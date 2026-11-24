# gnome-server

The GNOME backend: one Rust binary (Axum/Tokio/Hyper, SQLite via rusqlite) that serves the built SPA and the engine
host on two origins, the `/api/*` REST API (sessions, accounts, sync, Wisp tickets, VPN locations and exit checks,
content-blocking filter lists, the game catalog), the game wrapper `/play-frame/<slug>` and the open-source games
under `/oss/<slug>/` on the proxy origin, the `/wisp/`
gateway to HolyWisp (zero-copy `splice(2)` relay), a separate admin listener, background jobs and the operator CLI.
Contracts live in `docs/API.md` (HTTP) and `docs/ARCHITECTURE.md` §4 (process model, configuration, security, Wisp
gateway, data model, origins) and §7 (VPN gateway profiles).

Pure-Rust dependencies only (no OpenSSL; SQLite is compiled in with FTS5), sized for a Raspberry Pi 4.

Since Wave C the games module (`src/games/`, the `gnome-catalog` crate wired in) and the VPN exit check
(`src/vpn/exit.rs`) are part of every build.

## Build, run, test

```sh
cargo build -p gnome-server --release           # target/release/gnome-server
gnome-server config check                        # validate + print the effective configuration (secrets redacted)
gnome-server migrate                             # create/upgrade $GNOME_DATA_DIR/gnome.db
gnome-server                                     # = serve; public :8080, admin 127.0.0.1:9091

# development against a scratch data dir and the built frontend
GNOME_DATA_DIR=/tmp/gnome-dev GNOME_BIND=127.0.0.1:8080 GNOME_STATIC_DIR=frontend/dist cargo run -p gnome-server

cargo test -p gnome-server                       # unit + integration tests (temp dirs, no network)
# real end-to-end through HolyWisp (needs network): example.org over HTTP, example.com over TLS, client-IP checks
HOLYWISP_BIN=services/holywisp/build/x86_64/holywisp cargo test -p gnome-server --test holywisp_e2e -- --ignored --nocapture
cargo clippy --all-targets -- -D warnings
cargo fmt -p gnome-server                        # style: backend/rustfmt.toml (120 columns)
```

The real HolyWisp test also reads `HOLYWISP_CONF`, `HOLYWISP_PORT`, `GNOME_SERVER_BIN` (e.g. the release binary) and
`GNOME_E2E_PORT_BASE` (header of `tests/holywisp_e2e.rs`).

The Vite dev server proxies only `/api` (the app origin) to `GNOME_DEV_BACKEND` (default `http://127.0.0.1:8080`); the
proxy origin (engine host, `/wisp/`) is served by gnome-server itself, e.g. on `GNOME_PROXY_BIND=127.0.0.1:8081`, and
the app learns it from `GET /api/config`.

## CLI

| Command | What it does |
| --- | --- |
| `gnome-server [serve]` | Run the server until SIGINT/SIGTERM (a second SIGINT or SIGTERM exits immediately) |
| `gnome-server migrate` | Apply pending migrations and print the schema versions |
| `gnome-server user create <name> [--admin] [--password-stdin]` | Create an account. The password is prompted twice on a TTY, or read from the first line of stdin |
| `gnome-server user reset-password <name> [--password-stdin]` | Set a new password and revoke every session of that user |
| `gnome-server filters refresh [<id>...]` | Check every filter list (or the named ones) upstream now, store what changed, print one line per list; exit `1` if any failed. Works while a server runs on the same data dir |
| `gnome-server filters status` | Print the stored filter lists (size, compressed sizes, version, last error) |
| `gnome-server config check` | Validate the configuration and print every setting with its source (`default`/`file`/`env`); never creates files |
| `gnome-server catalog import [--source S]… [--limit N] [--replay <index.json>]` | Import game feeds now (default: every enabled source); one JSON report per run; exit `1` when a run failed or was busy, `2` for an unknown or disabled source or a bad replay index. `--replay` answers the importers from captured responses and never contacts a host (development and tests). Needs the server's binds (the `oss` source needs a proxy origin) |
| `gnome-server catalog stats` | Print the catalog statistics (`CatalogStats`) as JSON |
| `gnome-server catalog fetch-oss [--slug S]…` | Download the pinned builds of the enabled open-source games (default: every entry whose build is missing or at another commit) from `codeload.github.com`; one JSON line per entry; exit `1` if one failed |
| `gnome-server version` | Version and target |

Exit codes: `0` success, `1` runtime failure, `2` configuration or usage error.

## Configuration

Environment variables, optionally layered over a TOML file named by `GNOME_CONFIG` (keys are the variable names
without `GNOME_`, lowercased; arrays allowed for lists; unknown keys are rejected). Environment wins. All problems
are reported at once. The authoritative table is `docs/ARCHITECTURE.md` §4.2; `src/config.rs` (`VARS`) is the
implementation.

| Variable | Default | |
| --- | --- | --- |
| `GNOME_BIND` | `0.0.0.0:8080` | public listener (role per request `Host`, see [Origins](#origins-and-roles)) |
| `GNOME_ADMIN_BIND` | `127.0.0.1:9091` | admin listener; empty disables; non-loopback only with `GNOME_ADMIN_ALLOW_REMOTE=true` + token |
| `GNOME_ADMIN_TOKEN` | – | bearer token (≥ 16 chars); without it only loopback `Host` names are answered |
| `GNOME_ADMIN_ALLOW_REMOTE` | `false` | see above |
| `GNOME_DATA_DIR` | `./data` | `gnome.db` (+ WAL), `secret.key`; created 0700 |
| `GNOME_STATIC_DIR` | `./frontend/dist` | built SPA, indexed at startup (restart after deploying a new build) |
| `GNOME_STATIC_RELOAD` | `false` | development only: re-index after a rebuild (on a miss under `/assets/`, `/engine/`, `/sw.js`, `/vendor/`, at most once per second, and when the file of an unhashed path changed) |
| `GNOME_PUBLIC_ORIGINS` | – | the app origin(s): allowed `Origin`s for state-changing requests (empty = same-origin against `Host`) and the engine host's `frame-ancestors`; must never contain the proxy origin |
| `GNOME_PROXY_ORIGIN` | – | origin of the proxy role (engine host, `/wisp/`), e.g. `https://p.gnome.example.com`; needs `GNOME_PUBLIC_ORIGINS` unless `GNOME_BIND` is loopback |
| `GNOME_PROXY_BIND` | – | optional second listener that always has the proxy role; loopback without `GNOME_PROXY_ORIGIN` ⇒ origin `http://<bind>` |
| `GNOME_PROXY_CSP` | – | a second CSP for engine-host documents, sent as its own header (can only restrict; one policy, `;`-separated, no `frame-ancestors`, no `report-uri`/`report-to`); see [Origins](#origins-and-roles) |
| `GNOME_ALLOW_CUSTOM_WISP` | `false` | users may use their own Wisp servers: adds `ws: wss:` to the engine-host and bare-mux worker policies, `/api/config` → `wisp.custom_servers` |
| `GNOME_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | peers whose `X-Forwarded-For/-Proto/-Host` and `X-Request-Id` are honoured |
| `GNOME_ACCESS_MODE` / `GNOME_ACCESS_CODE` | `open` / – | `open` · `code` · `accounts` |
| `GNOME_ACCOUNTS` / `GNOME_REGISTRATION` | `true` / `open` | accounts + sync; self-service registration |
| `GNOME_SECRET_KEY` | generated | base64, ≥ 32 bytes; else `$GNOME_DATA_DIR/secret.key` (0600, created atomically) |
| `GNOME_COOKIE_SECURE` | `auto` | `auto` (HTTPS, or a plain-HTTP loopback app origin) · `true` · `false`; secure cookies use `__Host-` names |
| `GNOME_SOURCE_URL` | – | AGPL §13 source link (in `/api/config`) |
| `GNOME_ENGINES` / `GNOME_ENGINE_DEFAULT` | `scramjet,ultraviolet` / `scramjet` | reported to the SPA |
| `GNOME_WISP_UPSTREAM` | `127.0.0.1:6001` | the direct HolyWisp (internal address only; `localhost` is refused) |
| `GNOME_WISP_TICKET_TTL_S` | `3600` | upper bound of a Wisp ticket's lifetime (60–604800; tickets also end with their session; checked only at the upgrade, so open connections outlive it) |
| `GNOME_MAX_WS_PER_IP` / `GNOME_MAX_WS_PER_SESSION` | `32` / `16` | concurrent Wisp connections per client IP (IPv6 /64) / per session |
| `GNOME_VPN_PROFILES` | – | path of the VPN gateway profiles TOML (`services/vpn/profiles.example.toml`) |
| `GNOME_VPN_CHECK_URL` / `GNOME_VPN_CHECK_URL_V6` | empty / empty | the operator's exit check service (HTTPS JSON with `ip`, `country`, `city`) and its IPv6-only name; **empty = no exit checks** (`verify_url: null`) |
| `GNOME_VPN_CHECK_INTERVAL_MIN` | `15` | minutes between server-side checks of each location (± 20 %; 0–1440; `0` = on request only) |
| `GNOME_VPN_EGRESS_SHARED_OK` | `false` | the operator states the egress's terms allow every person who can use this instance (silences the D16 warning) |
| `GNOME_CATALOG_SOURCES` / `GNOME_CATALOG_REFRESH_HOURS` | `gamepix,oss` / `24` | enabled game sources (`none` = no catalog); hours between imports of each source (`0` = on request; first tick 30 s after start) |
| `GNOME_GAMEPIX_SID` | `1` | GamePix publisher SID (`1` = the public default) |
| `GNOME_GD_PUBLISHER_ID` / `GNOME_PLAYGAMA_CLID` / `GNOME_FAMOBI_AFFILIATE_ID` / `GNOME_GAMEMONETIZE_ENABLED` | – / – / – / `false` | each network's ID (or opt-in); required to enable that source |
| `GNOME_ITCHIO_FEEDS` / `GNOME_ITCHIO_MAX_PAGES` / `GNOME_JS13K_FIRST_YEAR` | `games/free/platform-web` / `3` / `2012` | link-out sources |
| `GNOME_OSS_MANIFEST` / `GNOME_OSS_GAMES_DIR` / `GNOME_OSS_REQUIRE_BUILDS` | built-in / `$GNOME_DATA_DIR/oss-games` / `true` | the open-source games manifest, where builds live, list only built games |
| `GNOME_OSS_FETCH` / `GNOME_OSS_MAX_MB` | `auto` / `512` | fetch missing OSS builds in the background (`manual` = CLI only); disk cap for all builds (16–65536 MiB) |
| `GNOME_CATALOG_BLOCKLIST` / `GNOME_CATALOG_BLOCKLIST_FILE` / `GNOME_CATALOG_DEDUP_ORDER` / `GNOME_CATALOG_USER_AGENT` | – / – / built-in order / `GNOME-catalog/<version>` | trademark terms; preferred listing across sources; feed User-Agent |
| `GNOME_GAMES_EMBED_HOSTS` | – | developer hosts approved for game embeds (exact DNS names; catalog data never adds one) |
| `GNOME_ADS_TXT` | – | absolute path of the file served as `/ads.txt` (≤ 64 KiB) |
| `GNOME_THUMB_PROXY` / `GNOME_THUMB_CACHE_MB` | `true` / `256` | thumbnails through `/api/thumb/:id`; disk cap (`0` = validated pass-through, nothing stored) |
| `GNOME_FILTERS_REFRESH_HOURS` | `24` | re-check interval of filter lists without `! Expires` (lists with one follow it); clamped to 4 h–7 d; `0` = only `filters refresh` / admin refresh |
| `GNOME_FILTER_LISTS_FILE` | – | TOML overriding, disabling or adding filter lists (see [Filter lists](#filter-lists)) |
| `GNOME_RATE_LIMIT_SCALE` | `1.0` | multiplies every limit; `0` disables |
| `GNOME_ARGON2_MEMORY_KIB` | `19456` | Argon2id memory (t=2, p=1); old hashes are upgraded at the next login |
| `GNOME_WORKERS` / `GNOME_DB_READERS` | CPUs / `4` | Tokio workers (capped by CPUs); SQLite reader pool |
| `GNOME_LOG` / `GNOME_LOG_FORMAT` / `GNOME_LOG_IPS` | `info` / `pretty` / `false` | EnvFilter; `pretty` · `json`; client IPs in access logs |
| `GNOME_CSP` | `on` | shell CSP: `on` · `report-only` · `off` |
| `GNOME_HSTS` | `false` | HSTS on HTTPS responses |

65 variables in all (plus `GNOME_CONFIG`). `config check` and start-up warn when VPN profiles are offered in `open`
mode, in `accounts` mode with open registration, or (a reminder) in `code` mode, unless `GNOME_VPN_EGRESS_SHARED_OK`
is `true` (WAVE-C D16), and when the `oss` source is enabled without a proxy origin (it is then disabled).

`config check` also prints the origin setup (two-origin mode with the app and proxy origins and where each came from,
or a warning in single-origin mode), the Wisp upstream, the VPN profiles and the filter-list registry. It warns when
`GNOME_STATIC_DIR` has no `index.html`, and when it has one but lacks `engine/index.html`, `sw.js` or `vendor/` (a
UI-only or stale build: the browser cannot load proxied pages).

Adding a setting: a `VarSpec` in `VARS` (mark it `inactive(..)` until a module reads it), a `Config` field, parsing in
`Config::from_lookup` (+ cross-field rules there), and rows in ARCHITECTURE §4.2 and this file. Secrets use
`util::Secret` (`Debug` prints `<redacted>`, comparison is constant-time) and `secret(..)` specs (redacted in
`config check` and error messages).

## Module map

| Path | Responsibility |
| --- | --- |
| `main.rs`, `cli.rs` | Entry point; clap CLI (`serve`, `migrate`, `user`, `filters`, `config check`, `catalog`, `version`); runtime setup |
| `config.rs` | `Config` from env + TOML, validation, provenance, redaction |
| `state.rs` | `AppState` (cheap `Arc` handle): config, `Db`, secret key, password hasher, rate limiter, login backoff, metrics, static index, security policies, jobs, shutdown token + task tracker, module list, module state |
| `module.rs` | `Module` trait (with the start-up hook `prepare`, awaited before jobs start and listeners accept), `ModuleSetup`, `Ext<T>`, `builtin_modules` (`core`, `accounts`, `wisp`, `vpn`, `filters`, `games`) |
| `origins.rs` | `Role` (app / proxy / single-origin), `ProxySetup` (proxy origin, app origins, validation, warnings) |
| `server.rs` | Listeners (public, proxy, admin; hyper HTTP/1.1, upgrades enabled, header-read timeout), accept loops, graceful shutdown |
| `router.rs` | Per-role routers, `Host` dispatch on the public listener, admin router; middleware order; body limits; request timeout; panic → 500 JSON |
| `gateway/mod.rs` | The `wisp` module: `POST /api/wisp/ticket`, `/wisp/` + `/wisp/p/{id}/` upgrade checks, metrics, diagnostics |
| `gateway/ticket.rs` | Route-bound Wisp tickets `w2.<exp_s>.<iat_s>.<route>.<session_ref>.<mac>` (`route` = `d` or `p<base64url id>`; own key derivation, strict parsing, constant-time MAC check; `w1` refused). The gateway refuses a ticket on another route, one minted before the process started, and a default-route ticket older than the session's latest profile mint (`401 wisp_ticket_wrong_route` / `_stale` / `_superseded`) |
| `gateway/caps.rs` | Per-IP and per-session connection caps (RAII `CapGuard`) |
| `gateway/upstream.rs` | Upstream addresses (internal only), the reconstructed upgrade request, response-head parsing, the health probe |
| `gateway/relay.rs` | Byte relay: `splice(2)` through nonblocking pipes on Linux (via `rustix`), `copy_bidirectional` otherwise |
| `gateway/health.rs` | Upstream health state and the `wisp.health` job (every 60 s) |
| `vpn/mod.rs`, `vpn/profiles.rs` | The `vpn` module (`/api/vpn/locations` with `exit` behind the access gate, `POST /api/vpn/locations/{id}/check`, `wisp.profiles` in `/api/config`, the `vpn.exit-check` job); `GNOME_VPN_PROFILES` parsing |
| `vpn/exit.rs`, `vpn/wisp_client.rs` | `ExitChecker`: each location's exit checked through its own HolyWisp (a minimal Wisp v1 client, TLS by rustls with webpki roots, one HTTP/1.1 GET, `User-Agent: exit-check/1`, 15 s deadline, 16 KiB cap), results, the 60 s reuse, diagnostics and metrics |
| `games/mod.rs` | The `games` module: the `gnome-catalog` crate wired in (`prepare`, config hand-over), routes, jobs, CLI, admin, metrics, diagnostics |
| `games/routes.rs`, `games/thumbs.rs` | `/api/games*`, `POST /api/games/{slug}/play` (HMAC dedup), `/api/thumb/{id}` and its disk LRU cache (type + magic-byte checks, ≤ 2 MiB) |
| `games/frames.rs` | `FramePolicy` (which embed hosts may be framed, per game; the `pending` report) and the wrapper document `/play-frame/{slug}` with its per-game CSP |
| `games/oss.rs` | Open-source builds: the fetch of a pinned commit (tarball via `gnome-net`, safe extraction, atomic replace, file index) and `/oss/{slug}/**` on the proxy role (entry only to frame loads, per-file policies) |
| `games/jobs.rs`, `games/cli.rs`, `games/replay.rs`, `games/admin.rs`, `games/fetcher.rs`, `games/ads_txt.rs` | `catalog.import` / `catalog.rankings` / `catalog.policy` / `catalog.oss-fetch`; `gnome-server catalog …`; `--replay` captures; `/admin/catalog/*` and `/admin/games/*`; the feed fetcher over `gnome-net`; `/ads.txt` |
| `filters/mod.rs` | The `filters` module: `FilterService` (registry, in-memory index, startup check), `filters.refresh` job, `POST /admin/filters/refresh`, diagnostics, metrics |
| `filters/registry.rs` | Built-in list registry (research §5.2 defaults) and `GNOME_FILTER_LISTS_FILE` overrides (also `file` sources and their path checks) |
| `filters/refresh.rs` | Upstream checks: conditional GET via `gnome-net`, mirrors, `!#include` flattening, Ghostery resources revision check, SHA-256 change detection, `! Expires` schedule, backoff; file lists read without blocking (`read_list_file`) |
| `filters/store.rs` | `$GNOME_DATA_DIR/filters/` files (content-addressed versions, atomic writes, brotli/gzip precompression) and `kv` metadata |
| `filters/serve.rs` | `GET /api/filters`, `GET /api/filters/{id}` (ETag, `304`, encoding negotiation, `?v=` immutable caching) |
| `filters/text.rs` | Body checks (UTF-8, not HTML, has rules), `! Version:` / `! Expires:` parsing, include resolution |
| `observability.rs` | tracing setup; `observe` middleware (client info, `x-request-id`, metrics, access log) |
| `metrics.rs` | Lock-free HTTP counters and the Prometheus renderer |
| `jobs.rs` | Periodic job scheduler (`Job`, `JobRegistry`: status, manual trigger, cancellation) |
| `error.rs` | `ApiError` (API.md error shape) and the `ApiJson` / `OptionalJson` / `ApiQuery` extractors |
| `db/mod.rs`, `db/migrate.rs` | SQLite: WAL writer behind an async mutex + read-only pool, all on the blocking pool; migration runner |
| `security/client.rs` | Real client IP / scheme / host behind trusted proxies (`ClientInfo`) |
| `security/origin.rs`, `csrf.rs` | Origin normalization and policy; CSRF guard |
| `security/headers.rs`, `csp.rs` | Default security headers per role; **all CSP values** (shell policy, game-embed hosts, proxy-origin and engine-host policies, retry page) |
| `security/rate_limit.rs` | Sharded token buckets per IP (/64 for IPv6) and per session; `RateClass` table |
| `security/crypto.rs`, `secret_key.rs` | HMAC/SHA-256/random/base64 helpers; master key load/generation and subkey derivation |
| `auth/anon.rs` | Anonymous tokens `v1.<exp>.<rand>.<hmac>` (key bound to the access policy) |
| `auth/sessions.rs`, `users.rs` | User sessions (SHA-256 of a random token, sliding expiry, cap 50/user) and user rows |
| `auth/password.rs`, `backoff.rs` | Argon2id on the blocking pool behind a semaphore; credential rules; per-username backoff |
| `auth/cookies.rs`, `extract.rs` | Cookie names/attributes; `MaybeUser`, `RequireUser`, `MaybeAnon`, `proxy_session`, `CookieSink` |
| `api/mod.rs` | The built-in modules: `CoreApi` (health, config, session + maintenance jobs) and `Accounts` (auth + sync) |
| `api/meta.rs`, `session.rs`, `auth.rs` | `/api/health`, `/api/config`, `/api/session`, `/api/auth/*` |
| `api/sync/*` | `/api/sync/settings` (optimistic concurrency), `bookmarks` (LWW + tombstones), `history` (keyset paging, deletion propagation) |
| `api/validate.rs` | URL/UUID/title/timestamp validators and `FieldErrors` |
| `static_files.rs` | Static index (ETags, `.br`/`.gz` negotiation, cache policy, per-file CSP), per-role lookup (SPA, engine host, `/sw.js`, `/vendor/**`, `/assets/*`), reserved and engine prefixes |
| `admin/mod.rs`, `page.rs` | Admin guard, `/admin/` HTML page, `/admin/diagnostics`, `/admin/metrics` |
| `../database/migrations/0001_core.sql` | Core schema (embedded with `include_str!`) |
| `tests/` | Integration tests against the real routers (`tower::ServiceExt::oneshot`), real sockets (`server.rs`, `gateway.rs` with an in-process WebSocket echo upstream), the real binary (`cli.rs`); `roles.rs` (route tables per role), `wisp_tickets.rs`, `wisp_probe.rs` (ticket probe, URL forms), `fd_limit.rs` (real binary: `RLIMIT_NOFILE`, accept back-off), `filters.rs` (filter lists against an in-process upstream on an ephemeral 127.0.0.1 port, incl. a list replaced while readers hammer it and a replacement by a second process); `holywisp_e2e.rs` (ignored; real HolyWisp) |

## Request pipeline

Public listener: in two-origin mode a dispatcher first picks the router of the request's role from its `Host`
(`X-Forwarded-Host` only from trusted proxies); the proxy listener always uses the proxy-role router. Each role
router, outermost first: catch-panic (safety net for the middleware) → `observe` (resolve `ClientInfo`,
`x-request-id`, span, metrics, access log, `role=proxy`) → security headers (per role) → CSRF guard (non-GET/HEAD need `X-GNOME-Request: 1`
and an allowed `Origin` if one is sent) → API guard (`/api/*` only: baseline rate limit, `CookieSink` for refreshed
cookies, `Cache-Control: no-store`) → 30 s timeout for the response head → body limit (256 KiB; 2 MiB on sync batch
routes) → catch-panic → module routes, else the static fallback. The inner catch-panic turns a handler panic into
`500 internal` (details only in the log) that still gets the request id, security headers, metrics and an access-log
line.

Admin listener: catch-panic → `observe_admin` (request id, access log with `listener=admin`, no public metrics) →
admin guard (`admin` rate limit per IP, then token or loopback `Host`, CSRF, `X-Frame-Options: DENY`, strict CSP,
`no-store`) → timeout → body limit → catch-panic → admin routes. The admin router is never merged into the public
one (tested).

Connections: HTTP/1.1 with keep-alive; 20 s to send a request head (also bounds idle keep-alive); request heads over
roughly 128 KiB or with more than 100 header fields get `431` (64 KiB read buffer, which hyper may overshoot by one
read); a response write that makes no progress for 60 s (`WRITE_STALL_TIMEOUT`: the client stopped reading) closes
the connection; upgrades enabled. A request whose client disconnects first is logged and counted as status `499`.
Shutdown: stop accepting, gracefully close connections, cancel `state.shutdown`, wait up to 10 s for connections and
`state.tasks`, checkpoint the WAL.

## Origins and roles

ARCHITECTURE §4.6. A request has the **proxy** role when it arrived on the proxy listener (`GNOME_PROXY_BIND`) or its
host matches `GNOME_PROXY_ORIGIN` (default port ignored, case-insensitive); otherwise the **app** role. With neither
setting the server runs in **single-origin mode** (one origin, both roles), which `/api/config`
(`proxy.isolated: false`), `/admin/diagnostics` (`proxy`), `config check` and the startup log report.

| | app role (two-origin) | proxy role | single-origin |
| --- | --- | --- | --- |
| SPA (`/`, client routes, files) | yes | 404 | yes |
| `/api/*` | every module's `public_routes` + `shared_routes` | `shared_routes` (`GET /api/health` in its minimal form `{status, wisp: {direct}}`, filter lists) + `proxy_routes` | all |
| `/engine/` (`engine/index.html`; extension-less paths below it → it) | 404 | yes | yes |
| `/sw.js` (`no-cache`, `Service-Worker-Allowed: /`), `/vendor/**` | 404 | yes | yes |
| `/assets/*` (hashed, immutable) | yes | yes | yes |
| `/wisp/`, `/wisp/p/{id}/` | 404 | gateway | gateway |
| engine prefixes `/~/sj/`, `/uv/service/` (`static_files::ENGINE_PREFIXES`) | 404 | `503` retry page | `503` retry page |
| anything else | SPA rules | 404 | SPA rules |

The `503` retry page is compiled in (works without a static dir): it re-registers `/sw.js` (scope `/`) and reloads
with a capped backoff (0.25 s → 8 s, at most 5 tries per URL in 2 minutes).

Headers: the app role sends `X-Frame-Options: SAMEORIGIN` and the shell CSP, whose `frame-src` is only the proxy
origin (`'self'` in single-origin mode: escaped proxied code can navigate the engine iframe to anything it allows) and
`blob:` (Firefox checks the engine host's blob downloads against it), and whose `connect-src` drops `ws:`/`wss:` when
isolated. The proxy role never sends
`X-Frame-Options`, and none of its responses is a permissive realm (`csp::ProxyPolicies`; exact strings in
`frontend/src/shared/proxy-origin.ts`, compared by `csp.rs` tests with `tests/fixtures/proxy-origin-csp.json`, which
`tests/e2e/engine/suites/backend-proxy.mjs --write-fixture` regenerates from the TypeScript): engine-host documents get
`engineHostCsp(<app origins>)` (+ `nosniff`, `Referrer-Policy`) and `GNOME_PROXY_CSP` as a second policy (the
document's inline-script hashes are added to a `script-src` there without `'unsafe-inline'`); the bare-mux worker
`bareMuxWorkerCsp()` plus the script policy; other scripts `PROXIED_DOCUMENT_CSP` + `frame-ancestors 'self' <app
origins>`; everything else `default-src 'none'` (the security-headers middleware's default). `GNOME_ALLOW_CUSTOM_WISP`
adds `ws: wss:` to the engine host and to both of the worker's policies only (every policy of a response is enforced);
no query parameter changes a policy. `%GNOME_APP_ORIGINS%` in
the HTML under `/engine/` is filled when indexing (API.md "Static & SPA"). The answers hyper writes by itself for
request heads it cannot parse (`414`, `431`, `400`: they never reach the router, and Chromium commits them in a frame
as same-origin documents) are rewritten by `server::ConnIo` to carry `csp::NOTHING_RUNS_UNFRAMED` (`default-src
'none'; …; frame-ancestors 'none'`), `nosniff` and `no-store`; so is a panic caught outside the security-headers
middleware.

## Wisp gateway

ARCHITECTURE §4.4, API.md "Wisp". The app mints a ticket (`POST /api/wisp/ticket`, 30/min/session; open mode creates
the anonymous session if missing) and the engine host connects to `wss://<proxy origin>/wisp/?t=<ticket>&/` (or
`/wisp/p/<id>/?t=<ticket>&/` for a VPN profile; the `&/` keeps libcurl transports happy, which refuse a URL not ending
in `/`; `?t=<ticket>` and `?t=<ticket>/` are accepted too, exactly one trailing `/` is stripped, then the value is
percent-decoded). A plain `GET`/`HEAD` without `Upgrade` is the **ticket probe**: after the rate limit (it shares the
upgrade class) and the profile check it answers `401 wisp_ticket_missing|invalid|expired|revoked`, `503
wisp_upstream_unavailable` (`Retry-After: 10`) while the health job has the route's upstream down, or `426` for a
ticket an upgrade would accept; it needs no `Origin`, takes no slot, never contacts the upstream and changes nothing
(a `503` asks the health job for an early round, at most every 10 s).
Before anything is upgraded the gateway checks, cheapest first: 60 upgrades/min
per IP, the profile, a well-formed HTTP/1.1 `GET` WebSocket upgrade, `Origin` = the proxy origin exactly, the ticket (in
`accounts` mode also that its user session is still live, cached ≤ 15 s; it is re-checked every 15 s while the
connection is open, which ends when the session does), then takes a per-IP (32) and per-session (16) slot held by an
RAII guard for the connection's lifetime. Refusals are JSON 4xx; an unreachable or refusing
upstream is `502`.

The upstream (127.0.0.1, never `localhost`) receives a reconstructed request: the route's canonical path (`/wisp/` or
`/wisp/p/<id>/`, never the query or the ticket), `Host` = the
upstream, the WebSocket headers (`Upgrade`, `Connection`, `Sec-WebSocket-Key/-Version/-Protocol/-Extensions`, visible
ASCII only) and exactly one `X-Forwarded-For: <bare client ip>`; no client cookie, credential or forwarding header is
ever sent. HolyWisp's `101` head is relayed to the client, then the two sockets are spliced: the upgraded connection
is downcast to the raw `TcpStream` and each direction runs `splice(2)` socket → pipe → socket (bytes buffered at
upgrade time are written first); if the downcast fails, `splice` is unavailable (checked once at startup) or the
connection's two pipes cannot be created (out of file descriptors: splicing costs 6 per connection, copying 2) it
falls back to `copy_bidirectional`. EOF half-closes the other side; no idle timeout; a write towards the browser stalled for
60 s ends the connection; at shutdown connections get 10 s. `/admin/diagnostics` `ws` and `upstreams`, and
`/admin/metrics` `gnome_ws_*` / `gnome_wisp_upstream_*`, report connections, bytes, refusals by reason, ticket probes
and upstream health probes.

**File descriptors.** At startup (`gnome-server serve`) the `RLIMIT_NOFILE` soft limit is raised to the hard limit
(at most 1,048,576) and the before/after values are logged once; if that fails the server warns and keeps the
inherited limit, and below 4096 it warns how many Wisp connections fit (about soft ÷ 6). Raise the hard limit with
systemd `LimitNOFILE=`, `docker run --ulimit nofile=…` or `ulimit -Hn`. `/admin/diagnostics` `fd_limit` shows the
current soft/hard limits, the open count and the startup report; `/admin/metrics` has `process_open_fds` and
`process_max_fds`. When `accept()` fails (usually `EMFILE`) the listener pauses 100 ms per attempt instead of spinning,
warning at most every 10 s.

## Filter lists

ARCHITECTURE §5.5, API.md "Content-blocking filter lists", `docs/research/content-blocking.md` §5–§6.1. The server is a
cache: it mirrors list text and uBO's redirect resources so browsers download them from GNOME (once per change), and
the client builds the engine in a Worker.

- **Registry.** Built-in lists (`filters/registry.rs`), ids = uBO asset keys. On by default: `easylist`,
  `ublock-filters`, `ublock-badware`, `ublock-quick-fixes`, `ublock-unbreak`, `plowe-0`, `easyprivacy`,
  `ublock-privacy`, `adguard-spyware-url`, `ubo-resources`; off: `fanboy-cookiemonster`, `ublock-cookies`,
  `ublock-annoyances-others`. Sources are uBO's CDN (`ublockorigin.github.io/uAssetsCDN`, `!#include` already
  inlined) with `ublockorigin.pages.dev` and jsDelivr as mirrors (EasyList/EasyPrivacy also `easylist.to`); Peter
  Lowe's list comes from `pgl.yoyo.org`; `ubo-resources` from Ghostery's content-addressed CDN (`metadata.json` →
  newest revision → `<rev>/list.txt`, whose SHA-256 must equal the revision; the GitHub copy is the mirror). Never
  AdGuard Tracking Protection or CC BY-NC-SA lists. `GNOME_FILTER_LISTS_FILE` (TOML, validated by `config check`):

  ```toml
  [[list]]                 # override fields of a built-in list
  id = "easylist"
  url = "https://easylist.to/easylist/easylist.txt"
  mirrors = []

  [[list]]                 # stop offering one
  id = "plowe-0"
  disabled = true

  [[list]]                 # add one (id, name, category, url, license, homepage required)
  id = "my-extra"
  name = "My extra rules"
  category = "annoyances"  # ads | privacy | annoyances | cookies | urlparams | security
  url = "https://lists.example.org/extra.txt"
  license = "CC0-1.0"
  homepage = "https://lists.example.org/"
  default_enabled = false
  trusted = false          # may use the scriptlets that need trust (only lists you fully trust: see below)
  max_mb = 15              # 1-64

  [[list]]                 # a list read from a local file (file and url are exclusive; mirrors only with url)
  id = "my-local"
  name = "My local rules"
  category = "ads"
  file = "/etc/gnome/filters/local.txt"
  license = "CC0-1.0"      # homepage is optional for file lists (the listing then shows "")

  [[list]]                 # the built-in resources from a file (no network; its category stays `resources`)
  id = "ubo-resources"
  file = "/etc/gnome/filters/ubo-resources.json"
  ```

  URLs must be `https`; at most 64 lists and 4 mirrors each. Files of lists removed from the registry are deleted at
  the next start.
- **Trusted lists** (`trusted = true`; WAVE-B3 D11, §11.3). Only a trusted list may use the scriptlets that need
  trust: every `trusted-*` scriptlet and every scriptlet uBO's resources mark `requiresTrust` (by name and alias, such
  as `rpnt`/`replace-node-text`, which rewrites inline scripts, or `prevent-clipboard-write`); they set arbitrary
  cookies and storage, click elements and replace page text, so **a trusted list can run code in every page it
  names**. The browser drops those lines from every other list (and an untrusted scriptlet line whose arguments hold a
  backtick or `$`). Set `trusted = true` only for lists you fully trust; the built-in uBO lists (`ublock-*`) and
  `adguard-spyware-url` are trusted, EasyList, EasyPrivacy and Peter Lowe's list are not, and an added list is not
  unless you say so.
- **File lists** (`file = "/abs/path"`, WAVE-B3 D17). The path is checked at startup (`config check` too): absolute,
  at most 4,096 bytes, no `..` component, not under `/proc`, `/sys` or `/dev`; a file that does not exist yet is not
  a configuration error (the list stays unavailable, `config check` warns). Reading (`filters/refresh.rs`
  `read_list_file`): symbolic links are resolved and the result checked against `/proc`, `/sys` and `/dev` again, and
  on Linux so is the file that was opened (its `/proc/self/fd` link: a path swapped for a link between the checks and
  the open cannot lead the read there); only a regular file (checked before the open, and with `fstat` after an
  `O_NONBLOCK` open, so a FIFO or device named there cannot block the job), at most `max_mb`, within 10 s; then the
  checks of a download (UTF-8 text, not HTML, no NUL, at least one rule, and the first non-empty line `[Adblock …]`
  or a `!` comment; for `resources` Ghostery's JSON). `!#include` lines are not followed and `! Expires` schedules
  nothing. File lists are read by their own job,
  `filters.files`, as soon as the server serves and every 10 minutes (also with `GNOME_FILTERS_REFRESH_HOURS=0`:
  no upstream request is involved), and by every forced refresh (`gnome-server filters refresh`,
  `POST /admin/filters/refresh`); a new SHA-256 is stored as a new version like a download, the same bytes are
  `unchanged`, and a read error keeps the stored version. The error is recorded as a fixed word, never the path or
  OS text: `file-missing`, `file-forbidden-path`, `file-not-regular`, `file-unreadable`, `file-too-large`,
  `file-timeout`, `file-not-utf8`, `file-no-header`, `file-not-a-list`, `file-not-resources`; `source` is `file`, and
  `/admin/diagnostics` rows carry `source_kind: "file" | "url"`; `config check` prints each file list with what is at
  its path (a stat, never an open) and warns when the file is missing, not a regular file, larger than its `max_mb`,
  or reached through links that lead under `/proc`, `/sys` or `/dev`. The e2e runner serves its test lists this way
  (`tests/e2e/engine/lib/blocker.mjs`): gnome-server's fetcher refuses loopback hosts, so a local list server would
  not work.
- **Fetching** (`filters.refresh` job: every 10 min it looks for due lists; first look 10 s after start). A list is
  due when it is not stored yet or its `next_check_at` passed: `! Expires` of the stored copy (else
  `GNOME_FILTERS_REFRESH_HOURS`), clamped to 4 h–7 d, plus up to 5 % jitter (≤ 30 min). Requests go through
  `gnome-net`'s `SafeClient` (strict IP policy, https only, redirects re-checked, `User-Agent: GNOME/<version>
  (+GNOME_SOURCE_URL)`), 120 s per request, body limit 15 MiB per list (`max_mb`), 3 lists at a time. Conditional
  GET (`If-None-Match` / `If-Modified-Since`) against the URL the stored copy came from; a `200` is still compared by
  SHA-256 (GitHub Pages ETags change on every deploy). Sources are tried in order (primary, then mirrors); bodies
  that are not UTF-8, look like HTML (captive portals, challenge pages, SPA fallbacks) or contain no rules are
  refused. `!#include` lines are inlined (same origin and directory only, ≤ 3 deep, ≤ 32 files, within the size
  limit; such lists are always fetched unconditionally). A failed check keeps the stored copy and retries after
  15 min doubling to 6 h (5 min doubling to 1 h while nothing is stored). `GNOME_FILTERS_REFRESH_HOURS=0` disables
  automatic fetching (file lists are still re-read). `POST /admin/filters/refresh` and `gnome-server filters refresh` check every list now.
- **Storage.** Content-addressed: `$GNOME_DATA_DIR/filters/<id>.<sha256>.txt` (`.json` for resources) plus `.br`
  (quality 10, 4 MiB window) and `.gz` (level 9), compressed once per change on the blocking pool (at most two at a
  time). A new version is written next to the current one (each file to a temporary file, fsynced, renamed), then
  the `kv` row `filters:<id>` names it, and only then is the previous version removed, so a file never changes under
  a name in use. At startup every stored list is hashed against its metadata: missing compressed variants are
  rebuilt, a missing or mismatching plain file makes the list unavailable and due; temporary files and files of other
  versions are removed once they are 10 minutes old (a younger one may be another process's write in progress). The
  server starts and serves without any list (offline: lists answer `503` until fetched).
- **Serving** (`shared_routes`: app and proxy origin, read-only, no session). Bodies stream from the file of the
  version the index names, so a body always matches its ETag (and a `?v=<sha256>` URL that version). A request whose
  version was just removed looks the list up again: this process's index after its own refresh, or the `kv` row when
  another process (`filters refresh` next to a running server) replaced it. `GET /api/filters` is rendered once per
  change.

## Extension points

**Modules** (`module.rs`). A feature implements `Module` and is added in `builtin_modules`. A module with shared
state is wired like this (simplified from `gateway/mod.rs`; `tests/modules.rs` and `tests/roles.rs` have complete,
compiled examples):

```rust
pub struct Gateway { shared: Arc<GatewayState> }

pub fn builtin_modules(setup: &mut ModuleSetup<'_>) -> Vec<Arc<dyn Module>> {
    let mut modules: Vec<Arc<dyn Module>> = vec![Arc::new(CoreApi)];
    // Publish state for handlers anywhere (`Ext<GatewayState>`, `state.ext::<GatewayState>()`).
    let shared = setup.provide(GatewayState::new(&setup.state.config, &setup.state.secret));
    modules.push(Arc::new(Gateway { shared }));
    modules
}

impl Module for Gateway {
    fn name(&self) -> &'static str { "wisp" }
    fn public_routes(&self, _: &AppState) -> Router<AppState> { /* Router::new().route("/api/wisp/ticket", post(mint)) */ }
    fn proxy_routes(&self, _: &AppState) -> Router<AppState> { /* Router::new().route("/wisp/", get(upgrade)) */ }
    fn jobs(&self, _: &AppState) -> Vec<Job> { /* upstream health probe */ }
    fn health(&self, _: &AppState, h: &mut Health) { /* h.wisp.insert("direct".into(), UpstreamStatus::Up) */ }
    fn diagnostics<'a>(&'a self, _: &'a AppState, out: &'a mut Diagnostics) -> BoxFuture<'a, ()> { /* "ws", "upstreams" */ }
}
```

Hooks (all optional): `public_routes` (app role), `proxy_routes` (proxy role), `shared_routes` (**both roles**: the
mount point for read-only, unauthenticated endpoints the engine host needs too, such as `GET /api/filters` and
`GET /api/filters/{id}`; never a route that reads a session, sets a cookie or changes state, since proxied pages can
reach the proxy origin), `admin_routes` (`/admin/*`, guarded for you), `jobs`, `public_config`
(feature flags, `wisp.profiles`, `proxy`), `health`, `diagnostics` (overwrite the placeholder keys `ws`, `catalog`,
`filters`, `upstreams`, `proxy`), `metrics` (Prometheus text). `tests/modules.rs` exercises every hook.
`AppState::open_with(config, |setup| ...)` builds a server with a custom module list (tests, embedding).

**Module state.** `ModuleSetup::provide(value)` publishes one value per type; read it with `state.ext::<T>()` or the
`Ext<T>` extractor (a missing value is a wiring bug → `500`). Modules never need a new `AppState` field.

**Routing rules.** API routes live under `/api/`. Other prefixes must be added to `static_files::RESERVED_PREFIXES`
(`/api`, `/admin`, `/wisp` are) so the SPA fallback never shadows them. Engine prefixes (`/~/sj/`, `/uv/service/`)
are listed once in `static_files::ENGINE_PREFIXES`: they get a self-retrying `503` page (`engine_unavailable`, its
inline script allowed by hash), are never answered with the SPA, and appear in access logs as the bare prefix.
Which role serves a route is decided by the hook it comes from (see [Origins](#origins-and-roles));
`SecurityHeaders::apply` only fills headers a handler did not set.

**Jobs.** `Job::new(name, every, |state| async { ... })`, optional `.first_run_after(d)`. Runs never overlap, failures
are recorded in `/admin/diagnostics` and `gnome_job_failures_total`, `state.jobs.trigger(name)` runs one now (admin
"refresh" endpoints), and loops stop on shutdown. Each run is its own task: a run that panics is recorded as a
failure (`last_error: "panicked: …"`) and the job keeps its schedule. Long work should also watch `state.shutdown`;
long-lived tasks (WebSocket splices) should be spawned on `state.tasks` so shutdown waits for them (10 s grace).

**Rate limits.** Add a `RateClass` (with its `limits()` row and the API.md table row) and call
`rate_limit::enforce(&state, class, client.ip, Some(session_key))` in the handler. `WispTicket` (per session) and
`WispUpgrade` (per IP) are enforced by the gateway; `Admin` guards the admin listener.

**Sessions for the proxy.** `auth::proxy_session(&state, &headers, &client)` applies the access-mode rule (signed-in
user in `accounts` mode, valid `gnome_sid` otherwise) and returns a `ProxySession` whose `key()` is the stable
per-session key for caps and limits (a ticket's `session_ref` can be derived from it). It only reads: the sliding
expiry moves on `/api/` requests, where the cookie is re-issued with it.

**Client identity.** Handlers take `ClientInfo` (an extractor) for the real IP, HTTPS flag and host; cookies must be
read with `auth::extract::cookies_secure` + `cookies::SessionCookie::name` so `__Host-` names are respected.

**Upgrades.** Connections are `hyper_util::rt::TokioIo<server::ConnIo>` (`ConnIo` = the `tokio::net::TcpStream` plus
the write-stall timeout), so an upgrade handler recovers the raw socket with `hyper::upgrade::on(req)` +
`Upgraded::downcast::<TokioIo<ConnIo>>()` and `parts.io.into_inner().into_inner()` (e.g. for `splice(2)`; keep the
`ConnIo` instead to keep the stall timeout on a copy loop). The whole public middleware stack passes upgrades
through (`tests/server.rs` checks this over a real socket).

**Database.** `state.db.read(|conn| ...)` (read-only pool) and `state.db.write(|conn| ...)` (single writer; start a
`TransactionBehavior::Immediate` transaction for multi-statement work) run on the blocking pool; prefer
`prepare_cached`. Migrations: core `database/migrations/NNNN_*.sql` registered in `db::migrate::CORE_MIGRATIONS`
(versions 1–99); the catalog crate's `gnome_catalog::MIGRATIONS` (100–199). Each applies once, in version order, in
its own transaction, with a checksum in `schema_migrations`; a database with unknown (newer) versions is refused.
`kv` is a small per-module key/value table (keys `"<module>:<key>"`).

## Security notes

- **Sessions.** Anonymous: stateless HMAC token, 30 days, refreshable; its key depends on the access mode and code, so
  rotating the code revokes them. User: random 32 bytes in the cookie, SHA-256 in `user_sessions`, 30-day sliding
  expiry (written at most hourly, cookie re-issued), revoked on logout, password change (other sessions), reset and
  account deletion; at most 50 per user.
- **Cookies.** `HttpOnly; SameSite=Strict; Path=/`; when Secure the names are `__Host-gnome_sid` /
  `__Host-gnome_auth` and only those are read, so no other host of the site can plant a session. If a browser sends
  several values for one name, each is tried and the first valid one wins.
- **Passwords.** Argon2id, at most `CPUs/2` (1–4) hashes at once; unknown usernames cost a dummy verification;
  backoff after 5 failures per username (30 s doubling to 15 min), on top of 10/min/IP. An attempt is counted when it
  starts and taken back only when the password checks out, so a burst of concurrent guesses gets exactly the five
  free attempts (tested).
- **CSRF / origins.** `X-GNOME-Request: 1` on unsafe methods, `Origin` checked against `GNOME_PUBLIC_ORIGINS` or the
  host and scheme the client used; no CORS; `OPTIONS` is refused.
- **Headers.** `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, CSP (shell policy for HTML,
  `frame-ancestors 'self'` elsewhere), optional HSTS on HTTPS.
- **Client IP.** Socket peer, or for trusted proxies the right-most untrusted `X-Forwarded-For` hop; garbage hops never
  pick the address. Logs omit IPs and query strings by default.
- **Admin.** Separate listener, loopback by default, token required for remote binds, loopback `Host` check without a
  token (DNS rebinding), 60 / 120 requests per minute per IP checked before the token (no fast token guessing).
- **Access code.** Attempts are limited per IP (20/min); `config check` and startup warn when the code is shorter than
  8 characters.
- **Slow clients.** Header-read timeout (20 s), handler timeout (30 s, also bounds slow request bodies), write-stall
  timeout (60 s). Production deployments should still sit behind a reverse proxy, which also caps connections.
- **Two origins.** Proxied pages run on the proxy origin, which serves no session, account or sync endpoint and never
  the SPA, so a page that escapes the engines cannot read GNOME's storage or call its authenticated API. Wisp access
  there is by ticket: HMAC-SHA256 under a key derived from the secret key with its own label (`wisp-ticket/<policy>`,
  never the session-token key), bound to the access policy like anonymous sessions, carrying a non-reversible 16-byte
  `session_ref` (a digest of the anonymous token's random part, or a prefix of the user session's SHA-256 token hash)
  so per-session caps apply across tickets. User-session tickets stop working within 15 s of logout/revocation, and
  that session's open Wisp connections are closed within 30 s.
- **Single-origin mode.** Proxied pages share the app origin; `/api/config` (`proxy.isolated: false`),
  `/admin/diagnostics` (`proxy`) and `config check` say so.

## Data and sync

Tables (`0001_core.sql`, all `STRICT`, timestamps in Unix ms): `users` (NOCASE-unique usernames, `sync_clock`,
`history_cleared_before`), `user_sessions`, `user_settings`, `bookmarks` (+ a partial index over tombstones),
`history`, `kv`, `schema_migrations`. Every query path is index-backed (checked with `EXPLAIN QUERY PLAN`); history
pages seek straight to the keyset cursor.
Pragmas: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, 5 s busy timeout, 8 MiB page cache (4 MiB per reader),
32 MiB mmap, WAL file truncated to ≤ 64 MiB after checkpoints (`journal_size_limit`).

Sync is local-first (the server mirrors). Every write batch takes `synced_at = max(now, users.sync_clock + 1)` and
advances the clock; pulls return the clock itself as `server_time` (never the client's `since`, so a cursor from the
future is corrected), so cursors never skip data after deletions or a wall clock stepping back. Settings use optimistic
concurrency on `updated_at` (`409` carries the server copy; a document must load as a JSON value, i.e. ≤ 128 levels of
nesting, or it is refused with `422`). Bookmarks are last-writer-wins on the client's `updated_at`; an uploaded item
that loses re-announces the stored winner (it gets the batch's `synced_at`), so the device that sent the loser converges
on its next pull. Tombstones are kept 180 days and at most 50 000 per account (oldest dropped first); history
deletions propagate through `cleared_before`.

## Observability

- Logs to stderr: `GNOME_LOG` (EnvFilter), `GNOME_LOG_FORMAT=pretty|json`. Access lines (target
  `gnome_server::access`): `method`, `route` (matched route or path without query; engine URLs reduced to their
  prefix), `status` (`499` = the client disconnected before the response), `ms` (microsecond resolution), `ip` only
  with `GNOME_LOG_IPS=true`, `listener=admin` on the admin listener; every line inside a request carries its `id`.
- `x-request-id` on every response (accepted from trusted proxies when well-formed).
- `/admin/metrics`: `gnome_build_info`, `gnome_uptime_seconds`, `process_resident_memory_bytes`, `process_open_fds`, `process_max_fds`,
  `gnome_http_requests_total{status}`, `gnome_http_requests_in_flight`, `gnome_http_request_duration_seconds`
  (histogram), `gnome_http_connections_active`/`_total`, `gnome_rate_limited_total{class}`, `gnome_rate_limit_buckets`,
  `gnome_db_size_bytes`, `gnome_users`, `gnome_user_sessions`, `gnome_job_runs_total{job}`,
  `gnome_job_failures_total{job}`, `gnome_static_files`, plus module metrics: `gnome_ws_connections_active`/`_total`,
  `gnome_ws_relays_total{path}`, `gnome_ws_bytes_total{direction}`, `gnome_ws_rejected_total{reason}`,
  `gnome_ws_probes_total{result}` (`valid` · `rejected`),
  `gnome_wisp_upstream_up{id}`, `gnome_wisp_upstream_latency_seconds{id}`, `gnome_filter_list_available{id}`,
  `gnome_filter_list_bytes{id}`, `gnome_filter_list_age_seconds{id}`, `gnome_filter_list_failures{id}`,
  `gnome_filter_checks_total{result}` (`updated` · `unchanged` · `not_modified` · `failed`),
  `gnome_filter_downloaded_bytes_total`, `gnome_filter_served_total{status}`.
- Jobs: `sessions.cleanup` (hourly), `ratelimit.evict` (every minute: idle buckets and expired backoff records),
  `db.optimize` (6 h), `sync.purge_tombstones` (daily), `wisp.health` (every 60 s, and early after a failed upstream
  connection, at most every 10 s), `filters.refresh` (every 10 min: lists that are due, see
  [Filter lists](#filter-lists)).
