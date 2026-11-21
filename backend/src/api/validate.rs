//! Input validators shared by API handlers (and config).

use std::collections::BTreeMap;

use crate::error::ApiError;

pub const MAX_URL_LEN: usize = 4096;
pub const MAX_TITLE_LEN: usize = 512;
/// Client timestamps may be at most this far in the future (clock skew); otherwise one device could win every
/// last-writer-wins comparison forever.
pub const MAX_CLOCK_SKEW_MS: i64 = 24 * 60 * 60 * 1000;
/// Field errors reported per response (the rest are summarized).
const MAX_REPORTED_ERRORS: usize = 20;

/// Canonical 8-4-4-4-12 hexadecimal UUID (any version, either case).
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let n = prefix.len();
    (s.len() >= n && s.as_bytes()[..n].eq_ignore_ascii_case(prefix.as_bytes())).then(|| &s[n..])
}

/// An absolute `http:`/`https:` URL with a host, ≤ 4096 bytes, without whitespace or control characters.
pub fn is_http_url(s: &str) -> bool {
    if s.len() > MAX_URL_LEN || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(rest) = strip_prefix_ci(s, "https://").or_else(|| strip_prefix_ci(s, "http://")) else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = host_port.strip_prefix('[') {
        match v6.split_once(']') {
            Some((inner, after))
                if after.is_empty()
                    || after.strip_prefix(':').is_some_and(|p| p.bytes().all(|b| b.is_ascii_digit())) =>
            {
                inner
            }
            _ => return false,
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
            Some(_) => return false,
            None => host_port,
        }
    };
    !host.is_empty() && host.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '.' | '_' | '%' | ':' | '~'))
}

/// Titles: ≤ 512 characters, no NUL.
pub fn check_title(s: &str) -> Result<(), &'static str> {
    if s.chars().count() > MAX_TITLE_LEN {
        Err("must be at most 512 characters")
    } else if s.contains('\0') {
        Err("must not contain NUL characters")
    } else {
        Ok(())
    }
}

pub fn check_url(s: &str) -> Result<(), &'static str> {
    if s.len() > MAX_URL_LEN {
        Err("must be at most 4096 characters")
    } else if is_http_url(s) {
        Ok(())
    } else {
        Err("must be an absolute http(s) URL")
    }
}

/// Unix-ms timestamp between 0 and `now + MAX_CLOCK_SKEW_MS`.
pub fn check_timestamp(t: i64, now: i64) -> Result<(), &'static str> {
    if t < 0 {
        Err("must not be negative")
    } else if t > now.saturating_add(MAX_CLOCK_SKEW_MS) {
        Err("is too far in the future (check the device clock)")
    } else {
        Ok(())
    }
}

/// Accumulates `field → message` pairs for a `422 validation_failed`.
#[derive(Debug, Default)]
pub struct FieldErrors {
    fields: BTreeMap<String, String>,
    omitted: usize,
}

impl FieldErrors {
    pub fn add(&mut self, field: impl Into<String>, message: &str) {
        if self.fields.len() < MAX_REPORTED_ERRORS {
            self.fields.insert(field.into(), message.to_string());
        } else {
            self.omitted += 1;
        }
    }

    pub fn check(&mut self, field: impl FnOnce() -> String, result: Result<(), &'static str>) {
        if let Err(msg) = result {
            self.add(field(), msg);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    pub fn into_result(self) -> Result<(), ApiError> {
        if self.fields.is_empty() {
            return Ok(());
        }
        let mut err = ApiError::validation(self.fields);
        if self.omitted > 0 {
            err.message = format!("validation failed ({} more errors not shown)", self.omitted).into();
        }
        Err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids() {
        assert!(is_uuid("3f2c8a3e-5b1d-4c7e-9f00-123456789abc"));
        assert!(is_uuid("3F2C8A3E-5B1D-4C7E-9F00-123456789ABC"));
        for bad in [
            "",
            "3f2c8a3e5b1d4c7e9f00123456789abc",
            "3f2c8a3e-5b1d-4c7e-9f00-123456789abz",
            "3f2c8a3e-5b1d-4c7e-9f00-123456789abcd",
        ] {
            assert!(!is_uuid(bad), "{bad}");
        }
    }

    #[test]
    fn urls() {
        for ok in [
            "https://example.com",
            "http://example.com:8080/path?q=1#frag",
            "HTTPS://Example.COM/",
            "https://user:pw@host.example/x",
            "https://[2001:db8::1]:443/",
            "https://bücher.example/straße",
            "http://localhost",
        ] {
            assert!(is_http_url(ok), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "ftp://example.com",
            "https://",
            "https:///path",
            "https://exa mple.com",
            "data:text/html,hi",
            "//example.com",
            "https://example.com:port/",
            "https://[::1/",
            "http://a\u{0}b",
            "file:///etc/passwd",
        ] {
            assert!(!is_http_url(bad), "{bad}");
        }
        assert!(check_url(&format!("https://e.com/{}", "a".repeat(4090))).is_err());
    }

    #[test]
    fn titles_and_times() {
        assert!(check_title(&"é".repeat(512)).is_ok());
        assert!(check_title(&"é".repeat(513)).is_err());
        assert!(check_title("a\0b").is_err());
        assert!(check_timestamp(0, 1000).is_ok());
        assert!(check_timestamp(-1, 1000).is_err());
        assert!(check_timestamp(1000 + MAX_CLOCK_SKEW_MS, 1000).is_ok());
        assert!(check_timestamp(1001 + MAX_CLOCK_SKEW_MS, 1000).is_err());
    }

    #[test]
    fn field_errors_are_capped() {
        let mut e = FieldErrors::default();
        for i in 0..25 {
            e.add(format!("items[{i}].id"), "bad");
        }
        let err = e.into_result().unwrap_err();
        assert_eq!(err.fields().unwrap().len(), 20);
        assert!(err.message.contains("5 more"));
    }
}
