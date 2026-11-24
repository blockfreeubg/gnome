//! The thumbnail proxy's cache (WAVE-C D7): validated upstream fetches (allowed raster type **and** matching magic
//! bytes, ≤ 2 MiB), a disk LRU under `$GNOME_DATA_DIR/thumbs/` capped by `GNOME_THUMB_CACHE_MB` (0 = validated
//! pass-through without storing), a negative cache in memory, and coalesced misses.
//!
//! Files are `<dir>/<2 hex>/<sha256(url) hex>.<ext>`; a file's modification time is its expiry (the upstream's
//! `max-age`, at most 7 days), so the cache keeps its freshness rules across restarts.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use gnome_catalog::thumbs::{MAX_THUMB_BYTES, is_allowed_content_type};
use gnome_catalog::{FetchError, FetchRequest, Fetcher, Method};
use serde_json::{Value, json};
use tokio::sync::{OnceCell, Semaphore};

use crate::security::crypto::sha256_hex;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;

/// Longest freshness (also used when the upstream sends no `max-age`).
pub const MAX_AGE_S: u32 = 604_800;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const PERMITS: usize = 4;
const PERMIT_WAIT: Duration = Duration::from_secs(5);
const NEGATIVE_MAX: usize = 10_000;
const NEG_4XX: Duration = Duration::from_secs(3600);
const NEG_REFUSED: Duration = Duration::from_secs(86_400);
const NEG_UPSTREAM: Duration = Duration::from_secs(60);
const ACCEPT: &str = "image/avif,image/webp,image/png,image/jpeg,image/gif";
const RESULTS: [&str; 7] = ["hit", "miss", "not_modified", "not_found", "refused", "upstream_error", "rate_limited"];

/// One answer.
#[derive(Debug, Clone)]
pub struct ThumbHit {
    pub content_type: &'static str,
    /// Hex SHA-256 of the body (the strong `ETag`).
    pub etag: String,
    pub body: ThumbBody,
    /// `Cache-Control: public, max-age=…` (`min(604800, the upstream's max-age)`).
    pub max_age_s: u32,
}

#[derive(Debug, Clone)]
pub enum ThumbBody {
    Disk { path: PathBuf, len: u64 },
    Memory(Bytes),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbError {
    NotFound,
    Refused(&'static str),
    Upstream { retry_after_s: u32 },
    RateLimited { retry_after_s: u32 },
}

#[derive(Debug, Clone)]
struct Entry {
    path: PathBuf,
    len: u64,
    content_type: &'static str,
    etag: String,
    expires: SystemTime,
    used: u64,
}

#[derive(Debug, Default)]
struct Index {
    entries: HashMap<String, Entry>,
    total: u64,
    tick: u64,
}

type Shared = Arc<OnceCell<Result<ThumbHit, ThumbError>>>;

#[derive(Debug)]
pub struct ThumbCache {
    dir: PathBuf,
    cap: u64,
    index: Mutex<Index>,
    negative: Mutex<HashMap<String, (Instant, ThumbError)>>,
    inflight: Mutex<HashMap<String, Shared>>,
    permits: Semaphore,
    counters: [AtomicU64; RESULTS.len()],
}

/// Magic bytes → `image/jpeg` | `image/png` | `image/gif` | `image/webp` | `image/avif`; anything else `None`.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        Some("image/avif")
    } else {
        None
    }
}

fn extension(content_type: &str) -> &'static str {
    match content_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "avif",
    }
}

fn type_of_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "jpg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// `Cache-Control` → `(max_age_s, store)`.
fn freshness(cache_control: Option<&str>) -> (u32, bool) {
    let Some(cc) = cache_control else { return (MAX_AGE_S, true) };
    let mut max_age = MAX_AGE_S;
    let mut store = true;
    for d in cc.split(',').map(|d| d.trim().to_ascii_lowercase()) {
        if d == "no-store" {
            store = false;
        } else if let Some(v) = d.strip_prefix("max-age=") {
            max_age = v.trim_matches('"').parse::<u32>().unwrap_or(0).min(MAX_AGE_S);
        }
    }
    (max_age, store && max_age > 0)
}

impl ThumbCache {
    /// `$GNOME_DATA_DIR/thumbs/`, cap `GNOME_THUMB_CACHE_MB` (0 = no disk cache: validated pass-through).
    pub fn open(dir: PathBuf, cap_mb: u32) -> Self {
        Self {
            dir,
            cap: u64::from(cap_mb) << 20,
            index: Mutex::new(Index::default()),
            negative: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            permits: Semaphore::new(PERMITS),
            counters: Default::default(),
        }
    }

    /// Count one answer for `gnome_thumb_requests_total{result}`.
    pub fn count(&self, result: &str) {
        if let Some(i) = RESULTS.iter().position(|r| *r == result) {
            self.counters[i].fetch_add(1, Ordering::Relaxed);
        }
    }

    fn counter(&self, result: &str) -> u64 {
        RESULTS.iter().position(|r| *r == result).map_or(0, |i| self.counters[i].load(Ordering::Relaxed))
    }

    fn path_for(&self, key: &str, content_type: &str) -> PathBuf {
        self.dir.join(&key[..2]).join(format!("{key}.{}", extension(content_type)))
    }

    /// Index the files on disk (modification time = expiry), drop temporary and expired files; runs once at start.
    pub async fn scan(&self) {
        if self.cap == 0 {
            return;
        }
        let dir = self.dir.clone();
        let found = tokio::task::spawn_blocking(move || scan_dir(&dir)).await.unwrap_or_default();
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        for (key, entry) in found {
            index.total += entry.len;
            if let Some(old) = index.entries.insert(key, entry) {
                index.total -= old.len;
            }
        }
        drop(index);
        self.evict();
    }

    fn lookup(&self, key: &str) -> Option<Entry> {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        index.tick += 1;
        let tick = index.tick;
        let entry = index.entries.get_mut(key)?;
        if entry.expires <= SystemTime::now() {
            let gone = index.entries.remove(key)?;
            index.total -= gone.len;
            let _ = std::fs::remove_file(&gone.path);
            return None;
        }
        entry.used = tick;
        Some(entry.clone())
    }

    fn negative(&self, url: &str) -> Option<ThumbError> {
        let mut neg = self.negative.lock().unwrap_or_else(|e| e.into_inner());
        match neg.get(url) {
            Some((until, e)) if *until > Instant::now() => Some(*e),
            Some(_) => {
                neg.remove(url);
                None
            }
            None => None,
        }
    }

    fn remember(&self, url: &str, err: ThumbError, ttl: Duration) {
        let mut neg = self.negative.lock().unwrap_or_else(|e| e.into_inner());
        if neg.len() >= NEGATIVE_MAX {
            let now = Instant::now();
            neg.retain(|_, (until, _)| *until > now);
            if neg.len() >= NEGATIVE_MAX {
                neg.clear();
            }
        }
        neg.insert(url.to_string(), (Instant::now() + ttl, err));
    }

    /// `url` = `Catalog::thumbnail_source` (already allow-listed for its source). Coalesces concurrent misses of one
    /// URL into one fetch; misses take a `thumb_fetch` token for `ip` first.
    pub async fn get(
        &self,
        url: &str,
        ip: IpAddr,
        fetcher: &dyn Fetcher,
        state: &AppState,
    ) -> Result<ThumbHit, ThumbError> {
        let key = sha256_hex(url.as_bytes());
        // A hit is counted by the route (as `hit`, or `not_modified` when it answers 304).
        if let Some(e) = self.lookup(&key) {
            return Ok(ThumbHit {
                content_type: e.content_type,
                etag: e.etag,
                max_age_s: e
                    .expires
                    .duration_since(SystemTime::now())
                    .map_or(0, |d| u32::try_from(d.as_secs()).unwrap_or(MAX_AGE_S).min(MAX_AGE_S)),
                body: ThumbBody::Disk { path: e.path, len: e.len },
            });
        }
        if let Some(err) = self.negative(url) {
            self.count(match err {
                ThumbError::Upstream { .. } => "upstream_error",
                ThumbError::Refused(_) => "refused",
                _ => "not_found",
            });
            return Err(err);
        }
        if let Err(e) = enforce(state, RateClass::ThumbFetch, ip, None) {
            self.count("rate_limited");
            let retry = e.retry_after_s().unwrap_or(1);
            return Err(ThumbError::RateLimited { retry_after_s: u32::try_from(retry).unwrap_or(u32::MAX) });
        }
        let cell = {
            let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
            inflight.entry(key.clone()).or_default().clone()
        };
        let result = cell.get_or_init(|| self.fetch(url, &key, fetcher)).await.clone();
        self.inflight.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        match &result {
            Ok(_) => self.count("miss"),
            Err(ThumbError::Upstream { .. }) => self.count("upstream_error"),
            Err(ThumbError::Refused(_)) => self.count("refused"),
            Err(_) => self.count("not_found"),
        }
        result
    }

    async fn fetch(&self, url: &str, key: &str, fetcher: &dyn Fetcher) -> Result<ThumbHit, ThumbError> {
        let upstream = ThumbError::Upstream { retry_after_s: 60 };
        let Ok(Ok(_permit)) = tokio::time::timeout(PERMIT_WAIT, self.permits.acquire()).await else {
            return Err(upstream);
        };
        let request = FetchRequest {
            method: Method::Get,
            url: url.to_string(),
            headers: vec![("accept".into(), ACCEPT.into())],
            body: None,
            max_body_bytes: MAX_THUMB_BYTES,
            timeout: FETCH_TIMEOUT,
        };
        let response = match fetcher.fetch(request).await {
            Ok(r) => r,
            Err(FetchError::BodyTooLarge { .. }) => return self.refuse(url, "too large"),
            Err(FetchError::Blocked(_)) => return self.refuse(url, "blocked"),
            Err(_) => {
                self.remember(url, upstream, NEG_UPSTREAM);
                return Err(upstream);
            }
        };
        match response.status {
            200 => {}
            400..=499 => {
                self.remember(url, ThumbError::NotFound, NEG_4XX);
                return Err(ThumbError::NotFound);
            }
            500..=599 => {
                self.remember(url, upstream, NEG_UPSTREAM);
                return Err(upstream);
            }
            _ => return self.refuse(url, "status"),
        }
        let declared = response.header("content-type").unwrap_or("");
        if !is_allowed_content_type(declared) {
            return self.refuse(url, "content type");
        }
        if response.body.is_empty() || response.body.len() > MAX_THUMB_BYTES {
            return self.refuse(url, "size");
        }
        let Some(content_type) = sniff(&response.body) else { return self.refuse(url, "not an image") };
        let (max_age_s, store) = freshness(response.header("cache-control"));
        let body = Bytes::from(response.body);
        let etag = sha256_hex(&body);
        if store && self.cap > 0 {
            self.store(key, content_type, &etag, &body, max_age_s).await;
        }
        Ok(ThumbHit { content_type, etag, body: ThumbBody::Memory(body), max_age_s })
    }

    fn refuse(&self, url: &str, why: &'static str) -> Result<ThumbHit, ThumbError> {
        self.remember(url, ThumbError::Refused(why), NEG_REFUSED);
        Err(ThumbError::Refused(why))
    }

    async fn store(&self, key: &str, content_type: &'static str, etag: &str, body: &Bytes, max_age_s: u32) {
        let path = self.path_for(key, content_type);
        let expires = SystemTime::now() + Duration::from_secs(u64::from(max_age_s));
        let (p, b) = (path.clone(), body.clone());
        let written = tokio::task::spawn_blocking(move || write_atomic(&p, &b, expires)).await;
        if !matches!(written, Ok(Ok(()))) {
            return;
        }
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        index.tick += 1;
        let entry =
            Entry { path, len: body.len() as u64, content_type, etag: etag.to_string(), expires, used: index.tick };
        index.total += entry.len;
        if let Some(old) = index.entries.insert(key.to_string(), entry) {
            index.total -= old.len;
        }
        drop(index);
        self.evict();
    }

    /// Least recently used files go once the total passes the cap (down to 90 %).
    fn evict(&self) {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if index.total <= self.cap {
            return;
        }
        let target = self.cap / 10 * 9;
        let mut order: Vec<(u64, String)> = index.entries.iter().map(|(k, e)| (e.used, k.clone())).collect();
        order.sort_unstable();
        for (_, key) in order {
            if index.total <= target {
                break;
            }
            if let Some(e) = index.entries.remove(&key) {
                index.total -= e.len;
                let _ = std::fs::remove_file(&e.path);
            }
        }
    }

    /// Delete the files whose URL is not in `keep` (the thumbnails of visible games; the `catalog.policy` job).
    pub fn retain_urls(&self, keep: &std::collections::HashSet<String>) -> usize {
        let keys: std::collections::HashSet<String> = keep.iter().map(|u| sha256_hex(u.as_bytes())).collect();
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        let gone: Vec<String> = index.entries.keys().filter(|k| !keys.contains(*k)).cloned().collect();
        for k in &gone {
            if let Some(e) = index.entries.remove(k) {
                index.total -= e.len;
                let _ = std::fs::remove_file(&e.path);
            }
        }
        gone.len()
    }

    pub fn diagnostics(&self) -> Value {
        let (entries, bytes) = {
            let index = self.index.lock().unwrap_or_else(|e| e.into_inner());
            (index.entries.len(), index.total)
        };
        json!({
            "entries": entries,
            "bytes": bytes,
            "cap_bytes": self.cap,
            "hits": self.counter("hit"),
            "misses": self.counter("miss"),
            "refused": self.counter("refused"),
            "upstream_errors": self.counter("upstream_error"),
            "negative_entries": self.negative.lock().unwrap_or_else(|e| e.into_inner()).len(),
        })
    }

    pub fn metrics(&self, out: &mut String) {
        use std::fmt::Write;
        let _ = writeln!(out, "# HELP gnome_thumb_requests_total Thumbnail proxy answers by result.");
        let _ = writeln!(out, "# TYPE gnome_thumb_requests_total counter");
        for r in RESULTS {
            let _ = writeln!(out, "gnome_thumb_requests_total{{result=\"{r}\"}} {}", self.counter(r));
        }
        let bytes = self.index.lock().unwrap_or_else(|e| e.into_inner()).total;
        let _ = writeln!(out, "# HELP gnome_thumb_cache_bytes Bytes in the thumbnail disk cache.");
        let _ = writeln!(out, "# TYPE gnome_thumb_cache_bytes gauge");
        let _ = writeln!(out, "gnome_thumb_cache_bytes {bytes}");
    }
}

fn write_atomic(path: &Path, body: &[u8], expires: SystemTime) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
    std::fs::create_dir_all(parent)?;
    let tmp =
        parent.join(format!(".tmp-{}", crate::security::crypto::hex(&crate::security::crypto::random_bytes::<8>())));
    let result = (|| {
        let f = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut &f, body)?;
        f.set_modified(expires)?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn scan_dir(dir: &Path) -> Vec<(String, Entry)> {
    let mut out = Vec::new();
    let Ok(top) = std::fs::read_dir(dir) else { return out };
    let now = SystemTime::now();
    let mut found: Vec<(SystemTime, String, Entry)> = Vec::new();
    for sub in top.flatten() {
        let Ok(files) = std::fs::read_dir(sub.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            let name = f.file_name().to_string_lossy().into_owned();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if name.starts_with(".tmp-") || !meta.is_file() {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let Some((key, ext)) = name.split_once('.') else { continue };
            let (Some(content_type), true) =
                (type_of_extension(ext), key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()))
            else {
                continue;
            };
            let expires = meta.modified().unwrap_or(now);
            if expires <= now {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let Ok(body) = std::fs::read(&path) else { continue };
            let entry = Entry { path, len: meta.len(), content_type, etag: sha256_hex(&body), expires, used: 0 };
            found.push((expires, key.to_string(), entry));
        }
    }
    // Initial recency: the files that expire last were stored last.
    found.sort_by_key(|(t, _, _)| *t);
    for (i, (_, key, mut entry)) in found.into_iter().enumerate() {
        entry.used = i as u64;
        out.push((key, entry));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffing() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0"), Some("image/avif"));
        assert_eq!(sniff(b"<svg xmlns="), None);
        assert_eq!(sniff(b"<!doctype html>"), None);
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn freshness_rules() {
        assert_eq!(freshness(None), (MAX_AGE_S, true));
        assert_eq!(freshness(Some("public, max-age=3600")), (3600, true));
        assert_eq!(freshness(Some("max-age=99999999")), (MAX_AGE_S, true));
        assert_eq!(freshness(Some("no-store")), (MAX_AGE_S, false));
        assert_eq!(freshness(Some("max-age=0")), (0, false));
    }
}
