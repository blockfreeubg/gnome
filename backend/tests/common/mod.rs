//! Test harness: builds the real public/admin routers over a temporary data dir and static dir, and drives them with
//! `tower::ServiceExt::oneshot`.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use bytes::Bytes;
use gnome_server::AppState;
use gnome_server::config::Config;
use http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

pub const HOST: &str = "gnome.test";
pub const ORIGIN: &str = "http://gnome.test";

pub struct TestApp {
    pub state: AppState,
    pub public: Router,
    pub admin: Router,
    pub dir: TempDir,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// All `Set-Cookie` header values.
    pub fn set_cookies(&self) -> Vec<String> {
        self.headers.get_all(header::SET_COOKIE).iter().map(|v| v.to_str().unwrap().to_string()).collect()
    }

    /// The full `Set-Cookie` line for `name`.
    pub fn set_cookie(&self, name: &str) -> Option<String> {
        self.set_cookies().into_iter().find(|c| c.starts_with(&format!("{name}=")))
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or_default().to_string()
    }
}

impl TestApp {
    pub async fn new(vars: &[(&str, &str)]) -> Self {
        Self::with_static(vars, |_| {}).await
    }

    /// `setup` populates the static dir (created empty) before the index is built.
    pub async fn with_static(vars: &[(&str, &str)], setup: impl FnOnce(&Path)) -> Self {
        Self::with_modules(vars, setup, gnome_server::module::builtin_modules).await
    }

    /// Like [`TestApp::with_static`] with a custom module list (see `AppState::open_with`).
    pub async fn with_modules<F>(vars: &[(&str, &str)], setup: impl FnOnce(&Path), modules: F) -> Self
    where
        F: FnOnce(&mut gnome_server::module::ModuleSetup<'_>) -> Vec<std::sync::Arc<dyn gnome_server::module::Module>>,
    {
        let dir = tempfile::tempdir().unwrap();
        let static_dir = dir.path().join("static");
        std::fs::create_dir_all(&static_dir).unwrap();
        setup(&static_dir);
        let mut map: HashMap<String, String> = HashMap::from([
            ("GNOME_DATA_DIR".into(), dir.path().join("data").display().to_string()),
            ("GNOME_STATIC_DIR".into(), static_dir.display().to_string()),
            ("GNOME_ARGON2_MEMORY_KIB".into(), "1024".into()),
            // No test server imports a live feed or downloads an OSS build from GitHub (WAVE-C §4.11).
            ("GNOME_CATALOG_REFRESH_HOURS".into(), "0".into()),
            ("GNOME_OSS_FETCH".into(), "manual".into()),
        ]);
        for (k, v) in vars {
            map.insert((*k).to_string(), (*v).to_string());
        }
        let config = Config::from_lookup(|k| map.get(k).cloned(), None).expect("test config is valid");
        let state = AppState::open_with(config, modules).await.expect("app opens");
        state.prepare_modules().await;
        let public = gnome_server::router::public(&state);
        let admin = gnome_server::router::admin(&state);
        Self { state, public, admin, dir }
    }

    pub fn client(&self) -> Client<'_> {
        Client { app: self, cookies: BTreeMap::new(), peer: "203.0.113.10:40000".parse().unwrap() }
    }

    pub async fn send(&self, req: Request<Body>) -> TestResponse {
        send_to(&self.public, req, "203.0.113.10:40000".parse().unwrap()).await
    }

    pub async fn send_admin(&self, req: Request<Body>) -> TestResponse {
        send_to(&self.admin, req, "127.0.0.1:50000".parse().unwrap()).await
    }
}

pub async fn send_to(router: &Router, mut req: Request<Body>, peer: SocketAddr) -> TestResponse {
    if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
        req.extensions_mut().insert(ConnectInfo(peer));
    }
    let res = router.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    TestResponse { status: parts.status, headers: parts.headers, body }
}

/// Builder for requests to the public listener (Host set, CSRF header on unsafe methods).
pub fn req(method: Method, path: &str) -> http::request::Builder {
    let unsafe_method = !matches!(method, Method::GET | Method::HEAD);
    let b = Request::builder().method(method).uri(path).header(header::HOST, HOST);
    if unsafe_method { b.header("x-gnome-request", "1") } else { b }
}

pub fn get(path: &str) -> Request<Body> {
    req(Method::GET, path).body(Body::empty()).unwrap()
}

pub fn json_req(method: Method, path: &str, body: &Value) -> Request<Body> {
    req(method, path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap()
}

/// A browser-like client: keeps cookies, fixed client IP.
pub struct Client<'a> {
    pub app: &'a TestApp,
    pub cookies: BTreeMap<String, String>,
    pub peer: SocketAddr,
}

impl Client<'_> {
    pub fn with_ip(mut self, peer: &str) -> Self {
        self.peer = peer.parse().unwrap();
        self
    }

    pub async fn send(&mut self, mut req: Request<Body>) -> TestResponse {
        if !self.cookies.is_empty() {
            let cookie = self.cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
            req.headers_mut().insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        }
        let res = send_to(&self.app.public, req, self.peer).await;
        for line in res.set_cookies() {
            let (pair, attrs) = line.split_once(';').unwrap_or((&line, ""));
            let (name, value) = pair.split_once('=').unwrap();
            if value.is_empty() || attrs.contains("Max-Age=0") {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.to_string(), value.to_string());
            }
        }
        res
    }

    pub async fn get(&mut self, path: &str) -> TestResponse {
        self.send(get(path)).await
    }

    pub async fn post(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::POST, path, &body)).await
    }

    pub async fn put(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::PUT, path, &body)).await
    }

    pub async fn delete(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::DELETE, path, &body)).await
    }

    /// Register (and stay signed in).
    pub async fn register(&mut self, username: &str, password: &str) -> TestResponse {
        let res =
            self.post("/api/auth/register", serde_json::json!({"username": username, "password": password})).await;
        assert_eq!(res.status, StatusCode::CREATED, "register failed: {}", res.text());
        res
    }
}

/// Helpers of the games tests (WAVE-C §4.11): the crate's real feed captures through a `FixtureFetcher`.
pub mod games {
    use std::sync::Arc;
    use std::time::Duration;

    use gnome_catalog::{FixtureFetcher, FixtureResponse, ManualClock};
    use gnome_server::games::{Games, GamesOptions};

    use super::TestApp;

    /// 2026-11-10T12:00:00Z, the capture date.
    pub const T0: i64 = 1_762_776_000_000;
    pub const PROXY_ORIGIN: &str = "http://p.gnome.test";

    pub fn capture(name: &str) -> FixtureResponse {
        let path = format!("{}/../crates/catalog/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        FixtureResponse::ok(std::fs::read(path).unwrap())
    }

    /// GamePix (the three chess pages), GameDistribution (one page, then the end), Playgama (one page of ten: the
    /// second request has no capture, so its run fails with the ten games kept).
    pub fn feeds() -> FixtureFetcher {
        let f = FixtureFetcher::new();
        f.on_url(&["feeds.gamepix.com", "&page=1"], vec![capture("gamepix-chess-p1.json")]);
        f.on_url(&["feeds.gamepix.com", "&page=2"], vec![capture("gamepix-chess-p2.json")]);
        f.on_url(&["feeds.gamepix.com", "&page=3"], vec![capture("gamepix-chess-p3.json")]);
        f.on_url(&["catalog.api.gamedistribution.com", "page=1&"], vec![capture("gamedistribution-p1.json")]);
        f.on_url(&["catalog.api.gamedistribution.com"], vec![capture("gamedistribution-end.json")]);
        let mut pg = capture("playgama-p1.json");
        pg.status = 201;
        f.on_url(&["widgets.playgama.com"], vec![pg]);
        f
    }

    /// Two origins (app `http://gnome.test`, proxy `http://p.gnome.test`) and the three network sources.
    pub fn vars<'a>(extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
        let mut v = vec![
            ("GNOME_PROXY_ORIGIN", PROXY_ORIGIN),
            ("GNOME_PUBLIC_ORIGINS", super::ORIGIN),
            ("GNOME_CATALOG_SOURCES", "gamepix,gamedistribution,playgama"),
            ("GNOME_GD_PUBLISHER_ID", "0123456789abcdef0123456789abcdef"),
            ("GNOME_PLAYGAMA_CLID", "test-clid"),
        ];
        v.extend_from_slice(extra);
        v
    }

    pub async fn app_with(
        vars: &[(&str, &str)],
        setup: impl FnOnce(&std::path::Path),
        options: GamesOptions,
    ) -> TestApp {
        TestApp::with_modules(vars, setup, move |s| {
            gnome_server::module::builtin_modules_with_games(
                s,
                gnome_server::gateway::GatewayOptions::default(),
                options,
            )
        })
        .await
    }

    pub async fn app(extra: &[(&str, &str)]) -> TestApp {
        let options = GamesOptions {
            fetcher: Some(Arc::new(feeds())),
            clock: Some(Arc::new(ManualClock::new(T0))),
            ..GamesOptions::default()
        };
        app_with(&vars(extra), |_| {}, options).await
    }

    /// Wait until no import or OSS fetch of this process is running.
    pub async fn settle(app: &TestApp) {
        let games = app.state.ext::<Games>().unwrap();
        for _ in 0..1000 {
            let busy =
                app.state.config.catalog.sources.iter().any(|s| games.is_importing(*s)) || games.oss.is_fetching();
            if !busy {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the import did not finish");
    }

    /// A loopback admin-listener request.
    pub fn admin_get(path: &str) -> http::Request<axum::body::Body> {
        http::Request::builder().uri(path).header("host", "127.0.0.1:9091").body(axum::body::Body::empty()).unwrap()
    }

    pub fn admin_post(path: &str, body: &serde_json::Value) -> http::Request<axum::body::Body> {
        http::Request::builder()
            .method(http::Method::POST)
            .uri(path)
            .header("host", "127.0.0.1:9091")
            .header("x-gnome-request", "1")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(serde_json::to_vec(body).unwrap()))
            .unwrap()
    }

    /// Import every enabled source through the admin endpoint and wait for it.
    pub async fn import_all(app: &TestApp) {
        let res = app.send_admin(admin_post("/admin/catalog/import", &serde_json::json!({}))).await;
        assert_eq!(res.status, http::StatusCode::ACCEPTED, "{}", res.text());
        settle(app).await;
    }
}
