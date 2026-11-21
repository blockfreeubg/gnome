//! [`SafeClient`]: the SSRF-safe outbound HTTP client.

use std::error::Error as StdError;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::{Method, StatusCode};
use url::{Host, Url};

use crate::error::Error;
use crate::ip_policy::IpPolicy;
use crate::resolver::{BlockedAddress, PolicyResolver, Resolver, SystemResolver};

/// gnome-net's version, used in the default `User-Agent` (`GNOME/<version>`).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Hard upper bound for [`SafeClientConfig::max_redirects`] (and its default).
pub const MAX_REDIRECTS: usize = 5;
/// Default per-request body limit: 16 MiB of decoded body.
pub const DEFAULT_MAX_BODY_BYTES: u64 = 16 * 1024 * 1024;
/// Default TCP + TLS connect timeout.
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Default total time budget per request (all redirect hops plus reading the body).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Default port allowlist.
pub const DEFAULT_PORTS: [u16; 2] = [80, 443];

/// Request headers callers may not set: they would desynchronise framing or the connection target.
const FORBIDDEN_HEADERS: [&str; 10] = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-connection",
];

/// Configuration of a [`SafeClient`]. Start from [`SafeClientConfig::default`] and adjust with the builder
/// methods.
#[derive(Clone)]
pub struct SafeClientConfig {
    ip_policy: IpPolicy,
    allowed_ports: Vec<u16>,
    allowed_hosts: Option<Vec<String>>,
    max_redirects: usize,
    connect_timeout: Duration,
    timeout: Duration,
    max_body_bytes: u64,
    source_url: Option<String>,
    resolver: Arc<dyn Resolver>,
}

impl Default for SafeClientConfig {
    fn default() -> Self {
        Self {
            ip_policy: IpPolicy::strict(),
            allowed_ports: DEFAULT_PORTS.to_vec(),
            allowed_hosts: None,
            max_redirects: MAX_REDIRECTS,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            timeout: DEFAULT_TIMEOUT,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            source_url: None,
            resolver: Arc::new(SystemResolver),
        }
    }
}

impl fmt::Debug for SafeClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SafeClientConfig")
            .field("ip_policy", &self.ip_policy)
            .field("allowed_ports", &self.allowed_ports)
            .field("allowed_hosts", &self.allowed_hosts)
            .field("max_redirects", &self.max_redirects)
            .field("connect_timeout", &self.connect_timeout)
            .field("timeout", &self.timeout)
            .field("max_body_bytes", &self.max_body_bytes)
            .field("source_url", &self.source_url)
            .finish_non_exhaustive()
    }
}

impl SafeClientConfig {
    /// Destination IP policy (default [`IpPolicy::strict`]).
    #[must_use]
    pub fn ip_policy(mut self, policy: IpPolicy) -> Self {
        self.ip_policy = policy;
        self
    }

    /// Destination ports that may be used (default `80` and `443`). Applies to every redirect hop.
    #[must_use]
    pub fn allowed_ports(mut self, ports: impl IntoIterator<Item = u16>) -> Self {
        self.allowed_ports = ports.into_iter().collect();
        self
    }

    /// Restrict destinations (every hop) to these hosts. `example.com` matches exactly that host; `*.example.com`
    /// matches any subdomain of it (not the apex). Names are compared after IDNA/lowercase normalisation; a
    /// pattern may also be an IP literal (`192.0.2.1`, `[2001:db8::1]`). Default: no host restriction.
    #[must_use]
    pub fn allowed_hosts<S: Into<String>>(mut self, hosts: impl IntoIterator<Item = S>) -> Self {
        self.allowed_hosts = Some(hosts.into_iter().map(Into::into).collect());
        self
    }

    /// Redirects to follow, `0..=5` (default 5). With `0`, 3xx responses are returned as they are.
    #[must_use]
    pub fn max_redirects(mut self, n: usize) -> Self {
        self.max_redirects = n;
        self
    }

    /// Timeout for each TCP connect + TLS handshake (default 10 s).
    #[must_use]
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }

    /// Default total time budget per request, covering every hop and the body (default 30 s). Override per
    /// request with [`Request::timeout`].
    #[must_use]
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }

    /// Default decoded-body limit per request (default 16 MiB). Override per request with
    /// [`Request::max_body_bytes`].
    #[must_use]
    pub fn max_body_bytes(mut self, n: u64) -> Self {
        self.max_body_bytes = n;
        self
    }

    /// Public source URL of this deployment, appended to the `User-Agent` as `GNOME/<version> (+<url>)`.
    #[must_use]
    pub fn source_url(mut self, url: impl Into<String>) -> Self {
        let url = url.into();
        self.source_url = (!url.trim().is_empty()).then_some(url);
        self
    }

    /// Name resolver (default: the system resolver). Its answers are still filtered by the IP policy.
    #[must_use]
    pub fn resolver(mut self, resolver: Arc<dyn Resolver>) -> Self {
        self.resolver = resolver;
        self
    }

    /// The `User-Agent` this configuration produces.
    pub fn user_agent(&self) -> String {
        match &self.source_url {
            Some(url) => format!("GNOME/{VERSION} (+{url})"),
            None => format!("GNOME/{VERSION}"),
        }
    }
}

/// A host allowlist entry, normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HostPattern {
    Exact(String),
    /// Matches hosts ending in `.<suffix>`.
    Subdomains(String),
}

impl HostPattern {
    fn parse(raw: &str) -> Result<Self, Error> {
        let raw = raw.trim();
        let (wild, name) = match raw.strip_prefix("*.") {
            Some(rest) => (true, rest),
            None => (false, raw),
        };
        let bad = || Error::Config(format!("invalid host pattern {raw:?}"));
        let bracketed = name.starts_with('[') && name.ends_with(']');
        if name.is_empty() || name.contains(['/', '?', '#', '@', '*', '\\']) || (name.contains(':') && !bracketed) {
            return Err(bad());
        }
        let url = Url::parse(&format!("https://{name}/")).map_err(|_| bad())?;
        if url.port().is_some() {
            return Err(bad());
        }
        let host = normalize_host(url.host_str().ok_or_else(bad)?);
        if wild {
            if !matches!(url.host(), Some(Host::Domain(_))) {
                return Err(bad());
            }
            Ok(Self::Subdomains(host))
        } else {
            Ok(Self::Exact(host))
        }
    }

    fn matches(&self, host: &str) -> bool {
        match self {
            Self::Exact(h) => h == host,
            Self::Subdomains(s) => {
                host.len() > s.len() + 1 && host.ends_with(s.as_str()) && {
                    host.as_bytes()[host.len() - s.len() - 1] == b'.'
                }
            }
        }
    }
}

fn normalize_host(h: &str) -> String {
    h.trim_end_matches('.').to_ascii_lowercase()
}

struct Inner {
    http: reqwest::Client,
    ip_policy: IpPolicy,
    allowed_ports: Vec<u16>,
    allowed_hosts: Option<Vec<HostPattern>>,
    max_redirects: usize,
    timeout: Duration,
    max_body_bytes: u64,
}

/// An SSRF-safe HTTP client. Cheap to clone (shares one connection pool).
///
/// Every hop of every request is checked before anything is sent:
///
/// 1. scheme: `https`, or `http` when the request opted in with [`Request::allow_http`];
/// 2. no credentials in the URL; port in the port allowlist; host in the host allowlist (if configured);
/// 3. an IP-literal host must pass the [`IpPolicy`]; a host name is resolved by the configured [`Resolver`] and
///    only addresses passing the policy are handed to the connector, so the client connects exactly to vetted
///    addresses (no DNS-rebinding window). If none pass, the request fails with [`Error::Blocked`].
///
/// Redirects (301/302/303/307/308) are followed by the client itself, at most [`MAX_REDIRECTS`], each one
/// re-validated as above; credentials (`Authorization`, `Cookie`) are dropped on cross-origin hops and 303 (and
/// 301/302 after `POST`) switch to `GET` without a body. No proxy is ever used (environment proxies are ignored).
/// Bodies are decoded (gzip, brotli) and counted while streaming; the request fails with
/// [`Error::BodyTooLarge`] as soon as the decoded size passes the limit, so a compression bomb or an endless
/// stream never gets buffered. The total time budget covers all hops and the body.
#[derive(Clone)]
pub struct SafeClient {
    inner: Arc<Inner>,
}

impl fmt::Debug for SafeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SafeClient")
            .field("ip_policy", &self.inner.ip_policy)
            .field("allowed_ports", &self.inner.allowed_ports)
            .field("allowed_hosts", &self.inner.allowed_hosts)
            .field("max_redirects", &self.inner.max_redirects)
            .finish_non_exhaustive()
    }
}

impl SafeClient {
    /// Build a client. Fails with [`Error::Config`] on an invalid configuration (more than [`MAX_REDIRECTS`]
    /// redirects, empty port list, bad host pattern or source URL, zero timeouts).
    pub fn new(config: SafeClientConfig) -> Result<Self, Error> {
        if config.max_redirects > MAX_REDIRECTS {
            return Err(Error::Config(format!("max_redirects must be at most {MAX_REDIRECTS}")));
        }
        if config.allowed_ports.is_empty() || config.allowed_ports.contains(&0) {
            return Err(Error::Config("allowed_ports must be non-empty and must not contain 0".into()));
        }
        if config.timeout.is_zero() || config.connect_timeout.is_zero() {
            return Err(Error::Config("timeouts must be greater than zero".into()));
        }
        let allowed_hosts = match &config.allowed_hosts {
            Some(list) => Some(list.iter().map(|h| HostPattern::parse(h)).collect::<Result<Vec<_>, _>>()?),
            None => None,
        };
        let ua = HeaderValue::from_str(&config.user_agent())
            .map_err(|_| Error::Config("source_url is not a valid header value".into()))?;

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let mut tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| Error::Config(format!("TLS: {e}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];

        let resolver = PolicyResolver { inner: Arc::clone(&config.resolver), policy: config.ip_policy };
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls)
            .dns_resolver(resolver)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(config.connect_timeout)
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(4)
            .user_agent(ua)
            .build()
            .map_err(|e| Error::Config(format!("HTTP client: {}", chain(&e))))?;

        Ok(Self {
            inner: Arc::new(Inner {
                http,
                ip_policy: config.ip_policy,
                allowed_ports: config.allowed_ports,
                allowed_hosts,
                max_redirects: config.max_redirects,
                timeout: config.timeout,
                max_body_bytes: config.max_body_bytes,
            }),
        })
    }

    /// Perform a request, following redirects, and return the response with its whole (decoded, size-limited)
    /// body. Any HTTP status is `Ok`, including 304 and 5xx.
    pub async fn fetch(&self, request: Request) -> Result<Response, Error> {
        let budget = request.timeout.unwrap_or(self.inner.timeout);
        match tokio::time::timeout(budget, self.fetch_inner(request)).await {
            Ok(r) => r,
            Err(_) => Err(Error::Timeout),
        }
    }

    /// Shorthand for `fetch(Request::get(url))`.
    pub async fn get(&self, url: impl Into<String>) -> Result<Response, Error> {
        self.fetch(Request::get(url)).await
    }

    /// Conditional GET helper: sends `If-None-Match` / `If-Modified-Since` from `cached` (via
    /// [`Request::conditional`]) and reports a `304 Not Modified` as [`Conditional::NotModified`], with validators
    /// refreshed from the 304 when it carries any. Any other status is [`Conditional::Modified`] (check
    /// [`Response::status`] before using the body).
    pub async fn fetch_conditional(&self, request: Request, cached: &Validators) -> Result<Conditional, Error> {
        let resp = self.fetch(request.conditional(cached)).await?;
        if resp.is_not_modified() {
            let fresh = resp.validators();
            let validators = Validators {
                etag: fresh.etag.or_else(|| cached.etag.clone()),
                last_modified: fresh.last_modified.or_else(|| cached.last_modified.clone()),
            };
            Ok(Conditional::NotModified { validators })
        } else {
            let validators = resp.validators();
            Ok(Conditional::Modified { response: Box::new(resp), validators })
        }
    }

    /// Check one hop's URL against the scheme, credential, port, host-allowlist and IP-literal rules.
    fn check_url(&self, url: &Url, allow_http: bool) -> Result<(), Error> {
        match url.scheme() {
            "https" => {}
            "http" if allow_http => {}
            other => return Err(Error::SchemeNotAllowed(other.to_owned())),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(Error::InvalidUrl("credentials in URLs are not allowed".into()));
        }
        let host = url.host().ok_or_else(|| Error::InvalidUrl(format!("{url}: no host")))?;
        let port = url.port_or_known_default().ok_or_else(|| Error::InvalidUrl(format!("{url}: no port")))?;
        if !self.inner.allowed_ports.contains(&port) {
            return Err(Error::PortNotAllowed(port));
        }
        let host_str = normalize_host(url.host_str().unwrap_or_default());
        if let Some(list) = &self.inner.allowed_hosts
            && !list.iter().any(|p| p.matches(&host_str))
        {
            return Err(Error::HostNotAllowed(host_str));
        }
        let literal = match host {
            Host::Ipv4(ip) => Some(ip.into()),
            Host::Ipv6(ip) => Some(ip.into()),
            Host::Domain(_) => None,
        };
        if let Some(ip) = literal
            && let Err(class) = self.inner.ip_policy.check(ip)
        {
            tracing::info!(host = %host_str, %ip, %class, "gnome-net: blocked destination");
            return Err(Error::Blocked { host: host_str, ip, class });
        }
        Ok(())
    }

    async fn fetch_inner(&self, request: Request) -> Result<Response, Error> {
        let limit = request.max_body_bytes.unwrap_or(self.inner.max_body_bytes);
        let mut url = Url::parse(&request.url).map_err(|e| Error::InvalidUrl(format!("{}: {e}", request.url)))?;
        let mut headers = build_headers(&request.headers)?;
        let mut method = request.method;
        let mut body = request.body;
        let mut redirects = 0;
        loop {
            self.check_url(&url, request.allow_http)?;
            let mut rb = self.inner.http.request(method.clone(), url.clone()).headers(headers.clone());
            if let Some(b) = &body {
                rb = rb.body(b.clone());
            }
            let resp = rb.send().await.map_err(map_reqwest)?;
            let status = resp.status();
            let location = resp.headers().get(header::LOCATION).cloned();
            if self.inner.max_redirects > 0
                && matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
                && let Some(location) = location
            {
                if redirects >= self.inner.max_redirects {
                    return Err(Error::TooManyRedirects(self.inner.max_redirects));
                }
                let location =
                    location.to_str().map_err(|_| Error::InvalidUrl("redirect Location is not ASCII".into()))?;
                let next = url.join(location).map_err(|e| Error::InvalidUrl(format!("redirect {location:?}: {e}")))?;
                drop(resp);
                let to_get = (status == StatusCode::SEE_OTHER && method != Method::HEAD)
                    || (matches!(status.as_u16(), 301 | 302) && method == Method::POST);
                if to_get {
                    method = Method::GET;
                    body = None;
                    headers.remove(header::CONTENT_TYPE);
                    headers.remove(header::CONTENT_ENCODING);
                }
                if next.origin() != url.origin() {
                    headers.remove(header::AUTHORIZATION);
                    headers.remove(header::COOKIE);
                }
                tracing::debug!(from = %url, to = %next, status = status.as_u16(), "gnome-net: following redirect");
                url = next;
                redirects += 1;
                continue;
            }
            let headers = resp.headers().clone();
            let body = read_limited(resp, limit).await?;
            return Ok(Response { status, headers, url, redirects, body });
        }
    }
}

fn build_headers(pairs: &[(String, String)]) -> Result<HeaderMap, Error> {
    let mut map = HeaderMap::with_capacity(pairs.len());
    for (k, v) in pairs {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| Error::InvalidRequest(format!("invalid header name {k:?}")))?;
        if FORBIDDEN_HEADERS.contains(&name.as_str()) {
            return Err(Error::InvalidRequest(format!("header {name} may not be set")));
        }
        let value =
            HeaderValue::from_str(v).map_err(|_| Error::InvalidRequest(format!("invalid value for header {name}")))?;
        map.append(name, value);
    }
    Ok(map)
}

async fn read_limited(mut resp: reqwest::Response, limit: u64) -> Result<Bytes, Error> {
    let declared = resp.content_length();
    if declared.is_some_and(|n| n > limit) {
        return Err(Error::BodyTooLarge { limit });
    }
    let cap = declared.unwrap_or(0).min(limit).min(1 << 20);
    let mut buf = BytesMut::with_capacity(usize::try_from(cap).unwrap_or(0));
    while let Some(chunk) = resp.chunk().await.map_err(map_reqwest)? {
        if (buf.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err(Error::BodyTooLarge { limit });
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf.freeze())
}

/// `"outer: inner: innermost"` for an error and its sources.
fn chain(e: &(dyn StdError + 'static)) -> String {
    let mut out = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let msg = s.to_string();
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        src = s.source();
    }
    out
}

fn map_reqwest(e: reqwest::Error) -> Error {
    let mut src: Option<&(dyn StdError + 'static)> = Some(&e);
    while let Some(s) = src {
        if let Some(b) = s.downcast_ref::<BlockedAddress>() {
            return Error::Blocked { host: b.host.clone(), ip: b.ip, class: b.class };
        }
        src = s.source();
    }
    if e.is_timeout() {
        return Error::Timeout;
    }
    Error::Network(chain(&e.without_url()))
}

/// An outbound request. Build with [`Request::get`] / [`Request::new`] and the builder methods.
#[derive(Debug, Clone)]
pub struct Request {
    method: Method,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Bytes>,
    allow_http: bool,
    max_body_bytes: Option<u64>,
    timeout: Option<Duration>,
}

impl Request {
    /// A request with any method.
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            allow_http: false,
            max_body_bytes: None,
            timeout: None,
        }
    }

    /// A `GET` request.
    pub fn get(url: impl Into<String>) -> Self {
        Self::new(Method::GET, url)
    }

    /// A `POST` request with a body.
    pub fn post(url: impl Into<String>, body: impl Into<Bytes>) -> Self {
        Self::new(Method::POST, url).body(body)
    }

    /// Add a header (validated when the request is sent). `User-Agent` replaces the client default; hop-by-hop
    /// and framing headers (`Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, ...) are rejected with
    /// [`Error::InvalidRequest`].
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Set the request body.
    #[must_use]
    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Allow plain `http://` for this request and its redirects (default: `https` only).
    #[must_use]
    pub fn allow_http(mut self, allow: bool) -> Self {
        self.allow_http = allow;
        self
    }

    /// Decoded-body limit for this request (default: the client's).
    #[must_use]
    pub fn max_body_bytes(mut self, n: u64) -> Self {
        self.max_body_bytes = Some(n);
        self
    }

    /// Total time budget for this request including redirects and the body (default: the client's).
    #[must_use]
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }

    /// Add `If-None-Match` (from the ETag) and `If-Modified-Since` (from Last-Modified) when present.
    #[must_use]
    pub fn conditional(mut self, cached: &Validators) -> Self {
        if let Some(etag) = &cached.etag {
            self = self.header("If-None-Match", etag.clone());
        }
        if let Some(lm) = &cached.last_modified {
            self = self.header("If-Modified-Since", lm.clone());
        }
        self
    }

    /// The method.
    pub fn method(&self) -> &Method {
        &self.method
    }

    /// The URL as given.
    pub fn url(&self) -> &str {
        &self.url
    }
}

/// A complete response: status, headers, final URL and the decoded body.
#[derive(Debug, Clone)]
pub struct Response {
    status: StatusCode,
    headers: HeaderMap,
    url: Url,
    redirects: usize,
    body: Bytes,
}

impl Response {
    /// HTTP status.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// Response headers. After decompression `Content-Encoding` and `Content-Length` are removed.
    pub fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    /// First value of a header, if it is valid UTF-8.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// All headers as `(name, value)` string pairs (values decoded lossily), e.g. for `gnome_catalog::FetchResponse`.
    pub fn header_pairs(&self) -> Vec<(String, String)> {
        self.headers
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
            .collect()
    }

    /// The URL of the final hop.
    pub fn url(&self) -> &Url {
        &self.url
    }

    /// How many redirects were followed.
    pub fn redirects(&self) -> usize {
        self.redirects
    }

    /// The decoded body.
    pub fn body(&self) -> &Bytes {
        &self.body
    }

    /// Take the body.
    pub fn into_body(self) -> Bytes {
        self.body
    }

    /// Whether the status is `304 Not Modified`.
    pub fn is_not_modified(&self) -> bool {
        self.status == StatusCode::NOT_MODIFIED
    }

    /// The `ETag` / `Last-Modified` validators of this response.
    pub fn validators(&self) -> Validators {
        Validators::from_headers(&self.headers)
    }
}

/// Cache validators for conditional GETs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Validators {
    /// `ETag` (sent back as `If-None-Match`).
    pub etag: Option<String>,
    /// `Last-Modified` (sent back as `If-Modified-Since`).
    pub last_modified: Option<String>,
}

impl Validators {
    /// Read `ETag` and `Last-Modified` from response headers (values that are not visible ASCII are ignored).
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let get = |name: header::HeaderName| {
            headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
        };
        Self { etag: get(header::ETAG), last_modified: get(header::LAST_MODIFIED) }
    }

    /// Whether there is nothing to validate with.
    pub fn is_empty(&self) -> bool {
        self.etag.is_none() && self.last_modified.is_none()
    }
}

/// Outcome of [`SafeClient::fetch_conditional`].
#[derive(Debug, Clone)]
pub enum Conditional {
    /// `304 Not Modified`: keep the cached copy.
    NotModified {
        /// Validators to store (refreshed from the 304 where it sent new ones).
        validators: Validators,
    },
    /// Anything else (usually `200`). Check the status before using the body.
    Modified {
        /// The response (boxed to keep the enum small).
        response: Box<Response>,
        /// Its validators, to store with the new copy.
        validators: Validators,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_patterns() {
        let p = |s| HostPattern::parse(s).unwrap();
        assert_eq!(p("Example.COM."), HostPattern::Exact("example.com".into()));
        assert!(p("example.com").matches("example.com"));
        assert!(!p("example.com").matches("www.example.com"));
        let w = p("*.example.com");
        assert!(w.matches("a.example.com"));
        assert!(w.matches("a.b.example.com"));
        assert!(!w.matches("example.com"));
        assert!(!w.matches("badexample.com"));
        assert!(p("bücher.example").matches("xn--bcher-kva.example"));
        assert!(p("192.0.2.1").matches("192.0.2.1"));
        assert!(p("[2001:db8::1]").matches("[2001:db8::1]"));
        for bad in ["", "*.", "*.192.0.2.1", "a/b", "example.com:443", "user@example.com", "*.*.x"] {
            assert!(HostPattern::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn config_validation() {
        assert!(SafeClient::new(SafeClientConfig::default()).is_ok());
        assert!(matches!(SafeClient::new(SafeClientConfig::default().max_redirects(6)), Err(Error::Config(_))));
        assert!(matches!(SafeClient::new(SafeClientConfig::default().allowed_ports([])), Err(Error::Config(_))));
        assert!(matches!(SafeClient::new(SafeClientConfig::default().allowed_hosts(["a/b"])), Err(Error::Config(_))));
        assert!(matches!(
            SafeClient::new(SafeClientConfig::default().source_url("https://x/\n")),
            Err(Error::Config(_))
        ));
    }

    #[test]
    fn user_agent() {
        assert_eq!(SafeClientConfig::default().user_agent(), format!("GNOME/{VERSION}"));
        assert_eq!(
            SafeClientConfig::default().source_url("https://git.example/gnome").user_agent(),
            format!("GNOME/{VERSION} (+https://git.example/gnome)")
        );
    }

    #[test]
    fn forbidden_headers() {
        assert!(build_headers(&[("Host".into(), "x".into())]).is_err());
        assert!(build_headers(&[("Transfer-Encoding".into(), "chunked".into())]).is_err());
        assert!(build_headers(&[("bad name".into(), "x".into())]).is_err());
        assert!(build_headers(&[("X-A".into(), "a\nb".into())]).is_err());
        assert_eq!(build_headers(&[("Accept".into(), "text/plain".into())]).unwrap().len(), 1);
    }
}
