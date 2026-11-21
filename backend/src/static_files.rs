//! Static serving for both roles (docs/API.md "Static & SPA", ARCHITECTURE §4.6).
//!
//! At startup `GNOME_STATIC_DIR` is scanned into an in-memory index: URL path → content type, cache policy, strong
//! ETag (SHA-256 of the file), optional precompressed `.br` / `.gz` siblings, and the response's
//! Content-Security-Policy: for HTML the shell policy with the file's inline scripts by hash, for engine-host
//! documents under `/engine/` the engine-host policy (plus `GNOME_PROXY_CSP` as a second policy), and on the proxy
//! role a policy for every other file too ([`csp::ProxyPolicies`]: the bare-mux worker's, the script policy, or
//! `default-src 'none'` from the security-headers middleware). Engine-host documents get `%GNOME_APP_ORIGINS%`
//! replaced with the allowed app origins (HTML-attribute-escaped) when indexed; their precompressed siblings are not
//! served. Small files are held in memory; large ones are streamed from disk. Restart the server after deploying a
//! new frontend build, or (development only) set `GNOME_STATIC_RELOAD=true` ([`StaticFiles::serve`]).
//!
//! Lookup for `GET`/`HEAD` (decoded path), by [`Role`]:
//! * every role: reserved prefixes (`/api`, `/admin`, `/wisp`) → 404 JSON;
//! * **app** (two-origin mode): engine prefixes, `/engine/**`, `/sw.js` and `/vendor/**` → plain 404 (they belong
//!   to the proxy origin); otherwise the SPA rules below;
//! * **proxy**: engine prefixes ([`ENGINE_PREFIXES`]) → a small self-retrying `503` page, never the SPA;
//!   `/engine/**` → engine host rules; `/assets/*`, `/sw.js`, `/vendor/**` → exact files; everything else → 404;
//! * **single-origin**: engine prefixes → the `503` page; `/engine/**` → engine host rules; otherwise SPA rules.
//!
//! SPA rules: exact file; directory `index.html`; extension-less paths → `index.html` (client router); otherwise
//! 404. Engine host rules: exact file; directory `index.html`; extension-less paths → `/engine/index.html` (a `503`
//! "not built" page when the build has no engine host); otherwise 404. No query parameter changes any answer.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::body::Body;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;

use crate::config::Config;
use crate::error::ApiError;
use crate::origins::{self, Role};
use crate::security::ClientInfo;
use crate::security::crypto::b64url;
use crate::security::csp::{self, CspHeaders, ProxyPolicies};
use crate::state::AppState;

/// URL prefixes answered by the proxy engines inside the service worker (Scramjet `/~/sj/`, Ultraviolet
/// `/uv/service/`; API.md "Static & SPA"). A request that reaches the server here means the worker was not in
/// control (first visit, restart race, hard reload): it gets [`StaticFiles::engine_unavailable`], never the SPA, and
/// the access log shows only the prefix. This is the one place these prefixes are listed on the server.
pub const ENGINE_PREFIXES: &[&str] = &["/~/sj/", "/uv/service/"];

/// Whether `path` (raw or percent-decoded) lies under an engine prefix.
pub fn is_engine_path(path: &str) -> bool {
    ENGINE_PREFIXES.iter().any(|p| path.starts_with(p))
}

/// Prefixes that never fall back to the SPA (`/x` and `/x/...` → 404 JSON unless a route matches).
pub const RESERVED_PREFIXES: &[&str] = &["/api", "/admin", "/wisp"];

/// Where the engine host lives (`/engine/` → `engine/index.html` of the build; served on the proxy role only).
pub const ENGINE_HOST_PREFIX: &str = "/engine/";

/// Whether `path` is (under) the engine host.
pub fn is_engine_host_path(path: &str) -> bool {
    path.starts_with(ENGINE_HOST_PREFIX)
}

/// Static paths that belong to the proxy origin only: the engine host, the service worker and the vendor builds.
fn proxy_only(path: &str) -> bool {
    is_engine_host_path(path) || path == "/sw.js" || path.starts_with("/vendor/")
}

/// Files up to this size are kept in memory…
const MEMORY_FILE_LIMIT: u64 = 256 * 1024;
/// …until this much memory is used by the index.
const MEMORY_BUDGET: u64 = 32 * 1024 * 1024;
const STREAM_CHUNK: usize = 64 * 1024;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

/// Whether `path` is (under) a reserved prefix.
pub fn is_reserved(path: &str) -> bool {
    RESERVED_PREFIXES.iter().any(|p| path == *p || path.strip_prefix(p).is_some_and(|rest| rest.starts_with('/')))
}

#[derive(Debug, Clone)]
enum BodySource {
    Memory(Bytes),
    Disk(PathBuf),
}

#[derive(Debug, Clone)]
struct Variant {
    etag: HeaderValue,
    len: u64,
    body: BodySource,
}

/// Per-file Content-Security-Policy.
#[derive(Debug)]
enum ResponseCsp {
    /// None of its own: the security-headers middleware applies the role's default (`default-src 'none'` on the
    /// proxy role).
    Default,
    /// The shell policy of an HTML file (app and single-origin roles; on the proxy role the default applies).
    Shell(CspHeaders),
    /// Engine-host documents (`/engine/**` HTML, every role that serves them): the built-in engine-host policy and the
    /// operator's `GNOME_PROXY_CSP` as a second, separate policy.
    Engine { builtin: HeaderValue, operator: Option<HeaderValue> },
    /// A proxy-origin script policy (the script policy, or the bare-mux worker's with the script policy as a second
    /// one). Sent on the proxy role, and in single-origin mode too when `single_origin` (files only the proxy role
    /// serves in two-origin mode).
    Proxy { policy: HeaderValue, second: Option<HeaderValue>, single_origin: bool },
}

/// The placeholder in engine-host documents that is replaced with the allowed app origins.
pub const APP_ORIGINS_PLACEHOLDER: &str = "%GNOME_APP_ORIGINS%";

#[derive(Debug)]
struct Entry {
    content_type: HeaderValue,
    cache_control: HeaderValue,
    /// Per-file headers (`Service-Worker-Allowed` for `/sw.js`).
    extra: Vec<(HeaderName, HeaderValue)>,
    csp: ResponseCsp,
    identity: Variant,
    br: Option<Variant>,
    gzip: Option<Variant>,
    /// An engine-host document whose `%GNOME_APP_ORIGINS%` is filled per request with the origin the request was
    /// addressed to (single-origin mode without `GNOME_PUBLIC_ORIGINS`, where the server cannot know it when it
    /// indexes). The other bodies of this entry are unused.
    template: Option<Arc<str>>,
    /// `GNOME_STATIC_RELOAD`: the file and its (length, mtime) when indexed, to notice a rebuild. `None` for hashed
    /// `/assets/` files (immutable) and without the setting.
    stamp: Option<(PathBuf, FileStamp)>,
}

type FileStamp = (u64, Option<SystemTime>);

fn file_stamp(path: &Path) -> Option<FileStamp> {
    std::fs::metadata(path).ok().map(|m| (m.len(), m.modified().ok()))
}

/// The policies the index needs (from the configuration).
#[derive(Debug, Clone)]
pub struct StaticPolicies {
    pub csp: crate::config::CspMode,
    pub proxy: crate::origins::ProxySetup,
    pub proxy_csp: Option<String>,
    /// `GNOME_ALLOW_CUSTOM_WISP`.
    pub custom_wisp: bool,
    /// `GNOME_PUBLIC_ORIGINS` (normalized).
    pub public_origins: Vec<String>,
    /// `GNOME_STATIC_RELOAD`.
    pub reload: bool,
}

impl StaticPolicies {
    pub fn from_config(config: &Config) -> Self {
        Self {
            csp: config.csp,
            proxy: config.proxy.clone(),
            proxy_csp: config.proxy_csp.clone(),
            custom_wisp: config.allow_custom_wisp,
            public_origins: config.public_origins.clone(),
            reload: config.static_reload,
        }
    }

    /// The proxy-origin policies (retry page hashes included).
    pub fn proxy_policies(&self) -> ProxyPolicies {
        ProxyPolicies::new(&self.proxy, self.custom_wisp, &csp::inline_script_hashes(ENGINE_RETRY_HTML))
    }

    /// The value for `%GNOME_APP_ORIGINS%`: the app origins allowed to frame the engine host (two-origin mode), or
    /// in single-origin mode `GNOME_PUBLIC_ORIGINS`. `None`: single-origin mode without it, where the origin of each
    /// request is used.
    pub fn app_origins_value(&self) -> Option<String> {
        if self.proxy.isolated() {
            Some(self.proxy.app_origins().join(" "))
        } else if !self.public_origins.is_empty() {
            Some(self.public_origins.join(" "))
        } else {
            None
        }
    }
}

/// Escape text for an HTML attribute value (`&`, `<`, `>`, `"`, `'`).
pub fn html_attr_escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Index statistics (diagnostics).
#[derive(Debug, Clone, Default, Serialize)]
pub struct StaticStats {
    pub available: bool,
    pub files: usize,
    pub bytes: u64,
    pub bytes_in_memory: u64,
    pub precompressed: usize,
    pub has_index_html: bool,
}

/// One scan of the static dir.
#[derive(Debug, Default)]
struct Index {
    files: HashMap<String, Arc<Entry>>,
    index: Option<Arc<Entry>>,
    engine_index: Option<Arc<Entry>>,
    stats: StaticStats,
}

impl Index {
    fn load(root: &Path, policies: &StaticPolicies, proxy: &ProxyPolicies) -> Result<Self, String> {
        let files = scan(root, policies, proxy)?;
        let index = files.get("/index.html").cloned();
        let engine_index = files.get("/engine/index.html").cloned();
        let mut stats = StaticStats {
            available: true,
            files: files.len(),
            has_index_html: index.is_some(),
            ..StaticStats::default()
        };
        for e in files.values() {
            stats.bytes += e.identity.len;
            for v in [Some(&e.identity), e.br.as_ref(), e.gzip.as_ref()].into_iter().flatten() {
                if let BodySource::Memory(b) = &v.body {
                    stats.bytes_in_memory += b.len() as u64;
                }
            }
            stats.precompressed += usize::from(e.br.is_some() || e.gzip.is_some());
        }
        if index.is_none() {
            tracing::warn!(dir = %root.display(), "static dir has no index.html; the SPA cannot be served");
        }
        tracing::info!(
            dir = %root.display(),
            files = stats.files,
            precompressed = stats.precompressed,
            in_memory_kib = stats.bytes_in_memory / 1024,
            engine_host = engine_index.is_some(),
            "static index ready"
        );
        Ok(Self { files, index, engine_index, stats })
    }

    fn resolve(&self, path: &str, role: Role) -> Resolved<'_> {
        if is_reserved(path) {
            return Resolved::Reserved;
        }
        match role {
            Role::App => {
                if is_engine_path(path) || proxy_only(path) {
                    return Resolved::NotFound;
                }
                self.spa(path)
            }
            Role::Proxy => {
                if is_engine_path(path) {
                    return Resolved::EngineUnavailable;
                }
                if is_engine_host_path(path) {
                    return self.engine_host(path);
                }
                if path == "/sw.js" || path.starts_with("/vendor/") || path.starts_with("/assets/") {
                    return self.exact(path).map_or(Resolved::NotFound, Resolved::File);
                }
                Resolved::NotFound
            }
            Role::Both => {
                if is_engine_path(path) {
                    return Resolved::EngineUnavailable;
                }
                if is_engine_host_path(path) {
                    return self.engine_host(path);
                }
                self.spa(path)
            }
        }
    }

    /// The file at `path`, or the `index.html` of the directory `path` names.
    fn exact(&self, path: &str) -> Option<&Arc<Entry>> {
        self.files
            .get(path)
            .or_else(|| if path.ends_with('/') { self.files.get(&format!("{path}index.html")) } else { None })
    }

    fn spa(&self, path: &str) -> Resolved<'_> {
        if let Some(e) = self.exact(path) {
            return Resolved::File(e);
        }
        if !has_extension(path) {
            return match &self.index {
                Some(e) => Resolved::File(e),
                None => Resolved::NotBuilt,
            };
        }
        Resolved::NotFound
    }

    fn engine_host(&self, path: &str) -> Resolved<'_> {
        if let Some(e) = self.exact(path) {
            return Resolved::File(e);
        }
        if !has_extension(path) {
            return match &self.engine_index {
                Some(e) => Resolved::File(e),
                None => Resolved::EngineNotBuilt,
            };
        }
        Resolved::NotFound
    }
}

/// `GNOME_STATIC_RELOAD` state.
#[derive(Debug)]
struct Reloader {
    root: PathBuf,
    policies: StaticPolicies,
    /// When the last re-index finished (at most one per [`RELOAD_MIN_GAP`]); held while one runs.
    last: tokio::sync::Mutex<Option<Instant>>,
}

/// `GNOME_STATIC_RELOAD`: minimum time between two re-indexes.
pub const RELOAD_MIN_GAP: Duration = Duration::from_secs(1);

/// The static file index.
#[derive(Debug)]
pub struct StaticFiles {
    current: RwLock<Arc<Index>>,
    proxy: ProxyPolicies,
    reload: Option<Reloader>,
}

/// Per-request inputs of [`StaticFiles::serve`] besides the path.
#[derive(Debug, Clone, Copy)]
pub struct ServeRequest<'a> {
    pub headers: &'a HeaderMap,
    pub head: bool,
    pub role: Role,
    /// The origin the request was addressed to (fills `%GNOME_APP_ORIGINS%` in single-origin mode without
    /// `GNOME_PUBLIC_ORIGINS`).
    pub app_origin: Option<&'a str>,
}

impl StaticFiles {
    /// Scan `root`. Problems are logged; a missing directory yields an empty index that serves the "not built" page.
    pub fn load(root: &Path, policies: &StaticPolicies) -> Self {
        let proxy = policies.proxy_policies();
        let index = Index::load(root, policies, &proxy).unwrap_or_else(|e| {
            tracing::warn!(
                dir = %root.display(),
                error = %e,
                "frontend not available; serving a 'not built' page (set GNOME_STATIC_DIR or build the frontend)"
            );
            Index::default()
        });
        let reload = policies.reload.then(|| Reloader {
            root: root.to_path_buf(),
            policies: policies.clone(),
            last: tokio::sync::Mutex::new(None),
        });
        Self { current: RwLock::new(Arc::new(index)), proxy, reload }
    }

    fn current(&self) -> Arc<Index> {
        self.current.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn stats(&self) -> StaticStats {
        self.current().stats.clone()
    }

    /// The proxy-origin policies this index applies (the security-headers middleware computes the same `none`).
    pub fn proxy_policies(&self) -> &ProxyPolicies {
        &self.proxy
    }

    /// `GNOME_STATIC_RELOAD`: re-index unless `seen` is already outdated (then the newer index is returned) or the
    /// last re-index finished less than [`RELOAD_MIN_GAP`] ago (`None`). A failed scan keeps the old index.
    async fn reindex(&self, seen: &Arc<Index>) -> Option<Arc<Index>> {
        let r = self.reload.as_ref()?;
        let mut last = r.last.lock().await;
        let now = self.current();
        if !Arc::ptr_eq(&now, seen) {
            return Some(now);
        }
        if last.is_some_and(|t| t.elapsed() < RELOAD_MIN_GAP) {
            return None;
        }
        let (root, policies, proxy) = (r.root.clone(), r.policies.clone(), self.proxy.clone());
        let scanned = tokio::task::spawn_blocking(move || Index::load(&root, &policies, &proxy)).await;
        *last = Some(Instant::now());
        match scanned {
            Ok(Ok(index)) => {
                let index = Arc::new(index);
                *self.current.write().unwrap_or_else(|e| e.into_inner()) = index.clone();
                Some(index)
            }
            Ok(Err(e)) => {
                tracing::warn!(dir = %r.root.display(), error = %e, "static re-index failed; keeping the old index");
                None
            }
            Err(e) => {
                tracing::warn!(error = %e, "static re-index panicked; keeping the old index");
                None
            }
        }
    }

    /// Serve `raw_path` (percent-encoded request path). With `GNOME_STATIC_RELOAD` the index is rebuilt first when
    /// the path misses under `/assets/`, `/engine/`, `/sw.js` or `/vendor/` (or the build has no `index.html`), or
    /// when the indexed file of an unhashed path changed on disk.
    pub async fn serve(&self, raw_path: &str, req: ServeRequest<'_>) -> Response {
        let Ok(path) = percent_decode_str(raw_path).decode_utf8() else {
            return not_found();
        };
        if path.contains('\0') {
            return not_found();
        }
        let mut index = self.current();
        if self.reload.is_some()
            && self.wants_reindex(&index, &path, req.role)
            && let Some(newer) = self.reindex(&index).await
        {
            index = newer;
        }
        match index.resolve(&path, req.role) {
            Resolved::File(entry) => respond(entry, req).await,
            Resolved::Reserved => ApiError::not_found().into_response(),
            Resolved::EngineUnavailable => self.engine_unavailable(req.head),
            Resolved::NotBuilt => not_built(req.head, NOT_BUILT_HTML, None),
            Resolved::EngineNotBuilt => not_built(req.head, ENGINE_NOT_BUILT_HTML, Some(&self.proxy.styled)),
            Resolved::NotFound => not_found(),
        }
    }

    fn wants_reindex(&self, index: &Index, path: &str, role: Role) -> bool {
        match index.resolve(path, role) {
            Resolved::File(entry) => {
                entry.stamp.as_ref().is_some_and(|(file, stamp)| file_stamp(file).as_ref() != Some(stamp))
            }
            Resolved::NotFound | Resolved::EngineNotBuilt => {
                path.starts_with("/assets/") || (role.serves_proxy() && proxy_only(path))
            }
            Resolved::NotBuilt => true,
            Resolved::Reserved | Resolved::EngineUnavailable => false,
        }
    }

    /// `503` answer for engine prefixes (see [`ENGINE_PREFIXES`]).
    pub fn engine_unavailable(&self, head: bool) -> Response {
        let body = if head { Body::empty() } else { Body::from(ENGINE_RETRY_HTML) };
        let mut res = (StatusCode::SERVICE_UNAVAILABLE, body).into_response();
        let h = res.headers_mut();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        h.insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        h.insert(header::CONTENT_SECURITY_POLICY, self.proxy.retry.clone());
        res
    }
}

/// Whether the last path segment has a dot (`/a/b.js`); such paths never fall back to an HTML entry point.
fn has_extension(path: &str) -> bool {
    path.rsplit('/').next().unwrap_or("").contains('.')
}

enum Resolved<'a> {
    File(&'a Arc<Entry>),
    /// A reserved prefix reached only after percent-decoding (`/%61pi/…`).
    Reserved,
    EngineUnavailable,
    NotBuilt,
    EngineNotBuilt,
    NotFound,
}

/// Router fallback of the public routers (static files for `role`).
pub async fn fallback(state: AppState, role: Role, req: Request) -> Response {
    let path = req.uri().path();
    // Checked on the decoded path too, so `/%61pi/…` is a JSON 404 for every method, like `/api/…`.
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    if is_reserved(path) || is_reserved(&decoded) {
        return ApiError::not_found().into_response();
    }
    let head = req.method() == Method::HEAD;
    if req.method() != Method::GET && !head {
        let mut res = ApiError::method_not_allowed().into_response();
        res.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return res;
    }
    // Only single-origin mode without GNOME_PUBLIC_ORIGINS templates per request (`Entry::template`).
    let app_origin = if state.config.proxy.isolated() || !state.config.public_origins.is_empty() {
        None
    } else {
        let client = req.extensions().get::<ClientInfo>().cloned().unwrap_or_else(ClientInfo::unknown);
        origins::app_origin(&state.config, &client)
    };
    let serve = ServeRequest { headers: req.headers(), head, role, app_origin: app_origin.as_deref() };
    state.static_files.serve(path, serve).await
}

fn not_found() -> Response {
    let mut res = (StatusCode::NOT_FOUND, "404 Not Found\n").into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_CACHE));
    res
}

const NOT_BUILT_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GNOME · frontend not built</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0d; color: #ece6d8;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 36rem; padding: 2rem; border-top: 1px solid rgba(236, 228, 208, 0.14); }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; color: #d6b47a; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: #1a1a16; padding: 0.1em 0.35em;
         border-radius: 4px; }
  a { color: #e6c78f; }
  p { color: #b4ac9b; }
</style>
</head>
<body>
<main>
<h1>The GNOME web interface has not been built yet</h1>
<p>gnome-server is running, but it could not find a built frontend (no <code>index.html</code> in
<code>GNOME_STATIC_DIR</code>).</p>
<p>Build it with <code>npm --prefix frontend ci &amp;&amp; npm --prefix frontend run build</code>, or set
<code>GNOME_STATIC_DIR</code> to a built copy, then restart the server.</p>
<p>The API is up: <a href="/api/health">/api/health</a>.</p>
</main>
</body>
</html>
"#;

/// Shown on `/engine/` when the frontend build has no engine host (`engine/index.html`).
const ENGINE_NOT_BUILT_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GNOME · engine host not built</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0d; color: #ece6d8;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.75rem; color: #d6b47a; }
  p { color: #b4ac9b; margin: 0; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<main>
<h1>The proxy engine host is not part of this build</h1>
<p>gnome-server found no <code>engine/index.html</code> in <code>GNOME_STATIC_DIR</code>, so the in-browser proxy
cannot start. Deploy a frontend build that includes the engine host, then restart the server.</p>
</main>
</body>
</html>
"#;

/// A compiled-in "not built" page; `csp`: its policy on the engine-host paths (the app's come from the middleware).
fn not_built(head: bool, page: &'static str, csp: Option<&HeaderValue>) -> Response {
    let body = if head { Body::empty() } else { Body::from(page) };
    let mut res = (StatusCode::SERVICE_UNAVAILABLE, body).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(csp) = csp {
        h.insert(header::CONTENT_SECURITY_POLICY, csp.clone());
    }
    res
}

/// Shown when an engine URL reaches the server because the service worker was not in control. The script
/// (re-)registers `/sw.js` (scope `/`) and reloads with a capped exponential backoff (0.25 s, 1 s, 2 s, 4 s, 8 s:
/// at most 5 attempts per URL within two minutes, tracked in `sessionStorage`), then explains what to do. Where
/// service workers do not exist (an insecure context) it explains that at once and never reloads. It runs under a
/// CSP that allows exactly this script by hash (compiled in: works without a static dir).
const ENGINE_RETRY_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>GNOME · starting the proxy engine</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f0f0d; color: #ece6d8;
         font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.75rem; color: #d6b47a; }
  p { color: #b4ac9b; margin: 0 0 0.75rem; }
  a { color: #e6c78f; }
</style>
</head>
<body>
<main>
<h1>Starting the proxy engine</h1>
<p id="status">This page was requested before GNOME's proxy service worker was ready. Retrying&hellip;</p>
<p><a id="again" href="">Try again</a></p>
</main>
<script>
(function () {
  var status = document.getElementById('status');
  var key = 'gnome:engine-retry';
  var delays = [250, 1000, 2000, 4000, 8000];
  var now = Date.now();
  var tries = delays.length;
  try {
    var saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    tries = saved && saved.u === location.href && now - saved.t < 120000 ? saved.n : 0;
    sessionStorage.setItem(key, JSON.stringify({ u: location.href, n: tries + 1, t: saved && tries ? saved.t : now }));
  } catch (e) {
    tries = delays.length;
  }
  if (tries >= delays.length) {
    status.textContent = 'The proxy engine did not start. Reload GNOME and open the page again.';
    return;
  }
  var sw = navigator.serviceWorker;
  if (!sw) {
    status.textContent = 'Service workers are unavailable here (GNOME must be served over HTTPS).';
    return;
  }
  var delay = delays[tries];
  var done = false;
  function retry() {
    if (!done) {
      done = true;
      location.reload();
    }
  }
  setTimeout(retry, delay + 4000);
  sw.register('/sw.js', { scope: '/' }).then(function () {
    return sw.ready;
  }).then(function () {
    setTimeout(retry, delay);
  }, function () {});
})();
</script>
</body>
</html>
"#;

/// `(br, gzip)` acceptable per `Accept-Encoding` (q=0 excludes; `*` covers unlisted codings).
fn accepted_encodings(value: Option<&HeaderValue>) -> (bool, bool) {
    let Some(s) = value.and_then(|v| v.to_str().ok()) else { return (false, false) };
    let (mut br, mut gzip, mut star) = (None, None, None);
    for item in s.split(',') {
        let mut parts = item.split(';');
        let name = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        let mut q = 1.0f32;
        for p in parts {
            let p = p.trim();
            if let Some(v) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                q = v.trim().parse().unwrap_or(0.0);
            }
        }
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

/// `If-None-Match` matches `etag` (weak comparison, `*` matches anything).
fn none_match(req_headers: &HeaderMap, etag: &HeaderValue) -> bool {
    let target = etag.to_str().unwrap_or_default();
    req_headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t == "*" || t.trim_start_matches("W/") == target)
}

async fn respond(entry: &Entry, req: ServeRequest<'_>) -> Response {
    if let Some(template) = &entry.template {
        return respond_templated(entry, template, req);
    }
    let (req_headers, head, role) = (req.headers, req.head, req.role);
    let (accept_br, accept_gzip) = accepted_encodings(req_headers.get(header::ACCEPT_ENCODING));
    let (variant, encoding) = match (&entry.br, &entry.gzip) {
        (Some(br), _) if accept_br => (br, Some("br")),
        (_, Some(gz)) if accept_gzip => (gz, Some("gzip")),
        _ => (&entry.identity, None),
    };
    let varies = entry.br.is_some() || entry.gzip.is_some();

    let mut res = Response::new(Body::empty());
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, entry.cache_control.clone());
    if varies {
        h.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    apply_csp(h, &entry.csp, role);
    if none_match(req_headers, &variant.etag) {
        h.insert(header::ETAG, variant.etag.clone());
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        return res;
    }

    let (body, len, etag_valid) = match &variant.body {
        BodySource::Memory(bytes) => (if head { Body::empty() } else { Body::from(bytes.clone()) }, variant.len, true),
        BodySource::Disk(path) => {
            let file = match tokio::fs::File::open(path).await {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "indexed static file is gone; restart after redeploying the frontend");
                    return not_found();
                }
            };
            let actual = file.metadata().await.map(|m| m.len()).unwrap_or(variant.len);
            if actual != variant.len {
                tracing::warn!(path = %path.display(), "static file changed since startup; serving it uncached (restart to re-index)");
            }
            let body =
                if head { Body::empty() } else { Body::from_stream(ReaderStream::with_capacity(file, STREAM_CHUNK)) };
            (body, actual, actual == variant.len)
        }
    };

    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, entry.content_type.clone());
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if etag_valid {
        h.insert(header::ETAG, variant.etag.clone());
    } else {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(NO_CACHE));
    }
    if let Some(enc) = encoding {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static(enc));
    }
    for (name, value) in &entry.extra {
        h.insert(name.clone(), value.clone());
    }
    *res.body_mut() = body;
    res
}

/// An engine-host document filled with the request's origin (see [`Entry::template`]): built per request, never
/// precompressed, its ETag the hash of the result.
fn respond_templated(entry: &Entry, template: &str, req: ServeRequest<'_>) -> Response {
    let html = template.replace(APP_ORIGINS_PLACEHOLDER, &html_attr_escape(req.app_origin.unwrap_or("")));
    let tag: [u8; 32] = Sha256::digest(html.as_bytes()).into();
    let etag = HeaderValue::from_str(&format!("\"{}\"", b64url(&tag[..16]))).expect("etag is ASCII");
    let mut res = Response::new(Body::empty());
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, entry.cache_control.clone());
    apply_csp(h, &entry.csp, req.role);
    h.insert(header::ETAG, etag.clone());
    if none_match(req.headers, &etag) {
        *res.status_mut() = StatusCode::NOT_MODIFIED;
        return res;
    }
    h.insert(header::CONTENT_TYPE, entry.content_type.clone());
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(html.len()));
    if !req.head {
        *res.body_mut() = Body::from(html);
    }
    res
}

fn apply_csp(h: &mut HeaderMap, csp: &ResponseCsp, role: Role) {
    match csp {
        ResponseCsp::Shell(csp) if role.serves_app() => {
            h.insert(header::CONTENT_SECURITY_POLICY, csp.enforce.clone());
            if let Some(ro) = &csp.report_only {
                h.insert(header::CONTENT_SECURITY_POLICY_REPORT_ONLY, ro.clone());
            }
        }
        ResponseCsp::Engine { builtin, operator } => {
            h.insert(header::CONTENT_SECURITY_POLICY, builtin.clone());
            if let Some(op) = operator {
                h.append(header::CONTENT_SECURITY_POLICY, op.clone());
            }
        }
        ResponseCsp::Proxy { policy, second, single_origin }
            if role == Role::Proxy || (role == Role::Both && *single_origin) =>
        {
            h.insert(header::CONTENT_SECURITY_POLICY, policy.clone());
            if let Some(second) = second {
                h.append(header::CONTENT_SECURITY_POLICY, second.clone());
            }
        }
        ResponseCsp::Shell(_) | ResponseCsp::Proxy { .. } | ResponseCsp::Default => {}
    }
}

/// Content type by extension (`.mjs` → `text/javascript`, `.wasm` → `application/wasm`, …).
pub fn content_type(path: &str) -> &'static str {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some((_, ext)) = name.rsplit_once('.') else {
        // LICENSE, NOTICE, COPYING…
        return "text/plain; charset=utf-8";
    };
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "txt" | "license" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

fn cache_policy(url: &str) -> &'static str {
    if url.starts_with("/assets/") { IMMUTABLE } else { NO_CACHE }
}

/// Collect regular files under `dir` as URL path → (filesystem path, length).
fn walk(dir: &Path, prefix: &str, out: &mut BTreeMap<String, (PathBuf, u64)>, depth: usize) -> std::io::Result<()> {
    if depth > 32 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            tracing::warn!(path = %entry.path().display(), "skipping static file with a non-UTF-8 name");
            continue;
        };
        if name.starts_with('.') && name != ".well-known" {
            continue;
        }
        let path = entry.path();
        let url = format!("{prefix}/{name}");
        let ft = entry.file_type()?;
        if ft.is_dir() {
            walk(&path, &url, out, depth + 1)?;
        } else if ft.is_file() {
            out.insert(url, (path, entry.metadata()?.len()));
        } else if ft.is_symlink() {
            // Follow links to files (not directories, to avoid cycles).
            if let Ok(meta) = std::fs::metadata(&path)
                && meta.is_file()
            {
                out.insert(url, (path, meta.len()));
            }
        }
    }
    Ok(())
}

/// Read a file, hashing it; keep the bytes when small enough and within budget.
fn read_hashed(path: &Path, len: u64, budget: &mut u64) -> std::io::Result<([u8; 32], Option<Bytes>)> {
    let mut file = std::fs::File::open(path)?;
    let keep = len <= MEMORY_FILE_LIMIT && len <= *budget;
    let mut hasher = Sha256::new();
    if keep {
        let mut buf = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
        file.read_to_end(&mut buf)?;
        hasher.update(&buf);
        *budget -= buf.len() as u64;
        Ok((hasher.finalize().into(), Some(Bytes::from(buf))))
    } else {
        let mut buf = vec![0u8; STREAM_CHUNK];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok((hasher.finalize().into(), None))
    }
}

fn load_sibling(path: &Path, len: u64, etag: String, budget: &mut u64) -> std::io::Result<Variant> {
    let body = if len <= MEMORY_FILE_LIMIT && len <= *budget {
        let bytes = std::fs::read(path)?;
        *budget -= bytes.len() as u64;
        BodySource::Memory(Bytes::from(bytes))
    } else {
        BodySource::Disk(path.to_path_buf())
    };
    Ok(Variant { etag: HeaderValue::from_str(&etag).expect("etag is ASCII"), len, body })
}

/// The policy of a non-HTML file, by URL (see [`ResponseCsp`]). The bare-mux worker gets the contract's
/// `bareMuxWorkerCsp()` and, as a second policy, the script policy: `connect-src 'self'` alone leaves its realm free
/// to load images, frames and scripts from anywhere (as a worker: `importScripts`/`import()` of any URL; as a framed
/// document: `<img>`, `<iframe>`, `import()`), which the e2e realm check showed in both browsers. Under the
/// custom-Wisp opt-in that second policy's `connect-src` has `ws: wss:` too ([`ProxyPolicies::bare_mux_worker_script`]).
fn file_csp(url: &str, content_type: &str, proxy: &ProxyPolicies) -> ResponseCsp {
    if url == csp::BARE_MUX_WORKER_PATH {
        return ResponseCsp::Proxy {
            policy: proxy.bare_mux_worker.clone(),
            second: Some(proxy.bare_mux_worker_script.clone()),
            single_origin: true,
        };
    }
    if content_type.starts_with("text/javascript") {
        return ResponseCsp::Proxy { policy: proxy.script.clone(), second: None, single_origin: proxy_only(url) };
    }
    ResponseCsp::Default
}

fn scan(root: &Path, policies: &StaticPolicies, proxy: &ProxyPolicies) -> Result<HashMap<String, Arc<Entry>>, String> {
    let meta = std::fs::metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    let mut found = BTreeMap::new();
    walk(root, "", &mut found, 0).map_err(|e| e.to_string())?;
    let app_origins = policies.app_origins_value().map(|v| html_attr_escape(&v));
    let operator = policies.proxy_csp.as_deref();
    let mut budget = MEMORY_BUDGET;
    let mut files = HashMap::with_capacity(found.len());
    for (url, (path, len)) in &found {
        let is_sibling =
            [".br", ".gz"].iter().any(|ext| url.strip_suffix(ext).is_some_and(|base| found.contains_key(base)));
        if is_sibling {
            continue;
        }
        let stamp = if policies.reload && !url.starts_with("/assets/") {
            file_stamp(path).map(|st| (path.clone(), st))
        } else {
            None
        };
        let (mut hash, mut bytes) =
            read_hashed(path, *len, &mut budget).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut len = *len;
        let content_type = content_type(url);
        let mut extra = Vec::new();
        let mut csp = file_csp(url, content_type, proxy);
        let mut template = None;
        let mut templated = false;
        if content_type.starts_with("text/html") {
            let mut text = match &bytes {
                Some(b) => String::from_utf8_lossy(b).into_owned(),
                None => String::from_utf8_lossy(&std::fs::read(path).map_err(|e| e.to_string())?).into_owned(),
            };
            if is_engine_host_path(url) && text.contains(APP_ORIGINS_PLACEHOLDER) {
                templated = true;
                match &app_origins {
                    Some(value) => {
                        text = text.replace(APP_ORIGINS_PLACEHOLDER, value);
                        let filled = Bytes::from(text.clone().into_bytes());
                        hash = Sha256::digest(&filled).into();
                        len = filled.len() as u64;
                        bytes = Some(filled);
                    }
                    None => template = Some(Arc::<str>::from(text.as_str())),
                }
            }
            let hashes = csp::inline_script_hashes(&text);
            csp = if is_engine_host_path(url) {
                ResponseCsp::Engine {
                    builtin: proxy.engine_host.clone(),
                    operator: operator.map(|o| csp::operator_engine_policy(o, &hashes)),
                }
            } else {
                ResponseCsp::Shell(csp::headers_for(policies.csp, &policies.proxy, &hashes))
            };
        }
        if url == "/sw.js" {
            extra.push((HeaderName::from_static("service-worker-allowed"), HeaderValue::from_static("/")));
        }
        let tag = b64url(&hash[..16]);
        let identity = Variant {
            etag: HeaderValue::from_str(&format!("\"{tag}\"")).expect("etag is ASCII"),
            len,
            body: match bytes {
                Some(b) => BodySource::Memory(b),
                None => BodySource::Disk(path.clone()),
            },
        };
        let sibling = |ext: &str, suffix: &str, budget: &mut u64| -> Result<Option<Variant>, String> {
            // Precompressed copies of a templated document would carry the placeholder: not served.
            if templated {
                return Ok(None);
            }
            match found.get(&format!("{url}{ext}")) {
                Some((p, l)) => load_sibling(p, *l, format!("\"{tag}-{suffix}\""), budget)
                    .map(Some)
                    .map_err(|e| format!("{}: {e}", p.display())),
                None => Ok(None),
            }
        };
        let br = sibling(".br", "br", &mut budget)?;
        let gzip = sibling(".gz", "gz", &mut budget)?;
        files.insert(
            url.clone(),
            Arc::new(Entry {
                content_type: HeaderValue::from_static(content_type),
                cache_control: HeaderValue::from_static(cache_policy(url)),
                extra,
                csp,
                identity,
                br,
                gzip,
                template,
                stamp,
            }),
        );
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_prefixes() {
        for p in ["/~/sj/abc/def/https%3A%2F%2Fexample.com", "/uv/service/hvtrs8%2F-ezaopng.aoo%2F"] {
            assert!(is_engine_path(p), "{p}");
        }
        for p in ["/", "/~/", "/~/sx/x", "/uv/", "/scramjet/x", "/browse"] {
            assert!(!is_engine_path(p), "{p}");
        }
        let hashes = csp::inline_script_hashes(ENGINE_RETRY_HTML);
        assert_eq!(hashes.len(), 1, "the retry page has exactly one inline script");
        let policies = StaticPolicies {
            csp: crate::config::CspMode::On,
            proxy: crate::origins::ProxySetup::single_origin(),
            proxy_csp: None,
            custom_wisp: false,
            public_origins: Vec::new(),
            reload: false,
        };
        let files = StaticFiles::load(Path::new("/nonexistent/gnome-static"), &policies);
        let res = files.engine_unavailable(false);
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        let policy = res.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(policy.contains(&hashes[0]) && policy.contains("worker-src 'self'"), "{policy}");
        for p in ["/engine/", "/engine/tab", "/engine/assets/x.js"] {
            assert!(is_engine_host_path(p), "{p}");
        }
        for p in ["/engine", "/engines/", "/x/engine/"] {
            assert!(!is_engine_host_path(p), "{p}");
        }
    }

    #[test]
    fn templated_values_cannot_leave_the_attribute() {
        // The app origins are normalized before they get here (no quotes or brackets can pass), so this is the second
        // line of defence for `content="%GNOME_APP_ORIGINS%"`.
        assert_eq!(html_attr_escape("https://a.example https://b.example"), "https://a.example https://b.example");
        assert_eq!(html_attr_escape("x\" onload='y'><script>&"), "x&quot; onload=&#39;y&#39;&gt;&lt;script&gt;&amp;");
    }

    #[test]
    fn reserved_prefixes() {
        for p in ["/api", "/api/", "/api/x", "/admin", "/admin/diagnostics", "/wisp", "/wisp/"] {
            assert!(is_reserved(p), "{p}");
        }
        for p in ["/", "/apis", "/administrator", "/wispy", "/games/api"] {
            assert!(!is_reserved(p), "{p}");
        }
    }

    #[test]
    fn encoding_negotiation() {
        let v = |s: &'static str| Some(HeaderValue::from_static(s));
        assert_eq!(accepted_encodings(v("gzip, deflate, br, zstd").as_ref()), (true, true));
        assert_eq!(accepted_encodings(v("gzip").as_ref()), (false, true));
        assert_eq!(accepted_encodings(v("br;q=0, gzip;q=0.5").as_ref()), (false, true));
        assert_eq!(accepted_encodings(v("*").as_ref()), (true, true));
        assert_eq!(accepted_encodings(v("*;q=0, br").as_ref()), (true, false));
        assert_eq!(accepted_encodings(v("identity").as_ref()), (false, false));
        assert_eq!(accepted_encodings(None), (false, false));
    }

    #[test]
    fn if_none_match() {
        let etag = HeaderValue::from_static("\"abc\"");
        let mut h = HeaderMap::new();
        assert!(!none_match(&h, &etag));
        h.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"x\", W/\"abc\""));
        assert!(none_match(&h, &etag));
        h.insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(none_match(&h, &etag));
        h.insert(header::IF_NONE_MATCH, HeaderValue::from_static("\"abc-br\""));
        assert!(!none_match(&h, &etag));
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type("/a/b.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("/x.wasm"), "application/wasm");
        assert_eq!(content_type("/manifest.webmanifest"), "application/manifest+json");
        assert_eq!(content_type("/vendor/scramjet/LICENSE"), "text/plain; charset=utf-8");
        assert_eq!(content_type("/FONT.WOFF2"), "font/woff2");
        assert_eq!(content_type("/x.unknownext"), "application/octet-stream");
    }

    #[test]
    fn cache_policies() {
        assert_eq!(cache_policy("/assets/app-1a2b.js"), IMMUTABLE);
        assert_eq!(cache_policy("/sw.js"), NO_CACHE);
        assert_eq!(cache_policy("/vendor/uv/uv.bundle.js"), NO_CACHE);
    }
}
