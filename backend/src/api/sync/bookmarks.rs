//! `GET/POST /api/sync/bookmarks` — last-writer-wins per id on the client's `updated_at`, deletions as tombstones.
//!
//! An uploaded item that loses (the stored copy is newer, or a tie) is *re-announced*: the stored copy gets the
//! batch's `synced_at`, so the next pull of the device that sent the loser returns the winner and the device
//! converges. Without this, a device whose clock runs behind would keep its own edit forever while every other
//! device keeps the winner (its cursor is already past the winner's old `synced_at`).

use axum::Json;
use axum::extract::State;
use axum::response::Response;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::history::{MAX_PAGE, decode_cursor, encode_cursor};
use super::{MAX_BATCH, next_synced_at, sync_clock};
use crate::api::validate::{FieldErrors, check_timestamp, check_title, check_url, is_uuid};
use crate::auth::RequireUser;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::security::ClientInfo;
use crate::state::AppState;
use crate::util::now_ms;

/// Live (non-deleted) bookmarks and folders per account.
pub const MAX_BOOKMARKS_PER_USER: i64 = 20_000;
/// Tombstones are kept this long so offline devices learn about deletions.
pub const TOMBSTONE_RETENTION_MS: i64 = 180 * 24 * 60 * 60 * 1000;
/// Tombstones kept per account; beyond this the oldest are dropped (storage stays bounded however many deletions a
/// client uploads).
pub const MAX_TOMBSTONES_PER_USER: i64 = 50_000;
const MAX_POSITION: f64 = 1e15;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bookmark {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub position: f64,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

/// Query of `GET /api/sync/bookmarks` (D22): keyset-paged like history.
#[derive(Debug, Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub since: Option<i64>,
    /// 1–1000. Without it (an app from before paging) one page that ends on a `synced_at` boundary.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Batch {
    pub items: Vec<Bookmark>,
}

#[derive(Debug, Serialize)]
pub struct Changes {
    pub items: Vec<Bookmark>,
    /// Pass as `cursor` until it is `null` (always `null` without `limit`, D22).
    pub next_cursor: Option<String>,
    /// Pass back as `since` on the next pull.
    pub server_time: i64,
}

#[derive(Debug, Serialize)]
pub struct Applied {
    pub applied: usize,
    pub server_time: i64,
}

/// Changes received after `since` (including tombstones), oldest first.
pub async fn get(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiQuery(q): ApiQuery<PageQuery>,
) -> Result<Response, ApiError> {
    super::limit(&state, &client, &u)?;
    if q.limit.is_some_and(|l| !(1..=MAX_PAGE).contains(&l)) {
        return Err(ApiError::bad_request("limit must be between 1 and 1000"));
    }
    let cursor = match q.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => Some(decode_cursor(c).ok_or_else(|| ApiError::bad_request("invalid cursor"))?),
        None => None,
    };
    let pull = super::begin_pull(&state, &u)?;
    let since = q.since.unwrap_or(0).max(0);
    let uid = u.user.id;
    let limit = q.limit;
    let changes = state.db.read(move |c| page(c, uid, since, limit, cursor)).await?;
    Ok(super::pull_answer(&state, &changes, pull))
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(Bookmark, i64)> {
    Ok((
        Bookmark {
            id: r.get(0)?,
            parent_id: r.get(1)?,
            kind: r.get(2)?,
            title: r.get(3)?,
            url: r.get(4)?,
            position: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
            deleted: r.get(8)?,
        },
        r.get(9)?,
    ))
}

const COLUMNS: &str = "SELECT id, parent_id, kind, title, url, position, created_at, updated_at, deleted, synced_at
                         FROM bookmarks";

/// One page of changes (D22). With `limit`: at most `limit` items or [`super::PAGE_BYTES`] of JSON, then
/// `next_cursor`. Without: whole `synced_at` groups until the JSON reaches [`super::PAGE_BYTES`], with `server_time`
/// at the last group's `synced_at` when more follow, so an old client fetches the rest with `since=`.
fn page(
    c: &rusqlite::Connection,
    uid: i64,
    since: i64,
    limit: Option<u32>,
    cursor: Option<(i64, String)>,
) -> Result<Changes, ApiError> {
    let tx = c.unchecked_transaction()?;
    let clock = sync_clock(&tx, uid)?;
    let (at, id) = match &cursor {
        Some((at, id)) if *at > since => (*at, id.clone()),
        _ => (since, "~".to_string()),
    };
    let mut stmt = tx.prepare_cached(&format!(
        "{COLUMNS} WHERE user_id = ?1 AND (synced_at, id) > (?2, ?3) ORDER BY synced_at, id"
    ))?;
    let mut rows = stmt.query(params![uid, at, id])?;
    let mut items: Vec<Bookmark> = Vec::new();
    let mut bytes = 0usize;
    let mut next_cursor = None;
    let mut server_time = clock;
    let mut last_at = None;
    while let Some(row) = rows.next()? {
        let (b, synced_at) = map_row(row)?;
        match limit {
            Some(limit) => {
                if items.len() == limit as usize || bytes >= super::PAGE_BYTES {
                    next_cursor = last_at.map(|at| encode_cursor(at, &items[items.len() - 1].id));
                    break;
                }
            }
            None => {
                if bytes >= super::PAGE_BYTES && last_at != Some(synced_at) {
                    server_time = last_at.unwrap_or(clock);
                    break;
                }
            }
        }
        bytes += serde_json::to_vec(&b).map_or(0, |v| v.len() + 1);
        last_at = Some(synced_at);
        items.push(b);
    }
    Ok(Changes { items, next_cursor, server_time })
}

fn validate(items: &[Bookmark], now: i64) -> Result<(), ApiError> {
    let mut errors = FieldErrors::default();
    if items.len() > MAX_BATCH {
        errors.add("items", "at most 5000 items per request");
        return errors.into_result();
    }
    for (i, b) in items.iter().enumerate() {
        let f = |name: &str| format!("items[{i}].{name}");
        if !is_uuid(&b.id) {
            errors.add(f("id"), "must be a UUID");
        }
        if let Some(p) = &b.parent_id {
            if !is_uuid(p) {
                errors.add(f("parent_id"), "must be a UUID or null");
            } else if p.eq_ignore_ascii_case(&b.id) {
                errors.add(f("parent_id"), "must not be the item itself");
            }
        }
        errors.check(|| f("created_at"), check_timestamp(b.created_at, now));
        errors.check(|| f("updated_at"), check_timestamp(b.updated_at, now));
        if b.deleted {
            continue;
        }
        match b.kind.as_str() {
            "bookmark" => match &b.url {
                Some(url) => errors.check(|| f("url"), check_url(url)),
                None => errors.add(f("url"), "is required for bookmarks"),
            },
            "folder" => {
                if b.url.as_deref().is_some_and(|u| !u.is_empty()) {
                    errors.add(f("url"), "must be null for folders");
                }
            }
            _ => errors.add(f("kind"), "must be \"bookmark\" or \"folder\""),
        }
        errors.check(|| f("title"), check_title(&b.title));
        if !b.position.is_finite() || b.position.abs() > MAX_POSITION {
            errors.add(f("position"), "must be a finite number");
        }
    }
    errors.into_result()
}

/// Upsert a batch (last writer wins on `updated_at`; ties keep the stored copy, which is then re-announced; see the
/// module docs). Tombstones drop title/url.
pub async fn post(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(batch): ApiJson<Batch>,
) -> Result<Json<Applied>, ApiError> {
    super::limit(&state, &client, &u)?;
    let now = now_ms();
    validate(&batch.items, now)?;
    let uid = u.user.id;
    let items = batch.items;
    let quotas = super::quotas(&state);
    let applied = state
        .db
        .write(move |c| -> Result<Applied, ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before = super::before(&tx, uid)?;
            let synced_at = next_synced_at(&tx, uid, now)?;
            let mut applied = 0;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO bookmarks (user_id, id, parent_id, kind, title, url, position, created_at, updated_at,
                                            deleted, synced_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                     ON CONFLICT (user_id, id) DO UPDATE SET
                        parent_id = excluded.parent_id, kind = excluded.kind, title = excluded.title,
                        url = excluded.url, position = excluded.position, created_at = excluded.created_at,
                        updated_at = excluded.updated_at, deleted = excluded.deleted, synced_at = excluded.synced_at
                     WHERE excluded.updated_at > bookmarks.updated_at",
                )?;
                let mut reannounce = tx.prepare_cached(
                    "UPDATE bookmarks SET synced_at = ?3 WHERE user_id = ?1 AND id = ?2 AND synced_at < ?3",
                )?;
                for b in &items {
                    let kind = if b.kind == "folder" { "folder" } else { "bookmark" };
                    let (title, url) = if b.deleted {
                        ("", None)
                    } else if kind == "folder" {
                        (b.title.as_str(), None)
                    } else {
                        (b.title.as_str(), b.url.as_deref())
                    };
                    let changed = stmt.execute(params![
                        uid,
                        b.id,
                        b.parent_id,
                        kind,
                        title,
                        url,
                        b.position,
                        b.created_at,
                        b.updated_at,
                        b.deleted,
                        synced_at
                    ])?;
                    if changed == 0 {
                        reannounce.execute(params![uid, b.id, synced_at])?;
                    }
                    applied += changed;
                }
            }
            // Two covering index scans (all rows, tombstones only) instead of reading every row's `deleted`.
            let (total, tombstones): (i64, i64) = tx.query_row(
                "SELECT (SELECT count(*) FROM bookmarks WHERE user_id = ?1),
                        (SELECT count(*) FROM bookmarks WHERE user_id = ?1 AND deleted = 1)",
                [uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let live = total - tombstones;
            if live > MAX_BOOKMARKS_PER_USER {
                return Err(ApiError::invalid_field("items", "bookmark limit reached (20000 per account)"));
            }
            if tombstones > MAX_TOMBSTONES_PER_USER {
                tx.execute(
                    "DELETE FROM bookmarks WHERE pk IN
                       (SELECT pk FROM bookmarks WHERE user_id = ?1 AND deleted = 1 ORDER BY synced_at, pk LIMIT ?2)",
                    params![uid, tombstones - MAX_TOMBSTONES_PER_USER],
                )?;
            }
            // D20: a batch that grew the account past its quota (or the server past its cap) is rolled back whole.
            super::check_growth(quotas, &tx, uid, before)?;
            tx.commit()?;
            Ok(Applied { applied, server_time: synced_at })
        })
        .await?;
    Ok(Json(applied))
}

/// Delete tombstones received before `cutoff` (daily job).
pub fn purge_tombstones(conn: &Connection, cutoff: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM bookmarks WHERE deleted = 1 AND synced_at < ?1", [cutoff])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bm(id: &str) -> Bookmark {
        Bookmark {
            id: id.into(),
            parent_id: None,
            kind: "bookmark".into(),
            title: "t".into(),
            url: Some("https://example.com".into()),
            position: 1.0,
            created_at: 1,
            updated_at: 2,
            deleted: false,
        }
    }

    const ID: &str = "3f2c8a3e-5b1d-4c7e-9f00-123456789abc";

    #[test]
    fn validation_rules() {
        let now = 10_000;
        assert!(validate(&[bm(ID)], now).is_ok());
        let mut folder = bm(ID);
        folder.kind = "folder".into();
        folder.url = None;
        assert!(validate(&[folder.clone()], now).is_ok());
        folder.url = Some("https://x.example".into());
        assert!(validate(&[folder], now).is_err());
        let mut js = bm(ID);
        js.url = Some("javascript:alert(1)".into());
        let err = validate(&[js], now).unwrap_err();
        assert!(err.fields().unwrap().contains_key("items[0].url"));
        let mut tomb = bm(ID);
        tomb.deleted = true;
        tomb.url = None;
        tomb.kind = "whatever".into();
        assert!(validate(&[tomb], now).is_ok(), "tombstones only need id + timestamps");
        let mut future = bm(ID);
        future.updated_at = now + crate::api::validate::MAX_CLOCK_SKEW_MS + 1;
        assert!(validate(&[future], now).is_err());
        let mut nan = bm(ID);
        nan.position = f64::NAN;
        assert!(validate(&[nan], now).is_err());
        let mut selfparent = bm(ID);
        selfparent.parent_id = Some(ID.to_uppercase());
        assert!(validate(&[selfparent], now).is_err());
        let too_many = vec![bm(ID); MAX_BATCH + 1];
        assert!(validate(&too_many, now).is_err());
    }
}
