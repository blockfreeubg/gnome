-- GNOME game catalog schema, migration version 101 (independent review, 2026-11-11).
--
-- Owned by crates/catalog (embedded with include_str! as the second entry of gnome_catalog::MIGRATIONS) and
-- applied by gnome-server's migration runner after version 100. Kept next to the crate because the review could
-- only add files there; it may move to database/migrations/ unchanged (the path is only used by include_str!).
-- Never edit it once shipped.

-- Narrow covering index of listed games. Filtered counts and the relevance-ranked search join read it instead of
-- the wide `games` rows (3-4x faster for searches that match thousands of games). The count queries in query.rs
-- name it with INDEXED BY, so it must exist.
CREATE INDEX IF NOT EXISTS games_listed_search ON games (id, playable, mobile, pop_score) WHERE listed = 1;
