//! CSRF guard (API.md "Conventions"): every request that is not GET/HEAD must carry `X-GNOME-Request: 1` and, when an
//! `Origin` header is present, it must be allowed. Combined with `SameSite=Strict` cookies and the absence of CORS,
//! cross-site pages can neither forge state-changing requests nor read responses.

use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, Method, header};

use super::client::ClientInfo;
use super::origin::OriginPolicy;
use crate::error::ApiError;
use crate::state::AppState;

/// Custom header that cross-site forms cannot send (and cross-origin fetches cannot send without a CORS preflight,
/// which this server never approves).
pub const CSRF_HEADER: &str = "x-gnome-request";

static HINT_LOGGED: AtomicBool = AtomicBool::new(false);

/// Check a request; `Err` carries the 403 to return.
pub fn check(
    method: &Method,
    headers: &HeaderMap,
    client: &ClientInfo,
    origins: &OriginPolicy,
) -> Result<(), ApiError> {
    if matches!(*method, Method::GET | Method::HEAD) {
        return Ok(());
    }
    if headers.get(CSRF_HEADER).map(|v| v.as_bytes()) != Some(b"1") {
        return Err(ApiError::forbidden("missing X-GNOME-Request: 1 header"));
    }
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin.to_str().unwrap_or("");
        if !origins.allows(origin, client) {
            if let Some(hint) = origins.mismatch_hint(origin, client)
                && !HINT_LOGGED.swap(true, Ordering::Relaxed)
            {
                tracing::warn!(origin, hint, "rejected a same-site request because of a scheme mismatch");
            }
            return Err(ApiError::forbidden("origin not allowed"));
        }
    }
    Ok(())
}

/// Middleware for the public router.
pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let client = req.extensions().get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
    if let Err(e) = check(req.method(), req.headers(), &client, &state.origins) {
        return e.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn client() -> ClientInfo {
        ClientInfo { host: Some("gnome.local".into()), ..ClientInfo::unknown() }
    }

    #[test]
    fn safe_methods_pass() {
        let p = OriginPolicy::default();
        assert!(check(&Method::GET, &HeaderMap::new(), &client(), &p).is_ok());
        assert!(check(&Method::HEAD, &HeaderMap::new(), &client(), &p).is_ok());
    }

    #[test]
    fn header_required_and_origin_checked() {
        let p = OriginPolicy::default();
        let mut h = HeaderMap::new();
        assert_eq!(check(&Method::POST, &h, &client(), &p).unwrap_err().status, http::StatusCode::FORBIDDEN);
        h.insert(CSRF_HEADER, HeaderValue::from_static("1"));
        assert!(check(&Method::POST, &h, &client(), &p).is_ok(), "no Origin header is fine");
        h.insert(header::ORIGIN, HeaderValue::from_static("http://gnome.local"));
        assert!(check(&Method::DELETE, &h, &client(), &p).is_ok());
        h.insert(header::ORIGIN, HeaderValue::from_static("http://evil.example"));
        assert!(check(&Method::PUT, &h, &client(), &p).is_err());
        h.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(check(&Method::POST, &h, &client(), &p).is_err());
        let mut wrong = HeaderMap::new();
        wrong.insert(CSRF_HEADER, HeaderValue::from_static("true"));
        assert!(check(&Method::POST, &wrong, &client(), &p).is_err());
        assert!(check(&Method::OPTIONS, &HeaderMap::new(), &client(), &p).is_err(), "no CORS preflights");
    }
}
