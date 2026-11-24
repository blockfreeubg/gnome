//! WAVE-D D18 over real sockets and in-process: the global connection cap and its hardened `503` overflow answer,
//! the admin listener's own cap, the per-peer cap at accept for untrusted peers, the per-client in-flight cap behind a
//! trusted proxy with the IPv6 prefix tiers, the Wisp share (`429 server_full` at 90 %), upgraded Wisp connections
//! keeping their permit, the effective cap lowered by a small `RLIMIT_NOFILE` in the real binary, metrics and
//! diagnostics.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use common::*;
use gnome_server::AppState;
use gnome_server::gateway::upstream::accept_key;
use gnome_server::module::{Module, builtin_modules};
use gnome_server::server::{Listeners, serve_all};
use http::{Request, StatusCode, header};
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::Semaphore;

/// A route that waits until the test releases it, so requests stay in flight.
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

async fn app_with_blocker(vars: &[(&str, &str)]) -> (TestApp, Arc<Semaphore>) {
    let gate = Arc::new(Semaphore::new(0));
    let g = gate.clone();
    let app = TestApp::with_modules(
        vars,
        |_| {},
        move |s| {
            let mut list = builtin_modules(s);
            list.push(Arc::new(Blocker(g)));
            list
        },
    )
    .await;
    (app, gate)
}

/// An upstream that accepts every WebSocket upgrade and then holds the connection open.
async fn holding_upstream() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let head = read_head(&mut s).await.unwrap_or_default();
                let key = head
                    .split("\r\n")
                    .find_map(|l| {
                        l.strip_prefix("sec-websocket-key: ").or_else(|| l.strip_prefix("Sec-WebSocket-Key: "))
                    })
                    .unwrap_or_default()
                    .to_string();
                let answer = format!(
                    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                     Sec-WebSocket-Accept: {}\r\n\r\n",
                    accept_key(&key)
                );
                if s.write_all(answer.as_bytes()).await.is_ok() {
                    let mut sink = [0u8; 1024];
                    while matches!(s.read(&mut sink).await, Ok(n) if n > 0) {}
                }
            });
        }
    });
    addr
}

async fn read_head(s: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 64 * 1024 || s.read(&mut byte).await.ok()? == 0 {
            return if head.is_empty() { None } else { Some(String::from_utf8_lossy(&head).into_owned()) };
        }
        head.push(byte[0]);
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

async fn connect_from(addr: SocketAddr, src: &str) -> TcpStream {
    let sock = TcpSocket::new_v4().unwrap();
    sock.bind(format!("{src}:0").parse().unwrap()).unwrap();
    sock.connect(addr).await.unwrap()
}

struct Stack {
    app: TestApp,
    public: SocketAddr,
    proxy: SocketAddr,
    admin: SocketAddr,
}

async fn stack(vars: &[(&str, &str)]) -> Stack {
    let upstream = holding_upstream().await.to_string();
    let (pl, xl, al) = (
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
        TcpListener::bind("127.0.0.1:0").await.unwrap(),
    );
    let (public, proxy, admin) = (pl.local_addr().unwrap(), xl.local_addr().unwrap(), al.local_addr().unwrap());
    let proxy_s = proxy.to_string();
    let mut all: Vec<(&str, &str)> = vec![
        ("GNOME_PROXY_BIND", &proxy_s),
        ("GNOME_PUBLIC_ORIGINS", ORIGIN),
        ("GNOME_WISP_UPSTREAM", &upstream),
        ("GNOME_RATE_LIMIT_SCALE", "0"),
    ];
    all.extend_from_slice(vars);
    let app = TestApp::new(&all).await;
    let listeners = Listeners { public: pl, proxy: Some(xl), admin: Some(al) };
    tokio::spawn(serve_all(app.state.clone(), listeners, std::future::pending()));
    Stack { app, public, proxy, admin }
}

impl Stack {
    async fn ticket(&self, client: &mut Client<'_>) -> String {
        let res = client.post("/api/wisp/ticket", serde_json::json!({})).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text());
        res.json()["ticket"].as_str().unwrap().to_string()
    }

    /// A Wisp upgrade on the proxy listener: the answer's head and the open stream.
    async fn wisp(&self, ticket: &str) -> (String, TcpStream) {
        let mut s = TcpStream::connect(self.proxy).await.unwrap();
        let key = STANDARD.encode([7u8; 16]);
        let req = format!(
            "GET /wisp/?t={ticket} HTTP/1.1\r\nHost: {p}\r\nOrigin: http://{p}\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n",
            p = self.proxy
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let head = tokio::time::timeout(Duration::from_secs(10), read_head(&mut s)).await.unwrap().unwrap_or_default();
        (head, s)
    }

    async fn diagnostics(&self) -> Value {
        self.app.send_admin(admin_get("/admin/diagnostics")).await.json()
    }
}

fn admin_get(path: &str) -> Request<Body> {
    Request::builder().uri(path).header(header::HOST, "127.0.0.1:9091").body(Body::empty()).unwrap()
}

async fn get_on(addr: SocketAddr, src: &str, host: &str) -> String {
    let mut s = connect_from(addr, src).await;
    let req = format!("GET /api/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    let _ = s.write_all(req.as_bytes()).await;
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).into_owned()
}

/// Wait until `f` holds (the server updates its counters on other tasks).
async fn eventually(what: &str, mut f: impl AsyncFnMut() -> bool) {
    for _ in 0..300 {
        if f().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for: {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_cap_answers_503_keeps_wisp_permits_and_spares_the_admin_listener() {
    let s = stack(&[("GNOME_MAX_CONNECTIONS", "16")]).await;
    let d = s.diagnostics().await;
    assert_eq!(d["connections"]["max"], 16);
    assert_eq!(d["connections"]["effective"], 16);
    assert_eq!(d["connections"]["wisp_share"], 14, "90 % of 16");

    // 14 Wisp connections: each keeps its permit after the upgrade, although hyper's connection task ended.
    let mut client = s.app.client();
    let mut wisp = Vec::new();
    for i in 0..14 {
        let ticket = s.ticket(&mut client).await;
        let (head, stream) = s.wisp(&ticket).await;
        assert!(head.starts_with("HTTP/1.1 101 "), "wisp {i}: {head}");
        wisp.push(stream);
    }
    eventually("14 permits held", async || s.diagnostics().await["connections"]["active"] == 14).await;

    // The Wisp share is used up: 429 server_full, the tier named.
    let ticket = s.ticket(&mut client).await;
    let (head, mut refused) = s.wisp(&ticket).await;
    assert!(head.starts_with("HTTP/1.1 429 "), "{head}");
    let mut body = vec![0u8; 512];
    let n = refused.read(&mut body).await.unwrap();
    let v: Value = serde_json::from_slice(&body[..n]).unwrap();
    assert_eq!(v["error"]["code"], "too_many_connections");
    assert_eq!(v["tier"], "server");
    drop(refused);

    // Fill the cap with idle plain connections, then the next connection gets the hardened 503 before it sends.
    let mut idle = Vec::new();
    eventually("refused upgrade released", async || s.diagnostics().await["connections"]["active"] == 14).await;
    for _ in 0..2 {
        idle.push(TcpStream::connect(s.public).await.unwrap());
    }
    eventually("cap full", async || s.diagnostics().await["connections"]["active"] == 16).await;
    let mut over = TcpStream::connect(s.public).await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(Duration::from_secs(5), over.read_to_string(&mut answer)).await.unwrap().unwrap();
    assert!(answer.starts_with("HTTP/1.1 503 Service Unavailable\r\n"), "{answer}");
    assert!(answer.contains("\r\nretry-after: 1\r\n") && answer.contains("\r\nconnection: close\r\n"), "{answer}");
    assert!(answer.contains(gnome_server::server::AUTOMATIC_ANSWER_HEADERS), "hardened: {answer}");
    // The proxy listener shares the cap.
    let mut over = TcpStream::connect(s.proxy).await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(Duration::from_secs(5), over.read_to_string(&mut answer)).await.unwrap().unwrap();
    assert!(answer.starts_with("HTTP/1.1 503 "), "{answer}");

    // The admin listener has its own cap.
    let res = get_on(s.admin, "127.0.0.1", "127.0.0.1").await;
    assert!(!res.starts_with("HTTP/1.1 503 "), "admin: {res}");

    // Many overflow answers at once all arrive (at most 256 run together, the rest wait in the backlog).
    let mut many = Vec::new();
    for _ in 0..300 {
        many.push(tokio::spawn({
            let addr = s.public;
            async move {
                let mut c = TcpStream::connect(addr).await.unwrap();
                let mut a = String::new();
                let _ = tokio::time::timeout(Duration::from_secs(60), c.read_to_string(&mut a)).await;
                a.starts_with("HTTP/1.1 503 ")
            }
        }));
    }
    for t in many {
        assert!(t.await.unwrap(), "every overflow connection got the 503");
    }

    // A freed permit serves the next connection.
    drop(idle.pop());
    eventually("a permit freed", async || s.diagnostics().await["connections"]["active"] == 15).await;
    let res = get_on(s.public, "127.0.0.1", "gnome.test").await;
    assert!(res.starts_with("HTTP/1.1 200 "), "{res}");

    let d = s.diagnostics().await;
    assert!(d["connections"]["overflow_answered"].as_u64().unwrap() >= 302, "{}", d["connections"]);
    assert!(d["connections"]["cap_full_seconds"].as_f64().unwrap() > 0.0);
    let metrics = s.app.send_admin(admin_get("/admin/metrics")).await.text();
    assert!(metrics.contains("gnome_http_connections_refused_total{reason=\"cap\"}"), "{metrics}");
    assert!(metrics.contains("gnome_ws_rejected_total{reason=\"server_full\"} 1"), "{metrics}");
    assert!(metrics.contains("gnome_http_cap_full_seconds_total"), "{metrics}");
    drop(wisp);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn untrusted_peers_are_capped_at_accept() {
    let s = stack(&[("GNOME_MAX_CONNS_PER_IP", "2")]).await;
    // 127.0.0.2 is outside the default GNOME_TRUSTED_PROXIES (127.0.0.1/32, ::1/128).
    let a = connect_from(s.public, "127.0.0.2").await;
    let b = connect_from(s.public, "127.0.0.2").await;
    eventually("two held", async || s.diagnostics().await["connections"]["active"] == 2).await;
    let mut c = connect_from(s.public, "127.0.0.2").await;
    let mut buf = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), c.read_to_end(&mut buf)).await.unwrap();
    assert!(read.is_err() || buf.is_empty(), "closed at once without an answer: {buf:?}");
    // The trusted peer is not capped per address.
    let mut trusted = Vec::new();
    for _ in 0..4 {
        trusted.push(TcpStream::connect(s.public).await.unwrap());
    }
    let res = get_on(s.public, "127.0.0.1", "gnome.test").await;
    assert!(res.starts_with("HTTP/1.1 200 "), "{res}");
    // A slot frees when a connection closes.
    drop(a);
    eventually("slot freed", async || s.diagnostics().await["connections"]["active"] == 5).await;
    let res = get_on(s.public, "127.0.0.2", "gnome.test").await;
    assert!(res.starts_with("HTTP/1.1 200 "), "{res}");
    let d = s.diagnostics().await;
    assert_eq!(d["connections"]["refused"]["per_ip"], 1);
    assert_eq!(d["connections"]["per_ip_max"], 2);
    let metrics = s.app.send_admin(admin_get("/admin/metrics")).await.text();
    assert!(metrics.contains("gnome_http_connections_refused_total{reason=\"per_ip\"} 1"), "{metrics}");
    drop((b, trusted));
}

fn blocked(xff: &str) -> Request<Body> {
    req(http::Method::GET, "/block").header("x-forwarded-for", xff).body(Body::empty()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inflight_cap_per_client_behind_a_trusted_proxy_with_prefix_tiers() {
    let (app, gate) = app_with_blocker(&[("GNOME_MAX_INFLIGHT_PER_IP", "2")]).await;
    let front: SocketAddr = "127.0.0.1:40000".parse().unwrap();
    let router = app.public.clone();
    let spawn = |xff: &str| {
        let r = blocked(xff);
        let router = router.clone();
        tokio::spawn(async move { send_to(&router, r, front).await })
    };
    let held = [spawn("198.51.100.7"), spawn("198.51.100.7")];
    tokio::time::sleep(Duration::from_millis(100)).await;
    let res = send_to(&app.public, blocked("198.51.100.7"), front).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{}", res.text());
    assert_eq!(res.error_code(), "unavailable");
    assert_eq!(res.header("retry-after"), Some("1"));
    assert_eq!(res.json()["tier"], "ip");
    assert!(res.header("content-security-policy").is_some(), "security headers apply");
    // Another client behind the same front is unaffected.
    let other = send_to(&app.public, get("/api/health").header_xff("198.51.100.8"), front).await;
    assert_eq!(other.status, StatusCode::OK);
    gate.add_permits(2);
    for h in held {
        assert_eq!(h.await.unwrap().status, StatusCode::OK);
    }
    let res = send_to(&app.public, get("/api/health").header_xff("198.51.100.7"), front).await;
    assert_eq!(res.status, StatusCode::OK, "slots released when the response head is ready");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ipv6_prefix_tiers_bound_one_network_and_spare_others() {
    let (app, gate) = app_with_blocker(&[("GNOME_MAX_INFLIGHT_PER_IP", "1")]).await;
    let front: SocketAddr = "127.0.0.1:40000".parse().unwrap();
    // 128 /64s of one /56 (2001:db8:7:00xx::): 4 = 4 x 1 get in, then the /56 tier refuses.
    let mut tasks = Vec::new();
    let mut refused = Vec::new();
    for n in 0..128u32 {
        let xff = format!("2001:db8:7:{n:x}::1");
        let router = app.public.clone();
        let r = blocked(&xff);
        let t = tokio::spawn(async move { send_to(&router, r, front).await });
        tokio::time::sleep(Duration::from_millis(2)).await;
        if t.is_finished() {
            refused.push(t.await.unwrap());
        } else {
            tasks.push(t);
        }
    }
    assert_eq!(tasks.len(), 4, "4 per /56");
    assert!(refused.iter().all(|r| r.status == StatusCode::SERVICE_UNAVAILABLE && r.json()["tier"] == "prefix56"));
    // /64s in other /56s of the same /48: 16 x 1 in total for the /48.
    for k in 1..20u32 {
        let xff = format!("2001:db8:7:{:x}::1", k << 8);
        let router = app.public.clone();
        let r = blocked(&xff);
        let t = tokio::spawn(async move { send_to(&router, r, front).await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        if t.is_finished() {
            let res = t.await.unwrap();
            assert_eq!(res.json()["tier"], "prefix48", "{}", res.text());
        } else {
            tasks.push(t);
        }
    }
    assert_eq!(tasks.len(), 16, "16 per /48");
    // Plain HTTP from another /48 stays usable.
    let res = send_to(&app.public, get("/api/health").header_xff("2001:db8:8::1"), front).await;
    assert_eq!(res.status, StatusCode::OK);
    gate.add_permits(tasks.len());
    for t in tasks {
        assert_eq!(t.await.unwrap().status, StatusCode::OK);
    }
    let metrics = app.send_admin(admin_get("/admin/metrics")).await.text();
    assert!(metrics.contains("gnome_http_inflight_refused_total{tier=\"prefix56\"} 124"), "{metrics}");
    assert!(metrics.contains("gnome_http_inflight_refused_total{tier=\"prefix48\"} 7"), "{metrics}");
}

trait WithXff {
    fn header_xff(self, xff: &str) -> Request<Body>;
}

impl WithXff for Request<Body> {
    fn header_xff(mut self, xff: &str) -> Request<Body> {
        self.headers_mut().insert("x-forwarded-for", xff.parse().unwrap());
        self
    }
}

/// The real binary: under `ulimit -n 1024` the effective cap is (1024 − 512) ÷ 6 = 85, logged at startup.
/// `GNOME_TEST_EXEC_WRAPPER` (e.g. `qemu-aarch64`) runs the binary through a user-mode emulator.
#[cfg(target_os = "linux")]
#[test]
fn a_small_descriptor_limit_lowers_the_effective_cap() {
    use std::io::{BufRead as _, BufReader};
    use std::process::{Command, Stdio};
    let dir = tempfile::tempdir().unwrap();
    let wrapper = std::env::var("GNOME_TEST_EXEC_WRAPPER").unwrap_or_default();
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(format!("ulimit -n 1024 && exec {wrapper} \"$0\"")).arg(env!("CARGO_BIN_EXE_gnome-server"));
    cmd.env_clear()
        .env("GNOME_DATA_DIR", dir.path().join("data"))
        .env("GNOME_STATIC_DIR", dir.path().join("static"))
        .env("GNOME_BIND", "127.0.0.1:0")
        .env("GNOME_ADMIN_BIND", "")
        .env("GNOME_ARGON2_MEMORY_KIB", "1024")
        .env("GNOME_LOG_FORMAT", "json")
        .env("GNOME_CATALOG_REFRESH_HOURS", "0")
        .env("GNOME_FILTERS_REFRESH_HOURS", "0")
        .env("GNOME_OSS_FETCH", "manual")
        .env("GNOME_WISP_UPSTREAM", "127.0.0.1:9")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("server starts");
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let mut found = None;
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) if line.contains("GNOME_MAX_CONNECTIONS lowered") => {
                found = Some(line);
                break;
            }
            Ok(line) if line.contains("public listener ready") => break,
            _ => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let line = found.expect("the lowered cap is logged");
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["fields"]["effective"], 85, "{line}");
    assert_eq!(v["fields"]["configured"], 4096, "{line}");
}
