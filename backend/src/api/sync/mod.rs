//! `/api/sync/*`: the server mirrors data owned by the client (local-first). All routes require `gnome_auth` and
//! are rate limited per IP and per session ([`RateClass::Sync`]).
//!
//! `since` cursors use the server-assigned `synced_at`, taken from the per-user sync clock (`users.sync_clock`), so a
//! device never misses a change that another device uploaded late with an old client timestamp, and deletions or a
//! wall clock stepping backwards cannot make a new write look older than a cursor a device already holds.

pub mod bookmarks;
pub mod history;
pub mod settings;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use rusqlite::{Connection, params};

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::router::SYNC_BODY_LIMIT;
use crate::security::ClientInfo;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;

/// Most items accepted by one batch upload.
pub const MAX_BATCH: usize = 5000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sync/settings",
            get(settings::get).put(settings::put).layer(DefaultBodyLimit::max(settings::BODY_LIMIT)),
        )
        .route(
            "/api/sync/bookmarks",
            get(bookmarks::get).post(bookmarks::post).layer(DefaultBodyLimit::max(SYNC_BODY_LIMIT)),
        )
        .route(
            "/api/sync/history",
            get(history::get).post(history::post).delete(history::delete).layer(DefaultBodyLimit::max(SYNC_BODY_LIMIT)),
        )
}

pub(crate) fn limit(state: &AppState, client: &ClientInfo, user: &CurrentUser) -> Result<(), ApiError> {
    enforce(state, RateClass::Sync, client.ip, Some(user.session_key()))
}

/// Advance the user's sync clock and return the `synced_at` for one write batch: at least `now` and strictly
/// greater than every value handed out before. Call inside the write transaction.
pub(crate) fn next_synced_at(conn: &Connection, user_id: i64, now: i64) -> rusqlite::Result<i64> {
    let clock = sync_clock(conn, user_id)?;
    let next = now.max(clock.saturating_add(1));
    conn.prepare_cached("UPDATE users SET sync_clock = ?2 WHERE id = ?1")?.execute(params![user_id, next])?;
    Ok(next)
}

/// The user's sync clock: every row visible in this snapshot has `synced_at` ≤ it, and later writes get larger
/// values, so it is the `server_time` a pull hands back as the next `since`.
pub(crate) fn sync_clock(conn: &Connection, user_id: i64) -> rusqlite::Result<i64> {
    conn.prepare_cached("SELECT sync_clock FROM users WHERE id = ?1")?.query_row([user_id], |r| r.get(0))
}
