// GNOME app shell stub (APP origin). It does what frontend/src/browser/ will do with the engine host:
// embed <proxy origin>/engine/ in a sandboxed iframe, run the origin-checked handshake, mint Wisp tickets via
// POST /api/wisp/ticket, send commands and VALIDATE every engine event (the engine host is semi-trusted:
// docs/ENGINE-PROTOCOL.md §1). window.gnomeTest is the spike harness' window into it.
const params = new URLSearchParams(location.search);
const config = await (await fetch('/api/config', { headers: { 'X-GNOME-Request': '1' } })).json();
const PROXY_ORIGIN = config.proxy.origin;
const PROTOCOL = 1;
const SHORTCUTS = ['Alt+T', 'Ctrl+Shift+K', 'Alt+ArrowLeft', 'F6'];
const ENGINES = ['scramjet', 'ultraviolet'];
const iframe = document.getElementById('engine');
const statusEl = document.getElementById('status');

let readyResolve;
const T = (window.gnomeTest = {
  events: [], // validated engine events {seq, t, type, p}
  rejected: [], // events that failed validation
  shortcuts: [], // dispatched shortcuts {combo, source}
  fullscreenLog: [],
  connects: 0,
  init: null,
  ready: new Promise((r) => { readyResolve = r; }),
  cmd: (type, p, timeout) => cmd(type, p, timeout),
  lag: { max: 0, total: 0, over50: 0, longTasks: 0, longTaskMs: 0 },
  resetLag() { Object.assign(T.lag, { max: 0, total: 0, over50: 0, longTasks: 0, longTaskMs: 0 }); },
  ticketRequests: 0,
});

// App-origin secrets: the isolation suite checks that nothing on the proxy origin can read them.
localStorage.setItem('gnome:secret', 'app-local-secret');
await new Promise((resolve) => {
  const r = indexedDB.open('gnome', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put('app-idb-secret', 'secret'); tx.oncomplete = () => { r.result.close(); resolve(); }; };
  r.onerror = () => resolve();
});

/* ------------------------------------------------------------------------------- engine settings -- */
function settingsFromQuery() {
  const s = { transports: {} };
  if (params.get('sjt')) s.transports.scramjet = params.get('sjt');
  if (params.get('uvt')) s.transports.ultraviolet = params.get('uvt');
  if (params.get('route') === 'test') s.route = '/wisp/p/test-loopback/';
  for (const k of ['engine', 'csp', 'fault', 'ticketForm']) if (params.get(k)) s[k] = params.get(k);
  if (params.get('cspPolicy')) s.cspPolicy = params.get('cspPolicy');
  if (params.has('fallback')) s.autoFallback = params.get('fallback') !== '0';
  if (params.has('watchdog')) s.watchdog = params.get('watchdog') !== '0';
  if (params.has('bodyFix')) s.bodyFix = params.get('bodyFix') !== '0';
  if (params.has('swConfigBus')) s.swConfigBus = params.get('swConfigBus') === '1'; // legacy SW config over the bus
  if (params.get('navTimeout')) s.navTimeoutMs = Number(params.get('navTimeout'));
  return s;
}

/* -------------------------------------------------------------------------------------- tickets -- */
let lastTicketAt = 0;
async function fetchTicket() {
  T.ticketRequests++;
  const r = await fetch('/api/wisp/ticket', { method: 'POST', headers: { 'X-GNOME-Request': '1' } });
  if (!r.ok) throw new Error(`ticket: HTTP ${r.status}`);
  const j = await r.json();
  return { value: j.ticket, expiresAt: j.expires_at, wispUrl: j.wisp_url };
}

/* ------------------------------------------------------------------------------- handshake + port -- */
let port = null;
let instance = null; // a reloaded engine host says hello again with a new instance id
let nextId = 1;
const pending = new Map();

window.addEventListener('message', (e) => {
  // Only the engine iframe, only from the proxy origin, only the documented hello.
  if (e.source !== iframe.contentWindow || e.origin !== PROXY_ORIGIN) return;
  const d = e.data;
  if (!d || d.gnome !== 'hello' || typeof d.instance !== 'string' || d.instance === instance) return;
  instance = d.instance;
  if (port) port.close();
  if (d.protocol !== PROTOCOL) { statusEl.textContent = 'GNOME was updated, reload'; return; }
  const ch = new MessageChannel();
  port = ch.port1;
  port.onmessage = onMessage;
  T.connects++;
  iframe.contentWindow.postMessage({ gnome: 'connect', protocol: PROTOCOL }, PROXY_ORIGIN, [ch.port2]);
  init().catch((err) => { statusEl.textContent = `init failed: ${err.message}`; T.initError = String(err.message || err); });
});
iframe.src = `${PROXY_ORIGIN}/engine/`;

async function init() {
  const ticket = await fetchTicket();
  const res = await cmd('init', { settings: settingsFromQuery(), ticket, shortcuts: SHORTCUTS }, 40000);
  T.init = res;
  statusEl.textContent = `scramjet: ${res.engines.scramjet.state}, ultraviolet: ${res.engines.ultraviolet.state}`;
  readyResolve(res);
}

function cmd(type, p = {}, timeout = 10000) {
  if (!port) return Promise.reject(new Error('engine host not connected'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type}: timeout`)); }, timeout);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ k: 'cmd', id, type, p });
  });
}

/* ---------------------------------------------------------------------- event validation (§1) -- */
const isTab = (v) => Number.isInteger(v) && v > 0 && v < 1e6;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || str(v, max);
const isHttpUrl = (v) => {
  if (!str(v, 8192)) return false;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};
const optUrl = (v) => v === undefined || v === null || isHttpUrl(v);
const ERROR_KINDS = ['network', 'dns', 'tls', 'timeout', 'engine', 'blocked', 'vpn-down', 'offline'];
const FAVICON = /^data:image\/(png|gif|jpeg|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const VALID = {
  status: (p) => p && typeof p.engines === 'object',
  needTicket: (p) => p && (p.reason === 'expiring' || p.reason === 'rejected'),
  'tab.loading': (p) => isTab(p.tabId) && typeof p.loading === 'boolean',
  'tab.loaded': (p) => isTab(p.tabId) && optUrl(p.url) && ENGINES.includes(p.engine),
  'tab.committed': (p) => isTab(p.tabId) && isHttpUrl(p.url) && ENGINES.includes(p.engine) && ['navigate', 'reload', 'history', 'same-document'].includes(p.kind),
  'tab.title': (p) => isTab(p.tabId) && str(p.title, 1024),
  'tab.favicon': (p) => isTab(p.tabId) && (p.icon === null || (str(p.icon, 90000) && FAVICON.test(p.icon))),
  'tab.error': (p) => isTab(p.tabId) && ERROR_KINDS.includes(p.kind) && optStr(p.detail, 1000) && ENGINES.includes(p.engine),
  'tab.engineSwitched': (p) => isTab(p.tabId) && ENGINES.includes(p.from) && ENGINES.includes(p.to),
  'tab.openRequest': (p) => isTab(p.openerTabId) && isHttpUrl(p.url) && ['foreground', 'background', 'popup'].includes(p.disposition),
  'tab.contextMenu': (p) => isTab(p.tabId) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.target && ['link', 'image', 'editable', 'selection', 'page'].includes(p.target.kind) && optUrl(p.target.linkUrl) && optUrl(p.target.srcUrl) && optStr(p.target.selectionText, 2000),
  'tab.key': (p) => isTab(p.tabId) && SHORTCUTS.includes(p.combo),
  'tab.fullscreen': (p) => isTab(p.tabId) && typeof p.active === 'boolean',
  'download.started': (p) => str(p.downloadId, 64) && isTab(p.tabId) && isHttpUrl(p.url) && str(p.filename, 255) && !/[/\\]/.test(p.filename),
  'download.progress': (p) => str(p.downloadId, 64) && Number.isFinite(p.received),
  'download.done': (p) => str(p.downloadId, 64) && ['completed', 'failed', 'cancelled'].includes(p.state),
  log: (p) => ['debug', 'info', 'warn', 'error'].includes(p.level) && str(p.message, 1000),
};
let seq = 0;

function onMessage(e) {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.k === 'res') {
    const w = pending.get(m.id);
    if (!w) return;
    pending.delete(m.id);
    clearTimeout(w.timer);
    if (m.ok) w.resolve(m.p);
    else w.reject(Object.assign(new Error(m.error?.message || 'error'), { code: m.error?.code }));
    return;
  }
  if (m.k !== 'evt') return;
  const ok = typeof m.type === 'string' && VALID[m.type] && m.p && typeof m.p === 'object' && VALID[m.type](m.p);
  if (!ok) { T.rejected.push({ t: Date.now(), type: String(m.type).slice(0, 40) }); return; }
  T.events.push({ seq: ++seq, t: Date.now(), type: m.type, p: m.p });
  if (T.events.length > 5000) T.events.splice(0, 1000);
  if (m.type === 'tab.key') T.shortcuts.push({ combo: m.p.combo, source: 'engine', tabId: m.p.tabId, t: Date.now() });
  if (m.type === 'tab.title') document.getElementById('title').textContent = m.p.title; // text, never HTML
  if (m.type === 'needTicket') renewTicket(m.p.reason);
}

async function renewTicket(reason) {
  if (Date.now() - lastTicketAt < 2000) return; // rate limit (the endpoint is limited to 30/min)
  lastTicketAt = Date.now();
  try { await cmd('ticket', await fetchTicket(), 30000); } catch (err) { T.ticketError = `${reason}: ${err.message}`; }
}

/* ---------------------------------------------------------------------- shortcuts + fullscreen -- */
function comboOf(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  parts.push(key);
  return parts.join('+');
}
window.addEventListener('keydown', (e) => {
  const combo = comboOf(e);
  if (combo && SHORTCUTS.includes(combo)) { e.preventDefault(); T.shortcuts.push({ combo, source: 'app', t: Date.now() }); }
}, true);
document.addEventListener('fullscreenchange', () => {
  T.fullscreenLog.push({ t: Date.now(), engineFullscreen: document.fullscreenElement === iframe, any: !!document.fullscreenElement });
});

/* ---------------------------------------------------------------------------- main-thread lag -- */
{
  let last = performance.now();
  setInterval(() => {
    const t = performance.now();
    const d = t - last - 50;
    if (d > 0) { T.lag.total += d; if (d > T.lag.max) T.lag.max = d; if (d > 50) T.lag.over50++; }
    last = t;
  }, 50);
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { T.lag.longTasks++; T.lag.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: false });
  } catch { /* Firefox */ }
}
