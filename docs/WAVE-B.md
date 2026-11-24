# Wave B module plan (proxy + browser)

> Status: plan for Wave B step 2, written in Wave B step 1 (2026-11-11) together with the final engine protocol and
> revised by the contract fix (2026-11-12) after the security and completeness reviews (ENGINE-PROTOCOL §8.2).
> Contract: `docs/ENGINE-PROTOCOL.md` and the code in `frontend/src/shared/`. Architecture: `docs/ARCHITECTURE.md`
> §3, §4.6, §5. Evidence: `docs/research/spike-engine-host.md` (§4 has the verified wiring code to port, §11 the
> adversarial isolation review, §12 the checks against the real gnome-server). Decisions: `docs/PROGRESS.md`
> decisions log (2026-11-11 rows) and its "Wave B inputs" (owners in §10 below).
>
> **Step 2 status (2026-11-18):** the five lanes are built and independently reviewed (2026-11-12); the integration
> (§8 item 5) runs in two parts around the UI restyle. Part 1 applies the lanes' contract change requests
> (ENGINE-PROTOCOL §8.3) and corrects the documents to what the lanes measured (ENGINE-PROTOCOL §8.4; ARCHITECTURE
> §1–§5, §8, §9; API.md; WAVE-B3 §3.3, §11). Where the lanes departed from this plan, the code and those documents
> win: an ordinary page reaches the engine host through fresh-realm native getters (`host-attack borrow-natives`, a
> recorded limit), so the app origin is the only boundary; everything installed in page realms comes from
> `src/engine-host/realm.ts`; the SW gives SVG, XHTML and XML documents (and HTML without a usable `Content-Type`)
> `script-src 'none'` instead of the document-start hook (lane a's "kill switch also covers SVG/XHTML" item and lane
> b's "doc hook in HTML/SVG/XHTML" item), shows `<frame>` loads to the engines as iframes and refuses UV shared
> workers; the WebRTC kill switch has measured gaps (`host-webrtc gaps-open`); bare-mux's worker has a per-origin
> lock; `saveLink`/`saveImage` are offered since integration part 2 (Firefox had refused the engine host's blob
> downloads through the app's `frame-src`); clipboard enforcement is reported in no browser (integration
> part 2: Chromium's policy stops the asynchronous Clipboard API but not `document.execCommand('copy')`; Firefox
> implements neither the autoplay nor the clipboard-write policy).

Five lanes build at the same time without editing each other's files: (a) engine-host core, (b) engine-host
transport + service worker + build, (c) browser shell, (d) browser data, (e) backend. Then Wave B step 3 (extensions)
plugs into hook points the lanes leave for it (§9).

## 0. Rules for every lane

- Product rules: GNOME is a website only; Rust is for the backend only; the frontend is TypeScript + Svelte 5; the
  engines stay JavaScript, served unmodified; HolyWisp stays the C Wisp server. No fake UI or controls that do nothing,
  no placeholder implementations, no TODO comments for major features, no claim that something works unless a test
  shows it. Never modify `logo.png`, `frontend/public/logo.png` or `frontend/public/brand/**`. Sapphire's code is never
  copied.
- Host safety: never run privileged containers or systemd-in-Docker, never mount host `/proc/sys`, `/sys` or `/dev`,
  never change host kernel state, never use sudo. HolyWisp runs as in the spike harness: an unprivileged, read-only
  container (`--network host --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534`) or
  `HOLYWISP_RUNNER=host`.
- Edit only the files your lane owns (tables below). `frontend/src/shared/**` is **frozen**: a lane that needs a
  contract change writes the exact change and the reason in its report; the integration step applies it. Additive,
  optional changes that keep `PROTOCOL_VERSION` at 1 are preferred.
- Only lane b edits `frontend/package.json`, `package-lock.json`, `tests/e2e/package.json` and its lock, and only lane b
  runs `npm install` (exact versions, `save-exact`). Other lanes ask lane b for a dependency in their report and work
  without it until then.
- No stub modules in another lane's paths, and no import of a module that does not exist yet: a lane that consumes
  another lane's module takes it as a parameter of its own composition root until the module lands (lane a's
  `startEngineHost(deps)`, §2), and its tests inject its fakes.
- Shared and frozen for every lane: the design system (`src/components/**`, `src/styles/**`), the `src/lib/**` files
  no lane owns below (`keys.ts`, `format.ts`, `fuzzy.ts`, `platform.ts`, `tlds.ts`), `frontend/dev/**`,
  `frontend/public/brand/**`. A lane that needs a new component builds it in its own directory.
- Documentation: lane c keeps ARCHITECTURE §5.3 in step with `schema.ts` (the contract test compares them) and lane e
  updates the backend parts of ARCHITECTURE (§4.2 rows, §4.4/§4.6 server parts) and API.md; everything else a lane
  learns (a claim that did not hold, a limitation) goes into its report, and the integration step edits
  ENGINE-PROTOCOL.md and ARCHITECTURE §3–§5. A behaviour marked **[unproven]** that a lane's test disproves is
  dropped or changed through that report, never shipped as if it worked.
- Every increment keeps `npm run check && npm test` in `frontend/` green (and `cargo test --workspace` for lane e).
  Mark whatever is not tested yet as unverified, in code comments and in the report.
- Servers and harnesses take every port from the environment; use the port range your task gives you. Close every
  browser you launch and stop every process you start. Large outputs (cargo target dirs, browser profiles you keep)
  never go to `/tmp`.
- End-to-end tests run against the **real** gnome-server + HolyWisp in **Chromium and Firefox** (playwright-core
  1.64.0, the cached chromium-1248 and firefox-1555) with lane b's runner (§3), reusing the spike harness
  (`tests/e2e/spike-engine-host/`) and the real-stack harnesses (`tests/e2e/stack/stack-qa.mjs`,
  `tests/e2e/stack/engine-on-gnome-server.mjs`) where possible. The spike harness itself stays as it is: it is the
  reference for engine upgrades.

## 1. Lanes at a glance

| Lane | Owns (directories and files) | Provides | Consumes |
| --- | --- | --- | --- |
| a engine-host core | `frontend/engine/index.html`, `frontend/public/engine/uv-doc-hook.js`, `frontend/src/engine-host/**` except `transport/` and `sw-client/`, `tests/e2e/engine/suites/host-*.mjs` | the engine-host side of the protocol; `startEngineHost()`; `registerEngineHooks()` | lane b: `createTransportManager()`, `createSwClient()`; `src/shared/*`; `src/lib/keys.ts` |
| b transport + SW + build | `frontend/src/engine-host/transport/**`, `frontend/src/engine-host/sw-client/**`, `frontend/src/sw/**`, `frontend/public/engine/uv.config.js`, `frontend/scripts/copy-vendor.mjs` (+ `frontend/scripts/licenses/**`), `frontend/vite.config.ts` (+ a `vite.sw.config.ts`), `frontend/src/vite-env.d.ts`, `frontend/package.json` + lock, `frontend/tsconfig*.json`, `tests/e2e/engine/{run.mjs,lib/**,servers/**}`, `tests/e2e/engine/suites/{sw,transport,build}.mjs`, `tests/e2e/package.json` + lock | `TransportManager`, `SwClient`, `/sw.js`, the build (dist layout, `__GNOME_BUILD__`, `npm run dev:engine`), the e2e runner | `src/shared/*` |
| c browser shell | `frontend/src/browser/**`, `frontend/src/pages/browser/**`, `frontend/src/app/**`, `frontend/src/main.ts`, `frontend/index.html`, `frontend/src/settings/**`, `frontend/src/pages/settings/**`, `frontend/src/pages/about/**`, `frontend/src/pages/home/**`, `frontend/src/lib/{api,url,events}.ts`, ARCHITECTURE §5.3 (with `schema.ts`), `tests/e2e/engine/suites/shell-*.mjs` | the app-side engine client, tabs, the `BrowserBridge`, settings keys, `dispatchForwardedShortcut()` | the engine protocol; lane d's `library()`; `src/shared/*` |
| d browser data | `frontend/src/library/**`, `frontend/src/pages/{history,bookmarks,downloads}/**`, `frontend/src/lib/idb.ts`, `tests/e2e/engine/suites/library-*.mjs` | `initLibrary()` (history, bookmarks, downloads stores), the sync adapters, the `history` and `downloads` clearers | `src/shared/browser-data.ts`; `src/settings/sync.ts` and `clearers.ts` hooks; the bridge |
| e backend | `backend/**`, `crates/**` (only if needed), `services/**` (comments and recipes it changes), `docs/API.md` sections it changes, ARCHITECTURE §4.2 rows and §4.4/§4.6 server parts it changes, `tests/e2e/engine/suites/backend-*.mjs` | proxy-origin serving with the final CSPs, the custom-Wisp opt-in, templating, the probe's `503`, the dev re-index | `src/shared/proxy-origin.ts` (the strings to produce) |

Directory map (ARCHITECTURE §3): the app is `src/{app,browser,library,pages,settings,lib,components,styles}`; the
engine host is `frontend/engine/index.html` + `src/engine-host/**`; the SW is `src/sw/**` → `dist/sw.js`; shared code
is `src/shared/**`. The app never imports `src/engine-host/**` or `src/sw/**`, and they never import app code (only
`src/shared/**` and the pure `src/lib/keys.ts`); lane b's build test checks both directions (§3).

## 2. Lane a: engine-host core

**Builds** (port spike §4.3, §4.7–§4.10; behaviour: ENGINE-PROTOCOL §2, §3, §5, §6):
- `frontend/engine/index.html`: the vendor scripts in `ENGINE_HOST_SCRIPTS` order, then `<script type="module"
  src="/src/engine-host/main.ts">`, a `<meta name="gnome-app-origins" content="%GNOME_APP_ORIGINS%">` placeholder
  (gnome-server fills it), `<div id="tabs">`, no inline script.
- `core.ts` (composition root): `startEngineHost(deps: {createTransportManager: () => TransportManager;
  createSwClient: () => SwClient}): void` with the standalone guard, the connect listener with `decideConnect()`, hello
  repeats, then the SW client, the transport manager and the engines. `main.ts` is the two-line entry that imports
  lane b's `createTransportManager` and `createSwClient` and calls it; it is added once lane b's day-one modules exist
  (until then nothing imports a missing module, and the tests inject the fakes).
- `protocol-server.ts`: `validateCommandMessage()` on every message, one answer per command id (unknown and invalid
  commands answer with their id), `requiredCapability()` → `unsupported`, `tab.state` (core), `test.*` commands only
  when built with `__GNOME_ENGINE_TEST__`. Every value is fitted before it is emitted (`fitText`, `fitInt`,
  `downloadFilename`, the selection cut with `selectionTruncated`, a favicon over 64 KiB as `null`: ENGINE-PROTOCOL §3)
  and latest-value events are throttled per tab (`COALESCE_MS`: first value at once, the newest at the end of the
  interval, pending values flushed before any other event of that tab; ENGINE-PROTOCOL §5). Debug builds run
  `validateEventPayload()` on every event they emit (a self-check).
- `tabs.ts`: the tab model (frames; their `allow` from the command's `permissions` with `tabFrameAllow(permissions,
  enforcedPermissions)` before every GNOME-initiated load; live cap `LIMITS.maxLiveTabs`; per-tab history of at most
  `LIMITS.maxTabHistory` entries with `historyHandling`, `index` and `length` on every commit, `start.kind: 'restore'`
  whose first commit is `replace`; navId; the navigation state machine; `location.replace` loads; `tab.go` as a full
  load of the target entry). Navigations started in the page (Scramjet: the request hook; Ultraviolet: the `navigate`
  event of the tab's top document, else `beforeunload`), every load of a tab frame classified (commit, UV error page,
  frame left the proxy origin), `204`/`205` and the UV in-page timeout rule (ENGINE-PROTOCOL §6.1).
- `engines/{scramjet,ultraviolet,manager}.ts`: initialization (wasm magic bytes, Controller with
  `allowFailedIntercepts`, `controller.wait()` 10 s, `controllerchange` re-pointing; UV globals + `ultravioletReady()`),
  `proxiedUrl`/`decodeProxyUrl`, the controlled fallback (GET/HEAD only, synchronous error hook, cookie copy incl.
  HttpOnly, attempt counter, `init-failed` switch event; never for a download or a `204`), `classify()` into
  `TabErrorKind`.
- `observe/*`: document attach at any depth with the engine-host realm's natives (`N`); commits incl. same-document
  ones with `push`/`replace`/`traverse` (the Navigation API on the tab's top document, else `History.prototype`
  wrappers + `popstate`/`hashchange` + `PerformanceNavigationTiming`), traversal detection, title, favicon (≤ 64 KiB
  data URL), keys (`parseCombo`/`matchCombo`/`isTextEditingCombo` from `src/lib/keys.ts`), context menu (engine-host
  viewport coordinates × zoom, rounded), fullscreen, CSP-violation counting → `tab.blocked {'direct-connection'}`
  (coalesced).
- `popups.ts`: `window.open`, `target=_blank` links/areas/forms → `tab.openRequest` (ENGINE-PROTOCOL §6.3);
  `window.close()` → `tab.closeRequest`.
- `webrtc.ts`: the kill switch (`WEBRTC_GLOBALS`) at Scramjet `init.pre`, in every UV document (through the
  document-start hook) and in the engine-host realm, when `privacy.webrtc` is `block`; also in SVG and XHTML documents
  that run scripts (lane b's SW inserts the hook there for UV) and in `about:blank`/`srcdoc` children of proxied
  documents if tests show they leak. A document type no hook reaches goes into About's known limitations.
- `csp.ts`: `PROXIED_DOCUMENT_CSP` on Scramjet responses (`fetch.response`) for every `needsProxiedCsp()` destination.
- `downloads.ts`: the Scramjet tap (`downloadDisposition()` on document and iframe responses: `attachment` ends the
  navigation as a download at once, `unrendered-type` after `TIMEOUTS.downloadCommitMs` without a commit; `<a download>`
  requests) and the SW's `uv-download` signals with the attribution rules of ENGINE-PROTOCOL §6.9 (pending navigation
  URL, then `clientUrl`, then `referrer`, exact matches, ignore otherwise).
- `find.ts` (spike code), `zoom.ts`, `actions.ts` (print, select all; `tab.download` only if a variant works without
  the user's activation reaching the frame: until then `saveLink`/`saveImage` stay unreported), `cookies.ts` +
  `site-data.ts`, `suggest.ts` (endpoint table, `proxyFetch`; verify each provider's endpoint), `vpn-verify.ts`,
  `diagnostics.ts` (counters only), `hooks.ts` (the step-3 registry, ALLOW_ALL by default).
- `public/engine/uv-doc-hook.js`: the UV document-start hook (spike file): it hands the window to the engine host,
  which attaches at document start its observers, the WebRTC kill switch, the UV navigation start signal and, for
  step 3, the wrapper of `Ultraviolet.BareClient.prototype.createWebSocket` (installed when uv.bundle.js defines
  `Ultraviolet`; it calls `engineHooks().onWebSocket`, ALLOW_ALL until step 3).

**Interfaces it provides** (exact):
```ts
// src/engine-host/core.ts: the composition root (main.ts calls it with lane b's factories; tests pass fakes).
export function startEngineHost(deps: { createTransportManager: () => TransportManager; createSwClient: () => SwClient }): void;
// src/engine-host/hooks.ts: Wave B step 3 registers the content blocker here (window side).
export function registerEngineHooks(hooks: EngineHooks): () => void;   // EngineHooks from src/shared/engine-hooks.ts
export function engineHooks(): EngineHooks;                            // ALLOW_ALL until something registered
```
**Consumes**: `createTransportManager(): TransportManager` (`src/engine-host/transport/index.ts`) and
`createSwClient(): SwClient` (`src/engine-host/sw-client/index.ts`) from lane b, imported only by `main.ts` once they
exist; `src/shared/*`; `src/lib/keys.ts`.

**Settings it reads** (only through `EngineSettings` and the commands): `engines`, `engine`, `autoFallback`,
`privacy.webrtc`, `keys`, and the per-load `permissions` of `tab.create`/`navigate`/`go`/`reload`; `route`/`transport`
go to the transport manager; `privacy` (rest) and `extensions` go to the hooks.

**Capabilities**: report one only when its e2e test passes in both browsers (`zoom`, `print`, `selectAll`,
`saveLink`, `saveImage`, `cookies`, `siteData`, `suggest`, `vpnVerify`). `InitResult.enforcedPermissions` lists, per
browser, each of `autoplay`, `fullscreen`, `clipboard` whose enforcement e2e passes in that browser. Core features
have no flag: they must work.

**Tests**: unit (vitest, node): command dispatch with a fake port (`MessageChannel`), the navigation state machine
(GNOME-initiated and in-page starts, `204`, the UV in-page timeout rule, downloads) and fallback decisions, history
handling and `tab.state`, `classify()`, popup-routing decisions, coalescing order, the fit helpers on real measured
values, cookie-jar conversions (Scramjet dump ⇄ UV rows), suggestion parsing, diagnostics shape
(`validateCommandResult('diagnostics', …)`). E2E (`tests/e2e/engine/suites/host-*.mjs`, real stack, both browsers):
ports of the spike's `smoke`, `nav`, `fallback`, `input`, `isolation`, `leak` (lab, sites, bypass, hostcsp), `attack`
(webrtc, popup, handshake, host-inject) and `perf` suites against the built engine host; new rows: a pushState SPA
(push, replace, popstate, the browser's Back button, `tab.go` onto a pushState entry: `index`/`length` match), UV link
and form navigations → loading → committed → loaded, a failing UV link → `tab.error` and GNOME's overlay (never UV's
page), a `204` link (no error, the spinner ends), a zip without `Content-Disposition` via link and via navigation in
both engines (exactly one request, no error overlay, no fallback), `<a download>`, a UV download from a
`Referrer-Policy: no-referrer` page, popups (`window.open` with and without activation, `target=_blank`, middle-click,
GET/POST forms, `window.close`), context-menu kinds (fractional coordinates arrive as integers, a selection over
100 000 characters), WebRTC kill switch through the engines' hooks (ordinary page 0 STUN packets, blank child frame,
an SVG document with a script), CSP on `frame`/`object`/`embed` and an SVG document, each capability's command, each
enforced permission (`<feature> 'none'` blocks it in that browser), "no permissive realm" (§6 item 5: borrow each kind
of proxy-origin document in a hidden frame and try `fetch`, `WebSocket` and `new Image()` from it), `test.*` absent
in a production build.

**Fakes to work alone**: `src/engine-host/testing/fake-transport-manager.ts` and `fake-sw-client.ts` (in lane a's own
directory), passed to `startEngineHost()` in tests; e2e starts once lane b's day-one modules land.

## 3. Lane b: transport, service worker, build

**Builds** (port spike §4.4–§4.6 and §4.11; rules: `src/shared/transport.ts`, ARCHITECTURE §5.4):
- **Day one, in this order** (unblocks lane a): `src/vite-env.d.ts` (`declare const __GNOME_BUILD__: string;
  declare const __GNOME_ENGINE_TEST__: boolean;`); `transport/index.ts` exporting `createTransportManager()` with the
  libcurl/epoxy transports for both sides, the canonical URL (`routeEndpoints`, `wispUrl`), the single rebuild queue
  and `init()`-before-use; `sw-client/index.ts` exporting `createSwClient()` (register, claim, `controllerchange`); the
  `src/sw/` port of spike §4.11 with the hard-wired CSP; the SW build; `scripts/copy-vendor.mjs`; the engine
  packages in `frontend/package.json` (the exact `VENDOR_PACKAGES` pins, the two `*-transport-bare` aliases as in
  `tests/e2e/package.json`) plus `fake-indexeddb` (exact pin) for lane d.
- **Vite multi-entry**: `engine/index.html` is a second input. The existing `codeSplitting` group
  `{name: 'shell', tags: ['$initial']}` must get `entriesAware: true` (or a `test` limited to app modules): without it
  rolldown puts the initial modules of every entry into one `shell-*.js` that both pages load, so the engine host would
  run the app's `main.ts` and the app the engine host's (reproduced with Vite 8.3.7 / rolldown 1.2.18 in the
  completeness review). A build test reads the Vite manifest and checks both directions: the engine-host entry's
  static and dynamic import graph has only `src/engine-host/**`, `src/shared/**`, `src/lib/keys.ts` and Vite's preload
  helper; the app's graph has no `src/engine-host/**` or `src/sw/**`. The second input lands together with lane a's
  `engine/index.html` and `main.ts` (§8 step 3), because each needs the other; until then lane b checks the config
  and the test with a fixture entry in its own test directory, so `npm run build` never points at a missing file.
- **The classic SW**: a second build (`vite build -c vite.sw.config.ts`: `build.lib` with `formats: ['iife']`,
  `fileName: () => 'sw.js'`, `emptyOutDir: false`, `copyPublicDir: false`; checked in the completeness review: no
  `import`/`export` in the output). `__GNOME_BUILD__` is computed once (an environment variable the npm script sets) and
  given to both builds; `npm run build` chains the app/engine build, the SW build and `copy-vendor` in that order.
  `%GNOME_APP_ORIGINS%` survives Vite's HTML env replacement; the classic vendor `<script>` tags stay as they are, with
  a "can't be bundled without type=module" warning the build test expects.
- Then: the watchdog (probe via `probeUrl`/`classifyProbe`: 426 rebuild, 401 renew, 429 wait `Retry-After`,
  `503 wisp_upstream_unavailable` → `offline`/`upstream-unreachable` and the next probe after `Retry-After`, 404 →
  `offline`/`unknown-profile`, a socket that fails right after a 426 → `upstream-unreachable` with backoff;
  `backoffDelayMs`, `RebuildBudget`, idle retry), lazy renewal and the proactive renewal timer (`ticketRenewDelayMs()`
  after every ticket → `onNeedTicket('expiring')`), the shared UV transport (`uvTransportKey`/`uvTransportAction`: the
  installed key must be readable by every manager, e.g. as the manual transport's name; ENGINE-PROTOCOL §6.6), the UV
  socket tap inside the bare-mux worker whose events reach **every** engine host (through the SW's
  `Client.postMessage`, or one tap port per engine host; never a fixed BroadcastChannel name), `proxyFetch`,
  `useHooks()` around the Scramjet transport's WebSocket connects (UV pages are hooked by lane a), UV/libcurl warm-up
  (spike §7.3), custom endpoints (only when the route is `custom`, i.e. the operator allows them) and failover,
  `diagnostics()` (including `upstreamDown`/`unknownProfile` probes).
- SW: `self.skipWaiting` neutralized before `importScripts(...SW_IMPORTS)`; hold-and-revive; stale-prefix `503`;
  Firefox body buffering; the UV document-start hook inserted into HTML, SVG and XHTML documents; the download taps
  (`downloadDisposition()` on every UV response to a `mode: 'navigate'` request and on `<a download>` requests, never
  on a page's own fetch; `uv-download {…, clientUrl, navigation, disposition}`); signals to engine-host clients with
  `Client.postMessage` (never a BroadcastChannel); `parseHostToSw()` with `isEngineHostClientUrl()`; `sw-hello` with the
  build id; `gnome-skip-waiting` from the only engine host; `registerSwHooks()` for step 3. **No permissive realm**:
  every document the SW creates or passes through carries `PROXIED_DOCUMENT_CSP`, its own hold and `503` pages a
  policy at least as strict (`default-src 'none'` where nothing runs), with lane e (§6 item 5).
- SW client: `ensureControlled()` with the explicit apply step (ENGINE-PROTOCOL §2.5), `status()`, `onSignal()`.
- Build: `npm run build` → the `dist/` layout of ARCHITECTURE §3; `npm run dev:engine` (watch build of the engine
  host, SW and vendor copy, leaving `dist/index.html` alone); `__GNOME_BUILD__` in both bundles; `__GNOME_ENGINE_TEST__`
  only for e2e builds (`npm run build:e2e`); a separate `tsconfig` for `src/sw/` with the WebWorker lib (the shared
  files already compile there); vendor LICENSE files (the AGPL-3.0 text for packages without one, kept in
  `scripts/licenses/`, plus the bundled libraries' licenses such as libcurl.js).
- **E2E runner** `tests/e2e/engine/run.mjs`: starts the real gnome-server (two origins on loopback ports from the
  lane's range) and HolyWisp (the direct upstream plus one VPN-profile upstream the suites can stop), builds with
  `npm run build:e2e`, runs the suites in both browsers and writes `results.md` like the spike. It keeps the spike's
  suite contract, so every lane's suites look alike:

```js
// tests/e2e/engine/suites/<name>.mjs (lanes a, b, c, d, e)
export async function run(ctx) {}
// ctx, provided by tests/e2e/engine/run.mjs (lane b); lane b may add members, never change these:
//   browser: 'chromium' | 'firefox'; suite: string; runDir: string
//   launch(opts?): Promise<Browser>                playwright-core; the suite closes what it launches
//   newContext(browser): Promise<BrowserContext>
//   openApp(context, query?): Promise<App>         the built app on the real stack; App as in the spike's
//                                                  lib/drive.mjs: waitInit, mark, eventsSince, waitFor, gnome,
//                                                  waitTabFrame, createTab, navigate, stats, close
//   record({ test, result: 'pass' | 'fail' | 'skip', engine?, transport?, notes? }): void
//   log(...msg): void;  sleep(ms): Promise<void>
//   stack: { appOrigin, proxyOrigin,
//            restartServer(env?: Record<string, string>): Promise<void>,   // e.g. GNOME_ACCESS_MODE=code
//            upstream(name: 'direct' | string): { stop(): Promise<void>, start(): Promise<void> } }
```

**Settings it reads** (through lane a's calls): `EngineSettings.route` and `transport` (`start()`, `configure()`), the
ticket (`setTicket()`); `privacy`/`extensions` reach the SW hooks in step 3.

**Interfaces it provides** (exact):
```ts
// src/engine-host/transport/index.ts
export function createTransportManager(): TransportManager;           // src/shared/transport.ts
// src/engine-host/sw-client/index.ts
export function createSwClient(): SwClient;                           // src/shared/proxy-origin.ts
// src/sw/hooks.ts (service worker): Wave B step 3 registers the UV request hooks here.
export function registerSwHooks(hooks: RequestHooks): void;           // src/shared/engine-hooks.ts
```

**Tests**: unit: the manager with fake transports and a fake `fetch` (each probe outcome incl. `503` and 404, backoff
with injected randomness, the rebuild cap, lazy renewal per transport kind, one queue under concurrent rebuild
requests, custom endpoints never get the ticket, `uvTransportAction` wiring with two managers sharing a fake worker);
SW pure parts (prefix ownership, CSP decision, body buffering, download disposition per destination); `copy-vendor`
(every file byte-identical to `node_modules`, LICENSE present); the build test (manifest graph in both directions,
`dist/sw.js` has no `import`/`export`, `dist/engine/index.html` scripts equal `ENGINE_HOST_SCRIPTS`,
`dist/vendor/<dir>/` for every `VENDOR_PACKAGES` entry). E2E (`suites/sw.mjs`, `suites/transport.mjs`): ports of the
spike's `sw` and `transport` suites against the **real** gateway (ticket forms, probe 401/426, a forced 429, drop,
gateway restart, rotation, proactive and lazy renewal with the minimum 60 s TTL, a VPN profile whose HolyWisp is down:
`426` then a failed upgrade → `upstream-unreachable` and backoff, and the `503` answer once lane e has it; socket count
≤ the per-session cap), two GNOME tabs with both engines (a settings change in one; close the tab that installed the
UV transport, drop the Wisp socket: UV recovers in the other), SW lifecycle (stop/restart, update waits, apply step in
both browsers), forced reload claim. Wisp clients written for tests: HolyWisp's first CONTINUE frame can arrive in the
same read as the `101` head, so attach the message handler before `open` resolves.

**Fakes**: fake transports/fetch for unit tests; the real gnome-server gateway works from day one (it already has the
probe and the canonical ticket forms), the spike's stub (`tests/e2e/spike-engine-host/servers/proxy.mjs`) only for
fault injection the real server cannot do.

## 4. Lane c: browser shell

**Builds** (behaviour: ENGINE-PROTOCOL §1.2, §2, §5, §6):
- The engine client (`src/browser/engine/*`): the iframe with the exact sandbox and `allow` (ARCHITECTURE §4.6), `src`
  = `engineHostUrl(proxyOrigin)` (no parameters), created when the browser view first needs a proxied tab. To
  reconnect (Retry, "Restart browser engine", unexpected-load recovery) it **replaces the iframe element**, never sets
  `src` on the existing one (ENGINE-PROTOCOL §2.3). `decideHello()` with the expecting rule, connect, `init`, commands
  with `commandTimeoutMs()`, `validateResultMessage()` + `validateCommandResult()`. Events: `validateEventMessage()` →
  drop unknown tab and download ids (silently within `TIMEOUTS.closedTabGraceMs` of closing the tab) → `admitEvent()`
  with one `TokenBuckets` per port → handle. Counters in the status registry (`engine-protocol`): the compromise
  signals (unexpected hellos, unexpected loads, invalid events and results) apart from the rest (rate-limit drops,
  unknown ids, `LIBRARY_LIMITS` drops, refused privileged shortcuts). Unexpected-load recovery, `ping` liveness,
  mismatch and update notices. The navigation watchdog (`TIMEOUTS.navigationWatchdogMs`, on resume and after
  rate-limit drops of a tab) with `tab.state`; the copy of each tab's entries from `historyHandling`/`index`/`length`.
- The ticket flow: `requestWispTicket()` also returns the response's `Date` header and takes an `interactive` flag;
  mints that an engine event started are non-interactive (no prompting `ensureSession()`, no sign-in dialog: the
  passive notice of ENGINE-PROTOCOL §6.5 instead), mints the user started are interactive. `Ticket.expiresAt` =
  `ticketExpiresAtLocal(expires_at, date, Date.now(), wisp.ticket_ttl_s · 1000)`. At most 1 mint per 2 s and 10 per
  minute; requests inside those limits deferred and coalesced, never dropped; `Retry-After`.
- The `EngineSettings` snapshot builder (debounced 250 ms): `engineChoice(browser.engine, engines.default, engines)`;
  the route (`profile` when `vpn.mode` is `gateway`, else `custom` when `/api/config` → `wisp.custom_servers` and
  `browser.wispServers` has entries `isWispServer` accepts, else `default`; the kill switch never leaves the profile
  route); combos in canonical form, each once (`isCombo`); the blocker's site maps empty until `blocker` is reported;
  `privacy.webrtc` forced to `block` under the VPN kill switch. A property test: every Settings value `validate.ts`
  accepts gives a snapshot `validateEngineSettings()` accepts.
- Per-load permissions: `resolveEnginePermissions()` on every settings change (kept app side), and
  `enginePermissionsFor(resolved, destination)` with every `tab.create`/`navigate`/`go`/`reload`.
- Tabs and the toolbar: tab model and strip (at most `LIMITS.maxTabs`), omnibox (history/bookmark suggestions from
  lane d, `suggest` when on), back/forward/reload/stop, engine badge, error overlay (also restored from
  `tab.state.error`), popup decisions (`decideOpen` with `appActivation` = the app document's
  `navigator.userActivation.isActive`, null where missing) and the blocked-popup indicator, context menu
  (`ContextMenuHost`; no Copy for `selectionTruncated`), find bar, zoom (`browser.defaultZoom`), fullscreen state, the
  downloads panel, permission UI, history visits through one `VisitGate` per app page, session restore (real URLs +
  entries), discard policy (memory saver, `backgroundTabs`, `LIMITS.liveTabsSoftCap`), "clear on exit" at the next
  fresh start (sessionStorage marker absent and no answer from other GNOME tabs on the app-origin BroadcastChannel
  `gnome-app`): `init.clearOnStart`, `library().history.clear()`.
- `BrowserHost.svelte` replaces its placeholder; the browser registers its `BrowserBridge` and, once every
  browser-gated setting really works (§7), `registerFeature('browser')`.
- Shortcuts: forwarded combos (`tab.key`) run through `dispatchForwardedShortcut()`, active tab only, with the table of
  ENGINE-PROTOCOL §6.7 (ordinary and privileged actions; privileged ones need the app document's transient activation
  and pass `FORWARDED_PRIVILEGED_LIMIT`; a new action is privileged until classified); `bookmarkPage` opens the
  bookmark editor; About lists the shortcuts that work.
- Settings: the new key `privacy.webrtc` (§7) in `schema.ts`, `defaults.ts`, `validate.ts`, ARCHITECTURE §5.3 (the
  contract test compares them) and a Privacy row with the IP warning; `validate.ts` uses the shared `isWispServer`,
  `isCombo` and `isHostKey` (so a saved value always fits the protocol); the permission rows per ENGINE-PROTOCOL §6.14:
  allow/block rows only for the permissions in `enforcedPermissions` (remembered with the build id in localStorage
  after the first `init`, hidden until known); the custom-Wisp editor: with `wisp.custom_servers` false it is
  replaced by an explanation, with it true it warns that custom servers bypass the gateway, its access rules, VPN
  profiles and part of the leak protection, and that they are not used while the VPN is on; the registry changes of
  §7.
- `lib/api.ts`: `ServerConfig.wisp.custom_servers` (false when absent); `requestWispTicket()`'s `Date` header and
  `interactive` flag.
- About: engine versions from `InitResult.versions`, the known limitations of ARCHITECTURE §5.4, the permissions and
  features proxied pages never get (ENGINE-PROTOCOL §6.14), and the license list's pins read from
  `frontend/package.json` once lane b added the engines.
- Home: moves to `library()` (`history.query`, `bookmarks.favorites`/`setFavorite`, `history.removeUrl`) once lane d
  lands; until then it keeps its direct IndexedDB reads, which lane d keeps working (§5).

**Interfaces it provides** (exact):
```ts
// src/app/shortcuts.ts: forwarded key from the engine host (validated tab.key, active tab, browser view visible).
export function dispatchForwardedShortcut(combo: string, repeat: boolean): boolean;
// src/browser/bridge.ts (exists): the browser registers itself.
export function setBridge(bridge: BrowserBridge): () => void;
```
**Consumes**: `library(): BrowserLibrary | null` and `onLibrary()` (lane d, through `src/shared/browser-data.ts`);
`VisitGate`; `decideOpen()`, `resolveEnginePermissions()`, `enginePermissionsFor()`; the protocol helpers.

**Tests**: unit: the engine client against a fake engine host (every `decideHello` branch, unexpected hello/load and
the iframe replacement, result validation, timeouts, the event pipeline order, rate-limit drops, the watchdog and
`tab.state`, ticket rate limits and the clock conversion with skew both ways, non-interactive mints, mismatch), the
snapshot builder (route precedence incl. the VPN kill switch, `webrtc` forced to `block`, the property test), the tab
model (discard/restore, the soft cap, `maxTabs`, closed-tab stack, the entries copy), `decideOpen` wiring, forwarded
shortcuts (both classes, the limit). E2E (`suites/shell-*.mjs`, real stack, both browsers), **first**: does a click and
a key press in a proxied frame give the app document transient activation (`decideOpen` and privileged shortcuts
depend on it; ENGINE-PROTOCOL §6.3)? A two-origin fixture (an app-origin page, a proxy-origin frame, a nested frame)
answers it on day one, before any engine host exists. Then: open/close/switch tabs, navigate, back/forward through
the UI, reload, error overlay + "open in other engine", popups with and without a gesture and the indicator,
context-menu items, find bar, zoom, page fullscreen, forwarded shortcuts (ordinary and privileged), session restore
after an app reload,
engine-host reload recovery (`top[0].location.reload()` from a test page) and Retry with `history.length` unchanged,
update notice with a waiting SW, settings changes applied live (transport, engine, WebRTC), the ticket flows in
`code` and `accounts` access modes (incl. the passive notice and that only a gesture opens the dialog).

**Fakes**: `src/browser/testing/fake-engine-host.ts` (answers the protocol over a `MessageChannel` with scripted events;
validates every command it receives), an in-memory `BrowserLibrary` until lane d lands.

## 5. Lane d: browser data

**Builds**:
- `src/library/history.ts`, `bookmarks.ts`, `downloads.ts` implementing `HistoryStore`, `BookmarkStore`,
  `DownloadStore` (`src/shared/browser-data.ts`), `src/library/index.ts` exporting `initLibrary()` that calls
  `provideLibrary()`, registers the sync adapters (`registerRecordSync` in `src/settings/sync.ts`) and the `history` and
  `downloads` clearers (`registerClearer` in `src/settings/clearers.ts`, replacing the built-in ones).
- Bookmarks: top-level items store `parentId: BOOKMARK_ROOT` (IndexedDB cannot index null); the sync adapter maps it
  to `parentId: null` in `pending()` (so `bookmarkToWire` sends `parent_id: null`) and back in `applyRemote()`;
  positions, folders, tombstones, last-writer-wins with `max(now, updatedAt + 1)` stamps; `favorite` (device-local:
  never sent by the sync adapter, kept on `applyRemote()`, as `sync.ts` already expects); `favorites()`,
  `setFavorite()`; Netscape-HTML import/export (bookmarks page).
- History: visits as the caller's `VisitGate` admitted them (the store checks `browser.history.enabled`), retention
  (`browser.history.retentionDays`, pruned at start and daily), search, frecency suggestions, deletion by
  id/URL (`removeUrl`)/range/all with `onChange`; the history sync adapter only when `account.syncHistory`.
- Downloads: keyed by engine-host instance + `downloadId`; `started()` resolves false (records nothing) beyond
  `LIBRARY_LIMITS.activeDownloadsPerInstance` unfinished or `downloadsPerInstance` in total for that instance, or
  while `browser.downloads.track` is off; progress coalesced (≤ 1 write/s/item); `untracked` for ended instances;
  `keepDays`.
- `lib/idb.ts`, with frozen boundaries so lane c keeps compiling and working: `HistoryRecord {id, url, title,
  visitedAt}` and its `visitedAt`/`url` indexes stay (Home and the built-in clearers read them until they move);
  `BookmarkRecord.parentId` keeps its type `string | null` (`sync.ts`'s `bookmarkToWire`/`bookmarkFromWire` use it)
  and `favorite?` stays; `DownloadRecord` changes only inside lane d's appended upgrade, which migrates existing records
  (`size` → `total`, state `complete` → `completed`, `engine` and the instance added; `in_progress` keeps its name).
  Outside that upgrade fields are added, never renamed; new indexes go into the same appended upgrade.
- Pages: History (search, delete), Bookmarks (tree, edit, import/export), Downloads (list, remove, clear); links open
  through `openUrl()` / `browseLink()` (`src/browser/bridge.ts`).

**Settings it reads**: `browser.history.enabled`, `history.retentionDays`, `browser.downloads.track`, `keepDays`,
`account.syncHistory`/`syncBookmarks` (through `src/settings/account-sync.ts`); `privacy.clearHistoryOnExit` is applied
by lane c calling `history.clear()`.

**Interfaces it provides** (exact):
```ts
// src/library/index.ts
export function initLibrary(): () => void;   // provideLibrary({history, bookmarks, downloads}) + sync adapters + clearers
```
**Consumes**: `src/shared/browser-data.ts`, `src/settings/sync.ts` (`registerRecordSync`, `requestRecordSync`),
`src/settings/clearers.ts` (`registerClearer`), `src/lib/idb.ts`, the bridge.

**Tests**: unit with `fake-indexeddb` (asked from lane b; until then an in-memory store behind the same interface):
every store method, the root sentinel round trip through `bookmarkToWire`/`bookmarkFromWire`, sync adapters with the
fake transports `src/settings/sync.test.ts` uses, retention, download coalescing, the per-instance caps and
`untracked`, the `DownloadRecord` migration of the appended upgrade, Netscape import of real exports (Chrome,
Firefox). E2E (`suites/library-*.mjs`): the three pages with seeded data in both browsers; history and bookmark sync
against a real gnome-server in `accounts` mode; with lane c: visits recorded from real navigations (a pushState SPA
records pushes, not replaceState churn).

## 6. Lane e: backend

**Builds** (Rust; exact strings: `src/shared/proxy-origin.ts`; ARCHITECTURE §4.6):
1. Engine-host documents (`/engine/` and extension-less paths below it): the built-in policy
   `engineHostCsp(appOrigins, {customWisp})` (byte-identical), `nosniff`, `Referrer-Policy: no-referrer`, `no-cache`;
   `GNOME_PROXY_CSP` as a **second** policy header value (so it can only restrict).
2. `GNOME_ALLOW_CUSTOM_WISP` (default `false`; decisions log 2026-11-11): in `config.rs` `VARS`, `config check`, a row in
   ARCHITECTURE §4.2 and `/api/config` → `wisp.custom_servers` (API.md). `true` adds `ws: wss:` to the engine-host and
   bare-mux worker policies; nothing else changes them, and no query parameter of `/engine/` or of the worker URL is
   read (escaped code can load any same-origin URL in a hidden frame).
3. `%GNOME_APP_ORIGINS%` in `engine/index.html` replaced (once, when indexing) with the allowed app origins,
   space-separated and HTML-attribute-escaped; in single-origin mode the app origin itself. Precompressed `.br`/`.gz`
   siblings of a templated file are produced after templating (Wave D) or not served for it.
4. `/vendor/bare-mux/worker.js` with `bareMuxWorkerCsp({customWisp})` (`connect-src 'self'`, verified in spike §12)
   and `bareMuxWorkerScriptCsp(appOrigins, {customWisp})` as a second policy (sent since lane e's review, in the
   contract since the integration, ENGINE-PROTOCOL §8.3: the first alone is a permissive realm); every other
   `/vendor/**` script gets `proxyScriptCsp(appOrigins)`.
5. **No permissive realm** (PROGRESS "Wave B inputs"): every other proxy-role response carries a policy at least as
   strict as `PROXIED_DOCUMENT_CSP`: `proxyInertCsp(appOrigins)` (`default-src 'none'`) where nothing runs
   (`/api/health`, `/api/filters*`, the 404 and JSON error answers); the engine-prefix `503` page, which runs its retry
   script, allows exactly that script (by hash) and the `/sw.js` registration, nothing else; scripts and worker
   scripts (`/sw.js`, `/assets/*`, `/vendor/**`) get no more than their realm needs (`connect-src 'self'` at most,
   except the opt-in of item 2). Lane a's attack rows (§2) prove it in both browsers.
6. The ticket probe answers `503 wisp_upstream_unavailable` with `Retry-After` while the health job has that route's
   upstream down (instead of `426` followed by a failing upgrade); API.md's probe section says so; `classifyProbe`
   already reads it.
7. Check what already holds and keep it: `/sw.js` `no-cache` + `Service-Worker-Allowed: /`; the trimmed proxy-origin
   `GET /api/health` (status + `direct` only); a rate-limited probe answers `429` with `Retry-After`, never `401`;
   `/api/config` 404 on the proxy origin; side-effect-free GET handlers; a `Date` header on `POST /api/wisp/ticket`
   (the app's ticket clock uses it).
8. Development: `GNOME_STATIC_RELOAD` (default off, for development only): the static index is rebuilt when a request
   misses under `/assets/` or `/engine/` (at most once per second) and when a built HTML file changed, so
   `npm run dev:engine` works without restarting gnome-server (ARCHITECTURE §3); a row in §4.2.
9. Recommended (spike §11.3 item 4 and §8.1.4): `__Host-` cookie names on loopback HTTP too, so the dev two-port
   mode behaves like production.
10. Update ARCHITECTURE §4.2 (`GNOME_PROXY_CSP`, `GNOME_ALLOW_CUSTOM_WISP`, `GNOME_STATIC_RELOAD` rows), §4.4/§4.6 server
   parts and API.md ("Static & SPA", `/api/config`, the probe) to what is implemented.
11. The stale comments of the Wave B inputs: `services/holywisp/gnome.conf` (the reverse proxy terminates TLS, not the
   gateway), the header and the `bus:disable-leak-csp` message of `tests/e2e/spike-engine-host/suites/attack.mjs`
   (comments only), `crates/catalog/src/blocklist.rs:227` (no `start:` prefix).

**Tests**: `cargo test` for the policy strings with `customWisp` off and on (compared with the TS constants copied into
a test fixture), that a query on `/engine/` or the worker URL changes no header, the templating, the second policy,
single-origin mode, the strict policy of every other proxy-role response, the `503` probe while the upstream is marked
down, `GNOME_STATIC_RELOAD`; e2e (`suites/backend-*.mjs`): headers of `/engine/`, `/vendor/bare-mux/worker.js` and
`/sw.js` from the real server compared with `engineHostCsp()` / `bareMuxWorkerCsp()` for both opt-in values,
`tests/e2e/stack/stack-qa.mjs` against the Wave B server, and an **HTTPS two-hostname** run (two `*.localhost` names
on loopback with a local CA that only the test browser profiles trust: no change to the host's resolver or trust
store).

## 7. Settings keys

**New** (lane c adds them to `schema.ts`, `defaults.ts`, `validate.ts`, ARCHITECTURE §5.3 and the Settings page):

| Key | Type, default | Consumer | Settings row |
| --- | --- | --- | --- |
| `privacy.webrtc` | `'block' \| 'allow'`, `'block'` | lane a (kill switch, via `EngineSettings.privacy.webrtc`); lane c forces `block` under the VPN kill switch | Privacy, `needs: 'browser'`, with the warning that `allow` sends traffic directly, outside GNOME, revealing the IP address |

**Existing keys whose Settings rows wait for `registerFeature('browser')`** (`pages/settings/registry.ts`
`needs: 'browser'`); lane c registers the feature only when every one of them works:

| Key | Implemented by | Notes |
| --- | --- | --- |
| `browser.engine`, `browser.autoFallback` | c (snapshot, `engineChoice`), a | the operator default `GNOME_ENGINE_DEFAULT` decides what `auto` means |
| `browser.transport` | c (snapshot), b | |
| `browser.wispServers` | c (route, editor), b (endpoints), e (`GNOME_ALLOW_CUSTOM_WISP`) | used only when the operator allows custom servers and the VPN is off; otherwise the row explains why |
| `browser.searchSuggestions` | c (omnibox), a (`suggest`) | |
| `browser.defaultZoom` | c, a (`zoom`) | hide the row while `zoom` is not offered |
| `browser.newTab`, `newTabUrl`, `startup`, `startupUrls`, `openLinksInBackground`, `closeTabActivates`, `confirmCloseMultiple` | c | |
| `appearance.tabStrip`, `appearance.toolbar`, `appearance.showBookmarksBar` | c (bar UI) with d's store | |
| `browser.history.enabled`, `history.retentionDays` | d | |
| `browser.downloads.track`, `keepDays` | d | |
| `browser.downloads.openPanelOnStart` | c | |
| `privacy.defaultPermissions`, `privacy.sitePermissions` | c (UI, `resolveEnginePermissions` + `enginePermissionsFor` per load, popups via `decideOpen`), a (`tabFrameAllow`, `enforcedPermissions`) | camera, microphone, geolocation, notifications shown as unavailable; autoplay, fullscreen, clipboard allow/block only where enforced in this browser (ENGINE-PROTOCOL §6.14) |
| `privacy.clearHistoryOnExit`, `privacy.clearSiteDataOnExit` | c (next fresh start), d (`history.clear()`), a (`init.clearOnStart`) | |
| `browser.cookies.clearOnExit` | c (next fresh start), a (`init.clearOnStart.cookies`) | lane c re-gates the row (`cookiesClearOnExit`) from `extensions` to `browser`: it works in step 2 |
| `performance.memorySaver`, `discardAfterMinutes`, `backgroundTabs` | c | plus `LIMITS.liveTabsSoftCap` |
| `performance.cacheLimitMB` | none in Wave B step 2 | lane c re-gates the row to `extensions` and words it as the cap on GNOME's cached filter data, which step 3 implements |
| `account.syncHistory`, `account.syncBookmarks` | d (adapters; `account-sync.ts` already runs them) | |

The other rows gated by `extensions` (`browser.cookies.mode`, `privacy.sendGpc`, `doNotTrack`, `referrer`,
`stripTrackingParams`) stay hidden until Wave B step 3. The VPN route rule (`vpn.mode`, `preferredLocation`,
`killSwitch`) is part of lane c's snapshot builder now; the VPN page is Wave C, and it shows `vpn.verify` as the check
service's answer, never as proof (ENGINE-PROTOCOL §6.13).

## 8. Integration order

1. **Contract** (step 1) → security and completeness reviews → contract fix (`src/shared/**`, the two documents,
   ARCHITECTURE §3–§5). Done 2026-11-12.
2. **All five lanes start in parallel.** Day one: lane b lands, in the order of §3, `vite-env.d.ts`,
   `createTransportManager()`, `createSwClient()`, the SW port and build, `copy-vendor.mjs` and the dependencies
   (engines, `fake-indexeddb`); lane e lands items 1–5 of §6; lane c runs its activation e2e first. Lanes a, c, d work
   against their fakes meanwhile.
3. **a + b + e**: lane a adds `engine/index.html` and `main.ts` with the real transport manager and SW client, and
   lane b adds the second Vite input with the `entriesAware` fix and the manifest build test in the same step; the
   host and transport e2e suites run against the real stack (gnome-server + HolyWisp, both browsers).
4. **c**: the engine client switches from its fake to the real engine host; **d**: lane c calls `initLibrary()` from
   `main.ts` (one line, once `src/library/index.ts` exists), replaces the in-memory library and moves Home to
   `library()`.
5. **Integration**: every suite in both browsers, `npm run check && npm test`, `cargo test`, the spike harness's
   `leak` suite against the new engine host (no new native constructs), then `registerFeature('browser')` (lane c),
   then an independent review. Part 1 (2026-11-18, beside the UI restyle) covers the contract change requests,
   the CSP fixture shared with `csp.rs`, and the documents. Part 2 (after the restyle): a rebuilt e2e binary, every suite
   under `tests/e2e/engine/` in both browsers, the spike leak suite and the attack rows against the real engine host,
   real browsing through GNOME's UI, About's known limitations, the `registerFeature('browser')` check (lane c
   registers it when the browser module starts), the code items part 1 left open (e.g. `src/browser/engine/client.ts`
   keeping `expecting` after the hello timeout, ENGINE-PROTOCOL §2.2 step 5), then the review.

## 9. Where Wave B step 3 (extensions) plugs in

Wave B step 3 is planned and recorded in `docs/WAVE-B3.md` (decisions D1–D19, the §12.4 test matrix); what was built
is in ARCHITECTURE §5.5 and ENGINE-PROTOCOL §6.17 and §8.8. The list below is the step-2 hand-over it started from.

- Window side: `registerEngineHooks(hooks: EngineHooks)` (lane a's `src/engine-host/hooks.ts`); the Scramjet per-tab
  plugin already calls `onRequest`/`onResponse`/`onDocument` through `safeVerdict` and the counters.
- Service worker: `registerSwHooks(hooks: RequestHooks)` (lane b's `src/sw/hooks.ts`), fed by
  `{type: 'gnome-blocker-config'}` from the engine-host client; UV `request`/`beforemod` already call it.
- WebSockets: Scramjet pages through `TransportManager.useHooks()` (lane b); UV pages through lane a's wrapper of
  `Ultraviolet.BareClient.prototype.createWebSocket` in each UV document, which calls `engineHooks().onWebSocket`.
- Protocol: `EngineSettings.privacy`/`extensions` already travel with every snapshot (the per-site maps empty until
  `blocker` is reported); `status.blocker`, the `blocker` capability, `tab.blocked` categories and the filter lists
  (`GET /api/filters/<id>?v=<sha256>` on the proxy origin) are defined; `blocked` is already a `TabErrorKind`.
- App: `src/extensions/**` (core, filter-engine worker), `pages/extensions/**`, the `extensions` feature gate, the
  re-gated `performance.cacheLimitMB`.

## 10. Owners of the Wave B inputs (PROGRESS.md)

| Input | Owner |
| --- | --- |
| Engine-host and bare-mux worker CSPs as proxy-role defaults, with the custom-Wisp opt-in | e (§6 items 1–4); c (the Settings editor and its texts) |
| The probe answers `426` while the upstream is down; back off after a `426` and a failed upgrade; VPN status from the app | e (`503 wisp_upstream_unavailable`, §6 item 6); b (classification and backoff); c (`/api/vpn/locations`) |
| Ticket renewal that scales with the TTL; deferred and coalesced ticket requests | b (the `ticketRenewDelayMs` timer); c (the mint queue) |
| WebRTC kill switch | a |
| Explicit apply step for a waiting `/sw.js`; SW→host signals over `Client.postMessage` | b |
| Engine iframe without `allow-popups*` | c (the iframe), a (popup routing) |
| Real-stack runs in `code` and `accounts` access modes | c (e2e ticket flows) |
| HTTPS with two hostnames | e (§6 tests) |
| A real VPN tunnel | not in Wave B: it needs an operator's VPN account; the VPN step of Wave C runs it with the operator |
| The perf suite | a (the `perf` port) |
| No permissive realm on the proxy origin | e (server responses), b (the SW's documents), a (the attack rows that borrow each kind of proxy-origin document) |
| Reuse `tests/e2e/stack/stack-qa.mjs` and `engine-on-gnome-server.mjs` | e (stack-qa in its e2e), b (the runner's server setup) |
| Stale comments (`services/holywisp/gnome.conf`, the attack suite, `crates/catalog/src/blocklist.rs`) | e (§6 item 11) |
