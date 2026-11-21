# Ultraviolet (UV) — research for GNOME's fallback proxy engine

Research date: 2026-11-09. Author: research engineer (automated study).

This document studies Ultraviolet (UV) as GNOME's **fallback** client-side proxy engine (Scramjet
is primary). It answers: what the NebulaServices fork actually is and whether it can run over our
Wisp backend (HolyWisp); which UV to integrate and why; exact files/paths/config keys; the service
worker; how to run UV alongside Scramjet; bare-mux setup; transport compatibility (the important
part); hook points for blocking/cookies/observation; and known issues + security notes.

Everything below was verified by reading source and by running UV 3.2.10 end-to-end against a real
HolyWisp build in headless Chromium **and** Firefox (Playwright). Claims I could not verify are
marked **UNVERIFIED**.

## TL;DR / recommendations

- **Integrate upstream `@titaniumnetwork-dev/ultraviolet@3.2.10`** (npm `latest`) on
  **`@mercuryworkshop/bare-mux@2.1.9`** (npm `latest`). This is the only UV line that speaks
  **bare-mux transports**, and therefore the only one that can reach GNOME's **Wisp/HolyWisp**
  backend. Verified working over HolyWisp.
- **Do NOT use the NebulaServices fork** (`@nebula-services/ultraviolet`). It is a ~2022-era UV
  (pre-bare-mux) hard-wired to the **TompHTTP Bare HTTP protocol** via `@nebula-services/bare-client`.
  It has **no Wisp and no bare-mux support**; it needs a Bare server, which GNOME does not run.
  Verified: pointing it at HolyWisp as its `bare` URL fails (`TypeError: Failed to fetch`).
- **Transport pinning is mandatory.** bare-mux 2.1.9 requires transports that implement the
  **`BareTransport`** interface. The current transport majors
  (`epoxy-transport@3.0.2`, `libcurl-transport@2.0.6`) switched to the **successor**
  `@mercuryworkshop/proxy-transports` interface and are **incompatible** with bare-mux 2.1.9
  (verified: `TypeError: headers is not iterable`). Pin **`@mercuryworkshop/epoxy-transport@2.1.29`**
  (dist-tag `legacy`) as the primary transport and **`@mercuryworkshop/libcurl-transport@1.5.2`**
  as the alternate. Both verified end-to-end over HolyWisp.
- **License: treat UV as AGPL-3.0.** Both the Nebula fork and upstream ship `"license":"MIT"` in
  `package.json` while the `LICENSE` file is the full **GNU AGPL-3.0** text. GitHub classifies
  upstream as AGPL-3.0. The file is the operative grant; a bare "MIT" string with no MIT text is not
  an MIT grant. See [License facts](#license-facts). This has compliance consequences for a
  self-hostable/network-served product and must go to whoever owns GNOME's licensing.
- Two UV-3.2.10 defects you must patch in GNOME's integration (both verified, both have a verified
  fix below): (1) **Firefox drops all request bodies** (POST/PUT/XHR) because bare-mux reads
  `Request.prototype.body`, which Firefox lacks; (2) treat the **proxy origin as fully
  attacker-controlled** — a proxied page can read UV's cookie IndexedDB (incl. HttpOnly values) and
  reach the same-origin bare-mux SharedWorker.

---

## 0. Versions, sources, and how this was tested

### Packages inspected (npm, exact versions)

| Package | Version | dist-tags | License field | LICENSE file |
| --- | --- | --- | --- | --- |
| `@nebula-services/ultraviolet` | `1.0.11.patch.7` (pkg.json); npm `latest` resolves to **`1.0.1-1.patch.7`** | latest=`1.0.1-1.patch.7` | `MIT` | **AGPL-3.0** |
| `@nebula-services/bare-client` | `1.1.2-beta.3-patch.1` | latest=`1.1.2-beta.3-patch.1` | `GPL-3.0` | GPL-3.0 |
| `@titaniumnetwork-dev/ultraviolet` | **`3.2.10`** | latest=`3.2.10` | `MIT` | **AGPL-3.0** |
| `@mercuryworkshop/bare-mux` | **`2.1.9`** | latest=`2.1.9`, legacy=`1.1.4` | (none in pkg.json) | MIT |
| `@mercuryworkshop/epoxy-transport` | `3.0.2` (latest), `2.1.29` (legacy), `2.1.28` | latest=`3.0.2`, legacy=`2.1.29` | `AGPL-3.0-only` | AGPL-3.0 |
| `@mercuryworkshop/libcurl-transport` | `2.0.6` (latest), `1.5.2` (highest 1.x) | latest=`2.0.6` (no legacy tag) | `AGPL-3.0-only` | AGPL-3.0 |
| `@mercuryworkshop/proxy-transports` | `1.0.2` | latest=`1.0.2` | `MIT` | MIT |

npm `latest` semver quirk: the Nebula fork's `package.json` version string `1.0.11.patch.7` is not
valid semver; npm parsed/stored it as `1.0.1-1.patch.7`, which is what `npm view … dist-tags`
reports as `latest`. Published 2024-01-01…2024-01-14 only.

### Git sources read

- Upstream UV: `github.com/titaniumnetwork-dev/Ultraviolet`, `main` @ `62afe61` (2025-08-21). The
  3.2.10 release = commit `92d9075` (2024-10-26); its npm tarball's embedded source maps match that
  tree exactly (verified: 31/31 source files byte-identical). All `src/…:line` citations below are
  that tree unless noted. Local copy: `…/scratchpad/scratch-uvr/uv-3.2.10-git/`.
- Nebula fork: `github.com/NebulaServices/Ultraviolet`, `main` @ `5c9d8ac` (2024-01-14). Local
  clone: `…/scratchpad/repos/ultraviolet`.
- `github.com/MercuryWorkshop/bare-mux` @ `dc9dc6e` (2026-04-26, **archived**; README: "this is
  deprecated … please use proxy-transports instead").
- `github.com/titaniumnetwork-dev/Ultraviolet-App` @ `a1762248` (2026-01-27) — reference deployment.
- `EpoxyTransport`, `CurlTransport`(→libcurl-transport), `NebulaServices/bare-client`, UV wiki.
- Reference-repo HolyWisp: `…/scratchpad/repos/holywisp`.

### Test harness (what "verified" means here)

Built a stand-in for GNOME's Rust gateway and ran the real UV dist against the real HolyWisp:

- **HolyWisp**: built from a copy of the reference source (CMake Release),
  `holywisp --port 16001 --allow-loopback --allow-direct-ip`. Binary:
  `…/scratchpad/build-uvr/holywisp-build/holywisp`.
- **Gateway** (`…/scratchpad/scripts-uvr/server.mjs`): Node static file server that forwards
  `/wisp/` WebSocket upgrades as raw TCP to HolyWisp (exactly the `/wisp/`→HolyWisp bridge GNOME
  plans). Also has an optional Wisp-packet sniffer.
- **Target site** (`…/scratchpad/scripts-uvr/target.mjs`): a local "remote website" (cookies,
  redirects, a WS echo endpoint, POST/PUT echo, SPA pushState, sloppy/modern JS, etc.).
- **Runner** (`…/scratchpad/scripts-uvr/run.mjs`): Playwright (`playwright-core@1.64.0` →
  chromium-1248 / firefox-1555, the cached builds) drives a harness page that registers the SW,
  sets a bare-mux transport, loads URLs in a UV iframe, and inspects results.
- Web root with UV/bare-mux/transport dist and a few SW variants: `…/scratchpad/scratch-uvr/www/`.

---

## (a) What the NebulaServices fork is, and whether it can run over Wisp

### What it is

`@nebula-services/ultraviolet` is a **fork of upstream Ultraviolet from mid-2023**, before UV moved
to bare-mux. Provenance (verified from git):

- The fork's `main` (`5c9d8ac`) descends from upstream commit **`56bf6fc`** ("expose bareClient in
  `__uv`", 2023-06-08) — i.e. the **UV 2.0.0-beta era** (TompHTTP Bare v1/v2 client, webpack build,
  `crypto-js`/`css-tree`/`esotope-hammerhead`/`mime-db` deps). The Nebula commits (Dec 2023–Jan
  2024) were themselves later merged into upstream's `nebula-main` branch; the fork HEAD tree is
  identical to upstream commit `5c9d8ac`.
- Fork-specific source changes vs that base are tiny (verified `git diff 56bf6fc..5c9d8ac -- src`):
  1. **AES codec added** — `Ultraviolet.codec.aes` (`src/rewrite/codecs.js`), key =
     `location.origin + navigator.userAgent` (weak; obfuscation only).
  2. **Bare "proxy" passthrough** — a `proxyIp`/`proxyPort` config forwarded to the Bare client as
     `X-Bare-Proxy-IP` / `X-Bare-Proxy-Port` request headers (`src/uv.sw.js`,
     `src/uv.handler.js`; implemented in `@nebula-services/bare-client`
     `src/BareClient.ts:295`). This is a Bare-server feature, not Wisp.
  3. Build switched webpack→esbuild; dep `@tomphttp/bare-client` → `@nebula-services/bare-client`.
- `@nebula-services/bare-client` is a fork of `@tomphttp/bare-client@1.1.2-beta.3` (GPL-3.0). It
  implements the **TompHTTP Bare client** (`ClientV2`/`ClientV1`), fetching a Bare **manifest** from
  the `bare` URL and issuing Bare HTTP requests (`BareClient.ts:127` `fetchManifest`,
  `:213` `getClient`).

So: **base ≈ UV 2.0.0-beta; Bare-protocol (v1/v2) only; no Wisp; no bare-mux.** It is ~2 years
stale (last publish 2024-01-14; GitHub repo not updated since 2024-03). Upstream's own README
pointer and the fork graph confirm it is a dead branch superseded by UV 3.x + bare-mux.

### Can it run over Wisp / HolyWisp?

**No.** The Bare protocol and Wisp are different wire protocols:

- The Nebula fork's `BareClient` fetches a **Bare manifest** (an HTTP `GET` to the `bare` URL
  returning JSON `{versions, language, …}`) and then speaks Bare HTTP (`/v1/`, `/v2/`).
- HolyWisp is a **Wisp** server: a WebSocket stream-multiplexer. It has no Bare endpoints. Non-WS
  `GET /` returns `holyWisp: a Wisp server. Connect with a WebSocket client.`; other non-WS paths
  return `426 Upgrade Required` (`repos/holywisp/src/server/conn.c:472-487`). There is no Bare
  manifest to fetch.
- **Verified**: Nebula fork with `bare: "http://127.0.0.1:16001/"` (HolyWisp) renders UV's error
  page with `TypeError: Failed to fetch` (manifest fetch rejected). GNOME has no Bare server, so the
  fork cannot work without standing one up (e.g. `@nebula-services/bare-server-node`), which the
  stack explicitly excludes.

### Recommendation

Integrate **`@titaniumnetwork-dev/ultraviolet@3.2.10`** (not the Nebula fork), because:

1. **It is the only UV that uses bare-mux**, and bare-mux has **Wisp transports** (epoxy, libcurl)
   that connect straight to HolyWisp. Verified working against HolyWisp.
2. It is **maintained** (upstream `main` has fixes through 2025; the Nebula fork is abandoned).
3. The Nebula fork would force GNOME to also run a Bare server — contradicting the "HolyWisp, no
   Bare server" architecture.

The AES codec and `proxyIp` features unique to the Nebula fork are not worth the Bare dependency; if
GNOME wants AES-style URL obfuscation it can supply its own `encodeUrl`/`decodeUrl` to UV 3.2.10's
config (the codec is pluggable — see (b)).

### License facts

- **NebulaServices/Ultraviolet**: `package.json` `"license":"MIT"`, but `LICENSE` is the full **GNU
  AGPL-3.0** text (verified byte-identical normalized AGPL in both the git repo and the npm
  tarball). GitHub API classifies the repo `agpl-3.0`. It is a GitHub fork of upstream.
- **titaniumnetwork-dev/Ultraviolet (3.2.10)**: identical situation — `package.json`
  `"license":"MIT"`, `LICENSE` file = AGPL-3.0 (verified). GitHub API: `license.spdx_id =
  "AGPL-3.0"`. The AGPL text was committed over the old MIT `LICENSE` in `4589818` (2022-12-05)
  while `package.json` stayed MIT — an unresolved 2-year-old inconsistency, not a deliberate dual
  license. There is no MIT copyright/permission text anywhere in the tree.
- **Transports/backend are copyleft too**: `epoxy-transport` & `libcurl-transport` = **AGPL-3.0**;
  `epoxy-tls` = AGPL-3.0; `wisp-server-node` = AGPL-3.0; `bare-mux` = MIT; `proxy-transports` = MIT;
  `libcurl.js` = LGPL-3.0; `@nebula-services/bare-client` = GPL-3.0.

**Operating guidance**: assume **AGPL-3.0** for UV and for the epoxy/libcurl transports. AGPL §13
network-use applies to a self-hostable web proxy. GNOME must be prepared to offer corresponding
source of UV + modifications to users of the hosted service, or get written clarification from
Titanium Network / Mercury Workshop. This is a compliance decision above this report; flag it early.

---

## (b) UV 3.2.10 — files, URL paths, config keys, service worker, coexistence, bare-mux

### Files to serve

UV's npm tarball ships `dist/` (`import { uvPath } from "@titaniumnetwork-dev/ultraviolet"` →
absolute path of that `dist/`). Serve the whole directory under a public prefix (reference uses
`/uv/`):

| Served path (example) | File | Role |
| --- | --- | --- |
| `/uv/uv.bundle.js` | `uv.bundle.js` (370 KB) | Core `Ultraviolet` class + deps; defines `self.Ultraviolet`. Load **first**. |
| `/uv/uv.config.js` | `uv.config.js` | Sets `self.__uv$config`. **You override this** (see below). |
| `/uv/uv.client.js` | `uv.client.js` (51 KB) | `UVClient` in-page runtime (DOM/JS/location hooks). |
| `/uv/uv.handler.js` | `uv.handler.js` | `__uvHook(window)` — installs all the client hooks in a proxied page. |
| `/uv/uv.sw.js` | `uv.sw.js` | Defines `UVServiceWorker` (the SW-side fetch handler). |
| `/uv/sw.js` | `sw.js` | **Stock** service worker entry (importScripts the above). Replaceable. |
| — | `*.js.map` | Source maps (optional; do not ship to production if you care about leaking source). |

bare-mux ships `dist/` too (`import { baremuxPath } from "@mercuryworkshop/bare-mux/node"`), served
under `/baremux/`:

| Served path | File | Role |
| --- | --- | --- |
| `/baremux/index.js` | UMD build | Exposes global **`BareMux`** (`BareMux.BareMuxConnection`, `BareMux.BareClient`). Include in the **page**. |
| `/baremux/index.mjs` | ESM build | Same, for bundlers. |
| `/baremux/worker.js` | SharedWorker script | The bare-mux worker. Passed by URL to `BareMuxConnection("/baremux/worker.js")`. **Must be served at a stable absolute path.** |

Transport (serve the dir; filename is `index.mjs` / `index.js`):

| Served path | Package (pin!) | Transport module to pass to `setTransport` |
| --- | --- | --- |
| `/epoxy/index.mjs` | `@mercuryworkshop/epoxy-transport@2.1.29` | `"/epoxy/index.mjs"` |
| `/libcurl/index.mjs` | `@mercuryworkshop/libcurl-transport@1.5.2` | `"/libcurl/index.mjs"` |

`epoxyPath` / `libcurlPath` node exports give the dirs for `express.static` (same as UV/bare-mux).
Epoxy dist is ~1.7 MB (bundled `epoxy-tls` wasm); libcurl dist ~2.1 MB (bundled `libcurl.js` wasm).

### Every config key (`__uv$config`)

From `uv.d.ts` and `src/rewrite/index.js:47-70`, `src/uv.sw.js:31-39`. UV 3.2.10 **dropped** the
`bare` key (that was Bare-era; the Wisp endpoint now lives in the transport options, not here).

```js
// uv.config.js (override the stock one; served at /uv/uv.config.js)
self.__uv$config = {
  prefix:    "/uv/service/",                 // URL namespace the SW intercepts. Default "/service/".
  encodeUrl: Ultraviolet.codec.xor.encode,   // fn(string)->string, must encodeURIComponent the result
  decodeUrl: Ultraviolet.codec.xor.decode,   // fn(string)->string, must decodeURIComponent the input
  handler:   "/uv/uv.handler.js",            // default "/uv.handler.js"
  client:    "/uv/uv.client.js",             // default "/uv.client.js" (or derived from bundle path)
  bundle:    "/uv/uv.bundle.js",             // default "/uv.bundle.js"
  config:    "/uv/uv.config.js",             // default "/uv.config.js"
  sw:        "/uv/uv.sw.js",                 // default "/uv.sw.js"
  // optional:
  inject: [                                  // UVInject[] — inject HTML into matching proxied pages
    { host: "(^|\\.)example\\.com$", injectTo: "head", html: "<script>…</script>" }
    // host: a string compiled with `new RegExp(host)` and tested against the proxied URL's host
    //       (src/uv.sw.js:251); injectTo: "head" | "body"
  ],
  // construct: (uv, "service"|"window") => {}   // advanced hook, called on every Ultraviolet instance
};
```

- Codecs available on `Ultraviolet.codec`: **`xor`** (default; XORs every odd char with 2 — trivial
  obfuscation, not encryption), **`plain`** (`encodeURIComponent`), **`base64`** (`btoa` of the
  encoded string), and **`none`** (identity; present in 3.2.10, `src/rewrite/codecs.js:5`). AES is
  **only** in the Nebula fork. You can set `encodeUrl`/`decodeUrl` to anything; both run in the SW
  and in the page, so keep them dependency-free.
- `prefix` may be `/` (run UV at the site root) but then it intercepts everything; a dedicated
  prefix like `/uv/service/` is cleaner and is what GNOME should use (keeps UV, Scramjet, API and
  `/wisp/` on disjoint namespaces).

### Service worker

Stock `dist/sw.js` (3.2.10, verified):

```js
importScripts("uv.bundle.js");
importScripts("uv.config.js");
importScripts(__uv$config.sw || "uv.sw.js");
const uv = new UVServiceWorker();          // constructor reads __uv$config, creates new Ultraviolet.BareClient()
async function handleRequest(event) {
  if (uv.route(event)) return await uv.fetch(event);   // uv.route = url starts with origin+prefix
  return await fetch(event.request);
}
self.addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
```

Key SW API (`src/uv.sw.js`):

- `new UVServiceWorker(config = __uv$config)` — `:31`. Creates `this.bareClient = new
  Ultraviolet.BareClient()` (a **bare-mux** `BareClient`, no args → talks to the bare-mux
  SharedWorker). `:38`.
- `uv.route({request})` → boolean, true iff `request.url.startsWith(location.origin +
  config.prefix)` (`:45`).
- `uv.fetch({request})` → `Promise<Response>` (`:54`). Decodes the real URL, builds a
  `RequestContext`, fetches via bare-mux, strips CSP/framing headers, rewrites the body by
  `request.destination`, stores Set-Cookie into IndexedDB, returns the rewritten `Response`. On
  error for `document`/`iframe` destinations it returns the HTML **error page** (status 500); other
  destinations get an empty 500.

GNOME should ship its **own** SW (register at the UV scope) so it can add the GNOME hooks (blocking,
logging) and the Firefox body fix — see (d) and (e). A verified reference SW is at
`…/scratchpad/scratch-uvr/www/uv/sw-gnome.js`.

### Running UV's SW alongside Scramjet — what works, what conflicts

Both were tested (Scramjet 1.1.0 + UV 3.2.10, Chromium). **Both approaches work**; pick based on how
much you want to share.

1. **Separate registrations / separate scopes (recommended).** Register UV's SW at `/uv/` and
   Scramjet's SW at its own scope (`/scram/`). Each SW only `route()`s its own prefix and passes
   everything else through. Verified: both proxies run in the same page, each in its own iframe,
   both reach HolyWisp; no cross-talk. Service-worker scopes are path-based, so **the two prefixes
   must not nest** (`/uv/service/` vs `/scram/service/` or Scramjet's default `/scramjet/` — all
   disjoint). This is the cleanest and matches how each project expects to be deployed.

2. **One combined SW (works, more coupling).** A single SW at scope `/` can `importScripts` both
   engines and dispatch by prefix:

   ```js
   importScripts("/uv/uv.bundle.js","/uv/uv.config.js","/uv/uv.sw.js");
   importScripts("/scram/scramjet.all.js");
   const uv = new UVServiceWorker();
   const { ScramjetServiceWorker } = $scramjetLoadWorker();
   const scramjet = new ScramjetServiceWorker();
   self.addEventListener("fetch", (e) => e.respondWith((async () => {
     if (uv.route(e)) return uv.fetch(e);
     await scramjet.loadConfig();
     if (scramjet.route(e)) return scramjet.fetch(e);
     return fetch(e.request);
   })()));
   ```

   Verified working for both engines. Downsides: a single scope means one engine's bugs can crash
   the SW for the other; both share one bare-mux SharedWorker/transport; ordering matters (check
   UV's prefix first). Prefer (1) unless you have a reason to share.

**What conflicts regardless of approach:**

- **Prefixes/namespaces must be globally unique** across UV (`/uv/service/`), Scramjet
  (`/scramjet/` or `/scram/service/`), the REST API, static assets, and `/wisp/`. A proxied URL that
  collides with another prefix will be grabbed by the wrong engine.
- **One bare-mux SharedWorker is shared per origin.** `BareMuxConnection("/baremux/worker.js")`
  always maps to the same named SharedWorker (`new SharedWorker(path, "bare-mux-worker")`,
  `connection.ts:92`). Whatever transport you `setTransport` last is what **both** UV and Scramjet
  use. If both engines must run at once with different transports you'd need two differently-named
  worker files; normally you want them to share one Wisp transport, so this is fine.
- Scramjet 1.1.0 and UV 3.2.10 both depend on `@mercuryworkshop/bare-mux@^2.1.x` — compatible. (Note
  Scramjet **2.x alpha** moved to `proxy-transports` and does **not** use bare-mux; if GNOME's
  Scramjet is 2.x, the two engines no longer share a transport layer and each needs its own — see
  (c).)

### bare-mux setup (the page side)

bare-mux 2.x runs the actual HTTP/WS transport inside a **SharedWorker** so every tab/SW shares one
Wisp connection. Minimum wiring (verified):

```html
<!-- in the controller page (the GNOME shell), before anything navigates the UV iframe -->
<script src="/baremux/index.js"></script>      <!-- global BareMux -->
<script src="/uv/uv.bundle.js"></script>
<script src="/uv/uv.config.js"></script>
<script>
  const conn = new BareMux.BareMuxConnection("/baremux/worker.js");  // SharedWorker path (absolute!)
  // set the transport BEFORE the SW handles its first proxied request, else a race drops requests:
  const wisp = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/wisp/";
  if ((await conn.getTransport()) !== "/epoxy/index.mjs")
    await conn.setTransport("/epoxy/index.mjs", [{ wisp }]);          // epoxy wants { wisp }
  // libcurl wants { websocket }:  setTransport("/libcurl/index.mjs", [{ websocket: wisp }])
  // then point the iframe at the proxied URL:
  frame.src = __uv$config.prefix + __uv$config.encodeUrl("https://example.com/");
</script>
```

`BareMuxConnection` API (`bare-mux/src/client.ts:40`):

- `new BareMuxConnection(workerPath?: string | Promise<MessagePort> | MessagePort)`.
- `setTransport(path: string, options: any[], transferables?: Transferable[]): Promise<void>` —
  `path` is the **module URL** of the transport; `options` is the **array of constructor args**
  (first element usually `{ wisp }` or `{ websocket }`). The SharedWorker dynamically `import()`s
  `path` and does `new Transport(...options)`.
- `setManualTransport(functionBody, options, transferables)` / `setRemoteTransport(transport, name)`
  — advanced (a transport that runs in the window, relayed over a MessagePort).
- `getTransport(): Promise<string>` — the current transport name (the path you set), `""` if none.
- `getInnerPort()` — the MessagePort (UV's worker hook uses this to hand bare-mux to web workers:
  `__uv$type:"baremuxinit"`, `src/client/worker.js:44`).

**Deployment note (critical):** keep the UV page in an **iframe of a controller page** that holds
the `BareMuxConnection`. bare-mux's SharedWorker port can go away and must be re-requested from a
window; if the only context is the SW there is no window to ask and transport fetch fails (you will
see `bare-mux: failed to get a bare-mux SharedWorker MessagePort within 1s, retrying`). This matches
Ultraviolet-App's and the wiki's guidance and GNOME's "in-browser browser" (iframe) model.

---

## (c) Transport compatibility — the exact working combination

### The interface split (root cause)

bare-mux 2.x and the newest transports speak **different interfaces**:

- **bare-mux 2.1.9** expects a **`BareTransport`** (`bare-mux/src/baretypes.ts:16`):
  - `request(remote, method, body, headers, signal)` where **`headers: BareHeaders = Record<string,
    string | string[]>`** (an **object**),
  - `connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror)` with
    `requestHeaders` an **object**, `onopen(protocol: string)`.
- **`epoxy-transport@3.0.2` / `libcurl-transport@2.0.6`** implement
  **`@mercuryworkshop/proxy-transports` `ProxyTransport`** (`proxy-transports/dist/types.d.ts`):
  - `request(remote, method, body, headers, signal)` where **`headers: RawHeaders = [string,
    string][]`** (a **tuple array**),
  - `connect(…, onopen: (protocol, extensions) => void, …)`.
  Their source does `for (const [k,v] of headers)` (`epoxy-transport@3.0.2 src/main.ts:83`).

So if you hand a 3.x transport to bare-mux 2.1.9, bare-mux passes a headers **object** into code
that iterates it as tuples → **`TypeError: headers is not iterable`** (fetch) and **`requestHeaders
is not iterable`** (websocket). Verified in-browser for both epoxy 3.0.2 and libcurl 2.0.6.

### Verified compatibility matrix (UV 3.2.10 + bare-mux 2.1.9, over HolyWisp)

| Transport | Interface | fetch (HTTP) | WebSocket | POST body | External HTTPS | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **`epoxy-transport@2.1.29`** (legacy) | BareTransport | PASS | PASS | PASS (Chromium) | PASS | **Use — primary** |
| **`libcurl-transport@1.5.2`** (1.x) | BareTransport | PASS | PASS | PASS (Chromium) | PASS | **Use — alternate** |
| `epoxy-transport@2.1.28` | BareTransport | PASS | PASS | — | — | works (what UV-App pins) |
| `epoxy-transport@3.0.2` (latest) | ProxyTransport | **FAIL** `headers is not iterable` | FAIL | — | — | needs adapter |
| `libcurl-transport@2.0.6` (latest) | ProxyTransport | **FAIL** `headers is not iterable` | FAIL | — | — | needs adapter |
| `epoxy@3.0.2` via adapter shim | adapted→BareTransport | PASS | PASS | PASS (Chromium) | PASS | works with shim |
| `libcurl@2.0.6` via adapter shim | adapted→BareTransport | PASS | PASS | PASS (Chromium) | PASS | works with shim |

So the question "does bare-mux 2.1.9 work with epoxy 3.0.2 / libcurl 2.0.6?" → **No, not directly.**
It works with **older majors**: **epoxy 2.1.29** (dist-tag `legacy`) and **libcurl 1.5.2** (highest
1.x). This matches Ultraviolet-App, which pins `@mercuryworkshop/epoxy-transport": "2.1.28"` with
`bare-mux": "^2.1.8"`.

### Transport options (constructor args, verified)

- **epoxy 2.1.29** (`src/main.ts`): `new EpoxyTransport({ wisp: "wss://…/wisp/", wisp_v2?,
  udp_extension_required?, title_case_headers?, ws_title_case_headers?, wisp_ws_protocols?,
  redirect_limit?, header_limit?, buffer_size? })`. GNOME: `setTransport("/epoxy/index.mjs",
  [{ wisp }])`.
- **libcurl 1.5.2** (`src/main.ts`): `new LibcurlClient({ wisp | websocket: "wss://…/wisp/",
  transport?: "wisp"|"wsproxy", proxy?, connections?: [hard, cache, perHost] })`. The URL **must end
  with `/`** and be `ws://`/`wss://`. GNOME: `setTransport("/libcurl/index.mjs", [{ websocket: wisp
  }])`.

### If GNOME wants the newest transports anyway (adapter)

A ~40-line adapter wraps a `ProxyTransport` (3.x) as a `BareTransport` by converting headers
object↔tuple-array in `request`/`connect`. Verified end-to-end for epoxy 3.0.2 and libcurl 2.0.6
(fetch + WS + POST). Reference: `…/scratchpad/scratch-uvr/www/adapter/proxy-transport-for-baremux.mjs`.
**Not recommended** for the fallback engine — pinning the legacy transports is simpler and is the
supported path. Keep the adapter in your back pocket only if a newer transport fixes a bug you hit.

### Transport choice: epoxy vs libcurl

Pick **epoxy 2.1.29 as primary**:

- epoxy's `init()` **awaits** the wasm (`await initEpoxy()`), so the first request is safe.
- libcurl 1.5.2's `init()` can throw **`wasm not loaded yet, please call libcurl.load_wasm first`**
  on the very first use, especially in Firefox (verified). You must retry `init()` or gate the
  first navigation. Usable, but more fragile → make it the alternate.
- Both did TLS to external HTTPS and WS fine over HolyWisp. epoxy does TLS **inside** the browser
  (epoxy-tls/rustls over Wisp **TCP** streams); libcurl does TLS inside wasm curl over Wisp. Both
  only need HolyWisp to relay raw TCP — which it does (verified via Wisp packet sniff: `CONNECT` +
  `DATA` frames carrying the TLS ClientHello).
- epoxy-tls pinned by `epoxy-transport@2.1.29` = `@mercuryworkshop/epoxy-tls@2.1.20-1`;
  `epoxy-transport@2.1.28` pins `epoxy-tls@2.1.18-1`. Both verified.

HolyWisp requirements for either transport: **Wisp v1 and v2** both work (epoxy sent wisp-v1 by
default in testing; HolyWisp logged `websocket wisp-v1`). TCP relay must be allowed (on by default).
For GNOME's localhost deployment where the destination is public, the default HolyWisp egress policy
(public unicast only) is correct; only relax `allow-*` for testing.

---

## (d) Hooks: blocking/modification, cookies, URL/title observation, error detection

### Intercepting in the SW before `uv.fetch`

The cheapest block is in your own SW `fetch` listener, before calling `uv.fetch`, by decoding the
target URL yourself:

```js
const prefixFull = location.origin + __uv$config.prefix;
function decode(reqUrl) { return __uv$config.decodeUrl(reqUrl.slice(prefixFull.length)); }
self.addEventListener("fetch", (event) => event.respondWith((async () => {
  if (uv.route(event)) {
    const real = decode(event.request.url);                 // e.g. "https://ads.example/x"
    if (isBlocked(real))
      return new Response("<h1>Blocked by GNOME</h1>", { status: 403, headers: { "content-type": "text/html" } });
    return uv.fetch(event);
  }
  return fetch(event.request);
})()));
```

Verified: a `/blocked-page` navigation returned the GNOME 403 HTML and UV never fetched it. This is
the right layer for GNOME's blocklist/allowlist because it is engine-agnostic and runs before any
rewriting/IDB work.

### `UVServiceWorker` events (`uv.on(...)`)

`UVServiceWorker extends Ultraviolet.EventEmitter`. It emits (all carry a `HookEvent`; call
`event.respondWith(resp)` to short-circuit, read `event.data`):

| Event | When | `event.data` shape | Use |
| --- | --- | --- | --- |
| `request` | after decoding URL + building request, **before** bare-mux fetch (`src/uv.sw.js:123`) | `RequestContext`: `{ url:URL (real target), method, headers (mutable object), body, request (the raw Request, has `.destination`), address, credentials, mode, cache, redirect }` | block/allow (`event.respondWith`), add/rewrite **outgoing** headers |
| `beforemod` | after fetch, **before** CSP-strip/rewrite (`:144`) | `ResponseContext`: `{ url, status, statusText, headers (raw upstream, mutable), body, raw, getHeader(k) }` | inspect/replace raw upstream response |
| `response` | after rewriting, **before** the `Response` is constructed (`:310`) | `ResponseContext` (headers now rewritten) | add/rewrite **response** headers; last chance to replace |

Verified all three fire with correct data; verified modifying `event.data.headers["x-…"]` in
`request`/`response` reaches the wire / the client, and that `event.respondWith(new Response(...))`
in `request` replaces a subresource (used it to swap `/ad.js` for a stub). `event.data.request.destination`
tells you `"document"|"iframe"|"script"|"style"|"worker"|"image"|…` for category rules.

There is **no** `uv.on("response-body")`-style streaming hook; to transform bodies, replace in
`response`/`beforemod` or use `config.inject` for HTML insertion (`src/uv.sw.js:243` tests
`new RegExp(inject.host)` against the proxied host and splices `inject.html` at `<head>`/`<body>`).
Verified `inject` ran on the matching host.

### `hook.js` / `HookEvent`

`src/client/hook.js` (and a second copy inside `uv.sw.js`) define `HookEvent`:

```
class HookEvent { data; target; that; get intercepted; get returnValue; respondWith(input) }
```

This is the event object for **both** SW events (above) and the hundreds of in-page client hooks in
`uv.handler.js` (e.g. `client.document.on("setCookie", …)`, `client.element.on("setAttribute", …)`,
`client.fetch.on("request", …)`). In a proxied page you can add your own client hooks after UV
installs its own, but the stable, supported integration surface for GNOME is the **SW events** and
`config` above, not the internal client hooks (they are not a documented API and shift between
releases).

### Cookie storage (IndexedDB) — for a cookie manager

UV keeps a **synthetic cookie jar** in IndexedDB (it does not use real browser cookies for proxied
sites). Verified live schema:

- **Database**: `__op`, **version 1** (`src/rewrite/cookie.js:22`). (`openDB("__op", 1, …)`.)
- **Object store**: `cookies`, **keyPath `id`**, with one index **`path`** on the `path` field.
- **`id` format**: `` `${domain}@${path}@${name}` `` (`cookie.js:85`). `domain` is normalized to
  start with a dot (host-only cookies are stored as `.<host>`), `path` defaults `/`.
- **Row shape** (from `set-cookie-parser` + UV): `{ name, value, domain, path, expires?, maxAge?,
  secure?, httpOnly?, sameSite?, set: Date, id }`. Example verified rows:
  `{"name":"srvCookie","value":"fromServer","path":"/","domain":".localhost","id":".localhost@/@srvCookie","set":"…"}`
  and an `httpOnly:true` row for `secretCookie`.
- **Expiry** is enforced on read (`getCookies`, `cookie.js:47`): rows past `set + maxAge*1000` or
  past `expires` are deleted and filtered out.
- **Per-site IndexedDB** (the proxied page's own IDB, not the cookie jar) is namespaced
  `` `${origin}@${name}` `` (`uv.handler.js:425`), and the cookie DB `__op` is explicitly exempted
  from that rename. `localStorage`/`sessionStorage` keys are namespaced `__uv$<origin>@<key>`.

For a GNOME cookie manager, read/write `__op`→`cookies` directly (keyed by `id`). A write from the
SW posts `{ msg:"updateCookies", url }` to all clients (`uv.sw.js:190`) — UV's own client code does
**not** consume it (verified: no `updateCookies` listener in the client), so GNOME can listen for it
to refresh a cookie UI, or just re-read the store.

Cookie matching quirks to know (verified by unit-testing `uv.cookie.validateCookie`,
`cookie.js:7`): the "secure cookie not sent over http" and "path must match" checks are **skipped**
for dotted-domain cookies (the `domain.startsWith(".")` branch returns early), and suffix matching
uses `hostname.endsWith(domain.slice(1))` **without a dot boundary** — so a `.example.com` cookie
matches `badexample.com`. These are UV cookie-scoping bugs, not GNOME's, but a cookie manager built
on this store will reflect them.

### Observing a UV frame's URL / title from the parent (GNOME shell)

The shell and the UV iframe are **same-origin** (both on the proxy origin), so the shell can read
the frame. Verified ways to get the **real** (decoded) URL:

- `frame.contentWindow.__uv.location.href` → decoded real URL (e.g. `https://example.com/`). `__uv`
  is the per-frame `Ultraviolet` instance (non-enumerable own prop of the frame window).
- `frame.contentWindow.__uv$location.href` → same (the rewritten `location` alias).
- Or decode the raw location yourself: `__uv$config.decodeUrl(raw.slice((origin+prefix).length))`
  where `raw = ` the native `frame.contentWindow.location.href` (which is the encoded
  `…/uv/service/<encoded>` URL). Verified both give `https://example.com/`.
- Title: `frame.contentDocument.title` (plain). SPA navigations update it — verified a `pushState`
  SPA changed both `__uv.location.href` to `/spa/route-2?y=2` and the title to "SPA Changed".
- `frame.contentDocument.URL` / `document.location.href` inside the frame are **rewritten by UV** to
  return the real URL to page scripts (hooked), but the **native** descriptors (e.g.
  `Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype,'href').get` called from the shell
  realm) return the **encoded** `/uv/service/…` URL — verified. So: use `__uv.location` / decode,
  not the shell-realm native getters.

There is **no built-in "locationchange" event** for the parent. Options: poll
`contentWindow.__uv.location.href`, listen to the iframe `load` event (full navigations), and/or a
`MutationObserver` on `<title>` for SPA title changes. (UV's internal `client.location` emits
`hashchange` inside the frame but nothing to the parent.)

### Error-page behavior (failure detection)

`uv.fetch` catches transport/parse errors and, **only** for `request.destination` of `document` or
`iframe`, returns an HTML error page via `renderError` (`src/uv.sw.js:497`), status **500**,
`content-type: text/html`. Other destinations (script/style/image/fetch) get `new
Response(undefined, { status: 500 })` (empty). The error page contains these IDs (stable detection
hooks):

- `#errorTitle` ("Error processing your request"), `#errorMessage` ("Internal Server Error"),
- `#errorTrace` (a `<textarea>` with the stringified error — e.g. `TypeError: Request failed with
  error code 35: SSL connect error`, or `Error: there are no bare clients`),
- `#fetchedURL` (the URL it tried), `#uvHostname`, `#uvVersion` (`"3.2.10"`), `#uvBuild`
  (`"92d9075"`), `#reload` (button). `<title>` is `"Error"`.

GNOME can detect a failed navigation by checking, after the iframe `load`:
`frame.contentDocument.getElementById("uvVersion")` **and** `#errorTrace` exist (or `title ===
"Error"` plus one of those IDs). Verified: a bad TLS host, a DNS-failure host, and "no transport
set" all produced this page with a distinguishing `#errorTrace`. "**there are no bare clients**" in
`#errorTrace` specifically means no bare-mux transport was set — surface that as "proxy backend not
ready" rather than a site error.

Note the 3.2.10 error page sets `* { background-color: white }` and does **not** show the Bare
server link the old Nebula page had (that whole hostname-specific template is gone post-bare-mux).

---

## (e) Known issues on modern sites; security notes

### Correctness / compatibility issues (verified unless noted)

1. **Firefox drops all request bodies (POST/PUT/PATCH, fetch & XHR).** bare-mux 2.x
   `BareClient.fetch` builds `new Request(url, init)` and forwards **`req.body`** (a ReadableStream)
   to the SharedWorker (`bare-mux/src/client.ts:170,194`). **Firefox has no
   `Request.prototype.body`** (verified: `"body" in Request.prototype === false` in firefox-1555),
   so the body is `undefined` and the server receives **0 bytes**. Chromium works. Verified:
   POST/PUT/XHR bodies arrived length-0 on Firefox with the stock SW. **Fix (verified
   cross-browser):** either (a) polyfill `Request.prototype.body` in the SW to stream
   `this.clone().arrayBuffer()`, or (b) replace `BareClient.fetch` in your SW with a version that
   buffers `init.body` into an ArrayBuffer and transfers it. Drop-in reference SW that does (b):
   `…/scratchpad/scratch-uvr/www/uv/sw-gnome.js` (POST/PUT then worked on Firefox and Chromium, and
   redirects still follow). GNOME must ship one of these since Firefox is a target browser.
2. **bare-mux SharedWorker port race / requires a window.** The `failed to get a bare-mux
   SharedWorker MessagePort within 1s, retrying` warning is normal on cold start and recovers, but
   only if a **window** (controller page) is alive to answer the SW's port request. Keep UV in an
   iframe of a page holding the `BareMuxConnection`; set the transport **before** the first proxied
   request (else early subresources fail and you get partial renders).
3. **Module-mode JS rewriting leaks on sloppy-mode-only scripts.** UV parses scripts with meriyah
   `{ module: true }` (`src/rewrite/js.js:16`). Scripts that are only valid in sloppy mode (bare
   `with(){}`, duplicate params, `arguments` as a name, HTML-comment `<!--` tokens) **fail to parse,
   and UV returns them unrewritten** (the `recast` catch returns the input, `js.js:75`). Verified:
   `with(o){ location }` left `location` unrewritten and `location.href` then resolved to the
   **encoded** `…/uv/service/…` URL — both a correctness bug and a URL leak to the page. Modern
   bundlers emit strict/module code so this is rare, but ad/analytics snippets and legacy inline
   scripts can hit it.
4. **WebSocket wrapper is a best-effort fake.** UV wraps `WebSocket` with a synthetic `EventTarget`
   (`src/client/requests/websocket.js`) proxying `isTrusted`, `binaryType`, `readyState`, etc.
   Verified working (open/echo/close over HolyWisp via epoxy & libcurl), but it is a reimplementation
   — some libraries that inspect `WebSocket` internals or expect exact `CloseEvent`/`extensions`
   semantics may misbehave. (A post-3.2.10 upstream commit `d415ce1` further fixes `isTrusted` and
   `on*`; not in 3.2.10.)
5. **srcset/CSS rewriter was reverted right before 3.2.10.** PR #148 (regex srcset + extra CSS
   rewriting) was **reverted** in `6e36ac9`, one commit before the 3.2.10 tag, so 3.2.10 ships the
   simpler `split(",")` srcset rewriter and no `getTextContent` CSS rewriting. Expect occasional
   responsive-image (`srcset`/`imagesrcset`) and dynamic-CSS edge cases. Upstream `main` (unreleased)
   also adds `import.meta.url` rewriting (#178) that 3.2.10 lacks → ESM apps using `import.meta.url`
   for asset URLs can break.
6. **No nested service workers; SharedWorker not isolated.** UV deletes
   `navigator.serviceWorker` inside proxied pages (`uv.handler.js:830`), so sites that *require* a
   service worker (some PWAs, push, offline) won't get one (verified `navigator.serviceWorker ===
   undefined` in the frame). Proxied `SharedWorker`/`Worker` get bare-mux handed in but are only
   partially rewritten.
7. **Rewriter cost.** JS rewrite throughput ~**4.5–5 MB/s** (verified: 370 KB bundle ≈ 79 ms, 51 KB
   ≈ 17 ms in chromium-1248), output ~3–6% larger. Document responses are rewritten synchronously in
   the SW; very large inline scripts add latency. Acceptable for a fallback engine but noticeable on
   script-heavy sites.
8. **General UV 3.x modern-site caveats (UNVERIFIED specifics, from upstream issue tracker/README):**
   Google login / captcha flows, YouTube, Discord need a non-datacenter egress IP and are sensitive
   to rewriting bugs; some sites with strict Trusted Types or aggressive anti-proxy JS detect UV.
   These are the standard reasons UV is being superseded by Scramjet upstream (the UV README/repo
   describe it as "Succeeded by Scramjet").

### Security notes

Treat the **proxy origin as fully attacker-controlled** once any site is proxied. All proxied pages
and the GNOME shell share one origin, so same-origin isolation does not protect the shell from a
hostile proxied site. Verified consequences:

- **The synthetic cookie jar is readable by any proxied page, including HttpOnly values.** UV's
  `httpOnly` flag only hides cookies from the rewritten `document.cookie` getter
  (`validateCookie(..., js=true)`); it does **not** protect the IndexedDB store. A proxied page's own
  JS can `indexedDB.open("__op")` and read every cookie for every proxied site (verified: read
  `secretCookie=httpOnlyValue (httpOnly)` and all others from a proxied page). So UV's cookie
  isolation between proxied sites is **advisory, not enforced**. Mitigation: isolate per session
  (separate origin / partitioned storage per user or per browsing session), and never store
  first-party GNOME secrets on the proxy origin.
- **The bare-mux SharedWorker is reachable from any same-origin script.** Because the worker is
  named and origin-scoped, a proxied page can open the same SharedWorker and issue `get`/`set`
  messages, i.e. observe or replace the active transport (and thus the Wisp endpoint). Verified a
  proxied page changed the transport the shell then saw. Mitigation: per-session origin isolation as
  above; do not rely on the transport being fixed; consider a GNOME-specific worker name/path per
  session and validate transport changes server-side (HolyWisp already gates egress).
- **UV strips CSP and framing headers** from proxied responses (`cspHeaders` list,
  `src/uv.sw.js:10-27`: `content-security-policy`, `x-frame-options`, COOP/COEP/CORP, HSTS,
  `x-content-type-options`, etc.). This is required for the proxy to work but means proxied sites run
  with **no CSP** — XSS in a proxied page is unconstrained within the proxy origin. Combined with the
  shared-origin points above, a malicious or XSS'd proxied page can pivot to other proxied sites'
  data.
- **Anti-frame-escape holds for the window tree but not same-origin DOM.** UV's `__uv$parent` /
  `__uv$top` return the frame's own window when a proxied script tries to reach a non-proxied
  ancestor (verified `parent`/`top` emulation, `uv.handler.js:1360,1383`). But because the shell and
  frame are same-origin, the shell *can* read the frame's DOM (that's how GNOME observes the URL/
  title) — and a proxied page can read the shell's DOM too (verified `parent.document.title` from the
  frame). Do not put anything sensitive in the shell DOM when a frame is proxied.
- **URL codec is obfuscation, not security.** Default `xor` is reversible by anyone; `base64`/`plain`
  likewise. Don't treat the encoded URL as hiding anything. (Nebula's AES uses key = `origin+UA`,
  also weak and decryptable by the page.)
- **Cross-origin isolation (COOP/COEP) is fine.** UV runs correctly under
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (verified:
  it re-adds `Cross-Origin-Embedder-Policy: require-corp` to proxied responses when
  `crossOriginIsolated`, `uv.sw.js:305`). Needed if GNOME wants `SharedArrayBuffer`/epoxy threads.
- **Source maps**: UV dist ships `*.map`; don't serve them in production if you don't want to publish
  UV's (AGPL) source map inline — though under AGPL you may need to offer source anyway.

### Integration checklist for GNOME (fallback engine)

1. Vendor `@titaniumnetwork-dev/ultraviolet@3.2.10` dist → serve at `/uv/`.
2. Vendor `@mercuryworkshop/bare-mux@2.1.9` dist → serve at `/baremux/` (stable
   `/baremux/worker.js`).
3. Pin `@mercuryworkshop/epoxy-transport@2.1.29` (→`/epoxy/`) primary and
   `@mercuryworkshop/libcurl-transport@1.5.2` (→`/libcurl/`) alternate. **Do not** use epoxy 3.x /
   libcurl 2.x with bare-mux 2.1.9 without the adapter.
4. Ship a custom UV `sw.js` that (a) applies the **Firefox request-body fix**, (b) gates GNOME's
   blocklist before `uv.fetch`, (c) optionally logs via the `request`/`response` events. Reference:
   `…/scratchpad/scratch-uvr/www/uv/sw-gnome.js`.
5. Override `uv.config.js`: `prefix: "/uv/service/"`, keep `xor` (or supply GNOME codecs), set
   `inject` if you need per-site script injection.
6. Page wiring: controller page holds `BareMuxConnection("/baremux/worker.js")`, calls
   `setTransport("/epoxy/index.mjs", [{ wisp: "wss://<host>/wisp/" }])` **before** navigating the UV
   iframe; UV runs in an iframe of that page.
7. Keep UV's prefix disjoint from Scramjet's and from `/wisp/`, `/baremux/`, `/epoxy/`, `/libcurl/`,
   and the REST API. Prefer **separate SW registrations/scopes** for UV and Scramjet.
8. Per-session origin isolation (treat the proxy origin as hostile); don't co-locate GNOME secrets.
9. Resolve the **AGPL-3.0** question for UV and the epoxy/libcurl transports before shipping a hosted
   service.

---

## Appendix: key source citations (UV 3.2.10 tree = upstream commit `92d9075`)

- Config keys / defaults: `uv.d.ts`; `src/rewrite/index.js:47-70`; stock config `dist/uv.config.js`.
- SW class, `route`, `fetch`, events, CSP strip, inject, error page: `src/uv.sw.js`
  (`:30` ctor, `:45` route, `:54` fetch, `:123` `emit('request')`, `:144` `beforemod`, `:180`
  set-cookie→IDB, `:243` inject, `:310` `response`, `:497` `renderError`).
- Stock entry SW: `dist/sw.js`.
- Codecs: `src/rewrite/codecs.js` (`xor`, `plain`, `base64`, `none`).
- Cookie jar schema: `src/rewrite/cookie.js` (`:22` db `__op` v1, `:85` id format, `:7`
  `validateCookie`).
- Client hooks / `__uvHook`, bare-mux handoff, per-site IDB rename, `navigator.serviceWorker`
  delete, `__uv.location`/`$get`/`$wrap`: `src/uv.handler.js` (`:36`, `:425`, `:830`, `:1275`).
- WebSocket wrapper: `src/client/requests/websocket.js`.
- bare-mux `BareMuxConnection`/`BareClient`: `bare-mux/src/client.ts`; `BareTransport` interface
  `bare-mux/src/baretypes.ts:16`; worker `bare-mux/src/worker.ts`; SharedWorker plumbing
  `bare-mux/src/connection.ts`.
- proxy-transports `ProxyTransport`/`RawHeaders`: `proxy-transports/dist/types.d.ts`.
- Transport sources: `epoxy-transport@2.1.29 src/main.ts`, `@3.0.2 src/main.ts`;
  `libcurl-transport@1.5.2`(legacy-bare-mux) & `@2.0.6 src/main.ts`.
- Reference deployment: `Ultraviolet-App` `src/index.js`, `public/index.js`,
  `public/uv/uv.config.js`, `package.json` (pins epoxy 2.1.28 + bare-mux ^2.1.8).
- Harness + reproducible artifacts:
  `…/scratchpad/scripts-uvr/{server,target,run,direct,coexist}.mjs`,
  `…/scratchpad/scratch-uvr/www/` (UV config, `sw-gnome.js`, adapter, harness pages),
  HolyWisp build at `…/scratchpad/build-uvr/holywisp-build/holywisp`.
