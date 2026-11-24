# Wave B e2e runner (`tests/e2e/engine/`)

End-to-end suites of Wave B (docs/WAVE-B.md §0, §3) against the **real** stack: gnome-server in two-origin mode on
loopback serving an `npm run build:e2e` build, HolyWisp behind it, in Chromium and Firefox (the cached chromium-1248 and
firefox-1555 through playwright-core 1.64.0 from `tests/e2e/node_modules`).

```sh
cd tests/e2e && npm ci                     # once (lifecycle scripts are disabled)
CARGO_TARGET_DIR=~/.cache/gnome-targets/wb-e2e node engine/run.mjs --build-server   # first run: builds gnome-server
node engine/run.mjs                        # every suite, Chromium then Firefox
node engine/run.mjs --only sw,transport --browser firefox
node engine/run.mjs --only host-nav --parts spa,downloads --no-build   # reuse the last build
```

| Flag | Meaning |
| --- | --- |
| `--browser chromium\|firefox\|all` | browsers (comma list allowed); default all, in that order |
| `--only a,b` / `--skip a,b` | suites (file names in `suites/` without `.mjs`; `*-lib.mjs` files are helpers, never suites) |
| `--parts x,y` | passed to the suites as `ctx.parts` (each suite documents its parts in its header) |
| `--no-build` / `--dist <dir>` | reuse an existing build / build into (or reuse) this directory |
| `--build-server` | `cargo build --release -p gnome-server` first (`CARGO_BUILD_JOBS` defaults to 3) |
| `--offline` | `ctx.offline = true`: suites skip rows that need the internet; `ubo-resources` from the pinned `fixtures/blocker/lists/ubo-resources.json` |
| `--blocker-real` | the server keeps its built-in filter lists (internet, WAVE-B3 §12.3) instead of the test lists; `ctx.blockerReal` |
| `--strict` | exit 1 when a row failed that is not `expectFail` |

What a run starts (all on 127.0.0.1, every port from the environment, see below): HolyWisp with a copy of
`services/holywisp/gnome.conf` for the direct route; a second HolyWisp (gnome.conf + the spike's TEST-ONLY
allow-loopback overlay) behind the VPN profile `e2e-vpn`; a profile `e2e-dead` whose upstream never runs;
gnome-server (`serve`, app + proxy + admin listeners, fresh data dir under the run directory); the spike's local
target site (`spike-engine-host/servers/target.mjs`, reachable only through `/wisp/p/e2e-vpn/`) and leak sentinel
(the browsers' proxy for every non-loopback host, so pages reach the internet only through Wisp); the content-blocker
fixture server (`servers/blocker-fixtures.mjs`, reachable only through `/wisp/p/e2e-vpn/`) and a per-run
`GNOME_FILTER_LISTS_FILE` (`lib/blocker.mjs`): built-in lists off, the lanes' `fixtures/blocker/lists/*.txt`, the
generated big list and `ubo-resources`. After the server starts it waits up to 120 s (300 s with `--blocker-real`)
for the lists. It stops all of it at the end (also on Ctrl+C) and prints `all runner ports are free again`. At the
end of a run the runner removes the big list's copies from the run directory (about 28 MB; `lib/blocker.mjs`
`bigListText()` regenerates them byte for byte). The check after the build applies Wave B step 3's import rules
(`lib/build-check.mjs` `STEP3_ENGINE_ALLOWED` and `STEP3_APP_FORBIDDEN`, the same lists `suites/build.mjs` uses) and
prints the first problems. Every build offers the `blocker` capability (WAVE-B3 D19's build-time switch
`GNOME_ENGINE_TEST_CAPABILITIES` was removed by the step-3 integration).

Output: `<E2E_RESULTS_DIR>/<timestamp>/results.md` and `results.json` (default `tests/e2e/engine/results/`), the
server and HolyWisp logs; the build goes to `<E2E_RESULTS_DIR>/dist` (or `E2E_DIST_DIR`, `--dist`).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `E2E_PORT_BASE` | 27500 | moves **every** port of a run (`lib/ports.mjs`). The stack: app = base, proxy +1, admin +2, HolyWisp direct +10, HolyWisp VPN +11, dead profile +12 (never bound), sentinel +20, target +30, the `sw` suite's realm fixtures +40 (`servers/realm-fixtures.mjs`, started by that suite only) (each also `E2E_<NAME>_PORT`) |
| `E2E_STANDALONE_PORT_BASE` | `E2E_PORT_BASE` + 100 | port block (+0..+99) of the standalone suites (below) |
| `HOST_E2E_PORT_BASE` | `E2E_PORT_BASE` + 200 | `host-lib.mjs` fixtures: fixture site +0, leak listener +1, STUN sink +2 |
| `SHELL_E2E_PORT_BASE` | `E2E_PORT_BASE` + 210 | `shell-lib.mjs` servers (`shell-activation`'s static sites +1, +2) |
| `LIBRARY_E2E_PORT_BASE` | `E2E_PORT_BASE` + 220 | `library-lib.mjs`'s own stack: app +0, proxy +1, HolyWisp +4 |
| `BACKEND_E2E_PORT_BASE` | `E2E_STANDALONE_PORT_BASE` | `backend-lib.mjs` (the runner sets it for its standalone children) |
| `E2E_RESULTS_DIR`, `E2E_DIST_DIR` | `engine/results/`, `<results>/dist` | output; keep large outputs off `/tmp`. `backend-lib.mjs` suites run inside the runner put their scratch copies in `<E2E_RESULTS_DIR>/backend` (or `BACKEND_E2E_DIR`) |
| `GNOME_SERVER_BIN` / `CARGO_TARGET_DIR` | `$CARGO_TARGET_DIR/release/gnome-server` | the server binary |
| `HOLYWISP_RUNNER` | `host` | `host` (static binary as this user) or `docker` (the spike's locked-down, unprivileged container) |
| `HOLYWISP_BIN` | `services/holywisp/build/<arch>/holywisp` | |
| `CHROMIUM_EXECUTABLE`, `FIREFOX_EXECUTABLE` | the Playwright cache | other browser builds |
| `E2E_BLOCKER_PORT` | `E2E_PORT_BASE` + 50 | the content-blocker fixture server (`servers/blocker-fixtures.mjs`) |
| `E2E_BLOCKER_FIXTURES_DIR`, `E2E_BLOCKER_LISTS_DIR` | `fixtures/blocker`, `fixtures/blocker/lists` | its pages and the test lists |
| `E2E_BLOCKER_TRANSPORT` | `libcurl` | `epoxy`: `blocker-network` and `blocker-uv` open their driver pages with the epoxy transport (WAVE-B3 §12.4 "once more with epoxy"); every row records it |
| `TMPDIR` | the system's | Playwright puts browser profiles under `os.tmpdir()`: point it off a RAM `/tmp` for long runs |

## Wave D suites

| Suite | Switch | Needs | What |
| --- | --- | --- | --- |
| `cookie-flood.mjs` (+ `flood-lib.mjs`), standalone | `GNOME_E2E_FLOOD=1` (otherwise one skip row) | the release `gnome-server`, both browsers | CF1–CF4, CF9: a proxied page plants cookies for the app; the app keeps working on two ports and behind a Node HTTPS front with a 4 MiB head limit. CF5–CF8 are not written |
| `build-release.mjs`, standalone | – (run it directly: `node tests/e2e/engine/suites/build-release.mjs [--dist <release dist>]`) | Node, a release build | BR1–BR8: postbuild's siblings, manifests, notices, no vendor maps; BR9 skipped |
| `backend-proxy.mjs` part `oversized` | – | – | the Wave D head limits (431 over the connection's cap) |

The deploy suites of WAVE-D §5.8 (`deploy-*.mjs`, `GNOME_E2E_DEPLOY=1`) are not written yet; `deployment/check.sh`,
`deployment/tests/*.sh` and a shell smoke of the compose stack stand in.

## Writing a suite

One file per suite in `suites/`, named after the owning lane (`host-*` lane a, `sw`/`transport`/`build` lane b,
`shell-*` c, `library-*` d, `backend-*` e). It exports one function; the runner calls it once per browser:

```js
// tests/e2e/engine/suites/host-example.mjs
export async function run(ctx) {
  const browser = await ctx.launch();                 // the suite closes what it launches
  try {
    const context = await ctx.newContext(browser);
    const app = await ctx.openApp(context, { engine: 'scramjet', transport: 'libcurl' });
    const r = await app.navigate(1, 'https://example.com/', { create: true });
    ctx.record({ test: 'example.com loads', result: r.ok ? 'pass' : 'fail', engine: r.engine, transport: 'libcurl', notes: r.title ?? '' });
    await app.close();
  } finally {
    await browser.close();
  }
}
```

`ctx` (WAVE-B §3; members are only ever added):

| Member | |
| --- | --- |
| `browser` | `'chromium'` or `'firefox'`; `firstBrowser`: the first of the run (browser-independent checks run once) |
| `suite`, `runDir` | suite name; this run's output directory (write extra artefacts there) |
| `launch(opts?)` | a playwright-core `Browser` (`opts`: `extraPrefs` for Firefox, `extraArgs` for Chromium, `sentinelProxy: false`) |
| `newContext(browser, opts?)` | a `BrowserContext` (1280×860, downloads accepted) |
| `openApp(context, query?)` | opens the **e2e driver page** (`<app origin>/e2e-driver/`) and waits for `init`; returns an `App` |
| `record({test, result, engine?, transport?, notes?, expectFail?, data?})` | one result row; `result` is `pass`, `fail` or `skip` |
| `log(...)`, `sleep(ms)` | |
| `parts`, `offline`, `blockerReal` | `--parts` list (null = all), `--offline` and `--blocker-real` |
| `records` | every row recorded so far in this run |
| `build` | `{problems, buildId, engineHost, built}` of this run's build; `engineHost`: whether `engine/index.html` was built |
| `contract` | the exports of `src/shared/proxy-origin.ts` and `engine-protocol.ts` (+ `transport`: `transport.ts`), loaded with Vite |
| `stack` | see below |

`ctx.stack`: `appOrigin`, `proxyOrigin`, `appOrigins`, `adminOrigin` (= `admin`), `staticDir` (the build gnome-server
serves), `profiles` (`{live: 'e2e-vpn', dead: 'e2e-dead'}`), `deadProfile`, `target` (`{origin, altOrigin}` of the
local site; reach it with the driver's `route: 'profile:e2e-vpn'`), `sentinel` (`{origin, since(t)}`: direct requests
that reached it), `serverLog()`, `restartServer(env?)` (restart gnome-server with extra variables, e.g.
`{GNOME_ACCESS_MODE: 'code', GNOME_ACCESS_CODE: '1234'}`; `{}` restores the defaults; the data directory and so the
sessions survive), `upstream(name)` → `{stop(), start()}` for `'direct'` or `'e2e-vpn'`, and `blocker` (Wave B step 3):
`{mode 'test'|'real', offline, port, fixtures: {requests({since, label, path, method}), beacons({label, id}),
ws({since}), mark(), reset()}, labels, hosts, origin(label), url(label, path), toml, listsDir, lists: [{id, name,
category, trusted, default, maxMb, file, source}], expect, ready: {ok, ms, listing, missing, unavailable, unexpected},
listing(), waitForLists(opts), writeList(id, text), refreshLists({ids, via: 'cli'|'admin'})}`. Fixture URLs:
`http://<label>.localhost:<E2E_BLOCKER_PORT>/<lane>/<path>` (labels `site-a site-b ads trk cdn bad docblock idp`;
endpoints `/`, `/echo`, `/set-cookie`, `/cookies`, `/ws`, `/beacon`, `/redirect`, `/policy`); reach them only with
the route `profile:e2e-vpn`. The big list's id is `big` (default off; S4, V10 and U11 turn it on). A test list's
first line: `! gnome-e2e: id=<id> category=<ads|privacy|annoyances|cookies|urlparams|security> trusted=<bool>
default=<bool> [name=<text>] [max_mb=<1-64>]`.

### The driver page and `App`

The driver (`lib/driver/driver.ts`, built into `<dist>/e2e-driver/`) is a minimal app-side engine client: it embeds
the real `<proxy origin>/engine/` with the sandbox and `allow` of ENGINE-PROTOCOL §2.1, runs the handshake with
`decideHello`, mints real tickets (`POST /api/wisp/ticket`, `ticketExpiresAtLocal`, deferred and coalesced within
1 per 2 s and 10 per minute), answers `needTicket`, and validates every result (`validateResultMessage` +
`validateCommandResult`) and event (`validateEventMessage`). It is not GNOME's browser UI (lane c's suites drive the
real app at `/`). Query keys of `openApp(context, query)`: `engine` (`auto`|`scramjet`|`ultraviolet`), `transport`
(`libcurl`|`epoxy`), `route` (`default`|`profile:<id>`|`custom:<url,url>`), `fallback` (`0`|`1`), `webrtc`
(`block`|`allow`), `ticket=0` (init without a ticket), `autoTicket=0` (the suite answers `needTicket` itself),
`engines` (offered engines), `combos` (forwarded shortcuts), `blockerKey=<64 lower-case hex>` (→ `init.blockerKey`),
`clearSiteData=1` / `clearCookies=1` (→ `init.clearOnStart`).

`App` keeps the spike's API (`spike-engine-host/lib/drive.mjs`): `waitInit()`, `cmd(type, payload, timeout?)` (a raw
protocol command), `mark()`, `eventsSince(seq)`, `waitFor(since, pred, timeout)` (events are `{seq, t, type, p}`),
`gnome(fn, arg)` (evaluate in the driver page: `window.gnomeTest` has `events`, `rejected` (invalid events/results),
`hellos`, `tickets`, `ticketRequests`, `renewNow()`, `sendTicket(value)`, `applySettings(patch)`, `replaceIframe()`),
`engineFrame()`, `tabFrame(tabId)` / `waitTabFrame(tabId, pred)` (the tab iframe named `tab-<tabId>`),
`createTab(tabId, {url?, engine?, active?, zoom?, start?, permissions?})`, `navigate(tabId, url, {engine?, create?,
timeout?})` → `{ok, ms, engine, error, committed, switched, title, events}`, `stats()` (`diagnostics`), `status()`,
`close()`. `readOut`, `bodyText` and `withDeadline` are re-exported from the spike's drive.mjs.

Reading a tab's document: `app.tabFrame(tabId)` keeps the playwright Frame it found by name (Scramjet renames a
frame's browsing context, e.g. after a reload in Chromium). Playwright's Firefox stops answering evaluations and
locators in a Scramjet tab frame after that frame was reloaded, although the page renders: suites that read a tab
after a reload use `lib/tab-read.mjs` (`tabText(page, tabId, selector)` reads through the engine host's frame).

A suite that also runs on its own may keep its own launcher (lane e's `backend-lib.mjs`); under the runner it must
use `ctx.stack` and the runner's ports.

### Standalone suites

A suite that needs its own server layout (another topology, its own build) exports `standalone = true` next to its
`run(ctx)`. The runner then never calls `run(ctx)` for it: once per run, after the other suites, it starts the file
as a child process,

```sh
node suites/<suite>.mjs --browser <the run's browsers, comma-separated> [--static <dist>]   # --static when the build has e2e-driver/
```

with `BACKEND_E2E_PORT_BASE` = `E2E_STANDALONE_PORT_BASE` (default `E2E_PORT_BASE + 100`; the suite may use that base
up to +99), `BACKEND_E2E_DIR` = `<runDir>/<suite>/` and `GNOME_SERVER_BIN`. The child starts and stops everything
it needs and writes its rows (the runner's row shape, each with `browser`) as `<suite>.json` somewhere under
`BACKEND_E2E_DIR` (`backend-lib.mjs` `writeResults`); the runner adds them to the run's results, and records a
`suite-error` row with the tail of `<runDir>/<suite>/output.log` when there are none. `--parts` and `--offline` are not
passed. Standalone suites today: `backend-https` (two hostnames behind a TLS front) and `backend-reload`
(`GNOME_STATIC_RELOAD` with `npm run dev:engine`). Both still run on their own (`node engine/suites/<suite>.mjs`).
