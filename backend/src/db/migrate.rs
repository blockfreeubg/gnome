//! Migration runner.
//!
//! Migrations are embedded in the binary: core migrations from `database/migrations/` (versions 1..99) and the
//! catalog crate's [`gnome_catalog::MIGRATIONS`] (versions 100..199). They are applied in ascending version order,
//! each inside its own `BEGIN IMMEDIATE` transaction, and recorded in `schema_migrations` with a checksum. Running
//! the runner again is a no-op. A database that contains versions this binary does not know (written by a newer
//! release) is refused rather than silently used.
//!
//! Migration SQL must not contain statements that cannot run inside a transaction (`VACUUM`, `PRAGMA journal_mode`).

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub use gnome_catalog::Migration;

use super::DbError;
use crate::security::crypto::sha256_hex;
use crate::util::now_ms;

/// Core migrations, owned by gnome-server. Append new versions; never edit shipped ones.
pub const CORE_MIGRATIONS: &[Migration] = &[
    Migration { version: 1, name: "core", sql: include_str!("../../../database/migrations/0001_core.sql") },
    Migration { version: 2, name: "sync_quota", sql: include_str!("../../../database/migrations/0002_sync_quota.sql") },
];

const BOOTSTRAP: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
) STRICT;";

/// What a run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// `(version, name)` applied in this run.
    pub applied: Vec<(i64, &'static str)>,
    /// Versions present in the database after the run.
    pub current: Vec<i64>,
}

/// All migrations in application order, validated for range and uniqueness.
pub fn all_migrations() -> Result<Vec<Migration>, DbError> {
    validate(CORE_MIGRATIONS, gnome_catalog::MIGRATIONS)
}

fn validate(core: &[Migration], catalog: &[Migration]) -> Result<Vec<Migration>, DbError> {
    for m in core {
        if !(1..=99).contains(&m.version) {
            return Err(DbError::Migration(format!("core migration {} ({}) is outside 1..=99", m.version, m.name)));
        }
    }
    for m in catalog {
        if !(100..=199).contains(&m.version) {
            return Err(DbError::Migration(format!(
                "catalog migration {} ({}) is outside 100..=199",
                m.version, m.name
            )));
        }
    }
    let mut all: Vec<Migration> = core.iter().chain(catalog).copied().collect();
    all.sort_by_key(|m| m.version);
    if let Some(w) = all.windows(2).find(|w| w[0].version == w[1].version) {
        return Err(DbError::Migration(format!("duplicate migration version {}", w[0].version)));
    }
    Ok(all)
}

/// Apply every pending migration.
pub fn run(conn: &mut Connection) -> Result<MigrationReport, DbError> {
    run_with(conn, &all_migrations()?)
}

fn run_with(conn: &mut Connection, migrations: &[Migration]) -> Result<MigrationReport, DbError> {
    conn.execute_batch(BOOTSTRAP)?;
    let applied: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
    };
    if let Some((unknown, _)) = applied.iter().find(|(v, _)| !migrations.iter().any(|m| m.version == *v)) {
        return Err(DbError::Migration(format!(
            "the database contains migration {unknown}, which this gnome-server does not know; it was written by a \
             newer release — upgrade gnome-server or restore a backup"
        )));
    }
    let mut report = MigrationReport::default();
    for m in migrations {
        let checksum = sha256_hex(m.sql.as_bytes());
        if let Some((_, recorded)) = applied.iter().find(|(v, _)| *v == m.version) {
            if *recorded != checksum {
                tracing::warn!(
                    version = m.version,
                    name = m.name,
                    "migration SQL changed after it was applied; shipped migrations must not be edited"
                );
            }
            continue;
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Re-check under the write lock (another process may have migrated meanwhile).
        let already: Option<i64> = tx
            .query_row("SELECT version FROM schema_migrations WHERE version = ?1", [m.version], |r| r.get(0))
            .optional()?;
        if already.is_none() {
            tx.execute_batch(m.sql)
                .map_err(|e| DbError::Migration(format!("migration {} ({}) failed: {e}", m.version, m.name)))?;
            tx.execute(
                "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?1, ?2, ?3, ?4)",
                params![m.version, m.name, checksum, now_ms()],
            )?;
            report.applied.push((m.version, m.name));
        }
        tx.commit()?;
    }
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    report.current = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        c
    }

    #[test]
    fn core_schema_applies_and_is_idempotent() {
        let mut c = mem();
        let first = run(&mut c).unwrap();
        assert_eq!(first.applied.first(), Some(&(1, "core")));
        let second = run(&mut c).unwrap();
        assert!(second.applied.is_empty());
        assert_eq!(first.current, second.current);
        for table in ["users", "user_sessions", "user_settings", "bookmarks", "history", "kv", "schema_migrations"] {
            let n: i64 = c
                .query_row("SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1", [table], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(n, 1, "missing table {table}");
        }
    }

    #[test]
    fn ordering_ranges_and_duplicates() {
        const CORE: &[Migration] = &[
            Migration { version: 2, name: "b", sql: "CREATE TABLE b (x INTEGER);" },
            Migration { version: 1, name: "a", sql: "CREATE TABLE a (x INTEGER);" },
        ];
        const CAT: &[Migration] =
            &[Migration { version: 100, name: "c", sql: "CREATE TABLE c (x INTEGER REFERENCES a(x));" }];
        let all = validate(CORE, CAT).unwrap();
        assert_eq!(all.iter().map(|m| m.version).collect::<Vec<_>>(), vec![1, 2, 100]);
        let mut c = mem();
        let r = run_with(&mut c, &all).unwrap();
        assert_eq!(r.applied.iter().map(|a| a.0).collect::<Vec<_>>(), vec![1, 2, 100]);

        assert!(validate(&[Migration { version: 100, name: "x", sql: "" }], &[]).is_err());
        assert!(validate(&[], &[Migration { version: 5, name: "x", sql: "" }]).is_err());
        let dup = [Migration { version: 3, name: "x", sql: "" }, Migration { version: 3, name: "y", sql: "" }];
        assert!(validate(&dup, &[]).is_err());
    }

    #[test]
    fn failed_migration_rolls_back() {
        let ms = [
            Migration { version: 1, name: "ok", sql: "CREATE TABLE ok (x INTEGER);" },
            Migration { version: 2, name: "bad", sql: "CREATE TABLE half (x INTEGER); THIS IS NOT SQL;" },
        ];
        let mut c = mem();
        let err = run_with(&mut c, &ms).unwrap_err();
        assert!(err.to_string().contains("migration 2"));
        let half: i64 =
            c.query_row("SELECT count(*) FROM sqlite_schema WHERE name = 'half'", [], |r| r.get(0)).unwrap();
        assert_eq!(half, 0, "partial migration must roll back");
        let recorded: Vec<i64> = c
            .prepare("SELECT version FROM schema_migrations")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(recorded, vec![1]);
    }

    #[test]
    fn newer_database_is_refused() {
        let mut c = mem();
        run(&mut c).unwrap();
        c.execute("INSERT INTO schema_migrations VALUES (99, 'future', 'x', 0)", []).unwrap();
        assert!(run(&mut c).unwrap_err().to_string().contains("newer release"));
    }
}
