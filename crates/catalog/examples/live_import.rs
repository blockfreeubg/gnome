//! Live check against the real feeds (development tool; gnome-server uses gnome-net instead).
//!
//! ```text
//! # Full import of one source into a standalone database, then sample queries with timings:
//! cargo run --release --example live_import -- import --db /tmp/catalog.db [--source gamepix] [--limit N]
//! # One request to a source's endpoint to check that the parser handles the live shape (no database writes):
//! cargo run --release --example live_import -- probe --source gamedistribution [--save page.json]
//! ```
//!
//! The [`CurlFetcher`] here shells out to the system `curl` (HTTPS only, no redirects, bounded body), which keeps
//! the crate free of any HTTP/TLS dependency. Configuration comes from the usual `GNOME_*` variables; operator-ID
//! sources are force-enabled for `probe` only, with placeholder IDs (the feeds are public; IDs only matter for
//! embedding).

use std::io::Read as _;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use gnome_catalog::sources::{self, ItemCtx};
use gnome_catalog::{
    BoxFuture, Catalog, CatalogConfig, Clock, FetchError, FetchRequest, FetchResponse, Fetcher, ImportOptions,
    ListQuery, Method, RenderOptions, Sort, Source, TokioClock,
};
use rusqlite::Connection;

/// A [`Fetcher`] backed by the `curl` command-line tool.
struct CurlFetcher;

fn run_curl(req: &FetchRequest) -> Result<FetchResponse, FetchError> {
    if !req.url.starts_with("https://") {
        return Err(FetchError::Blocked(format!("not https: {}", req.url)));
    }
    let dir = tempfile::tempdir().map_err(|e| FetchError::Network(e.to_string()))?;
    let headers_path = dir.path().join("headers");
    let mut cmd = Command::new("curl");
    cmd.arg("-sS")
        .arg("--proto")
        .arg("=https")
        .arg("--compressed")
        .arg("--max-time")
        .arg(req.timeout.as_secs().max(1).to_string())
        .arg("--max-filesize")
        .arg(req.max_body_bytes.to_string())
        .arg("--dump-header")
        .arg(&headers_path)
        .arg("-X")
        .arg(match req.method {
            Method::Get => "GET",
            Method::Post => "POST",
        });
    for (k, v) in &req.headers {
        cmd.arg("-H").arg(format!("{k}: {v}"));
    }
    if req.body.is_some() {
        cmd.arg("--data-binary").arg("@-");
    }
    cmd.arg("--").arg(&req.url).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| FetchError::Network(format!("curl: {e}")))?;
    if let Some(body) = &req.body {
        use std::io::Write as _;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(body).map_err(|e| FetchError::Network(e.to_string()))?;
    }
    drop(child.stdin.take());
    let mut body = Vec::new();
    let limit = req.max_body_bytes as u64 + 1;
    let mut stdout = child.stdout.take().expect("piped stdout");
    (&mut stdout).take(limit).read_to_end(&mut body).map_err(|e| FetchError::Network(e.to_string()))?;
    if body.len() > req.max_body_bytes {
        // Stop the transfer instead of buffering more.
        let _ = child.kill();
        let _ = child.wait();
        return Err(FetchError::BodyTooLarge { limit: req.max_body_bytes });
    }
    drop(stdout);
    let out = child.wait_with_output().map_err(|e| FetchError::Network(e.to_string()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(match out.status.code() {
            Some(28) => FetchError::Timeout,
            Some(63) => FetchError::BodyTooLarge { limit: req.max_body_bytes },
            _ => FetchError::Network(err),
        });
    }
    let raw = std::fs::read_to_string(&headers_path).map_err(|e| FetchError::Network(e.to_string()))?;
    // With redirects off there is one header block; keep the last one anyway.
    let block = raw.split("\r\n\r\n").filter(|b| b.starts_with("HTTP/")).last().unwrap_or("");
    let mut lines = block.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| FetchError::Network("no HTTP status".into()))?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    Ok(FetchResponse { status, headers, body })
}

impl Fetcher for CurlFetcher {
    fn fetch(&self, request: FetchRequest) -> BoxFuture<'_, Result<FetchResponse, FetchError>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || run_curl(&request))
                .await
                .map_err(|e| FetchError::Network(format!("curl task: {e}")))?
        })
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn env_config() -> CatalogConfig {
    let (c, warnings) = CatalogConfig::from_env(|k| std::env::var(k).ok()).expect("catalog configuration");
    for w in warnings {
        eprintln!("warning: {w}");
    }
    c
}

/// Median wall time of `f` over `n` runs, in milliseconds.
fn time_ms<T>(n: usize, mut f: impl FnMut() -> T) -> (f64, T) {
    let mut times = Vec::with_capacity(n);
    let mut last = None;
    for _ in 0..n {
        let t = Instant::now();
        last = Some(f());
        times.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    (times[times.len() / 2], last.expect("n > 0"))
}

async fn import(args: &[String]) {
    let db_path = arg(args, "--db").expect("--db <path>");
    let source = arg(args, "--source").map_or(Source::GamePix, |s| Source::from_id(&s).expect("known source"));
    let limit = arg(args, "--limit").map(|l| l.parse().expect("--limit N"));
    let mut config = env_config();
    if !config.is_enabled(source) {
        panic!("source {source} is not enabled (set GNOME_CATALOG_SOURCES and its operator ID)");
    }
    config.sources.retain(|s| *s == source);
    let conn = Connection::open(&db_path).expect("open database");
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;").unwrap();
    // Same statement cache size as gnome-server's connections.
    conn.set_prepared_statement_cache_capacity(64);
    let fresh: i64 =
        conn.query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'games'", [], |r| r.get(0)).unwrap();
    if fresh == 0 {
        gnome_catalog::init_schema(&conn).expect("schema");
    }
    let render = RenderOptions {
        app_origin: "https://gnome.example.com".into(),
        proxy_origin: "https://p.gnome.example.com".into(),
        thumb_proxy: true,
    };
    let cat = Catalog::new(config, b"live-import-example", render);
    let db = Mutex::new(conn);
    let clock = TokioClock;
    let t = Instant::now();
    let prep = cat.prepare(&mut db.lock().unwrap(), clock.now_ms()).unwrap();
    println!("prepare ({:.0} ms): {prep:?}", t.elapsed().as_secs_f64() * 1000.0);
    if args.first().map(String::as_str) == Some("import") {
        let t = Instant::now();
        let report =
            cat.import(&CurlFetcher, &clock, &db, source, ImportOptions { limit, max_pages: None }).await.unwrap();
        let secs = t.elapsed().as_secs_f64();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        println!("import wall time: {secs:.1} s");
    }

    let mut conn = db.into_inner().unwrap();
    conn.execute_batch("PRAGMA optimize;").unwrap();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    let size = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    println!("database size: {:.1} MiB ({size} bytes)", size as f64 / 1_048_576.0);
    let stats = cat.stats(&conn).unwrap();
    println!("stats: {}", serde_json::to_string(&stats.by_source[source.id()]).unwrap());
    println!("listed: {} / stored: {}", stats.listed, stats.games);
    let ip: Vec<(String, String)> = conn
        .prepare("SELECT title, ip_risk_term FROM games WHERE ip_risk = 1 ORDER BY id LIMIT 12")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let ip_total: i64 = conn.query_row("SELECT count(*) FROM games WHERE ip_risk = 1", [], |r| r.get(0)).unwrap();
    println!("ip_risk: {ip_total} (e.g. {ip:?})");
    let terms: Vec<(String, i64)> = conn
        .prepare("SELECT ip_risk_term, count(*) FROM games WHERE ip_risk = 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 15")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("ip_risk by term: {terms:?}");
    let primary: Vec<(String, i64)> = conn
        .prepare(
            "SELECT category, count(*) FROM game_categories c JOIN games g ON g.id = c.game_id
             WHERE g.listed = 1 AND c.position = 0 GROUP BY 1 ORDER BY 2 DESC",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("primary category distribution (listed): {primary:?}");
    let (ms, cats) = time_ms(20, || cat.categories(&conn, false).unwrap());
    println!(
        "categories ({ms:.2} ms): {:?}",
        cats.iter().map(|c| format!("{}={}", c.slug, c.count)).collect::<Vec<_>>()
    );

    let (ms, r) = time_ms(20, || {
        cat.list(&conn, &ListQuery { q: Some("chess".into()), limit: Some(10), ..ListQuery::default() }).unwrap()
    });
    println!(
        "search 'chess' ({ms:.2} ms): total {} → {:?}",
        r.total,
        r.items.iter().map(|g| &g.title).collect::<Vec<_>>()
    );
    let (ms, r2) = time_ms(20, || {
        cat.list(
            &conn,
            &ListQuery {
                q: Some("chess".into()),
                limit: Some(10),
                cursor: r.next_cursor.clone(),
                ..ListQuery::default()
            },
        )
        .unwrap()
    });
    println!("search 'chess' page 2 ({ms:.2} ms): {:?}", r2.items.iter().map(|g| &g.title).collect::<Vec<_>>());
    let q = ListQuery {
        category: Some("puzzle".into()),
        sort: Some(Sort::Popular),
        limit: Some(48),
        ..ListQuery::default()
    };
    let (ms, r) = time_ms(20, || cat.list(&conn, &q).unwrap());
    println!(
        "category puzzle, popular ({ms:.2} ms): total {} → first {:?}",
        r.total,
        r.items.iter().take(8).map(|g| &g.title).collect::<Vec<_>>()
    );
    let q2 = ListQuery { cursor: r.next_cursor.clone(), ..q.clone() };
    let (ms, _) = time_ms(20, || cat.list(&conn, &q2).unwrap());
    println!("category puzzle, popular, page 2 ({ms:.2} ms)");
    // Keyset cost does not grow with depth: walk to page 40.
    let mut deep = q.clone();
    for _ in 0..39 {
        deep.cursor = cat.list(&conn, &deep).unwrap().next_cursor;
    }
    let (ms, r) = time_ms(20, || cat.list(&conn, &deep).unwrap());
    println!("category puzzle, popular, page 40 ({ms:.2} ms): {} items", r.items.len());
    let (ms, r) = time_ms(20, || {
        cat.list(
            &conn,
            &ListQuery { mobile: true, sort: Some(Sort::Trending), limit: Some(48), ..ListQuery::default() },
        )
        .unwrap()
    });
    println!("mobile only, trending ({ms:.2} ms): total {} (GamePix does not expose a mobile flag)", r.total);
    let (ms, r) = time_ms(20, || {
        cat.list(
            &conn,
            &ListQuery {
                q: Some("zombie".into()),
                category: Some("horror".into()),
                sort: Some(Sort::Popular),
                limit: Some(48),
                ..ListQuery::default()
            },
        )
        .unwrap()
    });
    println!("search 'zombie' in horror, popular ({ms:.2} ms): total {}", r.total);
    let (ms, r) = time_ms(20, || {
        cat.list(&conn, &ListQuery { q: Some("ra".into()), limit: Some(10), ..ListQuery::default() }).unwrap()
    });
    println!(
        "type-ahead 'ra' ({ms:.2} ms): total {} → {:?}",
        r.total,
        r.items.iter().take(5).map(|g| &g.title).collect::<Vec<_>>()
    );
    let (ms, r) = time_ms(20, || {
        cat.list(&conn, &ListQuery { sort: Some(Sort::New), limit: Some(48), ..ListQuery::default() }).unwrap()
    });
    println!(
        "all, new ({ms:.2} ms): total {} → first {:?}",
        r.total,
        r.items.iter().take(5).map(|g| &g.title).collect::<Vec<_>>()
    );
    let (ms, s) = time_ms(20, || cat.sections(&conn, 24).unwrap());
    println!(
        "sections ({ms:.2} ms): featured {} trending {} popular {} new {}; featured[..5] {:?}",
        s.featured.len(),
        s.trending.len(),
        s.popular.len(),
        s.new.len(),
        s.featured.iter().take(5).map(|g| &g.title).collect::<Vec<_>>()
    );
    let (ms, tags) = time_ms(20, || cat.tags(&conn, "", 10, false).unwrap());
    println!("tags ({ms:.2} ms): {:?}", tags.iter().map(|t| format!("{}={}", t.tag, t.count)).collect::<Vec<_>>());
    if let Some(g) = s.popular.first() {
        let (ms, page) = time_ms(20, || cat.game(&conn, &g.slug, 12).unwrap().unwrap());
        println!("detail '{}' ({ms:.2} ms): embed {} · related {}", g.slug, page.game.embed_url, page.related.len());
    }
    let (ms, n) = time_ms(3, || cat.refresh_rankings(&mut conn, TokioClock.now_ms()).unwrap());
    println!("refresh_rankings ({ms:.1} ms): {n} rows changed");
    // Peak resident set size of this process (Linux).
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines().filter(|l| l.starts_with("VmHWM") || l.starts_with("VmRSS")) {
            println!("{line}");
        }
    }
}

async fn probe(args: &[String]) {
    let source = Source::from_id(&arg(args, "--source").expect("--source")).expect("known source");
    let mut c = env_config();
    // Probing reads the public feed once; placeholder IDs only satisfy the enablement gate.
    c.gamedistribution.publisher_id.get_or_insert_with(|| "probe".into());
    c.playgama.clid.get_or_insert_with(|| "probe".into());
    c.gamemonetize.enabled = true;
    c.famobi.affiliate_id.get_or_insert_with(|| "probe".into());
    c.gamemonetize.per_page = 100;
    c.playgama.per_page = 100;
    c.itchio.max_pages = 1;
    if source == Source::Oss {
        let m = sources::oss::load_manifest(&c.oss).unwrap();
        println!("oss manifest: {} entries, {} enabled", m.games.len(), m.games.iter().filter(|g| g.enabled).count());
        return;
    }
    let adapter = sources::adapter(source, &c).unwrap();
    let now = TokioClock.now_ms();
    let mut page = adapter.first(now);
    if source == Source::Js13k {
        // Probe the current year only.
        while let Some(n) = adapter.next(&page, &Default::default(), now) {
            page = n;
        }
    }
    let mut req = adapter.request(&page);
    req.headers.push(("User-Agent".into(), c.user_agent.clone()));
    let t = Instant::now();
    let resp = match arg(args, "--from") {
        // Offline: re-analyze a saved body.
        Some(path) => FetchResponse { status: 200, headers: Vec::new(), body: std::fs::read(path).unwrap() },
        None => CurlFetcher.fetch(req.clone()).await.expect("fetch"),
    };
    println!(
        "{} {} → HTTP {} · {} bytes · {:.0} ms · etag {:?}",
        if req.method == Method::Post { "POST" } else { "GET" },
        req.url,
        resp.status,
        resp.body.len(),
        t.elapsed().as_secs_f64() * 1000.0,
        resp.header("etag")
    );
    if let Some(path) = arg(args, "--save") {
        std::fs::write(&path, &resp.body).unwrap();
    }
    let parsed = adapter.parse(&page, &resp.body).expect("parse");
    let (mut ok, mut rejected, mut ip) = (Vec::new(), Vec::new(), 0);
    for (i, raw) in parsed.items.iter().enumerate() {
        let ctx = ItemCtx { rank: i as u32 + 1, reported_total: parsed.info.reported_total, config: &c };
        match adapter.normalize(raw, &ctx) {
            Ok(g) => {
                ip += usize::from(g.ip_risk_term.is_some());
                ok.push(g);
            }
            Err(e) => rejected.push(e),
        }
    }
    println!(
        "items {} · normalized {} · rejected {} {:?} · ip_risk {ip} · reported total {:?} · next page: {}",
        parsed.items.len(),
        ok.len(),
        rejected.len(),
        rejected.iter().take(3).collect::<Vec<_>>(),
        parsed.info.reported_total,
        adapter.next(&page, &parsed.info, now).map_or("none".into(), |p| p.url)
    );
    if let Some(g) = ok.first() {
        println!(
            "first: {:?} by {:?} · {:?} · embed {} · thumb {:?} · tags {:?} · flags {:?}",
            g.title, g.developer, g.categories, g.embed_url, g.thumbnail_url, g.tags, g.flags
        );
    }
    let mut cats = std::collections::BTreeMap::new();
    let mut tags = std::collections::BTreeMap::new();
    for g in &ok {
        *cats.entry(g.categories[0].slug()).or_insert(0) += 1;
        for t in &g.tags {
            *tags.entry(t.clone()).or_insert(0) += 1;
        }
    }
    println!("primary categories: {cats:?}");
    let mut tags: Vec<(String, i32)> = tags.into_iter().collect();
    tags.sort_by_key(|t| std::cmp::Reverse(t.1));
    println!("top tags: {:?}", &tags[..tags.len().min(25)]);
    if args.iter().any(|a| a == "--verbose") {
        for g in ok.iter().filter(|g| g.ip_risk_term.is_some()) {
            println!(
                "  ip_risk: {:?} ← {:?} (tags {:?}, source categories {:?})",
                g.title, g.ip_risk_term, g.tags, g.source_categories
            );
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // `report`: prepare (re-map if the rules changed) + stats + timed queries, without fetching.
        Some("import" | "report") => import(&args).await,
        Some("probe") => probe(&args).await,
        _ => {
            eprintln!(
                "usage: live_import import|report --db PATH [--source gamepix] [--limit N] | probe --source NAME [--save FILE]"
            );
            std::process::exit(2);
        }
    }
}
