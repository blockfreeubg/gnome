//! Connection caps, per-client in-flight caps, request-head limits and byte budgets (WAVE-D D18, D19, D22).
//!
//! * **Connection cap**: one permit per connection on the public and proxy listeners together
//!   (`GNOME_MAX_CONNECTIONS`, lowered to (soft `RLIMIT_NOFILE` − 512) ÷ 6 when the descriptor limit cannot carry
//!   it); the admin listener has its own [`ADMIN_CONNECTIONS`]. Without a permit the accept loop still accepts from
//!   the descriptor reserve and answers the hardened `503` with `Retry-After: 1` ([`OVERFLOW_ANSWER`]); at most
//!   [`MAX_OVERFLOW_ANSWERS`] such answers run at once, beyond that the loop waits. An upgraded Wisp connection keeps
//!   its permit ([`ConnHold`]).
//! * **Per peer at accept**: peers outside `GNOME_TRUSTED_PROXIES` hold at most `GNOME_MAX_CONNS_PER_IP`
//!   connections per IPv4 address or IPv6 /64; the excess is closed at once.
//! * **In flight per client** ([`middleware`]): at most `GNOME_MAX_INFLIGHT_PER_IP` requests per client key (the
//!   real client behind a trusted proxy) until the response head is ready; IPv6 clients also per /56 (4×) and /48
//!   (16×). Beyond: `503 unavailable` + `Retry-After: 1`.
//! * **Large heads**: a head over [`SMALL_HEAD`] needs room for twice its size in `GNOME_MAX_INFLIGHT_HEAD_MB` and is
//!   one of at most [`LARGE_HEADS_PER_CLIENT`] per client key; otherwise the hardened `503`.
//! * **Head buffers** ([`max_head_for`]): 1 MiB for trusted peers on the app listener and loopback peers on the
//!   proxy listener, 64 KiB otherwise (hyper answers larger heads with its hardened automatic `431`).
//! * **Sync answers** (D22): a body over [`LARGE_ANSWER`] holds room in the fixed [`ANSWER_BUDGET`] until it is
//!   written; an account runs at most [`PULLS_PER_ACCOUNT`] pulls at once.

use std::collections::HashMap;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http::{HeaderValue, StatusCode, header};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::Config;
use crate::error::ApiError;
use crate::metrics::{LimitCounters, Metrics};
use crate::security::ClientInfo;
use crate::security::client::canonical_ip;
use crate::security::csp::NOTHING_RUNS_UNFRAMED;
use crate::server::Listener;
use crate::state::AppState;

/// Descriptors kept free for overflow answers, the database, pipes and files.
pub const FD_RESERVE: u64 = 512;
/// Descriptors one spliced Wisp connection may use: two sockets and two pipes of two descriptors each.
pub const FDS_PER_CONNECTION: u64 = 6;
/// Connections of the admin listener (its own cap, so operators always get in).
pub const ADMIN_CONNECTIONS: usize = 64;
/// Hardened `503` answers to connections over the cap that may run at once.
pub const MAX_OVERFLOW_ANSWERS: usize = 256;
/// Head buffer of untrusted peers and the admin listener; heads over it count against the large-head budget.
pub const SMALL_HEAD: usize = 64 * 1024;
/// Head buffer of trusted peers on the app listener (and loopback peers on the proxy listener).
pub const LARGE_HEAD: usize = 1024 * 1024;
/// Concurrent requests with a head over [`SMALL_HEAD`] per client key (and 4× per /56, 16× per /48).
pub const LARGE_HEADS_PER_CLIENT: u32 = 4;
/// Wisp upgrades are refused (`429`, `server_full`) once Wisp connections reach this share of the effective cap.
pub const WISP_SHARE_PERCENT: u64 = 90;
/// Sync answers over this size hold room in [`ANSWER_BUDGET`] until written.
pub const LARGE_ANSWER: usize = 1024 * 1024;
/// Byte budget of large sync answers being written.
pub const ANSWER_BUDGET: usize = 64 * 1024 * 1024;
/// Concurrent sync pulls per account.
pub const PULLS_PER_ACCOUNT: u32 = 2;
/// A full connection cap is logged at most this often.
const CAP_FULL_LOG_EVERY: Duration = Duration::from_secs(10);

/// The raw answer to a connection over the cap: written before any request is read, then the connection closes.
pub const OVERFLOW_ANSWER: &str = "HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\
     retry-after: 1\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\nreferrer-policy: no-referrer\r\n\
     content-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n";

/// The address level a cap applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// An IPv4 address or an IPv6 /64.
    Ip,
    /// An IPv6 /56 (4× the limit).
    Prefix56,
    /// An IPv6 /48 (16× the limit).
    Prefix48,
}

impl Tier {
    pub const ALL: [Tier; 3] = [Tier::Ip, Tier::Prefix56, Tier::Prefix48];

    /// Label in metrics and error bodies.
    pub fn name(self) -> &'static str {
        match self {
            Self::Ip => "ip",
            Self::Prefix56 => "prefix56",
            Self::Prefix48 => "prefix48",
        }
    }

    pub fn describe(self) -> &'static str {
        match self {
            Self::Ip => "this address",
            Self::Prefix56 => "this /56 network",
            Self::Prefix48 => "this /48 network",
        }
    }

    fn multiplier(self) -> u32 {
        match self {
            Self::Ip => 1,
            Self::Prefix56 => 4,
            Self::Prefix48 => 16,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Key {
    V4(u32),
    /// Prefix length and the masked upper 64 bits.
    V6(u8, u64),
}

/// The keys `ip` counts under: its /64 (or IPv4 address) and, with `tiers`, its /56 and /48.
fn keys_of(ip: IpAddr, tiers: bool) -> Vec<(Key, Tier)> {
    match canonical_ip(ip) {
        IpAddr::V4(v4) => vec![(Key::V4(u32::from(v4)), Tier::Ip)],
        IpAddr::V6(v6) => {
            let hi = (u128::from(v6) >> 64) as u64;
            let mut keys = vec![(Key::V6(64, hi), Tier::Ip)];
            if tiers {
                keys.push((Key::V6(56, hi & !0xff), Tier::Prefix56));
                keys.push((Key::V6(48, hi & !0xffff), Tier::Prefix48));
            }
            keys
        }
    }
}

/// Concurrent holders per client key, with the IPv6 prefix tiers.
#[derive(Debug, Clone)]
pub struct TieredCounter {
    limit: u32,
    tiers: bool,
    counts: Arc<Mutex<HashMap<Key, u32>>>,
}

impl TieredCounter {
    pub fn new(limit: u32, tiers: bool) -> Self {
        Self { limit, tiers, counts: Arc::default() }
    }

    pub fn limit(&self) -> u32 {
        self.limit
    }

    /// One slot for `ip` at every tier, or the first tier that is full.
    pub fn acquire(&self, ip: IpAddr) -> Result<TierGuard, Tier> {
        let keys = keys_of(ip, self.tiers);
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        for (key, tier) in &keys {
            if counts.get(key).copied().unwrap_or(0) >= self.limit.saturating_mul(tier.multiplier()) {
                return Err(*tier);
            }
        }
        for (key, _) in &keys {
            *counts.entry(*key).or_insert(0) += 1;
        }
        Ok(TierGuard { counts: self.counts.clone(), keys: keys.into_iter().map(|(k, _)| k).collect() })
    }

    /// Distinct keys holding slots (all tiers).
    pub fn holders(&self) -> usize {
        self.counts.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Slots held at the first tier (connections or requests).
    pub fn active(&self) -> u32 {
        let counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        counts.iter().filter(|(k, _)| matches!(k, Key::V4(_) | Key::V6(64, _))).map(|(_, n)| *n).sum()
    }
}

/// A slot of a [`TieredCounter`]; released on drop.
#[derive(Debug)]
pub struct TierGuard {
    counts: Arc<Mutex<HashMap<Key, u32>>>,
    keys: Vec<Key>,
}

impl Drop for TierGuard {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        for key in &self.keys {
            if let Some(n) = counts.get_mut(key) {
                *n -= 1;
                if *n == 0 {
                    counts.remove(key);
                }
            }
        }
    }
}

/// A fixed number of bytes shared by everyone.
#[derive(Debug, Clone)]
pub struct ByteBudget {
    cap: usize,
    used: Arc<AtomicUsize>,
}

impl ByteBudget {
    pub fn new(cap: usize) -> Self {
        Self { cap, used: Arc::default() }
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn used(&self) -> usize {
        self.used.load(Ordering::Relaxed)
    }

    /// Room for `bytes`, or `None` when the budget cannot hold them now.
    pub fn take(&self, bytes: usize) -> Option<BudgetGuard> {
        let mut used = self.used.load(Ordering::Acquire);
        loop {
            let total = used.checked_add(bytes).filter(|total| *total <= self.cap)?;
            match self.used.compare_exchange_weak(used, total, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Some(BudgetGuard { used: self.used.clone(), bytes }),
                Err(now) => used = now,
            }
        }
    }
}

/// Room in a [`ByteBudget`]; released on drop.
#[derive(Debug)]
pub struct BudgetGuard {
    used: Arc<AtomicUsize>,
    bytes: usize,
}

impl Drop for BudgetGuard {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// What a connection holds while it is open: its cap permit and its per-peer slot.
#[derive(Debug)]
pub struct ConnSlot {
    pub permit: OwnedSemaphorePermit,
    pub peer: Option<TierGuard>,
}

/// The connection's [`ConnSlot`], put in every request's extensions so an upgrade handler can take it into the
/// upgraded connection's task (the hyper connection task ends at the upgrade).
#[derive(Debug, Clone, Default)]
pub struct ConnHold(Arc<Mutex<Option<ConnSlot>>>);

impl ConnHold {
    pub fn new(slot: ConnSlot) -> Self {
        Self(Arc::new(Mutex::new(Some(slot))))
    }

    pub fn take(&self) -> Option<ConnSlot> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// The read-buffer cap of the request's connection ([`max_head_for`]). hyper refuses heads beyond it only after
/// one more read (up to about twice the cap); [`middleware`] refuses everything over the cap exactly.
#[derive(Debug, Clone, Copy)]
pub struct HeadCap(pub usize);

/// What the accept loop does with a new connection.
#[derive(Debug)]
pub enum Admission {
    Serve(ConnSlot),
    /// Over the cap: answer [`OVERFLOW_ANSWER`] while holding this overflow slot.
    Overflow(OwnedSemaphorePermit),
    /// The peer has `GNOME_MAX_CONNS_PER_IP` connections open: close at once.
    Refuse,
}

/// Every cap and budget of the process.
#[derive(Debug)]
pub struct Limits {
    pub max_connections: u32,
    pub effective: u32,
    conns: Arc<Semaphore>,
    admin: Arc<Semaphore>,
    overflow: Arc<Semaphore>,
    per_peer: TieredCounter,
    inflight: TieredCounter,
    large_heads: TieredCounter,
    pub head_budget: ByteBudget,
    pub answer_budget: ByteBudget,
    pulls: Mutex<HashMap<i64, u32>>,
    full_since: Mutex<Option<Instant>>,
    last_full_log: Mutex<Option<Instant>>,
    https_hosts: Vec<String>,
    https_warned: AtomicBool,
}

/// `min(max, (soft − 512) ÷ 6)`, at least 16 (the smallest configurable cap).
pub fn effective_cap(max: u32, soft_nofile: Option<u64>) -> u32 {
    match soft_nofile {
        Some(soft) => {
            let fit = soft.saturating_sub(FD_RESERVE) / FDS_PER_CONNECTION;
            u64::from(max).min(fit.max(16)) as u32
        }
        None => max,
    }
}

impl Limits {
    /// Caps from `config` and the process's current soft descriptor limit (after startup's raise).
    pub fn new(config: &Config) -> Self {
        let soft = crate::server::fd_limit::current().and_then(|(soft, _)| soft);
        Self::with_fd_limit(config, soft)
    }

    pub fn with_fd_limit(config: &Config, soft_nofile: Option<u64>) -> Self {
        let effective = effective_cap(config.max_connections, soft_nofile);
        if effective < config.max_connections {
            tracing::warn!(
                configured = config.max_connections,
                effective,
                fd_limit = ?soft_nofile,
                "GNOME_MAX_CONNECTIONS lowered to fit the file-descriptor limit ((limit - 512) / 6); raise LimitNOFILE= \
                 to allow more"
            );
        }
        let https_hosts = config
            .public_origins
            .iter()
            .chain(config.proxy_origin.iter())
            .filter_map(|o| o.strip_prefix("https://"))
            .map(str::to_ascii_lowercase)
            .collect();
        Self {
            max_connections: config.max_connections,
            effective,
            conns: Arc::new(Semaphore::new(effective as usize)),
            admin: Arc::new(Semaphore::new(ADMIN_CONNECTIONS)),
            overflow: Arc::new(Semaphore::new(MAX_OVERFLOW_ANSWERS)),
            per_peer: TieredCounter::new(config.max_conns_per_ip, false),
            inflight: TieredCounter::new(config.max_inflight_per_ip, true),
            large_heads: TieredCounter::new(LARGE_HEADS_PER_CLIENT, true),
            head_budget: ByteBudget::new(config.max_inflight_head_mb as usize * 1024 * 1024),
            answer_budget: ByteBudget::new(ANSWER_BUDGET),
            pulls: Mutex::default(),
            full_since: Mutex::default(),
            last_full_log: Mutex::default(),
            https_hosts,
            https_warned: AtomicBool::new(false),
        }
    }

    /// Connections open on the public and proxy listeners.
    pub fn active(&self) -> usize {
        self.effective as usize - self.conns.available_permits()
    }

    /// Wisp connections allowed before upgrades are refused (`server_full`).
    pub fn wisp_share(&self) -> i64 {
        (u64::from(self.effective) * WISP_SHARE_PERCENT / 100).max(1) as i64
    }

    pub fn per_ip_max(&self) -> u32 {
        self.per_peer.limit()
    }

    pub fn inflight_per_ip_max(&self) -> u32 {
        self.inflight.limit()
    }

    /// Admit a connection from `peer_ip` on `listener`; `trusted`: the peer is in `GNOME_TRUSTED_PROXIES`.
    /// `Overflow` may wait for an overflow slot (the accept loop pauses then).
    pub async fn admit(&self, listener: Listener, peer_ip: IpAddr, trusted: bool, metrics: &Metrics) -> Admission {
        if listener == Listener::Admin {
            return match self.admin.clone().try_acquire_owned() {
                Ok(permit) => Admission::Serve(ConnSlot { permit, peer: None }),
                Err(_) => self.overflow(metrics).await,
            };
        }
        let peer = if trusted {
            None
        } else {
            match self.per_peer.acquire(peer_ip) {
                Ok(g) => Some(g),
                Err(_) => {
                    LimitCounters::bump(&metrics.limits.refused_per_ip);
                    return Admission::Refuse;
                }
            }
        };
        match self.conns.clone().try_acquire_owned() {
            Ok(permit) => {
                self.cap_free(metrics);
                Admission::Serve(ConnSlot { permit, peer })
            }
            Err(_) => {
                drop(peer);
                self.cap_full();
                self.overflow(metrics).await
            }
        }
    }

    async fn overflow(&self, metrics: &Metrics) -> Admission {
        LimitCounters::bump(&metrics.limits.overflow_answered);
        match self.overflow.clone().acquire_owned().await {
            Ok(slot) => Admission::Overflow(slot),
            Err(_) => Admission::Refuse,
        }
    }

    fn cap_full(&self) {
        let now = Instant::now();
        self.full_since.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(now);
        let mut last = self.last_full_log.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_none_or(|at| at.elapsed() >= CAP_FULL_LOG_EVERY) {
            *last = Some(now);
            tracing::warn!(
                cap = self.effective,
                "connection cap full: new connections get 503 (GNOME_MAX_CONNECTIONS, LimitNOFILE=)"
            );
        }
    }

    fn cap_free(&self, metrics: &Metrics) {
        let mut since = self.full_since.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(at) = since.take() {
            let ms = u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX);
            metrics.limits.cap_full_ms.fetch_add(ms, Ordering::Relaxed);
        }
    }

    /// Seconds the cap has been full, including a current full period.
    pub fn cap_full_seconds(&self, metrics: &Metrics) -> f64 {
        let current =
            self.full_since.lock().unwrap_or_else(|e| e.into_inner()).map_or(0, |at| at.elapsed().as_millis());
        (LimitCounters::get(&metrics.limits.cap_full_ms) as f64 + current as f64) / 1000.0
    }

    /// Room for a head of `size` bytes from `ip` (twice its size, one of [`LARGE_HEADS_PER_CLIENT`]).
    pub fn take_large_head(&self, ip: IpAddr, size: usize) -> Option<(TierGuard, BudgetGuard)> {
        let slot = self.large_heads.acquire(ip).ok()?;
        let room = self.head_budget.take(size.saturating_mul(2))?;
        Some((slot, room))
    }

    /// One of the account's [`PULLS_PER_ACCOUNT`] concurrent sync pulls.
    pub fn pull(self: &Arc<Self>, user_id: i64) -> Option<PullGuard> {
        let mut pulls = self.pulls.lock().unwrap_or_else(|e| e.into_inner());
        let n = pulls.entry(user_id).or_insert(0);
        if *n >= PULLS_PER_ACCOUNT {
            return None;
        }
        *n += 1;
        Some(PullGuard { limits: self.clone(), user_id })
    }

    /// Count (and warn once about) a request for an `https://` origin from a peer outside `GNOME_TRUSTED_PROXIES`.
    fn note_proxy_trust(&self, client: &ClientInfo, metrics: &Metrics) {
        if client.via_trusted_proxy || self.https_hosts.is_empty() {
            return;
        }
        let Some(host) = client.host.as_deref() else { return };
        if !self.https_hosts.iter().any(|h| h == host) {
            return;
        }
        LimitCounters::bump(&metrics.limits.untrusted_https);
        if !self.https_warned.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                peer = %client.peer.ip(),
                "a request for an https:// origin came from a peer outside GNOME_TRUSTED_PROXIES: add your TLS front's \
                 address to GNOME_TRUSTED_PROXIES (logged once; counted in /admin/diagnostics proxy_trust)"
            );
        }
    }
}

/// One concurrent sync pull of an account; released on drop.
#[derive(Debug)]
pub struct PullGuard {
    limits: Arc<Limits>,
    user_id: i64,
}

impl Drop for PullGuard {
    fn drop(&mut self) {
        let mut pulls = self.limits.pulls.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = pulls.get_mut(&self.user_id) {
            *n -= 1;
            if *n == 0 {
                pulls.remove(&self.user_id);
            }
        }
    }
}

/// hyper's read-buffer cap for a connection from a peer on `listener` (D19).
/// The public listener follows the app's rule in single-origin mode too.
pub fn max_head_for(listener: Listener, peer_ip: IpAddr, trusted: bool) -> usize {
    let large = match listener {
        Listener::Admin => false,
        Listener::Public => trusted,
        Listener::Proxy => canonical_ip(peer_ip).is_loopback(),
    };
    if large { LARGE_HEAD } else { SMALL_HEAD }
}

/// Size of a request head as sent: the request line, every header line and the blank line.
pub fn head_size<B>(req: &http::Request<B>) -> usize {
    let uri = req.uri();
    let target = uri.path_and_query().map_or(1, |pq| pq.as_str().len())
        + uri.scheme_str().map_or(0, |s| s.len() + 3)
        + uri.authority().map_or(0, |a| a.as_str().len());
    let line = req.method().as_str().len() + 1 + target + 1 + 8 + 2;
    let headers: usize = req.headers().iter().map(|(n, v)| n.as_str().len() + 2 + v.len() + 2).sum();
    line + headers + 2
}

/// The hardened `503` (nothing in it may run, load or be framed) with `Retry-After: 1`.
pub fn hardened_503() -> Response {
    hardened(StatusCode::SERVICE_UNAVAILABLE, true)
}

/// The hardened `431` of a head over its connection's cap (or a Wisp upgrade's over 64 KiB).
pub fn hardened_431() -> Response {
    hardened(StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE, false)
}

fn hardened(status: StatusCode, retry: bool) -> Response {
    let mut res = Response::new(axum::body::Body::empty());
    *res.status_mut() = status;
    let h = res.headers_mut();
    if retry {
        h.insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    }
    h.insert(header::CONNECTION, HeaderValue::from_static("close"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(NOTHING_RUNS_UNFRAMED));
    res
}

/// Per-client in-flight cap and the large-head budget; a layer right inside `observe` (needs [`ClientInfo`]).
pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let client = req.extensions().get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
    let limits = &state.limits;
    limits.note_proxy_trust(&client, &state.metrics);
    let _inflight = match limits.inflight.acquire(client.ip) {
        Ok(g) => g,
        Err(tier) => {
            let i = Tier::ALL.iter().position(|t| *t == tier).unwrap_or(0);
            LimitCounters::bump(&state.metrics.limits.inflight_refused[i]);
            return ApiError::unavailable(format!("too many requests in progress from {}", tier.describe()))
                .with_retry_after(Duration::from_secs(1))
                .with_extra("tier", serde_json::Value::from(tier.name()))
                .into_response();
        }
    };
    let size = head_size(&req);
    if req.extensions().get::<HeadCap>().is_some_and(|cap| size > cap.0) {
        return hardened_431();
    }
    let _large = if size > SMALL_HEAD {
        match limits.take_large_head(client.ip, size) {
            Some(g) => Some(g),
            None => {
                LimitCounters::bump(&state.metrics.limits.large_head_refused);
                return hardened_503();
            }
        }
    } else {
        None
    };
    next.run(req).await
}

/// A response body that holds a [`BudgetGuard`] (and a [`PullGuard`]) until it is fully written or dropped.
pub struct GuardedBody {
    data: Option<Bytes>,
    _room: Option<BudgetGuard>,
    _pull: Option<PullGuard>,
}

impl GuardedBody {
    pub fn new(data: Bytes, room: Option<BudgetGuard>, pull: Option<PullGuard>) -> Self {
        Self { data: Some(data), _room: room, _pull: pull }
    }
}

impl hyper::body::Body for GuardedBody {
    type Data = Bytes;
    type Error = std::convert::Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Self::Error>>> {
        match self.data.take() {
            Some(data) if !data.is_empty() => Poll::Ready(Some(Ok(hyper::body::Frame::data(data)))),
            _ => {
                // Written: release the room now rather than when hyper drops the body.
                self._room = None;
                self._pull = None;
                Poll::Ready(None)
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.data.as_ref().is_none_or(Bytes::is_empty)
    }

    fn size_hint(&self) -> hyper::body::SizeHint {
        hyper::body::SizeHint::with_exact(self.data.as_ref().map_or(0, |d| d.len() as u64))
    }
}

/// A JSON answer of a sync pull: bodies over [`LARGE_ANSWER`] take room in the answer budget until written;
/// `pull` is held as long. Without room: `503 unavailable` + `Retry-After: 1`.
pub fn sync_answer(state: &AppState, body: Vec<u8>, pull: PullGuard) -> Response {
    let room = if body.len() > LARGE_ANSWER {
        match state.limits.answer_budget.take(body.len()) {
            Some(room) => Some(room),
            None => {
                LimitCounters::bump(&state.metrics.limits.answer_refused);
                return ApiError::unavailable("the server is busy sending other large sync answers")
                    .with_retry_after(Duration::from_secs(1))
                    .into_response();
            }
        }
    } else {
        None
    };
    let mut res = Response::new(axum::body::Body::new(GuardedBody::new(Bytes::from(body), room, Some(pull))));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

/// `503` for a third concurrent pull of one account.
pub fn too_many_pulls(state: &AppState) -> ApiError {
    LimitCounters::bump(&state.metrics.limits.answer_refused);
    ApiError::unavailable("this account already has sync downloads in progress")
        .with_retry_after(Duration::from_secs(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn effective_cap_follows_the_descriptor_limit() {
        assert_eq!(effective_cap(4096, None), 4096);
        assert_eq!(effective_cap(4096, Some(65_536)), 4096);
        assert_eq!(effective_cap(4096, Some(1024)), (1024 - 512) / 6);
        assert_eq!(effective_cap(4096, Some(100)), 16, "never below the smallest configurable cap");
        assert_eq!(effective_cap(1_000_000, Some(u64::MAX)), 1_000_000);
    }

    #[test]
    fn tiers_apply_to_ipv6_prefixes() {
        let c = TieredCounter::new(2, true);
        // Two /64s of one /56 hold 2 each; the /56 allows 8, so a third /64 of it still gets in.
        let mut held = Vec::new();
        for n in 0..4u32 {
            let addr = format!("2001:db8:0:{n:x}::1");
            held.push(c.acquire(ip(&addr)).unwrap());
            held.push(c.acquire(ip(&addr)).unwrap());
            assert_eq!(c.acquire(ip(&addr)).unwrap_err(), Tier::Ip, "{addr}");
        }
        assert_eq!(c.acquire(ip("2001:db8:0:4::1")).unwrap_err(), Tier::Prefix56, "8 = 4 x 2 per /56");
        // Other /56s of the same /48 until 32 = 16 x 2.
        for n in 1..4u32 {
            for m in 0..4u32 {
                let addr = format!("2001:db8:0:{:x}::1", (n << 8) | m);
                held.push(c.acquire(ip(&addr)).unwrap());
                held.push(c.acquire(ip(&addr)).unwrap());
            }
        }
        assert_eq!(c.acquire(ip("2001:db8:0:400::1")).unwrap_err(), Tier::Prefix48);
        assert!(c.acquire(ip("2001:db8:1::1")).is_ok(), "another /48");
        held.clear();
        assert_eq!(c.holders(), 0, "every slot released");
        // IPv4 addresses have no tiers; v4-mapped addresses count as IPv4.
        let v4 = TieredCounter::new(1, true);
        let _g = v4.acquire(ip("192.0.2.1")).unwrap();
        assert_eq!(v4.acquire(ip("::ffff:192.0.2.1")).unwrap_err(), Tier::Ip);
        assert!(v4.acquire(ip("192.0.2.2")).is_ok());
    }

    #[test]
    fn byte_budget_refuses_past_its_cap_and_releases() {
        let b = ByteBudget::new(100);
        let a = b.take(60).unwrap();
        assert!(b.take(41).is_none());
        let c = b.take(40).unwrap();
        assert_eq!(b.used(), 100);
        drop(a);
        assert!(b.take(60).is_some());
        drop(c);
        assert_eq!(b.used(), 0);
        assert!(b.take(usize::MAX).is_none(), "no overflow");
    }

    #[test]
    fn head_size_counts_line_and_fields() {
        let req = http::Request::builder().uri("/api/session?x=1").header("host", "a.example").body(()).unwrap();
        // "GET /api/session?x=1 HTTP/1.1\r\n" + "host: a.example\r\n" + "\r\n"
        assert_eq!(head_size(&req), 31 + 17 + 2);
    }

    #[test]
    fn head_buffers_per_listener() {
        let lo = ip("127.0.0.1");
        let far = ip("192.0.2.1");
        assert_eq!(max_head_for(Listener::Public, lo, true), LARGE_HEAD);
        assert_eq!(max_head_for(Listener::Public, far, false), SMALL_HEAD);
        assert_eq!(max_head_for(Listener::Public, far, true), LARGE_HEAD, "a trusted front");
        assert_eq!(max_head_for(Listener::Proxy, lo, true), LARGE_HEAD);
        assert_eq!(max_head_for(Listener::Proxy, far, true), SMALL_HEAD, "trusted is not enough on the proxy");
        assert_eq!(max_head_for(Listener::Admin, lo, true), SMALL_HEAD);
    }

    #[test]
    fn the_overflow_answer_is_hardened() {
        assert!(OVERFLOW_ANSWER.contains(&format!("content-security-policy: {NOTHING_RUNS_UNFRAMED}\r\n")));
        assert!(OVERFLOW_ANSWER.contains("retry-after: 1\r\n") && OVERFLOW_ANSWER.ends_with("\r\n\r\n"));
    }
}
