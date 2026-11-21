//! Reading upstream list bodies: sanity checks, the `! Version:` / `! Expires:` header, `!#include` directives and the
//! Ghostery resources metadata.

use std::time::Duration;

/// How many leading lines are searched for header fields.
const HEADER_LINES: usize = 64;

/// Fields from a list's comment header.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Header {
    /// `! Version: 202611092246`, or `! Last modified: <date>` when there is no version (uBO's CDN copies).
    pub version: Option<String>,
    /// `! Expires: 4 days (update frequency)` (unclamped).
    pub expires: Option<Duration>,
}

/// Parse the comment header (uBO rules: `! Expires: <n>` is days unless followed by `h`/`hour(s)`).
pub fn header(text: &str) -> Header {
    let mut h = Header::default();
    let mut last_modified = None;
    for line in text.lines().take(HEADER_LINES) {
        let Some(rest) = line.trim_start().strip_prefix('!') else { continue };
        let Some((key, value)) = rest.split_once(':') else { continue };
        let value = value.trim();
        let field = || {
            let v: String = value.chars().take(64).collect();
            (!v.is_empty() && !v.chars().any(char::is_control)).then_some(v)
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "version" if h.version.is_none() => h.version = field(),
            "last modified" if last_modified.is_none() => last_modified = field(),
            "expires" if h.expires.is_none() => h.expires = parse_expires(value),
            _ => {}
        }
    }
    h.version = h.version.or(last_modified);
    h
}

fn parse_expires(v: &str) -> Option<Duration> {
    let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
    let n: u64 = digits.parse().ok().filter(|n| *n > 0)?;
    let unit = v[digits.len()..].trim_start().to_ascii_lowercase();
    let hours = if unit.starts_with('h') { n } else { n.checked_mul(24)? };
    Some(Duration::from_secs(hours.min(24 * 365) * 3600))
}

/// Refuse bodies that are clearly not a filter list (an HTML error or challenge page, binary data, nothing).
pub fn check_list_body(body: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(body).map_err(|_| "the body is not UTF-8 text".to_string())?;
    let text = text.trim_start_matches('\u{feff}');
    let start = text.trim_start();
    if start.is_empty() {
        return Err("the body is empty".into());
    }
    if start.starts_with('<') {
        return Err("the body is an HTML/XML document, not a filter list".into());
    }
    if text.contains('\0') {
        return Err("the body contains NUL bytes".into());
    }
    if !text.lines().any(|l| {
        let l = l.trim();
        !l.is_empty() && !l.starts_with('!') && !l.starts_with('[')
    }) {
        return Err("the body contains no rules".into());
    }
    Ok(())
}

/// A list read from a file must also start like a filter list: its first non-empty line (after a BOM) starts with
/// `[Adblock` or `!` (WAVE-B3 §8). Downloads do not need this (uBO's CDN copies and Peter Lowe's list vary), but a
/// file named by mistake (a config file, a log) is refused instead of being served as rules.
pub fn check_list_header(body: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(body).map_err(|_| "the body is not UTF-8 text".to_string())?;
    let first = text.trim_start_matches('\u{feff}').lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if first.starts_with("[Adblock") || first.starts_with('!') {
        Ok(())
    } else {
        Err("the first line is not a filter-list header ([Adblock …] or a ! comment)".into())
    }
}

/// Refuse a resources body that is not Ghostery's JSON (`{"redirects": [...], "scriptlets": [...]}`).
pub fn check_resources_body(body: &[u8]) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct Shape {
        redirects: Vec<serde::de::IgnoredAny>,
        scriptlets: Vec<serde::de::IgnoredAny>,
    }
    let shape: Shape = serde_json::from_slice(body).map_err(|e| format!("not the resources JSON: {e}"))?;
    if shape.redirects.is_empty() && shape.scriptlets.is_empty() {
        return Err("the resources JSON has no redirects and no scriptlets".into());
    }
    Ok(())
}

/// The newest revision listed in Ghostery's `metadata.json` (`{"name": ..., "revisions": [<sha256 hex>, ...]}`).
pub fn latest_revision(metadata: &[u8]) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Metadata {
        revisions: Vec<String>,
    }
    let m: Metadata = serde_json::from_slice(metadata).map_err(|e| format!("metadata.json: {e}"))?;
    let rev = m.revisions.last().ok_or("metadata.json lists no revisions")?;
    if rev.len() != 64 || !rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("metadata.json: revision {rev:?} is not a SHA-256"));
    }
    Ok(rev.to_ascii_lowercase())
}

/// The target of an `!#include <path>` line, if `line` is one.
pub fn include_target(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix("!#include")?;
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    let target = rest.trim();
    (!target.is_empty()).then_some(target)
}

/// Whether the text has any `!#include` line.
pub fn has_includes(text: &str) -> bool {
    text.lines().any(|l| include_target(l).is_some())
}

/// Resolve an include against the URL of the list that names it. Like uBO, only files in the same directory (or
/// below it) on the same origin are followed.
pub fn resolve_include(base: &gnome_net::Url, target: &str) -> Result<gnome_net::Url, String> {
    let url = base.join(target).map_err(|e| format!("!#include {target:?}: {e}"))?;
    let dir = &base.path()[..=base.path().rfind('/').unwrap_or(0)];
    if url.origin() != base.origin() || !url.path().starts_with(dir) || url.path().contains("/../") {
        return Err(format!("!#include {target:?} leaves the list's directory"));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_fields() {
        let h = header(
            "[Adblock Plus 2.0]\n! Version: 202611092246\n! Title: EasyList\n! Expires: 4 days (update frequency)\n||ads.example^\n",
        );
        assert_eq!(h.version.as_deref(), Some("202611092246"));
        assert_eq!(h.expires, Some(Duration::from_secs(4 * 86400)));
        assert_eq!(header("! Expires: 12 hours\n").expires, Some(Duration::from_secs(12 * 3600)));
        assert_eq!(header("! Expires: 5h\n").expires, Some(Duration::from_secs(5 * 3600)));
        assert_eq!(header("! Expires: 7\n").expires, Some(Duration::from_secs(7 * 86400)));
        assert_eq!(header("!Last modified: Wed, 11 Nov 2026\n||x^\n").version.as_deref(), Some("Wed, 11 Nov 2026"));
        let both = header("! Last modified: Wed, 11 Nov 2026\n! Version: 7\n");
        assert_eq!(both.version.as_deref(), Some("7"));
        assert_eq!(header("||x^\n"), Header::default());
        assert_eq!(header("! Expires: soon\n! Expires: 0 days\n").expires, None);
        // Only the first occurrence counts; fields far below the header are ignored.
        let late = format!("{}! Version: 9\n", "||x^\n".repeat(HEADER_LINES));
        assert_eq!(header(&late).version, None);
    }

    #[test]
    fn list_body_checks() {
        assert!(check_list_body(b"! Title: x\n||ads.example^\n").is_ok());
        assert!(check_list_body(b"\xef\xbb\xbf[Adblock Plus 2.0]\nexample.com##.ad\n").is_ok());
        for bad in [&b""[..], b"   \n", b"<!DOCTYPE html><html>", b"\xff\xfe", b"! only\n! comments\n", b"||a^\0"] {
            assert!(check_list_body(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn list_header_checks() {
        for good in
            [&b"[Adblock Plus 2.0]\n||a^\n"[..], b"\xef\xbb\xbf\n\n! Title: x\n||a^\n", b"  ! gnome-e2e: id=x\n||a^\n"]
        {
            assert!(check_list_header(good).is_ok(), "{good:?}");
        }
        for bad in [&b"||a^\n! Title: x\n"[..], b"[general]\nkey = 1\n", b"", b"\xff\xfe", b"Adblock\n"] {
            assert!(check_list_header(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn resources_checks() {
        assert!(check_resources_body(br#"{"redirects":[{"name":"noop.js"}],"scriptlets":[]}"#).is_ok());
        assert!(check_resources_body(br#"{"redirects":[],"scriptlets":[]}"#).is_err());
        assert!(check_resources_body(b"[]").is_err());
        let rev = "0b0a50a9dbf263c650e7a901a9f66523c1ee96b73f9d026791b9ea03cfc7a43d";
        let meta = format!(r#"{{"name":"ublock-resources-json","revisions":["{}","{rev}"]}}"#, "a".repeat(64));
        assert_eq!(latest_revision(meta.as_bytes()).unwrap(), rev);
        assert!(latest_revision(br#"{"revisions":[]}"#).is_err());
        assert!(latest_revision(br#"{"revisions":["../../etc"]}"#).is_err());
    }

    #[test]
    fn includes() {
        assert_eq!(include_target("!#include filters-2026.txt"), Some("filters-2026.txt"));
        assert_eq!(include_target("  !#include\tsub/x.txt "), Some("sub/x.txt"));
        assert_eq!(include_target("!#includes x"), None);
        assert_eq!(include_target("! #include x"), None);
        assert!(has_includes("! x\n!#include a.txt\n"));
        let base = gnome_net::Url::parse("https://lists.example/filters/main.txt").unwrap();
        assert_eq!(resolve_include(&base, "a.txt").unwrap().as_str(), "https://lists.example/filters/a.txt");
        assert_eq!(resolve_include(&base, "sub/b.txt").unwrap().as_str(), "https://lists.example/filters/sub/b.txt");
        for bad in ["../secret.txt", "/other/x.txt", "https://evil.example/filters/a.txt", "//evil.example/x"] {
            assert!(resolve_include(&base, bad).is_err(), "{bad}");
        }
    }
}
