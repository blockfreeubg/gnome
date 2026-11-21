//! Write side: import runs, per-page upserts (one transaction per page), missing-item hiding, cross-source
//! dedup, facet counts, rankings, play counts and admin operations. Everything here is synchronous and runs on
//! the writer connection.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior, params};
use sha2::{Digest, Sha256};

use crate::config::CatalogConfig;
use crate::cursor::MAX_SORT_KEY_BYTES;
use crate::date::DAY_MS;
use crate::dedup::{dedup_key, preference};
use crate::error::{CatalogError, Result};
use crate::model::NewGame;
use crate::slug::{self, base_slug};
use crate::source::Source;
use crate::sources::{ItemCtx, PageInfo};

/// A run whose heartbeat is older than this is considered dead (process killed mid-import).
pub const STALE_RUN_MS: i64 = 60 * 60 * 1000;
/// Consecutive complete syncs a game may be missing from before it is hidden (mirrors the `status` column).
pub const MISSING_SYNCS_TO_HIDE: i64 = 3;
/// A sync is complete only if its count is within this fraction of the previous complete sync (and of the total
/// reported by the source).
pub const COUNT_TOLERANCE: f64 = 0.10;

/// Ranking constants.
pub mod ranking {
    /// Weight of the source quality prior in `pop_score` (cold-start ranking).
    pub const POP_PRIOR: f64 = 2.0;
    /// Half-life (days) of plays in `pop_score`.
    pub const POP_HALF_LIFE_DAYS: f64 = 30.0;
    /// Window (days) of plays counted in `pop_score`.
    pub const POP_WINDOW_DAYS: i64 = 90;
    /// Half-life (days) of plays in `trend_score`.
    pub const TREND_HALF_LIFE_DAYS: f64 = 3.0;
    /// Window (days) of plays counted in `trend_score`.
    pub const TREND_WINDOW_DAYS: i64 = 14;
    /// Weight of recent plays in `trend_score`.
    pub const TREND_PLAYS_WEIGHT: f64 = 1.5;
    /// Half-life (days) of the freshness bonus in `trend_score` (from `published_at`).
    pub const FRESH_HALF_LIFE_DAYS: f64 = 14.0;
    /// Daily play rows older than this are deleted.
    pub const KEEP_PLAYS_DAYS: i64 = 400;
}

/// `(pop_score, trend_score)` from decayed play sums, the source quality and the publication date.
pub fn scores(pop_plays: f64, trend_plays: f64, quality: f64, published_at: Option<i64>, now: i64) -> (f64, f64) {
    use ranking::*;
    let fresh = published_at
        .filter(|p| *p <= now)
        .map_or(0.0, |p| 0.5f64.powf(((now - p) as f64 / DAY_MS as f64) / FRESH_HALF_LIFE_DAYS));
    let pop = pop_plays.ln_1p() + POP_PRIOR * quality;
    let trend = TREND_PLAYS_WEIGHT * trend_plays.ln_1p() + 0.5 * quality + 0.5 * fresh;
    (pop, trend)
}

fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM catalog_meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO catalog_meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// What [`begin_run`] returns.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunStart {
    pub run_id: i64,
    pub prev_complete_seen: Option<i64>,
}

/// Start an import run (fails with [`CatalogError::Busy`] if one is running for the source).
pub(crate) fn begin_run(conn: &mut Connection, source: Source, now: i64, limited: bool) -> Result<RunStart> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "UPDATE catalog_imports SET status = 'interrupted', finished_at = ?2,
                error = coalesce(error, 'abandoned: no heartbeat for an hour')
         WHERE status = 'running' AND source = ?1 AND heartbeat_at < ?3",
        params![source.id(), now, now - STALE_RUN_MS],
    )?;
    let running: Option<i64> = tx
        .query_row("SELECT id FROM catalog_imports WHERE status = 'running' AND source = ?1", [source.id()], |r| {
            r.get(0)
        })
        .optional()?;
    if running.is_some() {
        return Err(CatalogError::Busy(source));
    }
    tx.execute(
        "INSERT INTO catalog_imports (source, started_at, heartbeat_at, status, limited) VALUES (?1, ?2, ?2, 'running', ?3)",
        params![source.id(), now, limited],
    )?;
    let run_id = tx.last_insert_rowid();
    let prev_complete_seen: Option<i64> = tx
        .query_row(
            "SELECT seen FROM catalog_imports WHERE source = ?1 AND complete = 1 ORDER BY id DESC LIMIT 1",
            [source.id()],
            |r| r.get(0),
        )
        .optional()?;
    tx.commit()?;
    Ok(RunStart { run_id, prev_complete_seen })
}

/// Mark every `running` run as interrupted (call once at startup: nothing can be running yet).
pub fn abandon_running(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE catalog_imports SET status = 'interrupted', finished_at = ?1,
                error = coalesce(error, 'interrupted (server restarted)')
         WHERE status = 'running'",
        [now],
    )?)
}

/// Cached HTTP validators of a feed page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CachedPage {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub item_ids: Vec<String>,
    pub info: PageInfo,
}

pub(crate) fn cached_page(conn: &Connection, source: Source, key: &str) -> Result<Option<CachedPage>> {
    let row = conn
        .prepare_cached(
            "SELECT etag, last_modified, item_ids, item_count, next_hint, reported_total
             FROM catalog_http_cache WHERE source = ?1 AND page_key = ?2",
        )?
        .query_row(params![source.id(), key], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })
        .optional()?;
    let Some((etag, last_modified, ids, count, next_hint, total)) = row else { return Ok(None) };
    Ok(Some(CachedPage {
        etag,
        last_modified,
        item_ids: serde_json::from_str(&ids)?,
        info: PageInfo {
            item_count: usize::try_from(count).unwrap_or(0),
            next_hint,
            reported_total: total.and_then(|t| u64::try_from(t).ok()),
            truncated: None,
        },
    }))
}

/// One page to store.
#[derive(Debug, Clone)]
pub(crate) struct PageWrite {
    pub source: Source,
    pub run_id: i64,
    pub now: i64,
    pub page_key: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub info: PageInfo,
    pub games: Vec<NewGame>,
    pub rejected: u32,
    pub requests: u32,
    pub retries: u32,
    /// Whether the source had a complete sync before this run (games first seen now are "new").
    pub has_complete_sync: bool,
    pub dedup_order: Vec<Source>,
}

/// Counters of one page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PageStats {
    pub inserted: u32,
    pub updated: u32,
    pub unchanged: u32,
    /// Records the database refused (constraint violations); rejected alone, the rest of the page is stored.
    pub refused: u32,
    /// Records already listed earlier in the same run (a feed that repeats itself).
    pub repeated: u32,
}

enum Upsert {
    Inserted,
    Updated,
    Unchanged,
}

/// Whether a database error concerns only the record being written (a constraint or size limit), so the record
/// can be rejected on its own instead of failing the page.
fn is_record_error(e: &CatalogError) -> bool {
    match e {
        CatalogError::Db(rusqlite::Error::SqliteFailure(f, _)) => {
            matches!(f.code, ErrorCode::ConstraintViolation | ErrorCode::TooBig)
        }
        CatalogError::Data(_) => true,
        _ => false,
    }
}

/// Store a page in one transaction. Each record is written in its own savepoint, so a record the database
/// refuses is rejected alone (counted in `refused`) while the rest of the page is stored.
pub(crate) fn apply_page(conn: &mut Connection, w: PageWrite) -> Result<PageStats> {
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut keys = BTreeSet::new();
    let mut stats = PageStats::default();
    let mut ids = Vec::with_capacity(w.games.len());
    for g in &w.games {
        let sp = tx.savepoint()?;
        match upsert_game(&sp, g, &w, &mut keys) {
            Ok((outcome, repeated)) => {
                sp.commit()?;
                match outcome {
                    Upsert::Inserted => stats.inserted += 1,
                    Upsert::Updated => stats.updated += 1,
                    Upsert::Unchanged => stats.unchanged += 1,
                }
                stats.repeated += u32::from(repeated);
                ids.push(g.source_id.as_str());
            }
            Err(e) if is_record_error(&e) => {
                // Dropping the savepoint rolls the record back.
                drop(sp);
                stats.refused += 1;
                tracing::warn!(source = w.source.id(), id = %g.source_id, error = %e, "catalog record refused by the database");
            }
            Err(e) => return Err(e),
        }
    }
    recompute_dedup(&tx, &keys, &w.dedup_order)?;
    // Validators are cached only for fully processed pages: a page with rejected records is fetched in full next
    // time (a 304 would otherwise keep those records out until the page changes).
    if (w.etag.is_some() || w.last_modified.is_some()) && w.rejected == 0 && stats.refused == 0 {
        tx.execute(
            "INSERT INTO catalog_http_cache
                 (source, page_key, etag, last_modified, item_ids, item_count, next_hint, reported_total, stored_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (source, page_key) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
                 item_ids = excluded.item_ids, item_count = excluded.item_count, next_hint = excluded.next_hint,
                 reported_total = excluded.reported_total, stored_at = excluded.stored_at",
            params![
                w.source.id(),
                w.page_key,
                w.etag,
                w.last_modified,
                serde_json::to_string(&ids)?,
                w.info.item_count as i64,
                w.info.next_hint,
                w.info.reported_total.map(|t| t as i64),
                w.now
            ],
        )?;
    } else {
        tx.execute(
            "DELETE FROM catalog_http_cache WHERE source = ?1 AND page_key = ?2",
            params![w.source.id(), w.page_key],
        )?;
    }
    tx.execute(
        "UPDATE catalog_imports SET pages = pages + 1, requests = requests + ?2, retries = retries + ?3,
                inserted = inserted + ?4, updated = updated + ?5, unchanged = unchanged + ?6, rejected = rejected + ?7,
                reported_total = coalesce(?8, reported_total), heartbeat_at = ?9
         WHERE id = ?1",
        params![
            w.run_id,
            w.requests,
            w.retries,
            stats.inserted,
            stats.updated,
            stats.unchanged,
            w.rejected + stats.refused,
            w.info.reported_total.map(|t| t as i64),
            w.now
        ],
    )?;
    tx.commit()?;
    Ok(stats)
}

/// A `304 Not Modified` page: the games it listed last time are still listed.
#[derive(Debug, Clone)]
pub(crate) struct NotModified {
    pub source: Source,
    pub run_id: i64,
    pub now: i64,
    pub item_ids: Vec<String>,
    pub reported_total: Option<u64>,
    pub requests: u32,
    pub retries: u32,
    pub dedup_order: Vec<Source>,
}

pub(crate) fn apply_not_modified(conn: &mut Connection, n: NotModified) -> Result<PageStats> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let ids = serde_json::to_string(&n.item_ids)?;
    let revived: BTreeSet<String> = {
        let mut stmt = tx.prepare_cached(
            "SELECT DISTINCT dedup_key FROM games
             WHERE source = ?1 AND missing_count >= ?3 AND source_id IN (SELECT value FROM json_each(?2))",
        )?;
        stmt.query_map(params![n.source.id(), ids, MISSING_SYNCS_TO_HIDE], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    let touched = tx.execute(
        "UPDATE games SET last_seen_at = ?3, last_seen_run = ?4, missing_count = 0
         WHERE source = ?1 AND source_id IN (SELECT value FROM json_each(?2))",
        params![n.source.id(), ids, n.now, n.run_id],
    )?;
    recompute_dedup(&tx, &revived, &n.dedup_order)?;
    tx.execute(
        "UPDATE catalog_imports SET pages = pages + 1, not_modified = not_modified + 1, unchanged = unchanged + ?2,
                requests = requests + ?3, retries = retries + ?4, reported_total = coalesce(?5, reported_total),
                heartbeat_at = ?6
         WHERE id = ?1",
        params![n.run_id, touched as i64, n.requests, n.retries, n.reported_total.map(|t| t as i64), n.now],
    )?;
    tx.commit()?;
    Ok(PageStats { unchanged: u32::try_from(touched).unwrap_or(u32::MAX), ..PageStats::default() })
}

fn json<T: serde::Serialize + ?Sized>(v: &T) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}

fn categories_json(g: &NewGame) -> Result<String> {
    json(&g.categories.iter().map(|c| c.slug()).collect::<Vec<_>>())
}

/// Folded title for `sort=az` (leading punctuation ignored), at most [`MAX_SORT_KEY_BYTES`] long so a cursor always
/// carries the whole key (a cut key would sort before its own row and repeat it on the next page).
pub(crate) fn title_sort(title: &str) -> String {
    let folded = slug::fold(title);
    let key = folded.trim_start_matches(|c: char| !c.is_alphanumeric());
    let mut cut = key.len().min(MAX_SORT_KEY_BYTES);
    while !key.is_char_boundary(cut) {
        cut -= 1;
    }
    key[..cut].to_owned()
}

/// A free slug derived from `base`: `base`, `base-2`, ... `base-50`, then `base-<h>` and `base-<h>-2`, ... where
/// `<h>` comes from the record's source id. Every candidate is checked, so the result is always free; it is at
/// most [`slug::MAX_STORED_SLUG`] long.
pub(crate) fn unique_slug(conn: &Connection, base: &str, source: Source, source_id: &str) -> Result<String> {
    let mut stmt = conn.prepare_cached("SELECT 1 FROM games WHERE slug = ?1")?;
    for n in 1..=50u32 {
        let cand = if n == 1 { base.to_owned() } else { format!("{base}-{n}") };
        if !stmt.exists([&cand])? {
            return Ok(cand);
        }
    }
    let h = Sha256::digest(format!("{}:{source_id}", source.id()).as_bytes());
    let hashed: String = h.iter().take(4).map(|b| format!("{b:02x}")).collect();
    for n in 1..=999u32 {
        let cand = if n == 1 { format!("{base}-{hashed}") } else { format!("{base}-{hashed}-{n}") };
        if !stmt.exists([&cand])? {
            debug_assert!(cand.len() <= slug::MAX_STORED_SLUG);
            return Ok(cand);
        }
    }
    Err(CatalogError::Data(format!("no free slug for {base:?}")))
}

fn write_labels(conn: &Connection, id: i64, g: &NewGame) -> Result<()> {
    conn.prepare_cached("DELETE FROM game_categories WHERE game_id = ?1")?.execute([id])?;
    let mut ins =
        conn.prepare_cached("INSERT OR IGNORE INTO game_categories (game_id, category, position) VALUES (?1, ?2, ?3)")?;
    for (i, c) in g.categories.iter().enumerate() {
        ins.execute(params![id, c.slug(), i as i64])?;
    }
    conn.prepare_cached("DELETE FROM game_tags WHERE game_id = ?1")?.execute([id])?;
    let mut ins = conn.prepare_cached("INSERT OR IGNORE INTO game_tags (game_id, tag) VALUES (?1, ?2)")?;
    // Same bound as the schema's CHECK (`length()` counts characters, not bytes).
    for t in g.tags.iter().filter(|t| (1..=48).contains(&t.chars().count())) {
        ins.execute(params![id, t])?;
    }
    Ok(())
}

/// Insert or update one record. Returns the outcome and whether the record was already listed earlier in this run.
fn upsert_game(conn: &Connection, g: &NewGame, w: &PageWrite, keys: &mut BTreeSet<String>) -> Result<(Upsert, bool)> {
    let existing = conn
        .prepare_cached("SELECT id, last_seen_run FROM games WHERE source = ?1 AND source_id = ?2")?
        .query_row(params![g.source.id(), g.source_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)))
        .optional()?;
    match existing {
        None => {
            insert_game(conn, g, w.now, w.has_complete_sync, w.run_id)?;
            keys.insert(dedup_key(&g.title, g.developer.as_deref()));
            Ok((Upsert::Inserted, false))
        }
        Some((id, last_run)) => {
            let (changed, revived) = update_game(conn, id, g, w.now, keys)?;
            conn.prepare_cached(
                "UPDATE games SET last_seen_at = ?2, last_seen_run = ?3, missing_count = 0, quality = ?4,
                        source_rank = ?5
                 WHERE id = ?1",
            )?
            .execute(params![id, w.now, w.run_id, g.quality.unwrap_or(0.5), g.source_rank])?;
            if revived {
                keys.insert(dedup_key(&g.title, g.developer.as_deref()));
            }
            Ok((if changed { Upsert::Updated } else { Upsert::Unchanged }, last_run == Some(w.run_id)))
        }
    }
}

fn insert_game(conn: &Connection, g: &NewGame, now: i64, has_complete_sync: bool, run_id: i64) -> Result<i64> {
    let slug = unique_slug(conn, &base_slug(g.slug_hint.as_deref(), &g.title, &g.source_id), g.source, &g.source_id)?;
    let (text_hash, meta_hash) = g.hashes();
    let quality = g.quality.unwrap_or(0.5);
    let published = g.published_at.map(|p| p.min(now));
    let new_key = published.unwrap_or(if has_complete_sync { now } else { 0 });
    let (pop, trend) = scores(0.0, 0.0, quality, published, now);
    conn.prepare_cached(
        "INSERT INTO games (source, source_id, slug, title, title_sort, developer, developer_url, thumbnail_url,
             embed_kind, embed_url, playable, width, height, orientation, mobile, source_url, license, attribution,
             categories, tags, flags, source_categories, thumbnails, published_at, source_updated_at, added_at,
             updated_at, new_key, last_seen_at, ip_risk, ip_risk_term, quality, source_rank, pop_score, trend_score,
             dedup_key, text_hash, meta_hash, keywords, description, instructions, last_seen_run)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
             ?23, ?24, ?25, ?26, ?26, ?27, ?26, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40)",
    )?
    .execute(params![
        g.source.id(),
        g.source_id,
        slug,
        g.title,
        title_sort(&g.title),
        g.developer,
        g.developer_url,
        g.thumbnail_url,
        g.embed_kind.as_str(),
        g.embed_url,
        g.playable(),
        g.width,
        g.height,
        g.orientation.map(|o| o.as_str()),
        g.mobile,
        g.source_url,
        g.license,
        g.attribution,
        categories_json(g)?,
        json(&g.tags)?,
        json(&g.flags)?,
        json(&g.source_categories)?,
        json(&g.thumbnails)?,
        published,
        g.source_updated_at,
        now,
        new_key,
        g.ip_risk_term.is_some(),
        g.ip_risk_term,
        quality,
        g.source_rank,
        pop,
        trend,
        dedup_key(&g.title, g.developer.as_deref()),
        text_hash,
        meta_hash,
        g.keywords(),
        g.description,
        g.instructions,
        run_id,
    ])?;
    let id = conn.last_insert_rowid();
    conn.prepare_cached("INSERT INTO game_raw (game_id, raw, fetched_at) VALUES (?1, ?2, ?3)")?
        .execute(params![id, g.raw, now])?;
    write_labels(conn, id, g)?;
    Ok(id)
}

/// Update an existing row's normalized content when it changed. Returns `(changed, was_hidden_as_missing)`.
fn update_game(conn: &Connection, id: i64, g: &NewGame, now: i64, keys: &mut BTreeSet<String>) -> Result<(bool, bool)> {
    let (old_text, old_meta, old_key, old_ip, missing, old_sort): (String, String, String, bool, i64, String) = conn
        .prepare_cached(
            "SELECT text_hash, meta_hash, dedup_key, ip_risk, missing_count, title_sort FROM games WHERE id = ?1",
        )?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?;
    let (text_hash, meta_hash) = g.hashes();
    let key = dedup_key(&g.title, g.developer.as_deref());
    let mut changed = false;
    if old_text == text_hash && old_sort != title_sort(&g.title) {
        // Same text, but the sort key rules changed (rows written by an earlier version): not an FTS change.
        conn.prepare_cached("UPDATE games SET title_sort = ?2 WHERE id = ?1")?
            .execute(params![id, title_sort(&g.title)])?;
    }
    if old_text != text_hash {
        conn.prepare_cached(
            "UPDATE games SET title = ?2, title_sort = ?3, developer = ?4, keywords = ?5, description = ?6,
                    dedup_key = ?7, text_hash = ?8
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            g.title,
            title_sort(&g.title),
            g.developer,
            g.keywords(),
            g.description,
            key,
            text_hash
        ])?;
        if old_key != key {
            keys.insert(old_key);
            keys.insert(key.clone());
        }
        changed = true;
    }
    if old_meta != meta_hash {
        let published = g.published_at.map(|p| p.min(now));
        conn.prepare_cached(
            "UPDATE games SET developer_url = ?2, thumbnail_url = ?3, embed_kind = ?4, embed_url = ?5, playable = ?6,
                    width = ?7, height = ?8, orientation = ?9, mobile = ?10, source_url = ?11, license = ?12,
                    attribution = ?13, categories = ?14, tags = ?15, flags = ?16, source_categories = ?17,
                    thumbnails = ?18, published_at = ?19, source_updated_at = ?20, ip_risk = ?21, ip_risk_term = ?22,
                    instructions = ?23, meta_hash = ?24, new_key = CASE WHEN ?19 IS NOT NULL THEN ?19 ELSE new_key END
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            g.developer_url,
            g.thumbnail_url,
            g.embed_kind.as_str(),
            g.embed_url,
            g.playable(),
            g.width,
            g.height,
            g.orientation.map(|o| o.as_str()),
            g.mobile,
            g.source_url,
            g.license,
            g.attribution,
            categories_json(g)?,
            json(&g.tags)?,
            json(&g.flags)?,
            json(&g.source_categories)?,
            json(&g.thumbnails)?,
            published,
            g.source_updated_at,
            g.ip_risk_term.is_some(),
            g.ip_risk_term,
            g.instructions,
            meta_hash,
        ])?;
        write_labels(conn, id, g)?;
        if old_ip != g.ip_risk_term.is_some() {
            keys.insert(key.clone());
        }
        changed = true;
    }
    if changed {
        conn.prepare_cached("UPDATE games SET updated_at = ?2 WHERE id = ?1")?.execute(params![id, now])?;
        conn.prepare_cached("UPDATE game_raw SET raw = ?2, fetched_at = ?3 WHERE game_id = ?1")?
            .execute(params![id, g.raw, now])?;
    }
    Ok((changed, missing >= MISSING_SYNCS_TO_HIDE))
}

/// Recompute the canonical (preferred) listing of each duplicate group in `keys`.
pub(crate) fn recompute_dedup<'a, I>(conn: &Connection, keys: I, order: &[Source]) -> Result<()>
where
    I: IntoIterator<Item = &'a String>,
{
    let mut select = conn.prepare_cached(
        "SELECT id, source, quality, canonical_id, status = 'active' AND source_enabled = 1 FROM games WHERE dedup_key = ?1",
    )?;
    let mut update = conn.prepare_cached("UPDATE games SET canonical_id = ?2 WHERE id = ?1")?;
    for key in keys {
        let rows: Vec<(i64, String, f64, Option<i64>, bool)> = select
            .query_map([key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<Result<_, _>>()?;
        let src = |s: &str| Source::from_id(s).unwrap_or(Source::Js13k);
        let primary = rows.iter().filter(|r| r.4).min_by(|a, b| {
            preference(order, src(&a.1))
                .cmp(&preference(order, src(&b.1)))
                .then(b.2.total_cmp(&a.2))
                .then(a.0.cmp(&b.0))
        });
        for r in &rows {
            let desired = match primary {
                Some(p) if p.1 != r.1 => Some(p.0),
                _ => None,
            };
            if r.3 != desired {
                update.execute(params![r.0, desired])?;
            }
        }
    }
    Ok(())
}

/// End-of-run input.
#[derive(Debug, Clone)]
pub(crate) struct Finish {
    pub run_id: i64,
    pub source: Source,
    pub now: i64,
    pub reached_end: bool,
    pub limited: bool,
    pub error: Option<String>,
    /// Why the run did not cover the whole feed (from the pages themselves).
    pub truncated: Option<String>,
    pub prev_complete_seen: Option<i64>,
    pub requests: u32,
    pub retries: u32,
    pub dedup_order: Vec<Source>,
}

/// Outcome of a run (also stored in `catalog_imports`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RunSummary {
    /// `complete`, `incomplete` or `failed`.
    pub status: String,
    /// Trusted for hiding missing games.
    pub complete: bool,
    /// Distinct games listed.
    pub seen: i64,
    /// Games that reached the missing threshold.
    pub hidden: i64,
    /// Why the run is incomplete, or an informational note.
    pub note: Option<String>,
    /// Fatal error.
    pub error: Option<String>,
}

fn within(a: i64, b: i64) -> bool {
    (a - b).abs() as f64 <= COUNT_TOLERANCE * b as f64
}

/// Decide whether a run that reached the end of its feed is *complete* (trusted for hiding missing games).
///
/// The count must be within ±10% of the previous complete sync. Growth beyond that is accepted (it cannot hide
/// anything wrongly); a shrink is accepted only once three consecutive syncs that reached the end agree on the
/// new size (±10%), so a feed outage that returns part of the catalog never hides the rest, while a real,
/// lasting removal is eventually honoured. Returns `(complete, note)`.
fn size_check(seen: i64, prev_complete: Option<i64>, prior_reached_end: &[i64]) -> (bool, Option<String>) {
    let Some(prev) = prev_complete else { return (true, None) };
    if within(seen, prev) {
        return (true, None);
    }
    if seen > prev {
        return (true, Some(format!("catalog grew from {prev} to {seen} games")));
    }
    if prior_reached_end.len() >= 2 && prior_reached_end.iter().take(2).all(|p| within(seen, *p)) {
        return (true, Some(format!("new size {seen} confirmed by 3 consecutive syncs (was {prev})")));
    }
    (false, Some(format!("{seen} games listed vs {prev} in the previous complete sync (outside ±10%)")))
}

pub(crate) fn finish_run(conn: &mut Connection, f: Finish) -> Result<RunSummary> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let prior_reached_end: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT seen FROM catalog_imports WHERE source = ?1 AND id < ?2 AND reached_end = 1 ORDER BY id DESC LIMIT 2",
        )?;
        stmt.query_map(params![f.source.id(), f.run_id], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    let seen: i64 = tx.query_row(
        "SELECT count(*) FROM games WHERE source = ?1 AND last_seen_run = ?2",
        params![f.source.id(), f.run_id],
        |r| r.get(0),
    )?;
    let reported: Option<i64> =
        tx.query_row("SELECT reported_total FROM catalog_imports WHERE id = ?1", [f.run_id], |r| r.get(0))?;
    let local = f.source == Source::Oss;
    let mut note = None;
    let complete = if f.error.is_some() {
        false
    } else if f.limited {
        note = Some("limited run (item or page limit): missing games are not counted".to_owned());
        false
    } else if let Some(t) = &f.truncated {
        note = Some(t.clone());
        false
    } else if !f.reached_end {
        note = Some("the end of the feed was not reached".to_owned());
        false
    } else if local {
        true
    } else if seen == 0 {
        note = Some("the feed listed no games".to_owned());
        false
    } else if let Some(t) = reported.filter(|t| !within(seen, *t)) {
        note = Some(format!("{seen} games listed but the source reports {t} (outside ±10%)"));
        false
    } else {
        let (ok, n) = size_check(seen, f.prev_complete_seen, &prior_reached_end);
        note = n;
        ok
    };
    let reached_end = f.reached_end && f.error.is_none() && !f.limited && f.truncated.is_none();
    let mut hidden = 0i64;
    if complete {
        // Games not listed in this complete sync. Remote feeds: one more strike (hidden at the third). The local
        // OSS manifest is authoritative, so its missing entries are hidden at once.
        let crossed: Vec<String> = if local {
            let keys: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT dedup_key FROM games WHERE source = ?1 AND last_seen_run IS NOT ?2 AND missing_count < ?3",
                )?;
                stmt.query_map(params![f.source.id(), f.run_id, MISSING_SYNCS_TO_HIDE], |r| r.get(0))?
                    .collect::<Result<_, _>>()?
            };
            tx.execute(
                "UPDATE games SET missing_count = ?3
                 WHERE source = ?1 AND last_seen_run IS NOT ?2 AND missing_count < ?3",
                params![f.source.id(), f.run_id, MISSING_SYNCS_TO_HIDE],
            )?;
            keys
        } else {
            tx.execute(
                "UPDATE games SET missing_count = missing_count + 1 WHERE source = ?1 AND last_seen_run IS NOT ?2",
                params![f.source.id(), f.run_id],
            )?;
            let mut stmt = tx.prepare(
                "SELECT dedup_key FROM games WHERE source = ?1 AND last_seen_run IS NOT ?2 AND missing_count = ?3",
            )?;
            stmt.query_map(params![f.source.id(), f.run_id, MISSING_SYNCS_TO_HIDE], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        hidden = crossed.len() as i64;
        let keys: BTreeSet<String> = crossed.into_iter().collect();
        recompute_dedup(&tx, &keys, &f.dedup_order)?;
    }
    let status = match (&f.error, complete) {
        (Some(_), _) => "failed",
        (None, true) => "complete",
        (None, false) => "incomplete",
    };
    tx.execute(
        "UPDATE catalog_imports SET finished_at = ?2, heartbeat_at = ?2, status = ?3, complete = ?4, seen = ?5,
                hidden = ?6, error = ?7, note = ?8, requests = requests + ?9, retries = retries + ?10,
                reached_end = ?11
         WHERE id = ?1",
        params![f.run_id, f.now, status, complete, seen, hidden, f.error, note, f.requests, f.retries, reached_end],
    )?;
    refresh_facets(&tx)?;
    refresh_rankings(&tx, f.now)?;
    tx.commit()?;
    Ok(RunSummary { status: status.to_owned(), complete, seen, hidden, note, error: f.error })
}

/// Recount listed games: overall, per category and per tag (with playable / mobile splits).
pub fn refresh_facets(conn: &Connection) -> Result<()> {
    const COUNTS: &str = "count(*), coalesce(sum(g.playable), 0), coalesce(sum(g.mobile = 1), 0), \
                          coalesce(sum(g.playable = 1 AND g.mobile = 1), 0)";
    conn.execute_batch(&format!(
        "DELETE FROM catalog_facets;
         INSERT INTO catalog_facets (kind, value, count_all, count_playable, count_mobile_all, count_mobile_playable)
             SELECT 'all', '', {COUNTS} FROM games g WHERE g.listed = 1;
         INSERT INTO catalog_facets (kind, value, count_all, count_playable, count_mobile_all, count_mobile_playable)
             SELECT 'category', c.category, {COUNTS}
             FROM game_categories c JOIN games g ON g.id = c.game_id
             WHERE g.listed = 1 GROUP BY c.category;
         INSERT INTO catalog_facets (kind, value, count_all, count_playable, count_mobile_all, count_mobile_playable)
             SELECT 'tag', t.tag, {COUNTS}
             FROM game_tags t JOIN games g ON g.id = t.game_id
             WHERE g.listed = 1 GROUP BY t.tag;"
    ))?;
    Ok(())
}

/// Recompute `pop_score` / `trend_score` from the daily play counts (decayed windows) and the cold-start priors.
/// Only rows whose score changed are written. Returns the number of rows updated.
pub fn refresh_rankings(conn: &Connection, now: i64) -> Result<usize> {
    use ranking::*;
    let today = now.div_euclid(DAY_MS);
    let mut sums: HashMap<i64, (f64, f64)> = HashMap::new();
    {
        let mut stmt = conn.prepare_cached("SELECT game_id, day, count FROM game_plays_daily WHERE day > ?1")?;
        let mut rows = stmt.query([today - POP_WINDOW_DAYS])?;
        while let Some(r) = rows.next()? {
            let (id, day, count): (i64, i64, i64) = (r.get(0)?, r.get(1)?, r.get(2)?);
            let age = (today - day).max(0) as f64;
            let e = sums.entry(id).or_default();
            e.0 += count as f64 * 0.5f64.powf(age / POP_HALF_LIFE_DAYS);
            if today - day < TREND_WINDOW_DAYS {
                e.1 += count as f64 * 0.5f64.powf(age / TREND_HALF_LIFE_DAYS);
            }
        }
    }
    let mut update = conn.prepare_cached("UPDATE games SET pop_score = ?2, trend_score = ?3 WHERE id = ?1")?;
    let mut stmt = conn.prepare_cached("SELECT id, quality, published_at, pop_score, trend_score FROM games")?;
    let mut rows = stmt.query([])?;
    let mut updated = 0usize;
    while let Some(r) = rows.next()? {
        let (id, quality, published, old_pop, old_trend): (i64, f64, Option<i64>, f64, f64) =
            (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
        let (p, t) = sums.get(&id).copied().unwrap_or_default();
        let (pop, trend) = scores(p, t, quality, published, now);
        if (pop - old_pop).abs() > 1e-6 || (trend - old_trend).abs() > 1e-6 {
            update.execute(params![id, pop, trend])?;
            updated += 1;
        }
    }
    conn.execute("DELETE FROM game_plays_daily WHERE day < ?1", [today - KEEP_PLAYS_DAYS])?;
    conn.execute("DELETE FROM game_play_dedup WHERE expires_at <= ?1", [now])?;
    set_meta(conn, "rankings_refreshed_at", &now.to_string())?;
    Ok(updated)
}

/// Result of [`record_play`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayOutcome {
    /// The play was counted.
    Counted,
    /// Already counted for this key, game and hour.
    Duplicate,
}

/// Count an anonymous play of the game `slug`. `dedup_key` is an opaque caller value (e.g. an HMAC of the
/// session); only a 16-byte hash of (key, game, hour) is stored, and only until the hour ends.
pub fn record_play(conn: &mut Connection, slug: &str, dedup_key: &[u8], now: i64) -> Result<PlayOutcome> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id: i64 = tx
        .prepare_cached("SELECT id FROM games WHERE slug = ?1 AND status = 'active' AND source_enabled = 1")?
        .query_row([slug], |r| r.get(0))
        .optional()?
        .ok_or(CatalogError::NotFound)?;
    let hour = now.div_euclid(3_600_000);
    let mut h = Sha256::new();
    h.update(b"gnome-catalog-play-v1\0");
    h.update((dedup_key.len() as u64).to_le_bytes());
    h.update(dedup_key);
    h.update(id.to_le_bytes());
    h.update(hour.to_le_bytes());
    let key: [u8; 16] = h.finalize()[..16].try_into().expect("16 bytes");
    let fresh = tx
        .prepare_cached("INSERT OR IGNORE INTO game_play_dedup (key, expires_at) VALUES (?1, ?2)")?
        .execute(params![key.as_slice(), (hour + 1) * 3_600_000])?;
    if fresh == 0 {
        return Ok(PlayOutcome::Duplicate);
    }
    tx.prepare_cached(
        "INSERT INTO game_plays_daily (game_id, day, count) VALUES (?1, ?2, 1)
         ON CONFLICT (game_id, day) DO UPDATE SET count = count + 1",
    )?
    .execute(params![id, now.div_euclid(DAY_MS)])?;
    tx.prepare_cached("UPDATE games SET plays = plays + 1 WHERE id = ?1")?.execute([id])?;
    tx.prepare_cached(
        "DELETE FROM game_play_dedup WHERE key IN (SELECT key FROM game_play_dedup WHERE expires_at <= ?1 LIMIT 64)",
    )?
    .execute([now])?;
    tx.commit()?;
    Ok(PlayOutcome::Counted)
}

/// Admin status override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdminStatus {
    /// Shown (also overrides an `ip_risk` match or a missing-from-feed hide).
    Active,
    /// Hidden by an admin.
    Hidden,
    /// Marked broken (the embed does not load).
    Broken,
}

impl AdminStatus {
    /// Database / API value.
    pub const fn as_str(self) -> &'static str {
        match self {
            AdminStatus::Active => "active",
            AdminStatus::Hidden => "hidden",
            AdminStatus::Broken => "broken",
        }
    }

    /// Parse `active` / `hidden` / `broken`.
    pub fn parse(s: &str) -> Option<AdminStatus> {
        Some(match s {
            "active" => AdminStatus::Active,
            "hidden" => AdminStatus::Hidden,
            "broken" => AdminStatus::Broken,
            _ => return None,
        })
    }
}

/// Feature or unfeature a game.
pub fn set_featured(conn: &mut Connection, id: i64, featured: bool, now: i64) -> Result<()> {
    let n = conn.execute(
        "UPDATE games SET featured = ?2, featured_at = CASE WHEN ?2 THEN coalesce(featured_at, ?3) END WHERE id = ?1",
        params![id, featured, now],
    )?;
    if n == 0 {
        return Err(CatalogError::NotFound);
    }
    Ok(())
}

/// Set (or with `None`, clear) the sticky admin status of a game. An admin `active` also overrides an `ip_risk`
/// match or a missing-from-feed hide.
pub fn set_status(conn: &mut Connection, id: i64, status: Option<AdminStatus>, order: &[Source]) -> Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let key: String = tx
        .query_row("SELECT dedup_key FROM games WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or(CatalogError::NotFound)?;
    tx.execute("UPDATE games SET admin_status = ?2 WHERE id = ?1", params![id, status.map(AdminStatus::as_str)])?;
    recompute_dedup(&tx, &[key], order)?;
    refresh_facets(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Apply the enabled-source set and dedup order (no-op when unchanged since the last call).
pub(crate) fn apply_listing_config(conn: &Connection, config: &CatalogConfig) -> Result<bool> {
    let fp = config.listing_fingerprint();
    if get_meta(conn, "listing_fingerprint")?.as_deref() == Some(fp.as_str()) {
        return Ok(false);
    }
    for s in Source::ALL {
        conn.execute(
            "UPDATE games SET source_enabled = ?2 WHERE source = ?1 AND source_enabled <> ?2",
            params![s.id(), config.is_enabled(s)],
        )?;
    }
    let keys: Vec<String> = {
        let mut stmt = conn.prepare("SELECT dedup_key FROM games GROUP BY dedup_key HAVING count(*) > 1")?;
        stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    recompute_dedup(conn, &keys, &config.dedup_order)?;
    set_meta(conn, "listing_fingerprint", &fp)?;
    Ok(true)
}

/// Re-map every stored record from its raw data when the normalization rules or the blocklist changed. Works in
/// chunks of 500 rows (one transaction each). Returns the number of rows changed, or `None` when up to date.
pub(crate) fn reapply_rules(conn: &mut Connection, config: &CatalogConfig, now: i64) -> Result<Option<usize>> {
    let fp = config.rules_fingerprint();
    if get_meta(conn, "rules_fingerprint")?.as_deref() == Some(fp.as_str()) {
        return Ok(None);
    }
    let mut after = 0i64;
    let mut changed = 0usize;
    loop {
        let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows: Vec<(i64, String, Option<i64>, String)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT g.id, g.source, g.source_rank, r.raw FROM games g JOIN game_raw r ON r.game_id = g.id
                 WHERE g.id > ?1 ORDER BY g.id LIMIT 500",
            )?;
            stmt.query_map([after], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?
        };
        let Some(last) = rows.last().map(|r| r.0) else {
            tx.commit()?;
            break;
        };
        let mut keys = BTreeSet::new();
        for (id, source, rank, raw) in rows {
            let Some(source) = Source::from_id(&source) else { continue };
            let ctx =
                ItemCtx { rank: rank.and_then(|r| u32::try_from(r).ok()).unwrap_or(1), reported_total: None, config };
            match crate::sources::renormalize(source, &raw, &ctx) {
                Ok(mut g) => {
                    // Rank-derived quality is not recomputable from the raw record; keep the stored inputs.
                    g.source_rank = rank.and_then(|r| u32::try_from(r).ok());
                    let sp = tx.savepoint()?;
                    match update_game(&sp, id, &g, now, &mut keys) {
                        Ok((c, _)) => {
                            sp.commit()?;
                            changed += usize::from(c);
                        }
                        Err(e) if is_record_error(&e) => {
                            drop(sp);
                            tracing::warn!(game = id, source = source.id(), error = %e, "re-mapped record refused by the database");
                        }
                        Err(e) => return Err(e),
                    }
                }
                Err(e) => {
                    tracing::warn!(game = id, source = source.id(), error = %e, "stored record no longer normalizes")
                }
            }
        }
        recompute_dedup(&tx, &keys, &config.dedup_order)?;
        tx.commit()?;
        after = last;
    }
    set_meta(conn, "rules_fingerprint", &fp)?;
    Ok(Some(changed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_rule() {
        assert!(size_check(100, None, &[]).0, "first sync");
        assert!(size_check(95, Some(100), &[]).0);
        assert!(size_check(110, Some(100), &[]).0);
        let (ok, note) = size_check(150, Some(100), &[]);
        assert!(ok && note.unwrap().contains("grew"));
        assert!(!size_check(80, Some(100), &[]).0, "shrink: not trusted");
        assert!(!size_check(80, Some(100), &[81]).0, "two observations are not enough");
        assert!(!size_check(80, Some(100), &[81, 100]).0, "the previous size is not a confirmation");
        let (ok, note) = size_check(80, Some(100), &[81, 79]);
        assert!(ok && note.unwrap().contains("confirmed by 3 consecutive syncs"));
    }

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::init_schema(&c).unwrap();
        c
    }

    #[test]
    fn concurrent_and_stale_runs() {
        let mut c = mem();
        let a = begin_run(&mut c, Source::GamePix, 1_000, false).unwrap();
        assert!(matches!(begin_run(&mut c, Source::GamePix, 2_000, false), Err(CatalogError::Busy(Source::GamePix))));
        assert!(begin_run(&mut c, Source::Famobi, 2_000, false).is_ok(), "other sources are independent");
        // An hour without heartbeat: the old run is considered dead.
        let b = begin_run(&mut c, Source::GamePix, 1_000 + STALE_RUN_MS + 1, false).unwrap();
        assert_ne!(a.run_id, b.run_id);
        let status: String =
            c.query_row("SELECT status FROM catalog_imports WHERE id = ?1", [a.run_id], |r| r.get(0)).unwrap();
        assert_eq!(status, "interrupted");
        assert_eq!(abandon_running(&c, 5_000).unwrap(), 2);
    }

    #[test]
    fn unique_slugs() {
        let c = mem();
        assert_eq!(unique_slug(&c, "chess", Source::GamePix, "A").unwrap(), "chess");
        assert_eq!(title_sort("  #1 Ünïcorn Racer"), "1 unicorn racer");
        // Sort keys fit a cursor whole and are never cut inside a character.
        let long = title_sort(&"游戏🎮".repeat(40));
        assert!(long.len() <= MAX_SORT_KEY_BYTES && long.len() > MAX_SORT_KEY_BYTES - 4, "{}", long.len());
    }

    /// Two real records of the captured GamePix page, normalized by the adapter.
    fn real_records() -> Vec<NewGame> {
        let body = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gamepix-p1.json")).unwrap();
        let cfg = CatalogConfig::default();
        let a = crate::sources::adapter(Source::GamePix, &cfg).unwrap();
        let page = a.first(0);
        let parsed = a.parse(&page, &body).unwrap();
        let ctx = ItemCtx { rank: 1, reported_total: None, config: &cfg };
        parsed.items.iter().take(2).map(|r| a.normalize(r, &ctx).unwrap()).collect()
    }

    fn page_write(run_id: i64, games: Vec<NewGame>) -> PageWrite {
        PageWrite {
            source: Source::GamePix,
            run_id,
            now: 1_000,
            page_key: "page:1".into(),
            etag: Some("\"v1\"".into()),
            last_modified: None,
            info: PageInfo { item_count: games.len(), ..PageInfo::default() },
            games,
            rejected: 0,
            requests: 1,
            retries: 0,
            has_complete_sync: false,
            dedup_order: crate::dedup::DEFAULT_ORDER.to_vec(),
        }
    }

    #[test]
    fn a_record_the_database_refuses_is_rejected_alone() {
        let mut c = mem();
        let run = begin_run(&mut c, Source::GamePix, 1_000, false).unwrap();
        let mut games = real_records();
        // Bypass `finalize`: a size outside the schema's CHECK range reaches the database.
        games[0].width = Some(20_000);
        let stats = apply_page(&mut c, page_write(run.run_id, games)).unwrap();
        assert_eq!((stats.inserted, stats.refused), (1, 1));
        let n = |c: &Connection, sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(n(&c, "SELECT count(*) FROM games"), 1);
        assert_eq!(n(&c, "SELECT count(*) FROM game_raw"), 1, "the refused record left nothing behind");
        assert_eq!(n(&c, "SELECT count(*) FROM games_fts"), 1);
        assert_eq!(n(&c, "SELECT rejected FROM catalog_imports"), 1);
        assert_eq!(n(&c, "SELECT count(*) FROM catalog_http_cache"), 0, "pages with rejected records are not cached");
        // The same page without the odd record is cached, and a repeat within the run is detected.
        let stats = apply_page(&mut c, page_write(run.run_id, real_records()[1..].to_vec())).unwrap();
        assert_eq!((stats.unchanged, stats.repeated, stats.refused), (1, 1, 0));
        assert_eq!(n(&c, "SELECT count(*) FROM catalog_http_cache"), 1);
    }

    #[test]
    fn slug_collisions_fall_back_to_checked_hashed_suffixes() {
        let mut c = mem();
        let run = begin_run(&mut c, Source::GamePix, 1_000, false).unwrap();
        let template = real_records().remove(0);
        let base = "a".repeat(crate::slug::MAX_SLUG);
        // 51 records with the same maximal base take `base`, `base-2` … `base-50` and one hashed slug.
        let games: Vec<NewGame> = (0..51)
            .map(|i| NewGame { source_id: format!("T{i}"), slug_hint: Some(base.clone()), ..template.clone() })
            .collect();
        assert_eq!(apply_page(&mut c, page_write(run.run_id, games)).unwrap().inserted, 51);
        // Occupy the first hashed candidate of record "X" too.
        let h = Sha256::digest(b"gamepix:X");
        let hashed = format!("{base}-{}", h.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>());
        c.execute("UPDATE games SET slug = ?1 WHERE source_id = 'T50'", [&hashed]).unwrap();
        let slug = unique_slug(&c, &base, Source::GamePix, "X").unwrap();
        assert_eq!(slug, format!("{hashed}-2"));
        assert!(crate::slug::is_valid_slug(&slug) && slug.len() <= crate::slug::MAX_STORED_SLUG);
    }
}
