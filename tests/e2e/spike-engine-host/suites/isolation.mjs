// Item 3 of the engine-host spike (docs/research/spike-engine-host.md): a proxied page must not reach
// the APP origin. From a proxied test page (served by servers/target.mjs through the TEST-ONLY HolyWisp route) we try
// to (a) read the app origin's localStorage/IndexedDB, (b) call app-origin endpoints with credentials and the CSRF
// header, (c) navigate the app's top-level window. Each attempt runs twice:
//   virtualized  the page's own script, rewritten by the engine (what any proxied site does)
//   escaped      unrewritten JS in the proxied document (Playwright frame.evaluate), standing in for any engine
//                escape; it uses the real window.top and the same-origin engine-host window for native APIs
// Then it records, as yes/no observations only, which proxy-origin facilities that escaped code shares with GNOME's
// engine host (same origin): the engine host window, other tabs' documents, storage databases, the service worker
// registration, the engine BroadcastChannel, host-scoped cookies, WebRTC.
import { TARGET_ORIGIN, TARGET_ORIGIN_ALT, APP_ORIGIN } from '../lib/config.mjs';
import { readOut } from '../lib/drive.mjs';
import { NetWatch } from '../lib/netwatch.mjs';
import { udpSink } from './leak.mjs';

const TRANSPORT = { scramjet: 'libcurl', ultraviolet: 'epoxy' };
const ENGINES = (process.env.SPIKE_ISO_ENGINES || 'scramjet,ultraviolet').split(',').filter(Boolean);
const ESCAPE_HOST = 'https://escaped-top.gnome-spike.invalid/';
// Firefox never sends ICE/STUN traffic to loopback by default; this pref only makes the local STUN sink observable
// (a real page would use a public STUN server). Chromium ignores it.
const RTC_LOOPBACK = { 'media.peerconnection.ice.loopback': true };

// (a) + (b), escaped. Returns short strings only.
async function escapedBoundary({ APP }) {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}`; } };
  const H = window.top[0]; // engine host window (proxy origin)
  await t('topIsApp', () => { try { return `same-origin?! ${window.top.location.href}`; } catch (e) { return `cross-origin (${e.name})`; } });
  await t('appLocalStorageViaTop', () => String(window.top.localStorage.getItem('gnome:secret')));
  await t('appIndexedDbViaTop', () => typeof window.top.indexedDB.open);
  await t('appSecretInProxyLocalStorage', () => String(H.localStorage.getItem('gnome:secret')));
  await t('appDbInProxyIndexedDb', async () => (H.indexedDB.databases ? (await H.indexedDB.databases()).some((d) => d.name === 'gnome') : 'unsupported') ? 'present' : 'absent');
  await t('appFramedReadable', () => new Promise((resolve) => {
    const f = H.document.createElement('iframe');
    f.src = `${APP}/`;
    let done = false;
    const fin = (v) => { if (!done) { done = true; f.remove(); resolve(v); } };
    f.onload = () => { try { fin(`readable: ${f.contentWindow.localStorage.getItem('gnome:secret')}`); } catch (e) { fin(`not readable (${e.name})`); } };
    H.document.body.appendChild(f);
    setTimeout(() => fin('no load event'), 4000);
  }));
  // (b) credentialed app calls with the CSRF header: these need a CORS preflight that the app never approves
  await t('postStateWithHeader', async () => `status ${(await H.fetch(`${APP}/api/state`, { method: 'POST', credentials: 'include', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: '{}' })).status}`);
  await t('postTicketWithHeader', async () => `status ${(await H.fetch(`${APP}/api/wisp/ticket`, { method: 'POST', credentials: 'include', headers: { 'X-GNOME-Request': '1' } })).status}`);
  // simple requests without the header (no preflight): they reach the server, but cannot be read or change state
  await t('getSecretCors', async () => `status ${(await H.fetch(`${APP}/api/secret`, { credentials: 'include' })).status}`);
  await t('getSecretNoCors', async () => { const r = await H.fetch(`${APP}/api/secret`, { credentials: 'include', mode: 'no-cors' }); return `type ${r.type}, readable body: ${(await r.text()).length > 0}`; });
  await t('postStateNoCors', async () => `type ${(await H.fetch(`${APP}/api/state`, { method: 'POST', credentials: 'include', mode: 'no-cors', body: 'x' })).type}`);
  await t('beaconState', () => `queued ${H.navigator.sendBeacon(`${APP}/api/state`, 'x')}`);
  return out;
}

// (c) top navigation without user activation, escaped.
function escapedTopNav({ dest }) {
  const out = {};
  const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = `threw ${e && e.name}`; } };
  const H = window.top[0];
  t('assign', () => { window.top.location.href = `${dest}?assign`; return 'no exception'; });
  t('replace', () => { window.top.location.replace(`${dest}?replace`); return 'no exception'; });
  t('openTop', () => (H.open(`${dest}?open-top`, '_top') ? 'returned a window' : 'returned null'));
  t('anchorTop', () => { const a = H.document.createElement('a'); a.href = `${dest}?anchor`; a.target = '_top'; H.document.body.appendChild(a); a.click(); a.remove(); return 'clicked'; });
  return out;
}

// Same-origin facilities escaped code shares with the engine host: yes/no observations and names only.
async function escapedReach() {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}`; } };
  const H = window.top[0];
  await t('engineHostWindow', () => (H.location.pathname === '/engine/' ? 'yes (same origin)' : 'no'));
  await t('otherTabDocuments', () => { const mine = window; const docs = [...H.document.querySelectorAll('iframe')].filter((f) => f.contentWindow !== mine).map((f) => { try { return Boolean(f.contentDocument); } catch { return false; } }); return `${docs.filter(Boolean).length}/${docs.length} other tab documents accessible`; });
  await t('indexedDbNames', async () => (H.indexedDB.databases ? (await H.indexedDB.databases()).map((d) => d.name).sort().join(',') : 'unsupported'));
  await t('cacheStorageNames', async () => (await H.caches.keys()).join(',') || '(none)');
  await t('serviceWorkerRegistrations', async () => (await H.navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).join(',') || '(none)');
  await t('engineBroadcastChannel', () => new Promise((resolve) => { const bc = new H.BroadcastChannel('gnome-engine'); let n = 0; bc.onmessage = () => { n++; }; setTimeout(() => { bc.close(); resolve(`joined; ${n} messages in 1.5 s`); }, 1500); }));
  await t('hostCookieNames', () => H.document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).sort().join(',') || '(none)');
  return out;
}

async function rtcFromPage({ stun }) {
  if (typeof RTCPeerConnection !== 'function') return 'RTCPeerConnection absent';
  const pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 1500));
  const n = (pc.localDescription?.sdp || '').split('\n').filter((l) => l.startsWith('a=candidate')).length;
  pc.close();
  return `RTCPeerConnection available; ${n} candidates`;
}

function appRequests(ctx, t0) {
  return ctx.eventsSince(t0, 'app-request').map((e) => `${e.method} ${e.path} origin=${e.origin || '-'} session=${e.hasSession} -> ${e.outcome}`);
}

async function engineRun(ctx, browser, engine, sink) {
  const context = await ctx.newContext(browser);
  const watch = new NetWatch(context, ctx.browser);
  const rec = (test, result, notes, data) => ctx.record({ engine, transport: TRANSPORT[engine], test, result, notes, data });
  try {
    const app = await ctx.openApp(context, { route: 'test', fallback: '0' });
    await watch.attachExisting();
    const appUrl = app.page.url();
    await app.navigate(2, `${TARGET_ORIGIN_ALT}/iso/victim`, { create: true, engine, timeout: 45000 }); // a second tab (other site)
    const t0 = Date.now();
    const r = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
    const virt = await readOut(app, 1, 30000);
    if (!r.ok || !virt) {
      rec('probe-load', 'fail', `probe page did not load: ${JSON.stringify(r.error).slice(0, 200)}`);
      return;
    }
    const virtReqs = appRequests(ctx, t0);
    // ---- virtualized (engine-rewritten page JS)
    const vStorage = virt.appLocalStorageViaOwn === null && (virt.appLocalStorageViaTop === null || /threw/.test(String(virt.appLocalStorageViaTop)));
    rec('virtualized:app-storage', vStorage ? 'pass' : 'fail', `own localStorage: ${virt.appLocalStorageViaOwn}; top.localStorage: ${virt.appLocalStorageViaTop}; top===self: ${virt.topIsSelf}; idb names: ${JSON.stringify(virt.idbDatabases).slice(0, 120)}`);
    const vApi = /^401/.test(String(virt.proxiedGetSecret)) && !/^200/.test(String(virt.proxiedPostState));
    rec('virtualized:app-endpoints', vApi ? 'pass' : 'fail', `GET /api/secret via proxy: ${String(virt.proxiedGetSecret).slice(0, 60)}; POST /api/state via proxy: ${String(virt.proxiedPostState).slice(0, 60)}; app saw: ${virtReqs.join(' | ').slice(0, 300)}`, { virt, appRequests: virtReqs });
    // ---- escaped: storage + endpoints
    const frame = app.tabFrame(1);
    const t1 = Date.now();
    const b = await frame.evaluate(escapedBoundary, { APP: APP_ORIGIN });
    await ctx.sleep(1500);
    const escReqs = appRequests(ctx, t1);
    const storageOk = /cross-origin/.test(b.topIsApp) && /threw SecurityError/.test(b.appLocalStorageViaTop) && /threw SecurityError/.test(b.appIndexedDbViaTop) && b.appSecretInProxyLocalStorage === 'null' && b.appDbInProxyIndexedDb !== 'present' && !/^readable/.test(b.appFramedReadable);
    rec('escaped:app-storage', storageOk ? 'pass' : 'fail', `top: ${b.topIsApp}; top.localStorage: ${b.appLocalStorageViaTop}; top.indexedDB: ${b.appIndexedDbViaTop}; app secret in proxy-origin storage: ${b.appSecretInProxyLocalStorage}/${b.appDbInProxyIndexedDb}; app framed: ${b.appFramedReadable}`, b);
    const stateChanged = escReqs.some((x) => /state-changed|ticket-issued/.test(x));
    const preflightOnly = !escReqs.some((x) => /^POST \/api\/(state|wisp\/ticket) .*-> (state-changed|ticket-issued)/.test(x));
    const headerCallsFailed = /threw TypeError/.test(b.postStateWithHeader) && /threw TypeError/.test(b.postTicketWithHeader);
    rec('escaped:app-endpoints', headerCallsFailed && !stateChanged && preflightOnly ? 'pass' : 'fail', `with X-GNOME-Request: state ${b.postStateWithHeader}, ticket ${b.postTicketWithHeader}; GET secret cors: ${b.getSecretCors}, no-cors: ${b.getSecretNoCors}; POST no-cors: ${b.postStateNoCors}; beacon: ${b.beaconState}; app saw: ${escReqs.join(' | ').slice(0, 400)}`, { b, appRequests: escReqs });
    // ---- escaped: reachability inventory (observations)
    const reach = await frame.evaluate(escapedReach);
    const udpBefore = sink.packets.length;
    const rtc = await frame.evaluate(rtcFromPage, { stun: sink.url }).catch((e) => `threw ${String(e.message || e).slice(0, 80)}`);
    await ctx.sleep(500);
    const udp = sink.packets.length - udpBefore;
    rec('reach:proxy-origin', 'pass', `engine host: ${reach.engineHostWindow}; ${reach.otherTabDocuments}; IndexedDB: ${reach.indexedDbNames}; caches: ${reach.cacheStorageNames}; SW: ${reach.serviceWorkerRegistrations}; bus: ${reach.engineBroadcastChannel}; cookies on this host: ${reach.hostCookieNames}`, reach);
    rec('reach:webrtc-from-page', udp > 0 ? 'fail' : 'pass', `${rtc}; UDP packets at the local STUN sink: ${udp} (direct, outside Wisp)`, { rtc, udp, virtualizedTypeof: virt.rtcPeerConnection });
    // ---- top navigation (last: a success would replace the app)
    const nav = await frame.evaluate(escapedTopNav, { dest: ESCAPE_HOST }).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
    await ctx.sleep(2000);
    let after = app.page.url();
    const navOk = after === appUrl;
    rec('escaped:top-navigation', navOk ? 'pass' : 'fail', `app URL ${navOk ? 'unchanged' : `CHANGED to ${after}`}; ${Object.entries(nav).map(([k, v]) => `${k}: ${v}`).join('; ')}`, nav);
    // with user activation: a click handler (unrewritten) in the proxied page
    if (navOk) {
      await frame.evaluate(({ dest }) => {
        document.getElementById('go').addEventListener('click', () => {
          try { window.top.location.href = `${dest}?user-activation`; window.__topnavUa = 'no exception'; } catch (e) { window.__topnavUa = `threw ${e.name}`; }
        });
      }, { dest: ESCAPE_HOST });
      await frame.click('#go').catch(() => {});
      await ctx.sleep(2000);
      after = app.page.url();
      const ua = await frame.evaluate(() => window.__topnavUa).catch(() => 'frame gone');
      rec('escaped:top-navigation-user-activation', after === appUrl ? 'pass' : 'fail', `app URL ${after === appUrl ? 'unchanged' : `CHANGED to ${after}`}; handler: ${ua}`);
    }
    // virtualized top navigation: the engine maps "top" to the proxied page itself
    const app2 = await ctx.openApp(context, { route: 'test', fallback: '0' });
    const appUrl2 = app2.page.url();
    await app2.navigate(1, `${TARGET_ORIGIN}/iso/probe?topnav=1`, { create: true, engine, timeout: 45000 });
    await ctx.sleep(3000);
    const tabUrl = await app2.cmd('diagnostics').then((d) => (d.tabs.find((x) => x.id === 1) || {}).url).catch(() => null);
    rec('virtualized:top-navigation', app2.page.url() === appUrl2 ? 'pass' : 'fail', `app URL ${app2.page.url() === appUrl2 ? 'unchanged' : 'CHANGED'}; tab now at ${tabUrl}`);
  } finally {
    for (const p of context.pages()) await p.close().catch(() => {});
    await watch.close();
    await context.close();
  }
}

export async function run(ctx) {
  const sink = await udpSink();
  const browser = await ctx.launch({ extraPrefs: RTC_LOOPBACK });
  try {
    // dev two-origin mode shares cookies across ports: check whether a __Host- cookie can be used on http loopback
    {
      const context = await ctx.newContext(browser);
      const page = await context.newPage();
      await page.goto(`${APP_ORIGIN}/`).catch(() => {});
      const host = await page.evaluate(() => { document.cookie = '__Host-probe=1; Secure; Path=/'; return /__Host-probe=1/.test(document.cookie); }).catch(() => null);
      ctx.record({ test: 'dev:host-prefixed-cookie-on-http-loopback', result: host ? 'pass' : 'partial', notes: host ? '__Host- + Secure cookies are accepted on http://127.0.0.1 (usable for dev two-port mode)' : '__Host-/Secure cookie refused on http://127.0.0.1: dev two-port mode cannot use prefixed cookies' });
      await context.close();
    }
    for (const engine of ENGINES) await engineRun(ctx, browser, engine, sink);
  } finally {
    await browser.close();
    await sink.close();
  }
}
