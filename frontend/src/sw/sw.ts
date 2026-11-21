/**
 * GNOME's service worker: `/sw.js` on the proxy origin, a classic script at scope `/` (built as an IIFE by
 * vite.sw.config.ts), one worker for both engines (ARCHITECTURE §5.4; port of spike §4.11):
 *
 *   /~/sj/*        Scramjet controller routing. Held while no controller has (re)announced its prefix (the worker
 *                  asks window clients to revive it), then 503; a prefix whose engine host is gone gets 503
 *                  `stale-prefix` at once. Never passed to the network.
 *   /uv/service/*  Ultraviolet 3.2.10 with GNOME's fixes: Firefox request bodies, the document-start hook in every
 *                  HTML document UV rewrites (through UV's own parsed-tree injection), download taps, transport-error
 *                  reports, the step-3 request hooks; `sharedworker` scripts are refused (UV serves them unrewritten).
 *   anything else  passes through (no respondWith).
 *
 * Both engines are shown `<frame>` loads as `iframe` loads (they rewrite HTML only for document/iframe), and a document
 * an engine left unrewritten that could run scripts gets SCRIPTLESS_CSP next to PROXIED_DOCUMENT_CSP (pure.ts).
 *
 * It takes no security configuration at runtime: PROXIED_DOCUMENT_CSP is added to every response with a navigable or
 * worker destination it passes through (both engines, engine error pages included), and its own pages carry
 * SW_PAGE_CSP (`default-src 'none'`, no forms, no base). Signals go to engine-host window clients only, with
 * Client.postMessage (never a BroadcastChannel, which any proxied page can join), and messages count only from the
 * engine-host client (`/engine/`).
 */

import { safeVerdict, type RequestInfo, type ResponseHeaders } from '../shared/engine-hooks';
import { browserFromUa, preprocessorEnv } from '../extensions/filters/config';
import { startSwBlocker } from '../extensions/sw/blocker';
import type { SwContext } from '../extensions/sw/blocker';
import { SwEngines } from '../extensions/sw/engines';
import { EngineHostRegistry } from '../extensions/sw/hosts';
import { UV_SCRIPT_COOKIE_DESTINATIONS, blankUvScriptCookies, swProviders, verdictBlocksCookies } from '../extensions/sw/providers';
import { validateEngineSettings } from '../shared/engine-protocol';
import {
  PROXY_PATHS,
  SW_IMPORTS,
  downloadFilename,
  isEngineHostClientUrl,
  parseHostToSw,
  type SwSignal,
} from '../shared/proxy-origin';
import { registerSwHooks, swHooks } from './hooks';
import {
  HOLD_MS,
  REVIVE_EVERY_MS,
  bareMime,
  blockedResponse,
  contentLength,
  createBodyFix,
  documentHookInstalled,
  downloadDecision,
  ensureProxiedCsp,
  forEngines,
  injectDocumentHook,
  isStalePrefix,
  referrerFor,
  refusedResponse,
  resourceBytes,
  scramjetNeedsScriptless,
  scramjetPrefixOf,
  tapDownloadStream,
  unavailableResponse,
  uvNeedsScriptless,
  uvRefusesDestination,
} from './pure';

const sw = self as unknown as ServiceWorkerGlobalScope & { __uv$config: UvConfig };

// Updates: controller.sw.js calls skipWaiting() on install (and clients.claim() on activate), so a new /sw.js would
// take over running engine hosts at once, which breaks both engines (spike §4.11, verified). The update waits instead;
// the engine host applies it at startup when it is the only one (gnome-skip-waiting below). First installs still
// activate at once (nothing is waiting for them).
const realSkipWaiting = sw.skipWaiting.bind(sw);
sw.skipWaiting = () => Promise.resolve();
importScripts(...SW_IMPORTS);

const STARTED_AT = Date.now();
const UV_PREFIX = sw.__uv$config.prefix;
const log = (message: string): void => console.warn(`[gnome sw] ${message}`);

// ── Signals to the engine hosts ──────────────────────────────────────────────────────────────────────────────────

/**
 * Engine hosts by client id (WAVE-B3 §4.5, F3): a client created by a navigation to /engine/, or one that loaded
 * before this SW (re)started whose URL is /engine/ and that was never seen as a proxied document or worker.
 */
const registry = new EngineHostRegistry();

async function engineHosts(): Promise<Client[]> {
  const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((c) => registry.accept(c.id, isEngineHostClientUrl(c.url, sw.location.origin)));
}

function signal(msg: SwSignal): Promise<void> {
  return engineHosts().then(
    (hosts) => {
      for (const c of hosts) c.postMessage(msg);
    },
    () => {},
  );
}

const hello = (): SwSignal => ({ type: 'sw-hello', build: __GNOME_BUILD__, startedAt: STARTED_AT });
void signal(hello());

// ── Messages from the engine host ───────────────────────────────────────────────────────────────────────────────

/** Scramjet prefixes ("/~/sj/<id>/") → id of the engine-host client that announced them. */
const owners = new Map<string, string>();

sw.addEventListener('message', (e: ExtendableMessageEvent) => {
  const data = e.data as unknown;
  const source = e.source;
  // Scramjet's controller announces its prefix with $controller$init (controller.sw.js handles the message itself).
  if (data && typeof data === 'object' && source && 'id' in source) {
    const init = (data as { $controller$init?: { prefix?: unknown } }).$controller$init;
    if (init && typeof init.prefix === 'string' && init.prefix.length <= 200) owners.set(init.prefix, source.id);
  }
  if (!source || !('url' in source) || (source as Client).type !== 'window') return;
  if (!registry.accept((source as Client).id, isEngineHostClientUrl(source.url, sw.location.origin))) return;
  const msg = parseHostToSw(data);
  if (!msg) return;
  switch (msg.type) {
    case 'gnome-claim':
      // A forced reload loaded the engine host uncontrolled.
      e.waitUntil(sw.clients.claim());
      return;
    case 'gnome-hello':
      (source as Client).postMessage(hello());
      return;
    case 'gnome-skip-waiting':
      // The apply step (ENGINE-PROTOCOL §2.5): only when the sender is the only engine host.
      e.waitUntil(
        engineHosts().then(async (hosts) => {
          if (hosts.length <= 1) await realSkipWaiting();
        }),
      );
      return;
    case 'gnome-blocker-config': {
      const v = validateEngineSettings(msg.settings);
      if (!v.ok) return;
      blocker.onConfig((source as Client).id, { privacy: v.value.privacy, extensions: v.value.extensions }, msg.setId);
      // Hosts that are gone (a closed GNOME tab) stop contributing their scoped maps.
      e.waitUntil(
        Promise.all(
          blocker.hostIds().map(async (id) => {
            if (!(await sw.clients.get(id))) {
              blocker.forgetHost(id);
              registry.forget(id);
            }
          }),
        ).catch(() => undefined),
      );
      return;
    }
    case 'gnome-blocker-engines':
      blocker.onEngines((source as Client).id, msg);
      return;
    case 'gnome-blocker-context':
      blocker.onContext((source as Client).id, msg);
      return;
  }
});

// ── The content blocker (Wave B step 3, WAVE-B3 §4.5) ──────────────────────────────────────────────────────────

const engines = new SwEngines(preprocessorEnv(browserFromUa(navigator.userAgent)));
/** Privacy headers and cookie modes apply from the first request (SW_FALLBACK_SETTINGS); lists once engines arrive. */
const blocker = startSwBlocker({
  signal: (m) => void signal(m),
  decode: (proxied) => {
    try {
      const u = new URL(proxied, sw.location.origin);
      if (u.origin !== sw.location.origin || !u.pathname.startsWith(UV_PREFIX)) return null;
      return sw.__uv$config.decodeUrl(u.href.slice(sw.location.origin.length + UV_PREFIX.length));
    } catch {
      return null;
    }
  },
  log,
  engines,
  providers: (rewriteParams) => swProviders({ rewriteParams }),
});
registerSwHooks(blocker.hooks);
/** The page context of each UV request, by the request UV sees (WAVE-B3 D15). */
const contexts = new WeakMap<Request, SwContext>();

// ── Firefox request bodies ───────────────────────────────────────────────────────────────────────────────────────

const bodies = createBodyFix(Request.prototype, 'body' in Request.prototype);

// ── Scramjet ─────────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What scramjet-controller's route() reads of a FetchEvent, with the request as the engines see it (forEngines). */
function scramjetEvent(event: FetchEvent): FetchEvent {
  const request = forEngines(event.request);
  if (request === event.request) return event;
  return { request, clientId: event.clientId, resultingClientId: event.resultingClientId } as unknown as FetchEvent;
}

async function handleScramjet(event: FetchEvent, url: URL): Promise<Response> {
  const t0 = Date.now();
  // controller.sw.js asks every client to revive 100 ms after the worker starts. Each revive makes the engine host's
  // Controller announce a NEW port and replace the old one, which loses a request already sent on the old port (seen
  // in Firefox, whose idle worker restarts while engine hosts run). So the hold waits a full interval before it adds
  // a revive of its own, and stops as soon as a controller can route.
  let lastRevive = t0;
  while (!$scramjetController.shouldRoute(event)) {
    // After a SW restart the controller list is empty until the engine host re-sends its port
    // ($controller$swrevive → $controller$init); the controller ignores revives in its first 5 s, so repeat them.
    if (Date.now() - t0 >= HOLD_MS) {
      void signal({ type: 'sw-unavailable', reason: 'not-routable' });
      return unavailableResponse('not-routable', event.request.destination);
    }
    if (Date.now() - lastRevive >= REVIVE_EVERY_MS) {
      lastRevive = Date.now();
      for (const c of await sw.clients.matchAll({ type: 'window' })) c.postMessage({ $controller$swrevive: {} });
    }
    await sleep(50);
  }
  const held = Date.now() - t0;
  if (held > 0) void signal({ type: 'sw-held', ms: held });
  const prefix = scramjetPrefixOf(url.pathname);
  const owner = prefix ? owners.get(prefix) : undefined;
  if (owner !== undefined) {
    const live = (await sw.clients.get(owner)) ? new Set([owner]) : new Set<string>();
    if (isStalePrefix(owners, prefix, live)) {
      void signal({ type: 'sw-unavailable', reason: 'stale-prefix' });
      return unavailableResponse('stale-prefix', event.request.destination);
    }
  }
  return $scramjetController.route(scramjetEvent(event));
}

// ── Ultraviolet ──────────────────────────────────────────────────────────────────────────────────────────────────

const uv = new UVServiceWorker();
/** The FetchEvent of each UV request, by the request UV sees (forEngines): the handlers need its clientId. */
const fetchEvents = new WeakMap<Request, FetchEvent>();
/** UV requests whose answer is a document UV did not rewrite (SCRIPTLESS_CSP), by the request UV sees. */
const scriptless = new WeakSet<Request>();

// The document-start hook goes into every HTML document UV rewrites through UV's own injection (pure.ts
// injectDocumentHook): UV's service worker calls `config.construct(instance, 'service')` on each instance it creates.
{
  const previous = uv.config.construct;
  let warned = false;
  uv.config.construct = (instance, context) => {
    if (typeof previous === 'function') previous(instance, context);
    if (!injectDocumentHook(instance) && !warned) {
      warned = true;
      log('this Ultraviolet build has no createHtmlInject: its documents are served without scripts');
    }
  };
}

// Transport errors with the target URL (UV's error page is only the visible half), and the Firefox body fix.
const bareFetch = bodies.wrapFetch(uv.bareClient.fetch.bind(uv.bareClient));
uv.bareClient.fetch = async (target, init) => {
  try {
    return await bareFetch(target, init);
  } catch (err) {
    void signal({
      type: 'uv-error',
      url: String(target).slice(0, 8192),
      message: String((err as { message?: unknown } | null)?.message ?? err).slice(0, 500),
    });
    throw err;
  }
};

const proxiedUrl = (real: string): string => `${sw.location.origin}${UV_PREFIX}${sw.__uv$config.encodeUrl(real)}`;

function requestInfo(ctx: UvRequestContext): RequestInfo {
  const c = contexts.get(ctx.request);
  const info: RequestInfo = {
    engine: 'ultraviolet' as const,
    tabId: null,
    url: ctx.url.href,
    method: ctx.method.toUpperCase(),
    destination: ctx.request.destination,
    topLevelUrl: c?.topLevelUrl ?? null,
    isTopLevelDocument: c?.isTopLevelDocument ?? false,
    documentUrl: c?.documentUrl ?? null,
    referrer: typeof ctx.headers.referer === 'string' ? ctx.headers.referer : null,
  };
  blocker.attach(info, c?.documentProxied ?? null);
  return info;
}

uv.on('request', (event) => {
  const ctx = event.data;
  // UV sends the whole referring URL it decoded from the browser's same-origin referrer: apply the request's own
  // referrer policy to the real URLs, as a browser does (default: only the origin to another origin).
  const ref = ctx.headers.referer;
  if (typeof ref === 'string') {
    const next = referrerFor(ref, ctx.url.href, ctx.request.referrerPolicy);
    if (next === null) delete ctx.headers.referer;
    else ctx.headers.referer = next;
  }
  const verdict = safeVerdict(swHooks(), requestInfo(ctx), (err) => log(`onRequest hook: ${String(err)}`));
  if (verdict.action === 'block') {
    // Counted by the composite (uv-blocked batches per document). A `$redirect` resource only for subresources
    // (safeVerdict dropped any for navigations, D10); a script goes through UV's own JS rewriter first, because UV
    // returns an intercepted request before rewriting it [unproven] (row N6); if that fails, a plain block.
    const r = verdict.resource;
    if (r) {
      let body = resourceBytes(r);
      if (body !== null && /javascript|ecmascript/.test(r.contentType)) {
        try {
          const rw = ctx.ultraviolet.js?.rewrite;
          body = typeof body === 'string' && rw ? rw.call(ctx.ultraviolet.js, body) : null;
        } catch {
          body = null;
        }
      }
      if (body !== null) {
        event.respondWith(new Response(body, { status: 200, headers: { 'content-type': r.contentType, 'cache-control': 'no-store' } }));
        return;
      }
    }
    event.respondWith(blockedResponse(verdict.category, ctx.request.destination));
    return;
  }
  if (verdict.action === 'redirect') {
    event.respondWith(new Response(null, { status: 307, headers: { location: proxiedUrl(verdict.url), 'cache-control': 'no-store' } }));
    return;
  }
  for (const name of verdict.headers?.remove ?? []) delete ctx.headers[name.toLowerCase()];
  for (const [name, value] of verdict.headers?.set ?? []) ctx.headers[name.toLowerCase()] = value;
  // Lane x3 (row K3c): a document or worker whose own cookies are blocked gets an empty script cookie string (UV's
  // handler shares that string with every about:blank child of the document).
  if (UV_SCRIPT_COOKIE_DESTINATIONS.has(ctx.request.destination) && verdictBlocksCookies(verdict)) blankUvScriptCookies(ctx.ultraviolet);
});

function headerView(h: Record<string, string | string[]>): ResponseHeaders {
  const key = (n: string): string => n.toLowerCase();
  return {
    get: (n) => {
      const v = h[key(n)];
      return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
    },
    getAll: (n) => {
      const v = h[key(n)];
      return v === undefined ? [] : Array.isArray(v) ? [...v] : [v];
    },
    set: (n, v) => {
      h[key(n)] = v;
    },
    append: (n, v) => {
      const cur = h[key(n)];
      h[key(n)] = cur === undefined ? [v] : Array.isArray(cur) ? [...cur, v] : [cur, v];
    },
    delete: (n) => {
      delete h[key(n)];
    },
  };
}

uv.on('beforemod', (event) => {
  const r = event.data;
  try {
    swHooks().onResponse({ ...requestInfo(r.request), status: r.status }, headerView(r.headers));
  } catch (err) {
    log(`onResponse hook: ${String(err)}`);
  }
});

let downloadSeq = 0;

function trackDownload(r: UvResponseContext, req: Request, decision: { navigation: boolean; disposition: 'attachment' | 'unrendered-type' }): void {
  const id = `uv-${STARTED_AT.toString(36)}-${++downloadSeq}`;
  const fe = fetchEvents.get(req);
  const total = contentLength(r.getHeader('content-length'));
  // started first, then progress/done in order (the client URL lookup is asynchronous).
  let chain: Promise<void> = (async () => {
    const client = fe?.clientId ? await sw.clients.get(fe.clientId) : undefined;
    await signal({
      type: 'uv-download',
      phase: 'started',
      id,
      url: req.url.slice(0, 8192),
      referrer: req.referrer ? req.referrer.slice(0, 8192) : null,
      clientUrl: client ? client.url.slice(0, 8192) : null,
      navigation: decision.navigation,
      disposition: decision.disposition,
      filename: downloadFilename(r.getHeader('content-disposition') ?? null, r.url.href),
      mime: bareMime(r.getHeader('content-type') ?? null),
      total,
    });
  })().catch(() => {});
  const then = (msg: SwSignal): void => {
    chain = chain.then(() => signal(msg));
  };
  const source = r.body instanceof ReadableStream ? (r.body as ReadableStream<Uint8Array>) : (new Response(r.body as BodyInit).body as ReadableStream<Uint8Array>);
  r.body = tapDownloadStream(source, {
    progress: (received) => then({ type: 'uv-download', phase: 'progress', id, received, total }),
    done: (state, received, error) => then({ type: 'uv-download', phase: 'done', id, state, received, error }),
  });
}

uv.on('response', (event) => {
  const r = event.data;
  const req = r.request.request;
  const contentType = r.getHeader('content-type') ?? null;
  // UV turns the HTML of document/iframe answers into a string (its rewriter, with the hook in <head>); any other
  // frame answer that can run scripts reaches the page as it is, so its scripts must not run (SCRIPTLESS_CSP).
  const rewritten = typeof r.body === 'string' && documentHookInstalled(r.request.ultraviolet);
  if (uvNeedsScriptless(req.destination, rewritten, bareMime(contentType))) scriptless.add(req);
  const decision = downloadDecision(req, r.getHeader('content-disposition') ?? null, contentType);
  if (decision && r.body) trackDownload(r, req, decision);
});

// ── Dispatch ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * e2e builds only: says which request an engine failed (the browser's own console line for a rejected respondWith,
 * e.g. Firefox's "Failed to load ‘’. A ServiceWorker intercepted the request and encountered an unexpected error",
 * may not name it: quality review, integration part 2). The error still reaches the browser.
 */
function noteFailure(req: Request, url: URL): (err: unknown) => never {
  return (err) => {
    if (__GNOME_ENGINE_TEST__) log(`an engine failed ${req.method} ${req.destination || 'fetch'}/${req.mode} ${url.pathname.slice(0, 48)}…: ${String(err).slice(0, 200)}`);
    throw err;
  };
}

sw.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const dest = req.destination;
  const engineDoc = url.pathname.startsWith(PROXY_PATHS.scramjetPrefix) || url.pathname.startsWith(UV_PREFIX);
  // Which clients are engine hosts and which are proxied documents or workers (F3).
  if (req.mode === 'navigate') registry.navigation(event.resultingClientId, url.pathname, PROXY_PATHS.engineHost, engineDoc);
  else if (engineDoc && (dest === 'worker' || dest === 'sharedworker')) registry.markProxied(event.resultingClientId);
  if (url.pathname.startsWith(PROXY_PATHS.scramjetPrefix)) {
    event.respondWith(
      bodies
        .bufferBody(req)
        .then(() => handleScramjet(event, url))
        .then((res) => ensureProxiedCsp(res, dest, { scriptless: scramjetNeedsScriptless(dest, bareMime(res.headers.get('content-type'))) }))
        .catch(noteFailure(req, url)),
    );
    return;
  }
  if (url.pathname.startsWith(UV_PREFIX)) {
    if (uvRefusesDestination(dest)) {
      event.respondWith(refusedResponse(dest));
      return;
    }
    const seen = forEngines(req);
    fetchEvents.set(seen, event);
    const navigation = req.mode === 'navigate' && (dest === 'document' || dest === 'iframe' || dest === 'frame');
    if (navigation || dest === 'worker') blocker.onClient(event.resultingClientId, req.url, event.clientId || null, req.referrer || null);
    event.respondWith(
      bodies
        .bufferBody(req)
        .then(() => blocker.ready())
        .then(() => blocker.context(event, req))
        .then(async (c) => {
          contexts.set(seen, c);
          const res = await uv.fetch({ request: seen } as unknown as FetchEvent);
          // A tab-top navigation answered with a redirect (UV's rewritten Location, or GNOME's own 307 of parameter
          // stripping): the next hop is the tab's own document too (D3), recorded before the browser follows it.
          if (c.isTopLevelDocument && res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (location) {
              try {
                blocker.redirected(c, new URL(location, req.url).href);
              } catch {
                /* an unusable Location: the browser does not follow it either */
              }
            }
          }
          return res;
        })
        .then((res) => ensureProxiedCsp(res, dest, { scriptless: scriptless.has(seen) }))
        .catch(noteFailure(req, url)),
    );
  }
  // Everything else (engine host, vendor files, /wisp/, /api/) goes to the network untouched.
});

