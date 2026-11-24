//! Session cookies (API.md "Conventions"): `HttpOnly; SameSite=Strict; Path=/`, `Max-Age` 30 days, `Secure` over
//! HTTPS, on plain HTTP to a loopback app origin (`GNOME_COOKIE_SECURE=auto`, decided per request by
//! [`crate::auth::extract::cookies_secure`]) or when `GNOME_COOKIE_SECURE=true`.
//!
//! Secure cookies carry the `__Host-` name prefix (`__Host-gnome_sid`, `__Host-gnome_auth`). Browsers only accept
//! such a cookie from the host itself, with `Secure`, `Path=/` and no `Domain`, so another host of the same site —
//! notably the proxy origin, where hostile pages run (ARCHITECTURE §4.6) — cannot plant a session cookie for the app
//! (session fixation via cookie tossing). Plain-HTTP deployments on other hosts use the unprefixed names.

use http::{HeaderMap, HeaderValue, header};

use crate::config::CookieSecure;
use crate::security::ClientInfo;

/// At most this many same-named cookie values are considered (duplicates only appear when another host or path
/// tosses a cookie; the real one is among the first few).
const MAX_CANDIDATES: usize = 4;

/// The two session cookies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionCookie {
    /// `gnome_sid`: anonymous session (stateless signed token).
    Anonymous,
    /// `gnome_auth`: signed-in user session.
    User,
}

impl SessionCookie {
    /// Cookie name for a request; `secure` = [`secure_for`] of that request.
    pub fn name(self, secure: bool) -> &'static str {
        match (self, secure) {
            (Self::Anonymous, false) => "gnome_sid",
            (Self::Anonymous, true) => "__Host-gnome_sid",
            (Self::User, false) => "gnome_auth",
            (Self::User, true) => "__Host-gnome_auth",
        }
    }
}

/// Values of cookie `name` across all `Cookie` headers, in header order, deduplicated, at most `MAX_CANDIDATES` (4).
pub fn values<'a>(headers: &'a HeaderMap, name: &str) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    let pairs = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='));
    for (k, v) in pairs {
        if k != name {
            continue;
        }
        let v = v.trim().trim_matches('"');
        if !out.contains(&v) {
            out.push(v);
            if out.len() == MAX_CANDIDATES {
                break;
            }
        }
    }
    out
}

/// The first value of cookie `name` across all `Cookie` headers.
pub fn get<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    values(headers, name).into_iter().next()
}

/// Whether cookies set on this request get the `Secure` attribute (and the `__Host-` names), from the scheme alone.
/// Handlers use [`crate::auth::extract::cookies_secure`], which adds the loopback rule of `auto` on top.
pub fn secure_for(mode: CookieSecure, client: &ClientInfo) -> bool {
    match mode {
        CookieSecure::Auto => client.https,
        CookieSecure::Always => true,
        CookieSecure::Never => false,
    }
}

/// `Set-Cookie` value. `value` must consist of cookie-octets (our tokens are base64url, digits and dots).
/// `Priority=High` (WAVE-D D19 (2)): Chromium evicts lower-priority cookies first when a site passes 180 cookies, so
/// cookies planted by a proxied page push out each other before GNOME's sessions (Firefox ignores the attribute).
pub fn set(name: &str, value: &str, max_age_s: u64, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Max-Age={max_age_s}; Path=/; HttpOnly; SameSite=Strict; Priority=High{secure}"
    ))
    .expect("cookie values are ASCII")
}

/// `Set-Cookie` value that deletes the cookie.
pub fn clear(name: &str, secure: bool) -> HeaderValue {
    set(name, "", 0, secure)
}

/// Name of the cookie a `Set-Cookie` header value sets.
pub fn set_cookie_name(value: &HeaderValue) -> Option<&str> {
    value.to_str().ok()?.split_once('=').map(|(n, _)| n.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cookie_headers() {
        let mut h = HeaderMap::new();
        h.append(header::COOKIE, HeaderValue::from_static("theme=dark; gnome_sid=abc.def"));
        h.append(header::COOKIE, HeaderValue::from_static("gnome_auth=\"tok\""));
        assert_eq!(get(&h, "gnome_sid"), Some("abc.def"));
        assert_eq!(get(&h, "gnome_auth"), Some("tok"));
        assert_eq!(get(&h, "missing"), None);
        assert_eq!(get(&h, "gnome"), None);
    }

    #[test]
    fn duplicates_are_all_candidates() {
        let mut h = HeaderMap::new();
        // A tossed cookie (longer path → sent first) followed by the real one.
        h.append(header::COOKIE, HeaderValue::from_static("gnome_sid=tossed; a=1; gnome_sid=real; gnome_sid=real"));
        h.append(header::COOKIE, HeaderValue::from_static("gnome_sid=3; gnome_sid=4; gnome_sid=5"));
        assert_eq!(values(&h, "gnome_sid"), vec!["tossed", "real", "3", "4"]);
    }

    #[test]
    fn names_follow_the_secure_flag() {
        assert_eq!(SessionCookie::Anonymous.name(false), "gnome_sid");
        assert_eq!(SessionCookie::Anonymous.name(true), "__Host-gnome_sid");
        assert_eq!(SessionCookie::User.name(false), "gnome_auth");
        assert_eq!(SessionCookie::User.name(true), "__Host-gnome_auth");
    }

    #[test]
    fn attributes() {
        let v = set("__Host-gnome_sid", "v1.1.a.b", 2_592_000, true);
        assert_eq!(
            v,
            "__Host-gnome_sid=v1.1.a.b; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict; Priority=High; Secure"
        );
        let c = clear("gnome_auth", false);
        assert_eq!(c, "gnome_auth=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict; Priority=High");
        for secure in [true, false] {
            for name in ["gnome_sid", "gnome_auth"] {
                let v = set(name, "x", 1, secure);
                assert!(v.to_str().unwrap().contains("; Priority=High"), "{v:?}");
            }
        }
        assert_eq!(set_cookie_name(&c), Some("gnome_auth"));
        let https = ClientInfo { https: true, ..ClientInfo::unknown() };
        assert!(secure_for(CookieSecure::Auto, &https));
        assert!(!secure_for(CookieSecure::Auto, &ClientInfo::unknown()));
        assert!(secure_for(CookieSecure::Always, &ClientInfo::unknown()));
        assert!(!secure_for(CookieSecure::Never, &https));
    }
}
