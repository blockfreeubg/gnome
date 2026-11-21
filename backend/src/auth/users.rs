//! User rows. Functions take a `rusqlite::Connection` so callers compose them inside one `Db::write` transaction.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;

/// `User` as returned by the API (API.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub created_at: i64,
}

/// A user with the stored password hash (never serialized).
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub user: User,
    pub password_hash: String,
}

const COLUMNS: &str = "id, username, is_admin, created_at, password_hash";

fn record(r: &Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        user: User { id: r.get(0)?, username: r.get(1)?, is_admin: r.get(2)?, created_at: r.get(3)? },
        password_hash: r.get(4)?,
    })
}

/// Case-insensitive lookup.
pub fn find_by_username(conn: &Connection, username: &str) -> rusqlite::Result<Option<UserRecord>> {
    conn.prepare_cached(&format!("SELECT {COLUMNS} FROM users WHERE username = ?1"))?
        .query_row([username], record)
        .optional()
}

pub fn find_by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<UserRecord>> {
    conn.prepare_cached(&format!("SELECT {COLUMNS} FROM users WHERE id = ?1"))?.query_row([id], record).optional()
}

/// Outcome of [`insert`].
#[derive(Debug)]
pub enum InsertError {
    UsernameTaken,
    Sqlite(rusqlite::Error),
}

impl From<rusqlite::Error> for InsertError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

pub fn insert(
    conn: &Connection,
    username: &str,
    password_hash: &str,
    is_admin: bool,
    now: i64,
) -> Result<User, InsertError> {
    let res = conn
        .prepare_cached(
            "INSERT INTO users (username, password_hash, is_admin, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        )?
        .execute(params![username, password_hash, is_admin, now]);
    match res {
        Ok(_) => Ok(User { id: conn.last_insert_rowid(), username: username.to_string(), is_admin, created_at: now }),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            Err(InsertError::UsernameTaken)
        }
        Err(e) => Err(e.into()),
    }
}

pub fn set_password(conn: &Connection, id: i64, password_hash: &str, now: i64) -> rusqlite::Result<bool> {
    let n = conn
        .prepare_cached("UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1")?
        .execute(params![id, password_hash, now])?;
    Ok(n == 1)
}

pub fn record_login(conn: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    conn.prepare_cached("UPDATE users SET last_login_at = ?2 WHERE id = ?1")?.execute(params![id, now])?;
    Ok(())
}

/// Delete a user; sessions, settings, bookmarks and history go with it (ON DELETE CASCADE).
pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(conn.prepare_cached("DELETE FROM users WHERE id = ?1")?.execute([id])? == 1)
}

pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT count(*) FROM users", [], |r| r.get(0))
}
