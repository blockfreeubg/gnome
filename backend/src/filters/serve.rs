//! `GET /api/filters` and `GET /api/filters/{id}` (both origins, read-only, public).

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Request};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use super::FilterService;
use super::registry::{Category, ListDef};
use super::store::{self, Variant};
use crate::error::ApiError;
use crate::module::Ext;

/// How long a request waits for the startup check of stored lists before answering `503`.
const LOAD_WAIT: Duration = Duration::from_secs(10);
/// `Cache-Control` of a body requested as `?v=<its sha256>` (the URL changes with the content).
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// `Cache-Control` otherwise: cache, but revalidate (cheap `304` with the ETag).
const REVALIDATE: &str = "no-cache";
const STREAM_CHUNK: usize = 64 * 1024;

/// One entry of `GET /api/filters` (API.md `FilterList`).
#[derive(Debug, Serialize)]
pub struct FilterList<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub category: &'static str,
    /// `abp` (filter text) or `resources` (uBO redirect resources + scriptlets, JSON).
    pub format: &'static str,
    pub license: &'a str,
    pub homepage: &'a str,
    pub default_enabled: bool,
    /// May use the scriptlets that need trust (`trusted-*` and uBO's `requiresTrust` ones; the client drops them from
    /// every other list).
    pub trusted: bool,
    /// Whether the body is stored and `GET /api/filters/{id}` serves it.
    pub available: bool,
    pub size: u64,
    pub sha256: Option<&'a str>,
    /// When the content last changed (ms).
    pub updated_at: Option<i64>,
    /// When upstream was last checked successfully (ms).
    pub fetched_at: Option<i64>,
    pub version: Option<&'a str>,
}

/// The serialized `GET /api/filters` body for one index generation.
#[derive(Debug, Clone)]
pub struct CachedListing {
    generation: u64,
    body: bytes::Bytes,
    tag: String,
}

#[derive(Debug, Serialize)]
struct Listing<'a> {
    lists: Vec<FilterList<'a>>,
    resources: Option<FilterList<'a>>,
}

fn unavailable(message: &'static str, retry_s: u64) -> Response {
    let mut res = ApiError::unavailable(message).into_response();
    res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(retry_s));
    res
}

async fn ready(svc: &FilterService) -> bool {
    svc.is_loaded() || tokio::time::timeout(LOAD_WAIT, svc.wait_loaded()).await.is_ok()
}

/// Whether `If-None-Match` names `sha` (any representation: `"<sha>"`, `"<sha>.br"`, `"<sha>.gz"`, weak or not;
/// `*` matches).
fn none_match(headers: &HeaderMap, sha: &str) -> bool {
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().trim_start_matches("W/").trim_matches('"'))
        .any(|t| t == "*" || t.split('.').next() == Some(sha))
}

/// `(br, gzip)` acceptable per `Accept-Encoding` (q=0 excludes; `*` covers unlisted codings).
fn accepted(headers: &HeaderMap) -> (bool, bool) {
    let Some(s) = headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()) else { return (false, false) };
    let (mut br, mut gzip, mut star) = (None, None, None);
    for item in s.split(',') {
        let mut parts = item.split(';');
        let name = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let q = parts
            .filter_map(|p| p.trim().strip_prefix("q=").or_else(|| p.trim().strip_prefix("Q=")))
            .map(|v| v.trim().parse::<f32>().unwrap_or(0.0))
            .next_back()
            .unwrap_or(1.0);
        let ok = q > 0.0;
        match name.as_str() {
            "br" => br = Some(ok),
            "gzip" | "x-gzip" => gzip = Some(ok),
            "*" => star = Some(ok),
            _ => {}
        }
    }
    (br.or(star).unwrap_or(false), gzip.or(star).unwrap_or(false))
}

fn version_param(req: &Request) -> Option<&str> {
    req.uri().query()?.split('&').find_map(|kv| kv.strip_prefix("v="))
}

fn entry_json<'a>(def: &'a ListDef, e: Option<&'a super::Entry>) -> FilterList<'a> {
    let stored = e.filter(|e| e.files.is_some());
    let m = stored.map(|e| &e.meta);
    FilterList {
        id: &def.id,
        name: &def.name,
        category: def.category.as_str(),
        format: def.format.as_str(),
        license: &def.license,
        homepage: &def.homepage,
        default_enabled: def.default_enabled,
        trusted: def.trusted,
        available: stored.is_some(),
        size: m.map_or(0, |m| m.size),
        sha256: m.and_then(|m| m.sha256.as_deref()),
        updated_at: m.and_then(|m| m.updated_at),
        fetched_at: e.and_then(|e| e.meta.fetched_at),
        version: m.and_then(|m| m.version.as_deref()),
    }
}

fn render_listing(svc: &FilterService) -> CachedListing {
    // Read the generation first: a change while rendering makes the next request render again.
    let generation = svc.generation.load(std::sync::atomic::Ordering::SeqCst);
    let entries: Vec<(&ListDef, Option<super::Entry>)> = svc.defs.iter().map(|d| (d, svc.entry(&d.id))).collect();
    let mut listing = Listing { lists: Vec::with_capacity(entries.len()), resources: None };
    for (def, e) in &entries {
        let item = entry_json(def, e.as_ref());
        if def.category == Category::Resources {
            listing.resources = Some(item);
        } else {
            listing.lists.push(item);
        }
    }
    let body = serde_json::to_vec(&listing).expect("listing serializes");
    let tag = store::sha256_hex(&body)[..32].to_string();
    CachedListing { generation, body: body.into(), tag }
}

/// `GET /api/filters` → `{"lists": FilterList[], "resources": FilterList | null}` (`ETag`, `no-cache`). The body is
/// rendered once per change of the index.
pub async fn list(Ext(svc): Ext<FilterService>, req: Request) -> Response {
    if !ready(&svc).await {
        return unavailable("filter lists are still loading", 2);
    }
    let current = svc.generation.load(std::sync::atomic::Ordering::SeqCst);
    let cached = svc.listing.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|c| c.generation == current);
    let listing = match cached {
        Some(c) => c,
        None => {
            let fresh = render_listing(&svc);
            *svc.listing.lock().unwrap_or_else(|e| e.into_inner()) = Some(fresh.clone());
            fresh
        }
    };
    let etag = HeaderValue::from_str(&format!("\"{}\"", listing.tag)).expect("hex is a valid header value");
    let mut res = if none_match(req.headers(), &listing.tag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut res = Response::new(Body::from(listing.body));
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        res
    };
    let h = res.headers_mut();
    h.insert(header::ETAG, etag);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(REVALIDATE));
    res
}

/// `GET /api/filters/{id}` → the list body (strong SHA-256 `ETag`, `304`, precompressed `br`/`gzip`).
pub async fn body(Ext(svc): Ext<FilterService>, Path(id): Path<String>, req: Request) -> Response {
    let Some(def) = svc.def(&id) else { return ApiError::not_found().into_response() };
    if !ready(&svc).await {
        return unavailable("filter lists are still loading", 2);
    }
    let (accept_br, accept_gzip) = accepted(req.headers());
    let immutable_tag = version_param(&req).map(str::to_owned);
    // Files are content-addressed (store.rs): whatever is read from a version's file is that version. A version that
    // is gone was replaced: look the list up again once (this process's index, or another process's metadata).
    let mut stale: Option<super::Entry> = None;
    for _ in 0..2 {
        let entry = match &stale {
            None => svc.entry(&id),
            Some(old) => svc.reload_entry(&id, old).await,
        };
        let Some(entry) = entry else { break };
        let (Some(files), Some(sha)) = (entry.files.clone(), entry.meta.sha256.clone()) else {
            return unavailable("this filter list has not been downloaded yet", 60);
        };
        let (variant, encoding, suffix): (&Variant, Option<&'static str>, &str) = if accept_br {
            (&files.br, Some("br"), ".br")
        } else if accept_gzip {
            (&files.gzip, Some("gzip"), ".gz")
        } else {
            (&files.identity, None, "")
        };
        let etag = HeaderValue::from_str(&format!("\"{sha}{suffix}\"")).expect("hex is a valid header value");
        let cache = if immutable_tag.as_deref() == Some(sha.as_str()) { IMMUTABLE } else { REVALIDATE };
        let mut res = Response::new(Body::empty());
        let h = res.headers_mut();
        h.insert(header::ETAG, etag);
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
        h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        if none_match(req.headers(), &sha) {
            *res.status_mut() = StatusCode::NOT_MODIFIED;
            svc.stats.served_not_modified.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return res;
        }
        let file = match tokio::fs::File::open(&variant.path).await {
            Ok(f) => f,
            Err(e) => {
                tracing::debug!(list = %id, error = %e, "stored filter list version is gone; looking it up again");
                stale = Some(entry);
                continue;
            }
        };
        match file.metadata().await {
            Ok(m) if m.len() == variant.len => {}
            _ => {
                stale = Some(entry);
                continue;
            }
        }
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static(def.format.content_type()));
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(variant.len));
        if let Some(enc) = encoding {
            h.insert(header::CONTENT_ENCODING, HeaderValue::from_static(enc));
        }
        svc.stats.served.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        *res.body_mut() = Body::from_stream(ReaderStream::with_capacity(file, STREAM_CHUNK));
        return res;
    }
    unavailable("this filter list is being replaced; try again", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(name: header::HeaderName, v: &str) -> HeaderMap {
        let mut m = HeaderMap::new();
        m.insert(name, HeaderValue::from_str(v).unwrap());
        m
    }

    #[test]
    fn if_none_match_matches_every_representation() {
        let sha = "ab12";
        for v in ["\"ab12\"", "W/\"ab12\"", "\"ab12.br\"", "\"x\", \"ab12.gz\"", "*"] {
            assert!(none_match(&h(header::IF_NONE_MATCH, v), sha), "{v}");
        }
        for v in ["\"ab1\"", "\"ab123\"", "\"x.ab12\""] {
            assert!(!none_match(&h(header::IF_NONE_MATCH, v), sha), "{v}");
        }
        assert!(!none_match(&HeaderMap::new(), sha));
    }

    #[test]
    fn encoding_negotiation() {
        let a = |v: &str| accepted(&h(header::ACCEPT_ENCODING, v));
        assert_eq!(a("gzip, deflate, br, zstd"), (true, true));
        assert_eq!(a("gzip"), (false, true));
        assert_eq!(a("br;q=0, gzip;q=0.5"), (false, true));
        assert_eq!(a("*"), (true, true));
        assert_eq!(a("*;q=0, br"), (true, false));
        assert_eq!(a("identity"), (false, false));
        assert_eq!(accepted(&HeaderMap::new()), (false, false));
    }
}
