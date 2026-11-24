//! `POST /api/wisp/ticket` per access mode, ticket lifetime, rate limit, and tickets of ended user sessions.

mod common;

use axum::body::Body;
use common::*;
use gnome_server::auth::anon::ANON_TTL_S;
use gnome_server::util::{now_ms, now_s};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};

const PROXY_ORIGIN: &str = "http://p.gnome.test";

/// The ticket's components `[w1, exp_s, session_ref, mac]`.
fn parts(ticket: &str) -> Vec<String> {
    ticket.split('.').map(str::to_string).collect()
}

fn ticket_of(v: &Value) -> String {
    v["ticket"].as_str().unwrap_or_else(|| panic!("no ticket in {v}")).to_string()
}

/// A WebSocket upgrade to `/wisp/` on the proxy role (answered before any upgrade happens).
fn upgrade(ticket: &str) -> Request<Body> {
    Request::builder()
        .uri(format!("/wisp/?t={ticket}"))
        .header(header::HOST, "p.gnome.test")
        .header(header::ORIGIN, PROXY_ORIGIN)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap()
}

/// A Wisp upstream address nothing listens on: accepted tickets end in `502`, refused ones in `401`.
fn closed_upstream() -> String {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string()
}

#[tokio::test]
async fn open_mode_creates_the_session_on_the_fly() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    let before = now_ms();
    let res = c.post("/api/wisp/ticket", json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert!(res.set_cookie("gnome_sid").is_some(), "anonymous session cookie set");
    assert_eq!(res.header("cache-control"), Some("no-store"));
    let v = res.json();
    let t = ticket_of(&v);
    let p = parts(&t);
    assert_eq!((p.len(), p[0].as_str(), p[3].as_str(), p[4].len(), p[5].len()), (6, "w2", "d", 22, 43), "{t}");
    let exp_ms = v["expires_at"].as_i64().unwrap();
    assert_eq!(exp_ms, p[1].parse::<i64>().unwrap() * 1000, "expires_at is the ticket's expiry in ms");
    let hour = 3_600_000;
    assert!(exp_ms > before + hour - 2_000 && exp_ms <= now_ms() + hour, "default TTL one hour: {exp_ms}");
    assert_eq!(app.send(get("/api/config")).await.json()["wisp"]["ticket_ttl_s"], 3600, "the default is published");
    assert_eq!(v["wisp_url"], "ws://gnome.test/wisp/");
    assert!(!t.contains(c.cookies["gnome_sid"].as_str()), "the ticket does not carry the session token");

    // Same session: same ref, no new cookie.
    let again = c.post("/api/wisp/ticket", json!({})).await;
    assert_eq!(again.status, StatusCode::OK);
    assert!(again.set_cookie("gnome_sid").is_none());
    assert_eq!(parts(&ticket_of(&again.json()))[4], p[4]);
    // Another browser: another ref.
    let other = app.client().post("/api/wisp/ticket", json!({})).await.json();
    assert_ne!(parts(&ticket_of(&other))[4], p[4]);
}

#[tokio::test]
async fn csrf_rules_apply() {
    let app = TestApp::new(&[]).await;
    let no_header = Request::builder()
        .method("POST")
        .uri("/api/wisp/ticket")
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.send(no_header).await.status, StatusCode::FORBIDDEN);
    let cross = Request::builder()
        .method("POST")
        .uri("/api/wisp/ticket")
        .header(header::HOST, HOST)
        .header(header::ORIGIN, "http://evil.example")
        .header("x-gnome-request", "1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.send(cross).await.status, StatusCode::FORBIDDEN);
    assert_eq!(app.send(get("/api/wisp/ticket")).await.status, StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn ttl_setting_and_session_expiry_bound_the_ticket() {
    let app = TestApp::new(&[("GNOME_WISP_TICKET_TTL_S", "120")]).await;
    let v = app.client().post("/api/wisp/ticket", json!({})).await.json();
    let exp = v["expires_at"].as_i64().unwrap();
    assert!((exp - now_ms() - 120_000).abs() < 3_000, "{exp}");

    // An anonymous session that ends in 100 s caps the ticket at its own expiry.
    let app = TestApp::new(&[("GNOME_WISP_TICKET_TTL_S", "604800")]).await;
    let (token, anon) = app.state.anon_key.issue(None, now_s() - ANON_TTL_S + 100);
    let mut c = app.client();
    c.cookies.insert("gnome_sid".into(), token);
    let v = c.post("/api/wisp/ticket", json!({})).await.json();
    assert_eq!(v["expires_at"].as_u64().unwrap(), anon.expires_at_s * 1000, "{v}");
}

#[tokio::test]
async fn code_mode_needs_an_unlocked_session() {
    let app = TestApp::new(&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "open sesame 123")]).await;
    let mut c = app.client();
    let res = c.post("/api/wisp/ticket", json!({})).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::UNAUTHORIZED, "access_code_required"));
    assert!(res.set_cookie("gnome_sid").is_none(), "no session without the code");
    assert_eq!(c.post("/api/session", json!({"access_code": "open sesame 123"})).await.status, StatusCode::OK);
    assert_eq!(c.post("/api/wisp/ticket", json!({})).await.status, StatusCode::OK);
}

#[tokio::test]
async fn tickets_are_rate_limited_per_session() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    for i in 0..30 {
        let res = c.post("/api/wisp/ticket", json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "ticket {i}: {}", res.text());
    }
    let res = c.post("/api/wisp/ticket", json!({})).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    assert!(res.header("retry-after").is_some());
    // Another session from the same address is unaffected.
    let mut other = app.client();
    assert_eq!(other.post("/api/wisp/ticket", json!({})).await.status, StatusCode::OK);
}

#[tokio::test]
async fn accounts_mode_tickets_end_with_the_user_session() {
    let upstream = closed_upstream();
    let app = TestApp::new(&[
        ("GNOME_ACCESS_MODE", "accounts"),
        ("GNOME_PROXY_ORIGIN", PROXY_ORIGIN),
        ("GNOME_PUBLIC_ORIGINS", ORIGIN),
        ("GNOME_WISP_UPSTREAM", &upstream),
    ])
    .await;
    let mut anon = app.client();
    let res = anon.post("/api/wisp/ticket", json!({})).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::UNAUTHORIZED, "login_required"));

    let mut alice = app.client();
    alice.register("alice_t", "a long password").await;
    let v = alice.post("/api/wisp/ticket", json!({})).await.json();
    let ticket = ticket_of(&v);
    assert_eq!(v["wisp_url"], "ws://p.gnome.test/wisp/");
    let mut device2 = app.client();
    let res = device2.post("/api/auth/login", json!({"username": "alice_t", "password": "a long password"})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let ticket2 = ticket_of(&device2.post("/api/wisp/ticket", json!({})).await.json());
    assert_ne!(parts(&ticket)[4], parts(&ticket2)[4], "one ref per user session");

    // Signing out on the first device ends its tickets (nothing was cached for it yet); the other device's
    // ticket is still accepted (and then fails at the closed upstream).
    assert_eq!(alice.post("/api/auth/logout", json!({})).await.status, StatusCode::NO_CONTENT);
    let res = app.send(upgrade(&ticket)).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{}", res.text());
    assert!(res.json()["error"]["message"].as_str().unwrap().contains("session"), "{}", res.text());
    let res = app.send(upgrade(&ticket2)).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::BAD_GATEWAY, "bad_gateway"));
}

#[tokio::test]
async fn upgrades_are_rate_limited_per_ip() {
    let app = TestApp::new(&[("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", ORIGIN)]).await;
    let peer = "198.51.100.40:5000".parse().unwrap();
    for i in 0..60 {
        let res = send_to(&app.public, upgrade("w1.1.x.y"), peer).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "attempt {i}: {}", res.text());
    }
    let res = send_to(&app.public, upgrade("w1.1.x.y"), peer).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    let other = send_to(&app.public, upgrade("w1.1.x.y"), "198.51.100.41:5000".parse().unwrap()).await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED, "other addresses are unaffected");
}

/// D23: a mint without a body (the step-2 clients) still gives a default-route ticket; `{}` and
/// `{"route": "default"}` do too; a profile route needs a known location; malformed routes are 422 on `route`.
#[tokio::test]
async fn the_ticket_route_comes_from_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path().join("profiles.toml");
    std::fs::write(
        &profiles,
        "[[profile]]\nid = \"se-got\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \
         \"Gothenburg\"\nwisp_upstream = \"127.0.0.1:9\"\n",
    )
    .unwrap();
    let path = profiles.display().to_string();
    let app = TestApp::new(&[("GNOME_VPN_PROFILES", &path)]).await;
    let no_body = Request::builder()
        .method("POST")
        .uri("/api/wisp/ticket")
        .header(header::HOST, HOST)
        .header(header::ORIGIN, ORIGIN)
        .header("x-gnome-request", "1")
        .body(Body::empty())
        .unwrap();
    let res = app.send(no_body).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(parts(&ticket_of(&res.json()))[3], "d");
    let mut c = app.client();
    for body in [json!({}), json!({"route": "default"}), json!({"route": null})] {
        let res = c.post("/api/wisp/ticket", body.clone()).await;
        assert_eq!(res.status, StatusCode::OK, "{body}: {}", res.text());
        assert_eq!(parts(&ticket_of(&res.json()))[3], "d", "{body}");
    }
    let res = c.post("/api/wisp/ticket", json!({"route": {"profile": "se-got"}})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let v = res.json();
    // `p` + base64url("se-got"); the URL the app connects to stays its own choice.
    assert_eq!(parts(&ticket_of(&v))[3], "pc2UtZ290");
    for (body, msg) in [
        (json!({"route": {"profile": "nope"}}), "unknown VPN location"),
        (json!({"route": {"profile": "direct"}}), "unknown VPN location"),
        (json!({"route": "profile"}), "must be"),
        (json!({"route": 5}), "must be"),
        (json!({"route": {"profile": "se-got", "x": 1}}), "must be"),
        (json!({"route": {"profile": 1}}), "must be"),
    ] {
        let res = c.post("/api/wisp/ticket", body.clone()).await;
        assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{body}: {}", res.text());
        let e = res.json();
        assert_eq!(e["error"]["code"], "validation_failed", "{body}");
        assert!(e["error"]["fields"]["route"].as_str().unwrap().contains(msg), "{body}: {e}");
    }
}
