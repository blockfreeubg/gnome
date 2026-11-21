/**
 * An in-memory BrowserLibrary (src/shared/browser-data.ts) for the browser shell's unit tests: records what the
 * shell writes (visits, titles, downloads) so tests can check the VisitGate and LIBRARY_LIMITS wiring. Test-only.
 */
import {
  BOOKMARK_ROOT,
  LIBRARY_LIMITS,
  type Bookmark,
  type BrowserLibrary,
  type DownloadItem,
  type HistoryVisit,
  type Suggestion,
} from '../../shared/browser-data';

export interface MemoryLibrary extends BrowserLibrary {
  visits: HistoryVisit[];
  downloadItems: Map<string, DownloadItem>;
}

export function createMemoryLibrary(): MemoryLibrary {
  const visits: HistoryVisit[] = [];
  const marks: Bookmark[] = [];
  const downloadItems = new Map<string, DownloadItem>();
  const listeners = { h: new Set<() => void>(), b: new Set<() => void>(), d: new Set<() => void>() };
  const fire = (s: Set<() => void>): void => s.forEach((f) => f());
  let n = 0;
  const lib: MemoryLibrary = {
    visits,
    downloadItems,
    history: {
      async recordVisit(v) {
        visits.unshift({ id: `v${++n}`, url: v.url, title: v.title, visitedAt: v.at });
        fire(listeners.h);
      },
      async updateTitle(url, title) {
        const v = visits.find((x) => x.url === url);
        if (v) v.title = title;
      },
      async query({ text, limit }) {
        return visits.filter((v) => !text || v.url.includes(text) || (v.title ?? '').includes(text)).slice(0, limit);
      },
      async suggest(text, limit): Promise<Suggestion[]> {
        return visits.filter((v) => v.url.includes(text)).slice(0, limit).map((v) => ({ url: v.url, title: v.title, source: 'history', score: 1 }));
      },
      async remove(ids) {
        for (const id of ids) visits.splice(visits.findIndex((v) => v.id === id), 1);
      },
      async removeUrl(url) {
        const before = visits.length;
        for (let i = visits.length - 1; i >= 0; i--) if (visits[i]!.url === url) visits.splice(i, 1);
        return before - visits.length;
      },
      async removeRange() {},
      async clear() {
        visits.length = 0;
      },
      onChange(fn) {
        listeners.h.add(fn);
        return () => listeners.h.delete(fn);
      },
    },
    bookmarks: {
      async get(id) {
        return marks.find((b) => b.id === id) ?? null;
      },
      async children(parentId) {
        return marks.filter((b) => b.parentId === parentId);
      },
      async byUrl(url) {
        return marks.filter((b) => b.url === url);
      },
      async favorites(limit) {
        return marks.filter((b) => b.favorite).slice(0, limit);
      },
      async add(input) {
        const b: Bookmark = { id: `b${++n}`, parentId: input.parentId ?? BOOKMARK_ROOT, kind: input.kind, title: input.title, url: input.url, position: marks.length, favorite: !!input.favorite, createdAt: 0, updatedAt: 0 };
        marks.push(b);
        fire(listeners.b);
        return b;
      },
      async update(id, patch) {
        const b = marks.find((x) => x.id === id)!;
        Object.assign(b, patch);
        return b;
      },
      async setFavorite(id, favorite) {
        const b = marks.find((x) => x.id === id);
        if (b) b.favorite = favorite;
      },
      async remove(id) {
        marks.splice(marks.findIndex((b) => b.id === id), 1);
      },
      async suggest() {
        return [];
      },
      onChange(fn) {
        listeners.b.add(fn);
        return () => listeners.b.delete(fn);
      },
    },
    downloads: {
      async started(instance, e, at) {
        const mine = [...downloadItems.keys()].filter((k) => k.startsWith(`${instance}/`));
        const active = mine.filter((k) => downloadItems.get(k)!.state === 'in_progress');
        if (active.length >= LIBRARY_LIMITS.activeDownloadsPerInstance || mine.length >= LIBRARY_LIMITS.downloadsPerInstance) return false;
        downloadItems.set(`${instance}/${e.downloadId}`, { id: `${instance}/${e.downloadId}`, url: e.url, filename: e.filename, mime: e.mime, total: e.total, received: 0, state: 'in_progress', error: null, engine: e.engine, startedAt: at, finishedAt: null });
        fire(listeners.d);
        return true;
      },
      progress(instance, e) {
        const d = downloadItems.get(`${instance}/${e.downloadId}`);
        if (d) d.received = e.received;
      },
      async done(instance, e, at) {
        const d = downloadItems.get(`${instance}/${e.downloadId}`);
        if (d) Object.assign(d, { state: e.state, received: e.received, error: e.error, finishedAt: at });
      },
      async instanceEnded(instance) {
        for (const [k, d] of downloadItems) if (k.startsWith(`${instance}/`) && d.state === 'in_progress') d.state = 'untracked';
      },
      async list(limit) {
        return [...downloadItems.values()].slice(0, limit);
      },
      async remove(id) {
        downloadItems.delete(id);
      },
      async clear() {
        downloadItems.clear();
      },
      onChange(fn) {
        listeners.d.add(fn);
        return () => listeners.d.delete(fn);
      },
    },
  };
  return lib;
}
