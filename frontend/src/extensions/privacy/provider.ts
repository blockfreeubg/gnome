/**
 * Privacy protection (WAVE-B3 §6.1): the `privacy` hook provider, the same module in the engine host (Scramjet) and
 * the service worker (Ultraviolet). DOM-free.
 *
 * - Tracking parameters (D13): documents only (a tab's own document or a frame), GET/HEAD only, with
 *   `policy.stripParams`: the `params` group's `$removeparam` result (`rewriteParams`, x1's filter engines of this
 *   realm), then GNOME's built-in table (params.ts, works before any list is compiled). A changed URL on the same
 *   origin becomes the `redirect` verdict (the engines answer it with a 307). Loop guard: never for a URL this
 *   provider produced in the last 10 s, and at most 3 redirects in 10 s per tab (the service worker cannot tell
 *   tabs apart: there per destination page, its origin and path).
 * - `Sec-GPC: 1` with `policy.gpc`, `DNT: 1` with `policy.dnt`, on every request.
 * - `Referer`: only ever reduced, never added or widened, with a floor in every mode (also with privacy protection
 *   off): at most what a browser's default `strict-origin-when-cross-origin` sends (reduceReferrer). Ultraviolet
 *   3.2.10 forwards the whole real URL of the referring page (every proxied request is same-origin to the browser,
 *   so the browser never trims it); this floor corrects that wherever the engine still sends more. And the
 *   initiating document's own `Referrer-Policy` response header is applied (onResponse remembers it per document,
 *   and per tab for the tab's own document): to its subresources, to its frames' navigations (the frame's
 *   `documentUrl` is its parent) and to the tab navigations it starts (Referrer Policy §8.3: a navigation follows
 *   the policy of the document that started it). Scramjet 2.0.67-alpha.2 serves every document with
 *   `Referrer-Policy: unsafe-url` and so ignores the page's header (measured 2026-11-19: a page served with
 *   `no-referrer` still sent its origin with an image; 2026-11-20: also with its frame and a link a user clicked).
 */
import { stripBuiltinParams } from './params';
import type { RequestInfo, RequestVerdict, ResponseHeaders, ResponseInfo } from '../../shared/engine-hooks';
import type { HookProvider, RequestContext } from '../core/compose';
import type { SitePolicy } from '../core/policy';

/** How long a URL this provider produced is never stripped again, and the window of the per-tab redirect cap. */
export const STRIP_WINDOW_MS = 10_000;
/** At most this many parameter-stripping redirects per tab (SW: per destination page) within STRIP_WINDOW_MS. */
export const STRIP_MAX_PER_WINDOW = 3;
const MEMORY = 256;

function parseHttp(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * The referrer rule of §6.1 on real URLs: the floor (a browser's default `strict-origin-when-cross-origin`: the
 * full URL without fragment and credentials to the same origin, the origin + `/` to another origin, nothing from
 * https to http) plus the mode (`default` and `origin-cross-site` = the floor; `none` = nothing). Never more than
 * `referrer`: an origin-only referrer stays origin-only. null = send none (also for a referrer that is not an
 * http(s) URL, or an unusable target).
 */
export function reduceReferrer(referrer: string | null, target: string, mode: SitePolicy['referrer']): string | null {
  if (referrer === null || mode === 'none') return null;
  const r = parseHttp(referrer);
  const t = parseHttp(target);
  if (r === null || t === null) return null;
  if (r.protocol === 'https:' && t.protocol === 'http:') return null;
  if (r.origin === t.origin) {
    r.hash = '';
    r.username = '';
    r.password = '';
    return r.href;
  }
  return `${r.origin}/`;
}

const POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

/** A `Referrer-Policy` header's policy: the last token a browser knows (Referrer Policy §8.1), else null. */
export function parseReferrerPolicy(value: string | null): string | null {
  if (value === null) return null;
  let policy: string | null = null;
  for (const t of value.split(',')) {
    const token = t.trim().toLowerCase();
    if (POLICIES.has(token)) policy = token;
  }
  return policy;
}

/** The Referer `policy` allows from `referrer` to `target` (Referrer Policy §8.3), on real URLs; null = none. */
export function referrerUnderPolicy(referrer: string, target: string, policy: string): string | null {
  const r = parseHttp(referrer);
  const t = parseHttp(target);
  if (r === null || t === null) return null;
  r.username = '';
  r.password = '';
  r.hash = '';
  const full = r.href;
  const origin = `${r.origin}/`;
  const same = r.origin === t.origin;
  const downgrade = r.protocol === 'https:' && t.protocol !== 'https:';
  switch (policy) {
    case 'no-referrer':
      return null;
    case 'unsafe-url':
      return full;
    case 'origin':
      return origin;
    case 'same-origin':
      return same ? full : null;
    case 'origin-when-cross-origin':
      return same ? full : origin;
    case 'no-referrer-when-downgrade':
      return downgrade ? null : full;
    case 'strict-origin':
      return downgrade ? null : origin;
    default:
      return same ? full : downgrade ? null : origin;
  }
}

/** Origin + path of an http(s) URL (the SW's loop-guard key). */
const pageOf = (url: string): string => {
  const u = parseHttp(url);
  return u === null ? url : `${u.origin}${u.pathname}`;
};

/** The document key of a URL (without its fragment). */
const docKey = (url: string): string => {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
};

const isDocument = (req: RequestInfo): boolean =>
  req.isTopLevelDocument || req.destination === 'document' || req.destination === 'iframe' || req.destination === 'frame';

/**
 * x1's `FilterEngines.rewriteParams` (WAVE-B3 §4.2, `filters/engines.ts`), structurally: this file is DOM-free and
 * compiles in the service worker, which must not import the window-side engines module.
 */
export type RewriteParams = (url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame') => string | null;

export interface PrivacyProviderDeps {
  /** x1's `FilterEngines.rewriteParams` of this realm (null when nothing changes, the group is off or not ready). */
  rewriteParams: RewriteParams;
  /** Clock (tests). */
  now?: () => number;
}

export function createPrivacyProvider(deps: PrivacyProviderDeps): HookProvider {
  const now = deps.now ?? (() => Date.now());
  /** URLs this provider redirected to → when. */
  const produced = new Map<string, number>();
  /** Per tab (or, in the SW, per cleaned URL): the times of recent redirects. */
  const recent = new Map<string, number[]>();
  /** Documents that answered with a Referrer-Policy header → that policy (for their subresources and frames). */
  const policies = new Map<string, string>();
  /**
   * Per tab (the engine host; the SW has no tab ids): the origin and Referrer-Policy (null: none) of the tab's own
   * document, from its last answer that was not a redirect, i.e. the page a navigation of the tab leaves.
   */
  const tabPolicies = new Map<string, { origin: string; policy: string | null }>();

  const remember = <V>(m: Map<string, V>, key: string, v: V): void => {
    m.delete(key);
    m.set(key, v);
    while (m.size > MEMORY) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  };

  function strip(req: RequestInfo): string | null {
    let cleaned = req.url;
    try {
      cleaned = deps.rewriteParams(req.url, req.documentUrl, req.isTopLevelDocument ? 'main_frame' : 'sub_frame') ?? req.url;
    } catch {
      cleaned = req.url; // the filter engines fail open; the built-in table still applies
    }
    cleaned = stripBuiltinParams(cleaned) ?? cleaned;
    if (cleaned === req.url) return null;
    const from = parseHttp(req.url);
    const to = parseHttp(cleaned);
    if (from === null || to === null || from.origin !== to.origin || to.href === from.href) return null;
    return to.href;
  }

  /**
   * The Referrer-Policy of the document that made the request, when it answered with one: for a subresource and a
   * frame navigation the requesting (parent) document; for the tab's own document the page the navigation leaves,
   * which the referrer names (its full URL, or its origin as the engine already trimmed it to the tab's document).
   */
  function pagePolicyOf(req: RequestInfo): string | undefined {
    if (!req.isTopLevelDocument) return req.documentUrl === null ? undefined : policies.get(docKey(req.documentUrl));
    if (req.referrer === null) return undefined;
    const known = policies.get(docKey(req.referrer));
    if (known !== undefined) return known;
    const from = parseHttp(req.referrer);
    const tab = req.tabId === null ? undefined : tabPolicies.get(`tab:${req.tabId}`);
    return from !== null && tab !== undefined && tab.policy !== null && tab.origin === from.origin ? tab.policy : undefined;
  }

  function guard(req: RequestInfo, cleaned: string): boolean {
    const t = now();
    const at = produced.get(req.url);
    if (at !== undefined && t - at < STRIP_WINDOW_MS) return false;
    // The SW cannot tell tabs apart: there the cap is per destination page (origin + path), so a page that sends the
    // browser back with another value in a parameter we keep (measured: `?round=N`) is still capped.
    const key = req.tabId !== null ? `tab:${req.tabId}` : `to:${pageOf(cleaned)}`;
    const times = (recent.get(key) ?? []).filter((x) => t - x < STRIP_WINDOW_MS);
    if (times.length >= STRIP_MAX_PER_WINDOW) {
      remember(recent, key, times);
      return false;
    }
    times.push(t);
    remember(recent, key, times);
    remember(produced, cleaned, t);
    return true;
  }

  return {
    name: 'privacy',
    onRequest(req: RequestInfo, ctx: RequestContext): RequestVerdict | null {
      const p = ctx.policy;
      const method = req.method.toUpperCase();
      if (p.stripParams && isDocument(req) && (method === 'GET' || method === 'HEAD')) {
        const cleaned = strip(req);
        if (cleaned !== null && guard(req, cleaned)) return { action: 'redirect', url: cleaned };
      }
      const set: Array<[string, string]> = [];
      const remove: string[] = [];
      if (p.gpc) set.push(['sec-gpc', '1']);
      if (p.dnt) set.push(['dnt', '1']);
      if (req.referrer !== null) {
        const pagePolicy = pagePolicyOf(req);
        const allowed = pagePolicy === undefined ? req.referrer : referrerUnderPolicy(req.referrer, req.url, pagePolicy);
        const r = allowed === null ? null : reduceReferrer(allowed, req.url, p.referrer);
        if (r === null) remove.push('referer');
        else if (r !== req.referrer) set.push(['referer', r]);
      }
      return set.length || remove.length ? { action: 'allow', headers: { set, remove } } : null;
    },
    onResponse(res: ResponseInfo, headers: ResponseHeaders): void {
      if (!isDocument(res)) return;
      const policy = parseReferrerPolicy(headers.get('referrer-policy'));
      const key = docKey(res.url);
      if (policy === null) policies.delete(key);
      else remember(policies, key, policy);
      // The tab's next document (a redirect hop is not one: the page the navigation leaves stays the tab's).
      const page = parseHttp(res.url);
      if (res.isTopLevelDocument && res.tabId !== null && page !== null && (res.status < 300 || res.status > 399)) {
        remember(tabPolicies, `tab:${res.tabId}`, { origin: page.origin, policy });
      }
    },
  };
}
