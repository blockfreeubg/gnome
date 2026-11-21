// Lane c (browser shell) helpers for the shell-*.mjs suites.
//
// The suites follow the suite contract of tests/e2e/engine/run.mjs (docs/WAVE-B.md §3: `export async function
// run(ctx)`). Until that runner exists, and for quick runs of one suite, `standaloneCtx()` builds the parts of ctx a
// suite needs from playwright-core and the cached browsers (chromium-1248, firefox-1555), and `runStandalone()` runs
// a suite in both browsers and prints the records:
//
//   node tests/e2e/engine/suites/shell-activation.mjs [--browser chromium|firefox|all]
//
// Ports come from the environment (SHELL_E2E_PORT_BASE, default E2E_PORT_BASE + 210: tests/e2e/engine/lib/ports.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, firefox } from 'playwright-core';
import { suitePortBase } from '../lib/ports.mjs';

export const BROWSERS = ['chromium', 'firefox'];

export function portBase() {
  return suitePortBase('shell');
}

export async function launchBrowser(name, opts = {}) {
  if (name === 'chromium') {
    const o = { headless: true, args: opts.args ?? [] };
    if (process.env.CHROMIUM_EXECUTABLE) o.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else o.channel = 'chromium'; // the full chromium-1248 in the new headless mode
    return chromium.launch(o);
  }
  if (name === 'firefox') {
    const o = { headless: true, firefoxUserPrefs: { 'devtools.jsonview.enabled': false, ...(opts.prefs ?? {}) } };
    if (process.env.FIREFOX_EXECUTABLE) o.executablePath = process.env.FIREFOX_EXECUTABLE;
    return firefox.launch(o);
  }
  throw new Error(`unknown browser ${name}`);
}

/**
 * A small static server: `routes` maps a path to `{type, body, headers?}` (or a function of the request returning
 * one). Answers 404 for anything else. Resolves to `{origin, close()}`.
 */
export function staticServer(host, port, routes) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    let r = routes[path];
    if (typeof r === 'function') r = r(req);
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': r.type, 'cache-control': 'no-store', ...(r.headers ?? {}) });
    res.end(r.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () =>
      resolve({
        origin: `http://${host}:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

export function standaloneCtx(browser, suite, runDir) {
  const records = [];
  return {
    browser,
    suite,
    runDir,
    records,
    launch: (opts) => launchBrowser(browser, opts),
    newContext: (b) => b.newContext({ viewport: { width: 1280, height: 860 } }),
    record(r) {
      records.push({ browser, ...r });
      const mark = r.result === 'pass' ? 'PASS' : r.result === 'skip' ? 'SKIP' : 'FAIL';
      console.log(`[${browser}] ${mark} ${r.test}${r.notes ? ` — ${r.notes}` : ''}`);
    },
    log: (...m) => console.log(`[${browser}]`, ...m),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Runs `run(ctx)` in the browsers named by --browser (default both); exits 1 when a record failed. */
export async function runStandalone(suite, run) {
  const i = process.argv.indexOf('--browser');
  const which = i > 0 ? process.argv[i + 1] : 'all';
  const browsers = which === 'all' ? BROWSERS : which.split(',');
  const runDir = process.env.SHELL_E2E_RUN_DIR || join(process.cwd(), `shell-e2e-${suite}-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const all = [];
  for (const b of browsers) {
    const ctx = standaloneCtx(b, suite, runDir);
    try {
      await run(ctx);
    } catch (err) {
      ctx.record({ test: 'suite crashed', result: 'fail', notes: String(err?.stack ?? err) });
    }
    all.push(...ctx.records);
  }
  writeFileSync(join(runDir, 'records.json'), JSON.stringify(all, null, 2));
  const failed = all.filter((r) => r.result === 'fail').length;
  const passed = all.filter((r) => r.result === 'pass').length;
  console.log(`\n${suite}: ${passed} passed, ${failed} failed, ${all.length - passed - failed} skipped (${runDir}/records.json)`);
  process.exitCode = failed ? 1 : 0;
}

// ── The real GNOME app on the real stack (ctx.stack from tests/e2e/engine/run.mjs) ──────────────────────────────

/**
 * Opens the GNOME app at `path` (default /browse). Note: playwright-core's page.evaluate runs with a user gesture,
 * which gives the app document transient activation for 5 s; suites that test activation-gated behaviour (pop-ups,
 * privileged forwarded shortcuts) wait that out before the real input (shell-activation.mjs found this).
 */
export async function openGnome(ctx, context, path = '/browse', { waitBrowser = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(`${ctx.stack.appOrigin}${path}`);
  if (waitBrowser) await page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
  return { page, errors };
}

/** A plain snapshot of the browser state (e2e builds expose window.__gnomeBrowser). */
export function state(page) {
  return page.evaluate(() => {
    const b = window.__gnomeBrowser;
    if (!b) return null;
    return {
      engineState: b.engineState,
      engineDetail: b.engineDetail,
      active: b.model.activeId,
      tabs: b.model.tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        loading: t.loading,
        live: t.live,
        discarded: t.discarded,
        engine: t.engine,
        error: t.error ? { kind: t.error.kind, signal: t.error.signal, fallback: t.error.fallback, url: t.error.url } : null,
        entries: [...t.entries],
        index: t.index,
        canGoBack: t.canGoBack,
        canGoForward: t.canGoForward,
        pinned: t.pinned,
        blockedPopups: t.blockedPopups.length,
        zoom: t.zoom,
        fullscreen: t.fullscreen,
        openedByPage: t.openedByPage,
      })),
      closed: b.model.closed.length,
      sw: b.status ? { ...b.status.sw } : null,
      transport: b.status
        ? Object.fromEntries(Object.entries(b.status.transport).map(([k, v]) => [k, { state: v.state, transport: v.transport, endpoint: v.endpoint, detail: v.detail }]))
        : null,
      counters: b.counters ? { ...b.counters } : null,
      ticketNotice: b.ticketNotice,
      updateNotice: b.updateNotice,
      capabilities: b.capabilities ? [...b.capabilities] : [],
      historyLength: history.length,
    };
  });
}

/** Polls state(page) until `pred(state)` is truthy; returns that state. */
export async function waitState(page, pred, timeout = 30_000, what = 'state') {
  const end = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await state(page);
    try {
      if (last && pred(last)) return last;
    } catch {
      /* keep polling */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const activeTab = (s) => s?.tabs.find((t) => t.id === s.active) ?? null;

/** Types into the address bar and presses Enter (real input). */
export async function omnibox(page, text, { newTab = false } = {}) {
  const input = page.locator('input[data-omnibox]');
  await input.click();
  await input.fill(text);
  await page.keyboard.press(newTab ? 'Alt+Enter' : 'Enter');
}

/** The tab frame of an engine tab (`tab-<id>` inside the engine iframe). */
export async function tabFrame(page, tabId, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const f = page.frames().find((x) => x.name() === `tab-${tabId}`);
    if (f) return f;
    if (Date.now() > end) throw new Error(`tab frame tab-${tabId} not found`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Waits until the active tab finished loading a page whose URL matches `re`. */
export function waitLoaded(page, re, timeout = 45_000) {
  return waitState(page, (s) => {
    const t = activeTab(s);
    return t && !t.loading && t.url && re.test(t.url) && t.live ? s : null;
  }, timeout, `active tab loaded ${re}`);
}

export async function screenshot(ctx, page, name) {
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(ctx.runDir, 'shell-shots');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ctx.browser}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
