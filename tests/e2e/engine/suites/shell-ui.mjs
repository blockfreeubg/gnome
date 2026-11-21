// Lane c (browser shell), real stack: visual QA of the browser view. Screenshots (dark/light × 1440x900 and
// 390x844) of real pages loaded through the engines, the tab strip, the address bar with suggestions, GNOME's
// context menu, the find bar, the downloads panel, the error overlay, the pop-up indicator and the update notice,
// with structural checks (no horizontal overflow, controls inside the viewport, no page errors).
//
// The update notice needs a waiting service worker; its screenshot sets the notice through the e2e hook
// (window.__gnomeBrowser) and is only a picture of the notice — shell-sw-update.mjs tests the real flow.
//
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-ui
import { activeTab, omnibox, openGnome, screenshot, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
];

async function setTheme(page, theme) {
  await page.evaluate((t) => window.__gnomeSettings.set('appearance', 'theme', t), theme);
  await page.waitForTimeout(200);
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function run(ctx) {
  const browser = await ctx.launch();
  const rec = (test, ok, notes) => ctx.record({ test: `shell-ui: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 600) });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      rec(name, false, String(e?.message ?? e).slice(0, 600));
    }
  };
  try {
    for (const vp of VIEWPORTS) {
      for (const theme of ['dark', 'light']) {
        const tag = `${vp.name}-${theme}`;
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: theme, acceptDownloads: true, ...(vp.mobile ? { isMobile: ctx.browser === 'chromium', hasTouch: true } : {}) });
        const { page, errors } = await openGnome(ctx, context);
        await setTheme(page, theme);
        await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');
        await screenshot(ctx, page, `${tag}-01-new-tab`);

        await step(`${tag} real pages and the tab strip`, async () => {
          await omnibox(page, 'example.com');
          await waitLoaded(page, /example\.com/, 60_000);
          if (!vp.mobile) {
            await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
          } else {
            await page.evaluate(() => window.__gnomeBrowser.newTab());
          }
          await omnibox(page, 'https://en.wikipedia.org/wiki/Gnome');
          const s = await waitLoaded(page, /wikipedia\.org/, 90_000);
          await page.waitForTimeout(2500); // let images and fonts settle
          await screenshot(ctx, page, `${tag}-02-wikipedia`);
          const ox = await overflowX(page);
          rec(`${tag} real pages and the tab strip`, s.tabs.length === 2 && ox <= 0, { tabs: s.tabs.map((t) => [t.title, t.engine]), overflowX: ox });
        });

        await step(`${tag} address bar suggestions`, async () => {
          const input = page.locator('input[data-omnibox]');
          await input.click();
          await input.fill('exam');
          await page.waitForTimeout(600);
          const listbox = page.getByRole('listbox');
          const n = await listbox.getByRole('option').count();
          await screenshot(ctx, page, `${tag}-03-omnibox`);
          rec(`${tag} address bar suggestions`, n >= 2, { options: n });
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
        });

        await step(`${tag} context menu`, async () => {
          const s = await state(page);
          const t = activeTab(s);
          const frame = await tabFrame(page, t.id);
          const link = frame.locator('#mw-content-text p a').first();
          await link.click({ button: 'right', timeout: 10_000 });
          const menu = page.getByRole('menu');
          await menu.waitFor({ timeout: 5000 });
          const items = await menu.getByRole('menuitem').allTextContents();
          await screenshot(ctx, page, `${tag}-04-context-menu`);
          rec(`${tag} context menu`, items.some((i) => /Open link in new tab/.test(i)) && items.some((i) => /Copy link address/.test(i)), items);
          await page.keyboard.press('Escape');
        });

        await step(`${tag} find bar`, async () => {
          await page.getByRole('button', { name: 'Browser menu' }).click();
          await page.getByRole('menuitem', { name: /Find in page/ }).click();
          const field = page.getByRole('searchbox', { name: 'Find in page' });
          await field.fill('gnome');
          await page.waitForTimeout(800);
          const count = await page.locator('.find .count').textContent();
          await screenshot(ctx, page, `${tag}-05-find`);
          rec(`${tag} find bar`, /\d+ of \d+/.test(count ?? ''), count);
          await field.press('Escape');
        });

        if (!vp.mobile) {
          await step(`${tag} downloads panel`, async () => {
            await page.getByRole('button', { name: 'Downloads', exact: true }).click();
            await page.getByRole('dialog', { name: 'Downloads' }).waitFor({ timeout: 5000 });
            await screenshot(ctx, page, `${tag}-06-downloads`);
            rec(`${tag} downloads panel`, true, '');
            await page.keyboard.press('Escape');
          });
        }

        await step(`${tag} pop-up indicator`, async () => {
          await page.evaluate(() => (window.__gnomeBrowser.downloadsOpen = false));
          const t = activeTab(await state(page));
          const frame = await tabFrame(page, t.id);
          // A pop-up the page asks for 6 s later, without any input: GNOME holds it back (privacy.defaultPermissions.popups = block).
          await frame.evaluate(() => setTimeout(() => window.open('https://example.org/', '_blank'), 6500));
          await waitState(page, (s) => activeTab(s)?.blockedPopups > 0, 15_000, 'blocked pop-up');
          const btn = page.getByRole('button', { name: /Pop-up blocked/ });
          await btn.click();
          await page.getByRole('dialog', { name: 'Blocked pop-ups' }).waitFor({ timeout: 5000 });
          await screenshot(ctx, page, `${tag}-07-popup-blocked`);
          rec(`${tag} pop-up indicator`, true, '');
          await page.keyboard.press('Escape');
        });

        await step(`${tag} error overlay`, async () => {
          await omnibox(page, 'https://gnome-e2e-unreachable.invalid/');
          await waitState(page, (s) => activeTab(s)?.error, 60_000, 'error');
          await screenshot(ctx, page, `${tag}-08-error`);
          rec(`${tag} error overlay`, await page.locator('.overlay[role="alert"]').isVisible(), '');
        });

        await step(`${tag} update notice`, async () => {
          await page.evaluate(() => (window.__gnomeBrowser.updateNotice = true));
          await page.waitForTimeout(500);
          await screenshot(ctx, page, `${tag}-09-update-notice`);
          rec(`${tag} update notice`, await page.getByText('GNOME was updated').isVisible(), '');
          await page.evaluate(() => (window.__gnomeBrowser.updateNotice = false));
        });

        if (vp.mobile) {
          await step(`${tag} tab switcher`, async () => {
            await page.getByRole('button', { name: /^\d+ open tabs?$/ }).click();
            await page.getByRole('dialog').first().waitFor({ timeout: 5000 });
            await page.waitForTimeout(400);
            await screenshot(ctx, page, `${tag}-10-tab-switcher`);
            rec(`${tag} tab switcher`, true, '');
            await page.keyboard.press('Escape');
          });
        }
        await step(`${tag} settings rows of the browser`, async () => {
          await page.goto(`${ctx.stack.appOrigin}/settings/privacy`);
          await page.locator('[data-row="privacy.webrtc"]').waitFor({ timeout: 15_000 });
          await page.locator('[data-row="privacy.webrtc"]').scrollIntoViewIfNeeded();
          await screenshot(ctx, page, `${tag}-11-settings-privacy`);
          await page.locator('[data-row="privacy.defaultPermissions"]').scrollIntoViewIfNeeded();
          await screenshot(ctx, page, `${tag}-12-settings-permissions`);
          await page.goto(`${ctx.stack.appOrigin}/settings/advanced`);
          await page.locator('[data-row="advanced.wispServers"]').scrollIntoViewIfNeeded();
          await screenshot(ctx, page, `${tag}-13-settings-wisp`);
          await page.goto(`${ctx.stack.appOrigin}/about#engine`);
          await page.locator('#engine').scrollIntoViewIfNeeded();
          await screenshot(ctx, page, `${tag}-14-about-engine`);
          rec(`${tag} settings rows of the browser`, await page.locator('#engine').isVisible(), '');
        });

        rec(`${tag} no page errors`, errors.length === 0, errors);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
