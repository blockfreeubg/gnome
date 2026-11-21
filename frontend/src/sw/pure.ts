/**
 * The service worker's decisions, free of the worker globals so vitest can check them (pure.test.ts, uv-rewrite.test.ts):
 * prefix ownership, the CSP decisions, what the engines are told about a request, the document-start hook, download
 * disposition per request, the download stream tap, the SW's own pages, and the Firefox request-body fix (spike §4.11).
 */

import { PROXIED_DOCUMENT_CSP, PROXY_PATHS, bareMime, downloadDisposition, needsProxiedCsp, type DownloadDisposition } from '../shared/proxy-origin';

/** Scramjet requests are held this long while the controller re-announces its prefix, then answered 503. */
export const HOLD_MS = 5_000;
/** While holding, window clients are asked to revive the controller this often (it ignores revives in its first 5 s). */
export const REVIVE_EVERY_MS = 1_000;
/** download.progress at most this often (ENGINE-PROTOCOL §6.9). */
export const PROGRESS_EVERY_MS = 200;

/**
 * The policy of the SW's own pages (hold/503, blocked, refused): nothing runs, loads, submits or re-bases in them.
 * `form-action` and `base-uri` do not fall back to `default-src`, so they are listed: the page must be at least as
 * strict as PROXIED_DOCUMENT_CSP (no permissive realm), and escaped code that borrows it must not be able to submit a
 * form anywhere from it.
 */
export const SW_PAGE_CSP = "default-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * A second policy for a document its engine did not rewrite: its scripts would otherwise run natively on the proxy
 * origin, outside any virtualization and without the WebRTC kill switch, with the engine host and every tab one
 * `parent` away (measured in both browsers before this policy: SVG, XHTML and XML documents, and HTML without a
 * Content-Type or as `Text/HTML`, under Ultraviolet). Both policies are enforced. The same string as lane a's
 * SCRIPTLESS_DOCUMENT_CSP for Scramjet documents (src/engine-host/csp.ts).
 */
export const SCRIPTLESS_CSP = "script-src 'none'";

/** `/~/sj/<id>/` of a Scramjet URL path, or null. */
export function scramjetPrefixOf(pathname: string): string | null {
  if (!pathname.startsWith(PROXY_PATHS.scramjetPrefix)) return null;
  const id = pathname.slice(PROXY_PATHS.scramjetPrefix.length).split('/')[0] ?? '';
  return id ? `${PROXY_PATHS.scramjetPrefix}${id}/` : null;
}

/**
 * Whether an engine-prefix request belongs to an engine host that is gone: the prefix was announced by a client
 * (owners) that no longer exists. Unknown prefixes are not stale (a SW restart forgets owners; the hold revives).
 */
export function isStalePrefix(owners: ReadonlyMap<string, string>, prefix: string | null, liveClientIds: ReadonlySet<string>): boolean {
  if (!prefix) return false;
  const owner = owners.get(prefix);
  return owner !== undefined && !liveClientIds.has(owner);
}

/** The policies of a Content-Security-Policy header value (comma-separated), trimmed. */
function policiesOf(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Headers with GNOME's proxied-document CSP added, and SCRIPTLESS_CSP when `scriptless` (appended: an existing policy
 * can only make it stricter; nothing is added twice).
 */
export function withProxiedCsp(headers: Headers, scriptless = false): Headers {
  const out = new Headers(headers);
  const have = policiesOf(out.get('content-security-policy'));
  if (!have.includes(PROXIED_DOCUMENT_CSP)) out.append('content-security-policy', PROXIED_DOCUMENT_CSP);
  if (scriptless && !have.includes(SCRIPTLESS_CSP)) out.append('content-security-policy', SCRIPTLESS_CSP);
  return out;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * The response with PROXIED_DOCUMENT_CSP when its request's destination needs it (any engine, any content type: every
 * document the SW passes through, incl. engine error pages), plus SCRIPTLESS_CSP when `scriptless` (a document its
 * engine left unrewritten). Opaque and error responses cannot be rebuilt and are returned as they are (a document never
 * gets one from the engines); the SW's own pages keep their stricter policy.
 */
export function ensureProxiedCsp(res: Response, destination: string, opts: { scriptless?: boolean } = {}): Response {
  if (!needsProxiedCsp(destination)) return res;
  if (res.type !== 'default' && res.type !== 'basic' && res.type !== 'cors') return res;
  const have = policiesOf(res.headers.get('content-security-policy'));
  // One of the SW's own pages (stricter: nothing runs in them).
  if (have.includes(SW_PAGE_CSP)) return res;
  const scriptless = opts.scriptless === true;
  if (have.includes(PROXIED_DOCUMENT_CSP) && (!scriptless || have.includes(SCRIPTLESS_CSP))) return res;
  if (res.status < 200 || res.status > 599) return res;
  return new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: withProxiedCsp(res.headers, scriptless),
  });
}

/** One of the SW's own pages (nothing runs in it: SW_PAGE_CSP); a document body only for frame destinations. */
function swPage(status: number, statusText: string, destination: string, text: string, headers: Record<string, string>): Response {
  const doc = destination === 'document' || destination === 'iframe' || destination === 'frame';
  const body = doc ? `<!doctype html><html lang="en"><meta charset="utf-8"><title>${statusText}</title><p>${text}</p></html>` : '';
  return new Response(body, {
    status,
    statusText,
    headers: {
      'content-type': doc ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': SW_PAGE_CSP,
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/** The SW's 503 for an engine prefix it cannot route (no permissive realm: SW_PAGE_CSP). */
export function unavailableResponse(reason: 'not-routable' | 'stale-prefix', destination: string): Response {
  return swPage(
    503,
    'Proxy engine unavailable',
    destination,
    `GNOME: the proxy engine is not available for this page (${reason}). Reload GNOME and try again.`,
    { 'x-gnome-sw': reason },
  );
}

/**
 * A request the step-3 blocker refused (nothing runs in the answer). For a navigation (document, iframe, frame) a
 * page whose `<meta name="gnome-blocked">` names the category, which the engine host recognizes at the frame's load
 * (WAVE-B3 §4.5: no engine hook reached it); a subresource gets an empty 403. Never a `$redirect` resource.
 */
export function blockedResponse(category: string, destination = ''): Response {
  const cat = /^[a-z-]{1,32}$/.test(category) ? category : 'ads';
  const doc = destination === 'document' || destination === 'iframe' || destination === 'frame';
  const body = doc ? `<!doctype html><meta charset="utf-8"><meta name="gnome-blocked" content="${cat}"><title>Blocked by GNOME</title>` : '';
  return new Response(body, {
    status: 403,
    statusText: 'Blocked by GNOME',
    headers: {
      'content-type': doc ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': SW_PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'x-gnome-blocked': cat,
    },
  });
}

/** A `$redirect` resource's bytes (base64 decoded when it says so); null when it cannot be decoded. */
export function resourceBytes(r: { body: string; base64: boolean }): Uint8Array<ArrayBuffer> | string | null {
  if (!r.base64) return r.body;
  try {
    const bin = atob(r.body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The answer to a request the SW refuses (uvRefusesDestination; nothing runs in it). */
export function refusedResponse(destination: string): Response {
  return swPage(403, 'Refused by GNOME', destination, 'GNOME: this kind of request is not supported by the proxy engine.', { 'x-gnome-sw': 'refused' });
}

// ── What the engines are told about a request, and which of their answers need SCRIPTLESS_CSP ─────────────────────

/** Destinations whose response becomes a document in a frame of some kind. */
const FRAME_DESTINATIONS: readonly string[] = ['document', 'iframe', 'frame', 'object', 'embed'];

export function isFrameDestination(destination: string): boolean {
  return FRAME_DESTINATIONS.includes(destination);
}

/**
 * The destination the engines see. Scramjet 2.0.67-alpha.2 and Ultraviolet 3.2.10 rewrite HTML only for `document`
 * and `iframe`: a `<frame>` document (destination `frame`) reached the page unrewritten, and its scripts ran natively
 * with the engine host two `parent`s up (measured in both browsers and both engines). A `frame` load is therefore
 * presented to the engines as an `iframe` one, which they virtualize like any other nested frame. `object`/`embed`
 * stay as they are (presented as frames, a plugin type would be reported as a download): their HTML gets
 * SCRIPTLESS_CSP instead.
 */
export function engineDestination(destination: string): string {
  return destination === 'frame' ? 'iframe' : destination;
}

/**
 * The request as the engines see it: the real Request when engineDestination() keeps its destination, else a view of
 * it whose `destination` reads as engineDestination() (every other member is the real request's, methods bound to it,
 * so the Firefox body fix and the engines' reads keep working).
 */
export function forEngines(request: Request): Request {
  const destination = engineDestination(request.destination);
  if (destination === request.destination) return request;
  return new Proxy(request, {
    get(target, prop) {
      if (prop === 'destination') return destination;
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * Whether a document of this bare MIME type can run scripts: HTML, the XML family (SVG, XHTML, any `+xml`, XSL) and a
 * missing or unreadable type (the browser sniffs it). PDFs, images, media and text cannot, so they keep working
 * whether their engine rewrote them or not.
 */
export function scriptCapable(mime: string | null): boolean {
  if (mime === null) return true;
  return (
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    mime === 'image/svg+xml' ||
    mime === 'text/xml' ||
    mime === 'application/xml' ||
    mime === 'text/xsl' ||
    mime.endsWith('+xml')
  );
}

/**
 * Whether an Ultraviolet answer needs SCRIPTLESS_CSP: a frame destination whose body UV did not rewrite into its
 * virtualized HTML with GNOME's document hook (`rewritten`, see injectDocumentHook) and whose type can run scripts.
 * UV 3.2.10 rewrites only `document`/`iframe` answers whose Content-Type starts with exactly `text/html`.
 */
export function uvNeedsScriptless(destination: string, rewritten: boolean, mime: string | null): boolean {
  return isFrameDestination(destination) && !rewritten && scriptCapable(mime);
}

/**
 * Whether a Scramjet answer needs SCRIPTLESS_CSP from the SW: Scramjet rewrites a document only when the destination it
 * sees is `document` or `iframe` and the type's essence is `text/html`; anything else in a frame that can run scripts
 * reaches the page as it is. (Lane a's per-tab plugin adds the same policy to most of these; the SW also covers the
 * scriptable types its download rule leaves out, e.g. a `+xml` type outside INLINE_DOCUMENT_TYPES that a browser
 * renders.) `object`/`embed`: browsers do not route plugin loads through service workers (they reach gnome-server's
 * strict engine-prefix 503 page instead, measured in Chromium), so these rules cover them only should that change.
 */
export function scramjetNeedsScriptless(destination: string, mime: string | null): boolean {
  if (!isFrameDestination(destination) || !scriptCapable(mime)) return false;
  const seen = engineDestination(destination);
  return !((seen === 'document' || seen === 'iframe') && mime === 'text/html');
}

/**
 * Ultraviolet destinations the SW refuses: UV 3.2.10 rewrites `worker` scripts but serves `sharedworker` scripts as
 * they are, which would start a native worker realm on the proxy origin (measured: no `__uv`, the origin's
 * IndexedDB, i.e. every engine's cookie jar). UV's client does not wrap SharedWorker, so a request here is a page
 * building the proxied worker URL itself.
 */
export function uvRefusesDestination(destination: string): boolean {
  return destination === 'sharedworker';
}

// ── Document-start hook (Ultraviolet HTML documents) ────────────────────────────────────────────────────────────

/**
 * A parse5 element node in the shape of UV's own injected nodes: UV's HTML rewriter serializes it as
 * `<script src="…" __uv-script="1"></script>` (`skip`: the rewriter leaves the attribute alone; `__uv-script`: UV's
 * handler removes the element if it is still there when UV starts; the hook removes itself first).
 */
export function documentHookNode(src: string = PROXY_PATHS.uvDocumentHook): {
  tagName: string;
  nodeName: string;
  childNodes: unknown[];
  attrs: Array<{ name: string; value: string; skip: boolean }>;
} {
  return {
    tagName: 'script',
    nodeName: 'script',
    childNodes: [],
    attrs: [
      { name: 'src', value: src, skip: true },
      { name: '__uv-script', value: '1', skip: true },
    ],
  };
}

const HOOKED = Symbol.for('gnome.uv.documentHook');

/**
 * Makes an Ultraviolet instance put GNOME's document-start hook (PROXY_PATHS.uvDocumentHook) first in the `<head>` of
 * every HTML document it rewrites, before UV's own scripts, and of the `srcdoc` documents inside it: UV 3.2.10 asks
 * its instance's `createHtmlInject()` for the nodes it inserts (an own property set by the constructor), and its parse5
 * rewriter puts them at the start of the PARSED `<head>` element (implied when the page has none). Working on the
 * parsed tree, a comment, an attribute value containing `<head>` or `>`, or a missing `<head>` cannot move or hide the
 * hook; a text search of the HTML could be fooled by all of them (measured: the WebRTC kill switch was then missing).
 * The SW calls this from `__uv$config.construct`, which UV's service worker runs on every instance it creates.
 * Returns false when the instance has no `createHtmlInject` (another UV version): its documents then count as
 * unrewritten (SCRIPTLESS_CSP).
 */
export function injectDocumentHook(uv: { createHtmlInject?: unknown }, src: string = PROXY_PATHS.uvDocumentHook): boolean {
  const original = uv.createHtmlInject;
  if (typeof original !== 'function') return false;
  if ((original as { [HOOKED]?: boolean })[HOOKED]) return true;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown[] {
    const nodes: unknown = (original as (...a: unknown[]) => unknown).apply(this, args);
    return [documentHookNode(src), ...(Array.isArray(nodes) ? (nodes as unknown[]) : [])];
  };
  Object.defineProperty(wrapped, HOOKED, { value: true });
  uv.createHtmlInject = wrapped;
  return true;
}

/** Whether injectDocumentHook() wrapped this instance (so an HTML body it rewrote carries the hook). */
export function documentHookInstalled(uv: { createHtmlInject?: unknown } | null | undefined): boolean {
  const f = uv?.createHtmlInject;
  return typeof f === 'function' && (f as { [HOOKED]?: boolean })[HOOKED] === true;
}

// ── Downloads (ENGINE-PROTOCOL §6.9) ─────────────────────────────────────────────────────────────────────────────

export interface DownloadDecision {
  /** true: a frame navigation that ends as a download; false: a download request (`<a download>`). */
  navigation: boolean;
  disposition: DownloadDisposition;
}

/**
 * Whether a UV response is a download to report: only navigation requests (`mode: 'navigate'`; a page's own
 * fetch/XHR never is). A frame navigation (destination `document`/`iframe`/`frame`) is one when
 * downloadDisposition() says so; a navigate-mode request with an empty destination is a download request
 * (`<a download>`) and is always reported, as `attachment` [unproven: how each browser sends `<a download>` through a
 * SW is checked by the e2e suite]; `object`/`embed` loads never are.
 */
export function downloadDecision(
  req: { mode: string; destination: string },
  contentDisposition: string | null,
  contentType: string | null,
): DownloadDecision | null {
  if (req.mode !== 'navigate') return null;
  const frame = req.destination === 'document' || req.destination === 'iframe' || req.destination === 'frame';
  if (!frame) return req.destination === '' ? { navigation: false, disposition: 'attachment' } : null;
  const disposition = downloadDisposition(contentDisposition, contentType);
  return disposition ? { navigation: true, disposition } : null;
}

/** Content-Length as a byte count, or null. */
/**
 * The Referer a browser would send for a request from `referrer` to `target` under `policy` (`Request.referrerPolicy`;
 * '' is the default, strict-origin-when-cross-origin), or null for none. Ultraviolet 3.2.10 decodes the browser's
 * referrer, which the browser computed for a SAME-origin request (the proxy origin), and sends it whole: the full
 * address of the referring page reached other sites (integration part 2; browsers send only the origin cross-origin
 * by default). The service worker's UV request hook applies the policy to the real URLs instead.
 */
export function referrerFor(referrer: string, target: string, policy: string): string | null {
  let r: URL;
  let t: URL;
  try {
    r = new URL(referrer);
    t = new URL(target);
  } catch {
    return null;
  }
  if (r.protocol !== 'http:' && r.protocol !== 'https:') return null;
  r.username = '';
  r.password = '';
  r.hash = '';
  const full = r.href;
  const origin = `${r.origin}/`;
  const sameOrigin = r.origin === t.origin;
  const downgrade = r.protocol === 'https:' && t.protocol !== 'https:';
  switch (policy) {
    case 'no-referrer':
      return null;
    case 'unsafe-url':
      return full;
    case 'origin':
      return origin;
    case 'same-origin':
      return sameOrigin ? full : null;
    case 'origin-when-cross-origin':
      return sameOrigin ? full : origin;
    case 'no-referrer-when-downgrade':
      return downgrade ? null : full;
    case 'strict-origin':
      return downgrade ? null : origin;
    default: // '' and 'strict-origin-when-cross-origin'
      return sameOrigin ? full : downgrade ? null : origin;
  }
}

export function contentLength(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\s*\d{1,15}\s*$/.test(value)) return null;
  return Number(value.trim());
}

export { bareMime };

export type DownloadEnd = 'completed' | 'failed' | 'cancelled';

/**
 * Passes a download's body through unchanged while counting it: `progress(received)` at most every
 * PROGRESS_EVERY_MS, then `done(state, received, error)` once (stream end, a read error, or the browser cancelling).
 */
export function tapDownloadStream(
  source: ReadableStream<Uint8Array>,
  report: { progress(received: number): void; done(state: DownloadEnd, received: number, error: string | null): void },
  now: () => number = Date.now,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  let last = now();
  let finished = false;
  const finish = (state: DownloadEnd, error: string | null): void => {
    if (finished) return;
    finished = true;
    report.done(state, received, error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish('completed', null);
          controller.close();
          return;
        }
        received += value.byteLength;
        const t = now();
        if (t - last >= PROGRESS_EVERY_MS) {
          last = t;
          report.progress(received);
        }
        controller.enqueue(value);
      } catch (err) {
        finish('failed', String((err as { message?: unknown } | null)?.message ?? err).slice(0, 300));
        controller.error(err);
      }
    },
    cancel(reason) {
      finish('cancelled', null);
      return reader.cancel(reason);
    },
  });
}

// ── Firefox request bodies (spike §4.11) ─────────────────────────────────────────────────────────────────────────

/**
 * Firefox has no `Request.prototype.body`, and both engines read it: controller.sw.js forwards `event.request.body`
 * (reading the property three times and transferring the third value, so every read must return the same object),
 * and bare-mux's BareClient.fetch forwards `new Request(url, init).body` to its SharedWorker. Firefox has no streaming
 * request bodies either. The fix buffers the body into one ArrayBuffer per Request before an engine sees it and
 * hands bare-mux's internal Request that same buffer (`nextBody`). Verified in the spike's nav suite (POST bodies).
 */
export function createBodyFix(requestProto: object, nativeBody: boolean) {
  const buffered = new WeakMap<object, ArrayBuffer>();
  let nextBody: ArrayBuffer | null = null;
  if (!nativeBody) {
    Object.defineProperty(requestProto, 'body', {
      configurable: true,
      enumerable: true,
      get(this: object) {
        if (nextBody) {
          const b = nextBody;
          nextBody = null;
          return b;
        }
        return buffered.get(this) ?? null;
      },
    });
  }
  return {
    native: nativeBody,
    /** Before an engine sees the request: buffer a non-GET body once. */
    async bufferBody(request: Request): Promise<void> {
      if (nativeBody || request.method === 'GET' || request.method === 'HEAD') return;
      const buf = await request.clone().arrayBuffer();
      if (buf.byteLength) buffered.set(request, buf);
    },
    /** Wraps UV's bareClient.fetch so the Request bare-mux builds synchronously reads the same buffer. */
    wrapFetch<I extends { body?: unknown } | undefined, R>(fetch: (target: unknown, init: I) => Promise<R>): (target: unknown, init: I) => Promise<R> {
      return async (target, init) => {
        if (!nativeBody && init && init.body !== null && init.body !== undefined) {
          const buf = init.body instanceof ArrayBuffer ? init.body : await new Response(init.body as BodyInit).arrayBuffer();
          const patched = { ...init, body: buf } as I;
          nextBody = buf.byteLength ? buf : null;
          const p = fetch(target, patched);
          nextBody = null;
          return p;
        }
        return fetch(target, init);
      };
    },
  };
}
