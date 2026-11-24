//! Import driver integration tests on a temporary SQLite database with the fixture fetcher and a virtual clock.

mod common;

use std::time::Duration;

use common::*;
use gnome_catalog::{CatalogError, FixtureFetcher, FixtureResponse, ImportOptions, ManualClock, Method, Source};

fn gamepix_chess_fetcher() -> FixtureFetcher {
    let f = FixtureFetcher::new();
    f.on_url(&["feeds.gamepix.com", "page=1&", "category=chess"], vec![ok("gamepix-chess-p1.json")]);
    f.on_url(&["feeds.gamepix.com", "page=2&", "category=chess"], vec![ok("gamepix-chess-p2.json")]);
    f.on_url(&["feeds.gamepix.com", "page=3&", "category=chess"], vec![ok("gamepix-chess-p3.json")]);
    f
}

#[tokio::test]
async fn multi_page_import_is_paced_and_complete() {
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = gamepix_chess_fetcher();
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.status.as_str(), r.complete), ("complete", true), "{r:?}");
    assert_eq!((r.pages, r.requests, r.retries), (3, 3, 0));
    assert_eq!((r.seen, r.inserted, r.updated, r.rejected, r.hidden), (29, 29, 0, 0, 0));
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 29);
    assert_eq!(count(&db, "SELECT count(DISTINCT slug) FROM games"), 29);
    assert_eq!(count(&db, "SELECT count(*) FROM game_raw"), 29);
    assert_eq!(count(&db, "SELECT count(*) FROM games_fts WHERE games_fts MATCH 'chess'"), 29);
    // One request per second: two waits of ~1 s between three requests.
    let sleeps = clock.sleeps();
    assert_eq!(sleeps.len(), 2, "{sleeps:?}");
    assert!(sleeps.iter().all(|s| *s <= Duration::from_secs(1)));
    let reqs = f.requests();
    assert!(
        reqs.iter().all(|r| r.method == Method::Get && r.header("user-agent").unwrap().starts_with("GNOME-catalog/"))
    );
    assert!(reqs[0].url.starts_with("https://feeds.gamepix.com/v2/json?sid=1&pagination=12&page=1"));
    // Re-import: everything unchanged, nothing new.
    let f = gamepix_chess_fetcher();
    let r2 = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r2.complete, r2.inserted, r2.updated, r2.unchanged, r2.seen), (true, 0, 0, 29, 29));
    let runs = cat.import_runs(&db.lock().unwrap(), Some("gamepix"), 10).unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!((runs[0].status.as_str(), runs[0].seen, runs[0].pages, runs[0].requests), ("complete", 29, 3, 3));
}

#[tokio::test]
async fn etag_304_replays_the_cached_page() {
    let cat = gd10();
    let db = db();
    let clock = ManualClock::new(T0);
    let first = FixtureFetcher::new();
    first.on_url(&["page=1&"], vec![ok("gamedistribution-p1.json").header("ETag", GD_ETAG)]);
    first.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
    let r1 = cat.import(&first, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    assert_eq!((r1.complete, r1.inserted, r1.pages), (true, 10, 2), "{r1:?}");
    assert!(first.requests()[0].header("if-none-match").is_none());

    clock.advance(Duration::from_secs(86_400));
    let second = FixtureFetcher::new();
    second.route(
        |r| r.url.contains("page=1&") && r.header("If-None-Match") == Some(GD_ETAG),
        vec![FixtureResponse::status(304).header("ETag", GD_ETAG)],
    );
    second.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
    let r2 = cat.import(&second, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    assert_eq!(
        (r2.status.as_str(), r2.not_modified_pages, r2.unchanged, r2.seen, r2.inserted),
        ("complete", 1, 10, 10, 0)
    );
    assert_eq!(second.requests()[0].header("if-none-match"), Some(GD_ETAG));
    // The 304 counted as "seen": nothing is missing.
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE missing_count > 0"), 0);
}

#[tokio::test]
async fn rate_limits_and_server_errors_back_off_and_retry() {
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&"], vec![ok("gamepix-chess-p1.json")]);
    f.on_url(
        &["page=2&"],
        vec![
            FixtureResponse::status(429).header("Retry-After", "30"),
            FixtureResponse::status(503),
            ok("gamepix-chess-p2.json"),
        ],
    );
    f.on_url(&["page=3&"], vec![ok("gamepix-chess-p3.json")]);
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.retries, r.requests, r.seen), (true, 2, 5, 29), "{r:?}");
    let sleeps = clock.sleeps();
    // The 429 honoured Retry-After (30 s, ±20% jitter never goes below 24 s), the 503 backed off >= 2 s.
    assert!(sleeps.iter().any(|s| *s >= Duration::from_secs(24)), "{sleeps:?}");
    assert_eq!(count(&db, "SELECT retries FROM catalog_imports"), 2);
}

#[tokio::test]
async fn persistent_rate_limiting_fails_the_run_without_hiding() {
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let ok_run = gamepix_chess_fetcher();
    assert!(cat.import(&ok_run, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap().complete);
    for _ in 0..3 {
        let f = FixtureFetcher::new();
        f.on_url(&["page=1&"], vec![ok("gamepix-chess-p1.json")]);
        f.route_sticky(|r| r.url.contains("page=2&"), vec![FixtureResponse::status(429)]);
        let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
        assert_eq!((r.status.as_str(), r.complete), ("failed", false));
        assert!(r.error.as_deref().unwrap().contains("rate limited"), "{:?}", r.error);
        assert_eq!(r.retries, 4);
        assert_eq!(f.requests().len(), 1 + 5);
    }
    // Exponential back-off: 5 s, 10 s, 20 s, 40 s (±20%).
    let waits: Vec<u64> = clock.sleeps().iter().map(Duration::as_secs).filter(|s| *s >= 4).take(4).collect();
    assert!(waits[0] >= 4 && waits[0] <= 6 && waits[3] >= 32 && waits[3] <= 48, "{waits:?}");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE missing_count > 0"), 0, "failed runs never hide");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 29);
    let failed = count(&db, "SELECT count(*) FROM catalog_imports WHERE status = 'failed' AND complete = 0");
    assert_eq!(failed, 3);
}

#[tokio::test]
async fn a_sharp_drop_in_size_is_an_incomplete_sync() {
    let cat = gd10();
    let db = db();
    let clock = ManualClock::new(T0);
    let full = FixtureFetcher::new();
    full.on_url(&["page=1&"], vec![ok("gamedistribution-p1.json")]);
    full.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
    assert!(cat.import(&full, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap().complete);
    let half = || {
        // The feed suddenly lists half of the catalog (e.g. an upstream outage).
        let f = FixtureFetcher::new();
        f.on_url(&["page=1&"], vec![gd_subset(5)]);
        f
    };
    for _ in 0..2 {
        let r = cat.import(&half(), &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
        assert_eq!((r.status.as_str(), r.complete, r.seen, r.hidden), ("incomplete", false, 5, 0), "{r:?}");
        assert!(r.note.as_deref().unwrap().contains("outside ±10%"), "{:?}", r.note);
    }
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE missing_count > 0"), 0, "untrusted syncs hide nothing");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 10);
    // Three consecutive syncs agree on the new size: it is accepted, and the missing games start counting.
    let r = cat.import(&half(), &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    assert!(r.complete && r.note.as_deref().unwrap().contains("confirmed by 3 consecutive syncs"), "{r:?}");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE missing_count = 1"), 5);
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 10, "still listed until 3 strikes");
    for _ in 0..2 {
        assert!(
            cat.import(&half(), &clock, &db, Source::GameDistribution, ImportOptions::default())
                .await
                .unwrap()
                .complete
        );
    }
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 5);
    // An empty feed is never complete either.
    let empty = FixtureFetcher::new();
    empty.on_url(&["page=1&"], vec![ok("gamedistribution-end.json")]);
    let r = cat.import(&empty, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.note.as_deref()), (false, Some("the feed listed no games")));
}

#[tokio::test]
async fn games_missing_from_three_complete_syncs_are_hidden_and_come_back() {
    let cat = gd10();
    let db = db();
    let clock = ManualClock::new(T0);
    let full = || {
        let f = FixtureFetcher::new();
        f.on_url(&["page=1&"], vec![ok("gamedistribution-p1.json")]);
        f.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
        f
    };
    assert!(
        cat.import(&full(), &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap().complete
    );
    // The 10th game disappears from the feed (9 of 10 is within ±10%: these syncs are complete).
    let last = "SELECT missing_count FROM games WHERE source_id = '2481802388a8421eb67c25a0d4dee395'";
    for round in 1..=3 {
        let f = FixtureFetcher::new();
        f.on_url(&["page=1&"], vec![gd_subset(9)]);
        clock.advance(Duration::from_secs(86_400));
        let r = cat.import(&f, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
        assert!(r.complete, "{r:?}");
        assert_eq!(count(&db, last), round);
        assert_eq!(r.hidden, i64::from(round == 3));
        let listed = count(&db, "SELECT count(*) FROM games WHERE listed = 1");
        assert_eq!(listed, if round < 3 { 10 } else { 9 });
    }
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM games WHERE status = 'hidden' AND source_id = '2481802388a8421eb67c25a0d4dee395'"
        ),
        1
    );
    // It returns: listed again, counter reset.
    let r = cat.import(&full(), &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    assert!(r.complete);
    assert_eq!(count(&db, last), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 10);
}

#[tokio::test]
async fn limited_runs_never_count_as_complete() {
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = gamepix_chess_fetcher();
    let r =
        cat.import(&f, &clock, &db, Source::GamePix, ImportOptions { limit: Some(5), max_pages: None }).await.unwrap();
    assert_eq!((r.status.as_str(), r.complete, r.inserted, r.pages), ("incomplete", false, 5, 1), "{r:?}");
    assert!(r.note.unwrap().contains("limited"));
    let f = gamepix_chess_fetcher();
    let r =
        cat.import(&f, &clock, &db, Source::GamePix, ImportOptions { limit: None, max_pages: Some(2) }).await.unwrap();
    assert_eq!((r.complete, r.pages, r.inserted), (false, 2, 19));
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE missing_count > 0"), 0);
}

#[tokio::test]
async fn http_errors_and_disabled_sources() {
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    f.on_url(
        &["page=1&"],
        vec![FixtureResponse { status: 400, headers: vec![], body: common::fixture("gamepix-badsid.json") }],
    );
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!(r.status, "failed");
    assert!(r.error.as_deref().unwrap().contains("sid not found"), "{:?}", r.error);
    assert_eq!(f.requests().len(), 1, "4xx is not retried");
    // Garbage instead of JSON fails the run.
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&"], vec![FixtureResponse::ok("<html>maintenance</html>")]);
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert!(r.error.as_deref().unwrap().contains("invalid GamePix feed JSON"));
    // Not enabled.
    let e = cat.import(&f, &clock, &db, Source::Playgama, ImportOptions::default()).await.unwrap_err();
    assert!(matches!(e, CatalogError::SourceDisabled(Source::Playgama)));
    // Oversized bodies are refused by the fetcher contract.
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&"], vec![FixtureResponse::ok(vec![b' '; 5 << 20])]);
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert!(r.error.as_deref().unwrap().contains("larger than"), "{:?}", r.error);
}

#[tokio::test]
async fn gamemonetize_cloudflare_1015_is_retried() {
    let mut c = config(&[Source::GameMonetize]);
    c.gamemonetize.per_page = 10;
    let cat = catalog(c);
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    let blocked = FixtureResponse::ok("<!DOCTYPE html><title>Access denied</title><span>error code: 1015</span>");
    f.on_url(&["feed.php", "page=1"], vec![blocked, ok("gamemonetize-p1.json")]);
    f.on_url(&["feed.php", "page=2"], vec![FixtureResponse::ok("[]")]);
    let r = cat.import(&f, &clock, &db, Source::GameMonetize, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.retries, r.inserted), (true, 1, 10), "{r:?}");
    // >= 10 s between requests, >= 48 s after the 1015 page (60 s base, -20% jitter).
    assert!(clock.sleeps().iter().all(|s| *s >= Duration::from_secs(10)), "{:?}", clock.sleeps());
    assert!(clock.sleeps().iter().any(|s| *s >= Duration::from_secs(48)));
}

#[tokio::test]
async fn playgama_pages_by_offset_and_posts_json() {
    let mut c = config(&[Source::Playgama]);
    c.playgama.per_page = 10;
    let cat = catalog(c);
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    f.route(|r| r.method == Method::Post, vec![FixtureResponse { status: 201, ..ok("playgama-p1.json") }]);
    // Only one page is captured; the second request (offset 10) fails, so the run must not be complete.
    let r = cat.import(&f, &clock, &db, Source::Playgama, ImportOptions::default()).await.unwrap();
    assert_eq!((r.status.as_str(), r.inserted, r.pages), ("failed", 10, 1), "{r:?}");
    let reqs = f.requests();
    let body: serde_json::Value = serde_json::from_slice(reqs[0].body.as_ref().unwrap()).unwrap();
    assert_eq!(body["pagination"], serde_json::json!({"limit": 10, "offset": 0}));
    assert_eq!(body["sort"]["type"], "ranking_default");
    assert_eq!(reqs[0].header("content-type"), Some("application/json"));
    let second: serde_json::Value = serde_json::from_slice(reqs[1].body.as_ref().unwrap()).unwrap();
    assert_eq!(second["pagination"]["offset"], 10);
    // The knock-off is stored but not listed.
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE status = 'ip_risk'"), 1);
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 9);
}

#[tokio::test]
async fn link_out_sources_import_as_unplayable() {
    let mut c = config(&[Source::ItchIo, Source::Js13k]);
    c.itchio.max_pages = 1;
    c.js13k.first_year = 2026;
    let cat = catalog(c);
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    f.on_url(&["itch.io/games/free/platform-web.xml?page=1"], vec![ok("itch-free-web.xml")]);
    f.on_url(&["js13kgames.com/2026/games.xml"], vec![ok("js13k-2026.xml")]);
    let r = cat.import(&f, &clock, &db, Source::ItchIo, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.inserted), (true, 36), "{r:?}");
    let r = cat.import(&f, &clock, &db, Source::Js13k, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.inserted), (true, 317), "{r:?}");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE playable = 1"), 0);
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE embed_kind = 'link'"), 353);
}

#[tokio::test]
async fn oss_import_requires_builds_and_hides_removed_entries_at_once() {
    let dir = tempfile::tempdir().unwrap();
    for slug_entry in ["2048/index.html", "bullethell/index.html", "javascript-racer/v4.final.html"] {
        let p = dir.path().join(slug_entry);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "<!doctype html>").unwrap();
    }
    let mut c = config(&[Source::Oss]);
    c.oss.require_builds = true;
    c.oss.builds_dir = dir.path().to_owned();
    let cat = catalog(c);
    let db = db();
    let clock = ManualClock::new(T0);
    let none = FixtureFetcher::new();
    let r = cat.import(&none, &clock, &db, Source::Oss, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.inserted, r.requests), (true, 3, 0), "{r:?}");
    assert!(none.requests().is_empty(), "the manifest is local");
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE embed_kind = 'selfhost' AND listed = 1"), 3);
    std::fs::remove_file(dir.path().join("bullethell/index.html")).unwrap();
    let r = cat.import(&none, &clock, &db, Source::Oss, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.hidden), (true, 1));
    assert_eq!(count(&db, "SELECT count(*) FROM games WHERE listed = 1"), 2);
    let r = cat.import(&none, &clock, &db, Source::Oss, ImportOptions::default()).await.unwrap();
    assert_eq!(r.hidden, 0, "already hidden games are not counted again");
}

#[test]
fn import_futures_are_send() {
    // gnome-server spawns imports on Tokio, so the future must be `Send`.
    fn assert_send<T: Send>(_: &T) {}
    let cat = gamepix_chess();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    let one = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default());
    assert_send(&one);
    let all = cat.import_enabled(&f, &clock, &db, ImportOptions::default());
    assert_send(&all);
    // Through trait objects too.
    let dyn_f: &dyn gnome_catalog::Fetcher = &f;
    let dyn_c: &dyn gnome_catalog::Clock = &clock;
    let via_dyn = cat.import(dyn_f, dyn_c, &db, Source::GamePix, ImportOptions::default());
    assert_send(&via_dyn);
}
