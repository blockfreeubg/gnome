// GNOME engine host (spike; Wave B starting point). Runs at <proxy origin>/engine/ inside the app's sandboxed
// cross-origin iframe (ARCHITECTURE §4.6). It owns:
//   - Scramjet 2.0.67-alpha.2 + controller 0.0.14 over libcurl-transport 2.0.6 | epoxy-transport 3.0.2
//   - Ultraviolet 3.2.10 + bare-mux 2.1.9 over epoxy-transport 2.1.29 | libcurl-transport 1.5.2
//   - the service worker registration (one classic /sw.js at scope "/"), one <iframe> per tab
//   - the typed, origin-checked postMessage protocol to the app (docs/ENGINE-PROTOCOL.md)
//   - Wisp tickets, transport watchdog/recovery, controlled Scramjet -> UV fallback, downloads, keys, context
//     menus, fullscreen, find-in-page, the optional GNOME CSP on proxied documents.
// Commands/events prefixed "test." exist only for the spike harness.
/* global $scramjet, $scramjetController, BareMux, __uv$config */

const PROTOCOL = 1;
const BUILD = 'spike-2026-11-10';
const SJ_CONFIG = {
  prefix: '/~/sj/',
  scramjetPath: '/vendor/scramjet/scramjet.js',
  injectPath: '/vendor/scramjet-controller/controller.inject.js',
  wasmPath: '/vendor/scramjet/scramjet.wasm',
};
const SJ_TRANSPORT_MODULES = { libcurl: '/vendor/libcurl-transport/index.mjs', epoxy: '/vendor/epoxy-transport/index.mjs' };
const UV_TRANSPORT_MODULES = { epoxy: '/vendor/epoxy-transport-bare/index.mjs', libcurl: '/vendor/libcurl-transport-bare/index.mjs' };
const BARE_MUX_WORKER = '/vendor/bare-mux/worker.js';
const VERSIONS = {
  scramjet: '2.0.67-alpha.2', controller: '0.0.14', ultraviolet: '3.2.10', bareMux: '2.1.9',
  transports: { 'scramjet/libcurl': '2.0.6', 'scramjet/epoxy': '3.0.2', 'ultraviolet/epoxy': '2.1.29', 'ultraviolet/libcurl': '1.5.2' },
};
// GNOME-imposed CSP for proxied documents (leak mitigation, docs/research/spike-engine-host.md §4).
const GNOME_CSP = [
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "form-action 'self'",
  'report-uri /__csp-report',
].join('; ');
const SCRAMJET_CLIENT = Symbol.for('scramjet client global');

const now = () => performance.now();
const round = (x) => Math.round(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const redact = (u) => String(u).replace(/([?&]t=)[^&]*/, '$1<ticket>');

// Native accessors of THIS realm. Proxied documents are same-origin, but their globals are hooked by the engines
// (and by the page), so everything the host does inside them goes through its own realm's functions.
const own = (obj, key) => Object.getOwnPropertyDescriptor(obj, key);
const N = {
  on: EventTarget.prototype.addEventListener,
  preventDefault: Event.prototype.preventDefault,
  stopImmediatePropagation: Event.prototype.stopImmediatePropagation,
  frameElement: (own(window, 'frameElement') || own(Window.prototype, 'frameElement')).get,
  ownerDocument: own(Node.prototype, 'ownerDocument').get,
  defaultView: own(Document.prototype, 'defaultView').get,
  title: own(Document.prototype, 'title').get,
  head: own(Document.prototype, 'head').get,
  body: own(Document.prototype, 'body').get,
  querySelector: Document.prototype.querySelector,
  querySelectorAll: Document.prototype.querySelectorAll,
  getElementById: Document.prototype.getElementById,
  createElement: Document.prototype.createElement,
  createTreeWalker: Document.prototype.createTreeWalker,
  createRange: Document.prototype.createRange,
  appendChild: Node.prototype.appendChild,
  getAttribute: Element.prototype.getAttribute,
  closest: Element.prototype.closest,
  rect: Element.prototype.getBoundingClientRect,
  contentWindow: own(HTMLIFrameElement.prototype, 'contentWindow').get,
  anchorHref: own(HTMLAnchorElement.prototype, 'href').get,
  imgSrc: own(HTMLImageElement.prototype, 'currentSrc').get,
};

/* ------------------------------------------------------------------------------------------------ state -- */
const S = {
  port: null,
  appOrigin: null,
  settings: null,
  ticket: null, // {value, expiresAt, wispUrl}
  shortcuts: new Set(),
  engines: {
    scramjet: { state: 'disabled', version: VERSIONS.scramjet, detail: null },
    ultraviolet: { state: 'disabled', version: VERSIONS.ultraviolet, detail: null },
  },
  transport: { scramjet: { state: 'connecting', transport: null }, ultraviolet: { state: 'connecting', transport: null } },
  controller: null,
  sjTransport: null,
  bareMux: null,
  tabs: new Map(),
  timings: {},
  counters: { wisp: [], swStarts: [], sw503: [], swHeld: [], uvErrors: [], sjErrors: [], csp: [], signals: [], recoveries: [], escapes: 0 },
  recovery: { scramjet: null, ultraviolet: null },
  initPromise: null,
};

function defaultSettings() {
  return {
    engine: 'auto', // 'auto' = Scramjet first with controlled fallback to Ultraviolet
    autoFallback: true,
    transports: { scramjet: 'libcurl', ultraviolet: 'epoxy' },
    route: '/wisp/', // or '/wisp/p/<profile>/'
    // 'query+amp-slash' = "?t=<ticket>&/", the gateway's canonical form, for every transport (libcurl needs the
    // trailing "/"). Others: 'auto' (libcurl "?t=<ticket>/", epoxy "?t=<ticket>") | 'query' | 'query+slash'.
    ticketForm: 'query+amp-slash',
    csp: 'off', // 'off' | 'enforce' | 'report-only'
    cspPolicy: GNOME_CSP,
    // The SW takes its config only from this engine host (SW message event, checked source). true = ALSO accept it
    // from the gnome-engine BroadcastChannel, which any proxied page can join (session-3 behaviour; attack tests only).
    swConfigBus: false,
    watchdog: true,
    lazyRenew: false, // "ticket" command: keep healthy epoxy transports (see handlers.ticket)
    dropProbe: false, // probe the Wisp route after a libcurl drop (renews a rejected ticket before the next request)
    navTimeoutMs: 20000,
    fault: null, // test only: 'sj-wasm-missing' | 'sj-transport-dead' | 'sj-throw-marker'
    bodyFix: true,
  };
}

/* ---------------------------------------------------------------------------------------- app protocol -- */
const APP_ORIGINS = (document.querySelector('meta[name="gnome-app-origins"]')?.content || '').split(/\s+/).filter(Boolean);
let helloTimer = null;

function emit(type, p) {
  if (S.port) S.port.postMessage({ k: 'evt', type, p });
}
function log(level, message) {
  emit('log', { level, message: String(message).slice(0, 500) });
}

if (window.parent === window) {
  document.body.innerHTML = '<p id="standalone">This page only works inside GNOME.</p>';
  throw new Error('engine host opened outside GNOME');
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || !e.data || e.data.gnome !== 'connect') return;
  if (!APP_ORIGINS.includes(e.origin)) return; // CSP frame-ancestors already limits who can embed us
  if (e.data.protocol !== PROTOCOL || !e.ports[0]) {
    window.parent.postMessage({ gnome: 'mismatch', protocol: PROTOCOL }, e.origin);
    return;
  }
  clearInterval(helloTimer);
  if (S.port) S.port.close();
  S.port = e.ports[0];
  S.appOrigin = e.origin;
  S.port.onmessage = onCommand;
});

const INSTANCE = Math.random().toString(36).slice(2, 10);
function sayHello() {
  window.parent.postMessage({ gnome: 'hello', protocol: PROTOCOL, build: BUILD, instance: INSTANCE }, '*'); // no secrets in hello
}
sayHello();
helloTimer = setInterval(sayHello, 500);
setTimeout(() => clearInterval(helloTimer), 15000);

async function onCommand(e) {
  const m = e.data;
  if (!m || m.k !== 'cmd' || typeof m.type !== 'string') return;
  const h = handlers[m.type];
  try {
    if (!h) throw fail('unknown_type', `unknown command ${m.type}`);
    const p = await h(m.p || {});
    S.port.postMessage({ k: 'res', id: m.id, ok: true, p: p ?? {} });
  } catch (err) {
    S.port.postMessage({ k: 'res', id: m.id, ok: false, error: { code: err.code || 'error', message: String(err.message || err).slice(0, 500) } });
  }
}

/* ----------------------------------------------------------------------- Wisp socket observation (tap) -- */
// The window-side transports (Scramjet's) create their Wisp WebSockets in this realm. Wrapping the constructor
// before the transport modules load gives exact connect/open/close events for the watchdog.
const NativeWebSocket = window.WebSocket;
window.WebSocket = class GnomeWispSocket extends NativeWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    const rec = { side: 'scramjet', url: redact(url), at: Date.now(), wasOpen: false };
    onWisp({ ...rec, ev: 'connecting' });
    N.on.call(this, 'open', () => { rec.wasOpen = true; onWisp({ ...rec, ev: 'open' }); });
    N.on.call(this, 'close', (ev) => onWisp({ ...rec, ev: 'close', code: ev.code }));
  }
};

// Same tap inside the bare-mux SharedWorker, installed through setManualTransport (a documented bare-mux API).
function uvTransportBody(modulePath) {
  return `
    if (!self.__gnomeWispTap) {
      self.__gnomeWispTap = true;
      const Native = self.WebSocket;
      const bus = new BroadcastChannel('gnome-engine');
      const redact = (u) => String(u).replace(/([?&]t=)[^&]*/, '$1<ticket>');
      self.WebSocket = class extends Native {
        constructor(url, protocols) {
          super(url, protocols);
          const rec = { type: 'wisp', side: 'ultraviolet', url: redact(url), at: Date.now(), wasOpen: false };
          bus.postMessage({ ...rec, ev: 'connecting' });
          this.addEventListener('open', () => { rec.wasOpen = true; bus.postMessage({ ...rec, ev: 'open' }); });
          this.addEventListener('close', (e) => bus.postMessage({ ...rec, ev: 'close', code: e.code }));
        }
      };
    }
    const { default: BareTransport } = await import(${JSON.stringify(modulePath)});
    return [BareTransport, ${JSON.stringify(modulePath)}];`;
}

/* -------------------------------------------------------------------------------------------- SW bus -- */
const bus = new BroadcastChannel('gnome-engine');
bus.onmessage = (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  switch (d.type) {
    case 'sw-start':
      S.counters.swStarts.push(d.at);
      pushSwConfig();
      break;
    case 'sw-503':
      S.counters.sw503.push({ ...d, t: Date.now() });
      break;
    case 'sw-held':
      S.counters.swHeld.push(d);
      break;
    case 'uv-error':
      S.counters.uvErrors.push({ ...d, t: Date.now() });
      onUvTransportError(d);
      break;
    case 'download':
      onUvDownload(d);
      break;
    case 'wisp':
      onWisp(d);
      break;
    default:
  }
};
// SW config goes to the SW's message event, whose source the SW checks (the engine-host client at /engine/):
// ordinary proxied pages have no ServiceWorker object to post from. The gnome-engine BroadcastChannel is NOT used
// for it (any proxied page can join that channel and could switch the UV CSP off); settings.swConfigBus re-enables
// that legacy path for attack tests. Production hard-wires the policy in the SW (no runtime config at all).
function pushSwConfig() {
  if (!S.settings) return;
  const config = { csp: S.settings.csp, cspPolicy: S.settings.cspPolicy, bodyFix: S.settings.bodyFix };
  navigator.serviceWorker.controller?.postMessage({ type: 'gnome-sw-config', config: { ...config, acceptBusConfig: !!S.settings.swConfigBus } });
  if (S.settings.swConfigBus) bus.postMessage({ type: 'sw-config', config });
}
// Another SW took control of this engine host (an updated /sw.js that activated around an app reload, or a claim).
// Scramjet's Controller announces its prefix only to the ServiceWorker object it was built with, so point it at the
// new one (a field of scramjet-controller 0.0.14: re-check on upgrades); the SW's revive then reaches the new worker.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (S.controller && navigator.serviceWorker.controller) S.controller.serviceWorkerController = navigator.serviceWorker.controller;
    pushSwConfig();
  });
}

/* ------------------------------------------------------------------------------------------ transports -- */
function wispUrl(kind, ticketOverride) {
  const base = new URL(S.settings.route, location.href);
  base.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ticket = ticketOverride ?? S.ticket?.value;
  if (!ticket) return base.href;
  const form = S.settings.ticketForm === 'auto' ? (kind === 'libcurl' ? 'query+slash' : 'query') : S.settings.ticketForm;
  // libcurl-transport (1.x, 2.x) and libcurl.js refuse Wisp URLs that do not END with "/".
  // 'query+amp-slash' ("?t=<ticket>&/") ends with "/" for libcurl and is the gateway's canonical form
  // (backend/src/gateway ticket_param; since session 4 it also strips one trailing "/" from "?t=<ticket>/").
  if (form === 'query+amp-slash') return `${base.href}?t=${encodeURIComponent(ticket)}&/`;
  return `${base.href}?t=${encodeURIComponent(ticket)}${form === 'query+slash' ? '/' : ''}`;
}

let transportLock = Promise.resolve();
const serialized = (fn) => {
  const p = transportLock.then(fn, fn);
  transportLock = p.catch(() => {});
  return p;
};

// Recipe: build, init() BEFORE use (concurrent libcurl init() calls hang), then controller.setTransport().
function setScramjetTransport(reason) {
  return serialized(async () => {
    const kind = S.settings.transports.scramjet;
    const t0 = now();
    const url = S.settings.fault === 'sj-transport-dead' ? wispUrl(kind, 'w1.0.dead.invalid') : wispUrl(kind);
    const mod = await import(SJ_TRANSPORT_MODULES[kind]);
    const Transport = kind === 'libcurl' ? mod.LibcurlClient : mod.default;
    const t = new Transport({ wisp: url });
    await t.init();
    S.sjTransport = t;
    if (S.controller) S.controller.setTransport(t);
    S.transport.scramjet = { state: 'ready', transport: kind, endpoint: S.settings.route, since: Date.now() };
    S.counters.recoveries.push({ side: 'scramjet', reason, ms: round(now() - t0), t: Date.now() });
    status();
    return t;
  });
}

// Recipe: setManualTransport() replaces the transport inside the bare-mux SharedWorker (old one is dropped).
function setUvTransport(reason) {
  return serialized(async () => {
    const kind = S.settings.transports.ultraviolet;
    const t0 = now();
    await S.bareMux.setManualTransport(uvTransportBody(UV_TRANSPORT_MODULES[kind]), [{ wisp: wispUrl(kind) }]);
    S.transport.ultraviolet = { state: 'ready', transport: kind, endpoint: S.settings.route, since: Date.now() };
    S.counters.recoveries.push({ side: 'ultraviolet', reason, ms: round(now() - t0), t: Date.now() });
    status();
  });
}

// Plain GET on the Wisp route: the gateway answers 401 for a bad ticket and 426 for a good one.
async function probeRoute() {
  const u = new URL(S.settings.route, location.href);
  if (S.ticket) u.searchParams.set('t', S.ticket.value);
  try {
    return (await fetch(u, { cache: 'no-store' })).status;
  } catch {
    return 0;
  }
}

function onWisp(d) {
  S.counters.wisp.push({ side: d.side, ev: d.ev, code: d.code, wasOpen: d.wasOpen, url: d.url, t: Date.now() });
  const side = d.side;
  if (!S.settings || !S.engines[side] || S.engines[side].state !== 'ready') return;
  if (d.ev === 'open') {
    S.transport[side].state = 'ready';
    status();
  }
  if (d.ev !== 'close') return;
  S.transport[side].state = 'degraded';
  status();
  if (!S.settings.watchdog) return;
  const kind = S.settings.transports[side];
  // libcurl opens a new Wisp connection by itself on the next request after a drop; epoxy never does.
  if (d.wasOpen && kind === 'libcurl') {
    // settings.dropProbe (opt-in): libcurl reconnects with the URL (and ticket) it was built with, so probe the
    // route now and renew a rejected ticket before the next request fails on a 401.
    if (S.settings.dropProbe) {
      probeRoute().then((st) => {
        if (st !== 401) return;
        S.transport[side].state = 'offline';
        status();
        emit('needTicket', { reason: 'rejected' });
      });
    }
    return;
  }
  recover(side, d.wasOpen ? 'drop' : 'connect-failed');
}

function recover(side, reason) {
  if (S.recovery[side]) return S.recovery[side];
  S.recovery[side] = (async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const st = await probeRoute();
      if (st === 426) {
        await (side === 'scramjet' ? setScramjetTransport(`recover:${reason}`) : setUvTransport(`recover:${reason}`));
        return 'recreated';
      }
      if (st === 401) {
        S.transport[side].state = 'offline';
        status();
        emit('needTicket', { reason: 'rejected' });
        return 'need-ticket'; // the "ticket" command recreates both transports
      }
      S.transport[side].state = 'offline';
      status();
      await sleep(Math.min(30000, 250 * 2 ** attempt) * (0.5 + Math.random()));
    }
    return 'gave-up';
  })().finally(() => {
    S.recovery[side] = null;
  });
  return S.recovery[side];
}

/* ------------------------------------------------------------------------------------- engines + SW -- */
async function ensureServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) throw fail('insecure_context', 'service workers need a secure context');
  const t0 = now();
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  const reg = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    const changed = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    // A forced reload (Ctrl+Shift+R; also Playwright's Firefox reload) loads the engine host uncontrolled even though
    // the SW is active: ask the SW to clients.claim() it (sw.js "gnome-claim"). First installs claim on activate.
    if (reg.active) reg.active.postMessage({ type: 'gnome-claim' });
    await withTimeout(changed, 5000, 'SW did not take control');
  }
  S.timings.swReady = round(now() - t0);
  pushSwConfig();
}

async function initScramjet() {
  const e = S.engines.scramjet;
  e.state = 'initializing';
  const t0 = now();
  try {
    if (!window.$scramjetController) throw fail('sj_load', 'controller.api.js did not load (load order?)');
    // The controller does not validate the rewriter wasm (a 404 still "inits"): check the magic bytes.
    const wasmPath = S.settings.fault === 'sj-wasm-missing' ? '/vendor/scramjet/missing.wasm' : SJ_CONFIG.wasmPath;
    const head = new Uint8Array(await (await fetch(wasmPath)).arrayBuffer()).subarray(0, 4);
    if (head.join() !== '0,97,115,109') throw fail('sj_wasm', 'scramjet.wasm missing or corrupt');
    const transport = await setScramjetTransport('init');
    const { Controller } = window.$scramjetController;
    S.controller = new Controller({
      serviceworker: navigator.serviceWorker.controller,
      transport,
      config: SJ_CONFIG,
      scramjetConfig: { flags: { allowFailedIntercepts: true } }, // the controller's own default is lost (deepMerge order)
    });
    await withTimeout(S.controller.wait(), 10000, 'controller.wait() timed out');
    e.state = 'ready';
  } catch (err) {
    e.state = 'failed';
    e.detail = String(err.message || err);
  }
  S.timings.scramjet = round(now() - t0);
}

async function initUltraviolet() {
  const e = S.engines.ultraviolet;
  e.state = 'initializing';
  const t0 = now();
  try {
    if (!window.BareMux || !window.__uv$config) throw fail('uv_load', 'bare-mux or uv.config.js did not load');
    S.bareMux = new BareMux.BareMuxConnection(BARE_MUX_WORKER);
    await withTimeout(setUvTransport('init'), 10000, 'bare-mux setTransport timed out');
    e.state = 'ready';
  } catch (err) {
    e.state = 'failed';
    e.detail = String(err.message || err);
  }
  S.timings.ultraviolet = round(now() - t0);
}

function engineStatus() {
  return {
    engines: JSON.parse(JSON.stringify(S.engines)),
    transport: JSON.parse(JSON.stringify(S.transport)),
  };
}
let statusQueued = false;
function status() {
  if (statusQueued) return;
  statusQueued = true;
  queueMicrotask(() => {
    statusQueued = false;
    emit('status', engineStatus());
  });
}

/* ---------------------------------------------------------------------------------------------- tabs -- */
let navSeq = 0;

function makeTabPlugin(tab) {
  const { ManagedPlugin } = window.$scramjetController;
  class GnomeTabPlugin extends ManagedPlugin {
    constructor() {
      super('gnome-tab', []);
    }
    install(frame) {
      super.install(frame);
      // Hooks must never throw (a throw fails the request); init/lifecycle hooks are not awaited.
      this.tap(frame.hooks.init.post, (ctx) => {
        try {
          attachDocument(ctx.window, 'scramjet');
          if (ctx.isTopLevel) this.tap(ctx.client.hooks.lifecycle.navigate, (_c, p) => sameDocument(tab, String(p.url)));
        } catch (err) { log('error', `init.post: ${err}`); }
      });
      this.tap(frame.hooks.fetch.request, (ctx, props) => {
        try { onSjRequest(tab, ctx, props); } catch (err) { if (err && err.gnomeInjected) throw err; log('error', `fetch.request: ${err}`); }
      });
      this.tap(frame.hooks.fetch.response, (ctx, props) => {
        try { onSjResponse(tab, ctx, props); } catch (err) { log('error', `fetch.response: ${err}`); }
      });
      this.tap(frame.hooks.error.request, (ctx, props) => {
        try { onSjError(tab, ctx, props); } catch (err) { log('error', `error.request: ${err}`); }
      });
    }
  }
  return new GnomeTabPlugin();
}

class Tab {
  constructor(id) {
    this.id = id;
    this.engine = null;
    this.iframe = null;
    this.frame = null; // Scramjet Frame
    this.active = false;
    this.history = [];
    this.index = -1;
    this.url = null;
    this.title = '';
    this.nav = null;
    this.attempts = 0;
    this.fullscreen = false;
    this.find = null;
    this.uvPoll = null;
  }
}

function tabOf(id) {
  const t = S.tabs.get(id);
  if (!t) throw fail('no_tab', `no tab ${id}`);
  return t;
}

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw fail('bad_url', 'absolute http(s) URL required'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('bad_url', 'absolute http(s) URL required');
  return u.href;
}

function chooseEngine(forced) {
  if (forced) {
    if (S.engines[forced]?.state !== 'ready') throw fail('engine_unavailable', `${forced} is ${S.engines[forced]?.state}`);
    return forced;
  }
  const pref = S.settings.engine === 'auto' ? 'scramjet' : S.settings.engine;
  if (S.engines[pref].state === 'ready') return pref;
  const other = pref === 'scramjet' ? 'ultraviolet' : 'scramjet';
  if (S.engines[other].state === 'ready') return other;
  throw fail('engine_unavailable', 'no proxy engine is ready');
}

function removeFrame(tab) {
  if (tab.uvPoll) clearInterval(tab.uvPoll);
  tab.uvPoll = null;
  if (tab.frame && S.controller) {
    const i = S.controller.frames.indexOf(tab.frame); // the controller has no removal API
    if (i >= 0) S.controller.frames.splice(i, 1);
  }
  tab.frame = null;
  tab.iframe?.remove();
  tab.iframe = null;
}

function ensureFrame(tab, engine) {
  if (tab.iframe && tab.engine === engine) return;
  removeFrame(tab);
  const f = document.createElement('iframe');
  f.name = `tab-${tab.id}`;
  f.allow = 'fullscreen; clipboard-write; autoplay';
  f.hidden = !tab.active;
  N.on.call(f, 'load', () => onIframeLoad(tab, f));
  document.getElementById('tabs').append(f);
  tab.iframe = f;
  tab.engine = engine;
  if (engine === 'scramjet') tab.frame = S.controller.createFrame(f, { plugins: [makeTabPlugin(tab)] });
  else tab.uvPoll = setInterval(() => pollUvUrl(tab), 500); // UV has no same-document navigation hook
}

function proxiedUrl(tab, url) {
  if (tab.engine === 'scramjet') {
    return $scramjet.rewriteUrl(url, tab.frame.context, { origin: new URL(location.href), base: new URL(location.href) });
  }
  return location.origin + __uv$config.prefix + __uv$config.encodeUrl(url);
}

// GNOME-initiated loads replace the frame's current entry, so they never add entries to the app tab's joint
// session history (where a later history.back() could move another frame or the app itself).
function loadInto(tab, proxied) {
  const f = tab.iframe;
  try {
    const w = N.contentWindow.call(f);
    if (w && w.location.href !== 'about:blank' && w.location.origin === location.origin) {
      w.location.replace(proxied);
      return;
    }
  } catch { /* escaped frame: reset it below */ }
  f.src = proxied;
}

function startNav(tab, url, engine, opts) {
  if (tab.nav && tab.nav.timer) clearTimeout(tab.nav.timer);
  const nav = {
    id: ++navSeq, url, engine, kind: opts.kind || 'navigate', auto: !!opts.auto, forced: !!opts.forced,
    historyIndex: opts.historyIndex, startedAt: now(), committed: false, failed: false, loaded: false, download: false,
    method: 'GET', // set from the Scramjet request hook; the fallback re-sends only GET/HEAD navigations
  };
  nav.timer = setTimeout(() => engineFailure(tab, nav, 'timeout', `no document within ${S.settings.navTimeoutMs} ms`), S.settings.navTimeoutMs);
  tab.nav = nav;
  emit('tab.loading', { tabId: tab.id, loading: true });
  return nav;
}

function navigate(tab, url, opts = {}) {
  url = checkUrl(url);
  if (!opts.auto && (opts.kind || 'navigate') === 'navigate') tab.attempts = 0; // reset only by user navigations
  const engine = chooseEngine(opts.engine);
  ensureFrame(tab, engine);
  const nav = startNav(tab, url, engine, { ...opts, forced: !!opts.engine && !opts.auto });
  loadInto(tab, proxiedUrl(tab, url));
  return { navId: nav.id, engine };
}

function commit(tab, url, engine) {
  const nav = tab.nav;
  let kind = 'navigate';
  let ms = null;
  if (nav && !nav.committed && !nav.failed) {
    nav.committed = true;
    clearTimeout(nav.timer);
    kind = nav.kind;
    ms = round(now() - nav.startedAt);
  }
  if (kind === 'history' && nav.historyIndex != null) {
    tab.index = nav.historyIndex;
    tab.history[tab.index] = url;
  } else if (kind === 'reload' && tab.index >= 0) {
    tab.history[tab.index] = url;
  } else {
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
  }
  tab.url = url;
  emit('tab.committed', { tabId: tab.id, url, engine, canGoBack: tab.index > 0, canGoForward: tab.index < tab.history.length - 1, kind, ms });
}

function sameDocument(tab, url) {
  if (!url || url === tab.url) return;
  tab.url = url;
  if (tab.index >= 0) tab.history[tab.index] = url;
  emit('tab.committed', { tabId: tab.id, url, engine: tab.engine, canGoBack: tab.index > 0, canGoForward: tab.index < tab.history.length - 1, kind: 'same-document', ms: null });
}

function pollUvUrl(tab) {
  try {
    const w = N.contentWindow.call(tab.iframe);
    if (!tab.nav || !tab.nav.committed || !w) return;
    const u = decodeProxyUrl(w.location.href, tab);
    if (u && u !== tab.url && /^https?:/.test(u)) sameDocument(tab, u);
  } catch { /* navigating */ }
}

function decodeProxyUrl(raw, tab) {
  let u;
  try { u = new URL(raw, location.href); } catch { return null; }
  if (u.origin !== location.origin) return u.href;
  if (u.pathname.startsWith(SJ_CONFIG.prefix)) {
    const ctxTab = tab && tab.frame ? tab : [...S.tabs.values()].find((t) => t.frame);
    if (ctxTab) {
      try { return String($scramjet.unrewriteUrl(u.href, ctxTab.frame.context)); } catch { /* fall through */ }
    }
    const rest = u.pathname.split('/').slice(4).join('/');
    try { return decodeURIComponent(rest); } catch { return null; }
  }
  if (u.pathname.startsWith(__uv$config.prefix)) {
    const tail = u.href.slice((location.origin + __uv$config.prefix).length);
    const hashAt = tail.indexOf('#');
    const enc = hashAt >= 0 ? tail.slice(0, hashAt) : tail;
    try { return __uv$config.decodeUrl(enc) + (hashAt >= 0 ? tail.slice(hashAt) : ''); } catch { return null; }
  }
  return null;
}

/* --------------------------------------------------------------------- per-document observation -- */
function frameChain(win) {
  const chain = [];
  let w = win;
  for (let i = 0; i < 32; i++) {
    let fe;
    try { fe = N.frameElement.call(w); } catch { return chain; }
    if (!fe) return chain;
    chain.push(fe);
    const doc = N.ownerDocument.call(fe);
    if (doc === document) return chain;
    w = N.defaultView.call(doc);
  }
  return chain;
}

function tabForWindow(win) {
  const chain = frameChain(win);
  const top = chain[chain.length - 1];
  for (const t of S.tabs.values()) if (t.iframe && t.iframe === top) return { tab: t, chain };
  return null;
}

// Called for every proxied document: Scramjet init.post, UV document-start hook (uv-doc-hook.js).
function attachDocument(win, engine) {
  const found = tabForWindow(win);
  if (!found) return;
  const { tab, chain } = found;
  const isTop = chain.length === 1;
  const doc = win.document;
  N.on.call(win, 'keydown', (e) => onKey(tab, e), true);
  N.on.call(win, 'contextmenu', (e) => onContextMenu(tab, win, e), true);
  N.on.call(doc, 'securitypolicyviolation', (e) => {
    S.counters.csp.push({ tabId: tab.id, directive: e.effectiveDirective, blocked: String(e.blockedURI).slice(0, 200), t: Date.now() });
  }, true);
  if (!isTop) return;
  const url = documentUrl(win, engine, tab);
  if (tab.nav && !tab.nav.committed && !tab.nav.failed) commit(tab, url, engine);
  else if (url !== tab.url && !(tab.nav && tab.nav.failed && url === tab.nav.url)) commit(tab, url, engine); // navigation started inside the page (not the substitute page of a failed one)
  N.on.call(win, 'popstate', () => sameDocument(tab, documentUrl(win, engine, tab)));
  N.on.call(win, 'hashchange', () => sameDocument(tab, documentUrl(win, engine, tab)));
  const head = N.head.call(doc);
  const titleNow = () => {
    const t = String(N.title.call(doc) || '').slice(0, 1024);
    if (t !== tab.title) { tab.title = t; emit('tab.title', { tabId: tab.id, title: t }); }
  };
  if (head) new MutationObserver(titleNow).observe(head, { subtree: true, childList: true, characterData: true });
  N.on.call(win, 'DOMContentLoaded', titleNow);
}

function documentUrl(win, engine, tab) {
  if (engine === 'scramjet') {
    try { const c = win[SCRAMJET_CLIENT]; if (c && c.url) return String(c.url.href); } catch { /* fall through */ }
  }
  return decodeProxyUrl(win.location.href, tab);
}

function comboOf(e) {
  const k = e.key;
  if (!k || k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta' || k === 'Dead') return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3); // layout-independent letters (Alt+T may yield "†")
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  parts.push(key);
  return parts.join('+');
}

function onKey(tab, e) {
  if (e.isComposing) return;
  const combo = comboOf(e);
  if (!combo || !S.shortcuts.has(combo)) return;
  N.preventDefault.call(e);
  N.stopImmediatePropagation.call(e);
  emit('tab.key', { tabId: tab.id, combo });
}

function onContextMenu(tab, win, e) {
  if (e.shiftKey) return; // Shift+right-click keeps the browser's own menu
  N.preventDefault.call(e);
  const el = e.target && e.target.nodeType === 1 ? e.target : e.target?.parentElement;
  const link = el ? N.closest.call(el, 'a[href]') : null;
  const img = el ? N.closest.call(el, 'img') : null;
  const sel = String(win.getSelection?.() || '').slice(0, 2000);
  const editable = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  let x = e.clientX;
  let y = e.clientY;
  for (const fe of frameChain(win)) {
    const r = N.rect.call(fe);
    x += r.left + fe.clientLeft;
    y += r.top + fe.clientTop;
  }
  const target = {
    kind: link ? 'link' : img ? 'image' : editable ? 'editable' : sel ? 'selection' : 'page',
    linkUrl: link ? decodeProxyUrl(N.anchorHref.call(link), tab) : undefined,
    srcUrl: img ? decodeProxyUrl(N.imgSrc.call(img), tab) : undefined,
    selectionText: sel || undefined,
    editable,
  };
  emit('tab.contextMenu', { tabId: tab.id, x: round(x), y: round(y), target });
}

N.on.call(document, 'fullscreenchange', () => {
  for (const tab of S.tabs.values()) {
    const active = document.fullscreenElement === tab.iframe;
    if (active !== tab.fullscreen) {
      tab.fullscreen = active;
      emit('tab.fullscreen', { tabId: tab.id, active });
    }
  }
});

function onIframeLoad(tab, f) {
  if (tab.iframe !== f) return;
  let w;
  let raw;
  try {
    w = N.contentWindow.call(f);
    raw = w.location.href;
  } catch {
    // The frame is no longer on the proxy origin: something navigated it outside the engines.
    S.counters.escapes++;
    emit('tab.error', { tabId: tab.id, url: tab.nav?.url || tab.url || '', kind: 'engine', detail: 'frame left the proxy origin', engine: tab.engine, fallback: 'none' });
    return;
  }
  if (raw === 'about:blank') return;
  const nav = tab.nav;
  const doc = w.document;
  if (tab.engine === 'ultraviolet' && doc && N.getElementById.call(doc, 'uvVersion') && N.getElementById.call(doc, 'errorTrace')) {
    const trace = String(N.getElementById.call(doc, 'errorTrace').value || '').slice(0, 500);
    if (nav && !nav.committed && !nav.failed) return engineFailure(tab, nav, 'uv-error-page', trace);
    return;
  }
  if (nav && nav.failed) return;
  if (nav && !nav.committed) commit(tab, decodeProxyUrl(raw, tab), tab.engine); // non-HTML documents have no hook
  if (nav && !nav.loaded) {
    nav.loaded = true;
    emit('tab.loading', { tabId: tab.id, loading: false });
    emit('tab.loaded', { tabId: tab.id, url: tab.url, engine: tab.engine, ms: round(now() - nav.startedAt), navId: nav.id });
  }
  sendFavicon(tab, w).catch(() => {});
}

async function sendFavicon(tab, w) {
  const doc = w.document;
  const link = N.querySelector.call(doc, 'link[rel~="icon"]');
  let raw = link ? N.getAttribute.call(link, 'href') : null;
  let href;
  if (raw) href = new URL(raw, w.location.href).href;
  else {
    const pageUrl = tab.url && new URL(tab.url);
    if (!pageUrl) return;
    href = proxiedUrl(tab, new URL('/favicon.ico', pageUrl).href);
  }
  const r = await fetch(href);
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return emit('tab.favicon', { tabId: tab.id, icon: null });
  const blob = await r.blob();
  if (blob.size > 65536) return emit('tab.favicon', { tabId: tab.id, icon: null });
  const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  emit('tab.favicon', { tabId: tab.id, icon: dataUrl });
}

/* ------------------------------------------------------------------ Scramjet hooks (per tab frame) -- */
function onSjRequest(tab, ctx, props) {
  const dest = ctx.parsed.destination;
  if ((dest === 'iframe' || dest === 'document') && !ctx.parsed.isIframe) {
    const url = String(props.url.href);
    // Top-level navigation of the tab frame (GNOME-initiated, in-page link, or a redirect hop).
    if (!tab.nav || tab.nav.committed || tab.nav.failed) startNav(tab, url, 'scramjet', { kind: 'navigate' });
    tab.nav.method = String(props.init?.method || ctx.request?.method || 'GET').toUpperCase(); // a form POST, a 307 hop
    if (S.settings.fault === 'sj-throw-marker' && url.includes('gnome-fault=sj-throw')) {
      throw Object.assign(new Error('injected Scramjet failure (test)'), { gnomeInjected: true });
    }
  }
}

function cspHeader() {
  return S.settings.csp === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy';
}

function onSjResponse(tab, ctx, props) {
  const dest = ctx.parsed.destination;
  const h = props.response.headers;
  const disposition = String(h.get('content-disposition') || '');
  if (/^\s*attachment/i.test(disposition) && props.response.body) {
    if (tab.nav && !tab.nav.committed && (dest === 'iframe' || dest === 'document')) {
      tab.nav.download = true;
      clearTimeout(tab.nav.timer);
      emit('tab.loading', { tabId: tab.id, loading: false });
    }
    props.response.body = trackSjDownload(tab, String(ctx.parsed.url.href), disposition, h, props.response.body);
    return;
  }
  if (S.settings.csp === 'off') return;
  const type = String(h.get('content-type') || '');
  if (((dest === 'iframe' || dest === 'document') && type.startsWith('text/html')) || dest === 'worker' || dest === 'sharedworker') {
    h.set(cspHeader(), S.settings.cspPolicy);
  }
}

function onSjError(tab, ctx, props) {
  const raw = ctx.rawrequest || {};
  const dest = raw.destination;
  const message = String(ctx.error?.message || ctx.error).slice(0, 500);
  S.counters.sjErrors.push({ tabId: tab.id, dest, url: decodeProxyUrl(raw.rawUrl, tab), message, t: Date.now() });
  const nav = tab.nav;
  if ((dest === 'document' || dest === 'iframe') && nav && !nav.committed && !nav.failed) {
    props.setResponse = {
      body: `<!doctype html><meta charset="utf-8"><title>GNOME</title><p>This page could not be loaded with Scramjet.</p>`,
      status: 502,
      statusText: 'Bad Gateway',
      headers: [['content-type', 'text/html; charset=utf-8']],
    };
    props.suppressError = true;
    // Synchronously: the substitute document above can commit (init.post) before a deferred call would run, which
    // turned the failure into a "loaded" Scramjet error page (docs/research/spike-engine-host.md, item 6). The
    // UV retry itself starts asynchronously (after the cookie copy), once this hook has returned.
    engineFailure(tab, nav, 'error-hook', message);
  }
}

/* ----------------------------------------------------------------------- failure + controlled fallback -- */
function classify(signal, detail) {
  const d = String(detail || '');
  if (signal === 'timeout') return 'timeout';
  if (/resolve|0x42|not known|NXDOMAIN|code 6\b/i.test(d)) return 'dns';
  if (/certificate|SSL|TLS|code 35|code 60/i.test(d)) return 'tls';
  if (/MuxTaskEnded|Multiplexor|websocket|Wisp|code 7\b|Could not connect|Failed to fetch|no bare clients/i.test(d)) return 'network';
  return 'engine';
}

function engineFailure(tab, nav, signal, detail) {
  if (tab.nav !== nav || nav.committed || nav.failed || nav.download) return;
  nav.failed = true;
  clearTimeout(nav.timer);
  const latency = round(now() - nav.startedAt);
  S.counters.signals.push({ tabId: tab.id, navId: nav.id, engine: nav.engine, signal, latency, detail: String(detail).slice(0, 300), t: Date.now() });
  // The retry re-sends the destination as a GET, so a navigation with a request body (form POST) is never retried
  // automatically: that would submit a different request (or the same one twice after a timeout).
  const idempotent = nav.method === 'GET' || nav.method === 'HEAD';
  const canFallback = S.settings.autoFallback && nav.engine === 'scramjet' && !nav.forced && S.engines.ultraviolet.state === 'ready' && tab.attempts < 1 && idempotent;
  if (!idempotent) detail = `${detail} (not retried automatically: ${nav.method} navigation)`;
  if (canFallback) {
    tab.attempts++;
    emit('tab.engineSwitched', { tabId: tab.id, from: 'scramjet', to: 'ultraviolet', reason: signal, detail: String(detail).slice(0, 300), latency });
    copyCookiesToUv(nav.url)
      .catch(() => 0)
      .then((copied) => {
        S.counters.signals.push({ tabId: tab.id, navId: nav.id, engine: 'ultraviolet', signal: 'fallback-start', cookiesCopied: copied, t: Date.now() });
        try {
          navigate(tab, nav.url, { engine: 'ultraviolet', kind: nav.kind, auto: true });
        } catch (err) {
          emit('tab.error', { tabId: tab.id, url: nav.url, kind: 'engine', detail: String(err.message || err), engine: 'ultraviolet', fallback: 'attempted', signal: 'fallback-failed', latency });
        }
      });
    return;
  }
  const fallback = nav.auto ? 'attempted' : nav.engine === 'scramjet' && S.engines.ultraviolet.state === 'ready' ? 'available' : 'none';
  emit('tab.loading', { tabId: tab.id, loading: false });
  emit('tab.error', { tabId: tab.id, url: nav.url, kind: classify(signal, detail), detail: String(detail).slice(0, 300), engine: nav.engine, fallback, signal, latency });
}

function onUvTransportError(d) {
  for (const tab of S.tabs.values()) {
    const nav = tab.nav;
    if (tab.engine === 'ultraviolet' && nav && !nav.committed && !nav.failed) {
      S.counters.signals.push({ tabId: tab.id, navId: nav.id, engine: 'ultraviolet', signal: 'uv-transport-error', latency: round(now() - nav.startedAt), detail: d.message, url: d.url, t: Date.now() });
    }
  }
}

// Best effort: copy the destination site's cookies from Scramjet's jar into UV's __op store before a fallback.
function openUvCookieDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('__op', 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('cookies', { keyPath: 'id' });
      store.createIndex('path', 'path');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function copyCookiesToUv(url) {
  if (!S.controller) return 0;
  const host = new URL(url).hostname;
  const jar = JSON.parse(S.controller.cookieJar.dump());
  const rows = Object.values(jar).filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return d && (host === d || host.endsWith('.' + d)) && (c.expires === undefined || c.expires > Date.now());
  });
  if (!rows.length) return 0;
  const db = await openUvCookieDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('cookies', 'readwrite');
    const st = tx.objectStore('cookies');
    for (const c of rows) {
      const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const path = c.path || '/';
      st.put({ name: c.name, value: c.value, domain, path, expires: c.expires ? new Date(c.expires) : undefined, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite, set: new Date(), id: `${domain}@${path}@${c.name}` });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return rows.length;
}

/* ---------------------------------------------------------------------------------------- downloads -- */
let downloadSeq = 0;
function countingStream(body, onProgress, onDone) {
  let received = 0;
  let last = 0;
  const source = body instanceof ReadableStream ? body : new Response(body).body;
  return source.pipeThrough(new TransformStream({
    transform(chunk, c) {
      received += chunk.byteLength;
      if (performance.now() - last > 200) { last = performance.now(); onProgress(received); }
      c.enqueue(chunk);
    },
    flush() { onDone(received); },
  }));
}
function trackSjDownload(tab, url, disposition, headers, body) {
  const id = `sj-${++downloadSeq}`;
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const total = Number(headers.get('content-length')) || null;
  emit('download.started', { downloadId: id, tabId: tab.id, url, filename: m ? decodeURIComponent(m[1]) : 'download', mime: headers.get('content-type') || null, total, engine: 'scramjet' });
  return countingStream(body,
    (received) => emit('download.progress', { downloadId: id, received, total }),
    (received) => emit('download.done', { downloadId: id, state: 'completed', received }));
}
function onUvDownload(d) {
  if (d.phase === 'started') {
    let tab = null;
    const ref = d.referrer ? decodeProxyUrl(d.referrer) : null;
    for (const t of S.tabs.values()) {
      if (t.engine !== 'ultraviolet') continue;
      if ((ref && t.url === ref) || (t.nav && !t.nav.committed && t.nav.url === d.url)) tab = t;
    }
    if (!tab) return; // another engine host's download
    d.tabId = tab.id;
    S.uvDownloads = S.uvDownloads || new Map();
    S.uvDownloads.set(d.id, tab.id);
    if (tab.nav && !tab.nav.committed) { tab.nav.download = true; clearTimeout(tab.nav.timer); emit('tab.loading', { tabId: tab.id, loading: false }); }
    emit('download.started', { downloadId: d.id, tabId: tab.id, url: d.url, filename: d.filename, mime: d.mime, total: d.total, engine: 'ultraviolet' });
    return;
  }
  if (!S.uvDownloads || !S.uvDownloads.has(d.id)) return;
  if (d.phase === 'progress') emit('download.progress', { downloadId: d.id, received: d.received, total: d.total });
  if (d.phase === 'done') emit('download.done', { downloadId: d.id, state: d.state, received: d.received });
}

/* -------------------------------------------------------------------------------------- find in page -- */
function tabDocuments(tab) {
  const out = [];
  const walk = (win, depth) => {
    if (!win || depth > 8) return;
    let doc;
    try { doc = win.document; } catch { return; }
    if (!doc) return;
    out.push(doc);
    for (const f of N.querySelectorAll.call(doc, 'iframe, frame')) {
      try { walk(N.contentWindow.call(f), depth + 1); } catch { /* cross-origin (escaped) frame */ }
    }
  };
  walk(N.contentWindow.call(tab.iframe), 0);
  return out;
}

function clearFind(tab) {
  if (!tab.find) return;
  for (const doc of tab.find.docs) {
    try { const w = N.defaultView.call(doc); w.CSS.highlights.delete('gnome-find'); w.CSS.highlights.delete('gnome-find-active'); } catch { /* gone */ }
  }
  tab.find = null;
}

function find(tab, { query, backwards = false, caseSensitive = false }) {
  if (tab.find && tab.find.query === query && tab.find.caseSensitive === caseSensitive && tab.find.ranges.length) {
    const n = tab.find.ranges.length;
    tab.find.active = (tab.find.active + (backwards ? n - 1 : 1)) % n;
  } else {
    clearFind(tab);
    if (!query) return { matches: 0, active: 0 };
    const q = caseSensitive ? query : query.toLowerCase();
    const docs = tabDocuments(tab);
    const ranges = [];
    for (const doc of docs) {
      const root = N.body.call(doc) || doc.documentElement;
      if (!root) continue;
      const walker = N.createTreeWalker.call(doc, root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentNode?.nodeName || '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = caseSensitive ? node.data : node.data.toLowerCase();
        for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
          const r = N.createRange.call(doc);
          r.setStart(node, i);
          r.setEnd(node, i + q.length);
          ranges.push({ doc, r });
        }
      }
    }
    tab.find = { query, caseSensitive, ranges, docs, active: backwards ? ranges.length - 1 : 0 };
    for (const doc of docs) {
      const w = N.defaultView.call(doc);
      if (!w.CSS || !w.CSS.highlights || !w.Highlight) continue;
      const mine = ranges.filter((x) => x.doc === doc).map((x) => x.r);
      if (mine.length) w.CSS.highlights.set('gnome-find', new w.Highlight(...mine));
      if (!N.getElementById.call(doc, 'gnome-find-style')) {
        const st = N.createElement.call(doc, 'style');
        st.id = 'gnome-find-style';
        st.textContent = '::highlight(gnome-find){background:#ffe066;color:#000}::highlight(gnome-find-active){background:#ff9632;color:#000}';
        const parent = N.head.call(doc) || doc.documentElement;
        N.appendChild.call(parent, st);
      }
    }
  }
  const f = tab.find;
  if (!f.ranges.length) return { matches: 0, active: 0 };
  const act = f.ranges[f.active];
  const w = N.defaultView.call(act.doc);
  for (const doc of f.docs) { try { N.defaultView.call(doc).CSS.highlights.delete('gnome-find-active'); } catch { /* gone */ } }
  if (w.CSS && w.CSS.highlights && w.Highlight) w.CSS.highlights.set('gnome-find-active', new w.Highlight(act.r));
  act.r.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  return { matches: f.ranges.length, active: f.active + 1, highlights: !!(w.CSS && w.CSS.highlights) };
}

/* -------------------------------------------------------------------------------- main-thread lag -- */
const lag = { max: 0, total: 0, over50: 0, longTasks: 0, longTaskMs: 0 };
{
  let last = now();
  setInterval(() => {
    const t = now();
    const d = t - last - 50;
    if (d > 0) { lag.total += d; if (d > lag.max) lag.max = d; if (d > 50) lag.over50++; }
    last = t;
  }, 50);
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { lag.longTasks++; lag.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: false });
  } catch { /* Firefox: no longtask entries */ }
}

/* ------------------------------------------------------------------------------------------ commands -- */
let ticketTimer = null;
function scheduleTicketRenewal() {
  clearTimeout(ticketTimer);
  if (!S.ticket || !S.ticket.expiresAt) return;
  const ms = Math.max(0, S.ticket.expiresAt - Date.now() - 5 * 60e3);
  ticketTimer = setTimeout(() => emit('needTicket', { reason: 'expiring' }), Math.min(ms, 2 ** 31 - 1));
}

const handlers = {
  async init(p) {
    if (S.initPromise) return S.initPromise;
    S.settings = { ...defaultSettings(), ...(p.settings || {}), transports: { ...defaultSettings().transports, ...(p.settings?.transports || {}) } };
    S.ticket = p.ticket || null;
    S.shortcuts = new Set(Array.isArray(p.shortcuts) ? p.shortcuts : []);
    S.initPromise = (async () => {
      const t0 = now();
      await ensureServiceWorker();
      await Promise.all([initScramjet(), initUltraviolet()]);
      S.timings.init = round(now() - t0);
      scheduleTicketRenewal();
      status();
      return { ...engineStatus(), versions: VERSIONS, timings: S.timings, build: BUILD };
    })();
    return S.initPromise;
  },
  async settings(p) {
    const before = S.settings;
    S.settings = { ...S.settings, ...p, transports: { ...S.settings.transports, ...(p.transports || {}) } };
    pushSwConfig();
    if (p.transports?.scramjet && p.transports.scramjet !== before.transports.scramjet && S.engines.scramjet.state === 'ready') await setScramjetTransport('settings');
    if (p.transports?.ultraviolet && p.transports.ultraviolet !== before.transports.ultraviolet && S.engines.ultraviolet.state === 'ready') await setUvTransport('settings');
    if ((p.route && p.route !== before.route) || (p.ticketForm && p.ticketForm !== before.ticketForm)) {
      if (S.engines.scramjet.state === 'ready') await setScramjetTransport('settings');
      if (S.engines.ultraviolet.state === 'ready') await setUvTransport('settings');
    }
    return { settings: S.settings };
  },
  async ticket(p) {
    S.ticket = p;
    scheduleTicketRenewal();
    // settings.lazyRenew (opt-in): the gateway checks tickets only at the upgrade, so a healthy epoxy transport
    // keeps its socket and picks the new ticket up at its next recreation (recreating it now leaves the old socket
    // open). libcurl transports reconnect with the URL they were built with, so they are rebuilt now (cheap: their
    // old socket closes). Transports that are not 'ready' are always rebuilt.
    const rebuild = (side) => !S.settings.lazyRenew || S.transport[side].state !== 'ready' || S.settings.transports[side] === 'libcurl';
    if (S.engines.scramjet.state === 'ready' && rebuild('scramjet')) await setScramjetTransport('ticket');
    if (S.engines.ultraviolet.state === 'ready' && rebuild('ultraviolet')) await setUvTransport('ticket');
    return {};
  },
  'tab.create'(p) {
    if (S.tabs.has(p.tabId)) throw fail('tab_exists');
    const tab = new Tab(p.tabId);
    S.tabs.set(tab.id, tab);
    if (p.active !== false) handlers['tab.activate']({ tabId: tab.id });
    if (p.url) return navigate(tab, p.url, { engine: p.engine });
    return {};
  },
  'tab.close'(p) {
    const tab = tabOf(p.tabId);
    clearFind(tab);
    if (tab.nav) clearTimeout(tab.nav.timer);
    removeFrame(tab);
    S.tabs.delete(tab.id);
    return {};
  },
  'tab.activate'(p) {
    const tab = tabOf(p.tabId);
    for (const t of S.tabs.values()) { t.active = t === tab; if (t.iframe) t.iframe.hidden = !t.active; }
    return {};
  },
  'tab.navigate'(p) { return navigate(tabOf(p.tabId), p.url, { engine: p.engine }); },
  'tab.go'(p) {
    const tab = tabOf(p.tabId);
    const target = tab.index + Number(p.delta || 0);
    if (target < 0 || target >= tab.history.length) throw fail('no_entry', 'no history entry');
    return navigate(tab, tab.history[target], { kind: 'history', historyIndex: target, engine: tab.engine, auto: true });
  },
  'tab.reload'(p) {
    const tab = tabOf(p.tabId);
    if (!tab.url) throw fail('no_document');
    const nav = startNav(tab, tab.url, tab.engine, { kind: 'reload' });
    N.contentWindow.call(tab.iframe).location.reload();
    return { navId: nav.id };
  },
  'tab.stop'(p) {
    const tab = tabOf(p.tabId);
    try { N.contentWindow.call(tab.iframe).stop(); } catch { /* escaped */ }
    if (tab.nav) { clearTimeout(tab.nav.timer); tab.nav.failed = true; }
    emit('tab.loading', { tabId: tab.id, loading: false });
    return {};
  },
  'tab.find'(p) { return find(tabOf(p.tabId), p); },
  'tab.findClear'(p) { clearFind(tabOf(p.tabId)); return {}; },
  diagnostics() {
    return {
      ...engineStatus(), versions: VERSIONS, timings: S.timings, build: BUILD,
      tabs: [...S.tabs.values()].map((t) => ({ id: t.id, engine: t.engine, url: t.url, history: t.history.length, index: t.index })),
      sw: { controlled: !!navigator.serviceWorker.controller, starts: S.counters.swStarts.length },
      memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null,
    };
  },
  // ---- spike-only ----
  'test.stats'() { return { counters: S.counters, timings: S.timings, lag: { ...lag, max: round(lag.max), total: round(lag.total), longTaskMs: round(lag.longTaskMs) } }; },
  'test.resetStats'() {
    for (const k of Object.keys(S.counters)) S.counters[k] = Array.isArray(S.counters[k]) ? [] : 0;
    Object.assign(lag, { max: 0, total: 0, over50: 0, longTasks: 0, longTaskMs: 0 });
    return {};
  },
  'test.setFault'(p) { S.settings.fault = p.fault || null; return {}; },
  async 'test.recreateTransport'(p) {
    if (p.engine === 'scramjet') await setScramjetTransport('test');
    else await setUvTransport('test');
    return {};
  },
  async 'test.cookies'() {
    const sj = S.controller ? Object.values(JSON.parse(S.controller.cookieJar.dump())).map((c) => `${c.domain}:${c.name}=${c.value}`) : [];
    let uv = [];
    try {
      const db = await openUvCookieDb();
      uv = await new Promise((res) => { const q = db.transaction('cookies').objectStore('cookies').getAll(); q.onsuccess = () => res(q.result.map((c) => `${c.domain}:${c.name}=${c.value}`)); q.onerror = () => res([]); });
      db.close();
    } catch { /* none */ }
    return { scramjet: sj, ultraviolet: uv };
  },
  async 'test.storage'() {
    // What the proxy origin itself can use: IndexedDB + Cache Storage inside the sandboxed iframe.
    const out = {};
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('gnome-engine-probe', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(Date.now(), 'probe'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      out.indexedDB = 'ok';
      db.close();
    } catch (err) { out.indexedDB = `failed: ${err}`; }
    try {
      const c = await caches.open('gnome-engine-probe');
      await c.put('/__probe', new Response('ok'));
      out.cacheStorage = (await (await c.match('/__probe')).text()) === 'ok' ? 'ok' : 'mismatch';
      await caches.delete('gnome-engine-probe');
    } catch (err) { out.cacheStorage = `failed: ${err}`; }
    out.databases = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : null;
    out.controlled = !!navigator.serviceWorker.controller;
    out.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    out.estimate = navigator.storage?.estimate ? await navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota })) : null;
    return out;
  },
};

// Exposed for the UV document-start hook (same origin; a proxied page that escapes its engine can reach it
// anyway, so this adds no capability).
Object.defineProperty(window, '__gnomeEngineHost', { value: Object.freeze({ attachDocument }), enumerable: false });
