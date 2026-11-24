<p align="center"><img src="logo.png" alt="GNOME logo" width="128"></p>

# GNOME

**New here? Start with [START-GUIDE.md](START-GUIDE.md)**: how to run everything on a development PC and on an
Ubuntu 24.04 server.

GNOME is a self-hostable website that has a web proxy, a browser that runs inside a browser tab, a games page and a
VPN page. You run one Rust server, `gnome-server`, plus a small Wisp relay called HolyWisp. People open GNOME in an
ordinary browser and browse other sites inside it. GNOME is a website only. There is no native app and no
browser-extension build. Its proxy engines are Scramjet (primary) and Ultraviolet (fallback). Their traffic goes
through HolyWisp, a Wisp server written in C. Accounts, settings sync and the admin listener are part of
`gnome-server`. The interface is TypeScript and Svelte 5.

> **Status on 2026-11-24.** GNOME is still being built.
> - **Built and tested:** the proxy (Scramjet with Ultraviolet fallback) and the browser (tabs, history, bookmarks,
>   downloads, session restore, settings), with the restyled UI; the built-in extensions (ad and tracker blocking,
>   privacy protection, the cookie manager, cosmetic filtering; Wave B step 3, 2026-11-21).
> - **Wave C, done on 2026-11-24:** the Games page, game details and the player (GamePix and reviewed
>   open-source games by default, the other networks with the operator's publisher IDs), and the VPN page (Connect /
>   Disconnect, locations, the kill switch, the server's exit check when the operator sets a check service). Each has
>   its e2e suites in Chromium and Firefox; the final run's results and its open items are in
>   [docs/PROGRESS.md](docs/PROGRESS.md). A real VPN tunnel has not been tested here (only a stand-in location).
> - **Wave D, done on 2026-11-24 (a quick, lean pass):** the production build pipeline and a reproducible,
>   checksummed release (`scripts/release.sh`, x86_64 and aarch64), the deployment files (a FROM-scratch Docker
>   image, a compose stack behind Caddy, a hardened systemd unit, Raspberry Pi 4 notes: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)),
>   connection caps, request-head limits and sync storage quotas, supply-chain audits ([docs/AUDIT.md](docs/AUDIT.md))
>   and a benchmark harness against a Node.js baseline ([docs/BENCHMARKS.md](docs/BENCHMARKS.md): short-run numbers
>   only; the long record run and the optimization loop were skipped and are open).
> - **Not built yet:** the final review (Wave E).
>
> The checklist and plan are in [docs/PROGRESS.md](docs/PROGRESS.md).

## Contents

1. [Features and their status](#features-and-their-status)
2. [Requirements](#requirements)
3. [Quick start](#quick-start-linux)
4. [Turning on every feature](#turning-on-every-feature)
5. [Using GNOME](#using-gnome)
6. [Development](#development)
7. [Production notes](#production-notes)
8. [Project layout, docs, licenses](#project-layout)

## Features and their status

Status terms: **Works** = built and covered by tests or a run. The proxy and browser rows marked Works were re-tested
through the restyled UI on 2026-11-19: the full e2e run in Chromium and Firefox (every suite, both engines, both
transports), and real sites browsed through GNOME's own UI with both engines in both browsers (example.com,
Wikipedia, GitHub, Hacker News, MDN, a login form, a Wikimedia Commons video, 1 MB and 20 MB downloads). **Partial** =
works, with the limits named. **Server only** = the server part works, but the interface has no control for it yet.
**Not built** = planned for the wave named.

| Feature | Status today | How to use it | Details |
| --- | --- | --- | --- |
| Proxy engine: Scramjet (primary) | Works | Type an address or a search in the address bar on `/browse` | [ENGINE-PROTOCOL](docs/ENGINE-PROTOCOL.md), [research](docs/research/scramjet.md) |
| Proxy engine: Ultraviolet (fallback) | Works | Used automatically when Scramjet fails to load a page (see [Engines](#engines-fallback-and-transports)). The switch itself is e2e-tested (a Scramjet that fails to start moves every tab to Ultraviolet); the notice GNOME then shows is not tested yet | [research](docs/research/ultraviolet.md) |
| Manual engine choice | Works | Settings → Advanced → Proxy engine: Automatic, Scramjet or Ultraviolet | |
| Active engine shown | Works | Engine badge in the toolbar (`SJ` / `UV`), with versions in its popover and in About → Browser engine | |
| HolyWisp / Wisp transport | Works | `holywisp` on `127.0.0.1:6001`. The browser connects through the gateway at `/wisp/` with a short-lived ticket | [services/holywisp](services/holywisp/README.md) |
| Transports libcurl / epoxy | Works | Settings → Advanced → Transport (default libcurl) | Content blocking is fully tested over libcurl only. Over epoxy, a blocked `fetch()` can hang instead of failing (open) |
| Custom Wisp servers | Works (operator opt-in) | `GNOME_ALLOW_CUSTOM_WISP=true`, then Settings → Advanced → Custom Wisp servers | |
| Rust backend (`gnome-server`) | Works | `gnome-server serve`, with the app, proxy and admin listeners | [backend/README.md](backend/README.md), [API](docs/API.md) |
| Two-origin isolation and other security features | Works | `GNOME_PROXY_BIND` (local) or `GNOME_PROXY_ORIGIN` + `GNOME_PUBLIC_ORIGINS` (production); see [Security features](#security-features) | [ARCHITECTURE §4.6](docs/ARCHITECTURE.md) |
| Browser: tabs, tab strip, toolbar, address bar | Works | `/browse`; right-click a tab for its menu; Alt+T opens a new tab | |
| Browser: find, zoom, fullscreen | Works | Mod+F, Alt+= / Alt+- / Alt+0, Alt+Shift+F | |
| Browser: print | Partial | Toolbar menu → Print…. Tested headless only. In Firefox, GNOME is expected to freeze while the print dialog is open (not tested with a real dialog) | |
| Browser: context menus | Works | Right-click in a page (Shift+right-click gives the native menu); "Save link as…" and "Save image as…" save through your browser | |
| Browser: pop-ups as tabs, pop-up blocking | Works | Automatic. A blocked pop-up shows an indicator in the toolbar. One click in a page opens at most one tab; the page's other pop-ups wait in the indicator | |
| Browser: site permissions | Partial | Settings → Privacy → Default permissions / Site permissions (see [limits](#known-limitations)) | |
| Browser: WebRTC block | Partial | Settings → Privacy → WebRTC (default Block). A site built to get around it can still leak your IP | |
| History | Works | `/history` (Alt+H); Settings → Browser → Save browsing history / Keep history for | |
| Bookmarks (bar, page, import/export) | Works | Alt+B, `/bookmarks` (Alt+Shift+B); imports and exports Netscape HTML | |
| Session restore | Works | Reloading keeps your tabs. Settings → Browser → On start-up | |
| Downloads | Works | Your own browser does the download and GNOME lists it: `/downloads` (Alt+J). Downloads cannot be paused or cancelled | |
| Keyboard shortcuts | Works | [List below](#keyboard-shortcuts); change them in Settings → Shortcuts | |
| Settings (local, import/export JSON) | Works | `/settings` (Alt+,) | |
| Sessions (anonymous and signed-in) | Works | Automatic: `/api/session`, `/api/auth/*` | [API](docs/API.md) |
| Accounts and sync (settings, bookmarks, history) | Works | Settings → Account & sync. The operator controls it with `GNOME_ACCOUNTS` and `GNOME_REGISTRATION` | [API](docs/API.md) |
| Access modes: open / code / accounts | Works | `GNOME_ACCESS_MODE`, `GNOME_ACCESS_CODE` | [below](#access-modes-and-accounts) |
| Admin diagnostics and metrics | Works | `http://127.0.0.1:9091/admin/` (loopback by default) | [below](#admin-diagnostics-logging-and-metrics) |
| VPN gateway (server-side egress) | Works (tested with a stand-in location; a real tunnel is not tested) | `GNOME_VPN_PROFILES` + one HolyWisp per exit location; route-bound Wisp tickets; optional exit checks with `GNOME_VPN_CHECK_URL` | [services/vpn](services/vpn/README.md), [below](#vpn-gateway-profiles) |
| VPN page (location, kill switch, exit check) | Works (Wave C; e2e in Chromium and Firefox with both engines) | `/vpn`: Connect / Disconnect, Automatic or a chosen location, "Block if the location is down", the server's exit check and an optional check from this browser; Settings → VPN | [ARCHITECTURE §7](docs/ARCHITECTURE.md) |
| Filter-list mirror (server) | Server only | Refreshed automatically, or with `gnome-server filters refresh`; served at `/api/filters` | [below](#filter-lists) |
| Ad blocker, tracker blocker | Works (Wave B step 3; e2e in Chromium and Firefox with both engines, 2026-11-21) | On by default. Blocks requests to ad and tracker servers on sites you open in GNOME, with the filter lists the server mirrors. The toolbar shield shows the count and pauses blocking for one site; Settings → Extensions and `/extensions` turn lists and blockers on or off | [docs/WAVE-B3.md](docs/WAVE-B3.md), [ARCHITECTURE §5.5](docs/ARCHITECTURE.md) |
| Privacy protection | Works (same tests) | Sends Global Privacy Control, cuts the Referer header, removes tracking parameters from pages you open (Settings → Privacy) | About → Content blocking lists what it does not cover |
| Cookie manager | Works (same tests) | Blocks third-party cookies by default; per-site rules (allow, until GNOME closes, block); lists and deletes cookies of both engines on `/extensions` → Cookies | |
| Cosmetic filtering | Works (same tests) | Hides ad frames and page clutter, runs the lists' scriptlets; cookie-notice and annoyance lists are opt-in | |
| Games catalog (server) | Works (Wave C) | Imported automatically (GamePix 30 s after start, then daily; reviewed open-source games fetched from GitHub); `gnome-server catalog import|stats|fetch-oss`; `/api/games*` | [below](#games-catalog), [crates/catalog](crates/catalog/README.md) |
| Games page: search, categories, trending, recently added, popular, featured, favorites, recently played; game details and player | Works (Wave C; e2e in Chromium and Firefox) | `/games`, `/games/<slug>`, `/play/<slug>`. Games load directly from their publishers (never proxied); a notice comes before a network's first game. Favorites and recently played stay in this browser | [research](docs/research/games-sources.md) |
| Production build optimisation | Works (Wave D; image recompression not done) | `npm run build:release`: minified, tree-shaken, content-hashed, precompressed (`.br`/`.gz`), no public source maps, a third-party notices file; no obfuscation (D10). `npm run release:check` verifies a release `dist/` | [DEPLOYMENT](docs/DEPLOYMENT.md) |
| Release artifacts | Works (Wave D) | `scripts/release.sh`: static musl `gnome-server` + HolyWisp + the web app per architecture (x86_64, aarch64), a source tarball, `SHA256SUMS`, optional signature | [DEPLOYMENT](docs/DEPLOYMENT.md) |
| Supply-chain audits | Works (Wave D) | `scripts/audit.sh` (cargo-deny, npm audit with a shipped/build-only policy, vendored wasm versions, pinned images) | [AUDIT](docs/AUDIT.md) |
| Connection caps, head limits, sync quotas | Works (Wave D) | `GNOME_MAX_CONNECTIONS`, `GNOME_MAX_CONNS_PER_IP`, `GNOME_MAX_INFLIGHT_PER_IP`, `GNOME_MAX_INFLIGHT_HEAD_MB`, `GNOME_SYNC_QUOTA_MB`, `GNOME_SYNC_TOTAL_MB` | [backend/README.md](backend/README.md) |
| Deployment files (Docker image, compose, Caddy, systemd, Raspberry Pi notes) | Works (Wave D; tested on this PC: the image, the compose stack with a throwaway CA, `systemd-analyze verify`/`security`; not tested: real DNS and ACME, booting the units, Pi hardware) | [START-GUIDE.md](START-GUIDE.md), `deployment/` | [DEPLOYMENT](docs/DEPLOYMENT.md) |
| Benchmarks | Partial (Wave D: harness, Node.js and wisp-js baselines, short-run numbers only) | `node bench/run.mjs --preset quick` | [BENCHMARKS](docs/BENCHMARKS.md), [bench/](bench/README.md) |
| Mobile layout | Works | Below 760 px wide: bottom bar (Home, Browser, Games, VPN, More), compact toolbar, tab switcher | |
| Safari / WebKit | Not tested | Every test runs in Chromium and Firefox only | |

## Requirements

- **Linux on x86_64** (tested). aarch64 (for example a Raspberry Pi 4) is a target: `scripts/release.sh` builds static
  aarch64 binaries of `gnome-server` and HolyWisp, which have only run under QEMU user-mode here, not on arm64
  hardware.
- **Rust 1.89 or newer** (the declared minimum; tested with 1.99.1), plus a **C compiler** (`cc`/`gcc`/`clang`). The
  C compiler builds the bundled SQLite and `ring`. You do not need a system SQLite or OpenSSL.
- **Node.js 22.12 or newer** with npm (tested with Node 26.13 / npm 12.2). Node is only needed to build the
  frontend, not to run it.
- **HolyWisp binary** in `services/holywisp/build/<arch>/holywisp`. That directory is not part of the source tree:
  `services/holywisp/fetch-build.sh` builds static binaries for both architectures into it, and needs Docker with
  buildx, git and network access. See [services/holywisp/README.md](services/holywisp/README.md).
- **Docker with buildx** only for images, releases (`scripts/release.sh`) and the compose stack; not for development.
- **Browsers** for using GNOME: current Chromium-based browsers and Firefox (the only ones tested). The server needs
  network access to the sites people browse.

## Quick start (Linux)

This starts the full stack on loopback: HolyWisp on `127.0.0.1:6001`, the app on `127.0.0.1:8080`, the proxy origin
on `127.0.0.1:8081` and the admin listener on `127.0.0.1:9091`. Run every command from the repository root.

**1. Build the frontend.** `gnome-server` serves `./frontend/dist` by default. An old build there with no
`engine/`, `sw.js` or `vendor/` gives you the interface but no proxy, so always rebuild.

```sh
cd frontend && npm ci && npm run build && cd ..
```

**2. Build the server.** This takes a few minutes on a cold cache (3 min 41 s with 3 jobs here).

```sh
cargo build --release -p gnome-server
```

**3. Start HolyWisp** (terminal 1). `gnome.conf` listens on `127.0.0.1:6001`, the default `GNOME_WISP_UPSTREAM`.

```sh
services/holywisp/build/$(uname -m)/holywisp --config services/holywisp/gnome.conf
```

**4. Start gnome-server** (terminal 2) with two origins on loopback:

```sh
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 ./target/release/gnome-server serve
```

**5. Open http://127.0.0.1:8080/** and type an address (for example `example.com`) in the address bar.

- Use `127.0.0.1` exactly, not `localhost`. The app origin is derived from `GNOME_BIND`, and the proxy origin only
  allows itself to be framed by that origin (`frame-ancestors`).
- The database, the generated secret key and the filter lists are written to `./data` (`GNOME_DATA_DIR`).

**What you should see.**

- The `gnome-server` log shows (abridged: timestamps, levels and targets left out; `engine_host=false` means the
  build in `frontend/dist` is stale, so rebuild it):

  ```
  static index ready dir=… files=… precompressed=0 in_memory_kib=… engine_host=true
  public listener ready addr=127.0.0.1:8080 version="0.1.0" proxy_origin="http://127.0.0.1:8081"
  proxy listener ready addr=127.0.0.1:8081 proxy_origin="http://127.0.0.1:8081"
  admin listener ready addr=127.0.0.1:9091 token=false
  Wisp upstream is up upstream=direct addr=127.0.0.1:6001
  ```

- These checks answer as shown:

  ```sh
  curl -s http://127.0.0.1:6001/health        # {"status":"ok"}             (HolyWisp)
  curl -s http://127.0.0.1:8080/api/health    # {"status":"ok",...,"wisp":{"direct":"up"}}
  curl -s http://127.0.0.1:8080/api/config    # ..."proxy":{"origin":"http://127.0.0.1:8081","isolated":true}...
  ```

- In the browser, the page loads in a tab and the engine badge next to the address bar reads `SJ` (Scramjet).

**Stop:** press Ctrl+C in each terminal. `gnome-server` drains connections for up to 10 s and exits at once on a
second Ctrl+C.

**Ports in use?** Change `GNOME_BIND`, `GNOME_PROXY_BIND` and `GNOME_ADMIN_BIND`. For HolyWisp, start it with
`--port N` and set `GNOME_WISP_UPSTREAM=127.0.0.1:N`.

**Without `GNOME_PROXY_BIND` or `GNOME_PROXY_ORIGIN`**, the server runs in single-origin mode and logs a warning:
proxied pages then run on the app origin and could read GNOME's local data. No test covers browsing in this mode.
Use two origins.

## Turning on every feature

Configuration comes from `GNOME_*` environment variables. An optional TOML file named by `GNOME_CONFIG` can hold the
same settings, and the environment wins over the file. In the file, keys are the variable names without `GNOME_`,
lowercased (`bind`, `proxy_bind`, `access_mode`, …), and lists are TOML arrays. Unknown keys are fatal.
`gnome-server config check` validates everything and prints each effective value with where it came from (secrets
are redacted). It exits 2 on an invalid configuration and creates no files. It also warns when `GNOME_STATIC_DIR`
has an `index.html` but no `engine/index.html`, `sw.js` or `vendor/` (a UI-only or stale build, which cannot load
proxied pages). Always run it after a change.

```sh
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 ./target/release/gnome-server config check
```

The full list of variables (75, plus `GNOME_CONFIG`) with defaults and ranges is in
[backend/README.md](backend/README.md) and [docs/ARCHITECTURE.md §4.2](docs/ARCHITECTURE.md); `config check`
prints all of them. Other CLI commands: `migrate`, `user create|reset-password`, `filters refresh|status`,
`catalog import|stats|fetch-oss`, `health` (asks the running server, exit 0 = ok), `admin get /admin/<path>` (reads the
local admin listener with the configured token), `db backup <new file>` (a consistent snapshot, mode 0600, while the
server runs), `version` (with the build id).

**Wave D variables.** Secrets can come from files: `GNOME_ADMIN_TOKEN_FILE`, `GNOME_ACCESS_CODE_FILE`,
`GNOME_SECRET_KEY_FILE` (absolute paths, at most 64 KiB, one trailing newline removed; never logged; use these in
production, for example with systemd credentials or Docker secrets). Limits: `GNOME_MAX_CONNECTIONS` (4096, lowered
to fit the descriptor limit), `GNOME_MAX_CONNS_PER_IP` (256 per IPv4 address or IPv6 /64, untrusted peers),
`GNOME_MAX_INFLIGHT_PER_IP` (256 requests in flight per client, ×4 per IPv6 /56, ×16 per /48),
`GNOME_MAX_INFLIGHT_HEAD_MB` (64: the budget for request heads over 64 KiB), `GNOME_SYNC_QUOTA_MB` (64 per account)
and `GNOME_SYNC_TOTAL_MB` (1024 for all accounts). `GNOME_COOKIE_HYGIENE` (`app` or `registrable`) chooses which
cookies the app clears that proxied pages planted for its hostname.

**A fresh server contacts game hosts by itself.** With the defaults, `gnome-server serve` imports the GamePix feed
30 s after start (then every 24 h; about 16,000 games in about 3 minutes) and downloads the reviewed open-source game
builds from GitHub (`codeload.github.com`) when the server has a proxy origin. `GNOME_CATALOG_REFRESH_HOURS=0` stops
the scheduled feed imports (only `catalog import` or the admin listener start one), and `GNOME_OSS_FETCH=manual`
stops the automatic OSS downloads (only `catalog fetch-oss`). `GNOME_CATALOG_SOURCES=none` turns the games off. Run `gnome-server <command> --help` for details. Exit codes are 0 for OK, 1 for a runtime failure and 2
for a configuration or usage error.

### Security features

These are built in and covered by tests. The defaults suit most instances; behind HTTPS, also set `GNOME_HSTS=true`.

- **Two origins** (app and proxy), and the admin listener on its own loopback port
  ([Admin](#admin-diagnostics-logging-and-metrics)).
- **Wisp tickets:** HMAC-signed, valid for 1 h at most (`GNOME_WISP_TICKET_TTL_S`), for Wisp only.
- **CSRF checks:** every request other than GET/HEAD needs `X-GNOME-Request: 1` and, if it has one, an allowed `Origin`.
- **Rate limits and login backoff:** `GNOME_RATE_LIMIT_SCALE` (default `1.0`; `0` turns rate limiting off).
- **Wisp connection caps:** `GNOME_MAX_WS_PER_IP` (32) and `GNOME_MAX_WS_PER_SESSION` (16).
- **Content-Security-Policy:** `GNOME_CSP` (`on`, `report-only` or `off`) for the interface; `GNOME_PROXY_CSP` adds a
  second policy to engine-host documents and can only restrict. `GNOME_HSTS` (default `false`) sends HSTS on HTTPS.
- **Cookies:** `Secure` with `__Host-` names (`GNOME_COOKIE_SECURE`: `auto`, `true` or `false`).
- **Passwords:** Argon2id (`GNOME_ARGON2_MEMORY_KIB`, default 19456). The signing key is `GNOME_SECRET_KEY`, or
  `secret.key` generated in the data directory.
- **Outbound requests** made by the server (filter lists) go through `gnome-net`, which refuses private addresses.
- **HolyWisp egress policy** (`gnome.conf`): private, loopback and link-local destinations, blocked ports and UDP are
  refused (checked by `services/holywisp/tests/smoke.sh`).

Tuning: `GNOME_WORKERS` (default: one per CPU) and `GNOME_DB_READERS` (default 4).

### Access modes and accounts

| Variable | Default | Values |
| --- | --- | --- |
| `GNOME_ACCESS_MODE` | `open` | `open` (anyone can browse) · `code` (an access code is required) · `accounts` (only signed-in users can browse) |
| `GNOME_ACCESS_CODE` | — | Required in `code` mode, 4–256 characters. Codes under 8 characters cause a warning |
| `GNOME_ACCOUNTS` | `true` | Accounts and sync (`/api/auth/*`, `/api/sync/*`). `accounts` mode requires `true` |
| `GNOME_REGISTRATION` | `open` | `open` or `closed`. When closed, only the CLI can create users |

- **`code` mode:** the first browsing attempt opens an "Access code required" dialog; registering also asks for it.
- **`accounts` mode:** visitors see "Sign in to keep browsing", which leads to Settings → Account & sync.
- **Creating the first admin user.** No user becomes admin automatically; the CLI is the only way:

  ```sh
  ./target/release/gnome-server user create alice --admin            # prompts twice for the password
  echo 'a-long-password' | ./target/release/gnome-server user create alice --admin --password-stdin
  ./target/release/gnome-server user reset-password alice            # also signs alice out everywhere
  ```

  - Usernames are 3–32 characters of `[a-zA-Z0-9_.-]`. Passwords are 10–256 characters.
  - The CLI uses the same `GNOME_DATA_DIR` as the server and works while the server is running.
  - Today the admin flag is only stored and shown. No page checks it. Operators use the
    [admin listener](#admin-diagnostics-logging-and-metrics) instead.

### Engines, fallback and transports

- **Operator:** `GNOME_ENGINES` (default `scramjet,ultraviolet`; `uv` is accepted as an alias) and
  `GNOME_ENGINE_DEFAULT` (default `scramjet`, which must be listed in `GNOME_ENGINES`).
- **User:** Settings → Advanced → **Proxy engine** (Automatic by default, Scramjet or Ultraviolet; choosing an
  engine turns off automatic fallback), **Retry on the other engine** (on) and **Transport** (libcurl or epoxy).
- **Automatic fallback.** When Scramjet fails to load a page at the engine level (an error or a timeout, never an
  HTTP error page), GNOME retries a GET/HEAD navigation once on Ultraviolet and copies the cookies across first. It
  never re-sends a POST. The next navigation you start uses Scramjet again.
- **Switching by hand:** "Open with <other engine>" in the error overlay, "Reload with …" in the badge popover.

### Custom Wisp servers

`GNOME_ALLOW_CUSTOM_WISP=true` lets users add their own `ws://`/`wss://` Wisp servers in Settings → Advanced →
Custom Wisp servers. When it is off, that row explains why it is unavailable. Custom servers bypass this server's
gateway, its access rules, the VPN profiles and part of the leak protection, and `config check` warns about this. A
VPN gateway route always wins over custom servers. GNOME uses the servers in order: before it builds a connection to
one it opens a test socket, so a server that is down is skipped before your first page loads, and the engine status
says "Your Wisp server does not answer" (retrying with a backoff) when none of them answers.

### VPN gateway profiles

GNOME's VPN is **server-side gateway egress only**. Pages opened **inside GNOME** can leave the server through a VPN
tunnel that you, the operator, set up on the server. The user's device, its other apps and tabs, GNOME's own
interface and the games are not routed through it. Nothing is installed on users' devices. GNOME is not affiliated
with Mullvad or any other VPN provider.

1. Set up a tunnel and **one HolyWisp instance per exit location**, using recipe A (gluetun with Docker) or recipe B
   (host WireGuard with `holywisp@<id>.service`) in [services/vpn/README.md](services/vpn/README.md). Read its
   section on terms first. Run the locations only over connections you are authorized to share with the people who
   use your server. Mullvad's terms, for example, forbid using the service to provide a VPN-like service to others,
   so with such a provider offer VPN locations only on an instance used by you and your household. GNOME's access
   modes do not change what a provider's terms allow.
2. Describe the locations in a TOML file (format and rules: [services/vpn/profiles.example.toml](services/vpn/profiles.example.toml)):

   ```toml
   [[profile]]
   id = "se-got"                    # [a-z0-9-]{1,32}; "direct" is reserved
   label = "Sweden · Gothenburg"
   country_code = "se"
   country = "Sweden"
   city = "Gothenburg"
   wisp_upstream = "127.0.0.1:6002" # internal host:port of that location's HolyWisp, never "localhost"
   ```

3. Start the server with `GNOME_VPN_PROFILES=/path/to/profiles.toml`, and restart it after each edit. Each profile is
   served at `/wisp/p/<id>/` on the proxy origin and is health-checked every 60 s. It shows up in
   `GET /api/vpn/locations`, `/api/health`, `/admin/diagnostics` and on the VPN page.

**Who may use it.** `config check` and start-up print a warning when locations are offered to anyone: in `open` mode,
in `accounts` mode with `GNOME_REGISTRATION=open` (as public as open mode), and, as a reminder, in `code` mode (an
access code can be passed on). Set `GNOME_VPN_EGRESS_SHARED_OK=true` only if your egress's terms allow every person
who can use the instance; it silences the warning.

**The VPN page** (`/vpn`). Users press **Connect** to route the pages they open in GNOME through Automatic (the first
location that is online, kept while it stays online) or a location they chose; **Disconnect** goes back to the
server's own connection. The connection switch and "Block if the location is down" are kept in each browser only:
account sync and imported settings never change them. With the kill switch on, pages stop loading while the location
is down instead of using the server's own connection. Tabs already open when the location changes keep their old
route until they are reloaded; the page counts them. Wisp tickets are bound to the route the browser chose, so a page
cannot move itself back to the server's own connection.

**Exit checks (optional, off by default).** GNOME calls no check service unless you set one. With
`GNOME_VPN_CHECK_URL=https://<your check endpoint>` (HTTPS, answering JSON with `ip`, `country`, `city`), gnome-server
checks each location's exit through that location's own HolyWisp every `GNOME_VPN_CHECK_INTERVAL_MIN` minutes (15,
randomly spread) and when a user presses **Check again**; `GNOME_VPN_CHECK_URL_V6` adds the same check through an
IPv6-only name. A self-hosted check endpoint is described in
[services/vpn/README.md "A check endpoint you run yourself"](services/vpn/README.md#a-check-endpoint-you-run-yourself)
(its Caddy and nginx examples have not been run here). Using a provider's public check page automatically needs that
provider's permission. A failed check is a warning on the VPN page; it never changes the route. Users can also turn
on "Check this browser's exit" (off by default), which asks the same service through their browser's route. Neither
check is proof: they report what the service saw.

**What works today.** Gateway routing, health checks, the VPN page, route-bound tickets and the exit check, tested
with a stand-in HolyWisp with no tunnel behind it (it exits from the server's own address: a test, not a VPN) and a
local check fixture. A real VPN tunnel has not been tested here.

### Filter lists

`gnome-server` mirrors 12 built-in content-blocking filter lists (EasyList, EasyPrivacy, uBlock filters, AdGuard URL
Tracking, Peter Lowe's list, cookie lists, …) plus uBlock Origin's redirect resources and scriptlets (13 entries),
and serves them at `/api/filters`. GNOME's built-in extensions (ad blocker, tracker blocker, privacy protection,
cookie manager, cosmetic filtering) download them from there into each browser, where GNOME compiles them; the
server builds no filter engine. Users turn the extensions and each list on or off in Settings → Extensions or on the
Extensions page (`/extensions`); the toolbar shield pauses blocking for one site. About → Licenses lists every list
with its publisher and license.

- **Automatic refresh.** `GNOME_FILTERS_REFRESH_HOURS` (default 24; `0` turns off automatic fetching). A list's own
  `! Expires` wins, and the interval is clamped to 4 h–7 d.
- **Manual refresh.** `gnome-server filters refresh [IDS...]` (exits 1 if any list failed), `filters status`, or
  the admin listener's `POST /admin/filters/refresh`.
- **Your own changes.** `GNOME_FILTER_LISTS_FILE=/path/to/lists.toml` adds lists, overrides fields of a built-in list
  or disables one. The format is documented at the top of `backend/src/filters/registry.rs`.

  ```toml
  [[list]]
  id = "plowe-0"
  disabled = true
  ```

### Games catalog

Games come only from legitimate sources: official feeds and embeds, and open-source games at pinned commits
([docs/research/games-sources.md](docs/research/games-sources.md), [crates/catalog](crates/catalog/README.md)).
Embeds are **never proxied, rewritten, overlaid or ad-blocked**: each game loads in a sandboxed frame directly from its
publisher, through a small wrapper page (`/play-frame/<slug>`) whose policy allows exactly that game's host.

**Sources.** `GNOME_CATALOG_SOURCES` (default `gamepix,oss`; `none` turns the games off). GamePix and the open-source
games are on by default; the other networks need your publisher account. What each network asks of you:

| Network | The network requires | GNOME settings | GNOME guarantees |
| --- | --- | --- | --- |
| GamePix | **unverified**: the public SID `1` is GamePix's own default; read the publisher terms at my.gamepix.com (behind a login) and use your own SID to be paid | `GNOME_GAMEPIX_SID` | direct frames, referrer origin, no blocking |
| GameDistribution | a publisher account with your domain, their tags and `ads.txt` lines, a Google Ad Manager account | `GNOME_GD_PUBLISHER_ID`, `GNOME_ADS_TXT`, a known app origin (`GNOME_PUBLIC_ORIGINS` or two origins) | `gd_sdk_referrer_url` = the player page; no monitoring crawler (the importer reads the feed only) |
| Playgama | an approved partner CLID | `GNOME_PLAYGAMA_CLID`; developer hosts in `GNOME_GAMES_EMBED_HOSTS` after review | the CLID in every embed URL |
| GameMonetize | your site added in the dashboard | `GNOME_GAMEMONETIZE_ENABLED=true` | ≥ 10 s between feed requests |
| Famobi | an approved affiliate ID (≥ 50k visits a month) | `GNOME_FAMOBI_AFFILIATE_ID` | the ID in every embed URL |
| itch.io, js13kGames | none (discovery and link-out) | `GNOME_CATALOG_SOURCES` | never framed |
| Open-source games | each license | `GNOME_OSS_*` | the license panel, the LICENSE file, the pinned source |

Disclose the proxy feature when you apply to networks whose terms bar "hacking" content (GameDistribution §6.2(iii)(c),
Playgama §6.1), get each network's written confirmation for a site that includes a proxy, and keep "unblocked"
marketing off the games pages. **Thumbnails**: caching or re-serving the networks' images is unverified against each
network's terms: confirm it with each network, or set `GNOME_THUMB_CACHE_MB=0` (thumbnails are still checked, but
nothing is stored).

- **Embed hosts.** A game is framed only when its embed host is a fixed host of an enabled source, or a developer host
  you approved in `GNOME_GAMES_EMBED_HOSTS` (exact DNS names, comma-separated; Playgama serves some games from
  developer hosts). Catalog data never adds a host. `/admin/diagnostics` → `games.embed_hosts` lists the `pending`
  hosts with their game counts; such games say "can't be played here" and link to their source.
- **Open-source games.** The built-in manifest (`crates/catalog/oss-games.toml`) enables only entries whose pinned
  commit was reviewed (no storage clearing, no external loads; recorded in the manifest): on 2026-11-23 `2048`,
  `javascript-racer`, `javascript-breakout`, `bullethell` and `clumsy-bird`. gnome-server downloads each one from
  `codeload.github.com` at its commit (`GNOME_OSS_FETCH=auto`, or `gnome-server catalog fetch-oss`), into
  `GNOME_OSS_GAMES_DIR` (default `$GNOME_DATA_DIR/oss-games`, at most `GNOME_OSS_MAX_MB`), and serves them from the
  **proxy origin** under `/oss/<slug>/`, so they need two origins (`GNOME_PROXY_BIND` or `GNOME_PROXY_ORIGIN`; in
  single-origin mode the `oss` source is disabled with a warning). Each game page shows its license, copyright,
  repository and commit and links its LICENSE file.
- **Thumbnails** go through `/api/thumb/<id>` (`GNOME_THUMB_PROXY=true`): the server fetches them from the enabled
  sources' image hosts only, checks type and size, and caches them on disk (`$GNOME_DATA_DIR/thumbs/`, at most
  `GNOME_THUMB_CACHE_MB`, default 256 MiB). On a Raspberry Pi with an SD card, keep the cache small or at `0`, or put
  `GNOME_DATA_DIR` on other storage, to spare the card's writes.
- **`/ads.txt`.** `GNOME_ADS_TXT=/absolute/path/ads.txt` serves that file (≤ 64 KiB) on the app origin, with the lines
  your networks give you.
- **CLI.** `gnome-server catalog import [--source S] [--limit N]` imports now (a limited run reports `incomplete`,
  which is expected), `catalog stats` prints the counts, `catalog fetch-oss [--slug S]` fetches open-source builds.
  The admin listener has `POST /admin/catalog/import`, `POST /admin/catalog/oss-fetch`, and per-game feature and
  hide switches ([docs/API.md](docs/API.md) "Admin"). Run the `catalog` commands with the same `GNOME_*` settings as
  the server (data directory and binds):

  ```sh
  GNOME_DATA_DIR=./data GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 ./target/release/gnome-server catalog import --source gamepix --limit 200
  GNOME_DATA_DIR=./data GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 ./target/release/gnome-server catalog fetch-oss
  GNOME_DATA_DIR=./data GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 ./target/release/gnome-server catalog stats
  ```

- **Scale** (measured 2026-11-23 on the development machine): a full GamePix import took 168 s for 16,041 games
  (15,722 listed), with gnome-server's memory at most 44 MiB and about 2 % of one CPU; the catalog database was about
  49 MB. Paging through every game (158 pages of 100) took under 0.2 s, at most 14 ms a page. The Games page's "All
  games" grid keeps at most 15,000 games: scrolling A–Z ends there (search, categories and other sorts still reach
  the rest). Scrolling it to that end loaded 313 pages, kept at most 50 tiles in the page and held 60 frames a second
  in Chromium (95th percentile 16.8 ms); in Firefox the 95th percentile was 33.5 ms.

**Privacy.** Before the first game of a network loads in a browser, the player says "This game loads from <network>.
<network> and its advertisers see your IP address and may set cookies." and waits for **Play**; the choice is kept
in that browser (Settings → Privacy → Clear browsing data → "Game network choices", or "Forget" on the Games page).
Playing a game tells the network and its advertisers the visitor's IP address, and tells the network your server's
address (the frames send your origin as the referrer). To keep your server unlisted there, use
`GNOME_CATALOG_SOURCES=none`. GNOME is not a
consent tool: if your server has visitors in the EU, you need your own consent solution, and the networks' rules for
players under 13 apply. Favorites and recently played stay in each browser and are not synced.

### Account sync

- **Server:** `GNOME_ACCOUNTS=true` (the default).
- **Users:** sign in under Settings → Account & sync, then turn on **Sync** (off by default). Settings and bookmark
  sync are then on; **history sync is off by default** (turning it on sends the addresses you visit to the server).
  Favorites, an uploaded home-background picture and the device's account switches stay local. "Sync now" syncs at once.
- **Limits:** 100,000 history visits and 20,000 bookmarks per account. Past 20,000 bookmarks the server refuses
  bookmark uploads, so bookmark sync stops for that account.
- Visits synced from your other devices are stored here even when "Save browsing history" is off on this device
  (an open product decision for Wave E).

### Admin diagnostics, logging and metrics

The admin listener (`GNOME_ADMIN_BIND`, default `127.0.0.1:9091`; empty disables it) serves:

| Path | What |
| --- | --- |
| `GET /admin/` | HTML diagnostics page (`?refresh=5` reloads it) |
| `GET /admin/diagnostics` | JSON: build, configuration without secrets, database (with the sync storage totals), upstreams, jobs, WebSockets, rate limiter, static files, `connections` (caps, active, refusals) and `proxy_trust` (requests with https origins from untrusted peers) |
| `GET /admin/metrics` | Prometheus text (`gnome_build_info`, `gnome_http_*` including the Wave D `gnome_http_connections_total`, `_connections_refused_total`, `_inflight_refused_total`, `_large_head_refused_total`, `_answer_refused_total`, `_cap_full_seconds_total`, `gnome_wisp_upstream_up{id}`, `process_*`, …) |
| `POST /admin/filters/refresh` | Re-check every filter list now (header `X-GNOME-Request: 1`; answers 202) |

- **Without `GNOME_ADMIN_TOKEN`**, the listener only answers requests addressed to localhost.
- **With a token** (16 or more characters), send `Authorization: Bearer <token>`. In a browser, use HTTP Basic auth
  with the token as the password.
- **On a non-loopback address**, the listener needs both `GNOME_ADMIN_ALLOW_REMOTE=true` and a token. In the app,
  About → Diagnostics and Settings → Advanced → Diagnostics show what the browser sees.

**Logging:** `GNOME_LOG` (default `info`, a tracing filter such as `info,gnome_server=debug`), `GNOME_LOG_FORMAT`
(`pretty` by default, or `json`) and `GNOME_LOG_IPS` (default `false`: client IPs are left out of access logs).

### Everything on

The example below turns on every feature that exists today, on loopback. It was checked with `config check` and
run (with other ports) on 2026-11-23: the access-code dialog appeared ("Enter code"), browsing worked after entering
the code, the test VPN profile reported `up` and showed on `/vpn`, the games
were imported (GamePix and the open-source games), `/ads.txt` answered, and the admin listener answered 401 without
the token and 200 with it. The exit check stays off until you set your own check endpoint (the commented line).

```sh
# terminal 1: the default HolyWisp, plus a second one standing in for a VPN exit (no tunnel: a test, not a VPN)
services/holywisp/build/$(uname -m)/holywisp --config services/holywisp/gnome.conf &
services/holywisp/build/$(uname -m)/holywisp --config services/holywisp/gnome.conf --port 6002 &

# still terminal 1: profiles and filter-list overrides, next to the data directory (any path works)
mkdir -p data
cat > data/profiles.toml <<'EOF'
[[profile]]
id = "test-exit"
label = "Test exit (no tunnel)"
country_code = "se"
country = "Sweden"
city = "Gothenburg"
wisp_upstream = "127.0.0.1:6002"
EOF
printf '[[list]]\nid = "plowe-0"\ndisabled = true\n' > data/lists.toml
printf 'example.com, pub-0000000000000000, DIRECT\n' > data/ads.txt   # the lines your game networks give you

# terminal 2: gnome-server
export GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 GNOME_ADMIN_BIND=127.0.0.1:9091
export GNOME_ADMIN_TOKEN=replace-with-a-long-random-token
export GNOME_ACCESS_MODE=code GNOME_ACCESS_CODE=choose-a-long-code
export GNOME_ACCOUNTS=true GNOME_REGISTRATION=closed
export GNOME_ALLOW_CUSTOM_WISP=true
export GNOME_VPN_PROFILES=$PWD/data/profiles.toml
export GNOME_FILTERS_REFRESH_HOURS=24 GNOME_FILTER_LISTS_FILE=$PWD/data/lists.toml
export GNOME_CATALOG_SOURCES=gamepix,oss GNOME_CATALOG_REFRESH_HOURS=24 GNOME_OSS_FETCH=auto
export GNOME_THUMB_PROXY=true GNOME_THUMB_CACHE_MB=256 GNOME_ADS_TXT=$PWD/data/ads.txt
# export GNOME_VPN_CHECK_URL=https://check.example.org/json   # your own check endpoint (services/vpn/README.md)
export GNOME_SOURCE_URL=https://example.org/your-gnome-source   # AGPL §13 source link shown in About
export GNOME_LOG=info GNOME_LOG_FORMAT=json
./target/release/gnome-server config check
echo 'a-long-password' | ./target/release/gnome-server user create alice --admin --password-stdin
./target/release/gnome-server serve
```

Check it from any terminal (the token is written out, because it is only exported in terminal 2):

```sh
curl -s http://127.0.0.1:8080/api/vpn/locations
curl -s http://127.0.0.1:8080/api/games/status      # about a minute after start: listed > 0
curl -s http://127.0.0.1:8080/ads.txt
curl -s -H "Authorization: Bearer replace-with-a-long-random-token" http://127.0.0.1:9091/admin/diagnostics
```

In a browser, http://127.0.0.1:9091/admin/ asks for HTTP Basic auth: any username, the token as the password.
Then open http://127.0.0.1:8080/ and enter the access code when asked; `/games` lists the games and `/vpn` offers
the test location. Sign in as `alice` under Settings → Account
& sync to use sync. To stop, press Ctrl+C in terminal 2 and run `kill %1 %2` in terminal 1.

## Using GNOME

| Page | What it has |
| --- | --- |
| `/` Home | Search box, quick links, recent sites, favorites, wallpaper |
| `/browse` Browser | The browser. It keeps running while you visit other pages |
| `/history` | History, with search and clearing |
| `/bookmarks` | Bookmarks, with import and export |
| `/downloads` | Downloads list |
| `/settings` | Settings |
| `/about` | How it works, browser engine versions and known limits, privacy, shortcuts, diagnostics, licenses, source link |
| `/extensions` | The built-in extensions: overview with this session's counts, filter lists, site rules (allowlist and per-site settings), the cookie manager, status and how it works |
| `/games` | The games: search, categories, shelves (Featured, Trending, Popular, Recently added, Favorites, Recently played) and "All games" as a grid or list. Settings → Games (card size, sort, hidden categories, touch-screen games only, recently played) |
| `/games/<slug>` | A game's page: description, how to play, tags, more like it; for open-source games the license panel |
| `/play/<slug>` | The player: the game in a sandboxed frame straight from its publisher, Fullscreen, Favorite; the notice before a network's first game |
| `/vpn` | The VPN page: status, Connect / Disconnect, locations, the exit check, the kill switch and other switches, and what the VPN covers. Shown in every build; without locations it says the server offers none. Settings → VPN |

In the address bar, `gnome://<page>` (for example `gnome://settings`) opens a GNOME page. Anything that is not an
address is searched with the search engine set in Settings → Browser: DuckDuckGo by default, or Google, Bing, Brave
Search, Startpage, Ecosia or a custom URL with `%s`. Search suggestions are off by default.

### Keyboard shortcuts

Mod is Cmd on Apple devices and Ctrl elsewhere. Rebind any shortcut in Settings → Shortcuts. The defaults avoid
combinations browsers keep for themselves (Ctrl+T, Ctrl+W, Ctrl+Tab, …), and Settings warns if you pick one.

| Action | Keys | Action | Keys |
| --- | --- | --- | --- |
| New tab | Alt+T | Find in page | Mod+F |
| Close tab | Alt+W | Command palette | Mod+K |
| Reopen closed tab | Alt+Shift+T | Toggle sidebar | Alt+S |
| Next / previous tab | Alt+PageDown / Alt+PageUp | History | Alt+H |
| Tab 1–8 / last tab | Alt+1 … Alt+8 / Alt+9 | Bookmarks | Alt+Shift+B |
| Focus address bar | Alt+L | Downloads | Alt+J |
| Reload (two bindings) | Alt+R or Alt+Shift+R | Settings | Alt+, |
| Back / forward | Alt+← / Alt+→ | Games | Alt+G |
| Home page | Alt+Home | Duplicate tab | Alt+Shift+D |
| Bookmark this page | Alt+B | Pin tab | Alt+Shift+P |
| GNOME fullscreen | Alt+Shift+F | Zoom in / out / reset | Alt+= / Alt+- / Alt+0 |

Alt+Shift+R is a second reload binding (Settings → Shortcuts: "Reload (second shortcut)"), not a separate
cache-bypassing reload: GNOME keeps no cache of its own, and proxied pages are fetched through the Wisp transport
rather than the browser's HTTP cache (by design; no test checks this separately).

### Notable settings

- **Appearance:** theme (dark by default), accent color, custom colors, font, text size, density, corner radius,
  animation, glass and blur; sidebar and its position, toolbar (full or compact), tab strip, bookmarks bar, Home
  background.
- **Browser:** search engine and home page; on start-up (Home, restore the previous tabs, or start-up pages); what
  new tabs show; default zoom; history (kept 90 days by default) and the downloads list.
- **Privacy:** clear browsing data, and clear cookies, history or site data when GNOME closes; WebRTC (Block by
  default); default and per-site permissions.
- **Performance:** GPU effects, memory saver, background tabs, preloading GNOME pages.
- **Advanced:** proxy engine, retry on the other engine, transport, custom Wisp servers; proxy isolation status,
  diagnostics; import and export of settings as JSON, reset all settings.

Settings live in this browser. With an account and Sync on, they also sync to the server.

### Known limitations

- **The app origin is the security boundary.** Every proxied page runs on the shared proxy origin. A site built to
  attack GNOME can take over the browser engine there, read or change your other GNOME tabs and their cookies, and
  use the connection ticket until it expires (1 h by default, `GNOME_WISP_TICKET_TTL_S`). It **cannot read** your
  GNOME account, settings, history or bookmarks, which live on the app origin. It can still add fake entries to your
  history, and it can plant enough cookies to stop GNOME loading until you clear them (the two loopback ports share
  cookies, and a proxy hostname under the app's domain can set `Domain=`). A fix is a Wave D decision.
- **Sites are not kept apart as in a normal browser.** Neither engine enforces the cross-origin rules (CORS): a page
  can read other sites' responses a browser would refuse it, and requests that need a preflight are sent without
  one. Since Wave B step 3 the cookie manager blocks third-party cookies by default in both engines (a site's fetch to
  another site carries none of its cookies), GNOME refuses cookies set for another site's domain, and Ultraviolet
  follows SameSite as Chromium does. With third-party cookies allowed, any site you open in GNOME,
  not only one built to attack GNOME, can read pages of other sites you are signed in to inside GNOME (under
  Scramjet: those whose cookies are `SameSite=None`; in Ultraviolet the same) and send them forged requests, and a
  site built to attack GNOME can do so in every mode. Don't sign in to sensitive accounts inside GNOME.
- **The WebRTC block** stops ordinary use, but a site built to get around it can still reveal your IP address.
  "Allow" sends WebRTC traffic directly, outside GNOME. In Chromium a site built to attack GNOME can also make the
  browser open a connection (TCP and TLS, no request) to a host it chooses, which shows that host your IP address.
- **The address bar and the VPN exit check** show what pages report or what the check service saw. They are not
  proof.
- **Games** load directly from their publishers, not through GNOME's browser engine or the VPN: the network and its
  advertisers see the visitor's IP address and may set cookies and show ads, and GNOME's blocking does not apply to
  them. GNOME's keyboard shortcuts do not reach a game that has the focus. Open-source games that are not marked
  isolated run on the proxy origin and share its storage with the proxied pages. Firefox ignores most of the app's
  `Permissions-Policy`; there, the game frame's `allow` attribute is what limits a game.
- **The VPN** routes only the pages opened in GNOME (not the device, other tabs, GNOME's interface, games, or WebRTC
  set to Allow). A page built to attack GNOME can still reveal the device's address (see WebRTC above). Exit checks
  report what the check service saw and are not proof. After a location change, tabs that were already open keep
  their old route until they are reloaded.
- **Permissions.** Camera, microphone, location and notifications are never available to proxied pages. Autoplay and
  fullscreen settings are enforced in Chromium; in Firefox only fullscreen is (Firefox does not implement the
  autoplay permissions policy). They hold for ordinary sites: a site built to attack GNOME can lift them for itself.
  There is no clipboard setting: Chromium's clipboard policy does not stop `document.execCommand('copy')`, and
  Firefox implements none, so pages can always copy after a click, as in a normal browser.
- **Pop-ups.** Pop-ups open as GNOME tabs, and `window.open` returns `null` to the page. Sign-ins that rely on
  `window.opener` (some OAuth and payment flows) do not work.
- **Document types.** SVG, XHTML and XML documents, and pages served without a `Content-Type`, run no scripts in
  either engine. Under Ultraviolet, neither do pages whose `Content-Type` is not exactly `text/html`. Pages inside
  `<object>`/`<embed>` do not load.
- **Scramjet:** synchronous XHR, WebSockets in workers, and `localStorage.clear()`/`key()` fail. In Firefox, blob
  and URL workers time out.
- **Ultraviolet:** dynamic `import()` fails, SharedWorkers are refused, and workers error in Firefox.
- **Downloads.** Downloads cannot be paused or cancelled. Downloads that a page builds as `blob:`/`data:` URLs are
  not listed.
- **Print.** In Firefox, GNOME is expected to freeze while a page's print dialog is open (`print()` blocks the whole
  content process); a real print dialog has not been tested.
- **Connections.** Now and then a page does not load and GNOME's error page says "SSL connect error" (libcurl
  error 35). In the e2e runs of 2026-11-19 this happened only in Firefox with Scramjet, mostly with the libcurl
  transport (the default; once as a connect error with epoxy): 7 of about 160 such rows in four runs, and a later
  load of the same site worked. The cause is not known yet (not reproduced in 10 loads through GNOME's UI, nor
  natively through HolyWisp).
- **Sites.** Some sites detect the proxy (TLS fingerprint), and some CSS-referenced icons stay blank. On GitHub
  repository pages the files, About and README load, but the latest-commit column and the Releases list stay empty
  placeholders, with both engines in both browsers (2026-11-19; not investigated further). Search engines
  may show a bot check to automated browsers: DuckDuckGo (the default) did in headless Chromium with both engines,
  but showed its results in headless Firefox (both engines) and in a headed Chromium (2026-11-19). The address bar no
  longer turns into `duckduckgo.com/undefined`: that was a Scramjet bug (a `history.pushState`/`replaceState` without
  a URL), which GNOME now works around (checked through GNOME's UI in both browsers on 2026-11-19).
- **Browsers.** Only Chromium and Firefox are tested. Safari and WebKit are not.

## Development

**Frontend scripts** (run in `frontend/`):

| Command | What it does |
| --- | --- |
| `npm ci` | Installs the locked dependencies |
| `npm run build` | App and engine host (`vite build`), `sw.js` (`vite build -c vite.sw.config.ts`) and `vendor/` (`scripts/copy-vendor.mjs`) into `dist/`, or into `GNOME_DIST_DIR` if set. About 30 MB |
| `npm run dev` | Vite dev server for the **app origin only**, on `127.0.0.1:5173` with HMR. It proxies `/api` to `GNOME_DEV_BACKEND` (default `http://127.0.0.1:8080`) |
| `npm run dev:engine` | Copies `vendor/` once, then watch-builds the engine host and `sw.js` into `dist/` (`index.html` is left alone) |
| `npm run preview` | Serves the built `dist/` (or `GNOME_DIST_DIR`) on `127.0.0.1:4173` and, like `npm run dev`, proxies `/api` to `GNOME_DEV_BACKEND`. Browsing there needs `GNOME_PUBLIC_ORIGINS` to include `http://127.0.0.1:4173` (not tested) |
| `npm run check` | `svelte-check` plus `tsc` for the app and the service worker |
| `npm test` | Vitest unit tests (1516 tests on 2026-11-24) |
| `npm run build:e2e` | Build with test hooks for the e2e runner. **Never deploy it** |
| `npm run qa:visual` | Screenshot QA against `npm run dev -- --port 21000 --strictPort` (or any app URL in `GNOME_QA_URL`). Set `GNOME_QA_OUT`, or it writes into `docs/screenshots/foundation/` |

**Two-origin development with HMR** ([docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md)). The engine host, `sw.js` and
`vendor/` always come from `gnome-server`'s proxy listener. This recipe was run (on other ports) on 2026-11-18:
browsing, back/forward, reload, new tabs and `/history` worked through the dev server in Chromium and Firefox.

```sh
# terminal 1
services/holywisp/build/$(uname -m)/holywisp --config services/holywisp/gnome.conf
# terminal 2
(cd frontend && npm run build) && \
GNOME_BIND=127.0.0.1:8080 GNOME_PROXY_BIND=127.0.0.1:8081 GNOME_STATIC_DIR=frontend/dist GNOME_STATIC_RELOAD=true \
GNOME_PUBLIC_ORIGINS=http://127.0.0.1:5173,http://127.0.0.1:8080 cargo run -p gnome-server
# terminal 3
cd frontend && npm run dev:engine
# terminal 4: then open http://127.0.0.1:5173/
cd frontend && npm run dev
```

Run only one `npm run dev` per checkout: several Vite dev servers share `frontend/node_modules/.vite` and break each
other's dependency cache (every page then fails with "Failed to fetch dynamically imported module").

`GNOME_STATIC_RELOAD=true` (development only) makes the server pick up new builds without a restart. Without it,
run `npm run build` and restart `gnome-server` after each change.

**Rust** (from the repository root; each of these passed on 2026-11-24):

```sh
cargo test --workspace --locked                                  # 536 passed, 5 ignored
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all --check
# ignored tests that need the network: real HolyWisp + gnome-server (HOLYWISP_BIN must be an absolute path),
# a GamePix import with one thumbnail, and the fetch of every enabled open-source game from GitHub
HOLYWISP_BIN=$PWD/services/holywisp/build/$(uname -m)/holywisp cargo test -p gnome-server --test holywisp_e2e -- --ignored --nocapture
cargo test -p gnome-server --test games_online --test games_oss -- --ignored
```

The fifth ignored test (`vpn_exit` `online_check_through_holywisp`) needs `HOLYWISP_BIN` and `VPN_CHECK_ONLINE_URL`
pointing at a check endpoint you run; it was not run here.

**End-to-end tests** ([tests/e2e/README.md](tests/e2e/README.md), [tests/e2e/engine/README.md](tests/e2e/engine/README.md)):

```sh
cd tests/e2e && npm ci
npx playwright-core install chromium firefox     # into ~/.cache/ms-playwright
node engine/run.mjs --browser all --build-server # or point GNOME_SERVER_BIN at a built gnome-server
```

- **What the runner does.** It builds the frontend with `build:e2e` and starts HolyWisp, a test VPN profile and
  `gnome-server` on ports from `E2E_PORT_BASE` (default 27500). It then runs every suite in Chromium and Firefox,
  writes `engine/results/<timestamp>/results.md`, and stops everything.
  - Options: `--browser chromium|firefox|all`, `--only a,b`, `--skip a,b`, `--parts x,y`, `--no-build`,
    `--dist <dir>`, `--offline`, `--strict`.
  - `E2E_PORT_BASE` moves every port of a run: the stack uses base +0..+40, the standalone suites +100..+199, and
    the suites' own fixture servers +200..+229 (`HOST_E2E_PORT_BASE`, `SHELL_E2E_PORT_BASE`,
    `LIBRARY_E2E_PORT_BASE` and `BACKEND_E2E_PORT_BASE` still override one block each). Keep the range below 32768,
    where Linux starts handing out outgoing ports.
  - The full run (every suite in both browsers, plus the standalone suites) on 2026-11-24, Wave C's final step:
    Chromium 798 passed, 13 failed, 21 skipped; Firefox 788 passed, 19 failed, 23 skipped. The failures are rows marked
    `expectFail` that measure known limits (About → Browser engine and Content blocking list them) and the `sw`
    build-id row, which fails only with `--no-build` and passes with the runner's own build; details are in
    [docs/PROGRESS.md](docs/PROGRESS.md) ("RESUME HERE"). Most skipped rows are Wave C rows not written yet or
    rows that need the internet.
- **Games and VPN suites (Wave C).** `backend-games`, `games-ui` and `games-player` are standalone suites with their
  own servers: they replay real feed captures (`gnome-server catalog import --replay <index.json>`, never contacting a
  host) and use GNOME's own test game for the open-source rows. `vpn-ui` runs on the runner's stack (a second HolyWisp
  as the test location, a local check fixture). Rows that need the internet (B16: one GamePix thumbnail through the
  proxy) are skipped unless `GAMES_E2E_ONLINE=1`.
- **Other QA scripts:** `tests/e2e/stack/stack-qa.mjs` (HTTP and Wisp checks without a browser; set `GNOME_QA_APP`
  and `GNOME_QA_PROXY` to a running stack), `tests/e2e/settings/settings-qa.mjs`, `settings-features-qa.mjs` and
  `tests/e2e/about/about-qa.mjs`. Each script's header lists its variables.

## Production notes

There are three ways to run GNOME in production, all described step by step in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and, for a first install, in [START-GUIDE.md](START-GUIDE.md):

- **Route A: the Docker stack** (`deployment/compose.yml`): Caddy (the only service with published ports, 80 and
  443, automatic HTTPS), the FROM-scratch `gnome-server` image (user 65532, read-only, no capabilities) and HolyWisp
  on its own network. Secrets come from files made by `deployment/init-secrets.sh`. VPN exits are added with
  `deployment/compose.vpn.yml`.
- **Route B: the release artifact with systemd** (`scripts/release.sh` builds it): static binaries, the web app,
  `deployment/systemd/gnome-server.service` (`DynamicUser`, an empty capability set, a system-call filter,
  `systemd-analyze security` 1.4) and HolyWisp's unit, with the same Caddyfile in front.
- **Route C: your own front** (nginx, Traefik, a CDN): the conditions it must meet are in DEPLOYMENT.md, "Other fronts
  and CDNs".

Rules that hold for every route:

- **Two HTTPS hostnames**, an app hostname and a proxy hostname (siblings such as `gnome.example.com` and
  `p.gnome.example.com`), with `GNOME_PUBLIC_ORIGINS`, `GNOME_PROXY_ORIGIN` and `GNOME_TRUSTED_PROXIES` set to the
  front's address. `config check` reports "proxy isolation: on (two-origin mode)".
- **The front**: [deployment/Caddyfile](deployment/Caddyfile) is the tested configuration. It raises
  `max_header_size` to 4 MB and puts a strict CSP on Caddy's own error answers and redirects, so no front-written page
  on the proxy hostname can run code. It removes `Cookie` on the proxy hostname, and its log drops client addresses,
  headers and query strings (Wisp tickets travel as `?t=`).
- **Never expose publicly** the admin listener (loopback, with an admin token from `GNOME_ADMIN_TOKEN_FILE`),
  HolyWisp's port 6001, the VPN egress HolyWisp instances or gluetun's control port.
- **Secrets** as files (`GNOME_*_FILE`), never in environment files or shell history.
- **Backups**: `gnome-server db backup <new file>` while the server runs; keep `secret.key` too.
- **Restart HolyWisp, do not reload it**: SIGHUP stops it.

## Project layout

```
backend/            gnome-server (Rust): API, gateway, accounts, filters, VPN profiles, admin listener
crates/net/         gnome-net: SSRF-safe outbound HTTP client and IP policy
crates/catalog/     gnome-catalog: game catalog importers and search (served by gnome-server's games module)
frontend/           Svelte 5 + TypeScript app, engine host (engine/), service worker (src/sw/)
services/holywisp/  pinned HolyWisp build, gnome.conf, systemd units, Dockerfile
services/vpn/       VPN egress recipes and profiles example
database/           SQL migrations
deployment/         Dockerfile, compose stack, Caddyfile, systemd unit, secrets and check scripts
scripts/            release.sh, audit.sh, budgets, third-party license tooling
bench/              benchmark harness, Node.js and wisp-js baselines, load generator (never shipped)
tests/e2e/          Playwright e2e runner and QA scripts
docs/               design and planning documents
```

**Documentation.**

| Doc | Contents |
| --- | --- |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Checklist, plan by wave, decisions log |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture, configuration (§4.2), origins, engines, extensions, games, VPN, build |
| [docs/API.md](docs/API.md) | HTTP API |
| [docs/ENGINE-PROTOCOL.md](docs/ENGINE-PROTOCOL.md) | App ↔ engine host protocol, with what is proven and what is not |
| [docs/DESIGN.md](docs/DESIGN.md) | Design system |
| [START-GUIDE.md](START-GUIDE.md) | Start everything: this PC and an Ubuntu 24.04 server |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [deployment/README.md](deployment/README.md) | Production deployment: Docker stack, release artifact with systemd, Caddy, Raspberry Pi 4, operations |
| [docs/BENCHMARKS.md](docs/BENCHMARKS.md), [bench/README.md](bench/README.md) | Benchmark method and results |
| [docs/AUDIT.md](docs/AUDIT.md) | Supply-chain audit policy and results |
| [docs/WAVE-B.md](docs/WAVE-B.md), [docs/WAVE-B3.md](docs/WAVE-B3.md), [docs/WAVE-C.md](docs/WAVE-C.md), [docs/WAVE-D.md](docs/WAVE-D.md) | Plans for the proxy and browser, the extensions, games and VPN, and performance and production |
| [backend/README.md](backend/README.md) | Server configuration, CLI, origins and roles |
| [services/holywisp/README.md](services/holywisp/README.md), [services/vpn/README.md](services/vpn/README.md) | HolyWisp build and operation, VPN egress |
| [crates/catalog/README.md](crates/catalog/README.md), [crates/net/README.md](crates/net/README.md) | Crate docs |
| [docs/research/](docs/research/) | Research notes (Scramjet, Ultraviolet, HolyWisp, content blocking, game sources, Mullvad, Sapphire) |

### Licenses and credits

GNOME is licensed **AGPL-3.0-only**. This is declared in `Cargo.toml` and the `package.json` files, and the full text
is in [LICENSE](LICENSE). If you run a modified instance for others, set `GNOME_SOURCE_URL` so the About page links to
your source (AGPL §13); release builds made with `scripts/release.sh --source-url-base URL` compile that link in as
the default. The About page lists every third-party component with its license. A release `dist/` carries
`licenses/THIRD-PARTY-NOTICES.txt`, and each release artifact a licenses bundle (`share/licenses/`), next to the source
tarball (`gnome-<v>-src.tar.gz`) and, for a published release, the third-party source tarball of the copyleft
components.

GNOME builds on:

- **Proxy engines and transports** (copied unmodified into `dist/vendor/` with their licenses):
  [Scramjet](https://github.com/MercuryWorkshop/scramjet) and its controller (AGPL-3.0); Ultraviolet by Titanium
  Network (AGPL-3.0); bare-mux and proxy-transports (MIT); the libcurl transport (AGPL-3.0; bundles libcurl.js,
  LGPL-3.0) and the epoxy transport (AGPL-3.0) by Mercury Workshop.
- **Server side:** [HolyWisp](https://github.com/Fracital/holyWisp) (ISC), statically linked with musl (MIT); SQLite
  (public domain); the Rust crates listed on the About page.
- **Interface:** Svelte (MIT); Lucide icons (ISC); the IANA list of top-level domains (tells addresses from
  searches); fonts Inter, Montserrat, Geist, Geist Mono, Fraunces and Atkinson Hyperlegible Next (OFL-1.1),
  self-hosted.
- **Filter lists** (mirrored, not bundled): EasyList, EasyPrivacy, uBlock filters, AdGuard URL Tracking, Peter
  Lowe's list (no formal license), EasyList Cookie and uBlock Origin's redirect resources (GPL-3.0), each under its
  own license.

GNOME's extensions are first-party features. They are not Chrome extensions, and GNOME does not run uBlock Origin.
GNOME contains no code from Sapphire, which was only studied
([docs/research/sapphire.md](docs/research/sapphire.md)) and has no license. GNOME is an independent project and is
not affiliated with, sponsored or endorsed by Mullvad VPN AB or any other VPN provider.
