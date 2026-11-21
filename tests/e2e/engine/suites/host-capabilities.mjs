// Lane a: the optional capabilities this engine host implements (ENGINE-PROTOCOL §4, §6.10, §6.11; WAVE-B §2
// "Capabilities": report one only when its e2e test passes in both browsers). The e2e build's `test.offer` turns a
// capability on for this run so its command can be exercised before core.ts OFFERED_CAPABILITIES lists it.
//   zoom      tab.zoom: the page lays out like browser zoom (innerWidth / factor), kept across navigations,
//             context-menu coordinates scaled
//   selectAll tab.action selectAll selects the page
//   print     tab.action print reaches the page (beforeprint and afterprint; the engine host answers afterwards)
//   cookies   cookies.list over both jars (metadata, HttpOnly flagged), cookies.delete by name, by site, all
//   siteData  siteData.clear storage / cookies for every proxied site
//   suggest   every provider of the endpoint table answers through proxyFetch (no direct request)
//   vpnVerify vpn.verify reads am.i.mullvad.net/json through the route (the IP itself stays out of the report)
//   saveLink, saveImage  tab.download of a link and an image without the user's activation in the frame (the browser
//                saves the file in both browsers since the app's frame-src allows the engine host's blob download)
import { BROWSER_NOISE } from '../../spike-engine-host/lib/netwatch.mjs';
import { ENGINES, PERMS, fixtureQuery, inFrame, perEngine, readOutOf, realClick, startFixtures } from './host-lib.mjs';

/** Hosts of the requests that reached the sentinel natively since t, browser background noise excluded. */
function directHosts(ctx, t) {
  const host = (e) => (e.kind === 'connect' ? String(e.target || '').replace(/:\d+$/, '') : (() => { try { return new URL(e.url).hostname; } catch { return String(e.url || ''); } })());
  return ctx.stack.sentinel.since(t).map(host).filter((h) => !BROWSER_NOISE.test(h));
}

async function testCmd(app, type, p) {
  try {
    await app.cmd(type, p);
  } catch (e) {
    if (!/invalid test\./.test(String(e.message))) throw e;
  }
}

async function frameOf(app, tab) {
  const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
  if (!f) throw new Error('frame not ready');
  return f;
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    await testCmd(app, 'test.offer', { capabilities: ['zoom', 'print', 'selectAll', 'cookies', 'siteData', 'saveLink', 'saveImage', 'suggest', 'vpnVerify'] });
    const host = await (await app.page.$('iframe')).boundingBox();
    let id = 1;

    await perEngine(ctx, 'capability:zoom', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/wide`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      let f = await frameOf(app, tab);
      const w1 = await inFrame(f, () => innerWidth);
      const z = await app.cmd('tab.zoom', { tabId: tab, factor: 2 });
      await ctx.sleep(300);
      const w2 = await inFrame(f, () => innerWidth);
      // Context menu at zoom 2: the coordinates are engine-host viewport pixels.
      const box = await (await f.waitForSelector('#ln')).boundingBox();
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const s = await app.mark();
      await app.page.mouse.click(at.x, at.y, { button: 'right' });
      await ctx.sleep(500);
      await app.page.keyboard.press('Escape');
      const menu = (await app.eventsSince(s)).filter((e) => e.type === 'tab.contextMenu' && e.p.tabId === tab).pop();
      const near = menu && Math.abs(menu.p.x - (at.x - host.x)) <= 3 && Math.abs(menu.p.y - (at.y - host.y)) <= 3 && menu.p.target.kind === 'link';
      // Kept across a navigation.
      const b = await app.navigate(tab, `${fx.origin}/second`, { engine, timeout: 45000 });
      f = await frameOf(app, tab);
      const w3 = b.ok ? await inFrame(f, () => innerWidth).catch(() => null) : null;
      await app.cmd('tab.zoom', { tabId: tab, factor: 1 });
      const ok = z.factor === 2 && Math.abs(w2 - w1 / 2) <= 2 && w3 !== null && Math.abs(w3 - w1 / 2) <= 2 && near;
      return { result: ok ? 'pass' : 'fail', notes: `innerWidth ${w1} → ${w2} (zoom 2) → ${w3} after a navigation; context menu at (${menu?.p.x},${menu?.p.y}) for a click at (${Math.round(at.x - host.x)},${Math.round(at.y - host.y)})` };
    });

    await perEngine(ctx, 'capability:selectAll', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/print`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await frameOf(app, tab);
      await app.cmd('tab.action', { tabId: tab, action: 'selectAll' });
      const sel = await inFrame(f, () => String(getSelection()));
      return { result: /printable text/.test(sel) ? 'pass' : 'fail', notes: `selection ${JSON.stringify(sel.slice(0, 40))}` };
    });

    await perEngine(ctx, 'capability:cookies (list, delete by name, delete all)', async (engine) => {
      const tab = id++;
      await app.cmd('cookies.delete', { all: true, site: null, name: null });
      const a = await app.navigate(tab, `${fx.origin}/cookies/set`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const l1 = await app.cmd('cookies.list', { site: '127.0.0.1' });
      const mine = l1.cookies.filter((c) => c.engine === engine);
      const sid = mine.find((c) => c.name === 'sid');
      const del = await app.cmd('cookies.delete', { all: false, site: '127.0.0.1', name: 'pref' });
      const b = await app.navigate(tab, `${fx.origin}/cookies`, { engine, timeout: 45000 });
      const f = b.ok ? await frameOf(app, tab) : null;
      const seen = f ? await inFrame(f, () => document.getElementById('cookies')?.textContent ?? '').catch(() => null) : null;
      const delAll = await app.cmd('cookies.delete', { all: true, site: null, name: null });
      const l2 = await app.cmd('cookies.list', { site: null });
      const ok =
        sid && sid.httpOnly === true && sid.size === 6 && mine.some((c) => c.name === 'pref') && del.deleted >= 1 &&
        /sid=s3cr3t/.test(seen ?? '') && !/pref=/.test(seen ?? '') && delAll.deleted >= 1 && l2.cookies.length === 0;
      return { result: ok ? 'pass' : 'fail', notes: `listed ${mine.map((c) => `${c.name}${c.httpOnly ? '(HttpOnly)' : ''}`).join(',')}; deleted pref ${del.deleted}; the site then saw ${JSON.stringify(seen)}; delete all ${delAll.deleted}; left ${l2.cookies.length}` };
    });

    await perEngine(ctx, 'capability:siteData.clear (storage)', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/storage`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      await app.navigate(tab, `${fx.origin}/storage`, { engine, timeout: 45000 });
      const f1 = await frameOf(app, tab);
      const before = await inFrame(f1, () => document.getElementById('out')?.textContent ?? '');
      await app.cmd('siteData.clear', { kinds: ['storage', 'cookies'] }, 30000);
      await app.cmd('tab.close', { tabId: tab });
      const tab2 = id++;
      await app.navigate(tab2, `${fx.origin}/storage`, { engine, create: true, timeout: 45000 });
      const f2 = await frameOf(app, tab2);
      const after = await inFrame(f2, () => document.getElementById('out')?.textContent ?? '');
      const ok = /"before":"v"/.test(before) && /"before":null/.test(after);
      return { result: ok ? 'pass' : 'fail', notes: `second visit before clearing ${before}; after clearing ${after}` };
    });

    await perEngine(ctx, 'capability:saveLink + saveImage (tab.download)', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/downloads`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const rows = [];
      let ok = true;
      for (const [kind, path, size, name] of [
        ['link', '/file/plain.bin', 256 * 1024, 'plain.bin'],
        ['image', '/favicon.png', null, 'favicon.png'],
      ]) {
        const h0 = fx.hits(path);
        const dl0 = app.downloads.length;
        const s = await app.mark();
        // The app's menu click is a gesture in the APP document only: no activation reaches the engine iframe.
        await ctx.sleep(5500);
        await app.cmd('tab.download', { tabId: tab, url: `${fx.origin}${path}`, kind });
        const done = await app.waitFor(s, (e) => e.type === 'download.done', 20000);
        const started = (await app.eventsSince(s)).find((e) => e.type === 'download.started');
        await ctx.sleep(1500);
        const saved = app.downloads.slice(dl0);
        let bytes = null;
        if (saved.length) {
          try {
            const p = await saved[saved.length - 1].download.path();
            bytes = p ? (await import('node:fs')).statSync(p).size : null;
          } catch {
            bytes = 'unreadable';
          }
        }
        const one = !!started && started.p.filename === name && done?.p.state === 'completed' && saved.length === 1 && (size === null ? bytes > 0 : bytes === size) && fx.hits(path) - h0 === 1;
        ok &&= one;
        rows.push(`${kind}: ${one ? 'ok' : 'FAIL'} started ${started?.p.filename ?? 'none'} done ${done?.p.state ?? 'none'} saved ${saved.length} (${bytes} bytes) requests ${fx.hits(path) - h0}`);
      }
      // Offered since integration part 2 (core.ts): Firefox had refused the engine host's blob download because it
      // checks it against the APP's frame-src as a navigation of the engine iframe; the shell policy now has `blob:`.
      return { result: ok ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    // Enforced permissions (ENGINE-PROTOCOL §6.14; worklist A5): `<feature> 'none'` in the tab frame's allow attribute
    // must block the feature, and the next GNOME-initiated load with `allow` must lift it again. One row per
    // permission, measured with enforcement forced on (`test.enforce`), and one row that the engine host's
    // InitResult.enforcedPermissions lists EXACTLY the permissions whose row passed in this browser.
    // /perm tries autoplay (unmuted play()) from its own script at load, without a gesture, and reports its policy;
    // fullscreen is read from document.fullscreenEnabled; /perm-clip writes the clipboard from a REAL click (focus and
    // the user's activation in the frame), so only the permissions policy decides (a write at load fails anyway in an
    // unfocused frame, which is why this row used to prove nothing in Chromium), both with the asynchronous API and
    // with document.execCommand('copy'): Chromium's `clipboard-write 'none'` stops only the first (security review,
    // integration part 2), so no browser reports clipboard as enforced (shared/site-rules.ts ENFORCED_PERMISSIONS).
    const reported = [...(app.init?.enforcedPermissions ?? [])].sort();
    const passed = { fullscreen: true, autoplay: true, clipboard: true };
    const probe = async (tab) => {
      const o = await readOutOf(app, `tab-${tab}`, 20000);
      if (!o) throw new Error('/perm did not report');
      return { fullscreen: { enabled: o.fullscreenEnabled, policy: o.fullscreen }, autoplay: { play: o.play, policy: o.autoplay } };
    };
    const clipWrite = async (tab, clipboard, engine) => {
      const r = await app.navigate(tab, `${fx.origin}/perm-clip?${clipboard}`, { engine, permissions: { ...PERMS, clipboard }, timeout: 45000 });
      if (!r.ok) return { clip: `load failed ${JSON.stringify(r.error).slice(0, 80)}` };
      await ctx.sleep(300);
      await realClick(app, app.tabFrame(tab), '#clip');
      return (await readOutOf(app, `tab-${tab}`, 8000)) ?? { clip: 'no answer' };
    };
    for (const engine of ENGINES) {
      try {
        await testCmd(app, 'test.enforce', { permissions: ['fullscreen', 'autoplay', 'clipboard'] });
        const tab = id++;
        const blocked = { autoplay: 'block', fullscreen: 'block', clipboard: 'block' };
        const a = await app.navigate(tab, `${fx.origin}/perm`, { engine, create: true, permissions: blocked, timeout: 45000 });
        if (!a.ok) throw new Error(`page did not load: ${JSON.stringify(a.error)}`);
        const off = await probe(tab);
        // The next GNOME-initiated load with allow lifts it.
        const b = await app.navigate(tab, `${fx.origin}/perm?again=1`, { engine, permissions: PERMS, timeout: 45000 });
        const on = b.ok ? await probe(tab) : null;
        const clipOff = await clipWrite(tab, 'block', engine);
        const clipOn = await clipWrite(tab, 'allow', engine);
        await testCmd(app, 'test.enforce', { permissions: null });
        const verdict = {
          fullscreen: off.fullscreen.enabled === false && on?.fullscreen.enabled === true,
          autoplay: off.autoplay.play === 'NotAllowedError' && on?.autoplay.play === 'played',
          // Both ways a page writes the clipboard: the policy must stop the asynchronous API AND execCommand('copy').
          clipboard: clipOff.clip === 'NotAllowedError' && clipOff.exec === 'refused' && clipOn.clip === 'written' && clipOn.exec === 'written',
        };
        const notes = {
          fullscreen: `blocked ${JSON.stringify(off.fullscreen)}; allowed again ${JSON.stringify(on?.fullscreen ?? null)}`,
          autoplay: `blocked ${JSON.stringify(off.autoplay)}; allowed again ${JSON.stringify(on?.autoplay ?? null)}`,
          clipboard: `blocked ${JSON.stringify(clipOff)}; allowed ${JSON.stringify(clipOn)}`,
        };
        for (const k of Object.keys(verdict)) {
          passed[k] &&= verdict[k];
          // A permission the engine host does not report for this browser is expected to fail (a measured limit).
          const listed = reported.includes(k);
          ctx.record({ test: `permission:${k} block → allow`, engine, result: verdict[k] ? 'pass' : 'fail', ...(listed ? {} : { expectFail: true }), notes: `${notes[k]}${listed ? '' : ' (not reported as enforced in this browser)'}` });
        }
        await app.cmd('tab.close', { tabId: tab }).catch(() => {});
      } catch (e) {
        await testCmd(app, 'test.enforce', { permissions: null }).catch(() => {});
        for (const k of ['fullscreen', 'autoplay', 'clipboard']) {
          passed[k] = false;
          ctx.record({ test: `permission:${k} block → allow`, engine, result: 'fail', notes: `threw: ${String(e.message || e).slice(0, 300)}` });
        }
      }
    }
    const enforced = Object.keys(passed).filter((k) => passed[k]).sort();
    ctx.record({
      test: 'permission:InitResult.enforcedPermissions lists exactly the permissions enforced in this browser',
      result: JSON.stringify(reported) === JSON.stringify(enforced) ? 'pass' : 'fail',
      notes: `reported ${JSON.stringify(reported)}; enforced in both engines ${JSON.stringify(enforced)}`,
    });

    await app.close();
  } finally {
    await context.close();
    await browser.close();
  }
  try {
    if (!ctx.offline) {
      const b2 = await ctx.launch();
      try {
        await proxyFetchRows(ctx, b2);
      } finally {
        await b2.close();
      }
    }
    await printRows(ctx, fx);
  } finally {
    await fx.close();
  }
}

// suggest and vpn.verify go through TransportManager.proxyFetch (Wisp, no engine): one row per provider and transport,
// not per engine. They need the internet (real providers, the real check service). In Chromium the context gets the
// User-Agent of a headed Chromium (the JS transports send navigator.userAgent): bot filters (Brave: 429, Startpage:
// 302) reject headless Chromium's "HeadlessChrome", which no real user sends.
async function proxyFetchRows(ctx, browser) {
  let opts = {};
  if (ctx.browser === 'chromium') {
    const probe = await ctx.newContext(browser);
    const pg = await probe.newPage();
    const ua = await pg.evaluate(() => navigator.userAgent);
    await probe.close();
    opts = { userAgent: ua.replace('HeadlessChrome', 'Chrome') };
  }
  const context = await ctx.newContext(browser, opts);
  try {
    const app = await ctx.openApp(context, {});
    await testCmd(app, 'test.offer', { capabilities: ['suggest', 'vpnVerify'] });
      for (const transport of ['libcurl', 'epoxy']) {
      await app.gnome((t) => window.gnomeTest.applySettings({ transport: t }), transport);
      await ctx.sleep(1500);
      const t0 = Date.now();
      const per = [];
      for (const provider of ['duckduckgo', 'google', 'bing', 'brave', 'startpage', 'ecosia']) {
        const s0 = Date.now();
        try {
          let retried = false;
          const once = () => app.cmd('suggest', { query: 'gnome sh', provider }, 8000);
          // The first request after a transport switch opens a cold connection (Wisp stream + TLS): one retry after a
          // timeout, recorded in the notes; likewise one retry when the provider itself answers 5xx (a live service's
          // passing outage, e.g. Ecosia's 503 on 2026-11-19), so the row measures the engine host, not the provider.
          const r = await once().catch(async (e) => {
            const m = String(e.message);
            if (!/timed out|answered 5\d\d/.test(m)) throw e;
            retried = /timed out/.test(m) ? 'cold timeout' : m.replace(/^.*answered /, 'provider answered ');
            await ctx.sleep(1500);
            return once();
          });
          per.push({ provider, ok: r.items.length > 0, n: r.items.length, first: r.items[0] ?? null, ms: Date.now() - s0, ...(retried ? { retriedOnceAfter: retried } : {}) });
        } catch (e) {
          per.push({ provider, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 120), ms: Date.now() - s0 });
        }
      }
      const directList = directHosts(ctx, t0);
      const direct = directList.length;
      for (const p of per) {
        ctx.record({ test: `capability:suggest ${p.provider}`, transport, result: p.ok && direct === 0 ? 'pass' : 'fail', notes: `${JSON.stringify(p)}; direct requests at the sentinel ${direct} ${JSON.stringify(directList)}` });
      }
      const t1 = Date.now();
      let v;
      try {
        const r = await app.cmd('vpn.verify', { url: 'https://am.i.mullvad.net/json' }, 25000);
        // The machine's public IP stays out of the report: only its shape is recorded.
        v = { ok: typeof r.ip === 'string' && r.ip.length > 0, ipKind: r.ip.includes(':') ? 'IPv6' : 'IPv4', country: r.country !== null, city: r.city !== null, vpnExit: r.vpnExit, checkedAtAge: Date.now() - r.checkedAt };
      } catch (e) {
        v = { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 160) };
      }
      const direct2List = directHosts(ctx, t1);
      const direct2 = direct2List.length;
      ctx.record({ test: 'capability:vpn.verify (am.i.mullvad.net through the route)', transport, result: v.ok && typeof v.vpnExit === 'boolean' && direct2 === 0 ? 'pass' : 'fail', notes: `${JSON.stringify(v)}; direct requests at the sentinel ${direct2} ${JSON.stringify(direct2List)}` });
    }
    await app.gnome(() => window.gnomeTest.applySettings({ transport: 'libcurl' }));
    await ctx.sleep(1000);
    await app.close();
  } finally {
    await context.close();
  }
}

// print: window.print() is modal. Headless Firefox has no print dialog and its print() never returns (the whole
// content process stops, the engine host with it), so Firefox runs with silent printing (Save to PDF into the run
// directory): the page must see beforeprint and afterprint. A Node-side deadline keeps a hang from stalling the suite.
async function printRows(ctx, fx) {
  const extraPrefs = {
    'print.always_print_silent': true,
    'print.show_print_progress': false,
    'print_printer': 'Mozilla Save to PDF',
    'print.printer_Mozilla_Save_to_PDF.print_to_file': true,
    'print.printer_Mozilla_Save_to_PDF.print_to_filename': `${ctx.runDir}/print-${ctx.browser}.pdf`,
  };
  const browser = await ctx.launch(ctx.browser === 'firefox' ? { extraPrefs } : {});
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    await testCmd(app, 'test.offer', { capabilities: ['print'] });
    let id = 100;
    await perEngine(ctx, 'capability:print', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/print`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await frameOf(app, tab);
      const deadline = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${what}: no answer in ${ms} ms`)), ms))]);
      let printed;
      try {
        await deadline(app.cmd('tab.action', { tabId: tab, action: 'print' }, 15000), 20000, 'tab.action print');
        await ctx.sleep(2000);
        printed = (await deadline(inFrame(f, () => window.__events.join(','), undefined, 5000), 8000, 'reading the page')) || 'no print events';
        const alive = await deadline(app.cmd('ping', {}), 8000, 'ping after print');
        printed += `; engine host alive ${!!alive?.instance}`;
      } catch (e) {
        printed = `failed: ${String(e.message).slice(0, 120)}`;
      }
      // Headless Chromium has no print dialog: print() fires beforeprint and returns (no afterprint). Firefox prints
      // silently to a PDF, so the whole sequence must run there.
      const ok = /beforeprint/.test(printed) && (ctx.browser !== 'firefox' || /afterprint/.test(printed)) && /alive true/.test(printed);
      return { result: ok ? 'pass' : 'fail', notes: `print ${printed}${ctx.browser === 'firefox' ? ' (silent printing to a PDF)' : ' (headless: no print dialog, no afterprint)'}` };
    });
    await app.close().catch(() => {});
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
