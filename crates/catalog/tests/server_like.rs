//! The integration recipe from the README, end to end: a `WriteDb` shaped like gnome-server's `Db::write`
//! (Tokio mutex + `spawn_blocking`, file database in WAL mode, separate read-only connection), with the import
//! spawned on the runtime.

mod common;

use std::sync::Arc;

use common::*;
use gnome_catalog::{CatalogError, FixtureFetcher, ImportOptions, ListQuery, ManualClock, Source, WriteDb};
use rusqlite::{Connection, OpenFlags};

#[derive(Debug)]
struct DbError(String);

/// Mirrors `gnome_server::db::Db` (writer only).
#[derive(Clone)]
struct ServerDb {
    writer: Arc<tokio::sync::Mutex<Connection>>,
}

impl ServerDb {
    async fn write<T, E, F>(&self, f: F) -> Result<T, E>
    where
        F: FnOnce(&mut Connection) -> Result<T, E> + Send + 'static,
        T: Send + 'static,
        E: From<DbError> + Send + 'static,
    {
        let mut guard = self.writer.clone().lock_owned().await;
        tokio::task::spawn_blocking(move || f(&mut guard)).await.map_err(|e| E::from(DbError(e.to_string())))?
    }
}

impl WriteDb for ServerDb {
    async fn write<T, F>(&self, f: F) -> Result<T, CatalogError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, CatalogError> + Send + 'static,
    {
        ServerDb::write(self, move |c| Ok::<_, DbError>(f(c))).await.map_err(|e: DbError| CatalogError::Storage(e.0))?
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawned_import_through_a_server_shaped_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gnome.db");
    let conn = Connection::open(&path).unwrap();
    let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    gnome_catalog::init_schema(&conn).unwrap();
    let db = ServerDb { writer: Arc::new(tokio::sync::Mutex::new(conn)) };
    let cat = Arc::new(gamepix_chess());
    {
        let cat = cat.clone();
        let now = T0;
        // The inherent `Db::write` wins method resolution; call the trait method explicitly.
        WriteDb::write(&db, move |c| cat.prepare(c, now)).await.unwrap();
    }
    let fetcher = Arc::new(FixtureFetcher::new());
    fetcher.on_url(&["page=1&"], vec![ok("gamepix-chess-p1.json")]);
    fetcher.on_url(&["page=2&"], vec![ok("gamepix-chess-p2.json")]);
    fetcher.on_url(&["page=3&"], vec![ok("gamepix-chess-p3.json")]);
    let clock = Arc::new(ManualClock::new(T0));
    let task = {
        let (cat, fetcher, clock, db) = (cat.clone(), fetcher.clone(), clock.clone(), db.clone());
        tokio::spawn(
            async move { cat.import(&*fetcher, &*clock, &db, Source::GamePix, ImportOptions::default()).await },
        )
    };
    let report = task.await.unwrap().unwrap();
    assert!(report.complete && report.inserted == 29, "{report:?}");
    // Reads go through a separate read-only connection, as on the server's read pool.
    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    reader.execute_batch("PRAGMA query_only = ON;").unwrap();
    let page = cat.list(&reader, &ListQuery::default()).unwrap();
    assert_eq!(page.total, 29);
    let sections = cat.sections(&reader, 24).unwrap();
    assert_eq!(sections.popular.len(), 24);
    let detail = cat.game(&reader, &page.items[0].slug, 6).unwrap().unwrap();
    assert_eq!(detail.related.len(), 6);
    assert!(cat.stats(&reader).unwrap().last_import.is_some());
}
