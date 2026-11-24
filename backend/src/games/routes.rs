//! Public routes of the games module (WAVE-C §4.2): `/api/games*`, `/api/thumb/:id` and the wrapper
//! `/play-frame/:slug`. Catalog reads are public in every access mode (D8). Query-parameter problems answer
//! `400 bad_request` naming the parameter (D10); before `prepare` ran or after it failed, `503` (D21).

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use gnome_catalog::{GamePage, ListFilter, ListQuery, PlayOutcome, Sort, Source};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use serde_json::{Value, json};

use super::thumbs::{ThumbBody, ThumbError};
use super::{Games, catalog_error};
use crate::auth::extract::{resolve_anon, resolve_user};
use crate::error::ApiError;
use crate::module::Ext;
use crate::security::ClientInfo;
use crate::security::crypto::hmac_sha256;
use crate::security::csp;
use crate::state::AppState;

/// Default and maximum page size of `GET /api/games`.
const DEFAULT_LIMIT: u32 = 48;
const SECTION_SIZE: usize = 24;
const RELATED: usize = 12;

/// The query string as `(name, value)` pairs, percent-decoded (`+` = space). Unknown names are ignored by callers.
pub fn query_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    let decode = |s: &str| {
        let s = s.replace('+', " ");
        percent_encoding::percent_decode_str(&s).decode_utf8_lossy().into_owned()
    };
    raw.unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (decode(k), decode(v)),
            None => (decode(p), String::new()),
        })
        .collect()
}

struct Params(Vec<(String, String)>);

impl Params {
    fn new(raw: Option<String>) -> Self {
        Self(query_pairs(raw.as_deref()))
    }

    /// The last value of `name` (empty values count as absent).
    fn get(&self, name: &str) -> Option<&str> {
        self.0.iter().rev().find(|(k, v)| k == name && !v.is_empty()).map(|(_, v)| v.as_str())
    }

    fn flag(&self, name: &str) -> Result<bool, ApiError> {
        match self.get(name) {
            None | Some("0" | "false") => Ok(false),
            Some("1" | "true") => Ok(true),
            Some(_) => Err(ApiError::bad_request(format!("{name} must be 0 or 1"))),
        }
    }

    fn limit(&self, default: u32) -> Result<u32, ApiError> {
        match self.get("limit") {
            None => Ok(default),
            Some(v) => v
                .parse::<u32>()
                .ok()
                .filter(|n| (1..=100).contains(n))
                .ok_or_else(|| ApiError::bad_request("limit must be 1-100")),
        }
    }

    /// `exclude=<slug,…>` (validated by the crate: at most 20 given, unknown slugs ignored).
    fn exclude(&self) -> Vec<String> {
        self.get("exclude")
            .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
            .unwrap_or_default()
    }

    fn filter(&self) -> Result<ListFilter, ApiError> {
        Ok(ListFilter { mobile: self.flag("mobile")?, exclude: self.exclude() })
    }
}

async fn read<T, F>(state: &AppState, games: &Arc<Games>, f: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&Games, &rusqlite::Connection) -> Result<T, gnome_catalog::CatalogError> + Send + 'static,
{
    games.ready()?;
    let g = games.clone();
    state.db.read(move |c| f(&g, c).map_err(catalog_error)).await.map_err(|e| {
        if e.status.is_server_error() && e.status != StatusCode::SERVICE_UNAVAILABLE { super::unavailable() } else { e }
    })
}

/// `GET /api/games`.
pub async fn list(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = Params::new(raw);
    let sort = match p.get("sort") {
        None => None,
        Some(v) => Some(Sort::parse(v).ok_or_else(|| ApiError::bad_request(format!("unknown sort: {v}")))?),
    };
    let q = ListQuery {
        q: p.get("q").map(str::to_string),
        category: p.get("category").map(str::to_string),
        tag: p.get("tag").map(str::to_string),
        sort,
        mobile: p.flag("mobile")?,
        include_link_out: p.flag("include_link_out")?,
        exclude: p.exclude(),
        cursor: p.get("cursor").map(str::to_string),
        limit: Some(p.limit(DEFAULT_LIMIT)?),
    };
    let page = read(&state, &games, move |g, c| g.catalog.list(c, &q)).await?;
    Ok(Json(serde_json::to_value(page).unwrap_or_default()))
}

/// `GET /api/games/sections`.
pub async fn sections(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let filter = Params::new(raw).filter()?;
    let s = read(&state, &games, move |g, c| g.catalog.sections(c, SECTION_SIZE, &filter)).await?;
    Ok(Json(serde_json::to_value(s).unwrap_or_default()))
}

/// `GET /api/games/categories`.
pub async fn categories(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let link_out = Params::new(raw).flag("include_link_out")?;
    let list = read(&state, &games, move |g, c| g.catalog.categories(c, link_out)).await?;
    Ok(Json(json!({ "categories": list })))
}

/// `GET /api/games/tags`.
pub async fn tags(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = Params::new(raw);
    let limit = p.limit(30)? as usize;
    let prefix = p.get("prefix").unwrap_or("").to_string();
    if prefix.chars().count() > 40 {
        return Err(ApiError::bad_request("tag prefix is limited to 40 characters"));
    }
    let list = read(&state, &games, move |g, c| g.catalog.tags(c, &prefix, limit, false)).await?;
    Ok(Json(json!({ "tags": list })))
}

/// `GET /api/games/by-ids`.
pub async fn by_ids(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let p = Params::new(raw);
    let ids: Vec<i64> = match p.get("ids") {
        None => Vec::new(),
        Some(v) => v
            .split(',')
            .map(|s| s.trim().parse::<i64>())
            .collect::<Result<_, _>>()
            .map_err(|_| ApiError::bad_request("ids must be comma-separated integers"))?,
    };
    let items = read(&state, &games, move |g, c| g.catalog.by_ids(c, &ids)).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Debug, Serialize)]
struct LastImport {
    status: String,
    finished_at: i64,
}

#[derive(Debug, Serialize)]
struct SourceStatus {
    id: Source,
    name: &'static str,
    last_import: Option<LastImport>,
}

/// `GET /api/games/status` (never error texts or URLs).
pub async fn status(State(state): State<AppState>, Ext(games): Ext<Games>) -> Result<Json<Value>, ApiError> {
    let sources = state.config.catalog.sources.clone();
    let (stats, finished) = read(&state, &games, move |g, c| {
        let stats = g.catalog.stats(c)?;
        let mut finished = Vec::new();
        for s in &sources {
            let runs = g.catalog.import_runs(c, Some(s.id()), 20)?;
            let last = runs.into_iter().find(|r| r.finished_at.is_some() && r.status != "running");
            finished.push((*s, last));
        }
        Ok((stats, finished))
    })
    .await?;
    let playable: i64 = stats
        .by_source
        .iter()
        .filter(|(id, _)| Source::from_id(id).is_some_and(Source::playable))
        .map(|(_, s)| s.listed)
        .sum();
    let importing = stats.by_source.values().any(|s| s.last_import.as_ref().is_some_and(|r| r.status == "running"))
        || state.config.catalog.sources.iter().any(|s| games.is_importing(*s));
    let sources: Vec<SourceStatus> = finished
        .into_iter()
        .map(|(s, run)| SourceStatus {
            id: s,
            name: s.display_name(),
            last_import: run.and_then(|r| r.finished_at.map(|t| LastImport { status: r.status, finished_at: t })),
        })
        .collect();
    Ok(Json(json!({
        "listed": stats.listed,
        "playable": playable,
        "importing": importing,
        "sources": sources,
    })))
}

/// The `GameDetail` of the API: the crate's detail plus `embed_allowed` and `oss`.
pub fn detail_json(games: &Games, state: &AppState, page: &GamePage) -> Value {
    let mut game = serde_json::to_value(&page.game).unwrap_or_default();
    let allowed = games.frames.allows(&page.game, &games.oss);
    let oss =
        (page.game.summary.source == Source::Oss).then(|| games.oss.get(&page.game.summary.slug)).flatten().map(|b| {
            let proxy = state.config.proxy.origin().unwrap_or_default();
            json!({
                "repository": b.repository,
                "commit": b.commit,
                "license_file_url": b.license_file.map(|f| format!("{proxy}/oss/{}/{f}", b.slug)),
            })
        });
    if let Some(obj) = game.as_object_mut() {
        obj.insert("embed_allowed".into(), Value::Bool(allowed));
        obj.insert("oss".into(), oss.unwrap_or(Value::Null));
    }
    json!({ "game": game, "related": page.related })
}

/// `GET /api/games/:slug`.
pub async fn game(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(slug): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let filter = Params::new(raw).filter()?;
    let page = read(&state, &games, move |g, c| g.catalog.game(c, &slug, RELATED, &filter)).await?;
    let page = page.ok_or_else(ApiError::not_found)?;
    Ok(Json(detail_json(&games, &state, &page)))
}

/// The play counter's dedup key (D8): the session reference when a session cookie is present, else the client IP
/// (IPv6 as its /64). The crate stores only an hourly 16-byte hash of it.
async fn dedup_key(state: &AppState, headers: &HeaderMap, client: &ClientInfo) -> [u8; 32] {
    let key = state.secret.derive("gnome/games/play-dedup");
    // A valid `gnome_auth` (never refreshed or re-issued here: no cookie sink).
    if let Ok(Some(user)) = resolve_user(state, headers, client, None).await {
        let r = crate::gateway::ticket::SessionRef::for_user(&user.token_hash);
        return hmac_sha256(&key, &[b"gnome/games/play\0", &r.0]);
    }
    if let Some(anon) = resolve_anon(state, headers, client) {
        let r = crate::gateway::ticket::SessionRef::for_anonymous(&anon.id);
        return hmac_sha256(&key, &[b"gnome/games/play\0", &r.0]);
    }
    let ip: Vec<u8> = match client.ip {
        IpAddr::V4(v4) => v4.octets().to_vec(),
        IpAddr::V6(v6) => v6.octets()[..8].to_vec(),
    };
    hmac_sha256(&key, &[b"gnome/games/play-ip\0", &ip])
}

/// `POST /api/games/:slug/play` (CSRF rules apply: the public router's middleware).
pub async fn play(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    client: ClientInfo,
) -> Result<StatusCode, ApiError> {
    games.ready()?;
    let key = dedup_key(&state, &headers, &client).await;
    let cat = games.catalog.clone();
    let now = games.now_ms();
    let outcome = state.db.write(move |c| cat.record_play(c, &slug, &key, now).map_err(catalog_error)).await?;
    if outcome == PlayOutcome::Counted {
        games.counters.plays.fetch_add(1, Ordering::Relaxed);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/thumb/:id` (rate class `thumb`, counted by the API middleware; misses also take `thumb_fetch`).
pub async fn thumb(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(id): Path<String>,
    headers: HeaderMap,
    client: ClientInfo,
) -> Response {
    let not_found = || {
        games.thumbs.count("not_found");
        ApiError::not_found().into_response()
    };
    let Ok(id) = id.parse::<i64>() else { return not_found() };
    if let Err(e) = games.ready() {
        return e.into_response();
    }
    let cat = games.catalog.clone();
    let url = match state.db.read(move |c| cat.thumbnail_source(c, id).map_err(catalog_error)).await {
        Ok(Some(url)) => url,
        Ok(None) => return not_found(),
        Err(e) => return e.into_response(),
    };
    let Some(fetcher) = games.thumb_fetcher() else { return super::unavailable().into_response() };
    let hit = match games.thumbs.get(&url, client.ip, fetcher, &state).await {
        Ok(hit) => hit,
        Err(ThumbError::NotFound | ThumbError::Refused(_)) => return ApiError::not_found().into_response(),
        Err(ThumbError::Upstream { retry_after_s }) => {
            return ApiError::unavailable("the image server failed")
                .with_retry_after(std::time::Duration::from_secs(u64::from(retry_after_s)))
                .into_response();
        }
        Err(ThumbError::RateLimited { retry_after_s }) => {
            return ApiError::rate_limited(std::time::Duration::from_secs(u64::from(retry_after_s))).into_response();
        }
    };
    let etag = format!("\"{}\"", hit.etag);
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, hit.content_type)
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, format!("public, max-age={}", hit.max_age_s))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; frame-ancestors 'none'")
        .header("cross-origin-resource-policy", "same-origin");
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    if not_modified {
        games.thumbs.count("not_modified");
        return res.status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap_or_default();
    }
    let body = match hit.body {
        ThumbBody::Memory(b) => Body::from(b),
        ThumbBody::Disk { path, len } => match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() as u64 == len => {
                games.thumbs.count("hit");
                Body::from(bytes)
            }
            _ => return super::unavailable().into_response(),
        },
    };
    res = res.status(StatusCode::OK);
    res.body(body).unwrap_or_default()
}

/// A wrapper-path 404 (an HTML body under `default-src 'none'; frame-ancestors 'self'`).
fn frame_not_found() -> Response {
    let mut res = (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")],
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Game not found</title></head>\
         <body><p>This game cannot be shown here.</p></body></html>",
    )
        .into_response();
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'self'"),
    );
    res
}

/// `GET`/`HEAD /play-frame/:slug`: the game's wrapper document (D2), computed per request.
pub async fn play_frame(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(slug): Path<String>,
    method: Method,
) -> Response {
    if let Err(e) = games.ready() {
        return e.into_response();
    }
    let lookup = slug.clone();
    let page = match read(&state, &games, move |g, c| g.catalog.game(c, &lookup, 0, &ListFilter::default())).await {
        Ok(Some(page)) => page,
        Ok(None) => return frame_not_found(),
        Err(e) => return e.into_response(),
    };
    let Some(target) = games.frames.target(&page.game, &games.oss) else { return frame_not_found() };
    let Ok(policy) = HeaderValue::from_str(&csp::wrapper_csp(&target.frame_source)) else { return frame_not_found() };
    let html = super::frames::render_wrapper(&target);
    let mut res = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, policy)
        .header(header::X_FRAME_OPTIONS, "SAMEORIGIN");
    if method == Method::HEAD {
        res = res.header(header::CONTENT_LENGTH, html.len());
        return res.body(Body::empty()).unwrap_or_default();
    }
    res.body(Body::from(html)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_strings() {
        let p = query_pairs(Some("q=a+b%20c&exclude=x,y&mobile=1&empty=&flag"));
        assert_eq!(p[0], ("q".into(), "a b c".into()));
        assert_eq!(p[1], ("exclude".into(), "x,y".into()));
        let params = Params(p);
        assert!(params.flag("mobile").unwrap());
        assert!(!params.flag("flag").unwrap());
        assert_eq!(params.exclude(), ["x", "y"]);
        assert!(Params(query_pairs(Some("limit=0"))).limit(48).is_err());
        assert_eq!(Params(query_pairs(Some("limit=100"))).limit(48).unwrap(), 100);
    }
}
