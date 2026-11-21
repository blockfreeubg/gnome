# Scramjet for GNOME: research and integration guide

Status: research complete, 2026-11-09. Author: research engineer, GNOME project.
Scope: the Scramjet proxy engine, the primary in-browser proxy for GNOME. It covers which version to use, how to integrate it, transports, plugins and hooks, cookies and site data, errors and the Ultraviolet fallback, downloads, and limitations and security.

Labels used in this document:
- **VERIFIED**: reproduced at runtime in the harness (section 15) with the published npm builds in headless Chromium 156 (Playwright `chromium-1248`) and, where stated, Firefox (`firefox-1555`).
- **CODE**: read in the source. File and line references are given.
- **UNVERIFIED**: inferred or assumed, not confirmed.

Source paths are relative to the Scramjet repo checkout `repos/scramjet` (HEAD `517206b`, 2026-11-08) unless they start with `npm:` (contents of a published tarball) or `sapphire/`.

---

## 0. TL;DR

1. **Use Scramjet 2.x through the controller.** Pin exactly: `@mercuryworkshop/scramjet@2.0.67-alpha.2` and `@mercuryworkshop/scramjet-controller@0.0.14`, with `@mercuryworkshop/libcurl-transport@2.0.6` as the primary transport and `@mercuryworkshop/epoxy-transport@3.0.2` as the secondary one. Scramjet 1.1.0 is the final v1 release (EOL). It logs *"you are using the last version of scramjet v1, if possible, please upgrade to v2"*, has no plugin system, and depends on bare-mux. Despite its `"license": "MIT"` field, its tarball ships the **AGPL-3.0** text, so the license question does not favour v1 (§2.3).
2. **Architecture: the service worker (SW) only routes.** Rewriting, cookies and networking all run in the **GNOME page's main thread**, inside the `Controller`. The SW forwards every request under `/~/sj/<controllerId>/<frameId>/…` to that page over a `MessagePort`. The transport is a plain `ProxyTransport` object passed to `new Controller({ transport })`. There is no bare-mux.
3. **Files to serve.** `/scramjet/scramjet.js` and `/scramjet/scramjet.wasm` come from the core package. `/controller/controller.api.js`, `/controller/controller.inject.js` and `/controller/controller.sw.js` come from the controller package. On top of these GNOME needs its own classic `/sw.js` that does `importScripts("/controller/controller.sw.js")` with scope `/`, and the transport bundle. No COOP/COEP headers are required. Adding them is optional and makes `crossOriginIsolated`/`SharedArrayBuffer` available **inside** proxied pages (VERIFIED). A secure context (HTTPS or localhost) is mandatory.
4. **There is no event API.** Everything goes through hooks: `frame.hooks.fetch.{intercept,request,preresponse,response}`, `frame.hooks.init.{pre,post}`, `frame.hooks.error.request`, `frame.fetchHandler.hooks.rewriter.html.{pre,post}`, and per document `client.hooks.lifecycle.navigate`. URL, title, favicon, load, download and error signals are all built from these hooks. Recipes for each are in §5 and §6, VERIFIED unless noted.
5. **Work around these upstream bugs** (all VERIFIED):
   - **Service worker restart.** After the SW restarts, the first proxied request falls through to the GNOME server. Use the hardened SW in §4.3.
   - **Stale prefixes.** Requests for prefixes from a previous page load hang forever.
   - **Transport init.** Concurrent `LibcurlClient.init()` calls hang. Pre-init the transport.
   - **Epoxy reconnects.** Epoxy does not reconnect after the Wisp socket drops. Recreate it with `setTransport`.
   - **Joint session history.** `frame.back()` uses the tab's joint session history, so it can move other iframes or the GNOME shell itself.
   - **Flag override.** The controller's own `allowFailedIntercepts: true` is lost to a `deepMerge` order bug.
   - **Broken page APIs.** Sync XHR throws, WebSockets inside workers throw, and `localStorage.clear()`/`key()` are wrong inside proxied pages.
   - **Published types.** The published `.d.ts` files are broken. Use `skipLibCheck` and local types.
6. **Security: every proxied site shares the GNOME origin.** A proxied page can reach `window[Symbol.for("scramjet client global")]` and read the **whole cookie jar of every proxied site, HttpOnly cookies included** (VERIFIED). Upstream's own adversarial test says cross-site isolation is "architectural rather than a small bug". Strong recommendation: serve the proxy from a **separate origin** (port or subdomain) from GNOME's authenticated UI and API (§10).

---

## 1. What was examined (versions, commits, artifacts)

| Item | Value | Evidence |
|---|---|---|
| Repo HEAD | `517206bc39bc124473844c3cf3ddbb508e32fc20`, 2026-11-08, "[controller, utils] depend on iife in build instead of esmodule" | `git log` |
| Published 2.x build commit | `c26bfc6` (tags `v2.0.67-alpha.2` and `v0.0.14-controller`); `versionInfo = {version:"2.0.67-alpha.2", build:"c26bfc6", date:"2026-06-24T02:30:45.970Z"}` | GitHub tags API; `npm:scramjet@2.0.67-alpha.2/dist/scramjet.js` |
| HEAD vs published | HEAD is **51 commits / 95 files** ahead of `c26bfc6`, with core fixes, type fixes and export changes (§13) | GitHub compare API |
| v1 line | branch `legacy` = tag `v1.1.0` = `57ba89e` (2026-04-27). `main` is 851 commits ahead of `legacy` | GitHub API |
| npm dist-tags | `@mercuryworkshop/scramjet`: `latest=1.1.0`, `legacy=1.1.0`, `alpha=2.0.67-alpha.2`. `@mercuryworkshop/scramjet-controller`: `latest=0.0.14`, `alpha=0.0.4` | `npm view … dist-tags` |
| Publish dates | scramjet 2.0.67-alpha.2: 2026-06-24T02:33Z. controller 0.0.14: 2026-06-24T02:33Z. scramjet 1.1.0: 2026-04-27T04:53Z. proxy-bootstrap 0.0.5 and scramjet-utils 0.0.3: 2026-05-24 | `npm view … time` |
| Wiki | `scramjet.wiki.git` has a single `Home.md` (10 lines) whose three links point to `https://example.com`. **The wiki contains no documentation.** | `pkgs/scramjet-wiki/Home.md` |
| Packages in monorepo | `packages/core` (@mercuryworkshop/scramjet 2.0.67-alpha.2), `packages/controller` (0.0.14), `packages/bootstrap` (@mercuryworkshop/proxy-bootstrap 0.0.5), `packages/utils` (@mercuryworkshop/scramjet-utils 0.0.3), `packages/rpc` (private, **not on npm**), `packages/demo`, `packages/create-proxy-app` (0.0.4), `packages/runway` (site-compat/adversarial test harness) | `pnpm-workspace.yaml` |

### 1.1 Exact files shipped in the npm tarballs (VERIFIED with `npm pack`)

`@mercuryworkshop/scramjet@2.0.67-alpha.2` (`package.json` `main`/`module` = `./dist/scramjet-external.mjs`):

| File | Bytes | What it is |
|---|---|---|
| `dist/scramjet.js` | 227,109 | **IIFE**. Sets `self.$scramjet`. No wasm inside. **This is the file to serve.** |
| `dist/scramjet.wasm` | 586,279 | Rewriter (oxc-based, Rust to wasm). **Serve this.** |
| `dist/scramjet.mjs` | 227,864 | ESM build of the same code, without wasm |
| `dist/scramjet_bundled.js` / `.mjs` | 1,008,891 / 1,009,650 | IIFE/ESM with the wasm inlined as base64. Not useful with the controller, which always fetches `wasmPath` |
| `dist/scramjet-external.mjs` | 1,118 | Generated stub: `export const {…} = globalThis.$scramjet` |
| `dist/*.map`, `dist/types/**` (37 .d.ts), `dist/temp-types-build/*` (build leftover), `lib/index.cjs` (`scramjetPath` = dist dir for Node) | | |

Package `exports`: `"."` → `scramjet-external.mjs`, `"./bundled"` → `scramjet.mjs`, `"./bundled-wasm"` → `scramjet_bundled.mjs`, `"./path"` → `lib/index.cjs`.

`@mercuryworkshop/scramjet-controller@0.0.14` (`main` = `./dist/controller-external.mjs`, `exports` only `"."`). There is no `./path` export; it was added later on HEAD:

| File | Bytes | What it is |
|---|---|---|
| `dist/controller.api.js` | 17,086 | IIFE, `var $scramjetController` (window API: `Controller`, `Frame`, `ManagedPlugin`, `VERSION`, `assertRuntimeScramjetVersion`, `config`) |
| `dist/controller.inject.js` | 6,436 | IIFE loaded into **every proxied document** (`$scramjetController.load(...)`) |
| `dist/controller.sw.js` | 4,576 | IIFE for the SW (`$scramjetController.shouldRoute`, `.route`). Standalone; does **not** need scramjet.js |
| `dist/controller-external.mjs` | 321 | Stub: `export const {Controller,Frame,ManagedPlugin,VERSION,assertRuntimeScramjetVersion,config} = globalThis.$scramjetController` |
| `dist/*.map`, `dist/types/*` (6 files), `src/*.ts` (source shipped) | | |

`@mercuryworkshop/proxy-bootstrap@0.0.5`: `dist/bootstrap-server.js` (Node), `dist/bootstrap-client.js`, `dist/bootstrap-static.js`, and maps/types.

`@mercuryworkshop/scramjet@1.1.0`: `dist/scramjet.all.js` (180 KB), `scramjet.bundle.js` (900 KB), `scramjet.sync.js`, `scramjet.wasm.wasm` (537 KB), `lib/noop.js`, `LICENSE` (**AGPL-3.0 text**), `README.md`.

Brotli-11 sizes of what GNOME serves: scramjet.js 76 KB, scramjet.wasm 156 KB, controller.api.js 5.6 KB, controller.inject.js 2.4 KB, controller.sw.js 1.7 KB, libcurl-transport `dist/index.js` 717 KB (wasm inlined), epoxy-transport `dist/index.js` 603 KB (wasm inlined).

---

## 2. (a) Which version: 2.x alpha through the controller vs 1.1.0

### 2.1 Decision

**Use 2.x through `@mercuryworkshop/scramjet-controller`**, pinned exactly to `scramjet@2.0.67-alpha.2` and `scramjet-controller@0.0.14`. Plan for upgrades to be a deliberate, tested task.

### 2.2 Comparison

| Criterion | 2.0.67-alpha.2 + controller 0.0.14 | 1.1.0 |
|---|---|---|
| Maintenance | Active: `main` HEAD 2026-11-08, 51 commits after the published build, issue templates, CI, the "runway" adversarial suite | **Final v1.** Legacy commit `4669240` adds `console.warn("you are using the last version of scramjet v1, if possible, please upgrade to v2 for better performance and more features")` (VERIFIED in `npm:scramjet@1.1.0/dist/scramjet.all.js`). No commits after 2026-04-27 |
| Stability | Labelled alpha. Several real bugs, listed in §10 and VERIFIED. Published types broken (§4.8). Upstream tracks **214 known-failing runway tests**, 39 of them "escapes-*" (`packages/runway/failing_tests.json`) | Stable API, but frozen with its bugs |
| Modern-site compatibility | VERIFIED working through libcurl and epoxy: example.com, en.wikipedia.org, news.ycombinator.com, github.com (168 requests). DuckDuckGo redirected to its bot page 418 and YouTube rendered an empty body in headless Chromium. Both look like bot or headless detection; the cause is UNVERIFIED | Not tested here. v1 has no further fixes |
| Plugin support | Full hook system (§6) used by Sapphire and scramjet-utils | Only SW-side `request`/`handleResponse` events plus frame `urlchange`/`navigate`/`contextInit` and the controller `download` event |
| Transport | `ProxyTransport` **object** passed to the Controller: libcurl-transport 2.x, epoxy-transport 3.x | bare-mux 2.1.9 `BareMuxConnection.setTransport(path, args)` with **bare-mux transports** (libcurl-transport 1.5.x, epoxy-transport 2.1.x `legacy`). The 2.x/3.x transports use `RawHeaders` and are not bare-mux compatible (`npm:bare-mux@2.1.9/dist/baretypes.d.ts:9-15`) |
| License | `AGPL-3.0-only` (package.json for core, controller, bootstrap, utils). Tarballs ship **no** LICENSE file | package.json says `MIT`, **but the tarball's `LICENSE` is the GNU AGPL v3 text**, and the legacy branch root `LICENSE` is AGPL. The repo has been AGPL since 2024-10-12 (commit `3d1aaf8`, §2.3) |
| Sapphire | Built against 2.x | Incompatible |

### 2.3 License facts (VERIFIED from git history and tarballs)

- `3d1aaf8` (2024-10-12) added a `LICENSE` that reads: *"Scramjet is licensed under AGPL-3 … Your project using scramjet MUST be open source, and must be compatible with GPL. Your project must include clear and prominent credit to the scramjet project, with a link to https://discord.gg/88CapFYSEd. If these terms cannot work for your project, email contact@mercurywork.shop for information on a obtaining a dual license."*
- `9b0e721` and `ef2fe16` (2025-07-04, "fix license") replaced that text with the verbatim AGPL v3.
- `npm:scramjet@1.1.0/LICENSE` is the AGPL v3 text (661 lines). The `"license": "MIT"` field in its `package.json` contradicts it. **Do not rely on the MIT claim.**
- At HEAD there is no `LICENSE` file at the repo root or in `packages/core`, only the `AGPL-3.0-only` fields.
- Transports are AGPL-3.0-only too: libcurl-transport 2.0.6, epoxy-transport 3.0.2 and epoxy-tls 2.1.20-1. Their bundled libcurl.js 0.7.5 is LGPL-3.0-or-later. proxy-transports 1.0.2 is MIT. wisp-js is AGPL-3.0 at 0.4.1 and LGPL-3.0-or-later at 0.5.3.
- **Consequence for GNOME.** Whichever Scramjet version is used, GNOME's distribution must satisfy AGPL-3.0: offer the corresponding source to network users, keep notices, and probably license GNOME's own frontend under an AGPL-compatible license. Otherwise a dual license is needed from Mercury Workshop. This is a project-level legal decision (not legal advice).

### 2.4 What Sapphire targets (CODE: `sapphire/package.json`)

- `devDependencies`: `@mercuryworkshop/scramjet ^2.0.67-alpha.2`, `@mercuryworkshop/scramjet-controller ^0.0.14`, `@mercuryworkshop/libcurl-transport ^2.0.5`, `@mercuryworkshop/wisp-js ^0.5.0`.
- `peerDependencies`: `@mercuryworkshop/scramjet-controller ^0.0.13`. In semver, `^0.0.13` means exactly `0.0.13`, so `0.0.14` does **not** satisfy it (VERIFIED with `semver.satisfies`). Expect a peer-dependency warning or ERESOLVE when installing Sapphire next to 0.0.14. Use `overrides` or `--legacy-peer-deps`.
- Sapphire's harness uses the same URL layout recommended here: `/scramjet/scramjet.js|wasm` and `/controller/controller.{api,inject,sw}.js` (`sapphire/test/harness/server.mjs:37-43`). Its SW combines its own router with the controller's (`sapphire/test/harness/web/public/sw.js`).

---

## 3. How Scramjet 2.x controller mode works

Read this before integrating; most gotchas follow from it.

```
GNOME page (window, origin O)                      Service worker (scope "/")            Wisp server (HolyWisp)
┌──────────────────────────────────┐   MessageChannel  ┌───────────────────────┐
│ Controller (controller.api.js)    │◄────RPC──────────►│ controller.sw.js      │
│  - cookieJar (CookieJar)          │  "request" RPC    │  tabs[] = {prefix,rpc}│
│  - transport (ProxyTransport) ────┼──── wss ──────────┼───────────────────────┼──► TCP to sites
│  - frames[]: Frame                │                   │ shouldRoute(e): path  │
│     - fetchHandler (rewrite HTML/ │                   │   startsWith a prefix │
│       JS/CSS + headers + cookies) │                   │ route(e): RPC to page │
│ <iframe src="O/~/sj/C/F/https%3A…">                   └───────────────────────┘
│   proxied doc: scramjet.js +      │  RemoteTransport (MessagePort via SW → page) for WebSockets
│   scramjet.wasm.js (virtual) +    │  and document.cookie writes
│   controller.inject.js + data: URL│
└──────────────────────────────────┘
```

- **Prefix.** `Controller.prefix = config.prefix + controller.id + "/"` (`packages/controller/src/index.ts:458`). `Frame.prefix = controller.prefix + frame.id + "/"` (`index.ts:785`). Both ids come from `Math.random().toString(36).substring(2,10)` and **change on every page load** (VERIFIED: `/~/sj/5f1mx35j/` became `/~/sj/ubgyvxbb/` after a reload).
- **Proxied URL format** (VERIFIED): `http://localhost:47100/~/sj/n6c03bwz/qagtsxe6/http%3A%2F%2F127.0.0.1%3A47101%2Fpage`, then optional `?$io=…&$dest=…` Scramjet query params, then an encoded hash. Query keys are defined in `core/src/fetch/parse.ts:10-24`: `$rfp`, `$rfs`, `$module`, `$tf`, `$pf`, `$iframe`, `$mode`, `$cred`, `$dest`, `$io`, `$fs`, `$csr`, `$fakedataurl`.
- **SW.** `shouldRoute(event)` returns true iff the path starts with a registered tab prefix (`controller/src/sw.ts:160-164`). `route(event)` RPCs `request` to the owning page and builds a `Response` from the reply. On exception it returns `500 "Internal Service Worker Error: <msg>"` (`sw.ts:166-211`). The SW calls `skipWaiting()` on install and `clients.claim()` on activate (`sw.ts:213-219`). On every (re)start it posts `$controller$swrevive` to all **controlled** clients after 100 ms (`sw.ts:221-231`).
- **Page.** `Controller.methods.request` loads the persisted cookies, serves the virtual wasm script, then runs `frame.fetchHandler.handleFetch(...)` (`controller/src/index.ts:271-354`). **Rewriting of every proxied response happens on the GNOME page's main thread.**
- **Per document injection** (`controller/src/index.ts:659-708`):
  1. `<script src=config.scramjetPath>`.
  2. `<script src=<framePrefix>scramjet.wasm.js>`. The controller generates this as `self.WASM='<base64 of the 586 KB wasm>'` (~782 KB, not HTTP-cacheable, sent per document over the MessagePort; `index.ts:279-304`).
  3. `<script src=config.injectPath>`.
  4. A `data:` script calling `$scramjetController.load({config, sjconfig, prefix, cookies: <full cookieJar.dump()>, codecEncode, codecDecode, …})`. The codec functions are inlined with `Function.prototype.toString()`.
- **Inside the proxied document.** `controller.inject.js` creates a `ScramjetClient` that hooks the DOM APIs, and a `RemoteTransport` connected back to the page's real transport. It finds its `Frame` through `window.frameElement[Symbol.for("controller frame handle")]`, then dispatches `frame.hooks.init.pre` and `frame.hooks.init.post` synchronously (`controller/src/inject.ts:291-364`).
- **WebSockets do not go through the SW.** Page WebSockets go `client.bare.createWebSocket` → RemoteTransport → controller → `transport.connect()` (`core/src/client/shared/requests/websocket.ts:66`, `controller/src/index.ts:377-431`). **Fetch hooks never see WebSockets** (§6.6).

---

## 4. (b) Integration guide for the recommended version

### 4.1 npm packages (exact pins)

```jsonc
// package.json (frontend)
"dependencies": {
  "@mercuryworkshop/scramjet": "2.0.67-alpha.2",          // MUST be explicit (see below)
  "@mercuryworkshop/scramjet-controller": "0.0.14",
  "@mercuryworkshop/libcurl-transport": "2.0.6",
  "@mercuryworkshop/epoxy-transport": "3.0.2",            // optional second transport
  "@mercuryworkshop/proxy-transports": "1.0.2",           // types + BareResponse (MIT)
  "domhandler": "5.0.3"                                   // only if you build DOM nodes in html.* hooks (§5.3, §6.2)
  // optional: "@mercuryworkshop/scramjet-utils": "0.0.3" (see §11.3 caveat)
}
```

- **The pin on `@mercuryworkshop/scramjet` is mandatory.** The controller declares `peerDependencies: {"@mercuryworkshop/scramjet": "*"}`, and semver `*` does **not** match prereleases. `npm install @mercuryworkshop/scramjet-controller@0.0.14` alone therefore auto-installs the peer **`@mercuryworkshop/scramjet@1.1.0`** (VERIFIED with `npm install --dry-run`). The controller then fails at runtime: `assertRuntimeScramjetVersion()` requires `$scramjet.versionInfo.version === "2.0.67-alpha.2"` exactly (`npm:scramjet-controller@0.0.14/src/version.ts`; message *"@mercuryworkshop/scramjet version mismatch: this build expects 2.0.67-alpha.2, but the loaded runtime is …"*).
- Plain `npm i @mercuryworkshop/scramjet` installs **1.1.0** (`latest` tag). Always name the version.

### 4.2 Files and URL paths to serve (GNOME/Axum static routes)

Use the controller defaults (`controller/src/index.ts:46-64`). The demo (`packages/demo/vite.config.ts`) and Sapphire use the same layout, so no path config is needed:

| URL path | Source file | Content-Type | Notes |
|---|---|---|---|
| `/scramjet/scramjet.js` | `@mercuryworkshop/scramjet/dist/scramjet.js` | `text/javascript` | Loaded by the GNOME page **and by every proxied document** (`config.scramjetPath`) |
| `/scramjet/scramjet.wasm` | `@mercuryworkshop/scramjet/dist/scramjet.wasm` | `application/wasm` | Fetched once per Controller (`config.wasmPath`, `index.ts:254-262`), then base64'd into the per-document virtual script |
| `/controller/controller.api.js` | `@mercuryworkshop/scramjet-controller/dist/controller.api.js` | `text/javascript` | Classic `<script>`, **after** scramjet.js |
| `/controller/controller.inject.js` | `…/dist/controller.inject.js` | `text/javascript` | Loaded in every proxied document (`config.injectPath`) |
| `/controller/controller.sw.js` | `…/dist/controller.sw.js` | `text/javascript` | `importScripts`ed by GNOME's SW |
| `/sw.js` | GNOME's own file (§4.3) | `text/javascript` | Serve with `Cache-Control: no-cache`. Root path so the default scope is `/` |
| transport | `@mercuryworkshop/libcurl-transport/dist/index.mjs` (ESM, default and named `LibcurlClient`) or `dist/index.js` (UMD, global `LibcurlTransport.LibcurlClient`); `@mercuryworkshop/epoxy-transport/dist/index.mjs` (ESM **default export only**) or `dist/index.js` (UMD, global `EpoxyTransport.default`) | `text/javascript` | Only the GNOME page needs these. Proxied pages and the SW never load them. Can be bundled by Vite |
| `/scramjet/*.map`, `/controller/*.map` | same dirs | `application/json` | Optional |
| Wisp endpoint | `/wisp/` (WebSocket upgrade) | n/a | Axum forwards to HolyWisp. Client URLs **must end with `/`** (§7) |

Server rules:
- **Never answer `/~/sj/*` with the SPA `index.html` fallback.** When the SW does not intercept (after a restart, §10.3), these requests reach the backend (VERIFIED: the server received `/~/sj/rkgsg8jw/dbwf54i0/http%3A%2F%2F127.0.0.1%3A47101%2Fecho%3Fafter%3Dstop`). Return a small `503` page, ideally with an auto-retry.
- Caching: if you add versioned paths (e.g. `/vendor/sj-2.0.67-alpha.2/scramjet.js`), set `config.scramjetPath`, `injectPath` and `wasmPath` (and the `importScripts` URL) accordingly, then use `Cache-Control: public, max-age=31536000, immutable`. Otherwise use `no-cache` with ETags.
- **No COOP/COEP is required** (VERIFIED: `crossOriginIsolated:false` works). For optional cross-origin isolation, see §10.1.

### 4.3 Service worker

`controller.sw.js` is an IIFE that sets `var $scramjetController`. It **must be loaded with `importScripts` in a classic SW**: `register("/sw.js", { type: "classic" })`, which is the default. In a module SW the `var` would be module-scoped, so the global would not exist. The fetch handler must hand prefix URLs to `route()`.

Minimal SW, the official pattern (`packages/demo/public/sw.js`, `packages/bootstrap/src/server.ts:48-56`):

```js
importScripts("/controller/controller.sw.js");
addEventListener("fetch", (e) => {
  if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e));
});
```

**Recommended hardened SW for GNOME (VERIFIED).** It fixes the restart race in §10.3: with the minimal SW, the first request after a restart reached the server. With this one, the request was held about 211 ms and then served correctly.

```js
importScripts("/controller/controller.sw.js");
// importScripts("/uv/uv.bundle.js", "/uv/uv.config.js", "/uv/uv.sw.js");  // UV fallback lives in the SAME SW (one SW per scope)
const SJ_PREFIX = "/~/sj/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(SJ_PREFIX)) return; // GNOME/UV routes elsewhere
  e.respondWith((async () => {
    // After a SW restart, tabs[] is empty until the page re-sends its MessagePort ($controller$swrevive)
    for (let i = 0; i < 50 && !$scramjetController.shouldRoute(e); i++) await sleep(100);
    if ($scramjetController.shouldRoute(e)) return $scramjetController.route(e);
    return new Response("Proxy engine not available. Reload the tab.", { status: 503, headers: { "content-type": "text/plain" } });
  })());
});
```

SW rules:
- **Scope must include the GNOME page**, so register `/sw.js` with scope `/`. The SW reaches pages with `clients.matchAll()`, which by spec includes only **controlled** clients (`sw.ts:53`, `sw.ts:225`). An uncontrolled shell would never receive `$controller$swrevive`, so it could not recover after an SW restart. This follows from the spec; a narrow-scope variant was not tested.
- There is only one SW per scope. Ultraviolet's SW code, Sapphire's router (`/~/sx/`) and any GNOME offline caching must be combined into this one script, routed by prefix as Sapphire does.
- `controller.sw.js` already registers `install` (`skipWaiting`), `activate` (`clients.claim()`) and `message` listeners. The SW needs nothing from scramjet.js.
- Register with `updateViaCache: "none"` (as bootstrap does, `bootstrap/src/clientcommon.ts:2-5`).

### 4.4 Page bootstrap and Controller initialization

Load order is enforced by globals. If `controller.api.js` runs before `scramjet.js`, it throws `TypeError: Cannot destructure property 'BareResponse' of 'globalThis.$scramjet' as it is undefined.` and `$scramjetController` stays undefined (VERIFIED).

```html
<!-- GNOME index.html <head>, before the Svelte/Vite module entry -->
<script src="/scramjet/scramjet.js"></script>
<script src="/controller/controller.api.js"></script>
```

After this, `import { Controller, ManagedPlugin } from "@mercuryworkshop/scramjet-controller"` and `import { ScramjetHeaders, rewriteUrl, unrewriteUrl } from "@mercuryworkshop/scramjet"` in TS work: they resolve to the external stubs that read the globals. This is CODE, and it is how the demo does it in `packages/demo/src/index.tsx:3-6`. Using the globals directly also works (VERIFIED in the harness).

```ts
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import { Controller } from "@mercuryworkshop/scramjet-controller";

async function startScramjet(): Promise<Controller> {
  if (!window.isSecureContext || !("serviceWorker" in navigator))
    throw new Error("Scramjet needs a secure context (HTTPS or localhost)");   // VERIFIED: on http://gnome.test, navigator.serviceWorker is undefined
  const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  await navigator.serviceWorker.ready;
  const sw = reg.active ?? navigator.serviceWorker.controller!;

  // Validate the rewriter wasm yourself: the controller does NOT (a 404 still "inits" fine, see §8.2)
  const head = new Uint8Array(await (await fetch("/scramjet/scramjet.wasm", { cache: "force-cache" })).arrayBuffer()).slice(0, 4);
  if (head.join() !== "0,97,115,109") throw new Error("scramjet.wasm missing or corrupt");

  const wisp = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/wisp/`;   // trailing slash REQUIRED
  const transport = new LibcurlClient({ wisp });
  await transport.init();          // pre-init: concurrent lazy init() calls can hang (§7.4)

  const controller = new Controller({
    serviceworker: sw,
    transport,
    // config: { prefix: "/~/sj/" },  (defaults shown in the table below)
    scramjetConfig: { flags: { allowFailedIntercepts: true } },   // see the note on the deepMerge bug below
  });
  await withTimeout(controller.wait(), 10_000, "Scramjet controller did not become ready");  // wait() can hang forever (§8.2)
  return controller;
}
const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
```

`new Controller(init: ControllerInit)` (`controller/src/index.ts:203-208`, `449-523`):

| `ControllerInit` key | Type | Required | Meaning |
|---|---|---|---|
| `serviceworker` | `ServiceWorker` | yes | The worker to postMessage `$controller$init` to (`setupMessagePort`, `index.ts:525-550`) |
| `transport` | `ProxyTransport` | yes | Network transport (§7) |
| `config` | `Partial<Config>` | no | Deep-merged over the module default `config` (`index.ts:452`). The exported `config` object can also be mutated before construction, as bootstrap does (`bootstrap/src/client.ts:35-39`) |
| `scramjetConfig` | `Partial<ScramjetConfig>` | no | Deep-merged over the core defaults (`index.ts:453-457`) |

`Config` (`controller/src/index.ts:37-64`):

| Key | Default | Notes |
|---|---|---|
| `prefix` | `"/~/sj/"` | URL space. Must lie inside the SW scope. VERIFIED working with `"/p/"` |
| `scramjetPath` | `"/scramjet/scramjet.js"` | Injected into proxied docs as a classic script, so it must be the IIFE |
| `injectPath` | `"/controller/controller.inject.js"` | Injected into proxied docs |
| `wasmPath` | `"/scramjet/scramjet.wasm"` | Fetched by the Controller |
| `virtualWasmPath` | `"scramjet.wasm.js"` | Path under each frame prefix that the controller answers with `self.WASM='…'` |
| `codec` | `{encode: (url) => url ? encodeURIComponent(url) : url, decode: (url) => url ? decodeURIComponent(url) : url}` | **Must be self-contained functions with no closures or imports.** They are serialized with `.toString()` into every proxied page and worker (`index.ts:698-699`, `755-756`). The encoded hash is also passed through the codec. VERIFIED: a base64url codec produced `…/p/<c>/<f>/aHR0cDovLzEyNy4wLjAuMTo0NzEwMS9wYWdlP3g9MQ#ZnJhZw` and worked |

`ScramjetConfig` (`core/src/types.ts:33-51`; defaults in `core/src/index.ts:19-50`; `defaultConfigDev` at `index.ts:53-64`):

| Key | Default | Notes |
|---|---|---|
| `globals.*` | `wrapfn:"$scramjet$wrap"`, `wrappropertybase:"$scramjet__"`, `wrappropertyfn:"$scramjet$prop"`, `cleanrestfn:"$scramjet$clean"`, `importfn:"$scramjet$import"`, `rewritefn:"$scramjet$rewrite"`, `metafn:"$scramjet$meta"`, `wrappostmessagefn:"$scramjet$wrappostmessage"`, `pushsourcemapfn:"$scramjet$pushsourcemap"`, `trysetfn:"$scramjet$tryset"`, `templocid:"$scramjet$temploc"`, `tempunusedid:"$scramjet$tempunused"` | Names of the globals that rewritten code calls. Leave them alone |
| `flags.syncxhr` | false | Sync XHR emulation (SharedArrayBuffer spin). **Broken:** sync XHR throws `e.getFlag is not a function` regardless (VERIFIED, `core/src/client/shared/requests/xmlhttprequest.ts:33`) |
| `flags.disableComputedWrap` | false | Rewriter option (`rewriter/wasm/src/lib.rs:74`) |
| `flags.rewriterLogs` | false | Timing and parse-error logs |
| `flags.captureErrors` | false (dev: true) | Rewriter `capture_errors` + `client/shared/err.ts` |
| `flags.cleanErrors` | false | Traps `Error.prepareStackTrace` to strip proxy URLs from stacks (`client/shared/error.ts`) |
| `flags.scramitize` | false | Rewriter debug option |
| `flags.sourcemaps` | true | Keeps the original source so `Function.prototype.toString` looks native (`shared/rewriters/js.ts:117`) |
| `flags.destructureRewrites` | true | Rewriter option |
| `flags.allowInvalidJs` | true (dev: false) | **If rewriting throws, the original, unrewritten JS is served and executed** (`core/src/shared/rewriters/js.ts:145-156`). This favours compatibility over safety (§10) |
| `flags.allowFailedIntercepts` | **false** | When true (and `debugTrampolines` is false) it enables the fast path in every API proxy, skipping the `Error.prepareStackTrace` dance (`client/client.ts:742-753`). The controller *intends* `true` (`controller/src/index.ts:66-72`) but merges in the wrong order: `deepMerge(scramjetConfig, scramjetDefaultConfig)` at `index.ts:453` lets the defaults override it. VERIFIED: the resulting `controller.scramjetConfig.flags.allowFailedIntercepts === false`. **Set it explicitly** |
| `flags.debugTrampolines` | false (dev: true) | Debug wrappers |
| `flags.encapsulateWorkers` | true | Worker code is wrapped in a data: script (`shared/rewriters/worker.ts:29`) |
| `flags.debugSourceURL` | false (dev: true) | Appends `//# sourceURL=` to rewritten scripts |
| `siteFlags` | `{}` | `Record<regexString, Partial<flags>>`. The first regex matching `url.href` that contains the flag wins (`shared/index.ts:15-28`) |
| `maskedfiles` | `[]` | Script names stripped from stack traces (cleanErrors). The controller's `["inject.js","scramjet.wasm.js"]` is merged in |

Other Controller members:
- `controller.wait(): Promise<void>` (`index.ts:642`) resolves when the SW has sent `ready`, the wasm has been fetched and the cookies have loaded. **Always await it before `frame.go()`.**
  - `controller.isReady` is declared but **never set to true** (`index.ts:226`).
  - The `createFrame` guard `if (!this.ready)` tests a Promise, so it never fires (`index.ts:631`).
  - If you navigate before the SW knows the controller's prefix, the request falls through to the network (CODE, same mechanism as §10.3 item 1).
- `controller.createFrame(el?, {plugins?})` (`index.ts:630`).
- `controller.setTransport(t)` (`index.ts:622`).
- `controller.cookieJar` (§9), `controller.persistCookies()` (`index.ts:606`), `controller.propagateCookieSync(entries, {clear?})` (`index.ts:569`).
- `controller.frames: Frame[]`. There is **no removal API**: remove closed tabs yourself with `controller.frames.splice(i,1)`.
- `controller.prefix`, `controller.config`, `controller.scramjetConfig`. Flags can be changed live, as the demo does with `Object.assign(controller.scramjetConfig.flags, …)`; changes apply to newly loaded documents.

### 4.5 Frames: create, navigate, back, forward, reload

```ts
const iframe = document.createElement("iframe");          // no sandbox attribute (inject.ts needs same-origin access)
tabsContainer.append(iframe);
const frame = controller.createFrame(iframe, { plugins: [/* ManagedPlugin instances */] });
frame.go("https://example.com/");                          // absolute http(s) URL only
```

`Frame` (`controller/src/index.ts:710-862`):

| Member | Behavior |
|---|---|
| `frame.go(url: string): void` | `iframe.src = rewriteUrl(url, frame.context, {origin: location, base: location})` (`index.ts:853-861`). Synchronous. **Pass an absolute `https://`/`http://` URL.** A relative string such as a search term resolves against the GNOME origin, and parseRequest then rejects it with *"attempted to fetch from same origin"* (`core/src/fetch/parse.ts:73-78`). Search-term to URL conversion is GNOME's job |
| `frame.back()` / `frame.forward()` | `iframe.contentWindow.history.back()` / `.forward()`. This uses the **joint session history of the whole GNOME tab** (VERIFIED, see below) |
| `frame.reload()` | `contentWindow.location.reload()` (VERIFIED) |
| `frame.element`, `frame.id`, `frame.prefix`, `frame.controller`, `frame.plugins`, `frame.getPlugin(name)` (throws if missing), `frame.fetchHandler` (ScramjetFetchHandler), `frame.context` (getter building a ScramjetContext), `frame.hooks` (§6) | |

**History gotcha (VERIFIED).** With two proxied iframes A and B in one GNOME page, calling `frame.back()` on A behaved as follows:
- Chromium: A went back while B was untouched, but a second `back()` (A had no earlier entry) **navigated the GNOME shell itself**, destroying the page.
- Firefox: one `back()` on A also took B back: B's Scramjet client disappeared, i.e. B returned to its initial `about:blank`.

GNOME must therefore keep its own per-tab history state, from `init.post`, `lifecycle.navigate` and `popstate`, and enable Back only when the tab really has an entry. It should also protect the shell, for example with a guard `history.pushState` entry plus a top-level `popstate` handler. Do not call `frame.back()` blindly.

Other frame facts:
- inject.ts sets `window.name = iframe.name = <random 8 chars>` when the iframe has no name (`inject.ts:292-295`). Set your own `name` attribute if you need a stable one.
- The first navigation of a fresh iframe replaces its initial entry. Later `go()` calls add joint-history entries.

### 4.6 Reading and observing URL, title, favicon and load (all VERIFIED)

- **Current URL** (decoded), from the GNOME realm:
  - `iframe.contentWindow[Symbol.for("scramjet client global")].url.href`. The symbol is exported as `$scramjet.SCRAMJETCLIENT`.
  - Or `unrewriteUrl(iframe.contentWindow.location.href, frame.context)`. The `$scramjet.unrewriteUrl(url, context)` export strips Scramjet's query params.
  - Both returned `http://127.0.0.1:47101/page` for `/~/sj/…/http%3A%2F%2F127.0.0.1%3A47101%2Fpage`.
- **Change notification:**
  - `frame.hooks.init.post` fires for every new document, with `{window, client, isTopLevel}`. `isTopLevel` is true for the frame's own document and false for nested proxied iframes.
  - `ctx.client.hooks.lifecycle.navigate` fires for same-document URL changes: `{type:"history"|"location"|"hashchange"}`, `{url}`. Dispatch sites: `core/src/client/dom/history.ts:23` (pushState/replaceState), `core/src/client/location.ts:62` (hash set), `:101` (assign), `:124` (replace), and `core/src/client/client.ts:576` (`location.href` set).
  - **`history.back()` or `popstate` inside the page fires nothing** (VERIFIED). Add a `popstate` listener on `ctx.window`. `scramjet-utils`' `UrlWatcherPlugin` (`packages/utils/src/url-watcher.ts:20-34`) only adds `hashchange`, so it misses popstate.
- **Title.** `iframe.contentDocument.title` is not trapped, so it is the real title. Observe with a `MutationObserver` created in `init.post`. VERIFIED: it picked up the dynamic change `"Origin Test Page"` → `"Origin Test Page (done)"`.
- **Favicon.** Take `doc.querySelector('link[rel~="icon"]')`:
  - Its `.href`, read through the proxied realm getter, is the **original** URL (e.g. `https://en.wikipedia.org/static/favicon/wikipedia.ico`).
  - `Element.prototype.getAttribute.call(link, "href")`, using the **GNOME realm's** unhooked function, returns the **proxied** URL (e.g. `http://localhost:47100/~/sj/<c>/<f>/https%3A%2F%2Fen.wikipedia.org%2Fstatic%2Ffavicon%2Fwikipedia.ico?%24io=…`). It can be used directly as `<img src>` in the GNOME UI while the frame exists, because the SW routes any client's request under the frame prefix.
  - The original value is also kept in the `scramjet-attr-href` attribute.
  - With no `<link rel=icon>`, compute `/favicon.ico` yourself: `rewriteUrl(new URL("/favicon.ico", pageUrl).href, frame.context, {origin: new URL(location.href), base: new URL(location.href)})`.
- **Load.** Use `ctx.window.addEventListener("load", …)` inside `init.post` (VERIFIED), or the `<iframe>` element's `load` event.

```ts
class TabObserver extends ManagedPlugin {
  constructor(private tab: { onUrl(u: string): void; onTitle(t: string): void; onIcon(src: string | null): void; onLoad(): void }) { super("gnome-tab-observer", []); }
  install(frame: Frame) {
    super.install(frame);
    this.tap(frame.hooks.init.post, (ctx: any) => {
      if (!ctx.isTopLevel) return;
      const w = ctx.window as Window, doc = w.document, url = () => ctx.client.url.href;
      this.tab.onUrl(url());
      this.tap(ctx.client.hooks.lifecycle.navigate, (_c: any, p: any) => this.tab.onUrl(p.url));
      w.addEventListener("popstate", () => this.tab.onUrl(url()));      // not covered by lifecycle.navigate
      w.addEventListener("hashchange", () => this.tab.onUrl(url()));
      new (w as any).MutationObserver(() => this.tab.onTitle(doc.title)).observe(doc, { subtree: true, childList: true, characterData: true });
      const icon = () => { const l = doc.querySelector('link[rel~="icon"]'); this.tab.onIcon(l ? Element.prototype.getAttribute.call(l, "href") : null); };
      w.addEventListener("DOMContentLoaded", icon);
      w.addEventListener("load", () => { icon(); this.tab.onLoad(); });
    });
  }
}
```

### 4.7 Events: what exists

There are **no DOM-style events** in 2.x. `Frame` and `Controller` are not `EventTarget`s, and `ScramjetFetchHandler extends EventTarget` but never dispatches anything (VERIFIED by grep of core/fetch, controller and utils). Map GNOME's needs to hooks:

| GNOME needs | Use |
|---|---|
| navigate (new document) | `frame.hooks.init.pre` / `init.post` (`inject.ts:360`, `:363`), or `fetch.request` with `ctx.parsed.destination` `iframe`/`document` and `!ctx.parsed.isIframe` (before the network) |
| urlchange | `init.post` + `client.hooks.lifecycle.navigate` + `popstate` + `hashchange` (§4.6) |
| load | `ctx.window` `load` event inside `init.post`, or the iframe `load` event |
| title / favicon | MutationObserver and `link[rel~=icon]` (§4.6) |
| download | `frame.hooks.fetch.response` with a `content-disposition: attachment` header (§10, "Downloads") |
| error | `frame.hooks.error.request` (§8) |
| new window / popup | No hook (CODE). `window.open` and `target=_blank` produce top-level documents with `destination:"document"`. Their URLs are under the frame prefix, so they still route through the same Frame's fetch hooks. However, **`init.*` hooks do not run in popups**: inject.ts finds the Frame only through the `frameElement` chain (`inject.ts:296-317`). `CatchEscapedLinksPlugin` (utils) bounces them to the shell (§11.3) |

v1 had `frame.addEventListener("urlchange"|"navigate"|"contextInit")` and `controller.addEventListener("download")` (`npm:scramjet@1.1.0/dist/types/client/events.d.ts`). These are gone in 2.x.

### 4.8 TypeScript notes (VERIFIED with `tsc 5.9.3`, `moduleResolution: bundler`)

- With `skipLibCheck: false` the published declarations produce dozens of errors (81 lines of tsc output):
  - scramjet's d.ts still contains unresolved path aliases (`@/…`, `@client/…`, `@rewriters/…`).
  - `dist/types/fetch/*` is not re-exported from `index.d.ts`, so **`FetchHooks`, `ScramjetFetchHandler` and `CookieSyncOptions` are not exported**.
  - The controller d.ts imports `@mercuryworkshop/rpc` (not on npm) and `./types` (not shipped).
- With `skipLibCheck: true` the only consumer error is the missing `FetchHooks` export. However, `frame.hooks.fetch`, `hooks.init` and `hooks.error` callback parameters are effectively **`any`**: assigning `ctx.window` to a `number` compiles.
- **Action:** set `skipLibCheck: true` and keep a local `src/lib/scramjet-types.ts` that mirrors `FetchHooks` (`core/src/fetch/index.ts:157-197`), `FrameInitHooks` / `FrameErrorHooks` (`controller/src/types.d.ts:104-134`) and `HtmlRewriterHooks` (`core/src/shared/index.ts:59-79`).
- libcurl-transport and epoxy-transport types resolve correctly through normal node_modules resolution.

---

## 5. Hooks API reference (CODE + VERIFIED usage)

### 5.1 Plugin machinery

- `class Plugin { constructor(name: string, tapOrder: {before?: string[]; after?: string[]} = {}); tap(hook, callback, order?) }` (`core/src/Tap.ts:98-111`).
- `class ManagedPlugin extends Plugin { frame: Frame; dependencies: string[]; constructor(name, dependencies: string[]); install(frame: Frame): void }` (`controller/src/index.ts:79-90`). Pass instances in `createFrame(el, {plugins:[…]})`. At frame construction each plugin's `dependencies` must name another plugin in the list, or the constructor throws *"Dependency X not found for plugin Y"*. Then `install(frame)` is called in array order (`index.ts:817-830`).
- `Tap.dispatch(hook, ctx, props)` (`Tap.ts:114-127`):
  - Callbacks are sorted by `before`/`after` and **all invoked immediately**: `callbacks.map(cb => cb.callback(ctx, props))`, then `Promise.all`. **Async callbacks run concurrently, not sequentially.** Ordering only decides who runs first up to its first `await`.
  - A synchronous throw, or a rejection on awaited hooks, fails the whole request. Wrap plugin bodies in try/catch, as Sapphire does (`sapphire/src/SapphirePlugin.ts:35-71`).
  - Fetch hooks are `await`ed (`core/src/fetch/fetch.ts:42`, `:173`, `:200`, `:225`). Init hooks (`inject.ts:360-363`), HTML rewriter hooks (`shared/rewriters/html.ts:172`, `:267`) and lifecycle hooks are **not awaited**, so their callbacks must be synchronous.
- `Tap.tap(hook, cb, plugin?, order?)` and `Tap.create()` are public (`Tap.ts:129-160`), and `$scramjet.Tap` exposes them.

### 5.2 Every hook point

| Hook | Where dispatched | Context | Props (mutable) | Use |
|---|---|---|---|---|
| `frame.hooks.fetch.intercept` | `core/src/fetch/fetch.ts:37-49`. First step for every proxied request except blob:/data: | `{request: ScramjetFetchRequest, parsed: ScramjetFetchParsed}` | `{response?: ScramjetFetchResponse}`. If set, it is **returned as-is**, with no header or body rewriting and no cookie handling. `Location` must already be a proxied URL | Short-circuit before any network or rewriting. CatchEscapedLinks uses it (`utils/src/catch-escaped-links.ts:16-26`) |
| `frame.hooks.fetch.request` | `fetch.ts:191-214`, after `rewriteRequestHeaders` (`fetch.ts:65`) and just before `client.fetch` | `{request, parsed, client: BareCompatibleClient}` | `{url: URL; init: BareRequestInit {body, headers: RawHeaders, method, redirect:"manual"}; earlyResponse?: BareResponse \| Response}`. `earlyResponse` skips the network but still goes through cookies, header rewriting and body rewriting (`fetch.ts:203-214`) | Ad blocking, header changes, URL changes, cache. VERIFIED |
| `frame.hooks.fetch.preresponse` | `fetch.ts:216-231`, right after the network call | `{request, parsed}` | `{response: BareResponse}` (`rawHeaders` editable; can be replaced). Runs **before** Set-Cookie handling and header/body rewriting | Edit or strip upstream headers (Set-Cookie, Content-Disposition), cache storage. VERIFIED |
| `frame.hooks.fetch.response` | `fetch.ts:160-175`, last step | `{request, parsed}` | `{response: {body: string\|ArrayBuffer\|Blob\|ReadableStream\|undefined, headers: ScramjetHeaders, status, statusText}}`. For HTML documents `body` is a **string** of rewritten HTML (VERIFIED `[object String]`); other bodies are usually `ReadableStream` | Final header injection (VERIFIED `X-Gnome:1` visible to page `fetch`), body edits, download detection |
| `frame.hooks.init.pre` | `controller/src/inject.ts:359-360`, in the proxied realm before `client.hook()` | `{window, client: ScramjetClient, isTopLevel}` | `{}` | Earliest per-document code |
| `frame.hooks.init.post` | `inject.ts:362-363`, after hooking. `document.readyState === "loading"` and `document.head` exists (VERIFIED) | same | `{}` | CSS injection, observers, `client.hooks.*` taps. VERIFIED |
| `frame.hooks.error.request` | `controller/src/index.ts:336-353`, when `handleFetch` throws | `{rawrequest: TransferRequest, error: unknown}` | `{setResponse?: TransferResponse {body, headers: RawHeaders, status, statusText}; suppressError?: boolean}` | Custom error page or UV fallback trigger. VERIFIED |
| `frame.fetchHandler.hooks.rewriter.html.pre` | `core/src/shared/rewriters/html.ts:172-181`. Every SW/controller-side HTML rewrite, after parsing and before URL rewriting | `{handler: DomHandler, meta: URLMeta, origHtml: string, htmlcontext: HtmlContext}` | none | Inspect or modify the parsed DOM (htmlparser2/domhandler tree) before rewriting |
| `frame.fetchHandler.hooks.rewriter.html.post` | `html.ts:266-280`, after rewriting and inject-script insertion | same | `{setRawHtml?: string}` replaces the whole serialized output | Cosmetic `<style>` injection, element removal. VERIFIED |
| `client.hooks.rewriter.html.pre/post` (per document; tap inside `init.post`) | Same functions, reached from client-side rewrites such as `innerHTML`, `document.write` and `DOMParser` (`core/src/client/client.ts:228-233`, `263-265`). `htmlcontext.apisource` names the API | same | same | Cosmetic filtering of dynamically inserted HTML |
| `client.hooks.lifecycle.navigate` (per document) | Dispatch sites listed in §4.6 | `{type:"location"\|"history"\|"hashchange"}` | `{url: string}` (informational) | URL bar updates. VERIFIED |

Key fields (`core/src/fetch/index.ts:16-66`):
- `request.{rawUrl, rawReferrer, rawDestination, mode, referrer, method, body, cache, initialHeaders: ScramjetHeaders, rawClientUrl?, clientId}`.
- `parsed.{url (unproxied target URL), clientUrl? (unproxied URL of the requesting document; null for the frame's top navigation), referrerSourceUrl, destination (request.destination, overridden by $dest), isIframe (true only for proxied sub-iframes), isModule, meta, referrerPolicy, fetchSiteState, fetchInitiatorOrigin, fetchCredentialsInclude, fetchMode, crossSiteRedirect, trackedClient}`.
- VERIFIED values:
  - Top navigation of the GNOME iframe: `destination:"iframe"`, `isIframe:false`, `clientUrl:null`, `rawReferrer:"http://localhost:47100/"`.
  - Subresources: `destination:"script"|"image"|""(fetch)`, `clientUrl:"http://127.0.0.1:47101/page"`, and a computed `referer` header.

What Scramjet already does to headers, before and after the hooks (`core/src/fetch/headers.ts`):
- **Request** (`:119-168`):
  - Drops the browser's `Referer` and recomputes `Origin`/`Referer` from the unproxied initiator, honouring the referrer policy (`createReferrerString`, `core/src/fetch/util.ts:26-81`).
  - Sets `Cookie` from the jar with SameSite emulation (`:154-163`).
  - Recomputes `Sec-Fetch-Site/Mode/Dest/User` and `Sec-Fetch-Storage-Access` for https and loopback targets (`:183-267`).
  - `User-Agent`, `sec-ch-ua*` and `Accept*` are forwarded from the real browser (VERIFIED in the echo output).
- **Response** (`:61-117`):
  - **Deletes** `cross-origin-embedder-policy`, `cross-origin-opener-policy`, `cross-origin-resource-policy`, `content-security-policy(-report-only)`, `expect-ct`, `feature-policy`, `origin-isolation`, `strict-transport-security`, `upgrade-insecure-requests`, `x-content-type-options`, `x-download-options`, `x-frame-options`, `x-permitted-cross-domain-policies`, `x-powered-by`, `x-xss-protection`, `clear-site-data` (`:20-40`), plus `permissions-policy` and `set-cookie`.
  - Rewrites `location`, `content-location`, `referer` and `link` (`:45-85`).
  - Forces `Referrer-Policy: unsafe-url` on documents (`:112-114`).
  - Adds COEP/COOP when `crossOriginIsolated` (`:97-110`).
  - `Content-Disposition` is **left untouched**.

### 5.3 Two copies of domhandler are fine

`html.*` hooks receive Scramjet's internal domhandler tree. The `Element`/`Text` constructors are not exported by scramjet, so import `domhandler@5` yourself. VERIFIED: nodes from a separate copy (`new Element("style",{…},[new Text(css)])`, with `parent` set and pushed into `head.children`) serialized correctly. dom-serializer works by node `type`, not `instanceof`.

---

## 6. (d) Recipes for GNOME features (all VERIFIED unless noted)

### 6.1 Ad blocker: block by URL, type and initiator

```ts
class AdBlock extends ManagedPlugin {
  constructor(private engine: { match(req: { url: string; type: string; initiator: string | null; isThirdParty: boolean }): boolean }) {
    super("gnome-adblock", []);
  }
  install(frame: Frame) {
    super.install(frame);
    this.tap(frame.hooks.fetch.request, (ctx: any, props: any) => {
      try {
        const url: URL = props.url;
        const dest: string = ctx.parsed.destination;          // "", "script", "image", "style", "font", "iframe", "document", ...
        const type = dest === "iframe" || dest === "document" ? (ctx.parsed.isIframe ? "sub_frame" : "main_frame")
          : dest === "" ? "xmlhttprequest" : dest === "style" ? "stylesheet" : dest;  // Sapphire's mapping: sapphire/src/network.ts:41-79
        const initiator = ctx.parsed.clientUrl?.href ?? null;  // unproxied page URL, null for top navigation
        if (this.engine.match({ url: url.href, type, initiator, isThirdParty: !!initiator && new URL(initiator).hostname !== url.hostname })) {
          props.earlyResponse = type === "main_frame" || type === "sub_frame"
            ? new Response("<!doctype html><title>Blocked</title><h1>Blocked by GNOME</h1>", { status: 200, headers: { "content-type": "text/html" } })
            : new Response(null, { status: 204, statusText: "Blocked" });   // VERIFIED: blocked script/img never reached origin
        }
      } catch (e) { console.error("[adblock]", e); }
    }, { before: ["scramjet-http-cache"] });   // run before HttpCachePlugin's async cache lookup
  }
}
```

- VERIFIED: `/ads/tracker.js` and `/ads/banner.png` were blocked, the origin's hit log shows they were never requested, and `window.__trackerLoaded` stayed false. This held in Chromium and Firefox.
- Sapphire's full DNR/webRequest implementation on the same hooks is a good reference: `sapphire/src/network.ts:190-333`.
- WebSockets need a transport wrapper; see §6.6.

### 6.2 Cosmetic CSS injection

Two VERIFIED options. Use both when you want CSS to win early and also to cover dynamic HTML.
- **Per document at runtime.** In `init.post`, call `ctx.window.document.createElement("style")`, set `.textContent = css` and append it to `document.head`. VERIFIED: `.ad-banner` computed `display: none`.
- **In the served HTML.** In `frame.fetchHandler.hooks.rewriter.html.post`, if `ctx.htmlcontext.loadScripts` is true, find the `head` node in `ctx.handler.root` and push `new Element("style", {"data-gnome":"1"}, [new Text(css)])` with `style.parent = head`. VERIFIED: `outline` was applied. Alternatively, string-edit `props.response.body` in `fetch.response` when `ctx.parsed.destination` is `iframe` or `document` (the body is a string there).
- **Dynamic HTML.** Tap `ctx.client.hooks.rewriter.html.post` inside `init.post` (CODE).

### 6.3 Privacy: strip tracking params, add Sec-GPC, control the referrer

- **Strip params on documents (VERIFIED)** by redirecting before the network call:
  ```ts
  this.tap(frame.hooks.fetch.request, (ctx: any, props: any) => {
    const u = new URL(props.url.href), before = u.search;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_eid$)/.test(k)) u.searchParams.delete(k);
    if (u.search === before) return;
    const d = ctx.parsed.destination;
    if (d === "document" || d === "iframe") props.earlyResponse = new Response(null, { status: 307, headers: { location: u.href } }); // Location is auto-rewritten
    else props.url = u;   // subresources: just fetch the clean URL
  });
  ```
  VERIFIED: the frame lands on `…/echo-page?id=9` and the origin is hit once, with the clean URL.
  - Do not only replace `props.url` for documents. The page keeps thinking its URL has the params, so they leak into later `Referer` headers (VERIFIED: `referer: …?utm_source=news&utm_medium=x&id=5`).
  - Never mutate `props.url` in place. It is the same object as `ctx.parsed.url`, which also feeds cookies and the rewrite base.
  - An `intercept`-based 307 also works but needs a pre-rewritten `Location`: `rewriteUrl(clean, frame.context, {origin:new URL(location.href), base:new URL(location.href)})`.
- **Sec-GPC (VERIFIED):** `props.init.headers.push(["Sec-GPC","1"])` in `fetch.request`. The origin received `sec-gpc: 1`. In-page JS sees `navigator.globalPrivacyControl` from the real browser; Scramjet does not change it (UNVERIFIED).
- **Referrer control:** in `fetch.request`, edit the `Referer` entry of `props.init.headers` (RawHeaders array): reduce it to the origin or delete it. Scramjet forces `Referrer-Policy: unsafe-url` on documents (`headers.ts:112-114`). Its own computation honours the page's real policy from `$rfp` (`parse.ts:117-123`).
- **Response headers:** `props.response.headers.set/delete` in `fetch.response` (ScramjetHeaders), or `props.response.rawHeaders` in `preresponse`.

### 6.4 Cookie manager

See §9 for storage.

**Cookie blocking (CODE)**, e.g. for third-party cookies: in `fetch.preresponse`, remove the `set-cookie` entries from `props.response.rawHeaders`. `handleCookies` reads `response.rawHeaders` after `preresponse` (`core/src/fetch/fetch.ts:71`), so those cookies are never stored. To stop sending cookies, delete the `Cookie` entry from `props.init.headers` in `fetch.request`. Sapphire edits `rawHeaders` in the same hook (`sapphire/src/network.ts:290-294`). Note that body rewriting decides the content type from `response.headers` (the native `Headers`), not `rawHeaders` (`core/src/fetch/body.ts:20-34`).

Read with `JSON.parse(controller.cookieJar.dump())`. Write with `controller.cookieJar.setCookies("name=value; Path=/; Max-Age=0", new URL("https://site/"))`, then `await controller.persistCookies()` and `await controller.propagateCookieSync([{url, cookie}])`. Sapphire's `chrome.cookies` implementation is the reference: `sapphire/src/api/cookies.ts:31-109`, and its "clear browsing data" is at `sapphire/src/api/misc.ts:809-813`.

### 6.5 Request and response hook ordering with other plugins

`HttpCachePlugin` (scramjet-utils) taps `request` asynchronously and returns early if `props.earlyResponse` is already set (`utils/src/http-cache-plugin.ts:331-347`). A blocker must therefore be ordered `before: ["scramjet-http-cache"]`. `CatchEscapedLinksPlugin` declares `after: ["scramjet-http-cache"]`.

### 6.6 WebSockets: a transport decorator (VERIFIED)

Page WebSockets bypass the fetch hooks. A `ProxyTransport` decorator passed to the Controller sees **every** HTTP request the controller makes and every page WebSocket:

```ts
class FilteringTransport implements ProxyTransport {
  constructor(private inner: ProxyTransport, private blocked: (u: URL) => boolean) {}
  get ready() { return this.inner.ready; }
  init() { return this.inner.init(); }
  request(remote: URL, method: string, body: BodyInit | null, headers: RawHeaders, signal?: AbortSignal) {
    if (this.blocked(remote)) return Promise.reject(new TypeError("blocked by GNOME"));
    return this.inner.request(remote, method, body, headers, signal);
  }
  connect(url: URL, protocols: string[], h: RawHeaders, onopen: any, onmessage: any, onclose: any, onerror: (e: string) => void) {
    if (this.blocked(url)) { setTimeout(() => onerror("blocked by GNOME"), 0); return [() => {}, () => {}] as [any, any]; }
    return this.inner.connect(url, protocols, h, onopen, onmessage, onclose, onerror);
  }
}
```

VERIFIED: the page's `new WebSocket("ws://…/ws")` got `error`, and the wrapper logged `ws ws://127.0.0.1:47101/ws` plus all HTTP requests. It also wraps cleanly for traffic metering.

---

## 7. (c) Transports

### 7.1 Interface expected by core and the controller

No bare-mux. The controller calls the transport object directly (`controller/src/index.ts:230`, `356-446`), and core wraps it in `BareCompatibleClient` (`core/src/fetch/index.ts:134`). The interface is `npm:@mercuryworkshop/proxy-transports@1.0.2/dist/types.d.ts`:

```ts
export type RawHeaders = [string, string][];
export interface ProxyTransport {
  init: () => Promise<void>;
  ready: boolean;
  connect: (url: URL, protocols: string[], requestHeaders: RawHeaders,
            onopen: (protocol: string, extensions: string) => void,
            onmessage: (data: Blob | ArrayBuffer | string) => void,
            onclose: (code: number, reason: string) => void,
            onerror: (error: string) => void) => [(data: Blob | ArrayBuffer | string) => void, (code: number, reason: string) => void];
  request: (remote: URL, method: string, body: BodyInit | null, headers: RawHeaders, signal: AbortSignal | undefined)
           => Promise<{ body: ReadableStream | ArrayBuffer | Blob | string; headers: RawHeaders; status: number; statusText: string }>;
}
```

`BareCompatibleClient.fetch` calls `await transport.init()` lazily whenever `!transport.ready` (`npm:proxy-transports/dist/index.mjs`, class `BareCompatibleClient`). Scramjet always uses `redirect: "manual"`.

### 7.2 Compatibility

| Transport | Works with Scramjet 2.x? | How to construct | Notes |
|---|---|---|---|
| `@mercuryworkshop/libcurl-transport@2.0.6` (AGPL-3.0; bundles libcurl.js 0.7.5 with inline wasm) | **Yes. VERIFIED** for HTTP and WebSocket | ESM: `import LibcurlClient from "@mercuryworkshop/libcurl-transport"` (also named `LibcurlClient`). UMD: `new LibcurlTransport.LibcurlClient({...})` | Options (`dist/index.d.ts`): `wisp` (or legacy `websocket`), must start with `ws://`/`wss://` and **end with `/`** (otherwise the constructor throws, `dist/index.mjs` LibcurlClient ctor); `proxy?` (`socks5h:`, `socks4a:` or `http:` upstream proxy); `transport?` (`"wsproxy"` for one-socket-per-connection mode); `connections?` `[maxActive=60, cacheLimit=50, perHost=6]` |
| `@mercuryworkshop/epoxy-transport@3.0.2` (AGPL-3.0; epoxy-tls 2.1.20-1, Rust/wasm inline) | **Yes. VERIFIED** for HTTP and WebSocket | ESM: `import EpoxyTransport from "@mercuryworkshop/epoxy-transport"`. **The default export is the only one.** UMD: `new EpoxyTransport.default({wisp})` | Options: `wisp` plus `wisp_v2?`, `udp_extension_required?`, `title_case_headers?`, `ws_title_case_headers?`, `wisp_ws_protocols?`, `redirect_limit?`, `header_limit?`, `buffer_size?` (`src/main.ts:15-37`). Defaults UNVERIFIED. The README's `import { EpoxyClient }` and proxy-bootstrap's `window.EpoxyTransport.EpoxyClient` are **wrong**: no such export (VERIFIED in the UMD exports `{default, epoxyInfo}`). Duplicate request header keys are collapsed (`src/main.ts:84-90`) |
| wisp-js client (`@mercuryworkshop/wisp-js/client`) | **No, not by itself** | n/a | Exposes `ClientConnection` and a `WispWebSocket` polyfill (raw TCP streams, `src/client/index.mjs`). It has no TLS or HTTP, so it is not a `ProxyTransport` (libcurl.js embeds its own Wisp client) |
| bare-mux transports (libcurl-transport 1.5.x, epoxy-transport 2.1.x `legacy` tag = 2.1.29) | No | n/a | For Scramjet 1.x and Ultraviolet only (bare-mux `BareTransport` uses `BareHeaders` records). If GNOME's UV fallback uses bare-mux, it ships this **second** transport stack in a SharedWorker, which does not conflict with the page's libcurl singleton (UNVERIFIED) |

Both transports do **TLS in wasm with their own CA bundles**. The upstream bump to libcurl-transport 2.0.6 and epoxy 3.0.2 (commit `de322fa`, "protect against emudhra incident"; epoxy-tls `9cde724` "bump for eMudhra intermediate distrust") shows that CA-trust changes need transport releases. Track them.

Observed differences (VERIFIED):
- **libcurl, http:// targets:** sends `Upgrade: h2c`, `HTTP2-Settings` and `Connection: Upgrade, HTTP2-Settings`, i.e. an HTTP/2 cleartext upgrade attempt. A Node origin with a WebSocket `upgrade` handler answered `400 Invalid Upgrade header`. Most servers ignore it, and https:// uses ALPN, but a few plain-HTTP servers may break.
- **libcurl `Accept-Encoding`** is `deflate, gzip, br`. Epoxy sends `gzip, br` and `connection: keep-alive`.
- **TLS ClientHello** comes from libcurl or rustls, not Chrome. Some anti-bot systems may flag it (UNVERIFIED; DuckDuckGo and YouTube behaved oddly in headless runs).

### 7.3 Configuring the Wisp URL; switching at runtime (VERIFIED)

- Derive the URL from the page: `` `${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/wisp/` `` (as `bootstrap/src/client.ts:18` does). It must end with `/`.
- Switch with `controller.setTransport(newTransport)` (`controller/src/index.ts:622-628`). This updates `controller.transport` and every `frame.fetchHandler.client.transport`. In-page `RemoteTransport`s RPC to `this.transport` at call time, so **already-open pages also pick up the new transport for new requests and WebSockets**. VERIFIED: libcurl on `/wisp/` switched to epoxy on `/wisp2/`; the next navigation and the page's WebSocket used `/wisp2/`.
- The old transport is not closed (the interface has no `close()`). Existing sockets stay on it until they end.
- libcurl.js is a **module-level singleton**: `init()` calls the global `libcurl.set_websocket(url)`. Two `LibcurlClient`s with different Wisp URLs therefore cannot coexist. The last `init()` wins for every session (CODE, LibcurlClient.init).

### 7.4 Reconnection, health and timeouts

- **libcurl reconnects automatically (VERIFIED).** After the server destroyed the Wisp WebSocket, the next navigation opened a new Wisp connection (wisp connection count went 1 → 2) with no errors. libcurl.js drops the dead `WispConnection` from `_wisp_connections` and creates a new one on the next stream (CODE).
- **Epoxy does not reconnect (VERIFIED).** After the kill, the next navigation hung with no error. Later requests failed with `Error: Hyper client: hyper_util::client::legacy::Error(Connect, Wisp(MuxTaskEnded)) (client error (Wisp: MuxTaskEnded (Multiplexor task ended)))`, and no new Wisp connection was attempted. GNOME must detect `MuxTaskEnded` in `hooks.error.request` and call `controller.setTransport(new EpoxyTransport({wisp}))`. It should also apply a navigation timeout.
- **Concurrent `LibcurlClient.init()` hangs (VERIFIED).** Two calls before the wasm is ready leave the first promise pending forever, because the second overwrites `libcurl.onload`. Concurrent first requests from `BareCompatibleClient` trigger exactly that, for example two tabs restored at startup. **Always `await transport.init()` before `new Controller(...)` and before `setTransport(...)`**, as Sapphire's harness does (`sapphire/test/harness/web/main.ts:383-385`).
- `transport.init()` does not open the Wisp socket. To probe health, make a real request, e.g. `await transport.request(new URL("https://<probe>/"), "HEAD", null, [], undefined)`, or use a GNOME backend endpoint that reports HolyWisp status.
- The RPC layer (`packages/rpc/index.ts`) has **no timeouts**. Put timeouts around navigation in GNOME: if no `init.pre`/`response` arrives for the document within N seconds, show an error or retry.

---

## 8. (f) Error handling, detecting failure, falling back to Ultraviolet

### 8.1 How navigation and fetch errors surface (VERIFIED unless marked CODE)

| Failure | What the iframe shows | What GNOME can observe |
|---|---|---|
| Wisp endpoint unreachable (libcurl) | Plain text, HTTP 500: `Internal Service Worker Error: TypeError: Request failed with error code 7: Could not connect to server` | `frame.hooks.error.request` with `ctx.rawrequest.destination === "iframe"` and `ctx.error` (libcurl stack). Console: `Error in controller request handler: …` |
| DNS failure (through wisp-js) | 500 `… error code 35: SSL connect error`. The Wisp close reason is **not** mapped to a DNS error | Same hook |
| Epoxy after a Wisp drop | The first request did not complete within 4 s and showed no error. Later ones gave 500 `… Hyper client: … MuxTaskEnded …` | Same hook, but only for the later requests |
| Origin returns 4xx/5xx | The origin's page, passed through | `fetch.preresponse`/`response` `status`. **No error hook** |
| Controller has no frame for the path (CODE) | 500 `Internal Service Worker Error: Error: No frame found for request` (`index.ts:274`) | n/a |
| Plugin throws (CODE) | Request fails, giving a 500 like the above | Error hook |

A custom error page is VERIFIED: setting `props.setResponse = {body, status: 502, statusText, headers: [["content-type","text/html; charset=utf-8"]]}` and `props.suppressError = true` rendered GNOME's page. This is the place to show "Retry / Open with Ultraviolet".

### 8.2 Detecting controller init failure (VERIFIED)

- **Insecure context.** `navigator.serviceWorker` is undefined, so `register` throws (`TypeError: Cannot read properties of undefined (reading 'register')`). Check `isSecureContext` first.
- **Load order or version mismatch.** These throw synchronously: `TypeError: Cannot destructure … globalThis.$scramjet …` at script load (VERIFIED), or `Error: @mercuryworkshop/scramjet version mismatch …` from `new Controller()` (`assertRuntimeScramjetVersion`, CODE).
- **SW not running `controller.sw.js`.** With a wrong or old SW, `controller.wait()` **never resolves** (VERIFIED: "timeout after 6s"). Wrap it in a timeout.
- **Bad or 404 wasm.** `controller.wait()` **resolves "ready" anyway**. Every JS rewrite then fails (`rewriter wasm does not have wasm magic (was it fetched correctly?)`), and with `allowInvalidJs: true` the page runs **unrewritten** JS. VERIFIED: the page rendered, its WebSocket went to the **real** host `ws://localhost:47100/ws`, and nothing hit `error.request`. **Validate the wasm magic `\0asm` yourself before creating frames** (§4.4).
- There is no "unhealthy" event. Implement a watchdog for SW control, transport probe and navigation timeouts.

### 8.3 Suggested fallback policy

1. If the init checks above fail, mark Scramjet unavailable for the session and use UV for all tabs.
2. Per tab: on `error.request` for a document, with no `init.post` within T seconds, or on repeated transport errors, offer or auto-switch that tab to UV. Pass the **unproxied** URL from `ctx.rawrequest.rawUrl` through `unrewriteUrl`, or from GNOME's own tab state.
3. Page-level breakage (site JS errors) can only be estimated. Count `error`/`unhandledrejection` on `ctx.window` from `init.post` and expose a manual "Try Ultraviolet" button. UV and Scramjet share the origin and the single SW, which is fine because their routes are prefixed differently.

---

## 9. (e) Cookies and other proxied site data

### 9.1 Where cookies live (VERIFIED)

- In memory: `controller.cookieJar`, a `CookieJar` (`core/src/shared/cookie.ts:19-199`). Cookies are keyed `` `${domain}@${path}@${name}` `` with a leading dot on the domain, for example `.127.0.0.1@/@srv`. Values look like `{name, value, path, domain, hostOnly, httpOnly?, secure?, sameSite ("lax" default), expires?(ms)}`.
- Persisted in **IndexedDB on the GNOME origin**: DB `__scramjet_controller` (version 1), object store `state`, key `cookies`, value `{updatedAt: number, cookies: string /* JSON of the jar */}` (`controller/src/index.ts:92-195`, `606-620`). VERIFIED: it survived a shell reload and the cookies were sent again.
- Synced across GNOME tabs through `BroadcastChannel("__scramjet_controller_channel")` messages `{updatedAt}` (`index.ts:95`, `241-252`, `617-619`). Synced into open proxied documents through the SW (`$controller$setCookie` broadcast, `sw.ts:52-128`) and through inject's jar copy (`inject.ts:238-286`).
- **Jar semantics:**
  - `Set-Cookie` from responses is applied in `handleCookies` (`core/src/fetch/fetch.ts:298-323`).
  - `document.cookie` is emulated (`core/src/client/dom/cookie.ts:4-17`): HttpOnly is hidden from JS (VERIFIED: page saw `srv=1; lax=3; jsck=fromjs`, server received `srv=1; srvhttp=2; lax=3`). The write reaches the jar **asynchronously**, so a request in the same task may miss it (upstream note in `packages/runway/src/tests/adversarial/cookie-jar.ts:12-15`).
  - `cookieStore` is deleted (`cookie.ts:20`).
  - SameSite is emulated (`fetch/headers.ts:474-503`). The `Secure` attribute is not enforced (`cookie.ts:138-140`). eTLD+1 is approximated with no PSL (`headers.ts:510-528`).
- There is **one jar per Controller and shared persistence**, so there is no per-tab or "private tab" cookie isolation. Every proxied document receives the **entire** jar dump in its injected `data:` script (`controller/src/index.ts:696`).

### 9.2 List, delete per site, clear all (VERIFIED)

```ts
type JarCookie = { name: string; value: string; domain: string; path: string; hostOnly?: boolean; httpOnly?: boolean; secure?: boolean; sameSite?: string; expires?: number };
const listCookies = (c: Controller): JarCookie[] =>
  Object.values(JSON.parse(c.cookieJar.dump()) as Record<string, JarCookie>).filter((k) => k.expires === undefined || k.expires > Date.now());

async function deleteCookiesForSite(c: Controller, host: string) {
  const all = JSON.parse(c.cookieJar.dump()) as Record<string, JarCookie>;
  for (const [id, k] of Object.entries(all)) {
    const d = k.domain.replace(/^\./, "");
    if (d === host || d.endsWith("." + host) || host.endsWith("." + d)) delete all[id];
  }
  c.cookieJar.load(JSON.stringify(all));
  await c.persistCookies();                 // IndexedDB + BroadcastChannel to other GNOME tabs
  await c.propagateCookieSync([], {});      // nudge SW clients (open proxied docs keep their own copy until reload)
}
async function clearAllCookies(c: Controller) {
  c.cookieJar.clear();
  await c.persistCookies();
  await c.propagateCookieSync([], { clear: true });   // open documents clear their jar copies
}
// Single cookie: c.cookieJar.setCookies(`${name}=; Path=${path}; Max-Age=0` + (hostOnly ? "" : `; Domain=${domain}`), new URL(`https://${host}/`)); then persist + propagate.
```

`deleteCookiesForSite` is VERIFIED: the IndexedDB value became `{"updatedAt":…,"cookies":"{}"}`. Note that `load()` replaces the whole jar.

### 9.3 Other proxied site data (all in the GNOME origin)

| Storage | Naming used by Scramjet | Source | Clear |
|---|---|---|---|
| localStorage / sessionStorage | key `` `${proxiedHost}@${key}` `` (host includes the port) | `core/src/client/dom/storage.ts:4-107` | Remove keys matching `/^[^@\/]+@/`. Keep GNOME's own keys free of `@` or under its own prefix. VERIFIED stored key: `127.0.0.1:47101@iso` |
| IndexedDB | DB name `` `${origin}@${name}` `` (`open` proxied; `deleteDatabase`/`databases()` **not** proxied) | `core/src/client/shared/indexeddb.ts:4-17` | `indexedDB.databases()`, then delete names matching `/^https?:\/\/[^@]+@/` (CODE) |
| Cache Storage | cache name `` `${origin}@${name}` `` | `core/src/client/shared/caches.ts:4-26` | `caches.keys()`, then delete matches. Also `scramjet-http-cache-v2` if HttpCachePlugin is used (`utils/src/http-cache-plugin.ts:56`, `bust()` at `:466`) |
| OPFS | root dir `origin.replace(/\/\|\s\|\./g,"-")` (e.g. `https:--example-com`) | `core/src/client/shared/opfs.ts:4-26` | `(await navigator.storage.getDirectory()).removeEntry(name, {recursive:true})` (CODE) |
| Cookies | §9.1 | | §9.2 |

**Upstream storage bugs (VERIFIED in a proxied page):**
- `localStorage.key(0)` returns a **value** (`"2"`) instead of the key name.
- `localStorage.clear()` **does nothing**: it iterates array indices (`storage.ts:23-30`).
- Prefix checks use `startsWith(host)` without the `@`, so host `a.com` also counts keys of `a.com.evil.net` in `length`/`key()`/`ownKeys` (CODE).
- Upstream tracks `storage-clear`, `storage-key-by-index`, `platform-indexeddb-databases` and `cachestorage-keys-not-namespaced` as failing (`packages/runway/failing_tests.json`).

---

## 10. (g) Downloads, and (h) limitations and security

### Downloads (VERIFIED)

- `Content-Disposition` is not rewritten. The SW returns the response and **the browser's own download manager handles it** with the original filename.
  - VERIFIED: clicking `<a href="/download">` and calling `frame.go(".../download")` both produced a Playwright download `suggestedFilename: "report.csv"`.
  - The download URL is a proxied `/~/sj/…` URL, so it works only while the Controller tab lives.
  - The frame stays on the current page.
- **Detect** in `fetch.response`: `props.response.headers.get("content-disposition")?.startsWith("attachment")` (VERIFIED value `attachment; filename="report.csv"`), together with `ctx.parsed.destination` and `props.response.headers.get("content-type")`.
- **Take over** (CODE): tee or replace `props.response.body` (a ReadableStream for downloads) to feed a GNOME download UI, then return a 204 to cancel the browser download. Or strip `content-disposition` in `preresponse` to force inline display.
- There is no download hook or event in 2.x. v1 had `flags.interceptDownloads` and a `download` event.
- `<a download>` attributes on same-origin proxied URLs trigger browser downloads directly (UNVERIFIED nuance: blob/data URLs).

### 10.1 Secure context and response headers

- **Secure context is mandatory.** On `http://gnome.test:47100` (not loopback), `isSecureContext` is false and `navigator.serviceWorker` is undefined (VERIFIED). Deploy GNOME over HTTPS. `http://localhost` and `127.0.0.1` work for development.
- **COOP/COEP:** not required.
  - When the GNOME shell document is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, Frames are created with `crossOriginIsolated: self.crossOriginIsolated` (`controller/src/index.ts:788`). The fetch handler then adds COEP/COOP to proxied documents, workers, scripts and styles (`core/src/fetch/headers.ts:97-110`).
  - VERIFIED: inside the proxied page `{"coi":true,"sab":"function"}`. This is useful for games that need SharedArrayBuffer or threads.
  - Cost: GNOME's own cross-origin subresources then need CORP/CORS, and COOP severs opener links. Consider enabling it only for a dedicated games/proxy origin.
- **CSP (if GNOME sets one on its shell; UNVERIFIED, not tested):**
  - `script-src` needs `'self' 'wasm-unsafe-eval'`. The shell compiles the rewriter with `new WebAssembly.Module` (`core/src/shared/rewriters/wasm.ts:28-30`), and both transports instantiate inline base64 wasm.
  - `connect-src` needs `'self'` plus your `ws:`/`wss:` Wisp origin.
  - `worker-src` needs `'self'` (the SW).
  - `frame-src` needs `'self'`.
  - Proxied documents are separate SW-synthesized documents with no CSP: upstream CSP is stripped (`headers.ts:20-40`) and the shell's CSP is not inherited. Their injected `data:` script therefore needs nothing from the shell's CSP.

### 10.2 Same origin and isolation (central security fact)

- Every proxied site, the GNOME UI, GNOME's REST API cookies, and the storage of the Scramjet and UV engines all live in **one browser origin**. Scramjet emulates per-site separation only in JS: storage key prefixes, cookie domain matching, the `frameElement` trap (VERIFIED returns `null`), `top`/`parent === self` (VERIFIED), and a fake `location`/`origin`.
- **A proxied page can reach Scramjet internals (VERIFIED).** It can read `window[Symbol.for("scramjet client global")]` (`Symbol.for` is a global registry) and call `client.context.cookieJar.dump()`. The result listed `.127.0.0.1@/@srvhttp`, an **HttpOnly** cookie, and the jar holds cookies for *all* proxied sites. A full escape to the GNOME realm was not demonstrated (one attempt failed), but internals such as `client.natives` (the unhooked natives) are exposed.
- **Upstream agrees.** `packages/runway/src/tests/adversarial/origin-isolation.ts:3-13` says: *"a frame belonging to another proxied site is fully readable from script - its DOM, its cookie jar and its location all read out. That is architectural rather than a small bug: real separation needs a distinct browser origin per proxied site."* The runway list has **39 failing `escapes-*` tests**, ways to run unrewritten code such as `escapes-script-text`, `escapes-setattribute-onclick`, `escapes-postmessage-source-eval` and `escapes-xslt-*`. It also lists `originisolation-cross-site-frame-access`.
- **Rewrite failures run original JS.** With `allowInvalidJs: true` (the default), any rewrite failure executes the original JS unproxied (`core/src/shared/rewriters/js.ts:145-156`, VERIFIED in §8.2).
- **Recommendations:**
  1. Serve the proxy from a **separate origin** from GNOME's authenticated app and API, for example `https://proxy.<host>`, or a second port served by the same Axum binary. That origin hosts its own small shell page: the Controller, the iframes and the SW. The main GNOME UI embeds it cross-origin and talks to it over `postMessage` (URL, title, favicon, back/forward, errors). A compromised proxied page then cannot touch GNOME's session, API or settings. Proxied sites still share the proxy origin with each other.
  2. If you keep a single origin, make GNOME's API cookies `HttpOnly; SameSite=Strict`, require a CSRF header token on state-changing endpoints, and accept that a proxied page can act as the user against GNOME's API, because same-origin JS can read the DOM tokens. This is UNVERIFIED for GNOME specifically, since the API does not exist yet.
  3. Keep `allowInvalidJs` at its default only if compatibility matters more than containment. Consider `siteFlags` to disable it per risky site.
- Upstream security headers (CSP, XFO, HSTS, COOP/COEP, CORP, `X-Content-Type-Options`, `Permissions-Policy`, `Clear-Site-Data`) are **stripped** (`headers.ts:20-40`, `:92`). Proxied sites lose those protections.

### 10.3 Robustness bugs to design around (all VERIFIED unless marked CODE)

1. **SW restart race.** The browser stops idle SWs. On the next proxied fetch the SW restarts with an empty `tabs[]`, `shouldRoute()` returns false, and **the request goes to the network**: the GNOME server received `/~/sj/…/http%3A%2F%2F127.0.0.1%3A47101%2Fecho%3Fafter%3Dstop` (status 599 from the harness). Routing recovers about 100 ms later through `$controller$swrevive` → `setupMessagePort()`, but only if more than **5 s** have passed since the controller became ready (`guardServiceWorkerRevive`, `controller/src/index.ts:265-270`, `514-521`); otherwise the revive is ignored and routing stays broken. **Fix:** the hardened SW in §4.3 (VERIFIED: held about 211 ms, then correct), plus a backend 503 for `/~/sj/*`, and optionally a keep-alive `postMessage` to the SW every 20 s (UNVERIFIED that this prevents termination).
2. **Stale prefixes hang forever.** After the GNOME page reloads, the SW keeps the dead `ControllerReference`. Any request for an old prefix, such as a popup from the previous session or a bookmarked proxied URL, **never resolves** (VERIFIED: aborted by an 8 s timer, never reached the server). Store real URLs for session restore, never proxied ones. The hardened SW could add a time-to-headers timeout around `route(e)`.
3. **No frame cleanup.** There is no API to remove a frame. `controller.frames` and each handler's `trackedClients` grow forever (CODE). Splice closed frames out yourself.
4. **Rewriting runs on GNOME's main thread.** Heavy pages compete with the Svelte UI (CODE). Measured first loads in headless: example.com 0.27 s, Wikipedia 0.9 s, HN 1.3 s, GitHub repo page 15 s. Every document also downloads and parses the ~782 KB base64 virtual wasm script, and every JS rewrite synchronously calls `new WebAssembly.Module(586 KB)` (`wasm.ts:28-30`; measured about 0.5 ms per call in Chromium, about 4-5 ms in Firefox).
5. **Sync XHR throws** (`TypeError: e.getFlag is not a function`; async XHR fine).
6. **WebSocket inside a Worker throws** `Cannot read properties of undefined (reading 'getCookies')`. Workers get `transport: null` and no cookie jar (`controller/src/index.ts:734-771`).
7. **Proxied pages have no service workers** (`Navigator.prototype.serviceWorker` deleted, `core/src/client/shared/chrome.ts:39`). The Navigation API, Bluetooth, HID, Presentation, IdleDetector and others are deleted too (`chrome.ts:8-90`). `registerProtocolHandler` is a no-op (`client/dom/protocol.ts`).
8. **The `deepMerge` order bug** drops the controller's `allowFailedIntercepts: true` (§4.4).
9. **Joint session history** issues with `frame.back()` (§4.5).
10. **Debug noise.** Every in-page WebSocket logs `console.warn("connecting")` and `console.log(response)` (`controller/src/inject.ts:84`, `:97`).
11. **Escaped navigations** (open in new tab, `window.open`) become top-level proxied windows outside the GNOME UI unless they are redirected (§11.3).

---

## 11. Official integration path: create-proxy-app and proxy-bootstrap (and why GNOME should not use them as-is)

### 11.1 create-proxy-app 0.0.4 template (`packages/create-proxy-app/templates/default`)

- `server.js`: `const { routeRequest, routeUpgrade } = await bootstrap();` then Express with `app.use((req,res,next)=>{ if (routeRequest(req,res)) return; next(); })`, `express.static("public")`, `server.on("upgrade", routeUpgrade)`, and port 3030.
- `public/index.html` loads `<script src="/bootstrap-init.js">` and `/index.js`.
- `public/index.js`:
  - Calls `controller = await initBootstrap()`.
  - Creates the plugins `new $scramjetUtils.HttpCachePlugin()`, `new $scramjetUtils.UrlWatcherPlugin(url => …)` and `new $scramjetUtils.CatchEscapedLinksPlugin(url => new URL('/?goto='+encodeURIComponent(url.href), location.origin))`.
  - Calls `frame = controller.createFrame(frameElement, {plugins:[…]})` and `frame.go(url)`, and handles `?goto=` on load.
- License header: "GNU General Public License … version 3". Ships `credits.html`.

### 11.2 proxy-bootstrap 0.0.5 (`packages/bootstrap/src`)

- `bootstrap(cfg)` (`server.ts:219-292`) **downloads packages from the npm registry at server start**:
  - The latest `@mercuryworkshop/scramjet-controller` 0.x, plus the scramjet version from that controller's `devDependencies`.
  - The latest libcurl-transport 2.x (or epoxy 3.x), and the latest scramjet-utils 0.x.
  - Everything is extracted into `<pkg>/dist/.downloads/`.
- It serves:
  - `/sw.js`, generated as `importScripts("/controller/controller.sw.js"); addEventListener("fetch", …)` (`server.ts:48-56`).
  - `/bootstrap-init.js` (`initBootstrap()`, which imports a base64 data-URL client).
  - The controller files at `/controller/*`, `/scram/scramjet.js`, `/scram/scramjet.wasm`, `/scram/scramjet-utils.js` and `/clients/libcurl-client.js`.
- It proxies `/wisp/` upgrades to an in-process wisp-js 0.4.1 server.
- Defaults (`common.ts:48-63`): `transport:"libcurl"`, `swPath:"/sw.js"`, `wispPath:"/wisp/"`, `scramjetBundlePath:"/scram/scramjet.js"`, `scramjetWasmPath:"/scram/scramjet.wasm"`, `scramjetUtilsBundlePath:"/scram/scramjet-utils.js"`, `libcurlClientPath:"/clients/libcurl-client.js"`, `epoxyClientPath:"/clients/epoxy-client.js"`, `scramjetControllerApiPath/InjectPath/SwPath:"/controller/controller.{api,inject,sw}.js"`, `bootstrapInitPath:"/bootstrap-init.js"`.
- The client sets `config.injectPath/wasmPath/scramjetPath` to these paths and builds `new LibcurlTransport.LibcurlClient({ wisp: "ws(s)://<host>/wisp/" })` (`client.ts:13-47`).
- `bootstrap-static.js` is a SW+client hybrid that downloads files from jsDelivr into IndexedDB (`static.ts`).
- **Not suitable for GNOME:**
  - It fetches code at runtime from the network: supply-chain and reproducibility risk, and no offline single binary.
  - It is Node-only.
  - Epoxy mode is broken: `new window.EpoxyTransport.EpoxyClient` doesn't exist (VERIFIED in `npm:proxy-bootstrap@0.0.5/dist/bootstrap-client.js`), and `server.ts` has no route for `epoxyClientPath`.
  - It is version-fragile: "latest 0.x controller" plus utils 0.0.3, which was built for scramjet alpha.1 and controller 0.0.13.
- **Replicate its layout statically in Axum instead** (§4.2).

### 11.3 scramjet-utils 0.0.3 (optional)

- Exports: `HttpCachePlugin`, `CACHE_NAME`, `UrlWatcherPlugin`, `CatchEscapedLinksPlugin`, `EventHandlerPlugin`, `LinkHandlerPlugin`, `setupAlwaysLastBubble`, `ManagedPlugin`, `getScramjet`, `getVersionInfo`, `versionInfo`.
- The global is `$scramjetUtils` (from `dist/scramjet-utils.js`). Load it after the controller.
- It was built against scramjet `2.0.67-alpha.1` and controller `0.0.13`. With alpha.2 and 0.0.14 the plugins load and work, but `getVersionInfo()` and `getScramjet()` throw *"@mercuryworkshop/scramjet version mismatch: this build expects 2.0.67-alpha.1 …"* (VERIFIED).
- HEAD's utils asserts versions at **module load** (`packages/utils/src/index.ts:25`), so a future utils release will hard-fail on any mismatch.
- `CatchEscapedLinksPlugin` turns every top-level `destination:"document"` request into a `302` to your shell URL (`utils/src/catch-escaped-links.ts:16-26`). That is the official answer to "open in new tab" and `window.open`.
- Recommendation: copy the few lines you need, the URL watcher (plus `popstate`) and catch-escaped-links, into GNOME rather than depending on the package.

---

## 12. Scramjet 1.1.0 API summary (reference only)

- Page: `const { ScramjetController } = $scramjetLoadController(); const sj = new ScramjetController({ prefix:"/scramjet/", files:{wasm,all,sync}, flags:{…, interceptDownloads}, siteFlags, codec:{encode,decode} }); await sj.init();`, then `sj.createFrame(iframe?)`, which returns a `ScramjetFrame` (an EventTarget with `urlchange`, `navigate` and `contextInit`, plus `go`, `back`, `forward`, `reload`, `url` and `client`).
- The controller emits a `download` event `{filename,url,type,body,length}` when `interceptDownloads` is set.
- Transport through bare-mux: `new BareMux.BareMuxConnection("/baremux/worker.js").setTransport("/libcurl/index.mjs", [{wisp}])`.
- SW: `importScripts("/scram/scramjet.all.js"); const { ScramjetServiceWorker } = $scramjetLoadWorker(); const sj = new ScramjetServiceWorker(); … await sj.loadConfig(); if (sj.route(e)) return sj.fetch(e);` with SW events `request` (set `e.response`) and `handleResponse`.
- Sources: `npm:scramjet@1.1.0/dist/types/{controller,worker,client/events}.d.ts`, legacy `static/sw.js` and `static/ui.js`, and `src/controller/controller.ts:22-110` @ `57ba89e`.

---

## 13. Upgrade watch-list: HEAD (`517206b`) vs the published build (`c26bfc6`)

- **Exports and API:**
  - Core no longer re-exports `BareResponse` (`194e026`). Import it from `@mercuryworkshop/proxy-transports`.
  - The controller exports `versionInfo {version, build, date}` instead of `VERSION` (`e012c65`). Read `$scramjetController.versionInfo?.version ?? $scramjetController.VERSION`. `assertRuntimeScramjetVersion` is no longer re-exported.
  - The controller gains a `./path` export (`8010443`), and `FrameOptions.plugins` becomes optional.
  - Utils asserts versions at load.
- **Core fixes** since the published build include: undefined in history, the anchor `toString` trap, attr-proxy hardening, the location tryset, the currentSrc leak, the indirect-eval refactor, the snapshot of `String.prototype.startsWith`, an export escape, and fetch type exports (GitHub compare `c26bfc6...517206b`).
- **Building from source**, if fixes are needed before a release, requires Rust plus `wasm-bindgen` 0.2.105, `wasm-opt`, the `wasm-snip` fork, and pnpm (`README.md`, `.github/workflows/main.yml`). `pnpm rewriter:build && pnpm build` in `packages/core`.
- **Re-check on every upgrade:** the §10.3 bugs, the §4.8 types, the `allowFailedIntercepts` merge, the exact version assertion (the controller and core must be upgraded together), and the transport CA updates.

---

## 14. GNOME integration checklist

1. Pin the packages (§4.1). Copy the five dist files to `/scramjet/` and `/controller/` at build time and embed them in the Rust binary. Serve `.wasm` as `application/wasm`.
2. Create one classic `/sw.js` at scope `/`: the hardened Scramjet routing (§4.3), plus the UV routes, plus any GNOME routes.
3. The backend must never serve the SPA fallback for `/~/sj/*`. Return a 503. Forward `/wisp/` WebSocket upgrades to HolyWisp.
4. Shell: `<script src=/scramjet/scramjet.js>` and `<script src=/controller/controller.api.js>` in `<head>`. Run `startScramjet()` (§4.4) with its secure-context check, wasm validation, `await transport.init()`, the explicit `allowFailedIntercepts`, and the `wait()` timeout.
5. Per tab: `controller.createFrame(iframe, {plugins: [TabObserver, AdBlock, Privacy, …]})` and `frame.go(absoluteUrl)`. Keep GNOME-owned per-tab history and the guard against shell navigation. On close, remove the iframe and splice it out of `controller.frames`.
6. Errors: an `error.request` page with Retry and "Open in UV"; navigation timeouts; epoxy `MuxTaskEnded` triggering `setTransport`.
7. Downloads: detect in `fetch.response`, leaving the browser to download by default.
8. Settings: implement cookies and site data management with §9.2 and §9.3.
9. Security: plan the proxy-origin split (§10.2). Decide AGPL compliance (§2.3).
10. TypeScript: `skipLibCheck: true` plus local hook types (§4.8).

---

## 15. Verification log (reproducible)

- **Downloaded artifacts** (untrusted, each in its own directory under `/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/pkgs/`): `scramjet-2.0.67-alpha.2`, `scramjet-controller-0.0.14`, `proxy-bootstrap-0.0.5`, `scramjet-1.1.0`, `scramjet-utils-0.0.3`, `proxy-transports-1.0.2`, `libcurl-transport-2.0.6`, `epoxy-transport-3.0.2`, `bare-mux-2.1.9`, `create-proxy-app-0.0.4`, `wisp-js-0.4.1`, `wisp-js-0.5.3`, `scramjet-wiki`, `scramjet-legacy-src` (v1 files @ `57ba89e`), and `harness-deps` (installed with `npm install --ignore-scripts`).
- **Harness** (my scripts, separate directory: `/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad/scripts/sjh/`):
  - `server.mjs`: app origin `http://localhost:47100` with static mounts, `/wisp/` and `/wisp2/` (wisp-js 0.5.3, loopback only, port whitelist 47101/80/443), and a test origin at `127.0.0.1:47101`.
  - `public/{index.html,app.mjs,sw.js,sw-robust.js}`.
  - `run.mjs <deps> <scenario> [browser]` with scenarios `basic`, `epoxy`, `coi`, `redirectstrip`, `realsite`, `error`, `dnsfail`, `download`, `swstop`, `swstop2` (`SWURL=/sw-robust.js`), `switch`, `utils`, `initfail`, `noswinit`, `workerws`, `reloadpersist`.
  - Extra probes: `iso.mjs` (isolation), `history.mjs` (joint history, chromium and firefox), `codec.mjs`, `syncxhr.mjs`, `misc.mjs` and `misc2.mjs` (insecure context, utils asserts, storage bugs, epoxy reconnect), `order.mjs`, `redirect2.mjs`, `wswrap.mjs`, `initrace.mjs`, `wasmtime.mjs`, `ts/` (tsc checks).
  - Saved outputs are in `results/*.txt`.
- **Browsers:** playwright-core 1.64.0 with Chromium `chromium-1248` (HeadlessChrome 156.0.8078.4) and Firefox `firefox-1555`.
- **Not verified:**
  - The exact behaviour against HolyWisp (all tests used wisp-js 0.5.3 as the Wisp server). In particular, whether libcurl.js speaks Wisp v1 or v2 to HolyWisp is UNVERIFIED.
  - Behaviour on real HTTPS deployments, and mobile browsers.
  - Long-run SW idle termination timing.
  - The UV + Scramjet combined SW.
