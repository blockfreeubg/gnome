//! Session extractors for handlers, plus [`proxy_session`] for modules that gate proxy access (the Wisp gateway).
//!
//! * [`MaybeUser`] / [`RequireUser`] resolve `gnome_auth` (one indexed read; the sliding-expiry write happens at
//!   most once per hour per session and re-issues the cookie through the [`CookieSink`]).
//! * [`MaybeAnon`] verifies `gnome_sid` (no I/O).
//!
//! Cookie names depend on the request's scheme (`__Host-` prefix when Secure, see [`cookies`]). When a browser sends
//! several values for one cookie name (another host or path tossed one), each is tried in order and the first valid
//! session wins, so a planted garbage cookie cannot sign the user out.
//!
//! Resolution results are cached in request extensions, so using several extractors costs one lookup.

use std::sync::{Arc, Mutex};

use axum::extract::FromRequestParts;
use axum::response::Response;
use http::request::Parts;
use http::{HeaderMap, HeaderValue, header};

use super::anon::AnonToken;
use super::cookies::{self, SessionCookie};
use super::sessions::{self, SESSION_TTL_MS, SessionRow, TokenHash};
use super::users::User;
use crate::config::{AccessMode, CookieSecure};
use crate::error::ApiError;
use crate::origins;
use crate::security::{ClientInfo, SessionKey};
use crate::state::AppState;
use crate::util::{now_ms, now_s};

/// Collects `Set-Cookie` values produced while handling a request (e.g. a refreshed `gnome_auth`); the API
/// middleware appends them to the response unless the handler already set the same cookie.
#[derive(Debug, Clone, Default)]
pub struct CookieSink(Arc<Mutex<Vec<HeaderValue>>>);

impl CookieSink {
    pub fn push(&self, value: HeaderValue) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(value);
    }

    pub fn apply(&self, res: &mut Response) {
        let pending = std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()));
        for value in pending {
            let name = cookies::set_cookie_name(&value).map(str::to_string);
            let already = res
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .any(|v| cookies::set_cookie_name(v).map(str::to_string) == name);
            if !already {
                res.headers_mut().append(header::SET_COOKIE, value);
            }
        }
    }
}

/// A signed-in user session.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub user: User,
    pub token_hash: TokenHash,
    /// Unix ms.
    pub expires_at: i64,
}

impl CurrentUser {
    /// Key for per-session limits and connection caps.
    pub fn session_key(&self) -> SessionKey {
        SessionKey::derive(&self.token_hash)
    }
}

#[derive(Clone)]
struct ResolvedUser(Option<CurrentUser>);

/// Whether cookies on this request are `Secure` (and therefore use the `__Host-` names). `GNOME_COOKIE_SECURE=auto`:
/// over HTTPS, and also over plain HTTP when the app origin the request was addressed to is a loopback one
/// (`http://127.0.0.1:…`, `http://localhost:…`), where browsers accept `Secure` cookies too, so the two-port
/// development setup uses the production cookie names (spike §11.3 item 4).
pub fn cookies_secure(state: &AppState, client: &ClientInfo) -> bool {
    match state.config.cookie_secure {
        CookieSecure::Auto if !client.https => {
            origins::app_origin(&state.config, client).is_some_and(|o| origins::loopback_http(&o))
        }
        mode => cookies::secure_for(mode, client),
    }
}

/// Well-formed `gnome_auth` tokens on the request, with their hashes (at most a few; see the module docs).
pub fn user_session_tokens(headers: &HeaderMap, secure: bool) -> Vec<(&str, TokenHash)> {
    cookies::values(headers, SessionCookie::User.name(secure))
        .into_iter()
        .filter_map(|token| sessions::hash_token(token).map(|hash| (token, hash)))
        .collect()
}

/// Resolve `gnome_auth` from request headers. With a `sink`, refreshes the sliding expiry when due and re-issues the
/// cookie into it; without one (e.g. the Wisp gateway, outside `/api/`) nothing is written, so the stored expiry and
/// the browser's cookie always move together. Returns `None` when accounts are disabled or the cookie is absent,
/// malformed, unknown or expired.
pub async fn resolve_user(
    state: &AppState,
    headers: &HeaderMap,
    client: &ClientInfo,
    sink: Option<&CookieSink>,
) -> Result<Option<CurrentUser>, ApiError> {
    if !state.config.accounts {
        return Ok(None);
    }
    let secure = cookies_secure(state, client);
    let candidates = user_session_tokens(headers, secure);
    if candidates.is_empty() {
        return Ok(None);
    }
    let now = now_ms();
    let hashes: Vec<TokenHash> = candidates.iter().map(|(_, hash)| *hash).collect();
    let found = state
        .db
        .read(move |c| -> Result<Option<(usize, SessionRow)>, ApiError> {
            for (i, hash) in hashes.iter().enumerate() {
                if let Some(row) = sessions::lookup(c, hash, now)? {
                    return Ok(Some((i, row)));
                }
            }
            Ok(None)
        })
        .await?;
    let Some((index, row)) = found else { return Ok(None) };
    let (cookie, hash) = candidates[index];
    let mut expires_at = row.expires_at;
    if let Some(sink) = sink
        && sessions::needs_touch(row.last_seen_at, now)
    {
        let touched = state.db.write(move |c| sessions::touch(c, &hash, now).map_err(ApiError::from)).await?;
        let Some(new_expiry) = touched else { return Ok(None) };
        expires_at = new_expiry;
        let max_age = u64::try_from(SESSION_TTL_MS / 1000).unwrap_or(0);
        sink.push(cookies::set(SessionCookie::User.name(secure), cookie, max_age, secure));
    }
    Ok(Some(CurrentUser { user: row.user, token_hash: hash, expires_at }))
}

/// Verify `gnome_sid` (the first valid value wins).
pub fn resolve_anon(state: &AppState, headers: &HeaderMap, client: &ClientInfo) -> Option<AnonToken> {
    let now = now_s();
    let name = SessionCookie::Anonymous.name(cookies_secure(state, client));
    cookies::values(headers, name).into_iter().find_map(|token| state.anon_key.verify(token, now))
}

/// `Option<CurrentUser>` for the request.
#[derive(Debug, Clone)]
pub struct MaybeUser(pub Option<CurrentUser>);

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(r) = parts.extensions.get::<ResolvedUser>() {
            return Ok(Self(r.0.clone()));
        }
        let client = parts.extensions.get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
        let sink = parts.extensions.get::<CookieSink>().cloned();
        let resolved = resolve_user(state, &parts.headers, &client, sink.as_ref()).await?;
        parts.extensions.insert(ResolvedUser(resolved.clone()));
        Ok(Self(resolved))
    }
}

/// A signed-in user, or `401 unauthorized`.
#[derive(Debug, Clone)]
pub struct RequireUser(pub CurrentUser);

impl FromRequestParts<AppState> for RequireUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match MaybeUser::from_request_parts(parts, state).await?.0 {
            Some(u) => Ok(Self(u)),
            None => Err(ApiError::unauthorized("sign in required")),
        }
    }
}

/// `Option<AnonToken>` (a valid `gnome_sid`).
#[derive(Debug, Clone)]
pub struct MaybeAnon(pub Option<AnonToken>);

impl FromRequestParts<AppState> for MaybeAnon {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let client = parts.extensions.get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
        Ok(Self(resolve_anon(state, &parts.headers, &client)))
    }
}

/// The session that authorizes use of the proxy.
#[derive(Debug, Clone)]
pub enum ProxySession {
    Anonymous(AnonToken),
    User(CurrentUser),
}

impl ProxySession {
    /// Key for per-session connection caps and rate limits.
    pub fn key(&self) -> SessionKey {
        match self {
            Self::Anonymous(t) => SessionKey::derive(t.id.as_bytes()),
            Self::User(u) => u.session_key(),
        }
    }
}

/// Access rule for the proxy (API.md "Wisp"): in `accounts` mode a signed-in user (`gnome_auth`), otherwise a valid
/// anonymous session (`gnome_sid`, obtained via `POST /api/session`, which enforces the access code in `code` mode).
pub async fn proxy_session(
    state: &AppState,
    headers: &HeaderMap,
    client: &ClientInfo,
) -> Result<ProxySession, ApiError> {
    match state.config.access_mode {
        AccessMode::Accounts => resolve_user(state, headers, client, None)
            .await?
            .map(ProxySession::User)
            .ok_or_else(ApiError::login_required),
        AccessMode::Open | AccessMode::Code => resolve_anon(state, headers, client)
            .map(ProxySession::Anonymous)
            .ok_or_else(|| ApiError::unauthorized("no session: POST /api/session first")),
    }
}
