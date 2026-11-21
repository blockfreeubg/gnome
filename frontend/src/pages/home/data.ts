/**
 * Home data: quick links (IndexedDB kv), recently visited and favorites (through the browser library, library() of
 * src/shared/browser-data.ts, when it runs; else read from IndexedDB directly), and an in-memory suggestion index for
 * the search box. Every loader degrades to an empty result when storage is unavailable.
 */
import {
  idbGet,
  idbGetAll,
  idbPut,
  idbQuery,
  idbTransaction,
  kvGet,
  kvSet,
  uuid,
  type BookmarkRecord,
  type HistoryRecord,
} from '../../lib/idb';
import { hostOf, normalizeLinkUrl } from '../../lib/url';
import { library, type Bookmark, type HistoryVisit } from '../../shared/browser-data';

// ── Quick links ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface QuickLink {
  id: string;
  title: string;
  url: string;
}

export const QUICK_LINKS_KEY = 'home.quickLinks';
export const MAX_QUICK_LINKS = 24;

export function defaultQuickLinks(): QuickLink[] {
  return [
    { id: 'default-wikipedia', title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
    { id: 'default-duckduckgo', title: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
    { id: 'default-youtube', title: 'YouTube', url: 'https://www.youtube.com/' },
    { id: 'default-reddit', title: 'Reddit', url: 'https://www.reddit.com/' },
    { id: 'default-github', title: 'GitHub', url: 'https://github.com/' },
    { id: 'default-archive', title: 'Internet Archive', url: 'https://archive.org/' },
  ];
}

/** Validates stored quick links; returns null when the stored value is unusable. */
export function validateQuickLinks(raw: unknown): QuickLink[] | null {
  if (!Array.isArray(raw)) return null;
  const out: QuickLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, url } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof url !== 'string') continue;
    const href = normalizeLinkUrl(url);
    if (!href || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: title.trim().slice(0, 80) || hostOf(href), url: href });
    if (out.length >= MAX_QUICK_LINKS) break;
  }
  return out;
}

/**
 * Synchronous copy of the quick links in localStorage, so Home renders its tiles in the first frame instead of
 * pushing the page down when IndexedDB answers (layout shift). IndexedDB stays the source of truth.
 */
export const QUICK_LINKS_MIRROR_KEY = 'gnome:home:quickLinks';

export function readQuickLinksMirror(): QuickLink[] | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(QUICK_LINKS_MIRROR_KEY) : null;
    return raw ? validateQuickLinks(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeQuickLinksMirror(links: readonly QuickLink[]): void {
  try {
    localStorage.setItem(QUICK_LINKS_MIRROR_KEY, JSON.stringify(links.map(({ id, title, url }) => ({ id, title, url }))));
  } catch {
    /* storage disabled or full: the tiles then appear when IndexedDB answers */
  }
}

/** First-frame quick links: the mirror, or the defaults on a first visit. */
export function initialQuickLinks(): QuickLink[] {
  return readQuickLinksMirror() ?? defaultQuickLinks();
}

export async function loadQuickLinks(): Promise<{ links: QuickLink[]; customized: boolean; available: boolean }> {
  try {
    const stored = validateQuickLinks(await kvGet<unknown>(QUICK_LINKS_KEY));
    const links = stored ?? defaultQuickLinks();
    writeQuickLinksMirror(links);
    return { links, customized: !!stored, available: true };
  } catch {
    return { links: readQuickLinksMirror() ?? defaultQuickLinks(), customized: false, available: false };
  }
}

export function saveQuickLinks(links: readonly QuickLink[]): Promise<void> {
  writeQuickLinksMirror(links);
  return kvSet(QUICK_LINKS_KEY, links.map(({ id, title, url }) => ({ id, title, url })));
}

export function newQuickLink(title: string, url: string): QuickLink {
  return { id: uuid(), title: title.trim() || hostOf(url), url };
}

// ── Recently visited & favorites ─────────────────────────────────────────────────────────────────────────────────

export interface SiteEntry {
  key: string;
  url: string;
  title: string;
  /** Last visit (history) or last update (bookmark). */
  time: number;
  source: 'history' | 'bookmark';
  bookmarkId?: string;
  favorite?: boolean;
}

function dedupeHistory(rows: ReadonlyArray<Pick<HistoryRecord, 'url' | 'title' | 'visitedAt'>>, limit: number): SiteEntry[] {
  const seen = new Set<string>();
  const out: SiteEntry[] = [];
  for (const h of rows) {
    if (!h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push({ key: `h:${h.url}`, url: h.url, title: h.title?.trim() || hostOf(h.url), time: h.visitedAt, source: 'history' });
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadRecent(limit = 8): Promise<SiteEntry[]> {
  try {
    const lib = library();
    const rows: ReadonlyArray<Pick<HistoryRecord, 'url' | 'title' | 'visitedAt'>> = lib
      ? ((await lib.history.query({ limit: 400 })) as HistoryVisit[])
      : await idbQuery('history', { index: 'visitedAt', direction: 'prev', limit: 400 });
    return dedupeHistory(rows, limit);
  } catch {
    return [];
  }
}

function bookmarkEntry(b: Pick<BookmarkRecord, 'id' | 'url' | 'title' | 'updatedAt' | 'favorite'> | Bookmark): SiteEntry {
  const url = b.url ?? '';
  return {
    key: `b:${b.id}`,
    url,
    title: b.title.trim() || hostOf(url),
    time: b.updatedAt,
    source: 'bookmark',
    bookmarkId: b.id,
    favorite: !!b.favorite,
  };
}

/**
 * With the browser library (src/library): its favorites, in bookmark order. Without it (a build whose library has
 * not started): favorites first, then the most visited bookmarks to fill the list, read from IndexedDB directly.
 */
export async function loadFavorites(limit = 8): Promise<SiteEntry[]> {
  try {
    const lib = library();
    if (lib) return (await lib.bookmarks.favorites(limit)).filter((b) => b.kind === 'bookmark' && !!b.url).map(bookmarkEntry);
    const all = (await idbGetAll('bookmarks')).filter((b) => b.kind === 'bookmark' && !b.deleted && !!b.url);
    if (all.length === 0) return [];
    const favorites = all.filter((b) => b.favorite).sort((a, b) => a.position - b.position);
    if (favorites.length >= limit) return favorites.slice(0, limit).map(bookmarkEntry);
    const history = await idbQuery('history', { index: 'visitedAt', direction: 'prev', limit: 600 });
    const visits = new Map<string, number>();
    for (const h of history) visits.set(h.url, (visits.get(h.url) ?? 0) + 1);
    const rest = all
      .filter((b) => !b.favorite)
      .sort((a, b) => (visits.get(b.url ?? '') ?? 0) - (visits.get(a.url ?? '') ?? 0) || b.updatedAt - a.updatedAt);
    return [...favorites, ...rest].slice(0, limit).map(bookmarkEntry);
  } catch {
    return [];
  }
}

/** Deletes every history entry for a URL. */
export async function removeFromHistory(url: string): Promise<number> {
  const lib = library();
  if (lib) return lib.history.removeUrl(url);
  const rows = await idbQuery('history', { index: 'url', query: IDBKeyRange.only(url) });
  if (rows.length === 0) return 0;
  await idbTransaction(['history'], (store) => {
    const os = store('history');
    for (const r of rows) os.delete(r.id);
  });
  return rows.length;
}

export async function setFavorite(bookmarkId: string, favorite: boolean): Promise<void> {
  const lib = library();
  if (lib) return lib.bookmarks.setFavorite(bookmarkId, favorite);
  const b = await idbGet('bookmarks', bookmarkId);
  if (!b) return;
  await idbPut('bookmarks', { ...b, favorite, updatedAt: Date.now() });
}

// ── Search suggestions ───────────────────────────────────────────────────────────────────────────────────────────

export interface SuggestionIndex {
  history: HistoryRecord[];
  bookmarks: BookmarkRecord[];
  loadedAt: number;
}

export async function loadSuggestionIndex(): Promise<SuggestionIndex> {
  try {
    const [history, bookmarks] = await Promise.all([
      idbQuery('history', { index: 'visitedAt', direction: 'prev', limit: 1500 }),
      idbGetAll('bookmarks'),
    ]);
    return {
      history,
      bookmarks: bookmarks.filter((b) => b.kind === 'bookmark' && !b.deleted && !!b.url),
      loadedAt: Date.now(),
    };
  } catch {
    return { history: [], bookmarks: [], loadedAt: Date.now() };
  }
}

function stripUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
}

/** Relevance of a title/url for a query (0 = no match). */
export function matchScore(query: string, title: string, url: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const u = stripUrl(url);
  const t = title.toLowerCase();
  if (u.startsWith(q)) return 4;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-–—|:·]+/).some((w) => w.startsWith(q))) return 2.5;
  if (u.includes(q)) return 1.5;
  if (t.includes(q)) return 1;
  return 0;
}

export function suggest(index: SuggestionIndex, query: string, limit = 5): { history: SiteEntry[]; bookmarks: SiteEntry[] } {
  const q = query.trim();
  if (!q) return { history: [], bookmarks: [] };
  const bookmarks = index.bookmarks
    .map((b) => ({ b, s: matchScore(q, b.title, b.url ?? '') }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.b.favorite ? 1 : 0) - (a.b.favorite ? 1 : 0))
    .slice(0, Math.max(2, Math.floor(limit / 2)))
    .map((x) => bookmarkEntry(x.b));
  const taken = new Set(bookmarks.map((b) => b.url));
  const now = Date.now();
  const byUrl = new Map<string, { h: HistoryRecord; visits: number; score: number }>();
  for (const h of index.history) {
    if (taken.has(h.url)) continue;
    const existing = byUrl.get(h.url);
    if (existing) {
      existing.visits++;
      continue;
    }
    const s = matchScore(q, h.title ?? '', h.url);
    if (s > 0) byUrl.set(h.url, { h, visits: 1, score: s });
  }
  const history = [...byUrl.values()]
    .map((x) => ({ ...x, rank: x.score + Math.log2(1 + x.visits) * 0.4 - Math.min(1, (now - x.h.visitedAt) / (30 * 86_400_000)) * 0.5 }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((x) => dedupeHistory([x.h], 1)[0]!)
    .filter(Boolean);
  return { history, bookmarks };
}
