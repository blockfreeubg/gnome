//! Real end-to-end check against a HolyWisp binary (ignored by default; needs network access):
//!
//! ```sh
//! HOLYWISP_BIN=services/holywisp/build/x86_64/holywisp \
//!   cargo test -p gnome-server --test holywisp_e2e -- --ignored --nocapture
//! ```
//!
//! Optional: `HOLYWISP_CONF` (default `services/holywisp/gnome.conf`; the test overrides `--port` and
//! `--log-level info` on the command line, the file is never modified), `HOLYWISP_PORT` (default: a free port),
//! `GNOME_SERVER_BIN` (default: this build's `gnome-server`, e.g. set it to `target/release/gnome-server`),
//! `GNOME_E2E_PORT_BASE` (gnome-server listeners on base..base+8; default: free ports). With `HOLYWISP_PORT` set the
//! HolyWisp instances use `HOLYWISP_PORT`..`HOLYWISP_PORT+2`.
//!
//! It starts HolyWisp and the real `gnome-server` binary (public, proxy and admin listeners: two-origin mode,
//! upstream = HolyWisp), mints a Wisp ticket with a real HTTP request, then fetches `http://example.org/` and
//! `https://example.com/` through the gateway with a minimal Wisp v1 client (below; TLS by rustls over the Wisp
//! stream). It checks the gateway's health probe and relay counters in `/admin/diagnostics`, and which client IP
//! HolyWisp applies its policy to: a dial to a refused destination makes HolyWisp log
//! `egress: <client ip>: blocked …`, which must name the gateway-resolved client IP — never a spoofed header.
//! Both ticket URL forms (`?t=<ticket>&/`, `?t=<ticket>/`) are used, the ticket probe is checked (valid → 426,
//! forged/expired → 401, no `Origin`), and the startup log must report the file-descriptor limit.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt as _, StreamExt as _};
use gnome_server::config::AccessMode;
use gnome_server::gateway::ticket::{SessionRef, TicketKey};
use gnome_server::gateway::upstream::accept_key;
use gnome_server::security::secret_key::SecretKey;
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, DuplexStream};
use tokio::net::TcpStream;
use tokio_rustls::rustls;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;

// ------------------------------------------------------------------------------------------- Wisp v1 client

const CONNECT: u8 = 0x01;
const DATA: u8 = 0x02;
const CONTINUE: u8 = 0x03;
const CLOSE: u8 = 0x04;
const TCP: u8 = 0x01;

type Ws = WebSocketStream<TcpStream>;

fn frame(kind: u8, stream: u32, payload: &[u8]) -> Message {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.push(kind);
    f.extend_from_slice(&stream.to_le_bytes());
    f.extend_from_slice(payload);
    Message::binary(f)
}

/// Open TCP stream `id` to `host:port` on a fresh Wisp connection and bridge it to an in-memory duplex. Returns the
/// application side and a handle resolving to the CLOSE reason.
async fn wisp_stream(mut ws: Ws, host: &str, port: u16) -> (DuplexStream, tokio::task::JoinHandle<u8>) {
    // The server's first frame: CONTINUE on stream 0 with the initial buffer (packets in flight per stream).
    let first = next_frame(&mut ws).await.expect("initial CONTINUE");
    assert_eq!((first.0, first.1), (CONTINUE, 0), "Wisp v1 starts with CONTINUE(0)");
    let mut window = u32::from_le_bytes(first.2[..4].try_into().unwrap());
    let id = 1u32;
    let mut connect = vec![TCP];
    connect.extend_from_slice(&port.to_le_bytes());
    connect.extend_from_slice(host.as_bytes());
    ws.send(frame(CONNECT, id, &connect)).await.unwrap();
    let (app, mut bridge) = tokio::io::duplex(256 * 1024);
    let task = tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        let mut reading = true;
        loop {
            tokio::select! {
                n = bridge.read(&mut buf), if reading && window > 0 => match n {
                    Ok(0) | Err(_) => reading = false, // Wisp v1 has no half-close: keep receiving
                    Ok(n) => {
                        ws.send(frame(DATA, id, &buf[..n])).await.unwrap();
                        window -= 1;
                    }
                },
                f = next_frame(&mut ws) => match f {
                    Some((DATA, sid, payload)) if sid == id => {
                        if bridge.write_all(&payload).await.is_err() {
                            return 0;
                        }
                    }
                    Some((CONTINUE, sid, payload)) if sid == id => {
                        window = u32::from_le_bytes(payload[..4].try_into().unwrap());
                    }
                    Some((CLOSE, sid, payload)) if sid == id => {
                        let _ = bridge.shutdown().await;
                        let _ = ws.close(None).await;
                        return payload.first().copied().unwrap_or(0);
                    }
                    Some(_) => {}
                    None => return 0,
                },
            }
        }
    });
    (app, task)
}

async fn next_frame(ws: &mut Ws) -> Option<(u8, u32, Vec<u8>)> {
    loop {
        match tokio::time::timeout(Duration::from_secs(30), ws.next()).await.ok()?? {
            Ok(Message::Binary(b)) if b.len() >= 5 => {
                return Some((b[0], u32::from_le_bytes(b[1..5].try_into().unwrap()), b[5..].to_vec()));
            }
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

// --------------------------------------------------------------------------------------------- the stack

struct HolyWisp {
    child: Child,
    addr: SocketAddr,
    log: PathBuf,
}

impl HolyWisp {
    /// `instance` 0, 1, …: port `HOLYWISP_PORT + instance` (or a free port) and its own log file.
    async fn start(dir: &std::path::Path, instance: u16) -> Self {
        let bin = std::env::var("HOLYWISP_BIN").expect("set HOLYWISP_BIN to the holywisp binary");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let conf = std::env::var("HOLYWISP_CONF")
            .map(PathBuf::from)
            .unwrap_or_else(|_| root.join("services/holywisp/gnome.conf"));
        let port: u16 = match std::env::var("HOLYWISP_PORT") {
            Ok(p) => p.parse::<u16>().expect("HOLYWISP_PORT") + instance,
            Err(_) => std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(),
        };
        let log = dir.join(format!("holywisp-{instance}.log"));
        let out = std::fs::File::create(&log).unwrap();
        let child = Command::new(bin)
            .arg("--config")
            .arg(&conf)
            .args(["--port", &port.to_string(), "--log-level", "info", "--workers", "2"])
            .stdout(Stdio::from(out.try_clone().unwrap()))
            .stderr(Stdio::from(out))
            .spawn()
            .expect("start holywisp");
        // Owned by `Self` at once: its `Drop` kills and reaps the process on every path, panics included.
        let hw = Self { child, addr: format!("127.0.0.1:{port}").parse().unwrap(), log };
        for _ in 0..100 {
            if TcpStream::connect(hw.addr).await.is_ok() {
                return hw;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("holywisp did not start: {}", hw.log());
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

impl Drop for HolyWisp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A `gnome-server` process (stopped with SIGTERM, then reaped, on drop).
struct Gnome {
    child: Child,
    public: SocketAddr,
    proxy: SocketAddr,
    admin: SocketAddr,
    log: PathBuf,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

impl Gnome {
    /// `instance` picks the ports (`GNOME_E2E_PORT_BASE + 3 * instance ..`).
    async fn start(dir: &std::path::Path, instance: u16, upstream: SocketAddr, trusted_proxies: &str) -> Self {
        Self::start_with(dir, instance, upstream, trusted_proxies, &[]).await
    }

    /// [`Gnome::start`] with more environment variables.
    async fn start_with(
        dir: &std::path::Path,
        instance: u16,
        upstream: SocketAddr,
        trusted_proxies: &str,
        env: &[(&str, &str)],
    ) -> Self {
        let bin = std::env::var("GNOME_SERVER_BIN").unwrap_or_else(|_| env!("CARGO_BIN_EXE_gnome-server").into());
        let ports: [u16; 3] = match std::env::var("GNOME_E2E_PORT_BASE") {
            Ok(base) => {
                let base: u16 = base.parse().expect("GNOME_E2E_PORT_BASE");
                [0, 1, 2].map(|i| base + 3 * instance + i)
            }
            Err(_) => [free_port(), free_port(), free_port()],
        };
        let [public, proxy, admin] = ports.map(|p| SocketAddr::from(([127, 0, 0, 1], p)));
        let data = dir.join(format!("gnome-{instance}"));
        let log = dir.join(format!("gnome-{instance}.log"));
        let out = std::fs::File::create(&log).unwrap();
        let child = Command::new(bin)
            .env_clear()
            .env("GNOME_BIND", public.to_string())
            .env("GNOME_PROXY_BIND", proxy.to_string())
            .env("GNOME_ADMIN_BIND", admin.to_string())
            .env("GNOME_WISP_UPSTREAM", upstream.to_string())
            .env("GNOME_TRUSTED_PROXIES", trusted_proxies)
            .env("GNOME_DATA_DIR", &data)
            .env("GNOME_STATIC_DIR", data.join("static"))
            .env("GNOME_LOG", "info")
            .envs(env.iter().copied())
            .stdout(Stdio::from(out.try_clone().unwrap()))
            .stderr(Stdio::from(out))
            .spawn()
            .expect("start gnome-server");
        let g = Self { child, public, proxy, admin, log };
        for _ in 0..200 {
            if TcpStream::connect(g.admin).await.is_ok() && TcpStream::connect(g.proxy).await.is_ok() {
                return g;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("gnome-server did not start: {}", std::fs::read_to_string(&g.log).unwrap_or_default());
    }

    /// `GET /admin/diagnostics` (loopback admin listener, no token).
    async fn diagnostics(&self) -> Value {
        let mut s = TcpStream::connect(self.admin).await.unwrap();
        let req = format!("GET /admin/diagnostics HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", self.admin);
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200 "), "{out}");
        serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    /// `POST /api/wisp/ticket` over HTTP on the app origin (creates the anonymous session).
    async fn ticket(&self) -> Value {
        let mut s = TcpStream::connect(self.public).await.unwrap();
        let req = format!(
            "POST /api/wisp/ticket HTTP/1.1\r\nHost: {0}\r\nOrigin: http://{0}\r\nX-Gnome-Request: 1\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n",
            self.public
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200 "), "{out}");
        // A loopback app origin over plain HTTP gets the production (`__Host-`, Secure) cookie names.
        assert!(out.to_ascii_lowercase().contains("set-cookie: __host-gnome_sid="), "{out}");
        serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    /// Open the Wisp WebSocket through the gateway (`extra` = more request headers).
    async fn wisp(&self, ticket: &str, extra: &str) -> Ws {
        self.wisp_at("/wisp/", ticket, extra).await.0
    }

    /// Open the Wisp WebSocket at `path` (`/wisp/` or a profile's `/wisp/p/<id>/`) with the canonical ticket form
    /// `?t=<ticket>&/`; returns the socket and the gateway's response head.
    async fn wisp_at(&self, path: &str, ticket: &str, extra: &str) -> (Ws, String) {
        self.wisp_query(path, &format!("t={ticket}&/"), extra).await
    }

    /// Plain `GET` (no `Upgrade`, no `Origin`) of `path?query` on the proxy listener: the ticket probe.
    async fn probe(&self, path_and_query: &str) -> (u16, Value) {
        let mut s = TcpStream::connect(self.proxy).await.unwrap();
        let req = format!("GET {path_and_query} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", self.proxy);
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        let status = out.split(' ').nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(out.split("\r\n\r\n").nth(1).unwrap_or("")).unwrap_or(Value::Null))
    }

    /// [`Gnome::wisp_at`] with any query string.
    async fn wisp_query(&self, path: &str, query: &str, extra: &str) -> (Ws, String) {
        let mut s = TcpStream::connect(self.proxy).await.unwrap();
        let mut key = [0u8; 16];
        getrandom::fill(&mut key).unwrap();
        let key = STANDARD.encode(key);
        let req = format!(
            "GET {path}?{query} HTTP/1.1\r\nHost: {0}\r\nOrigin: http://{0}\r\nUpgrade: websocket\r\nConnection: \
             Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n{extra}\r\n",
            self.proxy
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut head = Vec::new();
        let mut b = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(s.read(&mut b).await.unwrap(), 1, "closed during the head");
            head.push(b[0]);
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        assert!(head.starts_with("HTTP/1.1 101 "), "{head}");
        assert!(head.contains(&accept_key(&key)), "{head}");
        (WebSocketStream::from_raw_socket(s, Role::Client, None).await, head)
    }

    /// SIGTERM and wait for a clean exit (the Wisp connections are closed by then).
    async fn stop(mut self) -> String {
        let pid = self.child.id().to_string();
        let _ = Command::new("kill").args(["-TERM", &pid]).status();
        for _ in 0..300 {
            if let Ok(Some(status)) = self.child.try_wait() {
                assert!(status.success(), "gnome-server exited with {status}");
                return std::fs::read_to_string(&self.log).unwrap_or_default();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("gnome-server did not stop within 15 s");
    }
}

impl Drop for Gnome {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tls() -> tokio_rustls::TlsConnector {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

async fn http_get<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut s: S, host: &str) -> String {
    let req = format!("GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: gnome-e2e\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    // TLS peers may end without close_notify; what was read is what counts.
    let _ = tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs HOLYWISP_BIN and network access"]
async fn fetch_through_gateway_and_holywisp() {
    let dir = tempfile::tempdir().unwrap();
    let hw = HolyWisp::start(dir.path(), 0).await;

    // 1. The gateway's health probe (≈1 s after start) accepts HolyWisp. A known secret key lets this test sign an
    // expired ticket the server accepts as genuine.
    let master = [0x5au8; 32];
    let key_b64 = STANDARD.encode(master);
    let gnome = Gnome::start_with(dir.path(), 0, hw.addr, "", &[("GNOME_SECRET_KEY", &key_b64)]).await;
    let mut upstream = Value::Null;
    for _ in 0..100 {
        upstream = gnome.diagnostics().await["upstreams"][0].clone();
        if upstream["status"] != "unknown" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!((&upstream["id"], &upstream["status"]), (&"direct".into(), &"up".into()), "{upstream}");
    eprintln!("probe: {upstream}");

    // 2. Plain HTTP through the gateway.
    let t = gnome.ticket().await;
    let ticket = t["ticket"].as_str().unwrap();
    assert_eq!(t["wisp_url"], format!("ws://{}/wisp/", gnome.proxy));
    // The ticket probe: plain GETs without Origin. Valid → 426 (both routes); forged / expired / missing → 401.
    let key = TicketKey::new(&SecretKey::from_bytes(master.to_vec()).unwrap(), AccessMode::Open, None);
    let sref = SessionRef([1; 16]);
    let now = gnome_server::util::now_s();
    let expired = key.mint(sref, now - 1);
    let forged =
        TicketKey::new(&SecretKey::from_bytes(vec![1; 32]).unwrap(), AccessMode::Open, None).mint(sref, now + 600);
    for (pq, want) in [
        (format!("/wisp/?t={ticket}&/"), (426, "upgrade_required")),
        (format!("/wisp/?t={ticket}/"), (426, "upgrade_required")),
        (format!("/wisp/?t={ticket}//"), (401, "wisp_ticket_invalid")),
        (format!("/wisp/?t={forged}&/"), (401, "wisp_ticket_invalid")),
        (format!("/wisp/?t={expired}&/"), (401, "wisp_ticket_expired")),
        ("/wisp/".to_string(), (401, "wisp_ticket_missing")),
        (format!("/wisp/p/nope/?t={ticket}&/"), (404, "not_found")),
    ] {
        let (status, body) = gnome.probe(&pq).await;
        assert_eq!((status, body["error"]["code"].as_str().unwrap_or("?")), want, "probe {pq}: {body}");
    }
    eprintln!("probes: valid -> 426, forged/expired/missing -> 401, unknown profile -> 404");

    // Canonical `?t=<ticket>&/` form.
    let (io, close) = wisp_stream(gnome.wisp(ticket, "").await, "example.org", 80).await;
    let res = http_get(io, "example.org").await;
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert!(res.contains("Example Domain"), "{res}");
    eprintln!(
        "http://example.org/ -> {} ({} bytes), CLOSE {:#x}",
        res.lines().next().unwrap(),
        res.len(),
        close.await.unwrap()
    );

    // 3. HTTPS (TLS end-to-end between this client and example.com; the gateway and HolyWisp only see ciphertext),
    // over the trailing-slash form `?t=<ticket>/`.
    let (ws, _) = gnome.wisp_query("/wisp/", &format!("t={ticket}/"), "").await;
    let (io, close) = wisp_stream(ws, "example.com", 443).await;
    let name = rustls::pki_types::ServerName::try_from("example.com").unwrap();
    let tls = tls().connect(name, io).await.expect("TLS handshake with example.com through Wisp");
    let res = http_get(tls, "example.com").await;
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert!(res.contains("Example Domain"), "{res}");
    eprintln!(
        "https://example.com/ -> {} ({} bytes), CLOSE {:#x}",
        res.lines().next().unwrap(),
        res.len(),
        close.await.unwrap()
    );

    // 4. Client IP: a spoofed X-Forwarded-For from an untrusted client changes nothing.
    let (io, close) = wisp_stream(
        gnome.wisp(ticket, "X-Forwarded-For: 198.51.100.66\r\nCF-Connecting-IP: 198.51.100.67\r\n").await,
        "127.0.0.1",
        80,
    )
    .await;
    drop(io);
    assert_eq!(close.await.unwrap(), 0x48, "loopback destinations are refused (host blocked)");
    let mut ws = Value::Null;
    for _ in 0..100 {
        ws = gnome.diagnostics().await["ws"].clone();
        if ws["active"] == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eprintln!("gateway: {ws}");
    assert_eq!((ws["active"].as_i64(), ws["total"].as_u64()), (Some(0), Some(3)), "{ws}");
    let path = if cfg!(target_os = "linux") { "zero_copy" } else { "copy" };
    assert_eq!(ws["relays"][path], 3, "{ws}");
    assert!(ws["bytes_up"].as_u64().unwrap() > 0 && ws["bytes_down"].as_u64().unwrap() > 1000, "{ws}");
    assert_eq!(ws["probes"], serde_json::json!({"valid": 2, "rejected": 4, "upstream_down": 0}), "{ws}");
    let d = gnome.diagnostics().await;
    eprintln!("fd_limit: {}", d["fd_limit"]);
    assert!(d["fd_limit"]["startup"].is_object(), "{}", d["fd_limit"]);
    let log = gnome.stop().await;
    assert!(!log.contains(ticket), "the ticket is never logged");
    let fd_line = log.lines().find(|l| l.contains("file descriptor limit")).expect("the fd limit is logged at startup");
    eprintln!("startup: {fd_line}");

    // 5. Behind a trusted reverse proxy, the client IP it states is what HolyWisp sees.
    let gnome = Gnome::start(dir.path(), 1, hw.addr, "127.0.0.1/32").await;
    let t = gnome.ticket().await;
    let (io, close) = wisp_stream(
        gnome.wisp(t["ticket"].as_str().unwrap(), "X-Forwarded-For: 198.51.100.77\r\n").await,
        "127.0.0.1",
        80,
    )
    .await;
    drop(io);
    assert_eq!(close.await.unwrap(), 0x48);
    let _ = gnome.stop().await;

    tokio::time::sleep(Duration::from_millis(300)).await;
    let log = hw.log();
    eprintln!("--- holywisp log ---\n{log}");
    let blocked: Vec<&str> = log.lines().filter(|l| l.contains("blocked 127.0.0.1:80")).collect();
    assert_eq!(blocked.len(), 2, "{log}");
    assert!(blocked[0].contains("egress: 127.0.0.1: "), "untrusted client: the socket peer, not the header: {log}");
    assert!(blocked[1].contains("egress: 198.51.100.77: "), "trusted reverse proxy: its client: {log}");
    for spoofed in ["198.51.100.66", "198.51.100.67"] {
        assert!(!log.contains(spoofed), "{spoofed} reached HolyWisp: {log}");
    }
    let mac = ticket.rsplit('.').next().unwrap();
    assert!(!log.contains(mac) && !log.contains("t="), "no form of the ticket reached HolyWisp: {log}");
}

/// Wisp v2 `INFO` packet type.
const INFO: u8 = 0x05;

/// Wait until every upstream in `/admin/diagnostics` has a probe result; returns `upstreams`.
async fn probed_upstreams(gnome: &Gnome) -> Value {
    let mut ups = Value::Null;
    for _ in 0..100 {
        ups = gnome.diagnostics().await["upstreams"].clone();
        if ups.as_array().is_some_and(|a| a.iter().all(|u| u["status"] != "unknown")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    ups
}

/// A VPN gateway profile against real HolyWisp instances (HolyWisp ignores the request path, so this is what
/// proves the routing): `/wisp/p/<id>/` reaches that profile's instance only and its probe is up; Wisp v2
/// negotiates through the gateway (the subprotocol is echoed, `INFO` is the first frame); a client that
/// half-closes its socket without a WebSocket close frame ends the relay on both sides and frees its slots.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs HOLYWISP_BIN and network access"]
async fn vpn_profile_path_wisp_v2_and_half_close() {
    let dir = tempfile::tempdir().unwrap();
    // HolyWisp instances 1 and 2 and gnome-server instance 2: the other test (instance 0 / 0-1) may run alongside.
    let direct = HolyWisp::start(dir.path(), 1).await;
    let exit = HolyWisp::start(dir.path(), 2).await;
    let profiles = dir.path().join("profiles.toml");
    std::fs::write(
        &profiles,
        format!(
            "[[profile]]\nid = \"e2e-exit\"\nlabel = \"E2E exit\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\n\
             city = \"Gothenburg\"\nwisp_upstream = \"{}\"\n",
            exit.addr
        ),
    )
    .unwrap();
    let profiles = profiles.display().to_string();
    let gnome = Gnome::start_with(dir.path(), 2, direct.addr, "", &[("GNOME_VPN_PROFILES", &profiles)]).await;
    let ups = probed_upstreams(&gnome).await;
    eprintln!("probes: {ups}");
    assert_eq!((&ups[0]["id"], &ups[0]["status"]), (&"direct".into(), &"up".into()), "{ups}");
    assert_eq!((&ups[1]["id"], &ups[1]["status"]), (&"e2e-exit".into(), &"up".into()), "{ups}");

    // 1. Real browsing through the profile path.
    let t = gnome.ticket().await;
    let ticket = t["ticket"].as_str().unwrap().to_string();
    let (ws, _) = gnome.wisp_at("/wisp/p/e2e-exit/", &ticket, "").await;
    let (io, close) = wisp_stream(ws, "example.org", 80).await;
    let res = http_get(io, "example.org").await;
    assert!(res.starts_with("HTTP/1.1 200") && res.contains("Example Domain"), "{res}");
    eprintln!("via profile: http://example.org/ -> {}, CLOSE {:#x}", res.lines().next().unwrap(), close.await.unwrap());

    // 2. A refused destination through the profile is seen by the profile's instance only.
    let (ws, _) = gnome.wisp_at("/wisp/p/e2e-exit/", &ticket, "").await;
    let (io, close) = wisp_stream(ws, "127.0.0.1", 81).await;
    drop(io);
    assert_eq!(close.await.unwrap(), 0x48, "loopback is refused by the profile's HolyWisp");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(exit.log().contains("blocked 127.0.0.1:81"), "{}", exit.log());
    assert!(!direct.log().contains("blocked 127.0.0.1:81"), "{}", direct.log());

    // 3. Wisp v2: the subprotocol is relayed both ways and HolyWisp's INFO arrives first.
    let (mut ws, head) = gnome.wisp_at("/wisp/", &ticket, "Sec-WebSocket-Protocol: wisp-v2\r\n").await;
    assert!(head.to_ascii_lowercase().contains("\r\nsec-websocket-protocol: wisp-v2\r\n"), "{head}");
    let first = next_frame(&mut ws).await.expect("a first frame");
    assert_eq!((first.0, first.1), (INFO, 0), "Wisp v2 starts with INFO on stream 0");
    ws.close(None).await.unwrap();
    drop(ws);

    // 4. Half-close: FIN without a close frame. The relay passes it on, HolyWisp closes, the client sees the end.
    let (mut ws, _) = gnome.wisp_at("/wisp/", &ticket, "").await;
    assert_eq!(next_frame(&mut ws).await.expect("CONTINUE").0, CONTINUE);
    ws.get_mut().shutdown().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async { while let Some(Ok(_)) = ws.next().await {} })
        .await
        .expect("the gateway closes the client side after the upstream closed");
    drop(ws);

    let mut ws_d = Value::Null;
    for _ in 0..100 {
        ws_d = gnome.diagnostics().await["ws"].clone();
        if ws_d["active"] == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eprintln!("gateway: {ws_d}");
    assert_eq!((ws_d["active"].as_i64(), ws_d["total"].as_u64()), (Some(0), Some(4)), "{ws_d}");
    assert_eq!((ws_d["clients"].as_u64(), ws_d["sessions"].as_u64()), (Some(0), Some(0)), "slots freed: {ws_d}");
    let log = gnome.stop().await;
    assert!(!log.contains(&ticket), "the ticket is never logged");
}
