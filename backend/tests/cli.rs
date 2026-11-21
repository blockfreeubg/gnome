//! The real `gnome-server` binary: `version`, `config check`, `migrate`, `user create`, `user reset-password`.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_gnome-server");

/// Run the binary with a clean environment (only `vars`), feeding `stdin`.
fn run(args: &[&str], vars: &[(&str, &str)], stdin: Option<&str>) -> Output {
    let mut cmd = Command::new(BIN);
    cmd.args(args).env_clear().envs(vars.iter().copied()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().expect("binary runs");
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    }
    child.wait_with_output().unwrap()
}

fn text(out: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

fn base(dir: &Path) -> Vec<(&'static str, String)> {
    vec![
        ("GNOME_DATA_DIR", dir.join("data").display().to_string()),
        ("GNOME_STATIC_DIR", dir.join("static").display().to_string()),
        ("GNOME_ARGON2_MEMORY_KIB", "1024".to_string()),
        ("GNOME_LOG", "warn".to_string()),
    ]
}

fn vars<'a>(base: &'a [(&'static str, String)], extra: &[(&'static str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    base.iter().map(|(k, v)| (*k, v.as_str())).chain(extra.iter().copied()).collect()
}

#[test]
fn version_and_usage_errors() {
    let out = run(&["version"], &[], None);
    assert!(out.status.success());
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(s.starts_with(&format!("gnome-server {} (", gnome_server::VERSION)), "{s}");
    let out = run(&["frobnicate"], &[], None);
    assert_eq!(out.status.code(), Some(2), "clap usage error");
    let out = run(&["--help"], &[], None);
    assert!(out.status.success());
    for cmd in ["serve", "migrate", "user", "config", "version"] {
        assert!(String::from_utf8_lossy(&out.stdout).contains(cmd), "help lists {cmd}");
    }
}

#[test]
fn config_check_redacts_secrets_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let key = "c2VjcmV0LWtleS1mb3ItdGVzdHMtc2VjcmV0LWtleS1mb3ItdGVzdHM=";
    let out = run(
        &["config", "check"],
        &vars(
            &base,
            &[
                ("GNOME_ADMIN_TOKEN", "admin-token-very-secret-1"),
                ("GNOME_ACCESS_MODE", "code"),
                ("GNOME_ACCESS_CODE", "access-code-secret-2"),
                ("GNOME_SECRET_KEY", key),
                ("GNOME_WISP_UPSTREAM", "127.0.0.1:6002"),
            ],
        ),
        None,
    );
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    for secret in ["admin-token-very-secret-1", "access-code-secret-2", key] {
        assert!(!s.contains(secret), "secret leaked: {s}");
    }
    assert!(s.contains("GNOME_ADMIN_TOKEN") && s.contains("<redacted>"), "{s}");
    assert!(s.contains("secret key: from GNOME_SECRET_KEY"), "{s}");
    assert!(s.contains("proxy isolation: off"), "{s}");
    assert!(s.contains("wisp upstream: 127.0.0.1:6002"), "{s}");
    assert!(!s.contains("has no effect"), "{s}");
    assert!(s.contains("no index.html"), "missing frontend is reported: {s}");
    assert!(s.contains("configuration OK"), "{s}");
    assert!(!dir.path().join("data").exists(), "config check must not create the data dir");
}

/// A static dir with `index.html` but without the engine host, the service worker or the engines (a UI-only or stale
/// build, like an old `frontend/dist`) is reported, naming what is missing; a complete build is not.
#[test]
fn config_check_warns_about_a_build_without_the_browser_files() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let static_dir = dir.path().join("static");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(static_dir.join("index.html"), "<!doctype html>").unwrap();
    let out = run(&["config", "check"], &vars(&base, &[]), None);
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(!s.contains("no index.html"), "{s}");
    assert!(s.contains("has no engine/index.html, sw.js, vendor/: it is not a complete frontend build"), "{s}");

    std::fs::create_dir_all(static_dir.join("engine")).unwrap();
    std::fs::write(static_dir.join("engine").join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(static_dir.join("sw.js"), "").unwrap();
    let out = run(&["config", "check"], &vars(&base, &[]), None);
    let s = text(&out);
    assert!(s.contains("has no vendor/: it is not a complete frontend build"), "{s}");

    std::fs::create_dir_all(static_dir.join("vendor")).unwrap();
    let out = run(&["config", "check"], &vars(&base, &[]), None);
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(!s.contains("not a complete frontend build"), "{s}");
    assert!(s.contains("configuration OK"), "{s}");
}

#[test]
fn invalid_configuration_exits_2_with_every_problem() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let out = run(
        &["config", "check"],
        &vars(&base, &[("GNOME_BIND", "nope"), ("GNOME_ADMIN_TOKEN", "short-secret"), ("GNOME_CSP", "maybe")]),
        None,
    );
    let s = text(&out);
    assert_eq!(out.status.code(), Some(2), "{s}");
    assert!(s.contains("GNOME_BIND") && s.contains("GNOME_CSP") && s.contains("GNOME_ADMIN_TOKEN"), "{s}");
    assert!(!s.contains("short-secret"), "invalid secrets are not echoed: {s}");
    // `serve` refuses the same configuration before binding anything.
    let out = run(&["serve"], &vars(&base, &[("GNOME_BIND", "nope")]), None);
    assert_eq!(out.status.code(), Some(2), "{}", text(&out));
}

#[test]
fn toml_file_with_env_precedence() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let file = dir.path().join("gnome.toml");
    std::fs::write(&file, "bind = \"127.0.0.1:20901\"\nlog_ips = true\npublic_origins = [\"https://g.example\"]\n")
        .unwrap();
    let path = file.display().to_string();
    let out =
        run(&["config", "check"], &vars(&base, &[("GNOME_CONFIG", &path), ("GNOME_BIND", "127.0.0.1:20902")]), None);
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    let line = |name: &str| s.lines().find(|l| l.trim_start().starts_with(name)).unwrap_or_default().to_string();
    assert!(line("GNOME_BIND ").contains("127.0.0.1:20902") && line("GNOME_BIND ").contains("env"), "{s}");
    assert!(line("GNOME_LOG_IPS").contains("true") && line("GNOME_LOG_IPS").contains("file"), "{s}");
    assert!(line("GNOME_PUBLIC_ORIGINS").contains("https://g.example"), "{s}");
    std::fs::write(&file, "bnid = \"127.0.0.1:1\"\n").unwrap();
    let out = run(&["config", "check"], &vars(&base, &[("GNOME_CONFIG", &path)]), None);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out).contains("unknown key \"bnid\""), "{}", text(&out));
}

#[test]
fn migrate_is_idempotent_and_private() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let v = vars(&base, &[]);
    let out = run(&["migrate"], &v, None);
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(s.contains("applied migration 1 (core)"), "{s}");
    let out = run(&["migrate"], &v, None);
    assert!(text(&out).contains("database is up to date"), "{}", text(&out));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.path().join("data")), 0o700);
        assert_eq!(mode(&dir.path().join("data/gnome.db")), 0o600);
    }
}

fn db(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open(dir.join("data/gnome.db")).unwrap()
}

#[test]
fn user_create_and_reset_password() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let v = vars(&base, &[]);

    let out = run(&["user", "create", "Operator", "--admin", "--password-stdin"], &v, Some("correct horse battery\n"));
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(s.contains("created user Operator") && s.contains("admin"), "{s}");
    let (hash, is_admin): (String, bool) = db(dir.path())
        .query_row("SELECT password_hash, is_admin FROM users WHERE username = 'operator'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert!(hash.starts_with("$argon2id$v=19$m=1024,t=2,p=1$") && is_admin, "{hash}");

    // Duplicates (case-insensitive), bad names, short passwords, and no TTY without --password-stdin.
    let dup = run(&["user", "create", "OPERATOR", "--password-stdin"], &v, Some("another long password\n"));
    assert_eq!(dup.status.code(), Some(2));
    assert!(text(&dup).contains("already exists"), "{}", text(&dup));
    let bad = run(&["user", "create", "no spaces", "--password-stdin"], &v, Some("another long password\n"));
    assert_eq!(bad.status.code(), Some(2));
    let short = run(&["user", "create", "bob", "--password-stdin"], &v, Some("short\n"));
    assert_eq!(short.status.code(), Some(2));
    assert!(text(&short).contains("at least 10"), "{}", text(&short));
    let tty = run(&["user", "create", "bob"], &v, None);
    assert_eq!(tty.status.code(), Some(2));
    assert!(text(&tty).contains("--password-stdin"), "{}", text(&tty));

    // Reset signs the user out everywhere.
    let conn = db(dir.path());
    conn.execute(
        "INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
         SELECT zeroblob(32), id, 0, 0, 9999999999999 FROM users WHERE username = 'operator'",
        [],
    )
    .unwrap();
    let out = run(&["user", "reset-password", "operator", "--password-stdin"], &v, Some("a whole new password\r\n"));
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(s.contains("1 sessions signed out"), "{s}");
    let (new_hash, sessions): (String, i64) = conn
        .query_row(
            "SELECT password_hash, (SELECT count(*) FROM user_sessions) FROM users WHERE username = 'operator'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_ne!(new_hash, hash);
    assert_eq!(sessions, 0);
    let missing = run(&["user", "reset-password", "nobody", "--password-stdin"], &v, Some("a whole new password\n"));
    assert_eq!(missing.status.code(), Some(2));
    assert!(text(&missing).contains("no user named"), "{}", text(&missing));
}

/// `config check` describes the origin setup (ARCHITECTURE §4.6) and refuses an app allow-list containing the proxy
/// origin, which would let proxied pages pass the CSRF origin check.
#[test]
fn config_check_reports_the_origin_setup() {
    let dir = tempfile::tempdir().unwrap();
    let base = base(dir.path());
    let two = [("GNOME_BIND", "127.0.0.1:20901"), ("GNOME_PROXY_BIND", "127.0.0.1:20902")];
    let out = run(&["config", "check"], &vars(&base, &two), None);
    let s = text(&out);
    assert!(out.status.success(), "{s}");
    assert!(s.contains("proxy isolation: on (two-origin mode)"), "{s}");
    assert!(s.contains("app origin(s):   http://127.0.0.1:20901 (derived from the loopback GNOME_BIND)"), "{s}");
    assert!(s.contains("proxy origin:    http://127.0.0.1:20902 (derived from the loopback GNOME_PROXY_BIND)"), "{s}");
    assert!(!s.contains("proxy isolation is off"), "{s}");

    let public = [
        ("GNOME_PROXY_ORIGIN", "https://p.gnome.example.com"),
        ("GNOME_PUBLIC_ORIGINS", "https://gnome.example.com, https://P.gnome.example.com:443/"),
    ];
    let out = run(&["config", "check"], &vars(&base, &public), None);
    let s = text(&out);
    assert_eq!(out.status.code(), Some(2), "{s}");
    assert!(s.contains("must not contain the proxy origin https://p.gnome.example.com"), "{s}");
    assert!(!dir.path().join("data").exists(), "config check must not create the data dir");
}
