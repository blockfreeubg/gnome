//! A deliberately small, strict parser for the absolute `http(s)` URLs found in feeds.
//!
//! Feed URLs end up in iframes, `<img>` tags, link-outs and the thumbnail proxy, so anything unusual is rejected
//! rather than interpreted: userinfo (`user@host`), IP-literal hosts, non-ASCII hosts, backslashes, whitespace and
//! control characters, and URLs longer than [`MAX_URL`].

/// Maximum accepted URL length (bytes).
pub const MAX_URL: usize = 2048;

/// A parsed absolute URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    /// `"http"` or `"https"`.
    pub scheme: &'static str,
    /// Lowercase DNS host name.
    pub host: String,
    /// Explicit non-default port, if any.
    pub port: Option<u16>,
    /// Path starting with `/` (`/` when the URL had none).
    pub path: String,
    /// Query string without `?` (may be empty).
    pub query: Option<String>,
}

impl Url {
    /// Parse an absolute `http:`/`https:` URL. Fragments are dropped.
    pub fn parse(s: &str) -> Option<Url> {
        let s = s.trim();
        if s.is_empty() || s.len() > MAX_URL {
            return None;
        }
        if s.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'\\' || b == b'"' || b == b'<' || b == b'>' || b >= 0x80) {
            return None;
        }
        let (scheme, rest) = match strip_prefix_ci(s, "https://") {
            Some(r) => ("https", r),
            None => ("http", strip_prefix_ci(s, "http://")?),
        };
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..end];
        let tail = &rest[end..];
        if authority.contains('@') || authority.is_empty() {
            return None;
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => {
                if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let port: u16 = p.parse().ok()?;
                let default = if scheme == "https" { 443 } else { 80 };
                (h, if port == default { None } else { Some(port) })
            }
            None => (authority, None),
        };
        let host = host.to_ascii_lowercase();
        if !is_dns_name(&host) {
            return None;
        }
        let tail = tail.split('#').next().unwrap_or("");
        let (path, query) = match tail.split_once('?') {
            Some((p, q)) => (p, Some(q.to_owned())),
            None => (tail, None),
        };
        let path = if path.is_empty() { "/".to_owned() } else { path.to_owned() };
        if !path.starts_with('/') {
            return None;
        }
        Some(Url { scheme, host, port, path, query })
    }

    /// Whether the path has no `.` or `..` segment and no `%2e`, `%2f` or `%5c` (any case): such paths can name
    /// another resource than they appear to (WAVE-C D4), so embed URLs must not have them.
    pub fn has_plain_path(&self) -> bool {
        let lower = self.path.to_ascii_lowercase();
        if lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") {
            return false;
        }
        !self.path.split('/').any(|seg| seg == "." || seg == "..")
    }

    /// Serialize back to a string.
    pub fn as_string(&self) -> String {
        let mut s = format!("{}://{}", self.scheme, self.host);
        if let Some(p) = self.port {
            s.push(':');
            s.push_str(&p.to_string());
        }
        s.push_str(&self.path);
        if let Some(q) = &self.query {
            s.push('?');
            s.push_str(q);
        }
        s
    }

    /// The value of the first query parameter called `name` (raw, not percent-decoded).
    pub fn query_param(&self, name: &str) -> Option<&str> {
        self.query.as_deref()?.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == name).then_some(v)
        })
    }

    /// Replace (or append) query parameter `name` with the raw `value` (used to put template placeholders such as
    /// `{gamepix_sid}` into embed URLs). Other parameters keep their order.
    pub fn set_query_param(&mut self, name: &str, value: &str) {
        let mut parts: Vec<String> = Vec::new();
        let mut replaced = false;
        if let Some(q) = &self.query {
            for kv in q.split('&').filter(|kv| !kv.is_empty()) {
                let k = kv.split_once('=').map_or(kv, |(k, _)| k);
                if k == name {
                    if !replaced {
                        parts.push(format!("{name}={value}"));
                        replaced = true;
                    }
                } else {
                    parts.push(kv.to_owned());
                }
            }
        }
        if !replaced {
            parts.push(format!("{name}={value}"));
        }
        self.query = Some(parts.join("&"));
    }

    /// Whether the host equals `pattern`, or is a subdomain of it when the pattern starts with `*.`.
    pub fn host_matches(&self, pattern: &str) -> bool {
        match pattern.strip_prefix("*.") {
            Some(suffix) => self.host.len() > suffix.len() + 1 && self.host.ends_with(&format!(".{suffix}")),
            None => self.host == pattern,
        }
    }
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    (s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix)).then(|| &s[prefix.len()..])
}

/// A syntactically valid DNS name with at least two labels; IP literals are rejected.
fn is_dns_name(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 || !h.contains('.') {
        return false;
    }
    let labels: Vec<&str> = h.split('.').collect();
    let ok = labels.iter().all(|l| {
        !l.is_empty()
            && l.len() <= 63
            && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    });
    // The top-level label of a real domain is never all digits (which also rules out dotted-quad IPv4).
    ok && labels.last().is_some_and(|tld| !tld.bytes().all(|b| b.is_ascii_digit()))
}

/// Parse `s` and require an HTTPS URL on one of `hosts` (patterns as in [`Url::host_matches`]); `http` URLs on
/// those hosts are upgraded to `https` (all supported CDNs serve HTTPS; mixed content would be blocked anyway).
pub fn https_on(s: &str, hosts: &[&str]) -> Option<Url> {
    let mut u = Url::parse(s)?;
    if !hosts.is_empty() && !hosts.iter().any(|h| u.host_matches(h)) {
        return None;
    }
    if u.scheme == "http" {
        if u.port.is_some() {
            return None;
        }
        u.scheme = "https";
    }
    Some(u)
}

/// Percent-encode a string for use as a URL query component (RFC 3986 unreserved characters are kept).
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3 / 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalizes() {
        let u = Url::parse("HTTPS://Play.GamePix.com/prism-match-3d/embed?sid=1#frag").unwrap();
        assert_eq!(u.host, "play.gamepix.com");
        assert_eq!(u.path, "/prism-match-3d/embed");
        assert_eq!(u.query_param("sid"), Some("1"));
        assert_eq!(u.as_string(), "https://play.gamepix.com/prism-match-3d/embed?sid=1");
        assert_eq!(Url::parse("https://a.example:443").unwrap().as_string(), "https://a.example/");
        assert_eq!(Url::parse("https://a.example:8443/x").unwrap().port, Some(8443));
    }

    #[test]
    fn rejects_suspicious_urls() {
        for bad in [
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "//img.gamepix.com/x.png",
            "https://user:pw@img.gamepix.com/x.png",
            "https://127.0.0.1/x.png",
            "https://localhost/x.png",
            "https://img.gamepix.com/a b.png",
            "https://img.gamepix.com\\@evil.example/",
            "https://exa_mple.com/",
            "https://-bad.example/",
            "https://bücher.example/",
            "https://img.gamepix.com:99999/",
            "ftp://img.gamepix.com/x.png",
            "https://img.gamepix.com/\u{1}",
        ] {
            assert!(Url::parse(bad).is_none(), "{bad}");
        }
        assert!(Url::parse(&format!("https://a.example/{}", "x".repeat(MAX_URL))).is_none());
    }

    #[test]
    fn host_patterns_and_https_upgrade() {
        let u = Url::parse("https://emlise.itch.io/seasonshift").unwrap();
        assert!(u.host_matches("*.itch.io") && !u.host_matches("itch.io"));
        assert!(!Url::parse("https://itch.io/").unwrap().host_matches("*.itch.io"));
        assert!(!Url::parse("https://evilitch.io/").unwrap().host_matches("*.itch.io"));
        let up = https_on("http://html5.gamedistribution.com/abc/", &["html5.gamedistribution.com"]).unwrap();
        assert_eq!(up.as_string(), "https://html5.gamedistribution.com/abc/");
        assert!(https_on("https://evil.example/abc/", &["html5.gamedistribution.com"]).is_none());
    }

    #[test]
    fn query_param_replacement() {
        let mut u = Url::parse("https://play.gamepix.com/x/embed?a=1&sid=1&b=2").unwrap();
        u.set_query_param("sid", "{gamepix_sid}");
        assert_eq!(u.as_string(), "https://play.gamepix.com/x/embed?a=1&sid={gamepix_sid}&b=2");
        let mut v = Url::parse("https://playgama.com/export/game/x").unwrap();
        v.set_query_param("clid", "{playgama_clid}");
        assert_eq!(v.as_string(), "https://playgama.com/export/game/x?clid={playgama_clid}");
        assert_eq!(encode_component("https://g.example/games/a b"), "https%3A%2F%2Fg.example%2Fgames%2Fa%20b");
    }

    #[test]
    fn plain_paths() {
        let plain = |s: &str| Url::parse(s).unwrap().has_plain_path();
        assert!(plain("https://play.gamepix.com/x/embed?sid={gamepix_sid}"));
        assert!(plain("https://a.example/b.c/d..e/"));
        for bad in [
            "https://a.example/a/../b",
            "https://a.example/a/./b",
            "https://a.example/a/%2e%2e/b",
            "https://a.example/a/%2E%2e/b",
            "https://a.example/a%2fb",
            "https://a.example/a%2Fb",
            "https://a.example/a%5cb",
            "https://a.example/a%5Cb",
            "https://a.example/..",
        ] {
            assert!(!plain(bad), "{bad}");
        }
    }
}
