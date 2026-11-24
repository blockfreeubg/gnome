// Lane e (backend) e2e suite: the proxy-origin policies, templating, probe and cookies of the real gnome-server
// (docs/WAVE-B.md §6 items 1–9 and "Tests"; ARCHITECTURE §4.6; API.md "Static & SPA", the probe, /api/config).
//
// Parts (all by default; `--parts a,b` standalone, ctx.parts under the runner):
//   contract   backend/tests/fixtures/proxy-origin-csp.json equals what frontend/src/shared/proxy-origin.ts computes
//   headers    /engine/ (and paths below it), /vendor/bare-mux/worker.js and /sw.js from the real server equal
//              engineHostCsp(appOrigins) / bareMuxWorkerCsp() / the script policy, with GNOME_ALLOW_CUSTOM_WISP off
//              and on (a restart), and no query parameter changes a header; /api/config wisp.custom_servers
//   template   /engine/ has %GNOME_APP_ORIGINS% replaced with the app origins
//   realm      "no permissive realm": each kind of proxy-origin document, loaded on its own (what escaped code does
//              with a hidden frame), cannot reach the network directly: fetch, WebSocket, image, beacon, module
//              import, iframe and form submission towards a local sentinel all stay blocked (the sentinel sees
//              nothing), with a control page without a policy that does reach it; with the custom-Wisp opt-in the
//              engine host and the bare-mux worker URL can open ws: (documented) and nothing else changes
//   oversized  hyper's own answers to request heads it cannot parse (414 for a request target of 64 KiB or more, 431 for
//              a head over its read buffer: since WAVE-D D19 1 MiB for loopback peers on the proxy listener, so a
//              1.9 MB query in Chromium, a 900 KB query plus 40 cookies of 3.9 KB in Firefox) carry default-src 'none' +
//              frame-ancestors 'none', and a hidden frame of them gives escaped code no realm that reaches the
//              sentinel; a 156 KB cookie bomb now gets the proxy origin's normal 404 with proxyInertCsp (no realm either)
//   worker     the real bare-mux SharedWorker's own realm (code injected through its `set` message, as any
//              same-origin client can): fetch, importScripts and import() towards the sentinel stay blocked; a
//              WebSocket to it is blocked without the custom-Wisp opt-in and opens with it (both worker policies)
//   custom     (runner only: the real engine host and the e2e driver) with GNOME_ALLOW_CUSTOM_WISP=true every engine x
//              transport loads https://example.com/ through a custom Wisp server (HolyWisp addressed directly, not
//              the gateway: the gateway's connection counter does not move); without the opt-in the same route is
//              blocked by the policies (control)
//   retry      the engine-prefix 503 page registers /sw.js under its policy with no CSP violation
//   probe      the engine host's probe (a same-origin GET) gets 503 wisp_upstream_unavailable + Retry-After for a
//              route whose upstream the health job has down, 426 on the direct route, 401 for a bad ticket
//   cookies    plain HTTP on loopback app origins (127.0.0.1 and localhost) stores and sends __Host-gnome_sid
//   engines    (standalone only: the spike's app stub and engine host as the static dir) every engine x transport
//              loads https://example.com/ under the server's default policies (no GNOME_PROXY_CSP)
//   stackqa    tests/e2e/stack/stack-qa.mjs against this server (first browser only; no browser involved)
//
// ctx: the runner's (WAVE-B §3) plus, optionally, ctx.stack.{appOrigins, sentinel, deadProfile, spike, admin}. The
// standalone driver (backend-lib.mjs runStandalone below) provides all of them.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  E2E, FIXTURE, PORTS, REPO, assertPortsFree, cleanupAll, fixtureFrom, installSignalHandlers, launchBrowser, loadContract,
  parseArgs, prepareSpikeStatic, recorder, sleep, startGnomeServer, startHolyWisp, startSentinel, summarize, workDir, writeResults,
} from './backend-lib.mjs';

const ALL_PARTS = ['stackqa', 'contract', 'headers', 'template', 'realm', 'oversized', 'worker', 'custom', 'retry', 'probe', 'cookies', 'engines'];

const csps = (res) => (res.headers.get('content-security-policy') ?? '').split(/,\s*/).filter(Boolean);

async function headersOf(url) {
  const res = await fetch(url, { redirect: 'manual' });
  const body = await res.text();
  const h = {};
  for (const [k, v] of res.headers) if (k !== 'date' && k !== 'x-request-id') h[k] = v;
  return { status: res.status, headers: h, csp: csps(res), body };
}

export async function run(ctx) {
  const { record, stack } = ctx;
  const parts = new Set(ctx.parts ?? ALL_PARTS);
  const m = await loadContract();
  const appOrigins = stack.appOrigins ?? [stack.appOrigin];
  const P = () => stack.proxyOrigin;

  if (parts.has('stackqa') && ctx.browser === (ctx.firstBrowser ?? 'chromium')) {
    const r = await stackQa(stack);
    record({ test: 'stack-qa.mjs against the Wave B server', result: r.ok ? 'pass' : 'fail', notes: r.summary });
  }

  if (parts.has('contract')) {
    const want = fixtureFrom(m);
    const have = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const same = JSON.stringify(want) === JSON.stringify(have);
    const n = ['engineHostCsp', 'bareMuxWorkerCsp', 'proxyScriptCsp', 'bareMuxWorkerScriptCsp', 'proxyInertCsp'].map((k) => `${want[k].length} ${k}`).join(', ');
    record({ test: 'contract: backend fixture equals the TypeScript functions', result: same ? 'pass' : 'fail', notes: same ? `${n} cases` : 'regenerate with --write-fixture' });
  }

  const checkHeaders = async (customWisp) => {
    const label = `customWisp=${customWisp}`;
    const engine = m.engineHostCsp(appOrigins, { customWisp });
    const worker = m.bareMuxWorkerCsp({ customWisp });
    const queries = ['', '?wisp=wss://evil.example/', '?customWisp=true&custom_servers=1', '?csp=connect-src%20*', `?gnome-app-origins=${encodeURIComponent('https://evil.example')}`];
    // The worker's second policy is the script policy, with the opt-in's `ws: wss:` in its connect-src as well: every
    // policy of a response is enforced, so without it the opt-in would never reach the worker (the worker part).
    const workerScript = m.bareMuxWorkerScriptCsp(appOrigins, { customWisp });
    const checks = [
      ['/engine/', [engine]],
      ['/engine/tab/1', [engine]],
      // The contract's worker policy, then the script policy as a second one (bareMuxWorkerCsp() alone leaves a
      // permissive realm: see the realm part and the lane e report).
      ['/vendor/bare-mux/worker.js', [worker, workerScript]],
      ['/sw.js', [m.proxyScriptCsp(appOrigins)]],
    ];
    for (const [p, want] of checks) {
      const base = await headersOf(`${P()}${p}`);
      let ok = base.status === 200 && JSON.stringify(base.csp) === JSON.stringify(want);
      let notes = ok ? '' : `status ${base.status}, got ${JSON.stringify(base.csp)}, want ${JSON.stringify(want)}`;
      for (const q of queries.slice(1)) {
        const r = await headersOf(`${P()}${p}${q}`);
        if (JSON.stringify(r.headers) !== JSON.stringify(base.headers) || r.body !== base.body) {
          ok = false;
          notes += ` ${q} changed the answer`;
        }
      }
      if (p.startsWith('/engine/')) {
        ok &&= base.headers['x-content-type-options'] === 'nosniff' && base.headers['referrer-policy'] === 'no-referrer' && base.headers['cache-control'] === 'no-cache' && !base.headers['x-frame-options'];
      }
      if (p === '/sw.js') ok &&= base.headers['service-worker-allowed'] === '/' && base.headers['cache-control'] === 'no-cache';
      record({ test: `headers ${p} (${label}, ${queries.length - 1} queries)`, result: ok ? 'pass' : 'fail', notes: notes.trim() || want[0].slice(0, 90) });
    }
    // Answers where nothing runs (bodies may differ between requests, e.g. uptime_s, so only the policy is compared).
    const inert = m.proxyInertCsp(appOrigins);
    for (const p of ['/api/health', '/api/filters', '/no-such-file.html']) {
      const got = [];
      for (const q of queries) got.push((await headersOf(`${P()}${p}${q}`)).csp);
      const ok = got.every((c) => JSON.stringify(c) === JSON.stringify([inert]));
      record({ test: `headers ${p} is proxyInertCsp (${label}, ${queries.length - 1} queries)`, result: ok ? 'pass' : 'fail', notes: ok ? inert.slice(0, 90) : `got ${JSON.stringify(got)}, want ${JSON.stringify([inert])}` });
    }
    const config = await (await fetch(`${stack.appOrigin}/api/config`)).json();
    record({ test: `headers: /api/config wisp.custom_servers (${label})`, result: config.wisp?.custom_servers === customWisp ? 'pass' : 'fail', notes: JSON.stringify(config.wisp?.custom_servers) });
  };

  if (parts.has('headers')) await checkHeaders(false);

  if (parts.has('template')) {
    const r = await headersOf(`${P()}/engine/`);
    const meta = /<meta name="gnome-app-origins" content="([^"]*)"\s*\/?>/.exec(r.body)?.[1];
    record({ test: 'template: %GNOME_APP_ORIGINS% filled with the app origins', result: meta === appOrigins.join(' ') && !r.body.includes('%GNOME_APP_ORIGINS%') ? 'pass' : 'fail', notes: JSON.stringify(meta) });
  }

  // The runner's sentinel (the spike's, `since(t)` events with `url`) or this file's (`hits` with `path`).
  let sentinel = stack.sentinel && !stack.sentinel.hits
    ? { origin: stack.sentinel.origin, get hits() { return stack.sentinel.since(0).map((e) => ({ at: e.at, path: String(e.url ?? e.target ?? '') })); } }
    : stack.sentinel;
  let ownSentinel = null;
  if ((parts.has('realm') || parts.has('oversized') || parts.has('worker')) && !sentinel) {
    ownSentinel = await startSentinel();
    sentinel = ownSentinel;
  }
  try {
    if (parts.has('realm')) await realm(ctx, sentinel, { customWisp: false });
    if (parts.has('oversized')) await oversized(ctx, sentinel);
    if (parts.has('worker')) await workerRealm(ctx, sentinel, { customWisp: false });
    if (parts.has('custom')) await customServer(ctx, { optIn: false });

    if (parts.has('retry')) await retryPage(ctx);
    if (parts.has('probe')) await probe(ctx);
    if (parts.has('cookies')) await cookies(ctx);
    if (parts.has('engines')) {
      if (stack.spike) await engines(ctx, 'default policies');
      else record({ test: 'engines (spike engine host)', result: 'skip', notes: 'needs the spike static dir (standalone run); the real engine host runs in lanes a/b suites' });
    }

    const optInParts = ['headers', 'realm', 'worker', 'custom', 'engines'];
    if (optInParts.some((p) => parts.has(p)) && stack.restartServer) {
      await stack.restartServer({ GNOME_ALLOW_CUSTOM_WISP: 'true' });
      try {
        if (parts.has('headers')) await checkHeaders(true);
        if (parts.has('realm')) await realm(ctx, sentinel, { customWisp: true });
        if (parts.has('worker')) await workerRealm(ctx, sentinel, { customWisp: true });
        if (parts.has('custom')) await customServer(ctx, { optIn: true });
        if (parts.has('engines') && stack.spike) await engines(ctx, 'GNOME_ALLOW_CUSTOM_WISP=true');
      } finally {
        await stack.restartServer({});
      }
    }
  } finally {
    await ownSentinel?.close();
  }
}

// ── no permissive realm ──────────────────────────────────────────────────────────────────────────────────────────

/** Paths of each kind of proxy-origin document (what a hidden frame of escaped code can load). */
const REALM_PATHS = [
  ['/engine/', 'engine host'],
  ['/api/health', 'JSON (health)'],
  ['/api/filters', 'JSON (filter index)'],
  ['/wisp/', 'JSON error (probe 401)'],
  ['/nope', 'plain 404'],
  ['/api/config', 'JSON 404'],
  ['/sw.js', 'service worker script'],
  ['/vendor/bare-mux/index.js', 'vendor script'],
  ['/vendor/bare-mux/worker.js', 'bare-mux worker script'],
  ['/engine/uv.config.js', 'engine script'],
  ['/assets/probe-0000.js', 'hashed asset script'],
  ['/assets/probe-0000.css', 'stylesheet'],
  ['/~/sj/realm-check', 'engine-prefix 503 page'],
];

/** Runs in the borrowed realm: every way to reach `target` directly. */
function attempt([target, id]) {
  const ws = target.replace(/^http/, 'ws');
  const out = {};
  const tryIt = (k, f) => {
    try {
      const r = f();
      out[k] = 'started';
      if (r && typeof r.then === 'function') r.then(() => (out[k] = 'resolved'), (e) => (out[k] = `rejected ${String(e).slice(0, 60)}`));
    } catch (e) {
      out[k] = `threw ${String(e).slice(0, 60)}`;
    }
  };
  tryIt('fetch', () => fetch(`${target}/fetch?${id}`, { mode: 'no-cors' }));
  tryIt('websocket', () => {
    const s = new WebSocket(`${ws}/ws?${id}`);
    s.onerror = () => {};
  });
  tryIt('image', () => {
    const i = new Image();
    i.src = `${target}/img?${id}`;
  });
  tryIt('beacon', () => navigator.sendBeacon(`${target}/beacon?${id}`, 'x'));
  tryIt('import', () => import(`${target}/mod.js?${id}`));
  tryIt('iframe', () => {
    const f = document.createElement('iframe');
    f.src = `${target}/frame?${id}`;
    (document.body || document.documentElement).appendChild(f);
  });
  tryIt('xhr', () => {
    const x = new XMLHttpRequest();
    x.open('GET', `${target}/xhr?${id}`);
    x.send();
  });
  tryIt('form', () => {
    const f = document.createElement('form');
    f.action = `${target}/form?${id}`;
    f.method = 'GET';
    f.target = 'gnome-realm-form';
    const sink = document.createElement('iframe');
    sink.name = 'gnome-realm-form';
    (document.body || document.documentElement).append(sink, f);
    f.submit();
  });
  return out;
}

/** The realm paths, with the hashed assets of the build that is served (the spike dir has fixed probe files). */
async function realmPaths(stack) {
  if (stack.spike) return REALM_PATHS;
  const engine = await (await fetch(`${stack.proxyOrigin}/engine/`)).text();
  const app = await (await fetch(`${stack.appOrigin}/`)).text();
  const js = /src="(\/assets\/[^"]+\.js)"/.exec(engine)?.[1];
  const css = /href="(\/assets\/[^"]+\.css)"/.exec(app)?.[1];
  return REALM_PATHS.map(([p, kind]) => (p === '/assets/probe-0000.js' && js ? [js, kind] : p === '/assets/probe-0000.css' && css ? [css, kind] : [p, kind]));
}

async function realm(ctx, sentinel, { customWisp }) {
  const { record, stack } = ctx;
  const paths = await realmPaths(stack);
  const browser = await ctx.launch();
  try {
    // Control: a page without any policy reaches the sentinel through every route the check uses.
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${sentinel.origin}/control-page`);
      const id = `control-${ctx.browser}-${Date.now()}`;
      await page.evaluate(attempt, [sentinel.origin, id]);
      await sleep(1500);
      const hits = sentinel.hits.filter((h) => h.path.includes(id)).map((h) => h.path.split('?')[0]);
      record({ test: `realm control (no policy) reaches the sentinel (customWisp=${customWisp})`, result: hits.length >= 5 ? 'pass' : 'fail', notes: [...new Set(hits)].join(' ') });
      await context.close();
    }
    for (const [p, kind] of paths) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const violations = [];
      page.on('console', (msg) => {
        if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text())) violations.push(msg.text().slice(0, 120));
      });
      const id = `realm-${ctx.browser}-${customWisp}-${p.replace(/\W+/g, '_')}-${Date.now()}`;
      let result;
      try {
        await page.goto(`${stack.proxyOrigin}${p}`, { waitUntil: 'domcontentloaded' });
        result = await page.evaluate(attempt, [sentinel.origin, id]);
      } catch (e) {
        result = { error: String(e.message || e).slice(0, 120) };
      }
      await sleep(1500);
      const hits = [...new Set(sentinel.hits.filter((h) => h.path.includes(id)).map((h) => h.path.split('?')[0]))];
      // With the opt-in the engine host and the bare-mux worker may open ws:/wss: (the documented cost of custom Wisp
      // servers; escaped code owns the engine-host realm anyway, so the worker URL adds nothing to it).
      const allowed = customWisp && (p === '/engine/' || p === '/vendor/bare-mux/worker.js') ? ['/ws'] : [];
      const leaked = hits.filter((h) => !allowed.includes(h));
      const ok = !result.error && leaked.length === 0 && (allowed.length === 0 || hits.includes('/ws'));
      record({
        test: `realm ${kind} ${p} (customWisp=${customWisp}): no direct connection`,
        result: ok ? 'pass' : 'fail',
        notes: result.error ?? (leaked.length ? `LEAKED ${leaked.join(' ')}` : `blocked; ${violations.length} CSP reports${allowed.length ? `; ws allowed: ${hits.includes('/ws')}` : ''}`),
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ── hyper's own answers to request heads it cannot parse ─────────────────────────────────────────────────────────

/**
 * A request target of 64 KiB or more (414) or a head over the read buffer (431: a long URL, or a cookie bomb a page
 * planted on the proxy origin) never reaches gnome-server's service: hyper answers by itself, with an empty body.
 * Chromium commits such an answer in a frame as a same-origin document, so without a policy of its own escaped code
 * gets a realm that reaches any host directly (before server::ConnIo hardened them, fetch, WebSocket, image and beacon
 * from that realm reached the sentinel in Chromium; Firefox showed an opaque error page). Now they carry
 * `default-src 'none' … frame-ancestors 'none'`, so no browser renders them in a frame.
 */
// [label, url(browser), cookies to plant first, the answer: 'automatic' (414/431, strict policy) or 'normal' (404, proxyInertCsp)]
const OVERSIZED = [
  // WAVE-D D19: the proxy listener reads up to 1 MiB of head from loopback peers; Firefox's URLs stop at 1 MiB, so it
  // reaches the limit with a 900 KB query plus 40 cookies.
  ['431 head over 1 MiB (long query)', (b) => `/x?${'a'.repeat(b === 'firefox' ? 900_000 : 1_900_000)}`, (b) => (b === 'firefox' ? 40 : 0), 'automatic'],
  ['414 long path (66 KB)', () => `/${'a'.repeat(66_000)}`, () => 0, 'automatic'],
  ['cookie bomb (40 cookies of 3.9 KB, 156 KB): the normal 404', () => '/nope', () => 40, 'normal'],
];
const NOTHING_RUNS_UNFRAMED = "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

async function oversized(ctx, sentinel) {
  const { record, stack } = ctx;
  const inert = (await loadContract()).proxyInertCsp(stack.appOrigins ?? [stack.appOrigin]);
  const browser = await ctx.launch();
  try {
    for (const [label, url, bombOf, answer] of OVERSIZED) {
      const bomb = bombOf(ctx.browser);
      const context = await browser.newContext();
      const page = await context.newPage();
      const id = `oversized-${ctx.browser}-${label.replace(/\W+/g, '_')}-${Date.now()}`;
      let r;
      try {
        // The engine-host document at top level stands in for escaped code (its policy may frame same-origin URLs).
        await page.goto(`${stack.proxyOrigin}/engine/`, { waitUntil: 'domcontentloaded' });
        if (bomb) await page.evaluate((n) => { for (let i = 0; i < n; i++) document.cookie = `gnome-e2e-bomb${i}=${'c'.repeat(3900)}; path=/`; }, bomb);
        r = await page.evaluate(async ([u, target, tag]) => {
          const out = await fetch(u, { cache: 'no-store' }).then(
            (res) => ({ status: res.status, csp: res.headers.get('content-security-policy') }),
            (e) => ({ status: null, csp: String(e).slice(0, 80) }),
          );
          const f = document.createElement('iframe');
          f.src = u;
          document.body.appendChild(f);
          await new Promise((done) => { f.onload = done; setTimeout(done, 5000); });
          await new Promise((done) => setTimeout(done, 300));
          let w;
          try {
            w = f.contentWindow;
            void w.location.href;
            out.frame = 'same-origin';
          } catch {
            out.frame = 'opaque';
            return out;
          }
          try { await w.fetch(`${target}/fetch?${tag}`, { mode: 'no-cors' }); out.fetch = 'resolved'; } catch { out.fetch = 'blocked'; }
          try { new w.Image().src = `${target}/img?${tag}`; } catch { /* blocked */ }
          try { const sock = new w.WebSocket(`${target.replace(/^http/, 'ws')}/ws?${tag}`); sock.onerror = () => {}; } catch { /* blocked */ }
          try { w.navigator.sendBeacon(`${target}/beacon?${tag}`, 'x'); } catch { /* blocked */ }
          return out;
        }, [url(ctx.browser), sentinel.origin, id]);
      } catch (e) {
        r = { error: String(e.message || e).slice(0, 160) };
      }
      await sleep(1500);
      const hits = [...new Set(sentinel.hits.filter((h) => h.path.includes(id)).map((h) => h.path.split('?')[0]))];
      const shape =
        answer === 'automatic' ? [414, 431].includes(r.status) && r.csp === NOTHING_RUNS_UNFRAMED : r.status === 404 && r.csp === inert;
      const ok = !r.error && shape && hits.length === 0;
      record({
        test: `oversized: the answer to a ${label} is no permissive realm`,
        result: ok ? 'pass' : 'fail',
        notes: `${JSON.stringify(r)}; sentinel saw ${JSON.stringify(hits)}`,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ── the bare-mux SharedWorker's own realm ────────────────────────────────────────────────────────────────────────

/**
 * Code for bare-mux's `set` message (the worker runs it as an AsyncFunction body, as it does for any same-origin
 * client's `setManualTransport`): every way to reach `target` from the worker realm; the outcome comes back as the
 * transport's name.
 */
function injectedTransport(target, id) {
  return `
    const target = ${JSON.stringify(target)}, id = ${JSON.stringify(id)}, out = {};
    try { const s = new WebSocket(target.replace(/^http/, 'ws') + '/ws-inject?' + id); s.onerror = () => {}; out.websocket = 'created'; }
    catch (e) { out.websocket = 'threw ' + e.name; }
    try { await fetch(target + '/fetch-inject?' + id, { mode: 'no-cors' }); out.fetch = 'resolved'; } catch (e) { out.fetch = 'rejected'; }
    try { importScripts(target + '/importscripts-inject.js?' + id); out.importScripts = 'ran'; } catch (e) { out.importScripts = 'threw ' + e.name; }
    try { await import(target + '/import-inject.js?' + id); out.import = 'ran'; } catch (e) { out.import = 'rejected'; }
    return [class { constructor() { this.ready = true; } async init() {} async request() { throw new Error('e2e'); } connect() { throw new Error('e2e'); } meta() { return {}; } }, 'gnome-e2e ' + JSON.stringify(out)];`;
}

async function workerRealm(ctx, sentinel, { customWisp }) {
  const { record, stack } = ctx;
  const browser = await ctx.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const id = `worker-${ctx.browser}-${customWisp}-${Date.now()}`;
    let result;
    try {
      // Any proxy-origin page whose policy may create the worker: the engine host (top level, so it does not start).
      await page.goto(`${stack.proxyOrigin}/engine/`, { waitUntil: 'domcontentloaded' });
      result = await page.evaluate(
        ([code, workerPath]) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ error: 'no answer from the worker' }), 15000);
            const worker = new SharedWorker(workerPath, 'bare-mux-worker');
            const ask = (message) =>
              new Promise((answer) => {
                const ch = new MessageChannel();
                ch.port1.onmessage = (e) => answer(e.data);
                worker.port.postMessage({ message, port: ch.port2 }, [ch.port2]);
              });
            worker.port.start();
            ask({ type: 'set', client: { function: code, args: [] } }).then(async (set) => {
              const got = await ask({ type: 'get' });
              clearTimeout(timer);
              resolve({ set: set?.type, name: got?.name ?? null, error: set?.type === 'error' ? String(set.error).slice(0, 160) : null });
            });
          }),
        [injectedTransport(sentinel.origin, id), '/vendor/bare-mux/worker.js'],
      );
    } catch (e) {
      result = { error: String(e.message || e).slice(0, 160) };
    }
    await sleep(1500);
    const hits = [...new Set(sentinel.hits.filter((h) => h.path.includes(id)).map((h) => h.path.split('?')[0]))];
    const ran = typeof result?.name === 'string' && result.name.startsWith('gnome-e2e ');
    const want = customWisp ? ['/ws-inject'] : [];
    const ok = ran && !result.error && JSON.stringify(hits) === JSON.stringify(want);
    record({
      test: `worker: the bare-mux SharedWorker realm reaches only ${customWisp ? 'ws: (opt-in)' : 'its own origin'} (customWisp=${customWisp})`,
      result: ok ? 'pass' : 'fail',
      notes: `${ran ? result.name.slice('gnome-e2e '.length) : JSON.stringify(result)}; sentinel saw ${JSON.stringify(hits)}, want ${JSON.stringify(want)}`,
    });
    await context.close();
  } finally {
    await browser.close();
  }
}

// ── a custom Wisp server through the real engine host ────────────────────────────────────────────────────────────

async function customServer(ctx, { optIn }) {
  const { record, stack } = ctx;
  const label = `GNOME_ALLOW_CUSTOM_WISP=${optIn}`;
  if (!ctx.openApp || stack.spike) {
    record({ test: `custom: a custom Wisp server (${label})`, result: 'skip', notes: 'needs the real engine host and the e2e driver (run under tests/e2e/engine/run.mjs)' });
    return;
  }
  if (ctx.offline) {
    record({ test: `custom: a custom Wisp server (${label})`, result: 'skip', notes: '--offline' });
    return;
  }
  // HolyWisp of the runner's direct route, addressed directly: a Wisp server that is not the gateway.
  const { PORTS: RUNNER_PORTS } = await import('../lib/config.mjs');
  const server = `ws://127.0.0.1:${RUNNER_PORTS.holywisp}/`;
  const gatewayTotal = async () => (await (await fetch(`${stack.admin}/admin/diagnostics`)).json()).ws?.total ?? null;
  const combos = optIn
    ? [['scramjet', 'libcurl'], ['scramjet', 'epoxy'], ['ultraviolet', 'epoxy'], ['ultraviolet', 'libcurl']]
    : [['scramjet', 'epoxy'], ['ultraviolet', 'epoxy']];
  const browser = await ctx.launch();
  try {
    for (const [engine, transport] of combos) {
      const context = await ctx.newContext(browser);
      let r = null;
      let status = null;
      let error = null;
      const before = await gatewayTotal();
      try {
        const app = await ctx.openApp(context, { engine, transport, route: `custom:${server}`, fallback: 0 });
        r = await app.navigate(1, 'https://example.com/', { engine, create: true, timeout: optIn ? 60_000 : 20_000 });
        status = (await app.cmd('status', {}))?.transport?.[engine] ?? null;
        await app.close();
      } catch (e) {
        error = String(e.message || e).slice(0, 200);
      } finally {
        await context.close();
      }
      const after = await gatewayTotal();
      const loaded = r?.ok === true && r.title === 'Example Domain';
      const custom = status?.endpoint === 'custom';
      const ok = optIn ? loaded && custom && status.state === 'ready' && before === after : !loaded;
      record({
        test: optIn ? `custom: https://example.com/ through a custom Wisp server (${label})` : `custom: a custom Wisp server is blocked by the policies (${label})`,
        engine,
        transport,
        result: ok ? 'pass' : 'fail',
        notes: `loaded ${loaded} (${r?.ms ?? '-'} ms), transport ${JSON.stringify(status && { state: status.state, endpoint: status.endpoint, detail: status.detail })}, gateway connections ${before} -> ${after}${error ? `, ${error}` : ''}${r && !r.ok ? `, ${JSON.stringify(r.error).slice(0, 160)}` : ''}`,
      });
    }
  } finally {
    await browser.close();
  }
}

// ── engine-prefix 503 page ───────────────────────────────────────────────────────────────────────────────────────

async function retryPage(ctx) {
  const { record, stack } = ctx;
  const browser = await ctx.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = [];
    page.on('console', (msg) => {
      // Firefox reports its own favicon request (img-src under default-src 'none'): not the page's doing.
      if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text()) && !/favicon\.ico/.test(msg.text())) violations.push(msg.text().slice(0, 160));
    });
    const res = await page.goto(`${stack.proxyOrigin}/~/sj/retry-check`, { waitUntil: 'domcontentloaded' });
    const status = res?.status();
    let scope = null;
    for (let i = 0; i < 40 && !scope; i++) {
      await sleep(250);
      try {
        scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.scope ?? null);
      } catch {
        /* the page reloads itself */
      }
    }
    record({
      test: 'retry: the engine-prefix 503 page registers /sw.js under its own policy',
      result: status === 503 && scope === `${stack.proxyOrigin}/` && violations.length === 0 ? 'pass' : 'fail',
      notes: `status ${status}, scope ${scope}, violations ${JSON.stringify(violations)}`,
    });
    await context.close();
  } finally {
    await browser.close();
  }
}

// ── the probe's 503 ──────────────────────────────────────────────────────────────────────────────────────────────

async function probe(ctx) {
  const { record, stack } = ctx;
  if (!stack.deadProfile) {
    record({ test: 'probe 503 (VPN profile with a stopped upstream)', result: 'skip', notes: 'no stack.deadProfile' });
    return;
  }
  const browser = await ctx.launch();
  try {
    const context = await browser.newContext();
    const app = await context.newPage();
    await app.goto(`${stack.appOrigin}/api/health`);
    // Route-bound tickets (WAVE-C D23): one minted for the dead profile's route, then a default-route one (minted
    // after it, so the profile mint does not supersede it).
    const mint = (route) =>
      app.evaluate(
        async (r) =>
          (await (await fetch('/api/wisp/ticket', { method: 'POST', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ route: r }) })).json()).ticket,
        route,
      );
    const ticket = await mint({ profile: stack.deadProfile });
    const directTicket = await mint('default');
    // The engine-host document (top level, so it does not start): the probe is a same-origin GET without Origin.
    const host = await context.newPage();
    await host.goto(`${stack.proxyOrigin}/engine/`);
    const probeAt = (route, t) =>
      host.evaluate(async ([r, tk]) => {
        const res = await fetch(`${r}?t=${tk}&/`, { cache: 'no-store' });
        let code = null;
        try {
          code = (await res.json()).error.code;
        } catch {
          /* not JSON */
        }
        return { status: res.status, code, retryAfter: res.headers.get('retry-after') };
      }, [route, t]);
    let down = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 75_000) {
      down = await probeAt(`/wisp/p/${stack.deadProfile}/`, ticket);
      if (down.status === 503) break;
      await sleep(1000);
    }
    record({
      test: 'probe: a route whose upstream is down answers 503 wisp_upstream_unavailable with Retry-After',
      result: down?.status === 503 && down.code === 'wisp_upstream_unavailable' && Number(down.retryAfter) > 0 ? 'pass' : 'fail',
      notes: `${JSON.stringify(down)} after ${Math.round((Date.now() - t0) / 1000)} s`,
    });
    const direct = await probeAt('/wisp/', directTicket);
    record({ test: 'probe: the direct route (upstream up) still answers 426', result: direct.status === 426 ? 'pass' : 'fail', notes: JSON.stringify(direct) });
    const bad = await probeAt(`/wisp/p/${stack.deadProfile}/`, 'w1.1.AAAAAAAAAAAAAAAAAAAAAA.x');
    record({ test: 'probe: a bad ticket on that route is still 401', result: bad.status === 401 && bad.code === 'wisp_ticket_invalid' ? 'pass' : 'fail', notes: JSON.stringify(bad) });
    await context.close();
  } finally {
    await browser.close();
  }
}

// ── __Host- cookies on loopback HTTP ────────────────────────────────────────────────────────────────────────────

async function cookies(ctx) {
  const { record, stack } = ctx;
  const browser = await ctx.launch();
  try {
    for (const origin of stack.cookieOrigins ?? [stack.appOrigin]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${origin}/api/health`);
      const created = await page.evaluate(async () => (await fetch('/api/session', { method: 'POST', headers: { 'X-GNOME-Request': '1' } })).status);
      const jar = await context.cookies(origin);
      const sid = jar.find((c) => c.name === '__Host-gnome_sid');
      const again = await page.evaluate(async () => {
        const r = await fetch('/api/session');
        return { status: r.status, body: await r.json() };
      });
      const readable = await page.evaluate(() => document.cookie);
      const ok = created === 200 && sid?.secure === true && sid.httpOnly && sid.sameSite === 'Strict' && sid.path === '/' && again.status === 200 && readable === '';
      record({
        test: `cookies: ${origin} stores and sends __Host-gnome_sid over plain HTTP`,
        result: ok ? 'pass' : 'fail',
        notes: `POST ${created}, jar ${JSON.stringify(jar.map((c) => ({ n: c.name, s: c.secure, h: c.httpOnly, d: c.domain })))}, GET ${again.status} ${again.body?.session?.kind ?? ''}`,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ── both engines under the default policies (spike engine host) ─────────────────────────────────────────────────

const COMBOS = [
  { engine: 'scramjet', sjt: 'libcurl' },
  { engine: 'scramjet', sjt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'libcurl' },
];

async function engines(ctx, label) {
  const { record, stack } = ctx;
  const { openApp } = await import('../../spike-engine-host/lib/drive.mjs');
  const site = process.env.BACKEND_E2E_SITE ?? 'https://example.com/';
  const browser = await ctx.launch();
  try {
    for (const combo of COMBOS) {
      const transport = combo.sjt ?? combo.uvt;
      const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      try {
        const app = await openApp(context, { ...combo, ticketForm: 'query+amp-slash', fallback: 0 }, { origin: stack.appOrigin, timeout: 60_000 });
        const r = await app.navigate(1, site, { create: true, engine: combo.engine, timeout: 45_000 });
        const ok = r.ok && (site !== 'https://example.com/' || r.title === 'Example Domain');
        record({ test: `engines: ${site} (${label})`, engine: combo.engine, transport, result: ok ? 'pass' : 'fail', notes: ok ? `${r.ms} ms, "${r.title}"` : JSON.stringify(r.error).slice(0, 300) });
      } catch (e) {
        record({ test: `engines: ${site} (${label})`, engine: combo.engine, transport, result: 'fail', notes: String(e.message || e).slice(0, 300) });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// ── stack-qa.mjs ─────────────────────────────────────────────────────────────────────────────────────────────────

async function stackQa(stack) {
  // stack-qa checks a fetched filter list: the server's first refresh runs 10 s after start, or (servers started with
  // GNOME_FILTERS_REFRESH_HOURS=0) when the admin listener asks for one.
  const t0 = Date.now();
  let asked = false;
  while (Date.now() - t0 < 120_000) {
    if (!asked && stack.admin && Date.now() - t0 > 3000) {
      asked = true;
      await fetch(`${stack.admin}/admin/filters/refresh`, { method: 'POST', headers: { 'X-GNOME-Request': '1' } }).catch(() => {});
    }
    try {
      const idx = await (await fetch(`${stack.appOrigin}/api/filters`)).json();
      if (idx.lists?.some((l) => l.available)) break;
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  return new Promise((resolve) => {
    const env = { ...process.env, GNOME_QA_APP: stack.appOrigin, GNOME_QA_PROXY: stack.proxyOrigin, ...(stack.admin ? { GNOME_QA_ADMIN: stack.admin } : {}) };
    const p = spawn(process.execPath, [path.join(E2E, 'stack', 'stack-qa.mjs')], { env, cwd: E2E, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => {
      const passed = (out.match(/^ {2}✓/gm) ?? []).length;
      const failed = out.split('\n').filter((l) => l.startsWith('  ✗'));
      resolve({ ok: code === 0, summary: `${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join(' | ').slice(0, 600)}` : ''}`, out });
    });
  });
}

// ── standalone driver ────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  if (args.flags.has('--write-fixture')) {
    const m = await loadContract();
    writeFileSync(FIXTURE, `${JSON.stringify(fixtureFrom(m), null, 2)}\n`);
    console.log(`wrote ${path.relative(REPO, FIXTURE)}`);
    return;
  }
  installSignalHandlers();
  const dir = workDir(`proxy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const staticDir = args.static ?? (await prepareSpikeStatic(path.join(dir, 'static')));
  const spike = !args.static;
  const profiles = path.join(dir, 'profiles.toml');
  writeFileSync(profiles, `[[profile]]\nid = "dead"\nlabel = "Stopped upstream"\ncountry_code = "se"\ncountry = "Sweden"\ncity = "Gothenburg"\nwisp_upstream = "127.0.0.1:${PORTS.deadUpstream}"\n`);
  const appOrigin = `http://127.0.0.1:${PORTS.app}`;
  const appOrigins = [appOrigin, `http://localhost:${PORTS.app}`];
  const baseEnv = { GNOME_PUBLIC_ORIGINS: appOrigins.join(','), GNOME_VPN_PROFILES: profiles };
  await startHolyWisp(PORTS.holywisp, dir);
  const sentinel = await startSentinel();
  // The first server fetches the filter lists (stack-qa checks one); the restarts do not need them.
  const withQa = !args.parts || args.parts.includes('stackqa');
  let server = await startGnomeServer({ dir, staticDir, env: { ...baseEnv, ...(withQa ? { GNOME_FILTERS_REFRESH_HOURS: '24' } : {}) }, label: 'server-0' });
  let restarts = 0;
  const stack = {
    appOrigin,
    proxyOrigin: server.proxyOrigin,
    appOrigins,
    cookieOrigins: appOrigins,
    admin: server.adminOrigin,
    sentinel,
    deadProfile: 'dead',
    spike,
    restartServer: async (env = {}) => {
      await server.stop();
      server = await startGnomeServer({ dir, staticDir, env: { ...baseEnv, ...env }, label: `server-${++restarts}` });
    },
  };
  const all = [];
  try {
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows, record } = recorder(name);
      const ctx = {
        browser: name,
        firstBrowser: args.browsers[0],
        suite: 'backend-proxy',
        runDir: dir,
        parts: args.parts,
        launch: (opts) => launchBrowser(name, opts),
        newContext: (b) => b.newContext({ viewport: { width: 1280, height: 860 } }),
        record,
        log: (...msg) => console.log('   ', ...msg),
        sleep,
        stack,
      };
      try {
        await run(ctx);
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...rows);
    }
  } finally {
    await cleanupAll();
  }
  writeResults(dir, 'backend-proxy', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  await assertPortsFree();
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
