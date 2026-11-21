//! The real client behind reverse proxies.
//!
//! The TCP peer is the client unless it is listed in `GNOME_TRUSTED_PROXIES`. For a trusted peer the client is the
//! right-most `X-Forwarded-For` hop that is *not* itself a trusted proxy (hops a client can forge sit to the left),
//! and `X-Forwarded-Proto` / `X-Forwarded-Host` are honoured. Headers from untrusted peers are ignored entirely.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use http::request::Parts;
use http::{HeaderMap, header};
use ipnet::IpNet;

use crate::state::AppState;

/// Resolved client identity for one request (inserted into request extensions by the observe middleware).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    /// Client IP (IPv4-mapped IPv6 normalized to IPv4).
    pub ip: IpAddr,
    /// TCP peer address.
    pub peer: SocketAddr,
    /// Whether the client's request used HTTPS (only knowable via a trusted proxy's `X-Forwarded-Proto`).
    pub https: bool,
    /// Host the client addressed, lowercased (`X-Forwarded-Host` from trusted proxies, else `Host`).
    pub host: Option<String>,
    /// Whether the TCP peer is a trusted proxy.
    pub via_trusted_proxy: bool,
}

/// `GNOME_TRUSTED_PROXIES`.
#[derive(Debug, Clone, Default)]
pub struct TrustedProxies(Vec<IpNet>);

impl TrustedProxies {
    pub fn new(nets: Vec<IpNet>) -> Self {
        Self(nets)
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical_ip(ip);
        self.0.iter().any(|n| n.contains(&ip))
    }
}

/// Map IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`, seen on dual-stack listeners) to plain IPv4.
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

impl ClientInfo {
    /// Resolve from the TCP peer and request headers. `uri_authority` is the request-target authority, if any
    /// (absolute-form requests), used when there is no `Host` header.
    pub fn resolve(
        peer: SocketAddr,
        headers: &HeaderMap,
        uri_authority: Option<&str>,
        trusted: &TrustedProxies,
    ) -> Self {
        let peer_ip = canonical_ip(peer.ip());
        let via_trusted_proxy = trusted.contains(peer_ip);
        let ip = if via_trusted_proxy { forwarded_client(headers, trusted).unwrap_or(peer_ip) } else { peer_ip };
        let https =
            via_trusted_proxy && matches!(first_value(headers, "x-forwarded-proto").as_deref(), Some("https" | "wss"));
        let host = via_trusted_proxy
            .then(|| first_value(headers, "x-forwarded-host"))
            .flatten()
            .or_else(|| headers.get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_ascii_lowercase))
            .or_else(|| uri_authority.map(str::to_ascii_lowercase))
            .filter(|h| valid_host(h));
        Self { ip, peer, https, host, via_trusted_proxy }
    }

    /// Placeholder identity for requests without connection info (never happens behind the real listeners).
    pub fn unknown() -> Self {
        Self {
            ip: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            peer: SocketAddr::from(([0, 0, 0, 0], 0)),
            https: false,
            host: None,
            via_trusted_proxy: false,
        }
    }
}

/// Resolve the client from `X-Forwarded-For` (all header instances, in order).
fn forwarded_client(headers: &HeaderMap, trusted: &TrustedProxies) -> Option<IpAddr> {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let mut leftmost_trusted = None;
    for hop in hops.iter().rev() {
        match parse_hop(hop) {
            Some(ip) if trusted.contains(ip) => leftmost_trusted = Some(ip),
            Some(ip) => return Some(ip),
            // Garbage left of the trusted chain was supplied by the client: never let it choose its own address.
            None => return leftmost_trusted,
        }
    }
    leftmost_trusted
}

fn parse_hop(hop: &str) -> Option<IpAddr> {
    if let Ok(ip) = hop.parse::<IpAddr>() {
        return Some(canonical_ip(ip));
    }
    if let Ok(sa) = hop.parse::<SocketAddr>() {
        return Some(canonical_ip(sa.ip()));
    }
    hop.strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .and_then(|inner| inner.parse::<IpAddr>().ok())
        .map(canonical_ip)
}

/// First comma-separated value of the first instance of `name`, trimmed and lowercased.
fn first_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let v = headers.get(name)?.to_str().ok()?;
    let first = v.split(',').next()?.trim();
    (!first.is_empty()).then(|| first.to_ascii_lowercase())
}

fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 300
        && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']'))
}

impl FromRequestParts<AppState> for ClientInfo {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(info) = parts.extensions.get::<ClientInfo>() {
            return Ok(info.clone());
        }
        let Some(ConnectInfo(peer)) = parts.extensions.get::<ConnectInfo<SocketAddr>>().copied() else {
            return Ok(ClientInfo::unknown());
        };
        Ok(ClientInfo::resolve(peer, &parts.headers, parts.uri.authority().map(|a| a.as_str()), &state.trusted_proxies))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn trusted() -> TrustedProxies {
        TrustedProxies::new(vec![
            "127.0.0.1/32".parse().unwrap(),
            "::1/128".parse().unwrap(),
            "10.0.0.0/8".parse().unwrap(),
        ])
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_static(v));
        }
        h
    }

    fn peer(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn untrusted_peer_headers_are_ignored() {
        let h = headers(&[("x-forwarded-for", "1.1.1.1"), ("x-forwarded-proto", "https"), ("host", "Gnome.Example")]);
        let c = ClientInfo::resolve(peer("203.0.113.9:5000"), &h, None, &trusted());
        assert_eq!(c.ip, "203.0.113.9".parse::<IpAddr>().unwrap());
        assert!(!c.https && !c.via_trusted_proxy);
        assert_eq!(c.host.as_deref(), Some("gnome.example"));
    }

    #[test]
    fn rightmost_untrusted_hop_wins() {
        // client forged "6.6.6.6"; real client 198.51.100.7 was appended by the edge proxy 10.1.2.3.
        let h = headers(&[("x-forwarded-for", "6.6.6.6, 198.51.100.7"), ("x-forwarded-for", "10.1.2.3")]);
        let c = ClientInfo::resolve(peer("127.0.0.1:40000"), &h, None, &trusted());
        assert_eq!(c.ip, "198.51.100.7".parse::<IpAddr>().unwrap());
        assert!(c.via_trusted_proxy);
    }

    #[test]
    fn all_trusted_hops_use_leftmost() {
        let h = headers(&[("x-forwarded-for", "10.0.0.5, 10.0.0.6")]);
        let c = ClientInfo::resolve(peer("127.0.0.1:1"), &h, None, &trusted());
        assert_eq!(c.ip, "10.0.0.5".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn garbage_hops_cannot_choose_the_address() {
        let h = headers(&[("x-forwarded-for", "1.2.3.4, garbage")]);
        let c = ClientInfo::resolve(peer("127.0.0.1:1"), &h, None, &trusted());
        assert_eq!(c.ip, "127.0.0.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn ports_brackets_and_mapped_addresses() {
        let h = headers(&[("x-forwarded-for", "[2001:db8::1]:443")]);
        let c = ClientInfo::resolve(peer("[::ffff:127.0.0.1]:1"), &h, None, &trusted());
        assert!(c.via_trusted_proxy, "IPv4-mapped peer must match 127.0.0.1/32");
        assert_eq!(c.ip, "2001:db8::1".parse::<IpAddr>().unwrap());
        let h = headers(&[("x-forwarded-for", "192.0.2.1:8080")]);
        let c = ClientInfo::resolve(peer("[::1]:1"), &h, None, &trusted());
        assert_eq!(c.ip, "192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn scheme_and_host_from_trusted_proxy() {
        let h = headers(&[
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "gnome.example.com"),
            ("host", "127.0.0.1:8080"),
        ]);
        let c = ClientInfo::resolve(peer("127.0.0.1:1"), &h, None, &trusted());
        assert!(c.https);
        assert_eq!(c.host.as_deref(), Some("gnome.example.com"));
        assert_eq!(c.ip, "127.0.0.1".parse::<IpAddr>().unwrap(), "no XFF: the proxy itself");
    }

    #[test]
    fn invalid_host_is_dropped() {
        let h = headers(&[("host", "evil.com/<script>")]);
        let c = ClientInfo::resolve(peer("192.0.2.1:1"), &h, None, &trusted());
        assert_eq!(c.host, None);
        let c = ClientInfo::resolve(peer("192.0.2.1:1"), &HeaderMap::new(), Some("Example.org:8080"), &trusted());
        assert_eq!(c.host.as_deref(), Some("example.org:8080"));
    }
}
