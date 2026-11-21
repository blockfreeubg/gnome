//! Catalog configuration (environment variables; see the crate README for the full table).
//!
//! Sources that need an operator publisher/affiliate ID are only enabled when the ID is configured, even if they
//! are listed in `GNOME_CATALOG_SOURCES`; [`CatalogConfig::from_env`] returns a warning for each such source so
//! `gnome-server config check` can explain why.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::blocklist::{Blocklist, Scope};
use crate::dedup::DEFAULT_ORDER;
use crate::error::CatalogError;
use crate::source::Source;

/// Bumped whenever normalization rules change in a way that should re-map stored records (2: text hygiene, frame
/// sizes and sort keys of the 2026-11-11 review).
pub const RULES_VERSION: u32 = 2;

/// Default enabled sources (GamePix public feed + curated open-source games; decision 2026-11-10).
pub const DEFAULT_SOURCES: [Source; 2] = [Source::GamePix, Source::Oss];

/// GamePix settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GamePixConfig {
    /// Publisher SID (`1` = the public default; an unknown SID makes the feed answer HTTP 400).
    pub sid: String,
    /// Items per page (12, 24, 48 or 96).
    pub per_page: u32,
    /// Restrict the import to one GamePix namespace (testing; `None` = whole feed).
    pub category: Option<String>,
}

/// GameDistribution settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameDistributionConfig {
    /// Operator's GameDistribution publisher ID (acknowledges the Publisher Game License Agreement). Not sent to
    /// the feed (it is public); required to enable the source.
    pub publisher_id: Option<String>,
    /// Items per page (max 100).
    pub per_page: u32,
}

/// Playgama settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaygamaConfig {
    /// Partner CLID (filled into embed URLs at render time).
    pub clid: Option<String>,
    /// Items per request.
    pub per_page: u32,
}

/// GameMonetize settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameMonetizeConfig {
    /// Explicit opt-in: the operator registered and added the site in the GameMonetize dashboard.
    pub enabled: bool,
    /// Items per request (`num`, up to 1000).
    pub per_page: u32,
}

/// Famobi settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamobiConfig {
    /// Affiliate ID (e.g. `A-XXXXX`), appended to embed URLs at render time.
    pub affiliate_id: Option<String>,
}

/// itch.io settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItchConfig {
    /// Browse paths (each is fetched as `https://itch.io/<path>.xml?page=N`).
    pub feeds: Vec<String>,
    /// Pages per feed (36 items each).
    pub max_pages: u32,
}

/// js13kGames settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Js13kConfig {
    /// First competition year to import.
    pub first_year: i64,
}

/// Open-source manifest settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OssConfig {
    /// Manifest file; `None` = the `oss-games.toml` embedded in the crate.
    pub manifest: Option<PathBuf>,
    /// Directory holding the built games (`<dir>/<slug>/<entry>`), served from the proxy origin.
    pub builds_dir: PathBuf,
    /// Only import entries whose build exists in `builds_dir` (so the catalog never lists a game that cannot load).
    pub require_builds: bool,
}

/// Complete catalog configuration.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogConfig {
    /// Enabled sources (already gated on operator IDs).
    pub sources: Vec<Source>,
    /// GamePix settings.
    pub gamepix: GamePixConfig,
    /// GameDistribution settings.
    pub gamedistribution: GameDistributionConfig,
    /// Playgama settings.
    pub playgama: PlaygamaConfig,
    /// GameMonetize settings.
    pub gamemonetize: GameMonetizeConfig,
    /// Famobi settings.
    pub famobi: FamobiConfig,
    /// itch.io settings.
    pub itchio: ItchConfig,
    /// js13kGames settings.
    pub js13k: Js13kConfig,
    /// Open-source manifest settings.
    pub oss: OssConfig,
    /// Trademark / knock-off blocklist (matches → status `ip_risk`).
    pub blocklist: Blocklist,
    /// Cross-source dedup preference (most preferred first).
    pub dedup_order: Vec<Source>,
    /// `User-Agent` for feed requests.
    pub user_agent: String,
}

impl Default for CatalogConfig {
    fn default() -> Self {
        Self {
            sources: DEFAULT_SOURCES.to_vec(),
            gamepix: GamePixConfig { sid: "1".into(), per_page: 96, category: None },
            gamedistribution: GameDistributionConfig { publisher_id: None, per_page: 100 },
            playgama: PlaygamaConfig { clid: None, per_page: 250 },
            gamemonetize: GameMonetizeConfig { enabled: false, per_page: 1000 },
            famobi: FamobiConfig { affiliate_id: None },
            itchio: ItchConfig { feeds: vec!["games/free/platform-web".into()], max_pages: 3 },
            js13k: Js13kConfig { first_year: 2012 },
            oss: OssConfig { manifest: None, builds_dir: PathBuf::from("./data/oss-games"), require_builds: true },
            blocklist: Blocklist::default(),
            dedup_order: DEFAULT_ORDER.to_vec(),
            user_agent: format!("GNOME-catalog/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}

fn valid_id(v: &str, max: usize) -> bool {
    !v.is_empty() && v.len() <= max && v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn parse_bool(name: &str, v: &str) -> Result<bool, CatalogError> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        _ => Err(CatalogError::Config(format!("{name}: expected true/false, got {v:?}"))),
    }
}

fn parse_sources(name: &str, v: &str) -> Result<Vec<Source>, CatalogError> {
    let mut out = Vec::new();
    for part in v.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        if part.eq_ignore_ascii_case("none") {
            continue;
        }
        let s = Source::from_id(part).ok_or_else(|| {
            CatalogError::Config(format!(
                "{name}: unknown source {part:?} (known: {})",
                Source::ALL.iter().map(|s| s.id()).collect::<Vec<_>>().join(", ")
            ))
        })?;
        if !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

impl CatalogConfig {
    /// Build the configuration from environment-style variables (`get` returns `None` for unset variables; empty
    /// values count as unset). Returns the configuration and human-readable warnings.
    ///
    /// Recognized variables: `GNOME_CATALOG_SOURCES`, `GNOME_GAMEPIX_SID`, `GNOME_GD_PUBLISHER_ID`,
    /// `GNOME_PLAYGAMA_CLID`, `GNOME_GAMEMONETIZE_ENABLED`, `GNOME_FAMOBI_AFFILIATE_ID`, `GNOME_ITCHIO_FEEDS`,
    /// `GNOME_ITCHIO_MAX_PAGES`, `GNOME_JS13K_FIRST_YEAR`, `GNOME_OSS_MANIFEST`, `GNOME_OSS_GAMES_DIR`
    /// (default `$GNOME_DATA_DIR/oss-games`), `GNOME_OSS_REQUIRE_BUILDS`, `GNOME_CATALOG_BLOCKLIST`,
    /// `GNOME_CATALOG_BLOCKLIST_FILE`, `GNOME_CATALOG_DEDUP_ORDER`, `GNOME_CATALOG_USER_AGENT`.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<(Self, Vec<String>), CatalogError> {
        let get = |k: &str| get(k).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let mut c = CatalogConfig::default();
        let mut warnings = Vec::new();

        if let Some(sid) = get("GNOME_GAMEPIX_SID") {
            if !valid_id(&sid, 32) {
                return Err(CatalogError::Config("GNOME_GAMEPIX_SID: 1-32 characters [A-Za-z0-9._-]".into()));
            }
            c.gamepix.sid = sid;
        }
        for (var, slot) in [
            ("GNOME_GD_PUBLISHER_ID", &mut c.gamedistribution.publisher_id),
            ("GNOME_PLAYGAMA_CLID", &mut c.playgama.clid),
            ("GNOME_FAMOBI_AFFILIATE_ID", &mut c.famobi.affiliate_id),
        ] {
            if let Some(v) = get(var) {
                if !valid_id(&v, 64) {
                    return Err(CatalogError::Config(format!("{var}: 1-64 characters [A-Za-z0-9._-]")));
                }
                *slot = Some(v);
            }
        }
        if let Some(v) = get("GNOME_GAMEMONETIZE_ENABLED") {
            c.gamemonetize.enabled = parse_bool("GNOME_GAMEMONETIZE_ENABLED", &v)?;
        }
        if let Some(v) = get("GNOME_ITCHIO_FEEDS") {
            let feeds: Vec<String> =
                v.split(',').map(|f| f.trim().trim_matches('/').to_owned()).filter(|f| !f.is_empty()).collect();
            for f in &feeds {
                let ok = f.split('/').all(|seg| {
                    !seg.is_empty()
                        && seg != ".."
                        && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                });
                if !ok || f.len() > 200 {
                    return Err(CatalogError::Config(format!(
                        "GNOME_ITCHIO_FEEDS: {f:?} is not an itch.io browse path like games/free/platform-web"
                    )));
                }
            }
            c.itchio.feeds = feeds;
        }
        if let Some(v) = get("GNOME_ITCHIO_MAX_PAGES") {
            c.itchio.max_pages = v
                .parse()
                .ok()
                .filter(|n| (1..=20).contains(n))
                .ok_or_else(|| CatalogError::Config("GNOME_ITCHIO_MAX_PAGES: 1..20".into()))?;
        }
        if let Some(v) = get("GNOME_JS13K_FIRST_YEAR") {
            c.js13k.first_year = v
                .parse()
                .ok()
                .filter(|y| (2012..=2100).contains(y))
                .ok_or_else(|| CatalogError::Config("GNOME_JS13K_FIRST_YEAR: 2012..2100".into()))?;
        }
        if let Some(v) = get("GNOME_OSS_MANIFEST") {
            c.oss.manifest = Some(PathBuf::from(v));
        }
        c.oss.builds_dir = match get("GNOME_OSS_GAMES_DIR") {
            Some(d) => PathBuf::from(d),
            None => PathBuf::from(get("GNOME_DATA_DIR").unwrap_or_else(|| "./data".into())).join("oss-games"),
        };
        if let Some(v) = get("GNOME_OSS_REQUIRE_BUILDS") {
            c.oss.require_builds = parse_bool("GNOME_OSS_REQUIRE_BUILDS", &v)?;
        }
        if let Some(v) = get("GNOME_CATALOG_BLOCKLIST") {
            for term in v.split(',') {
                match term.trim().strip_prefix('!') {
                    Some(t) => c.blocklist.remove(t),
                    None => c.blocklist.add(term, Scope::Any),
                }
            }
        }
        if let Some(path) = get("GNOME_CATALOG_BLOCKLIST_FILE") {
            let text = std::fs::read_to_string(&path)
                .map_err(|e| CatalogError::Config(format!("GNOME_CATALOG_BLOCKLIST_FILE {path}: {e}")))?;
            c.blocklist.apply_file(&text);
        }
        if let Some(v) = get("GNOME_CATALOG_DEDUP_ORDER") {
            let mut order = parse_sources("GNOME_CATALOG_DEDUP_ORDER", &v)?;
            for s in DEFAULT_ORDER {
                if !order.contains(&s) {
                    order.push(s);
                }
            }
            c.dedup_order = order;
        }
        if let Some(ua) = get("GNOME_CATALOG_USER_AGENT") {
            if ua.len() > 200 || ua.bytes().any(|b| b < 0x20 || b == 0x7f) {
                return Err(CatalogError::Config("GNOME_CATALOG_USER_AGENT: printable, <= 200 bytes".into()));
            }
            c.user_agent = ua;
        }

        let requested = match get("GNOME_CATALOG_SOURCES") {
            Some(v) => parse_sources("GNOME_CATALOG_SOURCES", &v)?,
            None => DEFAULT_SOURCES.to_vec(),
        };
        c.sources = Vec::new();
        for s in requested {
            match c.missing_requirement(s) {
                Some(why) => warnings.push(format!("catalog source {} stays disabled: {why}", s.id())),
                None => c.sources.push(s),
            }
        }
        Ok((c, warnings))
    }

    /// Why `source` cannot be enabled with this configuration (`None` = it can).
    pub fn missing_requirement(&self, source: Source) -> Option<&'static str> {
        match source {
            Source::GameDistribution if self.gamedistribution.publisher_id.is_none() => {
                Some("set GNOME_GD_PUBLISHER_ID (GameDistribution licenses embeds to registered publishers only)")
            }
            Source::Playgama if self.playgama.clid.is_none() => {
                Some("set GNOME_PLAYGAMA_CLID (partner CLID from widgets.playgama.com)")
            }
            Source::GameMonetize if !self.gamemonetize.enabled => Some(
                "set GNOME_GAMEMONETIZE_ENABLED=true after adding your site in the GameMonetize publisher dashboard",
            ),
            Source::Famobi if self.famobi.affiliate_id.is_none() => {
                Some("set GNOME_FAMOBI_AFFILIATE_ID (approved Famobi affiliate ID)")
            }
            _ => None,
        }
    }

    /// Whether `source` is enabled.
    pub fn is_enabled(&self, source: Source) -> bool {
        self.sources.contains(&source)
    }

    /// Fingerprint of everything that affects normalization of stored records (rules version + blocklist).
    pub fn rules_fingerprint(&self) -> String {
        let mut h = Sha256::new();
        h.update(RULES_VERSION.to_le_bytes());
        for t in self.blocklist.terms() {
            h.update(t.words.as_bytes());
            h.update(match t.scope {
                Scope::Any => b"\x01",
                Scope::Title => b"\x02",
                Scope::Labels => b"\x03",
                Scope::TitleStart => b"\x04",
            });
        }
        h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
    }

    /// Fingerprint of the listing configuration (enabled sources + dedup preference).
    pub fn listing_fingerprint(&self) -> String {
        let mut h = Sha256::new();
        let mut enabled: Vec<&str> = self.sources.iter().map(|s| s.id()).collect();
        enabled.sort_unstable();
        h.update(enabled.join(",").as_bytes());
        h.update(b"|");
        h.update(self.dedup_order.iter().map(|s| s.id()).collect::<Vec<_>>().join(",").as_bytes());
        h.finalize().iter().take(12).map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn defaults_are_gamepix_and_oss() {
        let (c, w) = CatalogConfig::from_env(env(&[])).unwrap();
        assert_eq!(c.sources, vec![Source::GamePix, Source::Oss]);
        assert_eq!(c.gamepix.sid, "1");
        assert!(w.is_empty());
        assert_eq!(c.oss.builds_dir, PathBuf::from("./data/oss-games"));
    }

    #[test]
    fn operator_id_sources_are_gated() {
        let (c, w) = CatalogConfig::from_env(env(&[(
            "GNOME_CATALOG_SOURCES",
            "gamepix, gamedistribution,playgama,gamemonetize,famobi,itchio,js13k",
        )]))
        .unwrap();
        assert_eq!(c.sources, vec![Source::GamePix, Source::ItchIo, Source::Js13k]);
        assert_eq!(w.len(), 4, "{w:?}");
        let (c, w) = CatalogConfig::from_env(env(&[
            ("GNOME_CATALOG_SOURCES", "gd,playgama,gm,famobi"),
            ("GNOME_GD_PUBLISHER_ID", "pub-123"),
            ("GNOME_PLAYGAMA_CLID", "abc"),
            ("GNOME_GAMEMONETIZE_ENABLED", "true"),
            ("GNOME_FAMOBI_AFFILIATE_ID", "A-1000-10"),
            ("GNOME_DATA_DIR", "/srv/gnome"),
        ]))
        .unwrap();
        assert!(w.is_empty());
        assert_eq!(c.sources.len(), 4);
        assert_eq!(c.oss.builds_dir, PathBuf::from("/srv/gnome/oss-games"));
    }

    #[test]
    fn invalid_values_are_errors() {
        assert!(CatalogConfig::from_env(env(&[("GNOME_CATALOG_SOURCES", "crazygames")])).is_err());
        assert!(CatalogConfig::from_env(env(&[("GNOME_GAMEPIX_SID", "a b")])).is_err());
        assert!(CatalogConfig::from_env(env(&[("GNOME_GAMEMONETIZE_ENABLED", "maybe")])).is_err());
        assert!(CatalogConfig::from_env(env(&[("GNOME_ITCHIO_FEEDS", "../admin")])).is_err());
        assert!(CatalogConfig::from_env(env(&[("GNOME_CATALOG_SOURCES", "none")])).unwrap().0.sources.is_empty());
    }

    #[test]
    fn blocklist_and_order_overrides_change_fingerprints() {
        let (a, _) = CatalogConfig::from_env(env(&[])).unwrap();
        let (b, _) = CatalogConfig::from_env(env(&[("GNOME_CATALOG_BLOCKLIST", "elsa,!lego")])).unwrap();
        assert_ne!(a.rules_fingerprint(), b.rules_fingerprint());
        assert_eq!(b.blocklist.check("Elsa Dress Up", &[]), Some("elsa"));
        let (d, _) = CatalogConfig::from_env(env(&[("GNOME_CATALOG_DEDUP_ORDER", "gamepix")])).unwrap();
        assert_eq!(d.dedup_order[0], Source::GamePix);
        assert_eq!(d.dedup_order.len(), 8);
        assert_ne!(a.listing_fingerprint(), d.listing_fingerprint());
    }
}
