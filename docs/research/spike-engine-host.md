# Two-origin engine-host spike: results, wiring, limitations

> Wave A2 de-risking spike for ARCHITECTURE §4.6 (two origins, Wisp tickets) and §5.4 (engines, transports, SW), and
> the input to Wave B's engine-host work and `docs/ENGINE-PROTOCOL.md` reconciliation.
> Session 3 (2026-11-11): three lanes wrote the first results (spike-core: items 1, 2, 7 and the wiring;
> spike-isolation-leak: items 3, 4; spike-transport-fallback: items 5, 6, 8). Session 4 (2026-11-11 evening): the
> verification step merged their section files into this document, re-ran every suite twice from a clean `npm ci` in
> both browsers, tried to refute each conclusion, fixed the harness and the claims that did not hold, and added the
> missing tests (§9). Every result below is from the two session-4 runs unless a row says otherwise.
> The adversarial isolation review (lane proxy:spike-attack, session 4) is §11; its requirements are merged into §10.
> Harness: `tests/e2e/spike-engine-host/` (README: `tests/e2e/README.md`). Nothing here was run against `gnome-server`
> itself: the `/wisp/` gateway is a stub that copies the Rust gateway's ticket parsing and probe order (§7.15).

## 1. Summary

1. **The two-origin engine host works in Chromium 156 and Firefox 157.** A same-site, cross-origin iframe
   `<proxy origin>/engine/` with the specified sandbox (no `allow-top-navigation*`) gets a real origin, a secure context,
   a service worker at scope `/`, IndexedDB and Cache Storage, also with third-party storage partitioning turned back on
   (same-site frames are first-party for partitioning; the cross-site control is partitioned). Both cookie jars survive
   app reloads, a forced reload works with the `gnome-claim` fix, and stale Scramjet prefixes fail fast (`503
   stale-prefix`, 1 ms). Scramjet and UV run side by side behind one SW.
2. **Navigation through both engines over a real HolyWisp works** (example.com, Wikipedia, GitHub, httpbin cookies /
   redirects / form POST, WebSocket echo, title/favicon, back/forward/reload, downloads with progress), with two
   **upstream transport bugs**: both epoxy builds (2.1.29, 3.0.2) hang on the first request after the site closed an idle
   keep-alive connection, and neither epoxy build reconnects after a Wisp drop. → **libcurl is the default transport for
   both engines**; epoxy stays selectable behind the watchdog.
3. **The app origin stays isolated.** In every engine × browser, neither the page's own (engine-rewritten) script nor
   escaped (unrewritten) code could read the app's storage, get a credentialed state-changing app call past CORS, or
   navigate the app's top window. Escaped code shares everything else on the proxy origin with the engine host (§3,
   item 3, `reach:proxy-origin`); **WebRTC from ordinary proxied pages sends UDP directly**, outside Wisp, in both engines and browsers.
4. **The Wikipedia leak is root-caused and mitigated.** MediaWiki inserts module CSS as a Text node into a `<style>`
   element; neither engine rewrites that path (Scramjet's hook is commented out with a TODO, UV hooks only the
   `textContent`/`innerHTML` setters), so 7 icon URLs load natively. A **GNOME CSP on every proxied document and worker**
   turns every leak the 53-construct lab finds into a blocked load: the constructs that went native with the CSP off
   (Chromium/Firefox: Scramjet 17/16, UV 26/25) are exactly the ones reported blocked with it on, in both runs. On
   8 real sites the only visible change is that Wikipedia's 7 icons stay blank. The CSP does not bind escaped code;
   the same policy on the engine-host document closes the engine-host realm route; popups and WebRTC remain open.
   In the session-3 SW **any ordinary UV-proxied page (no escape needed) could switch the UV half of this CSP off** over
   the `gnome-engine` BroadcastChannel (26/25 constructs then leaked); the SW now takes its configuration only from the engine host (tested).
5. **Tickets:** `wss://<proxy>/wisp/?t=<ticket>&/` works for all four transports (libcurl needs the trailing `/`). Since
   session 4 the backend gateway also accepts `?t=<ticket>/`, percent-decodes, and answers the plain-GET probe with
   401 (bad ticket) / 426 (good ticket); both session-3 gateway gaps (F1, F5 of the transport lane) are closed in
   `backend/src/gateway/mod.rs`, and the harness stub now copies that parser exactly. The recovery recipe (watchdog,
   probe, renewal, lazy renewal) recovered every drop, gateway restart and rotation with all four transports.
6. **Controlled fallback works** (one retry on UV, same destination, Scramjet cookies incl. HttpOnly copied, the next
   user navigation returns to Scramjet). Session 4 found that a failed **POST** navigation was re-sent to UV as a
   **GET**; the engine host now never retries non-idempotent navigations (tested).
7. **SW lifecycle (new in session 4).** A stopped SW restarts on the next request and held Scramjet requests are routed
   after the controller re-announces itself (Chromium, 50 ms). A **new `/sw.js` taking over a running engine host breaks
   both engines** (upstream `skipWaiting()` in `controller.sw.js`): GNOME's SW now keeps updates waiting; the update
   applies at the next app reload in Chromium, while Firefox keeps the old worker across a reload (Wave B needs an
   explicit "apply update" step).
8. **Performance** (both runs, §3 item 8): cold engine-host init 250–470 ms wall (Chromium 250–470, Firefox 400–450),
   warm example.com 45–150 ms, warm Wikipedia 400–780 ms, about 80–155 MB PSS for the engine host with both engines.
   Scramjet costs 5–12 long tasks (0.34–1.06 s in total) per two-site session on the renderer thread it shares with the
   shell; UV 0–2 (≤ 0.21 s).
9. **Adversarial review (§11).** Attacking as a hostile proxied site confirmed both halves of the model: every app-origin
   check held (storage, API, top navigation, forged protocol messages, the ticket for virtualized pages), while escaped
   code owns the whole proxy origin: other tabs' documents, both cookie jars (HttpOnly included), engine storage, the
   SW registration, UV's bare-mux transport and the engine-host realm, from which it read the real Wisp ticket and
   forged app-accepted events over a captured port. A document-start WebRTC kill switch stops ordinary proxied pages
   (escaped code still reaches WebRTC through a native `about:blank` frame), and without `allow-popups` popups are dead.
   The 2026-11-11 decisions (PROGRESS) accept the shared realm and drop `allow-popups`/`allow-popups-to-escape-sandbox`.

## 2. What was tested

| Piece | Version / build |
| --- | --- |
| Browsers | chromium-1248 (Chromium 156, `channel: 'chromium'`, new headless) and firefox-1555 (Firefox 157), driven by playwright-core 1.64.0; Node 26.13 |
| Scramjet | 2.0.67-alpha.2 + scramjet-controller 0.0.14; transports libcurl-transport 2.0.6 (default) / epoxy-transport 3.0.2 |
| Ultraviolet | 3.2.10 + bare-mux 2.1.9 (UV's SW bundle carries bare-mux 2.1.6); transports epoxy-transport 2.1.29 (harness default) / libcurl-transport 1.5.2 |
| Wisp | HolyWisp e0a0f15 static x86_64 binary (sha256 `0064b769…f6d4f8`) in an unprivileged, read-only container: `services/holywisp/gnome.conf` behind `/wisp/`; `gnome.conf` + TEST-ONLY `allow-loopback` overlay behind `/wisp/p/test-loopback/` (local target only) |
| Origins | app `http://127.0.0.1:<app port>`, proxy `http://127.0.0.1:<proxy port>`: same-site, cross-origin, both secure contexts (dev two-port variant of §4.6) |
| Gateway | `servers/proxy.mjs` stub: ticket + `Origin` checks, strict `ticket_param` copy, 401/426 probe, splice to HolyWisp, drop/kill/rotate commands |
| Egress control | every non-loopback request of the browsers goes to a sentinel HTTP proxy that refuses and records it, so a request that reaches the internet went through Wisp |

Run it (clean state, as in session 4):

```sh
cd tests/e2e && npm ci
node spike-engine-host/run.mjs --only smoke,sw,nav,transport,fallback,input,isolation,leak,perf --strict
# every SPIKE_*_PORT can be moved (tests/e2e/README.md); session 4 used 22060-22099 and 22160-22199
```

A full run (both browsers, one after the other) takes about 30 minutes; `--parallel` runs `smoke,sw,nav,input` for both
browsers at once and the rest one browser at a time.

## 3. Verified results

Each row is one engine × transport × test. Columns give the result in **run 1** and **run 2** of session 4 for each
browser (`fail (exp.)` = expected failure documenting upstream or browser behaviour, `–` = not run there, e.g. the
Chromium-only CDP checks). Run 1 = the session-3 harness exactly as found (default ports 22060–22099); run 2 = the
harness after the session-4 fixes (ports 22160–22199). Rows added in session 4 have `–` in run 1. Notes are from run 2
(Chromium; Firefox when it differs). Full data: `results.json` of each run (§9.1).

### Item 1: two origins, sandbox, SW and storage in the engine host, reloads, SW lifecycle

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| scramjet | libcurl | example.com | pass · pass | pass · pass | {"ms":279,"title":"Example Domain","error":null} |
| ultraviolet | epoxy | example.com | pass · pass | pass · pass | {"ms":851,"title":"Example Domain","error":null} |
| - | - | gateway stub: ticket + Origin enforced | pass · pass | pass · pass | no ticket: 401; wrong ticket: 401; app origin: 403; opaque origin "null": 403; no Origin header: 403; valid: 101 (first Wisp packet 0x03); valid, profile route: 101 (fir… |
| - | - | proxy origin headers | pass · pass | pass · pass | /engine/ CSP "frame-ancestors http://127.0.0.1:22180 http://localhost:22180", X-Frame-Options absent; /sw.js 200 text/javascript; charset=utf-8, Service-Worker-Allowed / |
| - | - | engine iframe: cross-origin, sandboxed, secure context | pass · pass | pass · pass | app http://127.0.0.1:22180 embeds http://127.0.0.1:22181/engine/; sandbox exact=true; allow="fullscreen; clipboard-write; autoplay"; app reading frame document -> Securi… |
| - | - | SW registered + controls the engine host | pass · pass | pass · pass | {"scope":"http://127.0.0.1:22181/","script":"http://127.0.0.1:22181/sw.js","state":"activated"}; swReady 69 ms, init 185 ms (scramjet 116, uv 26) |
| - | - | IndexedDB + Cache Storage in the engine host | pass · pass | pass · pass | indexedDB ok, cacheStorage ok, persisted false, quota 10241 MiB, dbs ["__scramjet_controller","gnome-engine-probe"] |
| scramjet | libcurl | cookie set (302 + Set-Cookie incl. HttpOnly) | pass · pass | pass · pass | server saw {"sj":"persist","srvhttp":"1"}; jar [".127.0.0.1:sj=persist",".127.0.0.1:srvhttp=1"] |
| ultraviolet | epoxy | cookie set (302 + Set-Cookie incl. HttpOnly) | pass · pass | pass · pass | server saw {"srvhttp":"1","uv":"persist"}; __op [".127.0.0.1:srvhttp=1",".127.0.0.1:uv=persist"] |
| - | - | app reload: engine host re-handshakes, SW still in control | pass · pass | pass · pass | reload->init 134 ms (swReady 1 ms, init 59 ms); new engine host has 0 tabs (the app must restore tabs from real URLs); connects on the old page 1 |
| scramjet | libcurl | pre-reload proxied URL after app reload | pass · pass | pass · pass | {"status":503,"sw":"stale-prefix","ms":1,"path":"/~/sj/5tqsbpzu/mhgvbfh0/http%3A%2F%2F127"} |
| ultraviolet | epoxy | pre-reload proxied URL after app reload | pass · pass | pass · pass | {"status":200,"sw":null,"ms":125,"path":"/uv/service/hvtr%3A-%2F325.2.2.3%3A02392"} |
| scramjet | libcurl | cookies persist across app reload | pass · pass | pass · pass | server saw {"sj":"persist","srvhttp":"1"} |
| ultraviolet | epoxy | cookies persist across app reload | pass · pass | pass · pass | server saw {"srvhttp":"1","uv":"persist"} |
| - | - | forced reload (ignore cache): SW claims the engine host | pass · pass | – · – | controlled true, swReady 1 ms; scramjet ok; ultraviolet ok |
| - | - | engine host cannot navigate the app (no allow-top-navigation) | pass · pass | pass · pass | top.location.href= -> SecurityError: Failed to set a named property 'href' on 'Location': The current window does not have permission to navigate the target frame to 'ht… |
| scramjet | libcurl | same-site embed with storage partitioning ON | pass · pass | pass · pass | SW controlled true, IDB ok, Cache ok; cookie after reload: {"part":"1","srvhttp":"1"} |
| scramjet | libcurl | cross-site embed with partitioning ON: engine state is partitioned (control) | pass · pass | pass · pass | engines work; SW controlled true; proxied cookie set under the same-site embed NOT visible (partitioned); server saw {} |
| - | - | SW lifecycle: baseline (csp=enforce) | – · pass | – · pass | scramjet 146 ms; ultraviolet 209 ms; UV leak page: 0 native egress, 26 CSP violations; SW held [] ms, starts 0, 503 [] |
| - | - | SW lifecycle: stopped SW restarts on the next request | – · pass | – · – | scramjet 120 ms; ultraviolet 69 ms; UV leak page: 0 native egress, 26 CSP violations; SW held [50] ms, starts 1, 503 [] |
| - | - | SW lifecycle: an updated /sw.js waits; the running engine host keeps working | – · pass | – · pass | new version installed and waiting true, took over false (controller (original)); scramjet 63 ms; ultraviolet 67 ms; UV leak page: 0 native egress, 26 CSP violations; SW … |
| - | - | SW lifecycle: the update applies at the next app reload; both engines work | – · pass | – · fail (exp.) | controller after reload ?rev=1794448742832; scramjet 120 ms; ultraviolet 196 ms; UV leak page: 0 native egress, 26 CSP violations; SW held [] ms, starts 0, 503 [] — Firefox: controller after reload (original) (update still waiting); scramjet 132 ms; ultraviolet 271 ms; UV leak page: 0 native egress, 25 CSP viola… |

### Item 2: navigation through both engines over HolyWisp

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| ultraviolet | epoxy | example.com | pass · pass | pass · pass | 258 ms; title "Example Domain" |
| scramjet | libcurl | example.com | pass · pass | pass · pass | 271 ms; title "Example Domain" |
| ultraviolet | epoxy | en.wikipedia.org/wiki/Gnome | pass · pass | pass · pass | 777 ms; title "Gnome - Wikipedia" |
| ultraviolet | epoxy | find in page on Wikipedia | pass · pass | pass · pass | "gnome": 159 matches in 91 ms (round trip), highlights true |
| scramjet | libcurl | en.wikipedia.org/wiki/Gnome | pass · pass | pass · pass | 919 ms; title "Gnome - Wikipedia" |
| scramjet | libcurl | find in page on Wikipedia | pass · pass | pass · pass | "gnome": 159 matches in 48 ms (round trip), highlights true |
| ultraviolet | epoxy | github.com/MercuryWorkshop/scramjet | pass · pass | pass · pass | 2379 ms; title "GitHub - MercuryWorkshop/scramjet: Scramjet is a versatile web proxy designed to bypass internet censorship. · GitHub" |
| scramjet | libcurl | github.com/MercuryWorkshop/scramjet | pass · pass | pass · pass | 2431 ms; title "GitHub - MercuryWorkshop/scramjet: Scramjet is a versatile web proxy designed to bypass internet censorship. · GitHub" |
| ultraviolet | epoxy | httpbin cookie round trip | pass · pass | pass · pass | set->302->/cookies: { "cookies": { "gnome": "ultraviolet-56909" } } ; fresh /cookies: { "cookies": { "gnome": "ultraviolet-56909" } }  |
| scramjet | libcurl | httpbin cookie round trip | pass · pass | pass · pass | set->302->/cookies: { "cookies": { "gnome": "scramjet-57120" } } ; fresh /cookies: { "cookies": { "gnome": "scramjet-57120" } }  |
| ultraviolet | epoxy | httpbin redirect chain (3 x 302) | pass · pass | pass · pass | 61 ms; committed https://httpbin.org/get |
| scramjet | libcurl | httpbin redirect chain (3 x 302) | pass · pass | pass · pass | 107 ms; committed https://httpbin.org/get |
| scramjet | libcurl | httpbin form POST | pass · pass | pass · pass | committed https://httpbin.org/post; body , "delivery": "", "size": "medium" }, "json": null }  |
| ultraviolet | epoxy | httpbin form POST | pass · pass | pass · pass | committed https://httpbin.org/post; body custtel": "", "delivery": "", "size": "medium" }, "json": null }  |
| scramjet | libcurl | public WebSocket echo (page JS on example.com) | pass · pass | pass · pass | {"wss://echo.websocket.org/":"echoed","wss://ws.postman-echo.com/raw":"echoed"} |
| scramjet | libcurl | redirect chain 302/301/307/303 (local) | pass · pass | pass · pass | 169 ms; committed http://127.0.0.1:22190/redirect-done?via=chain |
| scramjet | libcurl | form POST body (local) | pass · pass | pass · pass | server got {"method":"POST","contentType":"application/x-www-form-urlencoded","length":25,"body":"greeting=hello+gnome&n=42"} |
| scramjet | libcurl | WebSocket echo (local, test-only route) | pass · pass | pass · pass | {"ok":true,"echoed":"gnome-ping-9opp5e","seen":["gnome-ping-9opp5e"]} |
| scramjet | libcurl | title change + favicon events | pass · pass | pass · pass | title "Changed title"; favicon 130 chars data:image/png |
| scramjet | libcurl | back / forward / reload | pass · pass | pass · pass | back {"url":"http://127.0.0.1:22190/","kind":"history","fwd":true}; fwd {"url":"http://127.0.0.1:22190/title-change","back":true}; reload "reload" |
| scramjet | libcurl | joint session history: GNOME-initiated loads add no entries | pass · pass | pass · pass | app history.length 2 at start, 3 after the in-page form submit (+1), 3 after 4 GNOME-initiated tab loads + back/forward/reload |
| scramjet | libcurl | download via link: browser download | pass · pass | pass · pass | browser download "gnome-spike.bin" 2097152 bytes; tab URL afterwards http://127.0.0.1:22190/download-page?size=2097152&delay=40 |
| scramjet | libcurl | download via link: engine-host events | pass · pass | pass · pass | started {"tabId":5,"filename":"gnome-spike.bin","total":2097152}; 7 progress events; done {"downloadId":"sj-1","state":"completed","received":2097152} |
| ultraviolet | epoxy | public WebSocket echo (page JS on example.com) | pass · pass | pass · pass | {"wss://echo.websocket.org/":"timeout (open true, received [\"Request served by 4d896d95b55478\"])","wss://ws.postman-echo.com/raw":"echoed"} |
| ultraviolet | epoxy | redirect chain 302/301/307/303 (local) | pass · pass | pass · pass | 179 ms; committed http://127.0.0.1:22190/redirect-done?via=chain |
| ultraviolet | epoxy | form POST body (local) | pass · pass | pass · pass | server got {"method":"POST","contentType":"application/x-www-form-urlencoded","length":25,"body":"greeting=hello+gnome&n=42"} |
| ultraviolet | epoxy | WebSocket echo (local, test-only route) | pass · pass | pass · pass | {"ok":true,"echoed":"gnome-ping-xpmk1e","seen":["gnome-ping-xpmk1e"]} |
| ultraviolet | epoxy | title change + favicon events | pass · pass | pass · pass | title "Changed title"; favicon 130 chars data:image/png |
| ultraviolet | epoxy | back / forward / reload | pass · pass | pass · pass | back {"url":"http://127.0.0.1:22190/","kind":"history","fwd":true}; fwd {"url":"http://127.0.0.1:22190/title-change","back":true}; reload "reload" |
| ultraviolet | epoxy | joint session history: GNOME-initiated loads add no entries | pass · pass | pass · pass | app history.length 2 at start, 3 after the in-page form submit (+1), 3 after 4 GNOME-initiated tab loads + back/forward/reload |
| ultraviolet | epoxy | download via link: browser download | pass · pass | pass · pass | browser download "gnome-spike.bin" 2097152 bytes; tab URL afterwards http://127.0.0.1:22190/download-page?size=2097152&delay=40 |
| ultraviolet | epoxy | download via link: engine-host events | pass · pass | pass · pass | started {"tabId":5,"filename":"gnome-spike.bin","total":2097152}; 7 progress events; done {"downloadId":"uv-mwcwgvf8-1","state":"completed","received":2097152} |
| scramjet | libcurl | download via navigation | pass · pass | pass · pass | browser download 1048576 bytes; tab events tab.loading,tab.loading,download.started,download.progress,download.progress,download.done; navigate() "timeout waiting for ta… |
| scramjet | libcurl | request after 6.5 s idle (server closed the keep-alive connection) | pass · pass | pass · pass | warm-up 114 ms; first 63 ms; after idle 103 ms |
| ultraviolet | epoxy | download via navigation | pass · pass | pass · pass | browser download 1048576 bytes; tab events tab.loading,tab.loading,download.started,download.progress,download.progress,download.done; navigate() "timeout waiting for ta… |
| scramjet | epoxy | request after 6.5 s idle (server closed the keep-alive connection) | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | warm-up 109 ms; first 60 ms; after idle "timeout waiting for tab.loaded/tab.error" |
| ultraviolet | epoxy | request after 6.5 s idle (server closed the keep-alive connection) | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | warm-up "timeout waiting for tab.loaded/tab.error"; first 79 ms; after idle "timeout waiting for tab.loaded/tab.error" |
| ultraviolet | libcurl | request after 6.5 s idle (server closed the keep-alive connection) | pass · pass | pass · pass | warm-up 86 ms; first 36 ms; after idle 73 ms |

### Item 3: isolation of the app origin (and what a proxied page shares)

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| - | - | dev:host-prefixed-cookie-on-http-loopback | pass · pass | pass · pass | __Host- + Secure cookies are accepted on http://127.0.0.1 (usable for dev two-port mode) |
| scramjet | libcurl | virtualized:app-storage | pass · pass | pass · pass | own localStorage: null; top.localStorage: null; top===self: true; idb names: ["__scramjet_controller"] |
| scramjet | libcurl | virtualized:app-endpoints | pass · pass | pass · pass | GET /api/secret via proxy: 401 {"error":"unauthenticated"}; POST /api/state via proxy: 403 {"error":"forbidden"}; app saw: GET /api/secret origin=http://127.0.0.1:22190 … |
| scramjet | libcurl | escaped:app-storage | pass · pass | pass · pass | top: cross-origin (SecurityError); top.localStorage: threw SecurityError; top.indexedDB: threw SecurityError; app secret in proxy-origin storage: null/absent; app framed… |
| scramjet | libcurl | escaped:app-endpoints | pass · pass | pass · pass | with X-GNOME-Request: state threw TypeError, ticket threw TypeError; GET secret cors: threw TypeError, no-cors: type opaque, readable body: false; POST no-cors: type opa… |
| scramjet | libcurl | reach:proxy-origin | pass · pass | pass · pass | engine host: yes (same origin); 1/1 other tab documents accessible; IndexedDB: __scramjet_controller,http://127.0.0.1:22190@__op; caches: (none); SW: /; bus: joined; 0 m… |
| scramjet | libcurl | reach:webrtc-from-page | fail · fail | fail · fail | RTCPeerConnection available; 2 candidates; UDP packets at the local STUN sink: 3 (direct, outside Wisp) |
| scramjet | libcurl | escaped:top-navigation | pass · pass | pass · pass | app URL unchanged; assign: threw SecurityError; replace: threw SecurityError; openTop: returned null; anchorTop: clicked |
| scramjet | libcurl | escaped:top-navigation-user-activation | pass · pass | pass · pass | app URL unchanged; handler: threw SecurityError |
| scramjet | libcurl | virtualized:top-navigation | pass · pass | pass · pass | app URL unchanged; tab now at http://127.0.0.1:22180/?escaped-top-virtualized |
| ultraviolet | epoxy | virtualized:app-storage | pass · pass | pass · pass | own localStorage: null; top.localStorage: null; top===self: true; idb names: ["__op","__scramjet_controller"] |
| ultraviolet | epoxy | virtualized:app-endpoints | pass · pass | pass · pass | GET /api/secret via proxy: 401 {"error":"unauthenticated"}; POST /api/state via proxy: 403 {"error":"forbidden"}; app saw: GET /api/secret origin=http://127.0.0.1:22190 … |
| ultraviolet | epoxy | escaped:app-storage | pass · pass | pass · pass | top: cross-origin (SecurityError); top.localStorage: threw SecurityError; top.indexedDB: threw SecurityError; app secret in proxy-origin storage: null/absent; app framed… |
| ultraviolet | epoxy | escaped:app-endpoints | pass · pass | pass · pass | with X-GNOME-Request: state threw TypeError, ticket threw TypeError; GET secret cors: threw TypeError, no-cors: type opaque, readable body: false; POST no-cors: type opa… |
| ultraviolet | epoxy | reach:proxy-origin | pass · pass | pass · pass | engine host: yes (same origin); 1/1 other tab documents accessible; IndexedDB: __op,__scramjet_controller; caches: (none); SW: /; bus: joined; 0 messages in 1.5 s; cooki… |
| ultraviolet | epoxy | reach:webrtc-from-page | fail · fail | fail · fail | RTCPeerConnection available; 2 candidates; UDP packets at the local STUN sink: 3 (direct, outside Wisp) |
| ultraviolet | epoxy | escaped:top-navigation | pass · pass | pass · pass | app URL unchanged; assign: threw SecurityError; replace: threw SecurityError; openTop: returned null; anchorTop: clicked |
| ultraviolet | epoxy | escaped:top-navigation-user-activation | pass · pass | pass · pass | app URL unchanged; handler: threw SecurityError |
| ultraviolet | epoxy | virtualized:top-navigation | pass · pass | pass · pass | app URL unchanged; tab now at http://127.0.0.1:22180/?escaped-top-virtualized |

In words (identical in both runs, both browsers, both engines):

| Attempt | Virtualized (the page's own, engine-rewritten script) | Escaped (unrewritten JS in the proxied document) |
| --- | --- | --- |
| Read app localStorage / IndexedDB | `top === self` (the engines virtualize `top`): own proxied storage, `null` | `window.top.localStorage` / `.indexedDB` → `SecurityError`; the proxy origin's own storage holds no app data; the app framed by the attacker is unreadable (and refused by its `frame-ancestors 'self'`) |
| Credentialed app call with `X-GNOME-Request: 1` | goes through Wisp from the server side, without the user's cookies: `GET /api/secret` → 401, `POST /api/state` → 403 | the CORS preflight is refused (no CORS on the app) → `TypeError`; no POST reached the server, no ticket was minted |
| Navigate the app's top window | navigates the tab frame itself (`top` = the proxied page) | assign / replace → `SecurityError`; `open(url, '_top')` → `null` (Chromium) / `InvalidAccessError` (Firefox); `<a target=_top>` ignored; with user activation → `SecurityError`; app URL unchanged |

Escaped **simple** requests without the custom header do reach the app: a credentialed `GET /api/secret` arrives with
the session cookie (the proxy origin is same-site with the app, so `SameSite=Strict` does not stop it), but its response
is unreadable; `POST` without the header and `sendBeacon` are refused by the CSRF check. GET handlers must therefore
stay side-effect free.

What a proxied page shares on the proxy origin (yes/no observations, names only, no data extracted):

| Facility (proxy origin) | Ordinary proxied page | Escaped page | Notes |
| --- | --- | --- | --- |
| Engine-host window and its realm | no (the engines virtualize `top`/`parent`) | **yes** (`window.top[0]`, same origin) | holds the Scramjet controller, the transports and the app port |
| Other tabs' documents (other proxied sites) | no | **yes** (1/1 other tab readable) | DOM, form values, storage of other sites |
| Engine storage: IndexedDB `__scramjet_controller` (Scramjet jar), `__op` (UV jar) | Scramjet: its own client's jar; UV: `__op` is exempt from UV's IndexedDB renaming (research) | **yes** | both jars hold every proxied site's cookies, HttpOnly included |
| Service-worker registration (scope `/`) | no (`navigator.serviceWorker` is removed in proxied pages) | **yes** | could unregister or update it |
| BroadcastChannel `gnome-engine` | **yes** (no escape needed) | yes | §5, bus integrity: it no longer configures the SW |
| UV transport worker (bare-mux SharedWorker) | – | **yes** | accepts transport code from any same-origin client (code reading) |
| Wisp ticket | not exposed by the engines | **assume yes** | part of the URLs the engine-host realm uses; it only authorizes Wisp |
| Cookies of the proxy **host** | no | **yes**: in dev two-port mode the app's JS-readable `gnome_pref` (cookies are host-scoped, not port-scoped); HttpOnly `gnome_sid` not | production hostnames differ |
| WebRTC (`RTCPeerConnection`) | **yes, sends UDP directly** | yes | not routed through Wisp |

### Item 4: leaks (lab, feature probe, root cause, escaped code, engine-host CSP, bus integrity)

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| scramjet | libcurl | lab:off | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | native 17/53: html-image-set, html-table-background, js-textnode, js-textnode-pr, js-textnode-after, js-textnode-data, js-textnode-nodevalue, js-append-string, js-replac… |
| ultraviolet | epoxy | lab:off | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | native 26/53: html-image-set, html-dsd-style, js-textnode, js-textnode-pr, js-textnode-after, js-textnode-data, js-textnode-nodevalue, js-append-string, js-replacechildr… |
| scramjet | libcurl | lab:enforce | pass · pass | pass · pass | native 0/53: none; stray: js-textnode-rel; csp-blocked 17; native-with-CSP-off constructs blocked now: 17/17 |
| ultraviolet | epoxy | lab:enforce | pass · pass | pass · pass | native 0/53: none; stray: js-textnode-rel; csp-blocked 26; native-with-CSP-off constructs blocked now: 26/26 |
| scramjet | libcurl | csp-probe:off | pass · pass | partial · partial | failing checks: none — Firefox: failing checks: blobWorker=FAIL timeout; urlWorker=FAIL timeout; postMessageFrame=FAIL timeout |
| ultraviolet | epoxy | csp-probe:off | partial · partial | partial · partial | failing checks: dynamicImport=FAIL TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:22181/uv/service/hvtr%3A-%2F325.2.2.3% |
| scramjet | libcurl | csp-probe:enforce | pass · pass | pass · pass | failing checks: none; regressions vs off: none; violations: 0 |
| ultraviolet | epoxy | csp-probe:enforce | pass · pass | pass · pass | failing checks: dynamicImport=FAIL TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:22181/uv/service/hvtr%3A-%2F325.2.2.3%; regressions vs off: n… |
| scramjet | libcurl | rootcause:wikipedia | pass · pass | pass · pass | native 7 (image; initiator other); text-node style inserts with url(): 5 (Node.appendChild), matching native URLs: 1; unrewritten css urls in DOM: 67 {"absolute":60,"rel… |
| ultraviolet | epoxy | rootcause:wikipedia | pass · pass | pass · pass | native 7 (image; initiator other); text-node style inserts with url(): 4 (Node.appendChild), matching native URLs: 1; unrewritten css urls in DOM: 67 {"absolute":60,"rel… |
| scramjet | libcurl | csp-compat:wikipedia | pass · pass | pass · pass | leaks off->on: [en.wikipedia.org] -> [-]; title same: true; imgs 5->5; text 66239->66239; proxied 37->37; violations 7 (self 0) |
| scramjet | libcurl | csp-compat:github | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 13->13; text 2575->2575; proxied 167->168; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:hn | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 2->2; text 4049->4049; proxied 8->8; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:mdn | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 0->0; text 12010->12010; proxied 79->79; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:rust | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 9->9; text 3485->3485; proxied 21->21; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:python | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 3->3; text 3474->3474; proxied 21->21; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:npm | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 0->0; text 261->261; proxied 36->36; violations 0 (self 0) |
| scramjet | libcurl | csp-compat:bbc | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 21->21; text 8643->8643; proxied 105->105; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:wikipedia | pass · pass | pass · pass | leaks off->on: [en.wikipedia.org] -> [-]; title same: true; imgs 5->5; text 66239->66239; proxied 29->29; violations 7 (self 0) |
| ultraviolet | epoxy | csp-compat:github | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 13->13; text 2575->2575; proxied 108->108; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:hn | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 2->2; text 4049->4049; proxied 7->7; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:mdn | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 0->0; text 12010->12010; proxied 41->41; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:rust | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 9->9; text 3485->3485; proxied 20->20; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:python | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 3->3; text 3474->3474; proxied 20->20; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:npm | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 0->0; text 261->261; proxied 9->9; violations 0 (self 0) |
| ultraviolet | epoxy | csp-compat:bbc | pass · pass | pass · pass | leaks off->on: [-] -> [-]; title same: true; imgs 21->21; text 8643->8643; proxied 84->84; violations 0 (self 0) |
| scramjet | libcurl | csp-bypass:own-realm-fetch | pass · pass | pass · pass | no native request; js: resolved |
| scramjet | libcurl | csp-bypass:blank-iframe-fetch | pass · pass | pass · pass | no native request; js: done |
| scramjet | libcurl | csp-bypass:engine-host-fetch | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: rejected TypeError |
| scramjet | libcurl | csp-bypass:engine-host-image | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: set |
| scramjet | libcurl | csp-bypass:popup | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: opened |
| scramjet | libcurl | csp-bypass:self-navigation | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: scheduled |
| scramjet | libcurl | csp-bypass:rtc | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: candidates: host,host |
| ultraviolet | epoxy | csp-bypass:own-realm-fetch | pass · pass | pass · pass | no native request; js: resolved |
| ultraviolet | epoxy | csp-bypass:blank-iframe-fetch | pass · pass | pass · pass | no native request; js: done |
| ultraviolet | epoxy | csp-bypass:engine-host-fetch | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: rejected TypeError |
| ultraviolet | epoxy | csp-bypass:engine-host-image | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: set |
| ultraviolet | epoxy | csp-bypass:popup | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: opened |
| ultraviolet | epoxy | csp-bypass:self-navigation | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: scheduled |
| ultraviolet | epoxy | csp-bypass:rtc | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: candidates: host,host |
| scramjet | libcurl | hostcsp-bypass:own-realm-fetch | pass · pass | pass · pass | no native request; js: resolved |
| scramjet | libcurl | hostcsp-bypass:blank-iframe-fetch | pass · pass | pass · pass | no native request; js: done |
| scramjet | libcurl | hostcsp-bypass:engine-host-fetch | pass · pass | pass · pass | blocked by CSP; js: rejected TypeError |
| scramjet | libcurl | hostcsp-bypass:engine-host-image | pass · pass | pass · pass | blocked by CSP; js: set |
| scramjet | libcurl | hostcsp-bypass:popup | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: opened |
| scramjet | libcurl | hostcsp-bypass:self-navigation | fail (exp.) · fail (exp.) | pass · pass | NATIVE egress; js: scheduled — Firefox: blocked by CSP; js: scheduled |
| scramjet | libcurl | hostcsp-bypass:rtc | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: candidates: host,host |
| ultraviolet | epoxy | hostcsp-bypass:own-realm-fetch | pass · pass | pass · pass | no native request; js: resolved |
| ultraviolet | epoxy | hostcsp-bypass:blank-iframe-fetch | pass · pass | pass · pass | no native request; js: done |
| ultraviolet | epoxy | hostcsp-bypass:engine-host-fetch | pass · pass | pass · pass | blocked by CSP; js: rejected TypeError |
| ultraviolet | epoxy | hostcsp-bypass:engine-host-image | pass · pass | pass · pass | blocked by CSP; js: set |
| ultraviolet | epoxy | hostcsp-bypass:popup | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: opened |
| ultraviolet | epoxy | hostcsp-bypass:self-navigation | fail (exp.) · fail (exp.) | pass · pass | NATIVE egress; js: scheduled — Firefox: blocked by CSP; js: scheduled |
| ultraviolet | epoxy | hostcsp-bypass:rtc | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | NATIVE egress; js: candidates: host,host |
| - | - | hostcsp:init | pass · pass | pass · pass | engines {"scramjet":{"state":"ready","version":"2.0.67-alpha.2","detail":null},"ultraviolet":{"state":"ready","version":"3.2.10","detail":null}}; transports {"scramjet":… |
| scramjet | libcurl | hostcsp-site:wikipedia | pass · pass | pass · pass | loaded 1774 ms, title "Gnome - Wikipedia"; proxied 40; native/egress [-] |
| scramjet | libcurl | hostcsp-site:github | pass · pass | pass · pass | loaded 2585 ms, title "GitHub - MercuryWorkshop/scramjet: Scramjet is a versatile web proxy designed to bypass internet censorship. · GitHub"; proxied 168; native/egress… |
| ultraviolet | epoxy | hostcsp-site:wikipedia | pass · pass | pass · pass | loaded 840 ms, title "Gnome - Wikipedia"; proxied 29; native/egress [-] |
| ultraviolet | epoxy | hostcsp-site:github | pass · pass | pass · pass | loaded 2163 ms, title "GitHub - MercuryWorkshop/scramjet: Scramjet is a versatile web proxy designed to bypass internet censorship. · GitHub"; proxied 108; native/egress… |
| - | - | hostcsp:engine-host-violations | pass · pass | pass · pass | no CSP violation reported by the engine host document while both engines ran |

Per-site rows (`site:<key>:<mode>`) are summarized in §5.3; the per-construct verdicts are in §5.2.

Bus integrity (`leak` part `cspbus`, added in session 4 after run 2 had started; focused run on ports 22260–22299, both
browsers):

| Engine | Transport | Test | Chromium | Firefox | Notes |
| --- | --- | --- | --- | --- | --- |
| ultraviolet | epoxy | cspbus: forged `sw-config {csp:'off'}` from an ordinary proxied page | pass | pass | after the page posted it for 3 s, the next UV leak page: 0 native egress, 26 (Chromium) / 25 (Firefox) CSP violations |
| ultraviolet | epoxy | cspbus: legacy bus config (`swConfigBus=1`, the session-3 SW) | fail (exp.) | fail (exp.) | the forged message switched the UV CSP off: 26 / 25 constructs reached the network directly, 0 violations |

### Item 5: Wisp tickets and reconnect (strict session-4 gateway parser)

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| scramjet | libcurl | ticket-form ?t=<ticket> | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | engine failed: The Websocket URL must end with a trailing forward slash. |
| ultraviolet | epoxy | ticket-form ?t=<ticket> | pass · pass | pass · pass | ok 178 ms; sockets connecting,open |
| scramjet | libcurl | ticket-form ?t=<ticket>/ | fail (exp.) · pass | fail (exp.) · pass | ok 154 ms; sockets connecting,open |
| ultraviolet | epoxy | ticket-form ?t=<ticket>/ | fail (exp.) · pass | fail (exp.) · pass | ok 176 ms; sockets connecting,open |
| scramjet | libcurl | ticket-form ?t=<ticket>&/ | pass · pass | pass · pass | ok 155 ms; sockets connecting,open |
| ultraviolet | epoxy | ticket-form ?t=<ticket>&/ | pass · pass | pass · pass | ok 165 ms; sockets connecting,open |
| scramjet | epoxy | ticket-form ?t=<ticket> | pass · pass | pass · pass | ok 149 ms; sockets connecting,open |
| ultraviolet | libcurl | ticket-form ?t=<ticket> | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | engine failed: The Websocket URL must end with a trailing forward slash. |
| scramjet | epoxy | ticket-form ?t=<ticket>/ | fail (exp.) · pass | fail (exp.) · pass | ok 142 ms; sockets connecting,open |
| ultraviolet | libcurl | ticket-form ?t=<ticket>/ | fail (exp.) · pass | fail (exp.) · pass | ok 87 ms; sockets connecting,open |
| scramjet | epoxy | ticket-form ?t=<ticket>&/ | pass · pass | pass · pass | ok 143 ms; sockets connecting,open |
| ultraviolet | libcurl | ticket-form ?t=<ticket>&/ | pass · pass | pass · pass | ok 88 ms; sockets connecting,open |
| scramjet | libcurl | initial connect carries ?t= | pass · pass | pass · pass | ok 154 ms; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | epoxy | initial connect carries ?t= | pass · pass | pass · pass | ok 164 ms; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | libcurl | drop: transport reconnects by itself (watchdog off) | pass · pass | pass · pass | ok 106 ms; new sockets after drop: 1 (?t=<ticket>&/); dropped 2 |
| ultraviolet | epoxy | drop: transport reconnects by itself (watchdog off) | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | FAILED (timeout/timeout: no document within 8000 ms); new sockets after drop: 0 (); dropped 2 |
| ultraviolet | epoxy | drop: recreate transport (same ticket) restores it | pass · pass | pass · pass | recreate 1 ms; ok 139 ms |
| scramjet | libcurl | recipe: gateway drop -> recovered | pass · pass | pass · pass | ok 116 ms; libcurl reconnected on next request; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | epoxy | recipe: gateway drop -> recovered | pass · pass | pass · pass | ok 136 ms; watchdog recreated transport 2 ms after drop; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | libcurl | recipe: gateway kill + restart -> recovered | pass · pass | pass · pass | ok 107 ms; lazy reconnect; reconnect attempts while down 0; upgrades after restart {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | epoxy | recipe: gateway kill + restart -> recovered | pass · pass | pass · pass | ok 135 ms; recreated 470 ms after restart; reconnect attempts while down 0; upgrades after restart {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | libcurl | recipe: ticket rotation -> new ticket minted, transports recreated | pass · pass | pass · pass | ok 102 ms; ticket requests +1; ticket recreation 6 ms after rotation; old-ticket upgrades refused 0; upgrades {"101:query+amp-slash:ZXQtMg":2} |
| ultraviolet | epoxy | recipe: ticket rotation -> new ticket minted, transports recreated | pass · pass | pass · pass | ok 135 ms; ticket requests +1; ticket recreation 6 ms after rotation; old-ticket upgrades refused 0; upgrades {"101:query+amp-slash:ZXQtMg":2} |
| scramjet | libcurl | recipe: proactive renewal before expiry | pass · pass | pass · pass | ok 100 ms; needTicket{expiring} -> new ticket 1517 ms after set (scheduled 1500); transports recreated ultraviolet,scramjet,ultraviolet; set took 2 ms |
| ultraviolet | epoxy | recipe: proactive renewal before expiry | pass · pass | pass · pass | ok 129 ms; needTicket{expiring} -> new ticket 1517 ms after set (scheduled 1500); transports recreated ultraviolet,scramjet,ultraviolet; set took 2 ms |
| scramjet | libcurl | recipe: lazy renewal (no socket leak) then drop -> new ticket | pass · pass | pass · pass | ok 109 ms; renewed 1520 ms after set; rebuilt on renewal: scramjet,scramjet (expected yes); live sockets 3 -> 3; upgrades after drop {"101:query+amp-slash:ZXQtMQ":2} (ne… |
| ultraviolet | epoxy | recipe: lazy renewal (no socket leak) then drop -> new ticket | pass · pass | pass · pass | ok 133 ms; renewed 1520 ms after set; rebuilt on renewal: scramjet,scramjet (expected no); live sockets 3 -> 3; upgrades after drop {"101:query+amp-slash:ZXQtMQ":2} (new… |
| both | libcurl+epoxy | old sockets closed after recreation | pass · pass | pass · pass | live Wisp sockets at the gateway: start:2 drop:2 restart:2 rotation:2 renewal:3 lazy:2 open-by-side:{"scramjet/libcurl":1,"ultraviolet/epoxy":1} end:2 (expected 2: one p… |
| scramjet | epoxy | initial connect carries ?t= | pass · pass | pass · pass | ok 140 ms; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | libcurl | initial connect carries ?t= | pass · pass | pass · pass | ok 87 ms; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | epoxy | drop: transport reconnects by itself (watchdog off) | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | FAILED (timeout/timeout: no document within 8000 ms); new sockets after drop: 0 (); dropped 2 |
| ultraviolet | libcurl | drop: transport reconnects by itself (watchdog off) | pass · pass | pass · pass | ok 73 ms; new sockets after drop: 1 (?t=<ticket>&/); dropped 2 |
| scramjet | epoxy | drop: recreate transport (same ticket) restores it | pass · pass | pass · pass | recreate 70 ms; ok 106 ms |
| scramjet | epoxy | recipe: gateway drop -> recovered | pass · pass | pass · pass | ok 101 ms; watchdog recreated transport 69 ms after drop; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | libcurl | recipe: gateway drop -> recovered | pass · pass | pass · pass | ok 71 ms; libcurl reconnected on next request; upgrades {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | epoxy | recipe: gateway kill + restart -> recovered | pass · pass | pass · pass | ok 62 ms; recreated 1264 ms after restart; reconnect attempts while down 0; upgrades after restart {"101:query+amp-slash:ZXQtMQ":2} |
| ultraviolet | libcurl | recipe: gateway kill + restart -> recovered | pass · pass | pass · pass | ok 70 ms; lazy reconnect; reconnect attempts while down 0; upgrades after restart {"101:query+amp-slash:ZXQtMQ":2} |
| scramjet | epoxy | recipe: ticket rotation -> new ticket minted, transports recreated | pass · pass | pass · pass | ok 98 ms; ticket requests +1; ticket recreation 67 ms after rotation; old-ticket upgrades refused 0; upgrades {"101:query+amp-slash:ZXQtMg":2} |
| ultraviolet | libcurl | recipe: ticket rotation -> new ticket minted, transports recreated | pass · pass | pass · pass | ok 67 ms; ticket requests +1; ticket recreation 67 ms after rotation; old-ticket upgrades refused 0; upgrades {"101:query+amp-slash:ZXQtMg":2} |
| scramjet | epoxy | recipe: proactive renewal before expiry | pass · pass | pass · pass | ok 100 ms; needTicket{expiring} -> new ticket 1514 ms after set (scheduled 1500); transports recreated scramjet,ultraviolet; set took 63 ms |
| ultraviolet | libcurl | recipe: proactive renewal before expiry | pass · pass | pass · pass | ok 67 ms; needTicket{expiring} -> new ticket 1514 ms after set (scheduled 1500); transports recreated scramjet,ultraviolet; set took 63 ms |
| scramjet | epoxy | recipe: lazy renewal (no socket leak) then drop -> new ticket | pass · pass | pass · pass | ok 98 ms; renewed 1516 ms after set; rebuilt on renewal: ultraviolet,ultraviolet (expected no); live sockets 3 -> 3; upgrades after drop {"101:query+amp-slash:ZXQtMQ":2}… |
| ultraviolet | libcurl | recipe: lazy renewal (no socket leak) then drop -> new ticket | pass · pass | pass · pass | ok 66 ms; renewed 1516 ms after set; rebuilt on renewal: ultraviolet,ultraviolet (expected yes); live sockets 3 -> 3; upgrades after drop {"101:query+amp-slash:ZXQtMQ":2… |
| both | epoxy+libcurl | old sockets closed after recreation | pass · pass | pass · pass | live Wisp sockets at the gateway: start:2 drop:2 restart:2 rotation:2 renewal:3 lazy:2 open-by-side:{"scramjet/epoxy":1,"ultraviolet/libcurl":1} end:2 (expected 2: one p… |
| scramjet | epoxy | recipe vs the session-3 gateway order (plain GET always 426): rotation detected | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | initial ok; in 6 s after rotation+drop: 2 transport rebuilds, 0 upgrades refused with 401, ticket requests +0; then FAILED (network/error-hook: Hyper client: hyper_util:… |
| ultraviolet | epoxy | recipe vs the session-3 gateway order (plain GET always 426): rotation detected | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | initial ok; in 6 s after rotation+drop: 2 transport rebuilds, 0 upgrades refused with 401, ticket requests +0; then FAILED (network/uv-error-page: Error: Hyper client: h… |

### Item 6: controlled fallback Scramjet → Ultraviolet

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| scramjet + ultraviolet | libcurl / epoxy | side by side: one engine host, one SW | pass · pass | pass · pass | scramjet 148 ms, ultraviolet 159 ms in two tabs at once; registrations [{"scope":"http://127.0.0.1:22181/","script":"http://127.0.0.1:22181/sw.js"}] |
| scramjet→ultraviolet | libcurl / epoxy | fallback on Scramjet error hook (injected throw) | pass · pass | pass · pass | loaded on ultraviolet after 165 ms; switched [["error-hook",3]]; same destination true; signals scramjet:error-hook@3ms -> ultraviolet:fallback-start |
| scramjet→ultraviolet | libcurl / epoxy | fallback carries Scramjet cookies to UV | pass · pass | pass · pass | the target received (via UV) cookies ["carried","fb","srvhttp"] (HttpOnly srvhttp carried) |
| scramjet→ultraviolet | libcurl / epoxy | next user navigation returns to Scramjet | pass · pass | pass · pass | engine scramjet, 64 ms |
| scramjet→ultraviolet | libcurl / epoxy | failed POST navigation is not retried on UV | – · pass | – · pass | end tab.error {"kind":"engine","fallback":"available","detail":"injected Scramjet failure (test) (not retried automatically: POST navigation)"}; switched 0; requests to … |
| scramjet→ultraviolet | libcurl / epoxy | fallback on dead Scramjet transport (Wisp 401) | pass · pass | pass · pass | loaded on ultraviolet after 184 ms; switched [["error-hook",16,"Request failed with error code 7: Could not connect to server"]]; signals scramjet:error-hook@16ms -> ult… |
| scramjet→ultraviolet | libcurl / epoxy | timeout: one retry on UV, then a final error | pass · pass | pass · pass | final {"kind":"timeout","engine":"ultraviolet","fallback":"attempted","signal":"timeout"} after 8010 ms; signals scramjet:timeout@4002ms -> ultraviolet:fallback-start ->… |
| scramjet→ultraviolet | libcurl / epoxy | HTTP 404 page is not an engine failure | pass · pass | pass · pass | engine scramjet, switched 0, 148 ms |
| scramjet→ultraviolet | libcurl / epoxy | Scramjet init failure -> UV for every navigation | pass · pass | pass · pass | scramjet failed (scramjet.wasm missing or corrupt) detected in 2 ms of init; navigation on ultraviolet 165 ms |
| scramjet→ultraviolet | libcurl / epoxy | DNS failure: Scramjet error -> UV retry -> final dns error | fail (exp.) · fail (exp.) | fail (exp.) · fail (exp.) | details ["Request failed with error code 7: Could not connect to server","Hyper client: hyper_util::client::legacy::Error(Connect, Io(Custom { kind: UnexpectedEof, error… |
| ultraviolet | epoxy | UV failure signals (DNS) | pass · pass | pass · pass | final tls/uv-error-page after 12 ms; signals ultraviolet:uv-transport-error@4ms -> ultraviolet:uv-error-page@9ms |
| scramjet | libcurl | Scramjet failure signals (DNS, forced engine: no fallback) | pass · pass | pass · pass | final tls/error-hook fallback=available after 21 ms; signals scramjet:error-hook@18ms |

Detection signals and their latency from the start of the navigation (session 4, both runs, both browsers):

| Signal | Source | Latency | Leads to |
| --- | --- | --- | --- |
| Scramjet init failure | engine-host init (wasm magic bytes, transport `init()`, `controller.wait()` with a 10 s timeout) | at init (a few ms for a bad wasm) | every navigation goes to UV, no switch event |
| `error.request` hook | Scramjet `frame.hooks.error.request` | 3 ms (hook throw), 9–16 ms (dead transport / 401), 10–18 ms (DNS) | fallback (if `autoFallback`, not forced, idempotent, attempts < 1) |
| navigation timeout | engine-host timer (`navTimeoutMs`, 20 s default; 4 s in the test) | = the timeout | fallback once, then a final `timeout` error |
| UV transport error | SW `bareClient.fetch` wrapper → `uv-error` | 4–6 ms | final error only (UV is the last engine); also fires for subresources |
| UV error page | `#uvVersion` + `#errorTrace` in the loaded frame | 9–12 ms | final error; the authoritative "document failed" signal (depends on UV's markup) |
| frame left the proxy origin | iframe `load` with a cross-origin `contentWindow` | at load | final error |

### Item 7: keyboard, context menu, fullscreen, find in page (nested proxied frames)

| Engine | Transport | Test | Chromium r1 · r2 | Firefox r1 · r2 | Notes (run 2) |
| --- | --- | --- | --- | --- | --- |
| scramjet | libcurl | keyboard shortcuts forwarded from nested proxied frames | pass · pass | pass · pass | top document: Alt+T Alt+T, Ctrl+Shift+K Ctrl+Shift+K, F6 F6, typing "gnome" (0 forwarded); same-site child frame: Alt+T Alt+T, Ctrl+Shift+K Ctrl+Shift+K, F6 F6, typing "… |
| scramjet | libcurl | context menu request from nested frame | pass · pass | pass · pass | kind link, linkUrl http://127.0.0.1:22190/nested-child?who=same-site-linked, at (495, 209) vs expected (495, 209) in engine-host coordinates |
| scramjet | libcurl | fullscreen from cross-site child frame | pass · pass | pass · pass | fullscreenEnabled true; requestFullscreen -> fs:on; tab.fullscreen on true, off true; app sees engine iframe fullscreen true |
| scramjet | libcurl | fullscreen from same-site child frame | pass · pass | pass · pass | fullscreenEnabled true; requestFullscreen -> fs:on; tab.fullscreen on true, off true; app sees engine iframe fullscreen true |
| scramjet | libcurl | find in page across nested same-origin proxied frames | pass · pass | pass · pass | "needle": 5 matches (active 1 -> next 2 -> prev 1); highlighted ranges top/same/cross [1,2,2], after findClear [0,0,0]; case-sensitive "Needle": 0 |
| ultraviolet | epoxy | keyboard shortcuts forwarded from nested proxied frames | pass · pass | pass · pass | top document: Alt+T Alt+T, Ctrl+Shift+K Ctrl+Shift+K, F6 F6, typing "gnome" (0 forwarded); same-site child frame: Alt+T Alt+T, Ctrl+Shift+K Ctrl+Shift+K, F6 F6, typing "… |
| ultraviolet | epoxy | context menu request from nested frame | pass · pass | pass · pass | kind link, linkUrl http://127.0.0.1:22190/nested-child?who=same-site-linked, at (495, 209) vs expected (495, 209) in engine-host coordinates |
| ultraviolet | epoxy | fullscreen from cross-site child frame | pass · pass | pass · pass | fullscreenEnabled true; requestFullscreen -> fs:on; tab.fullscreen on true, off true; app sees engine iframe fullscreen true |
| ultraviolet | epoxy | fullscreen from same-site child frame | pass · pass | pass · pass | fullscreenEnabled true; requestFullscreen -> fs:on; tab.fullscreen on true, off true; app sees engine iframe fullscreen true |
| ultraviolet | epoxy | find in page across nested same-origin proxied frames | pass · pass | pass · pass | "needle": 5 matches (active 1 -> next 2 -> prev 1); highlighted ranges top/same/cross [1,2,2], after findClear [0,0,0]; case-sensitive "Needle": 0 |

### Item 8: performance (real sites over the production HolyWisp config)

Ranges over 4 samples per cell (2 fresh-browser repetitions × 2 runs). Cold = first load in a fresh profile; warm = median of the next 4 loads in the same tab; init = wall time from opening the app page to the engine host's `init` reply (app page, engine iframe, SW install, both engines and transports); PSS = whole browser process tree over an `about:blank` baseline; JS heap = Chromium CDP `JSHeapUsedSize` of the renderer that runs app, engine host and tabs; long tasks seen by the engine host (Chromium only); timer lag = 50 ms `setInterval` drift in the engine host. Every perf load succeeded in both runs. Treat the numbers as orders of magnitude (shared machine).

| Browser | Engine | Transport | init cold (ms) | init warm (ms) | example.com cold / warm (ms) | Wikipedia cold / warm (ms) | PSS engine host / after 2 tabs (MB) | JS heap (MB) | long tasks (count · ms) | max timer lag (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| chromium | scramjet | epoxy | 254–355 | 271–1798 | 228–262 / 75–82 | 777–1162 / 505–542 | 88–91 / 454–486 | 29–63 | 5–7 · 347–567 | 74–96 |
| chromium | scramjet | libcurl | 251–474 | 152–367 | 280–498 / 78–151 | 845–1769 / 528–634 | 80–92 / 477–496 | 38–69 | 5–12 · 344–1063 | 99–280 |
| chromium | ultraviolet | epoxy | 247–267 | 151–268 | 251–271 / 44–52 | 713–1559 / 398–526 | 83–85 / 425–452 | 11–16 | 0–2 · 0–209 | 71–234 |
| chromium | ultraviolet | libcurl | 247–368 | 257–300 | 238–315 / 45–54 | 793–926 / 423–620 | 99–100 / 409–444 | 12–23 | 0–1 · 0–54 | 77–90 |
| firefox | scramjet | epoxy | 398–449 | 299–490 | 185–219 / 84–91 | 872–887 / 616–698 | 136–149 / 595–724 | – | – | 108–1316 |
| firefox | scramjet | libcurl | 400–401 | 292–415 | 234–1202 / 87–102 | 879–939 / 617–782 | 128–143 / 665–691 | – | – | 102–124 |
| firefox | ultraviolet | epoxy | 397–433 | 291–294 | 221–926 / 64–84 | 780–826 / 636–750 | 134–139 / 533–581 | – | – | 78–92 |
| firefox | ultraviolet | libcurl | 401–416 | 292–295 | 235–241 / 65–72 | 866–1743 / 647–746 | 149–155 / 511–646 | – | – | 67–90 |


## 4. The wiring that passed (copy-pasteable; Wave B's starting point)

The code below is extracted **verbatim** from the harness files that run 2 passed with (checksums in §9.1):
`web/app/app.js` (app side), `web/proxy/engine/index.html` + `host.js` (engine host), `web/proxy/sw.js` (service
worker); `uv-doc-hook.js`, `uv.config.js` and `retry-503.js` are small files next to them. Commands and settings named
`test.*`, `fault`, `swConfigBus` and the CSP `off`/`report-only` switch are spike-only: production hard-wires the CSP
(§5) and drops the test hooks. Find-in-page (`find`, `clearFind`, `tabDocuments`) and the favicon/title observers are in
`host.js` and are not repeated here.

### 4.1 Engine-host page (`<proxy origin>/engine/`): load order

The server templates `%GNOME_APP_ORIGINS%` with the allowed app origins (the same list as `frame-ancestors`).

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="gnome-app-origins" content="%GNOME_APP_ORIGINS%">
<title>GNOME engine host</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #101310; color: #ccc; font: 14px system-ui, sans-serif; }
  #tabs { position: absolute; inset: 0; }
  #tabs > iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  #tabs > iframe[hidden] { display: none; }
  #standalone { padding: 2em; }
</style>
<!-- Engine builds, unmodified, in their required load order (scramjet.js before controller.api.js). -->
<script src="/vendor/scramjet/scramjet.js"></script>
<script src="/vendor/scramjet-controller/controller.api.js"></script>
<script src="/vendor/bare-mux/index.js"></script>
<script src="/vendor/ultraviolet/uv.bundle.js"></script>
<script src="/engine/uv.config.js"></script>
<script type="module" src="/engine/host.js"></script>
</head>
<body>
<div id="tabs"></div>
</body>
</html>
```

### 4.2 App side: embed, handshake, commands, validated events (`web/app/app.js`)

The iframe (`web/app/index.html`): `<iframe id="engine" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation" allow="fullscreen; clipboard-write; autoplay">`; `app.js` installs the listener below, then sets `iframe.src = PROXY_ORIGIN + "/engine/"`. `fetchTicket()` is `POST /api/wisp/ticket` with `X-GNOME-Request: 1`; the validators (`isTab`, `str`, `isHttpUrl`, `FAVICON`) are in the same file.

```js
window.addEventListener('message', (e) => {
  // Only the engine iframe, only from the proxy origin, only the documented hello.
  if (e.source !== iframe.contentWindow || e.origin !== PROXY_ORIGIN) return;
  const d = e.data;
  if (!d || d.gnome !== 'hello' || typeof d.instance !== 'string' || d.instance === instance) return;
  instance = d.instance;
  if (port) port.close();
  if (d.protocol !== PROTOCOL) { statusEl.textContent = 'GNOME was updated, reload'; return; }
  const ch = new MessageChannel();
  port = ch.port1;
  port.onmessage = onMessage;
  T.connects++;
  iframe.contentWindow.postMessage({ gnome: 'connect', protocol: PROTOCOL }, PROXY_ORIGIN, [ch.port2]);
  init().catch((err) => { statusEl.textContent = `init failed: ${err.message}`; T.initError = String(err.message || err); });
});

async function init() {
  const ticket = await fetchTicket();
  const res = await cmd('init', { settings: settingsFromQuery(), ticket, shortcuts: SHORTCUTS }, 40000);
  T.init = res;
  statusEl.textContent = `scramjet: ${res.engines.scramjet.state}, ultraviolet: ${res.engines.ultraviolet.state}`;
  readyResolve(res);
}

function cmd(type, p = {}, timeout = 10000) {
  if (!port) return Promise.reject(new Error('engine host not connected'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type}: timeout`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ k: 'cmd', id, type, p });
  });
}

const VALID = {
  status: (p) => p && typeof p.engines === 'object',
  needTicket: (p) => p && (p.reason === 'expiring' || p.reason === 'rejected'),
  'tab.loading': (p) => isTab(p.tabId) && typeof p.loading === 'boolean',
  'tab.loaded': (p) => isTab(p.tabId) && optUrl(p.url) && ENGINES.includes(p.engine),
  'tab.committed': (p) => isTab(p.tabId) && isHttpUrl(p.url) && ENGINES.includes(p.engine) && ['navigate', 'reload', 'history', 'same-document'].includes(p.kind),
  'tab.title': (p) => isTab(p.tabId) && str(p.title, 1024),
  'tab.favicon': (p) => isTab(p.tabId) && (p.icon === null || (str(p.icon, 90000) && FAVICON.test(p.icon))),
  'tab.error': (p) => isTab(p.tabId) && ERROR_KINDS.includes(p.kind) && optStr(p.detail, 1000) && ENGINES.includes(p.engine),
  'tab.engineSwitched': (p) => isTab(p.tabId) && ENGINES.includes(p.from) && ENGINES.includes(p.to),
  'tab.openRequest': (p) => isTab(p.openerTabId) && isHttpUrl(p.url) && ['foreground', 'background', 'popup'].includes(p.disposition),
  'tab.contextMenu': (p) => isTab(p.tabId) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.target && ['link', 'image', 'editable', 'selection', 'page'].includes(p.target.kind) && optUrl(p.target.linkUrl) && optUrl(p.target.srcUrl) && optStr(p.target.selectionText, 2000),
  'tab.key': (p) => isTab(p.tabId) && SHORTCUTS.includes(p.combo),
  'tab.fullscreen': (p) => isTab(p.tabId) && typeof p.active === 'boolean',
  'download.started': (p) => str(p.downloadId, 64) && isTab(p.tabId) && isHttpUrl(p.url) && str(p.filename, 255) && !/[/\\]/.test(p.filename),
  'download.progress': (p) => str(p.downloadId, 64) && Number.isFinite(p.received),
  'download.done': (p) => str(p.downloadId, 64) && ['completed', 'failed', 'cancelled'].includes(p.state),
  log: (p) => ['debug', 'info', 'warn', 'error'].includes(p.level) && str(p.message, 1000),
};

function onMessage(e) {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.k === 'res') {
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok) w.resolve(m.p);
    else w.reject(Object.assign(new Error(m.error?.message || 'error'), { code: m.error?.code }));
    return;
  }
  if (m.k !== 'evt') return;
  const ok = typeof m.type === 'string' && VALID[m.type] && m.p && typeof m.p === 'object' && VALID[m.type](m.p);
  if (!ok) { T.rejected.push({ t: Date.now(), type: String(m.type).slice(0, 40) }); return; }
  T.events.push({ seq: ++seq, t: Date.now(), type: m.type, p: m.p });
  if (T.events.length > 5000) T.events.splice(0, 1000);
  if (m.type === 'tab.key') T.shortcuts.push({ combo: m.p.combo, source: 'engine', tabId: m.p.tabId, t: Date.now() });
  if (m.type === 'tab.title') document.getElementById('title').textContent = m.p.title; // text, never HTML
  if (m.type === 'needTicket') renewTicket(m.p.reason);
}

async function renewTicket(reason) {
  if (Date.now() - lastTicketAt < 2000) return; // rate limit (the endpoint is limited to 30/min)
  lastTicketAt = Date.now();
  try { await cmd('ticket', await fetchTicket(), 30000); } catch (err) { T.ticketError = `${reason}: ${err.message}`; }
}
```

### 4.3 Engine host: constants, handshake, command dispatch (`web/proxy/engine/host.js`)

```js
const SJ_CONFIG = {
  prefix: '/~/sj/',
  scramjetPath: '/vendor/scramjet/scramjet.js',
  injectPath: '/vendor/scramjet-controller/controller.inject.js',
  wasmPath: '/vendor/scramjet/scramjet.wasm',
};

const SJ_TRANSPORT_MODULES = { libcurl: '/vendor/libcurl-transport/index.mjs', epoxy: '/vendor/epoxy-transport/index.mjs' };

const UV_TRANSPORT_MODULES = { epoxy: '/vendor/epoxy-transport-bare/index.mjs', libcurl: '/vendor/libcurl-transport-bare/index.mjs' };

// GNOME-imposed CSP for proxied documents (leak mitigation, docs/research/spike-engine-host.md §4).
const GNOME_CSP = [
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "form-action 'self'",
  'report-uri /__csp-report',
].join('; ');
const SCRAMJET_CLIENT = Symbol.for('scramjet client global');

const now = () => performance.now();
const round = (x) => Math.round(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const fail = (code, message) => Object.assign(new Error(message || code), { code });

if (window.parent === window) {
  document.body.innerHTML = '<p id="standalone">This page only works inside GNOME.</p>';
  throw new Error('engine host opened outside GNOME');
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || !e.data || e.data.gnome !== 'connect') return;
  if (!APP_ORIGINS.includes(e.origin)) return; // CSP frame-ancestors already limits who can embed us
  if (e.data.protocol !== PROTOCOL || !e.ports[0]) {
    window.parent.postMessage({ gnome: 'mismatch', protocol: PROTOCOL }, e.origin);
    return;
  }
  clearInterval(helloTimer);
  if (S.port) S.port.close();
  S.port = e.ports[0];
  S.appOrigin = e.origin;
  S.port.onmessage = onCommand;
});

function sayHello() {
  window.parent.postMessage({ gnome: 'hello', protocol: PROTOCOL, build: BUILD, instance: INSTANCE }, '*'); // no secrets in hello
}

async function onCommand(e) {
  const m = e.data;
  if (!m || m.k !== 'cmd' || typeof m.type !== 'string') return;
  const h = handlers[m.type];
  try {
    if (!h) throw fail('unknown_type', `unknown command ${m.type}`);
    const p = await h(m.p || {});
    S.port.postMessage({ k: 'res', id: m.id, ok: true, p: p ?? {} });
  } catch (err) {
    S.port.postMessage({ k: 'res', id: m.id, ok: false, error: { code: err.code || 'error', message: String(err.message || err).slice(0, 500) } });
  }
}
```

### 4.4 Engine host: service worker control, SW config, SW updates

```js
async function ensureServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) throw fail('insecure_context', 'service workers need a secure context');
  const t0 = now();
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const changed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    // A forced reload (Ctrl+Shift+R; also Playwright's Firefox reload) loads the engine host uncontrolled even though
    // the SW is active: ask the SW to clients.claim() it (sw.js "gnome-claim"). First installs claim on activate.
    if (reg.active) reg.active.postMessage({ type: 'gnome-claim' });
    await withTimeout(changed, 5000, 'SW did not take control');
  }
  S.timings.swReady = round(now() - t0);
  pushSwConfig();
}

// SW config goes to the SW's message event, whose source the SW checks (the engine-host client at /engine/):
// ordinary proxied pages have no ServiceWorker object to post from. The gnome-engine BroadcastChannel is NOT used
// for it (any proxied page can join that channel and could switch the UV CSP off); settings.swConfigBus re-enables
// that legacy path for attack tests. Production hard-wires the policy in the SW (no runtime config at all).
function pushSwConfig() {
  if (!S.settings) return;
  const config = { csp: S.settings.csp, cspPolicy: S.settings.cspPolicy, bodyFix: S.settings.bodyFix };
  navigator.serviceWorker.controller?.postMessage({ type: 'gnome-sw-config', config: { ...config, acceptBusConfig: !!S.settings.swConfigBus } });
  if (S.settings.swConfigBus) bus.postMessage({ type: 'sw-config', config });
}

// Another SW took control of this engine host (an updated /sw.js that activated around an app reload, or a claim).
// Scramjet's Controller announces its prefix only to the ServiceWorker object it was built with, so point it at the
// new one (a field of scramjet-controller 0.0.14: re-check on upgrades); the SW's revive then reaches the new worker.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.controller && navigator.serviceWorker.controller) S.controller.serviceWorkerController = navigator.serviceWorker.controller;
    pushSwConfig();
  });
}
```

### 4.5 Engine host: Wisp URL, transports, socket taps

```js
function wispUrl(kind, ticketOverride) {
  const base = new URL(S.settings.route, location.href);
  base.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ticket = ticketOverride ?? S.ticket?.value;
  if (!ticket) return base.href;
  const form = S.settings.ticketForm === 'auto' ? (kind === 'libcurl' ? 'query+slash' : 'query') : S.settings.ticketForm;
  // libcurl-transport (1.x, 2.x) and libcurl.js refuse Wisp URLs that do not END with "/".
  // 'query+amp-slash' ("?t=<ticket>&/") ends with "/" for libcurl and is the gateway's canonical form
  // (backend/src/gateway ticket_param; since session 4 it also strips one trailing "/" from "?t=<ticket>/").
  if (form === 'query+amp-slash') return `${base.href}?t=${encodeURIComponent(ticket)}&/`;
  return `${base.href}?t=${encodeURIComponent(ticket)}${form === 'query+slash' ? '/' : ''}`;
}

const serialized = (fn) => {
  const p = transportLock.then(fn, fn);
  transportLock = p.catch(() => {});
  return p;
};

// Recipe: build, init() BEFORE use (concurrent libcurl init() calls hang), then controller.setTransport().
function setScramjetTransport(reason) {
  return serialized(async () => {
    const kind = S.settings.transports.scramjet;
    const t0 = now();
    const url = S.settings.fault === 'sj-transport-dead' ? wispUrl(kind, 'w1.0.dead.invalid') : wispUrl(kind);
    const mod = await import(SJ_TRANSPORT_MODULES[kind]);
    const Transport = kind === 'libcurl' ? mod.LibcurlClient : mod.default;
    const t = new Transport({ wisp: url });
    await t.init();
    S.sjTransport = t;
    if (S.controller) S.controller.setTransport(t);
    S.transport.scramjet = { state: 'ready', transport: kind, endpoint: S.settings.route, since: Date.now() };
    S.counters.recoveries.push({ side: 'scramjet', reason, ms: round(now() - t0), t: Date.now() });
    status();
    return t;
  });
}

// Recipe: setManualTransport() replaces the transport inside the bare-mux SharedWorker (old one is dropped).
function setUvTransport(reason) {
  return serialized(async () => {
    const kind = S.settings.transports.ultraviolet;
    const t0 = now();
    await S.bareMux.setManualTransport(uvTransportBody(UV_TRANSPORT_MODULES[kind]), [{ wisp: wispUrl(kind) }]);
    S.transport.ultraviolet = { state: 'ready', transport: kind, endpoint: S.settings.route, since: Date.now() };
    S.counters.recoveries.push({ side: 'ultraviolet', reason, ms: round(now() - t0), t: Date.now() });
    status();
  });
}

window.WebSocket = class GnomeWispSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    const rec = { side: 'scramjet', url: redact(url), at: Date.now(), wasOpen: false };
    onWisp({ ...rec, ev: 'connecting' });
    N.on.call(this, 'open', () => { rec.wasOpen = true; onWisp({ ...rec, ev: 'open' }); });
    N.on.call(this, 'close', (ev) => onWisp({ ...rec, ev: 'close', code: ev.code }));
  }
};

// Same tap inside the bare-mux SharedWorker, installed through setManualTransport (a documented bare-mux API).
function uvTransportBody(modulePath) {
  return `
    if (!self.__gnomeWispTap) {
      self.__gnomeWispTap = true;
      const Native = self.WebSocket;
      const bus = new BroadcastChannel('gnome-engine');
      const redact = (u) => String(u).replace(/([?&]t=)[^&]*/, '$1<ticket>');
      self.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(url, protocols);
          const rec = { type: 'wisp', side: 'ultraviolet', url: redact(url), at: Date.now(), wasOpen: false };
          bus.postMessage({ ...rec, ev: 'connecting' });
          this.addEventListener('open', () => { rec.wasOpen = true; bus.postMessage({ ...rec, ev: 'open' }); });
          this.addEventListener('close', (e) => bus.postMessage({ ...rec, ev: 'close', code: e.code }));
        }
      };
    }
    const { default: BareTransport } = await import(${JSON.stringify(modulePath)});
    return [BareTransport, ${JSON.stringify(modulePath)}];`;
}
```

### 4.6 Engine host: watchdog, probe, recovery, tickets

```js
// Plain GET on the Wisp route: the gateway answers 401 for a bad ticket and 426 for a good one.
async function probeRoute() {
  const u = new URL(S.settings.route, location.href);
  if (S.ticket) u.searchParams.set('t', S.ticket.value);
  try {
    return (await fetch(u, { cache: 'no-store' })).status;
  } catch {
    return 0;
  }
}

function onWisp(d) {
  S.counters.wisp.push({ side: d.side, ev: d.ev, code: d.code, wasOpen: d.wasOpen, url: d.url, t: Date.now() });
  const side = d.side;
  if (!S.settings || !S.engines[side] || S.engines[side].state !== 'ready') return;
  if (d.ev === 'open') {
    S.transport[side].state = 'ready';
    status();
  }
  if (d.ev !== 'close') return;
  S.transport[side].state = 'degraded';
  status();
  if (!S.settings.watchdog) return;
  const kind = S.settings.transports[side];
  // libcurl opens a new Wisp connection by itself on the next request after a drop; epoxy never does.
  if (d.wasOpen && kind === 'libcurl') {
    // settings.dropProbe (opt-in): libcurl reconnects with the URL (and ticket) it was built with, so probe the
    // route now and renew a rejected ticket before the next request fails on a 401.
    if (S.settings.dropProbe) {
      probeRoute().then((st) => {
        if (st !== 401) return;
        S.transport[side].state = 'offline';
        status();
        emit('needTicket', { reason: 'rejected' });
      });
    }
    return;
  }
  recover(side, d.wasOpen ? 'drop' : 'connect-failed');
}

function recover(side, reason) {
  if (S.recovery[side]) return S.recovery[side];
  S.recovery[side] = (async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const st = await probeRoute();
      if (st === 426) {
        await (side === 'scramjet' ? setScramjetTransport(`recover:${reason}`) : setUvTransport(`recover:${reason}`));
        return 'recreated';
      }
      if (st === 401) {
        S.transport[side].state = 'offline';
        status();
        emit('needTicket', { reason: 'rejected' });
        return 'need-ticket'; // the "ticket" command recreates both transports
      }
      S.transport[side].state = 'offline';
      status();
      await sleep(Math.min(30000, 250 * 2 ** attempt) * (0.5 + Math.random()));
    }
    return 'gave-up';
  })().finally(() => {
    S.recovery[side] = null;
  });
  return S.recovery[side];
}

function scheduleTicketRenewal() {
  clearTimeout(ticketTimer);
  if (!S.ticket || !S.ticket.expiresAt) return;
  const ms = Math.max(0, S.ticket.expiresAt - Date.now() - 5 * 60e3);
  ticketTimer = setTimeout(() => emit('needTicket', { reason: 'expiring' }), Math.min(ms, 2 ** 31 - 1));
}

  async ticket(p) {
    S.ticket = p;
    scheduleTicketRenewal();
    // settings.lazyRenew (opt-in): the gateway checks tickets only at the upgrade, so a healthy epoxy transport
    // keeps its socket and picks the new ticket up at its next recreation (recreating it now leaves the old socket
    // open). libcurl transports reconnect with the URL they were built with, so they are rebuilt now (cheap: their
    // old socket closes). Transports that are not 'ready' are always rebuilt.
    const rebuild = (side) => !S.settings.lazyRenew || S.transport[side].state !== 'ready' || S.settings.transports[side] === 'libcurl';
    if (S.engines.scramjet.state === 'ready' && rebuild('scramjet')) await setScramjetTransport('ticket');
    if (S.engines.ultraviolet.state === 'ready' && rebuild('ultraviolet')) await setUvTransport('ticket');
    return {};
  },
```

### 4.7 Engine host: engine initialization

```js
async function initScramjet() {
  const e = S.engines.scramjet;
  e.state = 'initializing';
  const t0 = now();
  try {
    if (!window.$scramjetController) throw fail('sj_load', 'controller.api.js did not load (load order?)');
    // The controller does not validate the rewriter wasm (a 404 still "inits"): check the magic bytes.
    const wasmPath = S.settings.fault === 'sj-wasm-missing' ? '/vendor/scramjet/missing.wasm' : SJ_CONFIG.wasmPath;
    const head = new Uint8Array(await (await fetch(wasmPath)).arrayBuffer()).subarray(0, 4);
    if (head.join() !== '0,97,115,109') throw fail('sj_wasm', 'scramjet.wasm missing or corrupt');
    const transport = await setScramjetTransport('init');
    const { Controller } = window.$scramjetController;
    S.controller = new Controller({
      serviceworker: navigator.serviceWorker.controller,
      transport,
      config: SJ_CONFIG,
      scramjetConfig: { flags: { allowFailedIntercepts: true } }, // the controller's own default is lost (deepMerge order)
    });
    await withTimeout(S.controller.wait(), 10000, 'controller.wait() timed out');
    e.state = 'ready';
  } catch (err) {
    e.state = 'failed';
    e.detail = String(err.message || err);
  }
  S.timings.scramjet = round(now() - t0);
}

async function initUltraviolet() {
  const e = S.engines.ultraviolet;
  e.state = 'initializing';
  const t0 = now();
  try {
    if (!window.BareMux || !window.__uv$config) throw fail('uv_load', 'bare-mux or uv.config.js did not load');
    S.bareMux = new BareMux.BareMuxConnection(BARE_MUX_WORKER);
    await withTimeout(setUvTransport('init'), 10000, 'bare-mux setTransport timed out');
    e.state = 'ready';
  } catch (err) {
    e.state = 'failed';
    e.detail = String(err.message || err);
  }
  S.timings.ultraviolet = round(now() - t0);
}
```

### 4.8 Engine host: tabs, Scramjet plugin hooks, loads without history entries, CSP and downloads

```js
function makeTabPlugin(tab) {
  const { ManagedPlugin } = window.$scramjetController;
  class GnomeTabPlugin extends ManagedPlugin {
    constructor() {
      super('gnome-tab', []);
    }
    install(frame) {
      super.install(frame);
      // Hooks must never throw (a throw fails the request); init/lifecycle hooks are not awaited.
      this.tap(frame.hooks.init.post, (ctx) => {
        try {
          attachDocument(ctx.window, 'scramjet');
          if (ctx.isTopLevel) this.tap(ctx.client.hooks.lifecycle.navigate, (_c, p) => sameDocument(tab, String(p.url)));
        } catch (err) { log('error', `init.post: ${err}`); }
      });
      this.tap(frame.hooks.fetch.request, (ctx, props) => {
        try { onSjRequest(tab, ctx, props); } catch (err) { if (err && err.gnomeInjected) throw err; log('error', `fetch.request: ${err}`); }
      });
      this.tap(frame.hooks.fetch.response, (ctx, props) => {
        try { onSjResponse(tab, ctx, props); } catch (err) { log('error', `fetch.response: ${err}`); }
      });
      this.tap(frame.hooks.error.request, (ctx, props) => {
        try { onSjError(tab, ctx, props); } catch (err) { log('error', `error.request: ${err}`); }
      });
    }
  }
  return new GnomeTabPlugin();
}

function ensureFrame(tab, engine) {
  if (tab.iframe && tab.engine === engine) return;
  removeFrame(tab);
  const f = document.createElement('iframe');
  f.name = `tab-${tab.id}`;
  f.allow = 'fullscreen; clipboard-write; autoplay';
  f.hidden = !tab.active;
  N.on.call(f, 'load', () => onIframeLoad(tab, f));
  document.getElementById('tabs').append(f);
  tab.iframe = f;
  tab.engine = engine;
  if (engine === 'scramjet') tab.frame = S.controller.createFrame(f, { plugins: [makeTabPlugin(tab)] });
  else tab.uvPoll = setInterval(() => pollUvUrl(tab), 500); // UV has no same-document navigation hook
}

function proxiedUrl(tab, url) {
  if (tab.engine === 'scramjet') {
    return $scramjet.rewriteUrl(url, tab.frame.context, { origin: new URL(location.href), base: new URL(location.href) });
  }
  return location.origin + __uv$config.prefix + __uv$config.encodeUrl(url);
}

// GNOME-initiated loads replace the frame's current entry, so they never add entries to the app tab's joint
// session history (where a later history.back() could move another frame or the app itself).
function loadInto(tab, proxied) {
  const f = tab.iframe;
  try {
    const w = N.contentWindow.call(f);
    if (w && w.location.href !== 'about:blank' && w.location.origin === location.origin) {
      w.location.replace(proxied);
      return;
    }
  } catch { /* escaped frame: reset it below */ }
  f.src = proxied;
}

function startNav(tab, url, engine, opts) {
  if (tab.nav && tab.nav.timer) clearTimeout(tab.nav.timer);
  const nav = {
    id: ++navSeq, url, engine, kind: opts.kind || 'navigate', auto: !!opts.auto, forced: !!opts.forced,
    historyIndex: opts.historyIndex, startedAt: now(), committed: false, failed: false, loaded: false, download: false,
    method: 'GET', // set from the Scramjet request hook; the fallback re-sends only GET/HEAD navigations
  };
  nav.timer = setTimeout(() => engineFailure(tab, nav, 'timeout', `no document within ${S.settings.navTimeoutMs} ms`), S.settings.navTimeoutMs);
  tab.nav = nav;
  emit('tab.loading', { tabId: tab.id, loading: true });
  return nav;
}

function onSjRequest(tab, ctx, props) {
  const dest = ctx.parsed.destination;
  if ((dest === 'iframe' || dest === 'document') && !ctx.parsed.isIframe) {
    const url = String(props.url.href);
    // Top-level navigation of the tab frame (GNOME-initiated, in-page link, or a redirect hop).
    if (!tab.nav || tab.nav.committed || tab.nav.failed) startNav(tab, url, 'scramjet', { kind: 'navigate' });
    tab.nav.method = String(props.init?.method || ctx.request?.method || 'GET').toUpperCase(); // a form POST, a 307 hop
    if (S.settings.fault === 'sj-throw-marker' && url.includes('gnome-fault=sj-throw')) {
      throw Object.assign(new Error('injected Scramjet failure (test)'), { gnomeInjected: true });
    }
  }
}

function onSjResponse(tab, ctx, props) {
  const dest = ctx.parsed.destination;
  const h = props.response.headers;
  const disposition = String(h.get('content-disposition') || '');
  if (/^\s*attachment/i.test(disposition) && props.response.body) {
    if (tab.nav && !tab.nav.committed && (dest === 'iframe' || dest === 'document')) {
      tab.nav.download = true;
      clearTimeout(tab.nav.timer);
      emit('tab.loading', { tabId: tab.id, loading: false });
    }
    props.response.body = trackSjDownload(tab, String(ctx.parsed.url.href), disposition, h, props.response.body);
    return;
  }
  if (S.settings.csp === 'off') return;
  const type = String(h.get('content-type') || '');
  if (((dest === 'iframe' || dest === 'document') && type.startsWith('text/html')) || dest === 'worker' || dest === 'sharedworker') {
    h.set(cspHeader(), S.settings.cspPolicy);
  }
}

function onSjError(tab, ctx, props) {
  const raw = ctx.rawrequest || {};
  const dest = raw.destination;
  const message = String(ctx.error?.message || ctx.error).slice(0, 500);
  S.counters.sjErrors.push({ tabId: tab.id, dest, url: decodeProxyUrl(raw.rawUrl, tab), message, t: Date.now() });
  const nav = tab.nav;
  if ((dest === 'document' || dest === 'iframe') && nav && !nav.committed && !nav.failed) {
    props.setResponse = {
      body: `<!doctype html><meta charset="utf-8"><title>GNOME</title><p>This page could not be loaded with Scramjet.</p>`,
      status: 502,
      statusText: 'Bad Gateway',
      headers: [['content-type', 'text/html; charset=utf-8']],
    };
    props.suppressError = true;
    // Synchronously: the substitute document above can commit (init.post) before a deferred call would run, which
    // turned the failure into a "loaded" Scramjet error page (docs/research/spike-engine-host.md, item 6). The
    // UV retry itself starts asynchronously (after the cookie copy), once this hook has returned.
    engineFailure(tab, nav, 'error-hook', message);
  }
}

function countingStream(body, onProgress, onDone) {
  let received = 0;
  let last = 0;
  const source = body instanceof ReadableStream ? body : new Response(body).body;
  return source.pipeThrough(new TransformStream({
    transform(chunk, c) {
      received += chunk.byteLength;
      if (performance.now() - last > 200) { last = performance.now(); onProgress(received); }
      c.enqueue(chunk);
    },
    flush() { onDone(received); },
  }));
}

function trackSjDownload(tab, url, disposition, headers, body) {
  const id = `sj-${++downloadSeq}`;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const total = Number(headers.get('content-length')) || null;
  emit('download.started', { downloadId: id, tabId: tab.id, url, filename: m ? decodeURIComponent(m[1]) : 'download', mime: headers.get('content-type') || null, total, engine: 'scramjet' });
  return countingStream(body,
    (received) => emit('download.progress', { downloadId: id, received, total }),
    (received) => emit('download.done', { downloadId: id, state: 'completed', received }));
}
```

### 4.9 Engine host: controlled fallback

```js
function classify(signal, detail) {
  const d = String(detail || '');
  if (signal === 'timeout') return 'timeout';
  if (/resolve|0x42|not known|NXDOMAIN|code 6\b/i.test(d)) return 'dns';
  if (/certificate|SSL|TLS|code 35|code 60/i.test(d)) return 'tls';
  if (/MuxTaskEnded|Multiplexor|websocket|Wisp|code 7\b|Could not connect|Failed to fetch|no bare clients/i.test(d)) return 'network';
  return 'engine';
}

function engineFailure(tab, nav, signal, detail) {
  if (tab.nav !== nav || nav.committed || nav.failed || nav.download) return;
  nav.failed = true;
  clearTimeout(nav.timer);
  const latency = round(now() - nav.startedAt);
  S.counters.signals.push({ tabId: tab.id, navId: nav.id, engine: nav.engine, signal, latency, detail: String(detail).slice(0, 300), t: Date.now() });
  // The retry re-sends the destination as a GET, so a navigation with a request body (form POST) is never retried
  // automatically: that would submit a different request (or the same one twice after a timeout).
  const idempotent = nav.method === 'GET' || nav.method === 'HEAD';
  const canFallback = S.settings.autoFallback && nav.engine === 'scramjet' && !nav.forced && S.engines.ultraviolet.state === 'ready' && tab.attempts < 1 && idempotent;
  if (!idempotent) detail = `${detail} (not retried automatically: ${nav.method} navigation)`;
  if (canFallback) {
    tab.attempts++;
    emit('tab.engineSwitched', { tabId: tab.id, from: 'scramjet', to: 'ultraviolet', reason: signal, detail: String(detail).slice(0, 300), latency });
    copyCookiesToUv(nav.url)
      .catch(() => 0)
      .then((copied) => {
        S.counters.signals.push({ tabId: tab.id, navId: nav.id, engine: 'ultraviolet', signal: 'fallback-start', cookiesCopied: copied, t: Date.now() });
        try {
          navigate(tab, nav.url, { engine: 'ultraviolet', kind: nav.kind, auto: true });
        } catch (err) {
          emit('tab.error', { tabId: tab.id, url: nav.url, kind: 'engine', detail: String(err.message || err), engine: 'ultraviolet', fallback: 'attempted', signal: 'fallback-failed', latency });
        }
      });
    return;
  }
  const fallback = nav.auto ? 'attempted' : nav.engine === 'scramjet' && S.engines.ultraviolet.state === 'ready' ? 'available' : 'none';
  emit('tab.loading', { tabId: tab.id, loading: false });
  emit('tab.error', { tabId: tab.id, url: nav.url, kind: classify(signal, detail), detail: String(detail).slice(0, 300), engine: nav.engine, fallback, signal, latency });
}

// Best effort: copy the destination site's cookies from Scramjet's jar into UV's __op store before a fallback.
function openUvCookieDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('__op', 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('cookies', { keyPath: 'id' });
      store.createIndex('path', 'path');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function copyCookiesToUv(url) {
  if (!S.controller) return 0;
  const host = new URL(url).hostname;
  const jar = JSON.parse(S.controller.cookieJar.dump());
  const rows = Object.values(jar).filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return d && (host === d || host.endsWith('.' + d)) && (c.expires === undefined || c.expires > Date.now());
  });
  if (!rows.length) return 0;
  const db = await openUvCookieDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('cookies', 'readwrite');
    const st = tx.objectStore('cookies');
    for (const c of rows) {
      const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const path = c.path || '/';
      st.put({ name: c.name, value: c.value, domain, path, expires: c.expires ? new Date(c.expires) : undefined, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite, set: new Date(), id: `${domain}@${path}@${c.name}` });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return rows.length;
}
```

### 4.10 Engine host: per-document observation (keys, context menu, commit, title) at any nesting depth

```js
const N = {
  on: EventTarget.prototype.addEventListener,
  preventDefault: Event.prototype.preventDefault,
  stopImmediatePropagation: Event.prototype.stopImmediatePropagation,
  frameElement: (own(window, 'frameElement') || own(Window.prototype, 'frameElement')).get,
  ownerDocument: own(Node.prototype, 'ownerDocument').get,
  defaultView: own(Document.prototype, 'defaultView').get,
  title: own(Document.prototype, 'title').get,
  head: own(Document.prototype, 'head').get,
  body: own(Document.prototype, 'body').get,
  querySelector: Document.prototype.querySelector,
  querySelectorAll: Document.prototype.querySelectorAll,
  getElementById: Document.prototype.getElementById,
  createElement: Document.prototype.createElement,
  createTreeWalker: Document.prototype.createTreeWalker,
  createRange: Document.prototype.createRange,
  appendChild: Node.prototype.appendChild,
  getAttribute: Element.prototype.getAttribute,
  closest: Element.prototype.closest,
  rect: Element.prototype.getBoundingClientRect,
  contentWindow: own(HTMLIFrameElement.prototype, 'contentWindow').get,
  anchorHref: own(HTMLAnchorElement.prototype, 'href').get,
  imgSrc: own(HTMLImageElement.prototype, 'currentSrc').get,
};

function frameChain(win) {
  const chain = [];
  let w = win;
  for (let i = 0; i < 32; i++) {
    let fe;
    try { fe = N.frameElement.call(w); } catch { return chain; }
    if (!fe) return chain;
    chain.push(fe);
    const doc = N.ownerDocument.call(fe);
    if (doc === document) return chain;
    w = N.defaultView.call(doc);
  }
  return chain;
}

// Called for every proxied document: Scramjet init.post, UV document-start hook (uv-doc-hook.js).
function attachDocument(win, engine) {
  const found = tabForWindow(win);
  if (!found) return;
  const { tab, chain } = found;
  const isTop = chain.length === 1;
  const doc = win.document;
  N.on.call(win, 'keydown', (e) => onKey(tab, e), true);
  N.on.call(win, 'contextmenu', (e) => onContextMenu(tab, win, e), true);
  N.on.call(doc, 'securitypolicyviolation', (e) => {
    S.counters.csp.push({ tabId: tab.id, directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 200), t: Date.now() });
  }, true);
  if (!isTop) return;
  const url = documentUrl(win, engine, tab);
  if (tab.nav && !tab.nav.committed && !tab.nav.failed) commit(tab, url, engine);
  else if (url !== tab.url && !(tab.nav && tab.nav.failed && url === tab.nav.url)) commit(tab, url, engine); // navigation started inside the page (not the substitute page of a failed one)
  N.on.call(win, 'popstate', () => sameDocument(tab, documentUrl(win, engine, tab)));
  N.on.call(win, 'hashchange', () => sameDocument(tab, documentUrl(win, engine, tab)));
  const head = N.head.call(doc);
  const titleNow = () => {
    const t = String(N.title.call(doc) || '').slice(0, 1024);
    if (t !== tab.title) { tab.title = t; emit('tab.title', { tabId: tab.id, title: t }); }
  };
  if (head) new MutationObserver(titleNow).observe(head, { subtree: true, childList: true, characterData: true });
  N.on.call(win, 'DOMContentLoaded', titleNow);
}

function comboOf(e) {
  const k = e.key;
  if (!k || k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta' || k === 'Dead') return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3); // layout-independent letters (Alt+T may yield "†")
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  parts.push(key);
  return parts.join('+');
}

function onKey(tab, e) {
  if (e.isComposing) return;
  const combo = comboOf(e);
  if (!combo || !S.shortcuts.has(combo)) return;
  N.preventDefault.call(e);
  N.stopImmediatePropagation.call(e);
  emit('tab.key', { tabId: tab.id, combo });
}
```

### 4.11 Service worker (`/sw.js` on the proxy origin, classic, scope `/`): complete file

Plus the closing `});` of the fetch listener. `web/proxy/engine/uv-doc-hook.js` (the UV document-start hook) and `uv.config.js` are in the same directory.

```js
/* GNOME engine-host service worker (spike of frontend/src/sw/; ARCHITECTURE §5.4).
 * ONE classic SW at scope "/" of the PROXY origin, for both engines:
 *   /~/sj/*        Scramjet controller routing. Held until the controller has (re)announced its prefix, then a
 *                  503 after HOLD_MS. Never passed through to the network. A prefix whose engine-host window
 *                  is gone (app reload) gets an immediate 503 instead of hanging forever.
 *   /uv/service/*  Ultraviolet 3.2.10 with GNOME's fixes: Firefox request bodies, document-start hook, GNOME
 *                  CSP on proxied documents (optional), download progress, error reporting.
 *   everything else passes through (no respondWith).
 */
/* global $scramjetController, UVServiceWorker */
// SW updates: controller.sw.js calls skipWaiting() on install (and clients.claim() on activate), so a new /sw.js (a
// deploy) would take over RUNNING engine hosts at once. Both engines break in that state (verified, session 4):
// Scramjet's Controller keeps announcing its prefix to the old, now redundant worker, and UV requests made more than a
// few seconds after the swap hang. GNOME keeps the normal update flow instead: a new version waits until no engine
// host uses the old one (the next app reload). First installs still activate at once, and gnome-claim still works.
self.skipWaiting = () => Promise.resolve();
importScripts('/vendor/scramjet-controller/controller.sw.js');
importScripts('/vendor/ultraviolet/uv.bundle.js', '/engine/uv.config.js', '/vendor/ultraviolet/uv.sw.js');

const SJ_PREFIX = '/~/sj/';
const UV_PREFIX = self.__uv$config.prefix;
const HOLD_MS = 5000;
const bus = new BroadcastChannel('gnome-engine');
const swStartedAt = Date.now();
// Runtime config pushed by the engine host (lost when the SW restarts; the host re-sends it on "sw-start"). It is
// accepted only from the SW message event of the engine-host client (/engine/). The gnome-engine BroadcastChannel can
// be joined by any proxied page, so it is ignored unless the engine host opted in (settings.swConfigBus, attack
// tests). Production hard-wires the policy here instead of taking any runtime config.
let config = { csp: 'off', cspPolicy: '', bodyFix: true };
let acceptBusConfig = false;
bus.postMessage({ type: 'sw-start', at: swStartedAt });
bus.onmessage = (e) => {
  if (acceptBusConfig && e.data && e.data.type === 'sw-config') config = { ...config, ...e.data.config };
};
function fromEngineHost(source) {
  try { return !!source && source.type === 'window' && new URL(source.url).origin === location.origin && new URL(source.url).pathname === '/engine/'; } catch { return false; }
}

/* ---- Firefox request bodies -------------------------------------------------------------------------------
 * Firefox has no Request.prototype.body (verified: firefox-1555 / Firefox 157). Both engines read it:
 * controller.sw.js forwards `event.request.body` to the controller (it reads the property three times and
 * transfers the third value, so every read must return the SAME object), and bare-mux's BareClient.fetch forwards
 * `new Request(url, init).body` to its SharedWorker. Firefox also has no streaming request bodies, so a
 * ReadableStream body reaching libcurl.js / epoxy is turned into the string "[object ReadableStream]" (verified).
 * Fix (verified in spike-core nav suite): buffer the body into ONE ArrayBuffer before an engine sees the request
 * (bufferBody, WeakMap per Request), and hand bare-mux's internal Request the same ArrayBuffer (nextBody). */
const NATIVE_REQUEST_BODY = 'body' in Request.prototype;
const bufferedBodies = new WeakMap(); // Request -> ArrayBuffer
let nextBody = null; // consumed by the next Request.body read (bare-mux reads it synchronously, see uv.bareClient.fetch)
if (!NATIVE_REQUEST_BODY) {
  Object.defineProperty(Request.prototype, 'body', {
    configurable: true,
    enumerable: true,
    get() {
      if (nextBody) { const b = nextBody; nextBody = null; return b; }
      if (bufferedBodies.has(this)) return bufferedBodies.get(this);
      return null;
    },
  });
}
async function bufferBody(request) {
  if (NATIVE_REQUEST_BODY || !config.bodyFix || request.method === 'GET' || request.method === 'HEAD') return;
  const buf = await request.clone().arrayBuffer();
  if (buf.byteLength) bufferedBodies.set(request, buf);
}

/* ---- Scramjet --------------------------------------------------------------------------------------------- */
const owners = new Map(); // controller prefix ("/~/sj/<id>/") -> clientId of the engine host that announced it
addEventListener('message', (e) => {
  const d = e.data;
  if (d && typeof d === 'object' && d.$controller$init && e.source) owners.set(d.$controller$init.prefix, e.source.id);
  // An engine host loaded by a forced reload is uncontrolled; it asks to be claimed (host.js ensureServiceWorker).
  if (d && typeof d === 'object' && d.type === 'gnome-claim') e.waitUntil(self.clients.claim());
  if (d && typeof d === 'object' && d.type === 'gnome-sw-config' && d.config && typeof d.config === 'object' && fromEngineHost(e.source)) {
    const { acceptBusConfig: viaBus, ...rest } = d.config;
    config = { ...config, ...rest };
    acceptBusConfig = viaBus === true;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unavailable(request, reason) {
  bus.postMessage({ type: 'sw-503', reason, path: new URL(request.url).pathname.slice(0, 120), dest: request.destination });
  const doc = request.destination === 'document' || request.destination === 'iframe';
  const body = doc
    ? `<!doctype html><meta charset="utf-8"><title>Proxy engine unavailable</title><p>GNOME: the proxy engine is not available for this page (${reason}).</p>`
    : '';
  return new Response(body, {
    status: 503,
    statusText: 'Proxy engine unavailable',
    headers: { 'content-type': doc ? 'text/html; charset=utf-8' : 'text/plain', 'cache-control': 'no-store', 'x-gnome-sw': reason },
  });
}

async function handleScramjet(event, url) {
  const t0 = Date.now();
  let lastRevive = 0;
  while (!$scramjetController.shouldRoute(event)) {
    // After a SW restart the controller list is empty until the engine host re-sends its port
    // ($controller$swrevive -> $controller$init). The controller ignores revives in its first 5 s, so repeat
    // the revive while holding.
    if (Date.now() - t0 >= HOLD_MS) return unavailable(event.request, 'not-routable');
    if (Date.now() - lastRevive >= 1000) {
      lastRevive = Date.now();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ $controller$swrevive: {} });
    }
    await sleep(50);
  }
  const held = Date.now() - t0;
  if (held > 0) bus.postMessage({ type: 'sw-held', ms: held, path: url.pathname.slice(0, 80) });
  const prefix = SJ_PREFIX + url.pathname.slice(SJ_PREFIX.length).split('/')[0] + '/';
  const owner = owners.get(prefix);
  if (owner && !(await self.clients.get(owner))) return unavailable(event.request, 'stale-prefix');
  return $scramjetController.route(event);
}

/* ---- Ultraviolet ------------------------------------------------------------------------------------------ */
const uv = new UVServiceWorker();
const DOC_HOOK = '<script src="/engine/uv-doc-hook.js"></script>';

// Report transport errors with the target URL (the UV error page is only the visible half).
const bareFetch = uv.bareClient.fetch.bind(uv.bareClient);
uv.bareClient.fetch = async (target, init) => {
  try {
    if (!NATIVE_REQUEST_BODY && config.bodyFix && init && init.body != null) {
      const buf = init.body instanceof ArrayBuffer ? init.body : await new Response(init.body).arrayBuffer();
      init = { ...init, body: buf };
      nextBody = buf.byteLength ? buf : null; // bare-mux: new Request(target, init).body, read before its first await
      const p = bareFetch(target, init);
      nextBody = null;
      return await p;
    }
    return await bareFetch(target, init);
  } catch (err) {
    bus.postMessage({ type: 'uv-error', url: String(target).slice(0, 300), message: String(err && (err.message || err)).slice(0, 300) });
    throw err;
  }
};

function cspHeaderName() {
  return config.csp === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy';
}

let downloadSeq = 0;
function trackDownload(body, info) {
  const id = `uv-${swStartedAt.toString(36)}-${++downloadSeq}`;
  bus.postMessage({ type: 'download', phase: 'started', id, ...info });
  let received = 0;
  let lastReport = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (Date.now() - lastReport > 200) {
        lastReport = Date.now();
        bus.postMessage({ type: 'download', phase: 'progress', id, received, total: info.total });
      }
      controller.enqueue(chunk);
    },
    flush() {
      bus.postMessage({ type: 'download', phase: 'done', id, state: 'completed', received, total: info.total });
    },
  });
  const source = body instanceof ReadableStream ? body : new Response(body).body;
  return source.pipeThrough(counter);
}

uv.on('response', (event) => {
  const r = event.data; // UV ResponseContext: headers (object, mutable), body, getHeader()
  const req = r.request.request; // the intercepted Request
  const dest = req.destination;
  const type = String(r.getHeader('content-type') || '');
  const disposition = String(r.getHeader('content-disposition') || '');
  if (/^\s*attachment/i.test(disposition) && r.body) {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    r.body = trackDownload(r.body, {
      engine: 'ultraviolet',
      url: String(r.url).slice(0, 500),
      referrer: String(req.referrer || '').slice(0, 500),
      filename: m ? decodeURIComponent(m[1]) : 'download',
      mime: type || null,
      total: Number(r.getHeader('content-length')) || null,
    });
    return;
  }
  if ((dest === 'document' || dest === 'iframe') && type.startsWith('text/html') && typeof r.body === 'string') {
    // Document-start hook (before UV's own injected scripts) so the engine host can observe the document.
    const m = /<head(\s[^>]*)?>/i.exec(r.body);
    if (m) r.body = r.body.slice(0, m.index + m[0].length) + DOC_HOOK + r.body.slice(m.index + m[0].length);
    if (config.csp !== 'off' && config.cspPolicy) r.headers[cspHeaderName()] = config.cspPolicy;
  } else if ((dest === 'worker' || dest === 'sharedworker') && config.csp !== 'off' && config.cspPolicy) {
    r.headers[cspHeaderName()] = config.cspPolicy;
  }
});

async function handleUv(event) {
  return uv.fetch(event);
}

/* ---- dispatch --------------------------------------------------------------------------------------------- */
addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(SJ_PREFIX)) return event.respondWith(bufferBody(event.request).then(() => handleScramjet(event, url)));
  if (url.pathname.startsWith(UV_PREFIX)) return event.respondWith(bufferBody(event.request).then(() => handleUv(event)));
  // Everything else (engine host, vendor files, /wisp/ upgrades, API) goes to the network untouched.
```

## 5. Leaks: root cause and the chosen mitigation

### 5.1 Reproduction and root cause (Wikipedia)

`https://en.wikipedia.org/wiki/Gnome` with the CSP off loads **7 images natively** (not through the engine) in both
engines and both browsers, in both session-4 runs, each confirmed by the sentinel (`CONNECT en.wikipedia.org:443`):
`https://en.wikipedia.org/w/load.php?modules=skins.vector.icons.js&image=<icon>&format=original&lang=en&skin=vector-2022&version=…`
(`speechBubbles`, `article`, `history`, `wikiText`, `edit`, `editLock`, `speechBubbleAdd`). Chromium's CDP initiator is
`other` (once `parser`, Scramjet in run 1): a CSS-initiated load either way.

1. MediaWiki's ResourceLoader ships module CSS inside JS: `mw.loader` → `flushCssBuffer()` → `newStyleTag(cssText)` →
   `el.appendChild(document.createTextNode(cssText))` (stack captured by a document-start tap in
   `load.php?modules=startup`; 4–5 such insertions with `url(` per load).
2. That CSS carries absolute `url(https://en.wikipedia.org/w/load.php?…&image=…)` values: 60 absolute and 7 relative
   unrewritten `url()`s were in the DOM's `<style>` elements in every run.
3. Neither engine rewrites CSS that enters a `<style>` element as a Text node:
   - Scramjet 2.0.67-alpha.2: `packages/core/src/client/dom/element.ts` (shipped source map) hooks the `textContent` /
     `innerText` / `innerHTML` setters and `Text.prototype.appendData/insertData/replaceData/wholeText`, but the
     `Element.prototype.appendChild`/`append` hook for `<style>` (and `<script>`) Text nodes is commented out under
     `// TODO: this needs to be done for all insert methods` (verified in the source map, session 4).
   - UV 3.2.10 rewrites `<style>` text only in its `textContent`/`innerHTML` setter hooks.
4. The browser then fetches the absolute URLs of the elements that render (the 7 visible icons) directly. The relative
   ones resolve against the proxy origin ("stray": broken, not leaked).

It is a client-side CSS-rewriting gap shared by both engines, not an HTML-rewriter or transport problem. The leak lab's
`js-textnode` construct reproduces it locally.

### 5.2 Leak lab: which constructs escape the engines

`/leak/matrix` gives each of 53 constructs its own element and its own unroutable host
(`https://leak-<id>.gnome-spike.invalid/<id>.png?n=<per-load nonce>`). NATIVE = left the browser (sentinel), proxied =
loaded through the engine, stray = an unrewritten relative URL hit the proxy origin, blocked = CSP violation, – = no
request (unsupported in that browser, or the construct threw). Verdicts of run 2; run 1 gave the same verdict for every
construct in all four combinations.

| Construct | chromium/Scramjet | chromium/UV | firefox/Scramjet | firefox/UV | CSP enforced (all 4) |
| --- | --- | --- | --- | --- | --- |
| `html-style` | proxied | proxied | proxied | proxied | proxied |
| `html-style-attr` | proxied | proxied | proxied | proxied | proxied |
| `html-image-set` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `html-import-string` | proxied | proxied | proxied | proxied | proxied |
| `html-svg-style` | proxied | proxied | proxied | proxied | proxied |
| `html-dsd-style` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `html-table-background` | **NATIVE** | proxied | **NATIVE** | proxied | blocked, proxied |
| `html-svg-image` | proxied | proxied | proxied | proxied | proxied |
| `html-img-srcset` | proxied | proxied | proxied | proxied | proxied |
| `html-video-poster` | proxied | proxied | proxied | proxied | proxied |
| `html-input-image` | proxied | proxied | proxied | proxied | proxied |
| `html-preconnect` | – | – | – | – | – |
| `js-textnode` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-textnode-rel` | stray | stray | stray | stray | stray |
| `js-textnode-pr` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-textnode-after` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-textnode-data` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-textnode-nodevalue` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-append-string` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-replacechildren` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-appenddata` | – | **NATIVE** | – | **NATIVE** | blocked, – |
| `js-textcontent` | proxied | proxied | proxied | proxied | proxied |
| `js-innerhtml` | proxied | proxied | proxied | proxied | proxied |
| `js-svg-style` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-shadow-innerhtml` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-insertadjacenthtml` | proxied | proxied | proxied | proxied | proxied |
| `js-iframe-srcdoc` | proxied | proxied | proxied | proxied | proxied |
| `cssom-insertrule` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `cssom-media-insertrule` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `cssom-addrule` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `cssom-replacesync` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `cssom-rule-style-prop` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `cssom-rule-setproperty` | proxied | proxied | proxied | proxied | proxied |
| `style-setproperty` | proxied | proxied | proxied | proxied | proxied |
| `style-camel` | proxied | proxied | proxied | proxied | proxied |
| `style-dashed` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `style-csstext` | proxied | proxied | proxied | proxied | proxied |
| `style-mask` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `style-custom-prop` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `style-setattribute` | proxied | proxied | proxied | proxied | proxied |
| `style-setattributens` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `style-attr-node` | proxied | proxied | proxied | proxied | proxied |
| `style-typed-om` | **NATIVE** | **NATIVE** | – | – | blocked, – |
| `style-animate` | **NATIVE** | **NATIVE** | **NATIVE** | **NATIVE** | blocked |
| `js-img-src` | proxied | proxied | proxied | proxied | proxied |
| `js-img-setattributens` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `js-img-srcset` | **NATIVE** | proxied | **NATIVE** | proxied | blocked, proxied |
| `js-svg-image-href` | proxied | proxied | proxied | proxied | proxied |
| `js-svg-image-baseval` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `js-link-preload` | proxied | proxied | proxied | proxied | proxied |
| `js-fetch` | proxied | proxied | proxied | proxied | proxied |
| `js-fontface` | proxied | **NATIVE** | proxied | **NATIVE** | blocked, proxied |
| `js-beacon` | proxied | proxied | proxied | proxied | proxied |

Native constructs with the CSP off (run 2): chromium/scramjet **17**, chromium/ultraviolet **26**, firefox/scramjet **16**, firefox/ultraviolet **25**; with the CSP enforced: **0** in all four.

Gaps per engine (CSP off, both browsers):
- **Scramjet:** Text nodes in `<style>` (appendChild before/after insertion, `data`, `nodeValue`, `append(string)`,
  `replaceChildren`), SVG `<style>`, `shadowRoot.innerHTML`, `CSSMediaRule.insertRule` (only `CSSStyleSheet.insertRule`
  is hooked), `CSSStyleSheet.addRule`, `cssRule.style.<prop> = …`, `el.animate()` keyframes, `attributeStyleMap.set()`
  (Chromium; Firefox has no Typed OM), `image-set("<string>")`, the legacy `background` attribute, the `img.srcset`
  property. Its `Text.prototype.appendData` hook throws (`Illegal invocation` / `'get parentElement' called on an object
  that does not implement interface Node`), so pages that call `appendData` break under Scramjet.
- **UV:** all Text-node variants plus `appendData`, `shadowRoot.innerHTML`, SVG `<style>`, declarative shadow DOM
  `<style>`, `insertRule`/`replaceSync`/`addRule`, `cssRule.style.<prop>`, dashed property names, `mask-image` and custom
  properties via `setProperty`, `setAttributeNS(null, 'style'|'src', …)`, SVG `href.baseVal`, `FontFace`, `el.animate()`,
  `attributeStyleMap.set()`, `image-set("<string>")`.
- **Both rewrite:** served HTML/CSS (`<style>`, `style=""`, `@import "…"`, SVG `<image>`, `srcset`, `poster`,
  `input[type=image]`, iframe `srcdoc`), `textContent`/`innerHTML`/`insertAdjacentHTML`, `setProperty('background-image')`,
  `cssText`, `setAttribute('style')`, `img.src`, `<link rel=preload>`, `fetch`, `sendBeacon`.

### 5.3 Mitigation: a GNOME CSP on every proxied document and worker (verified)

```
default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'
```

`'self'` is the proxy origin, where every rewritten URL points, so the policy only blocks what an engine failed to
rewrite. Placement (code in §4.8 and §4.11): Scramjet's per-tab `ManagedPlugin` `fetch.response` hook (after Scramjet
deleted the upstream CSP) and UV's SW `response` event (UV deletes upstream CSPs before it), for HTML documents with
destination `document`/`iframe` and for `worker`/`sharedworker` scripts. The spike adds `report-uri /__csp-report` to
count violations; **production must not** (§8.2.4).

Results with the policy enforced, both runs, both browsers:
- **Lab:** 0 native requests in all four engine × browser combinations, and **every construct that went native with
  the CSP off was reported blocked** (Chromium: Scramjet 17/17, UV 26/26; Firefox: Scramjet 16/16, UV 25/25). Relative
  strays stay (they are `'self'`).
- **Feature probe** (`/leak/csp-probe`, 30 checks: inline/eval/`new Function`/string `setTimeout`, wasm, static and
  dynamic modules, fetch/XHR same- and cross-site, WebSocket, beacon, images incl. `data:`/`blob:`, served CSS, inline
  styles, iframes incl. `srcdoc`, blob/URL workers, postMessage, localStorage, IndexedDB, cookies, pushState): **zero
  regressions** against the CSP off and zero violations. The checks that fail, fail with the CSP off too (engine bugs, §7).
- **Real sites** (Wikipedia, GitHub, HN, MDN, rust-lang.org, docs.python.org, npm, BBC): the Wikipedia leak becomes
  exactly 7 violations (the icon URLs) and no site leaks; titles, shown `<img>` counts and text are unchanged within
  live-content variation, and no site produced a `'self'` violation (table below; npm sends Chromium a bot-check page).
- `connect-src 'self'` without `ws:`/`wss:` is enough: neither engine opens WebSockets from the proxied document, and the
  probe's WebSocket check passes. Adding `ws: wss:` would let proxied documents open native WebSockets to any host.

**What it costs (measured):** leaks become blocked loads, so on a real deployment Wikipedia's 7 icons (CSS backgrounds;
the `<img>` counts below do not see them) stay blank; only an engine-side rewrite fixes such pages. Unrewritten relative
URLs stay broken (UV on MDN: 3 SVGs). Nothing else broke in the probe or on the 8 sites.

**What it does not cover:** escaped code (below); and, by code reading only (not tested), proxied documents loaded with
destination `frame`, `object` or `embed`, and documents that are not `text/html` (e.g. SVG, XHTML): the hooks above set
the header only for `document`/`iframe` + `text/html`. Production should set it on every response with a navigable
destination regardless of content type (§8.2.4).

#### Real sites, CSP off vs enforced (run 2)

Leak = hosts reached natively (not CSP-blocked) with the CSP off → enforced; violations with the CSP enforced; shown `<img>` elements off → enforced; title the same in both modes. Run 1 gave the same leak and violation results for every site.

| Site | Engine | Chromium: leak off → on · violations · imgs off → on · title same | Firefox: leak off → on · violations · imgs off → on · title same |
| --- | --- | --- | --- |
| wikipedia | scramjet | [en.wikipedia.org] → [–] · 7 · 5 → 5 · yes (pass) | [en.wikipedia.org] → [–] · 7 · 5 → 5 · yes (pass) |
| github | scramjet | [–] → [–] · 0 · 13 → 13 · yes (pass) | [–] → [–] · 0 · 13 → 13 · yes (pass) |
| hn | scramjet | [–] → [–] · 0 · 2 → 2 · yes (pass) | [–] → [–] · 0 · 2 → 2 · yes (pass) |
| mdn | scramjet | [–] → [–] · 0 · 0 → 0 · yes (pass) | [–] → [–] · 0 · 0 → 0 · yes (pass) |
| rust | scramjet | [–] → [–] · 0 · 9 → 9 · yes (pass) | [–] → [–] · 0 · 9 → 9 · yes (pass) |
| python | scramjet | [–] → [–] · 0 · 3 → 3 · yes (pass) | [–] → [–] · 0 · 3 → 3 · yes (pass) |
| npm | scramjet | [–] → [–] · 0 · 0 → 0 · yes (pass) | [–] → [–] · 0 · 6 → 6 · yes (pass) |
| bbc | scramjet | [–] → [–] · 0 · 21 → 21 · yes (pass) | [–] → [–] · 0 · 22 → 22 · yes (pass) |
| wikipedia | ultraviolet | [en.wikipedia.org] → [–] · 7 · 5 → 5 · yes (pass) | [en.wikipedia.org] → [–] · 7 · 5 → 5 · yes (pass) |
| github | ultraviolet | [–] → [–] · 0 · 13 → 13 · yes (pass) | [–] → [–] · 0 · 13 → 13 · yes (pass) |
| hn | ultraviolet | [–] → [–] · 0 · 2 → 2 · yes (pass) | [–] → [–] · 0 · 2 → 2 · yes (pass) |
| mdn | ultraviolet | [–] → [–] · 0 · 0 → 0 · yes (pass) | [–] → [–] · 0 · 0 → 0 · yes (pass) |
| rust | ultraviolet | [–] → [–] · 0 · 9 → 9 · yes (pass) | [–] → [–] · 0 · 9 → 9 · yes (pass) |
| python | ultraviolet | [–] → [–] · 0 · 3 → 3 · yes (pass) | [–] → [–] · 0 · 3 → 3 · yes (pass) |
| npm | ultraviolet | [–] → [–] · 0 · 0 → 0 · yes (pass) | [–] → [–] · 0 · 6 → 6 · yes (pass) |
| bbc | ultraviolet | [–] → [–] · 0 · 21 → 21 · yes (pass) | [–] → [–] · 0 · 22 → 22 · yes (pass) |

### 5.4 Escaped code and the engine-host CSP

With the proxied-document CSP enforced, escaped code (unrewritten JS in the proxied document) tried each route to an
unroutable host: its own (hooked) `fetch` stayed proxied and an `about:blank` iframe inherits the CSP, but **the
engine-host realm (fetch, image), a popup, navigating the tab frame and WebRTC reached the network directly** in both
engines and browsers (expected failures that document the limit). The same policy on the **engine-host document**
(`frame-ancestors <app>; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src
'self' data:; form-action 'self'`; `data:` because libcurl-transport's Emscripten loader `fetch()`es its wasm from a
`data:` URL) blocks the engine-host realm route in both browsers and native tab-frame navigations (Chromium still opens
one TCP/TLS connection to the target host for the blocked navigation, most likely a speculative preconnect), and both
engines initialize and load Wikipedia and GitHub with no engine-host violation. Popups (the sandbox lets them escape)
and WebRTC (no CSP directive) remain open.

## 6. Recovery recipes (verified unless marked)

| Situation | What the engine host does | Evidence |
| --- | --- | --- |
| Wisp socket dropped, **libcurl** (1.5.2, 2.0.6) | libcurl reconnects by itself on the next request with the URL (and ticket) it was built with; with `dropProbe` the host probes once and renews a rejected ticket before the next request fails | transport: drop rows, recipe drop |
| Wisp socket dropped, **epoxy** (2.1.29, 3.0.2) | epoxy never reconnects: probe the route: `426` → rebuild the transport (same ticket, 1–70 ms); `401` → `needTicket{rejected}`; network error → backoff 250 ms·2ⁿ ±50 %, capped at 30 s, 12 attempts | transport: drop rows, recipe drop |
| Gateway killed and restarted | same; recovered 0.1–1.8 s after the restart (probe backoff; session 3: 0.2–2.9 s); a navigation started during the outage fails and is not retried | recipe: gateway kill + restart |
| Ticket rotated / revoked / expired | the probe (or libcurl `dropProbe`) sees `401` → `needTicket{rejected}` → app `POST /api/wisp/ticket` (rate-limited to 1 per 2 s) → `ticket` command → both transports rebuilt 6–67 ms later; every later upgrade carries the new ticket | recipe: ticket rotation |
| Ticket close to expiry | `needTicket{expiring}` 5 min before `expiresAt` (fired 13–29 ms after its schedule); with `lazyRenew` only libcurl transports are rebuilt, healthy epoxy keeps its socket (rebuilding it would leak the old socket: no transport has a close API) | recipe: proactive / lazy renewal |
| Scramjet engine-level failure (error hook, timeout) on a GET/HEAD navigation | one retry on UV with the same destination, destination-site cookies copied from Scramjet's jar into UV's `__op` (HttpOnly included); the next user navigation returns to Scramjet | fallback rows |
| Scramjet failure on a **POST** (any non-GET/HEAD) navigation | **no** automatic retry (it would send a different request, or the same one twice after a timeout): `tab.error {fallback: 'available'}` | fallback: failed POST (session 4) |
| Scramjet init failure (e.g. bad rewriter wasm) | detected at init in 2–5 ms (wasm magic bytes, transport init, `controller.wait()` 10 s timeout); every navigation goes to UV, no switch event | fallback: init failure |
| SW stopped by the browser (idle) | the next request starts a new SW instance; Scramjet requests are **held** (≤ 5 s) while the SW asks window clients to revive and the controller re-announces its prefix (routed after 50 ms); the engine host re-sends the SW config on `sw-start`; UV documents kept the CSP | sw: SW lifecycle stop (Chromium only: CDP) |
| New `/sw.js` deployed while engine hosts run | GNOME's SW neutralizes `controller.sw.js`'s `skipWaiting()`, so the new version **waits**; both engines keep working; Chromium applies it at the next app reload; Firefox kept the old worker across Playwright's (forced) reload. On `controllerchange` the host points Scramjet's controller at the new worker and re-sends the SW config | sw: SW lifecycle update rows |
| App reload | the new engine host says `hello` with a new instance id, the app reconnects; the engine host has no tabs: the app restores tabs from **real** URLs; old Scramjet URLs get `503 stale-prefix` in 1 ms; UV URLs are stateless | sw: app reload rows |
| Forced reload (Ctrl+Shift+R) | the engine host loads uncontrolled; it posts `gnome-claim` and the SW calls `clients.claim()` | sw: forced reload (Chromium CDP; Firefox's Playwright reload is forced) |
| Rebuild loop protection | **recommended, not tested**: cap rebuilds per side (e.g. 6/min) and report `offline`; treat a `429` from the probe (it shares the gateway's 60/min upgrade budget) as backoff, not as "gateway down" | – |
| Failed navigation after a recovery | **recommended, not tested**: retry the last failed GET navigation once after the transport is ready again | – |

## 7. Limitations (with repro)

1. **epoxy keep-alive hang** (upstream; epoxy-transport 2.1.29 and 3.0.2, both engines, both browsers): the first
   request after the site closed an idle pooled HTTP/1.1 connection never completes (the Wisp connection stays open).
   Repro: `nav` row *request after 6.5 s idle*; or `?uvt=epoxy` / `?sjt=epoxy`, load a page, wait > 5 s (Node's
   keep-alive timeout), load another page from the same host. libcurl never hangs. Real servers close idle connections
   after 5–75 s, so this hits real browsing.
2. **epoxy never reconnects** after a Wisp drop (upstream): `transport` row *drop: transport reconnects by itself
   (watchdog off)*; the watchdog rebuild is required.
3. **UV + libcurl 1.5.2 in Firefox:** the first request after `setManualTransport` can fail with `wasm not loaded yet,
   please call libcurl.load_wasm first` (both runs: the `nav` alt-transport warm-up row). The engine host needs an init
   retry before declaring UV/libcurl ready.
4. **UV WebSocket to echo.websocket.org** opens and delivers the server's greeting but never echoes (both browsers, both
   runs); postman-echo works through UV, and Scramjet echoes both. Not investigated (possibly a send-before-ready race
   in UV/bare-mux). `nav` row *public WebSocket echo*.
5. **Error kinds:** HolyWisp's Wisp CLOSE reason (0x42 unreachable/DNS, 0x48 blocked) is not surfaced by any transport,
   so `dns`/`tls`/`network` cannot be told apart (a DNS failure arrives as "code 7 Could not connect", "code 35 SSL
   connect error" or a hyper `UnexpectedEof … tls`). `fallback` row *DNS failure* (expected failure).
6. **No transport has a close/destroy API:** rebuilding a healthy epoxy transport leaks its old Wisp socket until the
   next drop (live sockets 2 → 3 at the gateway after a renewal that rebuilt a healthy epoxy transport; each counts
   against the per-session cap of 16). `lazyRenew` avoids it for renewals; `transport` row *old sockets closed after
   recreation* (its socket log shows `renewal:3`, then 2 after the lazy-renewal step).
7. **Downloads** are the browser's own (the sandbox has `allow-downloads`): progress is observable for both engines,
   but GNOME cannot cancel or pause them, and the proxied URL works only while the engine host lives. A navigation that
   turns into a download never produces `tab.loaded`. `nav` download rows.
8. **Joint session history:** GNOME-initiated loads add no entries, but in-page navigations (links, form submits) inside
   a tab add entries to the app tab's history, so the browser's Back button then moves the proxied frame. `nav` row
   *joint session history*. Not solved here.
9. **Find-in-page** is visible to the page (a `<style id="gnome-find-style">` and highlight names in `CSS.highlights`);
   frames that escaped to a real cross-origin URL and shadow roots are not searched (code).
10. **CSS-rewriting gaps** (§5.2) are blocked, not fixed, by the CSP; unrewritten relative URLs stay broken. Engine bugs
    independent of the CSP (`leak` probe rows, partial): Scramjet `Text.appendData` throws; UV dynamic `import()` fails
    in both browsers; in Firefox Scramjet's blob/URL workers and `postMessage` from a `srcdoc` frame time out and UV's
    workers error. Repro: `SPIKE_LEAK_PARTS=probe SPIKE_LEAK_MODES=off`.
11. **Escaped code is not bound by the proxied-document CSP** (§5.4); with the engine-host CSP, popups and WebRTC remain
    and Chromium still preconnects for a blocked tab-frame navigation. `leak` rows `csp-bypass:*`, `hostcsp-bypass:*`.
12. **WebRTC** works in ordinary proxied pages of both engines and sends STUN/UDP directly (3 packets per check in
    Chromium, 5 in Firefox with `media.peerconnection.ice.loopback=true` so the loopback sink can see them); ICE reveals
    the user's addresses. `isolation` row *reach:webrtc-from-page* (fails on purpose until the kill switch exists).
13. **SW updates in Firefox:** a waiting `/sw.js` was not applied across Playwright's (forced) reload of the app; the
    engines kept working on the old worker. `sw` row *the update applies at the next app reload* (expected failure in
    Firefox). An explicit apply step is needed (§8.2.3).
14. **Playwright + Firefox frame reads:** `frame.evaluate()` on a tab iframe can stay pending forever after a GNOME
    `location.replace()` navigation; the harness now gives every frame read an 8 s deadline (`lib/drive.mjs`).
15. **Only the gateway stub was exercised** (strict `ticket_param` copy, the 401/426 probe, Origin and ticket checks);
    gnome-server's caps, rate limits (60 upgrades + probes per minute per IP) and session revocation were not.
16. **Dev variant only:** two ports on `http://127.0.0.1`, headless. Production uses two hostnames over HTTPS: host-only
    cookies do not cross hostnames there, `Domain=` and `__Host-` rules apply; secure-context rules are the same. In the
    dev two-port mode the proxy origin shares the app host's cookie jar (the app's JS-readable `gnome_pref` was visible
    to escaped code; HttpOnly `gnome_sid` was not); `__Host-` + `Secure` cookies are accepted on `http://127.0.0.1` in
    both browsers. `gnome_pref` is a cookie of the spike's app stub only: the real `gnome-server` sets no JS-readable
    cookie (§11.3 (4)).
17. **Real sites change** (bot checks, A/B variants): npm answers Chromium with a bot-check page; lazy images outside the
    viewport are not counted; native requests fail at the sentinel, so second-order loads of a leak are not observed.
18. **Performance** comes from one machine shared with other agents, real-network sites and 2 cold samples per cell per
    run; the PSS tree includes the app shell and Playwright's blank page; Firefox has no long-task API.
19. **Storage partitioning** is disabled by Playwright by default; only the partitioning rows re-enable it (Chromium
    `--disable-features` without `ThirdPartyStoragePartitioning`, Firefox `cookieBehavior=5`), and the cross-site
    control row proves it is active there.
20. **Spike-only runtime config:** the SW takes the UV CSP mode from the engine host at runtime (after every SW start);
    production hard-wires the policy in the SW. The `gnome-engine` BroadcastChannel (SW → host signals: downloads, UV
    errors, worker socket taps) can be joined, read and written by any proxied page; the adversarial review covers what
    that allows (§11.2.2, B4/B5).
21. **libcurl sends `Upgrade: h2c`** on plain-`http:` requests (observed at the local target, which now routes only
    `websocket` upgrades to its upgrade handler). Real servers ignore it; a server that accepts h2c would switch that
    request to cleartext HTTP/2 inside the Wisp stream. Only plain-HTTP sites are affected.

## 8. Recommended changes (not applied to those documents)

### 8.1 ARCHITECTURE §4.6 (origins, tickets)

Already applied by the backend in session 4 (verified by reading `backend/src/gateway/mod.rs`, its tests and §4.4/§4.6):
the canonical ticket URL `wss://<proxy>/wisp/?t=<ticket>&/` (also accepted: `?t=<ticket>`, `?t=<ticket>/`;
percent-decoded; a second `t` refused), the plain-GET/HEAD probe (`401 wisp_ticket_*` / `426`, no `Origin`, no slot,
shares the 60/min upgrade budget), "tickets are checked only at the upgrade", and the 1 h ticket TTL. Still to add:

1. **Verified status:** a same-site, cross-origin engine host in the specified sandbox gets SW, IndexedDB and Cache
   Storage in Chromium 156 and Firefox 157, also with storage partitioning on; a cross-site proxy hostname works but
   partitions all engine state (proxied cookies, SW, caches) under the app's site, so keep the proxy origin a sibling
   subdomain of the app's registrable domain.
2. **Engine-host CSP** (verified experiment, §5.4): serve `/engine/` with `frame-ancestors <app origin>; default-src 'self'
   data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data:; form-action 'self'`. Custom Wisp
   servers (`browser.wispServers`) would need their `ws:`/`wss:` origins in `connect-src` (not tested).
3. **Engine iframe sandbox:** `allow-popups allow-popups-to-escape-sandbox` lets escaped code open unproxied top-level
   windows (measured). **Decided 2026-11-11** (PROGRESS decisions log), after the adversarial review tested the sandbox
   without them (§11.3 (2): `window.open` returns `null` in Chromium and throws in Firefox): drop both flags and open
   `window.open`/`target=_blank` as GNOME tabs through `tab.openRequest`. Cost: OAuth/payment popups that need a window
   reference must fall back to a full-page redirect.
4. **Dev two-port mode** shares the host's cookie jar: use the `__Host-` cookie names on loopback HTTP too (both browsers
   accept them; parity with production, although on one host they cannot keep the two ports apart, §11.3 (4)), and
   state that GET handlers receive the session from escaped proxied pages (same-site) and must stay side-effect free
   (already true for the API; keep it a rule).
5. Serve `/vendor/bare-mux/worker.js` with a CSP (`connect-src 'self'`): it accepts transport code from any same-origin
   client and runs without one (code reading).
6. State plainly what proxied sites share with each other and with the engine host (§3 item 3 "reach" row): the UI must
   never promise isolation between proxied sites or IP protection against hostile pages.
7. **`/sw.js` updates:** a new version must not take over running engine hosts (it breaks both engines, §3 item 1): the
   SW neutralizes `skipWaiting()` and the update applies when no engine host uses the old version (§8.2.3).

### 8.2 ARCHITECTURE §5.4 (engines, transports, SW)

1. **Default transport libcurl for both engines** (Scramjet: libcurl-transport 2.0.6; UV: libcurl-transport 1.5.2 with an
   init retry, limitation 3) until the epoxy keep-alive hang is fixed upstream; epoxy only as an explicit choice. The
   §5.4 package table lists epoxy first for UV today.
2. **Transport manager:** replace "epoxy does not reconnect … watchdog recreates the transport" with the verified rules
   of §6: libcurl reconnects by itself with its constructor URL (probe once per drop, renew on 401); epoxy never does
   (probe, then rebuild / renew / back off); proactive renewal rebuilds only libcurl and anything not `ready`; cap
   rebuilds per side and report `offline` beyond the cap; treat a `429` probe answer as backoff.
3. **Service worker contract** (all verified except where noted): one ArrayBuffer per request body in Firefox (no
   `Request.prototype.body` stream polyfill); the `gnome-claim` message (forced reload); the UV document-start hook
   insertion; download progress taps; **hold-and-revive** for Scramjet prefixes after an SW restart (now verified in
   Chromium); **no mid-session takeover** by an updated SW (`self.skipWaiting = () => Promise.resolve()` before
   `importScripts(controller.sw.js)`), `controllerchange` handling in the engine host (point Scramjet's controller at
   the new worker, re-send config), and an explicit apply step for a waiting update (e.g. the engine host finds
   `registration.waiting` at startup, before any engine is created, and no other engine host is open → it asks the
   waiting worker to activate; otherwise the app shows "GNOME was updated, reload"; **not tested**). The SW takes no
   runtime configuration from any channel a proxied page can reach.
4. **GNOME CSP on every proxied document and worker**, hard-wired and always on (no runtime or settings switch;
   `report-only` only as a build/diagnostics flag): Scramjet in the per-tab plugin's `fetch.response`, UV in the SW
   `response` event; set it for every navigable destination (`document`, `iframe`, `frame`, `object`, `embed`) regardless
   of content type, and for `worker`/`sharedworker`. Count violations in the engine host (`securitypolicyviolation`
   listener, already in `attachDocument`) and report them to the app as blocked direct connections; do **not** use
   `report-uri`/`report-to`: CSP reports carry the proxied document URL (the user's browsing) to the server, and the
   proxy origin has no such endpoint (API.md).
5. **WebRTC kill switch** in every proxied window (Scramjet `init.pre`, UV document-start hook; and the engine-host realm
   against escaped code): replace `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCIceCandidate`,
   `RTCSessionDescription`. §5.4's "WebRTC bypasses the proxy (disabled in proxied frames)" is not implemented anywhere.
6. **Controlled fallback:** only for idempotent navigations (GET/HEAD); the error hook fails the navigation
   synchronously (a deferred call let the substitute page commit first); after a transport recovery retry the last
   failed GET once (not tested).
7. **Known upstream limitations:** add the CSS-rewriting gaps per engine (§5.2) and that they are blocked under the CSP,
   the Scramjet `appendData` bug, both epoxy bugs, UV dynamic `import()`, the Firefox worker failures, and that Wisp CLOSE
   reasons are not surfaced. File the Text-node gap upstream (Scramjet already has the TODO). Keep the `leak` suite (lab
   + sites) as the regression test for engine upgrades: a new engine version must not add native constructs.
8. **Main-thread cost:** Scramjet's rewriting runs on the renderer thread it shares with the shell (5–12 long tasks,
   0.34–1.06 s in total, timer stalls up to 0.28 s, per example + Wikipedia session in Chromium; session 3 saw single
   stalls up to 0.7 s); cap concurrent proxied tabs and suspend hidden ones (`performance.memorySaver`).
9. **Downloads:** the browser's download manager handles attachments; the engine host reports
   `download.started/progress/done` for both engines; a download navigation ends with `tab.loading:false`, never
   `tab.loaded`; GNOME cannot cancel them unless it takes the stream over.
10. **Find-in-page:** implemented in the engine host with the CSS Custom Highlight API across same-origin proxied frames.

### 8.3 docs/ENGINE-PROTOCOL.md

1. Handshake: `hello` carries an `instance` id and repeats every 500 ms until `connect` (max 15 s); the app reconnects
   only when a **new** instance says hello; `mismatch` reply for protocol/port errors.
2. Add the `tab.loaded {tabId, url, engine, ms, navId}` event; `tab.committed` gains `ms` (null for same-document) and
   the `same-document` kind (pushState/hash: Scramjet lifecycle hook, UV URL polling); a download navigation ends with
   `tab.loading {loading:false}` and no `tab.loaded`.
3. Downloads: `download.started` gains `engine` and `mime`; `download.cancel` is impossible while the browser owns the
   download (remove it, or mark it "only for taken-over downloads").
4. `tab.contextMenu` coordinates are engine-host viewport coordinates (the app adds the iframe offset); `tab.key` combos
   use layout-independent letters/digits from `KeyboardEvent.code`, and only `init.shortcuts` combos are forwarded (their
   default is prevented in the frame).
5. `tab.find` result gains `highlights: boolean`; `diagnostics` gains `sw: {controlled, starts}`, the CSP state and
   violation counters, and the WebRTC policy.
6. `Ticket.wispUrl` is the route only: the engine host appends `?t=<ticket>&/` itself (API.md already says so).
7. `TransportStatus.detail`: `'ticket-rejected' | 'gateway-unreachable' | 'rebuilding' | 'rate-limited'`.
8. `tab.error.kind`: `dns` and `tls` are best effort (merge into `network` for v1) until a transport exposes Wisp CLOSE
   reasons; `fallback: 'available'` also when a non-idempotent navigation was not retried (with the reason in `detail`).
9. `tab.engineSwitched` gains `reason: 'error-hook' | 'timeout' | 'init-failed'` and `latency` (ms).
10. §1 threat model: list the same-origin facilities a hostile proxied page reaches (engine-host realm, other tabs'
    documents, both cookie jars, the SW registration, the `gnome-engine` channel, the bare-mux worker); state that the
    Wisp ticket and every app → engine message must be assumed readable by such a page, and that engine → app events from
    a tab may be forged by that tab's page (already "semi-trusted").
11. Blocking events: report CSP violations of proxied documents as blocked **direct connections**
    (`tab.blocked {byCategory: {'direct-connection': n}}`).
12. `EngineSettings.privacy.webrtc: 'block'`, the only v1 value (§11.4: no setting that silently de-anonymizes; an
    `'allow'` added later needs an explicit warning that it reveals the user's IP); no CSP on/off switch in `settings`.
13. New: an "update ready" status (a waiting `/sw.js`), so the app can offer "GNOME was updated, reload".

## 9. Verification (session 4)

The previous verifier (session 3) was cut off after reading the reports and changed nothing. Session 4 started fresh.

### 9.1 What was re-run

Both full runs started from a clean copy of `tests/e2e` (no `node_modules`, no results) under the session scratch
directory, `npm ci` (41 packages, identical bytes to the project's `node_modules`, `npm audit`: 0 vulnerabilities), the
HolyWisp binary and `gnome.conf` copied unchanged (sha256 checked), every suite including `smoke`, Chromium then
Firefox, `--strict`, on ports inside the verification lane's range. Result directories stayed in the scratch tmpfs (not
kept); the tables in §3 and §5 were generated from their `results.json`.

The code quoted in §4 is byte-identical to run 2's copy (sha256, first 16 hex digits) except for two comments in
`host.js` (a reference to this document and the ticket-form note; run 2: `20d529c06e597094`; now `0e61be050a96dc11`); unchanged: `web/proxy/sw.js` `adf34869ec1bdd1d`, `web/app/app.js` `125ddf9424a60cd9`,
`web/proxy/engine/index.html` `ffd9cd6765e83a8a`, `uv-doc-hook.js` `01665376edda2ee6`, `uv.config.js` `eb49cc942eabaf48`.

| Run | Harness | Ports | Started (UTC) | Rows | pass | expected fail | other fail | partial | `--strict` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | the session-3 harness exactly as found (pristine copy) | 22060–22099, STUN 22098 (the defaults) | 2026-11-12 01:29:19 | 563 | 492 | 64 | 4 | 3 | exit 1 |
| 2 | the harness after the session-4 changes (§9.4) | 22160–22199, STUN 22198 | 2026-11-12 01:58:40 | 572 | 508 | 57 | 4 | 3 | exit 1 |
| focused | `leak` part `cspbus` (added after run 2 started), both browsers | 22260–22299 | 2026-11-12 ~02:20 | 4 | 2 | 2 | 0 | 0 | – |

The "other fail" rows of both runs are the WebRTC finding (`isolation` `reach:webrtc-from-page`, 2 per browser), which
fails on purpose until a kill switch exists; the partial rows are the three `csp-probe:off` rows (engine bugs that fail
with the CSP off too, §7.10).

Focused runs from a scratch copy on the second and third port sets (22160–22199 before run 2, 22260–22299 during it):
the `sw` suite twice in both browsers while the SW lifecycle test was developed, a scratch-only debug suite (five
Chromium runs) that isolated the SW-update failure, the new POST
fallback test against the **session-3** engine host (it failed: the POST was re-sent to UV as a GET), and the new
`cspbus` leak part (both browsers: the session-3 bus path lets an ordinary page switch the UV CSP off; the fixed default
holds).

### 9.2 What reproduced, what did not, what is flaky

- **No flaky rows.** Of the 563 rows the two runs share, none changed result, including every real-site row (all 64
  site loads succeeded in both runs) and every perf load. The only differences: the four `?t=<ticket>/` ticket-form rows
  per browser went from expected failure to pass, because run 2's stub parses tickets like the session-4 gateway (which
  strips one trailing `/`); and run 2 adds the session-4 rows (SW lifecycle, POST fallback).
- **Reproduced exactly, in both runs and both browsers:** every isolation result; the lab counts (Chromium: Scramjet 17,
  UV 26; Firefox: 16, 25) with the same verdict for every construct; the Wikipedia leak (7 native images, 4–5 text-node
  `<style>` inserts, 67 unrewritten URLs = 60 absolute + 7 relative, 7 violations with the CSP, 0 egress); the probe's 30
  checks with zero regressions; all escaped-code and engine-host-CSP rows (including Chromium's preconnect); the epoxy
  keep-alive hang and epoxy's missing reconnect (both builds); libcurl's self-reconnect with the same ticket; the whole
  recovery recipe with all four transports; every fallback row; the stale-prefix `503` in 1 ms; renewal firing
  13–30 ms after its 1500 ms schedule; UV + libcurl 1.5.2's first-request failure in Firefox; UV's
  echo.websocket.org greeting without echo.
- **Session-3 claims that no longer hold, or held only for the old code:** "`?t=<ticket>/` fails the MAC check" and
  "the probe always gets 426" were true for the session-3 Rust gateway only (fixed in the backend in session 4); the
  Chromium/Scramjet initiator of the Wikipedia natives is `other` in run 2 but `parser` in run 1 (both CSS-initiated);
  the intermittent Firefox + Scramjet/libcurl `tls` load failures and the one Firefox/Scramjet root-cause load that
  session 3 saw did not happen in either run; Scramjet's long tasks ranged 5–12 per session (session 3: 6–8).
- **Firefox POST bodies** (spike-core replaced the body polyfill after the other lanes' runs): both runs use the current
  `sw.js`, and every Firefox POST path passed: local and httpbin form POSTs (exact body), the isolation suite's
  virtualized `POST /api/state` (reaches the app stub through Wisp, 403 without cookies) and `sendBeacon`.

### 9.3 What each row really tests (read against the code)

- **Isolation "pass" rows attempt the read and assert the failure:** `escaped:app-storage` reads
  `window.top.localStorage`/`indexedDB` and requires `SecurityError`, frames the app and requires it unreadable;
  `escaped:app-endpoints` sends credentialed `POST`s with `X-GNOME-Request` and requires a `TypeError` **and** that the
  app server logged no state change and no minted ticket; top navigation rows try assign/replace/`open('_top')`/
  `<a target=_top>` and a user-activated attempt and require the app URL unchanged. The app stub refuses CORS preflights
  like gnome-server does (`backend/src/security/csrf.rs` rejects `OPTIONS`; no CORS layer exists in the backend).
- **The leak test detects native requests** (Playwright request events, Chromium CDP with block reasons, and the sentinel
  that sees every request that left the browser) instead of assuming them, and since session 4 an enforced-CSP pass
  needs positive evidence: each construct that went native with the CSP off must be reported blocked.
- **Reconnect rows really kill the socket:** the gateway stub destroys both TCP sockets of every live Wisp connection
  (`dropWisp`) or the whole proxy server process is SIGKILLed and restarted; the strict stub accepts only valid tickets,
  so a reconnect that loaded the target carried a valid ticket (the upgrade log shows the form and ticket tail).
- **Content checks:** transport and fallback rows require that the target served the path and the tab title is the
  target's (a loaded error or 503 page does not count); the new SW lifecycle rows do the same.
- **Weaker than claimed, fixed in session 4:** the stale-prefix row passed on any `200`; the cross-site partitioning row
  always passed (it is now the control that proves partitioning is active); the fallback cookie row did not require the
  HttpOnly cookie; the download-navigation row did not check for the absence of `tab.loaded`; the lab's enforced pass
  only required no native request; the transport suite marked **every** ticket-form and raw-drop failure as expected,
  so `--strict` would not have caught a regression of the recommended `?t=<ticket>&/` form or of libcurl's reconnect.

### 9.4 Harness changes (all in `tests/e2e/spike-engine-host/` and `tests/e2e/README.md`)

| File | Change | Default behaviour |
| --- | --- | --- |
| `servers/target.mjs` | the four hardcoded `22090` URLs (`/attack` topnav, `/nested` cross-site child, `/ws-page` default, `/csp-probe` WebSocket) use `SPIKE_TARGET_PORT`; new `/form-fault` page | same on the default ports; correct on others (run 2 ran on 22190) |
| `servers/proxy.mjs` | strict ticket parsing copies the **session-4** `ticket_param` (one trailing `/` stripped, percent-decoded, duplicate `t` refused; checked against its 16 unit-test vectors) and is the default (`SPIKE_GATEWAY_STRICT=0` = lenient); probe order `legacy` (alias `rust`) = the session-3 426-first order; `stats` reports the probe order | **changed**: strict by default |
| `web/proxy/engine/host.js` | default ticket form `query+amp-slash` (`?t=<ticket>&/`, the documented form; was `auto` = `?t=<ticket>/` for libcurl); SW config via the SW `message` event (legacy bus path only with `swConfigBus`); `controllerchange` handler (re-point Scramjet's controller, re-send config); non-GET/HEAD navigations are never auto-retried on UV | **changed** (bug fixes; every suite passed with them in run 2) |
| `web/proxy/sw.js` | config only from the engine-host client (`/engine/`, checked `e.source`), bus config only when the host opted in; `skipWaiting()` neutralized before `importScripts(controller.sw.js)` | **changed**: updates wait |
| `web/app/app.js` | `swConfigBus=1` query parameter | – |
| `run.mjs` | `--parallel` runs only `smoke,sw,nav,input` concurrently and the rest one browser at a time | **changed** for `--parallel` only |
| `lib/drive.mjs` | `withDeadline` / `FRAME_EVAL_MS` (8 s) for every frame read (`readOut`, `bodyText`, `waitTabFrame`) | same unless a read hangs |
| `suites/sw.mjs` | stale-prefix row asserts `503 stale-prefix`; cross-site row is the partitioning control; new SW lifecycle rows (stop/restart, update waits, update applies at reload) | new rows |
| `suites/transport.mjs` | `expectFail` only for the documented combinations (plain `?t=` with libcurl; epoxy raw drop); legacy probe-order row renamed | stricter |
| `suites/fallback.mjs` | new row: a failed POST is not retried on UV; cookie row requires the HttpOnly cookie | new row, stricter |
| `suites/nav.mjs` | download-navigation row requires `download.started`/`done` and no `tab.loaded` | stricter |
| `suites/leak.mjs` | enforced lab rows require every CSP-off native construct to be blocked; new part `cspbus`; frame-read deadlines | new part, stricter |
| `servers/isolation-leak-pages.mjs` | `/leak/bus-poison` page for `cspbus` | – |
| `tests/e2e/README.md` | every suite (with parallel safety), every `SPIKE_*` variable (incl. `SPIKE_GATEWAY_STRICT`/`PROBE`, `SPIKE_ENGINE_HOST_CSP`, `SPIKE_PERF_*`, `SPIKE_TRACE`, `SPIKE_ATTACK_*`, `SPIKE_RUN_DIR`), the app query parameters, known harness behaviour | – |

### 9.5 Findings of the verification

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | high | Any **ordinary** proxied page (no escape) could switch GNOME's UV leak CSP off by posting `sw-config` on the `gnome-engine` BroadcastChannel, from which session-3 `sw.js` took its config: 26/25 constructs then went native | fixed (SW takes config only from the engine-host client); `leak` `cspbus` rows, both browsers |
| 2 | high | A new `/sw.js` taking over a running engine host (upstream `skipWaiting()` + `clients.claim()`) breaks both engines: Scramjet's controller keeps announcing its prefix to the redundant worker (`503 not-routable` after the 5 s hold; code-confirmed in `controller/src/index.ts`), and UV requests made a few seconds after the swap hang (observed; inside bare-mux) | fixed in the harness (updates wait; `controllerchange` handling); Chromium applies the update at the next reload; Firefox open (§7.13) |
| 3 | medium | A failed Scramjet **POST** navigation was re-sent to UV as a **GET** of the action URL (verified against the session-3 engine host) | fixed; `fallback` row |
| 4 | medium | The doc's wiring code used `?t=<ticket>&/` while the harness default for libcurl was `?t=<ticket>/`, which only the lenient stub accepted; every suite but `transport` ran with a form that the session-3 gateway refused | fixed (default `?t=<ticket>&/`, strict stub default); moot for the session-4 gateway, which accepts both |
| 5 | medium | The stub's "strict" parser copied the session-3 `ticket_param`; the backend changed in session 4 (strip one `/`, percent-decode), so F1 ("`?t=<ticket>/` fails the MAC") and F5 ("the probe always gets 426") of the transport lane describe the old gateway | stub updated; claims corrected (§1, §8.1) |
| 6 | medium | `--parallel` was unsafe for `fallback` (it could pass wrongly: its content check reads the shared target log), `isolation` and `leak` (shared app/sentinel logs) and `leak`'s `hostcsp` restarts the proxy, not only for `transport`/`perf` | fixed in `run.mjs`; README |
| 7 | medium | The SW hold-and-revive path for Scramjet after an SW restart (ARCHITECTURE §5.4) had no test | tested (Chromium; Firefox has no stop API in Playwright) |
| 8 | medium | `report-uri` in the spike CSP sends the proxied document URL (the user's browsing) to the server; the proxy origin has no such endpoint | recommendation §8.2.4 |
| 9 | medium | The CSP is set only for `text/html` documents with destination `document`/`iframe` (+ workers); `frame`/`object`/`embed` and non-HTML documents are not covered | recommendation §8.2.4 (code reading, not tested) |
| 10 | low | Hardcoded port 22090 in four target pages | fixed |
| 11 | low | playwright-core + Firefox `frame.evaluate` hang could stall any suite that reads tab frames | mitigated (deadlines) |
| 12 | low | Six rows tested less than they claimed (§9.3) | fixed |
| 13 | low | README lacked suites, variables and parameters | fixed |
| 14 | info | The Chromium/Scramjet CDP initiator of the Wikipedia natives varies between runs (`parser` in run 1, `other` in run 2); same 7 URLs and root cause | documented |


## 10. Requirements for Wave B and the backend

**Engine host (Wave B, `frontend/src/engine/`, `src/transport/`, `src/sw/`):**
1. Start from §4. Keep: the origin-checked `hello`/`connect` handshake with instance ids, host-realm natives (`N`) for
   everything done inside proxied documents, GNOME-initiated loads via `location.replace` / `iframe.src` (no history
   entries), per-tab history in GNOME. The app validates **every** engine → app event (types, enums, lengths, `http(s)`
   URLs, `data:image` favicons; strings rendered as text, as the spike app does), rate-limits events per tab and asks
   for a gesture in its own UI before any destructive or privileged action: the peer may be a port captured by escaped
   code (§11.2.2 B6).
2. Transports: libcurl for both engines by default (UV/libcurl 1.5.2 with an init retry); one URL form
   `<wisp_url>?t=<ticket>&/`; build + `await init()` + only then hand over, all rebuilds through one queue; the watchdog of
   §6 (libcurl: probe once per drop; epoxy: probe → rebuild / renew / back off); lazy renewal; a per-side rebuild cap;
   `429` from the probe = back off.
3. SW: the §4.11 fixes (Firefox bodies, `gnome-claim`, hold-and-revive, stale-prefix `503`, no mid-session takeover,
   UV document-start hook, download taps) and an explicit apply step for a waiting update; **no runtime configuration
   from any channel a page can reach**: the CSP is a constant in the SW and the engine host.
4. The GNOME CSP on every proxied document and worker of both engines (all navigable destinations, any content type),
   counted with `securitypolicyviolation`, never sent with `report-uri`; the engine-host CSP of §8.1.2 on `/engine/`.
5. A WebRTC kill switch at document start in every proxied window of both engines and in the engine-host realm, on by
   default (`EngineSettings.privacy.webrtc: 'block'`, §8.3.12). It stops ordinary proxied pages; escaped code still
   reaches WebRTC through a native `about:blank` frame (§11.3 (1)), which only connection-level ICE/STUN/TURN denial
   would close.
6. Fallback only for GET/HEAD navigations; the error hook fails the navigation synchronously.
7. Treat the `gnome-engine` BroadcastChannel as public: nothing on it may change behaviour or carry data the app must
   trust (SW → host signals should go to the engine-host client with `client.postMessage`; §11.2.2 B4, B5).
8. Keep `tests/e2e/spike-engine-host` green (`leak` lab + sites as the engine-upgrade regression test) and port its
   checks to the Wave B e2e suite.
9. Engine iframe sandbox without `allow-popups`/`allow-popups-to-escape-sandbox`; `window.open` and `target=_blank`
   open a GNOME tab through `tab.openRequest` (decision 2026-11-11, §8.1.3, §11.3 (2)).
10. Assume escaped code owns the proxy origin (decision 2026-11-11, §11.2.2): other tabs' documents, both cookie jars
    (HttpOnly included), engine storage, the SW registration, UV's bare-mux transport (it can replace or observe all UV
    traffic) and the Wisp ticket. Keep nothing there that one proxied site must hide from another, never promise
    isolation between proxied sites in the UI (§8.1.6), keep Scramjet (in-window transport) the default engine, and
    rely on the ticket's 1 h TTL, the per-session caps and revocation rather than on hiding it.

**Backend (`gnome-server`):**
1. Keep the session-4 gateway contract the harness now mirrors: `?t=<ticket>&/` canonical, `?t=<ticket>` and
   `?t=<ticket>/` accepted, percent-decoding, a second `t` refused; the probe answers `401 wisp_ticket_*` / `426` without
   `Origin`; tickets are checked only at the upgrade. A probe that is rate-limited must answer `429` with `Retry-After`
   (the engine host backs off), never `401`.
2. Serve `/engine/` with the engine-host CSP (§8.1.2), `/vendor/bare-mux/worker.js` with `connect-src 'self'`, and
   `/sw.js` with `no-cache` (already in API.md) so updates are found; no CSP report endpoint is needed.
3. Dev two-port mode: `__Host-` cookie names on loopback HTTP too (§8.1.4, parity with production).
4. integrate:stack: run the `transport` suite's ticket-form and probe checks against the real gateway (only the stub was
   exercised here).
5. Keep cookies `HttpOnly; SameSite=Strict; Path=/` with no `Domain` and `__Host-` + `Secure` over HTTPS, and the CSRF
   rule (`X-GNOME-Request: 1` on non-GET + an allowed `Origin`, no CORS): against the real server they stopped simple
   form POSTs and cross-origin fetches from the proxy origin (§11.3 (4)). Every GET handler stays side-effect free: a
   proxied page's credentialed same-site GET reaches it with the session cookie.
6. Trim the proxy-origin `GET /api/health` to `status` + `wisp` (no `version`, `uptime_s` or VPN-profile ids; §11.2.2
   B9, §11.4): **done** by the session-4 integration step (`{"status","wisp":{"direct":…}}` on the proxy role, API.md;
   test `backend/tests/roles.rs` `proxy_origin_health_is_minimal`). Keep `/api/config` and every other route except
   `/api/health` and `/api/filters*` off the proxy origin (verified 404).
7. Ticket lifecycle unchanged (1 h TTL, per-session caps, revoke on session end); the ticket is exposed to escaped code,
   so consider flagging a ticket reused from a new IP (§11.4).

## 11. Adversarial isolation review (session 4)

> Lane `proxy:spike-attack`, session 4 (2026-11-11 evening); merged here from the former
> `docs/research/spike-engine-host-attack.md` by the integration step, which also added the status notes about the
> verification step's harness changes (§9.4). The lane acted as a **malicious proxied website** and attacked the
> two-origin engine host (ARCHITECTURE §4.6/§5.4). Everything below was run in Chromium 156 (chromium-1248, headless)
> and Firefox 157 (firefox-1555) through playwright-core 1.64.0, against Scramjet 2.0.67-alpha.2 + libcurl-transport
> 2.0.6 and Ultraviolet 3.2.10 + bare-mux 2.1.9 + epoxy-transport 2.1.29, over real HolyWisp e0a0f15 (the loopback test
> site only through the TEST-ONLY `/wisp/p/test-loopback/` route). The §11.3 (4) backend checks ran against the real
> `gnome-server` (debug build). Harness: `tests/e2e/spike-engine-host/`, suite `suites/attack.mjs` (§11.6). The review
> ran in parallel with the verification step (§9); rows that step changed say so. Its requirements are merged into §10.

### 11.1 Threat model and method

Two kinds of attacker code run from a proxied page, exactly as `suites/isolation.mjs` models them (§3 item 3):

- **virtualized**: the proxied site's own JS, rewritten by Scramjet/UV. This is every hostile site.
- **escaped**: unrewritten JS in the proxied document (Playwright `frame.evaluate`), standing in for *any* Scramjet/UV
  virtualization escape. Upstream ships known escapes (research `scramjet.md`/`ultraviolet.md`), so escaped code is a
  realistic capability, not a hypothetical. Escaped code is **same-origin with the engine host** (both the proxy
  origin) and reaches it through the unforgeable `window.top[0]` (`window.top` is the cross-origin app; its `frames[0]`
  is the engine-host iframe).

`ENGINE-PROTOCOL.md §1` already states the intended model: *"A page that escapes Scramjet/UV virtualization can do
anything the engine host can do."* This review **confirms that model holds in both directions**:

- **The app-origin boundary holds.** Neither virtualized nor escaped code could read the app's storage, call its
  authenticated API with effect, navigate its top window, or forge a protocol message the app accepts. The two-origin
  split does what it was designed to do.
- **The proxy origin is not an isolation boundary *inside itself*.** Every proxied tab, the engine host, both engines'
  cookie jars, the service worker, the bare-mux SharedWorker and the `gnome-engine` BroadcastChannel share one origin,
  so an escape in one proxied page compromises all of them and steals the Wisp ticket. This is the accepted cost of the
  design (PROGRESS decisions log, 2026-11-11: "the proxy origin is one shared realm"); the mitigations below shrink the
  blast radius and enforce the ticket's short life.

### 11.2 Attack table

Legend: **works** = the attack succeeded (`fail` row in the suite); **blocked** = the boundary held (`pass`);
**partial** = succeeded in part. Sev = severity. Each row ran for Scramjet and Ultraviolet in Chromium and Firefox unless
noted; results were identical across browsers.

#### 11.2.1 App-origin boundary: holds (the point of the two origins)

| # | Attack (from a proxied page) | Result | Evidence | Sev |
| --- | --- | --- | --- | --- |
| A1 | Read app `localStorage` / `IndexedDB` (via `window.top`, via proxy-origin storage, by framing the app) | **blocked** | `window.top.localStorage` → `SecurityError`; app not in proxy-origin IndexedDB; app iframe unreadable (§3 item 3) | – |
| A2 | Credentialed state-changing call to the app API (`POST /api/state`, `/api/wisp/ticket`) with `X-GNOME-Request` | **blocked** | CORS preflight refused, `TypeError`, no POST reaches the server, no ticket minted | – |
| A3 | Navigate the app's top window (`assign`/`replace`/`open('_top')`/`<a target=_top>`/user-activated) | **blocked** | all `SecurityError`/ignored; app URL never changed (sandbox has no `allow-top-navigation`) | – |
| A4 | **Forge an engine→app message from a non-host frame** (fake `hello`, fake `tab.committed` to `window.top`) | **blocked** | app `connects` unchanged, `rejected` unchanged, title unchanged. The app checks **both** `event.source === iframe.contentWindow` **and** `event.origin === proxyOrigin` on `hello`, and only accepts events over the private `MessagePort`, never over `window.postMessage` | – |
| A5 | **Obtain/replay the Wisp ticket as a non-escaped (virtualized) page** | **blocked** | ticket is in the engine host's module scope (not on `window`); `__gnomeEngineHost` exposes only `attachDocument`; bare-mux `getTransport()` returns the module path, not the URL; a raw `new WebSocket(wss://proxy/wisp/)` with no/guessed ticket is refused | – |

Takeaway: keep A1–A5 true. They are the whole security argument for the proxy origin. A5 refines §3 item 3's "assume
the ticket is exposed": a *virtualized* page cannot get it, only *escaped* code can (B6).

#### 11.2.2 Inside the proxy origin: proxied pages are not isolated from each other or from the host

| # | Attack (escaped code) | Result | Evidence | Sev |
| --- | --- | --- | --- | --- |
| B1 | **Read another tab's proxied document** | **works** | from tab A, `window.top[0].document.querySelectorAll('iframe')` → the victim tab's `contentDocument` is same-origin; stole its DOM (`victim-dom-secret`), a password field value (`hunter2-victim`), its `localStorage` (`victim-localstorage-secret`) and its non-HttpOnly cookies. Both engines, both browsers | High |
| B2 | **Steal proxied sites' cookies, including HttpOnly, from the engine jar** | **works** (UV) | read UV's `__op` IndexedDB `cookies` store: `.localhost:victim_http(httpOnly)=…`, `victim_js`, `victim_srv`. The HttpOnly cookie of a proxied site is plain data in a store any proxied page can open. Scramjet's jar is in `__scramjet_controller` (also enumerable) | High |
| B3 | **Poison engine-host storage** | **works** | wrote the engine host's `localStorage`, created a `caches` entry, and injected a forged cookie for `.victim.example` into UV's shared `__op` jar (cookie injection against any site the user later proxies) | Med |
| B4 | **Disable the leak CSP via the `gnome-engine` BroadcastChannel** | **partial** (session-3 SW path) | the channel is joinable and writable by any proxied page; the session-3 SW took its UV CSP from it (`sw-config`). Posting `{csp:'off'}` was consumed, but the engine host re-asserted `csp:enforce` on every SW restart (`sw-start` → `pushSwConfig`), a race the host usually won, so no leak reproduced in this lane's run. The channel's writability is proven deterministically by B5. **Status after §9:** the verification step closed the hole in the harness (§9.5 #1): by default the SW takes its configuration only from the engine-host client (checked `event.source`), and the `leak` suite's `cspbus` rows prove a forged `sw-config` from an ordinary page no longer switches the UV CSP off; `swConfigBus=1` restores the session-3 path for attack tests. Code reading: `bus:disable-leak-csp` can then no longer leak by default (it records `partial`; its message still describes the session-3 path) | Med |
| B5 | **Spoof host⇄SW signals over the bus** (fake `download`, fake `wisp` close) | **works** (UV) | a forged `{type:'download', filename:'invoice.pdf.exe', …}` posted to `gnome-engine` reached the app, which displayed it as a real download. Fake `wisp` close events flip transport status to `degraded`. The bus has no sender authentication. Unchanged by §9: the bus still carries SW → host signals (downloads, UV errors, worker socket taps) | Med |
| B6 | **Escape → compromise the engine host → steal the ticket + forge events** | **works** | escaped code injects an inline `<script>` into the engine-host realm (same origin; the engine-host document's CSP allows `'unsafe-inline'`). Running **as the host**, it posts a forged `hello` (so `source === iframe.contentWindow` and the app accepts it); the app re-handshakes and posts a fresh `MessagePort`; the injected listener captures it and intercepts the `init` command, reading the **real Wisp ticket** (`w1.…dGVzdC10aWNrZXQtMQ`, matched). The port is bidirectional, so the attacker can also inject any engine→app event the app accepts (spoof the omnibox/history via `tab.committed`, open tabs via `tab.openRequest`, harvest fresh tickets via `needTicket`). Both engines, both browsers | High |
| B7 | **Register/replace the service worker; unregister GNOME's `/sw.js`** | **works** | `navigator.serviceWorker.getRegistrations()` then `unregister()` removed GNOME's SW (scope `/`); a later navigation failed (`engine` error / "frame left the proxy origin"). The `503` retry page re-registers, so a one-shot unregister self-heals, but a loop sustains the DoS. A proxied page can also register its own SW on the proxy origin | Med |
| B8 | **Replace the shared bare-mux transport (UV)** | **works** (UV) | `new BareMux.BareMuxConnection('/vendor/bare-mux/worker.js').setManualTransport(<dead/MITM transport>)` replaces the transport inside the one SharedWorker for the whole origin; the engine host's UV then failed every navigation. The same hook can observe/modify all UV traffic (MITM), not only break it. bare-mux's `getPort` handshake over `navigator.serviceWorker` is a second interception surface (a malicious client can answer the SW's `getPort` with its own `MessagePort`) | High |
| B9 | **Read proxy-origin endpoints** | **info** | a proxied page is same-origin with `GET /api/health` and `GET /api/filters`. Real `gnome-server` `/api/health` returns `{status, version:"0.1.0", uptime_s, db, wisp:{direct:…}}`: it discloses the exact GNOME version (fingerprinting) and the Wisp-upstream map (VPN profile ids and their status when profiles are configured). `/api/filters` lists the instance's blocklists. `/api/config` is **404** on the proxy origin (good) | Low–Med |

#### 11.2.3 Reaching the network outside the proxy engines

| # | Attack | Result | Evidence | Sev |
| --- | --- | --- | --- | --- |
| C1 | **WebRTC from an ordinary (virtualized) proxied page** | **works** | `RTCPeerConnection` is present; STUN binding requests reached the local UDP sink directly, outside Wisp (3 pkts Chromium, 4–5 Firefox). The real client IP leaks; the proxy's anonymity goal is defeated. ARCHITECTURE §5.4 already *claims* this is "disabled in proxied frames"; it is not (§8.2.5) | High |
| C2 | **Escaped code reaches the network via a popup** (current sandbox) | **works** | `window.open('https://leak-popup.…invalid')` opened a window that reached the net directly (the sentinel saw it). `allow-popups-to-escape-sandbox` lets the popup leave the sandbox and browse unproxied, with an `opener` back to the escaped page | High–Med |
| C3 | **Escaped code reaches the network via CSS-rewriting gaps / engine-host realm / self-navigation** | **works w/o CSP; mostly blocked w/ CSP** | covered in full by item 4 (§3, §5). The per-document GNOME CSP (`connect-src 'self'`) turns the client-side CSS `url()` gaps into blocked loads; the engine-host CSP blocks the engine-host-realm and self-navigation routes. Popups (C2) and WebRTC (C1) are **not** covered by any CSP | Med |

### 11.3 Settling the four items item 3/4 left open

#### (1) WebRTC kill switch: proven for proxied pages, partial against escaped code

`suites/attack.mjs` installs, at document start, the kill switch a real engine host would use (Scramjet `init.pre` /
UV document-start hook, plus the engine-host realm): neutralize `RTCPeerConnection`/`webkitRTCPeerConnection`/
`mozRTCPeerConnection` in every **proxy-origin, non-`about:blank`** realm, i.e. exactly the realms the engine host owns
and can reach, and deliberately **not** native `about:blank` realms it cannot.

- **Ordinary proxied page:** `pass` in all four engine × browser cells. `typeof RTCPeerConnection === 'undefined'`, **0**
  STUN packets. This makes the ARCHITECTURE §5.4 claim true.
- **Escaped code:** `partial`. Own realm and the engine-host realm are both killed (0 packets through them), but escaped
  code can create a native `about:blank` iframe and read a fresh `contentWindow.RTCPeerConnection` the hook never ran in
  → STUN still egresses (3–4 pkts). The document-start hook cannot reach a realm the page conjures natively.

Requirement: implement the kill switch (it is cheap and effective for the real threat, hostile *sites*, which are
virtualized). Against *escaped* code the only complete fix is connection-level: deny ICE/STUN/TURN egress at the
transport/network layer. CSP `connect-src` does not reliably cover WebRTC in either browser.

#### (2) Dropping `allow-popups`: what breaks

- With the current sandbox (`allow-popups allow-popups-to-escape-sandbox`), escaped `window.open` escapes and browses
  unproxied (C2).
- With `allow-popups`/`allow-popups-to-escape-sandbox` **removed** from the engine iframe (tested by rewriting the
  sandbox at runtime and re-handshaking): `window.open` returns `null` (Chromium) or throws (Firefox); popups are dead.
  **What breaks:** OAuth/SSO/payment flows that need a real popup window. The replacement is to route `window.open`/
  `target=_blank` through an engine-host→app `tab.openRequest` so GNOME opens a *proxied* tab. That costs any flow that
  requires a genuine top-level cross-origin window (interactive OAuth popups), which must then fall back to full-page
  redirect or be opened unproxied with an explicit user choice.
- **Decided** (PROGRESS decisions log, 2026-11-11): the engine iframe drops both flags, and `window.open`/
  `target=_blank` open a new GNOME tab through `tab.openRequest`.

#### (3) Chromium speculative preconnect

Confirmed by item 4's `hostcsp` experiment and consistent here: when the engine-host CSP blocks a tab-frame navigation
to a native host, Chromium still opens **one** connection to that host (a speculative preconnect) before the CSP
cancels the request. No HTTP request line, headers or body are sent, but the TCP+TLS handshake reveals the client IP
and the SNI hostname to an attacker-chosen host. Firefox did not. There is no stable CSP directive (`navigate-to` is
gone) that blocks the preconnect. Severity low (contact only, no payload). Mitigation: nothing fully removes it from the
page side; it is one more reason escaped code must not be able to self-navigate a tab frame to a native URL (the
per-document CSP `connect-src 'self'` already blocks the *request*, leaving only the preconnect).

#### (4) Dev two-port cookie jar: tested against the real `gnome-server`

Real `gnome-server` in two-port dev mode (`GNOME_BIND=127.0.0.1:22600`, `GNOME_PROXY_BIND=127.0.0.1:22601`, `open`):

- **Cookie attributes (confirmed at runtime and in `backend/src/auth/cookies.rs`):** every cookie is
  `…; Max-Age=…; Path=/; HttpOnly; SameSite=Strict` with **no `Domain` attribute**, ever. Over HTTPS (or
  `X-Forwarded-Proto: https` from a trusted proxy) the names gain the `__Host-` prefix and `Secure`
  (`__Host-gnome_sid=…; Path=/; HttpOnly; SameSite=Strict; Secure`). **Production cookies carry no `Domain`**
  (confirmed). `__Host-` additionally forbids a `Domain` and requires `Secure` + `Path=/`, so in production the proxy
  hostname cannot *plant* (toss) a session cookie for the app (session-fixation defence).
- **Which app cookies a proxied page can READ:** **none.** All session cookies are HttpOnly and there is no
  JS-readable cookie. (The spike's `app.mjs` stub sets a demo `gnome_pref=visible-to-js`, the cookie §3 item 3 and §7.16
  saw; the real server sets no such cookie. Do not add one.)
- **Which it can SEND:** the browser stores `gnome_sid` host-scoped (`domain:"127.0.0.1"`, **no port**), so it is in
  scope for the proxy origin on the same host and **is attached** on same-site requests from the proxy origin to the app
  (confirmed: a credentialed request from the proxy-origin context carried it).
- **Do CSRF/Origin checks stop credentialed requests?** **Yes.** Against the real server:
  - a **simple form POST** (`Content-Type: application/x-www-form-urlencoded`, `Origin: <proxy origin>`, no custom
    header) → **403** ("missing `X-GNOME-Request: 1`"). Forms cannot set that header.
  - a cross-origin `fetch` with `X-GNOME-Request: 1` and `Origin: <proxy origin>` → **403** ("origin not allowed"), and
    cross-origin it would first fail the CORS preflight the server never approves.
  - the control (`Origin: <app origin>` + header) → **200**.
  - a credentialed **GET** reaches the handler **with** the session cookie but its response is unreadable cross-origin
    (no CORS). **Requirement: every GET handler must stay side-effect-free.**
- **Proxy-origin `/api/health`** exposes `version` + `uptime_s` + `wisp` to any proxied page (B9); `/api/config` is 404.

Conclusion: the dev two-port setup shares the cookie *jar* by host, but HttpOnly makes the session unreadable and the
CSRF `X-GNOME-Request` + `Origin` checks make it unusable for state change. The only standing requirements are the
side-effect-free-GET rule and the `/api/health` disclosure. In production the two roles are different hostnames, so the
jars are host-scoped apart anyway, and `__Host-` names block cookie tossing from the proxy hostname. (Integration note,
from the cookie rules, not tested: in the dev two-port mode both roles are the *same host* and cookies ignore ports, so
a cookie that escaped code sets with the native `document.cookie` on the proxy origin, `__Host-`-prefixed or not, is
also sent to the app; using `__Host-` names on loopback (§8.1.4) gives parity with production but cannot separate the
two ports. Dev two-port mode is a development setup only.)

### 11.4 Mitigations

Demonstrated in the harness (✓) vs required (→).

- ✓ **WebRTC kill switch** on every proxied document and the engine-host realm (§11.3 (1)). Default it on; expose only
  `EngineSettings.privacy.webrtc` = `block` (no user "allow WebRTC" setting that silently de-anonymizes).
- ✓/→ **Hard-wire the proxied-document CSP in the service worker** (B4/B5). The SW must not read `csp`/`cspPolicy` from
  the `gnome-engine` BroadcastChannel (any proxied page can write it). Bake the policy into the SW build; if the host
  must tell the SW anything security-relevant, send it over a client → SW `postMessage` and authenticate the sender with
  `event.source.url` (the engine host is `/engine/`; proxied pages are `/~/sj/*` or `/uv/service/*`). The harness SW
  does this since §9 (config only from the engine-host client); production goes further and takes no runtime
  configuration at all (§10). The host's re-assert-on-`sw-start` behaviour is a useful backstop but is a race, not a fix.
- → **Keep the per-document GNOME CSP always-on, both engines** (item 4, §5.3), which already blocks the CSS `url()`
  gaps and the engine-host-realm/self-navigation escape routes. No runtime off-switch.
- → **Drop `allow-popups`/`allow-popups-to-escape-sandbox`** and route `window.open`/`target=_blank` through
  `tab.openRequest` (§11.3 (2); decided 2026-11-11). Otherwise escaped code keeps an unproxied escape hatch.
- → **Treat the Wisp ticket as exposed to escaped code** (B6). It already grants no API access; keep the 1 h TTL, the
  per-session caps, and session-revocation ticket invalidation. Consider binding the ticket to a single live Wisp
  session count and alerting on reuse from a new IP.
- → **Reduce proxy-origin `/api/health`** (B9): the engine host only needs `status` and the `wisp` map for its own
  health check; drop `version` and `uptime_s` from the proxy-origin variant, and do not surface VPN-profile ids there.
  Implemented in gnome-server by the session-4 integration step (§10, backend 6).
- → **bare-mux transport integrity** (B8): a proxied page can replace the shared SharedWorker transport and answer the
  `getPort` handshake. There is no clean per-page fix while UV uses one SharedWorker per origin; document it as part of
  "an escape compromises all UV traffic", prefer Scramjet (in-window transport) as default, and watch bare-mux upstream
  for an authenticated handshake.
- → **Accept and document that proxied tabs are not isolated from each other** (B1/B2/B3/B6/B7; decided 2026-11-11). Do
  not place anything on the proxy origin that one proxied site must keep from another beyond best effort; the real
  boundary is the app origin (holds). If per-site isolation is ever required, it needs distinct sub-origins per tab
  (wildcard DNS + TLS; out of scope for v1).

### 11.5 Requirements

The review's requirements for the engine host and the backend are part of §10: engine host 1 (validate every event,
rate-limit per tab, gesture for privileged actions), 3 and 4 (hard-wired CSPs), 5 (WebRTC), 7 (public bus), 9
(sandbox) and 10 (shared realm, ticket exposed); backend 5 (cookies, CSRF, side-effect-free GETs), 6 (proxy-origin
`/api/health`, nothing else of the API on the proxy origin) and 7 (ticket lifecycle).

### 11.6 Reproduce / harness notes

```sh
cd tests/e2e
SPIKE_APP_PORT=22580 SPIKE_PROXY_PORT=22581 SPIKE_TARGET_PORT=22590 SPIKE_SENTINEL_PORT=22599 \
SPIKE_HOLYWISP_PORT=22560 SPIKE_HOLYWISP_TEST_PORT=22561 SPIKE_STUN_PORT=22598 \
SPIKE_RESULTS_DIR=<dir> node spike-engine-host/run.mjs --only attack --browser all
# knobs: SPIKE_ATTACK_PARTS (reach,crosstab,storage,bus,swhijack,baremux,ticket,host-inject,handshake,endpoints,popup,webrtc)
#        SPIKE_ATTACK_ENGINES (scramjet,ultraviolet)
```

- `suites/attack.mjs` is registered in `run.mjs` and **excluded from the default run** (like `smoke`); it runs only via
  `--only attack`. It does not restart the shared proxy server. With `--parallel`, `run.mjs` runs it one browser at a
  time (§9.4; the suite's header comment predates that and says not to combine them).
- It reuses `/iso/probe` and `/iso/victim` (which take their ports from config). The `target.mjs` pages that hardcoded
  22090 when this lane ran take `SPIKE_TARGET_PORT` since §9.4.
- The §11.3 (4) checks used the real `gnome-server` (two-port dev, `open` mode) with curl + a playwright-core
  cookie-scope check; no backend files were modified.
- Host state: unchanged. HolyWisp ran only in the harness's unprivileged lockdown containers; no privileged containers,
  no sudo, no kernel/sysctl/binfmt changes; every process, container and port the lane started was stopped.

## 12. Against the real gnome-server (integration, session 4)

§10 backend item 4, done with `tests/e2e/stack/engine-on-gnome-server.mjs`: this spike's app stub and engine host served
by the release `gnome-server` (two-origin mode, real tickets from `POST /api/wisp/ticket`, the real `/wisp/` gateway,
HolyWisp with `services/holywisp/gnome.conf`), Chromium 156 and Firefox 157:
- All four engine × transport pairs load `https://example.com/` with `?t=<ticket>&/` and `?t=<ticket>/`; `?t=<ticket>`
  works for epoxy and is refused by libcurl ("must end with a trailing forward slash"), as documented (24 pass, 4
  expected failures).
- The engine host's probe (same-origin `fetch` from the engine-host frame) gets `426` for a valid ticket in all three
  forms and `401 wisp_ticket_invalid` / `wisp_ticket_missing` otherwise; a WebSocket from the engine-host page (browser
  `Origin`) opens with a valid ticket and fails with a forged one. A rate-limited probe gets `429` + `Retry-After`
  (never `401`), and a connection opened with a 60 s ticket kept working after it expired (curl/Node checks).
- §8.1.2's engine-host policy, served by gnome-server through `GNOME_PROXY_CSP="default-src 'self' data: blob:
  'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data:; form-action 'self'"`: all four pairs
  load in both browsers (12/12).
- §8.1.5's worker policy (`connect-src 'self'` on `/vendor/bare-mux/worker.js`, added by a test proxy in front of the
  proxy listener): UV over epoxy and libcurl loads example.com and Wikipedia in both browsers, and a native `fetch`
  that code injected through `setManualTransport` makes inside the worker is blocked; without the policy it goes out
  (control). `data:` is not needed in that worker.
- Neither policy is the backend default yet: both would also block the user's custom Wisp servers
  (`browser.wispServers`, ws/wss URLs in Settings), so Wave B has to decide how custom servers and these policies fit
  together (an operator allow-list in `connect-src`, or no custom servers on isolated deployments).
- A valid ticket gets `426` from the probe even when the route's HolyWisp is down (the probe never contacts the
  upstream); the upgrade then answers `502 bad_gateway` (checked with a VPN profile whose upstream was not running).
  §4.6's `recover()` would rebuild after every `426` until a rebuild cap stops it: Wave B should back off when an
  upgrade fails right after a `426`, and take a VPN location's status from the app (`GET /api/vpn/locations`); the
  proxy origin's `GET /api/health` now reports only `status` and `wisp.direct` (API.md).
- Short tickets: with `GNOME_WISP_TICKET_TTL_S=60` (the minimum) `scheduleTicketRenewal()` fires at once (its margin is a
  fixed 5 minutes) and the app stub drops the request (its 2 s rate limit), so nothing renews the ticket until a
  connection fails. Wave B: a renewal margin that scales with the lifetime (e.g. `min(5 min, ttl / 2)`) and an app
  side that queues rather than drops a renewal request.
