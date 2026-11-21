//! `Origin` validation: an explicit allow-list (`GNOME_PUBLIC_ORIGINS`) or, when that is empty, same-origin against
//! the host and scheme the client actually used (see [`ClientInfo`]).

use std::net::Ipv6Addr;

use super::client::ClientInfo;

/// Normalize `scheme://host[:port]`: lowercase, default port removed. `None` for anything that is not a
/// serialized http(s) origin (paths, userinfo, `null`, other schemes).
pub fn normalize_origin(s: &str) -> Option<String> {
    let (scheme, rest) = s.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let (host, port) = split_host_port(rest)?;
    let host = host.to_ascii_lowercase();
    match port {
        Some(p) if p != default_port => Some(format!("{scheme}://{host}:{p}")),
        _ => Some(format!("{scheme}://{host}")),
    }
}

/// Split `host[:port]` and validate the host (DNS name, IPv4, or bracketed IPv6).
fn split_host_port(s: &str) -> Option<(&str, Option<u16>)> {
    if s.is_empty() || s.contains(['/', '?', '#', '@', ' ', '\\']) {
        return None;
    }
    let (host, port) = if let Some(rest) = s.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        inner.parse::<Ipv6Addr>().ok()?;
        let host = &s[..inner.len() + 2];
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':')?),
        };
        (host, port)
    } else {
        match s.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (s, None),
        }
    };
    let port = match port {
        Some(p) => {
            let n: u16 = p.parse().ok()?;
            if n == 0 {
                return None;
            }
            Some(n)
        }
        None => None,
    };
    if !host.starts_with('[') {
        let ok = !host.is_empty()
            && host.len() <= 253
            && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
        if !ok {
            return None;
        }
    }
    Some((host, port))
}

/// The origin this request was addressed to, e.g. `https://gnome.example.com`.
pub fn request_origin(client: &ClientInfo) -> Option<String> {
    let scheme = if client.https { "https" } else { "http" };
    normalize_origin(&format!("{scheme}://{}", client.host.as_deref()?))
}

/// Origin policy for state-changing requests and the Wisp gateway.
#[derive(Debug, Clone, Default)]
pub struct OriginPolicy {
    allowed: Vec<String>,
}

impl OriginPolicy {
    /// `allowed` must already be normalized (config does this).
    pub fn new(allowed: Vec<String>) -> Self {
        Self { allowed }
    }

    pub fn allow_list(&self) -> &[String] {
        &self.allowed
    }

    /// Whether the raw `Origin` header value is acceptable for this request.
    pub fn allows(&self, origin: &str, client: &ClientInfo) -> bool {
        let Some(origin) = normalize_origin(origin) else {
            return false;
        };
        if !self.allowed.is_empty() {
            return self.allowed.contains(&origin);
        }
        request_origin(client).is_some_and(|me| me == origin)
    }

    /// When a same-origin check failed only because of the scheme, explain the usual misconfiguration.
    pub fn mismatch_hint(&self, origin: &str, client: &ClientInfo) -> Option<&'static str> {
        if !self.allowed.is_empty() {
            return None;
        }
        let o = normalize_origin(origin)?;
        let me = request_origin(client)?;
        let strip = |s: &str| s.split_once("://").map(|(_, rest)| rest.to_string());
        if o.starts_with("https://") && me.starts_with("http://") && strip(&o) == strip(&me) {
            Some(
                "browser used https but the server saw http: add the TLS proxy to GNOME_TRUSTED_PROXIES \
                 (so X-Forwarded-Proto is honoured) or set GNOME_PUBLIC_ORIGINS",
            )
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(https: bool, host: &str) -> ClientInfo {
        ClientInfo { https, host: Some(host.to_string()), ..ClientInfo::unknown() }
    }

    #[test]
    fn normalization() {
        assert_eq!(normalize_origin("HTTPS://Gnome.Example.COM:443").as_deref(), Some("https://gnome.example.com"));
        assert_eq!(normalize_origin("http://localhost:8080").as_deref(), Some("http://localhost:8080"));
        assert_eq!(normalize_origin("http://[::1]:80").as_deref(), Some("http://[::1]"));
        assert_eq!(normalize_origin("http://[::1]:20001").as_deref(), Some("http://[::1]:20001"));
        for bad in [
            "null",
            "",
            "ftp://x",
            "https://",
            "https://a/b",
            "https://u@a",
            "https://a:0",
            "https://a:99999",
            "https://[zz]",
            "https://a b",
        ] {
            assert_eq!(normalize_origin(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn same_origin_mode() {
        let p = OriginPolicy::default();
        let c = client(false, "gnome.local:8080");
        assert!(p.allows("http://gnome.local:8080", &c));
        assert!(p.allows("http://GNOME.local:8080", &c));
        assert!(!p.allows("http://evil.example", &c));
        assert!(!p.allows("https://gnome.local:8080", &c));
        assert!(!p.allows("null", &c));
        let https = client(true, "gnome.example");
        assert!(p.allows("https://gnome.example", &https));
        assert!(p.allows("https://gnome.example:443", &https));
        let no_host = ClientInfo::unknown();
        assert!(!p.allows("http://anything", &no_host));
    }

    #[test]
    fn allow_list_mode_ignores_host() {
        let p = OriginPolicy::new(vec!["https://gnome.example.com".into()]);
        let c = client(false, "internal:8080");
        assert!(p.allows("https://gnome.example.com", &c));
        assert!(!p.allows("http://internal:8080", &c));
    }

    #[test]
    fn hint_for_scheme_mismatch() {
        let p = OriginPolicy::default();
        let c = client(false, "gnome.example");
        assert!(p.mismatch_hint("https://gnome.example", &c).is_some());
        assert!(p.mismatch_hint("https://other.example", &c).is_none());
    }
}
