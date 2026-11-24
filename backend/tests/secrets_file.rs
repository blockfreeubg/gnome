//! WAVE-D D23: secrets from files (`GNOME_SECRET_KEY_FILE`, `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE` and
//! their TOML keys). Every rule of WAVE-D §6.2, including each refusal.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

use gnome_server::config::{Config, ConfigError, ConfigFile};

const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDE=";
const TOKEN: &str = "an-admin-token-of-some-length";

fn load(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
    let map: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect();
    Config::from_lookup(|k| map.get(k).cloned(), None)
}

fn write(dir: &Path, name: &str, body: &[u8], mode: u32) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    p
}

fn setting(c: &Config, name: &str) -> String {
    c.settings.iter().find(|s| s.name == name).unwrap().value.clone()
}

#[test]
fn values_come_from_files_and_are_never_printed() {
    let dir = tempfile::tempdir().unwrap();
    let key = write(dir.path(), "key", format!("{KEY}\n").as_bytes(), 0o600);
    let token = write(dir.path(), "token", format!("{TOKEN}\r\n").as_bytes(), 0o640);
    let code = write(dir.path(), "code", b"mushroom-forest-42", 0o400);
    let c = load(&[
        ("GNOME_SECRET_KEY_FILE", key.to_str().unwrap()),
        ("GNOME_ADMIN_TOKEN_FILE", token.to_str().unwrap()),
        ("GNOME_ACCESS_CODE_FILE", code.to_str().unwrap()),
        ("GNOME_ACCESS_MODE", "code"),
    ])
    .unwrap();
    assert_eq!(c.secret_key.as_ref().unwrap().expose(), KEY, "one trailing \\n removed");
    assert_eq!(c.admin_token.as_ref().unwrap().expose(), TOKEN, "one trailing \\r\\n removed");
    assert_eq!(c.access_code.as_ref().unwrap().expose(), "mushroom-forest-42");
    assert_eq!(setting(&c, "GNOME_SECRET_KEY"), format!("<redacted> (from file {})", key.display()));
    assert_eq!(setting(&c, "GNOME_ADMIN_TOKEN"), format!("<redacted> (from file {})", token.display()));
    for s in &c.settings {
        assert!(!s.value.contains(TOKEN) && !s.value.contains(KEY), "{} leaks the value", s.name);
    }
    assert!(
        !c.warnings.iter().any(|w| w.contains("other users can read")),
        "0600/0640/0400 are fine: {:?}",
        c.warnings
    );
    assert_eq!(c.secret_files.len(), 3);
}

#[test]
fn every_refusal_names_the_problem() {
    let dir = tempfile::tempdir().unwrap();
    let token = write(dir.path(), "token", TOKEN.as_bytes(), 0o600);
    let t = token.to_str().unwrap();
    let cases: Vec<(Vec<(&str, String)>, &str)> = vec![
        (
            vec![("GNOME_ADMIN_TOKEN", TOKEN.into()), ("GNOME_ADMIN_TOKEN_FILE", t.into())],
            "GNOME_ADMIN_TOKEN and GNOME_ADMIN_TOKEN_FILE are both set",
        ),
        (vec![("GNOME_ADMIN_TOKEN_FILE", "relative/token".into())], "must be an absolute path"),
        (vec![("GNOME_ADMIN_TOKEN_FILE", dir.path().join("missing").display().to_string())], "cannot open"),
        (vec![("GNOME_ADMIN_TOKEN_FILE", dir.path().display().to_string())], "is not a regular file"),
        (
            vec![(
                "GNOME_ADMIN_TOKEN_FILE",
                write(dir.path(), "big", &vec![b'a'; 64 * 1024 + 1], 0o600).display().to_string(),
            )],
            "is larger than 64 KiB",
        ),
        (vec![("GNOME_ADMIN_TOKEN_FILE", write(dir.path(), "empty", b"\n", 0o600).display().to_string())], "is empty"),
        (
            vec![(
                "GNOME_ADMIN_TOKEN_FILE",
                write(dir.path(), "bin", &[0xff, 0xfe, b'a'], 0o600).display().to_string(),
            )],
            "is not UTF-8",
        ),
        // Whitespace inside the value.
        (
            vec![(
                "GNOME_ADMIN_TOKEN_FILE",
                write(dir.path(), "ws", b"an admin token with spaces", 0o600).display().to_string(),
            )],
            "GNOME_ADMIN_TOKEN: must not contain whitespace",
        ),
        // The value passes the variable's own validation.
        (
            vec![("GNOME_ADMIN_TOKEN_FILE", write(dir.path(), "short", b"short", 0o600).display().to_string())],
            "GNOME_ADMIN_TOKEN: must be at least 16 characters",
        ),
        (
            vec![("GNOME_SECRET_KEY_FILE", write(dir.path(), "badkey", b"not base64!", 0o600).display().to_string())],
            "GNOME_SECRET_KEY",
        ),
        (
            vec![("GNOME_ACCESS_CODE_FILE", write(dir.path(), "c", b"abc", 0o600).display().to_string())],
            "GNOME_ACCESS_CODE: must be at least 4 characters",
        ),
    ];
    for (vars, needle) in cases {
        let refs: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let Err(err) = load(&refs) else { panic!("accepted: {needle}") };
        let err = err.to_string();
        assert!(err.contains(needle), "{needle}: {err}");
        assert!(!err.contains(TOKEN), "the value is never printed: {err}");
    }
    // Exactly one trailing newline is removed.
    let two = write(dir.path(), "two", b"abc\n\n", 0o600);
    assert_eq!(gnome_server::config::read_secret_file(&two).unwrap().0, "abc\n");
    let crlf = write(dir.path(), "crlf", b"abc\r\n", 0o600);
    assert_eq!(gnome_server::config::read_secret_file(&crlf).unwrap().0, "abc");
    // An unreadable file (mode 000; not meaningful as root).
    if !nix_is_root() {
        let locked = write(dir.path(), "locked", TOKEN.as_bytes(), 0o000);
        let err = load(&[("GNOME_ADMIN_TOKEN_FILE", locked.to_str().unwrap())]).unwrap_err().to_string();
        assert!(err.contains("cannot open") && err.contains("init-secrets.sh"), "{err}");
    }
}

fn nix_is_root() -> bool {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Uid:")).map(|l| l.split_whitespace().nth(1) == Some("0")))
        .unwrap_or(false)
}

#[test]
fn empty_file_variables_count_as_unset_and_world_readable_files_warn() {
    let c = load(&[("GNOME_ADMIN_TOKEN_FILE", ""), ("GNOME_SECRET_KEY_FILE", "  ")]).unwrap();
    assert!(c.admin_token.is_none() && c.secret_key.is_none() && c.secret_files.is_empty());
    let dir = tempfile::tempdir().unwrap();
    let open = write(dir.path(), "token", TOKEN.as_bytes(), 0o644);
    let c = load(&[("GNOME_ADMIN_TOKEN_FILE", open.to_str().unwrap())]).unwrap();
    assert!(c.warnings.iter().any(|w| w.contains("other users can read this file")), "{:?}", c.warnings);
    assert_eq!(c.admin_token.unwrap().expose(), TOKEN);
}

#[test]
fn toml_keys_work_the_same() {
    let dir = tempfile::tempdir().unwrap();
    let token = write(dir.path(), "token", TOKEN.as_bytes(), 0o600);
    let file =
        ConfigFile::parse(Path::new("gnome.toml"), &format!("admin_token_file = {:?}\n", token.display().to_string()))
            .unwrap();
    let c = Config::from_lookup(|_| None, Some(file)).unwrap();
    assert_eq!(c.admin_token.unwrap().expose(), TOKEN);
    // A TOML file and an environment variable for the same secret: both set.
    let file =
        ConfigFile::parse(Path::new("gnome.toml"), &format!("admin_token_file = {:?}\n", token.display().to_string()))
            .unwrap();
    let err = Config::from_lookup(|k| (k == "GNOME_ADMIN_TOKEN").then(|| TOKEN.to_string()), Some(file)).unwrap_err();
    assert!(err.to_string().contains("are both set"), "{err}");
}

#[test]
fn plain_secrets_under_systemd_warn() {
    let dir = tempfile::tempdir().unwrap();
    let token = write(dir.path(), "token", TOKEN.as_bytes(), 0o600);
    let c = load(&[("GNOME_ADMIN_TOKEN", TOKEN), ("INVOCATION_ID", "abc")]).unwrap();
    assert!(
        c.warnings.iter().any(|w| w.contains("GNOME_ADMIN_TOKEN is set as a plain variable under systemd")),
        "{:?}",
        c.warnings
    );
    let c = load(&[("GNOME_ADMIN_TOKEN_FILE", token.to_str().unwrap()), ("INVOCATION_ID", "abc")]).unwrap();
    assert!(!c.warnings.iter().any(|w| w.contains("plain variable")), "{:?}", c.warnings);
    let c = load(&[("GNOME_ADMIN_TOKEN", TOKEN)]).unwrap();
    assert!(!c.warnings.iter().any(|w| w.contains("plain variable")), "not under systemd");
}

#[test]
fn m1_settings_defaults_ranges_and_warnings() {
    let c = load(&[]).unwrap();
    assert_eq!(
        (c.max_connections, c.max_conns_per_ip, c.max_inflight_per_ip, c.max_inflight_head_mb),
        (4096, 256, 256, 64)
    );
    assert_eq!((c.sync_quota_mb, c.sync_total_mb, c.cookie_hygiene.as_str()), (64, 1024, "app"));
    assert!(c.warnings.iter().any(|w| w.starts_with("GNOME_SOURCE_URL is empty")), "0.0.0.0 bind: {:?}", c.warnings);
    assert!(c.warnings.iter().any(|w| w.starts_with("GNOME_REGISTRATION=open")));
    let quiet = load(&[("GNOME_BIND", "127.0.0.1:10100"), ("GNOME_REGISTRATION", "closed")]).unwrap();
    assert!(
        !quiet.warnings.iter().any(|w| w.starts_with("GNOME_SOURCE_URL") || w.starts_with("GNOME_REGISTRATION")),
        "{:?}",
        quiet.warnings
    );
    let https = load(&[("GNOME_PUBLIC_ORIGINS", "https://gnome.example")]).unwrap();
    assert!(https.warnings.iter().any(|w| w.contains("GNOME_HSTS=false")));
    assert!(
        !load(&[("GNOME_PUBLIC_ORIGINS", "https://gnome.example"), ("GNOME_HSTS", "true")])
            .unwrap()
            .warnings
            .iter()
            .any(|w| w.contains("GNOME_HSTS=false"))
    );
    assert_eq!(load(&[("GNOME_MAX_CONNECTIONS", "100")]).unwrap().max_conns_per_ip, 100, "the default follows the cap");
    for (vars, needle) in [
        (vec![("GNOME_MAX_CONNECTIONS", "15")], "GNOME_MAX_CONNECTIONS"),
        (vec![("GNOME_MAX_CONNECTIONS", "1000001")], "GNOME_MAX_CONNECTIONS"),
        (vec![("GNOME_MAX_CONNS_PER_IP", "0")], "GNOME_MAX_CONNS_PER_IP"),
        (
            vec![("GNOME_MAX_CONNECTIONS", "100"), ("GNOME_MAX_CONNS_PER_IP", "101")],
            "is larger than GNOME_MAX_CONNECTIONS",
        ),
        (vec![("GNOME_MAX_INFLIGHT_PER_IP", "65537")], "GNOME_MAX_INFLIGHT_PER_IP"),
        (vec![("GNOME_MAX_INFLIGHT_HEAD_MB", "3")], "GNOME_MAX_INFLIGHT_HEAD_MB"),
        (vec![("GNOME_SYNC_QUOTA_MB", "0")], "GNOME_SYNC_QUOTA_MB"),
        (vec![("GNOME_SYNC_TOTAL_MB", "15")], "GNOME_SYNC_TOTAL_MB"),
        (vec![("GNOME_SYNC_QUOTA_MB", "100"), ("GNOME_SYNC_TOTAL_MB", "99")], "is smaller than GNOME_SYNC_QUOTA_MB"),
        (vec![("GNOME_COOKIE_HYGIENE", "everything")], "expected app or registrable"),
    ] {
        let Err(err) = load(&vars) else { panic!("accepted: {needle}") };
        let err = err.to_string();
        assert!(err.contains(needle), "{needle}: {err}");
    }
    assert_eq!(load(&[("GNOME_COOKIE_HYGIENE", "Registrable")]).unwrap().cookie_hygiene.as_str(), "registrable");
}
