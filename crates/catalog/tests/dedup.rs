//! Cross-source dedup with a real pair: "Temple Blocks", listed by both Famobi and GamePix
//! (tests/fixtures/dedup-temple-blocks.json, records unaltered).

mod common;

use common::*;
use gnome_catalog::{
    AdminStatus, Catalog, Clock, FixtureFetcher, FixtureResponse, ImportOptions, ListQuery, ManualClock, Source,
};

fn pair() -> (serde_json::Value, serde_json::Value) {
    let v: serde_json::Value = serde_json::from_slice(&fixture("dedup-temple-blocks.json")).unwrap();
    (v["famobi"].clone(), v["gamepix"].clone())
}

/// Import each record through its source's real adapter (single-item pages).
async fn import_both(cat: &Catalog, db: &std::sync::Mutex<rusqlite::Connection>, clock: &ManualClock) {
    let (famobi, gamepix) = pair();
    let f = FixtureFetcher::new();
    f.on_url(&["feeds.gamepix.com"], vec![FixtureResponse::ok(serde_json::json!({ "items": [gamepix] }).to_string())]);
    f.on_url(
        &["api.famobi.com"],
        vec![FixtureResponse::ok(serde_json::json!({ "num_games": 1, "games": [famobi] }).to_string())],
    );
    for s in [Source::GamePix, Source::Famobi] {
        let r = cat.import(&f, clock, db, s, ImportOptions::default()).await.unwrap();
        assert_eq!((r.complete, r.inserted), (true, 1), "{r:?}");
    }
}

fn ids(cat: &Catalog, conn: &rusqlite::Connection) -> Vec<(i64, Source)> {
    cat.list(conn, &ListQuery::default()).unwrap().items.iter().map(|g| (g.id, g.source)).collect()
}

#[tokio::test]
async fn preferred_listing_with_fallback() {
    let cfg = config(&[Source::GamePix, Source::Famobi]);
    let cat = catalog(cfg.clone());
    let db = db();
    let clock = ManualClock::new(T0);
    import_both(&cat, &db, &clock).await;
    let mut conn = db.lock().unwrap();
    let id = |s: &str| -> i64 { conn.query_row("SELECT id FROM games WHERE source = ?1", [s], |r| r.get(0)).unwrap() };
    let (gp, fa) = (id("gamepix"), id("famobi"));
    let key: (String, String) = conn
        .query_row(
            "SELECT a.dedup_key, b.dedup_key FROM games a, games b WHERE a.id = ?1 AND b.id = ?2",
            [gp, fa],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(key, ("templeblocks".to_owned(), "templeblocks".to_owned()));
    // Default order prefers GamePix over Famobi: one listing, the other kept as a fallback.
    assert_eq!(ids(&cat, &conn), [(gp, Source::GamePix)]);
    let canonical: Option<i64> =
        conn.query_row("SELECT canonical_id FROM games WHERE id = ?1", [fa], |r| r.get(0)).unwrap();
    assert_eq!(canonical, Some(gp));
    assert!(cat.categories(&conn, false).unwrap().iter().map(|c| c.count).sum::<u64>() > 0);
    // A favorite pointing at the fallback still resolves (by-ids and detail).
    assert_eq!(cat.by_ids(&conn, &[fa]).unwrap().len(), 1);
    let fslug: String = conn.query_row("SELECT slug FROM games WHERE id = ?1", [fa], |r| r.get(0)).unwrap();
    assert!(cat.game(&conn, &fslug, 0, &Default::default()).unwrap().is_some());

    // The preferred listing breaks: the fallback takes over at once.
    cat.set_status(&mut conn, gp, Some(AdminStatus::Broken)).unwrap();
    assert_eq!(ids(&cat, &conn), [(fa, Source::Famobi)]);
    let page = cat.game(&conn, &fslug, 0, &Default::default()).unwrap().unwrap();
    assert_eq!(page.game.embed_url, "https://play.famobi.com/temple-blocks/A-TEST");
    cat.set_status(&mut conn, gp, None).unwrap();
    assert_eq!(ids(&cat, &conn), [(gp, Source::GamePix)]);

    // The operator prefers Famobi: prepare() recomputes the groups.
    let mut famobi_first = cfg.clone();
    famobi_first.dedup_order.retain(|s| *s != Source::Famobi);
    famobi_first.dedup_order.insert(0, Source::Famobi);
    let cat2 = catalog(famobi_first);
    assert!(cat2.prepare(&mut conn, clock.now_ms()).unwrap().listing_changed);
    assert_eq!(ids(&cat2, &conn), [(fa, Source::Famobi)]);
    // Famobi disabled: GamePix is listed again.
    let mut gp_only = cfg;
    gp_only.sources = vec![Source::GamePix];
    let cat3 = catalog(gp_only);
    assert!(cat3.prepare(&mut conn, clock.now_ms()).unwrap().listing_changed);
    assert_eq!(ids(&cat3, &conn), [(gp, Source::GamePix)]);
    let stats = cat3.stats(&conn).unwrap();
    assert_eq!((stats.games, stats.listed), (2, 1));
}

#[tokio::test]
async fn hidden_preferred_listing_promotes_the_fallback_after_missing_syncs() {
    let cat = catalog(config(&[Source::GamePix, Source::Famobi]));
    let db = db();
    let clock = ManualClock::new(T0);
    import_both(&cat, &db, &clock).await;
    // GamePix stops listing the game; once it is hidden (3 complete syncs) the Famobi listing is shown.
    let other_gamepix_page = || {
        let f = FixtureFetcher::new();
        f.on_url(&["feeds.gamepix.com"], vec![ok("gamepix-mahjong-p1.json")]);
        f
    };
    // The replacement (single) page lists 29 other real games: growth (1 → 29) is accepted, so the syncs count.
    for round in 1..=3 {
        let r =
            cat.import(&other_gamepix_page(), &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
        assert!(r.complete, "{r:?}");
        let listed_famobi = count(&db, "SELECT count(*) FROM games WHERE source = 'famobi' AND listed = 1");
        assert_eq!(listed_famobi, i64::from(round == 3), "round {round}");
    }
}
