-- GNOME game catalog schema, migration version 100.
--
-- Owned by crates/catalog (embedded with include_str! as gnome_catalog::MIGRATIONS) and applied by gnome-server's
-- migration runner inside one transaction, after the core migrations. Never edit it once shipped: add
-- 0101_*.sql and register it in crates/catalog/src/lib.rs instead.
--
-- Conventions (same as 0001_core.sql): timestamps are Unix epoch milliseconds, tables are STRICT, JSON columns are
-- validated with json_valid(). Every record comes from a real source response or the curated OSS manifest.

-- One row per source listing, keyed on (source, source_id). Columns are ordered small/hot first so list queries
-- never touch the overflow pages that hold long descriptions.
CREATE TABLE games (
    id                INTEGER PRIMARY KEY,
    source            TEXT    NOT NULL CHECK (source IN ('gamepix', 'gamedistribution', 'playgama', 'gamemonetize',
                                                         'famobi', 'itchio', 'js13k', 'oss')),
    source_id         TEXT    NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
    slug              TEXT    NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 96),
    title             TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    title_sort        TEXT    NOT NULL,             -- folded title for sort=az
    developer         TEXT,                         -- NULL when the source does not expose it
    developer_url     TEXT,
    thumbnail_url     TEXT,                         -- best card image (absolute URL, or /oss/... for self-hosted)
    embed_kind        TEXT    NOT NULL CHECK (embed_kind IN ('iframe', 'selfhost', 'link')),
    embed_url         TEXT    NOT NULL,             -- template ({gamepix_sid}, {playgama_clid}, {famobi_affiliate},
                                                    -- {page_url}), relative self-host path, or link-out URL
    playable          INTEGER NOT NULL CHECK (playable IN (0, 1)),  -- 0 = link-out only: never iframe it
    width             INTEGER CHECK (width BETWEEN 1 AND 10000),
    height            INTEGER CHECK (height BETWEEN 1 AND 10000),
    orientation       TEXT    CHECK (orientation IN ('landscape', 'portrait', 'any')),
    mobile            INTEGER CHECK (mobile IN (0, 1)),             -- NULL = unknown
    source_url        TEXT,                         -- canonical page at the source (attribution / link-out)
    license           TEXT,                         -- SPDX id (self-hosted open-source games)
    attribution       TEXT    NOT NULL,
    categories        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(categories)),  -- GNOME slugs, primary first
    tags              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    flags             TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),       -- kids_friendly, no_blood, iap, ...
    source_categories TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_categories)),
    thumbnails        TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(thumbnails)),  -- [{url,w,h,kind}]
    published_at      INTEGER,                      -- from the source, when it has dates
    source_updated_at INTEGER,
    added_at          INTEGER NOT NULL,             -- first seen by GNOME
    updated_at        INTEGER NOT NULL,             -- last time an import changed the normalized record
    new_key           INTEGER NOT NULL DEFAULT 0,   -- sort=new key: published_at, else first-seen time for games that
                                                    -- appeared after the source's first complete sync, else 0
    last_seen_at      INTEGER NOT NULL,
    last_seen_run     INTEGER,                      -- catalog_imports.id of the last sync that listed it
    missing_count     INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),  -- consecutive complete syncs without it
    ip_risk           INTEGER NOT NULL DEFAULT 0 CHECK (ip_risk IN (0, 1)),   -- trademark/knock-off blocklist match
    ip_risk_term      TEXT,
    admin_status      TEXT    CHECK (admin_status IN ('active', 'hidden', 'broken')),  -- sticky admin override
    source_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (source_enabled IN (0, 1)),
    featured          INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
    featured_at       INTEGER,
    quality           REAL    NOT NULL DEFAULT 0.5 CHECK (quality BETWEEN 0 AND 1),  -- source signal (cold start)
    source_rank       INTEGER,                      -- position in the source's own ranking
    pop_score         REAL    NOT NULL DEFAULT 0,   -- sort=popular (decayed plays + quality prior)
    trend_score       REAL    NOT NULL DEFAULT 0,   -- sort=trending (short-window decayed plays + freshness)
    plays             INTEGER NOT NULL DEFAULT 0 CHECK (plays >= 0),  -- all-time anonymous play count
    canonical_id      INTEGER REFERENCES games (id) ON DELETE SET NULL, -- duplicate of this preferred listing
    dedup_key         TEXT    NOT NULL,
    text_hash         TEXT    NOT NULL,             -- change detection for the full-text-indexed columns
    meta_hash         TEXT    NOT NULL,             -- change detection for the other normalized columns
    keywords          TEXT    NOT NULL DEFAULT '',  -- categories + tags + source categories (indexed by FTS)
    -- Effective status: an admin override wins, then the blocklist, then "missing from 3 complete syncs".
    status            TEXT    NOT NULL GENERATED ALWAYS AS (
                          CASE WHEN admin_status IS NOT NULL THEN admin_status
                               WHEN ip_risk = 1 THEN 'ip_risk'
                               WHEN missing_count >= 3 THEN 'hidden'
                               ELSE 'active' END) STORED,
    -- Shown in listings: active, its source enabled, and the preferred listing of its duplicate group.
    listed            INTEGER NOT NULL GENERATED ALWAYS AS (
                          coalesce(admin_status, CASE WHEN ip_risk = 1 THEN 'ip_risk'
                                                      WHEN missing_count >= 3 THEN 'hidden'
                                                      ELSE 'active' END) = 'active'
                          AND source_enabled = 1 AND canonical_id IS NULL) STORED,
    description       TEXT    NOT NULL DEFAULT '',
    instructions      TEXT    NOT NULL DEFAULT '',
    UNIQUE (source, source_id)
) STRICT;

-- Keyset pagination: one partial index per sort order, over listed games only (row-value comparisons on
-- (key, id) seek directly to the cursor position).
CREATE INDEX games_listed_popular  ON games (pop_score DESC, id DESC) WHERE listed = 1;
CREATE INDEX games_listed_trending ON games (trend_score DESC, id DESC) WHERE listed = 1;
CREATE INDEX games_listed_new      ON games (new_key DESC, id DESC) WHERE listed = 1;
CREATE INDEX games_listed_az       ON games (title_sort, id) WHERE listed = 1;
CREATE INDEX games_listed_featured ON games (featured DESC, pop_score DESC, id DESC) WHERE listed = 1;
CREATE INDEX games_listed_quality  ON games (quality DESC, id DESC) WHERE listed = 1;  -- featured top-up
CREATE INDEX games_picks           ON games (featured_at DESC, id DESC) WHERE featured = 1;
-- Import paths: duplicate groups, missing-item marking, stats by source/status, FK maintenance.
CREATE INDEX games_dedup           ON games (dedup_key);
CREATE INDEX games_by_run          ON games (source, last_seen_run);
CREATE INDEX games_by_status       ON games (source, status);
CREATE INDEX games_canonical       ON games (canonical_id) WHERE canonical_id IS NOT NULL;

-- Original records (JSON) for re-mapping when rules change; kept out of `games` to keep its rows small.
CREATE TABLE game_raw (
    game_id    INTEGER PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
    raw        TEXT    NOT NULL CHECK (json_valid(raw)),
    fetched_at INTEGER NOT NULL
) STRICT;

CREATE TABLE game_categories (
    game_id  INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    category TEXT    NOT NULL,
    position INTEGER NOT NULL,                      -- 0 = primary
    PRIMARY KEY (game_id, category)
) STRICT, WITHOUT ROWID;
CREATE INDEX game_categories_by_category ON game_categories (category, game_id);

CREATE TABLE game_tags (
    game_id INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL CHECK (length(tag) BETWEEN 1 AND 48),
    PRIMARY KEY (game_id, tag)
) STRICT, WITHOUT ROWID;
CREATE INDEX game_tags_by_tag ON game_tags (tag, game_id);

-- Full-text search. External-content FTS5 over `games` (not contentless): the text already lives in `games`, so
-- the index stores no second copy, can be rebuilt at any time with INSERT INTO games_fts(games_fts) VALUES
-- ('rebuild'), and auxiliary functions can read column values. The triggers keep it in sync; the UPDATE trigger
-- fires only for the four indexed columns, so the frequent score / last-seen / status updates never touch the
-- index. Ranking uses bm25 with column weights title 10, developer 3, keywords 4, description 1 (see query.rs).
-- prefix='3' makes type-ahead prefix queries ("che*"; the last word is a prefix from 3 characters on) cheap.
CREATE VIRTUAL TABLE games_fts USING fts5(
    title, developer, keywords, description,
    content = 'games', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '3'
);

CREATE TRIGGER games_fts_insert AFTER INSERT ON games BEGIN
    INSERT INTO games_fts (rowid, title, developer, keywords, description)
    VALUES (new.id, new.title, new.developer, new.keywords, new.description);
END;

CREATE TRIGGER games_fts_delete AFTER DELETE ON games BEGIN
    INSERT INTO games_fts (games_fts, rowid, title, developer, keywords, description)
    VALUES ('delete', old.id, old.title, old.developer, old.keywords, old.description);
END;

CREATE TRIGGER games_fts_update AFTER UPDATE OF title, developer, keywords, description ON games BEGIN
    INSERT INTO games_fts (games_fts, rowid, title, developer, keywords, description)
    VALUES ('delete', old.id, old.title, old.developer, old.keywords, old.description);
    INSERT INTO games_fts (rowid, title, developer, keywords, description)
    VALUES (new.id, new.title, new.developer, new.keywords, new.description);
END;

-- Anonymous daily play aggregates (no user or session identifiers).
CREATE TABLE game_plays_daily (
    game_id INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    day     INTEGER NOT NULL,                       -- days since 1970-01-01 (UTC)
    count   INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (game_id, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX game_plays_daily_by_day ON game_plays_daily (day);

-- Short-lived de-duplication of play counts: 16-byte hashes of (caller key, game, hour window), deleted after the
-- window. Not linkable to a session without the caller's key.
CREATE TABLE game_play_dedup (
    key        BLOB    PRIMARY KEY CHECK (length(key) = 16),
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX game_play_dedup_by_expiry ON game_play_dedup (expires_at);

-- Import runs.
CREATE TABLE catalog_imports (
    id             INTEGER PRIMARY KEY,
    source         TEXT    NOT NULL,
    started_at     INTEGER NOT NULL,
    finished_at    INTEGER,
    heartbeat_at   INTEGER NOT NULL,
    status         TEXT    NOT NULL CHECK (status IN ('running', 'complete', 'incomplete', 'failed', 'interrupted')),
    complete       INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),  -- counted for missing-item hiding
    limited        INTEGER NOT NULL DEFAULT 0 CHECK (limited IN (0, 1)),   -- --limit / max pages: never complete
    reached_end    INTEGER NOT NULL DEFAULT 0 CHECK (reached_end IN (0, 1)),  -- covered the whole feed (no error,
                                                    -- limit or truncation); used to accept a new catalog size
    pages          INTEGER NOT NULL DEFAULT 0,
    not_modified   INTEGER NOT NULL DEFAULT 0,      -- pages answered 304
    requests       INTEGER NOT NULL DEFAULT 0,
    retries        INTEGER NOT NULL DEFAULT 0,
    seen           INTEGER NOT NULL DEFAULT 0,      -- distinct games listed by the source in this run
    inserted       INTEGER NOT NULL DEFAULT 0,
    updated        INTEGER NOT NULL DEFAULT 0,
    unchanged      INTEGER NOT NULL DEFAULT 0,
    rejected       INTEGER NOT NULL DEFAULT 0,      -- records that failed validation
    hidden         INTEGER NOT NULL DEFAULT 0,      -- games hidden by this run (missing from 3 complete syncs)
    reported_total INTEGER,                         -- total announced by the source, if any
    error          TEXT,
    note           TEXT                             -- why a run is incomplete
) STRICT;
CREATE INDEX catalog_imports_by_source ON catalog_imports (source, id);
CREATE INDEX catalog_imports_running   ON catalog_imports (source) WHERE status = 'running';

-- HTTP validators per feed page, with the ids the page listed, so a 304 can mark those games as seen.
CREATE TABLE catalog_http_cache (
    source         TEXT    NOT NULL,
    page_key       TEXT    NOT NULL,
    etag           TEXT,
    last_modified  TEXT,
    item_ids       TEXT    NOT NULL CHECK (json_valid(item_ids)),
    item_count     INTEGER NOT NULL,
    next_hint      TEXT,
    reported_total INTEGER,
    stored_at      INTEGER NOT NULL,
    PRIMARY KEY (source, page_key)
) STRICT, WITHOUT ROWID;

-- Precomputed counts of listed games (refreshed by every operation that changes listings: imports, admin status
-- changes, prepare, ranking refreshes). They serve the category/tag endpoints and the `total` of unfiltered,
-- category-only and tag-only listings without a count(*) scan. kind 'all' has one row with value ''.
CREATE TABLE catalog_facets (
    kind                  TEXT    NOT NULL CHECK (kind IN ('all', 'category', 'tag')),
    value                 TEXT    NOT NULL,
    count_all             INTEGER NOT NULL,   -- including link-out games
    count_playable        INTEGER NOT NULL,
    count_mobile_all      INTEGER NOT NULL,   -- mobile = 1
    count_mobile_playable INTEGER NOT NULL,
    PRIMARY KEY (kind, value)
) STRICT, WITHOUT ROWID;

-- Catalog bookkeeping (rules / listing fingerprints, last ranking refresh).
CREATE TABLE catalog_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
