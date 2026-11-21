// Lane c (browser shell), real stack: settings applied live and the Wisp ticket flows (docs/WAVE-B.md §4 Tests,
// §10 "Real-stack runs in code and accounts access modes"):
// - transport (libcurl ⇄ epoxy), engine (Ultraviolet forced) and WebRTC (block ⇄ allow) change while pages are open;
// - `code` mode: a navigation the user starts asks for the access code (an interactive mint); after the code changes
//   on the server, a session restore (no gesture) shows only the passive notice, and only its button opens the dialog;
// - `accounts` mode: a mint that needs sign-in shows the passive "Sign in" notice (no dialog); its button leads to the
//   account page; after signing up, a navigation the user starts gets a ticket and the page loads.
//
//   cd tests/e2e && E2E_PORT_BASE=28100 node engine/run.mjs --only shell-settings
import { activeTab, omnibox, openGnome, screenshot, state, tabFrame, waitLoaded, waitState } from './shell-lib.mjs';
import { tabText } from '../lib/tab-read.mjs';

const EXAMPLE = /^https:\/\/example\.com\/?$/;

async function setSetting(page, section, key, value) {
  await page.evaluate(([s, k, v]) => window.__gnomeSettings.set(s, k, v), [section, key, value]);
}

export async function run(ctx) {
  const browser = await ctx.launch();
  const rec = (test, ok, notes) => ctx.record({ test: `shell-settings: ${test}`, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes)?.slice(0, 700) });
  let current = null;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      if (current && !current.isClosed()) await screenshot(ctx, current, `settings-fail-${name.replace(/\W+/g, '-').slice(0, 40)}`).catch(() => {});
      rec(name, false, `${String(e?.message ?? e).slice(0, 500)} @ ${current?.url?.() ?? ''}`);
    }
  };
  try {
    // ── Live settings (open mode) ────────────────────────────────────────────────────────────────────────────
    {
      const context = await ctx.newContext(browser);
      const { page } = await openGnome(ctx, context);
      await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');
      await omnibox(page, 'example.com');
      await waitLoaded(page, EXAMPLE, 60_000);

      await step('transport changes live (libcurl → epoxy → libcurl)', async () => {
        await setSetting(page, 'browser', 'transport', 'epoxy');
        const s = await waitState(page, (x) => x.transport?.scramjet?.transport === 'epoxy' && x.transport?.scramjet?.state === 'ready', 30_000, 'epoxy ready');
        await page.getByRole('button', { name: 'Reload', exact: true }).click();
        await waitLoaded(page, EXAMPLE, 60_000);
        await setSetting(page, 'browser', 'transport', 'libcurl');
        const back = await waitState(page, (x) => x.transport?.scramjet?.transport === 'libcurl', 30_000, 'libcurl again');
        rec('transport changes live (libcurl → epoxy → libcurl), pages keep loading', true, { epoxy: s.transport, libcurl: back.transport });
      });

      await step('engine choice changes live (Ultraviolet forced)', async () => {
        await setSetting(page, 'browser', 'engine', 'ultraviolet');
        await page.waitForTimeout(600);
        await omnibox(page, 'https://example.org/');
        const s = await waitLoaded(page, /example\.org/, 60_000);
        rec('engine choice changes live (Ultraviolet forced)', activeTab(s).engine === 'ultraviolet', activeTab(s));
        await setSetting(page, 'browser', 'engine', 'auto');
        await page.waitForTimeout(600);
        await omnibox(page, 'example.com');
        const s2 = await waitLoaded(page, EXAMPLE, 60_000);
        rec('back to automatic: Scramjet first', activeTab(s2).engine === 'scramjet', activeTab(s2));
      });

      await step('WebRTC block ⇄ allow', async () => {
        const typeofRtc = async () => {
          const t = activeTab(await state(page));
          const f = await tabFrame(page, t.id);
          return f.evaluate(() => typeof window.RTCPeerConnection);
        };
        const blocked = await typeofRtc();
        await setSetting(page, 'privacy', 'webrtc', 'allow');
        await page.waitForTimeout(800);
        await page.getByRole('button', { name: 'Reload', exact: true }).click();
        await waitLoaded(page, EXAMPLE, 60_000);
        await page.waitForTimeout(300);
        const allowed = await typeofRtc();
        await setSetting(page, 'privacy', 'webrtc', 'block');
        await page.waitForTimeout(800);
        await page.getByRole('button', { name: 'Reload', exact: true }).click();
        await waitLoaded(page, EXAMPLE, 60_000);
        await page.waitForTimeout(300);
        const again = await typeofRtc();
        rec('WebRTC: blocked by default, allowed after the switch, blocked again', blocked === 'undefined' && allowed === 'function' && again === 'undefined', { blocked, allowed, again });
      });
      await context.close();
    }

    // ── "Clear cookies when GNOME closes", applied at the next fresh start (ENGINE-PROTOCOL §6.11) ──────────────
    // GNOME closes (its last page), then opens again in a new browser tab: no sessionStorage marker and no other GNOME
    // page, so the first engine host gets init.clearOnStart and clears both engines' jars (HttpOnly cookies too)
    // before its engines start. With the setting off the same restart keeps them. The local target site sets and
    // echoes the cookies; it is reachable only through the VPN profile route.
    if (ctx.stack?.target) {
      await step('clear cookies when GNOME closes', async () => {
        const context = await ctx.newContext(browser);
        try {
          const target = ctx.stack.target.origin;
          const open = async () => {
            const { page } = await openGnome(ctx, context);
            current = page;
            await waitState(page, (s) => s.tabs.length >= 1, 15_000, 'a tab');
            return page;
          };
          const cookiesOf = async (page) => {
            await omnibox(page, `${target}/cookies`);
            const s = await waitLoaded(page, /\/cookies$/, 60_000);
            // Through the engine host (lib/tab-read.mjs, worklist A15: Firefox's playwright can hang in a reloaded tab frame).
            return JSON.parse((await tabText(page, activeTab(s).id, '#out', { timeout: 10_000 })) ?? '{}').cookies ?? {};
          };
          const clearOnExit = (page, on) =>
            page.evaluate((v) => {
              const s = window.__gnomeSettings;
              s.set('browser', 'cookies', { ...s.value.browser.cookies, clearOnExit: v });
            }, on);
          let page = await open();
          await page.evaluate((id) => {
            const s = window.__gnomeSettings;
            s.set('vpn', 'mode', 'gateway');
            s.set('vpn', 'preferredLocation', id);
          }, ctx.stack.profiles.live);
          await clearOnExit(page, false);
          await page.waitForTimeout(600);
          await omnibox(page, `${target}/cookies/set?gnomeclear=1`);
          await waitLoaded(page, /\/cookies$/, 60_000);
          const set = await cookiesOf(page);
          await page.close();
          page = await open();
          const kept = await cookiesOf(page);
          await clearOnExit(page, true);
          await page.waitForTimeout(600);
          await page.close();
          page = await open();
          const after = await cookiesOf(page);
          rec(
            'clear cookies when GNOME closes: kept across a fresh start when off, removed (HttpOnly too) when on',
            set.gnomeclear === '1' && set.srvhttp === '1' && kept.gnomeclear === '1' && kept.srvhttp === '1' && !('gnomeclear' in after) && !('srvhttp' in after),
            { set, kept, after },
          );
          await clearOnExit(page, false);
        } finally {
          await context.close();
        }
      });
    }

    // ── code access mode ─────────────────────────────────────────────────────────────────────────────────────
    let codeContext = null;
    let codePage = null;
    await step('code mode: the user’s navigation asks for the access code', async () => {
      await ctx.stack.restartServer({ GNOME_ACCESS_MODE: 'code', GNOME_ACCESS_CODE: 'e2e-access-code-1' });
      codeContext = await ctx.newContext(browser);
      const { page } = await openGnome(ctx, codeContext);
      await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');
      await omnibox(page, 'example.com');
      const dialog = page.getByRole('dialog', { name: 'Access code required' });
      await dialog.waitFor({ timeout: 20_000 });
      await dialog.locator('input').fill('e2e-access-code-1');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      const s = await waitLoaded(page, EXAMPLE, 60_000);
      rec('code mode: a navigation the user starts asks for the code, then the page loads', !s.ticketNotice, activeTab(s));
      await page.waitForTimeout(1500); // session written
      codePage = page;
    });

    await step('code mode: a restore without a gesture shows only the passive notice', async () => {
      if (!codePage) throw new Error('no page from the previous step');
      const page = codePage;
      // A new code invalidates the anonymous session (sessions are bound to the access code).
      await ctx.stack.restartServer({ GNOME_ACCESS_MODE: 'code', GNOME_ACCESS_CODE: 'e2e-access-code-2' });
      // An app reload restores its tabs: the engine host starts without a gesture (a non-interactive mint).
      await page.reload();
      await page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
      const s = await waitState(page, (x) => !!x.ticketNotice, 30_000, 'passive notice');
      const dialogs = await page.getByRole('dialog', { name: 'Access code required' }).count();
      rec('code mode: no dialog opens by itself; the passive notice shows', dialogs === 0 && s.ticketNotice?.kind === 'access-code', { notice: s.ticketNotice, dialogs });
      await page.getByRole('button', { name: 'Enter code' }).click();
      const dialog = page.getByRole('dialog', { name: 'Access code required' });
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.locator('input').fill('e2e-access-code-2');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      const s2 = await waitState(page, (x) => !x.ticketNotice && x.transport?.scramjet?.state === 'ready', 30_000, 'ticket after the code');
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      await waitLoaded(page, EXAMPLE, 60_000);
      rec('code mode: the notice’s button opens the dialog; with the code the transports connect', true, s2.transport);
      await page.close();
    });
    await codeContext?.close();

    // ── accounts access mode ─────────────────────────────────────────────────────────────────────────────────
    await step('accounts mode: passive sign-in notice, sign up, then browse', async () => {
      await ctx.stack.restartServer({ GNOME_ACCESS_MODE: 'accounts' });
      const context = await ctx.newContext(browser);
      const { page } = await openGnome(ctx, context);
      current = page;
      await waitState(page, (s) => s.tabs.length === 1, 15_000, 'first tab');
      await omnibox(page, 'example.com');
      const s = await waitState(page, (x) => !!x.ticketNotice, 30_000, 'sign-in notice');
      rec('accounts mode: a mint that needs sign-in shows the passive notice', s.ticketNotice?.kind === 'login', s.ticketNotice);
      // The notice's button leads to the account page (a gesture in GNOME's UI; nothing opened by itself before).
      await page.locator('.notices').getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/settings\/account/, { timeout: 10_000 });
      // Back to the browser through the rail (GNOME's own navigation).
      await page.locator('a[href="/browse"]').first().click();
      await page.waitForURL(/\/browse/, { timeout: 10_000 });
      await page.locator('input[data-omnibox]').waitFor({ state: 'visible', timeout: 10_000 });
      // Sign up through the API (the account page's own flow is covered by the Settings QA).
      const user = `e2e${Date.now().toString(36)}`;
      const status = await page.evaluate(async (u) => {
        const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnome-request': '1' }, body: JSON.stringify({ username: u, password: 'correct-horse-battery-1' }) });
        return r.status;
      }, user);
      await omnibox(page, 'example.com');
      await waitState(page, (x) => !x.ticketNotice, 30_000, 'notice gone after the interactive mint');
      const s2 = await waitState(page, (x) => {
        const t = activeTab(x);
        return t && t.live && !t.loading && !t.error && EXAMPLE.test(t.url ?? '') && x.transport?.scramjet?.state === 'ready';
      }, 60_000, 'page loaded with a ticket');
      const t2 = activeTab(s2);
      const h1 = await (await tabFrame(page, t2.id)).locator('h1').first().textContent({ timeout: 15_000 }).catch(() => null);
      rec('accounts mode: after signing up, a navigation the user starts mints a ticket and loads the page', status === 201 && !s2.ticketNotice && /Example Domain/.test(t2.title + (h1 ?? '')), { status, title: t2.title, h1, transport: s2.transport });
      await context.close();
    });
  } finally {
    await ctx.stack.restartServer({}).catch(() => {});
    await browser.close();
  }
}
