//! Curated open-source games (`oss-games.toml`, research §8.2), self-hosted from the proxy origin.
//!
//! Records use `embed_kind = selfhost` and a relative embed path `/oss/<slug>/<entry>`; the server serves the build
//! from `$GNOME_OSS_GAMES_DIR/<slug>/` on the proxy origin (never with the app origin's privileges). Only enabled
//! entries whose build exists are imported (unless `GNOME_OSS_REQUIRE_BUILDS=false`), so the catalog never lists
//! a game that cannot load.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{ItemCtx, Reject, finalize, normalize_tags};
use crate::categories::Category;
use crate::config::OssConfig;
use crate::error::CatalogError;
use crate::model::{EmbedKind, NewGame, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_NAME, MAX_TITLE};
use crate::url::Url;

/// The manifest shipped with the crate.
pub const EMBEDDED_MANIFEST: &str = include_str!("../../oss-games.toml");

/// URL path prefix under which the proxy origin serves self-hosted builds.
pub const PATH_PREFIX: &str = "/oss/";

/// Manifest file.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    /// Manifest entries.
    pub games: Vec<OssEntry>,
}

/// One manifest entry (also stored verbatim, as JSON, as the record's raw data).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OssEntry {
    /// URL slug and stable id.
    pub slug: String,
    /// Title (README heading).
    pub title: String,
    /// `https://github.com/<owner>/<repo>`.
    pub repo: String,
    /// Pinned commit (40 hex) the build is made from.
    #[serde(default)]
    pub commit: Option<String>,
    /// SPDX identifier.
    pub license: String,
    #[serde(default)]
    /// Licence file at the pinned commit.
    pub license_file: Option<String>,
    /// Copyright line from the licence file, when it has one.
    #[serde(default)]
    pub copyright: Option<String>,
    /// Author / copyright holder.
    pub author: String,
    /// Entry HTML file, relative to the repository root.
    pub entry: String,
    /// `static` (the checkout runs as-is), `required` (build step) or `server` (needs a server component).
    pub build: String,
    #[serde(default)]
    /// Image path inside the build.
    pub thumbnail: Option<String>,
    /// GNOME category slugs.
    pub categories: Vec<String>,
    #[serde(default)]
    /// Tags.
    pub tags: Vec<String>,
    #[serde(default)]
    /// Description (README / repository description).
    pub description: Option<String>,
    #[serde(default)]
    /// How to play.
    pub instructions: Option<String>,
    #[serde(default)]
    /// Project homepage.
    pub homepage: Option<String>,
    /// Whether the entry may be imported.
    pub enabled: bool,
    #[serde(default)]
    /// Verification notes.
    pub notes: Option<String>,
}

/// A safe relative path inside a build (no traversal, no absolute paths, no odd characters).
pub fn is_safe_relative_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 200
        && !p.starts_with('/')
        && p.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
}

impl OssEntry {
    /// Validate the entry (called for every entry when the manifest is loaded).
    pub fn validate(&self) -> Result<(), String> {
        if !crate::slug::is_valid_slug(&self.slug) {
            return Err(format!("invalid slug {:?}", self.slug));
        }
        let repo = Url::parse(&self.repo).filter(|u| u.scheme == "https" && u.host == "github.com");
        if repo.as_ref().is_none_or(|u| u.path.trim_matches('/').split('/').count() != 2) {
            return Err(format!("{}: repo must be https://github.com/<owner>/<repo>", self.slug));
        }
        if let Some(c) = &self.commit
            && (c.len() != 40 || !c.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(format!("{}: commit must be 40 hex characters", self.slug));
        }
        if !is_safe_relative_path(&self.entry) || !self.entry.ends_with(".html") {
            return Err(format!("{}: unsafe entry path {:?}", self.slug, self.entry));
        }
        if let Some(t) = &self.thumbnail
            && !is_safe_relative_path(t)
        {
            return Err(format!("{}: unsafe thumbnail path {t:?}", self.slug));
        }
        if !matches!(self.build.as_str(), "static" | "required" | "server") {
            return Err(format!("{}: build must be static, required or server", self.slug));
        }
        if self.license.is_empty() || !self.license.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        {
            return Err(format!("{}: license must be an SPDX identifier", self.slug));
        }
        if self.categories.is_empty() || self.categories.iter().any(|c| Category::from_slug(c).is_none()) {
            return Err(format!("{}: categories must be GNOME category slugs", self.slug));
        }
        if self.title.trim().is_empty() || self.author.trim().is_empty() {
            return Err(format!("{}: title and author are required", self.slug));
        }
        Ok(())
    }

    /// Whether the entry may be imported: enabled, static, and (when required) its build is present.
    pub fn importable(&self, cfg: &OssConfig) -> bool {
        self.enabled && self.build == "static" && (!cfg.require_builds || build_present(&cfg.builds_dir, self))
    }
}

fn build_present(dir: &Path, e: &OssEntry) -> bool {
    dir.join(&e.slug).join(&e.entry).is_file()
}

/// Load and validate the configured manifest (the embedded one by default).
pub fn load_manifest(cfg: &OssConfig) -> Result<Manifest, CatalogError> {
    let text = match &cfg.manifest {
        Some(p) => std::fs::read_to_string(p)
            .map_err(|e| CatalogError::Config(format!("GNOME_OSS_MANIFEST {}: {e}", p.display())))?,
        None => EMBEDDED_MANIFEST.to_owned(),
    };
    parse_manifest(&text)
}

/// Parse and validate manifest text.
pub fn parse_manifest(text: &str) -> Result<Manifest, CatalogError> {
    let m: Manifest = toml::from_str(text).map_err(|e| CatalogError::Data(format!("oss manifest: {e}")))?;
    let mut seen = std::collections::HashSet::new();
    for e in &m.games {
        e.validate().map_err(|err| CatalogError::Data(format!("oss manifest: {err}")))?;
        if !seen.insert(e.slug.clone()) {
            return Err(CatalogError::Data(format!("oss manifest: duplicate slug {}", e.slug)));
        }
    }
    Ok(m)
}

/// Normalize a manifest entry.
pub fn normalize_entry(e: &OssEntry, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
    e.validate()?;
    let raw = serde_json::to_string(e).map_err(|err| err.to_string())?;
    let owner = e.repo.trim_end_matches('/').rsplit('/').nth(1).unwrap_or("");
    let (mut tags, flags) = normalize_tags(e.tags.iter().map(String::as_str));
    tags.truncate(super::MAX_TAGS);
    let thumbnail = e.thumbnail.as_ref().map(|t| format!("{PATH_PREFIX}{}/{t}", e.slug));
    // The manifest is plain text written by the operator: taken literally ("in a <canvas>" is not markup).
    let attribution = match &e.copyright {
        Some(c) => format!("{} · {}", e.license, text::clean_plain_line(c, 200)),
        None => format!("{} · {}", e.license, text::clean_plain_line(&e.author, MAX_NAME)),
    };
    let g = NewGame {
        source: Source::Oss,
        source_id: e.slug.clone(),
        slug_hint: Some(e.slug.clone()),
        title: text::clean_plain_line(&e.title, MAX_TITLE),
        developer: Some(text::clean_plain_line(&e.author, MAX_NAME)),
        developer_url: (!owner.is_empty()).then(|| format!("https://github.com/{owner}")),
        description: text::clean_plain_block(e.description.as_deref().unwrap_or(""), MAX_DESCRIPTION),
        instructions: text::clean_plain_block(e.instructions.as_deref().unwrap_or(""), MAX_INSTRUCTIONS),
        thumbnail_url: thumbnail.clone(),
        thumbnails: thumbnail
            .map(|url| Thumbnail { url, w: None, h: None, kind: ThumbKind::Icon })
            .into_iter()
            .collect(),
        embed_kind: EmbedKind::Selfhost,
        embed_url: format!("{PATH_PREFIX}{}/{}", e.slug, e.entry),
        width: None,
        height: None,
        orientation: None,
        mobile: None,
        source_url: Some(e.repo.clone()),
        license: Some(e.license.clone()),
        attribution,
        categories: e.categories.iter().filter_map(|c| Category::from_slug(c)).collect(),
        source_categories: Vec::new(),
        tags,
        flags,
        published_at: None,
        source_updated_at: None,
        quality: None,
        source_rank: None,
        ip_risk_term: None,
        raw,
    };
    finalize(g, ctx)
}

/// Re-normalize a stored raw record.
pub fn normalize_raw(raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
    let e: OssEntry = serde_json::from_str(raw).map_err(|err| format!("oss raw record: {err}"))?;
    normalize_entry(&e, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_is_valid() {
        let m = parse_manifest(EMBEDDED_MANIFEST).unwrap();
        assert!(m.games.len() >= 20, "all §8.2 repositories are listed");
        let enabled: Vec<&str> = m.games.iter().filter(|g| g.enabled).map(|g| g.slug.as_str()).collect();
        assert!(enabled.contains(&"2048") && enabled.contains(&"hexgl"));
        for g in m.games.iter().filter(|g| g.enabled) {
            assert_eq!(g.build, "static", "{}", g.slug);
            assert!(g.commit.is_some(), "{} is pinned", g.slug);
        }
    }

    #[test]
    fn manifest_text_is_taken_literally() {
        let m = parse_manifest(EMBEDDED_MANIFEST).unwrap();
        let e = m.games.iter().find(|g| g.slug == "javascript-breakout").unwrap();
        let cfg = crate::config::CatalogConfig::default();
        let g = normalize_entry(e, &ItemCtx { rank: 1, reported_total: None, config: &cfg }).unwrap();
        assert!(g.description.ends_with("in a <canvas>"), "{:?}", g.description);
    }

    #[test]
    fn path_safety() {
        for ok in ["index.html", "v4.final.html", "meta/apple-touch-icon.png"] {
            assert!(is_safe_relative_path(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x.html", "a/../b.html", "a//b", "a\\b", "a b.html", "./x"] {
            assert!(!is_safe_relative_path(bad), "{bad}");
        }
    }

    #[test]
    fn invalid_entries_are_rejected() {
        let base = parse_manifest(EMBEDDED_MANIFEST).unwrap().games[0].clone();
        let mut e = base.clone();
        e.entry = "../../secret.html".into();
        assert!(e.validate().is_err());
        let mut e = base.clone();
        e.repo = "https://gitlab.com/x/y".into();
        assert!(e.validate().is_err());
        let mut e = base;
        e.categories = vec!["girls".into()];
        assert!(e.validate().is_err());
        assert!(parse_manifest("[[games]]\nslug = \"x\"\n").is_err());
    }
}
