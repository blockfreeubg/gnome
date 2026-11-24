//! `gnome-server catalog …` (WAVE-C §4.6): the same `GNOME_*` configuration and data directory as the server, safe
//! while it runs (SQLite WAL; the crate's run lock refuses a second concurrent run of one source).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Subcommand;
use gnome_catalog::{CatalogError, ImportOptions, Source};

use super::{Games, GamesOptions};
use crate::config::Config;
use crate::observability::init_tracing;
use crate::state::AppState;

#[derive(Debug, Subcommand)]
pub enum CatalogCommand {
    /// Import game feeds now (default: every enabled source). Prints one JSON report per run; exit code 1 when a run
    /// failed or was busy, 2 for an unknown or disabled source or a bad --replay index.
    Import {
        /// Only this source (repeatable).
        #[arg(long = "source")]
        sources: Vec<String>,
        /// Stop after this many games (a limited run is never complete).
        #[arg(long)]
        limit: Option<usize>,
        /// Answer the importers' requests from captured responses (development and tests; never contacts a host).
        #[arg(long)]
        replay: Option<PathBuf>,
    },
    /// Print the catalog statistics as JSON.
    Stats,
    /// Fetch the pinned builds of open-source games (default: every enabled entry whose build is missing or at
    /// another commit). Prints one JSON line per entry; exit code 1 if one failed.
    FetchOss {
        /// Only this entry (repeatable).
        #[arg(long = "slug")]
        slugs: Vec<String>,
    },
}

fn usage(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("error: {msg}");
    ExitCode::from(2)
}

fn failure(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("error: {msg}");
    ExitCode::from(1)
}

/// Run one `catalog` command.
pub fn run(cmd: CatalogCommand) -> ExitCode {
    let mut config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => return usage(e.to_string().trim_end()),
    };
    init_tracing(&config);
    if config.catalog.sources.is_empty() {
        return usage("the game catalog is disabled (GNOME_CATALOG_SOURCES)");
    }
    let mut options = GamesOptions::default();
    if let CatalogCommand::Import { sources, replay, .. } = &cmd {
        for id in sources {
            match Source::from_id(id) {
                None => return usage(format!("unknown source {id:?}")),
                Some(s) if !config.catalog.sources.contains(&s) => {
                    return usage(format!("source {id} is not enabled"));
                }
                Some(_) => {}
            }
        }
        if let Some(path) = replay {
            let replay = match super::replay::Replay::load(path) {
                Ok(r) => r,
                Err(e) => return usage(e),
            };
            config.catalog = replay.apply(&config.catalog);
            options.fetcher = Some(Arc::new(replay.fetcher));
            options.clock = Some(Arc::new(replay.clock));
        }
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return failure(e),
    };
    rt.block_on(async move {
        let modules = move |s: &mut crate::module::ModuleSetup<'_>| {
            crate::module::builtin_modules_with_games(s, crate::gateway::GatewayOptions::default(), options)
        };
        let state = match AppState::open_with(config, modules).await {
            Ok(s) => s,
            Err(e) => return failure(e),
        };
        state.prepare_modules().await;
        let Some(games) = state.ext::<Games>() else { return usage("the game catalog is disabled") };
        if let Some(e) = games.prepare_error() {
            return failure(format!("the game catalog is unavailable: {e}"));
        }
        let code = match cmd {
            CatalogCommand::Import { sources, limit, .. } => import(&state, &games, &sources, limit).await,
            CatalogCommand::Stats => {
                let cat = games.catalog.clone();
                match state.db.read(move |c| cat.stats(c).map_err(super::catalog_error)).await {
                    Ok(stats) => {
                        println!("{}", serde_json::to_string_pretty(&stats).unwrap_or_default());
                        ExitCode::SUCCESS
                    }
                    Err(e) => failure(e.message),
                }
            }
            CatalogCommand::FetchOss { slugs } => fetch_oss(&state, &games, slugs).await,
        };
        state.shutdown.cancel();
        state.tasks.close();
        state.tasks.wait().await;
        code
    })
}

async fn import(state: &AppState, games: &Arc<Games>, ids: &[String], limit: Option<usize>) -> ExitCode {
    let sources: Vec<Source> = if ids.is_empty() {
        state.config.catalog.sources.clone()
    } else {
        ids.iter().filter_map(|id| Source::from_id(id)).collect()
    };
    let mut ok = true;
    for source in sources {
        let fetcher = match games.fetcher() {
            Ok(f) => f,
            Err(e) => return failure(e),
        };
        let opts = ImportOptions { limit, max_pages: None };
        match games.catalog.import(fetcher, games.clock(), &state.db, source, opts).await {
            Ok(report) => {
                ok &= report.status != "failed";
                println!("{}", serde_json::to_string(&report).unwrap_or_default());
            }
            Err(CatalogError::Busy(s)) => {
                ok = false;
                eprintln!("error: an import of {} is already running", s.id());
            }
            Err(e) => {
                ok = false;
                eprintln!("error: {}: {e}", source.id());
            }
        }
    }
    if ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
}

async fn fetch_oss(state: &AppState, games: &Arc<Games>, slugs: Vec<String>) -> ExitCode {
    let catalog = &state.config.catalog;
    if !catalog.sources.contains(&Source::Oss) {
        return usage("the oss source is not enabled (it needs a separate proxy origin)");
    }
    for s in &slugs {
        if let Some(why) = super::oss::OssBuilds::fetch_refusal(catalog, s) {
            return usage(format!("{s}: {why}"));
        }
    }
    let slugs = if slugs.is_empty() { games.oss.due(catalog) } else { slugs };
    if !games.oss.begin_fetching() {
        return failure("a fetch is already running");
    }
    let results = super::admin::run_oss_fetch(state, games, &slugs).await;
    let mut ok = true;
    for r in results {
        ok &= r.get("error").is_none();
        println!("{r}");
    }
    if ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
}
