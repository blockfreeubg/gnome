/* GNOME engine-host service worker (spike of frontend/src/sw/; ARCHITECTURE §5.4).
 * ONE classic SW at scope "/" of the PROXY origin, for both engines:
 *   /~/sj/*        Scramjet controller routing. Held until the controller has (re)announced its prefix, then a
 *                  503 after HOLD_MS. Never passed through to the network. A prefix whose engine-host window
 *                  is gone (app reload) gets an immediate 503 instead of hanging forever.
 *   /uv/service/*  Ultraviolet 3.2.10 with GNOME's fixes: Firefox request bodies, document-start hook, GNOME
 *                  CSP on proxied documents (optional), download progress, error reporting.
 *   everything else passes through (no respondWith).
 */
/* global $scramjetController, UVServiceWorker */
// SW updates: controller.sw.js calls skipWaiting() on install (and clients.claim() on activate), so a new /sw.js (a
// deploy) would take over RUNNING engine hosts at once. Both engines break in that state (verified, session 4):
// Scramjet's Controller keeps announcing its prefix to the old, now redundant worker, and UV requests made more than a
// few seconds after the swap hang. GNOME keeps the normal update flow instead: a new version waits until no engine
// host uses the old one (the next app reload). First installs still activate at once, and gnome-claim still works.
self.skipWaiting = () => Promise.resolve();
importScripts('/vendor/scramjet-controller/controller.sw.js');
importScripts('/vendor/ultraviolet/uv.bundle.js', '/engine/uv.config.js', '/vendor/ultraviolet/uv.sw.js');

const SJ_PREFIX = '/~/sj/';
const UV_PREFIX = self.__uv$config.prefix;
const HOLD_MS = 5000;
const bus = new BroadcastChannel('gnome-engine');
const swStartedAt = Date.now();
// Runtime config pushed by the engine host (lost when the SW restarts; the host re-sends it on "sw-start"). It is
// accepted only from the SW message event of the engine-host client (/engine/). The gnome-engine BroadcastChannel can
// be joined by any proxied page, so it is ignored unless the engine host opted in (settings.swConfigBus, attack
// tests). Production hard-wires the policy here instead of taking any runtime config.
let config = { csp: 'off', cspPolicy: '', bodyFix: true };
let acceptBusConfig = false;
bus.postMessage({ type: 'sw-start', at: swStartedAt });
bus.onmessage = (e) => {
  if (acceptBusConfig && e.data && e.data.type === 'sw-config') config = { ...config, ...e.data.config };
};
function fromEngineHost(source) {
  try { return !!source && source.type === 'window' && new URL(source.url).origin === location.origin && new URL(source.url).pathname === '/engine/'; } catch { return false; }
}

/* ---- Firefox request bodies -------------------------------------------------------------------------------
 * Firefox has no Request.prototype.body (verified: firefox-1555 / Firefox 157). Both engines read it:
 * controller.sw.js forwards `event.request.body` to the controller (it reads the property three times and
 * transfers the third value, so every read must return the SAME object), and bare-mux's BareClient.fetch forwards
 * `new Request(url, init).body` to its SharedWorker. Firefox also has no streaming request bodies, so a
 * ReadableStream body reaching libcurl.js / epoxy is turned into the string "[object ReadableStream]" (verified).
 * Fix (verified in spike-core nav suite): buffer the body into ONE ArrayBuffer before an engine sees the request
 * (bufferBody, WeakMap per Request), and hand bare-mux's internal Request the same ArrayBuffer (nextBody). */
const NATIVE_REQUEST_BODY = 'body' in Request.prototype;
const bufferedBodies = new WeakMap(); // Request -> ArrayBuffer
let nextBody = null; // consumed by the next Request.body read (bare-mux reads it synchronously, see uv.bareClient.fetch)
if (!NATIVE_REQUEST_BODY) {
  Object.defineProperty(Request.prototype, 'body', {
    configurable: true,
    enumerable: true,
    get() {
      if (nextBody) { const b = nextBody; nextBody = null; return b; }
      if (bufferedBodies.has(this)) return bufferedBodies.get(this);
      return null;
    },
  });
}
async function bufferBody(request) {
  if (NATIVE_REQUEST_BODY || !config.bodyFix || request.method === 'GET' || request.method === 'HEAD') return;
  const buf = await request.clone().arrayBuffer();
  if (buf.byteLength) bufferedBodies.set(request, buf);
}

/* ---- Scramjet --------------------------------------------------------------------------------------------- */
const owners = new Map(); // controller prefix ("/~/sj/<id>/") -> clientId of the engine host that announced it
addEventListener('message', (e) => {
  const d = e.data;
  if (d && typeof d === 'object' && d.$controller$init && e.source) owners.set(d.$controller$init.prefix, e.source.id);
  // An engine host loaded by a forced reload is uncontrolled; it asks to be claimed (host.js ensureServiceWorker).
  if (d && typeof d === 'object' && d.type === 'gnome-claim') e.waitUntil(self.clients.claim());
  if (d && typeof d === 'object' && d.type === 'gnome-sw-config' && d.config && typeof d.config === 'object' && fromEngineHost(e.source)) {
    const { acceptBusConfig: viaBus, ...rest } = d.config;
    config = { ...config, ...rest };
    acceptBusConfig = viaBus === true;
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unavailable(request, reason) {
  bus.postMessage({ type: 'sw-503', reason, path: new URL(request.url).pathname.slice(0, 120), dest: request.destination });
  const doc = request.destination === 'document' || request.destination === 'iframe';
  const body = doc
    ? `<!doctype html><meta charset="utf-8"><title>Proxy engine unavailable</title><p>GNOME: the proxy engine is not available for this page (${reason}).</p>`
    : '';
  return new Response(body, {
    status: 503,
    statusText: 'Proxy engine unavailable',
    headers: { 'content-type': doc ? 'text/html; charset=utf-8' : 'text/plain', 'cache-control': 'no-store', 'x-gnome-sw': reason },
  });
}

async function handleScramjet(event, url) {
  const t0 = Date.now();
  let lastRevive = 0;
  while (!$scramjetController.shouldRoute(event)) {
    // After a SW restart the controller list is empty until the engine host re-sends its port
    // ($controller$swrevive -> $controller$init). The controller ignores revives in its first 5 s, so repeat
    // the revive while holding.
    if (Date.now() - t0 >= HOLD_MS) return unavailable(event.request, 'not-routable');
    if (Date.now() - lastRevive >= 1000) {
      lastRevive = Date.now();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ $controller$swrevive: {} });
    }
    await sleep(50);
  }
  const held = Date.now() - t0;
  if (held > 0) bus.postMessage({ type: 'sw-held', ms: held, path: url.pathname.slice(0, 80) });
  const prefix = SJ_PREFIX + url.pathname.slice(SJ_PREFIX.length).split('/')[0] + '/';
  const owner = owners.get(prefix);
  if (owner && !(await self.clients.get(owner))) return unavailable(event.request, 'stale-prefix');
  return $scramjetController.route(event);
}

/* ---- Ultraviolet ------------------------------------------------------------------------------------------ */
const uv = new UVServiceWorker();
const DOC_HOOK = '<script src="/engine/uv-doc-hook.js"></script>';

// Report transport errors with the target URL (the UV error page is only the visible half).
const bareFetch = uv.bareClient.fetch.bind(uv.bareClient);
uv.bareClient.fetch = async (target, init) => {
  try {
    if (!NATIVE_REQUEST_BODY && config.bodyFix && init && init.body != null) {
      const buf = init.body instanceof ArrayBuffer ? init.body : await new Response(init.body).arrayBuffer();
      init = { ...init, body: buf };
      nextBody = buf.byteLength ? buf : null; // bare-mux: new Request(target, init).body, read before its first await
      const p = bareFetch(target, init);
      nextBody = null;
      return await p;
    }
    return await bareFetch(target, init);
  } catch (err) {
    bus.postMessage({ type: 'uv-error', url: String(target).slice(0, 300), message: String(err && (err.message || err)).slice(0, 300) });
    throw err;
  }
};

function cspHeaderName() {
  return config.csp === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy';
}

let downloadSeq = 0;
function trackDownload(body, info) {
  const id = `uv-${swStartedAt.toString(36)}-${++downloadSeq}`;
  bus.postMessage({ type: 'download', phase: 'started', id, ...info });
  let received = 0;
  let lastReport = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (Date.now() - lastReport > 200) {
        lastReport = Date.now();
        bus.postMessage({ type: 'download', phase: 'progress', id, received, total: info.total });
      }
      controller.enqueue(chunk);
    },
    flush() {
      bus.postMessage({ type: 'download', phase: 'done', id, state: 'completed', received, total: info.total });
    },
  });
  const source = body instanceof ReadableStream ? body : new Response(body).body;
  return source.pipeThrough(counter);
}

uv.on('response', (event) => {
  const r = event.data; // UV ResponseContext: headers (object, mutable), body, getHeader()
  const req = r.request.request; // the intercepted Request
  const dest = req.destination;
  const type = String(r.getHeader('content-type') || '');
  const disposition = String(r.getHeader('content-disposition') || '');
  if (/^\s*attachment/i.test(disposition) && r.body) {
    const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    r.body = trackDownload(r.body, {
      engine: 'ultraviolet',
      url: String(r.url).slice(0, 500),
      referrer: String(req.referrer || '').slice(0, 500),
      filename: m ? decodeURIComponent(m[1]) : 'download',
      mime: type || null,
      total: Number(r.getHeader('content-length')) || null,
    });
    return;
  }
  if ((dest === 'document' || dest === 'iframe') && type.startsWith('text/html') && typeof r.body === 'string') {
    // Document-start hook (before UV's own injected scripts) so the engine host can observe the document.
    const m = /<head(\s[^>]*)?>/i.exec(r.body);
    if (m) r.body = r.body.slice(0, m.index + m[0].length) + DOC_HOOK + r.body.slice(m.index + m[0].length);
    if (config.csp !== 'off' && config.cspPolicy) r.headers[cspHeaderName()] = config.cspPolicy;
  } else if ((dest === 'worker' || dest === 'sharedworker') && config.csp !== 'off' && config.cspPolicy) {
    r.headers[cspHeaderName()] = config.cspPolicy;
  }
});

async function handleUv(event) {
  return uv.fetch(event);
}

/* ---- dispatch --------------------------------------------------------------------------------------------- */
addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(SJ_PREFIX)) return event.respondWith(bufferBody(event.request).then(() => handleScramjet(event, url)));
  if (url.pathname.startsWith(UV_PREFIX)) return event.respondWith(bufferBody(event.request).then(() => handleUv(event)));
  // Everything else (engine host, vendor files, /wisp/ upgrades, API) goes to the network untouched.
});
