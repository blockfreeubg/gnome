//! itch.io browse RSS feeds (research §4.1) — discovery and link-out only.
//!
//! `GET https://itch.io/<browse path>.xml?page=N` (36 items per page, e.g. `games/free/platform-web`). itch.io
//! rate-limits aggressively (HTTP 429 even at one request per 25 s), so requests are spaced 30 s apart and a 429
//! backs off for 150 s or more. Game pages send `frame-ancestors 'self' https://itch.io`, so records are stored with
//! `embed_kind = link` / `playable = false`: the UI opens them in a new tab and never frames them.
//!
//! Item fields: `guid` (= game URL), `title` (decorated: `"Season Shift [Free] [Puzzle]"`), `plainTitle`,
//! `imageurl`, `price`, `currency`, `link`, `description` (CDATA with an `<img>`), `pubDate`, `createDate`,
//! `updateDate`, `platforms/{html,windows,osx,linux,android}`.

use super::rss::{RssItem, parse_items};
use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize, quality_from_rank};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_DESCRIPTION, MAX_NAME, MAX_TITLE};
use crate::url::https_on;

/// Items per itch.io RSS page.
pub const PAGE_SIZE: usize = 36;

/// Genres that appear in decorated titles.
const GENRES: &[&str] = &[
    "Action",
    "Adventure",
    "Card Game",
    "Educational",
    "Fighting",
    "Interactive Fiction",
    "Other",
    "Platformer",
    "Puzzle",
    "Racing",
    "Rhythm",
    "Role Playing",
    "Shooter",
    "Simulation",
    "Sports",
    "Strategy",
    "Survival",
    "Visual Novel",
];

/// The itch.io adapter.
#[derive(Debug, Clone)]
pub struct ItchIo {
    feeds: Vec<String>,
    max_pages: u32,
}

impl ItchIo {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        Self { feeds: c.itchio.feeds.clone(), max_pages: c.itchio.max_pages.max(1) }
    }

    fn page_ref(&self, feed: usize, number: u32) -> Option<PageRef> {
        let path = self.feeds.get(feed)?;
        Some(PageRef {
            number,
            feed,
            key: format!("{path}?page={number}"),
            url: format!("https://itch.io/{path}.xml?page={number}"),
            body: None,
        })
    }
}

impl Adapter for ItchIo {
    fn source(&self) -> Source {
        Source::ItchIo
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        self.page_ref(0, 1).unwrap_or(PageRef {
            number: 1,
            feed: 0,
            key: "games/free/platform-web?page=1".into(),
            url: "https://itch.io/games/free/platform-web.xml?page=1".into(),
            body: None,
        })
    }

    fn request(&self, page: &PageRef) -> FetchRequest {
        FetchRequest {
            method: Method::Get,
            url: page.url.clone(),
            headers: vec![("Accept".into(), "application/rss+xml, application/xml, text/xml".into())],
            body: None,
            max_body_bytes: 2 << 20,
            timeout: std::time::Duration::from_secs(30),
        }
    }

    fn parse(&self, _page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let xml = std::str::from_utf8(body).map_err(|_| "itch.io feed is not UTF-8".to_owned())?;
        let items = parse_items(xml)?;
        Ok(ParsedPage {
            info: PageInfo { item_count: items.len(), ..PageInfo::default() },
            items: items.iter().map(RssItem::to_json).collect(),
        })
    }

    fn next(&self, page: &PageRef, info: &PageInfo, _now_ms: i64) -> Option<PageRef> {
        if info.item_count >= PAGE_SIZE && page.number < self.max_pages {
            return self.page_ref(page.feed, page.number + 1);
        }
        self.page_ref(page.feed + 1, 1)
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it = RssItem::from_json(raw).ok_or("itch.io item is not an object")?;
        let link = it.get("guid").or_else(|| it.get("link")).ok_or("itch.io item without guid")?;
        let url = https_on(link, &["*.itch.io"]).ok_or_else(|| format!("itch.io link {link:?}"))?;
        let user = url.host.trim_end_matches(".itch.io").to_owned();
        let source_id = format!("{}{}", url.host, url.path.trim_end_matches('/'));
        let decorated = it.get("title").unwrap_or("");
        let title = it.get("plainTitle").map_or_else(|| strip_brackets(decorated), str::to_owned);
        let genres: Vec<String> = brackets(decorated).into_iter().filter(|b| GENRES.contains(&b.as_str())).collect();
        let description = text::clean_block(it.get("description").unwrap_or(""), MAX_DESCRIPTION);
        let image = it.get("imageurl").and_then(|u| https_on(u, &["img.itch.zone"]));
        let thumbnails: Vec<Thumbnail> = image
            .iter()
            .map(|u| Thumbnail { url: u.as_string(), w: None, h: None, kind: ThumbKind::Landscape })
            .collect();
        let mut flags = Vec::new();
        if it.get("price").is_some_and(|p| p.trim() != "$0.00" && !p.trim().is_empty()) {
            flags.push("paid".to_owned());
        }
        let developer = text::clean_line(&user, MAX_NAME);
        let g = NewGame {
            source: Source::ItchIo,
            source_id,
            slug_hint: None,
            title: text::clean_line(&title, MAX_TITLE),
            developer: (!developer.is_empty()).then(|| developer.clone()),
            developer_url: Some(format!("https://{}", url.host)),
            description,
            instructions: String::new(),
            thumbnail_url: thumbnails.first().map(|t| t.url.clone()),
            thumbnails,
            embed_kind: EmbedKind::Link,
            embed_url: url.as_string(),
            width: None,
            height: None,
            orientation: None,
            mobile: None,
            source_url: Some(url.as_string()),
            license: None,
            attribution: format!("by {developer} on itch.io"),
            categories: Vec::new(),
            source_categories: genres,
            tags: Vec::new(),
            flags,
            published_at: it.get("createDate").or_else(|| it.get("pubDate")).and_then(crate::date::parse_any),
            source_updated_at: it.get("updateDate").and_then(crate::date::parse_any),
            quality: quality_from_rank(ctx.rank, Some(u64::from(self.max_pages) * PAGE_SIZE as u64)),
            source_rank: Some(ctx.rank),
            ip_risk_term: None,
            raw: raw.to_owned(),
        };
        finalize(g, ctx)
    }
}

/// Bracketed decorations of an itch.io title: `"guesthour [Free] [Role Playing] [Windows]"` → `[Free, Role
/// Playing, Windows]`.
fn brackets(title: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = title;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else { break };
        out.push(rest[open + 1..open + close].trim().to_owned());
        rest = &rest[open + close + 1..];
    }
    out
}

fn strip_brackets(title: &str) -> String {
    title.split(" [").next().unwrap_or(title).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decorations() {
        assert_eq!(brackets("guesthour [Free] [Role Playing] [Windows]"), ["Free", "Role Playing", "Windows"]);
        assert_eq!(strip_brackets("Season Shift [Free] [Puzzle]"), "Season Shift");
        assert!(brackets("No decorations").is_empty());
    }
}
