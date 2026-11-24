//! The games module's public routes and admin endpoints (WAVE-C §4.2, §4.4, §4.10) on real feed captures.

mod common;

use std::sync::Arc;

use common::games::{self, T0};
use common::*;
use gnome_catalog::ManualClock;
use gnome_server::games::{Games, GamesOptions};
use http::{Method, StatusCode};
use serde_json::{Value, json};

fn ids(v: &Value) -> Vec<i64> {
    v.as_array().unwrap().iter().map(|g| g["id"].as_i64().unwrap()).collect()
}

const SUMMARY_KEYS: [&str; 11] = [
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
    "playable",
];

#[tokio::test]
async fn listing_sections_detail_and_errors() {
    let app = games::app(&[]).await;
    games::import_all(&app).await;
    let runs = app.send_admin(games::admin_get("/admin/catalog/imports")).await.json();
    let status_of = |s: &str| {
        runs["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["source"] == s)
            .map(|r| r["status"].as_str().unwrap().to_string())
    };
    assert_eq!(status_of("gamepix").as_deref(), Some("complete"), "{runs}");
    assert_eq!(status_of("gamedistribution").as_deref(), Some("complete"), "{runs}");
    // The Playgama capture says 2865 games: the second request has no capture, so the run fails with its ten kept.
    assert_eq!(status_of("playgama").as_deref(), Some("failed"), "{runs}");

    let page = app.send(get("/api/games?limit=5")).await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.header("cache-control"), Some("no-store"));
    let page = page.json();
    let total = page["total"].as_u64().unwrap();
    assert!(total >= 40, "{total}");
    let first = &page["items"][0];
    for k in SUMMARY_KEYS {
        assert!(first.get(k).is_some(), "GameSummary.{k}");
    }
    assert_eq!(first.as_object().unwrap().len(), SUMMARY_KEYS.len(), "{first}");
    // Paging through: every game once.
    let mut seen = Vec::new();
    let mut url = "/api/games?limit=7".to_string();
    loop {
        let p = app.send(get(&url)).await.json();
        seen.extend(ids(&p["items"]));
        match p["next_cursor"].as_str() {
            Some(c) => url = format!("/api/games?limit=7&cursor={c}"),
            None => break,
        }
    }
    assert_eq!(seen.len() as u64, total);
    // The 400 messages (D10).
    for (q, msg) in [
        ("limit=0", "limit must be 1-100"),
        ("limit=x", "limit must be 1-100"),
        ("category=girls", "unknown category: girls"),
        ("sort=random", "unknown sort: random"),
        ("cursor=nope", "invalid cursor"),
        ("mobile=2", "mobile must be 0 or 1"),
    ] {
        let res = app.send(get(&format!("/api/games?{q}"))).await;
        assert_eq!((res.status, res.error_code()), (StatusCode::BAD_REQUEST, "bad_request".into()), "{q}");
        assert_eq!(res.json()["error"]["message"], msg, "{q}");
    }
    let q = format!("q={}", "x".repeat(101));
    assert_eq!(
        app.send(get(&format!("/api/games?{q}"))).await.json()["error"]["message"],
        "q is limited to 100 characters"
    );
    let many = (0..21).map(|i| format!("c{i}")).collect::<Vec<_>>().join(",");
    let res = app.send(get(&format!("/api/games?exclude={many}"))).await.json();
    assert_eq!(res["error"]["message"], "at most 20 categories can be excluded");
    let res = app.send(get("/api/games/by-ids?ids=1,x")).await.json();
    assert_eq!(res["error"]["message"], "ids must be comma-separated integers");
    let ids201 = (1..=201).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let res = app.send(get(&format!("/api/games/by-ids?ids={ids201}"))).await.json();
    assert_eq!(res["error"]["message"], "at most 200 ids");
    let res = app.send(get(&format!("/api/games/tags?prefix={}", "a".repeat(41)))).await.json();
    assert_eq!(res["error"]["message"], "tag prefix is limited to 40 characters");
    // Cursor binding: changed exclusions → 400; unknown exclusions ignored (same items and cursor).
    let base = app.send(get("/api/games?limit=5&exclude=strategy")).await.json();
    let same = app.send(get("/api/games?limit=5&exclude=strategy,no-such-category")).await.json();
    assert_eq!(base, same);
    let cursor = base["next_cursor"].as_str().unwrap();
    let res = app.send(get(&format!("/api/games?limit=5&cursor={cursor}"))).await.json();
    assert_eq!(res["error"]["message"], "cursor does not belong to this query");
    let res = app.send(get(&format!("/api/games?limit=5&exclude=strategy&mobile=1&cursor={cursor}"))).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // Sections, categories, tags, by-ids, status.
    let s = app.send(get("/api/games/sections?exclude=strategy")).await.json();
    for k in ["featured", "trending", "popular", "new"] {
        assert!(s[k].as_array().unwrap().len() <= 24, "{k}");
    }
    assert!(!s["featured"].as_array().unwrap().is_empty());
    let cats = app.send(get("/api/games/categories")).await.json();
    assert!(cats["categories"].as_array().unwrap().len() >= 14);
    let tags = app.send(get("/api/games/tags?limit=3")).await.json();
    assert!(tags["tags"].as_array().unwrap().len() <= 3);
    let some = ids(&page["items"]);
    let by = app.send(get(&format!("/api/games/by-ids?ids={},999999,{}", some[1], some[0]))).await.json();
    assert_eq!(ids(&by["items"]), [some[1], some[0]], "order kept, unknown omitted");
    let st = app.send(get("/api/games/status")).await.json();
    assert_eq!(st["listed"].as_u64().unwrap(), total);
    assert_eq!(st["playable"].as_u64().unwrap(), total, "every source here is playable");
    assert_eq!(st["importing"], false);
    let sources = st["sources"].as_array().unwrap();
    assert_eq!(sources[0]["id"], "gamepix");
    assert_eq!(sources[0]["name"], "GamePix");
    assert_eq!(sources[0]["last_import"]["status"], "complete");
    assert!(sources[0]["last_import"]["finished_at"].is_i64());
    assert!(st.to_string().find("http").is_none(), "no URLs or error texts: {st}");

    // Detail: the crate's detail + embed_allowed + oss; related.
    let slug = first["slug"].as_str().unwrap();
    let d = app.send(get(&format!("/api/games/{slug}"))).await.json();
    assert!(d["game"]["embed_allowed"].is_boolean() && d["game"].get("oss").is_some());
    assert!(d["game"]["oss"].is_null());
    assert!(d["related"].as_array().unwrap().len() <= 12);
    for k in ["description", "instructions", "tags", "embed_url", "attribution", "embed_kind", "flags"] {
        assert!(d["game"].get(k).is_some(), "GameDetail.{k}");
    }
    assert_eq!(app.send(get("/api/games/no-such-game")).await.status, StatusCode::NOT_FOUND);
    // GameDistribution's referrer is the page the visitor sees (D2).
    let gd = app.send(get("/api/games?limit=100")).await.json();
    let gd_slug = gd["items"].as_array().unwrap().iter().find(|g| g["source"] == "gamedistribution").unwrap()["slug"]
        .as_str()
        .unwrap()
        .to_string();
    let d = app.send(get(&format!("/api/games/{gd_slug}"))).await.json();
    let embed = d["game"]["embed_url"].as_str().unwrap();
    assert!(embed.contains(&format!("gd_sdk_referrer_url=http%3A%2F%2Fgnome.test%2Fplay%2F{gd_slug}")), "{embed}");

    // Admin overrides: hidden → 404 and gone from listings; featured first.
    let id = first["id"].as_i64().unwrap();
    let hide = games::admin_post(&format!("/admin/games/{id}/status"), &json!({"status": "hidden"}));
    assert_eq!(app.send_admin(hide).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.send(get(&format!("/api/games/{slug}"))).await.status, StatusCode::NOT_FOUND);
    let bad = games::admin_post(&format!("/admin/games/{id}/status"), &json!({"status": "gone"}));
    let res = app.send_admin(bad).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.json()["error"]["fields"]["status"].is_string());
    let clear = games::admin_post(&format!("/admin/games/{id}/status"), &json!({"status": null}));
    assert_eq!(app.send_admin(clear).await.status, StatusCode::NO_CONTENT);
    assert_eq!(app.send(get(&format!("/api/games/{slug}"))).await.status, StatusCode::OK);
    let feat = games::admin_post(&format!("/admin/games/{}/feature", some[3]), &json!({"featured": true}));
    assert_eq!(app.send_admin(feat).await.status, StatusCode::NO_CONTENT);
    let s = app.send(get("/api/games/sections")).await.json();
    assert_eq!(s["featured"][0]["id"].as_i64(), Some(some[3]));
    let none = games::admin_post("/admin/games/999999/feature", &json!({"featured": true}));
    assert_eq!(app.send_admin(none).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn play_counter_dedups_per_session_and_ip() {
    let app = games::app(&[]).await;
    games::import_all(&app).await;
    let slug = app.send(get("/api/games?limit=1")).await.json()["items"][0]["slug"].as_str().unwrap().to_string();
    let path = format!("/api/games/{slug}/play");
    let play = |c: &str| req(Method::POST, &path).header(http::header::ORIGIN, ORIGIN).header("cookie", c.to_string());
    let send = |r: http::request::Builder| app.send(r.body(axum::body::Body::empty()).unwrap());
    assert_eq!(send(play("")).await.status, StatusCode::NO_CONTENT);
    assert_eq!(send(play("")).await.status, StatusCode::NO_CONTENT, "a duplicate within the hour");
    let games = app.state.ext::<Games>().unwrap();
    assert_eq!(games.counters.plays.load(std::sync::atomic::Ordering::Relaxed), 1);
    // Another client IP counts again.
    let other =
        send_to(&app.public, play("").body(axum::body::Body::empty()).unwrap(), "198.51.100.7:4000".parse().unwrap())
            .await;
    assert_eq!(other.status, StatusCode::NO_CONTENT);
    assert_eq!(games.counters.plays.load(std::sync::atomic::Ordering::Relaxed), 2);
    // Without the CSRF header: 403.
    let no_csrf = http::Request::builder()
        .method(Method::POST)
        .uri(&path)
        .header(http::header::HOST, HOST)
        .body(axum::body::Body::empty())
        .unwrap();
    assert_eq!(app.send(no_csrf).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        send(req(Method::POST, "/api/games/no-such-game/play").header(http::header::ORIGIN, ORIGIN)).await.status,
        StatusCode::NOT_FOUND
    );
    // A dedup row older than two hours is gone after the rankings job.
    let n = |app: &TestApp| {
        let conn = rusqlite::Connection::open(app.state.config.db_path()).unwrap();
        conn.query_row("SELECT count(*) FROM game_play_dedup", [], |r| r.get::<_, i64>(0)).unwrap()
    };
    assert!(n(&app) >= 1);
    let cat = games.catalog.clone();
    let later = T0 + 3 * 3_600_000;
    gnome_catalog::WriteDb::write(&app.state.db, move |c| cat.refresh_rankings(c, later)).await.unwrap();
    assert_eq!(n(&app), 0);
}

#[tokio::test]
async fn availability_flags_and_admin_conflicts() {
    // Before prepare: 503 with Retry-After (an open_with without prepare_modules).
    let dir = tempfile::tempdir().unwrap();
    let vars: std::collections::HashMap<String, String> = games::vars(&[])
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .chain([
            ("GNOME_DATA_DIR".to_string(), dir.path().join("d").display().to_string()),
            ("GNOME_STATIC_DIR".to_string(), dir.path().join("s").display().to_string()),
        ])
        .collect();
    let config = gnome_server::config::Config::from_lookup(|k| vars.get(k).cloned(), None).unwrap();
    let state = gnome_server::AppState::open_with(config, gnome_server::module::builtin_modules).await.unwrap();
    let router = gnome_server::router::public(&state);
    let res = send_to(&router, get("/api/games"), "203.0.113.1:1".parse().unwrap()).await;
    assert_eq!((res.status, res.header("retry-after")), (StatusCode::SERVICE_UNAVAILABLE, Some("30")));
    let res = send_to(&router, get("/play-frame/x"), "203.0.113.1:1".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    let cfg = send_to(&router, get("/api/config"), "203.0.113.1:1".parse().unwrap()).await.json();
    assert_eq!(cfg["features"]["games"], false);
    state.prepare_modules().await;
    let cfg = send_to(&router, get("/api/config"), "203.0.113.1:1".parse().unwrap()).await.json();
    assert_eq!((cfg["features"]["games"].clone(), cfg["features"]["thumb_proxy"].clone()), (json!(true), json!(true)));
    let games = state.ext::<Games>().unwrap();
    // A failed prepare also answers 503 (and features.games is false).
    *games.prepared.write().unwrap() = Some(Err("disk on fire".into()));
    let res = send_to(&router, get("/api/games/sections"), "203.0.113.1:1".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);

    // No catalog: the routes do not exist.
    let none = TestApp::new(&[("GNOME_CATALOG_SOURCES", "none")]).await;
    assert_eq!(none.send(get("/api/games")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(none.send(get("/play-frame/x")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(none.send(get("/api/config")).await.json()["features"]["games"], false);

    // Admin: 422 for unknown and disabled sources and bad limits; 409 while a run is going.
    let app = games::app(&[]).await;
    let post = |b: Value| games::admin_post("/admin/catalog/import", &b);
    let res = app.send_admin(post(json!({"sources": ["nope"]}))).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.json()["error"]["fields"]["sources"], "unknown source nope");
    let res = app.send_admin(post(json!({"sources": ["itchio"]}))).await.json();
    assert_eq!(res["error"]["fields"]["sources"], "itchio is not enabled");
    let res = app.send_admin(post(json!({"limit": 0}))).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let g = app.state.ext::<Games>().unwrap();
    assert!(g.begin_import(gnome_catalog::Source::GamePix));
    let res = app.send_admin(post(json!({"sources": ["gamepix"]}))).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.json()["error"]["message"], "an import of gamepix is already running");
    g.end_import(gnome_catalog::Source::GamePix);
    let res = app.send_admin(post(json!({"sources": ["gamepix"], "limit": 5}))).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json(), json!({"job": "catalog.import", "sources": ["gamepix"]}));
    games::settle(&app).await;
    let runs = app.send_admin(games::admin_get("/admin/catalog/imports?source=gamepix&limit=1")).await.json();
    assert_eq!(runs["runs"][0]["limited"], true);
    assert_eq!(runs["runs"][0]["complete"], false);

    // Diagnostics and metrics.
    let d = app.send_admin(games::admin_get("/admin/diagnostics")).await.json();
    for k in ["prepared", "error", "embed_hosts", "thumbs", "oss"] {
        assert!(d["games"].get(k).is_some(), "games.{k}: {}", d["games"]);
    }
    assert_eq!(d["games"]["prepared"], true);
    assert!(d["catalog"]["by_source"]["gamepix"]["listed"].as_i64().unwrap() > 0);
    for k in
        ["catalog_sources", "thumb_proxy", "games_embed_hosts", "oss_fetch", "vpn_check_url", "vpn_check_interval_min"]
    {
        assert!(d["config"].get(k).is_some(), "config.{k}");
    }
    assert_eq!(d["config"]["oss_fetch"], "manual", "the test harness default");
    let m = app.send_admin(games::admin_get("/admin/metrics")).await.text();
    for line in [
        "gnome_catalog_games{source=\"gamepix\",state=\"listed\"}",
        "gnome_catalog_import_runs_total{source=\"gamepix\",status=\"incomplete\"} 1",
        "gnome_game_plays_total 0",
        "gnome_games_embed_hosts{state=\"fixed\"} 3",
        "gnome_thumb_requests_total{result=\"hit\"} 0",
        "gnome_thumb_cache_bytes 0",
        "gnome_oss_builds{state=\"served\"} 0",
    ] {
        assert!(m.contains(line), "{line} missing in\n{m}");
    }
}

#[tokio::test]
async fn a_server_with_the_test_defaults_imports_nothing() {
    // GNOME_CATALOG_REFRESH_HOURS=0 + GNOME_OSS_FETCH=manual (the harness defaults): the jobs' feed imports are off.
    let app = games::app_with(
        &games::vars(&[]),
        |_| {},
        GamesOptions { clock: Some(Arc::new(ManualClock::new(T0))), ..GamesOptions::default() },
    )
    .await;
    app.state.start_jobs();
    app.state.jobs.trigger(gnome_server::games::IMPORT_JOB);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    games::settle(&app).await;
    let runs = app.send_admin(games::admin_get("/admin/catalog/imports")).await.json();
    assert_eq!(runs["runs"], json!([]), "no feed import with GNOME_CATALOG_REFRESH_HOURS=0: {runs}");
    let names: Vec<String> = app
        .state
        .jobs
        .snapshot()
        .iter()
        .map(|j| serde_json::to_value(j).unwrap()["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!names.iter().any(|n| n == gnome_server::games::OSS_FETCH_JOB), "{names:?}");
    app.state.shutdown.cancel();
}
