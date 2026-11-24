# GNOME Architecture

> Status: v0.3 (2026-11-10). Phase 1 research is in `docs/research/`; §4.6 (origins), §5.4 (engines), §5.5 (extensions),
> §6 (games) and §7 (VPN) were finalized from it. Details marked **(verify)** are re-checked by the end-to-end tests.
> Corrected 2026-11-18 by Wave B step 2's integration to what the five lanes built and measured (§1, §2, §3, §4.3,
> §4.6, §5.2, §5.4, §5.5, §5.6, §8, §9; the evidence per claim is in `docs/ENGINE-PROTOCOL.md`).

## 1. Overview

```
 Browser (user)                                                      Server (single host, e.g. Raspberry Pi 4)
 ┌───────────────────────────────────────────────────────┐          ┌────────────────────────────────────────────────┐
 │ App origin: GNOME SPA (Svelte 5)                      │          │ Caddy / Cloudflare (TLS termination, optional) │
 │  ├ shell: rail, routes, design system, settings       │  HTTPS   │        │                                       │
 │  ├ browser UI: tabs, omnibox, menus, engine client    │◀────────▶│ gnome-server (Rust, Axum/Tokio)                │
 │  ├ library: history, bookmarks, downloads (IndexedDB) │          │  app :8080 · proxy origin :8081 or a hostname  │
 │  ├ games: catalog UI, player (official embeds)        │          │  ├ static files (precompressed, ETag)          │
 │  └ vpn: page, gateway profiles (server-side egress)   │          │  ├ /api/* (sessions, auth, sync, games, ...)   │
 │    │ postMessage protocol (validated, one port)       │          │  ├ /engine/, /sw.js, /vendor/** (proxy origin) │
 │    ▼ cross-origin iframe                              │          │  ├ /wisp/ gateway: Origin+ticket check,        │
 │ Proxy origin: engine host /engine/                    │          │  │   byte-splice → HolyWisp                    │
 │  ├ EngineManager → Scramjet (primary) | UV (fallb.)   │          │  ├ background: filter lists, catalog, health   │
 │  ├ transports: Wisp client (libcurl/epoxy)            │──wss────▶│  └ admin listener 127.0.0.1:9091 (diagnostics) │
 │  ├ one iframe per tab (proxied pages)                 │ /wisp/   │ HolyWisp (C11) 127.0.0.1:6001  → Internet      │
 │  └ content blocking (Wave B step 3)                   │          │ HolyWisp 127.0.0.1:60xx → VPN gateway (opt.)   │
 │ Service worker /sw.js (proxy origin): routing,        │          │ SQLite (data dir)                              │
 │   CSP, download taps, blocking hooks                  │          │                                                │
 └───────────────────────────────────────────────────────┘          └────────────────────────────────────────────────┘
 GNOME is a website only: nothing is installed on the user's device.
```

Key property: with the libcurl/epoxy Wisp transports, **TLS to destination sites is negotiated inside the user's
browser**; the server only relays encrypted TCP streams. GNOME's server never sees page contents or full URLs of
HTTPS sites.

## 2. Components
| Component | Tech | Responsibility |
| --- | --- | --- |
| `frontend/` (app origin) | Svelte 5, TypeScript, Vite | SPA shell, browser UI and its engine client, library (history, bookmarks, downloads), pages, design system, settings |
| `frontend/` (proxy origin) | TypeScript, Vite; the pinned engines served unmodified | Engine host (`src/engine-host/`: engine manager, Scramjet and Ultraviolet adapters, transport manager, SW client, one iframe per tab), service worker (`src/sw/` → `/sw.js`), `/vendor/**` |
| `backend/` (`gnome-server`) | Rust, Axum, Tokio, Hyper, rusqlite | Static serving, REST API, sessions/auth, Wisp gateway, background jobs, admin listener, CLI subcommands |
| `crates/catalog` (`gnome-catalog`) | Rust lib | Game catalog schema, importers (streaming, page-by-page), search (FTS5), ranking |
| `crates/net` (`gnome-net`) | Rust lib | SSRF-safe outbound HTTP client (resolve → filter private ranges → connect to vetted IP), shared URL helpers |
| `services/holywisp/` | C11 (upstream HolyWisp, pinned) | Primary Wisp server; default-deny egress (blocks private/loopback/link-local/metadata) |
| `database/migrations/` | SQL | Embedded into the binary, applied on start |
| `deployment/` | Docker, compose, systemd, Caddy | Production deployment (amd64 + arm64) |
| `bench/` | Node baseline + scripts | Phase 7 benchmarks (Node/wisp-js baseline vs Rust/HolyWisp) |
| `tests/` | Playwright, Rust integration | End-to-end and integration tests |

## 3. Repository layout & ownership
```
gnome/
├── Cargo.toml              # workspace: backend, crates/* (Rust is used for the backend only)
├── backend/src/            # main.rs (CLI), config, state, db, error, security/, auth/, api/, gateway/,
│                           # static_files, filters/, games/, vpn/, admin/, metrics
│                           # games/: admin, ads_txt, cli, fetcher, frames (FramePolicy + /play-frame), jobs, oss
│                           # (fetch + /oss/**), replay (--replay), routes, thumbs (/api/thumb + disk cache)
│                           # vpn/: profiles, exit (ExitChecker), wisp_client (Wisp v1 + rustls for the check)
├── crates/catalog/src/     # config, store, import, query (search, listings), sources/{gamepix,gamedistribution,playgama,...}, categories, dedup, blocklist
├── crates/net/src/         # client (SafeClient), ip_policy, resolver, error
├── database/migrations/    # 0001_core.sql (core), 0100_catalog.sql (catalog crate; its 0101 index migration lives in crates/catalog/migrations/)
├── frontend/               # Wave B module plan and lane ownership: docs/WAVE-B.md
│   ├── index.html          # app entry (the shell; its inline boot script is hashed into the shell CSP)
│   ├── engine/index.html   # engine-host entry, served at <proxy origin>/engine/: vendor scripts in order, then the module
│   ├── public/             # logo.png (original), brand/ (both never modified), manifest.webmanifest,
│   │                       # engine/uv.config.js + engine/uv-doc-hook.js (plain scripts, served as they are)
│   ├── scripts/            # copy-vendor.mjs (pinned engine builds → dist/vendor/** with licenses), visual-qa.mjs,
│   │                       # qa-components.mjs, rust-crates.mjs; postbuild.mjs, bundle-report.mjs, third-party-notices.mjs (Wave D)
│   └── src/
│       ├── shared/         # the contract: engine-protocol.ts, site-rules.ts, transport.ts, proxy-origin.ts,
│       │                   # engine-hooks.ts, browser-data.ts (+ tests); pure, imported by app, engine host and SW
│       ├── app/            # App.svelte, router, Shell, Rail, routes.ts, shortcuts, status registry, view transitions
│       ├── components/     # design system (see docs/DESIGN.md §10)
│       ├── styles/         # tokens.css, base.css, fonts.css, utilities.css
│       ├── lib/            # api.ts, idb.ts, events.ts, keys.ts, url.ts (normalize/search), format.ts, platform.ts
│       ├── settings/       # schema.ts, defaults.ts, validate.ts, store.svelte.ts, apply.ts, sync.ts, account*.ts, clearers*.ts, features.ts
│       ├── browser/        # app side of the browser: bridge.ts, engine client (embed, handshake, validated events),
│       │                   # tabs, session restore, omnibox, context menu, find, zoom, permissions, downloads panel
│       ├── library/        # history, bookmarks and downloads stores + their sync adapters
│       ├── engine-host/    # proxy origin only: core (protocol server, tabs, engines, fallback, per-document observers),
│       │                   # transport/ (transport manager), sw-client/ (SW registration, updates, signals)
│       ├── sw/             # the service worker → dist/sw.js (classic script, scope /)
│       ├── extensions/     # Wave B step 3: content-blocking runtime behind src/shared/engine-hooks.ts:
│       │                   # core/ (policy, composite, sanitizer, selectors; pure), filters/ (lists, engines, cache,
│       │                   # network provider), worker/ (builder Worker), cosmetic/, cookies/, privacy/ (providers),
│       │                   # host/ (engine-host composition root, UV context), sw/ (SW half), app/ (listing, key,
│       │                   # exposure budget, shield, stats; app/ui/ the cookie manager and editors)
│       ├── pages/          # home/ browser/ games/ extensions/ vpn/ history/ bookmarks/ downloads/ settings/ about/
│       ├── games/          # api.ts, types.ts, catalog.svelte.ts, library.svelte.ts (favorites, recently played),
│       │                   # player.ts, networks.ts (D24 notice choices), channel.ts, copy.ts, feature.svelte.ts,
│       │                   # start.ts, summary.ts, components/ (GameShelf, GameTile, GameThumb, LicensePanel),
│       │                   # testing/fake-api.ts; pages/games/ GamesPage, GameDetailPage, PlayPage
│       └── vpn/            # api.ts, types.ts, state.svelte.ts (vpnState), wire.svelte.ts, start.ts, app-deps.ts,
│                           # copy.ts, testing/; pages/vpn/ VpnPage.svelte, browser-check.svelte.ts
├── services/holywisp/      # VERSION (pinned commit), fetch-build.sh, gnome.conf, holywisp.service
├── services/vpn/           # gateway examples (gluetun/wireproxy), profiles.example.toml
├── scripts/                # dev.sh, build.sh, release.sh, bench.sh, check.sh
├── deployment/             # Dockerfile, docker-compose.yml, systemd/, Caddyfile, .env.example
├── bench/  tests/  docs/
```

**Frontend build** (Wave B: `vite.config.ts`, `package.json` and `scripts/copy-vendor.mjs` belong to the build lane).
`npm run build` writes `frontend/dist/`, which gnome-server serves as `GNOME_STATIC_DIR` (API.md "Static & SPA"):
- `index.html` + `assets/*`: the app (Vite multi-page input `index.html`).
- `engine/index.html` + `assets/*`: the engine host (second input `engine/index.html`). Hashed chunks share one
  `/assets/` directory, served on both origins. The engine-host bundle imports only `src/engine-host/**`,
  `src/shared/**` and the pure `src/lib/keys.ts`; it never imports app code, and the app never imports engine-host code.
  The `shell` code-splitting group (`tags: ['$initial']`) must be `entriesAware`: otherwise rolldown puts the initial
  modules of both entries into one chunk that both pages load, which would run the app's and the engine host's
  `main.ts` together. A build test checks both import graphs from the Vite manifest (WAVE-B lane b).
- `sw.js`: the service worker, a separate classic (IIFE, unhashed, no ES-module syntax) build of `src/sw/` (a second
  `vite build` with a library config; `npm run build` runs the app/engine build, then the SW build, then the vendor
  copy); the only code it loads at runtime is `importScripts` of `/vendor/**` and `/engine/uv.config.js`
  (`SW_IMPORTS`).
- `engine/uv.config.js`, `engine/uv-doc-hook.js`: copied from `public/` unchanged.
- `vendor/<dir>/**`: `scripts/copy-vendor.mjs` copies the `dist/` of each pinned package byte for byte
  (`VENDOR_PACKAGES` in `src/shared/proxy-origin.ts`, versions in §5.4) with its LICENSE file (the AGPL-3.0 text for
  the packages whose tarball ships none) and the license files of what their bundles include (e.g. libcurl.js). Vendor
  files are never bundled, minified or obfuscated; a test compares the copies with `node_modules`.
- A build id (`__GNOME_BUILD__`, computed once per build and passed to both Vite builds), identical in the
  engine-host bundle and `sw.js` of one build, lets the engine host see whether the active service worker is current
  (ENGINE-PROTOCOL §2.5).

**Two-origin development.** `npm run dev` serves only the app (Vite with HMR; `/api` is proxied to
`GNOME_DEV_BACKEND`, default `http://127.0.0.1:8080`, §8). The engine host, `/sw.js` and `/vendor/**` always come from
gnome-server's proxy listener; `npm run dev:engine` rebuilds them into `dist/` on every change (a watch build of the
engine-host entry, the SW and the vendor copy that leaves `dist/index.html` alone). gnome-server indexes
`GNOME_STATIC_DIR` once at startup (`/engine/` answers "not built" when it started before the first build), so build
first, and either run it with `GNOME_STATIC_RELOAD=true` (development only, §4.2: it re-indexes when a request misses
under `/assets/`, `/engine/`, `/sw.js` or `/vendor/` or the build has no `index.html`, at most once per second, and
when the file of any unhashed path, such as `sw.js` or an HTML file, changed on disk; a failed scan keeps the old
index; e2e `backend-reload`, standalone: two successive `npm run dev:engine` builds served without a restart) or
restart it after each rebuild. A full local stack:

```sh
services/holywisp/build/x86_64/holywisp --config services/holywisp/gnome.conf     # 127.0.0.1:6001
(cd frontend && npm run build)        # gnome-server indexes dist/ when it starts
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 GNOME_STATIC_DIR=frontend/dist GNOME_STATIC_RELOAD=true \
GNOME_PUBLIC_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:8080 cargo run -p gnome-server
cd frontend && npm run dev:engine     # second terminal
cd frontend && npm run dev            # third terminal; open http://127.0.0.1:5173/
```

`/api/config` then names `http://127.0.0.1:8081` as the proxy origin (a loopback `GNOME_PROXY_BIND` without
`GNOME_PROXY_ORIGIN`); app and proxy origin are same-site, cross-origin secure contexts, like production's two
hostnames. Differences to keep in mind: the two ports share the host's cookie jar (cookies are host-scoped);
gnome-server's cookies are HttpOnly and its CSRF rules hold (spike §11.3 item 4), and on loopback app origins it uses
the `__Host-` names with `Secure` too (browsers accept them on `127.0.0.1` and `localhost`), but about 160 KB of
cookies planted by escaped code on the proxy port also reach the app port and make every app request too large
(PROGRESS "Deferred items": cookie flood across the origin boundary; in production a proxy hostname under the app's
domain can do the same with `Domain=`). Without HMR, `npm run build` and gnome-server alone serve both origins
from `dist/` (app `:8080`, proxy `:8081`).

## 4. Backend (`gnome-server`)

### 4.1 Process model
One multi-threaded Tokio runtime (`worker_threads` = CPUs, capped by `GNOME_WORKERS`). Two listeners: public
(`GNOME_BIND`, default `0.0.0.0:8080`) and admin (`GNOME_ADMIN_BIND`, default `127.0.0.1:9091`, empty = disabled).
SQLite opened in WAL mode with one writer connection (serialized through a `tokio::sync::Mutex` + `spawn_blocking`)
and a small read pool (`GNOME_DB_READERS`, default 4). Graceful shutdown on SIGINT/SIGTERM (drain HTTP; WebSocket
splices get a 10 s grace period).

CLI (`gnome-server <cmd>`): `serve` (default) · `migrate` · `filters refresh [<id>…]` · `filters status` ·
`user create <name> [--admin] [--password-stdin]` · `user reset-password <name> [--password-stdin]` · `config check`
(prints effective config with secrets redacted) · `version` · `catalog import [--source S]… [--limit N]
[--replay <index.json>]` (one JSON report per run; exit 1 when a run failed or was busy, 2 for an unknown or disabled
source or a bad replay index; `--replay` answers the importers from captured responses and never contacts a host:
development and tests only) · `catalog stats` · `catalog fetch-oss [--slug S]…` (one JSON line per entry; exit 1 if
one failed). The `catalog` commands run the modules' start-up hook first (`Module::prepare`, D21) and need the same
binds as the server (the `oss` source counts as disabled without a proxy origin).

### 4.2 Configuration (environment; optional `GNOME_CONFIG=/path/gnome.toml`, env wins)
| Variable | Default | Meaning |
| --- | --- | --- |
| `GNOME_BIND` | `0.0.0.0:8080` | Public listener |
| `GNOME_ADMIN_BIND` | `127.0.0.1:9091` | Admin listener (empty disables). Refuses non-loopback unless `GNOME_ADMIN_ALLOW_REMOTE=true` **and** `GNOME_ADMIN_TOKEN` set |
| `GNOME_ADMIN_TOKEN` | – | Bearer token for admin endpoints (≥ 16 chars, constant-time compare). Without it the admin listener answers only loopback `Host` names |
| `GNOME_ADMIN_ALLOW_REMOTE` | `false` | Allow a non-loopback `GNOME_ADMIN_BIND` (only together with `GNOME_ADMIN_TOKEN`) |
| `GNOME_DATA_DIR` | `./data` | SQLite DB, secret key, filter lists, thumbnail cache |
| `GNOME_STATIC_DIR` | `./frontend/dist` | Built SPA |
| `GNOME_STATIC_RELOAD` | `false` | **Development only.** Re-index `GNOME_STATIC_DIR` while serving: when a request misses under `/assets/`, `/engine/`, `/sw.js` or `/vendor/` (or the build has no `index.html`), at most once per second, and when the file of an unhashed path changed on disk (a `stat` per request), so `npm run dev:engine` works without restarting gnome-server (§3). A failed scan keeps the old index; startup prints a warning |
| `GNOME_PUBLIC_ORIGINS` | – | Comma-separated allowed origins of the **app** (e.g. `https://gnome.example.com`). Empty → same-origin check against `Host`. Also the `frame-ancestors` of the proxy origin; required with a proxy origin unless `GNOME_BIND` is loopback (then `http://<GNOME_BIND>` is assumed). Must never contain the proxy origin (startup error) |
| `GNOME_PROXY_ORIGIN` | – | Public origin of the isolated **proxy origin** (e.g. `https://p.gnome.example.com`; no path). Requests whose `Host` (`X-Forwarded-Host` from trusted proxies) matches it get the proxy-origin routes (§4.6) |
| `GNOME_PROXY_BIND` | – | Optional second listener that always serves the proxy-origin role (dev: `127.0.0.1:8081`; also for reverse proxies that map the proxy hostname to its own port). Requires `GNOME_PROXY_ORIGIN` unless it is loopback (then `http://<bind>` is assumed) |
| `GNOME_PROXY_CSP` | – | A second Content-Security-Policy for engine-host documents (`/engine/**` HTML), sent as its own `Content-Security-Policy` header next to the built-in engine-host policy (§4.6), so it can only restrict it further: one policy, `;`-separated, no `frame-ancestors`, no `report-uri`/`report-to` (GNOME's policies never send violation reports, which would carry the users' browsing to a server), ≤ 4096 printable ASCII. A `script-src` without `'unsafe-inline'` also gets the document's inline-script hashes |
| `GNOME_ALLOW_CUSTOM_WISP` | `false` | Let users connect to Wisp servers of their own (`browser.wispServers`; `/api/config` → `wisp.custom_servers`). `true` adds `ws: wss:` to the `connect-src` of the engine-host and bare-mux worker policies and changes nothing else; custom servers bypass the gateway, its access rules, the VPN profiles and part of the leak protection (startup prints a warning). No URL parameter can do the same (decisions log 2026-11-11) |
| `GNOME_WISP_TICKET_TTL_S` | `3600` | Upper bound of a Wisp ticket's lifetime in seconds (60–604800); a ticket never outlives its session and is checked only at the upgrade, so open connections outlive it (§4.6; 1 h default per the 2026-11-11 decision) |
| `GNOME_TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | CIDRs whose `X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host` (and a well-formed `X-Request-Id`) are trusted; empty = none |
| `GNOME_ACCESS_MODE` | `open` | `open` · `code` · `accounts` (who may use the proxy; `accounts` needs `GNOME_ACCOUNTS=true`) |
| `GNOME_ACCESS_CODE` | – | Required in `code` mode (4–256 chars, constant-time compare). Changing it (or the mode) invalidates anonymous sessions |
| `GNOME_ACCOUNTS` | `true` | User accounts and sync (`/api/auth/*`, `/api/sync/*`; `false` → those routes 404) |
| `GNOME_REGISTRATION` | `open` | `open` · `closed` (accounts; operators can still create users with `gnome-server user create`) |
| `GNOME_SECRET_KEY` | auto | ≥ 32 bytes base64; if unset, generated once into `$GNOME_DATA_DIR/secret.key` (0600) |
| `GNOME_COOKIE_SECURE` | `auto` | `auto` (secure when HTTPS is seen, and on plain HTTP when the request's app origin is a loopback one such as `http://127.0.0.1:8080` or `http://localhost:5173`, which browsers treat as trustworthy for `Secure` cookies) · `true` · `false`. Secure cookies use `__Host-` names |
| `GNOME_WISP_UPSTREAM` | `127.0.0.1:6001` | Primary HolyWisp address (`host:port`; internal addresses only: loopback, private, CGNAT, link-local, never a cloud-metadata address such as `169.254.169.254`, `fd00:ec2::254` or `100.100.100.200`; DNS names are filtered to such answers; `localhost` refused) |
| `GNOME_VPN_PROFILES` | – | Path to the egress gateway profiles TOML (§7; format in `services/vpn/profiles.example.toml`) |
| `GNOME_VPN_CHECK_URL` | empty | The operator's exit check service (HTTPS, JSON with `ip`, `country`, `city`; examples in `services/vpn/README.md`). **Empty = no exit checks at all**: no server-side checks, `verify_url: null`, no browser-side check (D15) |
| `GNOME_VPN_CHECK_URL_V6` | empty | The same service under an IPv6-only name; empty = IPv6 exits are not checked |
| `GNOME_VPN_CHECK_INTERVAL_MIN` | `15` | Minutes between server-side checks of each location (± 20 %; 0–1440; `0` = on request only) |
| `GNOME_VPN_EGRESS_SHARED_OK` | `false` | `true` = the operator states that the VPN egress's terms allow every person who can use this instance; silences D16's start-up and `config check` warning |
| `GNOME_SOURCE_URL` | – | Link to corresponding source (AGPL §13 offer) shown in About |
| `GNOME_ENGINES` | `scramjet,ultraviolet` | Proxy engines the SPA may use (`/api/config` → `engines`) |
| `GNOME_ENGINE_DEFAULT` | `scramjet` | Default engine (must be listed in `GNOME_ENGINES`) |
| `GNOME_CATALOG_REFRESH_HOURS` | `24` | Hours between imports of each source (`catalog.import`, first tick 30 s after start); `0` = only on request (CLI or admin; the local `oss` source is still scanned on the first tick) |
| `GNOME_CATALOG_SOURCES` | `gamepix,oss` | Enabled importers (ids defined by `gnome-catalog`: `gamepix`, `gamedistribution`, `playgama`, `gamemonetize`, `famobi`, `itchio`, `js13k`, `oss`; `none` = no catalog; GameDistribution, Playgama, GameMonetize and Famobi also need their publisher/affiliate ID configured, §6) |
| `GNOME_GAMEPIX_SID` | `1` | GamePix publisher SID (`1` = the public default SID) |
| `GNOME_GD_PUBLISHER_ID` / `GNOME_PLAYGAMA_CLID` / `GNOME_FAMOBI_AFFILIATE_ID` | – | The operator's publisher/affiliate IDs; each is required to enable its source (GameDistribution, Playgama, Famobi) |
| `GNOME_GAMEMONETIZE_ENABLED` | `false` | Opt-in for GameMonetize (after adding the site in its publisher dashboard) |
| `GNOME_ITCHIO_FEEDS` / `GNOME_ITCHIO_MAX_PAGES` | `games/free/platform-web` / `3` | itch.io browse paths (link-out records) / pages per feed (1–20) |
| `GNOME_JS13K_FIRST_YEAR` | `2012` | First js13kGames year (link-out records) |
| `GNOME_OSS_MANIFEST` / `GNOME_OSS_GAMES_DIR` / `GNOME_OSS_REQUIRE_BUILDS` | embedded `oss-games.toml` / `$GNOME_DATA_DIR/oss-games` / `true` | Curated open-source games: another manifest file; where built games live (`<dir>/<slug>/<entry>`); import only entries whose build exists |
| `GNOME_CATALOG_BLOCKLIST` / `GNOME_CATALOG_BLOCKLIST_FILE` | – | Extra trademark/knock-off terms, comma-separated (`!term` removes a default) / a file with one term per line (`#` comments, `title:` / `start:` / `label:` scopes) |
| `GNOME_CATALOG_DEDUP_ORDER` | `playgama,gamepix,gamedistribution,gamemonetize,famobi,oss,itchio,js13k` | Preferred listing when one game is in several sources (unlisted sources are appended in this order) |
| `GNOME_OSS_FETCH` | `auto` | `auto`: the job `catalog.oss-fetch` downloads every enabled OSS entry's pinned commit from `codeload.github.com` when its build is missing; `manual`: only `gnome-server catalog fetch-oss` |
| `GNOME_OSS_MAX_MB` | `512` | Disk cap for all OSS builds together, MiB (16–65536) |
| `GNOME_GAMES_EMBED_HOSTS` | – | Developer hosts the operator approved for game embeds (exact DNS names, comma-separated; D4). Catalog data never adds a host by itself; the admin diagnostics list the `pending` ones |
| `GNOME_ADS_TXT` | – | Absolute path of a file served as `/ads.txt` on the app origin (`text/plain`, ≤ 64 KiB, re-read on change; D22) |
| `GNOME_CATALOG_USER_AGENT` | `GNOME-catalog/<version>` | Feed `User-Agent` (printable, ≤ 200 bytes; e.g. `GNOME-catalog/<ver> (+https://<your site>)`) |
| `GNOME_FILTERS_REFRESH_HOURS` | `24` | Filter lists are re-checked (conditional GET) when their `! Expires` says; lists without one every this many hours; both clamped to 4 h–7 d. `0` = no automatic fetching (only `gnome-server filters refresh` / `POST /admin/filters/refresh`) |
| `GNOME_FILTER_LISTS_FILE` | – | TOML that overrides, disables (`disabled = true`) or adds filter lists on top of the built-in registry (format: `backend/src/filters/registry.rs`, backend/README.md); validated at startup. A list may come from a local file instead of a URL (`file = "/abs/path"`, also the built-in `ubo-resources`): absolute, no `..`, not under `/proc`, `/sys` or `/dev`; only a regular file, opened without blocking, read within the list's size limit and 10 s, checked like a download, re-read at start, every 10 min (job `filters.files`, also with `GNOME_FILTERS_REFRESH_HOURS=0`) and on every forced refresh; a missing file only makes that list unavailable; `/api/filters` never shows the path |
| `GNOME_THUMB_PROXY` | `true` | Serve game thumbnails through `/api/thumb/:id` |
| `GNOME_THUMB_CACHE_MB` | `256` | Disk cap for the thumbnail cache in MiB (LRU); `0` = no disk cache (validated pass-through, nothing stored) |
| `GNOME_MAX_WS_PER_IP` / `GNOME_MAX_WS_PER_SESSION` | `32` / `16` | Concurrent Wisp connections per client IP (IPv6: per /64) / per session (`session_ref`) |
| `GNOME_RATE_LIMIT_SCALE` | `1.0` | Multiplies all rate limits (0–1000; `0` disables rate limiting) |
| `GNOME_ARGON2_MEMORY_KIB` | `19456` | Password hashing cost (Argon2id, t=2, p=1; lower on 1 GB Pi; hashes are upgraded on next login) |
| `GNOME_WORKERS` | – | Tokio worker threads (default = CPUs; capped by the CPU count) |
| `GNOME_DB_READERS` | `4` | SQLite read-only connection pool size (1–64) |
| `GNOME_LOG` | `info` | tracing EnvFilter |
| `GNOME_LOG_FORMAT` | `pretty` | `pretty` · `json` |
| `GNOME_LOG_IPS` | `false` | Include client IPs in logs |
| `GNOME_CSP` | `on` | Content-Security-Policy for the shell: `on` · `report-only` · `off` (debugging; `frame-ancestors 'self'` stays) |
| `GNOME_HSTS` | `false` | Send HSTS on HTTPS responses (enable only when always served over HTTPS) |

Settings of modules that are not part of a build are still validated, and `gnome-server config check` labels them
"no effect"; setting one logs a warning. TOML keys are the variable names without `GNOME_`, lowercased.
Since Wave C the games module is part of every build: the catalog rows above are server settings (`config.rs`
`VARS`), so `config check` shows them and a `GNOME_CONFIG` file accepts them; the server hands them to the
`gnome-catalog` crate. `GNOME_CATALOG_SOURCES=none` turns the catalog off (`/api/config` → `features.games` false).

### 4.3 Security model
- **Who can use the proxy**: the `/wisp/` gateway requires a valid **Wisp ticket** (§4.6, minted by the app origin for
  a valid session) and an allowed `Origin`. `open` mode issues anonymous sessions freely (rate-limited); `code` mode
  requires an access code; `accounts` mode requires login. Combined with per-IP/per-session connection caps this
  prevents GNOME from being an anonymous open relay.
- **Proxy isolation**: proxied sites run on a separate *proxy origin* (§4.6), so a hostile or sandbox-escaping page
  cannot read GNOME's storage (settings, history, bookmarks) or call the authenticated API. That is the only
  isolation GNOME guarantees: inside the proxy origin a hostile site can reach the engine host, other tabs' pages,
  the proxied cookie jars and the Wisp ticket (§4.6 "One shared realm").
- **SSRF**: browsing egress goes only through HolyWisp, whose default-deny policy refuses loopback, RFC 1918, CGNAT,
  link-local (incl. `169.254.169.254` cloud metadata), multicast and reserved ranges *after DNS resolution*. Server-side
  fetches by `gnome-server` (catalog feeds, filter lists, thumbnails, VPN relay metadata) use `gnome-net`'s safe client
  (same IP policy, connect-to-vetted-IP to defeat DNS rebinding, redirect re-validation, size/time limits) and, for
  thumbnails, a host allow-list derived from enabled catalog sources.
- **CSRF**: `SameSite=Strict` cookies + mandatory `X-GNOME-Request: 1` + Origin check on state-changing requests.
- **Sessions**: anonymous tokens are HMAC-signed (stateless); user sessions are random tokens stored hashed, revocable.
- **Admin**: separate loopback listener; optional bearer token; never routed on the public port.
- **Headers**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; app origin: every HTML answer gets
  `Cross-Origin-Opener-Policy: same-origin` (a popup that escapes a game's sandbox keeps no `window.opener`) and a
  deny-list `Permissions-Policy` (camera, microphone, geolocation, payment, USB, serial, HID, MIDI, display
  capture, wake lock, idle detection, credentials, XR, local fonts, window management; fullscreen, autoplay, gamepad,
  clipboard-write and the motion sensors are left to the game frames' `allow`; Firefox ignores most of the header, so
  there the frames' `allow` is what limits games); the shell's CSP has the fixed `frame-src blob: <proxy origin>`
  (`'self'` in single-origin mode; `'self'` also covers the game wrapper) and `frame-ancestors 'none'` with
  `X-Frame-Options: DENY` (nothing frames the shell); other app answers `X-Frame-Options: SAMEORIGIN` and
  `frame-ancestors 'self'`. The **game wrapper** `/play-frame/<slug>` (WAVE-C D2) is the only app document that frames
  third-party content: it runs no script, its own CSP is `default-src 'none'; frame-src <exactly this game's embed
  origin, or <proxy origin>/oss/<slug>/>; style-src '<hash>'; base-uri 'none'; form-action 'none'; frame-ancestors
  'self'`, and it holds one sandboxed iframe of the game (`allow-scripts allow-same-origin allow-popups
  allow-popups-to-escape-sandbox …`, never `allow-top-navigation`). A game may be framed only when its embed host is a
  fixed host of an enabled source or an operator-approved developer host (`GNOME_GAMES_EMBED_HOSTS`); catalog data
  never adds a host. Thumbnails (`/api/thumb/:id`) answer with the sniffed image type, `nosniff` and `default-src
  'none'; frame-ancestors 'none'`;
  proxy origin: no `X-Frame-Options`, and a Content-Security-Policy on **every** response, at least as strict as the
  proxied-document policy (the engine-host policy, the bare-mux worker's two policies, the script policy, the
  `default-src 'none'` policy where nothing runs, the engine-prefix `503` page's, and hyper's own error answers), whose
  `frame-ancestors` names only the app origins and the proxy origin itself (`'none'` for hyper's answers); the full
  list is §4.6 "Headers"; optional HSTS.
- **Limits**: body size limits, per-route rate limits (token buckets keyed by IP and session), WebSocket caps,
  timeouts on every outbound request.
- **Privacy**: no analytics; access logs omit query strings and IPs by default; game play counts are anonymous
  aggregates; browsing history is stored only in the user's browser unless they explicitly enable history sync.

### 4.4 Wisp gateway
`/wisp/` and `/wisp/p/:profile/` (served on the proxy origin) → validate (Origin, ticket, caps, upgrade rate) → open
TCP to the upstream HolyWisp (`127.0.0.1`, never `localhost`) → write a reconstructed HTTP/1.1 Upgrade request: the
route's canonical path (`/wisp/` or `/wisp/p/<id>/`, never the client's query), `Upgrade`, `Connection`, `Sec-WebSocket-Key/Version/Protocol/Extensions`
unchanged; **every** client `X-Forwarded-For`/`X-Real-IP`/`Forwarded`/`CF-Connecting-IP`/`True-Client-IP` dropped and
exactly one `X-Forwarded-For: <bare client ip>` written; `Cookie`/`Authorization` never forwarded → read the upstream
response head (bounded size + timeout) → relay a `101` verbatim (non-101 → `502` JSON) → splice bytes both ways
(Linux `splice(2)` zero-copy when both sides are plain TCP; `copy_bidirectional` otherwise). HTTP/1.1 only (no RFC 8441
h2 WebSockets); no short idle timeout on spliced connections. Per-session/IP connection caps and byte counters live in
the gateway (HolyWisp's own limits are per IP and its bandwidth limiter is ineffective). HolyWisp is configured with
`trusted-proxy=127.0.0.1/32`, `trusted-headers-reset=on`, `trusted-header=X-Forwarded-For` (see
`services/holywisp/gnome.conf`). Counters: active/total connections, bytes up/down. No payload inspection.
Implementation (`backend/src/gateway/`): a plain `GET`/`HEAD` without `Upgrade` is the ticket probe (§4.6: after the
rate limit and the profile check, `401 wisp_ticket_*`, `503 wisp_upstream_unavailable` while the health job has the
route's upstream down, or `426`; no `Origin`, no slot, no upstream contact). Upgrade checks in
order — 60 upgrades/min per IP (probes included), known profile, HTTP/1.1 `GET` WebSocket
upgrade (visible-ASCII header values only), `Origin` exactly the proxy origin, ticket, per-IP (32) and per-session (16)
slots held by an RAII guard — each refusal a JSON 4xx before any upgrade. Splice: the upgraded connection is downcast
to the raw `TcpStream`, each direction runs socket → nonblocking pipe → socket with tokio readiness (via `rustix`, no
`unsafe`; a connection whose pipes cannot be created, e.g. at the file-descriptor limit, is copied instead); buffered
bytes from both sides are written first; EOF half-closes the other side; a write to the browser
stalled for 60 s ends the connection; 10 s grace at shutdown. Upstream health: the `wisp.health` job (every 60 s, early
after a failed connection) does a TCP connect + WebSocket handshake + first Wisp frame per upstream (direct and each
VPN profile) and feeds `/api/health` `wisp`, `/api/vpn/locations`, `/admin/diagnostics` `upstreams` and the probe's `503` (a probe
that answers it asks for an early round, at most every 10 s, and says `Retry-After: 10`).
File descriptors: a spliced connection costs about 6 (two sockets, two pipes), so at startup the server raises its
`RLIMIT_NOFILE` soft limit to the hard limit (capped at 1,048,576; logged once, a failure is only a warning; shown in
`/admin/diagnostics` `fd_limit`), and its accept loops back off 100 ms on `accept()` errors such as `EMFILE` instead
of spinning. Deployments should still set a generous hard limit (systemd `LimitNOFILE=`, `docker --ulimit nofile=`).

### 4.5 Data model (SQLite)
Core (`0001_core.sql`): `users`, `user_sessions`, `user_settings`, `bookmarks`, `history`, `kv`,
`schema_migrations`. Catalog (`0100_catalog.sql`, owned by `gnome-catalog`): `games`, `game_raw` (original
records), `game_categories`, `game_tags`, `games_fts` (FTS5), `game_plays_daily`, `game_play_dedup`,
`catalog_imports`, `catalog_http_cache` (feed validators), `catalog_facets` (listing counts), `catalog_meta`; migration
101 (`crates/catalog/migrations/0101_catalog_search_index.sql`) adds the covering index `games_listed_search`. The
server's migration runner applies both, and the games module (Wave C) uses these tables as they are: no new migration.
Thumbnails live as files in `$GNOME_DATA_DIR/thumbs/` (`<2 hex>/<sha256(url)>.<ext>`, the modification time is the
expiry, LRU-capped by `GNOME_THUMB_CACHE_MB`), OSS builds in `GNOME_OSS_GAMES_DIR` (one directory per slug with a
`.gnome-oss.json` file index). Filter lists are files in
`$GNOME_DATA_DIR/filters/` (content-addressed `<id>.<sha256>.txt` / `.json` plus precompressed `.br` and `.gz`; a new
version is written beside the old one, which is removed once the metadata names the new one) with metadata (SHA-256,
sizes, upstream validators, version, `! Expires`, schedule, last error) in `kv` (`filters:<id>`).

### 4.6 Origins: app origin vs proxy origin
Scramjet and Ultraviolet run every proxied site on the origin that serves them; their JavaScript virtualization is not a
security boundary (a proxied page can read the whole proxied cookie jar, and upstream tests show sandbox escapes). GNOME
therefore uses **two origins served by the same `gnome-server` binary**:

| Role | Example | Serves |
| --- | --- | --- |
| **App origin** | `https://gnome.example.com` | SPA shell (`index.html`, `/assets/*`, `/brand/*`), all `/api/*` (sessions, auth, sync, games, VPN metadata, `POST /api/wisp/ticket`). Never `/wisp/` or engine prefixes when a proxy origin is configured |
| **Proxy origin** | `https://p.gnome.example.com` (or `http://127.0.0.1:8081` in dev) | Only: the **engine host** page `/engine/` (+ files under `/engine/`) and the shared hashed `/assets/*` chunks, `/sw.js`, `/vendor/**` (unmodified engine/transport builds), `/wisp/` + `/wisp/p/:id/`, read-only `GET /api/filters*`, `GET /api/health` (minimal form: status and the direct Wisp upstream only, no version or VPN profile ids), and the engine prefixes `/~/sj/*` and `/uv/service/*` (normally answered by the SW; the server answers a small auto-retrying `503` page, never the SPA). Everything else → 404 |

The role of a request is decided by the listener (`GNOME_PROXY_BIND` ⇒ proxy role) or by `Host` matching
`GNOME_PROXY_ORIGIN`. With neither configured GNOME runs in **single-origin mode** (both roles on one origin): it works,
but `/admin/diagnostics`, the About page and `config check` report *proxy isolation: off* with an explanation.

- **Engine host**: the app's browser view embeds one cross-origin iframe `<proxy-origin>/engine/` (never with a
  query: no URL parameter changes a policy of the proxy origin, see Headers) filling the content area:
  `sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock
  allow-presentation"`, `allow="fullscreen; clipboard-write; autoplay"`. No top navigation, and **no `allow-popups` /
  `allow-popups-to-escape-sandbox`** (decisions log 2026-11-11: escaped code could open a native, unproxied popup):
  `window.open`, `target=_blank` links and forms become GNOME tabs through `tab.openRequest`, and flows that need a
  real popup with `window.opener` (some OAuth or payment sign-ins) must use a full-page redirect. Verified: in this
  sandbox the same-site engine host gets a real origin, a secure context, its service worker, IndexedDB and Cache
  Storage in Chromium 156 and Firefox 157, also with storage partitioning on; a cross-site proxy hostname works too
  but partitions all engine state under the app's site, so keep the proxy origin a sibling of the app's registrable
  domain. The engine host owns the Scramjet `Controller`, the UV/bare-mux wiring, the transports, the service worker
  (scope `/`), one `<iframe>` per tab and (Wave B step 3) the content-blocking runtime. It talks to the app only over
  the typed, validated `postMessage` protocol of `frontend/src/shared/engine-protocol.ts` (`docs/ENGINE-PROTOCOL.md`):
  an instance-id `hello`/`connect` handshake that the app accepts only right after it created the iframe (to reconnect
  it replaces the iframe element, never re-navigates it, which could add a history entry), then one `MessagePort` per
  engine-host load. The app keeps all user data (tabs/session, history, bookmarks, downloads list,
  settings) in *its* IndexedDB; the proxy origin stores only engine state (proxied cookies and site data, filter-engine
  cache).
- **One shared realm** (accepted limitation, decisions log 2026-11-11; the adversarial review,
  `docs/research/spike-engine-host.md` §11): the proxy origin is not a boundary inside itself, and the app origin is
  the only boundary GNOME guarantees. Code that escapes Scramjet or UV in one proxied page can take over the
  engine-host realm, read the Wisp ticket and every app→engine message, forge any engine→app event, read and change
  other tabs' documents, read both engines' cookie jars (HttpOnly included), poison engine storage, replace the
  service worker or UV's shared bare-mux transport, and get around the WebRTC kill switch (§5.4). **No engine bug is
  needed for that**: Wave B step 2 measured that an ordinary proxied page reaches the engine-host window through a
  fresh child realm's native `parent`/`top`/`frameElement` getters in both engines and both browsers (e2e
  `host-attack borrow-natives`, a recorded limit; ENGINE-PROTOCOL §1.1), so every site built to attack GNOME has
  these powers. Only engine-level virtualization of every fresh realm or per-site proxy sub-origins would close it.
  Such code cannot read the app's storage, call the authenticated API with effect, navigate the app, or get a
  message accepted from another frame (verified on both engines and browsers: `host-isolation`, `host-attack`). Consequences: the app validates every engine→app message, rate-limits them per tab and asks
  for a gesture in its own UI before any privileged action; it sends the engine host nothing a hostile page may not
  read (ENGINE-PROTOCOL §1); tickets stay bounded by their TTL and the per-session caps; the UI never promises
  isolation between proxied sites or IP protection against hostile pages, and never presents the address bar as proof
  of a site's identity. Per-site proxy sub-origins would need wildcard DNS and TLS and are out of scope for v1.
- **Wisp tickets**: the proxy origin has no access to the app's cookies. The app calls `POST /api/wisp/ticket` (valid
  session required per access mode) and passes the ticket to the engine host, which connects to
  `wss://<proxy-origin>/wisp/?t=<ticket>&/` (VPN profile: `/wisp/p/<id>/?t=<ticket>&/`). The `&/` is part of the
  canonical form because libcurl-based transports (both generations) refuse a Wisp URL that does not end in `/`; the
  empty-key pair is ignored, so the same URL works for every transport. The gateway also accepts `?t=<ticket>` and
  `?t=<ticket>/` (it strips exactly one trailing `/` from the raw value; tickets never contain `/`), percent-decodes
  the value, refuses a second `t`, and never forwards the query to HolyWisp. Ticket =
  `w2.<exp_s>.<iat_s>.<route>.<session_ref>.<hmac>` (HMAC-SHA256 with the secret key, domain-separated from session
  tokens; `session_ref` = a stable, non-secret hash of the anonymous or user session so per-session caps apply).
  **Route-bound since Wave C (D23)**: the app mints for the route it chose (`POST /api/wisp/ticket` body
  `{"route": "default" | {"profile": "<id>"}}`; `route` = `d` or `p<base64url id>`), and the gateway accepts a ticket
  only on its own path (`401 wisp_ticket_wrong_route`), refuses tickets minted before the process started
  (`wisp_ticket_stale`) and default-route tickets older than the session's latest profile-route mint
  (`wisp_ticket_superseded`; the 15 s re-check also closes such open default-route connections). So a page cannot
  leave a VPN location for the direct route by reusing an older ticket; `w1` tickets are refused. Lifetime: `GNOME_WISP_TICKET_TTL_S` (default 1 h, at most
  7 days), never past the session's expiry. A ticket is a bearer token that proxied pages on the proxy origin can read,
  and in `open`/`code` mode it cannot be revoked, hence the short default. User-session tickets are rejected once that
  session is revoked (cached lookup, ≤ 15 s), and that session's open connections are closed (re-checked every 15 s).
  The ticket only authorizes Wisp; it grants no API access.
  **Tickets are checked only at the upgrade**: an open connection outlives its ticket's expiry (only the `accounts`-mode
  session watch above ends connections). The engine host's lazy renewal relies on this: it keeps healthy connections,
  renews the ticket before `expires_at`, and uses the new one for its next connection.
  **Probe**: the engine host cannot read why a WebSocket was refused, so a plain `GET`/`HEAD` of the same Wisp URL
  without `Upgrade` answers `401` (`wisp_ticket_missing` · `wisp_ticket_invalid` · `wisp_ticket_expired` ·
  `wisp_ticket_revoked`) for a ticket an upgrade would refuse, `503 wisp_upstream_unavailable` with `Retry-After` for a
  valid one while the health job has that route's upstream (direct HolyWisp or the VPN profile's) down, where an
  upgrade would only fail with `502`, and `426` otherwise; a network error means the gateway is down. The probe needs no `Origin` (same-origin GET fetches carry none; real upgrades still need the exact
  proxy origin), shares the per-IP upgrade rate limit (60/min: a probe precedes at most one rebuild, and a separate
  budget would only double the ticket-guessing allowance), takes no connection slot, never contacts HolyWisp and
  changes no ticket state. The engine host renews on 401, rebuilds its transport on 426 and waits `Retry-After` on 503.
- **Headers**: proxy-origin responses never send `X-Frame-Options`. Engine-host documents get the verified engine-host policy (`engineHostCsp()` in
  `frontend/src/shared/proxy-origin.ts`): `frame-ancestors <app origins>; default-src 'self' data: blob:
  'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'` (`data:` because
  libcurl-transport loads its wasm from a `data:` URL, `blob:` because Scramjet's controller fetches the `blob:` URLs a
  page makes in the engine host, integration part 2; it blocks the engine-host realm as a route to the network), plus `nosniff` and `Referrer-Policy`. Custom Wisp servers need an
  operator opt-in (`GNOME_ALLOW_CUSTOM_WISP`, default off, `/api/config` → `wisp.custom_servers`; decisions log
  2026-11-11): only then does its `connect-src` also get `ws: wss:`. The policy is the same for every request: no URL
  parameter widens it, because escaped code can load any same-origin URL in a hidden frame and use that realm. The
  page gets the allowed app origins templated in (`<meta name="gnome-app-origins">`) for the handshake: gnome-server
  replaces `%GNOME_APP_ORIGINS%` in the HTML files under `/engine/` when it indexes them (space-separated,
  HTML-attribute-escaped; the same list as `frame-ancestors`; in single-origin mode `GNOME_PUBLIC_ORIGINS`, or without
  it the origin each request was addressed to) and does not serve their precompressed siblings. In single-origin mode
  the engine host's `frame-ancestors` is `'self'`. `GNOME_PROXY_CSP` is sent as a second policy (its own header), so
  it can only restrict further. `/vendor/bare-mux/worker.js` gets `bareMuxWorkerCsp()` (`connect-src 'self'`,
  verified on the real server, spike §12; `ws: wss:` added with the opt-in): UV's transport SharedWorker accepts
  transport code from any same-origin client; because that policy alone leaves the worker free to `importScripts` any
  URL and, loaded as a document, to load images, frames and modules from anywhere, the worker also gets the script
  policy below as a second policy (`bareMuxWorkerScriptCsp(appOrigins, {customWisp})`; with the opt-in its `connect-src` gets `ws: wss:` too: every policy of a response
  is enforced, so otherwise the opt-in would not reach UV's transports). Every other proxy-origin response gets a policy at least as strict as the
  proxied-document one: scripts (`/sw.js`, `/assets/*.js`, `/vendor/**/*.js`, `/engine/*.js`, which escaped code can
  run as workers or open as documents) get `proxyScriptCsp(appOrigins)` = `PROXIED_DOCUMENT_CSP` + `frame-ancestors
  'self' <app origins>`; everything where nothing runs (JSON answers and errors, the 404s, `/api/health`,
  `/api/filters*`, styles, wasm, fonts, text, other HTML) gets `proxyInertCsp(appOrigins)` = `default-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'self' <app origins>` (the functions of
  `frontend/src/shared/proxy-origin.ts`; `csp.rs` compares its `ProxyPolicies` with the fixture generated from them); the engine-prefix `503` page allows exactly its inline script (by hash), its inline styles and the
  `<proxy origin>/sw.js` registration; the "engine host not built" page `default-src 'none'` plus inline styles. The
  SW does the same for the documents it makes, so no same-origin document is a permissive realm for escaped code
  (backend e2e `tests/e2e/engine/suites/backend-proxy.mjs`, part `realm`: fetch, WebSocket, image, beacon, module
  import, iframe and form submission from each kind of document stay blocked in Chromium and Firefox; part `worker`:
  the same from the bare-mux SharedWorker's own realm). That includes the answers hyper writes by itself for request
  heads it cannot parse (`414` for a request target of 64 KiB or more, `431` for a head over the read buffer, as after
  a page planted a cookie bomb, `400` for a malformed head): they never reach the router, and Chromium commits such an
  empty answer in a frame as a same-origin document, so without a policy escaped code would get a realm that reaches
  any host directly from `<proxy origin>/x?<140 KB>` (seen in the review of Wave B). The connection IO (`server::ConnIo`) sends them with `default-src 'none';
  form-action 'none'; base-uri 'none'; frame-ancestors 'none'` (no browser renders them in a frame), `nosniff` and
  `no-store` (part `oversized`); a panic caught outside the security-headers middleware gets the same policy. A
  reverse proxy in front answers oversized heads with its own error page before gnome-server sees them, so its header
  limit must stay above what browsers send (URLs up to 2 MB in Chromium plus about 720 KB of cookies). No query parameter of any proxy-origin URL changes a policy
  (the only queries read there are the Wisp ticket and the filter lists' `?v=` cache rule). Proxied documents and workers get GNOME's proxied-document CSP
  from the engines (§5.4), never from the server. The app's CSP lists only the proxy origin (`'self'` in single-origin mode) and `blob:` in
  `frame-src` and, when isolated, no `ws:`/`wss:` in `connect-src`. Escaped proxied code can navigate the engine iframe
  itself, and that navigation is checked against the app's `frame-src`, so the list names no game-embed host: games are
  framed through the app's own wrapper `/play-frame/<slug>` (covered by `'self'` only in single-origin mode, where the
  engine host is same-origin anyway), whose own policy names exactly that one game's embed origin (WAVE-C D2, D4).
  Open-source games under `/oss/<slug>/**` (WAVE-C D5): the manifest's `entry` file is the only HTML served and only
  to frame loads (`Sec-Fetch-Dest: iframe` or `frame`; a top-level load or any other destination answers 404, so a link
  to it never runs a game with the proxy origin's first-party storage); every other `.html`/`.htm`/`.xhtml`/`.xht`/
  `.xml` file of a build answers 404; the entry gets `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'
  'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'; frame-ancestors <app origins>` (no `'self'`: a proxied
  page cannot frame it; `; sandbox allow-scripts` for `isolated` entries), scripts `proxyScriptCsp(appOrigins)`,
  everything else `proxyInertCsp(appOrigins)`. Non-isolated OSS games share the proxy origin's realm and storage (the
  reviewed entries only). `blob:` lets the
  engine host's own blob downloads through in Firefox, which checks them against this list (a `blob:` URL belongs to
  the origin that made it, so only proxy-origin blobs, with their creator's strict policy, can load there). The app's `GNOME_PUBLIC_ORIGINS`/same-origin check never accepts
  the proxy origin, so proxied pages cannot make credentialed state-changing API calls (CORS is not enabled on the app
  origin).
- **Deployment**: two hostnames on the reverse proxy (Caddy/Cloudflare) → the same `gnome-server`; or `GNOME_PROXY_BIND`
  for a second port. Both are same-site, so the engine host's storage and service worker are not partitioned away.

## 5. Frontend

### 5.1 Navigation model
Routes (History API): `/` Home · `/browse` Browser · `/games` · `/games/:slug` · `/play/:slug` · `/extensions` · `/vpn`
· `/history` · `/bookmarks` · `/downloads` · `/settings` · `/settings/:section` · `/about`. The **Browser view stays
mounted** (hidden) while other routes are shown, so tabs and their iframes survive navigation. Internal URLs typed in
the omnibox (`gnome://settings`, `gnome://games`, …) map to routes. Pages are lazy-loaded chunks; hovering/focusing a
rail item prefetches its chunk.

Inside the Browser view each GNOME tab shows either a proxied page (a frame inside the engine host, §4.6) or an
internal page; `/browse?url=<address>` opens an address in a new tab (links elsewhere in GNOME use it, so a
middle-click opens GNOME, never the site directly). The engine iframe is created when the Browser view first needs a
proxied tab, not at app start, and lives as long as the app page; if it is reloaded behind GNOME's back, GNOME replaces
it with a fresh iframe (it never re-navigates the old one, which could add a history entry) and restores the tabs
(ENGINE-PROTOCOL §2.3). **Joint session history**: GNOME-initiated loads add no entries to the browser's history, but
navigations inside a proxied page do, so the browser's own Back button can move a tab's frame instead of the app's
route; the engine host reports that as a traversal (a `history` commit, or a same-document `traverse`; verified with
the browser's own Back button, e2e `host-nav`).
GNOME's Back button and shortcut always use the tab's own history.

### 5.2 State & storage (local-first)
IndexedDB database `gnome` (via a tiny wrapper, `lib/idb.ts`) with object stores: `settings`, `session` (tabs, closed
tabs), `history`, `bookmarks`, `downloads`, `games_favorites`, `games_recent`, `extensions`, `sitePermissions`, `kv`.
The schema is **version 2**: upgrades are an append-only list (`UPGRADES[n]` migrates version n → n + 1, never
edited once released); the v1 → v2 upgrade (Wave B, browser data) adds sparse `syncPending` indexes on `history` and
`bookmarks` and an `instance` index on `downloads`, migrates download records to the version-2 shape (a running v1
download becomes "no longer followed") and moves top-level bookmarks from a `null` parent to the root sentinel
`BOOKMARK_ROOT` (IndexedDB does not index `null`). An older GNOME tab holding a v1 connection closes it on
`versionchange` (e2e `library-upgrade`, real Chromium and Firefox IndexedDB).
Settings are also mirrored to `localStorage` (`gnome:settings:v1`) so appearance applies before first paint
(inline boot script in `index.html` reads it and sets CSS variables + theme class → no flash).
When signed in with sync enabled, `settings/sync.ts` mirrors settings/bookmarks (and history only if opted in) to
`/api/sync/*`. Settings: one document without the device-local `account` section; uploads carry `base_updated_at`, and a
`409` is resolved by a per-key three-way merge against the last agreed copy (kept in IndexedDB `kv`), then retried;
lists used as sets (allowlist, start-up pages, Wisp servers, hidden categories) merge as sets. Home-background
pictures uploaded in Settings stay device-local: a picture reference that arrives through sync or an imported settings
file never replaces this browser's own backdrop (`settings/local-picture.ts`). The same holds (`settings/local-vpn.ts`) for `vpn.mode` (this
browser's VPN connection switch) and `vpn.killSwitch` (WAVE-C D12): a value that arrives through sync or an import
never changes them, so a synced kill switch cannot strand a device. Game favorites and recently played (`games_favorites`,
`games_recent`, in use since Wave C) stay in this browser and are not synced (D9; the Games page says so); the
per-network choices of the D24 notice ("This game loads from <network> …") are kept in `kv` and cleared by Clear
browsing data → "Game network choices". Bookmarks/history: the owning feature
registers a `RecordSyncAdapter` (`registerRecordSync`) and calls `requestRecordSync(kind)` after local changes; `since`
cursors live in `kv`. `settings/account.svelte.ts` holds the signed-in user (sign-in, registration etc. via
`/api/auth/*`) and asks `GET /api/session` only when this browser was signed in last time (localStorage
`gnome:account:v1`: user id and name, nothing secret), so signed-out visitors cost no request;
`settings/account-sync.ts` runs sync (`startAccountSync()`, loaded from `main.ts` when idle) and
`settings/account-forms.ts` holds the form checks and error wording.

### 5.3 Settings schema (contract — `frontend/src/settings/schema.ts`)
```ts
export type Theme = 'dark' | 'light' | 'system';
export type Motion = 'none' | 'reduced' | 'normal' | 'expressive';
export type EngineId = 'scramjet' | 'ultraviolet';
export type ShortcutAction =
  | 'newTab' | 'closeTab' | 'reopenClosedTab' | 'nextTab' | 'prevTab' | 'focusOmnibox' | 'reload' | 'hardReload'
  | 'back' | 'forward' | 'home' | 'bookmarkPage' | 'toggleFullscreen' | 'findInPage' | 'openHistory'
  | 'openBookmarks' | 'openDownloads' | 'openSettings' | 'openGames' | 'toggleSidebar' | 'commandPalette'
  | 'duplicateTab' | 'pinTab' | 'zoomIn' | 'zoomOut' | 'zoomReset' | `selectTab${1|2|3|4|5|6|7|8|9}`;

export interface Settings {
  version: 2;
  appearance: {
    theme: Theme;
    accentPreset: 'mint' | 'periwinkle' | 'wheat' | 'moss' | 'lichen' | 'ember' | 'slate' | 'mushroom' | 'fern' | 'custom'; // default 'mint'
    accent: string;                       // hex; used when accentPreset === 'custom'
    colors: { background: string | null; surface: string | null; text: string | null; mutedText: string | null; border: string | null };
    fontFamily: 'inter' | 'montserrat' | 'geist' | 'system' | 'atkinson' | 'fraunces' | 'mono'; // default 'inter'
    fontSize: number;                     // 12–20 px, default 14
    density: 'compact' | 'comfortable' | 'spacious';
    transparency: number;                 // 0.55–1 glass opacity, default 0.82
    reduceTransparency: boolean;
    blur: number;                         // 0–40 px, default 16
    animation: Motion;                    // default 'normal' (respects prefers-reduced-motion when 'normal')
    radius: number;                       // 0–16 px, default 10
    sidebar: 'auto' | 'expanded' | 'compact' | 'hidden'; // default 'compact'
    sidebarPosition: 'left' | 'right';
    toolbar: 'full' | 'compact';
    tabStrip: 'top' | 'hidden-when-single';
    showBookmarksBar: boolean;
    homeBackground: {
      kind: 'wallpaper' | 'glow' | 'none' | 'color' | 'gradient' | 'image'; // default 'wallpaper'
      value: string;                      // wallpaper id, hex color, CSS gradient, https: address or idb:<key>
      dim: number;                        // 0–0.9 (color, gradient and image)
      blur: number;                       // 0–40 px (color, gradient and image)
    };
  };
  browser: {
    searchEngine: 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia' | 'custom';
    customSearchUrl: string;              // must contain %s
    searchSuggestions: boolean;           // fetched through the proxy transport, never via GNOME's server
    engine: 'auto' | EngineId;            // 'auto' = Scramjet with controlled fallback to Ultraviolet
    autoFallback: boolean;                // one automatic retry on the other engine per navigation
    transport: 'libcurl' | 'epoxy';
    wispServers: string[];                // [] = server default (/wisp/)
    homepage: string;                     // 'gnome://home' or a URL
    startup: 'home' | 'restore' | 'urls';
    startupUrls: string[];
    newTab: 'home' | 'blank' | 'url';
    newTabUrl: string;
    openLinksInBackground: boolean;
    closeTabActivates: 'right' | 'left' | 'last-used';
    confirmCloseMultiple: boolean;
    history: { enabled: boolean; retentionDays: number /* 0 = forever */ };
    cookies: { mode: 'all' | 'block-third-party' | 'block-all'; clearOnExit: boolean };
    downloads: { track: boolean; openPanelOnStart: boolean; keepDays: number };
    shortcuts: Record<ShortcutAction, string>;   // e.g. 'Alt+T'; '' = unbound
    defaultZoom: number;                  // 0.5–2
  };
  privacy: {
    webrtc: 'block' | 'allow';            // default 'block'; 'allow' sends WebRTC traffic directly, outside GNOME (reveals the IP address)
    stripTrackingParams: boolean;
    sendGpc: boolean;                     // Sec-GPC: 1
    doNotTrack: boolean;
    referrer: 'default' | 'origin-cross-site' | 'none';
    clearHistoryOnExit: boolean;
    clearSiteDataOnExit: boolean;
    sitePermissions: Record<string /* host */, Partial<Record<'camera' | 'microphone' | 'geolocation' | 'notifications' | 'popups' | 'autoplay' | 'clipboard' | 'fullscreen', 'ask' | 'allow' | 'block'>>>;
    defaultPermissions: Record<'camera' | 'microphone' | 'geolocation' | 'notifications' | 'popups' | 'autoplay' | 'clipboard' | 'fullscreen', 'ask' | 'allow' | 'block'>;
  };
  performance: {
    gpuEffects: boolean;                  // blur/backdrop/shadows; off = flat surfaces
    memorySaver: boolean;
    discardAfterMinutes: number;          // background tab discard when memorySaver on
    backgroundTabs: 'keep-alive' | 'discard';
    prefetchPages: boolean;
    cacheLimitMB: number;                 // cap on the content blocker's cached filter data (Cache Storage, proxy origin)
  };
  vpn: {
    mode: 'off' | 'gateway';              // this browser's VPN switch; device-local (never set by sync or import)
    preferredLocation: string | null;     // gateway profile id; null = Automatic (the first location that is up, pinned)
    autoConnect: boolean;                 // turn the switch on at each fresh start (decided before any tab goes live)
    killSwitch: boolean;                  // if the location is down, block proxied traffic instead of going direct; device-local
    verifyExit: boolean;                  // this browser's exit check through the engine host (`vpn.verify`); default false
  };
  games: {
    view: 'grid' | 'list';
    cardSize: 'small' | 'medium' | 'large';
    defaultSort: 'popular' | 'trending' | 'new' | 'az';
    fullscreenOnPlay: boolean;
    trackRecent: boolean;
    recentLimit: number;
    showMobileOnly: boolean;
    hiddenCategories: string[];
  };
  extensions: {
    enabled: { adblock: boolean; trackers: boolean; privacy: boolean; cookies: boolean; cosmetic: boolean };
    lists: Record<string /* filter list id */, boolean>;
    allowlist: string[];                  // hostnames where all blocking is off
    perSite: Record<string /* host */, { adblock?: boolean; trackers?: boolean; cosmetic?: boolean }>;
    cosmeticAggressive: boolean;          // also apply generic cosmetic filters
    autoUpdateLists: boolean;
    cookieRules: Record<string /* host */, 'allow' | 'session' | 'block'>;
  };
  account: { sync: boolean; syncHistory: boolean; syncBookmarks: boolean; syncSettings: boolean };
}
```
Defaults live in `settings/defaults.ts`. Every key is consumed by real behaviour — the Settings page must not expose
anything that does nothing. Settings are stored whole (not as differences from the defaults), so changing a default
needs a migration (`MIGRATIONS` in `settings/validate.ts`): **v2 (2026-11-12, design v2, docs/DESIGN.md)** moves every
appearance value that still equals its v1 default to the v2 default — accent `wheat` → `mint`, font `geist` →
`inter`, glass opacity 0.78 → 0.82, blur 18 → 16, radius 6 → 10, sidebar `auto` → `compact`, the `glow` backdrop →
the `grove` wallpaper — and keeps every value the user changed. `sidebar` values in v2: `compact` = the slim icon rail
(labels in tooltips), `expanded` = the same rail with labels, `auto` = compact on the browser and on windows under
1100px, expanded elsewhere, `hidden` = no rail (revealed from the screen edge or with the sidebar shortcut).

### 5.4 Proxy engines, transport, service worker
Everything in this section runs on the proxy origin (§4.6): the engine host (`frontend/src/engine-host/`) and the
service worker (`frontend/src/sw/`). The app talks to them only over the engine protocol (`docs/ENGINE-PROTOCOL.md`).
Research: `docs/research/scramjet.md`, `ultraviolet.md`, `holywisp.md`; the verified wiring and its limits:
`docs/research/spike-engine-host.md` (§4 code, §6 recovery, §7 limitations). Unverified parts are marked **(verify)**.

**Pinned packages** (exact versions; copied unmodified to `/vendor/<dir>/` with their licenses by
`scripts/copy-vendor.mjs`, §3; never bundled, minified or obfuscated; no `proxy-bootstrap`, which downloads code at
runtime):
| Engine | Packages | Transports (default first) |
| --- | --- | --- |
| Scramjet (primary) | `@mercuryworkshop/scramjet@2.0.67-alpha.2`, `@mercuryworkshop/scramjet-controller@0.0.14` | `@mercuryworkshop/libcurl-transport@2.0.6`, `@mercuryworkshop/epoxy-transport@3.0.2` (proxy-transports interface) |
| Ultraviolet (fallback) | `@titaniumnetwork-dev/ultraviolet@3.2.10` (upstream; **not** the NebulaServices fork, which is Bare-only), `@mercuryworkshop/bare-mux@2.1.9` | `@mercuryworkshop/libcurl-transport@1.5.2`, `@mercuryworkshop/epoxy-transport@2.1.29` (BareTransport interface — the 3.x/2.x builds fail with bare-mux 2.1.9) |

**libcurl is the default transport for both engines** (`browser.transport`): both epoxy builds hang on the first
request after a site closed an idle keep-alive connection and never reconnect after a Wisp drop (spike §7.1–§7.2);
epoxy stays selectable behind the watchdog. UV with libcurl 1.5.2 in Firefox fails its first request after
`setManualTransport` ("wasm not loaded yet"), so that side is ready only after a successful warm-up **(verify)**.

**Engine host.** The page loads the vendor scripts in a fixed order (`ENGINE_HOST_SCRIPTS`: `scramjet.js` before
`controller.api.js`, bare-mux, `uv.bundle.js`, `/engine/uv.config.js`), then its module. It refuses to run outside an
iframe, performs the handshake, and on `init`: clears proxied data if asked, makes sure the service worker controls it
(applying a waiting update first when it is the only engine host), starts the transports, then both engines in
parallel. Scramjet: the wasm's magic bytes are checked (the controller "inits" with a 404), the first transport is
initialized before use, `new Controller({serviceworker, transport, config, scramjetConfig: {flags:
{allowFailedIntercepts: true}}})` (the controller's own default is lost in its merge), `controller.wait()` with a 10 s
timeout; on `controllerchange` the controller's `serviceWorkerController` is pointed at the new worker (a field of
controller 0.0.14: re-check on upgrades). Ultraviolet: bare-mux and `__uv$config` loaded, then the transport manager's
UV side, 10 s timeout. Engine adapters (`engines/scramjet.ts`, `engines/ultraviolet.ts`) implement one internal
interface behind the engine manager, so each stays independently maintainable.
- **Tabs**: one iframe per tab (its `allow` set from the decisions the app sends with each GNOME-initiated load, §5.6
  permissions); at most `LIMITS.maxLiveTabs` (32) live frames. GNOME-initiated loads use `location.replace` (or `src`
  on a fresh frame), so they add no entries to the joint session history; per-tab history is GNOME's, at most 50
  entries per tab with push/replace/traverse on every commit (never `frame.back()`, which can move other frames or the
  app; `tab.go` loads the target entry in full). Scramjet's controller has no frame-removal API (the host removes its
  frame from `controller.frames`).
- **Per-document observation**, at any nesting depth, from Scramjet's `init.pre`/`init.post` hooks and the UV
  document-start hook (`/engine/uv-doc-hook.js`, which the SW puts first in the parsed `<head>` of every HTML document
  UV rewrites, `srcdoc` children included, by wrapping each UV instance's `createHtmlInject`; a text search for
  `<head>` was fooled by comments and attributes): forwarded keys, context menus, title, commits with push/replace/traverse (the Navigation API on the
  tab's top document, else `History.prototype` wrappers, `popstate` and `PerformanceNavigationTiming`; the spike's UV
  URL polling only saw that the URL changed), the start of UV navigations begun in the page (the `navigate` event, else
  `beforeunload`: UV has no request hook in the engine host), CSP-violation counting, popup routing (§5.6) and the
  WebRTC kill switch. Every load of a tab frame is classified, so a failing page shows GNOME's error overlay, never an
  engine's error page. **Realm hygiene** (`src/engine-host/realm.ts`, its header states the rules): a proxied page is
  same-origin with the engine host, so any engine-host function, error or array it can reach hands it the engine
  host's global (`fn.constructor('return this')()`). Everything GNOME installs in a page realm is therefore a callable
  of that realm (`pageKit(win, N)`: a Proxy made by the page realm's own `Proxy` around a page-realm function, its
  trap compiled with the page realm's own `Function` at document start; GNOME's step sits only in the trap's closure
  and anything it throws, a stack overflow included, reaches the page as a page-realm error); engine-host code never
  runs page code (it reads page objects only through its own realm's native getters, `natives.ts`, converts page
  values with the page realm's `String`, and serializes form entries in the page realm); and no engine-host observer
  or callback receives page nodes (Blink would hand the page engine-host wrappers), hence page-realm
  `MutationObserver`s. E2e `host-attack realm-walk` and `page-getters`: no engine-host function, arguments array or
  DOM wrapper within an ordinary page's reach, both engines and browsers. This keeps GNOME from opening a path of its
  own; it does not close the engines' paths (§4.6 "One shared realm"). All of this observation is verified by the
  `host-*` suites (ENGINE-PROTOCOL §6).
- **Controlled fallback** (verified): on an *engine-level* failure of a Scramjet navigation (the `error.request` hook,
  3–18 ms, or the navigation timeout, 20 s; never an HTTP 4xx/5xx page of the site; a frame that left the proxy origin
  is a final error) the engine host retries the **same destination once** on Ultraviolet if `autoFallback` is on, the
  engine was not forced, UV is ready and the navigation is **idempotent (GET or HEAD)**: a POST is never re-sent (it
  would submit a different request, or the same one twice after a timeout) and ends as an error offering the other
  engine. The error
  hook fails the navigation synchronously (a deferred call let Scramjet's substitute page commit first). The
  destination site's cookies are copied from Scramjet's jar into UV's `__op` store first, HttpOnly included. No
  switching back automatically, no retry loops: a per-tab attempt counter is reset only by a user-initiated
  navigation, which starts on Scramjet again. A Scramjet init failure sends every navigation to UV. Users can reopen a
  tab in the other engine or pin one (`browser.engine`).

**Transport manager** (`frontend/src/engine-host/transport/`; interface and pure rules in
`frontend/src/shared/transport.ts`), the recipe the spike verified with all four engine × transport combinations:
- One URL form for every transport: `wss://<proxy origin>/wisp/?t=<ticket>&/` (profile: `/wisp/p/<id>/?t=<ticket>&/`).
  Custom Wisp servers (`browser.wispServers`) are used only when the operator allows them (`GNOME_ALLOW_CUSTOM_WISP`,
  which adds `ws: wss:` to the engine-host and bare-mux worker CSPs, §4.6) and the VPN is off; they are used in order
  and never get the ticket; `ws:` servers are skipped from an https proxy origin (mixed content), and a server's path
  must end in `/` (Wisp v2). Before a transport is built for a custom server, a test socket (the engine-host realm's
  own, outside the watchdog's taps) checks it opens; the first server that answers is used. Verified on the real
  stack: with the opt-in a dead first server is skipped before the first navigation and pages load with all four
  engine × transport combinations; without it nothing reaches a custom server and both sides say
  `offline`/`gateway-unreachable`.
- Build a transport, `await init()`, and only then hand it over (Scramjet: `controller.setTransport`; UV: bare-mux
  `setManualTransport` inside its SharedWorker). Every (re)build goes through **one queue**: concurrent libcurl
  `init()` calls hang.
- **Watchdog**: socket closes are observed (Scramjet's transport: a `WebSocket` wrapper in the engine-host realm,
  installed before the transport modules load; UV's: a tap installed with the transport inside the bare-mux worker,
  whose events reach every engine host, never over a fixed channel name (verified with two GNOME tabs); UV transport
  errors reported by the SW).
  These signals are hints that trigger the **probe** (`GET` of the same URL without `Upgrade`, §4.6): libcurl
  reconnects by itself with the URL it was built with, so after a drop it is probed once (401 → new ticket); epoxy never
  reconnects, so it is probed and then rebuilt (426), given a new ticket (401) or backed off (network error:
  250 ms·2ⁿ ±50 %, ≤ 30 s, 12 attempts, then every 60 s and on the next navigation). The probe never contacts the
  upstream, so a socket that fails to open right after a `426` means HolyWisp or the VPN location's instance is down
  (verified on the real server: `426`, then `502` on the upgrade): the side reports `offline`
  (`upstream-unreachable`) and backs off the same way instead of rebuilding after every `426`. The probe itself
  answers `503 wisp_upstream_unavailable` with `Retry-After: 10` while the server's health job has that upstream down
  (§4.4), which the side reads the same way and waits out, also when a navigation fails meanwhile (one probe per
  `Retry-After`, verified); a `404` means the VPN profile is gone (`unknown-profile`: the app picks the route again).
  A VPN location's status comes from the app (`/api/vpn/locations`). A `429` probe answer (the real gateway sends it
  with `Retry-After`) waits that long and is never read as "gateway down" or "ticket rejected" (verified). Rebuilds are
  capped at 6 per minute per side; beyond the cap the side reports `offline` (`rebuild-limit`) **(verify)**: unit-tested
  only.
- **One Ultraviolet transport per proxy origin**: every engine host of the browser (one per GNOME tab) shares bare-mux's
  single SharedWorker, so UV pages in every GNOME tab use the transport the last `setManualTransport()` installed. A
  manager installs it only at start (when the worker runs nothing or another route or kind), on a settings change of
  its own, or to rebuild one of its own route and kind (`uvTransportAction`), never to replace another route because a
  check found it different: the app syncs settings across its tabs, so a GNOME tab with slightly older settings cannot
  undo a VPN or kill-switch change made in another (verified with two GNOME tabs, also after the installing tab closed).
  **The lock**: bare-mux accepts transport code from any port that connects to its worker, and UV does not wrap
  `SharedWorker`, so an ordinary UV page could install a transport of its own and receive every later UV request of
  every GNOME tab. GNOME's install code wraps bare-mux's `onconnect`: a later port may install only code that starts
  with a per-origin secret the engine hosts keep in `localStorage` (`gnome-uv-transport-lock`; the `gnome-` prefix
  keeps it out of site-data clearing). A page can still read the transport's name (the route key) and send requests
  through it as UV does; a page that reaches the engine host can read the secret (ENGINE-PROTOCOL §1.1, §6.6).
- **Tickets**: proactive renewal at 80 % of the ticket's remaining life, never sooner than 10 s
  (`needTicket {expiring}`; a fixed 5-minute margin fired at once for the minimum 60 s TTL, spike §12), measured on
  the browser's clock after the app converted `expires_at` with the response's `Date` header (a skewed device clock
  changes nothing), a new ticket after a 401 probe (`needTicket {rejected}`);
  the app defers and coalesces ticket requests inside its rate limits, never drops them; and **lazy renewal**: a new
  ticket rebuilds libcurl transports (cheap: their old socket closes) and anything not `ready`, while a healthy epoxy
  transport keeps its socket (no transport has a close API, so rebuilding it would leak a Wisp connection against the
  16 per session). Tickets are checked only at the upgrade (§4.6).
- Status per side (`connecting` · `ready` · `degraded` · `offline`, with `ticket-missing` · `ticket-rejected` ·
  `gateway-unreachable` · `upstream-unreachable` · `unknown-profile` · `rate-limited` · `rebuilding` · `rebuild-limit`)
  goes to the app's status registry.
- After a recovery the last failed GET navigation of each tab is retried once **(verify)**.

**Service worker** (`/sw.js` on the proxy origin, classic script, scope `/`, built from `frontend/src/sw/`; served
`no-cache` with `Service-Worker-Allowed: /`): one SW for both engines; it takes **no security configuration at
runtime** (the CSP, the routing and the WebRTC policy are constants of the build). Its only runtime input is the
content blocker's (Wave B step 3), accepted only from clients it registered as engine hosts by client id (a
navigation to `/engine/`; proxied clients are refused): the user's blocking settings (`gnome-blocker-config`), the
compiled filter engines (`gnome-blocker-engines`, sent whenever an Ultraviolet load starts and the SW lacks the set
in force) and the Ultraviolet page context (`gnome-blocker-context`: documents and their top-level pages, announced
tab-top navigations, the initiators of GNOME's own loads). It persists none of it; privacy headers and cookie modes
apply from the first request with the schema defaults until an engine host sent the user's settings (≤ 300 ms wait
per SW start).
- Before `importScripts` of `controller.sw.js` it replaces `self.skipWaiting` with a no-op: upstream would take over
  running engine hosts, which breaks both engines. Updates therefore **wait**; first installs still activate at once.
  The engine host applies a waiting update at startup, before any engine exists, when it is the only engine host
  (Firefox does not apply it across a reload by itself; the host asks again every 500 ms for 3 s, because a GNOME tab
  closed a moment earlier can still be counted), and the app shows "GNOME was updated — Reload" otherwise. Once
  controlled, the host also checks for an update itself (`registration.update()`: at once when the active worker is
  another build, else after 3 s, then every 15 min), because Chromium can install a new `/sw.js` only after the load
  that should have applied it. A check **before** control broke Firefox (it left a redundant controller and
  `controller.wait()` timed out) and is not done. Verified in both browsers (`sw update`, `shell-sw-update`; the
  apply at the reload right after the other GNOME tab closed is intermittent in both browsers, so it can take a
  second reload: ENGINE-PROTOCOL §2.5). A forced
  reload loads the engine host uncontrolled; it posts `gnome-claim` and the SW claims it.
- `/~/sj/*` → Scramjet controller routing. While no controller has announced the prefix (SW restart, first load) the
  request is **held** up to 5 s while the SW asks window clients to revive the controller (once a second), then
  answered `503`; a prefix whose engine-host window is gone (app reload) gets `503 stale-prefix` at once. Never passed
  through to the network. **Firefox stops an idle service worker after about 30 s even while engine hosts run**, so
  the hold is a normal path there: `controller.sw.js` itself asks the clients to revive the controller when the worker
  starts, and a second, immediate revive by the hold made the engine host's `Controller` replace its port and lose a
  request already in flight (the page hung for 20 s). The hold therefore waits one interval before it adds a revive
  of its own (verified: `sw stop`, Chromium over CDP and Firefox by its own idle stop).
- `/uv/service/*` → UV (`uv.sw.js`) with GNOME's fixes: Firefox request bodies (no `Request.prototype.body`; the body
  is buffered into one ArrayBuffer per request and handed to bare-mux's internal Request), the document-start hook
  (rewritten HTML documents, above), download taps (navigation responses that are attachments or of a type browsers
  do not render, and `<a download>` requests, never a page's own fetch; ENGINE-PROTOCOL §6.9) and transport-error
  reports. UV `sharedworker` requests get a `403`: UV serves shared-worker scripts unrewritten, which gave a page a
  native worker on the proxy origin with every engine's cookie jar, so sites lose `SharedWorker` under UV (Scramjet
  rewrites them: code reading, no row). The SW's own hold, `503`, blocked and refused pages carry `SW_PAGE_CSP` (`default-src 'none';
  form-action 'none'; base-uri 'none'`), so they are no permissive realm (§4.6).
- **Documents the engines leave unrewritten** (both engines): `<frame>` loads are shown to the engines as `iframe`
  loads (neither engine rewrites destination `frame`, so a `<frameset>`'s documents loaded raw and ran natively with
  the engine host two parents up); every frame answer an engine did not rewrite and whose type can run scripts (SVG,
  XHTML, XML, HTML without a usable `Content-Type`; UV rewrites only an exact `text/html`) gets `SCRIPTLESS_CSP`
  (`script-src 'none'`) as a second policy, so it runs no scripts at all. Browsers never pass `<object>`/`<embed>`
  loads through a service worker: they reach gnome-server's engine-prefix `503` page, so proxied HTML inside them
  does not load. Verified in both browsers (`sw` parts `frames`, `unrewritten`, `object`, and the `sharedworker`
  row that refuses a UV-proxied SharedWorker; that Scramjet rewrites a page's SharedWorker passes in Chromium only, a
  known Firefox limit, ENGINE-PROTOCOL §6.16).
- GNOME's proxied-document CSP (`PROXIED_DOCUMENT_CSP`: `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'
  'wasm-unsafe-eval'; connect-src 'self' blob:; form-action 'self'`; `blob:` because Ultraviolet's SW fetches the `blob:`
  URLs a page makes, and a `blob:` URL never leaves the browser) on every response with a navigable destination
  (`document`, `iframe`, `frame`, `object`, `embed`; any content type) and on worker scripts: UV in the SW's `response`
  handler, Scramjet in the per-tab plugin's `fetch.response` (both after the engine removed the upstream CSP).
- Messages from the engine host count only when `event.source` is a window client at `/engine/` (by its URL, which a
  page can fake with `history.pushState` from a native realm: WAVE-B3 §11.2 F3, open); signals to the engine host (UV
  downloads and errors, held and refused requests, its build id) go to the engine-host clients with
  `Client.postMessage` (verified), never a BroadcastChannel, which any proxied page can join (spike §9.5: an ordinary
  page turned the session-3 SW's UV CSP off that way). Everything else passes through.

**Leak mitigation.** Neither engine rewrites CSS that enters a `<style>` as a Text node (MediaWiki does that: 7 icons
of Wikipedia loaded natively), and a 53-construct lab finds 16–26 such client-side gaps per engine and browser
(spike §5.2). The proxied-document CSP turns every one of them into a blocked load (0 native requests, no regression
in a 30-check feature probe, 8 real sites unchanged except Wikipedia's 7 icons, which stay blank; `host-leak probe`
repeats the probe on the built engine host in both browsers: page-made `blob:` images, workers and fetches work since
integration part 2 put `blob:` into the `connect-src` of this policy and of the engine host's, the realms where the
engines resolve them). It does not bind
escaped code; the engine-host CSP (§4.6) closes the engine-host realm as a route. Violations are counted in the engine
host (`securitypolicyviolation`) and shown as blocked direct connections; never sent with `report-uri`/`report-to`
(the reports would carry the user's browsing). Keep the spike's `leak` suite (lab + sites) as the regression test for
engine upgrades: a new engine version must not add native constructs.

**WebRTC kill switch** (`privacy.webrtc`, default `block`). WebRTC sends STUN/UDP directly, outside Wisp, from
ordinary proxied pages of both engines (measured: it reveals the user's IP). With `block` the engine host replaces
`RTCPeerConnection`, its `webkit`/`moz` aliases, `RTCDataChannel`, `RTCIceCandidate` and `RTCSessionDescription`
(`WEBRTC_GLOBALS`) with `undefined` at document start in every proxied window (Scramjet `init.pre`, the UV
document-start hook) and in the engine-host realm, and a child-frame guard (page-realm wrappers of the getters and
insertion methods that reach a child window, per-document page-realm observers, `load` listeners and sweeps by
index; the engine-host document gets the same recursive guard) applies it to child realms before the page can use
them. Verified in both browsers and both engines (`host-webrtc`, 0 STUN packets): the page's own realm, `about:blank`,
`srcdoc`, sandboxed and `data:` children, parser-inserted frames, `<object>`/`<embed>` blank documents, shadow roots,
`document.write`, `execCommand` and the realms escaped code makes with the engine host's DOM. It stays **partial**,
and that is measured (`gaps-open`, a recorded limit): a page that polls a child frame while it loads a new proxied
document reaches the new realm before the document-start script runs; UV runs a `javascript:` document's script
while it is parsed; Firefox makes a frame re-navigated to `about:blank` reachable before its `load` event; and (code
reading only, no row) a page that exhausts the stack around an insertion gets past the wrapper until the observer
runs. None of these can be closed
from page JavaScript, and a page that reaches the engine host (§4.6) shares the guard's realm. So the switch stops
sites that use WebRTC in the ordinary way, not a site built to reveal the IP address; only connection-level blocking
(impossible for a website) would. `allow` keeps WebRTC working; Settings says it sends traffic directly, outside
GNOME, revealing the IP address. With the VPN kill switch on, the app always sends `block`. A change of the setting
applies to the documents that load after it (`host-webrtc webrtc:switch`, both browsers and engines): each proxied
document decides at its start, and the engine-host realm's own guard follows the live setting.

**Main-thread cost and tab caps.** App and engine host are same-site, so their documents share a renderer process and
its main thread: Scramjet's rewriting caused 5–12 long tasks (0.34–1.06 s in total) and timer stalls up to 0.28 s per
example.com + Wikipedia session in Chromium (session 3: single stalls up to 0.7 s); UV 0–2 (≤ 0.21 s). A busy proxied
page can freeze the shell as well. Hence: at most 32 live tab frames per engine host, and the app discards the least
recently used background tab beyond `LIMITS.liveTabsSoftCap` (16) live proxied tabs, besides
`performance.memorySaver`/`backgroundTabs` (discarded tabs are restored from their real URLs and back/forward
entries). A cross-site proxy hostname would give the engine host its own process, at the cost of partitioned engine
state; not evaluated.

**Known upstream limitations** (documented in the About page, tracked by the e2e suite): the CSS-rewriting gaps above
(blocked, not fixed; unrewritten relative URLs stay broken); Scramjet's `Text.appendData` hook throws; UV's dynamic
`import()` fails; in Firefox Scramjet's blob/URL workers and `postMessage` from `srcdoc` frames time out and UV's
workers error; the epoxy keep-alive hang and missing reconnect; UV + libcurl 1.5.2's first request in Firefox; UV's
WebSocket to echo.websocket.org opens but never echoes; Wisp CLOSE reasons are not surfaced by any transport (so DNS and
TLS failures cannot be told apart); no transport has a close API; libcurl sends `Upgrade: h2c` on plain-HTTP requests;
downloads belong to the browser (no cancel); sync XHR, WebSockets in workers and `localStorage.clear()/key()` are
broken in Scramjet 2; proxied sites get no service workers; some sites detect the transport's TLS fingerprint;
Chromium preconnects (TCP + TLS + SNI) to the host of a CSP-blocked navigation. GNOME's own limits, listed with them:
downloads of `blob:`/`data:` URLs a page builds itself are not listed, and a UV download behind a redirect from a
`no-referrer` page may not be; per-site autoplay/fullscreen decisions apply from the next GNOME-initiated load after
an in-page navigation to another site, and only where the browser enforces them (both in Chromium, only fullscreen in
Firefox; clipboard writes in neither: Chromium's `clipboard-write 'none'` does not stop `document.execCommand('copy')`);
sites are not kept apart as in a browser: neither engine enforces CORS and Ultraviolet 3.2.10 sends every cookie
whatever its SameSite attribute, so any proxied site can read other proxied sites' signed-in pages (under Scramjet,
those with `SameSite=None` cookies; step 3's cookie manager is the planned mitigation); one click in a page opens one
GNOME tab (the app counts the same tab's next open within 1 s as having no gesture); popups and privileged forwarded
shortcuts need the user's activation to reach the app
document (it does, in both browsers); the WebRTC kill switch does not stop a site built to get around it (above); a
hostile site can reach GNOME's engine host and through it other tabs' pages and cookies and the connection ticket
(§4.6); under Ultraviolet, sites' `SharedWorker`s are refused; SVG, XHTML and XML documents and HTML without a usable
`Content-Type` run no scripts; proxied HTML inside `<object>`/`<embed>` does not load; printing in Firefox is expected to freeze GNOME's UI while the print dialog is open (the engine host shares
the app's process, ENGINE-PROTOCOL §6.10; not tested with a real dialog).

### 5.5 Extensions (built-in, first-party)
Research: `docs/research/sapphire.md`, `content-blocking.md`; plan and decisions D1–D19: `docs/WAVE-B3.md`. Sapphire
has **no license**, so GNOME implements its own first-party runtime (no code copied; no `chrome.*` emulation; no
user-installed extensions, no extension manifest; the UI never claims extension compatibility; lists are "filter
lists" with their publishers and licenses). Built-ins: **ad blocker**, **tracker blocker**, **privacy protection**,
**cookie manager**, **cosmetic filtering**. They exist only where the engine host offers the capability `blocker`
(D19), which every build does since the Wave B step 3 integration (2026-11-21); the app then registers the
`extensions` feature (Settings rows, the toolbar shield, the Extensions page, About's "Content blocking").

- **Groups and toggles (D1, D2).** One `@ghostery/adblocker@2.20.3` engine per list group (`ads`, `security`,
  `trackers`, `params`, `cookies`, `annoyances`; MPL-2.0, unmodified, `-content` for the page side). `ads` and
  `security` follow the ad blocker, `trackers` the tracker blocker, `params` privacy protection + "Remove tracking
  parameters", `cookies`/`annoyances` cosmetic filtering; element hiding follows cosmetic filtering, generic hiding
  also needs aggressive mode, scriptlets follow their group. Engine configuration v1 (D12): preprocessors on (env
  from `browserFamily()`), no extended selectors, no `$csp`, no HTML filtering, integrity check on.
- **Precedence (D3).** Allowlist > per-site override > global toggles > filters, keyed by the tab's top-level page
  (`src/shared/site-rules.ts`); frames inherit. A tab's own document request, every redirect hop and its response
  are judged under the page being loaded, never the page being left. Cookie rules are keyed by the cookie's own site
  (D4). A request whose page cannot be told (Ultraviolet, unknown context) is judged with the global settings,
  without site rules, as third-party.
- **Scoped site rules (D5).** The app sends `allowlist`/`perSite` only for sites the engine host shows or is about to
  load (`tab.loading {url}` announcements, answered by a snapshot; a Scramjet tab request waits ≤ 150 ms for it), at
  most 20 newly exposed rule-bearing sites per tab per minute and 120 per app page per hour, paused for the page after
  two compromise signals; `cookieRules` travel whole while the cookie manager is on.
- **Builds, cache and fail open (D6–D9).** The engine host fetches each list as `GET /api/filters/<id>?v=<sha256>`
  and compiles it only when the body's SHA-256 matches the ref (else `changed`, the app refreshes its listing). Builds
  run in a module Worker on the proxy origin (one at a time per browser, Web Lock with a 30 s cap), groups one after
  the other. Every list first passes GNOME's sanitizer (`src/extensions/core/sanitize.ts`, `SANITIZER_VERSION`, part
  of the cache key): it drops comments, procedural (`#?#`), HTML-filtering, ABP snippet and AdGuard JavaScript rules,
  `$csp` and lines over 8 KiB, converts ABP `{style}` to `:style()`, keeps `:style()` only without `url(`, `src(`,
  image functions, `expression(`, escapes, comments, braces or `@`, drops every hiding or `:style()` rule whose text
  has a brace, a comment opener or a control character, and drops from lists not marked trusted every scriptlet that
  needs trust and every scriptlet line with a backtick or `$` in its arguments. Selectors are validated by the
  browser's own stylesheet parser on the engine host's main thread in ≈ 8 ms slices: rules that do not parse as one
  style rule, that name `::highlight(` or that hide the root or body element are removed, except `:style()` rules on
  the root or body that only restore the page (scrolling, backgrounds, `filter: none`, margins of 0). The built set
  is stored in Cache Storage (`gnome-blocker-v1`) with an HMAC-SHA-256 under the app's random 256-bit `blockerKey`
  (IndexedDB `blocker:key:v1`, never synced or exported; replaced when site data is cleared, at a start with "clear
  site data on exit" pending, and after a compromise signal); a set that does not verify is rebuilt. Up to
  `performance.cacheLimitMB` (16–8192, default 256) is cached; a larger set is built at every start and still reaches
  the SW by message. Blocking fails open until a set is in force and never during updates (the old set blocks until
  the swap); `init` waits ≤ 500 ms for a verified cached set, never for a build.
- **Resources and scriptlets (D10, D11).** `$redirect` resources answer subresources (200), never documents;
  Ultraviolet's JS rewrite of a script stub is required (an unrewritten stub would leave the proxy). Scriptlets run at
  document start in the page realm through `PageKit.run`, compiled with the realm's current `Function` after the
  engine's client (Scramjet `init.post`, UV's `__uvHook` assignment), inside `withPageAssignments`, with GNOME's JSON
  argument assembly; never a `<script>` element, never the engine-host realm. Every page-side line keeps rule R1
  (ENGINE-PROTOCOL §1.2 rule 10).
- **Cosmetic filtering.** In each proxied document, at any depth, the cosmetic provider adopts one constructed
  stylesheet of the page's own realm (a page-made `<style>` where that fails). With generic filters on it watches the
  classes, ids and hrefs that appear (a page-realm `MutationObserver` read with engine-host natives only; at most
  4,096 features, 1 batch per 100 ms and 512 KiB of CSS per document, stopped at a trusted `pagehide`) and adds the
  matching generic rules to a second sheet. A document that opens before the engines are ready gets its styles when
  they are, not its scriptlets.
- **Privacy protection.** `Sec-GPC` and `DNT` on every request, `navigator.globalPrivacyControl`/`doNotTrack` in
  documents GNOME attaches; the `Referer` is only ever reduced, never past a browser's default
  `strict-origin-when-cross-origin`, in every mode and with privacy protection off; the initiating document's own
  `Referrer-Policy` header applies to its subresources, frames and the tab navigations it starts (Scramjet serves
  every document as `unsafe-url` and ignores `<meta name="referrer">` for its HTML's elements); `document.referrer`
  is reduced the same way per realm. Tracking parameters are removed from tab documents and frames (GET/HEAD) by a
  same-origin 307 (D13): the params group's `$removeparam` filters, then GNOME's built-in table (ClearURLs-derived,
  LGPL-3.0), at most 3 times per tab (SW: per destination page) in 10 s.
- **Cookie manager.** Modes (`block-third-party` by default, `all`, `block-all`) and per-site rules (allow, until
  GNOME closes, block) remove `Cookie` and `Set-Cookie` before the engines' jars; "until GNOME closes" strips
  Expires/Max-Age and the app deletes those sites' cookies at the next fresh start, before tabs are restored.
  `document.cookie` is wrapped per realm and decides by the realm's document and the document it is called on; a
  blocked UV document gets an empty script-cookie string. Whatever the mode, GNOME refuses `Set-Cookie` lines a
  browser refuses (another site's or a public-suffix `Domain`, `__Secure-`/`__Host-` violations, `Secure` from
  insecure origins), and applies SameSite to Ultraviolet's requests by Chromium's rules (Lax by default, `None` needs
  `Secure`, two-minute Lax+POST), replacing Ultraviolet 3.2.10's cookie serialization, with the initiators the
  engine host announces (ENGINE-PROTOCOL §6.17). The Extensions page lists both engines' jars by registrable domain
  (names, never values).
- **Adapters** (through `src/shared/engine-hooks.ts`; one composite registration, `src/extensions/core/compose.ts`):
  Scramjet's per-tab `fetch.request`/`fetch.preresponse`/`init.post`; for Ultraviolet the SW's `request`/`beforemod`
  with the page context the engine host sends (D15: documents, announced tab-top navigations, redirect hops recorded
  as the tab's own document) and the engines by message; WebSockets judged in the page realm for Scramjet (D16, the
  transport manager's wrapper as a backstop) and through `BareClient.prototype.createWebSocket` in each UV document.
- **Shared realm.** The filter engine, its Worker and its cache live on the proxy origin, so code that escaped its
  engine can disable or poison them, and any page can become such code (ENGINE-PROTOCOL §1.1: measured paths in both
  engines). Blocking protects against sites that do not target GNOME, not against one that does; the UI says so
  (About, "Content blocking").
- Blocked documents show GNOME's "blocked" page (no "proceed once"); counts per tab are `tab.blocked` (CSP-blocked
  direct connections are their own category). Games and their publisher embeds are **never** filtered (§6).
- **Measured (2026-11-20/21, this machine, Chromium 156 / Firefox 157).** First build of the test lists ~250 ms in
  Chromium, ~1.3 s with the 550,000-line big list in Firefox; a cached load ~260 ms after the settings command;
  sanitizing the server's 12 lists 173 ms cold; validating the default lists' 31,077 selectors 91–110 ms of
  main-thread work in 12–14 slices of at most 8–10 ms (above the 50–90 ms estimate, never a long task); cosmetics per
  document under 1 ms on most sites, youtube.com with 30 scriptlets 15 ms (Chromium) / 24–26 ms (Firefox). Production
  build 2026-11-21: engine-host entry 185.7 KB, blocker chunk 143.3 KB (dynamic import), builder Worker 279.5 KB,
  `sw.js` 296.8 KB (raw; budgets 300/400/400 KB and +350 KB over step 2); the app's startup 144.4 KB gzip JS + 14.3 KB
  gzip CSS. A Raspberry Pi 4 was not available: its column in WAVE-B3 §10.2 stays an estimate.

### 5.6 Browser features
The app-side browser (`frontend/src/browser/`, `pages/browser/`) drives the engine host through the protocol; the
library (`frontend/src/library/`, the History/Bookmarks/Downloads pages) keeps the user's data behind
`frontend/src/shared/browser-data.ts`. Exact semantics: `docs/ENGINE-PROTOCOL.md` §6; module plan: `docs/WAVE-B.md`.
- **Tabs**: create, close, reorder, pin, duplicate, restore closed (muting is not available); each tab shows a
  proxied page or an internal `gnome://` page. Discarding (memory saver, the live-tab cap of §5.4) closes the engine
  tab and keeps its URL and back/forward entries; restoring re-creates it from them.
- **Omnibox**: URL normalization, search, `gnome://` pages, suggestions from history and bookmarks, and optional
  search-engine suggestions fetched through the proxy transport (`suggest`), never through GNOME's server.
- **Navigation**: loading state (indeterminate: there is no progress source), back/forward through GNOME's per-tab
  history, reload (also its second binding `hardReload`, labelled "Reload (second shortcut)": proxied responses do not come from
  the HTTP cache, by construction, not separately tested), stop; the engine badge and
  "open in the other engine"; an app-rendered error overlay with Retry (`tab.error`), also for navigations started in
  the page; a navigation watchdog that resynchronizes a tab with `tab.state` when an outcome event is missing.
- **New tabs and popups**: pages open tabs only through `tab.openRequest` (window.open, `target=_blank` links and
  forms); with a user gesture they open (in the background on request): the page's claim counts only together with
  the app document's own transient activation (verified in both browsers: a real click or key press in a proxied
  frame, nested or cross-site, activates the app document). Without one the `popups` site permission decides and
  blocked ones wait behind a toolbar indicator. At most 500 GNOME tabs per app page. `window.close()` closes only tabs
  a page opened.
- **Find in page**: the engine host searches the tab's same-origin proxied documents and highlights with the CSS
  Custom Highlight API (verified); **zoom** per tab, applied to the tab frame, with `browser.defaultZoom` for new
  tabs (verified); **fullscreen** of page elements, also from nested frames (verified); **print** and **select all**
  from GNOME's page menu (print verified headless only; in Firefox the print dialog is expected to freeze GNOME's UI
  while it is open, not tested with a real dialog, ENGINE-PROTOCOL §6.10). "Save link/image as" downloads through the
  engine host and the browser saves the file (both browsers since integration part 2: Firefox had refused the engine
  host's blob download through the app's `frame-src`, which now lists `blob:`).
- **Context menus** inside proxied frames: the engine host reports the target and engine-host viewport coordinates;
  the app shows its own menu, and every item is a click in GNOME's UI.
- **Keyboard shortcuts**: captured in the shell *and* forwarded from proxied frames, matched in both places with the
  same `src/lib/keys.ts` functions (layout-independent); a forwarded combo acts only on the active tab, and the
  privileged ones (opening or closing tabs, GNOME pages and dialogs, the address bar, bookmarks, fullscreen) only with
  the app document's transient activation and at most once a second (ENGINE-PROTOCOL §6.7).
- **Session restore** from real URLs and back/forward entries (never proxied URLs, which die with the engine host).
- **History** recorded from committed navigations (cross-document ones, and pushState changes beyond the fragment;
  never replaceState, traversals or reloads), capped per tab and per minute so a page cannot flood it, only while
  `browser.history.enabled`, and at most **100,000 visits** in total (the oldest go; checked every 500 new visits and
  at start). When the origin's storage quota is used up, recording a visit drops the oldest 5 % of the visits (at least
  500) and retries once, and the pages word quota errors so the user can act; a byte budget does not exist yet
  (PROGRESS "Deferred items"). **Bookmarks** with folders, the bar (the root's children; the root is a non-null
  sentinel because IndexedDB cannot index null), favorites for Home and Netscape-HTML import/export (always into a new
  folder). The sync adapters never upload a record the server would refuse (`library/wire.ts` mirrors the server's
  `validate.rs`; such a record stays local, the rest keeps syncing); on a last-writer-wins tie the server's copy of a
  bookmark wins. Deleting single visits or a recent range stays local (the API clears only "before"); the History
  page's "All time" can also clear the account copy (`DELETE /api/sync/history {all: true}`). Changes reach the
  other GNOME tabs over the app-origin BroadcastChannel `gnome:library`.
- **Downloads**: the browser's own download manager saves attachments and other responses it does not render, under
  their real file names (for a Scramjet download whose server names no file, the engine host adds a
  `Content-Disposition` with the name; without it the browser named the file after the encoded proxied URL); GNOME
  lists them (capped per engine host, and at most **1000 items** in the list: the oldest finished ones go) with
  streamed progress observed in the engine host and the SW, but cannot cancel or pause them, and downloads a page
  builds itself (`blob:`, `data:`) are not listed. Unfinished downloads of an app page that closed are found through
  its `localStorage` heartbeat (`gnome:library:page:<id>`, stale after 3 minutes) and become "no longer followed".
- **Permissions**: camera, microphone, geolocation and notifications are never available to proxied pages (their
  grant would belong to the whole proxy origin); popups are decided by the app; autoplay and fullscreen are
  enforced per site by the engine host through each tab frame's `allow` attribute, from the decisions the app sends
  with every GNOME-initiated load (never the per-site list), and only where the browser enforces them
  (`enforcedPermissions`: Chromium fullscreen and autoplay, Firefox fullscreen; the table is in
  `shared/site-rules.ts`, and the app keeps only what its own browser can enforce of the engine host's claim).
  Clipboard writes are not enforced in any browser (ENGINE-PROTOCOL §6.14).
- **Cookies and site data** of proxied sites (both engines' jars) are listed and cleared through the engine host;
  "clear on exit" runs at the next start of GNOME in a new browser tab (a browser that restores its session restores
  GNOME's tab too, which then does not count as a new start).

## 6. Games
Research: `docs/research/games-sources.md`; module plan and decisions: `docs/WAVE-C.md` (D2–D11, D19–D22, D24). The
catalog is stored server-side by the `gnome-catalog` crate (unified `games` table keyed on `(source, source_id)` with
the raw record, FTS5 search, keyset pagination, category mapping to the 14 GNOME categories, cross-source dedup,
anonymous daily play counts) and served by gnome-server's games module (`backend/src/games/`). Importers stream
page-by-page (never the whole catalog in memory), respect each source's rate limit and ETag, and hide games missing
from 3 complete syncs.
- **Sources**: the GamePix public feed (`sid=1`, the publicly offered default; 16,041 records, 15,722 listed on
  2026-11-23) and a curated manifest of open-source games are enabled by default. GameDistribution, Playgama,
  GameMonetize and Famobi importers are built but stay **disabled until the operator configures their
  publisher/affiliate ID** (their terms license embeds only to registered publishers). itch.io and js13kGames are
  discovery/link-out sources (`playable: false`, opened in a new tab, never framed). CrazyGames, Poki, Armor Games,
  Newgrounds and Kongregate are **not used** (framing blocked and/or forbidden by their terms). No catalog entry is
  fabricated: tests replay real feed captures (`gnome-server catalog import --replay`) or GNOME's own test game.
- **Jobs**: `catalog.import` (first tick 30 s after start, then every `GNOME_CATALOG_REFRESH_HOURS` per source),
  `catalog.rankings` (hourly; also purges the play counter's hourly dedup hashes), `catalog.policy` (every 5 min: the
  frame policy and the cached stats), `catalog.oss-fetch` (`GNOME_OSS_FETCH=auto`). A module start-up hook
  (`Module::prepare`, D21) prepares the catalog before any listener accepts; until it has run the routes answer `503`.
  The admin listener starts imports and OSS fetches, features or hides games, and shows the embed hosts (with the
  `pending` ones), the thumbnail cache and the OSS builds (`/admin/diagnostics` `catalog`, `games`).
- **Reads are public** in every access mode (D8): `GNOME_ACCESS_MODE` means "who may use the proxy". Hidden categories
  and "only games that work on touch screens" are applied by the server (`exclude=`, `mobile=1`, D11), so totals and
  pages stay right.
- **Player** (`/play/<slug>`): publisher embeds load as **direct cross-origin iframes** — never through
  Scramjet/UV/Wisp (proxying replaces the referrer, which networks treat as invalid traffic) and never ad-blocked,
  rewritten or overlaid. Every game is framed through its **wrapper document** `/play-frame/<slug>` on the app origin
  (D2, §4.3): no script, its own CSP whose `frame-src` names exactly that game's embed origin, one sandboxed iframe
  (popups may escape the sandbox for ad click-outs; COOP severs their opener). Which hosts may be framed is decided per
  game (D4): a fixed embed host of an enabled source, or a developer host the operator approved in
  `GNOME_GAMES_EMBED_HOSTS`; catalog data never adds a host, and a refused game shows "can't be played here" with a
  link to its source (`embed_allowed: false`). The shell's `frame-src` never lists embed hosts.
- **Before a network's first frame** (D24) the stage says "This game loads from <network>. <network> and its
  advertisers see your IP address and may set cookies." with **Play**; the choice is remembered per network in this
  browser (Clear browsing data → "Game network choices", or "Forget" on the Games page). OSS games need no notice.
  GNOME is not a consent tool: operators with EU visitors bring their own (README).
- **Open-source games** (D5, D6) are served by gnome-server from the **proxy origin** under `/oss/<slug>/` (two-origin
  mode only; in single-origin mode the `oss` source is disabled with a start-up warning), never with the app origin's
  privileges. Only manifest entries with a recorded review of their pinned commit are enabled (no storage clearing, no
  `innerHTML` from the URL or messages, no external loads); entries that need no storage run `isolated` (an
  opaque-origin sandbox). The pinned commit is downloaded from `codeload.github.com` through the SSRF-safe client and
  extracted with caps (regular files only) into `GNOME_OSS_GAMES_DIR` (`GNOME_OSS_MAX_MB`). Each game page shows its
  license, copyright, repository and commit, and links the LICENSE file. Reviewed and enabled on 2026-11-23: `2048`,
  `javascript-racer`, `javascript-breakout`, `bullethell` (isolated), `clumsy-bird`; disabled with the reason:
  `a-dark-room`, `hextris`, `hexgl` (review) and `particle-clicker`, `javascript-chess`, `a-blast` (CDN code, O10).
- **Thumbnails** go through `/api/thumb/:id` by default (D7): SSRF-safe client with the enabled sources' thumbnail
  hosts as allow-list, ≤ 2 MiB, the declared type must be an allowed raster type and match the magic bytes, a disk LRU
  (`GNOME_THUMB_CACHE_MB`, `0` = pass-through without storing). `GNOME_THUMB_PROXY=false` loads them from the source.
- **Hygiene**: a configurable trademark/knock-off blocklist marks matches `ip_risk` and hides them by default; titles
  and texts are plain text. `/ads.txt` is served from an operator file (`GNOME_ADS_TXT`, D22).
- **Favorites and recently played** stay in this browser (IndexedDB `games_favorites`, `games_recent`; D9): not
  synced; the page says so. The play counter dedups per session (or per IP /64) and hour and stores only a 16-byte
  hourly hash.
- **Frontend** (`src/games/`, `src/pages/games/`): the Games page (search, category chips, shelves Featured,
  Trending, Popular, New, Favorites, Recently played, and "All games" as a virtualized grid or list over keyset pages,
  at most 15,000 items kept), the detail page and the player (Fullscreen, the notice, the license panel for OSS games).

## 7. VPN
Research: `docs/research/mullvad-vpn.md`; module plan and decisions: `docs/WAVE-C.md` (D12–D18, D23, §6–§8). GNOME is a
website only, so the VPN feature is **browser-compatible gateway mode**: traffic loaded inside GNOME is routed through
operator-configured egress gateways (separate HolyWisp instances whose egress goes through a VPN tunnel the operator
set up on the server). Only pages opened in GNOME are routed — never system-wide protection, never the games (they
load directly from their publishers). No native/desktop companion is built (product decision: website only). VPN
credentials live only in the server operator's configuration and are never requested from end users.
- **Operator setup** (`services/vpn/README.md`, `profiles.example.toml`, `compose.example.yml`): per offered
  location, one HolyWisp instance on its own loopback port whose egress goes through the VPN (e.g. gluetun with
  HolyWisp in its network namespace, or HolyWisp's `proxy=socks5://…` through a tunnel). `GNOME_VPN_PROFILES` lists
  them (`id`, label, country/city, upstream). The operator runs the locations over connections they are authorized
  to share with the people who use the server; no provider is presented as usable for a multi-user service, and there
  is no provider branding. `config check` and start-up **warn** (D16) when profiles are offered in `open` mode, in
  `accounts` mode with open registration, or (a reminder) in `code` mode, unless the operator states
  `GNOME_VPN_EGRESS_SHARED_OK=true`.
- **Health** (`status` in `/api/vpn/locations` and `/api/health`): the `wisp.health` probe (TCP connect + WebSocket
  handshake + first Wisp frame to the profile's HolyWisp, every 60 s; failed or older than 3 min = `down`). It proves
  the location's instance answers, not that its exit works: a tunnel that is down fails closed.
- **Exit check** (D14, D15): only when the operator set a check service (`GNOME_VPN_CHECK_URL`, **empty by default**;
  optionally `GNOME_VPN_CHECK_URL_V6`), gnome-server checks each location's exit itself through that location's own
  HolyWisp (a minimal Wisp v1 client, TLS by rustls, one GET with the neutral `User-Agent: exit-check/1`, 15 s
  deadline), every `GNOME_VPN_CHECK_INTERVAL_MIN` ± 20 % (first checks spread over the whole interval) and on request
  (`POST /api/vpn/locations/:id/check`, at most once a minute per location). The result is `exit` in
  `/api/vpn/locations`, shown only to clients the access policy admits. **Exit checks never change the route or the
  connection state**: a failed check is a warning ("The exit check through <label> fails: <reason>"). Results are
  worded as what the service reported ("<service> reports <ip> in <country>"), never as proof.
- **The app** (`src/vpn/`, `src/pages/vpn/`): `vpnState()` polls `/api/vpn/locations` (60 s, backoff, paused while
  hidden) and is the browser's single status source. "Connected" rests on the app's own facts (D13): the route the app
  chose is that location's profile and the server reports it `up`; the engine host's transport report only refines
  `connecting`, and is labelled as forgeable. `vpn.mode` and `vpn.killSwitch` are **device-local** (D12): sync and
  imports never set them. **Automatic** (`preferredLocation: null`, D17) = the first location that is up, pinned for
  this app page while it stays up (a switch shows a toast naming both); a chosen location is never replaced (unusable →
  the kill switch blocks, else the default route). Auto-connect is decided inside the browser's start, before any tab
  goes live. The kill switch blocks proxied traffic while the location is down and forces WebRTC to `block`.
  `registerFeature('vpn')` runs in every build (D18), so the VPN page and Settings → VPN work even when no location is
  offered; the tab-strip chip shows "VPN · Blocked" or "VPN · Not in use" linking to `/vpn`, and the error overlay has
  an "Open VPN page" link.
- **Route-bound Wisp tickets** (D23, §4.6): the app mints a ticket for the chosen route and mints anew on every route
  change; the gateway accepts a ticket only on its own path and refuses older default-route tickets once a profile
  ticket was minted (and closes such open default-route connections), so a page cannot switch itself to the direct
  route. Connections on a previous *profile* route keep running until their page reloads; the VPN page counts those
  tabs ("<n> tabs may still use the previous route until you reload them"; O16).
- **This browser's check** (`vpn.verifyExit`, **off by default**, and only with a check service): after a connect or
  route change and on **Check again**, the engine host loads `verify_url` through the route (`vpn.verify`); the page
  says that a page that broke out of GNOME's browser engine can fake this answer, warns when it differs from the
  server's check, and never calls agreement a confirmation.
- **VPN page** (`/vpn`): status card (Off, Connecting, Connected, Blocked, Not in use, with the exit warning),
  Connect / Disconnect, the Exit check card (server check, this browser's check, Check again), the Locations card,
  the Behaviour card (kill switch, connect automatically, check this browser's exit) and a privacy card. A real VPN
  tunnel end to end is `[unproven]` (WAVE-C O7): the e2e tests use a second HolyWisp as a stand-in location.

## 8. Build & deployment
Frontend: Vite production build (minify, tree-shake, CSS minify via Lightning CSS, hashed assets, no public source
maps), then `frontend/scripts/postbuild.mjs` (Wave D): vendor `.map` files dropped in release builds, precompressed
`.br` (and `.gz` for GNOME's files) siblings written only when they save ≥ 10 % and verified by decompression, the
`.gnome/files.json`/`build.json` manifests with `SOURCE_DATE_EPOCH`, `licenses/THIRD-PARTY-NOTICES.txt`, and the
build-time budgets of `scripts/budgets.json`. No obfuscation (D10: minify only). Third-party engine files are copied
unmodified with their licenses. Image recompression (D12) is not done yet. Releases: `scripts/release.sh` builds, in
pinned Docker images, a static musl `gnome-server` per architecture (x86_64, aarch64 cross-compiled with
tonistiigi/xx, no binfmt), the release `dist/`, HolyWisp and the licenses bundle into
`gnome-<v>-linux-<arch>.tar.gz`, plus the source tarball, `SHA256SUMS`, optionally a signature
(`ssh-keygen -Y sign` or GnuPG), the images and a no-cache reproducibility check. Deployment (`deployment/`,
[docs/DEPLOYMENT.md](DEPLOYMENT.md)): the FROM-scratch `gnome-server` image (user 65532, health check), the compose
stack (only Caddy publishes ports; every service read-only with `cap_drop: ALL`), the Caddyfile (`max_header_size 4MB`,
a strict CSP on Caddy's own answers, `Cookie` removed on the proxy hostname, a log without client addresses or query
strings), the systemd unit (`DynamicUser`, `systemd-analyze security` 1.4), secrets as `_FILE` files, Raspberry Pi 4
notes. Request limits (connection caps with IPv6 prefix tiers, exact head limits per listener and peer trust, the
large-head and large-answer budgets, sync quotas) live in `backend/src/limits.rs` and are listed in backend/README.md
and docs/API.md. Backend: `cargo build
--release` with `lto = "fat"`, `codegen-units = 1`, `strip = true`, and `panic = "unwind"` kept on purpose (a panicking request or task becomes a 500 / is contained instead of aborting every live Wisp connection); the deployment pieces are listed above.

Frontend development (`frontend/`): `npm run dev` (Vite; proxies `/api` to `GNOME_DEV_BACKEND`, default
`http://127.0.0.1:8080`, and answers `/api/*` with a plain `502` while nothing listens there — the app then reports the
server as unreachable and keeps working locally), `npm run check` (svelte-check + `tsc --noEmit`), `npm test` (Vitest),
`npm run build`, and `npm run qa:visual` (Playwright visual QA of the shell: screenshots + console/accessibility/overflow
checks → `docs/screenshots/foundation/`; env `GNOME_QA_URL`, `GNOME_QA_OUT`, `GNOME_QA_BROWSER=chromium|firefox`,
`GNOME_QA_EXECUTABLE`, `GNOME_QA_ONLY`; `playwright-core` is pinned to 1.64.0, the release matching the cached
Chromium r1248 / Firefox r1555 builds). The dev server also serves two QA-only pages that are not part of the
production build (whose inputs are `index.html` and `engine/index.html`, §3): `/dev/gallery.html` (every design-system component; the harness
drives each one's keyboard path, touch hit targets and an axe-core WCAG 2.2 AA audit) and `/dev/virtual-grid.html`
(a 10,000-card `VirtualGrid` scroll benchmark: mount time, DOM size, frame times).

## 9. Licensing
| Component | License | How GNOME complies |
| --- | --- | --- |
| Scramjet 2.0.67-alpha.2 / scramjet-controller 0.0.14 / libcurl-transport 2.0.6 and 1.5.2 / epoxy-transport 3.0.2 and 2.1.29 (`proxy-bootstrap` is not used) | AGPL-3.0-only | Served unmodified from `/vendor/` with license texts (the AGPL-3.0 text for the packages whose tarball ships none, and the licenses of what their bundles include, e.g. libcurl.js); About page links to exact upstream sources and to `GNOME_SOURCE_URL` (AGPL §13). Obfuscation is opt-in and never applied to these files. |
| Ultraviolet 3.2.10 (`@titaniumnetwork-dev/ultraviolet`) | AGPL-3.0 (its `package.json` says MIT, but the tarball ships the AGPL-3.0 text; GNOME follows the stricter text, `VENDOR_PACKAGES`) | Served unmodified from `/vendor/ultraviolet/` with that LICENSE; covered by the AGPL §13 offer like Scramjet |
| bare-mux 2.1.9 (`@mercuryworkshop/bare-mux`) | MIT (its LICENSE file; `package.json` names none) | Served unmodified from `/vendor/bare-mux/` with its license text |
| HolyWisp | ISC | License text shipped |
| @ghostery/adblocker | MPL-2.0 | Used unmodified |
| Filter lists (EasyList etc.) | GPLv3 / CC BY-SA 3.0 (varies) | Downloaded from upstream at runtime, attributed in UI |
| Sapphire | **no license** | Not bundled; architecture studied only |
| Open-source games (`crates/catalog/oss-games.toml`: 2048, javascript-racer, javascript-breakout and bullethell MIT, clumsy-bird GPL-3.0) | each game's own license | Not part of GNOME's build: fetched by gnome-server at the pinned commit from the upstream repository and served unmodified; every game's detail page shows its license, copyright, repository and commit and links its LICENSE file (About → Licenses says so) |
| Publisher games (GamePix and the opt-in networks) | the networks' publisher terms | Embedded directly, never proxied, rewritten, overlaid or ad-blocked; the operator configures each network (README "Games catalog") |
| Mullvad app | GPL-3.0 | No code used; no branding; GNOME calls no provider service by default |
| Lucide icons | ISC | Attributed |
| Fonts (Geist, Fraunces, Inter, Atkinson Hyperlegible Next) | OFL-1.1 | Attributed |
