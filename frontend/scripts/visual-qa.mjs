#!/usr/bin/env node
/**
 * Visual QA for the app shell (docs/DESIGN.md): screenshots of the key surfaces in the dark and light themes at
 * desktop (1440×900) and phone (390×844) sizes, plus automated checks that run on every screen:
 *   - no uncaught page errors; no console errors except the browser's own "Failed to load resource" line for /api/*
 *     while no backend runs (GNOME degrades quietly: one request per page load, no retry storm, no stack traces);
 *   - no horizontal overflow on phones; every button/link has an accessible name; no duplicate element ids;
 *   - a few interactions behave (palette theme command, context menu keyboard close + focus restore);
 *   - robustness: the saved theme is applied before the app bundle runs, damaged settings storage is repaired, router
 *     edge cases (trailing/double slashes, malformed escapes, back/forward, query/hash), the browser layer stays
 *     mounted; focus moves to the new page after keyboard navigation and through the hidden rail's keyboard path;
 *   - the design-system gallery (dev/gallery.html): every component's keyboard path, touch hit targets, a
 *     10,000-card VirtualGrid scroll benchmark and cold-load layout shift (scripts/qa-components.mjs).
 *
 * Usage (from frontend/):  npm run dev -- --port 21000 --strictPort   then   npm run qa:visual
 * Against a production build (vite preview or gnome-server serving dist/), set GNOME_QA_URL: scenarios that need the
 * dev server (the component gallery, the benchmark, the IndexedDB fixtures) are skipped or limited to the app.
 * Env: GNOME_QA_URL       app URL (default http://127.0.0.1:21000)
 *      GNOME_QA_OUT       output directory (default ../docs/screenshots/foundation)
 *      GNOME_QA_BROWSER   chromium (default) or firefox; screenshots from Firefox get a "-firefox" suffix
 *      GNOME_QA_EXECUTABLE  browser executable (default: the build pinned playwright-core installs in
 *                         ~/.cache/ms-playwright — playwright-core is pinned to 1.64.0 = Chromium r1248 / Firefox r1555)
 *      GNOME_QA_ONLY      comma-separated scenario names to run (default: all)
 * Exits with status 1 when a check fails.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import { componentScenarios } from './qa-components.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BASE = (process.env.GNOME_QA_URL ?? 'http://127.0.0.1:21000').replace(/\/$/, '');
const OUT = resolve(process.env.GNOME_QA_OUT ?? join(HERE, '../../docs/screenshots/foundation'));
const ONLY = (process.env.GNOME_QA_ONLY ?? '').split(',').filter(Boolean);
const BROWSER = process.env.GNOME_QA_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const SUFFIX = BROWSER === 'firefox' ? '-firefox' : '';
const SETTINGS_KEY = 'gnome:settings:v1';

/**
 * Browser warnings that are not defects, matched exactly (Firefox; worklist A8, measured by wb2p2:engine 2026-11-19):
 * - the engine iframe's `allow` list keeps `autoplay` and `clipboard-write` because Chromium enforces them (the engine
 *   host's tab frames can only get what the engine iframe delegates); Firefox implements neither and says so once per
 *   iframe. Leaving them out in Firefox would change nothing today and silently block them once Firefox supports them.
 * - "Layout was forced before the page was fully loaded" from documents on the proxy origin (the engine host and the
 *   proxied page measure layout while loading): Firefox's own advice, not an error, and not from GNOME's UI.
 * They are counted and listed, never failures; any other warning still fails the run.
 */
// Firefox reports them as `[JavaScript Warning: "<message>" {file: "<url>" line: N}]`.
const BENIGN_WARNINGS = [
  // the app's engine iframe keeps these features delegated for Chromium (ENGINE-PROTOCOL §6.14); Firefox skips them.
  // The file is the production app bundle, or embed.ts (which builds that iframe) under the Vite dev server.
  /^\[JavaScript Warning: "Feature Policy: Skipping unsupported feature name “(autoplay|clipboard-write)”\." \{file: "[^"]*\/(?:assets\/app-[\w-]+\.js|src\/browser\/engine\/embed\.ts)" line: \d+\}\]$/,
  // only from documents that are not on the app origin (BASE): the engine host and proxied pages
  new RegExp(
    `^\\[JavaScript Warning: "Layout was forced before the page was fully loaded\\. If stylesheets are not yet loaded this may cause a flash of unstyled content\\." \\{file: "(?!${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})[^"]*" line: \\d+\\}\\]$`,
  ),
];
const benign = [];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

/** A settings mirror as the app writes it (the app fills every missing key from its defaults). */
function mirror(appearance) {
  const theme = appearance.theme ?? 'dark';
  return JSON.stringify({
    v: 1,
    updatedAt: Date.now(),
    settings: { version: 1, appearance },
    boot: { theme, motion: 'normal', vars: {}, dark: {}, light: {}, classes: [], meta: { dark: '#0f0f0d', light: '#f5f1e8' } },
  });
}

const failures = [];
const notes = [];

async function settle(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(350);
}

async function shot(page, name) {
  await settle(page);
  const file = join(OUT, `${name}${SUFFIX}.png`);
  await page.screenshot({ path: file, animations: 'disabled' });
  return file;
}

/** Structural checks for the current screen. */
async function lint(page, label, phone) {
  const r = await page.evaluate((isPhone) => {
    const problems = [];
    const named = (el) =>
      (el.getAttribute('aria-label') ?? '').trim() ||
      (el.getAttribute('aria-labelledby') ?? '').trim() ||
      (el.textContent ?? '').trim() ||
      el.querySelector('img[alt]:not([alt=""])');
    for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], [role="option"]')) {
      if (el.closest('[aria-hidden="true"], [inert]') || el.getClientRects().length === 0) continue;
      if (!named(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}.${el.className}`);
    }
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) problems.push(`duplicate id #${id} ×${n}`);
    if (isPhone) {
      const main = document.querySelector('main');
      if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('document overflows horizontally');
      if (main && !main.hidden && main.scrollWidth > main.clientWidth + 1) problems.push(`main overflows horizontally (${main.scrollWidth} > ${main.clientWidth})`);
    }
    return problems;
  }, phone);
  for (const p of r) failures.push(`${label}: ${p}`);
}

async function newPage(browser, { theme, viewport, sidebar = 'auto', appearance = {}, contextOptions = {} }) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: 'no-preference',
    ...contextOptions,
  });
  await context.addInitScript(
    ([key, value]) => {
      try {
        if (!sessionStorage.getItem('qa:seeded')) {
          localStorage.setItem(key, value);
          sessionStorage.setItem('qa:seeded', '1');
        }
      } catch {
        /* storage blocked */
      }
    },
    [SETTINGS_KEY, mirror({ theme, sidebar, ...appearance })],
  );
  const page = await context.newPage();
  const label = () => `${theme}/${viewport} ${page.url().replace(BASE, '') || '/'}`;
  page.on('pageerror', (e) => failures.push(`${label()}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const loc = m.location()?.url ?? '';
    const expected = m.type() === 'error' && /Failed to load resource/.test(m.text()) && /\/api\//.test(loc);
    if (expected) notes.push(`${label()}: (expected, no backend) ${m.text()} ${loc.replace(BASE, '')}`);
    else if (m.type() === 'warning' && BENIGN_WARNINGS.some((re) => re.test(m.text()))) benign.push(`${label()}: ${m.text().slice(0, 140)}`);
    else failures.push(`${label()}: console.${m.type()}: ${m.text()}`);
  });
  return { context, page };
}

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('.shell');
  // The virtual pointer starts at (0,0), over the tab strip's Home mark, whose tooltip then shows in every
  // screenshot; park it over the stage instead (scenarios that need a hover move it themselves).
  const vp = page.viewportSize();
  if (vp) await page.mouse.move(Math.round(vp.width / 2), Math.round((vp.height * 2) / 3));
}

/** The IndexedDB fixtures import app modules by source path, which only the Vite dev server serves. */
async function devModules(page, scenario) {
  const res = await page.request.get(`${BASE}/src/lib/idb.ts`).catch(() => null);
  const ok = !!res && res.ok();
  if (!ok) notes.push(`${scenario}: app sources not served (production build): skipped`);
  return ok;
}

const scenarios = {
  async home(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    await page.waitForSelector('.tiles .tile');
    await lint(page, `${theme}/${viewport} home`, viewport === 'phone');
    await shot(page, `home-${theme}-${viewport}`);
    await context.close();
  },

  async stub(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/games');
    await page.waitForSelector('h1:has-text("Games")');
    if ((await page.title()) !== 'Games · GNOME') failures.push(`stub: unexpected title ${await page.title()}`);
    await lint(page, `${theme}/${viewport} games`, viewport === 'phone');
    await shot(page, `stub-games-${theme}-${viewport}`);
    await context.close();
  },

  async palette(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    await page.keyboard.press('Control+K');
    await page.waitForSelector('dialog.palette[open] [role="option"]');
    await lint(page, `${theme}/${viewport} palette`, viewport === 'phone');
    await shot(page, `palette-${theme}-${viewport}`);
    await page.keyboard.type('side');
    await page.waitForSelector('dialog.palette [role="option"] mark');
    await shot(page, `palette-search-${theme}-${viewport}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.palette:not([open])', { state: 'attached' });
    await context.close();
  },

  async contextmenu(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    const tile = page.locator('.tiles .tile').first();
    await tile.click({ button: 'right' });
    await page.waitForSelector('[role="menu"]');
    await lint(page, `${theme}/${viewport} context menu`, viewport === 'phone');
    await shot(page, `contextmenu-${theme}-${viewport}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached' });
    await context.close();
  },

  async rail(browser, theme, viewport) {
    if (viewport === 'phone') {
      // Under 760px the rail becomes the bottom bar + "More" sheet.
      const { context, page } = await newPage(browser, { theme, viewport });
      await open(page, '/history');
      await page.getByRole('button', { name: 'More' }).click();
      await page.waitForSelector('dialog.sheet[open] .more');
      await lint(page, `${theme}/${viewport} more sheet`, true);
      await shot(page, `more-sheet-${theme}-${viewport}`);
      await context.close();
      return;
    }
    for (const sidebar of ['expanded', 'compact']) {
      const { context, page } = await newPage(browser, { theme, viewport, sidebar });
      await open(page, '/history');
      await page.waitForSelector(`.shell[data-rail="${sidebar}"]`);
      if (sidebar === 'compact') {
        await page.locator('nav.rail a[href="/bookmarks"]').hover();
        await page.waitForSelector('.tooltip');
      }
      await lint(page, `${theme}/${viewport} rail ${sidebar}`, false);
      await shot(page, `rail-${sidebar}-${theme}-${viewport}`);
      await context.close();
    }
  },

  async railmenu(browser, theme, viewport) {
    if (viewport === 'phone') return;
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    // The rail's own context menu (anywhere on the rail; here on its search button).
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /^Search/ }).click({ button: 'right' });
    await page.waitForSelector('[role="menu"] [role="menuitemradio"]');
    await page.getByRole('menuitem', { name: 'Position' }).hover();
    await page.waitForSelector('[role="menu"] >> nth=1');
    await shot(page, `rail-menu-${theme}-${viewport}`);
    // Choosing "Compact" in the menu applies the setting.
    await page.getByRole('menuitemradio', { name: 'Compact' }).click();
    await page.waitForSelector('.shell[data-rail="compact"]');
    await context.close();
  },

  async dialog(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    await page.getByRole('button', { name: 'Add link' }).click();
    await page.waitForSelector('dialog.dialog[open] input');
    await page.keyboard.type('example.org');
    await lint(page, `${theme}/${viewport} dialog`, viewport === 'phone');
    await shot(page, `dialog-${theme}-${viewport}`);
    await page.keyboard.press('Escape');
    await context.close();
  },

  async toast(browser, theme, viewport) {
    if (viewport === 'phone') return;
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    await page.locator('.tiles .tile').nth(2).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await page.waitForSelector('.toast');
    await page.mouse.move(720, 600); // off the toast (which pauses while hovered) and off any tooltip target
    await shot(page, `toast-${theme}-${viewport}`);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.tiles .tile:not(.add)').length === 6);
    await context.close();
  },

  /** Home search → the browser view: the address opens in the active browser tab (address bar and tab strip). */
  async browse(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    await page.getByRole('combobox', { name: 'Search or enter address' }).fill('example.com');
    await page.waitForSelector('[role="listbox"] [role="option"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.pathname === '/browse' && document.title === 'Browser · GNOME');
    const address = page.getByRole('combobox', { name: 'Address and search bar' });
    await page.waitForFunction((el) => /^(https?:\/\/)?example\.com\b/.test(el.value), await address.elementHandle());
    if (viewport === 'desktop') {
      const tab = page.getByRole('tab', { selected: true });
      if (!/example\.com/.test((await tab.getAttribute('title')) ?? '')) failures.push(`browse: the active tab does not show example.com (${await tab.getAttribute('title')})`);
      if (!(await page.$('.shell[data-rail="compact"]'))) failures.push('browse: rail is not compact on the browser view (auto mode)');
    }
    await lint(page, `${theme}/${viewport} browse`, viewport === 'phone');
    await shot(page, `browse-${theme}-${viewport}`);
    await context.close();
  },

  async railright(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    const { context, page } = await newPage(browser, { theme, viewport, appearance: { sidebarPosition: 'right' } });
    await open(page, '/vpn');
    await page.waitForSelector('.shell[data-side="right"] nav.rail.right');
    // The rail sits on the right edge below the chrome, its hairline on the inner (left) edge (DESIGN.md §9.1).
    const ok = await page.evaluate(() => {
      const nav = document.querySelector('nav.rail');
      const rail = nav?.getBoundingClientRect();
      const chrome = document.querySelector('.chrome-slot')?.getBoundingClientRect();
      const cs = nav && getComputedStyle(nav);
      return !!rail && !!chrome && !!cs && rail.right >= window.innerWidth - 1 && rail.top >= chrome.bottom - 1 &&
        cs.borderLeftWidth === '1px' && cs.borderRightWidth === '0px';
    });
    if (!ok) failures.push('railright: rail is not on the right below the chrome, or its hairline is not on its inner (left) edge');
    await shot(page, `rail-right-${theme}-${viewport}`);
    await context.close();
  },

  /** Home with real data: history and bookmarks written through the app's own IndexedDB wrapper (dev server). */
  async homedata(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    if (!(await devModules(page, 'homedata'))) return context.close();
    const seeded = await page.evaluate(async () => {
      const idb = await import('/src/lib/idb.ts');
      const now = Date.now();
      const visits = [
        ['https://en.wikipedia.org/wiki/Gnome', 'Gnome — Wikipedia', 4],
        ['https://www.theguardian.com/international', 'News, sport and opinion from the Guardian', 35],
        ['https://github.com/MercuryWorkshop/scramjet', 'MercuryWorkshop/scramjet: interception-based web proxy', 90],
        ['https://news.ycombinator.com/', 'Hacker News', 180],
        ['https://www.bbc.co.uk/weather', 'BBC Weather', 1440],
        ['https://developer.mozilla.org/en-US/docs/Web/CSS/color-mix', 'color-mix() — CSS | MDN', 2900],
      ];
      await idb.idbPutMany('history', visits.map(([url, title, minutes]) => ({ id: idb.uuid(), url, title, visitedAt: now - minutes * 60_000 })));
      const marks = [
        ['https://archive.org/', 'Internet Archive', true],
        ['https://www.openstreetmap.org/', 'OpenStreetMap', true],
        ['https://svelte.dev/docs', 'Svelte docs', true],
        ['https://fonts.google.com/specimen/Fraunces', 'Fraunces — a soft, wonky serif', false],
      ];
      await idb.idbPutMany('bookmarks', marks.map(([url, title, favorite], i) => ({
        id: idb.uuid(), parentId: null, kind: 'bookmark', title, url, position: i, createdAt: now, updatedAt: now - i * 1000, deleted: false, favorite,
      })));
      return (await idb.idbCount('history')) === 6 && (await idb.idbCount('bookmarks')) === 4;
    });
    if (!seeded) failures.push('homedata: IndexedDB seeding failed');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('section[aria-labelledby="home-recent"] [role="listitem"], section[aria-labelledby="home-recent"] li');
    await lint(page, `${theme}/${viewport} home with data`, viewport === 'phone');
    if (viewport === 'phone') await page.locator('#home-recent').scrollIntoViewIfNeeded();
    await shot(page, `home-data-${theme}-${viewport}`);
    // Typing in the search box suggests matching history and bookmarks.
    await page.getByRole('combobox', { name: 'Search or enter address' }).fill('wiki');
    await page.waitForSelector('[role="listbox"] [role="option"]:has-text("Gnome — Wikipedia")');
    await shot(page, `home-suggestions-${theme}-${viewport}`);
    await context.close();
  },

  /** The real-browser IndexedDB wrapper: put/get/query/count/delete/clear and kv. */
  async idb(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/about');
    if (!(await devModules(page, 'idb'))) return context.close();
    const problems = await page.evaluate(async () => {
      const idb = await import('/src/lib/idb.ts');
      const out = [];
      const expect = (cond, msg) => cond || out.push(msg);
      const t = Date.now();
      const rows = Array.from({ length: 30 }, (_, i) => ({ id: `qa-${i}`, url: `https://s${i % 5}.example/`, title: `S${i}`, visitedAt: t - i * 1000 }));
      await idb.idbPutMany('history', rows);
      expect((await idb.idbGet('history', 'qa-3'))?.title === 'S3', 'get');
      const recent = await idb.idbQuery('history', { index: 'visitedAt', direction: 'prev', limit: 5 });
      expect(recent.map((r) => r.id).join() === 'qa-0,qa-1,qa-2,qa-3,qa-4', `query order ${recent.map((r) => r.id)}`);
      const filtered = await idb.idbQuery('history', { index: 'url', query: IDBKeyRange.only('https://s2.example/') });
      expect(filtered.length === 6, `index range ${filtered.length}`);
      expect((await idb.idbCount('history')) === 30, 'count');
      await idb.idbDelete('history', 'qa-0');
      expect((await idb.idbGet('history', 'qa-0')) === undefined, 'delete');
      await idb.idbTransaction(['history', 'kv'], (store) => {
        store('history').delete('qa-1');
        store('kv').put({ ok: true }, 'qa:tx');
      });
      expect((await idb.kvGet('qa:tx'))?.ok === true && (await idb.idbCount('history')) === 28, 'transaction');
      await idb.kvSet('qa:blob', new Blob(['hello'], { type: 'text/plain' }));
      expect((await (await idb.kvGet('qa:blob')).text()) === 'hello', 'kv blob');
      await idb.idbClear('history');
      expect((await idb.idbCount('history')) === 0, 'clear');
      const settingsRow = await idb.idbGet('settings', 'current');
      const { CURRENT_SETTINGS_VERSION } = await import('/src/settings/schema.ts');
      expect(!!settingsRow && settingsRow.version === CURRENT_SETTINGS_VERSION, 'settings persisted by the store');
      return out;
    });
    for (const p of problems) failures.push(`idb: ${p}`);
    await context.close();
  },

  /** Scroll position is restored when going back, and new pages start at the top. */
  async scroll(browser, theme, viewport) {
    if (viewport !== 'phone' || theme === 'light') return;
    const { context, page } = await newPage(browser, { theme, viewport });
    await page.setViewportSize({ width: 390, height: 560 }); // short screen: Home scrolls
    await open(page, '/');
    await page.waitForSelector('.tiles .tile');
    const target = await page.evaluate(() => {
      const main = document.querySelector('main');
      main.scrollTop = Math.min(200, main.scrollHeight - main.clientHeight);
      return main.scrollTop;
    });
    if (target < 100) failures.push(`scroll: Home does not scroll enough to test (${target})`);
    await page.waitForTimeout(100);
    await page.getByRole('link', { name: 'Games' }).click();
    await page.waitForFunction(() => document.title === 'Games · GNOME');
    const top = await page.evaluate(() => document.querySelector('main').scrollTop);
    if (top !== 0) failures.push(`scroll: new page did not start at the top (${top})`);
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/');
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => document.querySelector('main').scrollTop);
    if (Math.abs(restored - target) > 2) failures.push(`scroll: position not restored on back (${restored}, expected ${target})`);
    await context.close();
  },

  /** Hidden sidebar: hovering the screen edge reveals the rail as an overlay; Escape hides it. */
  async hiddenrail(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    const { context, page } = await newPage(browser, { theme, viewport, sidebar: 'hidden' });
    await page.mouse.move(700, 400); // the virtual pointer starts at (0,0), which is the reveal edge
    await open(page, '/games');
    await page.waitForTimeout(300);
    if (await page.$('nav.rail')) failures.push('hiddenrail: rail visible while hidden');
    await page.mouse.move(2, 400);
    await page.waitForSelector('.rail-overlay nav.rail.overlay');
    await shot(page, `rail-hidden-reveal-${theme}-${viewport}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.rail-overlay', { state: 'detached' });
    // Keyboard: the toggleSidebar shortcut (Alt+S) reveals it; a click elsewhere closes it.
    await page.mouse.move(700, 400);
    await page.keyboard.press('Alt+S');
    await page.waitForSelector('.rail-overlay nav.rail');
    await page.mouse.click(900, 600);
    await page.waitForSelector('.rail-overlay', { state: 'detached' });
    await context.close();
  },

  /**
   * No flash of the wrong theme (the app bundle is held back, so only the inline boot script has run), recovery from
   * damaged settings storage, router edge cases and the persistent browser layer.
   */
  async robustness(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    // The entry module: /src/main.ts on the dev server (with a ?t= stamp after edits), /assets/app-*.js when built
    // (/assets/index-*.js in older builds).
    const bundle = /\/src\/main\.ts(\?|$)|\/assets\/(app|index)-[^/?]*\.js(\?|$)/;
    for (const [os, saved] of [
      ['dark', 'light'],
      ['light', 'dark'],
      ['light', 'system'],
    ]) {
      const { context, page } = await newPage(browser, { theme: os, viewport, appearance: { theme: saved } });
      await context.route(bundle, async (route) => {
        await new Promise((r) => setTimeout(r, 900));
        await route.continue();
      });
      const want = saved === 'system' ? os : saved;
      await page.goto(BASE + '/', { waitUntil: 'commit' });
      await page.waitForFunction(() => document.readyState !== 'loading' || document.body !== null);
      await page.waitForTimeout(250);
      const early = await page.evaluate(() => ({ cls: document.documentElement.className, app: !!document.querySelector('.shell') }));
      if (early.app) notes.push(`robustness: the app bundle was not held back (${os}/${saved})`);
      else if (!early.cls.includes(`theme-${want}`)) failures.push(`robustness: first paint has "${early.cls}", expected theme-${want} (OS ${os}, saved ${saved})`);
      await page.waitForSelector('.shell');
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const late = await page.evaluate(() => document.documentElement.className);
      if (!late.includes(`theme-${want}`)) failures.push(`robustness: app switched to "${late}", expected theme-${want} (OS ${os}, saved ${saved})`);
      await context.close();
    }

    // Damaged or hand-edited settings mirrors: the page still starts, applies a valid theme and repairs the mirror.
    const damaged = [
      'not json',
      '[]',
      'null',
      '{"v":1,"updatedAt":"x","settings":"garbage","boot":7}',
      '{"v":1,"updatedAt":5,"settings":{"version":1,"appearance":{"theme":"light","fontSize":999,"accent":"red"}},"boot":{"theme":"light","vars":{"--bg":"red","color":"x"},"classes":["<b>"],"meta":{"dark":"javascript:x"}}}',
      '{"v":1,"updatedAt":5,"settings":{"version":99,"appearance":{"theme":"light"}}}',
      '{"v":1,"updatedAt":5,"settings":{"__proto__":{"polluted":1},"version":1,"privacy":{"sitePermissions":{"__proto__":{"camera":"allow"},"a.com":{"camera":"allow"}}}}}',
    ];
    for (const value of damaged) {
      const { context, page } = await newPage(browser, { theme, viewport });
      await context.addInitScript(
        ([key, v]) => {
          if (!sessionStorage.getItem('qa:damaged')) {
            localStorage.setItem(key, v);
            sessionStorage.setItem('qa:damaged', '1');
          }
        },
        [SETTINGS_KEY, value],
      );
      await open(page, '/');
      await page.waitForTimeout(300);
      const r = await page.evaluate((key) => {
        let mirror = null;
        try {
          mirror = JSON.parse(localStorage.getItem(key) ?? 'null');
        } catch {
          mirror = 'unparseable';
        }
        return {
          cls: document.documentElement.className,
          bg: document.documentElement.style.getPropertyValue('--bg'),
          polluted: Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'),
          mirrorOk: mirror === null || (typeof mirror === 'object' && typeof mirror.settings?.appearance?.theme === 'string'),
          fontSize: mirror?.settings?.appearance?.fontSize ?? null,
        };
      }, SETTINGS_KEY);
      const label = `robustness: damaged mirror ${value.slice(0, 40)}`;
      if (!/theme-(dark|light)/.test(r.cls)) failures.push(`${label}: no theme class (${r.cls})`);
      if (r.bg === 'red') failures.push(`${label}: an unvalidated boot variable stayed applied`);
      if (r.polluted) failures.push(`${label}: Object.prototype was polluted`);
      if (!r.mirrorOk) failures.push(`${label}: the mirror was not repaired`);
      if (r.fontSize !== null && (r.fontSize < 12 || r.fontSize > 20)) failures.push(`${label}: fontSize ${r.fontSize} kept`);
      await context.close();
    }

    // Router: cold loads are canonicalized; client navigation, back/forward, query and hash changes.
    const { context, page } = await newPage(browser, { theme, viewport });
    const where = () => page.evaluate(() => `${location.pathname}${location.search}${location.hash} | ${document.title}`);
    for (const [path, expected] of [
      ['/games/', '/games | Games · GNOME'],
      ['//games', '/games | Games · GNOME'],
      ['/downloads/', '/downloads | Downloads · GNOME'],
      ['/history?q=a#top', '/history?q=a#top | History · GNOME'],
      ['/nope/deeper/', '/nope/deeper | Page not found · GNOME'],
    ]) {
      await open(page, path);
      await page.waitForFunction((t) => document.title === t, expected.split(' | ')[1], { timeout: 5000 }).catch(() => undefined);
      const got = await where();
      if (got !== expected) failures.push(`robustness: cold load ${path} → "${got}", expected "${expected}"`);
    }
    const click = (href) =>
      page.evaluate((h) => {
        const a = document.createElement('a');
        a.href = h;
        a.textContent = h;
        document.querySelector('main .route, .layer.active')?.append(a);
        a.click();
        a.remove();
      }, href);
    await open(page, '/');
    const trail = [];
    for (const href of ['/games', '/games/%E0%A4%A', '/history?q=1#top', '/browse']) {
      await click(href);
      await page.waitForTimeout(250);
      trail.push(await where());
    }
    const want = ['/games | Games · GNOME', '/games/%E0%A4%A | Page not found · GNOME', '/history?q=1#top | History · GNOME', '/browse | Browser · GNOME'];
    if (JSON.stringify(trail) !== JSON.stringify(want)) failures.push(`robustness: client navigation ${JSON.stringify(trail)}`);
    await page.evaluate(() => (document.querySelector('.layer.active .host').dataset.qaMark = 'kept'));
    const back = [];
    for (let i = 0; i < 4; i++) {
      await page.goBack();
      await page.waitForTimeout(250);
      back.push(await where());
    }
    if (JSON.stringify(back) !== JSON.stringify([...want.slice(0, 3)].reverse().concat('/ | GNOME'))) {
      failures.push(`robustness: back through history ${JSON.stringify(back)}`);
    }
    const layer = await page.evaluate(() => {
      const l = document.querySelector('.layer');
      return l && { inert: l.inert, hidden: l.getAttribute('aria-hidden'), visibility: getComputedStyle(l).visibility };
    });
    if (!layer || !layer.inert || layer.hidden !== 'true' || layer.visibility !== 'hidden') {
      failures.push(`robustness: the hidden browser layer is not inert/hidden: ${JSON.stringify(layer)}`);
    }
    for (let i = 0; i < 4; i++) await page.goForward();
    await page.waitForFunction(() => location.pathname === '/browse');
    await page.waitForTimeout(250);
    if ((await page.evaluate(() => document.querySelector('.layer.active .host')?.dataset.qaMark)) !== 'kept') {
      failures.push('robustness: the browser layer was re-created instead of staying mounted');
    }
    await click('/history');
    await page.waitForTimeout(250);
    await page.evaluate(() => (document.querySelector('main .route').dataset.qaMark = 'same'));
    await click('/history?q=2');
    await click('/history?q=2#x');
    await page.waitForTimeout(250);
    if ((await page.evaluate(() => document.querySelector('main .route')?.dataset.qaMark)) !== 'same') {
      failures.push('robustness: a query or hash change re-created the page');
    }
    await context.close();
  },

  /** Focus after navigation (into and out of the persistent browser layer) and the hidden rail's keyboard path. */
  async focus(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    const focused = (page) =>
      page.evaluate(() => {
        const a = document.activeElement;
        return a ? `${a.tagName.toLowerCase()}:${(a.textContent ?? '').trim().slice(0, 30)}` : 'none';
      });
    const enterLink = async (page, href, container) => {
      await page.evaluate(
        ([h, c]) => {
          const a = document.createElement('a');
          a.href = h;
          a.textContent = `go ${h}`;
          document.querySelector(c).append(a);
          a.focus();
        },
        [href, container],
      );
      await page.keyboard.press('Enter');
    };
    {
      const { context, page } = await newPage(browser, { theme, viewport });
      await open(page, '/');
      await enterLink(page, '/browse', 'main .route');
      await page.waitForFunction(() => document.title.startsWith('Browser'));
      await page.waitForTimeout(250);
      // The browser view's new tab shows Home: focus moves to that view's heading (inside the visible layer).
      const inView = await page.evaluate(() => document.activeElement?.tagName === 'H1' && !!document.activeElement.closest('.layer.active'));
      if (!inView) failures.push(`focus: after opening /browse from the page, focus is on ${await focused(page)}`);
      const mains = await page.evaluate(() => [...document.querySelectorAll('main, [role="main"]')].filter((e) => e.checkVisibility()).length);
      if (mains !== 1) failures.push(`focus: /browse exposes ${mains} visible main landmarks`);
      await enterLink(page, '/games', '.layer.active');
      await page.waitForFunction(() => document.title.startsWith('Games'));
      await page.waitForTimeout(250);
      if ((await focused(page)) !== 'h1:Games') failures.push(`focus: after leaving the browser layer, focus is on ${await focused(page)}`);
      await context.close();
    }
    {
      const { context, page } = await newPage(browser, { theme, viewport, sidebar: 'hidden' });
      await page.mouse.move(700, 400);
      await open(page, '/games');
      await page.waitForTimeout(250);
      await page.locator('main h1').focus();
      await page.keyboard.press('Alt+S');
      await page.waitForSelector('.rail-overlay nav.rail');
      await page.waitForTimeout(200);
      if ((await focused(page)) !== 'a:Games') failures.push(`focus: the sidebar shortcut did not move focus into the rail (${await focused(page)})`);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.rail-overlay', { state: 'detached' });
      if ((await focused(page)) !== 'h1:Games') failures.push(`focus: Escape did not return focus from the rail (${await focused(page)})`);
      await page.keyboard.press('Alt+S');
      await page.waitForSelector('.rail-overlay nav.rail');
      await page.waitForTimeout(200);
      await page.locator('.rail-overlay a[href="/history"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.title.startsWith('History'));
      await page.waitForSelector('.rail-overlay', { state: 'detached' });
      await page.waitForTimeout(200);
      if ((await focused(page)) !== 'h1:History') failures.push(`focus: navigating from the rail overlay left focus on ${await focused(page)}`);
      await context.close();
    }
  },

  async notfound(browser, theme, viewport) {
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/no-such-page');
    await page.waitForSelector('text=This page does not exist');
    await shot(page, `notfound-${theme}-${viewport}`);
    await context.close();
  },

  /** Functional checks (no screenshots). */
  async behaviour(browser, theme, viewport) {
    if (viewport === 'phone' || theme === 'light') return;
    const { context, page } = await newPage(browser, { theme, viewport });
    await open(page, '/');
    // Theme command in the palette.
    await page.keyboard.press('Control+K');
    await page.waitForSelector('dialog.palette[open]');
    await page.keyboard.type('light theme');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.classList.contains('theme-light'));
    // The choice persists across a reload (localStorage mirror + IndexedDB).
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'networkidle' });
    if (!(await page.evaluate(() => document.documentElement.classList.contains('theme-light')))) {
      failures.push('behaviour: theme did not persist across reload');
    }
    // Context menu: keyboard navigation and focus restoration.
    const tile = page.locator('.tiles .tile').first();
    await tile.focus();
    if (BROWSER === 'chromium') await page.keyboard.press('Shift+F10');
    // Playwright's Firefox key emulation skips the widget layer that turns Shift+F10 / the ContextMenu key into a
    // contextmenu event; dispatch the event exactly as browsers do for the keyboard (at 0,0 on the focused element).
    else await tile.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await page.waitForSelector('[role="menu"]');
    await page.keyboard.press('ArrowDown');
    const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    if (focusedRole !== 'menuitem') failures.push(`behaviour: menu focus is on ${focusedRole}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="menu"]', { state: 'detached' });
    const back = await page.evaluate(() => document.activeElement?.classList.contains('tile'));
    if (!back) failures.push('behaviour: focus did not return to the quick link after Escape');
    // Navigation: rail link → route + title, browser back.
    await page.locator('nav.rail a[href="/downloads"]').click();
    await page.waitForFunction(() => document.title === 'Downloads · GNOME');
    await page.goBack();
    await page.waitForFunction(() => document.title === 'GNOME' && location.pathname === '/');
    await context.close();
  },
};

// Component gallery, keyboard paths, touch targets, VirtualGrid benchmark, layout shift (scripts/qa-components.mjs).
Object.assign(scenarios, componentScenarios({ BASE, BROWSER, failures, notes, newPage, shot, lint }));

const browser = await (BROWSER === 'firefox' ? firefox : chromium).launch({
  headless: true,
  ...(process.env.GNOME_QA_EXECUTABLE ? { executablePath: process.env.GNOME_QA_EXECUTABLE } : {}),
});
mkdirSync(OUT, { recursive: true });
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    for (const theme of ['dark', 'light']) {
      for (const viewport of ['desktop', 'phone']) {
        try {
          await run(browser, theme, viewport);
        } catch (err) {
          failures.push(`${name} ${theme}/${viewport}: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
        }
      }
    }
  }
} finally {
  await browser.close();
}

const backendLines = notes.filter((n) => n.includes('(expected, no backend)'));
console.log(`screenshots → ${OUT}`);
console.log(`expected backend-unreachable console lines: ${backendLines.length}`);
if (benign.length) console.log(`benign browser warnings (BENIGN_WARNINGS): ${benign.length}`);
for (const n of notes) if (!backendLines.includes(n)) console.log(`  · ${n}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks passed');
