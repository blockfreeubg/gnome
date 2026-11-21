#!/usr/bin/env node
/**
 * Settings page QA (frontend/src/pages/settings): screenshots in dark + light at 1440×900 and 390×844, structural
 * checks on every screen (page errors, console errors, unnamed controls, duplicate ids, phone overflow), behaviour
 * checks (instant appearance, search + highlight, deep links, reset, shortcut recording + conflicts, clear browsing
 * data against real IndexedDB, export, rows of features this build does not include are hidden) and an end-to-end
 * account + sync run against a real gnome-server (signed-out visitors cause no session request, register, sync on,
 * the rail shows the user right after a reload, two devices with a conflicting edit, reset all keeps sync on and
 * reaches the server, wrong passwords, change password, sign out/in, delete account).
 *
 * Rows whose feature is not part of the build (frontend/src/settings/features.ts: browser, extensions, vpn, games)
 * are hidden; checks of those rows run once the feature registers and are reported as skipped until then.
 *
 * Run against gnome-server serving a production build with accounts enabled:
 *   GNOME_QA_URL=http://127.0.0.1:21201 node tests/e2e/settings/settings-qa.mjs
 * Env: GNOME_QA_URL (required), GNOME_QA_OUT (default docs/screenshots/settings), GNOME_QA_BROWSER (chromium|firefox),
 *      GNOME_QA_ONLY (comma-separated scenario names), GNOME_QA_SKIP_ACCOUNT=1 (no account e2e).
 * playwright-core comes from frontend/node_modules (pinned to the cached browser builds). Exits 1 on any failure.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '../../../frontend/package.json'));
const { chromium, firefox } = require('playwright-core');

const BASE = (process.env.GNOME_QA_URL ?? '').replace(/\/$/, '');
if (!BASE) {
  console.error('Set GNOME_QA_URL to a gnome-server (accounts enabled) serving a frontend build.');
  process.exit(2);
}
const OUT = resolve(process.env.GNOME_QA_OUT ?? join(HERE, '../../../docs/screenshots/settings'));
const ONLY = (process.env.GNOME_QA_ONLY ?? '').split(',').filter(Boolean);
const BROWSER = process.env.GNOME_QA_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const SUFFIX = BROWSER === 'firefox' ? '-firefox' : '';
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const failures = [];
const passes = [];

function check(cond, label) {
  if (cond) passes.push(label);
  else failures.push(label);
}

function mirror(theme) {
  return JSON.stringify({
    v: 1,
    updatedAt: Date.now(),
    settings: { version: 1, appearance: { theme } },
    boot: { theme, motion: 'normal', vars: {}, dark: {}, light: {}, classes: [], meta: { dark: '#0f0f0d', light: '#f5f1e8' } },
  });
}

async function newPage(browser, theme, viewport) {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1, colorScheme: theme, acceptDownloads: true });
  await context.addInitScript(
    ([value]) => {
      try {
        if (!sessionStorage.getItem('qa:seeded')) {
          localStorage.setItem('gnome:settings:v1', value);
          sessionStorage.setItem('qa:seeded', '1');
        }
      } catch {
        /* storage blocked */
      }
    },
    [mirror(theme)],
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const label = () => `${theme}/${viewport} ${page.url().replace(BASE, '')}`;
  page.on('pageerror', (e) => failures.push(`${label()}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    // Expected in the account run: a wrong password (login 401, password/account 422) and a revoked session
    // (session, sync 401). Endpoints a server may not have (filters, VPN, games) answer 404. Signed-out visitors
    // must not cause any 401: the app asks GET /api/session only when this browser was signed in.
    const url = m.location()?.url ?? '';
    if (/Failed to load resource/.test(text) && /\/api\/(session|auth\/(login|password|account)|filters|vpn\/locations|games\/categories|sync\/)/.test(url)) return;
    failures.push(`${label()}: console.${m.type()}: ${text} ${url.replace(BASE, '')}`);
  });
  return { context, page };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(400);
}

/** Screenshot; `full` grows the viewport to the app scroller's content height (the document itself does not scroll). */
async function shot(page, name, full = false) {
  await settle(page);
  const size = page.viewportSize();
  if (full) {
    const h = await page.evaluate(() => {
      let el = document.querySelector('.settings');
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el && el !== document.body ? el.scrollHeight + (innerHeight - el.clientHeight) : document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(h, size.height), 7000) });
    await settle(page);
  }
  await page.screenshot({ path: join(OUT, `${name}${SUFFIX}.png`), animations: 'disabled' });
  if (full) await page.setViewportSize(size);
}

async function lint(page, label, phone) {
  const problems = await page.evaluate((isPhone) => {
    const out = [];
    const named = (el) =>
      (el.getAttribute('aria-label') ?? '').trim() ||
      (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).some((id) => document.getElementById(id)?.textContent?.trim()) ||
      (el.textContent ?? '').trim() ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) ||
      [...(el.labels ?? [])].some((l) => l.textContent.trim());
    const sel = 'button, a[href], input:not([type=hidden]), [role="button"], [role="switch"], [role="combobox"], [role="radio"], [role="slider"]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"], [inert]') || el.getClientRects().length === 0) continue;
      if (!named(el)) out.push(`unnamed ${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
    }
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push(`duplicate id #${id} ×${n}`);
    if (isPhone && document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page overflows horizontally (${document.documentElement.scrollWidth}px)`);
    return out;
  }, phone);
  for (const p of problems) failures.push(`${label}: ${p}`);
}

async function open(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('.settings');
  await settle(page);
}

const row = (page, id) => page.locator(`[data-row$=".${id}"]`).first();
const skipped = [];

// ── Visual scenarios (run for each theme × viewport) ──────────────────────────────────────────────────────────────

const visual = {
  async sections(browser, theme, viewport) {
    const { context, page } = await newPage(browser, theme, viewport);
    const phone = viewport === 'phone';
    await open(page, '/settings');
    await lint(page, `${theme}/${viewport} /settings`, phone);
    await shot(page, `${phone ? 'list' : 'appearance'}-${theme}-${viewport}`, !phone);
    for (const s of ['browser', 'privacy', 'extensions', 'vpn', 'account', 'advanced', 'games', 'performance']) {
      await open(page, `/settings/${s}`);
      await lint(page, `${theme}/${viewport} /settings/${s}`, phone);
      if (['privacy', 'extensions', 'account', 'advanced'].includes(s) || (phone && s === 'browser')) await shot(page, `${s}-${theme}-${viewport}`, true);
    }
    if (phone) {
      await open(page, '/settings/appearance');
      await shot(page, `appearance-${theme}-${viewport}`, true);
    }
    await context.close();
  },

  async search(browser, theme, viewport) {
    const { context, page } = await newPage(browser, theme, viewport);
    await open(page, '/settings');
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('history');
    await page.waitForSelector('.result');
    await settle(page);
    const n = await page.evaluate(() => CSS.highlights?.get('gnome-settings-search')?.size ?? -1);
    check(n > 0 || n === -1, `${theme}/${viewport} search highlights painted (${n})`);
    await lint(page, `${theme}/${viewport} search`, viewport === 'phone');
    await shot(page, `search-${theme}-${viewport}`);
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('zzzz nothing');
    await page.waitForSelector('text=No settings match');
    check(true, `${theme}/${viewport} empty search state`);
    await context.close();
  },

  async shortcuts(browser, theme, viewport) {
    const { context, page } = await newPage(browser, theme, viewport);
    await open(page, '/settings/shortcuts');
    const history = row(page, 'openHistory');
    await history.getByRole('button', { name: 'Change', exact: true }).click();
    await page.keyboard.press('Alt+G'); // openGames' default: a conflict
    await page.waitForSelector('text=is used by');
    await lint(page, `${theme}/${viewport} shortcuts`, viewport === 'phone');
    await history.scrollIntoViewIfNeeded();
    await shot(page, `shortcuts-${theme}-${viewport}`);
    await context.close();
  },

  async cleardata(browser, theme, viewport) {
    const { context, page } = await newPage(browser, theme, viewport);
    await open(page, '/settings/privacy');
    await page.getByRole('button', { name: 'Clear data…' }).click();
    await page.waitForSelector('dialog[open]');
    await lint(page, `${theme}/${viewport} clear data dialog`, viewport === 'phone');
    await shot(page, `clear-data-${theme}-${viewport}`);
    await context.close();
  },
};

async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${label}: ${String(err?.message ?? err).split('\n')[0]}`);
  }
}

// ── Behaviour checks (once) ─────────────────────────────────────────────────────────────────────────────────────

async function behaviour(browser) {
  const { context, page } = await newPage(browser, 'dark', 'desktop');
  await open(page, '/settings/appearance');
  let bgBefore = '';

  // Appearance applies instantly.
  await step('Appearance applies instantly.', async () => {
    bgBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    await row(page, 'theme').getByRole('radio', { name: 'Light' }).click();
    await page.waitForTimeout(100);
    const bgAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    check(bgBefore !== bgAfter, `theme applies instantly (--bg ${bgBefore} → ${bgAfter})`);
  });
  // Reset per row.
  await step('Reset per row.', async () => {
    await row(page, 'theme').getByRole('button', { name: /to default$/ }).click();
    await page.waitForTimeout(100);
    const bgReset = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    check(bgReset === bgBefore, 'row reset restores the default theme');

  });
  // Slider: radius applies instantly through the CSS variable.
  await step('Slider: radius applies instantly through the CSS variable.', async () => {
    const radius = row(page, 'radius').getByRole('slider');
    await radius.focus();
    await page.keyboard.press('ArrowRight');
    const r = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius').trim());
    // Design v2 default radius is 10px (docs/DESIGN.md §5); one step right is 11px.
    check(r === '11px', `radius slider applies instantly (${r})`);

  });
  // Reset section.
  await step('Reset section.', async () => {
    await page.getByRole('button', { name: 'Reset section' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Reset' }).click().catch(async () => {
      await page.locator('dialog[open]').getByRole('button', { name: 'Reset', exact: true }).click();
    });
    await page.waitForTimeout(200);
    const r2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--radius').trim());
    check(r2 === '10px', `section reset restores radius (${r2})`);

  });
  // Deep link scrolls + flashes.
  await step('Deep link scrolls + flashes.', async () => {
    await page.goto(`${BASE}/settings/appearance#homeBackground`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const deep = await page.evaluate(() => {
      const el = document.getElementById('homeBackground');
      if (!el) return 'missing';
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight ? (el.classList.contains('flash') ? 'ok' : 'no flash') : 'not in view';
    });
    check(deep === 'ok', `deep link /settings/appearance#homeBackground (${deep})`);

  });
  // Shortcut recording: replace a conflicting combo.
  await step('Shortcut recording: replace a conflicting combo.', async () => {
    await open(page, '/settings/shortcuts');
    await row(page, 'openHistory').getByRole('button', { name: 'Change', exact: true }).click();
    await page.keyboard.press('Alt+G');
    await row(page, 'openHistory').getByRole('button', { name: 'Use it here' }).click();
    const sc = await page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.browser.shortcuts);
    check(sc.openHistory === 'Alt+G' && sc.openGames === '', `shortcut conflict resolved (openHistory=${sc.openHistory}, openGames=${sc.openGames})`);
    await row(page, 'openGames').getByRole('button', { name: 'Set', exact: true }).click();
    await page.keyboard.press('Control+t');
    await page.waitForSelector('text=keeps');
    check(true, 'reserved combo warning shown for Ctrl+T');
    // The new binding works right away (the shell handles openHistory in every build).
    await page.locator('h1').first().click();
    await page.keyboard.press('Alt+G');
    await page.waitForURL(/\/history$/);
    check(true, 'rebound shortcut Alt+G opens History');
    await open(page, '/settings/shortcuts');
    await row(page, 'openHistory').getByRole('button', { name: /to default$/ }).click();
    await row(page, 'openGames').getByRole('button', { name: /to default$/ }).click();

  });
  // Clear browsing data against real IndexedDB.
  await step('Clear browsing data against real IndexedDB.', async () => {
    await open(page, '/settings/privacy');
    const seeded = await page.evaluate(
      () =>
        new Promise((res) => {
          const req = indexedDB.open('gnome');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['history', 'downloads'], 'readwrite');
            const now = Date.now();
            tx.objectStore('history').put({ id: 'h-new', url: 'https://a.example/', title: 'A', visitedAt: now - 60_000 });
            tx.objectStore('history').put({ id: 'h-old', url: 'https://b.example/', title: 'B', visitedAt: now - 5 * 86_400_000 });
            tx.objectStore('downloads').put({ id: 'd1', url: 'https://c.example/f', filename: 'f', mime: null, size: 1, received: 1, state: 'complete', error: null, startedAt: now - 1000, finishedAt: now });
            tx.oncomplete = () => res(true);
            tx.onerror = () => res(false);
          };
          req.onerror = () => res(false);
        }),
    );
    check(seeded, 'seeded history/downloads in IndexedDB');
    await page.getByRole('button', { name: 'Clear data…' }).click();
    const dlg = page.locator('dialog[open]');
    await dlg.getByText('Downloads list', { exact: true }).click();
    await dlg.getByRole('button', { name: 'Clear data' }).click();
    await page.waitForSelector('text=Browsing data cleared');
    const left = await page.evaluate(
      () =>
        new Promise((res) => {
          const req = indexedDB.open('gnome');
          req.onsuccess = () => {
            const tx = req.result.transaction(['history', 'downloads']);
            const h = tx.objectStore('history').getAllKeys();
            const d = tx.objectStore('downloads').count();
            tx.oncomplete = () => res({ history: h.result, downloads: d.result });
          };
        }),
    );
    check(
      JSON.stringify(left.history) === '["h-old"]' && left.downloads === 0,
      `clear data (last hour) removed recent history and downloads only (${JSON.stringify(left)})`,
    );

  });
  // Export downloads a JSON file.
  await step('Export downloads a JSON file.', async () => {
    await open(page, '/settings/advanced');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export' }).click()]);
    check(/gnome-settings-.*\.json$/.test(download.suggestedFilename()), `export downloads ${download.suggestedFilename()}`);

  });
  // Custom Wisp servers accept ws/wss only.
  await step('Custom Wisp servers accept ws/wss only.', async () => {
    check(await row(page, 'isolation').getByText('Isolated').isVisible(), 'proxy isolation row shows the server state');
    const wisp = row(page, 'wispServers');
    if (!(await wisp.count())) {
      skipped.push('custom Wisp servers editor (hidden until the built-in browser registers)');
      return;
    }
    await wisp.getByRole('textbox').fill('https://not-a-websocket.example/');
    await wisp.getByRole('button', { name: 'Add server' }).click();
    check(await wisp.getByText('Use a ws:// or wss:// address.').isVisible(), 'wisp server editor rejects https://');
    await wisp.getByRole('textbox').fill('wss://wisp.example.com/');
    await wisp.getByRole('button', { name: 'Add server' }).click();
    check(await wisp.getByText('wss://wisp.example.com/').isVisible(), 'wisp server editor accepts wss://');

  });
  // Filter lists degrade gracefully (or render when the endpoint exists).
  await step('Filter lists degrade gracefully (or render when the endpoint exists).', async () => {
    await open(page, '/settings/extensions');
    if (!(await row(page, 'lists').count())) {
      skipped.push('filter lists row (hidden until the built-in extensions register)');
      return;
    }
    const lists = await row(page, 'lists').innerText();
    check(/does not publish|lists on|publishes no/.test(lists), `filter lists row degrades or renders (${lists.split('\n')[0]})`);

  });
  // Settings of features this build does not include are not offered (no controls that do nothing).
  await step('Rows of absent features are hidden.', async () => {
    await open(page, '/settings');
    const listed = await page.locator('nav[aria-label="Settings sections"] a').allInnerTexts();
    const vpnRows = await (async () => {
      await open(page, '/settings/vpn');
      return page.locator('[data-row^="vpn."]').count();
    })();
    if (vpnRows === 0) {
      check(!listed.some((t) => /^VPN/.test(t.trim())), `sections list leaves out VPN while it has no settings (${listed.length} sections)`);
      check(await page.getByText('VPN settings are not available yet').isVisible(), '/settings/vpn explains why it is empty');
    } else skipped.push('hidden VPN section (the VPN feature is present)');
    await open(page, '/settings/browser');
    const startup = await row(page, 'startup').count();
    const engine = await row(page, 'searchEngine').count();
    check(engine === 1, 'search engine row is shown in every build');
    if (!startup) {
      await page.getByRole('searchbox', { name: 'Search settings' }).fill('start-up');
      await page.waitForTimeout(200);
      check((await page.locator('[data-row="browser.startup"]').count()) === 0, 'search does not surface hidden rows');
    } else skipped.push('hidden browser rows (the built-in browser is present)');
  });
  await context.close();
}

// ── Account + sync end to end ────────────────────────────────────────────────────────────────────────────────────

async function serverSettings(page) {
  return page.evaluate(() => fetch('/api/sync/settings', { credentials: 'same-origin' }).then((r) => r.json()));
}

async function waitFor(fn, label, timeout = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    if (Date.now() - start > timeout) {
      failures.push(`timed out: ${label}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function account(browser) {
  const user = `qa_${Date.now().toString(36)}`;
  const pw1 = 'correct horse battery';
  const pw2 = 'staple horse battery 2';
  const a = await newPage(browser, 'dark', 'desktop');
  const apiCalls = [];
  a.page.on('response', (r) => {
    if (r.url().includes('/api/')) apiCalls.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
  });
  await a.page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await open(a.page, '/settings/account');
  check(
    !apiCalls.some((c) => /\/api\/(session|auth\/me)\b/.test(c) || / 4\d\d$/.test(c)),
    `signed-out visitors cause no session check and no 4xx (${apiCalls.join(', ')})`,
  );
  await shot(a.page, `account-signed-out-dark-desktop`);
  await a.page.getByRole('button', { name: 'Create one', exact: true }).click();
  await a.page.getByLabel('Username').fill(user);
  await a.page.getByLabel('Password', { exact: true }).fill('short');
  await a.page.getByLabel('Confirm password').fill('short');
  await a.page.getByRole('button', { name: 'Create account' }).last().click();
  check(await a.page.getByText('Use at least 10 characters.').isVisible(), 'register validates password length client-side');
  await a.page.getByLabel('Password', { exact: true }).fill(pw1);
  await a.page.getByLabel('Confirm password').fill(pw1);
  await a.page.getByRole('button', { name: 'Create account' }).last().click();
  await a.page.waitForSelector(`text=${user}`);
  check(true, `registered ${user} through the UI`);
  // The next load shows the user in the rail at once and confirms it with GET /api/session (200).
  apiCalls.length = 0;
  await open(a.page, '/settings/account');
  // The account entry is the toolbar avatar since design v2 (it was a rail item before).
  check(
    (await a.page.locator('a[href="/settings/account"][aria-label]').first().getAttribute('aria-label')) === `Account: ${user}`,
    'the account entry shows the signed-in user after a reload',
  );
  check(apiCalls.includes('GET /api/session 200'), `signed-in reload confirms the session (${apiCalls.join(', ')})`);

  // Turn sync on → settings uploaded.
  await row(a.page, 'sync').getByRole('switch').click();
  await waitFor(async () => (await serverSettings(a.page)).data !== null, 'first settings upload');
  const first = await serverSettings(a.page);
  check(first.data && !('account' in first.data), 'server copy has no device-local account section');
  await a.page.waitForSelector('text=Last synced');
  await shot(a.page, `account-signed-in-dark-desktop`);

  // Local change → pushed after the debounce.
  await open(a.page, '/settings/appearance');
  await row(a.page, 'theme').getByRole('radio', { name: 'Light' }).click();
  await waitFor(async () => (await serverSettings(a.page)).data?.appearance?.theme === 'light', 'theme change uploaded');
  check((await serverSettings(a.page)).data?.appearance?.theme === 'light', 'device A theme change reached the server');

  // Device B signs in, enables sync, receives the theme.
  const b = await newPage(browser, 'dark', 'desktop');
  await open(b.page, '/settings/account');
  await b.page.getByLabel('Username').fill(user);
  await b.page.getByLabel('Password', { exact: true }).fill(pw1);
  await b.page.getByRole('button', { name: 'Sign in' }).last().click();
  await b.page.waitForSelector(`text=${user}`);
  await row(b.page, 'sync').getByRole('switch').click();
  await waitFor(
    () => b.page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.appearance.theme === 'light'),
    'device B received the theme',
  );
  check(true, 'device B pulled the synced theme');

  // Conflict: both devices edit different keys without seeing each other's change, then both sync.
  await open(b.page, '/settings/appearance');
  await open(a.page, '/settings/appearance');
  await row(b.page, 'fontSize').getByRole('slider').focus();
  await b.page.keyboard.press('ArrowRight'); // 15 px on B
  await row(a.page, 'density').getByRole('radio', { name: 'Compact' }).click(); // compact on A
  await waitFor(async () => {
    const d = (await serverSettings(a.page)).data?.appearance;
    return d?.fontSize === 15 && d?.density === 'compact';
  }, 'server holds both edits');
  // A pulls B's edit on its next sync (visibility/periodic); trigger with "Sync now".
  await open(a.page, '/settings/account');
  await row(a.page, 'sync').getByRole('button', { name: 'Sync now' }).click();
  await waitFor(
    () => a.page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.appearance.fontSize === 15),
    'device A merged device B edit',
  );
  await open(b.page, '/settings/account');
  await row(b.page, 'sync').getByRole('button', { name: 'Sync now' }).click();
  await waitFor(
    () => b.page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.appearance.density === 'compact'),
    'device B merged device A edit',
  );
  check(true, 'two devices with concurrent edits converged');

  // Reset all keeps this browser's sync switches, and the reset reaches the server.
  await open(a.page, '/settings/advanced');
  await a.page.getByRole('button', { name: 'Reset all…' }).click();
  await a.page.locator('dialog[open]').getByRole('button', { name: 'Reset everything' }).click();
  await a.page.waitForSelector('text=Settings reset to defaults');
  const afterReset = await a.page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings);
  check(afterReset.account.sync === true && afterReset.appearance.theme === 'dark', 'reset all keeps sync on (and resets the theme)');
  await waitFor(async () => {
    const d = (await serverSettings(a.page)).data?.appearance;
    return d?.theme === 'dark' && d?.density === 'comfortable';
  }, 'reset reached the server');

  // Change password on A: a wrong current password is reported on its field; then B's session is revoked.
  await open(a.page, '/settings/account');
  await a.page.getByRole('button', { name: 'Change password' }).click();
  const dlg = a.page.locator('dialog[open]');
  await dlg.getByRole('textbox', { name: 'Current password', exact: true }).fill('not the password');
  await dlg.getByRole('textbox', { name: 'New password', exact: true }).fill(pw2);
  await dlg.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(pw2);
  await dlg.getByRole('button', { name: 'Change password' }).click();
  check(
    await dlg
      .getByText('Current password is incorrect.')
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    'wrong current password is reported on its field',
  );
  await dlg.getByRole('textbox', { name: 'Current password', exact: true }).fill(pw1);
  await dlg.getByRole('textbox', { name: 'New password', exact: true }).fill(pw2);
  await dlg.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(pw2);
  await shot(a.page, 'change-password-dark-desktop');
  await dlg.getByRole('button', { name: 'Change password' }).click();
  await a.page.waitForSelector('text=Password changed');
  const bSession = await b.page.evaluate(() => fetch('/api/session').then((r) => r.json().then((j) => `${r.status} ${j.session?.kind ?? ''}`)));
  check(!/user$/.test(bSession), `password change revoked the other session (B /api/session → ${bSession})`);

  // Sign out and back in with the new password.
  await a.page.getByRole('button', { name: 'Sign out' }).click();
  await a.page.waitForSelector('text=Sign in');
  await a.page.getByLabel('Username').fill(user);
  await a.page.getByLabel('Password', { exact: true }).fill(pw1);
  await a.page.getByRole('button', { name: 'Sign in' }).last().click();
  check(
    await a.page
      .getByText('The username or password is not right.')
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    'old password is rejected',
  );
  await a.page.getByLabel('Password', { exact: true }).fill(pw2);
  await a.page.getByRole('button', { name: 'Sign in' }).last().click();
  await a.page.waitForSelector(`text=${user}`);
  check(true, 'signed in with the new password');

  // Delete the account (a wrong password first: reported on the field, nothing deleted).
  await a.page.getByRole('button', { name: 'Delete account' }).click();
  const del = a.page.locator('dialog[open]');
  await del.getByRole('textbox', { name: 'Password', exact: true }).fill('not the password');
  await del.getByRole('button', { name: 'Delete account' }).click();
  check(
    await del
      .getByText('Password is incorrect.')
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    'wrong password on account deletion is reported on its field',
  );
  await del.getByRole('textbox', { name: 'Password', exact: true }).fill(pw2);
  await shot(a.page, 'delete-account-dark-desktop');
  await del.getByRole('button', { name: 'Delete account' }).click();
  await a.page.waitForSelector('text=Account deleted');
  check((await a.page.evaluate(() => localStorage.getItem('gnome:account:v1'))) === null, 'deleting the account forgets the sign-in hint');
  const login = await a.page.evaluate(
    ([u, p]) =>
      fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GNOME-Request': '1' }, body: JSON.stringify({ username: u, password: p }) }).then(
        (r) => r.status,
      ),
    [user, pw2],
  );
  check(login === 401, `deleted account can no longer sign in (${login})`);
  await a.context.close();
  await b.context.close();
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
const browser = await (BROWSER === 'firefox' ? firefox : chromium).launch({ headless: true });
try {
  for (const [name, run] of Object.entries(visual)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    for (const theme of ['dark', 'light']) {
      for (const viewport of ['desktop', 'phone']) {
        try {
          await run(browser, theme, viewport);
        } catch (err) {
          failures.push(`${name} ${theme}/${viewport}: ${String(err?.message ?? err).split('\n')[0]}`);
        }
      }
    }
  }
  for (const [name, run] of Object.entries({ behaviour, account })) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    if (name === 'account' && process.env.GNOME_QA_SKIP_ACCOUNT) continue;
    try {
      await run(browser);
    } catch (err) {
      failures.push(`${name}: ${String(err?.message ?? err).split("\n").slice(0, 6).join(" ⏎ ")}`);
    }
  }
} finally {
  await browser.close();
}

console.log(`screenshots → ${OUT}`);
for (const p of passes) console.log(`  ✓ ${p}`);
for (const s of skipped) console.log(`  – skipped: ${s}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks passed');
