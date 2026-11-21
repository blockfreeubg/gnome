//! Concurrent Wisp connections per client IP (IPv6 per /64, like the rate limiter) and per session
//! (`GNOME_MAX_WS_PER_IP`, `GNOME_MAX_WS_PER_SESSION`). A [`CapGuard`] holds one slot of each and releases both when
//! dropped, whatever ends the connection (normal close, error, panic, shutdown, a rejected upgrade).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use super::ticket::SessionRef;
use crate::security::client::canonical_ip;

/// IPv4 address, or the /64 of an IPv6 address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum IpKey {
    V4(u32),
    V6(u64),
}

impl IpKey {
    fn of(ip: IpAddr) -> Self {
        match canonical_ip(ip) {
            IpAddr::V4(v4) => Self::V4(u32::from(v4)),
            IpAddr::V6(v6) => Self::V6((u128::from(v6) >> 64) as u64),
        }
    }
}

#[derive(Debug, Default)]
struct Counts {
    by_ip: HashMap<IpKey, u32>,
    by_session: HashMap<SessionRef, u32>,
}

/// Which cap refused a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapExceeded {
    Ip,
    Session,
}

/// The connection caps (shared; cheap to clone).
#[derive(Debug, Clone)]
pub struct Caps {
    max_per_ip: u32,
    max_per_session: u32,
    counts: Arc<Mutex<Counts>>,
}

impl Caps {
    pub fn new(max_per_ip: u32, max_per_session: u32) -> Self {
        Self { max_per_ip, max_per_session, counts: Arc::default() }
    }

    /// Take one slot for `ip` and `session`, or refuse without taking any.
    pub fn acquire(&self, ip: IpAddr, session: SessionRef) -> Result<CapGuard, CapExceeded> {
        let ip = IpKey::of(ip);
        let mut c = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if c.by_ip.get(&ip).copied().unwrap_or(0) >= self.max_per_ip {
            return Err(CapExceeded::Ip);
        }
        if c.by_session.get(&session).copied().unwrap_or(0) >= self.max_per_session {
            return Err(CapExceeded::Session);
        }
        *c.by_ip.entry(ip).or_insert(0) += 1;
        *c.by_session.entry(session).or_insert(0) += 1;
        Ok(CapGuard { counts: self.counts.clone(), ip, session })
    }

    /// Connections currently holding a slot.
    pub fn active(&self) -> u32 {
        self.counts.lock().unwrap_or_else(|e| e.into_inner()).by_ip.values().sum()
    }

    /// `(distinct client IPs, distinct sessions)` with open connections.
    pub fn holders(&self) -> (usize, usize) {
        let c = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        (c.by_ip.len(), c.by_session.len())
    }
}

/// One held slot; dropping it releases the slot (and forgets keys that reach zero, so the maps stay small).
#[derive(Debug)]
pub struct CapGuard {
    counts: Arc<Mutex<Counts>>,
    ip: IpKey,
    session: SessionRef,
}

impl Drop for CapGuard {
    fn drop(&mut self) {
        let mut c = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = c.by_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                c.by_ip.remove(&self.ip);
            }
        }
        if let Some(n) = c.by_session.get_mut(&self.session) {
            *n -= 1;
            if *n == 0 {
                c.by_session.remove(&self.session);
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
        assert_eq!(caps.acquire(ip("192.0.2.1"), SessionRef([3; 16])).unwrap_err(), CapExceeded::Ip);
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
        assert_eq!(caps.acquire(ip("2001:db8:1:2:9::9"), SessionRef([3; 16])).unwrap_err(), CapExceeded::Ip);
        assert!(caps.acquire(ip("2001:db8:1:3::1"), SessionRef([3; 16])).is_ok());
        let _v4 = caps.acquire(ip("::ffff:192.0.2.1"), SessionRef([4; 16])).unwrap();
        let _v4b = caps.acquire(ip("192.0.2.1"), SessionRef([5; 16])).unwrap();
        assert_eq!(caps.acquire(ip("192.0.2.1"), SessionRef([6; 16])).unwrap_err(), CapExceeded::Ip, "mapped = v4");
    }
}
