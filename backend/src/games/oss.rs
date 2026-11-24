//! Open-source game builds (WAVE-C D5, D6): which manifest entries have a build on disk ([`OssBuilds::rescan`]),
//! the fetch of an entry's pinned commit from GitHub's commit tarballs ([`OssBuilds::fetch`]), and serving the
//! builds on the proxy origin under `/oss/<slug>/**` ([`serve`]).
//!
//! The proxy origin is one shared realm (the engines' cookie jars, the service workers, the engine host), so only
//! reviewed entries are fetched or served, only the manifest's `entry` file is served as HTML and only to frame
//! loads, and every answer carries a policy at least as strict as `PROXIED_DOCUMENT_CSP`.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::response::{IntoResponse, Response};
use gnome_catalog::sources::oss::{OssEntry, load_manifest};
use gnome_catalog::{CatalogConfig, Source};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::security::crypto::hex;
use crate::security::csp;
use crate::state::AppState;
use crate::util::now_ms;

/// The build's file index written by [`OssBuilds::fetch`].
pub const INDEX_FILE: &str = ".gnome-oss.json";
/// Downloaded archive cap (SafeClient body cap: a tarball is not content-encoded, so this caps the gzip stream).
pub const MAX_ARCHIVE_BYTES: u64 = 64 << 20;
/// Decompressed tar bytes in total, headers included.
pub const MAX_TAR_BYTES: u64 = 129 << 20;
/// PAX and GNU long-name/long-link entries are read only up to this size.
pub const MAX_EXTENSION_BYTES: u64 = 64 << 10;
/// Entries per build.
pub const MAX_ENTRIES: u32 = 20_000;
/// Bytes written per build.
pub const MAX_BUILD_BYTES: u64 = 128 << 20;
/// Whole-fetch timeout.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Host the fetch may contact.
pub const ARCHIVE_HOST: &str = "codeload.github.com";
const MAX_REQUEST_PATH: usize = 1024;
const STREAM_CHUNK: usize = 64 * 1024;

/// One served build.
#[derive(Debug, Clone)]
pub struct OssBuild {
    pub slug: String,
    pub entry: String,
    /// `https://github.com/<owner>/<repo>`; `None` for a `local` build.
    pub repository: Option<String>,
    /// The commit of the build on disk (`.gnome-oss.json`), else the manifest's.
    pub commit: Option<String>,
    pub license_file: Option<String>,
    /// Manifest flags (WAVE-C §4.8 item 5): an opaque-origin sandbox, pointer lock, gamepad.
    pub isolated: bool,
    pub pointer_lock: bool,
    pub gamepad: bool,
    /// path → sha256 hex, from `.gnome-oss.json` (absent for hand-copied builds).
    pub files: Option<Arc<HashMap<String, String>>>,
}

/// What `rescan` found, by slug (each list sorted).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct OssScan {
    /// Built and served now.
    pub served: Vec<String>,
    /// Enabled and pinned, no build on disk.
    pub missing: Vec<String>,
    /// A build at another commit than the manifest's (still served until re-fetched).
    pub outdated: Vec<String>,
    /// Enabled without a 40-hex commit (never fetched; `local` entries are not listed here).
    pub unpinned: Vec<String>,
    /// The served set differs from the previous scan (the import job's trigger).
    pub changed: bool,
}

/// One finished fetch.
#[derive(Debug, Clone, Serialize)]
pub struct OssFetchReport {
    pub slug: String,
    pub commit: String,
    pub files: u32,
    pub bytes: u64,
    pub skipped_links: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct BuildIndex {
    commit: String,
    fetched_at: i64,
    files: BTreeMap<String, String>,
}

/// The builds under `GNOME_OSS_GAMES_DIR`, by slug.
#[derive(Debug)]
pub struct OssBuilds {
    dir: PathBuf,
    max_bytes: u64,
    /// `oss` is an enabled source (two-origin mode only).
    enabled: bool,
    served: RwLock<HashMap<String, OssBuild>>,
    scan: RwLock<OssScan>,
    failed: RwLock<Vec<String>>,
    last_fetch: Mutex<Option<OssFetchReport>>,
    fetching: std::sync::atomic::AtomicBool,
}

impl OssBuilds {
    pub fn new(config: &Config) -> Self {
        Self {
            dir: config.catalog.oss.builds_dir.clone(),
            max_bytes: u64::from(config.oss_max_mb) << 20,
            enabled: config.catalog.sources.contains(&Source::Oss),
            served: RwLock::new(HashMap::new()),
            scan: RwLock::new(OssScan::default()),
            failed: RwLock::new(Vec::new()),
            last_fetch: Mutex::new(None),
            fetching: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The builds directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Re-read the manifest (`GNOME_OSS_MANIFEST` or the built-in one) and each enabled entry's build directory.
    pub fn rescan(&self, catalog: &CatalogConfig) -> Result<OssScan, String> {
        let mut scan = OssScan::default();
        let mut served = HashMap::new();
        if self.enabled {
            let manifest = load_manifest(&catalog.oss).map_err(|e| e.to_string())?;
            for e in manifest.games.iter().filter(|e| e.enabled) {
                if !e.local && e.commit.is_none() {
                    scan.unpinned.push(e.slug.clone());
                    continue;
                }
                if !e.servable() {
                    continue;
                }
                let build_dir = self.dir.join(&e.slug);
                if !is_regular_file_below(&build_dir, &e.entry) {
                    if !e.local {
                        scan.missing.push(e.slug.clone());
                    }
                    continue;
                }
                let index = read_index(&build_dir);
                let commit = index.as_ref().map(|i| i.commit.clone()).or_else(|| e.commit.clone());
                if !e.local && index.as_ref().is_some_and(|i| Some(&i.commit) != e.commit.as_ref()) {
                    scan.outdated.push(e.slug.clone());
                }
                scan.served.push(e.slug.clone());
                served.insert(e.slug.clone(), build_of(e, commit, index));
            }
        }
        scan.served.sort();
        scan.missing.sort();
        scan.outdated.sort();
        scan.unpinned.sort();
        let previous = self.scan.read().unwrap_or_else(|e| e.into_inner()).served.clone();
        scan.changed = previous != scan.served;
        *self.served.write().unwrap_or_else(|e| e.into_inner()) = served;
        *self.scan.write().unwrap_or_else(|e| e.into_inner()) = scan.clone();
        Ok(scan)
    }

    /// The served build of `slug` (enabled, reviewed, `oss` enabled, entry file present).
    pub fn get(&self, slug: &str) -> Option<OssBuild> {
        self.served.read().unwrap_or_else(|e| e.into_inner()).get(slug).cloned()
    }

    /// The last scan.
    pub fn last_scan(&self) -> OssScan {
        self.scan.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Slugs whose last fetch failed (metrics `state="failed"`).
    pub fn failed(&self) -> Vec<String> {
        self.failed.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn last_fetch(&self) -> Option<OssFetchReport> {
        self.last_fetch.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Whether a fetch is running (admin `409`).
    pub fn is_fetching(&self) -> bool {
        self.fetching.load(std::sync::atomic::Ordering::Acquire)
    }

    /// Mark a fetch run as started (`false` when one is already running).
    pub fn begin_fetching(&self) -> bool {
        use std::sync::atomic::Ordering;
        self.fetching.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }

    /// Mark the fetch run as finished.
    pub fn end_fetching(&self) {
        self.fetching.store(false, std::sync::atomic::Ordering::Release);
    }

    /// The entries [`OssBuilds::fetch`] would fetch by default: enabled, reviewed, pinned, not local, and missing or
    /// at another commit.
    pub fn due(&self, catalog: &CatalogConfig) -> Vec<String> {
        let Ok(manifest) = load_manifest(&catalog.oss) else { return Vec::new() };
        manifest
            .games
            .iter()
            .filter(|e| e.servable() && !e.local && e.commit.is_some())
            .filter(|e| {
                let dir = self.dir.join(&e.slug);
                !is_regular_file_below(&dir, &e.entry)
                    || read_index(&dir).is_none_or(|i| Some(&i.commit) != e.commit.as_ref())
            })
            .map(|e| e.slug.clone())
            .collect()
    }

    /// Why `slug` cannot be fetched (`None` = it can): the admin endpoint's 422 messages.
    pub fn fetch_refusal(catalog: &CatalogConfig, slug: &str) -> Option<&'static str> {
        let Ok(manifest) = load_manifest(&catalog.oss) else { return Some("unknown entry") };
        let Some(e) = manifest.games.iter().find(|e| e.slug == slug) else { return Some("unknown entry") };
        if e.local {
            Some("a local build")
        } else if !e.servable() {
            Some("not enabled")
        } else if e.commit.is_none() {
            Some("not pinned to a commit")
        } else {
            None
        }
    }

    /// D6: download, check and install one entry's pinned commit. A failure leaves the old build in place.
    pub async fn fetch(
        &self,
        catalog: &CatalogConfig,
        slug: &str,
        client: &gnome_net::SafeClient,
        shutdown: &CancellationToken,
    ) -> Result<OssFetchReport, String> {
        let result = self.fetch_inner(catalog, slug, client, shutdown).await;
        let mut failed = self.failed.write().unwrap_or_else(|e| e.into_inner());
        failed.retain(|s| s != slug);
        match &result {
            Ok(report) => *self.last_fetch.lock().unwrap_or_else(|e| e.into_inner()) = Some(report.clone()),
            Err(_) => failed.push(slug.to_string()),
        }
        result
    }

    async fn fetch_inner(
        &self,
        catalog: &CatalogConfig,
        slug: &str,
        client: &gnome_net::SafeClient,
        shutdown: &CancellationToken,
    ) -> Result<OssFetchReport, String> {
        let manifest = load_manifest(&catalog.oss).map_err(|e| e.to_string())?;
        let entry = manifest.games.iter().find(|e| e.slug == slug).ok_or("unknown entry")?.clone();
        if let Some(why) = Self::fetch_refusal(catalog, slug) {
            return Err(why.into());
        }
        let commit = entry.commit.clone().ok_or("not pinned to a commit")?;
        let repo = entry.repo.as_deref().ok_or("no repository")?;
        let path = repo.strip_prefix("https://github.com/").ok_or("repository must be https://github.com/…")?;
        let url = format!("https://{ARCHIVE_HOST}/{}/tar.gz/{commit}", path.trim_end_matches('/'));
        let started = Instant::now();
        let request = gnome_net::Request::get(url).max_body_bytes(MAX_ARCHIVE_BYTES).timeout(FETCH_TIMEOUT);
        let response = tokio::select! {
            r = client.fetch(request) => r.map_err(|e| format!("download: {e}"))?,
            () = shutdown.cancelled() => return Err("shutting down".into()),
        };
        if response.status() != StatusCode::OK {
            return Err(format!("download: HTTP {}", response.status().as_u16()));
        }
        let archive = response.body().clone();
        let dir = self.dir.clone();
        let budget = self.max_bytes.saturating_sub(self.used_bytes_except(slug));
        let report = tokio::task::spawn_blocking(move || install(&dir, &entry, &commit, &archive, budget))
            .await
            .map_err(|e| format!("extract: {e}"))??;
        Ok(OssFetchReport { duration_ms: started.elapsed().as_millis() as u64, ..report })
    }

    /// Bytes used by every build but `slug`'s (the `GNOME_OSS_MAX_MB` cap).
    fn used_bytes_except(&self, slug: &str) -> u64 {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return 0 };
        rd.flatten()
            .filter(|d| d.file_name().to_str().is_some_and(|n| n != slug && !n.starts_with('.')))
            .map(|d| dir_size(&d.path()))
            .sum()
    }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path).map(|rd| rd.flatten().map(|d| dir_size(&d.path())).sum()).unwrap_or(0)
}

fn build_of(e: &OssEntry, commit: Option<String>, index: Option<BuildIndex>) -> OssBuild {
    OssBuild {
        slug: e.slug.clone(),
        entry: e.entry.clone(),
        repository: e.repo.clone(),
        commit,
        license_file: e.license_file.clone(),
        isolated: e.isolated,
        pointer_lock: e.pointer_lock,
        gamepad: e.gamepad,
        files: index.map(|i| Arc::new(i.files.into_iter().collect())),
    }
}

fn read_index(build_dir: &Path) -> Option<BuildIndex> {
    let path = build_dir.join(INDEX_FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > 16 << 20 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Whether `rel` (slash-separated, already checked) names a regular file below `base` with no symbolic link on the
/// way (every component checked with `symlink_metadata`).
fn is_regular_file_below(base: &Path, rel: &str) -> bool {
    resolve_below(base, rel).is_some()
}

fn resolve_below(base: &Path, rel: &str) -> Option<(PathBuf, std::fs::Metadata)> {
    let base_meta = std::fs::symlink_metadata(base).ok()?;
    if !base_meta.is_dir() {
        return None;
    }
    let mut path = base.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        let last = i + 1 == parts.len();
        if last && !meta.is_file() || !last && !meta.is_dir() {
            return None;
        }
        if last {
            let canonical = path.canonicalize().ok()?;
            let root = base.canonicalize().ok()?;
            return canonical.starts_with(&root).then_some((path, meta));
        }
    }
    None
}

/// A request path after `/oss/<slug>/`, percent-decoded once; `None` when refused (§4.3).
pub fn decode_request_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > MAX_REQUEST_PATH {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8().ok()?.into_owned();
    if decoded.is_empty() || decoded.len() > MAX_REQUEST_PATH || decoded.contains(['\\', '\0']) {
        return None;
    }
    let ok = decoded.split('/').all(|seg| !seg.is_empty() && !seg.starts_with('.'));
    ok.then_some(decoded)
}

fn is_document_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".html", ".htm", ".xhtml", ".xht", ".xml"].iter().any(|ext| lower.ends_with(ext))
}

fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// `GET`/`HEAD /oss/{slug}/{*path}` on the proxy role (§4.3).
pub async fn serve(
    State(state): State<AppState>,
    method: Method,
    UrlPath((slug, path)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(games) = state.ext::<super::Games>() else { return not_found() };
    let Some(build) = games.oss.get(&slug) else { return not_found() };
    let Some(path) = decode_request_path(&path) else { return not_found() };
    let is_entry = path == build.entry;
    if is_document_path(&path) && !is_entry {
        return not_found();
    }
    if is_entry {
        let dest = headers.get("sec-fetch-dest").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !matches!(dest, "iframe" | "frame") {
            return not_found();
        }
    }
    let base = games.oss.dir().join(&slug);
    let lookup = path.clone();
    let Ok(Some((file, meta))) = tokio::task::spawn_blocking(move || resolve_below(&base, &lookup)).await else {
        return not_found();
    };
    let etag = match build.files.as_ref().and_then(|f| f.get(&path)) {
        Some(sha) => format!("\"{sha}\""),
        None => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            format!("W/\"{}-{mtime}\"", meta.len())
        }
    };
    let app_origins: Vec<&str> = state.config.proxy.app_origins().iter().map(String::as_str).collect();
    let policy = if is_entry {
        csp::oss_document_csp(&app_origins, build.isolated, build.pointer_lock)
    } else if path.ends_with(".js") || path.ends_with(".mjs") {
        csp::proxy_script_csp(&app_origins)
    } else {
        csp::proxy_inert_csp(&app_origins)
    };
    let content_type = crate::static_files::content_type(&path);
    let mut res = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header(header::ETAG, &etag)
        .header(header::ACCEPT_RANGES, "none")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer");
    if let Ok(v) = HeaderValue::from_str(&policy) {
        res = res.header(header::CONTENT_SECURITY_POLICY, v);
    }
    let matches = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag || t.trim() == "*"));
    if matches {
        return res.status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap_or_else(|_| not_found());
    }
    res = res.header(header::CONTENT_LENGTH, meta.len());
    if method == Method::HEAD {
        return res.body(Body::empty()).unwrap_or_else(|_| not_found());
    }
    let Ok(f) = tokio::fs::File::open(&file).await else { return not_found() };
    let stream = tokio_util::io::ReaderStream::with_capacity(f, STREAM_CHUNK);
    res.body(Body::from_stream(stream)).unwrap_or_else(|_| not_found())
}

// --- the fetch's extraction (D6), all on the stream ---------------------------------------------------------------

/// Fails the read after `limit` bytes in total (the decompressed tar stream, headers included).
struct CappedReader<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for CappedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Err(std::io::Error::other("the archive exceeds 129 MiB uncompressed"));
        }
        let max = buf.len().min(usize::try_from(self.left).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..max])?;
        self.left -= n as u64;
        Ok(n)
    }
}

/// Check one archive path (top directory stripped by the caller) and return its relative form.
fn checked_path(raw: &[u8]) -> Result<Option<String>, String> {
    let s = std::str::from_utf8(raw).map_err(|_| "a path is not UTF-8".to_string())?;
    if s.contains(['\\', '\0']) || s.starts_with('/') {
        return Err(format!("refused path {s:?}"));
    }
    if s.len() > 255 {
        return Err("a path is longer than 255 bytes".into());
    }
    let mut parts = Vec::new();
    for c in Path::new(s).components() {
        match c {
            Component::Normal(p) => {
                let p = p.to_str().ok_or("a path is not UTF-8")?;
                if p.len() > 128 {
                    return Err("a path component is longer than 128 bytes".into());
                }
                parts.push(p);
            }
            Component::CurDir => {}
            _ => return Err(format!("refused path {s:?}")),
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// Unpack `archive` (gzip'd tar) for `entry` into a temporary directory and swap it into place (D6). `budget` is
/// what `GNOME_OSS_MAX_MB` leaves for this build. Public for the tests' hostile archives.
pub fn install(
    dir: &Path,
    entry: &OssEntry,
    commit: &str,
    archive: &[u8],
    budget: u64,
) -> Result<OssFetchReport, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let random = hex(&crate::security::crypto::random_bytes::<6>());
    let tmp = dir.join(format!(".tmp-{}-{random}", entry.slug));
    let result = unpack(&tmp, archive, budget.min(MAX_BUILD_BYTES)).and_then(|(files, bytes, skipped)| {
        for (what, rel) in [("entry", Some(&entry.entry)), ("license_file", entry.license_file.as_ref())] {
            let rel = rel.ok_or_else(|| format!("the manifest names no {what}"))?;
            if !is_regular_file_below(&tmp, rel) {
                return Err(format!("the archive has no {what} {rel}"));
            }
        }
        let index = BuildIndex { commit: commit.to_string(), fetched_at: now_ms(), files };
        let count = u32::try_from(index.files.len()).unwrap_or(u32::MAX);
        let json = serde_json::to_vec(&index).map_err(|e| e.to_string())?;
        std::fs::write(tmp.join(INDEX_FILE), json).map_err(|e| format!("{INDEX_FILE}: {e}"))?;
        Ok((count, bytes, skipped))
    });
    let (files, bytes, skipped_links) = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let target = dir.join(&entry.slug);
    let old = dir.join(format!(".old-{}-{random}", entry.slug));
    let had_old = std::fs::symlink_metadata(&target).is_ok();
    if had_old {
        std::fs::rename(&target, &old).map_err(|e| format!("move the old build away: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        if had_old {
            let _ = std::fs::rename(&old, &target);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("install the build: {e}"));
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(OssFetchReport {
        slug: entry.slug.clone(),
        commit: commit.to_string(),
        files,
        bytes,
        skipped_links,
        duration_ms: 0,
    })
}

type Unpacked = (BTreeMap<String, String>, u64, u32);

/// Read an extension record's content (PAX header, GNU long name or link), at most [`MAX_EXTENSION_BYTES`].
fn read_extension<R: Read>(item: &mut tar::Entry<'_, R>) -> Result<Vec<u8>, String> {
    if item.header().size().unwrap_or(u64::MAX) > MAX_EXTENSION_BYTES {
        return Err("an extension header is larger than 64 KiB".into());
    }
    let mut out = Vec::new();
    item.take(MAX_EXTENSION_BYTES + 1).read_to_end(&mut out).map_err(|e| format!("archive: {e}"))?;
    if out.len() as u64 > MAX_EXTENSION_BYTES {
        return Err("an extension header is larger than 64 KiB".into());
    }
    Ok(out)
}

/// The `path` record of a PAX extended header.
fn pax_path(data: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut rest = data;
    let mut path = None;
    while !rest.is_empty() {
        let sp = rest.iter().position(|b| *b == b' ').ok_or("malformed PAX header")?;
        let len: usize =
            std::str::from_utf8(&rest[..sp]).ok().and_then(|n| n.parse().ok()).ok_or("malformed PAX header")?;
        if len <= sp + 1 || len > rest.len() {
            return Err("malformed PAX header".into());
        }
        let record = &rest[sp + 1..len - 1];
        if let Some(v) = record.strip_prefix(b"path=") {
            path = Some(v.to_vec());
        }
        rest = &rest[len..];
    }
    Ok(path)
}

/// Raw entries (extension records are handled here, so none is read into memory unchecked).
fn unpack(tmp: &Path, archive: &[u8], cap: u64) -> Result<Unpacked, String> {
    use std::io::Write;
    use tar::EntryType;
    std::fs::create_dir(tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let gz = flate2::read::GzDecoder::new(archive);
    let mut ar = tar::Archive::new(CappedReader { inner: gz, left: MAX_TAR_BYTES });
    let mut files = BTreeMap::new();
    let mut written = 0u64;
    let mut entries_seen = 0u32;
    let mut skipped = 0u32;
    let mut top: Option<String> = None;
    let mut long_path: Option<Vec<u8>> = None;
    let entries = ar.entries().map_err(|e| format!("archive: {e}"))?.raw(true);
    for item in entries {
        let mut item = item.map_err(|e| format!("archive: {e}"))?;
        let kind = item.header().entry_type();
        match kind {
            EntryType::XHeader => {
                let data = read_extension(&mut item)?;
                if let Some(p) = pax_path(&data)? {
                    long_path = Some(p);
                }
                continue;
            }
            EntryType::GNULongName => {
                let mut data = read_extension(&mut item)?;
                while data.last() == Some(&0) {
                    data.pop();
                }
                long_path = Some(data);
                continue;
            }
            EntryType::GNULongLink => {
                read_extension(&mut item)?;
                continue;
            }
            EntryType::XGlobalHeader => continue,
            EntryType::Regular | EntryType::Directory => {}
            EntryType::Symlink | EntryType::Link | EntryType::Char | EntryType::Block | EntryType::Fifo => {
                long_path = None;
                skipped += 1;
                continue;
            }
            other => return Err(format!("refused archive entry type {other:?}")),
        }
        entries_seen += 1;
        if entries_seen > MAX_ENTRIES {
            return Err(format!("more than {MAX_ENTRIES} entries"));
        }
        let raw = match long_path.take() {
            Some(p) => p,
            None => item.path_bytes().into_owned(),
        };
        let Some(path) = checked_path(&raw)? else { continue };
        let (first, rest) = path.split_once('/').map_or((path.as_str(), ""), |(a, b)| (a, b));
        match &top {
            None => top = Some(first.to_string()),
            Some(t) if t == first => {}
            Some(_) => return Err("the archive has more than one top directory".into()),
        }
        if rest.is_empty() {
            continue;
        }
        if rest == ".git" || rest.starts_with(".git/") {
            return Err("the archive contains .git/".into());
        }
        let out = tmp.join(rest);
        if kind == EntryType::Directory {
            std::fs::create_dir_all(&out).map_err(|e| format!("{rest}: {e}"))?;
            set_mode(&out, 0o755);
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{rest}: {e}"))?;
        }
        if std::fs::symlink_metadata(&out).is_ok() {
            return Err(format!("{rest} appears twice"));
        }
        let mut f = std::fs::File::create(&out).map_err(|e| format!("{rest}: {e}"))?;
        let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
        let remaining = cap.saturating_sub(written);
        let mut limited = (&mut item).take(remaining + 1);
        let mut buf = vec![0u8; STREAM_CHUNK];
        let mut n_file = 0u64;
        loop {
            let n = limited.read(&mut buf).map_err(|e| format!("{rest}: {e}"))?;
            if n == 0 {
                break;
            }
            n_file += n as u64;
            if n_file > remaining {
                return Err("the build is larger than its cap (128 MiB per game, GNOME_OSS_MAX_MB in total)".into());
            }
            f.write_all(&buf[..n]).map_err(|e| format!("{rest}: {e}"))?;
            sha2::Digest::update(&mut hasher, &buf[..n]);
        }
        written += n_file;
        set_mode(&out, 0o644);
        files.insert(rest.to_string(), hex(&sha2::Digest::finalize(hasher)));
    }
    if top.is_none() {
        return Err("the archive is empty".into());
    }
    Ok((files, written, skipped))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_paths() {
        assert_eq!(decode_request_path("index.html").as_deref(), Some("index.html"));
        assert_eq!(decode_request_path("js/a%20b.js").as_deref(), Some("js/a b.js"));
        for bad in ["", "%2e%2e/x", "..%2fx", "a/../b", "a/./b", ".gnome-oss.json", "a/.git/x", "a//b", "a\\b", "a%00"]
        {
            assert!(decode_request_path(bad).is_none(), "{bad}");
        }
        assert!(decode_request_path(&"a".repeat(1025)).is_none());
    }

    #[test]
    fn archive_paths() {
        assert_eq!(checked_path(b"top/a/b.js").unwrap().as_deref(), Some("top/a/b.js"));
        assert_eq!(checked_path(b"./top/").unwrap().as_deref(), Some("top"));
        for bad in [&b"/etc/passwd"[..], b"top/../x", b"top\\x", b"top/a\0"] {
            assert!(checked_path(bad).is_err(), "{bad:?}");
        }
        assert!(checked_path(format!("top/{}", "a".repeat(129)).as_bytes()).is_err());
        assert!(checked_path(format!("top/{}", "a/".repeat(130)).as_bytes()).is_err());
    }
}
