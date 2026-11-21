//! Test harness: builds the real public/admin routers over a temporary data dir and static dir, and drives them with
//! `tower::ServiceExt::oneshot`.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::ConnectInfo;
use bytes::Bytes;
use gnome_server::AppState;
use gnome_server::config::Config;
use http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

pub const HOST: &str = "gnome.test";
pub const ORIGIN: &str = "http://gnome.test";

pub struct TestApp {
    pub state: AppState,
    pub public: Router,
    pub admin: Router,
    pub dir: TempDir,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.text()))
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// All `Set-Cookie` header values.
    pub fn set_cookies(&self) -> Vec<String> {
        self.headers.get_all(header::SET_COOKIE).iter().map(|v| v.to_str().unwrap().to_string()).collect()
    }

    /// The full `Set-Cookie` line for `name`.
    pub fn set_cookie(&self, name: &str) -> Option<String> {
        self.set_cookies().into_iter().find(|c| c.starts_with(&format!("{name}=")))
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or_default().to_string()
    }
}

impl TestApp {
    pub async fn new(vars: &[(&str, &str)]) -> Self {
        Self::with_static(vars, |_| {}).await
    }

    /// `setup` populates the static dir (created empty) before the index is built.
    pub async fn with_static(vars: &[(&str, &str)], setup: impl FnOnce(&Path)) -> Self {
        Self::with_modules(vars, setup, gnome_server::module::builtin_modules).await
    }

    /// Like [`TestApp::with_static`] with a custom module list (see `AppState::open_with`).
    pub async fn with_modules<F>(vars: &[(&str, &str)], setup: impl FnOnce(&Path), modules: F) -> Self
    where
        F: FnOnce(&mut gnome_server::module::ModuleSetup<'_>) -> Vec<std::sync::Arc<dyn gnome_server::module::Module>>,
    {
        let dir = tempfile::tempdir().unwrap();
        let static_dir = dir.path().join("static");
        std::fs::create_dir_all(&static_dir).unwrap();
        setup(&static_dir);
        let mut map: HashMap<String, String> = HashMap::from([
            ("GNOME_DATA_DIR".into(), dir.path().join("data").display().to_string()),
            ("GNOME_STATIC_DIR".into(), static_dir.display().to_string()),
            ("GNOME_ARGON2_MEMORY_KIB".into(), "1024".into()),
        ]);
        for (k, v) in vars {
            map.insert((*k).to_string(), (*v).to_string());
        }
        let config = Config::from_lookup(|k| map.get(k).cloned(), None).expect("test config is valid");
        let state = AppState::open_with(config, modules).await.expect("app opens");
        let public = gnome_server::router::public(&state);
        let admin = gnome_server::router::admin(&state);
        Self { state, public, admin, dir }
    }

    pub fn client(&self) -> Client<'_> {
        Client { app: self, cookies: BTreeMap::new(), peer: "203.0.113.10:40000".parse().unwrap() }
    }

    pub async fn send(&self, req: Request<Body>) -> TestResponse {
        send_to(&self.public, req, "203.0.113.10:40000".parse().unwrap()).await
    }

    pub async fn send_admin(&self, req: Request<Body>) -> TestResponse {
        send_to(&self.admin, req, "127.0.0.1:50000".parse().unwrap()).await
    }
}

pub async fn send_to(router: &Router, mut req: Request<Body>, peer: SocketAddr) -> TestResponse {
    if req.extensions().get::<ConnectInfo<SocketAddr>>().is_none() {
        req.extensions_mut().insert(ConnectInfo(peer));
    }
    let res = router.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    TestResponse { status: parts.status, headers: parts.headers, body }
}

/// Builder for requests to the public listener (Host set, CSRF header on unsafe methods).
pub fn req(method: Method, path: &str) -> http::request::Builder {
    let unsafe_method = !matches!(method, Method::GET | Method::HEAD);
    let b = Request::builder().method(method).uri(path).header(header::HOST, HOST);
    if unsafe_method { b.header("x-gnome-request", "1") } else { b }
}

pub fn get(path: &str) -> Request<Body> {
    req(Method::GET, path).body(Body::empty()).unwrap()
}

pub fn json_req(method: Method, path: &str, body: &Value) -> Request<Body> {
    req(method, path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, ORIGIN)
        .body(Body::from(serde_json::to_vec(body).unwrap()))
        .unwrap()
}

/// A browser-like client: keeps cookies, fixed client IP.
pub struct Client<'a> {
    pub app: &'a TestApp,
    pub cookies: BTreeMap<String, String>,
    pub peer: SocketAddr,
}

impl Client<'_> {
    pub fn with_ip(mut self, peer: &str) -> Self {
        self.peer = peer.parse().unwrap();
        self
    }

    pub async fn send(&mut self, mut req: Request<Body>) -> TestResponse {
        if !self.cookies.is_empty() {
            let cookie = self.cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
            req.headers_mut().insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        }
        let res = send_to(&self.app.public, req, self.peer).await;
        for line in res.set_cookies() {
            let (pair, attrs) = line.split_once(';').unwrap_or((&line, ""));
            let (name, value) = pair.split_once('=').unwrap();
            if value.is_empty() || attrs.contains("Max-Age=0") {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.to_string(), value.to_string());
            }
        }
        res
    }

    pub async fn get(&mut self, path: &str) -> TestResponse {
        self.send(get(path)).await
    }

    pub async fn post(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::POST, path, &body)).await
    }

    pub async fn put(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::PUT, path, &body)).await
    }

    pub async fn delete(&mut self, path: &str, body: Value) -> TestResponse {
        self.send(json_req(Method::DELETE, path, &body)).await
    }

    /// Register (and stay signed in).
    pub async fn register(&mut self, username: &str, password: &str) -> TestResponse {
        let res =
            self.post("/api/auth/register", serde_json::json!({"username": username, "password": password})).await;
        assert_eq!(res.status, StatusCode::CREATED, "register failed: {}", res.text());
        res
    }
}
