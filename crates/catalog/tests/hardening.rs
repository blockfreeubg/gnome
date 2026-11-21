//! Regression tests from the independent review (2026-11-11): hostile feed input, refused records, slug
//! collisions, cursors over long non-Latin titles, runaway feeds, FTS consistency and re-import idempotency.
//!
//! Hostile records are real captured GamePix / GameDistribution records with single fields replaced, so every
//! other field keeps the live shape.

mod common;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use common::*;
use gnome_catalog::text::{clean_block, clean_line};
use gnome_catalog::{FixtureFetcher, FixtureResponse, ImportOptions, ListQuery, ManualClock, Sort, Source};
use serde_json::{Value, json};

/// The 12 real items of the captured GamePix page.
fn gamepix_items() -> Vec<Value> {
    let feed: Value = serde_json::from_slice(&fixture("gamepix-p1.json")).unwrap();
    feed["items"].as_array().unwrap().clone()
}

/// A GamePix feed page holding `items`; `next` = number of the next page (`None`: last page).
fn gamepix_page(items: &[Value], next: Option<u32>) -> FixtureResponse {
    let mut feed = json!({
        "version": "https://jsonfeed.org/version/1.1",
        "title": "My GamePix Games",
        "items": items,
    });
    if let Some(n) = next {
        feed["next_url"] =
            json!(format!("https://feeds.gamepix.com/v2/json/?order=quality&page={n}&pagination=12&sid=1"));
    }
    FixtureResponse::ok(serde_json::to_vec(&feed).unwrap())
}

/// Answer GamePix page `n` (URLs end with `&page=N` when no category is configured).
fn on_page(f: &FixtureFetcher, n: u32, resp: FixtureResponse) {
    let suffix = format!("&page={n}");
    f.route(move |r| r.url.starts_with("https://feeds.gamepix.com/") && r.url.ends_with(&suffix), vec![resp]);
}

/// GamePix with 12 items per page and no category filter.
fn gamepix12() -> gnome_catalog::Catalog {
    let mut c = config(&[Source::GamePix]);
    c.gamepix.per_page = 12;
    catalog(c)
}

/// Real item `i` with a new id (and the given field overrides).
fn variant(base: &Value, id: &str, set: &[(&str, Value)]) -> Value {
    let mut v = base.clone();
    v["id"] = json!(id);
    for (k, val) in set {
        v[*k] = val.clone();
    }
    v
}

fn no_markup(s: &str) {
    let lower = s.to_ascii_lowercase();
    for bad in ["<script", "<img", "<svg", "<iframe", "<details", "<x ", "onerror=", "ontoggle=", "onclick=", "</"] {
        assert!(!lower.contains(bad), "markup {bad:?} survived in {s:?}");
    }
}

#[test]
fn hostile_markup_never_survives_cleaning() {
    let cases = [
        // Double-escaped markup (GameMonetize double-escapes): stripped after the second decoding too.
        ("&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;Hi", "Hi"),
        ("&amp;lt;img src=x onerror=alert(1)&amp;gt;Hi", "Hi"),
        // Removed characters cannot split a tag name and later join it back together.
        ("<scr\u{0}ipt>alert(1)</scr\u{0}ipt>Hi", "Hi"),
        ("<scr\u{200b}ipt>alert(1)</script>Hi", "Hi"),
        ("<scr&#8203;ipt>alert(1)</script>Hi", "Hi"),
        ("<i\u{202e}mg src=x onerror=alert(1)>Hi", "Hi"),
        // Unknown element names are markup when they carry attributes; closing tags are always markup.
        ("<details open ontoggle=alert(1)>Hi</details>", "Hi"),
        ("<x onclick=alert(1)>Hi</x>", "Hi"),
        ("<svg/onload=alert(1)>Hi", "Hi"),
        ("<a href=\"javascript:alert(1)\">Hi</a>", "Hi"),
        ("<SCRIPT>alert(1)</SCRIPT >Hi", "Hi"),
        ("<script>a</scriptx>b</script>Hi", "Hi"),
    ];
    for (input, want) in cases {
        let got = clean_line(input, 200);
        no_markup(&got);
        assert_eq!(got, want, "{input:?}");
        no_markup(&clean_block(input, 200));
    }
    // Plain text in angle brackets stays.
    assert_eq!(
        clean_line("Press <Space> to jump, <Left Arrow> to move", 100),
        "Press <Space> to jump, <Left Arrow> to move"
    );
    assert_eq!(clean_line("I <3 it &amp;lt;3", 100), "I <3 it <3");
    assert_eq!(clean_line("a < b and b > c", 100), "a < b and b > c");
}

#[test]
fn invisible_and_stacked_characters_are_removed() {
    // Arabic letter mark (a bidi control), Hangul fillers and other blank "letters", tag characters.
    assert_eq!(clean_line("A\u{61c}B \u{3164}\u{115f}\u{1160}\u{ffa0}\u{2800}C\u{e0041}", 100), "AB C");
    assert_eq!(clean_line("\u{3164}\u{3164}", 100), "", "a title of fillers is empty (and rejected)");
    // "Zalgo": runs of combining marks are capped; normal accents are kept.
    let zalgo = format!("Z{}algo", "\u{0301}\u{0316}\u{0337}".repeat(20));
    let cleaned = clean_line(&zalgo, 200);
    assert!(cleaned.chars().count() <= 10, "{cleaned:?}");
    assert_eq!(clean_line("Pokémon Ünïcode Tiếng Việt", 100), "Pokémon Ünïcode Tiếng Việt");
    assert_eq!(clean_line("Tie\u{0302}\u{0301}ng", 100), "Tie\u{0302}\u{0301}ng", "two stacked marks are normal");
}

#[test]
fn cleaning_is_linear_on_hostile_input() {
    // Each of these was quadratic or allocation-heavy before the review (seconds to minutes).
    let inputs = [
        "<script></script>x".repeat(25_000),
        "<style>".repeat(60_000),
        "<a ".repeat(100_000),
        "<x a=1 ".repeat(60_000),
        "<!--".repeat(100_000),
        "&amp;lt;b&amp;gt;".repeat(25_000),
        format!("<{}", "a".repeat(400_000)),
        "</".repeat(150_000),
    ];
    for input in &inputs {
        let t = Instant::now();
        let out = clean_block(input, 5000);
        let line = clean_line(input, 120);
        assert!(t.elapsed() < Duration::from_secs(3), "{} bytes took {:?}", input.len(), t.elapsed());
        assert!(out.chars().count() <= 5000 && line.chars().count() <= 120);
    }
}

#[tokio::test]
async fn odd_records_are_rejected_alone_and_never_fail_the_page() {
    let items = gamepix_items();
    let page = vec![
        // Sizes outside the schema's range are unknown, not errors.
        variant(&items[0], "WIDE01", &[("width", json!(20000)), ("height", json!(0))]),
        variant(&items[1], "TALL01", &[("height", json!(4_000_000_000u64))]),
        // A title that cleans to nothing is rejected (counted), the rest of the page is stored.
        variant(&items[2], "BLANK1", &[("title", json!("\u{3164}<b></b>"))]),
        items[3].clone(),
    ];
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&page, None));
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.status.as_str(), r.inserted, r.rejected), ("complete", 3, 1), "{r:?}");
    let sizes: Vec<(Option<i64>, Option<i64>)> = db
        .lock()
        .unwrap()
        .prepare("SELECT width, height FROM games WHERE source_id IN ('WIDE01', 'TALL01') ORDER BY source_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(sizes, [(items[1]["width"].as_i64(), None), (None, None)]);
}

#[tokio::test]
async fn slug_collisions_stay_unique_valid_and_reachable() {
    // 60 records whose source slug folds to the same maximal base: numbered suffixes, then hashed ones.
    let base = items_with_same_slug(60);
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&base, None));
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.inserted, r.rejected), (60, 0), "{r:?}");
    let conn = db.lock().unwrap();
    let slugs: Vec<String> = conn
        .prepare("SELECT slug FROM games")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(slugs.iter().collect::<HashSet<_>>().len(), 60);
    for s in &slugs {
        assert!(gnome_catalog::slug::is_valid_slug(s), "{s}");
        assert!(cat.game(&conn, s, 0).unwrap().is_some(), "game {s} is unreachable");
    }
}

fn items_with_same_slug(n: usize) -> Vec<Value> {
    let items = gamepix_items();
    // Folds to a base of exactly the maximum slug length, so hashed suffixes give the longest stored slugs.
    let long = "a".repeat(85);
    (0..n).map(|i| variant(&items[i % items.len()], &format!("SL{i:03}"), &[("namespace", json!(long))])).collect()
}

#[tokio::test]
async fn az_paging_over_long_non_latin_titles_visits_every_game_once() {
    // 120-character titles of 3- and 4-byte characters (folded sort keys far above the cursor's key budget)
    // that share a long prefix and differ only at the end.
    let items = gamepix_items();
    let mut page = Vec::new();
    for i in 0..30 {
        let title: String = format!("{}", (b'a' + i as u8) as char) + &"游戏🎮".repeat(59);
        page.push(variant(&items[i % items.len()], &format!("LT{i:03}"), &[("title", json!(title))]));
    }
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&page, None));
    assert_eq!(cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap().inserted, 30);
    let conn = db.lock().unwrap();
    let mut q = ListQuery { sort: Some(Sort::Az), limit: Some(7), ..ListQuery::default() };
    let mut seen = Vec::new();
    for _ in 0..20 {
        let p = cat.list(&conn, &q).unwrap();
        seen.extend(p.items.iter().map(|g| g.id));
        match p.next_cursor {
            Some(c) => q.cursor = Some(c),
            None => break,
        }
    }
    assert_eq!(seen.len(), 30, "{seen:?}");
    assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 30);
}

#[tokio::test]
async fn a_feed_that_repeats_its_pages_forever_is_stopped() {
    // The feed ignores `page` and always answers with the same 12 games and a `next_url`.
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    for n in 1..=60u32 {
        on_page(&f, n, gamepix_page(&gamepix_items(), Some(n + 1)));
    }
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert!(!r.complete, "{r:?}");
    assert!(f.requests().len() <= 6, "{} requests", f.requests().len());
    assert!(r.note.as_deref().unwrap_or_default().contains("repeat") || r.error.is_some(), "{r:?}");
    assert_eq!(count(&db, "SELECT count(*) FROM games"), 12);
}

#[tokio::test]
async fn fts_index_stays_consistent_through_updates_renames_and_deletes() {
    let items = gamepix_items();
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&items, None));
    cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    // Second sync: two games renamed, one with a new description.
    let mut changed = items.clone();
    changed[0]["title"] = json!("Zyxwv Renamed Cube");
    changed[1]["title"] = json!("Qwertz Renamed Sorter");
    changed[2]["description"] = json!("Now about xylophones.");
    clock.advance(Duration::from_secs(86_400));
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&changed, None));
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.updated, r.unchanged), (3, 9), "{r:?}");
    let conn = db.lock().unwrap();
    let integrity = |c: &rusqlite::Connection| {
        c.execute("INSERT INTO games_fts (games_fts, rank) VALUES ('integrity-check', 1)", []).unwrap();
    };
    integrity(&conn);
    let hits = |q: &str| cat.list(&conn, &ListQuery { q: Some(q.into()), ..ListQuery::default() }).unwrap().total;
    assert_eq!((hits("zyxwv"), hits("qwertz"), hits("xylophones")), (1, 1, 1));
    let in_titles = |w: &str| -> i64 {
        conn.query_row("SELECT count(*) FROM games_fts WHERE games_fts MATCH ?1", [format!("title : {w}")], |r| {
            r.get(0)
        })
        .unwrap()
    };
    assert_eq!(in_titles("prism"), 0, "the old title is gone from the index");
    // Deleting rows (e.g. an operator purging a source) removes them from the index too.
    conn.execute("DELETE FROM games WHERE source_id IN (?1, ?2)", [items[0]["id"].as_str(), items[1]["id"].as_str()])
        .unwrap();
    integrity(&conn);
    assert_eq!((hits("zyxwv"), hits("qwertz")), (0, 0));
}

#[tokio::test]
async fn reimport_is_idempotent() {
    let items = gamepix_items();
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let snapshot = |db: &std::sync::Mutex<rusqlite::Connection>| -> Vec<(String, String, String, String)> {
        db.lock()
            .unwrap()
            .prepare("SELECT source_id, slug, text_hash, meta_hash FROM games ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    let mut before = None;
    for round in 0..3 {
        let f = FixtureFetcher::new();
        on_page(&f, 1, gamepix_page(&items, Some(2)));
        on_page(&f, 2, gamepix_page(&items[..5], None));
        let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
        assert!(r.complete, "{r:?}");
        assert_eq!(r.seen, 12);
        if round > 0 {
            assert_eq!((r.inserted, r.updated), (0, 0), "{r:?}");
        }
        let snap = snapshot(&db);
        assert_eq!(snap.len(), 12);
        if let Some(b) = &before {
            assert_eq!(b, &snap);
        }
        before = Some(snap);
        assert_eq!(count(&db, "SELECT count(*) FROM game_raw"), 12);
        assert_eq!(
            count(&db, "SELECT count(*) FROM game_categories"),
            count(&db, "SELECT sum(json_array_length(categories)) FROM games")
        );
        clock.advance(Duration::from_secs(86_400));
    }
}

#[tokio::test]
async fn tags_with_multibyte_characters_are_filterable() {
    let mut items: Vec<Value> = serde_json::from_slice(&fixture("gamedistribution-p1.json")).unwrap();
    // 30 characters, 60 bytes: within the 40-character tag limit.
    items[0]["Tag"] = json!(["ж".repeat(30)]);
    let cat = gd10();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    f.on_url(&["page=1&"], vec![FixtureResponse::ok(serde_json::to_vec(&items).unwrap())]);
    f.on_url(&["page=2&"], vec![ok("gamedistribution-end.json")]);
    cat.import(&f, &clock, &db, Source::GameDistribution, ImportOptions::default()).await.unwrap();
    let conn = db.lock().unwrap();
    let p = cat.list(&conn, &ListQuery { tag: Some("ж".repeat(30)), ..ListQuery::default() }).unwrap();
    assert_eq!(p.items.len(), 1);
}

/// Keys and JSON types of every response against `docs/API.md` ("Games catalog"), plus the documented additive
/// fields.
#[tokio::test]
async fn response_shapes_match_api_md() {
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let f = FixtureFetcher::new();
    on_page(&f, 1, gamepix_page(&gamepix_items(), None));
    cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    let conn = db.lock().unwrap();
    let keys = |v: &Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    let sorted = |k: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = k.iter().map(|s| (*s).to_owned()).collect();
        v.sort();
        v
    };
    let summary_keys =
        ["id", "slug", "title", "developer", "thumbnail", "categories", "mobile", "source", "added_at", "plays"];
    let check_summary = |g: &Value| {
        assert_eq!(keys(g), sorted(&[&summary_keys[..], &["playable"]].concat()), "GameSummary (+ playable)");
        assert!(g["id"].is_i64() && g["slug"].is_string() && g["title"].is_string());
        assert!(g["developer"].is_null() || g["developer"].is_string());
        assert!(g["thumbnail"].as_str().is_some_and(|t| t.starts_with("/api/thumb/")), "thumbnail proxy on");
        assert!(g["categories"].as_array().is_some_and(|c| !c.is_empty() && c.iter().all(Value::is_string)));
        assert!(g["mobile"].is_boolean() && g["source"] == "gamepix" && g["added_at"].is_i64() && g["plays"].is_i64());
    };
    let page =
        serde_json::to_value(cat.list(&conn, &ListQuery { limit: Some(5), ..ListQuery::default() }).unwrap()).unwrap();
    assert_eq!(keys(&page), sorted(&["items", "next_cursor", "total"]));
    assert!(page["next_cursor"].is_string() && page["total"] == 12);
    page["items"].as_array().unwrap().iter().for_each(check_summary);
    let sections = serde_json::to_value(cat.sections(&conn, 24).unwrap()).unwrap();
    assert_eq!(keys(&sections), sorted(&["featured", "trending", "popular", "new"]));
    let cats = serde_json::to_value(cat.categories(&conn, false).unwrap()).unwrap();
    assert!(cats.as_array().unwrap().iter().all(|c| keys(c) == sorted(&["slug", "name", "count"])));
    let slug = page["items"][0]["slug"].as_str().unwrap().to_owned();
    let detail = serde_json::to_value(cat.game(&conn, &slug, 4).unwrap().unwrap()).unwrap();
    assert_eq!(keys(&detail), sorted(&["game", "related"]));
    let detail_keys = [
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
    ];
    let additive = ["playable", "embed_kind", "orientation", "flags"];
    assert_eq!(keys(&detail["game"]), sorted(&[&summary_keys[..], &detail_keys[..], &additive[..]].concat()));
    assert!(detail["game"]["embed_url"].as_str().unwrap().starts_with("https://play.gamepix.com/"));
    detail["related"].as_array().unwrap().iter().for_each(check_summary);
    let ids: Vec<i64> = page["items"].as_array().unwrap().iter().map(|g| g["id"].as_i64().unwrap()).rev().collect();
    let by_ids = cat.by_ids(&conn, &ids).unwrap();
    assert_eq!(by_ids.iter().map(|g| g.id).collect::<Vec<_>>(), ids, "order preserved");
}

/// A fetcher that answers from a [`FixtureFetcher`] after a variable latency on a virtual clock, recording when each
/// request was sent.
struct SlowFetcher<'a> {
    inner: FixtureFetcher,
    clock: &'a ManualClock,
    sent: std::sync::Mutex<Vec<i64>>,
}

impl gnome_catalog::Fetcher for SlowFetcher<'_> {
    fn fetch(
        &self,
        request: gnome_catalog::FetchRequest,
    ) -> gnome_catalog::BoxFuture<'_, Result<gnome_catalog::FetchResponse, gnome_catalog::FetchError>> {
        use gnome_catalog::Clock;
        let mut sent = self.sent.lock().unwrap();
        sent.push(self.clock.now_ms());
        // 50 ms … 1.65 s: shorter and longer than the source's interval.
        self.clock.advance(Duration::from_millis(50 + (sent.len() as u64 * 377) % 1600));
        drop(sent);
        self.inner.fetch(request)
    }
}

#[tokio::test]
async fn requests_start_at_least_the_source_interval_apart_whatever_the_latency() {
    let items = gamepix_items();
    let cat = gamepix12();
    let db = db();
    let clock = ManualClock::new(T0);
    let inner = FixtureFetcher::new();
    for n in 1..=8u32 {
        let page: Vec<Value> =
            items.iter().map(|it| variant(it, &format!("{}{n}", it["id"].as_str().unwrap()), &[])).collect();
        on_page(&inner, n, gamepix_page(&page, (n < 8).then_some(n + 1)));
    }
    let f = SlowFetcher { inner, clock: &clock, sent: std::sync::Mutex::new(Vec::new()) };
    let r = cat.import(&f, &clock, &db, Source::GamePix, ImportOptions::default()).await.unwrap();
    assert_eq!((r.complete, r.pages, r.inserted), (true, 8, 96), "{r:?}");
    let sent = f.sent.lock().unwrap().clone();
    let min_gap = sent.windows(2).map(|w| w[1] - w[0]).min().unwrap();
    assert!(min_gap >= Source::GamePix.min_interval().as_millis() as i64, "gaps {sent:?}");
}

/// Migration 101 adds the search index to a database that already applied version 100 (the shape of databases
/// created before the review), and the catalog's counts work on it.
#[test]
fn migration_101_upgrades_a_version_100_database() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let ms = gnome_catalog::MIGRATIONS;
    assert_eq!(ms.iter().map(|m| m.version).collect::<Vec<_>>(), [100, 101]);
    conn.execute_batch(ms[0].sql).unwrap();
    let has_index = |c: &rusqlite::Connection| -> i64 {
        c.query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'games_listed_search'", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(has_index(&conn), 0);
    conn.execute_batch(ms[1].sql).unwrap();
    assert_eq!(has_index(&conn), 1);
    let cat = gamepix12();
    let q = ListQuery { q: Some("chess".into()), ..ListQuery::default() };
    conn.execute("INSERT INTO catalog_facets VALUES ('all', '', 0, 0, 0, 0)", []).unwrap();
    assert_eq!(cat.list(&conn, &q).unwrap().total, 0);
}
