//! Destination IP policy: which addresses server-side fetches may connect to.
//!
//! The classes mirror HolyWisp's egress policy (`src/common/net.c`, `src/server/egress.c`; see
//! `docs/research/holywisp.md` §5.6) so that proxied browsing and GNOME's own server-side fetches refuse the same
//! destinations:
//!
//! | Class | IPv4 | IPv6 | Allowed when |
//! | --- | --- | --- | --- |
//! | [`IpClass::Loopback`] | `127/8` | `::1` | [`IpPolicy::allow_loopback`] |
//! | [`IpClass::Private`] | `10/8`, `172.16/12`, `192.168/16`, CGNAT `100.64/10` | ULA `fc00::/7` | [`IpPolicy::allow_private`] |
//! | [`IpClass::LinkLocal`] | `169.254/16` (incl. cloud metadata `169.254.169.254`) | `fe80::/10` | [`IpPolicy::allow_link_local`] |
//! | [`IpClass::Unspecified`] | `0/8` | `::` | never |
//! | [`IpClass::Multicast`] | `224/4` | `ff00::/8` | never |
//! | [`IpClass::Broadcast`] | `255.255.255.255` | — | never |
//! | [`IpClass::Documentation`] | `192.0.2/24`, `198.51.100/24`, `203.0.113/24` | `2001:db8::/32`, `3fff::/20` | never |
//! | [`IpClass::Benchmarking`] | `198.18/15` | `2001:2::/48` | never |
//! | [`IpClass::Reserved`] | `240/4`, `192.0.0/24`, `192.88.99/24` | `fec0::/10`, `100::/64`, `64:ff9b:1::/48`, `5f00::/16`, the rest of `2001::/23`, everything outside `2000::/3` | never |
//!
//! IPv6 forms that carry an IPv4 address are unwrapped ([`embedded_ipv4`]):
//!
//! * IPv4-mapped `::ffff:a.b.c.d` is classified exactly as `a.b.c.d` (connecting to it *is* connecting to
//!   `a.b.c.d`).
//! * IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and Teredo `2001::/32` (client address,
//!   bit-inverted) take the class of the embedded address when that is not public; **a public embedded address
//!   makes the whole address [`IpClass::Reserved`]** (as in HolyWisp). Tunnelled forms are never needed to reach a
//!   public server, and refusing them closes translation-gateway bypasses.
//!
//! Differences from HolyWisp, all stricter: `192.88.99/24`, `100::/64`, `2001:2::/48`, `64:ff9b:1::/48`,
//! `3fff::/20`, `5f00::/16`, `2001::/23` and IPv6 outside `2000::/3` are refused here (HolyWisp treats some of them
//! as public), and Teredo is unwrapped rather than always reserved (with the default flags both refuse it).

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The class of an IP address under the egress policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IpClass {
    /// Globally routable unicast; always allowed.
    Public,
    /// `127/8`, `::1`.
    Loopback,
    /// RFC 1918, CGNAT `100.64/10`, ULA `fc00::/7`.
    Private,
    /// `169.254/16`, `fe80::/10`.
    LinkLocal,
    /// `0/8`, `::` (on Linux, connecting to `0.0.0.0` reaches the local host).
    Unspecified,
    /// `224/4`, `ff00::/8`.
    Multicast,
    /// `255.255.255.255`.
    Broadcast,
    /// Documentation ranges (RFC 5737, RFC 3849, RFC 9637).
    Documentation,
    /// Benchmarking ranges (`198.18/15`, `2001:2::/48`).
    Benchmarking,
    /// Reserved, special-purpose or tunnelled-public addresses.
    Reserved,
}

impl IpClass {
    /// Short lowercase name used in errors and logs (`"loopback"`, `"link-local"`, ...).
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Loopback => "loopback",
            Self::Private => "private",
            Self::LinkLocal => "link-local",
            Self::Unspecified => "unspecified",
            Self::Multicast => "multicast",
            Self::Broadcast => "broadcast",
            Self::Documentation => "documentation",
            Self::Benchmarking => "benchmarking",
            Self::Reserved => "reserved",
        }
    }
}

impl fmt::Display for IpClass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How an IPv4 address is embedded in an IPv6 address (see [`embedded_ipv4`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Embedding {
    /// `::ffff:a.b.c.d` (IPv4-mapped).
    Mapped,
    /// `::a.b.c.d` (deprecated IPv4-compatible).
    Compatible,
    /// `64:ff9b::a.b.c.d` (NAT64 well-known prefix, RFC 6052).
    Nat64,
    /// `2002:aabb:ccdd::/48` (6to4, RFC 3056).
    SixToFour,
    /// `2001:0:<server>:<flags>:<port>:<client>` (Teredo, RFC 4380); the client address is stored bit-inverted.
    Teredo,
}

/// The IPv4 address carried inside an IPv6 address, if any.
///
/// `::` and `::1` are not treated as IPv4-compatible (they are the IPv6 unspecified and loopback addresses).
pub fn embedded_ipv4(ip: Ipv6Addr) -> Option<(Embedding, Ipv4Addr)> {
    let s = ip.segments();
    let o = ip.octets();
    let low32 = Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    if s[..5] == [0, 0, 0, 0, 0] && s[5] == 0xffff {
        return Some((Embedding::Mapped, low32));
    }
    if s[..6] == [0; 6] {
        let v = u32::from(low32);
        return (v > 1).then_some((Embedding::Compatible, low32));
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some((Embedding::Nat64, low32));
    }
    if s[0] == 0x2002 {
        return Some((Embedding::SixToFour, Ipv4Addr::new(o[2], o[3], o[4], o[5])));
    }
    if s[0] == 0x2001 && s[1] == 0 {
        return Some((Embedding::Teredo, Ipv4Addr::from(!u32::from(low32))));
    }
    None
}

const fn in_v4(ip: u32, net: [u8; 4], prefix: u32) -> bool {
    let net = u32::from_be_bytes(net);
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
    ip & mask == net & mask
}

const fn in_v6(ip: u128, net: u128, prefix: u32) -> bool {
    let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
    ip & mask == net & mask
}

/// Classify an IPv4 address.
pub fn classify_v4(ip: Ipv4Addr) -> IpClass {
    let v = u32::from(ip);
    if in_v4(v, [0, 0, 0, 0], 8) {
        IpClass::Unspecified
    } else if in_v4(v, [127, 0, 0, 0], 8) {
        IpClass::Loopback
    } else if in_v4(v, [10, 0, 0, 0], 8)
        || in_v4(v, [172, 16, 0, 0], 12)
        || in_v4(v, [192, 168, 0, 0], 16)
        || in_v4(v, [100, 64, 0, 0], 10)
    {
        IpClass::Private
    } else if in_v4(v, [169, 254, 0, 0], 16) {
        IpClass::LinkLocal
    } else if v == u32::MAX {
        IpClass::Broadcast
    } else if in_v4(v, [224, 0, 0, 0], 4) {
        IpClass::Multicast
    } else if in_v4(v, [240, 0, 0, 0], 4) || in_v4(v, [192, 0, 0, 0], 24) || in_v4(v, [192, 88, 99, 0], 24) {
        IpClass::Reserved
    } else if in_v4(v, [192, 0, 2, 0], 24) || in_v4(v, [198, 51, 100, 0], 24) || in_v4(v, [203, 0, 113, 0], 24) {
        IpClass::Documentation
    } else if in_v4(v, [198, 18, 0, 0], 15) {
        IpClass::Benchmarking
    } else {
        IpClass::Public
    }
}

/// Classify an IPv6 address (unwrapping embedded IPv4 forms, see the module docs).
pub fn classify_v6(ip: Ipv6Addr) -> IpClass {
    let v = u128::from(ip);
    if v == 0 {
        return IpClass::Unspecified;
    }
    if v == 1 {
        return IpClass::Loopback;
    }
    if let Some((how, v4)) = embedded_ipv4(ip) {
        let class = classify_v4(v4);
        return match (how, class) {
            (Embedding::Mapped, c) => c,
            (_, IpClass::Public) => IpClass::Reserved,
            (_, c) => c,
        };
    }
    const fn p(segs: [u16; 8]) -> u128 {
        let mut v = 0u128;
        let mut i = 0;
        while i < 8 {
            v = (v << 16) | segs[i] as u128;
            i += 1;
        }
        v
    }
    if in_v6(v, p([0xff00, 0, 0, 0, 0, 0, 0, 0]), 8) {
        IpClass::Multicast
    } else if in_v6(v, p([0xfe80, 0, 0, 0, 0, 0, 0, 0]), 10) {
        IpClass::LinkLocal
    } else if in_v6(v, p([0xfc00, 0, 0, 0, 0, 0, 0, 0]), 7) {
        IpClass::Private
    } else if in_v6(v, p([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32) || in_v6(v, p([0x3fff, 0, 0, 0, 0, 0, 0, 0]), 20) {
        IpClass::Documentation
    } else if in_v6(v, p([0x2001, 0x2, 0, 0, 0, 0, 0, 0]), 48) {
        IpClass::Benchmarking
    } else if !in_v6(v, p([0x2000, 0, 0, 0, 0, 0, 0, 0]), 3)
        || in_v6(v, p([0x2001, 0, 0, 0, 0, 0, 0, 0]), 23)
        || in_v6(v, p([0x5f00, 0, 0, 0, 0, 0, 0, 0]), 16)
    {
        // Outside global unicast (fec0::/10, 100::/64, 64:ff9b:1::/48, unallocated space ...), IETF protocol
        // assignments 2001::/23 (ORCHID, AMT, AS112 ...) and SRv6 SIDs 5f00::/16.
        IpClass::Reserved
    } else {
        IpClass::Public
    }
}

/// Classify any IP address.
pub fn classify(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

/// Which address classes outbound connections may reach.
///
/// The default ([`IpPolicy::strict`]) allows only [`IpClass::Public`]. The three opt-ins mirror HolyWisp's
/// `allow-loopback`, `allow-private` and `allow-link-local`; GNOME never enables them in production (the test
/// suites use `allow_loopback` to reach a local test server). Unspecified, multicast, broadcast, documentation,
/// benchmarking and reserved addresses can never be allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct IpPolicy {
    loopback: bool,
    private: bool,
    link_local: bool,
}

impl IpPolicy {
    /// Allow public addresses only (the default).
    pub const fn strict() -> Self {
        Self { loopback: false, private: false, link_local: false }
    }

    /// Also allow loopback destinations. **Tests and local development only.**
    #[must_use]
    pub const fn allow_loopback(mut self, allow: bool) -> Self {
        self.loopback = allow;
        self
    }

    /// Also allow RFC 1918 / CGNAT / ULA destinations (e.g. a mirror on the operator's LAN).
    #[must_use]
    pub const fn allow_private(mut self, allow: bool) -> Self {
        self.private = allow;
        self
    }

    /// Also allow link-local destinations. This includes cloud metadata services (`169.254.169.254`).
    #[must_use]
    pub const fn allow_link_local(mut self, allow: bool) -> Self {
        self.link_local = allow;
        self
    }

    /// Whether loopback destinations are allowed.
    pub const fn allows_loopback(&self) -> bool {
        self.loopback
    }

    /// Whether a class is allowed under this policy.
    pub const fn allows_class(&self, class: IpClass) -> bool {
        match class {
            IpClass::Public => true,
            IpClass::Loopback => self.loopback,
            IpClass::Private => self.private,
            IpClass::LinkLocal => self.link_local,
            IpClass::Unspecified
            | IpClass::Multicast
            | IpClass::Broadcast
            | IpClass::Documentation
            | IpClass::Benchmarking
            | IpClass::Reserved => false,
        }
    }

    /// `Ok(())` if `ip` may be connected to, otherwise `Err(class)` with the refusing class.
    pub fn check(&self, ip: IpAddr) -> Result<(), IpClass> {
        let class = classify(ip);
        if self.allows_class(class) { Ok(()) } else { Err(class) }
    }

    /// Whether `ip` may be connected to.
    pub fn is_allowed(&self, ip: IpAddr) -> bool {
        self.check(ip).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use IpClass::*;

    fn c(s: &str) -> IpClass {
        classify(s.parse().unwrap_or_else(|e| panic!("{s}: {e}")))
    }

    #[test]
    fn ipv4_table() {
        let table: &[(&str, IpClass)] = &[
            // unspecified / "this network" 0/8
            ("0.0.0.0", Unspecified),
            ("0.0.0.1", Unspecified),
            ("0.255.255.255", Unspecified),
            // loopback 127/8
            ("127.0.0.1", Loopback),
            ("127.0.0.0", Loopback),
            ("127.1.2.3", Loopback),
            ("127.255.255.255", Loopback),
            // RFC 1918
            ("10.0.0.0", Private),
            ("10.0.0.1", Private),
            ("10.255.255.255", Private),
            ("172.16.0.0", Private),
            ("172.20.1.1", Private),
            ("172.31.255.255", Private),
            ("192.168.0.1", Private),
            ("192.168.255.255", Private),
            // CGNAT 100.64/10
            ("100.64.0.0", Private),
            ("100.64.0.1", Private),
            ("100.127.255.255", Private),
            // link-local incl. cloud metadata
            ("169.254.0.0", LinkLocal),
            ("169.254.169.254", LinkLocal),
            ("169.254.255.255", LinkLocal),
            // multicast 224/4
            ("224.0.0.0", Multicast),
            ("224.0.0.1", Multicast),
            ("239.255.255.250", Multicast),
            // broadcast and reserved 240/4
            ("255.255.255.255", Broadcast),
            ("240.0.0.0", Reserved),
            ("250.1.2.3", Reserved),
            ("255.255.255.254", Reserved),
            // IETF protocol assignments, deprecated 6to4 relay anycast
            ("192.0.0.0", Reserved),
            ("192.0.0.8", Reserved),
            ("192.0.0.170", Reserved),
            ("192.88.99.1", Reserved),
            // documentation
            ("192.0.2.1", Documentation),
            ("198.51.100.7", Documentation),
            ("203.0.113.255", Documentation),
            // benchmarking 198.18/15
            ("198.18.0.0", Benchmarking),
            ("198.19.255.255", Benchmarking),
            // public neighbours of the special ranges
            ("1.1.1.1", Public),
            ("8.8.8.8", Public),
            ("9.255.255.255", Public),
            ("11.0.0.0", Public),
            ("100.63.255.255", Public),
            ("100.128.0.0", Public),
            ("126.255.255.255", Public),
            ("128.0.0.0", Public),
            ("169.253.255.255", Public),
            ("169.255.0.0", Public),
            ("172.15.255.255", Public),
            ("172.32.0.0", Public),
            ("192.0.1.255", Public),
            ("192.0.3.0", Public),
            ("192.88.98.255", Public),
            ("192.167.255.255", Public),
            ("192.169.0.0", Public),
            ("198.17.255.255", Public),
            ("198.20.0.0", Public),
            ("198.51.99.255", Public),
            ("203.0.112.255", Public),
            ("223.255.255.255", Public),
            ("93.184.215.14", Public),
        ];
        for (ip, want) in table {
            assert_eq!(c(ip), *want, "{ip}");
        }
    }

    #[test]
    fn ipv6_table() {
        let table: &[(&str, IpClass)] = &[
            ("::", Unspecified),
            ("::1", Loopback),
            // IPv4-mapped: classified as the IPv4 address, public stays public
            ("::ffff:127.0.0.1", Loopback),
            ("::ffff:10.0.0.1", Private),
            ("::ffff:100.64.0.1", Private),
            ("::ffff:169.254.169.254", LinkLocal),
            ("::ffff:0.0.0.0", Unspecified),
            ("::ffff:224.0.0.1", Multicast),
            ("::ffff:255.255.255.255", Broadcast),
            ("::ffff:198.18.0.1", Benchmarking),
            ("::ffff:1.1.1.1", Public),
            // IPv4-compatible (deprecated)
            ("::127.0.0.1", Loopback),
            ("::10.0.0.1", Private),
            ("::169.254.169.254", LinkLocal),
            ("::0.0.0.2", Unspecified),
            ("::1.1.1.1", Reserved),
            // NAT64 well-known prefix
            ("64:ff9b::7f00:1", Loopback),
            ("64:ff9b::a00:1", Private),
            ("64:ff9b::a9fe:a9fe", LinkLocal),
            ("64:ff9b::101:101", Reserved),
            // local-use NAT64 prefix (RFC 8215)
            ("64:ff9b:1::a00:1", Reserved),
            ("64:ff9b:1::101:101", Reserved),
            // 6to4
            ("2002:7f00:1::", Loopback),
            ("2002:a00:1::1", Private),
            ("2002:c0a8:101::1", Private),
            ("2002:a9fe:a9fe::", LinkLocal),
            ("2002:0:0::1", Unspecified),
            ("2002:101:101::1", Reserved),
            // Teredo: client address is the bit-inverted low 32 bits
            ("2001:0:4136:e378:8000:63bf:80ff:fffe", Loopback), // !0x80fffffe = 127.0.0.1
            ("2001:0:4136:e378:8000:63bf:f5ff:fffe", Private),  // !0xf5fffffe = 10.0.0.1
            ("2001:0:4136:e378:8000:63bf:3fff:fdd2", Documentation), // !0x3ffffdd2 = 192.0.2.45
            ("2001:0:4136:e378:8000:63bf:fefe:fefe", Reserved), // 1.1.1.1 public -> reserved
            // ULA, link-local, site-local, multicast
            ("fc00::1", Private),
            ("fd00::1", Private),
            ("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", Private),
            ("fe80::1", LinkLocal),
            ("febf::1", LinkLocal),
            ("fec0::1", Reserved),
            ("ff02::1", Multicast),
            ("ff0e::1", Multicast),
            // documentation, benchmarking
            ("2001:db8::1", Documentation),
            ("2001:db8:ffff::1", Documentation),
            ("3fff::1", Documentation),
            ("3fff:fff::1", Documentation),
            ("2001:2::1", Benchmarking),
            // reserved / special-purpose / outside 2000::/3
            ("100::1", Reserved),
            ("2001:10::1", Reserved),
            ("2001:1ff::1", Reserved),
            ("5f00::1", Reserved),
            ("4000::1", Reserved),
            ("1::1", Reserved),
            ("::2:1:1", Reserved),
            ("e000::1", Reserved),
            // public
            ("2606:4700:4700::1111", Public),
            ("2001:4860:4860::8888", Public),
            ("2001:200::1", Public),
            ("2a00:1450:4001:80b::200e", Public),
            ("2001:db9::1", Public),
            ("3fff:1000::1", Public),
            ("3ffe::1", Public),
        ];
        for (ip, want) in table {
            assert_eq!(c(ip), *want, "{ip}");
        }
    }

    #[test]
    fn embedded_forms() {
        let e = |s: &str| embedded_ipv4(s.parse().unwrap());
        assert_eq!(e("::ffff:1.2.3.4"), Some((Embedding::Mapped, Ipv4Addr::new(1, 2, 3, 4))));
        assert_eq!(e("::1.2.3.4"), Some((Embedding::Compatible, Ipv4Addr::new(1, 2, 3, 4))));
        assert_eq!(e("64:ff9b::1.2.3.4"), Some((Embedding::Nat64, Ipv4Addr::new(1, 2, 3, 4))));
        assert_eq!(e("2002:102:304::"), Some((Embedding::SixToFour, Ipv4Addr::new(1, 2, 3, 4))));
        assert_eq!(e("2001:0:4136:e378:8000:63bf:3fff:fdd2"), Some((Embedding::Teredo, Ipv4Addr::new(192, 0, 2, 45))));
        assert_eq!(e("::"), None);
        assert_eq!(e("::1"), None);
        assert_eq!(e("2001:db8::1"), None);
        assert_eq!(e("2606:4700::1"), None);
    }

    #[test]
    fn policy_flags() {
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let strict = IpPolicy::strict();
        assert_eq!(strict, IpPolicy::default());
        assert!(strict.is_allowed(ip("1.1.1.1")));
        assert!(strict.is_allowed(ip("2606:4700:4700::1111")));
        assert!(strict.is_allowed(ip("::ffff:1.1.1.1")));
        for s in ["127.0.0.1", "::1", "10.0.0.1", "169.254.169.254", "fe80::1", "fd00::1", "0.0.0.0", "::"] {
            assert!(!strict.is_allowed(ip(s)), "{s}");
        }
        assert_eq!(strict.check(ip("169.254.169.254")), Err(LinkLocal));

        let lo = IpPolicy::strict().allow_loopback(true);
        assert!(lo.is_allowed(ip("127.0.0.1")));
        assert!(lo.is_allowed(ip("::1")));
        assert!(lo.is_allowed(ip("::ffff:127.0.0.1")));
        assert!(!lo.is_allowed(ip("10.0.0.1")));
        assert!(!lo.is_allowed(ip("169.254.169.254")));
        assert!(!lo.is_allowed(ip("0.0.0.0")));

        let all = IpPolicy::strict().allow_loopback(true).allow_private(true).allow_link_local(true);
        assert!(all.is_allowed(ip("10.0.0.1")));
        assert!(all.is_allowed(ip("fd00::1")));
        assert!(all.is_allowed(ip("169.254.169.254")));
        // Never allowed, whatever the flags.
        for s in [
            "0.0.0.0",
            "::",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "2001:db8::1",
            "ff02::1",
            "64:ff9b::101:101",
            "2002:101:101::1",
            "fec0::1",
        ] {
            assert!(!all.is_allowed(ip(s)), "{s}");
        }
    }
}
