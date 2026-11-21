//! The Wisp gateway (ARCHITECTURE §4.4, §4.6; API.md "Wisp", `POST /api/wisp/ticket`).
//!
//! * **Tickets** (app role): `POST /api/wisp/ticket` mints a [`ticket`] for the caller's session (anonymous in
//!   `open`/`code` mode — created on the fly in `open` mode —, signed-in in `accounts` mode).
//! * **Gateway** (proxy role): `GET /wisp/?t=<ticket>&/` and `GET /wisp/p/:id/?t=<ticket>&/` (`ticket_param`
//!   for the accepted URL forms). A plain `GET`/`HEAD` without `Upgrade` is a **ticket probe**: after the rate limit
//!   and the profile check it answers `401 wisp_ticket_*`, `503 wisp_upstream_unavailable` (ticket valid, but the
//!   health job has the route's upstream down) or `426` (ticket valid) and opens nothing, takes no slot and needs
//!   no `Origin`. Upgrade checks run before anything is
//!   upgraded, cheapest first: upgrade rate per IP, known profile, a well-formed HTTP/1.1 `GET` WebSocket upgrade,
//!   `Origin` = the proxy origin, a valid ticket (and in `accounts` mode a live user session, cached ≤
//!   [`SESSION_CHECK_TTL`]), per-IP and per-session connection caps ([`caps`]). Every refusal is a JSON 4xx; the
//!   upstream being unreachable or refusing is a JSON `502`. Then the upgrade is forwarded to HolyWisp
//!   ([`upstream`]): only the WebSocket headers, `Host` = the upstream, exactly one `X-Forwarded-For` with the client
//!   IP (every client-supplied forwarding header, cookie and credential is dropped). HolyWisp's `101` head is
//!   relayed and the bytes are spliced ([`relay`]) on a task tracked by `state.tasks` (10 s grace at shutdown). In
//!   `accounts` mode the task re-checks the user session every [`SESSION_CHECK_TTL`] and closes the connection once
//!   the session was revoked or expired.
//! * **Health** ([`health`]): the `wisp.health` job probes every upstream each minute.
//!
//! The gateway never inspects or logs what flows through it (stream destinations are inside the Wisp payload).

pub mod caps;
pub mod health;
pub mod relay;
pub mod ticket;
pub mod upstream;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http::{HeaderMap, HeaderValue, Method, StatusCode, Version, header};
use serde_json::{Value, json};
use tracing::Instrument as _;

use self::caps::{CapExceeded, Caps};
use self::health::{DIRECT, PROBE_INTERVAL, Upstream, Upstreams};
use self::relay::RelayCounters;
use self::ticket::{SessionRef, Ticket, TicketError, TicketKey};
use self::upstream::{ForwardedUpgrade, UpstreamError};
use crate::api::meta::UpstreamStatus;
use crate::auth::cookies::{self, SessionCookie};
use crate::auth::extract::{CookieSink, cookies_secure, resolve_anon, resolve_user};
use crate::auth::sessions;
use crate::config::AccessMode;
use crate::db::DbError;
use crate::error::ApiError;
use crate::jobs::Job;
use crate::module::{Diagnostics, Ext, Health, Module, ModuleSetup};
use crate::observability::RequestId;
use crate::origins;
use crate::security::ClientInfo;
use crate::security::origin::normalize_origin;
use crate::security::rate_limit::{RateClass, SessionKey, enforce};
use crate::server::SHUTDOWN_GRACE;
use crate::state::AppState;
use crate::util::{BoxFuture, now_ms, now_s};

/// How long a user-session check (`accounts` mode) is trusted before the database is asked again; also how often an
/// open connection's session is checked again (a connection of a revoked or expired session ends within twice this).
pub const SESSION_CHECK_TTL: Duration = Duration::from_secs(15);
const SESSION_CACHE_MAX: usize = 8192;
/// Name of the upstream health job.
pub const HEALTH_JOB: &str = "wisp.health";

/// Gateway behaviour that tests (or embedders) may change.
#[derive(Debug, Clone, Copy)]
pub struct GatewayOptions {
    /// Use `splice(2)` when this process supports it (Linux). `false` forces the copy path.
    pub zero_copy: bool,
    /// [`SESSION_CHECK_TTL`] (tests shorten it).
    pub session_check: Duration,
}

impl Default for GatewayOptions {
    fn default() -> Self {
        Self { zero_copy: true, session_check: SESSION_CHECK_TTL }
    }
}

/// Why an upgrade was refused (diagnostics/metrics label).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum Reject {
    RateLimited,
    UnknownProfile,
    NotAnUpgrade,
    Origin,
    Ticket,
    SessionEnded,
    TooManyConnections,
    Upstream,
    ShuttingDown,
}

impl Reject {
    pub const ALL: [Reject; 9] = [
        Reject::RateLimited,
        Reject::UnknownProfile,
        Reject::NotAnUpgrade,
        Reject::Origin,
        Reject::Ticket,
        Reject::SessionEnded,
        Reject::TooManyConnections,
        Reject::Upstream,
        Reject::ShuttingDown,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::RateLimited => "rate_limited",
            Self::UnknownProfile => "unknown_profile",
            Self::NotAnUpgrade => "not_an_upgrade",
            Self::Origin => "origin",
            Self::Ticket => "ticket",
            Self::SessionEnded => "session_ended",
            Self::TooManyConnections => "too_many_connections",
            Self::Upstream => "upstream",
            Self::ShuttingDown => "shutting_down",
        }
    }
}

/// Counters for diagnostics and Prometheus.
#[derive(Debug, Default)]
pub struct GatewayStats {
    active: AtomicI64,
    total: AtomicU64,
    pub relay: RelayCounters,
    rejected: [AtomicU64; Reject::ALL.len()],
    /// Ticket probes (plain `GET`s of a Wisp route) answered `[426 valid, 401 refused, 503 upstream down]`.
    probes: [AtomicU64; 3],
}

impl GatewayStats {
    fn reject(&self, why: Reject) {
        self.rejected[why as usize].fetch_add(1, Ordering::Relaxed);
    }

    pub fn active(&self) -> i64 {
        self.active.load(Ordering::Relaxed)
    }

    pub fn total(&self) -> u64 {
        self.total.load(Ordering::Relaxed)
    }

    pub fn rejected(&self, why: Reject) -> u64 {
        self.rejected[why as usize].load(Ordering::Relaxed)
    }

    /// Ticket probes answered `(426 valid, 401 refused)`.
    pub fn probes(&self) -> (u64, u64) {
        (self.probes[0].load(Ordering::Relaxed), self.probes[1].load(Ordering::Relaxed))
    }

    /// Ticket probes with a valid ticket answered `503 wisp_upstream_unavailable`.
    pub fn probes_upstream_down(&self) -> u64 {
        self.probes[2].load(Ordering::Relaxed)
    }
}

/// Keeps `active` raised for the lifetime of a connection task, however it ends.
struct ActiveGuard(Arc<Gateway>);

impl ActiveGuard {
    fn new(gw: Arc<Gateway>) -> Self {
        gw.stats.active.fetch_add(1, Ordering::Relaxed);
        Self(gw)
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.stats.active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Cached answers to "is the user session behind this ticket still live?" (`accounts` mode), each trusted for `ttl`.
#[derive(Debug)]
struct SessionCache {
    ttl: Duration,
    entries: Mutex<HashMap<SessionRef, (Instant, bool)>>,
}

impl SessionCache {
    fn new(ttl: Duration) -> Self {
        Self { ttl, entries: Mutex::default() }
    }

    fn cached(&self, r: SessionRef) -> Option<bool> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.get(&r).filter(|(at, _)| at.elapsed() < self.ttl).map(|(_, live)| *live)
    }

    fn store(&self, r: SessionRef, live: bool) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= SESSION_CACHE_MAX {
            entries.retain(|_, (at, _)| at.elapsed() < self.ttl);
            if entries.len() >= SESSION_CACHE_MAX {
                entries.clear();
            }
        }
        entries.insert(r, (Instant::now(), live));
    }

    async fn live(&self, state: &AppState, r: SessionRef) -> Result<bool, ApiError> {
        if let Some(live) = self.cached(r) {
            return Ok(live);
        }
        let now = now_ms();
        let live = state.db.read(move |c| sessions::live_by_prefix(c, &r.0, now).map_err(DbError::from)).await?;
        self.store(r, live);
        Ok(live)
    }
}

/// Gateway state, published with [`ModuleSetup::provide`] (`state.ext::<Gateway>()`).
pub struct Gateway {
    pub upstreams: Upstreams,
    tickets: TicketKey,
    caps: Caps,
    sessions: SessionCache,
    pub stats: GatewayStats,
    /// Whether connections use `splice(2)`; `Err` explains why not.
    zero_copy: Result<(), String>,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway").field("upstreams", &self.upstreams).field("zero_copy", &self.zero_copy).finish()
    }
}

impl Gateway {
    fn new(state: &AppState, options: GatewayOptions) -> Self {
        let c = &state.config;
        let mut list = vec![Arc::new(Upstream::new(DIRECT, c.wisp_upstream.clone()))];
        list.extend(c.profiles.iter().map(|p| Arc::new(Upstream::new(p.id.clone(), p.upstream.clone()))));
        let zero_copy =
            if options.zero_copy { relay::zero_copy_available() } else { Err("disabled by configuration".into()) };
        match &zero_copy {
            Ok(()) => tracing::debug!("Wisp gateway: zero-copy splice(2) available"),
            Err(why) => tracing::info!(reason = %why, "Wisp gateway: splice(2) unavailable, relaying by copying"),
        }
        Self {
            upstreams: Upstreams::new(list),
            tickets: TicketKey::new(&state.secret, c.access_mode, c.access_code.as_ref()),
            caps: Caps::new(c.max_ws_per_ip, c.max_ws_per_session),
            sessions: SessionCache::new(options.session_check),
            stats: GatewayStats::default(),
            zero_copy,
        }
    }

    /// Whether connections are relayed with `splice(2)`.
    pub fn zero_copy(&self) -> bool {
        self.zero_copy.is_ok()
    }

    /// Mint a ticket (exposed for tests and tools; the HTTP endpoint applies the access rules first).
    pub fn mint(&self, session_ref: SessionRef, expires_at_s: u64) -> String {
        self.tickets.mint(session_ref, expires_at_s)
    }

    fn refuse(&self, why: Reject, err: ApiError) -> Response {
        self.stats.reject(why);
        tracing::debug!(reason = why.name(), status = err.status.as_u16(), "Wisp upgrade refused");
        err.into_response()
    }

    /// Check the request's ticket. Read-only: nothing is minted, extended or consumed (tickets are stateless); in
    /// `accounts` mode the session lookup only fills the [`SessionCache`].
    async fn verify_ticket(&self, state: &AppState, query: Option<&str>) -> Result<Ticket, (Reject, ApiError)> {
        let raw = ticket_param(query).map_err(|p| (Reject::Ticket, p.error()))?;
        let t = self.tickets.verify(&raw, now_s()).map_err(|e| {
            let code = if e == TicketError::Expired { TICKET_EXPIRED } else { TICKET_INVALID };
            (Reject::Ticket, ApiError::new(StatusCode::UNAUTHORIZED, code, e.message()))
        })?;
        if state.config.access_mode == AccessMode::Accounts {
            let live = self.sessions.live(state, t.session_ref).await.map_err(|e| (Reject::SessionEnded, e))?;
            if !live {
                return Err((
                    Reject::SessionEnded,
                    ApiError::new(
                        StatusCode::UNAUTHORIZED,
                        TICKET_REVOKED,
                        "the session behind this Wisp ticket ended",
                    ),
                ));
            }
        }
        Ok(t)
    }

    /// A plain (non-upgrade) `GET`/`HEAD` of a Wisp route: the engine host's ticket probe. `401` with a
    /// `wisp_ticket_*` code when the ticket would be refused; for a valid ticket `503 wisp_upstream_unavailable` with
    /// `Retry-After` while the health job has the route's upstream down (an upgrade would fail with `502`), else
    /// `426`. No `Origin` is required (a same-origin `fetch` GET carries none) because nothing is opened: the probe
    /// takes no connection slot, never contacts the upstream itself (a `503` may ask the health job for an early
    /// round, at most every 10 s) and changes no ticket state.
    async fn probe(&self, state: &AppState, upstream: &Upstream, query: Option<&str>) -> Response {
        match self.verify_ticket(state, query).await {
            Ok(_) if upstream.status().0 == UpstreamStatus::Down => {
                self.stats.probes[2].fetch_add(1, Ordering::Relaxed);
                if self.upstreams.claim_early_probe() {
                    state.jobs.trigger(HEALTH_JOB);
                }
                tracing::debug!(upstream = %upstream.id, "Wisp ticket probe: the upstream is down");
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    UPSTREAM_UNAVAILABLE,
                    "the Wisp server of this route is unavailable; retry later",
                )
                .with_retry_after(UPSTREAM_RETRY_AFTER)
                .into_response()
            }
            Ok(_) => {
                self.stats.probes[0].fetch_add(1, Ordering::Relaxed);
                *upgrade_required("the Wisp ticket is valid; connect with a WebSocket upgrade", false)
            }
            Err((_, e)) => {
                if e.status == StatusCode::UNAUTHORIZED {
                    self.stats.probes[1].fetch_add(1, Ordering::Relaxed);
                }
                tracing::debug!(code = e.code, status = e.status.as_u16(), "Wisp ticket probe refused");
                e.into_response()
            }
        }
    }

    /// The whole upgrade path for `/wisp/` (`profile = None`) and `/wisp/p/:id/`.
    async fn upgrade(self: Arc<Self>, state: AppState, profile: Option<String>, mut req: Request) -> Response {
        let client = req.extensions().get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
        if let Err(e) = enforce(&state, RateClass::WispUpgrade, client.ip, None) {
            return self.refuse(Reject::RateLimited, e);
        }
        let upstream = match &profile {
            None => self.upstreams.get(DIRECT).cloned(),
            Some(id) if id != DIRECT => self.upstreams.get(id).cloned(),
            Some(_) => None,
        };
        let Some(upstream) = upstream else {
            return self.refuse(Reject::UnknownProfile, ApiError::not_found());
        };
        if is_probe(&req) {
            return self.probe(&state, &upstream, req.uri().query()).await;
        }
        let forwarded = match forwarded_upgrade(&req) {
            Ok(mut f) => {
                // HolyWisp gets the route's canonical path, so nothing of the client's URL (the query with the
                // ticket, percent-encoded spellings of the profile id) is forwarded.
                f.path = match &profile {
                    None => "/wisp/".into(),
                    Some(id) => format!("/wisp/p/{id}/"),
                };
                f
            }
            Err(res) => {
                self.stats.reject(Reject::NotAnUpgrade);
                return *res;
            }
        };
        if let Err(e) = check_origin(&state, &client, req.headers()) {
            return self.refuse(Reject::Origin, e);
        }
        let ticket = match self.verify_ticket(&state, req.uri().query()).await {
            Ok(t) => t,
            Err((why, e)) => return self.refuse(why, e),
        };
        let slot = match self.caps.acquire(client.ip, ticket.session_ref) {
            Ok(slot) => slot,
            Err(which) => {
                let msg = match which {
                    CapExceeded::Ip => "too many concurrent Wisp connections from this address",
                    CapExceeded::Session => "too many concurrent Wisp connections for this session",
                };
                return self.refuse(Reject::TooManyConnections, ApiError::too_many_connections(msg));
            }
        };
        if state.shutdown.is_cancelled() {
            return self.refuse(Reject::ShuttingDown, ApiError::unavailable("the server is shutting down"));
        }
        let (stream, head, rest) = match upstream::open(&upstream.addr, &forwarded, client.ip).await {
            Ok(opened) => opened,
            Err(e) => {
                tracing::warn!(upstream = %upstream.id, error = %e, "Wisp upstream failed");
                if !matches!(e, UpstreamError::Status(_)) && self.upstreams.claim_early_probe() {
                    state.jobs.trigger(HEALTH_JOB);
                }
                let msg = match e {
                    UpstreamError::Status(code) => format!("the Wisp server refused the connection (HTTP {code})"),
                    UpstreamError::Timeout => "the Wisp server did not answer in time".into(),
                    _ => "the Wisp server is unavailable".into(),
                };
                return self.refuse(Reject::Upstream, ApiError::bad_gateway(msg));
            }
        };
        let on_upgrade = hyper::upgrade::on(&mut req);
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        for (name, value) in head.headers {
            res.headers_mut().append(name, value);
        }
        let span = match req.extensions().get::<RequestId>() {
            Some(RequestId(id)) => {
                tracing::debug_span!("wisp", id = %id.to_str().unwrap_or("-"), upstream = %upstream.id)
            }
            None => tracing::debug_span!("wisp", upstream = %upstream.id),
        };
        let gw = self.clone();
        let shutdown = state.shutdown.clone();
        let active = ActiveGuard::new(self.clone());
        // `accounts` mode: the ticket's user session is checked again while the connection is open, so signing out
        // (or a password change revoking other sessions) also ends connections opened before, e.g. with a ticket a
        // hostile proxied page copied.
        let watch = (state.config.access_mode == AccessMode::Accounts).then(|| (state.clone(), ticket.session_ref));
        state.tasks.spawn(
            async move {
                let _slot = slot;
                let _active = active;
                let upgraded = match on_upgrade.await {
                    Ok(u) => u,
                    Err(e) => {
                        tracing::debug!(error = %e, "the client did not complete the upgrade");
                        return;
                    }
                };
                gw.stats.total.fetch_add(1, Ordering::Relaxed);
                let started = Instant::now();
                let relayed = relay::relay(upgraded, stream, rest, gw.zero_copy(), &gw.stats.relay);
                let grace = async {
                    shutdown.cancelled().await;
                    tokio::time::sleep(SHUTDOWN_GRACE).await;
                };
                let session_ended = async {
                    let Some((state, session_ref)) = &watch else { return std::future::pending().await };
                    loop {
                        tokio::time::sleep(gw.sessions.ttl).await;
                        // A database error keeps the connection: only a definite "not live" ends it.
                        if let Ok(false) = gw.sessions.live(state, *session_ref).await {
                            return;
                        }
                    }
                };
                let secs = || started.elapsed().as_secs_f64();
                tokio::select! {
                    r = relayed => match r {
                        Ok(t) => tracing::debug!(up = t.up, down = t.down, zero_copy = t.zero_copy, secs = secs(), "Wisp connection closed"),
                        Err(e) => tracing::debug!(error = %e, secs = secs(), "Wisp connection ended with an error"),
                    },
                    () = grace => tracing::debug!(secs = secs(), "Wisp connection closed at shutdown"),
                    () = session_ended => tracing::debug!(secs = secs(), "Wisp connection closed: its user session ended"),
                }
            }
            .instrument(span),
        );
        res
    }
}

/// Error code (503, ticket probe): the route's upstream is marked down by the health job.
pub const UPSTREAM_UNAVAILABLE: &str = "wisp_upstream_unavailable";
/// `Retry-After` of [`UPSTREAM_UNAVAILABLE`]: the probe asks for an early health round (at most every 10 s), so its
/// result is known by then.
pub const UPSTREAM_RETRY_AFTER: Duration = Duration::from_secs(10);

/// Error code (401): no ticket in the URL.
pub const TICKET_MISSING: &str = "wisp_ticket_missing";
/// Error code (401): malformed, forged, tampered, minted by another server or under another access policy, or
/// more than one `t` parameter.
pub const TICKET_INVALID: &str = "wisp_ticket_invalid";
/// Error code (401): the ticket's expiry has passed.
pub const TICKET_EXPIRED: &str = "wisp_ticket_expired";
/// Error code (401, `accounts` mode): the user session the ticket was minted for was revoked or expired.
pub const TICKET_REVOKED: &str = "wisp_ticket_revoked";

/// Why the URL carries no usable ticket text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TicketParamError {
    Missing,
    /// Several `t` parameters, an invalid percent-encoding or an oversized value.
    Invalid,
}

impl TicketParamError {
    fn error(self) -> ApiError {
        match self {
            Self::Missing => ApiError::new(
                StatusCode::UNAUTHORIZED,
                TICKET_MISSING,
                "a Wisp ticket is required (?t=<ticket>&/, from POST /api/wisp/ticket)",
            ),
            Self::Invalid => ApiError::new(StatusCode::UNAUTHORIZED, TICKET_INVALID, "invalid Wisp ticket parameter"),
        }
    }
}

/// The ticket text of the single `t` query parameter (API.md "Wisp").
///
/// The canonical form is `?t=<ticket>&/`: libcurl-based transports refuse a Wisp URL that does not end in `/`, and
/// the empty-key `/` pair is ignored. `?t=<ticket>/` is also accepted: exactly one trailing `/` is stripped from the
/// raw value (tickets never contain `/`), so `?t=<ticket>//` stays invalid. Then the value is percent-decoded (a
/// decoded `/` is not stripped). Other parameters are ignored; more than one `t` is refused as ambiguous.
fn ticket_param(query: Option<&str>) -> Result<std::borrow::Cow<'_, str>, TicketParamError> {
    let mut found = None;
    for pair in query.unwrap_or("").split('&') {
        if let Some(v) = pair.strip_prefix("t=") {
            if found.is_some() {
                return Err(TicketParamError::Invalid);
            }
            found = Some(v);
        }
    }
    let raw = found.ok_or(TicketParamError::Missing)?;
    let raw = raw.strip_suffix('/').unwrap_or(raw);
    if raw.is_empty() {
        return Err(TicketParamError::Missing);
    }
    // Every ticket character may be percent-encoded at most (3 bytes each).
    if raw.len() > 3 * ticket::MAX_LEN {
        return Err(TicketParamError::Invalid);
    }
    percent_encoding::percent_decode_str(raw).decode_utf8().map_err(|_| TicketParamError::Invalid)
}

/// A request that does not try to upgrade: a `GET` or `HEAD` without an `Upgrade` header (a ticket probe).
fn is_probe(req: &Request) -> bool {
    matches!(*req.method(), Method::GET | Method::HEAD) && !req.headers().contains_key(header::UPGRADE)
}

/// Exactly one `Origin`, equal to the proxy origin (in single-origin mode the app origin of the request).
fn check_origin(state: &AppState, client: &ClientInfo, headers: &HeaderMap) -> Result<(), ApiError> {
    let mut values = headers.get_all(header::ORIGIN).iter();
    let (Some(origin), None) = (values.next(), values.next()) else {
        return Err(ApiError::forbidden("Wisp connections need the proxy origin's Origin header"));
    };
    let expected = origins::proxy_origin(&state.config, client);
    let got = origin.to_str().ok().and_then(normalize_origin);
    match (got, expected) {
        (Some(got), Some(expected)) if got == expected => Ok(()),
        _ => Err(ApiError::forbidden("origin not allowed for Wisp connections")),
    }
}

/// Longest forwarded header value we accept (HolyWisp keeps 511 characters and an 8 KiB head).
const MAX_FORWARDED_VALUE: usize = 1024;

/// All values of `name` joined with `, ` (list semantics), trimmed; visible ASCII and spaces only.
fn forwarded_text(headers: &HeaderMap, name: header::HeaderName, max: usize) -> Result<Option<String>, ApiError> {
    let mut out = String::new();
    for value in headers.get_all(&name) {
        let bytes = value.as_bytes();
        if !bytes.iter().all(|b| (0x20..0x7f).contains(b) || *b == b'\t') {
            return Err(ApiError::bad_request(format!("{name}: only visible ASCII is forwarded")));
        }
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(text);
    }
    if out.len() > max {
        return Err(ApiError::bad_request(format!("{name} is too long")));
    }
    Ok((!out.is_empty()).then_some(out))
}

fn has_token(list: &str, token: &str) -> bool {
    list.split(',').any(|t| t.trim().eq_ignore_ascii_case(token))
}

fn upgrade_required(message: &'static str, with_version: bool) -> Box<Response> {
    let mut res = ApiError::upgrade_required(message).into_response();
    res.headers_mut().insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    if with_version {
        res.headers_mut().insert(header::SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));
    }
    Box::new(res)
}

/// Validate the client's upgrade (HTTP/1.1, RFC 6455 headers) and collect what is forwarded.
fn forwarded_upgrade(req: &Request) -> Result<ForwardedUpgrade, Box<Response>> {
    let bad = |e: ApiError| Box::new(e.into_response());
    // RFC 6455 §4.1: a GET. (The route also answers HEAD, which must never become an upgrade.)
    if req.version() != Version::HTTP_11 || req.method() != Method::GET {
        return Err(upgrade_required("Wisp needs an HTTP/1.1 GET WebSocket upgrade", false));
    }
    let h = req.headers();
    let upgrade = forwarded_text(h, header::UPGRADE, 64).map_err(bad)?;
    let connection = forwarded_text(h, header::CONNECTION, 128).map_err(bad)?;
    let (Some(upgrade), Some(connection)) = (upgrade, connection) else {
        return Err(upgrade_required("Wisp needs a WebSocket upgrade (Upgrade: websocket)", false));
    };
    if !has_token(&upgrade, "websocket") || !has_token(&connection, "upgrade") {
        return Err(upgrade_required("Wisp needs a WebSocket upgrade (Upgrade: websocket)", false));
    }
    let version = forwarded_text(h, header::SEC_WEBSOCKET_VERSION, 16).map_err(bad)?;
    if version.as_deref() != Some("13") {
        return Err(upgrade_required("unsupported WebSocket version (13 is required)", true));
    }
    let key = forwarded_text(h, header::SEC_WEBSOCKET_KEY, 64).map_err(bad)?;
    let key = key
        .filter(|k| k.len() == 24 && STANDARD.decode(k).is_ok_and(|raw| raw.len() == 16))
        .ok_or_else(|| bad(ApiError::bad_request("invalid Sec-WebSocket-Key")))?;
    let protocol = forwarded_text(h, header::SEC_WEBSOCKET_PROTOCOL, MAX_FORWARDED_VALUE).map_err(bad)?;
    let extensions = forwarded_text(h, header::SEC_WEBSOCKET_EXTENSIONS, MAX_FORWARDED_VALUE).map_err(bad)?;
    let path = req.uri().path();
    if path.len() > 256 || !path.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(bad(ApiError::bad_request("invalid path")));
    }
    Ok(ForwardedUpgrade {
        path: path.to_string(),
        upgrade,
        connection,
        key,
        version: "13".into(),
        protocol,
        extensions,
    })
}

/// `POST /api/wisp/ticket` (API.md).
async fn mint_ticket(
    State(state): State<AppState>,
    Ext(gw): Ext<Gateway>,
    client: ClientInfo,
    sink: Option<Extension<CookieSink>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let now = now_s();
    let mut set_cookie = None;
    let (session_ref, rate_key, session_expires_s) = match state.config.access_mode {
        AccessMode::Accounts => {
            let sink = sink.as_ref().map(|Extension(s)| s);
            let user = resolve_user(&state, &headers, &client, sink).await?.ok_or_else(ApiError::login_required)?;
            let exp = u64::try_from(user.expires_at / 1000).unwrap_or(0);
            (SessionRef::for_user(&user.token_hash), user.session_key(), exp)
        }
        mode => {
            let anon = match (resolve_anon(&state, &headers, &client), mode) {
                (Some(anon), _) => anon,
                (None, AccessMode::Open) => {
                    enforce(&state, RateClass::SessionCreate, client.ip, None)?;
                    let (token, anon) = state.anon_key.issue(None, now);
                    let secure = cookies_secure(&state, &client);
                    let name = SessionCookie::Anonymous.name(secure);
                    set_cookie = Some(cookies::set(name, &token, crate::auth::anon::ANON_TTL_S, secure));
                    anon
                }
                (None, _) => {
                    return Err(ApiError::access_code_required("an access code is required: POST /api/session first"));
                }
            };
            (SessionRef::for_anonymous(&anon.id), SessionKey::derive(anon.id.as_bytes()), anon.expires_at_s)
        }
    };
    enforce(&state, RateClass::WispTicket, client.ip, Some(rate_key))?;
    let expires_at_s = (now + u64::from(state.config.wisp_ticket_ttl_s)).min(session_expires_s);
    if expires_at_s <= now {
        return Err(ApiError::unauthorized("the session has expired"));
    }
    let origin = origins::proxy_origin(&state.config, &client)
        .ok_or_else(|| ApiError::bad_request("cannot tell which origin this request used (no Host header)"))?;
    let body = json!({
        "ticket": gw.tickets.mint(session_ref, expires_at_s),
        "expires_at": expires_at_s.saturating_mul(1000),
        "wisp_url": origins::websocket_url(&origin, "/wisp/"),
    });
    let mut res = Json(body).into_response();
    if let Some(cookie) = set_cookie {
        res.headers_mut().append(header::SET_COOKIE, cookie);
    }
    Ok(res)
}

async fn wisp_direct(State(state): State<AppState>, Ext(gw): Ext<Gateway>, req: Request) -> Response {
    gw.upgrade(state, None, req).await
}

async fn wisp_profile(
    State(state): State<AppState>,
    Ext(gw): Ext<Gateway>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    gw.upgrade(state, Some(id), req).await
}

/// The gateway module (tickets on the app role, `/wisp/*` on the proxy role, upstream health).
pub struct WispModule {
    gw: Arc<Gateway>,
}

/// Build the gateway and publish its state; returns the module to mount.
pub fn install(setup: &mut ModuleSetup<'_>, options: GatewayOptions) -> Arc<dyn Module> {
    let gw = setup.provide(Gateway::new(setup.state, options));
    Arc::new(WispModule { gw })
}

impl Module for WispModule {
    fn name(&self) -> &'static str {
        "wisp"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/api/wisp/ticket", post(mint_ticket))
    }

    fn proxy_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/wisp/", get(wisp_direct)).route("/wisp/p/{id}/", get(wisp_profile))
    }

    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![
            Job::new(HEALTH_JOB, PROBE_INTERVAL, |state| async move {
                let gw = state.ext::<Gateway>().ok_or("gateway state missing")?;
                gw.upstreams.probe_all().await;
                Ok(())
            })
            .first_run_after(Duration::from_secs(1)),
        ]
    }

    fn health(&self, _state: &AppState, health: &mut Health) {
        for u in self.gw.upstreams.all() {
            health.wisp.insert(u.id.clone(), u.status().0);
        }
    }

    fn diagnostics<'a>(&'a self, state: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let gw = &self.gw;
            let s = &gw.stats;
            let (clients, sessions) = gw.caps.holders();
            let rejected: serde_json::Map<String, Value> =
                Reject::ALL.iter().map(|r| (r.name().to_string(), Value::from(s.rejected(*r)))).collect();
            out.insert(
                "ws".into(),
                json!({
                    "active": s.active(),
                    "total": s.total(),
                    "bytes_up": s.relay.up.load(Ordering::Relaxed),
                    "bytes_down": s.relay.down.load(Ordering::Relaxed),
                    "zero_copy": gw.zero_copy(),
                    "zero_copy_unavailable": gw.zero_copy.as_ref().err(),
                    "relays": {
                        "zero_copy": s.relay.zero_copy.load(Ordering::Relaxed),
                        "copy": s.relay.copied.load(Ordering::Relaxed),
                    },
                    "clients": clients,
                    "sessions": sessions,
                    "limits": {"per_ip": state.config.max_ws_per_ip, "per_session": state.config.max_ws_per_session},
                    "rejected": rejected,
                    "probes": {
                        "valid": s.probes().0,
                        "rejected": s.probes().1,
                        "upstream_down": s.probes_upstream_down(),
                    },
                }),
            );
            let upstreams: Vec<Value> =
                gw.upstreams.all().iter().map(|u| serde_json::to_value(u.report()).unwrap_or(Value::Null)).collect();
            out.insert("upstreams".into(), Value::Array(upstreams));
        })
    }

    fn metrics(&self, _state: &AppState, w: &mut String) {
        let s = &self.gw.stats;
        let _ = writeln!(w, "# HELP gnome_ws_connections_active Wisp WebSocket connections being relayed.");
        let _ = writeln!(w, "# TYPE gnome_ws_connections_active gauge");
        let _ = writeln!(w, "gnome_ws_connections_active {}", s.active());
        let _ = writeln!(w, "# HELP gnome_ws_connections_total Wisp WebSocket connections relayed since start.");
        let _ = writeln!(w, "# TYPE gnome_ws_connections_total counter");
        let _ = writeln!(w, "gnome_ws_connections_total {}", s.total());
        let _ = writeln!(w, "# HELP gnome_ws_relays_total Relayed connections by path (zero_copy = splice).");
        let _ = writeln!(w, "# TYPE gnome_ws_relays_total counter");
        let _ =
            writeln!(w, "gnome_ws_relays_total{{path=\"zero_copy\"}} {}", s.relay.zero_copy.load(Ordering::Relaxed));
        let _ = writeln!(w, "gnome_ws_relays_total{{path=\"copy\"}} {}", s.relay.copied.load(Ordering::Relaxed));
        let _ = writeln!(w, "# HELP gnome_ws_bytes_total Bytes relayed (up = browser to HolyWisp).");
        let _ = writeln!(w, "# TYPE gnome_ws_bytes_total counter");
        let _ = writeln!(w, "gnome_ws_bytes_total{{direction=\"up\"}} {}", s.relay.up.load(Ordering::Relaxed));
        let _ = writeln!(w, "gnome_ws_bytes_total{{direction=\"down\"}} {}", s.relay.down.load(Ordering::Relaxed));
        let _ = writeln!(w, "# HELP gnome_ws_rejected_total Wisp upgrades refused, by reason.");
        let _ = writeln!(w, "# TYPE gnome_ws_rejected_total counter");
        for r in Reject::ALL {
            let _ = writeln!(w, "gnome_ws_rejected_total{{reason=\"{}\"}} {}", r.name(), s.rejected(r));
        }
        let _ = writeln!(w, "# HELP gnome_ws_probes_total Wisp ticket probes (plain GETs), by answer.");
        let _ = writeln!(w, "# TYPE gnome_ws_probes_total counter");
        let (valid, refused) = s.probes();
        let _ = writeln!(w, "gnome_ws_probes_total{{result=\"valid\"}} {valid}");
        let _ = writeln!(w, "gnome_ws_probes_total{{result=\"rejected\"}} {refused}");
        let _ = writeln!(w, "gnome_ws_probes_total{{result=\"upstream_down\"}} {}", s.probes_upstream_down());
        let _ = writeln!(w, "# HELP gnome_wisp_upstream_up Whether the last probe of a Wisp upstream succeeded.");
        let _ = writeln!(w, "# TYPE gnome_wisp_upstream_up gauge");
        for u in self.gw.upstreams.all() {
            let up = u.status().0 == crate::api::meta::UpstreamStatus::Up;
            let _ = writeln!(w, "gnome_wisp_upstream_up{{id=\"{}\"}} {}", u.id, u8::from(up));
        }
        let _ =
            writeln!(w, "# HELP gnome_wisp_upstream_latency_seconds Time to the first Wisp frame in the last probe.");
        let _ = writeln!(w, "# TYPE gnome_wisp_upstream_latency_seconds gauge");
        for u in self.gw.upstreams.all() {
            if let Some(ms) = u.report().latency_ms {
                let _ = writeln!(w, "gnome_wisp_upstream_latency_seconds{{id=\"{}\"}} {}", u.id, ms / 1000.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_query_parameter() {
        use TicketParamError::{Invalid, Missing};
        let p = |q: Option<&str>| ticket_param(q).map(|c| c.into_owned());
        let ok = |s: &str| Ok(s.to_string());
        assert_eq!(p(Some("t=w1.1.a.b")), ok("w1.1.a.b"));
        // The canonical form for libcurl transports (URL ends in '/'), and the trailing-slash form.
        assert_eq!(p(Some("t=w1.1.a.b&/")), ok("w1.1.a.b"));
        assert_eq!(p(Some("t=w1.1.a.b/")), ok("w1.1.a.b"));
        // Exactly one '/' is stripped: the rest stays part of the value (and fails ticket parsing).
        assert_eq!(p(Some("t=w1.1.a.b//")), ok("w1.1.a.b/"));
        assert_eq!(p(Some("t=w1.1.a.b/&/")), ok("w1.1.a.b"));
        // Other parameters are ignored, in any position.
        assert_eq!(p(Some("x=1&t=abc&y=2")), ok("abc"));
        assert_eq!(p(Some("&&t=abc&&/&x")), ok("abc"));
        // Percent-encoding is decoded after the strip; an encoded '/' is not stripped.
        assert_eq!(p(Some("t=w1%2E1%2ea.b&/")), ok("w1.1.a.b"));
        assert_eq!(p(Some("t=abc%2F")), ok("abc/"));
        assert_eq!(p(Some("t=abc%zz")), ok("abc%zz"), "an invalid escape stays literal (and fails parsing)");
        assert_eq!(p(Some("t=abc%FF")), Err(Invalid), "not UTF-8");
        assert_eq!(p(Some(&format!("t={}", "A".repeat(3 * ticket::MAX_LEN + 1)))), Err(Invalid));
        // Ambiguous, missing, empty.
        assert_eq!(p(Some("t=a&t=b")), Err(Invalid));
        assert_eq!(p(Some("t=a&/&t=a")), Err(Invalid));
        assert_eq!(p(Some("t=")), Err(Missing));
        assert_eq!(p(Some("t=/")), Err(Missing));
        assert_eq!(p(Some("t=&/")), Err(Missing));
        assert_eq!(p(Some("tt=a")), Err(Missing));
        assert_eq!(p(Some("T=a")), Err(Missing));
        assert_eq!(p(Some("/")), Err(Missing));
        assert_eq!(p(None), Err(Missing));
    }

    #[test]
    fn every_accepted_url_form_verifies_and_the_others_do_not() {
        let key = TicketKey::new(
            &crate::security::secret_key::SecretKey::from_bytes(vec![7; 32]).unwrap(),
            AccessMode::Open,
            None,
        );
        let t = key.mint(SessionRef([3; 16]), now_s() + 600);
        let check = |q: String| ticket_param(Some(&q)).ok().and_then(|raw| key.verify(&raw, now_s()).ok());
        for q in [
            format!("t={t}"),
            format!("t={t}&/"),
            format!("t={t}/"),
            format!("a=b&t={t}&c=d&/"),
            format!("t={}", t.replace('.', "%2E")),
        ] {
            assert!(check(q.clone()).is_some(), "{q}");
        }
        for q in [format!("t={t}//"), format!("t={t}%2F"), format!("t={t}x"), format!("t={t}&t={t}"), format!("t=/{t}")]
        {
            assert!(check(q.clone()).is_none(), "{q}");
        }
    }

    #[test]
    fn probes_are_plain_gets_and_heads() {
        let plain = |m: Method| http::Request::builder().method(m).uri("/wisp/?t=x&/").body(Body::empty()).unwrap();
        assert!(is_probe(&plain(Method::GET)));
        assert!(is_probe(&plain(Method::HEAD)));
        assert!(!is_probe(&plain(Method::POST)));
        assert!(!is_probe(&upgrade_req(GOOD)), "an upgrade is no probe");
        // Any Upgrade header means an upgrade attempt, validated (and refused) as one.
        assert!(!is_probe(&upgrade_req(&[("upgrade", "h2c")])));
        let mut head = upgrade_req(GOOD);
        *head.method_mut() = Method::HEAD;
        assert!(!is_probe(&head));
        assert!(is_probe(&upgrade_req(&[("connection", "upgrade")])), "Connection alone upgrades nothing");
    }

    #[test]
    fn tokens_in_header_lists() {
        assert!(has_token("keep-alive, Upgrade", "upgrade"));
        assert!(has_token("WebSocket", "websocket"));
        assert!(!has_token("upgrades", "upgrade"));
    }

    fn upgrade_req(pairs: &[(&str, &str)]) -> Request {
        let mut b = http::Request::builder().uri("/wisp/?t=x");
        for (k, v) in pairs {
            b = b.header(*k, *v);
        }
        b.body(Body::empty()).unwrap()
    }

    const GOOD: &[(&str, &str)] = &[
        ("upgrade", "websocket"),
        ("connection", "Upgrade"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
    ];

    #[test]
    fn upgrade_validation() {
        let f = forwarded_upgrade(&upgrade_req(GOOD)).unwrap();
        assert_eq!((f.path.as_str(), f.protocol), ("/wisp/", None), "the query (ticket) is not forwarded");
        let mut with = GOOD.to_vec();
        with.push(("sec-websocket-protocol", "wisp-v2"));
        with.push(("sec-websocket-protocol", "other"));
        assert_eq!(forwarded_upgrade(&upgrade_req(&with)).unwrap().protocol.as_deref(), Some("wisp-v2, other"));
        let status = |pairs: &[(&str, &str)]| forwarded_upgrade(&upgrade_req(pairs)).unwrap_err().status();
        assert_eq!(status(&GOOD[1..]), StatusCode::UPGRADE_REQUIRED);
        let mut v8 = GOOD.to_vec();
        v8[2] = ("sec-websocket-version", "8");
        let res = forwarded_upgrade(&upgrade_req(&v8)).unwrap_err();
        assert_eq!(
            (res.status(), res.headers()["sec-websocket-version"].as_bytes()),
            (StatusCode::UPGRADE_REQUIRED, &b"13"[..])
        );
        let mut bad_key = GOOD.to_vec();
        bad_key[3] = ("sec-websocket-key", "short");
        assert_eq!(status(&bad_key), StatusCode::BAD_REQUEST);
        let mut h2c = GOOD.to_vec();
        h2c[0] = ("upgrade", "h2c");
        assert_eq!(status(&h2c), StatusCode::UPGRADE_REQUIRED);
        let mut long = GOOD.to_vec();
        let huge = "x".repeat(2000);
        long.push(("sec-websocket-protocol", &huge));
        assert_eq!(status(&long), StatusCode::BAD_REQUEST);
        let mut http10 = upgrade_req(GOOD);
        *http10.version_mut() = Version::HTTP_10;
        assert_eq!(forwarded_upgrade(&http10).unwrap_err().status(), StatusCode::UPGRADE_REQUIRED);
        // The route answers HEAD too; only a GET is an upgrade.
        for method in [Method::HEAD, Method::POST, Method::CONNECT] {
            let mut other = upgrade_req(GOOD);
            *other.method_mut() = method.clone();
            assert_eq!(forwarded_upgrade(&other).unwrap_err().status(), StatusCode::UPGRADE_REQUIRED, "{method}");
        }
    }

    #[test]
    fn obs_text_is_never_forwarded() {
        let mut req = upgrade_req(GOOD);
        req.headers_mut().insert("sec-websocket-protocol", HeaderValue::from_bytes(b"wisp\xff").unwrap());
        assert_eq!(forwarded_upgrade(&req).unwrap_err().status(), StatusCode::BAD_REQUEST);
    }
}
