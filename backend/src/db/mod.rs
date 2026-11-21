//! SQLite access.
//!
//! * One **writer** connection serialized behind an async mutex; work runs on the blocking pool
//!   (`spawn_blocking`) so the async workers never block on disk.
//! * A small pool of **read-only** connections (`GNOME_DB_READERS`, default 4). WAL mode lets readers proceed while
//!   the writer commits.
//! * Pragmas are tuned for a Raspberry Pi 4 (small page cache, modest mmap, `synchronous=NORMAL` which is durable
//!   across application crashes and only loses the last transactions on power loss in WAL mode).
//!
//! Closures passed to [`Db::read`]/[`Db::write`] get a plain `rusqlite::Connection`; use `prepare_cached`.

pub mod migrate;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Errors from the database layer.
#[derive(Debug)]
pub enum DbError {
    Sqlite(rusqlite::Error),
    Migration(String),
    /// The blocking task panicked or was cancelled.
    Task(String),
    Io(std::io::Error),
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "sqlite: {e}"),
            Self::Migration(e) => write!(f, "migration: {e}"),
            Self::Task(e) => write!(f, "database task failed: {e}"),
            Self::Io(e) => write!(f, "database file: {e}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const STATEMENT_CACHE: usize = 64;

/// Handle to the database (cheap to clone).
#[derive(Clone)]
pub struct Db {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    writer: Arc<tokio::sync::Mutex<Connection>>,
    readers: Mutex<Vec<Connection>>,
    reader_permits: Arc<Semaphore>,
    reader_count: usize,
}

impl fmt::Debug for Db {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Db").field("path", &self.inner.path).field("readers", &self.inner.reader_count).finish()
    }
}

/// Create the database file with owner-only permissions if it does not exist yet (SQLite gives the `-wal`/`-shm`
/// files the same mode). The parent directory must exist.
fn precreate_private(path: &Path) -> std::io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    opts.open(path).map(drop)
}

/// Open and configure the writer connection.
pub fn open_writer(path: &Path) -> Result<Connection, DbError> {
    precreate_private(path).map_err(DbError::Io)?;
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(DbError::Migration(format!("could not enable WAL mode (got {mode})")));
    }
    conn.execute_batch(
        "PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA cache_size = -8192;
         PRAGMA mmap_size = 33554432;
         PRAGMA temp_store = MEMORY;
         PRAGMA journal_size_limit = 67108864;",
    )?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    Ok(conn)
}

fn open_reader(path: &Path) -> Result<Connection, DbError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch(
        "PRAGMA query_only = ON;
         PRAGMA cache_size = -4096;
         PRAGMA mmap_size = 33554432;
         PRAGMA temp_store = MEMORY;",
    )?;
    conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
    Ok(conn)
}

/// Returns a borrowed reader to the pool even if the closure panics.
struct ReaderGuard {
    conn: Option<Connection>,
    inner: Arc<Inner>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for ReaderGuard {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.inner.readers.lock().unwrap_or_else(|e| e.into_inner()).push(conn);
        }
    }
}

impl Db {
    /// Open the database at `path`, apply all migrations, and start `readers` read-only connections.
    pub async fn open(path: PathBuf, readers: usize) -> Result<Self, DbError> {
        let p = path.clone();
        let (writer, report) = tokio::task::spawn_blocking(move || -> Result<_, DbError> {
            let mut writer = open_writer(&p)?;
            let report = migrate::run(&mut writer)?;
            Ok((writer, report))
        })
        .await
        .map_err(|e| DbError::Task(e.to_string()))??;
        for m in &report.applied {
            tracing::info!(version = m.0, name = m.1, "applied database migration");
        }
        let p = path.clone();
        let reader_conns = tokio::task::spawn_blocking(move || {
            (0..readers.max(1)).map(|_| open_reader(&p)).collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|e| DbError::Task(e.to_string()))??;
        let reader_count = reader_conns.len();
        Ok(Self {
            inner: Arc::new(Inner {
                path,
                writer: Arc::new(tokio::sync::Mutex::new(writer)),
                readers: Mutex::new(reader_conns),
                reader_permits: Arc::new(Semaphore::new(reader_count)),
                reader_count,
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// Run `f` on a read-only connection.
    pub async fn read<T, E, F>(&self, f: F) -> Result<T, E>
    where
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
        T: Send + 'static,
        E: From<DbError> + Send + 'static,
    {
        let permit = self
            .inner
            .reader_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| E::from(DbError::Task("reader pool closed".into())))?;
        let conn = self.inner.readers.lock().unwrap_or_else(|e| e.into_inner()).pop();
        let Some(conn) = conn else {
            return Err(E::from(DbError::Task("reader pool exhausted".into())));
        };
        let guard = ReaderGuard { conn: Some(conn), inner: self.inner.clone(), _permit: permit };
        tokio::task::spawn_blocking(move || {
            let guard = guard;
            f(guard.conn.as_ref().expect("reader present"))
        })
        .await
        .map_err(|e| E::from(DbError::Task(e.to_string())))?
    }

    /// Run `f` on the single writer connection (serialized). Use a transaction inside `f` for multi-statement work.
    pub async fn write<T, E, F>(&self, f: F) -> Result<T, E>
    where
        F: FnOnce(&mut Connection) -> Result<T, E> + Send + 'static,
        T: Send + 'static,
        E: From<DbError> + Send + 'static,
    {
        let mut guard = self.inner.writer.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || f(&mut guard)).await.map_err(|e| E::from(DbError::Task(e.to_string())))?
    }

    /// Size of the database file plus its WAL, in bytes.
    pub fn size_bytes(&self) -> u64 {
        let wal = {
            let mut s = self.inner.path.as_os_str().to_owned();
            s.push("-wal");
            PathBuf::from(s)
        };
        [&self.inner.path, &wal].iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum()
    }

    /// Flush the WAL into the main file and refresh planner statistics (shutdown / periodic maintenance).
    pub async fn checkpoint_and_optimize(&self) -> Result<(), DbError> {
        self.write(|conn| -> Result<(), DbError> {
            conn.execute_batch("PRAGMA optimize;")?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
            Ok(())
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_migrate_read_write() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path().join("gnome.db"), 2).await.unwrap();
        let n: i64 = db
            .write(|c| -> Result<i64, DbError> {
                c.execute("INSERT INTO kv (key, value, updated_at) VALUES ('t:a', '1', 0)", [])?;
                Ok(c.last_insert_rowid())
            })
            .await
            .unwrap();
        assert!(n > 0);
        let v: String = db
            .read(|c| -> Result<String, DbError> {
                Ok(c.query_row("SELECT value FROM kv WHERE key = 't:a'", [], |r| r.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(v, "1");
        // Readers are read-only.
        let err = db.read(|c| -> Result<usize, DbError> { Ok(c.execute("DELETE FROM kv", [])?) }).await;
        assert!(err.is_err());
        // Pragmas took effect on the writer.
        let (fk, mode): (i64, String) = db
            .write(|c| -> Result<(i64, String), DbError> {
                Ok((
                    c.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?,
                    c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
                ))
            })
            .await
            .unwrap();
        assert_eq!((fk, mode.as_str()), (1, "wal"));
        db.checkpoint_and_optimize().await.unwrap();
        assert!(db.size_bytes() > 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(db.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[tokio::test]
    async fn reader_survives_panics() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path().join("gnome.db"), 1).await.unwrap();
        let r: Result<(), DbError> = db.read(|_| panic!("boom")).await;
        assert!(matches!(r, Err(DbError::Task(_))));
        // The single reader was returned to the pool.
        let one: i64 =
            db.read(|c| -> Result<i64, DbError> { Ok(c.query_row("SELECT 1", [], |r| r.get(0))?) }).await.unwrap();
        assert_eq!(one, 1);
    }

    #[tokio::test]
    async fn fts5_is_available_for_the_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(dir.path().join("gnome.db"), 1).await.unwrap();
        let hits: i64 = db
            .write(|c| -> Result<i64, DbError> {
                c.execute_batch(
                    "CREATE VIRTUAL TABLE t_fts USING fts5(title);
                     INSERT INTO t_fts(title) VALUES ('mushroom forest runner'), ('space racer');",
                )?;
                Ok(c.query_row("SELECT count(*) FROM t_fts WHERE t_fts MATCH 'forest'", [], |r| r.get(0))?)
            })
            .await
            .unwrap();
        assert_eq!(hits, 1);
    }
}
