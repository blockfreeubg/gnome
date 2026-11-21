//! Configuration (docs/ARCHITECTURE.md §4.2).
//!
//! Sources, highest precedence first: environment variables, the optional TOML file named by `GNOME_CONFIG`, built-in
//! defaults. TOML keys are the variable names without the `GNOME_` prefix, lowercased (`bind = "0.0.0.0:8080"`,
//! `public_origins = ["https://gnome.example.com"]`). Unknown TOML keys are rejected so typos are caught.
//!
//! Adding a setting: add a [`VarSpec`] to [`VARS`], a field to [`Config`], parse it in [`Config::from_lookup`] and
//! document it in ARCHITECTURE §4.2 + backend/README.md.
//!
//! Settings of modules this build does not include yet are validated already (a config file stays valid across
//! upgrades) but carry [`VarSpec::inactive`]: `config check` labels them and setting one produces a warning. Clear
//! the marker in the change that makes a module read the setting.

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use ipnet::IpNet;

use crate::gateway::upstream::UpstreamAddr;
use crate::origins::ProxySetup;
use crate::security::origin::normalize_origin;
use crate::util::Secret;
use crate::vpn::profiles::VpnProfile;

/// Environment variable naming an optional TOML configuration file.
pub const CONFIG_FILE_VAR: &str = "GNOME_CONFIG";

/// One recognised setting.
#[derive(Debug, Clone, Copy)]
pub struct VarSpec {
    pub name: &'static str,
    pub default: &'static str,
    /// Never printed (`config check`, `Debug`, error messages).
    pub secret: bool,
    /// Whether an explicitly empty value means something (otherwise empty = unset = default).
    pub empty_allowed: bool,
    pub help: &'static str,
    /// Read by a module this build does not include (named here): the value is validated but has no effect.
    pub inactive: Option<&'static str>,
}

const fn var(name: &'static str, default: &'static str, help: &'static str) -> VarSpec {
    VarSpec { name, default, secret: false, empty_allowed: false, help, inactive: None }
}

const fn var_empty_ok(name: &'static str, default: &'static str, help: &'static str) -> VarSpec {
    VarSpec { name, default, secret: false, empty_allowed: true, help, inactive: None }
}

const fn secret(name: &'static str, help: &'static str) -> VarSpec {
    VarSpec { name, default: "", secret: true, empty_allowed: false, help, inactive: None }
}

/// Mark a setting as belonging to `module`, which this build does not include.
const fn inactive(spec: VarSpec, module: &'static str) -> VarSpec {
    VarSpec { inactive: Some(module), ..spec }
}

const GAME_CATALOG: &str = "the game catalog";

/// Every setting the server understands, in documentation order.
pub const VARS: &[VarSpec] = &[
    var("GNOME_BIND", "0.0.0.0:8080", "public listener address"),
    var_empty_ok("GNOME_ADMIN_BIND", "127.0.0.1:9091", "admin listener address; empty disables it"),
    secret("GNOME_ADMIN_TOKEN", "bearer token required by the admin listener (>= 16 chars)"),
    var("GNOME_ADMIN_ALLOW_REMOTE", "false", "allow a non-loopback GNOME_ADMIN_BIND (also requires GNOME_ADMIN_TOKEN)"),
    var("GNOME_DATA_DIR", "./data", "SQLite database, secret key, filter lists, caches"),
    var("GNOME_STATIC_DIR", "./frontend/dist", "built SPA served on the public listener"),
    var(
        "GNOME_STATIC_RELOAD",
        "false",
        "development only: re-index GNOME_STATIC_DIR after a rebuild (on a miss under /assets/, /engine/, /sw.js or \
         /vendor/, at most once per second, and when a served unhashed file changed)",
    ),
    var("GNOME_PUBLIC_ORIGINS", "", "comma-separated allowed origins; empty = same-origin check against Host"),
    var(
        "GNOME_PROXY_ORIGIN",
        "",
        "origin of the isolated proxy role (engine host, /wisp/), e.g. https://p.example.com",
    ),
    var("GNOME_PROXY_BIND", "", "optional second listener that always serves the proxy-origin role"),
    var("GNOME_WISP_TICKET_TTL_S", "3600", "upper bound of a Wisp ticket's lifetime in seconds (60-604800)"),
    var(
        "GNOME_ALLOW_CUSTOM_WISP",
        "false",
        "let users choose their own Wisp servers (adds ws: wss: to the engine-host and bare-mux worker CSPs)",
    ),
    var_empty_ok("GNOME_TRUSTED_PROXIES", "127.0.0.1/32,::1/128", "CIDRs whose X-Forwarded-* headers are trusted"),
    var("GNOME_ACCESS_MODE", "open", "who may use the proxy: open | code | accounts"),
    secret("GNOME_ACCESS_CODE", "access code required in code mode (>= 4 chars)"),
    var("GNOME_ACCOUNTS", "true", "enable user accounts and sync (/api/auth/*, /api/sync/*)"),
    var("GNOME_REGISTRATION", "open", "self-service registration: open | closed"),
    secret("GNOME_SECRET_KEY", "base64 key (>= 32 bytes); generated into $GNOME_DATA_DIR/secret.key when unset"),
    var(
        "GNOME_COOKIE_SECURE",
        "auto",
        "Secure cookie attribute (and __Host- names): auto (HTTPS, or a plain-HTTP loopback app origin) | true | false",
    ),
    var("GNOME_WISP_UPSTREAM", "127.0.0.1:6001", "primary HolyWisp address (internal host:port)"),
    var("GNOME_VPN_PROFILES", "", "path to the VPN gateway profiles TOML (egress HolyWisp instances)"),
    var("GNOME_SOURCE_URL", "", "link to the corresponding source code (AGPL-3.0 section 13), shown in About"),
    var("GNOME_ENGINES", "scramjet,ultraviolet", "enabled proxy engines"),
    var("GNOME_ENGINE_DEFAULT", "scramjet", "default proxy engine (must be enabled)"),
    inactive(var("GNOME_CATALOG_REFRESH_HOURS", "24", "periodic game catalog import interval; 0 = off"), GAME_CATALOG),
    inactive(var("GNOME_CATALOG_SOURCES", "gamepix,oss", "enabled game catalog importers"), GAME_CATALOG),
    var(
        "GNOME_FILTERS_REFRESH_HOURS",
        "24",
        "filter-list re-check interval for lists without '! Expires' (clamped 4-168 h); 0 = manual refresh only",
    ),
    var("GNOME_FILTER_LISTS_FILE", "", "TOML file that adds, overrides or disables filter lists"),
    inactive(var("GNOME_THUMB_PROXY", "true", "serve game thumbnails through /api/thumb/:id"), GAME_CATALOG),
    inactive(var("GNOME_THUMB_CACHE_MB", "256", "disk cap for the thumbnail cache"), GAME_CATALOG),
    var("GNOME_MAX_WS_PER_IP", "32", "concurrent Wisp connections per client IP (IPv6: per /64)"),
    var("GNOME_MAX_WS_PER_SESSION", "16", "concurrent Wisp connections per session"),
    var("GNOME_RATE_LIMIT_SCALE", "1.0", "multiplies every rate limit; 0 disables rate limiting"),
    var("GNOME_ARGON2_MEMORY_KIB", "19456", "Argon2id memory cost in KiB (t=2, p=1)"),
    var("GNOME_WORKERS", "", "Tokio worker threads; default = number of CPUs"),
    var("GNOME_DB_READERS", "4", "SQLite read-only connection pool size"),
    var("GNOME_LOG", "info", "tracing EnvFilter directive"),
    var("GNOME_LOG_FORMAT", "pretty", "log format: pretty (human-readable) | json"),
    var("GNOME_LOG_IPS", "false", "include client IPs in access logs"),
    var("GNOME_CSP", "on", "Content-Security-Policy for the shell: on | off | report-only"),
    var("GNOME_PROXY_CSP", "", "a second CSP for engine-host documents (can only restrict the built-in policy)"),
    var("GNOME_HSTS", "false", "send Strict-Transport-Security on HTTPS responses"),
];

fn spec(name: &str) -> &'static VarSpec {
    VARS.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("unknown config variable {name}"))
}

/// Who may use the proxy (`/wisp/`), see ARCHITECTURE §4.3.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    /// Anyone gets an anonymous session.
    Open,
    /// An access code is required to obtain an anonymous session.
    Code,
    /// A signed-in account is required.
    Accounts,
}

impl AccessMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Code => "code",
            Self::Accounts => "accounts",
        }
    }

    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "open" => Ok(Self::Open),
            "code" => Ok(Self::Code),
            "accounts" => Ok(Self::Accounts),
            _ => Err("expected one of: open, code, accounts".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Registration {
    Open,
    Closed,
}

impl Registration {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }

    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            _ => Err("expected one of: open, closed".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieSecure {
    /// `Secure` when the request arrived over HTTPS (directly or via a trusted proxy's X-Forwarded-Proto).
    Auto,
    Always,
    Never,
}

impl CookieSecure {
    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "true" | "1" | "yes" | "on" => Ok(Self::Always),
            "false" | "0" | "no" | "off" => Ok(Self::Never),
            _ => Err("expected one of: auto, true, false".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Pretty,
    Json,
}

impl LogFormat {
    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "pretty" => Ok(Self::Pretty),
            "json" => Ok(Self::Json),
            _ => Err("expected one of: pretty, json".into()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CspMode {
    On,
    Off,
    ReportOnly,
}

impl CspMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::On => "on",
            Self::Off => "off",
            Self::ReportOnly => "report-only",
        }
    }

    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "on" | "true" | "1" => Ok(Self::On),
            "off" | "false" | "0" => Ok(Self::Off),
            "report-only" | "report_only" => Ok(Self::ReportOnly),
            _ => Err("expected one of: on, off, report-only".into()),
        }
    }
}

/// Proxy engines the SPA may use (`/api/config` → `engines`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineId {
    Scramjet,
    Ultraviolet,
}

impl EngineId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Scramjet => "scramjet",
            Self::Ultraviolet => "ultraviolet",
        }
    }

    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "scramjet" => Ok(Self::Scramjet),
            "ultraviolet" | "uv" => Ok(Self::Ultraviolet),
            other => Err(format!("unknown engine {other:?} (expected scramjet or ultraviolet)")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Engines {
    pub default: EngineId,
    pub scramjet: bool,
    pub ultraviolet: bool,
}

/// Where an effective value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    Default,
    File,
    Env,
}

impl Provenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::File => "file",
            Self::Env => "env",
        }
    }
}

/// One effective setting as shown by `gnome-server config check` (secrets already redacted).
#[derive(Debug, Clone)]
pub struct Setting {
    pub name: &'static str,
    pub value: String,
    pub provenance: Provenance,
    /// See [`VarSpec::inactive`].
    pub inactive: Option<&'static str>,
}

/// Validated, immutable server configuration. `Debug` redacts secrets.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: SocketAddr,
    pub admin_bind: Option<SocketAddr>,
    pub admin_token: Option<Secret>,
    pub admin_allow_remote: bool,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// `GNOME_STATIC_RELOAD`: re-index the static dir after a rebuild (development only, `static_files`).
    pub static_reload: bool,
    /// Normalized (`scheme://host[:port]`, lowercase, default port removed).
    pub public_origins: Vec<String>,
    /// `GNOME_PROXY_ORIGIN` as configured (normalized). See [`Config::proxy`] for the effective setup.
    pub proxy_origin: Option<String>,
    /// `GNOME_PROXY_BIND`: a listener that always has the proxy role.
    pub proxy_bind: Option<SocketAddr>,
    /// The resolved two-origin setup (single-origin mode when no proxy origin is configured or derived).
    pub proxy: ProxySetup,
    /// `GNOME_PROXY_CSP`: the operator's second policy for engine-host documents (validated, single policy, no
    /// `frame-ancestors`).
    pub proxy_csp: Option<String>,
    pub wisp_ticket_ttl_s: u32,
    /// `GNOME_ALLOW_CUSTOM_WISP`: users may connect to Wisp servers of their own (`/api/config` →
    /// `wisp.custom_servers`; the engine-host and bare-mux worker policies add `ws: wss:`).
    pub allow_custom_wisp: bool,
    pub trusted_proxies: Vec<IpNet>,
    pub access_mode: AccessMode,
    pub access_code: Option<Secret>,
    pub accounts: bool,
    pub registration: Registration,
    /// Raw configured key (validated base64, >= 32 bytes) or `None` → `$GNOME_DATA_DIR/secret.key`.
    pub secret_key: Option<Secret>,
    pub cookie_secure: CookieSecure,
    pub wisp_upstream: UpstreamAddr,
    /// `GNOME_VPN_PROFILES` (path) and the profiles loaded from it.
    pub vpn_profiles: Option<PathBuf>,
    pub profiles: Vec<VpnProfile>,
    pub source_url: Option<String>,
    pub engines: Engines,
    pub catalog_refresh_hours: u32,
    pub catalog_sources: Vec<String>,
    pub filters_refresh_hours: u32,
    /// `GNOME_FILTER_LISTS_FILE` (path) and the effective filter-list registry (built-ins + overrides).
    pub filter_lists_file: Option<PathBuf>,
    pub filter_lists: Vec<crate::filters::registry::ListDef>,
    pub thumb_proxy: bool,
    pub thumb_cache_mb: u32,
    pub max_ws_per_ip: u32,
    pub max_ws_per_session: u32,
    /// 0 disables rate limiting.
    pub rate_limit_scale: f64,
    pub argon2_memory_kib: u32,
    pub workers: Option<usize>,
    pub db_readers: usize,
    pub log: String,
    pub log_format: LogFormat,
    pub log_ips: bool,
    pub csp: CspMode,
    pub hsts: bool,
    /// The TOML file that was loaded, if any.
    pub config_file: Option<PathBuf>,
    /// Non-fatal observations (printed at startup and by `config check`).
    pub warnings: Vec<String>,
    /// Effective values with provenance, in [`VARS`] order (secrets redacted).
    pub settings: Vec<Setting>,
}

/// All configuration problems found (reported together).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    pub problems: Vec<String>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "invalid configuration:")?;
        for p in &self.problems {
            writeln!(f, "  - {p}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

/// A parsed TOML configuration file.
#[derive(Debug, Clone)]
pub struct ConfigFile {
    pub path: PathBuf,
    pub table: toml::Table,
}

impl ConfigFile {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = std::fs::read_to_string(path).map_err(|e| ConfigError {
            problems: vec![format!("{CONFIG_FILE_VAR}: cannot read {}: {e}", path.display())],
        })?;
        Self::parse(path, &text)
    }

    pub fn parse(path: &Path, text: &str) -> Result<Self, ConfigError> {
        let table = text.parse::<toml::Table>().map_err(|e| ConfigError {
            problems: vec![format!("{CONFIG_FILE_VAR}: {} is not valid TOML: {e}", path.display())],
        })?;
        Ok(Self { path: path.to_path_buf(), table })
    }
}

impl Config {
    /// Load from the process environment (+ `GNOME_CONFIG` file).
    pub fn from_env() -> Result<Self, ConfigError> {
        let file = match std::env::var_os(CONFIG_FILE_VAR) {
            Some(p) if !p.is_empty() => Some(ConfigFile::load(Path::new(&p))?),
            _ => None,
        };
        Self::from_lookup(|k| std::env::var(k).ok(), file)
    }

    /// Load from an arbitrary variable lookup (tests use a map) layered over an optional file.
    pub fn from_lookup<F>(env: F, file: Option<ConfigFile>) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut problems = Vec::new();
        let mut raw: BTreeMap<&'static str, (String, Provenance)> = BTreeMap::new();

        if let Some(file) = &file {
            for (key, value) in &file.table {
                let name = format!("GNOME_{}", key.to_ascii_uppercase());
                let Some(spec) = VARS.iter().find(|s| s.name == name) else {
                    problems.push(format!(
                        "{}: unknown key {key:?} (keys are setting names without GNOME_, lowercased, e.g. \"bind\")",
                        file.path.display()
                    ));
                    continue;
                };
                match toml_scalar(value) {
                    Ok(v) => {
                        raw.insert(spec.name, (v, Provenance::File));
                    }
                    Err(e) => problems.push(format!("{}: {key}: {e}", file.path.display())),
                }
            }
        }
        for spec in VARS {
            if let Some(v) = env(spec.name) {
                raw.insert(spec.name, (v, Provenance::Env));
            }
        }

        let mut p = Parser { raw, problems, warnings: Vec::new() };

        let bind = p.parse("GNOME_BIND", parse_socket_addr);
        let admin_bind = p
            .parse("GNOME_ADMIN_BIND", |v| if v.trim().is_empty() { Ok(None) } else { parse_socket_addr(v).map(Some) });
        let admin_token = p.parse_opt("GNOME_ADMIN_TOKEN", |v| {
            let v = v.trim();
            if v.chars().count() < 16 {
                Err("must be at least 16 characters".into())
            } else if v.chars().any(|c| c.is_whitespace() || c.is_control()) {
                Err("must not contain whitespace or control characters".into())
            } else {
                Ok(Secret::new(v))
            }
        });
        let admin_allow_remote = p.parse("GNOME_ADMIN_ALLOW_REMOTE", parse_bool);
        let data_dir = p.parse("GNOME_DATA_DIR", parse_path);
        let static_dir = p.parse("GNOME_STATIC_DIR", parse_path);
        let static_reload = p.parse("GNOME_STATIC_RELOAD", parse_bool);
        let public_origins = p.parse("GNOME_PUBLIC_ORIGINS", parse_origins);
        let proxy_origin = p.parse_opt("GNOME_PROXY_ORIGIN", parse_single_origin);
        let proxy_bind = p.parse_opt("GNOME_PROXY_BIND", parse_socket_addr);
        let wisp_ticket_ttl_s = p.parse("GNOME_WISP_TICKET_TTL_S", |v| parse_u32_in(v, 60, 604_800));
        let allow_custom_wisp = p.parse("GNOME_ALLOW_CUSTOM_WISP", parse_bool);
        let trusted_proxies = p.parse("GNOME_TRUSTED_PROXIES", parse_cidrs);
        let access_mode = p.parse("GNOME_ACCESS_MODE", AccessMode::parse);
        let access_code = p.parse_opt("GNOME_ACCESS_CODE", |v| {
            let v = v.trim();
            if v.chars().count() < 4 {
                Err("must be at least 4 characters".into())
            } else if v.chars().count() > 256 {
                Err("must be at most 256 characters".into())
            } else {
                Ok(Secret::new(v))
            }
        });
        let accounts = p.parse("GNOME_ACCOUNTS", parse_bool);
        let registration = p.parse("GNOME_REGISTRATION", Registration::parse);
        let secret_key = p.parse_opt("GNOME_SECRET_KEY", |v| {
            crate::security::secret_key::decode_key(v).map(|_| Secret::new(v.trim()))
        });
        let cookie_secure = p.parse("GNOME_COOKIE_SECURE", CookieSecure::parse);
        let wisp_upstream = p.parse("GNOME_WISP_UPSTREAM", UpstreamAddr::parse);
        let vpn_profiles = p.parse_opt("GNOME_VPN_PROFILES", parse_path);
        let source_url = p.parse_opt("GNOME_SOURCE_URL", parse_http_url);
        let enabled_engines = p.parse("GNOME_ENGINES", parse_engines);
        let engine_default = p.parse("GNOME_ENGINE_DEFAULT", EngineId::parse);
        let catalog_refresh_hours = p.parse("GNOME_CATALOG_REFRESH_HOURS", |v| parse_u32_in(v, 0, 8760));
        let catalog_sources = p.parse("GNOME_CATALOG_SOURCES", parse_ident_list);
        let filters_refresh_hours = p.parse("GNOME_FILTERS_REFRESH_HOURS", |v| parse_u32_in(v, 0, 8760));
        let filter_lists_file = p.parse_opt("GNOME_FILTER_LISTS_FILE", parse_path);
        let thumb_proxy = p.parse("GNOME_THUMB_PROXY", parse_bool);
        let thumb_cache_mb = p.parse("GNOME_THUMB_CACHE_MB", |v| parse_u32_in(v, 0, 1_048_576));
        let max_ws_per_ip = p.parse("GNOME_MAX_WS_PER_IP", |v| parse_u32_in(v, 1, 100_000));
        let max_ws_per_session = p.parse("GNOME_MAX_WS_PER_SESSION", |v| parse_u32_in(v, 1, 100_000));
        let rate_limit_scale = p.parse("GNOME_RATE_LIMIT_SCALE", parse_scale);
        let argon2_memory_kib = p.parse("GNOME_ARGON2_MEMORY_KIB", |v| parse_u32_in(v, 1024, 1_048_576));
        let workers = p.parse_opt("GNOME_WORKERS", |v| parse_u32_in(v, 1, 1024).map(|n| n as usize));
        let db_readers = p.parse("GNOME_DB_READERS", |v| parse_u32_in(v, 1, 64)) as usize;
        let log = p.parse("GNOME_LOG", parse_log_filter);
        let log_format = p.parse("GNOME_LOG_FORMAT", LogFormat::parse);
        let log_ips = p.parse("GNOME_LOG_IPS", parse_bool);
        let csp = p.parse("GNOME_CSP", CspMode::parse);
        let proxy_csp = p.parse_opt("GNOME_PROXY_CSP", parse_proxy_csp);
        let hsts = p.parse("GNOME_HSTS", parse_bool);

        // Cross-field rules.
        if access_mode == AccessMode::Code && access_code.is_none() && !p.failed("GNOME_ACCESS_CODE") {
            p.problems.push("GNOME_ACCESS_MODE=code requires GNOME_ACCESS_CODE".into());
        }
        if access_mode == AccessMode::Code
            && let Some(code) = &access_code
            && code.expose().chars().count() < 8
        {
            p.warnings.push(
                "GNOME_ACCESS_CODE is shorter than 8 characters: attempts are limited per client IP only (20 per \
                 minute), so a short code can be guessed from many addresses"
                    .into(),
            );
        }
        if access_mode != AccessMode::Code && access_code.is_some() {
            p.warnings.push("GNOME_ACCESS_CODE is set but GNOME_ACCESS_MODE is not \"code\"; it is ignored".into());
        }
        if access_mode == AccessMode::Accounts && !accounts {
            p.problems.push("GNOME_ACCESS_MODE=accounts requires GNOME_ACCOUNTS=true".into());
        }
        if let Some(admin) = admin_bind {
            if !admin.ip().is_loopback() && !(admin_allow_remote && admin_token.is_some()) {
                p.problems.push(format!(
                    "GNOME_ADMIN_BIND={admin} is not a loopback address; refusing to expose the admin listener. \
                     Bind it to 127.0.0.1/::1, or set GNOME_ADMIN_ALLOW_REMOTE=true and GNOME_ADMIN_TOKEN"
                ));
            }
            if admin.port() == bind.port() && (admin.ip() == bind.ip() || bind.ip().is_unspecified()) {
                p.problems.push(format!("GNOME_ADMIN_BIND={admin} collides with GNOME_BIND={bind}"));
            }
        }
        if let Some(proxy) = proxy_bind {
            let collides = |other: SocketAddr| {
                other.port() == proxy.port()
                    && (other.ip() == proxy.ip() || other.ip().is_unspecified() || proxy.ip().is_unspecified())
            };
            if collides(bind) {
                p.problems.push(format!("GNOME_PROXY_BIND={proxy} collides with GNOME_BIND={bind}"));
            }
            if let Some(admin) = admin_bind.filter(|a| collides(*a)) {
                p.problems.push(format!("GNOME_PROXY_BIND={proxy} collides with GNOME_ADMIN_BIND={admin}"));
            }
        }
        let proxy = if p.failed("GNOME_PROXY_ORIGIN") || p.failed("GNOME_PROXY_BIND") {
            ProxySetup::single_origin()
        } else {
            ProxySetup::resolve(
                proxy_origin.as_deref(),
                proxy_bind,
                &public_origins,
                bind,
                &mut p.problems,
                &mut p.warnings,
            )
        };
        let profiles = match &vpn_profiles {
            Some(path) if !p.failed("GNOME_VPN_PROFILES") => match crate::vpn::profiles::load(path) {
                Ok(list) => list,
                Err(problems) => {
                    p.problems.extend(problems.into_iter().map(|e| format!("GNOME_VPN_PROFILES: {e}")));
                    Vec::new()
                }
            },
            _ => Vec::new(),
        };
        for profile in profiles.iter().filter(|pr| pr.upstream == wisp_upstream) {
            p.problems.push(format!(
                "GNOME_VPN_PROFILES: profile {:?} uses GNOME_WISP_UPSTREAM ({wisp_upstream}); each VPN location needs \
                 its own HolyWisp instance whose egress goes through the tunnel",
                profile.id
            ));
        }
        let filter_lists = match &filter_lists_file {
            Some(path) if !p.failed("GNOME_FILTER_LISTS_FILE") => match crate::filters::registry::load(path) {
                Ok(lists) => lists,
                Err(problems) => {
                    p.problems.extend(problems.into_iter().map(|e| format!("GNOME_FILTER_LISTS_FILE: {e}")));
                    Vec::new()
                }
            },
            _ => crate::filters::registry::builtin(),
        };
        if (1..4).contains(&filters_refresh_hours) || filters_refresh_hours > 168 {
            p.warnings.push(format!(
                "GNOME_FILTERS_REFRESH_HOURS={filters_refresh_hours} is outside 4-168; lists without '! Expires' are \
                 re-checked every {} hours",
                filters_refresh_hours.clamp(4, 168)
            ));
        }
        if admin_allow_remote && admin_token.is_none() && !p.failed("GNOME_ADMIN_TOKEN") {
            p.warnings
                .push("GNOME_ADMIN_ALLOW_REMOTE=true has no effect without GNOME_ADMIN_TOKEN (loopback only)".into());
        }
        let engines = Engines {
            default: engine_default,
            scramjet: enabled_engines.contains(&EngineId::Scramjet),
            ultraviolet: enabled_engines.contains(&EngineId::Ultraviolet),
        };
        if !enabled_engines.contains(&engine_default) {
            p.problems.push(format!("GNOME_ENGINE_DEFAULT={} is not listed in GNOME_ENGINES", engine_default.as_str()));
        }
        if argon2_memory_kib < 8192 {
            p.warnings.push(format!(
                "GNOME_ARGON2_MEMORY_KIB={argon2_memory_kib} is below 8192; password hashes are weaker than \
                 recommended (OWASP baseline: 19456)"
            ));
        }
        if static_reload {
            p.warnings.push(
                "GNOME_STATIC_RELOAD=true re-indexes GNOME_STATIC_DIR while serving (development only: it costs a \
                 file check per request and a full re-scan after each rebuild)"
                    .into(),
            );
        }
        if allow_custom_wisp {
            p.warnings.push(
                "GNOME_ALLOW_CUSTOM_WISP=true: users may route the proxy through Wisp servers of their own, which \
                 bypass this server's gateway, its access rules, the VPN profiles and part of the leak protection \
                 (the engine-host and bare-mux worker policies allow any ws:/wss: host)"
                    .into(),
            );
        }
        if rate_limit_scale == 0.0 {
            p.warnings.push("GNOME_RATE_LIMIT_SCALE=0 disables all rate limiting".into());
        }
        if trusted_proxies.is_empty() {
            p.warnings.push(
                "GNOME_TRUSTED_PROXIES is empty: X-Forwarded-* headers are ignored (fine without a reverse proxy)"
                    .into(),
            );
        }
        for spec in VARS {
            if let (Some(module), Some(_)) = (spec.inactive, p.user_value(spec.name)) {
                p.warnings
                    .push(format!("{} is set but has no effect: this build does not include {module}", spec.name));
            }
        }

        if !p.problems.is_empty() {
            return Err(ConfigError { problems: p.problems });
        }

        let settings = VARS
            .iter()
            .map(|spec| {
                let (value, provenance) = match p.raw.get(spec.name) {
                    Some((v, prov)) => (v.trim().to_string(), *prov),
                    None => (spec.default.to_string(), Provenance::Default),
                };
                let value = if spec.secret && !value.is_empty() { "<redacted>".to_string() } else { value };
                Setting { name: spec.name, value, provenance, inactive: spec.inactive }
            })
            .collect();

        Ok(Config {
            bind,
            admin_bind,
            admin_token,
            admin_allow_remote,
            data_dir,
            static_dir,
            static_reload,
            public_origins,
            proxy_origin,
            proxy_bind,
            proxy,
            proxy_csp,
            wisp_ticket_ttl_s,
            allow_custom_wisp,
            trusted_proxies,
            access_mode,
            access_code,
            accounts,
            registration,
            secret_key,
            cookie_secure,
            wisp_upstream,
            vpn_profiles,
            profiles,
            source_url,
            engines,
            catalog_refresh_hours,
            catalog_sources,
            filters_refresh_hours,
            filter_lists_file,
            filter_lists,
            thumb_proxy,
            thumb_cache_mb,
            max_ws_per_ip,
            max_ws_per_session,
            rate_limit_scale,
            argon2_memory_kib,
            workers,
            db_readers,
            log,
            log_format,
            log_ips,
            csp,
            hsts,
            config_file: file.map(|f| f.path),
            warnings: p.warnings,
            settings,
        })
    }

    /// Path of the SQLite database.
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("gnome.db")
    }

    /// Path of the generated secret key file (used when `GNOME_SECRET_KEY` is unset).
    pub fn secret_key_path(&self) -> PathBuf {
        self.data_dir.join("secret.key")
    }

    /// Whether `/api/auth/register` accepts new accounts.
    pub fn registration_open(&self) -> bool {
        self.accounts && self.registration == Registration::Open
    }
}

struct Parser {
    raw: BTreeMap<&'static str, (String, Provenance)>,
    problems: Vec<String>,
    warnings: Vec<String>,
}

impl Parser {
    /// The user-supplied value, if any (empty counts as unset unless the variable gives empty a meaning).
    fn user_value(&self, name: &'static str) -> Option<String> {
        let spec = spec(name);
        let (v, _) = self.raw.get(name)?;
        if v.trim().is_empty() && !spec.empty_allowed { None } else { Some(v.clone()) }
    }

    fn failed(&self, name: &str) -> bool {
        self.problems.iter().any(|p| p.starts_with(name))
    }

    fn report(&mut self, name: &'static str, value: &str, err: &str) {
        if spec(name).secret {
            self.problems.push(format!("{name}: {err}"));
        } else {
            self.problems.push(format!("{name}={value:?}: {err}"));
        }
    }

    /// Parse a setting that always has a value (user value, else the built-in default).
    fn parse<T>(&mut self, name: &'static str, f: impl Fn(&str) -> Result<T, String>) -> T {
        if let Some(v) = self.user_value(name) {
            match f(&v) {
                Ok(t) => return t,
                Err(e) => self.report(name, &v, &e),
            }
        }
        let default = spec(name).default;
        f(default).unwrap_or_else(|e| panic!("built-in default for {name} ({default:?}) is invalid: {e}"))
    }

    /// Parse an optional setting (no built-in default).
    fn parse_opt<T>(&mut self, name: &'static str, f: impl Fn(&str) -> Result<T, String>) -> Option<T> {
        let v = self.user_value(name)?;
        match f(&v) {
            Ok(t) => Some(t),
            Err(e) => {
                self.report(name, &v, &e);
                None
            }
        }
    }
}

fn toml_scalar(value: &toml::Value) -> Result<String, String> {
    match value {
        toml::Value::String(s) => Ok(s.clone()),
        toml::Value::Integer(i) => Ok(i.to_string()),
        toml::Value::Float(f) => Ok(f.to_string()),
        toml::Value::Boolean(b) => Ok(b.to_string()),
        toml::Value::Array(items) => {
            let parts: Result<Vec<String>, String> = items
                .iter()
                .map(|item| match item {
                    toml::Value::Array(_) | toml::Value::Table(_) => Err("nested arrays/tables are not allowed".into()),
                    other => toml_scalar(other),
                })
                .collect();
            Ok(parts?.join(","))
        }
        toml::Value::Datetime(_) => Err("datetimes are not supported here".into()),
        toml::Value::Table(_) => Err("tables are not supported; use flat keys".into()),
    }
}

pub(crate) fn parse_bool(v: &str) -> Result<bool, String> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err("expected a boolean (true/false)".into()),
    }
}

fn parse_socket_addr(v: &str) -> Result<SocketAddr, String> {
    v.trim().parse::<SocketAddr>().map_err(|_| "expected IP:port, e.g. 0.0.0.0:8080 or [::]:8080".into())
}

fn parse_path(v: &str) -> Result<PathBuf, String> {
    let v = v.trim();
    if v.is_empty() {
        return Err("must not be empty".into());
    }
    Ok(PathBuf::from(v))
}

fn parse_u32_in(v: &str, min: u32, max: u32) -> Result<u32, String> {
    let n: u32 = v.trim().parse().map_err(|_| format!("expected an integer between {min} and {max}"))?;
    if n < min || n > max {
        return Err(format!("must be between {min} and {max}"));
    }
    Ok(n)
}

fn parse_scale(v: &str) -> Result<f64, String> {
    let f: f64 = v.trim().parse().map_err(|_| "expected a number, e.g. 1.0".to_string())?;
    if !f.is_finite() || !(0.0..=1000.0).contains(&f) {
        return Err("must be between 0 and 1000".into());
    }
    Ok(f)
}

fn split_list(v: &str) -> impl Iterator<Item = &str> {
    v.split(',').map(str::trim).filter(|s| !s.is_empty())
}

fn parse_origins(v: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for item in split_list(v) {
        let origin = normalize_origin(item.trim_end_matches('/')).ok_or_else(|| {
            format!("{item:?} is not an origin (expected scheme://host[:port], e.g. https://gnome.example.com)")
        })?;
        if !out.contains(&origin) {
            out.push(origin);
        }
    }
    Ok(out)
}

fn parse_cidrs(v: &str) -> Result<Vec<IpNet>, String> {
    split_list(v)
        .map(|item| {
            item.parse::<IpNet>()
                .or_else(|_| item.parse::<std::net::IpAddr>().map(IpNet::from))
                .map(|n| n.trunc())
                .map_err(|_| format!("{item:?} is not an IP address or CIDR (e.g. 10.0.0.0/8)"))
        })
        .collect()
}

fn parse_single_origin(v: &str) -> Result<String, String> {
    let v = v.trim();
    normalize_origin(v.trim_end_matches('/')).ok_or_else(|| {
        format!("{v:?} is not an origin (expected scheme://host[:port] without a path, e.g. https://p.example.com)")
    })
}

/// `GNOME_PROXY_CSP`: one policy (no `,`), printable ASCII, every directive name well-formed, no `frame-ancestors`
/// (the server sets it from the app origins) and no `report-uri`/`report-to` (GNOME's policies never report: a report
/// carries URLs of the user's browsing to a server, ENGINE-PROTOCOL §6.16). Returned normalized: `a x; b y`.
fn parse_proxy_csp(v: &str) -> Result<String, String> {
    let v = v.trim();
    if v.len() > 4096 {
        return Err("must be at most 4096 characters".into());
    }
    if !v.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        return Err("must be printable ASCII (no control characters or line breaks)".into());
    }
    if v.contains(',') {
        return Err("must be a single policy: separate directives with ';', not ','".into());
    }
    let mut directives = Vec::new();
    for directive in v.split(';').map(str::trim).filter(|d| !d.is_empty()) {
        let name = directive.split_ascii_whitespace().next().unwrap_or("");
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(format!("{directive:?} does not start with a directive name"));
        }
        if name.eq_ignore_ascii_case("frame-ancestors") {
            return Err("must not contain frame-ancestors: the server sets it to the app origin(s)".into());
        }
        if name.eq_ignore_ascii_case("report-uri") || name.eq_ignore_ascii_case("report-to") {
            return Err(format!(
                "must not contain {name}: violation reports would carry the users' browsing to a server (GNOME counts \
                 violations in the engine host instead)"
            ));
        }
        directives.push(directive.split_ascii_whitespace().collect::<Vec<_>>().join(" "));
    }
    if directives.is_empty() {
        return Err("contains no directives".into());
    }
    Ok(directives.join("; "))
}

fn parse_http_url(v: &str) -> Result<String, String> {
    let v = v.trim();
    if crate::api::validate::is_http_url(v) { Ok(v.to_string()) } else { Err("expected an http(s):// URL".into()) }
}

fn parse_engines(v: &str) -> Result<Vec<EngineId>, String> {
    let engines: Vec<EngineId> = split_list(v).map(EngineId::parse).collect::<Result<_, _>>()?;
    if engines.is_empty() {
        return Err("at least one engine must be enabled".into());
    }
    Ok(engines)
}

fn parse_ident_list(v: &str) -> Result<Vec<String>, String> {
    split_list(v)
        .map(|s| {
            let ok = s.len() <= 64
                && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
            if ok { Ok(s.to_string()) } else { Err(format!("{s:?} is not a valid source id ([a-z0-9_-])")) }
        })
        .collect()
}

fn parse_log_filter(v: &str) -> Result<String, String> {
    let v = v.trim();
    tracing_subscriber::EnvFilter::try_new(v).map_err(|e| format!("invalid tracing filter: {e}"))?;
    Ok(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|k| map.get(k).cloned(), None)
    }

    #[test]
    fn defaults_are_valid() {
        let c = load(&[]).expect("defaults parse");
        assert_eq!(c.bind, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.admin_bind, Some("127.0.0.1:9091".parse().unwrap()));
        assert_eq!(c.access_mode, AccessMode::Open);
        assert_eq!(c.trusted_proxies.len(), 2);
        assert_eq!(c.db_readers, 4);
        assert_eq!(c.argon2_memory_kib, 19456);
        assert!(c.engines.scramjet && c.engines.ultraviolet);
        assert_eq!(c.engines.default, EngineId::Scramjet);
        // Decisions 2026-11-11 (one-hour tickets) and 2026-11-10 (GamePix feed + curated OSS games).
        assert_eq!(c.wisp_ticket_ttl_s, 3600);
        assert_eq!(c.catalog_sources, ["gamepix", "oss"]);
        assert_eq!(c.settings.len(), VARS.len());
        // Decision 2026-11-11: custom Wisp servers need the operator's opt-in; the dev re-index is off too.
        assert!(!c.allow_custom_wisp && !c.static_reload && c.proxy_csp.is_none());
    }

    #[test]
    fn proxy_csp_is_one_policy_that_can_only_restrict() {
        assert_eq!(
            parse_proxy_csp("  script-src   'self' 'wasm-unsafe-eval' ;; img-src 'self'; ").unwrap(),
            "script-src 'self' 'wasm-unsafe-eval'; img-src 'self'"
        );
        for (bad, why) in [
            ("frame-ancestors 'self'", "frame-ancestors"),
            ("img-src 'self'; Frame-Ancestors *", "frame-ancestors"),
            ("img-src 'self'; report-uri https://collector.example/csp", "report-uri"),
            ("report-to gnome; img-src 'self'", "report-to"),
            ("img-src 'self', script-src 'none'", "single policy"),
            ("img-src 'self'\nscript-src 'none'", "printable ASCII"),
            ("'self' img-src", "directive name"),
            (" ; ;", "no directives"),
        ] {
            let err = parse_proxy_csp(bad).unwrap_err();
            assert!(err.contains(why), "{bad:?}: {err}");
        }
        assert!(parse_proxy_csp(&format!("img-src {}", "a".repeat(4096))).is_err());
        let err = load(&[("GNOME_PROXY_CSP", "report-uri /x")]).unwrap_err().to_string();
        assert!(err.contains("GNOME_PROXY_CSP") && err.contains("report-uri"), "{err}");
    }

    #[test]
    fn env_overrides_file() {
        let file = ConfigFile::parse(
            Path::new("gnome.toml"),
            "bind = \"127.0.0.1:20001\"\nlog_ips = true\npublic_origins = [\"https://A.example.com/\", \"http://b.example:80\"]\n",
        )
        .unwrap();
        let c =
            Config::from_lookup(|k| (k == "GNOME_BIND").then(|| "127.0.0.1:20002".to_string()), Some(file)).unwrap();
        assert_eq!(c.bind.port(), 20002);
        assert!(c.log_ips);
        assert_eq!(c.public_origins, vec!["https://a.example.com", "http://b.example"]);
        let bind = c.settings.iter().find(|s| s.name == "GNOME_BIND").unwrap();
        assert_eq!(bind.provenance, Provenance::Env);
        let ips = c.settings.iter().find(|s| s.name == "GNOME_LOG_IPS").unwrap();
        assert_eq!(ips.provenance, Provenance::File);
    }

    #[test]
    fn unknown_file_keys_are_rejected() {
        let file = ConfigFile::parse(Path::new("g.toml"), "bnid = \"x\"").unwrap();
        let err = Config::from_lookup(|_| None, Some(file)).unwrap_err();
        assert!(err.problems[0].contains("unknown key"), "{err}");
    }

    #[test]
    fn all_problems_are_reported_together() {
        let err = load(&[("GNOME_BIND", "nope"), ("GNOME_DB_READERS", "0"), ("GNOME_CSP", "maybe")]).unwrap_err();
        assert_eq!(err.problems.len(), 3, "{err}");
    }

    #[test]
    fn code_mode_requires_code() {
        let err = load(&[("GNOME_ACCESS_MODE", "code")]).unwrap_err();
        assert!(err.to_string().contains("requires GNOME_ACCESS_CODE"));
        let short = load(&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "letmein")]).unwrap();
        assert!(short.warnings.iter().any(|w| w.contains("shorter than 8")), "{:?}", short.warnings);
        assert!(!short.warnings.iter().any(|w| w.contains("letmein")), "the code itself is never printed");
        let long = load(&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "mushroom-forest-42")]).unwrap();
        assert!(long.warnings.is_empty(), "{:?}", long.warnings);
    }

    #[test]
    fn remote_admin_requires_opt_in_and_token() {
        let err = load(&[("GNOME_ADMIN_BIND", "0.0.0.0:9091")]).unwrap_err();
        assert!(err.to_string().contains("not a loopback"));
        let err = load(&[("GNOME_ADMIN_BIND", "0.0.0.0:9091"), ("GNOME_ADMIN_ALLOW_REMOTE", "true")]).unwrap_err();
        assert!(err.to_string().contains("not a loopback"));
        let ok = load(&[
            ("GNOME_ADMIN_BIND", "0.0.0.0:9091"),
            ("GNOME_ADMIN_ALLOW_REMOTE", "true"),
            ("GNOME_ADMIN_TOKEN", "0123456789abcdef0123"),
        ]);
        assert!(ok.is_ok());
        let disabled = load(&[("GNOME_ADMIN_BIND", "")]).unwrap();
        assert_eq!(disabled.admin_bind, None);
    }

    #[test]
    fn secrets_are_redacted_everywhere() {
        let c = load(&[("GNOME_ADMIN_TOKEN", "super-secret-admin-token"), ("GNOME_ACCESS_CODE", "tiny-code")]).unwrap();
        let dbg = format!("{c:?}");
        assert!(!dbg.contains("super-secret-admin-token") && !dbg.contains("tiny-code"));
        let s = c.settings.iter().find(|s| s.name == "GNOME_ADMIN_TOKEN").unwrap();
        assert_eq!(s.value, "<redacted>");
        let err = load(&[("GNOME_ADMIN_TOKEN", "short-secret")]).unwrap_err();
        assert!(!err.to_string().contains("short-secret"));
    }

    #[test]
    fn empty_values_mean_default() {
        let c = load(&[("GNOME_BIND", ""), ("GNOME_TRUSTED_PROXIES", "")]).unwrap();
        assert_eq!(c.bind.port(), 8080);
        assert!(c.trusted_proxies.is_empty());
    }

    #[test]
    fn settings_of_missing_modules_are_flagged() {
        let quiet = load(&[]).unwrap();
        assert!(!quiet.warnings.iter().any(|w| w.contains("no effect")), "{:?}", quiet.warnings);
        let c = load(&[
            ("GNOME_CATALOG_REFRESH_HOURS", "12"),
            ("GNOME_THUMB_PROXY", "false"),
            ("GNOME_WISP_UPSTREAM", "127.0.0.1:6002"),
            ("GNOME_FILTERS_REFRESH_HOURS", "12"),
        ])
        .unwrap();
        let flagged: Vec<_> = c.warnings.iter().filter(|w| w.contains("has no effect")).collect();
        assert_eq!(flagged.len(), 2, "{:?}", c.warnings);
        assert!(flagged[0].starts_with("GNOME_CATALOG_REFRESH_HOURS") && flagged[0].contains(GAME_CATALOG));
        let s = c.settings.iter().find(|s| s.name == "GNOME_CATALOG_REFRESH_HOURS").unwrap();
        assert_eq!((s.value.as_str(), s.inactive), ("12", Some(GAME_CATALOG)));
        // Settings of modules this build includes (the Wisp gateway, filter lists) are active.
        for name in [
            "GNOME_BIND",
            "GNOME_WISP_UPSTREAM",
            "GNOME_MAX_WS_PER_IP",
            "GNOME_VPN_PROFILES",
            "GNOME_FILTERS_REFRESH_HOURS",
            "GNOME_FILTER_LISTS_FILE",
        ] {
            assert!(c.settings.iter().find(|s| s.name == name).unwrap().inactive.is_none(), "{name}");
        }
        // Still validated.
        assert!(load(&[("GNOME_THUMB_CACHE_MB", "-1")]).is_err());
    }

    #[test]
    fn filter_lists_file_is_validated() {
        let c = load(&[]).unwrap();
        assert_eq!(c.filter_lists, crate::filters::registry::builtin());
        let err = load(&[("GNOME_FILTER_LISTS_FILE", "/nonexistent/gnome-lists.toml")]).unwrap_err();
        assert!(err.problems[0].starts_with("GNOME_FILTER_LISTS_FILE: cannot read"), "{err}");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lists.toml");
        std::fs::write(&path, "[[list]]\nid = \"plowe-0\"\ndisabled = true\n").unwrap();
        let c = load(&[("GNOME_FILTER_LISTS_FILE", path.to_str().unwrap())]).unwrap();
        assert!(c.filter_lists.iter().all(|l| l.id != "plowe-0"));
        assert_eq!(c.filter_lists.len(), crate::filters::registry::builtin().len() - 1);
        std::fs::write(&path, "[[list]]\nid = \"easylist\"\nurl = \"http://easylist.to/easylist.txt\"\n").unwrap();
        let err = load(&[("GNOME_FILTER_LISTS_FILE", path.to_str().unwrap())]).unwrap_err();
        assert!(err.to_string().contains("must be an https URL"), "{err}");
        let c = load(&[("GNOME_FILTERS_REFRESH_HOURS", "2")]).unwrap();
        assert!(c.warnings.iter().any(|w| w.contains("outside 4-168")), "{:?}", c.warnings);
    }

    #[test]
    fn engine_default_must_be_enabled() {
        assert!(load(&[("GNOME_ENGINES", "ultraviolet")]).is_err());
        let c = load(&[("GNOME_ENGINES", "ultraviolet"), ("GNOME_ENGINE_DEFAULT", "ultraviolet")]).unwrap();
        assert!(!c.engines.scramjet && c.engines.ultraviolet);
    }

    #[test]
    fn list_parsers() {
        let c = load(&[("GNOME_TRUSTED_PROXIES", "10.0.0.0/8, 192.168.1.7 ,fd00::/8")]).unwrap();
        assert_eq!(c.trusted_proxies.len(), 3);
        assert!(load(&[("GNOME_PUBLIC_ORIGINS", "https://x.example/path")]).is_err());
        assert!(load(&[("GNOME_WISP_UPSTREAM", "holywisp:6001")]).is_ok());
        assert!(load(&[("GNOME_WISP_UPSTREAM", "holywisp")]).is_err());
        assert!(load(&[("GNOME_SOURCE_URL", "ftp://x")]).is_err());
        assert!(load(&[("GNOME_LOG", "info,gnome_server=debug")]).is_ok());
    }
}
