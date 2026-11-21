//! `GET/POST/DELETE /api/sync/history` (used only when the user turned on history sync).
//!
//! Deletions propagate through `cleared_before`: `DELETE` removes the server copy and records the cutoff; pulls
//! return it so other devices delete their local entries before it, and uploads of older entries are ignored.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use super::{MAX_BATCH, next_synced_at, sync_clock};
use crate::api::validate::{FieldErrors, check_timestamp, check_title, check_url, is_uuid};
use crate::auth::RequireUser;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::security::ClientInfo;
use crate::security::crypto::{b64url, b64url_decode};
use crate::state::AppState;
use crate::util::now_ms;

/// Entries kept per account (oldest visits are dropped beyond this).
pub const MAX_HISTORY_PER_USER: i64 = 100_000;
pub const DEFAULT_PAGE: u32 = 500;
pub const MAX_PAGE: u32 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    pub visited_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub items: Vec<HistoryEntry>,
    pub next_cursor: Option<String>,
    /// High-water mark: once `next_cursor` is null, pass this as `since` on the next pull.
    pub server_time: i64,
    /// Entries visited before this were deleted by the user; drop local copies older than it.
    pub cleared_before: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct Batch {
    pub items: Vec<HistoryEntry>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteRequest {
    #[serde(default)]
    pub before: Option<i64>,
    #[serde(default)]
    pub all: Option<bool>,
}

fn encode_cursor(synced_at: i64, id: &str) -> String {
    b64url(format!("{synced_at}:{id}").as_bytes())
}

fn decode_cursor(cursor: &str) -> Option<(i64, String)> {
    let raw = String::from_utf8(b64url_decode(cursor)?).ok()?;
    let (at, id) = raw.split_once(':')?;
    let at: i64 = at.parse().ok()?;
    (at >= 0 && is_uuid(id)).then(|| (at, id.to_string()))
}

fn cleared_before(conn: &Connection, user_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.prepare_cached("SELECT history_cleared_before FROM users WHERE id = ?1")?
        .query_row([user_id], |r| r.get(0))
        .optional()
        .map(Option::flatten)
}

/// Entries received after `since`, oldest first, keyset-paged by `(synced_at, id)`.
pub async fn get(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiQuery(q): ApiQuery<PageQuery>,
) -> Result<Json<Page>, ApiError> {
    super::limit(&state, &client, &u)?;
    let limit = q.limit.unwrap_or(DEFAULT_PAGE);
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(ApiError::bad_request("limit must be between 1 and 1000"));
    }
    let cursor = match q.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(c) => Some(decode_cursor(c).ok_or_else(|| ApiError::bad_request("invalid cursor"))?),
        None => None,
    };
    let since = q.since.unwrap_or(0).max(0);
    let uid = u.user.id;
    let page = state
        .db
        .read(move |c| -> Result<Page, ApiError> {
            let tx = c.unchecked_transaction()?;
            let fetch = i64::from(limit) + 1;
            let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<(HistoryEntry, i64)> {
                Ok((HistoryEntry { id: r.get(0)?, url: r.get(1)?, title: r.get(2)?, visited_at: r.get(3)? }, r.get(4)?))
            };
            let mut rows: Vec<(HistoryEntry, i64)> = match &cursor {
                // The row value alone bounds the index range, so a page seeks straight to the cursor instead of
                // re-reading everything after `since`. `since` is folded in: `(since, "~")` is past every id with
                // that `synced_at` ('~' sorts after all UUID characters).
                Some((at, id)) => {
                    let (at, id) = if *at > since { (*at, id.as_str()) } else { (since, "~") };
                    tx.prepare_cached(
                        "SELECT id, url, title, visited_at, synced_at FROM history
                          WHERE user_id = ?1 AND (synced_at, id) > (?2, ?3)
                          ORDER BY synced_at, id LIMIT ?4",
                    )?
                    .query_map(params![uid, at, id, fetch], map)?
                    .collect::<Result<_, _>>()?
                }
                None => tx
                    .prepare_cached(
                        "SELECT id, url, title, visited_at, synced_at FROM history
                          WHERE user_id = ?1 AND synced_at > ?2 ORDER BY synced_at, id LIMIT ?3",
                    )?
                    .query_map(params![uid, since, fetch], map)?
                    .collect::<Result<_, _>>()?,
            };
            let more = rows.len() > limit as usize;
            rows.truncate(limit as usize);
            let next_cursor = if more { rows.last().map(|(e, at)| encode_cursor(*at, &e.id)) } else { None };
            // The clock itself, never `since` (see bookmarks::get).
            let server_time = sync_clock(&tx, uid)?;
            let cleared_before = cleared_before(&tx, uid)?;
            Ok(Page { items: rows.into_iter().map(|(e, _)| e).collect(), next_cursor, server_time, cleared_before })
        })
        .await?;
    Ok(Json(page))
}

fn validate(items: &[HistoryEntry], now: i64) -> Result<(), ApiError> {
    let mut errors = FieldErrors::default();
    if items.len() > MAX_BATCH {
        errors.add("items", "at most 5000 items per request");
        return errors.into_result();
    }
    for (i, e) in items.iter().enumerate() {
        let f = |name: &str| format!("items[{i}].{name}");
        if !is_uuid(&e.id) {
            errors.add(f("id"), "must be a UUID");
        }
        errors.check(|| f("url"), check_url(&e.url));
        if let Some(t) = &e.title {
            errors.check(|| f("title"), check_title(t));
        }
        errors.check(|| f("visited_at"), check_timestamp(e.visited_at, now));
    }
    errors.into_result()
}

/// Upsert entries (new ids are inserted; known ids are updated if anything changed).
pub async fn post(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(batch): ApiJson<Batch>,
) -> Result<Json<serde_json::Value>, ApiError> {
    super::limit(&state, &client, &u)?;
    let now = now_ms();
    validate(&batch.items, now)?;
    let uid = u.user.id;
    let items = batch.items;
    let applied = state
        .db
        .write(move |c| -> Result<usize, ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let cutoff = cleared_before(&tx, uid)?.unwrap_or(i64::MIN);
            let synced_at = next_synced_at(&tx, uid, now)?;
            let mut applied = 0;
            {
                let mut stmt = tx.prepare_cached(
                    "INSERT INTO history (user_id, id, url, title, visited_at, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (user_id, id) DO UPDATE SET
                        url = excluded.url, title = excluded.title, visited_at = excluded.visited_at,
                        synced_at = excluded.synced_at
                     WHERE excluded.url != history.url OR excluded.title IS NOT history.title
                        OR excluded.visited_at != history.visited_at",
                )?;
                for e in items.iter().filter(|e| e.visited_at >= cutoff) {
                    applied += stmt.execute(params![uid, e.id, e.url, e.title, e.visited_at, synced_at])?;
                }
            }
            let count: i64 = tx.query_row("SELECT count(*) FROM history WHERE user_id = ?1", [uid], |r| r.get(0))?;
            if count > MAX_HISTORY_PER_USER {
                tx.execute(
                    "DELETE FROM history WHERE pk IN
                       (SELECT pk FROM history WHERE user_id = ?1 ORDER BY visited_at, pk LIMIT ?2)",
                    params![uid, count - MAX_HISTORY_PER_USER],
                )?;
            }
            tx.commit()?;
            Ok(applied)
        })
        .await?;
    Ok(Json(serde_json::json!({ "applied": applied })))
}

/// Delete entries visited before `before`, or everything with `{"all": true}`.
pub async fn delete(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(req): ApiJson<DeleteRequest>,
) -> Result<Response, ApiError> {
    super::limit(&state, &client, &u)?;
    let now = now_ms();
    let all = req.all == Some(true);
    let before = match (all, req.before) {
        (true, None) => None,
        (false, Some(b)) => {
            check_timestamp(b, now).map_err(|m| ApiError::invalid_field("before", m))?;
            Some(b)
        }
        _ => return Err(ApiError::bad_request("send either {\"before\": ms} or {\"all\": true}")),
    };
    let uid = u.user.id;
    state
        .db
        .write(move |c| -> Result<(), ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let cutoff = match before {
                Some(b) => {
                    tx.execute("DELETE FROM history WHERE user_id = ?1 AND visited_at < ?2", params![uid, b])?;
                    b
                }
                None => {
                    tx.execute("DELETE FROM history WHERE user_id = ?1", [uid])?;
                    now
                }
            };
            tx.execute(
                "UPDATE users SET history_cleared_before = max(COALESCE(history_cleared_before, 0), ?2) WHERE id = ?1",
                params![uid, cutoff],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip_and_rejects_garbage() {
        let id = "3f2c8a3e-5b1d-4c7e-9f00-123456789abc";
        let c = encode_cursor(1234, id);
        assert_eq!(decode_cursor(&c), Some((1234, id.to_string())));
        assert_eq!(decode_cursor("!!!"), None);
        assert_eq!(decode_cursor(&b64url(b"12:not-a-uuid")), None);
        assert_eq!(decode_cursor(&b64url(b"-5:3f2c8a3e-5b1d-4c7e-9f00-123456789abc")), None);
    }

    #[test]
    fn validation_rules() {
        let ok = HistoryEntry {
            id: "3f2c8a3e-5b1d-4c7e-9f00-123456789abc".into(),
            url: "https://example.com/a".into(),
            title: Some("A".into()),
            visited_at: 5,
        };
        assert!(validate(std::slice::from_ref(&ok), 10).is_ok());
        let mut bad = ok.clone();
        bad.url = "chrome://settings".into();
        bad.id = "x".into();
        let err = validate(&[bad], 10).unwrap_err();
        let fields = err.fields().unwrap();
        assert!(fields.contains_key("items[0].url") && fields.contains_key("items[0].id"));
    }
}
