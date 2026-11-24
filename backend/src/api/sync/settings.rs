//! `GET/PUT /api/sync/settings` — one JSON document per user with optimistic concurrency.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::auth::RequireUser;
use crate::error::{ApiError, ApiJson, without_position};
use crate::security::ClientInfo;
use crate::state::AppState;
use crate::util::now_ms;

/// Largest settings document.
pub const MAX_SETTINGS_BYTES: usize = 256 * 1024;
/// Request body limit: the document plus the JSON envelope.
pub const BODY_LIMIT: usize = MAX_SETTINGS_BYTES + 4 * 1024;

#[derive(Debug, Deserialize)]
pub struct PutSettings {
    pub data: Box<RawValue>,
    #[serde(default)]
    pub base_updated_at: Option<i64>,
}

#[derive(Serialize)]
struct SettingsDoc<'a> {
    data: Option<&'a RawValue>,
    updated_at: Option<i64>,
}

pub async fn get(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
) -> Result<Response, ApiError> {
    super::limit(&state, &client, &u)?;
    let uid = u.user.id;
    let row: Option<(String, i64)> = state
        .db
        .read(move |c| {
            c.prepare_cached("SELECT data, updated_at FROM user_settings WHERE user_id = ?1")?
                .query_row([uid], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .map_err(ApiError::from)
        })
        .await?;
    let raw = match &row {
        Some((data, _)) => Some(RawValue::from_string(data.clone()).map_err(ApiError::internal_from)?),
        None => None,
    };
    Ok(Json(SettingsDoc { data: raw.as_deref(), updated_at: row.map(|r| r.1) }).into_response())
}

enum Outcome {
    Saved(i64),
    Conflict { data: String, updated_at: i64 },
}

/// Store the document if `base_updated_at` matches the server copy (or the server has none); otherwise
/// `409 conflict` carrying the server copy as top-level `data` / `updated_at`.
pub async fn put(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(body): ApiJson<PutSettings>,
) -> Result<Response, ApiError> {
    super::limit(&state, &client, &u)?;
    let raw = body.data.get();
    if !raw.trim_start().starts_with('{') {
        return Err(ApiError::invalid_field("data", "must be a JSON object"));
    }
    if raw.len() > MAX_SETTINGS_BYTES {
        return Err(ApiError::payload_too_large());
    }
    // Stored verbatim, but it must also load as a `serde_json::Value`: the 409 answer embeds the stored copy, and a
    // document nested deeper than serde_json's 128 levels (or holding an out-of-range number) would turn every later
    // conflict into a 500.
    if let Err(e) = serde_json::from_str::<serde_json::Value>(raw) {
        return Err(ApiError::invalid_field("data", format!("cannot be stored: {}", without_position(&e))));
    }
    let data = raw.to_string();
    let base = body.base_updated_at;
    let uid = u.user.id;
    let now = now_ms();
    let quotas = super::quotas(&state);
    let outcome = state
        .db
        .write(move |c| -> Result<Outcome, ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let before = super::before(&tx, uid)?;
            let current: Option<(String, i64)> = tx
                .prepare_cached("SELECT data, updated_at FROM user_settings WHERE user_id = ?1")?
                .query_row([uid], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            let updated_at = match current {
                Some((cur, at)) if base != Some(at) => return Ok(Outcome::Conflict { data: cur, updated_at: at }),
                Some((_, at)) => now.max(at + 1),
                None => now,
            };
            tx.prepare_cached(
                "INSERT INTO user_settings (user_id, data, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            )?
            .execute(params![uid, data, updated_at])?;
            // D20: dropping `tx` on refusal rolls the write back.
            super::check_growth(quotas, &tx, uid, before)?;
            tx.commit()?;
            Ok(Outcome::Saved(updated_at))
        })
        .await?;
    match outcome {
        Outcome::Saved(updated_at) => Ok(Json(serde_json::json!({ "updated_at": updated_at })).into_response()),
        Outcome::Conflict { data, updated_at } => {
            let data: serde_json::Value = serde_json::from_str(&data).map_err(ApiError::internal_from)?;
            Err(ApiError::conflict("settings were changed on another device; merge and retry")
                .with_extra("data", data)
                .with_extra("updated_at", updated_at.into()))
        }
    }
}
