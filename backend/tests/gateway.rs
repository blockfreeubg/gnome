//! The Wisp gateway over real sockets: an in-process WebSocket echo upstream stands in for HolyWisp. Covers the
//! handshake and echo through both relay paths (splice and copy), bytes buffered on either side at upgrade time,
//! the reconstructed upstream request (header spoofing, no credentials), refusals before the upgrade, connection
//! caps and their release, upstream failures, health probes and VPN profile routing.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use common::*;
use futures_util::{SinkExt as _, StreamExt as _};
use gnome_server::gateway::ticket::{SessionRef, TicketKey, TicketRoute};
use gnome_server::gateway::upstream::accept_key;
use gnome_server::gateway::{Gateway, GatewayOptions};
use gnome_server::module::builtin_modules_with;
use gnome_server::security::secret_key::SecretKey;
use gnome_server::server::{Listeners, serve_all};
use http::{Request, StatusCode, header};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;

/// What the upstream sends right after its `101` (in the same write): a Wisp v1 `CONTINUE` on stream 0, like
/// HolyWisp, so the health probe accepts this upstream too.
const GREETING: [u8; 9] = [0x03, 0, 0, 0, 0, 0x80, 0, 0, 0];

// ------------------------------------------------------------------------------------------------ upstream

/// An echo upstream that records every request head it receives.
struct Upstream {
    addr: SocketAddr,
    heads: Arc<Mutex<Vec<String>>>,
}

impl Upstream {
    async fn start() -> Self {
        Self::start_with(false).await
    }

    /// `refuse`: answer `403` instead of upgrading.
    async fn start_with(refuse: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let heads = Arc::new(Mutex::new(Vec::new()));
        let seen = heads.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve_upstream(stream, seen.clone(), refuse));
            }
        });
        Self { addr, heads }
    }

    /// Heads of relayed connections (the gateway's health probes send no `X-Forwarded-For`).
    fn heads(&self) -> Vec<String> {
        self.heads.lock().unwrap().iter().filter(|h| !header_values(h, "x-forwarded-for").is_empty()).cloned().collect()
    }
}

async fn serve_upstream(mut stream: TcpStream, heads: Arc<Mutex<Vec<String>>>, refuse: bool) {
    let Some(head) = read_head(&mut stream).await else { return };
    let key = header_value(&head, "sec-websocket-key").unwrap_or_default();
    heads.lock().unwrap().push(head);
    if refuse {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        return;
    }
    let mut out = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \
         {}\r\nX-Upstream: echo\r\n\r\n",
        accept_key(&key)
    )
    .into_bytes();
    out.extend_from_slice(&[0x82, GREETING.len() as u8]);
    out.extend_from_slice(&GREETING);
    if stream.write_all(&out).await.is_err() {
        return;
    }
    let mut ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    while let Some(Ok(msg)) = ws.next().await {
        match msg {
            Message::Binary(_) | Message::Text(_) => {
                if ws.send(msg).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

/// Read an HTTP head byte by byte (so nothing after it is consumed).
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 16 * 1024 || stream.read(&mut byte).await.ok()? == 0 {
            return None;
        }
        head.push(byte[0]);
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

/// Values of header `name` (case-insensitive) in a raw head.
fn header_values(head: &str, name: &str) -> Vec<String> {
    head.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(n, _)| n.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
        .collect()
}

fn header_value(head: &str, name: &str) -> Option<String> {
    header_values(head, name).into_iter().next()
}

// -------------------------------------------------------------------------------------------------- server

/// gnome-server on real sockets: the public listener and a loopback proxy listener (two-origin mode).
struct Running {
    app: TestApp,
    /// The public listener (app role, or the proxy role for the proxy origin's host).
    public: SocketAddr,
    proxy: SocketAddr,
    server: JoinHandle<()>,
}

impl Running {
    async fn start(vars: &[(&str, &str)], upstream: SocketAddr, zero_copy: bool) -> Self {
        Self::start_with(vars, upstream, GatewayOptions { zero_copy, ..GatewayOptions::default() }).await
    }

    async fn start_with(vars: &[(&str, &str)], upstream: SocketAddr, options: GatewayOptions) -> Self {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let public_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = proxy_listener.local_addr().unwrap();
        let public = public_listener.local_addr().unwrap();
        let (proxy_s, upstream_s) = (proxy.to_string(), upstream.to_string());
        let mut all: Vec<(&str, &str)> = vec![
            ("GNOME_PROXY_BIND", &proxy_s),
            ("GNOME_PUBLIC_ORIGINS", ORIGIN),
            ("GNOME_WISP_UPSTREAM", &upstream_s),
        ];
        all.extend_from_slice(vars);
        let app = TestApp::with_modules(&all, |_| {}, move |s| builtin_modules_with(s, options)).await;
        let listeners = Listeners { public: public_listener, proxy: Some(proxy_listener), admin: None };
        let server = tokio::spawn(serve_all(app.state.clone(), listeners, std::future::pending()));
        Self { app, public, proxy, server }
    }

    fn origin(&self) -> String {
        format!("http://{}", self.proxy)
    }

    fn gateway(&self) -> Arc<Gateway> {
        self.app.state.ext::<Gateway>().expect("gateway installed")
    }

    /// A ticket for `client`'s session (`POST /api/wisp/ticket` on the app origin).
    async fn ticket(&self, client: &mut Client<'_>) -> String {
        self.ticket_for(client, json!({})).await
    }

    /// A ticket for `client`'s session and the route in `body` (D23).
    async fn ticket_for(&self, client: &mut Client<'_>, body: Value) -> String {
        let res = client.post("/api/wisp/ticket", body).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text());
        let v = res.json();
        assert_eq!(v["wisp_url"], format!("ws://{}/wisp/", self.proxy));
        v["ticket"].as_str().unwrap().to_string()
    }

    /// Open a Wisp WebSocket with the right Origin.
    async fn open(&self, ticket: &str) -> Result<Ws, (u16, Value)> {
        let origin = self.origin();
        connect(self.proxy, &format!("/wisp/?t={ticket}"), &[("Origin", &origin)], None).await.map(|(ws, _)| ws)
    }

    async fn wait_idle(&self) {
        let gw = self.gateway();
        for _ in 0..200 {
            if gw.stats.active() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("connections still active: {}", gw.stats.active());
    }

    async fn diagnostics(&self) -> Value {
        let req = Request::builder()
            .uri("/admin/diagnostics")
            .header(header::HOST, "127.0.0.1:9091")
            .body(axum::body::Body::empty())
            .unwrap();
        self.app.send_admin(req).await.json()
    }

    async fn stop(self) {
        self.app.state.shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(15), self.server).await.expect("server stops").unwrap();
    }
}

// -------------------------------------------------------------------------------------------------- client

type Ws = WebSocketStream<TcpStream>;

/// A masked client frame (binary, FIN).
fn client_frame(payload: &[u8]) -> Vec<u8> {
    let mask = [0x37, 0xfa, 0x21, 0x3d];
    let mut f = vec![0x82];
    match payload.len() {
        n if n < 126 => f.push(0x80 | n as u8),
        n if n <= 0xffff => {
            f.push(0x80 | 126);
            f.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            f.push(0x80 | 127);
            f.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    f.extend_from_slice(&mask);
    f.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    f
}

/// Raw WebSocket upgrade to `addr`. `early`: a frame sent in the same write as the request head. On `101` returns
/// the socket as a client WebSocket and the response head; otherwise the status and JSON body.
async fn connect(
    addr: SocketAddr,
    path: &str,
    headers: &[(&str, &str)],
    early: Option<&[u8]>,
) -> Result<(Ws, String), (u16, Value)> {
    connect_as(addr, &addr.to_string(), path, headers, early).await
}

/// [`connect`] with `Host: host` instead of the socket address.
async fn connect_as(
    addr: SocketAddr,
    host: &str,
    path: &str,
    headers: &[(&str, &str)],
    early: Option<&[u8]>,
) -> Result<(Ws, String), (u16, Value)> {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let key = STANDARD.encode(rand_bytes());
    let mut req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: \
         13\r\nSec-WebSocket-Key: {key}\r\n"
    );
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    let mut bytes = req.into_bytes();
    if let Some(payload) = early {
        bytes.extend(client_frame(payload));
    }
    stream.write_all(&bytes).await.unwrap();
    let head = tokio::time::timeout(Duration::from_secs(10), read_head(&mut stream))
        .await
        .expect("response head in time")
        .expect("a response head");
    let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
    if status != 101 {
        let len: usize = header_value(&head, "content-length").map_or(0, |v| v.parse().unwrap());
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await.unwrap();
        let v = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return Err((status, v));
    }
    assert_eq!(header_value(&head, "sec-websocket-accept"), Some(accept_key(&key)), "{head}");
    Ok((WebSocketStream::from_raw_socket(stream, Role::Client, None).await, head))
}

fn rand_bytes() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).unwrap();
    b
}

async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("a message in time")
            .expect("stream open")
            .expect("no error");
        match msg {
            Message::Binary(b) => return b.to_vec(),
            Message::Text(t) => return t.as_bytes().to_vec(),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected message {other:?}"),
        }
    }
}

fn code(err: &(u16, Value)) -> (u16, &str) {
    (err.0, err.1["error"]["code"].as_str().unwrap_or("?"))
}

// ----------------------------------------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn echo_through_splice_and_copy_with_a_clean_upstream_request() {
    for zero_copy in [true, false] {
        let upstream = Upstream::start().await;
        // No trusted reverse proxy: the client talks to the gateway directly (the default trusts loopback peers).
        let run = Running::start(&[("GNOME_TRUSTED_PROXIES", "")], upstream.addr, zero_copy).await;
        let gw = run.gateway();
        assert_eq!(gw.zero_copy(), zero_copy && cfg!(target_os = "linux"), "splice available on this host");
        let mut client = run.app.client();
        let ticket = run.ticket(&mut client).await;
        let origin = run.origin();
        // Spoofing attempts and credentials that must never reach HolyWisp.
        let spoof = [
            ("Origin", origin.as_str()),
            ("X-Forwarded-For", "198.51.100.66"),
            ("X-Forwarded-For", "198.51.100.67, 10.0.0.1"),
            ("X-Real-IP", "198.51.100.68"),
            ("Forwarded", "for=198.51.100.69"),
            ("CF-Connecting-IP", "198.51.100.70"),
            ("True-Client-IP", "198.51.100.71"),
            ("Cookie", "gnome_sid=secret-cookie"),
            ("Authorization", "Bearer secret-token"),
            ("Sec-WebSocket-Protocol", "wisp-v2"),
        ];
        let (mut ws, head) = connect(run.proxy, &format!("/wisp/?t={ticket}"), &spoof, Some(b"early bytes"))
            .await
            .unwrap_or_else(|e| panic!("upgrade refused: {e:?}"));
        assert_eq!(header_value(&head, "x-upstream").as_deref(), Some("echo"), "upstream head relayed: {head}");
        assert!(header_value(&head, "x-frame-options").is_none(), "{head}");

        // HolyWisp's first frame (buffered with its 101), then the echo of the client's early frame.
        assert_eq!(next_binary(&mut ws).await, GREETING);
        assert_eq!(next_binary(&mut ws).await, b"early bytes");
        // Messages of many sizes, including multi-megabyte ones, come back intact and in order.
        let mut sent = 0usize;
        for size in [0usize, 1, 125, 126, 65_535, 65_536, 300_000, 2_500_000] {
            let payload: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();
            ws.send(Message::binary(payload.clone())).await.unwrap();
            assert_eq!(next_binary(&mut ws).await, payload, "{size} bytes (zero_copy={zero_copy})");
            sent += size;
        }
        ws.send(Message::text("hello")).await.unwrap();
        assert_eq!(next_binary(&mut ws).await, b"hello");
        assert_eq!(gw.stats.active(), 1);
        ws.close(None).await.unwrap();
        drop(ws);
        run.wait_idle().await;

        // The request HolyWisp saw.
        let heads = upstream.heads();
        assert_eq!(heads.len(), 1);
        let h = &heads[0];
        assert!(h.starts_with("GET /wisp/ HTTP/1.1\r\n"), "path without the ticket: {h}");
        assert!(!h.contains(&ticket), "{h}");
        assert_eq!(header_values(h, "x-forwarded-for"), ["127.0.0.1"], "exactly one bare client IP: {h}");
        for name in
            ["x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip", "cookie", "authorization", "origin"]
        {
            assert!(header_values(h, name).is_empty(), "{name} forwarded: {h}");
        }
        assert_eq!(header_values(h, "host"), [upstream.addr.to_string()]);
        assert_eq!(header_values(h, "sec-websocket-protocol"), ["wisp-v2"]);
        assert_eq!(header_values(h, "sec-websocket-version"), ["13"]);

        // Counters.
        let d = run.diagnostics().await;
        let ws_d = &d["ws"];
        assert_eq!((ws_d["active"].as_i64(), ws_d["total"].as_u64()), (Some(0), Some(1)), "{ws_d}");
        let path = if gw.zero_copy() { "zero_copy" } else { "copy" };
        assert_eq!(ws_d["relays"][path], 1, "{ws_d}");
        assert!(ws_d["bytes_up"].as_u64().unwrap() >= sent as u64, "{ws_d}");
        assert!(ws_d["bytes_down"].as_u64().unwrap() >= (sent + GREETING.len()) as u64, "{ws_d}");
        assert_eq!((ws_d["clients"].as_u64(), ws_d["sessions"].as_u64()), (Some(0), Some(0)), "slots released");
        let metrics = run.app.send_admin(admin_metrics()).await.text();
        assert!(metrics.contains("gnome_ws_connections_total 1\n"), "{metrics}");
        assert!(metrics.contains(&format!("gnome_ws_relays_total{{path=\"{path}\"}} 1\n")), "{metrics}");
        run.stop().await;
    }
}

fn admin_metrics() -> Request<axum::body::Body> {
    Request::builder()
        .uri("/admin/metrics")
        .header(header::HOST, "127.0.0.1:9091")
        .body(axum::body::Body::empty())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trusted_reverse_proxy_supplies_the_client_ip() {
    let upstream = Upstream::start().await;
    let run = Running::start(&[("GNOME_TRUSTED_PROXIES", "127.0.0.1/32")], upstream.addr, true).await;
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let origin = run.origin();
    let headers = [("Origin", origin.as_str()), ("X-Forwarded-For", "198.51.100.7, 203.0.113.99")];
    let (mut ws, _) = connect(run.proxy, &format!("/wisp/?t={ticket}"), &headers, None).await.unwrap();
    assert_eq!(next_binary(&mut ws).await, GREETING);
    ws.close(None).await.unwrap();
    drop(ws);
    run.wait_idle().await;
    // The right-most untrusted address of the chain, as one bare IP.
    assert_eq!(header_values(&upstream.heads()[0], "x-forwarded-for"), ["203.0.113.99"]);
    run.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusals_are_json_and_happen_before_the_upgrade() {
    let upstream = Upstream::start().await;
    let run = Running::start(&[], upstream.addr, true).await;
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let origin = run.origin();
    let attempt = |path: String, headers: Vec<(&'static str, String)>| {
        let addr = run.proxy;
        async move {
            let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
            connect(addr, &path, &h, None).await.map(|_| ()).unwrap_err()
        }
    };
    let ok_origin = vec![("Origin", origin.clone())];
    // Origin: missing, the app origin, another site, a duplicate.
    assert_eq!(code(&attempt(format!("/wisp/?t={ticket}"), vec![]).await), (403, "forbidden"));
    assert_eq!(code(&attempt(format!("/wisp/?t={ticket}"), vec![("Origin", ORIGIN.into())]).await), (403, "forbidden"));
    let evil = vec![("Origin", "http://evil.example".to_string())];
    assert_eq!(code(&attempt(format!("/wisp/?t={ticket}"), evil).await), (403, "forbidden"));
    let twice = vec![("Origin", origin.clone()), ("Origin", origin.clone())];
    assert_eq!(code(&attempt(format!("/wisp/?t={ticket}"), twice).await), (403, "forbidden"));
    // Tickets: missing, empty, tampered, expired, from another server, ambiguous.
    for (path, want) in [
        ("/wisp/".to_string(), "wisp_ticket_missing"),
        ("/wisp/?t=".into(), "wisp_ticket_missing"),
        (format!("/wisp/?t={ticket}x"), "wisp_ticket_invalid"),
        (format!("/wisp/?t={ticket}&t={ticket}"), "wisp_ticket_invalid"),
    ] {
        assert_eq!(code(&attempt(path.clone(), ok_origin.clone()).await), (401, want), "{path}");
    }
    let mut tampered = ticket.clone().into_bytes();
    let i = tampered.len() - 3;
    tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap();
    assert_eq!(code(&attempt(format!("/wisp/?t={tampered}"), ok_origin.clone()).await), (401, "wisp_ticket_invalid"));
    let gw = run.gateway();
    let sref = SessionRef([5; 16]);
    let expired = gw.mint(sref, gnome_server::util::now_s() - 1);
    let err = attempt(format!("/wisp/?t={expired}"), ok_origin.clone()).await;
    assert_eq!(code(&err), (401, "wisp_ticket_expired"));
    assert!(err.1["error"]["message"].as_str().unwrap().contains("expired"), "{:?}", err.1);
    let foreign =
        TicketKey::new(&SecretKey::from_bytes(vec![9; 32]).unwrap(), gnome_server::config::AccessMode::Open, None)
            .mint(sref, &TicketRoute::Default, gnome_server::util::now_s(), gnome_server::util::now_s() + 600);
    assert_eq!(code(&attempt(format!("/wisp/?t={foreign}"), ok_origin.clone()).await), (401, "wisp_ticket_invalid"));
    // Unknown profile; `direct` is not a profile path.
    assert_eq!(code(&attempt(format!("/wisp/p/nope/?t={ticket}"), ok_origin.clone()).await), (404, "not_found"));
    assert_eq!(code(&attempt(format!("/wisp/p/direct/?t={ticket}"), ok_origin.clone()).await), (404, "not_found"));
    // Not a WebSocket upgrade (a plain GET is a ticket probe: valid ticket → 426) / HTTP/1.0.
    let mut s = TcpStream::connect(run.proxy).await.unwrap();
    s.write_all(
        format!("GET /wisp/?t={ticket} HTTP/1.1\r\nHost: x\r\nOrigin: {origin}\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    )
    .await
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 426 "), "{out}");
    assert!(out.contains("\"upgrade_required\""), "{out}");
    let mut s = TcpStream::connect(run.proxy).await.unwrap();
    s.write_all(
        format!(
            "GET /wisp/?t={ticket} HTTP/1.0\r\nHost: x\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: \
             Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.0 426 ") || out.starts_with("HTTP/1.1 426 "), "{out}");
    // A header value with obs-text is refused, not forwarded.
    let mut s = TcpStream::connect(run.proxy).await.unwrap();
    let mut raw = format!(
        "GET /wisp/?t={ticket} HTTP/1.1\r\nHost: x\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: \
         Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: "
    )
    .into_bytes();
    raw.extend_from_slice(b"wisp\xff\r\nConnection: close\r\n\r\n");
    s.write_all(&raw).await.unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).await.unwrap();
    assert!(out.starts_with(b"HTTP/1.1 400 "), "{}", String::from_utf8_lossy(&out));
    // A HEAD with every upgrade header is no upgrade either (the GET route answers HEAD too).
    let mut s = TcpStream::connect(run.proxy).await.unwrap();
    s.write_all(
        format!(
            "HEAD /wisp/?t={ticket} HTTP/1.1\r\nHost: x\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: \
             Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let head = read_head(&mut s).await.expect("a response head");
    assert!(head.starts_with("HTTP/1.1 426 "), "{head}");

    // Nothing reached the upstream, and the ticket still works.
    assert!(upstream.heads().is_empty(), "{:?}", upstream.heads());
    let mut ws = run.open(&ticket).await.unwrap();
    assert_eq!(next_binary(&mut ws).await, GREETING);
    ws.close(None).await.unwrap();
    drop(ws);
    run.wait_idle().await;
    let d = run.diagnostics().await;
    for (reason, n) in [("origin", 4), ("ticket", 7), ("unknown_profile", 2), ("not_an_upgrade", 3)] {
        assert_eq!(d["ws"]["rejected"][reason], n, "{reason}: {}", d["ws"]["rejected"]);
    }
    assert_eq!(d["ws"]["probes"], json!({"valid": 1, "rejected": 0, "upstream_down": 0}));
    run.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_caps_are_enforced_and_released() {
    let upstream = Upstream::start().await;
    let vars = [("GNOME_MAX_WS_PER_SESSION", "2"), ("GNOME_MAX_WS_PER_IP", "3")];
    let run = Running::start(&vars, upstream.addr, true).await;
    let mut alice = run.app.client();
    let mut bob = run.app.client();
    let (ta, tb) = (run.ticket(&mut alice).await, run.ticket(&mut bob).await);
    assert_ne!(ta.split('.').nth(4), tb.split('.').nth(4), "two sessions, two refs");
    let a1 = run.open(&ta).await.unwrap();
    let a2 = run.open(&ta).await.unwrap();
    // A fresh ticket of the same session shares its cap.
    let ta2 = run.ticket(&mut alice).await;
    assert_eq!(ta2.split('.').nth(4), ta.split('.').nth(4));
    let err = run.open(&ta2).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&err), (429, "too_many_connections"));
    assert!(err.1["error"]["message"].as_str().unwrap().contains("session"));
    let b1 = run.open(&tb).await.unwrap();
    let err = run.open(&tb).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&err), (429, "too_many_connections"));
    assert!(err.1["error"]["message"].as_str().unwrap().contains("address"), "{:?}", err.1);
    assert_eq!(run.gateway().stats.active(), 3);
    // Closing one connection frees one slot of each kind.
    let mut a1 = a1;
    a1.close(None).await.unwrap();
    drop(a1);
    for _ in 0..200 {
        if run.gateway().stats.active() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let b2 = run.open(&tb).await.expect("a released slot is reusable");
    // A connection whose client vanishes without a close frame releases its slots too.
    drop((a2, b1, b2));
    run.wait_idle().await;
    let d = run.diagnostics().await;
    assert_eq!((d["ws"]["clients"].as_u64(), d["ws"]["sessions"].as_u64()), (Some(0), Some(0)), "{}", d["ws"]);
    assert_eq!(d["ws"]["rejected"]["too_many_connections"], 2);
    run.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upstream_failures_are_502_and_trigger_a_probe() {
    // Nothing listens on the upstream port.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let run = Running::start(&[], closed, true).await;
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let err = run.open(&ticket).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&err), (502, "bad_gateway"));
    assert_eq!(run.gateway().stats.active(), 0, "no slot held after a failed upstream");
    // The failure asked the health job for an early probe, which marks the upstream down.
    let mut status = Value::Null;
    for _ in 0..300 {
        status = run.app.send(get("/api/health")).await.json()["wisp"]["direct"].clone();
        if status == "down" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(status, "down");
    run.stop().await;

    // The upstream answers, but not with 101.
    let refusing = Upstream::start_with(true).await;
    let run = Running::start(&[], refusing.addr, false).await;
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let err = run.open(&ticket).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&err), (502, "bad_gateway"));
    assert!(err.1["error"]["message"].as_str().unwrap().contains("HTTP 403"), "{:?}", err.1);
    let d = run.diagnostics().await;
    assert_eq!(d["ws"]["rejected"]["upstream"], 1);
    assert_eq!((d["ws"]["clients"].as_u64(), d["ws"]["total"].as_u64()), (Some(0), Some(0)));
    run.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_probes_and_vpn_profiles() {
    let direct = Upstream::start().await;
    let sweden = Upstream::start().await;
    let down = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path().join("profiles.toml");
    std::fs::write(
        &profiles,
        format!(
            "[[profile]]\nid = \"se-got\"\nlabel = \"Sweden · Gothenburg\"\ncountry_code = \"SE\"\ncountry = \
             \"Sweden\"\ncity = \"Gothenburg\"\nprovider_note = \"operator's own VPN account\"\nwisp_upstream = \
             \"{}\"\n\n[[profile]]\nid = \"ch-zrh\"\nlabel = \"Switzerland · Zurich\"\ncountry_code = \"ch\"\ncountry \
             = \"Switzerland\"\ncity = \"Zurich\"\nwisp_upstream = \"{down}\"\n",
            sweden.addr
        ),
    )
    .unwrap();
    let path = profiles.display().to_string();
    let run = Running::start(&[("GNOME_VPN_PROFILES", &path)], direct.addr, true).await;

    // Before the first probe: unknown.
    let loc = run.app.send(get("/api/vpn/locations")).await.json();
    assert_eq!(loc["profiles"][0]["status"], "unknown");
    assert_eq!(loc["profiles"][0]["checked_at"], Value::Null);
    run.gateway().upstreams.probe_all().await;
    let health = run.app.send(get("/api/health")).await.json();
    assert_eq!(health["wisp"], json!({"direct": "up", "se-got": "up", "ch-zrh": "down"}), "{health}");
    let loc = run.app.send(get("/api/vpn/locations")).await.json();
    let p = &loc["profiles"];
    assert_eq!(p.as_array().unwrap().len(), 2);
    assert_eq!(
        (&p[0]["id"], &p[0]["path"], &p[0]["status"], &p[0]["country_code"]),
        (&json!("se-got"), &json!("/wisp/p/se-got/"), &json!("up"), &json!("se"))
    );
    assert!(p[0]["checked_at"].as_i64().unwrap() > 0);
    assert_eq!(p[1]["status"], "down");
    // WAVE-C D15: no exit-check service unless the operator sets GNOME_VPN_CHECK_URL.
    assert!(loc["verify_url"].is_null() && loc["check_service"].is_null(), "{loc}");
    assert_eq!(p[0]["exit"]["state"], "off");
    let cfg = run.app.send(get("/api/config")).await.json();
    assert_eq!(cfg["features"]["vpn_gateway"], true);
    assert_eq!(cfg["wisp"]["profiles"][0]["path"], "/wisp/p/se-got/");
    assert_eq!(cfg["wisp"]["profiles"][1]["id"], "ch-zrh");
    let d = run.diagnostics().await;
    let ups = d["upstreams"].as_array().unwrap();
    assert_eq!(ups.iter().map(|u| u["id"].as_str().unwrap()).collect::<Vec<_>>(), ["direct", "se-got", "ch-zrh"]);
    assert!(ups[2]["error"].as_str().is_some(), "{d}");
    let metrics = run.app.send_admin(admin_metrics()).await.text();
    assert!(metrics.contains("gnome_wisp_upstream_up{id=\"se-got\"} 1\n"), "{metrics}");
    assert!(metrics.contains("gnome_wisp_upstream_up{id=\"ch-zrh\"} 0\n"), "{metrics}");

    // A profile path reaches that profile's upstream only.
    let mut client = run.app.client();
    let ticket = run.ticket_for(&mut client, json!({"route": {"profile": "se-got"}})).await;
    let origin = run.origin();
    let (mut ws, _) =
        connect(run.proxy, &format!("/wisp/p/se-got/?t={ticket}"), &[("Origin", &origin)], None).await.unwrap();
    assert_eq!(next_binary(&mut ws).await, GREETING);
    ws.send(Message::binary(b"via sweden".to_vec())).await.unwrap();
    assert_eq!(next_binary(&mut ws).await, b"via sweden");
    ws.close(None).await.unwrap();
    drop(ws);
    run.wait_idle().await;
    let swedish = sweden.heads();
    assert_eq!(swedish.len(), 1, "the relayed connection");
    assert!(swedish[0].starts_with("GET /wisp/p/se-got/ HTTP/1.1\r\n"), "{}", swedish[0]);
    assert!(direct.heads().is_empty(), "nothing relayed to direct");
    // A ticket of one location is refused on another one's path (D23).
    let err = connect(run.proxy, &format!("/wisp/p/ch-zrh/?t={ticket}"), &[("Origin", &origin)], None)
        .await
        .map(|_| ())
        .unwrap_err();
    assert_eq!(code(&err), (401, "wisp_ticket_wrong_route"));
    let zrh = run.ticket_for(&mut client, json!({"route": {"profile": "ch-zrh"}})).await;
    let err = connect(run.proxy, &format!("/wisp/p/ch-zrh/?t={zrh}"), &[("Origin", &origin)], None)
        .await
        .map(|_| ())
        .unwrap_err();
    assert_eq!(code(&err), (502, "bad_gateway"));
    run.stop().await;
}

/// The usual deployment: one listener for both hostnames (a reverse proxy in front). The proxy origin's host gets the
/// gateway on the main listener (by `Host`, or by `X-Forwarded-Host` from a trusted proxy that rewrote `Host`); every
/// other host is the app role, where `/wisp/` does not exist.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_main_listener_routes_upgrades_by_host() {
    let upstream = Upstream::start().await;
    let run = Running::start(&[], upstream.addr, true).await; // trusts 127.0.0.1 (the default)
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let origin = run.origin();
    let proxy_host = run.proxy.to_string();
    let path = format!("/wisp/?t={ticket}");
    let via_host = connect_as(run.public, &proxy_host, &path, &[("Origin", &origin)], None).await;
    let (mut ws, _) = via_host.unwrap_or_else(|e| panic!("Host = the proxy origin's host: {e:?}"));
    assert_eq!(next_binary(&mut ws).await, GREETING);
    ws.send(Message::binary(b"main listener".to_vec())).await.unwrap();
    assert_eq!(next_binary(&mut ws).await, b"main listener");
    ws.close(None).await.unwrap();
    drop(ws);
    let forwarded = [("Origin", origin.as_str()), ("X-Forwarded-Host", proxy_host.as_str())];
    let app_host = run.public.to_string();
    let (mut ws, _) = connect_as(run.public, &app_host, &path, &forwarded, None)
        .await
        .unwrap_or_else(|e| panic!("X-Forwarded-Host from a trusted proxy: {e:?}"));
    assert_eq!(next_binary(&mut ws).await, GREETING);
    ws.close(None).await.unwrap();
    drop(ws);
    run.wait_idle().await;
    // The app role: no gateway at all, whatever the Origin.
    for o in [origin.as_str(), ORIGIN] {
        let err = connect_as(run.public, &app_host, &path, &[("Origin", o)], None).await.map(|_| ()).unwrap_err();
        assert_eq!(code(&err), (404, "not_found"), "{o}");
    }
    assert_eq!(upstream.heads().len(), 2, "only the two proxy-role upgrades reached the upstream");
    run.stop().await;
}

/// `accounts` mode: signing out ends the session's open Wisp connections too (not only new upgrades), while the
/// connections of the user's other, still signed-in device stay up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signing_out_closes_open_connections_of_that_session() {
    let upstream = Upstream::start().await;
    let check = Duration::from_millis(100);
    let options = GatewayOptions { session_check: check, ..GatewayOptions::default() };
    let run = Running::start_with(&[("GNOME_ACCESS_MODE", "accounts")], upstream.addr, options).await;
    let mut phone = run.app.client();
    phone.register("carol_g", "a long password").await;
    let mut laptop = run.app.client();
    let res = laptop.post("/api/auth/login", json!({"username": "carol_g", "password": "a long password"})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let (tp, tl) = (run.ticket(&mut phone).await, run.ticket(&mut laptop).await);
    let mut on_phone = run.open(&tp).await.unwrap();
    let mut on_laptop = run.open(&tl).await.unwrap();
    for ws in [&mut on_phone, &mut on_laptop] {
        assert_eq!(next_binary(ws).await, GREETING);
    }
    // Several checks pass while the sessions are live.
    tokio::time::sleep(check * 5).await;
    on_phone.send(Message::binary(b"still here".to_vec())).await.unwrap();
    assert_eq!(next_binary(&mut on_phone).await, b"still here");

    assert_eq!(phone.post("/api/auth/logout", json!({})).await.status, StatusCode::NO_CONTENT);
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match on_phone.next().await {
                Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_))) => {}
                _ => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the signed-out session's connection was closed");
    // The other device is unaffected, and a new upgrade with the old ticket is refused.
    on_laptop.send(Message::binary(b"laptop".to_vec())).await.unwrap();
    assert_eq!(next_binary(&mut on_laptop).await, b"laptop");
    assert_eq!(code(&run.open(&tp).await.map(|_| ()).unwrap_err()), (401, "wisp_ticket_revoked"));
    on_laptop.close(None).await.unwrap();
    drop((on_phone, on_laptop));
    run.wait_idle().await;
    let d = run.diagnostics().await;
    assert_eq!((d["ws"]["clients"].as_u64(), d["ws"]["sessions"].as_u64()), (Some(0), Some(0)), "{}", d["ws"]);
    run.stop().await;
}

/// A plain GET over a real socket; returns the status and JSON body.
async fn plain_get(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let status = out.split(' ').nth(1).unwrap().parse().unwrap();
    let body = out.split_once("\r\n\r\n").map_or("", |(_, b)| b);
    (status, serde_json::from_str(body).unwrap_or(Value::Null))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ticket_url_forms_and_probes_over_real_sockets() {
    let upstream = Upstream::start().await;
    let run = Running::start(&[("GNOME_MAX_WS_PER_SESSION", "1")], upstream.addr, true).await;
    let mut client = run.app.client();
    let ticket = run.ticket(&mut client).await;
    let origin = run.origin();
    let o = [("Origin", origin.as_str())];
    // The canonical `&/` form and the trailing-slash form both upgrade; HolyWisp sees neither the query nor the
    // ticket in any spelling.
    for path in [format!("/wisp/?t={ticket}&/"), format!("/wisp/?t={ticket}/"), format!("/wisp/?x=1&t={ticket}&/")] {
        let (mut ws, _) = connect(run.proxy, &path, &o, None).await.unwrap_or_else(|e| panic!("{path}: {e:?}"));
        assert_eq!(next_binary(&mut ws).await, GREETING);
        ws.close(None).await.unwrap();
        drop(ws);
        run.wait_idle().await;
    }
    assert_eq!(
        code(&connect(run.proxy, &format!("/wisp/?t={ticket}//"), &o, None).await.map(|_| ()).unwrap_err()),
        (401, "wisp_ticket_invalid")
    );
    let heads = upstream.heads();
    assert_eq!(heads.len(), 3);
    let (mac, sref) = (ticket.rsplit('.').next().unwrap(), ticket.split('.').nth(4).unwrap());
    for h in &heads {
        assert!(h.starts_with("GET /wisp/ HTTP/1.1\r\n"), "{h}");
        assert!(!h.contains(mac) && !h.contains(sref) && !h.contains("t="), "{h}");
    }

    // With the session's only slot taken, a probe still answers 426 (it takes no slot) and reaches nobody.
    let (mut held, _) = connect(run.proxy, &format!("/wisp/?t={ticket}&/"), &o, None).await.unwrap();
    assert_eq!(next_binary(&mut held).await, GREETING);
    assert_eq!(
        code(&connect(run.proxy, &format!("/wisp/?t={ticket}&/"), &o, None).await.map(|_| ()).unwrap_err()),
        (429, "too_many_connections")
    );
    let before = upstream.heads().len();
    for _ in 0..5 {
        let (status, body) = plain_get(run.proxy, &format!("/wisp/?t={ticket}&/")).await;
        assert_eq!((status, body["error"]["code"].as_str()), (426, Some("upgrade_required")), "{body}");
    }
    let (status, body) = plain_get(run.proxy, "/wisp/?t=w1.1.AAAAAAAAAAAAAAAAAAAAAA.x&/").await;
    assert_eq!((status, body["error"]["code"].as_str()), (401, Some("wisp_ticket_invalid")), "{body}");
    assert_eq!(upstream.heads().len(), before, "probes never contact the upstream");
    let d = run.diagnostics().await;
    assert_eq!((d["ws"]["active"].as_i64(), d["ws"]["sessions"].as_u64()), (Some(1), Some(1)), "{}", d["ws"]);
    assert_eq!(d["ws"]["probes"], json!({"valid": 5, "rejected": 1, "upstream_down": 0}));
    held.close(None).await.unwrap();
    drop(held);
    run.wait_idle().await;
    run.stop().await;
}

/// D23: tickets are bound to their route. A ticket works only on its own path; tickets minted before the server
/// started are stale; once a session minted a profile-route ticket, its older default-route tickets are refused and
/// their open connections close at the next session re-check (shortened here; 15 s in production), while a
/// default-route ticket minted later (the app's real fallback) works.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tickets_are_bound_to_their_route() {
    let direct = Upstream::start().await;
    let sweden = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let profiles = dir.path().join("profiles.toml");
    std::fs::write(
        &profiles,
        format!(
            "[[profile]]\nid = \"se-got\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \
             \"Gothenburg\"\nwisp_upstream = \"{}\"\n",
            sweden.addr
        ),
    )
    .unwrap();
    let path = profiles.display().to_string();
    let check = Duration::from_millis(200);
    let options = GatewayOptions { session_check: check, ..GatewayOptions::default() };
    let run = Running::start_with(&[("GNOME_VPN_PROFILES", &path)], direct.addr, options).await;
    let origin = run.origin();
    let o = [("Origin", origin.as_str())];
    let mut client = run.app.client();

    let td = run.ticket(&mut client).await;
    let mut on_direct = run.open(&td).await.unwrap();
    assert_eq!(next_binary(&mut on_direct).await, GREETING);
    let wrong = connect(run.proxy, &format!("/wisp/p/se-got/?t={td}"), &o, None).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&wrong), (401, "wisp_ticket_wrong_route"));
    // The probe answers the same.
    assert_eq!(plain_get(run.proxy, &format!("/wisp/p/se-got/?t={td}&/")).await.0, 401);

    // Mint times are whole seconds: the profile mint must be strictly later than the default one.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let tp = run.ticket_for(&mut client, json!({"route": {"profile": "se-got"}})).await;
    let wrong = connect(run.proxy, &format!("/wisp/?t={tp}"), &o, None).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&wrong), (401, "wisp_ticket_wrong_route"));
    let (mut on_vpn, _) = connect(run.proxy, &format!("/wisp/p/se-got/?t={tp}"), &o, None).await.unwrap();
    assert_eq!(next_binary(&mut on_vpn).await, GREETING);

    // The open direct connection ends at the next re-check; the old ticket is refused from now on.
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match on_direct.next().await {
                Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_))) => {}
                _ => return,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the superseded direct-route connection was closed");
    assert_eq!(code(&run.open(&td).await.map(|_| ()).unwrap_err()), (401, "wisp_ticket_superseded"));
    // The profile connection is unaffected.
    on_vpn.send(Message::binary(b"via sweden".to_vec())).await.unwrap();
    assert_eq!(next_binary(&mut on_vpn).await, b"via sweden");
    // Another session's direct tickets are not affected by this session's mint.
    let mut other = run.app.client();
    let t_other = run.ticket(&mut other).await;
    let mut ws_other = run.open(&t_other).await.unwrap();
    assert_eq!(next_binary(&mut ws_other).await, GREETING);
    // A direct-route ticket minted after the profile one works (the app's fallback with the kill switch off).
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let td2 = run.ticket(&mut client).await;
    let mut on_direct2 = run.open(&td2).await.unwrap();
    assert_eq!(next_binary(&mut on_direct2).await, GREETING);

    // A ticket minted before this process started (an earlier run with the same secret) is stale.
    let key = TicketKey::new(&run.app.state.secret, gnome_server::config::AccessMode::Open, None);
    let now = gnome_server::util::now_s();
    let old = key.mint(SessionRef([7; 16]), &TicketRoute::Default, now - 3600, now + 600);
    assert_eq!(code(&run.open(&old).await.map(|_| ()).unwrap_err()), (401, "wisp_ticket_stale"));
    let old_vpn = key.mint(SessionRef([7; 16]), &TicketRoute::Profile("se-got".into()), now - 3600, now + 600);
    let err = connect(run.proxy, &format!("/wisp/p/se-got/?t={old_vpn}"), &o, None).await.map(|_| ()).unwrap_err();
    assert_eq!(code(&err), (401, "wisp_ticket_stale"));
    // A w1 ticket (before D23) is refused as invalid.
    let w1 = format!("w1.{}.{}.{}", now + 600, SessionRef([7; 16]).to_b64(), "A".repeat(43));
    assert_eq!(code(&run.open(&w1).await.map(|_| ()).unwrap_err()), (401, "wisp_ticket_invalid"));

    for ws in [&mut on_vpn, &mut ws_other, &mut on_direct2] {
        ws.close(None).await.unwrap();
    }
    drop((on_direct, on_vpn, ws_other, on_direct2));
    run.wait_idle().await;
    run.stop().await;
}
