# GNOME end-to-end harnesses

`tests/e2e/` holds browser-driven harnesses that run against real engine, transport and HolyWisp builds.
[playwright-core](https://playwright.dev) drives the cached Playwright browsers; nothing here is a unit test.

| Harness | Purpose | Report |
| --- | --- | --- |
| `spike-engine-host/` | Wave B de-risking spike: the two-origin engine host (ARCHITECTURE §4.6, §5.4). The app origin embeds `<proxy origin>/engine/` in a sandboxed cross-origin iframe; the engine host runs Scramjet + Ultraviolet behind one service worker over a real HolyWisp. | `docs/research/spike-engine-host.md` (the `attack` suite: its §11) |
| `about/about-qa.mjs`, `settings/settings-qa.mjs` | Frontend page QA (About, Settings) against a running gnome-server: screenshots plus structural and behaviour checks. Usage and environment: the header comment of each script | – |
| `settings/settings-features-qa.mjs` | Settings rows of features a build may not include yet (filter lists, VPN locations, custom Wisp servers, game categories): run against the Vite dev server (`frontend/`, `npx vite --port <p>` with `GNOME_DEV_BACKEND` pointing at gnome-server), which can register those features in the page. Usage: the header comment | – |
| `stack/stack-qa.mjs` | The real two-origin stack without a browser: gnome-server (app + proxy listener) with HolyWisp behind it. Route sets and security headers per role, CSRF, host-only cookies, `/api/config`, minimal proxy-origin `/api/health`, VPN locations, Wisp tickets through `/wisp/` in all three URL forms (real HTTPS fetch inside the stream), refusals before the upgrade, the ticket probe, filter lists with ETag/304 on both roles, admin diagnostics. Usage: the header comment | – |
| `stack/engine-on-gnome-server.mjs` | The `spike-engine-host` app stub and engine host served by a real gnome-server (`prepare` builds the `GNOME_STATIC_DIR`): both engines × four transports × the ticket URL forms against the real gateway and HolyWisp, the engine host's probe and Origin, in Chromium and Firefox; also the way to try a `GNOME_PROXY_CSP`. Usage: the header comment | – |

## Requirements

- Node ≥ 22.12 (`package.json` engines); verified with Node 26.13. The target server relies on
  `http.createServer({ shouldUpgradeCallback })`, which older Node releases ignore.
- The Playwright browser builds pinned by `playwright-core` 1.64.0 in `~/.cache/ms-playwright`:
  `chromium-1248` (Chromium 156, used through `channel: 'chromium'`, the new headless mode) and `firefox-1555`
  (Firefox 157). Install them with `npx playwright-core install chromium firefox` if missing, or point
  `CHROMIUM_EXECUTABLE` / `FIREFOX_EXECUTABLE` at other builds.
- HolyWisp: the static binary from `services/holywisp/fetch-build.sh`
  (`services/holywisp/build/<arch>/holywisp`), run inside a locked-down, unprivileged container (`--network host
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534`). Docker is required unless
  `HOLYWISP_RUNNER=host`.
- Network access for the real-site checks (example.com, Wikipedia, GitHub, httpbin.org, public WebSocket echo
  services). `--offline` skips them; everything else runs against the local target server.

## Install

```sh
cd tests/e2e
npm ci            # lifecycle scripts are disabled (.npmrc ignore-scripts=true); no package needs them
```

## Run

```sh
cd tests/e2e
node spike-engine-host/run.mjs                                   # every suite except smoke and attack, Chromium then Firefox
node spike-engine-host/run.mjs --only smoke                      # 5-second end-to-end check of the whole stack
node spike-engine-host/run.mjs --only sw,nav,input --parallel    # Chromium and Firefox at the same time
node spike-engine-host/run.mjs --browser firefox --only nav --offline
```

| Flag | Meaning |
| --- | --- |
| `--browser chromium\|firefox\|all` | Browsers to run (comma-separated list allowed). Default: all |
| `--only a,b` / `--skip a,b` | Suites to run / to leave out (see the table below) |
| `--offline` | Skip checks that need the internet (suites that support it) |
| `--strict` | Exit code 1 if a check failed that is not marked as a documented upstream failure (`expectFail`) |
| `--parallel` | Run the browsers concurrently against the same servers, but only for the parallel-safe suites (`smoke`, `sw`, `nav`, `input`; roughly halves their wall time). The other suites then run one browser at a time: `transport` and `leak` (part `hostcsp`) kill and restart the shared proxy server, `fallback`, `isolation`, `leak` and `attack` judge results from shared server logs (target requests, app API requests, sentinel, CSP reports) that the other browser's traffic would pollute, and `perf` measures timings |

Every run starts two HolyWisp instances (production config + test-only overlay), the app / proxy / target servers and
the leak sentinel, writes `results.json`, `results.md`, `events.json` and the HolyWisp logs to
`<SPIKE_RESULTS_DIR>/<timestamp>/`, and stops everything it started (also on Ctrl+C). It ends with
`all harness ports are free again` or names the ports still in use.

### Suites (`spike-engine-host/suites/`)

| Suite | Item | Parallel-safe | What it verifies |
| --- | --- | --- | --- |
| `smoke` | – | yes | example.com through both engines (not in the default list) |
| `sw` | 1 | yes | The prototype is really two-origin and sandboxed; the Wisp gateway stub enforces ticket + `Origin`; SW registration/control, IndexedDB and Cache Storage inside the sandboxed cross-origin iframe; Scramjet cookie jar and UV `__op` persistence across an app reload and a forced reload (Chromium); stale Scramjet prefixes get the SW's `503 stale-prefix`; storage partitioning on (same-site embed works; the cross-site embed is the control that partitioning is really active); SW lifecycle while an engine host runs: a stopped SW restarts and held Scramjet requests are routed (Chromium), an updated `/sw.js` waits instead of taking over and applies at the next app reload |
| `nav` | 2 | yes | example.com, Wikipedia, GitHub, httpbin cookie round trip / redirect chain / form POST, public WebSocket echo, find on Wikipedia; locally: redirect chain, form POST body, WebSocket echo, title/favicon events, back/forward/reload, joint session history, downloads (link and navigation) with engine-host progress events, keep-alive reuse after idle per transport |
| `input` | 7 | yes | Keyboard shortcuts forwarded from nested proxied frames (same-site and cross-site children), context-menu requests with coordinates, fullscreen from nested frames, find-in-page across the tab's same-origin proxied documents |
| `transport` | 5 | no | Wisp ticket URL forms against the stub's strict parser (identical to the session-4 `backend/src/gateway` `ticket_param`) and reconnect behaviour of the four transports; the recovery recipe (drop, gateway kill + restart, ticket rotation, proactive and lazy renewal); a negative control with the session-3 gateway probe order |
| `fallback` | 6 | no | Scramjet → Ultraviolet controlled fallback (one retry, same destination, cookies copied incl. HttpOnly), detection signals and their latency; a failed POST navigation is never re-sent on UV |
| `isolation` | 3 | no | A proxied page cannot reach the app origin's storage, API or top-level window; what it shares on the proxy origin; WebRTC egress |
| `leak` | 4 | no | Requests that bypass the engines (sentinel), root cause, GNOME CSP as mitigation (every construct that leaks with the CSP off must be reported blocked with it on); parts `lab,probe,rootcause,sites,bypass,hostcsp,cspbus` (`SPIKE_LEAK_PARTS`; `cspbus`: a forged SW config from an ordinary proxied page must not switch the UV CSP off) |
| `perf` | 8 | no | Init and page-load times, memory and main-thread blocking per engine × transport × browser |
| `attack` | – | no | Adversarial isolation review by the proxy:spike-attack lane (not in the default list; parts and knobs: header of `suites/attack.mjs`) |

Reading results: `expectFail` rows document upstream or browser behaviour (for example the epoxy keep-alive hang) and do
not fail `--strict`. The isolation suite's `reach:webrtc-from-page` rows fail on purpose: WebRTC reaches the network
directly from proxied pages until the engine host has a WebRTC kill switch, so a run with `--strict` exits 1 today.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPIKE_APP_PORT` | `22080` | App origin `http://127.0.0.1:<port>` (shell stub + API stub) |
| `SPIKE_PROXY_PORT` | `22081` | Proxy origin (engine host, `/sw.js`, `/vendor/**`, `/wisp/` gateway stub) |
| `SPIKE_TARGET_PORT` | `22090` | Local test site; reachable from the browsers only through the TEST-ONLY HolyWisp |
| `SPIKE_SENTINEL_PORT` | `22099` | Leak sentinel: the browsers' HTTP proxy for every non-loopback host; never forwards |
| `SPIKE_HOLYWISP_PORT` | `22060` | HolyWisp with `services/holywisp/gnome.conf` (only `--port` changed), behind `/wisp/` |
| `SPIKE_HOLYWISP_TEST_PORT` | `22061` | HolyWisp with `gnome.conf` + `holywisp-test-only.conf` (allow-loopback), behind `/wisp/p/test-loopback/` |
| `SPIKE_STUN_PORT` | sentinel − 1 | UDP port of the leak suite's STUN probe |
| `SPIKE_RESULTS_DIR` | `spike-engine-host/results` | Where run directories are written (git-ignored) |
| `HOLYWISP_BIN` | `services/holywisp/build/<arch>/holywisp` | HolyWisp binary (mounted read-only into the container) |
| `HOLYWISP_IMAGE` | – | Use the packaged image (`services/holywisp/Dockerfile`) instead of `HOLYWISP_BIN` |
| `HOLYWISP_RUNNER` | `docker` | `docker`, or `host` for CI machines without Docker (runs the binary directly) |
| `CHROMIUM_EXECUTABLE` / `FIREFOX_EXECUTABLE` | – | Browser binaries other than the cached Playwright builds |
| `SPIKE_CHROMIUM_CHANNEL` | `chromium` | `chromium` = full Chromium build in new headless mode; anything else = Playwright's headless shell |
| `SPIKE_FRAME_ANCESTORS` | app origins | `frame-ancestors` sources of the proxy origin |
| `SPIKE_TICKETS` | the fixed test ticket | JSON array of tickets the gateway stub accepts |
| `SPIKE_GATEWAY_STRICT` | `1` | Ticket parsing of the gateway stub. Default: exactly like the session-4 `backend/src/gateway` `ticket_param` (first `t=` pair of the raw query, one trailing `/` stripped, percent-decoded, two `t=` pairs refused; canonical form `?t=<ticket>&/`). `0`: the old lenient `URLSearchParams` parse |
| `SPIKE_GATEWAY_PROBE` | `stub` | Plain `GET` of a Wisp route (the engine host's ticket probe). `stub` = the Rust gateway since session 4: `401` for a missing/invalid ticket, `426` for a valid one, no `Origin` check. `legacy` (alias `rust`) = the session-3 order, `426` to every plain GET |
| `SPIKE_ENGINE_HOST_CSP` | – | Extra CSP directives for the engine-host document `/engine/` (appended to its `frame-ancestors`); the leak suite's `hostcsp` part sets it and restarts the proxy server |
| `SPIKE_ISO_ENGINES`, `SPIKE_LEAK_PARTS`, `SPIKE_LEAK_SITES`, `SPIKE_LEAK_MODES`, `SPIKE_LEAK_ENGINES` | all | Narrow the isolation / leak suites (see the suite headers). Leak defaults: parts `lab,probe,sites,rootcause,bypass,hostcsp,cspbus`, sites `wikipedia,github,hn,mdn,rust,python,npm,bbc`, modes `off,enforce` (`report-only` also works), engines `scramjet,ultraviolet` |
| `SPIKE_ATTACK_PARTS`, `SPIKE_ATTACK_ENGINES` | all | Narrow the `attack` suite (header of `suites/attack.mjs`) |
| `SPIKE_PERF_RUNS` / `SPIKE_PERF_REPEAT` | `5` / `2` | Loads per site / fresh-browser repetitions in the perf suite |
| `SPIKE_TRACE`, `SPIKE_VERBOSE` | – | Extra logging (transport suite; standalone server runs) |
| `SPIKE_RUN_DIR` | set by `run.mjs` | The current run's output directory (servers and HolyWisp logs write there); not meant to be set by hand |

Parallel runs on one machine need distinct `SPIKE_*_PORT` values and `SPIKE_RESULTS_DIR`s; HolyWisp containers are
named per process (`gnome-e2e-holywisp-<kind>-<pid>`), so they never collide.

## App query parameters (engine settings for one run)

The app stub (`web/app/app.js`) turns its query string into the engine host's `init` settings, so a suite can open
`http://127.0.0.1:22080/?route=test&uvt=libcurl` and so on:
`route=test` (Wisp route `/wisp/p/test-loopback/`), `engine=auto|scramjet|ultraviolet`, `sjt=libcurl|epoxy`,
`uvt=epoxy|libcurl`, `ticketForm=query+amp-slash|auto|query|query+slash` (default `query+amp-slash`, i.e.
`?t=<ticket>&/` for every transport), `fallback=0|1`, `watchdog=0|1`, `bodyFix=0|1`, `navTimeout=<ms>`,
`csp=off|enforce|report-only`, `cspPolicy=<policy>`, `fault=sj-wasm-missing|sj-transport-dead|sj-throw-marker`,
`swConfigBus=1` (the SW also accepts its config from the `gnome-engine` BroadcastChannel, which any proxied page can
join: the session-3 behaviour, for attack tests only; by default the SW takes its config only from the engine host's
`postMessage`, checked by client URL). Runtime-only engine-host settings (sent with the `settings` command, not the
query): `lazyRenew`, `dropProbe`.

## Known harness behaviour

- **Firefox frame reads:** with playwright-core 1.64 and Firefox 157, `frame.evaluate()` on a tab iframe can stay
  pending forever after a GNOME `location.replace()` navigation (a tab reused for a second page). `lib/drive.mjs` gives
  every frame read (`readOut`, `bodyText`, `waitTabFrame`) an 8 s deadline (`FRAME_EVAL_MS`), so a stuck read becomes a
  failed check instead of a stalled suite; the transport and fallback suites never read tab frames and judge content
  from the target's request log and validated `tab.title` events.
- **Gateway stub, not gnome-server:** the `/wisp/` stub in `servers/proxy.mjs` copies the gateway's ticket parsing and
  probe order (see `SPIKE_GATEWAY_*`); caps, rate limits and session revocation of the real gateway are not exercised.
- **Real sites change:** rows against Wikipedia, GitHub, httpbin and the leak suite's sites depend on live content
  (bot checks, A/B variants); a run on a loaded machine is slower but should not change pass/fail.

## Safety

- Third-party code (engines, transports) is only served to the browsers; HolyWisp runs in an unprivileged container.
  Nothing runs privileged and nothing changes host kernel state.
- `holywisp-test-only.conf` (allow-loopback) is a TEST-ONLY overlay; `services/holywisp/gnome.conf` is never modified.
- The browsers reach the internet only through Wisp: every non-loopback request goes to the leak sentinel, which
  refuses it and records it.
