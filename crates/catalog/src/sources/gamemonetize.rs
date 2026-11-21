//! GameMonetize `feed.php` (research §3.4).
//!
//! `GET https://gamemonetize.com/feed.php?format=0&num={N≤1000}&page={P}` → JSON array. Cloudflare rate-limits
//! hard (error 1015 after ~4 quick requests), so requests are spaced ≥ 10 s and a 1015 page is treated like a 429.
//! The numeric `id` differs between GameMonetize endpoints; the 32-character hash in `url` is the stable ID. Titles
//! are HTML-escaped (decoded by the text cleaner, twice if needed).
//!
//! Embed: `https://html5.gamemonetize.co/<hash>/` (publisher attribution is per site via the GM dashboard).

use serde::Deserialize;

use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize, normalize_tags, orientation_from_size};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_TITLE};
use crate::url::https_on;

/// One `feed.php` item (all values are strings).
#[derive(Debug, Deserialize)]
pub struct GmGame {
    /// Endpoint-specific numeric ID — not stable across endpoints.
    #[serde(default)]
    pub id: Option<String>,
    /// Title (HTML-escaped).
    pub title: String,
    #[serde(default)]
    /// Description.
    pub description: String,
    #[serde(default)]
    /// How to play.
    pub instructions: String,
    /// `https://html5.gamemonetize.co/<32-char hash>/`.
    pub url: String,
    /// One label, e.g. `"Puzzle"`, `"Hypercasual"`.
    #[serde(default)]
    pub category: Option<String>,
    /// Comma-separated, with SEO padding.
    #[serde(default)]
    pub tags: String,
    /// `https://img.gamemonetize.com/<hash>/512x384.jpg`.
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    /// Width (a string).
    pub width: Option<String>,
    #[serde(default)]
    /// Height (a string).
    pub height: Option<String>,
}

/// The GameMonetize adapter.
#[derive(Debug, Clone)]
pub struct GameMonetize {
    per_page: u32,
}

impl GameMonetize {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        Self { per_page: c.gamemonetize.per_page.clamp(1, 1000) }
    }

    fn page_ref(&self, number: u32) -> PageRef {
        PageRef {
            number,
            feed: 0,
            key: format!("page:{number}:{}", self.per_page),
            url: format!("https://gamemonetize.com/feed.php?format=0&num={}&page={number}", self.per_page),
            body: None,
        }
    }
}

/// The 32-character game hash in an embed URL path.
fn game_hash(path: &str) -> Option<String> {
    let seg = path.trim_matches('/');
    (seg.len() == 32 && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())).then(|| seg.to_owned())
}

impl Adapter for GameMonetize {
    fn source(&self) -> Source {
        Source::GameMonetize
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        self.page_ref(1)
    }

    fn request(&self, page: &PageRef) -> FetchRequest {
        FetchRequest {
            method: Method::Get,
            url: page.url.clone(),
            headers: vec![("Accept".into(), "application/json".into())],
            body: None,
            max_body_bytes: 8 << 20,
            timeout: std::time::Duration::from_secs(60),
        }
    }

    fn parse(&self, _page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let items = super::split_json_array(body)?;
        Ok(ParsedPage { info: PageInfo { item_count: items.len(), ..PageInfo::default() }, items })
    }

    fn next(&self, page: &PageRef, info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        (info.item_count >= self.per_page as usize).then(|| self.page_ref(page.number + 1))
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it: GmGame = serde_json::from_str(raw).map_err(|e| format!("GameMonetize item: {e}"))?;
        let embed =
            https_on(&it.url, &["html5.gamemonetize.co"]).ok_or_else(|| format!("GameMonetize url {:?}", it.url))?;
        let hash = game_hash(&embed.path).ok_or_else(|| format!("GameMonetize url {:?} has no game hash", it.url))?;
        let thumb = it.thumb.as_deref().and_then(|u| https_on(u, &["img.gamemonetize.com"]));
        let thumbnails: Vec<Thumbnail> = thumb
            .iter()
            .map(|u| {
                let sized = u.path.ends_with("/512x384.jpg");
                Thumbnail {
                    url: u.as_string(),
                    w: sized.then_some(512),
                    h: sized.then_some(384),
                    kind: ThumbKind::Landscape,
                }
            })
            .collect();
        let size = |s: &Option<String>| {
            s.as_deref().and_then(|v| v.trim().parse::<u32>().ok()).filter(|v| (1..=10_000).contains(v))
        };
        let (width, height) = (size(&it.width), size(&it.height));
        let (tags, flags) = normalize_tags(it.tags.split(','));
        let g = NewGame {
            source: Source::GameMonetize,
            source_id: hash,
            slug_hint: None,
            title: text::clean_line(&it.title, MAX_TITLE),
            developer: None,
            developer_url: None,
            description: text::clean_block(&it.description, MAX_DESCRIPTION),
            instructions: text::clean_block(&it.instructions, MAX_INSTRUCTIONS),
            thumbnail_url: thumbnails.first().map(|t| t.url.clone()),
            thumbnails,
            embed_kind: EmbedKind::Iframe,
            embed_url: embed.as_string(),
            width,
            height,
            orientation: orientation_from_size(width, height),
            mobile: None,
            source_url: None,
            license: None,
            attribution: "via GameMonetize".into(),
            categories: Vec::new(),
            source_categories: it.category.iter().map(|c| text::clean_line(c, 60)).collect(),
            tags,
            flags,
            published_at: None,
            source_updated_at: None,
            quality: None,
            source_rank: None,
            ip_risk_term: None,
            raw: raw.to_owned(),
        };
        finalize(g, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::game_hash;

    #[test]
    fn hashes() {
        assert_eq!(
            game_hash("/jfquw19x7ayem6ybhl5ixivz2fkhxu31/").as_deref(),
            Some("jfquw19x7ayem6ybhl5ixivz2fkhxu31")
        );
        assert_eq!(game_hash("/short/"), None);
        assert_eq!(game_hash("/a/jfquw19x7ayem6ybhl5ixivz2fkhxu31/"), None);
    }
}
