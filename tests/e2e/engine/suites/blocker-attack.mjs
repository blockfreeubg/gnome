// Lane x1 (docs/WAVE-B3.md §12.2 "Attacks"): A0 first (paths from an ordinary page to the engine host), A1 r1-realm-walk
// (step 2's walk extended to step 3's additions, with a stack sweep), A3/A3b (forged service-worker messages, F3),
// A8 (UV cross-origin pushState, F4), A9 (a synthetic CSP-violation event, F6), A10 (a Scramjet page reopening a
// WebSocket the wrapper blocked through the client's own method, D16). Both engines. Fixture pages:
// fixtures/blocker/network/shared/{a0,a1,attack,cors}.html. Parts: a0, a1, sw, a6, a7, a8, a9, a10, a5, a4, cors (a measurement).
import { applyBlocker, blockedOf, blockerSettings, forEngines, listRefs, openBlockerApp, pageOut, partOn, waitBlocker } from './blocker-network.mjs';
import { omnibox, openGnome, state, waitState } from './shell-lib.mjs';

/**
 * A6 (WAVE-B3 D5): code that controls the engine-host realm forges `tab.loading.url` announcements (the e2e-only
 * `test.blockerExposure {announce}` sends them as such code could, past the 2/s throttle) for rule-bearing sites; the
 * real app (its SiteExposure, lane x4) exposes at most 20 newly exposed rule-bearing sites per tab per minute, also
 * across an engine-iframe replacement (an unexpected load of the engine host). Measured through what the engine host
 * holds (`test.blockerExposure`: the keys of the scoped maps of its last snapshot).
 */
async function rowA6(ctx, browser) {
  const context = await ctx.newContext(browser);
  try {
    const { page } = await openGnome(ctx, context, '/browse');
    // as shell-blocker: the VPN profile route of the run (the fixture hosts are reachable only through it)
    await page.evaluate((id) => {
      const st = window.__gnomeSettings;
      st.set('vpn', 'mode', 'gateway');
      st.set('vpn', 'preferredLocation', id);
    }, ctx.stack.profiles.live);
    // the engine host starts with the first page
    await waitState(page, (x) => x.tabs.length >= 1, 20_000, 'a tab').catch(() => null);
    await omnibox(page, ctx.stack.blocker.url('site-a', '/network/page.html'));
    const ready = await waitState(page, (x) => x.engineState === 'ready' && x.tabs.some((t) => t.live), 45_000, 'the browser').catch(() => null);
    if (!ready) return { result: 'fail', notes: `the browser did not start: ${JSON.stringify(await state(page).catch(() => null))?.slice(0, 500)}` };
    const caps = await page.evaluate(() => window.__gnomeBrowser.hasCapability('blocker')).catch(() => false);
    if (!caps) return { result: 'fail', notes: 'the engine host does not offer blocker' };
    const KEYS = 60;
    const key = (n) => `*.a6-${n}.localhost`;
    await page.evaluate((keys) => window.__gnomeSettings.set('extensions', 'allowlist', keys), Array.from({ length: KEYS }, (_, n) => key(n)));
    await page.waitForTimeout(500);
    const tabId = (ready.tabs.find((t) => t.live) ?? ready.tabs[0]).id;
    const cmd = (p) => page.evaluate((x) => window.__gnomeBrowser.testCommand('test.blockerExposure', x), p);
    const exposed = (r) => (r?.allowlist ?? []).filter((k) => /^\*\.a6-\d+\.localhost$/.test(k)).length;
    const urls = (from, to) => Array.from({ length: to - from }, (_, i) => `http://www.a6-${from + i}.localhost/`);
    const before = exposed(await cmd({}));
    await cmd({ tabId, announce: urls(0, 30) });
    await page.waitForTimeout(1500);
    const first = await cmd({});
    // An unexpected load of the engine iframe: the app replaces it (a compromise signal) and restores the tab.
    const engineFrame = page.frames().find((f) => /\/engine\//.test(f.url()));
    await engineFrame?.evaluate(() => location.reload()).catch(() => null);
    const after = await waitState(page, (x) => (x.counters?.unexpectedLoads ?? 0) >= 1 && x.engineState === 'ready' && x.tabs.some((t) => t.id === tabId), 40_000, 'the replaced engine host').catch(() => null);
    await page.waitForTimeout(1000);
    const second0 = after ? await cmd({}) : null;
    if (after) await cmd({ tabId, announce: urls(30, 60) });
    await page.waitForTimeout(1500);
    const second = after ? await cmd({}) : null;
    const s = await state(page);
    const n1 = exposed(first);
    const n2 = exposed(second);
    const keys = (r) => (r?.allowlist ?? []).filter((k) => /^\*\.a6-\d+\.localhost$/.test(k));
    const union = new Set([...keys(first), ...keys(second0), ...keys(second)]).size;
    const paused = await page.evaluate(() => window.__gnomeBrowser.exposure?.paused ?? null).catch(() => null);
    // 20 per tab per minute (EXPOSURE_BUDGET): 30 forged → at most 20; 30 more within the minute, after the replacement:
    // no new site (the budget is the app page's); the app may have paused site rules after the compromise signals (D5)
    const ok = before === 0 && n1 > 0 && n1 <= 20 && !!after && n2 <= 20 && union <= 20;
    return {
      result: ok ? 'pass' : 'fail',
      notes: `rule-bearing sites the engine host held: before ${before}; after 30 forged ${n1}; after the engine iframe was replaced ${exposed(second0)}; after 30 more forged ${n2}; distinct over both ${union}; site rules paused ${paused}; protocol counters ${JSON.stringify(s?.counters ?? null)}; tab ${tabId}`,
    };
  } finally {
    await context.close().catch(() => null);
  }
}

export async function run(ctx) {
  const bk = ctx.stack.blocker;
  if (!bk || bk.mode !== 'test') {
    ctx.record({ test: 'blocker-attack', result: 'skip', notes: 'needs the test lists' });
    return;
  }
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await openBlockerApp(ctx, context);
    const refs = await listRefs(ctx);
    await applyBlocker(app, blockerSettings(refs));
    const ready = await waitBlocker(app);
    if (!ready.ok) ctx.record({ test: 'blocker-attack: blocker ready', result: 'fail', notes: JSON.stringify(ready.status) });
    let id = 300;
    const load = async (engine, url) => {
      const tab = id++;
      const s = await app.mark();
      const nav = await app.navigate(tab, url, { engine, create: true, timeout: 45_000 });
      const out = nav.ok ? await pageOut(app, tab, 60_000) : null;
      return { tab, s, nav, out };
    };
    const close = (tab) => app.cmd('tab.close', { tabId: tab }).catch(() => null);

    if (partOn(ctx, 'a0')) {
      await forEngines(ctx, 'A0 an ordinary page reaches the engine host or its realm (borrow-natives first)', async (engine) => {
        const r = await load(engine, bk.url('site-b', '/network/a0.html'));
        await close(r.tab);
        if (!r.out || r.out.raw !== undefined) return { result: 'fail', notes: `no result: ${JSON.stringify(r.out)}; nav ${JSON.stringify(r.nav.error ?? null)}` };
        const reached = Object.entries(r.out).filter(([, v]) => v === 'ENGINE-HOST').map(([k]) => k);
        const notes = Object.entries(r.out).map(([k, v]) => `${k}=${v}`).join(', ');
        if (!reached.length) return { result: 'pass', notes };
        // Allowed as a recorded limit (§11.1, §12.2): borrow-natives in both engines, Scramjet's client path.
        // `window[0] Window.prototype frameElement` is the same class as borrow-frameElement (a fresh child realm's
        // native getter); UV's child realms keep theirs native (webrtc.ts hardenUvRealm: GNOME's hook needs it).
        const allowed = reached.every((k) => k.startsWith('borrow-') || k === 'window[0].parent.parent' || k === 'window[0] Window.prototype frameElement' || (engine === 'scramjet' && k === 'scramjet client descriptors'));
        return { result: 'fail', expectFail: allowed ? 'measured limit (F2): a fresh child realm\'s native getters, and Scramjet\'s client global' : undefined, notes: `reached via ${reached.join(', ')}; ${notes}` };
      });
    }

    if (partOn(ctx, 'a1')) {
      await forEngines(ctx, 'A1 r1-realm-walk: nothing GNOME installs hands an ordinary page an engine-host object (normal calls and at the stack limit)', async (engine) => {
        const r = await load(engine, bk.url('site-b', '/network/a1.html'));
        await close(r.tab);
        const o = r.out;
        if (!o || o.checked === undefined) return { result: 'fail', notes: `no result: ${JSON.stringify(o)}` };
        const ok = o.checked > 100 && o.host.length === 0 && o.sweep.host === 0 && o.sweep.calls > 50 && o.installed.length >= 4 && !!o.dict && o.dict.host.length === 0;
        return {
          result: ok ? 'pass' : 'fail',
          notes: `checked ${o.checked}; engine-host functions ${o.host.length}${o.host.length ? ` (${o.host.join(', ')})` : ''}; sweep calls ${o.sweep.calls}, page errors ${o.sweep.page}, engine-host ${o.sweep.host}${o.sweep.hostIn.length ? ` (${o.sweep.hostIn.join(', ')})` : ''}; option dictionaries: page getters ran ${o.dict?.seen ?? '?'} times, engine-host values ${JSON.stringify(o.dict?.host ?? null)}; installed ${o.installed.join(', ')}; errors ${JSON.stringify(o.errors)}`,
        };
      });
    }

    if (partOn(ctx, 'sw')) {
      await forEngines(
        ctx,
        'A3/A3b a UV page posts blocker config, context, engines and gnome-claim (after a child realm pushState to /engine/): no effect, no signals',
        async (engine) => {
          const t0 = Date.now();
          const r = await load(engine, bk.url('site-b', '/network/attack.html?p=a3b'));
          await ctx.sleep(800);
          const blocked = await blockedOf(app, r.s, r.tab);
          await close(r.tab);
          const o = r.out ?? {};
          const beacons = bk.fixtures.requests({ since: t0, label: 'trk' }).filter((q) => /a3b/.test(q.path ?? q.url ?? '')).length;
          const ok = /^threw:SecurityError/.test(String(o.pushEngine)) && o.after === 403 && o.afterImg === 'error' && beacons === 0 && o.signals === 0;
          return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(o)}; tracker beacon requests ${beacons}; tab.blocked ${JSON.stringify(blocked)}` };
        },
        { engines: ['ultraviolet'] },
      );
    }

    if (partOn(ctx, 'a7')) {
      await forEngines(
        ctx,
        'A7 a UV page opens a WebSocket to the ad host through bare-mux directly, past GNOME\'s wrapper (recorded)',
        async (engine) => {
          const t0 = Date.now();
          const r = await load(engine, bk.url('site-b', '/network/a7.html'));
          await close(r.tab);
          const upgrades = bk.fixtures.requests({ since: t0 }).filter((q) => q.method === 'UPGRADE' && q.label === 'ads').length;
          const o = r.out ?? {};
          if (o.a7 === 'open' || upgrades > 0) {
            // A bypass (WAVE-B3 §11.1, D16): Ultraviolet's sockets are judged only in GNOME's createWebSocket wrapper.
            return { result: 'fail', expectFail: 'measured bypass: a page that loads bare-mux\'s client in a realm Ultraviolet never hooked opens sockets past the wrapper (About lists it)', notes: `${JSON.stringify(o)}; WebSocket upgrades at ads.localhost ${upgrades}` };
          }
          return { result: o.a7 && o.a7 !== 'no client' ? 'pass' : 'fail', notes: `${JSON.stringify(o)}; WebSocket upgrades at ads.localhost ${upgrades}` };
        },
        { engines: ['ultraviolet'] },
      );
    }

    if (partOn(ctx, 'a8')) {
      await forEngines(ctx, 'A8 a page pushState to another origin: SecurityError, the address and policy stay', async (engine) => {
        const r = await load(engine, bk.url('site-b', '/network/attack.html?p=a8'));
        await ctx.sleep(500);
        const commits = (await app.eventsSince(r.s)).filter((e) => e.type === 'tab.committed' && e.p.tabId === r.tab).map((e) => e.p.url);
        await close(r.tab);
        const stayed = commits.every((u) => u.includes('site-b.localhost')) && String(r.out?.a8location ?? '').includes('site-b.localhost');
        // UV: GNOME's wrapper throws (F4). Scramjet: measured to keep the URL without throwing (its own history hook).
        const ok = stayed && (engine === 'scramjet' || /^threw:SecurityError/.test(String(r.out?.a8)));
        return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(r.out)}; commits ${commits.join(' ')}${engine === 'scramjet' && r.out?.a8 === 'no error' ? ' (Scramjet: no SecurityError; the URL did not change)' : ''}` };
      });
    }

    if (partOn(ctx, 'a9')) {
      await forEngines(ctx, 'A9 a synthetic securitypolicyviolation event is not counted', async (engine) => {
        const r = await load(engine, bk.url('site-b', '/network/attack.html?p=a9'));
        await ctx.sleep(900);
        const blocked = await blockedOf(app, r.s, r.tab);
        await close(r.tab);
        const ok = r.out?.a9 === 'dispatched' && !(blocked?.byCategory?.['direct-connection'] > 0);
        return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(blocked)}` };
      });
    }

    if (partOn(ctx, 'a10')) {
      await forEngines(
        ctx,
        'A10 a Scramjet page reopens a WebSocket the wrapper blocked through the client’s own method: still blocked',
        async () => {
          const r = await load('scramjet', bk.url('site-a', '/network/attack.html?p=a10'));
          await close(r.tab);
          const ok = r.out?.a10ws !== 'open' && r.out?.a10client !== 'open' && r.out?.a10client !== 'no client';
          return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(r.out) };
        },
        { engines: ['scramjet'] },
      );
    }
    if (partOn(ctx, 'a6')) {
      let r;
      try {
        r = await rowA6(ctx, browser);
      } catch (err) {
        r = { result: 'fail', notes: `threw: ${String(err?.stack ?? err).slice(0, 600)}` };
      }
      ctx.record({ test: 'A6 forged tab.loading.url announcements from the engine-host realm: at most 20 newly exposed rule-bearing sites per tab per minute, across an engine-iframe replacement', ...r });
    }

    if (partOn(ctx, 'a5')) {
      await forEngines(ctx, 'A5 a page searches Cache Storage, IndexedDB and Web Storage for site rules: finds none', async (engine) => {
        await applyBlocker(app, blockerSettings(refs, { allowlist: ['*.gnome-secret-rule.localhost'], perSite: { 'gnome-secret-site.localhost': { adblock: false } } }));
        const r = await load(engine, bk.url('site-b', '/network/page.html'));
        const f = app.tabFrame(r.tab);
        const found = f
          ? await f
              .evaluate(async () => {
                const hits = [];
                const look = (where, text) => {
                  if (/gnome-secret-(rule|site)/.test(text)) hits.push(where);
                };
                for (const name of await caches.keys()) {
                  const c = await caches.open(name);
                  for (const k of await c.keys()) look(`cache ${name} ${k.url}`, (await (await c.match(k)).text()).slice(0, 2_000_000));
                }
                for (let i = 0; i < localStorage.length; i++) look('localStorage', String(localStorage.getItem(localStorage.key(i))));
                const dbs = indexedDB.databases ? await indexedDB.databases() : [];
                const names = dbs.map((d) => d.name);
                return { hits, dbs: names, searched: true };
              })
              .catch((e) => ({ error: String(e) }))
          : null;
        await close(r.tab);
        await applyBlocker(app, blockerSettings(refs));
        return { result: found?.searched && found.hits.length === 0 ? 'pass' : 'fail', notes: `${JSON.stringify(found)} (IndexedDB databases listed by name; GNOME writes no rules into any)` };
      });
    }

    if (partOn(ctx, 'a4')) {
      await forEngines(
        ctx,
        'A4 a page holds the build lock: the build completes ≤ 30 s later anyway',
        async (engine) => {
          const context2 = await ctx.newContext(browser);
          const app2 = await openBlockerApp(ctx, context2);
          try {
            const tab = id++;
            await app2.navigate(tab, bk.url('site-b', '/network/page.html'), { engine, create: true, timeout: 45_000 });
            const f = app2.tabFrame(tab);
            const held = f ? await f.evaluate(() => new Promise((resolve) => { navigator.locks.request('gnome-blocker-build', () => { resolve('held'); return new Promise(() => {}); }).catch((e) => resolve('threw:' + e.name)); })).catch((e) => `error:${e}`) : 'no frame';
            const app3 = await openBlockerApp(ctx, context2);
            const t0 = Date.now();
            await applyBlocker(app3, blockerSettings(refs));
            const rd = await waitBlocker(app3, { timeout: 60_000 });
            await app3.close().catch(() => null);
            return { result: held === 'held' && rd.ok && Date.now() - t0 <= 36_000 ? 'pass' : 'fail', notes: `page lock ${held}; ready after ${Date.now() - t0} ms` };
          } finally {
            await app2.close().catch(() => null);
            await context2.close().catch(() => null);
          }
        },
        { engines: ['ultraviolet'] },
      );
    }

    if (partOn(ctx, 'cors')) {
      // Measurement only (no claim): the facts the integration step needs for "can GNOME's SW emulate CORS?".
      await forEngines(ctx, 'CORS (measured): a page reads cross-site responses; what the upstream received', async (engine) => {
        const t0 = Date.now();
        const r = await load(engine, bk.url('site-a', '/network/cors.html'));
        await close(r.tab);
        const echo = (name) => {
          try {
            return JSON.parse(r.out?.[name]?.body ?? 'null');
          } catch {
            return null;
          }
        };
        const seen = bk.fixtures.requests({ since: t0, label: 'site-b' }).map((q) => `${q.method} ${q.path} origin=${q.headers?.origin ?? '-'} referer=${(q.headers?.referer ?? '-').slice(0, 40)} cookie=${q.headers?.cookie ? 'yes' : 'no'}`);
        const facts = {
          readsWithoutCorsHeaders: !!r.out?.noCorsHeadersCookies?.readable,
          xhrReadsWithoutCorsHeaders: !!r.out?.xhr?.readable,
          originSentWithCorsFetch: echo('corsEcho')?.headers?.origin ?? null,
          originSentWithCredentials: echo('corsEchoCredentials')?.headers?.origin ?? null,
          preflightSeen: seen.some((x) => x.startsWith('OPTIONS')),
          putArrived: seen.some((x) => x.startsWith('PUT')),
        };
        return { result: 'pass', notes: `measured ${JSON.stringify(facts)}; upstream saw ${seen.join(' | ')}; page ${JSON.stringify(r.out).slice(0, 600)}` };
      });
    }
    await app.close();
  } finally {
    await context.close();
    await browser.close();
  }
}
