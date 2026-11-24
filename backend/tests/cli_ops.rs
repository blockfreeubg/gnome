//! The real `gnome-server` binary's operations commands: `health`, `admin get`, `db backup`, `version`.
//!
//! Listeners bind `127.0.0.1` on ports from `GNOME_TEST_PORT_BASE` (default 11400; WAVE-D §0 keeps test ports below
//! 32768). `GNOME_TEST_EXEC_WRAPPER` (e.g. `qemu-aarch64`) runs the binary through a user-mode emulator (row RP2).

use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_gnome-server");
const TOKEN: &str = "cli-ops-test-admin-token-0123456789";

fn command() -> Command {
    match std::env::var("GNOME_TEST_EXEC_WRAPPER").ok().filter(|w| !w.is_empty()) {
        Some(w) => {
            let mut c = Command::new(w);
            c.arg(BIN);
            c
        }
        None => Command::new(BIN),
    }
}

/// Two consecutive free loopback ports in the lane's range.
fn free_ports() -> (u16, u16) {
    let base: u16 = std::env::var("GNOME_TEST_PORT_BASE").ok().and_then(|v| v.parse().ok()).unwrap_or(11400);
    for p in (base..base + 400).step_by(2) {
        if let (Ok(a), Ok(b)) = (TcpListener::bind(("127.0.0.1", p)), TcpListener::bind(("127.0.0.1", p + 1))) {
            drop((a, b));
            return (p, p + 1);
        }
    }
    panic!("no free port pair from {base}");
}

fn env(dir: &Path, app: u16, admin: u16) -> Vec<(&'static str, String)> {
    vec![
        ("GNOME_DATA_DIR", dir.join("data").display().to_string()),
        ("GNOME_STATIC_DIR", dir.join("static").display().to_string()),
        ("GNOME_BIND", format!("127.0.0.1:{app}")),
        ("GNOME_ADMIN_BIND", format!("127.0.0.1:{admin}")),
        ("GNOME_ADMIN_TOKEN", TOKEN.to_string()),
        ("GNOME_ARGON2_MEMORY_KIB", "1024".to_string()),
        ("GNOME_WORKERS", "2".to_string()),
        ("GNOME_DB_READERS", "1".to_string()),
        ("GNOME_LOG", "warn".to_string()),
        ("GNOME_WISP_UPSTREAM", "127.0.0.1:9".to_string()),
        ("GNOME_FILTERS_REFRESH_HOURS", "0".to_string()),
        ("GNOME_CATALOG_REFRESH_HOURS", "0".to_string()),
        ("GNOME_OSS_FETCH", "manual".to_string()),
    ]
}

fn run(args: &[&str], vars: &[(&'static str, String)]) -> Output {
    command()
        .args(args)
        .env_clear()
        .envs(vars.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::null())
        .output()
        .expect("binary runs")
}

fn text(o: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(vars: &[(&'static str, String)]) -> Server {
    let child = command()
        .arg("serve")
        .env_clear()
        .envs(vars.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("server starts");
    let server = Server(child);
    let t = Instant::now();
    while run(&["health", "--timeout-ms", "500"], vars).status.code() != Some(0) {
        assert!(t.elapsed() < Duration::from_secs(30), "server did not become healthy");
        std::thread::sleep(Duration::from_millis(100));
    }
    server
}

#[test]
fn version_prints_build_id() {
    let out = run(&["version"], &[]);
    assert!(out.status.success());
    assert!(text(&out).contains(" build "), "{}", text(&out));
}

#[test]
fn health_admin_and_backup_against_a_running_server() {
    let dir = tempfile::tempdir().unwrap();
    let (app, admin) = free_ports();
    let vars = env(dir.path(), app, admin);
    let _server = start(&vars);

    let out = run(&["health"], &vars);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"status\""));

    let out = run(&["health", "--url", &format!("http://127.0.0.1:{app}/api/health")], &vars);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));

    let out = run(&["admin", "get", "/admin/diagnostics"], &vars);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    assert!(String::from_utf8_lossy(&out.stdout).trim_start().starts_with('{'));

    // Without the token the listener refuses (401): exit 1.
    let no_token: Vec<_> = vars.iter().filter(|(k, _)| *k != "GNOME_ADMIN_TOKEN").cloned().collect();
    let out = run(&["admin", "get", "/admin/diagnostics"], &no_token);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));

    let out = run(&["admin", "get", "/api/health"], &vars);
    assert_eq!(out.status.code(), Some(2), "{}", text(&out));

    let backup = dir.path().join("backup.db");
    let out = run(&["db", "backup", backup.to_str().unwrap()], &vars);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    assert!(text(&out).contains("schema versions"), "{}", text(&out));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let copy = rusqlite::Connection::open(&backup).unwrap();
    let n: i64 = copy.query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0)).unwrap();
    assert!(n >= 1);

    // An existing target is refused and left alone.
    let out = run(&["db", "backup", backup.to_str().unwrap()], &vars);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));
    assert!(backup.exists());
}

#[test]
fn health_fails_without_a_server_and_admin_get_without_listener() {
    let dir = tempfile::tempdir().unwrap();
    let (app, admin) = free_ports();
    let vars = env(dir.path(), app, admin);
    let out = run(&["health", "--timeout-ms", "300"], &vars);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));

    let mut off = vars.clone();
    off.retain(|(k, _)| *k != "GNOME_ADMIN_BIND" && *k != "GNOME_ADMIN_TOKEN");
    off.push(("GNOME_ADMIN_BIND", String::new()));
    let out = run(&["admin", "get", "/admin/diagnostics"], &off);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));

    let out = run(&["db", "backup", dir.path().join("x.db").to_str().unwrap()], &vars);
    assert_eq!(out.status.code(), Some(1), "no database yet: {}", text(&out));
}
