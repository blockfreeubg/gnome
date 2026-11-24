//! `GET /api/health` and `GET /api/config`.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use http::StatusCode;
use serde::Serialize;

use crate::VERSION;
use crate::gateway::health::DIRECT;
use crate::origins::{self, Role};
use crate::security::ClientInfo;
use crate::state::AppState;

/// Runtime configuration for the SPA (API.md). Modules adjust it in `Module::public_config`.
#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig {
    pub version: &'static str,
    pub access_mode: &'static str,
    pub registration: &'static str,
    pub features: Features,
    pub wisp: WispInfo,
    pub engines: EnginesInfo,
    pub proxy: ProxyInfo,
    pub source_url: Option<String>,
    pub limits: Limits,
}

/// Where proxied content runs (ARCHITECTURE §4.6).
#[derive(Debug, Clone, Serialize)]
pub struct ProxyInfo {
    /// Origin the app embeds the engine host from and connects Wisp to: `GNOME_PROXY_ORIGIN` (or the derived
    /// `http://<GNOME_PROXY_BIND>`). In single-origin mode the app origin the request was addressed to, or the first
    /// `GNOME_PUBLIC_ORIGINS` entry when that origin is not on the allow-list (`null` if it cannot be determined,
    /// e.g. no `Host` header and no allow-list).
    pub origin: Option<String>,
    /// Whether proxied pages are isolated on their own origin. `false` = single-origin mode.
    pub isolated: bool,
    /// Which foreign cookies the app removes in two-origin mode: `"app"` or `"registrable"` (`GNOME_COOKIE_HYGIENE`,
    /// WAVE-D D19 (3)).
    #[serde(rename = "cookieHygiene")]
    pub cookie_hygiene: &'static str,
}

/// What `/admin/diagnostics`, `config check` and the startup log say about proxy isolation in single-origin mode.
pub const SINGLE_ORIGIN_EXPLANATION: &str = "single-origin mode: proxied pages run on the app origin, so a hostile \
     page could read GNOME's local data and call its API as the signed-in user";

#[derive(Debug, Clone, Serialize)]
pub struct Features {
    pub accounts: bool,
    pub sync: bool,
    /// Set by the games module.
    pub games: bool,
    /// Set by the VPN gateway module when profiles are configured.
    pub vpn_gateway: bool,
    /// Set by the games module when `GNOME_THUMB_PROXY` is on.
    pub thumb_proxy: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WispInfo {
    pub path: String,
    /// Upper bound of a ticket's lifetime (`GNOME_WISP_TICKET_TTL_S`; tickets end with their session if earlier).
    pub ticket_ttl_s: u32,
    /// Filled by the VPN gateway module.
    pub profiles: Vec<WispProfile>,
    /// `GNOME_ALLOW_CUSTOM_WISP`: users may connect to Wisp servers of their own (the engine-host and bare-mux worker
    /// policies allow `ws: wss:`). Off: the app never sends a `custom` route.
    pub custom_servers: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WispProfile {
    pub id: String,
    pub label: String,
    pub country_code: String,
    pub city: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnginesInfo {
    pub default: &'static str,
    pub scramjet: bool,
    pub ultraviolet: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Limits {
    pub max_ws_per_session: u32,
}

/// Upstream state as reported by health checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpstreamStatus {
    Up,
    Down,
    Unknown,
}

/// `GET /api/health` body. Modules adjust it in `Module::health`.
#[derive(Debug, Clone, Serialize)]
pub struct Health {
    /// `ok`, or `degraded` when a core dependency (the database) fails (HTTP 503).
    pub status: &'static str,
    pub version: &'static str,
    pub uptime_s: u64,
    /// `ok` | `error`.
    pub db: &'static str,
    /// Wisp upstreams by id (`direct` = primary HolyWisp); the gateway module reports `up`/`down`.
    pub wisp: BTreeMap<String, UpstreamStatus>,
}

/// `GET /api/health` as the **proxy origin** answers it in two-origin mode. Every proxied page runs on that origin and
/// can read it, so it carries only what the engine host needs for its own check — the overall status and the primary
/// Wisp upstream — and nothing that fingerprints the server (`version`, `uptime_s`) or lists the operator's VPN
/// locations (docs/research/spike-engine-host.md §11.2.2, B9). The app origin keeps the full [`Health`]; the app relays
/// VPN location status to the engine host itself (`GET /api/vpn/locations`).
#[derive(Debug, Clone, Serialize)]
pub struct ProxyHealth {
    pub status: &'static str,
    /// Only `direct`.
    pub wisp: BTreeMap<String, UpstreamStatus>,
}

impl From<Health> for ProxyHealth {
    fn from(h: Health) -> Self {
        Self { status: h.status, wisp: h.wisp.into_iter().filter(|(id, _)| id == DIRECT).collect() }
    }
}

/// Build the public config for a request (config values + module contributions).
pub fn public_config(state: &AppState, client: &ClientInfo) -> PublicConfig {
    let c = &state.config;
    let mut cfg = PublicConfig {
        version: VERSION,
        access_mode: c.access_mode.as_str(),
        registration: if c.registration_open() { "open" } else { "closed" },
        features: Features {
            accounts: c.accounts,
            sync: c.accounts,
            games: false,
            vpn_gateway: false,
            thumb_proxy: false,
        },
        wisp: WispInfo {
            path: "/wisp/".into(),
            ticket_ttl_s: c.wisp_ticket_ttl_s,
            profiles: Vec::new(),
            custom_servers: c.allow_custom_wisp,
        },
        engines: EnginesInfo {
            default: c.engines.default.as_str(),
            scramjet: c.engines.scramjet,
            ultraviolet: c.engines.ultraviolet,
        },
        proxy: ProxyInfo {
            origin: origins::proxy_origin(c, client),
            isolated: c.proxy.isolated(),
            cookie_hygiene: c.cookie_hygiene.as_str(),
        },
        source_url: c.source_url.clone(),
        limits: Limits { max_ws_per_session: c.max_ws_per_session },
    };
    for m in state.modules() {
        m.public_config(state, &mut cfg);
    }
    cfg
}

pub async fn config(State(state): State<AppState>, client: ClientInfo) -> Json<PublicConfig> {
    Json(public_config(&state, &client))
}

/// Full [`Health`] on the app (and single-origin) role, [`ProxyHealth`] on the proxy role.
pub async fn health(State(state): State<AppState>, role: Option<Extension<Role>>) -> Response {
    let db_ok = state
        .db
        .read(|c| c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0)).map_err(crate::db::DbError::from))
        .await
        .is_ok();
    let mut h = Health {
        status: if db_ok { "ok" } else { "degraded" },
        version: VERSION,
        uptime_s: state.uptime_s(),
        db: if db_ok { "ok" } else { "error" },
        wisp: BTreeMap::from([(DIRECT.to_string(), UpstreamStatus::Unknown)]),
    };
    for m in state.modules() {
        m.health(&state, &mut h);
    }
    let status = if h.status == "ok" { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    if role.is_some_and(|Extension(r)| r == Role::Proxy) {
        return (status, Json(ProxyHealth::from(h))).into_response();
    }
    (status, Json(h)).into_response()
}
