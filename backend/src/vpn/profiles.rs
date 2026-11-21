//! `GNOME_VPN_PROFILES`: the operator's egress gateway profiles (ARCHITECTURE §7, `services/vpn/`).
//!
//! ```toml
//! [[profile]]
//! id = "se-got"                       # [a-z0-9-]{1,32}; the Wisp path is /wisp/p/<id>/
//! label = "Sweden · Gothenburg"
//! country_code = "se"                 # ISO 3166-1 alpha-2
//! country = "Sweden"
//! city = "Gothenburg"
//! provider_note = "Mullvad WireGuard, operator's own account"   # optional
//! wisp_upstream = "127.0.0.1:6002"    # the HolyWisp instance whose egress goes through the tunnel
//! ```
//!
//! Each profile is one HolyWisp instance (its upstream SOCKS5 proxy is per process). Upstreams are internal
//! addresses only (see [`UpstreamAddr`]). Unknown keys are errors so typos are caught.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

use crate::gateway::upstream::UpstreamAddr;

/// At most this many profiles (each is a separate HolyWisp process and probe).
pub const MAX_PROFILES: usize = 64;

/// One validated profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VpnProfile {
    pub id: String,
    pub label: String,
    /// Lowercase ISO 3166-1 alpha-2.
    pub country_code: String,
    pub country: String,
    pub city: String,
    pub provider_note: String,
    pub upstream: UpstreamAddr,
}

impl VpnProfile {
    /// `/wisp/p/<id>/`.
    pub fn path(&self) -> String {
        format!("/wisp/p/{}/", self.id)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    #[serde(default)]
    profile: Vec<RawProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProfile {
    id: String,
    label: String,
    country_code: String,
    country: String,
    city: String,
    #[serde(default)]
    provider_note: String,
    wisp_upstream: String,
}

/// Read and validate a profiles file. All problems are reported together.
pub fn load(path: &Path) -> Result<Vec<VpnProfile>, Vec<String>> {
    let text = std::fs::read_to_string(path).map_err(|e| vec![format!("cannot read {}: {e}", path.display())])?;
    parse(path, &text)
}

/// Validate profiles from TOML text (`path` is only used in messages).
pub fn parse(path: &Path, text: &str) -> Result<Vec<VpnProfile>, Vec<String>> {
    let raw: RawFile = toml::from_str(text).map_err(|e| vec![format!("{}: {}", path.display(), e.message())])?;
    let mut problems = Vec::new();
    if raw.profile.len() > MAX_PROFILES {
        problems.push(format!("{}: at most {MAX_PROFILES} profiles are supported", path.display()));
    }
    let mut ids = HashSet::new();
    let mut profiles = Vec::with_capacity(raw.profile.len());
    for (i, p) in raw.profile.into_iter().enumerate() {
        let at = format!("{}: profile #{} ({:?})", path.display(), i + 1, p.id);
        let mut bad = |field: &str, msg: &str| problems.push(format!("{at}: {field} {msg}"));
        let id_ok = (1..=32).contains(&p.id.len())
            && p.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !id_ok {
            bad("id", "must be 1-32 characters of [a-z0-9-]");
        } else if p.id == crate::gateway::health::DIRECT {
            bad("id", "\"direct\" is reserved for GNOME_WISP_UPSTREAM");
        } else if !ids.insert(p.id.clone()) {
            bad("id", "is used twice");
        }
        for (field, value, max, required) in [
            ("label", &p.label, 64, true),
            ("country", &p.country, 64, true),
            ("city", &p.city, 64, true),
            ("provider_note", &p.provider_note, 200, false),
        ] {
            let len = value.chars().count();
            if required && value.trim().is_empty() {
                bad(field, "is required");
            } else if len > max {
                bad(field, &format!("must be at most {max} characters"));
            } else if value.chars().any(char::is_control) {
                bad(field, "must not contain control characters");
            }
        }
        let country_code = p.country_code.to_ascii_lowercase();
        if country_code.len() != 2 || !country_code.bytes().all(|b| b.is_ascii_lowercase()) {
            bad("country_code", "must be a two-letter ISO 3166-1 code, e.g. \"se\"");
        }
        match UpstreamAddr::parse(&p.wisp_upstream) {
            Ok(upstream) => profiles.push(VpnProfile {
                id: p.id,
                label: p.label.trim().to_string(),
                country_code,
                country: p.country.trim().to_string(),
                city: p.city.trim().to_string(),
                provider_note: p.provider_note.trim().to_string(),
                upstream,
            }),
            Err(e) => bad("wisp_upstream", &e),
        }
    }
    let mut seen = HashSet::new();
    for p in &profiles {
        if !seen.insert(p.upstream.authority()) {
            problems.push(format!(
                "{}: profiles share wisp_upstream {}; every location needs its own HolyWisp instance",
                path.display(),
                p.upstream
            ));
        }
    }
    if problems.is_empty() { Ok(profiles) } else { Err(problems) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"
[[profile]]
id = "se-got"
label = "Sweden · Gothenburg"
country_code = "SE"
country = "Sweden"
city = "Gothenburg"
provider_note = "Mullvad WireGuard, operator account"
wisp_upstream = "127.0.0.1:6002"

[[profile]]
id = "ch-zrh"
label = "Switzerland · Zurich"
country_code = "ch"
country = "Switzerland"
city = "Zurich"
wisp_upstream = "gluetun:6003"
"#;

    fn parse_str(text: &str) -> Result<Vec<VpnProfile>, Vec<String>> {
        parse(Path::new("profiles.toml"), text)
    }

    #[test]
    fn valid_file() {
        let p = parse_str(GOOD).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].country_code, "se", "lowercased");
        assert_eq!(p[0].path(), "/wisp/p/se-got/");
        assert_eq!(p[1].provider_note, "");
        assert_eq!(p[1].upstream.host(), "gluetun");
        assert_eq!(parse_str("").unwrap(), vec![], "an empty file means no profiles");
    }

    #[test]
    fn every_problem_is_reported() {
        let bad = r#"
[[profile]]
id = "Bad_ID"
label = ""
country_code = "swe"
country = "Sweden"
city = "Gothenburg"
wisp_upstream = "8.8.8.8:6002"

[[profile]]
id = "direct"
label = "x"
country_code = "se"
country = "x"
city = "x"
wisp_upstream = "localhost:6003"
"#;
        let problems = parse_str(bad).unwrap_err();
        let joined = problems.join("\n");
        for needle in
            ["id must be", "label is required", "country_code", "not an internal address", "reserved", "127.0.0.1"]
        {
            assert!(joined.contains(needle), "missing {needle:?} in {joined}");
        }
    }

    #[test]
    fn the_shipped_example_is_valid() {
        let text = include_str!("../../../services/vpn/profiles.example.toml");
        let p = parse_str(text).unwrap();
        assert_eq!(p.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["se-got", "ch-zrh"]);
        assert_eq!(p[0].upstream.authority(), "gluetun:6002");
        // The commented recipe-B profile is valid too once uncommented.
        let uncommented: String = text
            .lines()
            .map(|l| l.strip_prefix("# ").filter(|r| r.starts_with('[') || r.contains(" = ")).unwrap_or(l))
            .collect::<Vec<_>>()
            .join("\n");
        let all = parse_str(&uncommented).unwrap();
        assert_eq!(all.len(), 3, "{uncommented}");
        assert_eq!(all[2].upstream.authority(), "127.0.0.1:6004");
    }

    #[test]
    fn duplicates_and_unknown_keys() {
        let dup = GOOD.replace("ch-zrh", "se-got");
        assert!(parse_str(&dup).unwrap_err()[0].contains("used twice"));
        let shared = GOOD.replace("gluetun:6003", "127.0.0.1:6002");
        assert!(parse_str(&shared).unwrap_err()[0].contains("share wisp_upstream"));
        let typo = GOOD.replace("wisp_upstream = \"gluetun:6003\"", "wisp_upsteam = \"gluetun:6003\"");
        assert!(parse_str(&typo).unwrap_err()[0].contains("unknown field"), "{:?}", parse_str(&typo));
        assert!(parse_str("[[profile]]\nid = 1").is_err());
    }
}
