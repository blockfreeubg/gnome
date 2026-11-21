//! Small shared helpers: clocks, secrets, boxed futures.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

/// Boxed, sendable error used by jobs and startup code.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// Boxed, sendable future (object-safe async hooks).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Current Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Current Unix time in seconds.
pub fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A configuration secret (admin token, access code, secret key). `Debug` never prints the value.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret value. Only call this where the value is actually needed (comparison, key decoding).
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Constant-time comparison against a candidate (e.g. a submitted access code or bearer token). Digests are
    /// compared, so not even the secret's length leaks through timing.
    pub fn matches(&self, candidate: &[u8]) -> bool {
        use crate::security::crypto::{ct_eq, sha256};
        ct_eq(&sha256(self.0.as_bytes()), &sha256(candidate))
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Resident set size of this process in bytes (Linux `/proc/self/status`), if available.
pub fn rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// Escape text for safe inclusion in HTML element content and double-quoted attributes.
pub fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_is_redacted() {
        let s = Secret::new("hunter2-very-secret");
        assert_eq!(format!("{s:?}"), "<redacted>");
        assert!(s.matches(b"hunter2-very-secret"));
        assert!(!s.matches(b"hunter2"));
    }

    #[test]
    fn html_escape_escapes_markup() {
        assert_eq!(html_escape(r#"<a href="x">'&'</a>"#), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    }

    #[test]
    fn clocks_are_sane() {
        assert!(now_ms() > 1_700_000_000_000);
        assert!(now_s() > 1_700_000_000);
    }
}
