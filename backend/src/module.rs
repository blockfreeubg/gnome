//! Extension point for server features.
//!
//! A feature (core API, accounts/sync, and later the Wisp gateway, VPN profiles, filter lists, games catalog) is a
//! [`Module`]. [`builtin_modules`] builds the enabled modules once at startup; the server then mounts their routers,
//! starts their jobs and asks them to contribute to `/api/config`, `/api/health`, `/admin/diagnostics` and
//! `/admin/metrics`.
//!
//! **Module state.** State that only the module's own handlers need can live in the module struct (capture an `Arc`
//! in the handlers). State that other code needs too (handlers on several routers, jobs, other modules) is published
//! during construction with [`ModuleSetup::provide`] and read anywhere through [`AppState::ext`] or the [`Ext`]
//! extractor — `AppState` itself never needs a new field for a module.
//!
//! **Roles** (ARCHITECTURE §4.6, [`crate::origins`]). `public_routes` are served on the *app* role only,
//! `proxy_routes` on the *proxy* role only and `shared_routes` on **both** roles (e.g. `GET /api/health`, the
//! filter lists `GET /api/filters*`). In single-origin mode one origin serves all three (app and shared routes win
//! over a proxy route with the same path). The proxy origin is where hostile pages run: give it — and so
//! `shared_routes` — only read-only, unauthenticated routes, plus `/wisp/`.
//!
//! Routing rules:
//! * API endpoints live under `/api/` (the API middleware adds the baseline rate limit, `Cache-Control: no-store` and
//!   cookie refresh there). Use [`crate::security::rate_limit::enforce`] with a [`RateClass`] for stricter limits.
//! * Non-API prefixes must be reserved in [`crate::static_files::RESERVED_PREFIXES`] so the SPA fallback never
//!   shadows them (`/wisp/` already is).
//! * Never mount `/admin/*` publicly: admin endpoints go in `admin_routes` (separate listener).
//!
//! [`RateClass`]: crate::security::rate_limit::RateClass

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRequestParts;
use http::request::Parts;

pub use crate::api::meta::{
    EnginesInfo, Features, Health, ProxyInfo, PublicConfig, UpstreamStatus, WispInfo, WispProfile,
};
use crate::error::ApiError;
use crate::jobs::Job;
use crate::state::AppState;
use crate::util::BoxFuture;

/// JSON object returned by `GET /admin/diagnostics` (modules overwrite their keys, e.g. `"ws"`, `"catalog"`).
pub type Diagnostics = serde_json::Map<String, serde_json::Value>;

pub trait Module: Send + Sync + 'static {
    /// Stable identifier (logs, diagnostics).
    fn name(&self) -> &'static str;

    /// Routes of the app role (SPA origin): everything under `/api/` the app calls.
    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
    }

    /// Routes of the proxy role only (engine-host origin), e.g. `/wisp/*`.
    fn proxy_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
    }

    /// Routes mounted on **both** roles: read-only, unauthenticated endpoints the app and the engine host both use
    /// (`GET /api/health`, `GET /api/filters`, `GET /api/filters/{id}`). Never put a route that reads a session,
    /// sets a cookie or changes state here: on the proxy origin it would be reachable by proxied pages.
    fn shared_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
    }

    /// Routes for the admin listener (paths must start with `/admin/`; the bearer-token guard is applied for you).
    fn admin_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new()
    }

    /// Start-up work that must be done before the first request is answered (`server::serve_all` awaits every
    /// module's `prepare` in mount order before it starts the jobs and the accept loops). It never fails the start:
    /// a module reports problems in `diagnostics` and degrades (WAVE-C D21).
    fn prepare<'a>(&'a self, _state: &'a AppState) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    /// Periodic jobs to start with the server.
    fn jobs(&self, _state: &AppState) -> Vec<Job> {
        Vec::new()
    }

    /// Adjust `GET /api/config` (feature flags, Wisp profiles, proxy origin, …). Called per request; keep it cheap.
    fn public_config(&self, _state: &AppState, _config: &mut PublicConfig) {}

    /// Adjust `GET /api/health` (e.g. `wisp.direct` up/down). Called per request; keep it cheap.
    fn health(&self, _state: &AppState, _health: &mut Health) {}

    /// Fill keys of `GET /admin/diagnostics`.
    fn diagnostics<'a>(&'a self, _state: &'a AppState, _out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    /// Append Prometheus text (`# HELP`/`# TYPE` + samples) to `GET /admin/metrics`.
    fn metrics(&self, _state: &AppState, _out: &mut String) {}
}

/// Handed to module constructors while the server is being assembled.
pub struct ModuleSetup<'a> {
    /// Core services (config, database, secret key, limiter, …). Module state is not available yet.
    pub state: &'a AppState,
    extensions: http::Extensions,
}

impl<'a> ModuleSetup<'a> {
    pub(crate) fn new(state: &'a AppState) -> Self {
        Self { state, extensions: http::Extensions::new() }
    }

    /// Publish shared state for [`AppState::ext`] / [`Ext`]. Returns the shared handle so the module can keep a
    /// clone. One value per type.
    ///
    /// # Panics
    /// If a value of the same type was already provided (two modules must not fight over one slot).
    pub fn provide<T: Send + Sync + 'static>(&mut self, value: T) -> Arc<T> {
        let shared = Arc::new(value);
        let previous = self.extensions.insert(shared.clone());
        assert!(previous.is_none(), "module state {} was provided twice", std::any::type_name::<T>());
        shared
    }

    pub(crate) fn finish(self) -> http::Extensions {
        self.extensions
    }
}

/// Modules enabled for this configuration, in mount order.
pub fn builtin_modules(setup: &mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>> {
    builtin_modules_with(setup, crate::gateway::GatewayOptions::default())
}

/// [`builtin_modules`] with non-default gateway options (tests force the copy relay path with this).
pub fn builtin_modules_with(
    setup: &mut ModuleSetup<'_>,
    gateway: crate::gateway::GatewayOptions,
) -> Vec<Arc<dyn Module>> {
    builtin_modules_with_games(setup, gateway, crate::games::GamesOptions::default())
}

/// [`builtin_modules_with`] with the games module's options (tests pass fixture fetchers and a manual clock).
pub fn builtin_modules_with_games(
    setup: &mut ModuleSetup<'_>,
    gateway: crate::gateway::GatewayOptions,
    games_options: crate::games::GamesOptions,
) -> Vec<Arc<dyn Module>> {
    let mut modules: Vec<Arc<dyn Module>> = vec![Arc::new(crate::api::CoreApi)];
    if setup.state.config.accounts {
        modules.push(Arc::new(crate::api::Accounts));
    }
    modules.push(crate::gateway::install(setup, gateway));
    modules.push(crate::vpn::install(setup));
    modules.push(crate::filters::install(setup, crate::filters::FilterOptions::default()));
    if let Some(games) = crate::games::install(setup, games_options) {
        modules.push(games);
    }
    modules
}

/// Extractor for module state published with [`ModuleSetup::provide`]. A missing value is a wiring bug and answers
/// `500 internal`.
#[derive(Debug)]
pub struct Ext<T>(pub Arc<T>);

impl<T: Send + Sync + 'static> FromRequestParts<AppState> for Ext<T> {
    type Rejection = ApiError;

    async fn from_request_parts(_parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        state.ext::<T>().map(Self).ok_or_else(|| {
            ApiError::internal_from(format!("module state {} is not registered", std::any::type_name::<T>()))
        })
    }
}
