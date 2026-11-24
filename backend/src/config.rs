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

/// Built-in default of `GNOME_SOURCE_URL`: release builds set `GNOME_DEFAULT_SOURCE_URL` at compile time to the
/// release's source archives (WAVE-D D27); local builds leave it empty.
pub const DEFAULT_SOURCE_URL: &str = match option_env!("GNOME_DEFAULT_SOURCE_URL") {
    Some(url) => url,
    None => "",
};

/// The secrets that may also come from a file (`<NAME>_FILE`, WAVE-D D23).
pub const SECRET_FILES: [(&str, &str); 3] = [
    ("GNOME_SECRET_KEY", "GNOME_SECRET_KEY_FILE"),
    ("GNOME_ADMIN_TOKEN", "GNOME_ADMIN_TOKEN_FILE"),
    ("GNOME_ACCESS_CODE", "GNOME_ACCESS_CODE_FILE"),
];

/// Largest secret file read (`_FILE` variables).
pub const SECRET_FILE_MAX: u64 = 64 * 1024;

/// Every setting the server understands, in documentation order.
pub const VARS: &[VarSpec] = &[
    var("GNOME_BIND", "0.0.0.0:8080", "public listener address"),
    var_empty_ok("GNOME_ADMIN_BIND", "127.0.0.1:9091", "admin listener address; empty disables it"),
    secret("GNOME_ADMIN_TOKEN", "bearer token required by the admin listener (>= 16 chars)"),
    var("GNOME_ADMIN_TOKEN_FILE", "", "file holding GNOME_ADMIN_TOKEN (absolute path; e.g. a systemd credential)"),
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
    var("GNOME_ACCESS_CODE_FILE", "", "file holding GNOME_ACCESS_CODE (absolute path)"),
    var("GNOME_ACCOUNTS", "true", "enable user accounts and sync (/api/auth/*, /api/sync/*)"),
    var("GNOME_REGISTRATION", "open", "self-service registration: open | closed"),
    secret("GNOME_SECRET_KEY", "base64 key (>= 32 bytes); generated into $GNOME_DATA_DIR/secret.key when unset"),
    var("GNOME_SECRET_KEY_FILE", "", "file holding GNOME_SECRET_KEY's base64 text (absolute path)"),
    var(
        "GNOME_COOKIE_SECURE",
        "auto",
        "Secure cookie attribute (and __Host- names): auto (HTTPS, or a plain-HTTP loopback app origin) | true | false",
    ),
    var("GNOME_WISP_UPSTREAM", "127.0.0.1:6001", "primary HolyWisp address (internal host:port)"),
    var("GNOME_VPN_PROFILES", "", "path to the VPN gateway profiles TOML (egress HolyWisp instances)"),
    var_empty_ok(
        "GNOME_VPN_CHECK_URL",
        "",
        "exit check service for VPN locations (HTTPS JSON with ip, country, city); empty = no exit checks",
    ),
    var_empty_ok(
        "GNOME_VPN_CHECK_URL_V6",
        "",
        "the same check service under an IPv6-only name; empty = IPv6 not checked",
    ),
    var(
        "GNOME_VPN_CHECK_INTERVAL_MIN",
        "15",
        "minutes between server-side exit checks of each location; 0 = on request only",
    ),
    var(
        "GNOME_VPN_EGRESS_SHARED_OK",
        "false",
        "true = your VPN egress's terms allow every person who can use this instance (silences the terms warning)",
    ),
    var(
        "GNOME_SOURCE_URL",
        DEFAULT_SOURCE_URL,
        "link to the corresponding source code (AGPL-3.0 section 13), shown in About",
    ),
    var("GNOME_ENGINES", "scramjet,ultraviolet", "enabled proxy engines"),
    var("GNOME_ENGINE_DEFAULT", "scramjet", "default proxy engine (must be enabled)"),
    var("GNOME_CATALOG_REFRESH_HOURS", "24", "hours between game catalog imports of each source; 0 = only on request"),
    var(
        "GNOME_CATALOG_SOURCES",
        "gamepix,oss",
        "game catalog sources: gamepix, gamedistribution, playgama, gamemonetize, famobi, itchio, js13k, oss; none = no catalog",
    ),
    var("GNOME_GAMEPIX_SID", "1", "GamePix publisher SID (1 = the public default SID)"),
    var("GNOME_GD_PUBLISHER_ID", "", "GameDistribution publisher ID (required to enable gamedistribution)"),
    var("GNOME_PLAYGAMA_CLID", "", "Playgama partner CLID (required to enable playgama)"),
    var(
        "GNOME_GAMEMONETIZE_ENABLED",
        "false",
        "enable gamemonetize (after adding this site in the GameMonetize dashboard)",
    ),
    var("GNOME_FAMOBI_AFFILIATE_ID", "", "Famobi affiliate ID (required to enable famobi)"),
    var("GNOME_ITCHIO_FEEDS", "games/free/platform-web", "itch.io browse paths, comma-separated (link-out records)"),
    var("GNOME_ITCHIO_MAX_PAGES", "3", "pages per itch.io feed (1-20)"),
    var("GNOME_JS13K_FIRST_YEAR", "2012", "first js13kGames year (link-out records)"),
    var("GNOME_OSS_MANIFEST", "", "open-source games manifest; empty = the manifest built into gnome-server"),
    var("GNOME_OSS_GAMES_DIR", "", "where open-source game builds live; empty = $GNOME_DATA_DIR/oss-games"),
    var("GNOME_OSS_REQUIRE_BUILDS", "true", "list only open-source games whose build exists"),
    var("GNOME_OSS_FETCH", "auto", "fetch missing open-source builds in the background: auto | manual"),
    var("GNOME_OSS_MAX_MB", "512", "disk cap for all open-source game builds together, in MiB (16-65536)"),
    var("GNOME_CATALOG_BLOCKLIST", "", "extra trademark/knock-off terms, comma-separated (!term removes a default)"),
    var("GNOME_CATALOG_BLOCKLIST_FILE", "", "file with one blocklist term per line (title:, start:, label: scopes)"),
    var(
        "GNOME_CATALOG_DEDUP_ORDER",
        "playgama,gamepix,gamedistribution,gamemonetize,famobi,oss,itchio,js13k",
        "preferred listing when one game is in several sources",
    ),
    var("GNOME_CATALOG_USER_AGENT", "", "User-Agent of catalog feed requests; empty = GNOME-catalog/<version>"),
    var("GNOME_GAMES_EMBED_HOSTS", "", "developer hosts approved for game embeds, comma-separated DNS names"),
    var("GNOME_ADS_TXT", "", "file served as /ads.txt on the app origin (lines from your game networks)"),
    var(
        "GNOME_FILTERS_REFRESH_HOURS",
        "24",
        "filter-list re-check interval for lists without '! Expires' (clamped 4-168 h); 0 = manual refresh only",
    ),
    var("GNOME_FILTER_LISTS_FILE", "", "TOML file that adds, overrides or disables filter lists"),
    var("GNOME_THUMB_PROXY", "true", "serve game thumbnails through /api/thumb/:id"),
    var("GNOME_THUMB_CACHE_MB", "256", "disk cap for the thumbnail cache in MiB; 0 = no disk cache"),
    var(
        "GNOME_MAX_CONNECTIONS",
        "4096",
        "connections on the public and proxy listeners together (16-1000000; lowered to (RLIMIT_NOFILE - 512) / 6)",
    ),
    var("GNOME_MAX_CONNS_PER_IP", "256", "connections per peer IP (IPv6: per /64) outside GNOME_TRUSTED_PROXIES"),
    var(
        "GNOME_MAX_INFLIGHT_PER_IP",
        "256",
        "concurrent requests per client (IPv6: per /64, 4x per /56, 16x per /48); beyond: 503",
    ),
    var("GNOME_MAX_INFLIGHT_HEAD_MB", "64", "byte budget in MiB for request heads over 64 KiB (4-1024)"),
    var("GNOME_SYNC_QUOTA_MB", "64", "sync storage per account in MiB (1-4096)"),
    var("GNOME_SYNC_TOTAL_MB", "1024", "sync storage of all accounts together in MiB (16-1048576)"),
    var(
        "GNOME_COOKIE_HYGIENE",
        "app",
        "which foreign cookies the app removes in two-origin mode: app (below the registrable domain) | registrable",
    ),
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

/// `GNOME_COOKIE_HYGIENE` (`/api/config` `proxy.cookieHygiene`, WAVE-D D19 (3)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieHygiene {
    /// Remove foreign cookies host-only and at the domain levels below the registrable domain.
    App,
    /// Also at the registrable domain (the operator's opt-in).
    Registrable,
}

impl CookieHygiene {
    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "app" => Ok(Self::App),
            "registrable" => Ok(Self::Registrable),
            _ => Err("expected app or registrable".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Registrable => "registrable",
        }
    }
}

/// `GNOME_OSS_FETCH`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OssFetch {
    /// The `catalog.oss-fetch` job fetches missing or outdated builds of enabled manifest entries.
    Auto,
    /// Only `gnome-server catalog fetch-oss` and `POST /admin/catalog/oss-fetch` fetch.
    Manual,
}

impl OssFetch {
    fn parse(v: &str) -> Result<Self, String> {
        match v.trim().to_ascii_lowercase().as_str() {
            "auto" => Ok(Self::Auto),
            "manual" => Ok(Self::Manual),
            _ => Err("expected auto or manual".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
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
    /// The catalog crate's configuration, parsed by `gnome_catalog::CatalogConfig::from_env` over the same merged
    /// variables (environment over `GNOME_CONFIG` file), with `GNOME_DATA_DIR` passed through. Its `sources` are the
    /// usable ones: gated on operator IDs by the crate, then by the server: `oss` needs two origins (D5),
    /// `gamedistribution` a known app origin (its referrer URL, D2). Empty `sources` = no games module.
    pub catalog: gnome_catalog::CatalogConfig,
    pub catalog_refresh_hours: u32,
    pub filters_refresh_hours: u32,
    /// `GNOME_FILTER_LISTS_FILE` (path) and the effective filter-list registry (built-ins + overrides).
    pub filter_lists_file: Option<PathBuf>,
    pub filter_lists: Vec<crate::filters::registry::ListDef>,
    pub thumb_proxy: bool,
    pub thumb_cache_mb: u32,
    /// `GNOME_GAMES_EMBED_HOSTS`: lowercase DNS names (>= 2 labels, no IP, port or wildcard, <= 64 entries, never an
    /// app or proxy origin host).
    pub games_embed_hosts: Vec<String>,
    pub oss_fetch: OssFetch,
    /// `GNOME_OSS_MAX_MB` (16-65536).
    pub oss_max_mb: u32,
    /// `GNOME_ADS_TXT`: an absolute path (a missing file is a warning).
    pub ads_txt: Option<PathBuf>,
    /// `GNOME_VPN_CHECK_URL` (`None` when empty, the default): an absolute `https://` URL without credentials,
    /// <= 2048 bytes; a plain `http://` URL is accepted with a warning (the e2e fixture uses one through the test-only
    /// HolyWisp).
    pub vpn_check_url: Option<String>,
    /// `GNOME_VPN_CHECK_URL_V6` (`None` when empty): same rules; only together with `vpn_check_url`.
    pub vpn_check_url_v6: Option<String>,
    /// `GNOME_VPN_CHECK_INTERVAL_MIN` (0-1440; 0 = on request only).
    pub vpn_check_interval_min: u32,
    /// `GNOME_VPN_EGRESS_SHARED_OK` (D16).
    pub vpn_egress_shared_ok: bool,
    pub max_ws_per_ip: u32,
    pub max_ws_per_session: u32,
    /// `GNOME_MAX_CONNECTIONS` as configured (the effective cap may be lower, [`crate::limits`]).
    pub max_connections: u32,
    pub max_conns_per_ip: u32,
    pub max_inflight_per_ip: u32,
    pub max_inflight_head_mb: u32,
    pub sync_quota_mb: u32,
    pub sync_total_mb: u32,
    pub cookie_hygiene: CookieHygiene,
    /// Secrets read from `<NAME>_FILE` (variable name → path), for `config check`.
    pub secret_files: BTreeMap<&'static str, PathBuf>,
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
        let secret_files = p.resolve_secret_files();

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
        let source_url = p.parse_opt("GNOME_SOURCE_URL", parse_http_url).or_else(|| {
            (!DEFAULT_SOURCE_URL.is_empty()).then(|| {
                parse_http_url(DEFAULT_SOURCE_URL).unwrap_or_else(|e| {
                    panic!("built-in GNOME_DEFAULT_SOURCE_URL ({DEFAULT_SOURCE_URL:?}) is invalid: {e}")
                })
            })
        });
        let enabled_engines = p.parse("GNOME_ENGINES", parse_engines);
        let engine_default = p.parse("GNOME_ENGINE_DEFAULT", EngineId::parse);
        let catalog_refresh_hours = p.parse("GNOME_CATALOG_REFRESH_HOURS", |v| parse_u32_in(v, 0, 8760));
        let filters_refresh_hours = p.parse("GNOME_FILTERS_REFRESH_HOURS", |v| parse_u32_in(v, 0, 8760));
        let filter_lists_file = p.parse_opt("GNOME_FILTER_LISTS_FILE", parse_path);
        let thumb_proxy = p.parse("GNOME_THUMB_PROXY", parse_bool);
        let thumb_cache_mb = p.parse("GNOME_THUMB_CACHE_MB", |v| parse_u32_in(v, 0, 1_048_576));
        let games_embed_hosts = p.parse("GNOME_GAMES_EMBED_HOSTS", parse_embed_hosts);
        let oss_fetch = p.parse("GNOME_OSS_FETCH", OssFetch::parse);
        let oss_max_mb = p.parse("GNOME_OSS_MAX_MB", |v| parse_u32_in(v, 16, 65_536));
        let ads_txt = p.parse_opt("GNOME_ADS_TXT", parse_abs_path);
        let vpn_check_url = p.parse_opt("GNOME_VPN_CHECK_URL", parse_check_url).flatten();
        let vpn_check_url_v6 = p.parse_opt("GNOME_VPN_CHECK_URL_V6", parse_check_url).flatten();
        let vpn_check_interval_min = p.parse("GNOME_VPN_CHECK_INTERVAL_MIN", |v| parse_u32_in(v, 0, 1440));
        let vpn_egress_shared_ok = p.parse("GNOME_VPN_EGRESS_SHARED_OK", parse_bool);
        let max_ws_per_ip = p.parse("GNOME_MAX_WS_PER_IP", |v| parse_u32_in(v, 1, 100_000));
        let max_ws_per_session = p.parse("GNOME_MAX_WS_PER_SESSION", |v| parse_u32_in(v, 1, 100_000));
        let max_connections = p.parse("GNOME_MAX_CONNECTIONS", |v| parse_u32_in(v, 16, 1_000_000));
        let per_ip_set = p.user_value("GNOME_MAX_CONNS_PER_IP").is_some();
        let max_conns_per_ip = p.parse("GNOME_MAX_CONNS_PER_IP", |v| parse_u32_in(v, 1, 65_536));
        // The default follows a smaller GNOME_MAX_CONNECTIONS; an explicit larger value is a mistake.
        let max_conns_per_ip = if per_ip_set { max_conns_per_ip } else { max_conns_per_ip.min(max_connections) };
        let max_inflight_per_ip = p.parse("GNOME_MAX_INFLIGHT_PER_IP", |v| parse_u32_in(v, 1, 65_536));
        let max_inflight_head_mb = p.parse("GNOME_MAX_INFLIGHT_HEAD_MB", |v| parse_u32_in(v, 4, 1024));
        let sync_quota_mb = p.parse("GNOME_SYNC_QUOTA_MB", |v| parse_u32_in(v, 1, 4096));
        let sync_total_mb = p.parse("GNOME_SYNC_TOTAL_MB", |v| parse_u32_in(v, 16, 1_048_576));
        let cookie_hygiene = p.parse("GNOME_COOKIE_HYGIENE", CookieHygiene::parse);
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
        if max_conns_per_ip > max_connections && !p.failed("GNOME_MAX_CONNECTIONS") {
            p.problems.push(format!(
                "GNOME_MAX_CONNS_PER_IP={max_conns_per_ip} is larger than GNOME_MAX_CONNECTIONS={max_connections}"
            ));
        }
        if sync_total_mb < sync_quota_mb && !p.failed("GNOME_SYNC_QUOTA_MB") {
            p.problems.push(format!(
                "GNOME_SYNC_TOTAL_MB={sync_total_mb} is smaller than GNOME_SYNC_QUOTA_MB={sync_quota_mb}"
            ));
        }
        let public_bind = |a: &SocketAddr| !a.ip().is_loopback();
        if source_url.is_none() && (public_bind(&bind) || proxy_bind.as_ref().is_some_and(public_bind)) {
            p.warnings.push(
                "GNOME_SOURCE_URL is empty while a listener is not on loopback: AGPL-3.0 section 13 asks you to offer \
                 the corresponding source to every user of this server (set it to your source archive or repository)"
                    .into(),
            );
        }
        if accounts && registration == Registration::Open {
            p.warnings.push(
                "GNOME_REGISTRATION=open: anyone who reaches this server can create accounts and use sync storage \
                 (GNOME_SYNC_QUOTA_MB each, GNOME_SYNC_TOTAL_MB together); set GNOME_REGISTRATION=closed once your \
                 accounts exist"
                    .into(),
            );
        }
        let https_origin = public_origins.iter().chain(proxy_origin.iter()).any(|o| o.starts_with("https://"));
        if https_origin && !hsts {
            p.warnings.push(
                "https:// origins with GNOME_HSTS=false: browsers may still try plain HTTP first; set GNOME_HSTS=true \
                 once HTTPS works for every hostname"
                    .into(),
            );
        }
        if env("INVOCATION_ID").is_some_and(|v| !v.is_empty()) {
            for (name, file_var) in SECRET_FILES {
                if p.raw.get(name).is_some_and(|(_, prov)| *prov == Provenance::Env) && !secret_files.contains_key(name)
                {
                    p.warnings.push(format!(
                        "{name} is set as a plain variable under systemd: it shows in the unit's environment; use \
                         {file_var} with LoadCredential= instead"
                    ));
                }
            }
        }
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
        let catalog = parse_catalog(&mut p, &data_dir, &proxy, &public_origins);
        if !catalog.sources.is_empty() && !thumb_proxy {
            p.warnings.push(
                "GNOME_THUMB_PROXY=false: thumbnails load from the game networks' image servers in visitors' browsers, \
                 which then see their IP addresses"
                    .into(),
            );
        }
        for host in &games_embed_hosts {
            if own_hosts(&proxy, &public_origins).iter().any(|h| h == host) {
                p.problems.push(format!(
                    "GNOME_GAMES_EMBED_HOSTS: {host:?} is this server's own app or proxy host; games are never framed \
                     from it"
                ));
            }
        }
        if let Some(path) = &ads_txt
            && !path.is_file()
        {
            p.warnings
                .push(format!("GNOME_ADS_TXT={}: the file does not exist (yet); /ads.txt answers 404", path.display()));
        }
        if vpn_check_url_v6.is_some() && vpn_check_url.is_none() {
            p.problems.push("GNOME_VPN_CHECK_URL_V6 requires GNOME_VPN_CHECK_URL".into());
        }
        for (name, url) in [("GNOME_VPN_CHECK_URL", &vpn_check_url), ("GNOME_VPN_CHECK_URL_V6", &vpn_check_url_v6)] {
            if url.as_deref().is_some_and(|u| u[..5].eq_ignore_ascii_case("http:")) {
                p.warnings.push(format!("{name}: the VPN exit check is sent unencrypted (http:)"));
            }
        }
        if !profiles.is_empty() {
            if !vpn_egress_shared_ok {
                let public = access_mode == AccessMode::Open
                    || (access_mode == AccessMode::Accounts && registration == Registration::Open);
                if public {
                    p.warnings.push(VPN_TERMS_WARNING.into());
                } else if access_mode == AccessMode::Code {
                    p.warnings.push(VPN_CODE_WARNING.into());
                }
            }
            if vpn_check_url.is_none() {
                p.warnings.push(
                    "no exit checks: set GNOME_VPN_CHECK_URL to a check service you run or are allowed to use \
                     (services/vpn/README.md \"Verify\")"
                        .into(),
                );
            }
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
                let value = match secret_files.get(spec.name) {
                    Some(path) => format!("<redacted> (from file {})", path.display()),
                    None if spec.secret && !value.is_empty() => "<redacted>".to_string(),
                    None => value,
                };
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
            catalog,
            catalog_refresh_hours,
            filters_refresh_hours,
            filter_lists_file,
            filter_lists,
            thumb_proxy,
            thumb_cache_mb,
            games_embed_hosts,
            oss_fetch,
            oss_max_mb,
            ads_txt,
            vpn_check_url,
            vpn_check_url_v6,
            vpn_check_interval_min,
            vpn_egress_shared_ok,
            max_ws_per_ip,
            max_ws_per_session,
            max_connections,
            max_conns_per_ip,
            max_inflight_per_ip,
            max_inflight_head_mb,
            sync_quota_mb,
            sync_total_mb,
            cookie_hygiene,
            secret_files,
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

    /// `GNOME_PUBLIC_ORIGINS` is set and every configured origin (with `GNOME_PROXY_ORIGIN`) is `https://`.
    pub fn all_origins_https(&self) -> bool {
        !self.public_origins.is_empty()
            && self.public_origins.iter().chain(self.proxy_origin.iter()).all(|o| o.starts_with("https://"))
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
    /// Read every `<NAME>_FILE` secret into `raw` as `<NAME>`'s value (WAVE-D D23). Returns name → path.
    fn resolve_secret_files(&mut self) -> BTreeMap<&'static str, PathBuf> {
        let mut out = BTreeMap::new();
        for (name, file_var) in SECRET_FILES {
            let Some(path) = self.user_value(file_var) else { continue };
            let path = path.trim().to_string();
            if self.user_value(name).is_some() {
                self.problems.push(format!("{name} and {file_var} are both set; set only one of them"));
                continue;
            }
            match read_secret_file(Path::new(&path)) {
                Ok((value, others_can_read)) => {
                    if others_can_read {
                        self.warnings.push(format!(
                            "{file_var}={path}: other users can read this file; make it readable by the owner (and \
                             group) only, e.g. chmod 0640"
                        ));
                    }
                    let prov = self.raw.get(file_var).map_or(Provenance::Env, |(_, prov)| *prov);
                    self.raw.insert(name, (value, prov));
                    out.insert(name, PathBuf::from(path));
                }
                Err(e) => self.problems.push(format!("{file_var}={path:?}: {e}")),
            }
        }
        out
    }

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

/// Read a `_FILE` secret: an absolute path to a regular file of at most [`SECRET_FILE_MAX`] bytes of UTF-8, with
/// exactly one trailing `\n` or `\r\n` removed. Returns the value and whether others (mode bit `0o004`) may read it.
pub fn read_secret_file(path: &Path) -> Result<(String, bool), String> {
    use std::io::Read as _;
    if !path.is_absolute() {
        return Err("must be an absolute path".into());
    }
    let file = std::fs::File::open(path).map_err(|e| {
        let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
            " (the server's user or group must be able to read it; deployment/init-secrets.sh sets this up)"
        } else {
            ""
        };
        format!("cannot open: {e}{hint}")
    })?;
    let meta = file.metadata().map_err(|e| format!("cannot stat: {e}"))?;
    if !meta.is_file() {
        return Err("is not a regular file".into());
    }
    if meta.len() > SECRET_FILE_MAX {
        return Err(format!("is larger than {} KiB", SECRET_FILE_MAX / 1024));
    }
    let mut bytes = Vec::new();
    file.take(SECRET_FILE_MAX + 1).read_to_end(&mut bytes).map_err(|e| format!("cannot read: {e}"))?;
    if bytes.len() as u64 > SECRET_FILE_MAX {
        return Err(format!("is larger than {} KiB", SECRET_FILE_MAX / 1024));
    }
    let mut text = String::from_utf8(bytes).map_err(|_| "is not UTF-8 text".to_string())?;
    if text.ends_with("\r\n") {
        text.truncate(text.len() - 2);
    } else if text.ends_with('\n') {
        text.truncate(text.len() - 1);
    }
    if text.trim().is_empty() {
        return Err("is empty".into());
    }
    #[cfg(unix)]
    let others = {
        use std::os::unix::fs::PermissionsExt as _;
        meta.permissions().mode() & 0o004 != 0
    };
    #[cfg(not(unix))]
    let others = false;
    Ok((text, others))
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

/// D16: VPN locations on a server everyone can use.
pub const VPN_TERMS_WARNING: &str = "VPN locations are usable by everyone who can open this server or register on it. \
    Use only VPN egress whose terms allow every person who can use this instance; consumer VPN subscriptions \
    (Mullvad's among them) do not allow offering the VPN to others. GNOME's access modes do not change what a \
    provider's terms allow. Set GNOME_VPN_EGRESS_SHARED_OK=true only if your egress's terms allow this use.";

/// D16: VPN locations in access-code mode.
pub const VPN_CODE_WARNING: &str = "VPN locations are usable by everyone who has the access code: keep the code within \
    the people your VPN egress's terms allow";

/// The catalog crate's configuration over the merged variables, then the server's own gates (§3.1 of WAVE-C).
fn parse_catalog(
    p: &mut Parser,
    data_dir: &Path,
    proxy: &ProxySetup,
    public_origins: &[String],
) -> gnome_catalog::CatalogConfig {
    let data = data_dir.display().to_string();
    let lookup =
        |k: &str| p.raw.get(k).map(|(v, _)| v.clone()).or_else(|| (k == "GNOME_DATA_DIR").then(|| data.clone()));
    let mut catalog = match gnome_catalog::CatalogConfig::from_env(lookup) {
        Ok((catalog, warnings)) => {
            p.warnings.extend(warnings);
            catalog
        }
        Err(gnome_catalog::CatalogError::Config(msg)) => {
            p.problems.push(msg);
            return gnome_catalog::CatalogConfig { sources: Vec::new(), ..Default::default() };
        }
        Err(e) => {
            p.problems.push(format!("game catalog: {e}"));
            return gnome_catalog::CatalogConfig { sources: Vec::new(), ..Default::default() };
        }
    };
    if !proxy.isolated() && catalog.sources.contains(&gnome_catalog::Source::Oss) {
        catalog.sources.retain(|s| *s != gnome_catalog::Source::Oss);
        p.warnings.push(
            "open-source games need a separate proxy origin (GNOME_PROXY_ORIGIN or GNOME_PROXY_BIND); they are never \
             served from the app origin"
                .into(),
        );
    }
    if !proxy.isolated()
        && public_origins.is_empty()
        && catalog.sources.contains(&gnome_catalog::Source::GameDistribution)
    {
        catalog.sources.retain(|s| *s != gnome_catalog::Source::GameDistribution);
        p.warnings
            .push("gamedistribution needs GNOME_PUBLIC_ORIGINS: its embeds must name the page that shows them".into());
    }
    catalog
}

/// Hosts (with `:port` when not the default) of the app and proxy origins this server knows.
fn own_hosts(proxy: &ProxySetup, public_origins: &[String]) -> Vec<String> {
    proxy
        .app_origins()
        .iter()
        .chain(public_origins)
        .map(String::as_str)
        .chain(proxy.origin())
        .filter_map(|o| o.split_once("://").map(|(_, h)| h.to_string()))
        .collect()
}

/// `GNOME_GAMES_EMBED_HOSTS`: exact DNS names.
fn parse_embed_hosts(v: &str) -> Result<Vec<String>, String> {
    let hosts: Vec<String> = split_list(v).map(str::to_ascii_lowercase).collect();
    if hosts.len() > 64 {
        return Err("at most 64 hosts".into());
    }
    for h in &hosts {
        let labels: Vec<&str> = h.split('.').collect();
        let label_ok = |l: &&str| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        let is_ip = h.parse::<std::net::IpAddr>().is_ok() || h.starts_with('[');
        let numeric_tld = labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()));
        if is_ip || numeric_tld || h.contains(':') {
            return Err(format!("{h:?}: an IP address or a port is not a host name"));
        }
        if h.contains('*') {
            return Err(format!("{h:?}: wildcards are not allowed (list each host)"));
        }
        if labels.len() < 2 || h.len() > 253 || !labels.iter().all(label_ok) {
            return Err(format!("{h:?} is not a DNS name like games.example.com"));
        }
    }
    Ok(hosts)
}

fn parse_abs_path(v: &str) -> Result<PathBuf, String> {
    let path = parse_path(v)?;
    if !path.is_absolute() {
        return Err("must be an absolute path".into());
    }
    Ok(path)
}

/// `GNOME_VPN_CHECK_URL(_V6)`: empty = off; else an absolute http(s) URL without credentials, <= 2048 bytes.
fn parse_check_url(v: &str) -> Result<Option<String>, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(None);
    }
    if v.len() > 2048 {
        return Err("at most 2048 bytes".into());
    }
    if v.contains('#') {
        return Err("must not contain a #fragment".into());
    }
    let uri: http::Uri = v.parse().map_err(|e| format!("not a URL: {e}"))?;
    let scheme_ok = uri.scheme_str().is_some_and(|s| s.eq_ignore_ascii_case("https") || s.eq_ignore_ascii_case("http"));
    let Some(authority) = uri.authority().filter(|_| scheme_ok) else {
        return Err("expected an https:// URL".into());
    };
    if authority.as_str().contains('@') {
        return Err("must not contain credentials".into());
    }
    if authority.host().is_empty() {
        return Err("expected an https:// URL with a host".into());
    }
    Ok(Some(v.to_string()))
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
        assert_eq!(c.catalog.sources[0], gnome_catalog::Source::GamePix);
        assert_eq!((c.oss_fetch, c.oss_max_mb, c.vpn_check_interval_min), (OssFetch::Auto, 512, 15));
        // D15: no exit-check service unless the operator names one.
        assert!(c.vpn_check_url.is_none() && c.vpn_check_url_v6.is_none() && !c.vpn_egress_shared_ok);
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
        let long = load(&[
            ("GNOME_ACCESS_MODE", "code"),
            ("GNOME_ACCESS_CODE", "mushroom-forest-42"),
            ("GNOME_CATALOG_SOURCES", "gamepix"),
            ("GNOME_SOURCE_URL", "https://example.com/gnome-src.tar.gz"),
            ("GNOME_REGISTRATION", "closed"),
        ])
        .unwrap();
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
    fn every_setting_is_active() {
        let c = load(&[("GNOME_CATALOG_REFRESH_HOURS", "12"), ("GNOME_THUMB_PROXY", "false")]).unwrap();
        assert!(!c.warnings.iter().any(|w| w.contains("has no effect")), "{:?}", c.warnings);
        assert!(c.settings.iter().all(|s| s.inactive.is_none()));
        assert_eq!(c.catalog_refresh_hours, 12);
        // Still validated.
        assert!(load(&[("GNOME_THUMB_CACHE_MB", "-1")]).is_err());
    }

    const TWO_ORIGINS: [(&str, &str); 2] =
        [("GNOME_PUBLIC_ORIGINS", "https://gnome.example.com"), ("GNOME_PROXY_ORIGIN", "https://p.gnome.example.com")];

    #[test]
    fn every_catalog_variable_is_a_server_setting() {
        let asked = std::sync::Mutex::new(Vec::<String>::new());
        let _ = gnome_catalog::CatalogConfig::from_env(|k| {
            asked.lock().unwrap().push(k.to_string());
            None
        });
        let asked = asked.into_inner().unwrap();
        assert!(asked.len() >= 15, "{asked:?}");
        for k in asked {
            assert!(VARS.iter().any(|v| v.name == k), "{k} is read by gnome-catalog but missing from VARS");
        }
        // And a config file accepts them.
        let f = ConfigFile::parse(Path::new("t.toml"), "gamepix_sid = \"abc\"\noss_fetch = \"manual\"\n").unwrap();
        let c = Config::from_lookup(|_| None, Some(f)).unwrap();
        assert_eq!(c.catalog.gamepix.sid, "abc");
        assert_eq!(c.oss_fetch, OssFetch::Manual);
    }

    #[test]
    fn catalog_sources_are_gated_by_the_origin_setup() {
        use gnome_catalog::Source;
        let single =
            load(&[("GNOME_CATALOG_SOURCES", "gamepix,oss,gamedistribution"), ("GNOME_GD_PUBLISHER_ID", "abc")])
                .unwrap();
        assert_eq!(single.catalog.sources, [Source::GamePix]);
        assert!(single.warnings.iter().any(|w| w.starts_with("open-source games need a separate proxy origin")));
        assert!(single.warnings.iter().any(|w| w.starts_with("gamedistribution needs GNOME_PUBLIC_ORIGINS")));
        let mut vars = TWO_ORIGINS.to_vec();
        vars.extend([("GNOME_CATALOG_SOURCES", "gamepix,oss,gamedistribution"), ("GNOME_GD_PUBLISHER_ID", "abc")]);
        let two = load(&vars).unwrap();
        assert_eq!(two.catalog.sources.len(), 3, "{:?}", two.warnings);
        assert!(load(&[("GNOME_CATALOG_SOURCES", "none")]).unwrap().catalog.sources.is_empty());
        assert!(load(&[("GNOME_CATALOG_SOURCES", "nope")]).is_err());
        let data = load(&[("GNOME_DATA_DIR", "/srv/gnome")]).unwrap();
        assert_eq!(data.catalog.oss.builds_dir, Path::new("/srv/gnome/oss-games"));
        let thumbs = load(&[("GNOME_THUMB_PROXY", "false")]).unwrap();
        assert!(thumbs.warnings.iter().any(|w| w.starts_with("GNOME_THUMB_PROXY=false")));
        let none = load(&[("GNOME_THUMB_PROXY", "false"), ("GNOME_CATALOG_SOURCES", "none")]).unwrap();
        assert!(!none.warnings.iter().any(|w| w.starts_with("GNOME_THUMB_PROXY=false")));
    }

    #[test]
    fn embed_hosts_are_exact_dns_names() {
        let c = load(&[("GNOME_GAMES_EMBED_HOSTS", "DeadlyDescent.net, games.example.org")]).unwrap();
        assert_eq!(c.games_embed_hosts, ["deadlydescent.net", "games.example.org"]);
        for bad in ["*.example.com", "1.2.3.4", "[::1]", "example.com:8443", "localhost", "a..b", "-a.com", "x.123"] {
            assert!(load(&[("GNOME_GAMES_EMBED_HOSTS", bad)]).is_err(), "{bad}");
        }
        let mut vars = TWO_ORIGINS.to_vec();
        vars.push(("GNOME_GAMES_EMBED_HOSTS", "p.gnome.example.com"));
        let err = load(&vars).unwrap_err();
        assert!(err.problems.iter().any(|p| p.contains("own app or proxy host")), "{err:?}");
        vars.pop();
        vars.push(("GNOME_GAMES_EMBED_HOSTS", "gnome.example.com"));
        assert!(load(&vars).is_err());
    }

    #[test]
    fn oss_and_ads_txt_settings() {
        assert!(load(&[("GNOME_OSS_FETCH", "sometimes")]).is_err());
        assert!(load(&[("GNOME_OSS_MAX_MB", "8")]).is_err());
        assert!(load(&[("GNOME_ADS_TXT", "relative/ads.txt")]).is_err());
        let c = load(&[("GNOME_ADS_TXT", "/nonexistent/ads.txt")]).unwrap();
        assert_eq!(c.ads_txt.as_deref(), Some(Path::new("/nonexistent/ads.txt")));
        assert!(c.warnings.iter().any(|w| w.starts_with("GNOME_ADS_TXT=")));
    }

    #[test]
    fn vpn_check_url_rules() {
        let c = load(&[("GNOME_VPN_CHECK_URL", "")]).unwrap();
        assert!(c.vpn_check_url.is_none());
        let c = load(&[("GNOME_VPN_CHECK_URL", "https://check.example.net/json")]).unwrap();
        assert_eq!(c.vpn_check_url.as_deref(), Some("https://check.example.net/json"));
        assert!(!c.warnings.iter().any(|w| w.contains("unencrypted")));
        let c = load(&[("GNOME_VPN_CHECK_URL", "http://127.0.0.1:21060/json")]).unwrap();
        assert!(c.warnings.iter().any(|w| w.contains("unencrypted")), "{:?}", c.warnings);
        for bad in ["ftp://x.example/", "https://u:p@x.example/", "https://x.example/#a", "not a url", "/json"] {
            assert!(load(&[("GNOME_VPN_CHECK_URL", bad)]).is_err(), "{bad}");
        }
        assert!(load(&[("GNOME_VPN_CHECK_URL", &format!("https://x.example/{}", "a".repeat(2048)))]).is_err());
        let err = load(&[("GNOME_VPN_CHECK_URL_V6", "https://ipv6.example.net/json")]).unwrap_err();
        assert!(err.problems.iter().any(|p| p == "GNOME_VPN_CHECK_URL_V6 requires GNOME_VPN_CHECK_URL"));
        assert!(load(&[("GNOME_VPN_CHECK_INTERVAL_MIN", "1441")]).is_err());
        assert_eq!(load(&[("GNOME_VPN_CHECK_INTERVAL_MIN", "0")]).unwrap().vpn_check_interval_min, 0);
    }

    /// D16 in its five cases, each also silenced by `GNOME_VPN_EGRESS_SHARED_OK=true`.
    #[test]
    fn vpn_terms_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = dir.path().join("profiles.toml");
        std::fs::write(
            &profiles,
            "[[profile]]\nid = \"se\"\nlabel = \"Sweden\"\ncountry_code = \"se\"\ncountry = \"Sweden\"\ncity = \"Stockholm\"\n\
             provider_note = \"test\"\nwisp_upstream = \"127.0.0.1:21999\"\n",
        )
        .unwrap();
        let path = profiles.display().to_string();
        type Case<'a> = (&'a [(&'a str, &'a str)], Option<&'a str>);
        let cases: [Case; 5] = [
            (&[("GNOME_ACCESS_MODE", "open")], Some(VPN_TERMS_WARNING)),
            (&[("GNOME_ACCESS_MODE", "accounts"), ("GNOME_REGISTRATION", "open")], Some(VPN_TERMS_WARNING)),
            (&[("GNOME_ACCESS_MODE", "accounts"), ("GNOME_REGISTRATION", "closed")], None),
            (&[("GNOME_ACCESS_MODE", "code"), ("GNOME_ACCESS_CODE", "long-enough-code")], Some(VPN_CODE_WARNING)),
            (
                &[
                    ("GNOME_ACCESS_MODE", "code"),
                    ("GNOME_ACCESS_CODE", "long-enough-code"),
                    ("GNOME_REGISTRATION", "closed"),
                ],
                Some(VPN_CODE_WARNING),
            ),
        ];
        for (vars, expected) in cases {
            for shared_ok in ["false", "true"] {
                let mut all = vars.to_vec();
                all.extend([("GNOME_VPN_PROFILES", path.as_str()), ("GNOME_VPN_EGRESS_SHARED_OK", shared_ok)]);
                let c = load(&all).unwrap();
                let got: Vec<&String> =
                    c.warnings.iter().filter(|w| **w == VPN_TERMS_WARNING || **w == VPN_CODE_WARNING).collect();
                match (expected, shared_ok) {
                    (Some(w), "false") => assert_eq!(got, [w], "{vars:?}"),
                    _ => assert!(got.is_empty(), "{vars:?} {shared_ok}: {got:?}"),
                }
                assert!(c.warnings.iter().any(|w| w.starts_with("no exit checks")), "{:?}", c.warnings);
            }
        }
        let quiet = load(&[]).unwrap();
        assert!(!quiet.warnings.iter().any(|w| w.starts_with("no exit checks") || *w == VPN_TERMS_WARNING));
        let checked =
            load(&[("GNOME_VPN_PROFILES", &path), ("GNOME_VPN_CHECK_URL", "https://c.example.net/")]).unwrap();
        assert!(!checked.warnings.iter().any(|w| w.starts_with("no exit checks")));
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
