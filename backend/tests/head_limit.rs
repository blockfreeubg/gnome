//! WAVE-D D19 head limits (row CF4 at the socket level) and the large-head budget: per listener, the head buffer is
//! 1 MiB for trusted peers on the app listener and loopback peers on the proxy listener, 64 KiB otherwise and on the
//! admin listener; Wisp upgrades over 64 KiB are refused with the hardened `431` unless the peer is loopback; heads
//! over 64 KiB need room in `GNOME_MAX_INFLIGHT_HEAD_MB` (twice their size) and one of 4 slots per client key.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use common::*;
use gnome_server::AppState;
use gnome_server::module::{Module, builtin_modules};
use gnome_server::security::csp::NOTHING_RUNS_UNFRAMED;
use gnome_server::server::{Listeners, serve_all};
use http::{Request, StatusCode};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpSocket};
use tokio::sync::Semaphore;

async fn roundtrip_from(addr: SocketAddr, raw: &str, src: &str) -> String {
    // When the server refuses a head while the client is still sending it, the close may reset the connection before
    // the answer is read (TCP discards it on RST); a few attempts get the answer itself, which is what is checked.
    for _ in 0..4 {
        let res = roundtrip_once(addr, raw, src).await;
        if !res.is_empty() {
            return res;
        }
    }
    String::new()
}

async fn roundtrip_once(addr: SocketAddr, raw: &str, src: &str) -> String {
    let sock = TcpSocket::new_v4().unwrap();
    sock.bind(format!("{src}:0").parse().unwrap()).unwrap();
    let s = sock.connect(addr).await.unwrap();
    // Write and read at once: a refused head is answered (and the socket closed) before every byte is written.
    let (mut rd, mut wr) = s.into_split();
    let raw = raw.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        let _ = wr.write_all(&raw).await;
        wr
    });
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let read = tokio::time::timeout(Duration::from_secs(10), async {
        while let Ok(n) = rd.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    })
    .await;
    assert!(read.is_ok(), "response in time");
    writer.abort();
    String::from_utf8_lossy(&buf).into_owned()
}

fn cookie_head(path: &str, host: &str, bytes: usize, extra: &str) -> String {
    let n = bytes / 3900 + 1;
    let cookies: Vec<String> = (0..n).map(|i| format!("f{i}={}", "c".repeat(3890))).collect();
    format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Cookie: {}\r\nConnection: close\r\n\r\n", cookies.join("; "))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn head_buffers_per_listener_and_peer() {
    let (pl, xl, al) = (
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
    );
    let (public, proxy, admin) = (pl.local_addr().unwrap(), xl.local_addr().unwrap(), al.local_addr().unwrap());
    let proxy_s = proxy.to_string();
    let app = TestApp::new(&[("GNOME_PROXY_BIND", &proxy_s), ("GNOME_PUBLIC_ORIGINS", ORIGIN)]).await;
    tokio::spawn(serve_all(app.state.clone(), Listeners { public: pl, proxy: Some(xl), admin: Some(al) }, async {
        std::future::pending::<()>().await
    }));
    // hyper's automatic answer or the limits layer's exact-cap answer: both carry the strict policy and no body.
    let hardened_431 = |res: &str| {
        let lower = res.to_ascii_lowercase();
        res.starts_with("HTTP/1.1 431 ")
            && lower.contains(&format!("content-security-policy: {NOTHING_RUNS_UNFRAMED}\r\n"))
            && lower.matches("content-security-policy").count() == 1
            && lower.contains("x-content-type-options: nosniff")
            && lower.ends_with("\r\n\r\n")
    };

    // App listener: 200 KB from the untrusted 127.0.0.2 → 431; from the trusted 127.0.0.1 → the normal answer.
    let res = roundtrip_from(public, &cookie_head("/nope", HOST, 200_000, ""), "127.0.0.2").await;
    assert!(hardened_431(&res), "untrusted 200 KB: {res}");
    let res = roundtrip_from(public, &cookie_head("/api/health", HOST, 200_000, ""), "127.0.0.1").await;
    assert!(res.starts_with("HTTP/1.1 200 "), "trusted 200 KB: {res}");
    // 1.5 MiB from the trusted peer is over the 1 MiB buffer.
    let res = roundtrip_from(public, &cookie_head("/api/health", HOST, 1_500_000, ""), "127.0.0.1").await;
    assert!(hardened_431(&res), "trusted 1.5 MiB: {res}");
    // Admin listener: 64 KiB for everyone.
    let res = roundtrip_from(admin, &cookie_head("/admin/diagnostics", "127.0.0.1", 200_000, ""), "127.0.0.1").await;
    assert!(hardened_431(&res), "admin 200 KB: {res}");
    // Proxy listener: 1 MiB for loopback peers only (127.0.0.2 is loopback too, so trust does not matter here).
    let res = roundtrip_from(proxy, &cookie_head("/api/health", &proxy_s, 200_000, ""), "127.0.0.1").await;
    assert!(!res.starts_with("HTTP/1.1 431 "), "proxy loopback 200 KB: {res}");
    // A Wisp upgrade head of 200 KB from 127.0.0.2 on the app listener: the 64 KiB buffer refuses it.
    let upgrade = "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n";
    let res = roundtrip_from(public, &cookie_head("/wisp/?t=x", HOST, 200_000, upgrade), "127.0.0.2").await;
    assert!(hardened_431(&res), "untrusted Wisp upgrade 200 KB: {res}");
    app.state.shutdown.cancel();
}

#[tokio::test]
async fn wisp_upgrades_over_64_kib_are_refused_unless_loopback() {
    let app = TestApp::new(&[("GNOME_PROXY_ORIGIN", "http://p.gnome.test"), ("GNOME_PUBLIC_ORIGINS", ORIGIN)]).await;
    let upgrade = |pad: usize| {
        Request::builder()
            .uri("/wisp/?t=nope")
            .header("host", "p.gnome.test")
            .header("origin", "http://p.gnome.test")
            .header("upgrade", "websocket")
            .header("connection", "upgrade")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "AAAAAAAAAAAAAAAAAAAAAA==")
            .header("x-pad", "p".repeat(pad))
            .body(Body::empty())
            .unwrap()
    };
    // A trusted front that is not loopback forwards a 70 KB head: the hardened 431.
    let far: SocketAddr = "203.0.113.10:4000".parse().unwrap();
    let res = send_to(&app.public, upgrade(70_000), far).await;
    assert_eq!(res.status, StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE);
    assert_eq!(res.header("content-security-policy"), Some(NOTHING_RUNS_UNFRAMED));
    assert!(res.body.is_empty());
    // The same from loopback reaches the ticket check (development's flooded cookies reach the proxy port too).
    let res = send_to(&app.public, upgrade(70_000), "127.0.0.1:4000".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{}", res.text());
    // A small head from far away also reaches the ticket check.
    let res = send_to(&app.public, upgrade(1000), far).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{}", res.text());
    let gw = app.state.ext::<gnome_server::gateway::Gateway>().unwrap();
    assert_eq!(gw.stats.rejected(gnome_server::gateway::Reject::HeadTooLarge), 1);
}

struct Blocker(Arc<Semaphore>);

impl Module for Blocker {
    fn name(&self) -> &'static str {
        "blocker"
    }
    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        let gate = self.0.clone();
        Router::new().route(
            "/block",
            axum::routing::get(move || {
                let gate = gate.clone();
                async move {
                    let _ = gate.acquire().await.map(|p| p.forget());
                    "released"
                }
            }),
        )
    }
}

fn large(xff: &str, pad: usize) -> Request<Body> {
    req(http::Method::GET, "/block")
        .header("x-forwarded-for", xff)
        .header("x-pad", "p".repeat(pad))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_large_head_budget_bounds_bytes_and_slots() {
    let gate = Arc::new(Semaphore::new(0));
    let g = gate.clone();
    // 4 MiB budget: a 600 KB head takes 1.2 MB, so three fit.
    let app = TestApp::with_modules(
        &[("GNOME_MAX_INFLIGHT_HEAD_MB", "4")],
        |_| {},
        move |s| {
            let mut list = builtin_modules(s);
            list.push(Arc::new(Blocker(g)));
            list
        },
    )
    .await;
    let front: SocketAddr = "127.0.0.1:40000".parse().unwrap();
    let hold = |xff: &str, pad: usize| {
        let (router, r) = (app.public.clone(), large(xff, pad));
        tokio::spawn(async move { send_to(&router, r, front).await })
    };
    // One client key: 4 slots, the 5th is refused although the budget has room (4 x 300 KB x 2 = 2.4 MB).
    let mut held: Vec<_> = (0..4).map(|_| hold("198.51.100.1", 300_000)).collect();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let res = send_to(&app.public, large("198.51.100.1", 300_000), front).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "5th large head of one key");
    assert_eq!(res.header("retry-after"), Some("1"));
    assert_eq!(res.header("content-security-policy"), Some(NOTHING_RUNS_UNFRAMED), "the strict policy");
    assert!(res.body.is_empty());
    // Other keys: the byte budget (4 MiB, 2.4 MB used) has room for one more 600 KB head (1.2 MB), not two.
    held.push(hold("198.51.100.2", 600_000));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let res = send_to(&app.public, large("198.51.100.3", 600_000), front).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "past the byte budget");
    // A small head is never counted.
    let res = send_to(&app.public, get("/api/health"), front).await;
    assert_eq!(res.status, StatusCode::OK);
    let d = app.send_admin(admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["connections"]["large_head"]["refused"], 2);
    assert_eq!(d["connections"]["large_head"]["budget_bytes"], 4 * 1024 * 1024);
    assert!(d["connections"]["large_head"]["used_bytes"].as_u64().unwrap() > 3_000_000);
    // Room is released when the response head is ready.
    gate.add_permits(held.len());
    for h in held {
        assert_eq!(h.await.unwrap().status, StatusCode::OK);
    }
    let d = app.send_admin(admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["connections"]["large_head"]["used_bytes"], 0);
    gate.add_permits(1);
    let res = send_to(&app.public, large("198.51.100.1", 600_000), front).await;
    assert_eq!(res.status, StatusCode::OK);
    let metrics = app.send_admin(admin_get("/admin/metrics")).await.text();
    assert!(metrics.contains("gnome_http_large_head_refused_total 2"), "{metrics}");
}

fn admin_get(path: &str) -> Request<Body> {
    Request::builder().uri(path).header("host", "127.0.0.1:9091").body(Body::empty()).unwrap()
}
