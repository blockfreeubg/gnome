//! `GET /api/sync/usage` (WAVE-D D20): the account's stored sync bytes and its quota.

use axum::Json;
use axum::extract::State;
use serde::Serialize;

use super::{account_bytes, quotas};
use crate::auth::RequireUser;
use crate::error::ApiError;
use crate::security::ClientInfo;
use crate::state::AppState;

#[derive(Debug, Serialize)]
pub struct Usage {
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub history_bytes: i64,
    pub bookmarks_bytes: i64,
    pub settings_bytes: i64,
}

pub async fn get(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
) -> Result<Json<Usage>, ApiError> {
    super::limit(&state, &client, &u)?;
    let uid = u.user.id;
    let bytes = state.db.read(move |c| account_bytes(c, uid).map_err(ApiError::from)).await?;
    Ok(Json(Usage {
        used_bytes: bytes.total(),
        quota_bytes: quotas(&state).0,
        history_bytes: bytes.history_bytes,
        bookmarks_bytes: bytes.bookmarks_bytes,
        settings_bytes: bytes.settings_bytes,
    }))
}
