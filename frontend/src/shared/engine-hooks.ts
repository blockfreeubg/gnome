/**
 * Hook points for the content-blocking runtime of Wave B step 3 (ad and tracker blocking, cosmetic filtering, cookie
 * rules, privacy headers: ARCHITECTURE §5.5). Defined now so the engine-host core (lane a), the transport manager and
 * the service worker (lane b) call them from the start; step 3 supplies the implementation. Until then every call
 * site uses ALLOW_ALL, which blocks nothing and reports the blocker as `off`.
 *
 * Call sites:
 * - Scramjet, window side, in each tab frame's ManagedPlugin: `fetch.request` → onRequest (block: `earlyResponse`;
 *   redirect: a 307 `earlyResponse`, documents only; header edits on `props.init.headers`); `fetch.preresponse` →
 *   onResponse (Set-Cookie policy, before Scramjet stores cookies); `init.post` → onDocument.
 * - Ultraviolet, in the service worker: `uv.on('request')` → onRequest (block/redirect: `event.respondWith`);
 *   `uv.on('beforemod')` → onResponse. The UV document-start hook calls onDocument in the engine-host realm.
 * - WebSockets of proxied pages → onWebSocket. Scramjet: the transport manager wraps the Scramjet transport's
 *   connect in the engine-host realm. Ultraviolet: its transport runs inside the bare-mux SharedWorker, where no
 *   synchronous call into these hooks is possible. Every UV page WebSocket passes `createWebSocket` of the BareClient
 *   that UV's document scripts create (`Ultraviolet.BareClient`, bundled in uv.bundle.js; uv.client.js calls it), so
 *   the engine host wraps `Ultraviolet.BareClient.prototype.createWebSocket` in each UV document as soon as
 *   uv.bundle.js defines `Ultraviolet` (the UV document-start hook runs before UV's scripts and hands the window to
 *   the engine host; lane a) and asks these hooks there [unproven].
 * Hooks are synchronous and must not throw: every caller catches, logs and allows (blocking fails open). The core
 * counts what was blocked (BlockCounter) and sends `tab.blocked` coalesced per tab (COALESCE_MS); it also counts
 * proxied-document CSP violations as `direct-connection` itself, without any hook.
 *
 * Wave B step 3 (WAVE-B3 §3.1 C6–C8, §4): the content blocker composes its providers into the one registration
 * (src/extensions/core/compose.ts). A tab's own document request (every redirect hop) is judged under its own URL
 * (`topLevelUrl` = the request URL), never the page being left; `documentUrl` is the requesting document (party and
 * `$domain` checks), `referrer` what the engine is about to send. A `block` verdict may carry a `$redirect` resource,
 * answered `200` for subresources only (safeVerdict drops it for documents and frames). Ultraviolet's onDocument runs
 * after UV's client hooked the window (its `__uvHook` assignment), Scramjet's at `init.post`. `ResponseHeaders.append`
 * adds one Set-Cookie line per cookie.
 *
 * Shared-realm caveat (ENGINE-PROTOCOL §1): code that escaped its engine runs in the same realm as these hooks and can
 * disable them. Blocking protects against ordinary hostile pages, not against an escape.
 *
 * No DOM types here: the service worker compiles this file in its WebWorker scope.
 */

import { BLOCK_CATEGORIES } from './engine-protocol';
import type { BlockCategory, BlockerStatus, EngineId, EngineSettings, TabId } from './engine-protocol';

export interface RequestInfo {
  engine: EngineId;
  /** null when the service worker cannot attribute the request to a tab (Ultraviolet subresources). */
  tabId: TabId | null;
  /** The real destination URL (not the proxied one). */
  url: string;
  /** Upper case. */
  method: string;
  /** `Request.destination` ('' for fetch/XHR); `'websocket'` for onWebSocket calls (Request.destination has no such value). */
  destination: string;
  /**
   * The top-level page the request belongs to (first-party context): for a request with `isTopLevelDocument` (the
   * tab's own document, every redirect hop) the request URL itself, never the page being left; otherwise the tab's
   * top-level page (Scramjet: the committed page, or the page being loaded for requests of that new document before
   * its commit; Ultraviolet: what the SW's context map says). Null when unknown; consumers treat unknown as
   * third-party (WAVE-B3 D4, D15).
   */
  topLevelUrl: string | null;
  /** The request loads the tab's top-level document. */
  isTopLevelDocument: boolean;
  /**
   * The real http(s) URL of the document that made the request (Scramjet: the client's URL; Ultraviolet: the SW's
   * client map, or a recorded document the referrer names), the parent document for a frame navigation, the URL itself
   * for a tab's top document; an `about:`, `blob:` or `data:` client counts as its tab's top-level page; null when
   * unknown. The filter engine's first-party/third-party and `$domain` checks use it; per-site rules use topLevelUrl.
   */
  documentUrl: string | null;
  /** The real URL the engine is about to send as `Referer`; null when it sends none. */
  referrer: string | null;
}

export interface HeaderChanges {
  set?: ReadonlyArray<readonly [name: string, value: string]>;
  remove?: readonly string[];
}

/**
 * A `$redirect` resource (uBO's redirect resources): answered `200` with this body instead of a refusal. Only for
 * subresources: a tab document or a frame (destination document/iframe/frame, or isTopLevelDocument) is never answered
 * with one; the call sites treat such a verdict as a plain block.
 */
export interface RedirectResource {
  /** Bare, lower-case MIME type without `;base64`. */
  contentType: string;
  /** The body; base64 when `base64` is true. At most 1 MiB decoded. */
  body: string;
  base64: boolean;
}

export type RequestVerdict =
  | { action: 'allow'; headers?: HeaderChanges }
  /** With `resource`: answered with it (`$redirect`). Without: refused (subresources: an empty 403; tab documents: tab.error `blocked`). */
  | { action: 'block'; category: BlockCategory; resource?: RedirectResource }
  /** Documents only (tracking-parameter stripping): answered with a 307 to `url` (an http(s) URL). */
  | { action: 'redirect'; url: string };

export interface ResponseInfo extends RequestInfo {
  status: number;
}

/** Mutable upstream response headers (Scramjet `rawHeaders`, UV `ResponseContext.headers`), behind one interface. */
export interface ResponseHeaders {
  get(name: string): string | null;
  getAll(name: string): string[];
  set(name: string, value: string): void;
  /** Adds one more value of `name` (Set-Cookie: one header line per cookie). */
  append(name: string, value: string): void;
  delete(name: string): void;
}

export interface DocumentInfo {
  engine: EngineId;
  tabId: TabId;
  /** The document's real URL. */
  url: string;
  topLevelUrl: string;
  isTopLevel: boolean;
}

/** The proxied document's `Window` (structural here so this file compiles in the service worker too). */
export type ProxiedWindow = object;

/** The parts every side calls (window side and service worker). */
export interface RequestHooks {
  /** Content-blocking settings changed (sent with every `settings` command; the SW gets them over gnome-blocker-config). */
  configure(settings: Pick<EngineSettings, 'privacy' | 'extensions'>): void;
  onRequest(req: RequestInfo): RequestVerdict;
  onResponse(res: ResponseInfo, headers: ResponseHeaders): void;
  onWebSocket(req: RequestInfo): 'allow' | 'block';
  status(): BlockerStatus;
}

/** Window side only (Scramjet `init.post`, the UV document-start hook): cosmetic CSS, `navigator.globalPrivacyControl`. */
export interface EngineHooks extends RequestHooks {
  onDocument(win: ProxiedWindow, doc: DocumentInfo): void;
}

/** Where callers report a block; the core aggregates per tab into `tab.blocked`. */
export interface BlockCounter {
  count(tabId: TabId, category: BlockCategory): void;
}

/** The step-2 implementation: allows everything, changes nothing. */
export const ALLOW_ALL: EngineHooks = {
  configure() {},
  onRequest: () => ({ action: 'allow' }),
  onResponse() {},
  onWebSocket: () => 'allow',
  onDocument() {},
  status: () => ({ state: 'off', lists: 0, detail: null }),
};

/**
 * Runs a hook the way every call site must: a throw (or a malformed verdict) allows the request and is reported to
 * `onError` (the core logs it), so a broken filter never breaks browsing.
 */
const RESOURCE_TYPE_RE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/;
/** 1 MiB once decoded (base64 length of 1,048,576 bytes). */
const RESOURCE_MAX_CHARS = 1_398_104;
function goodResource(r: unknown): r is RedirectResource {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.contentType === 'string' &&
    RESOURCE_TYPE_RE.test(o.contentType) &&
    typeof o.body === 'string' &&
    o.body.length <= RESOURCE_MAX_CHARS &&
    typeof o.base64 === 'boolean'
  );
}

export function safeVerdict(hooks: RequestHooks, req: RequestInfo, onError: (err: unknown) => void): RequestVerdict {
  try {
    const v = hooks.onRequest(req);
    const document =
      req.isTopLevelDocument || req.destination === 'document' || req.destination === 'iframe' || req.destination === 'frame';
    if (v && v.action === 'allow') return v;
    if (v && v.action === 'block' && BLOCK_CATEGORIES.includes(v.category)) {
      return v.resource === undefined || (!document && goodResource(v.resource)) ? v : { action: 'block', category: v.category };
    }
    if (v && v.action === 'redirect' && document && /^https?:\/\//i.test(v.url)) return v;
    onError(new Error('invalid verdict'));
  } catch (err) {
    onError(err);
  }
  return { action: 'allow' };
}
