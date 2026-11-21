-- GNOME core schema, migration version 1.
--
-- Applied by gnome-server's migration runner (backend/src/db/migrate.rs) inside a single transaction and recorded in
-- `schema_migrations`. Core migrations use versions 1..99; `crates/catalog` owns 100..199. Never edit a migration
-- that has shipped: add `0002_*.sql` (and register it in CORE_MIGRATIONS) instead.
--
-- Conventions: every timestamp is Unix epoch milliseconds (INTEGER). Tables are STRICT. Rows owned by a user are
-- removed with the user (ON DELETE CASCADE; the server enables `PRAGMA foreign_keys`).

-- Migration bookkeeping. The runner also creates this table (identically) before applying anything, hence IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,             -- hex SHA-256 of the migration SQL as applied
    applied_at INTEGER NOT NULL
) STRICT;

-- Accounts. Usernames are unique case-insensitively (NOCASE; the allowed alphabet is ASCII-only).
CREATE TABLE users (
    id                     INTEGER PRIMARY KEY,
    username               TEXT    NOT NULL COLLATE NOCASE UNIQUE
                                   CHECK (length(username) BETWEEN 3 AND 32),
    password_hash          TEXT    NOT NULL,      -- Argon2id PHC string
    is_admin               INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    last_login_at          INTEGER,
    -- History sync: entries visited before this instant were deleted by the user on some device and must not be
    -- re-uploaded or kept by other devices (see DELETE /api/sync/history).
    history_cleared_before INTEGER,
    -- Sync clock: the last `synced_at` handed out for this user's bookmarks/history. Every write takes
    -- max(now, sync_clock + 1), so values only ever grow, even after rows are deleted or the wall clock steps back
    -- (a Raspberry Pi has no RTC). Pulls return it as `server_time`.
    sync_clock             INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Signed-in sessions (`gnome_auth` cookie). Only the SHA-256 of the random cookie token is stored.
CREATE TABLE user_sessions (
    token_hash   BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL             -- sliding: pushed forward (30 days) while the session is used
) STRICT, WITHOUT ROWID;

CREATE INDEX user_sessions_by_user ON user_sessions (user_id, created_at);
CREATE INDEX user_sessions_by_expiry ON user_sessions (expires_at);

-- Synced settings document (one JSON object per user; optimistic concurrency on updated_at).
CREATE TABLE user_settings (
    user_id    INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    data       TEXT    NOT NULL CHECK (json_valid(data)),
    updated_at INTEGER NOT NULL
) STRICT;

-- Synced bookmarks and folders. Last-writer-wins per (user, id) on the client's updated_at; deletions are kept as
-- tombstones (deleted = 1, title/url cleared). synced_at comes from users.sync_clock (strictly increasing per user)
-- and drives `GET /api/sync/bookmarks?since=`.
CREATE TABLE bookmarks (
    pk         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id         TEXT    NOT NULL,              -- client UUID
    parent_id  TEXT,
    kind       TEXT    NOT NULL CHECK (kind IN ('bookmark', 'folder')),
    title      TEXT    NOT NULL,
    url        TEXT,
    position   REAL    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    synced_at  INTEGER NOT NULL,
    UNIQUE (user_id, id)
) STRICT;

CREATE INDEX bookmarks_by_sync ON bookmarks (user_id, synced_at, id);
-- Tombstones only: the per-account tombstone count and cap, and the daily purge, never read live rows.
CREATE INDEX bookmarks_tombstones ON bookmarks (user_id, synced_at) WHERE deleted = 1;

-- Synced browsing history (only for users who opted in). synced_at as for bookmarks; keyset paging on (synced_at, id).
CREATE TABLE history (
    pk         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    id         TEXT    NOT NULL,              -- client UUID
    url        TEXT    NOT NULL,
    title      TEXT,
    visited_at INTEGER NOT NULL,
    synced_at  INTEGER NOT NULL,
    UNIQUE (user_id, id)
) STRICT;

CREATE INDEX history_by_sync ON history (user_id, synced_at, id);
CREATE INDEX history_by_visit ON history (user_id, visited_at);

-- Small server-side key/value store for modules (e.g. filter-list metadata, last import markers).
-- Keys are namespaced by module: "<module>:<key>".
CREATE TABLE kv (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
