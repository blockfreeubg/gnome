//! The games module (WAVE-C §4): the reviewed `gnome-catalog` crate wired into gnome-server, plus what the crate
//! leaves to the server: feed and thumbnail fetchers over gnome-net, the public routes, the admin endpoints, the jobs,
//! the CLI, the thumbnail cache, the frame policy and its wrapper document, the OSS fetch and serving, `/ads.txt`,
//! metrics and diagnostics.

pub mod admin; // /admin/catalog/*, /admin/games/*
pub mod ads_txt; // GET /ads.txt (D22)
pub mod cli; // gnome-server catalog …
pub mod fetcher; // CatalogFetcher: gnome_catalog::Fetcher over gnome_net::SafeClient
pub mod frames; // FramePolicy (D4), the wrapper /play-frame/<slug> (D2), the pending report
pub mod jobs; // catalog.import, catalog.rankings, catalog.policy, catalog.oss-fetch
pub mod oss; // OSS fetch (D6) and /oss/<slug>/** (D5)
pub mod replay; // ReplayFetcher for `catalog import --replay` (D19)
pub mod routes; // /api/games*, /api/thumb/:id, /play-frame/:slug
pub mod thumbs; // ThumbCache: disk LRU + validated upstream fetch (D7)

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use axum::Router;
use axum::routing::{get, post};
use gnome_catalog::{CatalogError, CatalogStats, Clock, Fetcher, PrepareReport, RenderOptions, WriteDb};
use serde_json::json;

use crate::api::meta::PublicConfig;
use crate::db::{Db, DbError};
use crate::error::ApiError;
use crate::jobs::Job;
use crate::module::{Diagnostics, Module, ModuleSetup};
use crate::state::AppState;
use crate::util::BoxFuture;

pub const IMPORT_JOB: &str = "catalog.import";
pub const RANKINGS_JOB: &str = "catalog.rankings";
pub const POLICY_JOB: &str = "catalog.policy";
pub const OSS_FETCH_JOB: &str = "catalog.oss-fetch";

/// Knobs for tests and embedding; production uses the defaults.
#[derive(Default)]
pub struct GamesOptions {
    /// Feed fetcher (default: `CatalogFetcher::for_feeds`). Tests pass a `gnome_catalog::FixtureFetcher`.
    pub fetcher: Option<Arc<dyn Fetcher>>,
    /// Thumbnail fetcher (default: `CatalogFetcher::for_thumbnails`).
    pub thumb_fetcher: Option<Arc<dyn Fetcher>>,
    /// Client of the OSS fetch (default: strict policy, `allowed_hosts(["codeload.github.com"])`).
    pub oss_client: Option<gnome_net::SafeClient>,
    /// Clock (default `gnome_catalog::TokioClock`).
    pub clock: Option<Arc<dyn Clock>>,
}

/// Cached counters behind the metrics (the metrics hook is synchronous).
#[derive(Debug, Default)]
pub struct Counters {
    pub plays: AtomicU64,
    /// `(source, status)` → finished runs since start.
    pub runs: Mutex<std::collections::BTreeMap<(String, String), u64>>,
}

/// Shared state, published with `ModuleSetup::provide`.
pub struct Games {
    pub catalog: Arc<gnome_catalog::Catalog>,
    pub frames: frames::FramePolicy,
    pub thumbs: thumbs::ThumbCache,
    pub oss: oss::OssBuilds,
    /// `None` until `prepare` ran, `Some(Err(_))` when it failed: in both cases the routes answer 503 (D21).
    pub prepared: RwLock<Option<Result<PrepareReport, String>>>,
    pub counters: Counters,
    fetcher: Option<Arc<dyn Fetcher>>,
    fetcher_error: Option<String>,
    thumb_fetcher: Option<Arc<dyn Fetcher>>,
    oss_client: Option<gnome_net::SafeClient>,
    clock: Arc<dyn Clock>,
    stats: RwLock<Option<CatalogStats>>,
    /// Sources with an import started by the admin endpoint or the job (one run of a source at a time).
    importing: Mutex<Vec<gnome_catalog::Source>>,
}

impl std::fmt::Debug for Games {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Games").finish_non_exhaustive()
    }
}

impl Games {
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    pub fn clock(&self) -> &dyn Clock {
        self.clock.as_ref()
    }

    /// The feed fetcher, or why there is none.
    pub fn fetcher(&self) -> Result<&dyn Fetcher, String> {
        self.fetcher.as_deref().ok_or_else(|| self.fetcher_error.clone().unwrap_or_else(|| "no feed client".into()))
    }

    pub fn thumb_fetcher(&self) -> Option<&dyn Fetcher> {
        self.thumb_fetcher.as_deref()
    }

    pub fn oss_client(&self) -> Option<&gnome_net::SafeClient> {
        self.oss_client.as_ref()
    }

    /// `Ok` once `prepare` ran without error; else `503 unavailable` + `Retry-After: 30` (D21).
    pub fn ready(&self) -> Result<(), ApiError> {
        match &*self.prepared.read().unwrap_or_else(|e| e.into_inner()) {
            Some(Ok(_)) => Ok(()),
            _ => Err(unavailable()),
        }
    }

    pub fn prepare_error(&self) -> Option<String> {
        match &*self.prepared.read().unwrap_or_else(|e| e.into_inner()) {
            Some(Err(e)) => Some(e.clone()),
            None => Some("not prepared yet".into()),
            Some(Ok(_)) => None,
        }
    }

    pub fn cached_stats(&self) -> Option<CatalogStats> {
        self.stats.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Reserve `source` for one import run (`false`: one is already running in this process).
    pub fn begin_import(&self, source: gnome_catalog::Source) -> bool {
        let mut running = self.importing.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains(&source) {
            return false;
        }
        running.push(source);
        true
    }

    pub fn end_import(&self, source: gnome_catalog::Source) {
        self.importing.lock().unwrap_or_else(|e| e.into_inner()).retain(|s| *s != source);
    }

    pub fn is_importing(&self, source: gnome_catalog::Source) -> bool {
        self.importing.lock().unwrap_or_else(|e| e.into_inner()).contains(&source)
    }

    pub fn record_run(&self, source: &str, status: &str) {
        let mut runs = self.counters.runs.lock().unwrap_or_else(|e| e.into_inner());
        *runs.entry((source.to_string(), status.to_string())).or_default() += 1;
    }

    /// Recompute the pending-host report and the cached stats (after imports, admin changes, the policy job).
    pub async fn refresh(&self, state: &AppState) -> Result<(), ApiError> {
        let games = state.ext::<Games>().ok_or_else(|| ApiError::internal_from("games module state missing"))?;
        let now = self.now_ms();
        let stats = state
            .db
            .read(move |c| -> Result<CatalogStats, ApiError> {
                games.frames.refresh(&games.catalog, c, now).map_err(catalog_error)?;
                games.catalog.stats(c).map_err(catalog_error)
            })
            .await?;
        *self.stats.write().unwrap_or_else(|e| e.into_inner()) = Some(stats);
        Ok(())
    }
}

/// `503 unavailable` with `Retry-After: 30`.
pub fn unavailable() -> ApiError {
    ApiError::unavailable("the game catalog is not ready").with_retry_after(std::time::Duration::from_secs(30))
}

/// The crate's errors as API errors: caller input → `400 bad_request` (D10), storage → `503` (D21).
pub fn catalog_error(e: CatalogError) -> ApiError {
    match e {
        CatalogError::InvalidInput(m) => ApiError::bad_request(m),
        CatalogError::NotFound => ApiError::not_found(),
        CatalogError::Busy(s) => ApiError::conflict(format!("an import of {} is already running", s.id())),
        other => {
            tracing::warn!(error = %other, "game catalog");
            unavailable()
        }
    }
}

impl WriteDb for Db {
    // The trait spells out `+ Send`; an `async fn` here would not state it.
    #[allow(clippy::manual_async_fn)]
    fn write<T, F>(&self, f: F) -> impl Future<Output = Result<T, CatalogError>> + Send
    where
        T: Send + 'static,
        F: FnOnce(&mut rusqlite::Connection) -> Result<T, CatalogError> + Send + 'static,
    {
        async move {
            Db::write(self, move |c| Ok::<_, DbError>(f(c))).await.map_err(|e| CatalogError::Storage(e.to_string()))?
        }
    }
}

/// The games module.
pub struct GamesModule {
    games: Arc<Games>,
}

/// `None` when `config.catalog.sources` is empty (`GNOME_CATALOG_SOURCES=none`, or every source gated off): the
/// routes then do not exist (404) and `/api/config` keeps `features.games: false`.
pub fn install(setup: &mut ModuleSetup<'_>, options: GamesOptions) -> Option<Arc<dyn Module>> {
    let config = &setup.state.config;
    if config.catalog.sources.is_empty() {
        return None;
    }
    let app_origin =
        config.proxy.app_origins().first().or_else(|| config.public_origins.first()).cloned().unwrap_or_default();
    let render = RenderOptions {
        app_origin,
        proxy_origin: config.proxy.origin().unwrap_or_default().to_string(),
        thumb_proxy: config.thumb_proxy,
    };
    let secret = setup.state.secret.derive("gnome/catalog/cursor");
    let catalog = Arc::new(gnome_catalog::Catalog::new(config.catalog.clone(), &secret, render));
    let source_url = config.source_url.as_deref();
    let (fetcher, fetcher_error) = match options.fetcher {
        Some(f) => (Some(f), None),
        None => match fetcher::CatalogFetcher::for_feeds(&config.catalog.sources, source_url) {
            Ok(f) => (Some(Arc::new(f) as Arc<dyn Fetcher>), None),
            Err(e) => {
                tracing::error!(error = %e, "game feeds cannot be fetched");
                (None, Some(e))
            }
        },
    };
    let thumb_fetcher = options.thumb_fetcher.or_else(|| {
        fetcher::CatalogFetcher::for_thumbnails(catalog.thumb_policy(), source_url)
            .map(|f| Arc::new(f) as Arc<dyn Fetcher>)
            .map_err(|e| tracing::error!(error = %e, "thumbnails cannot be fetched"))
            .ok()
    });
    let oss_client = options.oss_client.or_else(|| {
        let mut cfg = gnome_net::SafeClientConfig::default()
            .allowed_hosts([oss::ARCHIVE_HOST])
            .max_body_bytes(oss::MAX_ARCHIVE_BYTES)
            .timeout(oss::FETCH_TIMEOUT);
        if let Some(url) = source_url {
            cfg = cfg.source_url(url.to_string());
        }
        gnome_net::SafeClient::new(cfg).map_err(|e| tracing::error!(error = %e, "OSS builds cannot be fetched")).ok()
    });
    let games = setup.provide(Games {
        frames: frames::FramePolicy::new(config),
        thumbs: thumbs::ThumbCache::open(config.data_dir.join("thumbs"), config.thumb_cache_mb),
        oss: oss::OssBuilds::new(config),
        prepared: RwLock::new(None),
        counters: Counters::default(),
        fetcher,
        fetcher_error,
        thumb_fetcher,
        oss_client,
        clock: options.clock.unwrap_or_else(|| Arc::new(gnome_catalog::TokioClock)),
        stats: RwLock::new(None),
        importing: Mutex::new(Vec::new()),
        catalog,
    });
    Some(Arc::new(GamesModule { games }))
}

impl GamesModule {
    async fn prepare_inner(&self, state: &AppState) -> Result<PrepareReport, String> {
        let games = &self.games;
        let cat = games.catalog.clone();
        let now = games.now_ms();
        let report = WriteDb::write(&state.db, move |c| cat.prepare(c, now)).await.map_err(|e| e.to_string())?;
        let config = state.config.clone();
        let g = games.clone();
        tokio::task::spawn_blocking(move || g.oss.rescan(&config.catalog))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("open-source games: {e}"))?;
        games.refresh(state).await.map_err(|e| e.to_string())?;
        Ok(report)
    }
}

impl Module for GamesModule {
    fn name(&self) -> &'static str {
        "games"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
            .route("/api/games", get(routes::list))
            .route("/api/games/sections", get(routes::sections))
            .route("/api/games/categories", get(routes::categories))
            .route("/api/games/tags", get(routes::tags))
            .route("/api/games/by-ids", get(routes::by_ids))
            .route("/api/games/status", get(routes::status))
            .route("/api/games/{slug}", get(routes::game))
            .route("/api/games/{slug}/play", post(routes::play))
            .route("/api/thumb/{id}", get(routes::thumb))
            .route("/play-frame/{slug}", get(routes::play_frame))
            .route("/ads.txt", get(ads_txt::serve))
    }

    fn proxy_routes(&self, state: &AppState) -> Router<AppState> {
        if !state.config.proxy.isolated() {
            return Router::new();
        }
        Router::new().route("/oss/{slug}/{*path}", get(oss::serve))
    }

    fn admin_routes(&self, _state: &AppState) -> Router<AppState> {
        admin::routes()
    }

    fn jobs(&self, state: &AppState) -> Vec<Job> {
        jobs::jobs(state)
    }

    fn prepare<'a>(&'a self, state: &'a AppState) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let result = self.prepare_inner(state).await;
            if let Err(e) = &result {
                tracing::error!(error = %e, "the game catalog is unavailable");
            }
            *self.games.prepared.write().unwrap_or_else(|e| e.into_inner()) = Some(result);
            let games = self.games.clone();
            state.tasks.spawn(async move { games.thumbs.scan().await });
        })
    }

    fn public_config(&self, state: &AppState, config: &mut PublicConfig) {
        config.features.games = self.games.ready().is_ok() && !state.config.catalog.sources.is_empty();
        config.features.thumb_proxy = state.config.thumb_proxy;
    }

    fn diagnostics<'a>(&'a self, state: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let cat = self.games.catalog.clone();
            if let Ok(stats) = state.db.read(move |c| cat.stats(c).map_err(catalog_error)).await {
                out.insert("catalog".into(), serde_json::to_value(stats).unwrap_or_default());
            }
            let g = &self.games;
            let scan = g.oss.last_scan();
            out.insert(
                "games".into(),
                json!({
                    "prepared": g.ready().is_ok(),
                    "error": g.prepare_error().filter(|_| g.ready().is_err()),
                    "embed_hosts": g.frames.report(),
                    "thumbs": g.thumbs.diagnostics(),
                    "oss": {
                        "dir": g.oss.dir().display().to_string(),
                        "served": scan.served,
                        "missing": scan.missing,
                        "outdated": scan.outdated,
                        "unpinned": scan.unpinned,
                        "last_fetch": g.oss.last_fetch(),
                    },
                }),
            );
        })
    }

    fn metrics(&self, _state: &AppState, out: &mut String) {
        metrics(&self.games, out);
    }
}

fn metrics(g: &Games, out: &mut String) {
    use std::fmt::Write;
    let _ = writeln!(out, "# HELP gnome_catalog_games Games in the catalog by source and state.");
    let _ = writeln!(out, "# TYPE gnome_catalog_games gauge");
    let mut last_complete = Vec::new();
    if let Some(stats) = g.cached_stats() {
        for (source, s) in &stats.by_source {
            for (state, n) in [
                ("listed", s.listed),
                ("active", s.active),
                ("hidden", s.hidden),
                ("broken", s.broken),
                ("ip_risk", s.ip_risk),
            ] {
                let _ = writeln!(out, "gnome_catalog_games{{source=\"{source}\",state=\"{state}\"}} {n}");
            }
            if let Some(run) = s.last_import.as_ref().filter(|r| r.complete)
                && let Some(t) = run.finished_at
            {
                last_complete.push((source.clone(), t / 1000));
            }
        }
    }
    let _ = writeln!(out, "# HELP gnome_catalog_import_runs_total Finished catalog import runs since start.");
    let _ = writeln!(out, "# TYPE gnome_catalog_import_runs_total counter");
    for ((source, status), n) in g.counters.runs.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        let _ = writeln!(out, "gnome_catalog_import_runs_total{{source=\"{source}\",status=\"{status}\"}} {n}");
    }
    let _ = writeln!(out, "# HELP gnome_catalog_last_complete_import_seconds Unix time of the last complete import.");
    let _ = writeln!(out, "# TYPE gnome_catalog_last_complete_import_seconds gauge");
    for (source, t) in last_complete {
        let _ = writeln!(out, "gnome_catalog_last_complete_import_seconds{{source=\"{source}\"}} {t}");
    }
    let _ = writeln!(out, "# HELP gnome_game_plays_total Counted game plays since start.");
    let _ = writeln!(out, "# TYPE gnome_game_plays_total counter");
    let _ = writeln!(out, "gnome_game_plays_total {}", g.counters.plays.load(Ordering::Relaxed));
    let report = g.frames.report();
    let _ = writeln!(out, "# HELP gnome_games_embed_hosts Game embed hosts by state.");
    let _ = writeln!(out, "# TYPE gnome_games_embed_hosts gauge");
    for (state, n) in [
        ("fixed", report.fixed.len()),
        ("approved", g.frames.approved_count()),
        ("pending", report.pending.len()),
        ("refused", report.refused.len()),
    ] {
        let _ = writeln!(out, "gnome_games_embed_hosts{{state=\"{state}\"}} {n}");
    }
    g.thumbs.metrics(out);
    let scan = g.oss.last_scan();
    let _ = writeln!(out, "# HELP gnome_oss_builds Open-source game builds by state.");
    let _ = writeln!(out, "# TYPE gnome_oss_builds gauge");
    for (state, n) in [
        ("served", scan.served.len()),
        ("missing", scan.missing.len()),
        ("outdated", scan.outdated.len()),
        ("failed", g.oss.failed().len()),
    ] {
        let _ = writeln!(out, "gnome_oss_builds{{state=\"{state}\"}} {n}");
    }
}
