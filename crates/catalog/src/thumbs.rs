//! Thumbnail proxy policy for `GET /api/thumb/:id` (the server fetches and caches; no image processing here).
//!
//! * The host allow-list is derived from the *enabled* sources ([`crate::Source::thumbnail_hosts`]); a URL is
//!   only proxied when it is HTTPS, on the allow-listed host **of its own source**, with no userinfo, no explicit
//!   port and a sane length.
//! * Responses should be accepted only with an image content type from [`ALLOWED_CONTENT_TYPES`] and at most
//!   [`MAX_THUMB_BYTES`]; serve them with `Content-Type` from that list, `X-Content-Type-Options: nosniff`,
//!   `Content-Security-Policy: default-src 'none'` and `Cache-Control: public, max-age=604800`.
//! * Self-hosted (OSS) thumbnails are relative `/oss/...` paths on the proxy origin and are never fetched.

use crate::source::Source;
use crate::url::Url;

/// Maximum thumbnail size the proxy should download.
pub const MAX_THUMB_BYTES: usize = 2 << 20;

/// Image types the proxy may serve (anything else, notably SVG and HTML, must be refused).
pub const ALLOWED_CONTENT_TYPES: &[&str] = &["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

/// Whether a response `Content-Type` is an allowed raster image type (parameters such as `; charset` ignored).
pub fn is_allowed_content_type(content_type: &str) -> bool {
    let base = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    ALLOWED_CONTENT_TYPES.contains(&base.as_str())
}

/// Host allow-list for the enabled sources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThumbPolicy {
    sources: Vec<Source>,
}

/// Why a thumbnail URL is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbRejection {
    /// Not an absolute, well-formed URL.
    Malformed,
    /// Not HTTPS, or has an explicit port.
    Scheme,
    /// The source is not enabled.
    SourceDisabled,
    /// The host is not one of the source's image hosts.
    Host,
}

impl ThumbPolicy {
    /// Policy for the enabled sources.
    pub fn new(enabled: &[Source]) -> Self {
        Self { sources: enabled.to_vec() }
    }

    /// Every allow-listed host (e.g. for logging or the CSP `img-src` in direct mode).
    pub fn hosts(&self) -> Vec<&'static str> {
        let mut h: Vec<&'static str> = self.sources.iter().flat_map(|s| s.thumbnail_hosts().iter().copied()).collect();
        h.sort_unstable();
        h.dedup();
        h
    }

    /// Validate a stored thumbnail URL of a game from `source`; returns the URL to fetch.
    pub fn check(&self, source: Source, url: &str) -> Result<String, ThumbRejection> {
        if !self.sources.contains(&source) {
            return Err(ThumbRejection::SourceDisabled);
        }
        let u = Url::parse(url).ok_or(ThumbRejection::Malformed)?;
        if u.scheme != "https" || u.port.is_some() {
            return Err(ThumbRejection::Scheme);
        }
        if u.path.len() > 1024 || !source.thumbnail_hosts().iter().any(|h| u.host_matches(h)) {
            return Err(ThumbRejection::Host);
        }
        Ok(u.as_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_list_follows_enabled_sources() {
        let p = ThumbPolicy::new(&[Source::GamePix, Source::Oss]);
        assert_eq!(p.hosts(), ["img.gamepix.com"]);
        let ok = "https://img.gamepix.com/games/prism-match-3d/cover/prism-match-3d.png?w=320";
        assert_eq!(p.check(Source::GamePix, ok).as_deref(), Ok(ok));
        assert_eq!(
            p.check(Source::GameDistribution, "https://img.gamedistribution.com/a.jpg"),
            Err(ThumbRejection::SourceDisabled)
        );
        assert_eq!(p.check(Source::GamePix, "https://img.gamedistribution.com/a.jpg"), Err(ThumbRejection::Host));
        assert_eq!(p.check(Source::GamePix, "http://img.gamepix.com/a.png"), Err(ThumbRejection::Scheme));
        assert_eq!(p.check(Source::GamePix, "https://img.gamepix.com:8443/a.png"), Err(ThumbRejection::Scheme));
        assert_eq!(
            p.check(Source::GamePix, "https://evil.example@img.gamepix.com/a.png"),
            Err(ThumbRejection::Malformed)
        );
        assert_eq!(p.check(Source::GamePix, "/oss/2048/meta/icon.png"), Err(ThumbRejection::Malformed));
        assert_eq!(p.check(Source::GamePix, "https://img.gamepix.com.evil.example/a.png"), Err(ThumbRejection::Host));
    }

    #[test]
    fn content_types() {
        assert!(is_allowed_content_type("image/JPEG"));
        assert!(is_allowed_content_type("image/png; charset=binary"));
        assert!(!is_allowed_content_type("image/svg+xml"));
        assert!(!is_allowed_content_type("text/html"));
    }
}
