// Lane a: downloads on the real stack (ENGINE-PROTOCOL §6.9; WAVE-B §2 Tests): an attachment via a link and via a
// navigation, a zip sent without Content-Disposition (unrendered type) via a link and via a navigation, `<a download>`,
// and an attachment from a `Referrer-Policy: no-referrer` page. Each: download.started (tab, file name, MIME, size),
// progress, done/completed with every byte, the browser's own download, exactly one request at the server, no
// tab.loaded and no tab.error for the navigation that became a download, no fallback, and the tab's document stays.
import { fixtureQuery, perEngine, realClick, startFixtures } from './host-lib.mjs';

const SIZE = 256 * 1024;

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx));
    let id = 1;

    // `d0`: how many browser downloads there were before the row's action: only later ones are this row's (a 40 s window
    // let a row read the previous row's file, which has the same size).
    const expectDownload = async ({ tab, since, path, base, filename, mime, navId, label, keepUrl, d0 }) => {
      const started = await app.waitFor(since, (e) => e.type === 'download.started' && e.p.tabId === tab, 20000);
      const done = started ? await app.waitFor(since, (e) => e.type === 'download.done' && e.p.downloadId === started.p.downloadId, 30000) : null;
      await ctx.sleep(1500);
      const evs = (await app.eventsSince(since)).filter((e) => e.p?.tabId === tab || e.p?.openerTabId === tab || (started && e.p?.downloadId === started.p.downloadId));
      const progress = evs.filter((e) => e.type === 'download.progress');
      const loaded = evs.filter((e) => e.type === 'tab.loaded' && (navId === undefined || e.p.navId === navId));
      const errors = evs.filter((e) => e.type === 'tab.error');
      const switched = evs.filter((e) => e.type === 'tab.engineSwitched');
      const hits = fx.hits(path) - base;
      const st = await app.cmd('tab.state', { tabId: tab });
      const browserDl = app.downloads.slice(d0);
      // The file the browser saved (the engines' taps must not change the bytes).
      let savedBytes = null;
      const lastDl = browserDl[browserDl.length - 1];
      if (lastDl) {
        try {
          const p = await lastDl.download.path();
          savedBytes = p ? (await import('node:fs')).statSync(p).size : null;
        } catch {
          savedBytes = 'unreadable';
        }
      }
      // The name the BROWSER saved it under (integration part 2: under Scramjet a download without a file name in its
      // Content-Disposition was saved as the encoded proxied URL, e.g. `http___127.0.0.1_…_archive.zip`).
      const savedName = lastDl ? lastDl.suggestedFilename : null;
      const ok =
        !!started &&
        started.p.filename === filename &&
        savedName === filename &&
        (mime === undefined || started.p.mime === mime) &&
        started.p.total === SIZE &&
        done?.p.state === 'completed' &&
        done.p.received === SIZE &&
        loaded.length === 0 &&
        errors.length === 0 &&
        switched.length === 0 &&
        hits === 1 &&
        savedBytes === SIZE &&
        !st.loading &&
        (keepUrl === undefined || st.entries[st.index] === keepUrl);
      return {
        result: ok ? 'pass' : 'fail',
        notes: `${label}: started ${JSON.stringify(started?.p ?? null)}; progress ${progress.length}; done ${JSON.stringify(done?.p ?? null)}; requests ${hits}; tab.loaded ${loaded.length}; tab.error ${errors.length}; switched ${switched.length}; current ${st.entries[st.index]}; browser downloads ${browserDl.length}, last saved ${savedBytes} bytes as ${JSON.stringify(savedName)}`,
      };
    };

    await perEngine(ctx, 'downloads:attachment-link', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/downloads`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const base = fx.hits('/file/attach.bin');
      const since = await app.mark();
      const d0 = app.downloads.length;
      await realClick(app, f, '#d-attach');
      return expectDownload({ tab, since, path: '/file/attach.bin', base, filename: 'attach.bin', mime: 'application/octet-stream', label: 'link', keepUrl: `${fx.origin}/downloads`, d0 });
    });

    await perEngine(ctx, 'downloads:attachment-navigation', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const base = fx.hits('/file/attach.bin');
      const since = await app.mark();
      const d0 = app.downloads.length;
      const nav = await app.cmd('tab.navigate', { tabId: tab, url: `${fx.origin}/file/attach.bin`, engine, permissions: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } });
      return expectDownload({ tab, since, path: '/file/attach.bin', base, filename: 'attach.bin', navId: nav.navId, label: 'navigation', keepUrl: `${fx.origin}/`, d0 });
    });

    await perEngine(ctx, 'downloads:zip-without-disposition (link + navigation)', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/downloads`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const h0 = fx.hits('/file/archive.zip');
      const s1 = await app.mark();
      const d1 = app.downloads.length;
      await realClick(app, f, '#d-zip');
      const r1 = await expectDownload({ tab, since: s1, path: '/file/archive.zip', base: h0, filename: 'archive.zip', mime: 'application/zip', label: 'link', keepUrl: `${fx.origin}/downloads`, d0: d1 });
      const linkHits = fx.hits('/file/archive.zip') - h0;
      const s2 = await app.mark();
      const d0 = app.downloads.length;
      const nav = await app.cmd('tab.navigate', { tabId: tab, url: `${fx.origin}/file/archive.zip`, engine, permissions: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } });
      const started = await app.waitFor(s2, (e) => e.type === 'download.started' && e.p.tabId === tab, 20000);
      await ctx.sleep(2500);
      const evs = (await app.eventsSince(s2)).filter((e) => e.p?.tabId === tab);
      const navHits = fx.hits('/file/archive.zip') - h0 - linkHits;
      const navName = app.downloads.slice(d0).pop()?.suggestedFilename ?? null;
      const navOk = !!started && navHits === 1 && navName === 'archive.zip' && !evs.some((e) => e.type === 'tab.error' || e.type === 'tab.engineSwitched' || (e.type === 'tab.loaded' && e.p.navId === nav.navId));
      const ok = r1.result === 'pass' && linkHits === 1 && navOk;
      return { result: ok ? 'pass' : 'fail', notes: `${r1.notes} | navigation: started ${!!started} requests ${navHits} saved as ${JSON.stringify(navName)} events ${evs.map((e) => e.type).join(',')}` };
    });

    await perEngine(ctx, 'downloads:a-download', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/downloads`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const h0 = fx.hits('/file/plain.bin');
      const since = await app.mark();
      const d0 = app.downloads.length;
      await realClick(app, f, '#d-adl');
      return expectDownload({ tab, since, path: '/file/plain.bin', base: h0, filename: 'saved.bin', label: '<a download>', keepUrl: `${fx.origin}/downloads`, d0 });
    });

    await perEngine(ctx, 'downloads:no-referrer-page', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/downloads-noref`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const base = fx.hits('/file/attach.bin');
      const since = await app.mark();
      const d0 = app.downloads.length;
      await realClick(app, f, '#d-attach');
      return expectDownload({ tab, since, path: '/file/attach.bin', base, filename: 'attach.bin', label: 'no-referrer', keepUrl: `${fx.origin}/downloads-noref`, d0 });
    });

    const rejected = (await app.gnome(() => window.gnomeTest.rejected)).filter((r) => !String(r.kind).startsWith('result:test.'));
    ctx.record({ test: 'app-side:no-invalid-events', result: rejected.length === 0 ? 'pass' : 'fail', notes: JSON.stringify(rejected).slice(0, 400) });
    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
