//! Playgama catalogue API (research §3.3).
//!
//! `POST https://widgets.playgama.com/api/v1/partner/export/catalogue/games` (JSON body below) → `201
//! {"games":[…],"totalCount":N}`, ordered by Playgama's `ranking_default`. `offset` is rounded down to a multiple of
//! `limit`, so pages are requested as `offset = page * limit`. This is the API the official catalogue UI calls; it
//! is undocumented, so parsing is tolerant (unknown fields ignored, odd items rejected one by one).
//!
//! Embed: `gameURL` (usually `https://playgama.com/export/game/<slug>`, a few games use the developer's own host)
//! with `clid={playgama_clid}` appended; the partner CLID is filled in at render time.

use serde::Deserialize;
use serde_json::value::RawValue;

use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize, normalize_tags, quality_from_rank};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, Orientation, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_INSTRUCTIONS, MAX_TITLE};
use crate::url::https_on;

const ENDPOINT: &str = "https://widgets.playgama.com/api/v1/partner/export/catalogue/games";

/// Response envelope.
#[derive(Debug, Deserialize)]
pub struct PgResp {
    #[serde(default)]
    /// Games (raw JSON).
    pub games: Vec<Box<RawValue>>,
    #[serde(rename = "totalCount", default)]
    /// Size of the whole catalogue.
    pub total_count: Option<u64>,
}

/// `screenOrientation`.
#[derive(Debug, Deserialize, Default)]
pub struct PgOrient {
    #[serde(default)]
    /// Playable in landscape.
    pub horizontal: bool,
    #[serde(default)]
    /// Playable in portrait.
    pub vertical: bool,
}

/// One game (all 16 keys were present in every sampled item).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgGame {
    /// Numeric string, e.g. `"97426"` — the stable ID.
    pub id: String,
    /// e.g. `"piece-of-cake-merge--bake"`.
    pub slug: String,
    /// Title.
    pub title: String,
    #[serde(default)]
    /// Description.
    pub description: String,
    #[serde(default)]
    /// How to play.
    pub how_to_play_text: String,
    /// Embed URL.
    #[serde(rename = "gameURL")]
    pub game_url: String,
    /// Source page (`https://playgama.com/game/<slug>`).
    #[serde(rename = "playgamaGameUrl", default)]
    pub playgama_game_url: Option<String>,
    #[serde(default)]
    /// Genres (mapped with the keyword rules).
    pub genres: Vec<String>,
    #[serde(default)]
    /// Tags.
    pub tags: Vec<String>,
    /// `[big_preview, icon]`.
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    /// Gameplay videos (unused).
    pub videos: Vec<serde_json::Value>,
    /// `"For Android"` | `"For IOS"` | `"For Desktop"`.
    #[serde(default)]
    pub mobile_ready: Vec<String>,
    /// Ignored (gendered targeting is never exposed).
    #[serde(default)]
    pub gender: Vec<String>,
    /// `"Yes"` | `"No"`.
    #[serde(default)]
    pub in_game_purchases: Option<String>,
    #[serde(default)]
    /// Languages, e.g. `en-US`.
    pub supported_languages: Vec<String>,
    #[serde(default)]
    /// Supported orientations.
    pub screen_orientation: Option<PgOrient>,
}

/// The Playgama adapter.
#[derive(Debug, Clone)]
pub struct Playgama {
    per_page: u32,
}

impl Playgama {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        Self { per_page: c.playgama.per_page.clamp(1, 1000) }
    }

    fn page_ref(&self, number: u32) -> PageRef {
        let offset = u64::from(number - 1) * u64::from(self.per_page);
        let body = serde_json::json!({
            "pagination": {"limit": self.per_page, "offset": offset},
            "sort": {"type": "ranking_default"},
            "filters": {"ageGroups": [], "interests": [], "platforms": [], "supportedLanguages": [], "hasInAppPurchases": false},
        });
        PageRef {
            number,
            feed: 0,
            key: format!("page:{number}:{}", self.per_page),
            url: ENDPOINT.into(),
            body: Some(body.to_string().into_bytes()),
        }
    }
}

impl Adapter for Playgama {
    fn source(&self) -> Source {
        Source::Playgama
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        self.page_ref(1)
    }

    fn request(&self, page: &PageRef) -> FetchRequest {
        FetchRequest {
            method: Method::Post,
            url: page.url.clone(),
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Content-Type".into(), "application/json".into()),
            ],
            body: page.body.clone(),
            max_body_bytes: 16 << 20,
            timeout: std::time::Duration::from_secs(60),
        }
    }

    fn parse(&self, _page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let r: PgResp = serde_json::from_slice(body).map_err(|e| format!("invalid Playgama JSON: {e}"))?;
        Ok(ParsedPage {
            info: PageInfo { item_count: r.games.len(), reported_total: r.total_count, ..PageInfo::default() },
            items: r.games.into_iter().map(|g| g.get().to_owned()).collect(),
        })
    }

    fn next(&self, page: &PageRef, info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        let seen = u64::from(page.number) * u64::from(self.per_page);
        let more = match info.reported_total {
            Some(total) => seen < total && info.item_count > 0,
            None => info.item_count >= self.per_page as usize,
        };
        more.then(|| self.page_ref(page.number + 1))
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it: PgGame = serde_json::from_str(raw).map_err(|e| format!("Playgama item: {e}"))?;
        if it.id.is_empty() || it.id.len() > 20 || !it.id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("Playgama id {:?}", it.id));
        }
        // Any HTTPS host: a few games are embedded from their developer's site.
        let mut embed = https_on(&it.game_url, &[])
            .filter(|u| u.scheme == "https")
            .ok_or_else(|| format!("Playgama gameURL {:?}", it.game_url))?;
        embed.set_query_param("clid", "{playgama_clid}");
        let mut thumbnails = Vec::new();
        for (i, img) in it.images.iter().enumerate().take(2) {
            if let Some(u) = https_on(img, &["static.playgama.com"]) {
                let kind = if i == 0 { ThumbKind::Landscape } else { ThumbKind::Icon };
                thumbnails.push(Thumbnail { url: u.as_string(), w: None, h: None, kind });
            }
        }
        let orientation = it.screen_orientation.as_ref().and_then(|o| match (o.horizontal, o.vertical) {
            (true, true) => Some(Orientation::Any),
            (true, false) => Some(Orientation::Landscape),
            (false, true) => Some(Orientation::Portrait),
            (false, false) => None,
        });
        let mobile = (!it.mobile_ready.is_empty()).then(|| {
            it.mobile_ready.iter().any(|m| m.eq_ignore_ascii_case("For Android") || m.eq_ignore_ascii_case("For IOS"))
        });
        let (tags, mut flags) = normalize_tags(it.tags.iter().map(String::as_str));
        if it.in_game_purchases.as_deref().is_some_and(|v| v.eq_ignore_ascii_case("yes")) {
            flags.push("iap".into());
        }
        let g = NewGame {
            source: Source::Playgama,
            source_id: it.id.clone(),
            slug_hint: Some(it.slug.clone()),
            title: text::clean_line(&it.title, MAX_TITLE),
            developer: None,
            developer_url: None,
            description: text::clean_block(&it.description, MAX_DESCRIPTION),
            instructions: text::clean_block(&it.how_to_play_text, MAX_INSTRUCTIONS),
            thumbnail_url: thumbnails.first().map(|t| t.url.clone()),
            thumbnails,
            embed_kind: EmbedKind::Iframe,
            embed_url: embed.as_string(),
            width: None,
            height: None,
            orientation,
            mobile,
            source_url: it
                .playgama_game_url
                .as_deref()
                .and_then(|u| https_on(u, &["playgama.com"]))
                .map(|u| u.as_string()),
            license: None,
            attribution: "via Playgama".into(),
            categories: Vec::new(),
            source_categories: it.genres.iter().map(|c| text::clean_line(c, 60)).collect(),
            tags,
            flags,
            published_at: None,
            source_updated_at: None,
            quality: quality_from_rank(ctx.rank, ctx.reported_total),
            source_rank: Some(ctx.rank),
            ip_risk_term: None,
            raw: raw.to_owned(),
        };
        finalize(g, ctx)
    }
}
