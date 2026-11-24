//! The server-side VPN exit check (WAVE-C D14, D15, §6): gnome-server asks the operator's check service, through
//! each location's own HolyWisp instance, which address that location's traffic leaves from. Results are information
//! only: they never change the route or the connection state.
//!
//! The check, exactly: [`WispStream::connect`] to the profile's upstream (5 s; skipped while the health job has the
//! location `down`) → a Wisp CLOSE before any data is `connect_failed` → for `https:` a rustls handshake with the
//! check host's name (`tls_failed`) → `GET` with the neutral `User-Agent: exit-check/1` → at most 16 KiB read until
//! EOF → a non-2xx status is `http_status` → [`parse_answer`] (`bad_answer`). The whole check has a 15 s deadline.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::OnceCell;

use super::profiles::VpnProfile;
use super::wisp_client::{WispError, WispStream};
use crate::api::meta::UpstreamStatus;
use crate::config::Config;
use crate::gateway::Gateway;
use crate::state::AppState;
use crate::util::now_ms;

/// The neutral User-Agent of every check (names no product and no instance).
pub const USER_AGENT: &str = "exit-check/1";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const CHECK_DEADLINE: Duration = Duration::from_secs(15);
pub const MAX_ANSWER: usize = 16 * 1024;
/// An on-demand check of a location younger than this is answered without a new one.
pub const REUSE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitState {
    Ok,
    Failed,
    Unchecked,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitError {
    UpstreamUnreachable,
    ConnectFailed,
    TlsFailed,
    HttpStatus,
    BadAnswer,
    Timeout,
}

impl ExitError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UpstreamUnreachable => "upstream_unreachable",
            Self::ConnectFailed => "connect_failed",
            Self::TlsFailed => "tls_failed",
            Self::HttpStatus => "http_status",
            Self::BadAnswer => "bad_answer",
            Self::Timeout => "timeout",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExitResult {
    pub state: ExitState,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub provider_exit: Option<bool>,
    pub country_match: Option<bool>,
    pub checked_at: Option<i64>,
    pub error: Option<ExitError>,
    /// The check through `GNOME_VPN_CHECK_URL_V6` (`None` when not configured): `state`, `ip`, `error` only.
    pub v6: Option<ExitV6>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExitV6 {
    pub state: ExitState,
    pub ip: Option<String>,
    pub error: Option<ExitError>,
}

impl ExitResult {
    /// `state` with every other field `null`.
    pub fn empty(state: ExitState) -> Self {
        Self {
            state,
            ip: None,
            country: None,
            city: None,
            provider_exit: None,
            country_match: None,
            checked_at: None,
            error: None,
            v6: None,
        }
    }

    fn failed(error: ExitError) -> Self {
        Self { error: Some(error), ..Self::empty(ExitState::Failed) }
    }
}

/// A parsed check URL.
#[derive(Debug, Clone)]
struct Target {
    https: bool,
    host: String,
    port: u16,
    /// `path?query`.
    path: String,
    /// `host[:port]` as the `Host` header and the UI name it.
    authority: String,
}

impl Target {
    fn parse(url: &str) -> Option<Self> {
        let uri: http::Uri = url.parse().ok()?;
        let https = uri.scheme_str()?.eq_ignore_ascii_case("https");
        let authority = uri.authority()?;
        let host = authority.host().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        let default = if https { 443 } else { 80 };
        let port = authority.port_u16().unwrap_or(default);
        let path = uri.path_and_query().map_or("/", |p| p.as_str()).to_string();
        let shown = if authority.host().starts_with('[') { format!("[{host}]") } else { host.clone() };
        let authority = if port == default { shown } else { format!("{shown}:{port}") };
        Some(Self { https, host, port, path, authority })
    }
}

type Shared = Arc<OnceCell<ExitResult>>;

/// The checker, published as module state by the VPN module.
pub struct ExitChecker {
    v4: Target,
    v6: Option<Target>,
    tls: tokio_rustls::TlsConnector,
    results: Mutex<HashMap<String, ExitResult>>,
    inflight: Mutex<HashMap<String, Shared>>,
    on_demand: Mutex<HashMap<String, Instant>>,
    /// `(id, result)` → checks since start (`result` = `ok` or the error).
    counters: Mutex<BTreeMap<(String, &'static str), u64>>,
}

impl std::fmt::Debug for ExitChecker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExitChecker").field("service", &self.v4.authority).finish_non_exhaustive()
    }
}

/// The service's `host[:port]` of a check URL (`check_service` in `/api/vpn/locations`).
pub fn service_host(url: &str) -> Option<String> {
    Target::parse(url).map(|t| t.authority)
}

impl ExitChecker {
    /// `None` when `GNOME_VPN_CHECK_URL` is empty or there are no profiles.
    pub fn new(config: &Config) -> Option<Self> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        Self::with_roots(config, roots)
    }

    /// Tests: another root store (a test CA).
    pub fn with_roots(config: &Config, roots: rustls::RootCertStore) -> Option<Self> {
        let url = config.vpn_check_url.as_deref()?;
        if config.profiles.is_empty() {
            return None;
        }
        let v4 = Target::parse(url)?;
        let v6 = config.vpn_check_url_v6.as_deref().and_then(Target::parse);
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .ok()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Some(Self {
            v4,
            v6,
            tls: tokio_rustls::TlsConnector::from(Arc::new(tls)),
            results: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            on_demand: Mutex::new(HashMap::new()),
            counters: Mutex::new(BTreeMap::new()),
        })
    }

    /// The check service's host, for the UI's wording ("<host> reports …").
    pub fn service_host(&self) -> &str {
        &self.v4.authority
    }

    /// The last result (`unchecked` before the first one).
    pub fn result(&self, profile_id: &str) -> ExitResult {
        let r = self.results.lock().unwrap_or_else(|e| e.into_inner()).get(profile_id).cloned();
        r.unwrap_or_else(|| {
            let mut e = ExitResult::empty(ExitState::Unchecked);
            if self.v6.is_some() {
                e.v6 = Some(ExitV6 { state: ExitState::Unchecked, ip: None, error: None });
            }
            e
        })
    }

    pub fn results(&self) -> BTreeMap<String, ExitResult> {
        self.results.lock().unwrap_or_else(|e| e.into_inner()).iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// The on-demand rule: a check of this location younger than [`REUSE`] is reused (`Some`), else a new one may
    /// run (`None`, and the time is recorded).
    pub fn recent(&self, profile_id: &str) -> Option<ExitResult> {
        let now = now_ms();
        let last = self.results.lock().unwrap_or_else(|e| e.into_inner()).get(profile_id).cloned();
        if let Some(r) = last
            && r.checked_at.is_some_and(|t| now - t < REUSE.as_millis() as i64)
        {
            return Some(r);
        }
        self.on_demand.lock().unwrap_or_else(|e| e.into_inner()).insert(profile_id.to_string(), Instant::now());
        None
    }

    /// Check now through the profile's HolyWisp (the IPv4/default name, then the IPv6 name when configured);
    /// concurrent calls for one profile share one check. A `down` location (health job) is not contacted.
    pub async fn check(&self, state: &AppState, profile: &VpnProfile) -> ExitResult {
        let cell = {
            let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
            inflight.entry(profile.id.clone()).or_default().clone()
        };
        let result = cell.get_or_init(|| self.run(state, profile)).await.clone();
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if inflight.get(&profile.id).is_some_and(|c| Arc::ptr_eq(c, &cell)) {
            inflight.remove(&profile.id);
        }
        result
    }

    async fn run(&self, state: &AppState, profile: &VpnProfile) -> ExitResult {
        let down = state
            .ext::<Gateway>()
            .and_then(|gw| gw.upstreams.get(&profile.id).map(|u| u.status().0))
            .is_some_and(|s| s == UpstreamStatus::Down);
        let mut result = if down {
            ExitResult::failed(ExitError::UpstreamUnreachable)
        } else {
            match self.once(profile, &self.v4).await {
                Ok(r) => r,
                Err(e) => ExitResult::failed(e),
            }
        };
        if let Some(v6) = &self.v6 {
            result.v6 = Some(if down {
                ExitV6 { state: ExitState::Failed, ip: None, error: Some(ExitError::UpstreamUnreachable) }
            } else {
                match self.once(profile, v6).await {
                    Ok(r) => ExitV6 { state: ExitState::Ok, ip: r.ip, error: None },
                    Err(e) => ExitV6 { state: ExitState::Failed, ip: None, error: Some(e) },
                }
            });
        }
        result.checked_at = Some(now_ms());
        let label = result.error.map_or("ok", ExitError::as_str);
        *self.counters.lock().unwrap_or_else(|e| e.into_inner()).entry((profile.id.clone(), label)).or_default() += 1;
        self.results.lock().unwrap_or_else(|e| e.into_inner()).insert(profile.id.clone(), result.clone());
        result
    }

    async fn once(&self, profile: &VpnProfile, target: &Target) -> Result<ExitResult, ExitError> {
        match tokio::time::timeout(CHECK_DEADLINE, self.fetch(profile, target)).await {
            Ok(r) => r,
            Err(_) => Err(ExitError::Timeout),
        }
    }

    async fn fetch(&self, profile: &VpnProfile, target: &Target) -> Result<ExitResult, ExitError> {
        let stream =
            WispStream::connect(&profile.upstream, &profile.path(), &target.host, target.port, CONNECT_TIMEOUT)
                .await
                .map_err(|e| match e {
                WispError::Timeout => ExitError::Timeout,
                _ => ExitError::UpstreamUnreachable,
            })?;
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: {USER_AGENT}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            target.path, target.authority
        );
        let answer = if target.https {
            let name =
                rustls::pki_types::ServerName::try_from(target.host.clone()).map_err(|_| ExitError::TlsFailed)?;
            let probe = StreamProbe::new(stream);
            let end = probe.end.clone();
            match self.tls.connect(name, probe).await {
                Ok(mut tls) => exchange(&mut tls, &request, || end.closed_early()).await?,
                Err(_) => return Err(if end.closed_early() { ExitError::ConnectFailed } else { ExitError::TlsFailed }),
            }
        } else {
            let mut s = stream;
            let r = exchange_plain(&mut s, &request).await;
            r?
        };
        parse_http(&answer).and_then(|body| parse_answer(&body, profile))
    }

    pub fn diagnostics(&self, interval_min: u32) -> serde_json::Value {
        serde_json::json!({
            "check_service": self.service_host(),
            "interval_min": interval_min,
            "exits": self.results(),
        })
    }

    pub fn metrics(&self, out: &mut String) {
        use std::fmt::Write;
        let _ = writeln!(out, "# HELP gnome_vpn_exit_checks_total Server-side VPN exit checks by location and result.");
        let _ = writeln!(out, "# TYPE gnome_vpn_exit_checks_total counter");
        for ((id, result), n) in self.counters.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            let _ = writeln!(out, "gnome_vpn_exit_checks_total{{id=\"{id}\",result=\"{result}\"}} {n}");
        }
        let results = self.results();
        let _ = writeln!(out, "# HELP gnome_vpn_exit_ok Whether the last exit check of a location succeeded.");
        let _ = writeln!(out, "# TYPE gnome_vpn_exit_ok gauge");
        for (id, r) in &results {
            let _ = writeln!(out, "gnome_vpn_exit_ok{{id=\"{id}\"}} {}", u8::from(r.state == ExitState::Ok));
        }
        let _ = writeln!(out, "# HELP gnome_vpn_exit_checked_seconds Unix time of the last exit check of a location.");
        let _ = writeln!(out, "# TYPE gnome_vpn_exit_checked_seconds gauge");
        for (id, r) in &results {
            if let Some(t) = r.checked_at {
                let _ = writeln!(out, "gnome_vpn_exit_checked_seconds{{id=\"{id}\"}} {}", t / 1000);
            }
        }
    }
}

/// Records whether the Wisp stream was closed by the server before it sent any data (the target refused).
#[derive(Debug, Clone, Default)]
struct EarlyEnd(Arc<Mutex<Option<StreamEnd>>>);

/// How the stream ended (its error) and how many bytes it had received.
type StreamEnd = (Option<WispError>, u64);

impl EarlyEnd {
    fn closed_early(&self) -> bool {
        matches!(*self.0.lock().unwrap_or_else(|e| e.into_inner()), Some((Some(WispError::Closed(_)), 0)))
    }
}

/// A [`WispStream`] that remembers, at its end of input, how the server closed it.
struct StreamProbe {
    inner: WispStream,
    end: EarlyEnd,
}

impl StreamProbe {
    fn new(inner: WispStream) -> Self {
        Self { inner, end: EarlyEnd::default() }
    }
}

impl AsyncRead for StreamProbe {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let poll = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = &poll
            && buf.filled().len() == before
        {
            let record = (self.inner.error(), self.inner.received());
            *self.end.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(record);
        }
        poll
    }
}

impl AsyncWrite for StreamProbe {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Send the request and read the answer until EOF (at most [`MAX_ANSWER`] bytes).
async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    request: &str,
    closed_early: impl Fn() -> bool,
) -> Result<Vec<u8>, ExitError> {
    let res = read_answer(s, request).await;
    match res {
        Err(ExitError::BadAnswer) => Err(ExitError::BadAnswer),
        Err(_) if closed_early() => Err(ExitError::ConnectFailed),
        other => other,
    }
}

async fn exchange_plain(s: &mut WispStream, request: &str) -> Result<Vec<u8>, ExitError> {
    let answer = read_answer(s, request).await;
    let empty = answer.as_ref().is_ok_and(Vec::is_empty) || answer.is_err();
    if empty && s.received() == 0 && matches!(s.error(), Some(WispError::Closed(_))) {
        return Err(ExitError::ConnectFailed);
    }
    answer
}

async fn read_answer<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, request: &str) -> Result<Vec<u8>, ExitError> {
    s.write_all(request.as_bytes()).await.map_err(|_| ExitError::ConnectFailed)?;
    s.flush().await.map_err(|_| ExitError::ConnectFailed)?;
    let mut out = Vec::with_capacity(4096);
    let mut buf = [0u8; 4096];
    loop {
        match s.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if out.len() + n > MAX_ANSWER {
                    return Err(ExitError::BadAnswer);
                }
                out.extend_from_slice(&buf[..n]);
            }
            // A TLS peer that closes without close_notify still delivered a complete answer.
            Err(_) if !out.is_empty() => break,
            Err(_) => return Err(ExitError::ConnectFailed),
        }
    }
    Ok(out)
}

/// The head (httparse) and the body (`Content-Length`, chunked, or until EOF) of an HTTP/1.1 answer.
fn parse_http(answer: &[u8]) -> Result<Vec<u8>, ExitError> {
    if answer.is_empty() {
        return Err(ExitError::ConnectFailed);
    }
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut resp = httparse::Response::new(&mut headers);
    let head_len = match resp.parse(answer) {
        Ok(httparse::Status::Complete(n)) => n,
        _ => return Err(ExitError::BadAnswer),
    };
    let code = resp.code.unwrap_or(0);
    if !(200..300).contains(&code) {
        return Err(ExitError::HttpStatus);
    }
    let header = |name: &str| {
        resp.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)).and_then(|h| std::str::from_utf8(h.value).ok())
    };
    let body = &answer[head_len..];
    if header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        return dechunk(body);
    }
    if let Some(len) = header("content-length") {
        let len: usize = len.trim().parse().map_err(|_| ExitError::BadAnswer)?;
        return body.get(..len).map(<[u8]>::to_vec).ok_or(ExitError::BadAnswer);
    }
    Ok(body.to_vec())
}

fn dechunk(mut body: &[u8]) -> Result<Vec<u8>, ExitError> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|w| w == b"\r\n").ok_or(ExitError::BadAnswer)?;
        let size_text = std::str::from_utf8(&body[..line_end]).map_err(|_| ExitError::BadAnswer)?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| ExitError::BadAnswer)?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size + 2 || out.len() + size > MAX_ANSWER {
            return Err(ExitError::BadAnswer);
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

fn text_field(v: &serde_json::Value, max_chars: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    (!s.is_empty() && s.chars().count() <= max_chars && !s.chars().any(char::is_control)).then(|| s.to_string())
}

/// The check service's JSON → ip (an IP literal, required), country (≤ 64), city (≤ 128), the optional
/// `country_code`/`country_iso` (two letters), the optional `mullvad_exit_ip` boolean → `provider_exit`;
/// `country_match` against the profile (code if given, else the name, case-insensitive; `None` if neither).
pub fn parse_answer(body: &[u8], profile: &VpnProfile) -> Result<ExitResult, ExitError> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| ExitError::BadAnswer)?;
    let obj = v.as_object().ok_or(ExitError::BadAnswer)?;
    let ip: IpAddr =
        obj.get("ip").and_then(|i| i.as_str()).and_then(|s| s.trim().parse().ok()).ok_or(ExitError::BadAnswer)?;
    let country = obj.get("country").and_then(|c| text_field(c, 64));
    let city = obj.get("city").and_then(|c| text_field(c, 128));
    let code = ["country_code", "country_iso"]
        .iter()
        .find_map(|k| obj.get(*k).and_then(|c| c.as_str()))
        .map(str::trim)
        .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_alphabetic()));
    let country_match = match (code, &country) {
        (Some(c), _) => Some(c.eq_ignore_ascii_case(&profile.country_code)),
        (None, Some(name)) => Some(name.eq_ignore_ascii_case(&profile.country)),
        (None, None) => None,
    };
    Ok(ExitResult {
        state: ExitState::Ok,
        ip: Some(ip.to_string()),
        country,
        city,
        provider_exit: obj.get("mullvad_exit_ip").and_then(serde_json::Value::as_bool),
        country_match,
        checked_at: None,
        error: None,
        v6: None,
    })
}

/// When the first scheduled check of a location runs: a random point of the whole first interval (never a burst
/// after boot, which would link an instance's locations together). `r` is uniform in `[0, 1)`.
pub fn first_delay(interval: Duration, r: f64) -> Duration {
    interval.mul_f64(r.clamp(0.0, 1.0))
}

/// The delay after a check: the interval × a random factor in 0.8–1.2. `r` is uniform in `[0, 1)`.
pub fn next_delay(interval: Duration, r: f64) -> Duration {
    interval.mul_f64(0.8 + 0.4 * r.clamp(0.0, 1.0))
}

/// A uniform `[0, 1)` from the OS's randomness.
pub fn random_unit() -> f64 {
    let b = crate::security::crypto::random_bytes::<8>();
    (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> VpnProfile {
        crate::vpn::profiles::parse(
            std::path::Path::new("p.toml"),
            "[[profile]]\nid = \"se\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \"Gothenburg\"\nwisp_upstream = \"127.0.0.1:21999\"\n",
        )
        .unwrap()
        .remove(0)
    }

    #[test]
    fn answers() {
        let p = profile();
        // am.i.mullvad.net's documented shape (research §3.5).
        let mullvad = br#"{"ip":"185.65.134.1","country":"Sweden","city":"Gothenburg","longitude":11.9,"latitude":57.7,"mullvad_exit_ip":true,"mullvad_exit_ip_hostname":"se-got-wg-001","mullvad_server_type":"WireGuard","blacklisted":{"blacklisted":false,"results":[]},"organization":"M247"}"#;
        let r = parse_answer(mullvad, &p).unwrap();
        assert_eq!((r.ip.as_deref(), r.country_match, r.provider_exit), (Some("185.65.134.1"), Some(true), Some(true)));
        let other = br#"{"ip":"2001:db8::1","country":"Germany","country_iso":"DE","city":"Berlin"}"#;
        let r = parse_answer(other, &p).unwrap();
        assert_eq!((r.ip.as_deref(), r.country_match, r.provider_exit), (Some("2001:db8::1"), Some(false), None));
        let bare = parse_answer(br#"{"ip":"192.0.2.1"}"#, &p).unwrap();
        assert_eq!((bare.country_match, bare.country, bare.city), (None, None, None));
        for bad in [&br#"{"country":"Sweden"}"#[..], b"{\"ip\":\"nope\"}", b"<html>", b"[]", b""] {
            assert_eq!(parse_answer(bad, &p), Err(ExitError::BadAnswer));
        }
    }

    #[test]
    fn http_bodies() {
        assert_eq!(parse_http(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra").unwrap(), b"{}");
        assert_eq!(
            parse_http(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{\"\r\n1\r\n}\r\n0\r\n\r\n")
                .unwrap(),
            b"{\"}"
        );
        assert_eq!(parse_http(b"HTTP/1.1 500 Oops\r\n\r\n"), Err(ExitError::HttpStatus));
        assert_eq!(parse_http(b"garbage"), Err(ExitError::BadAnswer));
    }

    #[test]
    fn schedule() {
        let i = Duration::from_secs(900);
        assert_eq!(first_delay(i, 0.0), Duration::ZERO);
        assert!(first_delay(i, 0.999) < i);
        assert_eq!(next_delay(i, 0.0), Duration::from_secs(720));
        assert!(next_delay(i, 0.999) < Duration::from_secs(1080));
        let r = random_unit();
        assert!((0.0..1.0).contains(&r));
    }

    #[test]
    fn targets() {
        let t = Target::parse("https://check.example.net/json?x=1").unwrap();
        assert_eq!(
            (t.https, t.host.as_str(), t.port, t.path.as_str(), t.authority.as_str()),
            (true, "check.example.net", 443, "/json?x=1", "check.example.net")
        );
        assert_eq!(service_host("http://127.0.0.1:21060/").as_deref(), Some("127.0.0.1:21060"));
        assert_eq!(service_host("https://[2001:db8::1]:8443/").as_deref(), Some("[2001:db8::1]:8443"));
    }
}
