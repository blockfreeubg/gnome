//! Wisp upstreams (HolyWisp instances): addresses, the forwarded WebSocket upgrade and the health probe.
//!
//! Upstreams are internal infrastructure only: the hop from the gateway is unencrypted and carries the client's
//! IP in `X-Forwarded-For`, and HolyWisp has no authentication of its own. An address is an IP literal that is
//! loopback, private (RFC 1918 / ULA), CGNAT or link-local (never a cloud-metadata address), or a DNS name (e.g. a
//! container name) whose answers are filtered to such addresses at connect time. `localhost` is refused: it may
//! resolve to `::1` while HolyWisp listens on `127.0.0.1` only.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::{Bytes, BytesMut};
use http::{HeaderName, HeaderValue};
use sha1::{Digest as _, Sha1};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpStream;

use crate::security::client::canonical_ip;
use crate::security::crypto::random_bytes;

/// Time to establish the TCP connection (DNS included).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Time for the upstream's response head after the request was written.
pub const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest accepted upstream response head (HolyWisp's is ~200 bytes).
pub const MAX_HEAD: usize = 16 * 1024;
/// RFC 6455 §1.3.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// A validated `host:port` of a Wisp upstream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpstreamAddr {
    host: String,
    port: u16,
    ip: Option<IpAddr>,
}

/// Cloud instance-metadata endpoints inside the otherwise accepted ranges: 169.254.169.254 (AWS, GCP, Azure,
/// OpenStack, …), 169.254.170.2 (AWS ECS task metadata), 169.254.0.23 (Tencent Cloud), 100.100.100.200 (Alibaba
/// Cloud, inside CGNAT) and fd00:ec2::254 (AWS IMDS over IPv6, inside ULA).
const METADATA_V4: [Ipv4Addr; 4] = [
    Ipv4Addr::new(169, 254, 169, 254),
    Ipv4Addr::new(169, 254, 170, 2),
    Ipv4Addr::new(169, 254, 0, 23),
    Ipv4Addr::new(100, 100, 100, 200),
];
const METADATA_V6: [Ipv6Addr; 1] = [Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254)];

/// Loopback, RFC 1918, CGNAT (100.64/10), IPv4 link-local, IPv6 loopback and ULA — never a cloud-metadata address.
pub fn is_internal_ip(ip: IpAddr) -> bool {
    match canonical_ip(ip) {
        IpAddr::V4(v4) => internal_v4(v4) && !METADATA_V4.contains(&v4),
        IpAddr::V6(v6) => (v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00) && !METADATA_V6.contains(&v6),
    }
}

fn internal_v4(v4: Ipv4Addr) -> bool {
    let [a, b, ..] = v4.octets();
    v4.is_loopback() || v4.is_private() || (a == 100 && (64..128).contains(&b)) || v4.is_link_local()
}

impl UpstreamAddr {
    /// Parse and validate `host:port` (`[v6]:port` for IPv6 literals).
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let usage = "expected host:port with an internal address, e.g. 127.0.0.1:6001";
        let (host, port) = if let Some(rest) = s.strip_prefix('[') {
            let (inner, after) = rest.split_once(']').ok_or(usage)?;
            (inner, after.strip_prefix(':').ok_or(usage)?)
        } else {
            let (h, p) = s.rsplit_once(':').ok_or(usage)?;
            if h.contains(':') {
                return Err("IPv6 addresses need brackets, e.g. [::1]:6001".into());
            }
            (h, p)
        };
        let port: u16 = port.parse().ok().filter(|p| *p != 0).ok_or(usage)?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            let ip = canonical_ip(ip);
            if !is_internal_ip(ip) {
                return Err(format!(
                    "{ip} is not an internal address (loopback, private, CGNAT or link-local): the gateway's hop to \
                     HolyWisp is unencrypted and carries client IPs"
                ));
            }
            return Ok(Self { host: ip.to_string(), port, ip: Some(ip) });
        }
        if s.starts_with('[') {
            return Err(usage.into());
        }
        let host = host.to_ascii_lowercase();
        let valid = !host.is_empty()
            && host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            });
        if !valid {
            return Err(usage.into());
        }
        if host == "localhost" || host.ends_with(".localhost") || host == "localhost.localdomain" {
            return Err("use 127.0.0.1 instead of localhost: it may resolve to ::1 while HolyWisp listens on \
                        127.0.0.1 only"
                .into());
        }
        Ok(Self { host, port, ip: None })
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The IP literal, if the address is one.
    pub fn ip(&self) -> Option<IpAddr> {
        self.ip
    }

    /// `host:port` as used in the forwarded `Host` header.
    pub fn authority(&self) -> String {
        match self.ip {
            Some(IpAddr::V6(v6)) => format!("[{v6}]:{}", self.port),
            _ => format!("{}:{}", self.host, self.port),
        }
    }

    /// Connect (resolving DNS names; only internal answers are used) within [`CONNECT_TIMEOUT`].
    pub async fn connect(&self) -> Result<TcpStream, UpstreamError> {
        self.connect_within(CONNECT_TIMEOUT).await
    }

    pub async fn connect_within(&self, timeout: Duration) -> Result<TcpStream, UpstreamError> {
        let attempt = async {
            let candidates: Vec<SocketAddr> = match self.ip {
                Some(ip) => vec![SocketAddr::new(ip, self.port)],
                None => {
                    let resolved = tokio::net::lookup_host((self.host.as_str(), self.port))
                        .await
                        .map_err(|e| UpstreamError::Unreachable(format!("cannot resolve {}: {e}", self.host)))?;
                    let all: Vec<SocketAddr> = resolved.collect();
                    let internal: Vec<SocketAddr> = all.iter().copied().filter(|a| is_internal_ip(a.ip())).collect();
                    if internal.is_empty() {
                        return Err(UpstreamError::NotInternal(self.host.clone()));
                    }
                    internal
                }
            };
            let mut last = None;
            for addr in candidates {
                match TcpStream::connect(addr).await {
                    Ok(stream) => {
                        let _ = stream.set_nodelay(true);
                        return Ok(stream);
                    }
                    Err(e) => last = Some(e),
                }
            }
            Err(UpstreamError::Unreachable(last.map_or_else(|| "no address".into(), |e| e.to_string())))
        };
        tokio::time::timeout(timeout, attempt).await.map_err(|_| UpstreamError::Timeout)?
    }
}

impl fmt::Display for UpstreamAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.authority())
    }
}

/// Why an upstream could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpstreamError {
    Unreachable(String),
    /// A DNS name resolved to public addresses only.
    NotInternal(String),
    Timeout,
    /// The connection closed before a complete response head.
    Closed,
    Malformed(&'static str),
    /// The upstream answered, but not `101 Switching Protocols`.
    Status(u16),
    Io(String),
}

impl fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(e) => write!(f, "unreachable: {e}"),
            Self::NotInternal(host) => write!(f, "{host} resolves to no internal address; refusing to connect"),
            Self::Timeout => f.write_str("timed out"),
            Self::Closed => f.write_str("closed the connection before answering"),
            Self::Malformed(what) => write!(f, "malformed response head ({what})"),
            Self::Status(code) => write!(f, "answered HTTP {code} instead of 101"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
        }
    }
}

impl std::error::Error for UpstreamError {}

/// The parts of the client's upgrade request that are forwarded (already validated: visible ASCII only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForwardedUpgrade {
    /// Request path without the query (and so without the ticket).
    pub path: String,
    pub upgrade: String,
    pub connection: String,
    pub key: String,
    pub version: String,
    pub protocol: Option<String>,
    pub extensions: Option<String>,
}

impl ForwardedUpgrade {
    /// The reconstructed request head: only these fields, `Host` = the upstream, exactly one `X-Forwarded-For` with
    /// the bare client IP. Nothing else from the client (no cookies, credentials or forwarding headers) is sent.
    pub fn request_head(&self, upstream: &UpstreamAddr, client_ip: IpAddr) -> Vec<u8> {
        let mut head = String::with_capacity(512);
        head.push_str("GET ");
        head.push_str(&self.path);
        head.push_str(" HTTP/1.1\r\nHost: ");
        head.push_str(&upstream.authority());
        for (name, value) in [
            ("Upgrade", Some(&self.upgrade)),
            ("Connection", Some(&self.connection)),
            ("Sec-WebSocket-Key", Some(&self.key)),
            ("Sec-WebSocket-Version", Some(&self.version)),
            ("Sec-WebSocket-Protocol", self.protocol.as_ref()),
            ("Sec-WebSocket-Extensions", self.extensions.as_ref()),
        ] {
            if let Some(v) = value {
                head.push_str("\r\n");
                head.push_str(name);
                head.push_str(": ");
                head.push_str(v);
            }
        }
        head.push_str("\r\nX-Forwarded-For: ");
        head.push_str(&canonical_ip(client_ip).to_string());
        head.push_str("\r\n\r\n");
        head.into_bytes()
    }
}

/// A parsed upstream response head.
#[derive(Debug, Clone)]
pub struct ResponseHead {
    pub status: u16,
    /// In the order received (names lowercased by `HeaderName`).
    pub headers: Vec<(HeaderName, HeaderValue)>,
}

impl ResponseHead {
    pub fn header(&self, name: &str) -> Option<&HeaderValue> {
        self.headers.iter().find(|(n, _)| n.as_str().eq_ignore_ascii_case(name)).map(|(_, v)| v)
    }
}

/// Connect, send the reconstructed upgrade and read the response head. Returns the stream, the head and any bytes
/// that followed it (HolyWisp sends the first Wisp frame right after the `101`). A non-101 answer is an error.
pub async fn open(
    upstream: &UpstreamAddr,
    forwarded: &ForwardedUpgrade,
    client_ip: IpAddr,
) -> Result<(TcpStream, ResponseHead, Bytes), UpstreamError> {
    let mut stream = upstream.connect().await?;
    stream
        .write_all(&forwarded.request_head(upstream, client_ip))
        .await
        .map_err(|e| UpstreamError::Io(e.to_string()))?;
    let (head, rest) = read_head(&mut stream, HEAD_TIMEOUT).await?;
    if head.status != 101 {
        return Err(UpstreamError::Status(head.status));
    }
    Ok((stream, head, rest))
}

/// Read and parse an HTTP/1.x response head within `timeout`.
pub async fn read_head(stream: &mut TcpStream, timeout: Duration) -> Result<(ResponseHead, Bytes), UpstreamError> {
    let read = async {
        let mut buf = BytesMut::with_capacity(1024);
        loop {
            let scanned_from = buf.len().saturating_sub(3);
            let n = stream.read_buf(&mut buf).await.map_err(|e| UpstreamError::Io(e.to_string()))?;
            if n == 0 {
                return Err(UpstreamError::Closed);
            }
            if let Some(pos) = find_head_end(&buf[scanned_from..]) {
                let end = scanned_from + pos + 4;
                let head = parse_head(&buf[..end])?;
                let rest = buf.split_off(end).freeze();
                return Ok((head, rest));
            }
            if buf.len() > MAX_HEAD {
                return Err(UpstreamError::Malformed("head too large"));
            }
        }
    };
    tokio::time::timeout(timeout, read).await.map_err(|_| UpstreamError::Timeout)?
}

fn find_head_end(b: &[u8]) -> Option<usize> {
    b.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_head(raw: &[u8]) -> Result<ResponseHead, UpstreamError> {
    let mut slots = [httparse::EMPTY_HEADER; 64];
    let mut res = httparse::Response::new(&mut slots);
    match res.parse(raw) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err(UpstreamError::Malformed("incomplete")),
        Err(_) => return Err(UpstreamError::Malformed("not HTTP/1.x")),
    }
    let status = res.code.ok_or(UpstreamError::Malformed("no status"))?;
    let mut headers = Vec::with_capacity(res.headers.len());
    for h in res.headers.iter() {
        let name = HeaderName::from_bytes(h.name.as_bytes()).map_err(|_| UpstreamError::Malformed("header name"))?;
        let value = HeaderValue::from_bytes(h.value).map_err(|_| UpstreamError::Malformed("header value"))?;
        headers.push((name, value));
    }
    Ok(ResponseHead { status, headers })
}

/// `Sec-WebSocket-Accept` for a key (RFC 6455 §4.2.2).
pub fn accept_key(key: &str) -> String {
    let mut sha = Sha1::new();
    sha.update(key.as_bytes());
    sha.update(WS_GUID.as_bytes());
    STANDARD.encode(sha.finalize())
}

/// Health probe: TCP connect, WebSocket handshake (checking `Sec-WebSocket-Accept`) and the first Wisp frame
/// (`CONTINUE` on stream 0), then a clean WebSocket close. Returns the time to the first frame.
pub async fn probe(upstream: &UpstreamAddr, timeout: Duration) -> Result<Duration, String> {
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + timeout;
    let mut stream = upstream.connect_within(timeout).await.map_err(|e| e.to_string())?;
    let key = STANDARD.encode(random_bytes::<16>());
    let request = format!(
        "GET /wisp/ HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \
         {key}\r\nSec-WebSocket-Version: 13\r\n\r\n",
        upstream.authority()
    );
    stream.write_all(request.as_bytes()).await.map_err(|e| format!("write: {e}"))?;
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let (head, rest) = read_head(&mut stream, remaining).await.map_err(|e| e.to_string())?;
    if head.status != 101 {
        return Err(UpstreamError::Status(head.status).to_string());
    }
    if head.header("sec-websocket-accept").and_then(|v| v.to_str().ok()) != Some(accept_key(&key).as_str()) {
        return Err("wrong Sec-WebSocket-Accept".into());
    }
    let mut frame = rest.to_vec();
    let payload = tokio::time::timeout_at(deadline, async {
        loop {
            if let Some(p) = first_frame_payload(&frame)? {
                return Ok(p);
            }
            if frame.len() > 1024 {
                return Err("first frame too large".to_string());
            }
            let mut more = [0u8; 256];
            let n = stream.read(&mut more).await.map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                return Err("closed before the first Wisp frame".to_string());
            }
            frame.extend_from_slice(&more[..n]);
        }
    })
    .await
    .map_err(|_| "no Wisp frame in time".to_string())??;
    let elapsed = started.elapsed();
    // CONTINUE (0x03) for stream 0: [type, stream id u32 LE, buffer remaining u32 LE].
    if payload.len() < 9 || payload[0] != 0x03 || payload[1..5] != [0, 0, 0, 0] {
        return Err("the first frame is not a Wisp CONTINUE".into());
    }
    // Masked close frame, status 1000.
    let mask = random_bytes::<4>();
    let code = 1000u16.to_be_bytes();
    let close = [0x88, 0x82, mask[0], mask[1], mask[2], mask[3], code[0] ^ mask[0], code[1] ^ mask[1]];
    let _ = stream.write_all(&close).await;
    let _ = stream.shutdown().await;
    Ok(elapsed)
}

/// The payload of the first (unmasked, binary) server frame in `b`, once complete. Errors for other opcodes.
fn first_frame_payload(b: &[u8]) -> Result<Option<Vec<u8>>, String> {
    if b.len() < 2 {
        return Ok(None);
    }
    if b[0] & 0x0f != 0x2 {
        return Err(format!("first frame has opcode {:#x}, expected binary", b[0] & 0x0f));
    }
    if b[1] & 0x80 != 0 {
        return Err("server frames must not be masked".into());
    }
    let (len, offset) = match b[1] & 0x7f {
        126 if b.len() >= 4 => (usize::from(u16::from_be_bytes([b[2], b[3]])), 4),
        126 => return Ok(None),
        127 => return Err("first frame is implausibly large".into()),
        n => (usize::from(n), 2),
    };
    if b.len() < offset + len {
        return Ok(None);
    }
    Ok(Some(b[offset..offset + len].to_vec()))
}

/// The unspecified addresses (`0.0.0.0`, `::`) are never upstreams.
pub fn is_unspecified(ip: IpAddr) -> bool {
    ip == IpAddr::V4(Ipv4Addr::UNSPECIFIED) || ip == IpAddr::V6(Ipv6Addr::UNSPECIFIED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_addresses() {
        for ok in [
            "127.0.0.1",
            "127.8.9.10",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.254",
            "169.254.64.2",
            "::1",
            "fd00::1",
            "fc12::3",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_internal_ip(ok.parse().unwrap()), "{ok}");
        }
        for bad in [
            "1.1.1.1",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "169.254.169.254",
            "169.254.170.2",
            "169.254.0.23",
            "100.100.100.200",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "0.0.0.0",
            "::",
            "2001:db8::1",
            "fe80::1",
            "::ffff:8.8.8.8",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_internal_ip(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn parse_addresses() {
        let a = UpstreamAddr::parse("127.0.0.1:6001").unwrap();
        assert_eq!((a.host(), a.port(), a.authority()), ("127.0.0.1", 6001, "127.0.0.1:6001".to_string()));
        let v6 = UpstreamAddr::parse("[::1]:6002").unwrap();
        assert_eq!(v6.authority(), "[::1]:6002");
        let mapped = UpstreamAddr::parse("[::ffff:127.0.0.1]:6001").unwrap();
        assert_eq!(mapped.authority(), "127.0.0.1:6001");
        let name = UpstreamAddr::parse(" HolyWisp_1:6001 ").unwrap();
        assert_eq!((name.host(), name.ip()), ("holywisp_1", None));
        for bad in [
            "",
            "127.0.0.1",
            "127.0.0.1:0",
            "127.0.0.1:70000",
            "::1:6001",
            "[::1]",
            "[nope]:1",
            "a b:1",
            "-x:1",
            "x..y:1",
            "1.1.1.1:6001",
            "[2001:db8::1]:6001",
            "169.254.169.254:80",
            "[fd00:ec2::254]:80",
            "100.100.100.200:80",
            "0.0.0.0:6001",
        ] {
            assert!(UpstreamAddr::parse(bad).is_err(), "{bad:?}");
        }
        for local in ["localhost:6001", "LOCALHOST:6001", "wisp.localhost:6001"] {
            assert!(UpstreamAddr::parse(local).unwrap_err().contains("127.0.0.1"), "{local}");
        }
    }

    #[test]
    fn reconstructed_request_head() {
        let fwd = ForwardedUpgrade {
            path: "/wisp/".into(),
            upgrade: "websocket".into(),
            connection: "keep-alive, Upgrade".into(),
            key: "dGhlIHNhbXBsZSBub25jZQ==".into(),
            version: "13".into(),
            protocol: Some("wisp-v2".into()),
            extensions: None,
        };
        let up = UpstreamAddr::parse("127.0.0.1:6001").unwrap();
        let head = String::from_utf8(fwd.request_head(&up, "::ffff:203.0.113.9".parse().unwrap())).unwrap();
        assert_eq!(
            head,
            "GET /wisp/ HTTP/1.1\r\nHost: 127.0.0.1:6001\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: \
             wisp-v2\r\nX-Forwarded-For: 203.0.113.9\r\n\r\n"
        );
        let v6 = String::from_utf8(fwd.request_head(&up, "2001:db8::7".parse().unwrap())).unwrap();
        assert!(v6.contains("\r\nX-Forwarded-For: 2001:db8::7\r\n"), "bare IPv6, no brackets: {v6}");
    }

    /// An upstream that never finishes its head is cut off by size, a silent one by time, and the bytes after a
    /// complete head are returned untouched.
    #[tokio::test]
    async fn response_heads_are_bounded_in_size_and_time() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            // 1: endless header lines; 2: silence; 3: a head split across writes, then frame bytes.
            let (mut flood, _) = listener.accept().await.unwrap();
            let pad = format!("X-Pad: {}\r\n", "p".repeat(1000));
            let _ = flood.write_all(b"HTTP/1.1 101 Switching Protocols\r\n").await;
            while flood.write_all(pad.as_bytes()).await.is_ok() {}
            let (silent, _) = listener.accept().await.unwrap();
            let (mut split, _) = listener.accept().await.unwrap();
            split.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r").await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            split.write_all(b"\n\r\n\x82\x09\x03").await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
            drop(silent);
        });
        let mut flood = TcpStream::connect(addr).await.unwrap();
        let err = read_head(&mut flood, Duration::from_secs(10)).await.unwrap_err();
        assert_eq!(err, UpstreamError::Malformed("head too large"));
        drop(flood);
        let mut silent = TcpStream::connect(addr).await.unwrap();
        let started = Instant::now();
        assert_eq!(read_head(&mut silent, Duration::from_millis(200)).await.unwrap_err(), UpstreamError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut split = TcpStream::connect(addr).await.unwrap();
        let (head, rest) = read_head(&mut split, Duration::from_secs(5)).await.unwrap();
        assert_eq!((head.status, head.headers.len()), (101, 1));
        assert_eq!(&rest[..], b"\x82\x09\x03", "bytes after the head are kept for the relay");
        server.abort();
    }

    #[test]
    fn accept_key_matches_rfc_6455_example() {
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn heads_and_frames() {
        let head =
            parse_head(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nX-A: 1\r\nX-A: 2\r\n\r\n").unwrap();
        assert_eq!(head.status, 101);
        assert_eq!(head.headers.len(), 3, "duplicates are kept in order");
        assert!(parse_head(b"garbage\r\n\r\n").is_err());
        assert_eq!(first_frame_payload(&[0x82, 0x09, 3, 0, 0, 0, 0, 8, 0, 0, 0]).unwrap().unwrap()[0], 3);
        assert_eq!(first_frame_payload(&[0x82, 0x09, 3]).unwrap(), None);
        assert!(first_frame_payload(&[0x81, 0x01, b'x']).is_err());
        assert!(is_unspecified("0.0.0.0".parse().unwrap()) && !is_unspecified("127.0.0.1".parse().unwrap()));
    }
}
