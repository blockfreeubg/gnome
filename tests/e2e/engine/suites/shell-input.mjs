// Lane c (browser shell), real stack: input that starts in a proxied page (docs/WAVE-B.md §4 Tests): pop-ups with
// and without a gesture and the pop-up indicator (ENGINE-PROTOCOL §6.3, decideOpen with the app document's own
// activation), GNOME's context menu and its items (§6.8), forwarded shortcuts, ordinary and privileged (§6.7), and
// page fullscreen (§6.10).
//
// Pages come from the runner's local target site, reachable only through the VPN profile `e2e-vpn`: the suite turns
// the VPN gateway on in GNOME's settings, which also exercises the profile route of the settings snapshot.
//
// Activation: playwright-core's evaluate runs with a user gesture that activates the documents for 5 s
// (shell-activation.mjs), so before every activation-sensitive input the suite waits that out (`quiet`).
//
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-input
import { activeTab, omnibox, openGnome, screenshot, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';
import { tabGlobal } from '../lib/tab-read.mjs';

const QUIET_MS = 6000;

export async function run(ctx) {
  if (!ctx.stack?.target) {
    ctx.record({ test: 'shell-input: target site', result: 'skip', notes: 'the runner started no target site' });
    return;
  }
  const target = ctx.stack.target.origin;
  const browser = await ctx.launch();
  const rec = (test, ok, notes) => ctx.record({ test: `shell-input: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 700) });
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      rec(name, false, String(e?.message ?? e).slice(0, 700));
    }
  };
  const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));
  try {
    const context = await ctx.newContext(browser);
    const { page, errors } = await openGnome(ctx, context);
    await page.evaluate((id) => {
      const s = window.__gnomeSettings;
      s.set('vpn', 'mode', 'gateway');
      s.set('vpn', 'preferredLocation', id);
    }, ctx.stack.profiles.live);
    await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');

    await step('profile route reaches the target site', async () => {
      await omnibox(page, `${target}/popup`);
      const s = await waitLoaded(page, /\/popup$/, 60_000);
      rec('the VPN profile route reaches the target site', !!activeTab(s), activeTab(s));
    });

    await step('a target=_blank link clicked by the user opens a tab in front', async () => {
      const s0 = await state(page);
      const opener = activeTab(s0);
      const frame = await tabFrame(page, opener.id);
      const box = await frame.locator('#blank').boundingBox();
      await quiet();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const s = await waitState(page, (x) => x.tabs.length === s0.tabs.length + 1, 15_000, 'new tab');
      const t = activeTab(s);
      rec('a target=_blank link clicked by the user opens a tab in front', t.id !== opener.id && s.tabs.some((x) => x.id === t.id), { active: t, tabs: s.tabs.length });
      // Back to the opener.
      await page.locator(`[data-tab="${opener.id}"]`).click();
      await waitState(page, (x) => x.active === opener.id, 5000, 'opener active');
    });

    await step('a pop-up without a gesture waits behind the indicator', async () => {
      const s0 = await state(page);
      const opener = activeTab(s0);
      const frame = await tabFrame(page, opener.id);
      // A scripted click 6.5 s later: neither the page nor the app document has activation by then.
      await frame.evaluate(() => setTimeout(() => document.getElementById('open').click(), 6500));
      const s = await waitState(page, (x) => activeTab(x)?.blockedPopups === 1, 15_000, 'blocked pop-up');
      rec('a pop-up without a gesture is held back (no tab, the indicator shows)', s.tabs.length === s0.tabs.length, { tabs: s.tabs.length, blocked: activeTab(s).blockedPopups });
      await page.getByRole('button', { name: /Pop-up blocked/ }).click();
      await page.getByRole('dialog', { name: 'Blocked pop-ups' }).getByRole('button', { name: 'Open in new tab' }).click();
      const s2 = await waitState(page, (x) => x.tabs.length === s0.tabs.length + 1, 15_000, 'opened from the indicator');
      await waitLoaded(page, /title-change/, 60_000);
      rec('opening it from the indicator (a click in GNOME) opens the tab', activeTab(s2) !== null, { tabs: s2.tabs.map((t) => t.url) });
      await page.locator(`[data-tab="${opener.id}"]`).click();
      await waitState(page, (x) => x.active === opener.id, 5000, 'opener active');
    });

    await step('one click opens one tab: the rest of a burst waits behind the indicator', async () => {
      const s0 = await state(page);
      const opener = activeTab(s0);
      const frame = await tabFrame(page, opener.id);
      const blocked0 = opener.blockedPopups;
      // The button's own handler opens one window; this listener three more, all in the same click (security review,
      // integration part 2: a burst like that opened 3 GNOME tabs). The evaluate's own activation runs out first.
      await frame.evaluate(() =>
        document.getElementById('open').addEventListener('click', () => {
          for (let i = 1; i <= 3; i++) window.open(`/title-change?burst=${i}`);
        }),
      );
      await quiet();
      // The opener's frame is shown again a moment after the tab switch: wait for the button's box.
      let box = null;
      for (let i = 0; i < 25 && !box; i++) {
        box = await frame.locator('#open').boundingBox().catch(() => null);
        if (!box) await page.waitForTimeout(200);
      }
      if (!box) throw new Error('the #open button has no box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const s = await waitState(page, (x) => (x.tabs.find((t) => t.id === opener.id)?.blockedPopups ?? 0) >= blocked0 + 3, 15_000, 'three held back');
      await new Promise((r) => setTimeout(r, 1500));
      const s2 = await state(page);
      const held = s2.tabs.find((t) => t.id === opener.id)?.blockedPopups ?? 0;
      rec('one click with four window.open calls opens one GNOME tab; the other three wait behind the indicator', s2.tabs.length === s0.tabs.length + 1 && held === blocked0 + 3, { tabs: [s0.tabs.length, s.tabs.length, s2.tabs.length], held: [blocked0, held] });
      await page.locator(`[data-tab="${opener.id}"]`).click();
      await waitState(page, (x) => x.active === opener.id, 5000, 'opener active');
    });

    await step('context menu on a link', async () => {
      const s0 = await state(page);
      const opener = activeTab(s0);
      const frame = await tabFrame(page, opener.id);
      await frame.locator('#blank').click({ button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ timeout: 5000 });
      const items = (await menu.getByRole('menuitem').allTextContents()).map((x) => x.trim());
      await screenshot(ctx, page, 'context-menu-link');
      const want = ['Open link in new tab', 'Open link in background tab', 'Copy link address', 'Bookmark link'];
      rec('context menu on a link offers the link items', want.every((w) => items.some((i) => i.startsWith(w))), items);
      await menu.getByRole('menuitem', { name: /Open link in background tab/ }).click();
      const s = await waitState(page, (x) => x.tabs.length === s0.tabs.length + 1, 15_000, 'background tab');
      rec('"Open link in background tab" opens a tab and keeps the current one active', s.active === opener.id, { active: s.active, opener: opener.id, tabs: s.tabs.length });
    });

    await step('context menu on the page', async () => {
      const t = activeTab(await state(page));
      const fe = await page.locator('iframe.engine-frame').boundingBox();
      await page.mouse.click(fe.x + fe.width / 2, fe.y + fe.height - 60, { button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ timeout: 5000 });
      const items = (await menu.getByRole('menuitem').allTextContents()).map((x) => x.trim());
      rec('context menu on the page offers Back, Forward, Reload and Bookmark page', ['Back', 'Forward', 'Reload', 'Bookmark page'].every((w) => items.some((i) => i.startsWith(w))), items);
      await page.keyboard.press('Escape');
    });

    // Before the Alt+R reload: playwright's Firefox can stop answering in a Scramjet frame after a reload (A15).
    await step('page fullscreen', async () => {
      const t = activeTab(await state(page));
      const frame = await tabFrame(page, t.id);
      const ok = await frame.evaluate(() => document.documentElement.requestFullscreen().then(() => true, (e) => String(e)));
      const s = await waitState(page, (x) => activeTab(x)?.fullscreen === true, 10_000, 'tab.fullscreen').catch((e) => ({ err: String(e) }));
      const appFs = await page.evaluate(() => (document.fullscreenElement ? document.fullscreenElement.className : null));
      rec('page fullscreen is reported and the engine iframe is the app’s fullscreen element', ok === true && !s.err && /engine-frame/.test(appFs ?? ''), { ok, appFs, s: s.err ?? 'ok' });
      await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
      await waitState(page, (x) => activeTab(x)?.fullscreen === false, 10_000, 'fullscreen ends').catch(() => null);
    });

    await step('forwarded ordinary shortcut (Alt+R reloads the tab)', async () => {
      const t = activeTab(await state(page));
      const frame = await tabFrame(page, t.id);
      await frame.evaluate(() => (window.__shellMark = 1));
      // Focus the page away from its links (a click on #blank would open a tab).
      const fe = await page.locator('iframe.engine-frame').boundingBox();
      await page.mouse.click(fe.x + fe.width / 2, fe.y + fe.height - 60);
      await page.keyboard.press('Alt+r');
      await waitState(page, (x) => activeTab(x)?.loading, 10_000, 'reload starts').catch(() => null);
      await waitLoaded(page, /\/popup$/, 30_000);
      await new Promise((r) => setTimeout(r, 500));
      // Through the engine host, with a deadline: playwright's Firefox can stop answering in a Scramjet tab frame after
      // it was reloaded (worklist A15), which hung the whole run here once (integration part 2).
      const mark = await tabGlobal(page, t.id, '__shellMark');
      rec('forwarded ordinary shortcut (Alt+R reloads the tab)', mark === null, { mark });
    });

    await step('forwarded privileged shortcut with a real key press (Alt+T opens a tab)', async () => {
      const s0 = await state(page);
      const t = activeTab(s0);
      const fe = await page.locator('iframe.engine-frame').boundingBox();
      await page.mouse.click(fe.x + fe.width / 2, fe.y + fe.height - 60);
      await quiet();
      await page.keyboard.press('Alt+t');
      const s = await waitState(page, (x) => x.tabs.length === s0.tabs.length + 1, 10_000, 'new tab from Alt+T');
      rec('forwarded privileged shortcut with a real key press (Alt+T opens a tab)', activeTab(s)?.url === null, { tabs: s.tabs.length, refused: s.counters?.refusedShortcuts });
      await page.locator(`[data-tab="${t.id}"]`).click();
    });

    await step('zoom (capability zoom)', async () => {
      const s0 = await state(page);
      if (!s0.capabilities.includes('zoom')) {
        ctx.record({ test: 'shell-input: zoom in and reset', result: 'skip', notes: 'the engine host does not offer the zoom capability yet; the zoom UI and Settings row stay hidden' });
        return;
      }
      const t = activeTab(s0);
      await page.keyboard.press('Alt+=');
      const s = await waitState(page, (x) => activeTab(x)?.zoom > 1, 10_000, 'zoomed');
      await page.keyboard.press('Alt+0');
      const r = await waitState(page, (x) => activeTab(x)?.zoom === 1, 10_000, 'reset');
      rec('zoom in and reset', activeTab(s).zoom > 1 && activeTab(r).zoom === 1, { tab: t.id });
    });

    rec('no page errors in the app', errors.length === 0, errors);
    await context.close();
  } finally {
    await browser.close();
  }
}
