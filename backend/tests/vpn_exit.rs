//! The server-side VPN exit check (WAVE-C §6): the minimal Wisp client against an in-process Wisp server, each error
//! class from its cause, the locations shape, the access gate, on-demand checks, the IPv6 name, the schedule's
//! helpers, diagnostics and metrics. Every listener binds a port in 21000-21999.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use futures_util::{SinkExt, StreamExt};
use gnome_server::gateway::upstream::UpstreamAddr;
use gnome_server::module::{Module, ModuleSetup};
use gnome_server::vpn::wisp_client::{WispError, WispStream};
use http::{Method, StatusCode};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

// ------------------------------------------------------------------------------------------- ports and fakes

static NEXT_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(21_400);

async fn listen() -> TcpListener {
    loop {
        let port = NEXT_PORT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        assert!(port < 22_000, "out of test ports");
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            return l;
        }
    }
}

/// A port in the range with nothing listening on it.
async fn closed_port() -> u16 {
    let l = listen().await;
    l.local_addr().unwrap().port()
}

fn frame(kind: u8, stream: u32, payload: &[u8]) -> Message {
    let mut f = vec![kind];
    f.extend_from_slice(&stream.to_le_bytes());
    f.extend_from_slice(payload);
    Message::binary(f)
}

#[derive(Default)]
struct WispLog {
    paths: Vec<String>,
    cookies: usize,
    forwarded: usize,
    connects: Vec<(String, u16)>,
}

#[derive(Clone, Copy)]
struct WispFake {
    buffer: u32,
    silent: bool,
    oversized: bool,
}

/// An in-process Wisp v1 server: CONNECTs go to 127.0.0.1 at the requested port (whatever the host name); a refused
/// connection is a CLOSE (0x42); CONTINUE after every `buffer` packets.
async fn wisp_server(fake: WispFake) -> (SocketAddr, Arc<Mutex<WispLog>>) {
    let l = listen().await;
    let addr = l.local_addr().unwrap();
    let log = Arc::new(Mutex::new(WispLog::default()));
    let log2 = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = l.accept().await else { return };
            let log = log2.clone();
            tokio::spawn(async move {
                #[allow(clippy::result_large_err)] // the handshake callback's signature is tungstenite's
                let cb = |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                          res: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    let mut l = log.lock().unwrap();
                    l.paths.push(req.uri().path().to_string());
                    l.cookies += usize::from(req.headers().contains_key("cookie"));
                    l.forwarded += usize::from(req.headers().contains_key("x-forwarded-for"));
                    Ok(res)
                };
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, cb).await else { return };
                if fake.silent {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    return;
                }
                ws.send(frame(3, 0, &fake.buffer.to_le_bytes())).await.unwrap();
                let Some(Ok(Message::Binary(c))) = ws.next().await else { return };
                let (id, port) = (u32::from_le_bytes(c[1..5].try_into().unwrap()), u16::from_le_bytes([c[6], c[7]]));
                let host = String::from_utf8_lossy(&c[8..]).to_string();
                log.lock().unwrap().connects.push((host, port));
                if fake.oversized {
                    ws.send(frame(2, id, &vec![0u8; 70 * 1024])).await.unwrap();
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    return;
                }
                let Ok(mut target) = TcpStream::connect(("127.0.0.1", port)).await else {
                    let _ = ws.send(frame(4, id, &[0x42])).await;
                    return;
                };
                let mut buf = vec![0u8; 8192];
                let mut got = 0u32;
                loop {
                    tokio::select! {
                        n = target.read(&mut buf) => match n {
                            Ok(0) | Err(_) => {
                                let _ = ws.send(frame(4, id, &[0x02])).await;
                                return;
                            }
                            Ok(n) => {
                                if ws.send(frame(2, id, &buf[..n])).await.is_err() {
                                    return;
                                }
                            }
                        },
                        m = ws.next() => match m {
                            Some(Ok(Message::Binary(b))) if b[0] == 2 => {
                                if target.write_all(&b[5..]).await.is_err() {
                                    return;
                                }
                                got += 1;
                                if got.is_multiple_of(fake.buffer) {
                                    ws.send(frame(3, id, &fake.buffer.to_le_bytes())).await.unwrap();
                                }
                            }
                            Some(Ok(Message::Binary(b))) if b[0] == 4 => {
                                let _ = target.shutdown().await;
                                return;
                            }
                            None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                            _ => {}
                        },
                    }
                }
            });
        }
    });
    (addr, log)
}

const WISP: WispFake = WispFake { buffer: 64, silent: false, oversized: false };

/// A one-answer-per-connection HTTP target; records each request.
async fn http_target(answer: Vec<u8>, delay: Duration) -> (u16, Arc<Mutex<Vec<String>>>) {
    let l = listen().await;
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let (answer, seen) = (answer.clone(), seen2.clone());
            tokio::spawn(async move {
                let req = read_head(&mut s).await;
                seen.lock().unwrap().push(req);
                tokio::time::sleep(delay).await;
                let _ = s.write_all(&answer).await;
                let _ = s.shutdown().await;
            });
        }
    });
    (port, seen)
}

async fn read_head<S: tokio::io::AsyncRead + Unpin>(s: &mut S) -> String {
    let mut req = Vec::new();
    let mut b = [0u8; 1024];
    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
        match s.read(&mut b).await {
            Ok(0) | Err(_) => break,
            Ok(n) => req.extend_from_slice(&b[..n]),
        }
    }
    String::from_utf8_lossy(&req).into_owned()
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/vpn/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn test_roots() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(rustls::pki_types::CertificateDer::from(fixture("ca.der"))).unwrap();
    roots
}

/// A TLS target for `check.test` (the test CA's certificate).
async fn tls_target(answer: Vec<u8>) -> u16 {
    let cert = rustls::pki_types::CertificateDer::from(fixture("check.test.der"));
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(fixture("check.test.key.der").into());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let l = listen().await;
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = l.accept().await else { return };
            let (acceptor, answer) = (acceptor.clone(), answer.clone());
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(s).await else { return };
                read_head(&mut tls).await;
                let _ = tls.write_all(&answer).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    port
}

fn ok_json(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
        .into_bytes()
}

const SE: &str = r#"{"ip":"185.65.134.1","country":"Sweden","city":"Gothenburg","mullvad_exit_ip":true}"#;

fn profiles_file(dir: &std::path::Path, upstreams: &[(&str, SocketAddr)]) -> String {
    let mut text = String::new();
    for (id, addr) in upstreams {
        text.push_str(&format!(
            "[[profile]]\nid = \"{id}\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \"Gothenburg\"\nprovider_note = \"the operator's own test tunnel\"\nwisp_upstream = \"{addr}\"\n\n"
        ));
    }
    let path = dir.join("profiles.toml");
    std::fs::write(&path, text).unwrap();
    path.display().to_string()
}

/// The built-in modules with the checker trusting the test CA.
fn modules(setup: &mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>> {
    let mut m: Vec<Arc<dyn Module>> = vec![Arc::new(gnome_server::api::CoreApi)];
    if setup.state.config.accounts {
        m.push(Arc::new(gnome_server::api::Accounts));
    }
    m.push(gnome_server::gateway::install(setup, gnome_server::gateway::GatewayOptions::default()));
    m.push(gnome_server::vpn::install_with_roots(setup, test_roots()));
    m
}

struct Vpn {
    app: TestApp,
    _dir: tempfile::TempDir,
}

async fn vpn_app(upstreams: &[(&str, SocketAddr)], check_url: &str, extra: &[(&str, &str)]) -> Vpn {
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path(), upstreams);
    let mut vars = vec![
        ("GNOME_VPN_PROFILES", profiles.as_str()),
        ("GNOME_VPN_CHECK_URL", check_url),
        ("GNOME_CATALOG_SOURCES", "none"),
    ];
    vars.extend_from_slice(extra);
    Vpn { app: TestApp::with_modules(&vars, |_| {}, modules).await, _dir: dir }
}

async fn check(app: &TestApp, id: &str) -> (StatusCode, Value) {
    let r = app.send(json_req(Method::POST, &format!("/api/vpn/locations/{id}/check"), &json!({}))).await;
    (r.status, if r.body.is_empty() { Value::Null } else { r.json() })
}

fn vpn_jobs(app: &TestApp) -> Vec<&'static str> {
    let vpn = app.state.modules().iter().find(|m| m.name() == "vpn").unwrap();
    vpn.jobs(&app.state).iter().map(|j| j.name).collect()
}

// ------------------------------------------------------------------------------------------------ the tests

#[tokio::test]
async fn wisp_client_echo_flow_control_close_and_errors() {
    // An echo target through a 2-packet buffer: many writes, all echoed.
    let echo = listen().await;
    let port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut b = vec![0u8; 4096];
                while let Ok(n) = s.read(&mut b).await {
                    if n == 0 || s.write_all(&b[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let (addr, log) = wisp_server(WispFake { buffer: 2, ..WISP }).await;
    let up = UpstreamAddr::parse(&addr.to_string()).unwrap();
    let mut s = WispStream::connect(&up, "/wisp/p/se/", "echo.test", port, Duration::from_secs(5)).await.unwrap();
    let sent: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let (mut r, mut w) = tokio::io::split(s);
    let writer = {
        let sent = sent.clone();
        tokio::spawn(async move {
            for chunk in sent.chunks(10_000) {
                w.write_all(chunk).await.unwrap();
            }
            w
        })
    };
    let mut got = vec![0u8; sent.len()];
    r.read_exact(&mut got).await.unwrap();
    assert_eq!(got, sent);
    let w = writer.await.unwrap();
    s = r.unsplit(w);
    assert_eq!(log.lock().unwrap().paths, ["/wisp/p/se/"]);
    assert_eq!(log.lock().unwrap().connects, [("echo.test".to_string(), port)]);
    // Half-close sends Wisp CLOSE: the target sees the end.
    s.shutdown().await.unwrap();
    // CLOSE before data → Closed(reason).
    let refused = closed_port().await;
    let mut c = WispStream::connect(&up, "/wisp/p/se/", "x.test", refused, Duration::from_secs(5)).await.unwrap();
    let mut b = [0u8; 8];
    assert_eq!(c.read(&mut b).await.unwrap(), 0);
    assert_eq!(c.error(), Some(WispError::Closed(0x42)));
    // An oversized frame.
    let (big, _) = wisp_server(WispFake { oversized: true, ..WISP }).await;
    let up_big = UpstreamAddr::parse(&big.to_string()).unwrap();
    let mut o = WispStream::connect(&up_big, "/wisp/p/se/", "x.test", 1, Duration::from_secs(5)).await.unwrap();
    let _ = o.read(&mut b).await;
    assert_eq!(o.error(), Some(WispError::Upstream));
    // A server that never sends its first CONTINUE: Upstream within the timeout.
    let (silent, _) = wisp_server(WispFake { silent: true, ..WISP }).await;
    let up_silent = UpstreamAddr::parse(&silent.to_string()).unwrap();
    let started = std::time::Instant::now();
    let e = WispStream::connect(&up_silent, "/wisp/p/se/", "x.test", 1, Duration::from_millis(300)).await.unwrap_err();
    assert_eq!(e, WispError::Upstream);
    assert!(started.elapsed() < Duration::from_secs(2));
    // Nothing listening: Upstream.
    let nothing = UpstreamAddr::parse(&format!("127.0.0.1:{}", closed_port().await)).unwrap();
    let e = WispStream::connect(&nothing, "/wisp/p/se/", "x.test", 1, Duration::from_secs(1)).await.unwrap_err();
    assert_eq!(e, WispError::Upstream);
}

#[tokio::test]
async fn default_server_runs_no_checks() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path(), &[("se", "127.0.0.1:21998".parse().unwrap())]);
    let app = TestApp::new(&[("GNOME_VPN_PROFILES", profiles.as_str())]).await;
    let v = app.send(get("/api/vpn/locations")).await.json();
    assert_eq!(v["verify_url"], Value::Null);
    assert_eq!(v["check_service"], Value::Null);
    assert_eq!(
        v["profiles"][0]["exit"],
        json!({"state": "off", "ip": null, "country": null, "city": null, "provider_exit": null,
               "country_match": null, "checked_at": null, "error": null, "v6": null})
    );
    let (status, _) = check(&app, "se").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "no check route without a check service");
    assert!(app.state.ext::<gnome_server::vpn::exit::ExitChecker>().is_none());
    assert!(vpn_jobs(&app).is_empty());
    let d = app.send_admin(common::games::admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["vpn"]["check_service"], Value::Null);
}

#[tokio::test]
async fn http_check_reports_the_exit() {
    let (wisp, log) = wisp_server(WISP).await;
    let (port, seen) = http_target(ok_json(SE), Duration::ZERO).await;
    let url = format!("http://check.test:{port}/json?fmt=1");
    let v = vpn_app(&[("se", wisp)], &url, &[]).await;
    let loc = v.app.send(get("/api/vpn/locations")).await.json();
    assert_eq!(loc["verify_url"], url.as_str());
    assert_eq!(loc["check_service"], format!("check.test:{port}"));
    assert_eq!(loc["profiles"][0]["exit"]["state"], "unchecked");
    let (status, body) = check(&v.app, "se").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let exit = &body["exit"];
    assert_eq!(
        (exit["state"].clone(), exit["ip"].clone(), exit["country_match"].clone(), exit["provider_exit"].clone()),
        (json!("ok"), json!("185.65.134.1"), json!(true), json!(true))
    );
    assert!(exit["checked_at"].is_i64() && exit["error"].is_null() && exit["v6"].is_null());
    let req = seen.lock().unwrap()[0].clone();
    assert!(req.starts_with("GET /json?fmt=1 HTTP/1.1\r\n"), "{req}");
    assert!(req.contains(&format!("\r\nHost: check.test:{port}\r\n")), "{req}");
    assert!(req.contains("\r\nUser-Agent: exit-check/1\r\n"), "{req}");
    assert!(!req.to_ascii_lowercase().contains("gnome"), "names no product: {req}");
    {
        let l = log.lock().unwrap();
        assert_eq!(l.paths, ["/wisp/p/se/"]);
        assert_eq!((l.cookies, l.forwarded), (0, 0));
    }
    // Shown in the locations list from now on; reused within 60 s (no new request).
    let loc = v.app.send(get("/api/vpn/locations")).await.json();
    assert_eq!(loc["profiles"][0]["exit"], *exit);
    let (_, again) = check(&v.app, "se").await;
    assert_eq!(again["exit"]["checked_at"], exit["checked_at"]);
    assert_eq!(seen.lock().unwrap().len(), 1);
    // 404, 403 without the CSRF header.
    assert_eq!(check(&v.app, "nope").await.0, StatusCode::NOT_FOUND);
    let no_csrf = http::Request::builder()
        .method(Method::POST)
        .uri("/api/vpn/locations/se/check")
        .header("host", HOST)
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(v.app.send(no_csrf).await.status, StatusCode::FORBIDDEN);
    // Diagnostics and metrics.
    let d = v.app.send_admin(common::games::admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["vpn"]["check_service"], format!("check.test:{port}"));
    assert_eq!(d["vpn"]["interval_min"], 15);
    assert_eq!(d["vpn"]["exits"]["se"]["state"], "ok");
    assert_eq!(d["config"]["vpn_check_url"], format!("check.test:{port}"), "the host only");
    let m = v.app.send_admin(common::games::admin_get("/admin/metrics")).await.text();
    for line in [
        "gnome_vpn_exit_checks_total{id=\"se\",result=\"ok\"} 1",
        "gnome_vpn_exit_ok{id=\"se\"} 1",
        "gnome_vpn_exit_checked_seconds{id=\"se\"}",
    ] {
        assert!(m.contains(line), "{line}\n{m}");
    }
    assert_eq!(vpn_jobs(&v.app), ["vpn.exit-check"]);
    let on_request = vpn_app(&[("se", wisp)], &url, &[("GNOME_VPN_CHECK_INTERVAL_MIN", "0")]).await;
    assert!(vpn_jobs(&on_request.app).is_empty(), "0 = on request only");
}

#[tokio::test]
async fn each_error_class_from_its_cause() {
    let (wisp, _) = wisp_server(WISP).await;
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("http_status", b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n".to_vec(), "http_status"),
        ("html", b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!doctype html><p>hi".to_vec(), "bad_answer"),
        ("no_ip", ok_json(r#"{"country":"Sweden"}"#), "bad_answer"),
        ("huge", ok_json(&format!(r#"{{"ip":"192.0.2.1","pad":"{}"}}"#, "x".repeat(17 * 1024))), "bad_answer"),
    ];
    for (name, answer, expected) in cases {
        let (port, _) = http_target(answer, Duration::ZERO).await;
        let v = vpn_app(&[("se", wisp)], &format!("http://check.test:{port}/"), &[]).await;
        let (_, body) = check(&v.app, "se").await;
        assert_eq!(
            (body["exit"]["state"].as_str(), body["exit"]["error"].as_str()),
            (Some("failed"), Some(expected)),
            "{name}: {body}"
        );
    }
    // Chunked answers are decoded.
    let chunked = format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{SE}\r\n0\r\n\r\n", SE.len());
    let (port, _) = http_target(chunked.into_bytes(), Duration::ZERO).await;
    let v = vpn_app(&[("se", wisp)], &format!("http://check.test:{port}/"), &[]).await;
    assert_eq!(check(&v.app, "se").await.1["exit"]["state"], "ok");
    // A closed target port: the Wisp server CLOSEs before data.
    let v = vpn_app(&[("se", wisp)], &format!("http://check.test:{}/", closed_port().await), &[]).await;
    assert_eq!(check(&v.app, "se").await.1["exit"]["error"], "connect_failed");
    // No HolyWisp at the location's upstream; a location the health job has down is not contacted.
    let dead: SocketAddr = format!("127.0.0.1:{}", closed_port().await).parse().unwrap();
    let v = vpn_app(&[("se", dead)], "http://check.test:21999/", &[]).await;
    assert_eq!(check(&v.app, "se").await.1["exit"]["error"], "upstream_unreachable");
    let gw = v.app.state.ext::<gnome_server::gateway::Gateway>().unwrap();
    gw.upstreams.get("se").unwrap().probe_now().await;
    let loc = v.app.send(get("/api/vpn/locations")).await.json();
    assert_eq!(loc["profiles"][0]["status"], "down");
    let checker = v.app.state.ext::<gnome_server::vpn::exit::ExitChecker>().unwrap();
    let r = checker.check(&v.app.state, &v.app.state.config.profiles[0]).await;
    assert_eq!(r.error, Some(gnome_server::vpn::exit::ExitError::UpstreamUnreachable));
    // TLS: the test CA's certificate passes; an untrusted one fails.
    let tls_port = tls_target(ok_json(SE)).await;
    let v = vpn_app(&[("se", wisp)], &format!("https://check.test:{tls_port}/json"), &[]).await;
    assert_eq!(check(&v.app, "se").await.1["exit"]["state"], "ok");
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path(), &[("se", wisp)]);
    let url = format!("https://check.test:{tls_port}/json");
    let untrusted = TestApp::new(&[
        ("GNOME_VPN_PROFILES", profiles.as_str()),
        ("GNOME_VPN_CHECK_URL", url.as_str()),
        ("GNOME_CATALOG_SOURCES", "none"),
    ])
    .await;
    assert_eq!(check(&untrusted, "se").await.1["exit"]["error"], "tls_failed");
}

#[tokio::test]
async fn a_slow_service_times_out() {
    let (wisp, _) = wisp_server(WISP).await;
    let (port, _) = http_target(ok_json(SE), Duration::from_secs(20)).await;
    let v = vpn_app(&[("se", wisp)], &format!("http://check.test:{port}/"), &[]).await;
    let started = std::time::Instant::now();
    let (_, body) = check(&v.app, "se").await;
    assert_eq!(body["exit"]["error"], "timeout", "{body}");
    assert!(started.elapsed() < Duration::from_secs(18));
}

#[tokio::test]
async fn the_access_gate() {
    let (wisp, _) = wisp_server(WISP).await;
    let (port, _) = http_target(ok_json(SE), Duration::ZERO).await;
    let url = format!("http://check.test:{port}/");
    // Code mode: no session → health fields only, check 401; with a session → details.
    let v = vpn_app(&[("se", wisp)], &url, &[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "long-enough-code")])
        .await;
    let (status, body) = check(&v.app, "se").await;
    assert_eq!((status, body["error"]["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("access_code_required")));
    let mut client = v.app.client();
    assert_eq!(client.post("/api/session", json!({"access_code": "long-enough-code"})).await.status, StatusCode::OK);
    let res = client.post("/api/vpn/locations/se/check", json!({})).await;
    assert_eq!(res.json()["exit"]["state"], "ok");
    let anon = v.app.send(get("/api/vpn/locations")).await.json();
    let exit = &anon["profiles"][0]["exit"];
    assert_eq!(exit["state"], "unchecked");
    assert!(exit["ip"].is_null() && exit["provider_exit"].is_null() && exit["country"].is_null());
    assert_eq!(anon["profiles"][0]["status"], "unknown", "the health fields stay public");
    let admitted = client.get("/api/vpn/locations").await.json();
    assert_eq!(admitted["profiles"][0]["exit"]["ip"], "185.65.134.1");
    // Accounts mode: login_required.
    let v = vpn_app(&[("se", wisp)], &url, &[("GNOME_ACCESS_MODE", "accounts")]).await;
    let (status, body) = check(&v.app, "se").await;
    assert_eq!((status, body["error"]["code"].as_str()), (StatusCode::UNAUTHORIZED, Some("login_required")));
    let mut user = v.app.client();
    assert_eq!(user.register("exituser", "correct horse battery").await.status, StatusCode::CREATED);
    assert_eq!(user.post("/api/vpn/locations/se/check", json!({})).await.json()["exit"]["state"], "ok");
}

#[tokio::test]
async fn ipv6_name_rate_limit_and_joined_checks() {
    let (wisp, _) = wisp_server(WISP).await;
    let (wisp2, _) = wisp_server(WISP).await;
    let (p4, seen4) = http_target(ok_json(SE), Duration::from_millis(200)).await;
    let (p6, _) = http_target(ok_json(r#"{"ip":"2a03:1b20::1"}"#), Duration::ZERO).await;
    let (u4, u6) = (format!("http://check.test:{p4}/"), format!("http://ipv6.check.test:{p6}/"));
    let v = vpn_app(
        &[("se", wisp), ("se2", wisp2)],
        &u4,
        &[("GNOME_VPN_CHECK_URL_V6", u6.as_str()), ("GNOME_RATE_LIMIT_SCALE", "0.2")],
    )
    .await;
    assert_eq!(v.app.send(get("/api/vpn/locations")).await.json()["profiles"][0]["exit"]["v6"]["state"], "unchecked");
    // Two concurrent on-demand checks of one location share one check.
    let checker = v.app.state.ext::<gnome_server::vpn::exit::ExitChecker>().unwrap();
    let profile = &v.app.state.config.profiles[0];
    let (a, b) = tokio::join!(checker.check(&v.app.state, profile), checker.check(&v.app.state, profile));
    assert_eq!(a, b);
    assert_eq!(seen4.lock().unwrap().len(), 1);
    assert_eq!(a.v6.as_ref().unwrap().ip.as_deref(), Some("2a03:1b20::1"));
    // Scale 0.2: one vpn_check token. se is fresh (reused, no token); se2 takes the token; then 429.
    assert_eq!(check(&v.app, "se").await.0, StatusCode::OK);
    assert_eq!(check(&v.app, "se2").await.0, StatusCode::OK);
}

#[tokio::test]
async fn on_demand_checks_are_rate_limited() {
    let (wa, _) = wisp_server(WISP).await;
    let (wb, _) = wisp_server(WISP).await;
    let (port, _) = http_target(ok_json(SE), Duration::ZERO).await;
    // Scale 0.2: one token; two locations: the first check passes, the second is 429.
    let v =
        vpn_app(&[("a", wa), ("b", wb)], &format!("http://check.test:{port}/"), &[("GNOME_RATE_LIMIT_SCALE", "0.2")])
            .await;
    assert_eq!(check(&v.app, "a").await.0, StatusCode::OK);
    let (status, body) = check(&v.app, "b").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
}

/// A real check through a real HolyWisp (`HOLYWISP_BIN`) to the service named by `VPN_CHECK_ONLINE_URL` (skipped when
/// unset; point it at a check endpoint you run, never at a third party's service). It reports this machine's
/// address, which the test does not print.
#[tokio::test]
#[ignore = "needs HOLYWISP_BIN, VPN_CHECK_ONLINE_URL and network"]
async fn online_check_through_holywisp() {
    let (Ok(bin), Ok(url)) = (std::env::var("HOLYWISP_BIN"), std::env::var("VPN_CHECK_ONLINE_URL")) else {
        eprintln!("skipped: set HOLYWISP_BIN and VPN_CHECK_ONLINE_URL");
        return;
    };
    let port = closed_port().await;
    let conf = format!("{}/../services/holywisp/gnome.conf", env!("CARGO_MANIFEST_DIR"));
    let mut child = std::process::Command::new(bin)
        .args(["--config", &conf, "--port", &port.to_string(), "--log-level", "warn", "--workers", "1"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    for _ in 0..100 {
        if TcpStream::connect(addr).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let dir = tempfile::tempdir().unwrap();
    let profiles = profiles_file(dir.path(), &[("online", addr)]);
    let app = TestApp::new(&[
        ("GNOME_VPN_PROFILES", profiles.as_str()),
        ("GNOME_VPN_CHECK_URL", url.as_str()),
        ("GNOME_CATALOG_SOURCES", "none"),
    ])
    .await;
    let (_, body) = check(&app, "online").await;
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(body["exit"]["state"], "ok", "error: {}", body["exit"]["error"]);
    assert!(body["exit"]["ip"].is_string());
}
