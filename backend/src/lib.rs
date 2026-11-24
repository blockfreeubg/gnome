//! `gnome-server` — the GNOME backend: static SPA serving on the app and proxy origins, the `/api/*` REST API
//! (sessions, accounts, sync, Wisp tickets, VPN locations, filter lists), the `/wisp/` gateway to HolyWisp, the admin
//! listener, background jobs and the CLI.
//!
//! Everything except the binary entry point lives in this library so the integration tests (`backend/tests/`) can
//! drive the real routers with `tower::ServiceExt::oneshot`.
//!
//! Module map and extension points are documented in `backend/README.md`.
#![forbid(unsafe_code)]

pub mod admin;
pub mod api;
pub mod auth;
pub mod cli;
pub mod config;
pub mod db;
pub mod error;
pub mod filters;
pub mod games;
pub mod gateway;
pub mod jobs;
pub mod metrics;
pub mod module;
pub mod observability;
pub mod origins;
pub mod router;
pub mod security;
pub mod server;
pub mod state;
pub mod static_files;
pub mod util;
pub mod vpn;

pub use error::ApiError;
pub use state::AppState;

/// Crate version reported by `/api/health`, `/api/config`, diagnostics and `gnome-server version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
