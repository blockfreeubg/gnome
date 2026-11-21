/**
 * Browser data contract between the browser shell (Wave B lane c: it records visits, stars pages and receives the
 * engine's download events) and the browser data lane (d: the IndexedDB stores, the History/Bookmarks/Downloads
 * pages, the sync adapters registered through src/settings/sync.ts). App side only: the engine host never imports
 * this file, because everything here is the user's own data.
 *
 * Lane d registers its implementation with provideLibrary() at startup; lane c reads it with library() and keeps
 * working (records nothing, suggests nothing) while none is registered.
 *
 * Writes caused by engine events are bounded here, not by the event rate limits alone: after an escape the engine
 * host can forge commits and downloads for every live tab (ENGINE-PROTOCOL §1.2), so lane c passes every commit
 * through a VisitGate and lane d's DownloadStore caps what one engine-host instance can add (LIBRARY_LIMITS).
 */

import type { CommitKind, EngineId, EventMap, HistoryHandling } from './engine-protocol.ts';

/**
 * parentId of top-level bookmarks. IndexedDB does not index null keys, so records never store `parentId: null`; the
 * bookmarks sync adapter maps this sentinel to the wire's `parent_id: null` and back (API.md "Bookmarks"). The
 * bookmarks bar (`appearance.showBookmarksBar`) shows the children of the root.
 */
export const BOOKMARK_ROOT = 'root';

/** Caps on what engine events can write into the user's library (app side; ENGINE-PROTOCOL §1.2 rule 2). */
export const LIBRARY_LIMITS = {
  /** History visits one tab may add per rolling minute; more are dropped and counted. */
  visitsPerTabPerMinute: 20,
  /** …and all tabs together. */
  visitsPerMinute: 60,
  /** A commit of the URL a tab recorded last, less than this long ago, adds no second visit. */
  repeatVisitMs: 60_000,
  /** download.started records one engine-host instance may have unfinished at once… */
  activeDownloadsPerInstance: 20,
  /** …and in total; beyond either cap the download is not listed (the browser still downloads it). */
  downloadsPerInstance: 200,
} as const;

export interface HistoryVisit {
  id: string;
  url: string;
  title: string | null;
  visitedAt: number;
}

export interface Suggestion {
  url: string;
  title: string | null;
  source: 'history' | 'bookmark';
  /** Higher is better; comparable across sources (frecency for history, a fixed boost for bookmarks). */
  score: number;
}

/**
 * Which commits add a history visit: cross-document `navigate` commits (push or replace) always; `same-document`
 * pushes when more than the fragment changed (pushState routes count, `#section` jumps do not); replaceState,
 * traversals (`history`, same-document `traverse`) and reloads never.
 */
export function shouldRecordVisit(kind: CommitKind, historyHandling: HistoryHandling, previousUrl: string | null, url: string): boolean {
  if (kind === 'navigate') return true;
  if (kind !== 'same-document' || historyHandling !== 'push') return false;
  if (previousUrl === null) return true;
  const strip = (u: string): string => {
    const i = u.indexOf('#');
    return i < 0 ? u : u.slice(0, i);
  };
  return strip(previousUrl) !== strip(url);
}

export type VisitDecision =
  /** Record the visit. */
  | 'record'
  /** Not a visit (shouldRecordVisit) or a repeat of the tab's last recorded URL. */
  | 'skip'
  /** Over LIBRARY_LIMITS: dropped; the app counts it in its diagnostics. */
  | 'limited';

/**
 * Lane c, for every validated tab.committed of a known tab: whether it adds a history visit. Applies
 * shouldRecordVisit(), skips a repeat of the tab's last recorded URL within LIBRARY_LIMITS.repeatVisitMs, then the
 * rolling per-tab and global caps. Call forget(tabKey) when the tab closes.
 */
export class VisitGate {
  readonly #tabs = new Map<string, { lastUrl: string; lastAt: number; times: number[] }>();
  readonly #all: number[] = [];

  decide(tabKey: string, commit: { kind: CommitKind; historyHandling: HistoryHandling; url: string }, previousUrl: string | null, now: number): VisitDecision {
    if (!shouldRecordVisit(commit.kind, commit.historyHandling, previousUrl, commit.url)) return 'skip';
    const tab = this.#tabs.get(tabKey);
    if (tab && tab.lastUrl === commit.url && now - tab.lastAt < LIBRARY_LIMITS.repeatVisitMs) return 'skip';
    const minuteAgo = now - 60_000;
    const prune = (times: number[]): void => {
      while (times.length && (times[0] ?? now) <= minuteAgo) times.shift();
    };
    prune(this.#all);
    if (tab) prune(tab.times);
    if ((tab?.times.length ?? 0) >= LIBRARY_LIMITS.visitsPerTabPerMinute || this.#all.length >= LIBRARY_LIMITS.visitsPerMinute) return 'limited';
    const entry = tab ?? { lastUrl: commit.url, lastAt: now, times: [] };
    entry.lastUrl = commit.url;
    entry.lastAt = now;
    entry.times.push(now);
    this.#tabs.set(tabKey, entry);
    this.#all.push(now);
    return 'record';
  }

  forget(tabKey: string): void {
    this.#tabs.delete(tabKey);
  }
}

export interface HistoryStore {
  /**
   * A committed top-level navigation the VisitGate admitted. No-op while `browser.history.enabled` is off and for
   * URLs that are not http(s).
   */
  recordVisit(visit: { url: string; title: string | null; at: number }): Promise<void>;
  /** `tab.title` of a tab showing `url`: updates the newest visit of that URL from the last 30 minutes. */
  updateTitle(url: string, title: string): Promise<void>;
  /** Newest first. `before` pages by visitedAt; `text` matches URL and title (case-insensitive). */
  query(opts: { text?: string; before?: number; limit: number }): Promise<HistoryVisit[]>;
  /** Omnibox: up to `limit` matches, best first. */
  suggest(text: string, limit: number): Promise<Suggestion[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Every visit of exactly this URL (Home's "remove from history"); resolves to how many were removed. */
  removeUrl(url: string): Promise<number>;
  /** Visits with from ≤ visitedAt < to. */
  removeRange(from: number, to: number): Promise<void>;
  clear(): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface Bookmark {
  id: string;
  /** BOOKMARK_ROOT or a folder id. */
  parentId: string;
  kind: 'bookmark' | 'folder';
  title: string;
  /** null for folders. */
  url: string | null;
  /** Sort key within the parent folder (a number, not an index: see BookmarkStore.add). */
  position: number;
  /** Shown under "Favorites" on Home (device-local: not part of bookmark sync). */
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BookmarkStore {
  get(id: string): Promise<Bookmark | null>;
  /** Live children in position order. */
  children(parentId: string): Promise<Bookmark[]>;
  /** Live bookmarks with exactly this URL (the toolbar star). */
  byUrl(url: string): Promise<Bookmark[]>;
  /** Live favorite bookmarks in position order (Home), at most `limit`. */
  favorites(limit: number): Promise<Bookmark[]>;
  /**
   * position: the index among the folder's live items (0 = first; beyond the end or omitted = last); the stored
   * Bookmark.position is a number between the neighbours.
   */
  add(input: { parentId: string; kind: 'bookmark' | 'folder'; title: string; url: string | null; position?: number; favorite?: boolean }): Promise<Bookmark>;
  /**
   * position: the index among the folder's live items (0 = first; beyond the end = last), the item itself not
   * counted; omitted, the item keeps its place, or goes last when it moves to another folder. The stored
   * Bookmark.position is a number between the neighbours.
   */
  update(id: string, patch: { title?: string; url?: string | null; parentId?: string; position?: number }): Promise<Bookmark>;
  setFavorite(id: string, favorite: boolean): Promise<void>;
  /** A folder goes with its contents; tombstones are kept for sync. */
  remove(id: string): Promise<void>;
  suggest(text: string, limit: number): Promise<Suggestion[]>;
  onChange(listener: () => void): () => void;
}

/**
 * `untracked`: the engine host that reported the download is gone (GNOME reloaded): the browser finishes or
 * fails it on its own and its downloads list has the outcome; GNOME can no longer tell.
 */
export type DownloadItemState = 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'untracked';

export interface DownloadItem {
  id: string;
  url: string;
  filename: string;
  mime: string | null;
  total: number | null;
  received: number;
  state: DownloadItemState;
  error: string | null;
  engine: EngineId;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Downloads belong to the browser's own download manager (the engine iframe has `allow-downloads`); GNOME observes
 * them (ENGINE-PROTOCOL §6.9) and keeps this list. Download ids restart with every engine host, so an item is keyed
 * by the engine-host instance plus its downloadId. No-op while `browser.downloads.track` is off.
 */
export interface DownloadStore {
  /**
   * Records a download unless that instance already has LIBRARY_LIMITS.activeDownloadsPerInstance unfinished or
   * LIBRARY_LIMITS.downloadsPerInstance in total (or tracking is off): resolves to whether it was recorded. The
   * app drops later events of an unrecorded download id without counting them.
   */
  started(instance: string, e: EventMap['download.started'], at: number): Promise<boolean>;
  /** Called often: coalesce, persist at most once per second per item. */
  progress(instance: string, e: EventMap['download.progress']): void;
  done(instance: string, e: EventMap['download.done'], at: number): Promise<void>;
  /** That engine host is gone: its unfinished items become `untracked`. */
  instanceEnded(instance: string): Promise<void>;
  /** Newest first. */
  list(limit: number): Promise<DownloadItem[]>;
  remove(id: string): Promise<void>;
  /** Removes finished items; downloads still running stay (like the 'downloads' clearer). */
  clear(): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface BrowserLibrary {
  history: HistoryStore;
  bookmarks: BookmarkStore;
  downloads: DownloadStore;
}

let current: BrowserLibrary | null = null;
const listeners: Set<(lib: BrowserLibrary | null) => void> = /*#__PURE__*/ new Set();

/** Lane d, at startup. Returns an unregister function (tests, hot reload). */
export function provideLibrary(lib: BrowserLibrary): () => void {
  current = lib;
  for (const fn of [...listeners]) fn(lib);
  return () => {
    if (current !== lib) return;
    current = null;
    for (const fn of [...listeners]) fn(null);
  };
}

/** The registered stores, or null before lane d registered them. */
export function library(): BrowserLibrary | null {
  return current;
}

/** Called with the current value at once and on every change. */
export function onLibrary(listener: (lib: BrowserLibrary | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
