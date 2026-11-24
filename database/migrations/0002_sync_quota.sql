-- GNOME core schema, migration 2: sync storage accounting (WAVE-D D20).
--
-- Stored bytes per account, kept exact by triggers, so the per-account quota (GNOME_SYNC_QUOTA_MB) and the
-- server-wide cap (GNOME_SYNC_TOTAL_MB) need no scan:
--   live bookmark  octet_length(url) + octet_length(title) + 36 (id) + 36 (parent, if any) + 64
--   tombstone      64
--   visit          octet_length(url) + octet_length(title) + 36 (id) + 64
--   settings       octet_length(data)
-- `sync_totals` (one row) is the sum over every account. Rows removed by an account deletion (ON DELETE CASCADE)
-- fire the delete triggers too, so the total stays exact. Append-only: never edit a migration once shipped.

ALTER TABLE users ADD COLUMN sync_bookmark_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sync_history_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN sync_settings_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_totals (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    bytes INTEGER NOT NULL
) STRICT;

-- Backfill.
UPDATE users SET
    sync_bookmark_bytes = coalesce((
        SELECT sum(CASE WHEN b.deleted = 1 THEN 64
                        ELSE coalesce(octet_length(b.url), 0) + octet_length(b.title) + 36
                             + CASE WHEN b.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
          FROM bookmarks b WHERE b.user_id = users.id), 0),
    sync_history_bytes = coalesce((
        SELECT sum(octet_length(h.url) + coalesce(octet_length(h.title), 0) + 100)
          FROM history h WHERE h.user_id = users.id), 0),
    sync_settings_bytes = coalesce((SELECT octet_length(s.data) FROM user_settings s WHERE s.user_id = users.id), 0);

INSERT INTO sync_totals (id, bytes)
    VALUES (1, (SELECT coalesce(sum(sync_bookmark_bytes + sync_history_bytes + sync_settings_bytes), 0) FROM users));

-- Bookmarks.
CREATE TRIGGER sync_bytes_bookmarks_insert AFTER INSERT ON bookmarks BEGIN
    UPDATE users SET sync_bookmark_bytes = sync_bookmark_bytes +
        (CASE WHEN NEW.deleted = 1 THEN 64
              ELSE coalesce(octet_length(NEW.url), 0) + octet_length(NEW.title) + 36
                   + CASE WHEN NEW.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes +
        (CASE WHEN NEW.deleted = 1 THEN 64
              ELSE coalesce(octet_length(NEW.url), 0) + octet_length(NEW.title) + 36
                   + CASE WHEN NEW.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = 1;
END;

CREATE TRIGGER sync_bytes_bookmarks_delete AFTER DELETE ON bookmarks BEGIN
    UPDATE users SET sync_bookmark_bytes = sync_bookmark_bytes -
        (CASE WHEN OLD.deleted = 1 THEN 64
              ELSE coalesce(octet_length(OLD.url), 0) + octet_length(OLD.title) + 36
                   + CASE WHEN OLD.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = OLD.user_id;
    UPDATE sync_totals SET bytes = bytes -
        (CASE WHEN OLD.deleted = 1 THEN 64
              ELSE coalesce(octet_length(OLD.url), 0) + octet_length(OLD.title) + 36
                   + CASE WHEN OLD.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = 1;
END;

-- `synced_at`-only updates (re-announcements) do not change the size and do not fire this.
CREATE TRIGGER sync_bytes_bookmarks_update AFTER UPDATE OF user_id, url, title, parent_id, deleted ON bookmarks BEGIN
    UPDATE users SET sync_bookmark_bytes = sync_bookmark_bytes -
        (CASE WHEN OLD.deleted = 1 THEN 64
              ELSE coalesce(octet_length(OLD.url), 0) + octet_length(OLD.title) + 36
                   + CASE WHEN OLD.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = OLD.user_id;
    UPDATE users SET sync_bookmark_bytes = sync_bookmark_bytes +
        (CASE WHEN NEW.deleted = 1 THEN 64
              ELSE coalesce(octet_length(NEW.url), 0) + octet_length(NEW.title) + 36
                   + CASE WHEN NEW.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes
        - (CASE WHEN OLD.deleted = 1 THEN 64
                ELSE coalesce(octet_length(OLD.url), 0) + octet_length(OLD.title) + 36
                     + CASE WHEN OLD.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
        + (CASE WHEN NEW.deleted = 1 THEN 64
                ELSE coalesce(octet_length(NEW.url), 0) + octet_length(NEW.title) + 36
                     + CASE WHEN NEW.parent_id IS NULL THEN 0 ELSE 36 END + 64 END)
     WHERE id = 1;
END;

-- History.
CREATE TRIGGER sync_bytes_history_insert AFTER INSERT ON history BEGIN
    UPDATE users SET sync_history_bytes = sync_history_bytes +
        (octet_length(NEW.url) + coalesce(octet_length(NEW.title), 0) + 100)
     WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes + (octet_length(NEW.url) + coalesce(octet_length(NEW.title), 0) + 100)
     WHERE id = 1;
END;

CREATE TRIGGER sync_bytes_history_delete AFTER DELETE ON history BEGIN
    UPDATE users SET sync_history_bytes = sync_history_bytes -
        (octet_length(OLD.url) + coalesce(octet_length(OLD.title), 0) + 100)
     WHERE id = OLD.user_id;
    UPDATE sync_totals SET bytes = bytes - (octet_length(OLD.url) + coalesce(octet_length(OLD.title), 0) + 100)
     WHERE id = 1;
END;

CREATE TRIGGER sync_bytes_history_update AFTER UPDATE OF user_id, url, title ON history BEGIN
    UPDATE users SET sync_history_bytes = sync_history_bytes -
        (octet_length(OLD.url) + coalesce(octet_length(OLD.title), 0) + 100)
     WHERE id = OLD.user_id;
    UPDATE users SET sync_history_bytes = sync_history_bytes +
        (octet_length(NEW.url) + coalesce(octet_length(NEW.title), 0) + 100)
     WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes
        - (octet_length(OLD.url) + coalesce(octet_length(OLD.title), 0) + 100)
        + (octet_length(NEW.url) + coalesce(octet_length(NEW.title), 0) + 100)
     WHERE id = 1;
END;

-- Settings.
CREATE TRIGGER sync_bytes_settings_insert AFTER INSERT ON user_settings BEGIN
    UPDATE users SET sync_settings_bytes = sync_settings_bytes + octet_length(NEW.data) WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes + octet_length(NEW.data) WHERE id = 1;
END;

CREATE TRIGGER sync_bytes_settings_delete AFTER DELETE ON user_settings BEGIN
    UPDATE users SET sync_settings_bytes = sync_settings_bytes - octet_length(OLD.data) WHERE id = OLD.user_id;
    UPDATE sync_totals SET bytes = bytes - octet_length(OLD.data) WHERE id = 1;
END;

CREATE TRIGGER sync_bytes_settings_update AFTER UPDATE OF user_id, data ON user_settings BEGIN
    UPDATE users SET sync_settings_bytes = sync_settings_bytes - octet_length(OLD.data) WHERE id = OLD.user_id;
    UPDATE users SET sync_settings_bytes = sync_settings_bytes + octet_length(NEW.data) WHERE id = NEW.user_id;
    UPDATE sync_totals SET bytes = bytes - octet_length(OLD.data) + octet_length(NEW.data) WHERE id = 1;
END;
