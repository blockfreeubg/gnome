// Lane a: smoke of the built engine host on the real stack (port of the spike's `smoke` suite; WAVE-B §2 Tests).
// init over the hardened handshake, both engines ready, a real site (example.com over the direct route) and the
// fixture site (over the VPN profile route) through both engines, commit → loaded with index/length, title and
// favicon events, tab.state, ping, status, diagnostics, and that test.* exists only in this e2e build.
import { PERMS, fixtureQuery, perEngine, readOutOf, realClick, startFixtures } from './host-lib.mjs';

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  try {
    // A real site over the direct route (HolyWisp → the internet).
    {
      const context = await ctx.newContext(browser);
      try {
        const app = await ctx.openApp(context, {});
        const init = app.init;
        const ok = init?.status?.engines?.scramjet?.state === 'ready' && init?.status?.engines?.ultraviolet?.state === 'ready';
        ctx.record({ test: 'init:engines-ready', result: ok ? 'pass' : 'fail', notes: `scramjet ${init?.status?.engines?.scramjet?.state}, ultraviolet ${init?.status?.engines?.ultraviolet?.state}; timings ${JSON.stringify(init?.timings)}` });
        // What this host reports (core.ts OFFERED_CAPABILITIES / ENFORCED_PERMISSIONS, each backed by host-capabilities).
        const wantCaps = ['blocker', 'cookies', 'print', 'saveImage', 'saveLink', 'selectAll', 'siteData', 'suggest', 'vpnVerify', 'zoom'];
        // Clipboard is enforced nowhere (shared/site-rules.ts ENFORCED_PERMISSIONS: Chromium's policy does not stop execCommand('copy')).
        const wantPerms = ctx.browser === 'firefox' ? ['fullscreen'] : ['autoplay', 'fullscreen'];
        const caps = [...(init?.capabilities ?? [])].sort();
        const perms = [...(init?.enforcedPermissions ?? [])].sort();
        ctx.record({ test: 'init:capabilities-and-enforced-permissions', result: JSON.stringify(caps) === JSON.stringify(wantCaps) && JSON.stringify(perms) === JSON.stringify(wantPerms) ? 'pass' : 'fail', notes: `capabilities ${JSON.stringify(caps)}; enforcedPermissions ${JSON.stringify(perms)}` });
        let tab = 1;
        let closedTabs = 0;
        await perEngine(ctx, 'real-site:example.com', async (engine) => {
          let r = await app.navigate(tab, 'https://example.com/', { engine, create: true, timeout: 60000 });
          // A real site over the internet: one retry after a network-level failure (e.g. libcurl's "code 35: SSL
          // connect error", seen once on 2026-11-19), said in the notes; the retry is a new tab, so its first commit
          // is again push@0/1.
          let retried = '';
          if (!r.ok && r.error?.kind === 'network') {
            retried = ` (retried once after: ${String(r.error.detail).slice(0, 80)})`;
            await app.cmd('tab.close', { tabId: tab }).then(() => closedTabs++, () => {});
            tab++;
            r = await app.navigate(tab, 'https://example.com/', { engine, create: true, timeout: 60000 });
          }
          tab++;
          const ok2 = r.ok && r.title === 'Example Domain' && r.committed?.historyHandling === 'push' && r.committed?.index === 0 && r.committed?.length === 1;
          return { result: ok2 ? 'pass' : 'fail', notes: `ok ${r.ok} title ${JSON.stringify(r.title)} engine ${r.engine} committed ${JSON.stringify(r.committed)} error ${JSON.stringify(r.error)}${retried}` };
        });
        // Lane c's report: a late tab.error (frame-left-proxy) after commit and load, on the first load of a tab created
        // blank and then navigated, and of a tab created with start.kind 'restore'. Watch 4 s after tab.loaded.
        await perEngine(ctx, 'first-load:blank-then-navigate + restore (no late tab.error)', async (engine) => {
          const a = tab++;
          const since = await app.mark();
          await app.createTab(a, { engine, start: { kind: 'blank' } });
          const r1 = await app.navigate(a, 'https://example.com/', { engine, timeout: 60000 });
          const b = tab++;
          const restore = { kind: 'restore', entries: ['https://example.com/', 'https://example.org/'], index: 1 };
          const t0 = await app.mark();
          await app.createTab(b, { engine, start: restore });
          const r2 = await app.waitFor(t0, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === b, 60000);
          await ctx.sleep(4000);
          const evs = (await app.eventsSince(since)).filter((e) => e.p?.tabId === a || e.p?.tabId === b);
          const errors = evs.filter((e) => e.type === 'tab.error').map((e) => ({ tabId: e.p.tabId, kind: e.p.kind, signal: e.p.signal }));
          const st = await app.cmd('tab.state', { tabId: b });
          const commitB = evs.filter((e) => e.type === 'tab.committed' && e.p.tabId === b).map((e) => `${e.p.kind}/${e.p.historyHandling}@${e.p.index}/${e.p.length}`);
          const ok = r1.ok && r2?.type === 'tab.loaded' && errors.length === 0 && st.index === 1 && st.entries.length === 2 && commitB[0] === 'navigate/replace@1/2';
          return { result: ok ? 'pass' : 'fail', notes: `blank→navigate ok ${r1.ok}; restore ${r2?.type}; commits(restore) ${commitB.join(' ')}; state ${JSON.stringify({ entries: st.entries, index: st.index })}; errors ${JSON.stringify(errors)}` };
        });
        const ping = await app.cmd('ping', {});
        const status = await app.cmd('status', {});
        const diag = await app.cmd('diagnostics', {});
        ctx.record({
          test: 'commands:ping-status-diagnostics',
          result: ping?.instance === init?.instance && status?.engines && diag?.tabs?.live === tab - 1 - closedTabs ? 'pass' : 'fail',
          notes: `ping ${JSON.stringify(ping)}; diag tabs ${JSON.stringify(diag?.tabs)} csp ${JSON.stringify(diag?.csp)} webrtc ${JSON.stringify(diag?.webrtc)}`,
        });
        // The driver validates every result against the protocol, which has no test.* commands: an answered test.stats
        // therefore shows up as "invalid test.stats result" (ok: true from the host), an unknown one as unknown_type.
        const stats = await app.cmd('test.stats', {}).then(() => 'resolved', (e) => String(e.message || e));
        ctx.record({ test: 'e2e-build:test-commands', result: /invalid test\.stats result/.test(stats) ? 'pass' : 'fail', notes: stats.slice(0, 200) });
        const rejected = (await app.gnome(() => window.gnomeTest.rejected)).filter((r) => !String(r.kind).startsWith('result:test.'));
        ctx.record({ test: 'app-side:no-invalid-events', result: rejected.length === 0 ? 'pass' : 'fail', notes: JSON.stringify(rejected).slice(0, 400) });
        await app.close();
      } finally {
        await context.close();
      }
    }
    // The fixture site over the VPN profile route: title, favicon, tab.state, tab.go.
    {
      const context = await ctx.newContext(browser);
      try {
        const app = await ctx.openApp(context, fixtureQuery(ctx));
        let tab = 10;
        await perEngine(ctx, 'fixture:nav-title-favicon-state', async (engine) => {
          const id = tab++;
          const since = await app.mark();
          const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
          const b = await app.navigate(id, `${fx.origin}/second`, { engine, timeout: 45000 });
          await ctx.sleep(2500);
          const evs = (await app.eventsSince(since)).filter((e) => e.p?.tabId === id);
          const fav = evs.filter((e) => e.type === 'tab.favicon').pop();
          const titles = evs.filter((e) => e.type === 'tab.title').map((e) => e.p.title);
          const st = await app.cmd('tab.state', { tabId: id });
          const back = await app.cmd('tab.go', { tabId: id, delta: -1, permissions: PERMS });
          const end = await app.waitFor(since, (e) => e.type === 'tab.loaded' && e.p.tabId === id && e.p.navId === back.navId, 30000);
          const commits = (await app.eventsSince(since)).filter((e) => e.type === 'tab.committed' && e.p.tabId === id).map((e) => `${e.p.kind}/${e.p.historyHandling}@${e.p.index}/${e.p.length}`);
          const ok =
            a.ok && b.ok && titles.includes('Fixture home') && titles.includes('Second page') && /^data:image\/png;base64,/.test(fav?.p?.icon ?? '') &&
            JSON.stringify(st.entries) === JSON.stringify([`${fx.origin}/`, `${fx.origin}/second`]) && st.index === 1 && end &&
            commits.join(' ') === 'navigate/push@0/1 navigate/push@1/2 history/traverse@0/2';
          return { result: ok ? 'pass' : 'fail', notes: `a ${a.ok} b ${b.ok} titles ${JSON.stringify(titles)} favicon ${fav ? String(fav.p.icon).slice(0, 30) : 'none'} state ${JSON.stringify(st)} commits ${commits.join(' ')} back-loaded ${!!end} errors ${JSON.stringify([a.error, b.error])}` };
        });
        // GNOME's own navigations (tab.create, tab.navigate to another site, tab.reload) carry no initiator, like a
        // browser's address bar: no Referer, no Origin, Sec-Fetch-Site `none` (UV sends no Sec-Fetch-* at all). Before
        // integration part 2 Chromium + Scramjet sent the previous site's Origin and Referer cross-site, and the
        // engine host's own loads logged Scramjet's "unrewriteurl: unexpected url …/engine/" (worklist A14). A link
        // the page follows keeps the page as its initiator (the page's origin as Referer; Scramjet: cross-site).
        await perEngine(ctx, 'fixture:gnome-loads-carry-no-initiator (no Referer/Origin, Sec-Fetch-Site none; a link keeps its referrer)', async (engine) => {
          const id = tab++;
          const c0 = app.console.length;
          const seen = {};
          const headersOf = async (label) => {
            const o = await readOutOf(app, `tab-${id}`, 20000);
            seen[label] = o ? { referer: o.referer ?? null, origin: o.origin ?? null, site: o['sec-fetch-site'] ?? null } : null;
            return seen[label];
          };
          const gnome = (h) => !!h && h.referer === null && h.origin === null && (h.site === 'none' || (engine === 'ultraviolet' && h.site === null));
          const a = await app.navigate(id, `${fx.origin}/headers`, { engine, create: true, timeout: 45000 });
          const h1 = a.ok ? await headersOf('create') : null;
          const b = await app.navigate(id, `${fx.altOrigin}/headers?n=2`, { engine, timeout: 45000 });
          const h2 = b.ok ? await headersOf('navigate-cross-site') : null;
          const since = await app.mark();
          await app.cmd('tab.reload', { tabId: id, permissions: PERMS });
          const r = await app.waitFor(since, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === id, 45000);
          const h3 = r?.type === 'tab.loaded' ? await headersOf('reload') : null;
          const c = await app.navigate(id, `${fx.origin}/headers-link`, { engine, timeout: 45000 });
          let h4 = null;
          if (c.ok) {
            const s2 = await app.mark();
            await realClick(app, app.tabFrame(id), '#go');
            const d = await app.waitFor(s2, (e) => e.type === 'tab.loaded' && e.p.tabId === id && /from=link/.test(e.p.url), 30000);
            h4 = d ? await headersOf('link') : null;
          }
          const errs = app.console.slice(c0).filter((m) => /unrewriteurl: unexpected url/.test(m.text));
          // Both engines send the page's origin as Referer to another site, as a browser does (Ultraviolet sent the whole
          // referring URL until integration part 2; it sends no Sec-Fetch-* at all).
          const linkOk = !!h4 && h4.referer === `${fx.origin}/` && (engine === 'scramjet' ? h4.site === 'cross-site' : true);
          const ok = gnome(h1) && gnome(h2) && gnome(h3) && linkOk && errs.length === 0;
          await app.cmd('tab.close', { tabId: id }).catch(() => {});
          return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(seen)}; unrewriteurl errors ${errs.length}` };
        });
        // Security review (integration part 2): requests a page chooses and the engine host makes. A browser applies
        // SameSite to a link a page opens (the Lax cookie, never the Strict one, `Sec-Fetch-Site: cross-site`, the page
        // as Referer) and to subresource-like requests (neither cookie). Under Scramjet the tab a page asked for
        // (tab.create with `start.opener`: what the app sends after tab.openRequest), the tab's favicon and an
        // `<a download>` the page clicks by script now carry the page as their initiator; before, all three sent the
        // victim's Strict cookie (the favicon and the download without any click). GNOME's own load (no opener) keeps
        // no initiator, like a typed URL (Sec-Fetch-Site: none). Ultraviolet 3.2.10 ignores SameSite by itself; GNOME's
        // SameSite glue (WAVE-B3 lane x3, integration step) makes it hold in both engines.
        await perEngine(ctx, 'fixture:page-chosen-requests-carry-the-page-as-initiator (SameSite as in a browser)', async (engine) => {
          const victim = tab++;
          const attacker = tab++;
          fx.xs.reset();
          const a = await app.navigate(victim, `${fx.origin}/xs/set`, { engine, create: true, timeout: 45000 });
          if (!a.ok) return { result: 'fail', notes: `victim page did not load: ${JSON.stringify(a.error)}` };
          const b = await app.navigate(attacker, `${fx.altOrigin}/xs/attacker`, { engine, create: true, timeout: 45000 });
          if (!b.ok) return { result: 'fail', notes: `attacker page did not load: ${JSON.stringify(b.error)}` };
          const has = (via) => fx.xs.log().some((e) => e.via === via);
          for (let i = 0; i < 60 && !(has('favicon') && has('adownload')); i++) await ctx.sleep(250);
          const since = await app.mark();
          await realClick(app, app.tabFrame(attacker), '#blank');
          const req = await app.waitFor(since, (e) => e.type === 'tab.openRequest' && e.p.openerTabId === attacker, 10000);
          const opened = tab++;
          if (req) await app.createTab(opened, { engine, active: false, start: { kind: 'url', url: req.p.url, opener: `${fx.altOrigin}/xs/attacker` } });
          const own = tab++;
          await app.createTab(own, { engine, active: false, start: { kind: 'url', url: `${fx.origin}/xs/echo?via=gnome` } });
          for (let i = 0; i < 80 && !(has('blank') && has('gnome')); i++) await ctx.sleep(250);
          const last = (via) => fx.xs.log().filter((e) => e.via === via).pop() ?? null;
          const cookie = (e, name) => !!e && e.cookie.split(/;\s*/).some((c) => c.startsWith(`${name}=`));
          const [fav, dl, blank, gnome] = ['favicon', 'adownload', 'blank', 'gnome'].map(last);
          const checks = {
            favicon: !!fav && !cookie(fav, 'xs_strict') && !cookie(fav, 'xs_lax'),
            aDownload: !!dl && !cookie(dl, 'xs_strict') && !cookie(dl, 'xs_lax'),
            openedTab: !!blank && !cookie(blank, 'xs_strict') && cookie(blank, 'xs_lax') && blank.site === 'cross-site' && blank.referer === `${fx.altOrigin}/`,
            gnomeLoad: !!gnome && cookie(gnome, 'xs_strict') && cookie(gnome, 'xs_lax') && gnome.site === 'none',
          };
          const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
          for (const t of [victim, attacker, opened, own]) await app.cmd('tab.close', { tabId: t }).catch(() => {});
          const brief = (e) => (e ? { cookie: e.cookie, site: e.site, referer: e.referer } : null);
          const notes = `${failed.length ? `failed ${failed.join(', ')}; ` : ''}openRequest ${!!req}; favicon ${JSON.stringify(brief(fav))}; <a download> ${JSON.stringify(brief(dl))}; opened tab ${JSON.stringify(brief(blank))}; GNOME's own load ${JSON.stringify(brief(gnome))}`;
          return { result: failed.length ? 'fail' : 'pass', notes };
        });
        const rejected = await app.gnome(() => window.gnomeTest.rejected);
        ctx.record({ test: 'app-side:no-invalid-events (fixture)', result: rejected.length === 0 ? 'pass' : 'fail', notes: JSON.stringify(rejected).slice(0, 400) });
        await app.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await fx.close();
  }
}
