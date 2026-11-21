// Request capture for the isolation and leak suites (docs/research/spike-engine-host.md, items 3 and 4).
// Every request of every page of a browser context is classified:
//   proxied  an engine URL on the proxy origin (/~/sj/... or /uv/service/...); `target` is the decoded real URL
//   infra    engine host, SW, vendor files, /wisp/, API, CSP reports on the proxy origin; app-origin files
//   stray    another path on the proxy origin: a URL the engine did not rewrite that resolved against the proxy
//            origin (broken resource, not a leak)
//   native   any other http(s) host: a request that bypassed the proxy engines (a LEAK)
// Chromium also gets a CDP session per page for initiators and CSP block reasons; Firefox relies on Playwright's
// request events plus the sentinel proxy (servers/sentinel.mjs) that sees every non-loopback egress.
import { APP_ORIGIN, PROXY_ORIGIN, PORTS } from './config.mjs';

const LOCAL_ORIGINS = new Set([APP_ORIGIN, PROXY_ORIGIN, `http://localhost:${PORTS.app}`, `http://localhost:${PORTS.proxy}`]);

// Ultraviolet's xor codec (uv.bundle.js Ultraviolet.codec.xor.decode).
export function uvDecode(s) {
  if (!s) return s;
  const [input, ...search] = s.split('?');
  let d;
  try { d = decodeURIComponent(input); } catch { return null; }
  return d.split('').map((c, i) => (i % 2 ? String.fromCharCode(c.charCodeAt(0) ^ 2) : c)).join('') + (search.length ? `?${search.join('?')}` : '');
}

// Real URL behind a proxy-origin engine URL, or null.
export function decodeEngineUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.origin !== PROXY_ORIGIN) return null;
  if (u.pathname.startsWith('/~/sj/')) {
    const rest = u.pathname.split('/').slice(4).join('/');
    try { return decodeURIComponent(rest); } catch { return rest; }
  }
  if (u.pathname.startsWith('/uv/service/')) return uvDecode(raw.slice((PROXY_ORIGIN + '/uv/service/').length));
  return null;
}

export function classify(raw) {
  let u;
  try { u = new URL(raw); } catch { return { kind: 'other' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return { kind: 'other' };
  const origin = `${u.protocol.replace('ws', 'http')}//${u.host}`;
  if (origin === PROXY_ORIGIN) {
    const target = decodeEngineUrl(raw);
    if (target !== null) return { kind: 'proxied', target };
    if (/^\/(engine\/|vendor\/|sw\.js$|wisp\/|api\/|__csp-report$|favicon\.ico$)/.test(u.pathname)) return { kind: 'infra' };
    return { kind: 'stray' };
  }
  if (LOCAL_ORIGINS.has(origin)) return { kind: 'infra' };
  if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === PORTS.target) return { kind: 'native', direct: 'target' };
  return { kind: 'native' };
}

// Browser background traffic that reaches the sentinel without any page involvement.
export const BROWSER_NOISE = /(^|\.)(google\.com|googleapis\.com|gstatic\.com|gvt1\.com|googleusercontent\.com|google-analytics\.com|doubleclick\.net|mozilla\.(com|net|org)|firefox\.com|mozaws\.net|mozgcp\.net|services\.mozilla\.com|digicert\.com|r3\.o\.lencr\.org|lencr\.org|ocsp\.[a-z0-9.-]+)(:\d+)?$/i;

export function sentinelHost(e) {
  if (e.kind === 'connect') return String(e.target || '').replace(/:\d+$/, '');
  try { return new URL(e.url).hostname; } catch { return String(e.url || ''); }
}

export class NetWatch {
  constructor(context, browserName) {
    this.context = context;
    this.browserName = browserName;
    this.reqs = []; // {i, t, url, method, type, kind, target?, frame, nav, sw, status?, failure?, initiator?}
    this.byRequest = new Map();
    this.cdp = []; // {t, url, initiator, type, blockedReason?}
    this.cdpById = new Map();
    this.sessions = [];
    this.onRequest = (r) => this.addRequest(r);
    this.onFailed = (r) => {
      const rec = this.byRequest.get(r);
      if (rec) rec.failure = r.failure()?.errorText || 'failed';
    };
    this.onResponse = (resp) => {
      const rec = this.byRequest.get(resp.request());
      if (rec) {
        rec.status = resp.status();
        try { rec.fromSW = resp.fromServiceWorker(); } catch { /* old playwright */ }
      }
    };
    this.onPage = (p) => { this.attachCdp(p).catch(() => {}); };
    context.on('request', this.onRequest);
    context.on('requestfailed', this.onFailed);
    context.on('response', this.onResponse);
    context.on('page', this.onPage);
  }

  addRequest(r) {
    const url = r.url();
    const c = classify(url);
    if (c.kind === 'other') return;
    let frame = null;
    let sw = false;
    try { sw = Boolean(r.serviceWorker && r.serviceWorker()); } catch { /* n/a */ }
    if (!sw) { try { frame = r.frame()?.url()?.slice(0, 200) || null; } catch { frame = null; } }
    const rec = { i: this.reqs.length, t: Date.now(), url: url.slice(0, 500), method: r.method(), type: r.resourceType(), kind: c.kind, target: c.target ? c.target.slice(0, 500) : undefined, direct: c.direct, frame, nav: r.isNavigationRequest(), sw };
    this.reqs.push(rec);
    this.byRequest.set(r, rec);
  }

  async attachCdp(page) {
    if (this.browserName !== 'chromium') return;
    const s = await this.context.newCDPSession(page);
    this.sessions.push(s);
    s.on('Network.requestWillBeSent', (e) => {
      const ini = e.initiator || {};
      const top = ini.stack?.callFrames?.[0] || ini.stack?.parent?.callFrames?.[0] || null;
      const rec = { t: Date.now(), id: e.requestId, url: String(e.request?.url || '').slice(0, 500), type: e.type, initiator: { type: ini.type, url: ini.url ? ini.url.slice(0, 300) : undefined, line: ini.lineNumber, stackUrl: top ? String(top.url).slice(0, 300) : undefined, fn: top ? top.functionName : undefined } };
      this.cdp.push(rec);
      this.cdpById.set(e.requestId, rec);
    });
    s.on('Network.loadingFailed', (e) => {
      const rec = this.cdpById.get(e.requestId);
      if (rec) { rec.errorText = e.errorText; rec.blockedReason = e.blockedReason; rec.corsError = e.corsErrorStatus?.corsError; }
    });
    await s.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => s.send('Network.enable'));
  }

  async attachExisting() {
    for (const p of this.context.pages()) await this.attachCdp(p).catch(() => {});
  }

  mark() { return { r: this.reqs.length, c: this.cdp.length, t: Date.now() }; }

  since(m) {
    const reqs = this.reqs.slice(m.r);
    const cdp = this.cdp.slice(m.c);
    return { reqs, cdp };
  }

  // Native requests since mark m, deduplicated by URL, with Chromium initiators attached.
  natives(m) {
    const { reqs, cdp } = this.since(m);
    const out = new Map();
    for (const r of reqs) {
      if (r.kind !== 'native') continue;
      const prev = out.get(r.url);
      if (prev) { prev.count++; continue; }
      const c = cdp.find((x) => x.url === r.url);
      out.set(r.url, { url: r.url, type: r.type, method: r.method, frame: r.frame, nav: r.nav, sw: r.sw, failure: r.failure, status: r.status, initiator: c ? c.initiator : undefined, blockedReason: c ? c.blockedReason : undefined, count: 1 });
    }
    // CDP-only natives (requests Playwright did not surface, e.g. CSP-blocked before the network)
    for (const c of cdp) {
      if (classify(c.url).kind !== 'native' || out.has(c.url)) continue;
      out.set(c.url, { url: c.url, type: c.type, initiator: c.initiator, blockedReason: c.blockedReason, errorText: c.errorText, cdpOnly: true, count: 1 });
    }
    return [...out.values()];
  }

  counts(m) {
    const { reqs } = this.since(m);
    const n = { proxied: 0, infra: 0, stray: 0, native: 0, failedProxied: 0 };
    for (const r of reqs) {
      n[r.kind] = (n[r.kind] || 0) + 1;
      if (r.kind === 'proxied' && (r.failure || (r.status && r.status >= 500))) n.failedProxied++;
    }
    return n;
  }

  strays(m) {
    return [...new Set(this.since(m).reqs.filter((r) => r.kind === 'stray').map((r) => r.url))];
  }

  async close() {
    this.context.off('request', this.onRequest);
    this.context.off('requestfailed', this.onFailed);
    this.context.off('response', this.onResponse);
    this.context.off('page', this.onPage);
    for (const s of this.sessions) await s.detach().catch(() => {});
  }
}

// Wait until no new request arrived for `quietMs` (or `maxMs` passed).
export async function settle(watch, { quietMs = 2500, maxMs = 15000 } = {}) {
  const t0 = Date.now();
  let last = watch.reqs.length;
  let lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 250));
    if (watch.reqs.length !== last) { last = watch.reqs.length; lastChange = Date.now(); }
    if (Date.now() - lastChange >= quietMs) return Date.now() - t0;
  }
  return Date.now() - t0;
}
