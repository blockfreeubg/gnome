//! The module extension point: a feature module publishes shared state and contributes routes (public + admin), a
//! job, `/api/config`, `/api/health`, `/admin/diagnostics` and `/admin/metrics` — without touching `AppState`.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::routing::get as route;
use common::*;
use gnome_server::AppState;
use gnome_server::jobs::Job;
use gnome_server::module::{
    Diagnostics, Ext, Health, Module, ModuleSetup, PublicConfig, UpstreamStatus, builtin_modules,
};
use gnome_server::util::BoxFuture;
use http::{Request, StatusCode, header};
use serde_json::json;

/// State shared between the module's handlers, its job and anyone else holding an `AppState`.
#[derive(Default)]
struct Counter {
    hits: AtomicU64,
}

struct Probe {
    shared: Arc<Counter>,
}

impl Module for Probe {
    fn name(&self) -> &'static str {
        "probe"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route(
            "/api/probe",
            route(|Ext(counter): Ext<Counter>| async move {
                let hits = counter.hits.fetch_add(1, Ordering::SeqCst) + 1;
                axum::Json(json!({ "hits": hits }))
            }),
        )
    }

    fn admin_routes(&self, _state: &AppState) -> Router<AppState> {
        let shared = self.shared.clone();
        Router::new()
            .route("/admin/probe", route(move || async move { format!("hits={}", shared.hits.load(Ordering::SeqCst)) }))
    }

    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![Job::new("probe.tick", Duration::from_secs(3600), |state| async move {
            let counter = state.ext::<Counter>().ok_or("counter missing")?;
            counter.hits.fetch_add(100, Ordering::SeqCst);
            Ok(())
        })]
    }

    fn public_config(&self, _state: &AppState, config: &mut PublicConfig) {
        config.features.games = true;
    }

    fn health(&self, _state: &AppState, health: &mut Health) {
        health.wisp.insert("direct".into(), UpstreamStatus::Up);
    }

    fn diagnostics<'a>(&'a self, _state: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            out.insert("probe".into(), json!({ "hits": self.shared.hits.load(Ordering::SeqCst) }));
        })
    }

    fn metrics(&self, _state: &AppState, out: &mut String) {
        out.push_str("# HELP gnome_probe_hits Probe hits.\n# TYPE gnome_probe_hits counter\n");
        out.push_str(&format!("gnome_probe_hits {}\n", self.shared.hits.load(Ordering::SeqCst)));
    }
}

fn with_probe(setup: &mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>> {
    let mut modules = builtin_modules(setup);
    let shared = setup.provide(Counter::default());
    modules.push(Arc::new(Probe { shared }));
    modules
}

fn admin_get(path: &str) -> Request<axum::body::Body> {
    Request::builder().uri(path).header(header::HOST, "127.0.0.1:9091").body(axum::body::Body::empty()).unwrap()
}

#[tokio::test]
async fn a_module_plugs_into_every_hook() {
    let app = TestApp::with_modules(&[], |_| {}, with_probe).await;
    assert_eq!(
        app.state.modules().iter().map(|m| m.name()).collect::<Vec<_>>(),
        ["core", "accounts", "wisp", "vpn", "filters", "games", "probe"]
    );

    // Public route, with the API middleware applied; the state is reachable from AppState as well.
    let res = app.send(get("/api/probe")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.json()["hits"], 1);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(app.state.ext::<Counter>().unwrap().hits.load(Ordering::SeqCst), 1);

    // Admin route only on the admin router.
    assert_eq!(app.send_admin(admin_get("/admin/probe")).await.text(), "hits=1");
    assert_eq!(app.send(get("/admin/probe")).await.status, StatusCode::NOT_FOUND);

    // Config, health, diagnostics and metrics contributions.
    assert_eq!(app.send(get("/api/config")).await.json()["features"]["games"], true);
    assert_eq!(app.send(get("/api/health")).await.json()["wisp"]["direct"], "up");
    let d = app.send_admin(admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["probe"], json!({"hits": 1}));
    assert_eq!(d["modules"], json!(["core", "accounts", "wisp", "vpn", "filters", "games", "probe"]));
    assert!(app.send_admin(admin_get("/admin/metrics")).await.text().contains("gnome_probe_hits 1\n"));

    // The job is registered with the server's jobs and sees the same state.
    app.state.start_jobs();
    assert!(app.state.jobs.trigger("probe.tick"));
    let mut hits = 0;
    for _ in 0..50 {
        hits = app.state.ext::<Counter>().unwrap().hits.load(Ordering::SeqCst);
        if hits == 101 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(hits, 101, "triggered job ran against the shared state");
    app.state.shutdown.cancel();
}

#[tokio::test]
async fn missing_module_state_is_a_500_not_a_panic() {
    struct Lonely;
    impl Module for Lonely {
        fn name(&self) -> &'static str {
            "lonely"
        }
        fn public_routes(&self, _state: &AppState) -> Router<AppState> {
            Router::new().route("/api/lonely", route(|Ext(_c): Ext<Counter>| async { "unreachable" }))
        }
    }
    let app = TestApp::with_modules(
        &[],
        |_| {},
        |setup| {
            let mut m = builtin_modules(setup);
            m.push(Arc::new(Lonely));
            m
        },
    )
    .await;
    assert!(app.state.ext::<Counter>().is_none());
    let res = app.send(get("/api/lonely")).await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(res.error_code(), "internal");
}

/// A module whose handler and job panic: both are contained, reported, and leave no trace in the gauges.
struct Faulty;

impl Module for Faulty {
    fn name(&self) -> &'static str {
        "faulty"
    }
    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route(
            "/api/faulty",
            route(|| async {
                if std::hint::black_box(true) {
                    panic!("handler bug with a secret detail");
                }
                "unreachable"
            }),
        )
    }
    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![Job::new("faulty.job", Duration::from_secs(3600), |_state| async {
            if std::hint::black_box(true) {
                panic!("job bug");
            }
            Ok(())
        })]
    }
}

#[tokio::test]
async fn handler_and_job_panics_are_contained() {
    let app = TestApp::with_modules(
        &[],
        |_| {},
        |setup| {
            let mut m = builtin_modules(setup);
            m.push(Arc::new(Faulty));
            m
        },
    )
    .await;
    for _ in 0..3 {
        let res = app.send(get("/api/faulty")).await;
        assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.error_code(), "internal");
        assert!(!res.text().contains("secret detail"), "panic details stay in the log");
        // The 500 went through the whole middleware stack.
        assert!(res.header("x-request-id").is_some(), "request id on the panic response");
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("cache-control"), Some("no-store"));
    }
    assert_eq!(app.state.metrics.in_flight(), 0, "the in-flight gauge does not leak");
    assert_eq!(app.state.metrics.by_status().get(&500), Some(&3));

    // A panicking job is recorded as a failed run and keeps its schedule.
    app.state.start_jobs();
    let status = || app.state.jobs.snapshot().into_iter().find(|j| j.name == "faulty.job").unwrap();
    for expected_runs in 1..=2 {
        assert!(app.state.jobs.trigger("faulty.job"));
        for _ in 0..100 {
            if status().runs == expected_runs {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let s = status();
        assert_eq!((s.runs, s.failures, s.running), (expected_runs, expected_runs, false), "{s:?}");
        assert_eq!(s.last_error.as_deref(), Some("panicked: job bug"));
    }
    app.state.shutdown.cancel();
}

#[test]
#[should_panic(expected = "provided twice")]
fn one_value_per_type() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        TestApp::with_modules(
            &[],
            |_| {},
            |setup| {
                setup.provide(Counter::default());
                setup.provide(Counter::default());
                Vec::new()
            },
        )
        .await;
    });
}
