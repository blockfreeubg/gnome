// Item 1 (spike-core): the prototype really is two-origin + sandboxed, the Wisp gateway stub really enforces
// ticket + Origin, and the engine host's service worker / IndexedDB / Cache Storage work inside the sandboxed
// cross-origin iframe, including Scramjet cookie persistence, UV's __op store and an app reload.
import WebSocket from 'ws';
import { APP_ORIGIN, APP_ORIGIN_XSITE, PROXY_ORIGIN, TARGET_ORIGIN, TICKETS } from '../lib/config.mjs';
import { readOut } from '../lib/drive.mjs';

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
const ALLOW = 'fullscreen; clipboard-write; autoplay';
const sortTokens = (s) => String(s || '').trim().split(/\s+/).sort().join(' ');
const j = (v) => JSON.stringify(v);

export function engineFrame(app) {
  return app.page.frames().find((f) => f.url().startsWith(`${PROXY_ORIGIN}/engine/`)) || null;
}

// One WebSocket upgrade against the gateway stub; resolves with the HTTP status and the first Wisp packet type.
function wsProbe(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const done = (r) => { clearTimeout(timer); try { ws.terminate(); } catch { /* closed */ } resolve(r); };
    const timer = setTimeout(() => done({ status: 'timeout' }), 5000);
    ws.on('unexpected-response', (_req, res) => done({ status: res.statusCode }));
    ws.on('error', (e) => done({ status: 'error', error: String(e.message).slice(0, 80) }));
    ws.on('message', (data) => done({ status: 101, firstPacketType: data[0] })); // HolyWisp: CONTINUE (0x03) on stream 0
  });
}

async function gatewayChecks(ctx) {
  const base = PROXY_ORIGIN.replace('http', 'ws');
  const T = encodeURIComponent(TICKETS.first);
  const cases = [
    ['no ticket', `${base}/wisp/`, PROXY_ORIGIN, 401],
    ['wrong ticket', `${base}/wisp/?t=w1.0.x.invalid`, PROXY_ORIGIN, 401],
    ['app origin', `${base}/wisp/?t=${T}`, APP_ORIGIN, 403],
    ['opaque origin "null"', `${base}/wisp/?t=${T}`, 'null', 403],
    ['no Origin header', `${base}/wisp/?t=${T}`, null, 403],
    ['valid', `${base}/wisp/?t=${T}`, PROXY_ORIGIN, 101],
    ['valid, profile route', `${base}/wisp/p/test-loopback/?t=${T}`, PROXY_ORIGIN, 101],
    ['unknown route', `${base}/wisp/p/nope/?t=${T}`, PROXY_ORIGIN, 404],
  ];
  const got = [];
  let ok = true;
  for (const [name, url, origin, want] of cases) {
    const r = await wsProbe(url, origin);
    const pass = r.status === want && (want !== 101 || r.firstPacketType === 3);
    ok &&= pass;
    got.push(`${name}: ${r.status}${r.firstPacketType !== undefined ? ` (first Wisp packet 0x0${r.firstPacketType})` : ''}${pass ? '' : ` WANT ${want}`}`);
  }
  // Plain HTTP on the route tells "ticket rejected" (401) from "upgrade required" (426).
  const h1 = (await fetch(`${PROXY_ORIGIN}/wisp/`)).status;
  const h2 = (await fetch(`${PROXY_ORIGIN}/wisp/?t=${T}`)).status;
  ok &&= h1 === 401 && h2 === 426;
  got.push(`HTTP GET: no ticket ${h1}, ticket ${h2}`);
  ctx.record({ test: 'gateway stub: ticket + Origin enforced', result: ok ? 'pass' : 'fail', notes: got.join('; ') });
}

async function headerChecks(ctx) {
  const r = await fetch(`${PROXY_ORIGIN}/engine/`);
  const csp = r.headers.get('content-security-policy');
  const xfo = r.headers.get('x-frame-options');
  const sw = await fetch(`${PROXY_ORIGIN}/sw.js`);
  const ok = r.ok && /frame-ancestors /.test(csp || '') && csp.includes(APP_ORIGIN) && !xfo && sw.ok && /javascript/.test(sw.headers.get('content-type') || '');
  ctx.record({ test: 'proxy origin headers', result: ok ? 'pass' : 'fail', notes: `/engine/ CSP "${csp}", X-Frame-Options ${xfo ?? 'absent'}; /sw.js ${sw.status} ${sw.headers.get('content-type')}, Service-Worker-Allowed ${sw.headers.get('service-worker-allowed')}` });
}

async function frameChecks(ctx, app) {
  const p = app.page;
  const attrs = await p.evaluate(() => {
    const f = document.getElementById('engine');
    let cross;
    try { void f.contentWindow.document.title; cross = false; } catch (e) { cross = `${e.name}`; }
    return { sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), src: f.src, cross, appOrigin: location.origin };
  });
  const ef = engineFrame(app);
  const inner = await ef.evaluate(async () => ({
    origin: location.origin,
    windowOrigin: window.origin, // "null" if allow-same-origin were missing
    secure: window.isSecureContext,
    fullscreenEnabled: document.fullscreenEnabled,
    hasSW: 'serviceWorker' in navigator,
    parentIsTop: window.parent === window.top,
    topHref: (() => { try { return window.top.location.href; } catch (e) { return `blocked (${e.name})`; } })(),
  }));
  const okAttrs = sortTokens(attrs.sandbox) === sortTokens(SANDBOX) && attrs.allow === ALLOW && attrs.src === `${PROXY_ORIGIN}/engine/`;
  const okInner = inner.origin === PROXY_ORIGIN && inner.windowOrigin === PROXY_ORIGIN && inner.secure && inner.hasSW && inner.fullscreenEnabled && attrs.cross;
  ctx.record({
    test: 'engine iframe: cross-origin, sandboxed, secure context',
    result: okAttrs && okInner ? 'pass' : 'fail',
    notes: `app ${attrs.appOrigin} embeds ${attrs.src}; sandbox exact=${sortTokens(attrs.sandbox) === sortTokens(SANDBOX)}; allow="${attrs.allow}"; app reading frame document -> ${attrs.cross}; inside: ${j(inner)}`,
  });
}

// The sandbox has no allow-top-navigation*: the engine host must not be able to navigate the app away.
async function topNavCheck(ctx, context) {
  const app = await ctx.openApp(context, {});
  const before = app.page.url();
  const r = await engineFrame(app).evaluate((target) => {
    try { window.top.location.href = target; return 'no exception'; } catch (e) { return `${e.name}: ${String(e.message).slice(0, 140)}`; }
  }, `${APP_ORIGIN}/?escaped=1`);
  await ctx.sleep(1000);
  const after = app.page.url();
  ctx.record({ test: 'engine host cannot navigate the app (no allow-top-navigation)', result: after === before ? 'pass' : 'fail', notes: `top.location.href= -> ${r}; app URL ${after === before ? 'unchanged' : `changed to ${after}`}` });
  await app.close();
}

async function swChecks(ctx, app) {
  const d = await app.cmd('diagnostics');
  const reg = await engineFrame(app).evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    return { scope: r && r.scope, script: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL, state: r && r.active && r.active.state };
  });
  const st = await app.cmd('test.storage');
  const okSw = d.sw.controlled && reg.scope === `${PROXY_ORIGIN}/` && reg.script === `${PROXY_ORIGIN}/sw.js` && reg.state === 'activated';
  ctx.record({ test: 'SW registered + controls the engine host', result: okSw ? 'pass' : 'fail', notes: `${j(reg)}; swReady ${app.init.timings.swReady} ms, init ${app.init.timings.init} ms (scramjet ${app.init.timings.scramjet}, uv ${app.init.timings.ultraviolet})` });
  ctx.record({ test: 'IndexedDB + Cache Storage in the engine host', result: st.indexedDB === 'ok' && st.cacheStorage === 'ok' ? 'pass' : 'fail', notes: `indexedDB ${st.indexedDB}, cacheStorage ${st.cacheStorage}, persisted ${st.persisted}, quota ${st.estimate ? Math.round(st.estimate.quota / 1048576) + ' MiB' : '?'}, dbs ${j(st.databases)}` });
  return st;
}

async function cookieRoundTrip(app, tabId, engine, name, create) {
  const set = await app.navigate(tabId, `${TARGET_ORIGIN}/cookies/set?${name}=persist`, { engine, create, timeout: 30000 });
  const out = set.ok ? await readOut(app, tabId, 10000) : null;
  const frameUrl = app.tabFrame(tabId)?.url() || null;
  return { ok: set.ok, out, frameUrl, committed: set.committed?.url, error: set.error };
}

const swLog = [];
async function debugTab(ctx, app, tabId, r) {
  ctx.log('sw console', j(swLog.slice(-25)).slice(0, 3000));
  const f = app.tabFrame(tabId);
  let body = null;
  try { body = f && (await f.evaluate(() => document.documentElement.outerHTML.slice(0, 600))); } catch (e) { body = String(e.message).slice(0, 100); }
  const stats = await app.cmd('test.stats').catch((e) => String(e));
  ctx.log(`debug tab ${tabId}: frame ${f?.url()}`, `body ${body}`, `nav ${j({ ok: r.ok, error: r.error, committed: r.committed })}`);
  ctx.log('stats', j({ sw503: stats.counters?.sw503, uvErrors: stats.counters?.uvErrors, sjErrors: stats.counters?.sjErrors, signals: stats.counters?.signals, wisp: stats.counters?.wisp?.slice(-6) }).slice(0, 1500));
  ctx.log('console', j(app.console.slice(-15)).slice(0, 2500));
}

export async function run(ctx) {
  await gatewayChecks(ctx);
  await headerChecks(ctx);
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const hook = (w) => { try { w.on('console', (m) => swLog.push(`${Date.now() % 100000} ${m.type()} ${m.text().slice(0, 200)}`)); } catch { /* not supported */ } };
    context.on('serviceworker', hook);
    const app = await ctx.openApp(context, { route: 'test' });
    await frameChecks(ctx, app);
    await swChecks(ctx, app);

    // Cookies set by the target through each engine, then an app reload, then sent again.
    const sj = await cookieRoundTrip(app, 1, 'scramjet', 'sj', true);
    const uv = await cookieRoundTrip(app, 2, 'ultraviolet', 'uv', true);
    const jar = await app.cmd('test.cookies');
    const stBefore = await app.cmd('test.storage');
    if (!sj.out?.cookies) await debugTab(ctx, app, 1, sj);
    const firstSet = (r, n) => r.ok && r.out && r.out.cookies && r.out.cookies[n] === 'persist' && r.out.cookies.srvhttp === '1';
    ctx.record({ engine: 'scramjet', transport: 'libcurl', test: 'cookie set (302 + Set-Cookie incl. HttpOnly)', result: firstSet(sj, 'sj') ? 'pass' : 'fail', notes: `server saw ${j(sj.out?.cookies)}; jar ${j(jar.scramjet)}` });
    ctx.record({ engine: 'ultraviolet', transport: 'epoxy', test: 'cookie set (302 + Set-Cookie incl. HttpOnly)', result: firstSet(uv, 'uv') ? 'pass' : 'fail', notes: `server saw ${j(uv.out?.cookies)}; __op ${j(jar.ultraviolet)}` });

    const connectsBefore = await app.page.evaluate(() => window.gnomeTest.connects);
    const t0 = Date.now();
    await app.page.reload();
    await app.waitInit(60000);
    const reloadMs = Date.now() - t0;
    const d = await app.cmd('diagnostics');
    ctx.record({
      test: 'app reload: engine host re-handshakes, SW still in control',
      result: d.sw.controlled && d.tabs.length === 0 ? 'pass' : 'fail',
      notes: `reload->init ${reloadMs} ms (swReady ${app.init.timings.swReady} ms, init ${app.init.timings.init} ms); new engine host has ${d.tabs.length} tabs (the app must restore tabs from real URLs); connects on the old page ${connectsBefore}`,
    });

    // Stale proxied URLs from before the reload: Scramjet prefix of a dead controller must 503 quickly, UV URLs are stateless.
    const stale = await engineFrame(app).evaluate(async (urls) => {
      const out = {};
      for (const [k, u] of Object.entries(urls)) {
        if (!u) { out[k] = 'no url'; continue; }
        const t0 = performance.now();
        try {
          const r = await fetch(u, { cache: 'no-store' });
          out[k] = { status: r.status, sw: r.headers.get('x-gnome-sw'), ms: Math.round(performance.now() - t0), path: new URL(u).pathname.slice(0, 40) };
        } catch (e) { out[k] = `threw ${e.name}`; }
      }
      return out;
    }, { scramjet: sj.frameUrl, ultraviolet: uv.frameUrl });
    // The claim: the dead controller's prefix fails fast with the SW's 503 stale-prefix (never hangs, never the network).
    const sjStaleOk = stale.scramjet && stale.scramjet.status === 503 && stale.scramjet.sw === 'stale-prefix' && stale.scramjet.ms < 2000;
    ctx.record({ engine: 'scramjet', transport: 'libcurl', test: 'pre-reload proxied URL after app reload', result: sjStaleOk ? 'pass' : 'fail', notes: j(stale.scramjet) });
    ctx.record({ engine: 'ultraviolet', transport: 'epoxy', test: 'pre-reload proxied URL after app reload', result: stale.ultraviolet && stale.ultraviolet.status === 200 ? 'pass' : 'fail', notes: j(stale.ultraviolet) });

    for (const [tabId, engine, name, transport] of [[1, 'scramjet', 'sj', 'libcurl'], [2, 'ultraviolet', 'uv', 'epoxy']]) {
      const r = await app.navigate(tabId, `${TARGET_ORIGIN}/cookies`, { engine, create: true, timeout: 30000 });
      const out = r.ok ? await readOut(app, tabId, 10000) : null;
      const ok = out && out.cookies && out.cookies[name] === 'persist' && out.cookies.srvhttp === '1';
      ctx.record({ engine, transport, test: 'cookies persist across app reload', result: ok ? 'pass' : 'fail', notes: `server saw ${j(out?.cookies ?? r.error)}` });
      if (!ok) await debugTab(ctx, app, tabId, r);
    }
    // Forced reload (Ctrl+Shift+R): the engine host document loads uncontrolled. Chromium: CDP ignoreCache reload;
    // Firefox: Playwright's page.reload() above is already a forced reload (the engine host came back uncontrolled
    // before host.js asked the SW to claim it).
    if (ctx.browser === 'chromium') {
      const cdp = await context.newCDPSession(app.page);
      await cdp.send('Page.reload', { ignoreCache: true });
      await app.waitInit(60000);
      const dd = await app.cmd('diagnostics');
      const r = await app.navigate(1, `${TARGET_ORIGIN}/cookies`, { engine: 'scramjet', create: true, timeout: 30000 });
      const r2 = await app.navigate(2, `${TARGET_ORIGIN}/cookies`, { engine: 'ultraviolet', create: true, timeout: 30000 });
      ctx.record({ test: 'forced reload (ignore cache): SW claims the engine host', result: dd.sw.controlled && r.ok && r2.ok ? 'pass' : 'fail', notes: `controlled ${dd.sw.controlled}, swReady ${app.init.timings.swReady} ms; scramjet ${r.ok ? 'ok' : j(r.error)}; ultraviolet ${r2.ok ? 'ok' : j(r2.error)}` });
    }
    const stAfter = await app.cmd('test.storage');
    ctx.log('dbs before/after reload', j(stBefore.databases), j(stAfter.databases));
    await app.close();

    await topNavCheck(ctx, context);

    await context.close();
  } finally {
    await browser.close();
  }
  await partitioningChecks(ctx);
  await swLifecycleChecks(ctx);
}

// SW lifecycle while an engine host runs (session 4). (1) Chromium only: the browser stops the SW (CDP
// ServiceWorker.stopAllWorkers stands in for idle termination); the next proxied request starts a fresh instance with
// empty routing state: held Scramjet requests must be routed once the controller re-announces its prefix, and UV
// documents must still get the GNOME CSP (UV's response hook runs in the SW). (2) A new /sw.js (a deploy; here a new
// script URL for scope "/") must NOT take over the running engine host (sw.js neutralizes controller.sw.js's
// skipWaiting: a mid-session swap breaks both engines); it waits, both engines keep working, and it controls the
// next engine host after an app reload, where both engines must work again.
async function swLifecycleChecks(ctx) {
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    let app = await ctx.openApp(context, { route: 'test', csp: 'enforce' });
    await ctx.sleep(6000); // past the controller's 5 s revive guard (an idle stop happens after ~30 s anyway)
    let tab = 0;
    const served = (path, t0) => ctx.events.some((e) => e.from === 'target' && e.type === 'target-request' && e.path === path && e.at >= t0);
    const leakEgress = (t0) => ctx.eventsSince(t0, 'sentinel').filter((e) => /gnome-spike\.invalid/.test(String(e.target || e.url || ''))).length;
    const loadBoth = async (label) => {
      const t0 = Date.now();
      const s0 = (await app.stats()).counters;
      const sj = await app.navigate(++tab, `${TARGET_ORIGIN}/?sw=${label}`, { engine: 'scramjet', create: true, timeout: 30000 });
      const sjReal = sj.ok && served('/', t0) && sj.title === 'GNOME spike target'; // not the SW's 503 page
      const t1 = Date.now();
      const uv = await app.navigate(++tab, `${TARGET_ORIGIN}/leak/matrix?sw=${label}`, { engine: 'ultraviolet', create: true, timeout: 30000 });
      const uvReal = uv.ok && served('/leak/matrix', t1);
      await ctx.sleep(3500); // the matrix runs its constructs and reports after 2.5 s
      const s1 = (await app.stats()).counters;
      const d = (k) => s1[k].length - s0[k].length;
      return { sj, uv, sjReal, uvReal, egress: leakEgress(t0), held: s1.swHeld.slice(s0.swHeld.length).map((h) => h.ms), starts: d('swStarts'), sw503: s1.sw503.slice(s0.sw503.length).map((x) => x.reason), violations: d('csp') };
    };
    const note = (r) => `scramjet ${r.sjReal ? `${r.sj.ms} ms` : r.sj.ok ? `loaded a non-target page (title ${j(r.sj.title)})` : j(r.sj.error).slice(0, 100)}; ultraviolet ${r.uvReal ? `${r.uv.ms} ms` : j(r.uv.error).slice(0, 100)}; UV leak page: ${r.egress} native egress, ${r.violations} CSP violations; SW held ${j(r.held)} ms, starts ${r.starts}, 503 ${j(r.sw503)}`;
    const healthy = (r) => r.sjReal && r.uvReal && r.egress === 0 && r.violations > 0;
    const before = await loadBoth('before');
    ctx.record({ test: 'SW lifecycle: baseline (csp=enforce)', result: healthy(before) ? 'pass' : 'fail', notes: note(before) });

    if (ctx.browser === 'chromium') {
      const cdp = await context.newCDPSession(app.page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await ctx.sleep(500);
      const afterStop = await loadBoth('after-stop');
      ctx.record({ test: 'SW lifecycle: stopped SW restarts on the next request', result: healthy(afterStop) && afterStop.starts > 0 ? 'pass' : 'fail', notes: note(afterStop) });
      await cdp.detach().catch(() => {});
    }

    const update = await engineFrame(app).evaluate(async () => {
      const t0 = performance.now();
      let changed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { changed = true; }, { once: true });
      const reg = await navigator.serviceWorker.register(`/sw.js?rev=${Date.now()}`, { scope: '/', updateViaCache: 'none' });
      for (let i = 0; i < 100 && !reg.waiting && !changed; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1000)); // would a takeover still happen?
      return { waiting: !!reg.waiting, changed, ms: Math.round(performance.now() - t0), controller: new URL(navigator.serviceWorker.controller.scriptURL).search || '(original)' };
    });
    const waitingRun = await loadBoth('update-waiting');
    ctx.record({ test: 'SW lifecycle: an updated /sw.js waits; the running engine host keeps working', result: update.waiting && !update.changed && healthy(waitingRun) ? 'pass' : 'fail', notes: `new version installed and waiting ${update.waiting}, took over ${update.changed} (controller ${update.controller}); ${note(waitingRun)}` });

    await app.page.reload();
    await app.waitInit(60000);
    tab = 0;
    const ctl = await engineFrame(app).evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).search || '(original)');
    await ctx.sleep(500);
    const afterReload = await loadBoth('after-reload');
    // Firefox (157, Playwright's reload = a forced reload) keeps the old worker in control across the reload: the waiting
    // version is not applied, so Wave B needs an explicit "apply update" step there (documented, expectFail).
    const applied = /rev=/.test(ctl);
    ctx.record({ test: 'SW lifecycle: the update applies at the next app reload; both engines work', result: applied && healthy(afterReload) ? 'pass' : 'fail', expectFail: ctx.browser === 'firefox' && !applied && healthy(afterReload), notes: `controller after reload ${ctl}${applied ? '' : ' (update still waiting)'}; ${note(afterReload)}` });
    await app.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

// Playwright launches Chromium with --disable-features=...,ThirdPartyStoragePartitioning,... and Firefox with
// network.cookie.cookieBehavior=4; real browsers partition third-party storage. Re-enable it to check the
// supported same-site deployment and to show what a cross-site deployment would do.
const PW_DISABLED_FEATURES = ['AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding', 'BlockOriginHeaderModificationOnRedirect', 'Translate', 'AutoDeElevate', 'OptimizationHints', 'NetworkTimeServiceQuerying', 'AimEnabled'];
export function launchWithPartitioning(ctx) {
  return ctx.browser === 'chromium'
    ? ctx.launch({ extraArgs: [`--disable-features=${PW_DISABLED_FEATURES.join(',')}`] })
    : ctx.launch({ extraPrefs: { 'network.cookie.cookieBehavior': 5 } });
}

async function partitioningChecks(ctx) {
  const browser = await launchWithPartitioning(ctx);
  try {
    const context = await ctx.newContext(browser);
    const same = await ctx.openApp(context, { route: 'test' });
    const r1 = await same.navigate(1, `${TARGET_ORIGIN}/cookies/set?part=1`, { engine: 'scramjet', create: true, timeout: 30000 });
    const o1 = r1.ok ? await readOut(same, 1, 10000) : null;
    const st1 = await same.cmd('test.storage');
    await same.page.reload();
    await same.waitInit(60000);
    const r2 = await same.navigate(1, `${TARGET_ORIGIN}/cookies`, { engine: 'scramjet', create: true, timeout: 30000 });
    const o2 = r2.ok ? await readOut(same, 1, 10000) : null;
    const okSame = st1.controlled && st1.indexedDB === 'ok' && st1.cacheStorage === 'ok' && o1?.cookies?.part === '1' && o2?.cookies?.part === '1';
    ctx.record({ engine: 'scramjet', transport: 'libcurl', test: 'same-site embed with storage partitioning ON', result: okSame ? 'pass' : 'fail', notes: `SW controlled ${st1.controlled}, IDB ${st1.indexedDB}, Cache ${st1.cacheStorage}; cookie after reload: ${j(o2?.cookies ?? r2.error)}` });
    await same.close();
    // Cross-site (app http://localhost, proxy http://127.0.0.1): not the supported deployment.
    try {
      const xs = await ctx.openApp(context, { route: 'test' }, { origin: APP_ORIGIN_XSITE, timeout: 45000 });
      const r = await xs.navigate(1, `${TARGET_ORIGIN}/cookies`, { engine: 'scramjet', create: true, timeout: 30000 });
      const out = r.ok ? await readOut(xs, 1, 10000) : null;
      const xst = await xs.cmd('test.storage');
      // Also the control for the same-site row above: only a partitioned result proves that this launch really
      // re-enabled storage partitioning (otherwise the same-site row would show nothing).
      const partitioned = r.ok && out?.cookies?.part !== '1';
      ctx.record({
        engine: 'scramjet', transport: 'libcurl',
        test: 'cross-site embed with partitioning ON: engine state is partitioned (control)',
        result: partitioned ? 'pass' : 'fail',
        notes: `engines ${r.ok ? 'work' : `fail ${j(r.error)}`}; SW controlled ${xst.controlled}; proxied cookie set under the same-site embed ${out?.cookies?.part === '1' ? 'VISIBLE (not partitioned: partitioning is NOT active in this launch)' : 'NOT visible (partitioned)'}; server saw ${j(out?.cookies)}`,
      });
      await xs.close();
    } catch (e) {
      ctx.record({ test: 'cross-site embed with partitioning ON: engine state is partitioned (control)', result: 'partial', notes: `engine host does not start cross-site, so partitioning is not proven: ${String(e.message || e).slice(0, 300)}` });
    }
    await context.close();
  } finally {
    await browser.close();
  }
}
