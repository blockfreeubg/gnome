// Lane x1 (docs/WAVE-B3.md §12.2 "Network", rows N1–N18): list-based network blocking on the real stack (gnome-server
// with the run's file lists, HolyWisp, the fixture server of servers/blocker-fixtures.mjs reached through the VPN
// profile route `e2e-vpn`), in both engines. The engine host offers `blocker` through the e2e build switch (D19).
// Test lists: fixtures/blocker/lists/network.txt (ads), network-trackers.txt (privacy), network-security.txt
// (security); fixture pages: fixtures/blocker/network/shared/page.html?p=<probes> (README there).
//
// Parts (--parts): network (N1–N10, N13, N14, N18), counts (N13b), unbreak (N19), policy (N11, N15–N17), hold (N12). Exports the helpers the other
// x1 suites (blocker-uv, blocker-cache, blocker-attack) share.
import { tabText } from '../lib/tab-read.mjs';

export const ENGINES = ['scramjet', 'ultraviolet'];

/** The run's listing → FilterListRef[] of every available default list plus the resources (what x4's filterListRefs does). */
export async function listRefs(ctx, { only = null, extra = [] } = {}) {
  const listing = await ctx.stack.blocker.listing();
  if (!listing) throw new Error('GET /api/filters failed');
  const pick = (l) => l.available && l.sha256 && (only ? only.includes(l.id) : l.default_enabled || extra.includes(l.id));
  const refs = listing.lists.filter(pick).map((l) => ({ id: l.id, sha256: l.sha256, category: l.category, format: l.format, trusted: l.trusted }));
  const r = listing.resources;
  if (r && r.available && r.sha256) refs.push({ id: r.id, sha256: r.sha256, category: 'resources', format: 'resources', trusted: r.trusted });
  return refs.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Content-blocking settings for the driver's `settings` command (a full snapshot with these parts changed). */
export function blockerSettings(refs, over = {}) {
  return {
    privacy: { webrtc: 'block', sendGpc: false, doNotTrack: false, referrer: 'default', stripTrackingParams: false, cookies: 'all', ...(over.privacy ?? {}) },
    extensions: {
      enabled: { adblock: true, trackers: true, privacy: false, cookies: false, cosmetic: true, ...(over.enabled ?? {}) },
      lists: refs,
      allowlist: over.allowlist ?? [],
      perSite: over.perSite ?? {},
      cosmeticAggressive: false,
      cookieRules: {},
      ...(over.cacheLimitMB ? { cacheLimitMB: over.cacheLimitMB } : {}),
    },
  };
}

export async function applyBlocker(app, settings) {
  return app.gnome((s) => window.gnomeTest.applySettings(s), settings);
}

/** Waits until status.blocker is `state` (default ready); returns the last status and how long it took. */
export async function waitBlocker(app, { state = 'ready', timeout = 60_000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = (await app.status().catch(() => null))?.blocker ?? last;
    if (last && last.state === state) return { ok: true, ms: Date.now() - t0, status: last };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, ms: Date.now() - t0, status: last };
}

/** The `#out` JSON of a fixture page in the tab (read through the engine host's frame), once it is not "pending". */
export async function pageOut(app, tabId, timeout = 30_000) {
  const end = Date.now() + timeout;
  let text = null;
  while (Date.now() < end) {
    text = await tabText(app.page, tabId, '#out', { timeout: Math.max(1000, end - Date.now()) }).catch(() => null);
    if (text && text !== 'pending') {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { raw: text };
}

/** The last tab.blocked of a tab since `seq`. */
export async function blockedOf(app, since, tabId) {
  return (await app.eventsSince(since)).filter((e) => e.type === 'tab.blocked' && e.p.tabId === tabId).pop()?.p ?? null;
}

/** A test.* command: the driver validates every result against the protocol, which has none for test.* (host-hooks.mjs). */
export async function testCmd(app, type, p) {
  try {
    await app.cmd(type, p);
  } catch (e) {
    if (!/invalid test\./.test(String(e.message))) throw e;
  }
}

/** Clicks an element of the tab's top document from inside it (playwright's click is unreliable in Firefox frames). */
export async function clickIn(app, tabId, selector) {
  const f = app.tabFrame(tabId);
  if (!f) return false;
  return f.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector).catch(() => false);
}

export async function forEngines(ctx, test, fn, { engines = ENGINES } = {}) {
  for (const engine of engines) {
    let r;
    try {
      r = await fn(engine);
    } catch (err) {
      r = { result: 'fail', notes: `threw: ${String(err?.stack ?? err).slice(0, 600)}` };
    }
    ctx.record({ test, engine, transport: 'libcurl', ...r });
  }
}

export function partOn(ctx, part) {
  return !ctx.parts || ctx.parts.includes(part);
}

export async function openBlockerApp(ctx, context, extra = {}) {
  return ctx.openApp(context, { route: 'profile:e2e-vpn', fallback: '0', ...extra });
}

export async function run(ctx) {
  const bk = ctx.stack.blocker;
  if (!bk || bk.mode !== 'test') {
    ctx.record({ test: 'blocker-network', result: 'skip', notes: 'needs the test lists (not --blocker-real)' });
    return;
  }
  const page = (label, probes, extra = '') => bk.url(label, `/network/page.html?p=${probes}${extra}`);
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await openBlockerApp(ctx, context);
    const caps = (await app.gnome(() => window.gnomeTest.init?.capabilities ?? null)) ?? [];
    if (!caps.includes('blocker')) {
      ctx.record({ test: 'blocker-network: capability', result: 'fail', notes: `the engine host does not offer blocker: ${JSON.stringify(caps)} (build without GNOME_ENGINE_TEST_CAPABILITIES=blocker?)` });
      await app.close();
      return;
    }
    const refs = await listRefs(ctx);
    const base = blockerSettings(refs);
    await applyBlocker(app, base);
    const ready = await waitBlocker(app);
    ctx.record({ test: 'blocker: first build ready', result: ready.ok ? 'pass' : 'fail', notes: `${ready.ms} ms; status ${JSON.stringify(ready.status)}; lists ${refs.map((r) => r.id).join(', ')}` });
    const stats = await app.cmd('blocker.stats', {}).catch((e) => ({ error: String(e) }));
    ctx.record({ test: 'blocker.stats after the first build', result: stats?.source === 'build' && stats.engines?.length >= 2 ? 'pass' : 'fail', notes: JSON.stringify(stats).slice(0, 900) });
    let id = 100;

    const open = new Set();
    const closeTabs = async () => {
      for (const t of open) await app.cmd('tab.close', { tabId: t }).catch(() => null);
      open.clear();
    };
    /** Loads a page in a new tab; the tab stays open until the next row (closeTabs), at most 32 per engine host. */
    const load = async (engine, url) => {
      if (open.size >= 6) await closeTabs();
      const tab = id++;
      open.add(tab);
      const s = await app.mark();
      const nav = await app.navigate(tab, url, { engine, create: true, timeout: 45_000 });
      const out = nav.ok ? await pageOut(app, tab) : null;
      await ctx.sleep(700); // tab.blocked is coalesced (500 ms)
      const blocked = await blockedOf(app, s, tab);
      return { tab, s, nav, out, blocked };
    };

    if (partOn(ctx, 'network')) {
      await forEngines(ctx, 'N1 third-party ad script blocked, counted ads', async (engine) => {
        const r = await load(engine, page('site-a', 'ad'));
        const ok = r.nav.ok && r.out?.ad === 'error' && r.out?.adRan === 0 && (r.blocked?.byCategory?.ads ?? 0) >= 1;
        return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}; nav ${r.nav.ok ? 'ok' : JSON.stringify(r.nav.error)}` };
      });
      await forEngines(ctx, 'N2 the same script on an ads.localhost page loads (first party)', async (engine) => {
        const r = await load(engine, page('ads', 'ad'));
        return { result: r.out?.ad === 'load' && r.out?.adRan === 1 ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}` };
      });
      await forEngines(ctx, 'N3 tracker pixel blocked, counted trackers, never requested', async (engine) => {
        const before = bk.fixtures.beacons({ label: 'trk', id: 'n3' });
        const r = await load(engine, page('site-a', 'trk'));
        const after = bk.fixtures.beacons({ label: 'trk', id: 'n3' });
        const ok = r.out?.trk === 'error' && (r.blocked?.byCategory?.trackers ?? 0) >= 1 && after === before;
        return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}; beacons ${before}→${after}` };
      });
      await forEngines(ctx, 'N4 an exception in another list unblocks (shared lines)', async (engine) => {
        const r = await load(engine, page('site-a', 'ok'));
        return { result: r.out?.ok === 'load' && r.out?.okRan === 1 ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}` };
      });
      await forEngines(ctx, 'N5 $badfilter in list B disables a rule of list A', async (engine) => {
        const r = await load(engine, page('site-a', 'bf'));
        return { result: r.out?.bf === 'load' && r.out?.bfRan === 1 ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}` };
      });
      await forEngines(ctx, 'N6 $redirect=noop.js answers 200 with the stub, counted', async (engine) => {
        const r = await load(engine, page('site-a', 'stub'));
        const ok = r.out?.stub === 'load' && r.out?.realStub === 0 && (r.blocked?.byCategory?.ads ?? 0) >= 1;
        return {
          result: ok ? 'pass' : 'fail',
          notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}${engine === 'ultraviolet' ? '; UV: that the stub went through UV\'s JS rewriter is row N6b\'s (noop.js reads nothing)' : ''}`,
        };
      });
      await forEngines(ctx, 'N6b a $redirect script resource runs as page code the engine rewrote (its location.assign stays in the proxy)', async (engine) => {
        await closeTabs();
        const tab = id++;
        open.add(tab);
        const land = bk.url('site-a', '/network/page.html?landed=n6b');
        const s = await app.mark();
        const nav = await app.navigate(tab, page('site-a', 'ga', `&land=${encodeURIComponent(land)}`), { engine, create: true, timeout: 45_000 });
        const landed = await app.waitFor(s, (e) => e.type === 'tab.committed' && e.p.tabId === tab && /landed=n6b/.test(e.p.url), 20_000).catch(() => null);
        await ctx.sleep(500);
        const evs = (await app.eventsSince(s)).filter((e) => e.p?.tabId === tab);
        const err = evs.find((e) => e.type === 'tab.error')?.p ?? null;
        const ok = nav.ok && !!landed && landed.p.engine === engine && landed.p.url === land && err === null;
        return { result: ok ? 'pass' : 'fail', notes: `committed ${JSON.stringify(landed?.p ?? null)}; tab.error ${JSON.stringify(err)}; first load ${nav.ok ? 'ok' : JSON.stringify(nav.error)}` };
      });
      await forEngines(ctx, 'N7 $subdocument and $redirect=noop.html frames are empty (never a resource), counted', async (engine) => {
        const r = await load(engine, page('site-a', 'adframe,frame2'));
        const text = (f) => f?.text ?? null;
        const ok = r.nav.ok && text(r.out?.adframe) !== 'AD FRAME CONTENT' && text(r.out?.frame2) !== 'AD FRAME CONTENT' && (r.blocked?.byCategory?.ads ?? 0) >= 2;
        return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}` };
      });
      await forEngines(ctx, 'N8 a $document rule blocks the tab document: tab.error blocked, fallback none, no commit, no subresource', async (engine) => {
        await closeTabs();
        const tab = id++;
        open.add(tab);
        const t0 = Date.now();
        const s = await app.mark();
        const url = bk.url('docblock', '/network/page.html?p=ad');
        const nav = await app.navigate(tab, url, { engine, create: true, timeout: 45_000 });
        await ctx.sleep(500);
        const evs = await app.eventsSince(s);
        const err = evs.find((e) => e.type === 'tab.error' && e.p.tabId === tab)?.p ?? null;
        const committed = evs.filter((e) => e.type === 'tab.committed' && e.p.tabId === tab && e.p.url.includes('docblock.localhost'));
        // Nothing of the blocked site is requested, its favicon included (the engine host fetches a page's favicon only
        // for a document that loaded).
        await ctx.sleep(1000);
        const seen = bk.fixtures.requests({ since: t0, label: 'docblock' });
        const reqs = seen.length;
        const ok = err?.kind === 'blocked' && err.fallback === 'none' && /^blocked:ads$/.test(err.detail) && committed.length === 0 && reqs === 0;
        return { result: ok ? 'pass' : 'fail', notes: `tab.error ${JSON.stringify(err)}; commits ${committed.length}; docblock requests ${JSON.stringify(seen.map((q) => `${q.method} ${q.path ?? q.url}`))}; nav ok ${nav.ok}` };
      });
      await forEngines(ctx, 'N9 a badware-list rule blocks, counted security', async (engine) => {
        const r = await load(engine, page('site-a', 'bad'));
        const ok = r.out?.bad === 'error' && (r.blocked?.byCategory?.security ?? 0) >= 1;
        return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}` };
      });
      await forEngines(ctx, 'N10 a WebSocket to an ad host fails, counted (another host opens)', async (engine) => {
        const r = await load(engine, page('site-a', 'ws,wsok'));
        const ok = r.out?.ws !== 'open' && r.out?.wsok === 'open' && (r.blocked?.byCategory?.ads ?? 0) >= 1;
        return {
          result: ok ? 'pass' : 'fail',
          notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}${engine === 'scramjet' ? ' (Scramjet: the transport backstop, judged without per-site context; D16 per-document wrapper not built)' : ''}`,
        };
      });
      await forEngines(ctx, 'N13 counts per category; total includes direct-connection', async (engine) => {
        const r = await load(engine, page('site-a', 'ad,trk,bad,direct'));
        // Firefox reports the CSP violation of the injected style later than the page's load (measured: not within 0.7 s).
        await ctx.sleep(3000);
        r.blocked = (await blockedOf(app, r.s, r.tab)) ?? r.blocked;
        const by = r.blocked?.byCategory ?? {};
        const sum = Object.values(by).reduce((a, b) => a + b, 0);
        const ok = (by.ads ?? 0) >= 1 && (by.trackers ?? 0) >= 1 && (by.security ?? 0) >= 1 && (by['direct-connection'] ?? 0) >= 1 && r.blocked?.total === sum;
        return { result: ok ? 'pass' : 'fail', notes: `tab.blocked ${JSON.stringify(r.blocked)}` };
      });
      await forEngines(ctx, 'N14 fetch() and XHR to an ad URL: an empty 403 (recorded)', async (engine) => {
        const r = await load(engine, page('site-a', 'fetch'));
        const f = r.out?.fetch;
        const x = r.out?.fetchXhr;
        const ok = f && x && (f.status === 403 || f.error) && (x.status === 403 || x.error);
        return { result: ok ? 'pass' : 'fail', notes: `fetch ${JSON.stringify(f)}; xhr ${JSON.stringify(x)}` };
      });
      await forEngines(ctx, 'N18 a $redirect-rule in the ads list answers a trackers block with its stub', async (engine) => {
        const r = await load(engine, page('site-a', 'rr'));
        const ok = r.out?.rr === 'load' && r.out?.realRr === 0 && (r.blocked?.byCategory?.trackers ?? 0) >= 1;
        return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(r.out)}; tab.blocked ${JSON.stringify(r.blocked)}` };
      });
    }

    if (partOn(ctx, 'unbreak')) {
      await forEngines(ctx, 'N19 a root/body :style() unbreak rule that only restores the page applies; a rule that would hide the root is dropped', async (engine) => {
        const r = await load(engine, bk.url('idp', '/network/unbreak.html'));
        const o = r.out ?? {};
        const ok = r.nav.ok && o.bodyOverflow === 'auto' && o.htmlDisplay === 'block';
        return { result: ok ? 'pass' : 'fail', notes: `page ${JSON.stringify(o)}` };
      });
    }

    if (partOn(ctx, 'counts')) {
      // N13b (N13 with the app's view, x4's U3): the app starts a tab's counts again at every cross-document
      // tab.committed, so what it shows is the last tab.blocked AFTER that commit. Blocks of requests the parser made
      // before the document start (static <img>) must reach it too, and each blocked request counts once.
      const afterCommit = (evs, tab) => {
        let i = -1;
        evs.forEach((e, n) => {
          if (e.type === 'tab.committed' && e.p.tabId === tab && e.p.kind !== 'same-document') i = n;
        });
        return evs.slice(i + 1).filter((e) => e.type === 'tab.blocked' && e.p.tabId === tab).pop()?.p ?? null;
      };
      const settle = async (app, s, tab) => {
        // tab.blocked is coalesced (500 ms) and UV's counts come in 250 ms batches from the service worker
        await ctx.sleep(1500);
        const evs = await app.eventsSince(s);
        return { seen: afterCommit(evs, tab), last: evs.filter((e) => e.type === 'tab.blocked' && e.p.tabId === tab).pop()?.p ?? null };
      };
      await forEngines(ctx, 'N13b counts reach the app: 3 ads and 1 tracker counted once each after the commit (static images, a reload, the same URL again, script-made images)', async (engine) => {
        await closeTabs();
        const tab = id++;
        open.add(tab);
        const t0 = Date.now();
        const notes = [];
        let ok = true;
        const check = (label, r, out) => {
          const by = r.seen?.byCategory ?? {};
          const good = out?.states?.length === 4 && out.states.every((x) => x === 'error') && by.ads === 3 && by.trackers === 1 && r.seen.total === 4;
          ok &&= good;
          notes.push(`${label}: after the commit ${JSON.stringify(r.seen?.byCategory ?? null)} (last ${JSON.stringify(r.last?.byCategory ?? null)}); page ${JSON.stringify(out?.states ?? out)}`);
        };
        let s = await app.mark();
        const nav = await app.navigate(tab, bk.url('site-a', '/network/counts.html'), { engine, create: true, timeout: 45_000 });
        let out = nav.ok ? await pageOut(app, tab) : null;
        check('first load', await settle(app, s, tab), out);
        s = await app.mark();
        await app.cmd('tab.reload', { tabId: tab, permissions: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } }).catch((e) => notes.push(`reload: ${e.message}`));
        await app.waitFor(s, (e) => e.type === 'tab.loaded' && e.p.tabId === tab, 30_000).catch(() => null);
        out = await pageOut(app, tab);
        check('reload', await settle(app, s, tab), out);
        // the same URL again by a new GNOME navigation (x4's "repeat load of the same URL")
        s = await app.mark();
        const again = await app.navigate(tab, bk.url('site-a', '/network/counts.html'), { engine, timeout: 45_000 });
        out = again.ok ? await pageOut(app, tab) : null;
        check('the same URL again', await settle(app, s, tab), out);
        s = await app.mark();
        const nav2 = await app.navigate(tab, bk.url('site-a', '/network/counts-script.html'), { engine, timeout: 45_000 });
        out = nav2.ok ? await pageOut(app, tab) : null;
        check('script-made', await settle(app, s, tab), out);
        const hits = bk.fixtures.requests({ since: t0 }).filter((q) => /n13b/.test(q.search ?? '')).length;
        ok &&= hits === 0;
        return { result: ok ? 'pass' : 'fail', notes: `${notes.join('; ')}; beacon requests ${hits}` };
      });
    }

    if (partOn(ctx, 'policy')) {
      await forEngines(ctx, 'N11 allowlist site-a; per-site ads off; trackers off globally', async (engine) => {
        const notes = [];
        await applyBlocker(app, blockerSettings(refs, { allowlist: ['*.site-a.localhost'] }));
        const a = await load(engine, page('site-a', 'ad,trk'));
        notes.push(`allowlisted ${JSON.stringify(a.out)}`);
        await applyBlocker(app, blockerSettings(refs, { perSite: { '*.site-b.localhost': { adblock: false } } }));
        const b = await load(engine, page('site-b', 'ad,trk'));
        notes.push(`per-site ads off ${JSON.stringify(b.out)}`);
        await applyBlocker(app, blockerSettings(refs, { enabled: { trackers: false } }));
        const c = await load(engine, page('site-b', 'ad,trk'));
        notes.push(`trackers off ${JSON.stringify(c.out)}`);
        await applyBlocker(app, base);
        const ok = a.out?.ad === 'load' && a.out?.trk === 'load' && b.out?.ad === 'load' && b.out?.trk === 'error' && c.out?.ad === 'error' && c.out?.trk === 'load';
        return { result: ok ? 'pass' : 'fail', notes: notes.join('; ') };
      });
      await forEngines(ctx, 'N15 a site-b frame inside allowlisted site-a: its third-party requests are not blocked (frames inherit)', async (engine) => {
        await applyBlocker(app, blockerSettings(refs, { allowlist: ['*.site-a.localhost'] }));
        const r = await load(engine, page('site-a', 'inner-b'));
        const f = app.page.frames().find((fr) => fr.name() === 'innerb' || /inner\.html/.test(fr.url()));
        const inner = f ? await f.evaluate(() => document.getElementById('out')?.textContent ?? null).catch(() => null) : null;
        await applyBlocker(app, base);
        return { result: inner && JSON.parse(inner).ad === 1 ? 'pass' : 'fail', notes: `frame out ${inner}; page ${JSON.stringify(r.out)}; nav ${r.nav.ok ? 'ok' : JSON.stringify(r.nav.error)}; frames ${app.page.frames().map((fr) => `${fr.name()}:${fr.url().slice(0, 60)}`).join(' ')}` };
      });
      await forEngines(ctx, 'N16 a link from allowlisted site-a to a $document-blocked page is blocked (judged under itself)', async (engine) => {
        await applyBlocker(app, blockerSettings(refs, { allowlist: ['*.site-a.localhost'] }));
        const target = bk.url('docblock', '/network/page.html');
        const r = await load(engine, page('site-a', 'link', `&to=${encodeURIComponent(target)}`));
        const s = await app.mark();
        await clickIn(app, r.tab, '#link');
        const err = await app.waitFor(s, (e) => e.type === 'tab.error' && e.p.tabId === r.tab, 20_000).catch(() => null);
        await applyBlocker(app, base);
        return { result: err?.p?.kind === 'blocked' ? 'pass' : 'fail', notes: `tab.error ${JSON.stringify(err?.p ?? null)}` };
      });
      await forEngines(ctx, 'N17 a link from site-b to allowlisted site-a: site-a and its early ad script load (waited for its rules)', async (engine) => {
        // A fresh engine host (own browser context): site-a has never been announced and answered in its connection.
        // site-a is allowlisted only in the snapshot the driver sends as its answer to the announcement (D5), as the
        // app's scoped maps would.
        const context3 = await ctx.newContext(browser);
        const app3 = await openBlockerApp(ctx, context3);
        try {
          await applyBlocker(app3, base);
          await waitBlocker(app3);
          const tab = 900;
          const target = page('site-a', 'ad');
          await app3.navigate(tab, page('site-b', 'link', `&to=${encodeURIComponent(target)}`), { engine, create: true, timeout: 45_000 });
          await pageOut(app3, tab);
          const allow = blockerSettings(refs, { allowlist: ['*.site-a.localhost'] });
          const s = await app3.mark();
          const answer = app3.gnome(
            ([settings, since]) =>
              new Promise((resolve) => {
                const t0 = Date.now();
                const tick = () => {
                  const ev = window.gnomeTest.events.find((e) => e.seq > since && e.type === 'tab.loading' && e.p.url && e.p.url.includes('site-a.localhost'));
                  if (ev) {
                    window.gnomeTest.applySettings(settings).then(() => resolve({ answeredAfterMs: Date.now() - t0 }));
                    return;
                  }
                  if (Date.now() - t0 > 15_000) return resolve({ answeredAfterMs: null });
                  setTimeout(tick, 2);
                };
                tick();
              }),
            [allow, s],
          );
          await clickIn(app3, tab, '#link');
          const ans = await answer;
          await app3.waitFor(s, (e) => e.type === 'tab.loaded' && e.p.tabId === tab, 30_000).catch(() => null);
          const out = await pageOut(app3, tab);
          const diag = await app3.cmd('diagnostics', {}).catch(() => null);
          const ok = out?.host === 'site-a.localhost' && out?.ad === 'load';
          return { result: ok ? 'pass' : 'fail', notes: `out ${JSON.stringify(out)}; answer ${JSON.stringify(ans)}; diagnostics.blocker ${JSON.stringify(diag?.blocker ?? null)}` };
        } finally {
          await app3.close().catch(() => null);
          await context3.close().catch(() => null);
        }
      });
    }

    if (partOn(ctx, 'hold')) {
      await forEngines(ctx, 'N12 while the build is held: pages load unblocked, building; after release: blocked', async (engine) => {
        // A fresh engine host with nothing in force (the driver's init sends no lists and no blockerKey), in its own
        // browser context: the service worker (UV's blocker) is shared by every engine host of a context and keeps
        // the engines another one sent (§4.5).
        const context2 = await ctx.newContext(browser);
        const app2 = await openBlockerApp(ctx, context2);
        try {
          const held = await testCmd(app2, 'test.blocker', { holdBuild: true }).catch((e) => ({ error: String(e) }));
          if (held?.error) return { result: 'fail', notes: `test.blocker: ${held.error}` };
          await applyBlocker(app2, base);
          await ctx.sleep(300);
          const st = (await app2.status())?.blocker;
          const tab = id++;
          await app2.navigate(tab, page('site-a', 'ad'), { engine, create: true, timeout: 45_000 });
          const during = await pageOut(app2, tab);
          await testCmd(app2, 'test.blocker', { releaseBuild: true });
          const rd = await waitBlocker(app2);
          const tab2 = id++;
          await app2.navigate(tab2, page('site-a', 'ad'), { engine, create: true, timeout: 45_000 });
          const after = await pageOut(app2, tab2);
          const ok = st?.state === 'building' && during?.ad === 'load' && rd.ok && after?.ad === 'error';
          return { result: ok ? 'pass' : 'fail', notes: `status while held ${JSON.stringify(st)}; during ${JSON.stringify(during)}; ready after ${rd.ms} ms; after ${JSON.stringify(after)}` };
        } finally {
          await app2.close().catch(() => null);
          await context2.close().catch(() => null);
        }
      });
    }
    await app.close();
  } finally {
    await context.close();
    await browser.close();
  }
}
