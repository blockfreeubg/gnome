#!/usr/bin/env node
/**
 * Settings rows of features a build may not include yet (frontend/src/settings/features.ts: browser, extensions, vpn,
 * games) against a real gnome-server. Production builds hide those rows until the feature registers, so this harness
 * runs against the Vite dev server (which can import app modules), registers every feature in the page and checks:
 * - filter lists from GET /api/filters: grouped, each with its license; only deviations from a list's default are
 *   stored; a missing endpoint (404) and a server still loading its lists (503 + Retry-After) degrade honestly;
 * - VPN locations from GET /api/vpn/locations (status and checked time), or the "no gateway" state; the custom Wisp
 *   server editor accepts ws/wss only, and the VPN row warns when custom servers bypass the gateway;
 * - the games categories row degrades when the server has no catalog.
 *
 *   cd frontend && GNOME_DEV_BACKEND=http://127.0.0.1:21400 npx vite --port 21410
 *   GNOME_QA_URL=http://127.0.0.1:21410 node tests/e2e/settings/settings-features-qa.mjs
 * Env: GNOME_QA_URL (required: Vite dev server proxying /api to gnome-server), GNOME_QA_BROWSER (chromium|firefox).
 * Start gnome-server with GNOME_VPN_PROFILES (two profiles are enough; nothing needs to listen on their upstreams) to
 * check the location list. Exits 1 on any failure.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '../../../frontend/package.json'));
const pw = require('playwright-core');

const BASE = (process.env.GNOME_QA_URL ?? '').replace(/\/$/, '');
if (!BASE) {
  console.error('Set GNOME_QA_URL to a Vite dev server (frontend/) that proxies /api to gnome-server.');
  process.exit(2);
}
const BROWSER = process.env.GNOME_QA_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const failures = [];
const passes = [];
const check = (cond, label) => (cond ? passes : failures).push(label);

const browser = await pw[BROWSER].launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let injected = 0; // console lines caused by the 404/503 answers this harness injects
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (injected > 0 && /Failed to load resource/.test(m.text()) && /\/api\/filters/.test(m.location()?.url ?? '')) {
    injected--;
    return;
  }
  // A server without the games catalog answers 404 to its categories.
  if (/Failed to load resource/.test(m.text()) && /\/api\/games\/categories/.test(m.location()?.url ?? '')) return;
  failures.push(`console.${m.type()}: ${m.text()} ${m.location()?.url ?? ''}`);
});
const row = (id) => page.locator(`[data-row="${id}"]`);
const section = async (id) => {
  await page.locator(`nav[aria-label="Settings sections"] a[href="/settings/${id}"]`).click();
  await page.waitForTimeout(700);
};

try {
  await page.goto(`${BASE}/settings/extensions`, { waitUntil: 'networkidle' });
  const dev = await page.evaluate(async () => {
    try {
      const f = await import('/src/settings/features.ts');
      for (const x of f.FEATURES) f.registerFeature(x);
      return true;
    } catch {
      return false;
    }
  });
  if (!dev) throw new Error('app sources are not served here: run this against the Vite dev server');
  await page.waitForTimeout(1200);

  // Filter lists against GET /api/filters.
  const served = await page.evaluate(() => fetch('/api/filters').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const listRow = row('extensions.lists');
  const text = await listRow.innerText();
  if (served?.lists?.length) {
    const on = served.lists.filter((l) => l.default_enabled).length;
    check(text.includes(`${on} of ${served.lists.length} lists on`), `filter lists: "${on} of ${served.lists.length} lists on" from the server`);
    check(served.lists.every((l) => text.includes(l.name)), 'filter lists: every list the server reports is shown');
    check(served.lists.every((l) => text.includes(l.license)), 'filter lists: every list shows its license');
    check(!/\S·|·\S/.test(text.replace(/\s+/g, ' ')), 'filter lists: details are separated by " · "');
    const first = served.lists.find((l) => l.default_enabled);
    const extra = served.lists.find((l) => !l.default_enabled);
    await page.getByRole('switch', { name: first.name, exact: true }).click();
    if (extra) await page.getByRole('switch', { name: extra.name, exact: true }).click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.extensions.lists);
    check(stored[first.id] === false && (!extra || stored[extra.id] === true), `filter lists: toggles store deviations (${JSON.stringify(stored)})`);
    await page.getByRole('switch', { name: first.name, exact: true }).click();
    if (extra) await page.getByRole('switch', { name: extra.name, exact: true }).click();
    const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('gnome:settings:v1')).settings.extensions.lists);
    check(Object.keys(reset).length === 0, 'filter lists: switching back to the default stores nothing');
  } else {
    check(/does not publish|publishes no/.test(text), 'filter lists: degrades when the server has none');
  }
  // Missing endpoint (older server), then a server still verifying its stored lists.
  injected++;
  await page.route('**/api/filters', (r) =>
    r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'not found' } }) }),
  );
  await section('vpn');
  await section('extensions');
  check(/does not publish filter lists yet/.test(await listRow.innerText()), 'filter lists: 404 says the server does not publish lists yet');
  await page.unroute('**/api/filters');
  let calls = 0;
  injected++;
  await page.route('**/api/filters', (r) => {
    calls++;
    if (calls > 1) return r.continue();
    return r.fulfill({
      status: 503,
      headers: { 'Retry-After': '1' },
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'filter lists are still loading', retry_after_s: 1 } }),
    });
  });
  await section('vpn');
  await section('extensions');
  await page.waitForTimeout(2000);
  check(calls === 2 && !/could not be loaded/.test(await listRow.innerText()), `filter lists: 503 + Retry-After is retried (${calls} requests)`);
  await page.unroute('**/api/filters');

  // VPN locations against GET /api/vpn/locations.
  await section('vpn');
  const vpn = await page.evaluate(() => fetch('/api/vpn/locations').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  check(/Only traffic inside GNOME is routed/.test(await page.locator('.content').innerText()), 'vpn: says only traffic inside GNOME is routed');
  if (vpn?.profiles?.length) {
    await row('vpn.preferredLocation').getByRole('combobox').click();
    const options = await page.getByRole('option').allInnerTexts();
    await page.keyboard.press('Escape');
    check(
      vpn.profiles.every((p) => options.some((o) => o.startsWith(p.label))) && options.some((o) => /checked/.test(o)),
      `vpn: every location with its status (${options.map((o) => o.split('\n')[0]).join(', ')})`,
    );
    check(await row('vpn.mode').getByRole('radio', { name: 'Gateway' }).isEnabled(), 'vpn: gateway mode can be chosen');
  } else {
    check(/no VPN gateway configured/.test(await row('vpn.mode').innerText()), 'vpn: says the server has no gateway');
  }

  // Custom Wisp servers: ws/wss only; the VPN row warns that they bypass the gateway.
  await section('advanced');
  const wisp = row('advanced.wispServers');
  await wisp.getByRole('textbox').fill('https://not-a-websocket.example/');
  await wisp.getByRole('button', { name: 'Add server' }).click();
  check(await wisp.getByText('Use a ws:// or wss:// address.').isVisible(), 'wisp servers: https:// is rejected');
  await wisp.getByRole('textbox').fill('wss://wisp.example.com/');
  await wisp.getByRole('button', { name: 'Add server' }).click();
  check(await wisp.getByText('wss://wisp.example.com/').isVisible(), 'wisp servers: wss:// is accepted');
  await section('vpn');
  check(/bypass the gateway/.test(await row('vpn.mode').innerText()), 'vpn: warns that custom Wisp servers bypass the gateway');
  await section('advanced');
  await wisp.getByRole('button', { name: /Remove/ }).first().click();

  // Games: hidden categories from GET /api/games/categories, or an honest message.
  await section('games');
  const cats = await row('games.hiddenCategories').innerText();
  check(/does not offer the games catalog|could not be loaded|categor/i.test(cats), `games: hidden categories row (${cats.split('\n').pop()})`);
} catch (err) {
  failures.push(String(err?.message ?? err).split('\n')[0]);
} finally {
  await browser.close();
}

for (const p of passes) console.log(`  ✓ ${p}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks passed');
