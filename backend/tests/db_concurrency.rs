//! SQLite under concurrent load: many requests writing at once (several per account), readers alongside, and a
//! second connection writing the same file the way `gnome-server user create` does while the server runs. Every
//! request must succeed (no `database is locked`), and the per-account sync clock must stay strictly increasing.

mod common;

use std::collections::BTreeSet;

use axum::body::Body;
use common::*;
use gnome_server::auth::users;
use gnome_server::db::DbError;
use http::{HeaderValue, Method, Request, StatusCode, header};
use serde_json::{Value, json};

const USERS: usize = 6;
const WRITERS_PER_USER: usize = 4;
const ROUNDS: usize = 15;
const ITEMS: usize = 40;

fn with_cookie(mut req: Request<Body>, cookie: &str) -> Request<Body> {
    req.headers_mut().insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
    req
}

fn uuid(user: usize, writer: usize, round: usize, item: usize) -> String {
    format!("{user:08x}-{writer:04x}-4{round:03x}-8000-{item:012x}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_writers_never_see_database_is_locked() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "0")]).await;
    let mut cookies = Vec::new();
    for u in 0..USERS {
        let mut c = app.client().with_ip(&format!("192.0.2.{}:1000", 10 + u));
        c.register(&format!("writer{u}"), "correct horse battery").await;
        cookies.push(format!("gnome_auth={}", c.cookies["gnome_auth"]));
    }

    // Another connection writing the same database file meanwhile (an operator running `user create`).
    let db_path = app.state.db.path().to_path_buf();
    let external = std::thread::spawn(move || {
        let conn = gnome_server::db::open_writer(&db_path).expect("second writer opens");
        for i in 0..60 {
            users::insert(&conn, &format!("cli_user_{i}"), "$argon2id$v=19$m=1024,t=2,p=1$x$y", false, 0)
                .unwrap_or_else(|_| panic!("external insert {i} failed"));
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    });

    let mut tasks = tokio::task::JoinSet::new();
    for (u, cookie) in cookies.iter().enumerate() {
        for w in 0..WRITERS_PER_USER {
            let (router, cookie) = (app.public.clone(), cookie.clone());
            tasks.spawn(async move {
                let peer = format!("192.0.2.{}:2000", 10 + u).parse().unwrap();
                let mut synced = Vec::new();
                for r in 0..ROUNDS {
                    let bookmarks: Vec<Value> = (0..ITEMS)
                        .map(|i| {
                            json!({"id": uuid(u, w, r, i), "kind": "bookmark", "title": format!("b{r}.{i}"),
                                   "url": "https://example.com/", "position": i, "created_at": 1, "updated_at": 2})
                        })
                        .collect();
                    let req = with_cookie(
                        json_req(Method::POST, "/api/sync/bookmarks", &json!({"items": bookmarks})),
                        &cookie,
                    );
                    let res = send_to(&router, req, peer).await;
                    assert_eq!(res.status, StatusCode::OK, "bookmarks: {}", res.text());
                    synced.push(res.json()["server_time"].as_i64().unwrap());

                    let visits: Vec<Value> = (0..ITEMS)
                        .map(|i| json!({"id": uuid(u, w, r, i), "url": "https://example.com/v", "visited_at": 5}))
                        .collect();
                    let req =
                        with_cookie(json_req(Method::POST, "/api/sync/history", &json!({"items": visits})), &cookie);
                    let res = send_to(&router, req, peer).await;
                    assert_eq!(res.status, StatusCode::OK, "history: {}", res.text());

                    // Settings: concurrent writers of one account race on purpose; 409 is the documented answer.
                    let req = with_cookie(
                        json_req(Method::PUT, "/api/sync/settings", &json!({"data": {"w": w, "r": r}})),
                        &cookie,
                    );
                    let res = send_to(&router, req, peer).await;
                    assert!(matches!(res.status, StatusCode::OK | StatusCode::CONFLICT), "settings: {}", res.text());

                    for path in ["/api/sync/bookmarks?since=0", "/api/sync/history?limit=50", "/api/auth/me"] {
                        let res = send_to(&router, with_cookie(get(path), &cookie), peer).await;
                        assert_eq!(res.status, StatusCode::OK, "{path}: {}", res.text());
                    }
                }
                (u, synced)
            });
        }
    }
    let mut per_user: Vec<Vec<i64>> = vec![Vec::new(); USERS];
    while let Some(done) = tasks.join_next().await {
        let (u, synced) = done.expect("writer task succeeded");
        per_user[u].extend(synced);
    }
    external.join().expect("external writer succeeded");

    for (u, stamps) in per_user.iter().enumerate() {
        let unique: BTreeSet<i64> = stamps.iter().copied().collect();
        assert_eq!(unique.len(), stamps.len(), "user {u}: every batch got its own synced_at");
        let mut c = app.client().with_ip(&format!("192.0.2.{}:3000", 10 + u));
        c.cookies.insert("gnome_auth".into(), cookies[u].trim_start_matches("gnome_auth=").into());
        let all = c.get("/api/sync/bookmarks?since=0").await.json();
        assert_eq!(all["items"].as_array().unwrap().len(), WRITERS_PER_USER * ROUNDS * ITEMS);
        // History uploads advance the same per-account clock, so the clock is at least the last bookmark stamp.
        assert!(all["server_time"].as_i64().unwrap() >= *unique.last().unwrap(), "server_time covers every batch");
    }
    let n: i64 = app
        .state
        .db
        .read(|c| -> Result<i64, DbError> { Ok(c.query_row("SELECT count(*) FROM users", [], |r| r.get(0))?) })
        .await
        .unwrap();
    assert_eq!(n, (USERS + 60) as i64);
}
