//! Accounts: register / login / me / logout / password / account deletion, toggles and protections.

mod common;

use common::*;
use http::{Method, StatusCode};
use serde_json::json;

const PW: &str = "correct horse battery";

#[tokio::test]
async fn full_account_lifecycle() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "100")]).await;
    let mut c = app.client();

    assert_eq!(c.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    let res = c.register("Gnome_Fan", PW).await;
    let v = res.json();
    assert_eq!(v["user"]["username"], "Gnome_Fan");
    assert_eq!(v["user"]["is_admin"], false);
    assert!(v["user"]["id"].is_i64() && v["user"]["created_at"].is_i64());
    let cookie = res.set_cookie("gnome_auth").unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict") && cookie.contains("Max-Age=2592000"));

    let me = c.get("/api/auth/me").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.json()["user"]["username"], "Gnome_Fan");
    let s = c.get("/api/session").await.json();
    assert_eq!(s["session"]["kind"], "user");
    assert_eq!(s["session"]["user"]["username"], "Gnome_Fan");
    assert_eq!(s["session"]["proxy"], false, "open mode needs gnome_sid for the proxy");

    // Usernames are unique case-insensitively.
    let mut other = app.client();
    let res = other.post("/api/auth/register", json!({"username": "gnome_fan", "password": PW})).await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(res.error_code(), "conflict");

    // Logout clears the cookie and kills the session row.
    let stolen = c.cookies["gnome_auth"].clone();
    let res = c.post("/api/auth/logout", json!({})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT);
    assert!(res.set_cookie("gnome_auth").unwrap().contains("Max-Age=0"));
    assert_eq!(c.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED);
    let mut replay = app.client();
    replay.cookies.insert("gnome_auth".into(), stolen);
    assert_eq!(replay.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED, "logged-out token is dead");

    // Login is case-insensitive on the username.
    let res = c.post("/api/auth/login", json!({"username": "GNOME_FAN", "password": PW})).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert_eq!(res.json()["user"]["username"], "Gnome_Fan");
    let res = c.post("/api/auth/login", json!({"username": "gnome_fan", "password": "not the password"})).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"]["message"], "invalid credentials");
    let res = c.post("/api/auth/login", json!({"username": "nobody_here", "password": PW})).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"]["message"], "invalid credentials", "same message for unknown users");

    // Second device.
    let mut phone = app.client().with_ip("198.51.100.4:1");
    assert_eq!(
        phone.post("/api/auth/login", json!({"username": "gnome_fan", "password": PW})).await.status,
        StatusCode::OK
    );

    // Password change: wrong current → 422; success revokes other sessions only.
    let res = c.post("/api/auth/password", json!({"current": "nope nope nope", "next": "a brand new password"})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res.json()["error"]["fields"]["current"].is_string());
    let res = c.post("/api/auth/password", json!({"current": PW, "next": "short"})).await;
    assert!(res.json()["error"]["fields"]["next"].is_string());
    let res = c.post("/api/auth/password", json!({"current": PW, "next": "a brand new password"})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    assert_eq!(c.get("/api/auth/me").await.status, StatusCode::OK, "current session survives");
    assert_eq!(phone.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED, "other sessions revoked");
    let res = phone.post("/api/auth/login", json!({"username": "gnome_fan", "password": PW})).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        phone
            .post("/api/auth/login", json!({"username": "gnome_fan", "password": "a brand new password"}))
            .await
            .status,
        StatusCode::OK
    );

    // Store some synced data, then delete the account.
    let res = c.put("/api/sync/settings", json!({"data": {"version": 1}, "base_updated_at": null})).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = c.delete("/api/auth/account", json!({"password": "wrong password!"})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let res = c.delete("/api/auth/account", json!({"password": "a brand new password"})).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    assert!(res.set_cookie("gnome_auth").unwrap().contains("Max-Age=0"));
    assert_eq!(phone.get("/api/auth/me").await.status, StatusCode::UNAUTHORIZED, "all sessions gone");
    let left: i64 = app
        .state
        .db
        .read(|c| -> Result<i64, gnome_server::db::DbError> {
            Ok(c.query_row(
                "SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM user_settings) + (SELECT count(*) FROM user_sessions)",
                [],
                |r| r.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(left, 0, "user data cascaded away");
    // The name is free again.
    let mut again = app.client();
    again.register("Gnome_Fan", PW).await;
}

#[tokio::test]
async fn registration_validation() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    let res = c.post("/api/auth/register", json!({"username": "a b", "password": "short"})).await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    let v = res.json();
    assert_eq!(v["error"]["code"], "validation_failed");
    assert!(v["error"]["fields"]["username"].is_string());
    assert!(v["error"]["fields"]["password"].is_string());
    assert!(c.cookies.is_empty());
}

#[tokio::test]
async fn registration_can_be_closed() {
    let app = TestApp::new(&[("GNOME_REGISTRATION", "closed")]).await;
    let mut c = app.client();
    let res = c.post("/api/auth/register", json!({"username": "newbie", "password": PW})).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    assert_eq!(app.send(get("/api/config")).await.json()["registration"], "closed");
    // Existing users (e.g. created with the CLI) can still sign in.
    let hash = app.state.passwords.hash_blocking(PW).unwrap();
    app.state
        .db
        .write(move |c| {
            gnome_server::auth::users::insert(c, "operator", &hash, true, 1).map(drop).map_err(|e| match e {
                gnome_server::auth::users::InsertError::Sqlite(e) => gnome_server::db::DbError::from(e),
                gnome_server::auth::users::InsertError::UsernameTaken => unreachable!(),
            })
        })
        .await
        .unwrap();
    let res = c.post("/api/auth/login", json!({"username": "operator", "password": PW})).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["user"]["is_admin"], true);
}

#[tokio::test]
async fn accounts_disabled_means_404() {
    let app = TestApp::new(&[("GNOME_ACCOUNTS", "false")]).await;
    let mut c = app.client();
    for path in ["/api/auth/register", "/api/auth/login", "/api/auth/logout"] {
        let res = c.post(path, json!({"username": "x", "password": "y"})).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.error_code(), "not_found");
    }
    assert_eq!(c.get("/api/auth/me").await.status, StatusCode::NOT_FOUND);
    assert_eq!(c.get("/api/sync/settings").await.status, StatusCode::NOT_FOUND);
    // Anonymous sessions still work.
    assert_eq!(c.post("/api/session", json!({})).await.status, StatusCode::OK);
}

#[tokio::test]
async fn login_backoff_after_repeated_failures() {
    let app = TestApp::new(&[("GNOME_RATE_LIMIT_SCALE", "100")]).await;
    let mut c = app.client();
    c.register("victim", PW).await;
    let mut attacker = app.client().with_ip("198.51.100.66:1");
    for _ in 0..5 {
        let res =
            attacker.post("/api/auth/login", json!({"username": "victim", "password": "guess guess guess"})).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
    // Locked now, even with the right password and from another IP.
    let res = c.post("/api/auth/login", json!({"username": "VICTIM", "password": PW})).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    let retry: u64 = res.header("retry-after").unwrap().parse().unwrap();
    assert!((1..=30).contains(&retry), "{retry}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_guesses_get_only_the_free_attempts() {
    // Each guess comes from its own IP (so the per-IP limit never applies) and all of them are in flight before the
    // first slow password verification finishes: the per-username count must still stop at five.
    let app = TestApp::new(&[]).await;
    app.client().register("target", PW).await;
    let mut guesses = tokio::task::JoinSet::new();
    for i in 0..40u8 {
        let router = app.public.clone();
        guesses.spawn(async move {
            let body = json!({"username": "TARGET", "password": format!("guess number {i}")});
            let peer = format!("198.51.100.{i}:4000").parse().unwrap();
            send_to(&router, json_req(Method::POST, "/api/auth/login", &body), peer).await.status
        });
    }
    let (mut verified, mut locked) = (0, 0);
    while let Some(status) = guesses.join_next().await {
        match status.unwrap() {
            StatusCode::UNAUTHORIZED => verified += 1,
            StatusCode::TOO_MANY_REQUESTS => locked += 1,
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!((verified, locked), (5, 35), "only the free attempts reach the password check");
    // The real password is refused too while the lock lasts, and unknown names are throttled the same way.
    let mut owner = app.client().with_ip("192.0.2.90:1");
    let res = owner.post("/api/auth/login", json!({"username": "target", "password": PW})).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
    let mut prober = app.client().with_ip("192.0.2.91:1");
    for _ in 0..5 {
        let res = prober.post("/api/auth/login", json!({"username": "no_such_user", "password": PW})).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    }
    let res = prober.post("/api/auth/login", json!({"username": "no_such_user", "password": PW})).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS, "no difference between real and unknown names");
}

#[tokio::test]
async fn auth_endpoints_are_rate_limited_per_ip() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client().with_ip("192.0.2.80:1");
    for i in 0..10 {
        let res = c.post("/api/auth/login", json!({"username": format!("user{i}"), "password": "whatever pw"})).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "attempt {i}");
    }
    let res = c.post("/api/auth/login", json!({"username": "user99", "password": "whatever pw"})).await;
    assert_eq!(res.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn sliding_expiry_refreshes_cookie_and_row() {
    let app = TestApp::new(&[]).await;
    let mut c = app.client();
    c.register("slider", PW).await;
    // Pretend the session was last used two hours ago.
    app.state
        .db
        .write(|c| -> Result<usize, gnome_server::db::DbError> {
            Ok(c.execute(
                "UPDATE user_sessions SET last_seen_at = last_seen_at - 7200000, expires_at = expires_at - 7200000",
                [],
            )?)
        })
        .await
        .unwrap();
    let before: i64 = app
        .state
        .db
        .read(|c| -> Result<i64, gnome_server::db::DbError> {
            Ok(c.query_row("SELECT expires_at FROM user_sessions", [], |r| r.get(0))?)
        })
        .await
        .unwrap();
    let res = c.get("/api/auth/me").await;
    assert_eq!(res.status, StatusCode::OK);
    let refreshed = res.set_cookie("gnome_auth").expect("cookie re-issued on sliding refresh");
    assert!(refreshed.contains("Max-Age=2592000"));
    let after: i64 = app
        .state
        .db
        .read(|c| -> Result<i64, gnome_server::db::DbError> {
            Ok(c.query_row("SELECT expires_at FROM user_sessions", [], |r| r.get(0))?)
        })
        .await
        .unwrap();
    assert!(after >= before + 7_000_000, "expiry slid forward");
    // Not refreshed again within the hour.
    assert!(c.get("/api/auth/me").await.set_cookie("gnome_auth").is_none());
}

#[tokio::test]
async fn proxy_session_reads_without_sliding_the_expiry() {
    // The Wisp gateway resolves sessions outside /api/ (no cookie can be re-issued there): it must not slide the
    // stored expiry, or the browser's cookie could expire under a session the server still keeps alive.
    let app = TestApp::new(&[("GNOME_ACCESS_MODE", "accounts")]).await;
    let mut c = app.client();
    c.register("wisp_user", PW).await;
    let age = |state: gnome_server::AppState| async move {
        state
            .db
            .read(|db| -> Result<i64, gnome_server::db::DbError> {
                Ok(db.query_row("SELECT last_seen_at FROM user_sessions", [], |r| r.get(0))?)
            })
            .await
            .unwrap()
    };
    app.state
        .db
        .write(|db| -> Result<usize, gnome_server::db::DbError> {
            Ok(db.execute("UPDATE user_sessions SET last_seen_at = last_seen_at - 7200000", [])?)
        })
        .await
        .unwrap();
    let before = age(app.state.clone()).await;
    let mut headers = http::HeaderMap::new();
    let cookie = format!("gnome_auth={}", c.cookies["gnome_auth"]);
    headers.insert(http::header::COOKIE, cookie.parse().unwrap());
    let client = gnome_server::security::ClientInfo::unknown();
    let session = gnome_server::auth::proxy_session(&app.state, &headers, &client).await.expect("signed in");
    assert!(matches!(session, gnome_server::auth::ProxySession::User(_)));
    assert_eq!(age(app.state.clone()).await, before, "no write from the gateway path");
    // The next API call slides it and re-issues the cookie together.
    let res = c.get("/api/auth/me").await;
    assert!(res.set_cookie("gnome_auth").is_some());
    assert!(age(app.state.clone()).await > before);
}
