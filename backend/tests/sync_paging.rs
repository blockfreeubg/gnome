//! WAVE-D D22: bookmark pulls are keyset-paged like history; every page ends at `limit` items or once its JSON
//! reaches 1 MiB; a request without `limit` gets one page that ends on a `synced_at` boundary; at most 2 pulls per
//! account at once; pull answers over 1 MiB need room in the 64 MiB answer budget.

mod common;

use std::collections::BTreeMap;

use axum::body::Body;
use common::*;
use http::{Request, StatusCode, header};
use http_body_util::BodyExt as _;
use serde_json::{Value, json};
use tower::ServiceExt as _;

const PW: &str = "correct horse battery";

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

fn bookmark(n: u32, url: &str, updated: i64) -> Value {
    json!({"id": uuid(n), "kind": "bookmark", "title": "t".repeat(512), "url": url, "position": n, "created_at": 1,
           "updated_at": updated})
}

fn long_url(n: u32) -> String {
    format!("https://example.com/{n}/{}", "u".repeat(4000))
}

/// Pull every bookmark change since `since` page by page; returns the items by id and the last `server_time`.
async fn pull_all(c: &mut Client<'_>, since: i64, limit: u32) -> (BTreeMap<String, Value>, i64, usize) {
    let mut out = BTreeMap::new();
    let mut cursor = String::new();
    let mut pages = 0;
    loop {
        let res = c.get(&format!("/api/sync/bookmarks?since={since}&limit={limit}&cursor={cursor}")).await;
        assert_eq!(res.status, StatusCode::OK, "{}", res.text());
        assert!(res.body.len() < 1024 * 1024 + 16 * 1024, "a page stops once it reaches 1 MiB: {}", res.body.len());
        pages += 1;
        let v = res.json();
        for item in v["items"].as_array().unwrap() {
            out.insert(item["id"].as_str().unwrap().to_string(), item.clone());
        }
        match v["next_cursor"].as_str() {
            Some(next) => cursor = next.to_string(),
            None => return (out, v["server_time"].as_i64().unwrap(), pages),
        }
    }
}

#[tokio::test]
async fn paged_pulls_equal_the_whole_change_set() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut c = app.client();
    c.register("pager", PW).await;
    for batch in 0..3u32 {
        let items: Vec<Value> = (0..100).map(|n| bookmark(batch * 100 + n, "https://example.com/", 10)).collect();
        assert_eq!(c.post("/api/sync/bookmarks", json!({"items": items})).await.status, StatusCode::OK);
    }
    let tombs: Vec<Value> = (0..10)
        .map(|n| json!({"id": uuid(n), "kind": "bookmark", "created_at": 1, "updated_at": 20, "deleted": true}))
        .collect();
    assert_eq!(c.post("/api/sync/bookmarks", json!({"items": tombs})).await.status, StatusCode::OK);
    let (all, server_time, pages) = pull_all(&mut c, 0, 7).await;
    assert_eq!(all.len(), 300);
    assert!(pages >= 43, "{pages}");
    assert_eq!(all.values().filter(|b| b["deleted"] == true).count(), 10, "tombstones included");
    // Writes between pages: changes after the first page's cursor still arrive in this or the next sync.
    let first = c.get("/api/sync/bookmarks?since=0&limit=50").await.json();
    let cursor = first["next_cursor"].as_str().unwrap().to_string();
    let edit = vec![bookmark(5, "https://example.com/edited", 30), bookmark(999, "https://example.com/new", 30)];
    assert_eq!(c.post("/api/sync/bookmarks", json!({"items": edit})).await.status, StatusCode::OK);
    let mut seen: BTreeMap<String, Value> = BTreeMap::new();
    let mut page = c.get(&format!("/api/sync/bookmarks?since=0&limit=50&cursor={cursor}")).await.json();
    loop {
        for item in page["items"].as_array().unwrap() {
            seen.insert(item["id"].as_str().unwrap().to_string(), item.clone());
        }
        let Some(next) = page["next_cursor"].as_str() else { break };
        page = c.get(&format!("/api/sync/bookmarks?since=0&limit=50&cursor={next}")).await.json();
    }
    assert!(seen.contains_key(&uuid(999)) && seen[&uuid(5)]["url"] == "https://example.com/edited");
    let (later, _, _) = pull_all(&mut c, server_time, 1000).await;
    assert_eq!(later.len(), 2, "the next sync from server_time gets exactly the two writes");
    // Limit bounds and a bad cursor.
    for q in ["limit=0", "limit=1001", "limit=10&cursor=nope"] {
        let res = c.get(&format!("/api/sync/bookmarks?{q}")).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{q}");
    }
}

#[tokio::test]
async fn pages_stop_at_1_mib_and_limitless_pulls_end_on_a_group_boundary() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut c = app.client();
    c.register("bigpager", PW).await;
    // Three upload batches (three synced_at groups) of 150 maximal bookmarks (≈ 4.6 KB of JSON each).
    for batch in 0..3u32 {
        let items: Vec<Value> = (0..150).map(|n| bookmark(batch * 150 + n, &long_url(n), 10)).collect();
        assert_eq!(c.post("/api/sync/bookmarks", json!({"items": items})).await.status, StatusCode::OK);
    }
    let first = c.get("/api/sync/bookmarks?limit=1000").await;
    let v = first.json();
    let n = v["items"].as_array().unwrap().len();
    assert!(n < 450 && n > 150, "the 1 MiB cap ended the page: {n}");
    assert!(v["next_cursor"].is_string());
    let (all, _, _) = pull_all(&mut c, 0, 1000).await;
    assert_eq!(all.len(), 450);
    // Without limit (an app from before paging): whole synced_at groups until 1 MiB, server_time at the boundary.
    let res = c.get("/api/sync/bookmarks?since=0").await.json();
    let items = res["items"].as_array().unwrap();
    assert_eq!(items.len(), 300, "two whole groups (the second crosses 1 MiB)");
    assert!(res["next_cursor"].is_null());
    let boundary = res["server_time"].as_i64().unwrap();
    let rest = c.get(&format!("/api/sync/bookmarks?since={boundary}")).await.json();
    assert_eq!(rest["items"].as_array().unwrap().len(), 150, "the rest with since=");
    // History pages stop at 1 MiB too.
    let visits: Vec<Value> = (0..400u32)
        .map(
            |n| json!({"id": uuid(n), "url": long_url(n), "title": "t".repeat(512), "visited_at": 1000 + i64::from(n)}),
        )
        .collect();
    assert_eq!(c.post("/api/sync/history", json!({"items": visits})).await.status, StatusCode::OK);
    let page = c.get("/api/sync/history?limit=1000").await;
    let v = page.json();
    assert!(v["items"].as_array().unwrap().len() < 400 && v["next_cursor"].is_string());
    assert!(page.body.len() < 1024 * 1024 + 16 * 1024);
}

fn authed(path: &str, cookie: &str) -> Request<Body> {
    Request::builder().uri(path).header(header::HOST, HOST).header(header::COOKIE, cookie).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn two_pulls_per_account_and_the_answer_budget() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut c = app.client();
    let res = c.register("puller", PW).await;
    let cookie: String =
        res.set_cookies().iter().map(|c| c.split(';').next().unwrap().to_string()).collect::<Vec<_>>().join("; ");
    let items: Vec<Value> = (0..250).map(|n| bookmark(n, &long_url(n), 10)).collect();
    assert_eq!(c.post("/api/sync/bookmarks", json!({"items": items})).await.status, StatusCode::OK);
    let peer = "203.0.113.10:40000".parse().unwrap();
    let send = |path: &str| {
        let mut r = authed(path, &cookie);
        r.extensions_mut().insert(axum::extract::ConnectInfo::<std::net::SocketAddr>(peer));
        app.public.clone().oneshot(r)
    };
    // Two answers whose bodies are not read yet hold both pull slots.
    let a = send("/api/sync/bookmarks?limit=10").await.unwrap();
    let b = send("/api/sync/history?limit=10").await.unwrap();
    assert_eq!((a.status(), b.status()), (StatusCode::OK, StatusCode::OK));
    let third = send("/api/sync/bookmarks?limit=10").await.unwrap();
    assert_eq!(third.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(third.headers()["retry-after"], "1");
    // Reading a body to its end frees its slot.
    a.into_body().collect().await.unwrap();
    let again = send("/api/sync/bookmarks?limit=10").await.unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    drop((b, again));
    // An answer over 1 MiB needs room in the 64 MiB budget: with the budget taken, it gets 503; small ones pass.
    let room = app.state.limits.answer_budget.take(64 * 1024 * 1024 - 1000).unwrap();
    let big = send("/api/sync/bookmarks?limit=1000").await.unwrap();
    assert_eq!(big.status(), StatusCode::SERVICE_UNAVAILABLE);
    let small = send("/api/sync/bookmarks?limit=5").await.unwrap();
    assert_eq!(small.status(), StatusCode::OK);
    drop((room, small));
    let big = send("/api/sync/bookmarks?limit=1000").await.unwrap();
    assert_eq!(big.status(), StatusCode::OK);
    assert!(app.state.limits.answer_budget.used() > 1024 * 1024, "held while the body is unwritten");
    let body = big.into_body().collect().await.unwrap().to_bytes();
    assert!(body.len() > 1024 * 1024);
    assert_eq!(app.state.limits.answer_budget.used(), 0, "released once written");
}
