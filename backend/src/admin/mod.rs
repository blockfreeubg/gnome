//! Admin listener (`GNOME_ADMIN_BIND`, loopback by default): `/admin/` HTML diagnostics, `/admin/diagnostics` JSON,
//! `/admin/metrics` Prometheus text, plus module admin routes. These routes exist only on the admin router.
//!
//! Guard, applied to every admin request:
//! * Rate limited per client IP ([`RateClass::Admin`], 60 / 120 per min), before the token is looked at, so a
//!   remote admin listener cannot be used to guess the token quickly.
//! * With `GNOME_ADMIN_TOKEN`: `Authorization: Bearer <token>` or HTTP Basic with the token as password (so a browser
//!   can open the page), compared in constant time; otherwise `401` with a Basic challenge.
//! * Without a token: only loopback `Host` names are accepted (defeats DNS rebinding against 127.0.0.1).
//! * Non-GET/HEAD requests need `X-GNOME-Request: 1` and a same-host `Origin` if one is sent (CSRF).

mod page;

use std::fmt::Write as _;
use std::net::IpAddr;

use axum::Router;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::VERSION;
use crate::api::meta::SINGLE_ORIGIN_EXPLANATION;
use crate::auth::{sessions, users};
use crate::error::{ApiError, ApiQuery};
use crate::module::Diagnostics;
use crate::security::ClientInfo;
use crate::security::csrf::CSRF_HEADER;
use crate::security::rate_limit::{RateClass, enforce};
use crate::state::AppState;
use crate::util::{Secret, now_ms, rss_bytes};

const ADMIN_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/", get(|| async { Redirect::to("/admin/") }))
        .route("/admin", get(|| async { Redirect::to("/admin/") }))
        .route("/admin/", get(admin_page))
        .route("/admin/diagnostics", get(diagnostics))
        .route("/admin/metrics", get(metrics))
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let n = prefix.len();
    (s.len() >= n && s.as_bytes()[..n].eq_ignore_ascii_case(prefix.as_bytes())).then(|| &s[n..])
}

/// `Authorization: Bearer <token>` or `Basic base64(any-user:<token>)`.
pub fn token_ok(headers: &HeaderMap, token: &Secret) -> bool {
    let Some(v) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else { return false };
    if let Some(bearer) = strip_prefix_ci(v, "Bearer ") {
        return token.matches(bearer.trim().as_bytes());
    }
    if let Some(basic) = strip_prefix_ci(v, "Basic ") {
        let Ok(decoded) = STANDARD.decode(basic.trim()) else { return false };
        let Some(pos) = decoded.iter().position(|b| *b == b':') else { return false };
        return token.matches(&decoded[pos + 1..]);
    }
    false
}

/// Whether the `Host` header names this machine (`localhost`, a loopback IP).
fn loopback_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else { return false };
    let host = host.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':')
            .map_or(host.as_str(), |(h, p)| if p.bytes().all(|b| b.is_ascii_digit()) { h } else { host.as_str() })
    };
    name == "localhost" || name.ends_with(".localhost") || name.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn unauthorized() -> Response {
    let mut res = ApiError::unauthorized("admin token required").into_response();
    let h = res.headers_mut();
    h.append(header::WWW_AUTHENTICATE, HeaderValue::from_static("Basic realm=\"GNOME admin\", charset=\"UTF-8\""));
    h.append(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer realm=\"GNOME admin\""));
    res
}

/// Admin guard + headers.
pub async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let ip = req.extensions().get::<ClientInfo>().map_or(ClientInfo::unknown().ip, |c| c.ip);
    if let Err(e) = enforce(&state, RateClass::Admin, ip, None) {
        return with_admin_headers(e.into_response());
    }
    let headers = req.headers();
    match &state.config.admin_token {
        Some(token) => {
            if !token_ok(headers, token) {
                return with_admin_headers(unauthorized());
            }
        }
        None => {
            if !loopback_host(headers) {
                return with_admin_headers(
                    ApiError::forbidden(
                        "the admin listener only answers to localhost (set GNOME_ADMIN_TOKEN for remote use)",
                    )
                    .into_response(),
                );
            }
        }
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        if headers.get(CSRF_HEADER).map(|v| v.as_bytes()) != Some(b"1") {
            return with_admin_headers(ApiError::forbidden("missing X-GNOME-Request: 1 header").into_response());
        }
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
            let same = origin.split_once("://").is_some_and(|(_, rest)| rest.eq_ignore_ascii_case(host));
            if !same {
                return with_admin_headers(ApiError::forbidden("origin not allowed").into_response());
            }
        }
    }
    let res = next.run(req).await;
    with_admin_headers(res)
}

fn with_admin_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(ADMIN_CSP));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[derive(Debug, Default, Clone)]
struct DbStats {
    users: i64,
    user_sessions: i64,
    schema_versions: Vec<i64>,
}

async fn db_stats(state: &AppState) -> Result<DbStats, ApiError> {
    let now = now_ms();
    state
        .db
        .read(move |c| -> Result<DbStats, ApiError> {
            let schema_versions = c
                .prepare_cached("SELECT version FROM schema_migrations ORDER BY version")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<i64>, _>>()?;
            Ok(DbStats { users: users::count(c)?, user_sessions: sessions::count_active(c, now)?, schema_versions })
        })
        .await
}

/// Build the diagnostics document (API.md "Admin").
pub async fn collect(state: &AppState) -> Result<Diagnostics, ApiError> {
    let db = db_stats(state).await?;
    let m = &state.metrics;
    let by_status: serde_json::Map<String, Value> =
        m.by_status().into_iter().map(|(code, n)| (code.to_string(), Value::from(n))).collect();
    let rate_limited_by_class: serde_json::Map<String, Value> =
        state.limiter.rejected().into_iter().map(|(c, n)| (c.name().to_string(), Value::from(n))).collect();
    let c = &state.config;
    let mut d = Diagnostics::new();
    d.insert("uptime_s".into(), state.uptime_s().into());
    d.insert("rss_bytes".into(), rss_bytes().map_or(Value::Null, Value::from));
    // RLIMIT_NOFILE now (`null` = unlimited or unknown) and what startup did (`null` when the server was not started
    // by the CLI, e.g. in-process tests).
    let (fd_soft, fd_hard) = crate::server::fd_limit::current().unwrap_or((None, None));
    d.insert(
        "fd_limit".into(),
        json!({
            "soft": fd_soft,
            "hard": fd_hard,
            "open": crate::server::fd_limit::open_count(),
            "startup": crate::server::fd_limit::startup(),
        }),
    );
    d.insert(
        "http".into(),
        json!({
            "requests": m.requests(),
            "rate_limited": state.limiter.rejected_total(),
            "by_status": by_status,
            "in_flight": m.in_flight(),
            "connections_active": m.connections_active(),
            "connections_total": m.connections_total(),
            "rate_limited_by_class": rate_limited_by_class,
        }),
    );
    // Filled by the Wisp gateway, catalog and filter modules; present (zero/empty) so consumers can rely on keys.
    d.insert("ws".into(), json!({"active": 0, "total": 0, "bytes_up": 0, "bytes_down": 0}));
    d.insert(
        "db".into(),
        json!({
            "size_bytes": state.db.size_bytes(),
            "users": db.users,
            "user_sessions": db.user_sessions,
            "schema_versions": db.schema_versions,
        }),
    );
    // Replaced by the games module's `CatalogStats` when the catalog is enabled.
    d.insert("catalog".into(), json!({"games": 0, "listed": 0, "by_source": {}, "last_import": null}));
    d.insert("filters".into(), json!([]));
    d.insert("upstreams".into(), json!([]));
    // ARCHITECTURE §4.6: the origin setup; single-origin mode is reported with an explanation.
    let p = &c.proxy;
    d.insert(
        "proxy".into(),
        json!({
            "isolated": p.isolated(),
            "mode": p.mode(),
            "origin": p.origin(),
            "app_origins": p.app_origins(),
            "listener": c.proxy_bind.map(|a| a.to_string()),
            "explanation": (!p.isolated()).then_some(SINGLE_ORIGIN_EXPLANATION),
        }),
    );
    d.insert("jobs".into(), serde_json::to_value(state.jobs.snapshot()).unwrap_or(Value::Null));
    d.insert(
        "rate_limiter".into(),
        json!({
            "enabled": state.limiter.enabled(),
            "scale": c.rate_limit_scale,
            "buckets": state.limiter.len(),
            "login_backoff_entries": state.backoff.len(),
        }),
    );
    d.insert("static".into(), serde_json::to_value(state.static_files.stats()).unwrap_or(Value::Null));
    d.insert("modules".into(), state.modules().iter().map(|m| Value::from(m.name())).collect());
    d.insert(
        "config".into(),
        json!({
            "access_mode": c.access_mode.as_str(),
            "registration": if c.registration_open() { "open" } else { "closed" },
            "accounts": c.accounts,
            "csp": c.csp.as_str(),
            "hsts": c.hsts,
            "public_origins": c.public_origins,
            "proxy_origin": c.proxy_origin,
            "proxy_bind": c.proxy_bind.map(|a| a.to_string()),
            "proxy_csp": c.proxy_csp.is_some(),
            "allow_custom_wisp": c.allow_custom_wisp,
            "static_reload": c.static_reload,
            "filters_refresh_hours": c.filters_refresh_hours,
            "filter_lists_file": c.filter_lists_file.as_ref().map(|p| p.display().to_string()),
            "wisp_upstream": c.wisp_upstream.to_string(),
            "wisp_ticket_ttl_s": c.wisp_ticket_ttl_s,
            "max_ws_per_ip": c.max_ws_per_ip,
            "max_ws_per_session": c.max_ws_per_session,
            "vpn_profiles": c.profiles.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
            "trusted_proxies": c.trusted_proxies.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "admin_token": c.admin_token.is_some(),
            "log_ips": c.log_ips,
            "catalog_sources": c.catalog.sources.iter().map(|s| s.id()).collect::<Vec<_>>(),
            "thumb_proxy": c.thumb_proxy,
            "games_embed_hosts": c.games_embed_hosts,
            "oss_fetch": c.oss_fetch.as_str(),
            "vpn_check_url": c.vpn_check_url.as_deref().and_then(url_host),
            "vpn_check_url_v6": c.vpn_check_url_v6.as_deref().and_then(url_host),
            "vpn_check_interval_min": c.vpn_check_interval_min,
            "vpn_egress_shared_ok": c.vpn_egress_shared_ok,
        }),
    );
    d.insert(
        "build".into(),
        json!({
            "version": VERSION,
            "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        }),
    );
    for module in state.modules() {
        module.diagnostics(state, &mut d).await;
    }
    Ok(d)
}

async fn diagnostics(State(state): State<AppState>) -> Result<axum::Json<Diagnostics>, ApiError> {
    Ok(axum::Json(collect(&state).await?))
}

#[derive(Debug, Deserialize)]
struct PageQuery {
    #[serde(default)]
    refresh: Option<u32>,
}

async fn admin_page(State(state): State<AppState>, ApiQuery(q): ApiQuery<PageQuery>) -> Result<Html<String>, ApiError> {
    let d = collect(&state).await?;
    let refresh = q.refresh.map(|r| r.clamp(2, 3600));
    Ok(Html(page::render(&d, refresh)))
}

async fn metrics(State(state): State<AppState>) -> Result<Response, ApiError> {
    let db = db_stats(&state).await?;
    let mut out = String::with_capacity(4096);
    let w = &mut out;
    let _ = writeln!(w, "# HELP gnome_build_info Build information.");
    let _ = writeln!(w, "# TYPE gnome_build_info gauge");
    let _ = writeln!(w, "gnome_build_info{{version=\"{VERSION}\"}} 1");
    let _ = writeln!(w, "# HELP gnome_uptime_seconds Seconds since the server started.");
    let _ = writeln!(w, "# TYPE gnome_uptime_seconds gauge");
    let _ = writeln!(w, "gnome_uptime_seconds {}", state.uptime_s());
    if let Some(rss) = rss_bytes() {
        let _ = writeln!(w, "# HELP process_resident_memory_bytes Resident memory size in bytes.");
        let _ = writeln!(w, "# TYPE process_resident_memory_bytes gauge");
        let _ = writeln!(w, "process_resident_memory_bytes {rss}");
    }
    if let Some(n) = crate::server::fd_limit::open_count() {
        let _ = writeln!(w, "# HELP process_open_fds Number of open file descriptors.");
        let _ = writeln!(w, "# TYPE process_open_fds gauge");
        let _ = writeln!(w, "process_open_fds {n}");
    }
    if let Some((Some(soft), _)) = crate::server::fd_limit::current() {
        let _ = writeln!(w, "# HELP process_max_fds Maximum number of open file descriptors (soft limit).");
        let _ = writeln!(w, "# TYPE process_max_fds gauge");
        let _ = writeln!(w, "process_max_fds {soft}");
    }
    state.metrics.render_prometheus(w);
    let _ = writeln!(w, "# HELP gnome_rate_limited_total Requests rejected by rate limiting, by route class.");
    let _ = writeln!(w, "# TYPE gnome_rate_limited_total counter");
    for (class, n) in state.limiter.rejected() {
        let _ = writeln!(w, "gnome_rate_limited_total{{class=\"{}\"}} {n}", class.name());
    }
    let _ = writeln!(w, "# HELP gnome_rate_limit_buckets Token buckets currently tracked.");
    let _ = writeln!(w, "# TYPE gnome_rate_limit_buckets gauge");
    let _ = writeln!(w, "gnome_rate_limit_buckets {}", state.limiter.len());
    let _ = writeln!(w, "# HELP gnome_db_size_bytes SQLite database size including WAL.");
    let _ = writeln!(w, "# TYPE gnome_db_size_bytes gauge");
    let _ = writeln!(w, "gnome_db_size_bytes {}", state.db.size_bytes());
    let _ = writeln!(w, "# HELP gnome_users Registered user accounts.");
    let _ = writeln!(w, "# TYPE gnome_users gauge");
    let _ = writeln!(w, "gnome_users {}", db.users);
    let _ = writeln!(w, "# HELP gnome_user_sessions Active signed-in sessions.");
    let _ = writeln!(w, "# TYPE gnome_user_sessions gauge");
    let _ = writeln!(w, "gnome_user_sessions {}", db.user_sessions);
    let jobs = state.jobs.snapshot();
    let _ = writeln!(w, "# HELP gnome_job_runs_total Completed runs per background job.");
    let _ = writeln!(w, "# TYPE gnome_job_runs_total counter");
    for j in &jobs {
        let _ = writeln!(w, "gnome_job_runs_total{{job=\"{}\"}} {}", j.name, j.runs);
    }
    let _ = writeln!(w, "# HELP gnome_job_failures_total Failed runs per background job.");
    let _ = writeln!(w, "# TYPE gnome_job_failures_total counter");
    for j in &jobs {
        let _ = writeln!(w, "gnome_job_failures_total{{job=\"{}\"}} {}", j.name, j.failures);
    }
    let _ = writeln!(w, "# HELP gnome_static_files Files in the static index.");
    let _ = writeln!(w, "# TYPE gnome_static_files gauge");
    let _ = writeln!(w, "gnome_static_files {}", state.static_files.stats().files);
    for module in state.modules() {
        module.metrics(&state, w);
    }
    let mut res = (StatusCode::OK, out).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"));
    Ok(res)
}

/// `host[:port]` of a URL (diagnostics name the check service's host only, never its path or query).
pub fn url_host(url: &str) -> Option<String> {
    let uri: http::Uri = url.parse().ok()?;
    uri.authority().map(|a| a.as_str().rsplit('@').next().unwrap_or("").to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(k.clone(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn tokens() {
        let t = Secret::new("0123456789abcdef-admin");
        assert!(token_ok(&headers(&[(header::AUTHORIZATION, "Bearer 0123456789abcdef-admin")]), &t));
        assert!(token_ok(&headers(&[(header::AUTHORIZATION, "bearer 0123456789abcdef-admin")]), &t));
        let basic = format!("Basic {}", STANDARD.encode("admin:0123456789abcdef-admin"));
        assert!(token_ok(&headers(&[(header::AUTHORIZATION, &basic)]), &t));
        assert!(!token_ok(&headers(&[(header::AUTHORIZATION, "Bearer wrong")]), &t));
        assert!(!token_ok(&headers(&[(header::AUTHORIZATION, "Basic !!!")]), &t));
        assert!(!token_ok(&HeaderMap::new(), &t));
    }

    #[test]
    fn loopback_hosts() {
        for ok in ["localhost:9091", "127.0.0.1:9091", "[::1]:9091", "127.0.0.1", "admin.localhost"] {
            assert!(loopback_host(&headers(&[(header::HOST, ok)])), "{ok}");
        }
        for bad in ["evil.example:9091", "10.0.0.1:9091", "localhost.evil.example"] {
            assert!(!loopback_host(&headers(&[(header::HOST, bad)])), "{bad}");
        }
        assert!(!loopback_host(&HeaderMap::new()));
    }
}
