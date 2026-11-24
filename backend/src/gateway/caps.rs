//! Concurrent Wisp connections per client IP (IPv6 per /64, like the rate limiter) and per session
//! (`GNOME_MAX_WS_PER_IP`, `GNOME_MAX_WS_PER_SESSION`). A [`CapGuard`] holds one slot of each and releases both when
//! dropped, whatever ends the connection (normal close, error, panic, shutdown, a rejected upgrade).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use super::ticket::SessionRef;
use crate::limits::{Tier, TierGuard, TieredCounter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapExceeded {
    /// The client's address (IPv6: /64), or its /56 (4×) or /48 (16×) (WAVE-D D18).
    Ip(Tier),
    Session,
}

/// Shared per-IP and per-session counters (cheap to clone).
#[derive(Debug, Clone)]
pub struct Caps {
    by_ip: TieredCounter,
    max_per_session: u32,
    by_session: Arc<Mutex<HashMap<SessionRef, u32>>>,
}

impl Caps {
    pub fn new(max_per_ip: u32, max_per_session: u32) -> Self {
        Self { by_ip: TieredCounter::new(max_per_ip, true), max_per_session, by_session: Arc::default() }
    }

    /// Take one slot for `ip` (and its prefixes) and one for `session`, or say which cap is full.
    pub fn acquire(&self, ip: IpAddr, session: SessionRef) -> Result<CapGuard, CapExceeded> {
        let ip_slot = self.by_ip.acquire(ip).map_err(CapExceeded::Ip)?;
        let mut c = self.by_session.lock().unwrap_or_else(|e| e.into_inner());
        if c.get(&session).copied().unwrap_or(0) >= self.max_per_session {
            return Err(CapExceeded::Session);
        }
        *c.entry(session).or_insert(0) += 1;
        Ok(CapGuard { _ip: ip_slot, by_session: self.by_session.clone(), session })
    }

    /// Connections currently holding a slot.
    pub fn active(&self) -> u32 {
        self.by_ip.active()
    }

    /// Distinct (client keys at every tier, sessions) holding slots.
    pub fn holders(&self) -> (usize, usize) {
        (self.by_ip.holders(), self.by_session.lock().unwrap_or_else(|e| e.into_inner()).len())
    }
}

/// One connection's slots; dropping it releases them.
#[derive(Debug)]
pub struct CapGuard {
    _ip: TierGuard,
    by_session: Arc<Mutex<HashMap<SessionRef, u32>>>,
    session: SessionRef,
}

impl Drop for CapGuard {
    fn drop(&mut self) {
        let mut c = self.by_session.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = c.get_mut(&self.session) {
            *n -= 1;
            if *n == 0 {
                c.remove(&self.session);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn per_ip_and_per_session_limits() {
        let caps = Caps::new(3, 2);
        let (a, b) = (SessionRef([1; 16]), SessionRef([2; 16]));
        let g1 = caps.acquire(ip("192.0.2.1"), a).unwrap();
        let g2 = caps.acquire(ip("192.0.2.1"), a).unwrap();
        assert_eq!(caps.acquire(ip("192.0.2.9"), a).unwrap_err(), CapExceeded::Session, "2 per session, any IP");
        let g3 = caps.acquire(ip("192.0.2.1"), b).unwrap();
        assert_eq!(caps.acquire(ip("192.0.2.1"), SessionRef([3; 16])).unwrap_err(), CapExceeded::Ip(Tier::Ip));
        assert_eq!(caps.active(), 3);
        drop(g1);
        assert!(caps.acquire(ip("192.0.2.1"), b).is_ok(), "a released slot is reusable (guard dropped at once)");
        drop((g2, g3));
        assert_eq!(caps.active(), 0);
        assert_eq!(caps.holders(), (0, 0), "empty entries are removed");
    }

    #[test]
    fn a_refused_acquire_takes_nothing() {
        let caps = Caps::new(1, 5);
        let _g = caps.acquire(ip("198.51.100.1"), SessionRef([1; 16])).unwrap();
        assert!(caps.acquire(ip("198.51.100.1"), SessionRef([2; 16])).is_err());
        assert_eq!(caps.holders(), (1, 1), "the second session got no slot");
    }

    #[test]
    fn ipv6_shares_a_slash_64() {
        let caps = Caps::new(2, 10);
        let _a = caps.acquire(ip("2001:db8:1:2::1"), SessionRef([1; 16])).unwrap();
        let _b = caps.acquire(ip("2001:db8:1:2::ffff"), SessionRef([2; 16])).unwrap();
        assert_eq!(caps.acquire(ip("2001:db8:1:2:9::9"), SessionRef([3; 16])).unwrap_err(), CapExceeded::Ip(Tier::Ip));
        assert!(caps.acquire(ip("2001:db8:1:3::1"), SessionRef([3; 16])).is_ok());
        let _v4 = caps.acquire(ip("::ffff:192.0.2.1"), SessionRef([4; 16])).unwrap();
        let _v4b = caps.acquire(ip("192.0.2.1"), SessionRef([5; 16])).unwrap();
        assert_eq!(
            caps.acquire(ip("192.0.2.1"), SessionRef([6; 16])).unwrap_err(),
            CapExceeded::Ip(Tier::Ip),
            "mapped = v4"
        );
    }

    #[test]
    fn ipv6_prefix_tiers_are_named() {
        let caps = Caps::new(1, 1000);
        let mut held = Vec::new();
        for n in 0..4u8 {
            held.push(caps.acquire(ip(&format!("2001:db8:5:{n:x}::1")), SessionRef([n; 16])).unwrap());
        }
        let err = caps.acquire(ip("2001:db8:5:4::1"), SessionRef([9; 16])).unwrap_err();
        assert_eq!(err, CapExceeded::Ip(Tier::Prefix56), "4 x 1 per /56");
        assert!(caps.acquire(ip("2001:db8:5:100::1"), SessionRef([9; 16])).is_ok(), "another /56 of the /48");
    }
}
