//! Content-blocking filter-list service (API.md "Content-blocking filter lists", ARCHITECTURE §5.5,
//! `docs/research/content-blocking.md` §5–§6.1).
//!
//! The backend is a cache, not a blocker: it mirrors upstream list text (uBO/ABP syntax) and uBO's redirect resources
//! so every browser downloads them from this server once, and the client builds the engine in a Worker.
//!
//! * [`registry`]: the built-in lists (research defaults) + `GNOME_FILTER_LISTS_FILE` overrides.
//! * [`refresh`]: the `filters.refresh` job (every 10 minutes it checks which lists are due: `! Expires` of each list,
//!   else `GNOME_FILTERS_REFRESH_HOURS`, clamped to 4 h–7 d; failures back off), conditional GETs through
//!   `gnome-net`'s SSRF-safe client, mirrors, `!#include` flattening, SHA-256 change detection.
//! * [`store`]: content-addressed `$GNOME_DATA_DIR/filters/<id>.<sha256>.<txt|json>` (+ `.br`, `.gz` precompressed
//!   on change; a new version is written next to the old one, which is removed once the metadata names the new one)
//!   and per-list metadata in `kv` (`filters:<id>`).
//! * [`serve`]: `GET /api/filters` and `GET /api/filters/{id}` on **both** origins (`shared_routes`: read-only,
//!   public, no session) with strong SHA-256 ETags, `304`, brotli/gzip negotiation and immutable caching for
//!   `?v=<sha256>` URLs.
//!
//! Lists with a `file` source (`GNOME_FILTER_LISTS_FILE`, registry.rs) are read from disk by their own job,
//! [`FILES_JOB`]: right after the startup check, then every 10 minutes, also with `GNOME_FILTERS_REFRESH_HOURS=0`
//! (reading a local file costs no upstream request), and by every forced refresh (`gnome-server filters refresh`,
//! `POST /admin/filters/refresh`).
//!
//! The first fetch happens in the background shortly after start; the server serves without it (lists answer `503`
//! until they are stored, `GET /api/filters` reports `available: false`). `gnome-server filters refresh` and
//! `POST /admin/filters/refresh` check every list immediately.

pub mod refresh;
pub mod registry;
pub mod serve;
pub mod store;
pub mod text;

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use gnome_net::{SafeClient, SafeClientConfig};
use http::StatusCode;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};
use tokio_util::sync::CancellationToken;

use self::refresh::{Mode, Outcome};
use self::registry::ListDef;
use self::store::{Files, Meta};
use crate::db::Db;
use crate::jobs::Job;
use crate::module::{Diagnostics, Module, ModuleSetup};
use crate::state::AppState;
use crate::util::{BoxFuture, now_ms};

/// Job name (diagnostics, `JobRegistry::trigger`).
pub const JOB: &str = "filters.refresh";
/// How often the job looks for due lists (cheap: an in-memory check).
pub const TICK: Duration = Duration::from_secs(600);
/// Delay of the first check after start (the first fetch of a new install happens then).
pub const FIRST_RUN: Duration = Duration::from_secs(10);
/// Job that re-reads the file lists (first run as soon as the server serves, then every [`TICK`]).
pub const FILES_JOB: &str = "filters.files";

/// Knobs for tests and embedding; production uses the defaults.
#[derive(Debug, Default)]
pub struct FilterOptions {
    /// Client used for upstream fetches (default: strict IP policy, `User-Agent` with `GNOME_SOURCE_URL`).
    pub client: Option<SafeClient>,
    /// Allow `http` upstream URLs (tests against local servers).
    pub allow_http: bool,
    /// Registry to use instead of `Config::filter_lists`.
    pub lists: Option<Vec<ListDef>>,
}

/// A list's state in memory.
#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub meta: Meta,
    /// `None` until a body is stored (and after a startup check found the stored files inconsistent).
    pub files: Option<Arc<Files>>,
}

impl Entry {
    /// Whether both describe the same stored version (same SHA-256 and the same files).
    fn same_version(&self, other: &Entry) -> bool {
        self.meta.sha256 == other.meta.sha256
            && match (&self.files, &other.files) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b) || a == b,
                (None, None) => true,
                _ => false,
            }
    }
}

/// Counters for `/admin/metrics`.
#[derive(Debug, Default)]
pub struct Stats {
    pub updated: AtomicU64,
    pub unchanged: AtomicU64,
    pub not_modified: AtomicU64,
    pub failed: AtomicU64,
    pub downloaded_bytes: AtomicU64,
    /// List bodies sent to clients (200) and revalidations answered `304`.
    pub served: AtomicU64,
    pub served_not_modified: AtomicU64,
}

impl Stats {
    fn count(&self, outcome: &Outcome) {
        let c = match outcome {
            Outcome::Updated { .. } => &self.updated,
            Outcome::Unchanged => &self.unchanged,
            Outcome::NotModified => &self.not_modified,
            Outcome::Failed { .. } => &self.failed,
            Outcome::Skipped => return,
        };
        c.fetch_add(1, Ordering::Relaxed);
    }
}

/// Shared state of the filter-list service (`Ext<FilterService>`, `state.ext::<FilterService>()`).
pub struct FilterService {
    pub defs: Vec<ListDef>,
    pub dir: PathBuf,
    db: Db,
    client: Result<SafeClient, String>,
    allow_http: bool,
    refresh_hours: u32,
    shutdown: CancellationToken,
    index: RwLock<HashMap<String, Entry>>,
    loaded: watch::Sender<bool>,
    refresh_lock: tokio::sync::Mutex<()>,
    compress_permits: Semaphore,
    force: AtomicBool,
    /// Bumped on every index change; keys the cached `GET /api/filters` body.
    generation: AtomicU64,
    listing: std::sync::Mutex<Option<serve::CachedListing>>,
    pub stats: Stats,
}

impl std::fmt::Debug for FilterService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilterService").field("lists", &self.defs.len()).field("dir", &self.dir).finish_non_exhaustive()
    }
}

impl FilterService {
    pub fn new(state: &AppState, options: FilterOptions) -> Self {
        let config = &state.config;
        let client = match options.client {
            Some(c) => Ok(c),
            None => {
                let mut cfg = SafeClientConfig::default().timeout(refresh::FETCH_TIMEOUT);
                if let Some(url) = &config.source_url {
                    cfg = cfg.source_url(url.clone());
                }
                SafeClient::new(cfg).map_err(|e| format!("outbound HTTP client: {e}"))
            }
        };
        if let Err(e) = &client {
            tracing::error!(error = %e, "filter lists cannot be fetched");
        }
        Self {
            defs: options.lists.unwrap_or_else(|| config.filter_lists.clone()),
            dir: config.data_dir.join("filters"),
            db: state.db.clone(),
            client,
            allow_http: options.allow_http,
            refresh_hours: config.filters_refresh_hours,
            shutdown: state.shutdown.clone(),
            index: RwLock::new(HashMap::new()),
            loaded: watch::Sender::new(false),
            refresh_lock: tokio::sync::Mutex::new(()),
            compress_permits: Semaphore::new(2),
            force: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            listing: std::sync::Mutex::new(None),
            stats: Stats::default(),
        }
    }

    pub fn def(&self, id: &str) -> Option<&ListDef> {
        self.defs.iter().find(|d| d.id == id)
    }

    /// The in-memory state of a list.
    pub fn entry(&self, id: &str) -> Option<Entry> {
        self.index.read().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }

    fn set_entry(&self, id: &str, meta: Meta, files: Option<Arc<Files>>) {
        self.index.write().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), Entry { meta, files });
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Whether the startup check of the stored lists has finished.
    pub fn is_loaded(&self) -> bool {
        *self.loaded.borrow()
    }

    /// Wait for the startup check of the stored lists.
    pub async fn wait_loaded(&self) {
        let mut rx = self.loaded.subscribe();
        let _ = rx.wait_for(|loaded| *loaded).await;
    }

    /// Startup: read metadata, verify the stored files (rebuilding missing compressed variants), drop lists that
    /// are no longer in the registry, then mark the service loaded.
    pub async fn load(&self) {
        let rows: HashMap<String, Meta> = match store::load_all(&self.db).await {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                tracing::error!(error = %e, "cannot read filter-list metadata; lists will be fetched again");
                HashMap::new()
            }
        };
        let dir = self.dir.clone();
        let defs: Vec<(String, &'static str)> =
            self.defs.iter().map(|d| (d.id.clone(), d.format.extension())).collect();
        let known: Vec<(String, Meta)> = rows.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let checked = tokio::task::spawn_blocking(move || {
            if let Err(e) = crate::state::ensure_private_dir(&dir) {
                tracing::error!(dir = %dir.display(), error = %e, "cannot create the filter-list directory");
            }
            // Another process (`gnome-server filters refresh` next to a server) may be writing right now: only files
            // older than STALE_AGE are left over.
            store::clean_temp_files(&dir, store::STALE_AGE);
            let mut out = Vec::new();
            for (id, ext) in &defs {
                let meta = known.iter().find(|(k, _)| k == id).map(|(_, m)| m.clone());
                let verified = meta.as_ref().and_then(|m| store::verify(&dir, id, ext, m));
                // Only versions the metadata does not name are removed: a version that failed the check (perhaps
                // just unreadable for a moment) is rewritten or superseded by the next fetch.
                let keep = meta.as_ref().and_then(|m| m.sha256.as_deref());
                store::remove_other_versions(&dir, id, ext, keep, store::STALE_AGE);
                out.push((id.clone(), meta, verified));
            }
            for (id, _) in known.iter().filter(|(k, _)| !defs.iter().any(|(d, _)| d == k)) {
                for ext in ["txt", "json"] {
                    store::remove_other_versions(&dir, id, ext, None, Duration::ZERO);
                }
            }
            out
        })
        .await
        .unwrap_or_default();
        for (id, meta, verified) in checked {
            let mut meta = meta.unwrap_or_default();
            // Corrections are compare-and-set on the version, so they never undo a version another process stored
            // after this one read the metadata.
            let files = match verified {
                Some((files, br, gz)) => {
                    if (br, gz) != (meta.size_br, meta.size_gzip) {
                        meta.size_br = br;
                        meta.size_gzip = gz;
                        let _ = store::save_if_version(&self.db, &id, &meta, meta.sha256.as_deref()).await;
                    }
                    Some(Arc::new(files))
                }
                None => {
                    if let Some(sha) = meta.sha256.take() {
                        meta = Meta { next_check_at: 0, ..Meta::default() };
                        let _ = store::save_if_version(&self.db, &id, &meta, Some(&sha)).await;
                    }
                    None
                }
            };
            self.set_entry(&id, meta, files);
        }
        for id in rows.keys().filter(|k| self.def(k).is_none()) {
            tracing::info!(list = %id, "removing a filter list that is no longer configured");
            let _ = store::delete(&self.db, id).await;
        }
        self.loaded.send_replace(true);
    }

    /// Look a list up again after the files of `stale` (an entry read from the index) went missing. If this process
    /// replaced the list, the index already holds the new version; otherwise another process (e.g.
    /// `gnome-server filters refresh`) did, and its metadata row names the version to serve. The index is only
    /// updated while it still holds `stale` (compare-and-set), so a late reader never undoes a newer replacement.
    pub async fn reload_entry(&self, id: &str, stale: &Entry) -> Option<Entry> {
        let def = self.def(id)?;
        if let Some(current) = self.entry(id).filter(|c| !c.same_version(stale)) {
            return Some(current);
        }
        let meta = match store::load_one(&self.db, id).await {
            Ok(meta) => meta.unwrap_or_default(),
            Err(e) => {
                // Leave the index alone: this request answers "try again", the next one looks again.
                tracing::warn!(list = id, error = %e, "cannot re-read filter-list metadata");
                return None;
            }
        };
        let dir = self.dir.clone();
        let (id_owned, ext, m) = (id.to_string(), def.format.extension(), meta.clone());
        let files = tokio::task::spawn_blocking(move || store::stat_files(&dir, &id_owned, ext, &m))
            .await
            .ok()
            .flatten()
            .map(Arc::new);
        let fresh = Entry { meta, files };
        let mut index = self.index.write().unwrap_or_else(|e| e.into_inner());
        if let Some(current) = index.get(id).filter(|c| !c.same_version(stale)) {
            return Some(current.clone());
        }
        index.insert(id.to_string(), fresh.clone());
        drop(index);
        self.generation.fetch_add(1, Ordering::SeqCst);
        Some(fresh)
    }

    /// Ids of the lists read from local files.
    pub fn file_list_ids(&self) -> Vec<String> {
        self.defs.iter().filter(|d| d.is_file()).map(|d| d.id.clone()).collect()
    }

    /// Ids of the lists fetched from upstream URLs.
    pub fn url_list_ids(&self) -> Vec<String> {
        self.defs.iter().filter(|d| !d.is_file()).map(|d| d.id.clone()).collect()
    }

    /// Read every file list now ([`FILES_JOB`]; waits for the startup check).
    pub async fn read_file_lists(self: &Arc<Self>) -> Vec<refresh::ListReport> {
        let ids = self.file_list_ids();
        if ids.is_empty() {
            return Vec::new();
        }
        self.refresh(Mode::All, Some(&ids)).await
    }

    /// Ask the job for a full refresh (every list, now). Without a running job (CLI, tests) the refresh runs on
    /// `state.tasks`.
    pub fn request_refresh(self: &Arc<Self>, state: &AppState) {
        self.force.store(true, Ordering::SeqCst);
        if !state.jobs.trigger(JOB) {
            let svc = Arc::clone(self);
            state.tasks.spawn(async move {
                if svc.force.swap(false, Ordering::SeqCst) {
                    svc.refresh(Mode::All, None).await;
                }
            });
        }
    }

    /// One `/admin/diagnostics` row per list.
    pub fn status(&self) -> Vec<Value> {
        let index = self.index.read().unwrap_or_else(|e| e.into_inner());
        self.defs
            .iter()
            .map(|d| {
                let e = index.get(&d.id).cloned().unwrap_or_default();
                let m = &e.meta;
                json!({
                    "id": d.id,
                    // `file` lists are read from the operator's disk (the path is in the configuration only).
                    "source_kind": if d.is_file() { "file" } else { "url" },
                    "category": d.category.as_str(),
                    "default_enabled": d.default_enabled,
                    "available": e.files.is_some(),
                    "size": m.size,
                    "size_br": m.size_br,
                    "size_gzip": m.size_gzip,
                    "sha256": m.sha256,
                    "version": m.version,
                    "expires_s": m.expires_s,
                    "updated_at": m.updated_at,
                    "fetched_at": m.fetched_at,
                    "next_check_at": (m.next_check_at > 0).then_some(m.next_check_at),
                    "source": m.source,
                    "failures": m.failures,
                    "last_error": m.last_error,
                    "last_error_at": m.last_error_at,
                })
            })
            .collect()
    }
}

/// The filter-list module.
pub struct Filters {
    svc: Arc<FilterService>,
}

/// Build the service, publish it as module state and start the startup check of stored lists.
pub fn install(setup: &mut ModuleSetup<'_>, options: FilterOptions) -> Arc<dyn Module> {
    let svc = setup.provide(FilterService::new(setup.state, options));
    let loader = Arc::clone(&svc);
    setup.state.tasks.spawn(async move { loader.load().await });
    Arc::new(Filters { svc })
}

async fn admin_refresh(State(state): State<AppState>) -> Response {
    match state.ext::<FilterService>() {
        Some(svc) => {
            svc.request_refresh(&state);
            (StatusCode::ACCEPTED, axum::Json(json!({"job": JOB, "lists": svc.defs.len()}))).into_response()
        }
        None => crate::error::ApiError::not_found().into_response(),
    }
}

impl Module for Filters {
    fn name(&self) -> &'static str {
        "filters"
    }

    fn shared_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/api/filters", get(serve::list)).route("/api/filters/{id}", get(serve::body))
    }

    fn admin_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/admin/filters/refresh", post(admin_refresh))
    }

    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![
            Job::new(JOB, TICK, |state| async move {
                let svc = state.ext::<FilterService>().ok_or("filter-list state missing")?;
                let forced = svc.force.swap(false, Ordering::SeqCst);
                if !forced && svc.refresh_hours == 0 {
                    return Ok(());
                }
                // A forced run checks everything; a scheduled one the due upstream lists (FILES_JOB reads the files).
                let reports = if forced {
                    svc.refresh(Mode::All, None).await
                } else {
                    svc.refresh(Mode::Due, Some(&svc.url_list_ids())).await
                };
                let failed: Vec<&str> = reports
                    .iter()
                    .filter(|r| matches!(r.outcome, Outcome::Failed { .. }))
                    .map(|r| r.id.as_str())
                    .collect();
                if failed.is_empty() {
                    Ok(())
                } else {
                    Err(format!(
                        "{} of {} checked lists failed: {}",
                        failed.len(),
                        reports.iter().filter(|r| r.outcome != Outcome::Skipped).count(),
                        failed.join(", ")
                    )
                    .into())
                }
            })
            .first_run_after(FIRST_RUN),
            Job::new(FILES_JOB, TICK, |state| async move {
                let svc = state.ext::<FilterService>().ok_or("filter-list state missing")?;
                let reports = svc.read_file_lists().await;
                let failed: Vec<&str> = reports
                    .iter()
                    .filter(|r| matches!(r.outcome, Outcome::Failed { .. }))
                    .map(|r| r.id.as_str())
                    .collect();
                if failed.is_empty() {
                    Ok(())
                } else {
                    Err(format!(
                        "{} of {} file lists could not be read: {}",
                        failed.len(),
                        reports.len(),
                        failed.join(", ")
                    )
                    .into())
                }
            })
            .first_run_after(Duration::ZERO),
        ]
    }

    fn diagnostics<'a>(&'a self, _state: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            out.insert("filters".into(), Value::Array(self.svc.status()));
        })
    }

    fn metrics(&self, _state: &AppState, w: &mut String) {
        let svc = &self.svc;
        let now = now_ms();
        let index = svc.index.read().unwrap_or_else(|e| e.into_inner()).clone();
        let _ = writeln!(w, "# HELP gnome_filter_list_available Whether a filter list is stored and served.");
        let _ = writeln!(w, "# TYPE gnome_filter_list_available gauge");
        for d in &svc.defs {
            let up = index.get(&d.id).is_some_and(|e| e.files.is_some());
            let _ = writeln!(w, "gnome_filter_list_available{{id=\"{}\"}} {}", d.id, u8::from(up));
        }
        let _ = writeln!(w, "# HELP gnome_filter_list_bytes Size of a stored filter list (uncompressed).");
        let _ = writeln!(w, "# TYPE gnome_filter_list_bytes gauge");
        for d in &svc.defs {
            let size = index.get(&d.id).filter(|e| e.files.is_some()).map_or(0, |e| e.meta.size);
            let _ = writeln!(w, "gnome_filter_list_bytes{{id=\"{}\"}} {size}", d.id);
        }
        let _ = writeln!(
            w,
            "# HELP gnome_filter_list_age_seconds Seconds since a filter list was last checked successfully."
        );
        let _ = writeln!(w, "# TYPE gnome_filter_list_age_seconds gauge");
        for d in &svc.defs {
            if let Some(at) = index.get(&d.id).and_then(|e| e.meta.fetched_at) {
                let _ = writeln!(w, "gnome_filter_list_age_seconds{{id=\"{}\"}} {}", d.id, (now - at).max(0) / 1000);
            }
        }
        let _ = writeln!(w, "# HELP gnome_filter_list_failures Consecutive failed checks of a filter list.");
        let _ = writeln!(w, "# TYPE gnome_filter_list_failures gauge");
        for d in &svc.defs {
            let n = index.get(&d.id).map_or(0, |e| e.meta.failures);
            let _ = writeln!(w, "gnome_filter_list_failures{{id=\"{}\"}} {n}", d.id);
        }
        let s = &svc.stats;
        let _ = writeln!(w, "# HELP gnome_filter_checks_total Upstream checks of filter lists, by result.");
        let _ = writeln!(w, "# TYPE gnome_filter_checks_total counter");
        for (result, c) in [
            ("updated", &s.updated),
            ("unchanged", &s.unchanged),
            ("not_modified", &s.not_modified),
            ("failed", &s.failed),
        ] {
            let _ = writeln!(w, "gnome_filter_checks_total{{result=\"{result}\"}} {}", c.load(Ordering::Relaxed));
        }
        let _ = writeln!(w, "# HELP gnome_filter_downloaded_bytes_total Bytes of new filter-list content downloaded.");
        let _ = writeln!(w, "# TYPE gnome_filter_downloaded_bytes_total counter");
        let _ = writeln!(w, "gnome_filter_downloaded_bytes_total {}", s.downloaded_bytes.load(Ordering::Relaxed));
        let _ = writeln!(w, "# HELP gnome_filter_served_total Filter-list bodies served, by status.");
        let _ = writeln!(w, "# TYPE gnome_filter_served_total counter");
        let _ = writeln!(w, "gnome_filter_served_total{{status=\"200\"}} {}", s.served.load(Ordering::Relaxed));
        let _ = writeln!(
            w,
            "gnome_filter_served_total{{status=\"304\"}} {}",
            s.served_not_modified.load(Ordering::Relaxed)
        );
    }
}
