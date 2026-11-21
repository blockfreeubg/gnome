// Lane c (browser shell), real stack: the app's UI for the optional capabilities the engine host reports in its
// `init` result (ENGINE-PROTOCOL §4). The app shows that UI only for a reported capability, so each row first reads
// InitResult.capabilities and records a skip when the engine host does not offer it.
// - suggest: with browser.searchSuggestions on, a search typed into the address bar lists the provider's suggestions
//   (fetched by the engine host through Wisp, §6.12), shown as text;
// - selectAll, print: GNOME's page context menu offers them; Select all selects the page's text, Print… answers
//   without an error and leaves the engine host responsive;
// - saveLink: GNOME's link menu offers "Save link as…", and the browser saves the linked file;
// - siteData: Settings → Privacy → Clear data offers "Cookies and site data" once the engine host runs, and it removes
//   the site's cookies (HttpOnly too) from both engines' jars;
// - zoom with browser.defaultZoom: the Settings row appears, and a new tab opens at the default zoom.
// Cookies come from the runner's local target site, reachable only through the VPN profile route.
//
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-capabilities
import { activeTab, omnibox, openGnome, screenshot, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';
import { tabText } from '../lib/tab-read.mjs';

const EXAMPLE = /^https:\/\/example\.com\/?$/;
const QUIET_MS = 6000;

export async function run(ctx) {
  // window.print() is modal; headless Firefox has no print dialog and its print() never returns (the content
  // process stops, the app page with it), so Firefox prints silently to a PDF in the run directory (as host-capabilities).
  const browser = await ctx.launch(
    ctx.browser === 'firefox'
      ? {
          extraPrefs: {
            'print.always_print_silent': true,
            'print.show_print_progress': false,
            print_printer: 'Mozilla Save to PDF',
            'print.printer_Mozilla_Save_to_PDF.print_to_file': true,
            'print.printer_Mozilla_Save_to_PDF.print_to_filename': `${ctx.runDir}/shell-print-${ctx.browser}.pdf`,
          },
        }
      : undefined,
  );
  const rec = (test, ok, notes) => ctx.record({ test: `shell-capabilities: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 700) });
  const skip = (test, why) => ctx.record({ test: `shell-capabilities: ${test}`, result: 'skip', notes: why });
  let page = null;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      if (page && !page.isClosed()) await screenshot(ctx, page, `capabilities-fail-${name.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => {});
      rec(name, false, String(e?.message ?? e).slice(0, 700));
    }
  };
  try {
    const context = await ctx.newContext(browser);
    ({ page } = await openGnome(ctx, context));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');
    await omnibox(page, 'example.com');
    let s = await waitLoaded(page, EXAMPLE, 60_000);
    const caps = s.capabilities;
    ctx.log(`capabilities: ${caps.join(', ') || '(none)'}`);
    const logWarnings = () => page.evaluate(() => window.__gnomeBrowser.log.filter((l) => l.level !== 'debug').map((l) => l.message));

    await step('search suggestions in the address bar', async () => {
      if (!caps.includes('suggest')) return skip('search suggestions in the address bar', 'the engine host does not offer suggest');
      if (ctx.offline) return skip('search suggestions in the address bar', '--offline: the provider is on the internet');
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'searchSuggestions', true));
      const input = page.locator('input[data-omnibox]');
      await input.click();
      await input.fill('');
      await page.keyboard.type('wikipedia gnom', { delay: 40 });
      const group = page.locator('li.group-label', { hasText: /suggestions/ });
      await group.waitFor({ timeout: 15_000 });
      const id = await group.getAttribute('id');
      const items = (await page.locator(`[role="option"][aria-describedby="${id}"]`).allTextContents()).map((x) => x.trim());
      await screenshot(ctx, page, 'omnibox-suggestions');
      rec('search suggestions in the address bar (through the engine host, shown as text)', items.length >= 1 && items.every((x) => x.length > 0 && x.length <= 256), { group: await group.textContent(), items });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'searchSuggestions', false));
    });

    const pageMenu = async () => {
      // The page's empty top-left corner (example.com has its only link at the bottom centre).
      const fe = await page.locator('iframe.engine-frame').boundingBox();
      await page.mouse.click(fe.x + 24, fe.y + 24, { button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ timeout: 5000 });
      return menu;
    };

    await step('Select all from the page menu', async () => {
      if (!caps.includes('selectAll')) return skip('Select all from the page menu', 'the engine host does not offer selectAll');
      const t = activeTab(await state(page));
      const frame = await tabFrame(page, t.id);
      await frame.evaluate(() => getSelection()?.removeAllRanges());
      const menu = await pageMenu();
      await menu.getByRole('menuitem', { name: /^Select all/ }).click();
      let selected = 0;
      for (let i = 0; i < 25 && !selected; i++) {
        selected = await frame.evaluate(() => (getSelection()?.toString() ?? '').length);
        if (!selected) await page.waitForTimeout(200);
      }
      rec('Select all from GNOME’s page menu selects the page’s text', selected > 50, { selected });
      await frame.evaluate(() => getSelection()?.removeAllRanges());
    });

    // Before Print… (which reloads the tab): playwright's Firefox can stop answering in a reloaded Scramjet frame (A15).
    await step('Save link as… from the link menu', async () => {
      if (!caps.includes('saveLink')) return skip('Save link as… from the link menu', 'the engine host does not offer saveLink');
      const t = activeTab(await state(page));
      const frame = await tabFrame(page, t.id);
      const box = await frame.locator('a').first().boundingBox();
      if (!box) throw new Error("example.com's link has no box");
      const downloads = [];
      const onDownload = (d) => downloads.push(d);
      page.on('download', onDownload);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ timeout: 5000 });
      await menu.getByRole('menuitem', { name: /^Save link as/ }).click();
      for (let i = 0; i < 100 && !downloads.length; i++) await page.waitForTimeout(200);
      page.off('download', onDownload);
      const d = downloads[0];
      let bytes = null;
      if (d) {
        const file = await d.path().catch(() => null);
        bytes = file ? (await import('node:fs')).statSync(file).size : null;
      }
      rec('Save link as… from GNOME’s link menu: the browser saves the linked file', !!d && bytes > 0, { name: d?.suggestedFilename() ?? null, bytes, downloads: downloads.length });
    });

    await step('Print… from the page menu', async () => {
      if (!caps.includes('print')) return skip('Print… from the page menu', 'the engine host does not offer print');
      const before = (await logWarnings()).length;
      const menu = await pageMenu();
      await menu.getByRole('menuitem', { name: /^Print/ }).click();
      await page.waitForTimeout(1500);
      const warnings = (await logWarnings()).slice(before).filter((m) => /tab\.action/.test(m));
      // The engine host still answers (a print dialog must not leave it hanging): a reload completes.
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      s = await waitLoaded(page, EXAMPLE, 30_000);
      rec('Print… from GNOME’s page menu answers without an error; the engine host stays responsive', warnings.length === 0 && s.engineState === 'ready', { warnings, engine: s.engineState });
    });

    await step('default zoom for new tabs', async () => {
      if (!caps.includes('zoom')) return skip('default zoom for new tabs', 'the engine host does not offer zoom');
      const t1 = activeTab(await state(page));
      const f1 = await tabFrame(page, t1.id);
      const w1 = await f1.evaluate(() => innerWidth);
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'defaultZoom', 1.25));
      await page.getByRole('button', { name: 'New tab', exact: true }).click();
      await waitState(page, (x) => x.tabs.length === 2 && activeTab(x)?.url === null, 10_000, 'new tab');
      await omnibox(page, 'example.com');
      s = await waitLoaded(page, EXAMPLE, 60_000);
      const t2 = activeTab(s);
      const f2 = await tabFrame(page, t2.id);
      const w2 = await f2.evaluate(() => innerWidth);
      // Zoom lays the page out like browser zoom: 1.25 leaves the page 1/1.25 of the width at 1.
      rec('a new tab opens at the default zoom (Settings → Browser → Default zoom)', t2.zoom === 1.25 && Math.abs(w2 - w1 / 1.25) <= 3, { zoom: t2.zoom, w1, w2 });
      await page.evaluate(() => window.__gnomeSettings.set('browser', 'defaultZoom', 1));
      await page.locator(`[data-tab="${t2.id}"] .close`).click({ force: true });
      await waitState(page, (x) => x.tabs.length === 1, 5000, 'one tab again');
    });

    await step('clear cookies and site data from Settings', async () => {
      if (!caps.includes('siteData')) return skip('clear cookies and site data from Settings', 'the engine host does not offer siteData');
      if (!ctx.stack?.target) return skip('clear cookies and site data from Settings', 'the runner started no target site');
      const target = ctx.stack.target.origin;
      await page.evaluate((id) => {
        const st = window.__gnomeSettings;
        st.set('vpn', 'mode', 'gateway');
        st.set('vpn', 'preferredLocation', id);
      }, ctx.stack.profiles.live);
      await page.waitForTimeout(800);
      const cookies = async () => {
        await omnibox(page, `${target}/cookies`);
        const x = await waitLoaded(page, /\/cookies$/, 60_000);
        // Read through the engine host (lib/tab-read.mjs): playwright's Firefox stops answering in a Scramjet tab
        // frame after that frame was reloaded (worklist A15; the page itself is fine).
        return JSON.parse((await tabText(page, activeTab(x).id, '#out', { timeout: 10_000 })) ?? '{}').cookies ?? {};
      };
      await omnibox(page, `${target}/cookies/set?gnomesite=1`);
      await waitLoaded(page, /\/cookies$/, 60_000);
      const set = await cookies();
      // To Settings inside the app (the engine host keeps running: the clearer exists only while it does).
      await page.locator('a[href="/settings"]').first().click();
      await page.waitForFunction(() => location.pathname.startsWith('/settings'));
      await page.locator('a[href="/settings/privacy"]').first().click();
      await page.getByRole('button', { name: /Clear data/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Clear browsing data' });
      await dialog.waitFor({ timeout: 5000 });
      const option = dialog.getByRole('checkbox', { name: /Cookies and site data/ });
      if (!(await option.count())) throw new Error('no "Cookies and site data" option in the dialog');
      // All time (site data has no time range), and only this category.
      await dialog.getByRole('combobox').first().click();
      await page.getByRole('option', { name: 'All time' }).click();
      for (const box of await dialog.getByRole('checkbox').all()) {
        const name = await box.evaluate((el) => el.labels?.[0]?.textContent ?? '');
        const want = /Cookies and site data/.test(name);
        // The styled box sits over the native input: set it through the input itself.
        if (!(await box.isDisabled()) && (await box.isChecked()) !== want) await box.setChecked(want, { force: true });
      }
      await screenshot(ctx, page, 'clear-site-data-dialog');
      if (!(await option.isChecked())) throw new Error('"Cookies and site data" could not be chosen');
      await dialog.getByRole('button', { name: 'Clear data', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 });
      await page.locator('a[href="/browse"]').first().click();
      await page.waitForFunction(() => location.pathname === '/browse');
      const after = await cookies();
      rec(
        'Settings → Clear data → "Cookies and site data" removes the sites’ cookies (HttpOnly too)',
        set.gnomesite === '1' && set.srvhttp === '1' && !('gnomesite' in after) && !('srvhttp' in after),
        { set, after },
      );
      await page.evaluate(() => window.__gnomeSettings.set('vpn', 'mode', 'off'));
    });

    rec('no page errors in the app', errors.length === 0, errors);
    await context.close();
  } finally {
    await browser.close();
  }
}
