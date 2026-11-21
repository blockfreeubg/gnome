//! Sync: settings optimistic concurrency, bookmarks LWW + tombstones, history paging + deletion propagation.

mod common;

use common::*;
use http::StatusCode;
use serde_json::{Value, json};

const PW: &str = "correct horse battery";

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

async fn signed_in<'a>(app: &'a TestApp, name: &str) -> Client<'a> {
    let mut c = app.client();
    c.register(name, PW).await;
    c
}

#[tokio::test]
async fn sync_requires_sign_in() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    for path in ["/api/sync/settings", "/api/sync/bookmarks", "/api/sync/history"] {
        let res = c.get(path).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(res.error_code(), "unauthorized");
    }
}

#[tokio::test]
async fn settings_optimistic_concurrency() {
    let app = TestApp::new(&[]).await;
    let mut laptop = signed_in(&app, "settings_user").await;
    let empty = laptop.get("/api/sync/settings").await.json();
    assert_eq!(empty, json!({"data": null, "updated_at": null}));

    let doc = json!({"version": 1, "appearance": {"theme": "dark", "fontSize": 14}});
    let res = laptop.put("/api/sync/settings", json!({"data": doc, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let t1 = res.json()["updated_at"].as_i64().unwrap();
    let got = laptop.get("/api/sync/settings").await.json();
    assert_eq!(got["data"], doc);
    assert_eq!(got["updated_at"], t1);

    // Another device signed into the same account updates first.
    let mut phone = app.client().with_ip("198.51.100.5:1");
    phone.post("/api/auth/login", json!({"username": "settings_user", "password": PW})).await;
    let phone_doc = json!({"version": 1, "appearance": {"theme": "light"}});
    let res = phone.put("/api/sync/settings", json!({"data": phone_doc, "base_updated_at": t1})).await;
    assert_eq!(res.status, StatusCode::OK);
    let t2 = res.json()["updated_at"].as_i64().unwrap();
    assert!(t2 > t1);

    // The laptop's write based on t1 is now stale → 409 with the server copy.
    let res = laptop.put("/api/sync/settings", json!({"data": {"version": 1, "x": 1}, "base_updated_at": t1})).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    let v = res.json();
    assert_eq!(v["error"]["code"], "conflict");
    assert_eq!(v["data"], phone_doc);
    assert_eq!(v["updated_at"], t2);
    // A first-time push (base null) also conflicts once the server has data.
    let res = laptop.put("/api/sync/settings", json!({"data": {"version": 1}, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    // After merging, retry with the right base.
    let res =
        laptop.put("/api/sync/settings", json!({"data": {"version": 1, "merged": true}, "base_updated_at": t2})).await;
    assert_eq!(res.status, StatusCode::OK);

    // Validation: objects only, size cap.
    let res = laptop.put("/api/sync/settings", json!({"data": [1, 2], "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let big = "x".repeat(257 * 1024);
    let res = laptop.put("/api/sync/settings", json!({"data": {"blob": big}, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
}

fn bookmark(id: &str, title: &str, updated_at: i64) -> Value {
    json!({
        "id": id, "parent_id": null, "kind": "bookmark", "title": title, "url": "https://example.com/",
        "position": 1.5, "created_at": 1_000, "updated_at": updated_at, "deleted": false
    })
}

#[tokio::test]
async fn bookmarks_last_writer_wins_with_tombstones() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "bm_user").await;
    let (a, b, folder) = (uuid(1), uuid(2), uuid(3));

    let v = c.get("/api/sync/bookmarks").await.json();
    assert_eq!(v["items"], json!([]));
    let since0 = v["server_time"].as_i64().unwrap();

    let res = c
        .post(
            "/api/sync/bookmarks",
            json!({"items": [
                bookmark(&a, "A v1", 2_000),
                bookmark(&b, "B v1", 2_000),
                {"id": folder, "parent_id": null, "kind": "folder", "title": "Games", "url": null,
                 "position": 0, "created_at": 1_000, "updated_at": 2_000, "deleted": false}
            ]}),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.json()["applied"], 3);

    let pull = c.get(&format!("/api/sync/bookmarks?since={since0}")).await.json();
    assert_eq!(pull["items"].as_array().unwrap().len(), 3);
    let cursor = pull["server_time"].as_i64().unwrap();
    assert!(cursor > since0);
    assert_eq!(pull["items"][0]["position"], 1.5);

    // Older and equal updated_at lose; newer wins. The stored copy that beat a loser (B, a tie) is handed out again
    // so the device that sent the loser converges on it.
    let res = c
        .post(
            "/api/sync/bookmarks",
            json!({"items": [bookmark(&a, "A stale", 1_500), bookmark(&b, "B tie", 2_000), bookmark(&a, "A v2", 3_000)]}),
        )
        .await;
    assert_eq!(res.json()["applied"], 1);
    let pull = c.get(&format!("/api/sync/bookmarks?since={cursor}")).await.json();
    let items = pull["items"].as_array().unwrap();
    let titles: Vec<&str> = items.iter().map(|i| i["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["A v2", "B v1"], "the winner of A and the re-announced winner of B; folder unchanged");
    let cursor = pull["server_time"].as_i64().unwrap();

    // Tombstone: drops title/url, still returned so other devices delete it.
    let tomb = json!({"id": b, "kind": "bookmark", "title": "secret", "url": "https://secret.example/",
                      "position": 1, "created_at": 1_000, "updated_at": 4_000, "deleted": true});
    assert_eq!(c.post("/api/sync/bookmarks", json!({"items": [tomb]})).await.json()["applied"], 1);
    let pull = c.get(&format!("/api/sync/bookmarks?since={cursor}")).await.json();
    let items = pull["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["deleted"], true);
    assert_eq!(items[0]["title"], "");
    assert_eq!(items[0]["url"], Value::Null);
    let cursor = pull["server_time"].as_i64().unwrap();
    // A stale resurrection attempt loses to the tombstone, which is re-announced.
    assert_eq!(
        c.post("/api/sync/bookmarks", json!({"items": [bookmark(&b, "B again", 3_500)]})).await.json()["applied"],
        0
    );
    let pull = c.get(&format!("/api/sync/bookmarks?since={cursor}")).await.json();
    assert_eq!(pull["items"].as_array().unwrap().len(), 1);
    assert_eq!(pull["items"][0]["deleted"], true);

    // Full pull returns everything including the tombstone.
    let all = c.get("/api/sync/bookmarks").await.json();
    assert_eq!(all["items"].as_array().unwrap().len(), 3);

    // Other users see nothing.
    let mut stranger = signed_in(&app, "bm_other").await;
    assert_eq!(stranger.get("/api/sync/bookmarks").await.json()["items"], json!([]));
}

#[tokio::test]
async fn a_device_with_a_slow_clock_converges_on_the_winner() {
    // Laptop and phone share an account; the phone's clock runs 5 s behind.
    let app = TestApp::new(&[]).await;
    let mut laptop = signed_in(&app, "two_devices").await;
    let mut phone = app.client().with_ip("192.0.2.150:1");
    phone.cookies = laptop.cookies.clone();
    let id = uuid(7);
    laptop.post("/api/sync/bookmarks", json!({"items": [bookmark(&id, "laptop edit", 10_000)]})).await;
    let pulled = phone.get("/api/sync/bookmarks?since=0").await.json();
    let phone_cursor = pulled["server_time"].as_i64().unwrap();
    // Seconds later the phone edits the same bookmark, but its clock says 9 000: last-writer-wins keeps the laptop's.
    let res = phone.post("/api/sync/bookmarks", json!({"items": [bookmark(&id, "phone edit", 9_000)]})).await;
    assert_eq!(res.json()["applied"], 0);
    // The phone's next pull hands it the winner, so it does not keep its losing copy forever.
    let pull = phone.get(&format!("/api/sync/bookmarks?since={phone_cursor}")).await.json();
    let items = pull["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{pull}");
    assert_eq!(items[0]["title"], "laptop edit");
    assert_eq!(items[0]["updated_at"], 10_000);
}

#[tokio::test]
async fn tombstones_are_capped_per_account() {
    use gnome_server::api::sync::bookmarks::MAX_TOMBSTONES_PER_USER;
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "deleter").await;
    // Seed a full tombstone allowance directly (synced_at 1..=N, oldest first).
    app.state
        .db
        .write(|db| -> Result<usize, gnome_server::db::DbError> {
            Ok(db.execute(
                "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
                 INSERT INTO bookmarks (user_id, id, kind, title, position, created_at, updated_at, deleted, synced_at)
                 SELECT u.id, printf('00000000-0000-4000-8000-%012d', i), 'bookmark', '', 0, 1, 2, 1, i
                   FROM n, users u WHERE u.username = 'deleter'",
                [MAX_TOMBSTONES_PER_USER],
            )?)
        })
        .await
        .unwrap();
    let fresh: Vec<Value> = (0..10)
        .map(|n| {
            json!({"id": uuid(1_000 + n), "kind": "bookmark", "position": 0, "created_at": 1, "updated_at": 2,
                   "deleted": true})
        })
        .collect();
    let res = c.post("/api/sync/bookmarks", json!({"items": fresh})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    let (count, oldest): (i64, i64) = app
        .state
        .db
        .read(|db| -> Result<(i64, i64), gnome_server::db::DbError> {
            Ok(db.query_row("SELECT count(*), min(synced_at) FROM bookmarks WHERE deleted = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?)
        })
        .await
        .unwrap();
    assert_eq!(count, MAX_TOMBSTONES_PER_USER, "the oldest tombstones made room");
    assert_eq!(oldest, 11, "the ten oldest were dropped");
}

#[tokio::test]
async fn a_cursor_from_the_future_is_corrected() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "time_traveller").await;
    c.post("/api/sync/bookmarks", json!({"items": [bookmark(&uuid(1), "x", 1_000)]})).await;
    let clock = c.get("/api/sync/bookmarks").await.json()["server_time"].as_i64().unwrap();
    // E.g. a cursor kept from before the server's database was restored from a backup.
    let future = clock + 86_400_000;
    let pull = c.get(&format!("/api/sync/bookmarks?since={future}")).await.json();
    assert_eq!(pull["server_time"], clock, "the real clock, so the device resynchronizes");
    let page = c.get(&format!("/api/sync/history?since={future}")).await.json();
    assert_eq!(page["server_time"], clock);
}

#[tokio::test]
async fn settings_must_round_trip() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "deep_settings").await;
    let mut deep = json!(1);
    for _ in 0..200 {
        deep = json!({ "a": deep });
    }
    let res = c.put("/api/sync/settings", json!({"data": deep, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", res.text());
    assert!(res.json()["error"]["fields"]["data"].as_str().unwrap().contains("recursion limit"), "{}", res.text());
    // A normal document, then a stale write: the conflict carries the stored copy.
    let res = c.put("/api/sync/settings", json!({"data": {"theme": "dark"}, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = c.put("/api/sync/settings", json!({"data": {"theme": "light"}, "base_updated_at": 1})).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.json()["data"], json!({"theme": "dark"}));
}

#[tokio::test]
async fn bookmark_validation_is_strict() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "bm_strict").await;
    let mut bad_url = bookmark(&uuid(1), "x", 1_000);
    bad_url["url"] = json!("javascript:alert(1)");
    let mut bad_id = bookmark("not-a-uuid", "x", 1_000);
    bad_id["title"] = json!("t".repeat(513));
    let res = c.post("/api/sync/bookmarks", json!({"items": [bad_url, bad_id]})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let fields = &res.json()["error"]["fields"];
    assert!(fields["items[0].url"].is_string(), "{fields}");
    assert!(fields["items[1].id"].is_string(), "{fields}");
    assert!(fields["items[1].title"].is_string(), "{fields}");
    // Nothing from a rejected batch is stored.
    assert_eq!(c.get("/api/sync/bookmarks").await.json()["items"], json!([]));

    let too_many: Vec<Value> = (0..5001).map(|i| bookmark(&uuid(i), "x", 1_000)).collect();
    let res = c.post("/api/sync/bookmarks", json!({"items": too_many})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.json()["error"]["fields"]["items"].is_string());

    let ok: Vec<Value> = (0..5000).map(|i| bookmark(&uuid(i), "x", 1_000)).collect();
    let res = c.post("/api/sync/bookmarks", json!({"items": ok})).await;
    assert_eq!(res.status, StatusCode::OK, "5000 items fit the 2 MiB batch limit: {}", res.text());
    assert_eq!(res.json()["applied"], 5000);
}

fn visit(n: u32, url: &str, at: i64) -> Value {
    json!({"id": uuid(n), "url": url, "title": format!("Page {n}"), "visited_at": at})
}

#[tokio::test]
async fn history_paging_and_deletion() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "hist_user").await;
    let first: Vec<Value> =
        (0..7).map(|i| visit(i, &format!("https://example.com/{i}"), 10_000 + i64::from(i))).collect();
    let res = c.post("/api/sync/history", json!({"items": first})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.json()["applied"], 7);
    // Re-sending identical entries changes nothing.
    let again: Vec<Value> =
        (0..7).map(|i| visit(i, &format!("https://example.com/{i}"), 10_000 + i64::from(i))).collect();
    assert_eq!(c.post("/api/sync/history", json!({"items": again})).await.json()["applied"], 0);

    // Page through with limit=3.
    let mut seen = Vec::new();
    let mut cursor: Option<String> = None;
    let mut since: i64;
    loop {
        let url = match &cursor {
            Some(cur) => format!("/api/sync/history?limit=3&cursor={cur}"),
            None => "/api/sync/history?limit=3".to_string(),
        };
        let page = c.get(&url).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.text());
        let page = page.json();
        for item in page["items"].as_array().unwrap() {
            seen.push(item["id"].as_str().unwrap().to_string());
        }
        since = page["server_time"].as_i64().unwrap();
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    let mut expected: Vec<String> = (0..7).map(uuid).collect();
    expected.sort();
    let mut sorted = seen.clone();
    sorted.sort();
    assert_eq!(sorted, expected, "every entry exactly once");
    assert_eq!(seen.len(), 7);

    // Incremental pull sees only new uploads.
    c.post("/api/sync/history", json!({"items": [visit(100, "https://example.org/new", 20_000)]})).await;
    let page = c.get(&format!("/api/sync/history?since={since}")).await.json();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["url"], "https://example.org/new");
    assert_eq!(page["cleared_before"], Value::Null);

    // Delete before a cutoff: server rows go, the cutoff propagates, older uploads are ignored.
    let res = c.delete("/api/sync/history", json!({"before": 10_004})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    let page = c.get("/api/sync/history").await.json();
    assert_eq!(page["items"].as_array().unwrap().len(), 4, "10_004..10_006 and 20_000 remain");
    assert_eq!(page["cleared_before"], 10_004);
    let res = c.post("/api/sync/history", json!({"items": [visit(0, "https://example.com/0", 10_000)]})).await;
    assert_eq!(res.json()["applied"], 0, "a device that missed the deletion cannot resurrect it");

    // Delete everything.
    assert_eq!(c.delete("/api/sync/history", json!({"all": true})).await.status, StatusCode::NO_CONTENT);
    let page = c.get("/api/sync/history").await.json();
    assert_eq!(page["items"], json!([]));
    assert!(page["cleared_before"].as_i64().unwrap() > 20_000);

    // Bad requests.
    assert_eq!(c.delete("/api/sync/history", json!({})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.delete("/api/sync/history", json!({"all": true, "before": 5})).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get("/api/sync/history?limit=0").await.status, StatusCode::BAD_REQUEST);
    assert_eq!(c.get("/api/sync/history?cursor=garbage!").await.status, StatusCode::BAD_REQUEST);
    let res = c.post("/api/sync/history", json!({"items": [visit(1, "about:blank", 5)]})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn history_pages_across_batches_after_since() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "pager").await;
    let batch = |from: u32| -> Vec<Value> { (from..from + 3).map(|i| visit(i, "https://example.com/p", 5)).collect() };
    c.post("/api/sync/history", json!({"items": batch(0)})).await;
    let since = c.get("/api/sync/history").await.json()["server_time"].as_i64().unwrap();
    for from in [10, 20] {
        c.post("/api/sync/history", json!({"items": batch(from)})).await;
    }
    let (mut seen, mut cursor) = (Vec::new(), None::<String>);
    loop {
        let url = match &cursor {
            Some(cur) => format!("/api/sync/history?since={since}&limit=2&cursor={cur}"),
            None => format!("/api/sync/history?since={since}&limit=2"),
        };
        let page = c.get(&url).await.json();
        seen.extend(page["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()));
        match page["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None => break,
        }
    }
    let expected: Vec<String> = [10, 11, 12, 20, 21, 22].into_iter().map(uuid).collect();
    assert_eq!(seen, expected, "both later batches, oldest first, each entry once, nothing from before since");
    // A crafted cursor behind `since` cannot reach older entries.
    let behind = base64_url(&format!("0:{}", uuid(0)));
    let page = c.get(&format!("/api/sync/history?since={since}&limit=10&cursor={behind}")).await.json();
    let ids: Vec<&str> = page["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 6, "{page}");
    assert!(!ids.contains(&uuid(0).as_str()));
}

fn base64_url(s: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s)
}

#[tokio::test]
async fn cursors_survive_deletions_and_clock_steps() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "clock_user").await;
    c.post("/api/sync/history", json!({"items": [visit(1, "https://example.com/1", 1_000)]})).await;
    // Pretend earlier writes were stamped while the wall clock ran an hour ahead (e.g. a Raspberry Pi before NTP).
    let ahead = gnome_server::util::now_ms() + 3_600_000;
    app.state
        .db
        .write(move |db| -> Result<usize, gnome_server::db::DbError> {
            Ok(db.execute("UPDATE users SET sync_clock = ?1", [ahead])?)
        })
        .await
        .unwrap();
    let cursor = c.get("/api/sync/history").await.json()["server_time"].as_i64().unwrap();
    assert_eq!(cursor, ahead);
    // Deleting every row must not reset the clock: the next upload is still newer than the device's cursor.
    assert_eq!(c.delete("/api/sync/history", json!({"all": true})).await.status, StatusCode::NO_CONTENT);
    let now = gnome_server::util::now_ms();
    c.post("/api/sync/history", json!({"items": [visit(2, "https://example.com/2", now)]})).await;
    let page = c.get(&format!("/api/sync/history?since={cursor}")).await.json();
    assert_eq!(page["items"].as_array().unwrap().len(), 1, "{page}");
    assert!(page["server_time"].as_i64().unwrap() > cursor);
    // Bookmarks share the clock.
    let res = c.post("/api/sync/bookmarks", json!({"items": [bookmark(&uuid(9), "B", 1_000)]})).await;
    let applied_at = res.json()["server_time"].as_i64().unwrap();
    assert!(applied_at > cursor);
    let pull = c.get(&format!("/api/sync/bookmarks?since={cursor}")).await.json();
    assert_eq!(pull["items"].as_array().unwrap().len(), 1);
    assert_eq!(pull["server_time"], applied_at);
}

#[tokio::test]
async fn shape_errors_name_the_field() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "shape_user").await;
    let mut item = bookmark(&uuid(1), "x", 1_000);
    item.as_object_mut().unwrap().remove("updated_at");
    let res = c.post("/api/sync/bookmarks", json!({"items": [bookmark(&uuid(2), "ok", 1_000), item]})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.json()["error"]["fields"], json!({"items[1].updated_at": "is required"}));
    let res = c.post("/api/sync/history", json!({"items": [{"id": uuid(3), "url": 42, "visited_at": 1}]})).await;
    let fields = res.json()["error"]["fields"].clone();
    assert!(fields["items[0].url"].as_str().unwrap().starts_with("invalid type"), "{fields}");
}

#[tokio::test]
async fn sync_is_rate_limited_per_session() {
    let app = TestApp::new(&[]).await;
    let mut c = signed_in(&app, "busy_user").await;
    let mut limited = None;
    for i in 0..80 {
        let res = c.get("/api/sync/settings").await;
        if res.status == StatusCode::TOO_MANY_REQUESTS {
            limited = Some(i);
            break;
        }
        assert_eq!(res.status, StatusCode::OK);
    }
    // Burst of 60 per session (refill 2/s may add a token while the loop runs).
    assert!(matches!(limited, Some(60..=62)), "{limited:?}");
}
