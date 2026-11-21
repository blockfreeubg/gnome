//! The Wisp ticket probe (API.md "Wisp", ARCHITECTURE §4.6): a plain `GET`/`HEAD` of `/wisp/` or `/wisp/p/:id/`
//! answers `401 wisp_ticket_*` for a ticket an upgrade would refuse and `426` for one it would accept. No `Origin`
//! is needed, the probe shares the per-IP upgrade rate limit, and it never mints, extends or consumes anything.
//! Also the accepted ticket URL forms (`?t=X`, `?t=X&/`, `?t=X/`) on probes and refused upgrades.

mod common;

use axum::body::Body;
use common::*;
use gnome_server::config::AccessMode;
use gnome_server::gateway::Gateway;
use gnome_server::gateway::ticket::{SessionRef, TicketKey};
use gnome_server::security::secret_key::SecretKey;
use gnome_server::util::now_s;
use http::{Method, Request, StatusCode, header};
use serde_json::json;

const PROXY_HOST: &str = "p.gnome.test";
const PROXY_ORIGIN: &str = "http://p.gnome.test";

/// A Wisp upstream address nothing listens on: an accepted upgrade ends in `502`, so any probe that reached the
/// upstream would show up as one.
fn closed_upstream() -> String {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().to_string()
}

/// A plain request to the proxy role, without `Origin` (like a same-origin `fetch` GET in Chromium).
fn probe_req(method: Method, path_and_query: &str) -> Request<Body> {
    Request::builder().method(method).uri(path_and_query).header(header::HOST, PROXY_HOST).body(Body::empty()).unwrap()
}

fn probe(path_and_query: &str) -> Request<Body> {
    probe_req(Method::GET, path_and_query)
}

/// A WebSocket upgrade with the proxy origin.
fn upgrade(path_and_query: &str) -> Request<Body> {
    Request::builder()
        .uri(path_and_query)
        .header(header::HOST, PROXY_HOST)
        .header(header::ORIGIN, PROXY_ORIGIN)
        .header(header::UPGRADE, "websocket")
        .header(header::CONNECTION, "Upgrade")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap()
}

fn status_code(res: &TestResponse) -> (u16, String) {
    (res.status.as_u16(), res.error_code())
}

async fn two_origins(extra: &[(&str, &str)]) -> TestApp {
    let upstream = closed_upstream();
    let mut vars = vec![
        ("GNOME_PROXY_ORIGIN", PROXY_ORIGIN),
        ("GNOME_PUBLIC_ORIGINS", ORIGIN),
        ("GNOME_WISP_UPSTREAM", upstream.as_str()),
    ];
    vars.extend_from_slice(extra);
    TestApp::new(&vars).await
}

async fn ticket(c: &mut Client<'_>) -> String {
    let res = c.post("/api/wisp/ticket", json!({})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    res.json()["ticket"].as_str().unwrap().to_string()
}

fn profiles_file(dir: &std::path::Path) -> String {
    let path = dir.join("profiles.toml");
    std::fs::write(
        &path,
        format!(
            "[[profile]]\nid = \"se-got\"\nlabel = \"Sweden · Gothenburg\"\ncountry_code = \"se\"\ncountry = \
             \"Sweden\"\ncity = \"Gothenburg\"\nwisp_upstream = \"{}\"\n",
            closed_upstream()
        ),
    )
    .unwrap();
    path.display().to_string()
}

#[tokio::test]
async fn a_valid_ticket_gets_426_without_an_origin_in_every_url_form() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path());
    let app = two_origins(&[("GNOME_VPN_PROFILES", &profiles)]).await;
    let t = ticket(&mut app.client()).await;
    let encoded = t.replace('.', "%2E");
    for route in ["/wisp/", "/wisp/p/se-got/"] {
        for query in [
            format!("t={t}"),
            format!("t={t}&/"),
            format!("t={t}/"),
            format!("x=1&t={t}&y=2&/"),
            format!("t={encoded}&/"),
        ] {
            let res = app.send(probe(&format!("{route}?{query}"))).await;
            let what = format!("{route}?{query}: {}", res.text());
            assert_eq!(status_code(&res), (426, "upgrade_required".into()), "{what}");
            assert_eq!(res.header("upgrade"), Some("websocket"), "{what}");
            assert_eq!(res.header("content-type"), Some("application/json"), "{what}");
            assert_eq!(res.header("cache-control"), Some("no-store"), "{what}");
            assert!(res.set_cookies().is_empty(), "a probe sets no cookie: {what}");
            assert!(!res.text().contains("w1."), "a probe mints nothing: {what}");
        }
    }
    // HEAD is a probe too (status only).
    let res = app.send(probe_req(Method::HEAD, &format!("/wisp/?t={t}&/"))).await;
    assert_eq!(res.status, StatusCode::UPGRADE_REQUIRED);
    assert!(res.body.is_empty());
    // An Origin is not needed, and a foreign one changes nothing: the probe opens nothing.
    let mut with_origin = probe(&format!("/wisp/?t={t}&/"));
    with_origin.headers_mut().insert(header::ORIGIN, "http://evil.example".parse().unwrap());
    assert_eq!(app.send(with_origin).await.status, StatusCode::UPGRADE_REQUIRED);
    // The same forms on real upgrades pass the ticket check (and then fail at the closed upstream: 502).
    for query in [format!("t={t}"), format!("t={t}&/"), format!("t={t}/")] {
        let res = app.send(upgrade(&format!("/wisp/?{query}"))).await;
        assert_eq!(status_code(&res), (502, "bad_gateway".into()), "{query}: {}", res.text());
    }
    // Upgrades still require the proxy Origin.
    let mut no_origin = upgrade(&format!("/wisp/?t={t}&/"));
    no_origin.headers_mut().remove(header::ORIGIN);
    assert_eq!(status_code(&app.send(no_origin).await), (403, "forbidden".into()));
}

#[tokio::test]
async fn refused_tickets_get_401_with_a_specific_code() {
    let app = two_origins(&[]).await;
    let t = ticket(&mut app.client()).await;
    let gw = app.state.ext::<Gateway>().unwrap();
    let sref = SessionRef([4; 16]);
    let expired = gw.mint(sref, now_s() - 1);
    let foreign =
        TicketKey::new(&SecretKey::from_bytes(vec![9; 32]).unwrap(), AccessMode::Open, None).mint(sref, now_s() + 600);
    let other_policy = TicketKey::new(&app.state.secret, AccessMode::Accounts, None).mint(sref, now_s() + 600);
    let mut tampered = t.clone().into_bytes();
    let i = tampered.len() - 2;
    tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap();
    let longer = {
        let p: Vec<&str> = t.split('.').collect();
        format!("w1.{}.{}.{}", now_s() + 999_999, p[2], p[3])
    };
    let cases = [
        ("/wisp/".to_string(), "wisp_ticket_missing"),
        ("/wisp/?".into(), "wisp_ticket_missing"),
        ("/wisp/?t=".into(), "wisp_ticket_missing"),
        ("/wisp/?t=&/".into(), "wisp_ticket_missing"),
        ("/wisp/?ticket=abc".into(), "wisp_ticket_missing"),
        ("/wisp/?t=garbage&/".into(), "wisp_ticket_invalid"),
        (format!("/wisp/?t={t}//"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={t}%2F"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={t}&t={t}"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={t}x&/"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={tampered}&/"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={longer}&/"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={foreign}&/"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={other_policy}&/"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={expired}&/"), "wisp_ticket_expired"),
        (format!("/wisp/?t={expired}/"), "wisp_ticket_expired"),
    ];
    for (path, want) in &cases {
        let res = app.send(probe(path)).await;
        assert_eq!(status_code(&res), (401, (*want).into()), "probe {path}: {}", res.text());
        assert_eq!(res.header("content-type"), Some("application/json"), "{path}");
        assert!(res.json()["error"]["message"].is_string(), "{path}");
        // A real upgrade refuses the same way.
        let res = app.send(upgrade(path)).await;
        assert_eq!(status_code(&res), (401, (*want).into()), "upgrade {path}: {}", res.text());
    }
    // A probe of an unknown profile stays 404, with or without a valid ticket; `direct` is no profile path.
    for path in [format!("/wisp/p/nope/?t={t}&/"), "/wisp/p/nope/".into(), format!("/wisp/p/direct/?t={t}&/")] {
        assert_eq!(status_code(&app.send(probe(&path)).await), (404, "not_found".into()), "{path}");
    }
    // Counted as probes, not as refused upgrades; nothing holds a slot.
    let d = app.send_admin(admin("/admin/diagnostics")).await.json();
    assert_eq!(d["ws"]["probes"], json!({"valid": 0, "rejected": cases.len(), "upstream_down": 0}), "{}", d["ws"]);
    assert_eq!((d["ws"]["clients"].as_u64(), d["ws"]["sessions"].as_u64()), (Some(0), Some(0)));
    let metrics = app.send_admin(admin("/admin/metrics")).await.text();
    assert!(metrics.contains(&format!("gnome_ws_probes_total{{result=\"rejected\"}} {}\n", cases.len())), "{metrics}");
    // The valid ticket is untouched by all of this.
    assert_eq!(app.send(probe(&format!("/wisp/?t={t}&/"))).await.status, StatusCode::UPGRADE_REQUIRED);
}

fn admin(path: &str) -> Request<Body> {
    Request::builder().uri(path).header(header::HOST, "127.0.0.1:9091").body(Body::empty()).unwrap()
}

#[tokio::test]
async fn a_revoked_user_session_gets_401_revoked() {
    let app = two_origins(&[("GNOME_ACCESS_MODE", "accounts")]).await;
    let mut alice = app.client();
    alice.register("alice_p", "a long password").await;
    let t = ticket(&mut alice).await;
    // A live user session: valid.
    assert_eq!(app.send(probe(&format!("/wisp/?t={t}&/"))).await.status, StatusCode::UPGRADE_REQUIRED);
    // A correctly signed ticket for a session that does not exist (deleted account): revoked.
    let gw = app.state.ext::<Gateway>().unwrap();
    let gone = gw.mint(SessionRef::for_user(&[0u8; 32]), now_s() + 600);
    let res = app.send(probe(&format!("/wisp/?t={gone}&/"))).await;
    assert_eq!(status_code(&res), (401, "wisp_ticket_revoked".into()), "{}", res.text());
    // Signing out (no cached answer for that session yet): revoked.
    let mut bob = app.client();
    bob.register("bob_p", "a long password").await;
    let tb = ticket(&mut bob).await;
    assert_eq!(bob.post("/api/auth/logout", json!({})).await.status, StatusCode::NO_CONTENT);
    let res = app.send(probe(&format!("/wisp/?t={tb}&/"))).await;
    assert_eq!(status_code(&res), (401, "wisp_ticket_revoked".into()), "{}", res.text());
}

#[tokio::test]
async fn probes_share_the_per_ip_upgrade_limit() {
    let app = two_origins(&[]).await;
    let t = ticket(&mut app.client()).await;
    let peer = "198.51.100.50:5000".parse().unwrap();
    for i in 0..40 {
        let res = send_to(&app.public, probe(&format!("/wisp/?t={t}&/")), peer).await;
        assert_eq!(res.status, StatusCode::UPGRADE_REQUIRED, "probe {i}: {}", res.text());
    }
    for i in 0..20 {
        let res = send_to(&app.public, probe("/wisp/?t=bad&/"), peer).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "probe {i}: {}", res.text());
    }
    // 60 per minute per IP, probes and upgrades together.
    let res = send_to(&app.public, probe(&format!("/wisp/?t={t}&/")), peer).await;
    assert_eq!(status_code(&res), (429, "rate_limited".into()));
    assert!(res.header("retry-after").is_some());
    let res = send_to(&app.public, upgrade(&format!("/wisp/?t={t}&/")), peer).await;
    assert_eq!(status_code(&res), (429, "rate_limited".into()), "upgrades share the budget");
    let other = send_to(&app.public, probe(&format!("/wisp/?t={t}&/")), "198.51.100.51:5000".parse().unwrap()).await;
    assert_eq!(other.status, StatusCode::UPGRADE_REQUIRED, "other addresses are unaffected");
}

#[tokio::test]
async fn single_origin_mode_probes_on_the_app_origin() {
    let upstream = closed_upstream();
    let app = TestApp::new(&[("GNOME_WISP_UPSTREAM", &upstream)]).await;
    let t = ticket(&mut app.client()).await;
    let res = app.send(get(&format!("/wisp/?t={t}&/"))).await;
    assert_eq!(status_code(&res), (426, "upgrade_required".into()), "{}", res.text());
    assert_eq!(status_code(&app.send(get("/wisp/?t=nope/")).await), (401, "wisp_ticket_invalid".into()));
}

/// While the health job has a route's upstream down, a valid ticket's probe answers `503 wisp_upstream_unavailable`
/// with `Retry-After` instead of `426` (whose upgrade would fail with `502`); refused tickets keep their `401`, other
/// routes are unaffected, and an upstream that was never probed (`unknown`) still gets `426`.
#[tokio::test]
async fn a_route_whose_upstream_is_down_gets_503_with_retry_after() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path());
    let app = two_origins(&[("GNOME_VPN_PROFILES", &profiles)]).await;
    let t = ticket(&mut app.client()).await;
    let gw = app.state.ext::<Gateway>().unwrap();
    // Nothing probed yet: unknown is not down.
    for route in ["/wisp/", "/wisp/p/se-got/"] {
        assert_eq!(app.send(probe(&format!("{route}?t={t}&/"))).await.status, StatusCode::UPGRADE_REQUIRED, "{route}");
    }
    // The health job's probe of the VPN profile fails (nothing listens there).
    gw.upstreams.get("se-got").unwrap().probe_now().await;
    for query in [format!("t={t}&/"), format!("t={t}/"), format!("t={t}")] {
        let res = app.send(probe(&format!("/wisp/p/se-got/?{query}"))).await;
        let what = format!("{query}: {}", res.text());
        assert_eq!(status_code(&res), (503, "wisp_upstream_unavailable".into()), "{what}");
        assert_eq!(res.header("retry-after"), Some("10"), "{what}");
        assert_eq!(res.json()["error"]["retry_after_s"], 10, "{what}");
        assert_eq!(res.header("content-type"), Some("application/json"), "{what}");
        assert_eq!(
            res.header("content-security-policy"),
            Some(
                format!("default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' {ORIGIN}")
                    .as_str()
            ),
            "{what}"
        );
    }
    // The first 503 asked the health job for an early round, which is rate-limited to one per 10 s: nothing else in
    // this test claims it before this point (probe_now() and the 426 probes do not), so the claim is taken.
    assert!(!gw.upstreams.claim_early_probe(), "a 503 probe asks the health job for an early round");
    let head = app.send(probe_req(Method::HEAD, &format!("/wisp/p/se-got/?t={t}&/"))).await;
    assert_eq!((head.status, head.header("retry-after")), (StatusCode::SERVICE_UNAVAILABLE, Some("10")));
    // A ticket the upgrade would refuse is still reported as such (the engine host renews it first).
    let res = app.send(probe("/wisp/p/se-got/?t=garbage&/")).await;
    assert_eq!(status_code(&res), (401, "wisp_ticket_invalid".into()));
    assert_eq!(status_code(&app.send(probe("/wisp/p/se-got/")).await), (401, "wisp_ticket_missing".into()));
    // The direct route has its own upstream.
    assert_eq!(app.send(probe(&format!("/wisp/?t={t}&/"))).await.status, StatusCode::UPGRADE_REQUIRED);
    gw.upstreams.get("direct").unwrap().probe_now().await;
    assert_eq!(
        status_code(&app.send(probe(&format!("/wisp/?t={t}&/"))).await),
        (503, "wisp_upstream_unavailable".into())
    );
    let d = app.send_admin(admin("/admin/diagnostics")).await.json();
    assert_eq!(d["ws"]["probes"], json!({"valid": 3, "rejected": 2, "upstream_down": 5}), "{}", d["ws"]);
    let metrics = app.send_admin(admin("/admin/metrics")).await.text();
    assert!(metrics.contains("gnome_ws_probes_total{result=\"upstream_down\"} 5\n"), "{metrics}");
    // An upgrade still answers as before (502 at the closed upstream).
    let res = app.send(upgrade(&format!("/wisp/p/se-got/?t={t}&/"))).await;
    assert_eq!(status_code(&res), (502, "bad_gateway".into()), "{}", res.text());
}
