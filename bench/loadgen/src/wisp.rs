//! Wisp v1 over the WebSocket client: CONNECT, DATA, CONTINUE, CLOSE, and per-stream flow control (the client
//! never sends more DATA packets than the server's last CONTINUE allows).
use crate::ws;
use std::collections::HashMap;
use std::io::{self, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const CONNECT: u8 = 0x01;
pub const DATA: u8 = 0x02;
pub const CONTINUE: u8 = 0x03;
pub const CLOSE: u8 = 0x04;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Packet {
    Connect { stream: u32, port: u16, host: String },
    Data { stream: u32, payload: Vec<u8> },
    Continue { stream: u32, remaining: u32 },
    Close { stream: u32, reason: u8 },
    Other { kind: u8, stream: u32 },
}

pub fn header(kind: u8, stream: u32) -> [u8; 5] {
    let s = stream.to_le_bytes();
    [kind, s[0], s[1], s[2], s[3]]
}

pub fn encode(p: &Packet) -> Vec<u8> {
    let mut out = Vec::new();
    match p {
        Packet::Connect { stream, port, host } => {
            out.extend_from_slice(&header(CONNECT, *stream));
            out.push(0x01);
            out.extend_from_slice(&port.to_le_bytes());
            out.extend_from_slice(host.as_bytes());
        }
        Packet::Data { stream, payload } => {
            out.extend_from_slice(&header(DATA, *stream));
            out.extend_from_slice(payload);
        }
        Packet::Continue { stream, remaining } => {
            out.extend_from_slice(&header(CONTINUE, *stream));
            out.extend_from_slice(&remaining.to_le_bytes());
        }
        Packet::Close { stream, reason } => {
            out.extend_from_slice(&header(CLOSE, *stream));
            out.push(*reason);
        }
        Packet::Other { kind, stream } => out.extend_from_slice(&header(*kind, *stream)),
    }
    out
}

pub fn decode(b: &[u8]) -> Option<Packet> {
    if b.len() < 5 {
        return None;
    }
    let stream = u32::from_le_bytes(b[1..5].try_into().ok()?);
    let rest = &b[5..];
    Some(match b[0] {
        CONNECT if rest.len() >= 3 => Packet::Connect {
            stream,
            port: u16::from_le_bytes([rest[1], rest[2]]),
            host: String::from_utf8_lossy(&rest[3..]).into_owned(),
        },
        DATA => Packet::Data { stream, payload: rest.to_vec() },
        CONTINUE if rest.len() >= 4 => Packet::Continue { stream, remaining: u32::from_le_bytes(rest[..4].try_into().ok()?) },
        CLOSE if !rest.is_empty() => Packet::Close { stream, reason: rest[0] },
        kind => Packet::Other { kind, stream },
    })
}

/// Per-stream credit (packets the client may still send), as the server's CONTINUE packets set it.
#[derive(Default)]
pub struct Credits {
    pub initial: Option<u32>,
    pub per_stream: HashMap<u32, u32>,
    pub closed: HashMap<u32, u8>,
    pub dead: bool,
}

impl Credits {
    /// Take one credit for `stream`; `false` when none is left.
    pub fn take(&mut self, stream: u32) -> bool {
        let Some(init) = self.initial else { return false };
        let c = self.per_stream.entry(stream).or_insert(init);
        if *c == 0 {
            return false;
        }
        *c -= 1;
        true
    }
    pub fn apply(&mut self, p: &Packet) {
        match p {
            Packet::Continue { stream: 0, remaining } if self.initial.is_none() => self.initial = Some(*remaining),
            Packet::Continue { stream, remaining } => {
                self.per_stream.insert(*stream, *remaining);
            }
            Packet::Close { stream, reason } => {
                self.closed.insert(*stream, *reason);
            }
            _ => {}
        }
    }
}

pub struct Shared {
    pub credits: Mutex<Credits>,
    pub cv: Condvar,
    pub rx_bytes: AtomicU64,
    pub dead: AtomicBool,
}

pub enum Event {
    Data(u32, Vec<u8>),
    Close(u32, u8),
}

/// The sending half of a connection (movable to its own thread).
pub struct Writer {
    pub w: TcpStream,
    pub shared: Arc<Shared>,
    pub next_stream: u32,
    buf: Vec<u8>,
    mask_seed: u32,
}

pub struct Conn {
    pub tx: Writer,
    pub events: mpsc::Receiver<Event>,
}

pub struct Target {
    pub addr: SocketAddr,
    pub host: String,
    pub path: String,
    pub origin: Option<String>,
}

fn mask(seed: &mut u32) -> [u8; 4] {
    // xorshift: masks only need to be unpredictable to intermediaries, not to us.
    *seed ^= *seed << 13;
    *seed ^= *seed >> 17;
    *seed ^= *seed << 5;
    seed.to_le_bytes()
}

impl Conn {
    /// Upgrade `sock` (already connected) and wait for the server's initial CONTINUE. `deliver`: forward DATA to
    /// the event channel (else only count it).
    pub fn open(mut sock: TcpStream, t: &Target, deliver: bool) -> io::Result<Conn> {
        sock.set_nodelay(true)?;
        let key = ws::b64(&rand16());
        let (status, head) = ws::handshake(&mut sock, &t.host, &t.path, t.origin.as_deref(), &key)?;
        if status != 101 {
            return Err(io::Error::other(format!("upgrade refused: HTTP {status}: {}", head.lines().next().unwrap_or(""))));
        }
        let shared = Arc::new(Shared {
            credits: Mutex::new(Credits::default()),
            cv: Condvar::new(),
            rx_bytes: AtomicU64::new(0),
            dead: AtomicBool::new(false),
        });
        let (tx, events) = mpsc::channel();
        let mut r = sock.try_clone()?;
        let sh = shared.clone();
        let mut wpong = sock.try_clone()?;
        std::thread::Builder::new().stack_size(128 << 10).spawn(move || {
            let mut buf = Vec::new();
            loop {
                let f = match ws::read_frame(&mut r, &mut buf) {
                    Ok(f) => f,
                    Err(_) => break,
                };
                match f.opcode {
                    0x8 => break,
                    0x9 => {
                        let mut out = Vec::new();
                        ws::encode_frame(0xA, &[&f.payload], [9, 8, 7, 6], &mut out);
                        let _ = wpong.write_all(&out);
                    }
                    0x2 | 0x0 | 0x1 => {
                        if !deliver && f.payload.len() >= 5 && f.payload[0] == DATA {
                            sh.rx_bytes.fetch_add(f.payload.len() as u64 - 5, Ordering::Relaxed);
                            buf = f.payload;
                            continue;
                        }
                        let Some(p) = decode(&f.payload) else { continue };
                        match p {
                            Packet::Data { stream, payload } => {
                                sh.rx_bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);
                                if deliver {
                                    let _ = tx.send(Event::Data(stream, payload));
                                }
                            }
                            Packet::Continue { .. } | Packet::Close { .. } => {
                                if let Packet::Close { stream, reason } = p {
                                    let _ = tx.send(Event::Close(stream, reason));
                                }
                                sh.credits.lock().unwrap().apply(&p);
                                sh.cv.notify_all();
                            }
                            _ => {}
                        }
                        buf = f.payload;
                    }
                    _ => {}
                }
            }
            sh.dead.store(true, Ordering::Relaxed);
            sh.credits.lock().unwrap().dead = true;
            sh.cv.notify_all();
        })?;
        let seed = 0x9e37_79b9 ^ std::process::id() ^ u32::from_le_bytes(rand16()[..4].try_into().unwrap()) | 1;
        let tx = Writer { w: sock, shared, next_stream: 1, buf: Vec::with_capacity(70 << 10), mask_seed: seed };
        let conn = Conn { tx, events };
        {
            let g = conn.tx.shared.credits.lock().unwrap();
            let (g, to) = conn.tx.shared.cv.wait_timeout_while(g, Duration::from_secs(10), |c| c.initial.is_none() && !c.dead).unwrap();
            if to.timed_out() || g.initial.is_none() {
                return Err(io::Error::other("no initial CONTINUE from the Wisp server"));
            }
        }
        Ok(conn)
    }

    pub fn connect(&mut self, host: &str, port: u16) -> io::Result<u32> {
        self.tx.connect(host, port)
    }
    pub fn data(&mut self, stream: u32, payload: &[u8]) -> io::Result<()> {
        self.tx.data(stream, payload)
    }
    pub fn close(&mut self, stream: u32) -> io::Result<()> {
        self.tx.close(stream)
    }
    pub fn shutdown(&self) {
        self.tx.shutdown();
    }

    /// Wait for `n` bytes of DATA on `stream` (other streams' data is dropped).
    pub fn recv_exact(&mut self, stream: u32, n: usize, timeout: Duration, out: &mut Vec<u8>) -> io::Result<()> {
        out.clear();
        let deadline = std::time::Instant::now() + timeout;
        while out.len() < n {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match self.events.recv_timeout(left) {
                Ok(Event::Data(s, d)) if s == stream => out.extend_from_slice(&d),
                Ok(Event::Close(s, r)) if s == stream => return Err(io::Error::other(format!("stream closed (reason {r:#x})"))),
                Ok(_) => {}
                Err(_) => return Err(io::Error::new(io::ErrorKind::TimedOut, "echo timed out")),
            }
        }
        Ok(())
    }
}

impl Writer {
    pub fn send_raw(&mut self, parts: &[&[u8]]) -> io::Result<()> {
        let m = mask(&mut self.mask_seed);
        ws::encode_frame(0x2, parts, m, &mut self.buf);
        self.w.write_all(&self.buf)
    }

    pub fn connect(&mut self, host: &str, port: u16) -> io::Result<u32> {
        let id = self.next_stream;
        self.next_stream += 1;
        let p = encode(&Packet::Connect { stream: id, port, host: host.into() });
        self.send_raw(&[&p])?;
        Ok(id)
    }

    /// Send one DATA packet, waiting for credit (up to 30 s).
    pub fn data(&mut self, stream: u32, payload: &[u8]) -> io::Result<()> {
        {
            let mut g = self.shared.credits.lock().unwrap();
            loop {
                if g.dead {
                    return Err(io::Error::new(io::ErrorKind::ConnectionReset, "connection closed"));
                }
                if let Some(r) = g.closed.get(&stream) {
                    return Err(io::Error::other(format!("stream closed by the server (reason {r:#x})")));
                }
                if g.take(stream) {
                    break;
                }
                let (ng, to) = self.shared.cv.wait_timeout(g, Duration::from_secs(30)).unwrap();
                g = ng;
                if to.timed_out() {
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "no CONTINUE within 30 s"));
                }
            }
        }
        let h = header(DATA, stream);
        self.send_raw(&[&h, payload])
    }

    pub fn close(&mut self, stream: u32) -> io::Result<()> {
        let p = encode(&Packet::Close { stream, reason: 0x02 });
        self.send_raw(&[&p])
    }

    pub fn shutdown(&self) {
        let _ = self.w.shutdown(std::net::Shutdown::Both);
    }
}

pub fn rand16() -> [u8; 16] {
    let mut b = [0u8; 16];
    // getrandom(2) through libc; the bench does not need a CSPRNG crate.
    unsafe { libc::getrandom(b.as_mut_ptr().cast(), 16, 0) };
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packets_round_trip() {
        for p in [
            Packet::Connect { stream: 7, port: 12345, host: "127.0.0.1".into() },
            Packet::Data { stream: 1, payload: vec![1, 2, 3] },
            Packet::Continue { stream: 0, remaining: 128 },
            Packet::Close { stream: 3, reason: 2 },
        ] {
            assert_eq!(decode(&encode(&p)), Some(p));
        }
        assert_eq!(&encode(&Packet::Connect { stream: 1, port: 80, host: "a".into() }), &[1, 1, 0, 0, 0, 1, 80, 0, b'a']);
    }
    #[test]
    fn flow_control_never_exceeds_the_window() {
        let mut c = Credits::default();
        assert!(!c.take(1), "no credit before the initial CONTINUE");
        c.apply(&Packet::Continue { stream: 0, remaining: 3 });
        assert!(c.take(1) && c.take(1) && c.take(1));
        assert!(!c.take(1));
        assert!(c.take(2), "a new stream starts with the initial window");
        c.apply(&Packet::Continue { stream: 1, remaining: 2 });
        assert!(c.take(1) && c.take(1) && !c.take(1));
    }
}
