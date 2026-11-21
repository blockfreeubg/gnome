//! Sessions per access mode, CSRF, security headers, health/config, rate limiting.

mod common;

use axum::body::Body;
use common::*;
use http::{Method, Request, StatusCode, header};
use serde_json::json;

#[tokio::test]
async fn health_and_config() {
    let app = TestApp::new(&[("GNOME_SOURCE_URL", "https://example.com/gnome-src")]).await;
    let res = app.send(get("/api/health")).await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    assert_eq!(v["status"], "ok");
    assert_eq!(v["version"], gnome_server::VERSION);
    assert_eq!(v["db"], "ok");
    assert_eq!(v["wisp"]["direct"], "unknown");
    assert!(v["uptime_s"].is_u64());
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert!(res.header("x-request-id").is_some_and(|id| !id.is_empty()));

    let v = app.send(get("/api/config")).await.json();
    assert_eq!(v["proxy"], json!({"origin": ORIGIN, "isolated": false}), "single-origin mode");
    assert_eq!(v["access_mode"], "open");
    assert_eq!(v["registration"], "open");
    assert_eq!(v["features"]["accounts"], true);
    assert_eq!(v["features"]["sync"], true);
    assert_eq!(v["features"]["games"], false);
    assert_eq!(v["wisp"]["path"], "/wisp/");
    assert_eq!(v["wisp"]["profiles"], json!([]));
    assert_eq!(v["engines"], json!({"default": "scramjet", "scramjet": true, "ultraviolet": true}));
    assert_eq!(v["source_url"], "https://example.com/gnome-src");
    assert_eq!(v["limits"]["max_ws_per_session"], 16);
}

#[tokio::test]
async fn config_reflects_settings() {
    let app = TestApp::new(&[
        ("GNOME_ACCOUNTS", "false"),
        ("GNOME_ENGINES", "ultraviolet"),
        ("GNOME_ENGINE_DEFAULT", "ultraviolet"),
        ("GNOME_MAX_WS_PER_SESSION", "4"),
    ])
    .await;
    let v = app.send(get("/api/config")).await.json();
    assert_eq!(v["features"]["accounts"], false);
    assert_eq!(v["registration"], "closed");
    assert_eq!(v["engines"], json!({"default": "ultraviolet", "scramjet": false, "ultraviolet": true}));
    assert_eq!(v["limits"]["max_ws_per_session"], 4);
    assert!(v["source_url"].is_null());
}

#[tokio::test]
async fn open_mode_issues_and_refreshes_anonymous_sessions() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    assert_eq!(c.get("/api/session").await.status, StatusCode::UNAUTHORIZED);

    // No body at all is fine in open mode.
    let res = c.send(req(Method::POST, "/api/session").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let cookie = res.set_cookie("gnome_sid").expect("gnome_sid set");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Path=/"));
    assert!(cookie.contains("Max-Age=2592000"));
    assert!(!cookie.contains("Secure"), "plain HTTP must not get Secure in auto mode");
    let v = res.json();
    assert_eq!(v["session"]["kind"], "anonymous");
    let exp = v["session"]["expires_at"].as_i64().unwrap();
    assert!(exp > gnome_server::util::now_ms());

    let first_token = c.cookies["gnome_sid"].clone();
    let rand_part = first_token.split('.').nth(2).unwrap().to_string();
    let v = c.get("/api/session").await.json();
    assert_eq!(v["session"]["kind"], "anonymous");
    assert_eq!(v["session"]["user"], json!(null));
    assert_eq!(v["session"]["proxy"], true);

    // Refreshing keeps the session id.
    let res = c.post("/api/session", json!({})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(c.cookies["gnome_sid"].split('.').nth(2).unwrap(), rand_part);

    // A tampered token is not a session.
    let mut forged = first_token.clone();
    forged.replace_range(3..4, if &forged[3..4] == "9" { "8" } else { "9" });
    c.cookies.insert("gnome_sid".into(), forged);
    assert_eq!(c.get("/api/session").await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn tossed_duplicate_cookies_do_not_hide_the_real_session() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    assert_eq!(c.post("/api/session", json!({})).await.status, StatusCode::OK);
    let real = c.cookies["gnome_sid"].clone();
    // Browsers send the cookie with the longer path first: a planted garbage value must not sign the user out.
    let r = req(Method::GET, "/api/session")
        .header(header::COOKIE, format!("gnome_sid=v1.9999999999.AAAAAAAAAAAAAAAAAAAAAA.forged; gnome_sid={real}"))
        .body(Body::empty())
        .unwrap();
    let res = app.send(r).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.json()["session"]["kind"], "anonymous");
}

#[tokio::test]
async fn changing_the_access_code_revokes_anonymous_sessions() {
    let first = TestApp::new(&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "old-code-1")]).await;
    let mut c = first.client();
    assert_eq!(c.post("/api/session", json!({"access_code": "old-code-1"})).await.status, StatusCode::OK);
    let token = c.cookies["gnome_sid"].clone();
    // Same data dir (same secret key), new code: the old session is gone and cannot be refreshed without the code.
    let config = |code: &str| {
        let vars = std::collections::HashMap::from([
            ("GNOME_DATA_DIR".to_string(), first.dir.path().join("data").display().to_string()),
            ("GNOME_STATIC_DIR".to_string(), first.dir.path().join("static").display().to_string()),
            ("GNOME_ARGON2_MEMORY_KIB".to_string(), "1024".to_string()),
            ("GNOME_ACCESS_MODE".to_string(), "code".to_string()),
            ("GNOME_ACCESS_CODE".to_string(), code.to_string()),
        ]);
        gnome_server::config::Config::from_lookup(|k| vars.get(k).cloned(), None).unwrap()
    };
    let probe = |state: &gnome_server::AppState, path: &str, method: Method| {
        let router = gnome_server::router::public(state);
        let r = req(method, path)
            .header(header::COOKIE, format!("gnome_sid={token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        async move { send_to(&router, r, "203.0.113.10:1".parse().unwrap()).await }
    };
    let same = gnome_server::AppState::open(config("old-code-1")).await.unwrap();
    assert_eq!(probe(&same, "/api/session", Method::GET).await.status, StatusCode::OK, "restarts keep sessions");
    let rotated = gnome_server::AppState::open(config("new-code-2")).await.unwrap();
    assert_eq!(probe(&rotated, "/api/session", Method::GET).await.status, StatusCode::UNAUTHORIZED);
    let res = probe(&rotated, "/api/session", Method::POST).await;
    assert_eq!(res.error_code(), "access_code_required", "no refresh without the new code");
}

#[tokio::test]
async fn code_mode_requires_the_access_code() {
    let app = TestApp::new(&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "mushroom-42")]).await;
    let mut c = app.client();
    let res = c.post("/api/session", json!({})).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.error_code(), "access_code_required");
    let res = c.post("/api/session", json!({"access_code": "wrong"})).await;
    assert_eq!(res.error_code(), "access_code_required");
    assert!(c.cookies.is_empty());
    let res = c.post("/api/session", json!({"access_code": " mushroom-42 "})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert!(c.cookies.contains_key("gnome_sid"));
    // A valid session refreshes without the code.
    assert_eq!(c.post("/api/session", json!({})).await.status, StatusCode::OK);
    assert_eq!(c.get("/api/config").await.json()["access_mode"], "code");
    // Registration needs the code first (a valid anonymous session).
    let mut other = app.client().with_ip("198.51.100.2:1");
    let res = other.post("/api/auth/register", json!({"username": "eve", "password": "long enough pw"})).await;
    assert_eq!(res.error_code(), "access_code_required");
    let res = c.post("/api/auth/register", json!({"username": "adam", "password": "long enough pw"})).await;
    assert_eq!(res.status, StatusCode::CREATED);
}

#[tokio::test]
async fn accounts_mode_requires_login() {
    let app = TestApp::new(&[("GNOME_ACCESS_MODE", "accounts")]).await;
    let mut c = app.client();
    let res = c.post("/api/session", json!({})).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.error_code(), "login_required");
    c.register("hiker", "a long password").await;
    let res = c.post("/api/session", json!({})).await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    assert_eq!(v["session"]["kind"], "user");
    assert_eq!(v["session"]["user"]["username"], "hiker");
    assert!(res.set_cookie("gnome_sid").is_none(), "no anonymous sessions in accounts mode");
    let v = c.get("/api/session").await.json();
    assert_eq!(v["session"]["kind"], "user");
    assert_eq!(v["session"]["proxy"], true);
}

#[tokio::test]
async fn csrf_guard() {
    let app = TestApp::new(&[]).await;
    // Missing X-GNOME-Request.
    let r = http::Request::builder()
        .method(Method::POST)
        .uri("/api/session")
        .header(header::HOST, HOST)
        .body(Body::empty())
        .unwrap();
    let res = app.send(r).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(res.error_code(), "forbidden");
    // Cross-site Origin.
    let r =
        req(Method::POST, "/api/session").header(header::ORIGIN, "https://evil.example").body(Body::empty()).unwrap();
    assert_eq!(app.send(r).await.status, StatusCode::FORBIDDEN);
    // Same-origin passes.
    let r = req(Method::POST, "/api/session").header(header::ORIGIN, ORIGIN).body(Body::empty()).unwrap();
    assert_eq!(app.send(r).await.status, StatusCode::OK);
    // CORS preflights are never approved.
    let r = http::Request::builder()
        .method(Method::OPTIONS)
        .uri("/api/session")
        .header(header::HOST, HOST)
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::empty())
        .unwrap();
    let res = app.send(r).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert!(res.header("access-control-allow-origin").is_none());
}

#[tokio::test]
async fn public_origins_allow_list() {
    let app = TestApp::new(&[("GNOME_PUBLIC_ORIGINS", "https://gnome.example.com")]).await;
    let r = req(Method::POST, "/api/session").header(header::ORIGIN, ORIGIN).body(Body::empty()).unwrap();
    assert_eq!(app.send(r).await.status, StatusCode::FORBIDDEN, "same-host origin is not on the allow list");
    let r = req(Method::POST, "/api/session")
        .header(header::ORIGIN, "https://gnome.example.com")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.send(r).await.status, StatusCode::OK);
    // A Host that is not an app origin (a reverse proxy rewriting it) is not reported as the proxy origin.
    let v = app.send(get("/api/config")).await.json();
    assert_eq!(v["proxy"]["origin"], "https://gnome.example.com");
    let two = TestApp::new(&[("GNOME_PUBLIC_ORIGINS", "https://gnome.example.com, http://gnome.test")]).await;
    assert_eq!(two.send(get("/api/config")).await.json()["proxy"]["origin"], ORIGIN, "the origin in use, if allowed");
}

#[tokio::test]
async fn trusted_proxy_https_gets_secure_cookies_and_hsts() {
    let app = TestApp::new(&[("GNOME_HSTS", "true")]).await;
    let https = |method: Method, path: &str| {
        req(method, path)
            .header("x-forwarded-proto", "https")
            .header("x-forwarded-for", "198.51.100.77")
            .header(header::ORIGIN, "https://gnome.test")
    };
    let proxy: std::net::SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let res = send_to(&app.public, https(Method::POST, "/api/session").body(Body::empty()).unwrap(), proxy).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    // Secure cookies use the __Host- name so no other host of the site can plant one.
    let cookie = res.set_cookie("__Host-gnome_sid").expect("__Host-gnome_sid set");
    assert!(cookie.ends_with("; Secure") && cookie.contains("; Path=/;") && !cookie.contains("Domain"), "{cookie}");
    assert!(res.set_cookie("gnome_sid").is_none());
    assert_eq!(res.header("strict-transport-security"), Some("max-age=31536000"));
    let token = cookie.split_once('=').unwrap().1.split(';').next().unwrap().to_string();
    let with_cookie = |name: &str| {
        https(Method::GET, "/api/session")
            .header(header::COOKIE, format!("{name}={token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(send_to(&app.public, with_cookie("__Host-gnome_sid"), proxy).await.status, StatusCode::OK);
    // Over HTTPS an unprefixed cookie (which a sibling host could have set) is not a session.
    assert_eq!(send_to(&app.public, with_cookie("gnome_sid"), proxy).await.status, StatusCode::UNAUTHORIZED);
    // The same headers from an untrusted peer are ignored: http origin expected, https origin rejected.
    let r = req(Method::POST, "/api/session")
        .header("x-forwarded-proto", "https")
        .header(header::ORIGIN, "https://gnome.test")
        .body(Body::empty())
        .unwrap();
    let res = send_to(&app.public, r, "198.51.100.9:3000".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert!(res.header("strict-transport-security").is_none());
}

/// Plain HTTP on a loopback app origin (the two-port development setup) uses the production cookie names too:
/// browsers accept `Secure` cookies from loopback origins (spike §11.3 item 4). Other plain-HTTP hosts, and
/// `GNOME_COOKIE_SECURE=false`, keep the unprefixed names; a configured non-loopback app origin wins over a loopback
/// `Host` that a reverse proxy may send.
#[tokio::test]
async fn loopback_http_uses_host_prefixed_cookies() {
    let post = |host: &str| {
        Request::builder()
            .method(Method::POST)
            .uri("/api/session")
            .header(header::HOST, host)
            .header("x-gnome-request", "1")
            .header(header::ORIGIN, format!("http://{host}"))
            .body(Body::empty())
            .unwrap()
    };
    let app = TestApp::new(&[]).await;
    for host in ["127.0.0.1:8080", "localhost:5173", "[::1]:8080", "gnome.localhost:8080"] {
        let res = app.send(post(host)).await;
        assert_eq!(res.status, StatusCode::OK, "{host}: {}", res.text());
        let cookie = res.set_cookie("__Host-gnome_sid").unwrap_or_else(|| panic!("{host}: {:?}", res.set_cookies()));
        assert!(cookie.ends_with("; Secure") && cookie.contains("; Path=/;") && !cookie.contains("Domain"), "{cookie}");
        let token = cookie.split_once('=').unwrap().1.split(';').next().unwrap().to_string();
        let session = |name: &str| {
            Request::builder()
                .uri("/api/session")
                .header(header::HOST, host)
                .header(header::COOKIE, format!("{name}={token}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(app.send(session("__Host-gnome_sid")).await.status, StatusCode::OK, "{host}");
        assert_eq!(app.send(session("gnome_sid")).await.status, StatusCode::UNAUTHORIZED, "{host}");
    }
    let res = app.send(post("gnome.test")).await;
    assert!(res.set_cookie("gnome_sid").is_some_and(|c| !c.contains("Secure")), "{:?}", res.set_cookies());
    let off = TestApp::new(&[("GNOME_COOKIE_SECURE", "false")]).await;
    assert!(off.send(post("127.0.0.1:8080")).await.set_cookie("gnome_sid").is_some());
    // A reverse proxy that rewrites Host to the loopback listener: the configured app origin decides.
    let lan = TestApp::new(&[("GNOME_PUBLIC_ORIGINS", "http://192.168.1.5")]).await;
    let mut r = post("127.0.0.1:8080");
    r.headers_mut().insert(header::ORIGIN, "http://192.168.1.5".parse().unwrap());
    let res = lan.send(r).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert!(res.set_cookie("gnome_sid").is_some(), "{:?}", res.set_cookies());
}

#[tokio::test]
async fn security_headers_everywhere() {
    let app = TestApp::new(&[]).await;
    for path in ["/api/health", "/api/nope", "/"] {
        let res = app.send(get(path)).await;
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"), "{path}");
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"), "{path}");
        assert_eq!(res.header("x-frame-options"), Some("SAMEORIGIN"), "{path}");
        assert!(res.header("content-security-policy").is_some_and(|c| c.contains("frame-ancestors 'self'")), "{path}");
        assert!(res.header("strict-transport-security").is_none(), "HSTS is off by default");
    }
}

#[tokio::test]
async fn unknown_api_routes_are_json_404_and_405() {
    let app = TestApp::new(&[]).await;
    let res = app.send(get("/api/does-not-exist")).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.error_code(), "not_found");
    let res = app.send(req(Method::PUT, "/api/health").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.error_code(), "method_not_allowed");
    assert_eq!(res.header("allow"), Some("GET,HEAD"));
    let res = app.send(req(Method::DELETE, "/api/session").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.header("allow"), Some("GET,HEAD,POST"));
}

#[tokio::test]
async fn session_creation_is_rate_limited_per_ip() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client().with_ip("192.0.2.50:1000");
    for i in 0..20 {
        let res = c.post("/api/session", json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "request {i}");
    }
    let res = c.post("/api/session", json!({})).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(res.error_code(), "rate_limited");
    let retry: u64 = res.header("retry-after").unwrap().parse().unwrap();
    assert!((1..=3).contains(&retry), "{retry}");
    assert_eq!(res.json()["error"]["retry_after_s"].as_u64(), Some(retry));
    // Another client IP is unaffected.
    let mut d = app.client().with_ip("192.0.2.51:1000");
    assert_eq!(d.post("/api/session", json!({})).await.status, StatusCode::OK);
}

#[tokio::test]
async fn malformed_bodies_are_api_errors() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    let r = req(Method::POST, "/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let res = c.send(r).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.error_code(), "bad_request");
    let res = c.post("/api/auth/login", json!({"username": 5})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.error_code(), "validation_failed");
    let r = req(Method::POST, "/api/auth/login").body(Body::from("{}")).unwrap();
    assert_eq!(c.send(r).await.status, StatusCode::BAD_REQUEST, "content type required");
    let big = "x".repeat(300 * 1024);
    let res = c.post("/api/auth/login", json!({"username": big, "password": "x"})).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.error_code(), "payload_too_large");
}
