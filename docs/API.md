# GNOME HTTP API

Served by `gnome-server` (Rust/Axum). All JSON. Times are Unix **milliseconds** unless stated. IDs are strings unless
stated. This document is the contract between the frontend and the backend — change both sides together.

## Conventions
- **Two origins** (ARCHITECTURE §4.6): the *app origin* serves the SPA and `/api/*`; the *proxy origin* serves only the
  engine host, `/sw.js`, `/vendor/**`, the shared hashed `/assets/*`, `/wisp/*`, read-only `GET /api/filters*` and
  `GET /api/health`. In single-origin mode one origin serves both roles. Endpoints below are app-origin unless marked
  **[proxy origin]** or **[both origins]**. On the proxy origin every other path is `404` (unsafe methods may get
  `403 forbidden` from the CSRF check first).
- Base path: `/api/`. Admin endpoints live on a **separate listener** (default `127.0.0.1:9091`) under `/admin/` and
  are never mounted on the public listener.
- Errors: HTTP status + body `{"error": {"code": "snake_case_code", "message": "Human readable", "retry_after_s"?: n}}`.
  Codes: `bad_request` (400; also malformed JSON or a missing `Content-Type: application/json`), `validation_failed`
  (422, + `fields: {name: msg}`), `unauthorized` (401), `forbidden` (403), `not_found` (404), `method_not_allowed`
  (405, + `Allow`), `conflict` (409), `payload_too_large` (413), `quota_exceeded` (413, + `scope`; see "Usage, quotas and paging"), `rate_limited` (429 + `Retry-After`),
  `access_code_required` (401), `login_required` (401), `internal` (500), `timeout` (503: no response within 30 s),
  `unavailable` (503 + `Retry-After`: the filter lists are not ready yet, see "Content-blocking filter lists"; on the
  Wisp gateway: shutting down).
  Wisp gateway only: `upgrade_required` (426, + `Upgrade: websocket`), `too_many_connections` (429, no `Retry-After`:
  a slot frees when a connection closes), `bad_gateway` (502), `wisp_upstream_unavailable` (503 + `Retry-After: 10`
  and `retry_after_s`, only to a ticket probe while the route's upstream is down, see "Ticket probe"), and for tickets
  (401): `wisp_ticket_missing` (no `t` parameter or an empty one), `wisp_ticket_invalid` (malformed, forged or
  tampered, from another server or another access policy, or more than one `t`), `wisp_ticket_expired`,
  `wisp_ticket_revoked` (`accounts` mode: its user session was revoked or expired).
  `fields` keys are JSON paths of the offending values: `username`, `items[3].url`, or `body` for the document as a
  whole; a missing member reads `"is required"`.
- **CSRF**: every non-GET/HEAD request must carry `X-GNOME-Request: 1` and, if an `Origin` header is present, it must
  be an allowed origin. Otherwise `403 forbidden`.
- Cookies (all `HttpOnly; SameSite=Strict; Path=/`; `Secure` when the request arrived over HTTPS, when its app origin
  is a plain-HTTP loopback origin such as `http://127.0.0.1:8080` or `http://localhost:5173` (browsers accept `Secure`
  cookies there; `GNOME_COOKIE_SECURE=auto`), or with `GNOME_COOKIE_SECURE=true`). Secure cookies carry the `__Host-`
  prefix (`__Host-gnome_sid`, `__Host-gnome_auth`): browsers then refuse copies set by any other host of the site (such
  as the proxy hostname), so a proxied page cannot plant a session. When cookies are secure only the prefixed names are
  read. (In the loopback two-port dev mode both roles are one host, whose cookies browsers share across ports; the
  prefixed names give parity with production but cannot keep the ports apart.)
  - `gnome_sid` — anonymous session, stateless signed token `v1.<exp_s>.<rand_b64url>.<hmac_b64url>` (30 days). The
    signing key is bound to `GNOME_ACCESS_MODE` and the access code: changing either invalidates existing anonymous
    sessions.
  - `gnome_auth` — user session, random 32-byte token (stored as SHA-256 in DB), 30-day sliding expiry (the cookie is
    re-issued when the expiry slides, at most hourly).
- Request body limit: 256 KiB (sync batch endpoints: 2 MiB).
- Rate limits (token buckets; per client IP — real IP resolved through `GNOME_TRUSTED_PROXIES`, IPv6 per /64 — and,
  where noted, per session; all multiplied by `GNOME_RATE_LIMIT_SCALE`, 0 disables):

  | Class | Applies to | Per IP (burst / refill) | Per session |
  | --- | --- | --- | --- |
  | `api` | every `/api/*` request on either origin (baseline) | 300 / 600 per min | – |
  | `session_create` | `POST /api/session`; `POST /api/wisp/ticket` when it creates the anonymous session (`open` mode) | 20 / 20 per min | – |
  | `auth` | register, login, password change, account deletion | 10 / 10 per min | – |
  | `sync` | `/api/sync/*` | 300 / 300 per min | 60 / 120 per min |
  | `wisp_ticket` | `POST /api/wisp/ticket` | – | 30 / 30 per min |
  | `wisp_upgrade` | `/wisp/` upgrades and ticket probes together (proxy origin) | 60 / 60 per min | – |
  | `admin` | every admin-listener request (checked before the token) | 60 / 120 per min | – |
  | `thumb` | `GET /api/thumb/:id`, counted instead of `api` (a long scroll loads hundreds) | 600 / 1200 per min | – |
  | `thumb_fetch` | thumbnail cache misses that need an upstream fetch (on top of `thumb`) | 60 / 120 per min | – |
  | `vpn_check` | `POST /api/vpn/locations/:id/check` (the VPN module also keeps a 60 s gap per location) | 6 / 6 per min | – |

  Exhausted → `429 rate_limited` with `Retry-After` (whole seconds) and `retry_after_s`.

## Public, unauthenticated
### `GET /api/health` [both origins]
`200 {"status":"ok","version":"0.1.0","uptime_s":123,"db":"ok","wisp":{"direct":"up"|"down"|"unknown","<profile id>":…}}` ·
`503 {"status":"degraded",…,"db":"error",…}` when the database cannot be read. `wisp` has one entry per Wisp upstream:
`direct` (`GNOME_WISP_UPSTREAM`) and each VPN profile id. A status is `unknown` until the first probe (≈1 s after start,
then every 60 s: TCP connect + WebSocket handshake + first Wisp frame) and `down` when the last probe failed or is older
than 3 minutes. Wisp status never makes the response `503`.
**Proxy origin** (two-origin mode): every proxied page can read this answer, so it is only
`{"status":"ok"|"degraded","wisp":{"direct":…}}` (same status codes): no `version`, `uptime_s` or `db`, and no VPN
profile ids. The app origin and single-origin mode answer the full form above; the app passes VPN location status
(`GET /api/vpn/locations`) to the engine host itself.

### `GET /api/config`
Runtime configuration for the SPA.
```json
{
  "version": "0.1.0",
  "access_mode": "open" | "code" | "accounts",
  "registration": "open" | "closed",
  "features": { "accounts": true, "sync": true, "games": true, "vpn_gateway": true, "thumb_proxy": true },
  "wisp": { "path": "/wisp/", "ticket_ttl_s": 3600, "custom_servers": false, "profiles": [ { "id": "se-got", "label": "Sweden · Gothenburg", "country_code": "se", "city": "Gothenburg", "path": "/wisp/p/se-got/" } ] },
  "engines": { "default": "scramjet", "scramjet": true, "ultraviolet": true },
  "proxy": { "origin": "https://p.gnome.example.com", "isolated": true },
  "source_url": "https://example.com/gnome-source",
  "limits": { "max_ws_per_session": 16 }
}
```
`proxy.origin` is the origin the app must embed `/engine/` from and connect Wisp to (equal to the app origin in
single-origin mode, where `isolated` is `false`; `null` if the server cannot tell which origin the request used).
`wisp.ticket_ttl_s` is `GNOME_WISP_TICKET_TTL_S` (the upper bound of a ticket's lifetime); `wisp.custom_servers` is
`GNOME_ALLOW_CUSTOM_WISP`: only when it is `true` may the app route the engines through Wisp servers the user entered
(the engine-host and bare-mux worker policies then allow `ws: wss:`); `wisp.profiles` lists the
VPN gateway profiles (empty without `GNOME_VPN_PROFILES`; `features.vpn_gateway` is `true` when there is at least one).
`features.sync` follows `features.accounts` (`GNOME_ACCOUNTS`); `registration` is `"closed"` when accounts are off.
`features.games` is `true` while at least one catalog source is enabled (`GNOME_CATALOG_SOURCES`, not `none`) and
`features.thumb_proxy` follows `GNOME_THUMB_PROXY`; both are set by the games module.

### `POST /api/session`
Creates (or refreshes) the anonymous session cookie `gnome_sid` (same session id, new 30-day expiry).
Body (optional; only used in `code` mode): `{"access_code": "..."}` — not needed to refresh a still-valid session.
`200 {"session":{"kind":"anonymous"|"user","expires_at":ms,"user":User|null}}` · `401 access_code_required` ·
`401 login_required` (in `accounts` mode without `gnome_auth`; with it the response is `kind: "user"` and no
`gnome_sid` is issued). Rate limit: 20/min/IP.

### `GET /api/session`
`200 {"session":{"kind":"anonymous"|"user","expires_at":ms,"user":User|null,"proxy":boolean}}` or
`401 unauthorized` (no valid session; in `accounts` mode also with only an anonymous `gnome_sid`). `kind` is `user`
whenever `gnome_auth` is valid. `proxy` tells whether these cookies authorize the proxy under the current access mode
(`accounts`: signed in; `open`/`code`: a valid `gnome_sid`).

### `POST /api/wisp/ticket`
Mints a Wisp ticket for the current session (anonymous `gnome_sid` in `open`/`code` mode — created on the fly in `open`
mode; `gnome_auth` in `accounts` mode) **and the route the app chose** (Wave C D23). CSRF rules apply. Rate limit:
30/min/session (creating the anonymous session in `open` mode also counts against `session_create`, 20/min/IP).
Body (optional): `{"route": "default"}` or `{"route": {"profile": "<id>"}}`; no body, `{}` or `"route": null` =
`default` (the direct route `/wisp/`).
`200 {"ticket":"w2.<exp_s>.<iat_s>.<route>.<session_ref>.<mac>","expires_at":ms,"wisp_url":"wss://p.gnome.example.com/wisp/"}`
(+ `Set-Cookie: gnome_sid=…` when the anonymous session was created) · `400 bad_request` (the body is not JSON) ·
`422 validation_failed` with `fields.route` ("unknown VPN location", or `must be "default" or {"profile": "<id>"}`)
· `401 access_code_required` (`code` mode without a session) · `401 login_required` (`accounts` mode) ·
`429 rate_limited`.
- `expires_at` = min(now + `GNOME_WISP_TICKET_TTL_S`, the session's expiry); the engine host renews before it.
- Ticket (`w2`): `exp_s` = expiry and `iat_s` = mint time, Unix **seconds** (decimal, no leading zeros); `route` = `d`
  (direct) or `p` followed by the profile id in unpadded base64url (ids may contain the separator `.`); `session_ref`
  = 16 bytes base64url (22 chars), a stable non-secret digest of the session (the same for every ticket of that
  session; it cannot be turned back into a cookie); `mac` = HMAC-SHA256 base64url (43 chars) over everything before
  it, with a key derived from the server's secret key for tickets only (bound to the access mode and code, like
  anonymous sessions: changing them invalidates outstanding tickets). `w1` tickets (no route) are refused as
  malformed. Treat it as opaque.
- A ticket works **only on its own route**: `/wisp/?t=…` for `d`, `/wisp/p/<id>/?t=…` for that profile. The gateway
  refuses it with `401 wisp_ticket_wrong_route` on another path, `401 wisp_ticket_stale` when it was minted before
  the server process started (the engine host re-mints through `needTicket {reason: 'rejected'}`), and, for a
  default-route ticket, `401 wisp_ticket_superseded` when the session minted a profile-route ticket after it (the
  latest profile mint per session is kept in memory for the ticket TTL). The 15 s session re-check also closes that
  session's open default-route connections the superseded rule now refuses. Connections on a previous *profile* route
  keep running until their page reloads (WAVE-C O16).
- `wisp_url` is `ws://…` when the proxy origin is plain `http://` (development). Connect to
  `<wisp_url>?t=<ticket>&/` (canonical form, see "Wisp" below); for a VPN profile use the profile's `path` on the same
  origin with a ticket minted for that profile: `wss://<proxy origin>/wisp/p/<id>/?t=<ticket>&/`.
- `GNOME_WISP_TICKET_TTL_S` defaults to 3600 (1 h; at most 604800). A ticket is checked only when a connection is
  upgraded: open connections outlive its expiry, so the engine host renews before `expires_at` (and after a probe
  answers 401) for its *next* connection.

## Accounts (optional; disabled → 404)
| Method & path | Body | Response |
| --- | --- | --- |
| `POST /api/auth/register` | `{"username","password"}` (username 3–32 `[a-zA-Z0-9_.-]`, password 10–256 chars, not only whitespace) | `201 {"user":User}` + sets `gnome_auth`; `403 forbidden` (registration closed), `401 access_code_required` (`code` mode without a valid `gnome_sid`), `409 conflict` (username taken), `422` (`fields.username`, `fields.password`) |
| `POST /api/auth/login` | `{"username","password"}` | `200 {"user":User}` + sets `gnome_auth`; `401 unauthorized` generic "invalid credentials" |
| `POST /api/auth/logout` | – | `204` (clears cookie, deletes the session row of every `gnome_auth` sent; idempotent) |
| `GET /api/auth/me` | – | `200 {"user":User}` / `401 unauthorized` |
| `POST /api/auth/password` | `{"current","next"}` | `204` (revokes other sessions); `422` (`fields.next`: the password rules; `fields.current`: "is incorrect") |
| `DELETE /api/auth/account` | `{"password"}` | `204` (deletes user + all synced data, clears the cookie); `422` (`fields.password`: "is incorrect") |

`User = {"id": number, "username": string, "is_admin": boolean, "created_at": ms}`
Rate limit (register, login, password change, account deletion): 10/min/IP. Login, password change and account
deletion also back off per username after 5 failures in 15 min (an attempt counts from the moment it starts, so
concurrent guesses get no more than the five; locked → `429` with `Retry-After`, for existing and unknown usernames
alike).
Passwords: Argon2id (m=19 MiB, t=2, p=1 — OWASP baseline; tunable via env for Raspberry Pi).

## Sync (requires `gnome_auth`; local-first — the client is the source of truth, the server is a mirror)
### Settings
- `GET /api/sync/settings` → `{"data": object|null, "updated_at": ms|null}`
- `PUT /api/sync/settings` body `{"data": object, "base_updated_at": ms|null}` → `200 {"updated_at": ms}`;
  `409 conflict` with the server copy (top-level `data` + `updated_at`) if `base_updated_at` is stale (client merges &
  retries). Max 256 KiB; `422` (`fields.data`) for a document nested deeper than 128 levels or holding a number outside
  the double range.

`since` cursors: every pull returns `server_time`; pass it back as `since` on the next pull. It is the account's
sync clock (all rows in the response have `synced_at` ≤ it, every later write gets a larger value), so a device never
misses an upload, whatever client timestamps say and even after deletions or a server clock step backwards. It is the
clock even when `since` is larger (a cursor from the future, e.g. after a server restore, is corrected, not kept).

### Bookmarks
`Bookmark = {"id": uuid, "parent_id": uuid|null, "kind": "bookmark"|"folder", "title": string, "url": string|null,
"position": number, "created_at": ms, "updated_at": ms, "deleted": boolean}`
- `GET /api/sync/bookmarks?since=ms` → `{"items": Bookmark[], "server_time": ms}` (changes received after `since`,
  oldest first, including tombstones; tombstones are kept 180 days and carry `title: ""`, `url: null`)
- `POST /api/sync/bookmarks` body `{"items": Bookmark[]}` (≤ 5000) → `{"applied": n, "server_time": ms}`
  (last-writer-wins per id on `updated_at`; ties keep the stored copy; a batch is applied entirely or not at all).
  An item that loses re-announces the stored copy: the next pull returns the winner, so the device that sent the
  loser converges (clients should still stamp an edit `max(now, updated_at + 1)` of the version they edited).
  Live bookmarks are limited to 20 000 per account (`422` on `items` beyond that); tombstones to 50 000 (the oldest
  are dropped). Tombstones need only `id` and the timestamps. Folders must have `url: null`.

### History (only when the user has turned on history sync)
`HistoryEntry = {"id": uuid, "url": string, "title": string|null, "visited_at": ms}`
- `GET /api/sync/history?since=ms&limit=500&cursor=` → `{"items": HistoryEntry[], "next_cursor": string|null,
  "server_time": ms, "cleared_before": ms|null}` — entries received after `since`, keyset-paged (`limit` 1–1000,
  default 500; pass `next_cursor` as `cursor` until it is `null`, then keep the last `server_time` as the next
  `since`). `cleared_before`: the user deleted everything visited before it — drop local copies older than that.
- `POST /api/sync/history` body `{"items": HistoryEntry[]}` (≤ 5000) → `{"applied": n}` (new ids inserted, changed
  ones updated; entries visited before `cleared_before` are ignored; the server keeps the newest 100 000 visits).
- `DELETE /api/sync/history` body `{"before": ms}` or `{"all": true}` → `204`

### Usage, quotas and paging (Wave D)
- `GET /api/sync/usage` → `{"used_bytes", "quota_bytes", "history_bytes", "bookmarks_bytes", "settings_bytes"}`: the
  account's stored sync bytes (as the server counts them) against `GNOME_SYNC_QUOTA_MB`.
- A bookmark or settings write that would grow the account past its quota answers `413 quota_exceeded` with
  `scope: "account"` (plus `used_bytes`, `quota_bytes`); when all accounts together pass `GNOME_SYNC_TOTAL_MB`, every
  kind answers it with `scope: "server"`. A write that does not grow the total always applies, so an account over a
  lowered quota can shrink. A history upload over the quota is applied and the oldest visits are trimmed. The history upload
  answer is `{"applied": n, "trimmed": n}` (`trimmed` 0 when nothing was trimmed).
- `GET /api/sync/bookmarks` also takes `limit` (1–1000) and `cursor`, and answers `next_cursor` (`null` on the last
  page). Every page of either pull route stops at 1 MiB of JSON. A bookmark pull without `limit` returns whole change
  groups up to 1 MiB with `server_time` at the last one, so an older client fetches the rest with `since=`. An invalid
  cursor answers `400 bad_request` ("invalid cursor").
- An account runs at most two pulls at once; a third, or a pull when the server's 64 MiB budget for large answers is
  used up, answers `503 unavailable` with `Retry-After: 1`.

### Connection and request limits (Wave D)
- More requests in flight from one client than `GNOME_MAX_INFLIGHT_PER_IP` (×4 for its IPv6 /56, ×16 for its /48):
  `503 unavailable` + `Retry-After: 1` with a top-level `"tier"` (`ip`, `prefix56`, `prefix48`).
- Request heads: 64 KiB, or 1 MiB from a trusted proxy on the app listener and from loopback on the proxy listener;
  a larger head gets a bodiless `431` (strict CSP, `Connection: close`). Heads over 64 KiB share the
  `GNOME_MAX_INFLIGHT_HEAD_MB` budget; when it is used up: a bodiless `503` + `Retry-After: 1`.
- A full connection cap (`GNOME_MAX_CONNECTIONS`) gets the same bodiless `503`; connections beyond
  `GNOME_MAX_CONNS_PER_IP` from an untrusted peer are closed at once.
- Wisp upgrades: `429 server_full` once Wisp connections reach 90 % of the connection cap; `431` for an upgrade head
  over 64 KiB from a non-loopback peer.
- `GET /api/config` → `proxy.cookieHygiene`: `"app"` (default) or `"registrable"` (`GNOME_COOKIE_HYGIENE`): which
  cookies the app clears that proxied pages planted for its hostname.
- `/admin/diagnostics` adds `connections` (caps, active, refusals per reason), `proxy_trust` and the database's sync
  totals.

IDs are UUIDs (8-4-4-4-12 hex). URLs are validated (`http:`/`https:` only, ≤ 4096 chars); titles ≤ 512 chars; client
timestamps must be ≥ 0 and at most 24 h in the future.

## Games catalog (public)
Served by the games module on the **app origin** in every access mode (D8: `GNOME_ACCESS_MODE` means "who may use the
proxy"). All under the `api` rate class except `/api/thumb/` (`thumb`); JSON; `Cache-Control: no-store` unless
stated. While the module's start-up hook has not run, failed, or the database cannot be read: `503 unavailable` with
`Retry-After: 30`. With `GNOME_CATALOG_SOURCES=none` the routes answer `404` and `/api/config` reports
`features.games: false`.

`GameSummary = {"id": number, "slug": string, "title": string, "developer": string|null, "thumbnail": string|null,
"categories": string[], "mobile": boolean, "source": string, "added_at": ms, "plays": number, "playable": boolean}`
— `thumbnail` is `/api/thumb/<id>` when the thumbnail proxy is on, otherwise the source URL. `playable: false` = a
link-out entry (itch.io, js13kGames): open `source_url` in a new tab, never in an iframe.

`GameDetail = GameSummary & {"description": string, "instructions": string, "tags": string[], "embed_url": string,
"width": number|null, "height": number|null, "source_url": string|null, "developer_url": string|null,
"license": string|null, "published_at": ms|null, "attribution": string, "embed_kind": "iframe"|"selfhost"|"link",
"orientation": "landscape"|"portrait"|"any"|null, "flags": string[], "embed_allowed": boolean, "oss":
{"repository": string, "commit": string, "license_file_url": string}|null}` — `flags` ⊆ `kids_friendly`, `no_blood`,
`no_cruelty`, `iap`, `paid`. `embed_allowed` = the server's frame policy accepts this game (its embed host is a fixed
host of an enabled source or an operator-approved developer host; always `false` for `link`); `oss` is set for
open-source games only (`license_file_url` = `<proxy origin>/oss/<slug>/<license file>`). Titles, descriptions and
instructions are plain text (they may contain `<`).

Query-parameter problems answer `400 bad_request` with a message naming the parameter: `limit must be 1-100`,
`unknown category: <slug>`, `unknown sort: <value>`, `invalid cursor`, `cursor does not belong to this query`,
`q is limited to 100 characters`, `at most 20 categories can be excluded`, `ids must be comma-separated integers`,
`at most 200 ids`, `tag prefix is limited to 40 characters`. Unknown `exclude` slugs are ignored (they match no game).

| Endpoint | Notes |
| --- | --- |
| `GET /api/games?q=&category=&tag=&sort=&mobile=1&exclude=&include_link_out=1&cursor=&limit=` | `q` ≤ 100 chars (the last word is a prefix from 3 letters). `sort` ∈ `relevance` (default when `q`), `popular` (default), `trending`, `new`, `featured`, `az`. `mobile=1` = only games that work on touch screens; `exclude=<slug,…>` (≤ 20) leaves out games in any of those categories; link-out entries only with `include_link_out=1`. `limit` 1–100 (default 48). Keyset pagination: an opaque `cursor`, bound to every parameter but `cursor` and `limit`. → `{"items": GameSummary[], "next_cursor": string\|null, "total": number}` |
| `GET /api/games/sections?mobile=1&exclude=` | → `{"featured": [...], "trending": [...], "popular": [...], "new": [...]}` (≤ 24 each, playable games only; `featured` = admin picks topped up by source quality) |
| `GET /api/games/categories?include_link_out=1` | → `{"categories": [{"slug","name","count"}]}`: the 14 core categories always (count may be 0), optional ones when used |
| `GET /api/games/tags?prefix=&limit=` | `prefix` ≤ 40, `limit` 1–100 (default 30) → `{"tags": [{"tag","count"}]}` |
| `GET /api/games/by-ids?ids=1,2,3` | ≤ 200 ids, order preserved, games no longer visible omitted → `{"items": GameSummary[]}` |
| `GET /api/games/status` | → `{"listed", "playable", "importing", "sources": [{"id", "name", "last_import": {"status", "finished_at"}|null}]}`: listed games, listed games of playable sources, whether a run of any source is running, and per enabled source its display name and the last finished run's status and time (never error texts or URLs) |
| `GET /api/games/:slug?mobile=1&exclude=` | → `{"game": GameDetail, "related": GameSummary[]}` (12 related; `mobile`/`exclude` apply to `related`) · `404 not_found` for an unknown, hidden, broken, `ip_risk` or disabled-source game |
| `POST /api/games/:slug/play` | no body; CSRF rules. Anonymous aggregate counter: `204` whether counted or a duplicate within the hour · `404 not_found`. Dedup key: an HMAC of the session reference (`gnome_auth` or `gnome_sid`), else an HMAC of the client IP (IPv6 as its /64); only the catalog's 16-byte hourly hash is stored, no user id |
| `GET /api/thumb/:id` | `200` image bytes from the enabled sources' thumbnail hosts (SSRF-safe client, ≤ 2 MiB, the declared type must be an allowed raster type **and** match the file's magic bytes): `Content-Type` = the sniffed type, strong `ETag`, `Cache-Control: public, max-age=<min(604800, the upstream's max-age)>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; `304` on `If-None-Match` · `404 not_found` (unknown or invisible game, no thumbnail, an OSS thumbnail, a URL the source's policy refuses, an upstream 4xx, or a refused answer: type, sniff, size) · `429 rate_limited` (`thumb` or `thumb_fetch`) · `503 unavailable` + `Retry-After: 60` (upstream 5xx, timeout, network). Cached on disk up to `GNOME_THUMB_CACHE_MB` (`0` = validated pass-through, nothing stored) |
| `GET`/`HEAD /play-frame/:slug` | The game's **wrapper document** (not under `/api/`): `200 text/html`, `Cache-Control: no-store`, `X-Frame-Options: SAMEORIGIN`, `Content-Security-Policy: default-src 'none'; frame-src <exactly this game's embed origin, or <proxy origin>/oss/<slug>/>; style-src '<hash>'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, COOP and `Permissions-Policy` like all app HTML. It runs no script and holds one sandboxed `<iframe>` of the game (`referrerpolicy` per source). `404` (HTML under `default-src 'none'; frame-ancestors 'self'`) for an unknown, invisible or link-out game and whenever the frame policy refuses it · `503` while the module is not prepared |
| `GET /ads.txt` | The `GNOME_ADS_TXT` file: `text/plain; charset=utf-8`, `Cache-Control: public, max-age=3600`, ≤ 64 KiB (larger: `404` and a warning in the log); `404` when unset or missing |

Categories (slugs): `action adventure arcade racing sports puzzle strategy multiplayer simulation idle platformer
casual horror sandbox` (+ `shooter`, `io`, `card`, `educational`, `music` if sources provide them).

## Content-blocking filter lists (public) [both origins]
The server mirrors upstream lists (uBO/ABP filter text) and uBO's redirect resources; the client builds the engine
(ARCHITECTURE §5.5). Read-only, no session, no cookies; served on the app and the proxy origin.

`FilterList = {"id","name","category":"ads"|"privacy"|"annoyances"|"cookies"|"urlparams"|"security"|"resources",
"format":"abp"|"resources","license","homepage","default_enabled": bool,"trusted": bool,"available": bool,
"size": bytes,"sha256": string|null,"updated_at": ms|null,"fetched_at": ms|null,"version": string|null}`
- `available`: the body is stored and served (`false` until the first successful fetch: `size` 0, `sha256`,
  `updated_at` and `version` `null`). `sha256` is the hex SHA-256 of the body. `updated_at` = when the content last
  changed, `fetched_at` = last successful upstream check. `version` = the list's `! Version:` header, else its
  `! Last modified:` (uBO's CDN copies have no version).
- `trusted`: the list may use the scriptlets that need trust (`trusted-*` and every scriptlet the resources mark
  `requiresTrust`, by name and alias): such a list can run code in the pages it names. The client drops those lines
  from every other list (`docs/WAVE-B3.md` D11, `docs/research/content-blocking.md` §2.7).
- `format: "resources"` is the one non-filter entry (`ubo-resources`, `category: "resources"`): uBO's redirect
  resources and scriptlets as the JSON `{"redirects": [...], "scriptlets": [...]}` that
  `FiltersEngine.updateResources()` loads.
- Built-in lists (ids are uBO's asset keys; `default_enabled` = research §5.2 defaults): `easylist`, `ublock-filters`,
  `ublock-badware` (security), `ublock-quick-fixes`, `ublock-unbreak`, `plowe-0` (ads, on); `easyprivacy`,
  `ublock-privacy` (privacy, on); `adguard-spyware-url` (urlparams, on); `fanboy-cookiemonster`, `ublock-cookies`
  (cookies, off); `ublock-annoyances-others` (annoyances, off); `ubo-resources` (on). Operators change the set with
  `GNOME_FILTER_LISTS_FILE`.
- **Lists from files.** Operators may also add lists from local files (`file = "/absolute/path"` instead of `url` in
  `GNOME_FILTER_LISTS_FILE`, also for `ubo-resources`; backend/README.md "Filter lists"). They are listed and served
  exactly like downloaded lists (same fields, ETags, `?v=` caching); `homepage` is `""` when the operator gave none,
  `fetched_at` is the last successful read of the file. The listing never shows a file's path or an operating-system
  error: a file that is missing or not a valid list is simply `available: false` until it can be read (the reason, a
  fixed word such as `file-missing`, is only in `/admin/diagnostics`).

- `GET /api/filters` → `{"lists": FilterList[], "resources": FilterList | null}` (registry order; `ETag`,
  `Cache-Control: no-cache`, `304` on `If-None-Match`). `503 unavailable` (+ `Retry-After`) only during the first
  seconds after start while stored lists are verified.
- `GET /api/filters/:id` → the body: `text/plain; charset=utf-8` (`format: "abp"`) or `application/json`
  (`resources`). Precompressed `br` / `gzip` per `Accept-Encoding` (`Vary: Accept-Encoding`, `Content-Encoding`).
  Strong ETag `"<sha256>"`, `"<sha256>.br"` or `"<sha256>.gz"` per representation; `If-None-Match` with any of them
  (or `*`) → `304`. `Cache-Control: no-cache`, or `public, max-age=31536000, immutable` when requested as
  `?v=<sha256>` and that is the current content (use the `sha256` from the listing to build cache-busting URLs).
  Unknown id → `404`; not downloaded yet → `503 unavailable` + `Retry-After: 60`; replaced twice while the request
  was looking it up (rare) → `503 unavailable` + `Retry-After: 1`; stored lists still being verified after a start →
  `503 unavailable` + `Retry-After: 2` (also for `GET /api/filters`). A `200` body always matches its ETag.

## VPN gateway (public metadata)
- `GET /api/vpn/locations` →
  `{"profiles":[{"id","label","country_code","country","city","provider_note","path","status":"up"|"down"|"unknown","checked_at":ms,"exit":VpnExit}],"verify_url":string|null,"check_service":string|null}`
  (`checked_at` = time of the last health probe, `null` before the first; `status` as in `/api/health`;
  `country_code` lowercase ISO 3166-1 alpha-2; `provider_note` may be empty). Empty `profiles` without
  `GNOME_VPN_PROFILES`. `verify_url` is `GNOME_VPN_CHECK_URL` or **`null` (the default: no exit checks at all)**; the
  browser's own optional check (Settings → VPN → "Check this browser's exit", off by default) loads it *through the
  proxy path* of the location. `check_service` is its host (with `:port` when not the scheme's default), for the
  wording "<service> reports …".
- `VpnExit = {"state": "ok"|"failed"|"unchecked"|"off", "ip", "country", "city", "provider_exit": bool|null,
  "country_match": bool|null, "checked_at": ms|null, "error": "upstream_unreachable"|"connect_failed"|"tls_failed"|"http_status"|"bad_answer"|"timeout"|null,
  "v6": {"state","ip","error"}|null}` — the **server's own check** of that location's exit, made through the location's
  HolyWisp (Wisp + TLS + one GET with `User-Agent: exit-check/1`, 15 s deadline) every `GNOME_VPN_CHECK_INTERVAL_MIN`
  ± 20 % and on request. `state` is `off` for every profile while checks are off. `provider_exit` copies the service's
  `mullvad_exit_ip`-style boolean when it sends one; `country_match` compares the answer with the profile's country.
  `v6` is the same check against `GNOME_VPN_CHECK_URL_V6` (`null` when unset). A failed check is information only: it
  never changes routing or the health `status`.
- **Access gate**: the exit details are shown only to clients the access policy lets use the proxy (anyone in `open`
  mode, a valid anonymous session in `code` mode, a signed-in user in `accounts` mode; no cookie is issued). Everyone
  else gets `exit` = `{"state": "unchecked"}` with every other field `null`, so egress addresses stay private.
- `POST /api/vpn/locations/:id/check` (CSRF rules; `vpn_check` rate class; **exists only when checks are on**, else
  `404`) → `200 {"exit": VpnExit}` once the check finished (≤ 20 s, ≤ 35 s with an IPv6 name; a check of that location
  younger than 60 s is answered without a new one; a running one is joined) · `401 access_code_required` /
  `401 login_required` (as `POST /api/wisp/ticket`) · `404 not_found` (unknown id) · `429 rate_limited`.
- Connection itself happens over Wisp at the profile's `path` with a ticket minted for that profile (see "Wisp
  tickets" above and "Wisp" below). Operator setup: `services/vpn/README.md`.

## Wisp (WebSocket) [proxy origin]
- `GET /wisp/?t=<ticket>&/` (Upgrade: websocket) → direct egress via the primary HolyWisp instance.
- `GET /wisp/p/:profile/?t=<ticket>&/` → egress through a configured VPN gateway profile (unknown id → `404`).

**Ticket URL forms.** The canonical form is `?t=<ticket>&/`: libcurl-based transports (libcurl-transport 1.x and 2.x)
refuse a Wisp URL that does not end in `/`, and the trailing empty-key pair `/` is ignored, so one form works for every
transport. Also accepted: `?t=<ticket>` and `?t=<ticket>/` (exactly one trailing `/` is stripped from the raw value;
`?t=<ticket>//` is invalid). Other query parameters are ignored, more than one `t` is `wisp_ticket_invalid`, and the
value is percent-decoded after the strip (tickets need no encoding; a decoded `%2F` is not stripped). The query never
reaches HolyWisp.

**Ticket probe.** A plain `GET` (or `HEAD`) of `/wisp/` or `/wisp/p/:profile/` *without* an `Upgrade` header, with the
same query, tells the engine host whether its ticket would be accepted (a browser cannot read the status of a refused
WebSocket): after checks 1–2 below it answers `401` with one of the `wisp_ticket_*` codes (check 5's rules), or
`426 upgrade_required` (+ `Upgrade: websocket`) when the ticket is valid. The probe needs **no** `Origin` (a same-origin
`fetch` GET carries none), counts against the `wisp_upgrade` rate limit (429 with `Retry-After`, never 401), takes no
connection slot, never contacts HolyWisp, and never mints, extends or consumes a ticket. Unknown profile → `404`. While
the health job has the route's upstream down (its last probe failed or is older than 3 minutes; the direct HolyWisp for
`/wisp/`, the profile's for `/wisp/p/:profile/`), a valid ticket gets `503 wisp_upstream_unavailable` with
`Retry-After: 10` (and `retry_after_s`) instead of `426`, because an upgrade would only fail with `502`; such a probe
asks the health job for an early round (at most every 10 s), so the next probe after `Retry-After` sees the new state.
A ticket the upgrade would refuse still gets its `401` first. A network error means the gateway itself is unreachable.

Upgrade requirements, checked in this order before anything is upgraded (each refusal is a JSON error):
1. per-IP upgrade rate 60/min → `429 rate_limited`;
2. a known profile → `404 not_found`;
3. an HTTP/1.1 `GET` WebSocket upgrade (`Upgrade: websocket`, `Connection: upgrade`, `Sec-WebSocket-Version: 13`, a valid
   `Sec-WebSocket-Key`) → `426 upgrade_required` (a wrong version also gets `Sec-WebSocket-Version: 13`); header
   values that are not visible ASCII or too long → `400 bad_request`;
4. exactly one `Origin`, equal to the proxy origin (single-origin mode: the app origin) → `403 forbidden`;
5. a valid, unexpired ticket in exactly one `t` parameter → `401 wisp_ticket_missing` · `wisp_ticket_invalid` ·
   `wisp_ticket_expired` · `wisp_ticket_revoked` (`accounts` mode: its user session was revoked or expired; checked
   against the database at most every 15 s per session);
6. ≤ 32 concurrent connections per client IP (IPv6 /64), ≤ 16 per session (`session_ref`) → `429 too_many_connections`;
7. upstream unreachable, timed out (5 s connect, 10 s response head) or answering anything but `101` → `502 bad_gateway`;
   shutting down → `503 unavailable`.

Then the gateway sends HolyWisp a reconstructed upgrade (the route's canonical path `/wisp/` or `/wisp/p/<id>/`, never
the query, `Host` = the upstream, the WebSocket
headers, exactly one `X-Forwarded-For: <client ip>`; never the client's cookies, credentials or forwarding headers),
relays HolyWisp's `101` head and splices the bytes. No idle timeout (connections may stay quiet for hours); a client
that stops reading for 60 s is disconnected; at server shutdown connections get 10 s; in `accounts` mode an open
connection whose user session was revoked or expired (sign-out, password change, account deletion) is closed within
30 s. The gateway never inspects or
logs stream destinations (the access log records `/wisp/` without the query).

## Static & SPA
- App-origin HTML (the shell, `/play-frame/<slug>`, error pages) → `Cross-Origin-Opener-Policy: same-origin` and a
  deny-list `Permissions-Policy` (camera, microphone, geolocation, payment, USB, serial, HID, MIDI, display
  capture, wake lock, idle detection, WebAuthn and other credentials, XR, local fonts, window management; fullscreen,
  autoplay, gamepad, clipboard-write and motion sensors are left to the game frames' `allow`). The shell's CSP has
  `frame-src blob: <proxy origin>` (`'self'` in single-origin mode, where the wrapper `/play-frame/` is also
  same-origin) and `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`: nothing frames the shell.
- Hashed assets under `/assets/` → `Cache-Control: public, max-age=31536000, immutable`.
- `/vendor/**` (third-party engine builds, unmodified) and other unhashed files → `Cache-Control: no-cache` + `ETag`.
- `/sw.js` → `no-cache`, `Service-Worker-Allowed: /`.
- Brotli/gzip variants (`file.br`, `file.gz`) are served when accepted (`Vary: Accept-Encoding`).
- App origin: any other GET without a file match → `index.html` (client router) for extension-less paths (paths
  whose last segment has a dot → plain 404), **except** `/api/*`, `/admin/*`, `/wisp/*` (404 JSON, also when
  percent-encoded). With a proxy origin configured, `/engine/**`, `/sw.js`, `/vendor/**`, `/wisp/*` and the engine
  prefixes are plain 404 here. In single-origin mode the app origin also serves everything listed for the proxy origin
  below (the engine prefixes get the `503` page, `/engine/` the engine host).
- No built frontend (no `index.html` in `GNOME_STATIC_DIR`): SPA paths answer `503` with a page explaining how to build
  it; the API keeps working.
- Proxy origin: `/engine/` → `engine/index.html` of the build (extension-less paths below `/engine/` too; files under
  `/engine/` as they are; `503` page when the build has no engine host); `/sw.js` (`no-cache`,
  `Service-Worker-Allowed: /`); `/vendor/**`; `/assets/*`; engine prefixes `/~/sj/*` and `/uv/service/*` (kept in one
  constant) that reach the server (the SW was not in control) → a small compiled-in `503` HTML page (`Retry-After: 2`,
  `no-store`) that re-registers `/sw.js` and reloads with a capped backoff (at most 5 tries per URL in 2 minutes) —
  never the SPA; everything else → 404. No response carries `X-Frame-Options`, and no query parameter changes any
  header of these static answers (on the proxy origin a query changes no policy anywhere; only the filter lists'
  `?v=` cache rule and the Wisp ticket read one). `%GNOME_APP_ORIGINS%` in the HTML files under `/engine/` is replaced, when the server indexes them, with the
  app origins allowed to frame the engine host (space-separated, HTML-attribute-escaped; single-origin mode:
  `GNOME_PUBLIC_ORIGINS`, or without it the origin of each request); their `.br`/`.gz` siblings are not served.
- Proxy origin, open-source games: `GET`/`HEAD /oss/<slug>/<path>` from `<GNOME_OSS_GAMES_DIR>/<slug>/` (two-origin mode
  only; a plain 404 on the app origin). Only reviewed, enabled builds; paths with `.`/`..`/dot segments, backslashes,
  NUL, symbolic links or directories answer 404. The manifest's `entry` file is the only HTML served, and only when
  the request says `Sec-Fetch-Dest: iframe` (or `frame`): a top-level load answers 404. Other `.html`/`.htm`/`.xhtml`/
  `.xht`/`.xml` files answer 404. Policies: the entry gets `default-src 'self' data: blob: 'unsafe-inline'
  'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'; frame-ancestors <app origins>` (+
  `; sandbox allow-scripts[ allow-pointer-lock]` for `isolated` entries), scripts the proxy script policy, everything
  else the inert policy; `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: public, max-age=3600`, an `ETag`
  (strong from the build's file index), `Accept-Ranges: none`.
  Content-Security-Policy of the proxy origin (exact strings: `frontend/src/shared/proxy-origin.ts`):
  - engine-host documents: `engineHostCsp(<app origins>)` = `frame-ancestors <app origins>; default-src 'self' data:
    blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'` (single-origin
    mode: `frame-ancestors 'self'`), and the operator's `GNOME_PROXY_CSP` as a second `Content-Security-Policy` header
    (it can only restrict: the server refuses at startup a value with `frame-ancestors`, `report-uri`, `report-to`, a
    `,`, anything but printable ASCII, a bad directive name, no directive at all or more than 4096 characters);
    `nosniff`, `Referrer-Policy: no-referrer`, `no-cache`;
  - `/vendor/bare-mux/worker.js`: `bareMuxWorkerCsp()` = `connect-src 'self'`, plus `bareMuxWorkerScriptCsp(<app
    origins>)` (the script policy) as a second header (`connect-src` alone would leave the worker free to load scripts,
    images and frames from any host);
  - other scripts (`/sw.js`, `/assets/*.js`, `/vendor/**/*.js`, `/engine/*.js`): `proxyScriptCsp(<app origins>)` =
    `PROXIED_DOCUMENT_CSP; frame-ancestors 'self' <app origins>`;
  - everything else (JSON answers and errors, 404s, `/api/health`, `/api/filters*`, styles, fonts, wasm, text, other
    HTML): `proxyInertCsp(<app origins>)` = `default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors
    'self' <app origins>`;
  - the engine-prefix `503` page: `default-src 'none'; script-src <its hash>; worker-src <proxy origin>/sw.js
    ('self' in single-origin mode); style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors
    'self' <app origins>`; the "engine host not built" page: `default-src 'none'` plus inline styles.
  - hyper's own answers to request heads it cannot parse (`414` request target of 64 KiB or more, `431` head over the
    read buffer, `400` malformed; every role and listener): `default-src 'none'; form-action 'none'; base-uri 'none';
    frame-ancestors 'none'`, `nosniff`, `no-store`, empty body.
  With `GNOME_ALLOW_CUSTOM_WISP=true` the engine-host policy and both policies of the bare-mux worker have
  `connect-src … ws: wss:` (a response's policies are all enforced, so the worker's second one carries the opt-in
  too); nothing else changes. In single-origin mode the engine-host documents, `/sw.js` and the scripts under
  `/engine/` and `/vendor/` (the bare-mux worker with its two policies) get the same policies; every other answer keeps
  the app's headers, the non-script files under `/vendor/` (wasm, source maps, license texts) included: they get
  `frame-ancestors 'self'` only, not `proxyInertCsp`. Single-origin mode has no isolation (the app's own documents are
  on the same origin), so no proxy-origin guarantee holds there.
- `GNOME_STATIC_RELOAD=true` (development only): the index is rebuilt when a request misses under `/assets/`,
  `/engine/`, `/sw.js` or `/vendor/` (at most once per second) and when the file of an unhashed path changed on disk;
  otherwise restart gnome-server after deploying a new frontend build.
- App-origin HTML gets the shell CSP; its `frame-src` lists only the engine host's origin (the proxy origin; `'self'`
  in single-origin mode) and `blob:`, because escaped proxied code can navigate the engine iframe to anything that list
  allows (ENGINE-PROTOCOL §1.1); `blob:` because Firefox checks the engine host's own blob downloads (a page's
  `<a download>`) against it as navigations of the engine iframe, and a `blob:` URL can only be the proxy origin's
  there. With a proxy origin its `connect-src` has no `ws:`/`wss:`. Game embeds are not on it (Wave C frames each game
  through its own wrapper document).

## Admin (separate listener, default `127.0.0.1:9091`; also requires `Authorization: Bearer $GNOME_ADMIN_TOKEN` when set)
Without a token the listener answers only requests whose `Host` is `localhost`/a loopback address (DNS-rebinding
defence); with a token, HTTP Basic with the token as password also works so a browser can open `/admin/`. Unsafe
methods need `X-GNOME-Request: 1`. Every request counts against the `admin` rate limit (60 / 120 per min per IP)
before the token is checked, so guesses cannot be hidden behind ignored `429`s.

| Endpoint | |
| --- | --- |
| `GET /admin/` | Minimal HTML diagnostics page (`?refresh=<s>`: reload every 2–3600 s); `GET /` and `GET /admin` redirect here (`303`) |
| `GET /admin/diagnostics` | `{"uptime_s","rss_bytes","http":{"requests","rate_limited","by_status","in_flight","connections_active","connections_total","rate_limited_by_class"},"ws":{"active","total","bytes_up","bytes_down","zero_copy","zero_copy_unavailable","relays":{"zero_copy","copy"},"clients","sessions","limits":{"per_ip","per_session"},"rejected":{"<reason>":n},"probes":{"valid","rejected","upstream_down"}},"fd_limit":{"soft","hard","open","startup":{"before_soft","before_hard","soft","hard","raised","error"}|null},"db":{"size_bytes","users","user_sessions","schema_versions"},"catalog":{"games","by_source","last_import"},"filters":[{"id","source_kind","category","default_enabled","available","size","size_br","size_gzip","sha256","version","expires_s","updated_at","fetched_at","next_check_at","source","failures","last_error","last_error_at"}],"upstreams":[{"id","addr","status","latency_ms","checked_at","error"}],"proxy":{"isolated","mode","origin","app_origins","listener","explanation"},"jobs":[{"name","every_s","runs","failures","running","last_started_at","last_duration_ms","last_error"}],"rate_limiter":{"enabled","scale","buckets","login_backoff_entries"},"static":{"available","files","bytes","bytes_in_memory","precompressed","has_index_html"},"modules":[...],"config":{...},"build":{"version","target","profile"}}` — keys of modules that are not running are present with zero/empty values; `fd_limit` is `RLIMIT_NOFILE` now (`null` = unlimited) and what startup did (`startup` is `null` when the server was not started by `gnome-server serve`); `ws.probes.upstream_down` counts the probes answered `503 wisp_upstream_unavailable`; `config` is the effective configuration without secrets (`access_mode`, `registration`, `accounts`, `csp`, `hsts`, `public_origins`, `proxy_origin`, `proxy_bind`, `proxy_csp` (whether `GNOME_PROXY_CSP` is set), `allow_custom_wisp`, `static_reload`, `filters_refresh_hours`, `filter_lists_file`, `wisp_upstream`, `wisp_ticket_ttl_s`, `max_ws_per_ip`, `max_ws_per_session`, `vpn_profiles`, `trusted_proxies`, `admin_token` (whether one is set), `log_ips`); `filters[].source_kind` is `"file"` for lists read from a local file (GNOME_FILTER_LISTS_FILE `file =`) and `"url"` otherwise; for file lists `source` is `"file"` and `last_error` is one of file-missing, file-forbidden-path, file-not-regular, file-unreadable, file-too-large, file-timeout, file-not-utf8, file-no-header, file-not-a-list, file-not-resources. The jobs list also shows `filters.files` (every 600 s, first run at start) |
| `GET /admin/metrics` | Prometheus text format; among others `gnome_ws_probes_total{result="valid"\|"rejected"\|"upstream_down"}` (ticket probes by answer; `upstream_down` = the `503 wisp_upstream_unavailable` answers) and `gnome_wisp_upstream_up{id}` |
| `POST /admin/filters/refresh` | check every filter list upstream now (conditional GETs), in the background → `202 {"job":"filters.refresh","lists":n}`; results appear in `/admin/diagnostics` `filters` |
| `POST /admin/catalog/import` | `{"sources"?: string[], "limit"?: number}` (default: every enabled source; `limit` 1–100000 makes the run limited, never complete) → `202 {"job": "catalog.import", "sources": [ids]}` (runs in the background, one source after another; the frame policy is refreshed afterwards) · `409 conflict` "an import of <id> is already running" · `422 validation_failed` with `fields.sources` ("unknown source x", "x is not enabled") or `fields.limit` |
| `GET /admin/catalog/imports?source=&limit=` | `limit` 1–500 (default 50) → `200 {"runs": ImportRun[]}` (newest first) |
| `POST /admin/catalog/oss-fetch` | `{"slugs"?: string[]}` (default: every enabled entry whose build is missing or at another commit) → `202 {"job": "catalog.oss-fetch", "slugs": [...]}` · `409 conflict` while one runs · `422` `fields.slugs` ("unknown entry", "not enabled", "not pinned to a commit", "a local build") |
| `POST /admin/games/:id/feature` | `{"featured": bool}` → `204` · `404 not_found` |
| `POST /admin/games/:id/status` | `{"status": "active"\|"hidden"\|"broken"\|null}` (`active` also overrides an `ip_risk` match; `null` clears the override) → `204` · `404` · `422` `fields.status` |
