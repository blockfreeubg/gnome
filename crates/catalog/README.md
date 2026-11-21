# gnome-catalog

GNOME's game catalog as a library for `gnome-server`: the SQLite schema, importers for legitimate sources only
(official publisher feeds, link-out discovery feeds and a curated open-source manifest), normalization, cross-source
dedup, full-text search, ranking and the read API behind `/api/games*`. Every stored record comes from a real feed
response or a verified manifest entry; nothing is invented. Research and terms: `docs/research/games-sources.md`.

The crate does no networking of its own. The server supplies an HTTP client (`Fetcher`), a clock (`Clock`) and its
writer connection (`WriteDb`); read functions take a plain `&rusqlite::Connection`, so they run on the read pool.

Dependencies: rusqlite (bundled SQLite with FTS5), serde/serde_json, quick-xml (RSS), toml (manifest), hmac + sha2 +
base64 (cursor signing), tokio `time` (sleep), tracing. No TLS, HTTP or image stack.

## Integration with gnome-server

### Startup

```rust
let (cfg, warnings) = gnome_catalog::CatalogConfig::from_env(|k| std::env::var(k).ok())?;
for w in warnings { tracing::warn!("{w}") }                  // e.g. "gamedistribution stays disabled: set …"
let catalog = Arc::new(gnome_catalog::Catalog::new(cfg, &secret_key_bytes, gnome_catalog::RenderOptions {
    app_origin: public_app_origin,                           // GameDistribution's referrer = <app origin>/games/<slug>
    proxy_origin: proxy_origin_or_app_origin,                // serves /oss/<slug>/… (self-hosted games)
    thumb_proxy: config.thumb_proxy,                         // GNOME_THUMB_PROXY
}));
// MIGRATIONS (versions 100 and 101) are applied by the server's runner (db/migrate.rs) — nothing to do here.
let cat = catalog.clone();
gnome_catalog::WriteDb::write(&db, move |c| cat.prepare(c, now_ms())).await?;   // once, before serving
```

(`Db` also has an inherent `write`, which wins method resolution — call the trait method as shown, or use the
inherent one with your own error conversion.)

`prepare` marks runs left `running` by a crashed process as `interrupted`, applies the enabled-source set and dedup
order (recomputing duplicate groups when they changed), re-maps stored records from their raw JSON when the
normalization rules or the blocklist changed, and refreshes facet counts and rankings.

### Traits the server implements

| Trait | Server implementation |
| --- | --- |
| `Fetcher` | gnome-net's SSRF-safe client: send the request as given, enforce `max_body_bytes` and `timeout`, decompress, return every HTTP status as `Ok` (304/429/5xx included) and only transport failures as `Err` (`Timeout`, `BodyTooLarge`, `Network` = retryable, `Blocked` = egress policy). Follow no redirects, or a few with re-validation (the feeds do not redirect). |
| `WriteDb` | Over `Db::write`: `async fn write<T, F>(&self, f: F) -> Result<T, CatalogError> { Db::write(self, move \|c\| Ok::<_, DbError>(f(c))).await.map_err(\|e\| CatalogError::Storage(e.to_string()))? }` (the trait requires the future to be `Send`) — exactly this shape is exercised by `tests/server_like.rs` (Tokio mutex + `spawn_blocking`, WAL file, import on `tokio::spawn`, reads on a `query_only` connection). |
| `Clock` | `gnome_catalog::TokioClock` (provided). |

`FixtureFetcher` + `ManualClock` (also exported) make server-side tests independent of the network and of real
time; `impl WriteDb for std::sync::Mutex<Connection>` runs closures inline (tests, CLI).

### Routes (public listener, app origin)

| Route | Call | Connection |
| --- | --- | --- |
| `GET /api/games?q=&category=&tag=&sort=&mobile=&cursor=&limit=` | `catalog.list(conn, &ListQuery { .. })` → `ListPage {items, next_cursor, total}`. Add `include_link_out=1` support if the UI wants itch.io/js13k entries in lists (default: playable only). | reader |
| `GET /api/games/sections` | `catalog.sections(conn, 24)` | reader |
| `GET /api/games/categories` | `catalog.categories(conn, false)` → `[{slug,name,count}]` (14 core always, optional ones when used) | reader |
| `GET /api/games/tags?prefix=&limit=` | `catalog.tags(conn, prefix, limit, false)` | reader |
| `GET /api/games/by-ids?ids=1,2,3` | `catalog.by_ids(conn, &ids)` (≤ 200; order kept; missing omitted) | reader |
| `GET /api/games/:slug` | `catalog.game(conn, slug, 12)` → `Option<GamePage {game, related}>`; `None` → 404 | reader |
| `POST /api/games/:slug/play` | `catalog.record_play(conn, slug, dedup_key, now)` with `dedup_key` = e.g. HMAC(secret, session_ref); `NotFound` → 404; `Counted`/`Duplicate` → 204 | writer |
| `GET /api/thumb/:id` | `catalog.thumbnail_source(conn, id)` → validated upstream URL or 404; fetch with the `Fetcher`, accept only `thumbs::is_allowed_content_type` and ≤ `thumbs::MAX_THUMB_BYTES`, serve with `nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: public, max-age=604800`, cache on disk (`GNOME_THUMB_CACHE_MB`). | reader |

`CatalogError::InvalidInput` (bad cursor/category/limit, tampered cursor) → `400 validation_failed`;
`NotFound` → 404; `Db`/`Storage` → 500.

Response shapes map 1:1 onto `docs/API.md` `GameSummary` / `GameDetail` (they `Serialize` to exactly those keys),
plus additive fields the UI needs: `playable` (summary and detail; `false` = link-out only, open `source_url` in a new
tab and **never** iframe it), `embed_kind` (`iframe`/`selfhost`/`link`), `orientation`, `flags` (`kids_friendly`,
`no_blood`, `no_cruelty`, `iap`, `paid`). `embed_url` is ready to use: publisher IDs and the GameDistribution page
URL are filled in at render time from the current configuration (rows store templates such as
`…/embed?sid={gamepix_sid}`), self-hosted games point at `<proxy origin>/oss/<slug>/<entry>`.

### Admin listener

| Route | Call |
| --- | --- |
| `GET /admin/diagnostics` → `"catalog"` | `catalog.stats(conn)` → `{games, listed, by_source: {<source>: {enabled,total,listed,active,hidden,broken,ip_risk,duplicates,last_import}}, last_import, rankings_refreshed_at}` |
| `POST /admin/catalog/import` `{"sources"?, "limit"?}` | spawn `catalog.import(&fetcher, &TokioClock, &db, source, ImportOptions { limit, max_pages: None })` per source (or `import_enabled`), return `202 {job_id}`; `CatalogError::Busy` means a run of that source is in progress |
| `GET /admin/catalog/imports` | `catalog.import_runs(conn, None, 50)` |
| `POST /admin/games/:id/feature` `{"featured": bool}` | `catalog.set_featured(conn, id, featured, now)` (writer) |
| `POST /admin/games/:id/status` `{"status": "active"\|"hidden"\|"broken"\|null}` | `catalog.set_status(conn, id, AdminStatus::parse(..))` (writer). `active` also overrides an `ip_risk` match; `null` clears the override |

### Jobs and CLI

| Job / command | Call |
| --- | --- |
| `catalog-import`, every `GNOME_CATALOG_REFRESH_HOURS` (default 24, first run shortly after start) | `catalog.import_enabled(&fetcher, &TokioClock, &db, ImportOptions::default())`; afterwards recompute the CSP `frame-src` list with `catalog.embed_hosts(conn)` |
| `catalog-rankings`, hourly | `catalog.refresh_rankings(conn, now)` (writer; also purges expired play-dedup keys) |
| `gnome-server catalog import [--source S] [--limit N]` | `catalog.import(.., Source::from_id(S), ImportOptions { limit: N, .. })` — limited runs never count as complete |
| `gnome-server catalog stats` | `catalog.stats(conn)` printed as JSON |

An import returns `Err` only for database problems, a disabled source or a concurrent run. Feed problems end the run
with status `failed` or `incomplete` (see the report's `error`/`note`); they are logged and stored in
`catalog_imports`, and never hide games.

### Content-Security-Policy

`frame-src`: `catalog.embed_hosts(conn)` — the fixed embed hosts of the enabled sources plus any host a visible game
embeds from (a few Playgama games embed from their developer's own HTTPS host). `img-src`: with the thumbnail proxy
off, `catalog.thumb_policy().hosts()`. Self-hosted games: the proxy origin.

### Self-hosted open-source games

`oss-games.toml` lists only the repositories verified in research §8.2 (pinned commit, licence file, copyright line,
entry file — all re-checked on 2026-11-10). 11 are `enabled` (static: the checkout runs as-is); the rest are listed
with `enabled = false` and the reason (build step, server component, analytics, not a finished game). An entry is
imported only when `$GNOME_OSS_GAMES_DIR/<slug>/<entry>` exists, so the catalog never lists a game that cannot load.
The server (next step) should provide the fetch step (`git clone` + checkout of the pinned `commit` into that
directory, LICENSE kept) and serve `<proxy origin>/oss/<slug>/` from it — never from the app origin.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GNOME_CATALOG_SOURCES` | `gamepix,oss` | Requested sources: `gamepix`, `gamedistribution`, `playgama`, `gamemonetize`, `famobi`, `itchio`, `js13k`, `oss` (`none` = no catalog). Sources lacking their operator ID stay disabled with a warning. gnome-server's config uses the same default (decision 2026-11-10). |
| `GNOME_GAMEPIX_SID` | `1` | GamePix publisher SID (`1` = the public default SID; an unknown SID makes the feed answer 400). |
| `GNOME_GD_PUBLISHER_ID` | – | Required to enable GameDistribution (registered publisher; acknowledges the Publisher Game License Agreement). |
| `GNOME_PLAYGAMA_CLID` | – | Required to enable Playgama; filled into embed URLs (`?clid=`). |
| `GNOME_GAMEMONETIZE_ENABLED` | `false` | Opt-in for GameMonetize, after adding the site in the GameMonetize dashboard. |
| `GNOME_FAMOBI_AFFILIATE_ID` | – | Required to enable Famobi; appended to embed URLs. |
| `GNOME_ITCHIO_FEEDS` | `games/free/platform-web` | itch.io browse paths (link-out records). |
| `GNOME_ITCHIO_MAX_PAGES` | `3` | Pages per itch.io feed (36 items each; ≤ 2 requests/min). |
| `GNOME_JS13K_FIRST_YEAR` | `2012` | First js13kGames year (link-out records). |
| `GNOME_OSS_MANIFEST` | embedded `oss-games.toml` | Alternative manifest file. |
| `GNOME_OSS_GAMES_DIR` | `$GNOME_DATA_DIR/oss-games` | Built open-source games (`<dir>/<slug>/<entry>`). |
| `GNOME_OSS_REQUIRE_BUILDS` | `true` | Only import entries whose build exists. |
| `GNOME_CATALOG_BLOCKLIST` | – | Extra trademark terms, comma-separated (`!term` removes a default). |
| `GNOME_CATALOG_BLOCKLIST_FILE` | – | File with one term per line (`#` comments, `title:` / `start:` / `label:` scopes, `!term` removes). |
| `GNOME_CATALOG_DEDUP_ORDER` | `playgama,gamepix,gamedistribution,gamemonetize,famobi,oss,itchio,js13k` | Preferred listing when the same game is in several sources. |
| `GNOME_CATALOG_USER_AGENT` | `GNOME-catalog/0.1.0` | Feed `User-Agent`; set it to `GNOME-catalog/<ver> (+https://<your site>)`. |
| `GNOME_CATALOG_REFRESH_HOURS` | `24` | (server) import interval. |
| `GNOME_THUMB_PROXY`, `GNOME_THUMB_CACHE_MB` | `true`, `256` | (server) thumbnail proxy. |

## How it works

**Schema** (`database/migrations/0100_catalog.sql`, plus `migrations/0101_catalog_search_index.sql` in this crate):
`games` keyed on `(source, source_id)` with a unique, stable
slug; `status` (`active` / `hidden` / `broken` / `ip_risk`) and `listed` are STORED generated columns derived from the
sticky admin override, the blocklist flag, the missing-sync counter, the source switch and the dedup link, so every
listing query is one partial-index scan (`WHERE listed = 1`, one index per sort order), plus a narrow covering index
of listed games (`games_listed_search`: id, playable, mobile, popularity; migration 101) that filtered counts and
the search join read instead of the wide rows. Also `game_raw` (original records), `game_categories`, `game_tags`, `games_fts`,
`game_plays_daily`, `game_play_dedup`, `catalog_imports`, `catalog_http_cache` (ETags + the ids each page listed),
`catalog_facets`, `catalog_meta`.

**FTS5 choice**: external-content table over `games` with triggers rather than contentless: the text already lives in
`games`, so no second copy is stored; the index can be rebuilt from it at any time (`'rebuild'`); and the UPDATE
trigger is restricted to the four indexed columns, so the frequent score / last-seen / status updates never touch the
index. Ranking: bm25 with weights title 10, developer 3, keywords (categories + tags + source categories) 4,
description 1, plus a strict *title tier*: games whose title contains every search word come first (bm25 saturates
term frequency, so column weights alone let repeated keyword/description mentions beat a title hit). The last word
is a prefix match (type-ahead) once it has 3 characters (`prefix='3'` index; 2-letter prefixes matched ~1 in 6
live games); diacritics and case are folded; user input is reduced to quoted words, so FTS syntax cannot be
injected.

**Query plans** (checked with `EXPLAIN QUERY PLAN` and SQLite's per-statement full-scan counters on the live
14.9k-game catalog; no hot path scans a table): every listing walks one partial sort index. A filter (category,
tag, or full-text matches) that covers a large share of the catalog is tested per row while walking
(`+g.id IN (…)`, so page 40 costs the same as page 1, and a broad type-ahead search like `the*` walks instead of
sorting 9,000 matches); a selective one drives the query from its member list. The choice compares the filter's
size with the catalog's (`6 × members² ≥ page × listed`, calibrated on the live data: ≈ 350 members for a 48-row
page at 14.7k games), so it stays right as catalogs grow; related games use the same rule per category (small
categories are never walked to the end of the index). `total` for unfiltered, category-only and tag-only listings
(each with the mobile / link-out variants) comes from `catalog_facets`, which every listing-changing operation
refreshes (during a running import it lags until the run finishes); other combinations are counted through
`games_listed_search`, driven by the most selective list. An empty total skips the page query.

**Pagination**: keyset on `(sort key, id)` with signed, query-bound cursors (HMAC-SHA256 truncated to 128 bits over
version, sort, a fingerprint of the filters, the key and the id). Tampered cursors and cursors replayed against a
different query or sort are rejected. Inserts during paging never duplicate or skip items; an hourly score refresh
can move an item across a page boundary. The `az` sort key is stored at most 300 bytes long (cut at a character
boundary), so a cursor always carries it whole, whatever the script of the title.

**Normalization**: per-source serde structs (documented in `src/sources/*`), parsed item by item so one odd record is
rejected without failing its page; sizes outside the schema's range become unknown, and a record the database still
refuses is rolled back alone (one savepoint per record) and counted as rejected. Text hygiene (`src/text.rs`)
removes control, bidi, zero-width and other invisible characters before every markup pass (so they cannot split a
tag name), decodes entities and strips markup twice (double-escaped feeds), so no tag survives whatever the escaping
depth: known HTML elements (scripts, styles and embedded documents with their content), closing tags and tags of any
name that carry attributes; other text in angle brackets (`Press <Space>`, `I <3 it`) is kept. Whitespace is
normalized, runs of combining marks are capped ("Zalgo"), lengths are capped, and every step is linear (fields are
cut at 256 KiB first). The OSS manifest is plain text by contract and is taken literally ("in a `<canvas>`").
Categories follow research §6 (per-source tables, the ordered keyword rules,
a few strong title words, ≤ 3, fallback casual; gendered labels never exposed; `shooter`/`io`/`card`/`educational`/
`music` only from a source's own categories). URLs are parsed strictly (HTTPS on each source's expected hosts; no
userinfo, IP literals or odd characters).

**Imports**: page by page (one page in memory, one transaction per page), with the source's request spacing
(GamePix/GD 1 s, Playgama 5 s, GameMonetize 10 s, itch.io 30 s), `If-None-Match`/`If-Modified-Since` from cached
validators (a 304 replays the ids that page listed), retries with exponential back-off and jitter on 429/5xx/
transport errors (honouring `Retry-After`; Cloudflare error 1015 pages count as 429). A run is **complete** only if
it reached the end of the feed without error or limit and its count is within ±10% of the previous complete sync
(and of the source's reported total). Growth beyond that is accepted (it cannot hide anything); a shrink is accepted
only once three consecutive end-reaching syncs agree on the new size, so an outage that returns part of a catalog
never hides the rest while a real removal is still honoured. Games missing from 3 consecutive complete syncs are
hidden (`status = hidden`) and come back if they reappear; entries removed from the local OSS manifest are hidden
at once. Validators are cached only for pages whose records were all stored (a page with rejected records is
fetched in full next time). A feed that repeats itself (3 pages in a row listing only games already seen in the
run, e.g. one that ignores the page parameter) or never ends (10,000 pages) stops the run as incomplete.

**Dedup**: key = folded title (+ developer when the record has one). The preferred visible listing of a group (dedup
order, then source quality) is listed; the others keep `canonical_id` → preferred id and stay stored as fallbacks —
when the preferred one is hidden, broken or its source disabled, the next takes over automatically. `by_ids` and
detail pages still resolve fallbacks, so favorites keep working.

**Ranking**: `pop_score = ln(1 + plays decayed with a 30-day half-life over 90 days) + 2 × source quality`;
`trend_score = 1.5 × ln(1 + plays decayed with a 3-day half-life over 14 days) + 0.5 × quality + 0.5 × freshness`
(freshness halves every 14 days after `published_at`). The source quality (GamePix `quality_score`, Playgama/itch
rank position, otherwise 0.5) gives a sensible order before anyone has played. Plays are anonymous daily aggregates;
`record_play` stores only a 16-byte hash of (caller key, game, hour) until the hour ends.

**Blocklist** (`src/blocklist.rs`): research brands (Minecraft, GTA, Mario, Pokémon, FNaF, Roblox, Sprunki,
Fortnite, Subway Surfers, Skibidi, Ninja Turtles, Harry Potter, Spider-Man) match titles and the feeds' own
tags/categories; other cloned franchises and clone names (Tetris, Pac-Man, Flappy Bird, Plants vs Zombies, …) match
titles only, because feeds put such words on unrelated games as SEO tags. The 2026-11-11 review added the
knock-off names whose every live title match was a knock-off (Huggy, Steve and Alex, Freddy, Granny, Addams,
Bomberman, Frogger, Doodle Jump, Speakerman, Fireboy and Watergirl, K-Pop Demon Hunters, Choo-Choo Charles) and
made "Among Us" match only at the start of a title (or in tags), since "They Are Among Us" is ordinary English.
Matches get status `ip_risk` (hidden by default; an admin can set `active`). Blocklist files accept `title:`,
`start:` and `label:` prefixes.

## Operator compliance checklist

1. **Register before enabling a network.** GameDistribution: publisher account, your domain, their Tags/`ads.txt`, a
   Google Ad Manager account. GameMonetize: add the site in the dashboard. Playgama: approved partner (CLID). Famobi:
   approved affiliate (≥ 50k visits/month). GamePix: the public `sid=1` works; use your own SID from my.gamepix.com
   to be paid. Serve `/ads.txt` with the lines the networks give you.
2. **Never proxy, rewrite or ad-block the embeds.** Load them as direct cross-origin iframes (GNOME's player does);
   do not set `referrerpolicy="no-referrer"`; exempt the games pages from GNOME's blockers; no overlays.
3. **Disclose the proxy feature** when applying to networks whose terms bar "hacking" content (GD §6.2(iii)(c),
   Playgama §6.1), keep "unblock" marketing off the games pages, or serve the catalog from its own (sub)domain.
4. **No monitoring crawlers** against GameDistribution embeds (their terms forbid it); the importer reads only the
   feed.
5. **Attribution.** Show "via <network>" and the developer when known; link `source_url`. For open-source games show
   the licence, copyright line and repository, ship the LICENSE file, and publish modified source for (A)GPL games.
6. **Removals.** Games disappear after 3 complete syncs without them; for a network's removal request set the game
   `hidden` in the admin API; when leaving a network, remove it from `GNOME_CATALOG_SOURCES` (its games stop being
   listed immediately).
7. **Review `ip_risk` games** before setting any of them `active`; extend the blocklist for your audience.
8. **Privacy and age.** Embeds load ad scripts and consent banners; run a CMP for EU visitors; several networks
   require users to be 13+.
9. **Thumbnails** are hotlinked from the networks' CDNs through `/api/thumb/:id`; caching/resizing them is not
   explicitly covered by every network's terms (research §12).
10. **Respect rate limits**: do not lower the request spacing; GameMonetize and itch.io block aggressive clients.

## Tests

`cargo test`: unit tests (text hygiene, slugs, URLs, dates, categories, blocklist, dedup keys, cursors, config,
size rule, run locking) and integration tests on temporary databases with `FixtureFetcher` serving the real captures
in `tests/fixtures/` (see its README): per-source normalization, multi-page import with request pacing, the ETag/304
path, 429/503 back-off, persistent rate limiting, incomplete-sync protection, hide-after-3-missing and revival,
limited runs, OSS builds, keyset paging stability under concurrent inserts, cursor tampering, FTS ranking, filters,
sections, facets, by-ids, detail/related, plays → rankings, admin overrides, stats, and config changes applied by
`prepare`. `tests/hardening.rs` (independent review) covers hostile text (double-escaped and split tags, unknown
elements with event handlers, invisible and stacked characters, linear time on 0.4 MB adversarial inputs), records
the database refuses, frame sizes out of range, slug collisions up to the hashed suffixes, `az` paging over long
non-Latin titles, feeds that repeat pages forever, FTS consistency through renames and deletes (`integrity-check`),
re-import idempotency, multibyte tags, and every response shape against `docs/API.md`.

Live check (development only; uses the system `curl`, no extra dependency):

```sh
cargo run --release --example live_import -- import --db /tmp/catalog.db --source gamepix
cargo run --release --example live_import -- report --db /tmp/catalog.db
cargo run --release --example live_import -- probe --source gamedistribution
```

### Live check results (2026-11-10, x86_64 dev machine, release build)

Full import of the public GamePix feed (`sid=1`, 96 per page, ≥ 1 s between requests) into a fresh database:

| Metric | Result |
| --- | --- |
| Games imported | **14,865** (155 pages, 155 requests, 0 retries, 0 rejected; run `complete`) |
| Duration | 199 s wall (3.7 s user, 2.2 s system CPU) |
| Peak RSS | 10.7 MiB importer process (`VmHWM`); 15.6 MiB max over the process tree incl. `curl` children (`getrusage` — GNU `time` is not installed on that machine) |
| Database size | 39.2 MiB after checkpoint (`games` 16.1, `game_raw` 13.2, FTS 5.3, indexes ≈ 4.5) |
| Listed / `ip_risk` | 14,621 listed; 244 `ip_risk` (skibidi 129, sprunki 63, minecraft 27, flappy bird 10, granny 5, ninja turtle 3, among us 3, terraria / roblox / mario / huggy wuggy 1 each) |
| Primary category | casual 3257 · puzzle 3037 · arcade 2348 · action 1566 · adventure 912 · sports 633 · racing 568 · strategy 521 · horror 436 · platformer 426 · simulation 327 · multiplayer 278 · idle 258 · sandbox 54 |
| Category facets (any position) | puzzle 3180 · casual 3257 · arcade 2348 · action 1694 · adventure 915 · sports 675 · racing 628 · strategy 606 · horror 568 · platformer 503 · shooter 493 · simulation 442 · idle 362 · multiplayer 305 · educational 266 · card 97 · sandbox 67 · io 48 · music 29 |

Query timings on that database (median of 20, in-process): search `chess` 0.26 ms (42 hits, title matches first;
page 2 0.27 ms) · category `puzzle` sorted popular 0.41 ms (3,180; page 40 0.48 ms) · search `zombie` in `horror`
0.54 ms · all sorted new 0.07 ms · sections 0.19 ms · categories 0.01 ms · detail + 12 related 0.55 ms ·
`refresh_rankings` 41 ms · `prepare` re-mapping all 14,865 stored records after a blocklist change: 0.33 s.

One request each to the other sources (parsers vs. the live shapes; nothing stored): GameDistribution 100/100 items
normalized (weak ETag sent), Playgama 100/100 (`totalCount` 2865), GameMonetize 100/100, Famobi 649/649 (whole feed),
itch.io 36/36, js13kGames 2026 317/317 — zero rejected records. The checks led to two blocklist fixes: Famobi
distributes the official *Cut the Rope* games (not a default term), and franchise words that feeds use as SEO tags
(e.g. `tetris` on generic block puzzles — GamePix even has a `tetris` namespace) only count in titles; the brands the
research named as tag bait (Minecraft, GTA, Roblox, …) still match tags.


### Review re-check (2026-11-11, same machine, release build)

The independent review re-ran the live import with the reviewed code (fresh database, then a second run on it):

| Metric | Result |
| --- | --- |
| Fresh import | **14,929** games (the feed grew), 156 pages / 156 requests, 0 retries, 0 rejected, `complete`; 155.3 s wall |
| Request spacing | 156 requests over 155.2 s, median gap 1.001 s; the pacer starts requests ≥ 1 s apart (also tested with variable latency on a virtual clock); timestamps taken in this example's `curl` wrapper jitter by up to 21 ms |
| Peak RSS | 10.3 MiB importer (`VmHWM`), 15.5 MiB including `curl` children |
| Re-import of the same database | `complete`, 0 inserted / 0 updated / 14,929 unchanged; no duplicate `(source, source_id)` or slug; rows, slugs and hashes identical; FTS `integrity-check` passes |
| Listed / `ip_risk` | 14,614 listed; 315 `ip_risk` (the new title terms flagged 73 more knock-offs; "The dead among us" and "They Are Among Us" are no longer flagged) |
| `prepare` re-map after the rules change | 14,929 stored records in 0.50 s: 75 changed (73 newly flagged, 2 unflagged), no stored text changed |
| Database size | 40.2 MiB (the narrow search index adds ≈ 0.4 MiB) |

Query timings on that database (median of 30, in-process; before → after the review's plan changes): search `the`
sorted popular 12.5 → 2.5 ms · search `game` sorted az 7.4 → 1.3 ms · search `car` page 4 4.6 → 1.7 ms · search
`puzzle game` 5.1 → 2.8 ms · `match` in `puzzle` 6.2 → 2.8 ms · detail + related for a small category (`sandbox`)
0.78 → 0.19 ms and for `multiplayer`/`io` 1.33 → 0.35 ms · unchanged: listing pages 0.08 ms, `puzzle` popular
0.43 ms (page 40 0.52 ms), sections 0.20 ms, search `chess` 0.30 ms. Only the admin `stats` and `embed_hosts` scan
the `games` table (≈ 7–9 ms).