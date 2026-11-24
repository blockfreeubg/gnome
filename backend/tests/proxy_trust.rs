//! WAVE-D §6.3 proxy trust: with every configured origin `https://`, `GNOME_COOKIE_SECURE=auto` gives `Secure`
//! cookies with `__Host-` names whatever `X-Forwarded-Proto` says; a request for an `https://` origin from a peer
//! outside `GNOME_TRUSTED_PROXIES` is counted in `/admin/diagnostics` `proxy_trust` (and warned about once).

mod common;

use axum::body::Body;
use common::*;
use http::{Request, StatusCode};

fn session(host: &str, xfp: Option<&str>) -> Request<Body> {
    let scheme = if host.ends_with(".lan") { "http" } else { "https" };
    let mut b = Request::builder()
        .method("POST")
        .uri("/api/session")
        .header("host", host)
        .header("origin", format!("{scheme}://{host}"))
        .header("x-gnome-request", "1");
    if let Some(p) = xfp {
        b = b.header("x-forwarded-proto", p);
    }
    b.body(Body::empty()).unwrap()
}

async fn untrusted(app: &TestApp) -> u64 {
    let req =
        Request::builder().uri("/admin/diagnostics").header("host", "127.0.0.1:9091").body(Body::empty()).unwrap();
    app.send_admin(req).await.json()["proxy_trust"]["untrusted_https_requests"].as_u64().unwrap()
}

#[tokio::test]
async fn all_https_origins_give_host_cookies_and_untrusted_requests_are_counted() {
    let app = TestApp::new(&[
        ("GNOME_PUBLIC_ORIGINS", "https://gnome.example"),
        ("GNOME_PROXY_ORIGIN", "https://p.gnome.example"),
    ])
    .await;
    // From an untrusted peer without X-Forwarded-Proto (a front missing from GNOME_TRUSTED_PROXIES).
    let far = "203.0.113.10:4000".parse().unwrap();
    let res = send_to(&app.public, session("gnome.example", None), far).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let cookie = res.set_cookie("__Host-gnome_sid").expect("__Host- name without X-Forwarded-Proto");
    assert!(cookie.contains("; Secure") && cookie.contains("; Priority=High"), "{cookie}");
    assert_eq!(untrusted(&app).await, 1);
    let res = send_to(&app.public, session("gnome.example", None), far).await;
    assert!(res.set_cookie("__Host-gnome_sid").is_some());
    assert_eq!(untrusted(&app).await, 2, "every such request is counted (the warning is logged once)");
    // The trusted front with X-Forwarded-Proto is not counted; neither is an unknown host.
    let res = send_to(&app.public, session("gnome.example", Some("https")), "127.0.0.1:4000".parse().unwrap()).await;
    assert!(res.set_cookie("__Host-gnome_sid").is_some());
    let _ = send_to(&app.public, session("other.example", None), far).await;
    assert_eq!(untrusted(&app).await, 2);
}

#[tokio::test]
async fn mixed_origins_keep_the_scheme_rule() {
    let app = TestApp::new(&[("GNOME_PUBLIC_ORIGINS", "https://gnome.example,http://gnome.lan")]).await;
    let far = "203.0.113.10:4000".parse().unwrap();
    let res = send_to(&app.public, session("gnome.lan", None), far).await;
    let cookie = res.set_cookie("gnome_sid").expect("plain name over plain HTTP");
    assert!(!cookie.contains("Secure") && cookie.contains("; Priority=High"), "{cookie}");
    assert!(res.set_cookie("__Host-gnome_sid").is_none());
}
