/**
 * Shared rules of the library stores: which URLs and titles may be stored (the sync server's limits, API.md
 * "Sync"), text matching for search and the omnibox, and frecency.
 *
 * What is stored must also be accepted by the sync server (backend/src/api/validate.rs): it refuses a whole upload
 * batch for one invalid item, so a single stored record it rejects would stop bookmark and history sync for good.
 */
import { sanitizeText } from '../shared/engine-protocol';

/** API.md: URLs are http:/https: only, at most 4096 characters; titles at most 512. */
export const MAX_URL_LENGTH = 4096;
export const MAX_TITLE_LENGTH = 512;
export const DAY_MS = 86_400_000;

/**
 * Host characters the sync server accepts (`is_http_url`: letters, digits and `-._%:~`; the brackets of an IPv6
 * address are stripped first). The URL parser accepts more, e.g. `http://a$b.example/` or `http://a,b/`.
 */
const SERVER_HOST = /^[A-Za-z0-9\-._%:~]+$/;
/** Characters a stored URL never contains (the server refuses whitespace and control characters anywhere). */
const NOT_URL_SAFE = /[^\x21-\x7e]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether `s` holds a lone surrogate (JSON.stringify escapes it; the server's JSON parser refuses the request). */
export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

/**
 * The URL as stored (parsed and serialized), or null when it is not an http(s) URL without credentials, within the
 * size limit, whose host the sync server accepts.
 */
export function storableUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (!host || !SERVER_HOST.test(host)) return null;
  let href = u.href;
  if (NOT_URL_SAFE.test(href)) {
    // The serializer percent-encodes everything outside ASCII; encode whatever a browser left as it was the same way.
    try {
      href = href.replace(/[^\x21-\x7e]+/g, (s) => encodeURIComponent(s));
    } catch {
      return null; // a lone surrogate
    }
  }
  return href.length > MAX_URL_LENGTH ? null : href;
}

/**
 * A title as stored: control and bidi-override characters removed, lone surrogates replaced (JSON with one is
 * refused by the server), whitespace collapsed, at most 512 characters (code points, as the server counts); null
 * when empty. Very long input is cut before it is cleaned (an imported file can hold a title of megabytes).
 */
export function storableTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const clean = sanitizeText(title.length > 16_384 ? title.slice(0, 16_384) : title)
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;
  if (clean.length <= MAX_TITLE_LENGTH) return clean;
  // 2 × 512 UTF-16 units always hold the first 512 code points.
  return [...clean.slice(0, MAX_TITLE_LENGTH * 2)].slice(0, MAX_TITLE_LENGTH).join('');
}

/** URL without scheme and `www.`, lower case (what people type). */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
}

/** Case-insensitive substring match on URL and title (History and Bookmarks search). Every word must match. */
export function matchesText(text: string, url: string | null, title: string | null): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${(url ?? '').toLowerCase()}\n${(title ?? '').toLowerCase()}`;
  return words.every((w) => hay.includes(w));
}

/**
 * How well `query` matches a page, for suggestions (0 = no match): the start of the URL (what people type) is best,
 * then the start of the title, the start of a title word, then anywhere. Multi-word queries need every word.
 */
export function matchQuality(query: string, url: string, title: string | null): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const u = bareUrl(url);
  const t = (title ?? '').toLowerCase();
  if (u.startsWith(q)) return 4;
  if (t.startsWith(q)) return 3;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.every((w) => u.includes(w) || t.includes(w)) ? 1.5 : 0;
  if (t.split(/[\s\-–—|:·/.,]+/).some((w) => w.startsWith(q))) return 2.5;
  if (u.split(/[/.?=&#_-]+/).some((w) => w.startsWith(q))) return 2;
  if (u.includes(q)) return 1.5;
  if (t.includes(q)) return 1;
  return 0;
}

/** Recency weight of one visit (the bucket scheme browsers use for frecency). */
export function visitWeight(ageMs: number): number {
  const days = ageMs / DAY_MS;
  if (days <= 4) return 100;
  if (days <= 14) return 70;
  if (days <= 31) return 50;
  if (days <= 90) return 30;
  return 10;
}

/** Frecency of a page from its visit times. */
export function frecency(visitTimes: readonly number[], now: number): number {
  let sum = 0;
  for (const t of visitTimes) sum += visitWeight(Math.max(0, now - t));
  return sum;
}

/**
 * Suggestion score, comparable across sources: match quality × log2(1 + frecency). A bookmark counts like a page
 * with BOOKMARK_FRECENCY (about two recent visits) plus its own visits.
 */
export const BOOKMARK_FRECENCY = 200;

export function suggestionScore(quality: number, frecencyValue: number): number {
  return Math.round(quality * Math.log2(1 + frecencyValue) * 1000) / 1000;
}
