//! `/api/*` handlers, grouped into the core modules.

pub mod auth;
pub mod meta;
pub mod session;
pub mod sync;
pub mod validate;

use std::time::{Duration, Instant};

use axum::Router;
use axum::routing::{delete, get, post};

use crate::db::DbError;
use crate::jobs::Job;
use crate::module::Module;
use crate::state::AppState;
use crate::util::now_ms;

/// Health, config, sessions and core maintenance jobs.
pub struct CoreApi;

impl Module for CoreApi {
    fn name(&self) -> &'static str {
        "core"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
            .route("/api/config", get(meta::config))
            .route("/api/session", get(session::get_session).post(session::create_session))
    }

    /// Health is served on both origins (the engine host checks it on its own); nothing else of the core API is on
    /// the proxy origin.
    fn shared_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/api/health", get(meta::health))
    }

    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![
            Job::new("sessions.cleanup", Duration::from_secs(60 * 60), |state| async move {
                let now = now_ms();
                let removed = state
                    .db
                    .write(move |c| crate::auth::sessions::cleanup_expired(c, now).map_err(DbError::from))
                    .await?;
                if removed > 0 {
                    tracing::info!(removed, "removed expired user sessions");
                }
                Ok(())
            })
            .first_run_after(Duration::from_secs(30)),
            Job::new("ratelimit.evict", Duration::from_secs(60), |state| async move {
                let now = Instant::now();
                let buckets = state.limiter.evict(now);
                let backoffs = state.backoff.evict(now);
                tracing::debug!(buckets, backoffs, "evicted idle rate-limit state");
                Ok(())
            }),
            Job::new("db.optimize", Duration::from_secs(6 * 60 * 60), |state| async move {
                state.db.write(|c| c.execute_batch("PRAGMA optimize;").map_err(DbError::from)).await?;
                Ok(())
            }),
        ]
    }
}

/// Accounts (`/api/auth/*`) and sync (`/api/sync/*`); mounted only when `GNOME_ACCOUNTS=true`.
pub struct Accounts;

impl Module for Accounts {
    fn name(&self) -> &'static str {
        "accounts"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
            .route("/api/auth/register", post(auth::register))
            .route("/api/auth/login", post(auth::login))
            .route("/api/auth/logout", post(auth::logout))
            .route("/api/auth/password", post(auth::change_password))
            .route("/api/auth/me", get(auth::me))
            .route("/api/auth/account", delete(auth::delete_account))
            .merge(sync::routes())
    }

    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        vec![
            Job::new("sync.purge_tombstones", Duration::from_secs(24 * 60 * 60), |state| async move {
                let cutoff = now_ms() - sync::bookmarks::TOMBSTONE_RETENTION_MS;
                let removed = state
                    .db
                    .write(move |c| sync::bookmarks::purge_tombstones(c, cutoff).map_err(DbError::from))
                    .await?;
                if removed > 0 {
                    tracing::info!(removed, "purged old bookmark tombstones");
                }
                Ok(())
            })
            .first_run_after(Duration::from_secs(5 * 60)),
        ]
    }
}
