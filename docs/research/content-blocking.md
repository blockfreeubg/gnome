# Content blocking for GNOME: ad blocker, tracker blocker, privacy protection, cookie manager, cosmetic filtering

Research date: 2026-11-09. Author: research engineering (automated). Status: **recommendation + verified measurements**.
Anything not verified by reading source or running code is labelled **UNVERIFIED**.

Scope: the content-blocking stack for GNOME's built-in extensions. Proxied pages load through Scramjet (primary) or
Ultraviolet (fallback). Network blocking matches each outgoing proxied request (URL + resource type + initiator)
before it is fetched. Cosmetic filtering injects CSS (and later scriptlets) into proxied same-origin frames.

Versions examined:

| Component | Version / commit | Where |
|---|---|---|
| `@ghostery/adblocker` | **2.20.3** (npm `latest`, published 2026-10-28T13:04Z, MPL-2.0, `ENGINE_VERSION = 899`) | npm tarball, `dist/esm` + typings |
| `@ghostery/adblocker-content` | 2.20.3 (MPL-2.0) | npm |
| `@ghostery/adblocker-extended-selectors` | 2.20.3 (MPL-2.0) | npm |
| Scramjet | repo commit `517206bc` (2026-11-08); `@mercuryworkshop/scramjet` 2.0.67-alpha.2, `@mercuryworkshop/scramjet-controller` 0.0.14 (both AGPL-3.0-only) | `repos/scramjet` |
| Ultraviolet | repo commit `5c9d8acd` (2024-01-14); `@nebula-services/ultraviolet` 1.0.11.patch.7 (MIT) | `repos/ultraviolet` |
| HolyWisp | commit `e0a0f159` (2026-11-07) | `repos/holywisp` |
| Test runtimes | Node v26.13.0; Chromium 156.0.8078.4 and Firefox 157.0 (headless, via `playwright-core` 1.64.0); esbuild 0.28.2 | local |
| Test machine | AMD Ryzen 5 5600G (6C/12T, ≤4.47 GHz), 14 GB RAM, Linux 7.3 | local |

All scratch artifacts are under `$SP = /tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad`
(see [§12 Reproduction](#12-reproduction)).

---

## 0. TL;DR

1. **Use `@ghostery/adblocker` 2.20.3 (MPL-2.0).** It is pure JS and needs no Node APIs. It is **verified running inside a
   classic service worker** in Chromium 156 and Firefox 157 (no `document`, `window`, `Buffer` or `process`). A
   self-contained bundle is **253.6 KB minified / 90.8 KB gzip / 71.1 KB brotli** (plus 3.2 KB / 1.4 KB gz for
   `@ghostery/adblocker-content`). It supports uBO-style syntax: `$redirect`, `$removeparam` (plain names only), `$csp`,
   HTML filtering, cosmetics and scriptlets. It does **not** support `$header`, `$popup`, regex `$removeparam`, `$urlskip`,
   `$permissions`, `$cname`, `$method` or `$strict1p/3p` (see §2.10).
2. **Scramjet 2's controller changes where the blocker runs.** The Scramjet SW is only a router. Every proxied request
   is sent by RPC to the **page that owns the `Controller`**, and `ScramjetFetchHandler.handleFetch` runs there
   (`controller/src/sw.ts:166-200` → `controller/src/index.ts:271-308`). So the Scramjet integration is a
   `ManagedPlugin` that taps `frame.hooks.fetch.{intercept,request,preresponse,response}` and
   `frame.hooks.init.post` in the **GNOME top-level page**, not in the SW. With UV, the blocker runs in the SW
   (`uv.on('request'|'beforemod'|'response')`).
3. **Measured performance, Node 26, default preset ≈ uBO defaults + URL-param list.** The preset parses 6.3 MB of list
   text in **322 ms** (warm; 439 ms first run). The serialized engine is **8.0 MB** (3.4 MB gzip). It deserializes in
   **12 ms in a fresh process**. Matching runs at **~52 k req/s including `Request` construction** (p50 13 µs, p99 74 µs).
   EasyList + EasyPrivacy alone: parse **228 ms**, **5.2 MB** serialized, deserialize **3.8–8.4 ms**, **~123 k req/s
   end to end** (p50 5.8 µs, p99 38 µs). In the browser SW: **110 k req/s** (Chromium) and **96 k req/s** (Firefox) for
   EasyList + EasyPrivacy.
4. **Build the engine on the client and keep the backend dumb.** The Rust backend fetches and caches **list text**
   (1.6 MB brotli for the default preset, against 2.9 MB brotli for the serialized engine) and serves it with SHA-256
   ETags. A Web Worker parses it. The main thread validates cosmetic selectors with `CSSStyleSheet.insertRule`
   (55,840 selectors in 49 ms in Chromium and 90 ms in Firefox), and invalid ones are removed. The engine is then
   serialized into Cache Storage. **Selector validation is required.** If you build without a DOM (Node, Worker or SW),
   the engine keeps invalid selectors, such as EasyList's ABP-style `##sel {style}` rules. Each one invalidates a whole
   1024-selector CSS rule in a real browser. This was verified: 8 of 1,153 hosts lost cosmetic rule blocks (309 selectors).
5. **Default lists (balanced breakage):**
   - **Ad blocker ON:** EasyList, uBlock filters, uBlock Badware, uBlock Quick fixes, uBlock Unbreak, Peter Lowe.
   - **Tracker blocker ON:** EasyPrivacy, uBlock Privacy.
   - **Strip tracking params ON:** AdGuard/uBO URL Tracking Protection plus a small built-in list. The lists
     intentionally do not strip `utm_*`.
   - **Cookie notices OFF (opt-in):** EasyList Cookie List. Add uBlock Cookie Notices once scriptlets ship; 93 % of its
     2,171 scriptlets are `trusted-*`.
   - **Never by default:** AdGuard Tracking Protection (15 MB of text, 437 k rules, 20 MB engine, 1.4 s parse) and any
     CC BY-NC-SA list (Disconnect, DDG Tracker Radar, Ghostery TrackerDB).
6. **Privacy features that are implementable today:**
   - URL-param stripping (engine `rewrite.url` plus a 307 for documents).
   - `Sec-GPC: 1` and `navigator.globalPrivacyControl`.
   - Cross-site referrer trimming.
   - Third-party cookie blocking: strip `Cookie` in the request hook and `Set-Cookie` in the preresponse hook.
   - Fingerprinting-script blocking via EasyPrivacy and uBO Privacy.
   - WebRTC disabling (UNVERIFIED in Scramjet).
   - Cookie stores the cookie manager can read and write:
     - Scramjet: `JSON.parse(controller.cookieJar.dump())`, persisted in IndexedDB `__scramjet_controller` / store
       `state` / key `cookies`.
     - UV: IndexedDB `__op` / store `cookies` (keyPath `id`).

---

## 1. Where blocking runs (hook points)

### 1.1 Scramjet 2 (controller architecture), the primary engine

The request path is: browser → Scramjet SW `route(event)` → MessagePort RPC `"request"` → `Controller.methods.request`
in the **controller page** → `frame.fetchHandler.handleFetch()` → transport (Wisp) → response back over RPC → SW builds
`new Response(...)`.

- `packages/controller/src/sw.ts:160-164` `shouldRoute(event)`; `:166-211` `route(event)` calls
  `tab.rpc.call("request", {rawUrl, rawReferrer, destination, mode, method, body, cache, initialHeaders, rawClientUrl, clientId})`.
- `packages/controller/src/index.ts:271-308` receives the RPC and calls `frame.fetchHandler.handleFetch(...)` on the
  page's main thread.
- Plugins: `packages/controller/src/index.ts:79-89` defines `class ManagedPlugin extends Plugin { frame; dependencies; install(frame) }`.
  `Frame` (`:710`) exposes `hooks = { fetch: this.fetchHandler.hooks.fetch, init: Tap.create<FrameInitHooks>(), error: Tap.create<FrameErrorHooks>() }`
  (`:809-813`). Plugins are installed via `controller.createFrame(iframe, { plugins: [...] })` (`:630`, install loop
  `:817-831`). `Plugin.tap(hook, callback, order?)` is defined at `packages/core/src/Tap.ts:98-115`.

Fetch hooks (`packages/core/src/fetch/index.ts:157-197`; dispatch sites in `packages/core/src/fetch/fetch.ts`):

| Hook | Dispatched at | Context | Props (mutable) | GNOME use |
|---|---|---|---|---|
| `fetch.intercept` | `fetch.ts:37-49`, before any network I/O | `request: ScramjetFetchRequest`, `parsed: ScramjetFetchParsed` | `response?: ScramjetFetchResponse`; setting it short-circuits | **Network blocking**, redirect resources, blocked-page interstitial, `removeparam` 307 for documents |
| `fetch.request` | `fetch.ts:191-214`, after `rewriteRequestHeaders` (Referer/Origin/Cookie/Sec-Fetch-* already computed, `headers.ts:119-165`) | `request`, `parsed`, `client` | `init: BareRequestInit` (raw headers `[name,value][]`), `url: URL`, `earlyResponse?` | `Sec-GPC`, strip `Cookie` (3P), trim `Referer`, rewrite URL for subresource `removeparam` |
| `fetch.preresponse` | `fetch.ts:216-229`, **before** `handleCookies` (`fetch.ts:71`, `:298-323`) | `request`, `parsed` | `response: BareResponse` (`rawHeaders`) | Strip `Set-Cookie` from 3P responses; HTML filtering of raw body (UNVERIFIED) |
| `fetch.response` | `fetch.ts:160-173`, after body rewrite | `request`, `parsed` | `response: {body, headers: ScramjetHeaders, status, statusText}` | Stats; header tweaks. **Do not add CSP headers** (see §6.6) |
| `init.pre` / `init.post` | `controller/src/inject.ts:355-364`, inside each proxied window when Scramjet's inject script runs (top of `<head>`) | `window`, `client: ScramjetClient`, `isTopLevel` | – | **Cosmetic CSS injection**, DOMMonitor, `navigator.globalPrivacyControl`, WebRTC kill-switch |
| `rewriter.html.pre` | `core/src/shared/rewriters/html.ts:172-181`, after parse and **before** `traverseParsedHtml` (`:182`) and before inject scripts are unshifted (`:240-263`) | `handler: DomHandler`, `meta`, `origHtml`, `htmlcontext` | – (mutate DOM) | Insert `<style>` for first paint and `<script>` scriptlets (they get JS-rewritten); `##^script:has-text` removal |
| `rewriter.html.post` | `html.ts:266-283` | same | `setRawHtml?` | Last-resort HTML edits |
| `error.request` | `controller/src/types.d.ts:123-145` | `rawrequest`, `error` | `setResponse?`, `suppressError?` | Error page |

`ScramjetFetchParsed` fields used for matching (`core/src/fetch/index.ts:35-66`, filled by `fetch/parse.ts:58-151`):

- `url`: the upstream URL.
- `destination`: `request.destination`, overridable by the `$dest` query param.
- `isIframe`: Scramjet's own notion. The GNOME tab's top-level proxied document arrives as destination `iframe` with
  `isIframe=false`; Scramjet itself treats that as a top-level navigation (`Sec-Fetch-Dest: document`,
  `core/src/fetch/headers.ts:226-232`). Nested iframes get `$iframe` stamped by the URL rewriter
  (`core/src/shared/rewriters/url.ts:186`).
- `clientUrl`: the un-rewritten client document URL.
- `referrerSourceUrl`.
- `fetchInitiatorOrigin`.
- `meta.topFrameName`.

Things the SW never sees, which matter for blocking:

- **WebSockets:** Scramjet creates them in the client via `client.bare.createWebSocket(...)`
  (`core/src/client/shared/requests/websocket.ts:66,278`). `$websocket` filters need a client-side hook (UNVERIFIED design).
- **Beacons:** they *do* reach the SW (URL rewritten in `core/src/client/dom/beacon.ts:4-10`), but with destination `''`.
  They match as `xmlhttprequest`, so `$ping` filters do not apply.

### 1.2 Ultraviolet (fallback): runs in the SW

`src/uv.sw.js` (`class UVServiceWorker extends EventEmitter`, `:30`):

- `this.emit('request', reqEvent)` at `:120`. The event data is a `RequestContext` with `url` (URL), `headers` (plain
  object, `cookie` already set at `:117`, `referer` at `:105`), `method` and `body`. `event.respondWith(x)`
  short-circuits (`HookEvent`, `:371-391`).
- `this.emit('beforemod', resEvent)` at `:146`, before CSP stripping (`:149`) and before `set-cookie` storage (`:182`).
  Delete `resEvent.data.headers['set-cookie']` here.
- `this.emit('response', resEvent)` at `:276`. For HTML, `resEvent.data.body` is the rewritten HTML string, so a
  `<style>` can be inserted there (UNVERIFIED).

### 1.3 HolyWisp is not the place for ad blocking

HolyWisp has `block-host` / `allow-host` (`holywisp.conf.example:18-19`). It only sees CONNECT host:port; TLS is
end-to-end in the browser's Wisp transport. It matches hosts **linearly** (`src/common/filter.c:41-57`) and has no
config reload. Keep it for admin policy (private ranges, ports). URL-level and cosmetic blocking must be client-side.

---

## 2. `@ghostery/adblocker` 2.20.3 evaluation

### 2.1 Package facts

- npm: `@ghostery/adblocker@2.20.3`, tarball `https://registry.npmjs.org/@ghostery/adblocker/-/adblocker-2.20.3.tgz`,
  `sha512-Wxv+RiqfD+xYVij9gkudU6nDb+eqbfu2roDZa0rtqVw2qIm0ICxEnkrsgUyfZw7+L+3PfI2PszHZQeoCkR1CuA==`, with npm provenance
  (SLSA v1). `"type": "module"`. Exports: `import` → `dist/esm/index.js`, `require` → `dist/commonjs/index.js`.
- Release cadence: 66 releases since 2.0.0 (2024-10-17). 2.20.0 → 2.20.3 shipped between 2026-10-09 and 2026-10-28.
  Repo `ghostery/adblocker` (MPL-2.0) was pushed 2026-11-09.
- Runtime dependencies (all resolved by `npm install --ignore-scripts`):

| Package | Version | License |
|---|---|---|
| `@ghostery/adblocker-content` | 2.20.3 | MPL-2.0 |
| `@ghostery/adblocker-extended-selectors` | 2.20.3 | MPL-2.0 |
| `@ghostery/url-parser` | 1.3.1 | MPL-2.0 |
| `@remusao/guess-url-type` | 2.1.0 | MPL-2.0 |
| `@remusao/small` (tiny fallback redirect resources) | 2.1.0 | MPL-2.0 |
| `@remusao/smaz` (+ `-compress`/`-decompress`, `@remusao/trie`) | 2.2.0 / 2.1.0 | MPL-2.0 |
| `tldts-experimental` / `tldts-core` (public suffix list) | 7.4.19 / 7.4.20 | MIT |

- Main exports (`dist/esm/index.d.ts:8-24`): `FiltersEngine`, `ENGINE_VERSION`, `Request`, `makeRequest`,
  `NetworkFilter`, `CosmeticFilter`, `Preprocessor`, `parseFilters`, `parseFilter`, `generateDiff`, `mergeDiffs`,
  `getLinesWithFilters`, `Config`, `Resources`, `StreamingHtmlFilter`, and the fetch helpers (`fetchLists`,
  `fetchResources`, `adsLists`, `adsAndTrackingLists`, `fullLists`, `fetchWithRetry`).

### 2.2 Works in a service worker or plain browser (verified)

Reading the source showed every non-standard global is guarded:

- `Buffer` is used only as a fallback when `btoa` is missing (`resources.js:11-19`).
- `document` is only touched in the CSS-validity helper, behind `typeof document !== 'undefined'`
  (`filters/cosmetic.js:70-92`).
- `window.queueMicrotask` is behind a `typeof window` check (`queue-microtask.js:9-12`).
- It uses `TextEncoder`/`TextDecoder` (`data-view.js:14-15`) and `structuredClone`, both available in SWs.

Running it confirmed this. The bundle was built with esbuild as an IIFE, loaded in a **classic SW** via `importScripts`
(`$SP/adblock-bench/browser/www/sw.js`) and driven by Playwright (`$SP/adblock-bench/results/browser.json`):

| Check (SW context) | Chromium 156 | Firefox 157 |
|---|---|---|
| `typeof document / window / Buffer / process` | all `undefined` | all `undefined` |
| fetch + deserialize EasyList+EasyPrivacy engine (5,207,337 B) | 14.1 ms + **11.5 ms** | 22 ms + **6 ms** |
| match 20,246-request sample (best of 3) | 184.5 ms → **109,734 req/s** | 212 ms → **95,500 req/s** |
| first 1,000 matches after deserialize (lazy init) | 33 ms | 54 ms |
| fetch + deserialize "full" engine (9,857,721 B) | 24.9 ms + 19.9 ms | 32 ms + 9 ms |
| match sample with full engine | **51,217 req/s** | **38,490 req/s** |
| `FiltersEngine.parse(EasyList+EasyPrivacy)` inside SW | 342.5 ms (285 ms in an earlier run) | 363 ms |
| Real `FetchEvent` mapping: `<script>`/`<img>`/`<link rel=stylesheet>`/`fetch()` → destination `script`/`image`/`style`/`''` → type `script`/`image`/`stylesheet`/`xmlhttprequest`; blocked ones answered with `Response.error()` | `<script>`/`<img>` fire `error`, `fetch()` rejects, allowed ones load | same (Firefox logs one console error per `Response.error()`) |

Page (main-thread) checks in the same run:

- Parsing EasyList+EasyPrivacy with a DOM took 372.7 ms in Chromium and 375 ms in Firefox, and kept **24,474**
  cosmetic filters. The SW build kept 24,514 (see §2.8).
- Injecting `getCosmeticsFilters()` styles hid `.ad--300x250`, `#ad--sidebar` and `ins.adsbygoogle[data-ad-client]`
  and left content visible.
- `DOMMonitor` reported classes and ids added later.

### 2.3 Size of what we need

Built with esbuild 0.28.2 (`--minify`, `target es2020`, `platform browser`). Script:
`$SP/adblock-bench/bundle/build.mjs`.

| Bundle | Minified | gzip -9 | brotli 11 | Notes |
|---|---:|---:|---:|---|
| `{ FiltersEngine, Request }` (ESM) | **253,623 B** | **90,782 B** | **71,074 B** | `@ghostery/adblocker` 124,955 B; `tldts-experimental` 100,931 B; ext-selectors 7,247; `tldts-core` 6,772; `@remusao/small` 6,382; guess-url-type 1,996; url-parser 1,847; smaz ≈3.4 k |
| everything (`export *`) | 258,734 B | 92,362 B | 72,447 B | Tree-shaking barely helps: `FiltersEngine` references everything |
| SW IIFE (`self.GhosteryAdblocker`) | 253,645 B | 90,791 B | 70,896 B | Used in the SW test |
| `@ghostery/adblocker-content` (DOMMonitor, extractFeaturesFromDOM, injectScript, autoRemoveScript) | 3,180 B | 1,384 B | 1,202 B | |
| Shipped `dist/adblocker.umd.min.js` | 132,742 B | 35,624 B | – | **Not self-contained**: it `require`s url-parser, smaz, extended-selectors, guess-url-type, tldts-experimental and small as externals |

### 2.4 Building an engine (API)

Signatures from `dist/esm/engine/engine.d.ts`:

```ts
static parse<T extends FilterEngine>(this: new (...a: any[]) => T, filters: string, options?: Partial<Config>): T;            // :137
static empty<T extends FilterEngine>(this: new (...a: any[]) => T, config?: Partial<Config>): T;                               // :75
static fromLists<T extends typeof FilterEngine>(this: T, fetch: Fetch, urls: string[], config?: Partial<Config>, caching?: Caching): Promise<InstanceType<T>>; // :84
static fromPrebuiltAdsOnly / fromPrebuiltAdsAndTracking / fromPrebuiltFull(fetchImpl?: Fetch, caching?: Caching)              // :93-103
static merge<T extends typeof FilterEngine>(this: T, engines: InstanceType<T>[], opts?: MergeOptions): InstanceType<T>;      // :136
update({ newNetworkFilters, newCosmeticFilters, newPreprocessors, removedCosmeticFilters, removedNetworkFilters, removedPreprocessors }: Partial<IListDiff>, env?: Env): boolean; // :197
updateFromDiff({ added, removed, preprocessors }: IPartialRawDiff, env?: Env): boolean;                                       // :198
updateResources(data: string, checksum: string): boolean;                                                                     // :189
updateEnv(env: Env): void;   // Env = class Env extends Map<string, boolean> (preprocessor.js:2); a plain Map works
getFilters(): { networkFilters: NetworkFilter[]; cosmeticFilters: CosmeticFilter[] };
```

- **Do not use `fromLists` / `fromPrebuilt*` in GNOME.**
  - `fromPrebuilt*` is just `fromLists(fetch, adsLists | adsAndTrackingLists | fullLists)` (`engine.js:97-113`). Those
    URLs point to `https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/...`
    (`fetch.js:38-63`).
  - The repo copies are stale: last bot update 2026-08-14, and the Peter Lowe copy says "Last modified: 29 May 2024".
  - `fromLists` always also downloads `.../assets/ublock-origin/resources.json` (`fetch.js:74-76`, `engine.js:76-95`).
  - `!#include` is not supported: `parseFilters` has no include handling (`lists.js:127-…`).
- **`Config` flags** (`dist/esm/config.js:30`, all `readonly`, 16 booleans serialized with the engine):

| Flag | Default | GNOME recommendation |
|---|---|---|
| `loadNetworkFilters` | true | true |
| `loadCosmeticFilters` | true | true. False drops 1.1 MB from the EL+EP engine (4,094,461 vs 5,207,337 B) |
| `loadGenericCosmeticsFilters` | true | true. False if "generic cosmetic filtering" is turned off |
| `loadExtendedSelectors` | **false** | false in v1. True once procedural (`:has-text`, `:upward`, `:xpath`, `:remove()`) evaluation exists (§6.5) |
| `loadCSPFilters` | true | true (we emulate a few, §6.6) |
| `loadExceptionFilters` | true | true |
| `loadPreprocessors` | **false** | **true**, then `updateEnv(...)`. With false, *both* branches of `!#if` load (verified). uBO's `filters.min.txt` has 301 `!#if` |
| `enableHtmlFiltering` | false | true only once §6.5 HTML filtering is implemented. Pair with env `cap_html_filtering` |
| `enableCompression` | false | false. −21 % raw size (5.21 → 4.09 MB) but +75 % parse time (228 → 400 ms), and gzip transfer barely changes (2.27 → 2.19 MB) |
| `integrityCheck` | true | true (CRC32 checked on deserialize) |
| `enableOptimizations` | true | true |
| `enableInMemoryCache` | true | true |
| `guessRequestTypeFromUrl` | false | false (we map destinations exactly, §2.6) |
| `debug` | false | false. True keeps raw filter text for a "logger" devtool, at a larger size |
| `enableMutationObserver`, `enablePushInjectionsOnNavigationEvents` | true | Irrelevant (WebExtension wrappers only) |

- **Preprocessor env.** Tokens found in the selected lists: `cap_html_filtering` (147), `env_safari` (59),
  `env_mobile` (57), `env_firefox` (49), `ext_ubol` (45), `env_chromium` (31), `cap_ipaddress` (9), `env_mv3` (3),
  `ext_abp` (1). Recommended env:
  `new Map([['env_chromium', isChromium], ['env_firefox', isFirefox], ['env_safari', isSafari], ['env_mobile', isMobile], ['cap_html_filtering', htmlFilteringEnabled]])`,
  with everything else false. The env is **not** serialized, so call `updateEnv` after every `deserialize` (verified:
  `$SP/adblock-bench/update-check.mjs`).

### 2.5 Serialize / deserialize

```ts
serialize(array?: Uint8Array): Uint8Array;                    // engine.d.ts:180
static deserialize(serialized: Uint8Array): FiltersEngine;    // engine.d.ts:138
getSerializedSize(): number;
```

- Format: `uint16 ENGINE_VERSION`, then `Config`, resources, lists, preprocessors and buckets, then a CRC32
  (`engine.js:169-226`). `deserialize` **throws** on a version mismatch (`serialized engine version mismatch, expected 899 but got …`)
  and on checksum mismatch (both verified). **Key cached engines by `ENGINE_VERSION`** and rebuild after library upgrades.
- Deserialization is essentially zero-copy. Buckets keep views into the input buffer and filters are materialized
  lazily. Measured heap growth on deserialize was ≈0.1–0.4 MB (1.5 MB with `enableCompression`); after 20k matches it was within GC noise. Budget memory
  as ≈ the serialized size plus a few MB per engine instance. The cost of laziness is paid by the first matches: the
  first match takes 2.7–7 ms and the first 1,000 take 50–109 ms in Node or 33–184 ms in a browser SW. **Warm up**
  after load by matching a few synthetic requests during idle time.

| Engine (Node 26) | Serialized | gzip -9 | brotli 11 | `serialize()` | `deserialize()` warm / in-process first / fresh process |
|---|---:|---:|---:|---:|---|
| EasyList+EasyPrivacy (default config) | 5,207,337 B | 2,267,478 B | 1,939,123 B | 9.4 ms | 3.8 / 7.2 / **8.4 ms** |
| same, `loadCosmeticFilters:false` | 4,094,461 B | 1,797,188 B | 1,529,309 B | 6.4 ms | 3.0 / 5.8 / 6.6 ms |
| same, `enableCompression:true` | 4,090,293 B | 2,192,683 B | 1,910,944 B | 8.2 ms | 3.0 / 6.0 / 8.0 ms |
| **gnome-default** (§5.2) | **8,017,593 B** | 3,396,968 B | 2,863,682 B | 11.3 ms | 6.1 / 25.9 / **12.0 ms** |
| gnome-full (default + cookie notices) | 9,857,721 B | 4,296,357 B | 3,599,250 B | 14.6 ms | 7.4 / 9.5 / 14.0 ms |

A fresh Node process also pays ≈30 ms to import the ESM module graph.

### 2.6 Network matching

```ts
// request.d.ts
static fromRawDetails<T = any>({ requestId, tabId, url, hostname, domain, sourceUrl, sourceHostname, sourceDomain, type, _originalRequestDetails }: Partial<RequestInitialization<T>>): Request<T>;
// engine.d.ts:281
match(request: Request, withMetadata?: boolean): BlockingResponse;
interface BlockingResponse {                         // engine.d.ts:26-40
  match: boolean;                                    // block (or redirect) unless an exception matched
  redirect: undefined | { filename: string; body: string; contentType: string; dataUrl: string };
  rewrite: undefined | { url: undefined | string };  // $removeparam result
  exception: NetworkFilter | undefined;
  filter: NetworkFilter | undefined;
  metadata: IPatternLookupResult[] | undefined;      // only with TrackerDB metadata (CC BY-NC-SA, don't ship)
}
getCSPDirectives(request: Request): string | undefined;   // main_frame only (engine.js:822-870, check at :826)
matchAll(request: Request): Set<NetworkFilter>;
```

The precedence order (`engine.js:872-1062`) is: `$important`, then `$redirect`/`$redirect-rule`/`redirect=none`,
then normal filters, then exceptions (`@@`), then `$removeparam`. **`$removeparam` is only evaluated when the request is
not blocked** (`engine.js:945-1027`). These semantics were verified with `$SP/adblock-bench/feature-probe.mjs`:

- An `@@` exception with `domain=allowed.com` un-blocks the request. `match:false` is returned with `exception` set.
- `$important` beats `@@`.
- `$3p` does not match first-party requests.
- `||example.org^$removeparam=utm_source`, `||example.org^$removeparam=fbclid` and a generic `$removeparam=gclid`
  turn `https://example.org/p?utm_source=x&id=1&fbclid=abc&gclid=z` into `rewrite.url = "https://example.org/p?id=1"`.
  The `@@||keep.example.org^$removeparam=gclid` exception is honoured.

**Gotchas (all verified):**

1. `type` defaults to `'main_frame'` when omitted (`request.js:123`), and `main_frame` is always first-party
   (`request.js:104-107`). Forgetting `type` silently disables every `$third-party` rule.
2. An empty `sourceUrl` makes every request first-party (`request.js:108-117`). Always pass the initiator.
3. Fetch destination `'style'` is **not** a known type (`NORMALIZED_TYPE_TOKEN`, `request.js:18-55`). A
   `$stylesheet` filter did *not* match `type:'style'` but did match `type:'stylesheet'`. Map destinations yourself.
4. Type `'document'` is not a main frame for `isMainFrame()` (`request.js:234-236`), so `getCSPDirectives` returns
   undefined for it. Use `'main_frame'` for top-level documents.
5. WebSocket and `data:` URLs are `isSupported`.

Destination → type mapping for GNOME (implemented and verified in the SW test, `$SP/adblock-bench/browser/www/sw.js`):

```ts
import type { RequestType } from '@ghostery/adblocker';
const DEST_TO_TYPE: Record<string, RequestType> = {
  '': 'xmlhttprequest',       // fetch/XHR/sendBeacon/EventSource/<a ping>
  document: 'main_frame', iframe: 'sub_frame', frame: 'sub_frame', fencedframe: 'sub_frame',
  script: 'script', worker: 'script', sharedworker: 'script', serviceworker: 'script',
  audioworklet: 'script', paintworklet: 'script', json: 'script', // Ghostery maps Firefox 'json' to script
  style: 'stylesheet', image: 'image', font: 'font',
  audio: 'media', video: 'media', track: 'other',
  object: 'object', embed: 'object', report: 'csp_report',
  manifest: 'other', xslt: 'other', webidentity: 'other',
};
// Scramjet: the GNOME tab's top-level proxied page is destination "iframe" with parsed.isIframe === false.
export function toAdblockType(destination: string, scramjetIsIframe?: boolean): RequestType {
  if (destination === 'iframe' && scramjetIsIframe === false) return 'main_frame';
  return DEST_TO_TYPE[destination] ?? 'other';
}
```

Initiator (`sourceUrl`):

- Subresources: `parsed.clientUrl.href`.
- Sub-frame navigations: the un-rewritten `request.rawReferrer`. Scramjet sets `Referrer-Policy: unsafe-url` on proxied
  documents (`core/src/fetch/headers.ts:112-114`), so the full parent URL is available (UNVERIFIED for all cases).
- `main_frame`: the URL itself.

### 2.7 Redirect resources and scriptlets (`Resources`)

- Format: `Resources.parse(data, { checksum })` expects **JSON** `{ redirects: [{name, aliases[], body, contentType}], scriptlets: [{name, aliases[], body, dependencies[], executionWorld?, requiresTrust?}] }`
  (`resources.js:140-173`). Load it with `engine.updateResources(jsonText, checksum)`. It is serialized with the engine
  (verified round-trip).
- Source. The content is uBO's redirect resources and scriptlets (GPL-3.0), compiled by Ghostery:
  - **Recommended: the content-addressed Ghostery CDN.**
    - Fetch `https://cdn.ghostery.com/adblocker/resources/ublock-resources-json/metadata.json` and take
      `revisions.at(-1)`.
    - Then fetch `https://cdn.ghostery.com/adblocker/resources/ublock-resources-json/<rev>/list.txt`.
    - The revision is the SHA-256 of the content (verified: `c4c0a51a…84da`, Last-Modified 2026-11-05, 65 redirects,
      153 scriptlets, parses and works with 2.20.3).
    - Ghostery's own updater uses this scheme: `packages/adblocker/assets/update.js`, run daily by `.github/workflows/assets.yml`.
  - Fallback: the repo copy `.../assets/ublock-origin/resources.json` (183,850 B; 45,906 B gzip; 63 redirects,
    149 scriptlets; last updated 2026-08-14).
- Without resources, `getResource()` falls back to `@remusao/small` MIME stubs (`resources.js:231-246`). Verified:
  `$redirect=noop.js` returned `MIME_TYPE_STUB.js` with an empty body. Blocking still works but is less faithful.
- `redirect.body` is base64 text when `contentType` contains `;base64`. Some entries are malformed (for example
  `video/flv;base64;base64`). To build a `Response`, decode with the `contentType.includes(';base64')` check, or simply
  `await fetch(redirect.dataUrl)`.
- **Trusted scriptlets are not gated.** `CosmeticFilter.getScript()` (`filters/cosmetic.js:804-820`) substitutes
  arguments without checking `requiresTrust`. Verified: `example.com##+js(trusted-set-cookie, consent, accepted)` from
  an arbitrary list was injected. uBO only allows `trusted-*` from its own lists. **GNOME must strip `+js(trusted-…)`
  lines from every list except `ublock-*` (and opt-in user filters) before parsing.** 34 of the 153 scriptlets in the
  current CDN build are `requiresTrust` (33 of 149 in the repo copy).
- Generic scriptlets (`##+js(...)` without a domain) are rejected at parse time (`filters/cosmetic.js:262-267`).
  `executionWorld: 'ISOLATED'` (22 scriptlets in the CDN build) is ignored. A proxy only has the main world.
- Verified in a plain page in both browsers (`$SP/adblock-bench/browser/www/scriptlet.html`):
  - `set-constant`: the page's later assignment was ignored.
  - `abort-on-property-read`: throws `ReferenceError`.
  - `json-prune`: removes keys.
  - Injected `<script id="ghostery-adblocker-script">` tags are auto-removed.
  - **Inside Scramjet frames: UNVERIFIED** (§6.5).

### 2.8 Cosmetic API

```ts
getCosmeticsFilters({ url, hostname, domain, ancestors, classes, hrefs, ids,
  getBaseRules = true, getInjectionRules = true, getExtendedRules = true,
  getRulesFromDOM = true, getRulesFromHostname = true, hidingStyle, callerContext }: {
  url: string; hostname: string; domain: string | null | undefined;
  ancestors?: { domain: string; hostname: string }[]; classes?: string[]; hrefs?: string[]; ids?: string[];
  getBaseRules?: boolean; getInjectionRules?: boolean; getExtendedRules?: boolean;
  getRulesFromDOM?: boolean; getRulesFromHostname?: boolean; hidingStyle?: string; callerContext?: any;
}): IMessageFromBackground;   // engine.d.ts:207-225, impl engine.js:606-657

interface IMessageFromBackground {   // @ghostery/adblocker-content index.d.ts
  active: boolean; scripts: string[]; styles: string;
  extended: { ast: AST; id: number; attribute?: string; directive?: AST }[];
}
```

- `styles` is ready-to-insert CSS. Selectors are grouped in chunks of **≤1024 per rule** (`engine/bucket/cosmetic.js:20-46`).
  The default style is `display: none !important;` (`filters/cosmetic.js:15`); override it with `hidingStyle`.
- Two-phase usage, as in Ghostery's WebExtension:
  1. At document start: `getRulesFromDOM:false`. This returns hostname-specific rules, the "base" generic stylesheet
     and scriptlets.
  2. Then feed `DOMMonitor` updates with `getBaseRules:false, getRulesFromHostname:false, getInjectionRules:false, classes, ids, hrefs`.
- Measured in Node over 1,685 frame hostnames:

| Engine | Base stylesheet | Hostname-only call | Host-specific CSS (p50 / p90 / max) | DOM-features call |
|---|---|---|---|---|
| EL+EP | 3,422 B | 14–15 µs | 267 / 371 / 3,282 B | 16–18 µs |
| gnome-default | 11,380 B | 36 µs | 1,385 / 1,535 / 3,986 B | 20 µs |

  The first call takes ~2–3 ms because it builds the base stylesheet lazily.
- **The DOM-less build hazard (verified).** `isValidCss` only validates when `document` exists
  (`filters/cosmetic.js:70-92`). Builds in Node, a Worker or a SW therefore accept invalid selectors:

| Measurement | Result |
|---|---|
| EL+EP cosmetic filters kept (DOM-less build vs page with DOM) | 24,514 vs 24,474. All 40 extra are EasyList's "ABP CSS injection filters" in the form `domain##selector {style}` |
| CSS parsing of a Node-built gnome-full engine (1,153 hostnames) | **8 hosts lost whole chunks**, 309 selectors in total (c.bing.com, hitomi.la, mirror.co.uk, w3schools.com, player.twitch.tv, twitch.tv, wunderground.com, fivethirtyeight.abcnews.go.com). A rougher rule-count check flagged 11; 3 of those (facebook.com) were counting artifacts |
| Exact validation via `CSSStyleSheet.insertRule(sel + '{}')` over 55,840 plain selectors | **45 invalid**: 44 ABP `{style}` rules plus 1 procedural `:matches-css-before()` nested in `:has()` that Ghostery misclassified as plain CSS. 48.7 ms (Chromium), 90 ms (Firefox) |
| `CSS.supports('selector(…)')` as a validator | Unusable: it rejects selector *lists* (439 false negatives) |

  The ABP rules are worse than "ignored". A rule like `.good,\n.bad {top:0} { display: none !important; }` makes the
  browser apply `top:0` to `.good` and drop the hide (verified in `$SP/adblock-bench/update-check.mjs`).
  **Mitigation (§6.1):** convert `##sel {style}` to `##sel:style(style)` before parsing, then validate selectors on the
  main thread and remove bad ones with `engine.update({ removedCosmeticFilters: ids })` (verified to work).

### 2.9 HTML filtering

- `getHtmlFilters(request: Request): HTMLSelector[]` (`engine.js:548-604`) requires `enableHtmlFiltering:true`. It
  returns `['script', patterns[]]` for `##^script:has-text(...)` and `['replace', [RegExp, replacement]]` for
  `$replace=`. Only `^script:has-text()` is supported; `##^.ad` is dropped.
- `new StreamingHtmlFilter(selectors)` with `.write(chunk)` and `.flush()` filters raw HTML text. Verified: it removed
  `<script>if(adblock){nag()}</script>` and `<div class="promo">…</div>` while keeping other scripts. 137 `##^`
  filters in gnome-default are unsupported variants.

### 2.10 Supported and unsupported filter syntax (verified)

Network options accepted (`filters/network.js:571-860`). An unknown option makes `NetworkFilter.parse` return `null`,
so the **whole filter is dropped** (`:841`):

- Party and domain: `to`, `denyallow`, `domain`/`from`, `3p`/`third-party`, `1p`/`first-party`.
- Priority and control: `badfilter`, `important`, `match-case`.
- Rewrites and redirects: `redirect`, `redirect-rule` (with `:priority`), `removeparam` (no regex, no negation, `:773-780`),
  `replace`/`content`.
- CSP: `csp`, `inline-script`, `inline-font`.
- Cosmetic exceptions: `ehide`/`elemhide`, `shide`/`specifichide`, `ghide`/`generichide`.
- Types: `all` (does not add CSP), `image`, `media`, `object`, `other`, `ping`/`beacon`, `script`, `css`/`stylesheet`,
  `frame`/`subdocument`, `xhr`/`xmlhttprequest`, `websocket`, `font`, `doc`/`document`.

Cosmetic: `##`, `#@#`, `entity.*##`, `~domain`, `:has()` (native CSS), `:style()`, `##+js()` (domain-specific only)
and `##^script:has-text()`. **`#?#` and `#@?#` lines are dropped by the list parser** (`detectFilterType` classifies
them as AdGuard syntax: `lists.js:85-109`, with a TODO in the source), even though `CosmeticFilter.parse` accepts
them. The same selector written with `##` is kept (verified). The default and cookie lists contain 360 such lines
(EasyList 291, uBlock filters 12, EasyList Cookie 57) plus 2 `#@?#` lines in Unbreak. They mostly use `:has-text(`
(351) and `:has(` (99), so sanitation should rewrite `#?#`→`##` once extended selectors are enabled (§6.1.1).

With `loadExtendedSelectors`: `:has-text`, `:matches-path`, `:matches-attr`, `:matches-css(-before|-after)`, `:upward`,
`:xpath`, `:remove()`, `:remove-attr()`, `:remove-class()`. Dropped: `:min-text-length`, `:watch-attr`, `:others`,
`:contains`, `:-abp-*`, and `domain>>##` (allowed for scriptlets only).

Filters dropped from the **gnome-default** set (178,593 lines, 4,378 dropped; script
`$SP/adblock-bench/unsupported-samples.mjs`):

| Dropped construct | Count | Impact / GNOME mitigation |
|---|---:|---|
| `$popup` (plus ~600 combined like `$document,popup`) | 3,124 | Popups are a `window.open` concern. Optional GNOME popup blocker: build a second small engine from the `$popup` lines rewritten to `$document` and consult it in Scramjet's `window.open` hook (UNVERIFIED design) |
| cosmetic: invalid or unsupported | 385 | Mostly `#?#` procedural lines (303 in these lists) that the list parser drops. The rest use unsupported pseudo-classes (`:watch-attr`, `:min-text-length`, `:contains`, …) |
| `$urlskip` (uBO Privacy link-shortener skipping) | 242 | Optional ClearURLs `redirections` (§7.1) |
| `##^…` other than `script:has-text` | 137 | None |
| regex `$removeparam=/…/` | 74 | Built-in param list / ClearURLs (§7.1) |
| `$method` | 36 | Could pre-filter by method in our hook (rare) |
| `$ipaddress`, `$cname` | 32, 29 | Not possible client-side (no DNS) |
| `$popunder` | 24 | Same as `$popup` |
| `$uritransform` | 21 | None |
| `$header` | 12 | Response-header matching. Emulable in `preresponse` but not worth it |
| `$permissions` | 11 | Would need `Permissions-Policy`; Scramjet strips security headers |
| `$strict1p`, `$strict3p` | 13, 6 | Minor under-blocking |
| `$rewrite` (ABP) | 10 | Minor |

### 2.11 `@ghostery/adblocker-content` (content-side helpers)

`dist/esm/index.d.ts`:

```ts
export function extractFeaturesFromDOM(roots?: Element[]): { classes: string[]; hrefs: string[]; ids: string[] };
export class DOMMonitor {
  constructor(cb: (update: { type: 'features'; ids: string[]; classes: string[]; hrefs: string[] } | { type: 'elements'; elements: Element[] }) => void);
  queryAll(window: Pick<Window, 'document'>): void;
  start(window: Pick<Window, 'document'> & { MutationObserver?: typeof MutationObserver }): void;
  stop(): void;
  handleNewFeatures({ hrefs, ids, classes }): boolean;
}
export function autoRemoveScript(script: string): string;   // try{…}catch{}; removes document.currentScript
export function injectScript(s: string, doc: Document): void; // inline <script id="ghostery-adblocker-script">; Firefox path uses a Blob URL
```

- `DOMMonitor.start(win)` uses the *frame's* `MutationObserver`, so it works when the plugin, running in the controller
  realm, passes a proxied same-origin `window` (verified in a normal page).
- **Do not use `injectScript` inside Scramjet frames.** It bypasses Scramjet's JS rewriting, and its Firefox branch
  goes through `URL.createObjectURL`, which Scramjet hooks. Inject scriptlets through the HTML rewriter instead (§6.5).
- Reference implementation for the full content side (two-phase cosmetics, extended selectors, scriptlets):
  `@ghostery/adblocker-webextension-cosmetics` 2.20.3 (MPL-2.0).

---

## 3. Benchmarks

### 3.1 Method

- **Lists:** downloaded 2026-11-09 ≈22:50 UTC into `$SP/filters/` (§5.1).
- **Node benchmark:** `$SP/adblock-bench/bench-node.mjs` reports parse ×4 (first and warm median), serialize ×5,
  deserialize ×15, per-request latency and cosmetics. `$SP/adblock-bench/cold-start.mjs` runs a fresh process.
  `$SP/adblock-bench/match-sample.mjs` runs other samples.
- **Realistic URL sample #1:** `brave/adblock-rust` `data/requests.json`. This is the standard adblock benchmark corpus,
  committed 2019-03-15. It has **242,945 requests** `{frameUrl, url, cpt}` over 1,688 frame hosts. Types: image 113,607,
  script 71,401, xhr 19,931, document 15,891, stylesheet 10,759, font 6,481, other 2,655, fetch 1,600, media 556, …
  It is old and ad-heavy.
- **Realistic URL sample #2 (fresh):** `$SP/adblock-bench/crawl.mjs`. Headless Chromium visited 20 popular sites
  without blocking, recording **15,622 requests** (2026-11-09). Types: image 9,146, sub_frame 2,459, script 1,903,
  fetch 1,133, xhr 441, ping 156, … Several sites (imdb, forbes, dailymail, accuweather, nytimes) served bot pages.
- Run-to-run variance was about ±5–10 %. Single-threaded throughput.

### 3.2 Node results (Brave corpus, 242,945 requests)

| Preset | List text | Network / cosmetic filters | Parse first / warm | Match only | End-to-end (`fromRawDetails`+`match`) | Latency p50 / p90 / p99 / p99.9 | Blocked | Redirected / rewritten |
|---|---:|---|---|---:|---:|---|---:|---|
| EasyList+EasyPrivacy | 3,540,288 B | 105,004 / 24,519 | 303 / **228 ms** | 133 k/s (7.5 µs) | **123 k/s** | 5.8 / 13.6 / 38 / 104 µs | 43.3 % | 170 / 0 |
| EL+EP network-only | 3,540,288 B | 105,004 / 0 | 247 / 190 ms | 138 k/s | 127 k/s | 5.7 / 13.1 / 36 / 101 µs | 43.3 % | 170 / 0 |
| gnome-ads (§5.2 Ad blocker) | 5,245,969 B | 65,074 / 42,687 | 337 / 260 ms | 67 k/s (14.9 µs) | 62 k/s | 11 / 29 / 73 / 231 µs | 37.8 % | 3,626 / 0 |
| **gnome-default** (ads + trackers + URL params) | 6,305,848 B | 125,512 / 43,093 | 439 / **322 ms** | 55 k/s (18.2 µs) | **52 k/s** | 13 / 38 / 74 / 211 µs | 45.3 % | 7,299 / 533 |
| gnome-full (+ cookie notices) | 9,052,602 B | 127,752 / 74,297 | 578 / 446 ms | 50 k/s (20 µs) | 47 k/s | 15 / 40 / 88 / 266 µs | 45.6 % | 7,301 / 533 |

- `Request.fromRawDetails` costs 1.3–1.5 µs per request; its tldts parse is included in the end-to-end column.
- `getCSPDirectives` costs ≈2.5–2.9 µs per main frame. No main frame in the corpus matched a `$csp` filter.
- Fresh-process cold start for gnome-default: import 29.5 ms, deserialize 12.0 ms, first match 6.9 ms, next 999 matches
  105 ms, next 19,000 matches 445 ms.

### 3.3 Node results (2026 crawl, 15,622 requests)

| Engine | Blocked | Redirected | Throughput |
|---|---:|---:|---:|
| EL+EP | 72.4 % | 2 | 87 k req/s (11.5 µs) |
| gnome-ads | 69.3 % | 287 | 54 k req/s (18.6 µs) |
| gnome-default | 74.5 % | 314 | 57 k req/s (17.4 µs) |
| gnome-full | 74.9 % | 314 | 40 k req/s (24.8 µs) |

The top blocked hosts are cookie-sync and ad-tech endpoints (`cm.g.doubleclick.net`, `pagead2.googlesyndication.com`,
`x.bidswitch.net`, `sync.1rx.io`, …). The block percentage is inflated because nothing was blocked during the crawl.
With blocking on, the ad-tech cascade never starts.

**Budget.** A heavy page has ~150–300 requests. At ~15–25 µs each that is **2–8 ms of main-thread CPU per page load**
in the Scramjet controller, plus ~40 µs and one style insertion per frame for cosmetics. This is acceptable.

### 3.4 Per-list parse cost (Node, `loadExtendedSelectors:true`, `$SP/adblock-bench/results/per-list.json`)

| List | Bytes | Parse | Network | Cosmetic | removeparam | Serialized |
|---|---:|---:|---:|---:|---:|---:|
| EasyList | 2,024,394 | 285 ms | 48,447 | 24,482 | 0 | 2,952,041 |
| EasyPrivacy | 1,515,893 | 218 ms | 56,557 | 36 | 0 | 2,258,009 |
| uBlock filters (CDN `.min`, includes inlined) | 1,949,317 | 290 ms | 6,398 | 16,920 | 39 | 1,823,741 |
| uBlock Privacy (`.min`) | 141,012 | 20 ms | 1,228 | 360 | 215 | 127,517 |
| uBlock Badware (`.min`) | 164,773 | 20 ms | 4,603 | 143 | 0 | 216,769 |
| uBlock Quick fixes (`.min`) | 80,437 | 8 ms | 140 | 270 | 0 | 67,525 |
| uBlock Unbreak (`.min`) | 178,675 | 17 ms | 1,850 | 606 | 9 | 145,281 |
| Peter Lowe (ABP) | 70,409 | 7 ms | 3,560 | 0 | 0 | 121,909 |
| AdGuard/uBO URL Tracking (uBO fork) | 180,930 | 17 ms | 2,650 | 1 | 2,649 | 111,129 |
| AdGuard URL Tracking (17) | 183,589 | 7 ms | 2,692 | 1 | 2,691 | 112,693 |
| EasyList Cookie (uBO mirror) | 1,219,160 | 103 ms | 2,114 | 26,020 | 0 | 1,461,041 |
| uBlock Cookie Notices | 378,567 | 11 ms | 82 | 2,329 | 0 | 332,749 |
| AdGuard Cookie Notices (18) | 1,488,812 | 136 ms | 2,890 | 17,765 | 0 | 1,539,657 |
| uBlock Other annoyances | 424,181 | 30 ms | 294 | 3,289 | 2 | 291,185 |
| Fanboy Annoyance (uBO, flattened) | 2,567,887 | 201 ms | 4,169 | 53,208 | 0 | 2,983,389 |
| AdGuard Base w/o EasyList (2_without_easylist) | 4,376,181 | 447 ms | 23,237 | 31,099 | 18 | 3,984,681 |
| **AdGuard Tracking Protection (3)** | **15,088,394** | **1,379 ms** | **437,207** | 752 | 0 | **19,981,061** |

The first rows (EasyList, EasyPrivacy, uBlock filters) include JIT warm-up. Smaller lists are dominated by fixed
overhead.

---

## 4. Alternatives

| Engine | Version / date | License | Browser/SW-ready? | Size | Notes |
|---|---|---|---|---|---|
| **`@ghostery/adblocker`** | 2.20.3, 2026-10-28 | MPL-2.0 | **Yes (verified, SW in Chromium + Firefox)** | **91 KB gz** | uBO-compatible; fast; zero-copy serialization. Gaps listed in §2.10 |
| Brave `adblock-rust` (crate `adblock`) | 0.13.5, 2026-10-28 | MPL-2.0 | **No maintained WASM build** | UNVERIFIED | Used by Brave; README claims "Compiling to native code or WASM"; `css-validation` feature validates selectors with Servo `cssparser`/`selectors` (no DOM needed). npm `adblock-rs` 0.13.5 is a **Node native addon** (neon), not browser-usable. Unofficial `adblock-wasm` 0.7.1 (2021/2022) and `adblock-rust-wasm` 0.1.0 (2024-09) are stale. Doing it ourselves means wasm-bindgen glue plus resource handling. No wasm32 std was available here, so it was not built |
| uBO's engine `@gorhill/ubo-core` | 0.1.30, last published 2024-10-07 | GPL-3.0-or-later | Node-oriented | – | Static network engine only (no cosmetic or scriptlet pipeline outside the extension); stale on npm |
| AdGuard `@adguard/tsurlfilter` | 6.0.4, 2026-10-15 | GPL-3.0-only | Yes (used by AdGuard's extension) | 1,318,374 B min / **302,269 B gz** / 213,623 B br (Engine+RuleStorage+Request; bundles `@adguard/scriptlets` 643 KB and `@adguard/agtree` 315 KB) | Richest syntax. It exports `CookieModifier`, `RemoveHeaderModifier`, `RemoveParamModifier`, `UrlTransformModifier`, `ReplaceModifier`, `CSP_HEADER_NAME`, `PERMISSIONS_POLICY_HEADER_NAME`, `HTTPMethod`, `StealthOptionName`. 3.3× Ghostery's size. Best fit for AdGuard-syntax lists. Behaviour not benchmarked here |
| `@cliqz/adblocker` | 1.34.0, 2024-10-17 | MPL-2.0 | – | – | Predecessor of Ghostery's package (renamed). Do not use |

**Recommendation: Ghostery.**

- **License:** permissive enough to vendor into anything. GNOME's frontend will be AGPL anyway because Scramjet is
  AGPL-3.0-only (`packages/core/package.json`). MPL-2.0 and GPL-3.0 are compatible with AGPL-3.0.
- **Size:** smallest, at 91 KB gzip.
- **Runtime:** already proven in SWs. Its serialization makes the "build once, load in ~10 ms everywhere" model trivial.
- **Re-evaluate tsurlfilter** only if `$removeheader`, `$cookie` or regex `$removeparam` become must-haves.
- **Re-evaluate adblock-rust/WASM** only if per-request CPU becomes a problem. It does not at 2–8 ms per page.

---

## 5. Filter lists

### 5.1 Catalogue (verified with `curl -I`/GET on 2026-11-09; headers in `$SP/filters/headers/*.hdr`)

Prefer the **uBO CDN mirrors** (`https://ublockorigin.github.io/uAssetsCDN/...`, fallbacks `https://ublockorigin.pages.dev/...`
and `https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssetsCDN@main/...`). They have **`!#include` already inlined**.
Verified: `filters.min.txt` has 0 includes and the same 24,119 rules as our self-flattened copy, and the
`easylist-cookies.txt` mirror contains all 2,856 lines of `easylist_cookie_specific_uBO.txt`. These are the same URLs
uBO itself uses (`gorhill/uBlock` `assets/assets.json`).

| GNOME id (uBO key) | Title | Primary URL (status) | Mirror / alt | Bytes · lines | gzip · brotli | `! Expires` | License |
|---|---|---|---|---|---|---|---|
| `easylist` | EasyList | `https://easylist.to/easylist/easylist.txt` (200, max-age 7200) | `https://ublockorigin.github.io/uAssetsCDN/thirdparties/easylist.txt` (200, 2,020,442 B); `https://easylist-downloads.adblockplus.org/easylist.txt` (200) | 2,024,394 · 76,487 | 701,847 · 596,482 | 4 days (releases several times a day, e.g. Version 202611092246) | **Dual GPL-3.0-or-later / CC BY-SA 3.0 or later**; attribution "The EasyList authors (https://easylist.to/)" (licence page, Wayback 2026-10-25; live page is behind a Cloudflare JS challenge) |
| `easyprivacy` | EasyPrivacy | `https://easylist.to/easylist/easyprivacy.txt` (200) | `https://ublockorigin.github.io/uAssetsCDN/thirdparties/easyprivacy.txt` (1,504,700 B, Expires 6 d, has `Diff-Path`) | 1,515,893 · 57,371 | 448,576 · 378,594 | 4 days | same as EasyList |
| `ublock-filters` | uBlock filters – Ads | `https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt` (200, 1,949,317 B) | raw `https://ublockorigin.github.io/uAssets/filters/filters.txt` (469,921 B, **10 `!#include`**: filters-general, 2020…2026, ubo-link-shorteners, mobile) | 1,949,317 · 26,376 | 556,909 · 428,404 | 5 days (`Diff-Expires` ≈5 h) | GPL-3.0 (uAssets) |
| `ublock-badware` | uBlock filters – Badware risks | `https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt` | raw `.../uAssets/filters/badware.txt` (273,715 B) | 164,773 · 5,106 | 52,268 · 46,644 | 5 days | GPL-3.0 |
| `ublock-privacy` | uBlock filters – Privacy | `https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt` | raw `.../uAssets/filters/privacy.txt` (185,665 B, includes `resource-abuse.txt`) | 141,012 · 2,218 | 37,757 · 33,347 | 7 days | GPL-3.0 |
| `ublock-unbreak` | uBlock filters – Unbreak | `https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt` | raw `.../unbreak.txt` (282,165 B) | 178,675 · 2,884 | 55,433 · 47,553 | 5 days | GPL-3.0 |
| `ublock-quick-fixes` | uBlock filters – Quick fixes | `https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt` | raw `.../quick-fixes.txt` (86,126 B, Expires 8 h) | 80,437 · 534 | 20,629 · 18,110 | 12 hours | GPL-3.0 |
| `adguard-spyware-url` | AdGuard/uBO – URL Tracking Protection (uBO fork of AdGuard TrackParamFilter) | `https://ublockorigin.github.io/uAssetsCDN/filters/privacy-removeparam.txt` | `https://ublockorigin.github.io/uAssets/filters/privacy-removeparam.txt` | 180,930 · 4,029 | 39,776 · 33,939 | 7 days | GPL-3.0 |
| `adguard-url-17` | AdGuard URL Tracking filter | `https://filters.adtidy.org/extension/ublock/filters/17.txt` (200) | `/extension/chromium/filters/17.txt` | 183,589 · 4,056 | 39,426 · 33,650 | 5 days | GPL-3.0 (AdguardFilters) |
| `plowe-0` | Peter Lowe's ad & tracking server list | `https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext` (200, max-age 3600) | hosts format `…hostformat=hosts…` | 70,409 · 3,579 (3,560 hostnames) | 23,413 · 20,947 | none (Last modified 2026-11-07; uBO uses `updateAfter: 13` days) | **No explicit license.** The homepage says "Feel free to combine this list with yours or lists from other sites and put it up on the web"; uBO and Ghostery redistribute it (legal status UNVERIFIED) |
| `fanboy-cookiemonster` | EasyList – Cookie Notices | `https://ublockorigin.github.io/uAssetsCDN/thirdparties/easylist-cookies.txt` (200, flattened) | `https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt` (1,218,647 B, 1 include → 1,533,535 B flattened, Expires 9 d) | 1,219,160 · 29,132 | 386,538 · 333,579 | 7 days | Fanboy header: CC BY 3.0; mirror header points to the EasyList licence (UNVERIFIED which governs) |
| `ublock-cookies` | uBlock filters – Cookie Notices | `https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt` (CDN copy identical) | – | 378,567 · 5,810 | 110,483 · 90,653 | 7 days | GPL-3.0. **2,024 of its 2,171 scriptlets are `trusted-*`** (953 `trusted-set-cookie`, 901 `trusted-click-element`) |
| `adguard-cookies` | AdGuard Cookie Notices | `https://filters.adtidy.org/extension/ublock/filters/18.txt` | – | 1,488,812 · 23,813 | 435,930 · 348,082 | 5 days | GPL-3.0 |
| `ublock-annoyances-others` | uBlock filters – Other annoyances | `https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt` | – | 424,181 · 8,377 | 87,753 · 73,396 | 7 days | GPL-3.0 |
| `fanboy-annoyance` | Fanboy's Annoyance List | `https://secure.fanboy.co.nz/fanboy-annoyance_ubo.txt` (4 includes) | `https://easylist.to/easylist/fanboy-annoyance.txt` (200) | 2,183,530 (2,567,887 flattened) · 56,501 | 687,565 · 574,296 | 9 days | CC BY 3.0 (header) |
| `fanboy-social` | Fanboy Social | `https://secure.fanboy.co.nz/fanboy-social_ubo.txt` | `https://easylist.to/easylist/fanboy-social.txt` (200) | 406,783 · 14,150 | 117,785 · 103,665 | 9 days | CC BY 3.0 (header) |
| `adguard-generic` | AdGuard Base (w/o EasyList) | `https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt` | `.../filters/2.txt` (with EasyList: 6,442,769 B, 147,368 lines) | 4,376,181 · 71,220 | 1,111,769 · 840,669 | 5 days | GPL-3.0 |
| `adguard-tracking` | AdGuard Tracking Protection | `https://filters.adtidy.org/extension/ublock/filters/3.txt` | – | **15,088,394 · 441,641** | 3,506,192 · 2,857,079 | 5 days | GPL-3.0 |
| `clearurls` | ClearURLs rules (JSON, not ABP) | `https://rules2.clearurls.xyz/data.minify.json` (200, max-age 600) + SHA-256 at `https://rules2.clearurls.xyz/rules.minify.hash` (verified equal) | `https://gitlab.com/ClearURLs/rules/-/raw/master/data.min.json` (106,346 B) | 37,423 · 206 providers, 733 param regexes, 10 "complete providers" | 8,174 · 7,455 | n/a | LGPL-3.0 (ClearURLs/Rules) |
| `dandelion-lus` | Actually Legitimate URL Shortener | `https://raw.githubusercontent.com/DandelionSprout/adfilt/master/LegitimateURLShortener.txt` | – (1 include, AdGuard-only) | 305,851 · 5,828 (3,126 `removeparam`, 229 regex) | 99,474 · 83,032 | 12 hours | Dandelicence 1.4 (custom permissive, attribution) |
| `ubo-resources` | uBO redirect resources + scriptlets (Ghostery JSON build) | `https://cdn.ghostery.com/adblocker/resources/ublock-resources-json/metadata.json` → `…/<sha256>/list.txt` | `https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json` | 183,850 (repo copy) | 45,906 · 38,843 | follow library releases | GPL-3.0 (uBlock Origin) |

Licences checked via the GitHub API (2026-11-09): AdguardTeam/AdguardFilters GPL-3.0; uBlockOrigin/uAssets GPL-3.0;
ClearURLs/Rules LGPL-3.0. **Non-commercial lists to avoid bundling** (all CC BY-NC-SA 4.0): Disconnect
(`disconnectme/disconnect-tracking-protection`), DuckDuckGo Tracker Radar, Ghostery TrackerDB (`ghostery/trackerdb`,
which also powers `FiltersEngine.fromTrackerDB` and `match(..., withMetadata)`).

Update politeness. Upstream HTTP validators are weak or unhelpful: GitHub Pages ETags change on every deploy, and
Peter Lowe sends no ETag. **Compare by SHA-256 of the content**, honour `! Expires`, and send a descriptive
`User-Agent`. One GNOME backend fetches once for all its users, which is friendlier than per-browser updates.

### 5.2 Recommended defaults (balanced breakage)

| GNOME extension / toggle | Default | Lists | Rationale |
|---|---|---|---|
| **Ad blocker** | **ON** | `easylist`, `ublock-filters`, `ublock-badware`, `ublock-quick-fixes`, `ublock-unbreak`, `plowe-0` (+ `ubo-resources`) | uBO's default ad set. `unbreak` and `quick-fixes` exist to keep breakage low; badware blocks scam pages (needs the interstitial, §6.2) |
| **Tracker blocker** | **ON** | `easyprivacy`, `ublock-privacy` | Includes fingerprinting vendors (`fpjs.io`, `fpcdn.io`, `openfpcdn.io`, `fpjscdn.net`, `fingerprintjs.com/visitors/`), CNAME-cloaked tracker subdomains and crypto-mining |
| **Privacy protection → strip tracking params** | **ON** | `adguard-spyware-url` (uBO fork) + GNOME built-in list (§7.1) | 2,649 `$removeparam` rules. Note: neither AdGuard nor uBO lists strip `utm_source/medium/campaign` (verified) |
| **Cookie notices** | **OFF (opt-in)** | v1: `fanboy-cookiemonster` (CSS-heavy: 26,020 cosmetic, 2,468 scriptlets). v2 (scriptlets verified in Scramjet): add `ublock-cookies` (trusted list) | Hiding consent dialogs without scriptlets often leaves `overflow:hidden` or overlays, which is breakage. uBO also ships these off |
| Annoyances | OFF | `ublock-annoyances-others`, EasyList annoyances | – |
| Not offered by default | – | `adguard-tracking` (20 MB engine, 1.4 s parse, mostly duplicates/CNAME), `adguard-generic` (overlaps EasyList), NC-licensed lists | Cost or licence |

Measured cost of the defaults (gnome-default, §3.2):

- **6.3 MB of text, about 1.6 MB brotli / 1.9 MB gzip on the wire.**
- 125,512 network and 43,093 cosmetic filters.
- Parse 322 ms in Node, and roughly 0.4–0.6 s in a browser Worker (UNVERIFIED extrapolation from the EL+EP
  SW numbers). Parsing the gnome-full lists on the page main thread with DOM validation measured 995 ms in
  Chromium, which is why the build belongs in a Worker.
- 8.0 MB serialized; 12 ms cold deserialize; ~52 k req/s.

---

## 6. Integration design

### 6.1 Engine lifecycle

```
Rust backend (tokio interval)                          Browser
───────────────────────────                          ──────────────────────────────────────────────
for each enabled list:                                GNOME page (top level, owns Scramjet Controller)
  if now >= expires_at: GET primary (→ mirrors)        1. GET /api/content-blocking/manifest.json
  flatten !#include (non-CDN sources only)             2. key = sha256(ENGINE_VERSION, preset, list sha256s,
  sha256(body) → store in SQLite                            resources sha256, config, env)
  expires_at = now + clamp(Expires, 4h, 7d)+jitter     3. Cache Storage hit? → bytes. Miss → Builder Worker:
serves:                                                     fetch lists → sanitize (§6.1.1) → FiltersEngine.parse
  /api/content-blocking/manifest.json                       → updateResources → post plain selectors to main
  /api/content-blocking/lists/{id}.txt (ETag=sha256)       → main: insertRule validation (≈50–90 ms) → ids back
  /api/content-blocking/resources.json                      → engine.update({removedCosmeticFilters}) → serialize
                                                            → caches.open('gnome-content-blocking-v1').put(...)
                                                       4. FiltersEngine.deserialize(bytes); engine.updateEnv(env);
                                                          warm-up; register plugin. UV SW loads the same bytes
                                                          from Cache Storage lazily on first fetch (fail-open).
```

- The backend never runs JS; it is a cache.
- The client rebuilds only when a list's SHA-256 changes (at most a few times a day).
- If the engine is not ready, requests are **allowed** (fail-open).

#### 6.1.1 List sanitation

Apply this before parsing, in the backend or the worker. The ABP CSS conversion was verified (converting every
`{style}` to `:style()`; the `{remove:true}` special case below is a refinement): it reduced broken hosts from 8 to 1
(309 to 38 lost selectors). The remaining one is the misclassified procedural selector on c.bing.com, caught by
insertRule validation.

```ts
const ABP_CSS = /^([^#\s]*)(#@?#)(?![+^])(.+?)\s*\{([^{}]*)\}\s*$/;   // domain##selector {style}
export function sanitizeList(text: string, opts: { trusted: boolean; extended: boolean }): string {
  return text.split('\n').map((line) => {
    if (!opts.trusted && /#@?#\+js\(\s*trusted-/.test(line)) return '';       // trusted scriptlets: uBO lists only
    if (opts.extended) line = line.replace(/^([^#\s]*)#(@?)\?#/, '$1#$2#');    // #?# / #@?# are dropped by Ghostery's list parser
    const m = ABP_CSS.exec(line);
    if (m && !m[3].includes(':style(')) {
      const style = m[4].trim();
      if (/^remove\s*:\s*true;?$/.test(style))                               // ABP {remove:true}
        return opts.extended ? `${m[1]}${m[2]}${m[3]}:remove()` : `${m[1]}${m[2]}${m[3]}`; // remove, or plain hide
      return `${m[1]}${m[2]}${m[3]}:style(${style})`;
    }
    return line;
  }).join('\n');
}
```

Main-thread validator (`CSSStyleSheet.insertRule` is the exact stylesheet parser; `CSS.supports('selector()')` is not usable):

```ts
export function invalidSelectorIds(pairs: Array<[id: number, selector: string]>): number[] {
  const sheet = new CSSStyleSheet(); const bad: number[] = [];
  for (const [id, sel] of pairs) { try { sheet.insertRule(sel + '{}', 0); sheet.deleteRule(0); } catch { bad.push(id); } }
  return bad;
}
// worker side: pairs = engine.getFilters().cosmeticFilters.filter(f => !f.isScriptInject() && !f.isExtended()).map(f => [f.getId(), f.getSelector()])
// then: engine.update({ removedCosmeticFilters: bad })
```

### 6.2 Scramjet plugin (sketch; API names verified in source, code not compiled against Scramjet: UNVERIFIED)

```ts
import { ManagedPlugin, type Frame } from '@mercuryworkshop/scramjet-controller';
import { ScramjetHeaders } from '@mercuryworkshop/scramjet';
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { DOMMonitor } from '@ghostery/adblocker-content';
import { getDomain } from 'tldts-experimental';               // already in the bundle via Ghostery

export class GnomeContentBlocker extends ManagedPlugin {
  private topUrl: URL | null = null;
  constructor(private getEngine: () => FiltersEngine | null, private policy: Policy) { super('gnome-content-blocker', []); }

  install(frame: Frame) {
    super.install(frame);
    const H = frame.hooks;

    // 1) network blocking (core/src/fetch/fetch.ts:37-49)
    this.tap(H.fetch.intercept, ({ request, parsed }, props) => {
      const engine = this.getEngine(); if (!engine) return;                       // fail-open
      const type = toAdblockType(parsed.destination, parsed.isIframe);
      if (type === 'main_frame') this.topUrl = parsed.url;
      if (!this.policy.blockingEnabledFor(this.topUrl)) return;                   // per-site allowlist (top-level site)
      const sourceUrl = type === 'main_frame' ? parsed.url.href
        : parsed.clientUrl?.href ?? this.unrewrite(request.rawReferrer) ?? '';
      const r = engine.match(Request.fromRawDetails({ url: parsed.url.href, type, sourceUrl }));
      this.policy.count(this.frame, type, r);                                     // badge/stats
      if (r.match) {
        props.response = r.redirect
          ? redirectResponse(r.redirect)                                          // 200 + resource body
          : type === 'main_frame' || type === 'sub_frame'
            ? interstitial(parsed.url, r.filter)                                  // "Blocked by GNOME" HTML, "proceed" button
            : { body: '', status: 200, statusText: 'OK', headers: blockedHeaders() };
      } else if (r.rewrite?.url && (type === 'main_frame' || type === 'sub_frame')) {
        props.response = redirect307(r.rewrite.url, frame, parsed);               // page sees the clean URL
      } else if (r.rewrite?.url) {
        (parsed as any).gnomeRewrite = r.rewrite.url;                             // applied in the request hook
      }
    });

    // 2) outgoing request headers/URL (fetch.ts:191-214) — see §7
    this.tap(H.fetch.request, (ctx, props) => {
      if ((ctx.parsed as any).gnomeRewrite) props.url = new URL((ctx.parsed as any).gnomeRewrite);
      applyPrivacyHeaders(props.init, ctx, this.topUrl, this.policy);             // Sec-GPC, 3P Cookie strip, Referer trim
    });

    // 3) drop 3P Set-Cookie before Scramjet stores it (fetch.ts:216-229, handleCookies at :71)
    this.tap(H.fetch.preresponse, (ctx, props) => {
      if (this.policy.blockThirdPartyCookies && isThirdParty(ctx.parsed.url, this.topUrl))
        (props.response as any).rawHeaders = props.response.rawHeaders.filter(([k]) => k.toLowerCase() !== 'set-cookie');
    });

    // 4) cosmetics inside every proxied window (controller/src/inject.ts:355-364)
    this.tap(H.init.post, ({ window: win, client }) => {
      const engine = this.getEngine(); if (!engine || !this.policy.cosmeticsEnabledFor(this.topUrl)) return;
      const url = client.url as URL; const hostname = url.hostname; const domain = getDomain(hostname) ?? hostname;
      const base = engine.getCosmeticsFilters({ url: url.href, hostname, domain,
        getRulesFromDOM: false, getInjectionRules: false, getExtendedRules: false });
      const sheet = new win.CSSStyleSheet(); sheet.replaceSync(base.styles);
      win.document.adoptedStyleSheets = [...win.document.adoptedStyleSheets, sheet];
      const extra = new win.CSSStyleSheet(); win.document.adoptedStyleSheets = [...win.document.adoptedStyleSheets, extra];
      let css = '';
      new DOMMonitor((u) => {
        if (u.type !== 'features') return;
        const r = engine.getCosmeticsFilters({ url: url.href, hostname, domain, classes: u.classes, ids: u.ids, hrefs: u.hrefs,
          getBaseRules: false, getRulesFromHostname: false, getInjectionRules: false, getExtendedRules: false });
        if (r.styles) { css += '\n' + r.styles; extra.replaceSync(css); }
      }).start(win);
    });
  }
}
```

Notes:

- **Real network errors for blocked subresources.** The controller path can only return a synthetic response.
  `route()` returns `new Response(body, {status, headers})` (`controller/src/sw.ts:197-201`). To make blocked
  subresources behave like `ERR_BLOCKED_BY_CLIENT`, set a private header (for example `x-gnome-blocked: 1`) in
  `blockedHeaders()`. GNOME's own SW `fetch` listener then does:

  ```js
  const res = await route(event);
  return res.headers.get('x-gnome-blocked') ? Response.error() : res;
  ```

  Verified separately in plain SWs: `Response.error()` makes `<script>`/`<img>` fire `error` and `fetch()` reject.
  Header passthrough through the controller RPC is UNVERIFIED. Do not do this for navigations; show the interstitial.
- `new Response('', {status: 204})` throws (null-body status with a body). Use 200 with an empty body, or a null body.
- Per-site allowlisting must be keyed on the **top-level site of the tab** (`this.topUrl`), not on the request's frame.
  This mirrors uBO's per-site switch. Ghostery has no tab concept.
- Scramjet does not partition its cookie jar. Third-party decisions use `registrableDomain(parsed.url) !== registrableDomain(topUrl)`
  (`tldts`).
- The `this.tap(...)` callbacks run in the controller page realm. The `init.post` callback receives the proxied frame's
  `window` (same origin). Use that realm's constructors (`win.CSSStyleSheet`). Whether Scramjet's own DOM hooks
  interfere with `adoptedStyleSheets` is UNVERIFIED; fall back to a `<style>` element in `win.document.head`, which
  exists because Scramjet's inject script runs inside `<head>`.

### 6.3 Ultraviolet hooks (sketch, UNVERIFIED)

```js
// in GNOME's UV service worker, after `const uv = new UVServiceWorker();`
uv.on('request', (event) => {
  const ctx = event.data;                                   // RequestContext (uv.sw.js:327-361)
  // GNOME shows UV tabs in an <iframe> too, so the tab's top document arrives as destination 'iframe'. UV has no
  // isIframe flag: treat it as main_frame when the referrer is NOT a UV-proxied URL (i.e. it is the GNOME shell).
  const ref = ctx.request.referrer || '';
  const isTabTop = ctx.request.destination === 'iframe' && !ref.startsWith(location.origin + __uv$config.prefix);
  const type = toAdblockType(ctx.request.destination, isTabTop ? false : true);
  const sourceUrl = type === 'main_frame' ? ctx.url.href : (ctx.headers.referer || '');
  const r = engine?.match(Request.fromRawDetails({ url: ctx.url.href, type, sourceUrl }));
  if (r?.match) return event.respondWith(r.redirect ? fetch(r.redirect.dataUrl) : Response.error());
  if (thirdParty(ctx.url, topSiteOf(ctx))) delete ctx.headers.cookie;   // UV sends all cookies of the domain
  ctx.headers['sec-gpc'] = '1';
});
uv.on('beforemod', (event) => { if (thirdParty(...)) delete event.data.headers['set-cookie']; }); // before uv.sw.js:182
```

For cosmetics, in `uv.on('response')` (`uv.sw.js:276`) insert `<style>${styles}</style>` after `<head>` in
`event.data.body` when the destination is `document`/`iframe`. UV has no frame-init hook, so DOM-feature (generic
class/id) rules need a small script injected the same way.

### 6.4 Cosmetic filtering details

- **First paint:** put hostname rules plus the base stylesheet into the HTML (Scramjet `rewriter.html.pre`, appended to
  `<head>` as `<style>`). Then use DOMMonitor for generic class/id/href rules.
- Use `ancestors` for `>>` subframe scriptlets (v2).
- Respect `$generichide`/`$elemhide`. `getCosmeticsFilters` already applies `hideExceptions`
  (`matchCosmeticFilters`, `engine.js:695-764`).
- Extended (procedural) selectors arrive as ASTs in `extended[]` when `loadExtendedSelectors` is true. Evaluate them
  with `@ghostery/adblocker-extended-selectors` `querySelectorAll(root, ast)` plus a MutationObserver, as in
  `@ghostery/adblocker-webextension-cosmetics` (v2).

### 6.5 Scriptlets and HTML filtering (v2)

- **Scriptlets.** In `rewriter.html.pre`, insert `<script>${autoRemoveScript(script)}</script>` at the start of `<head>`.
  - The pre hook runs before `traverseParsedHtml`, so Scramjet will JS-rewrite the inline script like page code and map
    `location` and `document.cookie`.
  - The inject scripts are unshifted afterwards (`html.ts:240-263`), so the scriptlet runs after Scramjet's runtime but
    before page scripts.
  - This whole path is UNVERIFIED. Test it on YouTube-class sites before enabling. uBO filters contain 9,648
    scriptlet rules (40 % of rules), so ad-blocking quality on hostile sites depends on this.
  - Only `ublock-*` lists (and opt-in user filters) may use `trusted-*` scriptlets.
- **HTML filtering** (`enableHtmlFiltering:true`, env `cap_html_filtering:true`):
  - `['script', patterns]`: in `rewriter.html.pre`, remove `<script>` nodes whose text contains all patterns (same
    semantics as `selectTagsToRemove`, `html-filtering.js:151-162`).
  - `['replace', [re, s]]` (`$replace`): apply `StreamingHtmlFilter` to the raw upstream body in `fetch.preresponse`
    for documents (UNVERIFIED).

### 6.6 `$csp` filters

**Do not emit CSP headers.** Scramjet deletes upstream CSP (`core/src/fetch/headers.ts:20-25,69-70`), and every proxied
origin collapses into the GNOME origin. A real `script-src 'self'` would also block Scramjet's own `data:` inject
scripts (`controller/src/index.ts:~683-700`).

The 99 `$csp` rules in gnome-default are mostly `worker-src 'none'` (25) and `sandbox …` (17). Emulate them with
`engine.getCSPDirectives(Request.fromRawDetails({ url, type: 'main_frame' }))`:

- If the result contains `worker-src 'none'`, block `worker`/`sharedworker` destinations whose client is that page.
- Ignore the others in v1.
- `getCSPDirectives` only answers for `main_frame` (`engine.js:826`).

---

## 7. Privacy protection features implementable in the proxy

| Feature | Default | Scramjet hook | UV hook | Notes |
|---|---|---|---|---|
| **Strip tracking params** | ON | `intercept`: 307 to cleaned URL for documents; `request`: `props.url` for subresources | `request`: rewrite `ctx.url` (UNVERIFIED for documents) | Engine `rewrite.url` (2,649 `$removeparam` rules) **plus built-in list**. Verified: the engine removed `fbclid`, `gclid`, `msclkid`, `mc_eid`, `igsh`, `pp`, `tag`, `ref_`, `pd_rd_w` but **kept `utm_*`** |
| Link unwrapping (redirect skippers) | ON (v2) | `intercept` for documents | `request` | Ghostery drops `$urlskip`. Use ClearURLs `redirections` regexes (e.g. `google.*/url?…(?:url\|q)=(https?[^&]+)`) on navigations |
| **Global Privacy Control** | ON | `request`: `props.init.headers.push(['Sec-GPC','1'])`; `init.pre`: `Object.defineProperty(win.Navigator.prototype,'globalPrivacyControl',{get:()=>true,configurable:true})` | `request`: `ctx.headers['sec-gpc']='1'` | DNT: offer it but default OFF. It is deprecated and adds fingerprint entropy |
| **Referrer trimming** | ON ("origin for cross-site") | `request`: if `Referer` site ≠ target site → `Referer: origin + '/'` (or drop for blocked/tracker-ish) | `request`: `ctx.headers.referer` (set at `uv.sw.js:105`) | Scramjet already computes Referer from page policy (`headers.ts:139-151`) and forces `Referrer-Policy: unsafe-url` internally (`:112-114`). Trimming must happen at the upstream-request level |
| **Third-party cookie blocking** | ON (Safari-like), per-site "allow" | `request`: delete `Cookie` when `site(url) ≠ site(topUrl)`; `preresponse`: drop 3P `Set-Cookie` | `request`: delete `ctx.headers.cookie`; `beforemod`: delete `set-cookie` | `document.cookie` in 3P iframes still writes to the shared jar (`core/src/client/dom/cookie.ts:4-17`); needs an `init.pre` override (UNVERIFIED). UV ignores SameSite and sends every domain cookie in every context (`rewrite/cookie.js:7-20`) |
| Fingerprinting-script blocking | ON (via Tracker blocker) | – | – | EasyPrivacy (63 "fingerprint" mentions, 12 FingerprintJS endpoints) and uBO Privacy (28/5). AdGuard Tracking Protection has 87/20 but is too heavy. Avoid NC lists |
| WebRTC IP-leak guard | ON | `init.pre`: replace `RTCPeerConnection` and friends in proxied windows | n/a | WebRTC from proxied pages would connect directly from the user's browser and bypass the proxy. Whether Scramjet already neuters it is UNVERIFIED |
| `$websocket` blocking | v2 | client-side hook on Scramjet's WebSocket proxy (`websocket.ts:66`) | – | The SW never sees WebSockets |

### 7.1 Built-in tracking-parameter list (complements the lists)

Top-level navigations and links only; exact names unless a `*` is shown:

```
utm_* (source, medium, campaign, term, content, id, name, …), fbclid, gclid, dclid, gbraid, wbraid, msclkid, yclid,
twclid, ttclid, igshid, igsh, mc_cid, mc_eid, _hsenc, _hsmi, __hssc, __hstc, __hsfp, hsCtaTracking, mkt_tok,
oly_anon_id, oly_enc_id, rb_clickid, s_cid, vero_conv, vero_id, wickedid, _openstat, srsltid
```

- This is derived from ClearURLs `globalRules` (LGPL-3.0 data, 206 providers). Ship it as a small table in GNOME code
  with attribution, or fetch `data.minify.json` and verify its SHA-256.
- Leave out ClearURLs' aggressive `[a-z]?mc` and `ref_?`/`referrer` (referral-marketing) rules by default.

---

## 8. Cookie manager

Assumptions:

- GNOME embeds `@mercuryworkshop/scramjet-controller` 0.0.14 and core 2.0.67-alpha.2, and the GNOME top-level page owns
  the `Controller`.
- UV is the `@nebula-services/ultraviolet` 1.0.11.patch.7 fork cloned in `repos/ultraviolet`. Upstream Titanium Network
  UV 3.x storage was not checked (UNVERIFIED).
- The engine reports cover other storage (localStorage/IDB/Cache shims).

### 8.1 Scramjet cookie store

- **In memory:** `controller.cookieJar: CookieJar` (`controller/src/index.ts:219`, class in `core/src/shared/cookie.ts:19-199`).
- **Cookie shape** (`cookie.ts:6-17`):
  `{ name, value, path?, expires?: number /*ms epoch*/, maxAge?, domain? /*always ".host"*/, hostOnly?, secure?, httpOnly?, sameSite? }`.
- **Key** = `${domain}@${path}@${name}` (`cookie.ts:94`).
- **API:** `setCookies(setCookieString, url)`, `getCookies(url, fromJs, sameSiteContext)`, `load(json)`, `clear()`,
  `dump(): string` (JSON of `Record<key, Cookie>`). Expired cookies are skipped on read (`:134`) but never purged.
- **Persistence:** IndexedDB database `__scramjet_controller` v1, object store `state`, key `cookies`, value
  `{ updatedAt: number, cookies: string }` (`index.ts:92-95,133-195`). Writes go through `controller.persistCookies()`
  (`:606-620`), which bumps `updatedAt` and posts `{updatedAt}` on `BroadcastChannel('__scramjet_controller_channel')`.
  Other controllers then reload via `loadSavedCookies()` (`:583-604`).
- **Live frames hold copies:**
  - Each proxied document gets the *entire* jar dump embedded in its inject script (`index.ts:~696`), and loads it
    into its own `CookieJar` (`inject.ts:235-236`).
  - Updates reach frames as SW-relayed `$controller$setCookie` messages `{ cookies, options: { clear? }, id }`
    (`inject.ts:240-275`).
  - `controller.propagateCookieSync(entries, { clear: true })` (`index.ts:569-581`) makes every client clear its jar
    and apply `entries`.
- **Privacy/security note:** every proxied page realm receives all cookies of all sites, including `httpOnly` ones.
  Cross-site isolation relies entirely on Scramjet's sandbox. Offer "clear cookies on exit" and per-site cookie
  blocking.

```ts
type ScramjetCookie = { name: string; value: string; path?: string; expires?: number; maxAge?: number;
  domain?: string; hostOnly?: boolean; secure?: boolean; httpOnly?: boolean; sameSite?: string };

export function listCookies(controller: Controller) {
  const all: Record<string, ScramjetCookie> = JSON.parse(controller.cookieJar.dump());
  const now = Date.now();
  return Object.entries(all).filter(([, c]) => c.expires === undefined || c.expires >= now)
    .map(([id, c]) => ({ id, site: getDomain(c.domain!.slice(1)) ?? c.domain!.slice(1), ...c }));
}

export async function deleteCookies(controller: Controller, pred: (c: ScramjetCookie, id: string) => boolean) {
  const all: Record<string, ScramjetCookie> = JSON.parse(controller.cookieJar.dump());
  for (const [id, c] of Object.entries(all)) if (pred(c, id)) delete all[id];
  controller.cookieJar.load(JSON.stringify(all));
  await controller.persistCookies();                 // IDB + BroadcastChannel → other GNOME tabs
  // live proxied frames still hold old copies: either reload affected frames (frame.reload()),
  // or push a full resync (UNVERIFIED that serialising back to Set-Cookie strings round-trips all attributes):
  // await controller.propagateCookieSync(toSetCookieEntries(all), { clear: true });
}
// "Clear all": controller.cookieJar.clear(); await controller.persistCookies(); await controller.propagateCookieSync([], { clear: true });
```

### 8.2 Ultraviolet cookie store

- **Location:** IndexedDB database **`__op`** v1, object store **`cookies`** (`keyPath: 'id'`, index `path`)
  (`src/rewrite/cookie.js:22-33`).
- **Record:** `set-cookie-parser` output `{ name, value, domain /*".host"*/, path, expires?, maxAge?, secure?, httpOnly?, sameSite? }`
  plus `id = "${domain}@${path}@${name}"` and `set: Date` (`:68-90`).
- **Reads:** the SW reads all cookies on every request (`uv.sw.js:108`, `getCookies` `cookie.js:47-66`), so deletions
  apply to the next request immediately.
- **Loaded pages:** they keep a `document.cookie` snapshot (`uv.handler.js:101`). In this fork nobody consumes the
  SW's `updateCookies` message (`uv.sw.js:193`), so the effect shows after reload.

```js
const db = await new Promise((res, rej) => { const r = indexedDB.open('__op', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const tx = db.transaction('cookies', 'readwrite'); const store = tx.objectStore('cookies');
const all = await new Promise((res) => { const q = store.getAll(); q.onsuccess = () => res(q.result); });
for (const c of all) if (c.domain.endsWith('.tracker.example')) store.delete(c.id);
```

### 8.3 Cookie manager features

- List cookies grouped by registrable domain, with name, value (masked), expiry, `httpOnly`, `secure` and `sameSite`.
- Delete a single cookie, a whole site, or everything.
- **Clear on exit.**
- Per-site rules: `allow` | `block` | `session`, enforced in the `request`/`preresponse` hooks (Scramjet) or the
  `request`/`beforemod` events (UV).
- The global "block third-party cookies" switch.
- Expired-cookie purge: Scramjet never purges.

---

## 9. Config keys and files to serve

Backend endpoints (Rust/Axum; JSON over the existing REST API):

| Path | Content | Caching |
|---|---|---|
| `GET /api/content-blocking/manifest.json` | `{ "engineVersion": 899, "lists": [{ "id", "title", "group", "url", "mirrors": [], "license", "trusted": bool, "sha256", "bytes", "fetchedAt", "expiresAt" }], "resources": { "sha256", "bytes" } }` | `no-cache` + ETag |
| `GET /api/content-blocking/lists/{id}.txt` | flattened (and optionally sanitized) list text | `ETag: "<sha256>"`, `Cache-Control: public, max-age=3600`, br/gzip |
| `GET /api/content-blocking/resources.json` | uBO resources JSON (Ghostery CDN build) | ETag = sha256 |

SQLite (backend): `filter_lists(id TEXT PRIMARY KEY, url TEXT, mirror_urls TEXT, etag TEXT, last_modified TEXT, sha256 TEXT, body BLOB, fetched_at INTEGER, expires_at INTEGER, error TEXT)`.

Frontend:

- The engine bundle is built by Vite from npm (`@ghostery/adblocker`, `@ghostery/adblocker-content`, versions pinned).
- It is used by the controller page, a dedicated builder Worker, and the UV SW (IIFE via `importScripts`).
- Cache Storage: cache `gnome-content-blocking-v1`, key `/__gnome/content-blocking/engine/899/<presetKey>.bin`.

User-facing config keys (stored per GNOME user):

| Key | Type | Default |
|---|---|---|
| `contentBlocking.enabled` | bool | `true` |
| `contentBlocking.ads.enabled` / `.lists` | bool / string[] | `true` / `["easylist","ublock-filters","ublock-badware","ublock-quick-fixes","ublock-unbreak","plowe-0"]` |
| `contentBlocking.trackers.enabled` / `.lists` | bool / string[] | `true` / `["easyprivacy","ublock-privacy"]` |
| `contentBlocking.cookieNotices.enabled` / `.lists` | bool / string[] | `false` / `["fanboy-cookiemonster"]` (+`"ublock-cookies"` when scriptlets enabled) |
| `contentBlocking.annoyances.enabled` / `.lists` | bool / string[] | `false` / `["ublock-annoyances-others"]` |
| `contentBlocking.cosmetic.enabled` | bool | `true` |
| `contentBlocking.cosmetic.generic` | bool | `true` (maps to `loadGenericCosmeticsFilters`) |
| `contentBlocking.cosmetic.extendedSelectors` | bool | `false` (v1) |
| `contentBlocking.scriptlets.enabled` | bool | `false` (v1, until §6.5 is verified) |
| `contentBlocking.htmlFiltering.enabled` | bool | `false` |
| `contentBlocking.allowlist` | string[] (registrable domains) | `[]` |
| `contentBlocking.customFilters` / `.customFiltersTrusted` | string / bool | `""` / `false` |
| `contentBlocking.blockedPageInterstitial` | bool | `true` |
| `privacy.stripTrackingParams` | bool | `true` |
| `privacy.unwrapRedirectLinks` | bool | `true` (v2) |
| `privacy.globalPrivacyControl` | bool | `true` |
| `privacy.doNotTrack` | bool | `false` |
| `privacy.referrer` | `"default" \| "origin-cross-site" \| "none-cross-site"` | `"origin-cross-site"` |
| `privacy.thirdPartyCookies` | `"allow" \| "block"` | `"block"` |
| `privacy.blockWebRTC` | bool | `true` |
| `cookies.clearOnExit` | bool | `false` |
| `cookies.siteRules` | `Record<domain, "allow"\|"block"\|"session">` | `{}` |

Admin/backend keys (instance level):

| Key | Default |
|---|---|
| `content_blocking.update_min_interval` | `"4h"` |
| `content_blocking.update_max_interval` | `"7d"` |
| `content_blocking.user_agent` | `"GNOME/<version> (+<instance url>)"` |
| `content_blocking.extra_lists` | `[]` |

---

## 10. Risks and open questions

1. **Scriptlet injection inside Scramjet/UV frames is UNVERIFIED.** It is needed for top-tier ad blocking (40 % of
   uBO rules) and for cookie-notice lists. Prototype it with the `rewriter.html.pre` approach before enabling.
2. **Invalid cosmetic selectors from DOM-less builds** silently disable cosmetic chunks (verified). The sanitation and
   insertRule validation pipeline (§6.1.1) is mandatory.
3. **Ghostery gaps.** The library has no trusted-scriptlet gating, no `$popup`, `$header`, regex `$removeparam` or
   `$urlskip`, and `getCSPDirectives` is main-frame only. GNOME code must filter lists and emulate where needed.
4. **Library upgrades bump `ENGINE_VERSION`.** Cached engines then fail to deserialize (throws), so rebuild on mismatch.
5. **Scramjet 2 runs the blocker on the GNOME page's main thread.** Expect ~2–8 ms of CPU per page load and a
   cold-start cost of up to ~100 ms for the first 1,000 matches. Warm up during idle time.
6. **Scramjet embeds the full cookie jar** (all sites, including `httpOnly`) in every proxied document's inject script.
   Cookie isolation therefore depends on the sandbox (§8.1).
7. Peter Lowe's list has no formal license, and the Fanboy/EasyList Cookie headers disagree (CC BY 3.0 vs the EasyList
   licence page). Show attributions on a "Licenses" page. GNOME redistributes list text from its backend cache.
8. **The URL sample age.** The Brave corpus dates from 2019. The 2026 crawl is small (20 sites, some bot-blocked).
   Throughput is consistent across both: 40–123 k req/s depending on lists.
9. **Not verified here:**
   - The adblock-rust WASM build size and speed (no wasm32 target available).
   - tsurlfilter's behaviour, which was size-measured only.
   - Parse time of gnome-default inside a browser Worker (extrapolated; measured data points are EL+EP in a SW,
     285–363 ms, and gnome-full on the page main thread with DOM validation, 995 ms in Chromium).

---

## 11. Decision summary for implementers

- [ ] Add `@ghostery/adblocker@2.20.3` and `@ghostery/adblocker-content@2.20.3` (pin versions; MPL-2.0 notices).
- [ ] Backend list cache plus the manifest and endpoints (§9), with mirrors from §5.1 (uBO CDN first) and SHA-256
      change detection.
- [ ] Builder Worker with `sanitizeList`, then `parse` with `{ loadPreprocessors: true, loadExtendedSelectors: false }`,
      then `updateResources`, insertRule validation, `update(remove)`, `serialize`, and Cache Storage.
- [ ] Scramjet `GnomeContentBlocker` ManagedPlugin (§6.2) plus the GNOME SW wrapper (`x-gnome-blocked` → `Response.error()`).
- [ ] UV SW hooks (§6.3).
- [ ] Cosmetic CSS (hostname + base at document start, DOMMonitor generic rules).
- [ ] Privacy hooks (§7).
- [ ] Cookie manager (§8).
- [ ] v2: scriptlets (trusted only from `ublock-*`), extended selectors, HTML filtering, `$csp` worker-src emulation,
      popup blocker, WebSocket blocking, ClearURLs redirections.

---

## 12. Reproduction

`SP=/tmp/claude-1000/-home-duderucool-gnome/f2049012-6316-4b31-bd8a-a00530b243a1/scratchpad`

Downloaded data (untrusted, read-only):

| Path | Contents |
|---|---|
| `$SP/pkgs/ghostery-adblocker/tarballs/` | `npm pack` of adblocker, adblocker-content and adblocker-extended-selectors 2.20.3 |
| `$SP/pkgs/ghostery-adblocker/install/` | `npm install --ignore-scripts` (12 packages) |
| `$SP/pkgs/esbuild/` | esbuild 0.28.2 |
| `$SP/pkgs/playwright/` | playwright-core 1.64.0, which matches the cached chromium-1248 and firefox-1555 |
| `$SP/pkgs/adguard-tsurlfilter/` | tsurlfilter 6.0.4 |
| `$SP/filters/*.txt`, `headers/*.hdr` | Raw lists and response headers |
| `$SP/filters/flat/` | Self-flattened includes; sub-files in `includes/` |
| `$SP/filters/cdn/` | uBO CDN `.min` mirrors |
| `$SP/filters/ghostery-cdn/ublock-resources.json` | Resources |
| `$SP/filters/meta/` | uBO `assets.json` and licence pages |
| `$SP/datasets/brave-requests/requests.json` | Brave corpus, 67,453,833 B |
| `$SP/datasets/crawl-2026/requests.jsonl` | 2026 crawl |

Scripts (in `$SP/adblock-bench/`):

| Script | Purpose |
|---|---|
| `fetch-lists.sh <filtersDir>` | Download lists with headers |
| `flatten_includes.py <list> <baseUrl> <out> <cacheDir>` | Flatten `!#include`; run with `python3 -I` |
| `bench-node.mjs <node_modules> <filtersDir> <requests.jsonl> <out.json> <preset> [resources.json]` | Presets: `el+ep`, `el+ep-net`, `el+ep-compressed`, `gnome-ads`, `gnome-default`, `gnome-full` |
| `cold-start.mjs <node_modules> <engine.bin> <requests.jsonl>` | Fresh-process cold start |
| `per-list.mjs`, `match-sample.mjs`, `feature-probe.mjs`, `unsupported-samples.mjs`, `update-check.mjs`, `removeparam-check.mjs`, `sanitize-build.mjs`, `crawl.mjs` | Per-list costs, sample matching, semantics probes, sanitation build, crawl |
| `bundle/build.mjs <esbuildDir> <node_modules> <outdir>` | Bundle sizes |
| `browser/run-browser.mjs <playwright-core> <www> <out.json> [chromium\|firefox\|both]` | SW and page checks |
| `browser/run-page.mjs <playwright-core> <www> </page.html> [browser]` | Single-page checks; pages in `browser/www/`: `cosdiff*.html`, `cssvalid.html`, `cssbad.html`, `csssupports*.html`, `insertrule.html`, `affected.html`, `scriptlet.html` |

Results:

| Path | Contents |
|---|---|
| `$SP/adblock-bench/results/*.json` | Per-preset metrics; `browser.json`, `per-list.json` |
| `$SP/adblock-bench/results/*.engine.bin` | Serialized engines |
| `$SP/adblock-bench/results/feature-probe.txt` | Semantics probe output |
| `$SP/adblock-bench/results/crawl-2026-match.txt` | 2026 crawl matching |
