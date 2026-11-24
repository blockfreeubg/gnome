//! A log-linear latency histogram (≈ 3 % relative error, 32 sub-buckets per power of two), mergeable by adding
//! counts. `bench/lib/stats.mjs` decodes the same bucket index.
use std::collections::BTreeMap;

#[derive(Default, Clone, Debug, PartialEq)]
pub struct Hist {
    pub counts: BTreeMap<u32, u64>,
}

pub fn bucket(v: u64) -> u32 {
    if v < 32 {
        return v as u32;
    }
    let e = 63 - v.leading_zeros();
    let m = (v >> (e - 5)) - 32;
    32 + (e - 5) * 32 + m as u32
}

pub fn lower_bound(idx: u32) -> u64 {
    if idx < 32 {
        return u64::from(idx);
    }
    let e = (idx - 32) / 32 + 5;
    let m = u64::from((idx - 32) % 32);
    (32 + m) << (e - 5)
}

impl Hist {
    pub fn record(&mut self, ns: u64) {
        *self.counts.entry(bucket(ns)).or_insert(0) += 1;
    }
    pub fn merge(&mut self, other: &Hist) {
        for (k, v) in &other.counts {
            *self.counts.entry(*k).or_insert(0) += v;
        }
    }
    pub fn total(&self) -> u64 {
        self.counts.values().sum()
    }
    pub fn quantile(&self, q: f64) -> u64 {
        let n = self.total();
        if n == 0 {
            return 0;
        }
        let want = ((q * n as f64).ceil() as u64).clamp(1, n);
        let mut seen = 0;
        for (k, v) in &self.counts {
            seen += v;
            if seen >= want {
                return lower_bound(*k);
            }
        }
        0
    }
    pub fn to_json(&self) -> String {
        let parts: Vec<String> = self.counts.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
        format!("{{{}}}", parts.join(","))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn buckets_are_monotonic_and_close() {
        let mut last = 0;
        for v in (0..2_000_000u64).step_by(7) {
            let b = bucket(v);
            assert!(b >= last);
            last = b;
            let lo = lower_bound(b);
            assert!(lo <= v, "{v} {lo}");
            assert!(v - lo <= v / 32 + 1, "{v} {lo}");
        }
    }
    #[test]
    fn merge_adds_counts() {
        let mut a = Hist::default();
        let mut b = Hist::default();
        for v in 1..=100 {
            a.record(v * 1000);
        }
        for v in 101..=200 {
            b.record(v * 1000);
        }
        a.merge(&b);
        assert_eq!(a.total(), 200);
        let p50 = a.quantile(0.5);
        assert!((97_000..=100_000).contains(&p50), "{p50}");
        assert!(a.quantile(1.0) <= 200_000 && a.quantile(1.0) >= 194_000);
    }
}
