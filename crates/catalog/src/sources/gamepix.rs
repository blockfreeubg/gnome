//! GamePix v2 JSON Feed (research §3.2).
//!
//! `GET https://feeds.gamepix.com/v2/json?sid={SID}&pagination={12|24|48|96}&page={1..}` (JSON Feed 1.1, ordered by
//! `quality` by default). Paging follows `next_url`, which is absent on the last page; `last_page_url` names the last
//! page. An unknown SID answers `400 {"message":"Bad request: sid not found"}`. No ETag is sent (checked
//! 2026-11-10), so every sync downloads the feed (155 pages of 96 at one request per second).
//!
//! Embed: `https://play.gamepix.com/<namespace>/embed?sid=<SID>`; the stored template is
//! `…/embed?sid={gamepix_sid}` so a changed SID applies without re-importing.

use serde::Deserialize;
use serde_json::value::RawValue;

use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, Orientation, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_TITLE};
use crate::url::{Url, https_on};

const FEED_HOST: &str = "feeds.gamepix.com";

/// Feed envelope (`version`, `title`, `home_page_url`, `feed_url`, `first_page_url` and `modified` are also present
/// but unused).
#[derive(Debug, Deserialize)]
pub struct GpFeed {
    #[serde(default)]
    /// Next page (absent on the last page).
    pub next_url: Option<String>,
    #[serde(default)]
    /// Last page of the feed.
    pub last_page_url: Option<String>,
    #[serde(default)]
    /// Items (raw JSON).
    pub items: Vec<Box<RawValue>>,
}

/// One feed item (field comments: values observed in the feed).
#[derive(Debug, Deserialize)]
pub struct GpItem {
    /// Stable ID, e.g. `"737HCH"` (2–6 characters).
    pub id: String,
    /// Title.
    pub title: String,
    /// Slug, e.g. `"prism-match-3d"`.
    pub namespace: String,
    /// Present for roughly half of the games.
    #[serde(default)]
    pub description: Option<String>,
    /// One GamePix namespace (148 known, e.g. `match-3`).
    #[serde(default)]
    pub category: Option<String>,
    /// `landscape` | `portrait` | `all`.
    #[serde(default)]
    pub orientation: Option<String>,
    /// 0.24..0.98 observed: GamePix's own quality/popularity signal.
    #[serde(default)]
    pub quality_score: Option<f64>,
    /// Orientation-derived (800x600 / 600x800), not the native size.
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    /// Height (orientation-derived).
    pub height: Option<u32>,
    /// RFC 1123, e.g. `"Fri, 19 Dec 2025 12:08:29 GMT"`.
    #[serde(default)]
    pub date_modified: Option<String>,
    #[serde(default)]
    /// Publication date (RFC 1123).
    pub date_published: Option<String>,
    /// `https://img.gamepix.com/games/<ns>/cover/<ns>.png?w=320` (16:10 JPEG; `w=` resizes).
    #[serde(default)]
    pub banner_image: Option<String>,
    /// `https://img.gamepix.com/games/<ns>/icon/<ns>.png?w=105` (square).
    #[serde(default)]
    pub image: Option<String>,
    /// `https://play.gamepix.com/<ns>/embed?sid=<SID>`.
    pub url: String,
}

/// The GamePix adapter.
#[derive(Debug, Clone)]
pub struct GamePix {
    sid: String,
    per_page: u32,
    category: Option<String>,
}

impl GamePix {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        let per_page = match c.gamepix.per_page {
            12 | 24 | 48 | 96 => c.gamepix.per_page,
            _ => 96,
        };
        Self { sid: c.gamepix.sid.clone(), per_page, category: c.gamepix.category.clone() }
    }

    fn page_url(&self, page: u32) -> String {
        let mut u = format!(
            "https://{FEED_HOST}/v2/json?sid={}&pagination={}&page={page}",
            crate::url::encode_component(&self.sid),
            self.per_page
        );
        if let Some(c) = &self.category {
            u.push_str("&category=");
            u.push_str(&crate::url::encode_component(c));
        }
        u
    }

    fn page_ref(&self, number: u32) -> PageRef {
        PageRef { number, feed: 0, key: format!("page:{number}"), url: self.page_url(number), body: None }
    }
}

/// Page number of a GamePix paging URL, if it is a well-formed feed URL.
fn page_of(url: &str) -> Option<u32> {
    let u = Url::parse(url)?;
    if u.host != FEED_HOST || u.scheme != "https" || !u.path.starts_with("/v2/json") {
        return None;
    }
    u.query_param("page")?.parse().ok()
}

impl Adapter for GamePix {
    fn source(&self) -> Source {
        Source::GamePix
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        self.page_ref(1)
    }

    fn request(&self, page: &PageRef) -> FetchRequest {
        FetchRequest {
            method: Method::Get,
            url: page.url.clone(),
            headers: vec![("Accept".into(), "application/feed+json, application/json".into())],
            body: None,
            max_body_bytes: 4 << 20,
            timeout: std::time::Duration::from_secs(30),
        }
    }

    fn parse(&self, page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let feed: GpFeed = serde_json::from_slice(body).map_err(|e| format!("invalid GamePix feed JSON: {e}"))?;
        let mut info = PageInfo { item_count: feed.items.len(), ..PageInfo::default() };
        let last = feed.last_page_url.as_deref().and_then(page_of);
        match feed.next_url.as_deref() {
            Some(next) => match page_of(next) {
                Some(n) if n == page.number + 1 => info.next_hint = Some(next.to_owned()),
                _ => info.truncated = Some(format!("unexpected next_url {next:?} on page {}", page.number)),
            },
            None => {
                if let Some(last) = last.filter(|l| *l > page.number) {
                    info.truncated = Some(format!("feed ended at page {} but last_page_url says {last}", page.number));
                }
            }
        }
        Ok(ParsedPage { items: feed.items.into_iter().map(|r| r.get().to_owned()).collect(), info })
    }

    fn next(&self, page: &PageRef, info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        info.next_hint.as_ref()?;
        Some(self.page_ref(page.number + 1))
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it: GpItem = serde_json::from_str(raw).map_err(|e| format!("GamePix item: {e}"))?;
        if it.id.is_empty() || it.id.len() > 32 || !it.id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(format!("GamePix id {:?}", it.id));
        }
        let mut embed = https_on(&it.url, &["play.gamepix.com"]).ok_or_else(|| format!("GamePix url {:?}", it.url))?;
        embed.set_query_param("sid", "{gamepix_sid}");
        let mut thumbnails = Vec::new();
        let banner = it.banner_image.as_deref().and_then(|u| https_on(u, &["img.gamepix.com"]));
        if let Some(b) = &banner {
            let w = b.query_param("w").and_then(|w| w.parse().ok());
            thumbnails.push(Thumbnail { url: b.as_string(), w, h: None, kind: ThumbKind::Landscape });
        }
        if let Some(i) = it.image.as_deref().and_then(|u| https_on(u, &["img.gamepix.com"])) {
            let w = i.query_param("w").and_then(|w| w.parse().ok());
            thumbnails.push(Thumbnail { url: i.as_string(), w, h: w, kind: ThumbKind::Icon });
        }
        let orientation = match it.orientation.as_deref() {
            Some("landscape") => Some(Orientation::Landscape),
            Some("portrait") => Some(Orientation::Portrait),
            Some("all") => Some(Orientation::Any),
            _ => None,
        };
        let g = NewGame {
            source: Source::GamePix,
            source_id: it.id.clone(),
            slug_hint: Some(it.namespace.clone()),
            title: text::clean_line(&it.title, MAX_TITLE),
            developer: None,
            developer_url: None,
            description: text::clean_block(it.description.as_deref().unwrap_or(""), MAX_DESCRIPTION),
            instructions: String::new(),
            thumbnail_url: banner.map(|b| b.as_string()).or_else(|| thumbnails.first().map(|t| t.url.clone())),
            thumbnails,
            embed_kind: EmbedKind::Iframe,
            embed_url: embed.as_string(),
            width: it.width,
            height: it.height,
            orientation,
            mobile: None,
            source_url: None,
            license: None,
            attribution: "via GamePix".into(),
            categories: Vec::new(),
            source_categories: it.category.iter().map(|c| text::clean_line(c, 60)).collect(),
            tags: Vec::new(),
            flags: Vec::new(),
            published_at: it.date_published.as_deref().and_then(crate::date::parse_any),
            source_updated_at: it.date_modified.as_deref().and_then(crate::date::parse_any),
            quality: it.quality_score,
            source_rank: Some(ctx.rank),
            ip_risk_term: None,
            raw: raw.to_owned(),
        };
        finalize(g, ctx)
    }
}
