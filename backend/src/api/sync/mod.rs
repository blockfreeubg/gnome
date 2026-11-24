//! `/api/sync/*`: the server mirrors data owned by the client (local-first). All routes require `gnome_auth` and
//! are rate limited per IP and per session ([`RateClass::Sync`]).
//!
//! `since` cursors use the server-assigned `synced_at`, taken from the per-user sync clock (`users.sync_clock`), so a
//! device never misses a change that another device uploaded late with an old client timestamp, and deletions or a
//! wall clock stepping backwards cannot make a new write look older than a cursor a device already holds.

pub mod bookmarks;
pub mod history;
pub mod settings;
pub mod usage;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use http::StatusCode;
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
        .route("/api/sync/usage", get(usage::get))
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

/// Stored sync bytes of one account (WAVE-D D20; kept by the triggers of migration 2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct AccountBytes {
    pub history_bytes: i64,
    pub bookmarks_bytes: i64,
    pub settings_bytes: i64,
}

impl AccountBytes {
    pub fn total(self) -> i64 {
        self.history_bytes + self.bookmarks_bytes + self.settings_bytes
    }
}

pub(crate) fn account_bytes(conn: &Connection, user_id: i64) -> rusqlite::Result<AccountBytes> {
    conn.prepare_cached("SELECT sync_history_bytes, sync_bookmark_bytes, sync_settings_bytes FROM users WHERE id = ?1")?
        .query_row([user_id], |r| {
            Ok(AccountBytes { history_bytes: r.get(0)?, bookmarks_bytes: r.get(1)?, settings_bytes: r.get(2)? })
        })
}

/// Stored sync bytes of every account together.
pub(crate) fn server_bytes(conn: &Connection) -> rusqlite::Result<i64> {
    conn.prepare_cached("SELECT bytes FROM sync_totals WHERE id = 1")?.query_row([], |r| r.get(0))
}

/// `(account quota, server cap)` in bytes.
pub(crate) fn quotas(state: &AppState) -> (i64, i64) {
    let mib = |m: u32| i64::from(m) * 1024 * 1024;
    (mib(state.config.sync_quota_mb), mib(state.config.sync_total_mb))
}

/// The sizes before a write, to tell whether it grew them.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Before {
    pub account: i64,
    pub server: i64,
}

pub(crate) fn before(conn: &Connection, user_id: i64) -> rusqlite::Result<Before> {
    Ok(Before { account: account_bytes(conn, user_id)?.total(), server: server_bytes(conn)? })
}

/// Error code (413): a write would grow the account's (`scope: "account"`) or the server's (`scope: "server"`)
/// sync storage past its quota.
pub const QUOTA_EXCEEDED: &str = "quota_exceeded";

pub(crate) fn quota_exceeded(scope: &'static str, used: i64, quota: i64) -> ApiError {
    let message = match scope {
        "server" => "this server's sync storage is full",
        _ => "sync storage for this account is full",
    };
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, QUOTA_EXCEEDED, message)
        .with_extra("scope", serde_json::Value::from(scope))
        .with_extra("used_bytes", serde_json::Value::from(used))
        .with_extra("quota_bytes", serde_json::Value::from(quota))
}

/// After a bookmark or settings write inside its transaction: refuse it (the caller rolls back) when it grew the
/// account past its quota or the server past its cap. A write that does not grow a total always passes, so an
/// account over a lowered quota can shrink.
pub(crate) fn check_growth(
    state_quotas: (i64, i64),
    conn: &Connection,
    user_id: i64,
    before: Before,
) -> Result<(), ApiError> {
    let (quota, cap) = state_quotas;
    let account = account_bytes(conn, user_id)?.total();
    if account > quota && account > before.account {
        return Err(quota_exceeded("account", account, quota));
    }
    check_server_growth(cap, conn, before)
}

pub(crate) fn check_server_growth(cap: i64, conn: &Connection, before: Before) -> Result<(), ApiError> {
    let server = server_bytes(conn)?;
    if server > cap && server > before.server {
        return Err(quota_exceeded("server", server, cap));
    }
    Ok(())
}

/// A sync pull's page ends once its JSON reaches this size (D22), whatever its `limit`.
pub const PAGE_BYTES: usize = 1024 * 1024;

/// One concurrent pull of this account (at most [`crate::limits::PULLS_PER_ACCOUNT`]), else `503`.
pub(crate) fn begin_pull(state: &AppState, user: &CurrentUser) -> Result<crate::limits::PullGuard, ApiError> {
    state.limits.pull(user.user.id).ok_or_else(|| crate::limits::too_many_pulls(state))
}

/// Serialize a pull's answer and send it under the answer budget ([`crate::limits::sync_answer`]).
pub(crate) fn pull_answer<T: serde::Serialize>(
    state: &AppState,
    value: &T,
    pull: crate::limits::PullGuard,
) -> axum::response::Response {
    match serde_json::to_vec(value) {
        Ok(body) => crate::limits::sync_answer(state, body, pull),
        Err(e) => axum::response::IntoResponse::into_response(ApiError::internal_from(e)),
    }
}
