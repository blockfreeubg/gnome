//! Admin endpoints of the games module (WAVE-C §4.4), on the admin listener (loopback or token, `admin` class).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Router, response::IntoResponse, response::Response};
use gnome_catalog::{AdminStatus, ImportOptions, Source};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Games, IMPORT_JOB, OSS_FETCH_JOB, catalog_error};
use crate::error::{ApiError, ApiJson, OptionalJson};
use crate::module::Ext;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/catalog/import", post(import))
        .route("/admin/catalog/imports", get(imports))
        .route("/admin/catalog/oss-fetch", post(oss_fetch))
        .route("/admin/games/{id}/feature", post(feature))
        .route("/admin/games/{id}/status", post(status))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportBody {
    sources: Option<Vec<String>>,
    limit: Option<u64>,
}

fn field(name: &str, message: impl Into<String>) -> ApiError {
    ApiError::validation(BTreeMap::from([(name.to_string(), message.into())]))
}

/// Run imports of `sources` one after another (watching shutdown), then refresh the frame report and the stats.
pub async fn run_imports(state: &AppState, games: &Arc<Games>, sources: &[Source], limit: Option<usize>) -> Vec<Value> {
    let mut reports = Vec::new();
    for source in sources {
        if state.shutdown.is_cancelled() {
            break;
        }
        let result = match games.fetcher() {
            Ok(fetcher) => {
                let opts = ImportOptions { limit, max_pages: None };
                games.catalog.import(fetcher, games.clock(), &state.db, *source, opts).await
            }
            Err(e) => Err(gnome_catalog::CatalogError::Config(e)),
        };
        games.end_import(*source);
        match result {
            Ok(report) => {
                games.record_run(source.id(), &report.status);
                tracing::info!(source = source.id(), status = %report.status, inserted = report.inserted, "catalog import");
                reports.push(serde_json::to_value(&report).unwrap_or_default());
            }
            Err(e) => {
                tracing::warn!(source = source.id(), error = %e, "catalog import did not run");
                reports.push(json!({ "source": source.id(), "error": e.to_string() }));
            }
        }
    }
    for s in sources {
        games.end_import(*s);
    }
    if let Err(e) = games.refresh(state).await {
        tracing::warn!(error = %e.message, "catalog refresh after import");
    }
    reports
}

/// `POST /admin/catalog/import`.
async fn import(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    OptionalJson(body): OptionalJson<ImportBody>,
) -> Result<Response, ApiError> {
    games.ready()?;
    let body = body.unwrap_or_default();
    let enabled = &state.config.catalog.sources;
    let sources: Vec<Source> = match body.sources {
        None => enabled.clone(),
        Some(list) => {
            let mut out = Vec::new();
            for id in list {
                let Some(s) = Source::from_id(&id) else {
                    return Err(field("sources", format!("unknown source {id}")));
                };
                if !enabled.contains(&s) {
                    return Err(field("sources", format!("{id} is not enabled")));
                }
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            out
        }
    };
    let limit = match body.limit {
        None => None,
        Some(n) if (1..=100_000).contains(&n) => Some(n as usize),
        Some(_) => return Err(field("limit", "must be 1-100000")),
    };
    for (i, s) in sources.iter().enumerate() {
        if !games.begin_import(*s) {
            for done in &sources[..i] {
                games.end_import(*done);
            }
            return Err(ApiError::conflict(format!("an import of {} is already running", s.id())));
        }
    }
    let ids: Vec<&str> = sources.iter().map(|s| s.id()).collect();
    let answer = json!({ "job": IMPORT_JOB, "sources": ids });
    let (st, g) = (state.clone(), games.clone());
    state.tasks.spawn(async move {
        run_imports(&st, &g, &sources, limit).await;
    });
    Ok((StatusCode::ACCEPTED, Json(answer)).into_response())
}

/// `GET /admin/catalog/imports`.
async fn imports(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let pairs = super::routes::query_pairs(raw.as_deref());
    let get = |n: &str| pairs.iter().rev().find(|(k, v)| k == n && !v.is_empty()).map(|(_, v)| v.clone());
    let source = get("source");
    let limit = match get("limit") {
        None => 50,
        Some(v) => v
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=500).contains(n))
            .ok_or_else(|| ApiError::bad_request("limit must be 1-500"))?,
    };
    let cat = games.catalog.clone();
    let runs = state.db.read(move |c| cat.import_runs(c, source.as_deref(), limit).map_err(catalog_error)).await?;
    Ok(Json(json!({ "runs": runs })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OssFetchBody {
    slugs: Option<Vec<String>>,
}

/// Fetch `slugs` one at a time, then rescan, import `oss` and refresh. The caller holds `begin_fetching`.
pub async fn run_oss_fetch(state: &AppState, games: &Arc<Games>, slugs: &[String]) -> Vec<Value> {
    let mut out = Vec::new();
    let config = state.config.clone();
    for slug in slugs {
        if state.shutdown.is_cancelled() {
            break;
        }
        let Some(client) = games.oss_client() else {
            out.push(json!({ "slug": slug, "error": "no OSS client" }));
            continue;
        };
        match games.oss.fetch(&config.catalog, slug, client, &state.shutdown).await {
            Ok(r) => {
                tracing::info!(slug = %slug, files = r.files, "open-source game build installed");
                out.push(serde_json::to_value(r).unwrap_or_default());
            }
            Err(e) => {
                tracing::warn!(slug = %slug, error = %e, "open-source game build not installed");
                out.push(json!({ "slug": slug, "error": e }));
            }
        }
    }
    games.oss.end_fetching();
    let g = games.clone();
    let cfg = config.clone();
    let _ = tokio::task::spawn_blocking(move || g.oss.rescan(&cfg.catalog)).await;
    if config.catalog.sources.contains(&Source::Oss) && games.begin_import(Source::Oss) {
        run_imports(state, games, &[Source::Oss], None).await;
    }
    out
}

/// `POST /admin/catalog/oss-fetch`.
async fn oss_fetch(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    OptionalJson(body): OptionalJson<OssFetchBody>,
) -> Result<Response, ApiError> {
    games.ready()?;
    let catalog = &state.config.catalog;
    if !catalog.sources.contains(&Source::Oss) {
        return Err(field("slugs", "the oss source is not enabled"));
    }
    let slugs = match body.unwrap_or_default().slugs {
        None => games.oss.due(catalog),
        Some(list) => {
            for s in &list {
                if let Some(why) = super::oss::OssBuilds::fetch_refusal(catalog, s) {
                    return Err(field("slugs", format!("{s}: {why}")));
                }
            }
            list
        }
    };
    if !games.oss.begin_fetching() {
        return Err(ApiError::conflict("an open-source build fetch is already running"));
    }
    let answer = json!({ "job": OSS_FETCH_JOB, "slugs": slugs });
    let (st, g) = (state.clone(), games.clone());
    state.tasks.spawn(async move {
        run_oss_fetch(&st, &g, &slugs).await;
    });
    Ok((StatusCode::ACCEPTED, Json(answer)).into_response())
}

fn parse_id(id: &str) -> Result<i64, ApiError> {
    id.parse::<i64>().map_err(|_| ApiError::not_found())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FeatureBody {
    featured: bool,
}

/// `POST /admin/games/:id/feature`.
async fn feature(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<FeatureBody>,
) -> Result<StatusCode, ApiError> {
    games.ready()?;
    let id = parse_id(&id)?;
    let cat = games.catalog.clone();
    let now = games.now_ms();
    state.db.write(move |c| cat.set_featured(c, id, body.featured, now).map_err(catalog_error)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusBody {
    status: Option<String>,
}

/// `POST /admin/games/:id/status`.
async fn status(
    State(state): State<AppState>,
    Ext(games): Ext<Games>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<StatusBody>,
) -> Result<StatusCode, ApiError> {
    games.ready()?;
    let id = parse_id(&id)?;
    let status = match body.status.as_deref() {
        None => None,
        Some(s) => {
            Some(AdminStatus::parse(s).ok_or_else(|| field("status", "must be active, hidden, broken or null"))?)
        }
    };
    let cat = games.catalog.clone();
    state.db.write(move |c| cat.set_status(c, id, status).map_err(catalog_error)).await?;
    games.refresh(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}
