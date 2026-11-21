//! Famobi feed (research §3.5).
//!
//! `GET https://api.famobi.com/feed` → the whole catalog in one response (~650 games, ~0.5 MB):
//! `{"categories":[…],"num_games":649,"games":[…]}`. Paging parameters have no effect.
//!
//! Embed: `https://play.famobi.com/<package_id>/<affiliate_id>`; the stored template is
//! `https://play.famobi.com/<package_id>/{famobi_affiliate}`.

use serde::Deserialize;
use serde_json::value::RawValue;

use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize};
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, Orientation, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_TITLE};
use crate::url::https_on;

/// Feed envelope.
#[derive(Debug, Deserialize)]
pub struct FaFeed {
    #[serde(default)]
    /// Number of games the feed announces.
    pub num_games: Option<u64>,
    #[serde(default)]
    /// The games (raw JSON).
    pub games: Vec<Box<RawValue>>,
}

/// One game.
#[derive(Debug, Deserialize)]
pub struct FaGame {
    /// Stable ID and slug, e.g. `"gun-spin"`.
    pub package_id: String,
    /// Title.
    pub name: String,
    /// One-line tagline.
    #[serde(default)]
    pub description: String,
    /// 320x320 JPEG.
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    /// 60 px square thumbnail.
    pub thumb_60: Option<String>,
    #[serde(default)]
    /// 120 px square thumbnail.
    pub thumb_120: Option<String>,
    #[serde(default)]
    /// 180 px square thumbnail.
    pub thumb_180: Option<String>,
    /// `https://play.famobi.com/<package_id>`.
    pub link: String,
    /// `"YYYY-MM-DD"`.
    #[serde(default)]
    pub date: Option<String>,
    /// width / height; 0 = unknown.
    #[serde(default)]
    pub aspect_ratio: Option<f64>,
    #[serde(default)]
    /// Related package ids (unused).
    pub related: Vec<serde_json::Value>,
    #[serde(default)]
    /// Famobi categories.
    pub categories: Vec<String>,
    /// `"none"` | `"portrait"` | `"landscape"` (one `"landcape"` typo seen).
    #[serde(default)]
    pub orientation: Option<String>,
    #[serde(default)]
    /// Whether the game has highscores.
    pub highscores_enabled: Option<bool>,
}

/// The Famobi adapter.
#[derive(Debug, Clone, Copy)]
pub struct Famobi;

impl Adapter for Famobi {
    fn source(&self) -> Source {
        Source::Famobi
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        PageRef { number: 1, feed: 0, key: "feed".into(), url: "https://api.famobi.com/feed".into(), body: None }
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
        let f: FaFeed = serde_json::from_slice(body).map_err(|e| format!("invalid Famobi feed JSON: {e}"))?;
        Ok(ParsedPage {
            info: PageInfo { item_count: f.games.len(), reported_total: f.num_games, ..PageInfo::default() },
            items: f.games.into_iter().map(|g| g.get().to_owned()).collect(),
        })
    }

    fn next(&self, _page: &PageRef, _info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        None
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it: FaGame = serde_json::from_str(raw).map_err(|e| format!("Famobi item: {e}"))?;
        let id = it.package_id.trim();
        if id.is_empty() || id.len() > 100 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(format!("Famobi package_id {:?}", it.package_id));
        }
        let link = https_on(&it.link, &["play.famobi.com"]).ok_or_else(|| format!("Famobi link {:?}", it.link))?;
        let embed = format!("{}/{{famobi_affiliate}}", link.as_string().trim_end_matches('/'));
        let mut thumbnails = Vec::new();
        for (url, size, kind) in [
            (&it.thumb, 320, ThumbKind::Square),
            (&it.thumb_180, 180, ThumbKind::Square),
            (&it.thumb_120, 120, ThumbKind::Icon),
            (&it.thumb_60, 60, ThumbKind::Icon),
        ] {
            if let Some(u) = url.as_deref().and_then(|u| https_on(u, &["img.cdn.famobi.com"])) {
                thumbnails.push(Thumbnail { url: u.as_string(), w: Some(size), h: Some(size), kind });
            }
        }
        let orientation = match it.orientation.as_deref() {
            Some("portrait") => Some(Orientation::Portrait),
            Some("landscape" | "landcape") => Some(Orientation::Landscape),
            Some("none") => Some(Orientation::Any),
            _ => None,
        };
        let g = NewGame {
            source: Source::Famobi,
            source_id: id.to_owned(),
            slug_hint: Some(id.to_owned()),
            title: text::clean_line(&it.name, MAX_TITLE),
            developer: None,
            developer_url: None,
            description: text::clean_block(&it.description, MAX_DESCRIPTION),
            instructions: String::new(),
            thumbnail_url: thumbnails.first().map(|t| t.url.clone()),
            thumbnails,
            embed_kind: EmbedKind::Iframe,
            embed_url: embed,
            width: None,
            height: None,
            orientation,
            // Famobi builds every game mobile-first (research mapping; not verified per game).
            mobile: Some(true),
            source_url: None,
            license: None,
            attribution: "via Famobi".into(),
            categories: Vec::new(),
            source_categories: it.categories.iter().map(|c| text::clean_line(c, 60)).collect(),
            tags: Vec::new(),
            flags: Vec::new(),
            published_at: it.date.as_deref().and_then(crate::date::parse_iso8601),
            source_updated_at: None,
            quality: None,
            source_rank: None,
            ip_risk_term: None,
            raw: raw.to_owned(),
        };
        finalize(g, ctx)
    }
}
