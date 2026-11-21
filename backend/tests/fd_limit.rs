//! The real `gnome-server` binary and `RLIMIT_NOFILE` (Linux): startup raises the soft limit to the hard limit and
//! logs it once; `/admin/diagnostics` reports both; at a low hard limit the server warns and keeps running, and when
//! it runs out of descriptors the accept loop backs off (no busy loop) and recovers once descriptors free up.
//!
//! Limits are lowered for the child only (`ulimit` in `sh` before `exec`); nothing here needs privileges.
#![cfg(target_os = "linux")]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_gnome-server");

/// A running server whose stderr (JSON logs) is collected line by line.
struct Server {
    child: Child,
    logs: Arc<Mutex<Vec<Value>>>,
    _dir: tempfile::TempDir,
}

impl Server {
    /// Start with `ulimit_sh` (e.g. `ulimit -S -n 256`) applied to the child shell first.
    fn start(ulimit_sh: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("{ulimit_sh} && exec \"$0\"")).arg(BIN);
        cmd.env_clear()
            .env("GNOME_DATA_DIR", dir.path().join("data"))
            .env("GNOME_STATIC_DIR", dir.path().join("static"))
            .env("GNOME_BIND", "127.0.0.1:0")
            // Another loopback address: two `:0` binds on one address are refused as a collision.
            .env("GNOME_ADMIN_BIND", "127.0.0.2:0")
            .env("GNOME_ARGON2_MEMORY_KIB", "1024")
            .env("GNOME_WORKERS", "2")
            .env("GNOME_DB_READERS", "1")
            .env("GNOME_LOG", "info")
            .env("GNOME_LOG_FORMAT", "json")
            .env("GNOME_WISP_UPSTREAM", "127.0.0.1:9")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("server starts");
        let logs = Arc::new(Mutex::new(Vec::new()));
        let sink = logs.clone();
        let stderr = child.stderr.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let v = serde_json::from_str(&line).unwrap_or(Value::String(line));
                sink.lock().unwrap().push(v);
            }
        });
        Self { child, logs, _dir: dir }
    }

    fn messages(&self, needle: &str) -> Vec<Value> {
        self.logs
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["fields"]["message"].as_str().is_some_and(|m| m.contains(needle)))
            .cloned()
            .collect()
    }

    fn wait_for(&mut self, needle: &str) -> Value {
        let start = Instant::now();
        loop {
            if let Some(v) = self.messages(needle).into_iter().next() {
                return v;
            }
            let exited = self.child.try_wait().ok().flatten().is_some();
            assert!(
                !exited && start.elapsed() < Duration::from_secs(30),
                "no {needle:?} log line (exited: {exited}): {:?}",
                self.logs.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn addr(&mut self, listener: &str) -> SocketAddr {
        self.wait_for(&format!("{listener} listener ready"))["fields"]["addr"].as_str().unwrap().parse().unwrap()
    }

    /// `(soft, hard)` from `/proc/<pid>/limits`.
    fn limits(&self) -> (String, String) {
        let text = std::fs::read_to_string(format!("/proc/{}/limits", self.child.id())).unwrap();
        let line = text.lines().find(|l| l.starts_with("Max open files")).unwrap().to_string();
        let cols: Vec<&str> = line.split_whitespace().collect();
        (cols[3].to_string(), cols[4].to_string())
    }

    /// User + system CPU time of the server in clock ticks.
    fn cpu_ticks(&self) -> u64 {
        let stat = std::fs::read_to_string(format!("/proc/{}/stat", self.child.id())).unwrap();
        let rest = stat.rsplit_once(')').unwrap().1;
        let f: Vec<&str> = rest.split_whitespace().collect();
        // Fields after the command: state is index 0, so utime (14) and stime (15) are 11 and 12.
        f[11].parse::<u64>().unwrap() + f[12].parse::<u64>().unwrap()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn get(addr: SocketAddr, path: &str) -> Option<(u16, String)> {
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    let status = out.split(' ').nth(1)?.parse().ok()?;
    Some((status, out.split_once("\r\n\r\n").map_or(String::new(), |(_, b)| b.to_string())))
}

fn hard_limit() -> String {
    let text = std::fs::read_to_string("/proc/self/limits").unwrap();
    let line = text.lines().find(|l| l.starts_with("Max open files")).unwrap().to_string();
    line.split_whitespace().nth(4).unwrap().to_string()
}

#[test]
fn startup_raises_the_soft_limit_to_the_hard_limit_and_reports_both() {
    let hard = hard_limit();
    let expected: u64 = if hard == "unlimited" { 1 << 20 } else { hard.parse::<u64>().unwrap().min(1 << 20) };
    if expected <= 256 {
        eprintln!("skipped: the hard limit here ({hard}) leaves nothing to raise");
        return;
    }
    let mut server = Server::start("ulimit -S -n 256");
    let line = server.wait_for("file descriptor limit raised");
    assert_eq!(line["level"], "INFO", "{line}");
    assert_eq!(line["fields"]["before"], "256", "{line}");
    assert_eq!(line["fields"]["after"], expected.to_string(), "{line}");
    let admin = server.addr("admin");
    assert_eq!(server.limits(), (expected.to_string(), hard.clone()), "the hard limit is untouched");
    assert_eq!(server.messages("file descriptor limit").len(), 1, "logged once");

    let (status, body) = get(admin, "/admin/diagnostics").expect("diagnostics answer");
    assert_eq!(status, 200, "{body}");
    let d: Value = serde_json::from_str(&body).unwrap();
    let fd = &d["fd_limit"];
    assert_eq!(fd["soft"], expected, "{fd}");
    assert_eq!(fd["startup"]["before_soft"], 256, "{fd}");
    assert_eq!(fd["startup"]["soft"], expected, "{fd}");
    assert_eq!(fd["startup"]["raised"], true, "{fd}");
    assert_eq!(fd["startup"]["error"], Value::Null, "{fd}");
    assert!(fd["open"].as_u64().is_some_and(|n| n > 3), "{fd}");
    let (_, metrics) = get(admin, "/admin/metrics").unwrap();
    assert!(metrics.contains(&format!("\nprocess_max_fds {expected}\n")), "{metrics}");
    assert!(metrics.contains("\nprocess_open_fds "), "{metrics}");
}

#[test]
fn at_a_low_hard_limit_it_warns_runs_and_backs_off_when_out_of_descriptors() {
    const LIMIT: usize = 64;
    let mut server = Server::start(&format!("ulimit -S -n {LIMIT} && ulimit -H -n {LIMIT}"));
    let unchanged = server.wait_for("file descriptor limit unchanged");
    assert_eq!(unchanged["fields"]["soft"], LIMIT.to_string(), "{unchanged}");
    let low = server.wait_for("concurrent Wisp connections");
    assert_eq!(low["level"], "WARN", "{low}");
    let public = server.addr("public");
    assert_eq!(get(public, "/api/health").map(|r| r.0), Some(200), "serving with the low limit");

    // Hold idle connections until the server runs out of descriptors; the rest wait in the listen backlog.
    let mut held = Vec::new();
    for _ in 0..LIMIT + 16 {
        held.push(TcpStream::connect_timeout(&public, Duration::from_secs(5)).unwrap());
    }
    let failed = server.wait_for("accept failed; backing off");
    assert_eq!(failed["level"], "WARN", "{failed}");
    // While starved the server must not spin on accept(): a busy loop would burn ~1 CPU second here.
    let before = server.cpu_ticks();
    std::thread::sleep(Duration::from_millis(1500));
    let used = server.cpu_ticks() - before;
    assert!(used < 30, "accept loop used {used} ticks in 1.5 s while out of descriptors");
    assert_eq!(server.messages("accept failed").len(), 1, "the warning is rate-limited");

    // Descriptors come back: the server recovers on its own.
    drop(held);
    let start = Instant::now();
    loop {
        if get(public, "/api/health").is_some_and(|r| r.0 == 200) {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "the server did not recover");
        std::thread::sleep(Duration::from_millis(100));
    }
}
