//! Wisp tickets: `w2.<exp_s>.<iat_s>.<route>.<session_ref>.<mac>` (ARCHITECTURE §4.6, API.md `POST /api/wisp/ticket`;
//! route-bound since Wave C D23).
//!
//! The proxy origin cannot see the app's cookies, so the app mints a ticket for its session and the route it chose,
//! and hands it to the engine host, which connects to `/wisp/?t=<ticket>&/` or `/wisp/p/<id>/?t=<ticket>&/` (URL
//! forms: `gateway::ticket_param`). A ticket authorizes Wisp only (no API access), and only on its own route.
//!
//! * `exp_s`: expiry, Unix seconds, decimal without leading zeros.
//! * `iat_s`: mint time, Unix seconds, same form. The gateway refuses tickets minted before its process started and
//!   default-route tickets minted before the session's latest profile-route ticket (`gateway::Gateway`).
//! * `route`: `d` (the direct route, `/wisp/`) or `p` followed by the profile id in unpadded base64url (`/wisp/p/<id>/`;
//!   ids are encoded because the separator `.` must never appear in them).
//! * `session_ref`: 16 bytes, base64url — a stable, non-secret digest of the session that cannot be turned back into
//!   a credential, so per-session caps apply across tickets ([`SessionRef`]).
//! * `mac`: HMAC-SHA256 over everything before it with a key derived from the master secret under its own label
//!   (`wisp-ticket/…`), never the anonymous-session key. Like that key it is bound to the access policy (mode and
//!   access code), so rotating the code or switching modes invalidates outstanding tickets.
//!
//! Parsing is strict (exact lengths, canonical base64url, digits only) and the MAC is compared in constant time
//! before anything else is looked at. `w1` tickets (no route) are refused as malformed.

use crate::auth::sessions::TokenHash;
use crate::config::AccessMode;
use crate::security::crypto::{b64url, b64url_decode, hmac_sha256, hmac_sha256_verify, sha256, sha256_hex};
use crate::security::secret_key::SecretKey;
use crate::util::Secret;

/// Ticket format version (first component).
pub const VERSION: &str = "w2";
/// Longest profile id a ticket can carry (profile ids are at most 32 characters today, `vpn::profiles`).
pub const MAX_PROFILE_ID_LEN: usize = 64;
/// Upper bound on the textual length: `w2.` + 12 digits + `.` + 12 digits + `.` + `p` + 86 (64 bytes in base64url)
/// + `.` + 22 + `.` + 43 = 183.
pub const MAX_LEN: usize = 192;
const REF_B64_LEN: usize = 22;
const MAC_B64_LEN: usize = 43;
const MAX_DIGITS: usize = 12;

/// The route a ticket is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TicketRoute {
    /// `/wisp/`: this server's own connection.
    Default,
    /// `/wisp/p/<id>/`: a VPN location.
    Profile(String),
}

impl TicketRoute {
    fn encode(&self) -> String {
        match self {
            Self::Default => "d".into(),
            Self::Profile(id) => format!("p{}", b64url(id.as_bytes())),
        }
    }

    fn decode(s: &str) -> Option<Self> {
        if s == "d" {
            return Some(Self::Default);
        }
        let b64 = s.strip_prefix('p')?;
        if b64.is_empty() || b64.len() > 86 {
            return None;
        }
        let bytes = b64url_decode(b64)?;
        // Canonical only: re-encoding must give the same text.
        if b64url(&bytes) != b64 || bytes.is_empty() || bytes.len() > MAX_PROFILE_ID_LEN {
            return None;
        }
        let id = String::from_utf8(bytes).ok()?;
        id.bytes().all(|b| b.is_ascii_graphic()).then_some(Self::Profile(id))
    }

    /// `"default"` or `"profile:<id>"` (logs and diagnostics).
    pub fn describe(&self) -> String {
        match self {
            Self::Default => "default".into(),
            Self::Profile(id) => format!("profile:{id}"),
        }
    }
}

/// Per-session identifier carried by tickets (16 bytes).
///
/// * Anonymous session: SHA-256 of a label and the token's random part, truncated — stable across refreshes of
///   the same `gnome_sid`.
/// * User session: the first 16 bytes of the session's stored token hash (itself SHA-256 of the 32 random cookie
///   bytes). Neither the cookie nor the full hash can be recovered from it, and the gateway can find the session
///   row by primary-key prefix to reject tickets of revoked sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionRef(pub [u8; 16]);

impl SessionRef {
    pub fn for_anonymous(token_id: &str) -> Self {
        let mut input = b"gnome/wisp-ref/anonymous\0".to_vec();
        input.extend_from_slice(token_id.as_bytes());
        let digest = sha256(&input);
        let mut r = [0u8; 16];
        r.copy_from_slice(&digest[..16]);
        Self(r)
    }

    pub fn for_user(token_hash: &TokenHash) -> Self {
        let mut r = [0u8; 16];
        r.copy_from_slice(&token_hash[..16]);
        Self(r)
    }

    pub fn to_b64(self) -> String {
        b64url(&self.0)
    }
}

/// A verified ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub session_ref: SessionRef,
    /// Unix seconds.
    pub expires_at_s: u64,
    /// Unix seconds: when it was minted.
    pub issued_at_s: u64,
    pub route: TicketRoute,
}

/// Why a ticket was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketError {
    /// Not of the form `w2.<digits>.<digits>.<route>.<22 base64url>.<43 base64url>`.
    Malformed,
    /// Well-formed, but the MAC does not match (forged, tampered, other server or other access policy).
    BadMac,
    Expired,
}

impl TicketError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Malformed => "malformed Wisp ticket",
            Self::BadMac => "invalid Wisp ticket",
            Self::Expired => "expired Wisp ticket",
        }
    }
}

/// Signing key for tickets.
#[derive(Clone)]
pub struct TicketKey([u8; 32]);

impl std::fmt::Debug for TicketKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TicketKey(<redacted>)")
    }
}

fn canonical_digits(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_DIGITS && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

impl TicketKey {
    /// Key for the given access policy (see the module docs).
    pub fn new(secret: &SecretKey, mode: AccessMode, access_code: Option<&Secret>) -> Self {
        let purpose = match (mode, access_code) {
            (AccessMode::Code, Some(code)) => format!("wisp-ticket/code/{}", sha256_hex(code.expose().as_bytes())),
            (mode, _) => format!("wisp-ticket/{}", mode.as_str()),
        };
        Self(secret.derive(&purpose))
    }

    /// The ticket string for `session_ref` on `route`, minted at `issued_at_s`, valid until `expires_at_s`.
    pub fn mint(&self, session_ref: SessionRef, route: &TicketRoute, issued_at_s: u64, expires_at_s: u64) -> String {
        let payload = format!("{VERSION}.{expires_at_s}.{issued_at_s}.{}.{}", route.encode(), session_ref.to_b64());
        let mac = hmac_sha256(&self.0, &[payload.as_bytes()]);
        format!("{payload}.{}", b64url(&mac))
    }

    /// Verify format, MAC (constant time) and expiry. The route, mint time and session rules are the gateway's.
    pub fn verify(&self, ticket: &str, now_s: u64) -> Result<Ticket, TicketError> {
        if ticket.len() > MAX_LEN || !ticket.is_ascii() {
            return Err(TicketError::Malformed);
        }
        let parts: Vec<&str> = ticket.split('.').collect();
        let [ver, exp, iat, route, sref, mac] = parts[..] else {
            return Err(TicketError::Malformed);
        };
        if ver != VERSION
            || !canonical_digits(exp)
            || !canonical_digits(iat)
            || route.is_empty()
            || sref.len() != REF_B64_LEN
            || mac.len() != MAC_B64_LEN
        {
            return Err(TicketError::Malformed);
        }
        let sref_bytes: [u8; 16] = b64url_decode(sref).and_then(|b| b.try_into().ok()).ok_or(TicketError::Malformed)?;
        let mac_bytes = b64url_decode(mac).filter(|m| m.len() == 32).ok_or(TicketError::Malformed)?;
        let payload = &ticket[..ticket.len() - mac.len() - 1];
        if !hmac_sha256_verify(&self.0, &[payload.as_bytes()], &mac_bytes) {
            return Err(TicketError::BadMac);
        }
        let route = TicketRoute::decode(route).ok_or(TicketError::Malformed)?;
        let expires_at_s: u64 = exp.parse().map_err(|_| TicketError::Malformed)?;
        let issued_at_s: u64 = iat.parse().map_err(|_| TicketError::Malformed)?;
        if expires_at_s <= now_s {
            return Err(TicketError::Expired);
        }
        Ok(Ticket { session_ref: SessionRef(sref_bytes), expires_at_s, issued_at_s, route })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::anon::AnonKey;

    const D: TicketRoute = TicketRoute::Default;

    fn secret(byte: u8) -> SecretKey {
        SecretKey::from_bytes(vec![byte; 32]).unwrap()
    }

    fn key(byte: u8) -> TicketKey {
        TicketKey::new(&secret(byte), AccessMode::Open, None)
    }

    #[test]
    fn mint_and_verify() {
        let k = key(1);
        let r = SessionRef::for_anonymous("AAAAAAAAAAAAAAAAAAAAAA");
        let t = k.mint(r, &D, 1_000, 2_000);
        assert!(t.starts_with("w2.2000.1000.d."), "{t}");
        assert_eq!(t.split('.').count(), 6);
        assert!(t.len() <= MAX_LEN);
        assert_eq!(
            k.verify(&t, 1_999),
            Ok(Ticket { session_ref: r, expires_at_s: 2_000, issued_at_s: 1_000, route: TicketRoute::Default })
        );
        // A profile route round-trips, also the longest id with the separator in it.
        for id in ["e2e-vpn", &format!("{}.x", "a".repeat(MAX_PROFILE_ID_LEN - 2))] {
            let route = TicketRoute::Profile(id.to_string());
            let t = k.mint(r, &route, 1_000, 999_999_999_999);
            assert!(t.len() <= MAX_LEN, "{} > {MAX_LEN}", t.len());
            assert_eq!(t.split('.').count(), 6);
            assert_eq!(k.verify(&t, 1_999).map(|v| v.route), Ok(route));
        }
        // Same session, same ref; another session, another ref.
        assert_eq!(SessionRef::for_anonymous("AAAAAAAAAAAAAAAAAAAAAA"), r);
        assert_ne!(SessionRef::for_anonymous("AAAAAAAAAAAAAAAAAAAAAB"), r);
        let hash = sha256(b"user token");
        assert_eq!(SessionRef::for_user(&hash).0, hash[..16]);
    }

    #[test]
    fn expiry_is_exclusive() {
        let k = key(1);
        let t = k.mint(SessionRef([7; 16]), &D, 1_000, 2_000);
        assert!(k.verify(&t, 1_999).is_ok());
        assert_eq!(k.verify(&t, 2_000), Err(TicketError::Expired));
        assert_eq!(k.verify(&t, u64::MAX), Err(TicketError::Expired));
    }

    #[test]
    fn tampering_is_detected() {
        let k = key(1);
        let t = k.mint(SessionRef([7; 16]), &D, 1_000, 2_000);
        let p: Vec<&str> = t.split('.').collect();
        // A longer expiry, a later mint time, another route, another session ref, a flipped MAC character: all fail
        // the MAC.
        let longer = format!("w2.9999999999.{}.{}.{}.{}", p[2], p[3], p[4], p[5]);
        assert_eq!(k.verify(&longer, 1_000), Err(TicketError::BadMac));
        let later = format!("w2.{}.1500.{}.{}.{}", p[1], p[3], p[4], p[5]);
        assert_eq!(k.verify(&later, 1_000), Err(TicketError::BadMac));
        let rerouted = format!("w2.{}.{}.{}.{}.{}", p[1], p[2], TicketRoute::Profile("x".into()).encode(), p[4], p[5]);
        assert_eq!(k.verify(&rerouted, 1_000), Err(TicketError::BadMac));
        let other_ref = format!("w2.{}.{}.{}.{}.{}", p[1], p[2], p[3], SessionRef([8; 16]).to_b64(), p[5]);
        assert_eq!(k.verify(&other_ref, 1_000), Err(TicketError::BadMac));
        let mut bytes = t.clone().into_bytes();
        let i = bytes.len() - 5;
        bytes[i] = if bytes[i] == b'A' { b'B' } else { b'A' };
        assert_eq!(k.verify(std::str::from_utf8(&bytes).unwrap(), 1_000), Err(TicketError::BadMac));
        // Another server (other master secret).
        assert_eq!(key(2).verify(&t, 1_000), Err(TicketError::BadMac));
    }

    #[test]
    fn wrong_domain_keys_and_formats_are_refused() {
        let s = secret(3);
        let k = TicketKey::new(&s, AccessMode::Open, None);
        let r = SessionRef([9; 16]);
        // A MAC made with the anonymous-session subkey over a ticket payload must not verify.
        let payload = format!("w2.5000.1000.d.{}", r.to_b64());
        let anon_mac = hmac_sha256(&s.derive("anon-session/open"), &[payload.as_bytes()]);
        assert_eq!(k.verify(&format!("{payload}.{}", b64url(&anon_mac)), 1_000), Err(TicketError::BadMac));
        // Nor one made with the master key itself.
        let master_mac = hmac_sha256(&[3; 32], &[payload.as_bytes()]);
        assert_eq!(k.verify(&format!("{payload}.{}", b64url(&master_mac)), 1_000), Err(TicketError::BadMac));
        // A session token is not a ticket, and a ticket is not a session token.
        let anon = AnonKey::new(&s, AccessMode::Open, None);
        let (session_token, _) = anon.issue(None, 1_000);
        assert_eq!(k.verify(&session_token, 1_000), Err(TicketError::Malformed));
        let ticket = k.mint(r, &D, 1_000, 5_000);
        assert!(anon.verify(&ticket, 1_000).is_none());
        let as_v1 = ticket.replacen("w2.", "v1.", 1);
        assert!(anon.verify(&as_v1, 1_000).is_none());
    }

    #[test]
    fn bound_to_the_access_policy() {
        let s = secret(4);
        let open = TicketKey::new(&s, AccessMode::Open, None);
        let accounts = TicketKey::new(&s, AccessMode::Accounts, None);
        let code_a = TicketKey::new(&s, AccessMode::Code, Some(&Secret::new("first-code-123")));
        let code_b = TicketKey::new(&s, AccessMode::Code, Some(&Secret::new("second-code-456")));
        let t = code_a.mint(SessionRef([1; 16]), &D, 1_000, 9_000);
        assert!(TicketKey::new(&s, AccessMode::Code, Some(&Secret::new("first-code-123"))).verify(&t, 1).is_ok());
        for other in [&open, &accounts, &code_b] {
            assert_eq!(other.verify(&t, 1), Err(TicketError::BadMac));
        }
    }

    #[test]
    fn malformed_tickets() {
        let k = key(5);
        let good = k.mint(SessionRef([2; 16]), &D, 1_000, 7_000);
        let p: Vec<&str> = good.split('.').collect();
        let (sref, mac) = (p[4], p[5]);
        // A MAC-valid ticket whose route text is not canonical must still be refused (`p` + non-canonical base64url,
        // an empty profile id, an unknown kind).
        let signed = |route: &str| {
            let payload = format!("w2.7000.1000.{route}.{sref}");
            let mac = hmac_sha256(&k.0, &[payload.as_bytes()]);
            format!("{payload}.{}", b64url(&mac))
        };
        let cases = [
            String::new(),
            "w2".into(),
            "w2.....".into(),
            format!("w1.7000.{sref}.{mac}"),
            format!("w1.7000.1000.d.{sref}.{mac}"),
            format!("W2.7000.1000.d.{sref}.{mac}"),
            format!("w2.07000.1000.d.{sref}.{mac}"),
            format!("w2.7000.01000.d.{sref}.{mac}"),
            format!("w2.+7000.1000.d.{sref}.{mac}"),
            format!("w2.7000.-1000.d.{sref}.{mac}"),
            format!("w2.7e3.1000.d.{sref}.{mac}"),
            format!("w2.1234567890123.1000.d.{sref}.{mac}"),
            format!("w2.7000..d.{sref}.{mac}"),
            format!("w2.7000.1000..{sref}.{mac}"),
            format!("w2.7000.1000.d.{sref}="),
            format!("w2.7000.1000.d.{sref}.{mac}."),
            format!("w2.7000.1000.d.{sref}.{mac}.extra"),
            format!("w2.7000.1000.d.{}.{mac}", &sref[..21]),
            format!("w2.7000.1000.d.{sref}A.{mac}"),
            format!("w2.7000.1000.d.{}+.{mac}", &sref[..21]),
            format!("w2.7000.1000.d.{sref}.{}", &mac[..42]),
            format!("w2.7000.1000.d.{sref}.{}/", &mac[..42]),
            format!("w2.7000.1000.d.{sref}.{mac}{}", "A".repeat(140)),
            format!("w2.7000.1000.d.{sref}.{}é", &mac[..41]),
            signed("p"),
            signed("pYR"),
            signed("x"),
            signed("dd"),
            signed(&format!("p{}", b64url(&[b'a'; MAX_PROFILE_ID_LEN + 1]))),
            signed(&format!("p{}", b64url(b"a b"))),
        ];
        for bad in cases {
            assert_eq!(k.verify(&bad, 1_000), Err(TicketError::Malformed), "{bad:?}");
        }
        // Non-canonical base64url (trailing bits set) is refused, not silently normalized.
        let last = sref.as_bytes()[21];
        let flipped = if last == b'A' { 'B' } else { 'A' };
        let noncanonical = format!("w2.7000.1000.d.{}{flipped}.{mac}", &sref[..21]);
        assert!(k.verify(&noncanonical, 1_000).is_err());
    }
}
