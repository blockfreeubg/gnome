// Lane d e2e: the History, Bookmarks and Downloads pages on the real stack (gnome-server serving the built app),
// with seeded data, in Chromium and Firefox: rendering, search, removal and Undo, clearing, folders, the editor and
// its URL check, favorites, drag and drop, Netscape import (a real Firefox export) and export, downloads in every
// state and the sweep of downloads whose app page closed, live updates across GNOME tabs, the Settings → Privacy
// clearers, structural checks (page errors, unnamed controls, duplicate ids, phone overflow) and screenshots in
// dark/light × desktop/phone (docs/screenshots/library).
//
//   node tests/e2e/engine/suites/library-pages.mjs [--browser chromium|firefox|all]   (see library-lib.mjs)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, REPO, runStandalone, settingsMirror, shotsDir } from './library-lib.mjs';
import { dump, seed, seedData } from './library-seed-lib.mjs';

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const FIREFOX_EXPORT = path.join(REPO, 'frontend', 'src', 'library', 'fixtures', 'firefox-157-export.html');

export async function run(ctx) {
  const browser = await ctx.launch();
  const errors = [];
  const check = async (test, fn) => {
    try {
      const notes = await fn();
      ctx.record({ test, result: 'pass', notes: typeof notes === 'string' ? notes : undefined });
    } catch (err) {
      ctx.record({ test, result: 'fail', notes: String(err?.message ?? err).slice(0, 600) });
    }
  };
  const expect = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  async function newPage(theme = 'dark', viewport = 'desktop', extraSettings = {}) {
    const context = await ctx.newContext(browser, { viewport: VIEWPORTS[viewport], colorScheme: theme, acceptDownloads: true });
    await context.addInitScript(
      ([value]) => {
        try {
          if (!sessionStorage.getItem('lib-e2e:seeded')) {
            localStorage.setItem('gnome:settings:v1', value);
            sessionStorage.setItem('lib-e2e:seeded', '1');
          }
        } catch {
          /* storage blocked */
        }
      },
      [settingsMirror(theme, extraSettings)],
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const label = () => `${theme}/${viewport} ${page.url().replace(ctx.stack.appOrigin, '')}`;
    page.on('pageerror', (e) => errors.push(`${label()}: page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = m.location()?.url ?? '';
      // Endpoints this build may not serve (games, filters, VPN locations) answer 404.
      if (/Failed to load resource/.test(m.text()) && /\/api\/(filters|vpn\/locations|games)/.test(url)) return;
      errors.push(`${label()}: console.error: ${m.text()} ${url.replace(ctx.stack.appOrigin, '')}`);
    });
    return { context, page };
  }

  const settle = async (page) => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(250);
  };

  async function open(page, p) {
    await page.goto(ctx.stack.appOrigin + p, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1');
    await settle(page);
  }

  /** Client-side navigation (no reload): through the app's router, like a click on a rail link. */
  async function go(page, p) {
    await page.evaluate((to) => {
      const a = document.createElement('a');
      a.href = to;
      document.body.append(a);
      a.click();
      a.remove();
    }, p);
    await page.waitForFunction((to) => location.pathname + location.search === to, p);
    await page.waitForSelector('h1');
    await settle(page);
  }

  /**
   * Seeds and shows `p`. The in-progress download's app page counts as alive (a fresh heartbeat). The seed is
   * written after the app has started (the browser starts when the page is idle) and the page is then shown by a
   * client-side navigation: lane c's startBrowser() currently clears the history on every app load (see the check
   * "history survives an app reload"), which would otherwise wipe the seed.
   */
  async function seeded(page, p, data = seedData()) {
    await open(page, '/about');
    await page.waitForTimeout(2500);
    await seed(page, data);
    await page.evaluate(() => localStorage.setItem('gnome:library:page:seed-page', String(Date.now())));
    await go(page, p);
    return data;
  }

  async function lint(page, label, phone) {
    const problems = await page.evaluate((isPhone) => {
      const out = [];
      const named = (el) =>
        (el.getAttribute('aria-label') ?? '').trim() ||
        (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).some((id) => document.getElementById(id)?.textContent?.trim()) ||
        (el.textContent ?? '').trim() ||
        [...(el.labels ?? [])].some((l) => l.textContent.trim());
      const sel = 'button, a[href], input:not([type=hidden]), [role="button"], [role="switch"], [role="combobox"], [role="radio"]';
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest('[aria-hidden="true"], [inert]') || el.getClientRects().length === 0) continue;
        if (!named(el)) out.push(`unnamed ${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
      }
      const ids = new Map();
      for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
      for (const [id, n] of ids) if (n > 1) out.push(`duplicate id #${id} ×${n}`);
      if (isPhone && document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page overflows horizontally (${document.documentElement.scrollWidth}px)`);
      const scroller = document.querySelector('main') ?? document.body;
      if (isPhone && scroller.scrollWidth > scroller.clientWidth + 1) out.push(`main overflows horizontally (${scroller.scrollWidth}px > ${scroller.clientWidth}px)`);
      return out;
    }, phone);
    if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  }

  async function shot(page, name) {
    await settle(page);
    const size = page.viewportSize();
    // The app's own scroller holds the page; grow the viewport to its content for a full-page picture.
    const h = await page.evaluate(() => {
      let el = document.querySelector('.library');
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el && el !== document.body ? el.scrollHeight + (innerHeight - el.clientHeight) : document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(h, size.height), 2400) });
    await settle(page);
    const suffix = ctx.browser === 'firefox' ? '-firefox' : '';
    await page.screenshot({ path: path.join(shotsDir(), `${name}${suffix}.png`), animations: 'disabled' });
    await page.setViewportSize(size);
  }

  const rows = (page) => page.locator('.days .row');
  /** A toast's title (the announcer repeats the text for screen readers, so scope to the toast region). */
  const toast = (page, text) => page.getByRole('region', { name: 'Notifications' }).getByText(text, { exact: true }).first();
  const summary = async (page) => (await page.locator('.summary').first().textContent())?.trim() ?? '';

  // ── Screenshots + lint: every page × theme × viewport (Firefox: dark desktop and light phone) ────────────────────
  const combos =
    ctx.browser === 'chromium'
      ? [['dark', 'desktop'], ['light', 'desktop'], ['dark', 'phone'], ['light', 'phone']]
      : [['dark', 'desktop'], ['light', 'phone']];
  for (const [theme, viewport] of combos) {
    await check(`screenshots + structure ${theme}/${viewport}`, async () => {
      const { context, page } = await newPage(theme, viewport);
      try {
        await seeded(page, '/history');
        await lint(page, 'history', viewport === 'phone');
        await shot(page, `history-${theme}-${viewport}`);
        await go(page, '/bookmarks');
        await lint(page, 'bookmarks', viewport === 'phone');
        await shot(page, `bookmarks-${theme}-${viewport}`);
        if (viewport === 'desktop') {
          await go(page, '/bookmarks?folder=b0000000-0000-4000-8000-00000000000a');
          await shot(page, `bookmarks-folder-${theme}-${viewport}`);
        }
        await go(page, '/downloads');
        await lint(page, 'downloads', viewport === 'phone');
        await shot(page, `downloads-${theme}-${viewport}`);
      } finally {
        await context.close();
      }
    });
  }

  // ── History ──────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const { context, page } = await newPage();
    try {
      const data = await seeded(page, '/history');
      await check('history: every visit listed, grouped by day, newest first', async () => {
        expect((await summary(page)).startsWith(`${data.history.length} visits`), `summary "${await summary(page)}"`);
        const first = (await page.locator('.day h2').first().textContent())?.trim();
        expect(first === 'Today', `first group "${first}"`);
        // Infinite scroll: scroll to the end until every visit is rendered.
        for (let i = 0; i < 10 && (await rows(page).count()) < data.history.length; i++) {
          await page.locator('.more button').scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(300);
        }
        const n = await rows(page).count();
        expect(n === data.history.length, `rendered ${n} of ${data.history.length}`);
        const times = await page.locator('.days .row time').evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute('datetime'))));
        expect(times.every((t, i) => i === 0 || times[i - 1] >= t), 'not newest first');
        return `${n} rows in ${await page.locator('.day').count()} days`;
      });

      await check('history: search matches title and URL; the query is kept in the address', async () => {
        await page.getByRole('searchbox', { name: 'Search history' }).fill('wikipedia rust');
        await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'wikipedia rust');
        await page.waitForTimeout(300);
        const urls = await page.locator('.days .row .url').allTextContents();
        const expected = data.history.filter((v) => /wikipedia/i.test(v.url + v.title) && /rust/i.test(v.url + v.title)).length;
        expect(urls.length === expected && urls.every((u) => /wikipedia/.test(u)), `${urls.length} rows, expected ${expected}`);
        await page.getByRole('searchbox', { name: 'Search history' }).fill('zzzz-nothing');
        await page.getByText('No matches').waitFor();
        await page.getByRole('searchbox', { name: 'Search history' }).fill('');
        await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));
      });

      await check('history: remove one visit, then Undo puts it back', async () => {
        await page.waitForTimeout(300);
        const before = (await dump(page, 'history')).length;
        const row = rows(page).first();
        const title = await row.locator('.title').textContent();
        await row.getByRole('button', { name: `Actions for ${title}` }).click();
        await page.getByRole('menuitem', { name: 'Remove this visit' }).click();
        await toast(page, 'Removed 1 visit').waitFor();
        expect((await dump(page, 'history')).length === before - 1, 'not removed');
        await page.getByRole('button', { name: 'Undo' }).click();
        await page.waitForFunction(async (n) => (await new Promise((r) => {
          const q = indexedDB.open('gnome');
          q.onsuccess = () => { const c = q.result.transaction('history').objectStore('history').count(); c.onsuccess = () => { q.result.close(); r(c.result); }; };
        })) === n, before);
      });

      await check('history: select two visits and remove them', async () => {
        const before = (await dump(page, 'history')).length;
        await rows(page).nth(1).locator('input.pick').check();
        await rows(page).nth(2).locator('input.pick').check();
        await page.getByText('2 selected').waitFor();
        await page.getByRole('region', { name: 'Selected visits' }).getByRole('button', { name: 'Remove' }).click();
        await toast(page, 'Removed 2 visits').waitFor();
        expect((await dump(page, 'history')).length === before - 2, 'not removed');
      });

      await check('history: "remove every visit to this page" removes all visits of that URL', async () => {
        const all = await dump(page, 'history');
        const url = 'https://news.ycombinator.com/';
        const n = all.filter((v) => v.url === url).length;
        expect(n > 1, `seed has ${n} visits of ${url}`);
        await page.getByRole('searchbox', { name: 'Search history' }).fill('news.ycombinator.com/');
        await page.waitForTimeout(400);
        const row = page.locator('.days .row', { has: page.locator('.url', { hasText: /^news\.ycombinator\.com$/ }) }).first();
        await row.getByRole('button', { name: /^Actions for/ }).click();
        await page.getByRole('menuitem', { name: 'Remove every visit to this page' }).click();
        await toast(page, `Removed ${n} visits to this page`).waitFor();
        expect(!(await dump(page, 'history')).some((v) => v.url === url), 'visits left');
        await page.getByRole('searchbox', { name: 'Search history' }).fill('');
        return `${n} visits`;
      });

      await check('history: Clear history → Last hour removes only the last hour', async () => {
        const now = Date.now();
        const before = await dump(page, 'history');
        await page.getByRole('button', { name: 'Clear history…' }).click();
        const dlg = page.getByRole('dialog', { name: 'Clear history' });
        await dlg.getByRole('radio', { name: 'Last hour' }).check();
        await dlg.getByRole('button', { name: 'Clear history' }).click();
        await toast(page, 'History cleared').waitFor();
        const after = await dump(page, 'history');
        const expected = before.filter((v) => v.visitedAt < now - 3600_000 - 5000).length;
        expect(after.every((v) => v.visitedAt < now - 3600_000 + 5000) && Math.abs(after.length - expected) <= 1, `${after.length} left, expected ≈${expected}`);
      });
    } finally {
      await context.close();
    }
  }

  await check('history: "History is off" notice; Turn on switches browser.history.enabled', async () => {
    const { context, page } = await newPage('dark', 'desktop', { browser: { history: { enabled: false, retentionDays: 90 } } });
    try {
      await open(page, '/history');
      await page.getByText('History is off', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Turn on' }).click();
      await page.getByText('History is off', { exact: true }).waitFor({ state: 'detached' });
      const on = await page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.browser.history.enabled);
      expect(on === true, 'setting not saved');
    } finally {
      await context.close();
    }
  });

  // ── Bookmarks ────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const { context, page } = await newPage();
    try {
      await seeded(page, '/bookmarks');
      const list = () => page.locator('.list .row .title');
      await check('bookmarks: the bar (root) in position order, tree with nested folders', async () => {
        const titles = await list().allTextContents();
        expect(titles.join('|') === 'Svelte docs|MDN Web Docs|Reading list|Projects|Kitchen|Hacker News', titles.join('|'));
        const tree = await page.getByRole('navigation', { name: 'Bookmark folders' }).locator('.label').allTextContents();
        expect(tree.join('|') === 'Favorites|Bookmarks bar|Reading list|Projects|Raspberry Pi|Kitchen', tree.join('|'));
      });

      await check('bookmarks: open a folder (address, breadcrumb), Back returns to the bar', async () => {
        await page.locator('.list .row', { hasText: 'Projects' }).locator('a.main').click();
        await page.waitForURL(/folder=/);
        await page.locator('.list .row', { hasText: 'Raspberry Pi' }).locator('a.main').click();
        await page.getByRole('heading', { name: 'Raspberry Pi' }).waitFor();
        const crumbs = await page.getByRole('navigation', { name: 'Folder path' }).locator('button').allTextContents();
        expect(crumbs.join('|') === 'Bookmarks bar|Projects', crumbs.join('|'));
        expect((await list().allTextContents()).length === 3, 'Raspberry Pi has 3 items');
        await page.goBack();
        await page.getByRole('heading', { name: 'Projects' }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Bookmarks bar' }).waitFor();
      });

      await check('bookmarks: the editor refuses javascript: URLs and adds https:// to a bare address', async () => {
        await page.getByRole('button', { name: 'Add bookmark' }).first().click();
        const dlg = page.getByRole('dialog', { name: 'Add bookmark' });
        await dlg.getByLabel('Address').fill('javascript:alert(document.cookie)');
        await dlg.getByRole('button', { name: 'Add bookmark' }).click();
        await dlg.getByText('Enter a valid web address that starts with http:// or https://.').waitFor();
        // A host the URL parser accepts but the sync server refuses (it would block bookmark sync).
        await dlg.getByLabel('Address').fill('http://a$b.example/');
        await dlg.getByRole('button', { name: 'Add bookmark' }).click();
        await page.waitForTimeout(500);
        expect(await dlg.isVisible(), 'the editor closed: http://a$b.example/ was accepted');
        await dlg.getByText('Enter a valid web address that starts with http:// or https://.').waitFor();
        expect(!(await dump(page, 'bookmarks')).some((x) => (x.url ?? '').includes('a$b')), 'http://a$b.example/ was stored');
        await dlg.getByLabel('Address').fill('openstreetmap.org/#map=13/52.52/13.40');
        await dlg.getByLabel('Name').fill('Berlin map');
        await dlg.getByRole('button', { name: 'Add bookmark' }).click();
        await dlg.waitFor({ state: 'detached' });
        const b = (await dump(page, 'bookmarks')).find((x) => x.title === 'Berlin map');
        expect(b?.url === 'https://openstreetmap.org/#map=13/52.52/13.40' && b.parentId === 'root' && typeof b.syncPending === 'number', JSON.stringify(b));
        expect((await list().allTextContents()).at(-1) === 'Berlin map', 'not appended at the end');
      });

      await check('bookmarks: edit moves a bookmark into a folder; the star makes it a favorite', async () => {
        const row = page.locator('.list .row', { hasText: 'Berlin map' });
        await row.getByRole('button', { name: 'Actions for Berlin map' }).click();
        await page.getByRole('menuitem', { name: 'Edit…' }).click();
        const dlg = page.getByRole('dialog', { name: 'Edit bookmark' });
        await dlg.getByRole('combobox').click();
        await page.getByRole('option', { name: /Reading list/ }).click();
        await dlg.getByRole('button', { name: 'Save' }).click();
        await dlg.waitFor({ state: 'detached' });
        await page.locator('.list .row', { hasText: 'Berlin map' }).waitFor({ state: 'detached' });
        await page.getByRole('navigation', { name: 'Bookmark folders' }).getByRole('button', { name: /Reading list/ }).click();
        await page.getByRole('heading', { name: 'Reading list' }).waitFor();
        await page.getByRole('button', { name: 'Add Berlin map to favorites' }).click();
        await page.getByRole('button', { name: 'Remove Berlin map from favorites' }).waitFor();
        await page.getByRole('navigation', { name: 'Bookmark folders' }).getByRole('button', { name: /Favorites/ }).click();
        await page.getByRole('heading', { name: 'Favorites' }).waitFor();
        const favs = await list().allTextContents();
        expect(favs.includes('Berlin map') && favs.includes('Svelte docs'), favs.join('|'));
        const b = (await dump(page, 'bookmarks')).find((x) => x.title === 'Berlin map');
        expect(b.favorite === true, 'favorite not stored');
      });

      await check('bookmarks: Move up reorders the bar (keyboard-accessible menu)', async () => {
        await page.getByRole('navigation', { name: 'Bookmark folders' }).getByRole('button', { name: /Bookmarks bar/ }).click();
        await page.getByRole('heading', { name: 'Bookmarks bar' }).waitFor();
        await page.locator('.list .row', { hasText: 'Hacker News' }).getByRole('button', { name: 'Actions for Hacker News' }).click();
        await page.getByRole('menuitem', { name: 'Move up' }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('.list .row .title')].map((e) => e.textContent).indexOf('Hacker News') === 4);
      });

      await check('bookmarks: drag and drop moves an item within the bar', async () => {
        // Drag "Kitchen" above "Svelte docs" (the first row: drop on its top edge).
        await page.waitForTimeout(400);
        const first = () => page.evaluate(() => document.querySelector('.list .row .title')?.textContent);
        let attempts = 0;
        while (attempts < 2 && (await first()) !== 'Kitchen') {
          attempts++;
          const src = page.locator('.list .row', { hasText: 'Kitchen' }).locator('a.main');
          await src.hover();
          await src.dragTo(page.locator('.list .row', { hasText: 'Svelte docs' }), { targetPosition: { x: 200, y: 4 } });
          await page.waitForFunction(() => document.querySelector('.list .row .title')?.textContent === 'Kitchen', null, { timeout: 3000 }).catch(() => {});
        }
        if ((await first()) !== 'Kitchen') {
          const dbg = await page.evaluate(() => [...document.querySelectorAll('.list .row .title')].map((e) => e.textContent));
          throw new Error(`Kitchen did not move to the top: ${JSON.stringify(dbg)}`);
        }
        const stored = (await dump(page, 'bookmarks')).filter((b) => b.parentId === 'root' && !b.deleted).sort((a, b) => a.position - b.position);
        expect(stored[0]?.title === 'Kitchen', 'order not stored');
        if (attempts > 1) return `moved on attempt ${attempts}`;
        return (await list().allTextContents()).join(' · ');
      });

      await check('bookmarks: search across folders shows each match with its folder path', async () => {
        await page.getByRole('searchbox', { name: 'Search bookmarks' }).fill('raspberry');
        await page.getByRole('heading', { name: 'Results for “raspberry”' }).waitFor();
        await page.waitForTimeout(300);
        const titles = await list().allTextContents();
        expect(titles.includes('Raspberry Pi') && titles.includes('Raspberry Pi OS images'), titles.join('|'));
        const where = await page.locator('.list .row .where').allTextContents();
        expect(where.some((w) => w === 'Bookmarks bar › Projects › Raspberry Pi'), where.join('|'));
        await page.getByRole('searchbox', { name: 'Search bookmarks' }).fill('');
      });

      await check('bookmarks: deleting a folder takes its contents; Undo restores them', async () => {
        const before = (await dump(page, 'bookmarks')).filter((b) => !b.deleted).length;
        await page.locator('.list .row', { hasText: 'Projects' }).getByRole('button', { name: 'Actions for Projects' }).click();
        await page.getByRole('menuitem', { name: 'Delete folder' }).click();
        await toast(page, 'Deleted “Projects”').waitFor();
        const after = (await dump(page, 'bookmarks')).filter((b) => !b.deleted).length;
        expect(after === before - 7, `${before} → ${after}`);
        await page.locator('.list .row', { hasText: 'Projects' }).waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Undo' }).click();
        await page.locator('.list .row', { hasText: 'Projects' }).waitFor();
        expect((await dump(page, 'bookmarks')).filter((b) => !b.deleted).length === before, 'not restored');
      });

      await check('bookmarks: import a real Firefox export into a new folder', async () => {
        await page.getByRole('button', { name: 'Import and export' }).click();
        await page.getByRole('menuitem', { name: 'Import from file…' }).click();
        const dlg = page.getByRole('dialog', { name: 'Import bookmarks' });
        await dlg.getByLabel('Bookmarks file').setInputFiles(FIREFOX_EXPORT);
        await dlg.getByText('8 bookmarks in 4 folders.').waitFor();
        await dlg.getByText('1 is not a web address').waitFor();
        await dlg.getByLabel('Folder name').fill('From Firefox');
        await dlg.getByRole('button', { name: 'Import' }).click();
        await toast(page, 'Imported 7 bookmarks').waitFor();
        await page.getByRole('heading', { name: 'From Firefox' }).waitFor();
        const titles = await list().allTextContents();
        expect(titles.join('|') === 'Example & query|Bookmarks Toolbar|Other Bookmarks', titles.join('|'));
        const all = await dump(page, 'bookmarks');
        expect(all.some((b) => b.title === 'Gartenzwerg – Wikipedia') && !all.some((b) => b.url?.startsWith('javascript:')), 'nested or bookmarklet wrong');
      });

      await check('bookmarks: export writes a Netscape file with the bar and every folder', async () => {
        await page.getByRole('button', { name: 'Import and export' }).click();
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export to file' }).click()]);
        const file = path.join(ctx.runDir, `export-${ctx.browser}.html`);
        await download.saveAs(file);
        const html = readFileSync(file, 'utf8');
        expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'), 'no doctype');
        for (const t of ['PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar', '>Raspberry Pi</H3>', 'HREF="https://svelte.dev/docs/svelte/overview"', '>Example &amp; query</A>']) {
          expect(html.includes(t), `missing ${t}`);
        }
        return download.suggestedFilename();
      });

      await check('bookmarks: a change in one GNOME tab shows in another without reloading', async () => {
        await page.getByRole('navigation', { name: 'Bookmark folders' }).getByRole('button', { name: /Bookmarks bar/ }).click();
        await page.getByRole('heading', { name: 'Bookmarks bar' }).waitFor();
        const other = await context.newPage();
        await other.goto(ctx.stack.appOrigin + '/bookmarks', { waitUntil: 'networkidle' });
        await other.locator('.list .row').first().waitFor();
        await page.getByRole('button', { name: 'New folder' }).click();
        const dlg = page.getByRole('dialog', { name: 'New folder' });
        await dlg.getByLabel('Name').fill('Made in tab one');
        await dlg.getByRole('button', { name: 'Create folder' }).click();
        await other.locator('.list .row', { hasText: 'Made in tab one' }).waitFor({ timeout: 5000 });
        await other.close();
      });
    } finally {
      await context.close();
    }
  }

  // ── Downloads ────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const { context, page } = await newPage();
    try {
      const data = await seeded(page, '/downloads');
      await check('downloads: every state with size, source, engine and live progress', async () => {
        const n = await page.locator('.days .row').count();
        expect(n === data.downloads.length, `${n} rows`);
        for (const t of ['Completed', 'Failed', 'Cancelled', 'No longer followed']) await page.locator('.days .row').getByText(t, { exact: true }).first().waitFor();
        const bar = page.getByRole('progressbar', { name: /2026-10-28-raspios/ });
        const now = await bar.getAttribute('aria-valuenow');
        expect(now !== null && Math.abs(Number(now) - 221_184_000 / 512_000_000) < 0.01, `aria-valuenow ${now}`);
        await page.getByText('The connection was reset by the server.').waitFor();
        expect((await summary(page)).includes('1 running'), await summary(page));
      });

      await check('downloads: filter by name or address', async () => {
        await page.getByRole('searchbox', { name: 'Filter downloads' }).fill('debian iso');
        await page.waitForTimeout(150);
        const names = await page.locator('.days .row .name').allTextContents();
        expect(names.join('|') === 'debian-13.2.0-amd64-netinst.iso', names.join('|'));
        await page.getByRole('searchbox', { name: 'Filter downloads' }).fill('');
      });

      await check('downloads: remove one from the list; Clear list keeps the running one', async () => {
        await page.locator('.days .row', { hasText: 'Gartenzwerg.png' }).getByRole('button', { name: 'Actions for Gartenzwerg.png' }).click();
        await page.getByRole('menuitem', { name: 'Remove from list' }).click();
        await page.locator('.days .row', { hasText: 'Gartenzwerg.png' }).waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Clear list' }).click();
        await toast(page, 'Downloads list cleared').waitFor();
        const left = await dump(page, 'downloads');
        expect(left.length === 1 && left[0].state === 'in_progress', JSON.stringify(left.map((d) => d.state)));
      });

      await check('downloads: an unfinished download of a closed app page becomes "No longer followed"', async () => {
        await page.evaluate(() => localStorage.setItem('gnome:library:page:seed-page', String(Date.now() - 10 * 60_000)));
        await open(page, '/downloads');
        await page.locator('.days .row').getByText('No longer followed', { exact: true }).waitFor();
        const [d] = await dump(page, 'downloads');
        expect(d.state === 'untracked', d.state);
      });
    } finally {
      await context.close();
    }
  }

  await check('downloads: "The downloads list is off" notice; Turn on switches browser.downloads.track', async () => {
    const { context, page } = await newPage('dark', 'desktop', { browser: { downloads: { track: false, openPanelOnStart: true, keepDays: 30 } } });
    try {
      await open(page, '/downloads');
      await page.getByText('The downloads list is off').waitFor();
      await page.getByRole('button', { name: 'Turn on' }).click();
      await page.getByText('The downloads list is off').waitFor({ state: 'detached' });
    } finally {
      await context.close();
    }
  });

  await check('Settings → Privacy → Clear browsing data uses the library clearers (history, last hour)', async () => {
    const { context, page } = await newPage();
    try {
      const data = await seeded(page, '/history');
      await go(page, '/settings/privacy');
      await page.getByRole('button', { name: 'Clear data…' }).click();
      const dlg = page.locator('dialog[open]');
      await dlg.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Last hour' }).click();
      await dlg.getByRole('button', { name: 'Clear data' }).click();
      await toast(page, 'Browsing data cleared').waitFor();
      const left = await dump(page, 'history');
      const cut = Date.now() - 3600_000;
      expect(left.length < data.history.length && left.every((v) => v.visitedAt < cut + 5000), `${left.length} left`);
    } finally {
      await context.close();
    }
  });

  await check('history survives an app reload (privacy.clearHistoryOnExit off)', async () => {
    const { context, page } = await newPage();
    try {
      const data = await seeded(page, '/history');
      expect((await dump(page, 'history')).length === data.history.length, 'seed missing');
      await open(page, '/history');
      await page.waitForTimeout(3000);
      const n = (await dump(page, 'history')).length;
      if (n !== data.history.length) {
        throw new Error(`${n} of ${data.history.length} visits left after a reload: src/browser/browser.svelte.ts (lane c) calls history.clear() from its onLibrary() listener, which runs before #freshStartApplied is computed`);
      }
    } finally {
      await context.close();
    }
  });

  await check('no page errors or console errors', async () => {
    if (errors.length) throw new Error(errors.slice(0, 8).join(' | '));
  });
  await browser.close();
}

if (isMain(import.meta.url)) await runStandalone(run, 'library-pages');
