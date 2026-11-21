//! Signed-in sessions (`gnome_auth`): a random 32-byte token in the cookie, its SHA-256 in `user_sessions`.
//! Expiry slides forward by 30 days whenever the session is used (at most one write per hour per session).

use rusqlite::{Connection, OptionalExtension, params};

use super::users::User;
use crate::security::crypto::{b64url, b64url_decode, random_bytes, sha256};

/// Session lifetime after last use.
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Minimum time between expiry refreshes of one session.
pub const TOUCH_INTERVAL_MS: i64 = 60 * 60 * 1000;
/// Oldest sessions beyond this count are revoked when a user signs in again.
pub const MAX_SESSIONS_PER_USER: i64 = 50;

/// SHA-256 of a session token.
pub type TokenHash = [u8; 32];

/// Validate the cookie format (43 base64url chars = 32 bytes) and hash it. `None` = not one of our tokens.
pub fn hash_token(cookie: &str) -> Option<TokenHash> {
    if cookie.len() != 43 {
        return None;
    }
    let raw = b64url_decode(cookie)?;
    (raw.len() == 32).then(|| sha256(&raw))
}

/// A freshly created session.
#[derive(Debug, Clone)]
pub struct NewSession {
    /// Cookie value (shown to the client once, never stored).
    pub token: String,
    pub token_hash: TokenHash,
    pub expires_at: i64,
}

/// Create a session for `user_id`, revoking the oldest ones beyond [`MAX_SESSIONS_PER_USER`].
pub fn create(conn: &Connection, user_id: i64, now: i64) -> rusqlite::Result<NewSession> {
    let raw = random_bytes::<32>();
    let token = b64url(&raw);
    let token_hash = sha256(&raw);
    let expires_at = now + SESSION_TTL_MS;
    conn.prepare_cached(
        "INSERT INTO user_sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)",
    )?
    .execute(params![token_hash.as_slice(), user_id, now, expires_at])?;
    conn.prepare_cached(
        "DELETE FROM user_sessions WHERE user_id = ?1 AND token_hash NOT IN
           (SELECT token_hash FROM user_sessions WHERE user_id = ?1 ORDER BY created_at DESC, token_hash LIMIT ?2)",
    )?
    .execute(params![user_id, MAX_SESSIONS_PER_USER])?;
    Ok(NewSession { token, token_hash, expires_at })
}

/// A live session joined with its user.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub user: User,
    pub expires_at: i64,
    pub last_seen_at: i64,
}

pub fn lookup(conn: &Connection, token_hash: &TokenHash, now: i64) -> rusqlite::Result<Option<SessionRow>> {
    conn.prepare_cached(
        "SELECT u.id, u.username, u.is_admin, u.created_at, s.expires_at, s.last_seen_at
           FROM user_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1 AND s.expires_at > ?2",
    )?
    .query_row(params![token_hash.as_slice(), now], |r| {
        Ok(SessionRow {
            user: User { id: r.get(0)?, username: r.get(1)?, is_admin: r.get(2)?, created_at: r.get(3)? },
            expires_at: r.get(4)?,
            last_seen_at: r.get(5)?,
        })
    })
    .optional()
}

/// Whether a live (unexpired) session exists whose token hash starts with `prefix` (a Wisp ticket's
/// `session_ref`). Token hashes are exactly 32 bytes, so the rows with that prefix are the primary-key range
/// `prefix‖00…00 ..= prefix‖ff…ff`: one index seek.
pub fn live_by_prefix(conn: &Connection, prefix: &[u8; 16], now: i64) -> rusqlite::Result<bool> {
    let mut low = [0u8; 32];
    let mut high = [0xffu8; 32];
    low[..16].copy_from_slice(prefix);
    high[..16].copy_from_slice(prefix);
    conn.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM user_sessions WHERE token_hash BETWEEN ?1 AND ?2 AND expires_at > ?3)",
    )?
    .query_row(params![low.as_slice(), high.as_slice(), now], |r| r.get(0))
}

/// Whether a session last refreshed at `last_seen_at` should be refreshed now.
pub fn needs_touch(last_seen_at: i64, now: i64) -> bool {
    now - last_seen_at >= TOUCH_INTERVAL_MS
}

/// Slide the expiry. Returns the new expiry, or `None` if the session no longer exists.
pub fn touch(conn: &Connection, token_hash: &TokenHash, now: i64) -> rusqlite::Result<Option<i64>> {
    let expires_at = now + SESSION_TTL_MS;
    let n = conn
        .prepare_cached(
            "UPDATE user_sessions SET last_seen_at = ?2, expires_at = ?3 WHERE token_hash = ?1 AND expires_at > ?2",
        )?
        .execute(params![token_hash.as_slice(), now, expires_at])?;
    Ok((n == 1).then_some(expires_at))
}

pub fn delete(conn: &Connection, token_hash: &TokenHash) -> rusqlite::Result<()> {
    conn.prepare_cached("DELETE FROM user_sessions WHERE token_hash = ?1")?.execute([token_hash.as_slice()])?;
    Ok(())
}

/// Revoke every session of `user_id` except `keep`.
pub fn delete_others(conn: &Connection, user_id: i64, keep: &TokenHash) -> rusqlite::Result<usize> {
    conn.prepare_cached("DELETE FROM user_sessions WHERE user_id = ?1 AND token_hash != ?2")?
        .execute(params![user_id, keep.as_slice()])
}

pub fn delete_all_for_user(conn: &Connection, user_id: i64) -> rusqlite::Result<usize> {
    conn.prepare_cached("DELETE FROM user_sessions WHERE user_id = ?1")?.execute([user_id])
}

/// Remove expired sessions (hourly job).
pub fn cleanup_expired(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.prepare_cached("DELETE FROM user_sessions WHERE expires_at <= ?1")?.execute([now])
}

pub fn count_active(conn: &Connection, now: i64) -> rusqlite::Result<i64> {
    conn.query_row("SELECT count(*) FROM user_sessions WHERE expires_at > ?1", [now], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::users;

    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::db::migrate::run(&mut c).unwrap();
        c
    }

    #[test]
    fn lifecycle() {
        let c = db();
        let u = users::insert(&c, "alice", "$argon2id$x", false, 1_000).unwrap();
        let s = create(&c, u.id, 1_000).unwrap();
        assert_eq!(hash_token(&s.token), Some(s.token_hash));
        let row = lookup(&c, &s.token_hash, 2_000).unwrap().unwrap();
        assert_eq!(row.user, u);
        assert_eq!(row.expires_at, 1_000 + SESSION_TTL_MS);
        assert!(!needs_touch(row.last_seen_at, 2_000));
        let later = 1_000 + TOUCH_INTERVAL_MS;
        assert!(needs_touch(row.last_seen_at, later));
        assert_eq!(touch(&c, &s.token_hash, later).unwrap(), Some(later + SESSION_TTL_MS));
        // Expired sessions are invisible and cleaned up.
        let after = later + SESSION_TTL_MS;
        assert!(lookup(&c, &s.token_hash, after).unwrap().is_none());
        assert_eq!(touch(&c, &s.token_hash, after).unwrap(), None);
        assert_eq!(cleanup_expired(&c, after).unwrap(), 1);
    }

    #[test]
    fn revocation_and_cap() {
        let c = db();
        let u = users::insert(&c, "bob", "$argon2id$x", false, 0).unwrap();
        let keep = create(&c, u.id, 10).unwrap();
        let other = create(&c, u.id, 11).unwrap();
        assert_eq!(delete_others(&c, u.id, &keep.token_hash).unwrap(), 1);
        assert!(lookup(&c, &other.token_hash, 12).unwrap().is_none());
        assert!(lookup(&c, &keep.token_hash, 12).unwrap().is_some());
        for i in 0..(MAX_SESSIONS_PER_USER + 5) {
            create(&c, u.id, 100 + i).unwrap();
        }
        assert_eq!(count_active(&c, 200).unwrap(), MAX_SESSIONS_PER_USER);
        assert!(lookup(&c, &keep.token_hash, 200).unwrap().is_none(), "oldest revoked first");
        // Deleting the user cascades.
        users::delete(&c, u.id).unwrap();
        assert_eq!(count_active(&c, 200).unwrap(), 0);
    }

    #[test]
    fn live_sessions_by_prefix() {
        let c = db();
        let u = users::insert(&c, "carol", "$argon2id$x", false, 0).unwrap();
        let s = create(&c, u.id, 1_000).unwrap();
        let prefix: [u8; 16] = s.token_hash[..16].try_into().unwrap();
        assert!(live_by_prefix(&c, &prefix, 2_000).unwrap());
        let mut other = prefix;
        other[15] ^= 1;
        assert!(!live_by_prefix(&c, &other, 2_000).unwrap());
        assert!(!live_by_prefix(&c, &prefix, s.expires_at).unwrap(), "expired");
        // Edge prefixes stay inside their own range.
        assert!(!live_by_prefix(&c, &[0xff; 16], 2_000).unwrap());
        assert!(!live_by_prefix(&c, &[0; 16], 2_000).unwrap());
        delete(&c, &s.token_hash).unwrap();
        assert!(!live_by_prefix(&c, &prefix, 2_000).unwrap(), "revoked");
        let plan: String = c
            .query_row(
                "EXPLAIN QUERY PLAN SELECT 1 FROM user_sessions WHERE token_hash BETWEEN ?1 AND ?2 AND expires_at > ?3",
                params![[0u8; 32].as_slice(), [1u8; 32].as_slice(), 0],
                |r| r.get(3),
            )
            .unwrap();
        assert!(plan.contains("SEARCH") && plan.contains("PRIMARY KEY"), "index seek: {plan}");
    }

    #[test]
    fn token_format() {
        assert!(hash_token("short").is_none());
        assert!(hash_token(&"!".repeat(43)).is_none());
        assert!(hash_token(&b64url(&[1u8; 32])).is_some());
    }
}
