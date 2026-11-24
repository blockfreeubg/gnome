//! Read side: every function takes `&rusqlite::Connection` and only reads, so gnome-server can run them on its
//! read-only pool (`PRAGMA query_only`). Shapes map 1:1 onto `docs/API.md` (`GameSummary`, `GameDetail`, ...), with
//! a few additive fields the UI needs (`playable`, `embed_kind`, `orientation`, `flags`).

use std::collections::{BTreeMap, HashMap};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::Catalog;
use crate::categories::Category;
use crate::cursor::{Cursor, CursorKey, KeyKind};
use crate::error::{CatalogError, Result};
use crate::source::Source;
use crate::url::encode_component;

/// Default page size of [`Catalog::list`].
pub const DEFAULT_LIMIT: u32 = 48;
/// Maximum page size.
pub const MAX_LIMIT: u32 = 100;
/// Maximum ids accepted by [`Catalog::by_ids`].
pub const MAX_BY_IDS: usize = 200;
/// Maximum items per section.
pub const MAX_SECTION: usize = 24;
/// Maximum search query length (characters).
pub const MAX_QUERY_CHARS: usize = 100;

/// bm25 column weights: title, developer, keywords, description.
const BM25: &str = "bm25(games_fts, 10.0, 3.0, 4.0, 1.0)";
/// How much popularity breaks relevance ties (bm25 is negative: lower is better).
const RELEVANCE_POP_WEIGHT: f64 = 0.25;
/// Offset that puts games whose *title* matches every search word ahead of all other matches. bm25 saturates term
/// frequency, so column weights alone let a game that repeats the word in its keywords and description outrank a
/// title match; bm25 values stay far inside ±1000, so this tier is strict.
const TITLE_TIER: f64 = 1000.0;

/// Sort order of [`Catalog::list`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Sort {
    /// Full-text relevance (requires `q`).
    Relevance,
    /// Popularity (decayed plays + source quality).
    Popular,
    /// Recent plays + freshness.
    Trending,
    /// Newest first.
    New,
    /// Admin picks first, then popularity.
    Featured,
    /// Alphabetical.
    Az,
}

impl Sort {
    /// Parse an API value.
    pub fn parse(s: &str) -> Option<Sort> {
        Some(match s {
            "relevance" => Sort::Relevance,
            "popular" => Sort::Popular,
            "trending" => Sort::Trending,
            "new" => Sort::New,
            "featured" => Sort::Featured,
            "az" => Sort::Az,
            _ => return None,
        })
    }

    fn code(self) -> u8 {
        self as u8 + 1
    }

    fn kind(self) -> KeyKind {
        match self {
            Sort::Relevance | Sort::Popular | Sort::Trending => KeyKind::Score,
            Sort::New => KeyKind::Int,
            Sort::Featured => KeyKind::Featured,
            Sort::Az => KeyKind::Text,
        }
    }
}

/// Parameters of `GET /api/games`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListQuery {
    /// Full-text query (title weighted over keywords and description; the last word is a prefix).
    pub q: Option<String>,
    /// Category slug.
    pub category: Option<String>,
    /// Tag.
    pub tag: Option<String>,
    /// Default: `relevance` with `q`, else `popular`.
    pub sort: Option<Sort>,
    /// Only games known to work on mobile.
    pub mobile: bool,
    /// Also return link-out-only games (itch.io, js13kGames).
    pub include_link_out: bool,
    /// Category slugs to leave out (a game with any of them in any position is excluded). At most
    /// [`MAX_EXCLUDE`] given; slugs that are not known categories are ignored (they match no game).
    pub exclude: Vec<String>,
    /// Opaque cursor from the previous page.
    pub cursor: Option<String>,
    /// 1..=100, default 48.
    pub limit: Option<u32>,
}

/// At most this many category slugs can be excluded (`ListQuery::exclude`, `ListFilter::exclude`).
pub const MAX_EXCLUDE: usize = 20;

/// Filters of `sections` and of the related games of `game` (the listing has them in [`ListQuery`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListFilter {
    /// Only games known to work on mobile.
    pub mobile: bool,
    /// Category slugs to leave out (see [`ListQuery::exclude`]).
    pub exclude: Vec<String>,
}

/// The known categories among `exclude` (sorted, deduplicated); more than [`MAX_EXCLUDE`] given is an error.
fn known_exclusions(exclude: &[String]) -> Result<Vec<&'static str>> {
    if exclude.len() > MAX_EXCLUDE {
        return Err(CatalogError::InvalidInput(format!("at most {MAX_EXCLUDE} categories can be excluded")));
    }
    let mut known: Vec<&'static str> =
        exclude.iter().filter_map(|c| Category::from_slug(c.trim())).map(Category::slug).collect();
    known.sort_unstable();
    known.dedup();
    Ok(known)
}

/// `g.id NOT IN (…)` for the known exclusions. The slugs come from the fixed category table (never from the caller),
/// so they are written into the SQL text; empty → `None`.
fn exclusion_sql(known: &[&'static str]) -> Option<String> {
    if known.is_empty() {
        return None;
    }
    let list = known.iter().map(|c| format!("'{c}'")).collect::<Vec<_>>().join(",");
    Some(format!("g.id NOT IN (SELECT game_id FROM game_categories WHERE category IN ({list}))"))
}

/// The SQL conditions of a [`ListFilter`] (each prefixed with ` AND `).
fn filter_sql(filter: &ListFilter) -> Result<String> {
    let mut out = String::new();
    if filter.mobile {
        out.push_str(" AND g.mobile = 1");
    }
    if let Some(ex) = exclusion_sql(&known_exclusions(&filter.exclude)?) {
        out.push_str(" AND ");
        out.push_str(&ex);
    }
    Ok(out)
}

/// `GameSummary`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GameSummary {
    /// Game id.
    pub id: i64,
    /// URL slug.
    pub slug: String,
    /// Title.
    pub title: String,
    /// Developer, when known.
    pub developer: Option<String>,
    /// `/api/thumb/<id>` with the thumbnail proxy on, else the source URL (self-hosted: proxy-origin URL).
    pub thumbnail: Option<String>,
    /// GNOME category slugs, primary first.
    pub categories: Vec<String>,
    /// Known to work on mobile.
    pub mobile: bool,
    /// Source of the listing.
    pub source: Source,
    /// When GNOME first saw the game (Unix ms).
    pub added_at: i64,
    /// All-time anonymous play count.
    pub plays: i64,
    /// `false` = link-out only: open `source_url` in a new tab, never in an iframe.
    pub playable: bool,
}

/// `GameDetail` (`GameSummary` fields flattened in).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GameDetail {
    #[serde(flatten)]
    /// The summary fields.
    pub summary: GameSummary,
    /// Description.
    pub description: String,
    /// How to play.
    pub instructions: String,
    /// Tags.
    pub tags: Vec<String>,
    /// Ready-to-use URL: publisher IDs and the page URL filled in; self-hosted builds on the proxy origin;
    /// the source page for link-out games.
    pub embed_url: String,
    /// Preferred frame width.
    pub width: Option<u32>,
    /// Preferred frame height.
    pub height: Option<u32>,
    /// Page at the source (attribution / link-out target).
    pub source_url: Option<String>,
    /// Developer page.
    pub developer_url: Option<String>,
    /// SPDX licence (self-hosted open-source games).
    pub license: Option<String>,
    /// Publication time at the source (Unix ms).
    pub published_at: Option<i64>,
    /// Attribution line to show next to the game.
    pub attribution: String,
    /// `iframe` | `selfhost` | `link`.
    pub embed_kind: String,
    /// `landscape` / `portrait` / `any`.
    pub orientation: Option<String>,
    /// `kids_friendly`, `no_blood`, `no_cruelty`, `iap`, `paid`.
    pub flags: Vec<String>,
}

/// `GET /api/games/:slug`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GamePage {
    /// The game.
    pub game: GameDetail,
    /// Related games.
    pub related: Vec<GameSummary>,
}

/// One page of `GET /api/games`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListPage {
    /// The page.
    pub items: Vec<GameSummary>,
    /// Cursor of the next page (`None` at the end).
    pub next_cursor: Option<String>,
    /// Number of matching games.
    pub total: u64,
}

/// `GET /api/games/sections`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sections {
    /// Admin picks, topped up by source quality.
    pub featured: Vec<GameSummary>,
    /// Trending games.
    pub trending: Vec<GameSummary>,
    /// Most popular games.
    pub popular: Vec<GameSummary>,
    /// Newest games.
    pub new: Vec<GameSummary>,
}

/// One entry of `GET /api/games/categories`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryCount {
    /// Category slug.
    pub slug: String,
    /// Display name.
    pub name: String,
    /// Listed games in the category.
    pub count: u64,
}

/// One entry of `GET /api/games/tags`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagCount {
    /// Tag.
    pub tag: String,
    /// Listed games with the tag.
    pub count: u64,
}

/// One import run (`GET /admin/catalog/imports`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportRun {
    /// Run id.
    pub id: i64,
    /// Source id.
    pub source: String,
    /// Start (Unix ms).
    pub started_at: i64,
    /// End (Unix ms); `None` while running.
    pub finished_at: Option<i64>,
    /// `running`, `complete`, `incomplete`, `failed` or `interrupted`.
    pub status: String,
    /// Counted for hiding missing games.
    pub complete: bool,
    /// Run with an item or page limit.
    pub limited: bool,
    /// Pages stored.
    pub pages: i64,
    /// Pages answered 304.
    pub not_modified: i64,
    /// HTTP requests.
    pub requests: i64,
    /// Retried requests.
    pub retries: i64,
    /// Distinct games listed by the source.
    pub seen: i64,
    /// New games.
    pub inserted: i64,
    /// Changed games.
    pub updated: i64,
    /// Unchanged games.
    pub unchanged: i64,
    /// Invalid records.
    pub rejected: i64,
    /// Games that reached the missing threshold.
    pub hidden: i64,
    /// Total announced by the source.
    pub reported_total: Option<i64>,
    /// Fatal error.
    pub error: Option<String>,
    /// Why the run is incomplete, or an informational note.
    pub note: Option<String>,
}

/// Per-source counts for `/admin/diagnostics`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SourceStats {
    /// Whether the source is enabled.
    pub enabled: bool,
    /// Stored listings.
    pub total: i64,
    /// Listed (visible) games.
    pub listed: i64,
    /// Status `active`.
    pub active: i64,
    /// Hidden (missing from the feed, or by an admin).
    pub hidden: i64,
    /// Marked broken by an admin.
    pub broken: i64,
    /// Blocklist matches.
    pub ip_risk: i64,
    /// Active rows that are fallbacks of a preferred listing from another source.
    pub duplicates: i64,
    /// Last run of the source.
    pub last_import: Option<ImportRun>,
}

/// The `"catalog"` object of `GET /admin/diagnostics`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogStats {
    /// All stored listings.
    pub games: i64,
    /// Listed (visible in the catalog).
    pub listed: i64,
    /// Counts per source.
    pub by_source: BTreeMap<String, SourceStats>,
    /// Most recent finished import of any source.
    pub last_import: Option<ImportRun>,
    /// Last ranking refresh (Unix ms).
    pub rankings_refreshed_at: Option<i64>,
}

/// Candidates taken from each category by [`Catalog::related`].
const RELATED_PER_CATEGORY: i64 = 100;

/// Whether a filter matching `members` of the `listed` games should be tested row by row while walking the sort
/// index in order (`+g.id IN (…)`), instead of driving the query from its member list (fetch every member, sort
/// them). Walking visits about `need × listed / members` index entries to fill `need` rows (all `listed` of them
/// when the filter has fewer than `need` members); driving costs about `members` row lookups plus a sort. Measured
/// on the live 14.7k-game catalog, an index step costs about a sixth of a member lookup, so walking wins when
/// `6 × members² ≥ need × listed` (≈ 350 members for a 49-row page there; the threshold grows with the catalog).
fn walk_sort_index(members: i64, need: i64, listed: i64) -> bool {
    members > 0 && 6 * (members as i128) * (members as i128) >= (need as i128) * (listed as i128)
}

const SUMMARY_COLS: &str = "g.id, g.slug, g.title, g.developer, g.thumbnail_url, g.categories, g.mobile, g.source, g.added_at, g.plays, g.playable";

struct RawSummary {
    id: i64,
    slug: String,
    title: String,
    developer: Option<String>,
    thumbnail_url: Option<String>,
    categories: String,
    mobile: Option<bool>,
    source: String,
    added_at: i64,
    plays: i64,
    playable: bool,
}

fn raw_summary(r: &Row<'_>) -> rusqlite::Result<RawSummary> {
    Ok(RawSummary {
        id: r.get(0)?,
        slug: r.get(1)?,
        title: r.get(2)?,
        developer: r.get(3)?,
        thumbnail_url: r.get(4)?,
        categories: r.get(5)?,
        mobile: r.get(6)?,
        source: r.get(7)?,
        added_at: r.get(8)?,
        plays: r.get(9)?,
        playable: r.get(10)?,
    })
}

/// Minimum length of the last word for a prefix (type-ahead) match: shorter prefixes match too much to rank
/// usefully (a 2-letter prefix matches ~1 in 6 games of the live GamePix catalog).
pub const MIN_PREFIX_CHARS: usize = 3;

/// Build a full-text query: words of the input (letters/digits), quoted; the last word is a prefix match (when it
/// has at least [`MIN_PREFIX_CHARS`] characters) unless the input ends with a space. `None` when the input has no
/// words.
pub fn fts_query(q: &str) -> Option<String> {
    let words: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(8)
        .map(|w| w.chars().take(40).collect::<String>().to_lowercase())
        .collect();
    let last = words.len().checked_sub(1)?;
    let prefix_last = !q.ends_with(char::is_whitespace) && words[last].chars().count() >= MIN_PREFIX_CHARS;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| if i == last && prefix_last { format!("\"{w}\"*") } else { format!("\"{w}\"") })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Normalize a tag filter value the way tags are stored.
fn normalize_tag_filter(t: &str) -> Option<String> {
    let (tags, _) = crate::sources::normalize_tags([t]);
    tags.into_iter().next()
}

fn fingerprint(parts: &[&str]) -> [u8; 8] {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u32).to_le_bytes());
        h.update(p.as_bytes());
    }
    h.finalize()[..8].try_into().expect("8 bytes")
}

fn facet_column(mobile: bool, include_link_out: bool) -> &'static str {
    match (mobile, include_link_out) {
        (false, true) => "count_all",
        (false, false) => "count_playable",
        (true, true) => "count_mobile_all",
        (true, false) => "count_mobile_playable",
    }
}

impl Catalog {
    /// Precomputed number of listed games for `kind` (`all` / `category` / `tag`) and `value`.
    fn facet_count(&self, conn: &Connection, kind: &str, value: &str, mobile: bool, link_out: bool) -> Result<i64> {
        let col = facet_column(mobile, link_out);
        Ok(conn
            .prepare_cached(&format!("SELECT {col} FROM catalog_facets WHERE kind = ?1 AND value = ?2"))?
            .query_row(params![kind, value], |r| r.get(0))
            .optional()?
            .unwrap_or(0))
    }

    fn render_summary(&self, r: RawSummary) -> GameSummary {
        let source = Source::from_id(&r.source).unwrap_or(Source::Oss);
        GameSummary {
            thumbnail: self.render_thumbnail(r.id, r.thumbnail_url),
            categories: serde_json::from_str(&r.categories).unwrap_or_default(),
            mobile: r.mobile.unwrap_or(false),
            id: r.id,
            slug: r.slug,
            title: r.title,
            developer: r.developer,
            source,
            added_at: r.added_at,
            plays: r.plays,
            playable: r.playable,
        }
    }

    fn render_thumbnail(&self, id: i64, url: Option<String>) -> Option<String> {
        let url = url?;
        if url.starts_with('/') {
            return Some(format!("{}{url}", self.render.proxy_origin.trim_end_matches('/')));
        }
        Some(if self.render.thumb_proxy { format!("/api/thumb/{id}") } else { url })
    }

    /// Fill an embed URL template for display.
    fn render_embed(&self, template: &str, slug: &str) -> String {
        if template.starts_with('/') {
            return format!("{}{template}", self.render.proxy_origin.trim_end_matches('/'));
        }
        // The page the visitor sees (the player route of the app, WAVE-C D2).
        let page_url = format!("{}/play/{slug}", self.render.app_origin.trim_end_matches('/'));
        let c = &self.config;
        let mut out = template.replace("{gamepix_sid}", &encode_component(&c.gamepix.sid));
        out = out.replace("{page_url}", &encode_component(&page_url));
        out = match &c.playgama.clid {
            Some(id) => out.replace("{playgama_clid}", &encode_component(id)),
            None => out.replace("&clid={playgama_clid}", "").replace("?clid={playgama_clid}", ""),
        };
        out = match &c.famobi.affiliate_id {
            Some(id) => out.replace("{famobi_affiliate}", &encode_component(id)),
            // Famobi invites plain links to play.famobi.com/<id> without an affiliate id.
            None => out.replace("/{famobi_affiliate}", ""),
        };
        out
    }

    fn summaries(&self, conn: &Connection, sql: &str, args: &[Value]) -> Result<Vec<GameSummary>> {
        let mut stmt = conn.prepare_cached(sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), raw_summary)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(|r| self.render_summary(r)).collect())
    }

    /// `GET /api/games`: filtered, sorted, keyset-paginated listing with the total number of matches.
    pub fn list(&self, conn: &Connection, q: &ListQuery) -> Result<ListPage> {
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT);
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(CatalogError::InvalidInput(format!("limit must be 1-{MAX_LIMIT}")));
        }
        let excluded = known_exclusions(&q.exclude)?;
        let text = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if text.is_some_and(|t| t.chars().count() > MAX_QUERY_CHARS) {
            return Err(CatalogError::InvalidInput(format!("q is limited to {MAX_QUERY_CHARS} characters")));
        }
        let fts = q.q.as_deref().and_then(fts_query);
        if text.is_some() && fts.is_none() {
            // Only punctuation: nothing can match.
            return Ok(ListPage { items: Vec::new(), next_cursor: None, total: 0 });
        }
        let mut sort = q.sort.unwrap_or(if fts.is_some() { Sort::Relevance } else { Sort::Popular });
        if sort == Sort::Relevance && fts.is_none() {
            sort = Sort::Popular;
        }
        let category = match q.category.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => Some(
                Category::from_slug(c).ok_or_else(|| CatalogError::InvalidInput(format!("unknown category: {c}")))?,
            ),
            None => None,
        };
        let tag = match q.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => {
                Some(normalize_tag_filter(t).ok_or_else(|| CatalogError::InvalidInput(format!("invalid tag: {t}")))?)
            }
            None => None,
        };
        let fp = fingerprint(&[
            fts.as_deref().unwrap_or(""),
            category.map_or("", Category::slug),
            tag.as_deref().unwrap_or(""),
            if q.mobile { "m" } else { "" },
            if q.include_link_out { "l" } else { "" },
            &excluded.join(","),
        ]);
        let cursor = match q.cursor.as_deref().filter(|c| !c.is_empty()) {
            Some(c) => Some(Cursor::decode(c, &self.cursor, sort.code(), fp, sort.kind()).map_err(|e| {
                CatalogError::InvalidInput(
                    if e.starts_with("cursor belongs to") {
                        "cursor does not belong to this query"
                    } else {
                        "invalid cursor"
                    }
                    .into(),
                )
            })?),
            None => None,
        };

        let fetch = i64::from(limit) + 1;
        let listed = self.facet_count(conn, "all", "", q.mobile, q.include_link_out)?;
        let mut conds = vec!["g.listed = 1".to_owned()];
        let mut args: Vec<Value> = Vec::new();
        if !q.include_link_out {
            conds.push("g.playable = 1".into());
        }
        if q.mobile {
            conds.push("g.mobile = 1".into());
        }
        // Exclusions keep every other filter's plan: they are tested per candidate row (`game_categories` primary
        // key), and their totals are counted below (no facet row exists for them).
        conds.extend(exclusion_sql(&excluded));
        // Filters that match a large share of the catalog are tested while walking the sort index in order
        // (`+g.id` keeps their IN list from driving the loop), so a page costs the same at any depth; selective
        // ones drive the query from their member list (see `walk_sort_index`).
        let walk = |kind: &str, value: &str| -> Result<bool> {
            Ok(walk_sort_index(self.facet_count(conn, kind, value, q.mobile, q.include_link_out)?, fetch, listed))
        };
        let mut filters: Vec<(bool, &'static str, Value)> = Vec::new();
        if let Some(c) = category {
            filters.push((
                walk("category", c.slug())?,
                "IN (SELECT game_id FROM game_categories WHERE category = ?)",
                Value::Text(c.slug().into()),
            ));
        }
        if let Some(t) = &tag {
            filters.push((walk("tag", t)?, "IN (SELECT game_id FROM game_tags WHERE tag = ?)", Value::Text(t.clone())));
        }
        let filter_args: Vec<Value> = filters.iter().map(|f| f.2.clone()).collect();
        // Totals of unfiltered, category-only and tag-only listings come from the facet counts. Other totals are
        // counted through the narrow `games_listed_search` index (no row reads), driven by the most selective
        // list (no `+`): the full-text matches when there is a query.
        let total: i64 = match (&fts, category, &tag, excluded.is_empty()) {
            (None, None, None, true) => listed,
            (None, Some(c), None, true) => {
                self.facet_count(conn, "category", c.slug(), q.mobile, q.include_link_out)?
            }
            (None, None, Some(t), true) => self.facet_count(conn, "tag", t, q.mobile, q.include_link_out)?,
            _ => {
                let mut count_conds = conds.clone();
                count_conds.extend(filters.iter().map(|f| format!("g.id {}", f.1)));
                let mut count_args = filter_args.clone();
                let sql = match &fts {
                    Some(m) => {
                        count_args.insert(0, Value::Text(m.clone()));
                        format!(
                            "SELECT count(*) FROM games_fts JOIN games g INDEXED BY games_listed_search
                                 ON g.id = games_fts.rowid
                             WHERE games_fts MATCH ? AND {}",
                            count_conds.join(" AND ")
                        )
                    }
                    None => format!(
                        "SELECT count(*) FROM games g INDEXED BY games_listed_search WHERE {}",
                        count_conds.join(" AND ")
                    ),
                };
                conn.prepare_cached(&sql)?.query_row(params_from_iter(count_args.iter()), |r| r.get(0))?
            }
        };
        if total == 0 {
            // Nothing matches (e.g. a mobile filter on a catalog without mobile flags): skip the page scan.
            return Ok(ListPage { items: Vec::new(), next_cursor: None, total: 0 });
        }
        for (walk, sql, value) in &filters {
            conds.push(format!("{}g.id {sql}", if *walk { "+" } else { "" }));
            args.push(value.clone());
        }
        if let Some(m) = &fts {
            // Broad searches (a common word, a 3-letter type-ahead prefix) match much of the catalog: walk the sort
            // index and test the matches; narrow ones drive the query from the match list.
            let plus = if walk_sort_index(total, fetch, listed) { "+" } else { "" };
            conds.push(format!("{plus}g.id IN (SELECT rowid FROM games_fts WHERE games_fts MATCH ?)"));
            args.push(Value::Text(m.clone()));
        }
        let where_sql = conds.join(" AND ");
        let (sql, page_args, key_index) = if sort == Sort::Relevance {
            // Relevance needs the bm25 value, so the FTS table drives the query.
            let mut inner_conds: Vec<String> = conds.iter().filter(|c| !c.contains("games_fts")).cloned().collect();
            inner_conds.push("games_fts MATCH ?".into());
            let m = fts.clone().unwrap_or_default();
            // Placeholders in SQL text order: the title-tier subquery (select list), filters, MATCH, cursor, limit.
            let mut a = vec![Value::Text(format!("title : ({m})"))];
            a.extend(filter_args);
            a.push(Value::Text(m));
            let mut outer = String::new();
            if let Some(c) = &cursor {
                let CursorKey::Score(r) = c.key else { unreachable!("relevance cursors carry a score") };
                outer = " WHERE (r, id) > (?, ?)".into();
                a.push(Value::Real(r));
                a.push(Value::Integer(c.id));
            }
            a.push(Value::Integer(fetch));
            let cols = "g.id AS id, g.slug, g.title, g.developer, g.thumbnail_url, g.categories, g.mobile, g.source, \
                        g.added_at, g.plays, g.playable";
            let sql = format!(
                "SELECT * FROM (SELECT {cols},
                                       ({BM25} - {RELEVANCE_POP_WEIGHT} * g.pop_score
                                        - {TITLE_TIER} * (g.id IN (SELECT rowid FROM games_fts WHERE games_fts MATCH ?))) AS r
                                FROM games_fts JOIN games g ON g.id = games_fts.rowid
                                WHERE {}){outer}
                 ORDER BY r, id LIMIT ?",
                inner_conds.join(" AND ")
            );
            (sql, a, 11)
        } else {
            let (key_cols, order, cmp) = match sort {
                Sort::Popular => ("g.pop_score", "g.pop_score DESC, g.id DESC", "(g.pop_score, g.id) < (?, ?)"),
                Sort::Trending => ("g.trend_score", "g.trend_score DESC, g.id DESC", "(g.trend_score, g.id) < (?, ?)"),
                Sort::New => ("g.new_key", "g.new_key DESC, g.id DESC", "(g.new_key, g.id) < (?, ?)"),
                Sort::Az => ("g.title_sort", "g.title_sort ASC, g.id ASC", "(g.title_sort, g.id) > (?, ?)"),
                Sort::Featured => (
                    "g.featured, g.pop_score",
                    "g.featured DESC, g.pop_score DESC, g.id DESC",
                    "(g.featured, g.pop_score, g.id) < (?, ?, ?)",
                ),
                Sort::Relevance => unreachable!(),
            };
            let mut a = args;
            let mut w = where_sql;
            if let Some(c) = &cursor {
                w.push_str(" AND ");
                w.push_str(cmp);
                match &c.key {
                    CursorKey::Score(s) => a.push(Value::Real(*s)),
                    CursorKey::Int(i) => a.push(Value::Integer(*i)),
                    CursorKey::Text(t) => a.push(Value::Text(t.clone())),
                    CursorKey::Featured(f, s) => {
                        a.push(Value::Integer(i64::from(*f)));
                        a.push(Value::Real(*s));
                    }
                }
                a.push(Value::Integer(c.id));
            }
            a.push(Value::Integer(fetch));
            (format!("SELECT {SUMMARY_COLS}, {key_cols} FROM games g WHERE {w} ORDER BY {order} LIMIT ?"), a, 11)
        };

        let mut stmt = conn.prepare_cached(&sql)?;
        let mut rows = stmt.query(params_from_iter(page_args.iter()))?;
        let mut items: Vec<(RawSummary, CursorKey)> = Vec::new();
        while let Some(r) = rows.next()? {
            let key = match sort {
                Sort::Popular | Sort::Trending | Sort::Relevance => CursorKey::Score(r.get(key_index)?),
                Sort::New => CursorKey::Int(r.get(key_index)?),
                Sort::Az => CursorKey::Text(r.get(key_index)?),
                Sort::Featured => CursorKey::Featured(r.get(key_index)?, r.get(key_index + 1)?),
            };
            items.push((raw_summary(r)?, key));
        }
        let next_cursor = if items.len() > limit as usize {
            items.truncate(limit as usize);
            items.last().map(|(s, k)| {
                Cursor { sort: sort.code(), fingerprint: fp, key: k.clone(), id: s.id }.encode(&self.cursor)
            })
        } else {
            None
        };
        Ok(ListPage {
            items: items.into_iter().map(|(s, _)| self.render_summary(s)).collect(),
            next_cursor,
            total: u64::try_from(total).unwrap_or(0),
        })
    }

    /// `GET /api/games/sections` (each section ≤ `limit`, max 24; playable games only).
    ///
    /// `featured` lists the admin's picks (newest pick first) and is topped up with the games that have the
    /// highest source quality score, so the section is never empty on a fresh install.
    pub fn sections(&self, conn: &Connection, limit: usize, filter: &ListFilter) -> Result<Sections> {
        let n = Value::Integer(limit.clamp(1, MAX_SECTION) as i64);
        let base = format!("FROM games g WHERE g.listed = 1 AND g.playable = 1{}", filter_sql(filter)?);
        let mut featured = self.summaries(
            conn,
            &format!("SELECT {SUMMARY_COLS} {base} AND g.featured = 1 ORDER BY g.featured_at DESC, g.id DESC LIMIT ?"),
            std::slice::from_ref(&n),
        )?;
        if featured.len() < limit.min(MAX_SECTION) {
            let rest = Value::Integer((limit.min(MAX_SECTION) - featured.len()) as i64);
            featured.extend(self.summaries(
                conn,
                &format!("SELECT {SUMMARY_COLS} {base} AND +g.featured = 0 ORDER BY g.quality DESC, g.id DESC LIMIT ?"),
                &[rest],
            )?);
        }
        Ok(Sections {
            featured,
            trending: self.summaries(
                conn,
                &format!("SELECT {SUMMARY_COLS} {base} ORDER BY g.trend_score DESC, g.id DESC LIMIT ?"),
                std::slice::from_ref(&n),
            )?,
            popular: self.summaries(
                conn,
                &format!("SELECT {SUMMARY_COLS} {base} ORDER BY g.pop_score DESC, g.id DESC LIMIT ?"),
                std::slice::from_ref(&n),
            )?,
            new: self.summaries(
                conn,
                &format!("SELECT {SUMMARY_COLS} {base} AND g.new_key > 0 ORDER BY g.new_key DESC, g.id DESC LIMIT ?"),
                &[n],
            )?,
        })
    }

    /// `GET /api/games/categories`: the 14 core categories always (count may be 0), optional ones when used.
    pub fn categories(&self, conn: &Connection, include_link_out: bool) -> Result<Vec<CategoryCount>> {
        let col = if include_link_out { "count_all" } else { "count_playable" };
        let mut stmt =
            conn.prepare_cached(&format!("SELECT value, {col} FROM catalog_facets WHERE kind = 'category'"))?;
        let counts: HashMap<String, i64> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        Ok(Category::all()
            .filter_map(|c| {
                let count = counts.get(c.slug()).copied().unwrap_or(0);
                (c.is_core() || count > 0).then(|| CategoryCount {
                    slug: c.slug().into(),
                    name: c.name().into(),
                    count: u64::try_from(count).unwrap_or(0),
                })
            })
            .collect())
    }

    /// `GET /api/games/tags?prefix=&limit=`: most used tags (optionally starting with `prefix`).
    pub fn tags(&self, conn: &Connection, prefix: &str, limit: usize, include_link_out: bool) -> Result<Vec<TagCount>> {
        let col = if include_link_out { "count_all" } else { "count_playable" };
        let prefix = crate::slug::fold(prefix.trim()).replace(char::is_whitespace, "-");
        if prefix.chars().count() > 40 {
            return Err(CatalogError::InvalidInput("tag prefix is limited to 40 characters".into()));
        }
        let upper = format!("{prefix}\u{10FFFF}");
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT value, {col} FROM catalog_facets
             WHERE kind = 'tag' AND value >= ?1 AND value < ?2 AND {col} > 0
             ORDER BY {col} DESC, value LIMIT ?3"
        ))?;
        let rows = stmt
            .query_map(params![prefix, upper, limit.clamp(1, 100) as i64], |r| {
                Ok(TagCount { tag: r.get(0)?, count: u64::try_from(r.get::<_, i64>(1)?).unwrap_or(0) })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    /// `GET /api/games/by-ids`: visible games in the given order (missing ids omitted). Duplicates of a preferred
    /// listing are still returned, so favorites keep working when the preferred source changes.
    pub fn by_ids(&self, conn: &Connection, ids: &[i64]) -> Result<Vec<GameSummary>> {
        if ids.len() > MAX_BY_IDS {
            return Err(CatalogError::InvalidInput(format!("at most {MAX_BY_IDS} ids")));
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let list = serde_json::to_string(ids)?;
        let rows = self.summaries(
            conn,
            &format!(
                "SELECT {SUMMARY_COLS} FROM games g
                 WHERE g.id IN (SELECT value FROM json_each(?1)) AND g.status = 'active' AND g.source_enabled = 1"
            ),
            &[Value::Text(list)],
        )?;
        let mut by_id: HashMap<i64, GameSummary> = rows.into_iter().map(|g| (g.id, g)).collect();
        Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
    }

    /// `GET /api/games/:slug`: detail plus related games (same categories / tags), or `None`.
    pub fn game(&self, conn: &Connection, slug: &str, related: usize, filter: &ListFilter) -> Result<Option<GamePage>> {
        let filter_conds = filter_sql(filter)?;
        if !crate::slug::is_valid_slug(slug) {
            return Ok(None);
        }
        let row = conn
            .prepare_cached(&format!(
                "SELECT {SUMMARY_COLS}, g.description, g.instructions, g.tags, g.embed_url, g.width, g.height,
                        g.source_url, g.developer_url, g.license, g.published_at, g.attribution, g.embed_kind,
                        g.orientation, g.flags
                 FROM games g WHERE g.slug = ?1 AND g.status = 'active' AND g.source_enabled = 1"
            ))?
            .query_row([slug], |r| {
                Ok((
                    raw_summary(r)?,
                    r.get::<_, String>(11)?,
                    r.get::<_, String>(12)?,
                    r.get::<_, String>(13)?,
                    r.get::<_, String>(14)?,
                    r.get::<_, Option<u32>>(15)?,
                    r.get::<_, Option<u32>>(16)?,
                    r.get::<_, Option<String>>(17)?,
                    r.get::<_, Option<String>>(18)?,
                    r.get::<_, Option<String>>(19)?,
                    r.get::<_, Option<i64>>(20)?,
                    (
                        r.get::<_, String>(21)?,
                        r.get::<_, String>(22)?,
                        r.get::<_, Option<String>>(23)?,
                        r.get::<_, String>(24)?,
                    ),
                ))
            })
            .optional()?;
        let Some((
            s,
            description,
            instructions,
            tags,
            embed,
            width,
            height,
            source_url,
            developer_url,
            license,
            published_at,
            rest,
        )) = row
        else {
            return Ok(None);
        };
        let (attribution, embed_kind, orientation, flags) = rest;
        let id = s.id;
        let playable = s.playable;
        let embed_url = self.render_embed(&embed, &s.slug);
        let game = GameDetail {
            summary: self.render_summary(s),
            description,
            instructions,
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            embed_url,
            width,
            height,
            source_url,
            developer_url,
            license,
            published_at,
            attribution,
            embed_kind,
            orientation,
            flags: serde_json::from_str(&flags).unwrap_or_default(),
        };
        let related =
            if related > 0 { self.related_where(conn, id, playable, related, &filter_conds)? } else { Vec::new() };
        Ok(Some(GamePage { game, related }))
    }

    /// Games sharing categories (primary weighs most) and tags with game `id`, then by popularity. Candidates are
    /// bounded (the most popular games of each category plus games sharing a tag), so the cost does not grow with
    /// the size of a category.
    pub fn related(&self, conn: &Connection, id: i64, playable_only: bool, limit: usize) -> Result<Vec<GameSummary>> {
        self.related_where(conn, id, playable_only, limit, "")
    }

    /// [`Catalog::related`] with extra conditions on the candidates (`filter_sql`).
    fn related_where(
        &self,
        conn: &Connection,
        id: i64,
        playable_only: bool,
        limit: usize,
        extra: &str,
    ) -> Result<Vec<GameSummary>> {
        let cats: Vec<(String, i64)> = conn
            .prepare_cached("SELECT category, position FROM game_categories WHERE game_id = ?1 ORDER BY position")?
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let playable = if playable_only { "AND g.playable = 1" } else { "" };
        let listed = self.facet_count(conn, "all", "", false, !playable_only)?;
        let mut parts = Vec::new();
        let mut args: Vec<Value> = Vec::new();
        for (cat, pos) in cats.iter().take(crate::categories::MAX_CATEGORIES) {
            // Large categories: walk the popularity index until 100 members are found; small ones (where the walk
            // would cover most of the index): sort the members.
            let members = self.facet_count(conn, "category", cat, false, !playable_only)?;
            let plus = if walk_sort_index(members, RELATED_PER_CATEGORY, listed) { "+" } else { "" };
            parts.push(format!(
                "SELECT id, {w} AS w FROM (SELECT g.id FROM games g
                     WHERE g.listed = 1 {playable} AND {plus}g.id IN (SELECT game_id FROM game_categories WHERE category = ?)
                     ORDER BY g.pop_score DESC, g.id DESC LIMIT {RELATED_PER_CATEGORY})",
                w = if *pos == 0 { 3 } else { 1 }
            ));
            args.push(Value::Text(cat.clone()));
        }
        parts.push(
            "SELECT game_id AS id, 2 AS w FROM (SELECT t.game_id FROM game_tags t
                 WHERE t.tag IN (SELECT tag FROM game_tags WHERE game_id = ?) LIMIT 500)"
                .to_owned(),
        );
        args.push(Value::Integer(id));
        args.push(Value::Integer(id));
        args.push(Value::Integer(limit.clamp(1, 48) as i64));
        let sql = format!(
            "SELECT {SUMMARY_COLS} FROM ({}) cand JOIN games g ON g.id = cand.id
             WHERE g.listed = 1 AND g.id <> ? {playable}{extra}
             GROUP BY g.id ORDER BY sum(cand.w) DESC, g.pop_score DESC, g.id DESC LIMIT ?",
            parts.join(" UNION ALL ")
        );
        self.summaries(conn, &sql, &args)
    }

    /// The validated upstream URL for `GET /api/thumb/:id` (`None`: unknown/hidden game, no thumbnail, self-hosted
    /// thumbnail, or a URL the policy refuses).
    pub fn thumbnail_source(&self, conn: &Connection, id: i64) -> Result<Option<String>> {
        let row: Option<(String, Option<String>)> = conn
            .prepare_cached(
                "SELECT source, thumbnail_url FROM games WHERE id = ?1 AND status = 'active' AND source_enabled = 1",
            )?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((source, Some(url))) = row else { return Ok(None) };
        let Some(source) = Source::from_id(&source) else { return Ok(None) };
        Ok(self.thumbs.check(source, &url).ok())
    }

    /// Hosts that visible playable games are embedded from (for the app CSP `frame-src`), plus the fixed hosts of
    /// the enabled sources. Recompute after imports.
    pub fn embed_hosts(&self, conn: &Connection) -> Result<Vec<String>> {
        let mut hosts: Vec<String> =
            self.config.sources.iter().flat_map(|s| s.embed_hosts().iter().map(|h| (*h).to_owned())).collect();
        let mut stmt = conn.prepare_cached(
            "SELECT DISTINCT substr(embed_url, 9, instr(substr(embed_url, 9), '/') - 1) FROM games
             WHERE embed_kind = 'iframe' AND status = 'active' AND source_enabled = 1 AND embed_url LIKE 'https://%'",
        )?;
        for h in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let h = h?;
            // `host` or `host:port` exactly as a CSP host-source needs it; anything else is skipped.
            let valid = crate::url::Url::parse(&format!("https://{h}/")).is_some_and(|u| match u.port {
                Some(p) => h == format!("{}:{p}", u.host),
                None => u.host == h,
            });
            if valid && !hosts.contains(&h) {
                hosts.push(h);
            }
        }
        hosts.sort();
        Ok(hosts)
    }

    /// Visible iframe games per embed host (`host[:port]` exactly as [`Catalog::embed_hosts`] produces them),
    /// sorted by host. Feeds the server's pending-host report (WAVE-C D4).
    pub fn embed_host_counts(&self, conn: &Connection) -> Result<Vec<(String, u64)>> {
        let mut stmt = conn.prepare_cached(
            "SELECT substr(embed_url, 9, instr(substr(embed_url, 9), '/') - 1) AS h, count(*) FROM games
             WHERE embed_kind = 'iframe' AND status = 'active' AND source_enabled = 1 AND embed_url LIKE 'https://%'
             GROUP BY h ORDER BY h",
        )?;
        let mut out = Vec::new();
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (h, n) = row?;
            let valid = crate::url::Url::parse(&format!("https://{h}/")).is_some_and(|u| match u.port {
                Some(p) => h == format!("{}:{p}", u.host),
                None => u.host == h,
            });
            if valid {
                out.push((h, u64::try_from(n).unwrap_or(0)));
            }
        }
        Ok(out)
    }

    /// `"catalog"` object of `GET /admin/diagnostics`.
    pub fn stats(&self, conn: &Connection) -> Result<CatalogStats> {
        let mut by_source: BTreeMap<String, SourceStats> = Source::ALL
            .iter()
            .map(|s| (s.id().to_owned(), SourceStats { enabled: self.config.is_enabled(*s), ..SourceStats::default() }))
            .collect();
        let mut stmt = conn.prepare_cached(
            "SELECT source, status, count(*), sum(listed), sum(canonical_id IS NOT NULL) FROM games GROUP BY source, status",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let (mut games, mut listed) = (0, 0);
        for row in rows {
            let (source, status, n, l, dup) = row?;
            games += n;
            listed += l;
            let e = by_source.entry(source).or_default();
            e.total += n;
            e.listed += l;
            match status.as_str() {
                "active" => {
                    e.active += n;
                    e.duplicates += dup;
                }
                "hidden" => e.hidden += n,
                "broken" => e.broken += n,
                "ip_risk" => e.ip_risk += n,
                _ => {}
            }
        }
        for (id, e) in &mut by_source {
            e.last_import = self.import_runs(conn, Some(id), 1)?.into_iter().next();
        }
        let last_import = conn
            .query_row(
                &format!("SELECT {IMPORT_COLS} FROM catalog_imports WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1"),
                [],
                import_row,
            )
            .optional()?;
        let rankings_refreshed_at = conn
            .query_row("SELECT value FROM catalog_meta WHERE key = 'rankings_refreshed_at'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .and_then(|v| v.parse().ok());
        Ok(CatalogStats { games, listed, by_source, last_import, rankings_refreshed_at })
    }

    /// Recent import runs, newest first (`GET /admin/catalog/imports`).
    pub fn import_runs(&self, conn: &Connection, source: Option<&str>, limit: usize) -> Result<Vec<ImportRun>> {
        let limit = limit.clamp(1, 500) as i64;
        // Two statements, so a per-source lookup uses `catalog_imports_by_source` instead of scanning every run.
        let rows = match source {
            Some(s) => conn
                .prepare_cached(&format!(
                    "SELECT {IMPORT_COLS} FROM catalog_imports WHERE source = ?1 ORDER BY id DESC LIMIT ?2"
                ))?
                .query_map(params![s, limit], import_row)?
                .collect::<Result<_, _>>()?,
            None => conn
                .prepare_cached(&format!("SELECT {IMPORT_COLS} FROM catalog_imports ORDER BY id DESC LIMIT ?1"))?
                .query_map([limit], import_row)?
                .collect::<Result<_, _>>()?,
        };
        Ok(rows)
    }
}

const IMPORT_COLS: &str = "id, source, started_at, finished_at, status, complete, limited, pages, not_modified, requests, \
     retries, seen, inserted, updated, unchanged, rejected, hidden, reported_total, error, note";

fn import_row(r: &Row<'_>) -> rusqlite::Result<ImportRun> {
    Ok(ImportRun {
        id: r.get(0)?,
        source: r.get(1)?,
        started_at: r.get(2)?,
        finished_at: r.get(3)?,
        status: r.get(4)?,
        complete: r.get(5)?,
        limited: r.get(6)?,
        pages: r.get(7)?,
        not_modified: r.get(8)?,
        requests: r.get(9)?,
        retries: r.get(10)?,
        seen: r.get(11)?,
        inserted: r.get(12)?,
        updated: r.get(13)?,
        unchanged: r.get(14)?,
        rejected: r.get(15)?,
        hidden: r.get(16)?,
        reported_total: r.get(17)?,
        error: r.get(18)?,
        note: r.get(19)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_choice_scales_with_the_catalog() {
        // Live 14.7k-game catalog, 49-row pages: the crossover measured between 306 and 443 members.
        assert!(!walk_sort_index(306, 49, 14_685) && walk_sort_index(443, 49, 14_685));
        // Five times the catalog: the same category is better driven from its members.
        assert!(!walk_sort_index(443, 49, 73_000) && walk_sort_index(1_000, 49, 73_000));
        assert!(!walk_sort_index(0, 49, 0));
        // Related games (100 per category): small categories are never walked to the end of the index.
        assert!(!walk_sort_index(68, 100, 14_685) && walk_sort_index(918, 100, 14_685));
    }

    #[test]
    fn fts_query_building() {
        assert_eq!(fts_query("chess").as_deref(), Some("\"chess\"*"));
        assert_eq!(fts_query("Chess master ").as_deref(), Some("\"chess\" \"master\""));
        assert_eq!(fts_query("chess ma").as_deref(), Some("\"chess\" \"ma\""), "2-letter words are exact");
        assert_eq!(fts_query("chess mas").as_deref(), Some("\"chess\" \"mas\"*"));
        assert_eq!(fts_query("\"drop table\"; --").as_deref(), Some("\"drop\" \"table\"*"));
        assert_eq!(fts_query("Pokémon AND OR NEAR(").as_deref(), Some("\"pokémon\" \"and\" \"or\" \"near\"*"));
        assert_eq!(fts_query("  ;; "), None);
        assert_eq!(fts_query(&"w ".repeat(20)).map(|q| q.matches('"').count()), Some(16));
    }
}
