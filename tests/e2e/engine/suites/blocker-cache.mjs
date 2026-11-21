// Lane x1 (docs/WAVE-B3.md §12.2 "Cache", rows S1–S10): the MAC'd engine cache in Cache Storage on the proxy origin
// (D6, §4.3). Each row uses its own browser context (its own Cache Storage and service worker) and the driver's
// `blockerKey` query key (init.blockerKey). The driver's init carries no lists; each engine host gets them with its
// first `settings` command, so "ready after init" is measured from that command. Parts: s1, attacks, limit, reload,
// page, clear, lock.
import fs from 'node:fs';
import { applyBlocker, blockerSettings, listRefs, openBlockerApp, pageOut, partOn, testCmd, waitBlocker } from './blocker-network.mjs';

const KEY = 'c0ffee'.padEnd(64, '7');
const KEY2 = 'beef'.padEnd(64, '3');

export async function run(ctx) {
  const bk = ctx.stack.blocker;
  if (!bk || bk.mode !== 'test') {
    ctx.record({ test: 'blocker-cache', result: 'skip', notes: 'needs the test lists' });
    return;
  }
  const refs = await listRefs(ctx);
  const base = blockerSettings(refs);
  const rec = (test, ok, notes, extra = {}) => ctx.record({ test, result: ok ? 'pass' : 'fail', notes, ...extra });
  const browser = await ctx.launch();
  /** One engine host in `context`, its lists applied; returns {app, ready, stats}. */
  const host = async (context, query = {}, settings = base) => {
    const app = await openBlockerApp(ctx, context, query);
    const t0 = Date.now();
    await applyBlocker(app, settings);
    const ready = await waitBlocker(app);
    const stats = await app.cmd('blocker.stats', {}).catch((e) => ({ error: String(e) }));
    return { app, ready: { ...ready, ms: Date.now() - t0 }, stats };
  };
  try {
    if (partOn(ctx, 's1') || partOn(ctx, 'attacks')) {
      const context = await ctx.newContext(browser);
      try {
        const a = await host(context, { blockerKey: KEY });
        const b = await host(context, { blockerKey: KEY });
        rec('S1 a second engine host loads the cached set (source cache, ready ≤ 500 ms after its settings)', a.stats?.source === 'build' && b.stats?.source === 'cache' && b.ready.ms <= 500 && b.stats.cache.entries >= 2, `first ${a.stats?.source} in ${a.ready.ms} ms; second ${b.stats?.source} in ${b.ready.ms} ms; cache ${JSON.stringify(b.stats?.cache)}`);
        if (partOn(ctx, 'attacks')) {
          // S2: a planted manifest (forged MAC) as a page that reaches Cache Storage would write it.
          await testCmd(b.app, 'test.blocker', { plant: true });
          const c = await host(context, { blockerKey: KEY });
          rec('S2 a planted set (forged MAC) is not used: rebuilt, cache-rejected once', c.stats?.source === 'build' && c.ready.status?.detail === 'cache-rejected', `source ${c.stats?.source}; status ${JSON.stringify(c.ready.status)}`);
          // S3: one flipped byte in every cached group.
          await testCmd(c.app, 'test.blocker', { corrupt: true });
          const d = await host(context, { blockerKey: KEY });
          rec('S3 one flipped byte in a group: rebuilt', d.stats?.source === 'build' && d.ready.status?.detail === 'cache-rejected', `source ${d.stats?.source}; status ${JSON.stringify(d.ready.status)}`);
          // the key binding: another blockerKey (a rotated key) never verifies the old MAC
          const e = await host(context, { blockerKey: KEY2 });
          rec('S10 (key side) a set MAC\'d under another key is refused and rebuilt', e.stats?.source === 'build', `source ${e.stats?.source}; status ${JSON.stringify(e.ready.status)} (the replay of an older manifest under a newer K: unit test cache.test.ts)`);
          for (const x of [c, d, e]) await x.app.close().catch(() => null);
        }
        await a.app.close().catch(() => null);
        await b.app.close().catch(() => null);
      } finally {
        await context.close();
      }
    }

    if (partOn(ctx, 'limit')) {
      const context = await ctx.newContext(browser);
      try {
        const big = await listRefs(ctx, { extra: ['big'] });
        const a = await host(context, { blockerKey: KEY }, blockerSettings(big, { cacheLimitMB: 16 }));
        const total = (a.stats?.engines ?? []).reduce((n, g) => n + g.bytes, 0);
        const over = total > 16 * 1024 * 1024;
        const detail = a.ready.status?.detail ?? '';
        const limited = over && detail === `over-cache-limit:${total}:${16 * 1024 * 1024}` && a.stats.cache.entries === 0 && a.stats.source === 'build';
        await a.app.close().catch(() => null);
        // the same set at the default 256 MiB: cached, and the next engine host loads it from there
        const b = await host(context, { blockerKey: KEY }, blockerSettings(big, { cacheLimitMB: 256 }));
        // the set goes into the cache after it is in force (ready): wait for the write to finish
        for (let i = 0; i < 40 && !(b.stats?.cache?.bytes >= total); i++) {
          await ctx.sleep(250);
          b.stats = await b.app.cmd('blocker.stats', {}).catch(() => b.stats);
        }
        const c = await host(context, { blockerKey: KEY }, blockerSettings(big, { cacheLimitMB: 256 }));
        const cached = b.stats?.source === 'build' && b.ready.status?.detail === null && b.stats.cache.entries >= 2 && b.stats.cache.bytes >= total && c.stats?.source === 'cache';
        ctx.record({
          test: 'S4 cacheLimitMB 16 with the big list: not cached, over-cache-limit (and cached at 256)',
          result: over ? (limited && cached ? 'pass' : 'fail') : 'skip',
          notes: `set ${total} bytes (${over ? 'over' : 'NOT over'} 16 MiB); at 16: status ${JSON.stringify(a.ready.status)}, cache ${JSON.stringify(a.stats?.cache)}, source ${a.stats?.source}; at 256: status ${JSON.stringify(b.ready.status)}, cache ${JSON.stringify(b.stats?.cache)}, next host ${c.stats?.source} in ${c.ready.ms} ms`,
        });
        await b.app.close().catch(() => null);
        await c.app.close().catch(() => null);
      } finally {
        await context.close();
      }
    }

    if (partOn(ctx, 'reload')) {
      const context = await ctx.newContext(browser);
      try {
        const a = await host(context, { blockerKey: KEY });
        // a UV tab is open, so the engine host sends the SW every set it swaps in
        const uvTab = 51;
        await a.app.navigate(uvTab, bk.url('site-b', '/network/page.html'), { engine: 'ultraviolet', create: true, timeout: 45_000 });
        await ctx.sleep(1100); // builtAt has millisecond resolution: the rebuild's must differ
        const s = await a.app.mark();
        await a.app.cmd('blocker.reload', {});
        const tab = 50;
        // the old set stays in force during the rebuild (D7)
        await a.app.navigate(tab, bk.url('site-a', '/network/page.html?p=ad'), { engine: 'scramjet', create: true, timeout: 45_000 });
        const during = await pageOut(a.app, tab);
        let stats = await a.app.cmd('blocker.stats', {});
        for (let i = 0; i < 80 && !(stats.builtAt > a.stats.builtAt); i++) {
          await ctx.sleep(250);
          stats = await a.app.cmd('blocker.stats', {});
        }
        const ready = await waitBlocker(a.app);
        const statuses = (await a.app.eventsSince(s)).filter((e) => e.type === 'status').map((e) => e.p.blocker.state);
        // after the swap, UV pages are judged by the set the SW got from this engine host
        const tab2 = 52;
        await a.app.navigate(tab2, bk.url('site-a', '/network/page.html?p=ad'), { engine: 'ultraviolet', create: true, timeout: 45_000 });
        const uv = await pageOut(a.app, tab2);
        // D7 and §4.1: the state stays `ready` while a newer set builds (the plan's S6 text "building → ready" predates
        // that rule); a rebuild shows as a new builtAt.
        const ok = stats.source === 'build' && stats.builtAt > a.stats.builtAt && ready.ok && during?.ad === 'error' && !statuses.includes('building') && uv?.ad === 'error';
        rec('S6 blocker.reload: rebuilt (a newer build in force), the old set blocks meanwhile, the state stays ready (D7), UV pages blocked after the swap', ok, `during ${JSON.stringify(during)}; status events ${JSON.stringify(statuses)}; built ${a.stats.builtAt} → ${stats.builtAt} (${stats.source}); UV after ${JSON.stringify(uv)}`);
        await a.app.close().catch(() => null);
      } finally {
        await context.close();
      }
    }

    if (partOn(ctx, 'page')) {
      const context = await ctx.newContext(browser);
      try {
        const a = await host(context, { blockerKey: KEY });
        // S8 / O3: an ordinary UV page reaches the proxy origin's Cache Storage.
        const tab = 60;
        await a.app.navigate(tab, bk.url('site-b', '/network/page.html'), { engine: 'ultraviolet', create: true, timeout: 45_000 });
        const f = a.app.tabFrame(tab);
        const r = f
          ? await f
              .evaluate(async () => {
                const out = { names: await caches.keys() };
                if (out.names.includes('gnome-blocker-v1')) {
                  const c = await caches.open('gnome-blocker-v1');
                  const keys = await c.keys();
                  out.entries = keys.length;
                  const m = keys.find((k) => k.url.endsWith('manifest.json'));
                  const text = m ? await (await c.match(m)).text() : '';
                  const nums = [];
                  const walk = (v) => (typeof v === 'number' ? nums.push(v) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : null);
                  walk(text ? JSON.parse(text) : null);
                  out.maxNumber = Math.max(0, ...nums);
                  out.deleted = await caches.delete('gnome-blocker-v1');
                }
                return out;
              })
              .catch((e) => ({ error: String(e) }))
          : null;
        const b = await host(context, { blockerKey: KEY });
        rec('S8 a UV page reads caches.keys() and the manifest (no millisecond timestamps) and deletes it: the next start rebuilds', r?.deleted === true && r.maxNumber < 1e10 && b.stats?.source === 'build', `page ${JSON.stringify(r)}; next ${b.stats?.source}`);
        await a.app.close().catch(() => null);
        await b.app.close().catch(() => null);
      } finally {
        await context.close();
      }
    }

    if (partOn(ctx, 'clear')) {
      const context = await ctx.newContext(browser);
      try {
        const a = await host(context, { blockerKey: KEY });
        await a.app.cmd('siteData.clear', { kinds: ['storage', 'cache'] });
        const after = await a.app.cmd('blocker.stats', {});
        await a.app.cmd('blocker.reload', {});
        await waitBlocker(a.app);
        const still = await a.app.cmd('blocker.stats', {});
        // the app replaces blockerKey after a clear (x4): the next engine host starts with another key
        const b = await host(context, { blockerKey: KEY2 });
        rec('S9 "Clear site data": the cache is gone, nothing more is written this session, the next key rebuilds', after.cache.entries === 0 && still.cache.entries === 0 && b.stats?.source === 'build', `after clear ${JSON.stringify(after.cache)}; after a rebuild in the same session ${JSON.stringify(still.cache)}; next host ${b.stats?.source}`);
        await a.app.close().catch(() => null);
        await b.app.close().catch(() => null);
      } finally {
        await context.close();
      }
    }

    if (partOn(ctx, 'changed')) {
      // S5: a list rewritten on the server while the app's listing (the refs) is stale: that list fails with
      // `changed`, the others compile; with the new hash it builds again. (The app's listing refresh is x4's part.)
      const context = await ctx.newContext(browser);
      const id = 'e2e-network-s5';
      const l = bk.lists.find((x) => x.id === id);
      const original = l ? fs.readFileSync(l.file, 'utf8') : null;
      try {
        // The refs as the app's stale listing has them; then the list changes on the server. A fresh context: an engine
        // host that already fetched `?v=<old hash>` gets the old body from the HTTP cache (immutable by hash), which is
        // right: that hash names that body.
        const stale = blockerSettings(await listRefs(ctx, { extra: [id] }));
        // Content this server never stored before (a later browser of the run must not meet an earlier version).
        bk.writeList(id, `${original}\n||s5b-${ctx.browser}-${Date.now()}.localhost^\n`);
        const refresh = await bk.refreshLists({ ids: [id] });
        const a = { app: await openBlockerApp(ctx, context) };
        await applyBlocker(a.app, stale);
        await waitBlocker(a.app);
        await ctx.sleep(500);
        const st = (await a.app.status()).blocker;
        const stats = await a.app.cmd('blocker.stats', {});
        const entry = stats.lists.find((x) => x.id === id);
        const fresh = await listRefs(ctx, { extra: [id] });
        await applyBlocker(a.app, blockerSettings(fresh));
        await waitBlocker(a.app);
        await ctx.sleep(1500);
        const after = (await a.app.cmd('blocker.stats', {})).lists.find((x) => x.id === id);
        rec('S5 a list rewritten on the server (stale refs): failed with `changed`, lists-failed; the new hash builds', entry?.error === 'changed' && /^lists-failed:1:/.test(st.detail ?? '') && after?.state === 'compiled', `refresh exit ${refresh.code}; status ${JSON.stringify(st)}; list ${JSON.stringify(entry)}; with the new hash ${JSON.stringify(after)}`);
        await a.app.close().catch(() => null);
      } finally {
        if (original !== null) {
          bk.writeList(id, original);
          await bk.refreshLists({ ids: [id] });
        }
        await context.close();
      }
    }

    if (partOn(ctx, 'lock')) {
      const context = await ctx.newContext(browser);
      try {
        // S7: two engine hosts start with an empty cache at the same time: one build (Web Lock), both ready.
        const [x, y] = await Promise.all([openBlockerApp(ctx, context, { blockerKey: KEY }), openBlockerApp(ctx, context, { blockerKey: KEY })]);
        await Promise.all([applyBlocker(x, base), applyBlocker(y, base)]);
        const [rx, ry] = await Promise.all([waitBlocker(x), waitBlocker(y)]);
        const [sx, sy] = await Promise.all([x.cmd('blocker.stats', {}), y.cmd('blocker.stats', {})]);
        const sources = [sx.source, sy.source].sort();
        rec('S7 two engine hosts, empty cache: one build, the other loads it; both ready', rx.ok && ry.ok && sources[0] === 'build' && sources[1] === 'cache', `sources ${sources.join(', ')}; ready ${rx.ms}/${ry.ms} ms`);
        await x.close().catch(() => null);
        await y.close().catch(() => null);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
