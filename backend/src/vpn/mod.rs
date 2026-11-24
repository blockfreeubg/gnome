//! VPN gateway profiles (ARCHITECTURE §7): "browser-compatible VPN" = Wisp connections whose egress leaves through
//! an operator-configured VPN tunnel. Each profile in `GNOME_VPN_PROFILES` ([`profiles`]) is a separate HolyWisp
//! instance reached at `/wisp/p/<id>/` (the gateway routes it, `crate::gateway`); this module publishes the list in
//! `/api/config` (`wisp.profiles`, `features.vpn_gateway`) and `GET /api/vpn/locations` with the status of each
//! profile's last health probe and, when the operator set a check service (`GNOME_VPN_CHECK_URL`, WAVE-C D15), the
//! server's own exit check through that location ([`exit`]). Only traffic loaded inside GNOME is routed; nothing here
//! touches the user's device, and exit checks never change the route choice (D14).

pub mod exit;
pub mod profiles;
pub mod wisp_client;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use crate::api::meta::{PublicConfig, UpstreamStatus, WispProfile};
use crate::auth::extract::{resolve_anon, resolve_user};
use crate::config::AccessMode;
use crate::error::ApiError;
use crate::gateway::Gateway;
use crate::jobs::Job;
use crate::module::{Diagnostics, Ext, Module, ModuleSetup};
use crate::security::ClientInfo;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;
use crate::util::{BoxError, BoxFuture};
use exit::{ExitChecker, ExitResult, ExitState};

/// The exit-check job.
pub const EXIT_CHECK_JOB: &str = "vpn.exit-check";
const TICK: Duration = Duration::from_secs(60);
/// Checks of different locations running at once.
const PARALLEL: usize = 2;

/// One entry of `GET /api/vpn/locations`.
#[derive(Debug, Clone, Serialize)]
pub struct Location {
    pub id: String,
    pub label: String,
    pub country_code: String,
    pub country: String,
    pub city: String,
    pub provider_note: String,
    pub path: String,
    pub status: UpstreamStatus,
    /// Unix ms of the last probe, `null` before the first one.
    pub checked_at: Option<i64>,
    /// The server's exit check (`off` without a check service; `unchecked` with every other field `null` for
    /// clients the access policy does not admit).
    pub exit: ExitResult,
}

#[derive(Debug, Clone, Serialize)]
pub struct Locations {
    pub profiles: Vec<Location>,
    /// `GNOME_VPN_CHECK_URL` (also the browser's own check, ENGINE-PROTOCOL §6.13), `null` when unset.
    pub verify_url: Option<String>,
    /// Its `host[:port]` (port only when not the scheme's default).
    pub check_service: Option<String>,
}

/// Whether this client may use the proxy (the policy behind `POST /api/session` and ticket minting; never issues a
/// cookie): anyone in `open` mode, a valid anonymous session in `code` mode, a signed-in user in `accounts` mode.
pub async fn admitted(state: &AppState, headers: &HeaderMap, client: &ClientInfo) -> Result<bool, ApiError> {
    Ok(match state.config.access_mode {
        AccessMode::Open => true,
        AccessMode::Code => resolve_anon(state, headers, client).is_some(),
        AccessMode::Accounts => resolve_user(state, headers, client, None).await?.is_some(),
    })
}

/// `GET /api/vpn/locations`.
pub async fn locations(
    State(state): State<AppState>,
    Ext(gw): Ext<Gateway>,
    headers: HeaderMap,
    client: ClientInfo,
) -> Result<Json<Locations>, ApiError> {
    let checker = state.ext::<ExitChecker>();
    let show = checker.is_some() && admitted(&state, &headers, &client).await?;
    let profiles = state
        .config
        .profiles
        .iter()
        .map(|p| {
            let (status, checked_at) = gw.upstreams.get(&p.id).map_or((UpstreamStatus::Unknown, None), |u| u.status());
            let exit = match &checker {
                None => ExitResult::empty(ExitState::Off),
                Some(c) if show => c.result(&p.id),
                Some(_) => ExitResult::empty(ExitState::Unchecked),
            };
            Location {
                id: p.id.clone(),
                label: p.label.clone(),
                country_code: p.country_code.clone(),
                country: p.country.clone(),
                city: p.city.clone(),
                provider_note: p.provider_note.clone(),
                path: p.path(),
                status,
                checked_at,
                exit,
            }
        })
        .collect();
    let verify_url = state.config.vpn_check_url.clone();
    let check_service = verify_url.as_deref().and_then(exit::service_host);
    Ok(Json(Locations { profiles, verify_url, check_service }))
}

#[derive(Debug, Serialize)]
pub struct CheckAnswer {
    pub exit: ExitResult,
}

/// `POST /api/vpn/locations/:id/check` (only with a check service; CSRF rules; `vpn_check` class).
pub async fn check(
    State(state): State<AppState>,
    Ext(checker): Ext<ExitChecker>,
    Path(id): Path<String>,
    headers: HeaderMap,
    client: ClientInfo,
) -> Result<Json<CheckAnswer>, ApiError> {
    if !admitted(&state, &headers, &client).await? {
        return Err(match state.config.access_mode {
            AccessMode::Accounts => ApiError::login_required(),
            _ => ApiError::access_code_required("an access code is required: POST /api/session first"),
        });
    }
    let profile = state.config.profiles.iter().find(|p| p.id == id).ok_or_else(ApiError::not_found)?;
    if let Some(recent) = checker.recent(&profile.id) {
        return Ok(Json(CheckAnswer { exit: recent }));
    }
    enforce(&state, RateClass::VpnCheck, client.ip, None)?;
    let exit = checker.check(&state, profile).await;
    Ok(Json(CheckAnswer { exit }))
}

/// The exit-check schedule: when each location's next check is due.
#[derive(Debug, Default)]
struct Schedule {
    due: Mutex<HashMap<String, Instant>>,
}

/// The VPN module.
pub struct Vpn {
    checker: Option<Arc<ExitChecker>>,
    schedule: Arc<Schedule>,
}

/// The VPN module's constructor (`module::builtin_modules_with`): publishes the exit checker when the operator set
/// a check service and there are locations.
pub fn install(setup: &mut ModuleSetup<'_>) -> Arc<dyn Module> {
    let checker = ExitChecker::new(&setup.state.config).map(|c| setup.provide(c));
    Arc::new(Vpn { checker, schedule: Arc::new(Schedule::default()) })
}

/// [`install`] with another TLS root store for the checker (tests: a test CA).
pub fn install_with_roots(setup: &mut ModuleSetup<'_>, roots: rustls::RootCertStore) -> Arc<dyn Module> {
    let checker = ExitChecker::with_roots(&setup.state.config, roots).map(|c| setup.provide(c));
    Arc::new(Vpn { checker, schedule: Arc::new(Schedule::default()) })
}

async fn tick(state: AppState, checker: Arc<ExitChecker>, schedule: Arc<Schedule>) -> Result<(), BoxError> {
    let interval = Duration::from_secs(u64::from(state.config.vpn_check_interval_min) * 60);
    let now = Instant::now();
    let due: Vec<_> = {
        let mut map = schedule.due.lock().unwrap_or_else(|e| e.into_inner());
        let mut due = Vec::new();
        for p in &state.config.profiles {
            let at = *map.entry(p.id.clone()).or_insert_with(|| now + exit::first_delay(interval, exit::random_unit()));
            if at <= now {
                due.push(p.clone());
            }
        }
        due
    };
    for chunk in due.chunks(PARALLEL) {
        if state.shutdown.is_cancelled() {
            break;
        }
        let runs = chunk.iter().map(|p| checker.check(&state, p));
        futures_util::future::join_all(runs).await;
        let mut map = schedule.due.lock().unwrap_or_else(|e| e.into_inner());
        for p in chunk {
            map.insert(p.id.clone(), Instant::now() + exit::next_delay(interval, exit::random_unit()));
        }
    }
    Ok(())
}

impl Module for Vpn {
    fn name(&self) -> &'static str {
        "vpn"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        let r = Router::new().route("/api/vpn/locations", get(locations));
        if self.checker.is_some() { r.route("/api/vpn/locations/{id}/check", post(check)) } else { r }
    }

    fn jobs(&self, state: &AppState) -> Vec<Job> {
        let Some(checker) = self.checker.clone() else { return Vec::new() };
        if state.config.vpn_check_interval_min == 0 {
            return Vec::new();
        }
        let schedule = self.schedule.clone();
        vec![
            Job::new(EXIT_CHECK_JOB, TICK, move |state| tick(state, checker.clone(), schedule.clone()))
                .first_run_after(Duration::ZERO),
        ]
    }

    fn public_config(&self, state: &AppState, config: &mut PublicConfig) {
        let profiles = &state.config.profiles;
        config.features.vpn_gateway = !profiles.is_empty();
        config.wisp.profiles = profiles
            .iter()
            .map(|p| WispProfile {
                id: p.id.clone(),
                label: p.label.clone(),
                country_code: p.country_code.clone(),
                city: p.city.clone(),
                path: p.path(),
            })
            .collect();
    }

    fn diagnostics<'a>(&'a self, state: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let value = match &self.checker {
                Some(c) => c.diagnostics(state.config.vpn_check_interval_min),
                None => serde_json::json!({
                    "check_service": null,
                    "interval_min": state.config.vpn_check_interval_min,
                    "exits": {},
                }),
            };
            out.insert("vpn".into(), value);
        })
    }

    fn metrics(&self, _state: &AppState, out: &mut String) {
        if let Some(c) = &self.checker {
            c.metrics(out);
        }
    }
}
