//! Shared helpers for the integration tests.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Mutex;

use gnome_catalog::{Catalog, CatalogConfig, FixtureResponse, RenderOptions, Source};
use rusqlite::Connection;

/// Start of the virtual clock used by the tests: 2026-11-10T12:00:00Z.
pub const T0: i64 = 1_794_312_000_000;

pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(fixture_path(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

pub fn fixture_str(name: &str) -> String {
    String::from_utf8(fixture(name)).expect("utf-8 fixture")
}

pub fn ok(name: &str) -> FixtureResponse {
    FixtureResponse::ok(fixture(name))
}

/// A fresh in-memory catalog database (foreign keys on, as in gnome-server).
pub fn db() -> Mutex<Connection> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    gnome_catalog::init_schema(&conn).unwrap();
    Mutex::new(conn)
}

pub fn render() -> RenderOptions {
    RenderOptions {
        app_origin: "https://gnome.example.com".into(),
        proxy_origin: "https://p.gnome.example.com".into(),
        thumb_proxy: true,
    }
}

/// Config with exactly these sources enabled (operator IDs filled in for gated ones).
pub fn config(sources: &[Source]) -> CatalogConfig {
    let mut c = CatalogConfig::default();
    c.gamedistribution.publisher_id = Some("test-publisher".into());
    c.playgama.clid = Some("test-clid".into());
    c.gamemonetize.enabled = true;
    c.famobi.affiliate_id = Some("A-TEST".into());
    c.oss.require_builds = false;
    c.sources = sources.to_vec();
    c
}

pub fn catalog(c: CatalogConfig) -> Catalog {
    Catalog::new(c, b"integration-test-secret", render())
}

/// GamePix restricted to the captured `chess` category (3 pages of 12).
pub fn gamepix_chess() -> Catalog {
    let mut c = config(&[Source::GamePix]);
    c.gamepix.per_page = 12;
    c.gamepix.category = Some("chess".into());
    catalog(c)
}

/// GameDistribution with 10 items per page (the captured page size).
pub fn gd10() -> Catalog {
    let mut c = config(&[Source::GameDistribution]);
    c.gamedistribution.per_page = 10;
    catalog(c)
}

/// The weak ETag the captured GameDistribution page was served with.
pub const GD_ETAG: &str = "W/\"3790-uh5RA/LCmaLPy5IOyTIc1a5Dv9I\"";

/// First `n` records of the captured GameDistribution page, as a JSON array (records unaltered).
pub fn gd_subset(n: usize) -> FixtureResponse {
    let items: Vec<serde_json::Value> = serde_json::from_slice(&fixture("gamedistribution-p1.json")).unwrap();
    FixtureResponse::ok(serde_json::to_vec(&items[..n]).unwrap())
}

pub fn count(conn: &Mutex<Connection>, sql: &str) -> i64 {
    conn.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}
