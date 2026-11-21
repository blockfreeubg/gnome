//! Lock-free HTTP counters for diagnostics and Prometheus.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

/// Upper bounds (seconds) of the request-duration histogram.
pub const DURATION_BUCKETS: [f64; 11] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

#[derive(Debug)]
pub struct Metrics {
    requests: AtomicU64,
    by_status: Box<[AtomicU64]>,
    in_flight: AtomicI64,
    /// Non-cumulative counts per bucket; the last slot is `+Inf`.
    duration_buckets: [AtomicU64; DURATION_BUCKETS.len() + 1],
    duration_sum_us: AtomicU64,
    connections_active: AtomicI64,
    connections_total: AtomicU64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            requests: AtomicU64::new(0),
            by_status: (0..600).map(|_| AtomicU64::new(0)).collect(),
            in_flight: AtomicI64::new(0),
            duration_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            duration_sum_us: AtomicU64::new(0),
            connections_active: AtomicI64::new(0),
            connections_total: AtomicU64::new(0),
        }
    }
}

impl Metrics {
    /// A request entered the server (in-flight gauge +1). Pair with [`Metrics::request_ended`].
    pub fn request_started(&self) {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
    }

    /// A request left the server, answered or not (in-flight gauge −1).
    pub fn request_ended(&self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }

    /// Count a response (`499` = the client went away before it).
    pub fn request_finished(&self, status: u16, elapsed: Duration) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        if let Some(slot) = self.by_status.get(usize::from(status)) {
            slot.fetch_add(1, Ordering::Relaxed);
        }
        let secs = elapsed.as_secs_f64();
        let idx = DURATION_BUCKETS.iter().position(|b| secs <= *b).unwrap_or(DURATION_BUCKETS.len());
        self.duration_buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.duration_sum_us.fetch_add(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    pub fn connection_opened(&self) {
        self.connections_active.fetch_add(1, Ordering::Relaxed);
        self.connections_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn connection_closed(&self) {
        self.connections_active.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn requests(&self) -> u64 {
        self.requests.load(Ordering::Relaxed)
    }

    pub fn in_flight(&self) -> i64 {
        self.in_flight.load(Ordering::Relaxed)
    }

    pub fn connections_active(&self) -> i64 {
        self.connections_active.load(Ordering::Relaxed)
    }

    pub fn connections_total(&self) -> u64 {
        self.connections_total.load(Ordering::Relaxed)
    }

    /// Non-zero status counters.
    pub fn by_status(&self) -> BTreeMap<u16, u64> {
        self.by_status
            .iter()
            .enumerate()
            .filter_map(|(code, n)| {
                let n = n.load(Ordering::Relaxed);
                (n > 0).then(|| (u16::try_from(code).unwrap_or(0), n))
            })
            .collect()
    }

    /// Prometheus exposition of the HTTP metrics.
    pub fn render_prometheus(&self, out: &mut String) {
        let _ = writeln!(out, "# HELP gnome_http_requests_total HTTP requests served on the public listener.");
        let _ = writeln!(out, "# TYPE gnome_http_requests_total counter");
        for (code, n) in self.by_status() {
            let _ = writeln!(out, "gnome_http_requests_total{{status=\"{code}\"}} {n}");
        }
        let _ = writeln!(out, "# HELP gnome_http_requests_in_flight Requests currently being handled.");
        let _ = writeln!(out, "# TYPE gnome_http_requests_in_flight gauge");
        let _ = writeln!(out, "gnome_http_requests_in_flight {}", self.in_flight());
        let _ = writeln!(out, "# HELP gnome_http_request_duration_seconds Time to produce the response head.");
        let _ = writeln!(out, "# TYPE gnome_http_request_duration_seconds histogram");
        let mut cumulative = 0u64;
        for (i, bound) in DURATION_BUCKETS.iter().enumerate() {
            cumulative += self.duration_buckets[i].load(Ordering::Relaxed);
            let _ = writeln!(out, "gnome_http_request_duration_seconds_bucket{{le=\"{bound}\"}} {cumulative}");
        }
        cumulative += self.duration_buckets[DURATION_BUCKETS.len()].load(Ordering::Relaxed);
        let _ = writeln!(out, "gnome_http_request_duration_seconds_bucket{{le=\"+Inf\"}} {cumulative}");
        let sum = self.duration_sum_us.load(Ordering::Relaxed) as f64 / 1e6;
        let _ = writeln!(out, "gnome_http_request_duration_seconds_sum {sum}");
        let _ = writeln!(out, "gnome_http_request_duration_seconds_count {cumulative}");
        let _ = writeln!(out, "# HELP gnome_http_connections_active Open client connections (public listener).");
        let _ = writeln!(out, "# TYPE gnome_http_connections_active gauge");
        let _ = writeln!(out, "gnome_http_connections_active {}", self.connections_active());
        let _ = writeln!(out, "# HELP gnome_http_connections_total Accepted client connections (public listener).");
        let _ = writeln!(out, "# TYPE gnome_http_connections_total counter");
        let _ = writeln!(out, "gnome_http_connections_total {}", self.connections_total());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_histogram() {
        let m = Metrics::default();
        for (status, elapsed) in
            [(200, Duration::from_millis(3)), (404, Duration::from_millis(30)), (200, Duration::from_secs(20))]
        {
            m.request_started();
            assert_eq!(m.in_flight(), 1);
            m.request_finished(status, elapsed);
            m.request_ended();
        }
        assert_eq!(m.requests(), 3);
        assert_eq!(m.in_flight(), 0);
        assert_eq!(m.by_status(), BTreeMap::from([(200, 2), (404, 1)]));
        let mut out = String::new();
        m.render_prometheus(&mut out);
        assert!(out.contains("gnome_http_requests_total{status=\"200\"} 2"));
        assert!(out.contains("gnome_http_request_duration_seconds_bucket{le=\"0.005\"} 1"));
        assert!(out.contains("gnome_http_request_duration_seconds_bucket{le=\"0.05\"} 2"));
        assert!(out.contains("gnome_http_request_duration_seconds_bucket{le=\"+Inf\"} 3"));
        assert!(out.contains("gnome_http_request_duration_seconds_count 3"));
    }
}
