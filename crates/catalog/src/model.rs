//! The unified, normalized game record produced by every importer, and shared enums.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::categories::Category;
use crate::source::Source;

/// How a game is presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmbedKind {
    /// Publisher embed loaded as a direct cross-origin iframe (never proxied, never ad-blocked).
    Iframe,
    /// Open-source build served from the proxy origin.
    Selfhost,
    /// Link-out only: open `source_url` in a new tab; the site forbids framing.
    Link,
}

impl EmbedKind {
    /// Database / API value.
    pub const fn as_str(self) -> &'static str {
        match self {
            EmbedKind::Iframe => "iframe",
            EmbedKind::Selfhost => "selfhost",
            EmbedKind::Link => "link",
        }
    }

    /// Parse the database value.
    pub fn parse(s: &str) -> Option<EmbedKind> {
        Some(match s {
            "iframe" => EmbedKind::Iframe,
            "selfhost" => EmbedKind::Selfhost,
            "link" => EmbedKind::Link,
            _ => return None,
        })
    }

    /// Whether the game can be played inside GNOME.
    pub const fn playable(self) -> bool {
        !matches!(self, EmbedKind::Link)
    }
}

/// Screen orientation of a game.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    /// Wider than tall.
    Landscape,
    /// Taller than wide.
    Portrait,
    /// Works in both orientations.
    Any,
}

impl Orientation {
    /// Database / API value.
    pub const fn as_str(self) -> &'static str {
        match self {
            Orientation::Landscape => "landscape",
            Orientation::Portrait => "portrait",
            Orientation::Any => "any",
        }
    }

    /// Parse the database value.
    pub fn parse(s: &str) -> Option<Orientation> {
        Some(match s {
            "landscape" => Orientation::Landscape,
            "portrait" => Orientation::Portrait,
            "any" => Orientation::Any,
            _ => return None,
        })
    }
}

/// Image role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThumbKind {
    /// ~4:3 or 16:9/16:10 card image (the preferred thumbnail).
    Landscape,
    /// 1:1.
    Square,
    /// Small square icon.
    Icon,
    /// Very wide banner.
    Wide,
}

/// One image of a game.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thumbnail {
    /// Absolute image URL (or a `/oss/...` path for self-hosted games).
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Width in pixels, when known.
    pub w: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Height in pixels, when known.
    pub h: Option<u32>,
    /// Role of the image.
    pub kind: ThumbKind,
}

/// A normalized record, ready to be stored. Built only from real source data (feed items or the OSS manifest).
#[derive(Debug, Clone, PartialEq)]
pub struct NewGame {
    /// Source of the record.
    pub source: Source,
    /// Stable ID inside the source.
    pub source_id: String,
    /// Preferred slug base (the source's own slug when it has one).
    pub slug_hint: Option<String>,
    /// Cleaned title (at most 120 characters).
    pub title: String,
    /// Developer / author, when the source exposes it.
    pub developer: Option<String>,
    /// Developer page.
    pub developer_url: Option<String>,
    /// Cleaned description (paragraphs kept).
    pub description: String,
    /// How to play / controls.
    pub instructions: String,
    /// Best card image (absolute URL, or a `/oss/...` path for self-hosted games).
    pub thumbnail_url: Option<String>,
    /// All images of the game.
    pub thumbnails: Vec<Thumbnail>,
    /// How the game is presented.
    pub embed_kind: EmbedKind,
    /// Embed URL template (placeholders such as `{gamepix_sid}` are filled at render time), the relative path of a
    /// self-hosted build, or the link-out URL.
    pub embed_url: String,
    /// Preferred frame width.
    pub width: Option<u32>,
    /// Preferred frame height.
    pub height: Option<u32>,
    /// Screen orientation.
    pub orientation: Option<Orientation>,
    /// `None` = unknown.
    pub mobile: Option<bool>,
    /// Canonical page at the source (attribution / link-out).
    pub source_url: Option<String>,
    /// SPDX identifier (self-hosted open-source games).
    pub license: Option<String>,
    /// Attribution line ("via GamePix", "MIT · Copyright …").
    pub attribution: String,
    /// GNOME categories, primary first (at most 3).
    pub categories: Vec<Category>,
    /// Raw source categories/genres (for re-mapping and the search keywords).
    pub source_categories: Vec<String>,
    /// Normalized tags.
    pub tags: Vec<String>,
    /// Content flags (`kids_friendly`, `no_blood`, `iap`, `paid`, ...).
    pub flags: Vec<String>,
    /// Publication time at the source (Unix ms).
    pub published_at: Option<i64>,
    /// Last update at the source (Unix ms).
    pub source_updated_at: Option<i64>,
    /// Source quality/popularity signal normalized to 0..1 (cold-start ranking). `None` = no signal.
    pub quality: Option<f64>,
    /// Position in the source's own ranking (1 = best), when the feed is ranked.
    pub source_rank: Option<u32>,
    /// Blocklist term that matched (→ status `ip_risk`).
    pub ip_risk_term: Option<String>,
    /// The original record (JSON) for re-mapping.
    pub raw: String,
}

impl NewGame {
    /// Whether the game can be played inside GNOME.
    pub fn playable(&self) -> bool {
        self.embed_kind.playable()
    }

    /// Search keywords indexed by FTS: category slugs, tags and source categories (deduplicated).
    pub fn keywords(&self) -> String {
        let mut words: Vec<String> = Vec::new();
        let items = self
            .categories
            .iter()
            .map(|c| c.slug().to_owned())
            .chain(self.tags.iter().cloned())
            .chain(self.source_categories.iter().map(|c| c.to_lowercase()));
        for w in items {
            if !w.is_empty() && !words.contains(&w) {
                words.push(w);
            }
        }
        words.join(" ")
    }

    /// Change-detection hashes `(text, meta)`: `text` covers the full-text-indexed columns (title, developer,
    /// keywords, description), `meta` every other normalized field except the volatile ranking inputs
    /// (`quality`, `source_rank`), which are refreshed separately on every sync without touching the FTS index.
    pub fn hashes(&self) -> (String, String) {
        let opt = |o: &Option<String>| o.clone().unwrap_or_else(|| "\u{0}".to_owned());
        let num = |o: Option<i64>| o.map_or_else(|| "\u{0}".to_owned(), |v| v.to_string());
        let text = digest(&[&self.title, &opt(&self.developer), &self.keywords(), &self.description]);
        let meta = digest(&[
            self.source.id(),
            &self.source_id,
            &opt(&self.developer_url),
            &self.instructions,
            &opt(&self.thumbnail_url),
            &serde_json::to_string(&self.thumbnails).unwrap_or_default(),
            self.embed_kind.as_str(),
            &self.embed_url,
            &num(self.width.map(i64::from)),
            &num(self.height.map(i64::from)),
            self.orientation.map_or("\u{0}", Orientation::as_str),
            &num(self.mobile.map(i64::from)),
            &opt(&self.source_url),
            &opt(&self.license),
            &self.attribution,
            &self.categories.iter().map(|c| c.slug()).collect::<Vec<_>>().join(","),
            &self.source_categories.join("\u{1}"),
            &self.tags.join("\u{1}"),
            &self.flags.join("\u{1}"),
            &num(self.published_at),
            &num(self.source_updated_at),
            &opt(&self.ip_risk_term),
        ]);
        (text, meta)
    }
}

/// Length-prefixed SHA-256 over the parts, truncated to 128 bits, hex.
fn digest(parts: &[&str]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_le_bytes());
        h.update(p.as_bytes());
    }
    h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect()
}
