//! Anonymous session tokens: `v1.<exp_s>.<rand_b64url>.<hmac_b64url>`.
//!
//! `rand` is 16 random bytes and identifies the session (it is kept when a token is refreshed, so per-session
//! limits survive refreshes). The HMAC-SHA256 covers `v1.<exp_s>.<rand>` and uses a subkey derived from the master
//! secret; verification is constant-time and checks expiry.
//!
//! The subkey is bound to the access policy: it depends on `GNOME_ACCESS_MODE` and, in `code` mode, on the access
//! code. Rotating the code (or switching from `open` to `code`) therefore invalidates every anonymous session issued
//! under the old policy — otherwise a session obtained with a revoked code could be refreshed forever.

use crate::config::AccessMode;
use crate::security::crypto::{b64url, b64url_decode, hmac_sha256, hmac_sha256_verify, random_bytes, sha256_hex};
use crate::security::secret_key::SecretKey;
use crate::util::Secret;

/// Lifetime of an anonymous session (30 days).
pub const ANON_TTL_S: u64 = 30 * 24 * 60 * 60;

const VERSION: &str = "v1";
const RAND_LEN: usize = 16;
const RAND_B64_LEN: usize = 22;
const MAC_B64_LEN: usize = 43;
const MAX_TOKEN_LEN: usize = 128;

/// A verified anonymous session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnonToken {
    /// The `rand` component (stable session identifier).
    pub id: String,
    /// Expiry, Unix seconds.
    pub expires_at_s: u64,
}

impl AnonToken {
    pub fn expires_at_ms(&self) -> i64 {
        i64::try_from(self.expires_at_s.saturating_mul(1000)).unwrap_or(i64::MAX)
    }
}

/// Signing key for anonymous tokens.
#[derive(Clone)]
pub struct AnonKey([u8; 32]);

impl std::fmt::Debug for AnonKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AnonKey(<redacted>)")
    }
}

impl AnonKey {
    /// Key for the given access policy (see the module docs).
    pub fn new(secret: &SecretKey, mode: AccessMode, access_code: Option<&Secret>) -> Self {
        let purpose = match (mode, access_code) {
            (AccessMode::Code, Some(code)) => format!("anon-session/code/{}", sha256_hex(code.expose().as_bytes())),
            (mode, _) => format!("anon-session/{}", mode.as_str()),
        };
        Self(secret.derive(&purpose))
    }

    /// Issue a token valid for [`ANON_TTL_S`]. Pass the id of a still-valid token to refresh it.
    pub fn issue(&self, keep_id: Option<&str>, now_s: u64) -> (String, AnonToken) {
        let id = keep_id.map_or_else(|| b64url(&random_bytes::<RAND_LEN>()), str::to_string);
        let exp = now_s + ANON_TTL_S;
        let payload = format!("{VERSION}.{exp}.{id}");
        let mac = hmac_sha256(&self.0, &[payload.as_bytes()]);
        (format!("{payload}.{}", b64url(&mac)), AnonToken { id, expires_at_s: exp })
    }

    /// Verify signature, format and expiry.
    pub fn verify(&self, token: &str, now_s: u64) -> Option<AnonToken> {
        if token.len() > MAX_TOKEN_LEN {
            return None;
        }
        let mut parts = token.split('.');
        let (ver, exp, id, mac) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() || ver != VERSION {
            return None;
        }
        if exp.is_empty() || exp.len() > 12 || !exp.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        if id.len() != RAND_B64_LEN || b64url_decode(id)?.len() != RAND_LEN || mac.len() != MAC_B64_LEN {
            return None;
        }
        let mac = b64url_decode(mac)?;
        let payload = &token[..ver.len() + 1 + exp.len() + 1 + id.len()];
        if !hmac_sha256_verify(&self.0, &[payload.as_bytes()], &mac) {
            return None;
        }
        let exp: u64 = exp.parse().ok()?;
        (exp > now_s).then(|| AnonToken { id: id.to_string(), expires_at_s: exp })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> AnonKey {
        AnonKey::new(&SecretKey::from_bytes(vec![byte; 32]).unwrap(), AccessMode::Open, None)
    }

    #[test]
    fn sign_and_verify() {
        let k = key(1);
        let (token, t) = k.issue(None, 1_000);
        assert!(token.starts_with("v1.2593000."), "{token}");
        assert_eq!(k.verify(&token, 1_000), Some(t.clone()));
        assert_eq!(t.expires_at_s, 1_000 + ANON_TTL_S);
        // Refresh keeps the id.
        let (token2, t2) = k.issue(Some(&t.id), 5_000);
        assert_ne!(token, token2);
        assert_eq!(t2.id, t.id);
        assert_eq!(k.verify(&token2, 5_000).unwrap().id, t.id);
    }

    #[test]
    fn expiry() {
        let k = key(1);
        let (token, t) = k.issue(None, 1_000);
        assert!(k.verify(&token, t.expires_at_s - 1).is_some());
        assert!(k.verify(&token, t.expires_at_s).is_none());
    }

    #[test]
    fn tampering_and_wrong_key() {
        let k = key(1);
        let (token, _) = k.issue(None, 1_000);
        assert!(key(2).verify(&token, 1_000).is_none());
        // Extend the expiry without re-signing.
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged_exp = "9999999999";
        parts[1] = forged_exp;
        assert!(k.verify(&parts.join("."), 1_000).is_none());
        // Flip one MAC character.
        let mut bytes = token.clone().into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        assert!(k.verify(std::str::from_utf8(&bytes).unwrap(), 1_000).is_none());
        for junk in ["", "v1", "v1.1.2.3", "v2.9999999999.AAAAAAAAAAAAAAAAAAAAAA.x", &format!("{token}.extra")] {
            assert!(k.verify(junk, 1_000).is_none(), "{junk}");
        }
    }

    #[test]
    fn bound_to_the_access_policy() {
        let secret = SecretKey::from_bytes(vec![9; 32]).unwrap();
        let open = AnonKey::new(&secret, AccessMode::Open, None);
        let code_a = AnonKey::new(&secret, AccessMode::Code, Some(&Secret::new("first-code")));
        let code_a_again = AnonKey::new(&secret, AccessMode::Code, Some(&Secret::new("first-code")));
        let code_b = AnonKey::new(&secret, AccessMode::Code, Some(&Secret::new("second-code")));
        let (token, _) = code_a.issue(None, 1_000);
        assert!(code_a_again.verify(&token, 1_000).is_some(), "same policy, same key (restarts keep sessions)");
        assert!(code_b.verify(&token, 1_000).is_none(), "a rotated access code revokes old sessions");
        assert!(open.verify(&token, 1_000).is_none());
        let (open_token, _) = open.issue(None, 1_000);
        assert!(code_a.verify(&open_token, 1_000).is_none(), "open-mode sessions do not bypass code mode");
    }
}
