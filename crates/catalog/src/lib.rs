//! gnome-catalog — GNOME's game catalog: schema, legitimate-source importers, normalization, search and ranking.
//!
//! The crate is a library used by `gnome-server`; it never opens sockets itself (see [`fetch`]).
//!
//! * **Schema**: [`MIGRATIONS`] (versions 100..199: `database/migrations/0100_catalog.sql` and
//!   `crates/catalog/migrations/0101_catalog_search_index.sql`), applied by the server's migration runner together
//!   with the core migrations.
//! * **Configuration**: [`CatalogConfig::from_env`] (`GNOME_CATALOG_SOURCES`, `GNOME_GAMEPIX_SID`, ...). Sources
//!   that need an operator publisher/affiliate ID stay disabled until it is configured.
//! * **Handle**: [`Catalog`] bundles the configuration, the cursor-signing key and render options. Read methods
//!   take `&rusqlite::Connection` (run them on the read pool); write methods take `&mut Connection` (writer).
//! * **Imports**: [`Catalog::import`] streams one source page by page through a [`Fetcher`] (the server's
//!   SSRF-safe client), a [`Clock`] and a [`WriteDb`] (the server's writer).
//!
//! See `crates/catalog/README.md` for the route/job mapping, configuration table and operator checklist.

#![warn(missing_docs)]

pub mod blocklist;
pub mod categories;
pub mod config;
pub mod cursor;
pub mod date;
pub mod dedup;
pub mod error;
pub mod fetch;
pub mod import;
pub mod model;
pub mod query;
pub mod slug;
pub mod source;
pub mod sources;
pub mod store;
pub mod text;
pub mod thumbs;
pub mod url;

use rusqlite::Connection;
use serde::Serialize;

pub use crate::categories::Category;
pub use crate::config::CatalogConfig;
pub use crate::cursor::CursorSecret;
pub use crate::error::{CatalogError, Result};
pub use crate::fetch::{
    BoxFuture, Clock, FetchError, FetchRequest, FetchResponse, Fetcher, FixtureFetcher, FixtureResponse, ManualClock,
    Method, TokioClock, WriteDb,
};
pub use crate::import::{ImportOptions, ImportReport};
pub use crate::model::{EmbedKind, NewGame};
pub use crate::query::{
    CatalogStats, CategoryCount, GameDetail, GamePage, GameSummary, ImportRun, ListPage, ListQuery, Sections, Sort,
    SourceStats, TagCount,
};
pub use crate::source::Source;
pub use crate::store::{AdminStatus, PlayOutcome};
pub use crate::thumbs::ThumbPolicy;

/// One SQL migration. Versions are globally unique across crates: core = 1..99, catalog = 100..199.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Globally unique version (catalog: 100..=199).
    pub version: i64,
    /// Short name recorded in `schema_migrations`.
    pub name: &'static str,
    /// The SQL, applied in one transaction.
    pub sql: &'static str,
}

/// Catalog migrations, applied by gnome-server's migration runner after the core migrations.
pub const MIGRATIONS: &[Migration] = &[
    Migration { version: 100, name: "catalog", sql: include_str!("../../../database/migrations/0100_catalog.sql") },
    Migration {
        version: 101,
        name: "catalog_search_index",
        sql: include_str!("../migrations/0101_catalog_search_index.sql"),
    },
];

/// Create the catalog schema on a standalone database (tests, tools, the live-import example). gnome-server must
/// not call this: its migration runner applies [`MIGRATIONS`] and records them.
pub fn init_schema(conn: &Connection) -> Result<()> {
    for m in MIGRATIONS {
        conn.execute_batch(m.sql)?;
    }
    Ok(())
}

/// How URLs are rendered in API responses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderOptions {
    /// Public app origin, e.g. `https://gnome.example.com` (GameDistribution's `gd_sdk_referrer_url` must be the
    /// exact game page URL `<app origin>/games/<slug>`).
    pub app_origin: String,
    /// Public proxy origin that serves self-hosted builds under `/oss/` (equal to the app origin in
    /// single-origin mode).
    pub proxy_origin: String,
    /// `GameSummary.thumbnail` = `/api/thumb/<id>` (`GNOME_THUMB_PROXY`), otherwise the source URL.
    pub thumb_proxy: bool,
}

/// Result of [`Catalog::prepare`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrepareReport {
    /// Runs left `running` by a previous process, now marked `interrupted`.
    pub interrupted_runs: usize,
    /// Whether the enabled sources / dedup order changed since the last start (groups were recomputed).
    pub listing_changed: bool,
    /// Rows re-mapped because the normalization rules or the blocklist changed (`None`: up to date).
    pub remapped: Option<usize>,
}

/// The catalog handle: configuration + cursor key + render options. Cheap to share (`Arc<Catalog>`).
#[derive(Debug, Clone)]
pub struct Catalog {
    config: CatalogConfig,
    cursor: CursorSecret,
    render: RenderOptions,
    thumbs: ThumbPolicy,
}

impl Catalog {
    /// Build the handle. `secret` is any server secret (it is passed through a domain-separated HMAC; cursors
    /// signed with one secret are rejected under another).
    pub fn new(config: CatalogConfig, secret: &[u8], render: RenderOptions) -> Self {
        let thumbs = ThumbPolicy::new(&config.sources);
        Self { cursor: CursorSecret::derive(secret), thumbs, config, render }
    }

    /// The configuration.
    pub fn config(&self) -> &CatalogConfig {
        &self.config
    }

    /// Render options.
    pub fn render_options(&self) -> &RenderOptions {
        &self.render
    }

    /// Thumbnail proxy policy (host allow-list of the enabled sources).
    pub fn thumb_policy(&self) -> &ThumbPolicy {
        &self.thumbs
    }

    /// Startup maintenance on the writer (call once before serving): mark interrupted runs, apply the enabled
    /// source set and dedup order, re-map stored records if the rules/blocklist changed, refresh facets and
    /// rankings.
    pub fn prepare(&self, conn: &mut Connection, now_ms: i64) -> Result<PrepareReport> {
        let interrupted_runs = store::abandon_running(conn, now_ms)?;
        let listing_changed = {
            let tx = conn.transaction()?;
            let changed = store::apply_listing_config(&tx, &self.config)?;
            tx.commit()?;
            changed
        };
        let remapped = store::reapply_rules(conn, &self.config, now_ms)?;
        let tx = conn.transaction()?;
        store::refresh_facets(&tx)?;
        store::refresh_rankings(&tx, now_ms)?;
        tx.commit()?;
        Ok(PrepareReport { interrupted_runs, listing_changed, remapped })
    }

    /// Periodic ranking refresh (hourly): decayed play windows → `pop_score` / `trend_score`, facet counts.
    pub fn refresh_rankings(&self, conn: &mut Connection, now_ms: i64) -> Result<usize> {
        let tx = conn.transaction()?;
        let n = store::refresh_rankings(&tx, now_ms)?;
        store::refresh_facets(&tx)?;
        tx.commit()?;
        Ok(n)
    }

    /// `POST /api/games/:slug/play`: count an anonymous play (one per `dedup_key` per game per hour).
    pub fn record_play(&self, conn: &mut Connection, slug: &str, dedup_key: &[u8], now_ms: i64) -> Result<PlayOutcome> {
        store::record_play(conn, slug, dedup_key, now_ms)
    }

    /// `POST /admin/games/:id/feature`.
    pub fn set_featured(&self, conn: &mut Connection, id: i64, featured: bool, now_ms: i64) -> Result<()> {
        store::set_featured(conn, id, featured, now_ms)
    }

    /// `POST /admin/games/:id/status` (`None` clears the override).
    pub fn set_status(&self, conn: &mut Connection, id: i64, status: Option<AdminStatus>) -> Result<()> {
        store::set_status(conn, id, status, &self.config.dedup_order)
    }
}
