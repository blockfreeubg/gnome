//! The two origins (ARCHITECTURE §4.6): the **app origin** serves the SPA shell and `/api/*`; the **proxy origin**
//! serves only what proxied content needs (engine host, service worker, vendor builds, shared hashed assets, the
//! `/wisp/` gateway, read-only health and filter lists). Proxied pages run on the proxy origin, so a page that
//! escapes the engines' virtualization cannot read GNOME's storage or call its authenticated API.
//!
//! A request has the proxy [`Role`] when it arrived on the proxy listener (`GNOME_PROXY_BIND`) or its host
//! (`X-Forwarded-Host` only from trusted proxies) matches `GNOME_PROXY_ORIGIN`; otherwise the app role. With
//! neither setting the server runs in **single-origin mode**: one origin serves both roles ([`Role::Both`]) and
//! `/api/config`, `/admin/diagnostics` and `config check` report proxy isolation as off.

use std::net::{IpAddr, SocketAddr};

use crate::config::Config;
use crate::security::ClientInfo;
use crate::security::origin::{normalize_origin, request_origin};

/// Which routes a request may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    /// App origin of a two-origin deployment: SPA shell and `/api/*`; never `/wisp/` or engine prefixes.
    App,
    /// Proxy origin: `/engine/`, `/assets/*`, `/sw.js`, `/vendor/**`, `/wisp/*`, `GET /api/health`, filter lists and
    /// the engine prefixes; everything else 404.
    Proxy,
    /// Single-origin mode: one origin serves the union of both roles.
    Both,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Proxy => "proxy",
            Self::Both => "single",
        }
    }

    /// Whether the SPA shell and the app's `/api/*` routes are served.
    pub fn serves_app(self) -> bool {
        matches!(self, Self::App | Self::Both)
    }

    /// Whether the engine host, `/sw.js`, `/vendor/**`, `/wisp/*` and the engine prefixes are served.
    pub fn serves_proxy(self) -> bool {
        matches!(self, Self::Proxy | Self::Both)
    }
}

/// Where the effective proxy origin came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyOriginSource {
    /// `GNOME_PROXY_ORIGIN`.
    Configured,
    /// `http://<GNOME_PROXY_BIND>` for a loopback proxy listener without `GNOME_PROXY_ORIGIN`.
    ProxyBind,
}

/// The resolved origin setup (part of [`Config`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxySetup {
    origin: Option<(String, ProxyOriginSource)>,
    /// App origins allowed to embed the proxy origin (CSP `frame-ancestors`); empty in single-origin mode.
    app_origins: Vec<String>,
    /// `app_origins` were derived from a loopback `GNOME_BIND` (no `GNOME_PUBLIC_ORIGINS`).
    app_origins_derived: bool,
}

/// `http://<addr>`, normalized (`http://127.0.0.1:8081`, `http://[::1]:8081`).
pub fn origin_for_socket(addr: SocketAddr) -> Option<String> {
    normalize_origin(&format!("http://{addr}"))
}

impl ProxySetup {
    /// Single-origin mode.
    pub fn single_origin() -> Self {
        Self::default()
    }

    /// Resolve from the raw settings, appending configuration problems and warnings. `configured` must already be
    /// normalized.
    pub fn resolve(
        configured: Option<&str>,
        proxy_bind: Option<SocketAddr>,
        public_origins: &[String],
        bind: SocketAddr,
        problems: &mut Vec<String>,
        warnings: &mut Vec<String>,
    ) -> Self {
        let origin = match (configured, proxy_bind) {
            (Some(o), _) => Some((o.to_string(), ProxyOriginSource::Configured)),
            (None, Some(addr)) if addr.ip().is_loopback() => {
                origin_for_socket(addr).map(|o| (o, ProxyOriginSource::ProxyBind))
            }
            (None, Some(addr)) => {
                problems.push(format!(
                    "GNOME_PROXY_BIND={addr} is not a loopback address: set GNOME_PROXY_ORIGIN to the public origin \
                     browsers use for it (e.g. https://p.gnome.example.com)"
                ));
                None
            }
            (None, None) => None,
        };
        let Some((proxy_origin, source)) = origin else { return Self::single_origin() };

        let (app_origins, derived) = if !public_origins.is_empty() {
            (public_origins.to_vec(), false)
        } else if bind.ip().is_loopback() {
            (origin_for_socket(bind).into_iter().collect(), true)
        } else {
            problems.push(format!(
                "a proxy origin ({proxy_origin}) needs GNOME_PUBLIC_ORIGINS: the app origin(s) allowed to embed it \
                 (CSP frame-ancestors); only a loopback GNOME_BIND lets the server assume http://<GNOME_BIND>"
            ));
            (Vec::new(), false)
        };
        if public_origins.contains(&proxy_origin) {
            problems.push(format!(
                "GNOME_PUBLIC_ORIGINS must not contain the proxy origin {proxy_origin}: proxied pages would be allowed \
                 to make state-changing API calls"
            ));
        } else if app_origins.contains(&proxy_origin) {
            problems.push(format!("the proxy origin {proxy_origin} must differ from the app origin"));
        }
        for app in &app_origins {
            if site_key(app) != site_key(&proxy_origin) {
                warnings.push(format!(
                    "the app origin {app} and the proxy origin {proxy_origin} do not look same-site (different scheme \
                     or parent domain): browsers may partition the engine host's storage and service worker; use \
                     sibling hostnames such as gnome.example.com and p.gnome.example.com"
                ));
            }
        }
        if !secure_context(&proxy_origin) {
            warnings.push(format!(
                "the proxy origin {proxy_origin} is plain http on a non-loopback host: browsers allow service workers \
                 only in secure contexts (https://, or http://localhost / 127.0.0.1), so the proxy engines cannot start"
            ));
        }
        Self { origin: Some((proxy_origin, source)), app_origins, app_origins_derived: derived }
    }

    /// Whether proxied content runs on its own origin.
    pub fn isolated(&self) -> bool {
        self.origin.is_some()
    }

    /// `two-origin` or `single-origin`.
    pub fn mode(&self) -> &'static str {
        if self.isolated() { "two-origin" } else { "single-origin" }
    }

    /// The configured or derived proxy origin (`None` in single-origin mode).
    pub fn origin(&self) -> Option<&str> {
        self.origin.as_ref().map(|(o, _)| o.as_str())
    }

    pub fn origin_source(&self) -> Option<ProxyOriginSource> {
        self.origin.as_ref().map(|(_, s)| *s)
    }

    /// App origins allowed to embed the proxy origin (two-origin mode only).
    pub fn app_origins(&self) -> &[String] {
        &self.app_origins
    }

    /// Whether [`ProxySetup::app_origins`] was derived from a loopback `GNOME_BIND`.
    pub fn app_origins_derived(&self) -> bool {
        self.app_origins_derived
    }

    /// Whether a request addressed to `host` (`host[:port]`, as in `Host`) targets the proxy origin.
    pub fn is_proxy_host(&self, host: &str) -> bool {
        let Some(origin) = self.origin() else { return false };
        let scheme = origin.split_once("://").map_or("http", |(s, _)| s);
        normalize_origin(&format!("{scheme}://{host}")).is_some_and(|o| o == origin)
    }
}

/// The app origin a request was addressed to: the origin the browser used, unless an allow-list is configured and it
/// is not on it (e.g. a reverse proxy that rewrites `Host` to 127.0.0.1:8080); then the first configured app
/// origin. `None` if it cannot be determined (no `Host` and no allow-list).
pub fn app_origin(config: &Config, client: &ClientInfo) -> Option<String> {
    let seen = request_origin(client);
    match (seen, config.public_origins.as_slice()) {
        (Some(origin), []) => Some(origin),
        (Some(origin), allowed) if allowed.contains(&origin) => Some(origin),
        (seen, allowed) => allowed.first().cloned().or(seen),
    }
}

/// The origin that serves the engine host and `/wisp/` for this request: the proxy origin, or in single-origin mode
/// the app origin.
pub fn proxy_origin(config: &Config, client: &ClientInfo) -> Option<String> {
    match config.proxy.origin() {
        Some(origin) => Some(origin.to_string()),
        None => app_origin(config, client),
    }
}

/// `ws(s)://<origin><path>` for an `http(s)://` origin.
pub fn websocket_url(origin: &str, path: &str) -> String {
    match origin.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}{path}"),
        None => format!("ws://{}{path}", origin.strip_prefix("http://").unwrap_or(origin)),
    }
}

fn host_of(origin: &str) -> &str {
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    if let Some(v6) = rest.strip_prefix('[') {
        return v6.split(']').next().unwrap_or(v6);
    }
    rest.rsplit_once(':').map_or(rest, |(h, _)| h)
}

/// Approximation of a "site" (scheme + registrable domain) without the Public Suffix List: the scheme plus the
/// last two DNS labels, or the whole host for IP addresses. Only used for an advisory warning.
fn site_key(origin: &str) -> String {
    let scheme = origin.split_once("://").map_or("", |(s, _)| s);
    let host = host_of(origin);
    if host.parse::<IpAddr>().is_ok() {
        return format!("{scheme}://{host}");
    }
    let labels: Vec<&str> = host.split('.').collect();
    let tail = labels[labels.len().saturating_sub(2)..].join(".");
    format!("{scheme}://{tail}")
}

/// Whether `host` (without port or brackets) is a loopback name or address (`localhost`, `*.localhost`, `127.0.0.0/8`,
/// `::1`).
fn loopback_host(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Whether pages on `origin` are a secure context (service workers allowed).
fn secure_context(origin: &str) -> bool {
    origin.starts_with("https://") || loopback_host(host_of(origin))
}

/// Whether `origin` is plain `http://` on a loopback host: browsers treat it as potentially trustworthy, so they
/// accept `Secure` (and `__Host-`) cookies from it (development setups, spike §11.3 item 4).
pub fn loopback_http(origin: &str) -> bool {
    origin.starts_with("http://") && loopback_host(host_of(origin))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(
        configured: Option<&str>,
        proxy_bind: Option<&str>,
        public: &[&str],
        bind: &str,
    ) -> (ProxySetup, Vec<String>, Vec<String>) {
        let (mut problems, mut warnings) = (Vec::new(), Vec::new());
        let public: Vec<String> = public.iter().map(|s| s.to_string()).collect();
        let setup = ProxySetup::resolve(
            configured,
            proxy_bind.map(|b| b.parse().unwrap()),
            &public,
            bind.parse().unwrap(),
            &mut problems,
            &mut warnings,
        );
        (setup, problems, warnings)
    }

    #[test]
    fn single_origin_without_settings() {
        let (s, problems, warnings) = resolve(None, None, &[], "0.0.0.0:8080");
        assert!(!s.isolated() && problems.is_empty() && warnings.is_empty());
        assert_eq!(s.mode(), "single-origin");
        assert!(!s.is_proxy_host("p.example.com"));
    }

    #[test]
    fn loopback_proxy_bind_derives_both_origins() {
        let (s, problems, warnings) = resolve(None, Some("127.0.0.1:8081"), &[], "127.0.0.1:8080");
        assert!(problems.is_empty() && warnings.is_empty(), "{problems:?} {warnings:?}");
        assert_eq!(s.origin(), Some("http://127.0.0.1:8081"));
        assert_eq!(s.origin_source(), Some(ProxyOriginSource::ProxyBind));
        assert_eq!(s.app_origins(), ["http://127.0.0.1:8080"]);
        assert!(s.app_origins_derived());
        assert!(s.is_proxy_host("127.0.0.1:8081"));
        assert!(!s.is_proxy_host("127.0.0.1:8080"));
        let (v6, problems, _) = resolve(None, Some("[::1]:8081"), &[], "[::1]:8080");
        assert!(problems.is_empty());
        assert_eq!(v6.origin(), Some("http://[::1]:8081"));
        assert!(v6.is_proxy_host("[::1]:8081"));
    }

    #[test]
    fn public_proxy_bind_needs_an_origin_and_public_origins() {
        let (_, problems, _) = resolve(None, Some("0.0.0.0:8081"), &["https://g.example.com"], "0.0.0.0:8080");
        assert!(problems[0].contains("not a loopback"), "{problems:?}");
        let (_, problems, _) = resolve(Some("https://p.g.example.com"), None, &[], "0.0.0.0:8080");
        assert!(problems[0].contains("needs GNOME_PUBLIC_ORIGINS"), "{problems:?}");
        let (s, problems, warnings) =
            resolve(Some("https://p.g.example.com"), Some("0.0.0.0:8081"), &["https://g.example.com"], "0.0.0.0:8080");
        assert!(problems.is_empty() && warnings.is_empty(), "{problems:?} {warnings:?}");
        assert!(s.is_proxy_host("p.g.example.com") && s.is_proxy_host("P.G.Example.com:443"));
        assert!(!s.is_proxy_host("p.g.example.com:8443") && !s.is_proxy_host("g.example.com"));
    }

    #[test]
    fn the_proxy_origin_is_never_an_app_origin() {
        let (_, problems, _) =
            resolve(Some("https://p.example.com"), None, &["https://example.com", "https://p.example.com"], "[::]:80");
        assert!(problems.iter().any(|p| p.contains("must not contain the proxy origin")), "{problems:?}");
    }

    #[test]
    fn advisory_warnings() {
        let (_, _, warnings) = resolve(Some("https://proxy-host.net"), None, &["https://gnome.example.com"], "[::]:80");
        assert!(warnings.iter().any(|w| w.contains("same-site")), "{warnings:?}");
        let (_, _, warnings) = resolve(Some("http://192.168.1.5:8081"), None, &["http://192.168.1.5:8080"], "[::]:80");
        assert!(warnings.iter().any(|w| w.contains("secure contexts")), "{warnings:?}");
        assert!(!warnings.iter().any(|w| w.contains("same-site")), "same IP, other port is same-site: {warnings:?}");
    }

    #[test]
    fn loopback_http_origins() {
        for o in [
            "http://127.0.0.1:8080",
            "http://127.8.0.1",
            "http://localhost:5173",
            "http://gnome.localhost",
            "http://[::1]:80",
        ] {
            assert!(loopback_http(o), "{o}");
        }
        for o in
            ["https://127.0.0.1:8080", "http://192.168.1.5:8080", "http://gnome.test", "http://localhost.example.com"]
        {
            assert!(!loopback_http(o), "{o}");
        }
    }

    #[test]
    fn websocket_urls() {
        assert_eq!(websocket_url("https://p.example.com", "/wisp/"), "wss://p.example.com/wisp/");
        assert_eq!(websocket_url("http://127.0.0.1:8081", "/wisp/p/se/"), "ws://127.0.0.1:8081/wisp/p/se/");
    }
}
