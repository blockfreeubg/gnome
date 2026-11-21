//! js13kGames per-year RSS (research §4.2) — link-out only.
//!
//! `GET https://js13kgames.com/<year>/games.xml` for 2012..=current year (ETags are sent; only the current year
//! changes). Items: `title`, `link` = `guid` = `https://js13kgames.com/<year>/games/<slug>`, `description` (CDATA:
//! cover `<img>` + `By <author>`), `media:content@url` (cover image). Slugs are globally unique.
//!
//! `play.js13kgames.com` sends `frame-ancestors 'self' https://js13kgames.com`, so entries link out to their
//! page. Entrants keep all rights (the competition licence covers the organizer only), so nothing is re-hosted.

use super::rss::{RssItem, parse_items};
use super::{Adapter, ItemCtx, PageInfo, PageRef, ParsedPage, Reject, finalize};
use crate::config::CatalogConfig;
use crate::fetch::{FetchRequest, Method};
use crate::model::{EmbedKind, NewGame, ThumbKind, Thumbnail};
use crate::source::Source;
use crate::text::{self, MAX_NAME, MAX_TITLE};
use crate::url::https_on;

/// The js13kGames adapter.
#[derive(Debug, Clone)]
pub struct Js13k {
    first_year: i64,
}

impl Js13k {
    /// From configuration.
    pub fn new(c: &CatalogConfig) -> Self {
        Self { first_year: c.js13k.first_year }
    }

    fn page_ref(&self, year: i64) -> PageRef {
        PageRef {
            number: u32::try_from(year - self.first_year + 1).unwrap_or(1),
            feed: 0,
            key: format!("year:{year}"),
            url: format!("https://js13kgames.com/{year}/games.xml"),
            body: None,
        }
    }

    fn year(&self, page: &PageRef) -> i64 {
        self.first_year + i64::from(page.number) - 1
    }
}

impl Adapter for Js13k {
    fn source(&self) -> Source {
        Source::Js13k
    }

    fn first(&self, _now_ms: i64) -> PageRef {
        self.page_ref(self.first_year)
    }

    fn request(&self, page: &PageRef) -> FetchRequest {
        FetchRequest {
            method: Method::Get,
            url: page.url.clone(),
            headers: vec![("Accept".into(), "application/rss+xml, application/xml, text/xml".into())],
            body: None,
            max_body_bytes: 4 << 20,
            timeout: std::time::Duration::from_secs(30),
        }
    }

    fn parse(&self, _page: &PageRef, body: &[u8]) -> Result<ParsedPage, String> {
        let xml = std::str::from_utf8(body).map_err(|_| "js13k feed is not UTF-8".to_owned())?;
        let items = parse_items(xml)?;
        Ok(ParsedPage {
            info: PageInfo { item_count: items.len(), ..PageInfo::default() },
            items: items.iter().map(RssItem::to_json).collect(),
        })
    }

    fn next(&self, page: &PageRef, _info: &PageInfo, now_ms: i64) -> Option<PageRef> {
        let year = self.year(page);
        (year < crate::date::year_of(now_ms)).then(|| self.page_ref(year + 1))
    }

    fn is_end_status(&self, page: &PageRef, status: u16) -> bool {
        // The current year's feed does not exist before the competition starts (August).
        status == 404 && page.number > 1
    }

    fn normalize(&self, raw: &str, ctx: &ItemCtx<'_>) -> Result<NewGame, Reject> {
        let it = RssItem::from_json(raw).ok_or("js13k item is not an object")?;
        let link = it.get("link").or_else(|| it.get("guid")).ok_or("js13k item without link")?;
        let url = https_on(link, &["js13kgames.com"]).ok_or_else(|| format!("js13k link {link:?}"))?;
        // /<year>/games/<slug>
        let segs: Vec<&str> = url.path.trim_matches('/').split('/').collect();
        let (year, slug) = match segs.as_slice() {
            [y, "games", s] if y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()) => (*y, *s),
            _ => return Err(format!("js13k link {link:?} is not /<year>/games/<slug>")),
        };
        if slug.is_empty() || !slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(format!("js13k slug {slug:?}"));
        }
        let desc = text::clean_line(it.get("description").unwrap_or(""), 300);
        let author = desc.strip_prefix("By ").map(|a| text::clean_line(a, MAX_NAME)).filter(|a| !a.is_empty());
        let cover = it
            .get("content@url")
            .or_else(|| it.get("description").and_then(img_src))
            .and_then(|u| https_on(u, &["play.js13kgames.com"]));
        let thumbnails: Vec<Thumbnail> = cover
            .iter()
            .map(|u| Thumbnail { url: u.as_string(), w: None, h: None, kind: ThumbKind::Landscape })
            .collect();
        let attribution = match &author {
            Some(a) => format!("by {a} · js13kGames {year}"),
            None => format!("js13kGames {year}"),
        };
        let g = NewGame {
            source: Source::Js13k,
            source_id: slug.to_owned(),
            slug_hint: Some(slug.to_owned()),
            title: text::clean_line(it.get("title").unwrap_or(""), MAX_TITLE),
            developer: author,
            developer_url: None,
            description: String::new(),
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
            attribution,
            categories: Vec::new(),
            source_categories: Vec::new(),
            tags: vec![format!("js13k-{year}")],
            flags: Vec::new(),
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

/// `src` of the first `<img>` in an HTML fragment.
fn img_src(html: &str) -> Option<&str> {
    let i = html.find("<img")?;
    let rest = &html[i..];
    let s = rest.find("src=\"")? + 5;
    let e = rest[s..].find('"')?;
    Some(&rest[s..s + e])
}
