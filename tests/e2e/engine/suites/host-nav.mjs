// Lane a: navigation on the real stack (port of the spike's `nav` suite plus the WAVE-B §2 rows): a pushState SPA
// (push, replace, a fragment link, the browser's own Back button, tab.go onto a pushState entry: index/length match),
// navigations started in the page (link, GET and POST forms, location.replace, the page's own reload) → loading →
// committed → loaded, a failing in-page link → tab.error and never the engine's page, a 204 link (no error, the
// spinner ends), nested frames that navigate themselves (never a navigation of the tab), and real sites. Both
// engines, forced (fallback off: this suite tests one engine at a time).
//
// Parts (`--parts`, all by default): spa, in-page, nested, history (pushState/replaceState without a URL), sites
// (DuckDuckGo, Wikipedia).
import { PERMS, fixtureQuery, inFrame, perEngine, readOutOf, realClick, startFixtures } from './host-lib.mjs';

const commitsOf = async (app, since, tabId) =>
  (await app.eventsSince(since)).filter((e) => e.type === 'tab.committed' && e.p.tabId === tabId).map((e) => e.p);
const fmt = (c) => `${c.kind}/${c.historyHandling}@${c.index}/${c.length}`;

async function tabFrame(app, tabId, timeout = 30000) {
  const f = await app.waitTabFrame(tabId, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', timeout);
  if (!f) {
    const names = app.page.frames().map((fr) => `${fr.name()}=${fr.url().slice(0, 80)}`);
    throw new Error(`tab ${tabId} frame not ready (frames: ${names.join(' ')})`);
  }
  return f;
}

/** Waits for the next commit (and, when `loaded`, its tab.loaded) of a tab after `since`. */
async function nextCommit(app, since, tabId, pred = () => true, timeout = 30000) {
  return app.waitFor(since, (e) => e.type === 'tab.committed' && e.p.tabId === tabId && pred(e.p), timeout);
}

export async function run(ctx) {
  const want = (part) => !ctx.parts || ctx.parts.includes(part);
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    let next = 1;

    if (want('spa')) await perEngine(ctx, 'spa:pushState-replaceState-fragment-back-go', async (engine) => {
      let id = next++;
      const a = await app.navigate(id, `${fx.origin}/spa`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `spa did not load: ${JSON.stringify(a.error)}` };
      let f;
      let retried = '';
      try {
        f = await tabFrame(app, id, 12000);
      } catch (e) {
        // playwright-core 1.64 + Firefox 157 can leave the first evaluate of a tab frame pending (spike §7): load the
        // page once more (a test-tooling problem, not an engine-host one; the note says so).
        retried = ` (tooling: frame read retried after ${String(e.message).slice(0, 40)})`;
        await app.cmd('tab.close', { tabId: id });
        id = next++;
        const r = await app.navigate(id, `${fx.origin}/spa`, { engine, create: true, timeout: 45000 });
        if (!r.ok) return { result: 'fail', notes: `spa did not load again: ${JSON.stringify(r.error)}` };
        f = await tabFrame(app, id);
      }
      const s0 = await app.mark();
      await inFrame(f, () => window.spa.push('/spa/a'));
      await nextCommit(app, s0, id, (c) => c.url.endsWith('/spa/a'));
      await inFrame(f, () => window.spa.push('/spa/b'));
      await nextCommit(app, s0, id, (c) => c.url.endsWith('/spa/b'));
      await inFrame(f, () => window.spa.replace('/spa/b?r=1'));
      await nextCommit(app, s0, id, (c) => c.url.endsWith('/spa/b?r=1'));
      // The browser's own Back button: the frame's pushState entries are in the app tab's joint session history.
      await app.page.goBack({ timeout: 10000 }).catch(() => null);
      await nextCommit(app, s0, id, (c) => c.historyHandling === 'traverse');
      const st1 = await app.cmd('tab.state', { tabId: id });
      const sameDoc = (await commitsOf(app, s0, id)).map(fmt);
      // tab.go onto a pushState entry loads it fresh (the fixture serves /spa/b as its own page).
      const s1 = await app.mark();
      const go = await app.cmd('tab.go', { tabId: id, delta: 1, permissions: PERMS });
      const loaded = await app.waitFor(s1, (e) => e.type === 'tab.loaded' && e.p.tabId === id && e.p.navId === go.navId, 30000);
      const goCommit = (await commitsOf(app, s1, id)).pop();
      // The fresh document's title (a frame read right after a GNOME location.replace can hang in playwright-core +
      // Firefox, spike §7; the title event is the engine host's own report).
      await ctx.sleep(500);
      const h1 = (await app.eventsSince(s1)).filter((e) => e.type === 'tab.title' && e.p.tabId === id).map((e) => e.p.title).pop() ?? null;
      const st2 = await app.cmd('tab.state', { tabId: id });
      const expectEntries = [`${fx.origin}/spa`, `${fx.origin}/spa/a`, `${fx.origin}/spa/b?r=1`];
      const ok =
        sameDoc.join(' ') === 'same-document/push@1/2 same-document/push@2/3 same-document/replace@2/3 same-document/traverse@1/3' &&
        st1.index === 1 && JSON.stringify(st1.entries) === JSON.stringify(expectEntries) &&
        loaded && goCommit && fmt(goCommit) === 'history/traverse@2/3' && h1 === 'SPA b (loaded fresh)' && st2.index === 2;
      return { result: ok ? 'pass' : 'fail', notes: `same-document ${sameDoc.join(' ')}; after Back ${JSON.stringify(st1)}; tab.go +1 → ${goCommit ? fmt(goCommit) : 'no commit'} (${h1})${retried}` };
    });

    if (want('spa')) await perEngine(ctx, 'spa:fragment-link-is-push', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/spa`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `spa did not load: ${JSON.stringify(a.error)}` };
      const f = await tabFrame(app, id);
      const s0 = await app.mark();
      await realClick(app, f, '#frag');
      const c = await nextCommit(app, s0, id, (x) => x.url.endsWith('#section'), 10000);
      // Scramjet 2.0.67-alpha.2 rewrites a fragment href to a full proxied URL, so the frame loads a new document
      // (a cross-document push); UV keeps it in the document. Either way the entry is a push.
      const want = engine === 'scramjet' ? /^(same-document|navigate)\/push@1\/2$/ : /^same-document\/push@1\/2$/;
      return { result: c && want.test(fmt(c.p)) ? 'pass' : 'fail', notes: c ? `${fmt(c.p)}${c.p.kind === 'navigate' ? ' (the engine reloaded the document for the fragment)' : ''}` : 'no commit' };
    });

    if (want('in-page')) await perEngine(ctx, 'in-page:link-form-replace-reload', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/links`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `links did not load: ${JSON.stringify(a.error)}` };
      const steps = [];
      const step = async (label, selector, expect) => {
        const f = await tabFrame(app, id);
        const s = await app.mark();
        await realClick(app, f, selector);
        const loaded = await app.waitFor(s, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === id, 30000);
        const evs = (await app.eventsSince(s)).filter((e) => e.p?.tabId === id);
        const commit = evs.find((e) => e.type === 'tab.committed');
        const order = evs.map((e) => (e.type === 'tab.loading' ? `loading:${e.p.loading}` : e.type)).filter((t) => t !== 'tab.title' && t !== 'tab.favicon');
        const ok = loaded?.type === 'tab.loaded' && commit && expect(commit.p) && order[0] === 'loading:true' && order.includes('tab.committed');
        steps.push(`${label}: ${ok ? 'ok' : 'FAIL'} ${commit ? fmt(commit.p) + ' ' + commit.p.url.replace(fx.origin, '') : 'no commit'} [${order.join(',')}]`);
        return ok;
      };
      const r1 = await step('link', '#l-second', (c) => c.url === `${fx.origin}/second` && fmt(c) === 'navigate/push@1/2');
      await app.cmd('tab.go', { tabId: id, delta: -1, permissions: PERMS });
      await app.waitFor(await app.mark(), (e) => e.type === 'tab.loaded' && e.p.tabId === id, 30000);
      await ctx.sleep(300);
      const r2 = await step('get-form', '#b-get', (c) => c.url === `${fx.origin}/echo?q=gnome` && c.historyHandling === 'push');
      await app.cmd('tab.go', { tabId: id, delta: -1, permissions: PERMS });
      await app.waitFor(await app.mark(), (e) => e.type === 'tab.loaded' && e.p.tabId === id, 30000);
      await ctx.sleep(300);
      const r3 = await step('post-form', '#b-post', (c) => c.url === `${fx.origin}/echo` && c.historyHandling === 'push');
      const f3 = await tabFrame(app, id);
      const echo = await inFrame(f3, () => document.getElementById('echo')?.textContent ?? '');
      await app.cmd('tab.go', { tabId: id, delta: -1, permissions: PERMS });
      await app.waitFor(await app.mark(), (e) => e.type === 'tab.loaded' && e.p.tabId === id, 30000);
      await ctx.sleep(300);
      // Ultraviolet 3.2.10 implements location.replace() with location.assign() (uv.client.js wraps "assign" for
      // "replace"), so the frame really adds an entry: the engine host reports what the frame did.
      const r4 = await step('location.replace', '#replace', (c) => c.url === `${fx.origin}/third` && c.historyHandling === (engine === 'ultraviolet' ? 'push' : 'replace'));
      await app.cmd('tab.navigate', { tabId: id, url: `${fx.origin}/links`, engine, permissions: PERMS });
      await app.waitFor(await app.mark(), (e) => e.type === 'tab.loaded' && e.p.tabId === id, 30000);
      await ctx.sleep(300);
      const r5 = await step('page reload', '#reload', (c) => c.kind === 'reload' && c.historyHandling === 'replace');
      const ok = r1 && r2 && r3 && r4 && r5 && /^POST \/echo q=posted/.test(echo);
      return { result: ok ? 'pass' : 'fail', notes: `${steps.join(' | ')} | echo ${JSON.stringify(echo)}` };
    });

    if (want('in-page')) await perEngine(ctx, 'in-page:failing-link → tab.error, never the engine page', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/links`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `links did not load: ${JSON.stringify(a.error)}` };
      const f = await tabFrame(app, id);
      const s = await app.mark();
      await realClick(app, f, '#l-dead');
      const err = await app.waitFor(s, (e) => e.type === 'tab.error' && e.p.tabId === id, 40000);
      const evs = (await app.eventsSince(s)).filter((e) => e.p?.tabId === id);
      const loaded = evs.filter((e) => e.type === 'tab.loaded');
      const st = await app.cmd('tab.state', { tabId: id });
      const ok = err && err.p.url === 'http://dead.invalid/' && err.p.engine === engine && loaded.length === 0 && st.error && !st.loading;
      return { result: ok ? 'pass' : 'fail', notes: `error ${JSON.stringify(err?.p)}; loaded events ${loaded.length}; state.error ${st.error?.signal}` };
    });

    if (want('in-page')) await perEngine(ctx, 'in-page:204-link (no error, spinner ends)', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/links`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `links did not load: ${JSON.stringify(a.error)}` };
      const f = await tabFrame(app, id);
      const s = await app.mark();
      await realClick(app, f, '#l-204');
      const end = await app.waitFor(s, (e) => e.p?.tabId === id && ((e.type === 'tab.loading' && e.p.loading === false) || e.type === 'tab.error'), 30000);
      await ctx.sleep(500);
      const evs = (await app.eventsSince(s)).filter((e) => e.p?.tabId === id);
      const types = evs.map((e) => (e.type === 'tab.loading' ? `loading:${e.p.loading}` : e.type));
      const st = await app.cmd('tab.state', { tabId: id });
      const ok = end?.type === 'tab.loading' && !types.includes('tab.error') && !types.includes('tab.committed') && !st.loading && st.entries.length === 1;
      return { result: ok ? 'pass' : 'fail', notes: `${types.join(',')}; after ${end ? Math.round(end.t - evs[0]?.t) : '?'} ms; state ${JSON.stringify({ loading: st.loading, entries: st.entries.length, error: st.error })}` };
    });

    // A nested frame that navigates itself (script, a link click inside it) or whose first load redirects is not a
    // navigation of the tab. Scramjet marks only a nested frame's first request (`$iframe=1`), so before the fix these
    // looked like navigations of the tab frame: `tab.loading` without a commit, after 20 s the fallback loaded the
    // nested URL as the whole tab on Ultraviolet; a redirecting iframe added a duplicate back/forward entry.
    if (want('nested')) await perEngine(ctx, 'nested-frames:self-navigation, redirect, link click (never the tab navigating)', async (engine) => {
      const rows = [];
      const results = [];
      for (const [path, click] of [
        ['/iframe-selfnav', null],
        ['/iframe-redirect', null],
        ['/iframe-link', '#go'],
      ]) {
        const id = next++;
        const s0 = await app.mark();
        const a = await app.navigate(id, `${fx.origin}${path}`, { engine, create: true, timeout: 45000 });
        if (!a.ok) {
          rows.push(`${path}: FAIL page did not load ${JSON.stringify(a.error)}`);
          results.push(false);
          continue;
        }
        await tabFrame(app, id);
        let inner = null;
        for (let i = 0; i < 60 && !inner; i++) {
          inner = app.tabFrame(id)?.childFrames()[0] ?? null;
          if (!inner) await ctx.sleep(200);
        }
        if (click && inner) await realClick(app, inner, click);
        await ctx.sleep(3500);
        const all = (await app.eventsSince(s0)).filter((e) => e.p?.tabId === id);
        const commits = all.filter((e) => e.type === 'tab.committed');
        const starts = all.filter((e) => e.type === 'tab.loading' && e.p.loading === true);
        const bad = all.filter((e) => e.type === 'tab.error' || e.type === 'tab.engineSwitched');
        const st = await app.cmd('tab.state', { tabId: id });
        const nested = inner ? await inFrame(app.tabFrame(id).childFrames()[0], () => document.title, undefined, 3000).catch(() => null) : null;
        const ok = commits.length === 1 && starts.length === 1 && bad.length === 0 && st.loading === false && st.entries.length === 1 && nested === 'Second page';
        rows.push(
          `${path}: ${ok ? 'ok' : 'FAIL'} commits ${commits.map((c) => fmt(c.p)).join(' ')}; loading starts ${starts.length}; ${bad.map((e) => e.type).join(',') || 'no error/switch'}; state ${st.entries.length} entries loading ${st.loading}; nested frame "${nested}"`,
        );
        results.push(ok);
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
      }
      return { result: results.every(Boolean) ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    // Worklist A12: Scramjet 2.0.67-alpha.2 turned pushState/replaceState without a URL (none, undefined, null) into
    // `<origin>/undefined` or `/null` (DuckDuckGo's results page showed duckduckgo.com/undefined); GNOME's wrapper
    // (observe/history-url.ts) keeps the URL, as a browser does. Both the page's own view and GNOME's entry are checked.
    if (want('history')) await perEngine(ctx, 'spa:history-without-url-keeps-the-url (pushState/replaceState with none, undefined, null)', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/history-nourl`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const out = await readOutOf(app, `tab-${id}`, 20000);
      await ctx.sleep(500);
      const st = await app.cmd('tab.state', { tabId: id });
      const want = `${fx.origin}/history-nourl`;
      await app.cmd('tab.close', { tabId: id }).catch(() => {});
      const ok = out?.href === want && st.entries[st.index] === want && !st.entries.some((u) => /\/(undefined|null)$/.test(u));
      return { result: ok ? 'pass' : 'fail', notes: `page sees ${out?.href} (history.length ${out?.length}); GNOME entries ${JSON.stringify(st.entries)} @${st.index}` };
    });

    if (!ctx.offline && want('sites')) {
      await perEngine(ctx, 'real-site:duckduckgo search keeps its URL (no /undefined)', async (engine) => {
        const app2 = await ctx.openApp(context, { fallback: '0' });
        try {
          const r = await app2.navigate(1, 'https://duckduckgo.com/?q=gnome+garden+statue', { engine, create: true, timeout: 60000 });
          await ctx.sleep(6000); // DuckDuckGo's script runs its replaceState after the load
          const st = await app2.cmd('tab.state', { tabId: 1 });
          const url = st.entries[st.index] ?? '';
          const ok = r.ok && /^https:\/\/duckduckgo\.com\/\?q=gnome/.test(url) && !/\/undefined/.test(url);
          return { result: ok ? 'pass' : 'fail', notes: `loaded ${r.ok} (${JSON.stringify(r.title)}); current entry ${url}` };
        } finally {
          await app2.close();
        }
      });
    }

    if (want('sites')) await perEngine(ctx, 'real-site:wikipedia', async (engine) => {
      const app2 = await ctx.openApp(context, { fallback: '0' });
      try {
        const r = await app2.navigate(1, 'https://en.wikipedia.org/wiki/Gnome', { engine, create: true, timeout: 60000 });
        return { result: r.ok && /Gnome/.test(r.title ?? '') ? 'pass' : 'fail', notes: `ok ${r.ok} title ${JSON.stringify(r.title)} loadMs ${r.loadMs} error ${JSON.stringify(r.error)}` };
      } finally {
        await app2.close();
      }
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
