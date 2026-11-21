# GNOME engine protocol (app ⇄ engine host)

> Status: **final v1** (2026-11-11, Wave B step 1). Reconciled with the two-origin spike
> (`docs/research/spike-engine-host.md`, re-verified twice in session 4) and its adversarial isolation review, then
> revised by the contract-fix step after an independent security review and a completeness review (§8).
> **The TypeScript is the source of truth**: `frontend/src/shared/engine-protocol.ts` (messages, limits, rate limits,
> validators, handshake rules). This document explains it. Where they disagree, the code wins and this document is
> fixed. `PROTOCOL_VERSION` is `1`.
>
> Evidence labels: **[proven]** = reproduced in both session-4 spike runs in Chromium 156 and Firefox 157 (the spike
> document's §3 rows and §9); **[unproven]** = designed here and not exercised by the spike: Wave B must test it
> (`docs/WAVE-B.md` names the tests) and must drop or change it if it does not hold. The spike's suites used a stub of
> the `/wisp/` gateway that copies gnome-server's ticket parser; the session-4 integration step repeated the ticket,
> probe and CSP checks against the real gnome-server (spike §12). The adversarial review is spike §11.
>
> **Wave B step 2** (2026-11-12, corrected by its integration step 2026-11-18, §8.4): a marker that names an e2e row
> (`suite row`, e.g. `host-attack borrow-natives`) is **[proven]** by that row of `tests/e2e/engine/suites/` on the
> real stack (gnome-server + HolyWisp, Chromium 156 and Firefox 157, both engines unless the text says otherwise) in
> the final run of the lane that owns it, or by a named unit test. A row marked `expectFail` is a measured limit,
> never proof that something works. The lanes' final runs are the evidence until the integration step reruns every
> suite in both browsers.

The **app** (the SPA on the app origin) owns the browser UI and all user data. The **engine host**
(`<proxy origin>/engine/`, ARCHITECTURE §4.6) owns the proxy engines, the transports, the service worker, one iframe
per tab, and (Wave B step 3) the content-blocking runtime. They talk only through this protocol.

## 0. Files of the contract

| File | Between | Contents |
| --- | --- | --- |
| `frontend/src/shared/engine-protocol.ts` | app ⇄ engine host | `PROTOCOL_VERSION`, every command, result and event type, `LIMITS`, `TIMEOUTS`, `TICKET`, `EVENT_RATE_LIMITS`, `COALESCE_MS`, `FORWARDED_PRIVILEGED_LIMIT`, capabilities, the validators (`validateEventMessage`, `validateCommandResult`, `validateCommandMessage`, …), the handshake decisions (`decideHello`, `decideConnect`), `TokenBuckets`/`admitEvent`, the ticket clock (`ticketExpiresAtLocal`, `ticketRenewDelayMs`), `engineChoice`, `isWispServer`, `isCombo`, `normalizeHttpUrl`, `sanitizeText`, `fitText`, `fitInt` |
| `frontend/src/shared/site-rules.ts` | app and engine host | host-key syntax and matching (`ruleFor`, `siteKeysFor`), the engine-enforced permissions (app: `resolveEnginePermissions`, `enginePermissionsFor`; engine host: `tabFrameAllow`), the popup decision (`decideOpen`) |
| `frontend/src/shared/transport.ts` | engine host (lanes a ⇄ b) | `TransportManager`, the Wisp URL form (`routeEndpoints`, `wispUrl`, `probeUrl`), `classifyProbe`, `retryAfterMs`, `RECOVERY`, `backoffDelayMs`, `RebuildBudget`, the shared UV transport rule (`uvTransportKey`, `uvTransportAction`) |
| `frontend/src/shared/proxy-origin.ts` | engine host, SW, gnome-server | paths, the pinned `/vendor/**` builds, the CSPs (`PROXIED_DOCUMENT_CSP`, `engineHostCsp`, `bareMuxWorkerCsp` + `bareMuxWorkerScriptCsp`, `proxyScriptCsp`, `proxyInertCsp`, with the operator's custom-Wisp opt-in), `engineHostUrl`, the download rules (`downloadDisposition`, `downloadFilename`, `bareMime`), `WEBRTC_GLOBALS`, the engine-host ⇄ SW messages, `SwClient` |
| `frontend/src/shared/engine-hooks.ts` | engine host, SW ⇄ Wave B step 3 | the content-blocking hook points (`RequestHooks`, `EngineHooks`, `ALLOW_ALL`, `safeVerdict`) |
| `frontend/src/shared/browser-data.ts` | app (lanes c ⇄ d) | history, bookmark and download store APIs, `BOOKMARK_ROOT`, `shouldRecordVisit`, `VisitGate` and `LIBRARY_LIMITS` (caps on what engine events can write), the `provideLibrary` registry |

All of them are pure and side-effect free at import time; the protocol file has no runtime dependencies at all.
Built as separate bundles, a bundle that imports only the engine-host half of the validators does not contain the app
half (checked with rolldown after the contract fix: 11.6 KB vs 15.0 KB minified). In the multi-entry Vite build the
file lands once in the chunk both entries share, so that chunk carries both halves (a size cost only).

## 1. Threat model

### 1.1 The boundary

The **app origin is the only boundary GNOME guarantees.** The **proxy origin is one shared realm** (decisions log,
2026-11-11): every proxied tab, the engine host, both engines' cookie jars, the service worker and the bare-mux
SharedWorker share one origin, and nothing inside it is a boundary against a hostile site.

Two kinds of attacker code run in a proxied page (spike §11.1):

- **Ordinary** (virtualized): the site's own JavaScript, rewritten by Scramjet or Ultraviolet. Every hostile site.
- **Escaped**: JavaScript that got out of its engine's virtualization. Escaped code is same-origin with the engine
  host and reaches it through `window.top[0]`.

**An ordinary page becomes escaped code without any engine bug** **[proven]** (`host-attack borrow-natives`, recorded
`expectFail`: both engines, both browsers, 2026-11-12). A fresh child realm's own **native** `parent`, `top` and
`frameElement` getters, called on the page's own window (`Object.getOwnPropertyDescriptor(frame.contentWindow,
'parent').get.call(window)`, or `window[0]` of a frame the parser inserted), return the engine-host window: the engines
virtualize those getters only in the realms they reach. Virtualizing them in every fresh realm from page JavaScript is
defeated by the same realm gaps the WebRTC kill switch has (§6.15) and would break the engines' own `top`/`parent`
logic, so step 2 ships this as a limit of same-origin proxying; only engine-level virtualization of every fresh realm
or per-site proxy sub-origins would close it. Upstream escapes exist besides. So **any site built to attack GNOME
has the "Escaped" column**: the "Ordinary" column below says only what the engines' virtualization stops for a page
that does not target GNOME. Every check of the app-origin boundary held, from the page and from the engine-host realm
(`host-isolation`, the escaped variant: app storage, ticket minting with credentials and the CSRF header, form POST,
top navigation; all refused).

What they can do **[proven]** (spike §11.2 attack ids A1–C3, §3 item 3; corrected by the Wave B step 2 rows named):

| | Ordinary page (virtualization only) | Escaped code: any page built to attack GNOME |
| --- | --- | --- |
| App storage, credentialed state-changing app API, the app's top window, a forged message the app accepts from a non-host frame (A1–A4) | no | no (`host-isolation`; `host-attack handshake-forgeries`, `host-inject-forged-hello`) |
| WebRTC straight to the network, revealing the user's IP (C1) | **yes** without the kill switch; with it, not from its own realm or ordinary fresh frames, but **yes** for a page that polls a frame while it navigates, and the other gaps of §6.15 | **yes**, through the same gaps |
| Join, read and write any BroadcastChannel of the proxy origin whose name it knows (so v1 never uses a fixed name: SW signals use `Client.postMessage`, and the UV socket tap reaches the engine hosts without one, §6.6, ARCHITECTURE §5.4) | yes | yes |
| Take over the engine-host realm, read the Wisp ticket and every app→engine message, capture the port and forge any engine→app event (B6) | no through its engine; **yes** through `borrow-natives` | **yes** |
| Read and change other tabs' documents, form values, storage (B1) | no through its engine; **yes** through `borrow-natives` | **yes** |
| Read both cookie jars including HttpOnly cookies, plant cookies for any site (B2, B3) | Scramjet: own client's jar; UV: `__op` is not renamed; everything through `borrow-natives` | **yes** |
| Unregister or replace the service worker, register its own (B7) | no through its engine (`navigator.serviceWorker` is removed in proxied pages); **yes** through `borrow-natives` | **yes** (it can persist across engine-host reloads) |
| Use Ultraviolet's shared bare-mux transport (B8) | UV pages keep a native `SharedWorker`: a page can connect to bare-mux's worker, read the installed transport's name (the route key: a VPN profile id or custom server URLs) and send requests through it as UV does; replacing it needs the per-origin lock secret (`transport lock` row: refused in both browsers), which `borrow-natives` reads from the engine host's `localStorage` | **yes** (all UV traffic of every GNOME tab) |
| Open a native, unproxied popup (C2) | no | **yes** with `allow-popups*`; **no** in v1 (§6.3; `host-attack native-popup-from-escaped-code`: nothing opens) |
| Make Chromium preconnect (TCP + TLS + SNI, no request) to a host for a CSP-blocked navigation | no through its engine | yes (no page-side fix) |
| Read another proxied site's pages with the user's cookies there, and send that site forged requests (security review, integration part 2) | **yes**: neither engine enforces CORS; Ultraviolet 3.2.10 sends every cookie of the destination with every request, SameSite ignored; Scramjet applies SameSite (so only `SameSite=None` cookies go with a cross-site `fetch`) | yes |
| Read `GET /api/health` and `GET /api/filters` of the proxy origin (B9) | yes | yes (the proxy-origin health answer is trimmed, API.md) |

**Escaped code finds no native route in the realms GNOME controls** **[proven]** (`host-attack
escaped-native-routes`, the spike's leak `bypass` on the real engine host, both engines, both browsers: a fresh blank
child's fetch, the engine host's fetch, image and beacon, a popup and the engine host's `RTCPeerConnection` send nothing
natively; `escaped-self-navigation`: the engine host's policy, whose `frame-src` falls back to `default-src 'self'
data: blob:`, refuses a tab frame that escaped code navigates to another origin, so nothing is requested;
`escaped-engine-iframe-navigation`: escaped code can also navigate the engine iframe itself, and that navigation obeys
the **app's** `frame-src`, which since integration part 2 lists only the proxy origin and `blob:` (it used to list
nine game-embed hosts and `'self'`: the security review loaded `https://itch.io/` natively that way in both browsers;
`blob:` only lets proxy-origin blobs, with their creator's strict policy, replace the engine host, which escaped code
can do with any proxy-origin URL anyway): a former game-embed host and the app origin are refused, and no request
reaches either; the row fails with the shell policy off). What stays open is listed in the table above (`borrow-natives`, the WebRTC gaps of §6.15, Chromium's preconnect,
which the same row records for the refused host).

**Every proxy-origin answer carries a strict policy** **[proven]** (`backend-proxy` parts `realm`, `worker` and
`oversized`; `host-attack borrow-proxy-origin-documents`; `sw hold503`). A browser fact this rests on: Chromium
commits an empty-bodied 4xx answer in a subframe as a **same-origin document with no policy** (Firefox shows an opaque
error page; measured by lane e's review before the fix, while with the policy the frame stays opaque in both browsers,
`backend-proxy oversized`), so an answer without a CSP is a permissive realm from which escaped code reaches any host
natively.
gnome-server therefore adds `default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` to the
answers hyper writes by itself (`400`/`414`/`431` for heads it cannot parse, e.g. after a page planted a cookie bomb)
and to panic answers, and the SW's own pages carry `SW_PAGE_CSP` (`default-src 'none'; form-action 'none'; base-uri
'none'`). A reverse proxy's own error pages are not covered yet (Wave D: its header limit must stay above what
browsers send).

### 1.2 Rules that follow

1. **The app validates everything it receives** from the engine host: every event (`validateEventMessage`), every
   command result (`validateResultMessage` + `validateCommandResult` for the pending command's type) and every
   handshake message (`decideHello`). Strings are rendered as text, never as HTML. The order for an event is:
   validate; drop it when its tab or download id is unknown (silently for a tab the app closed less than
   `TIMEOUTS.closedTabGraceMs` ago, the event was in flight), *before* the rate limits, so forged ids cannot use up
   the budget of real tabs; then `admitEvent` (§5); then handle it.
2. **No engine event triggers a privileged app action.** The reactions in §5 that need a user gesture in the app's
   own UI say so; the rest only update what the app displays (or, for `needTicket`, mint a ticket within the app's
   own rate limits). Nothing an event says can read, write or delete the user's settings, bookmarks, downloads list,
   account or sync data, except the history visits and download entries that commits and downloads produce, and
   those are capped independently of the event rate limits (`VisitGate`, `LIBRARY_LIMITS` in browser-data.ts: a
   forged commit stream for 16 live tabs must not grow the user's IndexedDB without bound).
3. **URLs, titles and the VPN exit check inside GNOME are not security indicators.** A page built to attack GNOME
   (escaped code, §1.1) can make any tab show any URL, title or content, and can forge the answer of `vpn.verify`. The UI must never present the
   address bar as proof of a site's identity or the exit check as proof that traffic leaves through the VPN (the
   app takes "VPN active" from its own facts, §6.13), and must never promise isolation between proxied sites or IP
   protection against hostile pages (ARCHITECTURE §4.6).
4. **The app may send** (and must assume a hostile page reads all of it): the engine settings snapshot
   (`EngineSettings`: engine choice, fallback, transport, Wisp route including custom Wisp server URLs when the
   operator allows them, privacy toggles, content-blocking toggles, filter-list ids and hashes, shortcut combos and
   the platform flag), the Wisp ticket, the URLs of the tabs it opens or restores (and their back/forward entries)
   with the resolved autoplay/fullscreen/clipboard decisions for the destination of each load (never the per-site
   permission list), find queries, zoom factors, context-menu actions, cookie and site-data commands, the VPN check
   URL, and, only while `browser.searchSuggestions` is on, the address-bar text it wants suggestions for. The
   content blocker's per-site maps (`extensions.allowlist`, `perSite`, `cookieRules`) name every site the user made
   a rule for: the app sends them empty until the engine host reported the `blocker` capability (Wave B step 3), and
   from then on their exposure to a realm a hostile page can own is the stated cost of blocking inside the engine
   host; step 3 narrows them if its design allows.
5. **The app never sends**: the session cookie or any other app credential, account data (user name, id), history,
   bookmarks, the downloads list, the per-site permission list, other users' data, the access code, sync state,
   games data, or settings outside `EngineSettings`. Discarded tabs' URLs are sent only when the tab is restored.
6. **The Wisp ticket is a bearer token that escaped code can read.** It authorizes Wisp for one session and nothing
   else; it lives at most `GNOME_WISP_TICKET_TTL_S` (1 h by default), counts against the per-session connection cap,
   and in `accounts` mode dies with its session. The engine host keeps it in module scope, where a page cannot read
   it through its engine's virtualization (A5), but any page can through `borrow-natives` (§1.1), so nothing relies on
   that.
7. **The engine host validates commands too** (`validateCommandMessage`), for robustness: it cannot defend itself
   against code in its own realm.
8. **Compromise signals.** The app counts, in its `engine-protocol` diagnostics status: hellos it did not ask for
   (§2.2), engine-iframe loads it did not start (§2.3) and events or results that fail validation. Those three are
   shown as compromise signals. Benign sites can trip the others, so they are separate counters that are not
   called compromise signals: events dropped by the rate limits, events for unknown tab or download ids, visits and
   downloads over `LIBRARY_LIMITS`. v1 takes no automatic action beyond §2.3.
9. **No credential prompt from an event.** `needTicket` and `status` never open the sign-in or access-code dialog by
   themselves: a ticket mint that an event started and that answers `login_required` / `access_code_required` shows a
   passive notice with a button, and only that button or a navigation the user starts in the browser view (gestures
   in GNOME's own UI) opens the dialog (§6.5). A hostile page must not be able to summon GNOME's credential prompts
   on cue.

## 2. Handshake and lifecycle

### 2.1 Embedding

The app's browser view creates one iframe (ARCHITECTURE §4.6):

```html
<iframe title="Browser content"
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation"
  allow="fullscreen; clipboard-write; autoplay">
```

No `allow-popups`, no `allow-popups-to-escape-sandbox`, no `allow-top-navigation*` (decisions log 2026-11-11).
**[proven]**: the specified sandbox gives the engine host a real origin, a secure context, a service worker at scope `/`,
IndexedDB and Cache Storage, also with third-party storage partitioning on (same-site embed); without
`allow-popups` `window.open` returns `null` (Chromium) or throws (Firefox). The iframe's `src` is
`engineHostUrl(proxyOrigin)`, always `<proxy origin>/engine/` without parameters; the proxy origin comes from
`GET /api/config` → `proxy.origin`.

Custom Wisp servers and the CSPs (decisions log 2026-11-11, which supersedes the `?wisp=` URL parameter of the first
draft): the engine-host and bare-mux worker policies allow `connect-src 'self'` only, which blocks Wisp servers on
other hosts, and no URL parameter may widen a policy of the proxy origin (escaped code could load
`/engine/?wisp=wss://attacker` in a same-origin frame and use that realm's wider `connect-src`). The operator decides
with `GNOME_ALLOW_CUSTOM_WISP` (default off; `/api/config` → `wisp.custom_servers`): off, the app never sends a
`custom` route and Settings explains why the custom-server editor is unavailable; on, gnome-server adds `ws: wss:` to
both policies (`engineHostCsp(appOrigins, {customWisp: true})`, `bareMuxWorkerCsp({customWisp: true})`, and the
worker's second policy `bareMuxWorkerScriptCsp(appOrigins, {customWisp: true})`, §6.16) and Settings
warns that custom servers bypass the gateway, its access rules, VPN profiles and part of the leak protection.
**[proven]**: the opt-in policies on the real stack (`transport custom`: without the opt-in neither the engine host
nor the bare-mux worker can reach a custom server, nothing loads and every engine × transport side reports
`offline`/`gateway-unreachable`, never `ready`; with it a test socket (closed after 4 s when a server does not answer,
`test-socket.test.ts`) skips a dead first server before any page asks,
HolyWisp addressed directly serves the first navigation for all four engine × transport combinations, and a server
that dies later sends the side to `offline`/`gateway-unreachable` until it is back; `backend-proxy` parts `custom` and `worker`:
the engine-host and bare-mux worker realms may then open `ws:`/`wss:` to any host while fetch, images, beacons,
imports, frames and forms stay blocked, and every other policy is unchanged).

### 2.2 hello / connect (hardened)

1. The app creates the engine iframe (or replaces it, §2.3) and only then starts **expecting** a hello.
2. The engine host checks `window.parent !== window` (otherwise it shows "This page only works inside GNOME" and
   stops), creates a random `instance` id (8–32 lower-case letters and digits) and posts
   `{gnome: 'hello', protocol, build, instance}` to `window.parent`, once per allowed app origin (the
   `gnome-app-origins` list gnome-server templates into the page, the same list as its `frame-ancestors`), every
   `TIMEOUTS.helloIntervalMs` (500 ms) until a connect arrives, for at most 15 s. Hello carries no secrets.
3. The app runs `decideHello(event, {expectedSource: iframe.contentWindow, proxyOrigin, expecting, connectedInstance})`:
   - `ignore` (wrong `source` or `origin`, malformed, or a repeat of the connected instance) → nothing;
   - `unexpected` (a valid hello while the app is not expecting one) → ignored and **counted as a compromise
     signal**: this is how the spike's B6 attack re-handshaked a captured engine host;
   - `mismatch` (other protocol version) → "GNOME was updated" state (§2.4);
   - `connect` → the app stops expecting, creates a `MessageChannel`, keeps `port1` and posts
     `{gnome: 'connect', protocol, instance}` to the iframe with target origin = the proxy origin and `port2`
     transferred. Then it sends `init` (§4).
4. The engine host runs `decideConnect(event, {parent: window.parent, appOrigins, instance, connected})`: it accepts
   exactly **one** connect per load, from `window.parent`, from an allowed app origin, for its own instance, with one
   port; it records `event.origin` as the app origin. A connect with another protocol version or without a port gets
   `{gnome: 'mismatch', protocol, instance}`. Everything after that goes over the port.
5. No hello within `TIMEOUTS.helloWaitMs` (20 s) of creating the iframe → the app shows "The browser engine did not
   start" with Retry (which replaces the iframe, §2.3). The timeout does **not** end `expecting`: a late first hello
   from that same iframe still connects (a slow start recovers by itself: the engine host repeats hello for 15 s from
   when its script runs, which can be after the app's 20 s). Counting it as a compromise signal only raised false
   alarms: a hello forged into a never-connected engine host (by code that controls another realm of the proxy
   origin, §1.1) could arrive just as well inside the window, and an accepted engine host is untrusted anyway (§1.2).
   Only an accepted hello (connect or mismatch) or replacing the iframe ends it (`HelloContext.expecting`, integration
   2026-11-18). Implemented in integration part 2 (2026-11-19): `src/browser/engine/client.ts` keeps `expecting` when
   the timer fires and goes `failed` → `connecting` on the late hello; Retry or a replaced iframe ends the window
   (`client.test.ts` "EngineClient late first hello"). **[proven]** in both browsers (`shell-browse` "a late first hello
   from the same iframe connects after 'did not start'": the engine host's script delayed 23 s, the same iframe connects,
   no compromise signal, no new iframe); Retry ending the window is unit-tested only.

**[proven]**: the instance-id handshake, re-handshake after an app reload, and that the app ignores hellos and events
from other frames (A4); "expecting only" (`host-attack host-inject-forged-hello`: a hello forged in the engine-host
realm is counted as unexpected and no port reaches the injected code) and one connect per load (`host-attack
handshake-forgeries`: a connect forged from a tab frame, with a forged or the real instance, gets no answer and the
engine host keeps working). **[unproven]**: posting hello per origin instead of `*` (used by every run, not asserted
by a row).

### 2.3 One port per engine-host load; reloads and hangs

- The engine host never accepts a second port, and it never reloads or navigates itself. The app never re-handshakes
  an engine host it is connected to: to reconnect it **replaces the engine iframe element** (removes it and inserts
  a fresh one with the same attributes: a new document, a new instance). It never sets `src` on the existing iframe:
  navigating an existing cross-origin iframe can add a joint session-history entry (in the HTML navigate algorithm a
  same-URL navigation is a replacement only for a same-origin initiator), and the browser's Back button would then
  reload the engine host, which is an unexpected load, which resets it again: a Back-button trap. A fresh iframe's
  first navigation adds no entry **[proven]** (`shell-browse`: `history.length` unchanged after Retry from "The
  browser engine did not start", after "Restart browser engine" and after unexpected-load recovery).
- **Unexpected load**: a `load` event of the engine iframe that the app did not cause (an escaped page can reload or
  navigate the engine-host document) means the engine host was replaced. The app then: counts a compromise signal,
  rejects pending commands with "engine host restarted", marks that instance's unfinished downloads `untracked`
  (browser-data.ts), replaces the iframe (expecting a hello), and after `init` re-creates its tabs with
  `tab.create {start: {kind: 'restore'}}` from its own copy of their back/forward entries. Discarded tabs stay
  discarded. **[proven]** (`shell-browse` "engine-host reload recovery": a proxied page runs
  `top[0].location.reload()`, the app counts one unexpected load, replaces the iframe and restores the tab's entries).
  In Firefox the reloaded engine host's hello can arrive before the iframe's `load` event, so the app then also
  counts an unexpected hello; both are valid signals.
- **Liveness**: while the browser view is visible the app sends `ping` every 30 s (timeout 5 s). Two timeouts in a
  row → the engine status becomes "not responding" with a "Restart browser engine" button (a gesture), which
  replaces the iframe as above. No automatic restart: a long-running page script freezes the app too (same renderer
  thread, ARCHITECTURE §5.4) and would only be killed.
- **Several GNOME tabs** (several app pages) mean several engine hosts on one proxy origin. They share the service
  worker (signals go to every engine-host client, and each host acts only on what matches its own tabs, §6.9), the
  Scramjet cookie sync, the proxied cookie jars and bare-mux's single SharedWorker, hence one Ultraviolet transport
  (§6.6). The SW apply step runs only in the only engine host (§2.5). **[proven]**: two engine hosts with UV
  traffic at the same time (`transport shared`, §6.6).
- An app reload creates a new engine host **[proven]**: it re-handshakes with a new instance, has no tabs, the app
  restores tabs from **real** URLs (never proxied ones); old Scramjet URLs get `503 stale-prefix` from the SW in 1 ms;
  UV URLs are stateless.

### 2.4 Protocol version mismatch

The app bundle and the engine-host bundle come from the same build, but an app page loaded before a deploy can embed
an engine host from after it. On `mismatch` (either direction) the app shows "GNOME was updated — Reload" and its
button (a gesture) reloads the whole app (`location.reload()`); nothing else is sent.

### 2.5 Service-worker updates

A new `/sw.js` must not take over a running engine host (it breaks both engines **[proven]**): the SW neutralizes
upstream `skipWaiting()`, so an update waits. `status.sw` tells the app what to show:

| `sw` | App |
| --- | --- |
| `controlled: false` | engine status "starting"; `init` fails after its timeout if it stays so |
| `updateWaiting: true` or `current: false` | a non-blocking "GNOME was updated — Reload" notice; if other GNOME tabs are open, "close the other GNOME tabs, then reload" |

The **apply step** runs in the engine host at startup, before any engine exists (`SwClient.ensureControlled()`): if a
newer worker is waiting and this is the only engine host (the waiting worker counts `/engine/` window clients), the
host posts `{type: 'gnome-skip-waiting'}` to it, waits for `controllerchange`, and only then starts the engines.
Because a GNOME tab closed a moment earlier can still be counted by the waiting worker, the host asks again every
500 ms within a 3 s window before it gives up.

**Background update check** (`sw-client/client.ts`). Chromium may install a new `/sw.js` only about 1.5 s after the
reload that should have applied it, so the startup apply step finds nothing waiting. Once the host is controlled it
therefore calls `registration.update()` itself: at once when the active worker is another build (`current: false`),
otherwise after 3 s, then every 15 min. A new worker installs and waits, `status.sw.updateWaiting` turns true (0–3 s
after the start), and the next load of the only GNOME tab applies it. An update check **before** the host is
controlled was tried and breaks Firefox: the update job ran while the engine host was uncontrolled and left a
redundant controller (no `sw-hello`, `controller.wait()` timed out), so it is not done.

**Idle stop (Firefox).** Firefox stops an idle service worker after about 30 s even while engine hosts run. The next
Scramjet request then reaches a fresh worker whose prefix no controller announced: it is held (up to 5 s,
ARCHITECTURE §5.4) while the SW asks the clients to revive the controller. A double revive (the
hold's immediate one plus `controller.sw.js`'s own at worker start) made the engine host's `Controller` replace its
port and lose a request already in flight, so the page hung for 20 s; the hold now waits one interval before it adds
a revive of its own.

**[proven]**: updates wait while both engines keep working (`sw update` "a new /sw.js waits while engine hosts run");
the explicit apply step and its refusal with two engine hosts (`sw update` "with two GNOME pages open the apply step is
refused", "the only GNOME page applies the waiting update at its next load", also right after the other GNOME page
closed; `shell-sw-update` 3/3 in both browsers; its row "with the other tab closed, Reload applies the update" is
intermittent: it failed once in Chromium (integration part 2, shell lane) and once in Firefox (the final gate's full
run: the update was still waiting after the reload) and passed on each re-run, so a user may need a second reload);
the background check ("an update no page has noticed yet is found
within seconds of the next load and waits"); the idle stop and revive (`sw stop`: Chromium stops the worker over CDP,
Firefox by its own idle stop: held, revived once, routed).

## 3. Envelope, validation, timeouts

```ts
type CommandMessage = { k: 'cmd'; id: number; type: CommandType; p: CommandPayload };              // app → engine host
type ResultMessage  = { k: 'res'; id: number; ok: true; p: unknown }                               // engine host → app
                    | { k: 'res'; id: number; ok: false; error: { code: CommandErrorCode; message: string } };
type EventMessage   = { k: 'evt'; type: EventType; p: EventPayload };                              // engine host → app
```

- `id`: a positive integer, unique per port. The engine host answers every command exactly once; an unknown or
  invalid command with a readable `id` gets `ok: false` with `unknown_type` or `bad_request`
  (`validateCommandMessage` returns that `id`).
- Error codes: `unknown_type` · `bad_request` · `bad_state` (e.g. a second `init`) · `unsupported` (capability not
  offered) · `no_tab` · `tab_exists` · `too_many_tabs` · `no_entry` · `no_document` · `engine_unavailable` · `timeout`
  · `failed`. The app reads any other code as `failed`.
- Results are validated per command type before the promise resolves; an invalid result rejects it like an error.
- Unknown event types are ignored (an engine host newer than the app); unknown command types answer `unknown_type`.
  Either side can be upgraded first within one protocol version, as long as additions are optional.
- Builds made for the e2e harness may accept `test.*` commands (fault injection, counters); production builds never
  do, and the app never sends them (WAVE-B lane b).

**Validation rules** (both directions, implemented once in the protocol file):

| Input | Result |
| --- | --- |
| Wrong type, missing key, unknown enum value, `undefined` where `null` is meant | **rejected** |
| Integers: NaN, ±Infinity, fractions, out of range; numbers out of range | **rejected** |
| String longer than its limit, array or record longer than its limit, object with more than 64 keys | **rejected** |
| A URL field that is not an absolute `http:`/`https:` URL (`javascript:`, `data:`, `blob:`, `file:`, relative, …) | **rejected** |
| Favicon not `data:image/{png,gif,jpeg,webp,avif,bmp,x-icon,vnd.microsoft.icon,svg+xml};base64,…` or over 64 KiB decoded | **rejected** |
| A key `__proto__`, `constructor` or `prototype` in any object the validator reads; accessor properties; class instances, Maps, Dates, arrays where an object belongs | **rejected** |
| Unknown keys | dropped |
| Display text (titles, details, messages, file and cookie names) | C0/C1 controls become spaces, bidi embedding/override/isolate controls are removed, lone surrogates become U+FFFD |
| Multi-line text (selection text, log messages, find queries) | controls other than tab, CR and LF removed; bidi embedding/override/isolate controls removed; lone surrogates become U+FFFD |
| URLs | re-serialized by the URL parser (`href`), user name and password removed |

**Limits** (`LIMITS`): URL 8192, ws URL 2048, title 1024, detail 300, message 500, selection 100 000, file name 255,
favicon 64 KiB decoded, find query 512 (at most 1000 matches counted), suggestion query 256 (10 results of ≤ 256),
64 shortcut combos of ≤ 48 visible ASCII characters (canonical combos are at most 35), 5000 entries per host-keyed
record or list, 500 filter lists, 16 Wisp servers, 50 back/forward entries per tab (kept, reported and restored),
`tab.go` delta ±50, zoom 0.25–5, 5000 cookies per list, 32 live tabs per engine host, timings ≤ 1 h; app side: 16 live
proxied tabs before the least recently used background tab is discarded, 500 GNOME tabs per app page.

**The engine host fits what it measures before emitting** (the validators reject instead of clamping, so an
unfitted value would drop the whole event): display text with `fitText` (cut to its limit, ending in "…"); file names
with `downloadFilename` (proxy-origin.ts); selection text cut to 100 000 with `selectionTruncated: true` (the app then
offers no Copy item, the page's own copy still works); coordinates, durations and counts rounded and clamped with
`fitInt`; a favicon over 64 KiB becomes `null`; a document URL longer than 8192 is reported as its origin and path
without query and fragment, cut to the limit (the engine host keeps the full URL in its own back/forward list). Debug
builds run `validateEventPayload` on every event they emit as a self-check (WAVE-B lane a).

**Timeouts** (`TIMEOUTS`, app side, from sending the command): `init` 40 s · `ticket` 30 s · `siteData.clear` 30 s ·
`vpn.verify` 20 s · `cookies.*` 10 s · `status`, `tab.state`, `ping`, `diagnostics`, `tab.find`, `suggest` 5 s ·
everything else 10 s. Navigation commands resolve when the navigation has **started**; its outcome arrives as
events. **Navigation watchdog** (app): a navigation that started and got neither `tab.loaded` nor `tab.error` within
`TIMEOUTS.navigationWatchdogMs` (25 s, more than the engine host's 20 s navigation timeout) makes the app ask
`tab.state`; so do resuming a hidden app page and rate-limit drops for that tab. A lost event never leaves a tab
spinning.

## 4. Commands (app → engine host)

Capabilities: `init` returns `capabilities`, the optional features the engine host implements (`zoom`, `print`,
`selectAll`, `saveLink`, `saveImage`, `cookies`, `siteData`, `suggest`, `vpnVerify`, `blocker`), each reported only once
its e2e test passes in both browsers. The app shows UI only for those; a command that needs a missing one fails with
`unsupported` (`requiredCapability`). The other features are core: every engine host implements them. Site
permissions are reported per permission (`enforcedPermissions`, §6.14), because browsers differ in which of them a
frame's `allow` attribute can enforce.

| Command | Payload | Result | Notes |
| --- | --- | --- | --- |
| `init` | `{settings: EngineSettings, ticket: Ticket \| null, clearOnStart: {cookies, siteData}}` | `{instance, status, versions, capabilities, enforcedPermissions, timings}` | first and once per port (a second one: `bad_state`). `clearOnStart` clears proxied cookies / all proxied site data before the engines start (§6.11). A null ticket leaves the transports `offline` / `ticket-missing` |
| `settings` | `{settings: EngineSettings}` | `{}` | a full snapshot, never a patch; the engine host applies what changed (transport kind or route: rebuild; privacy, keys: next use) |
| `ticket` | `Ticket {value, expiresAt, wispUrl}` | `{}` | answer to `needTicket` or a proactive renewal (§6.5). `wispUrl` is informational: the engine host builds its URLs from the route |
| `status` | `{}` | `EngineHostStatus` | after the app dropped `status` events, and on resume |
| `ping` | `{}` | `{instance, uptimeMs}` | liveness (§2.3) |
| `diagnostics` | `{}` | `EngineDiagnostics` | counters only, no URLs or titles (§6.18) |
| `tab.create` | `{tabId, active, engine: EngineId \| null, zoom, start, permissions}` | `{navId, engine}` (both null for a blank start) | `start` = `{kind: 'blank'}` (no frame until navigated) · `{kind: 'url', url, opener?}` (`opener`: the real URL of the page that asked for the tab, §6.3: the load is that page's navigation, §6.1) · `{kind: 'restore', entries, index}` (session restore, un-discard: real URLs, loads `entries[index]`, back/forward work over the others). `engine` forces an engine. `zoom` is ignored without the `zoom` capability. `permissions` (`EnginePermissionSet`, every command that loads a page carries it): the decisions for the destination it loads (§6.14). Beyond 32 live tabs: `too_many_tabs` |
| `tab.close` | `{tabId}` | `{}` | also how the app discards a tab (memory saver): the app keeps its URL and entries and restores it later |
| `tab.activate` | `{tabId: TabId \| null}` | `{}` | shows that tab's frame and hides the others; `null` = no proxied tab visible (the active GNOME tab shows an internal page) |
| `tab.navigate` | `{tabId, url, engine: EngineId \| null, permissions}` | `{navId, engine}` | resolves when the load started. `engine` forces an engine: no automatic fallback for this navigation |
| `tab.go` | `{tabId, delta, permissions}` (±1…50) | `{navId, engine}` | through GNOME's per-tab history, never the frame's own (`frame.back()` can move other frames or the app): a full load of the target entry's URL with `location.replace`, also for an entry a page made with pushState (the SPA then loads that route fresh). `permissions` for the target entry of the app's copy. `no_entry` when out of range |
| `tab.reload` | `{tabId, permissions}` | `{navId, engine}` | `no_document` when the tab has no page. Also what `hardReload` does: proxied responses do not come from the browser's HTTP cache (the SW answers them from the Wisp transport; by construction, not separately tested) |
| `tab.stop` | `{tabId}` | `{}` | ends the navigation (`tab.loading {loading: false}`) |
| `tab.state` | `{tabId}` | `TabState {entries, index, title, loading, navId, engine, error}` | core: what the engine host knows about the tab (its back/forward list, the navigation in progress or the last one, the `tab.error` of a failed one). The app resynchronizes with it (§3 navigation watchdog) |
| `tab.zoom` | `{tabId, factor}` (0.25–5) | `{factor}` | capability `zoom`; per tab, kept across navigations (§6.10) |
| `tab.find` | `{tabId, query, backwards, caseSensitive}` | `{matches, active, highlights, capped}` | the same query again moves to the next (or previous) match; `active` is 1-based, 0 without matches (§6.10) |
| `tab.findClear` | `{tabId}` | `{}` | removes the highlights |
| `tab.action` | `{tabId, action: 'selectAll' \| 'print'}` | `{}` | capabilities `selectAll`, `print` (§6.10) |
| `tab.download` | `{tabId, url, kind: 'link' \| 'image'}` | `{}` | capabilities `saveLink`, `saveImage`: "Save link/image as"; reported with `download.*` events |
| `cookies.list` | `{site: string \| null}` | `{cookies: CookieInfo[], truncated}` | capability `cookies`: both engines' jars, `site` = that domain and its subdomains; no values (`size` only) (§6.11) |
| `cookies.delete` | `{all, site, name}` | `{deleted}` | capability `cookies`: `all: true` takes no site or name; otherwise `site`, and `name` null = every cookie of the site |
| `siteData.clear` | `{kinds: ('cookies' \| 'storage' \| 'cache')[]}` | `{}` | capability `siteData`: for every proxied site, both engines |
| `suggest` | `{query, provider}` | `{items: string[]}` | capability `suggest`: search suggestions through the proxy transport, never through GNOME's server (§6.12) |
| `vpn.verify` | `{url}` | `{ip, country, city, vpnExit, checkedAt}` | capability `vpnVerify`: loads the exit check (`/api/vpn/locations` → `verify_url`) through the current route; the answer is not proof (§6.13) |

Removed from the draft: `tab.discard` (= `tab.close` + restore), `tab.contextAction` (the app does what it can itself,
the rest is `tab.action` / `tab.download`), `download.cancel` (the browser owns downloads), `permission.reply` (no
engine-side prompts in v1, §6.14), `blocker.reload` / `blocker.stats` (the settings snapshot carries the lists; counts
arrive as `tab.blocked`). Removed by the contract fix: `EngineSettings.permissions` (the per-site list; replaced by
the per-load `permissions`) and the `permissions` capability (replaced by `enforcedPermissions`).

`EngineSettings` (built by the app from its settings and `/api/config`; `validateEngineSettings` checks it):

```ts
interface EngineSettings {
  engines: { scramjet: boolean; ultraviolet: boolean };       // /api/config engines: a disabled engine is never started
  engine: 'auto' | 'scramjet' | 'ultraviolet';                // engineChoice(browser.engine, engines.default, engines)
  autoFallback: boolean;                                      // browser.autoFallback
  transport: 'libcurl' | 'epoxy';                             // browser.transport, both engines
  route: { kind: 'default' } | { kind: 'profile'; id } | { kind: 'custom'; servers };  // §6.6
  privacy: { webrtc: 'block' | 'allow'; sendGpc; doNotTrack; referrer; stripTrackingParams; cookies };
  extensions: { enabled; lists: FilterListRef[]; allowlist; perSite; cosmeticAggressive; cookieRules };   // step 3
  keys: { combos: string[]; apple: boolean };                 // §6.7
}
```

`engine`: `engineChoice()` maps `browser.engine` and the operator's default (`/api/config` → `engines.default`,
`GNOME_ENGINE_DEFAULT`): `auto` with the default Scramjet stays `auto` (Scramjet first, controlled fallback); `auto`
with the default Ultraviolet becomes `ultraviolet` (no automatic fallback; the error overlay offers Scramjet); a chosen
engine the server disables gives way to the one it offers.

`route`: `profile` with `vpn.preferredLocation` when `vpn.mode` is `gateway` (the VPN, once turned on, always wins:
custom servers would bypass it, so they are not used then and Settings says so); otherwise `custom` when
`/api/config` → `wisp.custom_servers` is true and `browser.wispServers` has entries the protocol accepts
(`isWispServer`; in order, duplicates removed; paths are on the proxy origin); otherwise `default`. The app enforces
`vpn.killSwitch` by choosing the route: the engine host never switches routes by itself. With the kill switch off and
the selected location down (`/api/vpn/locations`), the app may switch to `default` and says so in a toast; with it on,
it never leaves the profile route.

The snapshot builder (WAVE-B lane c) sends only values the validator accepts, so a saved setting can never make
`init` fail: combos in canonical form, each once (two actions bound to one combo send it once; `isCombo`); Wisp
servers filtered with `isWispServer`; the extension site maps empty until `blocker` is offered (§1.2 rule 4);
`privacy.webrtc` forced to `block` under the VPN kill switch. A property test checks that every Settings value
`validate.ts` accepts produces a snapshot `validateEngineSettings` accepts.

## 5. Events (engine host → app)

Every event is validated, then dropped when its tab or download id is unknown (§1.2 rule 1), then admitted by
`admitEvent`: a port-wide flood bucket (burst 800, 400/s), then a bucket per event type and scope (per tab; per
download for `download.progress`/`done`; per port for the rest) with the rates of `EVENT_RATE_LIMITS`. Dropped events
are counted (not as compromise signals, §1.2 rule 8). "Gesture" = the reaction needs a user gesture in the app's own
UI.

**Coalescing (engine host).** Events that carry only a latest value are throttled per tab (per download for
`download.progress`) to at most one per `COALESCE_MS` interval (`tab.loading`, `tab.title` and same-document `replace`
commits 200 ms, `tab.favicon` 2 s, `tab.blocked` 500 ms, `download.progress` 200 ms): the first value of a quiet
interval goes out at once, later ones are held and only the newest is sent when the interval ends. That is at most
half of the app's bucket rate, so the newest value always arrives and ordinary sites (replaceState-heavy SPAs,
animated favicons, ticker titles) never hit the app's limits. Pushes and cross-document commits are entries and are
never merged. Before any other event of a tab, that tab's pending coalesced values are sent first, so the order per
tab is kept.

| Event | Payload | App reaction | Gesture | Burst / per s |
| --- | --- | --- | --- | --- |
| `status` | `EngineHostStatus {engines, transport, sw, blocker}` | status registry (`src/app/status.ts`: `engine`, `transport`), engine badge, transport and update notices (§2.5, §6.6) | no | 20 / 10 |
| `needTicket` | `{reason: 'expiring' \| 'rejected' \| 'missing'}` | `POST /api/wisp/ticket` within the app's limits, then `ticket`; a mint that needs sign-in shows only a passive notice (§6.5) | no (app rate limits); the sign-in dialog: yes | 3 / 0.2 |
| `tab.loading` | `{tabId, loading}` | spinner, loading bar (indeterminate: there is no progress source) | no | 20 / 10 |
| `tab.committed` | `{tabId, navId, url, engine, kind, historyHandling, index, length, canGoBack, canGoForward, ms}` | address bar, back/forward buttons, the app's copy of the entries (session restore), history visit through `VisitGate` (§6.1) | no | 20 / 10 |
| `tab.loaded` | `{tabId, navId, url, engine, ms}` | ends loading; never sent for a navigation that became a download | no | 10 / 5 |
| `tab.title` | `{tabId, title}` | tab title (text), history title | no | 20 / 10 |
| `tab.favicon` | `{tabId, icon: dataURL \| null}` | tab icon in an `<img>` (never inline SVG markup) | no | 5 / 1 |
| `tab.error` | `{tabId, navId, url, kind, signal, detail, engine, fallback, idempotent, latencyMs}` | error overlay over the content area with **Retry** and, when `fallback: 'available'`, **Open in Ultraviolet/Scramjet** (§6.4) | buttons: yes | 5 / 2 |
| `tab.engineSwitched` | `{tabId, navId, from, to, reason, latencyMs}` | engine badge, a toast "Opened with Ultraviolet because Scramjet failed" | no | 3 / 0.5 |
| `tab.openRequest` | `{openerTabId, url, disposition, userActivation}` | `decideOpen` (§6.3): open a tab (at most `LIMITS.maxTabs`), or the "pop-up blocked" indicator | without a gesture in the page and the app: yes (the indicator) | 3 / 0.5 per opener |
| `tab.closeRequest` | `{tabId}` | closes the tab only if a page opened it and it has one history entry, as browsers do; ignored otherwise | no | 2 / 0.5 |
| `tab.blocked` | `{tabId, total, byCategory}` | shield badge, counts per site; `direct-connection` = CSP-blocked direct requests (§6.16); coalesced | no | 8 / 4 |
| `tab.contextMenu` | `{tabId, x, y, target}` | the app's own context menu at the iframe offset + (x, y) (§6.8); ignored while the browser view is hidden or a dialog is open | every item: yes (a menu click) | 4 / 2 |
| `tab.key` | `{tabId, combo, repeat}` | runs the shortcut bound to `combo` if `combo` is one the app sent, `tabId` is the active tab and the browser view is visible; actions that open or close tabs or GNOME UI also need the app's own transient activation (§6.7) | see §6.7 | 30 / 15 |
| `tab.fullscreen` | `{tabId, active}` | the page put an element in fullscreen (the engine iframe is the app's fullscreen element): hide the app's chrome, show the exit hint | no | 4 / 2 |
| `download.started` | `{downloadId, tabId, url, filename, mime, total, engine}` | downloads store (capped per engine-host instance, `LIBRARY_LIMITS`), the downloads panel if `browser.downloads.openPanelOnStart` (§6.9) | no | 5 / 1 per tab |
| `download.progress` | `{downloadId, received, total}` | progress | no | 10 / 10 per download |
| `download.done` | `{downloadId, state, received, error}` | final state | no | 2 / 1 per download |
| `log` | `{level, message}` | in-memory diagnostics ring buffer only: it may contain URLs, so it is never persisted and not in "Copy diagnostics" unless the user includes it | no | 20 / 5 |

Removed from the draft: `ready` (the `init` result), `permission.request` (§6.14). Changed: `tab.loading` has no
`progress`; `tab.error.kind` has no `dns`, `tls` or `vpn-down` (§6.4). Added by the contract fix:
`tab.committed.historyHandling`/`index`/`length`, `tab.contextMenu.target.selectionTruncated`.

## 6. Semantics

### 6.1 Navigation, commits, history

- `navId` identifies one navigation (GNOME-initiated or started in the page), unique per engine-host instance; the
  navigation commands return it and `tab.committed`/`loaded`/`error`/`engineSwitched` carry it.
- **Where a navigation starts.** GNOME-initiated loads start in the engine host (`tab.create`, `tab.navigate`,
  `tab.go`, `tab.reload`). A navigation started in the page (link, form, `location` change, the page's own reload)
  starts, for Scramjet, from the per-tab plugin's request hook for the tab frame's document **[proven]**. Ultraviolet
  has no request hook in the engine host, so the engine host starts it from the tab's top document, which the UV
  document-start hook hands it at document start: the Navigation API's `navigate` event (cross-document, with
  `downloadRequest` null), or, where that API is missing, `beforeunload` (the URL is then known only at the commit)
  **[proven]** for links, GET and POST forms, `location.replace` and the page's own reload in both engines
  (`host-nav in-page:link-form-replace-reload`: loading → committed → loaded). Either way the navigation gets a navId, `tab.loading {loading: true}` and the navigation timer, and
  ends like a GNOME-initiated one.
- **Every load of a tab frame is classified**, not only those of a pending navigation: a document commits
  (`tab.committed`, then `tab.loaded`); UV's error page becomes `tab.error {signal: 'uv-error-page'}` and GNOME's
  overlay; a frame that left the proxy origin becomes `tab.error {signal: 'frame-left-proxy'}`. A page never shows an
  engine's error page (**[proven]**: `host-nav in-page:failing-link`, both engines). Nested frames that navigate
  themselves, redirect or follow a link are never taken as navigations of the tab (`host-nav nested-frames`).
- A `204`/`205` answer, or a navigation the page cancels, keeps the current document: the navigation ends with
  `tab.loading {loading: false}`, no commit and no error. Scramjet's plugin sees the status. For an Ultraviolet
  navigation started in the page, the engine host cannot see the answer: when its timer fires and the tab's previous
  document is still the frame's document, the navigation ends this way instead of with `timeout` (a server that never
  answers ends later in UV's error page, reported as above) **[proven]** for a `204` link in both engines
  (`host-nav in-page:204-link`: no error, the spinner ends).
- GNOME-initiated loads replace the frame's current entry (`location.replace`, or `src` on a fresh frame), so they
  never add entries to the app tab's joint session history **[proven]**.
- GNOME-initiated loads carry **no initiator**, like a browser's address bar: no `Referer`, no `Origin`,
  `Sec-Fetch-Site: none` (Ultraviolet sends no `Sec-Fetch-*` at all), also across their redirects, while a link the
  page follows keeps the page as its initiator **[proven]** (`host-smoke fixture:gnome-loads-carry-no-initiator`,
  both engines, both browsers). Scramjet takes the initiator from the request's service-worker client, and Chromium
  names the frame's previous document as the client of the engine host's `location.replace()`: until integration
  part 2 the next site received the previous site's `Origin` and `Referer` and got the `lax` cookie mode (its
  SameSite=Strict cookies were not sent). The engine host now passes every request of Scramjet's controller through
  `withInitiator` (`sj-requests.ts`): GNOME's own navigations lose the initiator fields, and a client that is no
  Scramjet document (the engine host itself) is dropped, which also ends Scramjet's "unrewriteurl: unexpected url
  …/engine/" console error.
- **What a page chooses keeps the page as its initiator** (security review, integration part 2). The first load of a
  tab a page asked for (§6.3), and of one the user opens from a link or image in GNOME's context menu ("Open link in
  new tab", as a browser does it), is that page's navigation, not GNOME's: the app sends the page's real URL as
  `tab.create`'s `start.opener`, and the engine host gives Scramjet the opener (in Scramjet's form) as the request's
  client, so the destination sees `Sec-Fetch-Site: cross-site`, the opener's origin as `Referer` and the `lax` cookie
  mode, as after a link click. And what the engine host fetches itself for a page (the tab's favicon from the page's
  `<link rel=icon>`, a download the page's `<a download>` starts, also by a scripted `click()`) carries that page's
  document as its initiator (`withInitiator`'s `onBehalfOf`), so a cross-site target gets only its `SameSite=None`
  cookies. Before, all three were requests without an initiator (`strict` mode): any page could send any site a GET
  with its SameSite=Strict and Lax cookies, the favicon and the download without a click. **[proven]** for Scramjet
  (`host-smoke fixture:page-chosen-requests-carry-the-page-as-initiator`, both browsers: favicon and `<a download>`
  without the victim's cookies, the opened tab with its Lax cookie only, cross-site, the opener's origin as Referer;
  GNOME's own load with both cookies and `Sec-Fetch-Site: none`). Ultraviolet sends every cookie whatever its SameSite
  attribute (§1.1), so the row is `expectFail` there. Ultraviolet's `Referer` follows the request's referrer policy
  since integration part 2 (the SW's UV `request` hook, `sw/pure.ts` `referrerFor`: the origin only to another
  origin by default; before, it sent the whole referring URL): `host-smoke fixture:gnome-loads-carry-no-initiator`
  checks the link's Referer for both engines.
- **Per-tab history** (the back/forward list) is the engine host's, at most `LIMITS.maxTabHistory` (50) entries (the
  oldest is dropped). Every `tab.committed` carries `kind`, `historyHandling`, `index` and `length`, and
  `canGoBack`/`canGoForward` (= `index > 0`, `index < length − 1`; the validator rejects a commit where they
  disagree). The app keeps its own copy of the entries for session restore: `push` drops its entries after the old
  current one, appends `url` and then drops the oldest entries beyond `length`; `replace` overwrites entry `index`;
  `traverse` moves to `index` and sets that entry to `url`. When the result does not match `index` and `length` (an
  event was dropped), it asks `tab.state` and takes the engine host's list.
- **`kind` and `historyHandling`** (`HISTORY_HANDLING_FOR_KIND`): `navigate` (a new document) is `push`, or `replace`
  for a page's own `location.replace()`, and the first commit of a restored tab is `replace` of `entries[index]`;
  `reload` is `replace`; `history` (a cross-document traversal: `tab.go`, or the browser's own Back/Forward moving the
  frame) is `traverse`; `same-document` (`ms` null) is `push` (pushState, fragment links), `replace` (replaceState)
  or `traverse` (popstate, also from the browser's own Back button). The engine host tells them apart with the
  Navigation API on each tab's top document (`navigationType`, `destination.sameDocument`), attached at document start
  with its own realm's functions; without that API it wraps the document's `History.prototype.pushState` and
  `replaceState`, listens for `popstate` and `hashchange`, and reads `PerformanceNavigationTiming.type` for
  cross-document commits (a page's `location.replace()` then counts as `push`). A traversal moves to the neighbouring
  entry whose URL matches (back first); without a match it is reported as `navigate`/`push` (cross-document) or as
  `same-document`/`replace`. **[proven]**: commits, the back/forward/reload kinds through `tab.go`, redirects (the
  commit carries the final URL), title and favicon events; from step 2, `historyHandling`, same-document commits and
  traversal detection (`host-nav spa:pushState-replaceState-fragment-back-go`: push, replace, a fragment link, the
  browser's own Back button and `tab.go` onto a pushState entry with matching `index`/`length`; `spa:fragment-link-is-push`).
  The rows check the outcome, not which of the two detection paths a browser took, so the fallback without the
  Navigation API has no row of its own. A `pushState`/`replaceState` without a URL (none, `undefined`, `null`) keeps
  the document's URL, as in a browser **[proven]** (`host-nav spa:history-without-url-keeps-the-url` and
  `real-site:duckduckgo search keeps its URL`, both engines, both browsers): Scramjet 2.0.67-alpha.2's history hook
  converts the missing URL with `String()` and moved such a page to `<origin>/undefined` or `/null` (DuckDuckGo's
  results page), so the engine host wraps those two methods in every Scramjet document (`observe/history-url.ts`) and
  passes the document's real URL instead (an upstream bug to report).
- `tab.go` always loads the target entry's URL in full with `location.replace` (`history`/`traverse`), also for an
  entry a page made with pushState: the SPA then loads that route fresh. It never calls the frame's own history
  (`history.back()` can move other frames or the app).
- **Joint session history [proven limitation]**: navigations *inside* a page add entries to the app tab's history,
  so the browser's own Back button then moves the proxied frame; the engine host reports that as a traversal (above).
  GNOME's Back button always uses `tab.go`.
- **History visits** (`shouldRecordVisit`, `VisitGate` in browser-data.ts): a cross-document `navigate` commit (push
  or replace) adds one; a `same-document` push adds one when more than the fragment changed; replaceState, traversals
  (`history`, same-document `traverse`) and reloads never do. The app passes every validated commit of a known tab
  through its one `VisitGate`: a repeat of the URL that tab recorded last, within 60 s, adds nothing, and at most 20
  visits per tab and 60 in total per rolling minute are written (`LIBRARY_LIMITS`; the rest are dropped and counted,
  §1.2 rule 8). `tab.title` updates the newest visit of that URL. No visits while `browser.history.enabled` is off.
- `tab.loaded` ends a navigation; a navigation that turns into a download ends with `tab.loading {loading: false}`
  and `download.started`, never `tab.loaded` **[proven]** (§6.9).

### 6.2 Engines and controlled fallback

- `EngineSettings.engine` comes from `engineChoice()` (§4): `auto` = Scramjet first with controlled fallback; a
  forced engine (the user's choice, or Ultraviolet as the operator's default) has no automatic fallback. A tab stays
  on the engine it uses until the next user navigation.
- **Controlled fallback [proven]**: on an *engine-level* failure of a Scramjet navigation (the `error.request` hook or
  the navigation timeout; never an HTTP 4xx/5xx page of the site, and a frame that left the proxy origin is a final
  `engine` error) the engine host retries the **same destination once** on Ultraviolet, if `autoFallback` is on, the
  engine was not forced, UV is ready and the navigation is **idempotent (GET or HEAD)**. Before the retry it copies
  the destination site's Scramjet cookies (HttpOnly included) into UV's jar. It emits
  `tab.engineSwitched {reason: 'error-hook' | 'timeout'}`. A failed POST (or any other non-idempotent) navigation is
  never re-sent: `tab.error {fallback: 'available', idempotent: false}`. The error hook fails the navigation
  synchronously (a deferred call let Scramjet's substitute page commit first). The per-tab attempt counter is reset
  only by a user-initiated navigation, which goes back to Scramjet. A navigation that became a download (§6.9) or got
  a `204`/`205` never triggers the fallback.
- Scramjet failing to initialize (bad wasm, transport, `controller.wait()` timeout) **[proven]**: every navigation goes
  to UV. v1 adds one `tab.engineSwitched {reason: 'init-failed'}` per tab, on its first such navigation
  (`engine-host/tabs.ts`) **[proven]** (`host-fallback fallback:init-failed`: gnome-server restarted on a copy of the
  build whose `scramjet.wasm` is corrupt; Scramjet `failed` with "scramjet.wasm is missing or corrupt", UV `ready`, two
  tabs and three navigations all on UV, exactly one switch event per tab carrying its first navigation's `navId`, both
  browsers, integration part 2).
- The rows of step 2 (`host-fallback`: error hook → Ultraviolet with the same navId and the cookies including
  HttpOnly, the next user navigation back on Scramjet, POST not retried, 404 not a failure, timeout → Ultraviolet →
  `timeout` with `fallback: 'attempted'`) repeat the spike's fallback results on the built engine host.
- After a transport recovery, the engine host retries the last failed GET navigation of each tab once **[unproven]**.

### 6.3 New tabs and popups: `tab.openRequest`

`tab.openRequest` is the **only** way a page opens a tab or popup. The engine iframe has no `allow-popups`, so the
browser itself opens nothing (**[proven]**: `window.open` returns `null` in Chromium and throws in Firefox). The engine
host routes, in every proxied document **[proven]** (`host-popups popups:routing`: `window.open` with and without
activation, a features string, `about:blank`, `target=_blank` and named targets, middle and Ctrl clicks, GET and POST
forms, `window.close`; `tab.openRequest` is the only result, no page appears in the browser context, `window.open`
returns `null` to the page). Every function GNOME installs for this in a page realm is a page-realm callable
(`src/engine-host/realm.ts`, §6.15):

- `window.open(url, …)` → returns `null` to the page and emits `openRequest` with `disposition: 'popup'` when a
  features string asks for a window, else `foreground`. An empty or `about:blank` URL opens nothing (flows that script
  a blank popup, and anything that needs `window.opener`, such as some OAuth or payment sign-ins, must use a
  full-page redirect; decisions log 2026-11-11).
- Links and `<area>` with `target` `_blank` or a name that is not a frame of the tab, and middle/Ctrl/Cmd/Shift-clicks
  on links → the default is prevented; `disposition` `background` for middle/Ctrl/Cmd clicks, else `foreground`.
- GET forms with such a target → the submission URL as above. POST forms with such a target are submitted in the same
  tab (a POST cannot be reproduced in another tab).
- Targets the sandbox refuses or the engines rewrite (`_top`, `_parent`, `<base target>`, `form.submit()`, a sibling
  frame of the tab): the engine host navigates the target frame itself (`host-popups popups:targets`). A POST with
  files that targets another frame is submitted in its own frame instead of being replayed there.
- `userActivation` = the page's `navigator.userActivation.isActive` (read with the engine-host realm's native getter)
  at that moment.

The app decides with `decideOpen` (site-rules.ts). A **gesture** needs both the engine host's claim
(`userActivation`) and transient activation of the app's own document (`navigator.userActivation.isActive` there),
which a real click or key press in the frame gives it, because activation propagates to ancestor documents
**[proven]** in both browsers (`shell-activation`, 14/14 per browser: clicks and keys in the tab frame, a nested
same-origin frame and a nested cross-site frame; `host-popups popups:routing` records claim and app activation both
true after a real click, both false for a timer's `window.open`). The claim alone never counts (a page built to
attack GNOME can make the engine host claim anything),
and a browser without `navigator.userActivation` gives no gesture (fail closed). One click opens one tab: a browser
lets one activation open one pop-up, but the app cannot see clicks inside the engine iframe and its own activation
lasts seconds, so after a gesture-backed open the same tab's next open within 1 s (`GESTURE_OPEN_WINDOW_MS`) counts as
having no gesture, and an open over the `tab.openRequest` rate limit is not dropped silently but listed in the pop-up
indicator (security review, integration part 2: one click with four `window.open` calls opened three GNOME tabs;
`browser.test.ts`, `shell-input` "one click with four window.open calls opens one GNOME tab"). With a gesture the tab
opens in front, in the background for `background` or when `browser.openLinksInBackground` is on. Either way its
first load carries the opener (`start.opener`, §6.1). Without one, the opener
site's `popups` permission decides: allow → a background tab; block (the default) → the "pop-up blocked" indicator in
the toolbar, from which the user can open it; ask → the indicator with Allow / Block for the site. The app keeps at
most `LIMITS.maxTabs` (500) GNOME tabs per app page and refuses more with a notice. Because popups are blocked by
default, the propagation was the first thing lane c tested in both browsers (it holds, so the rule stands).
`window.close()` becomes `tab.closeRequest` (§5) **[proven]** (`host-popups popups:routing`). The app side (gesture,
indicator, `decideOpen`) is covered by `shell-input`. An event-driven open never starts an interactive ticket mint:
only the indicator's button (GNOME's own UI) may (§1.2 rule 9).

### 6.4 Errors

`kind` (`TabErrorKind`): `network` (the destination could not be reached), `timeout` (no document in 20 s), `engine`
(the engine failed: error hook without a network signature, UV error page, the frame left the proxy origin, no engine
ready), `gateway` (GNOME's gateway or a custom Wisp server refused or is down: the transport was offline when the
navigation failed), `offline` (`navigator.onLine` is false), `blocked` (the content blocker blocked the document, Wave B
step 3).

**DNS and TLS failures are not separate kinds in v1**: HolyWisp's CLOSE reasons are not surfaced by any transport, so
a DNS failure arrives as "code 7 Could not connect", "code 35 SSL connect error" or a hyper `UnexpectedEof … tls`
**[proven]**; all are `network`, and `detail` keeps the transport's words (sanitized). The app derives "VPN location
down" itself (route `profile`, kind `gateway`/`network`, and that location `down` in `/api/vpn/locations`).

`fallback`: `none` (no other engine), `attempted` (this error is the retry's), `available` (the other engine is ready
and was not tried, also for non-idempotent navigations). `signal` says what fired (`error-hook`, `timeout`,
`uv-error-page`, `frame-left-proxy`, `engine-unavailable`, `fallback-failed`, `blocked`) for diagnostics.

The app shows its own error overlay (never the engine's page) with **Retry** (`tab.navigate` to the same URL; for
`idempotent: false` it warns that the form will not be sent again) and, for `available`, **Open in <other engine>**
(`tab.navigate` with `engine`). This holds for navigations started in the page too (§6.1: every load of a tab frame is
classified). HTTP error pages of sites are not errors: they render. The last error of a tab is also in `tab.state`
(`error`), so an overlay is restored after the app missed the event.

### 6.5 Tickets

- At startup the app calls `POST /api/wisp/ticket` and sends the ticket in `init` (null if it could not get one:
  `needTicket {reason: 'missing'}` follows). It converts the answer into `Ticket`: `value` = `ticket`, `wispUrl` =
  `wisp_url`, and `expiresAt` = `ticketExpiresAtLocal(expires_at, <Date header>, Date.now(), wisp.ticket_ttl_s · 1000)`:
  the remaining life is measured against the server's clock (the response's `Date` header), so a device clock that is
  minutes off does not make every ticket look expired (or eternal); without a usable `Date` header the local clock is
  used, and the life is capped at the configured TTL. **[unproven]** with a real skewed clock (unit-tested both ways).
- **Proactive renewal**: the engine host emits `needTicket {reason: 'expiring'}` after
  `ticketRenewDelayMs(receivedAt, expiresAt)`: 80 % of the ticket's remaining life (48 min for the default 1 h TTL,
  48 s for the minimum 60 s), never sooner than 10 s, also for a ticket that arrived already expired, so renewals
  cannot loop (a dead ticket is caught by the next probe's 401). **[proven]**: renewal before expiry (the spike used a
  fixed 5-minute margin, which at a 60 s TTL fired at once; its app then dropped the request and nothing renewed the
  ticket, spike §12). **[proven]**: the 80 % rule (`transport renewal` "TTL 60 s: needTicket{expiring} at 80 % of the
  life; lazy renewal per kind; pages load"). The 10 s floor is unit-tested only (`ticketRenewDelayMs`).
- **Rejected [proven]**: when a probe answers 401 (`wisp_ticket_*`) the engine host emits
  `needTicket {reason: 'rejected'}`.
- The app requests at most one ticket per 2 s and 10 per minute (the server allows 30 per minute per session) and
  answers with the `ticket` command. A `needTicket` that arrives inside those limits is **deferred and coalesced**
  with any pending one, never dropped: with a 60 s TTL the spike's app dropped the request and nothing renewed the
  ticket until a connection failed (spike §12). A `429` from the ticket endpoint waits its `Retry-After`.
- **No credential prompt from an event** (§1.2 rule 9): a mint started by an engine event (`needTicket`, or a `status`
  with `ticket-missing`) never opens the sign-in or access-code dialog, and never runs a prompting `ensureSession()`.
  When it answers `login_required` or `access_code_required`, the transports stay offline (`ticket-missing` /
  `ticket-rejected`) and the browser view shows a passive notice ("Sign in to keep browsing" with a button). Only that
  button, or a navigation the user starts in GNOME's own UI (address bar, bookmark, Retry), opens the dialog; the
  mint that follows is user-initiated. **[proven]** in `code` and `accounts` modes (`shell-settings`: a session
  restore shows only the passive notice and only its button opens the dialog). Deferral and coalescing of
  `needTicket` at a 60 s TTL are unit-tested only (lane c).
- **Lazy renewal [proven]**: tickets are checked only at the upgrade, so the `ticket` command rebuilds libcurl
  transports (they reconnect with the URL they were built with) and anything not `ready`; a healthy epoxy transport
  keeps its socket and uses the new ticket at its next rebuild.

### 6.6 Transport status

`TransportStatus {state, transport, endpoint, detail, since, retryInMs}` per engine:

| `state` / `detail` | Meaning (transport.ts RECOVERY) | App shows |
| --- | --- | --- |
| `connecting` / `rebuilding` | building or rebuilding (one queue; `init()` before use) | spinner on the engine badge |
| `ready` / null | the transport is built and nothing is known to be wrong: no socket failed since the last build, or the last socket opened. Sockets open on demand, so an idle side is `ready` (not `connecting`). A custom server gets one test socket before its transport is built (the first server in order whose socket opens is used; integration part 2), so a dead server, or one the page's policy refuses, is skipped before a page needs it | nothing |
| `degraded` / null | a socket dropped or failed to open; recovery is running | nothing until a navigation fails |
| `offline` / `ticket-missing` | no ticket (init without one) | the passive sign-in / access-code notice (§6.5) |
| `offline` / `ticket-rejected` | the probe answered 401; waiting for a new ticket | "Reconnecting…", then the passive notice if minting fails |
| `offline` / `gateway-unreachable` | the probe failed at the network level (or a custom server does not answer); backing off 250 ms·2ⁿ ±50 %, ≤ 30 s, 12 attempts, then every 60 s | "GNOME's server is unreachable" with `retryInMs` |
| `offline` / `upstream-unreachable` | the gateway's upstream (HolyWisp, or the VPN location's instance) is down: the probe answered `503 wisp_upstream_unavailable` (the server's health job has it down; next probe after `Retry-After`), or it answered 426 and the socket then did not open (the probe never contacts the upstream); never a rebuild after every 426 | "GNOME's proxy service is down" (route `profile`: "this VPN location is down", from `/api/vpn/locations`) |
| `offline` / `unknown-profile` | the probe answered 404: the route names a VPN profile the server no longer has | the app refreshes `/api/config` and chooses the route again: with the kill switch on it never falls back to `default`, the VPN status says the location is no longer offered |
| `offline` / `rate-limited` | the probe answered 429 (shares the 60/min upgrade budget); waiting `Retry-After` | "Too many connections, retrying in …" |
| `offline` / `rebuild-limit` | more than 6 rebuilds of this side in a minute | "Connection unstable, retrying in …" |

`endpoint`: `default`, `profile` or `custom`. **[proven]** against the gateway stub: libcurl reconnects by itself after
a drop with its old URL; epoxy never reconnects and is rebuilt after a 426 probe; a 401 leads to a new ticket; drops,
gateway restarts, rotation and proactive/lazy renewal all recovered with the four engine × transport combinations.
**[proven]** against the real gnome-server (spike §12): `?t=<ticket>&/` and `?t=<ticket>/` with all four, the probe's
426/401, a rate-limited probe's `429` + `Retry-After`, a connection outliving its ticket, a `426` probe followed by a
`502` upgrade when the route's HolyWisp is down. **[proven]** in Wave B step 2 on the built engine host (`transport`):
the probe classes 426/401/404 (`probe`), drops and gateway restarts (`drop`), a forged ticket → 401 →
`needTicket {rejected}` → a new ticket (`rejected`), the engine host's handling of `upstream-unreachable` (`upstream`:
a VPN profile whose HolyWisp is down reports it with a backoff and no rebuild loop, and recovers when it starts
again), of `429` (`ratelimit`: `rate-limited` with `retryInMs` from `Retry-After`, never `ticket-rejected`), and the
classification of `unknown-profile` (`probe`; the app's route change after it is unit-tested only); sockets stay under the per-session cap after renewals (`cap`); custom external servers
behind the opt-in with failover from a dead first server (`custom`, §2.1). A socket the page's policy refuses counts
as a failed open in both taps (Firefox throws `NS_ERROR_CONTENT_BLOCKED` from the `WebSocket` constructor, Chromium
fires `error` and no `close`; until integration part 2 neither reached the watchdog, so a UV side stayed `ready` and
never failed over: `transport custom`, `shared-uv.test.ts`, `window-tap.test.ts`). The probe's `503 wisp_upstream_unavailable`
with `Retry-After: 10` (`backend-proxy probe`: a same-origin fetch from the engine-host document reads the status,
the header and `error.code`; a bad ticket still gets its 401 first, the healthy route 426); the side then waits out
`Retry-After` before its next probe, also when a navigation fails meanwhile (exactly one probe per 10 s window,
`transport upstream`). **[unproven]**: the rebuild cap (`rebuild-limit`) and the 60 s idle retry (unit-tested only).

**One Ultraviolet transport per proxy origin.** Every engine host of the browser (one per GNOME tab) shares
bare-mux's single SharedWorker, so the UV pages of every GNOME tab use the transport the last `setManualTransport()`
installed (Scramjet's transport lives in each engine host's own realm). The rules (`uvTransportAction`,
transport.ts): a manager installs the shared transport at start when the worker runs nothing or another route or
kind, on `settings` when its route or kind changed, and to rebuild one of its own route and kind (or into an empty
worker); it never replaces a transport of another route because a check found it different. The app syncs settings
across its tabs (its own BroadcastChannel on the app origin), so every GNOME tab converges on the newest route, and a
GNOME tab whose settings are a moment old cannot undo a VPN or kill-switch change made in another. The UV socket tap
reports to **every** engine host, not only the one that installed the transport (lane b: through the SW's
`Client.postMessage`, or one tap port per engine host), so the UV watchdog keeps working after that GNOME tab closes;
any engine host then rebuilds with its own ticket. **[proven]** (`transport shared`): two GNOME tabs with UV traffic at
the same time (one transport name), a settings change in one of them installs its transport and the other's next
navigation leaves it in place, and after the installing tab closed and the Wisp socket dropped UV recovers in the
other tab. The rebuild branch that keeps a newer route (a probe after a drop with an older key) is unit-tested only.

**The lock** (lane b). bare-mux accepts transport code from any port that connects to its worker, and Ultraviolet does
not wrap `SharedWorker`, so before step 2's fix an ordinary UV page could send bare-mux's own `set` message with a
port of its own and receive every later UV request of every GNOME tab. GNOME's install code now wraps bare-mux's
`onconnect`: a port that connects later may `set` only code that starts with a per-origin secret marker, which the
engine hosts keep in their own `localStorage` under `gnome-uv-transport-lock` (the `gnome-` prefix keeps it out of
site-data clearing); a refused `set` rejects `setManualTransport`, and a host that lost a first-use race retries
with the stored value (`transport lock`: refused, nothing intercepted, the next UV page loads, both transports, both
browsers). What remains (§1.1 B8): a page can still read the transport's name and use it as UV does, and a page that
reaches the engine host (`borrow-natives`) can read the secret. If the browser's site data is cleared while GNOME
tabs keep the worker alive, new engine hosts create a new secret and their installs are refused until every GNOME
tab is closed (not tested).

### 6.7 Keyboard shortcuts

`EngineSettings.keys.combos` are the bound combos of `browser.shortcuts` in canonical form (`src/lib/keys.ts`
`normalizeCombo`, e.g. `Alt+T`, `Mod+F`; each sent once), `keys.apple` the platform. In every proxied document (at any
nesting depth) the engine host listens to trusted `keydown` events in the capture phase and matches them with the
**same** `src/lib/keys.ts` functions the shell uses (`parseCombo`, `matchCombo`: layout-independent letters and digits
from `KeyboardEvent.code`; combos that edit text, `isTextEditingCombo`, are skipped while the target is editable;
composing input is ignored). A match is prevented in the frame and sent as
`tab.key {combo: <the string the app sent>, repeat}`.

The app runs the shortcut bound to that combo only if the combo is one it sent, the tab is the active tab and the
browser view is visible (`dispatchForwardedShortcut`). A forged `tab.key` is possible from a page that reaches the engine host (§1.1), so forwarded
shortcuts come in two classes (lane c's table in `src/app/shortcuts.ts`; every `ShortcutAction` is in exactly one,
and a new action is privileged until classified):

- **Ordinary** (they act on the active tab or the view and leave nothing behind): `reload`, `hardReload`, `back`,
  `forward`, `home`, `nextTab`, `prevTab`, `selectTab1`…`selectTab9`, `findInPage`, `zoomIn`, `zoomOut`, `zoomReset`,
  `toggleSidebar`. They run like shortcuts pressed in the shell.
- **Privileged** (they open or close tabs, change what persists, open GNOME UI or move the focus into it):
  `newTab`, `duplicateTab`, `reopenClosedTab`, `closeTab`, `pinTab`, `bookmarkPage`, `toggleFullscreen`,
  `focusOmnibox` (a forged one would steal what the user types for the page into the address bar, whose text can go
  to `suggest`), `openHistory`, `openBookmarks`, `openDownloads`, `openSettings`, `openGames`, `commandPalette`.
  They run only while the app document has transient user activation (a real key press in the frame gives it,
  activation propagates to ancestors) and at most `FORWARDED_PRIVILEGED_LIMIT` (2 at once, then 1 per second);
  refused ones are counted. `closeTab` closes only the active tab (undo: `reopenClosedTab`), `bookmarkPage` opens the
  bookmark editor (the user confirms) instead of saving silently, and no shortcut creates a tab beyond
  `LIMITS.maxTabs`.

**[proven]**: forwarding from top, same-site and cross-site nested proxied frames (Alt+T, Ctrl+Shift+K, F6), typing not
forwarded, layout-independent letters; from step 2, matching with `src/lib/keys.ts` and the editable rule
(`host-input keys:forwarded-top-nested-editable`, from the top document and a nested frame), activation reaching
the app document (`shell-activation`, §6.3) and the ordinary and privileged classes with real input
(`shell-input`). **[unproven]**: the active-tab rule (unit-tested only). A handler that runs for a forwarded key
never starts an interactive ticket mint (`isForwardedDispatch()` in `src/app/shortcuts.ts`): a forwarded `home` or
`newTab` set to an address loads it with a non-interactive mint (the passive notice at most), never the access-code
dialog (§1.2 rule 9; unit-tested).

### 6.8 Context menus

On `contextmenu` in a proxied document (any depth) the engine host prevents the browser's menu (Shift+right-click keeps
it) and sends `tab.contextMenu` with `x`/`y` in **engine-host viewport CSS pixels**: the event's client coordinates
plus the offsets of every frame up to the engine host, multiplied by the tab's zoom factor (§6.10), rounded and clamped
with `fitInt` (the validator accepts integers only). The app adds the engine iframe's bounding-rect offset and clamps
the menu to the content area. `target.kind`: `link`, `image`, `editable`, `selection` or `page`, with
`linkUrl`/`srcUrl` decoded to real URLs (http(s) only; anything else is null) and `selectionText`, cut to 100 000
characters with `selectionTruncated: true` when it was longer. **[proven]**: link targets and coordinates from a
nested frame in both engines; from step 2 every kind, integer coordinates at the click position, truncation over
100 000 characters and Shift+right-click (`host-input context-menu:kinds-coordinates-truncation`), and the zoom
factor (`host-capabilities capability:zoom`: coordinates scaled at zoom 2). GNOME's menu and its items:
`shell-input`.

Items (each a click in the app's own menu): link → Open in new tab / in background tab (the app opens it), Copy link
address (the app writes the clipboard), Save link as (`tab.download {kind: 'link'}`), Bookmark link; image → Open
image in new tab, Copy image address, Save image as (`tab.download {kind: 'image'}`); selection → Copy (the app copies
`selectionText`; not offered when `selectionTruncated`, because it would copy a prefix: the page's own copy, with
Shift+right-click, still works), Search for "…"; page → Back, Forward, Reload (`tab.go`, `tab.reload`), Select all
(`tab.action selectAll`), Print (`tab.action print`), Bookmark page; editable → only what the app can do itself (the
browser's own menu, with Shift, has cut/copy/paste). Items whose capability is missing are not shown.

### 6.9 Downloads

- The browser's own download manager saves them (the engine iframe has `allow-downloads`), from proxied URLs that work
  only while the engine host lives **[proven]**. GNOME **cannot cancel or pause** a download (no `download.cancel`).
- **What counts as a download** (`downloadDisposition` in proxy-origin.ts; the Scramjet tap and the SW's UV tap use
  the same rule): a response to a navigation request (`mode: 'navigate'`: the tab frame or a nested frame) that has
  `Content-Disposition: attachment` (`attachment`) or a MIME type browsers do not render in a frame (`unrendered-type`:
  anything outside `INLINE_DOCUMENT_TYPES`, `audio/*` and `video/*`, e.g. a zip sent without the header), and every
  download request (`<a download>`). A page's own `fetch`/XHR is never a download: the page reads it. **[proven]**:
  attachments via link and via navigation; from step 2, `unrendered-type` (`host-downloads
  downloads:zip-without-disposition`, via a link and a navigation: exactly one request, no error, no fallback, no
  `tab.loaded`) and `<a download>` (`downloads:a-download`: the file name of the attribute, the tab's document stays;
  the browser saves the file in Firefox too only since integration part 2's `blob:` in the app's `frame-src`, see
  "Save link/image as" below),
  both engines. **[unproven]**: PDF shown inline in proxied frames.
- An `attachment` navigation ends as a download at once: `tab.loading {loading: false}`, `download.started`, no
  navigation timeout, no fallback, never `tab.loaded`. An `unrendered-type` navigation stops the timer and the fallback
  at once; if no document commits for it within `TIMEOUTS.downloadCommitMs` (2 s) it is reported as a download, and if
  one commits the browser rendered it after all. Either way the destination is requested exactly once. An
  `<a download>` request leaves the tab's navigation state alone (its document stays).
- Events: `download.started {downloadId, tabId, url, filename, mime, total, engine}` (`filename` from
  `downloadFilename`: RFC 6266 `filename*`, else `filename`, else the URL's last path segment, never with a path; the
  browser saves the file under the same name: for a Scramjet navigation download whose `Content-Disposition` names no
  file, the per-tab plugin adds one (`downloads.ts` `namedDisposition`: the attachment keeps its type, an unrendered
  type gets `inline` with the name), because the browser otherwise names the file after the encoded proxied URL
  (`https___proof.ovh.net_files_1Mb.dat`; integration part 2, **[proven]**: `host-downloads` checks the name the browser
  saved under in every row, both engines, both browsers);
  `mime` the bare lower-case type; `total` from `Content-Length` or null); `download.progress` coalesced to at most
  every 200 ms; `download.done` with `completed` when the stream ends, `failed` when it errors and `cancelled` when the
  browser cancels it (**[unproven]**: the last two, unit-tested in the SW tap only). **[proven]**: started, progress
  (2 MiB, 7 events) and completed, via link and via navigation, both engines; for UV, `download.done.received` is the
  SW's own final byte count (`sw download`: 2,097,152 of 2,097,152; `library-visits`: a 21,456,836-byte zip complete
  in both browsers and both transports). A download that ends right after it starts is not lost (`library-visits`
  tiny download, every engine × browser).
- **Which tab.** Scramjet: exact (the tab frame's own plugin sees the response). Ultraviolet: the SW cannot tell tabs
  apart, so it sends `uv-download {phase: 'started', url, referrer, clientUrl, navigation, disposition, …}` to every
  engine-host client, and an engine host claims it for one of its own tabs only on an exact match, in this order:
  (1) `navigation` and a pending navigation of the tab to that URL (GNOME-initiated or started in the page, §6.1);
  (2) the decoded `clientUrl` is the URL of a document in the tab's frame tree; (3) the decoded `referrer` is.
  Without a match it ignores the signal (another GNOME tab may own it): the browser still downloads the file and
  GNOME does not list it. So under `Referrer-Policy: no-referrer` (or a `rel=noreferrer` link) a UV download behind a
  redirect can go unlisted, and two GNOME tabs that show the same URL can both list one. **[proven]**: the referrer
  match for links (spike); a link on a `Referrer-Policy: no-referrer` page (`host-downloads downloads:no-referrer-page`,
  both engines). **[unproven]**: which of the three rules claimed it in each row (the rows check the outcome), and the
  redirect case.
- Not observed at all: downloads of `blob:` and `data:` URLs a page builds itself (they never pass an engine;
  `download.started.url` is always http(s)) and downloads started by escaped code.
- GNOME's list is the app's (`DownloadStore`, browser-data.ts), capped per engine-host instance (`LIBRARY_LIMITS`: 20
  unfinished, 200 in total): beyond the cap a download is not listed (the browser still saves it) and its later events
  are dropped without being counted. Download ids restart with every engine host; after an engine-host reload the app
  marks that instance's unfinished downloads `untracked` (the browser finishes them; its own downloads list has the
  outcome).
- **"Save link/image as"** (`tab.download`, capabilities `saveLink`/`saveImage`) downloads a URL in the tab's context
  (with that site's cookies, the tab's page as initiator, §6.1): the engine host fetches it and saves it as a blob
  download (`<a download>` of a `blob:` URL in the engine-host document). **[proven]** in both browsers with both
  engines since integration part 2 (`host-capabilities capability:saveLink + saveImage`: the file byte-exact, one
  request; `shell-capabilities` "Save link as… from GNOME's link menu"). Until then Firefox saved nothing
  (`download.*` events arrived, no file) and the capabilities were not offered: Firefox checks the engine host's blob
  download as a navigation of the engine iframe against the **app's** `frame-src`, which had no `blob:` (console:
  "blocked the loading of a resource (frame-src) at blob:…"; it was not, as assumed, the missing activation). The same
  refusal had stopped every `<a download>` of a page in Firefox (`downloads:a-download` read the previous row's file
  of the same size and passed); gnome-server's shell policy now lists `blob:` (§1.1).

### 6.10 Find, zoom, fullscreen, print

- **Find [proven]** (also `host-input find:nested-next-previous-clear`): the engine host searches the tab's
  same-origin proxied documents (nested frames included), reading them with its own realm's native DOM functions and
  no callback the page could receive nodes through, and highlights with the CSS Custom Highlight API in the page
  realm's own registry with a page-realm `Highlight` (`realm.ts` `PageKit.highlight`; `highlights: false` where it is
  missing); the same query moves to the next/previous match; case-sensitive search; `tab.findClear` removes the
  highlights. Limits: at most 1000 matches (`capped`), frames that escaped to a real cross-origin URL and shadow roots
  are not searched, and the page can see the highlight names and the injected style (spike §7.9).
- **Zoom [proven]** (capability `zoom`, `host-capabilities capability:zoom`: the page lays out like browser zoom,
  kept across navigations; the app side with `browser.defaultZoom`: `shell-capabilities`, `shell-input`): per tab,
  applied to the tab iframe (CSS transform plus inverse width/height, so escaped or non-HTML documents zoom too). The
  app owns the zoom levels (`browser.defaultZoom`, per-site memory if it keeps one) and sends `tab.zoom` after
  `tab.create`/navigation as needed.
- **Fullscreen [proven]**: a page's `requestFullscreen()`, also from same-site and cross-site nested frames, works
  (the engine iframe and the tab iframes have `allow="fullscreen"`) and is reported as `tab.fullscreen`; the app sees
  the engine iframe as its fullscreen element. Blocking it per site: §6.14.
- **Print, select all** (capabilities `print`, `selectAll`): `print()` / select-all on the tab's top document.
  Select all **[proven]** (`host-capabilities capability:selectAll`; GNOME's menu item: `shell-capabilities`). Print
  is reported, but proven only headless (`host-capabilities capability:print`): headless Chromium has no print
  dialog (only `beforeprint` fires, then the engine host keeps answering), and headless Firefox's `print()` never
  returns, so the Firefox row prints silently to a PDF (`beforeprint`, `afterprint`, a PDF written). The real dialog
  in a headed browser is not tested. In Firefox `print()` is modal for the whole content process, and the engine host
  is same-site with the app, so GNOME's own UI is frozen while the print dialog is open.

### 6.11 Cookies and site data [proven]

`host-capabilities capability:cookies` (list over both jars with HttpOnly flagged, delete by name, by site, all) and
`capability:siteData.clear`; the app side (`shell-capabilities`: Settings → Clear data → "Cookies and site data"
removes both jars' cookies, HttpOnly included) and `init.clearOnStart.cookies` at a fresh start (`shell-settings`
"clear cookies when GNOME closes": both jars, HttpOnly too, kept when the setting is off). A browser that restores
its session also restores the app's `sessionStorage` marker, so a restored GNOME tab never sees a fresh start and
clear-on-exit does not run there; Settings says "the next time GNOME starts in a new browser tab".

Capability `cookies`: `cookies.list` reads both engines' jars (Scramjet: `controller.cookieJar`; UV: the `__op`
IndexedDB `cookies` store) and returns metadata only (`size` instead of the value). `cookies.delete` edits both jars
(Scramjet: dump, filter, load, `persistCookies()`). The app groups by registrable domain for the cookie manager.
Capability `siteData`: `siteData.clear` clears, for every proxied site, the listed kinds (`cookies`; `storage` =
proxied sites' localStorage, IndexedDB and Cache Storage, never the engine host's own databases; `cache` = engine
caches). "Clear … when GNOME closes" (`browser.cookies.clearOnExit`, `privacy.clearSiteDataOnExit`) is applied at the
next start of GNOME in a new browser tab, through `init.clearOnStart`, when no other GNOME tab is open (WAVE-B lane c);
work during page unload does not finish reliably.

### 6.12 Search suggestions [proven]

`host-capabilities capability:suggest <provider>`: every provider of the engine host's endpoint table (`suggest.ts`,
checked against the live providers: 6) answers through `proxyFetch` with no direct request, over libcurl and epoxy,
in both browsers; the omnibox shows them (`shell-capabilities`). The JS transports send `navigator.userAgent`, and
headless Chromium's `HeadlessChrome` agent gets 429 from Brave and 302 from Startpage (only an e2e concern).

Capability `suggest`, only while `browser.searchSuggestions` is on and only for input that is not a URL: the app
debounces (150 ms, at most 5 per second) and sends `suggest {query, provider}` (`browser.searchEngine`; no suggestions
for `custom`). The engine host fetches the provider's OpenSearch suggestion endpoint with `TransportManager.proxyFetch`
(through Wisp, without cookies or engines) and returns at most 10 strings; the app validates them again and shows them
as text. The engine host owns the endpoint table and must verify each endpoint.

### 6.13 VPN exit check

**[proven]** against `am.i.mullvad.net` through the default route (`host-capabilities capability:vpn.verify`, libcurl
and epoxy, both browsers; the machine's IP is kept out of the results). **[unproven]** through a real VPN tunnel
(Wave C, with an operator's account).

Capability `vpnVerify`: `vpn.verify {url}` with `/api/vpn/locations` → `verify_url` (`https://am.i.mullvad.net/json`)
fetches it through the current route with `proxyFetch` and returns `{ip, country, city, vpnExit, checkedAt}`
(`vpnExit` from `mullvad_exit_ip`, null when the service does not say). **The answer is not proof** (§1.2 rule 3):
a page that reaches the engine host (§1.1) can forge all of it, and the validator checks only its shape. The VPN page (Wave C) shows it
as what the check service reports ("The check service sees 185.… in Sweden"), never as a security badge, and takes
"VPN active" from the app's own facts: the route it chose is that location's profile, and `/api/vpn/locations` (app
origin) has the location `up`.

### 6.14 Permissions

| Permission | v1 |
| --- | --- |
| camera, microphone, geolocation, notifications | never available to proxied pages: not delegated to the engine iframe (the grant would belong to the proxy origin, i.e. to every proxied site at once). Settings shows them as unavailable |
| popups | decided by the app for `tab.openRequest` (§6.3): ask / allow / block |
| autoplay, fullscreen, clipboard (write) | enforced (where the browser can: autoplay and fullscreen in Chromium, fullscreen in Firefox, clipboard nowhere; below) by the engine host through each tab iframe's `allow` attribute (`tabFrameAllow`), set before every GNOME-initiated load from the decisions that come with the command (`permissions` of `tab.create`/`navigate`/`go`/`reload`); allow / block. The app resolves the user's settings itself (`resolveEnginePermissions`, `enginePermissionsFor` for the destination) and never sends the per-site list (§1.2 rules 4–5). A stored `ask` means block for autoplay and allow for fullscreen and clipboard writes (`ENGINE_PERMISSION_ASK`) |

- **`block` is written as `<feature> 'none'`**: a tab frame is same-origin with the engine host, so a feature left out
  of `allow` would still be allowed by its default `'self'` allowlist. For the same reason the engine host lists only
  the features this browser enforces (`engine-host/frame-allow.ts`; Chromium: fullscreen and autoplay): leaving out a
  feature Firefox does not implement changes nothing there and spares a "Feature Policy: Skipping unsupported
  feature name" console warning per tab frame (integration part 2). The app's engine iframe keeps all three in its
  `allow` (§2.1): it is cross-origin from the app, so Chromium needs them delegated, and a Firefox that implements
  them later would need them too; its two Firefox warnings are benign.
- **Per browser**: browsers differ in which features a frame's `allow` attribute can enforce, so
  `InitResult.enforcedPermissions` lists the ones this engine host enforces in this browser, each only after its e2e
  test passes there (WAVE-B lane a). Settings offers allow/block only for those; the others behave as in a normal
  browser (allowed), and `tabFrameAllow` writes them as allowed. The table is `ENFORCED_PERMISSIONS` in
  `shared/site-rules.ts` (with `browserFamily()`), and the app keeps only what its own browser can enforce of the
  engine host's claim (`trustedEnforcedPermissions` in `facts.svelte.ts`, integration part 2): an engine host a page
  controls must not make Settings offer a block the browser ignores. Reported (`host-capabilities permission:<name>
  block → allow` with both engines, and `permission:InitResult.enforcedPermissions lists exactly the permissions
  enforced in this browser`) **[proven]**: Chromium `fullscreen` and `autoplay`, Firefox `fullscreen` only. Firefox 157
  implements neither the autoplay nor the clipboard-write permissions policy (it logs "Skipping unsupported feature
  name" for both; a blocked page still plays and writes). **Clipboard is enforced in no browser** (security review,
  integration part 2): the clipboard row writes from a real click in the frame, both with the asynchronous Clipboard
  API and with `document.execCommand('copy')`, which most sites use; Chromium's `clipboard-write 'none'` refuses only
  the first (`NotAllowedError`), and the second still writes. So no browser reports `clipboard`, Settings shows it as
  "always allowed", and its rows are `expectFail` (a measured limit). Before, Chromium reported it and Settings offered
  a Clipboard Block that a site's ordinary copy button ignored.
- **Not against a page that attacks GNOME**: the engine host holds the delegated features, so a page that reaches it
  (§1.1 `borrow-natives`) can lift any per-site decision for itself.
- **In-page navigations keep the decisions** of the tab's last GNOME-initiated load (a frame's policy is fixed when its
  navigation starts, before the engine host could know the new site): a link from a site where autoplay is blocked to
  one where it is allowed stays blocked until the next GNOME-initiated load (reload, back/forward, address bar). The
  Settings text says "applies to sites you open in GNOME" accordingly. **[unproven]**: all of this row.

There are no engine-side permission prompts in v1 (no `permission.request` / `permission.reply`). Features GNOME never
delegates (WebAuthn, payment, MIDI/USB/serial/HID, screen capture, wake lock, Web Share, XR) are unavailable in proxied
pages; About lists them with the four above.

### 6.15 WebRTC

`privacy.webrtc` (new setting, default `block`; WAVE-B lane c): with `block` the engine host replaces the
`WEBRTC_GLOBALS` constructors (`RTCPeerConnection`, its `webkit`/`moz` aliases, `RTCDataChannel`, `RTCIceCandidate`,
`RTCSessionDescription`) with `undefined` at document start in every proxied window (Scramjet `init.pre`, the UV
document-start hook) and in the engine-host realm. A **child-frame guard** applies the switch to every child realm
before the page can use it: page-realm wrappers of the getters that hand out a child window or document
(`contentWindow`, `contentDocument`) and of the insertion methods (`appendChild` … `replaceChildren`,
`insertAdjacentHTML`, `innerHTML`/`outerHTML` setters, `document.write`, `execCommand`, `Range.insertNode`,
`attachShadow`), per-document page-realm `MutationObserver`s (parser insertions and `srcdoc` writes), a capture-phase
`load` listener per document and shadow root, and sweeps of the child browsing contexts by index; the engine-host
document gets the same recursive guard. Every function the switch installs in a page realm is a page-realm callable
(`src/engine-host/realm.ts`: a Proxy made by that realm's own `Proxy`, its trap compiled with that realm's own
`Function` at document start), so the switch hands no page an engine-host function.

**A change of the setting applies to every document that loads after it** **[proven]** (`host-webrtc
webrtc:switch`: block → `settings` with `allow` → `tab.reload` → `block` → `tab.reload`, both engines, both browsers:
the page's own probe and `typeof RTCPeerConnection` after its load agree; `shell-settings` "WebRTC: blocked by
default, allowed after the switch, blocked again"). A proxied document decides at its start, and its own guard keeps
its decision for its children. The engine-host realm outlives every change: its constructors stay `undefined` once
killed, but its guard follows the live setting (until integration part 2 it killed every later tab document at its
`load`, so `allow` never reached a page once the engine host had started with `block`); a switch back to `block`
also sweeps the open tab documents.

What `block` stops **[proven]** (`host-webrtc`, 0 STUN packets, both engines, both browsers): the page's own realm and
its `about:blank`, `srcdoc` and `innerHTML` children (`webrtc:block:page-and-child-frames`); `srcdoc` written after
insertion, sandboxed `srcdoc` and `data:` frames (`fresh-realms`; UV documents get `FRAME_RESTRICTION_CSP`, no
`data:`/`blob:` frames and no plugins); frames the parser inserts, inline `onload`, `document.write`,
`<object>`/`<embed>` `about:blank` documents, shadow roots, `execCommand('insertHTML')`, `replaceChildren` and, in
Chromium, re-navigation to `about:blank` (`gaps-closed`); the realms escaped code makes with the engine host's own DOM
(`escaped-code-realms`); the engine-host realm itself (`engine-host-realm`); SVG documents, whose scripts do not run at
all (`webrtc:block:svg-document`, see below). Without the switch the same pages reach the STUN sink (the `allow`
rows; 3 packets in Chromium, 4–5 in Firefox in the spike).

What it **cannot** stop (`host-webrtc webrtc:block:gaps-open`, recorded `expectFail`): a page that polls a child frame
(a `MessageChannel` loop) while the frame loads a new proxied document reaches the new realm before the engine's
document-start script has run (both engines, both browsers, 7–15 packets; under UV the hook is an external script, so
an inline one would only shorten the gap); a `javascript:` document runs its script while it is parsed (UV; Scramjet
runs none); Firefox fires the `load` event of a frame re-navigated to `about:blank` after the new realm is already
reachable. A fourth gap is known from code reading only (lane a review; `gaps-open` does not exercise it): a page
that exhausts the stack around an insertion gets a `RangeError` and the frame stays unguarded until the observer
runs. None of these can be closed from page JavaScript, and a page that reaches the engine host
(§1.1 `borrow-natives`) shares the guard's realm. So the switch protects against sites that use WebRTC in the ordinary
way, **not** against a site built to reveal the user's IP address; only connection-level blocking would, which a
website cannot do. Settings and About must not promise more.

**Documents the engines leave unrewritten run no scripts** (`SCRIPTLESS_CSP`, `script-src 'none'`, as a second
policy). Ultraviolet 3.2.10 rewrites only document answers whose `Content-Type` starts with exactly `text/html`, and
Scramjet rewrites only `text/html`, so SVG, XHTML and XML documents, and HTML without a usable `Content-Type` (none
at all, or `Text/HTML`), would run their scripts natively on the proxy origin. The SW adds the policy to every such
frame answer under both engines (Scramjet's own `csp.ts` rule stays; nothing is added twice): **[proven]** (`sw
unrewritten`, six document types × both engines × both browsers; a `+xml` type is downloaded in Chromium or rendered
without a script). Pages that rely on scripts in such documents break: a known limitation About lists. `allow` keeps
WebRTC working and Settings must say that it sends traffic directly, outside GNOME, revealing the user's IP address.
With `vpn.mode: 'gateway'` and `vpn.killSwitch` on, the app always sends `block`.

### 6.16 GNOME's CSP and blocked direct connections

Every proxied response with a navigable destination (`document`, `iframe`, `frame`, `object`, `embed`; any content
type) and every proxied worker script carries `PROXIED_DOCUMENT_CSP` (`proxy-origin.ts`), hard-wired: no runtime or
settings switch. It turns the engines' CSS-rewriting gaps into blocked loads **[proven]** for `document`/`iframe`
HTML and workers (0 native requests in the 53-construct lab, no regression in the 30-check probe, 8 real sites
unchanged except Wikipedia's 7 icons; `host-leak probe` repeats the probe on the built engine host: no check fails
beyond the engines' own limits, both engines, both browsers, since integration part 2 gave `connect-src` `blob:` in
this policy and in the engine host's, because the engines resolve a page's `blob:` URLs by fetching them in the SW
(Ultraviolet) or the engine host (Scramjet), and a `blob:` URL never leaves the browser; before, a page's `blob:` images,
workers and `fetch(blob:)` failed); and from step 2 for `frame` (`host-csp csp:frame (frameset)`; the SW shows
`<frame>` loads to both engines as `iframe` loads, because neither engine rewrites destination `frame`, whose
documents otherwise loaded raw with the engine host two parents up: `sw frames`), for SVG documents (`host-csp
csp:svg-document`: no construct reaches the network, and their scripts do not run, §6.15) and for the documents
`host-csp csp:document-iframe-object-embed` loads (0 native requests). `<object>`/`<embed>` of a proxied URL never
get proxied content: browsers do not pass plugin loads through a service worker, so they reach gnome-server's
engine-prefix `503` page and its strict policy under both engines and run no native script (`sw object`); proxied
HTML inside `<object>`/`<embed>` therefore does not load. Under UV, a `SharedWorker` started with a proxied URL is
refused with a `403` (UV serves shared-worker scripts unrewritten, which gave a native worker with the proxy origin's
IndexedDB, i.e. every engine's cookie jar): sites lose `SharedWorker` under UV (`sw sharedworker`, its UV row);
that Scramjet rewrites them is **[unproven]**: only Chromium shows it (`sw sharedworker`: the worker's `location` is
the site's real URL and its fetch reaches the site through the engine); in Firefox the shared worker never answers,
like Scramjet's other URL workers there (a known limit, `expectFail`). The engine-host document has its own policy
(`engineHostCsp`, **[proven]**: both engines run under it, `host-smoke` and every host row; `blob:` in its `connect-src`
since integration part 2, see above).
Browsers never route plugin loads through a service worker, so `object`/`embed` matter only to Scramjet's window-side
plugin; an `<object>`/`<embed>` of a proxied URL gets gnome-server's engine-prefix 503 page and its strict policy.

The other proxy-origin answers are no permissive realm either (escaped code can open any of them in a frame or run a
script as a worker). gnome-server sends the contract's functions, and a cargo test compares its policies with
`backend/tests/fixtures/proxy-origin-csp.json`, generated from `proxy-origin.ts` (`backend-proxy.mjs
--write-fixture`; a vitest checks the same file): `proxyScriptCsp(appOrigins)` (`PROXIED_DOCUMENT_CSP` plus
`frame-ancestors 'self' <app origins>`) for every other script (`/sw.js`, `/assets/*.js`, `/vendor/**`, `/engine/*.js`);
`bareMuxWorkerCsp()` **and** `bareMuxWorkerScriptCsp(appOrigins)` as two policies for `/vendor/bare-mux/worker.js`
(`connect-src 'self'` alone left a worker free to `importScripts()` any URL and, opened as a document, to load images,
frames and modules from anywhere; every policy of a response is enforced, so the opt-in's `ws: wss:` is in both);
`proxyInertCsp(appOrigins)` (`default-src 'none'; form-action 'none'; base-uri 'none'` plus the same
`frame-ancestors`) for every answer where nothing runs (JSON, 404s, `/api/health`, `/api/filters*`, styles, wasm,
fonts, images, text, other HTML). The SW's own pages use the same directives (`SW_PAGE_CSP`). **[proven]** on the
real gnome-server in both browsers (`backend-proxy` parts `headers`, `realm`, `worker`; `backend-https`).

Violations are counted in the engine host with `securitypolicyviolation` listeners in each proxied document and sent
as `tab.blocked {byCategory: {'direct-connection': n}}`; they are **never** reported with `report-uri`/`report-to`
(reports carry the user's browsing to a server). Violations inside workers fire in the worker, not in a document,
and are not counted. **[proven]** for the tab's top document (`host-csp csp:top-document + tab.blocked`); the
listeners count synthetic events too (they do not check `isTrusted`, WAVE-B3 §11.2 F6), so a page can raise its own
count, which is display-only. **[unproven]**: that the listeners see every document violation (the spike's suites counted
through CSP reports and Chromium's CDP).

### 6.17 Hooks for Wave B step 3 (extensions)

Step 3 (ad and tracker blocking, cosmetic filtering, cookie rules, privacy headers) plugs into hook points the Wave B
step-2 code already calls with `ALLOW_ALL` (`engine-hooks.ts`):

- `onRequest` (block → `earlyResponse` / `respondWith`; redirect for documents → 307; header edits) from Scramjet's
  per-tab `fetch.request` and UV's SW `request`; `onResponse` (Set-Cookie policy) from Scramjet `fetch.preresponse`
  and UV `beforemod`; `onDocument` (cosmetic CSS, `navigator.globalPrivacyControl`) from Scramjet `init.post` and the
  UV document-start hook; `onWebSocket` (with `RequestInfo.destination` `'websocket'`, a value `Request.destination`
  never has) from the transport manager for Scramjet pages and, for UV pages, from
  `Ultraviolet.BareClient.prototype.createWebSocket`, which the engine host wraps in each UV document as soon as
  uv.bundle.js defines `Ultraviolet` (UV's transport runs in the bare-mux SharedWorker, where no synchronous hook call
  is possible). Hooks are synchronous and fail open (`safeVerdict`). **[proven]** with blocking verdicts registered
  through the e2e build (`host-hooks hooks:onWebSocket, onRequest, onDocument (blocking verdicts)` and
  `hooks:unregistered → ALLOW_ALL`): `onWebSocket` blocks in both engines (for UV through the `createWebSocket`
  wrapper, whose block throws a page-realm `DOMException`), `onDocument` runs for both engines' top documents,
  `onRequest` blocks Scramjet subresources and documents (a blocked document ends as `tab.error {kind: 'blocked'}`).
  The UV service-worker hooks (`registerSwHooks`: `request`, `beforemod`) are not exercised by a row yet.
- Protocol: `EngineSettings.privacy` (except `webrtc`) and `EngineSettings.extensions` carry the user's choices;
  `status.blocker` reports the filter engine (`off` in step 2); `tab.blocked` carries counts per category; capability
  `blocker` gates the Extensions page; the engine host fetches lists itself from `GET /api/filters/<id>?v=<sha256>` on
  the proxy origin. The SW gets the same settings over `{type: 'gnome-blocker-config'}` from the engine-host client
  only (`SwClient.post`).
- Escaped code shares the realm with the hooks and can disable them, and any page can become escaped code through
  `borrow-natives` (§1.1): blocking protects against sites that do not target GNOME, never against one that does.

### 6.18 Diagnostics

`diagnostics` returns counters only (`EngineDiagnostics`): instance, uptime, status, versions, capabilities, enforced
permissions, live tabs per engine, SW starts / held requests / 503 answers, CSP violations by directive, WebRTC policy
and blocked attempts, transport probes (valid, rejected, unreachable, rate-limited, upstream down, unknown profile),
rebuilds and drops per side, fallbacks and non-retried failures, rejected commands, JS heap (Chromium), main-thread lag
and long tasks. No URLs, titles or tickets, so "Copy diagnostics" is safe to paste into a bug report. The app adds its
own counters (§1.2 rule 8): the compromise signals (unexpected hellos and loads, invalid events and results) and,
apart from them, rate-limit drops, events for unknown ids, `LIBRARY_LIMITS` drops and refused forwarded shortcuts.

## 7. What the spike proved, what it did not

| Area | Proven (both browsers, both engines unless noted) | Not proven (Wave B tests it) |
| --- | --- | --- |
| Origins, sandbox, storage | two origins; SW, IndexedDB, Cache Storage in the sandboxed engine host, partitioning on; cookie jars survive app reloads; no top navigation; app-origin isolation (A1–A5) | the final sandbox *with* popup routing; replacing the engine iframe adds no history entry (Retry, restart, unexpected-load recovery); HTTPS two-hostname deployment (dev two-port loopback only) |
| Handshake | instance-id hello/connect, re-handshake after reload, forged hellos from other frames ignored | expecting-only acceptance, one port per load, hello per origin; unexpected-load recovery (the spike only reloaded the whole app) |
| Navigation | example.com, Wikipedia, GitHub, httpbin cookies/redirects/forms, WebSockets, title/favicon, back/forward/reload through `tab.go`, no joint-history entries for GNOME loads | `historyHandling` and same-document commits (pushState SPA); traversal detection; `tab.go` onto a pushState entry; UV navigations started in the page (start signal, classification, `204`); every load classified; retry after recovery; several engine hosts at once |
| Fallback | error hook, dead transport, timeout, init failure, cookies incl. HttpOnly, POST not retried, 404 not a failure, return to Scramjet | `init-failed` switch event |
| Tickets, transports | `?t=<ticket>&/` with all four transports (stub and real gateway); probe 401/426 and a rate-limited 429 + `Retry-After` (real gateway); drop, restart, rotation, proactive and lazy renewal (stub) | the real gateway's connection caps; the engine host's 429, `upstream-unreachable` and `unknown-profile` handling; the probe's `503 wisp_upstream_unavailable` (not built yet); the rebuild cap; custom servers behind the operator opt-in; 80 % renewal and its floor; clock-skew conversion; deferred ticket requests; the shared UV transport across GNOME tabs (`uvTransportAction`, tap fan-out) |
| SW | Firefox body buffering, `gnome-claim`, hold-and-revive (Chromium), stale-prefix 503, updates wait, apply at reload (Chromium) | the explicit apply step (Firefox); SW→host signals over `Client.postMessage`; download taps by MIME type and for `<a download>` |
| Leaks, CSP | proxied-document CSP (lab, probe, 8 sites), engine-host CSP (also served by the real gnome-server), bare-mux worker `connect-src 'self'` (real server), bus-config attack fixed | `frame`/`object`/`embed` and non-HTML coverage; the custom-Wisp opt-in policies (`ws: wss:`); gnome-server producing the policies by default; no permissive realm (a strict CSP on every proxy-origin response, WAVE-B lanes b and e) |
| WebRTC | kill switch effect for ordinary pages (modelled); escaped code partial | the switch through the engines' hooks; blank child frames; SVG and XHTML documents |
| Input | keys from nested frames, context-menu link target + coordinates, fullscreen from nested frames, find across nested frames | `lib/keys.ts` matching, forwarded privileged shortcuts (activation), other context kinds, selection truncation, zoom, print, select all |
| Downloads | via link and navigation, progress events, no `tab.loaded` | downloads without `Content-Disposition` (`unrendered-type`), `<a download>`, UV attribution without a referrer, `failed`/`cancelled`; `tab.download` (activation) |
| Popups | without `allow-popups` the browser opens nothing | `window.open`/`target=_blank`/form routing to `tab.openRequest`; `decideOpen` activation (propagation to the app document); `window.close` → `tab.closeRequest` |
| Data | – | cookies list/delete, site-data clearing, suggestions, VPN check, per-permission enforcement (`enforcedPermissions`) and in-page navigations keeping the decisions |

**After Wave B step 2** (the sections above name each row). Now proven: the final sandbox with popup routing and
activation propagation; replacing the engine iframe adds no history entry; HTTPS with two hostnames (`backend-https`,
standalone, two `*.localhost` names behind a TLS front with a CA only the test profiles trust); expecting-only
acceptance and one port per load; unexpected-load recovery; `historyHandling`, same-document commits, traversal
detection and `tab.go` onto a pushState entry; UV navigations started in the page, every load classified, `204`;
several engine hosts at once and the shared UV transport; the engine host's 429, `upstream-unreachable` and
`unknown-profile` handling, the probe's `503`, custom servers behind the opt-in, the 80 % renewal; the explicit apply
step and the background update check; SW→host signals over `Client.postMessage` (every SW row that reports to the
engine host depends on them); download taps by MIME type and for `<a download>`; `frame` and SVG coverage of the
CSP, no permissive realm on the server and in the SW; the WebRTC switch through the engines' hooks and in blank
child frames; `lib/keys.ts` matching, privileged shortcuts, every context kind, truncation, zoom, select all;
cookies, site data, suggestions, the VPN check through the default route, `enforcedPermissions` as reported; and
from integration part 2 the `init-failed` switch event (`host-fallback fallback:init-failed`) and `tab.download`
("Save link/image as", §6.9).

Still not proven: the retry after a transport recovery; the
rebuild cap and the 60 s idle retry; clock-skew conversion and deferred ticket requests with a real clock (unit tests
only); the real gateway's connection caps beyond the per-session cap; `failed`/`cancelled` downloads; UV attribution
behind a redirect; print with a real dialog; autoplay enforcement in Firefox (not implemented by Firefox
157) and clipboard enforcement in any browser (Chromium's policy leaves `document.execCommand('copy')`); in-page navigations keeping the permission decisions; the UV service-worker hooks;
a real VPN tunnel. Measured limits (`expectFail` rows): `host-attack borrow-natives` (§1.1), `host-webrtc
webrtc:block:gaps-open` (§6.15), `host-smoke fixture:page-chosen-requests-carry-the-page-as-initiator` under
Ultraviolet (§1.1, §6.1), `host-capabilities permission:autoplay` in Firefox and `permission:clipboard` in both
browsers (§6.14), and `sw sharedworker` under Scramjet in Firefox (§6.16).

## 8. Changes

### 8.1 From the draft (2026-11-10)

- Threat model rewritten from the attack review: the proxy origin is one shared realm; the app origin is the boundary;
  what the app may and may never send; compromise signals.
- Handshake: instance ids, expecting-only hello, one port per load, instance in `connect`, `mismatch`, unexpected
  loads, liveness `ping`, SW update states and the apply step.
- New: `status`, `ping` commands; `tab.loaded`; `same-document` commits with `ms`; `navId`; capabilities;
  `tab.action`, `tab.download`; `EngineSettings.route`, `keys`, `privacy.webrtc`, resolved `permissions`;
  `TransportStatus.detail`/`since`/`retryInMs`; `SwStatus`; `BlockerStatus`; `tab.error.signal`/`idempotent`;
  `tab.engineSwitched.reason`/`latencyMs`; `tab.openRequest.userActivation`; `tab.key.repeat`; `download.started.engine`.
- Removed: `tab.discard`, `tab.contextAction`, `download.cancel`, `permission.request`/`reply`, `blocker.*`
  commands, `ready`, `tab.loading.progress`, error kinds `dns`/`tls`/`vpn-down`, `init.profiles`/`lists`/`shortcuts`
  (now in `EngineSettings`).
- Every command and event has exact types, limits and a validator; rate limits per tab; timeouts per command.

### 8.2 Contract fix (2026-11-12), after the security and completeness reviews

- Custom Wisp servers: the operator opt-in `GNOME_ALLOW_CUSTOM_WISP` (`/api/config` → `wisp.custom_servers`)
  replaces the `?wisp=` engine-host parameter (decisions log 2026-11-11); `engineHostCsp(appOrigins, {customWisp})`,
  `bareMuxWorkerCsp({customWisp})`, `engineHostUrl(proxyOrigin)` without parameters; `externalWispOrigins` and
  `parseWispOrigins` removed.
- Handshake: the app replaces the engine iframe element instead of resetting `src` (no Back-button trap, §2.3).
- Threat model: the order validate → unknown ids dropped → rate limits; `VisitGate` and `LIBRARY_LIMITS` cap what
  events can write; compromise signals are only unexpected hellos, unexpected loads and invalid messages (rate-limit
  drops are counted apart); the VPN exit check is not a security indicator; no credential prompt from an event; the
  per-site permission list is no longer sent (`EngineSettings.permissions` removed, per-load `permissions` on
  `tab.create`/`navigate`/`go`/`reload`); the blocker's per-site maps stay empty until `blocker` is reported.
- `decideOpen` fails closed without the app's own activation; forwarded shortcuts split into ordinary and privileged
  (`FORWARDED_PRIVILEGED_LIMIT`); `LIMITS.maxTabs`.
- Navigation: UV navigations started in the page get a start signal; every load of a tab frame is classified;
  `204`/`205`; `tab.committed.historyHandling`/`index`/`length`; `tab.go` loads a pushState entry in full; the new
  core command `tab.state` and the app's navigation watchdog.
- Normalization: the engine host fits values before emitting (`fitText`, `fitInt`, `downloadFilename`), the selection
  limit is 100 000 with `selectionTruncated`, combos may be 48 characters; the engine host coalesces latest-value
  events (`COALESCE_MS`); `sanitizeText` strips bidi controls from multi-line text too.
- Downloads: detected by `Content-Disposition` or an unrendered MIME type (`downloadDisposition`), `<a download>`;
  `uv-download` carries `clientUrl`, `navigation` and `disposition`; attribution rules; blob/data downloads are not
  observed.
- Tickets: `ticketExpiresAtLocal` (server clock from the `Date` header, TTL cap); the 10 s renewal floor also for
  expired tickets.
- Transport: the probe's `503 wisp_upstream_unavailable` (`upstream-down`) and 404 (`unknown-profile`, a new
  `TransportDetail`); one UV transport per proxy origin (`uvTransportKey`, `uvTransportAction`, tap events to every
  engine host); `onWebSocket` for UV pages from `Ultraviolet.BareClient.prototype.createWebSocket`.
- Capabilities: `permissions` replaced by `InitResult.enforcedPermissions` (per permission, per browser);
  `tabFrameAllow` writes `<feature> 'none'`.
- Snapshot: `engineChoice` makes `GNOME_ENGINE_DEFAULT` count; `isWispServer`/`isCombo` for the Settings validator and
  the snapshot builder.
- Library: `HistoryStore.removeUrl`, `BookmarkStore.favorites`/`setFavorite`, `Bookmark.favorite`,
  `DownloadStore.started` resolves to whether it recorded; `shouldRecordVisit` takes `historyHandling`.
- Not taken: letting the engine host drop invalid entries of a settings snapshot instead of rejecting it (the
  snapshot builder guarantees validity and a property test checks it; a partly applied snapshot would hide bugs);
  opener emulation for popups (later); a cross-site proxy hostname for process isolation (not evaluated).

### 8.3 Integration of Wave B step 2 (2026-11-18): additive contract changes from the lanes

`PROTOCOL_VERSION` stays 1; no message, type, validator or exported name was removed or changed, and no validator
accepts more than before. Two texts were corrected (the last two items): one to what the code already did, one
(`expecting`) ahead of the app code, which integration part 2 changes.

- `proxy-origin.ts`: `proxyScriptCsp(appOrigins)`, `bareMuxWorkerScriptCsp(appOrigins, {customWisp})` and
  `proxyInertCsp(appOrigins)`, the policies gnome-server already sent (lane e review; §6.16), now in the contract and in
  the shared fixture; `SwClient.post(message: HostToSwMessage)` (lane b; Wave B step 3 sends `gnome-blocker-config`
  with it); comments on `CSP_DESTINATIONS`' `object`/`embed` entries and the SW's own page policy.
- `engine-hooks.ts`: `RequestInfo.destination` is `'websocket'` for `onWebSocket` calls (lane b).
- `browser-data.ts` (comments only, lane d): `BookmarkStore.add`/`update` take `position` as the index among the
  folder's live items; `DownloadStore.clear` removes finished items only.
- `TransportState` (text only, lane b review): `ready` means "built, nothing known to be wrong", not "the last socket
  opened" (§6.6). The shell shows a spinner for `connecting`, so the old wording would have made every idle engine
  host spin; the code already behaved this way.
- `HelloContext.expecting` / `TIMEOUTS.helloWaitMs` (text only, lane c review): the hello timeout does not end the
  expecting window; a late first hello from the app's own fresh iframe connects instead of counting as a compromise
  signal (§2.2 step 5). `decideHello` is unchanged (it takes no clock); `src/browser/engine/client.ts` followed in
  integration part 2 (2026-11-19).

### 8.4 Integration of Wave B step 2 (2026-11-18): what the lanes measured

Document corrections from the ten lane reports, each checked against the code and the e2e suites (the evidence
rule of the header):

- Threat model (§1.1): an ordinary page reaches the engine-host window through a fresh child realm's native
  `parent`/`top`/`frameElement` getters (`host-attack borrow-natives`, `expectFail`), so every "ordinary page: no" of
  the old table holds only for a page that does not target GNOME; the app origin is the only boundary. Every
  proxy-origin answer needs a strict policy (Chromium commits an empty-bodied 4xx subframe answer as a same-origin
  document without one). The shared UV transport has a lock (§6.6).
- Realm hygiene: step 2 installs only page-realm callables in proxied realms (`src/engine-host/realm.ts`, rows
  `host-attack realm-walk` and `page-getters`: 0 engine-host functions and 0 engine-host arguments arrays in both
  engines and browsers); engine-host code reads page objects only through its own natives.
- WebRTC (§6.15): what `block` stops and the gaps it cannot close; documents the engines leave unrewritten (SVG,
  XHTML, XML, HTML without a usable `Content-Type`) run no scripts; `<frame>` loads are shown to the engines as
  iframes; `<object>`/`<embed>` never pass a service worker; UV refuses sites' `SharedWorker`s (§6.16).
- Service worker (§2.5): the apply step's retries, the background update check, the Firefox finding that an update
  check before control breaks the engine host, and Firefox's idle stop with the double-revive fix.
- Markers moved to **[proven]** in §2.1–§2.5, §6.1, §6.3, §6.5–§6.17 and the step-2 paragraph of §7; still
  **[unproven]**: the `init-failed` switch event (a manual probe only) and the items §7 lists.

### 8.5 Integration of Wave B step 2, part 2 (2026-11-19): engine host, service worker, transport

No contract change (`frontend/src/shared/**` untouched, `PROTOCOL_VERSION` stays 1). What the engine host does
differently, each with its row (both engines, both browsers):

- WebRTC (§6.15): the engine-host realm's child-frame guard follows the live `privacy.webrtc`; before, a switch to
  `allow` never reached a page once the engine host had started with `block` (`host-webrtc webrtc:switch`).
- GNOME-initiated navigations carry no initiator (§6.1: no `Referer`/`Origin`, `Sec-Fetch-Site: none`; Chromium had
  sent the previous site's) and Scramjet's "unrewriteurl: unexpected url …/engine/" error is gone (`host-smoke
  fixture:gnome-loads-carry-no-initiator`); `ScramjetEngine.decode()` asks Scramjet only for the URLs of its own frames.
- History without a URL keeps the URL (§6.1; Scramjet's `/undefined`, e.g. DuckDuckGo: `host-nav
  spa:history-without-url-keeps-the-url`, `real-site:duckduckgo search keeps its URL`).
- Custom Wisp servers (§2.1, §6.6): a socket the page's policy refuses is a failed open in both taps, and a test socket
  picks the first server that answers before a transport is built (`transport custom`).
- `init-failed` is proven (§6.2, `host-fallback fallback:init-failed`); `enforcedPermissions` reports clipboard in
  Chromium (§6.14, click-based row, and a row that the list is exactly what passed; withdrawn by the fix step, §8.6,
  because `document.execCommand('copy')` ignores the policy); tab frames list only the enforced
  features in `allow` (§6.14); the long-task observer runs only where the entry type exists.
- Found and not fixed here (a contract change request in the part-2 report): page-made `blob:` images, workers and
  fetches fail under both engines because the engine-host policy and the SW script's policy lack `blob:` in
  `connect-src` (`host-leak probe`). Fixed by the fix step (§8.6).

### 8.6 Integration of Wave B step 2, part 2 (2026-11-19): fixes after the security and quality reviews

`PROTOCOL_VERSION` stays 1; every contract change is additive or a stricter table, each with its unit tests, and the
CSP strings also in `csp.rs` and the regenerated `backend/tests/fixtures/proxy-origin-csp.json`:

- `PROXIED_DOCUMENT_CSP` and `ENGINE_HOST_CSP_DIRECTIVES`: `connect-src` gains `blob:` (§6.16; `host-leak probe` passes
  in both browsers, both engines; its Firefox × Ultraviolet `blobWorker` failure is the engine's own, as the spike's
  run without any GNOME policy shows). The bare-mux worker's first policy stays `connect-src 'self'`.
- `TabStart` `{kind: 'url', url, opener?}` (§4, §6.1, §6.3): the first load of a tab a page asked for, or that the user
  opened from a page's link in GNOME's context menu, carries that page as its initiator. The validator accepts only an
  http(s) URL and drops `opener` on the other starts.
- `ENFORCED_PERMISSIONS` and `browserFamily()` move from `engine-host/core.ts` into `site-rules.ts`, with the new
  `trustedEnforcedPermissions()` that the app applies to `InitResult.enforcedPermissions`; `clipboard` leaves
  Chromium's list, so no browser reports it (§6.14).

Engine host and service worker: what the engine host fetches for a page (favicon, `<a download>`) carries the page
as initiator (§6.1, `sj-requests.ts` `withInitiator`/`GnomeLoads`); Scramjet navigation downloads get a
`Content-Disposition` with the file name (§6.9); Ultraviolet's `Referer` follows the request's referrer policy
(`sw/pure.ts` `referrerFor`); a custom Wisp server's test socket closes after its 4 s deadline (§2.1); e2e builds log
which request an engine failed (`sw.ts` `noteFailure`). App: one click opens one tab, and an open over the rate limit
goes to the pop-up indicator (§6.3); `facts.svelte.ts` keeps only what the browser can enforce.

Capabilities: `saveLink` and `saveImage` are offered (`engine-host/core.ts`; §6.9), now that Firefox saves the
engine host's blob downloads.

gnome-server: the shell policy's `frame-src` names only the engine host's origin (the proxy origin; `'self'` in
single-origin mode) and `blob:`; `csp::GAME_EMBED_HOSTS` is gone (§1.1, `host-attack escaped-engine-iframe-navigation`;
Wave C frames games through per-game wrapper documents). `blob:` because Firefox checks the engine host's own blob
downloads against the app's `frame-src` as navigations of the engine iframe: it refused them, so a page's
`<a download>` was never saved in Firefox although GNOME listed it as completed (`host-downloads downloads:a-download`
had passed there only by reading the previous row's file of the same size; it now checks the file the browser saved).

Documents: §1.1 gains the row on sites not being kept apart (no CORS in either engine; Ultraviolet ignores SameSite;
the planned mitigation is step 3's third-party cookie blocking); the Scramjet SharedWorker marker is `[unproven]`
(Chromium only).

### 8.7 Integration of Wave B step 2, part 2 (2026-11-19): final gate

No contract change. The gate ran every suite under `tests/e2e/engine/` in Chromium and Firefox, plus the standalone
suites, on the tree of §8.6 (an `npm run build:e2e` build; gnome-server built after the last backend change): 1010
rows passed, 2 skipped, 17 failed as expected (the measured limits of §7) and 6 failed and then passed on a re-run.
Every row a `[proven]` marker names passed in both browsers in that run or its re-run, so no marker moved. The six:
four connection errors in Firefox under Scramjet ("Request failed with error code 35: SSL connect error" from
libcurl, once a connect error from epoxy; `transport renewal` ×2, `backend-proxy custom`, `host-leak sites:mdn`,
which also failed its first re-run; the same error hit other `host-leak sites` and `transport` rows in the re-runs,
7 of about 160 Firefox × Scramjet rows in all, and none in Chromium; not reproduced through GNOME's production UI or
natively through HolyWisp, cause unknown); one history-visit timeout in Chromium (`library-visits`); and
`shell-sw-update` "with the other tab closed, Reload applies the update" in Firefox (§2.5 now says the apply step
can take a second reload).
