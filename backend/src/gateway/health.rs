//! Upstream health: a job probes every Wisp upstream (the direct HolyWisp and each VPN profile) with a TCP connect +
//! WebSocket handshake + first Wisp frame ([`super::upstream::probe`]) every [`PROBE_INTERVAL`]. Results feed
//! `/api/health` (`wisp.<id>`), `/api/vpn/locations` and `/admin/diagnostics` (`upstreams`). Status comes only from
//! these probes; a result older than [`STALE_AFTER`] counts as down (the probe loop itself is stuck).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Serialize;

use super::upstream::{UpstreamAddr, probe};
use crate::api::meta::UpstreamStatus;
use crate::util::now_ms;

/// Time between probe rounds.
pub const PROBE_INTERVAL: Duration = Duration::from_secs(60);
/// Budget of one probe (connect, handshake, first frame).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// A result older than this is reported as down.
pub const STALE_AFTER: Duration = Duration::from_secs(3 * 60);
/// A failed real connection asks for an early probe at most this often.
const EARLY_PROBE_MIN_GAP_MS: i64 = 10_000;

/// Id of the primary HolyWisp instance (`GNOME_WISP_UPSTREAM`).
pub const DIRECT: &str = "direct";

/// The last probe of one upstream.
#[derive(Debug, Clone, Default)]
struct Probe {
    ok: Option<bool>,
    checked_at: Option<i64>,
    latency_ms: Option<f64>,
    error: Option<String>,
}

/// One upstream as reported in diagnostics.
#[derive(Debug, Clone, Serialize)]
pub struct UpstreamReport {
    pub id: String,
    pub addr: String,
    pub status: UpstreamStatus,
    pub latency_ms: Option<f64>,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
}

/// A Wisp upstream and its latest probe result.
#[derive(Debug)]
pub struct Upstream {
    pub id: String,
    pub addr: UpstreamAddr,
    last: RwLock<Probe>,
}

impl Upstream {
    pub fn new(id: impl Into<String>, addr: UpstreamAddr) -> Self {
        Self { id: id.into(), addr, last: RwLock::default() }
    }

    /// `(status, checked_at)` as of now (stale results count as down).
    pub fn status(&self) -> (UpstreamStatus, Option<i64>) {
        self.status_at(now_ms())
    }

    fn status_at(&self, now: i64) -> (UpstreamStatus, Option<i64>) {
        let last = self.last.read().unwrap_or_else(|e| e.into_inner());
        let status = match (last.ok, last.checked_at) {
            (None, _) | (_, None) => UpstreamStatus::Unknown,
            (Some(_), Some(at)) if now.saturating_sub(at) > STALE_AFTER.as_millis() as i64 => UpstreamStatus::Down,
            (Some(true), _) => UpstreamStatus::Up,
            (Some(false), _) => UpstreamStatus::Down,
        };
        (status, last.checked_at)
    }

    pub fn report(&self) -> UpstreamReport {
        let (status, checked_at) = self.status();
        let last = self.last.read().unwrap_or_else(|e| e.into_inner());
        UpstreamReport {
            id: self.id.clone(),
            addr: self.addr.to_string(),
            status,
            latency_ms: last.latency_ms,
            checked_at,
            error: last.error.clone(),
        }
    }

    fn record(&self, result: &Result<Duration, String>, at: i64) {
        let mut last = self.last.write().unwrap_or_else(|e| e.into_inner());
        *last = match result {
            Ok(latency) => Probe {
                ok: Some(true),
                checked_at: Some(at),
                latency_ms: Some((latency.as_micros() as f64 / 1000.0 * 10.0).round() / 10.0),
                error: None,
            },
            Err(e) => Probe { ok: Some(false), checked_at: Some(at), latency_ms: None, error: Some(e.clone()) },
        };
    }

    /// Probe now and record the result.
    pub async fn probe_now(&self) {
        let result = probe(&self.addr, PROBE_TIMEOUT).await;
        let previous = self.status().0;
        self.record(&result, now_ms());
        match (&result, previous) {
            (Err(e), UpstreamStatus::Up | UpstreamStatus::Unknown) => {
                tracing::warn!(upstream = %self.id, addr = %self.addr, error = %e, "Wisp upstream is down");
            }
            (Ok(_), UpstreamStatus::Down) => tracing::info!(upstream = %self.id, "Wisp upstream is up again"),
            (Ok(_), UpstreamStatus::Unknown) => {
                tracing::info!(upstream = %self.id, addr = %self.addr, "Wisp upstream is up")
            }
            _ => {}
        }
    }
}

/// Every upstream, `direct` first.
#[derive(Debug)]
pub struct Upstreams {
    list: Vec<Arc<Upstream>>,
    last_early_probe: AtomicI64,
}

impl Upstreams {
    pub fn new(list: Vec<Arc<Upstream>>) -> Self {
        Self { list, last_early_probe: AtomicI64::new(i64::MIN / 2) }
    }

    pub fn all(&self) -> &[Arc<Upstream>] {
        &self.list
    }

    pub fn get(&self, id: &str) -> Option<&Arc<Upstream>> {
        self.list.iter().find(|u| u.id == id)
    }

    /// Probe every upstream concurrently.
    pub async fn probe_all(&self) {
        let probes = self.list.iter().map(|u| u.probe_now());
        futures_join_all(probes).await;
    }

    /// Whether an early probe may run now (a real connection just failed); rate-limited.
    pub fn claim_early_probe(&self) -> bool {
        let now = now_ms();
        let last = self.last_early_probe.load(Ordering::Relaxed);
        now.saturating_sub(last) >= EARLY_PROBE_MIN_GAP_MS
            && self.last_early_probe.compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
    }
}

/// Await every future (small fan-out; avoids a dependency for `join_all`).
async fn futures_join_all<F: std::future::Future<Output = ()>>(futures: impl Iterator<Item = F>) {
    let mut set = Vec::new();
    for f in futures {
        set.push(Box::pin(f));
    }
    std::future::poll_fn(|cx| {
        let mut pending = false;
        set.retain_mut(|f| match f.as_mut().poll(cx) {
            std::task::Poll::Ready(()) => false,
            std::task::Poll::Pending => {
                pending = true;
                true
            }
        });
        if pending { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upstream() -> Upstream {
        Upstream::new(DIRECT, UpstreamAddr::parse("127.0.0.1:6001").unwrap())
    }

    #[test]
    fn statuses() {
        let u = upstream();
        assert_eq!(u.status(), (UpstreamStatus::Unknown, None));
        u.record(&Ok(Duration::from_micros(1234)), 1_000_000);
        assert_eq!(u.status_at(1_000_500), (UpstreamStatus::Up, Some(1_000_000)));
        assert_eq!(u.report().latency_ms, Some(1.2));
        let stale = 1_000_000 + STALE_AFTER.as_millis() as i64 + 1;
        assert_eq!(u.status_at(stale).0, UpstreamStatus::Down, "stale results are down");
        u.record(&Err("refused".into()), 2_000_000);
        assert_eq!(u.status_at(2_000_001).0, UpstreamStatus::Down);
        assert_eq!(u.report().error.as_deref(), Some("refused"));
    }

    #[tokio::test]
    async fn probing_a_closed_port_marks_it_down() {
        // Bind and drop to find a free port nothing listens on.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let ups = Upstreams::new(vec![Arc::new(Upstream::new(
            DIRECT,
            UpstreamAddr::parse(&format!("127.0.0.1:{port}")).unwrap(),
        ))]);
        ups.probe_all().await;
        let r = ups.get(DIRECT).unwrap().report();
        assert_eq!(r.status, UpstreamStatus::Down);
        assert!(r.error.unwrap().contains("unreachable"));
        assert!(ups.claim_early_probe());
        assert!(!ups.claim_early_probe(), "early probes are rate-limited");
    }
}
