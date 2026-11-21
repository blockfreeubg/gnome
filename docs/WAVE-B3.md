# Wave B step 3 module plan (built-in extensions)

> Status: plan for Wave B step 3, written 2026-11-12 (`wave-b3:plan`) while step 2's engine-host review and
> integration were still running, then revised the same day (`wave-b3:plan-fix`) with the verified findings of two
> reviews (security, completeness & feasibility; each finding re-checked against the code and the pinned libraries).
> It builds on the hook points step 2 left (`docs/WAVE-B.md` §9), on the frozen contract in `frontend/src/shared/**`
> as it stood on 2026-11-12, and on step 2's page-realm kit `frontend/src/engine-host/realm.ts` (`pageKit`, added by
> step 2's engine-host review at 11:50–12:15 and still being edited then). Small details of the step-2 code may still
> change in step 2's integration; design against the interfaces named here, and re-read the code before editing it.
> Inputs: `docs/research/content-blocking.md` (the research for this step; "research §n" below),
> `docs/ENGINE-PROTOCOL.md` (§1 threat model, §6.17 hooks), `docs/ARCHITECTURE.md` §5.3–§5.5, `docs/WAVE-B.md`
> (§0 rules, §9), the step-2 reports (`handoff/reports/wave-b-*.json`), and measurements made for this plan on this
> machine (§10). Decisions that bind every lane: `docs/PROGRESS.md` decisions log (2026-11-10 "built-in extensions are
> first-party", the 2026-11-11 rows), and the decisions in §1 below, which go into that log when step 3 starts.

Step 3 builds the five built-in extensions of ARCHITECTURE §5.5 (ad blocker, tracker blocker, privacy protection,
cookie manager, cosmetic filtering) on top of step 2's hooks. Five lanes build in parallel without editing each
other's files: **x1** filter engine and network blocking (engine host, Worker, service worker), **x2** cosmetic
filtering and scriptlets, **x3** privacy protection and the cookie manager, **x4** the app UI, **x5** a small
backend addition (filter lists from local files) and the e2e fixtures (the fixture server and the test lists the
deterministic e2e tests need).

## 0. Rules for every lane

- Everything in `docs/WAVE-B.md` §0 applies unchanged: product rules (website only, Rust for the backend only,
  TypeScript + Svelte 5 frontend, engines served unmodified, no fake UI, no placeholders, nothing claimed without a
  test), host safety (no privileged containers, no host kernel/sysctl/binfmt changes, no sudo; HolyWisp as in the e2e
  runner), ports from the environment, e2e against the real gnome-server + HolyWisp in Chromium and Firefox, "edit
  only the files your lane owns", "no stub modules in another lane's paths and no import of a module that does not
  exist yet" (take the other lane's module as a parameter of your own composition root and inject a fake in tests).
- **Built-in extensions are first-party** (decisions log 2026-11-10): no `chrome.*` emulation, no user-installed
  extensions, no extension manifest, and no text anywhere that suggests Chrome-extension or uBlock Origin
  compatibility. GNOME uses uBO-format filter lists and uBO's redirect resources and scriptlets (GPL-3.0, mirrored by
  the server); the UI names them as filter lists, with their publishers and licenses, never as extensions.
- Sapphire has no license: never copy its code, not even a snippet; ideas only.
- **`frontend/src/shared/**` stays frozen until step 2's integration step has finished.** Then lane x1 applies the
  contract changes of §3.1 as one change on its first day (with their tests), after diffing `src/shared/**` against
  this plan (step 2's integration may already have applied C9); nobody else edits `src/shared/**`. That change also
  updates every implementer and constructor of the changed types in the real tree (`testing/fake-sw-client.ts`,
  `transport/manager.ts`, `sw/sw.ts`, `tabs.ts`, `shared/browser-data.test.ts`) and passes the full
  `cd frontend && npm run check && npm test`, not only the shared tests. A lane that needs another change writes the
  exact diff and the reason in its report; the step-3 integration step applies it. All changes keep
  `PROTOCOL_VERSION` at 1: new fields are optional, new commands need the `blocker` capability, and a validator never
  rejects a message an older peer of the same protocol version sends. Lanes x2–x4 import none of the new contract
  types, `src/extensions/core/**` modules or kit additions (§3.3) until x1 reports them landed; until then they code
  against the exact text of this plan with local fakes, so `npm run check` stays green for everyone.
- **Realm hygiene (rule R1, mandatory for every line that touches a proxied document).** A proxied page is
  same-origin with the engine host, so any engine-host object it can reach hands it the engine-host global
  (`fn.constructor('return this')()`, `err.constructor.constructor`, `args.constructor.constructor`), i.e. makes it
  escaped code (ENGINE-PROTOCOL §1.1; step 2 measured that any page also gets there through `borrow-natives`, F2, so
  R1 only keeps GNOME from opening a path of its own). The API is step 2's page-realm kit, `src/engine-host/realm.ts`
  (`pageKit`, `wrapMethod`, `wrapAccessor`, `arg`, `isNative`, `nativePrototype`; x1 adds what §3.3 lists), and its
  header's three rules bind every step-3 line:
  1. **Nothing GNOME installs in a page realm is an engine-host object**: every function value, getter and setter is
     made by the kit (`kit.fn`, `kit.replace`, `kit.wrap`, `wrapMethod`, `wrapAccessor`), errors thrown at a page are
     `kit.error(…)`, data properties hold primitives only.
  2. **Engine-host code never runs page code** once page code may have run in that realm: page objects are read only
     through the engine-host realm's natives (`natives.ts`; Web IDL getters and methods with a brand check run no page
     code) or through kit code that hands back primitives or JSON (`kit.str`, `kit.formEntries`, `kit.readString`);
     never ordinary property access, iteration, spread, `String()`, template literals or calls on page values.
  3. **No engine-host callback receives page nodes**: an engine-host `MutationObserver`, `TreeWalker` filter or
     similar hands parser-made nodes engine-host wrappers (measured by step 2: `document.body` became an engine-host
     object), so page DOM is observed only with `kit.observe`. Engine-host event listeners on page targets are fine
     (step 2 measured their events as page-realm), but every one ignores events whose `isTrusted` (an unforgeable own
     property) is false.

  Kits are built only on GNOME's document-start paths, before page code runs in that realm (Scramjet `init.pre`, the
  UV document-start hook, a child frame the guard reaches at its creation); a realm without a kit gets nothing but
  primitive data properties. Step 2 converted its own sites (§4.7, finding F1); x1 verifies them with row A1.
- **Fail open, never fail broken.** A hook that throws, a filter engine that is not ready, a list that does not load:
  the request is allowed and the page works. Privacy headers and cookie rules need no filter engine and apply from
  the first request (the service worker uses the schema defaults until an engine host sent the user's settings,
  §4.5). Nothing a list contains can stop GNOME's own UI or the engine host from working. Unknown context is not
  first-party: where GNOME cannot tell which page a request belongs to, it applies the global settings without site
  rules and treats the request as third-party (D15), because a page can make its context unknown on purpose.
- **The proxy origin is one shared realm** (decisions log 2026-11-11). Blocking protects against sites that do not
  target GNOME, not against code that escaped its engine, and step 2 measured that any ordinary page can become such
  code without an engine bug (`host-attack borrow-natives`, finding F2, §11.1), so row A0 fails as step 2 ships. The UI never claims more ("protects you from trackers" is wrong; "blocks
  requests to ad and tracker servers on sites you open in GNOME" is right).
- Licenses: `@ghostery/adblocker*` are MPL-2.0 (bundled into GNOME's own chunks; keep their license headers, list
  them in About with their source links); `tldts-*` MIT; the filter lists keep their own licenses, shown per list.
  The built-in tracking-parameter table (x3) carries the ClearURLs attribution (LGPL-3.0 data).
- Every increment keeps `cd frontend && npm run check && npm test` green, and `cargo test --workspace` for x5. Mark
  untested behaviour **[unproven]** in comments and in the report; a test that disproves a claim of this plan changes
  the plan through the report, it is never shipped as if it worked.
- Port ranges: each lane's task gives its range; the e2e runner's ports come from `E2E_PORT_BASE` (WAVE-B §3). The
  blocker fixture server uses `E2E_PORT_BASE + 50` (`E2E_BLOCKER_PORT`, §12.1).

## 1. Decisions this plan settles

Each row is binding for the lanes. The ones marked (log) go into the PROGRESS decisions log when step 3 starts.

| # | Decision | Why |
| --- | --- | --- |
| D1 (log) | **One filter engine per list group**, not one merged engine: groups `ads`, `security`, `trackers`, `params`, `cookies`, `annoyances` (list category → group in §3.2 `GROUP_OF`). Lines that only act together with another list's filters are added to *every* group: exception lines (`@@…`, `#@#…`), `$badfilter` lines and non-exception `$redirect-rule` lines (a `$redirect-rule` only supplies the stub when its own engine's normal filters block, so uBO's unbreak stubs for EasyPrivacy blocks would otherwise be lost). Every list's non-exception `$removeparam` filters go to the `params` group, the only group whose rewrites GNOME applies (D13) | The schema has separate global and per-site toggles for the ad blocker, tracker blocker and cosmetic filtering, and `tab.blocked` reports categories. One engine per group answers both exactly at run time: toggling a blocker globally or per site needs no rebuild, and the group that matched is the category. Measured (§10): matching stays at ~11 µs per request (split 10.7 µs vs merged 11.1 µs, the first group that blocks ends the lookup); the shared exceptions (5,926 lines in the default set) cost +13 % serialized size (9.05 MB vs 7.98 MB). Re-homed by the review (counted in the server's 2026-11-11 copies): 416 non-exception `$redirect-rule` lines (ublock-filters 363, ublock-unbreak 49, ublock-quick-fixes 4) become shared, 265 `$removeparam` filters of the default `ads`/`trackers` lists (ublock-privacy 213, ublock-filters 44, ublock-unbreak 8) move to `params`; x1 re-measures sizes with them |
| D2 | **Group → toggle**: `ads` and `security` follow the ad blocker (`extensions.enabled.adblock`, per-site `adblock`), `trackers` the tracker blocker (`trackers`), `params` privacy protection + "Remove tracking parameters" (`enabled.privacy && privacy.stripTrackingParams`), `cookies` and `annoyances` cosmetic filtering (`cosmetic`). Element hiding follows `cosmetic` (and the group's toggle); generic hiding rules also need `cosmeticAggressive`; scriptlets follow their group's toggle, not `cosmetic` | Scriptlets defuse ad scripts and anti-adblock walls, so they belong to the blocker whose list carries them; cookie-notice and annoyance lists are opt-in page-clutter lists, so all of their rules follow cosmetic filtering |
| D3 | **Precedence for a request or document**: allowlist (`inHostList(allowlist, top)`) > per-site override (`ruleFor(perSite, top)`) > global toggles > filters, keyed by the **tab's top-level page**; frames inherit their tab's policy. **A tab's own document request, every redirect hop of it and its response are judged under the page being loaded** (`top` = the request URL), never under the page being left: otherwise a link from an allowlisted site would exempt a scam page, and under `block-third-party` (the default) every cross-site navigation would lose its own first-party cookies, breaking sign-ins and OAuth callbacks. Host-key matching is `src/shared/site-rules.ts`; the shield's "pause on this site" writes `*.<registrable domain>` (tldts with private suffixes, so `foo.github.io` stays its own site). The allowlist turns off everything list-based (blocking, `$redirect`, parameter stripping, element hiding, scriptlets; the scam and malware list too); privacy headers and cookie rules still apply there | ARCHITECTURE §5.5 and the Settings text ("Blocking is off on these sites"); privacy headers never break a site, so allowlisting a site to fix breakage should not resend tracking data |
| D4 | **Cookie rules are keyed by the cookie's site** (the request or response URL), in every context: `allow` exempts the site from third-party and block-all cookie blocking, `block` strips its cookies everywhere (first-party too), `session` keeps them until GNOME closes (Set-Cookie made a session cookie; at the next fresh start the app deletes that site's cookies). Without a rule, `browser.cookies.mode` decides; "third-party" = registrable domain (private suffixes included) of the cookie's site ≠ that of the tab's top-level page (for the tab's own document: the destination itself, D3). An unknown top-level page counts as third-party | The common browser model ("sites that can always / never use cookies"). A rule keyed by the top-level site could not express "block facebook.com cookies on every site". A page can make its context unknown (no-referrer frames, workers, `about:blank` children), so unknown must not mean first-party |
| D5 (log) | **The per-site maps travel scoped.** `allowlist` and `perSite` (keyed by the top-level site) are sent only for sites the engine host already loads or is about to load: the sites of every open tab's entries, of each GNOME-initiated load (sent before the load command), and of navigations started in a page, which the engine host announces with an optional `url` on `tab.loading` (§3.1 C3; a page-started navigation only after its `navigate` event was not cancelled, at most 2 announcements per tab per second). The app answers every announcement with a `settings` snapshot at once, also when nothing changed, and a tab document request waits for that answer (≤ 150 ms; Scramjet: the engine host holds it when its host was not announced and answered before in this connection, §4.4; Ultraviolet: the SW holds an announced navigation until the engine host's next config, §4.5), so the first page of a site is judged with its rules. Budget (per app page, across engine-host replacements) for what the engine host announces: at most 20 newly exposed rule-bearing sites per tab per minute and 120 per hour; an exposure that adds no allowlist or per-site entry costs nothing; loads started in GNOME's own UI and restored tabs are not budgeted; after two compromise signals (ENGINE-PROTOCOL §1.2 rule 8) in one app page the maps are sent empty for the rest of it. `cookieRules` (keyed by cookie site, any third party) are sent whole, and only while the cookie manager is on | ENGINE-PROTOCOL §1.2 rule 4 asks step 3 to narrow what the engine host gets, and the step-2 security review asked for "only the open tabs' sites". A hostile page then learns the rules of sites it already shows, plus at most the budgeted number it can forge announcements for. Cookie rules cannot be scoped: any third-party domain on any page may need one. Rejected: sending everything (the decision log's fallback), hashed keys (low-entropy host names are cracked offline, and escaped code can test any site through the hooks anyway), a per-connection cap (the app replaces the engine iframe on every unexpected load, which would reset it, and ordinary browsing used it up) |
| D6 (log) | **The cached engine is MAC'd with a key the app holds.** The app keeps a random 256-bit `blockerKey` in its own IndexedDB (never on the proxy origin) and sends it in `init`. The engine host stores each built engine set in Cache Storage with an HMAC-SHA-256 over its manifest (which names the set key K and carries each group's SHA-256), and uses a cached set only when the MAC verifies and the manifest names exactly the K being loaded; otherwise it rebuilds. The key is replaced whenever the user clears site data (also "clear on exit"; `gnome-blocker-v1` is deleted with the other caches then) and after a compromise signal (sets under the old key then fail verification and are deleted). The service worker never reads the cache: it gets the engines from an engine host (D15). Scriptlet code is never taken from anywhere but the verified `ubo-resources` list | Proxied pages can reach the proxy origin's Cache Storage: UV 3.2.10 hooks neither `caches` nor `CacheStorage` (code reading, 2026-11-12), Scramjet prefixes `open`/`has`/`match`/`delete` with the site but not `keys()`. A planted engine would otherwise inject CSS or scriptlets into every proxied page across reloads. The manifest's MAC is a per-user value UV pages can read, so it changes with "Clear site data" like a cookie would. Escaped code can read the key, which is the stated limit; it can already replace the service worker (B7) |
| D7 | **Fail open until ready, never during updates**: hooks allow list-based decisions while no engine set is loaded; a new list set is built in the background while the previous engines stay in force and is swapped in when ready. `init` waits up to 500 ms for a verified cached set (restored tabs are filtered from their first request) but never for a build. Privacy headers and cookie rules never wait: the service worker applies the schema defaults until an engine host sent the user's settings | First-run builds take seconds on slow devices (§10); updates must not open a gap |
| D8 | **Builds run in a dedicated module Worker** on the proxy origin (`/assets/…`, Vite `new Worker(new URL(…), {type: 'module'})`), groups one after the other, the Worker terminated after each build; one build at a time per browser (Web Lock `gnome-blocker-build`, with a 30 s wait cap so a page holding the lock only delays the build); cosmetic selectors are validated on the engine-host main thread with `CSSStyleSheet.insertRule` in ≤ 8 ms slices | Measured peak ~200 MB above baseline while the largest group parses (§10); the main thread is shared with the app (ARCHITECTURE §5.4); a DOM-less build keeps invalid selectors that disable whole 1,024-selector rules (research §2.8) |
| D9 | **List integrity**: the Worker fetches `GET /api/filters/<id>?v=<sha256>` and compiles a list only when the body's SHA-256 equals the ref's; otherwise that list is skipped this build and reported (`blocker.stats` → `failed` with the error code `changed`), the app refreshes its `/api/filters` listing, and sends new refs | The server keeps only the current version (API.md: a stale `?v=` gets the current body with `no-cache`) |
| D10 | **`$redirect` resources are answered, not refused, for subresources only**: the network provider returns `block` with a `resource` (§3.1 C7), which both engines answer `200` with that body; a tab document or a frame is never answered with a resource (HTML resources such as `click2load.html` would become unrewritten frame documents). In Ultraviolet a script resource goes through UV's own JS rewriter (`ctx.ultraviolet.js.rewrite`) first, because UV returns an intercepted request before its body rewriting **[unproven]**: if that fails, UV script redirects become plain blocks. Blocked subresources otherwise get step 2's empty `403 Blocked by GNOME`; blocked tab documents end in `tab.error {kind: 'blocked'}` and GNOME's overlay; blocked frames show an empty document | 7,299 `$redirect` matches in the research corpus (research §3.2): without the stubs pages that expect the script break |
| D11 | **Scriptlets run in the page realm at document start, after the engine's client hooked the window**, through `PageKit.run(source)` (§3.3), which compiles the source with that realm's current `Function` (the engine's wrapper, so the engine rewrites the scriptlet like page code): Scramjet `init.post`; Ultraviolet right after UV's handler hooked the window (its `self.__uvHook = …` assignment, before any page script), so the scriptlets see UV's virtual location, cookie jar and storage instead of the shared proxy-origin ones. Never through a `<script>` element, never in the engine-host realm. **GNOME assembles every scriptlet call itself, with the arguments as one JSON array** (§4.2 `scriptletCall`), because Ghostery 2.20.3's own assembly lets list text run as code. **Trust**: a scriptlet that needs trust (every name and alias of a `requiresTrust` scriptlet in the verified `ubo-resources`, and every `trusted-` name) runs only from lists with `trusted: true` (the server registry's flag: every `ublock-*` list, `adguard-spyware-url`); the sanitizer drops such lines from every other list, and also every untrusted `+js()` line whose arguments contain a backtick or `$`. **[unproven]** in both engines; if a test disproves them in one engine, scriptlets are off for that engine and About says so | Research §2.7, §2.11, §6.5. Verified by both reviews against the real library (§11.4): Ghostery 2.20.3 pastes each argument into a template literal with `String.prototype.replace`, escaping `.*+?^${}()\|[]\` but not the backtick, so a backtick ends the literal, and `$'`/`` $` `` in an argument splice script text back in (no backtick needed): any list could run code in every page it names; it ignores `requiresTrust` (`rpnt`, `replace-node-text`, `prevent-clipboard-write` ran from an untrusted list) and trims the name (`+js( trusted-set-cookie, …)` passed a prefix check). The planner's first probe missed the break-out because the injected code then threw |
| D12 | **Engine configuration v1**: `loadPreprocessors: true` (+ `updateEnv` after every deserialize: `env_chromium`/`env_firefox` from `browserFamily()`, everything else false), `loadExtendedSelectors: false` (`#?#` dropped), `loadCSPFilters: false` (`$csp` not emulated), `enableHtmlFiltering: false`, `enableCompression: false`, `integrityCheck: true`. Not in v1: procedural selectors, HTML filtering, `$csp`, `$popup` blocking, `$urlskip`, ClearURLs redirections, subresource `$removeparam` (the verdict can only redirect documents) | Research §2.4, §2.10; each "not in v1" item is listed in About's known limitations |
| D13 | **Parameter stripping is documents only** (tab documents and frames, GET/HEAD): the `params` group's `$removeparam` result (the `$removeparam` filters of every enabled list, D1) plus GNOME's built-in table (research §7.1), applied as the hook's 307 `redirect`, only when the cleaned URL keeps the request's origin; the built-in table works before any engine is ready | The contract's `redirect` verdict is for documents; links are where tracking parameters matter |
| D14 | **New protocol pieces** (all optional or capability-gated, `PROTOCOL_VERSION` stays 1): `blocker.stats` and `blocker.reload` commands, `InitPayload.blockerKey`, `EngineSettings.extensions.cacheLimitMB`, `tab.loading.url`, `EngineDiagnostics.blocker`; in the hooks `RequestInfo.documentUrl`/`referrer`, `RequestVerdict` resources, `ResponseHeaders.append`; engine host → SW `gnome-blocker-config.setId`, `gnome-blocker-engines` and `gnome-blocker-context`; SW → engine host `uv-blocked` as per-document counts (§3.1 C1–C12). `status.blocker.detail` and a list's `error` are codes the app turns into its own text, never display text from the engine host | ENGINE-PROTOCOL §4 removed `blocker.reload`/`blocker.stats` from the draft because the snapshot carries the lists; step 3 needs them back for what the snapshot cannot do: the Extensions page's compiled-list and cache facts, and a user-visible rebuild that discards cached data. Free text from a realm escaped code owns would let it write any message into GNOME's own UI |
| D15 | **The UV side gets page context from the engine host**: the SW cannot tell tabs apart, so the engine host sends it `[proxied document URL, top-level URL]` for every UV document it attaches and the proxied URLs a UV tab's top document is about to load (`gnome-blocker-context`). The SW maps a request to its document by `FetchEvent.clientId` (recorded at each UV navigation's and worker script's `resultingClientId`); the referrer is used only to look up a document the SW has recorded, never to create a context. Unknown context (a client the SW never recorded, after a 50 ms wait for its context) is judged with the global settings and no site rules, as third-party (Ghostery source `https://unknown.invalid/`, cookies blocked under `block-third-party`), never as its own top-level page. The SW gets its engines by message from an engine host (`gnome-blocker-engines`), so Ultraviolet pages are filtered also when the set is not cached. Engine-host messages count only from client ids the SW recorded as engine hosts (§4.5) **[unproven]** race and hit rates, measured in §12 | Per-site rules and third-party cookie rules need the tab's top-level site; frames must inherit it. A page controls its referrer (`referrerpolicy`, `fetch(…, {referrer})`) and can create clients the SW never saw, so a referrer-based or "own page" fallback would let it pick its own policy; a URL-based engine-host check is fooled by `history.pushState` to `/engine/` (finding F3) |
| D16 | **Scramjet WebSockets are judged in the page realm**: lane x1 wraps the Scramjet client's WebSocket creation at `init.post` (`kit.replace`, rule R1), with the tab, document and top-level URL; the transport manager's `useHooks()` wrapper, which sees only the target URL, stays as a backstop: it skips a socket only by consuming a one-shot mark the wrapper left when it *allowed* that URL (5 s), blocks a URL the wrapper blocked in the last 5 s, and judges the rest without context (third-party sentinel) **[unproven]**: needs the spike of §4.6; without it WebSockets are judged without per-site context and About says so | Step 2's transport wrapper passes `tabId: null, topLevelUrl: null` (`transport/manager.ts #checkWebSocket`). A socket opened past the wrapper (Scramjet's client is reachable from every page, F2) must not inherit the wrapper's decision |
| D17 | **Filter lists from local files on the server** (lane x5): a `GNOME_FILTER_LISTS_FILE` entry may name `file = "/abs/path"` instead of `url` (also the built-in `ubo-resources` entry); only regular files outside `/proc`, `/sys` and `/dev`, read with a size bound and a timeout | The e2e tests need deterministic test lists served by the real gnome-server, whose fetcher refuses loopback hosts (SSRF policy); operators get "my own list from disk" |
| D18 | **Pins** (frontend/package.json, exact): `@ghostery/adblocker@2.20.3`, `@ghostery/adblocker-content@2.20.3`, `@ghostery/adblocker-extended-selectors@2.20.3`, `tldts-experimental@7.4.19`, `tldts-core@7.4.19` (all `dependencies`, bundled into GNOME's chunks). Confirmed 2026-11-12: 2.20.3 is still the newest release (2026-10-28; `ENGINE_VERSION` 899); its dependency ranges are carets (`@ghostery/adblocker-content ^2.20.3`, `-extended-selectors ^2.20.3`, `tldts-experimental ^7.4.10`), so the siblings are pinned too; tldts-experimental shipped five releases between 2026-11-10 and 2026-11-12 (7.4.21–7.4.26), so the plan pins 7.4.19, the version the research measured. Lane x1 owns `package.json` and the lock | One copy of each in the lock (`npm ls` check); every realm reaches `tldts-experimental` only through `src/extensions/core/site.ts` (the app lazily, for the shield's site key and the cookie manager's grouping) |
| D19 (log) | **The blocker exists only where `blocker` is offered.** The engine host creates the blocker (and registers its hooks) only when `blocker` is among the capabilities it offers; otherwise ALLOW_ALL stays and the lists the app sends (public data) are ignored. Production offers `blocker` from the integration step on (§12.4). E2E builds get it earlier through a build-time switch: `GNOME_ENGINE_TEST_CAPABILITIES=blocker` → the define `__GNOME_ENGINE_TEST_CAPABILITIES__` (with `__GNOME_ENGINE_TEST__` only), which the engine host adds to `InitResult.capabilities` and diagnostics, and which makes the app call `registerFeature('extensions')` in e2e builds | Blocking that the user can neither see nor undo (no shield, no allowlist, empty site rules) is fake UI by omission. `test.offer` only widens the engine host's command gate, while the app learns capabilities only from `init`, so without the switch no app-side row could run before the final matrix |

## 2. Lanes at a glance

| Lane | Owns (directories and files) | Provides | Consumes |
| --- | --- | --- | --- |
| **x1** filter engine + network blocking | `src/extensions/core/{compose,policy,categories,site,version,detail}.ts` (+ tests); `src/extensions/filters/**`; `src/extensions/worker/**`; `src/extensions/sw/**`; `src/extensions/host/**`; step-2 files it changes (with their `*.test.ts`): `src/engine-host/{core,tabs,hooks,context,coalesce,main,site-data,popups,webrtc,nav-machine,realm,natives,build-info}.ts`, `src/engine-host/observe/**`, `src/engine-host/transport/manager.ts`, `src/engine-host/testing/**`, new `src/engine-host/blocked.ts`, `src/sw/{sw,hooks,pure,globals.d}.ts`, `src/vite-env.d.ts` (the test-capability define); the contract changes of §3.1 in `src/shared/**` (day one, once); `frontend/package.json` + lock, `frontend/vite.config.ts`, `frontend/vite.sw.config.ts`, `frontend/tsconfig*.json`; e2e: `tests/e2e/engine/fixtures/blocker/{network/**,lists/network.txt}`, `tests/e2e/engine/suites/blocker-{network,uv,cache,attack,sites}.mjs`, `tests/e2e/engine/suites/build.mjs` (graph rules, size budgets) | the composite hooks (`composeHooks`), `SitePolicy`, `FilterEngines` (what x2/x3 read from the compiled engines, with GNOME's scriptlet assembly), the blocker in both engines (`createBlocker`, `startSwBlocker`), `blocker.stats`/`blocker.reload`, `status.blocker`, per-category `tab.blocked`, the kit additions of §3.3, `withPageAssignments`, the UV `__uvHook` document point | x2 `sanitizeList`, `trustOnlyScriptlets`, `validateSelectors`, `createCosmeticProvider`; x3 `createCookieProvider`, `createPrivacyProvider`, `withCookieDocument`, `withPrivacyDocument` (all injected into its composition root until they land); x5 the fixture server and test-list TOML |
| **x2** cosmetic + scriptlets | `src/extensions/core/{sanitize,selectors}.ts` (+ tests); `src/extensions/cosmetic/**`; e2e: `tests/e2e/engine/fixtures/blocker/{cosmetic/**,lists/cosmetic.txt,lists/cosmetic-trusted.txt}`, `tests/e2e/engine/suites/blocker-cosmetic.mjs` | `sanitizeList` and `trustOnlyScriptlets` (x1's Worker runs them), `validateSelectors` (x1's build runs it on the main thread), `createCosmeticProvider` (element hiding, GNOME's own generic-rule monitor, scriptlets) | x1 `FilterEngines`, `HookProvider`/`RequestContext`, `PageKit` (with §3.3's additions), `Natives`, `withPageAssignments` |
| **x3** privacy + cookies | `src/extensions/privacy/**`; `src/extensions/cookies/**`; step-2 files it changes: `src/engine-host/{cookies,cookie-ops}.ts`; e2e: `tests/e2e/engine/fixtures/blocker/{privacy/**,lists/privacy.txt}`, `tests/e2e/engine/suites/blocker-{privacy,cookies}.mjs` | `createPrivacyProvider`/`withPrivacyDocument` (GPC, DNT, the referrer floor and modes, parameter stripping), `createCookieProvider`/`withCookieDocument` (third-party modes, per-site rules, `document.cookie`), `freshStartCookieDeletes` (app side), the built-in parameter table | x1 `FilterEngines.rewriteParams`, `HookProvider`, `SitePolicy`, `cookieRuleFor`, `cookiesBlocked`, `PageKit`; the existing `cookies.delete` command |
| **x4** app UI | `src/pages/extensions/**`; `src/extensions/app/**`; step-2 app files it changes: `src/browser/{browser.svelte,tabs.svelte}.ts`, `src/browser/engine/{snapshot,client}.ts`, `src/browser/ui/{Toolbar,ErrorOverlay}.svelte`, `src/browser/ui/error-copy.ts`, new `src/browser/ui/Shield*.svelte`, `src/browser/testing/fake-engine-host.ts`, `src/pages/settings/**`, `src/pages/about/**`, `src/app/status.ts`; e2e: `tests/e2e/engine/fixtures/blocker/ui/**`, `tests/e2e/engine/suites/shell-blocker.mjs` | the Extensions page, the toolbar shield, the blocked-page actions, the list refs (`filterListRefs`), the scoped site maps (`SiteExposure`), the blocker key (and its rotation), the fresh-start cookie deletes wiring, the texts of the status and list codes, `registerFeature('extensions')` | x1 protocol additions (`blocker.*`, `tab.loading.url`, `status.blocker`, `tab.blocked`, the test-capability define); x3 `freshStartCookieDeletes`; `src/extensions/core/{site,categories,policy,detail}.ts` |
| **x5** backend + e2e fixtures | `backend/src/filters/**`, `backend/README.md` (registry section), `docs/API.md` "Content-blocking filter lists", ARCHITECTURE §4.2 `GNOME_FILTER_LISTS_FILE` row; the step-3 parts of the e2e runner: `tests/e2e/engine/{run.mjs,lib/**}` (fixture server start, test-list TOML, `--blocker-real`, the generated big list), `tests/e2e/engine/servers/blocker-fixtures.mjs`, `tests/e2e/engine/fixtures/blocker/lists/ubo-resources.json` | `file = "/abs/path"` list sources (§8), the fixture server and the per-run test lists (§12.1) | — |

Directory map (ARCHITECTURE §3, `src/extensions/` "content-blocking runtime behind `src/shared/engine-hooks.ts`"):

```
frontend/src/extensions/
├── core/        pure, DOM-free, compiles in every scope (app, engine host, Worker, SW)
│   ├── compose.ts policy.ts categories.ts site.ts version.ts detail.ts   (x1)
│   └── sanitize.ts selectors.ts                                     (x2; selectors.ts needs a CSSStyleSheet passed in)
├── filters/     window side: engine loading, cache, Worker client, network provider, stats,
│                scriptlet assembly (scriptlets.ts)                                         (x1)
├── worker/      builder.worker.ts + build.ts (the dedicated Worker)                        (x1)
├── sw/          SW side: engines received by message, UV context, SW composition           (x1)
├── host/        engine-host composition root createBlocker(), UV context and engine sender (x1)
├── cosmetic/    provider, injection, generic-rule monitor, scriptlet runner                (x2)
├── privacy/     provider (pure), document overrides (window), params table                (x3)
├── cookies/     provider (pure), document.cookie override (window), fresh-start helper    (x3)
└── app/         app side: list refs, site exposure, blocker key, session stats            (x4)
```

Import rules (lane x1 extends the build test `tests/e2e/engine/suites/build.mjs`): the engine-host entry and its
Worker may import `src/engine-host/**`, `src/shared/**`, `src/lib/keys.ts`, `src/extensions/{core,filters,worker,host,
cosmetic,privacy,cookies}/**` and `node_modules/@ghostery/**`, `node_modules/tldts-*/**`; `@ghostery/adblocker` and
`src/extensions/filters/engines.ts` reach the engine-host graph only through a dynamic `import()` inside
`createBlocker` (its own chunk; §10.2 size budget); the SW build may import `src/sw/**`, `src/shared/**`,
`src/extensions/{core,sw}/**`, the DOM-free `src/extensions/filters/network.ts`,
`src/extensions/privacy/{provider,params}.ts` and `src/extensions/cookies/provider.ts`, and the same packages without
`@ghostery/adblocker-content` (no DOM types: `tsconfig.sw.json` checks it); the app may import `src/extensions/{core,app}/**`
and `src/extensions/cookies/fresh-start.ts`, never `filters`, `worker`, `sw`, `host` or the window parts of
`cosmetic`/`privacy`/`cookies`; `@ghostery/adblocker` never enters the app graph (`tldts-experimental` may, lazily).

## 3. New shared code

Everything in this section is exact (what was compiled and checked, and what not, is at the end of §3.1). Lane x1 adds §3.1 and §3.2 on its first day after step 2's integration step has finished (one change,
with the tests listed), §3.3 the same day; the other lanes code against these signatures from their first hour and
inject fakes until the files exist.

### 3.1 Contract changes in `frontend/src/shared/**` (additive; `PROTOCOL_VERSION` stays 1)

**C1 — `engine-protocol.ts`: optional keys in validators.** Next to `partial()`:

```ts
/** Required keys of `shape` plus optional keys of `optional` (absent stays absent); unknown keys are dropped. */
function objectWith<T extends object, O extends object>(shape: Shape<T>, optional: Shape<O>): Check<T & Partial<O>> {
  const required = object<T>(shape);
  const extra = partial<O>(optional);
  return (v, path) => ({ ...extra(v, path), ...required(v, path) });
}
```

**C2 — `EngineSettings.extensions.cacheLimitMB`** (the settings value `performance.cacheLimitMB` reaches the cache):

```ts
  extensions: {
    // …the six existing members unchanged…
    /**
     * `performance.cacheLimitMB` (Wave B step 3): the cap on what the content blocker keeps in Cache Storage on the
     * proxy origin, in MiB (16–8192, the settings range). Absent (an older app of the same protocol version) = 256.
     */
    cacheLimitMB?: number;
  };
```
and in `engineSettings`: `extensions: objectWith<Omit<EngineSettings['extensions'], 'cacheLimitMB'>, { cacheLimitMB:
number }>({ /* the existing six checks */ }, { cacheLimitMB: int(16, 8192) }),`.

**C3 — `tab.loading.url`** (D5: the app exposes a site's rules before its page loads):

```ts
  /**
   * `url`: only with `loading: true`, for a navigation whose destination is known when it starts (GNOME-initiated,
   * Scramjet's request hook, the Navigation API's `navigate` event once it was not cancelled), fitted like
   * tab.committed's (reportUrl; omitted when it does not fit). The app uses it to send that site's content-blocker
   * rules before the page loads and answers every such event with a `settings` snapshot, also when nothing changed
   * (WAVE-B3 D5). The engine host never coalesces an event that carries it and sends at most 2 per tab per second
   * (beyond that, the event goes out without `url`).
   */
  'tab.loading': { tabId: TabId; loading: boolean; url?: string };
```
validator: `'tab.loading': refine(objectWith<{ tabId: TabId; loading: boolean }, { url: string }>({ tabId, loading: bool
}, { url: httpUrl }), (e) => e.url === undefined || e.loading, 'url only with loading: true'),`.

**C4 — `InitPayload.blockerKey`** (D6):

```ts
export interface InitPayload {
  settings: EngineSettings;
  ticket: Ticket | null;
  clearOnStart: { cookies: boolean; siteData: boolean };
  /**
   * Wave B step 3: a random 256-bit key (64 lower-case hex digits) the app keeps in its own storage, never on the proxy
   * origin. The content blocker MACs what it caches on the proxy origin with it and uses cached filter data only when
   * the MAC verifies, so a page that writes the proxy origin's Cache Storage cannot plant filters or scriptlets.
   * The app replaces it when site data is cleared and after a compromise signal (WAVE-B3 D6). Escaped code can read
   * it (ENGINE-PROTOCOL §1). Absent: the blocker caches nothing.
   */
  blockerKey?: string;
}
```
validator: `init: objectWith<Omit<InitPayload, 'blockerKey'>, { blockerKey: string }>({ settings: engineSettings,
ticket: nullable(ticket), clearOnStart: object<InitPayload['clearOnStart']>({ cookies: bool, siteData: bool }) }, {
blockerKey: token(SHA256_RE, 'a 64-digit lower-case hex key') }),`.

**C5 — `blocker.stats` and `blocker.reload`** (D14). Types (after `BlockerStatus`):

```ts
/** One filter engine per list group (WAVE-B3 D1); a block by a group is counted as its BlockCategory. */
export type BlockerGroup = 'ads' | 'security' | 'trackers' | 'params' | 'cookies' | 'annoyances';
export const BLOCKER_GROUPS: readonly BlockerGroup[] = ['ads', 'security', 'trackers', 'params', 'cookies', 'annoyances'];

/**
 * Why a list was not compiled (WAVE-B3 D9): the download failed, the server's body no longer has the ref's hash, the
 * list exceeds the size cap, it is not valid UTF-8, or the engine could not be built from it. A code: the app shows
 * its own text (never text the engine host wrote) and takes list names only from its own /api/filters listing.
 */
export type BlockerListError = 'download' | 'changed' | 'too-large' | 'invalid-utf8' | 'build';
export const BLOCKER_LIST_ERRORS: readonly BlockerListError[] = ['download', 'changed', 'too-large', 'invalid-utf8', 'build'];

export interface BlockerListStats {
  id: string;
  /** The ref's SHA-256 (what the app asked for). */
  sha256: string;
  state: 'compiled' | 'failed';
  /** Null when compiled. */
  error: BlockerListError | null;
  /** Filter lines the sanitizer kept, and the ones it removed (scriptlets that need trust in an untrusted list, unsafe scriptlet arguments, unsafe :style(), invalid selectors, unsupported syntax). */
  rules: number;
  dropped: number;
}

export interface BlockerStats {
  /** `ENGINE_VERSION` of @ghostery/adblocker (899 for 2.20.3). */
  engineVersion: number;
  /** Unix ms when the engines in force were built (loaded from the cache: the start of the UTC day); null before the first. */
  builtAt: number | null;
  buildMs: number | null;
  /** Where the engines in force came from: a verified cache entry, or a build by this engine host. */
  source: 'cache' | 'build' | null;
  engines: Array<{ group: BlockerGroup; bytes: number; network: number; cosmetic: number; scriptlets: number }>;
  lists: BlockerListStats[];
  /** GNOME's blocker cache on the proxy origin (Cache Storage), against cacheLimitMB. */
  cache: { bytes: number; entries: number; limitBytes: number };
  /** uBO redirect resources and scriptlets loaded from `ubo-resources`; null without them. */
  resources: { redirects: number; scriptlets: number } | null;
}
```
`CommandMap` gains (and `COMMAND_TYPES` lists both at the end):

```ts
  /** Capability `blocker`: what the content blocker compiled, from where, and what it caches (the Extensions page). */
  'blocker.stats': { payload: Empty; result: BlockerStats };
  /**
   * Capability `blocker`: discard every cached engine set and rebuild the current one from the server's lists. Resolves
   * when the build has started (progress in status.blocker); the engines in force stay until the new ones are ready.
   */
  'blocker.reload': { payload: Empty; result: Empty };
```
`requiredCapability`: `case 'blocker.stats': case 'blocker.reload': return 'blocker';` (`commandTimeoutMs` keeps the
10 s default). `COMMAND_PAYLOADS`: `'blocker.stats': empty, 'blocker.reload': empty`. `COMMAND_RESULTS`:
`'blocker.stats': blockerStats, 'blocker.reload': empty`, with, before the per-type tables:

```ts
const blockerGroup = /*#__PURE__*/ oneOf(BLOCKER_GROUPS);
const blockerStats = /*#__PURE__*/ object<BlockerStats>({
  engineVersion: int(0, 65_535),
  builtAt: nullable(timestamp),
  buildMs: nullable(duration),
  source: nullable(oneOf<'cache' | 'build'>(['cache', 'build'])),
  engines: array(
    object<BlockerStats['engines'][number]>({ group: blockerGroup, bytes, network: count, cosmetic: count, scriptlets: count }),
    BLOCKER_GROUPS.length,
  ),
  lists: array(
    object<BlockerListStats>({
      id: token(ID_RE, 'a filter list id'),
      sha256: token(SHA256_RE, 'a lower-case hex SHA-256'),
      state: oneOf<BlockerListStats['state']>(['compiled', 'failed']),
      error: nullable(oneOf<BlockerListError>(BLOCKER_LIST_ERRORS)),
      rules: count,
      dropped: count,
    }),
    LIMITS.maxFilterLists,
  ),
  cache: object<BlockerStats['cache']>({ bytes, entries: count, limitBytes: bytes }),
  resources: nullable(object<NonNullable<BlockerStats['resources']>>({ redirects: count, scriptlets: count })),
});
```

**C5b — `status.blocker.detail` carries a code** (no type change: `BlockerStatus.detail` stays `string | null` and its
validator stays; the doc comment of `BlockerStatus` says so, and step 2 only ever sends `null`). The engine host writes
exactly one of these, the app renders its own sentence for each (x4) and a generic one ("The content blocker reported
a problem.") for anything else:

| `state` | `detail` | The app's text (x4, `error-copy.ts`) |
| --- | --- | --- |
| `building` | `null` | "Preparing filter lists…" |
| `ready` | `null` | — |
| `ready` | `lists-failed:<failed>:<total>` | "<failed> of <total> filter lists could not be loaded" |
| `ready` | `over-cache-limit:<bytes>:<limitBytes>` | "The filter data (<MB>) is larger than the cache limit (<MB>): it is rebuilt each time GNOME starts" |
| `ready` | `cache-rejected` | "The cached filter data did not verify and was rebuilt" (once) |
| `failed` | `failed:<reason>`, reason one of `all-lists-failed`, `worker-crashed`, `out-of-memory`, `build-error` | "Filter lists could not be prepared" + a reason sentence (`out-of-memory`: "…turn off some filter lists") |
| `off` | `null` | — |

`<failed>`, `<total>`, `<bytes>`, `<limitBytes>` are decimal integers. x1 adds `src/extensions/core/detail.ts`
(pure; the app may import it) with `formatBlockerDetail(d: BlockerDetail): string` and `parseBlockerDetail(s: string |
null): BlockerDetail | null` over the union of the rows above, unit-tested against this table; x4 renders the text
from the parsed value.

**C6 — `engine-hooks.ts`: `RequestInfo.documentUrl` and `referrer`** (the filter engine's party checks; referrer
trimming must only ever reduce what the engine sends):

```ts
export interface RequestInfo {
  // …engine, tabId, url, method, isTopLevelDocument unchanged…
  /**
   * The top-level page the request belongs to (first-party context): for a request with `isTopLevelDocument` (the
   * tab's own document, every redirect hop) the request URL itself, never the page being left; otherwise the tab's
   * top-level page (Scramjet: the committed page, or the page being loaded for requests of that new document before
   * its commit; Ultraviolet: what the SW's context map says). Null when unknown; consumers treat unknown as
   * third-party (WAVE-B3 D4, D15).
   */
  topLevelUrl: string | null;
  /** `Request.destination` ('' for fetch/XHR); `'websocket'` for onWebSocket calls. */
  destination: string;
  /**
   * The real http(s) URL of the document that made the request (Scramjet: the client's URL; Ultraviolet: the SW's
   * client map, or a recorded document the referrer names), the parent document for a frame navigation, the URL itself
   * for a tab's top document; an `about:`, `blob:` or `data:` client counts as its tab's top-level page; null when
   * unknown. The filter engine's first-party/third-party and `$domain` checks use it; per-site rules use topLevelUrl.
   */
  documentUrl: string | null;
  /** The real URL the engine is about to send as `Referer`; null when it sends none. */
  referrer: string | null;
}
```
Both new fields are required: x1's day-one change fills them at every construction site (`tabs.ts` twice,
`transport/manager.ts #checkWebSocket`, `sw/sw.ts requestInfo`, `shared/browser-data.test.ts`).

**C7 — `$redirect` resources in the verdict** (D10):

```ts
/**
 * A `$redirect` resource (uBO's redirect resources): answered `200` with this body instead of a refusal. Only for
 * subresources: a tab document or a frame (destination document/iframe/frame, or isTopLevelDocument) is never answered
 * with one; the call sites treat such a verdict as a plain block.
 */
export interface RedirectResource {
  /** Bare, lower-case MIME type without `;base64`. */
  contentType: string;
  /** The body; base64 when `base64` is true. At most 1 MiB decoded. */
  body: string;
  base64: boolean;
}

export type RequestVerdict =
  | { action: 'allow'; headers?: HeaderChanges }
  /** With `resource`: answered with it (`$redirect`). Without: refused (subresources: an empty 403; tab documents: tab.error `blocked`). */
  | { action: 'block'; category: BlockCategory; resource?: RedirectResource }
  /** Documents only (tracking-parameter stripping): answered with a 307 to `url` (an http(s) URL). */
  | { action: 'redirect'; url: string };
```
and in `safeVerdict` (`BLOCK_CATEGORIES` imported as a value; this file stays DOM-free):

```ts
const RESOURCE_TYPE_RE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/;
/** 1 MiB once decoded (base64 length of 1,048,576 bytes). */
const RESOURCE_MAX_CHARS = 1_398_104;
function goodResource(r: unknown): r is RedirectResource {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.contentType === 'string' && RESOURCE_TYPE_RE.test(o.contentType) && typeof o.body === 'string'
    && o.body.length <= RESOURCE_MAX_CHARS && typeof o.base64 === 'boolean';
}
// in safeVerdict, replacing the first `if` (the existing `document` test moves above it and gains 'frame'):
    const document = req.isTopLevelDocument || req.destination === 'document' || req.destination === 'iframe' || req.destination === 'frame';
    if (v && v.action === 'allow') return v;
    if (v && v.action === 'block' && BLOCK_CATEGORIES.includes(v.category)) {
      return v.resource === undefined || (!document && goodResource(v.resource)) ? v : { action: 'block', category: v.category };
    }
```

**C8 — `ResponseHeaders.append`** (several `Set-Cookie` lines after a session rule rewrote them):

```ts
export interface ResponseHeaders {
  get(name: string): string | null;
  getAll(name: string): string[];
  set(name: string, value: string): void;
  /** Adds one more value of `name` (Set-Cookie: one header line per cookie). */
  append(name: string, value: string): void;
  delete(name: string): void;
}
```

**C9 — `proxy-origin.ts`: `SwClient.post`** (lane b's step-2 request; `GnomeSwClient` already implements it;
`testing/fake-sw-client.ts` gains it in the same change, recording what was posted):

```ts
  /**
   * Engine host → SW (gnome-blocker-config, -context, -engines): to the active worker; dropped while there is none.
   * `transfer` is not used for engine bytes (the engine host keeps its own copy: its engines are views into them).
   */
  post(message: HostToSwMessage): void;
```

**C10 — `HostToSwMessage`** (D15): the config names the engine set in force, and two messages are added: the engines
themselves (the SW never reads Cache Storage) and the UV page context:

```ts
  /**
   * Content-blocking settings for the SW's UV hooks: validate `settings` with validateEngineSettings. `setId`: the set
   * key K (WAVE-B3 §4.3) of the engines in force at that engine host, null while it has none (absent from an older
   * engine host: null). Sent at once after every `settings` command, every swap and on sw-hello.
   */
  | { type: 'gnome-blocker-config'; settings: unknown; setId: string | null }
  /**
   * The serialized group engines of set `setId` (FiltersEngine.serialize output, one per group in force), sent by an
   * engine host that has at least one Ultraviolet tab: after each swap, when its first UV tab opens, and on sw-hello.
   */
  | { type: 'gnome-blocker-engines'; setId: string; groups: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> }
  /**
   * The top-level page of UV documents (WAVE-B3 D15): `docs` = [proxied document URL, real top-level URL] of documents
   * that started; `navs` = proxied URLs a UV tab's top document is about to load (judged as main_frame); `drop` =
   * announced navs that were cancelled; `reset` = forget what this engine host sent before (sent after sw-hello, with
   * everything it knows, split into one `reset: true` message and as many `reset: false` messages as the limits need).
   */
  | { type: 'gnome-blocker-context'; docs: Array<[string, string]>; navs: string[]; drop: string[]; reset: boolean };
```
with, at module level (`BLOCKER_GROUPS` and the `BlockerGroup` type imported from engine-protocol.ts),

```ts
export const BLOCKER_CONTEXT_LIMITS = { docs: 512, navs: 64, urlLength: 8192 } as const;
/** Per message: at most one engine per group, 64 MiB each, 128 MiB in all. */
export const BLOCKER_ENGINE_LIMITS = { groupBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 } as const;
const HEX64 = /^[0-9a-f]{64}$/;
```
and in `parseHostToSw`, replacing its `gnome-blocker-config` line (the rest stays):

```ts
  if (data.type === 'gnome-blocker-config') {
    if (!isObj(data.settings)) return null;
    const id = data.setId;
    return { type: 'gnome-blocker-config', settings: data.settings, setId: typeof id === 'string' && HEX64.test(id) ? id : null };
  }
  if (data.type === 'gnome-blocker-engines') {
    const { setId, groups } = data;
    if (typeof setId !== 'string' || !HEX64.test(setId) || !Array.isArray(groups) || groups.length > BLOCKER_GROUPS.length) return null;
    const seen = new Set<BlockerGroup>();
    const out: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> = [];
    let total = 0;
    for (const g of groups as unknown[]) {
      if (!isObj(g) || !(g.bytes instanceof ArrayBuffer) || typeof g.group !== 'string') return null;
      const group = g.group as BlockerGroup;
      if (!BLOCKER_GROUPS.includes(group) || seen.has(group)) return null;
      if (g.bytes.byteLength === 0 || g.bytes.byteLength > BLOCKER_ENGINE_LIMITS.groupBytes) return null;
      total += g.bytes.byteLength;
      if (total > BLOCKER_ENGINE_LIMITS.totalBytes) return null;
      seen.add(group);
      out.push({ group, bytes: g.bytes });
    }
    return { type: 'gnome-blocker-engines', setId, groups: out };
  }
  if (data.type === 'gnome-blocker-context') {
    const { docs, navs, reset } = data;
    const drop = data.drop === undefined ? [] : data.drop;
    if (!Array.isArray(docs) || docs.length > BLOCKER_CONTEXT_LIMITS.docs) return null;
    if (!Array.isArray(navs) || navs.length > BLOCKER_CONTEXT_LIMITS.navs || typeof reset !== 'boolean') return null;
    if (!Array.isArray(drop) || drop.length > BLOCKER_CONTEXT_LIMITS.navs) return null;
    const url = (u: unknown): u is string => str(u, BLOCKER_CONTEXT_LIMITS.urlLength) && u.length > 0;
    const pairs: Array<[string, string]> = [];
    for (const d of docs as unknown[]) {
      if (!Array.isArray(d) || d.length !== 2 || !url(d[0]) || !url(d[1])) return null;
      pairs.push([d[0], d[1]]);
    }
    if (!(navs as unknown[]).every(url) || !(drop as unknown[]).every(url)) return null;
    return { type: 'gnome-blocker-context', docs: pairs, navs: [...(navs as string[])], drop: [...(drop as string[])], reset };
  }
```
(`isObj` accepts only plain objects; a structured clone of the engine host's `{group, bytes}` literal is one.)

**C11 — `uv-blocked` becomes per-document counts, and its categories are checked** (today any string passes as a
`BlockCategory`, and the SW calls `clients.matchAll` and posts to every engine host once per blocked request, each of
which then walks its UV frame trees: ad-heavy pages block 100+ requests):

```ts
  /**
   * Wave B step 3: requests of one UV document were blocked since the last report (the SW batches per document, at
   * most one message per document per 250 ms). `documentUrl`: the requesting document's proxied URL as the SW
   * recorded it at its navigation; the engine host maps it to a tab (its own map of the UV documents it attached).
   * Counting only: a blocked UV tab navigation is recognized from the frame load (WAVE-B3 §4.4).
   */
  | { type: 'uv-blocked'; documentUrl: string; counts: Partial<Record<BlockCategory, number>> };
```
and in `parseSwSignal` (`BLOCK_CATEGORIES` becomes a value import next to `fitText`; the step-2 shape
`{documentUrl, category}` an older SW may still send parses as one count):

```ts
    case 'uv-blocked': {
      if (!str(d.documentUrl, 8192)) return null;
      const counts: Partial<Record<BlockCategory, number>> = {};
      const known = (c: unknown): c is BlockCategory => typeof c === 'string' && (BLOCK_CATEGORIES as readonly string[]).includes(c);
      if (known(d.category)) counts[d.category] = 1;
      else if (isObj(d.counts)) {
        for (const [k, v] of Object.entries(d.counts)) {
          if (!known(k) || !nat(v) || v === 0 || v > 100_000) return null;
          counts[k] = v;
        }
      } else return null;
      return Object.keys(counts).length ? { type: 'uv-blocked', documentUrl: d.documentUrl, counts } : null;
    }
```

**C12 — `EngineDiagnostics.blocker`** (optional; an older engine host omits it): what the blocker counts without a tab.

```ts
  /** Wave B step 3: hook throws caught by the composite and the call sites, WebSocket backstop decisions, announcement waits. */
  blocker?: { hookErrors: number; wsBackstopBlocked: number; wsBackstopSkipped: number; announceWaits: number; announceTimeouts: number };
```
validator: the `engineDiagnostics` check becomes `objectWith<Omit<EngineDiagnostics, 'blocker'>, { blocker:
NonNullable<EngineDiagnostics['blocker']> }>({ /* the existing checks */ }, { blocker: object({ hookErrors: count,
wsBackstopBlocked: count, wsBackstopSkipped: count, announceWaits: count, announceTimeouts: count }) })`. `hookErrors`
is today only in the e2e `test.stats`; §10.3 reports it here.

**Tests that come with C1–C12** (x1, same change): `engine-protocol.test.ts` — snapshots without and with
`cacheLimitMB` (16, 8192 accepted; 15, 8193, 1.5 rejected); `tab.loading` with `url` (accepted only with
`loading: true`, `javascript:` rejected); `init` without and with `blockerKey` (63 digits, upper case rejected); both
new commands round-trip through `validateCommandMessage` and `validateCommandResult`, need `blocker`
(`requiredCapability`), stats with 500 lists accepted and 501 rejected, an unknown list `error` code rejected;
diagnostics with and without `blocker`; `engine-hooks` — `safeVerdict` keeps a good resource, drops a malformed one
and any resource for a document or frame (keeps the block), allows an unknown category; `proxy-origin.test.ts` — the three `HostToSwMessage`s parse
(`gnome-blocker-config` without `setId` → `null`, a context without `drop` → `[]`), oversized or malformed context and
engine messages are `null` (a seventh group, a duplicate group, 64 MiB + 1, a non-ArrayBuffer), `uv-blocked` with an
unknown category or a zero count is `null`, the step-2 shape parses as one count; the exhaustive lists of
`engine-protocol.test.ts` (`type lists`, the valid payload/result fixture per command) gain both commands.
`browser/engine/snapshot.test.ts`'s property test keeps passing (x4 adds `cacheLimitMB`). Then the whole tree:
`npm run check && npm test`.

Checked for this plan (scratch copy, 2026-11-12, before the review): the first version of C1–C11 applied to a copy of
`src/shared/**` together with the code of §3.2 compiled with the frontend's `tsc` and `tsconfig` flags (strict,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`; `*.test.ts` and the rest of the tree excluded, which is why the
broken implementers listed in §0 went unnoticed); the existing shared tests then failed only in the two enumerations
above (and one test that reads `tests/e2e/package.json`, absent from the copy), 149 of 153 passed; a small test of the
first `composeHooks`, `sitePolicy`, `cookiesBlocked` and `siteOf` passed. **Re-checked after the review**
(`scratchpad/work-b3-plan-fix/tsc`, the code extracted from this document by a script): the revised C5, C7's
`safeVerdict`, C10, C11, all of §3.2 (`topOf`, `goodRedirect`, `cookiesBlocked` for an unknown party,
`SW_FALLBACK_SETTINGS`, `siteOf` with private suffixes, `listDomainOf`) and `scriptletCall` compile with the same
flags (`tsc` exit 0), and 7 behavioural checks pass (a tab document judged under itself with an allowlisted previous
page, a cross-origin redirect refused and not counted, unknown party blocked, `foo.github.io` its own site, JSON
scriptlet arguments, the new SW messages and signals including the step-2 `uv-blocked` shape, no resource for a
frame). C12 and the §3.3 additions were not compiled; x1 compiles everything in the real tree first.

### 3.2 Step-3 core (`frontend/src/extensions/core/`, lane x1 day one)

Pure, DOM-free, compiled in every scope. **`categories.ts`**:

```ts
import type { BlockCategory, BlockerGroup, FilterCategory } from '../../shared/engine-protocol';

/** The group engine a list compiles into (WAVE-B3 D1). `resources` is not a filter list. */
export const GROUP_OF: Readonly<Record<Exclude<FilterCategory, 'resources'>, BlockerGroup>> = {
  ads: 'ads',
  security: 'security',
  privacy: 'trackers',
  urlparams: 'params',
  cookies: 'cookies',
  annoyances: 'annoyances',
};

/** What a block by a group engine counts as in tab.blocked. */
export const CATEGORY_OF: Readonly<Record<BlockerGroup, BlockCategory>> = {
  ads: 'ads',
  security: 'security',
  trackers: 'trackers',
  params: 'urlparams',
  cookies: 'cookies',
  annoyances: 'annoyances',
};

/** The `extensions.enabled` toggle that governs a group (D2). */
export const TOGGLE_OF: Readonly<Record<BlockerGroup, 'adblock' | 'trackers' | 'privacy' | 'cosmetic'>> = {
  ads: 'adblock',
  security: 'adblock',
  trackers: 'trackers',
  params: 'privacy',
  cookies: 'cosmetic',
  annoyances: 'cosmetic',
};

/** Network matching order: the first group that blocks decides (a badware match counts as `security`). */
export const MATCH_ORDER: readonly BlockerGroup[] = ['security', 'ads', 'trackers', 'cookies', 'annoyances'];
```

**`site.ts`** (the only importer of `tldts-experimental` outside the libraries; x1's unit test pins its answers for
`site-a.localhost`, IP literals, `localhost`, `foo.co.uk`, `foo.github.io` (its own site), punycode):

```ts
import { getDomain } from 'tldts-experimental';

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/**
 * GNOME's notion of a site, like browsers': the Public Suffix List including its private section, so `foo.github.io`
 * and `bar.github.io` are different sites (tldts' default would merge them under `github.io`, and "pause on this site"
 * would then pause every GitHub Pages site).
 */
const SITE_OPTIONS = { allowPrivateDomains: true } as const;

/** Registrable domain of an http(s) URL's host (IP literals and hosts without one: the host itself); else null. */
export function siteOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host.startsWith('[') || IPV4_RE.test(host)) return host;
  return getDomain(host, SITE_OPTIONS) ?? host;
}

/**
 * The `domain` Ghostery's own matching expects for a hostname (tldts defaults, without the private section, as
 * Ghostery's Request.fromRawDetails computes it): only for x1's getCosmeticsFilters/matchCosmeticFilters calls.
 */
export function listDomainOf(hostname: string): string {
  return getDomain(hostname) ?? hostname;
}

/** Whether `url` is third-party to the tab's top-level page (another registrable domain); null when unknown. */
export function isThirdParty(url: string, topLevelUrl: string | null): boolean | null {
  if (topLevelUrl === null) return null;
  const a = siteOf(url);
  const b = siteOf(topLevelUrl);
  return a === null || b === null ? null : a !== b;
}

/** The host key "pause on this site" writes (D3): `*.<registrable domain>`, or the bare host for IP literals. */
export function siteKeyOf(url: string): string | null {
  const s = siteOf(url);
  if (s === null) return null;
  return s.startsWith('[') || IPV4_RE.test(s) ? s : `*.${s}`;
}
```

**`policy.ts`**:

```ts
import { BLOCKER_GROUPS } from '../../shared/engine-protocol';
import type { BlockerGroup, EngineSettings } from '../../shared/engine-protocol';
import { inHostList, ruleFor } from '../../shared/site-rules';
import { TOGGLE_OF } from './categories';

export type BlockerSettings = Pick<EngineSettings, 'privacy' | 'extensions'>;
export type CookieRule = 'allow' | 'session' | 'block';

/** What applies under one tab's top-level page (D3); its frames inherit it. */
export interface SitePolicy {
  /** The top-level site is on the allowlist: nothing list-based applies. */
  readonly allowlisted: boolean;
  /** Network blocking, `$redirect` resources and scriptlets, per group. */
  readonly groups: Readonly<Record<BlockerGroup, boolean>>;
  /** Element hiding with site-specific rules. */
  readonly hide: boolean;
  /** Also the site-independent ("generic") hiding rules. */
  readonly genericHide: boolean;
  readonly gpc: boolean;
  readonly dnt: boolean;
  readonly referrer: 'default' | 'origin-cross-site' | 'none';
  readonly stripParams: boolean;
  /** `browser.cookies.mode` while the cookie manager is on, else 'all'. */
  readonly cookieMode: 'all' | 'block-third-party' | 'block-all';
}

export function sitePolicy(s: BlockerSettings, topLevelUrl: string | null): SitePolicy {
  const e = s.extensions;
  const allowlisted = topLevelUrl !== null && inHostList(e.allowlist, topLevelUrl);
  const site = topLevelUrl === null ? undefined : ruleFor(e.perSite, topLevelUrl);
  const on = {
    adblock: site?.adblock ?? e.enabled.adblock,
    trackers: site?.trackers ?? e.enabled.trackers,
    cosmetic: site?.cosmetic ?? e.enabled.cosmetic,
  };
  const privacy = e.enabled.privacy;
  const stripParams = !allowlisted && privacy && s.privacy.stripTrackingParams;
  const groups = {} as Record<BlockerGroup, boolean>;
  for (const g of BLOCKER_GROUPS) {
    const t = TOGGLE_OF[g];
    groups[g] = !allowlisted && (t === 'privacy' ? stripParams : on[t]);
  }
  const hide = !allowlisted && on.cosmetic;
  return {
    allowlisted,
    groups,
    hide,
    genericHide: hide && e.cosmeticAggressive,
    gpc: privacy && s.privacy.sendGpc,
    dnt: privacy && s.privacy.doNotTrack,
    referrer: privacy ? s.privacy.referrer : 'default',
    stripParams,
    cookieMode: e.enabled.cookies ? s.privacy.cookies : 'all',
  };
}

/** The cookie rule of a cookie's site (D4); null without one, or while the cookie manager is off. */
export function cookieRuleFor(s: BlockerSettings, cookieUrl: string): CookieRule | null {
  if (!s.extensions.enabled.cookies) return null;
  return ruleFor(s.extensions.cookieRules, cookieUrl) ?? null;
}

/**
 * Whether cookies of a request or document are blocked (D4). `allow` and `session` rules allow (a session rule is
 * "allow until GNOME closes"); `thirdParty` null (unknown top-level page) counts as third-party: a page can make its
 * context unknown on purpose (no-referrer frames, workers, about:blank children; D15).
 */
export function cookiesBlocked(p: SitePolicy, rule: CookieRule | null, thirdParty: boolean | null): boolean {
  if (rule === 'allow' || rule === 'session') return false;
  if (rule === 'block') return true;
  if (p.cookieMode === 'block-all') return true;
  return p.cookieMode === 'block-third-party' && thirdParty !== false;
}

/**
 * What the service worker applies before an engine host sent the user's settings (after every SW start): the schema
 * defaults of `settings/defaults.ts` (a unit test compares them), no lists, no site or cookie rules. List-based
 * blocking still fails open (no engines yet); privacy headers and cookie modes do not wait (D7).
 */
export const SW_FALLBACK_SETTINGS: BlockerSettings = {
  privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'block-third-party' },
  extensions: {
    enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true },
    lists: [],
    allowlist: [],
    perSite: {},
    cosmeticAggressive: false,
    cookieRules: {},
  },
};
```

**`version.ts`**: `export const BLOCKER_FORMAT = 1;` (the cache layout of §4.3) and `export const
ADBLOCKER_ENGINE_VERSION = 899;` (a unit test imports `ENGINE_VERSION` from `@ghostery/adblocker` and fails when they
differ, so an upgrade changes the cache key deliberately). `SANITIZER_VERSION` lives in x2's `sanitize.ts`; both are
part of the cache key.

**`compose.ts`** — how several providers become the single `registerEngineHooks()` / `registerSwHooks()` registration:

```ts
import { BLOCK_CATEGORIES } from '../../shared/engine-protocol';
import type { BlockCategory, BlockerStatus } from '../../shared/engine-protocol';
import type { DocumentInfo, EngineHooks, ProxiedWindow, RequestInfo, RequestVerdict, ResponseHeaders, ResponseInfo } from '../../shared/engine-hooks';
import { sitePolicy } from './policy';
import type { BlockerSettings, SitePolicy } from './policy';
import { isThirdParty } from './site';

export interface RequestContext {
  readonly settings: BlockerSettings;
  /** The policy of the tab's top-level page (D3). */
  readonly policy: SitePolicy;
  /** The request's (or document's) site differs from the top-level page's; null when that page is unknown. */
  readonly thirdParty: boolean | null;
}

export type ProviderName = 'network' | 'cookies' | 'privacy' | 'cosmetic';

/** One built-in extension's part of the hooks. Members are optional and synchronous; the composite catches throws. */
export interface HookProvider {
  readonly name: ProviderName;
  configure?(settings: BlockerSettings): void;
  /** null = no opinion. `redirect` only for documents (safeVerdict drops it for anything else). */
  onRequest?(req: RequestInfo, ctx: RequestContext): RequestVerdict | null;
  onResponse?(res: ResponseInfo, headers: ResponseHeaders, ctx: RequestContext): void;
  /** The category that blocks the socket, or null. */
  onWebSocket?(req: RequestInfo, ctx: RequestContext): BlockCategory | null;
  /** Window side only (rule R1 applies to everything it installs). */
  onDocument?(win: ProxiedWindow, doc: DocumentInfo, ctx: RequestContext): void;
  /** Only the network provider has one: it is status.blocker. */
  status?(): BlockerStatus;
}

export interface ComposeOptions {
  /** In this order: network, cookies, privacy, cosmetic (blocks first; document overrides before scriptlets). */
  readonly providers: readonly HookProvider[];
  /**
   * Each block, `$redirect` answer and parameter-stripping redirect, once: the engine host counts it into tab.blocked
   * (a request without a tab, such as the WebSocket backstop's, goes to diagnostics only), the SW batches it per
   * document into uv-blocked.
   */
  onBlock(req: RequestInfo, category: BlockCategory): void;
  onError(provider: ProviderName, where: string, err: unknown): void;
}

const OFF: BlockerStatus = { state: 'off', lists: 0, detail: null };

/** The tab's top-level page for this request (D3, C6): a tab's own document request is judged under itself. */
const topOf = (req: RequestInfo): string | null => (req.isTopLevelDocument ? req.url : req.topLevelUrl);

/**
 * A parameter-stripping redirect is kept only where safeVerdict keeps it (documents, http(s)) and only when it stays
 * on the request's origin, so a provider bug cannot become an open redirect inside the proxy; it is counted only then.
 */
function goodRedirect(req: RequestInfo, to: string): boolean {
  if (!req.isTopLevelDocument && req.destination !== 'document' && req.destination !== 'iframe') return false;
  try {
    const from = new URL(req.url);
    const dest = new URL(to);
    return (dest.protocol === 'http:' || dest.protocol === 'https:') && dest.origin === from.origin && dest.href !== from.href;
  } catch {
    return false;
  }
}

/** Policy cache key: the top-level page's host (site rules are host keys, ports included). */
function hostOf(url: string | null): string {
  if (url === null) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * The one EngineHooks object of a realm (the SW uses it as RequestHooks and never calls onDocument). Until the first
 * configure() everything is allowed (the SW configures SW_FALLBACK_SETTINGS at its start, §4.5). Verdicts: the first
 * `block` wins (in provider order); else the first `redirect` that goodRedirect() keeps; else `allow` with the header
 * changes of every provider merged (lower-case names, a later `set` replaces an earlier one, a `remove` beats any
 * `set` of the same name).
 */
export function composeHooks(opts: ComposeOptions): EngineHooks {
  let settings: BlockerSettings | null = null;
  const policies = new Map<string, SitePolicy>();
  const run = <T>(p: HookProvider, where: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      opts.onError(p.name, where, err);
      return fallback;
    }
  };
  const context = (url: string, top: string | null): RequestContext | null => {
    if (settings === null) return null;
    const key = hostOf(top);
    let policy = policies.get(key);
    if (!policy) {
      policy = sitePolicy(settings, top);
      if (policies.size >= 256) policies.clear();
      policies.set(key, policy);
    }
    return { settings, policy, thirdParty: isThirdParty(url, top) };
  };
  const network = opts.providers.find((p) => p.name === 'network');

  return {
    configure(s) {
      settings = s;
      policies.clear();
      for (const p of opts.providers) if (p.configure) run(p, 'configure', () => p.configure?.(s), undefined);
    },
    onRequest(req) {
      const ctx = context(req.url, topOf(req));
      if (ctx === null) return { action: 'allow' };
      let redirect: RequestVerdict | null = null;
      const set = new Map<string, string>();
      const remove = new Set<string>();
      for (const p of opts.providers) {
        if (!p.onRequest) continue;
        const v = run(p, 'onRequest', () => p.onRequest?.(req, ctx) ?? null, null);
        if (v === null) continue;
        if (v.action === 'block') {
          if (!BLOCK_CATEGORIES.includes(v.category)) {
            opts.onError(p.name, 'onRequest', new Error(`invalid category ${String(v.category)}`));
            continue;
          }
          opts.onBlock(req, v.category);
          return v;
        }
        if (v.action === 'redirect') {
          if (redirect === null && goodRedirect(req, v.url)) redirect = v;
          else if (redirect === null) opts.onError(p.name, 'onRequest', new Error('redirect refused'));
          continue;
        }
        for (const n of v.headers?.remove ?? []) remove.add(n.toLowerCase());
        for (const [n, value] of v.headers?.set ?? []) set.set(n.toLowerCase(), value);
      }
      if (redirect !== null) {
        opts.onBlock(req, 'urlparams');
        return redirect;
      }
      for (const n of remove) set.delete(n);
      return set.size || remove.size ? { action: 'allow', headers: { set: [...set], remove: [...remove] } } : { action: 'allow' };
    },
    onResponse(res: ResponseInfo, headers: ResponseHeaders) {
      const ctx = context(res.url, topOf(res));
      if (ctx === null) return;
      for (const p of opts.providers) if (p.onResponse) run(p, 'onResponse', () => p.onResponse?.(res, headers, ctx), undefined);
    },
    onWebSocket(req) {
      const ctx = context(req.url, topOf(req));
      if (ctx === null) return 'allow';
      for (const p of opts.providers) {
        if (!p.onWebSocket) continue;
        const c = run(p, 'onWebSocket', () => p.onWebSocket?.(req, ctx) ?? null, null);
        if (c !== null && BLOCK_CATEGORIES.includes(c)) {
          opts.onBlock(req, c);
          return 'block';
        }
      }
      return 'allow';
    },
    onDocument(win: ProxiedWindow, doc: DocumentInfo) {
      const ctx = context(doc.url, doc.topLevelUrl);
      if (ctx === null) return;
      for (const p of opts.providers) if (p.onDocument) run(p, 'onDocument', () => p.onDocument?.(win, doc, ctx), undefined);
    },
    status() {
      return network?.status ? run(network, 'status', () => network.status?.() ?? OFF, OFF) : OFF;
    },
  };
}
```

Tests (x1, `compose.test.ts`, `policy.test.ts`, `site.test.ts`): block beats redirect beats headers; a throwing
provider is reported and skipped; header merge order; an invalid category is reported and ignored; `onBlock` exactly
once per decision, and never for a refused redirect (another origin, a subresource, `javascript:`); nothing before
`configure`; **the tab's own document is judged under itself**: a request with `isTopLevelDocument` and a
`topLevelUrl` of another (allowlisted) site gets the destination's policy and `thirdParty: false`, and so does its
response (the OAuth shape: `site-a` → IdP → `site-a/callback` keeps every hop first-party); policy precedence table
(allowlist > per-site > global, wildcard vs exact keys, ports, IPs, the allowlist keeping GPC/cookie rules, frames
inheriting); `cookiesBlocked` truth table (unknown party blocked under `block-third-party`); `SW_FALLBACK_SETTINGS`
equals the privacy/extensions defaults of `settings/defaults.ts` minus lists and rules; `siteOf` keeps
`foo.github.io` apart from `bar.github.io`; the policy cache is cleared by `configure`.

### 3.3 Realm hygiene: step 2's page kit and x1's additions (`frontend/src/engine-host/realm.ts`, lane x1 day one)

The plan's first version specified its own helpers here (`pageNatives`, `pageFunction`, `pageError`). They are
withdrawn: step 2 shipped `src/engine-host/realm.ts` (its engine-host review; re-read 2026-11-18 for step 2's
integration, unchanged since), whose header states the three rules: (1) everything GNOME installs in a page realm is
a callable of that realm, a Proxy made by the page realm's own `Proxy` around a page-realm function with its handler
and `apply` trap compiled by the page realm's own `Function`, captured at document start (Scramjet `init.pre`, the UV
document-start hook, a child frame the guard reaches at its creation); GNOME's step sits only in the trap's closure,
and anything it throws, including a stack overflow at its first instruction, reaches the page as a page-realm
`RangeError`; (2) engine-host code never runs page code: it reads page objects only through the engine-host natives
of `natives.ts`, converts page values with `PageKit.str` and calls the original natives from the page-realm trap
(a trap's arguments array is made in the caller's realm, so an engine-host read of a page getter would hand a page
Proxy an engine-host array); (3) no engine-host observer or callback receives page nodes (Blink makes a node's
wrapper in the realm it is first reached through), hence `PageKit.observe`. A realm whose `Function` is not the
browser's own, or that forbids eval, gets no kit, and nothing but data properties holding primitives is installed
there. `pageKit` is used by `tabs.ts`, `popups.ts`, `webrtc.ts`, `find.ts` and `observe/commits.ts`; kits are cached
per document (a frame's WindowProxy survives a navigation to a new realm). The withdrawn helper leaked on its own
terms (the security review's probe: its `apply` trap was an engine-host function, so a page calling it at the stack
limit received an engine-host `RangeError`, and it captured natives lazily).

Step 2's API, which every step-3 lane uses (`realm.test.ts`: two `vm` contexts as two realms):

- `pageKit(win, N): PageKit | null` with `str(v)` (ToString in the page realm), `formEntries(form, submitter)`
  (`{entries, files}` serialized by the page realm's `FormData`, files by name), `error(message, name =
  'SecurityError')` (a page-realm `DOMException`), `highlight(name, ranges)` / `unhighlight(name)` (the page realm's
  highlight registry with a page-realm `Highlight`), `observe(root, cb, attributeFilter?)` (a page-realm
  `MutationObserver`, `childList` + `subtree`, plus attribute changes of the names in `attributeFilter` when given),
  `wrap(original, before, after)`, `replace(original, decide)` and `fn(decide)` (for accessors; "call the original"
  returns `undefined`);
- `wrapMethod(N, kit, proto, key, before, after)` and `wrapAccessor(N, kit, proto, key, {get?, set?})` (false when the
  property is missing, not a function or not configurable), `arg(args, i)`, `isNative(N, fn, name)` (whitespace-
  insensitive, so SpiderMonkey's multi-line native source passes), `nativePrototype(N, win, name)`;
- a `Decide` writes its verdict into the page-realm `box`: `box[0]` = `RETURN` (0, return `box[1]`, a primitive or a
  page-realm object), `THROW` (1, throw `box[1]`, a page value) or `CALL_ORIGINAL` (2).

Old names map as: `pageFunction(win, impl)` → `kit.fn(decide)` or `kit.replace(original, decide)`; wrappers of
natives → `wrapMethod`/`wrapAccessor`/`kit.wrap`; `pageError` → `kit.error`; `pageNatives` →
`isNative`/`nativePrototype` plus the engine-host natives of `natives.ts`.

**x1's additions on day one** (one change to `realm.ts` + `realm.test.ts`, before x2 and x3 add page-side code). In
`FACTORY_SOURCE`, after the existing captures (all captured when the kit is built, at document start):

```js
const CSSS = typeof CSSStyleSheet === "function" ? CSSStyleSheet : null;
const CSSreplace = CSSS && typeof CSSS.prototype.replaceSync === "function" ? CSSS.prototype.replaceSync : null;
const ADdesc = typeof Document === "function" ? Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets") : undefined;
const ADget = ADdesc && typeof ADdesc.get === "function" ? ADdesc.get : null;
const push = Array.prototype.push;
const G = globalThis;
```
and in the returned object (`observe` stays as step 2 shipped it: it already takes an attribute filter, which x2
passes as `['class', 'id', 'href']`):

```js
  run: function (source) {
    try { const f = G.Function(S(source)); apply(f, undefined, []); return true; } catch (e) { return false; }
  },
  sheet: function (css) {
    if (CSSS === null || CSSreplace === null) return null;
    const s = new CSSS();
    apply(CSSreplace, s, [S(css)]);
    return s;
  },
  setSheet: function (sheet, css) { if (CSSreplace === null) return false; apply(CSSreplace, sheet, [S(css)]); return true; },
  adopt: function (doc, sheet) { if (ADget === null) return false; apply(push, apply(ADget, doc, []), [sheet]); return true; },
  readString: function (obj, key) { try { const v = obj[S(key)]; return typeof v === "string" ? v : null; } catch (e) { return null; } },
```
`PageKit` gains (and `buildKit` forwards each, coercing results: `=== true`, `typeof … === 'object' && … !== null`,
`typeof … === 'string'`, never reading a property of what the page realm returned):

```ts
  /**
   * Compiles `source` with the realm's CURRENT Function (after the engine's client hooked the window: Scramjet's or
   * UV's wrapper, which rewrites the code like page code) and runs it; false when either throws. Scriptlets only (D11),
   * at document start, before page scripts.
   */
  run(source: string): boolean;
  /** A constructed CSSStyleSheet of the page realm holding `css` (only such a sheet can join that realm's documents); null without the API. */
  sheet(css: string): object | null;
  setSheet(sheet: object, css: string): boolean;
  /** Appends `sheet` to `doc.adoptedStyleSheets` with the captured getter and Array.prototype.push (an observable array: no page code runs). */
  adopt(doc: Document, sheet: object): boolean;
  /** `obj[key]` read by page-realm code: the string, else null (also when the read throws). */
  readString(obj: object, key: string): string | null;
```

**`withPageAssignments`** (`src/engine-host/popups.ts`, x1, for x2's scriptlet runner):
`withPageAssignments(win: Window, run: () => void): void` — while `run` executes, an assignment to `window.open` or
`window.close` of `win` (uBO's `prevent-window-open`/`nowoif` wraps `open` by assignment) is kept: the getter then
returns the assigned page-realm value, which calls GNOME's own function when it lets a popup through. Outside `run`,
assignments are discarded as today (UV's own wrapper must stay behind GNOME's).

Rules on top of R1 (§0): data properties hold primitives; every function GNOME installs comes from the kit; values
returned to pages come from kit code or the page document's own factories (`N.createElement.call(doc, …)` returns a
page-realm element, reached through the page document); page DOM is observed only with `kit.observe`, whose records
are read with engine-host natives only (x2 captures what it needs beyond `natives.ts`, such as the `NodeList`
`length`/`item` and `MutationRecord` `type`/`target`/`addedNodes`/`attributeName` getters, in its own
`src/extensions/cosmetic/natives.ts`, the same way `natives.ts` does). `natives.ts` itself stays x1's.

Unit tests (`realm.test.ts`, node, two `vm` contexts as two realms, as step 2's): every new function's results,
errors and Proxy-trap arguments belong to the page context; `run` uses the realm's current `Function` (a page whose
`Function` was replaced after the kit was built by a recording wrapper sees the source) and returns `false` on a
throw without the throw reaching the engine host; `readString` with a throwing or non-string getter returns `null`;
`adopt` and `observe` on a page whose `Array.prototype.push`, `Array.prototype[Symbol.iterator]` and
`NodeList.prototype` members were replaced by recording Proxies call none of them; the stack-exhaustion case of step
2's file repeated for each new function. Row A1 (§12.2) walks everything step 2 and step 3 install, in both engines
and browsers.

## 4. Lane x1: filter engine + network blocking

**Day one, in this order** (each unblocks other lanes): the contract changes C1–C12 (§3.1) with their tests and the
fixes of every implementer they break, then the full `npm run check && npm test`; the core of §3.2 (plus
`core/detail.ts`, C5b); the kit additions and `withPageAssignments` of §3.3, and the verification of step 2's R1
conversions (§4.7) with the first version of row A1; the pins of D18 in `package.json` (one `npm install
--save-exact`, lock committed, `npm ls @ghostery/adblocker-content tldts-experimental tldts-core` shows one version
each); the test-capability define (D19: `vite.config.ts` `gnomeDefines`, `vite-env.d.ts`, `sw/globals.d.ts`,
`engine-host/build-info.ts`). The fixture server and the test-list TOML are x5's (§8, §12.1). Then, before any
filter work, the step-2 items of §11.2 that step 2's integration left open (F2–F6), because x2 and x3 build on them.

### 4.1 What it builds

- `src/extensions/filters/lists.ts`: `fetchList(ref)` → `GET /api/filters/<id>?v=<sha256>` (same origin,
  `cache: 'default'`, so the immutable answer comes from the HTTP cache), a 64 MiB cap per list and 128 MiB per build,
  `503` + `Retry-After` honoured once, UTF-8 decode (fatal), SHA-256 compared with `ref.sha256` (D9); a failure is a
  `BlockerListError` code (C5). Runs in the Worker.
- `src/extensions/worker/build.ts` (pure, unit-tested in node with the real `@ghostery/adblocker`) and
  `builder.worker.ts` (the entry; it imports x2's `sanitizeList` and `trustOnlyScriptlets` and is added when they
  exist, day one of x2): the `ubo-resources` ref first (hash-checked like every list) → `requiresTrust =
  trustOnlyScriptlets(resourcesJson)`; lists → `sanitizeList(text, {trusted: ref.trusted, requiresTrust})` → per group
  the kept lines, plus the `shared` lines of every list (D1), plus, for the `params` group, the `params` lines of every
  list → `FiltersEngine.parse(text, ENGINE_CONFIG)` (D12) → `updateResources(resourcesJson, sha256)` → every cosmetic
  selector that reaches a stylesheet (plain hiding rules and the selectors of `:style()` rules) posted to the main
  thread for validation → `update({removedCosmeticFilters})` → `serialize()` → the bytes transferred to the main
  thread; the group's engine and text are dropped before the next group. Per-list `rules`/`dropped` and per-group
  counts go into the manifest.
- `src/extensions/filters/worker-client.ts`: spawns the Worker (`new Worker(new URL('../worker/builder.worker.ts',
  import.meta.url), {type: 'module', name: 'gnome-blocker-build'})`), validates every message from it, answers the
  selector batches with x2's `validateSelectors` (main thread, ≤ 8 ms slices, `CSSStyleSheet` of the engine-host
  realm, `hitsRoot` against a probe document of the engine-host realm, §5.2), terminates the Worker after `done`,
  `error`, a newer build or 120 s.
- `src/extensions/filters/cache.ts`: the cache of §4.3 (key, manifest, HMAC, verification, eviction), engine host
  only.
- `src/extensions/filters/engines.ts` (loaded by dynamic `import()` inside `createBlocker`, its own chunk): the engine
  set in force (deserialize per group in separate tasks, `updateEnv`, warm-up of 200 synthetic matches in idle
  callbacks), swap after a build (D7), `FilterEngines` (§4.2) for x2/x3. `cosmetics()` takes the styles from
  `getCosmeticsFilters({…, getInjectionRules: false, getExtendedRules: false})` and builds every scriptlet itself from
  `matchCosmeticFilters` with `scriptletCall` (§4.2), never from Ghostery's assembled strings; `domain` from
  `listDomainOf` (§3.2).
- `src/extensions/filters/scriptlets.ts` (pure, DOM-free): `scriptletCall` (§4.2).
- `src/extensions/filters/network.ts`: the `network` provider (both realms, DOM-free): request type from the
  destination (research §2.6 `DEST_TO_TYPE`; `isTopLevelDocument` → `main_frame`; `document`/`iframe`/`frame` →
  `sub_frame`; `onWebSocket` → `websocket`); `sourceUrl` = the URL itself for `main_frame`, else `documentUrl ??
  topLevelUrl`, and **`https://unknown.invalid/` when both are null** (Ghostery treats an empty source as first party,
  so `$third-party` rules would never match where the context is unknown; D15); groups in `MATCH_ORDER` that
  `ctx.policy.groups` allows; the first match is `{action: 'block', category: CATEGORY_OF[group]}`, with `resource`
  for a `$redirect` match of a subresource only (`redirect.contentType` split at `;base64`); `main_frame` and
  `sub_frame` are never answered with a resource. Allowlisted or not ready: `null`.
- `src/extensions/filters/status.ts`: `status.blocker` — `off` (no lists in the snapshot, or every group's toggle off
  everywhere), `building` (loading or building, nothing in force yet), `ready` (`lists` = compiled lists; `detail` a
  C5b code: `lists-failed`, `over-cache-limit`, `cache-rejected`), `failed` (nothing could be built; `detail`
  `failed:<reason>`; retried after 1 min, 5 min, 30 min and at the next snapshot with other lists). While a newer set
  builds, the state stays `ready`.
- `src/extensions/host/blocker.ts`: `createBlocker()` (§4.2), called by `core.ts` only when `blocker` is offered
  (D19): composes `network` + x3's `cookies`, `privacy` + x2's `cosmetic` (window factories) with `composeHooks`,
  registers them with `registerEngineHooks`, drives builds (Web Lock `gnome-blocker-build` taken `ifAvailable`; if
  held, the cache is polled every 2 s for 30 s, then it builds anyway), `stats()`, `reload()`, the SW messages
  (`gnome-blocker-config` at once after each `configure`, after every swap and on `sw-hello`; `gnome-blocker-engines`
  while this engine host has an Ultraviolet tab; `gnome-blocker-context`, §4.5).
- `src/extensions/host/providers.ts` / `src/extensions/sw/providers.ts`: the only files that import x2's and x3's
  factories; x1 adds each import the day that lane's module exists (WAVE-B §0: no import of a missing module).
- `src/extensions/sw/**`: `startSwBlocker()` (§4.5).
- Changes to step-2 files: §4.4–§4.7.

### 4.2 Interfaces it provides (exact)

```ts
// src/extensions/filters/scriptlets.ts — GNOME's scriptlet assembly (pure; unit-tested with the real library).
/** The argument tail of Ghostery 2.20.3's assembleScript() (resources.js); a unit test pins it against getScriptlet(). */
export const GHOSTERY_ARGS_TAIL =
  ")(...[`{{1}}`,`{{2}}`,`{{3}}`,`{{4}}`,`{{5}}`,`{{6}}`,`{{7}}`,`{{8}}`,`{{9}}`,`{{10}}`].filter((a,i) => a !== '{{'+(i+1)+'}}').map((a) => decodeURIComponent(a)))";

/**
 * One scriptlet call with its arguments as data: `template` is `engine.resources.getScriptlet(name)` and `args` the
 * filter's `parseScript().args`. Ghostery's own CosmeticFilter.getScript() pastes each argument into a template
 * literal with String.prototype.replace, so a backtick ends the literal and `$'`/`` $` ``/`$&` splice script text in
 * (WAVE-B3 §11.4); here the arguments become one JSON array (the same values after decodeURIComponent, as Ghostery
 * intends). null = refuse (a surrogate script with arguments, or a template this library version does not produce).
 */
export function scriptletCall(template: string, args: readonly string[]): string | null {
  if (template.endsWith(GHOSTERY_ARGS_TAIL)) {
    return `${template.slice(0, -GHOSTERY_ARGS_TAIL.length)})(...${JSON.stringify(args.slice(0, 10))}.map((a) => decodeURIComponent(a)))`;
  }
  return args.length === 0 ? template : null;
}

// src/extensions/filters/engines.ts — what x2 and x3 read from the compiled engines (engine-host realm).
import type { SitePolicy } from '../core/policy';

export interface CosmeticsResult {
  /** CSS to insert: hiding rules (`display: none !important`) and `:style()` rules; '' when none. */
  styles: string;
  /**
   * Scriptlet sources for PageKit.run, deduplicated, each built by scriptletCall() from a matched script-inject filter
   * of `matchCosmeticFilters` that has no exception (the same selection getCosmeticsFilters makes).
   */
  scripts: string[];
}

export interface FilterEngines {
  /** Some group engines are in force (built, or loaded from a verified cache). */
  ready(): boolean;
  /**
   * At document start: hostname-specific rules (plus the generic base stylesheet when `policy.genericHide`) of the groups
   * the policy allows; styles only when `policy.hide`, scriptlets per group toggle (D2). Empty when not ready.
   */
  cosmetics(url: string, policy: SitePolicy): CosmeticsResult;
  /** Generic rules for classes, ids and hrefs that appeared in a document (x2's monitor), when `policy.genericHide`. */
  cosmeticsForFeatures(url: string, policy: SitePolicy, features: { classes: readonly string[]; ids: readonly string[]; hrefs: readonly string[] }): string;
  /**
   * The params group's `$removeparam` result for a document URL (the `$removeparam` filters of every enabled list, D1);
   * null without a change, with the group off, or not ready.
   */
  rewriteParams(url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame'): string | null;
  /** The engines in force changed (a swap after a build, a reload). */
  onChange(listener: () => void): () => void;
}

// src/extensions/host/blocker.ts — the engine host's step-3 composition root (core.ts calls it at init when `blocker` is offered, D19).
import type { BlockCounter } from '../../shared/engine-hooks';
import type { BlockerStats, LogLevel } from '../../shared/engine-protocol';
import type { HostToSwMessage } from '../../shared/proxy-origin';
import type { Natives } from '../../engine-host/natives';
import type { PageKit } from '../../engine-host/realm';
import type { BlockerSettings } from '../core/policy';

export interface BlockerHostContext {
  readonly N: Natives;
  /** The kit built for a proxied window at its document start (pageKit's cache), or null: x2 and x3 get it through here. */
  kitOf(win: Window): PageKit | null;
  /** popups.ts withPageAssignments (§3.3), for x2's scriptlet runner. */
  withPageAssignments(win: Window, run: () => void): void;
  /** The core's per-tab counter (tab.blocked, src/engine-host/blocked.ts). */
  readonly counter: BlockCounter;
  postToSw(message: HostToSwMessage): void;
  /** Whether this engine host has a live Ultraviolet tab (it then keeps the SW supplied with engines). */
  hasUvTabs(): boolean;
  log(level: LogLevel, message: string): void;
  readonly browser: 'chromium' | 'gecko' | 'other';
}

export interface Blocker {
  readonly hooks: EngineHooks;
  /** Always present: `ready()` stays false until the engines module (dynamic import) has loaded and a set is in force. */
  readonly engines: FilterEngines;
  /**
   * `init`: the first settings and the app's key. Resolves when a verified cached set is in force, or after `waitMs`
   * (500 at init; never waits for a build: D7).
   */
  start(settings: BlockerSettings, blockerKey: string | null, waitMs: number): Promise<void>;
  stats(): Promise<BlockerStats>;
  /** blocker.reload: drops every cached set and rebuilds the current one; resolves when the build started. */
  reload(): Promise<void>;
  /** siteData.clear deleted Cache Storage: keep the set in force, write nothing more to the cache this session (§4.3). */
  onCacheCleared(): void;
  /** The SW (re)started: resend the config, the engines (with a UV tab) and the UV context (reset). */
  onSwHello(): void;
  /** The first UV tab of this engine host opened: send the engines in force to the SW. */
  onUvTab(): void;
}

export function createBlocker(ctx: BlockerHostContext): Blocker;

// src/engine-host/blocked.ts — per-tab counts → tab.blocked (the core's BlockCounter).
export class BlockedCounts implements BlockCounter {
  constructor(emit: (p: EventMap['tab.blocked']) => void, onTabless: (category: BlockCategory) => void);
  count(tabId: TabId | null, category: BlockCategory): void;   // null (backstop, no tab): onTabless (diagnostics) only
  reset(tabId: TabId): void;                                  // a new top document
  forget(tabId: TabId): void;                                 // tab closed
}

// src/extensions/sw/blocker.ts — the SW side (Ultraviolet).
export interface SwBlockerDeps {
  /** Client.postMessage to the registered engine-host clients only (uv-blocked batches; §4.5). */
  signal(msg: SwSignal): void;
  /** Proxied UV URL → real URL (`__uv$config.decodeUrl` after the prefix), null when it is not one. */
  decode(proxied: string): string | null;
  log(message: string): void;
}

export interface SwBlocker {
  readonly hooks: RequestHooks;
  /** gnome-blocker-config from registered engine-host client `clientId` (already validated). */
  onConfig(clientId: string, settings: BlockerSettings, setId: string | null): void;
  /** gnome-blocker-engines from a registered engine-host client: deserialized and put in force (the most recent such message wins; the previous set is dropped). */
  onEngines(clientId: string, msg: Extract<HostToSwMessage, { type: 'gnome-blocker-engines' }>): void;
  onContext(clientId: string, msg: Extract<HostToSwMessage, { type: 'gnome-blocker-context' }>): void;
  /**
   * A UV navigation fetch (mode navigate, destination document/iframe/frame) or worker script fetch: remember which
   * document its resulting client shows (a worker inherits the creator's context).
   */
  onClient(resultingClientId: string, proxiedUrl: string, creatorClientId: string | null, referrer: string | null): void;
  /** An engine-host client is gone (clients.get → undefined): drop its config, scoped maps and context. */
  forgetHost(clientId: string): void;
  /**
   * The page context of a UV request (D15), resolved after at most the waits of §4.5: ≤ 50 ms for an unknown client's
   * context, ≤ 20 ms for an unannounced link of a tab-top document, ≤ 150 ms for an announced navigation's config.
   * `referrer` is not part of it: sw.ts takes UV's computed `referer` header inside the `request` event.
   */
  context(event: FetchEvent, request: Request): Promise<Pick<RequestInfo, 'documentUrl' | 'topLevelUrl' | 'isTopLevelDocument'>>;
  /** Resolves when the user's settings arrived, or at the single deadline of this SW start (300 ms after it): never per request. */
  ready(): Promise<void>;
}

export function startSwBlocker(deps: SwBlockerDeps): SwBlocker;
```

### 4.3 The cache (Cache Storage on the proxy origin, engine host only)

- Cache `gnome-blocker-v1` (`BLOCKER_FORMAT` 1). Per engine set **K** two kinds of entries:
  `<proxy origin>/__gnome/blocker/<K>/manifest.json` and `<proxy origin>/__gnome/blocker/<K>/<group>.bin`
  (synthetic URLs the server never serves). Only the engine host reads and writes it; the SW gets its engines by
  message (§4.5).
- **K** = lower-case hex SHA-256 of the canonical JSON `["gnome-blocker", BLOCKER_FORMAT, ADBLOCKER_ENGINE_VERSION,
  SANITIZER_VERSION, ENGINE_CONFIG_ID, refs]`, `refs` = the snapshot's `lists` sorted by `id`, each
  `[id, sha256, category, format, trusted]`; `ENGINE_CONFIG_ID` names the D12 flags. The preprocessor environment is
  not part of K (it is applied with `updateEnv` after every load).
- Manifest: `{format, key, components, engineVersion, sanitizer, builtDay, buildMs, usedDay, groups: [{group, bytes,
  sha256, network, cosmetic, scriptlets}], lists: BlockerListStats[], resources: {redirects, scriptlets, sha256} |
  null, mac}`; `key` = K, `components` = the array K hashes; `builtDay`/`usedDay` = whole UTC days since the epoch
  (no millisecond timestamps: UV pages can read this cache, D6); `mac` = HMAC-SHA-256 with `blockerKey` over the
  canonical JSON of the manifest without `mac` (so `usedDay` is covered: rewriting it, at most daily, rewrites the
  MAC). `BlockerStats.builtAt` of a set loaded from the cache is the start of `builtDay`.
- Load: read the manifest once → `crypto.subtle.verify` of its MAC → `manifest.key === K`, `manifest.format ===
  BLOCKER_FORMAT` and `components` equal to the components of the K being loaded (a replayed older, validly MAC'd set
  under a newer K is refused) → per group: read the entry once into an `ArrayBuffer`, hash exactly that buffer
  against its `sha256`, deserialize exactly that buffer (`FiltersEngine.deserialize`: a version mismatch throws, a
  miss) → `updateEnv`. Anything else is a miss, the entries are deleted, the set is rebuilt and the status `detail` is
  `cache-rejected` once.
- Without a `blockerKey` (an older app) nothing is read or written.
- Size: entries count against `cacheLimitMB` (default 256 MiB; the default set measured 9.05 MB as three groups, ~9.5
  MB with `security` as its own group, §10); the current set plus the most recently used others (`usedDay`) are kept
  while the total fits; a set that alone exceeds the limit is not cached (status `detail` `over-cache-limit`; D7
  still holds within the session, and UV pages are still filtered because the SW gets the engines by message).
  `Cache.put` failing (quota) is handled like an over-limit set.
- **Clearing**: `siteData.clear` with `storage` or `cache` (also the start-up "clear site data on exit") deletes
  `gnome-blocker-v1` like every other cache (step 2's `site-data.ts` behaviour stays; its header comment is corrected:
  the engine host does keep its filter data there). The engine host then keeps the set in force and writes nothing to
  the cache for the rest of its life (`Blocker.onCacheCleared`), and the app replaces `blockerKey` (x4, §7.1), so
  the next start rebuilds once and the per-user MAC a page could read before is gone. A page that deletes the cache
  itself (UV pages reach it) only costs a rebuild at the next start; blocking fails open meanwhile (§10.3).

### 4.4 Engine host integration (Scramjet and the window side)

- `main.ts`: `startEngineHost({ createTransportManager, createSwClient, createBlocker })`; `EngineHostDeps` gains
  `createBlocker?: (ctx: BlockerHostContext) => Blocker` (absent in unit tests that do not need it: ALLOW_ALL).
- `core.ts`:
  - **Capabilities (D19)**: the offered set is `OFFERED_CAPABILITIES` plus, in e2e builds only (`ENGINE_TEST`), the
    `__GNOME_ENGINE_TEST_CAPABILITIES__` of the build, reported in `InitResult.capabilities` and in diagnostics;
    `test.offer` keeps widening the command gate only. `OFFERED_CAPABILITIES` gains `'blocker'` in the integration
    step, once the matrix of §12.4 passes.
  - At `init`, only when `blocker` is offered: `createBlocker()` → `registerEngineHooks(blocker.hooks)` → `configure`
    (as today) → `blocker.start(settings, p.blockerKey ?? null, 500)` in parallel with the engines' init. Without
    `blocker`, ALLOW_ALL stays and the snapshot's lists are ignored.
  - `blocker.stats` / `blocker.reload` handlers; `EngineDiagnostics.blocker` (C12); after `siteData.clear` with
    `storage` or `cache` (and the start-up clear), `blocker.onCacheCleared()`.
  - `#onSwSignal`: `sw-hello` → `blocker.onSwHello()`; `uv-blocked` → the tab of the UV document map (`tabs.ts`:
    proxied document URL as the frame had it at its document start → tab id, filled at every UV document start, LRU
    4,096) → `counter.count(tabId, category)` once per counted block; a URL not in the map is another GNOME tab's
    and is ignored.
- `hooks.ts`: `registerEngineHooks` keeps a stack; its unregister function restores the hooks that were current
  before, not ALLOW_ALL, so the e2e-only `test.hooks` and its `{}` form put the blocker back.
- `tabs.ts`, Scramjet requests (`#requestInfo`, `#sjRequest`, `#sjPreresponse`):
  - `topLevelUrl` (C6): for the tab's own request (`#isOwnRequest`, every hop) the request URL; for a request whose
    client is the document being loaded (its `documentUrl` equals `tab.pendingTop`, the URL of the tab's latest own
    request, set at every hop and cleared at the top document's commit, fail or stop) `tab.pendingTop`, so
    preload-scanner requests before the commit belong to the new page; otherwise `tab.nav.current?.url ?? null`.
  - `documentUrl`: `c.parsed.clientUrl` (decoded to the real URL) for subresources; for frame navigations the parent
    document, `c.request.rawReferrer` decoded (both field names [verify] in the npm build, O10); the URL itself for
    the tab's document; an `about:`, `blob:` or `data:` value, or none, gives the request's `topLevelUrl`.
    `referrer`: the `Referer` of `p.init.headers`.
  - **The first page of a site waits for its rules (D5)**: for an own request whose host this engine host has not
    announced and seen answered in this connection, `#sjRequest` emits `tab.loading {url}` (if the throttle allows,
    else it does not wait) and returns a promise that resolves at the next `settings` command or after 150 ms, then
    judges (`EngineDiagnostics.blocker.announceWaits`/`announceTimeouts`). **[unproven]** that Scramjet 2.0.67-alpha.2
    awaits a plugin tap's promise (the completeness review read `Tap.dispatch` → `Promise.all`, awaited by `fetch`):
    spiked together with D16; fallback: judge at once, and About says that the first page of a site reached by a link
    may be judged without its site rules.
  - Verdicts: a `resource` only for subresources → `earlyResponse = new Response(bytes, {status: 200, headers:
    {'content-type': contentType, 'cache-control': 'no-store'}})` (Scramjet then rewrites it like any script and
    `#sjResponse` adds the proxied-document CSP); a `resource` for a frame or the tab's document is treated as a plain
    block; other blocks keep the empty `403`, and the tab's document ends with `tab.nav.fail('blocked',
    'blocked:<category>')` (`detail` exactly `blocked:` + the BlockCategory, which the app maps to its own text).
  - Counting moves to the composite's `onBlock` (`BlockedCounts`); the CSP-violation listener ignores events whose
    `isTrusted` is false (F6) and counts through the same counter (`direct-connection`); `tab.blocked` becomes
    `{total: Σ, byCategory}`; `rawHeadersBag` gets `append`.
- `tabs.ts`, Ultraviolet documents:
  - **`onDocument` runs after UV's client (D11)**: at the UV document start, `tabs.ts` defines a kit-built `__uvHook`
    accessor on the window (getter: the stored value; setter: stores it and, the first time, calls
    `hooks.onDocument(win, doc)` for that document). UV's handler assigns `self.__uvHook = p` right after it hooked
    the window and before any page script, so cosmetics, scriptlets and x3's document overrides see UV's virtual
    `location`, cookie jar and storage. If the assignment never comes, `onDocument` is not called for that document
    (fail open, logged, counted as a hook error) **[unproven]** in both browsers (rows CS11, K3).
  - At the UV document start (before UV's client): the document map entry for `uv-blocked`, the `docs` context to the
    SW (§4.5), and, unless step 2's integration already did them, the UV hardening of §11.2 (F2 `frameElement`, F4
    cross-origin `pushState`/`replaceState`, F5 `cookieStore`), each with the kit.
  - Blocked UV tab navigations: the SW answers them with its blocked page (§4.5; `uv-blocked` only counts, C11); `#onFrameLoad` checks, before
    its "engine unavailable" check, for an HTML document no engine hook reached whose `<meta name="gnome-blocked">`
    (read with natives) names a BlockCategory → `tab.nav.fail('blocked', 'blocked:<category>')`. No `tab.committed`
    is sent for the blocked URL. A page cannot fake it: a document the site serves is rewritten by UV and attached.
- `popups.ts`: `withPageAssignments` (§3.3).
- The 307 `redirect` verdict for a Scramjet document (`earlyResponse` with the real `Location`): Scramjet's response
  header pass rewrites `location`, `content-location` and `referer` (read in `scramjet.js` 2.0.67-alpha.2), so the
  frame follows a proxied URL; **[unproven]** until the parameter-stripping rows of §12 pass in both browsers; if it
  does not hold, `tabs.ts` writes the proxied URL itself (as the SW already does for UV).
- `nav-machine.ts`, `observe/commits.ts`, `tabs.ts`: `tab.loading {loading: true, url}` (C3) at a GNOME-initiated
  load, at a Scramjet own request, and at a Navigation API `navigate` event (trusted only) a microtask after its
  dispatch, only when it was not cancelled (`defaultPrevented`); `url` fitted with `reportUrl`, at most 2 per tab per
  second (beyond: no `url`); `coalesce.ts` never holds an event that carries `url`. `fail('blocked', …)` reports
  `fallback: 'none'` (the other engine would block it too). A same-document commit whose real URL has another origin
  than the committed document is ignored and counted (F4: UV's history hook does not check the origin), so a page
  cannot move its tab's address, policy, rule exposure or SW context with `pushState`.
- `blocked.ts`: `BlockedCounts` resets with the tab's top document (where `tab.blocked = 0` is today) and is
  forgotten with the tab; a block without a tab goes to `EngineDiagnostics.blocker` only.

### 4.5 Ultraviolet (the service worker)

- **Composition** (`sw.ts`): `blocker = startSwBlocker({signal, decode, log})`, `registerSwHooks(blocker.hooks)`;
  `startSwBlocker` configures `SW_FALLBACK_SETTINGS` (§3.2) at once, so privacy headers and cookie modes apply from
  the first request after every SW start (D7).
- **Which clients are engine hosts** (replaces step 2's URL test for the step-3 messages; F3 asks step 2 to use it
  for its own messages too):
  - `hosts`: the `resultingClientId` of every navigation fetch (`mode: 'navigate'`) whose URL path is exactly
    `/engine/`; and, for clients that loaded before this SW controlled them or before it (re)started, a window client
    whose URL path is `/engine/` that sends `gnome-hello` or `gnome-blocker-config` and was never seen as below.
  - `proxied`: every `resultingClientId` of a `/uv/` or `/~/sj/` navigation or worker-script fetch, i.e. every client
    that is a proxied document or worker (LRU 8,192; not the `clientId` of an ordinary request, since the engine host
    itself fetches proxied URLs, e.g. for downloads); such an id is never an engine host, also when its URL later says
    `/engine/` (`history.pushState` from a page, F3).
  - `gnome-blocker-*` messages count only from `hosts`; step 3's signals (`uv-blocked`) go only to `hosts`.
  - Residual (row A3b decides; §11.1): after a SW restart a UV page that has made no request since can still pass as
    an engine host by URL, and a page that reaches a native realm (F2) can start a real `/engine/` document.
- **Messages**: `gnome-blocker-config` → `validateEngineSettings` → `blocker.onConfig(source.id, settings, setId)`;
  `gnome-blocker-engines` → `blocker.onEngines(source.id, msg)` (deserialized in the SW and put in force: the most
  recent such message wins, since only a host with UV tabs sends them; the previous set is dropped; `setId` in the
  configs tells the SW which set each host has in force); `gnome-blocker-context` → `blocker.onContext(source.id, msg)`.
- **Clients**: every UV navigation fetch (`mode: 'navigate'`, destination `document`/`iframe`/`frame`) and worker
  script fetch (destination `worker`; `sharedworker` scripts stay refused) → `blocker.onClient(event.resultingClientId,
  url, event.clientId || null, request.referrer || null)`.
- **Per request**: `await blocker.ready()` (one 300 ms deadline per SW start, not per request), then `await
  blocker.context(event, request)` (see *Context* below; kept by request in a `WeakMap`), then `uv.fetch()`.
  `requestInfo(ctx)` takes that context plus `referrer: ctx.headers.referer ?? null`; `headerView` gets `append`.
- **Verdicts**: a `block` with a `resource` for a subresource → `respondWith` a `200` with the body (`cache-control:
  no-store`), a script resource first through `ctx.ultraviolet.js.rewrite(text)` (`globals.d.ts` gains `js: {rewrite(code:
  string): string}` on the Ultraviolet instance; UV returns an intercepted request before its own rewriting) **[unproven]**;
  if the rewrite throws, a plain block. A blocked navigation (`document`/`iframe`/`frame`) → `blockedResponse(category,
  destination)` becomes an SW page (`swPage`, `SW_PAGE_CSP`) whose body is `<!doctype html><meta charset="utf-8"><meta
  name="gnome-blocked" content="<category>"><title>Blocked by GNOME</title>`, never a resource. `onBlock` → the
  requesting document's batch (its proxied URL from the client map; none → not counted) → `uv-blocked {documentUrl,
  counts}` at most every 250 ms per document (redirects count as `urlparams`).
- **Context (D15)**, kept per engine host and LRU-bounded (2,048 clients, 4,096 documents, 64 navs per host):
  - A client recorded by `onClient` gets: for a navigation whose URL is in a host's `navs` (consumed, forgotten after
    30 s, removed by `drop`), itself as the top-level page (a tab-top document); for another navigation, the
    top-level page of the recorded document its referrer names (a lookup only: a referrer never creates a context),
    else none until a `docs` entry for its proxied URL arrives; for a worker, its creator's context.
  - `docs` entries (`[proxied document URL, real top-level URL]`) set or correct the top-level page of the clients
    showing that document.
  - `context()`: `documentUrl` = the client's document's real URL (http(s) only, else its top-level page);
    `topLevelUrl` = that document's top-level page, and for an announced navigation the request URL itself (C6);
    `isTopLevelDocument` = the request URL is in `navs` (UV's computed `referer` header becomes `referrer`, which x3's
    floor reduces). A client with no context yet: wait up to 50 ms for its context, then `topLevelUrl: null,
    documentUrl: null` (the network provider's third-party sentinel, the global settings without site rules,
    cookies as third-party: D4, D15). A UV navigation not in `navs` whose referrer is a recorded tab-top document:
    wait up to 20 ms for a `navs` entry (a link in the tab-top races its announcement; rows V2/V4 measure it). An
    announced navigation: wait up to 150 ms for a config from that host sent after its `navs` entry (D5: it carries
    the destination's rules).
- **Several engine hosts** (one per GNOME tab) share the SW: it keeps the last config of each and applies the newest
  one's settings with the union of their `allowlist`/`perSite` entries (each host sends only its scoped sites, D5);
  a client that is gone (`clients.get` → undefined, checked when the next config arrives) is forgotten
  (`forgetHost`).
- **The SW persists nothing** (it would put the scoped site maps where proxied pages may read them): after a restart
  (Firefox stops idle workers after ~30 s) it applies `SW_FALLBACK_SETTINGS` and waits for the engine hosts' answer to
  its `sw-hello` (config, engines from a host with a UV tab, context with `reset`); list-based decisions fail open
  until engines arrive.
- **What the engine host sends** (`host/blocker.ts`): `gnome-blocker-config` at once after every `settings` command
  (also the answers to announcements), every swap and on `sw-hello`, and after every `navs` message as soon as the
  app's answer for that navigation is in (at once for GNOME-initiated loads, whose snapshot came before the load
  command), so the SW's 150 ms wait normally ends after one round trip; `gnome-blocker-engines` (a structured-clone copy of
  the serialized groups in force, ~9–12 MB) while it has a UV tab: after each swap, when its first UV tab opens and on
  `sw-hello`; `gnome-blocker-context`: `docs` from the UV document start (`tabs.ts`, not the provider's
  `onDocument`, which now runs later), `navs` for UV tab-top navigations (GNOME-initiated loads before
  `location.replace`; page-started ones synchronously in the `navigate` listener, so the message beats the fetch,
  with `drop` a microtask later when the event was cancelled, or when its `signal` aborts), and everything again on
  `sw-hello` (`reset: true` first, then chunks within `BLOCKER_CONTEXT_LIMITS`).

### 4.6 WebSockets, the cache's neighbours, and the backstop

- **Scramjet (D16)**: spike first (half a day, together with the async-tap question of §4.4): find the per-window
  WebSocket creation in Scramjet 2.0.67-alpha.2's client (research §1.1: `client.bare.createWebSocket`,
  `core/src/client/shared/requests/websocket.ts`), reachable at `init.post` through the window's `SCRAMJET_CLIENT`
  (read with `N.getOwnPropertyDescriptor`, before page code ran); wrap it there with `kit.replace` (on the prototype
  the client calls, so deleting an own property does not unwrap it) with a `RequestInfo` that has the tab,
  `documentUrl`, `topLevelUrl` and `destination: 'websocket'`. Marks for the transport manager's `useHooks()`
  backstop, kept per URL for 5 s: a socket the wrapper **allowed** leaves one one-shot mark, which the first matching
  connect consumes (it is then skipped); a socket the wrapper **blocked** leaves a block mark, and the backstop blocks
  that URL while it lasts (a page that reopens it past the wrapper, e.g. through the client it can reach (F2), stays
  blocked). Everything else the backstop judges without context (the network provider's third-party sentinel: only
  rules without `$domain` can match) and counts in `EngineDiagnostics.blocker` (`wsBackstopBlocked`,
  `wsBackstopSkipped`). If the spike finds no such point, only the backstop runs and About lists "WebSocket blocking
  in Scramjet pages ignores per-site settings".
- **Ultraviolet**: step 2's `Ultraviolet.BareClient.prototype.createWebSocket` wrapper (already kit-built) gets
  `documentUrl` (the document's real URL) and `referrer` (null); its blocked error stays `kit.error('Blocked by GNOME',
  'SecurityError')`.
- `transport/manager.ts`: `#checkWebSocket` fills the new `RequestInfo` fields (`documentUrl: null`, `referrer:
  null`) and applies the marks above.
- `site-data.ts`: unchanged behaviour (`siteData.clear` with `storage` or `cache` deletes every Cache Storage cache,
  `gnome-blocker-v1` included, §4.3); its header comment is corrected and the core calls `blocker.onCacheCleared()`.

### 4.7 Realm hygiene in step 2's code (rule R1, finding F1 of §11.2)

Step 2's engine-host review converted the sites finding F1 named (read 2026-11-12 12:12): `popups.ts`
(`window.open`/`close` accessors through `keep()` with `kit.fn`/`kit.replace`, the form `submit` wrapper, form data
through `PageKit.formEntries`), `webrtc.ts` (the child-frame guard's `contentWindow`/`contentDocument` getters and
insertion-method wrappers through `wrapAccessor`/`wrapMethod`), `tabs.ts` (the UV `createWebSocket` wrapper, the
`Ultraviolet` accessor and its error through the kit; `#documentUrl` reading natives only), `observe/commits.ts` (the
`History.prototype.pushState`/`replaceState` wrappers where the Navigation API is missing) and `find.ts` (highlights
in the page realm's registry). x1 does not convert anything again: it **verifies**. Its first e2e row,
`r1-realm-walk` (§12.2, row A1), has an ordinary page in each engine and browser walk every own property GNOME
changed on its `window`, `document`, `navigator` and the prototypes of `Window`, `Document`, `Node`, `Element`,
`HTMLIFrameElement`, `HTMLFormElement`, `HTMLFrameElement`, `HTMLObjectElement`, `History`, `Attr`, `NamedNodeMap`,
`Range`, `ShadowRoot`, `DocumentFragment`, `Ultraviolet.BareClient` (and, from step 3, `Document.prototype.cookie` and
`referrer`, `window.__uvHook`, the Scramjet client's WebSocket method) and check that no value, getter, setter, thrown
error, Proxy-trap argument or return value has a `constructor` other than its own realm's, calling each one once
normally and once at the stack limit (a recursion sweep of depths around the overflow point). Anything it finds is
fixed by x1 before x2 and x3 add page-side code. Step 2 already has the first version of this row:
`tests/e2e/engine/suites/host-attack.mjs` `realm-walk` (an ordinary page finds no engine-host function among the
values, getters and setters of its window, document, navigator, history and the prototypes GNOME wraps, in what the
wrapped methods pass to `Function.prototype.apply`/`call`, or in the errors they throw: 0 of about 2,430–2,810
checked, both engines and browsers) and `page-getters` (rule 2: page-made forwarding Proxies on the getters
engine-host code could read receive no engine-host arguments array: 0, both engines and browsers); x1 extends
`realm-walk` to step 3's additions and adds the stack sweep. The other step-2 findings of §11.2 (F2–F6) are x1's
first tasks: step 2's integration left them open (§11.2 says what the code does on 2026-11-18).

### 4.8 Settings it reads

`EngineSettings.extensions.lists` (which lists, by hash), `enabled`, `allowlist`, `perSite` (through `SitePolicy`),
`cacheLimitMB`; `InitPayload.blockerKey`. It changes no settings key.

### 4.9 Tests

- Unit (vitest, node): `compose`/`policy`/`site`/`categories`/`detail` (§3.2, C5b); `build.ts` with the real library
  on small fixture lists (groups, shared exception lines reach every group, `$badfilter` across lists, a
  `$redirect-rule` in a list of another group answering a block of the trackers group with its stub, a `$removeparam`
  of an `ads`-group list applied through `rewriteParams`, `$important`, a `$redirect` resource answer, `main_frame` and
  `sub_frame` never a resource, preprocessor `!#if env_firefox` and an `@@` line under `!#else`, the `updateEnv` after
  deserialize); **`scriptletCall` and `cosmetics()`** with the real library and the pinned `ubo-resources.json`:
  `GHOSTERY_ARGS_TAIL` matches what `getScriptlet` returns for every scriptlet of the file, and every script
  `cosmetics()` returns, evaluated whole in a `vm` context with the stubs the scriptlets read, leaves a `PWNED` marker
  at 0 for the vectors of §11.4 (a tagged-template backtick, `$'`, `` $` ``, `$&`, an escaped backtick inside a
  backtick-quoted argument, `\` before a backtick, `\,` and `%2C` commas) from a **trusted** list too, while
  `set-constant` with a regex argument (`/^a$/`) still receives that exact string; `lists.ts` against a fake `fetch`
  (hash mismatch, 503 + Retry-After, too large, invalid UTF-8, each with its `BlockerListError`); `cache.ts` against an
  in-memory `CacheStorage` (key stability, MAC refusal, a flipped byte, a valid older manifest replayed under a newer K
  refused, `usedDay` tampering refused, an `ENGINE_VERSION` mismatch, eviction order within the limit, a set larger
  than the limit, nothing written after `onCacheCleared`); the network provider's type mapping table (every
  destination, Scramjet top document as `iframe`), its source URL rules (the sentinel for unknown context);
  `BlockedCounts` (reset, totals, coalescing order with `direct-connection`, tabless blocks to diagnostics); the SW:
  engine-host registration (navigation to `/engine/`, provisional ids, a `proxied` id refused even with an
  `/engine/` URL), the client map, referrer lookups that never create a context, workers inheriting, `navs`
  consumption, `drop` and expiry, the waits, the multi-host union, `ready()` with one deadline per start (fake
  timers), the most recent engines message in force, `uv-blocked` batching; the kit additions (§3.3).
- E2E (`blocker-network`, `blocker-uv`, `blocker-cache`, `blocker-attack`, `blocker-sites`; §12).
- `build.mjs`: the import rules of §2 for the engine-host entry, its Worker chunk, the app and `dist/sw.js` (no DOM
  lib in the SW, no `@ghostery/adblocker` in the app graph, Ghostery only in the dynamically imported blocker chunk of
  the engine host), and the size budgets of §10.2.

**Fakes to work alone**: x2's `sanitizeList` replaced by a pass-through in `build.ts` tests, `trustOnlyScriptlets` by
the set read from the pinned resources file, `validateSelectors` by "nothing invalid"; x3's providers absent (the
composite runs with `network` only); an in-memory `CacheStorage`; `FakeSwClient.post` recording messages; the e2e
fixture server and the test lists of §12.1 (x5). The real gnome-server can serve the test lists only through x5's
`file` entries (its fetcher refuses loopback URLs, so a local mirror does not work), so x1's list-dependent e2e rows
start when x5 lands (x5 is a day-one task); the rows that need no list (privacy headers, fail-open, the R1 walk, A0)
run before.

## 5. Lane x2: cosmetic filtering + scriptlets

**Day one**: `src/extensions/core/sanitize.ts` (with `trustOnlyScriptlets`) and `selectors.ts` (pure, unit-tested;
x1's Worker and build need them), then the provider.

### 5.1 What it builds

- **`core/sanitize.ts`** — the list sanitizer x1's Worker runs on every list before parsing (research §6.1.1, plus
  GNOME's own safety rules). `SANITIZER_VERSION = 1` (nothing has shipped; bumped with any later rule change: it is
  part of the cache key). Line by line:
  1. `! …` comments and `[Adblock Plus …]` headers are dropped. Preprocessor lines `!#if`, `!#else`, `!#endif` stay in
     `text` (`loadPreprocessors: true`) and are tracked as Ghostery does (`lists.js`): `!#if X` pushes `X` with its
     whitespace removed, `!#else` replaces the top `c` with `!(c)`, `!#endif` pops; at the end of the list every
     still-open `!#if` is closed with `!#endif`, so it cannot reach into the next list of the same group text.
     `!#include` is dropped and counted (the server's uBO CDN copies are flattened).
  2. **Trust** (lists without `trusted`): a scriptlet line `…##+js(…)` is dropped when its name is in
     `opts.requiresTrust` or starts with `trusted-`. The name is taken the way Ghostery's `parseScript` and
     `getRawScriptlet` take it: the text after `+js(` up to the first `,` (or the final `)` when there is none),
     trimmed with `String.prototype.trim`, `.js` appended when missing (every name that can resolve to a scriptlet
     consists of `[a-z0-9.-]`, so the first comma is Ghostery's split point too). `#@#+js(…)` exceptions stay.
  3. **Arguments** (lists without `trusted`): a `##+js(…)` line whose text after the name contains a backtick or a
     `$` is dropped and counted. In the default untrusted lists that is 1 line (easyprivacy:
     `visible.com##+js(set-local-storage-item, browser-ids, $remove$)`), with the opt-in fanboy-cookiemonster 1 more.
     GNOME's own assembly (§4.2 `scriptletCall`) already makes arguments data; this rule keeps a mistake there (or a
     call of Ghostery's own `getCosmeticsFilters().scripts`) from turning an untrusted list into code.
  4. ABP CSS `domain##selector {style}` → `domain##selector:style(style)`; `{remove: true}` → plain hiding (procedural
     `:remove()` is off in v1).
  5. `:style(…)` is kept only when its declarations are safe (`isSafeStyle`, which compares the ASCII-lowercased
     text, because CSS is ASCII case-insensitive): no `url(`, `image(`, `image-set(`, `cross-fade(`, `element(`,
     `paint(`, `expression(`, `-moz-binding`, `behavior`, `@`, `\` (no escapes at all), `/*`, `<`, `{`, `}`,
     `javascript:`, at most 1,024 characters: no list can make a proxied page load anything or run code through CSS.
  6. Dropped (counted): `#?#`/`#@?#` (procedural, off in v1), `##^…` (HTML filtering off), `#$#`/`#@$#` (ABP
     snippets), `#%#`/`#@%#` (AdGuard JavaScript rules: raw code injection, never), network filters with `$replace=`
     or `$content` (HTML filtering off), `$csp=` (D12); lines over 8 KiB. (The `html`/`body`/`::highlight(` checks
     moved to `validateSelectors`, which sees the selector as the browser parsed it.)
  7. **Shared lines** (D1): network exceptions `@@…`, cosmetic exceptions `#@#…`, filters with `$badfilter`, and
     non-exception filters with `$redirect-rule` go to `shared`, each wrapped in `!#if <c>` … `!#endif` where `<c>` is
     the open condition stack joined as Ghostery's `joinConditions` does (one condition as it is, several as
     `(a)&&(b)`), and are removed from `text`.
  8. **Params lines** (D1, D13): non-exception filters with `$removeparam` go to `params`, wrapped the same way, and
     are removed from `text`; x1 appends every list's `params` to the `params` group.
- **`trustOnlyScriptlets(resources)`** (same file): from the verified `ubo-resources` JSON, the `name` and every
  alias of each scriptlet with `requiresTrust: true`, each with and without `.js` (2026-11-11: 34 scriptlets,
  including `prevent-clipboard-write.js` without the prefix and `trusted-replace-node-text.js` with the aliases
  `trusted-rpnt.js`, `replace-node-text.js`, `rpnt.js`). A malformed file gives the empty set, and then the Worker
  drops every scriptlet line of an untrusted list (fail closed for code, not for blocking).
- **`core/selectors.ts`** — `validateSelectors(pairs, opts)`: `insertRule(selector + '{}')` into a sheet of the
  provided `CSSStyleSheet` constructor (the engine-host realm's; never attached to a document), then reads the rule's
  `selectorText` (escapes resolved, case folded by the browser) and `deleteRule`s it; returns the ids to drop: those
  that throw, those whose `selectorText` contains `::highlight(` (find-in-page highlights are GNOME UI inside proxied
  pages), and those for which `opts.hitsRoot(selectorText)` is true (x1 matches it against the `html` and `body`
  elements of a probe document of the engine-host realm: `html`, `body`, `:root`, `*`, `body:not(.x)`). Slices of at
  most `opts.sliceMs` (8) with `opts.yield()` between them, so the app's main thread never sees a long task from it.
  x1 sends it every selector that reaches a stylesheet, the selectors of `:style()` rules included.
- **`cosmetic/provider.ts`** — `createCosmeticProvider(deps)` (name `cosmetic`), only `onDocument`, for every proxied
  document at any depth that the core attaches (Scramjet `init.post`; Ultraviolet right after UV's client, §4.4), with
  the tab's policy (`ctx.policy`), the document's own URL and `kit = deps.kitOf(win)`; no kit → nothing (R1):
  - nothing when `!engines.ready()`; such documents (weakly held, at most 256) get their styles when the engines
    become ready (`engines.onChange`), not their scriptlets (too late to matter, and order-dependent);
  - `engines.cosmetics(doc.url, policy)` → `styles` into one constructed stylesheet of the **page realm**:
    `kit.sheet(styles)` then `kit.adopt(doc, sheet)` (a sheet constructed in the engine-host realm cannot join another
    realm's document, and every frame needs its own); later changes with `kit.setSheet`. Fallback where either returns
    `false`/`null`: a `<style>` element created by the page document (`N.createElement.call(doc, 'style')`, reached
    through the page document, so a page-realm element), text set and appended with natives. The late-styles path
    uses the same kit calls, whose natives were captured at document start, so it runs no page code;
  - when `policy.genericHide`: **GNOME's own generic-rule monitor**, not `@ghostery/adblocker-content`'s `DOMMonitor`
    (it reads page objects with ordinary property access, spreads page `NodeList`s, iterates `classList` and runs an
    engine-host `MutationObserver`: R1 rules 2 and 3). `kit.observe(doc, cb, true)` reports added nodes and `class`,
    `id`, `href` changes; `cb` reads each record and the elements below added nodes only with engine-host natives
    (`MutationRecord` getters, `NodeList` `length`/`item`, `Element.prototype.querySelectorAll` and `getAttribute`,
    captured in `cosmetic/natives.ts`), splits `class` on ASCII whitespace, keeps at most 4,096 distinct features per
    document, each at most 256 characters; batches at most one per 100 ms → `engines.cosmeticsForFeatures(…)` → a
    second page-realm sheet; at most 512 KiB of CSS per document; the monitor stops at the document's trusted
    `pagehide`;
  - scriptlets: at `onDocument` only, `deps.withPageAssignments(win, () => { for (const s of scripts) kit.run(s) })`
    (a `false` result is logged, message only). Never a `<script>` element, never the engine-host realm, never
    Ghostery's own assembled strings; `executionWorld: 'ISOLATED'` scriptlets run in the main world like uBO's MV2
    build, there is no other.
- No other DOM changes: GNOME injects nothing into the engine-host document, only into windows the core hands to
  `onDocument` (documents placed in a tab's frame tree).

### 5.2 Interfaces it provides (exact)

```ts
// src/extensions/core/sanitize.ts (DOM-free; runs in x1's Worker)
export const SANITIZER_VERSION = 1;
export interface SanitizeOptions {
  /** The list may use scriptlets that need trust (FilterListRef.trusted). */
  trusted: boolean;
  /** trustOnlyScriptlets() of the verified ubo-resources ref. */
  requiresTrust: ReadonlySet<string>;
}
export interface SanitizeResult {
  /** The list without its shared and params lines, every !#if closed, ready for FiltersEngine.parse. */
  text: string;
  /** Lines every group engine gets (exceptions, cosmetic exceptions, $badfilter, $redirect-rule), wrapped in their !#if conditions. */
  shared: string[];
  /** Non-exception $removeparam filters, wrapped the same way: the params group gets them (D1). */
  params: string[];
  /** Filter lines kept (text + shared + params) and dropped by the rules above. */
  rules: number;
  dropped: number;
}
export function sanitizeList(text: string, opts: SanitizeOptions): SanitizeResult;
export function trustOnlyScriptlets(resources: unknown): ReadonlySet<string>;
export function isSafeStyle(declarations: string): boolean;

// src/extensions/core/selectors.ts (window side; the constructor is passed in, so the file compiles without the DOM lib)
export interface SelectorCheckOptions {
  CSSStyleSheet: new () => {
    insertRule(rule: string, index?: number): number;
    deleteRule(index: number): void;
    readonly cssRules: { item(index: number): { readonly selectorText?: string } | null };
  };
  /** Whether a selector (as the sheet serialized it) matches the html or body element of a probe document. */
  hitsRoot(selectorText: string): boolean;
  /** Longest synchronous slice (8). */
  sliceMs: number;
  now(): number;
  /** Gives the main thread back between slices (scheduler.yield where available, else setTimeout 0). */
  yield(): Promise<void>;
}
export function validateSelectors(pairs: ReadonlyArray<readonly [id: number, selector: string]>, opts: SelectorCheckOptions): Promise<number[]>;

// src/extensions/cosmetic/provider.ts (window side)
import type { Natives } from '../../engine-host/natives';
import type { PageKit } from '../../engine-host/realm';
import type { HookProvider } from '../core/compose';
import type { FilterEngines } from '../filters/engines';
export function createCosmeticProvider(deps: {
  N: Natives;
  engines: FilterEngines;
  kitOf(win: Window): PageKit | null;
  withPageAssignments(win: Window, run: () => void): void;
  log(level: 'warn' | 'error', message: string): void;
}): HookProvider;
```

### 5.3 Settings it reads

`extensions.enabled.cosmetic`, `cosmeticAggressive`, `perSite[*].cosmetic` and the group toggles (all through
`SitePolicy`: `hide`, `genericHide`, `groups`).

### 5.4 Tests

- Unit: every sanitizer rule (with the lines of research §2.8/§2.10 that broke CSS chunks); `!#if` wrapping of
  shared and params lines, also under `!#else`, nested, and an unterminated `!#if` closed at the end of the list;
  **trust**: every name and alias of every `requiresTrust` scriptlet of the pinned `ubo-resources.json`, with and
  without `.js` and with spaces around it, is dropped from an untrusted list and kept in a trusted one;
  `trusted-prevent-xhr` (prefix, no flag) is dropped; an exception `#@#+js(rpnt)` stays; **arguments**: backtick and
  `$` lines dropped only from untrusted lists; counts; idempotence (`sanitize(sanitize(x)) === sanitize(x)`); speed
  (EasyList in < 150 ms on this machine: measured 57–80 ms for all 9 default lists before the review's rules);
  `isSafeStyle` table (escapes such as `\75 rl(`, `URL(`, `Image-Set(`); `validateSelectors` with a fake sheet and a
  fake clock (slicing, ids, `::HIGHLIGHT(`, `::h\69ghlight(`, `*`, `:root`, `body:not(.x)` dropped; `body > *` kept,
  as §11.5 says); the provider against a fake `FilterEngines`, a fake kit and a fake window whose prototypes, arrays
  and node lists are recording Proxies: the test fails if the provider runs any page member (R1 rule 2), touches
  anything but natives and the kit, or runs scriptlets outside `kit.run` inside `withPageAssignments`; nothing when
  not ready; the late-styles path; the 512 KiB and feature caps.
- The scriptlet-assembly regression (vectors of §11.4) is x1's (`scriptletCall`, §4.9); x2's rows CS11–CS15 repeat
  it in the browsers.
- E2E `blocker-cosmetic.mjs` (§12.2 rows CS1–CS18), both engines × both browsers.

**Fakes**: `FilterEngines` returning canned styles and scripts per hostname, a fake `PageKit` over a `vm` context.
x2's e2e rows run once x1 has wired the provider into `host/providers.ts` (§13 step 5); until then x2 works with unit
tests (no e2e-only `test.cosmetic` command: x1 could implement it only by importing x2's module, which WAVE-B §0
forbids before it exists, and then it gives nothing earlier than the wiring).

## 6. Lane x3: privacy protection + cookie manager

### 6.1 What it builds

- **`privacy/params.ts`**: the built-in table of research §7.1 (`utm_*` by prefix; `fbclid`, `gclid`, `dclid`,
  `gbraid`, `wbraid`, `msclkid`, `yclid`, `twclid`, `ttclid`, `igshid`, `igsh`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`,
  `__hssc`, `__hstc`, `__hsfp`, `hsCtaTracking`, `mkt_tok`, `oly_anon_id`, `oly_enc_id`, `rb_clickid`, `s_cid`,
  `vero_conv`, `vero_id`, `wickedid`, `_openstat`, `srsltid` exactly), with the ClearURLs attribution (LGPL-3.0
  data); `stripBuiltinParams(url)` keeps the order of the other parameters and the fragment, returns null when nothing
  changed.
- **`privacy/provider.ts`** (DOM-free; the engine host and the SW use the same module):
  `createPrivacyProvider({rewriteParams})` (name `privacy`; `rewriteParams` is x1's `FilterEngines.rewriteParams` of
  that realm), `onRequest`:
  - tracking parameters (D13): only documents (`isTopLevelDocument`, or destination `document`/`iframe`/`frame`), only
    GET/HEAD, only with `policy.stripParams`: `cleaned = rewriteParams(url, documentUrl, type) ?? url`, then
    `stripBuiltinParams(cleaned) ?? cleaned`; if it differs and keeps the request's origin, `{action: 'redirect', url:
    cleaned}` (the composite checks the origin again before counting). Loop guard: never for a URL this provider
    produced in the last 10 s, and at most 3 redirects in 10 s per tab (in the SW, where `tabId` is null: per
    requesting document);
  - `Sec-GPC: 1` with `policy.gpc`, `DNT: 1` with `policy.dnt`, on every request;
  - **`Referer` only ever reduced, with a floor in every mode** (also with privacy protection off): from
    `req.referrer` and the real URLs, at most what a browser's default `strict-origin-when-cross-origin` sends: the
    full URL to the same origin, the origin + `/` to another origin, nothing from https to http. Ultraviolet forwards
    the full real URL as `Referer` for every proxied request (all of them are same-origin to the browser, so it never
    trims), which this floor corrects; Scramjet already follows the page's policy. Modes on top: `default` = the
    floor; `origin-cross-site` = the floor (cross-origin is already cut to the origin) — the Settings text says "Only
    the site name to other sites"; `none` removes it. Never added, never widened.
- **`privacy/document.ts`** (window): `withPrivacyDocument(provider, deps)` adds `onDocument` (which runs after the
  engine's client hooked the window, §4.4): `navigator.globalPrivacyControl = true` (`policy.gpc`) and
  `navigator.doNotTrack = '1'` (`policy.dnt`) as non-writable, configurable data properties of the document's
  `navigator` (read with `N`; configurable, so nothing collides with an engine's own hooks, and a page that deletes
  them only drops its own signal), primitives only (R1); `document.referrer` reduced like the header: the value the
  engine reports is read once at `onDocument` with `kit.readString(doc, 'referrer')`, reduced (floor and mode against
  the document's own URL), and kept per document (`WeakMap`); the realm's `Document.prototype.referrer` getter is
  wrapped once per realm with `kit.replace` (decide: `RETURN` the reduced string for a document in the map, else
  `CALL_ORIGINAL`), so the value holds also when a page calls the getter through `Object.getOwnPropertyDescriptor`,
  from another realm, or on another document. Workers, `about:blank` children and non-HTML documents get the
  `Sec-GPC` header but no `navigator.globalPrivacyControl` (no hook runs there): About says so.
- **`cookies/provider.ts`** (DOM-free, both realms): `createCookieProvider()` (name `cookies`), from
  `cookieRuleFor(ctx.settings, url)` and `cookiesBlocked(ctx.policy, rule, ctx.thirdParty)` (D4; an unknown party
  counts as third-party): `onRequest` removes `cookie` when blocked; `onResponse` deletes every `set-cookie` when
  blocked, and with a `session` rule rewrites each one with `sessionizeSetCookie` (removes `Expires=` and `Max-Age=`;
  `append` per line) — except a line that deletes its cookie (`Max-Age` ≤ 0, or `Expires` in the past), which stays
  as it is, so a site's sign-out still ends the session. Both run before the engines touch their jars (Scramjet:
  `fetch.request` after its header computation and `fetch.preresponse` before `handleCookies`; UV: `request` after
  `cookie` was set, `beforemod` before the store; research §1).
- **`cookies/document.ts`** (window): `withCookieDocument(provider, deps)` adds `onDocument`: whether the document's
  own cookies are blocked (its URL against `cookieRuleFor`, `cookiesBlocked` with `isThirdParty(doc.url,
  doc.topLevelUrl)`) is kept per document (`WeakMap`), and the realm's `Document.prototype.cookie` accessor (the
  engine's own hook by then: Scramjet's, or UV's after its client) is wrapped once per realm with `kit.replace` for
  `get` and `set`, deciding by the document it is called on: blocked → `RETURN ''` / `RETURN undefined` (the write
  is ignored), else `CALL_ORIGINAL`; a document GNOME never attached → `CALL_ORIGINAL` (fail open). Because every
  attached realm's prototype is wrapped and the decision follows `this`, a tracker in a blocked frame gets nothing
  through `Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')` either, in its own realm or another's
  **[unproven]** in both engines (rows K3, K3b).
- **`cookies/fresh-start.ts`** (app side, pure): `freshStartCookieDeletes(ext)` — for every `session` rule while the
  cookie manager is on, one `cookies.delete {all: false, site, name: null}` with `site` = the rule's host key without
  `*.` and port (an IP key keeps its brackets); deduplicated. x4 sends them at a fresh start (the step-2 definition:
  no other GNOME tab open, ENGINE-PROTOCOL §6.11) after `init` and before tabs are restored. A rule for
  `example.com` thereby also ends the cookies of its subdomains (`cookies.delete` works per site and subdomains);
  the cookie-rule editor says so.
- **Engine-host cookie operations** (`src/engine-host/{cookies,cookie-ops}.ts`): `cookies.list` drops expired cookies
  of Scramjet's jar (research §8.1: never purged) before reporting; `cookies.delete` of a site also updates live
  Scramjet frames (`propagateCookieSync`) where the step-2 code does not yet.
- The Cookie Store API: Scramjet deletes `cookieStore` itself; in Ultraviolet pages it reaches the real proxy-origin
  jar that every proxied site shares (finding F5), so x1 (or step 2's integration) removes it at the UV document
  start and in the child-frame guard; x3's row K11 checks it.
- Not in v1 (About): cookies on WebSocket handshakes (the hook can only allow or block the socket), third-party
  storage partitioning (localStorage/IndexedDB of third-party frames), `$cookie`/`$removeheader` filters (Ghostery has
  none).

### 6.2 Interfaces it provides (exact)

```ts
// src/extensions/privacy/params.ts
export const BUILTIN_TRACKING_PARAMS: readonly string[];     // exact names; `utm_*` is matched by prefix in code
export function stripBuiltinParams(url: string): string | null;
// src/extensions/privacy/provider.ts (DOM-free)
export function createPrivacyProvider(deps: { rewriteParams: FilterEngines['rewriteParams'] }): HookProvider;  // name 'privacy'
/** The referrer rule of §6.1 (floor + mode) on real URLs; null = send none. Also used for document.referrer. */
export function reduceReferrer(referrer: string | null, target: string, mode: SitePolicy['referrer']): string | null;
// src/extensions/privacy/document.ts (window)
export function withPrivacyDocument(provider: HookProvider, deps: { N: Natives; kitOf(win: Window): PageKit | null }): HookProvider;
// src/extensions/cookies/provider.ts (DOM-free)
export function createCookieProvider(): HookProvider;  // name 'cookies'
export function sessionizeSetCookie(value: string): string;   // a deleting line (Max-Age <= 0, Expires in the past) comes back unchanged
// src/extensions/cookies/document.ts (window)
export function withCookieDocument(provider: HookProvider, deps: { N: Natives; kitOf(win: Window): PageKit | null }): HookProvider;
// src/extensions/cookies/fresh-start.ts (app side)
import type { CommandPayload } from '../../shared/engine-protocol';
import type { Settings } from '../../settings/schema';
export function freshStartCookieDeletes(ext: Settings['extensions']): Array<CommandPayload<'cookies.delete'>>;
```
The SW composition uses `createPrivacyProvider({rewriteParams})` with the SW's own engines, so documents loaded by UV
are stripped in the SW; the engine host uses the same for Scramjet. A document's parameters are stripped exactly once
(each engine has one request path).

### 6.3 Settings it reads

`privacy.sendGpc`, `doNotTrack`, `referrer`, `stripTrackingParams`, `browser.cookies.mode`,
`extensions.enabled.privacy`, `extensions.enabled.cookies`, `extensions.cookieRules`, the allowlist (through
`SitePolicy`). It adds no key; x4 adjusts the row texts (§9).

### 6.4 Tests

- Unit: the parameter table and stripping (order kept, fragment kept, `utm_*` prefix only at a name start, encoded
  names, IDN hosts, nothing → null); the privacy provider (headers per policy; `reduceReferrer` table: same origin,
  same site other origin, cross-site, https → http, each mode, privacy protection off, the referrer never added or
  widened; POST never redirected; a redirect to another origin never produced; allowlisted pages keep GPC but lose
  stripping; the loop guard); the cookie provider (the full truth table of mode × rule × party with `null` party;
  several Set-Cookie lines; attribute spellings `max-age`, `Expires=` with commas inside the date; a deleting line
  left as it is under a `session` rule); the document parts against a fake kit over a `vm` context (the wrapped
  getter decides per `this`: a frame document passed to the top realm's getter, a document never attached; the
  prototype-descriptor path; nothing but natives and the kit touched); `freshStartCookieDeletes` (wildcard, port, IP
  keys, cookie manager off → none).
- E2E `blocker-privacy.mjs` (rows P1–P12) and `blocker-cookies.mjs` (rows K1–K12), both engines × both browsers.

**Fakes**: `rewriteParams` returning null or a canned URL; policies built with `sitePolicy` from literal settings; a
fake kit. x3's e2e rows run once x1 has wired the providers (§13 step 6); until then x3 works with unit tests (no
e2e-only `test.providers`, for the reason given in §5.4).

## 7. Lane x4: app UI

### 7.1 What it builds

- **`src/extensions/app/lists.ts`**: the `/api/filters` listing on the app origin (ETag, `304`), stored in IndexedDB
  `kv` `blocker:listing:v1`; refreshed at app start, every 60 min while GNOME is open, when the Extensions page opens
  and when `blocker.stats` reports a `failed` list — only with `extensions.autoUpdateLists`; with it off, the stored
  listing is used until the user presses "Update lists now" (with none stored, it is fetched once). `filterListRefs()`
  (exact rule below) builds `EngineSettings.extensions.lists`.
- **`src/extensions/app/exposure.ts`**: `SiteExposure` (D5) — **one per app page**, kept across engine-host
  replacements; `expose(url, tabId, reason)` for every GNOME-initiated load (before the command), every entry of a
  tab it creates or restores, every `tab.loading.url` and every `tab.committed.url`. An exposure that adds no
  `allowlist` or `perSite` entry to the scope costs nothing; one that adds entries counts against the budget: at most
  20 newly exposed rule-bearing sites per tab per minute and 120 per app page per hour (`nav-start`/`commit` reasons;
  GNOME-initiated loads and restored entries always pass); beyond the budget the site is not exposed and gets the
  global settings (counted in the `engine-protocol` diagnostics as a dropped exposure). After two compromise signals
  (ENGINE-PROTOCOL §1.2 rule 8) in this app page, `scoped()` returns empty maps for the rest of it, and the shield and
  the Extensions page say "Site rules are paused on this page: GNOME noticed tampering in its browser engine. Reload
  GNOME to resume them." `scoped(settings)` → the `allowlist` and `perSite` entries whose keys are among
  `siteKeysFor(url)` of the exposed URLs. **Every `tab.loading.url` is answered with a `settings` snapshot at once**
  (not debounced), also when the scope did not grow: the engine host waits for that answer before it judges the first
  page of a site (§4.4).
- **`src/extensions/app/key.ts`**: the `blockerKey` (32 random bytes, hex) in IndexedDB `kv` `blocker:key:v1`,
  created on first use; never synced, never in a settings export or import. **Replaced** (D6) when the app sends
  `siteData.clear` with `storage` or `cache`, when it starts with "clear site data on exit" pending
  (`clearOnStart.siteData`, the new key goes into that `init`), and after a compromise signal; the next engine-host
  start then rebuilds once.
- **`src/extensions/app/stats.svelte.ts`**: this session's counts per category (sums of `tab.blocked` deltas per tab),
  per open tab and per site of open tabs; nothing persisted.
- **Snapshot** (`src/browser/engine/snapshot.ts`): `lists` = `filterListRefs(listing, settings)` always (public data,
  so `init` can load a cached set at once; an engine host without `blocker` ignores them, D19); `allowlist`/`perSite`
  = `exposure.scoped(…)` once the engine host reported `blocker`, else empty (as today); `cookieRules` = the whole map
  while `blocker` is reported and the cookie manager is on, else `{}`; `cacheLimitMB` = `performance.cacheLimitMB`. The
  property test keeps passing.
- **Engine client and browser** (`client.ts`, `browser.svelte.ts`, `tabs.svelte.ts`): `init` with `blockerKey`; after
  `init`: a `settings` snapshot with the scoped maps (when `blocker` is reported), then, at a fresh start, x3's
  `freshStartCookieDeletes()` as `cookies.delete` commands (capability `cookies`), then session restore; `tab.blocked`
  → `tab.blocked = total` and the new `tab.blockedBy = byCategory`; `tab.loading.url` → `exposure.expose` and the
  answering snapshot; `blocker.stats`/`blocker.reload` for the Extensions page. In e2e builds whose
  `__GNOME_ENGINE_TEST_CAPABILITIES__` include `blocker` (D19), `registerFeature('extensions')` runs right after
  `registerFeature('browser')` from the start; the integration step makes that unconditional and removes the switch.
- **Texts from codes** (`error-copy.ts`): `status.blocker.detail` through `parseBlockerDetail` (C5b) and a list's
  `error` code (C5) become GNOME's own sentences; list names come only from the app's own `/api/filters` listing.
  Nothing the engine host writes is shown as text.
- **Shield** (`src/browser/ui/Shield.svelte`, `ShieldPopover.svelte`, in `Toolbar.svelte`; also in the compact and
  mobile toolbars): the count of what the blocker stopped on this page (all categories but `direct-connection`), a
  state dot while `status.blocker` is `building`/`failed`; the popover (a gesture in GNOME's UI): counts per category
  with plain names ("Ads", "Trackers", "Scam and malware sites", "Tracking parameters removed", "Cookie notices",
  "Annoyances", and "Direct connections stopped" for `direct-connection`, which GNOME's sandbox CSP stops whether or
  not blocking is on), the blocker's state and its text, **Pause on this site** / **Resume**, the three per-site
  switches (ads, trackers, cosmetic → `perSite`), "Reload to apply" when a change needs it, and a link to the
  Extensions page. No numbers are shown for internal pages. *Pause* names its key ("Pause blocking on
  *.example.com") and adds `siteKeyOf(top)` to the allowlist; *Resume* removes every allowlist key among
  `siteKeysFor(top)` that is at least as specific as `siteKeyOf(top)` (`*.<site>`, `*.<sub>.<site>`, `<host>`,
  `<host>:<port>`); when a broader key (`*.co.uk`, a user's `*.com`) still matches, *Resume* is replaced by "Blocking
  is off for <key> in Settings" with a link to that rule.
- **Blocked page** (`ErrorOverlay.svelte`, `error-copy.ts`): `tab.error {kind: 'blocked'}` — "Blocked by GNOME" with
  the reason from `detail` = `blocked:<category>` (anything else: the generic text). The engine-fallback button is
  never shown for kind `blocked` (and the engine host reports `fallback: 'none'` for it, §4.4).
  - `security` ("This site is on a list of scam and malware sites"): **Go back** only, and the sentence "If you are
    sure, you can allow the site under Settings → Site rules." No one-click allow: a forged or mistaken prompt must
    not become a permanent, synced bypass of the scam list.
  - Other categories ("GNOME's content blocker stopped this page from loading"): **Go back** and a button that names
    its key, "Turn off blocking on <key>", where `<key>` is `siteKeyOf(url)` when the page's host is the registrable
    domain or `www.` + it, else the exact host (on `ads.example.com` only that host). It opens a confirmation in
    GNOME's UI that shows the key and says what it turns off ("Ad and tracker blocking, cosmetic filtering and
    tracking-parameter removal will be off on <key>, also on your other devices if you sync settings"); after
    *Confirm*, the allowlist entry is added, the snapshot sent, and the tab navigates to `tab.error.url`
    (`tab.navigate`: the blocked navigation never committed, so `tab.reload` would load the previous page); for
    `idempotent: false` the confirmation also says the form will be sent again. No "proceed once" in v1.
- **Extensions page** (`src/pages/extensions/**`, replacing the placeholder): *Overview* — the five extensions with
  their switches, one honest sentence each, state, this session's counts; *Filter lists* — the listing grouped by
  category with license, publisher link, size, last update, on/off (the Settings component `FilterLists.svelte`
  moves to `src/extensions/app/ui/` and both pages use it), compiled/failed from `blocker.stats` (with the text of
  its code), "Update lists now", "Rebuild filter data" (`blocker.reload`); *Site rules* — allowed sites, per-site
  overrides, cookie rules (the Settings editors, shared the same way; the cookie-rule editor says that cookie rules
  are sent whole to the browser engine while the cookie manager is on, D5); *Cookies* — the cookie manager:
  `cookies.list` grouped by registrable domain (`siteOf`), names, size, expiry, flags (never values), delete a cookie,
  a site, everything (capability `cookies`); *Status* — engine version, built at, from cache or built, cache use
  against the limit, per-group sizes; *How blocking works* — what it does and does not do (the §11 limits in plain
  words: it runs inside GNOME's browser, and a site that breaks out of the proxy engine, which any site built to
  target GNOME can do (row A0, F2), can turn it off and read the site rules of open sites and all cookie rules). Before the engine host
  runs (no proxied tab yet), the page shows the settings (they apply when it starts) and says live data appears once
  the browser is open.
- **Settings** (`src/pages/settings/**`): the rows gated by `extensions` keep their controls; texts per §9; the
  allowlist, per-site and cookie-rule editors store `*.<host>` for a bare host typed in (`example.com` →
  `*.example.com`, which also covers `www.example.com`), with an explicit "only this host" choice that stores the
  bare host; IP literals stay bare; the site-permission editor (step 2) is unchanged. The feature is registered with
  `registerFeature('extensions')` in `browser.svelte.ts` right after its `registerFeature('browser')` (the browser's
  start), **last**, once every row of §9 passed its e2e (§12.4; e2e builds earlier through D19's switch).
- **About** (`src/pages/about/**`): the known limitations of §14, the MPL-2.0 and MIT packages with versions read from
  `package.json`, "filter lists are mirrored from their publishers by this server" with the listing's licenses.
- `src/app/status.ts`: a `blocker` entry (state, the text of its code) for diagnostics;
  `src/browser/testing/fake-engine-host.ts`: blocker emulation (status transitions with codes, `tab.blocked` with
  categories, `blocker.stats`/`reload`, `tab.loading.url` announcements).

`filterListRefs` (exact rule):

```ts
// src/extensions/app/lists.ts
import type { FilterListRef } from '../../shared/engine-protocol';
import type { Settings } from '../../settings/schema';

/** GET /api/filters → FilterList (docs/API.md). */
export interface ServerFilterList {
  id: string;
  name: string;
  category: 'ads' | 'privacy' | 'annoyances' | 'cookies' | 'urlparams' | 'security' | 'resources';
  format: 'abp' | 'resources';
  license: string;
  homepage: string;
  default_enabled: boolean;
  trusted: boolean;
  available: boolean;
  size: number;
  sha256: string | null;
  updated_at: number | null;
  fetched_at: number | null;
  version: string | null;
}
export interface ServerListing {
  lists: ServerFilterList[];
  resources: ServerFilterList | null;
}

/**
 * The lists the engine host compiles: available ones with a hash that are on (the user's choice, else the server's
 * default) and whose group can apply somewhere (its toggle on globally or in a per-site override; params: privacy
 * protection with "Remove tracking parameters"), sorted by id; plus `ubo-resources` when any list is in. Lists the
 * blockers cannot use are not downloaded or built.
 */
export function filterListRefs(listing: ServerListing, s: Pick<Settings, 'extensions' | 'privacy'>): FilterListRef[];
```

### 7.2 Tests

- Unit: `filterListRefs` table (defaults, user overrides, unavailable or hashless lists, a toggle off globally but on
  for one site, params, resources only with a list); `SiteExposure` (keys, scope growth, exposures without rule
  entries free, the per-tab and per-page budgets with fake timers, kept across a simulated engine-host replacement,
  empty maps after two compromise signals, an answer snapshot for every announcement); the key (created once, never
  in an export, replaced on `siteData.clear` storage/cache, on `clearOnStart.siteData` and on a compromise signal);
  stats sums; the snapshot property test with lists and scoped maps; the shield's derived state (*Resume* removes only
  keys at least as specific as the site's, the broader-key case); the overlay (no allow action for `security`, the
  key rule for other categories, `tab.navigate` to the blocked URL after confirmation, no engine-fallback button);
  the editors' bare-host → `*.<host>` rule; `parseBlockerDetail` texts.
- E2E `shell-blocker.mjs` (rows U1–U13 of §12.2), both browsers, Scramjet and UV.

**Fakes**: the extended `fake-engine-host.ts`; a fake listing (`/api/filters` JSON in the unit tests); the real stack
for e2e once x1's blocker runs (with D19's e2e switch, from x1's first Scramjet milestone on).

## 8. Lane x5: backend — filter lists from local files, and the e2e fixtures

- `GNOME_FILTER_LISTS_FILE` entries may name `file = "/absolute/path.txt"` instead of `url` (exactly one of them;
  `mirrors` only with `url`; `homepage` optional for file lists), the built-in `ubo-resources` entry included
  (`[[list]] id = "ubo-resources"` with `file` replaces its CDN/metadata fetch; the resources JSON check still
  applies; its category still cannot change): `registry.rs` validates the path at startup (absolute, no `..`
  component, at most 4,096 bytes, not under `/proc`, `/sys` or `/dev`); a missing file is not a startup error but the
  list's `last_error`.
- `refresh.rs`: a file list is read at startup, on every refresh tick and on `gnome-server filters refresh`: opened
  with `O_NONBLOCK` (a FIFO or device cannot block the refresh job), `fstat` after open must say regular file, read
  with a size bound (`max_mb`) and a timeout (10 s), then the same checks as a download (UTF-8 text for `abp`, and a
  list header: the first non-empty line starts with `[Adblock` or `!`; JSON for `resources`), content-addressed like
  the others (a new SHA-256 → a new version beside the old one), `! Expires` ignored; a read error keeps the old
  version.
- `/api/filters` shows file lists like the others (never the path, never OS error text: `last_error` is a fixed
  word); `fetched_at` = the last successful read; `/admin/diagnostics` and `config check` mark them `file`.
- **E2E fixtures** (moved from x1 to balance the lanes; day one, with the file lists): the fixture server
  `tests/e2e/engine/servers/blocker-fixtures.mjs`, the runner's step-3 plumbing in `tests/e2e/engine/{run.mjs,lib/**}`
  (start the fixture server, write the test-list TOML, `--blocker-real`, `--offline` with the pinned
  `fixtures/blocker/lists/ubo-resources.json` as a `file` entry, the generated big list), exactly as §12.1 specifies.
  The lanes' own fixture directories and `lists/<lane>.txt` files stay theirs.
- Docs: API.md ("operators may add lists from files"), ARCHITECTURE §4.2 (`GNOME_FILTER_LISTS_FILE` row),
  `backend/README.md` (registry format).
- Tests (`cargo test`): TOML validation (url xor file, relative path, `..`, `/proc`/`/sys`/`/dev`), reading and
  re-reading on change, a FIFO and a directory refused without blocking, an `abp` file without a list header
  refused, a read error keeping the old version, `ubo-resources` from a file, the `?v=` immutable answer for a file
  list, the listing without paths or OS error text.

## 9. Settings keys

No key is added or renamed: every key below already exists in `schema.ts` (ARCHITECTURE §5.3) with a Settings row
gated by `extensions` (`pages/settings/registry.ts`). x4 rewords the rows marked "text" and registers the feature
last (§12.4).

| Key | Consumer | Behaviour (and the row text where it changes) |
| --- | --- | --- |
| `extensions.enabled.adblock` | x1 (`ads`, `security` groups), x2 (their scriptlets and hiding) | network blocking, `$redirect`, scriptlets and element hiding from ad and badware lists |
| `extensions.enabled.trackers` | x1 (`trackers`), x2 | the same for privacy lists |
| `extensions.enabled.privacy` | x3 | gates GPC, DNT, the referrer modes and parameter stripping (each also needs its own Privacy switch); the referrer floor of §6.1 applies also when it is off |
| `extensions.enabled.cookies` | x3 | gates `browser.cookies.mode` and `cookieRules` (off = cookies as the engines handle them) |
| `extensions.enabled.cosmetic` | x2 (hiding), x1 (`cookies`, `annoyances` groups) | text: "Hides ad frames and page clutter, and applies cookie-notice and annoyance lists" |
| `extensions.cosmeticAggressive` | x2 | generic hiding rules: the base stylesheet and the rules of GNOME's generic-rule monitor |
| `extensions.lists` | x4 (`filterListRefs`), x1 (compiles) | deviations from the server's `default_enabled`, as today |
| `extensions.autoUpdateLists` | x4 | on: the listing is refreshed (§7.1) and new hashes rebuild; off: the stored listing is used until "Update lists now". Text: "When off, GNOME keeps the lists it has until you update them. If this browser's cache was cleared, it downloads the current versions." |
| `extensions.allowlist` | x4 (scoping, editor: a bare host is stored as `*.<host>` unless "only this host"), x1/x2/x3 (`SitePolicy`) | text: "Ad and tracker blocking, the scam and malware list, cosmetic filtering and tracking-parameter removal are off on these sites and their subdomains. Privacy headers and cookie rules still apply." |
| `extensions.perSite` | same | per-site switches for ads (with the scam and malware list), trackers, cosmetic filtering; the editor stores `*.<host>` for a bare host as above |
| `extensions.cookieRules` | x3, x4 (editor: `*.<host>` for a bare host) | text: "Applies to a site's cookies wherever they are used, also inside other sites. 'Until GNOME closes' also ends the cookies of its subdomains." plus, in the editor, "While the cookie manager is on, GNOME's browser engine receives all cookie rules." |
| `privacy.sendGpc`, `privacy.doNotTrack`, `privacy.referrer`, `privacy.stripTrackingParams` | x3 | as §6.1 (`referrer`: never more than a browser's default `strict-origin-when-cross-origin`, in every mode); `referrer` text unchanged ("What a site learns about the page that linked to it"), `stripTrackingParams` text: "Removes utm_*, fbclid, gclid and similar from pages you open" |
| `browser.cookies.mode` | x3 | `block-third-party`: cookies of other sites than the tab's page are not sent or stored, also for JavaScript in their frames |
| `performance.cacheLimitMB` | x1 (cache), x4 (row) | the cap on `gnome-blocker-v1`; text as today ("Maximum space for the filter-list data GNOME's blockers cache in this browser"); the integration step corrects the stale comments "app/asset cache cap" in `settings/schema.ts` and ARCHITECTURE §5.3 (no lane owns `schema.ts`) |
| `privacy.webrtc`, `browser.cookies.clearOnExit`, `privacy.clearSiteDataOnExit` | core (step 2), x4 (key) | unchanged; clearing site data also deletes the blocker cache and replaces `blockerKey` (§4.3, §7.1): one rebuild at the next start |

## 10. Budgets and failure modes

### 10.1 Measured on this machine (2026-11-12)

AMD Ryzen 5 5600G (6C/12T), 15 GB RAM, Node 26.13.0, `@ghostery/adblocker` 2.20.3, the default lists as gnome-server
stored them on 2026-11-11 (10 refs: the 9 default filter lists + `ubo-resources`; 6.3 MB of text). Scripts and
results: `scratchpad/work-b3-plan/{scripts,out}/` of session `dd256ece-…` (throwaway); every number from a fresh
process, so the JIT is cold, as in a new Worker.

| Step | Result |
| --- | --- |
| Sanitize (§5.1 rules as in research §6.1.1, before the review added the trust, argument, shared `$redirect-rule` and `params` rules) | 57–80 ms; 40 ABP `{style}` rules converted; in the untrusted default lists 0 `trusted-*` lines, 0 lines naming a `requiresTrust` alias, 1 scriptlet line with `$` in its arguments (counted 2026-11-12) |
| SHA-256 of all list text (WebCrypto) | 10.5 ms |
| Parse, one merged engine | 595 ms; 126,054 network, 42,217 cosmetic, 10,457 scriptlet filters |
| Parse, group engines one after the other (D1, D8) | 690–730 ms in total (ads 470–481, trackers 121–182, params 19–24); the shared exception lines: 5,926 |
| Serialized | merged 7.98 MB; groups 9.05 MB (ads 5.57, trackers 2.88, params 0.60); with the three opt-in cookie-notice and annoyance lists too (13 refs, 8.3 MB of text): 12.0 MB, build 0.88 s |
| Peak memory of a group-by-group build | max RSS 241 MB (Node's own baseline 44 MB): ~200 MB while the ads group parses; the merged build of everything at once: 373 MB |
| Load from bytes (all groups) | deserialize 21 ms; heap +2.2 MB (the engines are views into the ~9 MB ArrayBuffers) |
| First 1,000 matches after a load | 45 ms (filters are materialized lazily: warm up in idle time) |
| Matching, 20,000 synthetic requests | 11.1 µs per request (merged) vs 10.7 µs (ads then trackers, first block wins); `Request.fromRawDetails` ~1.0 µs of it |
| Cosmetics per document (`getCosmeticsFilters`, hostname rules) | 64–75 µs; ~1.4 KB of CSS (site rules) or ~8 KB with the generic base stylesheet; ~7.7 scriptlets on big sites (cnn, guardian, reddit, youtube, dailymail, speedtest) |

From the research (browsers, same library): parsing in a Chromium/Firefox SW takes 1.25–1.6× Node's time (EasyList +
EasyPrivacy 285–363 ms vs 228 ms), matching 96–110 k requests/s, deserialization 6–12 ms, selector validation of
55,840 selectors 49 ms (Chromium) / 90 ms (Firefox) on the main thread.

### 10.2 Budgets

| | Desktop (this machine, browser estimate) | Raspberry Pi 4 class device (estimate) |
| --- | --- | --- |
| First build of the default set (Worker, off the main thread; blocking fails open meanwhile) | 0.9–1.2 s | 5–9 s (JavaScript on a Cortex-A72 at 1.5–1.8 GHz runs ~5–8× slower than this Zen 3 core on single-thread benchmarks) |
| Selector validation (main thread, ≤ 8 ms slices) | 50–90 ms in total | 0.25–0.7 s in total, never a long task |
| Start with a verified cached set (MAC + SHA-256 + deserialize) | 40–60 ms (`init` waits ≤ 500 ms) | 0.2–0.4 s |
| Matching per request (Scramjet: the engine host's main thread, shared with the app) | ~11 µs → 2–3 ms for a 200-request page | 55–90 µs → 11–18 ms per page |
| Cosmetics per document (+ generic-rule monitor batches ≤ 1 per 100 ms) | < 0.1 ms + one stylesheet | 0.3–0.6 ms |
| Transient memory of a build (the Worker, terminated after it) | ~200 MB peak | the same (CPU-independent): fine with 2–4 GB, risky at 1 GB (§10.3, the out-of-memory row) |
| Steady memory per realm that holds engines | ~9–10 MB (the engine host of each GNOME tab; the SW only once UV is used) | the same |
| Cache Storage (`gnome-blocker-v1`) | default set ~9.5 MB, full set ~12 MB; the 256 MiB default keeps several sets; the 16 MiB minimum keeps the current one (rows S4 and U11 use x5's generated big list, > 16 MiB, to test the over-limit case) | the same |
| Engines to the SW (`gnome-blocker-engines`, a structured-clone copy) | ~9–12 MB per SW start and per swap while a UV tab is open; estimate 5–15 ms to clone + 21 ms to deserialize (measured in the integration step) | 0.1–0.3 s |
| Server (a Pi 4 running gnome-server) | serves precompressed list text, ~1.6 MB brotli per browser per list change; no engine build on the server | negligible CPU |
| Code size (research §2.3: `@ghostery/adblocker` + its dependencies 253.6 KB minified, 90.8 KB gzip, 71.1 KB brotli; `-content` 3.2 KB) | the engine host's blocker chunk (dynamic `import()` in `createBlocker`) and the builder Worker (a separate Vite worker bundle) each carry one copy, `sw.js` another (UV); the app carries none, only `tldts-experimental` (~101 KB minified) in the lazily loaded shield/Extensions chunk. Budgets in `build.mjs`: the engine-host entry chunk stays under Vite's 300 KB `chunkSizeWarningLimit` (129 KB on 2026-11-12, before step 3), the blocker chunk and the Worker under 400 KB each, `sw.js` grows by at most 350 KB; engine-host start (load → `ready`) measured before and after | the same bytes; parsed once per realm |

The Pi 4 column is an estimate: no Pi 4 was available for this plan. The integration step measures it with a Pi 4 (or
records that it could not), and About's performance note quotes measured numbers only.

### 10.3 Failure modes

| Situation | Behaviour | What the app shows (its own text for the C5b code) |
| --- | --- | --- |
| First run, nothing cached | builds in the Worker; list-based decisions fail open; privacy headers, cookie rules and the built-in parameter table apply at once | shield dot, `status.blocker` `building`: "Preparing filter lists…" |
| Lists updated (new hashes) or a list turned on | the new set builds in the background; the engines in force stay until the swap (D7) | `ready`, nothing changes until the swap |
| One list fails (download error, `503`, changed on the server, too large, invalid UTF-8) | skipped this build, the others compiled; retried at the next build; the app refreshes its listing (auto-update on) | `ready` + `lists-failed:2:9`: "2 of 9 filter lists could not be loaded"; per list in the Extensions page (`blocker.stats`, the list's `error` code) |
| Every list fails, the Worker crashes or runs out of memory | `failed`; retried after 1, 5, 30 min and at the next snapshot with other lists; fail open | `failed:<reason>`: "Filter lists could not be prepared" + the reason (out of memory: "…turn off some filter lists") |
| Unsupported syntax inside a list | Ghostery drops the filter; the sanitizer counts what it drops; never fails the list | `dropped` per list |
| A cached set fails verification (MAC, K binding, hash, version) | deleted and rebuilt (fail open meanwhile) | once (`cache-rejected`): "The cached filter data did not verify and was rebuilt" |
| The set is larger than `cacheLimitMB`, or `Cache.put` fails (quota) | not cached; built at every start; UV pages are still filtered (the SW gets the engines by message) | `over-cache-limit:<bytes>:<limit>` |
| A page deletes `gnome-blocker-v1` (UV pages reach Cache Storage) | the set in force stays; the next start rebuilds, failing open meanwhile | `building` at the next start |
| The user clears site data (also "on exit") | `gnome-blocker-v1` deleted, nothing more written this session, `blockerKey` replaced: one rebuild at the next start | `building` once |
| A compromise signal (ENGINE-PROTOCOL §1.2 rule 8) | the app replaces `blockerKey`; after the second one in an app page it sends empty site maps for the rest of that page | the shield and the Extensions page: "Site rules are paused on this page…" |
| Engine-host reload (unexpected load, Retry, app reload) | the new instance loads the verified cached set at `init` (≤ 500 ms wait), the app restores tabs after `init`; the exposure budget carries over (per app page) | nothing, or `building` when nothing was cached |
| The app's storage cleared (new `blockerKey`) | no cached set verifies: one rebuild | `building` once |
| SW restart (Firefox stops idle workers after ~30 s) | `SW_FALLBACK_SETTINGS` (schema defaults: GPC, referrer floor, `block-third-party`) from the first request; list-based decisions fail open until an engine host sent config and engines; one 300 ms deadline per start, not per request; Scramjet unaffected | nothing |
| A UV request whose page context the SW does not know | held ≤ 50 ms for it, then judged with the global settings, no site rules, as third-party (D15) | nothing; counted in V2 |
| Several GNOME tabs | one build at a time (Web Lock, 30 s cap); every engine host then loads the cached set; the SW unions their scoped maps and uses the engines it received last | nothing |
| Settings change during a build | the Worker is terminated, the build restarts with the new lists | `building` continues |
| A hook throws | caught (composite, `safeVerdict`), counted in `EngineDiagnostics.blocker.hookErrors` (C12), the request is allowed | diagnostics only |
| GNOME's server unreachable | the stored listing is used; list downloads fail as above | as above |
| Library upgrade (`ENGINE_VERSION` changes) | the key changes: one rebuild | `building` once |
| Scramjet does not await an async plugin tap (§4.4 spike) | the first page of a site reached by a link is judged without its site rules (fallback) | nothing; About states it |

## 11. Security and privacy

ENGINE-PROTOCOL §1 applies: the app origin is the only boundary GNOME guarantees; the proxy origin is one shared
realm, and code that escaped its engine controls the engine host, the SW, the Worker it can start, and Cache Storage.
Step 2 measured that any ordinary page can become such code without an engine bug (F2, `borrow-natives`). The blocker
lives on the proxy origin, so it protects users from sites that do not target GNOME, never from one that does;
GNOME's UI says so (§7.1 *How blocking works*).

### 11.1 What a hostile page can and cannot do to the blocker

The "Ordinary page" column holds only for a page that does not target GNOME. Step 2 measured (finding F2,
`host-attack borrow-natives`, recorded `expectFail` in both engines and both browsers) that any ordinary page reaches
the engine-host window through a fresh child realm's native `parent`/`top`/`frameElement` getters, without an engine
bug, so a page that targets GNOME has the "Escaped code" column everywhere, and About and *How blocking works* say "a
site that targets GNOME can turn blocking off and read the site rules of the sites you have open". No "ordinary page
cannot" claim counts against such a site unless row A0 passes, and A0 cannot pass while that path is open.

| Attack | Ordinary page | Escaped code | Defence, and what the UI says |
| --- | --- | --- | --- |
| Detect blocking (failed bait requests, missing elements, the stylesheet, `navigator.globalPrivacyControl`, a scriptlet's effect) | yes | yes | inherent to every blocker; the page learns only that it is filtered |
| Turn it off for its own page | partly: it can drop GNOME's stylesheet from its own `adoptedStyleSheets`, undo a scriptlet in its own realm, hide elements from the generic rules; it cannot change a network decision (made in the engine host for Scramjet, in the SW for UV), a header or a cookie rule | yes, everything | network decisions never run in the page realm; rule R1 gives the page no path of GNOME's into the engine-host realm (F2's `borrow-natives` path stays open) |
| Turn it off for other pages and tabs | no through its engine; yes through `borrow-natives` (F2) | yes (one realm) | stated limit |
| Reach the engine-host realm | through anything GNOME installs: no (R1, step 2's kit; step 2's `realm-walk` and `page-getters` rows, A1 adds the stack sweep); otherwise **yes, measured** (F2: a fresh child realm's native `parent`/`top`/`frameElement` getters, both engines and browsers; also UV's unhooked `frameElement` and Scramjet's client global) | — | row A0 records it (`expectFail`); the About text above |
| Get past WebSocket blocking | Scramjet: no while the D16 wrapper holds, and a URL it blocked stays blocked in the backstop (A10); UV: possibly, by talking to bare-mux's SharedWorker directly **[unproven]**, tried by row A7 | yes | a bypass, if shown, goes into About |
| Plant filter data or scriptlets in `gnome-blocker-v1` | no: a set is used only when its MAC under the app's `blockerKey` verifies and the manifest names exactly the K being loaded (D6); scriptlet code comes only from the hash-checked `ubo-resources` list inside that set; the SW never reads the cache. UV pages can read the cache (its per-user MAC, replaced with "Clear site data") and delete it (one rebuild) | yes: it can read the key, and a planted set persists until the lists or the key change or the user rebuilds — no worse than replacing the SW (B7), which persists too | rebuild on any mismatch; "Rebuild filter data" (`blocker.reload`); the version numbers in the key; key rotation |
| Read the user's site rules | no: they live only in the memory of the engine host and the SW (nothing is persisted on the proxy origin), and R1 gives a page that does not target GNOME no path into those realms (one that does has F2's `borrow-natives`); a page sees from the behaviour whether its own site is exempt | the scoped `allowlist`/`perSite` (D5: sites open in GNOME tabs, plus the budget of forged announcements) and all `cookieRules` | D5; *How blocking works* says that a site that breaks out of the proxy engine can read the rules of the sites you have open and your cookie rules |
| Forge counts, status or stats | no: synthetic `securitypolicyviolation` events are ignored (`isTrusted`, F6); only the engine host emits events | yes | counts are display-only (ENGINE-PROTOCOL §1.2 rule 2); status and stats are codes the app turns into its own text, so no realm can write a message into GNOME's UI (C5, C5b) |
| Delay or starve builds | yes, a little: neither engine hooks `navigator.locks` (code reading), so holding `gnome-blocker-build` delays a build by ≤ 30 s (fail open meanwhile); it cannot feed the Worker | yes | the lock cap; the Worker takes input only from the engine host (refs from the app, lists from the server, hash-checked) |
| Message the SW (fake UV config, context or engines) | no if row A3b passes: `gnome-blocker-*` count only from client ids the SW registered as engine hosts, never from an id it saw as a proxied document or requester, so a `pushState` to `/engine/` no longer passes (F3); residual: right after a SW restart, and a page that reaches a native realm (F2) can start a real `/engine/` document | yes | as B7 |
| Make its tab look like another site (UV cross-origin `pushState`) | no after F4's fix: GNOME's kit wrapper refuses another origin with a `SecurityError`, as browsers do, and the engine host ignores same-document commits that change origin (row A8) | yes (ENGINE-PROTOCOL §1.2 rule 3) | policy, exposure and SW context never move on a same-document commit to another origin |
| Use the shared proxy-origin cookie jar through the Cookie Store API | UV: no after F5's fix (removed at document start and in child realms, row K11); Scramjet removes it itself | yes | — |
| Run code through a filter list | no from an untrusted list: GNOME builds every scriptlet call itself with JSON arguments, the sanitizer drops untrusted lines with a backtick or `$` in their arguments and every scriptlet that needs trust, by name and alias (§11.3) | — | a list marked trusted may run code in the pages it names: that is what trust means, the operator's decision |
| Load resources or leak data through list CSS | — (lists are chosen by the operator) | — | `:style()` refuses `url()`, `image()`, escapes and the rest of §5.1 rule 5 (case-insensitively); hiding rules are `display: none`; the proxied-document CSP blocks direct loads anyway |
| Turn a forged prompt into a lasting bypass ("Allow this site", "Pause") | it can put the blocked overlay or the shield on its own site: the actions name their key and need a confirmation; there is no allow action on a `security` block (§7.1) | yes, on any site | the confirmation shows the exact key and that it syncs |

### 11.2 Findings in step 2's code (2026-11-12)

Owner of each open item: step 2's integration step if it is still running when step 3 starts, else lane x1, as its
first tasks before x2 and x3 add page-side code (§13). The orchestrator passed F2–F6 to `wave-b:integrate`; its part 1
(2026-11-18, documents only) checked each against the code and left F2–F6 open, as the status lines below say.

- **F1 (high; fixed by step 2): engine-host functions that proxied pages could reach.** Found by reading the code for
  this plan: `popups.ts` (`window.open`/`close` accessors, the form `submit` wrapper), `webrtc.ts` (the child-frame
  guard's getters and insertion wrappers), `tabs.ts` (the UV `createWebSocket` wrapper and its `DOMException`),
  `observe/commits.ts` (the `History` wrappers). Step 2's engine-host review replaced all of them with its page-realm
  kit (`realm.ts`, §3.3, §4.7). Checked in the code on 2026-11-18: `popups.ts` installs `window.open`/`close` and the
  form `submit` wrapper with `kit.fn`/`kit.replace`, `webrtc.ts` installs nothing when a realm has no kit and wraps
  only through `wrapMethod`/`wrapAccessor`, and `tabs.ts`' UV `createWebSocket` wrapper and `Ultraviolet` accessor
  are `kit.replace`/`kit.fn` callables that throw `kit.error`; step 2's rows `host-attack realm-walk` and
  `page-getters` find 0 engine-host functions and arrays in both engines and browsers. x1 extends the row (A1).
- **F2 (high; measured, open): paths from an ordinary page to the engine-host realm without any engine bug.**
  - **Measured by step 2** (lane a review, row `host-attack borrow-natives`, recorded `expectFail`): an ordinary page
    in either engine and browser calls a fresh child realm's NATIVE `parent`, `top` or `frameElement` getter on its
    own window (`Object.getOwnPropertyDescriptor(frame.contentWindow, 'parent').get.call(window)`, or the same through
    `window[0]` of a frame the parser inserted) and gets the engine-host window. This path does not depend on the
    engines' hooks, so the two fixes below do not close it: GNOME would have to virtualize those getters in every
    fresh realm before the page reaches it, which the gaps of ENGINE-PROTOCOL §6.15 (polling a navigating frame,
    `javascript:` documents, Firefox's late `load`, stack exhaustion) defeat, and which would break the engines' own
    `top`/`parent` logic. Only engine-level virtualization of every fresh realm or per-site proxy sub-origins would
    close it. Status 2026-11-18: open; ENGINE-PROTOCOL §1.1 and ARCHITECTURE §4.6 now say that the app origin is the
    only boundary.
  - Ultraviolet 3.2.10 never hooks `frameElement` (0 occurrences in `uv.client.js`, `uv.handler.js`, `uv.bundle.js`,
    `uv.sw.js`). A UV tab document's `frameElement` is the tab `<iframe>` of the engine-host document; the engine host
    created that element, so its wrapper belongs to the engine-host realm (realm.ts rule 3), and
    `frameElement.constructor.constructor('return this')()` or `frameElement.ownerDocument.defaultView` hands any UV
    page the engine host. GNOME's own `public/engine/uv-doc-hook.js` performs this walk from the page realm. Fix (GNOME
    can): at every UV document start, and in every child realm the child-frame guard reaches, wrap that realm's
    `Window.prototype.frameElement` getter with `kit.replace`: when the native result (`N.frameElement.call(self)`) is
    an element of the engine-host document, `RETURN null`, else `CALL_ORIGINAL`. GNOME's hook keeps working: it runs
    first in each new realm and calls that realm's still-native getter on the parent windows.
  - Scramjet 2.0.67-alpha.2 keeps its client on every proxied window under the registered symbol
    `Symbol.for('scramjet client global')` (`globalThis.Symbol.for` in `scramjet.js`; GNOME's `vendor.ts` reads the
    same key), and the client exposes `descriptors.get(…)`, `descriptors.store` and `natives`, which call native
    getters: `descriptors.get('window.frameElement', window)` returns the tab iframe. GNOME cannot hide it without
    breaking Scramjet (Scramjet reads its frame's name through that call). Report upstream; until Scramjet hides its
    client, A0 fails for Scramjet and About says so.
  - Status of these two in the code on 2026-11-18: no `frameElement` wrapper exists (`tabs.ts`, `popups.ts` and
    `uv-doc-hook.js` only read the native getter), and Scramjet's client global is unchanged. Wrapping UV's
    `frameElement` still removes the most direct path, but the measured one above stays.
  - Row A0 (§12.2) runs first in both engines and browsers; `borrow-natives` is its first case.
- **F3 (high; code reading): the SW authenticates engine-host messages by URL.** `sw.ts` accepts any window client
  whose URL path is `/engine/` (`isEngineHostClientUrl` ignores the query). A UV page can call a native
  `History.prototype.pushState` from an unhooked `about:blank` child realm (`window[0]` skips UV's `contentWindow`
  hook) on its own `history`, so that its URL becomes `/engine/?x`, and post through that realm's
  `navigator.serviceWorker`: its `gnome-claim`, `gnome-skip-waiting` (a second "engine host" also stops waiting SW
  updates from being applied) and, in step 3, blocker config, context and engines then count as an engine host's,
  and it receives every SwSignal (other tabs' download, error and blocked URLs). [unproven] in Firefox: whether
  `Client.url` follows `pushState` and which client a message's `source` is. Fix: the client-id registration of
  §4.5 for every message and signal; row A3b. Status 2026-11-18: open (`sw.ts` still accepts a message, and sends
  signals, by `isEngineHostClientUrl(client.url)`, which compares origin and path only). With F2 open, a page can
  also post from the engine host's own client, which no client-id rule tells apart.
- **F4 (medium): UV's cross-origin `pushState`.** UV's history hook only rewrites the URL (`e.rewriteUrl(t.data.url,
  …)`), Scramjet's refuses another origin; `nav-machine.ts sameDocument()` commits whatever comes. An ordinary UV
  page can make its tab show any site in the address bar and in history, and in step 3 take that site's
  allowlist and per-site policy and make the app expose its rules. Fix: at the UV document start (before UV's
  client, so UV wraps GNOME's wrapper and hands it the proxied URL), `kit.replace` on `History.prototype.pushState`
  and `replaceState`: decode the URL argument, and for another origin than the document's real one `THROW
  kit.error('The URL is not of the same origin', 'SecurityError')`, else `CALL_ORIGINAL`; `nav-machine` ignores and
  counts same-document commits that change origin. Row A8. Status 2026-11-18: open (`nav-machine.ts sameDocument()`
  has no origin check, and no `pushState`/`replaceState` wrapper refuses another origin).
- **F5 (medium): UV leaves the Cookie Store API unvirtualized** (`cookieStore` 0 times in UV's client files; Scramjet
  deletes it). Every ordinary UV page can read and write real proxy-origin cookies: one jar shared by all proxied
  sites, invisible to `cookies.list`, untouched by every cookie mode, rule and clear-on-exit, sent with every
  proxy-origin request (and to the app origin in two-port development). Fix: at the UV document start and in the
  guard's child realms, data properties holding `undefined` for `cookieStore`, `CookieStore` and
  `CookieStoreManager` on the window and for `cookies` on `ServiceWorkerRegistration.prototype` (as the WebRTC kill
  switch does). Row K11. Status 2026-11-18: open (nothing in `src/engine-host/`, `public/engine/` or `src/sw/` touches
  `cookieStore`; UV 3.2.10's client files still never mention it).
- **F6 (low): forged `direct-connection` counts.** `tabs.ts` counts every `securitypolicyviolation` event it sees on
  a proxied document, synthetic ones too. Fix: every GNOME listener on page targets ignores events whose `isTrusted`
  is false (`observe/keys.ts` and `context-menu.ts` already do). Row A9. Status 2026-11-18: open (the listener in
  `tabs.ts` reads the disposition and directive through the engine host's natives but never checks `isTrusted`);
  ENGINE-PROTOCOL §6.16 says the count is display-only.
- Carried over from the first version of this plan: the Scramjet WebSocket hook has no tab or top-level context
  (`transport/manager.ts #checkWebSocket`, D16); `parseSwSignal` accepts any string as a `uv-blocked` category (C11);
  `site-data.ts`'s header comment says the engine host keeps nothing in Cache Storage (§4.3).

### 11.3 Scriptlets as a code-injection vector

- **Where the code comes from**: only the `ubo-resources` list (uBO's scriptlets and redirect resources, GPL-3.0),
  which gnome-server mirrors from its own registry, fetched by hash, and carried inside the MAC'd cached set. Filter
  lists only name a scriptlet and pass arguments.
- **Arguments are made data by GNOME, not by the library**: Ghostery 2.20.3's own assembly lets them break out
  (§11.4), so x1 builds every call itself with the arguments as one JSON array (`scriptletCall`, §4.2), for trusted
  and untrusted lists alike, and never uses Ghostery's assembled strings; the sanitizer also drops untrusted scriptlet
  lines whose arguments contain a backtick or `$` (§5.1 rule 3), in case that code path is ever bypassed. Upstream
  report for Ghostery: JSON-encode arguments.
- **Trust**: a scriptlet that needs trust (`requiresTrust` in the verified resources, every name and alias, and every
  `trusted-` name; they set arbitrary cookies and storage, click elements, replace page text, and `rpnt` /
  `replace-node-text` rewrites inline scripts, which is code by design) runs only from lists the server marks
  `trusted` — the operator's decision in `GNOME_FILTER_LISTS_FILE`, which `backend/README.md` tells operators to make
  only for lists they fully trust. The sanitizer drops them from every other list, because the library ignores
  `requiresTrust` and trims names (§11.4). Upstream report: enforce `requiresTrust`. AdGuard `#%#` rules (raw
  JavaScript) and ABP `#$#` snippets are dropped outright; generic `##+js()` without a domain is refused by the
  library.
- **Where it runs**: in the page's own realm through `kit.run`, which compiles it with that realm's current
  `Function` after the engine's client hooked the window (Scramjet `init.post`; Ultraviolet right after its handler),
  so the engine rewrites it like page code and it sees the virtual location, cookie jar and storage; with that page's
  privileges; never a `<script>` element (no `injectScript`: it bypasses Scramjet's rewriting and uses blob URLs that
  Scramjet hooks, research §2.11), never in the engine-host realm, never in the SW.
- What a list can still do — and its operator chose it: an untrusted list runs uBO scriptlets that need no trust, with
  data arguments, on the sites it names, hides content and blocks requests; a trusted list can run any code in the
  pages it names.

### 11.4 Measured probes: scriptlet arguments and trust

- **The first version of this plan was wrong.** Its probe (`scratchpad/work-b3-plan/scripts/scriptlet-args.mjs`,
  `@ghostery/adblocker` 2.20.3, the server's `ubo-resources.json` of 2026-11-11) tried five argument vectors and saw
  `PWNED` stay 0, and read that as "the arguments stay escaped data". The vector `` `${globalThis.PWNED=1}` `` had in
  fact broken out of the literal; the rest of the script then threw a `SyntaxError`, so nothing ran.
- **Security review** (`scratchpad/work-b3-sec/backtick-probe.mjs`, `backtick-probe2.mjs`): the line
  ``a.test##+js(set-constant, foo, x`-Function`globalThis.PWNED=1```-`)`` produced the argument array
  ``[`foo`,`x`-Function`globalThis\.PWNED=1```-``,…]``, and evaluating only that array set `PWNED` to 1 (a tagged
  template calls `Function`; inside the attacker's own template the escaped characters cook back to themselves);
  `c.test##+js(rpnt, script, foo, bar)`, `d.test##+js(replace-node-text, script, foo, bar)` and
  `e.test##+js(prevent-clipboard-write)` from an untrusted list were all injected.
- **Completeness review** (`scratchpad/work-b3-fit/probe/full.mjs`, `args.mjs`, `args4.mjs`; the whole assembled
  scriptlet in a `vm` context): ``x.test##+js(set-constant, a`\,Function`globalThis.PWNED=2```\,`)`` → `PWNED` 2;
  `x.test##+js(set-constant, $', \,PWNED=6\,0, \,0, …)` — no backtick: `$'` makes `String.prototype.replace` splice
  the rest of the script back in, which puts the next argument in code position → `PWNED` 6; `##+js( trusted-set-cookie,
  …)` with a leading space and `##+js(rpnt, …)` were injected.
- **Confirmed for this revision by reading the library** (`dist/esm/filters/cosmetic.js` `getScript`: `arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`,
  then `script.replace(`{{${i + 1}}}`, arg)`; `resources.js` `assembleScript`: `` (...[`{{1}}`,…,`{{10}}`]…) ``;
  `getScriptlet` never reads `requiresTrust`; the trimmed `parts[0]` is the name) and the server's resources file (34
  `requiresTrust` scriptlets).
- **The fix, checked for this revision** (`scratchpad/work-b3-plan-fix/check-scriptletcall.mjs` and
  `check-trust.mjs`, Node 26, the planner's scratch install, the server's resources file): all 99 scriptlet templates
  `getScriptlet` returns end with `GHOSTERY_ARGS_TAIL`; with the three break-out lines above, Ghostery's own scripts set
  `PWNED` to 2, 6 and 1, while `scriptletCall` built from `matchCosmeticFilters` + `parseScript()` ran each scriptlet
  with `PWNED` 0 and the arguments as plain strings (a regex argument `/^a$/` arrived unchanged); the sanitizer's name
  rule (§5.1 rule 2) catches `rpnt`, `replace-node-text`, `prevent-clipboard-write` and `+js( trusted-set-cookie, …)`
  exactly where Ghostery resolves them, and a case variant (`RPNT`) resolves to nothing in Ghostery either.
- The regression tests (x1 §4.9 with the real library, x2 §5.4, rows CS11–CS15) evaluate the **whole** generated
  script, so a break-out that then throws still fails them.

### 11.5 Cosmetic CSS and GNOME's own UI

- Styles go only into proxied documents (windows in a tab's frame tree), through the page's own adopted stylesheets;
  never into the engine-host document (which holds every tab frame) and never into the app.
- The only GNOME UI inside proxied pages is the find-in-page highlights (CSS Custom Highlight API): selectors whose
  parsed text contains `::highlight(` are dropped (also `::HIGHLIGHT(` and escaped spellings, since the check runs on
  the selector the browser parsed), and so are rules that hide the root or body element of a probe document (`html`,
  `body`, `:root`, `*`, …). A list can still hide everything inside the body (`body > *`, `div`): everything a list
  hides belongs to the site, and the operator chose the list.
- A page can read and remove GNOME's stylesheet from its own document; that only un-hides its own content.

### 11.6 What crosses the boundary (added to ENGINE-PROTOCOL §1.2 rules 4–5)

- **App → engine host**: the list refs (ids and hashes, public), `cacheLimitMB`, the scoped site rules (D5), all
  `cookieRules` while the cookie manager is on, and `blockerKey` (a cache-integrity key: it authorizes nothing outside
  the blocker cache; replaced when site data is cleared or a compromise signal is seen; a page cannot read it through
  its engine, but any page that reaches the engine host can, F2). Never: rules of sites the user has not opened in this app page (beyond the
  budget), or anything rule 5 lists.
- **Engine host → app**: counts per category (no URLs), `blocker.stats` (list ids, hashes, counts, sizes, error
  codes; no URLs, no text), `status.blocker` codes, `tab.loading.url` (a navigation's destination, which the app
  learns at the commit anyway; validated like every URL, throttled, and budgeted where it exposes rules).
- **Engine host → SW**: the settings (with the scoped maps), the set key, the compiled engines (public list data),
  the UV page context (proxied and real URLs of open documents); never the key.
- **Proxy-origin storage**: only `gnome-blocker-v1` (MAC'd engine sets; the MAC is a per-user value UV pages can
  read, replaced with "Clear site data"); no site rules, no key, no settings.
- **Server**: nothing new about users. x5's file lists read only regular files at paths in the operator's
  configuration (absolute, no `..`, not `/proc`, `/sys`, `/dev`), and `/api/filters` never shows paths or OS errors.

## 12. Tests: fixtures, end-to-end rows, real sites, the matrix

Unit tests are listed per lane (§4.9, §5.4, §6.4, §7.2, §8). Everything below runs on the real stack of the e2e
runner (`tests/e2e/engine/run.mjs`: gnome-server in two-origin mode serving an `npm run build:e2e` build built with
`GNOME_ENGINE_TEST=1 GNOME_ENGINE_TEST_CAPABILITIES=blocker` (D19), HolyWisp, playwright-core 1.64.0 with the cached
Chromium 156 and Firefox 157), with suite files named after their lane.

### 12.1 Fixtures (lane x5, day one)

- **Fixture server** `tests/e2e/engine/servers/blocker-fixtures.mjs` (node:http, started by the runner like the
  spike's target site, port `E2E_BLOCKER_PORT` = `E2E_PORT_BASE + 50`, listening on `[::1]` and `127.0.0.1`): it serves
  `tests/e2e/engine/fixtures/blocker/<lane>/**` (one directory per lane, each lane owns its own) by `Host`, for the
  names `site-a.localhost`, `site-b.localhost`, `ads.localhost`, `trk.localhost`, `cdn.localhost`, `bad.localhost`,
  `docblock.localhost`, `idp.localhost`, plus the endpoints `/echo` (request headers and the request URL as JSON,
  `no-store`), `/set-cookie?…` (a `Set-Cookie` per query pair), `/cookies` (the `Cookie` header it got), `/ws`
  (WebSocket echo), `/beacon` (counts hits: proves that something was *not* requested), `/redirect?to=` (a 302),
  `/policy?referrer=<policy>` (a page with that `Referrer-Policy`). Pages reach it only through the VPN profile route
  `e2e-vpn` (`openApp(context, {route: 'profile:e2e-vpn'})`), whose HolyWisp has the TEST-ONLY allow-loopback overlay;
  the direct route keeps the production policy. `*.localhost` resolves to `::1` on this host (nss-myhostname, checked
  2026-11-12); if that HolyWisp refuses `::1`, the names map to `127.0.0.2`–`127.0.0.9` (distinct IPv4 loopback
  addresses are distinct sites) and the rows stay the same. `site-a.localhost` and `site-b.localhost` must be distinct
  registrable domains for `siteOf()` (x1's unit test pins it).
- **Test lists** `tests/e2e/engine/fixtures/blocker/lists/<lane>.txt` (x1 `network.txt`, x2 `cosmetic.txt` and
  `cosmetic-trusted.txt`, x3 `privacy.txt`; each owned by its lane), each starting with `! gnome-e2e: id=… category=…
  trusted=… default=…`. The runner writes a `GNOME_FILTER_LISTS_FILE` TOML (into the run directory) that disables
  every built-in filter list, keeps `ubo-resources` (fetched from its upstream; with `--offline`, the pinned copy
  `fixtures/blocker/lists/ubo-resources.json` as a `file` source of the built-in entry, §8) and adds every
  `lists/*.txt` as an x5 `file` list, plus a **generated big list** `big.txt` (`default=false`, `max_mb = 16`): 400,000
  distinct lines `||big-<n>.localhost^`, ~9.6 MB of text, which serializes to more than 16 MiB (rows S4, U11 turn it
  on). A second runner mode `--blocker-real` keeps the built-in registry (internet) for §12.3.
- **E2E-only test commands** (x1's `#testHandlers`, never in production builds): `test.blocker {holdBuild, releaseBuild,
  plant, corrupt}` (fail-open rows, cache attacks through the engine-host realm), `test.blockerExposure` (the scoped
  maps the engine host holds, for A6). There are no `test.cosmetic`/`test.providers` commands (§5.4).

### 12.2 Rows (both engines × both browsers unless a row says otherwise)

**Network** (`blocker-network.mjs`, x1):

| Row | Case | Pass |
| --- | --- | --- |
| N1 | `<script src=//ads.localhost/ads/ad.js>` on site-a, rule `\|\|ads.localhost^$third-party` | `onerror` fires, the script did not run, `tab.blocked.byCategory.ads ≥ 1` |
| N2 | the same script on an `ads.localhost` page | loads (first party) |
| N3 | a pixel from `trk.localhost` (privacy list) | blocked, counted `trackers` |
| N4 | `@@\|\|ads.localhost/ok.js^` in *another* list than the blocking rule | loads (shared exception lines) |
| N5 | `$badfilter` in list B for a rule of list A | the rule no longer blocks |
| N6 | `$redirect=noop.js` for a script | answered `200` with the noop body (page marker set), counted; in UV the body went through UV's rewriter (a stub that reads `location` sees the real URL) |
| N7 | `$subdocument` rule for an ad frame, and a `$redirect=noop.html` rule for a frame | the frame is empty (never a resource), counted; the page works |
| N8 | `\|\|docblock.localhost^$document` and a link to it | `tab.error {kind: 'blocked'}`, `fallback: 'none'`; no `tab.committed` for the blocked URL; no request reached the page's subresources |
| N9 | badware-category rule for `bad.localhost` | blocked, counted `security` |
| N10 | `\|\|ads.localhost^$websocket` | the socket fails, counted (Scramjet: D16 path or backstop; UV: wrapper) |
| N11 | allowlist site-a; per-site ads off; trackers off globally | nothing blocked; ads load but trackers are blocked; trackers load |
| N12 | the build held (`test.blocker {holdBuild}`) | the page loads unblocked, `status.blocker` `building`; after release the next load is blocked |
| N13 | counts | `byCategory` per category, `total` = their sum including a `direct-connection` the fixture provokes |
| N14 | `fetch()` and XHR to an ad URL | an empty `403` (recorded per engine and browser) |
| N15 | a site-b frame inside allowlisted site-a | its third-party requests are not blocked (frames inherit) |
| N16 | a link from allowlisted site-a to `docblock.localhost` (`$document` rule) | blocked: the destination is judged under itself (D3) |
| N17 | a link from site-b to allowlisted site-a, which loads an `ads.localhost` script at once (preload scanner) | site-a and its script load: the tab document waited for its rules (D5) and the early subresource belongs to site-a (pending top, §4.4) |
| N18 | `$redirect-rule=noop.js` for `trk.localhost` in the ads test list, `\|\|trk.localhost^$third-party` in the privacy test list | the tracker script is answered with the noop stub, not refused (shared `$redirect-rule`, D1) |

**Ultraviolet specifics** (`blocker-uv.mjs`, x1, UV only): V1 SW restart (Chromium: stop it through CDP; Firefox: wait
past its idle timeout) — the first UV request after it carries `Sec-GPC` and has third-party cookies stripped (the
schema defaults), and is list-judged once the engines arrive (or recorded as failed open with the wait time; one
300 ms deadline per start, the second request is not held again); V2 a page with 20 nested frames, each loading a
third-party resource — at most 5 % of requests judged with unknown context (D15); V3 two GNOME tabs, only one of which
exposed allowlisted site-a — site-a is exempt in UV pages of both (the SW's union); V4 a UV tab-top navigation by link
is typed `main_frame` (N8 holds for it, no `tab.committed` for the blocked URL); where the Navigation API is missing,
the fallback is recorded; V5–V9, each checked against a `$third-party` rule and a third-party cookie (both must apply):
V5 an iframe with `referrerpolicy="no-referrer"`, V6 a page served with `Referrer-Policy: no-referrer`, V7 an
`about:blank` and a `srcdoc` ad frame that load an ad, V8 a dedicated worker's fetches (and a shared worker: refused by
GNOME's SW), V9 `fetch(url, {referrer: <another proxied page's URL>})`; V10 a set larger than `cacheLimitMB` (the big
list) — UV pages are still filtered (engines by message).

**Cache** (`blocker-cache.mjs`, x1): S1 a second engine host loads the cached set (`blocker.stats.source: 'cache'`,
ready ≤ 500 ms after `init` on this machine); S2 a set planted in `gnome-blocker-v1` by an ordinary UV page (it
reaches `caches`) and through `test.blocker {plant}` — not used, rebuilt, `cache-rejected` once; S3 one flipped byte
in a group's bytes — rebuilt; S4 `cacheLimitMB` 16 with the big list on — not cached, `over-cache-limit`; at 256 —
cached; S5 a list rewritten on the server (x5 file + `gnome-server filters refresh`) while the app's listing is stale
— that list `failed` with `changed`, the app refreshes, the set rebuilds with the new hash; S6 `blocker.reload` —
`building` → `ready`, `source: 'build'`, pages loaded during the rebuild still blocked by the old set, and the SW gets
the new set (UV pages blocked by it after the swap); S7 two GNOME tabs start with an empty cache — one build (lock),
both `ready`; S8 a UV page reads `caches.keys()` and the manifest, and deletes `gnome-blocker-v1` — it finds no
millisecond timestamps, the next start rebuilds; S9 "Clear site data" — the cache is gone, the next `init` carries
another `blockerKey`, the old MAC never reappears; S10 an older validly MAC'd manifest copied under the current K —
refused.

**Attacks** (`blocker-attack.mjs`, x1): **A0 first** — an ordinary page in each engine tries step 2's
`borrow-natives` case (a fresh child realm's native `parent`/`top`/`frameElement` getters called on its own window,
which reaches the engine host in both engines and browsers today, `expectFail`), `frameElement.ownerDocument.defaultView`, `frameElement.constructor.constructor`,
`Object.getOwnPropertyDescriptor(Window.prototype, 'frameElement').get.call(window)`, the same with the
`Window.prototype` of an `about:blank` child reached as `window[0]`,
`window[Symbol.for('scramjet client global')].descriptors.get('window.frameElement', window)` and
`window[0].parent.parent`, and reports whether any of them yields the engine-host window or realm (pass: none does;
until it passes in an engine, §11.1's note and the About text apply there, `expectFail` allowed for the
`borrow-natives` case and for Scramjet's client path with the upstream report linked); A1 `r1-realm-walk` (§4.7) — an ordinary page finds no engine-host constructor
through anything GNOME installed, called normally and at the stack limit; A2 a page removes GNOME's stylesheet — only
its own page changes; A3 a page posts `gnome-blocker-config`/`-context`/`-engines` to the SW through an `about:blank`
frame — no effect (a blocked request stays blocked); A3b a UV page sets its URL to `/engine/?x` with a child realm's
native `pushState` and posts config, context, engines and `gnome-claim`, and listens for signals — nothing counts, it
receives no `uv-blocked`, and a waiting SW update is still applied; A4 a page holds `gnome-blocker-build` — the build
completes ≤ 30 s later; A5 a page searches Cache Storage and IndexedDB for site rules — finds none; A6 forged
`tab.loading.url` announcements from the engine-host realm (`test.blockerExposure`) — at most 20 newly exposed
rule-bearing sites per tab per minute, across an engine-iframe replacement too; A7 a UV page opens a WebSocket through
bare-mux directly, past the wrapper — recorded (`expectFail` allowed; About lists it if it works); A8 a UV page calls
`history.pushState(null, '', 'https://site-a.localhost/')` from site-b — `SecurityError`, the address bar and the
policy stay site-b's; A9 a page dispatches a synthetic `securitypolicyviolation` event — not counted; A10 a Scramjet
page reopens a WebSocket URL the wrapper blocked through the client's own method — still blocked.

**Cosmetic** (`blocker-cosmetic.mjs`, x2): CS1 site-specific hiding; CS2 generic hiding only with
`cosmeticAggressive`; CS3 a class added after load is hidden (GNOME's monitor); CS4 `:style()` applied; CS5 an unsafe
`:style(background: url(//cdn.localhost/beacon))` dropped — no `/beacon` hit, also spelled `URL(`; CS6 an ABP
`{style}` rule converted and applied; CS7 an invalid selector beside valid ones — the valid ones of the same
1,024-selector rule still hide (research §2.8 regression); CS8 `#@#` and `$generichide`/`$elemhide` honoured; CS9
per-site cosmetic off and an allowlisted site — nothing hidden, no scriptlets; CS10 a site-b frame inside site-a gets
site-b's rules; CS11 `set-constant` — the page reads the constant before its own scripts run, and in UV the
scriptlet sees UV's virtual `location`; CS12 `abort-on-property-read`, and `json-prune` on a fetched JSON; CS13
`trusted-set-cookie` from `cosmetic-trusted.txt` (trusted) sets the cookie, the same line in `cosmetic.txt` does
nothing, and `rpnt`/`replace-node-text` and `prevent-clipboard-write` from `cosmetic.txt` do nothing; CS14 `##body`,
`##*`, `::highlight(` and `::HIGHLIGHT(` rules dropped — the body and find-in-page highlights stay visible; CS15 the
argument vectors of §11.4 in `cosmetic-trusted.txt` (where the sanitizer keeps them) — the page's `PWNED` marker stays
unset, the arguments arrive as strings; CS16 UV: `set-cookie` and `set-local-storage-item` from `cosmetic.txt` land
in UV's virtual jar and storage (`cookies.list` shows the cookie under its site; the proxy origin's own
`document.cookie` and `localStorage`, read from the engine-host realm, are unchanged); CS17 `nowoif` stops a
click-triggered popunder in both engines (no `tab.openRequest`); CS18 R1 rule 2 in the browser: a page that replaced
`Element.prototype.getAttribute`, `Element.prototype.querySelectorAll`, `NodeList.prototype[Symbol.iterator]` and
`Array.prototype.push` with Proxies that record their trap arguments' realm, with `cosmeticAggressive` on, adds nodes
and classes — no engine-host object reaches it.

**Privacy** (`blocker-privacy.mjs`, x3): P1 `Sec-GPC: 1` and `navigator.globalPrivacyControl === true` (neither with
privacy protection off); P2 `DNT: 1` and `navigator.doNotTrack === '1'`; P3 the floor: with referrer `default`, and
with privacy protection off, a cross-origin request gets only the origin (UV sent the full URL before) and https → http
none; P4 `origin-cross-site` — cross-site requests and `document.referrer` get the origin, same-origin the full URL,
also through `Object.getOwnPropertyDescriptor(Document.prototype, 'referrer')`; P5 `none` — no `Referer`,
`document.referrer === ''`; P6 never widened — a page with `Referrer-Policy: no-referrer` still sends none; P7 a link
with `utm_source`, `fbclid`, `id` lands on `?id=1` (built-in table), a `gnome_e2e` parameter is removed by the test
list's `$removeparam`, the history entry is the clean URL, `urlparams` counted; P8 a POST form keeps its URL, a frame
document is stripped; P9 an allowlisted site keeps its parameters and still gets GPC; P10 a server that redirects back
to the tracked URL — at most 3 strips, no loop; P11 a link from site-b to allowlisted `site-a/?utm_source=x` keeps its
parameter (judged under site-a, D3, with its rules in place, D5); P12 a worker's request carries `Sec-GPC` (the
property is absent there: About).

**Cookies** (`blocker-cookies.mjs`, x3): K1 `block-third-party` — a `trk.localhost` frame's `Set-Cookie` is not
stored and its `Cookie` not sent (`cookies.list` shows none in either jar); K2 first-party cookies work in that mode;
K3 `document.cookie` in that frame — the write is ignored, the read is `''`; K3b the same through
`Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')` of the frame's realm and of the top page's realm; K4
rule `allow` for `trk.localhost` — its cookies work as third party; K5 rule `block` for site-a — first-party header and
JavaScript cookies blocked; K6 rule `session` — stored without an expiry, gone after a fresh start before the restored
tab's first request, and a sign-out's deleting `Set-Cookie` still deletes it; K7 `block-all`; K8 `all` (control); K9
cookie manager off — modes and rules ignored; K10 K1–K7 hold in Scramjet's and UV's jar, and `cookies.list` attributes
each cookie to its engine; K11 UV: `cookieStore`, `CookieStore` and `CookieStoreManager` are `undefined` in a tab
document and in an `about:blank` child (F5); K12 under `block-third-party`: a link from site-b to site-a sends and
stores site-a's own cookies, and an OAuth-style chain site-a → `idp.localhost` → `site-a/callback` keeps the session
cookie the callback sets (D3).

**App** (`shell-blocker.mjs`, x4): U1 the Extensions page shows the listing (license, size, last update, publisher),
and turning a list off changes blocking after the rebuild; U2 each of the five switches acts at once; U3 the shield's
numbers equal `tab.blocked`; U4 "Pause on this site" names and writes `*.site-a.localhost`, after Reload nothing is
blocked, "Resume" undoes it, also when the site was allowed through Settings as `site-a.localhost`; U5 the popover's
per-site switches; U6 the blocked page — text per category; for `security` only Go back (and the Settings sentence);
for `ads`, the button names its key, the confirmation shows it, and after *Confirm* the page loads (not the previous
one); Go back; no "Open in Ultraviolet" button; U7 states `building`, `ready`, `failed` (a broken list) shown in the
shield and the page with GNOME's own texts; U8 "Rebuild filter data"; U9 the cookie manager — grouped by site for both
engines, delete a cookie, a site, everything; U10 the `extensions` rows are hidden before the browser started
(`registerFeature('extensions')` not yet called) and act after it (cross-checked with N/C/P/K); U11 `cacheLimitMB` 16
with the big list on — the `over-cache-limit` text in the page and the shield; U12 `autoUpdateLists` off — no refresh
after a server change until "Update lists now"; About lists the limitations and licenses; U13 the allowlist editor
turns `example.localhost` into `*.example.localhost` (and keeps it bare with "only this host"), and the cookie-rule
editor shows the "receives all cookie rules" sentence.

### 12.3 Real sites (`blocker-sites.mjs`, x1, `--blocker-real`, needs the internet)

- **Ad-heavy**: www.speedtest.net, www.cnn.com, www.theguardian.com, www.w3schools.com (the research's ABP-style CSS
  case), www.dailymail.co.uk, www.forbes.com, www.accuweather.com, www.youtube.com (scriptlets).
- **Tracker-heavy**: www.nytimes.com, www.imdb.com, www.businessinsider.com, www.huffpost.com, www.reddit.com.
- **Controls** (little to block, must keep working): en.wikipedia.org, github.com, news.ycombinator.com,
  developer.mozilla.org.
- Per site × engine × browser: the load outcome, title, `tab.blocked` per category, page errors, a screenshot, the
  engine host's main-thread figures (`diagnostics.mainThread`), and for three sites the same with blocking off.
- Pass: every site loads as it does with blocking off (no new error overlay, a title); ≥ 6 of the 8 ad-heavy and
  ≥ 4 of the 5 tracker-heavy sites show blocks in each engine × browser; the controls show no visible breakage
  (screenshots against blocking off, reviewed by a person in the integration step); added main-thread time per page
  ≤ 10 ms median on this machine. A bot or consent wall (the research saw bot pages from imdb, forbes, dailymail,
  accuweather and nytimes in headless Chromium) is recorded as such and counted as neither pass nor block.

### 12.4 The final matrix (integration step)

| Suite | Scramjet + Chromium | Scramjet + Firefox | UV + Chromium | UV + Firefox |
| --- | --- | --- | --- | --- |
| blocker-network (libcurl; once more with epoxy) | ✓ | ✓ | ✓ | ✓ |
| blocker-uv | – | – | ✓ | ✓ |
| blocker-cache | ✓ | ✓ | ✓ | ✓ |
| blocker-attack (A0 first) | ✓ | ✓ | ✓ | ✓ |
| blocker-cosmetic | ✓ | ✓ | ✓ | ✓ |
| blocker-privacy | ✓ | ✓ | ✓ | ✓ |
| blocker-cookies | ✓ | ✓ | ✓ | ✓ |
| shell-blocker | ✓ | ✓ | ✓ | ✓ |
| blocker-sites | ✓ | ✓ | ✓ | ✓ |
| every step-2 suite (`host-*`, `shell-*`, `library-*`, `sw`, `transport`, `backend-*`, `build`) | ✓ | ✓ | ✓ | ✓ |
| the spike harness's `leak` suite (blocking adds no native construct) | ✓ | ✓ | ✓ | ✓ |

`blocker` joins `OFFERED_CAPABILITIES`, the D19 e2e switch is removed and `registerFeature('extensions')` becomes
unconditional only when every cell passes (until then e2e builds offer `blocker` through D19's switch, and production
builds keep ALLOW_ALL); `expectFail` is allowed only for rows this plan marks **[unproven]** or conditional whose
fallback About states (A0 for Scramjet's client path with the upstream report, A7, the D10 UV rewriter, D11, D16 and
the §4.4 async-tap fallbacks, V2 beyond 5 %). Budgets of §10.2 are measured in the same run (first build, cache load,
engines to the SW, per-page main-thread time, chunk sizes, both browsers) and, if a Raspberry Pi 4 is available,
there.

## 13. Integration order

1. **Preconditions**: step 2's integration step has finished; finding F1 is fixed (step 2 did, §4.7) and F2–F6 are
   either fixed by step 2 or assigned to x1's first tasks (§11.2); re-read `src/shared/**`, `src/engine-host/{core,
   tabs,popups,webrtc,realm,natives,hooks,nav-machine}.ts`, `src/engine-host/observe/commits.ts` and `src/sw/sw.ts`
   against §3 and §4; the orchestrator has added D1, D5, D6, D17, D19 and the F-findings to PROGRESS (§14).
2. **Day one, all five lanes in parallel**: x1 — C1–C12 with their tests and the whole-tree check, the core of §3.2
   (with `detail.ts`), the kit additions and `withPageAssignments`, row A1 (first version) and A0, the pins, the D19
   switch, then the open F-items; x5 — file lists, the fixture server, the runner's TOML and the big list; x2 —
   `sanitize.ts` (with `trustOnlyScriptlets`), `selectors.ts`; x3 — the parameter table, the DOM-free providers
   (`reduceReferrer`), `freshStartCookieDeletes`; x4 — `lists.ts`, `exposure.ts`, `key.ts`, stats, the code texts, the
   editors' host rule, and the UI against the extended fake engine host. Lanes x2–x4 import x1's new modules only
   once x1 reports them landed (§0).
3. **x1, Scramjet**: Worker build, cache, window-side engines (dynamic import) with `scriptletCall`, the network
   provider, `BlockedCounts`, status/stats/reload, the `tab.loading.url` emission and the announcement wait (with the
   async-tap spike); N-, S-, A-rows on Scramjet (they need x5 and x2's sanitizer).
4. **x1, Ultraviolet**: the SW blocker (engine-host registration, engines by message, the context and its waits,
   the blocked page), the `__uvHook` document point, the UV WebSocket wrapper's new fields, the D16 spike; N-, V-, S-,
   A-rows on UV.
5. **x2 wired** (x1 adds the import to `host/providers.ts`): CS-rows on both engines.
6. **x3 wired** (`host/providers.ts`, `sw/providers.ts`): P- and K-rows on both engines.
7. **x4 on the real engine host** (from step 3 on, through D19's switch): the snapshot with lists and scoped maps,
   `blockerKey` and its rotation, the answering snapshots, the fresh-start deletes, the shield, the blocked page, the
   Extensions page; U-rows.
8. **Integration step**: the matrix of §12.4, the real sites, the leak suite, the budgets; `OFFERED_CAPABILITIES +=
   'blocker'`; the D19 switch removed and `registerFeature('extensions')` unconditional; the documents of §14; then
   an independent review (security and completeness) and its fixes.

## 14. Documentation the integration step updates

- **ARCHITECTURE**: §3 (the `src/extensions/**` tree of §2); §5.5 rewritten from D1–D19 (groups and toggles,
  precedence and the tab's own document, cookie rules and unknown context, scoped site rules and their budget, the
  MAC'd cache and key rotation, fail open, the Worker, list integrity, resources, scriptlets and GNOME's assembly, the
  engine configuration, parameter stripping, the UV context and engines by message, WebSockets, the capability gate)
  with the measured budgets; §5.4's service-worker paragraph (its runtime input now includes the UV context, the
  engines and engine-host registration by client id); §4.2's `GNOME_FILTER_LISTS_FILE` row (x5 writes it); §5.3: no
  key changes, but the `cacheLimitMB` comment becomes "cap on the content blocker's cached filter data (Cache Storage,
  proxy origin)", as in `settings/schema.ts`.
- **ENGINE-PROTOCOL**: §1.1's table (the results of rows A0 and A3b: which "ordinary page: no" claims hold in which
  engine and browser); §1.2 rule 4 (scoped maps, `cookieRules` whole, `blockerKey`) and the realm-hygiene rule R1 with
  its three directions as a new §1.2 rule; §4 (`InitPayload.blockerKey`, `EngineSettings.extensions.cacheLimitMB`,
  `blocker.stats` and `blocker.reload` back in, with why; `EngineDiagnostics.blocker`; the detail and error codes);
  §5 (`tab.loading.url`, its answer and throttle, `tab.blocked.total` including `direct-connection`); §6.17 rewritten
  (the composition, `topLevelUrl` of a tab's own document, resources in the verdict for subresources only,
  `documentUrl`/`referrer`, `ResponseHeaders.append`, the SW messages, UV `onDocument` after UV's client); §7 (what
  step 3 proved); §8 a "Wave B step 3" list of changes. `shared/engine-hooks.ts`' header comment follows (x1 changes
  it with C6).
- **API.md**: file lists (x5).
- **About** (x4), known limitations: no procedural selectors, HTML filtering, `$csp`, `$popup`, `$urlskip`,
  `$header`, `$cookie`/`$removeheader`, regex `$removeparam`; tracking parameters are removed from pages you open, not
  from requests inside them; cookies on WebSocket connections are not controlled; third-party storage is not
  partitioned; workers and `about:blank` frames get the `Sec-GPC` header but no `navigator.globalPrivacyControl`;
  requests whose page the service worker cannot tell are treated as third-party under the global settings; whatever
  the A0/A7/D10/D11/D16/§4.4 rows leave as fallbacks (for instance "WebSocket blocking in Scramjet pages ignores
  per-site settings", "the first page of a site reached by a link may be judged without its site rules"); while A0
  fails in an engine: "a site that targets GNOME can turn blocking off and read the site rules of the sites you have
  open"; always: a site that breaks out of its proxy engine can turn blocking off and read the site rules of open
  sites and all cookie rules; the measured first-build time.
- **PROGRESS**: the decisions-log rows marked (log) in §1 (D1, D5, D6, D17, D19) and the findings F1–F6 of §11.2
  under the Wave B inputs (with their owners) where the orchestrator did not already add them when step 3 started,
  each finding's final state, and the upstream reports (Ghostery: JSON-encode scriptlet arguments,
  enforce `requiresTrust`; Scramjet: hide the client global); the Phase 4 item "Extension architecture + built-ins".
- **WAVE-B.md** §9: a pointer to this document. **backend/README.md**: the registry's file lists (x5).

## 15. What this plan leaves open

| # | Open point | Why it is open | Who settles it |
| --- | --- | --- | --- |
| O1 | The per-document WebSocket hook in Scramjet (D16) | the creation point inside Scramjet 2.0.67-alpha.2's client was located only by the research's source reading | x1's spike (§4.6); the fallback is stated |
| O2 | How often UV requests are judged with unknown context, and UV tab-top typing where the Navigation API is missing (D15) | depends on message ordering between the engine host and the SW, and on the 20/50/150 ms waits | rows V2, V4–V9 |
| O3 | Ordinary pages and Cache Storage / `navigator.locks` | answered by code reading (2026-11-12): UV 3.2.10 hooks none of `caches`, `CacheStorage`, `indexedDB`, `navigator.locks`; Scramjet prefixes `CacheStorage` `open`/`has`/`match`/`delete` with the site but not `keys()`, and leaves `navigator.locks` alone. The design (MAC with K binding, lock cap, key rotation) assumes pages reach both | rows S2, S8, A4, A5 confirm it in the browsers |
| O4 | Scriptlets inside both engines' frames, through `kit.run` after the engine's client (D11) | **[unproven]** (research §6.5); for UV it also depends on the `__uvHook` point (O12) | rows CS11–CS17 |
| O5 | That GNOME's per-realm `Document.prototype.cookie`/`referrer` wrappers and `navigator.*` data properties hold against the engines' own hooks | the engines install their hooks first; GNOME wraps theirs | rows K3, K3b, P1, P4, P5 |
| O6 | Scramjet rewriting the `Location` of an `earlyResponse` 307 | read in `scramjet.js`, not run | rows P7, P8; fallback in §4.4 |
| O7 | Raspberry Pi 4 numbers | no Pi 4 here; §10.2 is an estimate from the measured desktop figures | the integration step |
| O8 | F2–F6 (§11.2) | step 2's integration was not running yet when this plan was revised (its engine-host review was) | step 2's integration step, else x1 first |
| O9 | `*.localhost` through the TEST-ONLY HolyWisp (`::1`) | not tried | x5's fixture server; fallback `127.0.0.2`–`127.0.0.9` |
| O10 | The exact Scramjet request fields for `documentUrl` (`parsed.clientUrl`, `request.rawReferrer`) | from the research's reading of the Scramjet repository at 517206bc; the completeness review found both names in the npm `scramjet.js` | x1 (§4.4) |
| O11 | Whether an ordinary page reaches the engine-host realm (F2) | **measured yes** by step 2 (`host-attack borrow-natives`, both engines and browsers, no engine bug needed); the UV `frameElement` and Scramjet client paths are code reading only | row A0 records it; closing it needs engine-level virtualization of fresh realms or per-site sub-origins |
| O12 | UV's `self.__uvHook = …` assignment as the "after UV's client, before page scripts" point | read in `uv.handler.js` 3.2.10, not run | rows CS11, CS16, K3; fallback: scriptlets off in UV (About) |
| O13 | UV's JS rewriter for `$redirect` script resources (`ctx.ultraviolet.js.rewrite`) | read in `uv.sw.js`, not run | row N6 in UV; fallback: plain block |
| O14 | Whether Scramjet awaits an async `fetch.request` tap (§4.4 announcement wait) | read in Scramjet's source map by the completeness review, not run | x1's spike with D16; rows N17, P11 |
| O15 | Engine-host registration in the SW after a restart, and Firefox's `Client.url` after `pushState` (F3) | not run | row A3b in both browsers |

Deliberately not in v1 (each in About): procedural (extended) selectors, HTML filtering, `$csp` emulation, popup
blocking from `$popup`, `$urlskip` and ClearURLs redirections, subresource `$removeparam`, a one-time "proceed" on a
blocked page, third-party storage partitioning, user-written custom filters (the schema has no key for them).
