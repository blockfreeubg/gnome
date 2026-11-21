// Item 2 (spike-core): navigation through both engines over a real HolyWisp. Real sites go through /wisp/
// (services/holywisp/gnome.conf); deterministic checks use the local target through the TEST-ONLY route
// /wisp/p/test-loopback/. Scramjet and Ultraviolet run in parallel (one browser context each per route).
import fs from 'node:fs';
import { TARGET_ORIGIN, PORTS } from '../lib/config.mjs';
import { readOut, bodyText } from '../lib/drive.mjs';

const j = (v) => JSON.stringify(v);
const DEFAULT_TRANSPORT = { scramjet: 'libcurl', ultraviolet: 'epoxy' };
const ALT_TRANSPORT = { scramjet: 'epoxy', ultraviolet: 'libcurl' };
const short = (r) => (r.ok ? `${r.ms} ms` : j(r.error).slice(0, 220));

// Wait for an in-page navigation (link click, form submit) to commit a URL matching `pred`.
async function waitCommit(app, tabId, since, pred, timeout = 30000) {
  return app.waitFor(since, (e) => (e.type === 'tab.committed' && e.p.tabId === tabId && pred(e.p.url)) || (e.type === 'tab.error' && e.p.tabId === tabId), timeout);
}

async function realSites(ctx, engine) {
  const transport = DEFAULT_TRANSPORT[engine];
  const rec = (test, ok, notes) => ctx.record({ engine, transport, test, result: ok ? 'pass' : 'fail', notes });
  const context = await ctx.newContext(ctx.browserHandle);
  try {
    const app = await ctx.openApp(context, {});
    let n = 0;
    const go = (url, timeout = 60000) => app.navigate(++n, url, { engine, create: true, timeout });

    const ex = await go('https://example.com/');
    rec('example.com', ex.ok && ex.title === 'Example Domain' && ex.committed?.url === 'https://example.com/', `${short(ex)}; title ${j(ex.title)}`);

    const wp = await go('https://en.wikipedia.org/wiki/Gnome');
    const wpText = wp.ok ? await bodyText(app, n) : '';
    rec('en.wikipedia.org/wiki/Gnome', wp.ok && /Gnome/.test(wp.title || '') && /folklore|mythology/i.test(wpText || ''), `${short(wp)}; title ${j(wp.title)}`);
    if (wp.ok) {
      const t0 = Date.now();
      const f = await app.cmd('tab.find', { tabId: n, query: 'gnome' }).catch((e) => ({ error: e.message }));
      const ms = Date.now() - t0;
      await app.cmd('tab.findClear', { tabId: n }).catch(() => {});
      rec('find in page on Wikipedia', f.matches > 20 && f.highlights === true, `"gnome": ${f.matches ?? f.error} matches in ${ms} ms (round trip), highlights ${f.highlights}`);
    }

    const gh = await go('https://github.com/MercuryWorkshop/scramjet', 90000);
    await app.waitFor(0, (e) => e.type === 'tab.title' && e.p.tabId === n && /scramjet/i.test(e.p.title), 15000);
    const ghTitle = await app.tabFrame(n)?.evaluate(() => document.title).catch(() => null);
    rec('github.com/MercuryWorkshop/scramjet', gh.ok && /scramjet/i.test(ghTitle || ''), `${short(gh)}; title ${j(ghTitle)}`);

    // Cookie round trip: Set-Cookie on a 302, then a separate navigation sends it back.
    const tag = `${engine}-${Date.now() % 100000}`;
    const c1 = await go(`https://httpbin.org/cookies/set?gnome=${tag}`);
    const t1 = c1.ok ? await bodyText(app, n) : '';
    const c2 = await go('https://httpbin.org/cookies');
    const t2 = c2.ok ? await bodyText(app, n) : '';
    rec('httpbin cookie round trip', c1.ok && c2.ok && t1.includes(tag) && t2.includes(tag), `set->302->/cookies: ${(t1 || j(c1.error)).replace(/\s+/g, ' ').slice(0, 80)}; fresh /cookies: ${(t2 || j(c2.error)).replace(/\s+/g, ' ').slice(0, 80)}`);

    const rd = await go('https://httpbin.org/redirect/3');
    rec('httpbin redirect chain (3 x 302)', rd.ok && rd.committed?.url === 'https://httpbin.org/get', `${short(rd)}; committed ${rd.committed?.url}`);

    // A real form POST (application/x-www-form-urlencoded).
    const fp = await go('https://httpbin.org/forms/post');
    let postOk = false;
    let postNote = short(fp);
    if (fp.ok) {
      const f = app.tabFrame(n);
      await f.fill('input[name=custname]', 'gnome core');
      await f.check('input[name=size][value=medium]');
      const since = await app.mark();
      await f.click('form button');
      const ev = await waitCommit(app, n, since, (u) => u.startsWith('https://httpbin.org/post'));
      await app.waitTabFrame(n, (fr) => fr.evaluate(() => document.body && document.body.innerText.includes('custname')), 20000);
      const txt = (await bodyText(app, n)) || '';
      postOk = ev?.type === 'tab.committed' && /"custname": "gnome core"/.test(txt) && /"size": "medium"/.test(txt);
      postNote = `committed ${ev?.p?.url ?? j(ev)}; body ${txt.replace(/\s+/g, ' ').slice(txt.indexOf('"form"'), txt.indexOf('"form"') + 90)}`;
    }
    rec('httpbin form POST', postOk, postNote);

    // Public WebSocket echo from page JS (the engines' WebSocket hooks in the proxied document).
    const wsRes = {};
    for (const url of ['wss://echo.websocket.org/', 'wss://ws.postman-echo.com/raw']) {
      wsRes[url] = await app.tabFrame(1).evaluate((u) => new Promise((res) => {
        const msg = `gnome-${Math.random().toString(36).slice(2, 8)}`;
        let ws;
        try { ws = new WebSocket(u); } catch (e) { return res(`threw ${e.name}`); }
        const seen = [];
        const timer = setTimeout(() => res(`timeout (open ${ws.readyState >= 1}, received ${j2(seen)})`), 15000);
        const j2 = (v) => JSON.stringify(v);
        ws.onopen = () => ws.send(msg);
        ws.onmessage = (e) => { seen.push(typeof e.data === 'string' ? e.data.slice(0, 40) : Object.prototype.toString.call(e.data)); if (String(e.data) === msg) { clearTimeout(timer); res('echoed'); ws.close(); } };
        ws.onerror = () => { clearTimeout(timer); res('error'); };
      }), url).catch((e) => `evaluate failed: ${String(e.message).slice(0, 80)}`);
    }
    rec('public WebSocket echo (page JS on example.com)', Object.values(wsRes).some((v) => v === 'echoed'), j(wsRes));

    await app.close();
  } finally {
    await context.close();
  }
}

// Run cmd (tab.go / tab.reload) and wait for the tab's next tab.loaded / tab.error.
async function histCmd(app, tabId, type, p) {
  const since = await app.mark();
  try { await app.cmd(type, { tabId, ...p }); } catch (e) { return { ok: false, error: e.message }; }
  const end = await app.waitFor(since, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === tabId, 30000);
  const evs = await app.eventsSince(since);
  const committed = evs.filter((e) => e.type === 'tab.committed' && e.p.tabId === tabId).pop()?.p;
  return { ok: end?.type === 'tab.loaded', committed, error: end?.type === 'tab.error' ? end.p : end ? null : 'timeout' };
}

async function localSite(ctx, engine) {
  const transport = DEFAULT_TRANSPORT[engine];
  const rec = (test, ok, notes, extra = {}) => ctx.record({ engine, transport, test, result: ok ? 'pass' : 'fail', notes, ...extra });
  const context = await ctx.newContext(ctx.browserHandle);
  try {
    const app = await ctx.openApp(context, { route: 'test' });
    let n = 0;
    const go = (url, timeout = 30000) => app.navigate(++n, url, { engine, create: true, timeout });

    // Redirect chain 302 -> 301 -> 307 -> 303 (each hop a separate response through the engine).
    const rd = await go(`${TARGET_ORIGIN}/redirect/4`);
    const ro = rd.ok ? await readOut(app, n, 8000) : null;
    rec('redirect chain 302/301/307/303 (local)', rd.ok && ro?.done === true && rd.committed?.url === `${TARGET_ORIGIN}/redirect-done?via=chain`, `${short(rd)}; committed ${rd.committed?.url}`);

    // POST form (Firefox needs the SW's Request.body fix for both engines).
    const hStart = await app.page.evaluate(() => history.length);
    const fm = await go(`${TARGET_ORIGIN}/form`);
    let po = null;
    if (fm.ok) {
      const since = await app.mark();
      await app.tabFrame(n).click('#submit');
      await waitCommit(app, n, since, (u) => u.endsWith('/post'));
      po = await readOut(app, n, 15000);
    }
    const hAfterForm = await app.page.evaluate(() => history.length);
    rec('form POST body (local)', po?.method === 'POST' && po?.body === 'greeting=hello+gnome&n=42' && /x-www-form-urlencoded/.test(po?.contentType || ''), po ? `server got ${j(po)}` : short(fm));

    // WebSocket echo via the TEST-ONLY HolyWisp (allow-loopback).
    const ws = await go(`${TARGET_ORIGIN}/ws-page?url=${encodeURIComponent(`ws://127.0.0.1:${PORTS.target}/ws`)}`);
    const wo = ws.ok ? await readOut(app, n, 15000) : null;
    rec('WebSocket echo (local, test-only route)', wo?.ok === true, wo ? j(wo) : short(ws));

    // Title + favicon events, then back / forward / reload through the tab's own history.
    const tabId = ++n;
    const a = await app.navigate(tabId, `${TARGET_ORIGIN}/`, { engine, create: true });
    const b = await app.navigate(tabId, `${TARGET_ORIGIN}/title-change`, { engine });
    const titled = await app.waitFor(0, (e) => e.type === 'tab.title' && e.p.tabId === tabId && e.p.title === 'Changed title', 5000);
    const fav = await app.waitFor(0, (e) => e.type === 'tab.favicon' && e.p.tabId === tabId && e.p.icon, 5000);
    rec('title change + favicon events', a.ok && b.ok && !!titled && /^data:image\/png;base64,/.test(fav?.p.icon || ''), `title ${j(titled?.p.title)}; favicon ${fav ? `${fav.p.icon.length} chars data:image/png` : 'none'}`);
    const bk = await histCmd(app, tabId, 'tab.go', { delta: -1 });
    const fw = await histCmd(app, tabId, 'tab.go', { delta: 1 });
    const rl = await histCmd(app, tabId, 'tab.reload', {});
    const okHist = bk.ok && bk.committed?.url === `${TARGET_ORIGIN}/` && bk.committed?.kind === 'history' && bk.committed?.canGoForward
      && fw.ok && fw.committed?.url === `${TARGET_ORIGIN}/title-change` && fw.committed?.canGoBack && !fw.committed?.canGoForward
      && rl.ok && rl.committed?.kind === 'reload';
    rec('back / forward / reload', okHist, `back ${j(bk.committed && { url: bk.committed.url, kind: bk.committed.kind, fwd: bk.committed.canGoForward })}; fwd ${j(fw.committed && { url: fw.committed.url, back: fw.committed.canGoBack })}; reload ${j(rl.committed && rl.committed.kind)}`);
    const hAfterGnome = await app.page.evaluate(() => history.length);
    // GNOME-initiated loads (tab.create/navigate/go/reload) replace the frame's entry; in-page navigations (the
    // form submit above) add entries to the app tab's joint session history like any iframe navigation does.
    rec('joint session history: GNOME-initiated loads add no entries', hAfterGnome - hStart === 1, `app history.length ${hStart} at start, ${hAfterForm} after the in-page form submit (+${hAfterForm - hStart}), ${hAfterGnome} after ${n} GNOME-initiated tab loads + back/forward/reload`);

    // Download: a link click inside the proxied page (Content-Disposition: attachment, 2 MiB, ~1.3 s).
    const dp = await go(`${TARGET_ORIGIN}/download-page?size=2097152&delay=40`);
    const since = await app.mark();
    const dlPromise = app.page.waitForEvent('download', { timeout: 30000 }).catch((e) => e);
    if (dp.ok) await app.tabFrame(n).click('#dl');
    const dl = await dlPromise;
    let size = null;
    let fname = null;
    if (dl && typeof dl.path === 'function') {
      fname = dl.suggestedFilename();
      const p = await dl.path().catch(() => null);
      size = p ? fs.statSync(p).size : null;
    }
    await app.waitFor(since, (e) => e.type === 'download.done', 15000);
    const evs = (await app.eventsSince(since)).filter((e) => e.type.startsWith('download.'));
    const started = evs.find((e) => e.type === 'download.started');
    const progress = evs.filter((e) => e.type === 'download.progress');
    const done = evs.find((e) => e.type === 'download.done');
    const tabUrl = (await app.cmd('diagnostics')).tabs.find((t) => t.id === n)?.url;
    rec('download via link: browser download', size === 2097152 && fname === 'gnome-spike.bin', `browser download "${fname}" ${size} bytes; tab URL afterwards ${tabUrl}`);
    rec('download via link: engine-host events', !!started && !!done && done.p.received === 2097152 && started.p.filename === 'gnome-spike.bin', `started ${j(started && { tabId: started.p.tabId, filename: started.p.filename, total: started.p.total })}; ${progress.length} progress events; done ${j(done && done.p)}`);

    // Download by navigating the tab to the attachment URL (omnibox-style).
    const since2 = await app.mark();
    const dl2p = app.page.waitForEvent('download', { timeout: 30000 }).catch((e) => e);
    const nav = await app.navigate(n, `${TARGET_ORIGIN}/download?size=1048576&delay=20`, { engine, timeout: 20000 });
    const dl2 = await dl2p;
    const size2 = dl2 && typeof dl2.path === 'function' ? await dl2.path().then((p) => fs.statSync(p).size).catch(() => null) : null;
    await app.waitFor(since2, (e) => e.type === 'download.done', 10000);
    const evs2 = (await app.eventsSince(since2)).filter((e) => e.type.startsWith('download.') || e.type === 'tab.loading' || e.type === 'tab.error' || e.type === 'tab.loaded');
    // The claim: the download completes as the browser's own, the engine host reports it, and the navigation ends
    // without tab.loaded (the app must end the loading state on download.started).
    rec('download via navigation', size2 === 1048576 && evs2.some((e) => e.type === 'download.started') && evs2.some((e) => e.type === 'download.done') && !evs2.some((e) => e.type === 'tab.loaded'), `browser download ${size2} bytes; tab events ${evs2.map((e) => e.type).join(',')}; navigate() ${nav.ok ? 'loaded' : j(nav.error).slice(0, 120)}`);

    // Keep-alive reuse after idle: the target (Node, keepAliveTimeout 5 s) closes idle connections.
    for (const [label, t] of [['default', DEFAULT_TRANSPORT[engine]], ['alt', ALT_TRANSPORT[engine]]]) {
      if (label === 'alt') await app.cmd('settings', { transports: { [engine]: t } }, 30000);
      // Warm-up: the first request on this transport (after the idle gaps of the tests above; also the first
      // request after a transport switch) is reported but not judged.
      const k0 = await go(`${TARGET_ORIGIN}/?keepalive=0`, 15000);
      const k1 = await go(`${TARGET_ORIGIN}/?keepalive=1`, 15000);
      await ctx.sleep(6500);
      const k2 = await go(`${TARGET_ORIGIN}/?keepalive=2`, 15000);
      // epoxy-transport 2.1.29 and 3.0.2 reuse a pooled HTTP/1.1 connection the server already closed and the
      // request never completes (documented upstream behaviour: expectFail).
      ctx.record({ engine, transport: t, test: 'request after 6.5 s idle (server closed the keep-alive connection)', result: k1.ok && k2.ok ? 'pass' : 'fail', expectFail: t === 'epoxy', notes: `warm-up ${short(k0)}; first ${short(k1)}; after idle ${short(k2)}` });
    }
    await app.close();
  } finally {
    await context.close();
  }
}

export async function run(ctx) {
  const browser = await ctx.launch();
  ctx.browserHandle = browser;
  try {
    const lanes = ['scramjet', 'ultraviolet'].map(async (engine) => {
      if (!ctx.offline) {
        try { await realSites(ctx, engine); } catch (e) { ctx.record({ engine, test: 'real sites: suite error', result: 'fail', notes: String(e.stack || e).slice(0, 400) }); }
      }
      try { await localSite(ctx, engine); } catch (e) { ctx.record({ engine, test: 'local site: suite error', result: 'fail', notes: String(e.stack || e).slice(0, 400) }); }
    });
    await Promise.all(lanes);
  } finally {
    await browser.close();
  }
}
