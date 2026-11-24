//! Command-line interface: `serve` (default) · `migrate` · `user create|reset-password` · `filters refresh|status` ·
//! `config check` · `health` · `admin get` · `db backup` · `version`.

use std::io::{BufRead as _, IsTerminal as _};
use std::path::Path;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::VERSION;
use crate::auth::password::{Passwords, validate_password, validate_username};
use crate::auth::{sessions, users};
use crate::config::{Config, VARS};
use crate::db;
use crate::observability::init_tracing;
use crate::security::secret_key::{self, KeySource};
use crate::state::{AppState, ensure_private_dir};
use crate::util::now_ms;

#[derive(Debug, Parser)]
#[command(
    name = "gnome-server",
    version,
    about = "GNOME web proxy platform server",
    long_about = "GNOME web proxy platform server.\n\nConfiguration comes from GNOME_* environment variables and an \
                  optional TOML file named by GNOME_CONFIG (environment wins). Run `gnome-server config check` to see \
                  the effective values."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the HTTP server (default when no command is given).
    Serve,
    /// Apply pending database migrations and exit.
    Migrate,
    /// Manage user accounts.
    #[command(subcommand)]
    User(UserCommand),
    /// Content-blocking filter lists.
    #[command(subcommand)]
    Filters(FiltersCommand),
    /// Inspect the configuration.
    #[command(subcommand)]
    Config(ConfigCommand),
    /// The game catalog: import feeds, print statistics, fetch open-source game builds.
    #[command(subcommand)]
    Catalog(crate::games::cli::CatalogCommand),
    /// Ask the running server's `/api/health` (exit 0 ok, 1 not ok or unreachable, 2 configuration error).
    Health {
        /// Ask this URL instead of `http://<GNOME_BIND>/api/health` (plain `http://` only).
        #[arg(long)]
        url: Option<String>,
        /// Give up after this many milliseconds.
        #[arg(long, default_value_t = 3000)]
        timeout_ms: u64,
    },
    /// Read from the local admin listener (`GNOME_ADMIN_BIND`).
    #[command(subcommand)]
    Admin(AdminCommand),
    /// Database maintenance.
    #[command(subcommand)]
    Db(DbCommand),
    /// Print version information.
    Version,
}

#[derive(Debug, Subcommand)]
pub enum AdminCommand {
    /// `GET <path>` (must start with `/admin/`) with the admin token when one is configured; prints the body.
    Get { path: String },
}

#[derive(Debug, Subcommand)]
pub enum DbCommand {
    /// Write a consistent snapshot of the database to a new file (mode 0600; the server may keep running).
    Backup { file: std::path::PathBuf },
}

#[derive(Debug, Subcommand)]
pub enum UserCommand {
    /// Create an account (prompts for the password unless --password-stdin is given).
    Create {
        /// Username: 3–32 characters of [a-zA-Z0-9_.-].
        name: String,
        /// Mark the account as an administrator.
        #[arg(long)]
        admin: bool,
        /// Read the password from the first line of standard input.
        #[arg(long)]
        password_stdin: bool,
    },
    /// Set a new password and sign the user out everywhere.
    ResetPassword {
        name: String,
        /// Read the password from the first line of standard input.
        #[arg(long)]
        password_stdin: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum FiltersCommand {
    /// Check every filter list upstream now (conditional GET) and store what changed. Exit code 1 if any failed.
    Refresh {
        /// Only these list ids (default: all).
        ids: Vec<String>,
    },
    /// Print the stored filter lists.
    Status,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    /// Validate the configuration and print the effective values (secrets redacted).
    Check,
}

/// Exit codes: 0 success, 1 runtime failure, 2 configuration/usage error.
pub fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(),
        Command::Migrate => migrate(),
        Command::User(cmd) => user(cmd),
        Command::Filters(cmd) => filters(cmd),
        Command::Config(ConfigCommand::Check) => config_check(),
        Command::Catalog(cmd) => return crate::games::cli::run(cmd),
        Command::Health { url, timeout_ms } => health(url.as_deref(), timeout_ms),
        Command::Admin(AdminCommand::Get { path }) => admin_get(&path),
        Command::Db(DbCommand::Backup { file }) => db_backup(&file),
        Command::Version => {
            println!(
                "gnome-server {VERSION} ({}-{}) build {}",
                std::env::consts::ARCH,
                std::env::consts::OS,
                option_env!("GNOME_BUILD_ID").unwrap_or("unknown")
            );
            Ok(())
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Failure::Config(msg)) => {
            eprintln!("error: {msg}");
            ExitCode::from(2)
        }
        Err(Failure::Runtime(msg)) => {
            eprintln!("error: {msg}");
            ExitCode::from(1)
        }
    }
}

enum Failure {
    Config(String),
    Runtime(String),
}

fn runtime(e: impl std::fmt::Display) -> Failure {
    Failure::Runtime(e.to_string())
}

fn load_config() -> Result<Config, Failure> {
    Config::from_env().map_err(|e| Failure::Config(e.to_string().trim_end().to_string()))
}

fn serve() -> Result<(), Failure> {
    let config = load_config()?;
    init_tracing(&config);
    std::panic::set_hook(Box::new(|info| tracing::error!(panic = %info, "panic")));
    for w in &config.warnings {
        tracing::warn!("{w}");
    }
    // Before any thread or socket exists; a failure is logged and the server runs with the inherited limit.
    crate::server::fd_limit::raise();
    let cpus = std::thread::available_parallelism().map_or(1, usize::from);
    let workers = config.workers.map_or(cpus, |cap| cap.min(cpus).max(1));
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .thread_name("gnome-worker")
        .enable_all()
        .build()
        .map_err(runtime)?;
    tracing::info!(workers, access_mode = config.access_mode.as_str(), "starting gnome-server {VERSION}");
    rt.block_on(async {
        let state = AppState::open(config).await.map_err(runtime)?;
        crate::server::run(state).await.map_err(runtime)
    })
}

/// One plain HTTP/1.1 `GET` (`Connection: close`); returns the status code and the body.
fn http_get(
    addr: std::net::SocketAddr,
    host: &str,
    path: &str,
    bearer: Option<&str>,
    timeout: std::time::Duration,
) -> Result<(u16, Vec<u8>), String> {
    use std::io::{Read as _, Write as _};
    let mut s = std::net::TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect {addr}: {e}"))?;
    s.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let auth = bearer.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: gnome-server-cli\r\n{auth}Connection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes()).map_err(|e| format!("send: {e}"))?;
    let mut buf = Vec::new();
    // Bounded: the health and diagnostics answers are small.
    s.take(16 << 20).read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n").ok_or("malformed answer (no end of head)")?;
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let status =
        head.split_ascii_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok()).ok_or("malformed status line")?;
    let mut body = buf[end + 4..].to_vec();
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if chunked {
        body = dechunk(&body).ok_or("malformed chunked body")?;
    }
    Ok((status, body))
}

fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let nl = b.windows(2).position(|w| w == b"\r\n")?;
        let size_txt = std::str::from_utf8(&b[..nl]).ok()?;
        let size = usize::from_str_radix(size_txt.split(';').next()?.trim(), 16).ok()?;
        b = &b[nl + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(b.get(..size)?);
        b = b.get(size + 2..)?;
    }
}

/// An unspecified bind address (`0.0.0.0`, `::`) is asked on loopback.
fn local_addr(mut a: std::net::SocketAddr) -> std::net::SocketAddr {
    if a.ip().is_unspecified() {
        a.set_ip(if a.is_ipv4() { std::net::Ipv4Addr::LOCALHOST.into() } else { std::net::Ipv6Addr::LOCALHOST.into() });
    }
    a
}

fn health(url: Option<&str>, timeout_ms: u64) -> Result<(), Failure> {
    let timeout = std::time::Duration::from_millis(timeout_ms.max(1));
    let (addr, host, path) = match url {
        Some(u) => {
            let rest =
                u.strip_prefix("http://").ok_or_else(|| Failure::Config(format!("--url must be http://: {u}")))?;
            let (authority, path) = rest.find('/').map_or((rest, "/api/health"), |i| (&rest[..i], &rest[i..]));
            let addr = std::net::ToSocketAddrs::to_socket_addrs(authority)
                .ok()
                .and_then(|mut a| a.next())
                .ok_or_else(|| Failure::Config(format!("--url: cannot resolve {authority} (give host:port)")))?;
            (addr, authority.to_string(), path.to_string())
        }
        None => {
            let config = load_config()?;
            let addr = local_addr(config.bind);
            (addr, addr.to_string(), "/api/health".to_string())
        }
    };
    let (status, body) = http_get(addr, &host, &path, None, timeout).map_err(runtime)?;
    let text = String::from_utf8_lossy(&body);
    println!("{}", text.trim_end());
    let ok = status == 200
        && serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .is_some_and(|v| v.get("status").and_then(|s| s.as_str()) == Some("ok"));
    if ok { Ok(()) } else { Err(Failure::Runtime(format!("health: HTTP {status}"))) }
}

fn admin_get(path: &str) -> Result<(), Failure> {
    if !path.starts_with("/admin/") || path.contains(char::is_whitespace) {
        return Err(Failure::Config(format!("admin get: the path must start with /admin/ (got {path:?})")));
    }
    let config = load_config()?;
    let addr = config
        .admin_bind
        .map(local_addr)
        .ok_or_else(|| Failure::Runtime("the admin listener is disabled (GNOME_ADMIN_BIND is empty)".into()))?;
    let host = match addr.ip() {
        std::net::IpAddr::V6(_) => format!("[::1]:{}", addr.port()),
        std::net::IpAddr::V4(_) => format!("127.0.0.1:{}", addr.port()),
    };
    let token = config.admin_token.as_ref().map(|t| t.expose().to_string());
    let (status, body) =
        http_get(addr, &host, path, token.as_deref(), std::time::Duration::from_secs(10)).map_err(runtime)?;
    use std::io::Write as _;
    let mut out = std::io::stdout().lock();
    out.write_all(&body).map_err(runtime)?;
    if !body.ends_with(b"\n") {
        let _ = out.write_all(b"\n");
    }
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(Failure::Runtime(format!("admin get {path}: HTTP {status}")))
    }
}

fn db_backup(target: &Path) -> Result<(), Failure> {
    let config = load_config()?;
    let source = config.db_path();
    if !source.exists() {
        return Err(Failure::Runtime(format!("no database at {}", source.display())));
    }
    // Created first with O_EXCL and 0600: SQLite would create it 0644 & ~umask, outside the unit's UMask.
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    opts.open(target).map_err(|e| Failure::Runtime(format!("cannot create {}: {e}", target.display())))?;
    let result = (|| -> Result<(u64, Vec<i64>), String> {
        let conn = rusqlite::Connection::open_with_flags(&source, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192;").map_err(|e| e.to_string())?;
        let target_txt = target.to_str().ok_or("the target path is not UTF-8")?;
        conn.execute("VACUUM INTO ?1", [target_txt]).map_err(|e| format!("VACUUM INTO: {e}"))?;
        drop(conn);
        let copy = rusqlite::Connection::open_with_flags(target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let check: String = copy.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("integrity check of the copy failed: {check}"));
        }
        let mut stmt =
            copy.prepare("SELECT version FROM schema_migrations ORDER BY version").map_err(|e| e.to_string())?;
        let versions =
            stmt.query_map([], |r| r.get::<_, i64>(0)).and_then(Iterator::collect).map_err(|e| e.to_string())?;
        let size = std::fs::metadata(target).map_err(|e| e.to_string())?.len();
        Ok((size, versions))
    })();
    match result {
        Ok((size, versions)) => {
            println!("backup written: {} ({}, schema versions {versions:?})", target.display(), human_bytes(size));
            println!("note: secret.key is not part of the backup; keep it separately or in your secret store");
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(target);
            Err(Failure::Runtime(format!("db backup: {e}")))
        }
    }
}

/// Open the database for a one-shot command (creates the data dir, applies migrations).
fn open_db(config: &Config) -> Result<(rusqlite::Connection, db::migrate::MigrationReport), Failure> {
    ensure_private_dir(&config.data_dir)
        .map_err(|e| Failure::Runtime(format!("cannot create data dir {}: {e}", config.data_dir.display())))?;
    let mut conn = db::open_writer(&config.db_path()).map_err(runtime)?;
    let report = db::migrate::run(&mut conn).map_err(runtime)?;
    Ok((conn, report))
}

fn migrate() -> Result<(), Failure> {
    let config = load_config()?;
    init_tracing(&config);
    let (_conn, report) = open_db(&config)?;
    if report.applied.is_empty() {
        println!("database is up to date: {}", config.db_path().display());
    }
    for (version, name) in &report.applied {
        println!("applied migration {version} ({name})");
    }
    println!("schema versions: {:?}", report.current);
    Ok(())
}

fn read_password(from_stdin: bool) -> Result<String, Failure> {
    if from_stdin {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).map_err(runtime)?;
        let pw = line.strip_suffix('\n').map_or(line.as_str(), |l| l.strip_suffix('\r').unwrap_or(l));
        return Ok(pw.to_string());
    }
    if !std::io::stdin().is_terminal() {
        return Err(Failure::Config("stdin is not a terminal; use --password-stdin to pipe the password".into()));
    }
    let first = rpassword::prompt_password("New password: ").map_err(runtime)?;
    let second = rpassword::prompt_password("Repeat password: ").map_err(runtime)?;
    if first != second {
        return Err(Failure::Config("the passwords do not match".into()));
    }
    Ok(first)
}

fn new_password_hash(config: &Config, from_stdin: bool) -> Result<String, Failure> {
    let password = read_password(from_stdin)?;
    validate_password(&password).map_err(|e| Failure::Config(format!("password {e}")))?;
    let hasher = Passwords::new(config.argon2_memory_kib).map_err(runtime)?;
    hasher.hash_blocking(&password).map_err(runtime)
}

fn user(cmd: UserCommand) -> Result<(), Failure> {
    let config = load_config()?;
    match cmd {
        UserCommand::Create { name, admin, password_stdin } => {
            validate_username(&name).map_err(|e| Failure::Config(format!("username {e}")))?;
            let hash = new_password_hash(&config, password_stdin)?;
            let (conn, _) = open_db(&config)?;
            match users::insert(&conn, &name, &hash, admin, now_ms()) {
                Ok(u) => {
                    println!("created user {} (id {}{})", u.username, u.id, if admin { ", admin" } else { "" });
                    Ok(())
                }
                Err(users::InsertError::UsernameTaken) => Err(Failure::Config(format!("user {name:?} already exists"))),
                Err(users::InsertError::Sqlite(e)) => Err(runtime(e)),
            }
        }
        UserCommand::ResetPassword { name, password_stdin } => {
            let (mut conn, _) = open_db(&config)?;
            let record = users::find_by_username(&conn, &name)
                .map_err(runtime)?
                .ok_or_else(|| Failure::Config(format!("no user named {name:?}")))?;
            let hash = new_password_hash(&config, password_stdin)?;
            let tx = conn.transaction().map_err(runtime)?;
            users::set_password(&tx, record.user.id, &hash, now_ms()).map_err(runtime)?;
            let revoked = sessions::delete_all_for_user(&tx, record.user.id).map_err(runtime)?;
            tx.commit().map_err(runtime)?;
            println!("password updated for {} ({revoked} sessions signed out)", record.user.username);
            Ok(())
        }
    }
}

fn human_bytes(n: u64) -> String {
    match n {
        0..1_000 => format!("{n} B"),
        1_000..1_000_000 => format!("{:.1} kB", n as f64 / 1e3),
        _ => format!("{:.2} MB", n as f64 / 1e6),
    }
}

fn filters(cmd: FiltersCommand) -> Result<(), Failure> {
    use crate::filters::FilterService;
    use crate::filters::refresh::{Mode, Outcome};
    let config = load_config()?;
    init_tracing(&config);
    if let FiltersCommand::Refresh { ids } = &cmd
        && let Some(unknown) = ids.iter().find(|id| !config.filter_lists.iter().any(|l| &l.id == *id))
    {
        return Err(Failure::Config(format!("unknown filter list {unknown:?}")));
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(runtime)?;
    rt.block_on(async {
        let state = AppState::open(config).await.map_err(runtime)?;
        let svc = state.ext::<FilterService>().ok_or_else(|| runtime("the filter-list module is not enabled"))?;
        svc.wait_loaded().await;
        let result = match cmd {
            FiltersCommand::Refresh { ids } => {
                let only = (!ids.is_empty()).then_some(ids.as_slice());
                let started = std::time::Instant::now();
                let reports = svc.refresh(Mode::All, only).await;
                let mut failed = 0;
                for r in &reports {
                    let detail = match &r.outcome {
                        Outcome::Updated { size, .. } => format!("updated, {}", human_bytes(*size)),
                        Outcome::Failed { error } => {
                            failed += 1;
                            format!("FAILED: {error}")
                        }
                        other => other.name().replace('_', " "),
                    };
                    println!("  {:26} {:>6} ms  {detail}", r.id, r.ms);
                }
                println!(
                    "{} lists checked in {:.1} s, {failed} failed",
                    reports.len(),
                    started.elapsed().as_secs_f64()
                );
                if failed > 0 { Err(Failure::Runtime(format!("{failed} filter lists failed"))) } else { Ok(()) }
            }
            FiltersCommand::Status => {
                println!("filter lists in {}", svc.dir.display());
                for def in &svc.defs {
                    let e = svc.entry(&def.id).unwrap_or_default();
                    let m = &e.meta;
                    let state_text = if e.files.is_some() {
                        format!(
                            "{} (br {}, gzip {}), version {}",
                            human_bytes(m.size),
                            human_bytes(m.size_br),
                            human_bytes(m.size_gzip),
                            m.version.as_deref().unwrap_or("-")
                        )
                    } else {
                        "not downloaded".into()
                    };
                    let error = m.last_error.as_deref().map(|e| format!("; last error: {e}")).unwrap_or_default();
                    println!(
                        "  {:26} {:10} {}{}  {state_text}{error}",
                        def.id,
                        def.category.as_str(),
                        if def.default_enabled { "on " } else { "off" },
                        if def.trusted { " trusted" } else { "        " },
                    );
                }
                Ok(())
            }
        };
        state.shutdown.cancel();
        state.tasks.close();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), state.tasks.wait()).await;
        result
    })
}

/// The browser's files a complete frontend build has beside `index.html` (frontend/package.json `build`: the engine
/// host page, the service worker and the engines copied by copy-vendor.mjs). `None` when all are there.
fn missing_engine_files(static_dir: &Path) -> Option<String> {
    let missing: Vec<&str> = [
        ("engine/index.html", static_dir.join("engine").join("index.html").is_file()),
        ("sw.js", static_dir.join("sw.js").is_file()),
        ("vendor/", static_dir.join("vendor").is_dir()),
    ]
    .into_iter()
    .filter_map(|(name, present)| (!present).then_some(name))
    .collect();
    (!missing.is_empty()).then(|| missing.join(", "))
}

fn config_check() -> Result<(), Failure> {
    let config = load_config()?;
    println!("gnome-server {VERSION}: effective configuration");
    match &config.config_file {
        Some(p) => println!("config file: {}", p.display()),
        None => println!("config file: (none; set GNOME_CONFIG to use one)"),
    }
    println!();
    let name_w = VARS.iter().map(|v| v.name.len()).max().unwrap_or(0);
    let value_w = config.settings.iter().map(|s| s.value.len().max(7)).max().unwrap_or(0).min(48);
    for s in &config.settings {
        let value = if s.value.is_empty() { "(unset)" } else { s.value.as_str() };
        let note = s.inactive.map(|m| format!("  [no effect: this build does not include {m}]")).unwrap_or_default();
        println!("  {:name_w$}  {:value_w$}  {:7}{note}", s.name, value, s.provenance.as_str());
    }
    println!();
    let proxy = &config.proxy;
    let mut warnings = config.warnings.clone();
    match proxy.origin() {
        Some(origin) => {
            let source = match proxy.origin_source() {
                Some(crate::origins::ProxyOriginSource::ProxyBind) => " (derived from the loopback GNOME_PROXY_BIND)",
                _ => "",
            };
            let derived = if proxy.app_origins_derived() { " (derived from the loopback GNOME_BIND)" } else { "" };
            println!("proxy isolation: on (two-origin mode)");
            println!("  app origin(s):   {}{derived}", proxy.app_origins().join(", "));
            println!("  proxy origin:    {origin}{source}");
            println!(
                "  proxy role on:   requests whose host is the proxy origin's{}",
                match config.proxy_bind {
                    Some(addr) => format!(", and every request to the proxy listener {addr}"),
                    None => String::new(),
                }
            );
        }
        None => {
            println!("proxy isolation: off (single-origin mode: one origin serves the app and the proxy)");
            warnings.push(format!(
                "proxy isolation is off: {}; set GNOME_PROXY_ORIGIN (+ GNOME_PUBLIC_ORIGINS) or GNOME_PROXY_BIND",
                crate::api::meta::SINGLE_ORIGIN_EXPLANATION
            ));
        }
    }
    println!("wisp upstream: {} (tickets up to {} s)", config.wisp_upstream, config.wisp_ticket_ttl_s);
    if config.profiles.is_empty() {
        println!("vpn gateway profiles: none");
    } else {
        println!("vpn gateway profiles: {}", config.profiles.len());
        for p in &config.profiles {
            println!("  {:12} {} -> {}", p.id, p.label, p.upstream);
        }
    }
    println!(
        "filter lists: {} ({}), re-checked {}",
        config.filter_lists.len(),
        match &config.filter_lists_file {
            Some(p) => format!("built-ins + {}", p.display()),
            None => "built-in registry".into(),
        },
        if config.filters_refresh_hours == 0 {
            "only on demand (GNOME_FILTERS_REFRESH_HOURS=0)".to_string()
        } else {
            format!("per '! Expires' (else every {} h), clamped to 4 h-7 d", config.filters_refresh_hours.clamp(4, 168))
        }
    );
    // Lists read from local files (WAVE-B3 §8): marked `file`, with what is at the path now (stat only, never an open:
    // a FIFO named here must not block the check). They are re-read by the `filters.files` job (at start and every
    // 10 min, whatever GNOME_FILTERS_REFRESH_HOURS says) and by every forced refresh.
    let file_lists: Vec<_> = config.filter_lists.iter().filter(|l| l.is_file()).collect();
    if !file_lists.is_empty() {
        println!(
            "  {} of them read from files: at start, every 10 min and on `filters refresh` (whatever \
             GNOME_FILTERS_REFRESH_HOURS says)",
            file_lists.len()
        );
    }
    for l in file_lists {
        let path = l.file.as_deref().expect("is_file");
        // What the read refuses although the path itself passed the configuration checks (refresh.rs read_list_file):
        // links that lead under /proc, /sys or /dev, and a file larger than the list's max_mb.
        let forbidden = std::fs::canonicalize(path).is_ok_and(|real| crate::filters::registry::forbidden_path(&real));
        let state = match std::fs::metadata(path) {
            Ok(_) if forbidden => {
                warnings.push(format!(
                    "filter list {:?}: {} leads to a path under /proc, /sys or /dev; it is not read",
                    l.id,
                    path.display()
                ));
                "leads under /proc, /sys or /dev".into()
            }
            Ok(m) if m.is_file() && m.len() > l.max_bytes => {
                warnings.push(format!(
                    "filter list {:?}: {} is {}, more than its max_mb ({} MiB); it is not read",
                    l.id,
                    path.display(),
                    human_bytes(m.len()),
                    l.max_bytes / (1024 * 1024)
                ));
                format!("regular file, {}, larger than max_mb", human_bytes(m.len()))
            }
            Ok(m) if m.is_file() => format!("regular file, {}", human_bytes(m.len())),
            Ok(_) => {
                warnings.push(format!(
                    "filter list {:?}: {} is not a regular file; it is not read",
                    l.id,
                    path.display()
                ));
                "not a regular file".into()
            }
            Err(_) => {
                warnings.push(format!(
                    "filter list {:?}: {} does not exist or cannot be read; the list stays unavailable until it can",
                    l.id,
                    path.display()
                ));
                "missing or unreadable".into()
            }
        };
        println!("  {:26} file  {} ({state})", l.id, path.display());
    }
    match secret_key::key_source(&config) {
        KeySource::Configured => println!("secret key: from GNOME_SECRET_KEY"),
        KeySource::File(p) => println!("secret key: {}", p.display()),
        KeySource::WillGenerate(p) => println!("secret key: will be generated at {}", p.display()),
    }
    match config.admin_bind {
        Some(addr) => println!(
            "admin listener: {addr} ({})",
            if config.admin_token.is_some() { "bearer token required" } else { "loopback only, no token" }
        ),
        None => println!("admin listener: disabled"),
    }
    if !config.static_dir.join("index.html").is_file() {
        warnings.push(format!(
            "GNOME_STATIC_DIR {} has no index.html: the frontend is not built (a placeholder page will be served)",
            config.static_dir.display()
        ));
    } else if let Some(missing) = missing_engine_files(&config.static_dir) {
        // A UI-only (or stale) build: the app loads, but the browser view cannot start its engine host or proxy a page.
        // `serve` logs the same fact as `engine_host=false` on its "static index ready" line.
        warnings.push(format!(
            "GNOME_STATIC_DIR {} has no {missing}: it is not a complete frontend build, so the browser cannot load \
             proxied pages (run `npm run build` in frontend/, which writes engine/, sw.js and vendor/)",
            config.static_dir.display()
        ));
    }
    if config.data_dir.exists() && !config.data_dir.is_dir() {
        warnings.push(format!("GNOME_DATA_DIR {} exists but is not a directory", config.data_dir.display()));
    }
    if !warnings.is_empty() {
        println!();
        for w in &warnings {
            println!("warning: {w}");
        }
    }
    println!();
    println!("configuration OK");
    Ok(())
}
