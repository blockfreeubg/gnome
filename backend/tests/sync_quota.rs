//! WAVE-D D20: per-account sync quota and the server-wide cap. The trigger-kept byte columns stay exact (inserts,
//! updates, tombstones, deletes, an account deletion, the backfill of a version-1 database); a bookmark or settings
//! write that grows an account past its quota is refused whole with `413 quota_exceeded` (`scope: "account"`) and a
//! shrinking one always applies; history is trimmed oldest first instead; the server-wide cap refuses every kind with
//! `scope: "server"`; `GET /api/sync/usage`; the triggers' cost on a 5,000-item batch and the file size on disk.

mod common;

use common::*;
use gnome_server::AppState;
use gnome_server::config::Config;
use http::StatusCode;
use rusqlite::Connection;
use serde_json::{Value, json};

const PW: &str = "correct horse battery";
const MIB: i64 = 1024 * 1024;

fn uuid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

/// Recomputed from the rows, the way the migration's backfill does.
fn recomputed(c: &Connection, uid: i64) -> (i64, i64, i64) {
    c.query_row(
        "SELECT
           coalesce((SELECT sum(CASE WHEN deleted = 1 THEN 64 ELSE coalesce(octet_length(url), 0) + octet_length(title)
                     + 36 + CASE WHEN parent_id IS NULL THEN 0 ELSE 36 END + 64 END) FROM bookmarks WHERE user_id = ?1), 0),
           coalesce((SELECT sum(octet_length(url) + coalesce(octet_length(title), 0) + 100) FROM history WHERE user_id = ?1), 0),
           coalesce((SELECT octet_length(data) FROM user_settings WHERE user_id = ?1), 0)",
        [uid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn kept(c: &Connection, uid: i64) -> (i64, i64, i64) {
    c.query_row(
        "SELECT sync_bookmark_bytes, sync_history_bytes, sync_settings_bytes FROM users WHERE id = ?1",
        [uid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

fn total_ok(c: &Connection) -> (i64, i64) {
    let kept: i64 = c.query_row("SELECT bytes FROM sync_totals WHERE id = 1", [], |r| r.get(0)).unwrap();
    let sum: i64 = c
        .query_row(
            "SELECT coalesce(sum(sync_bookmark_bytes + sync_history_bytes + sync_settings_bytes), 0) FROM users",
            [],
            |r| r.get(0),
        )
        .unwrap();
    (kept, sum)
}

async fn assert_exact(app: &TestApp, uids: &[i64]) {
    let uids = uids.to_vec();
    app.state
        .db
        .read(move |c| -> Result<(), gnome_server::db::DbError> {
            for uid in uids {
                assert_eq!(kept(c, uid), recomputed(c, uid), "user {uid}");
            }
            let (kept, sum) = total_ok(c);
            assert_eq!(kept, sum, "sync_totals");
            Ok(())
        })
        .await
        .unwrap();
}

async fn uid_of(app: &TestApp, name: &str) -> i64 {
    let name = name.to_string();
    app.state
        .db
        .read(move |c| -> Result<i64, gnome_server::db::DbError> {
            Ok(c.query_row("SELECT id FROM users WHERE username = ?1", [name], |r| r.get(0)).unwrap())
        })
        .await
        .unwrap()
}

fn bookmark(n: u32, title: &str, url: &str, updated: i64) -> Value {
    json!({"id": uuid(n), "kind": "bookmark", "title": title, "url": url, "position": n, "created_at": 1,
           "updated_at": updated, "parent_id": if n.is_multiple_of(2) { Value::Null } else { Value::from(uuid(900_000)) }})
}

fn long_url(n: u32) -> String {
    format!("https://example.com/{n}/{}", "u".repeat(4000))
}

#[tokio::test]
async fn triggers_stay_exact() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut a = app.client();
    a.register("quota_a", PW).await;
    let mut b = app.client();
    b.register("quota_b", PW).await;
    let (ua, ub) = (uid_of(&app, "quota_a").await, uid_of(&app, "quota_b").await);
    // Inserts, then updates (longer and shorter), tombstones, re-announcements.
    let items: Vec<Value> = (0..50).map(|n| bookmark(n, &format!("title {n}"), "https://example.com/a", 10)).collect();
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": items})).await.status, StatusCode::OK);
    let items: Vec<Value> =
        (0..25).map(|n| bookmark(n, &"é".repeat(100), "https://example.com/longer/path", 20)).collect();
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": items})).await.status, StatusCode::OK);
    let tombs: Vec<Value> = (25..40)
        .map(|n| json!({"id": uuid(n), "kind": "bookmark", "created_at": 1, "updated_at": 30, "deleted": true}))
        .collect();
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": tombs})).await.status, StatusCode::OK);
    let stale: Vec<Value> = (0..5).map(|n| bookmark(n, "loser", "https://example.com/", 1)).collect();
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": stale})).await.status, StatusCode::OK);
    let visits: Vec<Value> = (0..40)
        .map(|n| json!({"id": uuid(1000 + n), "url": format!("https://v.example/{n}"), "title": if n % 3 == 0 { Value::Null } else { Value::from("t") }, "visited_at": 1000 + i64::from(n)}))
        .collect();
    assert_eq!(a.post("/api/sync/history", json!({"items": visits})).await.status, StatusCode::OK);
    let retitled: Vec<Value> = (0..10)
        .map(|n| json!({"id": uuid(1000 + n), "url": format!("https://v.example/{n}"), "title": "a much longer title", "visited_at": 1000 + i64::from(n)}))
        .collect();
    assert_eq!(a.post("/api/sync/history", json!({"items": retitled})).await.status, StatusCode::OK);
    assert_eq!(a.put("/api/sync/settings", json!({"data": {"x": "y".repeat(500)}})).await.status, StatusCode::OK);
    let base = a.get("/api/sync/settings").await.json()["updated_at"].clone();
    assert_eq!(
        a.put("/api/sync/settings", json!({"data": {"x": 1}, "base_updated_at": base})).await.status,
        StatusCode::OK
    );
    let res = b
        .post("/api/sync/history", json!({"items": [{"id": uuid(5), "url": "https://b.example/", "visited_at": 5}]}))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_exact(&app, &[ua, ub]).await;
    // Deletions: part of the history, then the tombstone purge job's query.
    assert_eq!(a.delete("/api/sync/history", json!({"before": 1020})).await.status, StatusCode::NO_CONTENT);
    app.state
        .db
        .write(|c| {
            gnome_server::api::sync::bookmarks::purge_tombstones(c, i64::MAX).map_err(gnome_server::db::DbError::from)
        })
        .await
        .unwrap();
    assert_exact(&app, &[ua, ub]).await;
    // Usage.
    let u = a.get("/api/sync/usage").await.json();
    let (bm, hi, se) =
        app.state.db.read(move |c| -> Result<_, gnome_server::db::DbError> { Ok(kept(c, ua)) }).await.unwrap();
    assert_eq!(
        u,
        json!({"used_bytes": bm + hi + se, "quota_bytes": 64 * MIB, "history_bytes": hi, "bookmarks_bytes": bm, "settings_bytes": se})
    );
    // An account deletion removes its bytes from the server total.
    app.state
        .db
        .write(move |c| -> Result<(), gnome_server::db::DbError> {
            c.execute("DELETE FROM users WHERE id = ?1", [ua]).unwrap();
            Ok(())
        })
        .await
        .unwrap();
    assert_exact(&app, &[ub]).await;
    let usage_requires_sign_in = app.client().get("/api/sync/usage").await;
    assert_eq!(usage_requires_sign_in.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bookmark_and_settings_growth_past_the_quota_is_refused_and_shrinking_applies() {
    let app = TestApp::new(&[("GNOME_SYNC_QUOTA_MB", "1"), ("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut a = app.client();
    a.register("quota_full", PW).await;
    let uid = uid_of(&app, "quota_full").await;
    // ≈ 4.2 KB per bookmark: 300 of them are ≈ 1.26 MB, past the 1 MiB quota: refused whole.
    let big: Vec<Value> = (0..300).map(|n| bookmark(n, &"t".repeat(100), &long_url(n), 10)).collect();
    let res = a.post("/api/sync/bookmarks", json!({"items": big})).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", res.text());
    let v = res.json();
    assert_eq!(v["error"]["code"], "quota_exceeded");
    assert_eq!(v["scope"], "account");
    assert_eq!(v["quota_bytes"], MIB);
    assert!(v["used_bytes"].as_i64().unwrap() > MIB);
    assert_eq!(a.get("/api/sync/usage").await.json()["used_bytes"], 0, "rolled back whole");
    // 200 fit.
    let fit: Vec<Value> = (0..200).map(|n| bookmark(n, "t", &long_url(n), 10)).collect();
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": fit})).await.status, StatusCode::OK);
    // A settings document that grows the account past the quota is refused, a small one fits.
    let doc = json!({"data": {"blob": "s".repeat(240 * 1024)}});
    let res = a.put("/api/sync/settings", doc).await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", res.text());
    assert_eq!(res.json()["scope"], "account");
    // Push the account over its quota behind the API's back (as a lowered GNOME_SYNC_QUOTA_MB would).
    app.state
        .db
        .write(move |c| -> Result<(), gnome_server::db::DbError> {
            for n in 0..100 {
                c.execute(
                    "INSERT INTO history (user_id, id, url, title, visited_at, synced_at) VALUES (?1, ?2, ?3, NULL, 1, 1)",
                    rusqlite::params![uid, uuid(50_000 + n), long_url(n)],
                )
                .unwrap();
            }
            Ok(())
        })
        .await
        .unwrap();
    let over = a.get("/api/sync/usage").await.json()["used_bytes"].as_i64().unwrap();
    assert!(over > MIB, "{over}");
    // Growing is refused, shrinking (tombstones, shorter titles) applies.
    let grow = vec![bookmark(5000, "new", "https://example.com/new", 10)];
    assert_eq!(a.post("/api/sync/bookmarks", json!({"items": grow})).await.status, StatusCode::PAYLOAD_TOO_LARGE);
    let tombs: Vec<Value> = (0..20)
        .map(|n| json!({"id": uuid(n), "kind": "bookmark", "created_at": 1, "updated_at": 50, "deleted": true}))
        .collect();
    let res = a.post("/api/sync/bookmarks", json!({"items": tombs})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert!(a.get("/api/sync/usage").await.json()["used_bytes"].as_i64().unwrap() < over);
    assert_exact(&app, &[uid]).await;
}

#[tokio::test]
async fn history_is_trimmed_oldest_first() {
    let app = TestApp::new(&[("GNOME_SYNC_QUOTA_MB", "1"), ("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut a = app.client();
    a.register("quota_hist", PW).await;
    let uid = uid_of(&app, "quota_hist").await;
    let mut trimmed_total = 0;
    for batch in 0..2u32 {
        let visits: Vec<Value> = (0..200u32)
            .map(|n| {
                let i = batch * 200 + n;
                json!({"id": uuid(i), "url": long_url(i), "visited_at": 10_000 + i64::from(i)})
            })
            .collect();
        let res = a.post("/api/sync/history", json!({"items": visits})).await;
        assert_eq!(res.status, StatusCode::OK, "never refused for the account quota: {}", res.text());
        trimmed_total += res.json()["trimmed"].as_u64().unwrap();
    }
    assert!(trimmed_total > 100, "{trimmed_total}");
    let used = a.get("/api/sync/usage").await.json()["used_bytes"].as_i64().unwrap();
    assert!(used <= MIB && used > MIB - 5000, "fits the quota, close to it: {used}");
    // The oldest went: what remains is the newest, contiguous.
    let (min, n): (i64, i64) = app
        .state
        .db
        .read(move |c| -> Result<_, gnome_server::db::DbError> {
            Ok(c.query_row("SELECT min(visited_at), count(*) FROM history WHERE user_id = ?1", [uid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap())
        })
        .await
        .unwrap();
    assert_eq!(min, 10_000 + 400 - n, "the {n} newest visits remain");
    assert_exact(&app, &[uid]).await;
}

#[tokio::test]
async fn the_server_wide_cap_refuses_every_kind() {
    let app =
        TestApp::new(&[("GNOME_SYNC_QUOTA_MB", "8"), ("GNOME_SYNC_TOTAL_MB", "16"), ("GNOME_RATE_LIMIT_SCALE", "0")])
            .await;
    let mut a = app.client();
    a.register("filler", PW).await;
    let mut b = app.client();
    b.register("latecomer", PW).await;
    let ua = uid_of(&app, "filler").await;
    // 16 MiB of rows for the filler, written behind the API (more than its own quota; only the total matters).
    app.state
        .db
        .write(move |c| -> Result<(), gnome_server::db::DbError> {
            let tx = c.transaction().unwrap();
            for n in 0..4100u32 {
                tx.execute(
                    "INSERT INTO history (user_id, id, url, title, visited_at, synced_at) VALUES (?1, ?2, ?3, NULL, 1, 1)",
                    rusqlite::params![ua, uuid(n), long_url(n)],
                )
                .unwrap();
            }
            tx.commit().unwrap();
            Ok(())
        })
        .await
        .unwrap();
    for (what, res) in [
        (
            "bookmarks",
            b.post("/api/sync/bookmarks", json!({"items": [bookmark(1, "b", "https://example.com/", 1)]})).await,
        ),
        ("settings", b.put("/api/sync/settings", json!({"data": {"a": 1}})).await),
        (
            "history",
            b.post(
                "/api/sync/history",
                json!({"items": [{"id": uuid(1), "url": "https://example.com/", "visited_at": 1}]}),
            )
            .await,
        ),
    ] {
        assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE, "{what}: {}", res.text());
        let v = res.json();
        assert_eq!(
            (v["error"]["code"].as_str(), v["scope"].as_str()),
            (Some("quota_exceeded"), Some("server")),
            "{what}"
        );
        assert_eq!(v["quota_bytes"], 16 * MIB);
    }
    assert_eq!(b.get("/api/sync/usage").await.json()["used_bytes"], 0);
    let d = app
        .send_admin(
            http::Request::builder()
                .uri("/admin/diagnostics")
                .header("host", "127.0.0.1:9091")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .json();
    assert!(d["db"]["sync_bytes_total"].as_i64().unwrap() > 16 * MIB);
    assert_eq!(d["db"]["sync_quota_bytes"], 8 * MIB);
}

#[tokio::test]
async fn a_version_1_database_is_backfilled() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    {
        let c = Connection::open(data.join("gnome.db")).unwrap();
        let core = include_str!("../../database/migrations/0001_core.sql");
        c.execute_batch(core).unwrap();
        c.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, 'core', ?1, 0)",
            [gnome_server::security::crypto::sha256_hex(core.as_bytes())],
        )
        .unwrap();
        c.execute_batch(
            "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (1, 'old', 'x', 0, 0), (2, 'empty', 'x', 0, 0);
             INSERT INTO bookmarks (user_id, id, parent_id, kind, title, url, position, created_at, updated_at, deleted, synced_at)
               VALUES (1, 'a', NULL, 'bookmark', 'Title', 'https://example.com/', 1, 1, 1, 0, 1),
                      (1, 'b', 'a', 'folder', 'Folder', NULL, 2, 1, 1, 0, 1),
                      (1, 'c', NULL, 'bookmark', '', NULL, 3, 1, 1, 1, 1);
             INSERT INTO history (user_id, id, url, title, visited_at, synced_at) VALUES (1, 'h', 'https://h.example/', 'é', 1, 1);
             INSERT INTO user_settings (user_id, data, updated_at) VALUES (1, '{\"a\":1}', 1);",
        )
        .unwrap();
    }
    let map = [
        ("GNOME_DATA_DIR", data.display().to_string()),
        ("GNOME_STATIC_DIR", dir.path().join("static").display().to_string()),
        ("GNOME_CATALOG_REFRESH_HOURS", "0".into()),
    ];
    let config = Config::from_lookup(|k| map.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()), None).unwrap();
    let state = AppState::open(config).await.unwrap();
    let (kept1, kept2, total) = state
        .db
        .read(|c| -> Result<_, gnome_server::db::DbError> {
            let t: i64 = c.query_row("SELECT bytes FROM sync_totals", [], |r| r.get(0)).unwrap();
            Ok((kept(c, 1), kept(c, 2), t))
        })
        .await
        .unwrap();
    // a: 20 + 5 + 36 + 64; b: 6 + 36 + 36 + 64; c: tombstone 64. h: 18 + 2 + 100. settings: 7.
    assert_eq!(kept1, (125 + 142 + 64, 120, 7));
    assert_eq!(kept2, (0, 0, 0));
    assert_eq!(total, 125 + 142 + 64 + 120 + 7);
}

/// The triggers' cost on a 5,000-visit batch (the largest batch), and the database file's size as a multiple of
/// the logical bytes (for DEPLOYMENT.md "Capacity"). Recorded in the test output, not asserted beyond sanity.
#[tokio::test]
async fn trigger_cost_and_size_on_disk_are_recorded() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut a = app.client();
    a.register("timing_a", PW).await;
    let mut b = app.client();
    b.register("timing_b", PW).await;
    let batch = |base: u32| -> Value {
        let items: Vec<Value> = (0..5000u32)
            .map(|n| json!({"id": uuid(base + n), "url": format!("https://example.com/{n}/{}", "p".repeat(120)), "title": "A page title of moderate length", "visited_at": 1_000 + i64::from(n)}))
            .collect();
        json!({"items": items})
    };
    let t = std::time::Instant::now();
    assert_eq!(a.post("/api/sync/history", batch(0)).await.status, StatusCode::OK);
    let with = t.elapsed();
    app.state
        .db
        .write(|c| -> Result<(), gnome_server::db::DbError> {
            for t in ["sync_bytes_history_insert", "sync_bytes_history_update", "sync_bytes_history_delete"] {
                c.execute_batch(&format!("DROP TRIGGER {t}")).unwrap();
            }
            Ok(())
        })
        .await
        .unwrap();
    let t = std::time::Instant::now();
    assert_eq!(b.post("/api/sync/history", batch(10_000)).await.status, StatusCode::OK);
    let without = t.elapsed();
    let logical = a.get("/api/sync/usage").await.json()["used_bytes"].as_i64().unwrap() * 2;
    app.state.db.checkpoint_and_optimize().await.unwrap();
    let on_disk = app.state.db.size_bytes() as f64;
    eprintln!(
        "D20 trigger cost (debug build): 5,000-visit batch with triggers {with:?}, without {without:?}, ratio {:.2}; \
         database {on_disk} B on disk for {logical} logical sync bytes = {:.2}x",
        with.as_secs_f64() / without.as_secs_f64(),
        on_disk / logical as f64
    );
    assert!(on_disk > 0.0);
}
