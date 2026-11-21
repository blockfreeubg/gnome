//! VPN gateway profiles (ARCHITECTURE §7): "browser-compatible VPN" = Wisp connections whose egress leaves through
//! an operator-configured VPN tunnel. Each profile in `GNOME_VPN_PROFILES` ([`profiles`]) is a separate HolyWisp
//! instance reached at `/wisp/p/<id>/` (the gateway routes it, `crate::gateway`); this module publishes the list in
//! `/api/config` (`wisp.profiles`, `features.vpn_gateway`) and `GET /api/vpn/locations` with the status of each
//! profile's last health probe. Only traffic loaded inside GNOME is routed; nothing here touches the user's device.

pub mod profiles;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::api::meta::{PublicConfig, UpstreamStatus, WispProfile};
use crate::gateway::Gateway;
use crate::module::{Ext, Module};
use crate::state::AppState;

/// Exit check the VPN page loads *through the proxy path* to show the verified exit (API.md).
pub const VERIFY_URL: &str = "https://am.i.mullvad.net/json";

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
}

#[derive(Debug, Clone, Serialize)]
pub struct Locations {
    pub profiles: Vec<Location>,
    pub verify_url: &'static str,
}

/// `GET /api/vpn/locations`.
pub async fn locations(State(state): State<AppState>, Ext(gw): Ext<Gateway>) -> Json<Locations> {
    let profiles = state
        .config
        .profiles
        .iter()
        .map(|p| {
            let (status, checked_at) = gw.upstreams.get(&p.id).map_or((UpstreamStatus::Unknown, None), |u| u.status());
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
            }
        })
        .collect();
    Json(Locations { profiles, verify_url: VERIFY_URL })
}

/// The VPN gateway module.
pub struct Vpn;

impl Module for Vpn {
    fn name(&self) -> &'static str {
        "vpn"
    }

    fn public_routes(&self, _state: &AppState) -> Router<AppState> {
        Router::new().route("/api/vpn/locations", get(locations))
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
}
