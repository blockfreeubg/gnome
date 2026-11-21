// Lane d (with lane c's browser and lanes a/b's engine host) e2e: history visits and downloads recorded from real navigations on
// the real stack (gnome-server + HolyWisp + the built engine host), in Chromium and Firefox. A page opened in the
// browser adds one visit with its title; in that page, history.pushState routes add visits while replaceState churn
// and fragment-only pushes do not (src/shared/browser-data.ts shouldRecordVisit + VisitGate); a repeat of the same URL
// within LIBRARY_LIMITS.repeatVisitMs adds nothing; real downloads (a 21 MB zip and a tiny attachment) are listed and
// complete. Every engine × transport (browser.transport: libcurl, epoxy; LIBRARY_VISITS_TRANSPORTS narrows it).
// Needs the internet (example.com, codeload.github.com, httpbin.org).
//
//   node tests/e2e/engine/suites/library-visits.mjs [--browser chromium|firefox|all]   (see library-lib.mjs)
import { isMain, runStandalone, settingsMirror } from './library-lib.mjs';
import { dump } from './library-seed-lib.mjs';

export async function run(ctx) {
  const browser = await ctx.launch();
  const transports = (process.env.LIBRARY_VISITS_TRANSPORTS || 'libcurl,epoxy').split(',').filter(Boolean);
  try {
    for (const engine of ['scramjet', 'ultraviolet']) for (const transport of transports) await runEngine(ctx, browser, engine, transport);
  } finally {
    await browser.close();
  }
}

async function runEngine(ctx, browser, engine, transport) {
  const record = async (test, fn) => {
    try {
      const notes = await fn();
      ctx.record({ test, engine, transport, result: 'pass', notes: typeof notes === 'string' ? notes : undefined });
      return true;
    } catch (err) {
      ctx.record({ test, engine, transport, result: 'fail', notes: String(err?.message ?? err).slice(0, 600) });
      return false;
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const waitFor = async (fn, what, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await ctx.sleep(400);
    }
  };
  const context = await ctx.newContext(browser);
  await context.addInitScript(
    ([value]) => {
      if (!sessionStorage.getItem('lib-e2e:seeded')) {
        localStorage.setItem('gnome:settings:v1', value);
        sessionStorage.setItem('lib-e2e:seeded', '1');
      }
    },
    [settingsMirror('dark', { browser: { engine, transport, autoFallback: false } })],
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    const visitsOf = async (url) => (await dump(page, 'history')).filter((v) => v.url === url);
    const opened = await record('a page opened in the browser adds one visit with its title', async () => {
      await page.goto(`${ctx.stack.appOrigin}/browse?url=${encodeURIComponent('https://example.com/')}`, { waitUntil: 'load' });
      const [v] = await waitFor(async () => {
        const list = await visitsOf('https://example.com/');
        return list.length && list[0].title ? list : null;
      }, 'visit of https://example.com/ with a title', 45_000);
      expect(v.title === 'Example Domain', `title ${v.title}`);
      expect(typeof v.syncPending === 'number', 'not marked for sync');
      await ctx.sleep(1500);
      expect((await visitsOf('https://example.com/')).length === 1, 'more than one visit');
      // Which transport modules the engine-host realm loaded (src/shared/proxy-origin.ts TRANSPORT_MODULES; UV's run
      // in the bare-mux worker, whose loads this frame does not see).
      const host = page.frames().find((f) => f.url().startsWith(ctx.stack.proxyOrigin) && /\/engine\/?$/.test(new URL(f.url()).pathname));
      const loaded = host ? await host.evaluate(() => performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => /-transport(-bare)?\//.test(p))) : [];
      if (engine === 'scramjet') expect(loaded.some((p) => p.startsWith(`/vendor/${transport}-transport/`)), `the engine host did not load the ${transport} transport: ${loaded.join(', ') || 'none'}`);
      return `transport modules loaded by the engine host: ${[...new Set(loaded)].join(', ') || 'none'}`;
    });
    if (!opened) return;

    // The proxied document of the tab (a frame on the proxy origin whose location decodes to example.com).
    const tabFrame = async () =>
      waitFor(async () => {
        for (const f of page.frames()) {
          if (!f.url().startsWith(ctx.stack.proxyOrigin) || /\/engine\/?$/.test(f.url())) continue;
          const ok = await f.evaluate(() => document.title === 'Example Domain' || /Example Domain/.test(document.body?.innerText ?? '')).catch(() => false);
          if (ok) return f;
        }
        return null;
      }, 'the proxied example.com frame');

    await record('pushState routes add visits; replaceState and fragment-only pushes do not', async () => {
      const f = await tabFrame();
      // The page really runs in the selected engine (proxy-origin.ts PROXY_PATHS prefixes).
      const path = new URL(f.url()).pathname;
      expect(path.startsWith(engine === 'scramjet' ? '/~/sj/' : '/uv/service/'), `tab frame ${f.url()} is not on the ${engine} prefix`);
      await f.evaluate(() => {
        history.pushState({}, '', '/spa/route-1');
      });
      await waitFor(async () => (await visitsOf('https://example.com/spa/route-1')).length === 1, 'visit of the pushState route', 15_000);
      await f.evaluate(() => {
        for (let i = 0; i < 5; i++) history.replaceState({ i }, '', `/spa/route-1?replace=${i}`);
        history.pushState({}, '', '/spa/route-1?replace=4#details');
        history.pushState({}, '', '/spa/route-2');
      });
      await waitFor(async () => (await visitsOf('https://example.com/spa/route-2')).length === 1, 'visit of the second route', 15_000);
      await ctx.sleep(1500);
      const all = (await dump(page, 'history')).map((v) => v.url).sort();
      expect(!all.some((u) => /replace=/.test(u)), `replaceState or fragment push recorded: ${all.join(', ')}`);
      expect(all.length === 3, `visits: ${all.join(', ')}`);
      return all.join(' · ');
    });

    await record('a repeat of the same URL within a minute adds no visit; the History page lists the visits', async () => {
      const f = await tabFrame();
      await f.evaluate(() => {
        history.pushState({}, '', '/spa/route-1');
        history.pushState({}, '', '/spa/route-2');
      });
      await ctx.sleep(2500);
      const n1 = (await visitsOf('https://example.com/spa/route-1')).length;
      const n2 = (await visitsOf('https://example.com/spa/route-2')).length;
      // route-1 is not the tab's last recorded URL any more, so it counts again; route-2 right after is a new visit
      // too (the tab's last URL was route-1). What must not happen is a visit per commit of an unchanged URL.
      expect(n1 <= 2 && n2 <= 2, `route-1 ×${n1}, route-2 ×${n2}`);
      await f.evaluate(() => history.pushState({}, '', '/spa/route-2'));
      await ctx.sleep(2000);
      expect((await visitsOf('https://example.com/spa/route-2')).length === n2, 'a repeated push of the same URL added a visit');
      // Client-side navigation to History (an app reload would hit lane c's startup history wipe; see library-pages).
      await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = '/history';
        document.body.append(a);
        a.click();
        a.remove();
      });
      await page.locator('.days .row', { hasText: 'example.com/spa/route-2' }).first().waitFor();
      return `route-1 ×${n1}, route-2 ×${n2}`;
    });

    const download = async (url, name) => {
      await page.goto(`${ctx.stack.appOrigin}/browse?url=${encodeURIComponent(url)}`, { waitUntil: 'load' });
      return waitFor(async () => {
        const d = (await dump(page, 'downloads')).find((x) => x.filename === name);
        return d && d.state !== 'in_progress' ? d : null;
      }, `${name} listed and finished`, 60_000).catch(async (err) => {
        const d = (await dump(page, 'downloads')).find((x) => x.filename === name);
        throw new Error(`${err.message}; record: ${JSON.stringify(d ?? null)}`);
      });
    };
    await record('a real download (a 21 MB zip, attachment) is listed with its size and completes', async () => {
      const d = await download('https://codeload.github.com/sveltejs/svelte/zip/refs/tags/svelte@5.0.0', 'svelte-svelte-5.0.0.zip');
      expect(d.state === 'completed' && d.engine === engine && d.total > 1_000_000 && d.received === d.total, JSON.stringify(d));
      return `${d.received} bytes`;
    });
    await record('a tiny download (131 bytes; done right after started) completes in the list', async () => {
      const d = await download(
        'https://httpbin.org/response-headers?Content-Type=application/zip&Content-Disposition=attachment%3B%20filename%3Dgnome-tiny.zip',
        'gnome-tiny.zip',
      );
      expect(d.state === 'completed', JSON.stringify(d));
    });
  } finally {
    await context.close();
  }
}

if (isMain(import.meta.url)) await runStandalone(run, 'library-visits');
