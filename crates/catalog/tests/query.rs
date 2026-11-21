//! Query API tests on catalogs imported from the captured feeds.

mod common;

use std::collections::HashSet;
use std::sync::Mutex;

use common::*;
use gnome_catalog::{
    AdminStatus, Catalog, CatalogError, Clock, FixtureFetcher, ImportOptions, ListQuery, ManualClock, PlayOutcome,
    Sort, Source,
};
use rusqlite::Connection;

async fn import_chess(cat: &Catalog, db: &Mutex<Connection>, clock: &ManualClock) {
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&", "category=chess"], vec![ok("gamepix-chess-p1.json")]);
    f.on_url(&["page=2&", "category=chess"], vec![ok("gamepix-chess-p2.json")]);
    f.on_url(&["page=3&", "category=chess"], vec![ok("gamepix-chess-p3.json")]);
    assert!(cat.import(&f, clock, db, Source::GamePix, ImportOptions::default()).await.unwrap().complete);
}

/// Mahjong page as a limited run (so the chess games are not counted as missing).
async fn import_mahjong(db: &Mutex<Connection>, clock: &ManualClock) {
    let mut c = config(&[Source::GamePix, Source::GameDistribution]);
    c.gamepix.per_page = 96;
    c.gamepix.category = Some("mahjong".into());
    let cat = catalog(c);
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&", "category=mahjong"], vec![ok("gamepix-mahjong-p1.json")]);
    let r =
        cat.import(&f, clock, db, Source::GamePix, ImportOptions { limit: None, max_pages: Some(5) }).await.unwrap();
    assert_eq!(r.inserted, 29, "{r:?}");
}

async fn import_gd(cat: &Catalog, db: &Mutex<Connection>, clock: &ManualClock) {
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&"], vec![ok("gamedistribution-p1.json")]);
    f.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
    assert!(cat.import(&f, clock, db, Source::GameDistribution, ImportOptions::default()).await.unwrap().complete);
}

/// Catalog with GamePix (chess pages) + GameDistribution enabled.
fn mixed() -> Catalog {
    let mut c = config(&[Source::GamePix, Source::GameDistribution]);
    c.gamepix.per_page = 12;
    c.gamepix.category = Some("chess".into());
    c.gamedistribution.per_page = 10;
    catalog(c)
}

async fn setup() -> (Catalog, Mutex<Connection>, ManualClock) {
    let cat = mixed();
    let db = db();
    let clock = ManualClock::new(T0);
    import_chess(&cat, &db, &clock).await;
    import_mahjong(&db, &clock).await;
    import_gd(&cat, &db, &clock).await;
    (cat, db, clock)
}

fn page_all(cat: &Catalog, conn: &Connection, base: &ListQuery, limit: u32) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut q = base.clone();
    q.limit = Some(limit);
    loop {
        let p = cat.list(conn, &q).unwrap();
        assert!(p.items.len() <= limit as usize);
        ids.extend(p.items.iter().map(|g| g.id));
        match p.next_cursor {
            Some(c) => q.cursor = Some(c),
            None => break,
        }
    }
    ids
}

#[tokio::test]
async fn keyset_paging_is_stable_under_concurrent_inserts() {
    let cat = mixed();
    let db = db();
    let clock = ManualClock::new(T0);
    import_chess(&cat, &db, &clock).await;
    let chess: HashSet<i64> = {
        let conn = db.lock().unwrap();
        cat.list(&conn, &ListQuery { limit: Some(100), ..ListQuery::default() })
            .unwrap()
            .items
            .iter()
            .map(|g| g.id)
            .collect()
    };
    assert_eq!(chess.len(), 29);
    let first = {
        let conn = db.lock().unwrap();
        cat.list(&conn, &ListQuery { limit: Some(10), ..ListQuery::default() }).unwrap()
    };
    assert_eq!((first.items.len(), first.total), (10, 29));
    // 39 more games arrive between page loads (some rank above the cursor, some below).
    import_mahjong(&db, &clock).await;
    import_gd(&cat, &db, &clock).await;
    let conn = db.lock().unwrap();
    let mut seen: Vec<i64> = first.items.iter().map(|g| g.id).collect();
    let mut q = ListQuery { limit: Some(10), cursor: first.next_cursor.clone(), ..ListQuery::default() };
    let mut last_score = f64::INFINITY;
    loop {
        let p = cat.list(&conn, &q).unwrap();
        assert_eq!(p.total, 68);
        for g in &p.items {
            let s: f64 = conn.query_row("SELECT pop_score FROM games WHERE id = ?1", [g.id], |r| r.get(0)).unwrap();
            assert!(s <= last_score + 1e-12, "order is non-increasing");
            last_score = s;
        }
        seen.extend(p.items.iter().map(|g| g.id));
        match p.next_cursor {
            Some(c) => q.cursor = Some(c),
            None => break,
        }
    }
    let unique: HashSet<i64> = seen.iter().copied().collect();
    assert_eq!(unique.len(), seen.len(), "no game is returned twice");
    assert!(chess.is_subset(&unique), "no original game is skipped");
}

#[tokio::test]
async fn every_sort_pages_through_the_whole_result() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    for sort in [Sort::Popular, Sort::Trending, Sort::New, Sort::Featured, Sort::Az] {
        let base = ListQuery { sort: Some(sort), ..ListQuery::default() };
        let all = cat.list(&conn, &ListQuery { limit: Some(100), ..base.clone() }).unwrap();
        assert_eq!(all.total, 68);
        let paged = page_all(&cat, &conn, &base, 7);
        assert_eq!(paged, all.items.iter().map(|g| g.id).collect::<Vec<_>>(), "{sort:?}");
    }
    let az = cat.list(&conn, &ListQuery { sort: Some(Sort::Az), limit: Some(100), ..ListQuery::default() }).unwrap();
    let titles: Vec<String> = az.items.iter().map(|g| g.title.to_lowercase()).collect();
    let mut sorted = titles.clone();
    sorted.sort_by_key(|t| gnome_catalog::slug::fold(t.trim_start_matches(|c: char| !c.is_alphanumeric())));
    assert_eq!(titles, sorted);
    // Relevance pages too.
    let base = ListQuery { q: Some("mahjong".into()), ..ListQuery::default() };
    let all = cat.list(&conn, &ListQuery { limit: Some(100), ..base.clone() }).unwrap();
    assert!(all.total >= 29, "{}", all.total);
    assert_eq!(page_all(&cat, &conn, &base, 4), all.items.iter().map(|g| g.id).collect::<Vec<_>>());
}

#[tokio::test]
async fn tampered_or_foreign_cursors_are_rejected() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let p = cat.list(&conn, &ListQuery { limit: Some(5), ..ListQuery::default() }).unwrap();
    let cursor = p.next_cursor.unwrap();
    let bad = |q: ListQuery| matches!(cat.list(&conn, &q), Err(CatalogError::InvalidInput(_)));
    let mut flipped = cursor.clone().into_bytes();
    let i = flipped.len() / 2;
    flipped[i] = if flipped[i] == b'A' { b'B' } else { b'A' };
    assert!(bad(ListQuery { cursor: Some(String::from_utf8(flipped).unwrap()), ..ListQuery::default() }));
    assert!(bad(ListQuery { cursor: Some(cursor.clone()), sort: Some(Sort::New), ..ListQuery::default() }));
    assert!(bad(ListQuery { cursor: Some(cursor.clone()), category: Some("puzzle".into()), ..ListQuery::default() }));
    assert!(bad(ListQuery { cursor: Some("not-a-cursor".into()), ..ListQuery::default() }));
    // A cursor signed by another server secret.
    let other = Catalog::new(mixed().config().clone(), b"another secret", render());
    assert!(matches!(
        other.list(&conn, &ListQuery { cursor: Some(cursor), ..ListQuery::default() }),
        Err(CatalogError::InvalidInput(_))
    ));
    assert!(bad(ListQuery { category: Some("girls".into()), ..ListQuery::default() }));
    assert!(bad(ListQuery { limit: Some(0), ..ListQuery::default() }));
    assert!(bad(ListQuery { limit: Some(101), ..ListQuery::default() }));
    assert!(bad(ListQuery { q: Some("x".repeat(101)), ..ListQuery::default() }));
}

#[tokio::test]
async fn full_text_search_ranks_titles_first() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let search =
        |q: &str| cat.list(&conn, &ListQuery { q: Some(q.into()), limit: Some(100), ..ListQuery::default() }).unwrap();
    let r = search("mahjong");
    let in_title: Vec<bool> = r.items.iter().map(|g| g.title.to_lowercase().contains("mahjong")).collect();
    let first_other = in_title.iter().position(|t| !t).unwrap_or(in_title.len());
    assert!(first_other >= 20, "title matches come first: {:?}", r.items.iter().map(|g| &g.title).collect::<Vec<_>>());
    assert!(in_title[first_other..].iter().all(|t| !t), "no title match after a non-title match");
    assert!(r.items.len() > first_other, "keyword/description matches are found too");
    // Prefix (type-ahead), diacritics and case folding.
    assert!(search("ches").total >= search("chess").total);
    assert!(search("chess").total >= 29);
    assert_eq!(search("CHÉSS").total, search("chess").total);
    // Category keywords are indexed: "strategy" finds the chess games (category strategy).
    assert!(search("strategy").total >= 29);
    assert_eq!(search("zzqxv").total, 0);
    let empty = search(";;; --");
    assert_eq!((empty.total, empty.items.len()), (0, 0));
    // Search combined with a category filter and another sort.
    let r = cat
        .list(
            &conn,
            &ListQuery {
                q: Some("chess".into()),
                category: Some("strategy".into()),
                sort: Some(Sort::Az),
                ..ListQuery::default()
            },
        )
        .unwrap();
    assert!(r.total >= 29 && r.items.iter().all(|g| g.categories.contains(&"strategy".to_owned())));
}

#[tokio::test]
async fn category_filter_sorted_by_popularity() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let q = ListQuery {
        category: Some("puzzle".into()),
        sort: Some(Sort::Popular),
        limit: Some(100),
        ..ListQuery::default()
    };
    let r = cat.list(&conn, &q).unwrap();
    assert!(r.items.iter().all(|g| g.categories.contains(&"puzzle".to_owned())));
    let facet = cat.categories(&conn, false).unwrap().into_iter().find(|c| c.slug == "puzzle").unwrap();
    assert_eq!(facet.count, r.total);
    let scores: Vec<f64> = r
        .items
        .iter()
        .map(|g| conn.query_row("SELECT pop_score FROM games WHERE id = ?1", [g.id], |x| x.get(0)).unwrap())
        .collect();
    assert!(scores.windows(2).all(|w| w[0] >= w[1]));
    // Tag filter (GameDistribution tags).
    let r = cat.list(&conn, &ListQuery { tag: Some("Sorting".into()), ..ListQuery::default() }).unwrap();
    assert_eq!(r.items.iter().map(|g| g.title.as_str()).collect::<Vec<_>>(), ["Flower Sort Adventure"]);
}

#[tokio::test]
async fn sections_categories_and_tags() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let s = cat.sections(&conn, 24).unwrap();
    assert_eq!((s.featured.len(), s.trending.len(), s.popular.len()), (24, 24, 24));
    assert!(!s.new.is_empty() && s.new.len() <= 24);
    // No admin picks yet: featured is topped up by source quality (GamePix quality_score).
    let q: Vec<f64> = s
        .featured
        .iter()
        .map(|g| conn.query_row("SELECT quality FROM games WHERE id = ?1", [g.id], |r| r.get(0)).unwrap())
        .collect();
    assert!(q.windows(2).all(|w| w[0] >= w[1]));
    let cats = cat.categories(&conn, false).unwrap();
    assert!(cats.len() >= 14);
    assert_eq!(
        cats[..14].iter().map(|c| c.slug.as_str()).collect::<Vec<_>>(),
        [
            "action",
            "adventure",
            "arcade",
            "racing",
            "sports",
            "puzzle",
            "strategy",
            "multiplayer",
            "simulation",
            "idle",
            "platformer",
            "casual",
            "horror",
            "sandbox"
        ]
    );
    assert!(cats.iter().find(|c| c.slug == "strategy").unwrap().count >= 29);
    assert!(cats.iter().any(|c| c.slug == "io" && c.count == 2), "optional categories appear when used");
    let tags = cat.tags(&conn, "so", 10, false).unwrap();
    assert_eq!(tags.iter().map(|t| (t.tag.as_str(), t.count)).collect::<Vec<_>>(), [("sorting", 1)]);
    let all_tags = cat.tags(&conn, "", 100, false).unwrap();
    assert!(all_tags.len() > 20 && all_tags.windows(2).all(|w| w[0].count >= w[1].count));
}

#[tokio::test]
async fn by_ids_detail_and_related() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let some = cat.list(&conn, &ListQuery { limit: Some(3), ..ListQuery::default() }).unwrap().items;
    let ids = [some[2].id, 999_999, some[0].id, some[2].id];
    let got: Vec<i64> = cat.by_ids(&conn, &ids).unwrap().iter().map(|g| g.id).collect();
    assert_eq!(got, [some[2].id, some[0].id], "order kept, missing omitted, duplicates once");
    assert!(cat.by_ids(&conn, &vec![1; 201]).is_err());

    // GamePix: SID filled in; thumbnail through the proxy.
    let slug: String = conn
        .query_row(
            "SELECT slug FROM games WHERE source = 'gamepix' AND categories LIKE '%strategy%' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let page = cat.game(&conn, &slug, 6).unwrap().unwrap();
    let g = &page.game;
    assert!(
        g.embed_url.starts_with("https://play.gamepix.com/") && g.embed_url.ends_with("/embed?sid=1"),
        "{}",
        g.embed_url
    );
    assert_eq!(g.summary.thumbnail.as_deref(), Some(format!("/api/thumb/{}", g.summary.id).as_str()));
    assert_eq!((g.embed_kind.as_str(), g.summary.playable, g.attribution.as_str()), ("iframe", true, "via GamePix"));
    assert_eq!(page.related.len(), 6);
    assert!(page.related.iter().all(|r| r.id != g.summary.id && r.playable));
    let shared = page.related.iter().filter(|r| r.categories.iter().any(|c| g.summary.categories.contains(c))).count();
    assert_eq!(shared, 6, "related games share a category");

    // GameDistribution: the referrer is the exact GNOME game page URL.
    let slug: String = conn
        .query_row("SELECT slug FROM games WHERE source_id = '569b64ffae3b4021ac9dda1fd78cd4e0'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(slug, "flower-sort-adventure");
    let gd = cat.game(&conn, &slug, 0).unwrap().unwrap().game;
    assert_eq!(
        gd.embed_url,
        "https://html5.gamedistribution.com/569b64ffae3b4021ac9dda1fd78cd4e0/?gd_sdk_referrer_url=https%3A%2F%2Fgnome.example.com%2Fgames%2Fflower-sort-adventure"
    );
    assert_eq!(gd.flags, ["kids_friendly", "no_blood"]);
    assert_eq!(gd.tags, ["flowers", "sorting", "match3"]);
    let json = serde_json::to_value(&gd).unwrap();
    for key in [
        "id",
        "slug",
        "title",
        "developer",
        "thumbnail",
        "categories",
        "mobile",
        "source",
        "added_at",
        "plays",
        "description",
        "instructions",
        "tags",
        "embed_url",
        "width",
        "height",
        "source_url",
        "developer_url",
        "license",
        "published_at",
        "attribution",
        "playable",
    ] {
        assert!(json.get(key).is_some(), "GameDetail.{key}");
    }
    assert_eq!(json["source"], "gamedistribution");
    assert!(cat.game(&conn, "no-such-game", 3).unwrap().is_none());
    assert!(cat.game(&conn, "../etc", 3).unwrap().is_none());
}

#[tokio::test]
async fn plays_drive_popularity_and_trending() {
    let (cat, db, clock) = setup().await;
    let mut conn = db.lock().unwrap();
    let last =
        cat.list(&conn, &ListQuery { sort: Some(Sort::Popular), limit: Some(100), ..ListQuery::default() }).unwrap();
    let target = last.items.last().unwrap().clone();
    let now = clock.now_ms();
    assert_eq!(cat.record_play(&mut conn, &target.slug, b"session-a", now).unwrap(), PlayOutcome::Counted);
    assert_eq!(cat.record_play(&mut conn, &target.slug, b"session-a", now + 1000).unwrap(), PlayOutcome::Duplicate);
    assert_eq!(cat.record_play(&mut conn, &target.slug, b"session-b", now).unwrap(), PlayOutcome::Counted);
    assert_eq!(cat.record_play(&mut conn, &target.slug, b"session-a", now + 3_600_000).unwrap(), PlayOutcome::Counted);
    for i in 0..40u32 {
        cat.record_play(&mut conn, &target.slug, format!("s{i}").as_bytes(), now).unwrap();
    }
    assert!(matches!(cat.record_play(&mut conn, "no-such-game", b"x", now), Err(CatalogError::NotFound)));
    let stored: Vec<u8> = conn.query_row("SELECT key FROM game_play_dedup LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(stored.len(), 16, "only a hash is stored");
    assert!(!String::from_utf8_lossy(&stored).contains("session"));
    cat.refresh_rankings(&mut conn, now + 3_600_000).unwrap();
    for sort in [Sort::Popular, Sort::Trending] {
        let top = cat.list(&conn, &ListQuery { sort: Some(sort), limit: Some(1), ..ListQuery::default() }).unwrap();
        assert_eq!(top.items[0].id, target.id, "{sort:?}");
        assert_eq!(top.items[0].plays, 43);
    }
    // Plays decay: two months later the game is no longer trending (but still popular).
    cat.refresh_rankings(&mut conn, now + 60 * 86_400_000).unwrap();
    let trending =
        cat.list(&conn, &ListQuery { sort: Some(Sort::Trending), limit: Some(1), ..ListQuery::default() }).unwrap();
    assert_ne!(trending.items[0].id, target.id);
    let popular =
        cat.list(&conn, &ListQuery { sort: Some(Sort::Popular), limit: Some(1), ..ListQuery::default() }).unwrap();
    assert_eq!(popular.items[0].id, target.id);
    let dedup_rows: i64 = conn.query_row("SELECT count(*) FROM game_play_dedup", [], |r| r.get(0)).unwrap();
    assert_eq!(dedup_rows, 0, "expired dedup keys are purged");
}

#[tokio::test]
async fn admin_feature_and_status_overrides() {
    let (cat, db, clock) = setup().await;
    let mut conn = db.lock().unwrap();
    let all = cat.list(&conn, &ListQuery { limit: Some(100), ..ListQuery::default() }).unwrap();
    let pick = all.items[40].clone();
    cat.set_featured(&mut conn, pick.id, true, clock.now_ms()).unwrap();
    assert_eq!(cat.sections(&conn, 24).unwrap().featured[0].id, pick.id);
    let f = cat.list(&conn, &ListQuery { sort: Some(Sort::Featured), limit: Some(1), ..ListQuery::default() }).unwrap();
    assert_eq!(f.items[0].id, pick.id);
    cat.set_featured(&mut conn, pick.id, false, clock.now_ms()).unwrap();
    assert_ne!(cat.sections(&conn, 24).unwrap().featured[0].id, pick.id);
    assert!(matches!(cat.set_featured(&mut conn, 999_999, true, 0), Err(CatalogError::NotFound)));

    cat.set_status(&mut conn, pick.id, Some(AdminStatus::Broken)).unwrap();
    let after = cat.list(&conn, &ListQuery { limit: Some(100), ..ListQuery::default() }).unwrap();
    assert_eq!(after.total, all.total - 1);
    assert!(cat.game(&conn, &pick.slug, 0).unwrap().is_none());
    assert!(cat.by_ids(&conn, &[pick.id]).unwrap().is_empty());
    cat.set_status(&mut conn, pick.id, None).unwrap();
    assert!(cat.game(&conn, &pick.slug, 0).unwrap().is_some());
    let stats = cat.stats(&conn).unwrap();
    assert_eq!(stats.by_source["gamepix"].active, 58);
}

#[tokio::test]
async fn stats_thumbnails_and_embed_hosts() {
    let (cat, db, _clock) = setup().await;
    let conn = db.lock().unwrap();
    let s = cat.stats(&conn).unwrap();
    assert_eq!((s.games, s.listed), (68, 68));
    assert_eq!(s.by_source["gamepix"].total, 58);
    assert_eq!(s.by_source["gamedistribution"].listed, 10);
    assert!(s.by_source["gamepix"].enabled && !s.by_source["playgama"].enabled);
    assert_eq!(s.last_import.as_ref().unwrap().source, "gamedistribution");
    let json = serde_json::to_value(&s).unwrap();
    assert!(json["games"].is_number() && json["by_source"].is_object() && json["last_import"].is_object());
    let id: i64 = conn.query_row("SELECT id FROM games WHERE source = 'gamepix' LIMIT 1", [], |r| r.get(0)).unwrap();
    let url = cat.thumbnail_source(&conn, id).unwrap().unwrap();
    assert!(url.starts_with("https://img.gamepix.com/games/"));
    assert_eq!(cat.thumbnail_source(&conn, 999_999).unwrap(), None);
    assert_eq!(cat.thumb_policy().hosts(), ["img.gamedistribution.com", "img.gamepix.com"]);
    assert_eq!(cat.embed_hosts(&conn).unwrap(), ["html5.gamedistribution.com", "play.gamepix.com"]);
}

#[tokio::test]
async fn config_changes_are_applied_by_prepare() {
    let db = db();
    let clock = ManualClock::new(T0);
    let mut c = config(&[Source::Playgama, Source::GameDistribution]);
    c.playgama.per_page = 10;
    let cat = catalog(c.clone());
    {
        let mut conn = db.lock().unwrap();
        cat.prepare(&mut conn, clock.now_ms()).unwrap();
    }
    let f = FixtureFetcher::new();
    f.route(|r| r.method == gnome_catalog::Method::Post, vec![ok("playgama-p1.json")]);
    cat.import(&f, &clock, &db, Source::Playgama, ImportOptions { limit: Some(10), max_pages: None }).await.unwrap();
    let pvz = "SELECT status FROM games WHERE source_id = '119616'";
    let status = |db: &Mutex<Connection>| -> String { db.lock().unwrap().query_row(pvz, [], |r| r.get(0)).unwrap() };
    assert_eq!(status(&db), "ip_risk");
    // The operator allows the term: prepare() re-maps the stored raw records.
    let mut allowed = c.clone();
    allowed.blocklist.remove("plants vs zombies");
    let cat2 = catalog(allowed);
    let report = cat2.prepare(&mut db.lock().unwrap(), clock.now_ms()).unwrap();
    assert!(report.remapped.unwrap() >= 1, "{report:?}");
    assert_eq!(status(&db), "active");
    assert_eq!(cat2.prepare(&mut db.lock().unwrap(), clock.now_ms()).unwrap().remapped, None, "idempotent");
    // An admin can also clear a false positive directly.
    cat.prepare(&mut db.lock().unwrap(), clock.now_ms()).unwrap();
    assert_eq!(status(&db), "ip_risk");
    let id: i64 =
        db.lock().unwrap().query_row("SELECT id FROM games WHERE source_id = '119616'", [], |r| r.get(0)).unwrap();
    cat.set_status(&mut db.lock().unwrap(), id, Some(AdminStatus::Active)).unwrap();
    assert_eq!(status(&db), "active");
    // Disabling Playgama hides its games without deleting them; re-enabling brings them back.
    let mut gd_only = c.clone();
    gd_only.sources = vec![Source::GameDistribution];
    let cat3 = catalog(gd_only);
    let mut conn = db.lock().unwrap();
    assert!(cat3.prepare(&mut conn, clock.now_ms()).unwrap().listing_changed);
    assert_eq!(cat3.list(&conn, &ListQuery::default()).unwrap().total, 0);
    assert_eq!(cat3.stats(&conn).unwrap().by_source["playgama"].total, 10);
    assert!(cat.prepare(&mut conn, clock.now_ms()).unwrap().listing_changed);
    assert_eq!(cat.list(&conn, &ListQuery::default()).unwrap().total, 10);
}
