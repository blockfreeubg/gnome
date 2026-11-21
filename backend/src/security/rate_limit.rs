//! Token-bucket rate limiting keyed by client IP and/or session, per route class.
//!
//! * Buckets live in a sharded map (`SHARDS` × `Mutex<HashMap>`, SipHash with a random key) so concurrent requests
//!   rarely contend and keys cannot be chosen to collide.
//! * IPv6 clients are keyed by their /64 (one subscriber usually controls a whole /64).
//! * A periodic job ([`RateLimiter::evict`]) drops buckets that have refilled completely; each shard is also capped.
//!   A shard that is full of active buckets drops the fullest ones first: flooding the limiter with fresh keys
//!   cannot push out (and so reset) a bucket that is actually exhausted.
//! * All limits are multiplied by `GNOME_RATE_LIMIT_SCALE` (0 disables limiting).
//!
//! The class table in [`RateClass::limits`] is the single source of truth and is mirrored in docs/API.md.

use std::collections::HashMap;
use std::hash::{BuildHasher, RandomState};
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use super::client::canonical_ip;
use crate::error::ApiError;
use crate::state::AppState;

const SHARDS: usize = 16;
const MAX_ENTRIES_PER_SHARD: usize = 8192;

/// Steady rate with a burst allowance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    /// Bucket capacity (requests allowed back-to-back).
    pub burst: u32,
    /// Refill rate.
    pub per_minute: u32,
}

/// Route classes. Add a class here (and to API.md) rather than hard-coding numbers in handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RateClass {
    /// Baseline for every `/api/*` request.
    Api,
    /// `POST /api/session`.
    SessionCreate,
    /// Register, login, password change, account deletion.
    Auth,
    /// `/api/sync/*`.
    Sync,
    /// `POST /api/wisp/ticket` (per session), enforced by the Wisp gateway module.
    WispTicket,
    /// Wisp WebSocket upgrades (`/wisp/`), enforced by the Wisp gateway module.
    WispUpgrade,
    /// Every admin-listener request, checked before the token (bounds token guessing on a remote admin listener).
    Admin,
}

impl RateClass {
    pub const ALL: [RateClass; 7] = [
        RateClass::Api,
        RateClass::SessionCreate,
        RateClass::Auth,
        RateClass::Sync,
        RateClass::WispTicket,
        RateClass::WispUpgrade,
        RateClass::Admin,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::SessionCreate => "session_create",
            Self::Auth => "auth",
            Self::Sync => "sync",
            Self::WispTicket => "wisp_ticket",
            Self::WispUpgrade => "wisp_upgrade",
            Self::Admin => "admin",
        }
    }

    fn index(self) -> usize {
        self as usize
    }

    /// `(per client IP, per session)` limits before scaling.
    pub fn limits(self) -> (Option<Rate>, Option<Rate>) {
        const fn r(burst: u32, per_minute: u32) -> Option<Rate> {
            Some(Rate { burst, per_minute })
        }
        match self {
            Self::Api => (r(300, 600), None),
            Self::SessionCreate => (r(20, 20), None),
            Self::Auth => (r(10, 10), None),
            Self::Sync => (r(300, 300), r(60, 120)),
            Self::WispTicket => (None, r(30, 30)),
            Self::WispUpgrade => (r(60, 60), None),
            Self::Admin => (r(60, 120), None),
        }
    }
}

/// Opaque per-session key (anonymous token id or hashed user-session token), 16 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionKey(pub [u8; 16]);

impl SessionKey {
    /// Derive a key from any session identifier bytes.
    pub fn derive(id: &[u8]) -> Self {
        let h = super::crypto::sha256(id);
        let mut k = [0u8; 16];
        k.copy_from_slice(&h[..16]);
        Self(k)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Subject {
    V4(u32),
    V6Prefix(u64),
    Session(SessionKey),
}

impl Subject {
    fn ip(ip: IpAddr) -> Self {
        match canonical_ip(ip) {
            IpAddr::V4(v4) => Self::V4(u32::from(v4)),
            IpAddr::V6(v6) => Self::V6Prefix((u128::from(v6) >> 64) as u64),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    class: RateClass,
    subject: Subject,
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

/// Scaled bucket parameters.
#[derive(Debug, Clone, Copy)]
struct Params {
    capacity: f64,
    per_sec: f64,
}

pub struct RateLimiter {
    shards: Box<[Mutex<HashMap<Key, Bucket>>]>,
    hasher: RandomState,
    scale: f64,
    rejected: [AtomicU64; RateClass::ALL.len()],
}

impl std::fmt::Debug for RateLimiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RateLimiter").field("scale", &self.scale).field("entries", &self.len()).finish()
    }
}

impl RateLimiter {
    pub fn new(scale: f64) -> Self {
        Self {
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
            hasher: RandomState::new(),
            scale,
            rejected: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }

    pub fn enabled(&self) -> bool {
        self.scale > 0.0
    }

    fn params(&self, rate: Rate) -> Params {
        Params {
            capacity: (f64::from(rate.burst) * self.scale).max(1.0),
            per_sec: (f64::from(rate.per_minute) * self.scale / 60.0).max(1e-6),
        }
    }

    /// Check (and consume) the class limits for an IP and optional session. `Err` = retry after this long.
    pub fn check(&self, class: RateClass, ip: IpAddr, session: Option<SessionKey>) -> Result<(), Duration> {
        self.check_at(class, ip, session, Instant::now())
    }

    pub fn check_at(
        &self,
        class: RateClass,
        ip: IpAddr,
        session: Option<SessionKey>,
        now: Instant,
    ) -> Result<(), Duration> {
        if !self.enabled() {
            return Ok(());
        }
        let (per_ip, per_session) = class.limits();
        let result = (|| {
            if let Some(rate) = per_ip {
                self.take(Key { class, subject: Subject::ip(ip) }, self.params(rate), now)?;
            }
            if let (Some(rate), Some(s)) = (per_session, session) {
                self.take(Key { class, subject: Subject::Session(s) }, self.params(rate), now)?;
            }
            Ok(())
        })();
        if result.is_err() {
            self.rejected[class.index()].fetch_add(1, Ordering::Relaxed);
        }
        result
    }

    fn shard(&self, key: &Key) -> &Mutex<HashMap<Key, Bucket>> {
        let idx = (self.hasher.hash_one(key) as usize) % self.shards.len();
        &self.shards[idx]
    }

    fn take(&self, key: Key, p: Params, now: Instant) -> Result<(), Duration> {
        let mut map = self.shard(&key).lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_ENTRIES_PER_SHARD && !map.contains_key(&key) {
            self.evict_shard(&mut map, now);
            if map.len() >= MAX_ENTRIES_PER_SHARD {
                self.drop_fullest(&mut map, now, MAX_ENTRIES_PER_SHARD / 8);
            }
        }
        let bucket = map.entry(key).or_insert(Bucket { tokens: p.capacity, last: now });
        let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * p.per_sec).min(p.capacity);
        bucket.last = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = (1.0 - bucket.tokens) / p.per_sec;
            Err(Duration::from_secs_f64(wait.max(0.001)))
        }
    }

    fn params_for(&self, key: &Key) -> Option<Params> {
        let (per_ip, per_session) = key.class.limits();
        let rate = match key.subject {
            Subject::Session(_) => per_session,
            _ => per_ip,
        }?;
        Some(self.params(rate))
    }

    fn evict_shard(&self, map: &mut HashMap<Key, Bucket>, now: Instant) -> usize {
        let before = map.len();
        map.retain(|key, b| {
            let Some(p) = self.params_for(key) else { return false };
            let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
            b.tokens + elapsed * p.per_sec < p.capacity
        });
        before - map.len()
    }

    /// Bound memory when a shard is full of active buckets: drop the `n` with the most tokens left (relative to
    /// their capacity). They are the closest to an absent bucket, so dropping them loosens limits the least.
    fn drop_fullest(&self, map: &mut HashMap<Key, Bucket>, now: Instant, n: usize) {
        let mut fill: Vec<(f64, Key)> = map
            .iter()
            .map(|(key, b)| {
                let ratio = self.params_for(key).map_or(1.0, |p| {
                    let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
                    ((b.tokens + elapsed * p.per_sec) / p.capacity).min(1.0)
                });
                (ratio, *key)
            })
            .collect();
        let n = n.min(fill.len());
        if n == 0 {
            return;
        }
        fill.select_nth_unstable_by(n - 1, |a, b| b.0.total_cmp(&a.0));
        for (_, key) in &fill[..n] {
            map.remove(key);
        }
    }

    /// Remove buckets that have refilled completely (they behave exactly like absent ones). Returns how many.
    pub fn evict(&self, now: Instant) -> usize {
        self.shards
            .iter()
            .map(|s| {
                let mut map = s.lock().unwrap_or_else(|e| e.into_inner());
                self.evict_shard(&mut map, now)
            })
            .sum()
    }

    /// Number of tracked buckets.
    pub fn len(&self) -> usize {
        self.shards.iter().map(|s| s.lock().unwrap_or_else(|e| e.into_inner()).len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Rejections per class since start.
    pub fn rejected(&self) -> Vec<(RateClass, u64)> {
        RateClass::ALL.iter().map(|c| (*c, self.rejected[c.index()].load(Ordering::Relaxed))).collect()
    }

    pub fn rejected_total(&self) -> u64 {
        self.rejected.iter().map(|a| a.load(Ordering::Relaxed)).sum()
    }
}

/// Enforce a class for a request: `429 rate_limited` with `Retry-After` when exhausted.
pub fn enforce(state: &AppState, class: RateClass, ip: IpAddr, session: Option<SessionKey>) -> Result<(), ApiError> {
    state.limiter.check(class, ip, session).map_err(|wait| {
        tracing::debug!(class = class.name(), "rate limited");
        ApiError::rate_limited(wait)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn burst_then_reject_then_refill() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        let a = ip("192.0.2.1");
        for _ in 0..10 {
            assert!(rl.check_at(RateClass::Auth, a, None, t0).is_ok());
        }
        let wait = rl.check_at(RateClass::Auth, a, None, t0).unwrap_err();
        assert!(wait <= Duration::from_secs(6) && wait >= Duration::from_secs(5), "{wait:?}");
        // Other IPs and classes are independent.
        assert!(rl.check_at(RateClass::Auth, ip("192.0.2.2"), None, t0).is_ok());
        assert!(rl.check_at(RateClass::Api, a, None, t0).is_ok());
        // 10/min refill → one token after 6 s.
        assert!(rl.check_at(RateClass::Auth, a, None, t0 + Duration::from_secs(6)).is_ok());
        assert!(rl.check_at(RateClass::Auth, a, None, t0 + Duration::from_secs(6)).is_err());
        assert_eq!(rl.rejected_total(), 2);
    }

    #[test]
    fn ipv6_is_keyed_by_slash_64() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        for i in 0..10 {
            let addr = ip(&format!("2001:db8:1:2::{i:x}"));
            assert!(rl.check_at(RateClass::Auth, addr, None, t0).is_ok());
        }
        assert!(rl.check_at(RateClass::Auth, ip("2001:db8:1:2:ffff::1"), None, t0).is_err());
        assert!(rl.check_at(RateClass::Auth, ip("2001:db8:1:3::1"), None, t0).is_ok());
    }

    #[test]
    fn session_dimension() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        let s = SessionKey::derive(b"session-a");
        let mut ok = 0;
        for i in 0..100u32 {
            // Different IPs, same session: the per-session bucket (burst 60) is the limit.
            let addr = IpAddr::from(std::net::Ipv4Addr::from(0x0a00_0000 + i));
            if rl.check_at(RateClass::Sync, addr, Some(s), t0).is_ok() {
                ok += 1;
            }
        }
        assert_eq!(ok, 60);
    }

    #[test]
    fn scale_multiplies_and_zero_disables() {
        let rl = RateLimiter::new(2.0);
        let t0 = Instant::now();
        let a = ip("198.51.100.1");
        for _ in 0..20 {
            assert!(rl.check_at(RateClass::Auth, a, None, t0).is_ok());
        }
        assert!(rl.check_at(RateClass::Auth, a, None, t0).is_err());
        let off = RateLimiter::new(0.0);
        for _ in 0..1000 {
            assert!(off.check_at(RateClass::Auth, a, None, t0).is_ok());
        }
        // Tiny scales still allow one request per bucket.
        let tiny = RateLimiter::new(0.01);
        assert!(tiny.check_at(RateClass::Auth, a, None, t0).is_ok());
    }

    #[test]
    fn class_table_is_complete() {
        for (i, class) in RateClass::ALL.iter().enumerate() {
            assert_eq!(class.index(), i, "ALL is in declaration order");
            let (ip, session) = class.limits();
            assert!(ip.is_some() || session.is_some(), "{} limits something", class.name());
        }
        // `wisp_ticket` has only a per-session bucket: 30 tickets per session, whichever IP asks.
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        let s = SessionKey::derive(b"ticket-session");
        for _ in 0..30 {
            assert!(rl.check_at(RateClass::WispTicket, ip("192.0.2.30"), Some(s), t0).is_ok());
        }
        assert!(rl.check_at(RateClass::WispTicket, ip("192.0.2.31"), Some(s), t0).is_err(), "30 per session");
    }

    #[test]
    fn flooding_the_limiter_cannot_reset_an_exhausted_bucket() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        let attacker = ip("192.0.2.66");
        for _ in 0..10 {
            rl.check_at(RateClass::Auth, attacker, None, t0).unwrap();
        }
        assert!(rl.check_at(RateClass::Auth, attacker, None, t0).is_err());
        // Enough fresh keys (other IPv6 /64s) to overflow every shard many times over.
        for i in 0..(SHARDS * MAX_ENTRIES_PER_SHARD * 2) as u64 {
            let addr = IpAddr::V6(std::net::Ipv6Addr::from((0x2001_0db8_u128 << 96) | (u128::from(i) << 64)));
            let _ = rl.check_at(RateClass::Auth, addr, None, t0);
        }
        assert!(rl.len() <= SHARDS * MAX_ENTRIES_PER_SHARD, "memory stays bounded: {}", rl.len());
        assert!(rl.check_at(RateClass::Auth, attacker, None, t0).is_err(), "the exhausted bucket survived the flood");
    }

    #[test]
    fn concurrent_checks_never_exceed_the_burst() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        let allowed = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..200 {
                        if rl.check_at(RateClass::Auth, ip("192.0.2.55"), None, t0).is_ok() {
                            allowed.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            }
        });
        assert_eq!(allowed.load(Ordering::Relaxed), 10, "exactly the burst, however the threads interleave");
        assert_eq!(rl.rejected_total(), 8 * 200 - 10);
    }

    #[test]
    fn eviction_drops_refilled_buckets_only() {
        let rl = RateLimiter::new(1.0);
        let t0 = Instant::now();
        rl.check_at(RateClass::Auth, ip("192.0.2.10"), None, t0).unwrap();
        rl.check_at(RateClass::SessionCreate, ip("192.0.2.11"), None, t0).unwrap();
        assert_eq!(rl.len(), 2);
        assert_eq!(rl.evict(t0), 0);
        // Auth refills one token in 6 s; session-create in 3 s.
        assert_eq!(rl.evict(t0 + Duration::from_secs(4)), 1);
        assert_eq!(rl.evict(t0 + Duration::from_secs(7)), 1);
        assert!(rl.is_empty());
    }
}
