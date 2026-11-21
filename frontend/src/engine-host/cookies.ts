/**
 * The two engines' cookie jars (ENGINE-PROTOCOL §6.2 controlled fallback, §6.11 cookies): Scramjet's
 * `controller.cookieJar` (a JSON dump of `{ "<.domain>@<path>@<name>": Cookie }`, persisted by the controller in the
 * `__scramjet_controller` IndexedDB) and Ultraviolet's `__op` IndexedDB `cookies` store (rows keyed by the same
 * `<.domain>@<path>@<name>` id). The conversions are pure; the IndexedDB access is at the bottom.
 */
import { LIMITS, fitText, sanitizeText } from '../shared/engine-protocol';
import type { CookieInfo, EngineId } from '../shared/engine-protocol';

/** scramjet 2.0.67-alpha.2 `Cookie` (packages/core/src/shared/cookie.ts). */
export interface ScramjetCookie {
  name: string;
  value: string;
  path?: string;
  expires?: number;
  maxAge?: number;
  domain?: string;
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

/** Ultraviolet 3.2.10 `__op` cookies row (uv.bundle.js `setCookies`). */
export interface UvCookieRow {
  id: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: Date | string | number;
  /** Seconds after `set` (set-cookie-parser keeps the attribute; UV's own purge reads it). */
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  set?: Date | string | number;
}

const dotted = (domain: string): string => (domain.startsWith('.') ? domain : `.${domain}`);
const bare = (domain: string): string => domain.replace(/^\./, '').toLowerCase();

function time(v: Date | string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function parseScramjetDump(dump: string): Record<string, ScramjetCookie> {
  try {
    const parsed: unknown = JSON.parse(dump);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, ScramjetCookie> = {};
    for (const [id, c] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof c !== 'object' || c === null) continue;
      const cookie = c as ScramjetCookie;
      if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
      out[id] = cookie;
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether a cookie for `domain` is sent to `host` (the domain itself or a subdomain of it). */
export function domainMatches(domain: string, host: string): boolean {
  const d = bare(domain);
  const h = host.toLowerCase();
  return d !== '' && (h === d || h.endsWith(`.${d}`));
}

/** Whether a cookie belongs to `site` for the cookie manager: the site itself or any of its subdomains. */
export function belongsToSite(domain: string, site: string): boolean {
  const d = bare(domain);
  const s = site.toLowerCase();
  return d === s || d.endsWith(`.${s}`);
}

export function isExpired(expires: number | null, now: number): boolean {
  return expires !== null && expires <= now;
}

/** The fallback's copy (§6.2): the Scramjet cookies the destination host would get, as UV rows (HttpOnly included). */
export function scramjetCookiesForUv(jar: Record<string, ScramjetCookie>, url: string, now: number): UvCookieRow[] {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return [];
  }
  const rows: UvCookieRow[] = [];
  for (const c of Object.values(jar)) {
    if (!c.domain || !domainMatches(c.domain, host)) continue;
    const expires = typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : null;
    if (isExpired(expires, now)) continue;
    rows.push(scramjetToUvRow(c, now));
  }
  return rows;
}

export function scramjetToUvRow(c: ScramjetCookie, now: number): UvCookieRow {
  const domain = dotted(c.domain ?? '');
  const path = c.path && c.path.startsWith('/') ? c.path : '/';
  const row: UvCookieRow = {
    id: `${domain}@${path}@${c.name}`,
    name: c.name,
    value: c.value,
    domain,
    path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    set: new Date(now),
  };
  if (typeof c.expires === 'number' && Number.isFinite(c.expires)) row.expires = new Date(c.expires);
  if (c.sameSite) row.sameSite = c.sameSite;
  return row;
}

export function uvRowToScramjet(row: UvCookieRow): ScramjetCookie {
  const out: ScramjetCookie = {
    name: row.name,
    value: row.value,
    domain: dotted(row.domain),
    path: row.path || '/',
    secure: !!row.secure,
    httpOnly: !!row.httpOnly,
    sameSite: (row.sameSite ?? 'lax').toLowerCase(),
  };
  const exp = time(row.expires);
  if (exp !== null) out.expires = exp;
  return out;
}

function sameSite(v: string | undefined): CookieInfo['sameSite'] {
  const s = (v ?? '').toLowerCase();
  return s === 'strict' || s === 'lax' || s === 'none' ? s : null;
}

const COOKIE_DOMAIN_RE = /^\.?[A-Za-z0-9.:[\]_-]{1,253}$/;

/** A cookie as cookies.list reports it: metadata only, the value's length instead of the value; null if unreportable. */
export function cookieInfo(engine: EngineId, c: { name: string; value: string; domain?: string; path?: string; expires: number | null; secure?: boolean; httpOnly?: boolean; sameSite?: string }): CookieInfo | null {
  const domain = dotted(c.domain ?? '');
  if (!COOKIE_DOMAIN_RE.test(domain)) return null;
  const path = c.path && c.path.startsWith('/') ? fitText(sanitizeText(c.path), LIMITS.maxCookiePathLength) : '/';
  return {
    engine,
    domain,
    path: path.startsWith('/') ? path : '/',
    name: fitText(sanitizeText(c.name), LIMITS.maxCookieNameLength),
    size: Math.min(c.value.length, 1_048_576),
    expires: c.expires !== null && c.expires >= 0 ? Math.floor(c.expires) : null,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: sameSite(c.sameSite),
  };
}

export function scramjetCookieInfos(jar: Record<string, ScramjetCookie>, site: string | null, now: number): CookieInfo[] {
  const out: CookieInfo[] = [];
  for (const c of Object.values(jar)) {
    if (!c.domain || (site !== null && !belongsToSite(c.domain, site))) continue;
    const expires = typeof c.expires === 'number' && Number.isFinite(c.expires) ? c.expires : null;
    if (isExpired(expires, now)) continue;
    const info = cookieInfo('scramjet', { ...c, expires });
    if (info) out.push(info);
  }
  return out;
}

export function uvCookieInfos(rows: readonly UvCookieRow[], site: string | null, now: number): CookieInfo[] {
  const out: CookieInfo[] = [];
  for (const r of rows) {
    if (typeof r.name !== 'string' || typeof r.value !== 'string' || typeof r.domain !== 'string') continue;
    if (site !== null && !belongsToSite(r.domain, site)) continue;
    const set = time(r.set);
    const expires = typeof r.maxAge === 'number' && Number.isFinite(r.maxAge) && set !== null ? set + r.maxAge * 1000 : time(r.expires);
    if (isExpired(expires, now)) continue;
    const info = cookieInfo('ultraviolet', { name: r.name, value: r.value, domain: r.domain, path: r.path, expires, secure: r.secure, httpOnly: r.httpOnly, ...(r.sameSite ? { sameSite: r.sameSite } : {}) });
    if (info) out.push(info);
  }
  return out;
}

/** What cookies.delete removes from a jar: everything (`all`), or the site's cookies (optionally one name). */
export function cookieMatcher(p: { all: boolean; site: string | null; name: string | null }): (c: { domain?: string; name: string }) => boolean {
  if (p.all) return () => true;
  const site = p.site ?? '';
  return (c) => !!c.domain && belongsToSite(c.domain, site) && (p.name === null || c.name === p.name);
}

// ── Ultraviolet's __op database ──────────────────────────────────────────────────────────────────────────────────

export const UV_COOKIE_DB = '__op';
const UV_COOKIE_STORE = 'cookies';

/** Opens UV's cookie database (creating it with UV's own schema if no UV page ran yet). */
export function openUvCookieDb(idb: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(UV_COOKIE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(UV_COOKIE_STORE)) {
        const store = db.createObjectStore(UV_COOKIE_STORE, { keyPath: 'id' });
        store.createIndex('path', 'path');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('could not open the Ultraviolet cookie database'));
  });
}

export async function readUvCookies(idb: IDBFactory = indexedDB): Promise<UvCookieRow[]> {
  const db = await openUvCookieDb(idb);
  try {
    if (!db.objectStoreNames.contains(UV_COOKIE_STORE)) return [];
    return await new Promise<UvCookieRow[]>((resolve, reject) => {
      const q = db.transaction(UV_COOKIE_STORE).objectStore(UV_COOKIE_STORE).getAll();
      q.onsuccess = () => resolve(q.result as UvCookieRow[]);
      q.onerror = () => reject(q.error ?? new Error('could not read Ultraviolet cookies'));
    });
  } finally {
    db.close();
  }
}

/** Writes rows (put) and deletes ids in one transaction. */
export async function writeUvCookies(put: readonly UvCookieRow[], remove: readonly string[], idb: IDBFactory = indexedDB): Promise<void> {
  if (!put.length && !remove.length) return;
  const db = await openUvCookieDb(idb);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UV_COOKIE_STORE, 'readwrite');
      const st = tx.objectStore(UV_COOKIE_STORE);
      for (const row of put) st.put(row);
      for (const id of remove) st.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('could not write Ultraviolet cookies'));
      tx.onabort = () => reject(tx.error ?? new Error('Ultraviolet cookie write aborted'));
    });
  } finally {
    db.close();
  }
}

/**
 * Deletes the `__op` rows that have expired at `now` (expiredMatcher), each judged as it is inside one read-write
 * transaction: a row the service worker stored again after a caller read the jar (a refreshed cookie keeps its id)
 * is kept. Returns how many rows went.
 */
export async function deleteExpiredUvCookies(now: number, idb: IDBFactory = indexedDB): Promise<number> {
  const db = await openUvCookieDb(idb);
  try {
    if (!db.objectStoreNames.contains(UV_COOKIE_STORE)) return 0;
    const expired = expiredMatcher(now);
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(UV_COOKIE_STORE, 'readwrite');
      const cursor = tx.objectStore(UV_COOKIE_STORE).openCursor();
      let removed = 0;
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const row = c.value as UvCookieRow | null;
        if (typeof row === 'object' && row !== null && expired(row)) {
          c.delete();
          removed++;
        }
        c.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error ?? new Error('could not purge Ultraviolet cookies'));
      tx.onabort = () => reject(tx.error ?? new Error('Ultraviolet cookie purge aborted'));
    });
  } finally {
    db.close();
  }
}

// ── cookies.list / cookies.delete over both jars (capability `cookies`) ─────────────────────────────────────────

/**
 * A Set-Cookie line that recreates a Scramjet jar entry (for the controller's cookie sync, which rebuilds every live
 * Scramjet document's jar from such lines), with the URL it applies to.
 */
export function setCookieLine(c: ScramjetCookie): { url: string; cookie: string } | null {
  const host = bare(c.domain ?? '');
  if (!host) return null;
  // An IPv6 literal keeps (or gets) its brackets: the controller applies each line with `new URL(url)`, which refuses
  // `http://::1/` and would end the whole re-sync there.
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const path = c.path && c.path.startsWith('/') ? c.path : '/';
  const parts = [`${c.name}=${c.value}`, `Path=${path}`];
  if (!c.hostOnly) parts.push(`Domain=${host}`);
  if (typeof c.expires === 'number' && Number.isFinite(c.expires)) parts.push(`Expires=${new Date(c.expires).toUTCString()}`);
  if (c.secure) parts.push('Secure');
  if (c.httpOnly) parts.push('HttpOnly');
  if (c.sameSite) parts.push(`SameSite=${c.sameSite}`);
  const url = `${c.secure ? 'https' : 'http'}://${urlHost}${path}`;
  try {
    new URL(url);
  } catch {
    return null; // a domain no URL can hold: left out of the re-sync, the other cookies still go
  }
  return { url, cookie: parts.join('; ') };
}

/**
 * Matches the cookies of either jar that have expired (cookies.list purges them, WAVE-B3 §6.1: Scramjet 2.0.67-alpha.2
 * skips expired cookies when it reads its jar but never removes them, and Ultraviolet 3.2.10's own purge compares
 * `new Date(expires.toLocaleString())`, which misreads dates outside the local time zone's format).
 */
export function expiredMatcher(now: number): (c: { expires?: number | Date | string; maxAge?: number; set?: Date | string | number }) => boolean {
  return (c) => {
    const set = time(c.set);
    if (typeof c.maxAge === 'number' && Number.isFinite(c.maxAge) && set !== null) return set + c.maxAge * 1000 <= now;
    return isExpired(time(c.expires), now);
  };
}

/** Splits a jar by a matcher: what stays and how many go. */
export function partitionJar(jar: Record<string, ScramjetCookie>, match: (c: ScramjetCookie & { domain?: string }) => boolean): { keep: Record<string, ScramjetCookie>; removed: number } {
  const keep: Record<string, ScramjetCookie> = {};
  let removed = 0;
  for (const [id, c] of Object.entries(jar)) {
    if (match(c)) removed++;
    else keep[id] = c;
  }
  return { keep, removed };
}
