//! Real sockets: the accept loop, HEAD over the wire, keep-alive, jobs, graceful shutdown, HTTP upgrades.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::response::Response;
use common::*;
use gnome_server::AppState;
use gnome_server::module::{Module, builtin_modules};
use gnome_server::server::ConnIo;
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

async fn roundtrip(addr: SocketAddr, raw: &str) -> String {
    roundtrip_from(addr, raw, "127.0.0.1").await
}

/// [`roundtrip`] from the source address `src` (127.0.0.2 is outside the default `GNOME_TRUSTED_PROXIES`).
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
    let sock = tokio::net::TcpSocket::new_v4().unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serves_over_tcp_and_shuts_down_gracefully() {
    let app = TestApp::with_static(&[], |root| {
        std::fs::write(root.join("index.html"), "<!doctype html><title>t</title>").unwrap();
    })
    .await;
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let admin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (paddr, aaddr) = (public.local_addr().unwrap(), admin.local_addr().unwrap());
    let state = app.state.clone();
    let server = tokio::spawn(gnome_server::server::serve(state.clone(), public, Some(admin), std::future::pending()));

    let res = roundtrip(paddr, "GET /api/health HTTP/1.1\r\nHost: gnome.test\r\nConnection: close\r\n\r\n").await;
    assert!(res.starts_with("HTTP/1.1 200 OK\r\n"), "{res}");
    assert!(res.contains("\"status\":\"ok\""), "{res}");
    assert!(res.to_ascii_lowercase().contains("x-request-id: "), "{res}");

    // HEAD keeps the real Content-Length and sends no body.
    let res = roundtrip(paddr, "HEAD / HTTP/1.1\r\nHost: gnome.test\r\nConnection: close\r\n\r\n").await;
    assert!(res.starts_with("HTTP/1.1 200 OK\r\n"), "{res}");
    assert!(res.to_ascii_lowercase().contains("content-length: 31\r\n"), "{res}");
    assert!(res.ends_with("\r\n\r\n"), "no body after the head: {res:?}");

    // The app's ticket clock reads the Date header of POST /api/wisp/ticket (WAVE-B §6 item 7).
    let res = roundtrip(
        paddr,
        "POST /api/wisp/ticket HTTP/1.1\r\nHost: gnome.test\r\nX-GNOME-Request: 1\r\nOrigin: http://gnome.test\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert!(res.starts_with("HTTP/1.1 200 OK\r\n"), "{res}");
    let date = res.lines().find_map(|l| l.strip_prefix("date: ").or_else(|| l.strip_prefix("Date: ")));
    assert!(date.is_some_and(|d| d.ends_with(" GMT")), "a Date header: {res}");

    // Two requests on one keep-alive connection.
    let res = roundtrip(
        paddr,
        "GET /api/config HTTP/1.1\r\nHost: gnome.test\r\n\r\nGET /api/health HTTP/1.1\r\nHost: gnome.test\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(res.matches("HTTP/1.1 200 OK").count(), 2, "{res}");

    // Admin listener answers on its own port; the public port does not have it.
    let res = roundtrip(aaddr, "GET /admin/diagnostics HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await;
    assert!(res.starts_with("HTTP/1.1 200 OK\r\n"), "{res}");
    let res = roundtrip(paddr, "GET /admin/diagnostics HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await;
    assert!(res.starts_with("HTTP/1.1 404 Not Found\r\n"), "{res}");

    // Jobs are running.
    let jobs: Vec<_> = state.jobs.snapshot().into_iter().map(|j| j.name).collect();
    for name in ["sessions.cleanup", "ratelimit.evict", "db.optimize", "sync.purge_tombstones"] {
        assert!(jobs.contains(&name), "{name} not registered: {jobs:?}");
    }
    assert!(state.jobs.trigger("ratelimit.evict"));
    assert!(!state.jobs.trigger("no.such.job"));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let evict = state.jobs.snapshot().into_iter().find(|j| j.name == "ratelimit.evict").unwrap();
    assert_eq!(evict.runs, 1, "triggered run happened: {evict:?}");
    assert!(evict.last_error.is_none());
    // health, HEAD, ticket, keep-alive pair, admin-path probe (admin-listener connections are not counted).
    assert_eq!(state.metrics.connections_total(), 5);

    // An idle keep-alive connection must not hold up shutdown.
    let mut idle = TcpStream::connect(paddr).await.unwrap();
    idle.write_all(b"GET /api/health HTTP/1.1\r\nHost: gnome.test\r\n\r\n").await.unwrap();
    let mut first = [0u8; 12];
    idle.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"HTTP/1.1 200");

    let started = std::time::Instant::now();
    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(5), server).await.expect("serve() returns promptly").unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(TcpStream::connect(paddr).await.is_err(), "listener closed");
    let mut rest = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), idle.read_to_end(&mut rest)).await;
    assert_eq!(state.metrics.connections_active(), 0);
}

/// hyper answers request heads it cannot parse by itself, without the service: `414` for a request target of 64 KiB
/// or more, `431` for a head over the read buffer (a long URL, or a "cookie bomb" a proxied page planted), `400` for a
/// malformed one. Chromium commits such an empty answer in a frame as a same-origin document, so without a policy it
/// would be a permissive realm on the proxy origin (WAVE-B §6 item 5): they go out with `AUTOMATIC_ANSWER_HEADERS`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hypers_own_error_answers_carry_a_strict_policy() {
    let app = TestApp::with_static(
        &[("GNOME_PROXY_ORIGIN", "http://p.gnome.test"), ("GNOME_PUBLIC_ORIGINS", "http://gnome.test")],
        |root| std::fs::write(root.join("index.html"), "<!doctype html><title>t</title>").unwrap(),
    )
    .await;
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = public.local_addr().unwrap();
    let state = app.state.clone();
    let server = tokio::spawn(gnome_server::server::serve(state.clone(), public, None, std::future::pending()));
    let strict = gnome_server::server::AUTOMATIC_ANSWER_HEADERS;
    assert!(strict.contains(
        "content-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\r\n"
    ));
    let cookies: Vec<String> = (0..40).map(|i| format!("bomb{i}={}", "c".repeat(3900))).collect();
    for (what, raw, status) in [
        ("long query", format!("GET /x?{} HTTP/1.1\r\nHost: p.gnome.test\r\n\r\n", "a".repeat(140_000)), 431),
        ("long path", format!("GET /{} HTTP/1.1\r\nHost: p.gnome.test\r\n\r\n", "a".repeat(66_000)), 414),
        (
            "cookie bomb",
            format!("GET /nope HTTP/1.1\r\nHost: p.gnome.test\r\nCookie: {}\r\n\r\n", cookies.join("; ")),
            431,
        ),
        ("malformed", "GET /nope HTTP/1.1\r\nHost: p.gnome.test\r\nno colon here\r\n\r\n".to_string(), 400),
        ("app host", format!("GET /x?{} HTTP/1.1\r\nHost: gnome.test\r\n\r\n", "a".repeat(140_000)), 431),
    ] {
        // WAVE-D D19: heads up to 1 MiB are accepted from trusted peers (loopback by default), so the oversized
        // cases come from 127.0.0.2, an untrusted peer with the 64 KiB buffer.
        let res = roundtrip_from(addr, &raw, "127.0.0.2").await;
        assert!(res.starts_with(&format!("HTTP/1.1 {status} ")), "{what}: {res}");
        assert!(res.ends_with(&format!("{strict}\r\n")), "{what}: {res}");
        assert!(
            res.contains("\r\ncontent-length: 0\r\n") && res.contains("\r\nconnection: close\r\n"),
            "{what}: {res}"
        );
        assert_eq!(res.matches("content-security-policy").count(), 1, "{what}: {res}");
    }
    // The trusted peer (127.0.0.1): the cookie bomb and the long query get the service's own answers; a head over
    // the 1 MiB buffer still gets the hardened 431.
    let bomb = format!(
        "GET /nope HTTP/1.1\r\nHost: p.gnome.test\r\nCookie: {}\r\nConnection: close\r\n\r\n",
        cookies.join("; ")
    );
    let res = roundtrip(addr, &bomb).await;
    assert!(res.starts_with("HTTP/1.1 404 "), "trusted cookie bomb: {res}");
    let res = roundtrip(
        addr,
        &format!("GET /x?{} HTTP/1.1\r\nHost: gnome.test\r\nConnection: close\r\n\r\n", "a".repeat(140_000)),
    )
    .await;
    assert!(!res.starts_with("HTTP/1.1 431 "), "trusted long query: {res}");
    let huge: Vec<String> = (0..400).map(|i| format!("big{i}={}", "c".repeat(3900))).collect();
    let res =
        roundtrip(addr, &format!("GET /nope HTTP/1.1\r\nHost: p.gnome.test\r\nCookie: {}\r\n\r\n", huge.join("; ")))
            .await;
    // Refused exactly at the 1 MiB cap by the limits layer (hyper alone would read up to one more buffer first).
    let lower = res.to_ascii_lowercase();
    assert!(res.starts_with("HTTP/1.1 431 ") && lower.ends_with("\r\n\r\n"), "1.5 MiB head: {res}");
    let policy = "content-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; \
                  frame-ancestors 'none'\r\n";
    assert!(lower.contains(policy) && lower.matches("content-security-policy").count() == 1, "{res}");
    // On a keep-alive connection the answer before it is the service's own, untouched.
    let res = roundtrip_from(
        addr,
        &format!(
            "GET /api/health HTTP/1.1\r\nHost: p.gnome.test\r\n\r\nGET /x?{} HTTP/1.1\r\nHost: p.gnome.test\r\n\r\n",
            "a".repeat(140_000)
        ),
        "127.0.0.2",
    )
    .await;
    let (first, second) = res.split_at(res.find("HTTP/1.1 431 ").unwrap_or_else(|| panic!("{res}")));
    assert!(first.starts_with("HTTP/1.1 200 OK\r\n"), "{first}");
    assert!(
        first.contains(
            "content-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' \
             http://gnome.test\r\n"
        ),
        "{first}"
    );
    assert!(first.ends_with("}"), "the health answer's body is intact: {first}");
    assert!(second.ends_with(&format!("{strict}\r\n")), "{second}");
    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(15), server).await.expect("serve() returns").unwrap();
}

/// A module route that upgrades the connection and talks on the raw `TcpStream`, the way the Wisp gateway splices.
struct Upgrader;

async fn upgrade(mut req: Request) -> Response {
    let on_upgrade = hyper::upgrade::on(&mut req);
    tokio::spawn(async move {
        let upgraded = on_upgrade.await.expect("connection upgraded");
        let parts = upgraded.downcast::<TokioIo<ConnIo>>().expect("the connection IO is TokioIo<ConnIo>");
        let mut tcp: TcpStream = parts.io.into_inner().into_inner();
        let mut buf = parts.read_buf.to_vec();
        let mut more = [0u8; 64];
        while !buf.ends_with(b"ping") {
            let n = tcp.read(&mut more).await.unwrap();
            assert!(n > 0, "client closed early");
            buf.extend_from_slice(&more[..n]);
        }
        tcp.write_all(b"pong from the raw socket").await.unwrap();
    });
    Response::builder()
        .status(101)
        .header("connection", "upgrade")
        .header("upgrade", "gnome-test")
        .body(Body::empty())
        .unwrap()
}

impl Module for Upgrader {
    fn name(&self) -> &'static str {
        "upgrader"
    }
    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/wisp/test-upgrade", axum::routing::get(upgrade))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upgrades_reach_the_raw_tcp_stream() {
    let app = TestApp::with_modules(
        &[],
        |_| {},
        |setup| {
            let mut m = builtin_modules(setup);
            m.push(Arc::new(Upgrader));
            m
        },
    )
    .await;
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = public.local_addr().unwrap();
    let state = app.state.clone();
    let server = tokio::spawn(gnome_server::server::serve(state.clone(), public, None, std::future::pending()));

    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(
        b"GET /wisp/test-upgrade HTTP/1.1\r\nHost: gnome.test\r\nConnection: Upgrade\r\nUpgrade: gnome-test\r\n\r\n",
    )
    .await
    .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut byte).await.unwrap();
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 101 switching protocols\r\n"), "{head}");
    assert!(head.contains("upgrade: gnome-test") && head.contains("x-request-id: "), "{head}");
    s.write_all(b"ping").await.unwrap();
    let mut reply = [0u8; 24];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut reply)).await.expect("reply in time").unwrap();
    assert_eq!(&reply, b"pong from the raw socket");

    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(15), server).await.expect("serve() returns").unwrap();
}

/// A route that takes a while, so a client can give up first.
struct Slow;

impl Module for Slow {
    fn name(&self) -> &'static str {
        "slow"
    }
    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route(
            "/api/slow",
            axum::routing::get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "late"
            }),
        )
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clients_that_hang_up_are_counted_and_leave_the_gauge() {
    let app = TestApp::with_modules(
        &[],
        |_| {},
        |setup| {
            let mut m = builtin_modules(setup);
            m.push(Arc::new(Slow));
            m
        },
    )
    .await;
    let public = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = public.local_addr().unwrap();
    let state = app.state.clone();
    let server = tokio::spawn(gnome_server::server::serve(state.clone(), public, None, std::future::pending()));
    for _ in 0..3 {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /api/slow HTTP/1.1\r\nHost: gnome.test\r\n\r\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(s);
    }
    let mut settled = false;
    for _ in 0..100 {
        if state.metrics.in_flight() == 0 && state.metrics.by_status().get(&499) == Some(&3) {
            settled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(settled, "in_flight={} by_status={:?}", state.metrics.in_flight(), state.metrics.by_status());
    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(15), server).await.expect("serve() returns").unwrap();
}
