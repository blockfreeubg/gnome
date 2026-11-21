//! Per-source importers: request planning, page parsing and normalization into [`NewGame`].
//!
//! Each source module documents its endpoint, the verified parameters and the JSON/XML shape (serde structs),
//! following `docs/research/games-sources.md`. Parsing is tolerant: a page is split into raw items first, and each
//! item is deserialized on its own, so one odd record is rejected without failing the page.

pub mod famobi;
pub mod gamedistribution;
pub mod gamemonetize;
pub mod gamepix;
pub mod itchio;
pub mod js13k;
pub mod oss;
pub mod playgama;
pub mod rss;

use serde_json::value::RawValue;

use crate::blocklist::Blocklist;
use crate::categories::{self, Category, CategoryInput, is_gendered, normalize_token};
use crate::config::CatalogConfig;
use crate::fetch::FetchRequest;
use crate::model::NewGame;
use crate::source::Source;
use crate::text;

/// One page (request) of a sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRef {
    /// 1-based request number within the source's paging scheme (page number, js13k year, ...).
    pub number: u32,
    /// Index of the feed for multi-feed sources (itch.io).
    pub feed: usize,
    /// Cache key for HTTP validators (stable across syncs).
    pub key: String,
    /// Absolute URL.
    pub url: String,
    /// Request body (POST sources).
    pub body: Option<Vec<u8>>,
}

/// What a page contained, as needed for paging (also replayed from the cache on `304 Not Modified`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageInfo {
    /// Number of items the page listed (before normalization).
    pub item_count: usize,
    /// Source-provided pointer to the next page (GamePix `next_url`).
    pub next_hint: Option<String>,
    /// Total the source reports for the whole catalog.
    pub reported_total: Option<u64>,
    /// Set when the page proves the sync did not cover the whole catalog (e.g. a "last page" that is not last).
    pub truncated: Option<String>,
}

/// A parsed 200 response.
#[derive(Debug, Clone, Default)]
pub struct ParsedPage {
    /// Raw items (JSON text), in feed order.
    pub items: Vec<String>,
    /// Paging info.
    pub info: PageInfo,
}

/// Why a record was not imported.
pub type Reject = String;

/// Context for normalizing one item.
#[derive(Debug, Clone, Copy)]
pub struct ItemCtx<'a> {
    /// 1-based position in the source's ordering across the whole sync.
    pub rank: u32,
    /// Total reported by the source, if any.
    pub reported_total: Option<u64>,
    /// The catalog configuration (blocklist, publisher settings).
    pub config: &'a CatalogConfig,
}

impl ItemCtx<'_> {
    fn blocklist(&self) -> &Blocklist {
        &self.config.blocklist
    }
}

/// The per-source importer interface used by the import driver.
pub trait Adapter: Send + Sync {
    /// The source.
    fn source(&self) -> Source;
    /// First page of a sync (`now_ms` lets yearly sources pick the current year).
    fn first(&self, now_ms: i64) -> PageRef;
    /// HTTP request for a page (without `User-Agent`/conditional headers, which the driver adds).
    fn request(&self, page: &PageRef) -> FetchRequest;
    /// Split a successful response into raw items and paging info.
    fn parse(&self, page: &PageRef, body: &[u8]) -> Result<ParsedPage, String>;
    /// The page after `page`, or `None` at the end of the catalog.
    fn next(&self, page: &PageRef, info: &PageInfo, now_ms: i64) -> Option<PageRef>;
    /// Normalize one raw item.
    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject>;
    /// Whether an HTTP status for this page means "no more pages" rather than an error (js13k's current year
    /// before the competition).
    fn is_end_status(&self, _page: &PageRef, _status: u16) -> bool {
        false
    }
}

/// The adapter for an HTTP source.
pub fn adapter(source: Source, config: &CatalogConfig) -> Option<Box<dyn Adapter>> {
    Some(match source {
        Source::GamePix => Box::new(gamepix::GamePix::new(config)),
        Source::GameDistribution => Box::new(gamedistribution::GameDistribution::new(config)),
        Source::Playgama => Box::new(playgama::Playgama::new(config)),
        Source::GameMonetize => Box::new(gamemonetize::GameMonetize::new(config)),
        Source::Famobi => Box::new(famobi::Famobi),
        Source::ItchIo => Box::new(itchio::ItchIo::new(config)),
        Source::Js13k => Box::new(js13k::Js13k::new(config)),
        Source::Oss => return None,
    })
}

/// Re-normalize a stored raw record (used when mapping rules or the blocklist change).
pub fn renormalize(source: Source, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
    match source {
        Source::Oss => oss::normalize_raw(raw, ctx),
        s => adapter(s, ctx.config).ok_or_else(|| "no adapter".to_owned())?.normalize(raw, ctx),
    }
}

/// Split a JSON array body into raw item strings.
pub(crate) fn split_json_array(body: &[u8]) -> Result<Vec<String>, String> {
    let items: Vec<Box<RawValue>> = serde_json::from_slice(body).map_err(|e| format!("invalid JSON array: {e}"))?;
    Ok(items.into_iter().map(|r| r.get().to_owned()).collect())
}

/// Tags that carry no information (SEO padding, platforms, engines; research §9.4).
fn is_noise_tag(t: &str) -> bool {
    const NOISE: &[&str] = &[
        "free-games-for-your-site",
        "free-games-for-your-website",
        "free-games",
        "free",
        "best-games",
        "best",
        "html5",
        "html-5",
        "webgl",
        "android",
        "mobile",
        "ios",
        "h5",
        "unity",
        "unity3d",
        "unity-webgl",
        "unity-3d",
        "crazy-games",
        "unblocked",
        "unblocked-games",
        "gam-supported-games",
        "games",
        "game",
        "online",
        "online-games",
        "browser",
        "browser-games",
        "new",
        "new-games",
        "popular",
        "top",
        "hot",
        "1-player",
        "1player",
        "single-player",
        "kids-games",
        "kidgames",
        "gam-supported",
        "borwser",
        "iphone",
        "ipad",
        "tablet",
        "desktop",
        "pc",
    ];
    if NOISE.contains(&t) || t.ends_with("-games-online") {
        return true;
    }
    // "2026", "2025-games"
    let year = t.strip_suffix("-games").unwrap_or(t);
    year.len() == 4 && year.starts_with("20") && year.bytes().all(|b| b.is_ascii_digit())
}

/// Content flags carried as tags by GameDistribution.
fn tag_flag(t: &str) -> Option<&'static str> {
    Some(match t {
        "no-blood" => "no_blood",
        "kids-friendly" => "kids_friendly",
        "no-cruelty" => "no_cruelty",
        _ => return None,
    })
}

/// Maximum tags kept per game.
pub const MAX_TAGS: usize = 20;
/// Largest frame size stored (the schema's `CHECK (width BETWEEN 1 AND 10000)`); anything else is unknown.
pub const MAX_FRAME_SIZE: u32 = 10_000;

/// Normalize free-form tags: cleaned, lowercase, hyphenated, without SEO noise, gendered labels or duplicates.
/// Content flags are returned separately.
pub(crate) fn normalize_tags<'a>(raw: impl IntoIterator<Item = &'a str>) -> (Vec<String>, Vec<String>) {
    let mut tags = Vec::new();
    let mut flags = Vec::new();
    for r in raw {
        let cleaned = text::clean_line(r, 80);
        let full = normalize_token(&cleaned.to_lowercase()).trim_matches(['-', '.']).to_owned();
        let full = if r.trim_start().starts_with(".io") || full == "io" { ".io".to_owned() } else { full };
        if let Some(f) = tag_flag(&full) {
            if !flags.iter().any(|x| x == f) {
                flags.push(f.to_owned());
            }
            continue;
        }
        if full.is_empty()
            || full.chars().count() > text::MAX_TAG
            || !full.chars().any(char::is_alphanumeric)
            || is_gendered(&full)
            || is_noise_tag(&full)
        {
            continue;
        }
        if !tags.contains(&full) {
            tags.push(full);
        }
        if tags.len() >= MAX_TAGS {
            break;
        }
    }
    (tags, flags)
}

/// Cold-start quality from a rank position: 1.0 for the first, approaching 0 for the last.
pub(crate) fn quality_from_rank(rank: u32, total: Option<u64>) -> Option<f64> {
    let total = total.filter(|t| *t > 1)?;
    let r = f64::from(rank.max(1)) - 1.0;
    Some((1.0 - r / (total as f64 - 1.0)).clamp(0.0, 1.0))
}

/// Shared final step: validate, map categories (unless preset), check the blocklist, drop gendered source
/// categories from what is stored.
pub(crate) fn finalize(mut g: NewGame, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
    if g.title.is_empty() {
        return Err("empty title".into());
    }
    if g.source_id.is_empty() || g.source_id.len() > 200 || text::has_control_chars(&g.source_id) {
        return Err("invalid source id".into());
    }
    g.source_categories.retain(|c| !c.trim().is_empty());
    if g.categories.is_empty() {
        g.categories = categories::assign(CategoryInput {
            source: g.source,
            source_categories: &g.source_categories,
            tags: &g.tags,
            title: &g.title,
        });
    }
    g.categories.truncate(categories::MAX_CATEGORIES);
    if g.categories.is_empty() {
        g.categories.push(Category::Casual);
    }
    let labels: Vec<String> = g.source_categories.iter().chain(g.tags.iter()).cloned().collect();
    g.ip_risk_term = ctx.blocklist().check(&g.title, &labels).map(str::to_owned);
    // Gendered source categories are never exposed (not even in the stored keyword list).
    g.source_categories.retain(|c| !is_gendered(&normalize_token(c)));
    if let Some(q) = g.quality {
        g.quality = Some(if q.is_finite() { q.clamp(0.0, 1.0) } else { 0.5 });
    }
    // Sizes outside the schema's range are unknown, not errors: one odd record must never fail its page.
    g.width = g.width.filter(|w| (1..=MAX_FRAME_SIZE).contains(w));
    g.height = g.height.filter(|h| (1..=MAX_FRAME_SIZE).contains(h));
    Ok(g)
}

/// Orientation derived from a size (portrait when taller than wide).
pub(crate) fn orientation_from_size(w: Option<u32>, h: Option<u32>) -> Option<crate::model::Orientation> {
    match (w, h) {
        (Some(w), Some(h)) if w > 0 && h > 0 => {
            Some(if h > w { crate::model::Orientation::Portrait } else { crate::model::Orientation::Landscape })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_normalization_drops_noise_and_extracts_flags() {
        let raw = [
            "3D",
            "3D Games",
            "Action",
            "free games for your website",
            "H5",
            "Mobile",
            "2026 games",
            "Best Games",
            "Kids Friendly",
            "No Blood",
            "Girl",
            "defold-games-online",
            "zombie-games",
            ".io",
            "  ",
            "Racing",
            "racing",
        ];
        let (tags, flags) = normalize_tags(raw);
        assert_eq!(tags, ["3d", "action", "zombie", ".io", "racing"]);
        assert_eq!(flags, ["kids_friendly", "no_blood"]);
    }

    #[test]
    fn rank_quality() {
        assert_eq!(quality_from_rank(1, Some(100)), Some(1.0));
        assert_eq!(quality_from_rank(100, Some(100)), Some(0.0));
        assert_eq!(quality_from_rank(5, None), None);
    }
}
