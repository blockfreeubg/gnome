//! `GNOME_STATIC_RELOAD` (development only, ARCHITECTURE §3 "Two-origin development"): the static index is rebuilt
//! when a request misses under `/assets/`, `/engine/`, `/sw.js` or `/vendor/` (at most once per second) and when the
//! indexed file of an unhashed path changed, so `npm run dev:engine` works without restarting gnome-server. Without
//! the setting nothing is re-read.

mod common;

use std::path::Path;
use std::time::Duration;

use axum::body::Body;
use common::*;
use gnome_server::static_files::RELOAD_MIN_GAP;
use http::{Method, Request, StatusCode, header};

const PROXY_HOST: &str = "p.gnome.test";

fn w(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn at(path: &str) -> Request<Body> {
    Request::builder().method(Method::GET).uri(path).header(header::HOST, PROXY_HOST).body(Body::empty()).unwrap()
}

async fn app(reload: bool) -> TestApp {
    let flag = if reload { "true" } else { "false" };
    TestApp::with_static(
        &[
            ("GNOME_PROXY_ORIGIN", "http://p.gnome.test"),
            ("GNOME_PUBLIC_ORIGINS", ORIGIN),
            ("GNOME_STATIC_RELOAD", flag),
        ],
        |root| {
            w(root, "index.html", "<!doctype html><title>spa</title>");
            w(root, "sw.js", "/* sw v1 */");
        },
    )
    .await
}

/// Past the minimum gap between two re-indexes (file mtimes also need to move on).
async fn gap() {
    tokio::time::sleep(RELOAD_MIN_GAP + Duration::from_millis(150)).await;
}

#[tokio::test]
async fn a_rebuild_is_picked_up_without_a_restart() {
    let app = app(true).await;
    let root = app.dir.path().join("static");
    // Before the first engine build: "not built"; that miss re-indexes at once (nothing new yet).
    assert_eq!(app.send(at("/engine/")).await.status, StatusCode::SERVICE_UNAVAILABLE);
    w(&root, "engine/index.html", "<!doctype html><meta content=\"%GNOME_APP_ORIGINS%\"><title>engine v1</title>");
    w(&root, "assets/engine-aaaa.js", "/* v1 */");
    gap().await;
    let res = app.send(at("/engine/")).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text());
    assert!(
        res.text().contains("engine v1") && res.text().contains(&format!("content=\"{ORIGIN}\"")),
        "{}",
        res.text()
    );
    assert!(res.header("content-security-policy").unwrap().starts_with("frame-ancestors http://gnome.test;"));
    assert_eq!(app.send(at("/assets/engine-aaaa.js")).await.text(), "/* v1 */");

    // The next build: a new hashed chunk (a miss → re-index), a changed engine-host page and service worker (in
    // memory: noticed by their changed size/mtime).
    gap().await;
    w(&root, "assets/engine-bbbb.js", "/* v2 */");
    w(&root, "engine/index.html", "<!doctype html><title>engine v2, longer</title>");
    w(&root, "sw.js", "/* sw v2, longer */");
    assert_eq!(app.send(at("/assets/engine-bbbb.js")).await.text(), "/* v2 */");
    assert!(app.send(at("/engine/")).await.text().contains("engine v2"));
    gap().await;
    w(&root, "sw.js", "/* sw v3, even longer */");
    let sw = app.send(at("/sw.js")).await;
    assert_eq!(sw.text(), "/* sw v3, even longer */");
    assert_eq!(sw.header("service-worker-allowed"), Some("/"));
    assert!(sw.header("content-security-policy").unwrap().contains("connect-src 'self'"));

    // At most one re-index per second: a miss right after one finds nothing new.
    w(&root, "assets/engine-cccc.js", "/* v3 */");
    assert_eq!(app.send(at("/assets/engine-cccc.js")).await.status, StatusCode::NOT_FOUND);
    gap().await;
    assert_eq!(app.send(at("/assets/engine-cccc.js")).await.status, StatusCode::OK);
    assert!(app.state.static_files.stats().files >= 5);
}

#[tokio::test]
async fn without_the_setting_nothing_is_re_read() {
    let app = app(false).await;
    let root = app.dir.path().join("static");
    assert_eq!(app.send(at("/engine/")).await.status, StatusCode::SERVICE_UNAVAILABLE);
    w(&root, "engine/index.html", "<!doctype html><title>engine</title>");
    w(&root, "assets/x-1234.js", "x");
    w(&root, "sw.js", "/* sw v2 that is longer */");
    gap().await;
    assert_eq!(app.send(at("/engine/")).await.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(app.send(at("/assets/x-1234.js")).await.status, StatusCode::NOT_FOUND);
    assert_eq!(app.send(at("/sw.js")).await.text(), "/* sw v1 */", "the in-memory copy is served");
}

#[tokio::test]
async fn app_role_misses_of_proxy_paths_do_not_reindex() {
    let app = app(true).await;
    let root = app.dir.path().join("static");
    // The app origin 404s /engine/** in two-origin mode whatever the build has: nothing to re-index for.
    let app_req = || get("/engine/");
    assert_eq!(app.send(app_req()).await.status, StatusCode::NOT_FOUND);
    w(&root, "engine/index.html", "<!doctype html><title>engine</title>");
    // A proxy-role miss right away re-indexes (the app-role miss did not use up the once-per-second budget).
    assert_eq!(app.send(at("/engine/")).await.status, StatusCode::OK);
}
