/**
 * The cookie manager (WAVE-B3 §6.1, D4) and the browser's cookie rules both engines miss. DOM-free: the engine host
 * (Scramjet) and the service worker (Ultraviolet) use the same module.
 *
 * `createCookieProvider()` (name `cookies`), from `cookieRuleFor(ctx.settings, url)` and `cookiesBlocked(ctx.policy,
 * rule, ctx.thirdParty)` (an unknown party counts as third-party, D15):
 * - onRequest removes `Cookie` when the request's cookies are blocked;
 * - onResponse deletes every `Set-Cookie` when blocked; with a `session` rule rewrites each line into a session cookie
 *   (sessionizeSetCookie; a line that deletes its cookie stays as it is, so a site's sign-out still ends the session);
 *   and, whatever the cookie manager says, drops the lines a browser would refuse (setCookieAcceptable): a `Domain`
 *   the response's host does not belong to or that is a public suffix (both engines store any Domain they are given:
 *   Scramjet 2.0.67-alpha.2 `setCookies`, Ultraviolet 3.2.10 `setCookies`, so site-b could plant cookies for
 *   site-a), `__Secure-`/`__Host-` names without their requirements, and `Secure` cookies from insecure origins.
 * Both run before the engines touch their jars (Scramjet `fetch.request` after its header computation and
 * `fetch.preresponse` before its cookie handling; UV `request` after `cookie` was set and `beforemod` before its store).
 *
 * SameSite (the 2026-11-19 security finding: Ultraviolet 3.2.10 sends every stored cookie whose domain the host ends
 * with, with no path, `Secure`, `HttpOnly`-for-requests or SameSite check): `sameSiteMode` decides from what the
 * request's initiator and tab are which cookies may go (`strict`: all, `lax`: all but Strict, `cross-site`: only
 * `SameSite=None`), with the browser's rules: top-level GET navigations carry Lax cookies, a cookie without a valid
 * SameSite is Lax (Lax by default, as Chromium and RFC 6265bis), with Chromium's two-minute "Lax+POST" allowance for
 * top-level POSTs (form-posted sign-ins), and `SameSite=None` without `Secure` counts as Lax. `uvCookieHeader` builds
 * the `Cookie` header (and the `document.cookie` string) Ultraviolet should have built from its rows. Scramjet applies
 * SameSite itself (its `getCookies` modes, chosen from the request's initiator), so these are used only on the UV path.
 */
import type { RequestInfo, RequestVerdict, ResponseHeaders, ResponseInfo } from '../../shared/engine-hooks';
import type { HookProvider, RequestContext } from '../core/compose';
import { cookieRuleFor, cookiesBlocked } from '../core/policy';
import { siteOf } from '../core/site';

// ── Set-Cookie lines ─────────────────────────────────────────────────────────────────────────────────────────────

interface ParsedSetCookie {
  name: string;
  /** Attributes in order: lower-case name, value (trimmed; '' when absent). */
  attrs: Array<[string, string]>;
}

function parseSetCookie(line: string): ParsedSetCookie | null {
  const parts = line.split(';');
  const first = (parts[0] ?? '').trim();
  const eq = first.indexOf('=');
  const name = eq === -1 ? '' : first.slice(0, eq).trim();
  if (first === '') return null;
  const attrs: Array<[string, string]> = [];
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    const k = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    if (k === '') continue;
    attrs.push([k, i === -1 ? '' : p.slice(i + 1).trim()]);
  }
  return { name, attrs };
}

/** The last valid value of an attribute (RFC 6265 §5.3: the last one wins); undefined when absent. */
const lastAttr = (c: ParsedSetCookie, key: string): string | undefined => {
  let v: string | undefined;
  for (const [k, value] of c.attrs) if (k === key) v = value;
  return v;
};

/** Max-Age as a number when it is a valid integer (RFC 6265 §5.2.2), else undefined. */
function maxAgeOf(c: ParsedSetCookie): number | undefined {
  let v: number | undefined;
  for (const [k, value] of c.attrs) if (k === 'max-age' && /^-?\d+$/.test(value)) v = Number(value);
  return v;
}

function expiresOf(c: ParsedSetCookie): number | undefined {
  let v: number | undefined;
  for (const [k, value] of c.attrs) {
    if (k !== 'expires') continue;
    // RFC 1123 dates parse as they are; the cookie spelling `01-Jan-1970` needs its dashes as spaces.
    let t = Date.parse(value);
    if (!Number.isFinite(t)) t = Date.parse(value.replace(/-/g, ' '));
    if (Number.isFinite(t)) v = t;
  }
  return v;
}

/** Whether a Set-Cookie line deletes its cookie: Max-Age ≤ 0, or (without a valid Max-Age) an Expires in the past. */
export function deletesCookie(line: string, now: number = Date.now()): boolean {
  const c = parseSetCookie(line);
  if (c === null) return false;
  const maxAge = maxAgeOf(c);
  if (maxAge !== undefined) return maxAge <= 0;
  const expires = expiresOf(c);
  return expires !== undefined && expires <= now;
}

/**
 * A `session` rule (D4): the line without `Expires` and `Max-Age`, so the cookie lasts until GNOME closes (at the next
 * fresh start the app deletes the site's cookies: fresh-start.ts). A line that deletes its cookie comes back
 * unchanged.
 */
export function sessionizeSetCookie(value: string, now: number = Date.now()): string {
  if (deletesCookie(value, now)) return value;
  const parts = value.split(';');
  const kept = [parts[0] ?? ''];
  for (const p of parts.slice(1)) {
    const k = (p.includes('=') ? p.slice(0, p.indexOf('=')) : p).trim().toLowerCase();
    if (k === 'expires' || k === 'max-age') continue;
    kept.push(p);
  }
  return kept.join(';');
}

const LOCAL_HOST_RE = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** A secure context for cookies, as browsers count it: https, or http to a loopback host. */
export function isSecureUrl(u: URL): boolean {
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOST_RE.test(u.hostname.toLowerCase().replace(/\.$/, '')));
}

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/** `host` is `domain` or a subdomain of it (RFC 6265 §5.1.3, for host names). */
export function domainMatch(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !IP_RE.test(host));
}

/**
 * Whether a browser would store this Set-Cookie line from a response of `url` (RFC 6265bis §5.6, as Chromium and
 * Firefox apply it): a `Domain` must be the host or a parent of it at or below the host's registrable domain (never a
 * public suffix, never another site; an IP host only itself); `__Secure-` needs `Secure`, `__Host-` needs `Secure`,
 * no `Domain` and `Path=/`; `Secure` only from a secure URL. Lines that are not cookies (no name and no value) are
 * refused.
 */
export function setCookieAcceptable(line: string, url: string): boolean {
  const c = parseSetCookie(line);
  if (c === null) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const secure = c.attrs.some(([k]) => k === 'secure');
  if (secure && !isSecureUrl(u)) return false;
  const rawDomain = lastAttr(c, 'domain');
  const domain = rawDomain === undefined ? '' : rawDomain.replace(/^\./, '').toLowerCase().replace(/\.$/, '');
  if (domain !== '') {
    if (IP_RE.test(host)) {
      if (domain !== host) return false;
    } else {
      if (!domainMatch(host, domain)) return false;
      const site = siteOf(u.href);
      if (site === null || !(domain === site || domain.endsWith(`.${site}`))) return false;
    }
  }
  const name = c.name.toLowerCase();
  if (name.startsWith('__secure-') && !secure) return false;
  if (name.startsWith('__host-') && (!secure || domain !== '' || lastAttr(c, 'path') !== '/')) return false;
  return true;
}

// ── SameSite ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which cookies a request may carry: `strict` all, `lax` all but SameSite=Strict, `cross-site` only SameSite=None. */
export type SameSiteMode = 'strict' | 'lax' | 'cross-site';

export interface SameSiteRequest {
  /** The real destination URL. */
  url: string;
  method: string;
  /** The tab's own document (every redirect hop of it). */
  isTopLevelDocument: boolean;
  /** `Request.destination` (a frame navigation: `document`, `iframe` or `frame` without isTopLevelDocument). */
  destination: string;
  /** The tab's top-level page (the "site for cookies"); null when unknown (counts as cross-site). */
  topLevelUrl: string | null;
  /**
   * The real URL of the document that made the request (for a navigation: the one that started it). `''` = no
   * initiator: a navigation GNOME itself started (address bar, bookmark, history, reload), like a browser-initiated
   * one. null = unknown, which counts as cross-site (a page can hide its referrer on purpose).
   */
  initiator: string | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** The SameSite context of a request, by the browser's rules (see the header). */
export function sameSiteMode(r: SameSiteRequest): SameSiteMode {
  const target = siteOf(r.url);
  if (target === null) return 'cross-site';
  const initiatorSite = r.initiator === null || r.initiator === '' ? null : siteOf(r.initiator);
  if (r.isTopLevelDocument) {
    if (r.initiator === '' || initiatorSite === target) return 'strict';
    return SAFE_METHODS.has(r.method.toUpperCase()) ? 'lax' : 'cross-site';
  }
  const top = r.topLevelUrl === null ? null : siteOf(r.topLevelUrl);
  if (top === null || top !== target) return 'cross-site';
  return initiatorSite === top ? 'strict' : 'cross-site';
}

/** A stored cookie as both engines keep it (Scramjet's jar entries and Ultraviolet's `__op` rows). */
export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Unix ms, a Date or a date string (UV rows), absent for session cookies. */
  expires?: number | string | Date;
  /** Seconds after `set` (UV rows keep the attribute). */
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  /** The attribute as stored; absent or invalid = not declared (Lax by default). */
  sameSite?: string;
  /** When it was stored (UV rows). */
  set?: number | string | Date;
}

/** Chromium's "Lax+POST" window: a cookie without SameSite set this recently still goes with a top-level POST. */
export const LAX_POST_MS = 120_000;

const timeOf = (v: number | string | Date | undefined): number | null => {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Whether a cookie may go with a request of this SameSite mode. */
export function sameSiteAllows(c: StoredCookie, mode: SameSiteMode, r: Pick<SameSiteRequest, 'isTopLevelDocument' | 'method'>, now: number): boolean {
  if (mode === 'strict') return true;
  const s = (c.sameSite ?? '').toLowerCase();
  const declared = s === 'strict' || s === 'lax' || s === 'none';
  const effective = !declared ? 'lax' : s === 'none' && !c.secure ? 'lax' : s;
  if (mode === 'lax') return effective !== 'strict';
  if (effective === 'none') return true;
  if (declared || !r.isTopLevelDocument || SAFE_METHODS.has(r.method.toUpperCase())) return false;
  const set = timeOf(c.set);
  return set !== null && now - set >= 0 && now - set < LAX_POST_MS;
}

function expired(c: StoredCookie, now: number): boolean {
  const set = timeOf(c.set);
  if (typeof c.maxAge === 'number' && Number.isFinite(c.maxAge) && set !== null) return set + c.maxAge * 1000 <= now;
  const e = timeOf(c.expires);
  return e !== null && e <= now;
}

/** RFC 6265 §5.1.4 path-match. */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * The cookies of `rows` that a browser would send to `url` (domain- and path-match, `Secure` only to secure URLs,
 * not expired, SameSite by `mode`; `forScript`: the `document.cookie` string, without HttpOnly cookies), serialized
 * as Ultraviolet serializes them (`name=value` in row order, joined by `; `). A row whose domain has a leading dot
 * is a domain cookie, one without is host-only (Ultraviolet 3.2.10 stores every cookie with a dot, so all of its
 * cookies count as domain cookies, as it treats them).
 */
export function uvCookieHeader(
  rows: readonly StoredCookie[],
  url: string,
  mode: SameSiteMode,
  opts: { forScript: boolean; request: Pick<SameSiteRequest, 'isTopLevelDocument' | 'method'>; now: number },
): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const secure = isSecureUrl(u);
  const out: string[] = [];
  for (const c of rows) {
    if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
    const d = c.domain.toLowerCase();
    const domainOk = d.startsWith('.') ? domainMatch(host, d.slice(1)) : host === d;
    if (!domainOk) continue;
    if (!pathMatch(u.pathname || '/', c.path && c.path.startsWith('/') ? c.path : '/')) continue;
    if (c.secure && !secure) continue;
    if (opts.forScript && c.httpOnly) continue;
    if (expired(c, opts.now)) continue;
    if (!sameSiteAllows(c, mode, opts.request, opts.now)) continue;
    out.push(c.name ? `${c.name}=${c.value}` : c.value);
  }
  return out.join('; ');
}

// ── The provider ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface CookieProviderDeps {
  /** Clock (tests). */
  now?: () => number;
}

export function createCookieProvider(deps: CookieProviderDeps = {}): HookProvider {
  const now = deps.now ?? (() => Date.now());
  return {
    name: 'cookies',
    onRequest(req: RequestInfo, ctx: RequestContext): RequestVerdict | null {
      const rule = cookieRuleFor(ctx.settings, req.url);
      return cookiesBlocked(ctx.policy, rule, ctx.thirdParty) ? { action: 'allow', headers: { remove: ['cookie'] } } : null;
    },
    onResponse(res: ResponseInfo, headers: ResponseHeaders, ctx: RequestContext): void {
      const raw = headers.getAll('set-cookie');
      if (raw.length === 0) return;
      const rule = cookieRuleFor(ctx.settings, res.url);
      if (cookiesBlocked(ctx.policy, rule, ctx.thirdParty)) {
        headers.delete('set-cookie');
        return;
      }
      // Each header line is one cookie, as browsers and both engines read it (set-cookie-parser's parse per line;
      // the transports keep every Set-Cookie line apart): a comma never splits a line, also not one in a value.
      const t = now();
      const out: string[] = [];
      for (const line of raw) {
        if (!setCookieAcceptable(line, res.url)) continue;
        out.push(rule === 'session' ? sessionizeSetCookie(line, t) : line);
      }
      if (out.length === raw.length && out.every((l, i) => l === raw[i])) return;
      headers.delete('set-cookie');
      for (const l of out) headers.append('set-cookie', l);
    },
  };
}

// ── Ultraviolet's cookie path (the service worker's glue, lane x1's sw.ts) ──────────────────────────────────────

/**
 * One Ultraviolet 3.2.10 instance as its service worker uses it (`uv.sw.js` `fetch`): `cookie.getCookies(db)` reads
 * every `__op` row, `cookie.serialize(rows, meta, js)` builds the request's `Cookie` header (`js` false, before the
 * `request` event) and the `document.cookie` string injected into the document or worker it answers (`js` true).
 */
export interface UvCookieInstance {
  cookie: {
    serialize(rows: StoredCookie[], meta: { url: URL }, js: boolean): string;
  };
}

/**
 * Whether a composite verdict of a request blocks its cookies: createCookieProvider is the only provider that removes
 * the `cookie` header, and it does so exactly when cookiesBlocked holds for the request's URL in its context, the
 * decision withCookieDocument makes for the document that request loads.
 */
export function verdictBlocksCookies(v: RequestVerdict): boolean {
  return v.action === 'allow' && (v.headers?.remove ?? []).some((n) => n.toLowerCase() === 'cookie');
}

/** The destinations whose answers Ultraviolet's service worker injects a script-visible cookie string into. */
export const UV_SCRIPT_COOKIE_DESTINATIONS: ReadonlySet<string> = new Set(['document', 'iframe', 'frame', 'worker']);

/**
 * For an Ultraviolet document or worker whose own cookies are blocked (verdictBlocksCookies of its request, in UV's
 * `request` event): the script-visible cookie string the service worker injects into the answer (`__uv$cookies`, UV's
 * `cookie.serialize(rows, meta, true)`) becomes empty. Ultraviolet 3.2.10's handler reads that string once into a
 * closure that every `about:blank` child the page creates shares (`let u = k` per hooked window), so a blocked
 * frame's child read the frame's cookies (measured 2026-11-19/20, row K3c, both browsers), past withCookieDocument's
 * accessor, which covers only the document's own realm. The request's `Cookie` serialization (`js` false) stays UV's.
 * Per request: UV builds a fresh `cookie` object for every instance. False when the instance does not have UV
 * 3.2.10's shape (nothing changed).
 */
export function blankUvScriptCookies(instance: unknown): boolean {
  const cookie = typeof instance === 'object' && instance !== null ? (instance as { cookie?: unknown }).cookie : undefined;
  if (typeof cookie !== 'object' || cookie === null) return false;
  const c = cookie as { serialize?: unknown };
  const original = c.serialize;
  if (typeof original !== 'function') return false;
  c.serialize = function (this: unknown, rows: unknown, meta: unknown, js: unknown): unknown {
    return js === true ? '' : (original as (...a: unknown[]) => unknown).call(this, rows, meta, js);
  };
  return true;
}

/**
 * What the service worker knows about one UV request, for SameSite: the request's SameSite inputs (sameSiteMode) and,
 * for the document or worker it answers, whether that document is cross-site to its tab (its `document.cookie` then
 * holds only SameSite=None cookies, as browsers do for a cross-site frame).
 */
export interface UvCookieContext {
  request: SameSiteRequest;
  /** The answered document's own site differs from its tab's top-level page (or that page is unknown). */
  documentCrossSite: boolean;
  /**
   * The cookie manager blocks the answered document's own cookies (cookiesBlocked for its URL and party): its
   * `document.cookie` then starts empty, as withCookieDocument's getter answers, so nothing of the jar is injected
   * into a page whose cookies are blocked. Absent: false.
   */
  documentBlocked?: boolean;
}

/**
 * Makes one Ultraviolet instance build cookies as a browser does (the 2026-11-19 security finding): its `serialize`
 * is replaced by uvCookieHeader with the SameSite mode of `ctx` (the request's `Cookie` header) or of the answered
 * document (`document.cookie`). `ctx` null (the service worker could not attribute the request): `cross-site`
 * (only SameSite=None cookies; the cookie provider removes those too under block-third-party), and the document is
 * treated as cross-site. Call it from `uv.config.construct`, which UV runs synchronously at the start of `fetch`,
 * before it reads any cookie. Returns false when the instance does not have the shape UV 3.2.10 has (nothing changed).
 */
export function fixUvCookies(instance: unknown, ctx: UvCookieContext | null, now: () => number = () => Date.now()): boolean {
  const cookie = typeof instance === 'object' && instance !== null ? (instance as { cookie?: unknown }).cookie : undefined;
  if (typeof cookie !== 'object' || cookie === null || typeof (cookie as { serialize?: unknown }).serialize !== 'function') return false;
  const c = cookie as UvCookieInstance['cookie'];
  const request = ctx?.request ?? null;
  c.serialize = (rows, meta, js) => {
    const url = meta?.url instanceof URL ? meta.url.href : String(meta?.url ?? '');
    const list = Array.isArray(rows) ? rows : [];
    if (js) {
      if (ctx?.documentBlocked === true) return '';
      const mode: SameSiteMode = ctx === null || ctx.documentCrossSite ? 'cross-site' : 'strict';
      return uvCookieHeader(list, url, mode, { forScript: true, request: { isTopLevelDocument: false, method: 'GET' }, now: now() });
    }
    const mode: SameSiteMode = request === null ? 'cross-site' : sameSiteMode(request);
    return uvCookieHeader(list, url, mode, { forScript: false, request: request ?? { isTopLevelDocument: false, method: 'GET' }, now: now() });
  };
  return true;
}

/**
 * The SameSite inputs of a UV request from what the service worker has: lane x1's page context (WAVE-B3 D15:
 * `documentUrl`, `topLevelUrl`, `isTopLevelDocument`) and the initiator of a navigation. `navInitiator` (navigations
 * only): `''` for one GNOME itself started (address bar, bookmark, history, reload; the engine host announces it),
 * the opener's or the requesting document's real URL, or null when unknown (counts as cross-site). For other
 * requests the requesting document (`documentUrl`) is the initiator.
 */
export function uvSameSiteRequest(
  info: Pick<RequestInfo, 'url' | 'method' | 'destination' | 'isTopLevelDocument' | 'topLevelUrl' | 'documentUrl'>,
  navInitiator: string | null,
): SameSiteRequest {
  const navigation = info.isTopLevelDocument || info.destination === 'document' || info.destination === 'iframe' || info.destination === 'frame';
  return {
    url: info.url,
    method: info.method,
    isTopLevelDocument: info.isTopLevelDocument,
    destination: info.destination,
    topLevelUrl: info.isTopLevelDocument ? info.url : info.topLevelUrl,
    initiator: navigation ? navInitiator : info.documentUrl,
  };
}

/**
 * `Sec-Fetch-Site`, `-Mode` and `-Dest` for a UV request, as a browser would send them (Ultraviolet 3.2.10 sends
 * none: the service worker's Request carries no fetch metadata). Only when the initiator is known (`''` = GNOME's own
 * navigation → `none`): an unknown one gets no headers at all, as today, because a wrong `cross-site` would make
 * servers with a resource-isolation policy refuse a request they accept without the headers. `mode` is the
 * intercepted Request's `mode` (`navigate`, `cors`, `no-cors`, `same-origin`).
 */
export function uvFetchMetadata(r: SameSiteRequest, mode: string): Array<[string, string]> | null {
  if (r.initiator === null) return null;
  let site: 'none' | 'same-origin' | 'same-site' | 'cross-site';
  if (r.initiator === '') site = 'none';
  else {
    let a: URL;
    let b: URL;
    try {
      a = new URL(r.initiator);
      b = new URL(r.url);
    } catch {
      return null;
    }
    const sa = siteOf(a.href);
    const sb = siteOf(b.href);
    if (sa === null || sb === null) return null;
    site = a.origin === b.origin ? 'same-origin' : sa === sb && a.protocol === b.protocol ? 'same-site' : 'cross-site';
  }
  const navigation = r.isTopLevelDocument || r.destination === 'document' || r.destination === 'iframe' || r.destination === 'frame';
  const dest = r.isTopLevelDocument ? 'document' : r.destination === '' ? 'empty' : r.destination;
  const fetchMode = navigation ? 'navigate' : mode === 'cors' || mode === 'no-cors' || mode === 'same-origin' || mode === 'websocket' ? mode : 'no-cors';
  return [
    ['sec-fetch-site', site],
    ['sec-fetch-mode', fetchMode],
    ['sec-fetch-dest', dest],
  ];
}
