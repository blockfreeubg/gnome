//! I/O abstractions used by the importers.
//!
//! The catalog never opens sockets, resolves names or does TLS itself. gnome-server implements [`Fetcher`] with
//! gnome-net's SSRF-safe client, [`Clock`] with Tokio time ([`TokioClock`] is provided) and [`WriteDb`] with its
//! serialized writer connection. Tests use [`FixtureFetcher`] and [`ManualClock`], which never touch the network
//! or really sleep.

use std::collections::VecDeque;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use rusqlite::Connection;

use crate::error::CatalogError;

/// A boxed, sendable future (keeps [`Fetcher`] and [`Clock`] dyn-compatible).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// HTTP method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET`
    Get,
    /// `POST`
    Post,
}

/// An outbound request built by an importer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    /// HTTP method.
    pub method: Method,
    /// Absolute `https://` URL (validated by the importer; the implementation must still apply its own
    /// destination policy).
    pub url: String,
    /// Request headers, including `User-Agent`, `Accept` and conditional headers (`If-None-Match`,
    /// `If-Modified-Since`) when the importer has a cached validator.
    pub headers: Vec<(String, String)>,
    /// Request body (`POST` only).
    pub body: Option<Vec<u8>>,
    /// The implementation must fail with [`FetchError::BodyTooLarge`] instead of buffering more than this
    /// (after decompression).
    pub max_body_bytes: usize,
    /// Total time budget for the request including the body.
    pub timeout: Duration,
}

impl FetchRequest {
    /// First value of a request header (case-insensitive name).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// A response. `304 Not Modified` is a normal response (empty body), not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse {
    /// HTTP status code.
    pub status: u16,
    /// Response headers; names are compared case-insensitively by [`FetchResponse::header`].
    pub headers: Vec<(String, String)>,
    /// Decoded (decompressed) body, at most `max_body_bytes`.
    pub body: Vec<u8>,
}

impl FetchResponse {
    /// First value of a response header (case-insensitive name).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Transport-level failure (no HTTP response).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The request exceeded its time budget.
    Timeout,
    /// The body exceeded `max_body_bytes`.
    BodyTooLarge {
        /// The configured limit (bytes).
        limit: usize,
    },
    /// Connection / TLS / protocol error (retryable).
    Network(String),
    /// The destination is not allowed by the implementation's egress policy (not retryable).
    Blocked(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout => f.write_str("request timed out"),
            Self::BodyTooLarge { limit } => write!(f, "response body larger than {limit} bytes"),
            Self::Network(e) => write!(f, "network error: {e}"),
            Self::Blocked(e) => write!(f, "destination blocked: {e}"),
        }
    }
}

impl std::error::Error for FetchError {}

impl FetchError {
    /// Whether retrying may help.
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Timeout | Self::Network(_))
    }
}

/// Performs HTTP requests for the importers.
///
/// Contract for implementations:
/// * send the request as given (method, URL, headers, body); add `Accept-Encoding` and decompress if you like;
/// * follow at most a few redirects and re-validate every hop against the egress policy (or don't follow them —
///   the catalog's feeds do not redirect);
/// * enforce `max_body_bytes` and `timeout`;
/// * return any HTTP status as `Ok` (including 304, 429 and 5xx); only transport failures are `Err`.
pub trait Fetcher: Send + Sync {
    /// Perform one request.
    fn fetch(&self, request: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>>;
}

/// Time source and sleeper (abstracted so tests can run rate limits and back-off instantly).
pub trait Clock: Send + Sync {
    /// Current Unix time in milliseconds.
    fn now_ms(&self) -> i64;
    /// Sleep for `d`.
    fn sleep(&self, d: Duration) -> BoxFuture<'_, ()>;
}

/// Wall clock + `tokio::time::sleep`.
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioClock;

impl Clock for TokioClock {
    fn now_ms(&self) -> i64 {
        system_now_ms()
    }

    fn sleep(&self, d: Duration) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(d))
    }
}

/// Current Unix time in milliseconds.
pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A virtual clock: `sleep` returns immediately and advances `now`; every sleep is recorded.
#[derive(Debug)]
pub struct ManualClock {
    now: AtomicI64,
    sleeps: Mutex<Vec<Duration>>,
}

impl ManualClock {
    /// A clock starting at `now_ms`.
    pub fn new(now_ms: i64) -> Self {
        Self { now: AtomicI64::new(now_ms), sleeps: Mutex::new(Vec::new()) }
    }

    /// Move time forward without recording a sleep.
    pub fn advance(&self, d: Duration) {
        self.now.fetch_add(i64::try_from(d.as_millis()).unwrap_or(i64::MAX), Ordering::SeqCst);
    }

    /// Every sleep requested so far.
    pub fn sleeps(&self) -> Vec<Duration> {
        self.sleeps.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Total time slept.
    pub fn slept(&self) -> Duration {
        self.sleeps().iter().sum()
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn sleep(&self, d: Duration) -> BoxFuture<'_, ()> {
        self.sleeps.lock().unwrap_or_else(|e| e.into_inner()).push(d);
        self.advance(d);
        Box::pin(async {})
    }
}

/// Access to the catalog's writer connection.
///
/// gnome-server implements this over its serialized writer (`Db::write`, which runs the closure on the blocking
/// pool). The closure may run a transaction; it must not be cancelled half-way (it is synchronous).
pub trait WriteDb: Send + Sync {
    /// Run `f` with exclusive access to the writer connection.
    fn write<T, F>(&self, f: F) -> impl Future<Output = Result<T, CatalogError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, CatalogError> + Send + 'static;
}

/// Runs the closure inline on the calling task (blocking it). Fine for tests, CLIs and the example importer; a
/// server should implement [`WriteDb`] over `spawn_blocking` instead.
impl WriteDb for Mutex<Connection> {
    fn write<T, F>(&self, f: F) -> impl Future<Output = Result<T, CatalogError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, CatalogError> + Send + 'static,
    {
        let result = match self.lock() {
            Ok(mut conn) => f(&mut conn),
            Err(_) => Err(CatalogError::Storage("writer connection mutex poisoned".into())),
        };
        std::future::ready(result)
    }
}

/// A canned response for [`FixtureFetcher`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureResponse {
    /// HTTP status.
    pub status: u16,
    /// Response headers.
    pub headers: Vec<(String, String)>,
    /// Response body.
    pub body: Vec<u8>,
}

impl FixtureResponse {
    /// `200` with a body and optional extra headers.
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self { status: 200, headers: Vec::new(), body: body.into() }
    }

    /// Any status with an empty body.
    pub fn status(status: u16) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }
    }

    /// Add a header.
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    /// `200` with the contents of a file.
    pub fn file(path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
        Ok(Self::ok(std::fs::read(path)?))
    }
}

type Matcher = Box<dyn Fn(&FetchRequest) -> bool + Send + Sync>;

struct Route {
    matcher: Matcher,
    responses: VecDeque<FixtureResponse>,
    /// Keep answering with the last response once the queue is down to one.
    sticky: bool,
}

/// A [`Fetcher`] that answers from canned responses (e.g. the real feed captures in `tests/fixtures/`).
///
/// Routes are tried in registration order; the first route whose matcher accepts the request and still has a
/// response answers. Every request is logged for assertions. Unmatched requests fail with
/// [`FetchError::Network`].
#[derive(Default)]
pub struct FixtureFetcher {
    routes: Mutex<Vec<Route>>,
    log: Mutex<Vec<FetchRequest>>,
}

impl fmt::Debug for FixtureFetcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FixtureFetcher").field("requests", &self.requests().len()).finish()
    }
}

impl FixtureFetcher {
    /// An empty fetcher.
    pub fn new() -> Self {
        Self::default()
    }

    /// Answer requests accepted by `matcher` with `responses`, in order (each response is used once).
    pub fn route<M>(&self, matcher: M, responses: Vec<FixtureResponse>) -> &Self
    where
        M: Fn(&FetchRequest) -> bool + Send + Sync + 'static,
    {
        self.push(Box::new(matcher), responses, false)
    }

    /// Like [`route`](Self::route), but the last response keeps answering forever.
    pub fn route_sticky<M>(&self, matcher: M, responses: Vec<FixtureResponse>) -> &Self
    where
        M: Fn(&FetchRequest) -> bool + Send + Sync + 'static,
    {
        self.push(Box::new(matcher), responses, true)
    }

    /// Answer requests whose URL contains every one of `parts`.
    pub fn on_url(&self, parts: &[&str], responses: Vec<FixtureResponse>) -> &Self {
        let parts: Vec<String> = parts.iter().map(|p| (*p).to_owned()).collect();
        self.route(move |r| parts.iter().all(|p| r.url.contains(p.as_str())), responses)
    }

    fn push(&self, matcher: Matcher, responses: Vec<FixtureResponse>, sticky: bool) -> &Self {
        self.routes.lock().unwrap_or_else(|e| e.into_inner()).push(Route {
            matcher,
            responses: responses.into(),
            sticky,
        });
        self
    }

    /// Every request received so far.
    pub fn requests(&self) -> Vec<FetchRequest> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn answer(&self, req: &FetchRequest) -> Option<FixtureResponse> {
        let mut routes = self.routes.lock().unwrap_or_else(|e| e.into_inner());
        for route in routes.iter_mut() {
            if route.responses.is_empty() || !(route.matcher)(req) {
                continue;
            }
            if route.sticky && route.responses.len() == 1 {
                return route.responses.front().cloned();
            }
            return route.responses.pop_front();
        }
        None
    }
}

impl Fetcher for FixtureFetcher {
    fn fetch(&self, request: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).push(request.clone());
        let result = match self.answer(&request) {
            Some(r) if r.body.len() > request.max_body_bytes => {
                Err(FetchError::BodyTooLarge { limit: request.max_body_bytes })
            }
            Some(r) => Ok(FetchResponse { status: r.status, headers: r.headers, body: r.body }),
            None => Err(FetchError::Network(format!("no fixture for {:?} {}", request.method, request.url))),
        };
        Box::pin(std::future::ready(result))
    }
}
