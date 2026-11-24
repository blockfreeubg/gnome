//! Origin roles (ARCHITECTURE §4.6, API.md "Static & SPA"): which routes each role serves, per-role security
//! headers, the proxy listener, shared module routes and `/api/config` in both modes.

mod common;

use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::routing::get as route;
use common::*;
use gnome_server::AppState;
use gnome_server::module::{Module, ModuleSetup, builtin_modules};
use http::{Method, Request, StatusCode, header};
use serde_json::json;

const PROXY_HOST: &str = "p.gnome.test";
const PROXY_ORIGIN: &str = "http://p.gnome.test";
const SPA: &str = "<!doctype html><title>spa</title>";
const ENGINE: &str = "<!doctype html><title>engine</title><script>boot()</script>";

fn frontend(root: &Path) {
    let w = |rel: &str, body: &str| {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    };
    w("index.html", SPA);
    w("engine/index.html", ENGINE);
    w("sw.js", "self.addEventListener('fetch', () => {});");
    w("vendor/scramjet/scramjet.all.js", "/* scramjet */");
    w("assets/app-1a2b3c.js", "export {};");
    w("favicon.ico", "ico");
}

/// A module with one route on each hook, to check where `shared_routes` end up.
struct Hooks;

impl Module for Hooks {
    fn name(&self) -> &'static str {
        "hooks"
    }
    fn public_routes(&self, _: &AppState) -> Router<AppState> {
        Router::new().route("/api/hook/app", route(|| async { "app" }))
    }
    fn proxy_routes(&self, _: &AppState) -> Router<AppState> {
        Router::new().route("/api/hook/proxy", route(|| async { "proxy" }))
    }
    fn shared_routes(&self, _: &AppState) -> Router<AppState> {
        Router::new().route("/api/hook/shared", route(|| async { "shared" }))
    }
}

fn with_hooks(setup: &mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>> {
    let mut m = builtin_modules(setup);
    m.push(Arc::new(Hooks));
    m
}

async fn two_origins(extra: &[(&str, &str)]) -> TestApp {
    let mut vars = vec![("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", ORIGIN)];
    vars.extend_from_slice(extra);
    TestApp::with_modules(&vars, frontend, with_hooks).await
}

fn at(host: &str, method: Method, path: &str) -> Request<Body> {
    let mut b = Request::builder().method(method.clone()).uri(path).header(header::HOST, host);
    if method != Method::GET && method != Method::HEAD {
        b = b.header("x-gnome-request", "1").header(header::ORIGIN, format!("http://{host}"));
        b = b.header(header::CONTENT_TYPE, "application/json");
        return b.body(Body::from("{}")).unwrap();
    }
    b.body(Body::empty()).unwrap()
}

/// What a path is expected to produce.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Expect {
    Spa,
    Engine,
    /// A static file or handler answering 200 (not an HTML entry point).
    Ok,
    /// 404 (plain or JSON).
    NotFound,
    /// The engine retry page (503).
    Retry,
    /// The Wisp gateway answering a plain GET without a ticket (its ticket probe: 401 `wisp_ticket_missing`).
    Gateway,
    /// An API endpoint answering 401 (it exists but wants a session).
    Unauthorized,
    /// An unsafe request refused by the CSRF guard (403, the request's origin is not an app origin) or not routed
    /// (404).
    Refused,
}

async fn check(router: &Router, host: &str, table: &[(Method, &str, Expect)], label: &str) {
    for (method, path, expect) in table {
        let res = send_to(router, at(host, method.clone(), path), "203.0.113.10:40000".parse().unwrap()).await;
        let what =
            format!("{label} {method} {path}: {} {}", res.status, res.text().chars().take(120).collect::<String>());
        match expect {
            Expect::Spa => assert_eq!((res.status, res.text().as_str()), (StatusCode::OK, SPA), "{what}"),
            Expect::Engine => assert_eq!((res.status, res.text().as_str()), (StatusCode::OK, ENGINE), "{what}"),
            Expect::Ok => {
                assert_eq!(res.status, StatusCode::OK, "{what}");
                assert!(res.text() != SPA && res.text() != ENGINE, "{what}");
            }
            Expect::NotFound => {
                assert_eq!(res.status, StatusCode::NOT_FOUND, "{what}");
                assert!(!res.text().contains("<title>"), "{what}");
            }
            Expect::Retry => {
                assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{what}");
                assert!(res.text().contains("Starting the proxy engine"), "{what}");
            }
            Expect::Gateway => {
                assert_eq!(
                    (res.status, res.error_code().as_str()),
                    (StatusCode::UNAUTHORIZED, "wisp_ticket_missing"),
                    "{what}"
                )
            }
            Expect::Unauthorized => assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{what}"),
            Expect::Refused => assert!(matches!(res.status.as_u16(), 403 | 404), "{what}"),
        }
    }
}

use Expect::*;

/// Every `Content-Security-Policy` value (a response may carry two policies).
fn csps(res: &TestResponse) -> Vec<String> {
    res.headers.get_all("content-security-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect()
}

/// Paths every table covers.
fn app_table() -> Vec<(Method, &'static str, Expect)> {
    vec![
        (Method::GET, "/", Spa),
        (Method::GET, "/browse", Spa),
        (Method::GET, "/settings/appearance", Spa),
        (Method::GET, "/index.html", Spa),
        (Method::GET, "/favicon.ico", Ok),
        (Method::GET, "/assets/app-1a2b3c.js", Ok),
        (Method::GET, "/api/health", Ok),
        (Method::GET, "/api/config", Ok),
        (Method::GET, "/api/vpn/locations", Ok),
        (Method::GET, "/api/hook/app", Ok),
        (Method::GET, "/api/hook/shared", Ok),
        (Method::GET, "/api/hook/proxy", NotFound),
        (Method::GET, "/api/auth/me", Unauthorized),
        (Method::POST, "/api/wisp/ticket", Ok),
        // Proxy-origin paths.
        (Method::GET, "/engine/", NotFound),
        (Method::GET, "/engine/tab/1", NotFound),
        (Method::GET, "/sw.js", NotFound),
        (Method::GET, "/vendor/scramjet/scramjet.all.js", NotFound),
        (Method::GET, "/wisp/", NotFound),
        (Method::GET, "/wisp/p/se/", NotFound),
        (Method::GET, "/~/sj/c/f/https%3A%2F%2Fexample.com", NotFound),
        (Method::GET, "/uv/service/hvtrs8%2F-ezaopng.aoo", NotFound),
    ]
}

fn proxy_table() -> Vec<(Method, &'static str, Expect)> {
    vec![
        (Method::GET, "/engine/", Engine),
        (Method::GET, "/engine/tab/1", Engine),
        (Method::GET, "/engine/missing.js", NotFound),
        (Method::GET, "/sw.js", Ok),
        (Method::GET, "/vendor/scramjet/scramjet.all.js", Ok),
        (Method::GET, "/assets/app-1a2b3c.js", Ok),
        (Method::GET, "/api/health", Ok),
        (Method::GET, "/api/hook/shared", Ok),
        (Method::GET, "/api/hook/proxy", Ok),
        (Method::GET, "/wisp/", Gateway),
        (Method::GET, "/wisp/p/nope/", NotFound),
        (Method::GET, "/~/sj/c/f/https%3A%2F%2Fexample.com", Retry),
        (Method::GET, "/%7E/sj/c/f/https%3A%2F%2Fexample.com", Retry),
        (Method::GET, "/uv/service/hvtrs8%2F-ezaopng.aoo", Retry),
        // Never the SPA, the app API or accounts on the proxy origin.
        (Method::GET, "/", NotFound),
        (Method::GET, "/browse", NotFound),
        (Method::GET, "/index.html", NotFound),
        (Method::GET, "/favicon.ico", NotFound),
        (Method::GET, "/api/config", NotFound),
        (Method::GET, "/api/session", NotFound),
        (Method::POST, "/api/session", Refused),
        (Method::GET, "/api/auth/me", NotFound),
        (Method::POST, "/api/auth/login", Refused),
        (Method::POST, "/api/auth/register", Refused),
        (Method::GET, "/api/sync/settings", NotFound),
        (Method::POST, "/api/wisp/ticket", Refused),
        (Method::GET, "/api/vpn/locations", NotFound),
        (Method::GET, "/api/hook/app", NotFound),
        (Method::GET, "/admin/diagnostics", NotFound),
    ]
}

#[tokio::test]
async fn two_origin_route_tables() {
    let app = two_origins(&[]).await;
    check(&app.public, HOST, &app_table(), "app").await;
    check(&app.public, PROXY_HOST, &proxy_table(), "proxy host").await;
    // The proxy host matches case-insensitively and with the default port.
    check(&app.public, "P.GNOME.TEST:80", &[(Method::GET, "/engine/", Engine)], "proxy host:80").await;
    // Unknown hosts get the app role.
    check(&app.public, "other.test", &[(Method::GET, "/", Spa), (Method::GET, "/engine/", NotFound)], "other").await;
    // The proxy listener serves the proxy role whatever the Host says.
    let proxy_listener = gnome_server::router::proxy(&app.state);
    check(&proxy_listener, HOST, &proxy_table(), "proxy listener").await;
}

#[tokio::test]
async fn single_origin_serves_the_union() {
    let app = TestApp::with_modules(&[], frontend, with_hooks).await;
    let table = [
        (Method::GET, "/", Spa),
        (Method::GET, "/browse", Spa),
        (Method::GET, "/engine/", Engine),
        (Method::GET, "/engine/tab/1", Engine),
        (Method::GET, "/sw.js", Ok),
        (Method::GET, "/vendor/scramjet/scramjet.all.js", Ok),
        (Method::GET, "/assets/app-1a2b3c.js", Ok),
        (Method::GET, "/api/config", Ok),
        (Method::GET, "/api/health", Ok),
        (Method::GET, "/api/hook/app", Ok),
        (Method::GET, "/api/hook/proxy", Ok),
        (Method::GET, "/api/hook/shared", Ok),
        (Method::POST, "/api/wisp/ticket", Ok),
        (Method::GET, "/wisp/", Gateway),
        (Method::GET, "/~/sj/c/f/x", Retry),
        (Method::GET, "/uv/service/x", Retry),
    ];
    check(&app.public, HOST, &table, "single").await;
    let v = app.send(get("/api/config")).await.json();
    assert_eq!(v["proxy"], json!({"origin": ORIGIN, "isolated": false, "cookieHygiene": "app"}));
    let t = app.client().post("/api/wisp/ticket", json!({})).await.json();
    assert_eq!(t["wisp_url"], "ws://gnome.test/wisp/");
}

#[tokio::test]
async fn per_role_security_headers() {
    let app = two_origins(&[("GNOME_PROXY_CSP", "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'")]).await;
    let send = |host: &'static str, path: &'static str| {
        let router = app.public.clone();
        async move { send_to(&router, at(host, Method::GET, path), "203.0.113.10:40000".parse().unwrap()).await }
    };
    // App shell: nothing frames it (X-Frame-Options: DENY, frame-ancestors 'none'); the shell CSP frames only the
    // proxy origin (the engine host: escaped code can navigate the engine iframe to anything frame-src allows) and
    // 'self' (the game wrapper /play-frame/<slug>, WAVE-C D2), no WebSockets; COOP and Permissions-Policy (D3).
    let shell = send(HOST, "/").await;
    assert_eq!(shell.header("x-frame-options"), Some("DENY"));
    assert_eq!(shell.header("cross-origin-opener-policy"), Some("same-origin"));
    assert_eq!(shell.header("permissions-policy"), Some(gnome_server::security::csp::PERMISSIONS_POLICY));
    let csp = shell.header("content-security-policy").unwrap();
    assert!(csp.contains(&format!("; frame-src blob: 'self' {PROXY_ORIGIN};")), "{csp}");
    assert!(csp.ends_with("; frame-ancestors 'none'"), "{csp}");
    assert!(!csp.contains("gamedistribution") && !csp.contains("itch.io"), "{csp}");
    assert!(csp.contains("connect-src 'self';") && !csp.contains("ws:"), "isolated app opens no WebSockets: {csp}");
    // Engine host: the built-in engine-host policy (frame-ancestors = the app origin), then the operator's
    // directives as a second policy (with the inline-script hash).
    let engine = send(PROXY_HOST, "/engine/").await;
    assert_eq!(engine.header("x-frame-options"), None);
    let csp = csps(&engine);
    assert_eq!(csp.len(), 2, "{csp:?}");
    assert_eq!(
        csp[0],
        format!(
            "frame-ancestors {ORIGIN}; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' \
             'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'"
        )
    );
    assert!(csp[1].starts_with("script-src 'self' 'wasm-unsafe-eval' 'sha256-"), "{csp:?}");
    assert!(csp[1].ends_with("; object-src 'none'"), "{csp:?}");
    assert_eq!(engine.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(engine.header("referrer-policy"), Some("no-referrer"));
    // Other proxy-role responses: scripts get the proxied-document policy, everything else default-src 'none';
    // frame-ancestors 'self' + app, never X-Frame-Options.
    let script = format!(
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob:; \
         form-action 'self'; frame-ancestors 'self' {ORIGIN}"
    );
    let none = format!("default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' {ORIGIN}");
    for (path, want) in [
        ("/sw.js", &script),
        ("/vendor/scramjet/scramjet.all.js", &script),
        ("/assets/app-1a2b3c.js", &script),
        ("/api/health", &none),
        ("/nope", &none),
    ] {
        let res = send(PROXY_HOST, path).await;
        assert_eq!(res.header("x-frame-options"), None, "{path}");
        assert_eq!(csps(&res), std::slice::from_ref(want), "{path}");
    }
    let sw = send(PROXY_HOST, "/sw.js").await;
    assert_eq!(sw.header("service-worker-allowed"), Some("/"));
    assert_eq!(sw.header("cache-control"), Some("no-cache"));
    assert_eq!(sw.header("content-type"), Some("text/javascript; charset=utf-8"));
    let retry = send(PROXY_HOST, "/~/sj/x/y/z").await;
    let csp = retry.header("content-security-policy").unwrap();
    assert!(csp.ends_with(&format!("frame-ancestors 'self' {ORIGIN}")), "{csp}");
    assert_eq!(retry.header("x-frame-options"), None);
}

/// Proxied pages can read the proxy origin's `GET /api/health`: it names no version, uptime, database state or VPN
/// location, only the overall status and the primary Wisp upstream. The app origin (and single-origin mode) keep
/// the full answer.
#[tokio::test]
async fn proxy_origin_health_is_minimal() {
    let profiles = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(
        profiles.path(),
        "[[profile]]\nid = \"se-got\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \
         \"Gothenburg\"\nwisp_upstream = \"127.0.0.1:6002\"\n",
    )
    .unwrap();
    let path = profiles.path().display().to_string();
    let app = two_origins(&[("GNOME_VPN_PROFILES", &path)]).await;
    let send = |host: &'static str| {
        let router = app.public.clone();
        async move { send_to(&router, at(host, Method::GET, "/api/health"), "203.0.113.10:40000".parse().unwrap()).await }
    };
    let full = send(HOST).await;
    assert_eq!(full.status, StatusCode::OK);
    let v = full.json();
    assert_eq!(v["version"], gnome_server::VERSION);
    assert!(v["uptime_s"].is_u64() && v["db"] == "ok", "{v}");
    assert_eq!(v["wisp"], json!({"direct": "unknown", "se-got": "unknown"}), "{v}");
    let proxy = send(PROXY_HOST).await;
    assert_eq!(proxy.status, StatusCode::OK);
    assert_eq!(proxy.json(), json!({"status": "ok", "wisp": {"direct": "unknown"}}));
    let listener = gnome_server::router::proxy(&app.state);
    let via_listener = send_to(&listener, at(HOST, Method::GET, "/api/health"), "203.0.113.10:40000".parse().unwrap());
    assert_eq!(via_listener.await.json(), json!({"status": "ok", "wisp": {"direct": "unknown"}}));
    let single = TestApp::with_modules(&[], frontend, with_hooks).await;
    let v = single.send(get("/api/health")).await.json();
    assert_eq!(v["version"], gnome_server::VERSION, "single-origin mode keeps the full answer: {v}");
}

#[tokio::test]
async fn config_and_tickets_point_at_the_proxy_origin() {
    let app = two_origins(&[("GNOME_WISP_TICKET_TTL_S", "3600")]).await;
    let v = app.send(get("/api/config")).await.json();
    assert_eq!(v["proxy"], json!({"origin": PROXY_ORIGIN, "isolated": true, "cookieHygiene": "app"}));
    assert_eq!(v["wisp"]["ticket_ttl_s"], 3600);
    let t = app.client().post("/api/wisp/ticket", json!({})).await.json();
    assert_eq!(t["wisp_url"], "ws://p.gnome.test/wisp/");
    let diag = app
        .send_admin(
            Request::builder()
                .uri("/admin/diagnostics")
                .header(header::HOST, "127.0.0.1:9091")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .json();
    assert_eq!(diag["proxy"]["isolated"], true, "{}", diag["proxy"]);
    assert_eq!(diag["proxy"]["origin"], PROXY_ORIGIN, "{}", diag["proxy"]);
}

#[tokio::test]
async fn engine_retry_page_works_without_a_static_dir() {
    let app = TestApp::new(&[("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", ORIGIN)]).await;
    std::fs::remove_dir_all(app.dir.path().join("static")).ok();
    let res = send_to(&app.public, at(PROXY_HOST, Method::GET, "/~/sj/a/b/c"), "203.0.113.1:1".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(res.text().contains("sw.register('/sw.js', { scope: '/' })"), "{}", res.text());
}

/// Every route the app role mounts, with its real methods (keep in sync with the modules' `public_routes`).
const APP_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/config"),
    ("GET", "/api/session"),
    ("POST", "/api/session"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/password"),
    ("GET", "/api/auth/me"),
    ("DELETE", "/api/auth/account"),
    ("GET", "/api/sync/settings"),
    ("PUT", "/api/sync/settings"),
    ("GET", "/api/sync/bookmarks"),
    ("POST", "/api/sync/bookmarks"),
    ("GET", "/api/sync/history"),
    ("POST", "/api/sync/history"),
    ("DELETE", "/api/sync/history"),
    ("POST", "/api/wisp/ticket"),
    ("GET", "/api/vpn/locations"),
];

/// A request that passes the CSRF guard (`X-GNOME-Request`, no `Origin`), so a 404 proves the route is absent rather
/// than refused; `cookie` is sent as is.
fn passing_csrf(host: &str, method: &str, path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut b = Request::builder().method(method).uri(path).header(header::HOST, host);
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    if method == "GET" || method == "HEAD" {
        return b.body(Body::empty()).unwrap();
    }
    b.header("x-gnome-request", "1").header(header::CONTENT_TYPE, "application/json").body(Body::from("{}")).unwrap()
}

/// A browser-like WebSocket upgrade with a well-formed key and the given `Origin`.
fn upgrade_at(host: &str, path: &str, origin: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header(header::HOST, host)
        .header(header::ORIGIN, origin)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap()
}

fn assert_absent(res: &TestResponse, what: &str) {
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{what}: {} {}", res.status, res.text());
    let body = res.text();
    assert!(!body.contains("<title>"), "{what}: an HTML document was served: {body}");
    assert!(res.set_cookies().is_empty(), "{what}: sets cookies: {:?}", res.set_cookies());
}

/// ARCHITECTURE §4.6, exhaustively: the proxy role never reaches an app route (whatever the method, cookies, path
/// spelling or listener) or the SPA; the isolated app role never reaches the gateway, the engine host or the engine
/// prefixes, not even with a well-formed WebSocket upgrade.
#[tokio::test]
async fn two_origin_isolation_is_exhaustive() {
    let app = two_origins(&[]).await;
    let peer: std::net::SocketAddr = "203.0.113.10:40000".parse().unwrap();
    // A signed-in user's cookies (and an anonymous session), as a proxied page's requests would carry them.
    let mut alice = app.client();
    alice.register("alice_r", "a long password").await;
    assert_eq!(alice.post("/api/session", json!({})).await.status, StatusCode::OK);
    let cookie: String = alice.cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
    assert!(cookie.contains("gnome_auth=") && cookie.contains("gnome_sid="), "{cookie}");
    let proxy_listener = gnome_server::router::proxy(&app.state);

    for (router, host, label) in [(&app.public, PROXY_HOST, "proxy host"), (&proxy_listener, HOST, "proxy listener")] {
        for (method, path) in APP_ROUTES {
            // The app role serves it (sanity check that the table is real; without cookies, so the logout route
            // does not end the session used below), the proxy role never does.
            let on_app = send_to(&app.public, passing_csrf(HOST, method, path, None), peer).await;
            assert_ne!(on_app.status, StatusCode::NOT_FOUND, "app {method} {path}: {}", on_app.text());
            assert_ne!(on_app.status, StatusCode::METHOD_NOT_ALLOWED, "app {method} {path}: {}", on_app.text());
            for c in [None, Some(cookie.as_str())] {
                let res = send_to(router, passing_csrf(host, method, path, c), peer).await;
                assert_absent(&res, &format!("{label} {method} {path} (cookies: {})", c.is_some()));
            }
            // Other spellings of the same path.
            let rest = path.trim_start_matches("/api");
            for variant in [
                format!("/%61pi{rest}"),
                format!("/%41PI{rest}"),
                format!("/API{rest}"),
                format!("{path}/"),
                format!("/{path}"),
                format!("/wisp/..{path}"),
                format!("{path}?x=1"),
            ] {
                let res = send_to(router, passing_csrf(host, method, &variant, Some(&cookie)), peer).await;
                assert!(
                    matches!(res.status.as_u16(), 404 | 405),
                    "{label} {method} {variant}: {} {}",
                    res.status,
                    res.text()
                );
                assert!(!res.text().contains("<title>") && res.set_cookies().is_empty(), "{label} {method} {variant}");
            }
        }
        for path in [
            "/",
            "/index.html",
            "/browse",
            "/settings/appearance",
            "/games/some-game",
            "/favicon.ico",
            "/engine",
            "/%65ngine/../index.html",
            "/assets/../index.html",
            "/vendor/../index.html",
            "/admin/",
            "/admin/diagnostics",
        ] {
            assert_absent(&send_to(router, passing_csrf(host, "GET", path, Some(&cookie)), peer).await, path);
        }
    }

    // The session was live throughout (nothing above reached a handler on the proxy role).
    let me = send_to(&app.public, passing_csrf(HOST, "GET", "/api/auth/me", Some(&cookie)), peer).await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.text());

    // The isolated app role: no gateway (even for a valid-looking upgrade with the proxy origin's Origin), no engine
    // host, no service worker, no vendor builds, no retry page.
    for path in ["/wisp/", "/wisp/p/se-got/", "/wisp/p/nope/", "/%77isp/", "/wisp"] {
        for origin in [PROXY_ORIGIN, ORIGIN] {
            let res = send_to(&app.public, upgrade_at(HOST, &format!("{path}?t=w1.1.x.y"), origin), peer).await;
            assert_absent(&res, &format!("app upgrade {path} from {origin}"));
            assert_eq!(res.header("content-type"), Some("application/json"), "JSON 404 for a reserved prefix");
        }
    }
    for path in [
        "/engine/",
        "/engine/index.html",
        "/engine/tab/1",
        "/%65ngine/",
        "/sw.js",
        "/%73w.js",
        "/vendor/scramjet/scramjet.all.js",
        "/~/sj/c/f/https%3A%2F%2Fexample.com",
        "/%7E/sj/c/f/https%3A%2F%2Fexample.com",
        "/%7e/sj/x",
        "/uv/service/hvtrs8%2F-ezaopng.aoo",
        "/%75v/service/x",
    ] {
        let res = send_to(&app.public, passing_csrf(HOST, "GET", path, Some(&cookie)), peer).await;
        assert_absent(&res, &format!("app {path}"));
        assert!(!res.text().contains("Starting the proxy engine"), "app {path}: retry page");
    }
}

/// Single-origin mode: everything is same-origin, so every response keeps `X-Frame-Options: SAMEORIGIN`; the engine
/// host gets the engine-host policy with `frame-ancestors 'self'` (plus `GNOME_PROXY_CSP`) instead of the shell
/// policy, the files only the proxy role serves in two-origin mode get the proxy policies, and the shell may open
/// WebSockets (the engines run on this origin).
#[tokio::test]
async fn single_origin_headers() {
    let app = TestApp::with_modules(&[("GNOME_PROXY_CSP", "object-src 'none'")], frontend, with_hooks).await;
    let peer: std::net::SocketAddr = "203.0.113.10:40000".parse().unwrap();
    let shell = send_to(&app.public, at(HOST, Method::GET, "/"), peer).await;
    let csp = shell.header("content-security-policy").unwrap();
    assert!(csp.contains("connect-src 'self' ws: wss:") && csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(csp.contains("; frame-src blob: 'self';"), "{csp}");
    assert_eq!(shell.header("x-frame-options"), Some("DENY"));
    let engine = send_to(&app.public, at(HOST, Method::GET, "/engine/"), peer).await;
    assert_eq!(
        csps(&engine),
        [
            "frame-ancestors 'self'; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; \
             connect-src 'self' data: blob:; form-action 'self'",
            "object-src 'none'"
        ]
    );
    assert_eq!(engine.header("x-frame-options"), Some("SAMEORIGIN"));
    let sw = send_to(&app.public, at(HOST, Method::GET, "/sw.js"), peer).await;
    assert!(csps(&sw)[0].starts_with("default-src 'self' data: blob: 'unsafe-inline'"), "{:?}", csps(&sw));
    let asset = send_to(&app.public, at(HOST, Method::GET, "/assets/app-1a2b3c.js"), peer).await;
    assert_eq!(csps(&asset), ["frame-ancestors 'self'"], "app scripts keep the app role's header");
    for path in ["/sw.js", "/api/health", "/~/sj/x/y"] {
        let res = send_to(&app.public, at(HOST, Method::GET, path), peer).await;
        assert_eq!(res.header("x-frame-options"), Some("SAMEORIGIN"), "{path}");
        assert!(res.header("content-security-policy").unwrap().contains("frame-ancestors 'self'"), "{path}");
    }
}
