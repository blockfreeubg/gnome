# Sapphire (`@x8r/sapphire` 0.1.4): architecture study, and how GNOME should build its own extensions

> Research report, 2026-11-09. Scope: understand how Sapphire (a Scramjet 2 plugin that emulates `chrome.*`
> extension APIs inside proxied frames) works, extract the **real Scramjet 2 plugin API surface** from it, and use
> that to design GNOME's built-in privacy features (ad blocker, tracker blocker, privacy protection, cookie manager,
> cosmetic filtering, per-site controls and allowlist), plus Ultraviolet equivalents. It ends with a verdict on
> loading user-installed Chrome MV3 extensions.
>
> **Licensing rule for this document.** Sapphire has **no license** (see §1). Its architecture is described here in
> my own words. File:line references are given so a reviewer can check the claims. **Implementers should not
> read Sapphire's source while writing GNOME code** (clean room). Nothing from Sapphire may be copied, vendored or
> installed as a dependency of GNOME.
>
> **How claims were verified.** (1) I read every file in the Sapphire repo, the Scramjet monorepo, the published
> npm tarballs and Ultraviolet. (2) I built a small **hook-probe prototype of my own** (no Sapphire code) on
> the published Scramjet packages and ran it in Playwright Chromium 156. Its results are marked **[probe]**, and
> Appendix A has the details. (3) I probed browsers for the features Sapphire's content-script design depends on,
> also marked **[probe]**. Anything I could not check is marked **UNVERIFIED**. I did not run Sapphire's own test
> harness, because the reference repos are read-only data and must not be executed.

---

## 0. Summary

* **License: none. Do not copy or bundle.** Sapphire (repo `x8rr/sapphire`, a GitHub fork of
  `carbonicality/amethyst`) has no LICENSE file and no `license` field. Upstream amethyst has no license either. The
  GitHub API reports `license: null` for both, and `/license` returns 404 for both. Default copyright applies: all
  rights reserved.
* **Where Sapphire runs.** Sapphire runs entirely in the **host page** (the page that owns the Scramjet
  `Controller`). Every extension context is a Scramjet-proxied iframe on the host's real origin: background pages,
  MV3 service workers (emulated as hidden pages), popups, options pages and offscreen documents. The service worker
  only forwards fetches. Scramjet 2 runs its whole fetch pipeline, and therefore every plugin fetch hook, **in the
  host page**. **[probe]**
* **The Scramjet 2 plugin API is small and sufficient.** A `ManagedPlugin` is attached per `Frame`
  (one per tab) and taps these hooks:
  * `frame.hooks.fetch.{intercept,request,preresponse,response}`: per request, host realm, awaited.
  * `frame.hooks.init.{pre,post}`: per document, including nested iframes. They run synchronously at document start,
    before any page script.
  * `frame.hooks.error.request`.
  * `frame.fetchHandler.hooks.rewriter.html.{pre,post}`: access to the HTML DOM before serialization.
  * The per-document `client.hooks.lifecycle.navigate` hook: SPA navigations.

  Sapphire uses five of these: `init.pre`, `init.post`, `fetch.request`, `fetch.preresponse` and `fetch.response`
  (`src/SapphirePlugin.ts:35-71`).
* **Content scripts run in the page's own JS world.** They are injected as inline `<script>` elements, which
  Scramjet rewrites. Each extension gets its own `chrome` object through per-caller getters placed on the native
  `window.chrome` object. The calling extension is identified by inspecting the stack trace for a `//# sourceURL`.
  Two consequences:
  * There is **no isolation**: page scripts can observe content scripts and can obtain their APIs.
  * It needs a **native `window.chrome` object, so it works in Chromium only**. Firefox 157 has no `window.chrome`.
    **[probe]**
* **DNR and webRequest are enforced in the host page**, inside the `fetch.request` and `fetch.preresponse` hooks.
  Blocked requests get a synthetic early response and never reach the network. **WebSockets bypass every fetch hook**
  and are visible only at the transport layer. **[probe]**
* **API coverage is wide and shallow.** About 50 namespaces exist (37 permission-gated in `api/index.ts:53-91`, plus
  the always-present and manifest-driven ones). Messaging, storage, tabs, scripting, DNR,
  webRequest, action/popup, contextMenus, alarms and notifications work. Many others are bookkeeping-only stubs
  (privacy, proxy, contentSettings, fontSettings and more). Unknown permission namespaces become silently-succeeding
  auto-stubs. Permissions are mostly not enforced.
* **Recommendation for GNOME.** Build the built-ins as first-party modules: one realm-agnostic policy and filter core
  (`@ghostery/adblocker`, MPL-2.0, already planned) plus thin adapters:
  * a Scramjet `ManagedPlugin` that taps the hooks above, in the host page;
  * a transport wrapper for WebSockets;
  * a UV service-worker adapter (`uv.on('request' | 'beforemod' | 'response')` plus `__uv$config.inject`).

  Do **not** emulate `chrome.*` for the built-ins.
* **User-installed MV3 extensions: not for v1.** Running them is technically possible, as Sapphire shows, but it
  requires a clean-room reimplementation of about 9.5k lines. It works in Chromium only. Every extension would run
  with GNOME-origin privileges and without isolation. If there is demand, ship GNOME-native user scripts, user styles
  and custom filter lists first (§13).
* **Correction to `docs/ARCHITECTURE.md` §1.** That section places "blocking" in the service worker. For Scramjet 2
  (controller mode), blocking must run in the host page via plugin hooks. Only the UV fallback blocks in the SW (§12).

---

## 1. Provenance, versions and licensing

### 1.1 What was studied

| Item | Value (verified) |
| --- | --- |
| Repo clone | `.../scratchpad/repos/sapphire`, HEAD `901e7de051ee2974f2c7bb6869083913114b1886` (2026-10-06, "Update README.md"); `git ls-remote https://github.com/x8rr/sapphire` gives the same HEAD |
| npm | `@x8r/sapphire` versions 0.1.0, 0.1.1, 0.1.3, 0.1.4 (latest; published 2026-10-06, gitHead `61b1586…`). The 0.1.4 tarball's `src/` and `package.json` are **byte-identical** to the clone (`diff -rq`) |
| Shipping format | TypeScript sources only (`"main": "src/index.ts"`), so the host must bundle them. 9,472 lines in `src/`, 1,302 in `test/` |
| Runtime deps | `jszip ^3.10.1` (MIT OR GPL-3.0-or-later). Peer: `@mercuryworkshop/scramjet-controller ^0.0.13` |
| Dev deps | `@mercuryworkshop/scramjet ^2.0.67-alpha.2`, `scramjet-controller ^0.0.14`, `libcurl-transport ^2.0.5`, `wisp-js ^0.5.0`, `esbuild`, `vite`, `playwright-core ^1.61.1`, `typescript ^7.0.2` |
| Authorship | README: "Originally forked from carbonicality/amethyst". `tsconfig.json:1-12` header: "scramjet plugin + updated support by x8rr / first version by carbon06 + decayed / owned by discord.gg/unblockers" |

### 1.2 License findings

| Project | Evidence | Result |
| --- | --- | --- |
| `x8rr/sapphire` | No LICENSE file in the repo. No `license` in `package.json` or in npm metadata. `GET api.github.com/repos/x8rr/sapphire` gives `"license": null` and `"fork": true` with parent `carbonicality/amethyst`. `GET …/license` returns **404** | **No license** |
| `carbonicality/amethyst` | `GET api.github.com/repos/carbonicality/amethyst` gives `"license": null`. `GET …/license` returns **404**. Root contents are only `.gitignore`, `README.md` and `amethyst.js` (HEAD `f4b245c1d7de53a6f62f8b218b8687d4477b078d`). The `amethyst.js` header names authors ("developed by carbon06 + decayedontop") and has no license text | **No license** |

**Consequence.** No permissive license covers Sapphire, so GNOME **must not** copy, adapt line by line, vendor,
`npm install` or bundle Sapphire or amethyst. This document reuses ideas (architecture) only. The ARCHITECTURE.md §9
row "Sapphire | no license | Not bundled; architecture studied only" is correct.

### 1.3 Related licenses (for GNOME's planning)

| Component | Version checked | License |
| --- | --- | --- |
| `@mercuryworkshop/scramjet` | 2.0.67-alpha.2 | AGPL-3.0-only |
| `@mercuryworkshop/scramjet-controller` | 0.0.14 (0.0.13 also inspected) | AGPL-3.0-only |
| `@mercuryworkshop/libcurl-transport` | 2.0.6 (bundles libcurl.js 0.7.5) | AGPL-3.0-only |
| `@mercuryworkshop/proxy-transports` | 1.0.2 | MIT |
| `@mercuryworkshop/wisp-js` | 0.5.3 (test harness only) | LGPL-3.0-or-later |
| `@titaniumnetwork-dev/ultraviolet` | 3.2.10 (deps `@mercuryworkshop/bare-mux ^2.1.6`) | MIT |
| `@ghostery/adblocker` | 2.20.3 | MPL-2.0 |
| `tldts` | 7.4.19 | MIT |
| `brave/adblock-rust` | GitHub | MPL-2.0 |
| EasyList / EasyPrivacy | list header "Licence: https://easylist.to/pages/licence.html" | Dual GPL-3.0-or-later **or** CC BY-SA 3.0+, attribution "The EasyList authors (https://easylist.to/)" (page text verified via the Wayback Machine) |
| uBlock Origin, uAssets, AdguardFilters | GitHub API | GPL-3.0 |

---

## 2. Runtime model: where everything runs

```
GNOME origin (one real origin for everything below)
┌──────────────────────────── host page = GNOME SPA (main thread) ───────────────────────────────┐
│ Shell UI (tabs, omnibox, toolbar)                                                              │
│ Scramjet Controller ── cookieJar (all sites) ── transport (libcurl/epoxy → wss /wisp/)        │
│   ├ Frame tab#1  prefix /~/sj/<controllerId>/<frameId>/ ── plugins[] (hook callbacks run HERE) │
│   ├ Frame tab#2 …                                                                              │
│   └ (Sapphire only) hidden Frames: extension background / offscreen / auth                     │
│ Sapphire: registry, DNR index, messaging, storage cache (all in host-realm memory)             │
│ <iframe> tab#1 → proxied document (rewritten) → nested <iframe>s (rewritten)                   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
          ▲ RPC "request" over a MessagePort (bodies transferred)
┌─────────┴──────── service worker (same origin) ────────┐
│ controller.sw.js: shouldRoute/route by frame prefix →   │
│   forwards each fetch to the owning Controller          │
│ (Sapphire legacy: sapphire-sw-router.js for /~/sx/…)    │
└──────────────────────────────────────────────────────────┘
```

Verified facts:

1. The SW routes any URL under a registered controller prefix to that controller over RPC
   (`scramjet-controller/src/sw.ts:160-211` in the published 0.0.14 package).
2. The controller's `request` method picks the `Frame` whose `prefix` matches the path, then calls
   `frame.fetchHandler.handleFetch(...)` (`src/index.ts:273-337`). **All fetch hooks therefore run in the host page.**
   **[probe]** Hook callbacks executed in the host realm while the frame's `location.href` was
   `http://localhost:5399/~/sj/<cid>/<fid>/http%3A%2F%2F127.0.0.1…`.
3. Proxied documents are same-origin with the host. The controller-injected script (`controller.inject.js`) runs in
   the frame, finds the owning `Frame` through `iframe[Symbol.for("controller frame handle")]`, walking up parents for
   nested iframes (`inject.ts:291-317`), and dispatches `init.pre` and `init.post` on that Frame's hooks. Host-realm
   callbacks then touch the frame's `window` synchronously.
4. Sapphire's own state lives in host-realm memory. IndexedDB is only for persistence. Every extension context is
   just another iframe/realm in the same page, which is why messaging, storage and events can be plain in-memory
   function calls.

---

## 3. The real Scramjet 2 plugin API surface (verified)

Line numbers below refer to the **published** `@mercuryworkshop/scramjet-controller@0.0.14` `src/` (it ships its
sources), unless marked "core". "Core" refers to the Scramjet monorepo HEAD `517206bc39bc…` (2026-11-08),
`packages/core/src/…`, whose package version is 2.0.67-alpha.2. I confirmed that the published
`scramjet@2.0.67-alpha.2` `dist/scramjet.js` contains the same hook names and the same
request → earlyResponse → preresponse sequence.

### 3.1 Packages, globals and static files

* IIFE bundles set globals:
  * `scramjet.js` sets `$scramjet`.
  * `controller.api.js` sets `$scramjetController = { Controller, Frame, ManagedPlugin, VERSION, assertRuntimeScramjetVersion, config }`.
    The ESM entry `controller-external.mjs` only re-exports these globals.
  * `controller.sw.js` sets `$scramjetController = { shouldRoute, route }` inside the SW.
* Default paths, from `config` at `index.ts:48-66`. The host must serve:
  * `/scramjet/scramjet.js`
  * `/scramjet/scramjet.wasm`
  * `/controller/controller.inject.js`
  * `/controller/controller.sw.js`
  * `/controller/controller.api.js`

  Other defaults: prefix `/~/sj/`; the virtual wasm file `scramjet.wasm.js` is served by the controller itself
  (`index.ts:279-305`); the codec is `encodeURIComponent`/`decodeURIComponent` of the full URL.
* **Exact version pin.** The controller build throws if the loaded Scramjet runtime version differs from the one it
  was built for (`version.ts:18-30`). Controller 0.0.14 expects exactly `2.0.67-alpha.2`. 0.0.13 expects
  `2.0.67-alpha.1`. Pin both packages together.

### 3.2 Controller, Frame and ManagedPlugin

| API | Signature (summary) | Ref |
| --- | --- | --- |
| `new Controller(init)` | `{ serviceworker: ServiceWorker, transport: ProxyTransport, config?: Partial<Config>, scramjetConfig?: Partial<ScramjetConfig> }` | `index.ts:205-210, 451-525` |
| `controller.wait()` | `Promise<void>`. Waits for SW handshake, wasm and saved cookies | `:644` |
| `controller.createFrame(iframe?, { plugins })` | Returns `Frame`. Plugins are installed in the constructor | `:632-642, 819-832` |
| `controller.frames` | `Frame[]`. **There is no `destroy` API**; Sapphire splices this array to drop a frame (`sapphire.ts:291-294`) | `:222` |
| `controller.cookieJar` | Scramjet `CookieJar` for **all proxied sites** | `:221` |
| `controller.persistCookies()` | Writes `cookieJar.dump()` to IndexedDB `__scramjet_controller` / store `state` / key `cookies` and broadcasts on BroadcastChannel `__scramjet_controller_channel` | `:94-97, 608-622` |
| `controller.propagateCookieSync(entries, {clear?, destination?})` | Pushes `{url, cookie}` Set-Cookie strings to all loaded frames via the SW | `:571-583` |
| `controller.transport`, `setTransport(t)` | The `ProxyTransport` used for every upstream request | `:624-630` |
| `frame.prefix` | `/~/sj/<controllerId>/<frameId>/` **[probe]** | `:460, 787` |
| `frame.go(url)`, `back()`, `forward()`, `reload()` | Navigation of the frame's iframe | `:843-863` |
| `frame.hooks` | `{ fetch: FetchHooks (== fetchHandler.hooks.fetch), init: FrameInitHooks, error: FrameErrorHooks }` | `:811-815` |
| `frame.fetchHandler.hooks.rewriter.html` | `{ pre, post }` HTML rewriter hooks for documents fetched through this frame | core `fetch/index.ts:118-148` |
| `frame.getPlugin(name)` | Look up an installed plugin | `:835` |
| `class ManagedPlugin extends Plugin` | `constructor(name, dependencies: string[])`; override `install(frame)` and call `super.install(frame)`; `this.tap(hook, cb, order?)`. `order = { before?: string[]; after?: string[] }` by plugin name | `index.ts:81-92`; core `Tap.ts:13-18, 98-111` |

`ProxyTransport` (MIT `proxy-transports@1.0.2`, `types.d.ts:10-18`) has:
`init(): Promise<void>`, `ready: boolean`,
`request(remote: URL, method, body, headers: [string,string][], signal) → Promise<{body, headers, status, statusText}>`,
and `connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) → [send, close]`.

### 3.3 Hook reference

`Tap.dispatch` calls every callback **synchronously** and returns `Promise.all(results)` (core `Tap.ts:114-127`).
Fetch hooks are awaited. Init and HTML-rewriter hooks are **not** awaited, so callbacks there must do their work
synchronously.

| Hook | Dispatched at | Realm / timing | `context` | `props` (mutable) | Sapphire uses it at |
| --- | --- | --- | --- | --- | --- |
| `fetch.intercept` | core `fetch/fetch.ts:37-49` | Host. Runs first, before request-header rewriting. **Skipped for `blob:`/`data:`** (`:33-35`) | `{request: ScramjetFetchRequest, parsed: ScramjetFetchParsed}` | `response?: ScramjetFetchResponse` short-circuits. **The body is NOT rewritten** **[probe]** | not used |
| `fetch.request` | core `fetch.ts:191-214` | Host. After Scramjet computed upstream headers (Cookie from the jar, Referer, Origin, Sec-Fetch-*), before `transport.request` | `{request, parsed, client}` | `init: {method, headers: RawHeaders, body, redirect:"manual"}`, `url: URL` (the upstream URL can be replaced), `earlyResponse?: Response or BareResponse` (skips the network; **the body IS rewritten** afterwards) **[probe]** | `SapphirePlugin.ts:51-57` → `network.ts:190-288` |
| `fetch.preresponse` | core `fetch.ts:216-231` | Host. After network or earlyResponse. **Before** Set-Cookie storage (`:71`), response-header rewriting (`:83-88`), redirect rewriting (`:90-149`) and body rewriting (`:151-158`) | `{request, parsed}` | `response: BareResponse` (`status`, `statusText`, `rawHeaders`, `body`); replaceable | `SapphirePlugin.ts:58-64` → `network.ts:290-324` |
| `fetch.response` | core `fetch.ts:160-175` | Host. Final. The body is a rewritten string for HTML | `{request, parsed}` | `response: {body, headers: ScramjetHeaders, status, statusText}`; replaceable | `SapphirePlugin.ts:65-71` → `network.ts:326-333` |
| `init.pre` | `inject.ts:359-360` | Callback in host realm; target is the frame window. Per document, including nested iframes and `hookSubcontext` subframes (`:344-350`). **Before `client.hook()`**: `navigation` and `Navigator.prototype.serviceWorker` still exist; `readyState === "loading"`; no page script has run **[probe]** | `{window, client: ScramjetClient, isTopLevel}` | `{}` | `SapphirePlugin.ts:35-42` → `frames.ts:347-410` |
| `init.post` | `inject.ts:362-363` | As above, but right **after** `client.hook()`. Scramjet has already deleted `navigation` and `Navigator.prototype.serviceWorker`. `document.head` exists. Still before page scripts **[probe]** | same | `{}` | `SapphirePlugin.ts:43-50` → `frames.ts:412-442` |
| `error.request` | `index.ts:339-354` | Host, when `handleFetch` throws | `{rawrequest: TransferRequest, error}` | `setResponse?: TransferResponse`, `suppressError?: boolean` | not used |
| `fetchHandler.hooks.rewriter.html.pre` / `.post` | core `shared/rewriters/html.ts:172-181`, `266-279` | Host, for every document rewritten by this frame's handler. `pre` runs after parse, before Scramjet's traversal. `post` runs after inject scripts are added | `{handler: htmlparser2 DomHandler, meta, origHtml, htmlcontext}` | `post`: `setRawHtml?: string` | not used. **[probe]** Removing a node from `ctx.handler.root` in `pre` removed it from the delivered page |
| `client.hooks.lifecycle.navigate` (per document) | core `client/client.ts:573-588` (location set), `client/dom/history.ts:23` (push/replaceState), `client/location.ts:62,101,124` | Frame client; tap it from `init.pre`/`init.post` | `{type: "location" or "history" or "hashchange"}` | `{url}` | not used: Sapphire wraps `history.pushState` itself (`frames.ts:519-531`). **[probe]** fired on `pushState` |
| `client.hooks.rewriter.html` (per document) | core `client/client.ts:228-233` | In-frame HTML rewriting (`innerHTML`, `document.write`, …) | as the HTML hooks above | as above | not used |

Useful fields:

* `parsed.url`: the real target URL.
* `parsed.clientUrl`: the real URL of the requesting document. It is `null` for navigations.
* `parsed.destination`: `RequestDestination`, overridable through `$dest`.
* `parsed.isIframe`: true only when Scramjet rewrote an `<iframe src>` (it adds `$iframe=1`, core `htmlRules.ts:43-53`).

**[probe]** results for these fields:

* The tab's own navigation had `destination "iframe"`, `isIframe false` and `clientUrl null`.
* A nested iframe had `"iframe"`, `true` and `null`.
* A page `fetch()` had `destination ""` and `clientUrl` equal to the page URL.

Request ids:

* `request.clientId` is the SW `clientId`, or `resultingClientId` for navigations.
* `frame.fetchHandler.trackedClients` keeps a per-client history.

### 3.4 Hook semantics checked with the probe

Setup: own prototype; Chromium 156.0.8078.4 headless; scramjet 2.0.67-alpha.2; controller 0.0.14;
libcurl-transport 2.0.6; wisp-js 0.5.3. Host `localhost:5399`, test site `127.0.0.1:5400`.

| # | Check | Observed |
| --- | --- | --- |
| 1 | Hook order for one request | `intercept → request → transport.request → preresponse → response` |
| 2 | `init.pre` timing | A property set on `ctx.window` in `init.pre` was visible to the page's first `<head>` inline script (`readyState "loading"`) |
| 3 | CSS at `init.post` | A `<style>` appended in `init.post` existed before the first page script and hid `.ad-banner` (`display:none`) |
| 4 | Nested frames | `init.pre`/`init.post` fired for the child iframe with `isTopLevel:false` |
| 5 | `request.earlyResponse` (403) | Page got 403. The origin was **never contacted**. `preresponse`/`response` still fired |
| 6 | `request.earlyResponse` with a JS body | The body **was rewritten**: `location.href` inside it gave the emulated `http://127.0.0.1:5400/page.html` |
| 7 | `intercept.response` with a JS body | The body was **not rewritten**: `location.href` inside it gave the real `http://localhost:5399/~/sj/…` URL. **Never return untrusted HTML/JS from `intercept`.** It would run with real GNOME-origin access |
| 8 | 307 `earlyResponse` with an absolute `location` | Scramjet rewrote the redirect. The page's `fetch` resolved with `redirected:true` and the target body. The redirected request went through all hooks again. The origin never saw the original URL |
| 9 | Replace `props.url` (drop `utm_*`) | The origin received `/ok.js?keep=1`. The page's request URL was unchanged |
| 10 | Append a header in `props.init.headers` | `sec-gpc: 1` arrived at the origin |
| 11 | Cookie header at request time | `props.init.headers` contained `cookie: keepme=1`, taken from the jar |
| 12 | Strip `Set-Cookie` in `preresponse` | The stripped cookie never entered `controller.cookieJar` or `document.cookie`. The unstripped one did |
| 13 | `document.cookie = …` in the frame | Observed by wrapping `ctx.client.init.sendSetCookie` in `init.post`. Scramjet's setter calls `client.context.cookieJar.setCookies` and then `client.init.sendSetCookie` (core `client/dom/cookie.ts:3-21`) |
| 14 | `new WebSocket()` in the page | **No fetch hook fired.** Only `transport.connect("ws://…")` was seen, on a wrapper around the controller transport |
| 15 | `history.pushState` | `client.hooks.lifecycle.navigate` fired with `{type:"history"}` |
| 16 | `rewriter.html.pre` | Removing an element node from `ctx.handler.root` removed it from the document |

### 3.5 Traffic the fetch hooks do not see

* **WebSockets.** The path is: in-frame `client.bare.createWebSocket` (core
  `client/shared/requests/websocket.ts:66,278`) → `RemoteTransport.connect` (`inject.ts:37-135`) → controller
  `initRemoteTransport.connect` → `this.transport.connect` (`index.ts:357-433`). **[probe]** Filter WebSockets by
  wrapping the transport given to the Controller.
* **`blob:` and `data:` URLs.** `intercept` and `request` are skipped for them (core `fetch.ts:33-35`).
* **Direct transport calls by the host.** Example: Sapphire's `chrome.downloads.download` calls
  `controller.transport.request()` directly (`sapphire.ts:996-1003`). This skips the hooks and does not send the
  site's cookies.
* **The controller's own wasm payload** (`index.ts:279-305`).

### 3.6 Gotchas for implementers

* Plugins are installed **per Frame**. One tab gets one Frame, and all of that tab's nested iframes and workers share
  it, because requests are routed by prefix. Per-tab request attribution is free in Scramjet. It is *not* free in
  UV (§12.5).
* Callbacks run in the host realm but handle frame-realm objects. Create objects the page will see with the
  frame's constructors (`new win.Object()`, `win.structuredClone`, `new win.CSSStyleSheet()`). Otherwise
  `instanceof` checks and prototype identity break.
* Text inserted as `<script>`/`<style>` into a hooked document goes through Scramjet's JS/CSS rewriters. For script
  text, Scramjet also stores a base64 copy in a `scramjet-attr-script-source-src` attribute (core
  `client/dom/element.ts:486-544`). Large injected scripts therefore cost rewrite time and memory on every page load.
* The tab's top-level navigation arrives with `destination "iframe"`. Classify it as `main_frame` when
  `!parsed.isIframe`, as Sapphire does in `network.ts:41-48`. A frame navigated by script, not by a rewritten `src`,
  may be misclassified: **UNVERIFIED** edge case.
* Scramjet deliberately leaves `RTCPeerConnection` native. Its own test asserts it in
  `packages/runway/src/tests/adversarial/modern-apis.ts:109`. WebRTC from proxied pages therefore bypasses the proxy.
  This is relevant for privacy protection (§12.8).

---

## 4. Sapphire architecture, module by module (a)

### 4.1 Public entry points (`src/index.ts:1-18`)

Exports:

* the `Sapphire` class and its option types;
* `SapphirePlugin` and `SapphireContentScriptPlugin`;
* command helpers (`findMatchingCommand`, `triggerCommand`, `shortcutMatches`);
* match-pattern helpers (`matchPattern`, `urlMatchesPatterns`);
* URL helpers (`extensionOrigin`, `extensionUrl`, `parseExtensionUrl`, `displayExtensionUrl`, `normalizeExtensionUrl`);
* `BLOCKED_HEADER` (`"x-sapphire-blocked"`);
* types (`ChromeManifest`, `DNRRule`, `DNRDecision`, `TabInfo`, `SapphireHostBindings`, context-menu and
  notification types).

### 4.2 Host interface (`SapphireHostBindings`, `src/types.ts:237-288`)

The host is the browser shell. It owns tabs, windows and every piece of UI. Sapphire calls back into it:

| Binding | Shape | Status | Used for |
| --- | --- | --- | --- |
| `getTabId(win)` | `(Window) → number or null` | Declared **required** and listed in the README, but **never called** in `src/` (grep). Tab identity comes from the per-frame plugin's `tabId` | (unused) |
| `getTab(id)` | `(number) → TabInfo or null` | required | `tabs.get/query`, validation (`tabsModel.ts:31-50`) |
| `getAllTabs()` | `() → TabInfo[]` | required | `tabs.query`, windows, new-tab detection after `createTab` |
| `getActiveTabId?()` | `() → number or null` | optional, effectively needed | default tab for popups, `captureVisibleTab`, `sidePanel.open`, `tabs.*` without a `tabId` |
| `getTabWindow?(id)` | `(number) → Window or null` | optional | tab width/height, `detectLanguage`, capture crop, reload and history fallbacks |
| `createTab?(url, {active, openerTabId?})` | `→ number, Promise<number> or null` | optional, preferred | `tabs.create`, `windows.create`, opening extension pages |
| `navigateTab?(id or null, url)` | `→ void` | optional | `tabs.update({url})`. `null` means a new tab |
| `closeTab?`, `reloadTab?`, `activateTab?`, `goBack?`, `goForward?` | `(id) → void` | optional | corresponding `tabs.*` calls, and `window.close()` in extension tabs |
| `openPopup?(extId, tabId)` | `→ boolean or void` | optional | action click, `action.openPopup`, `_execute_action`. The host is expected to call `mountExtensionPopup` |
| `closePopup?(extId)` | `→ void` | optional | `window.close()` inside a popup |
| `openSidePanel?(extId, path, tabId)` | `→ void` | optional | `sidePanel.open`, `openPanelOnActionClick` |
| `createNotification?(extId, id, options, {click, close(byUser), buttonClick(i)})`, `clearNotification?` | | optional | `chrome.notifications`. Falls back to the Web Notification API, then to legacy `showNotification?(title, msg)` |
| `showContextMenu?(request)` | `request = {tabId, frameId, x, y, items, select(entry)}` | optional | Providing it makes Sapphire capture `contextmenu` in tab frames |
| `requestPermissions?(extId, perms, origins)` | `→ boolean or Promise<boolean>` | optional. **Default: grant** | `permissions.request` |
| `captureTab?(tabId, format, quality?)` | `→ Promise<dataURL or null>` | optional | `tabs.captureVisibleTab`. Falls back to `getDisplayMedia` plus cropping |
| `search?(text, tabId, disposition)` | | optional | `chrome.search.query`. Fallback: google.com |
| `ensureController?()` | `→ void` | optional | Asks a lazily-booting host to start the proxy, then call `attachController` |
| `openExtensionTab?(extId, page, tabId)` | | legacy | Older hosts that rendered extension pages themselves |

### 4.3 The `Sapphire` class (`src/sapphire.ts`)

This is the coordinator. It holds the `SapphireRegistry`, host bindings, the controller, `BrowserData`
(history and bookmarks), downloads and in-memory "settings" (`:82-113`).

* **Setup.**
  * Constructor: `new Sapphire({ host, controller?, backgroundRoot?, extensionHostSuffix? })`. It adds
    activity listeners for `idle` on the host `document` (`:103-113`).
  * `init()` loads stored extensions and starts their backgrounds (`:139-158`).
  * `attachController(c)` and `waitForController()` (`:125-137`).
  * `createPlugin(tabId, {kind?})` (`:118-120`).
  * `onChange(cb)` notifies UI listeners. `scheduleChange` debounces them by 50 ms (`:160-170`).
* **Lifecycle.**
  * `installExtension(buffer, filename)` unpacks, stores, loads, starts the background and fires
    `management.onInstalled` (`:174-186`).
  * `uninstallExtension` opens `setUninstallURL` if one was set (`:201-210`).
  * Also `setExtensionEnabled` (`:212-228`), `reloadExtension` (`:230-238`) and `getInstalledExtensions(tabId)`,
    which returns a toolbar summary: icon data URL, title, badge, popup URL, options URL (`:240-262`).
* **Frames.**
  * `createFrame(iframe, {kind, tabId})` wraps `controller.createFrame` with a `SapphirePlugin` (`:285-296`).
  * Hidden frames are fixed 0×0 iframes under `backgroundRoot` or `document.body` (`:298-305`).
  * `mountExtensionPopup`/`unmountExtensionPopup` (`:335-348`), `mountExtensionPage`, `mountSidePanel`,
    `getNewTabOverride`/`mountNewTabPage` (`:350-376`).
* **Backgrounds.** `startBackground` loads the background through Scramjet in a hidden frame
  (`:389-414`; 15 s readiness timeout at `:412`):
  * for MV3 `service_worker`, or MV2 `background.scripts`, it loads a generated page
    `_generated_background_page.html`;
  * for MV2 it loads `background.page`.

  `fireLifecycle` dispatches `runtime.onInstalled` (install or update, tracked through `meta.lastRunVersion`) or
  `runtime.onStartup` (`:442-456`). Offscreen documents get the same hidden-frame treatment (`:458-486`).
* **Tabs (called by APIs).** `openTab`: uses `createTab`, else `navigateTab(null)`, then polls `getAllTabs()` for
  the new id (`:490-510`). Also `navigate`, `closeTab`, `reloadTab`, `activateTab` and `historyGo` (`:512-550`).
  `tabUpdated` fans out `tabs.onUpdated` and resets per-tab action and DNR counters on `loading` (`:552-566`).
* **Host → Sapphire notifications.** `notifyTabCreated/Updated/Removed/Activated` (`:834-877`).
* **Script injection.** `executeScript`, `insertCss`, `removeCss` (`:601-638`) select target frames from the frame
  registry (`:582-599`). `addContentScripts`/`removeContentScripts` persist dynamic registrations (`:651-666`).
* **UI events.**
  * `clickAction(extId, tabId)` returns `"popup"`, `"clicked"`, `"disabled"` or `null` (`:697-701`).
  * `handleKeyboardEvent(e, tabId)` returns a boolean (`:751-757`).
  * `showContextMenu`, `getContextMenuItems` and `clickContextMenuItem` (`:759-794`).
  * Omnibox: keywords, input started/changed/entered/cancelled, with a 3 s suggestion timeout (`:797-831`).
* **Services.**
  * `launchWebAuthFlow` draws its own overlay iframe in the host document and completes when a proxied navigation
    reaches `https://<id>.chromiumapp.org/` (`:910-964`; detection in `network.ts:203-206`).
  * `download()` (`:966-1026`).
  * `externalRuntimeFor()`: `chrome.runtime` for web pages matching `externally_connectable` (`:1029-1081`).

### 4.4 `SapphirePlugin` and `SapphireContentScriptPlugin` (`src/SapphirePlugin.ts`)

* `class SapphirePlugin extends ManagedPlugin` is named `"sapphire"` and has no dependencies (`:19-30`). It carries
  `{kind, tabId}`, where `FrameKind` is one of `"tab" | "popup" | "background" | "offscreen" | "sidepanel" | "auth"`
  (`frames.ts:9-14`).
* `install(frame)` taps `init.pre`, `init.post`, `fetch.request`, `fetch.preresponse` and `fetch.response` (`:32-72`).
  Init taps ignore contexts without a `window`. Every tap catches and logs its own exceptions.
* `SapphireContentScriptPlugin(sapphire, tabId)` is a legacy alias for `kind:"tab"` (`:75-80`).
* Only `kind:"tab"` frames own tab and frame records (`frames.ts:343-345`). A popup's `tabId` only means "the tab it
  was opened over".

### 4.5 The extension origin and the legacy SW router

* **Alias origin.** Extension resources are addressed as `https://<extId>.<suffix>/<path>`. The default suffix is
  `sapphire-extension.invalid`, configurable (`urls.ts:10-34`). Scramjet proxies only http(s), so an https alias lets
  extension pages, `getURL()` images, `fetch(getURL(...))` and injected extension iframes all flow through the proxy.
  The `.invalid` TLD guarantees that a leaked request can never resolve.
* **Serving.** `fetch.request` answers alias-host requests from the package store using `earlyResponse`
  (`network.ts:197-201, 122-152`). Because the response comes through the `request` hook, extension HTML and JS are
  rewritten by Scramjet like any site. That is what makes extension pages run inside a hooked realm and fire init
  hooks. Details:
  * The generated background page is a tiny HTML document with one `<script>` per background script, typed `module`
    for module service workers (`network.ts:114-120`).
  * CSS is passed through `__MSG_*__` localization.
  * Every response carries `access-control-allow-origin: *`.
  * There is **no `web_accessible_resources` check**.
* `parseExtensionUrl` accepts:
  * alias URLs;
  * literal `chrome-extension://` and `moz-extension://` URLs;
  * the legacy same-origin `/~/sx/<id>/<path>` form (`urls.ts:49-77`).

  `normalizeExtensionUrl` maps these to the alias form. `displayExtensionUrl` maps back to `chrome-extension://`
  for the address bar (`urls.ts:80-91`).
* **`router/SapphireRouter.ts` and `router/swEntry.ts`.** This is a legacy SW-side route. The test harness bundles it
  with esbuild as an IIFE that sets `self.$sapphireRouter = {shouldRoute, route}` (`swEntry.ts:6-9`) and imports it
  before `controller.sw.js` (`test/harness/web/public/sw.js:1-15`). It does two things:
  * It serves `/~/sx/<extId>/<path>` straight from IndexedDB, which the SW can read because it shares the origin
    (`SapphireRouter.ts:13-57`).
  * A `/~/sx/<id>/__bootstrap__` navigation maps its `resultingClientId` to an extension, so that client's later
    same-origin requests are served from that package (`:8-11, 33-41, 59-64`).

  `tsconfig.worker.json` type-checks these two files with the `WebWorker` lib. GNOME needs nothing equivalent.

### 4.6 Realm bridging (`src/realm.ts`) and events (`src/events.ts`)

* All extension-facing values are created **in the extension's realm**:
  * `toRealm` uses the target realm's `structuredClone` (`:17-24`).
  * `jsonToRealm` round-trips through JSON in the target realm, which mirrors Chrome's message serialization
    (`:27-41`).
  * Promises are built with the target realm's `Promise` (`:64-77`).

  This keeps `instanceof Array` and `instanceof Promise` working inside extension code.
* `asyncApi` implements Chrome's dual calling convention (`:134-163`). A trailing callback gets the result, with
  `runtime.lastError` set on failure and "Unchecked runtime.lastError" logged if nobody read it. Without a callback,
  the call returns a realm Promise. `syncApi` is the synchronous variant (`:166-177`).
* `ChromeEvent` has `addListener`, `removeListener`, `hasListener` and `hasListeners`, plus declarative
  `addRules`/`getRules`/`removeRules` storage (`events.ts:19-122`).
  * `dispatch` queues one microtask per listener.
  * `dispatchSync` collects return values; it is used for blocking webRequest and `onMessage`.
  * `EventTable` creates named events lazily per context (`:125-155`).

### 4.7 Registry and data model (`src/registry.ts`)

* `SapphireRegistry` holds (`:156-380`):
  * `extensions: Map<id, ExtensionState>`;
  * a flat `contentScripts` list (manifest, scripting and userScripts registrations);
  * `contexts: Set<ExtensionContext>`;
  * `tabs: Map<tabId, TabState>`.
* `ExtensionContext` (`:14-32`) is one realm that holds an extension API:
  * `kind ∈ background | popup | tab | offscreen | sidepanel | iframe | content | devtools`;
  * plus `window`, `document`, `tabId`, `frameId`, `documentId`, `url`, `world`, an `EventTable`, the `alive` flag,
    the `lastError` state, the `chrome` object, ports and cleanup callbacks.

  A context dies on `pagehide`, or lazily when its document changes (`isAlive`, `:268-280`).
* `ExtensionState` (`:89-118`) holds:
  * the manifest (localized);
  * `PackageFiles`;
  * locales and messages;
  * four storage areas (`local`/`sync` persisted; `session`/`managed` in memory only; `:176-181`);
  * DNR state;
  * default and per-tab action state;
  * context menu items, alarms and notifications;
  * background and offscreen handles;
  * side panel state;
  * granted permissions and origins;
  * user-script world configs and misc settings.
* `TabState` holds the url, title, status and favicon, plus a `frames: Map<frameId, FrameRecord>`. Frame ids are
  `0` for the top frame and a per-window incrementing counter otherwise, kept in a `WeakMap<Window, id>`
  (`:120-139, 335-379`).
* `dispatch(extId, event, args)` delivers to an extension's non-content contexts by default. `dispatchAll` delivers
  to every enabled extension (`:319-331`).

### 4.8 Messaging (`src/messaging.ts`)

Messaging is in-memory and same-thread. `deliverMessage` sends a JSON-cloned payload to every listener in the target
contexts, each in its own task (`:37-97`):

* the first `sendResponse` wins;
* returning `true` keeps the channel open;
* a returned thenable resolves the response;
* if no receiver is listening, the result is `"Could not establish connection. Receiving end does not exist."`;
* if nobody answers, the result is `"The message port closed before a response was received."` (`:6-7`).

Ports are `PortSide` pairs (`:101-178`). `openPort` dispatches `onConnect` as a task, so messages posted
immediately after `connect()` queue behind it (`:180-208`). A port disconnects when its peer context dies.

Routing in `api/runtime.ts:81-109`:

* `runtime.sendMessage` from an extension goes to the *other* extension contexts of the same extension.
* A different extension id routes to `onMessageExternal`.
* `tabs.sendMessage` targets content contexts in that tab, optionally filtered by frame or document
  (`api/tabs.ts:80-110`).

### 4.9 Storage, database and package files

* **Storage (`storage.ts:37-167`).** Each area keeps one in-memory `Map` per extension. Because all contexts share
  the page, that copy stays coherent. Writes are chained to IndexedDB in order. JSON semantics are enforced
  (`jsonClone`, `:26-30`), so Dates become strings and `undefined` members drop. Quotas are reported (`:6-18`) but
  **not enforced**. `api/storage.ts` adds `onChanged` (global and per-area) and the `session` access level.
* **IndexedDB `sapphire_extensions`, version 2 (`db.ts:1-34`):**

  | Store | Contents |
  | --- | --- |
  | `extensions` (keyPath `id`) | Metadata: manifest, enabled flag, `installedAt`, `fileList`, `lastRunVersion`, grants |
  | `extension_files` | key `<extId>/<path>`, value ArrayBuffer |
  | `extension_storage` | key `<extId>/<area>/<key>` |
  | `extension_state` | keys `<extId>/dnr`, `<extId>/scripts`, `<extId>/alarms` and `__browser/data` (history and bookmarks) |
* **`PackageFiles` (`files.ts:11-87`).** Reads from IndexedDB with caching. Content scripts must be injected
  synchronously at document start, and MV3 `importScripts` is synchronous, so their text is **preloaded at load
  time**: `readTextSync` (`:60-62`), and `loadExtension` preloads every content-script file plus all `*.js`/`*.mjs`
  files for service-worker extensions (`extensions.ts:156-158`).

### 4.10 Install pipeline (`src/crx.ts`, `src/extensions.ts`)

* **CRX parsing.** `parseCrx` accepts CRX2 (`Cr24`, version 2: public key and signature lengths) and CRX3 (header
  protobuf) (`crx.ts:12-30`). For CRX3, the extension id comes from `signed_header_data` (field 10000) → `crx_id`
  (field 1), encoded as 16 bytes in the `a`–`p` alphabet (`:34-40, 79-85`). Signatures are **not verified**.
* **ID precedence** (`extensions.ts:206-210`):
  1. `manifest.key`, hashed with SHA-256;
  2. the CRX3 `crx_id`;
  3. the CRX2 public key;
  4. SHA-256 of `name + "\n" + filename-without-version`.
* **Unpacking** (`extensions.ts:180-212`). JSZip; finds the shallowest `manifest.json` when the archive has a nested
  root; skips `__MACOSX/` and `_metadata/`, so `verified_contents` is dropped. `parseManifestText` tolerates comments
  and trailing commas (`:30-60`).
* **Storing** (`:214-229`). Files are written in batches of 200. `enabled`, `installedAt` and `lastRunVersion`
  survive reinstall.
* **Loading** (`:140-162`):
  1. locales (`_locales/*/messages.json`, Chrome's fallback chain, `api/i18n.ts:30-48`);
  2. manifest localization;
  3. the default icon as a data URL;
  4. DNR state;
  5. manifest content scripts plus persisted dynamic registrations (default `run_at: document_idle`, `:80-95`);
  6. preloading;
  7. alarms.

### 4.11 Match patterns (`src/matchPatterns.ts`)

The module implements Chrome match patterns (`:1-6, 29-96`):

* `<all_urls>` covers http, https, ws, wss, ftp, file, urn and data.
* Scheme `*` means http, https, ws and wss.
* `*.host` also matches the bare host.
* A missing port matches any port.
* The path is matched against path plus query, never the fragment.
* `include_globs`/`exclude_globs` support `*` and `?` (`:104-126`).

### 4.12 Extension contexts in frames (`src/frames.ts`)

* **Extension documents** (alias-origin URLs) get an `ExtensionContext` in `init.pre`. Sapphire builds the
  `chrome` object and assigns it to `window.chrome` (`:380-407`).
* **MV3 background page.** The page gets a service-worker shim (`installServiceWorkerShim`, `:137-249`):
  * `importScripts` injects preloaded file text as `<script>`;
  * `clients.matchAll`/`get`/`openWindow`/`claim`;
  * `registration` and `serviceWorker`;
  * `skipWaiting`;
  * `ServiceWorkerGlobalScope` and `WorkerGlobalScope` constructors whose `instanceof` is true for that window;
  * `ExtendableEvent`.

  Synthetic `install` and `activate` events fire after `load` (`:315-329`).
* **Other extension pages** get a stand-in `navigator.serviceWorker` that talks to "their" background
  (`installPageServiceWorkerShim`, `:257-312`). Scramjet deletes the real one; probe check 3.4 confirms it is gone by
  `init.post`.
* **`init.post` for extension tab, popup and side-panel pages.** `window.close()` is redirected to closing that
  popup or tab (`:422-434`).
* **All tab frames and extension frames** get:
  * history traversal bounded to the frame's own entries, so `history.back()` cannot navigate the host (`:32-63`);
    this relies on a reference to the Navigation API object captured in `init.pre`, before Scramjet removes it
    (`:24-25, 355-360`);
  * a keyboard-shortcut listener (`:537-552`);
  * for tab frames only, a context-menu capture listener (`:554-600`) and lifecycle watchers (`:444-535`).

### 4.13 Action, popup and other UI-facing APIs

* **Action** (`api/action.ts`). The action state (title, icon data URL, badge text and colors, popup, enabled) exists
  per extension and per tab (`:61-70`). Setters notify the host through `onChange`.
  * `clickAction` (`:152-164`) does one of the following:
    * opens the popup through `host.openPopup`, if there is one;
    * else opens the side panel, if `openPanelOnActionClick` is set;
    * else fires `action.onClicked`, `browserAction.onClicked` or `pageAction.onClicked`.
  * With `displayActionCountAsBadgeText`, the badge shows the DNR block/redirect count per tab.
  * The host renders the toolbar from `getInstalledExtensions(tabId)`.
* **Popup mounting.** `mountExtensionPopup(iframe, extId, tabId)` creates a `kind:"popup"` Frame on the popup URL.
  `unmountExtensionPopup` destroys it, so its ports disconnect as in Chrome (`sapphire.ts:335-348`).
* **contextMenus** (`api/contextMenus.ts`). Items are stored per extension (`:24-126`). Entries are filtered by
  contexts and URL patterns. When an extension has more than one top-level item, they are folded under its name
  (`:138-162`). On click, checkbox and radio state is updated and `onClicked` plus the legacy `onclick` fire
  (`:164-196`). The host draws the menu. Sapphire supplies the items and a `select()` callback.
* **commands** (`commands.ts`). `suggested_key` is chosen per platform; the Mac `Command` vs `MacCtrl` distinction
  and the shifted-key fallback via `code` are handled (`:34-72`). Keydown is captured in every frame and in the host.
  `_execute_action`, `_execute_browser_action`, `_execute_page_action` and `_execute_side_panel` are special-cased
  (`sapphire.ts:735-748`).
* **notifications** (`api/notifications.ts:18-48`). Delivered through `host.createNotification`, with fallbacks.
  Icons are resolved to data URLs.

### 4.14 Tabs, windows and navigation model

* `tabsModel.ts` merges the host's `TabInfo` with what Sapphire observed in the tab's frames. The observed values
  win for url, title, status and favicon (`:31-50`). `buildTab` fills in the Chrome `Tab` shape: `index` from host
  order, `width`/`height` from `getTabWindow`, `groupId -1`, `lastAccessed` (`:70-112`).
* **Windows are synthetic.** They are derived from `TabInfo.windowId`, default `1` (`:114-148`).
* **Observed navigation** (`frames.ts`):
  * In `init.pre` of a top frame, Sapphire sets status `loading`, fires `tabs.onUpdated`, and synthesizes
    `webNavigation.onBeforeNavigate` and `onCommitted` together. These fire at document init, after the response,
    not before the request (`:363-378`).
  * On `DOMContentLoaded` and `load` it fires `onDOMContentLoaded` and `onCompleted`.
  * At `load` it also sets status `complete`, the title and the favicon, and records history (`:459-486`).
  * A `MutationObserver` tracks title changes for 5 s after load (`:487-503`).
  * Wrapped `pushState`/`replaceState`, `popstate` and `hashchange` produce `onHistoryStateUpdated` and
    `onReferenceFragmentUpdated` (`:504-533`).
* **BrowserData** (`browserData.ts`). History (up to 5,000 items), a bookmark tree and recently closed tabs (25), all
  Sapphire-owned and stored in `extension_state/__browser/data`. These are **not** the host's history or bookmarks.

### 4.15 Cookies (`api/cookies.ts`)

The cookies API is backed directly by the Scramjet controller's jar (`:31-39, 101-109`):

* **Read:** parse `controller.cookieJar.dump()`, a JSON object keyed `"<.domain>@<path>@<name>"`; see core
  `shared/cookie.ts:196-198`.
* **Write or delete:** build a `Set-Cookie` string (deletes use `Max-Age=0`), then call `cookieJar.setCookies(str, url)`,
  `controller.persistCookies()` and `controller.propagateCookieSync([{url, cookie}])`.

Limitations:

* There is a single store `"0"`.
* `onChanged` fires only for changes made by extensions, never for site-set cookies.
* There is **no host-permission check**.
* `browsingData.removeCookies` clears the whole jar: `clear()`, persist, propagate with `{clear: true}`
  (`api/misc.ts:808-814`).

### 4.16 scripting and userScripts (`api/scripting.ts`)

* `executeScript({target, func|files, args, world, injectImmediately})`:
  * validates arguments (exactly one of func or files; `allFrames` excludes `frameIds`/`documentIds`);
  * serializes `func` with `String(func)`;
  * hands off to `Sapphire.executeScript` (`:144-175`).
* `insertCSS` and `removeCSS` take code or files.
* `register/update/unregister/getRegisteredContentScripts` store registrations and persist them unless
  `persistAcrossSessions:false` (`:97-142`).
* `userScripts.*` reuses the registration code with world `USER_SCRIPT`. `configureWorld` stores `csp` (not
  enforced) and `messaging` (enforced for the USER_SCRIPT runtime) (`:200-235`; `api/runtime.ts:277-298`).

### 4.17 `compat.ts` and `autoStub.ts`

* `compat.ts`: per-extension interventions. There is a single entry: Tampermonkey
  (`dhdgffkkebhmkfjojejmpbldmpobfkfo`) receives `sender.url` as `chrome-extension://…` because it checks the scheme
  (`:12-15`; used at `api/runtime.ts:35`).
* `autoStub.ts`: `withMissingMemberFallback({})` wraps an object in a Proxy. Any missing property becomes a
  callable "auto-stub" that behaves as follows (`:3-58`):
  * it invokes a trailing callback with `undefined`;
  * it returns another stub;
  * it is a thenable that resolves to `undefined`;
  * `addListener`/`removeListener` are no-ops;
  * `hasListener` returns `false`;
  * it coerces to `""` and `0`.

  It is applied to every **granted permission name with no implementation** (`api/index.ts:160-166`). Feature
  detection passes and calls quietly do nothing.

---

## 5. How content scripts and CSS get into proxied frames (c)

The timeline for every tab document, including nested frames when `all_frames` is set:

1. **Response time.** The document passes through the controller's HTML rewriter. Scramjet's inject scripts are
   placed first in `<head>` (core `html.ts:236-263`).
2. **`init.pre`**, inside the inject script, before any page script (`frames.ts:347-410`). Sapphire:
   1. records the frame (`frameId`, a random 32-hex `documentId`, the URL);
   2. emits the tab and navigation events described in §4.14;
   3. if any content scripts are registered, wraps `Element.prototype.attachShadow` to remember closed shadow roots,
      used by `chrome.dom.openOrClosedShadowRoot` (`:71-86`);
   4. for non-extension documents, calls `installContentWorld` (`content.ts:88-152`). That function creates a
      per-document `ContentWorld` and, on the **native `window.chrome` object**, replaces `runtime`, `storage`,
      `i18n`, `extension` and `dom` with per-caller getters. Page code still sees the page's own values, or the
      `externally_connectable` runtime (`:114-148, 567-571`). If MAIN-world scripts are registered, it also wraps
      `Object.defineProperty` and `Reflect.defineProperty` (`:149, 272-297`).
3. **`client.hook()`.** Scramjet installs its realm hooks.
4. **`init.post`** runs `startContentScripts(world)` (`frames.ts:420`; `content.ts:425-452`):
   1. **Matching** (`:377-389`). Only enabled extensions are considered. Subframes need `allFrames`. Manifest
      `matches`/`exclude_matches` plus globs are applied. For about:, data:, blob: and javascript: documents the
      parent's URL is used when `match_about_blank` or `match_origin_as_fallback` is set (`:363-375`).
   2. **All CSS of every matching registration is injected first**, as `<style data-sapphire-extension="<id>">` in
      `head` (or `documentElement`). This includes registrations whose JS runs at `document_idle`. CSS text is
      localized (`__MSG_*__`, `chrome-extension://` → alias) and is rewritten by Scramjet's CSS rewriter
      (`:336-349, 329-334`).
   3. **JS phases.** `document_start` runs immediately. `document_end` runs when `readyState` becomes
      `interactive`. `document_idle` runs at `complete` or 200 ms after `interactive`, whichever comes first
      (`:439-451`).
   4. **Running a file** (`:391-418, 299-317`):
      * The preloaded text is read synchronously.
      * For ISOLATED and USER_SCRIPT worlds, the per-extension `ExtensionContext` is created or fetched with its own
        `chrome` object (`:155-173`).
      * The code is appended as an inline `<script>` (Scramjet rewrites it like page script) with a
        `//# sourceURL=` set according to the world (`:319-327`):

        | World | sourceURL |
        | --- | --- |
        | ISOLATED | `https://<id>.<suffix>/<file>` |
        | MAIN | `chrome-extension://<id>/<file>` |
        | USER_SCRIPT | `chrome-extension://<id>/__sapphire_user_script__/<file>` |
      * The element is removed immediately.
      * `world.injecting` is set while the code runs synchronously.
5. **Caller attribution for `chrome.*` at any later time.** The getter takes, in order (`content.ts:49-86, 130-139`):
   1. `world.injecting`, during top-level execution;
   2. otherwise, the extension found by scanning `Error.captureStackTrace` output for the alias host (or the
      USER_SCRIPT marker), which identifies callbacks that run later;
   3. otherwise, the page's value.
6. **MAIN-world scripts** may monkey-patch DOM prototypes. Sapphire snapshots configurable descriptors on about a
   dozen prototypes before and after each MAIN injection, then swaps each changed member for a dispatcher. Calls that
   come from extension isolated code reach the original; everyone else reaches the patch (`content.ts:186-269`).
   Later patches are caught through the wrapped `defineProperty` (`:272-297`).
7. **`scripting.executeScript` / `tabs.executeScript`** (`content.ts:506-563`):
   * The `func` source string is "repaired": trailing characters are trimmed until it parses, because Scramjet's
     `toString` may overrun (`:495-504`).
   * It is wrapped in a self-reporting IIFE and injected the same way as content scripts.
   * The result is JSON-cloned.
   * Unless `injectImmediately` is set, it waits for `interactive`.
   * There is a 30 s safety timeout.
   * `files` runs sequentially and returns `result: null`.

### Browser-compatibility finding **[probe]**

Probed in Chromium 156.0.8078.4 and Firefox 157.0:

* Both support `Error.captureStackTrace` and `Error.stackTraceLimit`.
* In both, a function defined in an inline `<script>` that carries `//# sourceURL=https://<id>.sapphire-extension.invalid/cs.js`
  shows that URL in `new Error().stack`, both synchronously and from a later timer.
* **Only Chromium has a native `window.chrome`** (keys `loadTimes, csi, app`). Firefox has `typeof window.chrome === "undefined"`.
* `installContentWorld` installs the getters only if `window.chrome` is an object (`content.ts:119-120`). In Firefox,
  content scripts would therefore find no `chrome` at all. This conclusion comes from code reading; end-to-end in
  Firefox is **UNVERIFIED**.

So the design is effectively Chromium-only. The harness also only launches Chrome (`test/run.mjs:9-12`).

---

## 6. Where and how DNR and webRequest block requests (d)

**Requests are filtered in the host page,** inside `fetch.request` (with `fetch.preresponse` for response headers).
The SW is not involved. The pipeline in `onFetchRequest` (`network.ts:190-288`):

1. Alias extension host: serve the extension resource as an early response (`:197-201`).
2. Skip non-http(s) URLs. Complete `identity.launchWebAuthFlow` on `*.chromiumapp.org` (`:202-206`).
3. **Skip requests initiated by extension pages.** Extension traffic is invisible to DNR and webRequest (`:207-209`).
4. Fast path: return if no enabled extension has DNR rules and no context has webRequest listeners (`:211-213`;
   `sapphire.ts:678-684`; `api/webRequest.ts:85-90`).
5. Build request details (`:215-233`):
   * `tabId` is set only for `kind:"tab"` frames, else -1;
   * the resource type comes from `parsed.destination` plus `isIframe` (`:41-79`), and `""` maps to
     `xmlhttprequest`;
   * `frameId` and `documentId` are looked up by matching `clientUrl` against the tab's frame registry (`:180-188`);
   * `initiator` is the `clientUrl` origin.
6. **DNR evaluation** (`dnr.ts:397-429`, `evaluateExtension` `:338-384`). Extensions are evaluated newest first.
   * Each extension has a cached index, rebuilt when `dnr.version` bumps (`:216-233`):
     * `urlFilter` rules keyed by their "best token" (longest alphanumeric run not touching `*`, common tokens
       demoted; `:152-174`);
     * rules that have only `requestDomains`, keyed by domain;
     * a generic list for everything else.
   * Candidates are the generic rules plus token hits from the URL's alphanumeric runs plus domain hits up the
     host's suffix chain (`:270-292`).
   * `urlFilter` supports `||`, `|`, `^` and `*`, compiled to a RegExp, case-insensitive by default
     (`:124-148`). `regexFilter` is a JS RegExp.
   * Conditions supported (`:235-268`):
     * `resourceTypes`/`excludedResourceTypes` (with no list given, `main_frame` is excluded by default; `:181`);
     * `requestMethods`/`excludedRequestMethods`;
     * `tabIds`/`excludedTabIds`;
     * `requestDomains`/`excludedRequestDomains`;
     * `initiatorDomains`/`excludedInitiatorDomains`, falling back to legacy `domains`/`excludedDomains`;
     * `domainType`, using a **hard-coded table of about 40 multi-label suffixes** instead of the PSL (`:96-114`).
   * Within one extension, the best rule is chosen by `priority`, then by action rank:
     allow 5 > allowAllRequests 4 > block 3 > upgradeScheme 2 > redirect 1 (`:64-71`). modifyHeaders rules above
     the allow floor are merged; higher priority owns set/remove, and appends accumulate (`:380-395`).
   * **Across extensions**, any block wins. Otherwise the first redirect wins (newest extension). Otherwise
     allowAllRequests or allow.
   * `allowAllRequests` matched on a main or sub frame is remembered under the key `"<tabId> <documentUrl>"`, at
     most 500 entries. It acts as an inherited allow for that document's subresources (`network.ts:236-252`;
     `dnr.ts:372-378`).
   * Redirect targets: `url`, `extensionPath` (alias URL), `transform` (scheme, host, port, path, query with
     `queryTransform`, fragment, credentials) and `regexSubstitution` (`\1`–`\9`). `upgradeScheme` maps http→https
     and ws→wss (`dnr.ts:294-335`).
7. **Effects** (`network.ts:254-265, 98-112`):

   | Outcome | What the page receives |
   | --- | --- |
   | `block`, frame | `earlyResponse`: HTML page "This page has been blocked by an extension", 200, header `x-sapphire-blocked: document` |
   | `block`, subresource | `earlyResponse`: 403 with header `x-sapphire-blocked: 1`. webRequest `onErrorOccurred` gets `net::ERR_BLOCKED_BY_CLIENT` |
   | `redirect` / `upgradeScheme` | `earlyResponse`: `307` with `location`. Scramjet rewrites the Location and the browser follows inside the proxy; probe check 3.4 #8 confirmed the mechanism |
   | request header ops | applied to `props.init.headers` (the already-computed upstream headers, including the jar's `Cookie`) |
   | response header ops | applied in `preresponse` on the **raw upstream** headers, before Scramjet stores cookies or rewrites headers (`network.ts:294`) |
8. **Bookkeeping** (`network.ts:154-178`):
   * With `declarativeNetRequestFeedback`, matches are recorded (up to 5,000 entries) and `onRuleMatchedDebug` fires.
   * Per-tab counts of block, redirect and upgrade outcomes feed the badge. They reset when the top frame goes to
     `loading`.
9. **DNR API** (`api/dnr.ts:35-130`): dynamic rules (persisted, max 30,000), session rules (5,000), static rulesets
   (manifest `rule_resources`), `updateEnabledRulesets`, `updateStaticRules`/`getDisabledRuleIds`, `isRegexSupported`
   (a heuristic that rejects lookaround and backreferences), `testMatchOutcome`, `getMatchedRules` and
   `setExtensionActionOptions`.

**webRequest emulation** (`api/webRequest.ts:97-132`; `network.ts:267-333`):

* **Stages:**
  * `onBeforeRequest`: blocking; `cancel` or `redirectUrl`.
  * `onBeforeSendHeaders`: blocking; `cancel` or `requestHeaders`.
  * `onSendHeaders`.
  * `onHeadersReceived`: blocking; `cancel`, `redirectUrl` or `responseHeaders`. Runs in `preresponse`.
  * `onBeforeRedirect`, including real 3xx responses.
  * `onResponseStarted` and `onCompleted`. Both run in `response`.
  * `onErrorOccurred`, only for blocks.
* Listeners registered with `"blocking"` run **synchronously** and must return a plain object. Promise results are
  not supported. **MV2-style blocking works for any extension with the `webRequest` permission**; there is no
  `webRequestBlocking` check.
* The `extraInfoSpec` values `requestHeaders`/`responseHeaders` shape the details object. `requestBody` is never
  filled. `onAuthRequired` never fires.
* Filters: `urls`, `types` and `tabId`. A listener only sees URLs covered by the extension's host permissions.

**Gaps:**

* No WebSocket filtering (§3.5).
* `responseHeaders` and `excludedResponseHeaders` *conditions* are declared but never evaluated.
* No RE2 semantics.
* Static rules are not validated and rule counts are not enforced for them.
* `domainType` errs for most eTLDs.
* Evaluation is synchronous on the UI thread.

---

## 7. How a browser shell integrates (tabs model) (e)

Reference shell: `test/harness/web/main.ts`.

1. **One Scramjet Frame per tab** (`openTab` at `:146-159`): create an `<iframe>` and call
   `controller.createFrame(iframe, { plugins: [sapphire.createPlugin(tabId)] })`. Then call
   `sapphire.notifyTabCreated(id)`, plus `notifyTabActivated(id)` if the tab is active, and finally
   `frame.go(sapphire.resolveUrl(url))`. `resolveUrl` turns `chrome-extension://…` into the alias URL.
2. **Host-owned state.** The host owns tab ids, order, the active tab and windows, and exposes them as `TabInfo`
   (`id, windowId, url, title, active, index?, pinned?, favIconUrl?, status?, audible?, muted?, incognito?, openerTabId?`;
   `types.ts:184-198`). Sapphire overlays what it observed in the frames. The harness computes `url` by removing
   `frame.prefix` from the iframe's `location.pathname` and decoding the remainder (`main.ts:41-51`).
3. **Host → Sapphire events:**
   * `notifyTabActivated(id, windowId?)` on focus changes;
   * `notifyTabRemoved(id, windowId?)` on close, which destroys that tab's contexts and records a closed tab
     (`main.ts:165-179`; `sapphire.ts:857-877`);
   * `notifyTabUpdated(id, {status, url, title})` is optional, since Sapphire observes frames itself.
4. **Sapphire → host:** tab operations through the bindings in §4.2. In the harness:
   * `createTab` → `openTab`;
   * `navigateTab` → `frame.go`;
   * `reloadTab` → `frame.reload`;
   * `goBack` and `goForward` → `frame.back()` and `frame.forward()` (`main.ts:90-136`).
5. **UI the host renders:**
   * the toolbar from `getInstalledExtensions(activeTabId)`, re-rendered through `sapphire.onChange` (`main.ts:215-243`);
   * popup hosting (`openPopup` → `mountExtensionPopup(popupIframe, extId, tabId)`; hide → `unmountExtensionPopup`);
   * the context menu (`showContextMenu` → render → `request.select(entry)`, `:333-365`);
   * notifications as toasts;
   * the permission prompt (`confirm()`);
   * a side-panel placeholder;
   * the extension manager (install from file, Web Store id or URL; enable, reload, options, remove;
     `:245-329`).
6. **Keyboard.** The host forwards its own `keydown` to `sapphire.handleKeyboardEvent(e)` (`main.ts:434-436`). Frames
   are covered by Sapphire's in-frame listener.
7. **Boot order** (`main.ts:369-398`):
   1. register the SW and wait for `controller`;
   2. create and `init()` a `LibcurlTransport({ wisp: "ws://<host>/wisp/" })`;
   3. create the `Controller` and `await controller.wait()`;
   4. `sapphire.attachController(controller)`, then `await sapphire.init()`.

---

## 8. What a host must implement (f)

**Infrastructure:**

* Serve the Scramjet and controller static files at the configured paths (§3.1).
* Provide a Wisp endpoint. The harness uses wisp-js on `/wisp/` with loopback and private IPs allowed, for tests
  (`test/harness/server.mjs:107-167`).
* Write a SW that `importScripts` `controller.sw.js` and routes `$scramjetController.shouldRoute(e)` →
  `route(e)`. The Sapphire router is only for legacy `/~/sx/` URLs.
* Bundle Sapphire's TypeScript sources.

**Bindings:**

* Minimum: `getTab`, `getAllTabs`, `getActiveTabId`, `getTabWindow`, `createTab` or `navigateTab`, `closeTab`,
  `activateTab`.
* For extension UIs: `openPopup` and `closePopup` (call `mountExtensionPopup` and `unmountExtensionPopup`).
* Optional: `createNotification`, `showContextMenu`, `requestPermissions` (**default grants everything**),
  `openSidePanel`, `captureTab`, `search`.
* `getTabId` must exist to satisfy the type, but it is unused.

**Calls into Sapphire:**

* `attachController` (or pass `controller`), then `init()`.
* `createPlugin(tabId)` for every tab Frame.
* `notifyTabCreated/Activated/Removed` (and optionally `notifyTabUpdated`).
* `clickAction`, `handleKeyboardEvent`, `installExtension(ArrayBuffer, filename)`, `setExtensionEnabled`,
  `uninstallExtension`, `reloadExtension`.
* Optionally `getNewTabOverride()` for new tabs and the omnibox `getOmniboxKeywords()` and `omniboxInput*()`.

**Address bar:** `displayUrl(aliasUrl)` gives the `chrome-extension://…` form. `resolveUrl(typed)` gives the URL to
load.

**Acquiring CRX files is the host's job.** The harness proxies
`https://clients2.google.com/service/update2/crx?response=redirect&prodversion=138.0&acceptformat=crx2,crx3&x=id%3D<id>%26uc`
through a dev-server endpoint `/api/crx/<id>` (`server.mjs:130-138`). A production GNOME should not offer this; see
§13.

---

## 9. `chrome.*` API coverage (g)

**Rules for which namespaces exist** (`api/index.ts:111-168`):

* **Content scripts** (ISOLATED world) get `runtime` (messaging subset), `i18n`, `extension` (MV2 subset) and `dom`,
  plus `storage` only with the `storage` permission. The **USER_SCRIPT** world gets `runtime` messaging only, and
  only after `userScripts.configureWorld({messaging:true})`.
* **Extension contexts** (background, popup, pages) always get the native `app`/`csi`/`loadTimes` extras, plus
  `runtime`, `extension`, `i18n`, `tabs`, `windows`, `permissions`, `management` (self subset), `commands` and
  `dom`.
* The manifest adds `action`, `browserAction` or `pageAction` (by manifest version) and `omnibox`.
* Each permission adds its namespace (`PERMISSION_NAMESPACES`, `:53-91`), plus `system.*`.
* **Any other granted permission name becomes an auto-stub namespace** (§4.17). Exceptions are names in
  `NON_NAMESPACE_PERMISSIONS` such as `activeTab`, `tabs`, `webRequestBlocking`, `unlimitedStorage` and
  `nativeMessaging` (`:170-187`).
* A granted `permissions.request` makes new namespaces appear in live contexts (`refreshChromeApi`, `:205-211`).

Levels used below: **Functional** means real behavior. **Partial** means it works for common cases, with notable
gaps. **Stub** means present but inert or fake. **Unsupported** means the call rejects with "not supported".

| Namespace | Level | Notes (file) |
| --- | --- | --- |
| `runtime` | Functional | sendMessage/onMessage, connect/ports, external messaging (`externally_connectable` pages too), `getURL` (**alias https URL, not chrome-extension://**), `getManifest` (localized), onInstalled/onStartup/onSuspend, `getContexts`, `openOptionsPage`, `setUninstallURL`, `reload`, `getPlatformInfo`, MV2 `getBackgroundPage`. Stubs: `requestUpdateCheck` returns no_update; `restart*`. `connectNative`/`sendNativeMessage` fail with "host not found". `onUpdateAvailable` and similar never fire (`api/runtime.ts`) |
| `extension` (MV2) | Functional / Stub | `getURL`, `sendRequest`/`onRequest`, `getViews`, `getBackgroundPage`, `getExtensionTabs`. `isAllowed*Access` returns false (`api/runtime.ts:234-274`) |
| `i18n` | Functional | `getMessage` (placeholders, `$1`–`$9`, `@@` predefined), `getUILanguage`, `getAcceptLanguages`. `detectLanguage` is a script-range heuristic (`api/i18n.ts`) |
| `storage` | Functional | local/sync/session/managed (managed is read-only and empty), onChanged, session access level. Quotas are not enforced. `sync` is never synced (`api/storage.ts`, `storage.ts`) |
| `tabs` | Functional / Partial | query (most filters), get, getCurrent, create, update (url/active only), remove, reload, goBack/goForward, sendMessage/connect, MV2 executeScript/insertCSS/removeCSS, captureVisibleTab, detectLanguage (`<html lang>`). Events fired: onCreated, onUpdated, onRemoved, onActivated, onHighlighted. Stubs: discard, move, highlight (activates the first tab), zoom (factor 1), ungroup. `group` throws. onMoved, onDetached, onAttached, onReplaced and onZoomChange never fire (`api/tabs.ts`) |
| `windows` | Partial | Synthetic, built from `TabInfo.windowId`. `create` opens tabs. `update` and `remove` are no-ops. Events never fire (`api/tabs.ts:233-270`) |
| `scripting` | Functional | executeScript (func+args, files, ISOLATED/MAIN, frameIds/documentIds/allFrames), insertCSS/removeCSS, dynamic content scripts (persisted). **No host-permission enforcement** |
| `userScripts` | Partial | register/update/unregister/getScripts, execute, configureWorld (`messaging` honored, `csp` ignored). The USER_SCRIPT world is the page realm |
| Manifest `content_scripts` | Functional, not isolated | §5. Chromium only |
| `declarativeNetRequest` | Partial → Functional | §6. Gaps: response-header conditions, RE2, PSL, WebSockets |
| `webRequest` | Partial | §6. Synchronous blocking only. No requestBody. No onAuthRequired. No WebSockets |
| `webNavigation` | Partial | onBeforeNavigate+onCommitted are synthesized at document init; also onDOMContentLoaded, onCompleted, onHistoryStateUpdated, onReferenceFragmentUpdated, getFrame/getAllFrames. onErrorOccurred, onCreatedNavigationTarget and onTabReplaced never fire |
| `cookies` | Partial | get/getAll/set/remove over the Scramjet jar. onChanged only for extension writes. Single store. No host-permission check |
| `action` / `browserAction` / `pageAction` | Functional (state only; the host renders it) | title, icon (path or ImageData → data URL), popup, badge (text, background, text color), enable/disable/isEnabled, openPopup (needs the host), onClicked, `getUserSettings` returns `{isOnToolbar:true}`; pageAction show/hide |
| `contextMenus` | Functional (the host renders) | create/update/remove/removeAll, onClicked plus legacy onclick, patterns, checkbox and radio, `%s` |
| `commands` | Functional | getAll, onCommand, platform-specific `suggested_key`. Users cannot remap |
| `notifications` | Functional (via the host) | create/update/clear/getAll, click/close/button events. `getPermissionLevel` returns "granted" |
| `alarms` | Functional | Persisted and restored. Runs only while the host page is open |
| `permissions` | Bookkeeping | request (host prompt, default grant)/contains/getAll/remove/events. **Not an enforcement layer**: only webRequest checks host permissions (`api/webRequest.ts:102` is the only `hostAllowed` caller) |
| `management` | Functional (over Sapphire's registry) | getSelf/get/getAll/setEnabled/uninstall(Self)/events. Permission warnings return `[]`. App methods throw |
| `identity` | Partial | `getRedirectURL`, `launchWebAuthFlow` (proxied overlay). `getAuthToken` throws "OAuth2 not granted or revoked." |
| `offscreen` | Functional | One hidden frame per extension |
| `sidePanel` | Partial | Option and behavior state. `open` goes through the host. `close` is a no-op. onClosed never fires |
| `downloads` | Partial | `download` uses the transport directly (no site cookies, no DNR), then triggers an `<a download>` click. search/erase work. Everything else is a no-op |
| `history`, `bookmarks` | Functional over **Sapphire's own** stores | Not the shell's history or bookmarks |
| `topSites`, `sessions` | Partial | topSites comes from visit counts. sessions offers recently closed tabs (memory, 25) and restore; tab values are kept in memory |
| `idle` | Partial | Activity is detected only on the host document. Input inside proxied iframes is **not** seen |
| `tts` | Functional | Web Speech API |
| `power`, `system.*` | Stub | No-ops and synthetic hardware values |
| `privacy`, `proxy`, `contentSettings`, `fontSettings` | Stub | Values are stored in an in-memory map and onChange fires, but there is **no effect on browsing** |
| `search` | Functional (via the host) | Fallback: google.com |
| `tabGroups`, `readingList`, `declarativeContent` | Stub | No groups. The reading list lives in memory. declarativeContent rules are stored but never evaluated |
| `browsingData` | Partial | Cookies (the whole jar) and history only. The rest are no-ops |
| `instanceID` / `gcm` | Partial / Unsupported | `getID` returns a random value; `getToken` throws |
| `debugger`, `pageCapture`, `desktopCapture`, `tabCapture`, `ttsEngine` | Unsupported | Methods reject (`api/misc.ts:906-916`) |
| `devtools.*` | Absent | `devtools_page` is ignored. The `"devtools"` context kind exists but nothing creates it |
| Any other permission | Auto-stub | Silent success |

**Overall assessment.** Sapphire is a broad façade, good enough for UI- and content-script-centric extensions in a
Chromium host. Its own suite targets Dark Reader, Violentmonkey, Tampermonkey, Stylus, Vimium, uBO Lite,
SponsorBlock and Return YouTube Dislike (`test/suites.mjs`). Those fixtures are not in the repo, so I could not
verify the claims: **UNVERIFIED**. `test/repro-vm-xhr.mjs` documents a known open problem: Violentmonkey's
`GM_xmlhttpRequest` does not complete.

It falls short of Chrome in these ways:

* deep-integration APIs are stubbed;
* the permission model is not enforced;
* there is no process or realm isolation;
* navigation events are synthesized;
* MV3 service workers are pages that are never terminated;
* everything runs on the host's UI thread.

---

## 10. Test harness (h)

* **Servers** (`test/harness/server.mjs`), both in one Node process:
  * **host** `http://localhost:5199`: Vite serving the harness app, the Scramjet and controller files from
    `node_modules` (`:37-43`), the esbuild-built `/sapphire-sw-router.js` (`:45-55, 125-128`), dev endpoints
    `/api/crx/<id>` and `/api/fetch?url=` (`:130-146`), and wisp-js on the `/wisp/` upgrade (`:165-167`);
  * **site** `http://127.0.0.1:5200`: static `test/site/*`, test extensions zipped on the fly at
    `/ext/<name>.zip`, plus `/echo` and `/set-cookie` (`:70-105`).

  The site is deliberately a different origin, so every test page goes through the proxy. Ports come from
  `HOST_PORT`/`SITE_PORT`.
* **Harness app** (`test/harness/web/`): a minimal browser shell (§7) that exposes `window.harness` with:
  `ready`, `controller`, `sapphire`, `logs`, `notifications`, `contextMenus`, `popups`, `sidePanels`, `tabs`,
  `openTab`, `navigate`, `closeTab`, `activate`, `tabWindow(id)`, `installFromUrl`, `popupWindow()`,
  `backgroundWindow(extId)` and `clearAll` (`main.ts:441-472`).
* **Runner** (`test/run.mjs`):
  * launches Chrome through `playwright-core` (`executablePath` is `$CHROME` or `/usr/bin/google-chrome-stable`,
    headless unless `HEADFUL` is set);
  * gives each suite a fresh context;
  * provides a helper `t` with `check`, `eq`, `waitFor(fn, arg, timeout)` (polling `waitForFunction` at 100 ms) and
    `eval`;
  * prints filtered console output on failure.

  Suites (`test/suites.mjs`):
  * `mv3-basic`, 60 assertions (`:8-122`), using `test/extensions/mv3-basic`. It covers:
    * the SW shim: importScripts, install event, onInstalled, `instanceof ServiceWorkerGlobalScope`;
    * i18n;
    * content-script timing and isolation semantics;
    * messaging: sync, async, promise, no-reply, ports;
    * storage JSON semantics;
    * web_accessible_resources;
    * `executeScript`;
    * a DNR block of `/blocked.txt`;
    * extension iframes;
    * tabs.onUpdated, webNavigation, alarms;
    * the popup (tabs.query, sendMessage, CSS);
    * context menus, keyboard commands, `all_frames`.
  * `vencord-style-loader` (`:255-271`): a background fetches a bundle and evals it into the page's MAIN world.
  * `real:*` suites (darkreader, violentmonkey, vimium, tampermonkey, stylus, ublite): run only if
    `test/site/crx/<name>.crx` exists. **The directory is absent and `*.crx` is gitignored**, so they are skipped by
    default.
  * `net:youtube`: needs `NETWORK=1` plus the SponsorBlock and RYD CRXs.
* **`test/realworld.mjs`**, exploratory. For each CRX in `test/site/crx/`, it installs the extension, opens a page,
  clicks the action and dumps the context kinds, page and popup state and filtered errors. Note: with no `crx/`
  directory, `readdirSync` throws unless names are passed on the command line.
* Other scripts: `test/harness/probe.mjs` (uBO Lite reload probe), `test/repro-vm-xhr.mjs` (an interactive repro),
  and `test/cherri*.mjs` (integration against a downstream host, "cherri-v3" on :5301, through
  `window.__cherriSapphire`).
* **What GNOME should reuse (as an approach, not code):**
  * two origins (app vs. test site), so everything is proxied;
  * an in-page `window.<app>Test` handle;
  * Playwright polling assertions;
  * fixtures generated on the fly.

  Locally, `playwright-core@1.64.0` matches the cached `chromium-1248` and `firefox-1555` builds (from its
  `browsers.json`); use `executablePath: ~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`. **[probe]**

---

## 11. Security and robustness assessment

These matter both for understanding Sapphire and for deciding about MV3 support (§13).

1. **One real origin for everything.** GNOME's UI, the controller and its global cookie jar, every proxied site and
   every extension page share the host origin. Containment depends entirely on Scramjet's JS virtualization, which is
   not a security boundary. Probe check 3.4 #7 shows how unrewritten code immediately sees the real origin.
2. **Content scripts share the page realm.** Page scripts can observe or tamper with content-script code and data,
   and can get hold of an extension's content-script `chrome` API. Two routes exist: imitating the sourceURL-based
   caller attribution, or running inside DOM methods that content scripts call while `world.injecting` is set. A
   hostile page can therefore send messages to the extension's background as if it were the content script. For
   extensions that trust content-script messages (user-script managers, password managers) this is a
   privilege-escalation path. This document describes the class of problem only.
3. **No `web_accessible_resources` enforcement.** Any proxied page can fetch any file of any installed extension
   (`network.ts:122-152`).
4. **Permissions are not enforced.** Host permissions gate only webRequest, and `requestPermissions` grants by
   default. Any installed extension gets:
   * the whole cookie jar for all sites (`cookies.getAll` with no host check);
   * header rewriting and redirection of any request (DNR/webRequest);
   * script injection into any tab (`scripting`).
5. **Everything runs on the host's UI thread.** Extension backgrounds are hidden iframes, so a busy or looping
   extension freezes the browser UI. There is no MV3 idle termination.
6. **Unverified packages.** CRX signatures are not checked. Extension ids fall back to a name+filename hash, so ids
   can collide or be spoofed.

---

## 12. Recommendations for GNOME's extension architecture

### 12.1 Principles

1. **Built-ins are first-party code in the host realm.** They are not emulated Chrome extensions. Each one is a
   GNOME module (`frontend/src/extensions/builtins/{adblock,trackers,privacy,cookies,cosmetic}`, as planned in
   ARCHITECTURE.md §3). Never hand privileged objects such as settings stores or the API client into proxied realms.
   Inject only inert data (CSS text) or small self-contained scriptlets.
2. **One realm-agnostic core, two engine adapters.** The policy, filter matching and decision logic must be pure
   TypeScript with no DOM and no Scramjet types. It is then used:
   * by the **Scramjet adapter**, in the host page, through plugin hooks;
   * by the **UV adapter**, in the service worker, through UV's event emitter.
3. **Synchronous hot path.** Matching, per-tab policy lookup and cosmetic CSS lookup must be synchronous at request
   or document-start time. `init.*` hooks are not awaited, and document_start cannot wait. Load and deserialize the
   engines at boot. Keep the effective settings in memory.
4. **Clean room.** Reuse ideas from this report, not Sapphire code.
5. **Every setting must have a real effect** (the rule in ARCHITECTURE.md §5.3). §12.4 maps each `extensions.*`,
   `privacy.*` and `browser.cookies.*` key to a hook.

### 12.2 Proposed structure

```
frontend/src/extensions/
├ core/                       # pure TS, used by window and SW
│ ├ policy.ts                 # resolve(topSite, frameSite, settings) → EffectivePolicy (§12.6)
│ ├ engine.ts                 # FiltersEngine wrapper: load/deserialize/match/cosmetics (@ghostery/adblocker)
│ ├ classify.ts               # resourceType from destination/isIframe; first/third party via tldts
│ ├ headers.ts                # pure header transforms (GPC/DNT, referrer trimming, cookie stripping)
│ └ stats.ts                  # per-tab counters + request log ring buffer
├ scramjet/
│ ├ ShieldPlugin.ts           # ManagedPlugin: fetch.request/preresponse/response, init.pre/post, rewriter.html.pre
│ ├ FilteringTransport.ts     # ProxyTransport wrapper → WebSocket (and host-level) blocking
│ └ frameScripts.ts           # document_start injections (cosmetic CSS, scriptlets, WebRTC policy)
├ uv/
│ └ uvShield.ts               # SW-side: uv.on('request'|'beforemod'|'response'), __uv$config.inject builder
├ runtime.ts                  # owns engine + settings snapshot; broadcasts changes (BroadcastChannel, SW postMessage)
└ builtins/{adblock,trackers,privacy,cookies,cosmetic}/   # feature toggles, UI panels, defaults
```

### 12.3 Filter engine and lists

* **Engine: `@ghostery/adblocker` 2.20.3 (MPL-2.0), used unmodified.** This is already planned in ARCHITECTURE.md §9.
  API verified from its `dist/esm/*.d.ts`:
  * `import { FiltersEngine, Request } from "@ghostery/adblocker"`.
  * `FiltersEngine.parse(text, config?)` and `FiltersEngine.fromLists(fetch, urls, config?, caching?)`.
  * `engine.serialize(): Uint8Array` and `FiltersEngine.deserialize(bytes)`. Cache the result in IndexedDB keyed by
    list versions, for a fast boot.
  * `engine.match(Request.fromRawDetails({ url, sourceUrl, type, tabId?, requestId? }))` returns
    `{ match, redirect?: {body, contentType, dataUrl, filename}, rewrite?, exception?, filter? }`.
  * `engine.getCosmeticsFilters({ url, hostname, domain, ancestors?, getBaseRules?, getInjectionRules?, … })` returns
    `IMessageFromBackground = { active: boolean, styles: string, scripts: string[], extended: […] }` (type from
    `@ghostery/adblocker-content@2.20.3`). `scripts` holds the scriptlet code strings to inject.
  * `engine.getHtmlFilters(request)`, `engine.getCSPDirectives(request)` and `engine.updateFromDiff(...)`.

  The engine runs in both window and SW contexts.
* Alternative: `brave/adblock-rust` (MPL-2.0) compiled to WASM. It is fast but needs more integration work. Keep it as
  a fallback if the JS engine is too slow on low-end devices. **UNVERIFIED performance**: benchmark EasyList plus
  EasyPrivacy matching on the host thread.
* **Registrable domains: `tldts` 7.4.19 (MIT).** Do not copy Sapphire's 40-entry suffix table.
* **Lists.**
  * The backend downloads the lists (`backend/src/filters/`, `GNOME_FILTERS_REFRESH_HOURS`), honoring the list's
    `! Expires:` header. EasyList currently says "4 days".
  * Store them in `$GNOME_DATA_DIR/filters/`, and serve them same-origin with an `ETag` to the SPA, for example
    `GET /api/filters/<id>`. Clients therefore never fetch lists through the proxy, and the server never learns
    browsing activity.
  * Attribute EasyList (GPL-3.0+ or CC BY-SA 3.0+, credited to "The EasyList authors") and the GPL-3.0 uBO and AdGuard
    lists in the UI.
  * Scriptlet and redirect resources taken from uBO assets are GPL-3.0. Check what `@ghostery/adblocker` ships before
    enabling scriptlets: **UNVERIFIED**.

### 12.4 Scramjet hook mapping (feature → hook → action)

| Feature / setting | Hook | Action | Evidence |
| --- | --- | --- | --- |
| Ad and tracker network blocking (`extensions.enabled.adblock/trackers`, `lists`) | `fetch.request` | Decide synchronously. Block with `props.earlyResponse`: 403/204, or typed empty content (empty JS or CSS, a 1×1 GIF) for less breakage. Use engine `redirect` resources as early responses; they are rewritten, so they are safe | probe checks 3.4 #5 and #6 |
| Block page for frames | `fetch.request` | `earlyResponse` with GNOME's static block page, which is then rewritten. Do **not** use `intercept` for HTML or JS (unrewritten) | probe check #7 |
| Tracking-parameter stripping (`privacy.stripTrackingParams`) | `fetch.request` | Subresources: replace `props.url`. Top-level navigations: `earlyResponse` 307 to the cleaned URL, so the page URL and history are correct | probe checks #8 and #9 |
| `Sec-GPC: 1` (`privacy.sendGpc`), `DNT: 1` (`privacy.doNotTrack`) | `fetch.request` | Append to `props.init.headers`. Navigator-level `globalPrivacyControl` would need an `init.post` patch (**UNVERIFIED** whether Scramjet exposes it) | probe check #10 |
| Referrer policy (`privacy.referrer`) | `fetch.request` | Trim or remove `referer` for cross-site requests (`origin-cross-site`), or always (`none`) | headers are visible in `props.init.headers` |
| Third-party / all-cookie blocking (`browser.cookies.mode`, `extensions.cookieRules`) | `fetch.request` + `fetch.preresponse` | Remove the `cookie` request header. Remove `set-cookie` in `preresponse`, before Scramjet stores it. For `session` rules, rewrite `Expires`/`Max-Age` away | probe checks #11 and #12 |
| JS cookie writes in third-party frames | `init.post` (or `init.pre`) | Wrap `ctx.client.init.sendSetCookie` **and** `ctx.client.context.cookieJar.setCookies` for frames whose site is third-party to the tab | observation verified (probe check #13); blocking **UNVERIFIED** |
| Cosmetic filtering (`extensions.enabled.cosmetic`, `cosmeticAggressive`, `perSite[*].cosmetic`) | `init.post` | Insert a `<style>` (or a `win.CSSStyleSheet` in `adoptedStyleSheets`) with `getCosmeticsFilters(...).styles`. Generic hides only when `cosmeticAggressive` is set | probe check #3 |
| HTML filtering (`##^` rules from `getHtmlFilters`) | `fetchHandler.hooks.rewriter.html.pre` | Remove matching nodes from `ctx.handler.root` before serialization (synchronous) | probe check #16 |
| Scriptlets (`+js(...)`) | `init.post` | Run the engine's scriptlet code in the frame realm at document_start, through an inline `<script>` that Scramjet rewrites. Keep scriptlets small, because of the rewrite cost (§3.6) | timing verified (probe check #2); scriptlets themselves **UNVERIFIED** |
| Per-site / allowlist (`extensions.allowlist`, `perSite`) | `init.pre` (top), `fetch.request` (main_frame), `client.hooks.lifecycle.navigate` | Recompute the tab's `EffectivePolicy` on every top-level commit and SPA navigation. Subframes inherit the tab's top-site policy | probe checks #2 and #15 |
| WebSocket blocking | Controller transport wrapper (`connect`) | Apply host-level rules. There is no tab context there; for that, keep a `wsUrl → tabId` hint from `init.post` patches (**UNVERIFIED**) | probe check #14 |
| WebRTC leak protection (privacy) | `init.post` | Policy-dependent: remove or wrap `RTCPeerConnection` in proxied frames. Scramjet leaves it native and its traffic bypasses the proxy | Scramjet's own runway test |
| Per-tab badge, logger, "N blocked" | all fetch hooks | Count by category, keyed by the plugin's `tabId` | — |
| Error UI | `error.request` | `setResponse` with GNOME's error page | `index.ts:339-354` |

### 12.5 Ultraviolet fallback (service worker)

The hook points below were verified in upstream `@titaniumnetwork-dev/ultraviolet@3.2.10` `dist/uv.sw.js`
(minified, checked by grep). The readable equivalents are in the NebulaServices fork in `repos/ultraviolet`
(`src/uv.sw.js`). Note that `repos/ultraviolet` is **that fork, not upstream**: it uses `@nebula-services/bare-client`
instead of bare-mux.

| UV hook | When | Data | Use for |
| --- | --- | --- | --- |
| `config.construct(ultraviolet, "service")` | per request, first (fork `:63`) | the `Ultraviolet` instance | rarely needed |
| `uv.on("request", e)` | before the network (fork `:120`) | `e.data` = RequestContext: `request` (the original `Request`), `url` (target `URL`, settable), `headers` (plain object, already holding UV's `cookie`/`referer`/`origin`/`user-agent`), `method`, `body`, `mode`, `cache`, `redirect` | network blocking with `e.respondWith(new Response(...))`; header edits; URL changes (param stripping) |
| `uv.on("beforemod", e)` | after the network, **before** UV strips CSP, rewrites `location`, stores `set-cookie` (in IndexedDB `__op`, store `cookies`) or rewrites the body (fork `:146`) | `e.data` = ResponseContext: `headers` (lower-cased), `status`, `body` (raw), `raw`, `request` | cookie policy (`delete headers["set-cookie"]`), response-header policy. Never `respondWith` unrewritten HTML or JS |
| `__uv$config.inject = [{ host: "<regex>", html: "<…>", injectTo: "head" or "body" }]` | present in upstream 3.2.10 (verified), absent from the fork. HTML is spliced into the raw document **before** rewriting, so inline scripts get rewritten | static per host regex | static cosmetic `<style>`; scriptlets (ordering relative to UV's handler: **UNVERIFIED**) |
| `uv.on("response", e)` | after rewriting (fork `:276`) | ResponseContext with the rewritten `body` string | dynamic per-site cosmetic CSS: insert `<style>` into rewritten HTML |

UV caveats:

* **No tab attribution in the hooks.** In GNOME's `sw.js`, keep a `WeakMap<Request, clientId>` filled in the `fetch`
  listener before calling `uv.fetch(event)`. Then apply a **frame-level** policy, using the requesting document's
  site. True per-tab policy is not available. UNVERIFIED design.
* **WebSockets do not pass through the SW.** They go over bare-mux's worker transport. Filtering them would need a
  wrapping bare-mux transport: **UNVERIFIED**.
* **Separate cookie stores.** UV keeps its own cookies (IndexedDB `__op`), separate from Scramjet's jar. The cookie
  manager and "clear site data" must handle both stores, and switching engines does not carry sessions over.
* The policy snapshot and the engine must also be loaded **inside the SW**. Deserialize them from Cache Storage or
  IndexedDB at SW start. Push settings changes with `postMessage`.

### 12.6 Per-site controls and allowlist

Use the ARCHITECTURE.md §5.3 keys as they are. Recommended semantics:

* **Site key.** The registrable domain of the **top-level** document (`tldts.getDomain(host)`), with an optional exact
  hostname override. Every subframe and subresource in a tab inherits the tab's top-site policy, like Brave Shields
  or uBO's trusted sites. Frame-level exceptions are not needed for v1.
* **Precedence**, highest first:
  1. allowlist (`extensions.allowlist`): no network, cosmetic or scriptlet blocking for that site; privacy headers
     and cookie rules still apply unless the user toggles them;
  2. `perSite[site]` toggles;
  3. global `extensions.enabled.*`;
  4. inside the engine: user custom filters, then list exceptions (`@@`), then list blocks (`$important` wins).
* **Effective policy cache.** Keep a `Map<tabId, EffectivePolicy>`. Recompute it on a top-level main_frame request,
  on `init.pre` with `isTopLevel`, and on `lifecycle.navigate`. Changing a toggle updates the cache and offers
  "reload to apply", because already-loaded subresources are not re-filtered.
* **Persistence.** Store settings in the SPA settings store, in IndexedDB. With account sync, the backend stores
  them in SQLite. They never travel through the proxy. Changes go to other GNOME windows over a `BroadcastChannel`
  and to the SW with `postMessage`.
* **UI.** A shield popover per tab showing counts by category, quick toggles, "trust this site" and "report breakage",
  plus a request logger driven by the hook data: URL, type, initiator, decision, matching filter.

### 12.7 Cookie manager

The source of truth for Scramjet is `controller.cookieJar`:

* **List:** `JSON.parse(controller.cookieJar.dump())`, grouped by registrable domain. Keys are
  `"<.domain>@<path>@<name>"`. Values: `{name, value, domain, path, expires?, hostOnly, secure, httpOnly, sameSite}`
  (core `shared/cookie.ts:6-18`).
* **Delete one:** `cookieJar.setCookies("<name>=; Path=<path>; Domain=<domain>; Max-Age=0", url)`. Omit `Domain` for
  host-only cookies. Then call `controller.persistCookies()` and
  `controller.propagateCookieSync([{url, cookie: header}])`, so loaded frames update.
* **Clear all:** `cookieJar.clear()`, then `persistCookies()`, then `propagateCookieSync([], {clear: true})`.
* **Persistence:** IndexedDB `__scramjet_controller`/`state`/`cookies`. Cross-window refresh goes over
  `BroadcastChannel("__scramjet_controller_channel")`.
* **Policies:** third-party blocking and session-only per site (§12.4 hooks). "Clear on exit" (`browser.cookies.clearOnExit`)
  means a full clear on SPA shutdown or next start. There is no reliable unload hook, so run it at startup.
* Proxied sites' `localStorage` and IndexedDB live in GNOME's real-origin storage under Scramjet's per-origin
  emulation. "Clear site data" (`privacy.clearSiteDataOnExit`) needs that layout researched in
  `client/dom/storage.ts`: **UNVERIFIED**.
* For UV, operate on IndexedDB `__op`/`cookies` as well (§12.5).

### 12.8 Privacy protection set (v1)

1. GPC and DNT headers (§12.4).
2. Referrer trimming.
3. Tracking-parameter stripping. Use a curated list (utm_*, fbclid, gclid, …) or the engine's `$removeparam`.
4. Third-party cookie policy.
5. WebRTC policy (disable, or relay-only).
6. Do not alter the User-Agent string by default: Scramjet forwards the real browser UA and it is consistent.
7. Fingerprinting hardening is opt-in only ("strict"), applied as `init.post` patches; expect site breakage.
8. Operator-level defense in depth: HolyWisp `block-host` (with `*.suffix`) or `allow-host` in `holywisp.conf` for
   malware or abuse domains server-wide. The Wisp layer sees only host:port, not URLs, and is no substitute for
   per-user lists.

### 12.9 Performance budget (targets, UNVERIFIED until benchmarked)

* Boot: deserialize the cached engine at about 10–50 ms. Never parse raw lists on the UI thread at every start.
* Per-request decision: about 0.1 ms on the host thread. A typical page makes 100–300 requests.
* Document start: one `getCosmeticsFilters` call plus a single `<style>` insertion. Cache hostname-specific CSS per
  hostname.
* Avoid large injected scripts. Scramjet rewrites them and stores a base64 copy (§3.6).

### 12.10 Skeleton (original GNOME code, consistent with the probe)

```ts
// frontend/src/extensions/scramjet/ShieldPlugin.ts — sketch; types elided
const { ManagedPlugin } = (globalThis as any).$scramjetController; // or import from "@mercuryworkshop/scramjet-controller"

export class ShieldPlugin extends ManagedPlugin {
  constructor(private rt: ShieldRuntime, private tabId: number) { super("gnome-shield", []); }

  install(frame: any) {
    super.install(frame);
    this.tap(frame.hooks.fetch.request, (ctx: any, props: any) => {
      const req = this.rt.describe(this.tabId, ctx.parsed, props.url, props.init.method); // sync
      const v = this.rt.decide(req);                                                       // sync
      if (v.block) { props.earlyResponse = this.rt.blockedResponse(req, v); return; }      // rewritten → safe
      if (v.redirectTo) { props.earlyResponse = new Response(null, { status: 307, headers: { location: v.redirectTo } }); return; }
      if (v.upstreamUrl) props.url = v.upstreamUrl;                                        // e.g. strip utm_*
      props.init.headers = this.rt.requestHeaders(req, props.init.headers);                // GPC/DNT/referrer/cookie
    });
    this.tap(frame.hooks.fetch.preresponse, (ctx: any, props: any) => {
      props.response.rawHeaders = this.rt.responseHeaders(this.tabId, ctx.parsed, props.response.rawHeaders); // Set-Cookie policy
    });
    this.tap(frame.hooks.init.pre, (ctx: any) => this.rt.onDocumentStart(this.tabId, ctx));  // top-level → policy refresh
    this.tap(frame.hooks.init.post, (ctx: any) => this.rt.injectDocumentStart(this.tabId, ctx)); // CSS, scriptlets, WebRTC
    this.tap(frame.fetchHandler.hooks.rewriter.html.pre, (ctx: any) => this.rt.htmlFilter(this.tabId, ctx));
  }
}

// Controller construction: wrap the transport so WebSockets are filtered too.
// const controller = new Controller({ serviceworker, transport: new FilteringTransport(libcurl, runtime) });
```

### 12.11 Testing plan

Write GNOME's own Playwright suite, following the approach of §10:

* App origin plus a separate test-site origin.
* HolyWisp with loopback allowed, in tests only. wisp-js is acceptable as a test double.
* `playwright-core@1.64.0` with the cached `chromium-1248`.
* A `window.gnomeTest` handle.
* Fixtures for each §12.4 row:
  * blocked vs. allowed requests, checking the origin's hit log;
  * cosmetic hiding at document_start;
  * stripped params and headers seen at the origin;
  * cookie-jar contents after `Set-Cookie`;
  * a WebSocket blocked at the transport;
  * allowlist on/off;
  * the UV fallback variant of each.

My prototype (§3.4, Appendix A; condensed host-page code in Appendix C) is a working template for the Scramjet half.

---

## 13. Should GNOME load user-installed Chrome MV3 extensions?

**Verdict: not in v1.** If ever, ship it as an explicitly experimental, admin-enabled, Chromium-only feature.
Cover the demand first with GNOME-native add-ons.

**Feasibility.** Sapphire shows that a Scramjet 2 host can run real extensions this way. GNOME cannot reuse it (no
license), so it would mean a **clean-room reimplementation** of roughly the same scope: about 9.5k lines of
TypeScript covering:

* the per-caller `chrome` façade and realm bridging;
* content-script injection with world emulation;
* MV3 service-worker emulation in pages;
* messaging and ports;
* storage;
* DNR and webRequest;
* action, popup, context-menu and command UIs;
* about 50 namespaces.

The upstream base is also unstable: Scramjet 2 is alpha (`2.0.67-alpha.2`), the controller is `0.0.x`, and builds
are pinned to exact versions.

**Hard limits found:**

* **Chromium-only** content scripts (native `window.chrome`, §5).
* **Single thread.** Extension backgrounds share the GNOME UI thread.
* Missing platform pieces:
  * real `proxy`, `privacy` and `contentSettings` effects;
  * `debugger`, `tabCapture` and `nativeMessaging`;
  * `identity.getAuthToken`;
  * `devtools`;
  * `onAuthRequired`;
  * request bodies;
  * WebSocket visibility.
* Synthetic navigation timing and windows.

**Security cost.** This is the deciding factor. Every installed extension would effectively run with
**GNOME-origin privileges** (§11): it can reach every site's cookies in the shared jar and act on every tab. If
anything escapes Scramjet's virtualization, it can also reach GNOME's own storage and same-origin `/api/*`. Content
scripts would be exposed to hostile pages. On a multi-user, self-hosted service, one bad extension compromises that
user's whole GNOME session.

**Recommended path:**

1. **v1.** Built-ins only (§12), plus user custom filters (uBO/ABP syntax, through the same engine), **user styles**
   (per-site CSS injected in `init.post`) and possibly **user scripts** with a small GM-style API implemented by
   GNOME. That covers dark mode, element hiding and simple page tweaks without a `chrome.*` emulation layer.
2. **Later, only if demanded.** An "experimental extensions" mode, off by default and gated by an operator setting
   with a per-user opt-in:
   * Chromium-only;
   * install from user-supplied `.crx`/`.zip` files only; no Chrome Web Store proxying through GNOME's server (this
     also avoids Web Store terms questions, **UNVERIFIED** legal analysis);
   * optionally restricted to an allowlist of vetted extension ids and hashes;
   * ideally the whole proxy runtime and extension runtime on a **separate sandbox origin** (for example
     `proxy.<gnome-host>`), embedded by the SPA and bridged with `postMessage`, so extension code cannot touch the
     account and admin origin;
   * design improvements over Sapphire: enforce `web_accessible_resources` and host permissions; run MV3 backgrounds
     in a dedicated `Worker` (closer to real SW semantics, off the UI thread); never trust stack-based caller
     attribution for privileged calls.

---

## 14. Open questions and UNVERIFIED items

* Real-world extension compatibility claimed by Sapphire's `real:*` suites. The CRX fixtures are absent and the
  harness was not run.
* Firefox end-to-end behavior of Sapphire content scripts. Code reading plus the `window.chrome` probe say they
  fail; not executed.
* UV: the ordering of `__uv$config.inject` scripts relative to UV's handler scripts; WebSocket filtering through a
  bare-mux transport wrapper; per-tab attribution in the SW.
* Whether a CSP header added in Scramjet `preresponse` survives Scramjet's response-header rewriting.
* Blocking (not just observing) JS cookie writes by wrapping `client.init.sendSetCookie` and
  `context.cookieJar.setCookies`.
* Scramjet's per-origin `localStorage`/IndexedDB emulation layout, needed for "clear site data".
* `@ghostery/adblocker` performance on the host thread with full lists on a Raspberry Pi-class client, and its
  scriptlet licensing.
* Edge cases of the `isIframe` classification for frames navigated by script.

---

## Appendix A: verification log

Environment: Linux (CachyOS 7.3.1), Node v26.13.0, npm 12.2.1. Playwright `playwright-core@1.64.0` installed with
`--ignore-scripts` in a fresh directory, driving the cached Chromium 156.0.8078.4 (`chromium-1248`) and Firefox 157.0
(`firefox-1555`).

| Check | Command or method | Result |
| --- | --- | --- |
| Sapphire license | `curl api.github.com/repos/x8rr/sapphire` and `/license`; repo scan; `npm view @x8r/sapphire --json` | `license: null`; 404; no LICENSE file; no license field |
| amethyst license | `curl api.github.com/repos/carbonicality/amethyst` and `/license`; `/contents/`; header of `amethyst.js` | `license: null`; 404; only 3 files; no license text |
| npm tarball = repo | `npm pack @x8r/sapphire@0.1.4` + `diff -rq` | `src/` and `package.json` identical |
| Controller API | `npm pack` of `scramjet-controller@0.0.13`/`0.0.14` and `scramjet@2.0.67-alpha.2`; read `src/`; grep `dist/` | §3. 0.0.13 and 0.0.14 have identical `src/`. Exact-version pins are `2.0.67-alpha.1` and `2.0.67-alpha.2` |
| Hook semantics | Own prototype (ephemeral session scratchpad `scripts/proto/{server.mjs,run.mjs,host/*,site/*}`; the host-page part is reproduced in Appendix C): Node `http` host and site servers plus wisp-js 0.5.3; host page loads `scramjet.js` and `controller.api.js`; `LibcurlTransport` (2.0.6) behind a logging wrapper; one `ManagedPlugin` tapping every hook; Playwright Chromium | §3.4, all 16 checks |
| Browser features | Own probe page in Chromium and Firefox: `typeof window.chrome`, `Error.captureStackTrace`, sourceURL in stacks | Chromium: chrome object with `loadTimes, csi, app`. Firefox: undefined. Both: captureStackTrace present and sourceURL honored |
| UV hook points | `npm pack @titaniumnetwork-dev/ultraviolet@3.2.10`; grep `dist/uv.sw.js` and `dist/uv.bundle.js`; read the fork's `src/uv.sw.js` | `emit("request"\|"beforemod"\|"response")`, `HookEvent.respondWith`, `config.construct`, `config.inject` (upstream only), cookie DB `__op` |
| Engine API | `npm pack @ghostery/adblocker@2.20.3`; read `dist/esm/engine/engine.d.ts` and `request.d.ts` | §12.3 |
| List license | EasyList header; archived licence page | GPL-3.0+ or CC BY-SA 3.0+, with attribution |

## Appendix B: Sapphire file index

| File | Purpose | Key lines |
| --- | --- | --- |
| `src/SapphirePlugin.ts` | Scramjet `ManagedPlugin`; taps 5 hooks | 19-72 |
| `src/frames.ts` | init hooks: frame records, extension contexts, SW shims, lifecycle/navigation, shortcuts, context menu | 347-442 |
| `src/content.ts` | content worlds, per-caller `chrome`, script/style injection, run_at phasing, executeScript | 88-152, 299-349, 425-452, 506-563 |
| `src/network.ts` | fetch hooks: extension resources, DNR, webRequest, block/redirect responses | 98-152, 190-333 |
| `src/dnr.ts` | DNR rule index and evaluator | 64-71, 216-429 |
| `src/sapphire.ts` | coordinator class (§4.3) | 82-1090 |
| `src/registry.ts` | contexts, extensions, tabs/frames model | 156-380 |
| `src/messaging.ts`, `src/events.ts`, `src/realm.ts` | messaging/ports; ChromeEvent; realm bridging | — |
| `src/storage.ts`, `src/db.ts`, `src/files.ts` | storage areas; IndexedDB `sapphire_extensions` v2; package files and preload | — |
| `src/crx.ts`, `src/extensions.ts` | CRX2/3 parsing, ids, unpack/store/load | 12-40; 140-229 |
| `src/urls.ts`, `src/urlScheme.ts`, `src/router/*` | alias origin; legacy `/~/sx/` scheme and SW router | — |
| `src/matchPatterns.ts`, `src/commands.ts`, `src/tabsModel.ts`, `src/browserData.ts`, `src/capture.ts` | helpers | — |
| `src/compat.ts`, `src/autoStub.ts` | per-extension interventions; missing-namespace auto-stubs | 12-15; 3-58 |
| `src/api/*.ts` | namespace implementations (§9); `api/index.ts` decides availability | `index.ts:53-211` |
| `test/harness/server.mjs`, `test/harness/web/*` | dev and test host (two origins, wisp, vite), shell | — |
| `test/run.mjs`, `test/suites.mjs`, `test/realworld.mjs` | Playwright runner, suites, exploratory runs | — |

## Appendix C: hook-probe host code (original, condensed, verified)

This is the host-page part of the probe that produced §3.4, trimmed to the essentials. It is GNOME's own code, not
Sapphire's. Requirements:

* The page loads `/scramjet/scramjet.js` and `/controller/controller.api.js` as classic scripts first, then this file
  as a module.
* `/sw.js` contains `importScripts("/controller/controller.sw.js")` and a `fetch` listener that calls
  `e.respondWith($scramjetController.route(e))` when `$scramjetController.shouldRoute(e)` is true.
* A Wisp server listens on `/wisp/`.
* Served as `/libcurl/index.mjs`, `@mercuryworkshop/libcurl-transport@2.0.6/dist/index.mjs` is a self-contained ESM
  (libcurl.js and its WASM are bundled), so no bundler is needed.

```js
import LibcurlTransport from "/libcurl/index.mjs";
const { Controller, ManagedPlugin } = globalThis.$scramjetController;
const log = [];

// The only place that sees WebSocket connects (probe check 3.4 #14).
const wrapTransport = (inner) => ({
  get ready() { return inner.ready; }, set ready(v) { inner.ready = v; },
  init: () => inner.init(),
  request: (remote, method, body, headers, signal) => (log.push(["http", String(remote)]), inner.request(remote, method, body, headers, signal)),
  connect: (url, ...rest) => (log.push(["ws", String(url)]), inner.connect(url, ...rest)),
});

class ProbePlugin extends ManagedPlugin {
  constructor(tabId) { super("gnome-probe", []); this.tabId = tabId; }
  install(frame) {
    super.install(frame);
    this.tap(frame.hooks.init.pre, (ctx) => { ctx.window.__marker = 1; });                 // visible to the first page script
    this.tap(frame.hooks.init.post, (ctx) => {                                             // document_start, Scramjet hooked
      const d = ctx.window.document, st = d.createElement("style");
      st.textContent = ".ad-banner{display:none!important}";
      (d.head ?? d.documentElement).appendChild(st);
      const send = ctx.client.init.sendSetCookie;                                          // document.cookie writes
      ctx.client.init.sendSetCookie = (c, o) => (log.push(["js-cookie", c.map((x) => x.cookie)]), send(c, o));
    });
    this.tap(frame.fetchHandler.hooks.rewriter.html.pre, (ctx) => { /* walk/edit ctx.handler.root (htmlparser2 DOM) */ });
    this.tap(frame.hooks.fetch.request, (ctx, props) => {
      const u = props.url;                                                                 // real target URL
      if (u.pathname === "/ad.js") props.earlyResponse = new Response("", { status: 403 }); // never hits the network
      if (u.searchParams.has("utm_source")) { const n = new URL(u.href); n.searchParams.delete("utm_source"); props.url = n; }
      props.init.headers = [...props.init.headers, ["sec-gpc", "1"]];
    });
    this.tap(frame.hooks.fetch.preresponse, (ctx, props) => {                              // before the jar stores cookies
      props.response.rawHeaders = props.response.rawHeaders.filter(([k]) => k.toLowerCase() !== "set-cookie" || !ctx.parsed.url.hostname.endsWith(".tracker.example"));
    });
  }
}

const reg = await navigator.serviceWorker.register("/sw.js");
await navigator.serviceWorker.ready;
if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
const transport = wrapTransport(new LibcurlTransport({ wisp: `ws://${location.host}/wisp/` }));
await transport.init();
const controller = new Controller({ serviceworker: navigator.serviceWorker.controller ?? reg.active, transport });
await controller.wait();
const frame = controller.createFrame(document.getElementById("tab"), { plugins: [new ProbePlugin(1)] });
frame.go("http://127.0.0.1:5400/page.html");                                              // frame.prefix = /~/sj/<cid>/<fid>/
```
