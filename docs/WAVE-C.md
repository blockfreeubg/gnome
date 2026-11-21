# Wave C module plan (games + VPN page)

> Status: plan for Wave C, written 2026-11-18 (`wave-c:plan`, doc-only) while the UI restyle's final gate was running
> and before Wave B step 2's integration part 2 and Wave B step 3. It builds on the code as it stood that evening:
> the reviewed `gnome-catalog` crate (`crates/catalog/**`, migrations 100–101), the server's module system
> (`backend/src/module.rs`), the VPN gateway profiles and health probes (`backend/src/vpn/**`,
> `backend/src/gateway/health.rs`), the app's route choice (`frontend/src/browser/engine/snapshot.ts` `chooseRoute`),
> the existing Settings → Games and Settings → VPN sections (hidden until `registerFeature('games' | 'vpn')`), the
> placeholder pages `src/pages/{games,vpn}/**`, and the step-3 ownership map of `docs/WAVE-B3.md` §2. Re-read the
> files named here before editing them: part 2 and step 3 may still change details.
> Revised 2026-11-19 (`wave-c:plan-fix`, doc-only) with the verified findings of the security/compliance review and
> the completeness/feasibility review: the player frames every game through a per-game wrapper document (D2, D4),
> Wisp tickets become route-bound (D23, lane v3), exit checks no longer change routing (D14), auto-connect is decided
> inside the browser's start (D12, v3), `vpn.killSwitch` joins `vpn.mode` as device-local, the exit check service has
> no default (D15), OSS builds are reviewed before they are enabled (D5), and the replay, test-harness, ownership and
> copy gaps are closed. Builders start from this version.
> Inputs: the user's product brief (games and VPN parts), `docs/PROGRESS.md` (decisions log, "Deferred items" — the
> Wave C backend item binds lane g1), `README.md`, `docs/ARCHITECTURE.md` §3–§7, `docs/API.md`, `docs/DESIGN.md` v2 §9–§12,
> `docs/ENGINE-PROTOCOL.md` (§1.2 rule 3, §4 `route`, §6.6, §6.13, §6.15), `crates/catalog/README.md`,
> `services/vpn/README.md`, `docs/research/games-sources.md`, `docs/research/mullvad-vpn.md`, and the lane reports
> `catalog-review.json` and `wave-b-c-browser-shell-review.json` (session `dd256ece…` handoff).

Wave C ships the two features the README still lists as "not built": the **Games** catalog (page, detail page,
player, favorites and recently played, served from the existing catalog crate) and the **VPN page** (connect,
disconnect, locations, status, exit checks, kill switch, privacy information). Six lanes build it without editing
each other's files: **g1** games backend (Rust), **g2** games UI, **v1** VPN page and client, **v2** VPN exit-check
backend (Rust), **v3** the VPN wiring inside the browser and the route-bound Wisp tickets (after step 3; app code
and one gateway change), **t** the e2e fixtures and suites. Five of
them run beside Wave B step 3; v3, the text changes in step-3-owned files, the documents and the final matrix wait
for step 3's integration step (§2.2).

## 0. Rules for every lane

- Everything in `docs/WAVE-B.md` §0 and `docs/WAVE-B3.md` §0 applies unchanged where it is about the product and the
  host: **website only; Rust for the backend only; TypeScript + Svelte 5 in the v2 design; no fake UI, no
  nonfunctional controls, no placeholder implementations; nothing claimed that is not tested** (mark untested
  behaviour **[unproven]** in comments and reports); engines served unmodified; e2e against the real gnome-server
  + HolyWisp in Chromium and Firefox; ports from the environment; **edit only the files your lane owns** (§2.1), no
  stub modules in another lane's paths and no import of a module that does not exist yet (take the other lane's
  module as a parameter of your own code and inject a fake in tests until it lands).
- **Host safety**: no privileged containers, no systemd-in-Docker, no host kernel/sysctl/binfmt/module changes, never
  `sudo`. HolyWisp runs as the e2e runner runs it (host binary as this user, or the runner's locked-down unprivileged
  container). Cargo with your lane's own `CARGO_TARGET_DIR` under `~/.cache/gnome-targets/` and `CARGO_BUILD_JOBS=3`.
- **Games only from legitimate sources, with their terms respected** (decisions log 2026-11-10): official feeds and
  embeds; GameDistribution, Playgama, GameMonetize and Famobi only with the operator's publisher ID; OSS games only
  from the curated manifest at pinned commits, with license, copyright and repository shown; **embeds are never
  proxied, rewritten, overlaid or ad-blocked**; **no fabricated catalog entries** — test data is real feed captures
  (`crates/catalog/tests/fixtures/`) or GNOME's own original test game in the e2e fixtures, never in a product
  manifest or database.
- **Mullvad: no code, no branding, no implied affiliation.** No provider is ever presented as usable for a
  multi-user service (§12.7), and GNOME calls no third-party service on a schedule unless the operator set it
  (D15). The VPN page says plainly that only traffic inside GNOME is routed.
- **Every proxy-origin response stays at least as strict as `PROXIED_DOCUMENT_CSP`** ("no permissive realm",
  PROGRESS "Wave B inputs"; ARCHITECTURE §4.6). This binds lane g1's `/oss/**` answers.
- **Nothing new crosses to the engine host.** Games data never does (ENGINE-PROTOCOL §1.2 rule 5); the VPN check URL
  already may (rule 4). No lane adds a command, event, capability or `EngineSettings` field; `src/shared/**` is not
  edited by Wave C (lane x1 of step 3 owns it).
- Documents (`docs/ARCHITECTURE.md`, `docs/API.md`, `docs/ENGINE-PROTOCOL.md`, `docs/DESIGN.md`, `docs/PROGRESS.md`,
  `README.md`, `backend/README.md`) are edited **only by the Wave C integration step** (§14), because step-3 lanes
  edit parts of them at the same time. Exceptions owned by one lane: `crates/catalog/README.md` (g1),
  `services/vpn/README.md` and `services/vpn/profiles.example.toml` (v2), and this file (the plan-fix step).
- Every increment keeps `cd frontend && npm run check && npm test` green, and `cargo test --workspace --locked` +
  `cargo clippy --workspace --all-targets --locked -- -D warnings` + `cargo fmt --all --check` for the Rust lanes.
  The tree is shared with step 3 (no git): land changes in small steps that compile. `npm test` includes
  `src/pages/about/licenses.test.ts`, which compares About's generated Rust crate list with
  `cargo tree -p gnome-server -e normal`: **any step that changes `Cargo.lock` regenerates that list in the same step**
  (§2.2 change request to x4), or every lane of both waves turns red.
- Port ranges: each lane's task gives its range; the runner's ports come from `E2E_PORT_BASE` (Wave C adds
  `E2E_PORT_BASE + 60` for the VPN check fixture and `+ 61` for a second test VPN location's HolyWisp, §9.1);
  standalone suites use `E2E_STANDALONE_PORT_BASE` (+0…+99), one suite at a time.

## 1. Decisions this plan settles

Each row binds the lanes. Rows marked (log) go into the PROGRESS decisions log when Wave C starts.

| # | Decision | Why |
| --- | --- | --- |
| D1 (log) | **When Wave C runs.** It starts after Wave B step 2's integration part 2 has finished (part 2 owns `frontend/src/{pages,app,browser,settings,…}/**` and reruns every suite, which a changing backend would disturb). Lanes **g1, g2, v1, v2, t run beside Wave B step 3** from step 3's day one: their files are disjoint from every step-3 lane (§2.2). **v3**, the text changes in `src/pages/settings/**` and `src/pages/about/**`, the documents and the final matrix **wait for step 3's integration step**, because step 3's lane x4 owns `src/browser/{browser.svelte,tabs.svelte}.ts`, `src/browser/engine/{snapshot,client}.ts`, `src/browser/ui/{Toolbar,ErrorOverlay}.svelte`, `error-copy.ts`, `src/pages/settings/**` and `src/pages/about/**` until then | Disjoint files are the only way two waves share one working tree without a merge tool |
| D2 (log) | **The player frames every game through a per-game wrapper document** that gnome-server renders on the app origin, `GET /play-frame/<slug>` (§4.5): no script, its own CSP `default-src 'none'; frame-src <exactly this game's embed origin>` (OSS: `<proxy origin>/oss/<slug>/`), and inside it one `<iframe src={embed_url} sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-pointer-lock allow-orientation-lock" allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope" allowfullscreen referrerpolicy="strict-origin-when-cross-origin">` (OSS entries: §4.5's narrower attributes). The app page's own frame is `<iframe src="/play-frame/<slug>" allow=… allowfullscreen>`, only on `/play/<slug>`. Never `allow-top-navigation*`, `allow-modals`, `allow-downloads`, `allow-presentation` or `allow-storage-access-by-user-activation`; never `referrerpolicy="no-referrer"`. GameDistribution's `gd_sdk_referrer_url` becomes `<app origin>/play/<slug>` (the page the visitor sees; crate change, §4.8) | Research §9.2: the networks' SDKs and ad click-outs need scripts, their own origin, forms, pointer lock and escaping popups, and "a restrictive sandbox … counts as interfering"; the sandbox still stops what matters on GNOME's tab: top navigation (malvertising redirects), modal dialogs over GNOME's UI, downloads. **A frame's own navigations are checked against its parent document's `frame-src`**: framed straight from the shell, a hostile game could navigate itself to anything the shell may frame — `<app>/browse?url=<attacker page>` (a second GNOME, same-origin with the top, opening a proxied attack page), `<proxy>/uv/service/…` (a proxied page beside the engine host) or another network's embed host (security review, high). The wrapper limits each game frame to its own origin. The app sends `Referrer-Policy: no-referrer` on every document, so the inner frame carries its own policy, and a stripped referrer is invalid traffic for GameDistribution and Playgama (research §0.3) |
| D3 (log) | **App-origin HTML gets `Cross-Origin-Opener-Policy: same-origin` and a deny-list `Permissions-Policy`** (§4.5) | Popups that escape the sandbox (ad click-outs) would otherwise keep `window.opener` and could navigate GNOME's tab (reverse tabnabbing); COOP severs it for every cross-origin popup. The deny-list keeps camera, microphone, geolocation, payment, USB and the like out of every frame of the page (the engine iframe never gets them either, ENGINE-PROTOCOL §6.14); `fullscreen`, `autoplay`, `gamepad`, `clipboard-write` and the motion sensors are left to each iframe's `allow` attribute (a header allowlist would cancel the delegation) |
| D4 (log) | **Which embed hosts may be framed is decided per game, and catalog data never adds a host by itself.** A game may be framed when its embed URL's host is a fixed embed host of an *enabled* source (`Source::embed_hosts`) or a developer host the operator listed in `GNOME_GAMES_EMBED_HOSTS` (exact DNS names), never an app or proxy origin host; an OSS game only at exactly its rendered `<proxy origin>/oss/<slug>/<entry>` (`FramePolicy::allows`, §4.5). The wrapper's `frame-src` names that one origin, computed per request, so an approval applies at the next page view. The **shell** policy's `frame-src` becomes `'self' <proxy origin>` (the wrapper and the engine host) and its `frame-ancestors` `'none'` with `X-Frame-Options: DENY` (nothing frames the SPA shell). A game that may not be framed is shown with `embed_allowed: false` and opens at its source in a new tab; `/admin/diagnostics` lists its host as `pending` (or `refused` for an app/proxy host) with game counts, recomputed every 5 minutes and after imports. The fixed `csp::GAME_EMBED_HOSTS` list goes away (its `y8.com`, `itch.io` and `embed.gamedistribution.com` entries have no importer); `img-src` gains the proxy origin (OSS thumbnails over plain HTTP in development) | The deferred item asks for a policy derived from `embed_hosts()`; the wrapper (D2) makes a per-game policy possible and keeps the shell's policy fixed. Playgama's importer accepts any HTTPS host (`sources/playgama.rs`: "a few games are embedded from their developer's site" — 1 of the 10 captured records, `deadlydescent.net`), so a poisoned or compromised feed could otherwise frame any host, including this instance's own proxy origin. Operator approval keeps framing bounded by what the operator agreed to; an unapproved game still works as a link-out |
| D5 (log) | **Open-source games are served by gnome-server on the proxy origin under `/oss/<slug>/`**: HTML gets `PROXIED_DOCUMENT_CSP; frame-ancestors <app origins>` (no `'self'`: a proxied page cannot frame them), scripts `proxyScriptCsp(app origins)`, everything else `proxyInertCsp(app origins)`; nothing third-party loads. Only the manifest's `entry` file is served as HTML, and only to frame loads (`Sec-Fetch-Dest: iframe`); every other `.html`/`.htm`/`.xhtml`/`.xml` file of a build answers 404 (§4.3). **An entry is enabled only with a recorded review of its pinned commit** (`reviewed = "<date>: …"` in the manifest: no storage, IndexedDB or service-worker clearing, no `innerHTML` from the URL, hash or `postMessage`, no external loads; the manifest test requires it, §4.8 item 5); an entry the review finds needing no storage gets `isolated = true` (an opaque-origin sandbox, §4.5). The three enabled entries that load code from CDNs (`particle-clicker`, `javascript-chess`, `a-blast`) become `enabled = false` with the reason, and so does any entry whose review fails. In single-origin mode the `oss` source is disabled with a startup warning (never served from the app origin) | ARCHITECTURE §6 already puts self-hosted games on the origin for untrusted content; the proxy origin is one shared realm (decisions log 2026-11-11): an OSS game gets both engines' cookie jars, the UV transport lock secret, the service-worker registrations and, through `parent.frames`, the engine host, so an unreviewed `localStorage.clear()` or a DOM XSS in any file of a repository would be a GNOME compromise (security review). An OSS document must not become a permissive realm for hostile proxied pages (no native network access beyond `'self'`), and a curated game must not pull unpinned third-party code into that realm. A dedicated third games origin would isolate them better: open item O2 |
| D6 | **The OSS fetch step lives in gnome-server**: `gnome-server catalog fetch-oss [--slug S]…` and the job `catalog.oss-fetch` (`GNOME_OSS_FETCH=auto`, the default; `manual` = CLI only) download each enabled entry's pinned commit as `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>` through gnome-net's SafeClient (host allow-list `codeload.github.com`), extract regular files and directories only (no links, devices, sparse or volume entries, absolute paths or `..`), within caps counted on the decompressed stream (§4.7), into a temporary directory that replaces `<GNOME_OSS_GAMES_DIR>/<slug>/` atomically, and require `entry` and `license_file` | The deferred item; a shell `git clone` would bypass the SSRF client and need git on the server; the commit in the URL is the integrity anchor (open item O8: GitHub does not promise byte-stable archives) |
| D7 (log) | **Thumbnails go through `/api/thumb/:id` by default** (`GNOME_THUMB_PROXY=true`): SafeClient with the enabled sources' thumbnail hosts as its host allow-list, ≤ 2 MiB (`thumbs::MAX_THUMB_BYTES`), the declared `Content-Type` must be an allowed raster type **and** match the file's magic bytes, served with `nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: public, max-age=<min(604800, the upstream's max-age)>`; a disk LRU cache under `$GNOME_DATA_DIR/thumbs/` capped by `GNOME_THUMB_CACHE_MB` (0 = validated pass-through without storing; whether each network's terms allow caching is unverified, research §11 item 11, so the README tells operators to confirm it or set 0; files of games that leave the catalog are deleted); its own rate classes (`thumb`, `thumb_fetch`) so a long scroll never exhausts the `api` baseline | Hotlinked thumbnails would show every visitor's IP address to the networks' CDNs and make the catalog depend on them on every scroll; the sniff closes "HTML labelled image/png"; `CORP` stops other sites from using the server as an image CDN |
| D8 | **Catalog reads are public in every access mode** (like `/api/filters` and `/api/vpn/locations`): `GNOME_ACCESS_MODE` keeps meaning "who may use the proxy". The play counter (`POST /api/games/:slug/play`) dedups by the session reference when a session cookie is present, else by an HMAC of the client IP (IPv6 /64); only the crate's hourly 16-byte hash is stored, and the hourly `catalog.rankings` job purges it (pseudonymous for at most two hours; daily totals are anonymous) | Embeds are not proxied traffic; the catalog is public metadata; access-code dialogs on the Games page would be friction without protection |
| D9 (log) | **Favorites and recently played stay in this browser** (IndexedDB `games_favorites`, `games_recent`, which exist since schema v1): not synced in Wave C; the page says so | The sync API has no games kind (it would need an endpoint, a core migration, a sync adapter and a switch in the Account panel, which step 3's x4 owns); recently played is history-like and stays local like history does by default. Open item O1 |
| D10 | **Query-parameter errors answer `400 bad_request`** with a message naming the parameter (the convention of `GET /api/sync/history`); body errors stay `422 validation_failed` | API.md conventions; the crate README's "400 validation_failed" note is corrected by lane g1 |
| D11 | **"Hidden categories" and "Only games that work on touch screens" are applied by the server**: `exclude=<slug,…>` (≤ 20, any position of a game's categories) and `mobile=1` on `GET /api/games`, `GET /api/games/sections` and the related games of `GET /api/games/:slug`; cursors are bound to them (crate change, §4.8). Excluded slugs the server does not know are ignored (they match no game) and are not bound into the cursor; the client also intersects `hiddenCategories` with `GET /api/games/categories` before sending (at most 19 categories exist, so the cap of 20 always holds) | Client-side filtering of keyset pages leaves holes and wrong totals; the Settings rows promise "left out of the catalog". The settings validator accepts up to 200 hidden slugs of any shape and Settings → Games keeps slugs the server no longer lists, so a strict 400 would let one synced or imported document break the whole Games page |
| D12 (log) | **`vpn.mode` (this browser's connection switch) and `vpn.killSwitch` are device-local**: a value arriving through account sync or an imported settings file never changes this browser's `vpn.mode` or `vpn.killSwitch` (exactly like the home-background picture, `settings/local-picture.ts`: `withDeviceSettings()` and `store.import()` put this browser's values back; the uploaded document may carry this device's values, which every other device ignores). **Connect** = `vpn.mode = 'gateway'` (and `preferredLocation` when the user picked one); **Disconnect** = `vpn.mode = 'off'`. The switch persists across reloads and restarts, so a reload or a session restore never silently drops the VPN; **`vpn.autoConnect` turns it on at every fresh start** (`browser/session.ts` `isFreshStart`: GNOME opened in a new browser tab with no other GNOME page open), also after a manual disconnect, decided inside the browser's own start before any tab can load (v3, §8.1). The other `vpn.*` keys keep syncing | An action on one device must not lower protection on another (turning the switch or the kill switch off), and an imported file must not route (or, with the kill switch, block) a browser that never chose it: that import is how lane c's review stranded a browser |
| D13 (log) | **"Connected" rests on the app's own facts**: the route the app chose is that location's profile and `/api/vpn/locations` (app origin) reports the location `up`; since D23 the gateway enforces that this browser's Wisp tickets work only on that route. The engine host's transport report only refines the state (`connecting` until a `profile` side is `ready`) and is labelled as what the engine host reports: escaped code can forge it (ENGINE-PROTOCOL §1.1 row B6), but cannot make pages leave through another route. The server's exit check (D14) and this browser's check (`vpn.verify`) are shown as **what the check service reported**, never as proof or a badge, and their agreement is never presented as confirmation | ENGINE-PROTOCOL §1.2 rule 3 and §6.13; a page that reaches the engine host can forge `vpn.verify` and the engine host's `status` |
| D14 (log) | **gnome-server checks each location's exit itself**, through that location's own HolyWisp instance (a minimal Wisp v1 client, TLS by rustls, one HTTP/1.1 GET), every `GNOME_VPN_CHECK_INTERVAL_MIN` (15) minutes ± 20 % and on demand (`POST /api/vpn/locations/:id/check`, at most once a minute per location), **only when the operator set a check service** (D15). The result is `exit` in `GET /api/vpn/locations`; **`status` keeps its meaning** (the health probe: the instance answers). **Exit-check results never change the route choice or the connection state**: a failed check is a warning on the VPN page and a `degraded` chip ("The exit check through <label> fails: <reason>") | The health probe cannot see a tunnel that fails closed (the instance answers, its streams do not connect; ARCHITECTURE §7); a server-side check works before any engine host runs and cannot be forged by proxied pages. A refused, unreachable or rate-limiting check service looks exactly like a dead tunnel (`connect_failed`, `timeout`): letting it drive routing would show "Blocked" while pages still load through a healthy tunnel (kill switch on) or move every user to this server's own connection on a check-service outage, a downgrade an outsider can trigger (kill switch off; both reviews) |
| D15 | **The check service is the operator's explicit choice**: `GNOME_VPN_CHECK_URL` (**default empty** = no server-side checks, no browser-side checks, `verify_url: null`) and optionally `GNOME_VPN_CHECK_URL_V6` (an IPv6-only name of the same service, §6.1); `config check` and the VPN page say how to set one, and `services/vpn/README.md` documents a self-hostable check endpoint. Results name the service's host ("<host> reports …"); `provider_exit` (`mullvad_exit_ip` at am.i.mullvad.net) appears only as "<host> says this address is one of its VPN exits: yes / no" and only when the field is present. Requests carry the neutral `User-Agent: exit-check/1` and the first checks are spread randomly over the whole interval. `vpn.verifyExit` defaults to `false` | No vendor wording in GNOME's UI (research §8.1 rule 5). A default naming am.i.mullvad.net would report every instance's exit addresses to a third party the operator never chose, every 15 minutes, linkable by the User-Agent and the boot-time stagger, and would read as an integration; research §3.7 found no permission for third-party use (O6) and §3.6 says never to make each browser hit it |
| D16 (log) | **Compliance with VPN providers' terms**: `config check` and startup **warn** when `GNOME_VPN_PROFILES` is set and either `GNOME_ACCESS_MODE=open`, or `GNOME_ACCESS_MODE=accounts` with `GNOME_REGISTRATION=open`; in `code` mode they print a **warning** that the access code must stay within the people the egress's terms allow; `GNOME_VPN_EGRESS_SHARED_OK=true` (the operator's statement that their egress terms allow every person who can use the instance) silences both. The VPN page, README and `services/vpn/README.md` say that the operator runs the locations over connections they are authorized to share with the people who use the server, and no document presents any provider as usable for a multi-user service; GNOME's access modes do not change what a provider's terms allow | Mullvad's terms forbid using the service "to provide a service similar to that provided by Mullvad or other services where VPN constitutes a significant part of the service" (README audit, 2026-11-18). Accounts mode with open registration is as public as open mode, and an access code can be handed to anyone (both reviews) |
| D17 | **"Automatic" location** (`preferredLocation: null`) = the first offered location whose health status is `up`, kept for this app page while it stays `up`; with none up, the first offered one (the kill switch then blocks). A switch between automatic locations shows a toast naming both (v3) | Settings already promises "The first location that is online"; `chooseRoute` today takes the first offered one whatever its status |
| D18 | **The stranded kill switch is fixed by visibility, not by weakening it**: D12 (imports and sync no longer set `vpn.mode` or `vpn.killSwitch`); `registerFeature('vpn')` in every build at app start (v3), so Settings → VPN's mode row (which stays enabled while the mode is on, `Vpn.svelte`) and the VPN page work even when the server offers no locations; the tab-strip chip shows "VPN · Blocked" (danger) or "VPN · Not in use" (warning), linking to `/vpn`; the VPN page shows the blocked state with **Disconnect** and the kill-switch switch; the error overlay gets an "Open VPN page" link (v3) | Lane c review: "the user has no visible control to turn it off"; the kill switch must keep its promise |
| D19 | **E2E catalog data**: real captures replayed by `gnome-server catalog import --source <id> --replay <index.json>` (CLI only, §4.6) into the suite's data directory before the server starts, with the adapter settings the captures were made with (replay-only overrides in the index, a pinned clock, unmatched requests refused as `Blocked`, §4.6); the `oss` source runs the real job path with a test manifest and GNOME's own original test game; publisher embeds are answered by Playwright routing under their real URLs (the "fake embed host"); thumbnails either through `/api/thumb/:id` (cargo tests with `FixtureFetcher`, one `GAMES_E2E_ONLINE=1` row) or, with `GNOME_THUMB_PROXY=false`, from routed CDN URLs | The suggested "local fake feed server" cannot work: gnome-net's strict policy refuses loopback, exactly why WAVE-B3 D17 serves test filter lists from files; a replay keeps the whole import code path except the fetcher, with no test hook in the running server |
| D20 | **`registerFeature('games')` and `registerFeature('vpn')` are the last step of their lanes** (g2, v3), once every row of their Settings section has passed its e2e row in both browsers; `games` registers only while `/api/config` → `features.games` is true, `vpn` always | Rows of features that do not act on their settings must stay hidden (`settings/features.ts`); the VPN mode row must be reachable even on a server without locations (D18) |
| D21 | **A module start-up hook**: `Module::prepare(&self, &AppState) -> BoxFuture<'_, ()>` (default no-op), awaited through `AppState::prepare_modules()` (each module's `prepare` in mount order) by `serve_all` before the jobs start and before any listener accepts, by the `catalog` CLI, and by the test harness (`TestApp::with_modules`); the games module runs `Catalog::prepare`, computes the first pending-host report and indexes the OSS builds there; a failure is logged, reported in diagnostics and turns the module's routes into `503 unavailable` (never a startup abort). **While `prepare` has not run, the routes answer exactly as after a failure** (`503 unavailable` + `Retry-After: 30`) | The crate requires `prepare` "once, before serving"; cargo tests drive the routers with `oneshot` and never call `serve_all` |
| D22 | **`/ads.txt`** on the app origin from an operator file (`GNOME_ADS_TXT=/abs/path`, `text/plain`, ≤ 64 KiB, re-read on change) | The networks' publisher terms ask for it (crate README "Operator compliance checklist" 1), and the SPA fallback answers `/ads.txt` with a 404 today |
| D23 (log) | **Wisp tickets are route-bound** (lane v3, gateway and app together, §8.1): `POST /api/wisp/ticket` takes the route the app chose (`{"route": "default"}` or `{"route": {"profile": "<id>"}}`; no body = `default`), and a `w2` ticket carries that route and its mint time. The gateway accepts it only on its route's path (`/wisp/` or `/wisp/p/<id>/`); once a session minted a profile-route ticket, its default-route tickets minted earlier are refused and their open connections closed at the existing 15 s session re-check; tickets minted before the server process started are refused (engine hosts re-mint through `needTicket {reason: 'rejected'}`). While `vpn.mode` is `gateway` the app mints a default-route ticket only when the kill switch is off and the route really falls back | Tickets carry no route today (`w1.<exp>.<session_ref>.<mac>`) and `/wisp/` and `/wisp/p/<id>/` share one check, so escaped code, which reads the ticket (ENGINE-PROTOCOL §1.1 row B6), could open a direct-route stream while the page says "Connected" or "Blocked" and learn this server's (often the household's) address for up to the ticket TTL (3600 s) — exactly the adversary the kill switch is for (security review, high) |
| D24 (log) | **A notice before a network's first frame**: before the first frame of a network loads in this browser, the player's stage shows "This game loads from <network>. <network> and its advertisers see your IP address and may set cookies." with **Play**; the choice is remembered per network in this browser (cleared by Settings → Privacy → Clear browsing data → "Game network choices" and by "Forget" on the Games page). OSS games need no notice. GNOME is not a consent tool: the README tells operators with EU visitors that they need one and must follow the networks' 13+ rules; passing consent signals to GameDistribution is open (O15) | Research §11 item 9; GamePix is on by default, so without it every default install would load ad-carrying third-party frames from a `/play/<slug>` link or the Recently played shelf before the visitor was told anything (security review) |

## 2. Lanes at a glance

### 2.1 Ownership

| Lane | Owns (directories and files) | Provides | Consumes |
| --- | --- | --- | --- |
| **g1** games backend (Rust) | new `backend/src/games/**` (`mod.rs`, `fetcher.rs`, `replay.rs`, `routes.rs`, `admin.rs`, `thumbs.rs`, `frames.rs`, `oss.rs`, `jobs.rs`, `ads_txt.rs`); `backend/tests/games_*.rs`, `backend/tests/fixtures/games/**`; `crates/catalog/**` (code, tests, `oss-games.toml`, README); **the day-one shared backend change of §3.1 and every later Wave C edit of these shared files**: root `Cargo.toml`, `Cargo.lock`, `backend/Cargo.toml`, `backend/src/{lib,config,module,server,router,cli,static_files}.rs`, `backend/src/security/{csp,headers,rate_limit}.rs`, `backend/src/admin/{mod,page}.rs` (the `catalog` placeholder and the `config` keys of diagnostics), `backend/src/state.rs` (`prepare_modules`), and the existing tests that pin the shell's frame headers (`backend/tests/roles.rs` asserts `frame-src 'self' <proxy origin> https://html5.gamedistribution.com`; the unit tests in `csp.rs` and `headers.rs` assert `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN` on the shell); `backend/tests/common/mod.rs` (server defaults `GNOME_CATALOG_REFRESH_HOURS=0`, `GNOME_OSS_FETCH=manual`, so no test server reaches the internet; `prepare_modules()` in `with_modules`); **one declared exception**: the generated BEGIN/END block of `frontend/src/pages/about/licenses.ts` (x4's file), regenerated with `node frontend/scripts/rust-crates.mjs` in the same step as every Wave C `Cargo.lock` change (§2.2) | `/api/games*`, `/api/thumb/:id`, `/play-frame/<slug>` (the wrapper), `/oss/<slug>/**` (proxy origin), `/ads.txt`, the admin endpoints, the jobs, `gnome-server catalog …`, `features.games`/`thumb_proxy`, the shell's fixed frame headers, COOP + Permissions-Policy, metrics and diagnostics; the config fields and the rate class lane v2 needs (§3.1) | gnome-net `SafeClient`; the crate |
| **v2** VPN exit check (Rust) | `backend/src/vpn/**` (new `exit.rs`, `wisp_client.rs`; changed `mod.rs`); `backend/tests/vpn_exit.rs`; `services/vpn/README.md`, `services/vpn/profiles.example.toml` (with the self-hostable check endpoint's examples, §6.3) | the server-side exit check (job `vpn.exit-check`, only with a check URL), `exit` in `GET /api/vpn/locations` for clients the access policy admits, `POST /api/vpn/locations/:id/check`, `verify_url` from `GNOME_VPN_CHECK_URL`, metrics | g1's day-one config fields, `RateClass::VpnCheck`, the Cargo dependencies (§3.1); `gateway::health::Upstreams` (read through `state.ext::<Gateway>()`); the access check `mint_ticket` uses (`auth::extract::{resolve_user, resolve_anon}`, read only; never issuing a cookie) |
| **g2** games UI | new `frontend/src/games/**` (`types.ts`, `api.ts`, `catalog.svelte.ts`, `library.svelte.ts`, `player.ts`, `copy.ts`, `start.ts`, `components/**`, `testing/**`, tests); `frontend/src/pages/games/**`; `frontend/src/main.ts` (the two `onIdle` lines of §3.2, nothing else) | the Games page, the detail page, the player (with D24's notice), favorites and recently played, the `gamesRecent` clearer's use and the new `gamesNetworks` clearer (registered from `start.ts` through `registerClearer`), `registerFeature('games')` (last) | `/api/games*` and `/play-frame/<slug>` (g1; `testing/fake-api.ts` until it lands), `/api/config` |
| **v1** VPN page + client | new `frontend/src/vpn/**` (`types.ts`, `api.ts`, `state.svelte.ts`, `copy.ts`, `start.ts`, `testing/**`, tests); `frontend/src/pages/vpn/**`; `frontend/src/settings/local-vpn.ts` (new, + test), `frontend/src/settings/store.svelte.ts` (`import()` only), `frontend/src/settings/sync.ts` (`withDeviceSettings()` only: the local-picture pattern needs no `syncedPart()` change, §7.1), `frontend/src/settings/defaults.ts` (`vpn.verifyExit: false` only, D15) and their tests | the VPN page, the VPN state (locations, exits, the app's connection facts), the tab-strip chip status (`reportStatus('vpn')`), device-local `vpn.mode` and `vpn.killSwitch` (D12), the pure `decideAutoConnect` | `/api/vpn/locations` (v2 adds `exit`), the read-only getters `browser.vpnLocation`, `browser.status`, `browser.engineState` |
| **v3** VPN wiring and route-bound tickets (after step 3's integration) | `frontend/src/browser/browser.svelte.ts`, `frontend/src/browser/engine/{snapshot,tickets}.ts`, `frontend/src/lib/api.ts` (`requestWispTicket`'s route only), `frontend/src/browser/ui/{ErrorOverlay.svelte,error-copy.ts}`, `frontend/src/browser/testing/fake-engine-host.ts` (+ their tests); `frontend/src/pages/settings/{sections/Vpn.svelte,registry.ts}` (texts of §10 only); `frontend/src/engine-host/vpn-verify.ts` (its header comment only); `frontend/src/vpn/start.ts` and `src/pages/vpn/**` (handed over by v1); **backend** `backend/src/gateway/{ticket,mod}.rs` and the tests that mint or check tickets (`backend/tests/{wisp_tickets,gateway,wisp_probe,roles,holywisp_e2e}.rs`; D23) | `browser.verifyExit()`, one location-status source for the route choice (v1's state), the Automatic-location rule (D17), auto-connect inside the browser's start (§8.1), route-bound `w2` tickets (D23), the overlay's VPN link, the "tabs on the previous route" count, `registerFeature('vpn')` (last) | v1's `vpnState`, v2's `exit` |
| **t** e2e fixtures and suites | new `tests/e2e/engine/suites/{backend-games,games-ui,games-player,vpn-ui}.mjs` and helpers `games-lib.mjs`, `vpn-lib.mjs`; `tests/e2e/engine/fixtures/games/**`, `tests/e2e/engine/fixtures/vpn/**`; `tests/e2e/engine/servers/vpn-check.mjs`; the no-internet variables in the base environments of `tests/e2e/engine/suites/{backend-lib,library-lib}.mjs`, `tests/e2e/stack/*.mjs`, `tests/e2e/settings/*.mjs` and `tests/e2e/about/about-qa.mjs` (day one); `tests/e2e/stack/stack-qa.mjs`'s shell framing check (`frame-ancestors 'none'`, with g1's day one); after step 3's integration: `tests/e2e/engine/suites/{transport,backend-proxy}.mjs` where they mint a ticket for a profile path (with v3's D23); after D20's registrations: the expectations in `tests/e2e/settings/{settings-qa,settings-features-qa}.mjs` and `tests/e2e/about/about-qa.mjs` | the replay indexes, the OSS test game, the embed fixture page, the check service fixture, every Wave C row (§9) | everything above; one change request to step 3's x5 (§2.2) |
| **Wave C integration** (after step 3's integration step and v3) | the documents of §14, `frontend/src/pages/about/**` (known limitations), `docs/PROGRESS.md` | the final matrix (§13.2), the README sections | everything |

Directory map (ARCHITECTURE §3 lists `src/games/` "api.ts, store.ts, components/" and `src/vpn/` "gateway.ts, verify.ts,
store.ts"; Wave C uses these names instead, and the integration step corrects §3):

```
backend/src/games/          g1: the games module (catalog wiring, routes, admin, jobs, thumbnails, frames, OSS, replay)
backend/src/vpn/            v2: + exit.rs (checker, job, API), wisp_client.rs (Wisp v1 stream over one TCP connection)
frontend/src/games/         g2: types, API client, listing state, favorites/recent, player rules, copy, start
  components/               g2: GameTile, GameRow, GameShelf, CatalogToolbar, PlayerFrame, LicensePanel, …
frontend/src/vpn/           v1: types, API client, state (locations, exits, connection facts), copy, start
frontend/src/pages/games/   g2: GamesPage, GameDetailPage, PlayPage
frontend/src/pages/vpn/     v1: VpnPage (+ its parts)
tests/e2e/engine/           t:  suites/{backend-games,games-ui,games-player,vpn-ui}.mjs, fixtures/{games,vpn}/**, servers/vpn-check.mjs
```

### 2.2 Wave C beside Wave B step 3

| | Runs beside step 3 | Why it can |
| --- | --- | --- |
| g1 | yes, from step 3's day one | step 3 edits `backend/src/filters/**` in the backend (x5), plus, per WAVE-B3 §8, the `config check` marking of file lists. Both lanes compile the same crate: land the day-one change (§3.1) as one compiling step in the first hours, then keep `cargo check --workspace` green after every edit; g1 never edits `backend/src/filters/**`. **Two declared overlaps**, each confined to one function: in `backend/src/cli.rs` x5 edits only `config_check` and g1 only the command dispatch (the `catalog` arm) and the usage text; in `backend/src/admin/mod.rs` x5 edits only what concerns filter lists and g1 only the `catalog` placeholder and the `config` keys. Whoever edits second re-reads the file right before editing and keeps the change inside its function. **The About crate list**: g1's day-one `Cargo.lock` change adds `tar`, `filetime`, `tokio-tungstenite`, `tungstenite` and their new transitive crates to gnome-server's normal graph, which turns `licenses.test.ts` red until the generated list is rewritten: the change request to x4 below |
| v2 | yes, once g1's day-one change has landed (it can write code against §3.1 before that) | `backend/src/vpn/**` and `services/vpn/**` belong to no step-3 lane |
| g2 | yes | `src/games/**` and `src/pages/games/**` belong to no step-3 lane; `src/main.ts` is not step-3 owned (x1 owns `src/engine-host/main.ts`, a different file); g2 adds no frontend dependency (x1 owns `frontend/package.json`) |
| v1 | yes | `src/vpn/**`, `src/pages/vpn/**` and `src/settings/{local-vpn,store.svelte,sync}.ts` belong to no step-3 lane (x4 owns `src/pages/settings/**`, not `src/settings/**`; step 3's integration edits only a comment in `settings/schema.ts`, which Wave C does not touch) |
| t | yes | new suite, fixture and server files are discovered by `run.mjs` without a runner change (`discoverSuites()`, `export const standalone = true`); the runner's base environment needs two variables (below) |
| v3 | **no: after step 3's integration step** | x4 owns `browser.svelte.ts`, `engine/snapshot.ts`, `ui/ErrorOverlay.svelte`, `ui/error-copy.ts`, `testing/fake-engine-host.ts` and `src/pages/settings/**` until then. The gateway part of D23 (`backend/src/gateway/**`, no step-3 lane's) lands in the same step as the app's ticket change, because a route-bound ticket breaks an app that does not send its route |
| text changes in `src/pages/settings/**`, `src/pages/about/**` | **no: v3 / the Wave C integration step** | x4 |
| documents | **no: the Wave C integration step** | x5 and step 3's integration step edit `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/ENGINE-PROTOCOL.md`, `backend/README.md`, `docs/PROGRESS.md` |

**Change request to step 3's lane x5** (`tests/e2e/engine/lib/stack.mjs`, `startGnomeServer`'s `base` env): add
`GNOME_CATALOG_REFRESH_HOURS: '0'` and `GNOME_OSS_FETCH: 'manual'`. Once g1 lands, a gnome-server started with the
defaults imports the GamePix feed from the internet 30 s after start and fetches OSS builds from GitHub; the
runner's shared server must not (and `--offline` runs could not). Both variables are harmless before g1 lands
(`GNOME_CATALOG_REFRESH_HOURS` is already in `VARS`, an unknown environment variable is ignored). If x5 has
finished, the Wave C integration step applies it; Wave C suites that need a catalog start their own server (§9).
The other scripts that start a gnome-server (`suites/backend-lib.mjs`, `suites/library-lib.mjs`, `tests/e2e/stack/*.mjs`,
`tests/e2e/settings/*.mjs`, `tests/e2e/about/about-qa.mjs`) belong to no step-3 lane: lane t adds the same two
variables to their base environments on day one, so no test run imports a live feed (≈ 156 requests, ≈ 40 MB) or
downloads from GitHub; a row of `backend-games` asserts `/admin/catalog/imports` stays empty on such a server.

**Change request to step 3's lane x4** (`frontend/src/pages/about/licenses.ts`, the generated block between
`// BEGIN RUST_CRATES` and `// END RUST_CRATES` only): lane g1 runs `node frontend/scripts/rust-crates.mjs` in the
same step as its day-one `Cargo.lock` change (and after any later Wave C `Cargo.lock` change), which rewrites only
that block, and adds any new license id to `LICENSES` if the script reports one. x4 is told before g1's day one; if
x4 prefers to run the script itself, g1's day-one change waits until x4 has, and the two land together. No other
line of `src/pages/about/**` is touched before step 3's integration step.

Order inside the wave:

```
step 2 integration part 2 done
 └─ step 3 day one ─────────────────────────────────────────────── step 3 integration step ─┐
    g1: day-one core (§3.1, with the About crate list) → M1 read routes + prepare + wrapper /play-frame/
        → M2 thumbnails → M3 admin, jobs, CLI, replay → M4 OSS review, fetch + /oss/ → M5 metrics, diagnostics, /ads.txt
    v2: (after g1 day one) Wisp client + TLS → checker → job + API (access-gated exit) → on-demand check
    g2: day one (§3.2) → pages on fake-api.ts → real routes (after g1 M1) → player + notice (after g1's wrapper)
        → favorites, recent, settings keys → registerFeature('games') last (D20)
    v1: day one (§3.2) → state + page on fakes → device-local vpn.mode/killSwitch → exits (after v2) → chip status
    t:  fixtures + base envs day one → backend-games rows as g1 lands → games-ui/games-player rows as g2 lands
        → vpn-ui rows (page rows after v1; routing, blocking, ticket and auto-connect rows after v3)
                                                                                            └─ v3 (app + D23 gateway)
                                                                                               → t's last rows
                                                                                               → Wave C integration
                                                                                               (docs, About, matrix)
                                                                                               → review → fixes
```

## 3. New shared code (day one)

Everything in this section is exact. Lane g1 lands §3.1 as one compiling change in its first hours (lane v2 codes
against it from its first hour and compiles once it is in); lanes g2 and v1 create their §3.2 files on their first
day; nobody else edits these files in Wave C.

### 3.1 Backend (lane g1, day one)

**Dependencies.** Root `Cargo.toml` `[workspace.dependencies]` gains

```toml
# OSS game builds: GitHub's commit tarballs (gzip via flate2, already a dependency). No xattr support.
tar = { version = "0.4", default-features = false }
```

and `backend/Cargo.toml` moves four test-only dependencies to `[dependencies]` and adds two (all except `tar` are
already in `Cargo.lock`, so the lock gains `tar`, `filetime` and whichever of their small dependencies it lacks):

```toml
[dependencies]
# … existing …
tar.workspace = true
# Wave C: the server-side VPN exit check speaks Wisp over a WebSocket and TLS through it (backend/src/vpn/exit.rs).
futures-util.workspace = true
rustls.workspace = true
tokio-rustls.workspace = true
tokio-tungstenite.workspace = true
webpki-roots.workspace = true

[dev-dependencies]
tempfile.workspace = true
tokio = { workspace = true, features = ["test-util"] }
```

The lane checks the newest `tar` 0.4.x release before pinning it in `Cargo.lock`. Moving `tokio-tungstenite` to
`[dependencies]` also brings `tungstenite` and its dependencies into gnome-server's normal graph. In the same step
the lane runs `node frontend/scripts/rust-crates.mjs` (the §2.2 change request to x4: it rewrites only the generated
block of `src/pages/about/licenses.ts`) and checks that `cd frontend && npm test` (`licenses.test.ts`) is green; the
day-one checklist is: `cargo check/clippy/fmt`, the existing cargo tests, `licenses.test.ts`.

**Configuration** (`backend/src/config.rs`). The four `inactive(…, GAME_CATALOG)` markers go (the module reads them
now) and `VARS` gains the crate's own variables, which `CatalogConfig::from_env` reads (so a `GNOME_CONFIG` file
accepts them and `config check` prints them), plus Wave C's new ones. In `VARS` order, after `GNOME_ENGINE_DEFAULT`:

```rust
    var("GNOME_CATALOG_REFRESH_HOURS", "24", "hours between game catalog imports of each source; 0 = only on request"),
    var(
        "GNOME_CATALOG_SOURCES",
        "gamepix,oss",
        "game catalog sources: gamepix, gamedistribution, playgama, gamemonetize, famobi, itchio, js13k, oss; none = no catalog",
    ),
    var("GNOME_GAMEPIX_SID", "1", "GamePix publisher SID (1 = the public default SID)"),
    var("GNOME_GD_PUBLISHER_ID", "", "GameDistribution publisher ID (required to enable gamedistribution)"),
    var("GNOME_PLAYGAMA_CLID", "", "Playgama partner CLID (required to enable playgama)"),
    var("GNOME_GAMEMONETIZE_ENABLED", "false", "enable gamemonetize (after adding this site in the GameMonetize dashboard)"),
    var("GNOME_FAMOBI_AFFILIATE_ID", "", "Famobi affiliate ID (required to enable famobi)"),
    var("GNOME_ITCHIO_FEEDS", "games/free/platform-web", "itch.io browse paths, comma-separated (link-out records)"),
    var("GNOME_ITCHIO_MAX_PAGES", "3", "pages per itch.io feed (1-20)"),
    var("GNOME_JS13K_FIRST_YEAR", "2012", "first js13kGames year (link-out records)"),
    var("GNOME_OSS_MANIFEST", "", "open-source games manifest; empty = the manifest built into gnome-server"),
    var("GNOME_OSS_GAMES_DIR", "", "where open-source game builds live; empty = $GNOME_DATA_DIR/oss-games"),
    var("GNOME_OSS_REQUIRE_BUILDS", "true", "list only open-source games whose build exists"),
    var("GNOME_OSS_FETCH", "auto", "fetch missing open-source builds in the background: auto | manual"),
    var("GNOME_OSS_MAX_MB", "512", "disk cap for all open-source game builds together, in MiB (16-65536)"),
    var("GNOME_CATALOG_BLOCKLIST", "", "extra trademark/knock-off terms, comma-separated (!term removes a default)"),
    var("GNOME_CATALOG_BLOCKLIST_FILE", "", "file with one blocklist term per line (title:, start:, label: scopes)"),
    var(
        "GNOME_CATALOG_DEDUP_ORDER",
        "playgama,gamepix,gamedistribution,gamemonetize,famobi,oss,itchio,js13k",
        "preferred listing when one game is in several sources",
    ),
    var("GNOME_CATALOG_USER_AGENT", "", "User-Agent of catalog feed requests; empty = GNOME-catalog/<version>"),
    var("GNOME_GAMES_EMBED_HOSTS", "", "developer hosts approved for game embeds, comma-separated DNS names"),
    var("GNOME_ADS_TXT", "", "file served as /ads.txt on the app origin (lines from your game networks)"),
```

`GNOME_THUMB_PROXY` and `GNOME_THUMB_CACHE_MB` keep their rows (help of the latter: "disk cap for the thumbnail
cache in MiB; 0 = no disk cache"). After `GNOME_VPN_PROFILES`:

```rust
    var_empty_ok(
        "GNOME_VPN_CHECK_URL",
        "",
        "exit check service for VPN locations (HTTPS JSON with ip, country, city); empty = no exit checks",
    ),
    var_empty_ok("GNOME_VPN_CHECK_URL_V6", "", "the same check service under an IPv6-only name; empty = IPv6 not checked"),
    var("GNOME_VPN_CHECK_INTERVAL_MIN", "15", "minutes between server-side exit checks of each location; 0 = on request only"),
    var(
        "GNOME_VPN_EGRESS_SHARED_OK",
        "false",
        "true = your VPN egress's terms allow every person who can use this instance (silences the terms warning)",
    ),
```

(`var_empty_ok`: an explicitly empty value is accepted and means off, D15. Lane v2 adds the tests that a default
server answers `GET /api/vpn/locations` with `verify_url: null` and registers no `vpn.exit-check` job.)

New `Config` fields (`catalog_sources: Vec<String>` is replaced by `catalog`):

```rust
/// `GNOME_OSS_FETCH`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OssFetch {
    /// The `catalog.oss-fetch` job fetches missing or outdated builds of enabled manifest entries.
    Auto,
    /// Only `gnome-server catalog fetch-oss` and `POST /admin/catalog/oss-fetch` fetch.
    Manual,
}

pub struct Config {
    // … existing fields; `catalog_sources` removed …
    /// The catalog crate's configuration, parsed by `gnome_catalog::CatalogConfig::from_env` over the same merged
    /// variables (environment over `GNOME_CONFIG` file), with `GNOME_DATA_DIR` passed through. Its `sources` are the
    /// usable ones: gated on operator IDs by the crate, then by the server: `oss` needs two origins (D5),
    /// `gamedistribution` a known app origin (its referrer URL, D2). Empty `sources` = no games module.
    pub catalog: gnome_catalog::CatalogConfig,
    pub catalog_refresh_hours: u32,
    pub thumb_proxy: bool,
    pub thumb_cache_mb: u32,
    /// `GNOME_GAMES_EMBED_HOSTS`: lowercase DNS names (≥ 2 labels, no IP, port or wildcard, ≤ 64 entries, never an
    /// app or proxy origin host).
    pub games_embed_hosts: Vec<String>,
    pub oss_fetch: OssFetch,
    /// `GNOME_OSS_MAX_MB` (16–65536).
    pub oss_max_mb: u32,
    /// `GNOME_ADS_TXT`: an absolute path (validated like `GNOME_FILTER_LISTS_FILE`; a missing file is a warning).
    pub ads_txt: Option<PathBuf>,
    /// `GNOME_VPN_CHECK_URL` (`None` when empty, the default): an absolute `https://` URL without credentials,
    /// ≤ 2048 bytes; a plain `http://` URL is accepted with a warning (the e2e fixture uses one through the test-only
    /// HolyWisp).
    pub vpn_check_url: Option<String>,
    /// `GNOME_VPN_CHECK_URL_V6` (`None` when empty): same rules; only together with `vpn_check_url`.
    pub vpn_check_url_v6: Option<String>,
    /// `GNOME_VPN_CHECK_INTERVAL_MIN` (0–1440; 0 = on request only).
    pub vpn_check_interval_min: u32,
    /// `GNOME_VPN_EGRESS_SHARED_OK` (D16).
    pub vpn_egress_shared_ok: bool,
}
```

Parsing: `CatalogConfig::from_env(|k| p.raw.get(k).map(|(v, _)| v.clone()).or_else(|| (k == "GNOME_DATA_DIR").then(|| data_dir.display().to_string())))`;
a `CatalogError::Config(msg)` becomes a problem, each returned warning a warning. A unit test records every key
`from_env` asks for and asserts that each is in `VARS` (so the crate cannot grow a variable the server's file
parser refuses). Cross-field rules, each with a test:

- `oss` enabled in single-origin mode → removed, warning "open-source games need a separate proxy origin
  (GNOME_PROXY_ORIGIN or GNOME_PROXY_BIND); they are never served from the app origin".
- `gamedistribution` enabled while no app origin is known (single-origin mode without `GNOME_PUBLIC_ORIGINS`) →
  removed, warning "gamedistribution needs GNOME_PUBLIC_ORIGINS: its embeds must name the page that shows them".
- `GNOME_VPN_PROFILES` set, `GNOME_VPN_EGRESS_SHARED_OK` not `true`, and either `GNOME_ACCESS_MODE=open` or
  `GNOME_ACCESS_MODE=accounts` with `GNOME_REGISTRATION=open` → warning (D16): "VPN locations are usable by everyone
  who can open this server or register on it. Use only VPN egress whose terms allow every person who can use this
  instance; consumer VPN subscriptions (Mullvad's among them) do not allow offering the VPN to others. GNOME's access
  modes do not change what a provider's terms allow. Set GNOME_VPN_EGRESS_SHARED_OK=true only if your egress's terms
  allow this use." Tests: open; accounts with open registration; accounts with closed registration (no warning);
  code (the warning below); each with `GNOME_VPN_EGRESS_SHARED_OK=true` (silent).
- `GNOME_VPN_PROFILES` set with `GNOME_ACCESS_MODE=code` (and the attestation not set) → warning "VPN locations are
  usable by everyone who has the access code: keep the code within the people your VPN egress's terms allow".
- `GNOME_VPN_PROFILES` set and `GNOME_VPN_CHECK_URL` empty → warning "no exit checks: set GNOME_VPN_CHECK_URL to a
  check service you run or are allowed to use (services/vpn/README.md \"Verify\")". `GNOME_VPN_CHECK_URL_V6` without
  `GNOME_VPN_CHECK_URL` → problem.
- `GNOME_THUMB_PROXY=false` with a catalog → warning "thumbnails load from the game networks' image servers in
  visitors' browsers, which then see their IP addresses".
- `GNOME_VPN_CHECK_URL` with `http:` → warning "the VPN exit check is sent unencrypted".
- `GNOME_GAMES_EMBED_HOSTS` entry that is malformed, an IP literal, has a port or wildcard, or equals an app or proxy
  origin host → problem naming the entry.

**Rate classes** (`backend/src/security/rate_limit.rs`): three variants, with their limits (per client IP,
multiplied by `GNOME_RATE_LIMIT_SCALE`) and their `snake_case` names in metrics and API.md:

```rust
pub enum RateClass {
    Api, SessionCreate, Auth, Sync, WispTicket, WispUpgrade, Admin,
    /// `GET /api/thumb/:id`, counted instead of `Api` (a long scroll loads hundreds): 600 burst / 1200 per min.
    Thumb,
    /// Thumbnail cache misses that need an upstream fetch: 60 burst / 120 per min.
    ThumbFetch,
    /// `POST /api/vpn/locations/:id/check`: 6 burst / 6 per min (lane v2 adds a 60 s gap per location).
    VpnCheck,
}
// RateClass::ALL becomes [RateClass; 10]; names "thumb", "thumb_fetch", "vpn_check".
```

`backend/src/router.rs` `api_guard`: `RateClass::Thumb` for paths starting with `/api/thumb/`, `RateClass::Api`
for every other `/api/*` path (one bucket per request, as today).

**Module start-up hook** (`backend/src/module.rs`, `backend/src/server.rs`):

```rust
// module.rs, in `trait Module`
    /// Start-up work that must be done before the first request is answered (`server::serve_all` awaits every
    /// module's `prepare` in mount order before it starts the jobs and the accept loops). It never fails the start:
    /// a module reports problems in `diagnostics` and degrades (D21).
    fn prepare<'a>(&'a self, _state: &'a AppState) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

// module.rs, `builtin_modules_with`: the VPN module publishes its exit checker (lane v2, §6.1) …
    modules.push(crate::vpn::install(setup)); // replaces `Arc::new(crate::vpn::Vpn)`; day one
// … and, after the filters module, the games module: added with M1 (when `backend/src/games/` exists), not on day
// one, so no stub module is ever mounted. Tests pass their own options through `builtin_modules_with_games`.
    if let Some(games) = crate::games::install(setup, games_options) {
        modules.push(games);
    }

/// `builtin_modules_with(setup, gateway)` stays (it calls this with `GamesOptions::default()`).
pub fn builtin_modules_with_games(
    setup: &mut ModuleSetup<'_>,
    gateway: crate::gateway::GatewayOptions,
    games_options: crate::games::GamesOptions,
) -> Vec<Arc<dyn Module>>; // added with M1

// state.rs
impl AppState {
    /// Await every module's `prepare` in mount order (D21). Called by `server::serve_all` before `start_jobs()`, by
    /// the `catalog` CLI, and by `backend/tests/common` `TestApp::with_modules` after `open_with`.
    pub async fn prepare_modules(&self);
}
```

**The shell's frame headers** (`backend/src/security/csp.rs`; the constant `GAME_EMBED_HOSTS` is deleted, and the
shell policy needs no run-time state because game frames get their own wrapper policy, D2/D4):

```rust
/// `SHELL_DIRECTIVES` changes: `frame-src 'self'` (+ the proxy origin: the engine host; `'self'`: the game wrapper
/// `/play-frame/<slug>`), `img-src 'self' data: blob: https:` (+ the proxy origin: OSS thumbnails, plain HTTP in
/// development), `frame-ancestors 'none'` (nothing frames the SPA shell). Signatures unchanged:
pub fn shell_policy(proxy: &ProxySetup, script_hashes: &[String]) -> String;
pub fn headers_for(mode: CspMode, proxy: &ProxySetup, script_hashes: &[String]) -> CspHeaders;
/// What shell HTML gets as its enforced policy in report-only and off modes (replaces `FRAME_ANCESTORS_ONLY` there;
/// non-HTML app answers keep `FRAME_ANCESTORS_ONLY`).
pub const SHELL_FRAME_ANCESTORS_ONLY: &str = "frame-ancestors 'none'";

/// Policy of a game wrapper document (D2), rendered per request by `games::frames`:
/// `default-src 'none'; frame-src <frame_source>; style-src '<WRAPPER_STYLE_HASH>'; base-uri 'none';
/// form-action 'none'; frame-ancestors 'self'`. `frame_source` is `https://<host>[:port]` for a network or developer
/// embed, `<proxy origin>/oss/<slug>/` for an OSS game; callers pass only values `FramePolicy::allows` accepted.
pub fn wrapper_csp(frame_source: &str) -> String;

/// Policy of open-source game documents under `/oss/` (D5): `PROXIED_DOCUMENT_CSP; frame-ancestors <app origins>`;
/// for an `isolated = true` entry (§4.8 item 5) `; sandbox allow-scripts` is added (`allow-pointer-lock` too when the
/// entry declares `pointer_lock = true`): an opaque origin with no access to the proxy realm.
pub fn oss_document_csp(app_origins: &[&str], isolated: bool, pointer_lock: bool) -> String;

/// `Permissions-Policy` of app-origin HTML (D3). Every name must be one Chromium recognizes (an e2e row checks the
/// console); fullscreen, autoplay, gamepad, clipboard-write and the motion sensors are left to iframe `allow`.
pub const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), \
    hid=(), bluetooth=(), midi=(), display-capture=(), screen-wake-lock=(), idle-detection=(), \
    publickey-credentials-get=(), publickey-credentials-create=(), otp-credentials=(), identity-credentials-get=(), \
    xr-spatial-tracking=(), local-fonts=(), window-management=()";

/// `Cross-Origin-Opener-Policy` of app-origin HTML (D3).
pub const OPENER_POLICY: &str = "same-origin";
```

`backend/src/security/headers.rs`: app-role HTML also gets `Cross-Origin-Opener-Policy` and `Permissions-Policy`
unless the handler set them (the middleware's existing "fill in what the handler did not set" rule). The shell CSP
stays precomputed. `backend/src/static_files.rs`: shell HTML (`ResponseCsp::Shell`, every HTML file of the build
except the engine host's) also gets `X-Frame-Options: DENY` (the middleware's `SAMEORIGIN` default stays for every
other app answer, the wrapper included); `/oss/` and `/play-frame/` are never answered by the SPA fallback (`/oss/`
joins `proxy_only()`: a plain 404 on the app role in two-origin mode; `/play-frame/` is a games-module route).
`backend/src/lib.rs`: `pub mod games;` (with M1). `backend/src/cli.rs`: the `catalog` command of §4.6, implemented in
`games::cli` (with M3). Until lane v2 lands `crate::vpn::install`, g1's day-one change adds it to
`backend/src/vpn/mod.rs` as `pub fn install(_setup: &mut ModuleSetup<'_>) -> Arc<dyn Module> { Arc::new(Vpn) }` —
the one line g1 writes in v2's directory, which v2 then owns (it is the module's real constructor, not a stub). The
day-one change updates the tests that pin the shell's frame headers (`roles.rs`: `frame-src 'self' <proxy origin>`
and `frame-ancestors 'none'`; the `csp.rs` and `headers.rs` unit tests) and tells lane t to update
`tests/e2e/stack/stack-qa.mjs`'s "app: frame-ancestors 'self'" check in the same step.

### 3.2 Frontend (lanes g2 and v1, day one)

**`frontend/src/main.ts`** (lane g2; two lines appended after the `startBrowser` line; the VPN line as soon as lane
v1 reports `src/vpn/start.ts` landed):

```ts
// Games (src/games): registers 'games' while the server offers a catalog, and the "Recently played games" clearer.
onIdle(() => void import('./games/start').then((m) => m.startGames()));
// VPN (src/vpn): location and exit status, the tab-strip chip (docs/WAVE-C.md §7). Auto-connect is not here: the
// browser decides it in its own start, before any tab loads (§8.1).
onIdle(() => void import('./vpn/start').then((m) => m.startVpn()));
```

**`frontend/src/games/types.ts`** (lane g2; the wire shapes of §4.2):

```ts
/** A GNOME category slug: the 14 core ones always, `shooter` `io` `card` `educational` `music` when used. */
export type CategorySlug = string;
export type SourceId = 'gamepix' | 'gamedistribution' | 'playgama' | 'gamemonetize' | 'famobi' | 'itchio' | 'js13k' | 'oss';
export type GameSort = 'relevance' | 'popular' | 'trending' | 'new' | 'featured' | 'az';
export type GameFlag = 'kids_friendly' | 'no_blood' | 'no_cruelty' | 'iap' | 'paid';

export interface GameSummary {
  id: number;
  slug: string;
  title: string; // plain text: render as text, never as HTML ("Press <Space>")
  developer: string | null;
  /** `/api/thumb/<id>`, a network image URL (thumbnail proxy off) or `<proxy origin>/oss/…`; null = none. */
  thumbnail: string | null;
  categories: CategorySlug[]; // primary first, at most 3
  mobile: boolean;
  source: SourceId;
  added_at: number; // ms
  plays: number;
  /** false = link-out only (itch.io, js13kGames): open source_url in a new tab, never frame it. */
  playable: boolean;
}

export interface GameDetail extends GameSummary {
  description: string;
  instructions: string;
  tags: string[];
  embed_url: string;
  width: number | null;
  height: number | null;
  source_url: string | null;
  developer_url: string | null;
  license: string | null; // SPDX, OSS only
  published_at: number | null;
  attribution: string; // "via GamePix", or "<SPDX> · <copyright>" for OSS
  embed_kind: 'iframe' | 'selfhost' | 'link';
  orientation: 'landscape' | 'portrait' | 'any' | null;
  flags: GameFlag[];
  /** This server frames the game (D4): `/play-frame/<slug>` answers 200. false: offer source_url instead. */
  embed_allowed: boolean;
  /** Self-hosted games only (`repository` is null for an operator's own `local` build, §4.8). */
  oss: { repository: string | null; commit: string | null; license_file_url: string | null } | null;
}

/** The game networks a frame can come from (D24's notice is per network); OSS games need none. */
export type NetworkId = Exclude<SourceId, 'itchio' | 'js13k' | 'oss'>;

export interface GamePage { game: GameDetail; related: GameSummary[] }
export interface GameListPage { items: GameSummary[]; next_cursor: string | null; total: number }
export interface GameSections { featured: GameSummary[]; trending: GameSummary[]; popular: GameSummary[]; new: GameSummary[] }
export interface GameCategory { slug: CategorySlug; name: string; count: number }
export interface GameTag { tag: string; count: number }
export interface GamesStatus {
  listed: number;
  /** Listed games that play here (embeds and OSS); `listed - playable` open on other sites (itch.io, js13kGames). */
  playable: number;
  importing: boolean;
  sources: Array<{
    id: SourceId;
    name: string; // display name: "GamePix", "Open source"
    last_import: { status: 'complete' | 'incomplete' | 'failed' | 'interrupted'; finished_at: number } | null;
  }>;
}

/** `GET /api/games` parameters (the UI never sends `cursor` with changed filters). */
export interface GameListQuery {
  q?: string;
  category?: CategorySlug;
  tag?: string;
  sort?: GameSort;
  mobile?: boolean;
  exclude?: CategorySlug[];
  include_link_out?: boolean;
  cursor?: string;
  limit?: number; // 1–100, the UI uses 48
}
```

**`frontend/src/vpn/types.ts`** (lane v1; `GET /api/vpn/locations` with lane v2's `exit`, §6.2):

```ts
export type LocationStatus = 'up' | 'down' | 'unknown';
export type ExitError = 'upstream_unreachable' | 'connect_failed' | 'tls_failed' | 'http_status' | 'bad_answer' | 'timeout';

export interface VpnExit {
  /** ok = the service answered; failed = see error; unchecked = not yet, or not shown to this client (no session the
   *  access policy admits, §6.2); off = this server runs no exit checks. */
  state: 'ok' | 'failed' | 'unchecked' | 'off';
  ip: string | null;
  country: string | null;
  city: string | null;
  /** The service's own "this is one of our exits" flag (`mullvad_exit_ip` at am.i.mullvad.net); null = not said. */
  provider_exit: boolean | null;
  /** The service's country against the profile's: null when it cannot tell. */
  country_match: boolean | null;
  checked_at: number | null;
  error: ExitError | null;
  /** The IPv6 check (`GNOME_VPN_CHECK_URL_V6`); null when the server checks no IPv6 name. */
  v6: { state: 'ok' | 'failed' | 'unchecked'; ip: string | null; error: ExitError | null } | null;
}

export interface VpnLocation {
  id: string;
  label: string;
  country_code: string; // lowercase ISO 3166-1 alpha-2
  country: string;
  city: string;
  provider_note: string; // operator text, may be empty: render as text
  path: string;
  status: LocationStatus; // the health probe: the location's instance answers (not: its exit works)
  checked_at: number | null;
  exit: VpnExit;
}

export interface VpnLocations {
  profiles: VpnLocation[];
  verify_url: string | null; // null = no exit checks on this server
  check_service: string | null; // the check URL's host, for wording
}

export interface VpnLocationRef { id: string; label: string }
/** Exit-check failures are not here: they never change the connection (D14), they add a warning. */
export type VpnUnusable = 'location-down' | 'location-gone' | 'no-location';

/** What the VPN page and the chip show: the app's own facts (D13); `exitWarning` = the server's last check of that
 *  location failed (D14). */
export type VpnConnection =
  | { kind: 'off' }
  | { kind: 'connecting'; location: VpnLocationRef; exitWarning: ExitError | null }
  | { kind: 'connected'; location: VpnLocationRef; engine: 'running' | 'not-started'; exitWarning: ExitError | null }
  | { kind: 'blocked'; location: VpnLocationRef | null; reason: VpnUnusable } // kill switch on
  | { kind: 'fallback'; location: VpnLocationRef | null; reason: VpnUnusable }; // kill switch off: default route
```

### 3.3 Test contract (accessible names the suites use)

Lane t writes its suites against these roles and names from day one; lanes g2 and v1 render exactly them (a
change goes through both lanes' reports). Sentence case, as DESIGN §13.

| Page | Element | Role / name |
| --- | --- | --- |
| `/games` | title | `heading` level 1 "Games" |
| | search | `searchbox` "Search games" |
| | category | `combobox` "Category" (first option "All categories") |
| | sort | `combobox` "Sort" (options "Popular", "Trending", "New", "A–Z", "Featured"; "Best match" while searching) |
| | shelves | `region` "Favorites", "Recently played", "Featured", "Trending", "Popular", "Recently added", each with a `list` of `link`s named by game title |
| | grid | `grid` "All games" (or "Search results", "<Category name> games"); each `gridcell` holds one `link` named by game title |
| | count | `status` "<n> games" (or "<n> results") |
| | filters in force | `link` "Touch screens only" / "<n> hidden categories" (to Settings → Games) |
| | empty / error | `heading` "No games yet" (catalog empty), "No games match" (+ `button` "Clear search"), "Games are not available on this server", "Games could not be loaded" (+ `button` "Try again") |
| | link-out tile | its link's name ends with "(opens on itch.io)" / "(opens on js13kGames)" (search results, category and tag grids only, §5.1) |
| | network choices | text "Game networks you allowed: <names>" with `button` "Forget" (only when this browser allowed one, D24) |
| `/games/:slug` | title | `heading` level 1 = game title; text "via <network>" |
| | play | `link` "Play" (to `/play/<slug>`), or `link` "Open on <host>" (new tab) when not playable here |
| | favorite | `button` "Add to favorites" / "Remove from favorites" (`aria-pressed`) |
| | sections | `region` "About this game", "How to play", "Tags", "License" (OSS: license, copyright, `link` "Source code", `link` "License text"), "More like this" |
| | gone | `heading` "This game is not available" |
| `/play/:slug` | notice (D24) | `region` "Before you play" with the text "This game loads from <network>. …" and `button` "Play"; no frame exists until it is pressed |
| | frame | `iframe` with `title` "<game title> (game)" and `src` `/play-frame/<slug>`; inside it the wrapper's one `iframe` with the same title |
| | controls | `button` "Fullscreen" / "Exit fullscreen", `button` "Add to favorites", `link` "Game details" |
| | note | text "Loaded directly from <network>. Not routed through GNOME or its VPN." (OSS: "Served by this GNOME server.") |
| | link-out fallback | `link` "Problems? Open on <host>" |
| `/vpn` | title | `heading` level 1 "VPN" |
| | state | `status` "Connection": one of "Off", "Connecting to <label>", "Connected to <label>", "Ready: <label>" (no engine host yet), "Blocked: <label> is down", "Not in use: <label> is down" (and the other `VpnUnusable` texts of §7.3) |
| | actions | `button` "Connect" / "Disconnect" |
| | locations | `listbox` "Locations"; `option`s named by label, `aria-selected` on the chosen one, each with "Online", "Offline" or "Not checked yet" |
| | exit warning | text "The exit check through <label> fails: <reason>" (D14; the state text is unchanged) |
| | exit | `region` "Exit check": "<service> reports <ip> in <city>, <country>", `button` "Check again"; without a check service the text "This server runs no exit checks." |
| | previous route (v3) | text "<n> tabs may still use the previous route until you reload them" ("1 tab may still use the previous route until you reload it") |
| | switches | `switch` "Block if the location is down"; "Connect automatically" and "Check this browser's exit" once v3 lands |
| | privacy | `region` "What the VPN does and does not do" |
| chrome | chip | the existing tab-strip `link` whose name starts with "VPN" |

## 4. Lane g1: games backend

### 4.1 What it builds

A server module `games` (`backend/src/games/`) that wires the reviewed crate into gnome-server exactly as
`crates/catalog/README.md` "Integration with gnome-server" describes, plus the pieces the crate leaves to the server:
the feed and thumbnail fetchers over gnome-net, the routes, the admin endpoints, the jobs, the CLI, the thumbnail
cache, the frame policy, the OSS fetch and serving, `/ads.txt`, metrics and diagnostics.

```rust
// backend/src/games/mod.rs
pub mod admin;    // /admin/catalog/*, /admin/games/*
pub mod ads_txt;  // GET /ads.txt (D22)
pub mod cli;      // gnome-server catalog …
pub mod fetcher;  // CatalogFetcher: gnome_catalog::Fetcher over gnome_net::SafeClient
pub mod frames;   // FramePolicy (which embeds may be framed, D4), the wrapper /play-frame/<slug> (D2), the pending report
pub mod jobs;     // catalog.import, catalog.rankings, catalog.policy, catalog.oss-fetch
pub mod oss;      // OSS fetch (D6) and /oss/<slug>/** (D5)
pub mod replay;   // ReplayFetcher for `catalog import --replay` (D19)
pub mod routes;   // /api/games*, /api/thumb/:id
pub mod thumbs;   // ThumbCache: disk LRU + validated upstream fetch (D7)

pub const IMPORT_JOB: &str = "catalog.import";
pub const RANKINGS_JOB: &str = "catalog.rankings";
pub const POLICY_JOB: &str = "catalog.policy";
pub const OSS_FETCH_JOB: &str = "catalog.oss-fetch";

/// Knobs for tests and embedding; production uses the defaults.
#[derive(Default)]
pub struct GamesOptions {
    /// Feed fetcher (default: `CatalogFetcher::for_feeds`). Tests pass a `gnome_catalog::FixtureFetcher`.
    pub fetcher: Option<Arc<dyn gnome_catalog::Fetcher>>,
    /// Thumbnail fetcher (default: `CatalogFetcher::for_thumbnails`).
    pub thumb_fetcher: Option<Arc<dyn gnome_catalog::Fetcher>>,
    /// Client of the OSS fetch (default: strict policy, `allowed_hosts(["codeload.github.com"])`).
    pub oss_client: Option<gnome_net::SafeClient>,
    /// Clock (default `gnome_catalog::TokioClock`).
    pub clock: Option<Arc<dyn gnome_catalog::Clock>>,
}

/// Shared state, published with `ModuleSetup::provide` (handlers, jobs, admin routes and diagnostics read it).
pub struct Games {
    pub catalog: Arc<gnome_catalog::Catalog>,
    pub frames: frames::FramePolicy,
    pub thumbs: thumbs::ThumbCache,
    pub oss: oss::OssBuilds,
    /// `None` until `prepare` ran, `Some(Err(_))` when it failed: in both cases the routes answer 503 (D21).
    pub prepared: std::sync::RwLock<Option<Result<gnome_catalog::PrepareReport, String>>>,
    // private: fetcher, thumb_fetcher, oss_client, clock, cached stats for metrics
}

/// `None` when `config.catalog.sources` is empty (`GNOME_CATALOG_SOURCES=none`, or every source gated off): the
/// routes then do not exist (404) and `/api/config` keeps `features.games: false`.
pub fn install(setup: &mut ModuleSetup<'_>, options: GamesOptions) -> Option<Arc<dyn Module>>;

/// The catalog's writer: `crate::db::Db` (a local type, so no newtype is needed for the foreign trait).
impl gnome_catalog::WriteDb for crate::db::Db { /* the README's shape, mapping DbError to CatalogError::Storage */ }
```

`Catalog::new(config.catalog.clone(), secret.as_bytes(), RenderOptions { app_origin, proxy_origin, thumb_proxy })`:
`app_origin` = the first of `config.proxy.app_origins()` (two-origin mode) or of `GNOME_PUBLIC_ORIGINS`
(single-origin mode; without one GameDistribution is already gated off, §3.1, and `app_origin` is only used for its
referrer URL); `proxy_origin` = `config.proxy.origin()` (in single-origin mode `oss` is gated off, so no proxy URL is
ever rendered for the app origin).

`Module` implementation: `name()` "games"; `public_routes` (§4.2, `/play-frame/{slug}`, `/ads.txt`); `proxy_routes`
(`/oss/{slug}/{*path}`); `admin_routes` (§4.4); `jobs` (§4.6); `prepare` (D21: `Catalog::prepare` on the writer,
`OssBuilds::rescan`, the first `FramePolicy::refresh` (the pending-host report), then a spawned `ThumbCache::scan` on
`state.tasks`); `public_config` sets `features.games`
(prepared without error and at least one source enabled) and `features.thumb_proxy` (`GNOME_THUMB_PROXY`);
`diagnostics` and `metrics` (§4.10).

`CatalogFetcher` (`fetcher.rs`):

```rust
pub struct CatalogFetcher { client: gnome_net::SafeClient }

impl CatalogFetcher {
    /// Strict IP policy, no proxies, redirects re-validated (gnome-net), host allow-list = the feed hosts of the
    /// enabled sources (`Source::feed_hosts`, crate change §4.8), User-Agent from the request (the crate sets
    /// `GNOME_CATALOG_USER_AGENT`), connect timeout 10 s.
    pub fn for_feeds(sources: &[gnome_catalog::Source], source_url: Option<&str>) -> Result<Self, String>;
    /// Host allow-list = `ThumbPolicy::hosts()` of the enabled sources; at most 1 redirect.
    pub fn for_thumbnails(policy: &gnome_catalog::ThumbPolicy, source_url: Option<&str>) -> Result<Self, String>;
    /// Any client (tests: `allow_loopback` + a `StaticResolver`).
    pub fn new(client: gnome_net::SafeClient) -> Self;
}

impl gnome_catalog::Fetcher for CatalogFetcher {
    /// Sends method, URL, headers and body as given; `max_body_bytes` and `timeout` from the request; every HTTP
    /// status is `Ok`. Errors: gnome-net `Timeout` → `FetchError::Timeout`, `BodyTooLarge` → `BodyTooLarge`,
    /// `is_policy()` → `Blocked`, anything else → `Network`.
    fn fetch(&self, request: gnome_catalog::FetchRequest)
        -> gnome_catalog::BoxFuture<'_, Result<gnome_catalog::FetchResponse, gnome_catalog::FetchError>>;
}
```

### 4.2 Public routes (app origin)

All under the `api` rate class except `/api/thumb/` (`thumb`); JSON; `Cache-Control: no-store` unless stated; while
`prepare` has not run, failed, or the database cannot be read: `503 unavailable` with `Retry-After: 30` (D21). Query-parameter problems:
`400 bad_request` with a message naming the parameter (D10): `limit must be 1-100`, `unknown category: <slug>` (the
`category` parameter; unknown `exclude` slugs are ignored, D11),
`unknown sort: <value>`, `invalid cursor`, `cursor does not belong to this query`, `q is limited to 100 characters`,
`at most 20 categories can be excluded`, `ids must be comma-separated integers`, `at most 200 ids`,
`tag prefix is limited to 40 characters`. The crate's `InvalidInput` messages are close to these (e.g. `limit must
be 1..=100`); the lane aligns them in the crate (§4.8) and pins each with a test.

| Method & path | Parameters | Answer |
| --- | --- | --- |
| `GET /api/games` | `q` (≤ 100 chars; the last word is a prefix from 3 letters) · `category` · `tag` · `sort` (`relevance` default with `q`, else `popular`; `trending`, `new`, `featured`, `az`) · `mobile=1` · `exclude=<slug,…>` (≤ 20 given; a game with any of them is left out; slugs the server does not know are ignored and not bound into the cursor, D11) · `include_link_out=1` · `cursor` · `limit` (1–100, default 48) | `200 {"items": GameSummary[], "next_cursor": string\|null, "total": number}` (keyset pages; a cursor is bound to every parameter but `cursor` and `limit`) |
| `GET /api/games/sections` | `mobile=1` · `exclude=` | `200 {"featured": GameSummary[], "trending": […], "popular": […], "new": […]}`, ≤ 24 each, playable games only (`featured`: admin picks, topped up by source quality, never empty while the catalog is not) |
| `GET /api/games/categories` | `include_link_out=1` | `200 {"categories": [{"slug","name","count"}]}`: the 14 core categories always (count may be 0), optional ones when used |
| `GET /api/games/tags` | `prefix` (≤ 40) · `limit` (1–100, default 30) | `200 {"tags": [{"tag","count"}]}` |
| `GET /api/games/by-ids` | `ids=1,2,3` (≤ 200) | `200 {"items": GameSummary[]}`: order kept, games that are no longer visible omitted (favorites and recently played resolve fallbacks of a deduplicated game) |
| `GET /api/games/status` | – | `200 GamesStatus` (§3.2): `listed`, `playable` (listed games of playable sources, from `CatalogStats` per source), `importing` (a run of any source is `running`), per enabled source its display name and the last finished run's `status` and `finished_at` — never error texts or URLs |
| `GET /api/games/:slug` | `mobile=1` · `exclude=` (for `related`) | `200 {"game": GameDetail, "related": GameSummary[]}` (12 related); `GameDetail` = the crate's detail plus `embed_allowed` (`FramePolicy::allows(game)`, §4.5; false for `link`) and `oss` (`{"repository", "commit", "license_file_url"}` from the manifest and `OssBuilds`, `license_file_url` = `<proxy origin>/oss/<slug>/<license_file>`; `null` for other sources) · `404 not_found` for an unknown, hidden, broken, `ip_risk` or disabled-source game |
| `POST /api/games/:slug/play` | no body; CSRF rules (`X-GNOME-Request: 1`, allowed `Origin`) | `204` (counted or a duplicate within the hour) · `404 not_found`. Dedup key (D8): `HMAC(secret, "gnome/games/play\0" ‖ session_ref)` with a valid `gnome_auth` (user `SessionRef`) or `gnome_sid` (anonymous `SessionRef`), else `HMAC(secret, "gnome/games/play-ip\0" ‖ client IP, IPv6 as its /64)`; the crate stores only its 16-byte hourly hash |
| `GET /api/thumb/:id` | `id` integer | `200` image bytes: `Content-Type` = the sniffed type, `ETag` (strong, body hash), `Cache-Control: public, max-age=<min(604800, the upstream's max-age)>`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin`; `304` on `If-None-Match` · `404 not_found` (unknown or invisible game, no thumbnail, an OSS thumbnail, the source's policy refuses the URL, the upstream answered 4xx, or its answer was refused: type, sniff, size) · `429 rate_limited` (`thumb` or `thumb_fetch` exhausted) · `503 unavailable` + `Retry-After: 60` (the upstream failed: 5xx, timeout, network) |
| `GET`/`HEAD /play-frame/:slug` | – | the game's wrapper document (D2, §4.5): `200 text/html; charset=utf-8`, `Cache-Control: no-store`, `Content-Security-Policy: <csp::wrapper_csp>`, `X-Frame-Options: SAMEORIGIN`, COOP and Permissions-Policy like all app HTML · `404` (an HTML body under `default-src 'none'; frame-ancestors 'self'`) for an unknown, invisible or link-out game and whenever `FramePolicy::allows` refuses it · `503` while `prepare` has not run or failed |
| `GET /ads.txt` | – | the `GNOME_ADS_TXT` file as `text/plain; charset=utf-8`, `Cache-Control: public, max-age=3600`, ≤ 64 KiB (larger: 404 and a warning); `404` when unset or missing |

`GameSummary`/`GameDetail` serialize exactly as API.md "Games catalog" lists them plus the additive fields above;
titles, descriptions and instructions are plain text (the review: "may legitimately contain `<`").

### 4.3 Proxy-origin routes: `/oss/<slug>/**`

`GET`/`HEAD /oss/{slug}/{*path}` on the proxy role only (two-origin mode; `oss` is gated off in single-origin mode),
served from `<GNOME_OSS_GAMES_DIR>/<slug>/`:

- `slug` must be a served build (`OssBuilds::get`: enabled in the manifest, `oss` source enabled, entry file
  present). `path` is percent-decoded once and refused (404) when empty, longer than 1024 bytes, or containing a `.`
  or `..` segment, a segment starting with `.` (`.git`, `.gnome-oss.json`), a backslash, NUL or an empty segment;
  every path component is checked with `symlink_metadata` (no symbolic links, the last one a regular file); the
  canonical path must stay below the canonical build directory. Directories answer 404 (embed URLs name the entry
  file).
- **Documents** (D5): the manifest's `entry` file is the only HTML served, and only when the request says
  `Sec-Fetch-Dest: iframe` (or `frame`); a top-level load, a missing header or any other destination answers 404, so a
  link to `https://<proxy>/oss/<slug>/…` never runs a game with the proxy origin's first-party storage. Every other
  `.html`, `.htm`, `.xhtml`, `.xht` and `.xml` file of a build answers 404 (repositories ship demos, tests and docs
  pages that were never reviewed). SVG stays an image (`image/svg+xml` under the inert policy: no script runs).
- Content types: `static_files::content_type` (the server's one table: extension-less files such as `LICENSE` are
  `text/plain; charset=utf-8`, so "License text" opens instead of downloading), with anything it does not know as
  `application/octet-stream`. Always `X-Content-Type-Options: nosniff`.
- Policies (D5): the entry → `csp::oss_document_csp(app origins, isolated, pointer_lock)` = `default-src 'self'
  data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self';
  frame-ancestors <app origins>` (+ `; sandbox allow-scripts[ allow-pointer-lock]` for `isolated = true` entries);
  `js`/`mjs` → `proxyScriptCsp(app origins)` (it may run as a worker); everything else → `proxyInertCsp(app origins)`
  (SVG documents run no script). No `X-Frame-Options` (the proxy role removes it); `Referrer-Policy: no-referrer`.
- Caching: `Cache-Control: public, max-age=3600`; strong `ETag` from the build's file index (`.gnome-oss.json`), weak
  `W/"<len>-<mtime_ns>"` for hand-copied builds without one; `304` on `If-None-Match`; no ranges
  (`Accept-Ranges: none`); files stream from disk in 64 KiB chunks.
- Unknown slug or path: the proxy role's 404 (`proxyInertCsp`). On the app role `/oss/**` is a plain 404 in
  two-origin mode (§3.1 `proxy_only`).

### 4.4 Admin endpoints (admin listener)

Guarded like every admin route (loopback or token; `X-GNOME-Request: 1` on unsafe methods; `admin` rate class).

| Method & path | Body | Answer |
| --- | --- | --- |
| `POST /admin/catalog/import` | `{"sources"?: string[], "limit"?: number}` (default: every enabled source; `limit` 1–100000 makes the run limited, never complete) | `202 {"job": "catalog.import", "sources": [ids]}` (runs in the background, one source after another; afterwards `FramePolicy::refresh`) · `409 conflict` "an import of <id> is already running" · `422 validation_failed` with `fields.sources` ("unknown source x", "x is not enabled") or `fields.limit` |
| `GET /admin/catalog/imports` | query `source=`, `limit=` (1–500, default 50) | `200 {"runs": ImportRun[]}` (the crate's shape, newest first) |
| `POST /admin/catalog/oss-fetch` | `{"slugs"?: string[]}` (default: every enabled entry whose build is missing or at another commit) | `202 {"job": "catalog.oss-fetch", "slugs": [...]}` · `409 conflict` while one runs · `422` `fields.slugs` ("unknown entry", "not enabled", "not pinned to a commit", "a local build") |
| `POST /admin/games/:id/feature` | `{"featured": bool}` | `204` · `404 not_found` |
| `POST /admin/games/:id/status` | `{"status": "active" \| "hidden" \| "broken" \| null}` (`active` overrides an `ip_risk` match; `null` clears the override) | `204` (then `FramePolicy::refresh`) · `404` · `422` `fields.status` |

`GET /admin/diagnostics` gets `catalog` (the crate's `CatalogStats`, replacing the zero placeholder of
`admin/mod.rs`) and `games` (§4.10); the HTML page (`admin/page.rs`) adds a "Games" table (embed hosts with the
pending ones and their counts, thumbnail cache, OSS builds).

### 4.5 The frame policy, the wrapper document and the app-origin headers

```rust
// backend/src/games/frames.rs
pub struct FramePolicy { /* the fixed hosts of the enabled sources, the approved hosts, the app and proxy hosts, the last report */ }

#[derive(Debug, Clone, Default, Serialize)]
pub struct FrameReport {
    /// `Source::embed_hosts` of the enabled sources.
    pub fixed: Vec<String>,
    /// `GNOME_GAMES_EMBED_HOSTS` entries that visible games embed from.
    pub approved_in_use: Vec<String>,
    /// Hosts visible iframe games embed from that are neither fixed nor approved: their games are `embed_allowed: false`.
    pub pending: Vec<HostCount>,
    /// Iframe games whose embed host is an app or proxy origin host: never framed (a poisoned record, D4).
    pub refused: Vec<HostCount>,
    pub computed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostCount { pub host: String, pub games: u64 }

/// What `/play-frame/<slug>` renders for one game.
pub struct FrameTarget {
    /// The `src` of the inner iframe: the rendered embed URL, or `<proxy origin>/oss/<slug>/<entry>`.
    pub src: String,
    /// The wrapper's `frame-src` value (`https://<host>[:port]`, or `<proxy origin>/oss/<slug>/`).
    pub frame_source: String,
    pub sandbox: &'static str,
    pub allow: String,
    pub title: String,
}

impl FramePolicy {
    pub fn new(config: &Config) -> Self;
    /// Whether this game may be framed (D4). Iframe-kind games: the embed URL parses with the crate's strict `Url`,
    /// is `https:`, has no `.`/`..` path segment and no `%2e`, `%2f` or `%5c` in its path (case-insensitive), and
    /// its host (and port) is a fixed host of an enabled source or an approved host — never an app or proxy origin
    /// host. `selfhost` games: `source = oss` and an `OssBuilds::get(slug)` build, whose URL is rendered here, never
    /// taken from the record. `link`: never. No string-prefix comparison anywhere.
    pub fn allows(&self, game: &gnome_catalog::GameDetail, oss: &crate::games::oss::OssBuilds) -> bool;
    /// `allows` plus the attributes of §5.2's table for that game; `None` when not allowed.
    pub fn target(&self, game: &gnome_catalog::GameDetail, oss: &crate::games::oss::OssBuilds) -> Option<FrameTarget>;
    /// Recompute the report from the catalog (a reader connection; `Catalog::embed_host_counts`).
    pub fn refresh(&self, catalog: &gnome_catalog::Catalog, conn: &rusqlite::Connection, now_ms: i64)
        -> Result<FrameReport, gnome_catalog::CatalogError>;
    pub fn report(&self) -> FrameReport;
}

/// The wrapper document (exact; `{…}` HTML-attribute-escaped: `& < > " '`):
/// <!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title} (game)</title><style>WRAPPER_STYLE</style></head><body><iframe src="{src}" title="{title} (game)" sandbox="{sandbox}" allow="{allow}" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>
pub const WRAPPER_STYLE: &str =
    "html,body{margin:0;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:0}";
pub fn render_wrapper(target: &FrameTarget) -> String;
```

The inner iframe's attributes, by kind (the outer frame in the app page, §5.2, carries the same `allow` and
`allowfullscreen`; no `sandbox` on the outer frame: the wrapper runs no script, and a sandbox there would be inherited
by the game):

| Kind | `sandbox` | `allow` |
| --- | --- | --- |
| network or approved developer embed | `EMBED_SANDBOX` = `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-pointer-lock allow-orientation-lock` | `EMBED_ALLOW` = `fullscreen; autoplay; gamepad; accelerometer; gyroscope` |
| OSS | `allow-scripts allow-same-origin allow-forms` + ` allow-pointer-lock` when the entry declares `pointer_lock = true` | `autoplay` + `; gamepad` when the entry declares `gamepad = true` |
| OSS `isolated = true` | `allow-scripts` + ` allow-pointer-lock` when declared (no `allow-same-origin`: an opaque origin) | as OSS |

OSS frames get no `fullscreen` (GNOME's stage button fullscreens them), no orientation lock (GNOME locks the
orientation itself), no motion sensors: they are same-origin with the engine host, so escaped proxied code in the same
app page could use whatever they are given (ENGINE_ALLOW is `fullscreen; clipboard-write; autoplay`, ENGINE-PROTOCOL
§6.14).

Rules (each with a test): `allows` exactly as documented above, with both spellings of every refused path
(`/a/../b`, `/a/%2e%2e/b`, `/a/%2E%2e/b`, `%2f`, `%5c`) and an iframe record naming the instance's own app and proxy
hosts; the wrapper's CSP is `csp::wrapper_csp(frame_source)` byte for byte with the hash of `WRAPPER_STYLE`; the
wrapper is computed per request, so an approval or an admin status change applies at the next page view (no app
reload); `refresh` runs in `prepare`, after every import run, after `POST /admin/games/:id/status`, and in the
5-minute `catalog.policy` job (which also picks up imports made by the CLI); it only feeds diagnostics and metrics.

The shell (the SPA's HTML) has the fixed policy of §3.1: `frame-src 'self' <proxy origin>`, `frame-ancestors 'none'`,
`X-Frame-Options: DENY`. App-role HTML (the shell, the wrapper and every other HTML file the app role serves)
additionally gets `Cross-Origin-Opener-Policy: same-origin` and `Permissions-Policy: <csp::PERMISSIONS_POLICY>` (D3);
JSON, images and the proxy role are unchanged.

### 4.6 Jobs and the CLI

| Job | Schedule | Work |
| --- | --- | --- |
| `catalog.import` | tick every 10 min, first 30 s after start | for each enabled HTTP source that is due — its last finished run is older than `GNOME_CATALOG_REFRESH_HOURS`, or it never finished one; a source whose last run `failed` retries after min(1 h × 2^(failures−1), the interval) — one `Catalog::import` after another (watching `state.shutdown`); `oss` is imported at the first tick when it never completed a run, and afterwards whenever `OssBuilds::rescan` differs from the stored `oss` records — **also with `GNOME_CATALOG_REFRESH_HOURS=0`** (no network involved); afterwards `FramePolicy::refresh`, cached stats, `PRAGMA optimize`. `GNOME_CATALOG_REFRESH_HOURS=0`: no feed imports (admin and CLI still import) |
| `catalog.rankings` | hourly, first after 60 s | `Catalog::refresh_rankings` (also purges expired play-dedup keys: a test asserts no dedup row survives two hours) |
| `catalog.policy` | every 5 min, first after 5 min | `FramePolicy::refresh` (the pending/refused report) and the cached stats behind the metrics; deletes thumbnail-cache files of games no longer visible |
| `catalog.oss-fetch` | daily, first after 20 s; only with `GNOME_OSS_FETCH=auto` and `oss` enabled | `OssBuilds::fetch` for every enabled, pinned entry whose build is missing or at another commit (one at a time); then an `oss` import and `FramePolicy::refresh` |

CLI (`backend/src/cli.rs` dispatches to `games::cli`; the same `GNOME_*` configuration and data directory as the
server, safe while it runs: SQLite WAL, and the crate's run lock refuses a second concurrent run of one source):

```
gnome-server catalog import [--source <id>]... [--limit <n>] [--replay <index.json>]
gnome-server catalog stats
gnome-server catalog fetch-oss [--slug <slug>]...
```

- `import`: `Db::open` (the server's migration runner), `AppState::prepare_modules()` (so `Catalog::prepare` ran),
  then one run per source (default: every enabled source); prints each `ImportReport` as one JSON line on stdout. Exit
  0 when every run ended `complete` or `incomplete` (limited runs are incomplete by design), 1 when one `failed` or
  another run of the source was busy, 2 for an unknown or disabled source or a bad `--replay` index.
- `--replay <index.json>` (development and tests, D19): answers the importers' requests from captured responses
  instead of the network (`replay::ReplayFetcher`); never contacts a host. Format, every path relative to the index
  file's directory (absolute paths and `..` are refused):

  ```json
  {
    "version": 1,
    "note": "Unmodified captures from crates/catalog/tests/fixtures (2026-11-10).",
    "now": "2026-11-10T12:00:00Z",
    "config": {
      "gamepix": { "per_page": 12, "category": "chess" },
      "gamedistribution": { "per_page": 10 },
      "playgama": { "per_page": 10 },
      "gamemonetize": { "per_page": 10 },
      "itchio": { "max_pages": 1 },
      "js13k": { "first_year": 2026 }
    },
    "sources": {
      "gamepix": [
        { "url_contains": ["/v2/json?", "&page=1&category=chess"], "status": 200, "file": "gamepix-chess-p1.json" },
        { "url_contains": ["/v2/json?", "&page=2&category=chess"], "status": 200, "file": "gamepix-chess-p2.json" },
        { "url_contains": ["/v2/json?", "&page=3&category=chess"], "status": 200, "file": "gamepix-chess-p3.json" }
      ],
      "playgama": [{ "url_contains": ["/catalogue/games"], "status": 201, "file": "playgama-p1.json" }],
      "itchio": [{ "url_contains": ["itch.io/games/free/platform-web.xml?page=1"], "status": 200, "file": "itch-free-web.xml" }],
      "js13k": [{ "url_contains": ["js13kgames.com/2026/games.xml"], "status": 200, "file": "js13k-2026.xml" }]
    }
  }
  ```

  - `config` overrides adapter settings **in replay mode only** (the keys the crate's `CatalogConfig` has for each
    source: `per_page`, `category`, `max_pages`, `first_year`), so the importers send exactly the requests the
    captures answer; the server's environment has no such variables, and the overrides never reach a running server.
  - `now` pins the replay clock (`replay::ReplayClock`: `now` + elapsed time; its sleeps return at once, so request
    spacing and back-off cost no real time), so js13kGames stops at 2026 in every year.
  - Each response answers one request, in order, for the first entry whose substrings all occur in the URL (the
    crate's `FixtureFetcher::on_url` semantics); an optional `"headers": {"etag": "…"}` is passed through; an
    unmatched request fails with the non-retryable `FetchError::Blocked("no fixture for <METHOD> <url>")` (the
    crate's own wording), never `Network`, so nothing backs off.
  - The matchers are written against the URLs the adapters really build (`page_url` and friends, never the crate
    tests' matchers), and `backend/tests/cli.rs` proves each source's outcome through the real CLI: GamePix 3 pages
    `complete`; GameDistribution `complete`; **Playgama `failed`** (its capture says `totalCount` 2865, so the second
    request, offset 10, has no capture: 10 inserted, 9 listed, the knock-off `ip_risk`; exit code 1 for that run, as
    the crate's own test asserts); itch.io (36) and js13kGames (317) `complete`; GameMonetize (`per_page` 10, as the
    crate's test) and Famobi as the CLI test finds them — a capture that is one full page ends `failed` like Playgama,
    with its games listed, and B1 asserts exactly the recorded status per source. The suites take their expected
    counts from these reports, not from constants.
- `stats`: `Catalog::stats` as JSON. `fetch-oss`: §4.7; prints one JSON line per entry; exit 1 if one failed.

### 4.7 Thumbnails and OSS builds

```rust
// backend/src/games/thumbs.rs
pub struct ThumbCache { /* dir, cap, LRU index, negative cache, in-flight map, fetch permits (4), counters */ }

pub struct ThumbHit { pub content_type: &'static str, pub etag: String, pub body: ThumbBody }
pub enum ThumbBody { Disk { path: PathBuf, len: u64 }, Memory(bytes::Bytes) }
pub enum ThumbError { NotFound, Refused(&'static str), Upstream { retry_after_s: u32 }, RateLimited { retry_after_s: u32 } }

impl ThumbCache {
    /// `$GNOME_DATA_DIR/thumbs/`, cap `GNOME_THUMB_CACHE_MB` (0 = no disk cache: validated pass-through).
    pub fn open(dir: PathBuf, cap_mb: u32) -> Self;
    /// Index the files on disk (mtime = initial recency), drop temporary files; runs once at start.
    pub async fn scan(&self);
    /// `url` = `Catalog::thumbnail_source` (already allow-listed for its source). Coalesces concurrent misses of
    /// one URL into one fetch; misses take a `thumb_fetch` token for `ip` first.
    pub async fn get(&self, url: &str, ip: std::net::IpAddr, fetcher: &dyn gnome_catalog::Fetcher, state: &AppState)
        -> Result<ThumbHit, ThumbError>;
}

/// Magic bytes → `image/jpeg` | `image/png` | `image/gif` | `image/webp` | `image/avif`; anything else `None`.
pub fn sniff(bytes: &[u8]) -> Option<&'static str>;
```

- Upstream request: `GET` with `Accept: image/avif,image/webp,image/png,image/jpeg,image/gif`, ≤ `MAX_THUMB_BYTES`
  (2 MiB), 10 s; at most 4 upstream fetches at once (others wait ≤ 5 s, then `503`).
- Accepted only when the status is 200, `thumbs::is_allowed_content_type(Content-Type)` holds **and** `sniff(body)`
  returns the same family (a `image/png` label on JPEG bytes is served as JPEG; HTML, SVG, empty or unknown bytes are
  refused whatever the label).
- Disk: `<dir>/<2 hex>/<sha256(url) hex>.<ext>` written to a temporary name and renamed; LRU eviction when the total
  passes the cap (down to 90 %); counters for hits, misses, refusals, upstream errors.
- Negative cache in memory (≤ 10,000 entries): upstream 4xx → 1 h, refused → 24 h, upstream error → 60 s.
- Freshness: a cached file is kept for at most the upstream's `Cache-Control: max-age` (7 days when it sends none;
  `no-store` → served, never stored), and files of games that are no longer visible are deleted by `catalog.policy`.

```rust
// backend/src/games/oss.rs
pub struct OssBuilds { /* dir, max bytes, served builds by slug */ }

#[derive(Debug, Clone)]
pub struct OssBuild {
    pub slug: String,
    pub entry: String,
    pub repository: String,
    pub commit: Option<String>,
    pub license_file: Option<String>,
    /// Manifest flags (§4.8 item 5): an opaque-origin sandbox, pointer lock, gamepad.
    pub isolated: bool,
    pub pointer_lock: bool,
    pub gamepad: bool,
    /// path → sha256 hex, from `.gnome-oss.json` (absent for hand-copied builds).
    pub files: Option<Arc<HashMap<String, String>>>,
}

/// What `rescan` found, by slug (each list sorted).
#[derive(Debug, Clone, Default, Serialize)]
pub struct OssScan {
    /// Built and served now.
    pub served: Vec<String>,
    /// Enabled and pinned, no build on disk.
    pub missing: Vec<String>,
    /// A build at another commit than the manifest's (still served until re-fetched).
    pub outdated: Vec<String>,
    /// Enabled without a 40-hex commit (never fetched; `local` entries are not listed here).
    pub unpinned: Vec<String>,
    /// The served set differs from the previous scan (the import job's trigger).
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OssFetchReport { pub slug: String, pub commit: String, pub files: u32, pub bytes: u64, pub skipped_links: u32, pub duration_ms: u64 }

impl OssBuilds {
    pub fn new(config: &Config) -> Self;
    /// Re-read the manifest (`GNOME_OSS_MANIFEST` or the built-in one) and each enabled entry's build directory.
    pub fn rescan(&self, catalog: &gnome_catalog::CatalogConfig) -> Result<OssScan, String>;
    pub fn get(&self, slug: &str) -> Option<OssBuild>;
    /// D6: download, check and install one entry's pinned commit.
    pub async fn fetch(&self, slug: &str, client: &gnome_net::SafeClient, shutdown: &CancellationToken)
        -> Result<OssFetchReport, String>;
}
```

Fetch rules (exact; each a test): only enabled entries with a 40-hex `commit`, a `reviewed` record (§4.8 item 5) and
a `https://github.com/<owner>/<repo>` repository; URL `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>`;
SafeClient strict policy, `allowed_hosts(["codeload.github.com"])`, ≤ 64 MiB downloaded (SafeClient's body cap: a
tarball is not content-encoded, so this caps the compressed archive), 120 s. Extraction, all on the stream:

- the gzip decoder is wrapped in a reader that fails the fetch after **129 MiB of decompressed tar bytes in total,
  headers included**, so no entry type can exhaust memory or disk before the per-file caps apply;
- entry types: `Regular` files and `Directory` entries are extracted; `Symlink`, `Link`, `Char`,
  `Block` and `Fifo` are skipped and counted; `XGlobalHeader` is skipped; **`GNUSparse`, `Continuous`,
  `GNUVolume` and any unknown type fail the fetch**; PAX (`XHeader`) and GNU long-name/long-link entries are read by
  `tar` only up to **64 KiB** each (a larger one fails the fetch before it is read);
- every entry must sit under the archive's single top directory, which is stripped; a path that is absolute, has a
  `..` component, a backslash or NUL, starts with `.git/`, exceeds 255 bytes, or a component over 128 bytes fails the
  fetch;
- files are written with the lane's own `File::create` + `io::copy` over `entry.take(remaining cap)` — **never
  `Entry::unpack` or `unpack_in`** (they follow the archive's sparse maps, modes and times) — 0644, directories 0755;
  at most 20,000 entries and 128 MiB written per game, and `GNOME_OSS_MAX_MB` across all builds;
- everything goes into `<dir>/.tmp-<slug>-<random>/`, then `entry` and `license_file` must exist there as regular
  files, `.gnome-oss.json` (`{"commit", "fetched_at", "files": {path: sha256}}`) is written, the old build is renamed
  away, the new one renamed into place and the old one deleted. A failure leaves the old build in place. A build whose
  commit differs from the manifest's is re-fetched (and still served until then).

Tests generate the hostile archives in memory: a GNU sparse entry with a huge logical size, a 1 MiB PAX header, a
long-name entry over 64 KiB, a gzip bomb past 129 MiB, two top directories, plus the link, device and path cases.

### 4.8 Crate changes (`crates/catalog/**`)

1. **Exclusions** (D11): `pub struct ListFilter { pub mobile: bool, pub exclude: Vec<String> }`; `ListQuery` gains
   `exclude: Vec<String>`; `Catalog::sections(&self, conn, limit, filter: &ListFilter)` and
   `Catalog::game(&self, conn, slug, related, filter: &ListFilter)` (related games honour it). At most 20 slugs given
   (`InvalidInput("at most 20 categories can be excluded")`); slugs that are not known categories are dropped before
   anything else (they match no game, D11); a game with any excluded category in any position is left out; totals with exclusions are counted through `games_listed_search` (no facet row exists for them); the
   cursor fingerprint covers the known `exclude` slugs (sorted) and `mobile`. Budget: a listing with 3 exclusions ≤ 5 ms p50 on the
   15k live catalog (x86), measured like the review's timings.
2. **Feed hosts**: `Source::feed_hosts(self) -> &'static [&'static str]` (GamePix `feeds.gamepix.com`,
   GameDistribution `catalog.api.gamedistribution.com`, Playgama `widgets.playgama.com`, GameMonetize
   `gamemonetize.com`, Famobi `api.famobi.com`, itch.io `itch.io`, js13kGames `js13kgames.com`, OSS none); a test
   asserts every adapter's first-page URL host is in its list.
3. **Referrer page** (D2): `{page_url}` renders `<app origin>/play/<slug>`; the GameDistribution test changes with it.
4. **Embed host counts**: `Catalog::embed_host_counts(&self, conn) -> Result<Vec<(String, u64)>>` (visible iframe
   games per embed host, `host[:port]` as `embed_hosts` produces them); `embed_hosts` stays.
5. **Manifest** (D5): `particle-clicker`, `javascript-chess` and `a-blast` get `enabled = false`, `notes` naming
   their CDN dependencies and "the proxy origin allows no third-party loads (docs/WAVE-C.md D5)". New entry fields:
   `reviewed` (string, required for every enabled non-`local` entry: `"<date>: <what was checked>"`), `isolated`,
   `pointer_lock`, `gamepad` (booleans, default false). **The lane reviews the pinned commit of each remaining
   enabled entry** before M4 ends (reading the repository at that commit: no `localStorage.clear()`,
   `sessionStorage.clear()`, `indexedDB.deleteDatabase`, `caches.delete`, service-worker `register`/`unregister`;
   no `innerHTML`/`document.write`/`eval` fed from `location`, the hash, `document.referrer` or `postMessage`; no
   external loads; which storage APIs it uses — none → `isolated = true`; whether it needs pointer lock or a gamepad)
   and records it in `reviewed`; an entry that fails gets `enabled = false` with the reason. The manifest test
   asserts that every enabled non-`local` entry has `reviewed`, and its count of enabled entries follows (11 → at most
   8). The manifest types and loader the server needs (`sources::oss::{Manifest, Entry}`, a
   `load_manifest(&OssConfig)`) become public if they are not.
6. **README**: "Integration with gnome-server" describes what is built (routes and their 400 `bad_request` errors,
   the frame policy, jobs, CLI, replay, OSS fetch and serving); the "next step" sentences go.
7. **Operator-provided builds**: a manifest entry may say `local = true` (then `repo` and `commit` are absent, the
   build is the operator's own files in `<GNOME_OSS_GAMES_DIR>/<slug>/`, it is never fetched; `license`,
   `license_file` and `copyright` stay required; `source_url` and `developer_url` are `null`, `oss.repository` is
   `null` in the API). For operators who host games of their own, and for the e2e test game (GNOME's own original
   code, §9.1), which must not borrow a real repository's name. The built-in manifest has no `local` entry.

8. **Embed URL paths**: a new `Url::has_plain_path(&self) -> bool` (no `.` or `..` segment, no `%2e`, `%2f` or
   `%5c` in any case) is required of every embed URL at normalization, so such records are rejected at import
   (`Reject`; other feed URLs are unaffected), and `FramePolicy::allows` (§4.5) checks again; tests with both
   spellings. The crate's `RenderOptions` already knows the app and proxy origins, but which hosts are refused is the
   server's rule (§4.5).

`RULES_VERSION` does not change (no normalization rule changes), and no migration is added: none of the above
changes the schema (exclusions use `game_categories`, host counts read `embed_url`).

### 4.9 Settings and configuration it reads

Server: every catalog variable of §3.1, `GNOME_THUMB_PROXY`, `GNOME_THUMB_CACHE_MB`, `GNOME_GAMES_EMBED_HOSTS`,
`GNOME_OSS_FETCH`, `GNOME_OSS_MAX_MB`, `GNOME_ADS_TXT`, `GNOME_DATA_DIR`, `GNOME_SOURCE_URL` (User-Agent),
the origin setup. No user setting reaches the server (favorites and recently played stay local, D9).

### 4.10 Metrics and diagnostics

`/admin/metrics` (from cached stats, refreshed by `catalog.policy` and after imports; the hook is synchronous):

```
gnome_catalog_games{source,state}                 gauge    state = listed | active | hidden | broken | ip_risk
gnome_catalog_import_runs_total{source,status}    counter  status = complete | incomplete | failed | interrupted
gnome_catalog_last_complete_import_seconds{source} gauge
gnome_game_plays_total                            counter  counted plays (no labels)
gnome_games_embed_hosts{state}                    gauge    state = fixed | approved | pending | refused
gnome_thumb_requests_total{result}                counter  result = hit | miss | not_modified | not_found | refused | upstream_error | rate_limited
gnome_thumb_cache_bytes                           gauge
gnome_oss_builds{state}                           gauge    state = served | missing | outdated | failed
```

`/admin/diagnostics` → `games`: `{"prepared": bool, "error": string|null, "embed_hosts": FrameReport,
"thumbs": {"entries", "bytes", "cap_bytes", "hits", "misses", "refused", "upstream_errors", "negative_entries"},
"oss": {"dir", "served": [slug], "missing": [slug], "outdated": [slug], "unpinned": [slug], "last_fetch":
OssFetchReport|null}}`; `catalog`: `CatalogStats`. `config` gains `catalog_sources`, `thumb_proxy`,
`games_embed_hosts`, `oss_fetch`, `vpn_check_url` and `vpn_check_url_v6` (the hosts only), `vpn_check_interval_min`,
`vpn_egress_shared_ok` (g1 writes these keys in `admin/mod.rs`, §2.2's declared overlap; the `catalog` placeholder
there is replaced by `CatalogStats`).

### 4.11 Tests and fakes

Fakes: the crate's `FixtureFetcher` (real captures) and `ManualClock`; `backend/tests/common` (the real router on a
temporary data directory; its defaults gain `GNOME_CATALOG_REFRESH_HOURS=0` and `GNOME_OSS_FETCH=manual`, so no
existing or new test server imports from the internet or fetches from GitHub; `TestApp::with_modules` awaits
`state.prepare_modules()` after `open_with`, so routes are prepared exactly as in `serve_all`; games tests build their
module list with `|s| builtin_modules_with_games(s, GatewayOptions::default(), GamesOptions { fetcher:
Some(fixture), clock: Some(manual), .. })`); a local HTTP server with a gnome-net client built with `allow_loopback` + `allow_http`
for the fetcher, thumbnail and OSS tests; tarballs and images generated inside the tests (tiny PNG/JPEG/WebP/GIF
bytes, HTML labelled `image/png`, an SVG, an oversized body).

- `backend/tests/games_api.rs`: import through `POST /admin/catalog/import` with captures; every route's keys
  against API.md; paging stability and cursor binding (changed `exclude`/`mobile` → 400); `exclude` any position and
  totals; unknown `exclude` slugs ignored (200, same items and cursor as without them); `mobile`; the 400 messages; 404s (unknown, `ip_risk` after a blocklist hit, hidden by the admin, disabled
  source after a restart); the play counter (204, one count per session per hour, IP fallback, 403 without the CSRF
  header); `status`; `/api/config` flags; routes 404 with `GNOME_CATALOG_SOURCES=none`; 503 while `prepare` failed and before it ran (an `open_with` without
  `prepare_modules`); `status.playable`; a dedup row older than two hours is gone after `catalog.rankings`.
- `backend/tests/games_policy.rs`: the shell's fixed frame headers (`frame-src 'self' <proxy origin>`,
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`; the same in report-only and off modes through
  `SHELL_FRAME_ANCESTORS_ONLY`); `/play-frame/<slug>` for one game of each replayed source: the wrapper byte for byte,
  `wrapper_csp` with the game's own origin only, `X-Frame-Options: SAMEORIGIN`, `no-store`; the real Playgama
  capture's `deadlydescent.net` game: wrapper 404, `embed_allowed: false`, listed as `pending` with its count, then
  approved with `GNOME_GAMES_EMBED_HOSTS` (wrapper 200 with `frame-src https://deadlydescent.net`, `true`); an iframe
  record naming the app or the proxy host → `refused`, wrapper 404; the dot-segment and encoded-path spellings of
  §4.5 refused; OSS: the wrapper frames exactly `<proxy origin>/oss/<slug>/<entry>` with the OSS attributes, an
  `isolated` entry without `allow-same-origin`; link-out games 404; `img-src` has the proxy origin; COOP and
  Permissions-Policy on app HTML (shell and wrapper) only; the proxy role's answers unchanged
  (`backend/tests/proxy_policies.rs` keeps passing). `backend/tests/roles.rs` changes its `frame-src` assertion to
  `'self' <proxy origin>` with and without a catalog. The wrapper's rendering cost is a benchmark the integration step
  records (§11.2), not a test assertion.
- `backend/tests/games_thumbs.rs`: hit/miss/304; type, sniff, size and SVG refusals; 4xx → 404 and its negative
  entry; 5xx/timeout → 503 with `Retry-After`; ten concurrent misses → one upstream request; eviction at the cap; the
  cache found again after a restart; exact headers; the `thumb` class separate from `api` (an exhausted `api` bucket
  still serves thumbnails); `thumb_fetch` → 429; `GNOME_THUMB_CACHE_MB=0`.
- `backend/tests/games_oss.rs`: fetch from a local server (install, replace on a new commit, old build kept on
  failure; refusals: symlink, hard link, device, `..`, absolute, `.git/`, too many entries, too large, total cap,
  missing entry or license file, unreviewed entry, and §4.7's hostile archives); serving (types incl. `LICENSE` as
  `text/plain`, the three policies byte for byte, the `isolated` sandbox, 304, `HEAD`; the entry with
  `Sec-Fetch-Dest: iframe` → 200, with `document`, `empty` or none → 404; another `.html`/`.xml` file of the build →
  404; 404 for `%2e%2e`, `..%2f`, `.gnome-oss.json`, a hidden file, a symlink placed by hand, a directory, an unknown
  slug); the app role's plain 404; single-origin mode: `oss` gated off with the warning; the manifest test (every
  enabled entry `reviewed`).
- `backend/tests/games_admin.rs`: 202/409/422; overrides visible in listings and the policy; diagnostics keys;
  metrics lines. `backend/tests/cli.rs` (extended): `catalog import --replay` with the index of §4.6 (each source's
  recorded status, exit code and counts; no request leaves the process; js13kGames stops at the pinned year), an
  unmatched request ends `failed` at once (no back-off), unknown source (2), `..` in an index (2), `catalog stats`.
- `config.rs` unit tests: every crate variable in `VARS` (a recording lookup over `CatalogConfig::from_env`); the
  cross-field rules of §3.1 (D16 in its five cases); TOML keys for the crate's variables accepted.
- `#[ignore]`d online tests (`backend/tests/games_online.rs`, run by hand and by the integration step with
  network): a `--limit 96` GamePix import through the real `CatalogFetcher`; one real thumbnail through the cache;
  the real fetch of every enabled OSS entry at its pinned commit (the browser half of that check is §13.1's online
  row).
- Crate: its existing suite plus the tests of §4.8.

## 5. Lane g2: games UI

### 5.1 What it builds

The three placeholder pages become the real ones, in the v2 design (DESIGN §9.4 page column `--page-max` 1200px,
§12 "Games": the novene launcher pattern), plus the client code under `src/games/`.

- **Games page** (`/games`; the URL keeps `q`, `category`, `tag` and `sort` as query parameters, written with the
  app router's replace navigation so Back leaves the page instead of undoing filters):
  - Header: "Games" and one line from `GET /api/games/status`: "<playable> games to play here from <network
    names>" plus, when `listed > playable`, " · <listed − playable> more on other sites" (`--text-3`). When this
    browser allowed a network (D24): "Game networks you allowed: <names>" with **Forget**.
  - Toolbar (one row on desktop, DESIGN §12: 38px glass fields, `--radius-lg`): search (debounced 250 ms; a query
    of one or two letters searches whole words only, as the server does), category select ("All categories" + the
    server's categories with counts, hidden ones left out), sort select ("Popular", "Trending", "New", "A–Z",
    "Featured"; "Best match" while searching; default `games.defaultSort`; a per-visit choice, it does not change
    the setting). When `games.showMobileOnly` or `games.hiddenCategories` apply, a small link says so ("Touch screens
    only", "3 hidden categories") and opens Settings → Games.
  - Without search, category or tag: shelves, each a horizontal row of tiles with a heading and a "See all" link (to
    the matching sort): **Favorites** and **Recently played** (local, D9; only when not empty; resolved through
    `by-ids`, see below), **Featured**, **Trending**, **Popular**, **Recently added** (one `sections` request); then
    the **All games** grid in `games.defaultSort`. Shelves and the All games grid hold playable games only.
  - With search, category or tag: one result grid with the count ("<n> results"), requested with
    `include_link_out=1`, so itch.io and js13kGames records appear there with their badge (the count includes them).
  - The grid is the design system's `VirtualGrid` (only visible rows render; `onEndReached` loads the next keyset
    page of 48; items are de-duplicated by id across pages; at most 15,000 kept in memory); `games.view = 'list'`
    uses `VirtualList` with `ListRow`s instead; `games.cardSize` sets the tile width (`small` 150px, `medium` 185px,
    `large` 230px; on phones at least two columns).
  - Tiles (DESIGN §12): glass tile, thumbnail (`--radius-xl` + 2, `loading="lazy"`, a monogram placeholder on
    error or without one), title (12.5px/500), a small "via <network>" line in list view; link-out games carry an
    "Opens on itch.io" badge and open `source_url` in a new tab (`rel="noopener"`); a tile is a link to
    `/games/<slug>`.
  - States: skeleton tiles while loading (no layout shift); "Games could not be loaded" + **Try again** on a network
    or 5xx error (the shelves and grid keep what they had); **empty catalog** (`status.listed` 0): "No games yet"
    with the reason from `status` ("The first import is running." / "The last import from GamePix failed; the server
    retries on its own." / "The first import starts within a minute of the server starting."); `features.games`
    false: "Games are not available on this server" ("This server's operator has not enabled a game catalog."); no
    results: "No games match" + **Clear search**.
  - Mobile (< 760px): toolbar stacked (search full width; category and sort side by side), shelves scroll with
    snap points, 16–20px side padding (DESIGN §9.2).
- **Game detail page** (`/games/:slug`): title, "via <network>" (with the developer and `developer_url` when known),
  **Play** (or "Open on <host>" for `playable: false` and `embed_allowed: false`, new tab), **Add to favorites**,
  every link to another site through `safeLink()` (§5.2: `https:` only, `rel="noopener noreferrer"`),
  facts (categories as chips linking to `/games?category=`, tags to `/games?tag=`, "Works on touch screens",
  orientation, the `flags` as plain words: "Kids friendly", "No blood", "No cruelty", "In-app purchases", "Paid"),
  "About this game" (description), "How to play" (instructions), for OSS games a **License** panel (SPDX license,
  the copyright line from `attribution`, "Source code" → `oss.repository`, "License text" → `oss.license_file_url`,
  the pinned commit), "More like this" (related, honouring the same filter). An unknown or removed game: "This game
  is not available" with a link back to Games.
- **Player** (`/play/:slug`, §5.3).
- **Favorites and recently played** (D9): `games_favorites` and `games_recent` (IndexedDB, keyed by catalog id, with
  the last `GameSummary` as `snapshot` so they render while the server is unreachable). A favorite or recent entry
  that `by-ids` no longer returns, **or returns with another slug than the one stored** (ids are reassigned when an
  operator rebuilds the database), stays listed, greyed, as "No longer available" with **Remove**. Recently played is
  recorded when a game's frame first loads, only while `games.trackRecent` is on, trimmed to `games.recentLimit`
  (0 keeps none); turning `trackRecent` off keeps the list until the user clears it (Settings → Privacy → Clear
  browsing data → **Recently played games**, a registered clearer with time ranges). Changes reach the app's other
  browser tabs over the app-origin BroadcastChannel `gnome:games`.
- **The network notice** (D24, `src/games/networks.ts`): the networks this browser allowed, kept in the app
  origin's `localStorage` under `gnome:games:allowed-networks` (a JSON array of `NetworkId`s; the app already keeps
  small per-browser flags there), changed only by the notice's **Play**, the Games page's **Forget** and the
  `gamesNetworks` clearer ("Game network choices" in Settings → Privacy → Clear browsing data; registered from
  `start.ts` with `registerClearer`, no time ranges). Other app tabs follow over `gnome:games`.
- **Feature registration** (`src/games/start.ts`): `registerFeature('games')` while `server.config.features.games`
  is true (unregistered when it turns false), as the **last** step of the lane (D20).

### 5.2 Interfaces it provides (exact)

```ts
// frontend/src/games/api.ts
import type { Settings } from '../settings/schema';
import type { GameCategory, GameListPage, GameListQuery, GamePage, GameSections, GameSummary, GameTag, GamesStatus, CategorySlug } from './types';

/** What every listing honours (Settings → Games, D11). */
export interface GameFilter { mobile: boolean; exclude: CategorySlug[] }
/** exclude = hiddenCategories ∩ the server's category slugs (≤ 19, sorted; before the categories loaded: none). */
export function filterFromSettings(s: Settings['games'], known: readonly CategorySlug[] | null): GameFilter;

export interface GamesApi {
  list(q: GameListQuery, signal?: AbortSignal): Promise<GameListPage>;
  sections(f: GameFilter, signal?: AbortSignal): Promise<GameSections>;
  categories(signal?: AbortSignal): Promise<GameCategory[]>;
  tags(prefix: string, limit?: number, signal?: AbortSignal): Promise<GameTag[]>;
  /** ≤ 200 ids per request (the client splits longer lists); missing games are simply absent. */
  byIds(ids: readonly number[], signal?: AbortSignal): Promise<GameSummary[]>;
  /** null on 404. */
  game(slug: string, f: GameFilter, signal?: AbortSignal): Promise<GamePage | null>;
  status(signal?: AbortSignal): Promise<GamesStatus>;
  /** `POST /api/games/:slug/play`; failures are ignored (a play count is best effort). */
  play(slug: string): Promise<void>;
}
/** Over src/lib/api.ts; every answer is shape-checked and malformed items are dropped (counted in diagnostics). */
export function createGamesApi(): GamesApi;

/** Only these thumbnail URLs are rendered: `/api/thumb/<id>`, `https:` URLs, and `<proxy origin>/oss/…`. */
export function thumbnailSrc(summary: GameSummary, proxyOrigin: string | null): string | null;
/** An href for developer_url, source_url and oss.repository: `https:` URLs only (`new URL()` parsing, never string
 *  prefixes), else null (rendered as text, no link). Used with rel="noopener noreferrer" target="_blank". */
export function safeLink(url: string | null): string | null;
/** oss.license_file_url: only `<proxy origin>/oss/<slug>/…` of this game (origin and pathname compared after parsing). */
export function licenseLink(game: GameDetail, proxyOrigin: string | null): string | null;

// frontend/src/games/player.ts — the app page's own frame; the game's sandboxed frame is inside the wrapper (§4.5)
/** `allow` of the outer frame: the superset the wrapper may pass on (the wrapper narrows it per game, §4.5). */
export const OUTER_ALLOW = 'fullscreen; autoplay; gamepad; accelerometer; gyroscope';

export interface FrameAttributes {
  src: string; // `/play-frame/<slug>` (same origin; the slug encoded with encodeURIComponent)
  title: string; // "<game title> (game)"
  allow: string; // OUTER_ALLOW
  allowfullscreen: true;
}
/** null when the game must not be framed here (`playable` false, `embed_kind` 'link', `embed_allowed` false). */
export function frameAttributes(game: GameDetail): FrameAttributes | null;
/** The network whose notice (D24) this game needs; null for OSS games. */
export function noticeNetwork(game: GameDetail): NetworkId | null;
/** Aspect ratio of the stage: width/height when both are known, else 16:9 (landscape, any) or 9:16 (portrait). */
export function stageAspect(game: Pick<GameDetail, 'width' | 'height' | 'orientation'>): number;

// frontend/src/games/library.svelte.ts
export interface GameLibrary {
  readonly favorites: readonly GameFavoriteRecord[]; // lib/idb.ts types, newest first
  readonly recent: readonly GameRecentRecord[];
  isFavorite(id: number): boolean;
  toggleFavorite(game: GameSummary): Promise<boolean>; // the new state
  removeFavorite(id: number): Promise<void>;
  recordPlay(game: GameSummary, at?: number): Promise<void>; // honours trackRecent / recentLimit
  removeRecent(id: number): Promise<void>;
  clearRecent(since?: number): Promise<void>;
  /** Refresh snapshots from `by-ids`; returns the ids the server no longer lists, counting an id whose returned slug
   *  differs from the stored one as no longer listed (its snapshot is kept, never replaced by the other game). */
  refresh(api: GamesApi): Promise<number[]>;
}
export function gameLibrary(): GameLibrary; // one per app page

// frontend/src/games/networks.ts (D24)
export function allowedNetworks(): readonly NetworkId[];
export function allowNetwork(id: NetworkId): void;
export function forgetNetworks(): void;

// frontend/src/games/catalog.svelte.ts — the Games page's listing state (one per page mount)
export class CatalogView {
  constructor(api: GamesApi, filter: () => GameFilter);
  query: GameListQuery;              // set → aborts the running request, starts page 1
  readonly items: GameSummary[];
  readonly total: number | null;
  readonly state: 'idle' | 'loading' | 'more' | 'done' | 'error';
  readonly error: string | null;
  loadMore(): void;                  // VirtualGrid onEndReached; a no-op while loading or done
  retry(): void;
}

// frontend/src/games/start.ts
export function startGames(): void; // idempotent
```

### 5.3 The player

- Stage: a glass card under the page header (DESIGN §12 "Detail and Play pages: glass card with the embed, actions
  in the header"), the frame at `stageAspect` filling the column width (desktop) or the viewport width (phones),
  never taller than the visible area; the header holds the title, **Fullscreen**, **Add to favorites**, **Game
  details**.
- **The notice** (D24): when `noticeNetwork(game)` is a network this browser has not allowed, the stage shows the
  region "Before you play": "This game loads from <network>. <network> and its advertisers see your IP address and
  may set cookies. GNOME's VPN and content blockers do not apply to games." and **Play**; nothing of the network
  loads before it is pressed (no frame, no request: a games-player row checks it). **Play** calls `allowNetwork()` and
  creates the frame (a gesture: `fullscreenOnPlay` applies to it as to the detail page's Play).
- The frame: `frameAttributes()` exactly (the outer frame; the wrapper renders the game's sandboxed frame, D2, §4.5);
  `loading="eager"`; created on mount (or on the notice's **Play**), removed on unmount (leaving the page stops the
  game: game pages are not kept alive like the Browser view).
- On the frame's first `load` (it fires once the wrapper and the game's document loaded): `library.recordPlay()` and
  `api.play(slug)`.
- **Fullscreen**: the button calls `requestFullscreen()` on the stage element (GNOME's own element: works for every
  game, even one without its own fullscreen button, and the only fullscreen OSS games get), then, on phones,
  `screen.orientation.lock(orientation)` for a landscape or portrait game (failures ignored). A network game's own
  fullscreen button works through the `fullscreen` delegation of both frames.
  **`games.fullscreenOnPlay`**: when the page opens from the detail page's **Play** or the notice's **Play** (a click in
  GNOME's UI, still within the browser's user-activation window, `navigator.userActivation?.isActive`), the stage
  enters fullscreen at once; otherwise (a typed URL, a reload, an expired activation) the Fullscreen button is focused
  and the line "Press Fullscreen to play in fullscreen" is shown: browsers refuse fullscreen without a gesture.
- The note under the stage (D13, §12.6): "Loaded directly from <network>. Not routed through GNOME or its VPN." with
  an info popover: "The publisher and its advertisers see your IP address and may set cookies. GNOME's VPN and
  content blockers do not apply to games. Playing tells the game network this server's address." OSS games: "Served by
  this GNOME server." and the license line.
- "Problems? Open on <host>" (`source_url` through `safeLink`, new tab) is always there: a cross-origin frame's failure
  cannot be detected reliably (its `load` fires for error pages too).
- A game the server no longer frames (an approval withdrawn, the game hidden: the wrapper answers 404 inside the
  frame) shows the server's 404 text in the stage; the link-out stays. No app reload is ever needed for a newly
  approved host: the wrapper's policy is computed per request (D4).
- Keyboard: GNOME's shortcuts do not reach the app while the focus is inside the cross-origin frame (browsers do
  not pass key events out of it); Escape leaves fullscreen as in any browser. About's limitations say so (§14).

### 5.4 Settings keys it reads

All exist (ARCHITECTURE §5.3; the Settings → Games rows exist in `pages/settings/sections/Games.svelte` and need no
change from g2; one description changes with v3's texts, §10): `games.view`, `games.cardSize`, `games.defaultSort`, `games.fullscreenOnPlay`, `games.trackRecent`,
`games.recentLimit`, `games.showMobileOnly`, `games.hiddenCategories` (§10). They sync with the settings document
like today; favorites and the recent list do not (D9).

### 5.5 Tests and fakes

- **Fakes**: `src/games/testing/fake-api.ts` (`GamesApi` over records taken unchanged from
  `crates/catalog/tests/fixtures/` captures, with their provenance in the file header; paging, filters, 404s, a
  failing mode); the e2e stack once g1's read routes land (§2.2: g1's M1 comes first).
- **Unit (vitest)**: answer shape checks (malformed items dropped); `filterFromSettings` (an unknown slug and 25
  hidden slugs → only known ones, ≤ 19; categories not loaded → none); `thumbnailSrc` (relative, https, proxy-origin
  OSS, refusing `javascript:`, `data:`, `http:` of another host); `safeLink` and `licenseLink` (`javascript:`,
  `data:`, `http:`, a look-alike `https://<proxy origin>.evil.example/oss/…`); `frameAttributes` byte for byte
  (`/play-frame/<slug>` with an encoded slug; null for link-out and `embed_allowed: false`); `noticeNetwork`;
  `networks.ts` (allow, forget, the clearer, a corrupt stored value); `stageAspect`;
  `CatalogView` (abort on query change, de-duplication across pages, `loadMore` guards, error and retry, the 15,000
  cap); `GameLibrary` with `fake-indexeddb` as the other library tests use it (toggle, limits, `trackRecent` off,
  `recentLimit` 0, clearer ranges, the BroadcastChannel echo, `refresh` with a reassigned id → "No longer available");
  copy (empty-state reasons and the header line from `GamesStatus`).
- **E2E**: `games-ui` and `games-player` rows of §9 (lane t writes them against §3.3; g2 runs them).
- **Budgets checked by g2** (with lane t's `games-ui budget` row): the `/games` route's own chunks ≤ 30 KiB gzip JS
  and ≤ 8 KiB gzip CSS (today's placeholder: 1.1 KiB raw); no new dependency.

## 6. Lane v2: VPN exit check (backend)

### 6.1 What it builds

gnome-server checks each VPN location's exit itself (D14), through the same HolyWisp instance the gateway splices
that location's users to, so a tunnel that fails closed (the instance answers, its streams do not connect;
ARCHITECTURE §7) shows up before a user notices, and the VPN page can show an exit before any engine host runs. The
check service is the operator's explicit choice (`GNOME_VPN_CHECK_URL`, empty by default, D15); without one nothing
of this section runs. Results are information only: they never change the route or the connection state (D14).
The `vpn::VERIFY_URL` constant (`https://am.i.mullvad.net/json`) is deleted; `verify_url` comes from the config.

```rust
// backend/src/vpn/wisp_client.rs — a minimal Wisp v1 client: one TCP stream over one WebSocket (promoted from the
// client in backend/tests/holywisp_e2e.rs, which stays as the end-to-end check of the gateway).
pub struct WispStream { /* a tokio DuplexStream pumped by a task that owns the WebSocket */ }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WispError {
    /// TCP connect, WebSocket handshake or the server's first frame (CONTINUE on stream 0) failed.
    Upstream,
    /// The server closed the stream (Wisp CLOSE; its reason byte kept for diagnostics).
    Closed(u8),
    Timeout,
}

impl WispStream {
    /// Connect to `upstream` (a location's HolyWisp, `VpnProfile::upstream`), handshake on the route's canonical path
    /// as the gateway writes it (`/wisp/p/<id>/`; no cookies, no `X-Forwarded-For`), then CONNECT a TCP stream to
    /// `host:port`. Honours CONTINUE flow control; frames over 64 KiB are an error.
    pub async fn connect(upstream: &crate::gateway::upstream::UpstreamAddr, path: &str, host: &str, port: u16, timeout: Duration)
        -> Result<WispStream, WispError>;
}
impl tokio::io::AsyncRead for WispStream { /* … */ }
impl tokio::io::AsyncWrite for WispStream { /* half-close sends Wisp CLOSE */ }

// backend/src/vpn/exit.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitState { Ok, Failed, Unchecked, Off }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitError { UpstreamUnreachable, ConnectFailed, TlsFailed, HttpStatus, BadAnswer, Timeout }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExitResult {
    pub state: ExitState,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub provider_exit: Option<bool>,
    pub country_match: Option<bool>,
    pub checked_at: Option<i64>,
    pub error: Option<ExitError>,
    /// The check through `GNOME_VPN_CHECK_URL_V6` (`None` when not configured): `state`, `ip`, `error` only.
    pub v6: Option<ExitV6>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExitV6 { pub state: ExitState, pub ip: Option<String>, pub error: Option<ExitError> }

pub struct ExitChecker { /* the parsed check URL, a TlsConnector (webpki roots), results by profile id, in-flight
                            checks by profile id, the last on-demand check by profile id, counters */ }

impl ExitChecker {
    /// `None` when `GNOME_VPN_CHECK_URL` is empty or there are no profiles.
    pub fn new(config: &Config) -> Option<Self>;
    /// Tests: another root store (a test CA).
    pub fn with_roots(config: &Config, roots: rustls::RootCertStore) -> Option<Self>;
    /// The check service's host, for the UI's wording ("<host> reports …").
    pub fn service_host(&self) -> &str;
    /// The last result (`unchecked` before the first one).
    pub fn result(&self, profile_id: &str) -> ExitResult;
    /// Check now through the profile's HolyWisp (the IPv4/default name, then the IPv6 name when configured);
    /// concurrent calls for one profile share one check. The health status comes from
    /// `state.ext::<Gateway>()` → `upstreams` (a `down` location is not contacted).
    pub async fn check(&self, state: &AppState, profile: &VpnProfile) -> ExitResult;
}

/// The check service's JSON → ip (an IP literal, required), country (≤ 64), city (≤ 128), the optional
/// `country_code`/`country_iso` (two letters), the optional `mullvad_exit_ip` boolean → `provider_exit`;
/// `country_match` against the profile (code if given, else the name, case-insensitive; `None` if neither).
pub fn parse_answer(body: &[u8], profile: &VpnProfile) -> Result<ExitResult, ExitError>;
```

The check, exactly: `WispStream::connect` to the profile's upstream (5 s; failure → `upstream_unreachable`; skipped
without network traffic, with that result, while the health job has the location `down`) → a Wisp CLOSE for the
stream before any data → `connect_failed` → for `https:` a rustls handshake with the check host's name (webpki
roots; failure → `tls_failed`) → `GET <path?query> HTTP/1.1`, `Host`, `User-Agent: exit-check/1` (neutral: it
names no product and no instance), `Accept: application/json`, `Connection: close` → read until EOF, at most 16 KiB, the head parsed with
`httparse`, `Content-Length` or a chunked body decoded within the same cap → a non-2xx status → `http_status` →
`parse_answer` (failure → `bad_answer`). The whole check has a 15 s deadline (`timeout`). Nothing about users is
sent; the service sees the location's exit address and the User-Agent. With `GNOME_VPN_CHECK_URL_V6`, the same
check runs a second time against that name (the service's IPv6-only host, e.g. a separate `ipv6.` name; HolyWisp
resolves it to IPv6 only because the name has only AAAA records) and fills `v6`: an IPv4-only tunnel beside an IPv6
leak, or the reverse, shows as two different answers. `services/vpn/README.md` requires each location's network
namespace to tunnel or block IPv6.

Schedule (`vpn.exit-check`, in `Vpn::jobs`, only when the checker exists and `GNOME_VPN_CHECK_INTERVAL_MIN` > 0): a
1-minute tick runs the profiles whose next check is due, at most two at a time; each profile's first check comes at
a random time spread over the whole first interval (never in a burst after boot, which would link an instance's
locations together), the next after the interval × a random factor in 0.8–1.2. The `Vpn` module gets
the checker as module state (`ModuleSetup::provide`), so the module becomes `crate::vpn::install(setup) ->
Arc<dyn Module>` (one line in `module.rs`'s `builtin_modules_with`, written by g1 on day one together with the
games line: `modules.push(crate::vpn::install(setup));` replacing `Arc::new(crate::vpn::Vpn)`).

### 6.2 Routes

| Method & path | Answer |
| --- | --- |
| `GET /api/vpn/locations` (app origin, public; unchanged otherwise) | `200 {"profiles": [{"id", "label", "country_code", "country", "city", "provider_note", "path", "status", "checked_at", "exit": {"state", "ip", "country", "city", "provider_exit", "country_match", "checked_at", "error", "v6"}}], "verify_url": string\|null, "check_service": string\|null}` — `exit.state` is `off` for every profile when checks are off (the default); `verify_url` (also used by the browser's own check, ENGINE-PROTOCOL §6.13) is `GNOME_VPN_CHECK_URL` or `null`; `check_service` its host, with `:port` when the port is not the scheme's default. **The exit details are shown only to clients the access policy lets use the proxy** — the policy behind `POST /api/session` and ticket minting (`auth::extract::{resolve_user, resolve_anon}`, never issuing a cookie): anyone in `open` mode, a valid anonymous session in `code` mode, a signed-in user in `accounts` mode. Everyone else gets each profile's health fields with `exit` = `{"state": "unchecked"}` and every other field `null`, so the operator's egress addresses and `provider_exit` are not public |
| `POST /api/vpn/locations/:id/check` (app origin; CSRF rules; `vpn_check` rate class; only when checks are on, else the route does not exist: `404`) | `200 {"exit": VpnExit}` once the check finished (≤ 35 s with an IPv6 name, else ≤ 20 s; a check of that location younger than 60 s is answered without a new one; a running one is joined) · `401 access_code_required` / `401 login_required` for a client the access policy does not admit (as `POST /api/wisp/ticket`) · `404 not_found` (unknown id) · `429 rate_limited` |

`/admin/diagnostics` → `vpn`: `{"check_service", "interval_min", "exits": {"<id>": ExitResult}}`; `/admin/metrics`:
`gnome_vpn_exit_checks_total{id,result}` (`result` = `ok` or the error), `gnome_vpn_exit_ok{id}` (1 / 0),
`gnome_vpn_exit_checked_seconds{id}`.

### 6.3 Operator documentation (lane v2 owns these two files)

`services/vpn/README.md`: "Verify" describes the server's check (what it proves: the location's streams reach the
internet and the check service names an exit; what it does not: that a given user's pages use that location —
that is the app's route choice and the route-bound tickets of D23), `GNOME_VPN_CHECK_URL`, `GNOME_VPN_CHECK_URL_V6`
and `GNOME_VPN_CHECK_INTERVAL_MIN`; that **nothing is checked until the operator sets a check service**; **a
self-hostable check endpoint**: any HTTPS endpoint outside the tunnels answering `{"ip": "<the client's address>"}`
(`country` and `city` optional), with a tested Caddy and nginx example (lane v2 runs both examples once and records
the result in its report), plus a separate IPv6-only name for `GNOME_VPN_CHECK_URL_V6`; that a third party's check
service (e.g. a VPN provider's connection check) may be used only where its operator allows automated checks, and
sees each location's exit address every interval; that each location's network namespace must tunnel or block IPv6.
"Before you start: terms" adds D16 in plain words: use only egress whose terms allow every person who can use your
instance; consumer VPN subscriptions, Mullvad's among them, do not allow offering the VPN to others, and GNOME's access
modes do not change that; GNOME warns at startup when VPN locations meet `GNOME_ACCESS_MODE=open` or accounts mode
with open registration, and reminds code-mode operators to keep the code within those people.
`profiles.example.toml`: `provider_note` guidance ("whose egress this is, e.g. 'the operator's own WireGuard server';
a provider's name in plain text at most, no logos").

### 6.4 Tests and fakes

Fakes: an in-process Wisp server (`tokio-tungstenite` server side plus a small Wisp responder that connects
CONNECTs to local TCP targets, refuses some with a CLOSE reason, and can shrink its CONTINUE buffer); a local HTTP
target and a local TLS target with a test CA (a committed test-only key pair under `backend/tests/fixtures/vpn/`,
generated once with `openssl` by the lane, never used outside tests); paused Tokio time for the schedule.

- `wisp_client` unit tests: connect and echo, CLOSE before data → `Closed(reason)`, flow control with a 2-packet
  buffer, half-close, an oversized frame, a server that never sends the first CONTINUE (→ `Upstream` within the
  timeout).
- `backend/tests/vpn_exit.rs`: each error class from its cause (closed port, CLOSE, bad certificate, 500, HTML,
  missing `ip`, slow server → `timeout`); `parse_answer` with am.i.mullvad.net's documented shape (research §3.5,
  verbatim), an `ip`/`country`/`country_iso`/`city` shape, a 17 KiB answer, chunked; `country_match` cases; the
  locations shape (`exit`, `verify_url`, `check_service`; the default server: checks off → `off`/`null`, no check
  route, no job); the access gate in every mode (open: details; code and accounts without a session: `unchecked` and
  nulls, the check route 401; with a session: details); the IPv6 name filling `v6`; the `User-Agent` exactly
  `exit-check/1`; on demand: the 60 s reuse, joining a running check, 404, 429, 403 without `X-GNOME-Request`; the
  job's first checks spread over the interval and its intervals; a `down` location skipped without traffic;
  diagnostics and metrics keys.
- `#[ignore]`d online test: a real check through a real HolyWisp (`HOLYWISP_BIN`, like `holywisp_e2e`) to the check
  service named by `VPN_CHECK_ONLINE_URL` (skipped when unset; the integration step points it at one of the §6.3
  examples it runs, never at a third party's service) through the direct instance (it reports this machine's address,
  which the test does not print).
- E2E (lane t, `vpn-ui` rows V8–V10 and V12): through the runner's `e2e-vpn` HolyWisp (TEST-ONLY allow-loopback
  overlay) to the local check fixture over `http:`, and through `e2e-dead`.

## 7. Lane v1: VPN page and client

### 7.1 What it builds

- **The VPN state** (`src/vpn/state.svelte.ts`, one per app page): the location list and exits from
  `GET /api/vpn/locations` (every 60 s while `vpn.mode` is `gateway` or the VPN page is visible, at once on a mode,
  location or route change and when the page becomes visible; on errors 60 s → 2 → 5 min; never while the server
  offers no locations), the connection as the app knows it (`VpnConnection`, D13), the chip, connect, disconnect,
  location choice and on-demand checks. Before lane v3 lands, the browser's own facts come from the existing
  read-only getters (`browser.vpnLocation`, `browser.engineState`, `browser.status.transport`), handed in by
  `start.ts` through `setBrowserFacts` (a lazy import of `browser.svelte.ts`; no browser file changes).
- **Connect and disconnect** (D12): **Connect** sets `vpn.mode = 'gateway'` (with `preferredLocation` when a location
  is chosen; `null` = Automatic); **Disconnect** sets `vpn.mode = 'off'`. Choosing a location in the list sets
  `preferredLocation`; while connected the route switches at once (toast "Now using <label>"), while off it only
  selects. Pages already open keep what they loaded; the engine host rebuilds its transports for the new route, and
  connections a page already holds are not moved — except that the gateway closes a session's default-route
  connections once the app minted a profile-route ticket (D23). Until v3 lands, the page says once, for 10 s after a
  change, "Tabs you opened earlier keep their pages. Reload them to load them through <label>."; v3 replaces it with
  the persistent line "<n> tabs may still use the previous route until you reload them" (§8.1).
- **Auto-connect** (D12) is not v1's: a decision in an idle callback cannot come before the browser's start (which
  restores tabs and serves `/browse?url=` deep links on its own), so v3 makes it part of that start (§8.1). v1 provides
  the pure `decideAutoConnect` and, once v3 lands, the page's "Connect automatically" switch.
- **Device-local `vpn.mode` and `vpn.killSwitch`** (D12) in `src/settings/`, the home-picture pattern
  (`local-picture.ts`): a downloaded or merged document gets this browser's two values back in
  `withDeviceSettings()` (which every download and merge already passes through before `deps.apply`), and an imported
  file keeps this browser's values (`store.import()`); `syncedPart()` is unchanged, so an uploaded document may carry
  this device's values, which every other device ignores; exports still contain them (ignored on import). Because the
  server copy is rewritten with the local values before the merge, the merge never sees a difference in these keys
  (no upload ping-pong between devices with different switches).
- **The tab-strip chip** (`reportStatus('vpn', …)` / `clearStatus('vpn')`; `TabStrip.svelte` already renders it,
  DESIGN §11.2): connected or ready → `ok`, "<label>" (`degraded`, "<label> · exit check failing" while
  `exitWarning` is set); connecting → `starting`, "<label>"; blocked → `down`, "Blocked"; fallback → `degraded`,
  "Not in use"; off → no chip.
- **The VPN page** (`src/pages/vpn/`; DESIGN §12 "VPN"; the narrow column, glass cards, §3.3 names):
  1. **Status card** (hero): tone dot, the state text of §7.3, the location (label; city, country; the operator's
     `provider_note` as plain text in `--text-3`), the one-line consequence of §7.3, **Connect** / **Disconnect**
     (primary / outline). While blocked: **Disconnect** and a link to the kill-switch row below. Without offered
     locations: "This server offers no VPN locations." (and **Disconnect** while the switch is on). With
     `exitWarning` set: the warning line "The exit check through <label> fails: <reason>" (§7.3) under the state;
     the state itself does not change (D14).
  2. **Exit check** card: without a check service (`verify_url` null, the default) only "This server runs no exit
     checks."; otherwise the server's check of the current or selected location as "<service> reports <ip> in <city>, <country> · checked <relative time>"; with `provider_exit`
     present, "<service> says this address is one of its VPN exits: yes / no"; `country_match: false` → a warning
     "<service> places this exit in <country>, not <profile country>"; with `v6`, "IPv6: <service> reports <ip>" (or
     its failure); a failure in plain words (§7.3); **Check again** (`POST …/check`, disabled for 60 s after a check;
     a 401 shows "Enter the access code or sign in to see exit checks."). Lane v3 adds "This browser's check" here
     (§8.1).
  3. **Locations** listbox: "Automatic — the first location that is online" first, then every location with its
     status ("Online", "Offline", "Not checked yet") and its last exit answer; the chosen one `--selected` + ring.
  4. **Behaviour** card (SettingRows, the same keys as Settings → VPN): "Block if the location is down"
     (`killSwitch`, "Kept in this browser only."); "Connect automatically" (`autoConnect`) and "Check this browser's
     exit" (`verifyExit`) are shown only once lane v3 lands auto-connect and the check, because before that the
     switches would do nothing.
  5. **Privacy** card "What the VPN does and does not do" (§7.3, verbatim); a warning line when `privacy.webrtc` is
     `allow` and the kill switch is off; the footer "GNOME is not affiliated with any VPN provider. These locations are
     run by this server's operator."
  6. Mobile: the cards stack; the status card stays first.

### 7.2 Interfaces it provides (exact)

```ts
// frontend/src/vpn/api.ts
/** Shape-checked; an older server without `exit` / `check_service` gets `exit.state 'unchecked'` and the URL's host. */
export function fetchLocations(signal?: AbortSignal): Promise<VpnLocations>;
/** `POST /api/vpn/locations/:id/check`; null when the server has no check route (404) or the request failed. */
export function checkLocation(id: string): Promise<VpnExit | null>;

// frontend/src/vpn/state.svelte.ts
export interface BrowserFacts {
  /** `browser.vpnLocation`: the profile route the app chose (null off the profile route). */
  readonly vpnLocation: { id: string; label: string; status: 'up' | 'down' | 'unknown' | 'gone' | 'none' } | null;
  readonly engineState: string; // Browser.engineState
  /** The engine host's transport sides whose `endpoint` is `profile` (EngineHostStatus.transport). */
  readonly profileTransport: ReadonlyArray<{ state: 'connecting' | 'ready' | 'degraded' | 'offline'; detail: string | null }>;
}
export function setBrowserFacts(facts: BrowserFacts | null): void;

export interface VpnState {
  readonly locations: readonly VpnLocation[] | null; // null until the first answer
  readonly verifyUrl: string | null;
  readonly checkService: string | null;
  readonly loadError: string | null;
  readonly connection: VpnConnection;
  /** The health status per location for the route choice (lane v3): `/api/vpn/locations` `status` only — exit
   *  checks never enter it (D14). */
  statusMap(): Readonly<Record<string, 'up' | 'down' | 'unknown'>>;
  /** The server's last check of this location failed: its error, else null (a warning only, D14). */
  exitWarning(id: string): ExitError | null;
  connect(locationId?: string | null): void;
  disconnect(): void;
  select(locationId: string | null): void;
  checkNow(id: string): Promise<VpnExit | null>;
  refresh(): Promise<void>;
  /** The VPN page is visible: poll every 60 s whatever the mode; returns the stop function. */
  watch(): () => void;
}
export function vpnState(): VpnState;

/** Pure: whether a fresh start turns the VPN on (D12): fresh, `autoConnect` on, mode off, and the server offers at
 *  least one location (`/api/config` wisp.profiles; v3 calls it once that is known, before any tab is live). */
export function decideAutoConnect(fresh: boolean, s: Settings['vpn'], offeredLocations: number): boolean;
/** Pure: the app's facts → the connection the page and the chip show (D13). */
export function connectionOf(i: {
  mode: 'off' | 'gateway';
  killSwitch: boolean;
  offered: ReadonlyArray<{ id: string; label: string }> | null; // /api/config wisp.profiles; null = not loaded
  route: BrowserFacts['vpnLocation'];
  status: Readonly<Record<string, 'up' | 'down' | 'unknown'>>;
  exitWarning: (id: string) => ExitError | null;
  engineState: string;
  profileTransport: BrowserFacts['profileTransport'];
}): VpnConnection;
/** Pure: the chip for a connection (null = no chip). */
export function chipStatus(c: VpnConnection): { state: StatusState; detail: string } | null;

// frontend/src/vpn/start.ts
export function startVpn(): void; // idempotent

// frontend/src/settings/local-vpn.ts
export type DeviceVpn = Pick<Settings['vpn'], 'mode' | 'killSwitch'>;
/** `doc` (a plain-object document from sync, a merge or an import) with this browser's `vpn.mode` and
 *  `vpn.killSwitch` put back (D12); a document without a `vpn` object gets one with just these two keys. */
export function withLocalVpn<T>(doc: T, device: DeviceVpn): T;
```

`connectionOf` rules (a unit-test table covers every row): mode `off` → `off`; mode `gateway` and no offered
location → `blocked`/`fallback` with `no-location` (by `killSwitch`); the route's location gone from `/api/config`
→ `location-gone`; its health status `down` → `location-down`; otherwise, with an engine host running: a `profile`
side `ready` → `connected` (`engine: 'running'`), `connecting`/`degraded` → `connecting`, `offline` with
`upstream-unreachable` or `unknown-profile` → `blocked`/`fallback` `location-down`/`location-gone`; without an
engine host → `connected` with `engine: 'not-started'` (shown as "Ready", §7.3). `connecting` and `connected` carry
`exitWarning(route id)`; an exit-check failure never produces `blocked` or `fallback` (D14). The engine host's
transport facts are what it reports (D13): a forged `ready` can show "Connected" too early, never a route other than
the one the app chose (D23).

### 7.3 Copy (exact; `src/vpn/copy.ts`)

State texts (the `status` "Connection" and the line under it):

| `VpnConnection` | State text | Line |
| --- | --- | --- |
| `off` | "Off" | "Pages you open in GNOME go through this server's own connection." |
| `connecting` | "Connecting to <label>" | "Pages you open in GNOME will go through <label>." |
| `connected`, `engine: 'running'` | "Connected to <label>" | "Pages you open in GNOME are routed through <label>." |
| `connected`, `engine: 'not-started'` | "Ready: <label>" | "Pages you open in GNOME will be routed through <label>." |
| `blocked`, `location-down` | "Blocked: <label> is down" | "The kill switch stops pages from loading until <label> is back, instead of using this server's own connection." |
| `blocked`, `location-gone` | "Blocked: <label> is no longer offered" | the same, with "until you choose another location" |
| `blocked`, `no-location` | "Blocked: no VPN location" | "The kill switch stops pages from loading. This server offers no VPN location to route them through." |
| `fallback`, `location-down` / `-gone` / `no-location` | "Not in use: <label> is down" / "… is no longer offered" / "Not in use: no VPN location" | "Pages load through this server's own connection until the VPN can be used again." |

Exit warning (under the state while `exitWarning` is set; the state is unchanged, D14): "The exit check through
<label> fails: <reason>" with the reason below in lower case without its final period.

Exit-check failures: `upstream_unreachable` "The location does not answer." · `connect_failed` "Connections through
this location to the check service fail: the location's tunnel or the check service may be down." · `tls_failed`
"The check service's HTTPS connection failed through this location." · `http_status` "The check service answered
with an error." · `bad_answer` "The check service's answer could not be read." · `timeout` "The check took too long."
No check service: "This server runs no exit checks."

"What the VPN does and does not do" (verbatim; `<service>` = `check_service`; the **Checks** paragraph only when a
check service is set):

> **What it does.** Pages you open in GNOME's browser leave this GNOME server through the location you choose, so
> the sites you open in GNOME see that location's address instead of this server's. Your device's address is not
> sent with GNOME's page requests, but a page built to attack GNOME can still make your browser reveal it (WebRTC and
> the other gaps under Kill switch).
>
> **What it does not do.** It does not route your device, your other browser tabs or apps, GNOME's own pages and
> settings, or games: games load directly from their publishers, who see your own address. It is not a VPN app and
> changes nothing on your device.
>
> **Who runs it.** This server's operator runs these locations over internet connections they are authorized to share
> with the people who use this server. The VPN service and the location's exit can see the names of the sites you open
> (not the content of HTTPS pages). This server's operator runs GNOME itself and is trusted with more. GNOME is not
> affiliated with any VPN provider.
>
> **Checks.** The exit check asks <service> which address it sees from a location. It shows what <service> reports,
> not proof that your pages use the VPN: GNOME knows that from its own route choice, which this server enforces.
>
> **Kill switch.** With "Block if the location is down" on, pages stop loading while the location is down instead of
> going through this server's own connection. While the VPN and the kill switch are on, GNOME also blocks WebRTC in
> pages; a site built to get around that block can still learn your address.
>
> **This browser only.** The VPN switch and the kill switch are kept in this browser: your other devices and settings
> files you import don't change them. "Connect automatically" syncs with your other settings.

WebRTC warning (`privacy.webrtc` `allow`, kill switch off): "WebRTC is allowed in Privacy settings: pages can connect
to other computers directly, outside GNOME and the VPN, and learn your address." A unit test runs **every exported
string of `copy.ts`** (and v3's §10 texts and the VPN rows of `registry.ts`, once v3 lands) through a check that fails
on "Mullvad", "secure", "anonymous", "protected", "encrypted", "no logs", "hide your IP", "your IP is hidden" or
"system-wide" (case-insensitive; the provider's name may appear only inside operator text: `provider_note`, the check
service's host).

The "What it does" claim about this server's address holds against escaped code only with D23's route-bound tickets
(v3). Wave C is released only after v3 and the final matrix (§13), and row V21 proves the claim.

### 7.4 Settings keys

Reads and writes `vpn.mode` and `vpn.killSwitch` (device-local), `vpn.preferredLocation`, `vpn.autoConnect`,
`vpn.verifyExit`; reads `privacy.webrtc`. No new key and no new value (§10); one default changes:
`vpn.verifyExit` `true` → `false` in `settings/defaults.ts` (D15; ARCHITECTURE §5.3 documents no default for it, so
`contract.test.ts` is unaffected).

### 7.5 Tests and fakes

Fakes: a fake `/api/vpn/locations` (the `lib/api.ts` test double the other API tests use), fake `BrowserFacts`, fake
timers. Unit: the shape checks (an older server's answer; a gated answer with `unchecked` and nulls; `v6`), the
`connectionOf` table (an exit warning never yields `blocked`/`fallback`), `chipStatus` (the degraded chip),
`decideAutoConnect`, `exitWarning`, the polling plan (60 s while on or watched, none while off and unwatched, the
backoff, none without offered locations), connect / disconnect / select writes, `withLocalVpn` with `sync.test.ts` (a
merge with another device's `vpn.mode` and `vpn.killSwitch` changes neither and pushes nothing because of them; a
merge where the remote changed another `vpn` key, e.g. `preferredLocation`, takes that key and keeps this browser's
mode and kill switch; a download keeps this browser's values) and the store's import test (an imported `gateway`
leaves `off` alone, an imported `killSwitch: false` leaves `true` alone), the defaults test (`verifyExit` false), the
forbidden-words check over every exported string of `copy.ts`. E2E: `vpn-ui` rows V1–V11 (§9.4) once the page lands;
the rest after lane v3.

## 8. Lane v3: VPN wiring and route-bound tickets (after Wave B step 3's integration step)

### 8.1 What it changes

- `src/browser/browser.svelte.ts`:
  - drops its own `/api/vpn/locations` poll and takes `vpnState().statusMap()` (the health status only, D14) as
    `SnapshotContext.vpnStatus` (one source of truth), re-snapshotting when it changes;
  - **auto-connect inside the start, with no timeout** (D12): in `start()`, right after `detectStart()`, a fresh start
    with `vpn.autoConnect` on and `vpn.mode` off decides through `decideAutoConnect(fresh, s.vpn, offered)`, where
    `offered` is `/api/config`'s profile count; when the server config is not loaded yet, the decision is made at the
    point where the browser already waits for `server.config` before creating the engine iframe (today's
    `#ensureActiveLive` path), and **no tab is made live and no `/browse?url=` deep link is opened before it**
    (restored tabs stay discarded meanwhile, as they are created). Turning the switch on writes `vpn.mode = 'gateway'`
    before the first snapshot is built, so the first ticket, transport and page load use the profile route. A reload
    (not a fresh start) never connects;
  - keeps the Automatic location of this app page pinned (D17): it passes the pinned id to `chooseRoute` and, when
    the pinned location goes `down` and another one is picked, toasts "VPN location changed: <A> is down. Now using
    <B>.";
  - **route-bound tickets** (D23): the `TicketMinter`'s `mint` passes the route of the current `chooseRoute` result;
    a route change mints a new ticket for the new route before (or with) the snapshot that switches it, and hands it
    over with the `ticket` command; while `vpn.mode` is `gateway` a default-route ticket is minted only when the kill
    switch is off and the route really fell back;
  - counts the tabs that were live before the last route change and have not loaded a page since ("tabs on the
    previous route"), for the VPN page's persistent line;
  - adds `async verifyExit(url: string): Promise<VpnVerifyResult | null>` (capability `vpnVerify`, `vpn.verify`;
    `null` while the capability is missing or the engine host is not ready), modelled on `searchSuggestions`.
- `src/browser/engine/tickets.ts` and `src/lib/api.ts`: `requestWispTicket({ interactive, route })` sends
  `{"route": "default"}` or `{"route": {"profile": "<id>"}}`; a coalesced batch never mixes routes (a pending mint for
  another route is superseded).
- **Backend, landed in the same step** (`backend/src/gateway/{ticket,mod}.rs`; D23):
  - `POST /api/wisp/ticket` accepts an optional JSON body `{"route": "default" | {"profile": "<id>"}}` (no body =
    `default`, so the step-2 suites that mint without one keep working); an unknown profile → `422
    validation_failed` (`fields.route`);
  - ticket `w2.<exp_s>.<iat_s>.<route>.<session_ref>.<mac>`, `route` = `d`, or `p` followed by the profile id in
    unpadded base64url (profile ids may contain `.`, the separator), the MAC over everything before it under the
    existing key; `MAX_LEN` grows to fit the longest profile id (64 characters; ≈ 190 bytes in all, inside the
    engine protocol's `TICKET_RE` of ≤ 512 URL-safe characters, so `src/shared/**` does not change); `w1` tickets are refused once this lands (every engine host re-mints through
    `needTicket {reason: 'rejected'}`);
  - the gateway resolves the path first (unknown profile → `404` as today), then verifies the ticket: MAC, expiry,
    **route equals the path's route** (else `401 wisp_ticket_wrong_route`), **`iat_s` ≥ the process start**
    (else `401 wisp_ticket_stale`), and, for a default-route ticket, **`iat_s` not older than the session's latest
    profile-route mint** (else `401 wisp_ticket_superseded`); the latest profile-route mint time per `SessionRef`
    lives in memory (bounded like the other per-session maps, entries expire after the ticket TTL);
  - the existing 15 s session re-check also closes a session's open default-route connections whose ticket the
    superseded rule now refuses;
  - tests in `backend/tests/wisp_tickets.rs` and `gateway.rs`: each refusal, both paths, the re-check closing a
    default-route connection within 20 s of a profile mint, a restart refusing old tickets, a mint without a body
    still giving a default-route ticket; the existing tests that use a no-body ticket on a profile path
    (`gateway.rs`, `roles.rs`, `wisp_probe.rs`, `holywisp_e2e.rs`) mint with the profile route.
- `src/browser/engine/snapshot.ts` `chooseRoute` (the property test keeps passing): `SnapshotContext` gains
  `autoPinned?: string | null`; `RouteChoice` gains `autoPicked: string | null`. With `preferredLocation` `null`: the
  pinned id while it is offered and not `down` in `ctx.vpnStatus`; else the first offered id whose status is `up`;
  else the first offered id (the kill switch then blocks; without it the default route, as today). A chosen
  (non-null) location is never replaced by another one: unusable → kill switch blocks, else the default route.
- `src/browser/ui/error-copy.ts` + `ErrorOverlay.svelte`: for every error on the profile route an **Open VPN page**
  link (a gesture in GNOME's UI; `navigate('/vpn')`), and, while the server's last exit check of that location failed,
  the line "The exit check through <label> fails too."
- `src/browser/testing/fake-engine-host.ts`: `vpn.verify` answers (configurable result or error).
- `src/engine-host/vpn-verify.ts`: its header comment's "am.i.mullvad.net/json by default" becomes "the operator's
  `GNOME_VPN_CHECK_URL`; none by default" (a comment only; x1's file, edited after step 3's integration).
- `src/pages/vpn/**` (handed over by v1): **This browser's check** in the Exit check card, run once after each connect
  or route change once the engine host is ready, and on **Check again**, only while `vpn.verifyExit` is on (default
  off, D15) and a check service is set; kept in memory for the page session: "Through this browser's route,
  <service> reports <ip> in <country>", followed by "A page that broke out of GNOME's browser engine can fake this
  answer."; when its IP differs from the server's check of the same location: "This browser's check answered
  differently from the server's check of <label>. A page may have interfered with GNOME's browser engine, or the
  location changed its exit address." Agreement shows no extra wording (never "confirmed"). The Behaviour card's
  "Connect automatically" and "Check this browser's exit" switches appear; the persistent line "<n> tabs may still use
  the previous route until you reload them" replaces v1's 10-second note while n > 0.
- `src/pages/settings/sections/Vpn.svelte` and `registry.ts`: the texts of §10 (VPN rows and the one Games row).
- `src/vpn/start.ts` (handed over by v1): `registerFeature('vpn')` at the end of `startVpn()`, in every build (D18,
  D20), once rows V1–V22 pass in both browsers.

### 8.2 Tests

Unit: the new `chooseRoute` table (pinned, first up, first offered; a chosen location never replaced; kill switch on
and off; an exit warning changes nothing), the property test, the browser's single status source (no second poll),
the auto-connect decision (fresh vs reload; config loaded before and after `detectStart`; no tab live and no deep
link opened before the decision), the toast, the ticket route on every mint and on a route change (no default-route
mint while connected with the kill switch on), the previous-route tab count, `verifyExit` gating (off by default; no
check service → no check), the error copy and overlay link, the forbidden-words check over §10's texts. Cargo: the
gateway tests above. E2E: `vpn-ui` rows V12–V22 (§9.4) and the rerun of the step-2 suites that mint tickets
(`transport`, `backend-proxy`: lane t updates their profile-path mints, §2.1).

## 9. Lane t: e2e fixtures and suites

Every suite runs against the real gnome-server (release build) and HolyWisp in Chromium and Firefox, discovered by
`run.mjs` from `suites/*.mjs` (no runner change). The games suites start their own server layout
(`export const standalone = true`, the standalone port block, `backend-lib.mjs`'s exported helpers used read-only);
`vpn-ui` uses the runner's shared stack (its `e2e-vpn` and `e2e-dead` profiles, the target site reachable only
through `e2e-vpn`, the leak sentinel) and restarts that server with extra variables, restoring the defaults at its
end (`ctx.stack.restartServer({})`). Rows are `[unproven]` until they pass in both browsers; a row a browser cannot
pass is recorded `expectFail` with the reason and the plan's claim is narrowed in the report.

### 9.1 Fixtures (lane t, day one)

- **Replay data** (D19): `suites/games-lib.mjs` `prepareReplay(dir)` copies unmodified captures from
  `crates/catalog/tests/fixtures/` into `<work>/replay/` and writes `index.json` (§4.6 format): GamePix
  `gamepix-chess-p{1,2,3}.json` (29 games over three pages), GameDistribution `gamedistribution-p1.json` +
  `gamedistribution-end.json`, Playgama `playgama-p1.json` (status 201; includes the `deadlydescent.net` developer
  host), GameMonetize `gamemonetize-p1.json`, Famobi `famobi.json`, itch.io `itch-free-web.xml`, js13kGames
  `js13k-2026.xml` (with `GNOME_JS13K_FIRST_YEAR=2026`). The publisher-ID sources get placeholder IDs that only
  the routed fake embeds ever see (`GNOME_GD_PUBLISHER_ID=e2e-publisher`, `GNOME_PLAYGAMA_CLID=e2e-clid`,
  `GNOME_GAMEMONETIZE_ENABLED=true`, `GNOME_FAMOBI_AFFILIATE_ID=A-E2E`). The index carries §4.6's `now`, `config`
  overrides and matchers written against the adapters' real URLs; Playgama (and any other single full captured page)
  ends `failed` with its games listed. About 69 playable and 353 link-out games (the suites read the real counts
  from the import reports): enough for several 48-item pages, every source's attribution, dedup and the pending
  host. Nothing is invented.
- **OSS test game**: `fixtures/games/oss/e2e-blocks/` — GNOME's own original game written for the tests (a canvas
  "catch the blocks" game in `index.html` + `game.js` + `style.css`, an `icon.svg` thumbnail, a `LICENSE` naming
  AGPL-3.0-only and pointing at `frontend/scripts/licenses/AGPL-3.0.txt`; it keeps its best score in `localStorage`)
  and `fixtures/games/oss-e2e.toml`, a manifest with that one `local = true` entry (§4.8 item 7; `local` entries need
  no `reviewed`, and the game uses `localStorage`, so it is not `isolated`). The suite copies
  the package into `<work>/oss-games/` and sets `GNOME_OSS_MANIFEST`, `GNOME_OSS_GAMES_DIR`, `GNOME_OSS_FETCH=manual`.
- **Fake embed host**: `fixtures/games/embed.html`, answered by Playwright routing (`context.route`) for every embed
  host the replayed records use (`https://play.gamepix.com/**`, `https://html5.gamedistribution.com/**`,
  `https://playgama.com/**`, `https://html5.gamemonetize.co/**`, `https://play.famobi.com/**`,
  `https://deadlydescent.net/**`) and for the popup host `https://ads.e2e.invalid/**`. The page records
  `document.referrer`, its own URL and query, and offers the probes the player rows call (top navigation, popup,
  `opener.location` and `opener.top.location` from the popup, self-navigation to `<app>/browse?url=…`, to
  `<proxy>/uv/service/…` and to another network's embed host, `alert`, geolocation, camera, fullscreen). Network images (thumbnail proxy off) are routed to a PNG the suite
  generates in memory. Unrouted requests to other hosts reach the leak sentinel and fail the row that caused them.
- **VPN check service**: `servers/vpn-check.mjs` on `E2E_VPN_CHECK_PORT` (default `E2E_PORT_BASE + 60`): `GET /json`
  answers `{"ip": "192.0.2.10", "country": "Sweden", "city": "E2E", "mullvad_exit_ip": false}` (a documentation
  address; the field name is the one am.i.mullvad.net uses, to test the generic `provider_exit` wording); requests
  whose `User-Agent` is the server's check (`exit-check/1`) are counted apart from the browser transports'; `POST /control` sets a
  different `ip` for browser requests (mismatch rows) or makes the service stop answering; `GET /stats` returns the
  counts. Reached by HolyWisp only through the `e2e-vpn` instance's TEST-ONLY allow-loopback overlay (the direct
  instance refuses loopback, as in production).
- **A second live location**: `vpn-ui` starts one more HolyWisp with the same TEST-ONLY overlay on
  `E2E_HOLYWISP_VPN2_PORT` (`E2E_PORT_BASE + 61`, through `lib/stack.mjs`'s exported `startHolyWisp`) and restarts the
  server with its own profiles file (`e2e-dead` first, then `e2e-vpn`, then `e2e-vpn2`), so the Automatic rule has a
  down location to skip and a second live one to move to.

- **No-internet base environments** (day one, §2.2): `GNOME_CATALOG_REFRESH_HOURS=0` and `GNOME_OSS_FETCH=manual` in
  `suites/backend-lib.mjs`, `suites/library-lib.mjs`, `tests/e2e/stack/*.mjs`, `tests/e2e/settings/*.mjs` and
  `tests/e2e/about/about-qa.mjs`; `stack-qa.mjs`'s app framing check becomes `frame-ancestors 'none'` with g1's day one.
- **Online switch**: rows that need the internet run only with `GAMES_E2E_ONLINE=1` (the runner gives standalone
  suites no `--online` flag); without it they are `skip`, never pass or fail by the host's connectivity. The UI's
  thumbnail-failure states route `/api/thumb/**` to 503/404 in Playwright instead of relying on the network.
  backend-proxy's private `attempt` probe set is copied into `games-lib.mjs` (not imported).

### 9.2 `backend-games` (standalone; HTTP rows once, browser rows in both browsers)

| ID | Row | Needs |
| --- | --- | --- |
| B1 | `catalog import --replay` for each replayed source prints one JSON report with the status `backend/tests/cli.rs` recorded for it (exit 0 for `complete`, 1 for Playgama's `failed`) and makes no outside request; `--replay` with `..` in the index exits 2 | g1 M3 |
| B2 | `/api/config`: `features.games` true, `features.thumb_proxy` as configured; with `GNOME_CATALOG_SOURCES=none` false and `/api/games` 404 | g1 M1 |
| B3 | every route's keys equal API.md's shapes (`GameSummary`, `GameDetail` with `embed_allowed` and `oss`, sections, categories, tags, by-ids, status) | g1 M1 |
| B4 | paging: following `next_cursor` with `limit=12` returns every listed game once, `total` constant; a cursor reused with another `exclude` → 400 `cursor does not belong to this query` | g1 M1 + crate |
| B5 | search `chess` (title matches first), `che` (prefix), `ch` (whole word only); category, tag, `exclude`, `mobile` filters and their totals | g1 M1 + crate |
| B6 | the 400 messages of §4.2 and the 404s (unknown slug; a game set `hidden` and one set `broken` by the admin) | g1 M1, M3 |
| B7 | `POST /api/games/:slug/play` → 204; without `X-GNOME-Request` → 403; unknown → 404 | g1 M1 |
| B8 | `GET /api/games/status` while an import runs (`importing: true`) and after (`last_import.status`) | g1 M3 |
| B9 | `index.html`: `frame-src 'self' <proxy origin>` only, `frame-ancestors 'none'`, `X-Frame-Options: DENY`; `/play-frame/<slug>` of one game per replayed source: `wrapper_csp` naming only that game's origin; the `deadlydescent.net` game: wrapper 404, `embed_allowed: false`, `pending` in `/admin/diagnostics` with its count; after a restart with `GNOME_GAMES_EMBED_HOSTS=deadlydescent.net`: wrapper 200 and `true` | g1 day one, M1 |
| B10 | app HTML (shell and wrapper) carries COOP `same-origin` and `Permissions-Policy` exactly; JSON and proxy-role answers do not; `img-src` has the proxy origin | g1 day one |
| B11 | `POST /admin/catalog/import {"sources":["oss"]}` → 202, then the test game is listed; 409 while a run is going; 422 for `crates` | g1 M3, M4 |
| B12 | `/oss/e2e-blocks/index.html` (proxy origin) with `Sec-Fetch-Dest: iframe`: `text/html`, `oss_document_csp` byte for byte, nosniff, ETag/304; with `Sec-Fetch-Dest: document` or none → 404; `game.js` the script policy; `icon.svg` the inert policy; `LICENSE` `text/plain`; another `.html` file copied into the build → 404; traversal (`%2e%2e/`, `..%2f`, `.gnome-oss.json`, a hidden file, a directory) → 404; the same paths on the app origin → plain 404 | g1 M4 |
| B13 | realm (both browsers): a top-level navigation to `/oss/e2e-blocks/index.html` shows the 404, not the game; a proxy-origin parent's `<iframe src="/oss/e2e-blocks/index.html">` does not load (`frame-ancestors` names the app origins only); inside the player's wrapper, the probes (`games-lib.mjs`'s copy of backend-proxy's set: fetch, WebSocket, image, beacon, module import, iframe, XHR, form to the sentinel) evaluated in the OSS frame → no sentinel hit | g1 M4 |
| B14 | the job path: with `GNOME_CATALOG_REFRESH_HOURS=0`, `GNOME_OSS_FETCH=manual`, only `oss` enabled and the test game's build in place, `GET /admin/catalog/imports` shows an `oss` run started by `catalog.import` within 45 s of start (the first-tick rule of §4.6) | g1 M3 |
| B15 | `GNOME_ADS_TXT` set → `/ads.txt` is the file as `text/plain`; unset → 404 | g1 M5 |
| B16 | `/api/thumb/<oss game>` → 404; with `GAMES_E2E_ONLINE=1` only: one GamePix thumbnail → 200 with the exact headers, the second request a cache hit (`/admin/diagnostics` `games.thumbs.hits`); upstream failures are covered by `games_thumbs.rs`, not here | g1 M2 |
| B17 | `gnome-server config check` prints the catalog and check variables; the D16 warning for profiles + `open` mode and for profiles + accounts with open registration, none with closed registration, the code-mode warning, silence with `GNOME_VPN_EGRESS_SHARED_OK=true`; the no-check-service warning; the single-origin `oss` warning | g1 day one |
| B18 | a server started like the runner's shared one (the base env of §9.1) imports nothing: `/admin/catalog/imports` stays empty for 60 s and `/admin/diagnostics` `games.oss.last_fetch` stays `null` | g1 M3, t |

### 9.3 `games-ui` and `games-player` (standalone; both browsers)

Server: two origins, the replayed catalog, the OSS test game, `GNOME_THUMB_PROXY=false` unless a row says
otherwise; the e2e frontend build the runner passes (`--static`).

| ID | Row | Needs |
| --- | --- | --- |
| U1 | `/games`: heading, the four server shelves not empty, the "All games" grid with playable tiles only, the status line "<playable> games to play here from <networks> · <n> more on other sites" with the API's counts | g2 |
| U2 | search: typing `chess` shows "<n> results" equal to the API's total; clearing restores the shelves; the URL keeps `q` and Back leaves the page | g2 |
| U3 | the Category select lists "All categories" and all 14 core categories (Action … Sandbox) with the API's counts; category and sort selects change the grid (first tiles equal the API's first items for that query) | g2 |
| U4 | virtualization: scrolling "All games" to the end loads every page once (requests carry `cursor`, `limit=48`), never more than 100 `gridcell`s in the DOM, the last game reachable, no duplicate titles; arrow keys move, Enter opens the detail page | g2 |
| U5 | settings: `view` list → list rows; `cardSize` large → wider tiles; `defaultSort` trending → the grid in trending order; `hiddenCategories` [puzzle] → no puzzle game in shelves, grid, related or totals, and the "1 hidden category" link; `showMobileOnly` → only `mobile` games and the "Touch screens only" link; an imported settings file with an unknown hidden slug and 25 hidden slugs → the page loads, the known ones are hidden | g2 + crate |
| U6 | favorites: add on the detail page → the Favorites shelf; kept after a reload; a second app tab sees it within 2 s; remove; a favorite the server no longer lists (admin `hidden`) shows "No longer available" with Remove | g2 |
| U7 | recently played: playing a game adds it; `trackRecent` off adds nothing; `recentLimit` 1 keeps one; Settings → Privacy → Clear browsing data → "Recently played games" empties it | g2 |
| U8 | empty catalog (no replay, the OSS build missing): "No games yet" with the reason; `GNOME_CATALOG_SOURCES=none`: "Games are not available on this server" and no Games rows in Settings; with a catalog the Games rows are visible (D20) | g2 |
| U9 | the server stopped while the page is open: "Games could not be loaded"; after a restart **Try again** works | g2 |
| U10 | mobile viewport 390×844: stacked toolbar, two columns, scrollable shelves, no horizontal overflow | g2 |
| U11 | link-out tiles in search results and a category grid: the "(opens on itch.io)" name; clicking one opens the itch.io URL in a new page (`target="_blank"`, `rel="noopener noreferrer"`); no iframe is ever created for them; the shelves and "All games" show none | g2 |
| U12 | thumbnails: proxy off → the routed network images render; proxy on with `/api/thumb/**` routed to 503 and 404 → monogram placeholders, no broken-image icons | g2 |
| U13 | budget: the `/games` route's own chunks ≤ 30 KiB gzip JS and ≤ 8 KiB gzip CSS (from the served build's files); a cold first view makes ≤ 6 API requests with ≤ 80 KiB of JSON | g2 |
| U14 | the detail page of one record per replayed source: "About this game" and "How to play" shown as text (a capture whose text contains `<` renders the character, no markup); the developer with its `https:` link (`rel="noopener noreferrer"`) when known; category chips and tag chips open `/games?category=` / `/games?tag=` grids whose counts equal the API's totals; the flag words; "More like this" honouring `hiddenCategories` | g2 |
| P1 | detail → **Play** (after the notice's **Play**) → the outer frame's `src` `/play-frame/<slug>`, `allow` and `allowfullscreen`, and the wrapper's inner frame's `src`, `sandbox`, `allow`, `referrerpolicy` exactly (one game of each replayed source); GameDistribution's URL carries `gd_sdk_referrer_url=<app origin>/play/<slug>` | g2 + g1 |
| P2 | inside the routed embed: `document.referrer` is the app origin with `/`; the request reached the embed host directly (seen by the route) and no Wisp connection was opened for it (`/admin/diagnostics` `ws.total` unchanged) | g2 |
| P3 | from the embed: `top.location = …` does not navigate GNOME (URL unchanged after 1 s); `alert()` shows no dialog | g2 |
| P4a | from the embed: `window.open('https://ads.e2e.invalid/x')` opens a page; from it `opener.location = …` and `opener.top.location = …` leave GNOME's tab and the game frame unchanged (URL and frame `src` after 1 s) — **must pass in both browsers**; if it fails in one, `allow-popups-to-escape-sandbox` is removed there rather than documented | g2 + g1 |
| P4b | the same popup's `window.opener` is `null` (COOP) — may be `expectFail` in a browser that keeps the opener, with About's limitation (§12.1) | g2 + g1 |
| P5 | from the embed: geolocation → `PERMISSION_DENIED`; `getUserMedia` → `NotAllowedError` | g2 + g1 |
| P6 | fullscreen: GNOME's button puts the stage in fullscreen and back; the game's own `requestFullscreen()` (a click inside the frame) works; `fullscreenOnPlay` + **Play** → fullscreen at once; a reload of `/play/<slug>` → not fullscreen, the Fullscreen button focused with the hint | g2 |
| P7 | the first frame load sends one `POST …/play` and records the game in Recently played; a second load in the same hour sends one more POST, which the server does not count | g2 |
| P8 | a link-out game: the detail page offers "Open on itch.io"; `/play/<slug>` shows no frame, only the link-out card | g2 |
| P9 | the `deadlydescent.net` game: "Open on deadlydescent.net" and no frame; after a restart with the host approved, the same app page (loaded before the restart) frames it on its next visit to `/play/<slug>`, without a reload | g2 + g1 |
| P10 | the OSS game (no notice): the wrapper's inner frame `src` `<proxy origin>/oss/e2e-blocks/index.html` with the OSS attributes of §4.5 (no `allow-popups`, no `fullscreen`); the canvas runs and keeps its score after a reload; the License region shows AGPL-3.0-only and "License text" opens the LICENSE as text; the note says "Served by this GNOME server."; from inside the frame `parent.document` throws and the app's storage is out of reach | g2 + g1 |
| P11 | leaving the player removes the frame (no frame of the embed host left after going to `/games`); the mobile viewport fills the width | g2 |
| P12 | Chromium: no `Permissions-Policy` "Unrecognized feature" console message on the app's first load | g1 |
| P13 | frame escape (both browsers): from the fake embed, `location = '<app origin>/browse?url=https://ads.e2e.invalid/'`, `location = '<proxy origin>/uv/service/<encoded URL>'` and `location = 'https://html5.gamemonetize.co/…'` (another network) each fail to load (the wrapper's `frame-src`), GNOME opens no tab and the sentinel sees nothing; the shell cannot be framed (`frame-ancestors 'none'`: an `<iframe src="/">` added to an app page stays empty) | g2 + g1 |
| P14 | the notice (D24): a `/play/<slug>` link of a network not yet allowed shows "Before you play" and **no request reaches the embed host** (the Playwright route counts zero) until **Play**; after **Play** the frame loads, a second game of the same network loads without the notice, a game of another network shows it; **Forget** on the Games page and the "Game network choices" clearer bring it back | g2 |

### 9.4 `vpn-ui` (the runner's shared stack; both browsers; page-loading rows under Scramjet and Ultraviolet)

The suite restarts the server with `GNOME_VPN_CHECK_URL=http://127.0.0.1:<E2E_VPN_CHECK_PORT>/json`,
`GNOME_VPN_CHECK_INTERVAL_MIN=1` and, from V6 on, its own profiles file (§9.1).

| ID | Row | Needs |
| --- | --- | --- |
| V1 | before the restart (no check service, the default): the Exit check card says "This server runs no exit checks." and `/api/vpn/locations` has `verify_url: null`; after it: `/vpn`: heading, "Off", the locations listbox ("E2E · live" Online, "E2E · down" Offline within 70 s), the privacy region verbatim (§7.3), the non-affiliation footer; no forbidden word of §7.3 in the page text | v1 |
| V2 | **Connect** to "E2E · live": "Ready: E2E · live" before any engine host runs; the target site (reachable only through `e2e-vpn`) loads in a tab; then "Connected to E2E · live" and the chip "VPN · E2E · live" with the `ok` tone | v1 |
| V3 | **Disconnect**: "Off", no chip; the target site no longer loads (the direct instance refuses it) | v1 |
| V4 | "E2E · down" with the kill switch on: "Blocked: E2E · down is down", the chip "VPN · Blocked", the target fails, the sentinel sees no direct request; **Disconnect** from the page restores loading | v1 |
| V5 | "E2E · down" with the kill switch off: "Not in use: …", the toast "VPN location unavailable", the engine host's route `default` (diagnostics) | v1 |
| V6 | choosing a location while connected switches the route at once ("Now using …"); while off it only selects | v1 |
| V7 | device-local switches: importing a settings file with `vpn.mode: gateway` leaves "Off", and one with `vpn.killSwitch: false` leaves the kill switch on; with sync on two browser contexts of one account, one connecting or turning its kill switch off changes neither in the other, while a `preferredLocation` change does sync; the exported file contains both keys | v1 |
| V8 | exit card: "127.0.0.1:<port> reports 192.0.2.10 in E2E, Sweden" and "… says this address is one of its VPN exits: no" for "E2E · live" (the server's check, through `e2e-vpn`) | v1 + v2 |
| V9 | the server's check of "E2E · down": "The location does not answer.", with no request at the check fixture | v1 + v2 |
| V10 | **Check again**: one new server check (fixture count + 1), the button disabled for 60 s, a second click within 60 s answered without a new check | v1 + v2 |
| V11 | WebRTC: VPN + kill switch on with `privacy.webrtc` allow → the engine host's policy is `block` (diagnostics) and no warning; kill switch off → the WebRTC warning on the page | v1 |
| V12 | the check fixture stops answering while connected to "E2E · live": the next check shows the warning "The exit check through E2E · live fails: connections through this location to the check service fail…" and the chip turns `degraded`; the state stays "Connected to E2E · live", the route stays the profile (diagnostics) and the target site still loads — with the kill switch on and off (D14) | v1 + v2 + v3 |
| V13 | Automatic (profiles `e2e-dead`, `e2e-vpn`, `e2e-vpn2`): picks "E2E · live" (the first one up), not the down one; the target loads | v3 |
| V14 | Automatic pinned: stopping `e2e-vpn`'s HolyWisp moves the route to `e2e-vpn2` within 70 s with the toast "VPN location changed: …"; a chosen (non-automatic) location is never replaced: kill switch on → blocked | v3 |
| V15 | auto-connect: `autoConnect` on, `vpn.mode` off, `browser.startup` `restore`; open the target site in a tab; close every GNOME page of the context; open a new page in the same context (a fresh start) → connected before the restored tab's first load (it loads on the first try through `e2e-vpn`, the sentinel sees no direct request, no error overlay). Variants: `/api/config` delayed by 3 s (Playwright route), the `startVpn` chunk delayed by 3 s, and a `/browse?url=<target>` deep link as the fresh page — each with no load on the default route. A reload (same page, not a fresh start) does not connect | v3 |
| V16 | this browser's check (`verifyExit` turned on; it is off by default): after connecting, "Through this browser's route, … reports 192.0.2.10 …"; the fixture's browser-request count + 1 | v3 |
| V17 | a different `ip` for browser requests (`POST /control`) → the mismatch warning | v3 |
| V18 | `verifyExit` off (the default) → no browser request at the fixture after connecting and after **Check again** | v3 |
| V19 | a blocked load's error overlay has **Open VPN page**, which opens `/vpn` | v3 |
| V20 | the stranded browser (D18): the server restarted without `GNOME_VPN_PROFILES` while the switch is on with the kill switch: the chip "VPN · Blocked", the page "Blocked: no VPN location", **Disconnect** works; Settings → VPN rows are visible (`registerFeature('vpn')`) with the §10 texts and the mode row is usable | v3 |
| V21 | route-bound tickets (D23): connected to "E2E · live" with the kill switch on, a page built to attack GNOME (the `host-attack` borrow-natives fixture) reads the engine host's ticket and opens `/wisp/` (direct) with it → `401 wisp_ticket_wrong_route`, and the sentinel sees no direct request; a default-route ticket minted before connecting is refused (`wisp_ticket_superseded`) and its open connection is closed within 20 s of the connect; after a server restart every engine host re-mints and pages load again | v3 |
| V22 | after a location change while connected, a tab opened before it shows on the VPN page as "1 tab may still use the previous route until you reload it"; reloading it clears the line | v3 |

### 9.5 Other scripts lane t updates (after D20's registrations)

`tests/e2e/settings/settings-qa.mjs` and `settings-features-qa.mjs`: the Games rows (with a catalog) and the VPN rows
(always) are now present; their controls act (a changed `games.cardSize` changes the tile width; the mode row
connects). `tests/e2e/about/about-qa.mjs`: the new limitations of §14 are listed. Each script keeps its header's
variable list.

With v3's D23 step (after step 3's integration): `suites/transport.mjs` and `suites/backend-proxy.mjs` mint their
tickets for a profile path with `{"route": {"profile": "<id>"}}` (`backend-proxy`'s dead-profile probe; `transport`'s
unknown-profile probe keeps its 404, which the gateway answers before it looks at the ticket); every other mint of the
step-2 suites stays body-less (default route).

## 10. Settings keys

No key is added, renamed or given a new value: every key below exists in `schema.ts` (ARCHITECTURE §5.3) with its
Settings row (`pages/settings/registry.ts`, gated by `games` / `vpn`), so there is no settings version bump and no
migration. What changes is who consumes them, one sync rule (D12: two keys become device-local), one default
(`vpn.verifyExit` → `false`, D15) and some row texts (lane v3, after step 3).

| Key | Consumer | Behaviour (and the row text where it changes) | Sync |
| --- | --- | --- | --- |
| `games.view` | g2 | grid (`VirtualGrid`) or list (`VirtualList`) on the Games page | synced |
| `games.cardSize` | g2 | tile width 150 / 185 / 230px | synced |
| `games.defaultSort` | g2 | the "All games" grid's order and the sort select's default | synced |
| `games.fullscreenOnPlay` | g2 | fullscreen at once when Play's gesture is still active, else the focused button and hint (§5.3) | synced |
| `games.trackRecent` | g2 | recently played recorded on a frame's first load | synced (the list itself stays local, D9) |
| `games.recentLimit` | g2 | entries kept (0 = none) | synced |
| `games.showMobileOnly` | g1 (`mobile=1`), g2 | every listing, shelf and related row | synced |
| `games.hiddenCategories` | g1 (`exclude=`), g2 | left out everywhere, totals included (D11); slugs the server does not list are kept but not sent | synced (merged as a set, as today) |
| `vpn.mode` | v1, browser | **this browser's connection switch** (D12). Row text (v3): label "VPN", options "Off" / "On", description "Route pages opened in GNOME through a location this server's operator runs. Kept in this browser only."; keywords `vpn wireguard tunnel gateway location` (no provider name); the custom-Wisp description becomes "Custom Wisp servers are not used while the VPN is on." (the VPN route wins, `chooseRoute`) | **device-local**: ignored when it arrives through sync or an import |
| `vpn.preferredLocation` | browser (`chooseRoute`), v1 | the chosen location; `null` = Automatic (D17). Row text (v3): "The location pages are routed through."; the Automatic option keeps "The first location that is online" (now true) | synced |
| `vpn.autoConnect` | v3 (in the browser's start; v1's pure decision) | turns the switch on at every fresh start (D12). Row text (v3): "Turn the VPN on each time GNOME opens in a new browser tab, also after you disconnected." | synced |
| `vpn.killSwitch` | browser (`chooseRoute`, WebRTC forced to `block`) | unchanged behaviour. Row text (v3): label "Block if the location is down", description "Stop loading pages while the location is down, instead of using this server's own connection. Kept in this browser only." | **device-local** (D12) |
| `vpn.verifyExit` | v3 (`browser.verifyExit`) | this browser's exit check after a connect or route change and on demand, only with a check service; never the server's check. **Default `false`** (D15). Row text (v3): label "Check this browser's exit", description "Ask the check service, through this browser's route, which address sites see. Its answer is not proof, and the check service sees this server's VPN address each time." | synced |
| `privacy.webrtc` | engine host (unchanged), v1 | the VPN page's warning when `allow` and the kill switch is off | synced |

Account sync and import rules after Wave C: the synced settings document leaves out `account` (as today); a
downloaded or merged document and an imported file get this browser's `vpn.mode` and `vpn.killSwitch` back
(`settings/local-vpn.ts`, like `settings/local-picture.ts` for the home picture), so values another device uploaded
are ignored; exports keep every key. One Games text changes with v3's texts (registry.ts is x4's until step 3's
integration): the Games section's description gains "Playing a game tells the game network and its advertisers this
server's address."
Favorites and recently played are not settings and are not synced (D9). The integration step updates the comments in
ARCHITECTURE §5.3 (`vpn.mode`: "this browser's VPN switch; device-local", `vpn.killSwitch`: "device-local",
`vpn.verifyExit`: "this browser's exit check through the engine host (`vpn.verify`); default false") and §5.2's sync
paragraph; `schema.ts`'s comments follow in the same
step (no lane owns `schema.ts`).

## 11. Budgets and failure modes

### 11.1 Measured (this machine unless noted)

| What | Result | Source |
| --- | --- | --- |
| Full GamePix import (live, `sid=1`) | 14,865 → 14,929 games; 155–199 s wall (156 requests, ≥ 1 s apart; 3.7 s user CPU); peak RSS 10.3–10.7 MiB (importer process) | crate README "Live check results" (2026-11-10, review re-check 2026-11-11) |
| Catalog database | 39.2–40.2 MiB for 14.9k games (`games` 16.1, `game_raw` 13.2, FTS 5.3, indexes ≈ 4.5): ≈ 2.7 KiB per game | crate README |
| Query medians at 14.9k games (x86, in process) | listing pages 0.08 ms · `puzzle` popular 0.43 ms (page 40: 0.52) · search `chess` 0.30 ms · `the` popular 2.5 ms · `game` az 1.3 ms · detail + related 0.19–0.55 ms · sections 0.20 ms · categories 0.01 ms · `refresh_rankings` 41 ms · `prepare` re-map 0.33–0.50 s · `stats`/`embed_hosts` 7–9 ms | crate README, catalog review |
| `GameSummary` JSON size | ≈ 228 B median (max 272) over the 82 captured GamePix records → sections (≤ 96 summaries) ≈ 21 KiB, a 48-item page ≈ 11 KiB, uncompressed (the API sends no `Content-Encoding`) | computed for this plan from `crates/catalog/tests/fixtures/gamepix-*.json` |
| App first load (restyle build of 2026-11-18 21:24) | 33 files, 440.8 KiB raw / 150.6 KiB gzip; the Games placeholder chunk 1.1 KiB; History 14.7 / 5.5 KiB gzip; Home 23.5 / 8.6; Settings 125.7 / 38.4 | measured for this plan on the `ui:final` scratch build |
| `VirtualGrid`, 10,000 cards (Chromium) | mount 32 ms, ≤ 72 cells in the DOM, scroll frames p50 16.7 / p95 16.8 / max 17.1 ms, 0 over 33 ms | foundation review, 2026-11-11 (`dev/virtual-grid.html`) |
| Developer-hosted embeds | 1 of 10 captured Playgama records (`deadlydescent.net`) | `playgama-p1.json` |
| OSS manifest | 11 enabled entries, 3 of which load code from CDNs (`particle-clicker`, `javascript-chess`, `a-blast`) → 8 after D5 | `oss-games.toml` notes |

### 11.2 Budgets

The integration step measures them (x86 here; the full-scale run of §13.1 step 6 with a real 14.9k-game import).
Raspberry Pi 4 figures are **targets derived from the catalog review's factor of 4–5 over x86**, to be measured
(open item O3), not promises.

| Item | Budget |
| --- | --- |
| Catalog database | ≤ 3 KiB per stored game (README: about 200 MiB with every network enabled, ≈ 75k stored records, research §0.2) |
| A full GamePix import inside gnome-server | ≤ 4 min wall (bound by the 1 s request spacing); ≤ 20 MiB extra RSS while it runs (sampled by the full-scale run); ≤ 20 s CPU on a Pi 4 (3.7 s × 5, rounded up) |
| `/api/games*` server time, 15k games | p50 listing ≤ 1 ms (x86) / ≤ 5 ms (Pi 4); broad search ≤ 7 / ≤ 35 ms (3–7 ms measured × 5); three exclusions ≤ 5 / ≤ 25 ms; detail + related ≤ 1 / ≤ 5 ms; p95 ≤ 20 ms on a Pi 4 with 10 concurrent requests (4 readers) |
| `/play-frame/<slug>` | detail read + rendering ≤ 1 ms p50 (x86); the rendering alone is a benchmark the integration step records (never a test assertion: timing in debug builds on a shared machine is flaky) |
| Pending-host report | ≤ 10 ms (x86) / ≤ 50 ms (Pi 4), every 5 min and after imports |
| Thumbnail cache | `GNOME_THUMB_CACHE_MB` (256 MiB default ≈ 6,500–25,000 images at 10–40 KB, an estimate: B16 online measures real sizes); eviction to 90 %; ≤ 2 MiB of index memory at 25k entries; 4 upstream fetches at once; 120 misses per minute per IP. On a Pi with an SD card, eviction churn wears the card: the README suggests a smaller cap (e.g. 64 MiB) or `0` there |
| OSS builds | `GNOME_OSS_MAX_MB` (512 MiB) in total, ≤ 128 MiB and ≤ 20,000 files per game |
| Games page | route chunks ≤ 30 KiB gzip JS + ≤ 8 KiB gzip CSS; a cold first view ≤ 6 API requests and ≤ 80 KiB JSON; tiles ≤ 1 s after the route change (loopback); ≤ 100 grid cells in the DOM; scroll frames p95 ≤ 20 ms |
| VPN | page chunk ≤ 15 KiB gzip; one locations request per minute only while on or watched; server checks (only with a check service): ≤ 64 locations × 1 per 15 min (× 2 with an IPv6 name), 2 at once, ≤ 15 s and ≤ 16 KiB each; browser checks only with `verifyExit` on: one per connect or route change and per **Check again** |
| gnome-server RSS on a Pi 4 with a 15k catalog, a full thumbnail index and the VPN checker | ≤ 150 MiB (estimate) |

### 11.3 Failure modes

| Situation | What happens | Tested by |
| --- | --- | --- |
| A feed is down or answers 429/5xx | retries with back-off (`Retry-After` honoured); the run ends `failed`; no game is hidden; the catalog keeps serving; `status` and diagnostics show the run; the next attempt after min(1 h × 2^(n−1), the interval) | crate tests; `games_api`; B8 |
| A feed answers part of its catalog with 200 | the run is `incomplete` (±10 % rule); nothing hidden; a real shrink is honoured after three agreeing syncs | crate tests |
| A poisoned feed (markup, a foreign embed host, a huge body, an embed URL on this instance's own proxy host or with dot segments) | text hygiene, strict URLs, body caps; a foreign embed host stays `pending` and its game opens at its source; an own-host or dot-segment URL is refused (D4) | crate tests; `games_policy`; B9 |
| A hostile game navigates its own frame (to `/browse?url=…`, `/uv/service/…`, another network) | the wrapper's `frame-src` names only the game's origin: the navigation is blocked; popups cannot navigate GNOME's tab or the game frame | P13, P4a |
| An embed host is down | the frame shows the host's own error or stays blank (a cross-origin failure is not detectable); "Problems? Open on <host>" is always there | — (stated in About) |
| A host approved after an app page loaded | the next `/play/<slug>` visit frames it (the wrapper's policy is computed per request) | P9 |
| Fresh install, empty catalog | "No games yet" with the reason; the first import starts 30 s after start (GamePix ≈ 3 min); OSS games after their fetch | U8 |
| `GNOME_CATALOG_SOURCES=none` | no games module: routes 404, `features.games` false, Settings rows hidden, "Games are not available on this server" | B2, U8 |
| `prepare` failed (database error) | the routes answer 503, `features.games` false, the error in diagnostics; the rest of GNOME runs | `games_api` |
| A game leaves its feed | hidden after three complete syncs (404 on its page); favorites and Recently played show "No longer available"; an OSS entry removed from the manifest disappears at once | crate tests; U6 |
| A game matches the blocklist (`ip_risk`) | hidden by default (404); an admin may set it `active` | crate tests; B6 |
| A thumbnail's upstream fails | 503 + 60 s negative entry; the tile shows its placeholder | `games_thumbs`; U12 |
| The thumbnail cache cannot write (disk full) | the image is served uncached, a warning and a counter | `games_thumbs` |
| An OSS fetch fails (GitHub down, a changed archive) | the old build stays and is served; diagnostics `failed`; retried the next day | `games_oss` |
| A CLI import while the server runs | SQLite WAL; the crate's run lock answers `Busy` for the same source (409 / exit 1) | `games_admin`, `cli.rs` |
| VPN location down, kill switch on | the route stays on the profile: nothing loads; "Blocked: …"; **Disconnect** works | V4 |
| VPN location down, kill switch off | the default route and the toast; Automatic moves to another usable location | V5, V14 |
| A tunnel failing closed (instance up, streams fail) | with a check service: the server's check fails (`connect_failed`), the page and chip warn; the route does not change (D14), so pages fail to load with the error overlay's **Open VPN page** link, where the user can disconnect or pick another location; with the kill switch off GNOME does **not** silently move to this server's own connection | V12, V19 |
| The check service is down, refuses or answers garbage | `exit` `failed` with `connect_failed` / `http_status` / `bad_answer` / `timeout`: a warning only; pages keep loading through a healthy tunnel; an outsider cannot move users off the VPN | `vpn_exit`; V12 |
| No check service (the default) | the Exit card says "This server runs no exit checks.", `exit.state` `off`, `verify_url` null, no scheduled request to anyone | `vpn_exit`; V1 |
| Escaped code tries the direct route while connected (or blocked) | its ticket is bound to the profile route: `/wisp/` refuses it (`wisp_ticket_wrong_route`); an older default-route ticket is superseded and its connections closed within 20 s | V21 |
| No locations while the switch is on (the stranded browser) | the chip, the page and the Settings rows show it, and **Disconnect** is one click away | V20 |
| A forged browser-side check or transport status (a page that reached the engine host) | the check is shown only as "this browser's check" with "A page that broke out … can fake this answer"; a mismatch with the server's check warns; agreement is never shown as confirmation; a forged `ready` can show "Connected" early but cannot change the route (D13, D23) | V17, V21 |
| No engine host yet | "Ready: <label>"; this browser's check waits for the browser | V2 |
| A location removed while connected (`unknown-profile`) | `/api/config` is refreshed; `location-gone`: blocked or fallback by the kill switch | v3 unit tests; V20 |

## 12. Security, privacy and compliance

### 12.1 What runs on the app origin

The app origin holds the session cookies (`HttpOnly`, `SameSite=Strict`, `__Host-`), the user's IndexedDB data, the
settings and the sync state. **No third-party code runs in its realm**: the shell policy keeps `script-src 'self'`
plus hashes, and the game wrapper (`/play-frame/<slug>`) runs no script at all (`default-src 'none'`); publisher
embeds are cross-origin frames inside the wrapper that run in their own origin and cannot read the app's DOM or
storage (same-origin policy), cannot make credentialed state-changing API calls (SameSite=Strict, the CSRF header and
the `Origin` check), cannot frame GNOME (the shell: `frame-ancestors 'none'`, `X-Frame-Options: DENY`; the wrapper:
`frame-ancestors 'self'`), and cannot navigate their own frame anywhere but their own origin (the wrapper's
`frame-src`, D2). What a hostile embed, or an ad inside it, could still try, and what stops it:

| Attempt | Outcome |
| --- | --- |
| Navigate GNOME's tab (malvertising redirect) | refused: no `allow-top-navigation*` (P3) |
| Navigate its own frame to `<app>/browse?url=…` (a second GNOME opening an attack page), `<proxy>/uv/service/…` (a proxied page beside the engine host) or another network's host | refused: the wrapper's `frame-src` names only the game's origin; a frame's navigations are checked against its parent's policy (P13) |
| Navigate the wrapper (its parent) | refused: a sandboxed frame without `allow-top-navigation*` may navigate only itself and its descendants |
| A modal dialog over GNOME ("enter your password") | refused: no `allow-modals` (P3) |
| A download | refused: no `allow-downloads` |
| Popups (ad click-outs) | allowed and unsandboxed (the networks need them, D2); a popup cannot navigate GNOME's tab or the game frame (P4a, both browsers), and COOP `same-origin` gives it no `opener` where the browser applies it (P4b); a popup is an ordinary browser tab with its own address bar |
| Camera, microphone, geolocation, payment, USB, HID, serial, MIDI, display capture, WebAuthn, … | denied by the page's `Permissions-Policy` and never delegated (P5, P12) |
| Fullscreen, autoplay, gamepad, motion sensors | delegated to network frames by `allow` through both frames (the networks' games need them); fullscreen also through GNOME's own button; OSS frames get only `autoplay` (+ `gamepad` when declared, §4.5) |
| Draw a fake GNOME prompt inside the game area | possible, as with any embedded content: GNOME never asks for credentials inside the player, and the player's note names the network that serves the frame |

`allow-scripts` with `allow-same-origin` is safe only because the game frame is never same-origin with the app (an
embed that shares its parent's origin could remove its own sandbox): `FramePolicy::allows` (§4.5) refuses any embed
whose host is an app or proxy origin host, and OSS games are framed only at their exact rendered `/oss/` URL on the
proxy origin. Publisher embeds are not put on the proxy origin: proxying them breaks the networks' terms, and that
origin is the shared realm where hostile proxied pages could read and change them. Because the Browser view stays
mounted, an engine-host frame and a game frame can sit in one app page: an escaped proxied page cannot reach a
publisher frame (another origin; the engine iframe's sandbox gives it no navigation rights over its siblings), but it
can reach a non-`isolated` OSS frame (§12.4).

### 12.2 Which embeds may be framed

D4: data never adds a host by itself. Fixed hosts come from the enabled sources (code), developer hosts only after the
operator lists them in `GNOME_GAMES_EMBED_HOSTS`; every embed URL must parse with the crate's strict URL rules (a DNS
name: no IP literal, userinfo or odd characters; a plain path: no dot segments or encoded `.`, `/`, `\`) and may never
be on an app or proxy origin host; the checks compare parsed origins and paths, never string prefixes. Each game's
wrapper names only that game's origin, so a poisoned or compromised feed can at most make one of its games open at its
source in a new tab; `/admin/diagnostics` lists such hosts as `pending` (or `refused`) with their game counts, so the
operator sees the attempt. The shell's own `frame-src` is fixed (`'self' <proxy origin>`). Tests: `games_policy`, B9,
P9, P13.

### 12.3 Thumbnails

Server-side fetches use gnome-net's SafeClient (the strict IP policy after DNS, connecting to the vetted address,
every redirect re-checked, no proxies) with a host allow-list of the enabled sources' image hosts on top of the
crate's own check (`https:` on the source's own image host, no userinfo or explicit port); bodies ≤ 2 MiB after
decoding (gnome-net counts the decoded bytes while they stream); the declared type and the magic bytes must agree on
an allowed raster type (no HTML, no SVG, no "image/png" that is something else); answers carry `nosniff`,
`default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy: same-origin` and no cookies; nothing
about the visitor is sent upstream. Images are never decoded or resized on the server (no image stack: O9). The
cache is keyed by the source URL and holds no user data; its disk use is capped, entries live no longer than the
upstream's `max-age`, and files of games that leave the catalog are deleted. Whether each network's terms allow a local
cache is unverified (research §11 item 11; §12.6): `GNOME_THUMB_CACHE_MB=0` keeps the validated pass-through without
storing. With the proxy on, the networks' CDNs see only the server's address; with `GNOME_THUMB_PROXY=false` they see
every visitor's address (the startup warning, the README).

### 12.4 Open-source games on the proxy origin

They run in the proxy origin's shared realm (decisions log 2026-11-11) unless `isolated`, so they are treated as
**reviewed code**: a curated manifest, pinned commits fetched unmodified, a recorded review of each pinned commit
before an entry is enabled (D5, §4.8 item 5), no third-party loads, license and source shown.

- **What a non-isolated OSS game can reach**: what any proxied page can — the engine host when the Browser view's
  engine iframe is in the same app page (`parent.frames[i]` is same-origin), other proxied tabs, both engines' cookie
  jars, the Wisp ticket, the UV transport lock secret, the service-worker registrations, the proxy origin's storage. A
  `localStorage.clear()` would also clear what Ultraviolet keeps there and GNOME's `gnome-uv-transport-lock`, after
  which UV installs are refused until every GNOME tab is closed (ENGINE-PROTOCOL §6.6); the review rules such calls
  out for every enabled entry, and GNOME's "Clear site data" also clears OSS games' saved progress (About says so).
- **`isolated = true` games** (the review found no storage use) run in an opaque origin (the wrapper's sandbox
  without `allow-same-origin` plus the response's CSP `sandbox`): they reach none of the above.
- **What it cannot reach**: the app origin (`parent.document` throws, P10; no credentialed API calls) and, natively,
  anything beyond `'self'`: `oss_document_csp` is `PROXIED_DOCUMENT_CSP` plus `frame-ancestors`, so an OSS document
  is no permissive realm for a hostile proxied page (B13); such a page cannot frame one (`frame-ancestors` names only
  the app origins) or open one top-level (the entry is served only to `Sec-Fetch-Dest: iframe`, B12, B13), and the
  build's other HTML files are never served, so an unreviewed demo page or a DOM XSS in one cannot be reached by a
  link.
- **What a hostile proxied page can do to it**: escaped code reaching the engine host can reach a non-isolated OSS
  frame of the same app page, take it over and draw anything in the game area, and read or change OSS saves: the
  shared-realm limit, stated in About. OSS frames therefore get no fullscreen, orientation lock or motion sensors
  (§4.5): escaped code could use what they are given. The player's note says "Served by this GNOME server", never
  "safe".
- **Never on the app origin**: in single-origin mode the source is off (D5).
- **Licenses**: the License panel (SPDX license, copyright, repository, commit, the LICENSE file from the build); the
  build is the repository's files at the pinned commit, unmodified, so the linked commit is the corresponding source
  of the (A)GPL entries (`hextris`, `clumsy-bird`); `local` entries are the operator's own responsibility.
- A dedicated games origin (a third hostname) would isolate every OSS game from the proxy realm: open item O2.

### 12.5 Referrer, cookies and tracking in embeds

- **Referrer**: the game frame sends `strict-origin-when-cross-origin` from the wrapper (the app's origin,
  `https://<app host>/`); the GameDistribution embed URL also carries `gd_sdk_referrer_url=<app origin>/play/<slug>`
  (the networks' requirement). Nothing about the user's proxied browsing ever becomes a referrer (another origin; the
  app's own pages send none).
- **The instance's hostname is disclosed**: the referrer and `gd_sdk_referrer_url` tell the networks, and through
  ad requests the ad exchanges, this server's address and which game is played. With GamePix on by default, a
  private, unlisted instance becomes discoverable the first time anyone presses Play. The README's "Games catalog"
  and the Settings → Games description say "Playing a game tells the game network and its advertisers this server's
  address.", and the README names `GNOME_CATALOG_SOURCES=none` (or `oss` only) as the way to keep an instance
  unlisted.
- **Cookies**: the networks and their advertisers set cookies inside the frame under the browser's own third-party
  rules (Chromium allows them by default; Firefox partitions them by top-level site). GNOME's cookie settings
  (`browser.cookies.mode`, the cookie manager of step 3) apply to proxied pages only, not to games: the player's info
  popover and About say so.
- **Notice, consent and age**: before a network's first frame loads in a browser, the player shows D24's notice
  (what the network and its advertisers see) and loads nothing until **Play**; the networks show their own consent
  prompts inside the frame (GamePix: iubenda). GNOME is not a consent tool: the README tells operators with EU
  visitors that they need one, that the networks' age rules (several require 13+) apply to their instance, and that
  passing consent to GameDistribution's `gdpr-*` parameters is not built (O15).
- **No ad blocking**: step 3's blocker runs in the engine host and service worker on the proxy origin and never sees
  app-origin frames, by construction; Wave C adds no exception list because nothing needs one.
- **Play counts**: pseudonymous for at most two hours, then anonymous daily totals: for players without a session
  cookie the dedup key is an HMAC of the IP (/64 for IPv6); only the crate's 16-byte hourly hash is stored, never the
  IP, and the hourly `catalog.rankings` job purges expired hashes (D8). An operator holding the server secret could
  test an IPv4 address against the hashes of the current hour.

### 12.6 What the operator configures for each network (the README gets this table)

| Network | The network requires | GNOME settings | GNOME guarantees |
| --- | --- | --- | --- |
| GamePix | **unverified**: the public SID `1` is GamePix's own default; read the publisher terms at my.gamepix.com (behind a login, research §3.2) and use your own SID to be paid | `GNOME_GAMEPIX_SID` | direct frames, referrer origin, no blocking |
| GameDistribution | a publisher account with your domain, their tags and `ads.txt` lines, a Google Ad Manager account | `GNOME_GD_PUBLISHER_ID`, `GNOME_ADS_TXT`, a known app origin (`GNOME_PUBLIC_ORIGINS` or two origins) | `gd_sdk_referrer_url` = the player page; no monitoring crawler (the importer reads the feed only) |
| Playgama | an approved partner CLID | `GNOME_PLAYGAMA_CLID`; developer hosts in `GNOME_GAMES_EMBED_HOSTS` after review | the CLID in every embed URL |
| GameMonetize | your site added in the dashboard | `GNOME_GAMEMONETIZE_ENABLED=true` | ≥ 10 s between feed requests |
| Famobi | an approved affiliate ID (≥ 50k visits a month) | `GNOME_FAMOBI_AFFILIATE_ID` | the ID in every embed URL |
| itch.io, js13kGames | none (discovery and link-out) | `GNOME_CATALOG_SOURCES` | never framed |
| Open-source games | each license | `GNOME_OSS_*` | the license panel, the LICENSE file, the pinned source |

Disclose the proxy feature when applying to networks whose terms bar "hacking" content (GameDistribution §6.2(iii)(c),
Playgama §6.1), get each network's written confirmation for a site that includes a proxy (research §11 item 4), and
keep "unblocked" marketing off the games pages (research §0.3 rule 3); a separate games hostname would address it
fully (O2). **Thumbnails**: caching or re-serving the networks' images is unverified against each network's terms
(research §11 item 11): confirm it with each network, or set `GNOME_THUMB_CACHE_MB=0` (validated pass-through, no
storage) — the README says so next to this table.

### 12.7 The VPN

- **The UI may say**: the state texts of §7.3; "Pages you open in GNOME are routed through <label>"; "the sites you
  open in GNOME see that location's address instead of this server's" (true against hostile pages too only because
  of D23's route-bound tickets); "Your device's address is not sent with GNOME's page requests" together with its
  limit; the check service's answer as "<service> reports …"; a location's health ("Online", "Offline", "Not checked
  yet").
- **The UI must not say or show**: system-wide protection; "your device", "your IP" or "you" being hidden or
  protected; "secure", "anonymous", "encrypted" (beyond "not the content of HTTPS pages"), "no logs"; a check as
  proof, a badge, or two agreeing checks as confirmation; any provider's endorsement; provider logos, colours, fonts
  or app screenshots. A provider's name appears only in the operator's own `provider_note` text and in the check
  service's host name (§7.3's test over every string).
- **The checks' and states' trust model**:

  | | Who measures | Can a page built to attack GNOME forge it? | What it shows | What it does not show |
  | --- | --- | --- | --- | --- |
  | Server check (D14) | gnome-server through the location's own HolyWisp | no (measured on the server, delivered over the app origin) | the location's streams reach the internet and the service names an exit | that your pages use that location; a failure does not prove the tunnel is down (the service may be) |
  | This browser's check (`vpn.verify`) | the engine host through the route the app chose | yes (ENGINE-PROTOCOL §1.1 row B6, §1.2 rule 3): the page says so next to it | what the service reported for this browser's route | anything on its own: a mismatch with the server's check is a warning, agreement is not confirmation |
  | The route ("Connected to", "Blocked") | the app's route choice and the server's health status (app-origin facts), enforced by the gateway through route-bound tickets (D23) | no: escaped code cannot use another route | the route GNOME chose for its proxied traffic | that hostile pages cannot learn your device's address (WebRTC gaps, preconnects, custom Wisp: §6.15) |
  | "Connecting" vs "Connected" | the engine host's transport report | yes: it can show "Connected" early or "Connecting" late | progress only | anything about the route |

- **DNS**: proxied hostnames are resolved on the server (HolyWisp), never on the user's device; with the recipes of
  `services/vpn/README.md`, HolyWisp's resolver goes through the tunnel and the exit resolves again. GNOME cannot see
  the operator's DNS path from the browser, so the UI makes no DNS claim; the operator docs keep theirs. Escaped code
  can still make Chromium preconnect (TCP, TLS and SNI from the device) to a host: the privacy card's device sentence
  covers it.
- **WebRTC**: with the VPN and its kill switch on, the app always sends `block` (unchanged), and the privacy copy
  states the block's limit (a site built to get around it can still learn the address); with the kill switch off
  the user's setting applies and the page warns when it is `allow`.
- **UDP and IPv6**: the VPN instances refuse UDP (`proxy-udp = refuse`) and the browser transports use TCP only;
  `services/vpn/README.md` requires IPv6 to be tunnelled or blocked in each location's namespace, and with
  `GNOME_VPN_CHECK_URL_V6` the server checks the IPv6 exit separately; the UI claims neither.
- **Who sees what**: the VPN service and the location's exit see the names of the sites (not HTTPS content); this
  server's operator runs GNOME itself, which does the TLS in the user's browser, and is trusted with more (the card
  says so).
- **Exposure of the egress**: `GET /api/vpn/locations` shows exit addresses, cities and `provider_exit` only to
  clients the access policy admits (§6.2), so a code- or accounts-mode instance does not publish its operator's
  egress addresses or that it uses a given provider.
- **Terms** (D16): the startup and `config check` warning for VPN locations on an `open` instance or an accounts
  instance with open registration, the code-mode reminder, the explicit `GNOME_VPN_EGRESS_SHARED_OK` attestation; the
  VPN page says the operator runs the locations over connections they are authorized to share with the people who use
  the server; the README and `services/vpn/README.md` say to use only egress whose terms allow every person who can
  use the instance and present no provider as usable for a multi-user service. Restricting locations to some accounts
  of an otherwise shared instance needs user-bound tickets (O4).
- **The check service** has no default (D15): no instance contacts a third party on a schedule unless its operator
  set one; requests carry the neutral `User-Agent: exit-check/1`, the first checks are spread over the interval, and
  browser-side checks are off by default (`vpn.verifyExit: false`) and run only with a check service. Whether a VPN
  provider's public connection check (e.g. am.i.mullvad.net) may be used for automated checks is open (O6): the docs
  tell operators to use it only where its operator allows that, and document a self-hosted endpoint instead.

### 12.8 What crosses to the engine host

Nothing new. Games data never does (ENGINE-PROTOCOL §1.2 rule 5); the VPN state sends the engine host only what it
already may: the route (unchanged), the Wisp ticket (now route-bound, same `ticket` command) and, for this browser's
check, `verify_url` (rule 4). The server's exit results stay on the app origin.

## 13. Integration order and the final matrix

### 13.1 Order

1. **Preconditions**: Wave B step 2's integration part 2 has finished; the orchestrator has added the (log) rows of §1
   to the PROGRESS decisions log and sent §2.2's change requests to step 3's lanes x5 (runner base env) and x4 (the
   About crate list's generated block) and the two declared overlaps (`cli.rs`, `admin/mod.rs`) to x5; every lane
   re-reads the files it will edit (part 2 may have changed them) and the step-3 ownership map (`docs/WAVE-B3.md` §2).
2. **Day one, beside step 3's day one**: g1 lands §3.1 as one compiling change first (cargo check, clippy, the
   existing tests and `licenses.test.ts` green, the About crate list regenerated), then starts M1; g2 and v1 create
   their §3.2 files; t writes the fixtures and helpers and the no-internet base environments (§9.1) and updates
   `stack-qa.mjs`'s framing check with g1's change; v2 writes `wisp_client.rs` against §3.1 and compiles once g1's
   change is in.
3. **Lanes**: g1 M1 → M5 (§2.2); g2 against `fake-api.ts`, then the real routes (after g1 M1), the player (after
   g1's wrapper), the notice, favorites and recently played, and `registerFeature('games')` last, once U1–U14 and
   P1–P14 pass in both browsers; g1 records the OSS reviews (§4.8 item 5) before M4 ends; v1 the state, the page,
   device-local `vpn.mode` and `vpn.killSwitch` and the chip, then the exits (after v2); v2 the checker, the gated
   API, the job and the operator docs with the tested check-endpoint examples; t runs B-rows as g1 lands, U/P-rows as g2 lands, V1–V11 as v1 and v2 land. Each lane
   reports its rows, its `[unproven]` items and any change it needs in another lane's files (exact diff and reason).
4. **Wait** for step 3's integration step (its matrix green and its documents written).
5. **v3**: the wiring of §8, D23's route-bound tickets (gateway and app in one step, with t's updates of the
   `transport` and `backend-proxy` mints), the Settings texts of §10, `registerFeature('vpn')` last; t: V12–V22 and
   §9.5's scripts.
6. **Wave C integration step**: the matrix of §13.2; the budgets of §11.2; the online and `#[ignore]`d rows with
   network (`GAMES_E2E_ONLINE=1`: B16; `games_online.rs`; the `vpn_exit` online test against a §6.3 example check
   endpoint); **two online rows with real data**: (a) scale — a full GamePix import (≈ 3 min, ≈ 14.9k games) into a
   scratch data directory through the real `catalog.import` job path, sampling gnome-server's RSS and CPU, then U4
   (scroll to the end, cell count, duplicates, frame times), deep keyset paging and the `CatalogView` cap in both
   browsers, the numbers recorded in §11 and the README; (b) OSS — `gnome-server catalog fetch-oss` for every
   enabled entry, each `/play/<slug>` loaded in both browsers, rendering with no uncaught error; an entry that fails
   is disabled with the reason before release; the documents of §14; About; the README commands run as written (the
   2026-11-18 README rule).
7. **Review**: an independent security review ∥ a completeness review (report only), then a fix step.

### 13.2 The final matrix

| Suite / check | Chromium | Firefox | Notes |
| --- | --- | --- | --- |
| `backend-games` (standalone) | ✓ | ✓ | HTTP rows once, browser rows (B10, B13) in both |
| `games-ui` (standalone) | ✓ | ✓ | thumbnail proxy off and on |
| `games-player` (standalone) | ✓ | ✓ | every replayed source; P4a and P13 must pass; P4b may be `expectFail` per browser with About's text |
| `vpn-ui` | ✓ | ✓ | the page-loading rows (V2–V5, V12–V15, V21) under Scramjet and Ultraviolet |
| every step-2 suite (`host-*`, `shell-*`, `library-*`, `sw`, `transport`, `backend-*`, `build`) and every step-3 suite (`blocker-*`, `shell-blocker`) | ✓ | ✓ | Wave C changes the app's HTML headers (COOP, Permissions-Policy, `frame-src`, `frame-ancestors 'none'`) and the Wisp ticket format (D23): everything reruns |
| `tests/e2e/stack/*.mjs` | ✓ | ✓ | the shell framing check and the no-internet base env |
| `tests/e2e/settings/*.mjs`, `tests/e2e/about/about-qa.mjs`, `frontend/scripts/visual-qa.mjs`, `qa-components.mjs` | ✓ | ✓ | the Games and VPN rows and pages now present |
| `cd frontend && npm run check && npm test` | | | |
| `cargo test --workspace --locked`, clippy `-D warnings`, `cargo fmt --check` | | | plus the `#[ignore]`d tests by hand with network |

`expectFail` is allowed only for rows this plan marks conditional (P4b's COOP behaviour in one browser); rows that
need the internet are `skip` without `GAMES_E2E_ONLINE=1` (B16) and run in the integration step's online pass; every other row must pass in both browsers before
`registerFeature('games')` and `registerFeature('vpn')` stay in the build.

## 14. Documents the integration step updates

- **`docs/ARCHITECTURE.md`**: §3 (the `backend/src/games/`, `src/games/`, `src/vpn/` trees as built; the old
  "gateway.ts, verify.ts, store.ts" names go); §4.1 (the `catalog` CLI, `--replay`); §4.2 (the catalog rows are
  active, the crate's variables are server settings, the new rows `GNOME_GAMES_EMBED_HOSTS`, `GNOME_OSS_FETCH`,
  `GNOME_OSS_MAX_MB`, `GNOME_ADS_TXT`, `GNOME_VPN_CHECK_URL` (empty default), `GNOME_VPN_CHECK_URL_V6`,
  `GNOME_VPN_CHECK_INTERVAL_MIN`, `GNOME_VPN_EGRESS_SHARED_OK`; the "not part of this build" paragraph goes); §4.3
  (COOP, Permissions-Policy, the shell's fixed `frame-src 'self' <proxy origin>` and `frame-ancestors 'none'`, the
  game wrapper `/play-frame/<slug>` and its per-game policy, the thumbnail answers); §4.6 "Headers" (`/oss/**` with
  the entry-only and `Sec-Fetch-Dest` rules; the `csp::GAME_EMBED_HOSTS` sentence replaced) and the Wisp tickets
  (`w2`, route-bound, D23); §4.5 (the tables are used; no new migration); §5.2 (the games stores in use; `vpn.mode`
  and `vpn.killSwitch` device-local); §5.3 (the comments of §10, `verifyExit` default false); §6 rewritten from D2,
  D4–D9, D11, D24 and §5; §7 rewritten from D12–D18, D23 and §6–§8; §9 (OSS games keep their own licenses, shown per
  game).
- **`docs/API.md`**: "Games catalog (public)" (served; `exclude` with unknown slugs ignored, `mobile`,
  `include_link_out`; the 400 messages; `GET /api/games/status` with `playable`; `embed_allowed` and `oss`; the play
  counter's dedup; the thumbnail answers; `/play-frame/<slug>`; `/ads.txt`); the rate-limit table (`thumb`,
  `thumb_fetch`, `vpn_check`); "VPN gateway" (`exit` with `v6` and its access gate, `check_service`, a nullable
  `verify_url` that is null by default, `POST /api/vpn/locations/:id/check`); "Wisp tickets" (`POST /api/wisp/ticket`
  `route`, the `w2` format, the 401 codes `wisp_ticket_wrong_route`, `wisp_ticket_stale`, `wisp_ticket_superseded`);
  "Admin" (the catalog endpoints with their exact answers, diagnostics `catalog`, `games`, `vpn`); "Static & SPA"
  (the app HTML headers; the proxy origin's `/oss/**`).
- **`docs/ENGINE-PROTOCOL.md`**: §4 `route` (Automatic = the first location that is up, pinned; a chosen location is
  never replaced; exit checks never change it); §6.5 (route-bound tickets: the app mints for the chosen route, a
  route change mints anew, `needTicket {reason: 'rejected'}` after a restart); §6.13 (the server's check, the wording
  rule with `provider_exit`, "Connected" from the app's facts and the gateway's enforcement, the transport report as
  forgeable, the mismatch warning, agreement never confirmation, `verifyExit` off by default; `[proven]` through a
  profile route by V16, `[unproven]` through a real tunnel, O7); §1.1 (the B6 row's direct-route consequence closed by
  D23, V21); §1.2 rule 3 points at the server's check.
- **`docs/DESIGN.md`** §12: the Games and VPN rows as built (shelves, toolbar, card sizes, the player's stage, notice
  and note, the empty states; the VPN status card states and exit warning, the Exit check and Locations cards, the
  privacy card).
- **`README.md`**: the status box; the feature table (Games catalog, page and player; the VPN page; the VPN gateway
  row); "Games catalog" rewritten (sources, §12.6's operator table with the unverified GamePix terms and the
  thumbnail-caching note, approving embed hosts, the OSS fetch and its reviews, thumbnails and the SD-card note,
  `/ads.txt`, the CLI, privacy notes: the notice before a network's first frame, that playing tells the networks this
  server's address and how to stay unlisted with `GNOME_CATALOG_SOURCES=none`, that operators with EU visitors need
  their own consent tool and the networks' 13+ rules apply); "VPN gateway profiles" (the page, Connect and Disconnect,
  device-local switches, route-bound tickets in one sentence, the check service with no default and the self-hosted
  endpoint, D16 in plain words incl. accounts with open registration and the attestation); "Turning on every feature"
  (the variable count, and that a fresh server now imports GamePix 30 s after start and fetches the reviewed OSS
  builds from GitHub, with the two variables that stop it); "Everything on" (the catalog and check variables, run and
  checked again); "Using GNOME" (`/games`, `/games/<slug>`, `/play/<slug>`, `/vpn`); "Known limitations" (games load
  directly from their publishers, who see the visitor's address and may set cookies and show ads; games are not routed
  or blocked; GNOME's shortcuts do not reach a game that has the focus; non-isolated OSS games share the proxy origin's
  realm and storage; the VPN routes only GNOME's proxied traffic; a page built to attack GNOME can still reveal the
  device's address; checks are not proof; WebRTC; the scale numbers of the online run); "Development" (the new
  suites, `--replay`, `GAMES_E2E_ONLINE`).
- **`backend/README.md`**: the configuration table, the CLI, the modules (games, the wrapper, the VPN exit check, the
  ticket format).
- **About** (`frontend/src/pages/about/**`): the README's new limitations; the Licenses intro says OSS games show
  their licenses on their own pages; the generated Rust crate list is already current (g1 regenerates it with every
  `Cargo.lock` change, §2.2); the integration step only checks `licenses.test.ts` is green.
- **`docs/PROGRESS.md`**: Phase 5 ("Browser-compatible VPN" and "VPN page + settings" `[x]`), Phase 6 (catalog,
  Games page and Player `[x]`; the player item's "optional proxied mode" struck through with the 2026-11-10
  decision), the decisions-log rows, the "Wave C backend" deferred item closed, §15's items moved to "Deferred items"
  where they belong.
- **This file**: a status line on top with the final matrix's result.

## 15. What this plan leaves open

| # | Open point | Why it is open | Who settles it |
| --- | --- | --- | --- |
| O1 | Syncing favorites and recently played | no sync kind exists (an endpoint, a core migration, a sync adapter and a switch in the Account panel) | a later wave, with the per-account sync quota of "Deferred items" |
| O2 | A dedicated games origin (a third hostname) | it would isolate OSS games from the proxy realm and give the networks a games-only domain, but needs a third hostname, a certificate and a third server role | product decision; Wave D (deployment) |
| O3 | Raspberry Pi 4 measurements | no Pi 4 here; §11.2's Pi figures are targets derived from the review's factor | the integration step if one is available, else Wave D |
| O4 | VPN locations for some accounts only on a shared instance | D23's `w2` tickets carry the route but no user claim; restricting a profile to some accounts needs a per-profile access rule checked at mint time | a later wave |
| O5 | Ad-related features (Topics, Protected Audience, Attribution Reporting) in the app's `Permissions-Policy` | denying them changes the networks' ad targeting (their terms), Chromium is retiring them, unknown names log console errors | product decision; D3 leaves them alone |
| O6 | Automated use of a VPN provider's public connection check (e.g. `am.i.mullvad.net`) | research §3.7: no explicit permission or prohibition; **no longer a default** (D15), so GNOME itself never calls it | an operator who wants it asks the provider first; the docs say so and offer the self-hosted endpoint |
| O7 | A real VPN tunnel end to end | needs an operator's account | an operator run following `services/vpn/README.md` "Verify"; `[unproven]` until then |
| O8 | GitHub archive stability | the commit in the URL is the anchor; GitHub does not promise byte-stable archives, so no archive checksum is pinned (the per-file index is written after the first fetch) | revisit if a fetch's files change for a pinned commit |
| O9 | Resizing or converting thumbnails | no image stack in the server (size and attack surface) | later, if bandwidth matters |
| O10 | The three CDN-dependent OSS games | vendoring their libraries means modifying the builds (with the libraries' licenses); the other entries' reviews are part of g1 (D5, §4.8 item 5) | a later manifest review |
| O11 | Approving developer hosts from the admin page instead of an environment variable | needs an admin write API and persistence | later; the diagnostics' `pending` list makes the variable workable |
| O12 | itch.io widgets and Y8 embeds | per-game manual embeds, no feed | not in Wave C (itch.io stays link-out) |
| O13 | Firefox and `Permissions-Policy` | Firefox ignores most of the header; the frames' `allow` attribute is what limits games there | stated in About; no action |
| O14 | Telling a dead tunnel from a refused check service | since D14 makes exit checks information only, the ambiguity affects only the warning's wording ("the location's tunnel or the check service may be down"); a probe of the service through the default route would tell them apart at the cost of more requests to it | revisit after operator feedback |
| O15 | Passing consent to the networks (GameDistribution's `gdpr-tracking`, `gdpr-targeting`, `gdpr-third-party`) | GNOME is not a consent tool, and research documents the parameters only on `embed.gamedistribution.com`, not on the `html5.gamedistribution.com` URLs the importer renders; D24's notice is a notice, not consent | a later wave with a real consent tool; operators with EU visitors bring their own (README) |
| O16 | Old-route connections after a location change | D23 closes default-route connections once a profile ticket is minted; connections on a previous *profile* route (a location change) or a profile route after Disconnect keep running until their page reloads (the VPN page counts those tabs) | revisit if a per-route epoch is worth the cost for pages of one browser with different automatic locations |
