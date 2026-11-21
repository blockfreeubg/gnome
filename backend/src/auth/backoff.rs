//! Progressive per-username login backoff (API.md: after 5 failures within 15 minutes).
//!
//! Failures are counted per lowercased username regardless of client IP (so distributed guessing is slowed too).
//! From the 5th failure in a 15-minute window, further attempts are refused until `30 s × 2^(failures − 5)` (capped
//! at 15 minutes) has passed since the last failure. A successful login clears the record.
//!
//! An attempt is counted when it *starts* ([`LoginBackoff::begin`], one atomic check-and-count), and only a password
//! that checks out takes it back ([`LoginBackoff::succeeded`]). Counting after the slow Argon2 verification instead
//! would let a burst of concurrent guesses all pass the check before the first failure is recorded.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const WINDOW: Duration = Duration::from_secs(15 * 60);
pub const FREE_FAILURES: u32 = 5;
const BASE_DELAY: Duration = Duration::from_secs(30);
const MAX_DELAY: Duration = Duration::from_secs(15 * 60);
const MAX_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Copy)]
struct Record {
    failures: u32,
    /// Most recent counted attempt.
    last: Instant,
}

#[derive(Debug, Default)]
pub struct LoginBackoff {
    map: Mutex<HashMap<String, Record>>,
}

fn delay_for(failures: u32) -> Duration {
    if failures < FREE_FAILURES {
        return Duration::ZERO;
    }
    let exp = (failures - FREE_FAILURES).min(16);
    BASE_DELAY.saturating_mul(1 << exp).min(MAX_DELAY)
}

impl Record {
    /// The failure streak is over: the last failure is older than the window (and therefore than any lock).
    fn lapsed(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last) > WINDOW.max(delay_for(self.failures))
    }
}

impl LoginBackoff {
    /// Start a password check for `username`: `Err(wait)` while the username is locked; otherwise the attempt is
    /// counted as a failure until [`LoginBackoff::succeeded`] is called for it.
    pub fn begin(&self, username: &str, now: Instant) -> Result<(), Duration> {
        let key = username.to_ascii_lowercase();
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = map.get(&key).filter(|r| !r.lapsed(now)) {
            let until = r.last + delay_for(r.failures);
            if now < until {
                return Err(until - now);
            }
        }
        if map.len() >= MAX_ENTRIES && !map.contains_key(&key) {
            map.retain(|_, r| !r.lapsed(now));
        }
        let r = map.entry(key).or_insert(Record { failures: 0, last: now });
        if r.lapsed(now) {
            *r = Record { failures: 0, last: now };
        }
        r.failures = r.failures.saturating_add(1);
        r.last = now;
        Ok(())
    }

    /// The password checked out: forget the username's failures (including the attempt [`LoginBackoff::begin`]
    /// counted).
    pub fn succeeded(&self, username: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&username.to_ascii_lowercase());
    }

    /// Drop records whose window and lock have both lapsed. Returns how many.
    pub fn evict(&self, now: Instant) -> usize {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let before = map.len();
        map.retain(|_, r| !r.lapsed(now));
        before - map.len()
    }

    pub fn len(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One attempt that turns out to be wrong (it stays counted).
    fn fail(b: &LoginBackoff, name: &str, at: Instant) -> Result<(), Duration> {
        b.begin(name, at)
    }

    #[test]
    fn progressive_lock() {
        let b = LoginBackoff::default();
        let t0 = Instant::now();
        for i in 0..5 {
            fail(&b, if i % 2 == 0 { "Alice" } else { "ALICE" }, t0 + Duration::from_secs(i)).unwrap();
        }
        // The fifth failure (at t0+4s) locks the name for 30 s.
        assert_eq!(b.begin("alice", t0 + Duration::from_secs(4)).unwrap_err(), Duration::from_secs(30));
        assert_eq!(b.begin("alice", t0 + Duration::from_secs(10)).unwrap_err(), Duration::from_secs(24));
        assert!(b.begin("bob", t0).is_ok(), "other usernames unaffected");
        // Refused attempts are not counted; the next allowed one is, and doubles the lock.
        fail(&b, "alice", t0 + Duration::from_secs(34)).unwrap();
        assert_eq!(b.begin("alice", t0 + Duration::from_secs(34)).unwrap_err(), Duration::from_secs(60));
        b.succeeded("Alice");
        assert!(b.begin("alice", t0 + Duration::from_secs(35)).is_ok(), "success clears the record");
    }

    #[test]
    fn concurrent_attempts_cannot_outrun_the_count() {
        // Attempts are counted when they start, so a burst gets exactly the free attempts, however slow the
        // verification of each one is.
        let b = LoginBackoff::default();
        let t0 = Instant::now();
        let started = (0..50).filter(|_| b.begin("victim", t0).is_ok()).count();
        assert_eq!(started, FREE_FAILURES as usize);
        // A correct password among them clears the lock for the real user.
        b.succeeded("victim");
        assert!(b.begin("victim", t0).is_ok());
    }

    #[test]
    fn delay_is_capped_and_records_expire() {
        assert_eq!(delay_for(4), Duration::ZERO);
        assert_eq!(delay_for(5), Duration::from_secs(30));
        assert_eq!(delay_for(40), MAX_DELAY);
        let b = LoginBackoff::default();
        let t0 = Instant::now();
        for _ in 0..5 {
            fail(&b, "carol", t0).unwrap();
        }
        assert!(b.begin("carol", t0).is_err());
        assert_eq!(b.evict(t0 + Duration::from_secs(60)), 0);
        assert_eq!(b.evict(t0 + WINDOW + Duration::from_secs(1)), 1);
        assert!(b.is_empty());
        // A streak that lapsed starts over.
        for _ in 0..4 {
            fail(&b, "dave", t0).unwrap();
        }
        let later = t0 + WINDOW + Duration::from_secs(1);
        for _ in 0..4 {
            fail(&b, "dave", later).unwrap();
        }
        assert!(b.begin("dave", later).is_ok(), "only four failures in the new window");
    }
}
