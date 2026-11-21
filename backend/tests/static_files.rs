//! Static & SPA serving: negotiation, conditional requests, fallbacks, headers.

mod common;

use std::path::Path;

use axum::body::Body;
use common::*;
use http::{Method, Request, StatusCode};

const INDEX: &str = "<!doctype html><html><head><script>document.documentElement.dataset.theme='dark';</script>\
<script type=\"module\" src=\"/assets/app-abc123.js\"></script></head><body>GNOME SPA</body></html>";
const APP_JS: &str = "console.log('identity');";

fn write(root: &Path, rel: &str, data: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, data).unwrap();
}

fn big_wasm() -> Vec<u8> {
    let mut v = b"\0asm\x01\0\0\0".to_vec();
    v.extend((0..600 * 1024u32).map(|i| (i % 251) as u8));
    v
}

fn site(root: &Path) {
    write(root, "index.html", INDEX.as_bytes());
    write(root, "sw.js", b"self.addEventListener('fetch', () => {});");
    write(root, "assets/app-abc123.js", APP_JS.as_bytes());
    write(root, "assets/app-abc123.js.br", b"BR-BYTES");
    write(root, "assets/app-abc123.js.gz", b"GZ-BYTES");
    write(root, "assets/style-1.css", b"body{}");
    write(root, "assets/style-1.css.gz", b"GZ-CSS");
    write(root, "vendor/scramjet/scramjet.wasm", &big_wasm());
    write(root, "vendor/scramjet/LICENSE", b"AGPL-3.0");
    write(root, "lib/module.mjs", b"export const x = 1;");
    write(root, "manifest.webmanifest", b"{}");
    write(root, "docs/index.html", b"<p>docs</p>");
    write(root, "file name.txt", b"spaces");
    write(root, ".env", b"SECRET=1");
    write(root, "archive.tar.gz", b"standalone gzip");
}

async fn app() -> TestApp {
    TestApp::with_static(&[], site).await
}

fn get_with(path: &str, pairs: &[(&str, &str)]) -> Request<Body> {
    let mut b = req(Method::GET, path);
    for (k, v) in pairs {
        b = b.header(*k, *v);
    }
    b.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn index_with_inline_script_hash_csp() {
    let app = app().await;
    let res = app.send(get("/")).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.text(), INDEX);
    assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(res.header("cache-control"), Some("no-cache"));
    assert!(res.header("etag").unwrap().starts_with('"'));
    let csp = res.header("content-security-policy").unwrap();
    let hashes = gnome_server::security::csp::inline_script_hashes(INDEX);
    assert_eq!(hashes.len(), 1);
    assert!(csp.contains(&format!("script-src 'self' 'wasm-unsafe-eval' {}", hashes[0])), "{csp}");
    assert!(csp.contains("frame-ancestors 'self'"));
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(app.send(get("/index.html")).await.text(), INDEX);
}

#[tokio::test]
async fn precompressed_negotiation() {
    let app = app().await;
    let path = "/assets/app-abc123.js";
    let br = app.send(get_with(path, &[("accept-encoding", "gzip, deflate, br")])).await;
    assert_eq!(br.status, StatusCode::OK);
    assert_eq!(br.body.as_ref(), b"BR-BYTES");
    assert_eq!(br.header("content-encoding"), Some("br"));
    assert_eq!(br.header("vary"), Some("Accept-Encoding"));
    assert_eq!(br.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(br.header("cache-control"), Some("public, max-age=31536000, immutable"));
    assert_eq!(br.header("content-length"), Some("8"));

    let gz = app.send(get_with(path, &[("accept-encoding", "gzip")])).await;
    assert_eq!(gz.body.as_ref(), b"GZ-BYTES");
    assert_eq!(gz.header("content-encoding"), Some("gzip"));

    let excluded = app.send(get_with(path, &[("accept-encoding", "br;q=0, gzip;q=1")])).await;
    assert_eq!(excluded.header("content-encoding"), Some("gzip"));

    let plain = app.send(get(path)).await;
    assert_eq!(plain.text(), APP_JS);
    assert_eq!(plain.header("content-encoding"), None);
    assert_eq!(plain.header("vary"), Some("Accept-Encoding"));

    let tags = [br.header("etag"), gz.header("etag"), plain.header("etag")];
    assert!(
        tags[0] != tags[1] && tags[1] != tags[2] && tags[0] != tags[2],
        "one strong ETag per representation: {tags:?}"
    );

    // Only gzip exists for the CSS.
    let css = app.send(get_with("/assets/style-1.css", &[("accept-encoding", "br, gzip")])).await;
    assert_eq!(css.body.as_ref(), b"GZ-CSS");
    // Files without siblings don't vary.
    assert_eq!(app.send(get("/lib/module.mjs")).await.header("vary"), None);
}

#[tokio::test]
async fn conditional_requests() {
    let app = app().await;
    let path = "/assets/app-abc123.js";
    let first = app.send(get_with(path, &[("accept-encoding", "br")])).await;
    let etag = first.header("etag").unwrap().to_string();
    let res = app.send(get_with(path, &[("accept-encoding", "br"), ("if-none-match", &etag)])).await;
    assert_eq!(res.status, StatusCode::NOT_MODIFIED);
    assert!(res.body.is_empty());
    assert_eq!(res.header("etag"), Some(etag.as_str()));
    assert_eq!(res.header("vary"), Some("Accept-Encoding"));
    assert_eq!(res.header("cache-control"), Some("public, max-age=31536000, immutable"));
    // The br tag does not validate the identity representation.
    let res = app.send(get_with(path, &[("if-none-match", &etag)])).await;
    assert_eq!(res.status, StatusCode::OK);
    // Weak form and lists match too.
    let index_tag = app.send(get("/")).await.header("etag").unwrap().to_string();
    let res = app.send(get_with("/browse", &[("if-none-match", &format!("\"nope\", W/{index_tag}"))])).await;
    assert_eq!(res.status, StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn head_requests() {
    let app = app().await;
    let r = req(Method::HEAD, "/assets/app-abc123.js").body(Body::empty()).unwrap();
    let res = app.send(r).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.body.is_empty());
    assert_eq!(res.header("content-length"), Some(APP_JS.len().to_string().as_str()));
    assert!(res.header("etag").is_some());
    let r = req(Method::HEAD, "/vendor/scramjet/scramjet.wasm").body(Body::empty()).unwrap();
    let res = app.send(r).await;
    assert_eq!(res.header("content-length"), Some(big_wasm().len().to_string().as_str()));
    assert!(res.body.is_empty());
}

#[tokio::test]
async fn spa_fallback_and_reserved_prefixes() {
    let app = app().await;
    for path in ["/browse", "/games/forest-run", "/settings/appearance", "/settings/", "/play/x?y=1"] {
        let res = app.send(get(path)).await;
        assert_eq!(res.status, StatusCode::OK, "{path}");
        assert_eq!(res.text(), INDEX, "{path}");
        assert_eq!(res.header("cache-control"), Some("no-cache"), "{path}");
    }
    for path in ["/missing.png", "/assets/gone-123.js", "/.env"] {
        let res = app.send(get(path)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert!(!res.text().contains("SECRET"), "{path}");
    }
    for path in ["/api", "/api/", "/api/nope", "/admin", "/admin/", "/admin/diagnostics", "/wisp", "/wisp/p/se/"] {
        let res = app.send(get(path)).await;
        assert_eq!(res.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(res.header("content-type"), Some("application/json"), "{path}");
        assert_eq!(res.error_code(), "not_found", "{path}");
    }
    // The gateway answers a plain GET of /wisp/ itself (single-origin mode; a ticket probe without a ticket):
    // JSON 401, never the SPA.
    let res = app.send(get("/wisp/")).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.error_code(), "wisp_ticket_missing");
    // Directory index.
    assert_eq!(app.send(get("/docs/")).await.text(), "<p>docs</p>");
    // Percent-decoding.
    assert_eq!(app.send(get("/file%20name.txt")).await.text(), "spaces");
    // A standalone .gz (no base file) is an ordinary download.
    let res = app.send(get("/archive.tar.gz")).await;
    assert_eq!(res.header("content-type"), Some("application/gzip"));
    assert_eq!(res.header("content-encoding"), None);
    // Unsafe methods on static paths.
    let res = app.send(req(Method::POST, "/index.html").body(Body::empty()).unwrap()).await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.header("allow"), Some("GET, HEAD"));
}

#[tokio::test]
async fn engine_prefixes_get_the_retry_page_never_the_spa() {
    let app = app().await;
    for path in [
        "/~/sj/5f1mx35j/qagtsxe6/https%3A%2F%2Fexample.com%2F",
        "/%7E/sj/5f1mx35j/qagtsxe6/https%3A%2F%2Fexample.com%2F",
        "/uv/service/hvtrs8%2F-ezaopng.aoo%2F",
        "/~/sj/c/f/scramjet.wasm.js",
    ] {
        let res = app.send(get(path)).await;
        assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert_ne!(res.text(), INDEX, "{path}: never the SPA");
        assert!(res.text().contains("Starting the proxy engine"), "{path}");
        assert_eq!(res.header("retry-after"), Some("2"), "{path}");
        assert_eq!(res.header("cache-control"), Some("no-store"), "{path}");
        let csp = res.header("content-security-policy").unwrap();
        assert!(csp.starts_with("default-src 'none'; script-src 'sha256-"), "{path}: {csp}");
        assert!(csp.contains("worker-src 'self'"), "{csp}");
    }
    let r = req(Method::HEAD, "/~/sj/c/f/https%3A%2F%2Fexample.com").body(Body::empty()).unwrap();
    let res = app.send(r).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(res.body.is_empty());
    // Also without a built frontend.
    let bare = TestApp::new(&[]).await;
    assert_eq!(bare.send(get("/~/sj/c/f/x")).await.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn percent_encoded_reserved_prefixes_do_not_reach_the_spa() {
    let app = app().await;
    for path in ["/%61pi/health", "/%61dmin/diagnostics", "/wisp%2Fx"] {
        let res = app.send(get(path)).await;
        assert_ne!(res.text(), INDEX, "{path}");
    }
    let res = app.send(get("/%61pi/health")).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.error_code(), "not_found");
    // Any method: a JSON 404, not the static fallback's 405.
    let post = req(Method::POST, "/%61pi/auth/login").body(Body::empty()).unwrap();
    let res = app.send(post).await;
    assert_eq!((res.status, res.error_code().as_str()), (StatusCode::NOT_FOUND, "not_found"));
}

#[tokio::test]
async fn special_files_and_types() {
    let app = app().await;
    let sw = app.send(get("/sw.js")).await;
    assert_eq!(sw.header("service-worker-allowed"), Some("/"));
    assert_eq!(sw.header("cache-control"), Some("no-cache"));
    assert_eq!(sw.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(app.send(get("/lib/module.mjs")).await.header("content-type"), Some("text/javascript; charset=utf-8"));
    assert_eq!(app.send(get("/manifest.webmanifest")).await.header("content-type"), Some("application/manifest+json"));
    assert_eq!(
        app.send(get("/vendor/scramjet/LICENSE")).await.header("content-type"),
        Some("text/plain; charset=utf-8")
    );
    let wasm = app.send(get("/vendor/scramjet/scramjet.wasm")).await;
    assert_eq!(wasm.status, StatusCode::OK);
    assert_eq!(wasm.header("content-type"), Some("application/wasm"));
    assert_eq!(wasm.header("cache-control"), Some("no-cache"));
    assert_eq!(wasm.body.as_ref(), big_wasm().as_slice(), "large files stream from disk intact");
    let stats = app.state.static_files.stats();
    assert!(stats.available && stats.has_index_html);
    assert_eq!(stats.precompressed, 2);
    assert!(stats.bytes_in_memory < stats.bytes, "the 600 KiB wasm is not held in memory");
}

#[tokio::test]
async fn csp_modes() {
    let ro = TestApp::with_static(&[("GNOME_CSP", "report-only")], site).await;
    let res = ro.send(get("/")).await;
    assert_eq!(res.header("content-security-policy"), Some("frame-ancestors 'self'"));
    assert!(res.header("content-security-policy-report-only").unwrap().contains("script-src 'self'"));
    let off = TestApp::with_static(&[("GNOME_CSP", "off")], site).await;
    let res = off.send(get("/")).await;
    assert_eq!(res.header("content-security-policy"), Some("frame-ancestors 'self'"));
    assert!(res.header("content-security-policy-report-only").is_none());
}

#[tokio::test]
async fn frontend_not_built() {
    let app = TestApp::new(&[]).await; // empty static dir
    for path in ["/", "/browse", "/settings/appearance"] {
        let res = app.send(get(path)).await;
        assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert!(res.text().contains("has not been built"), "{path}");
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    }
    assert_eq!(app.send(get("/api/health")).await.status, StatusCode::OK);

    let missing = TestApp::new(&[("GNOME_STATIC_DIR", "/nonexistent/gnome-static")]).await;
    let res = missing.send(get("/")).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!missing.state.static_files.stats().available);
    let r = req(Method::HEAD, "/").body(Body::empty()).unwrap();
    let res = missing.send(r).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(res.body.is_empty());
}
