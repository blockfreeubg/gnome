//! Listeners, connection handling and graceful shutdown.
//!
//! Listeners: public (`GNOME_BIND`, role per request host), proxy (`GNOME_PROXY_BIND`, always the proxy role,
//! optional) and admin (`GNOME_ADMIN_BIND`). Each runs an accept loop that serves HTTP/1.1 connections with hyper
//! (header-read timeout against slowloris, keep-alive, upgrades enabled for the Wisp gateway; TCP keepalive on
//! public sockets so dead peers of long-lived WebSockets are noticed). The connection IO is [`ConnIo`] (the
//! `tokio::net::TcpStream` plus a write-stall timeout against clients that stop reading), so an upgrade handler
//! recovers the raw socket with `hyper::upgrade::Upgraded::downcast::<TokioIo<ConnIo>>()` and
//! `parts.io.into_inner().into_inner()` (e.g. for `splice(2)`).
//!
//! Shutdown (SIGINT/SIGTERM, or `state.shutdown` cancelled): stop accepting, ask every connection to finish its
//! current request, cancel jobs, then wait up to [`SHUTDOWN_GRACE`] for connections and `state.tasks`
//! (WebSocket splices) before checkpointing the database. A second SIGINT or SIGTERM exits immediately.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Router;
use axum::extract::ConnectInfo;
use hyper::body::Incoming;
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tower::ServiceExt as _;

use crate::limits::{Admission, ConnHold};
use crate::router;
use crate::state::{AppState, StartupError};

/// How long in-flight requests and WebSocket splices get after shutdown starts.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
/// Time a client has to send a complete request head (also bounds idle keep-alive connections).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Per-connection read buffer caps ([`crate::limits::max_head_for`]). hyper may read one more chunk before it checks,
/// so request heads beyond about twice the cap are refused with `431`.
const MAX_BUF: usize = crate::limits::SMALL_HEAD;
const MAX_BUF_LARGE: usize = crate::limits::LARGE_HEAD;
/// How long an overflow answer waits for the client's request bytes before the socket closes (so the close does
/// not reset the connection before the client reads the `503`).
const OVERFLOW_LINGER: Duration = Duration::from_secs(1);
/// How long writing a response may make no progress (the client stopped reading and its receive window stays full)
/// before the connection is closed. Without it such a client would hold a connection and its file forever.
pub const WRITE_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Headers added to hyper's own error answers ([`ConnIo`]): nothing in such a document may run, load or be framed
/// (the policy is `csp::NOTHING_RUNS_UNFRAMED`; a unit test keeps the two equal).
pub const AUTOMATIC_ANSWER_HEADERS: &str = "cache-control: no-store\r\nx-content-type-options: nosniff\r\n\
     referrer-policy: no-referrer\r\ncontent-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; \
     frame-ancestors 'none'\r\n";

/// Status lines of the answers hyper writes by itself, without calling the service, for request heads it cannot
/// parse: `400` (malformed), `414` (a request target of 64 KiB or more), `431` (a head larger than the read buffer).
const AUTOMATIC_STATUS_LINES: [&[u8]; 3] = [
    b"HTTP/1.1 400 Bad Request\r\n",
    b"HTTP/1.1 414 URI Too Long\r\n",
    b"HTTP/1.1 431 Request Header Fields Too Large\r\n",
];

/// Upper bound of an automatic answer's length: the 431 status line (46 bytes), `connection: close` and
/// `content-length: 0` (19 each), a `date` (37) and the blank line, with room to spare.
const AUTOMATIC_ANSWER_MAX: usize = 192;

/// Where hyper's automatic error answer starts in `bytes`, when `bytes` ends with one: one of the
/// [`AUTOMATIC_STATUS_LINES`], then only `connection: close`, `content-length: 0` and `date` lines, then the blank
/// line. Every answer of the service carries more headers (the security-headers middleware's at least), so none of
/// them matches; nor does a body, unless its last bytes are exactly such an answer.
fn automatic_answer_start(bytes: &[u8]) -> Option<usize> {
    if !bytes.ends_with(b"\r\n\r\n") {
        return None;
    }
    let from = bytes.len().saturating_sub(AUTOMATIC_ANSWER_MAX);
    let at = from + bytes[from..].windows(9).rposition(|w| w == b"HTTP/1.1 ")?;
    let head = &bytes[at..];
    let status = AUTOMATIC_STATUS_LINES.iter().find(|s| head.starts_with(s))?;
    let fields = std::str::from_utf8(&head[status.len()..head.len() - 2]).ok()?;
    let mut empty_body = false;
    for line in fields.split_terminator("\r\n") {
        let (name, value) = line.split_once(": ")?;
        match name.to_ascii_lowercase().as_str() {
            "connection" if value.eq_ignore_ascii_case("close") => {}
            "content-length" if value == "0" => empty_body = true,
            "date" if value.ends_with(" GMT") => {}
            _ => return None,
        }
    }
    empty_body.then_some(at)
}

/// hyper's automatic `head` with [`AUTOMATIC_ANSWER_HEADERS`] added before its blank line.
fn hardened_answer(head: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(head.len() + AUTOMATIC_ANSWER_HEADERS.len());
    out.extend_from_slice(&head[..head.len() - 2]);
    out.extend_from_slice(AUTOMATIC_ANSWER_HEADERS.as_bytes());
    out.extend_from_slice(b"\r\n");
    out
}

/// Connection IO handed to hyper: the stream plus a write-stall timeout ([`WRITE_STALL_TIMEOUT`] on the listeners).
/// The timer runs only while a write is blocked, so idle keep-alive and long-lived upgraded connections that are
/// not sending are unaffected. Upgrade handlers can take the raw stream back with [`ConnIo::into_inner`].
///
/// **No permissive realm from hyper's own answers.** A request head hyper cannot parse (a request target of 64 KiB
/// or more, a head over the read buffer, e.g. after a page planted a "cookie bomb") never reaches the service: hyper
/// answers `414`/`431`/`400` itself, with only `connection`, `content-length` and `date`, so none of the security
/// headers. Chromium commits such an empty answer in a frame as a same-origin document without a policy, so escaped
/// proxied code that loads `<proxy origin>/x?<140 KB>` in a hidden frame could use that realm's `fetch`, `WebSocket`
/// or `Image` to reach any host directly (seen with the release build; Firefox shows an opaque error page). The
/// answer is always the last thing hyper writes on the connection, so `ConnIo` recognizes it at the end of a write
/// ([`automatic_answer_start`]) and sends it with [`AUTOMATIC_ANSWER_HEADERS`] (`default-src 'none'`,
/// `frame-ancestors 'none'`: no browser renders it in a frame) instead, reporting hyper's byte count back.
#[derive(Debug)]
pub struct ConnIo<S = TcpStream> {
    inner: S,
    stall_timeout: Duration,
    stalled: Option<Pin<Box<tokio::time::Sleep>>>,
    /// The hardened automatic answer being written: its bytes, how many are written, and how many of hyper's bytes
    /// they stand for.
    hardening: Option<(Vec<u8>, usize, usize)>,
}

impl<S> ConnIo<S> {
    pub fn new(inner: S, stall_timeout: Duration) -> Self {
        Self { inner, stall_timeout, stalled: None, hardening: None }
    }

    pub fn get_ref(&self) -> &S {
        &self.inner
    }

    pub fn into_inner(self) -> S {
        self.inner
    }

    /// Pass a write result through, arming the stall timer while the write is blocked.
    fn track<T>(&mut self, cx: &mut Context<'_>, result: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        if result.is_ready() {
            self.stalled = None;
            return result;
        }
        let timeout = self.stall_timeout;
        let timer = self.stalled.get_or_insert_with(|| Box::pin(tokio::time::sleep(timeout)));
        if timer.as_mut().poll(cx).is_ready() {
            self.stalled = None;
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::TimedOut, "the client stopped reading")));
        }
        Poll::Pending
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for ConnIo<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> ConnIo<S> {
    /// One write of hyper's `bufs`, with its automatic error answer (if the write ends with one) replaced by the
    /// hardened one ([`ConnIo`]); `vectored`: how hyper called.
    fn write_hardened(
        &mut self,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
        vectored: bool,
    ) -> Poll<io::Result<usize>> {
        if self.hardening.is_none()
            && let Some(last) = bufs.iter().rposition(|b| !b.is_empty())
            && let Some(at) = automatic_answer_start(&bufs[last])
        {
            if bufs[..last].iter().any(|b| !b.is_empty()) || at > 0 {
                // First what comes before it (the end of an earlier answer on this connection), unchanged.
                let mut before: Vec<io::IoSlice<'_>> = bufs[..last].to_vec();
                before.push(io::IoSlice::new(&bufs[last][..at]));
                return Pin::new(&mut self.inner).poll_write_vectored(cx, &before);
            }
            self.hardening = Some((hardened_answer(&bufs[last]), 0, bufs[last].len()));
        }
        if let Some((bytes, written, stands_for)) = &mut self.hardening {
            while *written < bytes.len() {
                match Pin::new(&mut self.inner).poll_write(cx, &bytes[*written..]) {
                    Poll::Ready(Ok(0)) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
                    Poll::Ready(Ok(n)) => *written += n,
                    Poll::Ready(Err(e)) => return Poll::Ready(Err(e)),
                    Poll::Pending => return Poll::Pending,
                }
            }
            // hyper offers the same bytes again after a pending write; never report more than this call offered.
            let n = (*stands_for).min(bufs.iter().map(|b| b.len()).sum());
            self.hardening = None;
            return Poll::Ready(Ok(n));
        }
        if vectored {
            Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
        } else {
            Pin::new(&mut self.inner).poll_write(cx, bufs.first().map_or(&[][..], |b| &b[..]))
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for ConnIo<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = this.write_hardened(cx, &[io::IoSlice::new(buf)], false);
        this.track(cx, result)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let result = this.write_hardened(cx, bufs, true);
        this.track(cx, result)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_flush(cx) {
            // A completed flush is no sign that the client read anything (a TCP flush always completes), so it
            // must not reset a stall that blocked writes have started.
            Poll::Ready(result) => Poll::Ready(result),
            Poll::Pending => this.track(cx, Poll::Pending),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// The file-descriptor limit (`RLIMIT_NOFILE`): every connection costs a descriptor, a spliced Wisp connection about
/// six (client and upstream sockets plus two pipes), so the inherited soft limit (often 1024) would end at about 150
/// concurrent Wisp connections. [`raise`](fd_limit::raise) lifts the soft limit to the hard limit at startup.
pub mod fd_limit {
    use std::sync::OnceLock;

    use serde::Serialize;

    /// The soft limit is never raised above this (Linux's default `fs.nr_open`; an unlimited hard limit is common
    /// on other systems, and a descriptor table that large only wastes memory).
    pub const CAP: u64 = 1 << 20;
    /// Below this the server warns that the limit bounds concurrent connections.
    pub const LOW: u64 = 4096;

    /// `RLIMIT_NOFILE` before and after startup raised it. `None` = unlimited (`RLIM_INFINITY`).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    pub struct Report {
        pub before_soft: Option<u64>,
        pub before_hard: Option<u64>,
        pub soft: Option<u64>,
        pub hard: Option<u64>,
        /// Whether the soft limit was changed.
        pub raised: bool,
        /// Why raising failed or was impossible; the server keeps running with the old limit.
        pub error: Option<String>,
    }

    static STARTUP: OnceLock<Report> = OnceLock::new();

    /// The soft limit to set for `(soft, hard)`, or `None` to keep it: the hard limit capped at [`CAP`], never
    /// lowering the current soft limit.
    pub fn target(soft: Option<u64>, hard: Option<u64>) -> Option<u64> {
        let ceiling = hard.map_or(CAP, |h| h.min(CAP));
        match soft {
            Some(s) if s < ceiling => Some(ceiling),
            _ => None,
        }
    }

    /// [`raise`] with injectable syscalls: `get` returns `(soft, hard)`, `set(soft, hard)` applies a new soft limit
    /// with the hard limit unchanged.
    pub fn raise_with(
        get: impl Fn() -> (Option<u64>, Option<u64>),
        set: impl Fn(u64, Option<u64>) -> std::io::Result<()>,
    ) -> Report {
        let (before_soft, before_hard) = get();
        let mut report =
            Report { before_soft, before_hard, soft: before_soft, hard: before_hard, raised: false, error: None };
        if let Some(want) = target(before_soft, before_hard) {
            match set(want, before_hard) {
                Ok(()) => {
                    let (soft, hard) = get();
                    report.soft = soft;
                    report.hard = hard;
                    report.raised = soft != before_soft;
                }
                Err(e) => report.error = Some(format!("setrlimit(RLIMIT_NOFILE, {want}) failed: {e}")),
            }
        }
        report
    }

    #[cfg(target_os = "linux")]
    fn get() -> (Option<u64>, Option<u64>) {
        let l = rustix::process::getrlimit(rustix::process::Resource::Nofile);
        (l.current, l.maximum)
    }

    #[cfg(target_os = "linux")]
    fn set(soft: u64, hard: Option<u64>) -> std::io::Result<()> {
        let limit = rustix::process::Rlimit { current: Some(soft), maximum: hard };
        rustix::process::setrlimit(rustix::process::Resource::Nofile, limit).map_err(std::io::Error::from)
    }

    /// The current `(soft, hard)` limits, `None` where unknown on this platform.
    pub fn current() -> Option<(Option<u64>, Option<u64>)> {
        #[cfg(target_os = "linux")]
        return Some(get());
        #[cfg(not(target_os = "linux"))]
        None
    }

    /// Descriptors this process has open (Linux: entries of `/proc/self/fd`, minus the one reading it).
    pub fn open_count() -> Option<u64> {
        let n = std::fs::read_dir("/proc/self/fd").ok()?.count();
        u64::try_from(n.saturating_sub(1)).ok()
    }

    /// Raise the soft limit to the hard limit (capped at [`CAP`]) and log the outcome once. Failure is a warning,
    /// never fatal. Only the first call's report is kept for [`startup`].
    pub fn raise() -> &'static Report {
        #[cfg(target_os = "linux")]
        let report = raise_with(get, set);
        #[cfg(not(target_os = "linux"))]
        let report = Report {
            before_soft: None,
            before_hard: None,
            soft: None,
            hard: None,
            raised: false,
            error: Some("not supported on this platform".into()),
        };
        let fmt = |v: Option<u64>| v.map_or_else(|| "unlimited".to_string(), |n| n.to_string());
        let (before, soft, hard) = (fmt(report.before_soft), fmt(report.soft), fmt(report.hard));
        match &report.error {
            Some(e) => {
                tracing::warn!(soft = %before, hard = %hard, error = %e, "cannot raise the file descriptor limit; keeping it")
            }
            None if report.raised => {
                tracing::info!(before = %before, after = %soft, hard = %hard, "file descriptor limit raised")
            }
            None => {
                tracing::info!(soft = %soft, hard = %hard, "file descriptor limit unchanged (already at the hard limit)")
            }
        }
        if report.soft.is_some_and(|s| s < LOW) {
            tracing::warn!(
                soft = %soft,
                "the file descriptor limit allows only about {} concurrent Wisp connections; raise the hard limit \
                 (systemd LimitNOFILE=, docker --ulimit nofile=, ulimit -Hn)",
                report.soft.unwrap_or(0) / 6
            );
        }
        STARTUP.get_or_init(|| report)
    }

    /// What [`raise`] did at startup (`None` when it never ran, e.g. in tests that build the server in-process).
    pub fn startup() -> Option<&'static Report> {
        STARTUP.get()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::Cell;

        #[test]
        fn target_soft_limits() {
            // The usual case: soft 1024 below a larger hard limit.
            assert_eq!(target(Some(1024), Some(524_288)), Some(524_288));
            // Already at the hard limit (hard == soft): nothing to do.
            assert_eq!(target(Some(1024), Some(1024)), None);
            assert_eq!(target(Some(524_288), Some(524_288)), None);
            // Huge or unlimited hard limits are capped.
            assert_eq!(target(Some(1024), Some(1 << 40)), Some(CAP));
            assert_eq!(target(Some(1024), None), Some(CAP));
            assert_eq!(target(Some(CAP), None), None);
            // Never lowered.
            assert_eq!(target(None, None), None);
            assert_eq!(target(Some(2 * CAP), None), None);
            assert_eq!(target(Some(5000), Some(4000)), None);
        }

        #[test]
        fn raise_with_reports_before_and_after() {
            let limit = Cell::new((Some(1024u64), Some(8192u64)));
            let r = raise_with(
                || limit.get(),
                |soft, hard| {
                    assert_eq!(hard, Some(8192), "the hard limit is passed through unchanged");
                    limit.set((Some(soft), hard));
                    Ok(())
                },
            );
            assert_eq!(
                r,
                Report {
                    before_soft: Some(1024),
                    before_hard: Some(8192),
                    soft: Some(8192),
                    hard: Some(8192),
                    raised: true,
                    error: None,
                }
            );
            // Second run (hard == soft): no syscall, nothing raised.
            let r = raise_with(|| limit.get(), |_, _| panic!("no setrlimit when soft == hard"));
            assert_eq!((r.soft, r.raised, r.error), (Some(8192), false, None));
        }

        #[test]
        fn a_failed_raise_is_reported_and_keeps_the_limit() {
            let r = raise_with(
                || (Some(1024), None),
                |_, _| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            );
            assert_eq!((r.before_soft, r.soft, r.hard, r.raised), (Some(1024), Some(1024), None, false));
            assert!(r.error.as_deref().unwrap().contains("1048576"), "{:?}", r.error);
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn the_real_limit_ends_at_the_capped_hard_limit() {
            // Changes only this test process's own soft limit (never the hard limit, never kernel state).
            let r = raise_with(get, set);
            assert!(r.error.is_none(), "{r:?}");
            let (soft, hard) = get();
            assert_eq!(soft, r.soft);
            assert_eq!(hard, r.before_hard, "the hard limit is unchanged");
            // Either raised to the capped hard limit, or already at (or above) it and left alone.
            let expected = target(r.before_soft, r.before_hard).or(r.before_soft);
            assert_eq!(soft, expected, "{r:?}");
            assert_eq!(target(soft, hard), None, "nothing left to raise");
            assert!(open_count().is_some_and(|n| n >= 3), "stdio at least");
        }
    }
}

/// The three listeners.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    Public,
    Proxy,
    Admin,
}

/// Already-bound listeners for [`serve_all`].
#[derive(Debug)]
pub struct Listeners {
    pub public: TcpListener,
    /// Always the proxy role (`GNOME_PROXY_BIND`).
    pub proxy: Option<TcpListener>,
    pub admin: Option<TcpListener>,
}

async fn bind(addr: SocketAddr, what: &str) -> Result<TcpListener, StartupError> {
    TcpListener::bind(addr).await.map_err(|e| StartupError(format!("cannot listen on {addr} ({what} listener): {e}")))
}

/// Bind the configured listeners and serve until SIGINT/SIGTERM.
pub async fn run(state: AppState) -> Result<(), StartupError> {
    let public = bind(state.config.bind, "public").await?;
    let proxy = match state.config.proxy_bind {
        Some(addr) => Some(bind(addr, "proxy").await?),
        None => None,
    };
    let admin = match state.config.admin_bind {
        Some(addr) => Some(bind(addr, "admin").await?),
        None => None,
    };
    let token = state.shutdown.clone();
    serve_all(state, Listeners { public, proxy, admin }, shutdown_signal(token)).await;
    Ok(())
}

/// Serve on already-bound public and admin listeners until `shutdown` resolves (or `state.shutdown` is cancelled).
pub async fn serve(
    state: AppState,
    public: TcpListener,
    admin: Option<TcpListener>,
    shutdown: impl Future<Output = ()>,
) {
    serve_all(state, Listeners { public, proxy: None, admin }, shutdown).await;
}

/// Serve on already-bound listeners until `shutdown` resolves (or `state.shutdown` is cancelled).
pub async fn serve_all(state: AppState, listeners: Listeners, shutdown: impl Future<Output = ()>) {
    let Listeners { public, proxy, admin } = listeners;
    let public_router = router::public(&state);
    let admin_router = router::admin(&state);
    state.prepare_modules().await;
    state.start_jobs();
    let conns = TaskTracker::new();
    let p = &state.config.proxy;
    if let Ok(addr) = public.local_addr() {
        match p.origin() {
            Some(origin) => {
                tracing::info!(%addr, version = crate::VERSION, proxy_origin = origin, "public listener ready")
            }
            None => tracing::info!(%addr, version = crate::VERSION, "public listener ready (single-origin mode)"),
        }
    }
    if !p.isolated() {
        tracing::warn!("proxy isolation is off: {}", crate::api::meta::SINGLE_ORIGIN_EXPLANATION);
    }
    let mut loops =
        vec![tokio::spawn(accept_loop(public, public_router, state.clone(), conns.clone(), Listener::Public))];
    if let Some(proxy) = proxy {
        if let Ok(addr) = proxy.local_addr() {
            tracing::info!(%addr, proxy_origin = p.origin().unwrap_or("-"), "proxy listener ready");
        }
        let proxy_router = router::proxy(&state);
        loops.push(tokio::spawn(accept_loop(proxy, proxy_router, state.clone(), conns.clone(), Listener::Proxy)));
    }
    if let Some(admin) = admin {
        if let Ok(addr) = admin.local_addr() {
            tracing::info!(%addr, token = state.config.admin_token.is_some(), "admin listener ready");
        }
        loops.push(tokio::spawn(accept_loop(admin, admin_router, state.clone(), conns.clone(), Listener::Admin)));
    } else {
        tracing::info!("admin listener disabled");
    }

    tokio::select! {
        () = shutdown => {}
        () = state.shutdown.cancelled() => {}
    }
    tracing::info!("shutting down: draining connections (grace {}s)", SHUTDOWN_GRACE.as_secs());
    state.shutdown.cancel();
    for l in loops {
        let _ = l.await;
    }
    conns.close();
    state.tasks.close();
    let drained = tokio::time::timeout(SHUTDOWN_GRACE, async {
        conns.wait().await;
        state.tasks.wait().await;
    })
    .await;
    if drained.is_err() {
        tracing::warn!(
            connections = conns.len(),
            tasks = state.tasks.len(),
            "grace period over; closing remaining connections"
        );
    }
    match state.db.checkpoint_and_optimize().await {
        Ok(()) => tracing::info!("database checkpointed; bye"),
        Err(e) => tracing::warn!(error = %e, "database checkpoint failed"),
    }
}

async fn accept_loop(listener: TcpListener, router: Router, state: AppState, conns: TaskTracker, kind: Listener) {
    let builder = |max_buf: usize| {
        let mut http = hyper::server::conn::http1::Builder::new();
        http.timer(TokioTimer::new()).header_read_timeout(HEADER_READ_TIMEOUT).keep_alive(true).max_buf_size(max_buf);
        http
    };
    let (small, large) = (builder(MAX_BUF), builder(MAX_BUF_LARGE));
    let token = state.shutdown.clone();
    let mut failures = AcceptFailures::default();
    loop {
        let (stream, peer) = tokio::select! {
            () = token.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    // Usually EMFILE/ENFILE (out of descriptors) under load: the pending connection stays in the
                    // backlog, so retrying at once would spin. Back off until descriptors free up.
                    failures.record(&e);
                    tokio::select! {
                        () = token.cancelled() => break,
                        () = tokio::time::sleep(ACCEPT_BACKOFF) => {}
                    }
                    continue;
                }
            },
        };
        let trusted = state.trusted_proxies.contains(peer.ip());
        let slot = match state.limits.admit(kind, peer.ip(), trusted, &state.metrics).await {
            Admission::Serve(slot) => slot,
            Admission::Refuse => continue,
            Admission::Overflow(answering) => {
                conns.spawn(answer_overflow(stream, answering));
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let public = kind != Listener::Admin;
        if public {
            keepalive(&stream);
        }
        let router = router.clone();
        let hold = ConnHold::new(slot);
        let held = hold.clone();
        let head_cap = crate::limits::max_head_for(kind, peer.ip(), trusted);
        let service = hyper::service::service_fn(move |mut req: http::Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo(peer));
            req.extensions_mut().insert(held.clone());
            req.extensions_mut().insert(crate::limits::HeadCap(head_cap));
            router.clone().oneshot(req)
        });
        let io = TokioIo::new(ConnIo::new(stream, WRITE_STALL_TIMEOUT));
        let http = if head_cap == MAX_BUF_LARGE { &large } else { &small };
        let conn = http.serve_connection(io, service).with_upgrades();
        let token = token.clone();
        let state = state.clone();
        if public {
            state.metrics.connection_opened();
        }
        conns.spawn(async move {
            let mut conn = std::pin::pin!(conn);
            let result = tokio::select! {
                r = conn.as_mut() => r,
                () = token.cancelled() => {
                    conn.as_mut().graceful_shutdown();
                    conn.await
                }
            };
            if let Err(e) = result {
                tracing::debug!(error = %e, "connection closed with error");
            }
            if public {
                state.metrics.connection_closed();
            }
            // An upgrade handler may have taken the slot into the upgraded connection's task.
            drop(hold);
        });
    }
}

/// Answer a connection over the cap with the hardened `503` ([`crate::limits::OVERFLOW_ANSWER`]), then read what
/// the client sent for up to [`OVERFLOW_LINGER`] (so closing does not reset the answer away) and close.
async fn answer_overflow(mut stream: TcpStream, slot: tokio::sync::OwnedSemaphorePermit) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let _slot = slot;
    let answer = crate::limits::OVERFLOW_ANSWER.as_bytes();
    if tokio::time::timeout(OVERFLOW_LINGER, stream.write_all(answer)).await.is_err() {
        return;
    }
    let _ = stream.shutdown().await;
    let mut sink = [0u8; 4096];
    let _ = tokio::time::timeout(OVERFLOW_LINGER, async {
        let mut total = 0usize;
        while total < 256 * 1024 {
            match stream.read(&mut sink).await {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n,
            }
        }
    })
    .await;
}

/// Pause after a failed `accept()`.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
/// At most one "accept failed" warning per listener in this interval (the rest are counted into the next one).
const ACCEPT_WARN_EVERY: Duration = Duration::from_secs(10);

/// Rate-limited logging of `accept()` failures.
#[derive(Debug, Default)]
struct AcceptFailures {
    last_warn: Option<std::time::Instant>,
    suppressed: u64,
}

impl AcceptFailures {
    fn record(&mut self, e: &io::Error) {
        if self.last_warn.is_some_and(|at| at.elapsed() < ACCEPT_WARN_EVERY) {
            self.suppressed += 1;
            return;
        }
        let also = std::mem::take(&mut self.suppressed);
        let fds = fd_limit::open_count();
        let soft = fd_limit::current().and_then(|(soft, _)| soft);
        tracing::warn!(error = %e, open_fds = ?fds, fd_limit = ?soft, failures_since_last_warning = also, "accept failed; backing off");
        self.last_warn = Some(std::time::Instant::now());
    }
}

/// TCP keepalive on a public connection: probes after 60 s of silence, every 20 s, 3 times. It never closes a
/// healthy idle connection (Wisp WebSockets may be quiet for hours); it notices peers that vanished without a FIN.
fn keepalive(stream: &TcpStream) {
    #[cfg(target_os = "linux")]
    {
        use rustix::net::sockopt;
        let _ = sockopt::set_socket_keepalive(stream, true);
        let _ = sockopt::set_tcp_keepidle(stream, Duration::from_secs(60));
        let _ = sockopt::set_tcp_keepintvl(stream, Duration::from_secs(20));
        let _ = sockopt::set_tcp_keepcnt(stream, 3);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = stream;
}

/// Resolves on SIGINT/SIGTERM (or when `token` is cancelled); a second SIGINT or SIGTERM exits immediately.
pub async fn shutdown_signal(token: CancellationToken) {
    tokio::select! {
        signal = interrupt_or_terminate() => tracing::info!("received {signal}"),
        () = token.cancelled() => return,
    }
    tokio::spawn(async {
        let signal = interrupt_or_terminate().await;
        tracing::warn!("second signal ({signal}): exiting immediately");
        std::process::exit(if signal == "SIGTERM" { 143 } else { 130 });
    });
}

/// The next SIGINT or SIGTERM.
async fn interrupt_or_terminate() -> &'static str {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => "SIGINT",
        () = terminate => "SIGTERM",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[tokio::test(start_paused = true)]
    async fn a_reader_that_stops_reading_is_cut_off() {
        let (server, mut client) = tokio::io::duplex(1024);
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        let started = tokio::time::Instant::now();
        // The client never reads: the first KiB fits in the pipe, then the write blocks until the timer fires.
        let err = io.write_all(&[7u8; 64 * 1024]).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), WRITE_STALL_TIMEOUT);
        let mut got = vec![0u8; 1024];
        client.read_exact(&mut got).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn flushing_between_blocked_writes_does_not_reset_the_stall() {
        let (server, _client) = tokio::io::duplex(64);
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        io.write_all(&[0u8; 64]).await.unwrap();
        let started = tokio::time::Instant::now();
        let err = std::future::poll_fn(|cx| {
            let written = Pin::new(&mut io).poll_write(cx, b"more");
            let _ = Pin::new(&mut io).poll_flush(cx);
            written
        })
        .await
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), WRITE_STALL_TIMEOUT);
    }

    /// What hyper writes for a request head over its read buffer (captured from the release build).
    const AUTO_431: &[u8] =
        b"HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\ncontent-length: 0\r\n\
        date: Thu, 12 Nov 2026 11:23:56 GMT\r\n\r\n";

    #[test]
    fn automatic_answers_are_recognized_and_nothing_else() {
        let auto_414 =
            b"HTTP/1.1 414 URI Too Long\r\nconnection: close\r\ncontent-length: 0\r\ndate: Thu, 12 Nov 2026 11:23:56 GMT\r\n\r\n";
        assert_eq!(automatic_answer_start(AUTO_431), Some(0));
        assert_eq!(automatic_answer_start(auto_414), Some(0));
        assert_eq!(automatic_answer_start(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n"), Some(0));
        // After the end of an earlier answer on the same connection (one write of a pipelined connection).
        let mut two =
            b"HTTP/1.1 404 Not Found\r\ncontent-length: 14\r\nx-content-type-options: nosniff\r\n\r\n404 Not \
                        Found\n"
                .to_vec();
        let at = two.len();
        two.extend_from_slice(AUTO_431);
        assert_eq!(automatic_answer_start(&two), Some(at));
        // The service's answers carry more headers; other statuses, bodies and anything after the answer stay alone.
        let mut trailing = AUTO_431.to_vec();
        trailing.extend_from_slice(b"x\r\n\r\n");
        for other in [
            &b"HTTP/1.1 431 Request Header Fields Too Large\r\ncontent-length: 0\r\nx-content-type-options: nosniff\r\n\r\n"[..],
            b"HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n",
            b"HTTP/1.1 400 Bad Request\r\ncontent-length: 2\r\n\r\n",
            b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\ndate: yesterday\r\n\r\n",
            &AUTO_431[..AUTO_431.len() - 2],
            &trailing,
            b"",
            b"\r\n\r\n",
        ] {
            assert_eq!(automatic_answer_start(other), None, "{:?}", String::from_utf8_lossy(other));
        }
    }

    /// Writes `parts` as hyper's queue strategy does (vectored, resuming after short writes); hyper's byte count.
    async fn write_like_hyper(io: &mut ConnIo<tokio::io::DuplexStream>, parts: &[&[u8]]) -> usize {
        let total: usize = parts.iter().map(|p| p.len()).sum();
        let mut done = 0;
        while done < total {
            let mut skip = done;
            let mut slices = Vec::new();
            for p in parts {
                if skip >= p.len() {
                    skip -= p.len();
                    continue;
                }
                slices.push(io::IoSlice::new(&p[skip..]));
                skip = 0;
            }
            let n = std::future::poll_fn(|cx| Pin::new(&mut *io).poll_write_vectored(cx, &slices)).await.unwrap();
            assert!(n > 0 && done + n <= total, "{n} of {total} after {done}");
            done += n;
        }
        done
    }

    #[tokio::test]
    async fn automatic_answers_go_out_hardened() {
        let hardened = hardened_answer(AUTO_431);
        let text = String::from_utf8(hardened.clone()).unwrap();
        assert!(text.starts_with("HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\n"), "{text}");
        assert!(text.ends_with(&format!("GMT\r\n{AUTOMATIC_ANSWER_HEADERS}\r\n")), "{text}");
        assert!(text.contains(
            "\r\ncontent-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; \
                               frame-ancestors 'none'\r\n"
        ));
        assert_eq!(automatic_answer_start(&hardened), None, "the hardened answer is not rewritten again");
        let csp_line = format!("content-security-policy: {}\r\n", crate::security::csp::NOTHING_RUNS_UNFRAMED);
        assert!(AUTOMATIC_ANSWER_HEADERS.contains(&csp_line), "{AUTOMATIC_ANSWER_HEADERS}");

        // poll_write, through a pipe smaller than the answer (several short writes); hyper sees its own byte count.
        let (server, mut client) = tokio::io::duplex(16);
        let reader = tokio::spawn(async move {
            let mut out = Vec::new();
            client.read_to_end(&mut out).await.unwrap();
            out
        });
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        io.write_all(AUTO_431).await.unwrap();
        io.shutdown().await.unwrap();
        drop(io);
        assert_eq!(reader.await.unwrap(), hardened);

        // Vectored, after the end of an earlier answer: that part goes out unchanged.
        let earlier: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nx-content-type-options: nosniff\r\n\r\nok";
        let (server, mut client) = tokio::io::duplex(16);
        let reader = tokio::spawn(async move {
            let mut out = Vec::new();
            client.read_to_end(&mut out).await.unwrap();
            out
        });
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        let mut together = earlier.to_vec();
        together.extend_from_slice(AUTO_431);
        assert_eq!(write_like_hyper(&mut io, &[earlier, AUTO_431]).await, together.len());
        assert_eq!(write_like_hyper(&mut io, &[earlier]).await, earlier.len(), "ordinary answers are untouched");
        io.shutdown().await.unwrap();
        drop(io);
        let mut want = earlier.to_vec();
        want.extend_from_slice(&hardened);
        want.extend_from_slice(earlier);
        assert_eq!(reader.await.unwrap(), want);

        // A pending hardened answer finishes on the next call and never reports more than that call offered.
        let (server, mut client) = tokio::io::duplex(8);
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        let first = std::future::poll_fn(|cx| Poll::Ready(Pin::new(&mut io).poll_write(cx, AUTO_431))).await;
        assert!(first.is_pending(), "the pipe takes 8 bytes, the rest waits");
        let drain = tokio::spawn(async move {
            let mut out = Vec::new();
            client.read_to_end(&mut out).await.unwrap();
            out
        });
        let n = std::future::poll_fn(|cx| Pin::new(&mut io).poll_write(cx, &AUTO_431[..10])).await.unwrap();
        assert_eq!(n, 10);
        io.shutdown().await.unwrap();
        drop(io);
        assert_eq!(drain.await.unwrap(), hardened);

        // Both in one slice (hyper's flatten strategy).
        let (server, mut client) = tokio::io::duplex(4096);
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        io.write_all(&together).await.unwrap();
        io.shutdown().await.unwrap();
        drop(io);
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, [earlier, &hardened[..]].concat());
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_but_steady_reader_is_served() {
        let (server, mut client) = tokio::io::duplex(1024);
        let reader = tokio::spawn(async move {
            let mut total = 0;
            let mut buf = [0u8; 1024];
            while total < 16 * 1024 {
                // Far slower than the timeout overall, but never stalled for that long at a time.
                tokio::time::sleep(WRITE_STALL_TIMEOUT / 2).await;
                total += client.read(&mut buf).await.unwrap();
            }
            total
        });
        let mut io = ConnIo::new(server, WRITE_STALL_TIMEOUT);
        io.write_all(&[1u8; 16 * 1024]).await.expect("progress keeps resetting the timer");
        assert_eq!(reader.await.unwrap(), 16 * 1024);
        assert!(io.get_ref().is_write_vectored() == io.is_write_vectored());
    }
}
