//! The JSON error type (docs/API.md "Conventions"):
//! `{"error": {"code": "snake_case", "message": "…", "retry_after_s"?: n, "fields"?: {name: msg}}}`.
//!
//! Also home of the JSON/query extractors that turn malformed input into these errors instead of axum's plain-text
//! rejections. JSON that has the wrong shape answers `422 validation_failed` with `fields` keyed by the JSON path of
//! the offending value (`username`, `items[3].url`, or `body` for the document itself).

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::time::Duration;

use axum::extract::rejection::QueryRejection;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http::request::Parts;
use http::{HeaderValue, StatusCode, header};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::db::DbError;

/// An API error response. Kept small (rare parts are boxed) because it is the error type of every handler.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: Cow<'static, str>,
    details: Option<Box<Details>>,
}

#[derive(Debug, Default)]
struct Details {
    retry_after_s: Option<u64>,
    fields: Option<BTreeMap<String, String>>,
    /// Extra top-level members merged next to `"error"` (e.g. the server copy in a sync conflict).
    extra: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self { status, code, message: message.into(), details: None }
    }

    fn details_mut(&mut self) -> &mut Details {
        self.details.get_or_insert_with(Box::default)
    }

    /// `Retry-After` seconds (rate limiting).
    pub fn retry_after_s(&self) -> Option<u64> {
        self.details.as_ref().and_then(|d| d.retry_after_s)
    }

    /// Per-field validation messages.
    pub fn fields(&self) -> Option<&BTreeMap<String, String>> {
        self.details.as_ref().and_then(|d| d.fields.as_ref())
    }

    pub fn bad_request(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    /// `422 validation_failed` with per-field messages.
    pub fn validation(fields: BTreeMap<String, String>) -> Self {
        let mut e = Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation_failed", "validation failed");
        e.details_mut().fields = Some(fields);
        e
    }

    /// `422 validation_failed` for a single field.
    pub fn invalid_field(field: impl Into<String>, message: impl Into<String>) -> Self {
        Self::validation(BTreeMap::from([(field.into(), message.into())]))
    }

    pub fn unauthorized(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "not found")
    }

    pub fn method_not_allowed() -> Self {
        Self::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "method not allowed")
    }

    pub fn conflict(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::CONFLICT, "conflict", message)
    }

    pub fn payload_too_large() -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", "request body too large")
    }

    /// `429 rate_limited` with `Retry-After` (whole seconds, rounded up, at least 1).
    pub fn rate_limited(retry_after: Duration) -> Self {
        let secs = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
        let mut e = Self::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited", "too many requests, slow down");
        e.details_mut().retry_after_s = Some(secs.max(1));
        e
    }

    pub fn access_code_required(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "access_code_required", message)
    }

    pub fn login_required() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "login_required", "sign in to use this server")
    }

    /// `503 timeout`: the handler did not produce a response in time ([`crate::router::REQUEST_TIMEOUT`]).
    pub fn timeout() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "timeout", "the request took too long")
    }

    /// `503 unavailable`: the server cannot take this request now (e.g. it is shutting down).
    pub fn unavailable(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    /// `502 bad_gateway`: an upstream (HolyWisp) was unreachable or refused.
    pub fn bad_gateway(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "bad_gateway", message)
    }

    /// `426 upgrade_required`: the endpoint only accepts an HTTP/1.1 WebSocket upgrade.
    pub fn upgrade_required(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::UPGRADE_REQUIRED, "upgrade_required", message)
    }

    /// `429 too_many_connections`: a concurrency cap (per client IP or per session) is reached. Unlike
    /// `rate_limited` there is no `Retry-After`: a slot frees up when another connection closes.
    pub fn too_many_connections(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, "too_many_connections", message)
    }

    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal server error")
    }

    /// Log `err` (with the request span) and return a generic 500.
    pub fn internal_from(err: impl std::fmt::Display) -> Self {
        tracing::error!(error = %err, "internal error");
        Self::internal()
    }

    /// Add `Retry-After` (whole seconds, at least 1) and `retry_after_s` to the answer.
    pub fn with_retry_after(mut self, retry_after: Duration) -> Self {
        let secs = retry_after.as_secs() + u64::from(retry_after.subsec_nanos() > 0);
        self.details_mut().retry_after_s = Some(secs.max(1));
        self
    }

    pub fn with_extra(mut self, key: &str, value: serde_json::Value) -> Self {
        self.details_mut().extra.get_or_insert_with(serde_json::Map::new).insert(key.to_string(), value);
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}: {}", self.status.as_u16(), self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Serialize)]
struct ErrorBody<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_s: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<&'a BTreeMap<String, String>>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let Details { retry_after_s, fields, extra } = self.details.map(|d| *d).unwrap_or_default();
        let mut body = serde_json::Map::new();
        if let Some(extra) = extra {
            body.extend(extra);
        }
        let err = ErrorBody { code: self.code, message: &self.message, retry_after_s, fields: fields.as_ref() };
        body.insert("error".into(), serde_json::to_value(err).unwrap_or(serde_json::Value::Null));
        let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| br#"{"error":{"code":"internal"}}"#.to_vec());
        let mut res = (self.status, bytes).into_response();
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(secs) = retry_after_s {
            h.insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        // 405s: axum's method router adds the accurate `Allow` header for routed paths.
        res
    }
}

impl From<DbError> for ApiError {
    fn from(e: DbError) -> Self {
        Self::internal_from(e)
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal_from(e)
    }
}

/// JSON request body with API-shaped rejections: `400 bad_request` (not JSON / wrong content type),
/// `422 validation_failed` with per-path `fields` (wrong shape), `413 payload_too_large` (over the body limit).
#[derive(Debug, Clone, Copy, Default)]
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let is_json = is_json_content_type(req.headers());
        let bytes = body_bytes(req, state).await?;
        if !is_json {
            return Err(ApiError::bad_request("expected Content-Type: application/json"));
        }
        parse_json(&bytes).map(Self)
    }
}

/// A JSON body that may be absent: an empty body yields `None`; anything else must be valid JSON for `T`.
#[derive(Debug, Clone, Default)]
pub struct OptionalJson<T>(pub Option<T>);

impl<S, T> FromRequest<S> for OptionalJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let is_json = is_json_content_type(req.headers());
        let bytes = body_bytes(req, state).await?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Self(None));
        }
        if !is_json {
            return Err(ApiError::bad_request("expected Content-Type: application/json"));
        }
        parse_json(&bytes).map(|v| Self(Some(v)))
    }
}

/// `application/json` or `application/<anything>+json` (parameters such as `charset` are ignored).
fn is_json_content_type(headers: &http::HeaderMap) -> bool {
    let Some(ct) = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()) else { return false };
    let essence = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    essence == "application/json" || (essence.starts_with("application/") && essence.ends_with("+json"))
}

/// The request body, honouring the route's body limit (`DefaultBodyLimit`).
async fn body_bytes<S: Send + Sync>(req: Request, state: &S) -> Result<Bytes, ApiError> {
    Bytes::from_request(req, state).await.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::payload_too_large()
        } else {
            ApiError::bad_request(e.body_text())
        }
    })
}

/// Deserialize a complete JSON document into `T`.
pub fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let value: T = serde_path_to_error::deserialize(&mut de).map_err(json_error)?;
    de.end().map_err(|e| ApiError::bad_request(format!("malformed JSON: {}", without_position(&e))))?;
    Ok(value)
}

fn json_error(err: serde_path_to_error::Error<serde_json::Error>) -> ApiError {
    let inner = err.inner();
    if !inner.is_data() {
        return ApiError::bad_request(format!("malformed JSON: {}", without_position(inner)));
    }
    let message = without_position(inner);
    let path = err.path().to_string();
    let at = |name: &str| if path == "." { name.to_string() } else { format!("{path}.{name}") };
    let (field, field_message) = match message.strip_prefix("missing field `").and_then(|r| r.strip_suffix('`')) {
        Some(name) => (at(name), "is required".to_string()),
        None => (if path == "." { "body".to_string() } else { path.clone() }, message.clone()),
    };
    let mut e = ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_failed",
        format!("validation failed: {field}: {field_message}"),
    );
    e.details_mut().fields = Some(BTreeMap::from([(field, field_message)]));
    e
}

/// serde_json's message without the trailing " at line L column C".
pub fn without_position(err: &serde_json::Error) -> String {
    let text = err.to_string();
    match text.rfind(" at line ") {
        Some(i) if err.line() > 0 => text[..i].to_string(),
        _ => text,
    }
}

/// `axum::extract::Query` with API-shaped rejections.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApiQuery<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match axum::extract::Query::<T>::from_request_parts(parts, state).await {
            Ok(axum::extract::Query(v)) => Ok(Self(v)),
            Err(QueryRejection::FailedToDeserializeQueryString(e)) => Err(ApiError::bad_request(e.body_text())),
            Err(other) => Err(ApiError::bad_request(other.body_text())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn shape_and_headers() {
        let res = ApiError::rate_limited(Duration::from_millis(1500)).into_response();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers()[header::RETRY_AFTER], "2");
        assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
        let v = body_json(res).await;
        assert_eq!(v["error"]["code"], "rate_limited");
        assert_eq!(v["error"]["retry_after_s"], 2);
    }

    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct Item {
        url: String,
        position: f64,
    }

    #[derive(Debug, serde::Deserialize)]
    #[allow(dead_code)]
    struct Doc {
        username: String,
        items: Vec<Item>,
    }

    fn fields_of(err: &ApiError) -> Vec<(String, String)> {
        err.fields().map(|f| f.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
    }

    #[test]
    fn json_errors_name_the_offending_path() {
        let ok: Doc = parse_json(br#"{"username":"a","items":[{"url":"u","position":1}]}"#).unwrap();
        assert_eq!(ok.items.len(), 1);

        let e = parse_json::<Doc>(br#"{"items":[]}"#).unwrap_err();
        assert_eq!((e.status, e.code), (StatusCode::UNPROCESSABLE_ENTITY, "validation_failed"));
        assert_eq!(fields_of(&e), vec![("username".to_string(), "is required".to_string())]);

        let e = parse_json::<Doc>(br#"{"username":"a","items":[{"url":"u","position":1},{"url":"u"}]}"#).unwrap_err();
        assert_eq!(fields_of(&e), vec![("items[1].position".to_string(), "is required".to_string())]);

        let e = parse_json::<Doc>(br#"{"username":"a","items":[{"url":5,"position":1}]}"#).unwrap_err();
        let fields = fields_of(&e);
        assert_eq!(fields[0].0, "items[0].url");
        assert!(fields[0].1.starts_with("invalid type: integer `5`"), "{fields:?}");
        assert!(!fields[0].1.contains("line"), "positions are stripped: {fields:?}");

        let e = parse_json::<Doc>(b"\"just text\"").unwrap_err();
        assert_eq!(fields_of(&e)[0].0, "body");

        for malformed in [&b"{not json"[..], b"{\"username\":\"a\",\"items\":[]} trailing", b""] {
            let e = parse_json::<Doc>(malformed).unwrap_err();
            assert_eq!((e.status, e.code), (StatusCode::BAD_REQUEST, "bad_request"), "{malformed:?}");
        }
    }

    #[test]
    fn json_content_types() {
        let h = |ct: &'static str| {
            let mut h = http::HeaderMap::new();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(ct));
            h
        };
        assert!(is_json_content_type(&h("application/json")));
        assert!(is_json_content_type(&h("Application/JSON; charset=utf-8")));
        assert!(is_json_content_type(&h("application/merge-patch+json")));
        assert!(!is_json_content_type(&h("text/plain")));
        assert!(!is_json_content_type(&h("application/jsonx")));
        assert!(!is_json_content_type(&http::HeaderMap::new()));
    }

    #[tokio::test]
    async fn validation_fields_and_extra() {
        let res = ApiError::invalid_field("username", "too short")
            .with_extra("data", serde_json::json!({"a": 1}))
            .into_response();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let v = body_json(res).await;
        assert_eq!(v["error"]["code"], "validation_failed");
        assert_eq!(v["error"]["fields"]["username"], "too short");
        assert_eq!(v["data"]["a"], 1);
    }
}
