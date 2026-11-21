#!/usr/bin/env node
/**
 * About page QA (frontend/src/pages/about): screenshots in dark + light at 1440×900 and 390×844 (viewport and full
 * page), structural checks (page errors, console errors, unnamed controls, duplicate ids, phone overflow) and checks
 * of what the page reports against the server it talks to:
 * - versions and access mode from GET /api/config, proxy isolation (on / off / not reachable), the AGPL source link;
 * - the filter lists the server distributes (GET /api/filters `lists` + `resources`) replace the documented defaults;
 * - the browser's engines are credited, license groups of features the build does not ship (content blocking) are not
 *   listed, and the Rust crate table has one row per crate version (no keyed-each errors);
 * - the shortcut reference lists only shortcuts that work in this build (shell, tabs, pages; zoom only once the engine
 *   offers it); the table of contents scrolls.
 *
 *   GNOME_QA_URL=http://127.0.0.1:21301 node tests/e2e/about/about-qa.mjs
 * Env: GNOME_QA_URL (required: gnome-server serving a frontend build), GNOME_QA_OUT (default docs/screenshots/about),
 *      GNOME_QA_BROWSER (chromium|firefox), GNOME_QA_EXPECT (isolated | single | offline: what the server should
 *      report; default isolated), GNOME_QA_SHOTS=0 (checks only). Exits 1 on any failure.
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
  console.error('Set GNOME_QA_URL to a gnome-server serving a frontend build.');
  process.exit(2);
}
const OUT = resolve(process.env.GNOME_QA_OUT ?? join(HERE, '../../../docs/screenshots/about'));
const BROWSER = process.env.GNOME_QA_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const SUFFIX = BROWSER === 'firefox' ? '-firefox' : '';
const EXPECT = process.env.GNOME_QA_EXPECT ?? 'isolated';
const SHOTS = process.env.GNOME_QA_SHOTS !== '0';
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const failures = [];
const passes = [];
const check = (cond, label) => (cond ? passes : failures).push(label);

function mirror(theme) {
  return JSON.stringify({
    v: 1,
    updatedAt: Date.now(),
    settings: { version: 1, appearance: { theme } },
    boot: { theme, motion: 'normal', vars: {}, dark: {}, light: {}, classes: [], meta: { dark: '#0f0f0d', light: '#f5f1e8' } },
  });
}

async function newPage(browser, theme, viewport) {
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], deviceScaleFactor: 1, colorScheme: theme });
  await context.addInitScript(
    ([value]) => {
      try {
        localStorage.setItem('gnome:settings:v1', value);
      } catch {
        /* storage blocked */
      }
    },
    [mirror(theme)],
  );
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const label = () => `${theme}/${viewport}`;
  page.on('pageerror', (e) => failures.push(`${label()}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const url = m.location()?.url ?? '';
    // Expected: network failures when the server is meant to be offline. A signed-out visit makes no session check.
    if (/Failed to load resource/.test(m.text()) && EXPECT === 'offline') return;
    failures.push(`${label()}: console.${m.type()}: ${m.text()} ${url.replace(BASE, '')}`);
  });
  return { context, page };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(400);
}

/** Screenshot; `full` grows the viewport to the page scroller's content height (the document itself does not scroll). */
async function shot(page, name, full = false) {
  if (!SHOTS) return;
  await settle(page);
  const size = page.viewportSize();
  if (full) {
    const h = await page.evaluate(() => {
      let el = document.querySelector('.about');
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      return el && el !== document.body ? el.scrollHeight + (innerHeight - el.clientHeight) : document.documentElement.scrollHeight;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(Math.max(h, size.height), 12000) });
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
      [...(el.labels ?? [])].some((l) => l.textContent.trim());
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), summary, [role="button"]')) {
      if (el.closest('[aria-hidden="true"], [inert]') || el.getClientRects().length === 0) continue;
      if (!named(el)) out.push(`unnamed ${el.tagName.toLowerCase()}`);
    }
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push(`duplicate id #${id} ×${n}`);
    for (const a of document.querySelectorAll('.about a[href]')) {
      const href = a.getAttribute('href') ?? '';
      if (!/^(https?:\/\/|\/|#)/.test(href)) out.push(`odd link ${href}`);
    }
    if (isPhone && document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`page overflows horizontally (${document.documentElement.scrollWidth}px)`);
    return out;
  }, phone);
  for (const p of problems) failures.push(`${label}: ${p}`);
}

async function open(page) {
  await page.goto(`${BASE}/about`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.about #licenses');
  await settle(page);
}

const text = (page, sel) => page.locator(sel).first().innerText();

async function facts(page) {
  const iso = await text(page, '#isolation');
  const source = await text(page, '.about section[aria-labelledby="source"]');
  if (EXPECT === 'offline') {
    check(/Proxy isolation: Unknown/.test(iso), `isolation shows Unknown while the server is unreachable (${iso.split('\n')[0]})`);
    check(/not reachable/.test(source), 'source offer explains the server is not reachable');
    return;
  }
  const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  const hero = await text(page, '.about .facts');
  check(hero.includes(cfg.version), `hero shows the server version ${cfg.version}`);
  if (EXPECT === 'isolated') {
    check(/Proxy isolation: On/.test(iso) && iso.includes(cfg.proxy.origin), `isolation On with the proxy origin (${cfg.proxy.origin})`);
    check(/run apart from GNOME/.test(await text(page, '.principles')), 'privacy principle states isolation (server isolated)');
  } else {
    check(/single-origin/.test(iso), 'isolation Off (single-origin mode)');
    check(/share GNOME’s origin/.test(await text(page, '.principles')), 'privacy principle states proxied pages share the origin');
  }
  if (cfg.source_url) check(await page.getByRole('link', { name: 'Get the source code' }).isVisible(), 'source link shown');
  else check(/GNOME_SOURCE_URL/.test(source), 'operator note about GNOME_SOURCE_URL');

  const served = await page.evaluate(() => fetch('/api/filters').then((r) => (r.ok ? r.json() : null)).catch(() => null));
  if (served?.lists?.length) {
    const names = [...served.lists, ...(served.resources ? [served.resources] : [])].map((l) => l.name);
    const shown = await page.locator('.about .group:has(.group-title:text-is("Filter lists")) .comp-name').allInnerTexts();
    check(
      names.length === shown.length && names.every((n) => shown.includes(n)),
      `filter lists are the ${names.length} the server distributes, resources included (${shown.length} shown)`,
    );
  }
}

async function structure(page) {
  const crates = await page.evaluate(() => {
    document.querySelector('.about details.crates')?.setAttribute('open', '');
    return { rows: document.querySelectorAll('.about .crate').length, count: Number(document.querySelector('.about .sum-count')?.textContent) };
  });
  check(crates.rows > 100 && crates.rows === crates.count, `crate table lists every crate version (${crates.rows} rows, count ${crates.count})`);
  // The built-in browser ships (Wave B): its engines are credited and its tab and page shortcuts are listed. Content
  // blocking and engine zoom are not offered on this page (no extensions feature; the engine has not started here).
  const groups = await page.locator('.about .group-title').allInnerTexts();
  check(groups.includes('Proxy engines and transports'), 'engines are listed now that the build ships the browser');
  check(!groups.includes('Content blocking'), 'content blocking is not listed while the build does not ship it');
  const shortcuts = await page.locator('.about section[aria-labelledby="shortcuts"] dt').allInnerTexts();
  check(
    shortcuts.includes('Command palette') && shortcuts.includes('New tab') && shortcuts.includes('Find in page') && !shortcuts.includes('Zoom in'),
    `shortcut reference lists working shortcuts only: shell, tabs and pages, no zoom before the engine offers it (${shortcuts.length})`,
  );
}

async function toc(page) {
  await page.locator('.about .toc a[href="#licenses"]').click();
  await page.waitForTimeout(600);
  const top = await page.evaluate(() => document.getElementById('licenses')?.getBoundingClientRect().top ?? -1);
  check(top >= 0 && top < 200 && page.url().endsWith('/about#licenses'), `table of contents scrolls to #licenses (top ${Math.round(top)})`);
}

mkdirSync(OUT, { recursive: true });
const browser = await (BROWSER === 'firefox' ? firefox : chromium).launch({ headless: true });
try {
  for (const theme of ['dark', 'light']) {
    for (const viewport of ['desktop', 'mobile']) {
      const { context, page } = await newPage(browser, theme, viewport);
      try {
        await open(page);
        await lint(page, `${theme}/${viewport}`, viewport === 'mobile');
        const tag = EXPECT === 'offline' ? '-offline' : '';
        await shot(page, `about-${theme}-${viewport}${tag}`);
        await shot(page, `about-${theme}-${viewport}${tag}-full`, true);
        if (theme === 'dark' && viewport === 'desktop') {
          await facts(page);
          await structure(page);
          await toc(page);
        }
      } catch (err) {
        failures.push(`${theme}/${viewport}: ${String(err?.message ?? err).split('\n')[0]}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}

console.log(`screenshots → ${SHOTS ? OUT : '(off)'}`);
for (const p of passes) console.log(`  ✓ ${p}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('all checks passed');
