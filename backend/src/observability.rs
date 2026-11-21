//! Logging and per-request observation.
//!
//! * [`init_tracing`]: `GNOME_LOG` (EnvFilter) and `GNOME_LOG_FORMAT` (`pretty` = human-readable lines, `json` = one
//!   JSON object per line), to stderr.
//! * [`observe`] (outermost public middleware): resolves [`ClientInfo`], assigns `x-request-id`, opens a span carrying
//!   it, records metrics and writes the access log line (target `gnome_server::access`): method, route (or path
//!   without query string; proxy-engine URLs are reduced to their prefix so browsing destinations never reach logs),
//!   status and latency, plus `role=proxy` for requests to the proxy origin. Client IPs are logged only with
//!   `GNOME_LOG_IPS=true`. A request whose client disconnects before the response is logged and counted with status
//!   `499`.

use std::io::IsTerminal as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use axum::extract::{ConnectInfo, MatchedPath, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use http::{HeaderName, HeaderValue, Method};
use percent_encoding::percent_decode_str;
use tracing::Instrument as _;
use tracing_subscriber::EnvFilter;

use crate::config::{Config, LogFormat};
use crate::origins::Role;
use crate::security::ClientInfo;
use crate::security::crypto::{b64url, random_bytes};
use crate::state::AppState;
use crate::static_files::ENGINE_PREFIXES;

pub const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");
const MAX_LOGGED_PATH: usize = 200;

/// Install the global subscriber. Safe to call more than once (later calls are ignored).
pub fn init_tracing(config: &Config) {
    let filter = EnvFilter::try_new(&config.log).unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr);
    let _ = match config.log_format {
        LogFormat::Pretty => builder.with_ansi(std::io::stderr().is_terminal()).try_init(),
        LogFormat::Json => builder.json().with_current_span(true).with_span_list(false).try_init(),
    };
}

/// The request id assigned to a request (also in the response's `x-request-id`).
#[derive(Debug, Clone)]
pub struct RequestId(pub HeaderValue);

/// Process-unique, cheap request ids: random per-process prefix + counter.
fn next_request_id() -> HeaderValue {
    static PREFIX: OnceLock<String> = OnceLock::new();
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let prefix = PREFIX.get_or_init(|| b64url(&random_bytes::<6>()));
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    HeaderValue::from_str(&format!("{prefix}-{n:x}")).expect("request id is ASCII")
}

/// Accept an upstream id only from a trusted proxy and only if it looks like an id.
fn incoming_request_id(req: &Request, client: &ClientInfo) -> Option<HeaderValue> {
    if !client.via_trusted_proxy {
        return None;
    }
    let v = req.headers().get(&REQUEST_ID)?;
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.as_bytes().iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'));
    ok.then(|| v.clone())
}

/// Path as it may appear in logs (never a query string; engine URLs, which encode the destination, are cut to
/// their prefix — also when the prefix itself arrives percent-encoded).
pub fn loggable_path(path: &str) -> String {
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    if let Some(prefix) = ENGINE_PREFIXES.iter().find(|p| path.starts_with(**p) || decoded.starts_with(**p)) {
        return format!("{prefix}…");
    }
    if path.len() > MAX_LOGGED_PATH {
        let mut cut = MAX_LOGGED_PATH;
        while !path.is_char_boundary(cut) {
            cut -= 1;
        }
        return format!("{}…", &path[..cut]);
    }
    path.to_string()
}

/// Which listener a request arrived on (access-log field; only the public listener feeds the HTTP metrics).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Listener {
    Public,
    Admin,
}

/// Outermost middleware of the public router.
pub async fn observe(State(state): State<AppState>, req: Request, next: Next) -> Response {
    observe_on(&state, Listener::Public, req, next).await
}

/// Outermost middleware of the admin router: request id + access log (`listener=admin`), no public metrics.
pub async fn observe_admin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    observe_on(&state, Listener::Admin, req, next).await
}

async fn observe_on(state: &AppState, listener: Listener, mut req: Request, next: Next) -> Response {
    let start = Instant::now();
    // The main listener's role dispatch may already have resolved the client.
    let client = match (req.extensions().get::<ClientInfo>(), req.extensions().get::<ConnectInfo<SocketAddr>>()) {
        (Some(known), _) => known.clone(),
        (None, Some(ConnectInfo(peer))) => {
            ClientInfo::resolve(*peer, req.headers(), req.uri().authority().map(|a| a.as_str()), &state.trusted_proxies)
        }
        (None, None) => ClientInfo::unknown(),
    };
    let proxy_role = req.extensions().get::<Role>() == Some(&Role::Proxy);
    let request_id = incoming_request_id(&req, &client).unwrap_or_else(next_request_id);
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| loggable_path(req.uri().path()), |m| m.as_str().to_string());
    let span = tracing::info_span!("req", id = %request_id.to_str().unwrap_or("-"));
    if listener == Listener::Public {
        state.metrics.request_started(); // paired with `request_ended` when `record` drops
    }
    let mut record = RequestRecord {
        state,
        listener,
        proxy_role,
        method: req.method().clone(),
        route,
        ip: state.config.log_ips.then_some(client.ip),
        start,
        span: span.clone(),
        done: false,
    };
    req.extensions_mut().insert(client);
    req.extensions_mut().insert(RequestId(request_id.clone()));

    let mut res = next.run(req).instrument(span).await;
    res.headers_mut().insert(REQUEST_ID, request_id);
    record.finish(res.status().as_u16());
    res
}

/// Status logged and counted for a request whose client went away before the response (hyper drops the request
/// future), as nginx does.
pub const CLIENT_CLOSED: u16 = 499;

/// Bookkeeping for one request: the in-flight gauge while it runs, then metrics and the access-log line. Kept in a
/// drop guard so a request that never completes — the client disconnected, or a middleware panicked — still leaves
/// the gauge and is still logged (`499`, or `500` while unwinding).
struct RequestRecord<'a> {
    state: &'a AppState,
    listener: Listener,
    /// The request had the proxy role (logged as `role=proxy`).
    proxy_role: bool,
    method: Method,
    route: String,
    ip: Option<IpAddr>,
    start: Instant,
    span: tracing::Span,
    done: bool,
}

impl RequestRecord<'_> {
    fn finish(&mut self, status: u16) {
        self.done = true;
        let elapsed = self.start.elapsed();
        if self.listener == Listener::Public {
            self.state.metrics.request_finished(status, elapsed);
        }
        let (method, route, ms) = (&self.method, self.route.as_str(), latency_ms(elapsed));
        self.span.in_scope(|| match (self.listener, self.ip) {
            (Listener::Public, Some(ip)) if self.proxy_role => {
                tracing::info!(target: "gnome_server::access", role = "proxy", %method, route, status, ms, %ip, "request");
            }
            (Listener::Public, None) if self.proxy_role => {
                tracing::info!(target: "gnome_server::access", role = "proxy", %method, route, status, ms, "request");
            }
            (Listener::Public, Some(ip)) => {
                tracing::info!(target: "gnome_server::access", %method, route, status, ms, %ip, "request");
            }
            (Listener::Public, None) => {
                tracing::info!(target: "gnome_server::access", %method, route, status, ms, "request");
            }
            (Listener::Admin, Some(ip)) => {
                tracing::info!(target: "gnome_server::access", listener = "admin", %method, route, status, ms, %ip, "request");
            }
            (Listener::Admin, None) => {
                tracing::info!(target: "gnome_server::access", listener = "admin", %method, route, status, ms, "request");
            }
        });
    }
}

impl Drop for RequestRecord<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.finish(if std::thread::panicking() { 500 } else { CLIENT_CLOSED });
        }
        if self.listener == Listener::Public {
            self.state.metrics.request_ended();
        }
    }
}

/// Latency in milliseconds with microsecond resolution (`1.234`). One correctly rounded division of the whole
/// microsecond count yields the double nearest to that decimal, so log lines never show float noise such as
/// `0.17339300000000002`.
fn latency_ms(elapsed: std::time::Duration) -> f64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX) as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_paths_are_not_logged() {
        assert_eq!(loggable_path("/~/sj/c1/f1/https%3A%2F%2Fexample.com%2Fsecret"), "/~/sj/…");
        assert_eq!(loggable_path("/%7E/sj/c1/f1/https%3A%2F%2Fexample.com%2Fsecret"), "/~/sj/…");
        assert_eq!(loggable_path("/uv/service/hvtrs8%2F-example"), "/uv/service/…");
        assert_eq!(loggable_path("/assets/app.js"), "/assets/app.js");
        let long = format!("/{}", "é".repeat(300));
        assert!(loggable_path(&long).chars().count() < 120);
    }

    #[test]
    fn latency_has_microsecond_resolution_without_float_noise() {
        use std::time::Duration;
        assert_eq!(latency_ms(Duration::from_nanos(173_393_000)).to_string(), "173.393");
        assert_eq!(latency_ms(Duration::from_nanos(1_499)).to_string(), "0.001");
        assert_eq!(latency_ms(Duration::from_micros(2_000)).to_string(), "2");
        assert_eq!(latency_ms(Duration::from_secs(3)).to_string(), "3000");
        assert_eq!(latency_ms(Duration::ZERO).to_string(), "0");
        // Every value prints as its exact three-decimal form.
        for micros in (0..2_000_000u64).step_by(7) {
            let shown = latency_ms(Duration::from_micros(micros)).to_string();
            let expected = format!("{}.{:03}", micros / 1000, micros % 1000);
            let expected = expected.trim_end_matches('0').trim_end_matches('.');
            assert_eq!(shown, if expected.is_empty() { "0" } else { expected }, "{micros} µs");
        }
    }

    #[test]
    fn request_ids_are_unique() {
        assert_ne!(next_request_id(), next_request_id());
    }
}
