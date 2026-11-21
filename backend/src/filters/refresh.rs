//! Fetching lists from upstream: conditional GET through `gnome-net`'s [`SafeClient`], mirrors in order,
//! `!#include` flattening, the Ghostery resources revision check, SHA-256 change detection, scheduling by
//! `! Expires` and failure backoff. Lists with a `file` source are read from disk instead ([`read_list_file`]).

use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Read as _;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use gnome_net::{Conditional, Request, SafeClient, Url, Validators};
use serde::Serialize;

use super::FilterService;
use super::registry::{Format, ListDef};
use super::store::{self, Meta};
use super::text;
use crate::util::{BoxFuture, now_ms};

/// Shortest and longest time between two checks of a list (research §6.1: `clamp(Expires, 4h, 7d)`).
pub const MIN_INTERVAL: Duration = Duration::from_secs(4 * 3600);
pub const MAX_INTERVAL: Duration = Duration::from_secs(7 * 86400);
/// Time budget of one upstream request (a 2 MB list on a slow link fits easily).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Lists fetched at the same time.
pub const CONCURRENCY: usize = 3;
/// `!#include` limits: nesting depth and files per list.
const MAX_INCLUDE_DEPTH: usize = 3;
const MAX_INCLUDES: usize = 32;
/// Size limit of Ghostery's `metadata.json`.
const METADATA_MAX_BYTES: u64 = 1 << 20;
/// Longest error text kept in metadata.
const MAX_ERROR_LEN: usize = 600;
/// Time budget of reading one file list (a slow or hung filesystem cannot hold the refresh job).
pub const FILE_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// `Meta::source` of a list read from a file (the path itself is never recorded or shown).
pub const FILE_SOURCE: &str = "file";

/// `O_NONBLOCK` for `open(2)`: opening a FIFO for reading then returns at once instead of waiting for a writer (the
/// type check after the open refuses it). Hard-coded because the crate has no libc binding; where the value is not
/// known the check before the open stands alone.
#[cfg(all(
    any(target_os = "linux", target_os = "android"),
    any(
        target_arch = "x86",
        target_arch = "x86_64",
        target_arch = "arm",
        target_arch = "aarch64",
        target_arch = "riscv32",
        target_arch = "riscv64",
        target_arch = "powerpc",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    )
))]
const O_NONBLOCK: i32 = 0o4000;
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
const O_NONBLOCK: i32 = 0x0004;
#[cfg(not(any(
    all(
        any(target_os = "linux", target_os = "android"),
        any(
            target_arch = "x86",
            target_arch = "x86_64",
            target_arch = "arm",
            target_arch = "aarch64",
            target_arch = "riscv32",
            target_arch = "riscv64",
            target_arch = "powerpc",
            target_arch = "powerpc64",
            target_arch = "s390x",
            target_arch = "loongarch64"
        )
    ),
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
)))]
const O_NONBLOCK: i32 = 0;

/// Why a file list could not be read. Recorded as the list's `last_error` as a fixed word: never the path, never OS
/// error text (API.md, WAVE-B3 §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileError {
    /// The path (or a component of it) does not exist.
    Missing,
    /// After resolving symbolic links the file lies under `/proc`, `/sys` or `/dev`.
    ForbiddenPath,
    /// A directory, FIFO, socket or device.
    NotRegular,
    /// Permission denied or another I/O error.
    Unreadable,
    /// Larger than the list's `max_mb`.
    TooLarge,
    /// Not read within [`FILE_READ_TIMEOUT`].
    Timeout,
    /// Not UTF-8 text.
    NotUtf8,
    /// An `abp` file whose first line is not a list header (`[Adblock …]` or `!`).
    NoHeader,
    /// An `abp` file that is empty, HTML, contains NUL or has no rules.
    NotAList,
    /// A `resources` file that is not Ghostery's resources JSON.
    NotResources,
}

impl FileError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "file-missing",
            Self::ForbiddenPath => "file-forbidden-path",
            Self::NotRegular => "file-not-regular",
            Self::Unreadable => "file-unreadable",
            Self::TooLarge => "file-too-large",
            Self::Timeout => "file-timeout",
            Self::NotUtf8 => "file-not-utf8",
            Self::NoHeader => "file-no-header",
            Self::NotAList => "file-not-a-list",
            Self::NotResources => "file-not-resources",
        }
    }
}

fn io_error(e: &std::io::Error) -> FileError {
    match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => FileError::Missing,
        _ => FileError::Unreadable,
    }
}

/// Where an open file really is (Linux: the `/proc/self/fd/<n>` link), or `None` where that cannot be told (no
/// procfs, another OS): then the checks made before the open stand alone.
#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Option<std::path::PathBuf> {
    use std::os::fd::AsRawFd as _;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(not(target_os = "linux"))]
fn opened_path(_file: &File) -> Option<std::path::PathBuf> {
    None
}

/// Open `path` for reading without blocking (`O_NONBLOCK`) and keep it only if `fstat` says it is a regular file and
/// the file that was opened does not lie under `/proc`, `/sys` or `/dev` (a path component replaced by a symbolic
/// link between [`read_list_file`]'s checks and this open would otherwise lead the read there; procfs and sysfs
/// files are regular files to `fstat`).
pub fn open_regular(path: &Path) -> Result<File, FileError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| io_error(&e))?;
    let meta = file.metadata().map_err(|e| io_error(&e))?;
    if !meta.file_type().is_file() {
        return Err(FileError::NotRegular);
    }
    if opened_path(&file).is_some_and(|p| super::registry::forbidden_path(&p)) {
        return Err(FileError::ForbiddenPath);
    }
    Ok(file)
}

/// Read a file list (blocking): symbolic links resolved and the result checked against `/proc`, `/sys` and `/dev`
/// again (the configured path passed [`super::registry::check_file_path`] only lexically), a regular file before and
/// after the non-blocking open, at most `max_bytes`.
pub fn read_list_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, FileError> {
    let real = std::fs::canonicalize(path).map_err(|e| io_error(&e))?;
    if super::registry::forbidden_path(&real) {
        return Err(FileError::ForbiddenPath);
    }
    // Refuse non-regular files before opening them too, for targets where O_NONBLOCK is not known.
    let meta = std::fs::metadata(&real).map_err(|e| io_error(&e))?;
    if !meta.file_type().is_file() {
        return Err(FileError::NotRegular);
    }
    if meta.len() > max_bytes {
        return Err(FileError::TooLarge);
    }
    let file = open_regular(&real)?;
    let mut body = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut body).map_err(|e| io_error(&e))?;
    if body.len() as u64 > max_bytes {
        return Err(FileError::TooLarge);
    }
    Ok(body)
}

/// The checks of a downloaded body, for a file list (plus the list header for `abp`).
pub fn check_file_body(format: Format, body: &[u8]) -> Result<(), FileError> {
    match format {
        Format::Abp => {
            if std::str::from_utf8(body).is_err() {
                return Err(FileError::NotUtf8);
            }
            text::check_list_body(body).map_err(|_| FileError::NotAList)?;
            text::check_list_header(body).map_err(|_| FileError::NoHeader)
        }
        Format::Resources => text::check_resources_body(body).map_err(|_| FileError::NotResources),
    }
}

/// Run blocking `work` on the blocking pool, giving up after `limit` (the thread may finish later; its result is
/// dropped).
async fn blocking_with_timeout<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> Result<T, FileError> + Send + 'static,
) -> Result<T, FileError> {
    match tokio::time::timeout(limit, tokio::task::spawn_blocking(work)).await {
        Err(_) => Err(FileError::Timeout),
        Ok(Err(_)) => Err(FileError::Unreadable),
        Ok(Ok(r)) => r,
    }
}

/// What a check of one list did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum Outcome {
    /// New content stored.
    Updated { size: u64, sha256: String },
    /// Upstream sent the same bytes again (or the resources revision did not change).
    Unchanged,
    /// Upstream answered `304 Not Modified`.
    NotModified,
    /// Not due yet.
    Skipped,
    /// Every source failed; the previous copy (if any) is kept.
    Failed { error: String },
}

impl Outcome {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Updated { .. } => "updated",
            Self::Unchanged => "unchanged",
            Self::NotModified => "not_modified",
            Self::Skipped => "skipped",
            Self::Failed { .. } => "failed",
        }
    }
}

/// Result of one list in a refresh run.
#[derive(Debug, Clone, Serialize)]
pub struct ListReport {
    pub id: String,
    #[serde(flatten)]
    pub outcome: Outcome,
    pub ms: u64,
    /// URL that answered (primary or mirror).
    pub source: Option<String>,
}

/// Which lists a run checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Lists whose `next_check_at` has passed, and lists that are not stored yet.
    Due,
    /// Every list (admin / CLI "refresh now"; conditional GETs keep it cheap).
    All,
}

enum Fetched {
    NotModified {
        validators: Validators,
        source: String,
    },
    /// Same content as stored, known without downloading it (resources revision).
    Same {
        source: String,
    },
    Body {
        body: Vec<u8>,
        validators: Validators,
        source: String,
        includes: u32,
    },
}

fn host_of(u: &str) -> String {
    Url::parse(u).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_else(|| u.to_string())
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_ERROR_LEN {
        let mut cut = MAX_ERROR_LEN;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push('…');
    }
    s
}

/// The interval until the next check: the list's `! Expires` (else `GNOME_FILTERS_REFRESH_HOURS`, else 24 h),
/// clamped to 4 h–7 d.
pub fn interval(expires: Option<Duration>, refresh_hours: u32) -> Duration {
    let fallback = Duration::from_secs(u64::from(if refresh_hours == 0 { 24 } else { refresh_hours }) * 3600);
    expires.unwrap_or(fallback).clamp(MIN_INTERVAL, MAX_INTERVAL)
}

/// Random delay added to a schedule so many lists (and many GNOME servers) do not hit upstream at the same instant:
/// up to 5 % of the interval, at most 30 minutes.
fn jitter(interval: Duration) -> Duration {
    let max = (interval / 20).min(Duration::from_secs(1800)).as_millis() as u64;
    if max == 0 {
        return Duration::ZERO;
    }
    let r = u64::from_le_bytes(crate::security::crypto::random_bytes::<8>());
    Duration::from_millis(r % max)
}

/// Wait before retrying after `failures` consecutive failures: 5 min doubling to 1 h while nothing is stored,
/// 15 min doubling to 6 h when an older copy is still served.
pub fn backoff(failures: u32, have_copy: bool) -> Duration {
    let (base, cap) = if have_copy { (15 * 60, 6 * 3600) } else { (5 * 60, 3600) };
    let exp = failures.saturating_sub(1).min(10);
    Duration::from_secs((base << exp).min(cap))
}

fn ms(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

impl FilterService {
    /// Check lists (all of them, or `only` these ids) and store what changed. Runs at most once at a time per
    /// process; lists are fetched [`CONCURRENCY`] at a time.
    pub async fn refresh(self: &Arc<Self>, mode: Mode, only: Option<&[String]>) -> Vec<ListReport> {
        self.wait_loaded().await;
        let _running = self.refresh_lock.lock().await;
        let started = Instant::now();
        let ids: Vec<String> =
            self.defs.iter().filter(|d| only.is_none_or(|o| o.contains(&d.id))).map(|d| d.id.clone()).collect();
        let mut reports = Vec::with_capacity(ids.len());
        let mut set = tokio::task::JoinSet::new();
        let mut pending = ids.into_iter();
        loop {
            while set.len() < CONCURRENCY {
                let Some(id) = pending.next() else { break };
                let svc = Arc::clone(self);
                set.spawn(async move { svc.refresh_one(&id, mode).await });
            }
            match set.join_next().await {
                Some(Ok(report)) => reports.push(report),
                Some(Err(e)) => tracing::error!(error = %e, "filter-list refresh task failed"),
                None => break,
            }
        }
        let order = |id: &str| self.defs.iter().position(|d| d.id == id).unwrap_or(usize::MAX);
        reports.sort_by_key(|r| order(&r.id));
        let changed = reports.iter().filter(|r| matches!(r.outcome, Outcome::Updated { .. })).count();
        let failed = reports.iter().filter(|r| matches!(r.outcome, Outcome::Failed { .. })).count();
        let checked = reports.iter().filter(|r| r.outcome != Outcome::Skipped).count();
        if checked > 0 {
            tracing::info!(
                checked,
                changed,
                failed,
                ms = started.elapsed().as_millis() as u64,
                "filter lists refreshed"
            );
        }
        reports
    }

    async fn refresh_one(&self, id: &str, mode: Mode) -> ListReport {
        let started = Instant::now();
        let def = self.defs.iter().find(|d| d.id == id).expect("refresh only runs registered ids");
        let entry = self.entry(id);
        let mut meta = entry.as_ref().map(|e| e.meta.clone()).unwrap_or_default();
        let have_copy = entry.as_ref().is_some_and(|e| e.files.is_some());
        let previous = meta.sha256.clone();
        let now = now_ms();
        // Not due yet: a stored copy before its next check, or a list without one that is backing off after failed
        // checks. A list that was never fetched, or whose recorded version lost its files, is fetched right away.
        let lost = !have_copy && meta.sha256.is_some();
        // File lists are always due: reading a local file costs no upstream request, and an operator's edit should
        // show at the next tick.
        if mode == Mode::Due && !def.is_file() && !lost && (have_copy || meta.failures > 0) && now < meta.next_check_at
        {
            return ListReport { id: id.into(), outcome: Outcome::Skipped, ms: 0, source: None };
        }
        let fetched = match (&def.file, def.format) {
            (Some(path), format) => Self::read_file(path, format, def.max_bytes).await,
            (None, Format::Abp) => self.fetch_abp(def, &meta, have_copy).await,
            (None, Format::Resources) => self.fetch_resources(def, &meta, have_copy).await,
        };
        let now = now_ms();
        let mut files = entry.as_ref().and_then(|e| e.files.clone());
        let (outcome, source) = match fetched {
            Ok(Fetched::NotModified { validators, source }) => {
                meta.etag = validators.etag;
                meta.last_modified = validators.last_modified;
                meta.source = Some(source.clone());
                (Outcome::NotModified, Some(source))
            }
            Ok(Fetched::Same { source }) => (Outcome::Unchanged, Some(source)),
            Ok(Fetched::Body { body, mut validators, source, includes }) => {
                let sha = store::sha256_hex(&body);
                // Validators and source only describe the stored copy: never record them for a body that was not
                // stored, or the next conditional GET would answer 304 for content we do not have.
                let header = match def.format {
                    Format::Abp => text::header(std::str::from_utf8(&body).unwrap_or_default()),
                    Format::Resources => text::Header::default(),
                };
                let mut adopt = |meta: &mut Meta| {
                    meta.etag = validators.etag.take();
                    meta.last_modified = validators.last_modified.take();
                    meta.source = Some(source.clone());
                    meta.includes = includes;
                    meta.version = header.version.clone();
                    // A file list is re-read at every tick: its `! Expires` schedules nothing.
                    meta.expires_s = if def.is_file() { None } else { header.expires.map(|d| d.as_secs()) };
                };
                if have_copy && meta.sha256.as_deref() == Some(sha.as_str()) {
                    adopt(&mut meta);
                    (Outcome::Unchanged, Some(source))
                } else {
                    match self.store_body(def, &sha, &body).await {
                        Ok((stored, br, gz)) => {
                            adopt(&mut meta);
                            meta.sha256 = Some(sha.clone());
                            meta.size = body.len() as u64;
                            meta.size_br = br;
                            meta.size_gzip = gz;
                            meta.updated_at = Some(now);
                            files = Some(Arc::new(stored));
                            self.stats.downloaded_bytes.fetch_add(body.len() as u64, Ordering::Relaxed);
                            (Outcome::Updated { size: body.len() as u64, sha256: sha }, Some(source))
                        }
                        Err(e) => (Outcome::Failed { error: format!("cannot store the list: {e}") }, Some(source)),
                    }
                }
            }
            Err(error) => (Outcome::Failed { error: truncate(error) }, None),
        };
        match &outcome {
            Outcome::Failed { error } => {
                meta.failures = meta.failures.saturating_add(1);
                meta.last_error = Some(error.clone());
                meta.last_error_at = Some(now);
                meta.next_check_at = now + ms(backoff(meta.failures, files.is_some()));
                tracing::warn!(list = id, failures = meta.failures, error = %error, "filter list refresh failed");
            }
            _ => {
                meta.failures = 0;
                meta.last_error = None;
                meta.fetched_at = Some(now);
                let every = interval(meta.expires_s.map(Duration::from_secs), self.refresh_hours);
                meta.next_check_at = now + ms(every + jitter(every));
                if let Outcome::Updated { size, .. } = &outcome {
                    tracing::info!(
                        list = id,
                        size,
                        version = meta.version.as_deref().unwrap_or("-"),
                        "filter list updated"
                    );
                }
            }
        }
        self.stats.count(&outcome);
        if let Err(e) = store::save(&self.db, id, &meta).await {
            tracing::error!(list = id, error = %e, "cannot save filter-list metadata");
        }
        self.set_entry(id, meta, files);
        // The metadata and the index name the new version now: the previous one can go. Requests still streaming it
        // keep their open file; later ones that looked it up find the new version (`reload_entry`).
        if let Outcome::Updated { sha256, .. } = &outcome
            && let Some(old) = previous.filter(|p| p != sha256)
        {
            let (dir, id, ext) = (self.dir.clone(), id.to_string(), def.format.extension());
            let _ = tokio::task::spawn_blocking(move || store::remove_version(&dir, &id, &old, ext)).await;
        }
        ListReport { id: id.into(), outcome, ms: started.elapsed().as_millis() as u64, source }
    }

    /// Compress and store version `sha` of a list (blocking work on the blocking pool, at most two at a time).
    async fn store_body(&self, def: &ListDef, sha: &str, body: &[u8]) -> Result<(store::Files, u64, u64), String> {
        let _permit = self.compress_permits.acquire().await.map_err(|e| e.to_string())?;
        let dir = self.dir.clone();
        let id = def.id.clone();
        let ext = def.format.extension();
        let sha = sha.to_string();
        let body = body.to_vec();
        tokio::task::spawn_blocking(move || {
            let (br, gz, took) = store::compress(&body);
            let ms = took.as_millis() as u64;
            tracing::debug!(list = %id, size = body.len(), br = br.len(), gzip = gz.len(), ms, "filter list compressed");
            store::write(&dir, &id, &sha, ext, &body, &br, &gz)
                .map(|files| (files, br.len() as u64, gz.len() as u64))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// A file list: read and checked like a download (the error is a [`FileError`] word).
    async fn read_file(path: &Path, format: Format, max_bytes: u64) -> Result<Fetched, String> {
        let path = path.to_path_buf();
        let body = blocking_with_timeout(FILE_READ_TIMEOUT, move || {
            let body = read_list_file(&path, max_bytes)?;
            check_file_body(format, &body)?;
            Ok(body)
        })
        .await
        .map_err(|e| e.as_str().to_string())?;
        Ok(Fetched::Body { body, validators: Validators::default(), source: FILE_SOURCE.into(), includes: 0 })
    }

    fn client(&self) -> Result<&SafeClient, String> {
        self.client.as_ref().map_err(Clone::clone)
    }

    fn request(&self, url: &str, max_bytes: u64) -> Request {
        Request::get(url).max_body_bytes(max_bytes).timeout(FETCH_TIMEOUT).allow_http(self.allow_http)
    }

    /// uBO/ABP text: primary, then mirrors; conditional GET against the URL the stored copy came from.
    async fn fetch_abp(&self, def: &ListDef, meta: &Meta, have_copy: bool) -> Result<Fetched, String> {
        let client = self.client()?;
        let mut errors = Vec::new();
        for url in std::iter::once(&def.url).chain(&def.mirrors) {
            if self.shutdown.is_cancelled() {
                return Err("shutting down".into());
            }
            let validators = if have_copy && meta.includes == 0 && meta.source.as_deref() == Some(url.as_str()) {
                Validators { etag: meta.etag.clone(), last_modified: meta.last_modified.clone() }
            } else {
                Validators::default()
            };
            match client.fetch_conditional(self.request(url, def.max_bytes), &validators).await {
                // Nothing was sent to validate against: a 304 says nothing about the stored copy (if any).
                Ok(Conditional::NotModified { .. }) if validators.is_empty() => {
                    errors.push(format!("{}: HTTP 304 to an unconditional request", host_of(url)));
                }
                Ok(Conditional::NotModified { validators }) => {
                    return Ok(Fetched::NotModified { validators, source: url.clone() });
                }
                Ok(Conditional::Modified { response, validators }) => {
                    if !response.status().is_success() {
                        errors.push(format!("{}: HTTP {}", host_of(url), response.status().as_u16()));
                        continue;
                    }
                    let final_url = response.url().clone();
                    let body = response.into_body().to_vec();
                    if let Err(e) = text::check_list_body(&body) {
                        errors.push(format!("{}: {e}", host_of(url)));
                        continue;
                    }
                    match self.flatten(client, &final_url, body, def.max_bytes).await {
                        Ok((body, includes)) => {
                            return Ok(Fetched::Body { body, validators, source: url.clone(), includes });
                        }
                        Err(e) => errors.push(format!("{}: {e}", host_of(url))),
                    }
                }
                Err(e) => errors.push(format!("{}: {e}", host_of(url))),
            }
        }
        Err(errors.join("; "))
    }

    /// Inline `!#include` files (same origin and directory, nested up to 3 deep, 32 files, within the list's size
    /// limit). uBO's CDN copies have none; upstream originals and operator lists may.
    async fn flatten(
        &self,
        client: &SafeClient,
        base: &Url,
        body: Vec<u8>,
        max: u64,
    ) -> Result<(Vec<u8>, u32), String> {
        let text = String::from_utf8(body).map_err(|_| "the body is not UTF-8 text".to_string())?;
        if !text::has_includes(&text) {
            return Ok((text.into_bytes(), 0));
        }
        let mut seen = HashSet::from([base.as_str().to_string()]);
        let mut count = 0usize;
        let out = self.inline(client, base, text, 0, max, &mut seen, &mut count).await?;
        if out.len() as u64 > max {
            return Err(format!("the flattened list is larger than {max} bytes"));
        }
        Ok((out.into_bytes(), u32::try_from(count).unwrap_or(u32::MAX)))
    }

    #[allow(clippy::too_many_arguments)]
    fn inline<'a>(
        &'a self,
        client: &'a SafeClient,
        base: &'a Url,
        text: String,
        depth: usize,
        max: u64,
        seen: &'a mut HashSet<String>,
        count: &'a mut usize,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let mut out = String::with_capacity(text.len());
            for line in text.split_inclusive('\n') {
                let Some(target) = text::include_target(line) else {
                    out.push_str(line);
                    continue;
                };
                if depth >= MAX_INCLUDE_DEPTH {
                    return Err(format!("!#include nested deeper than {MAX_INCLUDE_DEPTH}"));
                }
                let url = text::resolve_include(base, target)?;
                if !seen.insert(url.as_str().to_string()) {
                    continue;
                }
                *count += 1;
                if *count > MAX_INCLUDES {
                    return Err(format!("more than {MAX_INCLUDES} !#include files"));
                }
                let remaining = max.saturating_sub(out.len() as u64).max(1);
                let resp = client
                    .fetch(self.request(url.as_str(), remaining))
                    .await
                    .map_err(|e| format!("!#include {target}: {e}"))?;
                if !resp.status().is_success() {
                    return Err(format!("!#include {target}: HTTP {}", resp.status().as_u16()));
                }
                let final_url = resp.url().clone();
                let sub = String::from_utf8(resp.into_body().to_vec())
                    .map_err(|_| format!("!#include {target}: not UTF-8 text"))?;
                if sub.trim_start().starts_with('<') {
                    return Err(format!("!#include {target}: an HTML document, not a filter list"));
                }
                let sub = self.inline(client, &final_url, sub, depth + 1, max, seen, count).await?;
                out.push_str(&sub);
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                if out.len() as u64 > max {
                    return Err(format!("the flattened list is larger than {max} bytes"));
                }
            }
            Ok(out)
        })
    }

    /// Ghostery resources: newest revision from `metadata.json`, then `<rev>/list.txt` verified against it;
    /// mirrors serve the JSON directly.
    async fn fetch_resources(&self, def: &ListDef, meta: &Meta, have_copy: bool) -> Result<Fetched, String> {
        let client = self.client()?;
        let mut errors = Vec::new();
        match self.fetch_resources_revision(client, def, meta, have_copy).await {
            Ok(f) => return Ok(f),
            Err(e) => errors.push(format!("{}: {e}", host_of(&def.url))),
        }
        for url in &def.mirrors {
            if self.shutdown.is_cancelled() {
                return Err("shutting down".into());
            }
            let validators = if have_copy && meta.source.as_deref() == Some(url.as_str()) {
                Validators { etag: meta.etag.clone(), last_modified: meta.last_modified.clone() }
            } else {
                Validators::default()
            };
            match client.fetch_conditional(self.request(url, def.max_bytes), &validators).await {
                // Nothing was sent to validate against: a 304 says nothing about the stored copy (if any).
                Ok(Conditional::NotModified { .. }) if validators.is_empty() => {
                    errors.push(format!("{}: HTTP 304 to an unconditional request", host_of(url)));
                }
                Ok(Conditional::NotModified { validators }) => {
                    return Ok(Fetched::NotModified { validators, source: url.clone() });
                }
                Ok(Conditional::Modified { response, validators }) if response.status().is_success() => {
                    let body = response.into_body().to_vec();
                    match text::check_resources_body(&body) {
                        Ok(()) => return Ok(Fetched::Body { body, validators, source: url.clone(), includes: 0 }),
                        Err(e) => errors.push(format!("{}: {e}", host_of(url))),
                    }
                }
                Ok(Conditional::Modified { response, .. }) => {
                    errors.push(format!("{}: HTTP {}", host_of(url), response.status().as_u16()));
                }
                Err(e) => errors.push(format!("{}: {e}", host_of(url))),
            }
        }
        Err(errors.join("; "))
    }

    async fn fetch_resources_revision(
        &self,
        client: &SafeClient,
        def: &ListDef,
        meta: &Meta,
        have_copy: bool,
    ) -> Result<Fetched, String> {
        let resp = client.fetch(self.request(&def.url, METADATA_MAX_BYTES)).await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("metadata.json: HTTP {}", resp.status().as_u16()));
        }
        let rev = text::latest_revision(resp.body())?;
        if have_copy && meta.sha256.as_deref() == Some(rev.as_str()) {
            return Ok(Fetched::Same { source: def.url.clone() });
        }
        let list_url = resp.url().join(&format!("{rev}/list.txt")).map_err(|e| e.to_string())?;
        let resp = client.fetch(self.request(list_url.as_str(), def.max_bytes)).await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("{rev}/list.txt: HTTP {}", resp.status().as_u16()));
        }
        let validators = resp.validators();
        let body = resp.into_body().to_vec();
        if store::sha256_hex(&body) != rev {
            return Err(format!("{rev}/list.txt does not match its SHA-256 revision"));
        }
        text::check_resources_body(&body)?;
        Ok(Fetched::Body { body, validators, source: def.url.clone(), includes: 0 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule() {
        let h = |n: u64| Duration::from_secs(n * 3600);
        assert_eq!(interval(Some(h(96)), 24), h(96));
        assert_eq!(interval(Some(h(1)), 24), MIN_INTERVAL);
        assert_eq!(interval(Some(h(24 * 30)), 24), MAX_INTERVAL);
        assert_eq!(interval(None, 24), h(24));
        assert_eq!(interval(None, 2), MIN_INTERVAL);
        assert_eq!(interval(None, 8760), MAX_INTERVAL);
        assert_eq!(interval(None, 0), h(24));
        for _ in 0..100 {
            assert!(jitter(h(96)) < Duration::from_secs(1800));
            assert!(jitter(MIN_INTERVAL) < MIN_INTERVAL / 20);
        }
    }

    #[test]
    fn backoff_grows_and_caps() {
        let m = |n: u64| Duration::from_secs(n * 60);
        assert_eq!(backoff(1, false), m(5));
        assert_eq!(backoff(2, false), m(10));
        assert_eq!(backoff(10, false), m(60));
        assert_eq!(backoff(1, true), m(15));
        assert_eq!(backoff(3, true), m(60));
        assert_eq!(backoff(40, true), m(360));
    }

    const LIST: &[u8] = b"! gnome-e2e: id=x category=ads\n||ads.example^\n";

    #[test]
    fn file_lists_are_read_with_their_checks() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("list.txt");
        std::fs::write(&p, LIST).unwrap();
        assert_eq!(read_list_file(&p, 1024).unwrap(), LIST);
        // Re-read after a change: the new bytes.
        std::fs::write(&p, b"[Adblock Plus 2.0]\n||other.example^\n").unwrap();
        assert_eq!(read_list_file(&p, 1024).unwrap(), b"[Adblock Plus 2.0]\n||other.example^\n");
        assert_eq!(read_list_file(&p, 10), Err(FileError::TooLarge));
        assert_eq!(read_list_file(&dir.path().join("nope.txt"), 1024), Err(FileError::Missing));
        assert_eq!(read_list_file(&p.join("below-a-file"), 1024), Err(FileError::Missing));
        assert_eq!(read_list_file(dir.path(), 1024), Err(FileError::NotRegular));
        assert_eq!(open_regular(dir.path()).unwrap_err(), FileError::NotRegular);
        // The body checks of a download, plus the list header.
        assert_eq!(check_file_body(Format::Abp, LIST), Ok(()));
        assert_eq!(check_file_body(Format::Abp, b"||a^\n! late header\n"), Err(FileError::NoHeader));
        assert_eq!(check_file_body(Format::Abp, b"! only a comment\n"), Err(FileError::NotAList));
        assert_eq!(check_file_body(Format::Abp, b"<!DOCTYPE html>"), Err(FileError::NotAList));
        assert_eq!(check_file_body(Format::Abp, b"! x\n||a\xff^\n"), Err(FileError::NotUtf8));
        assert_eq!(check_file_body(Format::Resources, LIST), Err(FileError::NotResources));
        assert_eq!(
            check_file_body(Format::Resources, br#"{"redirects":[{"name":"noop.js"}],"scriptlets":[]}"#),
            Ok(())
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_into_kernel_interfaces_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        for (name, target) in [("status", "/proc/self/status"), ("zero", "/dev/zero"), ("k", "/sys/kernel")] {
            let link = dir.path().join(name);
            std::os::unix::fs::symlink(target, &link).unwrap();
            if Path::new(target).exists() {
                assert_eq!(read_list_file(&link, 1 << 20), Err(FileError::ForbiddenPath), "{target}");
            }
        }
        // A symlink to an ordinary list is fine.
        let real = dir.path().join("real.txt");
        std::fs::write(&real, LIST).unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(read_list_file(&link, 1024).unwrap(), LIST);
    }

    /// The file that was opened is checked again (Linux): procfs files are regular files to `fstat`, and a path
    /// component replaced by a link after `read_list_file`'s checks would lead the open there.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_opened_file_is_checked_again() {
        for p in ["/proc/self/status", "/proc/version"] {
            if Path::new(p).exists() {
                assert_eq!(open_regular(Path::new(p)).unwrap_err(), FileError::ForbiddenPath, "{p}");
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.txt");
        std::fs::write(&real, LIST).unwrap();
        assert!(open_regular(&real).is_ok());
        // What the open sees when a checked path was swapped for a link into /proc.
        let swapped = dir.path().join("swapped.txt");
        std::os::unix::fs::symlink("/proc/self/status", &swapped).unwrap();
        if Path::new("/proc/self/status").exists() {
            assert_eq!(open_regular(&swapped).unwrap_err(), FileError::ForbiddenPath);
        }
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_files_are_reported_without_os_text() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("secret.txt");
        std::fs::write(&p, LIST).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads anything; everyone else gets the fixed word.
        if File::open(&p).is_err() {
            assert_eq!(read_list_file(&p, 1024), Err(FileError::Unreadable));
        }
        for e in [
            FileError::Missing,
            FileError::ForbiddenPath,
            FileError::NotRegular,
            FileError::Unreadable,
            FileError::TooLarge,
            FileError::Timeout,
            FileError::NotUtf8,
            FileError::NoHeader,
            FileError::NotAList,
            FileError::NotResources,
        ] {
            let w = e.as_str();
            assert!(
                w.starts_with("file-") && w.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
                "{w}"
            );
        }
    }

    /// A FIFO is refused at once, by the check before the open and by the non-blocking open itself (which would wait
    /// for a writer without O_NONBLOCK).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fifos_are_refused_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo.txt");
        match std::process::Command::new("mkfifo").arg(&fifo).status() {
            Ok(s) if s.success() => {}
            _ => {
                eprintln!("mkfifo is not available: skipped");
                return;
            }
        }
        let started = std::time::Instant::now();
        let f = fifo.clone();
        let r = blocking_with_timeout(Duration::from_secs(5), move || read_list_file(&f, 1024)).await;
        assert_eq!(r, Err(FileError::NotRegular));
        let f = fifo.clone();
        let r = blocking_with_timeout(Duration::from_secs(5), move || open_regular(&f).map(|_| ())).await;
        assert_eq!(r, Err(FileError::NotRegular));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_hung_read_times_out() {
        let started = std::time::Instant::now();
        let r = blocking_with_timeout(Duration::from_millis(200), || {
            std::thread::sleep(Duration::from_millis(900));
            Ok(())
        })
        .await;
        assert_eq!(r, Err(FileError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn errors_are_truncated_on_char_boundaries() {
        let s = truncate("é".repeat(1000));
        assert!(s.len() <= MAX_ERROR_LEN + '…'.len_utf8());
        assert!(s.ends_with('…'));
        assert_eq!(truncate("short".into()), "short");
    }
}
