//! The frame policy, the wrapper `/play-frame/<slug>` and the app-origin headers (WAVE-C D2–D5, §4.5).

mod common;

use std::sync::Arc;

use common::games::{self, PROXY_ORIGIN, T0};
use common::*;
use gnome_catalog::ManualClock;
use gnome_server::games::GamesOptions;
use gnome_server::games::frames::{EMBED_ALLOW, EMBED_SANDBOX, WRAPPER_STYLE};
use gnome_server::security::csp;
use http::{Method, StatusCode};
use serde_json::{Value, json};

const PROXY_HOST: &str = "p.gnome.test";

async fn items(app: &TestApp) -> Vec<Value> {
    app.send(get("/api/games?limit=100")).await.json()["items"].as_array().unwrap().clone()
}

fn exec(app: &TestApp, sql: &str) {
    let conn = rusqlite::Connection::open(app.state.config.db_path()).unwrap();
    conn.execute_batch(sql).unwrap();
}

async fn refresh(app: &TestApp) {
    let g = app.state.ext::<gnome_server::games::Games>().unwrap();
    g.refresh(&app.state).await.unwrap();
}

fn wrapper(src: &str, title: &str, sandbox: &str, allow: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{title} (game)</title><style>{WRAPPER_STYLE}</style></head><body><iframe src=\"{src}\" title=\"{title} (game)\" sandbox=\"{sandbox}\" allow=\"{allow}\" allowfullscreen referrerpolicy=\"strict-origin-when-cross-origin\"></iframe></body></html>"
    )
}

fn esc(s: &str) -> String {
    gnome_server::games::frames::escape_attr(s)
}

#[tokio::test]
async fn wrappers_pending_hosts_and_refusals() {
    let app = games::app(&[]).await;
    games::import_all(&app).await;
    let list = items(&app).await;
    // One game of each source: the wrapper byte for byte, its own embed origin only.
    for source in ["gamepix", "gamedistribution", "playgama"] {
        let g = list.iter().find(|g| g["source"] == source).unwrap();
        let slug = g["slug"].as_str().unwrap();
        let d = app.send(get(&format!("/api/games/{slug}"))).await.json()["game"].clone();
        let embed = d["embed_url"].as_str().unwrap();
        let host = embed.trim_start_matches("https://").split('/').next().unwrap();
        let res = app.send(get(&format!("/play-frame/{slug}"))).await;
        assert_eq!(res.status, StatusCode::OK, "{source}");
        assert_eq!(d["embed_allowed"], true, "{source}");
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("cache-control"), Some("no-store"));
        assert_eq!(res.header("x-frame-options"), Some("SAMEORIGIN"));
        assert_eq!(res.header("content-security-policy"), Some(csp::wrapper_csp(&format!("https://{host}")).as_str()));
        assert_eq!(res.header("cross-origin-opener-policy"), Some("same-origin"));
        assert_eq!(res.header("permissions-policy"), Some(csp::PERMISSIONS_POLICY));
        let title = esc(d["title"].as_str().unwrap());
        assert_eq!(res.text(), wrapper(&esc(embed), &title, EMBED_SANDBOX, EMBED_ALLOW), "{source}");
        let head =
            app.send(req(Method::HEAD, &format!("/play-frame/{slug}")).body(axum::body::Body::empty()).unwrap()).await;
        assert_eq!(head.status, StatusCode::OK);
        assert!(head.body.is_empty());
    }
    // The real Playgama capture's developer-hosted game: pending until the operator approves the host.
    let dd = list.iter().find(|g| g["source"] == "playgama").map(|_| ()).and_then(|_| {
        let conn = rusqlite::Connection::open(app.state.config.db_path()).unwrap();
        conn.query_row("SELECT slug FROM games WHERE embed_url LIKE 'https://deadlydescent.net/%'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    });
    let dd = dd.expect("the capture has the deadlydescent.net game");
    let d = app.send(get(&format!("/api/games/{dd}"))).await.json();
    assert_eq!(d["game"]["embed_allowed"], false);
    let res = app.send(get(&format!("/play-frame/{dd}"))).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.header("content-security-policy"), Some("default-src 'none'; frame-ancestors 'self'"));
    assert!(res.header("content-type").unwrap().starts_with("text/html"));
    let diag = app.send_admin(games::admin_get("/admin/diagnostics")).await.json();
    let pending = &diag["games"]["embed_hosts"]["pending"];
    assert_eq!(pending, &json!([{"host": "deadlydescent.net", "games": 1}]), "{}", diag["games"]["embed_hosts"]);
    assert_eq!(
        diag["games"]["embed_hosts"]["fixed"],
        json!(["html5.gamedistribution.com", "play.gamepix.com", "playgama.com"])
    );

    // A record naming this instance's own hosts is refused; dot segments and encoded separators too.
    let gp: Vec<&Value> = list.iter().filter(|g| g["source"] == "gamepix").collect();
    let (a, b, c, e) = (
        gp[0]["id"].as_i64().unwrap(),
        gp[1]["id"].as_i64().unwrap(),
        gp[2]["id"].as_i64().unwrap(),
        gp[3]["id"].as_i64().unwrap(),
    );
    exec(&app, &format!("UPDATE games SET embed_url = 'https://p.gnome.test/x' WHERE id = {a}"));
    exec(&app, &format!("UPDATE games SET embed_url = 'https://play.gamepix.com/a/%2E%2e/b' WHERE id = {b}"));
    exec(&app, &format!("UPDATE games SET embed_url = 'https://play.gamepix.com/a/../b' WHERE id = {c}"));
    exec(&app, &format!("UPDATE games SET embed_url = 'https://play.gamepix.com/a%5cb' WHERE id = {e}"));
    for g in &gp[..4] {
        let slug = g["slug"].as_str().unwrap();
        assert_eq!(app.send(get(&format!("/play-frame/{slug}"))).await.status, StatusCode::NOT_FOUND, "{slug}");
        assert_eq!(app.send(get(&format!("/api/games/{slug}"))).await.json()["game"]["embed_allowed"], false);
    }
    refresh(&app).await;
    let diag = app.send_admin(games::admin_get("/admin/diagnostics")).await.json();
    assert_eq!(diag["games"]["embed_hosts"]["refused"], json!([{"host": "p.gnome.test", "games": 1}]));
    let m = app.send_admin(games::admin_get("/admin/metrics")).await.text();
    assert!(m.contains("gnome_games_embed_hosts{state=\"pending\"} 1"), "{m}");
    assert!(m.contains("gnome_games_embed_hosts{state=\"refused\"} 1"), "{m}");
    assert_eq!(app.send(get("/play-frame/no-such-game")).await.status, StatusCode::NOT_FOUND);

    // Approved by the operator: framed from exactly that origin.
    let approved = games::app(&[("GNOME_GAMES_EMBED_HOSTS", "deadlydescent.net")]).await;
    games::import_all(&approved).await;
    let res = approved.send(get(&format!("/play-frame/{dd}"))).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.header("content-security-policy"), Some(csp::wrapper_csp("https://deadlydescent.net").as_str()));
    assert_eq!(approved.send(get(&format!("/api/games/{dd}"))).await.json()["game"]["embed_allowed"], true);
    let diag = approved.send_admin(games::admin_get("/admin/diagnostics")).await.json();
    assert_eq!(diag["games"]["embed_hosts"]["approved_in_use"], json!(["deadlydescent.net"]));
    assert_eq!(diag["games"]["embed_hosts"]["pending"], json!([]));
}

const MANIFEST: &str = r#"
[[games]]
slug = "gnome-test-blocks"
title = "GNOME Test Blocks"
license = "AGPL-3.0-only"
license_file = "LICENSE"
copyright = "Copyright (c) 2026 the GNOME authors"
author = "GNOME"
entry = "index.html"
build = "static"
thumbnail = "thumb.png"
categories = ["puzzle"]
enabled = true
local = true
gamepad = true

[[games]]
slug = "gnome-test-isolated"
title = "GNOME Test Isolated"
license = "AGPL-3.0-only"
license_file = "LICENSE"
copyright = "Copyright (c) 2026 the GNOME authors"
author = "GNOME"
entry = "play.html"
build = "static"
categories = ["arcade"]
enabled = true
local = true
isolated = true
pointer_lock = true
"#;

/// An app with the `oss` source over a test manifest of two `local` builds (GNOME's own test files).
pub async fn oss_app() -> (TestApp, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let builds = dir.path().join("builds");
    for (slug, entry) in [("gnome-test-blocks", "index.html"), ("gnome-test-isolated", "play.html")] {
        let b = builds.join(slug);
        std::fs::create_dir_all(b.join("js")).unwrap();
        std::fs::write(b.join(entry), "<!doctype html><title>test</title><script src=js/game.js></script>").unwrap();
        std::fs::write(b.join("js/game.js"), "console.log('test game');").unwrap();
        std::fs::write(b.join("LICENSE"), "GNU AFFERO GENERAL PUBLIC LICENSE (test copy)").unwrap();
        std::fs::write(b.join("thumb.png"), b"\x89PNG\r\n\x1a\nfake").unwrap();
        std::fs::write(b.join("demo.html"), "<!doctype html><title>unreviewed demo</title>").unwrap();
        std::fs::write(b.join("data.xml"), "<x/>").unwrap();
        std::fs::write(b.join(".hidden"), "secret").unwrap();
        std::fs::write(b.join("logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
    }
    let manifest = dir.path().join("oss.toml");
    std::fs::write(&manifest, MANIFEST).unwrap();
    let (m, b) = (manifest.display().to_string(), builds.display().to_string());
    let vars = vec![
        ("GNOME_PROXY_ORIGIN", PROXY_ORIGIN),
        ("GNOME_PUBLIC_ORIGINS", ORIGIN),
        ("GNOME_CATALOG_SOURCES", "oss"),
        ("GNOME_OSS_MANIFEST", m.as_str()),
        ("GNOME_OSS_GAMES_DIR", b.as_str()),
    ];
    let options = GamesOptions { clock: Some(Arc::new(ManualClock::new(T0))), ..GamesOptions::default() };
    let app = games::app_with(&vars, |_| {}, options).await;
    games::import_all(&app).await;
    (app, dir)
}

#[tokio::test]
async fn oss_wrappers_and_details() {
    let (app, _dir) = oss_app().await;
    let d = app.send(get("/api/games/gnome-test-blocks")).await.json();
    assert_eq!(d["game"]["embed_allowed"], true, "{d}");
    assert_eq!(
        d["game"]["oss"],
        json!({"repository": null, "commit": null, "license_file_url": "http://p.gnome.test/oss/gnome-test-blocks/LICENSE"})
    );
    assert_eq!(d["game"]["source_url"], Value::Null, "a local build has no repository");
    assert_eq!(d["game"]["thumbnail"], "http://p.gnome.test/oss/gnome-test-blocks/thumb.png");
    let res = app.send(get("/play-frame/gnome-test-blocks")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.header("content-security-policy"),
        Some(csp::wrapper_csp("http://p.gnome.test/oss/gnome-test-blocks/").as_str())
    );
    let src = "http://p.gnome.test/oss/gnome-test-blocks/index.html";
    assert_eq!(
        res.text(),
        wrapper(src, "GNOME Test Blocks", "allow-scripts allow-same-origin allow-forms", "autoplay; gamepad")
    );
    let iso = app.send(get("/play-frame/gnome-test-isolated")).await.text();
    assert!(iso.contains("sandbox=\"allow-scripts allow-pointer-lock\" allow=\"autoplay\""), "{iso}");
    assert!(!iso.contains("allow-same-origin"));
}

#[tokio::test]
async fn oss_files_on_the_proxy_role() {
    let (app, _dir) = oss_app().await;
    let send = |path: &str, dest: Option<&str>| {
        let mut b = http::Request::builder().uri(path).header("host", PROXY_HOST);
        if let Some(d) = dest {
            b = b.header("sec-fetch-dest", d);
        }
        send_to(&app.public, b.body(axum::body::Body::empty()).unwrap(), "203.0.113.10:4000".parse().unwrap())
    };
    let app_origins = ["http://gnome.test"];
    let entry = send("/oss/gnome-test-blocks/index.html", Some("iframe")).await;
    assert_eq!(entry.status, StatusCode::OK);
    assert_eq!(entry.header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(
        entry.header("content-security-policy"),
        Some(csp::oss_document_csp(&app_origins, false, false).as_str())
    );
    assert!(entry.header("x-frame-options").is_none());
    assert_eq!(entry.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(entry.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(entry.header("cache-control"), Some("public, max-age=3600"));
    assert_eq!(entry.header("accept-ranges"), Some("none"));
    let etag = entry.header("etag").unwrap().to_string();
    assert!(etag.starts_with("W/\""), "a hand-copied build has a weak ETag: {etag}");
    for dest in [Some("document"), Some("empty"), None] {
        assert_eq!(send("/oss/gnome-test-blocks/index.html", dest).await.status, StatusCode::NOT_FOUND, "{dest:?}");
    }
    let iso = send("/oss/gnome-test-isolated/play.html", Some("frame")).await;
    assert_eq!(iso.header("content-security-policy"), Some(csp::oss_document_csp(&app_origins, true, true).as_str()));
    assert!(iso.header("content-security-policy").unwrap().ends_with("; sandbox allow-scripts allow-pointer-lock"));
    let js = send("/oss/gnome-test-blocks/js/game.js", Some("script")).await;
    assert_eq!(js.status, StatusCode::OK);
    assert_eq!(js.header("content-security-policy"), Some(csp::proxy_script_csp(&app_origins).as_str()));
    let lic = send("/oss/gnome-test-blocks/LICENSE", None).await;
    assert_eq!(lic.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(lic.header("content-security-policy"), Some(csp::proxy_inert_csp(&app_origins).as_str()));
    let svg = send("/oss/gnome-test-blocks/logo.svg", Some("image")).await;
    assert_eq!(svg.header("content-type"), Some("image/svg+xml"));
    assert_eq!(svg.header("content-security-policy"), Some(csp::proxy_inert_csp(&app_origins).as_str()));
    // 304 and HEAD.
    let again = send_to(
        &app.public,
        http::Request::builder()
            .uri("/oss/gnome-test-blocks/js/game.js")
            .header("host", PROXY_HOST)
            .header("if-none-match", js.header("etag").unwrap())
            .body(axum::body::Body::empty())
            .unwrap(),
        "203.0.113.10:4000".parse().unwrap(),
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_MODIFIED);
    let head = send_to(
        &app.public,
        http::Request::builder()
            .method(Method::HEAD)
            .uri("/oss/gnome-test-blocks/LICENSE")
            .header("host", PROXY_HOST)
            .body(axum::body::Body::empty())
            .unwrap(),
        "203.0.113.10:4000".parse().unwrap(),
    )
    .await;
    assert_eq!(head.status, StatusCode::OK);
    assert!(head.body.is_empty());
    // Refusals.
    let build = app.state.config.catalog.oss.builds_dir.join("gnome-test-blocks");
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc/hostname", build.join("link.txt")).unwrap();
    std::fs::create_dir_all(build.join("dir")).unwrap();
    for path in [
        "/oss/gnome-test-blocks/demo.html",
        "/oss/gnome-test-blocks/data.xml",
        "/oss/gnome-test-blocks/%2e%2e/gnome-test-isolated/play.html",
        "/oss/gnome-test-blocks/js/..%2fgame.js",
        "/oss/gnome-test-blocks/.gnome-oss.json",
        "/oss/gnome-test-blocks/.hidden",
        "/oss/gnome-test-blocks/link.txt",
        "/oss/gnome-test-blocks/dir",
        "/oss/gnome-test-blocks/missing.js",
        "/oss/no-such-game/index.html",
    ] {
        let res = send(path, Some("iframe")).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert!(res.header("content-security-policy").unwrap().starts_with("default-src 'none'"), "{path}");
    }
    // The app role never serves /oss/ (nor the SPA shell for it).
    let on_app = app.send(get("/oss/gnome-test-blocks/LICENSE")).await;
    assert_eq!(on_app.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn single_origin_mode_gates_oss_off() {
    let app = TestApp::new(&[("GNOME_CATALOG_SOURCES", "gamepix,oss")]).await;
    assert!(!app.state.config.catalog.sources.contains(&gnome_catalog::Source::Oss));
    assert!(app.state.config.warnings.iter().any(|w| w.starts_with("open-source games need a separate proxy origin")));
    assert_eq!(app.send(get("/oss/2048/index.html")).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn shell_headers_in_every_csp_mode() {
    let write =
        |root: &std::path::Path| std::fs::write(root.join("index.html"), "<!doctype html><title>spa</title>").unwrap();
    for mode in ["on", "report-only", "off"] {
        let app = TestApp::with_static(&games::vars(&[("GNOME_CSP", mode)]), write).await;
        let res = app.send(get("/")).await;
        assert_eq!(res.header("x-frame-options"), Some("DENY"), "{mode}");
        assert_eq!(res.header("cross-origin-opener-policy"), Some("same-origin"), "{mode}");
        let enforced = res.header("content-security-policy").unwrap();
        if mode == "on" {
            assert!(enforced.contains(&format!("; frame-src blob: 'self' {PROXY_ORIGIN};")), "{enforced}");
            assert!(enforced.contains(&format!("; img-src 'self' data: blob: https: {PROXY_ORIGIN};")), "{enforced}");
            assert!(enforced.ends_with("; frame-ancestors 'none'"), "{enforced}");
        } else {
            assert_eq!(enforced, csp::SHELL_FRAME_ANCESTORS_ONLY, "{mode}");
        }
        // JSON keeps the plain framing rule and gets neither COOP nor Permissions-Policy.
        let json = app.send(get("/api/games/categories")).await;
        assert_eq!(json.header("x-frame-options"), Some("SAMEORIGIN"));
        assert!(json.header("cross-origin-opener-policy").is_none() && json.header("permissions-policy").is_none());
    }
}

#[tokio::test]
async fn ads_txt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ads.txt");
    let p = path.display().to_string();
    let app = TestApp::new(&[("GNOME_ADS_TXT", p.as_str())]).await;
    assert_eq!(app.send(get("/ads.txt")).await.status, StatusCode::NOT_FOUND, "missing file");
    std::fs::write(&path, "gamedistribution.com, 0123, DIRECT\n").unwrap();
    let res = app.send(get("/ads.txt")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.header("content-type"), Some("text/plain; charset=utf-8"));
    assert_eq!(res.header("cache-control"), Some("public, max-age=3600"));
    assert_eq!(res.text(), "gamedistribution.com, 0123, DIRECT\n");
    std::fs::write(&path, "x".repeat(65 * 1024)).unwrap();
    assert_eq!(app.send(get("/ads.txt")).await.status, StatusCode::NOT_FOUND, "over 64 KiB");
    let unset = TestApp::new(&[]).await;
    assert_eq!(unset.send(get("/ads.txt")).await.status, StatusCode::NOT_FOUND);
}
