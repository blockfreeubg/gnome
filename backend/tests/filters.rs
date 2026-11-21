//! Filter-list service end to end against a local upstream (an in-process HTTP server on an ephemeral 127.0.0.1
//! port): first fetch, conditional GETs, mirrors, `!#include` flattening, the Ghostery resources revision
//! check, failures and backoff, serving on both origins (ETag, 304, br/gzip, `?v=`), restart checks and the admin
//! refresh. No public network.

mod common;

use std::collections::HashMap;
use std::io::Read as _;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::response::{IntoResponse, Response};
use common::{TestResponse, send_to};
use gnome_net::{IpPolicy, SafeClient, SafeClientConfig};
use gnome_server::AppState;
use gnome_server::config::Config;
use gnome_server::filters::refresh::{Mode, Outcome};
use gnome_server::filters::registry::{Category, DEFAULT_MAX_BYTES, Format, ListDef};
use gnome_server::filters::{FilterOptions, FilterService};
use http::{HeaderValue, Method, StatusCode, header};
use sha2::Digest as _;

const APP_HOST: &str = "127.0.0.1:20697";
const PEER: &str = "203.0.113.20:40000";

#[derive(Clone)]
struct Doc {
    status: u16,
    body: Vec<u8>,
    etag: Option<String>,
}

/// `(path, If-None-Match)` of every upstream request.
type RequestLog = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// A tiny upstream: serves `docs` by path, answers `If-None-Match` with 304 and logs every request.
struct Upstream {
    addr: SocketAddr,
    docs: Arc<Mutex<HashMap<String, Doc>>>,
    log: RequestLog,
}

impl Upstream {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind an ephemeral port");
        let addr = listener.local_addr().unwrap();
        let docs: Arc<Mutex<HashMap<String, Doc>>> = Arc::default();
        let log: RequestLog = Arc::default();
        let (d, l) = (docs.clone(), log.clone());
        let app = Router::new().fallback(move |req: Request| {
            let (docs, log) = (d.clone(), l.clone());
            async move {
                let path = req.uri().path().to_string();
                let inm = req.headers().get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).map(str::to_owned);
                log.lock().unwrap().push((path.clone(), inm.clone()));
                let Some(doc) = docs.lock().unwrap().get(&path).cloned() else {
                    return StatusCode::NOT_FOUND.into_response();
                };
                if let (Some(etag), Some(inm)) = (&doc.etag, &inm)
                    && etag == inm
                {
                    let mut r = StatusCode::NOT_MODIFIED.into_response();
                    r.headers_mut().insert(header::ETAG, HeaderValue::from_str(etag).unwrap());
                    return r;
                }
                let mut r = Response::new(Body::from(doc.body));
                *r.status_mut() = StatusCode::from_u16(doc.status).unwrap();
                if let Some(etag) = &doc.etag {
                    r.headers_mut().insert(header::ETAG, HeaderValue::from_str(etag).unwrap());
                }
                r
            }
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { addr, docs, log }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn put(&self, path: &str, body: &[u8], etag: Option<&str>) {
        self.put_status(path, 200, body, etag);
    }

    fn put_status(&self, path: &str, status: u16, body: &[u8], etag: Option<&str>) {
        let doc = Doc { status, body: body.to_vec(), etag: etag.map(str::to_owned) };
        self.docs.lock().unwrap().insert(path.to_string(), doc);
    }

    fn requests(&self, path: &str) -> Vec<Option<String>> {
        self.log.lock().unwrap().iter().filter(|(p, _)| p == path).map(|(_, inm)| inm.clone()).collect()
    }

    fn client(&self) -> SafeClient {
        SafeClient::new(
            SafeClientConfig::default()
                .ip_policy(IpPolicy::strict().allow_loopback(true))
                .allowed_ports([self.addr.port()]),
        )
        .unwrap()
    }
}

fn list(id: &str, category: Category, format: Format, url: String, mirrors: Vec<String>) -> ListDef {
    ListDef {
        id: id.into(),
        name: format!("List {id}"),
        category,
        format,
        url,
        mirrors,
        file: None,
        license: "CC0-1.0".into(),
        homepage: "https://lists.example/".into(),
        default_enabled: id != "mirrored",
        trusted: false,
        max_bytes: DEFAULT_MAX_BYTES,
    }
}

fn sha_hex(data: &[u8]) -> String {
    sha2::Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

const PLAIN_V1: &str =
    "[Adblock Plus 2.0]\n! Title: Plain\n! Version: 202611110001\n! Expires: 2 days\n||ads.example^\n";
const PLAIN_V2: &str =
    "[Adblock Plus 2.0]\n! Title: Plain\n! Version: 202611110002\n! Expires: 2 days\n||ads.example^\n||more.example^\n";

fn resources_json(n: usize) -> String {
    format!(
        r#"{{"redirects":[{{"name":"noop.js","aliases":[],"body":"","contentType":"application/javascript"}}],"scriptlets":[{}]}}"#,
        "{\"name\":\"x\"},".repeat(n).trim_end_matches(',')
    )
}

struct App {
    state: AppState,
    svc: Arc<FilterService>,
    public: Router,
    proxy: Router,
    admin: Router,
}

async fn open(dir: &Path, upstream: &Upstream, lists: Vec<ListDef>, vars: &[(&str, &str)]) -> App {
    let mut map: HashMap<String, String> = HashMap::from([
        ("GNOME_DATA_DIR".into(), dir.join("data").display().to_string()),
        ("GNOME_STATIC_DIR".into(), dir.join("static").display().to_string()),
        ("GNOME_ARGON2_MEMORY_KIB".into(), "1024".into()),
        ("GNOME_BIND".into(), APP_HOST.into()),
        ("GNOME_PROXY_BIND".into(), "127.0.0.1:20698".into()),
        ("GNOME_RATE_LIMIT_SCALE".into(), "0".into()),
    ]);
    for (k, v) in vars {
        map.insert((*k).into(), (*v).into());
    }
    let config = Config::from_lookup(|k| map.get(k).cloned(), None).expect("valid test config");
    let options = FilterOptions { client: Some(upstream.client()), allow_http: true, lists: Some(lists) };
    let state = AppState::open_with(config, move |setup| vec![gnome_server::filters::install(setup, options)])
        .await
        .expect("app opens");
    let svc = state.ext::<FilterService>().unwrap();
    svc.wait_loaded().await;
    App {
        public: gnome_server::router::public(&state),
        proxy: gnome_server::router::proxy(&state),
        admin: gnome_server::router::admin(&state),
        svc,
        state,
    }
}

impl App {
    async fn get(&self, router: &Router, path: &str, headers: &[(&str, &str)]) -> TestResponse {
        let mut b = http::Request::builder().method(Method::GET).uri(path).header(header::HOST, APP_HOST);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        send_to(router, b.body(Body::empty()).unwrap(), PEER.parse().unwrap()).await
    }

    async fn close(self) {
        self.state.shutdown.cancel();
        self.state.tasks.close();
        tokio::time::timeout(Duration::from_secs(10), self.state.tasks.wait()).await.unwrap();
    }
}

fn outcome<'a>(reports: &'a [gnome_server::filters::refresh::ListReport], id: &str) -> &'a Outcome {
    &reports.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("no report for {id}")).outcome
}

fn standard_upstream(up: &Upstream) -> (Vec<ListDef>, String) {
    up.put("/lists/plain.txt", PLAIN_V1.as_bytes(), Some("\"p1\""));
    up.put("/lists/main.txt", b"! Title: Main\n||main.example^\n!#include sub/inc.txt\n||after.example^\n", None);
    up.put("/lists/sub/inc.txt", b"! included\n||included.example^\n", None);
    up.put("/broken/m.txt", b"<!DOCTYPE html><html>challenge</html>", None);
    up.put("/lists/m.txt", b"! Title: Mirrored\nexample.org##.banner\n", Some("\"m1\""));
    let res = resources_json(3);
    let rev = sha_hex(res.as_bytes());
    up.put(
        "/res/metadata.json",
        format!(r#"{{"name":"x","revisions":["{}","{rev}"]}}"#, "0".repeat(64)).as_bytes(),
        None,
    );
    up.put(&format!("/res/{rev}/list.txt"), res.as_bytes(), None);
    let lists = vec![
        list("plain", Category::Ads, Format::Abp, up.url("/lists/plain.txt"), vec![]),
        list("incl", Category::Privacy, Format::Abp, up.url("/lists/main.txt"), vec![]),
        list("mirrored", Category::Annoyances, Format::Abp, up.url("/broken/m.txt"), vec![up.url("/lists/m.txt")]),
        list("res", Category::Resources, Format::Resources, up.url("/res/metadata.json"), vec![]),
    ];
    (lists, rev)
}

#[tokio::test]
async fn fetch_store_serve_and_revalidate() {
    let up = Upstream::start().await;
    let (lists, rev) = standard_upstream(&up);
    let dir = tempfile::tempdir().unwrap();
    let app = open(dir.path(), &up, lists.clone(), &[]).await;

    // Before the first fetch: listed but unavailable; bodies answer 503 with Retry-After.
    let res = app.get(&app.public, "/api/filters", &[]).await;
    assert_eq!(res.status, StatusCode::OK);
    let v = res.json();
    assert_eq!(v["lists"].as_array().unwrap().len(), 3);
    assert_eq!(v["lists"][0]["available"], false);
    assert_eq!(v["lists"][0]["sha256"], serde_json::Value::Null);
    assert_eq!(v["resources"]["id"], "res");
    let res = app.get(&app.public, "/api/filters/plain", &[]).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(res.header("retry-after").is_some());
    assert_eq!(app.get(&app.public, "/api/filters/unknown", &[]).await.status, StatusCode::NOT_FOUND);

    // First refresh: everything is stored.
    let reports = app.svc.refresh(Mode::Due, None).await;
    for id in ["plain", "incl", "mirrored", "res"] {
        assert!(matches!(outcome(&reports, id), Outcome::Updated { .. }), "{id}: {reports:?}");
    }
    // The mirror answered after the primary served an HTML page.
    let m = reports.iter().find(|r| r.id == "mirrored").unwrap();
    assert_eq!(m.source.as_deref(), Some(up.url("/lists/m.txt").as_str()));
    assert_eq!(up.requests("/broken/m.txt").len(), 1);

    let v = app.get(&app.public, "/api/filters", &[]).await.json();
    let plain = &v["lists"][0];
    assert_eq!(plain["id"], "plain");
    assert_eq!(plain["available"], true);
    assert_eq!(plain["size"], PLAIN_V1.len());
    assert_eq!(plain["sha256"], sha_hex(PLAIN_V1.as_bytes()));
    assert_eq!(plain["version"], "202611110001");
    assert_eq!(plain["category"], "ads");
    assert_eq!(plain["format"], "abp");
    assert!(plain["updated_at"].as_i64().unwrap() > 0);
    assert_eq!(v["resources"]["sha256"], rev);
    assert_eq!(v["resources"]["format"], "resources");

    // Flattened include.
    let incl = app.get(&app.public, "/api/filters/incl", &[]).await;
    assert_eq!(incl.text(), "! Title: Main\n||main.example^\n! included\n||included.example^\n||after.example^\n");

    // Identity, brotli and gzip on the app origin and the proxy origin; strong ETags per representation.
    let sha = sha_hex(PLAIN_V1.as_bytes());
    for router in [&app.public, &app.proxy] {
        let res = app.get(router, "/api/filters/plain", &[]).await;
        assert_eq!(res.status, StatusCode::OK);
        assert_eq!(res.text(), PLAIN_V1);
        assert_eq!(res.header("etag").unwrap(), format!("\"{sha}\""));
        assert_eq!(res.header("content-type"), Some("text/plain; charset=utf-8"));
        assert_eq!(res.header("cache-control"), Some("no-cache"));
        assert_eq!(res.header("vary"), Some("Accept-Encoding"));
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));

        let res = app.get(router, "/api/filters/plain", &[("accept-encoding", "gzip, deflate, br")]).await;
        assert_eq!(res.header("content-encoding"), Some("br"));
        assert_eq!(res.header("etag").unwrap(), format!("\"{sha}.br\""));
        let mut decoded = Vec::new();
        brotli::BrotliDecompress(&mut &res.body[..], &mut decoded).unwrap();
        assert_eq!(decoded, PLAIN_V1.as_bytes());

        let res = app.get(router, "/api/filters/plain", &[("accept-encoding", "gzip")]).await;
        assert_eq!(res.header("content-encoding"), Some("gzip"));
        let mut text = String::new();
        flate2::read::GzDecoder::new(&res.body[..]).read_to_string(&mut text).unwrap();
        assert_eq!(text, PLAIN_V1);

        // 304 for any representation's ETag; `?v=<sha>` is immutable.
        for tag in [format!("\"{sha}\""), format!("W/\"{sha}.br\""), format!("\"{sha}.gz\"")] {
            let res = app.get(router, "/api/filters/plain", &[("if-none-match", &tag)]).await;
            assert_eq!(res.status, StatusCode::NOT_MODIFIED, "{tag}");
            assert!(res.body.is_empty());
        }
        let res = app.get(router, &format!("/api/filters/plain?v={sha}"), &[]).await;
        assert_eq!(res.header("cache-control"), Some("public, max-age=31536000, immutable"));
        let res = app.get(router, "/api/filters/plain?v=stale", &[]).await;
        assert_eq!(res.header("cache-control"), Some("no-cache"));

        let res = app.get(router, "/api/filters/res", &[]).await;
        assert_eq!(res.header("content-type"), Some("application/json"));
        assert_eq!(sha_hex(&res.body), rev);
    }
    // The listing itself revalidates.
    let res = app.get(&app.proxy, "/api/filters", &[]).await;
    let etag = res.header("etag").unwrap().to_string();
    assert_eq!(app.get(&app.proxy, "/api/filters", &[("if-none-match", &etag)]).await.status, StatusCode::NOT_MODIFIED);

    // Nothing is due right after a fetch.
    let reports = app.svc.refresh(Mode::Due, None).await;
    assert!(reports.iter().all(|r| r.outcome == Outcome::Skipped), "{reports:?}");

    // Forced check: conditional GET with the stored ETag (304), unconditional for lists with includes, and the
    // resources revision is compared without downloading list.txt again.
    let list_txt = format!("/res/{rev}/list.txt");
    let reports = app.svc.refresh(Mode::All, None).await;
    assert_eq!(outcome(&reports, "plain"), &Outcome::NotModified);
    assert_eq!(up.requests("/lists/plain.txt").last().unwrap().as_deref(), Some("\"p1\""));
    assert_eq!(outcome(&reports, "incl"), &Outcome::Unchanged);
    assert_eq!(up.requests("/lists/main.txt").last().unwrap(), &None);
    assert_eq!(outcome(&reports, "mirrored"), &Outcome::NotModified, "validators kept for the mirror");
    assert_eq!(outcome(&reports, "res"), &Outcome::Unchanged);
    assert_eq!(up.requests(&list_txt).len(), 1);

    // New upstream content: stored, new ETag, the old one no longer matches.
    up.put("/lists/plain.txt", PLAIN_V2.as_bytes(), Some("\"p2\""));
    let reports = app.svc.refresh(Mode::All, Some(&["plain".to_string()])).await;
    assert_eq!(reports.len(), 1);
    let new_sha = sha_hex(PLAIN_V2.as_bytes());
    assert_eq!(outcome(&reports, "plain"), &Outcome::Updated { size: PLAIN_V2.len() as u64, sha256: new_sha.clone() });
    let res = app.get(&app.public, "/api/filters/plain", &[("if-none-match", &format!("\"{sha}\""))]).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.text(), PLAIN_V2);
    assert_eq!(app.get(&app.public, "/api/filters", &[]).await.json()["lists"][0]["version"], "202611110002");

    // Same bytes with a new ETag (GitHub Pages redeploys): unchanged by SHA-256.
    up.put("/lists/plain.txt", PLAIN_V2.as_bytes(), Some("\"p3\""));
    let reports = app.svc.refresh(Mode::All, Some(&["plain".to_string()])).await;
    assert_eq!(outcome(&reports, "plain"), &Outcome::Unchanged);

    // Upstream failure: the stored copy keeps being served; the failure is reported and backs off.
    up.put_status("/lists/plain.txt", 500, b"oops", None);
    let reports = app.svc.refresh(Mode::All, Some(&["plain".to_string()])).await;
    let Outcome::Failed { error } = outcome(&reports, "plain") else { panic!("{reports:?}") };
    assert!(error.contains("HTTP 500"), "{error}");
    assert_eq!(app.get(&app.public, "/api/filters/plain", &[]).await.text(), PLAIN_V2);
    let entry = app.svc.entry("plain").unwrap();
    assert_eq!(entry.meta.failures, 1);
    let wait = entry.meta.next_check_at - entry.meta.last_error_at.unwrap();
    assert_eq!(wait, 15 * 60 * 1000, "first retry after 15 minutes when a copy exists");
    assert!(matches!(app.svc.refresh(Mode::Due, None).await[0].outcome, Outcome::Skipped));

    // Diagnostics and metrics.
    let res = send_to(&app.admin, admin_get("/admin/diagnostics"), "127.0.0.1:50000".parse().unwrap()).await;
    let d = res.json();
    let rows = d["filters"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    let p = rows.iter().find(|r| r["id"] == "plain").unwrap();
    assert_eq!(p["available"], true);
    assert_eq!(p["failures"], 1);
    assert!(p["last_error"].as_str().unwrap().contains("HTTP 500"));
    assert_eq!(p["expires_s"], 2 * 86400);
    assert!(p["size_br"].as_u64().unwrap() > 0 && p["size_gzip"].as_u64().unwrap() > 0);
    let res = send_to(&app.admin, admin_get("/admin/metrics"), "127.0.0.1:50000".parse().unwrap()).await;
    let m = res.text();
    for line in [
        "gnome_filter_list_available{id=\"plain\"} 1",
        &format!("gnome_filter_list_bytes{{id=\"plain\"}} {}", PLAIN_V2.len()),
        "gnome_filter_list_failures{id=\"plain\"} 1",
        "gnome_filter_checks_total{result=\"failed\"} 1",
        "gnome_filter_checks_total{result=\"not_modified\"} 2",
    ] {
        assert!(m.contains(line), "missing {line:?} in:\n{m}");
    }
    assert!(m.contains("gnome_filter_served_total{status=\"304\"}"));
    let page = send_to(&app.admin, admin_get("/admin/"), "127.0.0.1:50000".parse().unwrap()).await.text();
    assert!(page.contains("<td>plain</td><td>ads</td><td>yes</td>"), "{page}");
    assert!(page.contains("1 failed: "), "{page}");
    app.close().await;
}

fn admin_get(path: &str) -> http::Request<Body> {
    http::Request::builder().uri(path).header(header::HOST, "127.0.0.1:9091").body(Body::empty()).unwrap()
}

#[tokio::test]
async fn bad_upstream_content_is_refused() {
    let up = Upstream::start().await;
    up.put("/html.txt", b"   <html><body>Just a moment...</body></html>", None);
    up.put("/empty.txt", b"! Title: nothing\n! only comments\n", None);
    up.put("/big.txt", "||x.example^\n".repeat(200).as_bytes(), None);
    up.put("/escape/main.txt", b"||a^\n!#include ../other/x.txt\n", None);
    up.put("/other/x.txt", b"||b^\n", None);
    up.put("/loop/a.txt", b"||a^\n!#include a.txt\n!#include b.txt\n", None);
    up.put("/loop/b.txt", b"||b^\n!#include a.txt\n", None);
    up.put("/res/metadata.json", format!(r#"{{"revisions":["{}"]}}"#, "a".repeat(64)).as_bytes(), None);
    up.put(&format!("/res/{}/list.txt", "a".repeat(64)), resources_json(1).as_bytes(), None);
    up.put("/res/direct.json", resources_json(2).as_bytes(), None);
    up.put_status("/always-304.txt", 304, b"", None);
    up.put("/fallback.txt", b"||fallback.example^\n", None);
    let mut big = list("big", Category::Ads, Format::Abp, up.url("/big.txt"), vec![]);
    big.max_bytes = 1000;
    let lists = vec![
        list("html", Category::Ads, Format::Abp, up.url("/html.txt"), vec![up.url("/missing.txt")]),
        list("empty", Category::Ads, Format::Abp, up.url("/empty.txt"), vec![]),
        big,
        list("escape", Category::Ads, Format::Abp, up.url("/escape/main.txt"), vec![]),
        list("loop", Category::Ads, Format::Abp, up.url("/loop/a.txt"), vec![]),
        list("bogus304", Category::Ads, Format::Abp, up.url("/always-304.txt"), vec![up.url("/fallback.txt")]),
        list(
            "res",
            Category::Resources,
            Format::Resources,
            up.url("/res/metadata.json"),
            vec![up.url("/res/direct.json")],
        ),
    ];
    let dir = tempfile::tempdir().unwrap();
    let app = open(dir.path(), &up, lists, &[]).await;
    let reports = app.svc.refresh(Mode::Due, None).await;
    let err = |id: &str| match outcome(&reports, id) {
        Outcome::Failed { error } => error.clone(),
        other => panic!("{id}: expected a failure, got {other:?}"),
    };
    let e = err("html");
    assert!(e.contains("HTML") && e.contains("HTTP 404"), "both sources are reported: {e}");
    assert!(err("empty").contains("no rules"));
    assert!(err("big").contains("larger than 1000 bytes"), "{}", err("big"));
    assert!(err("escape").contains("leaves the list's directory"));
    // A 304 to a request without validators says nothing about the content: the mirror is used.
    let r = reports.iter().find(|r| r.id == "bogus304").unwrap();
    assert!(matches!(r.outcome, Outcome::Updated { .. }), "{r:?}");
    assert_eq!(r.source.as_deref(), Some(up.url("/fallback.txt").as_str()));
    // Includes that repeat are inlined once.
    assert!(matches!(outcome(&reports, "loop"), Outcome::Updated { .. }));
    assert_eq!(app.get(&app.public, "/api/filters/loop", &[]).await.text(), "||a^\n||b^\n");
    // The revision did not match the content: the mirror's direct JSON was used instead.
    let r = reports.iter().find(|r| r.id == "res").unwrap();
    assert!(matches!(r.outcome, Outcome::Updated { .. }), "{r:?}");
    assert_eq!(r.source.as_deref(), Some(up.url("/res/direct.json").as_str()));
    // Never-fetched failures retry after 5 minutes...
    let e = app.svc.entry("html").unwrap().meta;
    assert_eq!(e.next_check_at - e.last_error_at.unwrap(), 5 * 60 * 1000);
    assert_eq!(app.get(&app.public, "/api/filters/html", &[]).await.status, StatusCode::SERVICE_UNAVAILABLE);
    // ...and the job honours that: a due check right away leaves upstream alone.
    let asked = up.requests("/html.txt").len();
    let due = app.svc.refresh(Mode::Due, None).await;
    for id in ["html", "empty", "big", "escape", "loop", "res"] {
        assert_eq!(outcome(&due, id), &Outcome::Skipped, "{id}");
    }
    assert_eq!(up.requests("/html.txt").len(), asked);
    // A forced check still goes upstream.
    let all = app.svc.refresh(Mode::All, Some(&["html".to_string()])).await;
    assert!(matches!(outcome(&all, "html"), Outcome::Failed { .. }));
    assert_eq!(up.requests("/html.txt").len(), asked + 1);
    app.close().await;
}

#[tokio::test]
async fn the_default_client_refuses_internal_destinations() {
    // Production options (no test client): loopback, private and http upstreams are refused by gnome-net.
    let dir = tempfile::tempdir().unwrap();
    let config = Config::from_lookup(
        |k| match k {
            "GNOME_DATA_DIR" => Some(dir.path().join("data").display().to_string()),
            "GNOME_STATIC_DIR" => Some(dir.path().join("static").display().to_string()),
            "GNOME_ARGON2_MEMORY_KIB" => Some("1024".into()),
            _ => None,
        },
        None,
    )
    .unwrap();
    let lists = vec![
        list("loop", Category::Ads, Format::Abp, "https://127.0.0.1/x.txt".into(), vec![]),
        list("private", Category::Ads, Format::Abp, "https://10.1.2.3/x.txt".into(), vec![]),
        list("meta", Category::Ads, Format::Abp, "http://169.254.169.254/latest/meta-data".into(), vec![]),
    ];
    let options = FilterOptions { lists: Some(lists), ..FilterOptions::default() };
    let state =
        AppState::open_with(config, move |setup| vec![gnome_server::filters::install(setup, options)]).await.unwrap();
    let svc = state.ext::<FilterService>().unwrap();
    let reports = svc.refresh(Mode::All, None).await;
    for r in &reports {
        let Outcome::Failed { error } = &r.outcome else { panic!("{r:?}") };
        let blocked = error.contains("destination blocked") || error.contains("scheme not allowed: http");
        assert!(blocked, "{}: {error}", r.id);
    }
    state.shutdown.cancel();
}

#[tokio::test]
async fn restart_checks_stored_files_and_drops_removed_lists() {
    let up = Upstream::start().await;
    let (lists, _) = standard_upstream(&up);
    let dir = tempfile::tempdir().unwrap();
    let app = open(dir.path(), &up, lists.clone(), &[]).await;
    app.svc.refresh(Mode::All, None).await;
    let filters = app.svc.dir.clone();
    let before = app.svc.entry("plain").unwrap();
    let files = |id: &str| app.svc.entry(id).unwrap().files.unwrap();
    let (plain_files, incl_files, res_files) = (files("plain"), files("incl"), files("res"));
    // Stored versions are content-addressed.
    let sha1 = sha_hex(PLAIN_V1.as_bytes());
    assert_eq!(plain_files.identity.path, filters.join(format!("plain.{sha1}.txt")));
    assert_eq!(plain_files.br.path, filters.join(format!("plain.{sha1}.txt.br")));
    app.close().await;

    // A lost precompressed file is rebuilt; a damaged plain file makes the list unavailable (and due). Temporary files
    // and files of other versions are removed once they are old; younger ones may be a write in progress in another
    // process and stay.
    std::fs::remove_file(&plain_files.br.path).unwrap();
    std::fs::write(&incl_files.identity.path, b"||tampered^\n").unwrap();
    let (old_tmp, new_tmp) = (filters.join(".plain.a.txt.tmp-123456"), filters.join(".plain.b.txt.tmp-654321"));
    let (old_version, new_version) =
        (filters.join(format!("plain.{}.txt", "e".repeat(64))), filters.join(format!("plain.{}.txt", "f".repeat(64))));
    for p in [&old_tmp, &new_tmp, &old_version, &new_version] {
        std::fs::write(p, b"partial").unwrap();
    }
    for p in [&old_tmp, &old_version] {
        let an_hour_ago = std::time::SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(p).unwrap().set_modified(an_hour_ago).unwrap();
    }
    let app = open(dir.path(), &up, lists[..3].to_vec(), &[]).await;
    let plain = app.svc.entry("plain").unwrap();
    assert!(plain.files.is_some());
    assert_eq!(plain.meta.sha256, before.meta.sha256);
    assert!(plain_files.br.path.is_file());
    let res = app.get(&app.proxy, "/api/filters/plain", &[("accept-encoding", "br")]).await;
    assert_eq!(res.header("content-encoding"), Some("br"));
    assert!(app.svc.entry("incl").unwrap().files.is_none());
    assert_eq!(app.get(&app.public, "/api/filters/incl", &[]).await.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!old_tmp.exists() && !old_version.exists());
    assert!(new_tmp.exists() && new_version.exists());
    // `res` is no longer configured: its files and metadata are gone.
    assert!(!res_files.identity.path.exists() && !res_files.br.path.exists() && !res_files.gzip.path.exists());
    assert!(app.svc.entry("res").is_none());
    let due = app.svc.refresh(Mode::Due, None).await;
    assert!(matches!(outcome(&due, "incl"), Outcome::Updated { .. }), "{due:?}");
    assert_eq!(outcome(&due, "plain"), &Outcome::Skipped);
    assert_eq!(app.get(&app.public, "/api/filters/incl", &[]).await.status, StatusCode::OK);

    // A list replaced by another process (`gnome-server filters refresh` next to the server) is picked up as soon as
    // that process removes the previous version, never served with a stale ETag.
    let other = open_second(dir.path(), &up, lists[..3].to_vec()).await;
    up.put("/lists/plain.txt", PLAIN_V2.as_bytes(), Some("\"p2\""));
    other.svc.refresh(Mode::All, Some(&["plain".to_string()])).await;
    assert!(!plain_files.identity.path.exists(), "the replaced version is removed");
    let sha2 = sha_hex(PLAIN_V2.as_bytes());
    for enc in ["identity", "br"] {
        let res = app.get(&app.public, "/api/filters/plain", &[("accept-encoding", enc)]).await;
        assert_eq!(res.status, StatusCode::OK, "{enc}");
        let etag = res.header("etag").unwrap().trim_matches('"').trim_end_matches(".br").to_string();
        assert_eq!(etag, sha2, "{enc}");
    }
    assert_eq!(app.get(&app.public, "/api/filters/plain", &[]).await.text(), PLAIN_V2);
    assert_eq!(app.get(&app.public, "/api/filters", &[]).await.json()["lists"][0]["sha256"], sha2);
    other.close().await;
    app.close().await;
}

async fn open_second(dir: &Path, up: &Upstream, lists: Vec<ListDef>) -> App {
    open(dir, up, lists, &[]).await
}

#[tokio::test]
async fn admin_refresh_runs_in_the_background() {
    let up = Upstream::start().await;
    let (lists, _) = standard_upstream(&up);
    let dir = tempfile::tempdir().unwrap();
    let app = open(dir.path(), &up, lists, &[("GNOME_FILTERS_REFRESH_HOURS", "0")]).await;
    let req = http::Request::builder()
        .method(Method::POST)
        .uri("/admin/filters/refresh")
        .header(header::HOST, "127.0.0.1:9091")
        .header("x-gnome-request", "1")
        .body(Body::empty())
        .unwrap();
    let res = send_to(&app.admin, req, "127.0.0.1:50000".parse().unwrap()).await;
    assert_eq!(res.status, StatusCode::ACCEPTED);
    assert_eq!(res.json()["job"], "filters.refresh");
    let mut ok = false;
    for _ in 0..100 {
        if app.get(&app.public, "/api/filters/plain", &[]).await.status == StatusCode::OK {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "the admin refresh stored the lists");
    // Admin routes are not on the public or proxy listener.
    let res = send_to(
        &app.proxy,
        http::Request::builder()
            .method(Method::POST)
            .uri("/admin/filters/refresh")
            .header("x-gnome-request", "1")
            .body(Body::empty())
            .unwrap(),
        PEER.parse().unwrap(),
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    app.close().await;
}

#[test]
fn cli_status_and_unknown_ids() {
    let dir = tempfile::tempdir().unwrap();
    let run = |args: &[&str]| {
        std::process::Command::new(env!("CARGO_BIN_EXE_gnome-server"))
            .args(args)
            .env_clear()
            .env("GNOME_DATA_DIR", dir.path().join("data"))
            .env("GNOME_STATIC_DIR", dir.path().join("static"))
            .env("GNOME_LOG", "error")
            .output()
            .unwrap()
    };
    let out = run(&["filters", "status"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("easylist") && text.contains("ubo-resources") && text.contains("not downloaded"), "{text}");
    // Refuses unknown ids before touching the network.
    let out = run(&["filters", "refresh", "no-such-list"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown filter list"));
}

/// Readers hammer a list while this process replaces it again and again: every `200` must be exactly the content its
/// ETag names (and an immutable `?v=<sha>` response exactly that version), a replacement must never leave the index
/// without the new copy, and readers should not see `503`s.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacing_a_list_while_it_is_served() {
    // A deadline instead of a hang if the service ever wedges (the readers yield, so the timer can fire).
    tokio::time::timeout(Duration::from_secs(120), replace_while_serving()).await.expect("finished within 120 s");
}

async fn replace_while_serving() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let up = Upstream::start().await;
    let body = |n: usize| format!("! Title: Busy\n! Version: {n}\n{}", "||busy.example^\n".repeat(20_000 + n));
    up.put("/busy.txt", body(0).as_bytes(), None);
    let lists = vec![list("busy", Category::Ads, Format::Abp, up.url("/busy.txt"), vec![])];
    let dir = tempfile::tempdir().unwrap();
    let app = Arc::new(open(dir.path(), &up, lists, &[]).await);
    app.svc.refresh(Mode::All, None).await;
    let (ok, unavailable, immutable) =
        (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    for n in 1..=12 {
        up.put("/busy.txt", body(n).as_bytes(), None);
        let stop = Arc::new(AtomicBool::new(false));
        let mut readers = tokio::task::JoinSet::new();
        for i in 0..6 {
            let (app, stop, ok, unavailable, immutable) =
                (app.clone(), stop.clone(), ok.clone(), unavailable.clone(), immutable.clone());
            readers.spawn(async move {
                let enc = ["br", "gzip", "identity"][i % 3];
                while !stop.load(Ordering::SeqCst) {
                    // Half of the readers ask for the version the listing names, as the client does (`?v=<sha>`).
                    let mut path = "/api/filters/busy".to_string();
                    let mut pinned = None;
                    if i >= 3 {
                        let listing = app.get(&app.public, "/api/filters", &[]).await.json();
                        if let Some(sha) = listing["lists"][0]["sha256"].as_str() {
                            path = format!("{path}?v={sha}");
                            pinned = Some(sha.to_string());
                        }
                    }
                    let res = app.get(&app.public, &path, &[("accept-encoding", enc)]).await;
                    match res.status {
                        StatusCode::OK => {
                            let decoded = match res.header("content-encoding") {
                                Some("br") => {
                                    let mut d = Vec::new();
                                    brotli::BrotliDecompress(&mut &res.body[..], &mut d).unwrap();
                                    d
                                }
                                Some("gzip") => {
                                    let mut d = Vec::new();
                                    flate2::read::GzDecoder::new(&res.body[..]).read_to_end(&mut d).unwrap();
                                    d
                                }
                                _ => res.body.to_vec(),
                            };
                            let etag = res.header("etag").unwrap().trim_matches('"').split('.').next().unwrap();
                            assert_eq!(sha_hex(&decoded), etag, "a body must match its ETag");
                            if res.header("cache-control") == Some("public, max-age=31536000, immutable") {
                                assert_eq!(pinned.as_deref(), Some(etag), "only the pinned version is immutable");
                                immutable.fetch_add(1, Ordering::SeqCst);
                            }
                            ok.fetch_add(1, Ordering::SeqCst);
                        }
                        StatusCode::SERVICE_UNAVAILABLE => {
                            unavailable.fetch_add(1, Ordering::SeqCst);
                        }
                        other => panic!("unexpected {other}"),
                    }
                    // A request can complete without ever returning `Pending` (an immediate 503): without this the
                    // loop never yields and starves the runtime (the refresh, timers and blocking-pool wakeups).
                    tokio::task::yield_now().await;
                }
            });
        }
        let reports = app.svc.refresh(Mode::All, None).await;
        assert!(matches!(reports[0].outcome, Outcome::Updated { .. }), "{reports:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
        stop.store(true, Ordering::SeqCst);
        while let Some(r) = readers.join_next().await {
            r.unwrap();
        }
        let e = app.svc.entry("busy").unwrap();
        assert!(e.files.is_some(), "round {n}: the new copy must stay available");
        assert_eq!(e.meta.sha256.as_deref(), Some(sha_hex(body(n).as_bytes()).as_str()), "round {n}");
        let res = app.get(&app.public, "/api/filters/busy", &[]).await;
        assert_eq!(res.status, StatusCode::OK, "round {n}");
        assert_eq!(res.text(), body(n));
    }
    let (ok, unavailable, immutable) =
        (ok.load(Ordering::SeqCst), unavailable.load(Ordering::SeqCst), immutable.load(Ordering::SeqCst));
    eprintln!("{ok} bodies served ({immutable} immutable), {unavailable} unavailable answers");
    assert_eq!(unavailable, 0, "a replacement made by this process is never visible as 503");
    assert!(immutable > 0, "the pinned `?v=` path was exercised");
    Arc::try_unwrap(app).ok().expect("no other references").close().await;
}

/// WAVE-B3 §8 (D17): lists read from local files, configured through `GNOME_FILTER_LISTS_FILE` (the real TOML parser):
/// read right after the startup check, served like downloaded lists (`?v=` immutable), re-read on change, a read
/// error keeps the stored version, `ubo-resources` from a file, never a path or OS text in the public listing.
#[tokio::test]
async fn file_lists_are_read_served_and_reread() {
    let up = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let lists_dir = dir.path().join("lists");
    std::fs::create_dir_all(&lists_dir).unwrap();
    let local = lists_dir.join("local.txt");
    let res_file = lists_dir.join("resources.json");
    let missing = lists_dir.join("not-there.txt");
    let v1 = "! gnome-e2e: id=local category=ads\n||ads.localhost^$third-party\n";
    std::fs::write(&local, v1).unwrap();
    let res = resources_json(2);
    std::fs::write(&res_file, &res).unwrap();
    let toml = format!(
        r#"
        [[list]]
        id = "local"
        name = "Local"
        category = "ads"
        file = "{}"
        license = "CC0-1.0"
        default_enabled = true

        [[list]]
        id = "gone"
        name = "Gone"
        category = "privacy"
        file = "{}"
        license = "CC0-1.0"

        [[list]]
        id = "ubo-resources"
        file = "{}"
        "#,
        local.display(),
        missing.display(),
        res_file.display()
    );
    // Only these lists (and the built-in resources entry, replaced by the file): the other built-ins are dropped.
    let defs = gnome_server::filters::registry::apply(
        gnome_server::filters::registry::builtin().into_iter().filter(|l| l.id == "ubo-resources").collect(),
        Path::new("lists.toml"),
        &toml,
    )
    .unwrap();
    assert!(defs.iter().all(|d| d.is_file()));
    let app = open(dir.path(), &up, defs, &[("GNOME_FILTERS_REFRESH_HOURS", "0")]).await;
    // As `serve` does: the file-list job runs at once, also with automatic fetching off.
    app.state.start_jobs();

    // Read right after the startup check, without any refresh request (and nothing went upstream).
    let mut listing = serde_json::Value::Null;
    for _ in 0..100 {
        listing = app.get(&app.public, "/api/filters", &[]).await.json();
        if listing["lists"][0]["available"] == true && listing["resources"]["available"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(up.log.lock().unwrap().is_empty(), "file lists never fetch upstream");
    let l = &listing["lists"][0];
    assert_eq!((l["id"].as_str(), l["available"].as_bool()), (Some("local"), Some(true)), "{listing}");
    let sha1 = sha_hex(v1.as_bytes());
    assert_eq!(l["sha256"], sha1.as_str());
    assert_eq!(l["size"], v1.len());
    assert_eq!(l["homepage"], "", "a file list without a homepage");
    assert!(l["fetched_at"].is_i64(), "fetched_at = the last successful read");
    assert_eq!(listing["resources"]["sha256"], sha_hex(res.as_bytes()).as_str());
    assert_eq!(listing["resources"]["format"], "resources");
    let gone = &listing["lists"][1];
    assert_eq!((gone["id"].as_str(), gone["available"].as_bool()), (Some("gone"), Some(false)));
    // Never a path or OS error text in the public listing.
    let raw = app.get(&app.public, "/api/filters", &[]).await.text();
    for leak in [lists_dir.display().to_string(), "not-there".into(), "No such file".into(), "os error".into()] {
        assert!(!raw.contains(&leak), "the listing shows {leak:?}: {raw}");
    }

    // Served like any list: strong ETag, `?v=<sha256>` immutable, on both origins; resources as JSON.
    let body = app.get(&app.public, &format!("/api/filters/local?v={sha1}"), &[("accept-encoding", "identity")]).await;
    assert_eq!(body.status, StatusCode::OK);
    assert_eq!(body.text(), v1);
    assert_eq!(body.header("etag"), Some(format!("\"{sha1}\"").as_str()));
    assert_eq!(body.header("cache-control"), Some("public, max-age=31536000, immutable"));
    let proxied = app.get(&app.proxy, "/api/filters/local", &[]).await;
    assert_eq!((proxied.status, proxied.header("cache-control")), (StatusCode::OK, Some("no-cache")));
    let r = app.get(&app.public, "/api/filters/ubo-resources", &[]).await;
    assert_eq!((r.status, r.header("content-type")), (StatusCode::OK, Some("application/json")));
    assert_eq!(app.get(&app.public, "/api/filters/gone", &[]).await.status, StatusCode::SERVICE_UNAVAILABLE);

    // The missing file is the list's last error, as a fixed word; diagnostics mark file lists.
    let diag = |app: &App| {
        let req = http::Request::builder()
            .uri("/admin/diagnostics")
            .header(header::HOST, "127.0.0.1:9091")
            .body(Body::empty())
            .unwrap();
        let admin = app.admin.clone();
        async move { send_to(&admin, req, "127.0.0.1:50000".parse().unwrap()).await.json() }
    };
    let d = diag(&app).await;
    let row = |d: &serde_json::Value, id: &str| {
        d["filters"].as_array().unwrap().iter().find(|r| r["id"] == id).cloned().unwrap()
    };
    assert_eq!(row(&d, "gone")["last_error"], "file-missing");
    assert_eq!(row(&d, "gone")["source_kind"], "file");
    assert_eq!(row(&d, "local")["source_kind"], "file");
    assert_eq!(row(&d, "local")["source"], "file", "the path is not recorded");

    // Due-mode runs (the job's ticks) always re-read file lists; the same bytes are "unchanged".
    let reports = app.svc.refresh(Mode::Due, None).await;
    assert_eq!(outcome(&reports, "local"), &Outcome::Unchanged);
    assert_eq!(outcome(&reports, "ubo-resources"), &Outcome::Unchanged);
    assert_eq!(outcome(&reports, "gone"), &Outcome::Failed { error: "file-missing".into() });

    // A changed file is a new version; the old `?v=` URL then gets the current body with no-cache.
    let v2 = "[Adblock Plus 2.0]\n||ads.localhost^$third-party\n||more.localhost^\n";
    std::fs::write(&local, v2).unwrap();
    let reports = app.svc.read_file_lists().await;
    let sha2 = sha_hex(v2.as_bytes());
    assert_eq!(outcome(&reports, "local"), &Outcome::Updated { size: v2.len() as u64, sha256: sha2.clone() });
    let stale = app.get(&app.public, &format!("/api/filters/local?v={sha1}"), &[]).await;
    assert_eq!((stale.text().as_str(), stale.header("cache-control")), (v2, Some("no-cache")));
    assert_eq!(app.get(&app.public, "/api/filters", &[]).await.json()["lists"][0]["sha256"], sha2.as_str());
    assert!(!dir.path().join("data/filters").join(format!("local.{sha1}.txt")).exists(), "the old version is removed");

    // A read error (file gone, then an invalid body) keeps the stored version and records the word.
    std::fs::remove_file(&local).unwrap();
    let reports = app.svc.read_file_lists().await;
    assert_eq!(outcome(&reports, "local"), &Outcome::Failed { error: "file-missing".into() });
    std::fs::write(&local, "||no-header.localhost^\n").unwrap();
    let reports = app.svc.read_file_lists().await;
    assert_eq!(outcome(&reports, "local"), &Outcome::Failed { error: "file-no-header".into() });
    std::fs::write(&res_file, "[]").unwrap();
    let reports = app.svc.read_file_lists().await;
    assert_eq!(outcome(&reports, "ubo-resources"), &Outcome::Failed { error: "file-not-resources".into() });
    let body = app.get(&app.public, "/api/filters/local", &[]).await;
    assert_eq!((body.status, body.text().as_str()), (StatusCode::OK, v2), "the stored version is still served");
    let l = app.get(&app.public, "/api/filters", &[]).await.json();
    assert_eq!(
        (l["lists"][0]["available"].as_bool(), l["lists"][0]["sha256"].as_str()),
        (Some(true), Some(sha2.as_str()))
    );
    assert_eq!(row(&diag(&app).await, "local")["last_error"], "file-no-header");

    // The missing list appears once its file does.
    std::fs::write(&missing, "! late\n||late.localhost^\n").unwrap();
    let reports = app.svc.read_file_lists().await;
    assert!(matches!(outcome(&reports, "gone"), Outcome::Updated { .. }));
    assert_eq!(app.get(&app.public, "/api/filters/gone", &[]).await.status, StatusCode::OK);
    app.close().await;
}

/// `gnome-server filters refresh` (a second process next to a running server) re-reads a file list, and the running
/// server serves the new version (row S5's path).
#[tokio::test]
async fn a_second_process_rereads_a_file_list() {
    let up = Upstream::start().await;
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("local.txt");
    std::fs::write(&local, "! v1\n||one.localhost^\n").unwrap();
    let toml = format!(
        "[[list]]\nid = \"local\"\nname = \"L\"\ncategory = \"ads\"\nfile = \"{}\"\nlicense = \"x\"\n",
        local.display()
    );
    let defs = || gnome_server::filters::registry::apply(Vec::new(), Path::new("t.toml"), &toml).unwrap();
    let app = open(dir.path(), &up, defs(), &[("GNOME_FILTERS_REFRESH_HOURS", "0")]).await;
    app.state.start_jobs();
    let mut ok = false;
    for _ in 0..100 {
        if app.get(&app.public, "/api/filters/local", &[]).await.status == StatusCode::OK {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ok, "read at startup");
    std::fs::write(&local, "! v2\n||two.localhost^\n").unwrap();
    let other = open_second(dir.path(), &up, defs()).await;
    // Like `gnome-server filters refresh`: no jobs run in that process, the refresh reads the file.
    let reports = other.svc.refresh(Mode::All, None).await;
    assert!(matches!(outcome(&reports, "local"), Outcome::Updated { .. }));
    other.close().await;
    assert_eq!(app.get(&app.public, "/api/filters/local", &[]).await.text(), "! v2\n||two.localhost^\n");
    app.close().await;
}

/// The jobs of a running server (WAVE-B3 §8, D17): `filters.files` reads the file lists and nothing else (a URL list
/// is not fetched by it, also with `GNOME_FILTERS_REFRESH_HOURS=0`); a file list's `! Expires` schedules nothing; a
/// forced refresh through the running `filters.refresh` job (`POST /admin/filters/refresh`) re-reads a changed file
/// list and fetches the URL lists.
#[tokio::test]
async fn the_file_job_reads_only_files_and_a_forced_refresh_reads_them_too() {
    let up = Upstream::start().await;
    up.put("/lists/plain.txt", PLAIN_V1.as_bytes(), Some("\"p1\""));
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("local.txt");
    let v1 = "! Title: Local\n! Expires: 1 hours\n||one.localhost^\n";
    std::fs::write(&local, v1).unwrap();
    let toml = format!(
        "[[list]]\nid = \"local\"\nname = \"L\"\ncategory = \"ads\"\nfile = \"{}\"\nlicense = \"x\"\n",
        local.display()
    );
    let mut defs = gnome_server::filters::registry::apply(Vec::new(), Path::new("t.toml"), &toml).unwrap();
    defs.push(list("plain", Category::Ads, Format::Abp, up.url("/lists/plain.txt"), vec![]));
    let app = open(dir.path(), &up, defs, &[("GNOME_FILTERS_REFRESH_HOURS", "0")]).await;
    app.state.start_jobs();
    let files_runs = |app: &App| {
        app.state.jobs.snapshot().iter().find(|j| j.name == gnome_server::filters::FILES_JOB).map_or(0, |j| j.runs)
    };
    // The first run of the file-list job has finished (all of it, not only the file list's part).
    for _ in 0..100 {
        if files_runs(&app) >= 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(files_runs(&app), 1, "filters.files ran once, right after the start");
    let listing = app.get(&app.public, "/api/filters", &[]).await.json();
    let entry = |l: &serde_json::Value, id: &str| {
        l["lists"].as_array().unwrap().iter().find(|x| x["id"] == id).cloned().unwrap()
    };
    assert_eq!(entry(&listing, "local")["sha256"], sha_hex(v1.as_bytes()).as_str());
    assert_eq!(entry(&listing, "plain")["available"], false, "nothing fetched the URL list yet");
    assert!(up.requests("/lists/plain.txt").is_empty(), "the file-list job never fetches a URL list");
    // `! Expires` of a file list is ignored (file lists are re-read at every run of their job).
    let diag = |app: &App| {
        let req = http::Request::builder()
            .uri("/admin/diagnostics")
            .header(header::HOST, "127.0.0.1:9091")
            .body(Body::empty())
            .unwrap();
        let admin = app.admin.clone();
        async move { send_to(&admin, req, "127.0.0.1:50000".parse().unwrap()).await.json() }
    };
    let d = diag(&app).await;
    let local_row = d["filters"].as_array().unwrap().iter().find(|r| r["id"] == "local").cloned().unwrap();
    assert!(local_row["expires_s"].is_null(), "{local_row}");

    // A forced refresh through the running job re-reads the changed file and fetches the URL list.
    let v2 = "! Title: Local\n||one.localhost^\n||two.localhost^\n";
    std::fs::write(&local, v2).unwrap();
    let req = http::Request::builder()
        .method(Method::POST)
        .uri("/admin/filters/refresh")
        .header(header::HOST, "127.0.0.1:9091")
        .header("x-gnome-request", "1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send_to(&app.admin, req, "127.0.0.1:50000".parse().unwrap()).await.status, StatusCode::ACCEPTED);
    let mut listing = serde_json::Value::Null;
    for _ in 0..100 {
        listing = app.get(&app.public, "/api/filters", &[]).await.json();
        if entry(&listing, "local")["sha256"] == sha_hex(v2.as_bytes()).as_str()
            && entry(&listing, "plain")["available"] == true
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(entry(&listing, "local")["sha256"], sha_hex(v2.as_bytes()).as_str(), "the forced refresh read the file");
    assert_eq!(entry(&listing, "plain")["available"], true, "and fetched the URL list: {listing}");
    assert_eq!(files_runs(&app), 1, "the forced refresh ran in filters.refresh, not in the file-list job");
    app.close().await;
}

/// The CLI with a real `GNOME_FILTER_LISTS_FILE` (built-ins disabled, as the e2e runner writes it): `config check`
/// marks the file lists, `filters refresh` reads them without any network, `filters status` shows them stored; a
/// relative path and a path under /proc are configuration errors.
#[test]
fn cli_with_file_lists() {
    let dir = tempfile::tempdir().unwrap();
    let list = dir.path().join("e2e.txt");
    std::fs::write(&list, "! gnome-e2e: id=e2e category=ads trusted=false default=true\n||ads.localhost^\n").unwrap();
    let mut toml: String = gnome_server::filters::registry::builtin()
        .iter()
        .filter(|l| l.id != "ubo-resources")
        .map(|l| format!("[[list]]\nid = \"{}\"\ndisabled = true\n\n", l.id))
        .collect();
    toml.push_str(&format!(
        "[[list]]\nid = \"e2e\"\nname = \"E2E\"\ncategory = \"ads\"\nfile = \"{}\"\nlicense = \"CC0-1.0\"\n\n\
         [[list]]\nid = \"later\"\nname = \"Later\"\ncategory = \"privacy\"\nfile = \"{}\"\nlicense = \"CC0-1.0\"\n\n\
         [[list]]\nid = \"ubo-resources\"\nfile = \"{}\"\n",
        list.display(),
        dir.path().join("later.txt").display(),
        dir.path().join("res.json").display()
    ));
    std::fs::write(dir.path().join("res.json"), resources_json(1)).unwrap();
    let toml_path = dir.path().join("lists.toml");
    std::fs::write(&toml_path, &toml).unwrap();
    let run = |args: &[&str], lists: &Path| {
        std::process::Command::new(env!("CARGO_BIN_EXE_gnome-server"))
            .args(args)
            .env_clear()
            .env("GNOME_DATA_DIR", dir.path().join("data"))
            .env("GNOME_STATIC_DIR", dir.path().join("static"))
            .env("GNOME_FILTER_LISTS_FILE", lists)
            .env("GNOME_LOG", "error")
            .output()
            .unwrap()
    };
    let out = run(&["config", "check"], &toml_path);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("filter lists: 3 ("), "{text}");
    assert!(text.lines().any(|l| l.contains("e2e") && l.contains(" file ") && l.contains("regular file")), "{text}");
    assert!(text.lines().any(|l| l.contains("later") && l.contains("missing or unreadable")), "{text}");
    assert!(text.contains("does not exist or cannot be read"), "the missing file is a warning: {text}");
    let out = run(&["filters", "refresh"], &toml_path);
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "one list (the missing file) failed: {text}");
    assert!(text.lines().any(|l| l.contains("e2e") && l.contains("updated")), "{text}");
    assert!(text.lines().any(|l| l.contains("ubo-resources") && l.contains("updated")), "{text}");
    assert!(text.lines().any(|l| l.contains("later") && l.contains("FAILED: file-missing")), "{text}");
    let out = run(&["filters", "status"], &toml_path);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{text}");
    assert!(text.lines().any(|l| l.contains("e2e") && l.contains("version")), "{text}");
    assert!(!text.contains("easylist"), "built-ins are disabled: {text}");
    for (bad, needle) in
        [("lists/x.txt", "must be an absolute path"), ("/proc/self/environ", "must not be under /proc")]
    {
        let p = dir.path().join("bad.toml");
        std::fs::write(
            &p,
            format!("[[list]]\nid = \"x\"\nname = \"x\"\ncategory = \"ads\"\nlicense = \"x\"\nfile = \"{bad}\"\n"),
        )
        .unwrap();
        let out = run(&["config", "check"], &p);
        assert_eq!(out.status.code(), Some(2), "{bad}");
        assert!(String::from_utf8_lossy(&out.stderr).contains(needle), "{}", String::from_utf8_lossy(&out.stderr));
    }
    // Paths that pass the configuration checks but that the read refuses: `config check` warns (exit 0).
    let huge = dir.path().join("huge.txt");
    std::fs::write(&huge, format!("! huge\n{}", "||h.localhost^\n".repeat(80_000))).unwrap();
    let mut warn_toml = format!(
        "[[list]]\nid = \"huge\"\nname = \"H\"\ncategory = \"ads\"\nlicense = \"x\"\nmax_mb = 1\nfile = \"{}\"\n",
        huge.display()
    );
    #[cfg(unix)]
    let linked = {
        let link = dir.path().join("status.txt");
        std::os::unix::fs::symlink("/proc/self/status", &link).unwrap();
        warn_toml.push_str(&format!(
            "\n[[list]]\nid = \"linked\"\nname = \"L\"\ncategory = \"ads\"\nlicense = \"x\"\nfile = \"{}\"\n",
            link.display()
        ));
        Path::new("/proc/self/status").exists()
    };
    let p = dir.path().join("warn.toml");
    std::fs::write(&p, &warn_toml).unwrap();
    let out = run(&["config", "check"], &p);
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "warnings only: {text}");
    assert!(text.contains("of them read from files: at start, every 10 min"), "{text}");
    assert!(text.contains("is 1.20 MB, more than its max_mb (1 MiB); it is not read"), "{text}");
    assert!(text.lines().any(|l| l.contains("huge") && l.contains("larger than max_mb")), "{text}");
    #[cfg(unix)]
    if linked {
        assert!(text.contains("\"linked\": ") && text.contains("leads to a path under /proc, /sys or /dev"), "{text}");
    }
}
