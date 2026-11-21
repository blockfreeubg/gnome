//! Integration tests for `SafeClient` against local HTTP/1.1 test servers on 127.0.0.1 (kernel-assigned ephemeral
//! ports, so parallel test runs and other services on the machine never collide), plus one real HTTPS fetch (skipped
//! when `GNOME_NET_OFFLINE=1`).

use std::future::Future;
use std::io::Write as _;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gnome_net::{
    Conditional, Error, IpClass, IpPolicy, Method, Request, SafeClient, SafeClientConfig, StaticResolver, StatusCode,
    VERSION, Validators,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ---------------------------------------------------------------------------------------------------------------
// Minimal HTTP/1.1 test server
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

type BoxFut = Pin<Box<dyn Future<Output = ()> + Send>>;
type Handler = Arc<dyn Fn(Req, TcpStream) -> BoxFut + Send + Sync>;

struct Server {
    port: u16,
    /// Accepted TCP connections.
    hits: Arc<AtomicUsize>,
    /// Every parsed request.
    log: Arc<Mutex<Vec<Req>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }

    fn requests(&self) -> Vec<Req> {
        self.log.lock().unwrap().clone()
    }
}

async fn bind() -> TcpListener {
    TcpListener::bind(("127.0.0.1", 0)).await.expect("bind an ephemeral port on 127.0.0.1")
}

async fn serve<F, Fut>(handler: F) -> Server
where
    F: Fn(Req, TcpStream) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    serve_on(bind().await, handler)
}

fn serve_on<F, Fut>(listener: TcpListener, handler: F) -> Server
where
    F: Fn(Req, TcpStream) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let handler: Handler = Arc::new(move |r, s| Box::pin(handler(r, s)));
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let log = Arc::new(Mutex::new(Vec::new()));
    let (h, l) = (Arc::clone(&hits), Arc::clone(&log));
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { return };
            h.fetch_add(1, Ordering::SeqCst);
            let (handler, log) = (Arc::clone(&handler), Arc::clone(&l));
            tokio::spawn(async move {
                if let Some(req) = read_request(&mut stream).await {
                    log.lock().unwrap().push(req.clone());
                    handler(req, stream).await;
                }
            });
        }
    });
    Server { port, hits, log, task }
}

async fn read_request(stream: &mut TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_owned();
    let path = first.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned())))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(Req { method, path, headers, body })
}

async fn respond(mut stream: TcpStream, status: &str, headers: &[(&str, &str)], body: &[u8]) {
    let mut out = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    let _ = stream.write_all(out.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn redirect(stream: TcpStream, status: &str, location: &str) {
    respond(stream, status, &[("Location", location)], b"").await;
}

// ---------------------------------------------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------------------------------------------

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

/// Test names: `origin.test`/`other.test` → 127.0.0.1, plus names that resolve to refused addresses.
fn resolver() -> Arc<StaticResolver> {
    Arc::new(
        StaticResolver::new()
            .with("origin.test", [ip("127.0.0.1")])
            .with("other.test", [ip("127.0.0.1")])
            .with("private.test", [ip("10.0.0.1")])
            .with("meta.test", [ip("169.254.169.254")])
            .with("cgnat.test", [ip("100.64.0.1")])
            .with("ula.test", [ip("fd00::1")])
            .with("zero.test", [ip("0.0.0.0")])
            .with("mapped.test", [ip("::ffff:127.0.0.1")])
            .with("nat64.test", [ip("64:ff9b::a9fe:a9fe")])
            .with("mixed.test", [ip("10.0.0.1"), ip("169.254.169.254"), ip("127.0.0.1")]),
    )
}

/// A client allowed to reach the loopback test server on `port` (the redirect-origin setup).
fn loopback_client(port: u16) -> SafeClient {
    SafeClient::new(loopback_config(port)).unwrap()
}

fn loopback_config(port: u16) -> SafeClientConfig {
    SafeClientConfig::default()
        .ip_policy(IpPolicy::strict().allow_loopback(true))
        .allowed_ports([port])
        .resolver(resolver())
}

/// A production-policy client (strict IP policy) that may use the test port.
fn strict_client(port: u16) -> SafeClient {
    SafeClient::new(SafeClientConfig::default().allowed_ports([80, 443, port]).resolver(resolver())).unwrap()
}

fn get(url: String) -> Request {
    Request::get(url).allow_http(true)
}

async fn ok_server() -> Server {
    serve(|_req, s| async move { respond(s, "200 OK", &[("Content-Type", "text/plain")], b"hello").await }).await
}

fn assert_blocked(r: Result<gnome_net::Response, Error>, class: IpClass) {
    match r {
        Err(Error::Blocked { class: c, .. }) => assert_eq!(c, class),
        other => panic!("expected Blocked({class}), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Destination policy
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn sanity_loopback_allowed_with_test_flag() {
    let srv = ok_server().await;
    let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/", srv.port))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(&r.body()[..], b"hello");
    assert_eq!(srv.hits(), 1);
}

#[tokio::test]
async fn localhost_via_system_resolver_is_refused() {
    let srv = ok_server().await;
    let client = SafeClient::new(SafeClientConfig::default().allowed_ports([srv.port])).unwrap();
    let r = client.fetch(get(format!("http://localhost:{}/", srv.port))).await;
    assert_blocked(r, IpClass::Loopback);
    assert_eq!(srv.hits(), 0, "no connection may be made");
}

#[tokio::test]
async fn names_resolving_to_internal_addresses_are_refused() {
    let srv = ok_server().await;
    let client = strict_client(srv.port);
    for (name, class) in [
        ("origin.test", IpClass::Loopback),
        ("mapped.test", IpClass::Loopback),
        ("private.test", IpClass::Private),
        ("cgnat.test", IpClass::Private),
        ("ula.test", IpClass::Private),
        ("meta.test", IpClass::LinkLocal),
        ("nat64.test", IpClass::LinkLocal),
        ("zero.test", IpClass::Unspecified),
    ] {
        let started = Instant::now();
        let r = client.fetch(get(format!("http://{name}:{}/", srv.port))).await;
        assert_blocked(r, class);
        assert!(started.elapsed() < Duration::from_secs(1), "{name}: refused before any connect attempt");
    }
    assert_eq!(srv.hits(), 0);
}

#[tokio::test]
async fn ip_literals_are_refused() {
    let srv = ok_server().await;
    let client = strict_client(srv.port);
    let p = srv.port;
    for (url, class) in [
        (format!("http://127.0.0.1:{p}/"), IpClass::Loopback),
        (format!("http://127.1:{p}/"), IpClass::Loopback),
        (format!("http://2130706433:{p}/"), IpClass::Loopback),
        (format!("http://0x7f.0.0.1:{p}/"), IpClass::Loopback),
        (format!("http://[::1]:{p}/"), IpClass::Loopback),
        (format!("http://[::ffff:127.0.0.1]:{p}/"), IpClass::Loopback),
        (format!("http://[::ffff:7f00:1]:{p}/"), IpClass::Loopback),
        (format!("http://0.0.0.0:{p}/"), IpClass::Unspecified),
        (format!("http://[::]:{p}/"), IpClass::Unspecified),
        ("http://10.0.0.1/".into(), IpClass::Private),
        ("http://192.168.1.1/".into(), IpClass::Private),
        ("http://169.254.169.254/latest/meta-data/".into(), IpClass::LinkLocal),
        ("http://[fe80::1]/".into(), IpClass::LinkLocal),
        ("http://[fd00::1]/".into(), IpClass::Private),
        ("http://[64:ff9b::7f00:1]/".into(), IpClass::Loopback),
        ("http://[2002:a9fe:a9fe::]/".into(), IpClass::LinkLocal),
        ("http://224.0.0.1/".into(), IpClass::Multicast),
        ("http://255.255.255.255/".into(), IpClass::Broadcast),
        ("https://192.0.2.1/".into(), IpClass::Documentation),
        ("https://198.18.0.1/".into(), IpClass::Benchmarking),
        ("https://240.0.0.1/".into(), IpClass::Reserved),
        // Other spellings the URL parser normalises to an address (WHATWG host parsing).
        (format!("http://127.0.0.1.:{p}/"), IpClass::Loopback),
        (format!("http://0177.0.0.1:{p}/"), IpClass::Loopback),
        (format!("http://0x7f000001:{p}/"), IpClass::Loopback),
        (format!("http://017700000001:{p}/"), IpClass::Loopback),
        (format!("http://127.000.000.001:{p}/"), IpClass::Loopback),
        (format!("http://%31%32%37.0.0.1:{p}/"), IpClass::Loopback),
        (format!("http://\u{ff11}\u{ff12}\u{ff17}.0.0.1:{p}/"), IpClass::Loopback),
        (format!("http://0:{p}/"), IpClass::Unspecified),
        (format!("http://[0:0:0:0:0:ffff:127.0.0.1]:{p}/"), IpClass::Loopback),
        (format!("http://[::127.0.0.1]:{p}/"), IpClass::Loopback),
        (format!("http://[0000::0001]:{p}/"), IpClass::Loopback),
        (format!("http://[::ffff:0.0.0.0]:{p}/"), IpClass::Unspecified),
        ("http://[::ffff:a9fe:a9fe]/latest/meta-data/".into(), IpClass::LinkLocal),
        ("http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/".into(), IpClass::Loopback),
        ("http://[fd00:ec2::254]/latest/meta-data/".into(), IpClass::Private),
        ("http://100.100.100.200/latest/meta-data/".into(), IpClass::Private),
    ] {
        assert_blocked(client.fetch(get(url.clone())).await, class);
    }
    assert_eq!(srv.hits(), 0);
}

#[tokio::test]
async fn mixed_answers_use_only_allowed_addresses() {
    let srv = ok_server().await;
    let r = loopback_client(srv.port).fetch(get(format!("http://mixed.test:{}/", srv.port))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);

    // Proof that refused addresses are never dialled: `decoy.test` resolves to [0.0.0.0, 127.0.0.2]. On Linux a
    // connect to 0.0.0.0 reaches 127.0.0.1, where a decoy server listens on the same port. Without filtering the
    // connector would try 0.0.0.0 first and hit the decoy; with it, only 127.0.0.2 is dialled.
    let (real, decoy) = loop {
        let a = TcpListener::bind(("127.0.0.2", 0)).await.expect("bind an ephemeral port on 127.0.0.2");
        let port = a.local_addr().unwrap().port();
        let Ok(b) = TcpListener::bind(("127.0.0.1", port)).await else { continue };
        break (a, b);
    };
    let port = real.local_addr().unwrap().port();
    let real = serve_on(real, |_r, s| async move { respond(s, "200 OK", &[], b"real").await });
    let decoy = serve_on(decoy, |_r, s| async move { respond(s, "200 OK", &[], b"decoy").await });
    let c = SafeClient::new(
        loopback_config(port)
            .resolver(Arc::new(StaticResolver::new().with("decoy.test", [ip("0.0.0.0"), ip("127.0.0.2")]))),
    )
    .unwrap();
    let r = c.fetch(get(format!("http://decoy.test:{port}/"))).await.unwrap();
    assert_eq!(&r.body()[..], b"real");
    assert_eq!((real.hits(), decoy.hits()), (1, 0));
}

#[tokio::test]
async fn scheme_port_credentials_and_host_rules() {
    let srv = ok_server().await;
    let p = srv.port;
    let client = loopback_client(p);
    // http needs the per-request opt-in.
    let r = client.fetch(Request::get(format!("http://origin.test:{p}/"))).await;
    assert!(matches!(r, Err(Error::SchemeNotAllowed(ref s)) if s == "http"), "{r:?}");
    for url in ["ftp://origin.test/", "file:///etc/passwd", "gopher://origin.test/", "data:text/plain,x"] {
        let r = client.fetch(get(url.into())).await;
        assert!(matches!(r, Err(Error::SchemeNotAllowed(_))), "{url}: {r:?}");
    }
    // Port allowlist (default 80/443 does not include the test port).
    let default_ports = SafeClient::new(
        SafeClientConfig::default().ip_policy(IpPolicy::strict().allow_loopback(true)).resolver(resolver()),
    )
    .unwrap();
    let r = default_ports.fetch(get(format!("http://origin.test:{p}/"))).await;
    assert_eq!(r.unwrap_err(), Error::PortNotAllowed(p));
    // Credentials in the URL.
    let r = client.fetch(get(format!("http://user:pw@origin.test:{p}/"))).await;
    assert!(matches!(r, Err(Error::InvalidUrl(_))), "{r:?}");
    // Host allowlist.
    let only_origin = SafeClient::new(loopback_config(p).allowed_hosts(["origin.test"])).unwrap();
    assert!(only_origin.fetch(get(format!("http://origin.test:{p}/"))).await.is_ok());
    let r = only_origin.fetch(get(format!("http://other.test:{p}/"))).await;
    assert_eq!(r.unwrap_err(), Error::HostNotAllowed("other.test".into()));
    let wildcard = SafeClient::new(loopback_config(p).allowed_hosts(["*.test"])).unwrap();
    assert!(wildcard.fetch(get(format!("http://other.test:{p}/"))).await.is_ok());
    // Forbidden request headers.
    let r = client.fetch(get(format!("http://origin.test:{p}/")).header("Host", "evil.example")).await;
    assert!(matches!(r, Err(Error::InvalidRequest(_))), "{r:?}");
    assert_eq!(srv.hits(), 2, "only the two allowed requests may connect");
}

// ---------------------------------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------------------------------

/// Port of the test server, from the request's `Host` header.
fn host_port(req: &Req) -> String {
    req.header("host").unwrap().rsplit(':').next().unwrap().to_owned()
}

/// Origin that answers every request with `302 Found` to `template` (`{p}` = its own port).
async fn redirector(template: &str) -> Server {
    let template = template.to_owned();
    serve(move |req, s| {
        let target = template.replace("{p}", &host_port(&req));
        async move { redirect(s, "302 Found", &target).await }
    })
    .await
}

#[tokio::test]
async fn redirects_to_internal_destinations_are_refused() {
    for (target, expect) in [
        ("http://private.test:{p}/", Some(IpClass::Private)),
        ("http://meta.test:{p}/latest/meta-data/", Some(IpClass::LinkLocal)),
        ("http://cgnat.test:{p}/", Some(IpClass::Private)),
        ("http://169.254.169.254:{p}/latest/meta-data/", Some(IpClass::LinkLocal)),
        ("http://[::ffff:10.0.0.1]:{p}/", Some(IpClass::Private)),
        ("http://10.1.2.3:{p}/", Some(IpClass::Private)),
        ("http://0.0.0.0:{p}/", Some(IpClass::Unspecified)),
        ("http://[fd12::1]:{p}/", Some(IpClass::Private)),
        ("file:///etc/passwd", None),
    ] {
        let srv = redirector(target).await;
        let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/start", srv.port))).await;
        match expect {
            Some(class) => assert_blocked(r, class),
            None => assert!(matches!(r, Err(Error::SchemeNotAllowed(ref s)) if s == "file"), "{r:?}"),
        }
        assert_eq!(srv.hits(), 1, "{target}: only the origin hop may connect");
    }
}

#[tokio::test]
async fn redirect_to_disallowed_port_or_host_is_refused() {
    let srv = redirector("http://origin.test:1/").await;
    let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/", srv.port))).await;
    assert_eq!(r.unwrap_err(), Error::PortNotAllowed(1));

    let srv = redirector("http://other.test:{p}/").await;
    let client = SafeClient::new(loopback_config(srv.port).allowed_hosts(["origin.test"])).unwrap();
    let r = client.fetch(get(format!("http://origin.test:{}/", srv.port))).await;
    assert_eq!(r.unwrap_err(), Error::HostNotAllowed("other.test".into()));
    assert_eq!(srv.hits(), 1);
}

#[tokio::test]
async fn redirect_chain_is_followed_and_revalidated() {
    let srv = serve(|req, s| async move {
        let port = host_port(&req);
        match req.path.as_str() {
            "/a" => redirect(s, "301 Moved Permanently", "/b").await,
            "/b" => redirect(s, "302 Found", "c").await,
            "/c" => redirect(s, "307 Temporary Redirect", &format!("http://other.test:{port}/d")).await,
            "/d" => respond(s, "200 OK", &[], b"done").await,
            _ => respond(s, "404 Not Found", &[], b"").await,
        }
    })
    .await;
    let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/a", srv.port))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(&r.body()[..], b"done");
    assert_eq!(r.redirects(), 3);
    assert_eq!(r.url().as_str(), format!("http://other.test:{}/d", srv.port));
    assert_eq!(srv.hits(), 4);
}

#[tokio::test]
async fn too_many_redirects() {
    let srv = serve(|_req, s| async move { redirect(s, "302 Found", "/loop").await }).await;
    let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/loop", srv.port))).await;
    assert_eq!(r.unwrap_err(), Error::TooManyRedirects(5));
    assert_eq!(srv.hits(), 6, "the original request plus 5 redirects");

    // max_redirects(0): the 3xx comes back as a response.
    let c = SafeClient::new(loopback_config(srv.port).max_redirects(0)).unwrap();
    let r = c.fetch(get(format!("http://origin.test:{}/loop", srv.port))).await.unwrap();
    assert_eq!(r.status(), StatusCode::FOUND);
    assert_eq!(r.header("location"), Some("/loop"));
}

#[tokio::test]
async fn redirect_method_and_credential_rules() {
    let srv = serve(|req, s| async move {
        let port = host_port(&req);
        match req.path.as_str() {
            "/see-other" => redirect(s, "303 See Other", "/landing").await,
            "/temp" => redirect(s, "307 Temporary Redirect", "/landing").await,
            "/same" => redirect(s, "302 Found", "/landing").await,
            "/cross" => redirect(s, "302 Found", &format!("http://other.test:{port}/landing")).await,
            _ => respond(s, "200 OK", &[], b"ok").await,
        }
    })
    .await;
    let p = srv.port;
    let c = loopback_client(p);
    let base = format!("http://origin.test:{p}");

    c.fetch(
        Request::post(format!("{base}/see-other"), "payload").allow_http(true).header("Content-Type", "text/plain"),
    )
    .await
    .unwrap();
    c.fetch(Request::post(format!("{base}/temp"), "payload").allow_http(true)).await.unwrap();
    c.fetch(get(format!("{base}/same")).header("Authorization", "Bearer secret").header("Cookie", "a=b"))
        .await
        .unwrap();
    c.fetch(get(format!("{base}/cross")).header("Authorization", "Bearer secret").header("Cookie", "a=b"))
        .await
        .unwrap();

    let log = srv.requests();
    let landing: Vec<&Req> = log.iter().filter(|r| r.path == "/landing").collect();
    assert_eq!(landing.len(), 4);
    // 303 after POST → GET without body or Content-Type.
    assert_eq!(landing[0].method, "GET");
    assert!(landing[0].body.is_empty());
    assert_eq!(landing[0].header("content-type"), None);
    // 307 keeps method and body.
    assert_eq!(landing[1].method, "POST");
    assert_eq!(landing[1].body, b"payload");
    // Same-origin keeps credentials; cross-origin drops them.
    assert_eq!(landing[2].header("authorization"), Some("Bearer secret"));
    assert_eq!(landing[2].header("cookie"), Some("a=b"));
    assert_eq!(landing[3].header("authorization"), None);
    assert_eq!(landing[3].header("cookie"), None);
    assert_eq!(landing[3].header("host"), Some(format!("other.test:{p}").as_str()));
}

// ---------------------------------------------------------------------------------------------------------------
// Body limits and decoding
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn declared_oversize_body_is_refused_early() {
    let srv = serve(|_req, mut s| async move {
        let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 104857600\r\n\r\n").await;
        let _ = s.write_all(&[b'x'; 1024]).await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    })
    .await;
    let started = Instant::now();
    let r =
        loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/", srv.port)).max_body_bytes(1 << 20)).await;
    assert_eq!(r.unwrap_err(), Error::BodyTooLarge { limit: 1 << 20 });
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn streaming_body_limit_aborts_mid_stream() {
    const TOTAL: u64 = 256 << 20; // what the server would send if never stopped
    let sent = Arc::new(AtomicU64::new(0));
    let done = Arc::new(tokio::sync::Notify::new());
    let (sent2, done2) = (Arc::clone(&sent), Arc::clone(&done));
    let srv = serve(move |_req, mut s| {
        let (sent, done) = (Arc::clone(&sent2), Arc::clone(&done2));
        async move {
            // Chunked, no Content-Length: the client cannot know the size up front.
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").await;
            let chunk = vec![b'a'; 64 * 1024];
            let framed = [format!("{:x}\r\n", chunk.len()).into_bytes(), chunk, b"\r\n".to_vec()].concat();
            while sent.load(Ordering::SeqCst) < TOTAL {
                if s.write_all(&framed).await.is_err() {
                    break;
                }
                sent.fetch_add(64 * 1024, Ordering::SeqCst);
            }
            done.notify_one();
        }
    })
    .await;
    let r =
        loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/", srv.port)).max_body_bytes(1 << 20)).await;
    assert_eq!(r.unwrap_err(), Error::BodyTooLarge { limit: 1 << 20 });
    // The client dropped the connection: the server's writes fail long before TOTAL.
    tokio::time::timeout(Duration::from_secs(10), done.notified()).await.expect("server write loop should stop");
    let n = sent.load(Ordering::SeqCst);
    assert!(n < 64 << 20, "server managed to send {n} bytes; the client kept reading");
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn brotli(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut w = brotli::CompressorWriter::new(&mut out, 4096, 9, 22);
        w.write_all(data).unwrap();
    }
    out
}

#[tokio::test]
async fn gzip_and_brotli_are_decoded_and_bombs_stopped() {
    let text: Vec<u8> = b"||ads.example^\n".repeat(1000);
    let bomb = Arc::new(gzip(&vec![0u8; 64 << 20]));
    let br_bomb = Arc::new(brotli(&vec![0u8; 64 << 20]));
    let (gz, br) = (Arc::new(gzip(&text)), Arc::new(brotli(&text)));
    let srv = serve(move |req, s| {
        let (gz, br, bomb, br_bomb) = (Arc::clone(&gz), Arc::clone(&br), Arc::clone(&bomb), Arc::clone(&br_bomb));
        async move {
            let ae = req.header("accept-encoding").unwrap_or_default().to_owned();
            match req.path.as_str() {
                "/gz" => respond(s, "200 OK", &[("Content-Encoding", "gzip"), ("X-AE", &ae)], &gz).await,
                "/br" => respond(s, "200 OK", &[("Content-Encoding", "br")], &br).await,
                "/br-bomb" => respond(s, "200 OK", &[("Content-Encoding", "br")], &br_bomb).await,
                _ => respond(s, "200 OK", &[("Content-Encoding", "gzip")], &bomb).await,
            }
        }
    })
    .await;
    let c = loopback_client(srv.port);
    let base = format!("http://origin.test:{}", srv.port);

    let r = c.fetch(get(format!("{base}/gz"))).await.unwrap();
    assert_eq!(&r.body()[..], &text[..]);
    assert!(r.header("x-ae").unwrap().contains("gzip") && r.header("x-ae").unwrap().contains("br"));
    assert_eq!(r.header("content-encoding"), None);

    let r = c.fetch(get(format!("{base}/br"))).await.unwrap();
    assert_eq!(&r.body()[..], &text[..]);

    for bomb in ["/bomb", "/br-bomb"] {
        let started = Instant::now();
        let r = c.fetch(get(format!("{base}{bomb}")).max_body_bytes(1 << 20)).await;
        assert_eq!(r.unwrap_err(), Error::BodyTooLarge { limit: 1 << 20 }, "{bomb}");
        assert!(started.elapsed() < Duration::from_secs(5), "{bomb}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn total_timeout_covers_headers_and_body() {
    let srv = serve(|req, mut s| async move {
        if req.path == "/slow-body" {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nonly-a-bit").await;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    })
    .await;
    let c = loopback_client(srv.port);
    for path in ["/no-response", "/slow-body"] {
        let started = Instant::now();
        let r =
            c.fetch(get(format!("http://origin.test:{}{path}", srv.port)).timeout(Duration::from_millis(400))).await;
        assert_eq!(r.unwrap_err(), Error::Timeout, "{path}");
        let el = started.elapsed();
        assert!(el >= Duration::from_millis(350) && el < Duration::from_secs(3), "{path}: {el:?}");
    }
    // The client-wide default applies when the request sets none.
    let c = SafeClient::new(loopback_config(srv.port).timeout(Duration::from_millis(300))).unwrap();
    assert_eq!(c.fetch(get(format!("http://origin.test:{}/x", srv.port))).await.unwrap_err(), Error::Timeout);
}

/// A listener that never accepts and whose accept queue is full: Linux drops further SYNs, so a connect attempt hangs
/// (as with a firewall that drops packets) until the connect timeout, well inside the total budget.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn connect_timeout_applies_to_a_silent_destination() {
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let listener = socket.listen(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut queued = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(("127.0.0.1", port))).await {
            Ok(Ok(s)) if queued.len() < 8 => queued.push(s),
            Ok(Ok(_)) => panic!("the accept queue never filled up"),
            Ok(Err(e)) => panic!("connect failed: {e}"),
            Err(_) => break, // queue full: this SYN was dropped
        }
    }
    let c = SafeClient::new(loopback_config(port).connect_timeout(Duration::from_millis(400))).unwrap();
    let started = Instant::now();
    let r = c.fetch(get(format!("http://origin.test:{port}/")).timeout(Duration::from_secs(20))).await;
    let el = started.elapsed();
    assert_eq!(r.unwrap_err(), Error::Timeout);
    assert!(el >= Duration::from_millis(350) && el < Duration::from_secs(5), "{el:?}");
    drop((queued, listener));
}

// ---------------------------------------------------------------------------------------------------------------
// Conditional GET and headers
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn conditional_get_304() {
    const ETAG: &str = "\"sha256-abc\"";
    const LM: &str = "Wed, 11 Nov 2026 10:00:00 GMT";
    let srv = serve(|req, s| async move {
        let inm = req.header("if-none-match") == Some(ETAG);
        let ims = req.header("if-modified-since") == Some(LM);
        match req.path.as_str() {
            "/etag" if inm => respond(s, "304 Not Modified", &[("ETag", ETAG)], b"").await,
            "/etag" => respond(s, "200 OK", &[("ETag", ETAG), ("Last-Modified", LM)], b"list v1").await,
            "/lm" if ims => respond(s, "304 Not Modified", &[], b"").await,
            "/lm" => respond(s, "200 OK", &[("Last-Modified", LM)], b"list v1").await,
            _ => respond(s, "404 Not Found", &[], b"").await,
        }
    })
    .await;
    let c = loopback_client(srv.port);
    let base = format!("http://origin.test:{}", srv.port);

    let first = c.fetch_conditional(get(format!("{base}/etag")), &Validators::default()).await.unwrap();
    let Conditional::Modified { response, validators } = first else { panic!("expected 200") };
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(&response.body()[..], b"list v1");
    assert_eq!(validators, Validators { etag: Some(ETAG.into()), last_modified: Some(LM.into()) });

    let second = c.fetch_conditional(get(format!("{base}/etag")), &validators).await.unwrap();
    let Conditional::NotModified { validators: v2 } = second else { panic!("expected 304") };
    assert_eq!(v2, validators);

    // Last-Modified only.
    let cached = Validators { etag: None, last_modified: Some(LM.into()) };
    let r = c.fetch_conditional(get(format!("{base}/lm")), &cached).await.unwrap();
    assert!(matches!(r, Conditional::NotModified { validators } if validators == cached));

    // The raw API reports 304 as a normal response.
    let r = c.fetch(get(format!("{base}/etag")).conditional(&validators)).await.unwrap();
    assert!(r.is_not_modified());
    assert!(r.body().is_empty());

    let log = srv.requests();
    assert_eq!(log[1].header("if-none-match"), Some(ETAG));
    assert_eq!(log[1].header("if-modified-since"), Some(LM));
    assert_eq!(log[0].header("if-none-match"), None);
}

#[tokio::test]
async fn user_agent_and_custom_headers() {
    let srv = serve(|req, s| async move {
        let ua = req.header("user-agent").unwrap_or_default().to_owned();
        respond(s, "200 OK", &[], ua.as_bytes()).await
    })
    .await;
    let url = format!("http://origin.test:{}/", srv.port);
    let r = loopback_client(srv.port).fetch(get(url.clone())).await.unwrap();
    assert_eq!(&r.body()[..], format!("GNOME/{VERSION}").as_bytes());

    let c = SafeClient::new(loopback_config(srv.port).source_url("https://git.example/gnome")).unwrap();
    let r = c.fetch(get(url.clone())).await.unwrap();
    assert_eq!(&r.body()[..], format!("GNOME/{VERSION} (+https://git.example/gnome)").as_bytes());

    let r = c.fetch(get(url).header("User-Agent", "GNOME-catalog/1")).await.unwrap();
    assert_eq!(&r.body()[..], b"GNOME-catalog/1");

    let r = c.fetch(Request::new(Method::HEAD, format!("http://origin.test:{}/", srv.port)).allow_http(true)).await;
    assert_eq!(r.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn http_error_statuses_are_responses() {
    let srv =
        serve(|_req, s| async move { respond(s, "503 Service Unavailable", &[("Retry-After", "7")], b"busy").await })
            .await;
    let r = loopback_client(srv.port).fetch(get(format!("http://origin.test:{}/", srv.port))).await.unwrap();
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.header("retry-after"), Some("7"));
    assert!(r.header_pairs().iter().any(|(k, v)| k == "retry-after" && v == "7"));
}

#[tokio::test]
async fn connection_refused_is_a_retryable_network_error() {
    // Bind and drop to get a port in our range with nothing listening.
    let port = bind().await.local_addr().unwrap().port();
    let r = loopback_client(port).fetch(get(format!("http://origin.test:{port}/"))).await;
    let e = r.unwrap_err();
    assert!(matches!(e, Error::Network(_)), "{e:?}");
    assert!(e.is_retryable() && !e.is_policy());
}

// ---------------------------------------------------------------------------------------------------------------
// Real TLS
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn real_https_fetch() {
    if std::env::var_os("GNOME_NET_OFFLINE").is_some() {
        eprintln!("GNOME_NET_OFFLINE set; skipping real HTTPS fetch");
        return;
    }
    let client = SafeClient::new(SafeClientConfig::default()).unwrap();
    let r = client.fetch(Request::get("https://example.com/").timeout(Duration::from_secs(20))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert!(String::from_utf8_lossy(r.body()).contains("Example Domain"));
    // Plain http to the same public host works with the opt-in.
    let r = client.fetch(Request::get("http://example.com/").allow_http(true)).await.unwrap();
    assert!(r.status().is_success() || r.status().is_redirection());
}
