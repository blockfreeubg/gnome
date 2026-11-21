//! GameDistribution catalog feed (research §3.1).
//!
//! `GET https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=all&categories=All&tags=All&subType=all
//! &type=all&mobile=all&rewarded=all&amount=100&page={1..N}&format=json` → JSON array (100 items max per page; `[]`
//! past the end). Weak ETags are sent and `If-None-Match` → `304` was verified on 2026-11-10. Every listed
//! parameter is required: unknown or duplicate parameters, and any other `collection`/`mobile` value, answer 500.
//!
//! Embed: `https://html5.gamedistribution.com/<md5>/?gd_sdk_referrer_url=<exact GNOME game page URL>`; the stored
//! template ends in `gd_sdk_referrer_url={page_url}`. The feed exposes no developer, dates or popularity.

use serde::Deserialize;

use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize, normalize_tags, orientation_from_size};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_TITLE};
use crate::url::https_on;

/// One feed item (all fields were present in every sampled item).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct GdGame {
    /// Title.
    pub title: String,
    /// 32 hex characters: the stable ID (also in `Url` and image names).
    pub md5: String,
    #[serde(default)]
    /// Description.
    pub description: String,
    #[serde(default)]
    /// How to play.
    pub instructions: String,
    /// `"html5"`.
    #[serde(rename = "Type", default)]
    pub kind: Option<String>,
    /// `"Javascript"`, `"WebGL"`, `"Construct 3"`, ...
    #[serde(default)]
    pub sub_type: Option<String>,
    /// `"true"` | `"false"` (a string).
    #[serde(default)]
    pub mobile: Option<String>,
    #[serde(default)]
    /// Always null in the samples.
    pub mobile_mode: Option<String>,
    #[serde(default)]
    /// Native height.
    pub height: Option<u32>,
    #[serde(default)]
    /// Native width.
    pub width: Option<u32>,
    #[serde(default)]
    /// Served over HTTPS.
    pub https: Option<bool>,
    /// Meaning undocumented (2 for most games).
    #[serde(default)]
    pub status: Option<i64>,
    /// `https://html5.gamedistribution.com/<md5>/`.
    pub url: String,
    /// `https://img.gamedistribution.com/<md5>-<W>x<H>.jpg`.
    #[serde(default)]
    pub asset: Vec<String>,
    /// 1–2 GameDistribution categories.
    #[serde(default)]
    pub category: Vec<String>,
    /// Free tags plus content flags (`No Blood`, `Kids Friendly`, `No Cruelty`).
    #[serde(default)]
    pub tag: Vec<String>,
}

const FEED: &str = "https://catalog.api.gamedistribution.com/api/v2.0/rss/All/?collection=all&categories=All&tags=All\
&subType=all&type=all&mobile=all&rewarded=all";

/// The GameDistribution adapter.
#[derive(Debug, Clone)]
pub struct GameDistribution {
    per_page: u32,
}

impl GameDistribution {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        Self { per_page: c.gamedistribution.per_page.clamp(1, 100) }
    }

    fn page_ref(&self, number: u32) -> PageRef {
        PageRef {
            number,
            feed: 0,
            key: format!("page:{number}:{}", self.per_page),
            url: format!("{FEED}&amount={}&page={number}&format=json", self.per_page),
            body: None,
        }
    }
}

/// `(w, h)` from an asset name like `…-512x384.jpg`.
fn asset_size(url: &str) -> Option<(u32, u32)> {
    let name = url.rsplit('/').next()?;
    let stem = name.rsplit_once('.')?.0;
    let (w, h) = stem.rsplit_once('-')?.1.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

impl Adapter for GameDistribution {
    fn source(&self) -> Source {
        Source::GameDistribution
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
            max_body_bytes: 4 << 20,
            timeout: std::time::Duration::from_secs(30),
        }
    }

    fn parse(&self, _page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let items = super::split_json_array(body)?;
        Ok(ParsedPage { info: PageInfo { item_count: items.len(), ..PageInfo::default() }, items })
    }

    fn next(&self, page: &PageRef, info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        // A short page is the last one (the next would be `[]`).
        (info.item_count >= self.per_page as usize).then(|| self.page_ref(page.number + 1))
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it: GdGame = serde_json::from_str(raw).map_err(|e| format!("GameDistribution item: {e}"))?;
        let md5 = it.md5.to_ascii_lowercase();
        if md5.len() != 32 || !md5.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("GameDistribution Md5 {:?}", it.md5));
        }
        let mut embed = https_on(&it.url, &["html5.gamedistribution.com"])
            .ok_or_else(|| format!("GameDistribution Url {:?}", it.url))?;
        if !embed.path.contains(&md5) {
            return Err(format!("GameDistribution Url {:?} does not contain the game id", it.url));
        }
        embed.set_query_param("gd_sdk_referrer_url", "{page_url}");
        let mut thumbnails: Vec<Thumbnail> = it
            .asset
            .iter()
            .filter_map(|a| https_on(a, &["img.gamedistribution.com"]))
            .map(|u| {
                let s = u.as_string();
                let (w, h) = asset_size(&s).map_or((None, None), |(w, h)| (Some(w), Some(h)));
                let kind = match (w, h) {
                    (Some(w), Some(h)) if w == h => ThumbKind::Square,
                    (Some(w), Some(h)) if w > 2 * h => ThumbKind::Wide,
                    (Some(w), _) if w <= 200 => ThumbKind::Icon,
                    _ => ThumbKind::Landscape,
                };
                Thumbnail { url: s, w, h, kind }
            })
            .collect();
        thumbnails.dedup_by(|a, b| a.url == b.url);
        let pick = |w: u32, h: u32| thumbnails.iter().find(|t| t.w == Some(w) && t.h == Some(h)).map(|t| t.url.clone());
        let thumbnail_url =
            pick(512, 384).or_else(|| pick(1280, 720)).or_else(|| thumbnails.first().map(|t| t.url.clone()));
        let (tags, flags) = normalize_tags(it.tag.iter().map(String::as_str));
        let (width, height) = (it.width.filter(|w| *w > 0), it.height.filter(|h| *h > 0));
        let g = NewGame {
            source: Source::GameDistribution,
            source_id: md5,
            slug_hint: None,
            title: text::clean_line(&it.title, MAX_TITLE),
            developer: None,
            developer_url: None,
            description: text::clean_block(&it.description, MAX_DESCRIPTION),
            instructions: text::clean_block(&it.instructions, MAX_INSTRUCTIONS),
            thumbnail_url,
            thumbnails,
            embed_kind: EmbedKind::Iframe,
            embed_url: embed.as_string(),
            width,
            height,
            orientation: orientation_from_size(width, height),
            mobile: it.mobile.as_deref().map(|m| m.eq_ignore_ascii_case("true")),
            source_url: None,
            license: None,
            attribution: "via GameDistribution".into(),
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
    use super::asset_size;

    #[test]
    fn asset_sizes() {
        assert_eq!(asset_size("https://img.gamedistribution.com/569b-512x384.jpg"), Some((512, 384)));
        assert_eq!(asset_size("https://img.gamedistribution.com/569b-1280x720.jpeg"), Some((1280, 720)));
        assert_eq!(asset_size("https://img.gamedistribution.com/569b.jpg"), None);
    }
}
