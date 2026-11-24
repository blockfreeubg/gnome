//! The games module's jobs (WAVE-C §4.6): `catalog.import`, `catalog.rankings`, `catalog.policy`,
//! `catalog.oss-fetch`.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use gnome_catalog::{CatalogError, Source};

use super::{Games, IMPORT_JOB, OSS_FETCH_JOB, POLICY_JOB, RANKINGS_JOB, admin, catalog_error};
use crate::config::OssFetch;
use crate::error::ApiError;
use crate::jobs::Job;
use crate::state::AppState;
use crate::util::BoxError;

const IMPORT_TICK: Duration = Duration::from_secs(600);
const HOUR_MS: i64 = 3_600_000;

fn games(state: &AppState) -> Result<Arc<Games>, BoxError> {
    state.ext::<Games>().ok_or_else(|| "games module state missing".into())
}

pub fn jobs(state: &AppState) -> Vec<Job> {
    let mut jobs = vec![
        Job::new(IMPORT_JOB, IMPORT_TICK, |state| async move { import_tick(&state).await })
            .first_run_after(Duration::from_secs(30)),
        Job::new(RANKINGS_JOB, Duration::from_secs(3600), |state| async move {
            let g = games(&state)?;
            g.ready().map_err(|e| e.message.to_string())?;
            let (cat, now) = (g.catalog.clone(), g.now_ms());
            gnome_catalog::WriteDb::write(&state.db, move |c| cat.refresh_rankings(c, now))
                .await
                .map_err(|e: CatalogError| e.to_string())?;
            Ok(())
        })
        .first_run_after(Duration::from_secs(60)),
        Job::new(POLICY_JOB, Duration::from_secs(300), |state| async move { policy(&state).await }),
    ];
    let c = &state.config;
    if c.oss_fetch == OssFetch::Auto && c.catalog.sources.contains(&Source::Oss) {
        jobs.push(
            Job::new(OSS_FETCH_JOB, Duration::from_secs(86_400), |state| async move {
                let g = games(&state)?;
                g.ready().map_err(|e| e.message.to_string())?;
                let due = g.oss.due(&state.config.catalog);
                if due.is_empty() || !g.oss.begin_fetching() {
                    return Ok(());
                }
                admin::run_oss_fetch(&state, &g, &due).await;
                Ok(())
            })
            .first_run_after(Duration::from_secs(20)),
        );
    }
    jobs
}

/// Whether an HTTP source is due: its last finished run is older than the interval or it never finished one; after
/// `n` failed runs in a row it retries after `min(1 h × 2^(n−1), interval)`.
pub fn is_due(runs: &[gnome_catalog::ImportRun], now_ms: i64, interval_ms: i64) -> bool {
    let finished: Vec<&gnome_catalog::ImportRun> =
        runs.iter().filter(|r| r.finished_at.is_some() && r.status != "running").collect();
    let Some(last) = finished.first() else { return true };
    let at = last.finished_at.unwrap_or(0);
    let failures = finished.iter().take_while(|r| r.status == "failed").count() as u32;
    let wait = if failures > 0 {
        (HOUR_MS.saturating_mul(1i64 << (failures - 1).min(30))).min(interval_ms)
    } else {
        interval_ms
    };
    now_ms - at >= wait
}

async fn import_tick(state: &AppState) -> Result<(), BoxError> {
    let g = games(state)?;
    g.ready().map_err(|e| e.message.to_string())?;
    let config = state.config.clone();
    let hours = i64::from(config.catalog_refresh_hours);
    let now = g.now_ms();
    let mut due: Vec<Source> = Vec::new();
    // Open-source games: no network involved, so also with GNOME_CATALOG_REFRESH_HOURS=0.
    if config.catalog.sources.contains(&Source::Oss) {
        let gg = g.clone();
        let cfg = config.clone();
        let scan = tokio::task::spawn_blocking(move || gg.oss.rescan(&cfg.catalog)).await?;
        let cat = g.catalog.clone();
        let completed = state
            .db
            .read(move |c| -> Result<bool, ApiError> {
                Ok(cat.import_runs(c, Some("oss"), 50).map_err(catalog_error)?.iter().any(|r| r.complete))
            })
            .await
            .unwrap_or(false);
        if scan.as_ref().is_ok_and(|s| s.changed) || !completed {
            due.push(Source::Oss);
        }
    }
    if hours > 0 {
        for s in config.catalog.sources.iter().copied().filter(|s| *s != Source::Oss) {
            let cat = g.catalog.clone();
            let runs = state
                .db
                .read(move |c| cat.import_runs(c, Some(s.id()), 30).map_err(catalog_error))
                .await
                .unwrap_or_default();
            if is_due(&runs, now, hours * HOUR_MS) {
                due.push(s);
            }
        }
    }
    let due: Vec<Source> = due.into_iter().filter(|s| g.begin_import(*s)).collect();
    if due.is_empty() {
        return Ok(());
    }
    admin::run_imports(state, &g, &due, None).await;
    let _ = state.db.write(|c| c.execute_batch("PRAGMA optimize").map_err(crate::db::DbError::from)).await;
    Ok(())
}

async fn policy(state: &AppState) -> Result<(), BoxError> {
    let g = games(state)?;
    g.ready().map_err(|e| e.message.to_string())?;
    g.refresh(state).await.map_err(|e| e.message.to_string())?;
    let cat = g.catalog.clone();
    let keep = state
        .db
        .read(move |c| -> Result<HashSet<String>, ApiError> {
            let mut stmt = c.prepare(
                "SELECT source, thumbnail_url FROM games
                 WHERE status = 'active' AND source_enabled = 1 AND thumbnail_url IS NOT NULL",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut keep = HashSet::new();
            for row in rows {
                let (source, url) = row?;
                if let Some(s) = Source::from_id(&source)
                    && let Ok(u) = cat.thumb_policy().check(s, &url)
                {
                    keep.insert(u);
                }
            }
            Ok(keep)
        })
        .await
        .map_err(|e| e.message.to_string())?;
    let removed = g.thumbs.retain_urls(&keep);
    if removed > 0 {
        tracing::info!(removed, "thumbnails of games no longer listed were deleted");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(status: &str, finished_at: i64) -> gnome_catalog::ImportRun {
        gnome_catalog::ImportRun { status: status.into(), finished_at: Some(finished_at), ..blank() }
    }

    fn blank() -> gnome_catalog::ImportRun {
        gnome_catalog::ImportRun {
            id: 1,
            source: "gamepix".into(),
            started_at: 0,
            finished_at: None,
            status: String::new(),
            complete: false,
            limited: false,
            pages: 0,
            not_modified: 0,
            requests: 0,
            retries: 0,
            seen: 0,
            inserted: 0,
            updated: 0,
            unchanged: 0,
            rejected: 0,
            hidden: 0,
            reported_total: None,
            error: None,
            note: None,
        }
    }

    #[test]
    fn due_rules() {
        let day = 24 * HOUR_MS;
        assert!(is_due(&[], 0, day));
        let ok = run("complete", 0);
        assert!(!is_due(std::slice::from_ref(&ok), day - 1, day));
        assert!(is_due(std::slice::from_ref(&ok), day, day));
        let f1 = run("failed", 0);
        assert!(!is_due(std::slice::from_ref(&f1), HOUR_MS - 1, day));
        assert!(is_due(std::slice::from_ref(&f1), HOUR_MS, day));
        let f3 = [run("failed", 0), run("failed", -1), run("failed", -2), ok];
        assert!(!is_due(&f3, 4 * HOUR_MS - 1, day));
        assert!(is_due(&f3, 4 * HOUR_MS, day));
        let many: Vec<_> = (0..10).map(|i| run("failed", -i)).collect();
        assert!(is_due(&many, day, day), "capped at the interval");
    }
}
