//! Accounts: `/api/auth/{register,login,logout,password,me,account}` (mounted only when accounts are enabled).

use std::time::Instant;

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode, header};
use rusqlite::TransactionBehavior;
use serde::Deserialize;
use serde_json::json;

use crate::auth::cookies::{self, SessionCookie};
use crate::auth::extract::{cookies_secure, user_session_tokens};
use crate::auth::password::{PASSWORD_MAX, validate_password, validate_username};
use crate::auth::sessions::{self, NewSession, SESSION_TTL_MS};
use crate::auth::users::{self, InsertError, UserRecord};
use crate::auth::{MaybeAnon, RequireUser};
use crate::config::AccessMode;
use crate::error::{ApiError, ApiJson};
use crate::security::ClientInfo;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;
use crate::util::now_ms;

#[derive(Debug, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct PasswordChange {
    pub current: String,
    pub next: String,
}

#[derive(Debug, Deserialize)]
pub struct AccountDeletion {
    pub password: String,
}

fn invalid_credentials() -> ApiError {
    ApiError::unauthorized("invalid credentials")
}

fn with_auth_cookie(mut res: Response, state: &AppState, client: &ClientInfo, session: &NewSession) -> Response {
    let secure = cookies_secure(state, client);
    let max_age = u64::try_from(SESSION_TTL_MS / 1000).unwrap_or(0);
    let cookie = cookies::set(SessionCookie::User.name(secure), &session.token, max_age, secure);
    res.headers_mut().append(header::SET_COOKIE, cookie);
    res
}

fn clear_auth_cookie(state: &AppState, client: &ClientInfo) -> Response {
    let secure = cookies_secure(state, client);
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().append(header::SET_COOKIE, cookies::clear(SessionCookie::User.name(secure), secure));
    res
}

/// Start a password check for `username` under the per-username backoff (the attempt counts as a failure until
/// [`LoginBackoff::succeeded`](crate::auth::backoff::LoginBackoff::succeeded)); `429` while the name is locked.
fn begin_attempt(state: &AppState, username: &str) -> Result<(), ApiError> {
    state.backoff.begin(username, Instant::now()).map_err(ApiError::rate_limited)
}

/// Verify `password` for `record`, applying the per-username backoff. Wrong password → `wrong()`. Returns whether
/// the stored hash should be upgraded.
async fn verify_with_backoff(
    state: &AppState,
    record: &UserRecord,
    password: String,
    wrong: fn() -> ApiError,
) -> Result<bool, ApiError> {
    begin_attempt(state, &record.user.username)?;
    let v = state.passwords.verify(password, record.password_hash.clone()).await?;
    if !v.ok {
        return Err(wrong());
    }
    state.backoff.succeeded(&record.user.username);
    Ok(v.needs_rehash)
}

pub async fn register(
    State(state): State<AppState>,
    client: ClientInfo,
    MaybeAnon(anon): MaybeAnon,
    ApiJson(body): ApiJson<Credentials>,
) -> Result<Response, ApiError> {
    enforce(&state, RateClass::Auth, client.ip, None)?;
    if !state.config.registration_open() {
        return Err(ApiError::forbidden("registration is closed on this server"));
    }
    if state.config.access_mode == AccessMode::Code && anon.is_none() {
        return Err(ApiError::access_code_required("enter the access code before creating an account"));
    }
    let mut fields = std::collections::BTreeMap::new();
    if let Err(e) = validate_username(&body.username) {
        fields.insert("username".to_string(), e.to_string());
    }
    if let Err(e) = validate_password(&body.password) {
        fields.insert("password".to_string(), e.to_string());
    }
    if !fields.is_empty() {
        return Err(ApiError::validation(fields));
    }
    let hash = state.passwords.hash(body.password).await?;
    let now = now_ms();
    let username = body.username;
    let (user, session) = state
        .db
        .write(move |c| {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let user = match users::insert(&tx, &username, &hash, false, now) {
                Ok(u) => u,
                Err(InsertError::UsernameTaken) => return Err(ApiError::conflict("that username is taken")),
                Err(InsertError::Sqlite(e)) => return Err(e.into()),
            };
            let session = sessions::create(&tx, user.id, now)?;
            users::record_login(&tx, user.id, now)?;
            tx.commit()?;
            Ok((user, session))
        })
        .await?;
    tracing::info!(user_id = user.id, "account registered");
    let res = (StatusCode::CREATED, Json(json!({ "user": user }))).into_response();
    Ok(with_auth_cookie(res, &state, &client, &session))
}

pub async fn login(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(body): ApiJson<Credentials>,
) -> Result<Response, ApiError> {
    enforce(&state, RateClass::Auth, client.ip, None)?;
    // Names that cannot exist and absurd passwords fail fast (the rules are public, so this reveals nothing).
    if validate_username(&body.username).is_err()
        || body.password.is_empty()
        || body.password.chars().count() > PASSWORD_MAX
    {
        return Err(invalid_credentials());
    }
    // Counted before the lookup, so unknown names are throttled exactly like real ones.
    begin_attempt(&state, &body.username)?;
    let name = body.username.clone();
    let record = state.db.read(move |c| users::find_by_username(c, &name).map_err(ApiError::from)).await?;
    let Some(record) = record else {
        // Same cost as a real verification so timing does not reveal which usernames exist.
        state.passwords.verify_dummy(body.password).await?;
        return Err(invalid_credentials());
    };
    let v = state.passwords.verify(body.password.clone(), record.password_hash.clone()).await?;
    if !v.ok {
        return Err(invalid_credentials());
    }
    state.backoff.succeeded(&record.user.username);
    let new_hash = if v.needs_rehash { Some(state.passwords.hash(body.password).await?) } else { None };
    let now = now_ms();
    let uid = record.user.id;
    let session = state
        .db
        .write(move |c| -> Result<NewSession, ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(h) = &new_hash {
                users::set_password(&tx, uid, h, now)?;
            }
            let session = sessions::create(&tx, uid, now)?;
            users::record_login(&tx, uid, now)?;
            tx.commit()?;
            Ok(session)
        })
        .await?;
    let res = Json(json!({ "user": record.user })).into_response();
    Ok(with_auth_cookie(res, &state, &client, &session))
}

/// Ends the current user session (idempotent). Every `gnome_auth` value the browser sent is revoked.
pub async fn logout(
    State(state): State<AppState>,
    client: ClientInfo,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let hashes: Vec<_> =
        user_session_tokens(&headers, cookies_secure(&state, &client)).into_iter().map(|(_, hash)| hash).collect();
    if !hashes.is_empty() {
        state
            .db
            .write(move |c| -> Result<(), ApiError> {
                for hash in &hashes {
                    sessions::delete(c, hash)?;
                }
                Ok(())
            })
            .await?;
    }
    Ok(clear_auth_cookie(&state, &client))
}

pub async fn me(RequireUser(u): RequireUser) -> Json<serde_json::Value> {
    Json(json!({ "user": u.user }))
}

/// Change the password; every other session of the user is revoked.
pub async fn change_password(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(body): ApiJson<PasswordChange>,
) -> Result<StatusCode, ApiError> {
    enforce(&state, RateClass::Auth, client.ip, None)?;
    if let Err(e) = validate_password(&body.next) {
        return Err(ApiError::invalid_field("next", e));
    }
    let uid = u.user.id;
    let record = state
        .db
        .read(move |c| users::find_by_id(c, uid).map_err(ApiError::from))
        .await?
        .ok_or_else(|| ApiError::unauthorized("sign in required"))?;
    verify_with_backoff(&state, &record, body.current, || ApiError::invalid_field("current", "is incorrect")).await?;
    let hash = state.passwords.hash(body.next).await?;
    let now = now_ms();
    let keep = u.token_hash;
    let revoked = state
        .db
        .write(move |c| -> Result<usize, ApiError> {
            let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
            users::set_password(&tx, uid, &hash, now)?;
            let revoked = sessions::delete_others(&tx, uid, &keep)?;
            tx.commit()?;
            Ok(revoked)
        })
        .await?;
    tracing::info!(user_id = uid, revoked_sessions = revoked, "password changed");
    Ok(StatusCode::NO_CONTENT)
}

/// Delete the account and all synced data (requires the password).
pub async fn delete_account(
    State(state): State<AppState>,
    client: ClientInfo,
    RequireUser(u): RequireUser,
    ApiJson(body): ApiJson<AccountDeletion>,
) -> Result<Response, ApiError> {
    enforce(&state, RateClass::Auth, client.ip, None)?;
    let uid = u.user.id;
    let record = state
        .db
        .read(move |c| users::find_by_id(c, uid).map_err(ApiError::from))
        .await?
        .ok_or_else(|| ApiError::unauthorized("sign in required"))?;
    verify_with_backoff(&state, &record, body.password, || ApiError::invalid_field("password", "is incorrect")).await?;
    state.db.write(move |c| users::delete(c, uid).map_err(ApiError::from)).await?;
    tracing::info!(user_id = uid, "account deleted");
    Ok(clear_auth_cookie(&state, &client))
}
