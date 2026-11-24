//! `/api/thumb/:id` and the thumbnail cache (WAVE-C D7, §4.7) with generated images behind a fixture fetcher.

mod common;

use std::sync::Arc;

use common::games::{self, T0};
use common::*;
use gnome_catalog::{FixtureFetcher, FixtureResponse, ManualClock};
use gnome_server::games::GamesOptions;
use http::StatusCode;
use serde_json::Value;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR tiny png";
const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];

fn image(body: &[u8], content_type: &str) -> FixtureResponse {
    FixtureResponse { status: 200, headers: vec![("content-type".into(), content_type.into())], body: body.to_vec() }
}

fn status(code: u16) -> FixtureResponse {
    FixtureResponse { status: code, headers: Vec::new(), body: Vec::new() }
}

struct Setup {
    app: TestApp,
    thumbs: Arc<FixtureFetcher>,
    games: Vec<Value>,
}

/// GamePix only (its thumbnails are on img.gamepix.com); every thumbnail URL answered by `answer(i)` in order.
async fn setup(extra: &[(&str, &str)], answers: Vec<FixtureResponse>) -> Setup {
    let thumbs = Arc::new(FixtureFetcher::new());
    for a in answers {
        thumbs.on_url(&["img.gamepix.com"], vec![a]);
    }
    let mut vars = vec![("GNOME_CATALOG_SOURCES", "gamepix")];
    vars.extend_from_slice(extra);
    let options = GamesOptions {
        fetcher: Some(Arc::new(games::feeds())),
        thumb_fetcher: Some(thumbs.clone()),
        clock: Some(Arc::new(ManualClock::new(T0))),
        ..GamesOptions::default()
    };
    let app = games::app_with(&vars, |_| {}, options).await;
    games::import_all(&app).await;
    let games = app.send(get("/api/games?limit=100")).await.json()["items"].as_array().unwrap().clone();
    assert!(games.iter().all(|g| g["thumbnail"].as_str().unwrap().starts_with("/api/thumb/")));
    Setup { app, thumbs, games }
}

fn thumb_of(s: &Setup, i: usize) -> String {
    s.games[i]["thumbnail"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn hits_misses_304_and_exact_headers() {
    let mut cc = image(PNG, "image/png");
    cc.headers.push(("cache-control".into(), "public, max-age=3600".into()));
    let s = setup(&[], vec![cc, image(JPEG, "image/png")]).await;
    let url = thumb_of(&s, 0);
    let miss = s.app.send(get(&url)).await;
    assert_eq!(miss.status, StatusCode::OK);
    assert_eq!(&miss.body[..], PNG);
    assert_eq!(miss.header("content-type"), Some("image/png"));
    assert_eq!(miss.header("cache-control"), Some("public, max-age=3600"));
    assert_eq!(miss.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(miss.header("content-security-policy"), Some("default-src 'none'; frame-ancestors 'none'"));
    assert_eq!(miss.header("cross-origin-resource-policy"), Some("same-origin"));
    let etag = miss.header("etag").unwrap().to_string();
    assert!(etag.starts_with('"') && etag.len() == 66, "{etag}");
    let accept = s.thumbs.requests()[0].header("accept").unwrap().to_string();
    assert_eq!(accept, "image/avif,image/webp,image/png,image/jpeg,image/gif");
    let hit = s.app.send(get(&url)).await;
    assert_eq!((hit.status, &hit.body[..]), (StatusCode::OK, PNG));
    assert_eq!(s.thumbs.requests().len(), 1, "served from the disk cache");
    let cond = s
        .app
        .send(req(http::Method::GET, &url).header("if-none-match", &etag).body(axum::body::Body::empty()).unwrap())
        .await;
    assert_eq!(cond.status, StatusCode::NOT_MODIFIED);
    // A PNG label on JPEG bytes is served as JPEG.
    let jpeg = s.app.send(get(&thumb_of(&s, 1))).await;
    assert_eq!(jpeg.header("content-type"), Some("image/jpeg"));
    let files = walk(&s.app.state.config.data_dir.join("thumbs"));
    assert_eq!(files.len(), 2, "{files:?}");
    let m = s.app.send_admin(games::admin_get("/admin/metrics")).await.text();
    for l in ["result=\"hit\"} 1", "result=\"miss\"} 2", "result=\"not_modified\"} 1"] {
        assert!(m.contains(&format!("gnome_thumb_requests_total{{{l}")), "{l}\n{m}");
    }
    assert_eq!(s.app.send(get("/api/thumb/999999")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(s.app.send(get("/api/thumb/x")).await.status, StatusCode::NOT_FOUND);
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                out.extend(walk(&e.path()));
            } else {
                out.push(e.path());
            }
        }
    }
    out
}

#[tokio::test]
async fn refusals_negative_cache_and_upstream_errors() {
    let svg = image(b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml");
    let html = image(b"<!doctype html><script>alert(1)</script>", "image/png");
    let big = image(&[PNG, &vec![0u8; 2 << 20]].concat(), "image/png");
    let empty = image(b"", "image/png");
    let s = setup(&[], vec![svg, html, big, empty, status(404), status(503)]).await;
    for i in 0..5 {
        let res = s.app.send(get(&thumb_of(&s, i))).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "answer {i}");
    }
    let res = s.app.send(get(&thumb_of(&s, 5))).await;
    assert_eq!((res.status, res.header("retry-after")), (StatusCode::SERVICE_UNAVAILABLE, Some("60")));
    // The negative cache answers without a new upstream request.
    let before = s.thumbs.requests().len();
    assert_eq!(s.app.send(get(&thumb_of(&s, 4))).await.status, StatusCode::NOT_FOUND);
    assert_eq!(s.app.send(get(&thumb_of(&s, 5))).await.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(s.thumbs.requests().len(), before);
    let d = s.app.send_admin(games::admin_get("/admin/diagnostics")).await.json();
    assert_eq!(d["games"]["thumbs"]["negative_entries"], 6, "{}", d["games"]["thumbs"]);
    assert!(walk(&s.app.state.config.data_dir.join("thumbs")).is_empty());
}

#[tokio::test]
async fn concurrent_misses_share_one_fetch() {
    let s = setup(&[], vec![image(PNG, "image/png")]).await;
    let url = thumb_of(&s, 0);
    let all = futures_util::future::join_all((0..10).map(|_| s.app.send(get(&url)))).await;
    assert!(all.iter().all(|r| r.status == StatusCode::OK), "{:?}", all.iter().map(|r| r.status).collect::<Vec<_>>());
    assert_eq!(s.thumbs.requests().len(), 1);
}

#[tokio::test]
async fn eviction_restart_and_no_disk_cache() {
    // 1 MiB cap, three 600 KiB images: the oldest goes.
    let body = [PNG, &vec![7u8; 600 << 10]].concat();
    let s = setup(&[("GNOME_THUMB_CACHE_MB", "1")], (0..3).map(|_| image(&body, "image/png")).collect()).await;
    for i in 0..3 {
        assert_eq!(s.app.send(get(&thumb_of(&s, i))).await.status, StatusCode::OK);
    }
    let dir = s.app.state.config.data_dir.join("thumbs");
    let files = walk(&dir);
    assert_eq!(files.len(), 1, "{files:?}");
    // Found again by a new cache over the same directory.
    let cache = gnome_server::games::thumbs::ThumbCache::open(dir.clone(), 1);
    cache.scan().await;
    assert_eq!(cache.diagnostics()["entries"], 1);
    // GNOME_THUMB_CACHE_MB=0: validated pass-through, nothing stored.
    let none = setup(&[("GNOME_THUMB_CACHE_MB", "0")], vec![image(PNG, "image/png")]).await;
    assert_eq!(none.app.send(get(&thumb_of(&none, 0))).await.status, StatusCode::OK);
    assert!(walk(&none.app.state.config.data_dir.join("thumbs")).is_empty());
    // no-store: served, never stored.
    let mut ns = image(PNG, "image/png");
    ns.headers.push(("cache-control".into(), "no-store".into()));
    let s2 = setup(&[], vec![ns]).await;
    let res = s2.app.send(get(&thumb_of(&s2, 0))).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(walk(&s2.app.state.config.data_dir.join("thumbs")).is_empty());
}

#[tokio::test]
async fn thumbnails_have_their_own_rate_classes() {
    // Scale 0.02: api 6 burst, thumb 12, thumb_fetch 1.
    let s = setup(&[("GNOME_RATE_LIMIT_SCALE", "0.02")], (0..3).map(|_| image(PNG, "image/png")).collect()).await;
    // (setup itself used a few api requests.)
    let mut limited = false;
    for _ in 0..8 {
        if s.app.send(get("/api/games/categories")).await.status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
        }
    }
    assert!(limited, "the api bucket is exhausted");
    assert_eq!(s.app.send(get(&thumb_of(&s, 0))).await.status, StatusCode::OK, "thumbnails still load");
    assert_eq!(s.app.send(get(&thumb_of(&s, 0))).await.status, StatusCode::OK, "a hit takes no thumb_fetch token");
    let res = s.app.send(get(&thumb_of(&s, 1))).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "thumb_fetch exhausted");
    assert!(res.header("retry-after").is_some());
}
