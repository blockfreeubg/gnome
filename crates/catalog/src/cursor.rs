//! Opaque keyset-pagination cursors.
//!
//! A cursor carries the sort key of the last item of a page plus its id, bound to the query it came from:
//!
//! ```text
//! base64url( version:u8 | sort:u8 | query fingerprint:[u8; 8] | key | id:i64 | HMAC-SHA256(secret, …)[..16] )
//! key = f64 bits (popular, trending, relevance) | i64 (new) | u8 + f64 bits (featured) | u16 len + UTF-8 (az)
//! ```
//!
//! Decoding is strict (exact length, known version and sort, valid UTF-8) and the MAC is checked in constant time,
//! so a tampered cursor or a cursor replayed against a different query or sort is rejected instead of silently
//! paging somewhere else. Keyset paging is stable under concurrent inserts: new games land before or after the
//! cursor position and never shift existing items. (Scores refreshed between two page loads can still move an
//! item across the boundary; the ranking job runs hourly.)

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// Maximum accepted cursor length (characters).
pub const MAX_CURSOR_LEN: usize = 512;
/// Longest text sort key a cursor carries (bytes). `games.title_sort` is stored at most this long, so the key of a
/// row always fits whole: a cut key would sort before the row it came from and repeat rows on the next page.
pub const MAX_SORT_KEY_BYTES: usize = 300;
const VERSION: u8 = 1;
const MAC_LEN: usize = 16;

/// Sort key of the last item on a page.
#[derive(Debug, Clone, PartialEq)]
pub enum CursorKey {
    /// `popular`, `trending`, `relevance`.
    Score(f64),
    /// `new`.
    Int(i64),
    /// `featured`: (featured flag, popularity).
    Featured(bool, f64),
    /// `az`.
    Text(String),
}

/// A decoded cursor.
#[derive(Debug, Clone, PartialEq)]
pub struct Cursor {
    /// Sort order code.
    pub sort: u8,
    /// Fingerprint of the query filters the cursor belongs to.
    pub fingerprint: [u8; 8],
    /// Sort key of the last item.
    pub key: CursorKey,
    /// Id of the last item (tie-breaker).
    pub id: i64,
}

/// Secret used to sign cursors (derive it from the server secret with a domain-separation label).
#[derive(Clone)]
pub struct CursorSecret([u8; 32]);

impl std::fmt::Debug for CursorSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CursorSecret(…)")
    }
}

impl CursorSecret {
    /// Derive the cursor key from arbitrary secret material (HMAC with a fixed label).
    pub fn derive(secret: &[u8]) -> Self {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret).expect("HMAC accepts any key length");
        mac.update(b"gnome-catalog cursor v1");
        Self(mac.finalize().into_bytes().into())
    }

    fn mac(&self) -> Hmac<Sha256> {
        <Hmac<Sha256> as KeyInit>::new_from_slice(&self.0).expect("HMAC accepts any key length")
    }
}

impl Cursor {
    /// Encode and sign.
    pub fn encode(&self, secret: &CursorSecret) -> String {
        let mut buf = Vec::with_capacity(64);
        buf.push(VERSION);
        buf.push(self.sort);
        buf.extend_from_slice(&self.fingerprint);
        match &self.key {
            CursorKey::Score(f) => buf.extend_from_slice(&f.to_bits().to_be_bytes()),
            CursorKey::Int(i) => buf.extend_from_slice(&i.to_be_bytes()),
            CursorKey::Featured(b, f) => {
                buf.push(u8::from(*b));
                buf.extend_from_slice(&f.to_bits().to_be_bytes());
            }
            CursorKey::Text(s) => {
                // Keys are stored at most MAX_SORT_KEY_BYTES long; never cut inside a character.
                let mut cut = s.len().min(MAX_SORT_KEY_BYTES);
                while !s.is_char_boundary(cut) {
                    cut -= 1;
                }
                let bytes = &s.as_bytes()[..cut];
                buf.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
                buf.extend_from_slice(bytes);
            }
        }
        buf.extend_from_slice(&self.id.to_be_bytes());
        let mut mac = secret.mac();
        mac.update(&buf);
        let tag = mac.finalize().into_bytes();
        buf.extend_from_slice(&tag[..MAC_LEN]);
        URL_SAFE_NO_PAD.encode(buf)
    }

    /// Decode, verify the signature and check that it belongs to `sort` / `fingerprint`. `kind` says which key
    /// layout the sort uses.
    pub fn decode(
        s: &str,
        secret: &CursorSecret,
        sort: u8,
        fingerprint: [u8; 8],
        kind: KeyKind,
    ) -> Result<Cursor, &'static str> {
        if s.is_empty() || s.len() > MAX_CURSOR_LEN {
            return Err("cursor length");
        }
        let buf = URL_SAFE_NO_PAD.decode(s).map_err(|_| "cursor encoding")?;
        if buf.len() < 2 + 8 + 8 + MAC_LEN {
            return Err("cursor too short");
        }
        let (body, tag) = buf.split_at(buf.len() - MAC_LEN);
        let mut mac = secret.mac();
        mac.update(body);
        mac.verify_truncated_left(tag).map_err(|_| "cursor signature")?;
        if body[0] != VERSION {
            return Err("cursor version");
        }
        if body[1] != sort {
            return Err("cursor belongs to another sort order");
        }
        if body[2..10] != fingerprint {
            return Err("cursor belongs to another query");
        }
        let rest = &body[10..];
        let (key, rest) = match kind {
            KeyKind::Score => (CursorKey::Score(f64::from_bits(be_u64(rest)?)), &rest[8..]),
            KeyKind::Int => (CursorKey::Int(be_u64(rest)? as i64), &rest[8..]),
            KeyKind::Featured => {
                let flag = *rest.first().ok_or("cursor truncated")?;
                if flag > 1 {
                    return Err("cursor flag");
                }
                (CursorKey::Featured(flag == 1, f64::from_bits(be_u64(&rest[1..])?)), &rest[9.min(rest.len())..])
            }
            KeyKind::Text => {
                let len = usize::from(u16::from_be_bytes(
                    rest.get(..2).ok_or("cursor truncated")?.try_into().unwrap_or([0, 0]),
                ));
                let text = rest.get(2..2 + len).ok_or("cursor truncated")?;
                let text = std::str::from_utf8(text).map_err(|_| "cursor text")?;
                (CursorKey::Text(text.to_owned()), &rest[2 + len..])
            }
        };
        if let CursorKey::Score(f) | CursorKey::Featured(_, f) = key
            && !f.is_finite()
        {
            return Err("cursor score");
        }
        if rest.len() != 8 {
            return Err("cursor length");
        }
        let id = be_u64(rest)? as i64;
        if id <= 0 {
            return Err("cursor id");
        }
        Ok(Cursor { sort, fingerprint, key, id })
    }
}

/// Key layout of a sort order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// One `f64` score.
    Score,
    /// One `i64`.
    Int,
    /// Featured flag and popularity score.
    Featured,
    /// A UTF-8 string.
    Text,
}

fn be_u64(b: &[u8]) -> Result<u64, &'static str> {
    Ok(u64::from_be_bytes(b.get(..8).ok_or("cursor truncated")?.try_into().map_err(|_| "cursor truncated")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> CursorSecret {
        CursorSecret::derive(b"test secret material")
    }

    #[test]
    fn round_trips_every_key_kind() {
        let fp = [1, 2, 3, 4, 5, 6, 7, 8];
        for (kind, key) in [
            (KeyKind::Score, CursorKey::Score(-12.345_678_9)),
            (KeyKind::Int, CursorKey::Int(1_762_950_892_000)),
            (KeyKind::Featured, CursorKey::Featured(true, 1.25)),
            (KeyKind::Text, CursorKey::Text("piece of cake – merge".into())),
        ] {
            let c = Cursor { sort: 3, fingerprint: fp, key, id: 42 };
            let s = c.encode(&secret());
            assert!(s.len() < MAX_CURSOR_LEN);
            assert_eq!(Cursor::decode(&s, &secret(), 3, fp, kind).unwrap(), c);
        }
    }

    #[test]
    fn tampering_and_replay_are_rejected() {
        let fp = [9; 8];
        let c = Cursor { sort: 1, fingerprint: fp, key: CursorKey::Score(2.5), id: 7 };
        let s = c.encode(&secret());
        // Flip one bit anywhere.
        let mut raw = URL_SAFE_NO_PAD.decode(&s).unwrap();
        for i in 0..raw.len() {
            raw[i] ^= 1;
            let t = URL_SAFE_NO_PAD.encode(&raw);
            assert!(Cursor::decode(&t, &secret(), 1, fp, KeyKind::Score).is_err(), "bit flip at {i}");
            raw[i] ^= 1;
        }
        assert_eq!(Cursor::decode(&s, &secret(), 2, fp, KeyKind::Score), Err("cursor belongs to another sort order"));
        assert_eq!(Cursor::decode(&s, &secret(), 1, [0; 8], KeyKind::Score), Err("cursor belongs to another query"));
        assert!(Cursor::decode(&s, &CursorSecret::derive(b"other"), 1, fp, KeyKind::Score).is_err());
        for junk in ["", "!!!!", "AAAA", &"A".repeat(600)] {
            assert!(Cursor::decode(junk, &secret(), 1, fp, KeyKind::Score).is_err(), "{junk}");
        }
        // Right MAC, wrong layout (a Score cursor read as Text) is rejected by the length checks.
        assert!(Cursor::decode(&s, &secret(), 1, fp, KeyKind::Text).is_err());
    }
}
