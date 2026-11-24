//! A minimal RFC 6455 client: the upgrade request, masked client frames, unmasked server frames.
use sha1::{Digest, Sha1};
use std::io::{self, Read, Write};

pub const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub fn b64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= c.len() {
                out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn accept_key(key: &str) -> String {
    let mut h = Sha1::new();
    h.update(key.as_bytes());
    h.update(GUID.as_bytes());
    b64(&h.finalize())
}

/// XOR `data` with the 4-byte `mask` (8 bytes at a time).
pub fn apply_mask(data: &mut [u8], mask: [u8; 4]) {
    let m8 = u64::from_ne_bytes([mask[0], mask[1], mask[2], mask[3], mask[0], mask[1], mask[2], mask[3]]);
    let mut chunks = data.chunks_exact_mut(8);
    for c in &mut chunks {
        let v = u64::from_ne_bytes(c.try_into().unwrap()) ^ m8;
        c.copy_from_slice(&v.to_ne_bytes());
    }
    for (i, b) in chunks.into_remainder().iter_mut().enumerate() {
        *b ^= mask[i % 4];
    }
}

/// One masked binary frame (FIN set) holding `parts` concatenated, written with one `write_all`.
pub fn encode_frame(opcode: u8, parts: &[&[u8]], mask: [u8; 4], out: &mut Vec<u8>) {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    out.clear();
    out.push(0x80 | opcode);
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len < 65536 {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    let start = out.len();
    for p in parts {
        out.extend_from_slice(p);
    }
    apply_mask(&mut out[start..], mask);
}

pub struct Frame {
    pub opcode: u8,
    pub payload: Vec<u8>,
}

/// Read one frame (continuations are not used by the servers measured here; they are returned as-is).
pub fn read_frame<R: Read>(r: &mut R, buf: &mut Vec<u8>) -> io::Result<Frame> {
    let mut h = [0u8; 2];
    r.read_exact(&mut h)?;
    let masked = h[1] & 0x80 != 0;
    let mut len = u64::from(h[1] & 0x7f);
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b)?;
        len = u64::from(u16::from_be_bytes(b));
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b)?;
        len = u64::from_be_bytes(b);
    }
    if len > 64 << 20 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask)?;
    }
    buf.resize(len as usize, 0);
    r.read_exact(buf)?;
    if masked {
        apply_mask(buf, mask);
    }
    Ok(Frame { opcode: h[0] & 0x0f, payload: std::mem::take(buf) })
}

/// Send the upgrade and read the response head. Returns the status code and the head.
pub fn handshake<S: Read + Write>(s: &mut S, host: &str, path: &str, origin: Option<&str>, key: &str) -> io::Result<(u16, String)> {
    let mut req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
    );
    if let Some(o) = origin {
        req.push_str(&format!("Origin: {o}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;
    let head = read_head(s)?;
    let status = head.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    if status == 101 {
        let want = accept_key(key);
        let ok = head.lines().any(|l| {
            l.split_once(':').is_some_and(|(k, v)| k.eq_ignore_ascii_case("sec-websocket-accept") && v.trim() == want)
        });
        if !ok {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad Sec-WebSocket-Accept"));
        }
    }
    Ok((status, head))
}

/// Read up to and including `\r\n\r\n` one byte at a time (so nothing after the head is consumed).
pub fn read_head<R: Read>(r: &mut R) -> io::Result<String> {
    let mut out = Vec::with_capacity(512);
    let mut b = [0u8; 1];
    while !out.ends_with(b"\r\n\r\n") {
        if r.read(&mut b)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in the response head"));
        }
        out.push(b[0]);
        if out.len() > 65536 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc6455_accept_key() {
        assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
    #[test]
    fn masking_round_trips_and_matches_bytewise() {
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let orig: Vec<u8> = (0..1001u32).map(|i| (i * 31) as u8).collect();
        let mut a = orig.clone();
        apply_mask(&mut a, mask);
        for (i, b) in a.iter().enumerate() {
            assert_eq!(*b, orig[i] ^ mask[i % 4]);
        }
        apply_mask(&mut a, mask);
        assert_eq!(a, orig);
    }
    #[test]
    fn frame_encode_decode() {
        for len in [0usize, 5, 125, 126, 65535, 65536, 200_000] {
            let data: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let mut out = Vec::new();
            encode_frame(2, &[&data[..len / 2], &data[len / 2..]], [1, 2, 3, 4], &mut out);
            let mut buf = Vec::new();
            let f = read_frame(&mut &out[..], &mut buf).unwrap();
            assert_eq!(f.opcode, 2);
            assert_eq!(f.payload, data);
        }
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
    }
}
