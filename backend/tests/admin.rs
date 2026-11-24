//! Admin listener: isolation from the public router, guard, diagnostics, metrics.

mod common;

use axum::body::Body;
use base64::Engine as _;
use common::*;
use http::{Method, Request, StatusCode, header};

const TOKEN: &str = "test-admin-token-0123456789";

fn admin_get(path: &str, host: &str) -> Request<Body> {
    Request::builder().uri(path).header(header::HOST, host).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn admin_routes_do_not_exist_on_the_public_router() {
    let app = TestApp::new(&[("GNOME_ADMIN_TOKEN", TOKEN)]).await;
    for path in ["/admin", "/admin/", "/admin/diagnostics", "/admin/metrics", "/admin/catalog/imports"] {
        for auth in [None, Some(format!("Bearer {TOKEN}"))] {
            let mut b = req(Method::GET, path);
            if let Some(a) = &auth {
                b = b.header(header::AUTHORIZATION, a);
            }
            let res = app.send(b.body(Body::empty()).unwrap()).await;
            assert_eq!(res.status, StatusCode::NOT_FOUND, "{path} {auth:?}");
            assert_eq!(res.error_code(), "not_found");
            let body = res.text();
            assert!(!body.contains("uptime_s") && !body.contains("gnome_http_requests_total"), "{path}: {body}");
        }
    }
    // And the admin router does not serve the public API or SPA.
    let res = app
        .send_admin(
            Request::builder()
                .uri("/api/health")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn loopback_only_without_token() {
    let app = TestApp::new(&[]).await;
    let res = app.send_admin(admin_get("/admin/", "127.0.0.1:9091")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    assert!(res.text().contains("GNOME <span>admin</span>"));
    assert_eq!(res.header("x-frame-options"), Some("DENY"));
    assert!(res.header("content-security-policy").unwrap().starts_with("default-src 'none'"));
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert!(res.header("x-request-id").is_some(), "admin requests are traceable too");
    assert!(res.text().contains("Proxy isolation is off"), "single-origin mode is explained");
    assert_eq!(app.send_admin(admin_get("/admin/", "localhost:9091")).await.status, StatusCode::OK);
    // DNS-rebinding style Host is refused.
    let res = app.send_admin(admin_get("/admin/diagnostics", "evil.example:9091")).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    // Root redirects to the page.
    let res = app.send_admin(admin_get("/", "127.0.0.1:9091")).await;
    assert!(res.status.is_redirection());
    assert_eq!(res.header("location"), Some("/admin/"));
}

#[tokio::test]
async fn token_is_required_when_configured() {
    let app = TestApp::new(&[("GNOME_ADMIN_TOKEN", TOKEN)]).await;
    let res = app.send_admin(admin_get("/admin/diagnostics", "127.0.0.1:9091")).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let challenges: Vec<_> =
        res.headers.get_all(header::WWW_AUTHENTICATE).iter().map(|v| v.to_str().unwrap().to_string()).collect();
    assert!(challenges.iter().any(|c| c.starts_with("Basic ")), "{challenges:?}");
    let with = |auth: String| {
        Request::builder()
            .uri("/admin/diagnostics")
            .header(header::HOST, "gnome.example:9091")
            .header(header::AUTHORIZATION, auth)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.send_admin(with(format!("Bearer {TOKEN}"))).await.status,
        StatusCode::OK,
        "token works from any host"
    );
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("admin:{TOKEN}"));
    assert_eq!(app.send_admin(with(format!("Basic {basic}"))).await.status, StatusCode::OK);
    assert_eq!(app.send_admin(with("Bearer wrong-token-wrong-token".into())).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn token_guessing_is_rate_limited() {
    let app = TestApp::new(&[("GNOME_ADMIN_TOKEN", TOKEN)]).await;
    let with = |auth: &str| {
        Request::builder()
            .uri("/admin/metrics")
            .header(header::HOST, "admin.example:9091")
            .header(header::AUTHORIZATION, auth)
            .body(Body::empty())
            .unwrap()
    };
    let guesser: std::net::SocketAddr = "198.51.100.200:5000".parse().unwrap();
    let mut limited = None;
    for i in 0..80 {
        let res = send_to(&app.admin, with(&format!("Bearer wrong-guess-number-{i:04}")), guesser).await;
        if res.status == StatusCode::TOO_MANY_REQUESTS {
            limited = Some(i);
            break;
        }
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(limited, Some(60), "burst of 60 per IP");
    // Checked before the token: a correct guess from the same IP is refused too, so ignoring 429s does not help.
    let res = send_to(&app.admin, with(&format!("Bearer {TOKEN}")), guesser).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(res.header("retry-after").is_some());
    assert_eq!(res.header("x-frame-options"), Some("DENY"), "admin headers on the 429");
    // Other clients are unaffected.
    let res = send_to(&app.admin, with(&format!("Bearer {TOKEN}")), "192.0.2.201:1".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn unsafe_admin_requests_need_the_csrf_header() {
    let app = TestApp::new(&[]).await;
    let post = |csrf: bool| {
        let mut b =
            Request::builder().method(Method::POST).uri("/admin/diagnostics").header(header::HOST, "127.0.0.1:9091");
        if csrf {
            b = b.header("x-gnome-request", "1");
        }
        b.body(Body::empty()).unwrap()
    };
    assert_eq!(app.send_admin(post(false)).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.send_admin(post(true)).await.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn diagnostics_document() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    c.register("diag_user", "a long password").await;
    app.send(get("/api/health")).await;
    app.send(get("/api/nope")).await;
    let res = app.send_admin(admin_get("/admin/diagnostics", "127.0.0.1:9091")).await;
    assert_eq!(res.status, StatusCode::OK);
    let d = res.json();
    for key in [
        "uptime_s",
        "rss_bytes",
        "http",
        "ws",
        "db",
        "catalog",
        "filters",
        "upstreams",
        "build",
        "jobs",
        "static",
        "modules",
    ] {
        assert!(d.get(key).is_some(), "missing {key}: {d}");
    }
    assert!(d["http"]["requests"].as_u64().unwrap() >= 3);
    assert!(d["http"]["by_status"]["404"].as_u64().unwrap() >= 1);
    assert_eq!(d["http"]["rate_limited"], 0);
    for key in ["active", "total", "bytes_up", "bytes_down"] {
        assert_eq!(d["ws"][key], 0, "ws.{key}: {}", d["ws"]);
    }
    assert_eq!(d["ws"]["limits"], serde_json::json!({"per_ip": 32, "per_session": 16}));
    assert_eq!(d["db"]["users"], 1);
    assert_eq!(d["db"]["user_sessions"], 1);
    assert!(d["db"]["size_bytes"].as_u64().unwrap() > 0);
    assert_eq!(d["catalog"]["games"], 0);
    // The built-in registry, nothing downloaded in tests (jobs are not started).
    let filters = d["filters"].as_array().unwrap();
    assert_eq!(filters.len(), gnome_server::filters::registry::builtin().len());
    assert!(filters.iter().all(|f| f["available"] == false && f["id"].is_string()), "{filters:?}");
    let upstreams = d["upstreams"].as_array().unwrap();
    assert_eq!(upstreams.len(), 1, "{upstreams:?}");
    assert_eq!((&upstreams[0]["id"], &upstreams[0]["addr"]), (&"direct".into(), &"127.0.0.1:6001".into()));
    assert_eq!(d["build"]["version"], gnome_server::VERSION);
    assert_eq!(d["modules"], serde_json::json!(["core", "accounts", "wisp", "vpn", "filters", "games"]));
    assert_eq!(d["proxy"]["isolated"], false);
    assert_eq!(d["proxy"]["mode"], "single-origin");
    assert!(d["proxy"]["explanation"].as_str().unwrap().contains("single-origin"));
    assert_eq!(state_requests_after_admin(&app).await, d["http"]["requests"], "admin traffic is not counted");
    #[cfg(target_os = "linux")]
    assert!(d["rss_bytes"].as_u64().unwrap() > 0);
}

/// Public request count after another admin request (must not change it).
async fn state_requests_after_admin(app: &TestApp) -> serde_json::Value {
    app.send_admin(admin_get("/admin/metrics", "127.0.0.1:9091")).await;
    serde_json::Value::from(app.state.metrics.requests())
}

#[tokio::test]
async fn prometheus_metrics() {
    let app = TestApp::new(&[]).await;
    app.send(get("/api/health")).await;
    let res = app.send_admin(admin_get("/admin/metrics", "[::1]:9091")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.header("content-type").unwrap().starts_with("text/plain; version=0.0.4"));
    let text = res.text();
    for needle in [
        "# TYPE gnome_http_requests_total counter",
        "gnome_http_requests_total{status=\"200\"} 1",
        "gnome_http_request_duration_seconds_bucket{le=\"+Inf\"} 1",
        "gnome_build_info{version=",
        "gnome_rate_limited_total{class=\"auth\"} 0",
        "gnome_users 0",
        "gnome_uptime_seconds",
    ] {
        assert!(text.contains(needle), "missing {needle:?} in\n{text}");
    }
    // Every sample line is `name{labels} value` or `name value`.
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let value = line.rsplit_once(' ').map(|(_, v)| v).unwrap();
        assert!(value.parse::<f64>().is_ok(), "bad sample line {line:?}");
    }
}
