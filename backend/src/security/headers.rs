//! Security headers added to every public-listener response, per [`Role`]: the app (and single-origin) role gets
//! `X-Frame-Options: SAMEORIGIN` and the shell CSP; the proxy role never gets `X-Frame-Options` (the app must be able
//! to frame the engine host), and every proxy-role response without a policy of its own (JSON answers, the 404s,
//! `/api/health`, `/api/filters*`, files where nothing runs) gets `default-src 'none'; …; frame-ancestors 'self'
//! <app origin(s)>` ([`super::csp::ProxyPolicies::none`]), so no proxy-origin document is a permissive realm.

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use http::{HeaderMap, HeaderName, HeaderValue, header};

use super::client::ClientInfo;
use super::csp::{self, CspHeaders, FRAME_ANCESTORS_ONLY, ProxyPolicies};
use crate::config::Config;
use crate::origins::Role;
use crate::state::AppState;

/// HSTS value used when `GNOME_HSTS=true` (sent only on HTTPS responses, as RFC 6797 requires).
pub const HSTS_VALUE: &str = "max-age=31536000";

/// Precomputed header values.
#[derive(Debug, Clone)]
pub struct SecurityHeaders {
    shell: CspHeaders,
    /// `default-src 'none'; …; frame-ancestors 'self' <app origins>` (two-origin mode only).
    proxy_default: Option<HeaderValue>,
    hsts: Option<HeaderValue>,
}

impl SecurityHeaders {
    pub fn new(config: &Config) -> Self {
        Self {
            shell: csp::headers_for(config.csp, &config.proxy, &[]),
            proxy_default: config
                .proxy
                .isolated()
                .then(|| ProxyPolicies::new(&config.proxy, config.allow_custom_wisp, &[]).none),
            hsts: config.hsts.then(|| HeaderValue::from_static(HSTS_VALUE)),
        }
    }

    /// Fill in security headers the handler did not set itself. App role: HTML responses without their own policy
    /// get the shell CSP, everything else `frame-ancestors 'self'`. Proxy role: no `X-Frame-Options` and
    /// `default-src 'none'` (with `frame-ancestors 'self' <app origins>`) unless the handler set a policy.
    pub fn apply(&self, headers: &mut HeaderMap, https: bool, role: Role) {
        set_default(headers, header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
        set_default(headers, header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        if https && let Some(hsts) = &self.hsts {
            headers.insert(header::STRICT_TRANSPORT_SECURITY, hsts.clone());
        }
        if role == Role::Proxy {
            headers.remove(header::X_FRAME_OPTIONS);
            let default = self.proxy_default.clone().unwrap_or(HeaderValue::from_static(FRAME_ANCESTORS_ONLY));
            set_default(headers, header::CONTENT_SECURITY_POLICY, default);
            return;
        }
        set_default(headers, header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
        if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
            if is_html(headers) {
                headers.insert(header::CONTENT_SECURITY_POLICY, self.shell.enforce.clone());
                if let Some(ro) = &self.shell.report_only {
                    headers.insert(header::CONTENT_SECURITY_POLICY_REPORT_ONLY, ro.clone());
                }
            } else {
                headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(FRAME_ANCESTORS_ONLY));
            }
        }
    }
}

fn set_default(headers: &mut HeaderMap, name: HeaderName, value: HeaderValue) {
    headers.entry(name).or_insert(value);
}

fn is_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.trim_start().to_ascii_lowercase().starts_with("text/html"))
}

/// Middleware for the public routers (the role comes from the request extensions, see `router`).
pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let https = req.extensions().get::<ClientInfo>().is_some_and(|c| c.https);
    let role = req.extensions().get::<Role>().copied().unwrap_or(Role::Both);
    let mut res = next.run(req).await;
    state.security_headers.apply(res.headers_mut(), https, role);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Config {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|k| map.get(k).cloned(), None).unwrap()
    }

    #[test]
    fn html_gets_shell_policy_others_frame_ancestors() {
        let sh = SecurityHeaders::new(&config(&[]));
        let mut html = HeaderMap::new();
        html.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        sh.apply(&mut html, false, Role::Both);
        assert!(html[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("script-src"));
        assert_eq!(html[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(html[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(html[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        let mut json = HeaderMap::new();
        json.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        sh.apply(&mut json, false, Role::App);
        assert_eq!(json[header::CONTENT_SECURITY_POLICY], FRAME_ANCESTORS_ONLY);
        assert!(!json.contains_key(header::STRICT_TRANSPORT_SECURITY));
    }

    #[test]
    fn hsts_only_over_https_when_enabled() {
        let sh = SecurityHeaders::new(&config(&[("GNOME_HSTS", "true")]));
        let mut h = HeaderMap::new();
        sh.apply(&mut h, false, Role::Both);
        assert!(!h.contains_key(header::STRICT_TRANSPORT_SECURITY));
        sh.apply(&mut h, true, Role::Both);
        assert_eq!(h[header::STRICT_TRANSPORT_SECURITY], HSTS_VALUE);
        let mut p = HeaderMap::new();
        sh.apply(&mut p, true, Role::Proxy);
        assert_eq!(p[header::STRICT_TRANSPORT_SECURITY], HSTS_VALUE, "the proxy role too");
    }

    #[test]
    fn handler_policy_is_kept() {
        let sh = SecurityHeaders::new(&config(&[]));
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'"));
        sh.apply(&mut h, false, Role::App);
        assert_eq!(h[header::CONTENT_SECURITY_POLICY], "default-src 'none'");
    }

    #[test]
    fn proxy_role_has_frame_ancestors_and_no_x_frame_options() {
        let sh = SecurityHeaders::new(&config(&[
            ("GNOME_PROXY_ORIGIN", "https://p.gnome.example.com"),
            ("GNOME_PUBLIC_ORIGINS", "https://gnome.example.com"),
        ]));
        let mut html = HeaderMap::new();
        html.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        html.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
        sh.apply(&mut html, false, Role::Proxy);
        assert!(!html.contains_key(header::X_FRAME_OPTIONS));
        assert_eq!(
            html[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' https://gnome.example.com"
        );
        assert_eq!(html[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(html[header::REFERRER_POLICY], "no-referrer");
        let mut app = HeaderMap::new();
        app.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html"));
        sh.apply(&mut app, false, Role::App);
        assert_eq!(app[header::X_FRAME_OPTIONS], "SAMEORIGIN");
        let csp = app[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
        assert!(
            csp.contains("; frame-src blob: https://p.gnome.example.com;"),
            "only the engine host may be framed: {csp}"
        );
    }
}
