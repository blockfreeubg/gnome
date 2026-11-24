//! Router assembly for the listeners.
//!
//! **Roles** (ARCHITECTURE §4.6, [`crate::origins`]). Each role has its own router: app (module `public_routes` +
//! `shared_routes` + the SPA), proxy (module `proxy_routes` + `shared_routes` + engine host / service worker / vendor
//! / assets / engine prefixes) and, in single-origin mode, both (app + shared routes first, then proxy routes, then
//! the combined static rules). The main listener
//! (`GNOME_BIND`, [`public`]) picks the router per request: the proxy origin's host gets the proxy role, every other
//! host the app role; without a proxy origin it always serves both. The proxy listener (`GNOME_PROXY_BIND`,
//! [`proxy`]) always serves the proxy role.
//!
//! Public middleware, outermost first: catch-panic → role → observe (client info, request id, metrics, access log)
//! → security headers (per role) → CSRF guard → API guard (baseline rate limit, cookie refresh, `no-store`) →
//! timeout → body limit → catch-panic → module routes / static fallback.
//!
//! Admin middleware: catch-panic → observe (request id, access log `listener=admin`) → guard (token / loopback Host,
//! CSRF, admin headers) → timeout → body limit → catch-panic → admin routes.
//!
//! The inner catch-panic turns a handler panic into a `500 internal` that still passes through every middleware
//! (request id, security headers, metrics, access log); the outer one is the safety net for the middleware itself.
//!
//! The admin router is built separately and is never merged into the public one.

use std::any::Any;
use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Router};
use http::{HeaderValue, header};
use tower::ServiceExt as _;
use tower_http::catch_panic::CatchPanicLayer;

use crate::auth::CookieSink;
use crate::error::ApiError;
use crate::origins::Role;
use crate::security::csp::NOTHING_RUNS_UNFRAMED;
use crate::security::rate_limit::{RateClass, enforce};
use crate::security::{ClientInfo, csrf, headers};
use crate::state::AppState;
use crate::{admin, limits, observability, static_files};

/// Default request body limit (API.md).
pub const DEFAULT_BODY_LIMIT: usize = 256 * 1024;
/// Body limit for sync batch endpoints.
pub const SYNC_BODY_LIMIT: usize = 2 * 1024 * 1024;
/// Time allowed to produce a response head (bodies may stream longer).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Router for `GNOME_BIND`: proxy role for requests addressed to the proxy origin's host, app role for every other
/// host; both roles in single-origin mode.
pub fn public(state: &AppState) -> Router {
    if !state.config.proxy.isolated() {
        return role_router(state, Role::Both);
    }
    let app = role_router(state, Role::App);
    let proxy = role_router(state, Role::Proxy);
    let st = state.clone();
    Router::new().fallback_service(tower::service_fn(move |mut req: Request| {
        let client = client_of(&st, &req);
        let to_proxy = client.host.as_deref().is_some_and(|h| st.config.proxy.is_proxy_host(h));
        req.extensions_mut().insert(client);
        let router = if to_proxy { proxy.clone() } else { app.clone() };
        router.oneshot(req)
    }))
}

/// Router for `GNOME_PROXY_BIND`: always the proxy role.
pub fn proxy(state: &AppState) -> Router {
    role_router(state, Role::Proxy)
}

/// The client behind a request on a public listener (`X-Forwarded-*` only from trusted proxies).
fn client_of(state: &AppState, req: &Request) -> ClientInfo {
    match req.extensions().get::<ConnectInfo<SocketAddr>>() {
        Some(ConnectInfo(peer)) => {
            ClientInfo::resolve(*peer, req.headers(), req.uri().authority().map(|a| a.as_str()), &state.trusted_proxies)
        }
        None => ClientInfo::unknown(),
    }
}

/// The router (routes, static fallback, middleware) of one role.
fn role_router(state: &AppState, role: Role) -> Router {
    let mut app_routes = Router::new();
    let mut proxy_routes = Router::new();
    for module in state.modules() {
        if role.serves_app() {
            app_routes = app_routes.merge(module.public_routes(state));
        }
        if role.serves_proxy() {
            proxy_routes = proxy_routes.merge(module.proxy_routes(state));
        }
        // Shared routes once per router: on the app router when there is one (single-origin mode included).
        if role.serves_app() {
            app_routes = app_routes.merge(module.shared_routes(state));
        } else {
            proxy_routes = proxy_routes.merge(module.shared_routes(state));
        }
    }
    let fallback = move |State(state): State<AppState>, req: Request| static_files::fallback(state, role, req);
    let routes = match role {
        Role::App => app_routes.fallback(fallback),
        Role::Proxy => proxy_routes.fallback(fallback),
        // App routes win; paths they do not route go to the proxy routes, then to the combined static rules.
        Role::Both => app_routes.fallback_service(
            proxy_routes.fallback(fallback).method_not_allowed_fallback(method_not_allowed).with_state(state.clone()),
        ),
    };
    routes
        .method_not_allowed_fallback(method_not_allowed)
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
        .layer(middleware::from_fn(timeout))
        .layer(middleware::from_fn_with_state(state.clone(), api_guard))
        .layer(middleware::from_fn_with_state(state.clone(), csrf::middleware))
        .layer(middleware::from_fn_with_state(state.clone(), limits::middleware))
        .layer(middleware::from_fn_with_state(state.clone(), headers::middleware))
        .layer(middleware::from_fn_with_state(state.clone(), observability::observe))
        .layer(Extension(role))
        .layer(CatchPanicLayer::custom(panic_response))
        .with_state(state.clone())
}

/// Router for `GNOME_ADMIN_BIND`.
pub fn admin(state: &AppState) -> Router {
    let mut router = admin::routes();
    for module in state.modules() {
        router = router.merge(module.admin_routes(state));
    }
    router
        .fallback(|| async { ApiError::not_found() })
        .method_not_allowed_fallback(method_not_allowed)
        .layer(CatchPanicLayer::custom(panic_response))
        .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
        .layer(middleware::from_fn(timeout))
        .layer(middleware::from_fn_with_state(state.clone(), admin::guard))
        .layer(middleware::from_fn_with_state(state.clone(), observability::observe_admin))
        .layer(CatchPanicLayer::custom(panic_response))
        .with_state(state.clone())
}

async fn method_not_allowed() -> ApiError {
    ApiError::method_not_allowed()
}

/// Baseline protections for `/api/*`.
async fn api_guard(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    if !req.uri().path().starts_with("/api/") {
        return next.run(req).await;
    }
    let ip = req.extensions().get::<ClientInfo>().map_or(ClientInfo::unknown().ip, |c| c.ip);
    // Thumbnails have their own class: a long scroll of the Games page loads hundreds (WAVE-C D7).
    let class = if req.uri().path().starts_with("/api/thumb/") { RateClass::Thumb } else { RateClass::Api };
    if let Err(e) = enforce(&state, class, ip, None) {
        return e.into_response();
    }
    let sink = CookieSink::default();
    req.extensions_mut().insert(sink.clone());
    let mut res = next.run(req).await;
    sink.apply(&mut res);
    res.headers_mut().entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static("no-store"));
    res
}

async fn timeout(req: Request, next: Next) -> Response {
    match tokio::time::timeout(REQUEST_TIMEOUT, next.run(req)).await {
        Ok(res) => res,
        Err(_) => ApiError::timeout().into_response(),
    }
}

fn panic_response(err: Box<dyn Any + Send + 'static>) -> Response {
    let detail = err
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| err.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".into());
    tracing::error!(panic = %detail, "request handler panicked");
    let mut res = ApiError::internal().into_response();
    // The outer catch-panic layer sits outside the security-headers middleware, so this answer brings its own strict
    // policy: it must not be a permissive realm on the proxy origin either (the middleware keeps it on the inner one).
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(NOTHING_RUNS_UNFRAMED));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt as _;

    async fn boom() -> &'static str {
        panic!("kaboom")
    }

    #[tokio::test(start_paused = true)]
    async fn slow_handlers_time_out_with_503() {
        async fn slow() -> &'static str {
            tokio::time::sleep(REQUEST_TIMEOUT * 2).await;
            "late"
        }
        let app: Router = Router::new().route("/slow", get(slow)).layer(middleware::from_fn(timeout));
        let started = tokio::time::Instant::now();
        let res = app.oneshot(http::Request::builder().uri("/slow").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(started.elapsed(), REQUEST_TIMEOUT);
        assert_eq!(res.status(), http::StatusCode::SERVICE_UNAVAILABLE);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "timeout");
    }

    #[tokio::test]
    async fn panics_become_json_500() {
        let app: Router = Router::new().route("/boom", get(boom)).layer(CatchPanicLayer::custom(panic_response));
        let res = app.oneshot(http::Request::builder().uri("/boom").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/json");
        // Also the answer of the outer layer, which no security-headers middleware sees: not a permissive realm.
        assert_eq!(res.headers()[header::CONTENT_SECURITY_POLICY], NOTHING_RUNS_UNFRAMED);
        assert_eq!(res.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"]["code"], "internal");
        assert!(!String::from_utf8_lossy(&body).contains("kaboom"), "panic details are not leaked");
    }
}
