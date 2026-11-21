// Lane c (browser shell), real stack: tabs and navigation through GNOME's own UI (docs/WAVE-B.md §4 Tests): open,
// switch and close tabs, navigate from the address bar, back/forward/reload through the toolbar, the error overlay
// and "open with the other engine", session restore after an app reload, engine-host reload recovery
// (top[0].location.reload() from a proxied page), "Restart browser engine", the keyboard-only paths, and "did not
// start" (the engine host's scripts blocked by GNOME_PROXY_CSP) with Retry, history.length unchanged throughout, and
// a late first hello (the engine host's script delayed past TIMEOUTS.helloWaitMs) that still connects.
//
// Runs under tests/e2e/engine/run.mjs (lane b's runner: gnome-server + HolyWisp + the e2e build):
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-browse
import { activeTab, omnibox, openGnome, screenshot, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';

const EXAMPLE = /^https:\/\/example\.com\/?$/;

/** The engine host is ready and the active tab, re-created by it, finished loading a page matching `re`. */
const waitReadyLoaded = (page, re, timeout = 60_000) =>
  waitState(page, (x) => {
    const t = activeTab(x);
    return x.engineState === 'ready' && t && t.live && !t.loading && t.url && re.test(t.url) ? x : null;
  }, timeout, `engine ready and ${re} loaded`);

export async function run(ctx) {
  const browser = await ctx.launch();
  const rec = (test, ok, notes, extra = {}) => ctx.record({ test: `shell: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 700), ...extra });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      rec(name, false, String(e?.message ?? e).slice(0, 700));
    }
  };
  try {
    const context = await ctx.newContext(browser);
    const { page, errors } = await openGnome(ctx, context);
    let s = await waitState(page, (x) => x.tabs.length >= 1, 15_000, 'a first tab');
    rec('the browser view opens with a new tab', s.tabs.length === 1 && activeTab(s)?.url === null, s);
    const historyAtStart = s.historyLength;

    await step('navigate from the address bar (example.com)', async () => {
      await omnibox(page, 'example.com');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const t = activeTab(s);
      const frame = await tabFrame(page, t.id);
      // The page itself, read in the tab frame (example.com's markup changes over time: its title and its text about
      // documentation examples are what stays).
      const page1 = await frame
        .evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 400), proxied: location.origin }))
        .catch(async (e) => {
          ctx.log(`frames: ${page.frames().map((f) => `${f.name()}=${f.url().slice(0, 90)}`).join(' | ')}`);
          await screenshot(ctx, page, 'example-unreadable');
          throw e;
        });
      rec(
        'navigate from the address bar (example.com)',
        /Example Domain/.test(page1.title) && /documentation/i.test(page1.text) && page1.proxied === ctx.stack.proxyOrigin && /Example Domain/.test(t.title) && !t.error,
        { title: t.title, page: page1, engine: t.engine },
        { engine: t.engine },
      );
      await screenshot(ctx, page, 'example');
    });

    await step('back and forward through the toolbar', async () => {
      await omnibox(page, 'https://example.org/');
      s = await waitLoaded(page, /example\.org/, 60_000);
      const before = activeTab(s);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const back = activeTab(s);
      await page.getByRole('button', { name: 'Forward', exact: true }).click();
      s = await waitLoaded(page, /example\.org/, 60_000);
      const fwd = activeTab(s);
      rec(
        'back and forward through the toolbar',
        before.entries.length === 2 && back.index === 0 && fwd.index === 1 && fwd.canGoBack && !fwd.canGoForward,
        { before: [before.entries, before.index], back: [back.entries, back.index], fwd: [fwd.entries, fwd.index] },
      );
    });

    await step('reload through the toolbar', async () => {
      const t = activeTab(await state(page));
      const frame = await tabFrame(page, t.id);
      await frame.evaluate(() => (window.__shellMark = 1)).catch(() => {});
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      s = await waitLoaded(page, /example\.org/, 60_000);
      await new Promise((r) => setTimeout(r, 500));
      const f2 = await tabFrame(page, t.id);
      const mark = await f2.evaluate(() => window.__shellMark ?? null).catch(() => 'gone');
      const after = activeTab(s);
      rec('reload through the toolbar', mark === null && after.entries.length === 2 && after.index === 1, { mark, entries: after.entries });
    });

    await step('open, switch and close tabs', async () => {
      await page.getByRole('button', { name: 'New tab', exact: true }).click();
      s = await waitState(page, (x) => x.tabs.length === 2 && activeTab(x)?.url === null, 10_000, 'second tab');
      await omnibox(page, 'example.com');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const [first, second] = s.tabs;
      await page.locator(`[data-tab="${first.id}"]`).click();
      s = await waitState(page, (x) => x.active === first.id, 5000, 'switch');
      const switched = activeTab(s).url;
      await page.locator(`[data-tab="${second.id}"] .close`).click({ force: true });
      s = await waitState(page, (x) => x.tabs.length === 1, 5000, 'close');
      rec('open, switch and close tabs', /example\.org/.test(switched) && s.tabs[0].id === first.id && s.closed >= 1, { switched, tabs: s.tabs.map((t) => t.url), closed: s.closed });
      await screenshot(ctx, page, 'tabs');
    });

    await step('background tabs unloaded on switch (performance.backgroundTabs = discard) and restored', async () => {
      await page.evaluate(() => window.__gnomeSettings.set('performance', 'backgroundTabs', 'discard'));
      const first = activeTab(await state(page));
      await page.getByRole('button', { name: 'New tab', exact: true }).click();
      await omnibox(page, 'example.com');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const second = activeTab(s);
      s = await waitState(page, (x) => x.tabs.find((t) => t.id === first.id)?.discarded === true, 10_000, 'first tab discarded');
      const gone = s.tabs.find((t) => t.id === first.id);
      await page.locator(`[data-tab="${first.id}"]`).click();
      s = await waitLoaded(page, /example\.org/, 60_000);
      const back = activeTab(s);
      const secondNow = s.tabs.find((t) => t.id === second.id);
      rec(
        'background tabs unloaded on switch and restored from their entries',
        !gone.live && back.live && JSON.stringify(back.entries) === JSON.stringify(first.entries) && back.index === first.index && secondNow.discarded,
        { gone: [gone.live, gone.discarded], back: [back.entries, back.index], first: [first.entries, first.index] },
      );
      await page.evaluate(() => window.__gnomeSettings.set('performance', 'backgroundTabs', 'keep-alive'));
      await page.locator(`[data-tab="${second.id}"] .close`).click({ force: true });
      await waitState(page, (x) => x.tabs.length === 1, 5000, 'one tab again');
    });

    await step('error overlay for an unreachable site, Retry, and open with the other engine', async () => {
      await omnibox(page, 'https://gnome-e2e-unreachable.invalid/');
      s = await waitState(page, (x) => activeTab(x)?.error, 60_000, 'error overlay');
      const t = activeTab(s);
      const overlay = page.locator('.overlay[role="alert"]');
      const shown = await overlay.isVisible();
      const title = await overlay.locator('h2').textContent();
      await screenshot(ctx, page, 'error-overlay');
      rec('error overlay for an unreachable site', shown && t.error.kind === 'network' && /reach/i.test(title ?? ''), { error: t.error, title });
      // With the automatic fallback on, the engine host already retried on Ultraviolet (fallback: attempted). With it
      // off, the overlay offers the other engine.
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'autoFallback', false));
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      s = await waitState(page, (x) => activeTab(x)?.error?.fallback === 'available', 60_000, 'fallback available');
      const first = activeTab(s).error;
      const other = page.getByRole('button', { name: /Open with (Ultraviolet|Scramjet)/ });
      await other.click();
      s = await waitState(page, (x) => activeTab(x)?.error && activeTab(x).engine !== 'scramjet', 60_000, 'other engine error');
      rec('"Open with Ultraviolet" (automatic fallback off) loads the address with the other engine', activeTab(s).engine === 'ultraviolet', { first, second: activeTab(s).error, engine: activeTab(s).engine });
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'autoFallback', true));
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      s = await waitState(page, (x) => activeTab(x)?.error, 60_000, 'retry error');
      rec('Retry loads the address again', !!activeTab(s).error, activeTab(s).error);
    });

    await step('session restore after an app reload (real URLs and entries)', async () => {
      // Back to a working page first, with two entries.
      await omnibox(page, 'example.com');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const before = await state(page);
      await new Promise((r) => setTimeout(r, 1500)); // the session is written ~0.8 s after a change
      await page.reload();
      await page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const urls = (x) => x.tabs.map((t) => t.url);
      const entries = (x) => x.tabs.map((t) => t.entries);
      rec(
        'session restore after an app reload (real URLs and entries)',
        JSON.stringify(urls(s)) === JSON.stringify(urls(before)) && JSON.stringify(entries(s)) === JSON.stringify(entries(before)),
        { before: entries(before), after: entries(s) },
      );
    });

    await step('engine-host reload recovery and history.length', async () => {
      s = await state(page);
      const h0 = s.historyLength;
      const t = activeTab(s);
      const frame = await tabFrame(page, t.id);
      await frame.evaluate(() => top[0].location.reload());
      s = await waitState(page, (x) => (x.counters?.unexpectedLoads ?? 0) >= 1, 20_000, 'unexpected load counted');
      // Until the new engine host's init, the tab keeps its flags from before the reset: wait for ready first.
      s = await waitReadyLoaded(page, EXAMPLE);
      rec(
        'engine-host reload recovery (unexpected load → fresh iframe, tabs restored)',
        s.counters.unexpectedLoads === 1 && activeTab(s).entries.length >= 1 && s.engineState === 'ready',
        { counters: s.counters, tab: activeTab(s) },
      );
      rec('history.length unchanged after the recovery', s.historyLength === h0, { before: h0, after: s.historyLength, atStart: historyAtStart });
    });

    await step('"Restart browser engine" keeps history.length', async () => {
      s = await state(page);
      const h0 = s.historyLength;
      await page.getByRole('button', { name: 'Browser menu' }).click();
      await page.getByRole('menuitem', { name: 'Restart browser engine' }).click();
      s = await waitState(page, (x) => x.engineState !== 'ready', 5000, 'restart begins').catch(() => null);
      s = await waitReadyLoaded(page, EXAMPLE);
      rec('"Restart browser engine" keeps history.length', s.historyLength === h0 && s.counters.unexpectedLoads === 1, { before: h0, after: s.historyLength, counters: s.counters });
    });

    await step('keyboard only: address bar, new tab, tab strip', async () => {
      // DESIGN.md §1.6 "full keyboard operation", with the default bindings (Alt+L, Alt+T, Alt+W).
      s = await state(page);
      const tabs0 = s.tabs.length;
      // The focus in GNOME's own document (the page's keys are forwarded and covered by shell-input).
      await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
      await page.keyboard.press('Alt+l');
      const inOmnibox = await page.evaluate(() => document.activeElement?.hasAttribute('data-omnibox') ?? false);
      await page.keyboard.type('example.org');
      await page.keyboard.press('Enter');
      s = await waitLoaded(page, /example\.org/, 60_000);
      await page.keyboard.press('Alt+t');
      await waitState(page, (x) => x.tabs.length === tabs0 + 1 && activeTab(x)?.url === null, 10_000, 'new tab from the keyboard');
      const newTabFocus = await page.evaluate(() => document.activeElement?.hasAttribute('data-omnibox') ?? false);
      await page.keyboard.type('example.com');
      await page.keyboard.press('Enter');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const second = activeTab(s);
      // The tab strip: one tab stop (the active tab), arrows move and activate, Delete closes.
      await page.locator('[role="tab"][aria-selected="true"]').focus();
      await page.keyboard.press('ArrowLeft');
      s = await waitState(page, (x) => x.active !== second.id, 5000, 'previous tab');
      const movedTo = s.active;
      const focusedTab = await page.evaluate(() => document.activeElement?.getAttribute('data-tab'));
      await page.keyboard.press('ArrowRight');
      s = await waitState(page, (x) => x.active === second.id, 5000, 'back to the new tab');
      await page.keyboard.press('Delete');
      s = await waitState(page, (x) => x.tabs.length === tabs0, 5000, 'closed with Delete');
      rec(
        'keyboard only: Alt+L focuses the address bar, Alt+T opens a tab with the focus there, arrows and Delete work the tab strip',
        inOmnibox && newTabFocus && focusedTab === String(movedTo) && !s.tabs.some((t) => t.id === second.id),
        { inOmnibox, newTabFocus, focusedTab, movedTo, tabs: s.tabs.length },
      );
    });

    await step('"did not start" and Retry keep history.length', async () => {
      // The operator's second engine-host policy (GNOME_PROXY_CSP can only restrict) blocks every script there, so
      // the next engine host never says hello: after TIMEOUTS.helloWaitMs the view offers Retry (ENGINE-PROTOCOL §2.2).
      await ctx.stack.restartServer({ GNOME_PROXY_CSP: "script-src 'none'" });
      let restored = false;
      try {
        await page.getByRole('button', { name: 'Browser menu' }).click();
        await page.getByRole('menuitem', { name: 'Restart browser engine' }).click();
        s = await waitState(page, (x) => x.engineState === 'failed', 40_000, 'engine did not start');
        const panel = page.locator('.engine-state');
        const said = (await panel.locator('h2').textContent()) ?? '';
        await screenshot(ctx, page, 'engine-did-not-start');
        const h0 = s.historyLength;
        const shown = activeTab(s)?.url ?? '';
        await ctx.stack.restartServer({});
        restored = true;
        await panel.getByRole('button', { name: 'Retry', exact: true }).click();
        // The page the tab showed before (the keyboard row left it on example.org).
        s = await waitReadyLoaded(page, new RegExp(`^${shown.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`));
        rec('"The browser engine did not start" shows Retry, which starts it again', /did not start/.test(said) && s.engineState === 'ready', { said, engine: s.engineState });
        rec('Retry keeps history.length (a fresh iframe adds no entry)', s.historyLength === h0, { before: h0, after: s.historyLength });
      } finally {
        if (!restored) await ctx.stack.restartServer({}).catch(() => {});
      }
    });

    await step('a late first hello still connects after "did not start"', async () => {
      // ENGINE-PROTOCOL §2.2 step 5 (HelloContext.expecting): the engine host's own script reaches the browser 23 s
      // late (after TIMEOUTS.helloWaitMs = 20 s), so its first hello comes after the app showed "did not start". The
      // same, never-connected iframe must connect then (failed → connecting → ready), with no compromise signal and no
      // replaced iframe. A fresh context: no service worker controls the engine-host page yet, so the route sees it.
      const late = await ctx.newContext(browser);
      try {
        let delayed = 0;
        await late.route('**/assets/engine-*.js', async (route) => {
          delayed++;
          await new Promise((r) => setTimeout(r, 23_000));
          await route.continue().catch(() => {});
        });
        const { page: p2, errors: errors2 } = await openGnome(ctx, late);
        await omnibox(p2, 'example.com');
        let x = await waitState(p2, (v) => v.engineState === 'failed', 30_000, 'did not start');
        const failed = { detail: x.engineDetail, frames: await p2.locator('iframe[src*="/engine/"]').count() };
        await screenshot(ctx, p2, 'late-hello-failed');
        x = await waitReadyLoaded(p2, EXAMPLE, 60_000);
        const frames = await p2.locator('iframe[src*="/engine/"]').count();
        await screenshot(ctx, p2, 'late-hello-connected');
        rec(
          'a late first hello from the same iframe connects after "did not start" (no compromise signal, no new iframe)',
          // counters stays null until the client counts something (onCounters fires only on a change): null = all zero.
          delayed === 1 && /did not start/.test(failed.detail ?? '') && x.engineState === 'ready' && (x.counters?.unexpectedHellos ?? 0) === 0 && (x.counters?.unexpectedLoads ?? 0) === 0 && failed.frames === 1 && frames === 1 && errors2.length === 0,
          { delayed, failed, frames, counters: x.counters, errors: errors2 },
        );
      } finally {
        await late.close();
      }
    });

    rec('no page errors in the app', errors.length === 0, errors);
    await context.close();
  } finally {
    await browser.close();
  }
}
