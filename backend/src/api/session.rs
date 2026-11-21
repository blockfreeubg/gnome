//! `POST /api/session` and `GET /api/session`.

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::header;
use serde::Deserialize;
use serde_json::json;

use crate::auth::anon::ANON_TTL_S;
use crate::auth::cookies::{self, SessionCookie};
use crate::auth::extract::cookies_secure;
use crate::auth::{MaybeAnon, MaybeUser};
use crate::config::AccessMode;
use crate::error::{ApiError, OptionalJson};
use crate::security::ClientInfo;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;
use crate::util::now_s;

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    #[serde(default)]
    pub access_code: Option<String>,
}

/// Create or refresh the anonymous session (`gnome_sid`). `code` mode needs `access_code` unless the existing
/// session is still valid; `accounts` mode needs a signed-in user and issues no anonymous session.
pub async fn create_session(
    State(state): State<AppState>,
    client: ClientInfo,
    MaybeAnon(anon): MaybeAnon,
    MaybeUser(user): MaybeUser,
    OptionalJson(body): OptionalJson<CreateSession>,
) -> Result<Response, ApiError> {
    enforce(&state, RateClass::SessionCreate, client.ip, None)?;
    match state.config.access_mode {
        AccessMode::Accounts => {
            let u = user.ok_or_else(ApiError::login_required)?;
            return Ok(
                Json(json!({"session": {"kind": "user", "expires_at": u.expires_at, "user": u.user}})).into_response()
            );
        }
        AccessMode::Code if anon.is_none() => {
            let code = body.and_then(|b| b.access_code).unwrap_or_default();
            let code = code.trim();
            if code.is_empty() {
                return Err(ApiError::access_code_required("an access code is required"));
            }
            let valid = state.config.access_code.as_ref().is_some_and(|expected| expected.matches(code.as_bytes()));
            if !valid {
                tracing::debug!("rejected access code");
                return Err(ApiError::access_code_required("invalid access code"));
            }
        }
        AccessMode::Code | AccessMode::Open => {}
    }
    let (token, session) = state.anon_key.issue(anon.as_ref().map(|a| a.id.as_str()), now_s());
    let secure = cookies_secure(&state, &client);
    let mut res = Json(json!({
        "session": {"kind": "anonymous", "expires_at": session.expires_at_ms(), "user": null}
    }))
    .into_response();
    let cookie = cookies::set(SessionCookie::Anonymous.name(secure), &token, ANON_TTL_S, secure);
    res.headers_mut().append(header::SET_COOKIE, cookie);
    Ok(res)
}

/// Current session. `proxy` tells whether the cookies authorize use of the proxy (`/wisp/`) under the current
/// access mode (the same rule as [`crate::auth::proxy_session`]).
pub async fn get_session(
    State(state): State<AppState>,
    MaybeAnon(anon): MaybeAnon,
    MaybeUser(user): MaybeUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let accounts_mode = state.config.access_mode == AccessMode::Accounts;
    let proxy = if accounts_mode { user.is_some() } else { anon.is_some() };
    if let Some(u) = user {
        return Ok(Json(json!({
            "session": {"kind": "user", "expires_at": u.expires_at, "user": u.user, "proxy": proxy}
        })));
    }
    match anon {
        Some(a) if !accounts_mode => Ok(Json(json!({
            "session": {"kind": "anonymous", "expires_at": a.expires_at_ms(), "user": null, "proxy": proxy}
        }))),
        _ => Err(ApiError::unauthorized("no session")),
    }
}
