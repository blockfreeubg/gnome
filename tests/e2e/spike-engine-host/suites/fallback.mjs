// Item 6 (spike-transport-fallback): Scramjet and Ultraviolet side by side in one engine host and one SW, and the
// controlled fallback: a navigation that fails on Scramjet is retried ONCE on UV with the same destination.
// Lists every detection signal with its latency (stats.counters.signals of the engine host).
// Local cases go to the target through /wisp/p/test-loopback/; the DNS cases use the real /wisp/ route.
import { TARGET_ORIGIN } from '../lib/config.mjs';

let n = 0;
const T = (path) => `${TARGET_ORIGIN}${path}${path.includes('?') ? '&' : '?'}fb=${++n}`;
const NX = () => `https://gnome-spike-nx-${Date.now().toString(36)}.invalid/`;

async function signalsSince(app, t) {
  return (await app.stats()).counters.signals.filter((s) => s.t >= t).map((s) => ({ engine: s.engine, signal: s.signal, latency: s.latency, detail: s.detail ? String(s.detail).slice(0, 100) : undefined }));
}
const sig = (list) => list.map((s) => `${s.engine}:${s.signal}${s.latency != null ? `@${s.latency}ms` : ''}`).join(' -> ') || 'none';
// Content checks use the harness logs, not the proxied frame (Playwright's frame.evaluate hangs in Firefox after
// location.replace() navigations): the target served the path since `since`, and the tab title is the target's.
let CTX = null;
const tmo = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer within ${ms} ms (${label})`)), ms))]);
function served(path, since) {
  return CTX.events.filter((e) => e.from === 'target' && e.type === 'target-request' && e.path === path && e.at >= since);
}
async function lastTitle(app, tab) {
  return tmo(app.gnome((t) => window.gnomeTest.events.filter((e) => e.type === 'tab.title' && e.p.tabId === t).pop()?.p.title ?? null, tab), 10000, 'title');
}
async function hello(app, tab, since) {
  return served('/', since).length > 0 && (await lastTitle(app, tab)) === 'GNOME spike target';
}

async function withApp(ctx, browser, query, fn) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, query);
    await fn(app);
  } catch (e) {
    ctx.record({ engine: 'scramjet', transport: 'libcurl', test: `fallback (${JSON.stringify(query)})`, result: 'fail', notes: String(e.stack || e).slice(0, 400) });
  } finally {
    await tmo(context.close(), 15000, 'context.close').catch((e) => ctx.log(e.message));
  }
}

export async function run(ctx) {
  CTX = ctx;
  const browser = await ctx.launch();
  const rec = (row) => ctx.record({ engine: 'scramjet→ultraviolet', transport: 'libcurl / epoxy', ...row });
  try {
    // One SW for both engines.
    await withApp(ctx, browser, { route: 'test' }, async (app) => {
      const t0 = Date.now();
      const a = await app.navigate(1, T('/'), { create: true, engine: 'scramjet' });
      const b = await app.navigate(2, T('/'), { create: true, engine: 'ultraviolet' });
      const engineFrame = app.page.frames().find((f) => f.url().endsWith('/engine/'));
      const regs = await tmo(engineFrame.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: r.active && r.active.scriptURL }))), 10000, 'registrations');
      const ok = a.ok && b.ok && (await hello(app, 1, t0)) && (await hello(app, 2, t0)) && regs.length === 1;
      rec({ engine: 'scramjet + ultraviolet', test: 'side by side: one engine host, one SW', result: ok ? 'pass' : 'fail', notes: `scramjet ${a.ok ? `${a.ms} ms` : 'FAILED'}, ultraviolet ${b.ok ? `${b.ms} ms` : 'FAILED'} in two tabs at once; registrations ${JSON.stringify(regs)}` });
    });

    // Signal 1: Scramjet error hook (frame.hooks.error.request) -> retry on UV, same destination; cookies carried.
    await withApp(ctx, browser, { route: 'test', fault: 'sj-throw-marker' }, async (app) => {
      const set = await app.navigate(1, T('/cookies/set?carried=yes'), { create: true });
      const url = T('/cookies?gnome-fault=sj-throw');
      const t0 = Date.now();
      const r = await app.navigate(1, url, { timeout: 30000 });
      const sigs = await signalsSince(app, t0);
      const sameDest = r.committed?.url === url;
      const cookies = served('/cookies', t0).pop()?.cookieNames || [];
      const ok = r.ok && r.engine === 'ultraviolet' && r.switched.length === 1 && r.switched[0].reason === 'error-hook' && sameDest;
      rec({ test: 'fallback on Scramjet error hook (injected throw)', result: ok ? 'pass' : 'fail', notes: `${r.ok ? `loaded on ${r.engine} after ${r.ms} ms` : `FAILED ${JSON.stringify(r.error)}`}; switched ${JSON.stringify(r.switched.map((s) => [s.reason, s.latency]))}; same destination ${sameDest}; signals ${sig(sigs)}`, data: { sigs, r: { ms: r.ms, committed: r.committed } } });
      rec({ test: 'fallback carries Scramjet cookies to UV', result: set.ok && cookies.includes('carried') && cookies.includes('srvhttp') ? 'pass' : 'fail', notes: `the target received (via UV) cookies ${JSON.stringify(cookies)} (HttpOnly srvhttp ${cookies.includes('srvhttp') ? 'carried' : 'not carried'})` });
      const back = await app.navigate(1, T('/'), {});
      rec({ test: 'next user navigation returns to Scramjet', result: back.ok && back.engine === 'scramjet' ? 'pass' : 'fail', notes: `engine ${back.engine}, ${back.ok ? `${back.ms} ms` : JSON.stringify(back.error)}` });
    });

    // A failed POST navigation must NOT be retried on UV: the fallback re-sends the destination as a GET (a different
    // request), and after a timeout it would submit the form twice. Expected: no switch, a final error with
    // fallback 'available' (the user can retry in the other engine), and no request to /post at all.
    await withApp(ctx, browser, { route: 'test', fault: 'sj-throw-marker' }, async (app) => {
      const form = await app.navigate(1, T('/form-fault'), { create: true });
      const t0 = Date.now();
      const since = await app.mark();
      if (form.ok) await tmo(app.tabFrame(1).click('#submit'), 10000, 'submit');
      const end = await app.waitFor(since, (e) => (e.type === 'tab.error' || e.type === 'tab.loaded') && e.p.tabId === 1, 15000);
      const switched = (await app.eventsSince(since)).filter((e) => e.type === 'tab.engineSwitched');
      const posts = served('/post', t0).map((e) => e.method);
      const ok = form.ok && end?.type === 'tab.error' && end.p.fallback === 'available' && !switched.length && posts.length === 0;
      rec({ test: 'failed POST navigation is not retried on UV', result: ok ? 'pass' : 'fail', notes: `${form.ok ? '' : 'form page FAILED; '}end ${end ? `${end.type} ${JSON.stringify({ kind: end.p.kind, fallback: end.p.fallback, detail: String(end.p.detail).slice(0, 90) })}` : 'none'}; switched ${switched.length}; requests to /post ${JSON.stringify(posts)}` });
    });

    // Signal 2: dead Scramjet transport (rejected ticket) with the watchdog off -> what fires, and when?
    await withApp(ctx, browser, { route: 'test', fault: 'sj-transport-dead', watchdog: '0', navTimeout: '10000' }, async (app) => {
      const url = T('/');
      const t0 = Date.now();
      const r = await app.navigate(1, url, { create: true, timeout: 40000 });
      const sigs = await signalsSince(app, t0);
      const ok = r.ok && r.engine === 'ultraviolet' && (await hello(app, 1, t0)) && r.committed?.url === url;
      rec({ test: 'fallback on dead Scramjet transport (Wisp 401)', result: ok ? 'pass' : 'fail', notes: `${r.ok ? `loaded on ${r.engine} after ${r.ms} ms` : `FAILED ${JSON.stringify(r.error)}`}; switched ${JSON.stringify(r.switched.map((s) => [s.reason, s.latency, String(s.detail).slice(0, 80)]))}; signals ${sig(sigs)}`, data: { sigs } });
    });

    // Signal 3: navigation timeout (site never answers): Scramjet times out, UV is tried once, then a final error.
    await withApp(ctx, browser, { route: 'test', navTimeout: '4000' }, async (app) => {
      const url = T('/hang');
      const t0 = Date.now();
      const r = await app.navigate(1, url, { create: true, timeout: 20000 });
      const sigs = await signalsSince(app, t0);
      const ok = !r.ok && r.switched.length === 1 && r.switched[0].reason === 'timeout' && r.error?.fallback === 'attempted' && r.error?.engine === 'ultraviolet';
      rec({ test: 'timeout: one retry on UV, then a final error', result: ok ? 'pass' : 'fail', notes: `final ${JSON.stringify({ kind: r.error?.kind, engine: r.error?.engine, fallback: r.error?.fallback, signal: r.error?.signal })} after ${r.ms} ms; signals ${sig(sigs)}`, data: { sigs } });
    });

    // Not a failure: an HTTP 404 document must not trigger a fallback.
    await withApp(ctx, browser, { route: 'test' }, async (app) => {
      const r = await app.navigate(1, T('/no-such-page'), { create: true });
      rec({ test: 'HTTP 404 page is not an engine failure', result: r.ok && r.engine === 'scramjet' && !r.switched.length ? 'pass' : 'fail', notes: `engine ${r.engine}, switched ${r.switched.length}, ${r.ok ? `${r.ms} ms` : JSON.stringify(r.error)}` });
    });

    // Signal 4: Scramjet init failure (rewriter wasm missing) -> every navigation goes straight to UV.
    await withApp(ctx, browser, { route: 'test', fault: 'sj-wasm-missing' }, async (app) => {
      const sj = app.init.engines.scramjet;
      const t0 = Date.now();
      const r = await app.navigate(1, T('/'), { create: true });
      const ok = sj.state === 'failed' && r.ok && r.engine === 'ultraviolet' && !r.switched.length && (await hello(app, 1, t0));
      rec({ test: 'Scramjet init failure -> UV for every navigation', result: ok ? 'pass' : 'fail', notes: `scramjet ${sj.state} (${sj.detail}) detected in ${app.init.timings.scramjet} ms of init; navigation on ${r.engine} ${r.ok ? `${r.ms} ms` : JSON.stringify(r.error)}` });
    });

    // Signal 5: DNS failure on the real route: Scramjet error -> UV error page -> final error with kind dns.
    await withApp(ctx, browser, {}, async (app) => {
      const url = NX();
      const t0 = Date.now();
      const r = await app.navigate(1, url, { create: true, timeout: 60000 });
      const sigs = await signalsSince(app, t0);
      const ok = !r.ok && r.switched.length === 1 && r.error?.fallback === 'attempted' && r.error?.kind === 'dns';
      // Known gap: HolyWisp's Wisp CLOSE reason (0x42 unreachable) never reaches the page; the transports report a
      // connect/TLS error instead, so kind 'dns' cannot be derived from the error text (expectFail documents it).
      rec({ test: 'DNS failure: Scramjet error -> UV retry -> final dns error', result: ok ? 'pass' : 'fail', expectFail: !ok && r.switched.length === 1 && r.error?.fallback === 'attempted', notes: `details ${JSON.stringify(sigs.map((x) => x.detail).filter(Boolean))}; ` + `switched ${JSON.stringify(r.switched.map((s) => [s.reason, s.latency]))}; final ${JSON.stringify({ kind: r.error?.kind, engine: r.error?.engine, fallback: r.error?.fallback, signal: r.error?.signal, latency: r.error?.latency })} after ${r.ms} ms; signals ${sig(sigs)}`, data: { sigs } });
      // UV alone: which signal comes first, the SW transport error (bus) or the #errorTrace page?
      const t1 = Date.now();
      const u = await app.navigate(2, NX(), { create: true, engine: 'ultraviolet', timeout: 60000 });
      const usigs = await signalsSince(app, t1);
      ctx.record({ engine: 'ultraviolet', transport: 'epoxy', test: 'UV failure signals (DNS)', result: !u.ok && u.error?.signal === 'uv-error-page' ? 'pass' : 'fail', notes: `final ${u.error?.kind}/${u.error?.signal} after ${u.ms} ms; signals ${sig(usigs)}`, data: { usigs } });
      const t2 = Date.now();
      const s = await app.navigate(3, NX(), { create: true, engine: 'scramjet', timeout: 60000 });
      const ssigs = await signalsSince(app, t2);
      ctx.record({ engine: 'scramjet', transport: 'libcurl', test: 'Scramjet failure signals (DNS, forced engine: no fallback)', result: !s.ok && s.error?.fallback === 'available' ? 'pass' : 'fail', notes: `final ${s.error?.kind}/${s.error?.signal} fallback=${s.error?.fallback} after ${s.ms} ms; signals ${sig(ssigs)}`, data: { ssigs } });
    });
  } finally {
    await browser.close();
  }
}
