// Lane x1 (docs/WAVE-B3.md §12.2 "Ultraviolet specifics", rows V1–V10), Ultraviolet only: the service worker's half of
// the blocker (§4.5, D15). Parts: restart (V1), nested (V2), union (V3), toptype (V4), contexts (V5–V9), limit (V10), params (V11).
import { applyBlocker, blockedOf, blockerSettings, clickIn, listRefs, openBlockerApp, pageOut, partOn, waitBlocker } from './blocker-network.mjs';

export async function run(ctx) {
  const bk = ctx.stack.blocker;
  if (!bk || bk.mode !== 'test') {
    ctx.record({ test: 'blocker-uv', result: 'skip', notes: 'needs the test lists' });
    return;
  }
  const refs = await listRefs(ctx);
  const base = blockerSettings(refs);
  const rec = (test, r) => ctx.record({ test, engine: 'ultraviolet', transport: 'libcurl', ...r });
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const app = await openBlockerApp(ctx, context, { engine: 'ultraviolet' });
    await applyBlocker(app, base);
    await waitBlocker(app);
    let id = 500;
    const load = async (url) => {
      const tab = id++;
      const s = await app.mark();
      const nav = await app.navigate(tab, url, { engine: 'ultraviolet', create: true, timeout: 45_000 });
      const out = nav.ok ? await pageOut(app, tab, 40_000) : null;
      await ctx.sleep(700);
      return { tab, s, nav, out, blocked: await blockedOf(app, s, tab) };
    };
    const close = (t) => app.cmd('tab.close', { tabId: t }).catch(() => null);

    if (partOn(ctx, 'contexts')) {
      const r = await load(bk.url('site-a', '/network/uvctx.html?p=v5,v7,v8,v9'));
      await close(r.tab);
      const o = r.out ?? {};
      const inner = (() => {
        try {
          return JSON.parse(o.v5 ?? 'null');
        } catch {
          return null;
        }
      })();
      rec('V5 an iframe with referrerpolicy=no-referrer: its third-party ad request is still blocked', { result: inner && inner.ad === 0 ? 'pass' : 'fail', notes: `frame ${o.v5}` });
      rec('V7 about:blank and srcdoc frames: their ad requests are blocked', { result: o.v7blank === 'error' && o.v7srcdoc === 'error' ? 'pass' : 'fail', notes: `blank ${o.v7blank}; srcdoc ${o.v7srcdoc}` });
      // Firefox × Ultraviolet: dedicated workers do not start at all (step 2's known engine limit, README "workers
      // error in Firefox"), so there is no worker request to judge; recorded, not passed.
      const v8 = /^(status:403|error:)/.test(String(o.v8)) && o.v8shared !== 'shared worker ran';
      const noWorker = ctx.browser === 'firefox' && o.v8 === 'worker error' && o.v8shared !== 'shared worker ran';
      rec('V8 a dedicated worker’s fetch is blocked; a shared worker is refused by GNOME’s SW', {
        result: v8 ? 'pass' : noWorker ? 'skip' : 'fail',
        notes: `worker ${o.v8}; shared ${o.v8shared}${noWorker ? ' (Firefox × Ultraviolet: the dedicated worker never starts, a known engine limit: nothing to judge)' : ''}`,
      });
      rec('V9 fetch() with a chosen referrer (another proxied page) does not pick its policy: still blocked', { result: o.v9 === 403 || /^error/.test(String(o.v9)) ? 'pass' : 'fail', notes: `status ${o.v9}; tab.blocked ${JSON.stringify(r.blocked)}` });
      const t0 = Date.now();
      const p6 = await load(bk.url('site-a', `/policy?referrer=no-referrer&script=${encodeURIComponent(bk.url('ads', '/network/ad.js'))}`));
      await close(p6.tab);
      const adReq = bk.fixtures.requests({ since: t0, label: 'ads' }).filter((q) => /ad\.js/.test(q.path)).length;
      rec('V6 a page served with Referrer-Policy: no-referrer: its third-party ad script is blocked (never requested)', { result: adReq === 0 && (p6.blocked?.byCategory?.ads ?? 0) >= 1 ? 'pass' : 'fail', notes: `ad.js requests ${adReq}; tab.blocked ${JSON.stringify(p6.blocked)}` });
    }

    if (partOn(ctx, 'toptype')) {
      const target = bk.url('docblock', '/network/page.html');
      const r = await load(bk.url('site-a', `/network/page.html?p=link&to=${encodeURIComponent(target)}`));
      const s = await app.mark();
      await clickIn(app, r.tab, '#link');
      const err = await app.waitFor(s, (e) => e.type === 'tab.error' && e.p.tabId === r.tab, 20_000).catch(() => null);
      const commits = (await app.eventsSince(s)).filter((e) => e.type === 'tab.committed' && e.p.tabId === r.tab && e.p.url.includes('docblock'));
      await close(r.tab);
      const navApi = (await app.cmd('diagnostics', {}).catch(() => null)) !== null;
      rec('V4 a UV tab-top navigation by link is main_frame: a $document rule blocks it, no commit', { result: err?.p?.kind === 'blocked' && commits.length === 0 ? 'pass' : 'fail', notes: `tab.error ${JSON.stringify(err?.p ?? null)}; commits ${commits.length}; ${ctx.browser === 'firefox' ? 'Firefox 157 has no Navigation API: the link is announced by … nothing (UV beforeunload has no URL); recorded' : 'Navigation API'}${navApi ? '' : ''}` });
    }

    if (partOn(ctx, 'params')) {
      // V11: a UV tab-top link whose tracking parameters the SW strips (its own 307, D13; the built-in table) is counted
      // `urlparams` for its tab (uv-blocked under the URL the engine host announced), and the hop after the 307 is the
      // tab's own document.
      await applyBlocker(app, blockerSettings(refs, { privacy: { stripTrackingParams: true }, enabled: { privacy: true } }));
      const tracked = bk.url('site-a', '/network/page.html?utm_source=v11&fbclid=x&id=11');
      const r = await load(bk.url('site-b', `/network/page.html?p=link&to=${encodeURIComponent(tracked)}`));
      const s = await app.mark();
      await clickIn(app, r.tab, '#link');
      const loaded = await app.waitFor(s, (e) => e.type === 'tab.loaded' && e.p.tabId === r.tab && /site-a\.localhost/.test(e.p.url ?? ''), 20_000).catch(() => null);
      await ctx.sleep(1500); // uv-blocked batches (250 ms) and tab.blocked coalescing (500 ms)
      const evs = await app.eventsSince(s);
      const commits = evs.filter((e) => e.type === 'tab.committed' && e.p.tabId === r.tab && e.p.kind !== 'same-document');
      const lastCommit = evs.lastIndexOf(commits.at(-1));
      const after = evs.slice(lastCommit + 1).filter((e) => e.type === 'tab.blocked' && e.p.tabId === r.tab).pop()?.p ?? null;
      const before = evs.slice(0, lastCommit).filter((e) => e.type === 'tab.blocked' && e.p.tabId === r.tab).map((e) => e.p.byCategory);
      await close(r.tab);
      await applyBlocker(app, base);
      const url = commits.at(-1)?.p.url ?? null;
      rec('V11 a UV tab-top link stripped of tracking parameters: the clean page commits and urlparams is counted for its tab', {
        result: loaded && url === bk.url('site-a', '/network/page.html?id=11') && (after?.byCategory?.urlparams ?? 0) >= 1 ? 'pass' : 'fail',
        notes: `committed ${url}; tab.blocked after the commit ${JSON.stringify(after)} (before it ${JSON.stringify(before)}); loaded ${!!loaded}`,
      });
    }

    if (partOn(ctx, 'union')) {
      // V3: two engine hosts (two GNOME tabs) share the SW; only the second exposed allowlisted site-a.
      const app2 = await openBlockerApp(ctx, context, { engine: 'ultraviolet' });
      await applyBlocker(app2, blockerSettings(refs, { allowlist: ['*.site-a.localhost'] }));
      await waitBlocker(app2);
      await applyBlocker(app, base); // the first host's newest config: no allowlist
      const r = await load(bk.url('site-a', '/network/page.html?p=ad'));
      await close(r.tab);
      rec('V3 two GNOME tabs, one exposed allowlisted site-a: exempt in UV pages of both (the SW\'s union)', { result: r.out?.ad === 'load' ? 'pass' : 'fail', notes: `first host's page ${JSON.stringify(r.out)}` });
      await app2.close().catch(() => null);
    }

    if (partOn(ctx, 'restart')) {
      // V1: the SW restarts (Chromium: stopped through CDP; Firefox: idle past its timeout, ~30 s without events). The
      // first UV page after it: privacy headers and cookie modes apply from its first request (the user's settings and
      // the schema defaults agree here: GPC on, block-third-party, D7), and its requests are list-judged once the
      // engines arrive (sw-hello → config; the UV load → engines; context), else recorded as failed open.
      const gpc = blockerSettings(refs, { privacy: { sendGpc: true, cookies: 'block-third-party' }, enabled: { privacy: true, cookies: true } });
      await applyBlocker(app, gpc);
      const ck = await load(bk.url('site-b', '/set-cookie?v1c=1'));
      await close(ck.tab);
      const starts = async () => (await app.cmd('diagnostics', {}).catch(() => null))?.sw?.starts ?? null;
      const before = await starts();
      let how;
      if (ctx.browser === 'chromium') {
        const cdp = await context.newCDPSession(app.page);
        await cdp.send('ServiceWorker.enable');
        const versions = [];
        cdp.on('ServiceWorker.workerVersionUpdated', (e) => versions.push(...e.versions));
        await ctx.sleep(500);
        const v = versions.find((x) => x.runningStatus === 'running');
        if (v) await cdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
        await ctx.sleep(800);
        how = v ? `stopped through CDP (${v.versionId})` : 'no running worker found';
      } else {
        // nothing reaches the SW meanwhile (no tab, no command that touches it)
        await ctx.sleep(40_000);
        how = 'idle 40 s';
      }
      const t0 = Date.now();
      const r = await load(bk.url('site-a', '/network/page.html?p=ad,echob'));
      await close(r.tab);
      const after = await starts();
      const reqs = bk.fixtures.requests({ since: t0 });
      const docReq = reqs.find((q) => q.label === 'site-a' && q.path === '/network/page.html');
      const echoReq = reqs.find((q) => q.label === 'site-b' && q.path === '/echo' && /echob/.test(q.search));
      const hdr = (q, n) => (q ? (Array.isArray(q.headers[n]) ? q.headers[n].join(', ') : (q.headers[n] ?? null)) : undefined);
      const restarted = after !== null && before !== null && after > before;
      // control: the cookie exists (a site-b page's own request carries it)
      const t1 = Date.now();
      const own = await load(bk.url('site-b', '/network/page.html?p=echoself'));
      await close(own.tab);
      const ownReq = bk.fixtures.requests({ since: t1 }).find((q) => q.label === 'site-b' && q.path === '/echo' && /echoself/.test(q.search));
      const stored = /v1c=1/.test(hdr(ownReq, 'cookie') ?? '');
      const privacy = stored && hdr(docReq, 'sec-gpc') === '1' && hdr(echoReq, 'sec-gpc') === '1' && !/v1c=/.test(hdr(echoReq, 'cookie') ?? '');
      await applyBlocker(app, base);
      rec('V1 SW restart: privacy headers and cookie modes from the first request; list-judged once the engines arrive', {
        result: restarted && privacy && r.out?.ad === 'error' ? 'pass' : 'fail',
        notes: `${how}; SW starts ${before} → ${after}; first request Sec-GPC ${hdr(docReq, 'sec-gpc')}; third-party fetch Sec-GPC ${hdr(echoReq, 'sec-gpc')}, Cookie ${JSON.stringify(hdr(echoReq, 'cookie'))} (site-b's own request: ${JSON.stringify(hdr(ownReq, 'cookie'))}); ad script ${r.out?.ad} (${r.out?.ad === 'error' ? 'list-judged' : 'FAILED OPEN'}); page in ${Date.now() - t0} ms`,
      });
    }

    if (partOn(ctx, 'nested')) {
      // V2: 20 nested frames of an ads.localhost page, each loading a script of its own host. The SW judges a request
      // whose page context it does not know as third-party (D15): only then does ||ads.localhost^$third-party block that
      // first-party script, so the scripts that did not run are the requests judged with unknown context. Twice: a
      // fresh page, and the same chain again in the next tab.
      const runs = [];
      for (let i = 0; i < 2; i++) {
        const r = await load(bk.url('ads', '/network/v2.html?d=20&top=1'));
        await close(r.tab);
        const frames = Array.isArray(r.out?.frames) ? r.out.frames : [];
        // A frame whose document cannot be read did not load (Firefox: Gecko refuses frames 10 levels below the app
        // page; app page → engine iframe → tab iframe → 7 nested frames); only loaded frames made the request.
        const loaded = frames.filter((f) => f && typeof f === 'object');
        const deepestUnloaded = frames.length > 0 && !(frames.at(-1) && typeof frames.at(-1) === 'object') && loaded.length === frames.length - 1;
        runs.push({ top: r.out?.ran ?? null, frames: frames.length, loaded: loaded.length, unknown: loaded.filter((f) => f.ran !== 1).length + (r.out?.ran === 1 ? 0 : 1), limit: frames.length < 20 && deepestUnloaded ? frames.length : null });
      }
      const requests = runs.reduce((n, x) => n + x.loaded + 1, 0);
      const unknown = runs.reduce((n, x) => n + x.unknown, 0);
      // 20 nested frames, or (Firefox) as deep as the browser lets frames nest, recorded
      const deep = runs.every((x) => x.frames === 20 || (ctx.browser === 'firefox' && x.limit !== null && x.loaded >= 5));
      rec('V2 20 nested frames: ≤ 5 % of requests judged with unknown context', {
        result: deep && unknown / requests <= 0.05 ? 'pass' : 'fail',
        notes: `${unknown} of ${requests} first-party requests judged as third-party (unknown context); per page ${JSON.stringify(runs)}${runs.some((x) => x.limit !== null) ? `; this browser loads no frame deeper than ${runs.map((x) => x.loaded).join('/')} nested frames inside a GNOME tab` : ''}`,
      });
    }
    if (partOn(ctx, 'limit')) {
      // V10: a set larger than cacheLimitMB is never cached; the SW still gets it by message (it never reads the cache),
      // so UV pages are filtered by it: a host only the big list names is blocked. Its own browser context: a SW that
      // has no engines yet.
      const context10 = await ctx.newContext(browser);
      try {
        const app10 = await openBlockerApp(ctx, context10, { engine: 'ultraviolet', blockerKey: 'f00d'.padEnd(64, '1') });
        const big = await listRefs(ctx, { extra: ['big'] });
        await applyBlocker(app10, blockerSettings(big, { cacheLimitMB: 16 }));
        const ready = await waitBlocker(app10, { timeout: 120_000 });
        const stats = await app10.cmd('blocker.stats', {}).catch((e) => ({ error: String(e) }));
        const total = (stats?.engines ?? []).reduce((n, g) => n + g.bytes, 0);
        const t0 = Date.now();
        const tab = 700;
        const nav = await app10.navigate(tab, bk.url('site-a', '/network/page.html?p=big,ad'), { engine: 'ultraviolet', create: true, timeout: 45_000 });
        const out = nav.ok ? await pageOut(app10, tab, 40_000) : null;
        const reached = bk.fixtures.requests({ since: t0 }).filter((q) => /^big-/.test(q.host ?? '')).length;
        const ok = ready.ok && /^over-cache-limit:/.test(ready.status?.detail ?? '') && stats?.cache?.entries === 0 && total > 16 * 1024 * 1024 && out?.big?.status === 403 && out?.bigXhr?.status === 403 && out?.ad === 'error' && reached === 0;
        rec('V10 a set larger than cacheLimitMB: UV pages still filtered (engines by message)', {
          result: ok ? 'pass' : 'fail',
          notes: `set ${total} bytes; status ${JSON.stringify(ready.status)} after ${ready.ms} ms; cache ${JSON.stringify(stats?.cache)}; page ${JSON.stringify(out)}; big-* requests that reached the fixture server ${reached}`,
        });
        await app10.close().catch(() => null);
      } finally {
        await context10.close().catch(() => null);
      }
    }
    await app.close();
    await context.close();
  } finally {
    await browser.close();
  }
}
