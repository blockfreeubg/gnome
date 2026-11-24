// vpn-ui (docs/WAVE-C.md §9.4): the VPN page (lane v1), the server's exit check (lane v2) and the browser's VPN
// wiring with route-bound tickets (lane v3), on the runner's shared stack: its `e2e-vpn` (live, loopback allowed) and
// `e2e-dead` profiles, the target site reachable only through `e2e-vpn`, the leak sentinel. The suite restarts the
// server with GNOME_VPN_CHECK_URL (the check fixture, servers/vpn-check.mjs) and GNOME_VPN_CHECK_INTERVAL_MIN=1, from
// V13 on with its own profiles file (e2e-dead, e2e-vpn, e2e-vpn2), and restores the defaults at its end.
//
//   cd tests/e2e && node engine/run.mjs --only vpn-ui [--browser chromium|firefox]
import { activeTab, omnibox, openGnome, state, tabFrame, waitState } from './shell-lib.mjs';
import { startVpn2, startVpnCheck, VPN_CHECK_PORT, writeThreeProfiles } from './vpn-lib.mjs';

const FORBIDDEN = /mullvad|secure|anonymous|protected|encrypted|no logs|hide your ip|your ip is hidden|system-wide/i;
let check = null;
let vpn2 = null;

async function connectionText(page) {
  return (await page.getByRole('status', { name: 'Connection' }).innerText().catch(() => '')).trim();
}

async function waitText(page, re, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    last = await connectionText(page);
    if (re.test(last)) return last;
    await page.waitForTimeout(300);
  }
  return last;
}

function setVpn(page, values) {
  return page.evaluate((v) => {
    for (const [k, val] of Object.entries(v)) window.__gnomeSettings.set('vpn', k, val);
  }, values);
}

/** Loads the target site in the active tab; resolves {ok, s}. */
async function loadTarget(page, url, timeout = 40_000) {
  await page.evaluate(() => window.__gnomeBrowser.setVisible?.(true));
  await omnibox(page, url);
  try {
    const s = await waitState(page, (x) => {
      const t = activeTab(x);
      return t && !t.loading && (t.error || (t.live && t.url?.startsWith(url))) ? x : null;
    }, timeout, 'target load');
    const t = activeTab(s);
    return { ok: !t.error && t.url?.startsWith(url), error: t.error, s };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

async function chip(page) {
  // The tab-strip chip ("VPN · …"), not the sidebar's "VPN" page link.
  const l = page.getByRole('link', { name: /^VPN ·/ }).first();
  return (await l.count()) ? ((await l.getAttribute('aria-label')) ?? (await l.innerText())).trim() : null;
}

async function gotoApp(page, app, path) {
  // In-app navigation keeps the engine host (a full reload would start a new app page).
  await page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await page.waitForTimeout(400);
  if (!new URL(page.url()).pathname.startsWith(path.split('?')[0])) await page.goto(`${app}${path}`);
}

export async function run(ctx) {
  const { record, stack } = ctx;
  const rec = (test, ok, notes = '') => record({ test, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes) });
  if (!stack?.target) {
    record({ test: 'vpn-ui', result: 'skip', notes: 'needs the runner’s stack with the target site' });
    return;
  }
  const app = stack.appOrigin;
  const target = `${stack.target.origin}/`;
  // V15: auto-connect at a fresh start (D12, §8.1), decided before any tab loads. `--parts auto-connect` runs only
  // these rows (on the runner's default server).
  async function autoConnect() {
    const c4 = await ctx.newContext(browser);
    let { page: p4 } = await openGnome(ctx, c4, '/vpn');
    await setVpn(p4, { autoConnect: true, mode: 'off', killSwitch: true, preferredLocation: stack.profiles.live });
    await p4.evaluate(() => window.__gnomeSettings.set('browser', 'startup', 'restore'));
    await gotoApp(p4, app, '/browse');
    await omnibox(p4, target);
    await p4.waitForTimeout(4000);
    const noise = (h) => !/google|gstatic|gvt1|mozilla|firefox/i.test(String(h.target ?? h.host ?? h.url ?? ''));
    /** Closes every GNOME page of c4, opens a fresh one at `path` (optionally with a route set up first). */
    const fresh = async (name, path, setup) => {
      await setVpn(p4, { mode: 'off' });
      await p4.waitForTimeout(600);
      await p4.close();
      if (setup) await setup();
      const since = Date.now();
      ({ page: p4 } = await openGnome(ctx, c4, path));
      let s = null;
      try {
        s = await waitState(p4, (x) => {
          const t = activeTab(x);
          return t && !t.loading && (t.error || (t.live && t.url?.startsWith(target))) ? x : null;
        }, 60_000, 'restored load');
      } catch {
        /* recorded below */
      }
      const t = activeTab(s);
      const last = s ? null : await state(p4).then((x) => ({ engine: x?.engineState, detail: x?.engineDetail, active: x?.active, tabs: x?.tabs.map((y) => ({ url: y.url, loading: y.loading, live: y.live, discarded: y.discarded, error: y.error })) })).catch((e) => String(e.message).slice(0, 100));
      const mode = await p4.evaluate(() => window.__gnomeSettings.value.vpn.mode);
      const route = await p4.evaluate(() => window.__gnomeBrowser.vpnLocation?.id ?? null);
      const hits = stack.sentinel.since(since).filter(noise);
      rec(`V15 auto-connect (${name}): connected before the first load, which loads through e2e-vpn on the first try, no direct request`,
        !!t && !t.error && t.url?.startsWith(target) && mode === 'gateway' && route === stack.profiles.live && hits.length === 0,
        { url: t?.url ?? null, error: t?.error ?? null, mode, route, sentinel: hits.slice(0, 3), last });
    };
    await fresh('restored tab', '/browse');
    await fresh('/api/config delayed by 3 s', '/browse', () =>
      c4.route('**/api/config', async (r) => {
        await new Promise((res) => setTimeout(res, 3000));
        await r.continue();
      }));
    await c4.unroute('**/api/config');
    await fresh('a /browse?url= deep link', `/browse?url=${encodeURIComponent(target)}`);
    record({ test: 'V15 auto-connect with the startVpn chunk delayed by 3 s', result: 'skip', notes: '[unproven] not written' });
    // A reload is not a fresh start: it keeps "Off".
    await setVpn(p4, { mode: 'off' });
    await p4.waitForTimeout(600);
    await p4.reload();
    await p4.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
    await p4.waitForTimeout(3000);
    const mode = await p4.evaluate(() => window.__gnomeSettings.value.vpn.mode);
    rec('V15 a reload (not a fresh start) does not connect', mode === 'off', { mode });
    await c4.close();
  }

  const browser = await ctx.launch();
  try {
    if (ctx.parts?.includes('auto-connect')) {
      await autoConnect();
      return;
    }
    // V1 before the restart: no check service.
    {
      const r = await (await fetch(`${app}/api/vpn/locations`)).json();
      const context = await ctx.newContext(browser);
      const { page } = await openGnome(ctx, context, '/vpn', { waitBrowser: false });
      const none = await page.getByText('This server runs no exit checks.').waitFor({ timeout: 15_000 }).then(() => true, () => false);
      rec('V1 without a check service (the default): verify_url null and "This server runs no exit checks."', r.verify_url === null && none, { verify_url: r.verify_url, none });
      await context.close();
    }
    check ??= await startVpnCheck(VPN_CHECK_PORT);
    check.reset();
    await stack.restartServer({ GNOME_VPN_CHECK_URL: check.url, GNOME_VPN_CHECK_INTERVAL_MIN: '1' });

    const context = await ctx.newContext(browser);
    const { page } = await openGnome(ctx, context, '/vpn');
    // V1 after the restart.
    {
      await page.getByRole('heading', { level: 1, name: 'VPN' }).waitFor({ timeout: 20_000 });
      const off = await waitText(page, /^Off$/, 10_000);
      const list = page.getByRole('listbox', { name: 'Locations' });
      let live = '';
      let down = '';
      const end = Date.now() + 75_000;
      while (Date.now() < end) {
        live = await list.getByRole('option', { name: 'E2E · live' }).innerText().catch(() => '');
        down = await list.getByRole('option', { name: 'E2E · down' }).innerText().catch(() => '');
        if (/Online/.test(live) && /Offline/.test(down)) break;
        await page.waitForTimeout(2000);
        await page.reload();
        await page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
      }
      const privacy = await page.getByRole('region', { name: 'What the VPN does and does not do' }).count();
      const footer = await page.getByText(/GNOME is not affiliated with any VPN provider/).count();
      const text = await page.locator('main').innerText();
      rec('V1 /vpn: heading, "Off", the listbox ("E2E · live" Online, "E2E · down" Offline within 70 s), the privacy region, the footer, no forbidden word', off === 'Off' && /Online/.test(live) && /Offline/.test(down) && privacy === 1 && footer >= 1 && !FORBIDDEN.test(text), {
        off, live: live.slice(0, 60), down: down.slice(0, 60), privacy, footer, forbidden: FORBIDDEN.exec(text)?.[0] ?? null,
      });
    }

    // V2: Connect (Automatic → the first one up: E2E · live). "Ready" before any engine host runs.
    {
      await page.getByRole('button', { name: 'Connect' }).click();
      const ready = await waitText(page, /^(Ready|Connected to|Connecting to)/, 15_000);
      await gotoApp(page, app, '/browse');
      await waitState(page, (s) => s.tabs.length >= 1, 15_000, 'a tab').catch(() => null);
      const t = await loadTarget(page, target, 60_000);
      const chipText = await chip(page);
      await gotoApp(page, app, '/vpn');
      const connected = await waitText(page, /^Connected to E2E · live$/, 20_000);
      rec('V2 Connect: "Ready: E2E · live" before any engine host; the target site (only through e2e-vpn) loads; "Connected to E2E · live" and the chip "VPN · E2E · live"', /^Ready: E2E · live$/.test(ready) && t.ok && connected === 'Connected to E2E · live' && /^VPN · E2E · live/.test(chipText ?? ''), {
        ready, load: t.ok || t.error, connected, chipText,
      });
    }

    // V8 + V10: the server's check of E2E · live, then Check again.
    {
      const want = `${check.service} reports 192.0.2.10 in E2E, Sweden`;
      let shown = false;
      for (let i = 0; i < 30 && !shown; i++) {
        shown = (await page.getByText(want).count()) > 0;
        if (!shown) {
          await page.waitForTimeout(3000);
          await page.reload();
        }
      }
      const provider = await page.getByText(/says this address is one of its VPN exits: no/).count();
      rec('V8 the exit card: "<service> reports 192.0.2.10 in E2E, Sweden" and "… one of its VPN exits: no" (the server’s check through e2e-vpn)', shown && provider > 0, { want, provider });
      // V9: the server's check of E2E · down fails before any request can leave (its HolyWisp does not answer). The
      // fixture cannot tell which location a request came through; it is reachable only through e2e-vpn.
      {
        const option = page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · down' });
        let text = '';
        for (let i = 0; i < 30; i++) {
          text = await option.innerText().catch(() => '');
          if (/The location does not answer\./.test(text)) break;
          await page.waitForTimeout(3000);
          await page.reload();
          await page.waitForFunction(() => !!window.__gnomeBrowser, null, { timeout: 20_000 });
        }
        rec('V9 the server’s check of "E2E · down": "The location does not answer."', /The location does not answer\./.test(text), { text: text.slice(0, 160) });
      }
      // The server reuses a check younger than 60 s (D14): wait until the job's last check is older than that.
      while (Date.now() - check.stats().lastServerAt < 61_000) await page.waitForTimeout(1000);
      const before = check.stats().server;
      const btn = page.getByRole('button', { name: 'Check again' });
      await btn.click();
      await page.waitForTimeout(2500);
      const after1 = check.stats().server;
      const disabled = await btn.isDisabled();
      await btn.click({ force: true, timeout: 2000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const after2 = check.stats().server;
      rec('V10 Check again: one new server check, the button disabled for 60 s, a second click inside 60 s makes none', after1 === before + 1 && disabled && after2 === after1, { before, after1, after2, disabled });
      // V18: verifyExit is off by default → no browser request at the fixture.
      rec('V18 verifyExit off (the default): no browser request at the check fixture after connecting and Check again', check.stats().browser === 0, check.stats());
    }

    // V22 + V16 + V17: a second location while connected; then this browser's check.
    {
      // The reloads above started a new app page: open the target in a tab again (a live tab on the current route).
      await gotoApp(page, app, '/browse');
      await loadTarget(page, `${target}?v22=${Date.now()}`, 60_000);
      await gotoApp(page, app, '/vpn');
      await page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · down' }).click();
      // V6 (connected): choosing a location switches the route at once, with the toast "Now using …".
      const nowUsing = await page.getByText('Now using E2E · down').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
      await page.waitForTimeout(1500);
      const switched = await page.evaluate(() => window.__gnomeBrowser.vpnLocation?.id ?? null);
      rec('V6 choosing a location while connected switches the route at once ("Now using E2E · down")', nowUsing && switched === stack.profiles.dead, { nowUsing, switched });
      const line = await page.getByText(/tabs? may still use the previous route until you reload/).innerText({ timeout: 8000 }).catch(() => '');
      const facts = await page.evaluate(() => ({ previous: window.__gnomeBrowser.previousRouteTabs, live: window.__gnomeBrowser.model.tabs.filter((t) => t.live).length, engine: window.__gnomeBrowser.engineState }));
      rec('V22 after a location change while connected, the tab opened before shows "1 tab may still use the previous route until you reload it"', line === '1 tab may still use the previous route until you reload it', { line, ...facts });
      // V4 (kill switch on, the default): Blocked, the chip, the target fails.
      const blocked = await waitText(page, /^Blocked: E2E · down is down$/, 20_000);
      await gotoApp(page, app, '/browse');
      const t = await loadTarget(page, `${target}?v4=${Date.now()}`, 40_000);
      const chipText = await chip(page);
      const since = Date.now();
      // V19: the blocked load's error overlay has "Open VPN page".
      const open = page.getByRole('button', { name: 'Open VPN page' });
      const hasOpen = await open.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      if (hasOpen) await open.click();
      await page.waitForTimeout(800);
      const onVpn = new URL(page.url()).pathname === '/vpn';
      // The browsers' own background traffic (update and safe-browsing services) is not GNOME's.
      const hits = stack.sentinel.since(since).filter((h) => !/google|gstatic|gvt1|mozilla|firefox/i.test(String(h.target ?? h.host ?? h.url ?? '')));
      rec('V4 "E2E · down" with the kill switch on: "Blocked: E2E · down is down", the chip "VPN · Blocked", the target fails, no direct request at the sentinel', blocked === 'Blocked: E2E · down is down' && !t.ok && /^VPN · Blocked/.test(chipText ?? '') && hits.length === 0, { blocked, load: t.error, chipText, sentinel: hits.slice(0, 3) });
      rec('V19 a blocked load’s error overlay has Open VPN page, which opens /vpn', hasOpen && onVpn, { hasOpen, url: page.url() });
      // Back to E2E · live, then this browser's check on.
      await page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · live' }).click();
      await waitText(page, /^Connected to E2E · live$/, 30_000);
      const b0 = check.stats().browser;
      await page.getByRole('switch', { name: 'Check this browser’s exit' }).click();
      // The automatic run happens once per route change: switch away and back.
      await setVpn(page, { preferredLocation: null });
      await page.waitForTimeout(800);
      await setVpn(page, { preferredLocation: stack.profiles.live });
      const own = page.getByText(/^Through this browser’s route, .* reports 192\.0\.2\.10/);
      const shown = await own.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      rec('V16 this browser’s check (turned on): "Through this browser’s route, … reports 192.0.2.10 …"; the fixture’s browser count goes up', shown && check.stats().browser > b0, { shown, browser: check.stats().browser - b0 });
      check.set({ browserIp: '192.0.2.99' });
      await page.getByRole('button', { name: 'Check again' }).click({ timeout: 70_000 }).catch(() => undefined);
      const mismatch = await page.getByText(/This browser’s check answered differently from the server’s check of E2E · live/).waitFor({ timeout: 70_000 }).then(() => true, () => false);
      rec('V17 another ip for browser requests → the mismatch warning', mismatch);
      check.reset();
      await page.getByRole('switch', { name: 'Check this browser’s exit' }).click();
    }

    // V21: route-bound tickets over HTTP from the app page (the session's own tickets).
    {
      const r = await page.evaluate(async ({ live }) => {
        const mint = async (route) => (await (await fetch('/api/wisp/ticket', { method: 'POST', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ route }) })).json()).ticket;
        const d = await mint('default');
        await new Promise((res) => setTimeout(res, 1100));
        const p = await mint({ profile: live });
        return { d, p };
      }, { live: stack.profiles.live });
      const host = await context.newPage();
      await host.goto(`${stack.proxyOrigin}/engine/`).catch(() => undefined);
      const probe = (route, t) =>
        host.evaluate(async ([r, tk]) => {
          const res = await fetch(`${r}?t=${encodeURIComponent(tk)}&/`, { cache: 'no-store' });
          let code = null;
          try {
            code = (await res.json()).error.code;
          } catch {
            /* not JSON */
          }
          return { status: res.status, code };
        }, [route, t]);
      const since = Date.now();
      const wrong = await probe('/wisp/', r.p);
      const superseded = await probe('/wisp/', r.d);
      const right = await probe(`/wisp/p/${stack.profiles.live}/`, r.p);
      await host.close();
      rec('V21 route-bound tickets: a profile ticket on /wisp/ → 401 wisp_ticket_wrong_route; a default ticket minted before the profile one → 401 wisp_ticket_superseded; the profile ticket on its route → 426; no sentinel hit', wrong.code === 'wisp_ticket_wrong_route' && superseded.code === 'wisp_ticket_superseded' && right.status === 426 && stack.sentinel.since(since).length === 0, { wrong, superseded, right });
      record({ test: 'V21 the host-attack page reading the engine host’s ticket; an open default-route connection closed within 20 s; re-mint after a restart', result: 'skip', notes: '[unproven] here (backend/tests/wisp_tickets.rs covers the 20 s close and the restart refusal)' });
    }

    // Connected to E2E · live with the kill switch on (the default) from here to V3.
    const endpoints = async () => Object.values((await state(page))?.transport ?? {}).map((t) => t.endpoint);
    const rtcInTab = async () => {
      const t = activeTab(await state(page));
      if (!t) return 'no tab';
      return (await tabFrame(page, t.id)).evaluate(() => typeof window.RTCPeerConnection).catch((e) => `error: ${String(e.message).slice(0, 80)}`);
    };
    const webrtcWarning = () => page.getByText(/WebRTC is allowed in Privacy settings/).count();

    // V11: WebRTC allowed in Privacy settings. With the kill switch the engine host's policy is `block` and the page
    // shows no warning; with the kill switch off the page warns.
    {
      await page.evaluate(() => window.__gnomeSettings.set('privacy', 'webrtc', 'allow'));
      await gotoApp(page, app, '/browse');
      const t = await loadTarget(page, `${target}?v11=${Date.now()}`, 60_000);
      const rtc = t.ok ? await rtcInTab() : `load failed: ${t.error}`;
      await gotoApp(page, app, '/vpn');
      const warnOn = await webrtcWarning();
      await setVpn(page, { killSwitch: false });
      await page.waitForTimeout(800);
      const warnOff = await webrtcWarning();
      rec('V11 WebRTC allowed: VPN + kill switch on → RTCPeerConnection blocked in the tab and no warning; kill switch off → the WebRTC warning on the page', rtc === 'undefined' && warnOn === 0 && warnOff > 0, { rtc, warnOn, warnOff });
      await page.evaluate(() => window.__gnomeSettings.set('privacy', 'webrtc', 'block'));
    }

    // V5: kill switch off (from V11), "E2E · down": "Not in use", the toast, the engine host's route `default`.
    {
      await page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · down' }).click();
      const text = await waitText(page, /^Not in use: E2E · down is down$/, 20_000);
      const toast = await page.getByText('VPN location unavailable').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      let eps = [];
      const end = Date.now() + 20_000;
      while (Date.now() < end) {
        eps = await endpoints();
        if (eps.length && eps.every((e) => e === 'default')) break;
        await page.waitForTimeout(500);
      }
      rec('V5 "E2E · down" with the kill switch off: "Not in use: E2E · down is down", the toast "VPN location unavailable", the engine host’s route default', text === 'Not in use: E2E · down is down' && toast && eps.length > 0 && eps.every((e) => e === 'default'), { text, toast, eps });
      await page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · live' }).click();
      await setVpn(page, { killSwitch: true });
      await waitText(page, /^Connected to E2E · live$/, 30_000);
    }

    // V12: the check service stops answering while connected: a warning and a `degraded` chip, never a route change
    // (D14), with the kill switch on and off.
    {
      check.set({ stopped: true });
      // "Check again" stays disabled for 60 s after V17's click: Playwright waits for it to be enabled.
      await page.getByRole('button', { name: 'Check again' }).click({ timeout: 75_000 }).catch(() => undefined);
      const warning = await page.getByText(/The exit check through E2E · live fails: /).first().innerText({ timeout: 75_000 }).catch(() => '');
      for (const kill of [true, false]) {
        await setVpn(page, { killSwitch: kill });
        await page.waitForTimeout(1000);
        const text = await waitText(page, /^Connected to E2E · live$/, 10_000);
        const route = await page.evaluate(() => window.__gnomeBrowser.vpnLocation?.id ?? null);
        await gotoApp(page, app, '/browse');
        const t = await loadTarget(page, `${target}?v12=${kill}-${Date.now()}`, 60_000);
        const chipText = await chip(page);
        const eps = await endpoints();
        await gotoApp(page, app, '/vpn');
        rec(`V12 the check service stops answering (kill switch ${kill ? 'on' : 'off'}): the warning "The exit check through E2E · live fails: …", the chip degraded, still "Connected to E2E · live" on the profile route, the target loads`,
          !!warning && text === 'Connected to E2E · live' && route === stack.profiles.live && t.ok && /exit check failing/.test(chipText ?? '') && eps.length > 0 && eps.every((e) => e === 'profile'),
          { warning: warning.slice(0, 200), text, route, load: t.ok || t.error, chipText, eps });
      }
      check.reset();
      await setVpn(page, { killSwitch: true });
    }

    // V3: Disconnect → Off, no chip, the target no longer loads.
    {
      await gotoApp(page, app, '/vpn');
      await page.getByRole('button', { name: 'Disconnect' }).click();
      const off = await waitText(page, /^Off$/, 10_000);
      await gotoApp(page, app, '/browse');
      const t = await loadTarget(page, `${target}?v3=${Date.now()}`, 40_000);
      const chipText = await chip(page);
      rec('V3 Disconnect: "Off", no chip; the target site no longer loads (the direct instance refuses it)', off === 'Off' && !t.ok && chipText === null, { off, load: t.error, chipText });
    }

    // V6 (off): choosing a location while off only selects it.
    {
      await gotoApp(page, app, '/vpn');
      await page.getByRole('listbox', { name: 'Locations' }).getByRole('option', { name: 'E2E · down' }).click();
      await page.waitForTimeout(1500);
      const text = await connectionText(page);
      const v = await page.evaluate(() => ({ mode: window.__gnomeSettings.value.vpn.mode, preferred: window.__gnomeSettings.value.vpn.preferredLocation, route: window.__gnomeBrowser.vpnLocation?.id ?? null }));
      rec('V6 choosing a location while off only selects it (still "Off", no profile route)', text === 'Off' && v.mode === 'off' && v.preferred === stack.profiles.dead && v.route === null, { text, ...v });
      await setVpn(page, { preferredLocation: null });
    }

    // V7: device-local switches against an imported settings file (D12). The other vpn keys of the file apply.
    {
      const r = await page.evaluate(({ live }) => {
        const s = window.__gnomeSettings;
        const file = JSON.parse(s.export());
        file.settings.vpn = { ...file.settings.vpn, mode: 'gateway', killSwitch: false, preferredLocation: live };
        const result = s.import(JSON.stringify(file));
        const after = { ...s.value.vpn };
        const exported = JSON.parse(s.export()).settings.vpn;
        return { ok: result.ok, after, exported: { mode: exported.mode, killSwitch: exported.killSwitch } };
      }, { live: stack.profiles.live });
      await page.waitForTimeout(800);
      const text = await connectionText(page);
      rec('V7 importing a file with vpn.mode gateway and vpn.killSwitch false leaves "Off" and the kill switch on; its preferredLocation applies; the exported file carries both keys',
        r.ok && r.after.mode === 'off' && r.after.killSwitch === true && r.after.preferredLocation === stack.profiles.live && text === 'Off' && r.exported.mode === 'off' && r.exported.killSwitch === true,
        { ...r, text });
      record({ test: 'V7 with sync on, two browser contexts of one account: connecting or the kill switch in one changes neither in the other, preferredLocation syncs', result: 'skip', notes: '[unproven] here: the shared stack runs in open mode (no accounts); settings/sync.test.ts and local-vpn.test.ts cover withDeviceSettings' });
      await setVpn(page, { preferredLocation: null });
    }
    await context.close();

    await autoConnect();

    // V13 + V14: three profiles (e2e-dead first), Automatic picks the first one up; stopping e2e-vpn moves to e2e-vpn2.
    {
      vpn2 ??= await startVpn2(ctx.runDir ?? process.cwd());
      await stack.restartServer({ GNOME_VPN_CHECK_URL: check.url, GNOME_VPN_CHECK_INTERVAL_MIN: '1', GNOME_VPN_PROFILES: writeThreeProfiles(ctx.runDir ?? process.cwd(), stack.profiles) });
      const c2 = await ctx.newContext(browser);
      const { page: p2 } = await openGnome(ctx, c2, '/vpn');
      // Wait until e2e-dead is down, then connect Automatic.
      const list = p2.getByRole('listbox', { name: 'Locations' });
      const end = Date.now() + 75_000;
      while (Date.now() < end && !/Offline/.test(await list.getByRole('option', { name: 'E2E · down' }).innerText().catch(() => ''))) {
        await p2.waitForTimeout(3000);
        await p2.reload();
      }
      await setVpn(p2, { preferredLocation: null, mode: 'gateway' });
      await gotoApp(p2, app, '/browse');
      const t = await loadTarget(p2, `${target}?v13=${Date.now()}`, 60_000);
      const route = await p2.evaluate(() => window.__gnomeBrowser.vpnLocation?.id ?? null);
      rec('V13 Automatic (e2e-dead, e2e-vpn, e2e-vpn2): picks "E2E · live" (the first one up), the target loads', route === stack.profiles.live && t.ok, { route, load: t.ok || t.error });
      await stack.upstream(stack.profiles.live).stop();
      let moved = null;
      const end2 = Date.now() + 80_000;
      while (Date.now() < end2) {
        moved = await p2.evaluate(() => window.__gnomeBrowser.vpnLocation?.id ?? null);
        if (moved === 'e2e-vpn2') break;
        await p2.waitForTimeout(2000);
      }
      const toast = await p2.getByText(/VPN location changed: E2E · live is down\. Now using E2E · live 2\./).count();
      rec('V14 Automatic pinned: stopping e2e-vpn’s HolyWisp moves the route to e2e-vpn2 within 70 s with the toast', moved === 'e2e-vpn2' && toast > 0, { moved, toast });
      await stack.upstream(stack.profiles.live).start();
      await setVpn(p2, { mode: 'off' });
      await c2.close();
    }

    // V20: the stranded browser: no profiles while the switch is on with the kill switch.
    {
      await stack.restartServer({ GNOME_VPN_PROFILES: '' });
      const c3 = await ctx.newContext(browser);
      const { page: p3 } = await openGnome(ctx, c3, '/vpn');
      await setVpn(p3, { mode: 'gateway', killSwitch: true });
      const text = await waitText(p3, /^Blocked: no VPN location$/, 20_000);
      await gotoApp(p3, app, '/browse');
      const chipText = await chip(p3);
      await gotoApp(p3, app, '/vpn');
      await p3.getByRole('button', { name: 'Disconnect' }).click().catch(() => undefined);
      const off = await waitText(p3, /^Off$/, 10_000);
      await p3.goto(`${app}/settings/vpn`);
      // Without locations the mode row says so (its §10 description is the default text); the row stays usable.
      await p3.locator('[data-row="vpn.mode"]').waitFor({ timeout: 15_000 }).catch(() => undefined);
      const row = (await p3.locator('[data-row^="vpn."]').count()) >= 5 && (await p3.getByText('Block if the location is down').count()) > 0 ? 1 : 0;
      rec('V20 the stranded browser: "Blocked: no VPN location", the chip "VPN · Blocked", Disconnect works; Settings → VPN rows are visible with §10’s texts', text === 'Blocked: no VPN location' && /^VPN · Blocked/.test(chipText ?? '') && off === 'Off' && row > 0, { text, chipText, off, row });
      await c3.close();
    }
  } finally {
    await browser.close();
    await stack.restartServer({});
    // The fixtures this suite started (the runner's process must be able to exit).
    await check?.close();
    check = null;
    await vpn2?.stop();
    vpn2 = null;
  }
}
