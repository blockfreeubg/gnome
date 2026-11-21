//! Proxy-origin policies (ARCHITECTURE §4.6, docs/WAVE-B.md §6 items 1–5, API.md "Static & SPA"): the engine-host and
//! bare-mux worker policies byte for byte as the TypeScript contract computes them (`tests/fixtures/proxy-origin-csp.json`,
//! generated from `frontend/src/shared/proxy-origin.ts`) with `GNOME_ALLOW_CUSTOM_WISP` off and on, no query
//! parameter changing a header, `GNOME_PROXY_CSP` as a second policy, `%GNOME_APP_ORIGINS%` templating, and a policy
//! at least as strict as the proxied-document one on every other proxy-role response ("no permissive realm"): the
//! contract's `proxyScriptCsp`, `bareMuxWorkerScriptCsp` and `proxyInertCsp`, also read from the fixture.

mod common;

use std::path::Path;

use axum::body::Body;
use common::*;
use http::{Method, Request, StatusCode, header};
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/proxy-origin-csp.json");
const APP: &str = "https://gnome.example.com";
const PROXY_ORIGIN: &str = "https://p.gnome.example.com";
const PROXY_HOST: &str = "p.gnome.example.com";
const ENGINE_HTML: &str = "<!doctype html><meta name=\"gnome-app-origins\" content=\"%GNOME_APP_ORIGINS%\">\
                           <title>engine</title><script src=\"/vendor/scramjet/scramjet.js\"></script>";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

/// The fixture's `engineHostCsp(appOrigins, {customWisp})`.
fn engine_csp(app_origins: &[&str], custom_wisp: bool) -> String {
    let f = fixture();
    let case = f["engineHostCsp"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["appOrigins"] == serde_json::json!(app_origins) && c["customWisp"] == custom_wisp)
        .unwrap_or_else(|| panic!("no fixture case for {app_origins:?} {custom_wisp}"));
    case["csp"].as_str().unwrap().to_string()
}

/// The fixture's `bareMuxWorkerCsp({customWisp})`.
fn worker_csp(custom_wisp: bool) -> String {
    let f = fixture();
    let case = f["bareMuxWorkerCsp"].as_array().unwrap().iter().find(|c| c["customWisp"] == custom_wisp).unwrap();
    case["csp"].as_str().unwrap().to_string()
}

/// The fixture's `<key>(appOrigins)` case for two-origin mode with [`APP`] (and `{customWisp}` when given): what the
/// TypeScript contract computes, so the router is checked against the contract, not against a copy of its formula.
fn contract_csp(key: &str, custom_wisp: Option<bool>) -> String {
    let f = fixture();
    let case = f[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} missing from the fixture: regenerate it"))
        .iter()
        .find(|c| c["appOrigins"] == serde_json::json!([APP]) && custom_wisp.is_none_or(|w| c["customWisp"] == w))
        .unwrap_or_else(|| panic!("no fixture case {key} for {APP} {custom_wisp:?}"));
    case["csp"].as_str().unwrap().to_string()
}

/// `proxyScriptCsp([APP])`: `PROXIED_DOCUMENT_CSP` plus `frame-ancestors 'self' <app>`.
fn script_csp() -> String {
    contract_csp("proxyScriptCsp", None)
}

/// `bareMuxWorkerScriptCsp([APP], {customWisp})`: the script policy, with the opt-in's `ws: wss:` in its
/// `connect-src` (both policies are enforced, so without it the opt-in would never reach the worker).
fn worker_script_csp(custom_wisp: bool) -> String {
    contract_csp("bareMuxWorkerScriptCsp", Some(custom_wisp))
}

fn w(root: &Path, rel: &str, body: &[u8]) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

fn frontend(root: &Path) {
    w(root, "index.html", b"<!doctype html><title>spa</title>");
    w(root, "engine/index.html", ENGINE_HTML.as_bytes());
    w(root, "engine/uv.config.js", b"self.__uv$config = {};");
    w(root, "sw.js", b"importScripts('/vendor/bare-mux/index.js');");
    w(root, "vendor/bare-mux/worker.js", b"/* bare-mux worker */");
    w(root, "vendor/bare-mux/index.js", b"/* bare-mux */");
    w(root, "vendor/bare-mux/LICENSE", b"MIT");
    w(root, "vendor/scramjet/scramjet.js", b"/* scramjet */");
    w(root, "vendor/scramjet/scramjet.wasm", b"\0asm\x01\0\0\0");
    w(root, "vendor/scramjet/demo.html", b"<!doctype html><script>alert(1)</script>");
    w(root, "assets/app-1a2b3c.js", b"export {};");
    w(root, "assets/app-1a2b3c.css", b"body{}");
    w(root, "assets/font-1a2b3c.woff2", b"wOF2");
}

async fn two_origins(extra: &[(&str, &str)]) -> TestApp {
    let mut vars = vec![("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", APP)];
    vars.extend_from_slice(extra);
    TestApp::with_static(&vars, frontend).await
}

fn at(host: &str, method: Method, path: &str) -> Request<Body> {
    Request::builder().method(method).uri(path).header(header::HOST, host).body(Body::empty()).unwrap()
}

async fn get_at(app: &TestApp, host: &str, path: &str) -> TestResponse {
    app.send(at(host, Method::GET, path)).await
}

fn csps(res: &TestResponse) -> Vec<String> {
    res.headers.get_all("content-security-policy").iter().map(|v| v.to_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn engine_host_and_worker_policies_equal_the_contract() {
    for custom in [false, true] {
        let flag = if custom { "true" } else { "false" };
        let app = two_origins(&[("GNOME_ALLOW_CUSTOM_WISP", flag)]).await;
        for path in ["/engine/", "/engine/index.html", "/engine/tab/1"] {
            let res = get_at(&app, PROXY_HOST, path).await;
            assert_eq!(res.status, StatusCode::OK, "{path}");
            assert_eq!(csps(&res), [engine_csp(&[APP], custom)], "{path} custom={custom}");
            assert_eq!(res.header("x-content-type-options"), Some("nosniff"), "{path}");
            assert_eq!(res.header("referrer-policy"), Some("no-referrer"), "{path}");
            assert_eq!(res.header("cache-control"), Some("no-cache"), "{path}");
            assert_eq!(res.header("x-frame-options"), None, "{path}");
        }
        // The contract's worker policy, then the script policy as a second one (no permissive realm), which carries
        // the opt-in's `ws: wss:` as well.
        let worker = get_at(&app, PROXY_HOST, "/vendor/bare-mux/worker.js").await;
        assert_eq!(csps(&worker), [worker_csp(custom), worker_script_csp(custom)], "custom={custom}");
        for policy in csps(&worker) {
            assert_eq!(policy.contains(" ws: wss:"), custom, "every policy of the worker follows the opt-in: {policy}");
        }
        let config = get_at(&app, HOST, "/api/config").await.json();
        assert_eq!(config["wisp"]["custom_servers"], custom, "{config}");
    }
}

#[tokio::test]
async fn several_app_origins_frame_the_engine_host() {
    let app = TestApp::with_static(
        &[
            ("GNOME_BIND", "127.0.0.1:8080"),
            ("GNOME_PROXY_BIND", "127.0.0.1:8081"),
            ("GNOME_PUBLIC_ORIGINS", "http://127.0.0.1:8080,http://127.0.0.1:5173"),
            ("GNOME_ADMIN_BIND", ""),
        ],
        frontend,
    )
    .await;
    let res = get_at(&app, "127.0.0.1:8081", "/engine/").await;
    assert_eq!(csps(&res), [engine_csp(&["http://127.0.0.1:8080", "http://127.0.0.1:5173"], false)]);
    assert!(
        res.text().contains("content=\"http://127.0.0.1:8080 http://127.0.0.1:5173\""),
        "the template lists the same origins: {}",
        res.text()
    );
}

/// Escaped code can load any same-origin URL in a hidden frame, so no query parameter may change a policy.
#[tokio::test]
async fn no_query_parameter_changes_a_header() {
    let app = two_origins(&[]).await;
    let queries = [
        "?wisp=wss://evil.example/",
        "?wisp=ws:%20wss:&customWisp=true",
        "?customWisp=1&custom_servers=true",
        "?csp=connect-src%20*",
        "?t=w1.1.x.y&/",
        "?%GNOME_APP_ORIGINS%=https://evil.example",
    ];
    for path in ["/engine/", "/vendor/bare-mux/worker.js", "/sw.js", "/~/sj/x/y", "/api/health", "/nope"] {
        let plain = get_at(&app, PROXY_HOST, path).await;
        let mut base: Vec<(String, String)> = plain
            .headers
            .iter()
            .filter(|(n, _)| *n != header::DATE && n.as_str() != "x-request-id")
            .map(|(n, v)| (n.to_string(), v.to_str().unwrap().to_string()))
            .collect();
        base.sort();
        for q in queries {
            let res = get_at(&app, PROXY_HOST, &format!("{path}{q}")).await;
            let mut got: Vec<(String, String)> = res
                .headers
                .iter()
                .filter(|(n, _)| *n != header::DATE && n.as_str() != "x-request-id")
                .map(|(n, v)| (n.to_string(), v.to_str().unwrap().to_string()))
                .collect();
            got.sort();
            assert_eq!(got, base, "{path}{q}");
            assert_eq!(res.body, plain.body, "{path}{q}");
        }
    }
}

#[tokio::test]
async fn operator_policy_is_a_second_header() {
    let app = two_origins(&[("GNOME_PROXY_CSP", "img-src 'self'; script-src 'self'")]).await;
    let res = get_at(&app, PROXY_HOST, "/engine/").await;
    assert_eq!(csps(&res), [engine_csp(&[APP], false), "img-src 'self'; script-src 'self'".to_string()]);
    // Only engine-host documents get it.
    assert_eq!(csps(&get_at(&app, PROXY_HOST, "/sw.js").await).len(), 1);
    assert_eq!(
        csps(&get_at(&app, PROXY_HOST, "/vendor/bare-mux/worker.js").await),
        [worker_csp(false), worker_script_csp(false)]
    );
    assert_eq!(worker_script_csp(false), script_csp());
}

#[tokio::test]
async fn app_origins_are_templated_into_the_engine_host() {
    // Two-origin mode: the allowed app origins (the same list as frame-ancestors).
    let app = two_origins(&[]).await;
    let res = get_at(&app, PROXY_HOST, "/engine/").await;
    assert!(res.text().contains(&format!("content=\"{APP}\"")), "{}", res.text());
    assert!(!res.text().contains("%GNOME_APP_ORIGINS%"));
    assert_eq!(res.header("content-length"), Some(res.body.len().to_string().as_str()));
    let etag = res.header("etag").unwrap().to_string();
    let again = app
        .send(
            Request::builder()
                .uri("/engine/")
                .header(header::HOST, PROXY_HOST)
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(again.status, StatusCode::NOT_MODIFIED);
    assert_eq!(csps(&again), [engine_csp(&[APP], false)], "a 304 keeps the policy");
    // Other HTML is left alone.
    let other = get_at(&app, PROXY_HOST, "/vendor/scramjet/demo.html").await;
    assert_eq!(other.text(), "<!doctype html><script>alert(1)</script>");

    // Single-origin mode with GNOME_PUBLIC_ORIGINS: those origins.
    let single =
        TestApp::with_static(&[("GNOME_PUBLIC_ORIGINS", "https://a.example,https://b.example")], frontend).await;
    let res = single.send(get("/engine/")).await;
    assert!(res.text().contains("content=\"https://a.example https://b.example\""), "{}", res.text());
    assert!(csps(&res)[0].starts_with("frame-ancestors 'self'; "), "{:?}", csps(&res));

    // Single-origin mode without it: the origin each request was addressed to.
    let open = TestApp::with_static(&[], frontend).await;
    let a = open.send(get("/engine/")).await;
    assert!(a.text().contains(&format!("content=\"{ORIGIN}\"")), "{}", a.text());
    let b = open.send(at("other.test:8080", Method::GET, "/engine/")).await;
    assert!(b.text().contains("content=\"http://other.test:8080\""), "{}", b.text());
    assert_ne!(a.header("etag"), b.header("etag"), "the ETag follows the filled-in body");
    let cached = open
        .send(
            Request::builder()
                .uri("/engine/")
                .header(header::HOST, HOST)
                .header(header::IF_NONE_MATCH, a.header("etag").unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(cached.status, StatusCode::NOT_MODIFIED);
    let head = open.send(at(HOST, Method::HEAD, "/engine/")).await;
    assert_eq!((head.status, head.body.len()), (StatusCode::OK, 0));
    assert_eq!(head.header("content-length"), a.header("content-length"));
}

#[tokio::test]
async fn precompressed_copies_of_a_templated_document_are_not_served() {
    let app = TestApp::with_static(&[("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", APP)], |root| {
        frontend(root);
        w(root, "engine/index.html.br", b"stale brotli with the placeholder");
        w(root, "engine/index.html.gz", b"stale gzip with the placeholder");
        w(root, "vendor/scramjet/scramjet.js.br", b"brotli scramjet");
    })
    .await;
    let req = |path: &str| {
        Request::builder()
            .uri(path)
            .header(header::HOST, PROXY_HOST)
            .header(header::ACCEPT_ENCODING, "br, gzip")
            .body(Body::empty())
            .unwrap()
    };
    let res = app.send(req("/engine/")).await;
    assert_eq!(res.header("content-encoding"), None);
    assert!(res.text().contains(&format!("content=\"{APP}\"")));
    assert_eq!(app.send(req("/engine/index.html.br")).await.status, StatusCode::NOT_FOUND);
    // Untemplated files keep their siblings.
    assert_eq!(app.send(req("/vendor/scramjet/scramjet.js")).await.header("content-encoding"), Some("br"));
}

/// The policies of every other proxy-role response: at least as strict as the proxied-document policy, and
/// `default-src 'none'` wherever nothing runs.
#[tokio::test]
async fn every_other_proxy_response_has_a_strict_policy() {
    let ancestors = format!("frame-ancestors 'self' {APP}");
    let script = script_csp();
    let none = contract_csp("proxyInertCsp", None);
    assert!(script.ends_with(&ancestors) && none.ends_with(&ancestors), "{script} / {none}");
    let app = two_origins(&[("GNOME_ALLOW_CUSTOM_WISP", "true")]).await;
    let cases: Vec<(Method, &str, &str)> = vec![
        (Method::GET, "/sw.js", &script),
        (Method::HEAD, "/sw.js", &script),
        (Method::GET, "/engine/uv.config.js", &script),
        (Method::GET, "/vendor/bare-mux/index.js", &script),
        (Method::GET, "/vendor/scramjet/scramjet.js", &script),
        (Method::GET, "/assets/app-1a2b3c.js", &script),
        (Method::GET, "/vendor/scramjet/scramjet.wasm", &none),
        (Method::GET, "/vendor/scramjet/demo.html", &none),
        (Method::GET, "/vendor/bare-mux/LICENSE", &none),
        (Method::GET, "/assets/app-1a2b3c.css", &none),
        (Method::GET, "/assets/font-1a2b3c.woff2", &none),
        (Method::GET, "/api/health", &none),
        (Method::GET, "/api/filters", &none),
        (Method::GET, "/api/filters/easylist", &none),
        (Method::GET, "/api/config", &none),
        (Method::POST, "/api/session", &none),
        (Method::GET, "/wisp/", &none),
        (Method::HEAD, "/wisp/?t=x&/", &none),
        (Method::GET, "/wisp/p/nope/", &none),
        (Method::GET, "/", &none),
        (Method::GET, "/index.html", &none),
        (Method::GET, "/settings", &none),
        (Method::GET, "/nope.js", &none),
        (Method::GET, "/vendor/missing.js", &none),
        (Method::GET, "/engine/missing.js", &none),
        (Method::GET, "/%61pi/x", &none),
        (Method::DELETE, "/sw.js", &none),
        (Method::POST, "/engine/", &none),
    ];
    for (method, path, want) in &cases {
        let res = app.send(at(PROXY_HOST, method.clone(), path)).await;
        assert_eq!(csps(&res), [want.to_string()], "{method} {path} ({})", res.status);
        assert_eq!(res.header("x-frame-options"), None, "{method} {path}");
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"), "{method} {path}");
    }
    // The opt-in widens nothing but the engine host and the worker.
    assert!(!script.contains("ws:") && !none.contains("ws:"));
    // The engine-prefix 503 page: exactly its script by hash and the /sw.js registration.
    for path in ["/~/sj/a/b/c", "/uv/service/hvtrs8-"] {
        let res = get_at(&app, PROXY_HOST, path).await;
        assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
        let csp = csps(&res);
        assert_eq!(csp.len(), 1, "{csp:?}");
        let c = &csp[0];
        assert!(c.starts_with("default-src 'none'; script-src 'sha256-"), "{c}");
        assert!(c.contains(&format!("; worker-src {PROXY_ORIGIN}/sw.js; ")), "{c}");
        assert!(c.ends_with(&ancestors), "{c}");
        assert_eq!(c.matches("'sha256-").count(), 1, "{c}");
        assert!(!c.contains("connect-src") && !c.contains("'self';") && !c.contains("ws:"), "{c}");
    }
    // A 304 keeps its policy too.
    let etag = get_at(&app, PROXY_HOST, "/sw.js").await.header("etag").unwrap().to_string();
    let res = app
        .send(
            Request::builder()
                .uri("/sw.js")
                .header(header::HOST, PROXY_HOST)
                .header(header::IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!((res.status, csps(&res)), (StatusCode::NOT_MODIFIED, vec![script.clone()]));
}

#[tokio::test]
async fn engine_host_not_built_page_is_strict() {
    let app = TestApp::with_static(&[("GNOME_PROXY_ORIGIN", PROXY_ORIGIN), ("GNOME_PUBLIC_ORIGINS", APP)], |root| {
        w(root, "index.html", b"<!doctype html><title>spa</title>");
    })
    .await;
    let res = get_at(&app, PROXY_HOST, "/engine/").await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(res.text().contains("engine host is not part of this build"));
    assert_eq!(
        csps(&res),
        [format!(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors \
             'self' {APP}"
        )]
    );
}

#[tokio::test]
async fn sw_and_vendor_keep_their_cache_rules() {
    let app = two_origins(&[]).await;
    let sw = get_at(&app, PROXY_HOST, "/sw.js").await;
    assert_eq!(sw.header("cache-control"), Some("no-cache"));
    assert_eq!(sw.header("service-worker-allowed"), Some("/"));
    assert_eq!(sw.header("content-type"), Some("text/javascript; charset=utf-8"));
    let worker = get_at(&app, PROXY_HOST, "/vendor/bare-mux/worker.js").await;
    assert_eq!(worker.header("cache-control"), Some("no-cache"));
    assert!(worker.header("etag").is_some());
    let asset = get_at(&app, PROXY_HOST, "/assets/app-1a2b3c.js").await;
    assert_eq!(asset.header("cache-control"), Some("public, max-age=31536000, immutable"));
}
