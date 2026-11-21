// Lane x4 (app UI of the built-in extensions): rows U1–U13 of docs/WAVE-B3.md §12.2, driven through GNOME's real
// app at `/` on the runner's real stack (gnome-server + HolyWisp, an `npm run build:e2e` build whose engine host offers
// `blocker` through D19's GNOME_ENGINE_TEST_CAPABILITIES switch, so the app registers the `extensions` feature).
// Fixture pages come from servers/blocker-fixtures.mjs (`fixtures/blocker/ui/**`), reached through the VPN profile
// route `e2e-vpn` (the TEST-ONLY allow-loopback HolyWisp); the filter lists are the runner's test lists.
//
// Blocking comes from the real blockers (the engine host's for Scramjet, the service worker's for Ultraviolet) and the
// runner's test lists (x1's network*.txt: ads.localhost third-party, docblock.localhost $document, trk.localhost
// third-party, bad.localhost as scam and malware; x2's cosmetic.txt site rule for site-a, used by U2).
//
// Parts (--parts): settings, lists, autoupdate, cookies, shield, switches, blocked, states, about, shots.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { activeTab, omnibox, openGnome, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';

const ENGINES = ['scramjet', 'ultraviolet'];
const want = (ctx, part) => {
  const on = !ctx.parts || ctx.parts.includes(part);
  // X4_DEBUG=1: one line per part entered (finds where a run stalls).
  if (on && process.env.X4_DEBUG) console.log(`[x4] ${ctx.browser} part ${part} ${new Date().toISOString()}`);
  return on;
};

export async function run(ctx) {
  const browser = await ctx.launch();
  const rec = (test, ok, data, extra = {}) => ctx.record({ test, result: ok === null ? 'skip' : ok ? 'pass' : 'fail', notes: typeof data === 'string' ? data : JSON.stringify(data ?? {}).slice(0, 900), ...extra });
  const shotsDir = join(ctx.runDir, 'shell-blocker-shots');
  mkdirSync(shotsDir, { recursive: true });
  const shot = async (page, name) => {
    const file = join(shotsDir, `${ctx.browser}-${name}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    return file;
  };
  const fx = ctx.stack.blocker;
  try {
    const context = await ctx.newContext(browser);
    try {
      const { page, errors } = await openGnome(ctx, context, '/browse');
      // The settings helpers read plain JSON out of Svelte state.
      const getExt = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__gnomeSettings.value.extensions)));
      const setExt = (key, value) => page.evaluate(([k, v]) => window.__gnomeSettings.set('extensions', k, v), [key, value]);
      const setSetting = (section, key, value) => page.evaluate(([s, k, v]) => window.__gnomeSettings.set(s, k, v), [section, key, value]);
      await page.evaluate((id) => {
        const s = window.__gnomeSettings;
        s.set('vpn', 'mode', 'gateway');
        s.set('vpn', 'preferredLocation', id);
      }, ctx.stack.profiles.live);
      await page.waitForTimeout(500);

      // The browser starts with the app: in this e2e build it registers the extensions feature right after itself.
      const started = await waitState(page, (s) => s.tabs.length >= 1, 20_000, 'the browser').catch(() => null);
      const navigateApp = async (path) => {
        // The app's router follows its own links; a click-free way: its navigate() through a real anchor click.
        await page.evaluate((p) => {
          const a = document.createElement('a');
          a.href = p;
          document.body.append(a);
          a.click();
          a.remove();
        }, path);
        await page.waitForTimeout(500);
      };

      // ── U10: the extensions rows exist once the browser started, and act ───────────────────────────────────
      if (want(ctx, 'settings')) {
        await navigateApp('/settings/extensions');
        await page.waitForSelector('[data-row="extensions.adblock"]', { timeout: 15_000 }).catch(() => undefined);
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-row^="extensions."]')].map((e) => e.getAttribute('data-row')));
        const expected = ['adblock', 'trackers', 'privacy', 'cookieManager', 'cosmetic', 'cosmeticAggressive', 'autoUpdateLists', 'lists', 'allowlist', 'perSite', 'cookieRules'].map((r) => `extensions.${r}`);
        const before = (await getExt()).enabled.trackers;
        await page.locator('[data-row="extensions.trackers"] button[role="switch"]').click();
        await page.waitForTimeout(200);
        const after = (await getExt()).enabled.trackers;
        await page.locator('[data-row="extensions.trackers"] button[role="switch"]').click();
        await page.waitForTimeout(200);
        const restored = (await getExt()).enabled.trackers;
        rec('U10 Settings → Extensions shows every extensions row once the browser started, and a switch acts at once', !!started && expected.every((r) => rows.includes(r)) && before === true && after === false && restored === true, { rows, before, after, restored });
        // The privacy rows gated by `extensions` are there too.
        await navigateApp('/settings/privacy');
        await page.waitForSelector('[data-row="privacy.sendGpc"]', { timeout: 10_000 }).catch(() => undefined);
        const privacyRows = await page.evaluate(() => ['privacy.sendGpc', 'privacy.doNotTrack', 'privacy.referrer', 'privacy.stripTrackingParams', 'privacy.cookies'].filter((r) => document.querySelector(`[data-row="${r}"]`)));
        rec('U10 the privacy rows the content blocker applies are shown in this build (gated by extensions)', privacyRows.length === 5, { privacyRows });

        // ── U13: the allowlist editor stores *.<host>, or the bare host with "Only this host" ─────────────────
        await navigateApp('/settings/extensions');
        await page.waitForSelector('[data-row="extensions.allowlist"] input', { timeout: 10_000 });
        const allowRow = page.locator('[data-row="extensions.allowlist"]');
        await allowRow.locator('input[type="text"], input:not([type])').first().fill('example.localhost');
        await allowRow.getByRole('button', { name: 'Add site' }).click();
        await page.waitForTimeout(200);
        await allowRow.locator('input[type="text"], input:not([type])').first().fill('only.example.localhost');
        await allowRow.locator('label.checkbox', { hasText: 'Only this host' }).click();
        await allowRow.getByRole('button', { name: 'Add site' }).click();
        await page.waitForTimeout(200);
        const allow = (await getExt()).allowlist;
        const shown = await allowRow.innerText();
        const cookieNote = await page.locator('[data-cookie-rules-note]').innerText().catch(() => '');
        rec(
          'U13 the allowlist editor turns example.localhost into *.example.localhost, keeps it bare with "Only this host", and the cookie-rule editor says it receives all cookie rules',
          allow.includes('*.example.localhost') && allow.includes('only.example.localhost') && !allow.includes('example.localhost') && shown.includes('*.example.localhost') && /receives all cookie rules/.test(cookieNote),
          { allow, cookieNote },
        );
        await setExt('allowlist', []);
        if (want(ctx, 'shots')) {
          await shot(page, 'settings-extensions');
        }
      }

      // ── U1: the Extensions page shows the server's listing ────────────────────────────────────────────────
      if (want(ctx, 'lists')) {
        const listing = await fx.listing();
        await navigateApp('/extensions#lists');
        await page.waitForSelector('[data-filter-lists] li[data-list]', { timeout: 20_000 }).catch(() => undefined);
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('[data-filter-lists] li[data-list]')].map((li) => ({
            id: li.getAttribute('data-list'),
            text: li.textContent ?? '',
            publisher: !!li.querySelector('a[href^="http"]'),
            on: li.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'true',
          })),
        );
        const lists = listing?.lists ?? [];
        const missing = lists.filter((l) => !rows.some((r) => r.id === l.id)).map((l) => l.id);
        const bad = rows.filter((r) => {
          const l = lists.find((x) => x.id === r.id);
          if (!l) return true;
          const license = l.license ? r.text.includes(l.license) : r.text.includes('License not stated');
          const size = !l.available || r.text.includes(' B') || r.text.includes('KB') || r.text.includes('MB');
          const updated = !l.available || !l.updated_at || r.text.includes('updated');
          const pub = !l.homepage || r.publisher;
          return !(license && size && updated && pub && r.on === (l.default_enabled === true));
        });
        rec('U1 the Extensions page lists every filter list of /api/filters with its license, size, last update, publisher and default state', lists.length > 0 && missing.length === 0 && bad.length === 0, { count: rows.length, missing, bad: bad.map((b) => b.id) });
        // Turning a list off writes the choice (its effect on blocking after the rebuild: the U1 row of the 'states' part).
        const target = lists.find((l) => l.default_enabled && l.id !== 'ubo-resources');
        if (target) {
          await page.locator(`#filter-list-${target.id}`).click();
          await page.waitForTimeout(200);
          const choices = (await getExt()).lists;
          rec('U1 turning a list off stores the choice (deviation from the server default only)', choices[target.id] === false, { id: target.id, choices });
          await page.locator(`#filter-list-${target.id}`).click();
          await page.waitForTimeout(200);
          const back = (await getExt()).lists;
          rec('U1 turning it back on removes the stored choice', !(target.id in back), { back });
        }
        if (want(ctx, 'shots')) await shot(page, 'extensions-lists');
      }

      // ── U12: autoUpdateLists off keeps the stored listing until "Update lists now" ────────────────────────
      if (want(ctx, 'autoupdate') && fx.mode === 'test') {
        const id = fx.lists.find((l) => l.id !== 'big')?.id;
        if (id) {
          await setExt('autoUpdateLists', false);
          const appSha = () => page.evaluate((x) => window.__gnomeBrowser.filterListing.listing?.lists.find((l) => l.id === x)?.sha256 ?? null, id);
          const before = await appSha();
          const l = fx.lists.find((x) => x.id === id);
          const { readFileSync } = await import('node:fs');
          const original = readFileSync(l.file, 'utf8');
          fx.writeList(id, `${original}\n! U12 ${ctx.browser} ${Date.now()}\n`);
          // The running server re-reads it (POST /admin/filters/refresh): its listing then names the new hash.
          const r = await fx.refreshLists({ via: 'admin' }).then(() => ({ code: 0 }), (e) => ({ code: 1, error: String(e) }));
          let serverSha = null;
          const until = Date.now() + 40_000;
          while (Date.now() < until) {
            serverSha = (await fx.listing())?.lists.find((x) => x.id === id)?.sha256 ?? null;
            if (serverSha && serverSha !== before) break;
            await page.waitForTimeout(500);
          }
          // Opening the Extensions page and the hourly refresh would refresh with auto-update on; off, they do not.
          await navigateApp('/settings/extensions');
          await navigateApp('/extensions#lists');
          await page.waitForTimeout(800);
          const kept = await appSha();
          await page.getByRole('button', { name: 'Update lists now' }).first().click();
          const end = Date.now() + 10_000;
          let updated = await appSha();
          while (updated !== serverSha && Date.now() < end) {
            await page.waitForTimeout(250);
            updated = await appSha();
          }
          rec(
            'U12 with autoUpdateLists off the app keeps its listing after a server change until "Update lists now"',
            r.code === 0 && before !== null && serverSha !== null && serverSha !== before && kept === before && updated === serverSha,
            { before, serverSha, kept, updated, refresh: r.code },
          );
          fx.writeList(id, original);
          await fx.refreshLists({ via: 'admin' }).catch(() => undefined);
          await setExt('autoUpdateLists', true);
        }
      }

      // ── U9: the cookie manager, both engines ───────────────────────────────────────────────────────────────
      if (want(ctx, 'cookies')) {
        for (const engine of ENGINES) {
          await setSetting('browser', 'engine', engine);
          await page.waitForTimeout(400);
          const tag = engine === 'scramjet' ? 'sj' : 'uv';
          await navigateApp('/browse');
          await omnibox(page, fx.url('site-a', `/set-cookie?gnome_u9${tag}a=1&gnome_u9${tag}b=2`));
          await waitLoaded(page, /\/set-cookie/, 60_000).catch(() => undefined);
          await omnibox(page, fx.url('site-b', `/set-cookie?gnome_u9${tag}c=3`));
          const loaded = await waitLoaded(page, /site-b\.localhost.*\/set-cookie/, 60_000).catch(() => null);
          const eng = activeTab(loaded)?.engine ?? null;
          await navigateApp('/extensions#cookies');
          await page.waitForSelector('[data-cookie-manager] [data-cookie-site]', { timeout: 20_000 }).catch(() => undefined);
          const view = async () =>
            page.evaluate(() =>
              Object.fromEntries([...document.querySelectorAll('[data-cookie-manager] [data-cookie-site]')].map((s) => [s.getAttribute('data-cookie-site'), [...s.querySelectorAll('.name')].map((n) => n.textContent)])),
            );
          const v1 = await view();
          const names = (site) => v1[site] ?? [];
          const grouped = names('site-a.localhost').includes(`gnome_u9${tag}a`) && names('site-a.localhost').includes(`gnome_u9${tag}b`) && names('site-b.localhost').includes(`gnome_u9${tag}c`);
          const text = await page.locator('[data-cookie-manager]').innerText();
          rec(`U9 the cookie manager groups the cookies of both sites by registrable domain, names only (never values) [${engine}]`, grouped && eng === engine && !/gnome_u9\w+=\d/.test(text), { v1, engine: eng }, { engine });
          // Delete one cookie.
          await page.getByRole('button', { name: `Delete cookie gnome_u9${tag}a of site-a.localhost` }).click();
          await page.waitForTimeout(800);
          const v2 = await view();
          rec(`U9 delete one cookie [${engine}]`, !(v2['site-a.localhost'] ?? []).includes(`gnome_u9${tag}a`) && (v2['site-a.localhost'] ?? []).includes(`gnome_u9${tag}b`), { v2 }, { engine });
          // Delete a site's cookies.
          await page.locator('[data-cookie-site="site-b.localhost"]').getByRole('button', { name: 'Delete site’s cookies' }).click();
          await page.waitForTimeout(800);
          const v3 = await view();
          rec(`U9 delete a site's cookies [${engine}]`, !('site-b.localhost' in v3) && 'site-a.localhost' in v3, { v3 }, { engine });
          // Delete everything (a confirmation in GNOME's UI).
          await page.getByRole('button', { name: 'Delete all' }).click();
          await page.getByRole('alertdialog').getByRole('button', { name: 'Delete cookies' }).click();
          await page.waitForTimeout(1000);
          const v4 = await view();
          const empty = await page.locator('[data-cookie-manager]').innerText();
          rec(`U9 delete every cookie after a confirmation [${engine}]`, Object.keys(v4).length === 0 && /No cookies/.test(empty), { v4 }, { engine });
          if (want(ctx, 'shots') && engine === 'scramjet') {
            await omnibox(page, fx.url('site-a', `/set-cookie?gnome_shot=1`)).catch(() => undefined);
            await page.waitForTimeout(1500);
            await navigateApp('/extensions#cookies');
            await page.waitForSelector('[data-cookie-manager] [data-cookie-site]', { timeout: 10_000 }).catch(() => undefined);
            await shot(page, 'extensions-cookies');
          }
        }
        await setSetting('browser', 'engine', 'auto');
      }

      // What the tab shows and the shield says (the cumulative counts of tab.blocked, the shield's own number).
      const blockedNow = () =>
        page.evaluate(() => {
          const t = window.__gnomeBrowser.active;
          const shield = document.querySelector('[data-shield-count]');
          return {
            url: t?.url ?? null,
            total: t?.blocked ?? 0,
            by: { ...(t?.blockedBy ?? {}) },
            shield: shield ? Number(shield.getAttribute('data-shield-count')) : null,
            badge: shield?.querySelector('.shield-badge')?.textContent?.trim() ?? null,
            blocker: window.__gnomeBrowser.status ? { ...window.__gnomeBrowser.status.blocker } : null,
          };
        });
      const blockerReady = () =>
        waitState(page, () => true, 1).then(() =>
          page.waitForFunction(() => window.__gnomeBrowser.status?.blocker.state === 'ready', null, { timeout: 60_000 }).then(() => true, () => false),
        );
      // Loads u3.html (3 images from ads.localhost, 1 from trk.localhost) and waits for its counts to settle.
      const loadU3 = async (expectAtLeast) => {
        const since = Date.now();
        await omnibox(page, fx.url('site-a', '/ui/u3.html'));
        await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
        const end = Date.now() + 6000;
        let c = await blockedNow();
        while (Date.now() < end && c.total < expectAtLeast) {
          await page.waitForTimeout(200);
          c = await blockedNow();
        }
        await page.waitForTimeout(600);
        c = await blockedNow();
        const hits = fx.fixtures.requests({ since, path: /^\/beacon/ }).map((r) => `${r.label}:${new URL(r.url ?? r.path, 'http://x').searchParams.get('id') ?? r.path}`);
        return { ...c, hits };
      };
      const reloadTab = async () => {
        const since = Date.now();
        await page.evaluate(() => window.__gnomeBrowser.reload());
        await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
        await page.waitForTimeout(1500);
        const c = await blockedNow();
        return { ...c, hits: fx.fixtures.requests({ since, path: /^\/beacon/ }).map((r) => r.label) };
      };
      // Opens the shield's popover and lets it settle (it animates in and re-renders as counts arrive).
      const openShield = async () => {
        const panel = page.locator('[data-shield-panel]');
        if (!(await panel.isVisible().catch(() => false))) await page.locator('[data-shield-count] button').click();
        await panel.waitFor({ timeout: 10_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        return panel;
      };
      /** A click that survives the popover re-rendering under the pointer (a few short tries). */
      const clickRetry = async (locator) => {
        for (let i = 0; i < 4; i++) {
          try {
            await locator.click({ timeout: 4000 });
            return true;
          } catch {
            await page.waitForTimeout(300);
          }
        }
        return false;
      };

      // ── U3/U4/U5: the shield's numbers, Pause / Resume, the per-site switches ─────────────────────────────
      if (want(ctx, 'shield')) {
        for (const engine of ENGINES) {
          await setSetting('browser', 'engine', engine);
          await setExt('allowlist', []);
          await setExt('perSite', {});
          await navigateApp('/browse');
          // The first page after the engine switch (a cold engine host or service worker) is x1's cross-check; the
          // app's rows judge the next load of the same page, once the blocker is ready (in a run of this part alone, the
          // first page also starts the engine host).
          const cold = await loadU3(4);
          rec(
            `U3 cross-check (x1): the first page after switching to the engine: 3 ads and 1 tracker blocked (none reached the server) and counted once each [${engine}]`,
            (cold.by.ads ?? 0) === 3 && (cold.by.trackers ?? 0) === 1 && !cold.hits.length,
            cold,
            { engine },
          );
          const ready = await blockerReady();
          // This session's counts (the Extensions page's Overview): the app sums tab.blocked per navigation; the engine
          // host sends a new page's early blocks before its commit and once more after it, which must count once.
          const sessionNow = () => page.evaluate(() => ({ ...window.__gnomeBrowser.blockStats.totals }));
          const s0 = await sessionNow();
          const c0 = await loadU3(4);
          const s1 = await sessionNow();
          const grew = { ads: (s1.ads ?? 0) - (s0.ads ?? 0), trackers: (s1.trackers ?? 0) - (s0.trackers ?? 0) };
          rec(
            `U3 this session's counts grow by what the page blocked, once (3 ads, 1 tracker for one load of the page) [${engine}]`,
            (c0.by.ads ?? 0) === 3 && (c0.by.trackers ?? 0) === 1 && grew.ads === 3 && grew.trackers === 1,
            { grew, by: c0.by, before: s0, after: s1 },
            { engine },
          );
          const blockerSum = Object.entries(c0.by).filter(([k]) => k !== 'direct-connection').reduce((n, [, v]) => n + v, 0);
          {
            // The app's part (x4): what the shield shows is tab.blocked without direct connections; the four images
            // were blocked (none reached the server).
            rec(
              `U3 the shield's number equals tab.blocked without direct connections, on a page whose 4 images were blocked [${engine}]`,
              ready && c0.total > 0 && c0.shield === blockerSum && c0.badge === String(blockerSum) && !c0.hits.length,
              c0,
              { engine },
            );
            // The engine host's part (x1): tab.blocked counts each blocked request once.
            rec(`U3 cross-check (x1): tab.blocked counts the 3 ads and 1 tracker once each [${engine}]`, (c0.by.ads ?? 0) === 3 && (c0.by.trackers ?? 0) === 1, c0.by, { engine });
            // The same four images made by script after load (no parser preload): tells a browser that requests a
            // blocked parser-preloaded image twice from a double count in the engine host.
            const since = Date.now();
            await omnibox(page, fx.url('site-a', '/ui/u3s.html'));
            await waitLoaded(page, /site-a\.localhost.*u3s\.html/, 60_000).catch(() => undefined);
            await page.waitForTimeout(2500);
            const cs = await blockedNow();
            const hitsS = fx.fixtures.requests({ since, path: /^\/beacon/ }).length;
            rec(`U3 cross-check (x1): script-made images, 3 ads and 1 tracker counted once each [${engine}]`, (cs.by.ads ?? 0) === 3 && (cs.by.trackers ?? 0) === 1 && hitsS === 0 && cs.shield === (cs.by.ads ?? 0) + (cs.by.trackers ?? 0), { by: cs.by, shield: cs.shield, hits: hitsS }, { engine });
            await omnibox(page, fx.url('site-a', '/ui/u3.html'));
            await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
            await page.waitForTimeout(1500);
          }
          const shieldBtn = page.locator('[data-shield-count] button');
          const visible = await shieldBtn.isVisible().catch(() => false);
          const panel = await openShield();
          const panelText = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ');
          {
            const cNow = await blockedNow();
            const want = Object.entries(cNow.by).filter(([k, v]) => k !== 'direct-connection' && v > 0);
            const labels = { ads: 'Ads', trackers: 'Trackers', security: 'Scam and malware sites', cookies: 'Cookie notices', annoyances: 'Annoyances', urlparams: 'Tracking parameters removed' };
            rec(`U3 the popover lists tab.blocked per category with plain names [${engine}]`, want.length > 0 && want.every(([k, v]) => panelText.includes(`${labels[k]} ${v}`)), { want, panelText: panelText.slice(0, 300) }, { engine });
          }
          if (want(ctx, 'shots') && engine === 'scramjet') await shot(page, 'shield-popover-counts');
          const pauseBtn = panel.getByRole('button', { name: /Pause blocking on/ });
          const pauseText = (await pauseBtn.innerText().catch(() => '')).replace(/\s+/g, ' ');
          await pauseBtn.click();
          await page.waitForTimeout(300);
          const afterPause = (await getExt()).allowlist;
          const resumeVisible = await panel.getByRole('button', { name: 'Resume' }).isVisible().catch(() => false);
          const reloadVisible = await panel.getByRole('button', { name: 'Reload to apply' }).isVisible().catch(() => false);
          if (want(ctx, 'shots') && engine === 'scramjet') await shot(page, 'shield-paused');
          rec(
            `U4 "Pause on this site" names and writes *.site-a.localhost, then offers Resume and "Reload to apply" [${engine}]`,
            visible && /Pause blocking on \*\.site-a\.localhost/.test(pauseText) && afterPause.includes('*.site-a.localhost') && resumeVisible && reloadVisible,
            { pauseText, afterPause, resumeVisible, reloadVisible },
            { engine },
          );
          await clickRetry(panel.getByRole('button', { name: 'Reload to apply' }));
          const c1 = await reloadTab();
          rec(`U4 after Reload nothing is blocked on the paused site: the four images reached the server [${engine}]`, c1.total === 0 && c1.hits.filter((l) => l === 'ads').length === 3 && c1.hits.includes('trk'), c1, { engine });
          // Resume undoes it (and the next load is blocked again).
          await openShield();
          await clickRetry(panel.getByRole('button', { name: 'Resume' }));
          await page.waitForTimeout(300);
          const afterResume = (await getExt()).allowlist;
          await page.keyboard.press('Escape');
          const c2 = await reloadTab();
          rec(
            `U4 Resume removes the key and the next load is blocked again (no image reached the server) [${engine}]`,
            afterResume.length === 0 && /u3\.html/.test(c2.url ?? "") && !c2.hits.length,
            { afterResume, c2 },
            { engine },
          );
          rec(`U4 cross-check (x1): after Resume the blocked ads and tracker are counted [${engine}]`, (c2.by.ads ?? 0) > 0 && (c2.by.trackers ?? 0) > 0, c2.by, { engine });
          // Allowed through Settings as the bare host: Resume removes it too.
          await setExt('allowlist', ['site-a.localhost']);
          await openShield();
          const resume2 = panel.getByRole('button', { name: 'Resume' });
          const r2 = (await resume2.isVisible().catch(() => false)) && (await clickRetry(resume2));
          await page.waitForTimeout(300);
          const afterResume2 = (await getExt()).allowlist;
          rec(`U4 Resume also removes site-a.localhost added in Settings [${engine}]`, r2 && afterResume2.length === 0, { afterResume2 }, { engine });
          // A broader key (a user's *.localhost) still matching: no Resume, a pointer to Settings instead.
          await setExt('allowlist', ['*.localhost']);
          await page.waitForTimeout(300);
          const broaderText = await panel.innerText().catch(() => '');
          const noResume = !(await panel.getByRole('button', { name: 'Resume' }).isVisible().catch(() => false));
          rec(`U4 a broader allowlist key replaces Resume with "Blocking is off for *.localhost in Settings" [${engine}]`, noResume && /Blocking is off for \*\.localhost in Settings/.test(broaderText), { broaderText: broaderText.slice(0, 300) }, { engine });
          await setExt('allowlist', []);
          await page.waitForTimeout(300);
          // U5: the per-site switches write perSite under the site key and act after a reload; back to the global
          // value removes the rule.
          const adsSwitch = panel.getByRole('switch', { name: /^Ads on / });
          await adsSwitch.click();
          await page.waitForTimeout(300);
          const ps1 = (await getExt()).perSite;
          const cosmeticSwitch = panel.getByRole('switch', { name: /^Cosmetic filtering on / });
          await cosmeticSwitch.click();
          await page.waitForTimeout(300);
          const ps2 = (await getExt()).perSite;
          await page.keyboard.press('Escape');
          const c3 = await reloadTab();
          rec(
            `U5 the per-site switches write perSite["*.site-a.localhost"]; with Ads off the ads load and the tracker stays blocked [${engine}]`,
            JSON.stringify(ps1) === JSON.stringify({ '*.site-a.localhost': { adblock: false } }) &&
              JSON.stringify(ps2) === JSON.stringify({ '*.site-a.localhost': { adblock: false, cosmetic: false } }) &&
              (c3.by.ads ?? 0) === 0 && c3.hits.filter((l) => l === 'ads').length === 3 && !c3.hits.includes('trk'),
            { ps1, ps2, c3 },
            { engine },
          );
          // The engine host's part (x1): the tracker it blocked on that load is counted.
          rec(`U5 cross-check (x1): with Ads off for the site, the blocked tracker is counted [${engine}]`, (c3.by.trackers ?? 0) > 0, c3.by, { engine });
          await openShield();
          await clickRetry(adsSwitch);
          await clickRetry(cosmeticSwitch);
          await page.waitForTimeout(300);
          const ps3 = (await getExt()).perSite;
          rec(`U5 switching back to the global values removes the rule [${engine}]`, Object.keys(ps3).length === 0, { ps3 }, { engine });
          await page.keyboard.press('Escape');

          // ── U2: each blocker switch acts at once (network: ad blocker, tracker blocker) ───────────────────
          await navigateApp('/extensions#overview');
          {
            // The Overview shows this session's sums as the app keeps them.
            const totals = await sessionNow();
            const sessionText = ((await page.locator('section[aria-labelledby="session-title"]').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
            const adsCard = ((await page.locator('[data-extension="adblock"]').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
            rec(
              `U3 the Extensions page shows this session's counts per category and per extension [${engine}]`,
              (totals.ads ?? 0) > 0 && sessionText.includes(`Ads ${totals.ads}`) && sessionText.includes(`Trackers ${totals.trackers}`) && adsCard.includes(`${(totals.ads ?? 0) + (totals.security ?? 0)} blocked this session`),
              { totals, sessionText: sessionText.slice(0, 300), adsCard: adsCard.slice(0, 200) },
              { engine },
            );
          }
          await page.locator('[data-extension="adblock"] button[role="switch"]').click();
          await page.waitForTimeout(400);
          await navigateApp('/browse');
          const c4 = await reloadTab();
          await navigateApp('/extensions#overview');
          await page.locator('[data-extension="adblock"] button[role="switch"]').click();
          await page.locator('[data-extension="trackers"] button[role="switch"]').click();
          await page.waitForTimeout(400);
          await navigateApp('/browse');
          const c5 = await reloadTab();
          await navigateApp('/extensions#overview');
          await page.locator('[data-extension="trackers"] button[role="switch"]').click();
          await page.waitForTimeout(400);
          const en = (await getExt()).enabled;
          await navigateApp('/browse');
          rec(
            `U2 the ad blocker and tracker blocker switches of the Extensions page act at the next load [${engine}]`,
            en.adblock &&
              en.trackers &&
              (c4.by.ads ?? 0) === 0 && c4.hits.filter((l) => l === 'ads').length === 3 && !c4.hits.includes('trk') && (c5.by.trackers ?? 0) === 0 && c5.hits.includes('trk') && !c5.hits.includes('ads'),
            { c4, c5, en },
            { engine },
          );
        }
        // From the shield's "Extensions" link (a GNOME page over a live proxied tab): the proxied page must not show
        // through GNOME's page (an observation for the shell's BrowserView, not a row of the plan).
        await navigateApp('/browse');
        await omnibox(page, fx.url('site-a', '/ui/u3.html'));
        await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
        const sp = await openShield();
        await sp.getByRole('link', { name: 'Extensions' }).click();
        await page.waitForTimeout(1500);
        const bleedNow = () =>
          page.evaluate(() => {
            const slot = document.querySelector('.engine-slot');
            const frame = slot?.querySelector('iframe');
            return {
              route: location.pathname,
              slot: slot ? getComputedStyle(slot).visibility : null,
              frame: frame ? getComputedStyle(frame).visibility : null,
              layer: slot?.closest('.layer') ? getComputedStyle(slot.closest('.layer')).visibility : null,
              browserVisible: window.__gnomeBrowser.visible,
            };
          });
        const bleed = await bleedNow();
        if (want(ctx, 'shots')) await shot(page, 'extensions-from-shield');
        // No shield on GNOME's own pages (and the same measurement for a GNOME page reached through the app's router).
        await navigateApp('/settings');
        await page.waitForTimeout(800);
        const bleedSettings = await bleedNow();
        if (want(ctx, 'shots')) await shot(page, 'settings-over-live-tab');
        // Outside lane x4's files (app/Shell.svelte, browser/ui/BrowserView.svelte): measured for the integration step.
        rec(
          'observation (shell): on GNOME pages opened over a live proxied tab (the shield’s Extensions link, /settings), the engine iframe is hidden',
          bleed.route === '/extensions' && bleed.frame === 'hidden' && bleedSettings.route === '/settings' && bleedSettings.frame === 'hidden',
          { fromShield: bleed, settings: bleedSettings },
        );
        const internal = await page.locator('[data-shield-count]').count();
        rec('U3 no shield and no numbers on GNOME’s own pages', internal === 0, { internal });
        await setSetting('browser', 'engine', 'auto');
      }

      // ── U2: the privacy protection, cookie manager and cosmetic filtering switches of the Extensions page ──
      // u2.html: a box the cosmetic test list hides on site-a (x2's site rule), the page's own Sec-GPC header and
      // navigator.globalPrivacyControl (x3), and a site-b frame that sets a third-party cookie (x3's block-third-party,
      // the default cookie mode). With the three switches on: hidden, GPC sent, the cookie not stored; with them off:
      // shown, no GPC, the cookie stored; on again: as at first.
      if (want(ctx, 'switches')) {
        // Reads in a proxied frame or a command to the engine host can hang (a frame mid-navigation): bounded.
        const bounded = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms))]);
        const readU2 = async (cookie) => {
          if (process.env.X4_DEBUG) console.log(`[x4] readU2 ${cookie}`);
          const readSince = Date.now();
          await navigateApp('/browse');
          await omnibox(page, fx.url('site-a', `/ui/u2.html?c=${cookie}`));
          const s = await waitLoaded(page, /site-a\.localhost.*u2\.html/, 60_000).catch(() => null);
          const tab = activeTab(s);
          let out = null;
          let lastError = null;
          const end = Date.now() + 20_000;
          // The page's first-party beacon carries its result (no read inside the proxied frame); the frame read is the
          // fallback (Playwright's frame reads of a reused tab frame can stall in Firefox).
          const fromBeacon = () => {
            const hit = fx.fixtures.requests({ since: readSince, path: /^\/beacon/ }).find((r) => {
              const q = new URLSearchParams(r.search ?? '');
              return q.get('id') === 'u2-result' && q.get('c') === cookie;
            });
            if (!hit) return null;
            try {
              return JSON.parse(new URLSearchParams(hit.search).get('r') ?? '');
            } catch {
              return null;
            }
          };
          while (tab && Date.now() < end) {
            out = fromBeacon();
            if (out) break;
            try {
              const f = await tabFrame(page, tab.id, 5000);
              out = await bounded(f.evaluate(() => {
                const t = document.getElementById('out')?.textContent ?? '';
                return t ? JSON.parse(t) : null;
              }), 3000, 'reading u2.html');
              if (out) break;
            } catch (e) {
              lastError = String(e).slice(0, 160); // navigating, or a stuck read
            }
            await page.waitForTimeout(250);
          }
          await page.waitForTimeout(500);
          const jar = await bounded(page.evaluate(() => window.__gnomeBrowser.listCookies('site-b.localhost').catch((e) => ({ error: String(e) }))), 10_000, 'cookies.list').catch((e) => ({ error: String(e) }));
          const names = Array.isArray(jar?.cookies) ? jar.cookies.map((c) => c.name) : jar;
          return { engine: tab?.engine ?? null, out, stored: Array.isArray(names) ? names.includes(cookie) : null, names, ...(out ? {} : { lastError, url: tab?.url ?? null }) };
        };
        const clickSwitch = async (key) => {
          await page.locator(`[data-extension="${key}"] button[role="switch"]`).click();
          await page.waitForTimeout(200);
        };
        for (const engine of ENGINES) {
          await setSetting('browser', 'engine', engine);
          await setExt('allowlist', []);
          await setExt('perSite', {});
          await navigateApp('/browse');
          await blockerReady();
          const tag = engine === 'scramjet' ? 'sj' : 'uv';
          const stamp = Date.now().toString(36);
          const on1 = await readU2(`gnome_u2${tag}on${stamp}`);
          // Each switch alone (off, one load, on again): only what it gates changes.
          const alone = {};
          for (const k of ['privacy', 'cookies', 'cosmetic']) {
            await navigateApp('/extensions#overview');
            await clickSwitch(k);
            const en = (await getExt()).enabled;
            alone[k] = { ...(await readU2(`gnome_u2${tag}${k}${stamp}`)), switchedOff: en[k] === false && Object.entries(en).every(([x, v]) => x === k || v === true) };
            await navigateApp('/extensions#overview');
            await clickSwitch(k);
          }
          await navigateApp('/extensions#overview');
          for (const k of ['privacy', 'cookies', 'cosmetic']) await clickSwitch(k);
          const enOff = (await getExt()).enabled;
          const off = await readU2(`gnome_u2${tag}off${stamp}`);
          await navigateApp('/extensions#overview');
          for (const k of ['privacy', 'cookies', 'cosmetic']) await clickSwitch(k);
          const enOn = (await getExt()).enabled;
          const on2 = await readU2(`gnome_u2${tag}on2${stamp}`);
          const isOn = (r) => r.engine === engine && r.out?.boxDisplay === 'none' && r.out?.gpc === true && r.out?.secGpc === '1' && r.out?.frameLoaded === true && r.stored === false;
          const isOff = (r) => r.engine === engine && !!r.out && r.out.boxDisplay !== 'none' && r.out.gpc === false && r.out.secGpc === null && r.out.frameLoaded === true && r.stored === true;
          rec(
            `U2 privacy protection, the cookie manager and cosmetic filtering: off in the Extensions page → the box shows, no GPC, the third-party cookie is stored; on again → as before [${engine}]`,
            isOn(on1) && !enOff.privacy && !enOff.cookies && !enOff.cosmetic && isOff(off) && enOn.privacy && enOn.cookies && enOn.cosmetic && isOn(on2),
            { on1, off, on2 },
            { engine },
          );
          // Each switch alone (what each one gates, and nothing else): its own effect is gone, the other two stay.
          const hidden = (r) => r.out?.boxDisplay === 'none';
          const shown = (r) => !!r.out && r.out.boxDisplay !== 'none';
          const gpcSent = (r) => r.out?.gpc === true && r.out?.secGpc === '1';
          const gpcNone = (r) => !!r.out && r.out.gpc === false && r.out.secGpc === null;
          const refused = (r) => r.out?.frameLoaded === true && r.stored === false;
          const stored = (r) => r.out?.frameLoaded === true && r.stored === true;
          const ok = (r) => r.engine === engine && r.switchedOff === true;
          rec(
            `U2 cosmetic filtering switch alone: off → the box shows while GPC is still sent and the third-party cookie still refused; on → hidden [${engine}]`,
            hidden(on1) && ok(alone.cosmetic) && shown(alone.cosmetic) && gpcSent(alone.cosmetic) && refused(alone.cosmetic) && hidden(on2),
            { on1: on1.out, alone: alone.cosmetic, on2: on2.out },
            { engine },
          );
          rec(
            `U2 privacy protection switch alone: off → no Sec-GPC and no navigator.globalPrivacyControl while the box stays hidden and the cookie refused; on → sent [${engine}]`,
            gpcSent(on1) && ok(alone.privacy) && gpcNone(alone.privacy) && hidden(alone.privacy) && refused(alone.privacy) && gpcSent(on2),
            { on1: on1.out, alone: alone.privacy, on2: on2.out },
            { engine },
          );
          rec(
            `U2 cookie manager switch alone: off → the third-party frame's cookie is stored while the box stays hidden and GPC is sent; on → refused [${engine}]`,
            refused(on1) && ok(alone.cookies) && stored(alone.cookies) && hidden(alone.cookies) && gpcSent(alone.cookies) && refused(on2),
            { on1: { out: on1.out, names: on1.names }, alone: alone.cookies, on2: { out: on2.out, names: on2.names } },
            { engine },
          );
          await bounded(page.evaluate(() => window.__gnomeBrowser.deleteCookies({ all: false, site: 'site-b.localhost', name: null }).catch(() => undefined)), 10_000, 'cookies.delete').catch(() => undefined);
        }
        await setSetting('browser', 'engine', 'auto');
      }

      // ── U6: the blocked page (the test lists: docblock.localhost $document in the ads list, bad.localhost in the
      // scam and malware list) ────────────────────────────────────────────────────────────────────────────
      if (want(ctx, 'blocked')) {
        /** The shield's panel on a blocked page: its text and whether it offers Pause or per-site switches. */
        const shieldOnBlocked = async () => {
          await page.locator('[data-shield-count] button').click();
          const sp = page.locator('[data-shield-panel]');
          await sp.waitFor({ timeout: 10_000 }).catch(() => undefined);
          await page.waitForTimeout(400);
          const r = {
            text: ((await sp.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').slice(0, 300),
            pause: await sp.getByRole('button', { name: /Pause blocking/ }).count(),
            switches: await sp.getByRole('switch').count(),
          };
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          return r;
        };
        for (const engine of ENGINES) {
          await setSetting('browser', 'engine', engine);
          await setExt('allowlist', []);
          await navigateApp('/browse');
          await blockerReady();
          await omnibox(page, fx.url('site-a', '/ui/u3.html'));
          await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
          const since = Date.now();
          await omnibox(page, fx.url('docblock', '/ui/index.html'));
          const blockedState = await waitState(page, (s) => activeTab(s)?.error?.kind === 'blocked', 30_000, 'the blocked page').catch(() => null);
          if (!blockedState) {
            rec(`U6 the blocked page [${engine}]`, false, { why: 'no blocked page within 30 s', state: activeTab(await state(page)) }, { engine });
            continue;
          }
          await page.waitForTimeout(500);
          const overlay = page.locator('[role="alert"]');
          const otext = (await overlay.innerText().catch(() => '')).replace(/\s+/g, ' ');
          const noFallback = !(await overlay.getByRole('button', { name: /Open (with|in)/ }).count());
          const turnOff = overlay.getByRole('button', { name: /Turn off blocking on/ });
          const keyText = (await turnOff.innerText().catch(() => '')).replace(/\s+/g, ' ');
          const reachedPaths = fx.fixtures.requests({ since, label: 'docblock' }).map((r) => `${r.method} ${r.path}`);
          // The blocked document itself never reached the server (the engine host's favicon fetch for the blocked page
          // is reported apart: x1's row N8 owns "no request reached the page's subresources").
          const reached = reachedPaths.filter((x) => x.endsWith('/ui/index.html')).length;
          if (want(ctx, 'shots') && engine === 'scramjet') await shot(page, 'blocked-page');
          const shieldAds = await shieldOnBlocked();
          rec(
            `U6 an ads block: "Blocked by GNOME", the ads reason, Go back, a button that names its key, no engine-fallback button; the document never reached the server [${engine}]`,
            !!blockedState && /Blocked by GNOME/.test(otext) && /a filter list for ads names this address/.test(otext) && /Go back/.test(otext) && noFallback && /Turn off blocking on \*\.docblock\.localhost/.test(keyText) && reached === 0 && activeTab(blockedState)?.error?.fallback === 'none',
            { otext: otext.slice(0, 400), keyText, reachedPaths, fallback: activeTab(blockedState)?.error?.fallback },
            { engine },
          );
          await turnOff.click();
          const dialog = page.getByRole('alertdialog');
          await dialog.waitFor({ timeout: 5000 }).catch(() => undefined);
          await page.waitForTimeout(400);
          const dtext = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ');
          if (want(ctx, 'shots') && engine === 'scramjet') await shot(page, 'blocked-confirm');
          await dialog.getByRole('button', { name: 'Turn off blocking' }).click();
          const loadedAfter = await waitLoaded(page, /docblock\.localhost(:\d+)?\/ui\/index\.html/, 45_000).catch(() => null);
          const allow = (await getExt()).allowlist;
          rec(
            `U6 the confirmation shows the key and what it turns off; after Confirm the allowlist has it and the blocked page loads, not the previous one [${engine}]`,
            /\*\.docblock\.localhost/.test(dtext) && /also on your other devices if you sync settings/.test(dtext) && allow.includes('*.docblock.localhost') && !!loadedAfter && /docblock\.localhost/.test(activeTab(loadedAfter)?.url ?? ''),
            { dtext: dtext.slice(0, 400), allow, url: activeTab(loadedAfter)?.url ?? null },
            { engine },
          );
          // The scam and malware list: only Go back and the Settings sentence.
          await omnibox(page, fx.url('bad', '/ui/index.html'));
          const bad = await waitState(page, (s) => activeTab(s)?.error?.kind === 'blocked', 30_000, 'the bad page').catch(() => null);
          await page.waitForTimeout(500);
          const btext = (await overlay.innerText().catch(() => '')).replace(/\s+/g, ' ');
          const buttons = await overlay.getByRole('button').allInnerTexts().catch(() => []);
          if (want(ctx, 'shots') && engine === 'scramjet') await shot(page, 'blocked-security');
          const shieldBad = await shieldOnBlocked();
          rec(
            `U6 on a blocked page (ads, scam and malware) the shield offers no Pause and no per-site switches: no one-click allow past the blocked page [${engine}]`,
            !!bad && [shieldAds, shieldBad].every((x) => x.pause === 0 && x.switches === 0 && /GNOME blocked this page/.test(x.text)),
            { shieldAds, shieldBad },
            { engine },
          );
          rec(
            `U6 a scam and malware block offers only Go back and "allow the site under Settings → Site rules" [${engine}]`,
            !!bad && /This site is on a list of scam and malware sites/.test(btext) && /If you are sure, you can allow the site under Settings → Site rules/.test(btext) && buttons.length === 1 && /Go back/.test(buttons[0] ?? ''),
            { btext: btext.slice(0, 300), buttons },
            { engine },
          );
          // Go back: the page the tab was on (the blocked navigation never committed).
          await overlay.getByRole('button', { name: 'Go back' }).click();
          const back = await waitLoaded(page, /docblock\.localhost/, 45_000).catch(() => null);
          rec(`U6 Go back shows the page the tab was on [${engine}]`, !!back && !activeTab(back)?.error, { url: activeTab(back)?.url ?? null }, { engine });
          await setExt('allowlist', []);
        }
        await setSetting('browser', 'engine', 'auto');
      }

      // ── U7, U8, U11: the blocker's states with GNOME's own texts, "Rebuild filter data", the cache limit ─────
      if (want(ctx, 'states')) {
        await setSetting('browser', 'engine', 'scramjet');
        await navigateApp('/browse');
        await omnibox(page, fx.url('site-a', '/ui/u3.html'));
        await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
        const ready = await blockerReady();
        // U8: "Rebuild filter data" discards the cached data and builds again (the engines in force stay meanwhile: the
        // state stays `ready`, WAVE-B3 §4.1 status); the Status tab then says it was built in this browser.
        await navigateApp('/extensions#lists');
        const before = await page.evaluate(() => window.__gnomeBrowser.refreshBlockerStats());
        await page.waitForTimeout(1100);
        await page.getByRole('button', { name: 'Rebuild filter data' }).click();
        const end8 = Date.now() + 60_000;
        let after = before;
        while (Date.now() < end8) {
          after = await page.evaluate(() => window.__gnomeBrowser.refreshBlockerStats());
          if (after && before && after.builtAt !== null && after.builtAt > (before.builtAt ?? 0)) break;
          await page.waitForTimeout(500);
        }
        await navigateApp('/extensions#status');
        await page.waitForTimeout(600);
        const statusText = await page.locator('[data-blocker-status]').innerText().catch(() => '');
        if (want(ctx, 'shots')) await shot(page, 'state-status-after-rebuild');
        rec(
          'U8 "Rebuild filter data": the engine host builds again (newer builtAt, source build) and the Status tab says so; blocking stays on meanwhile [scramjet]',
          ready && !!before && !!after && (after.builtAt ?? 0) > (before.builtAt ?? 0) && after.source === 'build' && /A build in this browser/.test(statusText),
          { before: before && { builtAt: before.builtAt, source: before.source }, after: after && { builtAt: after.builtAt, source: after.source }, statusText: statusText.slice(0, 300) },
          { engine: 'scramjet' },
        );
        // U7 building and a failed list, in a fresh browser context (empty caches): the app's listing is stored with
        // auto-update off before the engine host ever ran there, then the server's copy of one list changes. The engine
        // host starts with every list-based extension off (no lists sent: state `off`), its builds are held (x1's e2e-only
        // test.blocker {holdBuild}), then the extensions are switched on: with nothing in force the state is `building`
        // (the shield's dot, "Preparing filter lists…") until the build is released; that list then fails with `changed`
        // (its body no longer has the ref's hash) → "1 of N filter lists could not be loaded". Holding the build is needed
        // in Firefox: there the first engine host answers init only after its service worker and engines started (~1.8 s
        // here), when a first build of these lists (~1.3 s) is already done, so `building` never reaches the app.
        {
          const ctx2 = await ctx.newContext(browser);
          try {
            const { page: p2 } = await openGnome(ctx, ctx2, '/extensions#lists', { waitBrowser: true });
            await p2.waitForFunction(() => window.__gnomeBrowser.filterListing.listing !== null, null, { timeout: 20_000 });
            await p2.evaluate((id) => {
              const s = window.__gnomeSettings;
              s.set('vpn', 'mode', 'gateway');
              s.set('vpn', 'preferredLocation', id);
              s.set('extensions', 'autoUpdateLists', false);
              s.set('extensions', 'lists', { big: true });
              s.set('extensions', 'enabled', { adblock: false, trackers: false, privacy: false, cookies: true, cosmetic: false });
              s.set('browser', 'engine', 'scramjet');
            }, ctx.stack.profiles.live);
            await p2.waitForTimeout(800);
            const id = 'e2e-network-trackers';
            const l = fx.lists.find((x) => x.id === id);
            const { readFileSync } = await import('node:fs');
            const original = readFileSync(l.file, 'utf8');
            const sha0 = (await fx.listing())?.lists.find((x) => x.id === id)?.sha256;
            fx.writeList(id, `${original}\n! U7 ${ctx.browser} ${Date.now()}\n`);
            await fx.refreshLists({ via: 'admin' }).catch(() => undefined);
            const until = Date.now() + 40_000;
            while (Date.now() < until && (await fx.listing())?.lists.find((x) => x.id === id)?.sha256 === sha0) await p2.waitForTimeout(500);
            // The app page records every blocker state it holds (polled in the page every 10 ms, with the time since start).
            await p2.evaluate(() => {
              const t0 = performance.now();
              const log = [];
              let last;
              window.__x4States = log;
              setInterval(() => {
                const st = window.__gnomeBrowser.status?.blocker.state ?? null;
                if (st !== last) log.push([st, Math.round(performance.now() - t0)]);
                last = st;
              }, 10);
            });
            await omnibox(p2, fx.url('site-a', '/ui/u3.html'));
            await waitLoaded(p2, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
            const offFirst = await p2.evaluate(() => window.__gnomeBrowser.status?.blocker.state ?? null);
            const held = await p2.evaluate(() => window.__gnomeBrowser.testCommand('test.blocker', { holdBuild: true })).catch((e) => ({ error: String(e) }));
            const sawDot = p2.waitForSelector('[data-shield-count] .shield-dot', { timeout: 30_000 }).then(() => true, () => false);
            const sawText = p2.waitForFunction(() => [...document.querySelectorAll('[data-shield-count] button')].some((b) => /preparing filter lists/.test(b.getAttribute('aria-label') ?? '')), null, { timeout: 30_000 }).then(() => true, () => false);
            await p2.evaluate(() => window.__gnomeSettings.set('extensions', 'enabled', { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true }));
            const dot = await sawDot;
            const text = await sawText;
            await p2.locator('[data-shield-count] button').click();
            await p2.waitForTimeout(600);
            const buildingShield = (await p2.locator('[data-shield-panel]').innerText().catch(() => '')).replace(/\s+/g, ' ');
            if (want(ctx, 'shots')) await shot(p2, 'state-building-shield');
            await p2.keyboard.press('Escape');
            // The Extensions page says it too, while the build is still held: its banner, and "Preparing" as the state of
            // the extensions that use filter lists.
            const appTo = (path) =>
              p2.evaluate((x) => {
                const a = document.createElement('a');
                a.href = x;
                document.body.append(a);
                a.click();
                a.remove();
              }, path);
            await appTo('/extensions#overview');
            await p2.waitForTimeout(800);
            const buildingPage = ((await p2.locator('main').first().innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
            const adState = ((await p2.locator('[data-extension="adblock"] .state').innerText().catch(() => '')) ?? '').trim();
            const heldState = await p2.evaluate(() => window.__gnomeBrowser.status?.blocker.state ?? null);
            await appTo('/browse');
            await p2.waitForTimeout(500);
            await p2.evaluate(() => window.__gnomeBrowser.testCommand('test.blocker', { releaseBuild: true })).catch(() => undefined);
            const failed = await p2
              .waitForFunction(() => /^lists-failed:1:\d+$/.test(window.__gnomeBrowser.status?.blocker.detail ?? ''), null, { timeout: 60_000 })
              .then(() => true, () => false);
            const states = await p2.evaluate(() => window.__x4States.slice());
            const built = await p2
              .evaluate(() => window.__gnomeBrowser.refreshBlockerStats().then((x) => x && { source: x.source, buildMs: x.buildMs, lists: x.lists.map((l) => `${l.id}:${l.state}`) }))
              .catch((e) => String(e));
            rec(
              'U7 building: with nothing in force and a build under way the shield shows its state dot and "Preparing filter lists…", and so does the Extensions page [scramjet]',
              offFirst === 'off' &&
                held?.held === true &&
                states.some(([st]) => st === 'building') &&
                dot &&
                text &&
                buildingShield.includes('Preparing filter lists…') &&
                heldState === 'building' &&
                buildingPage.includes('Preparing filter lists…') &&
                adState === 'Preparing',
              { offFirst, held, states, dot, text, buildingShield: buildingShield.slice(0, 200), heldState, adState, buildingPage: buildingPage.slice(0, 300), built },
              { engine: 'scramjet' },
            );
            await p2.locator('[data-shield-count] button').click();
            await p2.waitForTimeout(600);
            const shieldText = (await p2.locator('[data-shield-panel]').innerText().catch(() => '')).replace(/\s+/g, ' ');
            if (want(ctx, 'shots')) await shot(p2, 'state-list-failed-shield');
            await p2.keyboard.press('Escape');
            await p2.evaluate(() => {
              const a = document.createElement('a');
              a.href = '/extensions#lists';
              document.body.append(a);
              a.click();
              a.remove();
            });
            await p2.waitForTimeout(800);
            await p2.evaluate(() => window.__gnomeBrowser.refreshBlockerStats());
            await p2.waitForTimeout(800);
            const pageText = await p2.locator('main, body').first().innerText().catch(() => '');
            const listState = await p2.evaluate((x) => document.querySelector(`[data-list="${x}"] [data-list-state]`)?.textContent ?? null, id);
            const detail = await p2.evaluate(() => window.__gnomeBrowser.status?.blocker.detail ?? null);
            if (want(ctx, 'shots')) await shot(p2, 'state-list-failed');
            rec(
              'U7 a list the server changed: GNOME’s "1 of N filter lists could not be loaded" in the page and the shield, and the list says it changed on the server [scramjet]',
              failed && /1 of \d+ filter lists could not be loaded/.test(pageText) && /1 of \d+ filter lists could not be loaded/.test(shieldText) && /Changed on the server/.test(listState ?? ''),
              { detail, listState, shieldText: shieldText.slice(0, 260) },
              { engine: 'scramjet' },
            );
            // With auto-update on the app refreshes its listing (a failed list) and the next build uses the new hash.
            await p2.evaluate(() => window.__gnomeSettings.set('extensions', 'autoUpdateLists', true));
            await p2.evaluate(() => window.__gnomeBrowser.refreshBlockerStats());
            const recovered = await p2
              .waitForFunction(() => window.__gnomeBrowser.status?.blocker.state === 'ready' && window.__gnomeBrowser.status?.blocker.detail === null, null, { timeout: 60_000 })
              .then(() => true, () => false);
            rec('U7 with auto-update on the app refreshes its listing after the failure and the list compiles again [scramjet]', recovered, { detail: await p2.evaluate(() => window.__gnomeBrowser.status?.blocker.detail ?? null) }, { engine: 'scramjet' });
            fx.writeList(id, original);
            await fx.refreshLists({ via: 'admin' }).catch(() => undefined);
          } finally {
            await ctx2.close();
          }
        }
        // U7 failed: a fresh browser context whose only filter list (every other one turned off) changed on the server
        // after the app stored its listing (auto-update off): nothing can be built → `failed:all-lists-failed`, shown
        // with GNOME's own text in the shield (its dot and the popover) and the Extensions page.
        {
          const ctx3 = await ctx.newContext(browser);
          const id = 'e2e-network-security';
          const l = fx.lists.find((x) => x.id === id);
          const { readFileSync } = await import('node:fs');
          const original = readFileSync(l.file, 'utf8');
          try {
            const { page: p3 } = await openGnome(ctx, ctx3, '/extensions#lists', { waitBrowser: true });
            await p3.waitForFunction(() => window.__gnomeBrowser.filterListing.listing !== null, null, { timeout: 20_000 });
            const others = (await fx.listing())?.lists.filter((x) => x.id !== id).map((x) => x.id) ?? [];
            await p3.evaluate(
              ([vpnId, offIds]) => {
                const s = window.__gnomeSettings;
                s.set('vpn', 'mode', 'gateway');
                s.set('vpn', 'preferredLocation', vpnId);
                s.set('extensions', 'autoUpdateLists', false);
                s.set('extensions', 'lists', Object.fromEntries(offIds.map((x) => [x, false])));
                s.set('browser', 'engine', 'scramjet');
              },
              [ctx.stack.profiles.live, others],
            );
            await p3.waitForTimeout(800);
            const sha0 = (await fx.listing())?.lists.find((x) => x.id === id)?.sha256;
            fx.writeList(id, `${original}\n! U7 failed ${ctx.browser} ${Date.now()}\n`);
            await fx.refreshLists({ via: 'admin' }).catch(() => undefined);
            const until = Date.now() + 40_000;
            while (Date.now() < until && (await fx.listing())?.lists.find((x) => x.id === id)?.sha256 === sha0) await p3.waitForTimeout(500);
            await omnibox(p3, fx.url('site-a', '/ui/u3.html'));
            const failed = await p3
              .waitForFunction(() => window.__gnomeBrowser.status?.blocker.state === 'failed' && window.__gnomeBrowser.status?.blocker.detail === 'failed:all-lists-failed', null, { timeout: 90_000 })
              .then(() => true, () => false);
            await waitLoaded(p3, /site-a\.localhost.*u3\.html/, 30_000).catch(() => undefined);
            const dot = await p3.locator('[data-shield-count] .shield-dot').count();
            const label = await p3.locator('[data-shield-count] button').getAttribute('aria-label').catch(() => null);
            await p3.locator('[data-shield-count] button').click();
            await p3.waitForTimeout(600);
            const shieldText = (await p3.locator('[data-shield-panel]').innerText().catch(() => '')).replace(/\s+/g, ' ');
            if (want(ctx, 'shots')) await shot(p3, 'state-failed-shield');
            await p3.keyboard.press('Escape');
            await p3.evaluate(() => {
              const a = document.createElement('a');
              a.href = '/extensions#overview';
              document.body.append(a);
              a.click();
              a.remove();
            });
            await p3.waitForTimeout(1000);
            const pageText = (await p3.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
            if (want(ctx, 'shots')) await shot(p3, 'state-failed-page');
            const sentence = 'Filter lists could not be prepared. None of the filter lists could be loaded from this server.';
            rec(
              'U7 failed: the only filter list changed on the server → "Filter lists could not be prepared" with its reason in the shield (dot, popover) and the Extensions page [scramjet]',
              failed && dot > 0 && /filter lists could not be prepared/.test(label ?? '') && shieldText.includes(sentence) && pageText.includes(sentence),
              { failed, dot, label, shieldText: shieldText.slice(0, 260), page: pageText.slice(0, 400) },
              { engine: 'scramjet' },
            );
          } finally {
            fx.writeList(id, original);
            await fx.refreshLists({ via: 'admin' }).catch(() => undefined);
            await ctx3.close();
          }
        }
        // U11: cacheLimitMB 16 with the big list on → over-cache-limit.
        await setSetting('performance', 'cacheLimitMB', 16);
        await setExt('lists', { big: true });
        await page.waitForTimeout(600);
        await navigateApp('/extensions#overview');
        const overText = await page
          .waitForFunction(() => /is larger than the cache limit \(16 MB\): it is rebuilt each time GNOME starts/.test(document.body.innerText), null, { timeout: 180_000 })
          .then(() => true, () => false);
        const overDetail = await page.evaluate(() => window.__gnomeBrowser.status?.blocker.detail ?? null);
        const overStatus = await page.evaluate(() => ({ ...(window.__gnomeBrowser.status?.blocker ?? {}) }));
        const overStats = await page.evaluate(() => window.__gnomeBrowser.refreshBlockerStats().then((x) => x && { cache: x.cache, lists: x.lists.map((l) => [l.id, l.state, l.error]) }));
        if (want(ctx, 'shots')) await shot(page, 'state-over-cache-limit');
        await navigateApp('/browse');
        await page.locator('[data-shield-count] button').click();
        const overShield = (await page.locator('[data-shield-panel]').innerText().catch(() => '')).replace(/\s+/g, ' ');
        await page.keyboard.press('Escape');
        const fits = overStats && overStats.cache.bytes <= overStats.cache.limitBytes && overDetail === null;
        if (fits) rec('U11 cacheLimitMB 16 with the big list on: GNOME’s over-cache-limit text in the page and the shield [scramjet]', null, `not provoked: the set with the big list is ${overStats.cache.bytes} bytes, within 16 MiB (${overStats.cache.limitBytes}); the fixture needs a bigger list (x5). The text is unit-tested. ${JSON.stringify(overStats).slice(0, 300)}`, { engine: 'scramjet' });
        else rec(
          'U11 cacheLimitMB 16 with the big list on: GNOME’s over-cache-limit text in the page and the shield [scramjet]',
          overText && /^over-cache-limit:\d+:16777216$/.test(overDetail ?? '') && /larger than the cache limit \(16 MB\)/.test(overShield),
          { overDetail, overStatus, overStats, overShield: overShield.slice(0, 200) },
          { engine: 'scramjet' },
        );
        await setExt('lists', {});
        await setSetting('performance', 'cacheLimitMB', 256);
        // U1: turning a list off changes blocking after the rebuild (the engines in force stay until the new set is ready,
        // D7: wait until the engine host compiled the set without that list), in both engines.
        await setExt('lists', { 'e2e-network-ads': false });
        const rebuilt = await page
          .waitForFunction(
            async () => {
              const st = await window.__gnomeBrowser.refreshBlockerStats();
              return !!st && st.lists.length > 0 && !st.lists.some((l) => l.id === 'e2e-network-ads');
            },
            null,
            { timeout: 60_000, polling: 500 },
          )
          .then(() => true, () => false);
        for (const engine of ENGINES) {
          await setSetting('browser', 'engine', engine);
          // The engine choice reaches the engine host with the next (debounced) snapshot; then a new navigation in that
          // engine (the first one after a switch to Ultraviolet also warms up its service worker), and the judged load.
          await page.waitForTimeout(800);
          await omnibox(page, fx.url('site-a', '/ui/index.html'));
          await waitLoaded(page, /site-a\.localhost.*\/ui\/index\.html/, 60_000).catch(() => undefined);
          await loadU3(0);
          const c = await (async () => {
            const since = Date.now();
            await page.evaluate(() => window.__gnomeBrowser.reload());
            await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => undefined);
            await page.waitForTimeout(1500);
            return { ...(await blockedNow()), engine: await page.evaluate(() => window.__gnomeBrowser.active?.engine ?? null), hits: fx.fixtures.requests({ since, path: /^\/beacon/ }).map((r) => r.label) };
          })();
          rec(
            `U1 turning the ads test list off: after the rebuild the ads load, the tracker stays blocked [${engine}]`,
            rebuilt && c.engine === engine && (c.by.ads ?? 0) === 0 && c.hits.filter((x) => x === 'ads').length === 3 && (c.by.trackers ?? 0) > 0 && !c.hits.includes('trk'),
            { ...c, rebuilt },
            { engine },
          );
        }
        await setExt('lists', {});
        await setSetting('browser', 'engine', 'auto');
      }

      // ── About: the limitations and the licenses ───────────────────────────────────────────────────────────
      if (want(ctx, 'about')) {
        await navigateApp('/about');
        await page.waitForSelector('#blocking', { timeout: 15_000 }).catch(() => undefined);
        const about = await page.evaluate(() => document.querySelector('#blocking')?.closest('section')?.textContent ?? '');
        const licenses = await page.evaluate(() => document.querySelector('#licenses')?.closest('section')?.textContent ?? '');
        rec(
          'U12 About lists the content-blocking limitations and the filter engine’s licenses (MPL-2.0 Ghostery adblocker, MIT tldts)',
          /does not do|do not do/.test(about) && /break out of GNOME’s browser engine/.test(about) && /Ghostery adblocker/.test(licenses) && /Mozilla Public License 2\.0/.test(licenses) && /tldts/.test(licenses),
          { about: about.slice(0, 200) },
        );
      }

      // ── Screenshots: the Extensions page, the shield and the blocked page in both themes, desktop and phone ──
      // GNOME's pages are shot from a new-tab page (no live proxied tab under them): the shell's BrowserView lets a
      // live tab's engine iframe show through GNOME pages (the 'observation (shell)' row above).
      if (want(ctx, 'shots')) {
        await setSetting('browser', 'engine', 'scramjet');
        await navigateApp('/browse');
        await omnibox(page, fx.url('site-a', '/ui/u3.html'));
        const s1 = await waitLoaded(page, /site-a\.localhost.*u3\.html/, 60_000).catch(() => null);
        const liveId = activeTab(s1)?.id ?? null;
        await omnibox(page, fx.url('docblock', '/ui/index.html'), { newTab: true });
        const s2 = await waitState(page, (x) => activeTab(x)?.error?.kind === 'blocked', 30_000, 'the blocked page').catch(() => null);
        const blockedId = activeTab(s2)?.id ?? null;
        const blankId = await page.evaluate(() => window.__gnomeBrowser.newTab()?.id ?? null);
        await page.waitForTimeout(800);
        for (const theme of ['dark', 'light']) {
          await setSetting('appearance', 'theme', theme);
          for (const [vw, vh, form] of [
            [1280, 860, 'desktop'],
            [390, 844, 'phone'],
          ]) {
            await page.setViewportSize({ width: vw, height: vh });
            await navigateApp('/browse');
            if (liveId !== null) {
              await page.evaluate((id) => window.__gnomeBrowser.activate(id), liveId);
              await page.waitForTimeout(900);
              await openShield().catch(() => undefined);
              await page.waitForTimeout(500);
              await shot(page, `shield-${theme}-${form}`);
              await page.keyboard.press('Escape');
            }
            if (blockedId !== null) {
              await page.evaluate((id) => window.__gnomeBrowser.activate(id), blockedId);
              await page.waitForTimeout(900);
              await shot(page, `blocked-${theme}-${form}`);
            }
            if (blankId !== null) await page.evaluate((id) => window.__gnomeBrowser.activate(id), blankId);
            await page.waitForTimeout(500);
            for (const t of ['overview', 'lists', 'rules', 'cookies', 'status', 'how']) {
              await navigateApp(`/extensions#${t}`);
              await page.waitForTimeout(1000);
              await shot(page, `extensions-${t}-${theme}-${form}`);
            }
            await navigateApp('/settings/extensions');
            await page.waitForTimeout(1000);
            await shot(page, `settings-extensions-${theme}-${form}`);
          }
        }
        await setSetting('appearance', 'theme', 'dark');
        await page.setViewportSize({ width: 1280, height: 860 });
        await setSetting('browser', 'engine', 'auto');
      }
      rec('no page errors in the app during the suite', errors.length === 0, { errors: errors.slice(0, 5) });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
