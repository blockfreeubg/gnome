//! gnome-bench: the load generator of `bench/run.mjs` (docs/WAVE-D.md §3.1). Every mode prints one JSON line.
//!
//!   gnome-bench echo --listen 127.0.0.1:P            counting echo: first byte E = echo, S = sink, Q = report count
//!   gnome-bench wisp tp|rtt|churn|open|idle|sha [--url ws://… | --ticket-api http://…] --target 127.0.0.1:E …
//!   gnome-bench http --url http://… [-H 'K: V']… [--method M] [-c N] [--rate R] [--duration S] [--warmup S]
//!   gnome-bench fadvise <paths…>                     posix_fadvise(DONTNEED) on files (directories recursively)
mod hist;
mod http;
mod wisp;
mod ws;

use hist::Hist;
use sha2::{Digest, Sha256};
use socket2::{Domain, Socket, Type};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wisp::{Conn, Target};

struct Args {
    pos: Vec<String>,
    opt: HashMap<String, Vec<String>>,
}

impl Args {
    fn parse() -> Args {
        let mut pos = Vec::new();
        let mut opt: HashMap<String, Vec<String>> = HashMap::new();
        let mut it = std::env::args().skip(1);
        while let Some(a) = it.next() {
            if let Some(k) = a.strip_prefix("--").or_else(|| a.strip_prefix('-').filter(|k| k.len() == 1)) {
                let v = it.next().unwrap_or_default();
                opt.entry(k.to_string()).or_default().push(v);
            } else {
                pos.push(a);
            }
        }
        Args { pos, opt }
    }
    fn s(&self, k: &str) -> Option<&str> {
        self.opt.get(k).and_then(|v| v.last()).map(String::as_str)
    }
    fn f(&self, k: &str, d: f64) -> f64 {
        self.s(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn u(&self, k: &str, d: usize) -> usize {
        self.s(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn all(&self, k: &str) -> Vec<String> {
        self.opt.get(k).cloned().unwrap_or_default()
    }
}

fn cpu_s() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
    t(ru.ru_utime) + t(ru.ru_stime)
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("gnome-bench: {msg}");
    std::process::exit(2)
}

fn main() {
    let a = Args::parse();
    match a.pos.first().map(String::as_str) {
        Some("echo") => echo(&a),
        Some("wisp") => wisp_mode(&a),
        Some("http") => http_mode(&a),
        Some("fadvise") => fadvise(&a.pos[1..]),
        _ => die("usage: gnome-bench echo|wisp|http|fadvise … (see src/main.rs)"),
    }
}

// ── echo ─────────────────────────────────────────────────────────────────────────────────────────────────────────

fn echo(a: &Args) {
    let addr = a.s("listen").unwrap_or_else(|| die("--listen 127.0.0.1:PORT"));
    let l = TcpListener::bind(addr).unwrap_or_else(|e| die(format!("bind {addr}: {e}")));
    if !l.local_addr().unwrap().ip().is_loopback() {
        die("the echo target listens on loopback only");
    }
    eprintln!("echo listening on {addr}");
    let sunk = Arc::new(AtomicU64::new(0));
    for s in l.incoming() {
        let Ok(mut s) = s else { continue };
        let sunk = sunk.clone();
        let _ = std::thread::Builder::new().stack_size(64 << 10).spawn(move || {
            let _ = s.set_nodelay(true);
            let mut buf = vec![0u8; 64 << 10];
            let Ok(n) = s.read(&mut buf) else { return };
            if n == 0 {
                return;
            }
            match buf[0] {
                b'Q' => {
                    let _ = s.write_all(sunk.load(Ordering::Relaxed).to_string().as_bytes());
                }
                b'S' => {
                    sunk.fetch_add(n as u64 - 1, Ordering::Relaxed);
                    while let Ok(n) = s.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        sunk.fetch_add(n as u64, Ordering::Relaxed);
                    }
                }
                _ => {
                    let mut n = n;
                    loop {
                        if s.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        n = match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => n,
                        };
                    }
                }
            }
        });
    }
}

fn sink_count(target: SocketAddr) -> u64 {
    let mut s = TcpStream::connect(target).unwrap_or_else(|e| die(format!("echo control: {e}")));
    s.write_all(b"Q").unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.trim().parse().unwrap_or(0)
}

// ── wisp ─────────────────────────────────────────────────────────────────────────────────────────────────────────

struct WispCfg {
    target: Target,
    echo: SocketAddr,
    query: String,
    probe: bool,
    sources: usize,
    errors: Mutex<HashMap<String, u64>>,
}

impl WispCfg {
    fn err(&self, e: &io::Error) {
        let mut k = e.to_string();
        k.truncate(80);
        *self.errors.lock().unwrap().entry(k).or_insert(0) += 1;
    }
    fn errors_json(&self) -> String {
        let e = self.errors.lock().unwrap();
        let parts: Vec<String> = e.iter().map(|(k, v)| format!("{}:{v}", json_str(k))).collect();
        format!("{{{}}}", parts.join(","))
    }
    fn tcp(&self, i: usize) -> io::Result<TcpStream> {
        let sock = Socket::new(Domain::IPV4, Type::STREAM, None)?;
        if self.sources > 1 {
            let src: SocketAddr = format!("127.0.0.{}:0", 2 + i % self.sources).parse().unwrap();
            sock.bind(&src.into())?;
        }
        sock.connect_timeout(&self.target.addr.into(), Duration::from_secs(10))?;
        Ok(sock.into())
    }
    fn open(&self, i: usize, deliver: bool) -> io::Result<Conn> {
        let s = self.tcp(i)?;
        let t = Target {
            addr: self.target.addr,
            host: self.target.host.clone(),
            path: format!("{}{}", self.target.path, self.query),
            origin: self.target.origin.clone(),
        };
        Conn::open(s, &t, deliver)
    }
    fn echo_host(&self) -> (String, u16) {
        (self.echo.ip().to_string(), self.echo.port())
    }
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn wisp_cfg(a: &Args) -> WispCfg {
    let echo: SocketAddr = a.s("target").unwrap_or_else(|| die("--target 127.0.0.1:PORT")).parse().unwrap_or_else(|e| die(e));
    let (url, query, origin, probe) = if let Some(api) = a.s("ticket-api") {
        let (ticket, wisp_url, _) = http::mint_ticket(api, None).unwrap_or_else(|e| die(e));
        let (hp, _) = http::split_url(&wisp_url).unwrap();
        let scheme = if wisp_url.starts_with("wss:") { "https" } else { "http" };
        (wisp_url.clone(), format!("?t={ticket}&/"), Some(a.s("origin").map_or(format!("{scheme}://{hp}"), str::to_string)), true)
    } else {
        let url = a.s("url").unwrap_or_else(|| die("--url ws://127.0.0.1:P/ or --ticket-api http://…")).to_string();
        (url, String::new(), a.s("origin").map(str::to_string), false)
    };
    let (hp, path) = http::split_url(&url).unwrap_or_else(|| die("bad URL"));
    let addr: SocketAddr = hp.parse().unwrap_or_else(|_| die(format!("{hp}: use a literal 127.0.0.x:port")));
    if !addr.ip().is_loopback() || !echo.ip().is_loopback() {
        die("benchmarks run on loopback only");
    }
    WispCfg {
        target: Target { addr, host: hp, path, origin },
        echo,
        query,
        probe,
        sources: a.u("sources", 1),
        errors: Mutex::new(HashMap::new()),
    }
}

fn wisp_mode(a: &Args) {
    let mode = a.pos.get(1).map(String::as_str).unwrap_or("");
    let cfg = Arc::new(wisp_cfg(a));
    let warm = a.f("warmup", 1.0);
    let dur = a.f("duration", 5.0);
    let t0 = Instant::now();
    match mode {
        "tp" => tp(a, cfg, warm, dur),
        "rtt" => rtt(cfg, warm, dur),
        "churn" | "open" => churn(a, cfg, mode == "open", warm, dur),
        "idle" => idle(a, cfg),
        "sha" => sha(a, cfg),
        _ => die("wisp mode: tp|rtt|churn|open|idle|sha"),
    }
    let _ = t0;
}

fn tp(a: &Args, cfg: Arc<WispCfg>, warm: f64, dur: f64) {
    let conns = a.u("conns", 1);
    let streams = a.u("streams", 1);
    let size = a.u("packet", 32 << 10);
    let stop = Arc::new(AtomicBool::new(false));
    let opened = Arc::new(AtomicU64::new(0));
    let mut hs = Vec::new();
    for i in 0..conns {
        let (cfg, stop, opened) = (cfg.clone(), stop.clone(), opened.clone());
        hs.push(std::thread::Builder::new().stack_size(256 << 10).spawn(move || {
            let mut c = match cfg.open(i, false) {
                Ok(c) => c,
                Err(e) => return cfg.err(&e),
            };
            let (h, p) = cfg.echo_host();
            let mut ids = Vec::new();
            for _ in 0..streams {
                match c.connect(&h, p) {
                    Ok(id) => ids.push(id),
                    Err(e) => return cfg.err(&e),
                }
            }
            let mut payload = vec![0x5au8; size];
            payload[0] = b'S';
            for id in &ids {
                if let Err(e) = c.data(*id, &payload) {
                    return cfg.err(&e);
                }
            }
            payload[0] = 0x5a;
            opened.fetch_add(1, Ordering::Relaxed);
            'run: while !stop.load(Ordering::Relaxed) {
                for id in &ids {
                    if let Err(e) = c.data(*id, &payload) {
                        if !stop.load(Ordering::Relaxed) {
                            cfg.err(&e);
                        }
                        break 'run;
                    }
                }
            }
            c.shutdown();
        }).unwrap());
    }
    let start = Instant::now();
    std::thread::sleep(Duration::from_secs_f64(warm));
    let c0 = sink_count(cfg.echo);
    let cpu0 = cpu_s();
    let t1 = Instant::now();
    std::thread::sleep(Duration::from_secs_f64(dur));
    let c1 = sink_count(cfg.echo);
    let secs = t1.elapsed().as_secs_f64();
    let cpu = cpu_s() - cpu0;
    stop.store(true, Ordering::Relaxed);
    let _ = start;
    // Writers blocked on credit wake up at most 30 s later; the harness only needs the line below.
    println!(
        "{{\"mode\":\"tp\",\"conns\":{conns},\"streams\":{streams},\"opened\":{},\"bytes\":{},\"secs\":{secs:.3},\"mib_s\":{:.2},\"loadgen_cpu_s\":{cpu:.3},\"errors\":{}}}",
        opened.load(Ordering::Relaxed),
        c1 - c0,
        (c1 - c0) as f64 / secs / 1048576.0,
        cfg.errors_json()
    );
    io::stdout().flush().ok();
    std::process::exit(0);
}

fn rtt(cfg: Arc<WispCfg>, warm: f64, dur: f64) {
    let mut c = cfg.open(0, true).unwrap_or_else(|e| die(e));
    let (h, p) = cfg.echo_host();
    let id = c.connect(&h, p).unwrap_or_else(|e| die(e));
    let mut buf = Vec::new();
    c.data(id, b"E").unwrap_or_else(|e| die(e));
    c.recv_exact(id, 1, Duration::from_secs(10), &mut buf).unwrap_or_else(|e| die(e));
    let ping = [0x42u8; 64];
    let mut hist = Hist::default();
    let start = Instant::now();
    let (mut ops, mut cpu0, mut t_meas) = (0u64, 0.0, None);
    loop {
        let el = start.elapsed().as_secs_f64();
        if el >= warm + dur {
            break;
        }
        if el >= warm && t_meas.is_none() {
            t_meas = Some(Instant::now());
            cpu0 = cpu_s();
        }
        let t = Instant::now();
        if let Err(e) = c.data(id, &ping).and_then(|_| c.recv_exact(id, 64, Duration::from_secs(10), &mut buf)) {
            cfg.err(&e);
            break;
        }
        if t_meas.is_some() {
            hist.record(t.elapsed().as_nanos() as u64);
            ops += 1;
        }
    }
    let secs = t_meas.map_or(0.0, |t| t.elapsed().as_secs_f64());
    print_latency("rtt", ops, secs, cpu_s() - cpu0, &hist, &cfg.errors_json(), "");
    std::process::exit(0);
}

fn print_latency(mode: &str, ops: u64, secs: f64, cpu: f64, h: &Hist, errors: &str, extra: &str) {
    println!(
        "{{\"mode\":\"{mode}\",\"ops\":{ops},\"secs\":{secs:.3},\"ops_s\":{:.1},\"p50_us\":{:.1},\"p99_us\":{:.1},\"p999_us\":{:.1},\"max_us\":{:.1},\"loadgen_cpu_s\":{cpu:.3},\"hist_ns\":{},\"errors\":{errors}{extra}}}",
        if secs > 0.0 { ops as f64 / secs } else { 0.0 },
        h.quantile(0.5) as f64 / 1e3,
        h.quantile(0.99) as f64 / 1e3,
        h.quantile(0.999) as f64 / 1e3,
        h.quantile(1.0) as f64 / 1e3,
        h.to_json()
    );
    io::stdout().flush().ok();
}

/// W3: (a) `churn`: [ticket probe +] upgrade + CONNECT + 1-byte echo + close, `--inflight` at once, each on a new
/// connection from `--sources` addresses; (b) `open`: stream open/close inside one connection per worker.
fn churn(a: &Args, cfg: Arc<WispCfg>, streams_only: bool, warm: f64, dur: f64) {
    let inflight = a.u("inflight", 32);
    let start = Instant::now();
    let measuring = Arc::new(AtomicBool::new(false));
    let hist = Arc::new(Mutex::new(Hist::default()));
    let ops = Arc::new(AtomicU64::new(0));
    let mut hs = Vec::new();
    for i in 0..inflight {
        let (cfg, measuring, hist, ops) = (cfg.clone(), measuring.clone(), hist.clone(), ops.clone());
        hs.push(std::thread::spawn(move || {
            let mut local = Hist::default();
            let (h, p) = cfg.echo_host();
            let mut buf = Vec::new();
            let mut probe_client: Option<http::Client> = None;
            let mut kept: Option<Conn> = None;
            let mut n = i;
            while start.elapsed().as_secs_f64() < warm + dur {
                let t = Instant::now();
                let r = (|| -> io::Result<()> {
                    if streams_only {
                        if kept.is_none() {
                            kept = Some(cfg.open(i, true)?);
                        }
                        let c = kept.as_mut().unwrap();
                        let id = c.connect(&h, p)?;
                        c.data(id, b"E")?;
                        c.recv_exact(id, 1, Duration::from_secs(10), &mut buf)?;
                        return c.close(id);
                    }
                    if cfg.probe {
                        if probe_client.is_none() {
                            probe_client = Some(http::Client::new(cfg.tcp(n)?)?);
                        }
                        let pc = probe_client.as_mut().unwrap();
                        let path = format!("{}{}", cfg.target.path, cfg.query);
                        pc.send(&http::build_request("GET", &path, &cfg.target.host, &[], b""))?;
                        let r = pc.recv(false, false);
                        match r {
                            Ok(r) if r.status == 426 => {}
                            Ok(r) => return Err(io::Error::other(format!("probe: HTTP {}", r.status))),
                            Err(e) => {
                                probe_client = None;
                                return Err(e);
                            }
                        }
                    }
                    let mut c = cfg.open(n, true)?;
                    let id = c.connect(&h, p)?;
                    c.data(id, b"E")?;
                    c.recv_exact(id, 1, Duration::from_secs(10), &mut buf)?;
                    c.close(id)?;
                    c.shutdown();
                    Ok(())
                })();
                n += inflight;
                match r {
                    Ok(()) if measuring.load(Ordering::Relaxed) => {
                        local.record(t.elapsed().as_nanos() as u64);
                        ops.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(()) => {}
                    Err(e) => {
                        if measuring.load(Ordering::Relaxed) {
                            cfg.err(&e);
                        }
                        kept = None;
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
            hist.lock().unwrap().merge(&local);
        }));
    }
    std::thread::sleep(Duration::from_secs_f64(warm));
    let cpu0 = cpu_s();
    let t1 = Instant::now();
    measuring.store(true, Ordering::Relaxed);
    for h in hs {
        let _ = h.join();
    }
    let secs = t1.elapsed().as_secs_f64();
    let h = hist.lock().unwrap().clone();
    print_latency(if streams_only { "open" } else { "churn" }, ops.load(Ordering::Relaxed), secs, cpu_s() - cpu0, &h, &cfg.errors_json(), "");
    std::process::exit(0);
}

/// W4: hold `--conns` idle connections (one idle stream each to the sink), print `ready` on stderr, wait `--hold`
/// seconds, then let `--active` of them send `--rate-kib` KiB/s each for `--duration` seconds.
fn idle(a: &Args, cfg: Arc<WispCfg>) {
    let n = a.u("conns", 1000);
    let active = a.u("active", 1000).min(n);
    let rate = a.f("rate-kib", 128.0);
    let hold = a.f("hold", 5.0);
    let dur = a.f("duration", 20.0);
    let ramp = a.u("ramp", 64);
    let conns: Arc<Mutex<Vec<(Conn, u32)>>> = Arc::new(Mutex::new(Vec::new()));
    let t_open = Instant::now();
    let next = Arc::new(AtomicU64::new(0));
    let mut hs = Vec::new();
    for _ in 0..ramp.min(n) {
        let (cfg, conns, next) = (cfg.clone(), conns.clone(), next.clone());
        hs.push(std::thread::spawn(move || {
            let (h, p) = cfg.echo_host();
            loop {
                let i = next.fetch_add(1, Ordering::Relaxed) as usize;
                if i >= n {
                    break;
                }
                let r = (|| -> io::Result<(Conn, u32)> {
                    let mut c = cfg.open(i, false)?;
                    let id = c.connect(&h, p)?;
                    c.data(id, b"S")?;
                    Ok((c, id))
                })();
                match r {
                    Ok(x) => conns.lock().unwrap().push(x),
                    Err(e) => cfg.err(&e),
                }
            }
        }));
    }
    for h in hs {
        let _ = h.join();
    }
    let held = conns.lock().unwrap().len();
    eprintln!("ready {held}");
    let open_s = t_open.elapsed().as_secs_f64();
    std::thread::sleep(Duration::from_secs_f64(hold));
    let c0 = sink_count(cfg.echo);
    eprintln!("active {active}");
    let all: Vec<(Conn, u32)> = std::mem::take(&mut *conns.lock().unwrap());
    let mut it = all.into_iter();
    let mut idle_rest = Vec::new();
    let mut hs = Vec::new();
    let t1 = Instant::now();
    for k in 0..held {
        let Some((mut c, id)) = it.next() else { break };
        if k >= active {
            idle_rest.push(c);
            continue;
        }
        let cfg = cfg.clone();
        hs.push(std::thread::Builder::new().stack_size(128 << 10).spawn(move || {
            let chunk = vec![0x5au8; 16 << 10];
            let per = Duration::from_secs_f64(16.0 / rate);
            let start = Instant::now();
            let mut k = 0u32;
            while start.elapsed().as_secs_f64() < dur {
                if let Err(e) = c.data(id, &chunk) {
                    cfg.err(&e);
                    break;
                }
                k += 1;
                let due = start + per * k;
                if let Some(w) = due.checked_duration_since(Instant::now()) {
                    std::thread::sleep(w);
                }
            }
            c
        }).unwrap());
    }
    let mut back = Vec::new();
    for h in hs {
        if let Ok(c) = h.join() {
            back.push(c);
        }
    }
    let secs = t1.elapsed().as_secs_f64();
    let c1 = sink_count(cfg.echo);
    eprintln!("done");
    println!(
        "{{\"mode\":\"idle\",\"conns\":{n},\"held\":{held},\"open_s\":{open_s:.2},\"active\":{active},\"bytes\":{},\"secs\":{secs:.2},\"mib_s\":{:.2},\"loadgen_cpu_s\":{:.3},\"errors\":{}}}",
        c1 - c0,
        (c1 - c0) as f64 / secs / 1048576.0,
        cpu_s(),
        cfg.errors_json()
    );
    io::stdout().flush().ok();
    drop(idle_rest);
    drop(back);
    std::process::exit(0);
}

/// The equivalence check's payload: `--bytes` of seeded pseudo-random data through one stream to the echo;
/// prints the SHA-256 of what was sent and of what came back.
fn sha(a: &Args, cfg: Arc<WispCfg>) {
    let total = a.u("bytes", 64 << 20);
    let c = cfg.open(0, true).unwrap_or_else(|e| die(e));
    let Conn { mut tx, events } = c;
    let (h, p) = cfg.echo_host();
    let id = tx.connect(&h, p).unwrap_or_else(|e| die(e));
    let writer = std::thread::spawn(move || -> io::Result<[u8; 32]> {
        let mut hasher = Sha256::new();
        tx.data(id, b"E")?;
        let mut x: u64 = 0x243f_6a88_85a3_08d3;
        let mut sent = 0;
        let mut chunk = vec![0u8; 32 << 10];
        while sent < total {
            let n = (total - sent).min(chunk.len());
            for w in chunk[..n].chunks_mut(8) {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let b = x.to_le_bytes();
                w.copy_from_slice(&b[..w.len()]);
            }
            hasher.update(&chunk[..n]);
            tx.data(id, &chunk[..n])?;
            sent += n;
        }
        Ok(hasher.finalize().into())
    });
    let mut hasher = Sha256::new();
    let mut got = 0usize;
    let mut first = true;
    let t = Instant::now();
    while got < total {
        match events.recv_timeout(Duration::from_secs(20)) {
            Ok(wisp::Event::Data(s, mut d)) if s == id => {
                if first && !d.is_empty() {
                    d.remove(0);
                    first = false;
                }
                got += d.len();
                hasher.update(&d);
            }
            Ok(wisp::Event::Close(s, r)) if s == id => die(format!("stream closed after {got} bytes (reason {r:#x})")),
            Ok(_) => {}
            Err(_) => die(format!("echo stalled after {got} bytes")),
        }
    }
    let sent = writer.join().unwrap().unwrap_or_else(|e| die(e));
    let back: [u8; 32] = hasher.finalize().into();
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    println!(
        "{{\"mode\":\"sha\",\"bytes\":{total},\"secs\":{:.3},\"sent_sha256\":\"{}\",\"echo_sha256\":\"{}\",\"equal\":{}}}",
        t.elapsed().as_secs_f64(),
        hex(&sent),
        hex(&back),
        sent == back
    );
    std::process::exit(0);
}

// ── http ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Closed loop (`-c` keep-alive connections) or, with `--rate R`, a fixed R req/s spread over the connections with
/// latency measured from each request's scheduled time (coordinated-omission corrected, like `oha --latency-correction`).
fn http_mode(a: &Args) {
    let url = a.s("url").unwrap_or_else(|| die("--url http://127.0.0.1:P/path"));
    let (hp, path) = http::split_url(url).unwrap_or_else(|| die("bad URL"));
    let addr: SocketAddr = hp.parse().unwrap_or_else(|_| die("use a literal 127.0.0.x:port"));
    if !addr.ip().is_loopback() {
        die("benchmarks run on loopback only");
    }
    let method = a.s("method").unwrap_or("GET").to_string();
    let mut headers = a.all("H");
    if let Some(api) = a.s("session-from") {
        // An anonymous session cookie minted through the ticket API (A1's session scenario).
        let (_, _, ck) = http::mint_ticket(api, None).unwrap_or_else(|e| die(e));
        if let Some(ck) = ck {
            headers.push(format!("Cookie: {ck}"));
        }
    }
    let body = a.s("body").unwrap_or("").as_bytes().to_vec();
    let req = Arc::new(http::build_request(&method, &path, &hp, &headers, &body));
    let c = a.u("c", 16);
    let rate = a.f("rate", 0.0);
    let warm = a.f("warmup", 1.0);
    let dur = a.f("duration", 5.0);
    let expect: Option<u16> = a.s("expect").and_then(|v| v.parse().ok());
    let head_req = method == "HEAD";
    let start = Instant::now();
    let measuring = Arc::new(AtomicBool::new(false));
    let hist = Arc::new(Mutex::new(Hist::default()));
    let ops = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(Mutex::new(HashMap::<String, u64>::new()));
    let mut hs = Vec::new();
    for i in 0..c {
        let (req, measuring, hist, ops, bytes, errors) =
            (req.clone(), measuring.clone(), hist.clone(), ops.clone(), bytes.clone(), errors.clone());
        hs.push(std::thread::spawn(move || {
            let mut local = Hist::default();
            let mut cl: Option<http::Client> = None;
            let interval = if rate > 0.0 { Some(Duration::from_secs_f64(c as f64 / rate)) } else { None };
            let t0 = start + interval.map_or(Duration::ZERO, |iv| iv.mul_f64(i as f64 / c as f64));
            let mut k: u32 = 0;
            while start.elapsed().as_secs_f64() < warm + dur {
                let sched = match interval {
                    Some(iv) => {
                        let due = t0 + iv * k;
                        k += 1;
                        if let Some(w) = due.checked_duration_since(Instant::now()) {
                            std::thread::sleep(w);
                        }
                        due
                    }
                    None => Instant::now(),
                };
                let r = (|| -> io::Result<http::Response> {
                    if cl.is_none() {
                        cl = Some(http::Client::new(TcpStream::connect(addr)?)?);
                    }
                    let cc = cl.as_mut().unwrap();
                    cc.send(&req)?;
                    cc.recv(head_req, false)
                })();
                let m = measuring.load(Ordering::Relaxed);
                match r {
                    Ok(resp) => {
                        if resp.header("connection").is_some_and(|v| v.eq_ignore_ascii_case("close")) {
                            cl = None;
                        }
                        if m {
                            local.record(sched.elapsed().as_nanos() as u64);
                            ops.fetch_add(1, Ordering::Relaxed);
                            bytes.fetch_add(resp.body.len() as u64, Ordering::Relaxed);
                            if expect.is_some_and(|e| e != resp.status) {
                                *errors.lock().unwrap().entry(format!("HTTP {}", resp.status)).or_insert(0) += 1;
                            }
                        }
                    }
                    Err(e) => {
                        cl = None;
                        if m {
                            let mut s = e.to_string();
                            s.truncate(80);
                            *errors.lock().unwrap().entry(s).or_insert(0) += 1;
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            }
            hist.lock().unwrap().merge(&local);
        }));
    }
    std::thread::sleep(Duration::from_secs_f64(warm));
    let cpu0 = cpu_s();
    let t1 = Instant::now();
    measuring.store(true, Ordering::Relaxed);
    for h in hs {
        let _ = h.join();
    }
    let secs = t1.elapsed().as_secs_f64();
    let h = hist.lock().unwrap().clone();
    let e = errors.lock().unwrap();
    let errs: Vec<String> = e.iter().map(|(k, v)| format!("{}:{v}", json_str(k))).collect();
    print_latency(
        "http",
        ops.load(Ordering::Relaxed),
        secs,
        cpu_s() - cpu0,
        &h,
        &format!("{{{}}}", errs.join(",")),
        &format!(",\"c\":{c},\"rate\":{rate}"),
    );
}

// ── fadvise ──────────────────────────────────────────────────────────────────────────────────────────────────────

fn fadvise(paths: &[String]) {
    use std::os::fd::AsRawFd;
    fn walk(p: &std::path::Path, n: &mut u64, failed: &mut u64) {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(p) {
                for e in rd.flatten() {
                    walk(&e.path(), n, failed);
                }
            }
        } else if let Ok(f) = std::fs::File::open(p) {
            let r = unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
            if r == 0 { *n += 1 } else { *failed += 1 }
        }
    }
    let (mut n, mut failed) = (0, 0);
    for p in paths {
        walk(std::path::Path::new(p), &mut n, &mut failed);
    }
    println!("{{\"mode\":\"fadvise\",\"files\":{n},\"failed\":{failed}}}");
}
