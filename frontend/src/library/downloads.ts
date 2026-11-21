/**
 * Downloads list (DownloadStore in src/shared/browser-data.ts) on the `downloads` object store.
 *
 * The browser's own download manager saves the files; GNOME lists what the engine host observed (ENGINE-PROTOCOL
 * §6.9). An engine host's download ids restart with every instance, so the store keys an item by instance +
 * downloadId, and it bounds what one instance can add (LIBRARY_LIMITS: 20 unfinished, 200 in total), because an
 * escaped page can forge download events; and since an escaped page can also make the app replace its engine host
 * (every new instance gets a fresh per-instance budget), the list keeps at most `maxItems` items in total (the
 * oldest finished ones go first), so forged downloads cannot grow IndexedDB without bound (ENGINE-PROTOCOL §1.2
 * rule 2). Progress is persisted at most once per second per item.
 *
 * Unfinished downloads of an engine host that is gone become `untracked`: lane c calls instanceEnded() after an
 * engine-host reload; for app pages that closed (no one could call it) the store keeps a heartbeat per app page in
 * localStorage while it observes downloads, and any page's sweep marks the unfinished downloads of a page whose
 * heartbeat stopped.
 */
import type { DownloadRecord } from '../lib/idb';
import { LIBRARY_LIMITS, type DownloadItem, type DownloadStore } from '../shared/browser-data';
import { createChangeHub, type ChangeHub } from './changes';
import type { LibraryDb } from './db';
import { DAY_MS, storableUrl } from './match';

export interface DownloadPrefs {
  /** browser.downloads.track */
  track: boolean;
  /** browser.downloads.keepDays (0 = until the user clears it) */
  keepDays: number;
}

/** Which app pages are still open (the default uses localStorage heartbeats: createPageLiveness). */
export interface PageLiveness {
  /** This app page. */
  readonly id: string;
  isAlive(page: string): boolean;
  /** This page observes unfinished downloads (true) or none any more (false). */
  setActive(active: boolean): void;
  stop(): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DownloadDeps {
  db: LibraryDb;
  prefs: () => DownloadPrefs;
  liveness: PageLiveness;
  now?: () => number;
  uuid?: () => string;
  hub?: ChangeHub;
  timers?: Timers;
  /** Items kept at most (default MAX_DOWNLOAD_ITEMS; tests use less). */
  maxItems?: number;
}

export interface LocalDownloadStore extends DownloadStore {
  /** Removes finished items older than keepDays and the oldest finished ones beyond the cap; resolves to how many. */
  prune(): Promise<number>;
  /** Finished items started at or after `since` (the "Downloads list" clearer); running ones stay. */
  clearSince(since: number): Promise<void>;
  /** Marks unfinished items of app pages that are gone as `untracked`; resolves to how many. */
  sweep(): Promise<number>;
  /** Persists pending progress now (pagehide). */
  flush(): Promise<void>;
  close(): void;
}

/** At most one progress write per item per this interval. */
export const PROGRESS_WRITE_MS = 1000;
/** Items the list keeps at most (the Downloads page shows this many); beyond it the oldest finished ones go. */
export const MAX_DOWNLOAD_ITEMS = 1000;

interface Active {
  id: string;
  instance: string;
  rec: DownloadRecord;
  lastWrite: number;
  timer: unknown;
  dirty: boolean;
  removed: boolean;
}

function toItem(r: DownloadRecord): DownloadItem {
  return {
    id: r.id,
    url: r.url,
    filename: r.filename,
    mime: r.mime,
    total: r.total,
    received: r.received,
    state: r.state,
    error: r.error,
    engine: r.engine,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

const finished = (r: DownloadRecord): boolean => r.state !== 'in_progress';
const bytes = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

export function createDownloadStore(deps: DownloadDeps): LocalDownloadStore {
  const { db, liveness } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const hub = deps.hub ?? createChangeHub('downloads');
  const timers: Timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  /** instance\0downloadId → the item while it runs in this page. */
  const active = new Map<string, Active>();
  /** Per instance: unfinished and total items recorded by this page. */
  const counts = new Map<string, { unfinished: number; total: number }>();
  const keyOf = (instance: string, downloadId: string): string => `${instance}\u0000${downloadId}`;

  const changed = (): void => hub.emit();
  const maxItems = deps.maxItems ?? MAX_DOWNLOAD_ITEMS;

  /** Deletes the oldest finished items beyond the cap (running ones stay: at most 20 per live instance); one at a time. */
  let capRun: Promise<number> | null = null;
  function trimToCap(): Promise<number> {
    capRun ??= (async () => {
      try {
        const total = await db.count('downloads');
        if (total <= maxItems) return 0;
        const oldest = await db.query('downloads', { index: 'startedAt', filter: finished, limit: total - maxItems });
        await db.deleteMany(
          'downloads',
          oldest.map((r) => r.id),
        );
        return oldest.length;
      } finally {
        capRun = null;
      }
    })();
    return capRun;
  }

  function updateActivity(): void {
    liveness.setActive([...active.values()].some((a) => !a.removed));
  }

  async function write(a: Active): Promise<void> {
    if (a.timer !== null) {
      timers.clear(a.timer);
      a.timer = null;
    }
    a.dirty = false;
    a.lastWrite = now();
    if (a.removed) return;
    await db.putMany('downloads', [a.rec]);
    changed();
  }

  function finish(key: string, a: Active): void {
    active.delete(key);
    const c = counts.get(a.instance);
    if (c) c.unfinished = Math.max(0, c.unfinished - 1);
    updateActivity();
  }

  async function markUntracked(rows: DownloadRecord[]): Promise<number> {
    const stale = rows.filter((r) => r.state === 'in_progress').map((r) => ({ ...r, state: 'untracked' as const, finishedAt: null }));
    await db.putMany('downloads', stale);
    if (stale.length) changed();
    return stale.length;
  }

  const store: LocalDownloadStore = {
    async started(instance, e, at) {
      if (!deps.prefs().track) return false;
      const key = keyOf(instance, e.downloadId);
      if (active.has(key)) return false;
      const c = counts.get(instance) ?? { unfinished: 0, total: 0 };
      if (c.unfinished >= LIBRARY_LIMITS.activeDownloadsPerInstance || c.total >= LIBRARY_LIMITS.downloadsPerInstance) return false;
      const url = storableUrl(e.url);
      if (!url) return false;
      c.unfinished++;
      c.total++;
      counts.set(instance, c);
      const t = Number.isFinite(at) && at > 0 ? Math.min(at, now()) : now();
      const rec: DownloadRecord = {
        id: uuid(),
        url,
        filename: e.filename || 'download',
        mime: e.mime,
        total: bytes(e.total),
        received: 0,
        state: 'in_progress',
        error: null,
        engine: e.engine,
        instance,
        downloadId: e.downloadId,
        page: liveness.id,
        startedAt: t,
        finishedAt: null,
      };
      const a: Active = { id: rec.id, instance, rec, lastWrite: 0, timer: null, dirty: false, removed: false };
      active.set(key, a);
      updateActivity();
      try {
        await write(a);
      } catch (err) {
        // done() may have finished it meanwhile (its own write failed too): count the slot back once.
        if (active.get(key) === a) finish(key, a);
        c.total = Math.max(0, c.total - 1);
        throw err;
      }
      // Not awaited: the app learns at once that the item is recorded (its later events are only kept from then on).
      void trimToCap().then(
        (n) => {
          if (n > 0) changed();
        },
        (err: unknown) => console.warn('[gnome] downloads cap check failed', err),
      );
      return true;
    },

    progress(instance, e) {
      const a = active.get(keyOf(instance, e.downloadId));
      if (!a || a.removed) return;
      const received = bytes(e.received);
      if (received !== null) a.rec = { ...a.rec, received };
      if (e.total !== undefined) a.rec = { ...a.rec, total: bytes(e.total) ?? a.rec.total };
      a.dirty = true;
      const wait = a.lastWrite + PROGRESS_WRITE_MS - now();
      if (wait <= 0) {
        void write(a).catch(() => undefined);
        return;
      }
      if (a.timer === null) {
        a.timer = timers.set(() => {
          a.timer = null;
          if (a.dirty && active.get(keyOf(instance, e.downloadId)) === a) void write(a).catch(() => undefined);
        }, wait);
      }
    },

    async done(instance, e, at) {
      const key = keyOf(instance, e.downloadId);
      const a = active.get(key);
      if (!a) return;
      finish(key, a);
      const t = Number.isFinite(at) && at > 0 ? Math.min(at, now()) : now();
      a.rec = {
        ...a.rec,
        state: e.state,
        received: bytes(e.received) ?? a.rec.received,
        total: e.state === 'completed' && a.rec.total === null ? bytes(e.received) : a.rec.total,
        error: e.state === 'completed' ? null : e.error,
        finishedAt: Math.max(t, a.rec.startedAt),
      };
      await write(a);
    },

    async instanceEnded(instance) {
      for (const [key, a] of [...active]) {
        if (a.instance !== instance) continue;
        if (a.timer !== null) timers.clear(a.timer);
        a.timer = null;
        active.delete(key);
      }
      counts.delete(instance);
      updateActivity();
      // Only this page's items: instance ids come from the engine host, so another page's (forged) instance may share it.
      await markUntracked(await db.query('downloads', { index: 'instance', range: { only: instance }, filter: (r) => r.page === liveness.id }));
    },

    async list(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (!n) return [];
      const rows = await db.query('downloads', { index: 'startedAt', direction: 'prev', limit: n });
      const byId = new Map([...active.values()].map((a) => [a.id, a]));
      return rows.map((r) => toItem(byId.get(r.id)?.rec ?? r));
    },

    async remove(id) {
      for (const a of active.values()) if (a.id === id) a.removed = true;
      updateActivity();
      await db.deleteMany('downloads', [id]);
      changed();
    },

    async clear() {
      const rows = await db.query('downloads', { filter: finished });
      await db.deleteMany(
        'downloads',
        rows.map((r) => r.id),
      );
      changed();
    },

    async clearSince(since) {
      const rows = await db.query('downloads', { index: 'startedAt', range: { lower: since }, filter: finished });
      await db.deleteMany(
        'downloads',
        rows.map((r) => r.id),
      );
      if (rows.length) changed();
    },

    onChange(listener) {
      return hub.onChange(listener);
    },

    async prune() {
      const days = deps.prefs().keepDays;
      let n = 0;
      if (days > 0) {
        const min = now() - days * DAY_MS;
        const rows = await db.query('downloads', { filter: (r) => finished(r) && (r.finishedAt ?? r.startedAt) < min });
        await db.deleteMany(
          'downloads',
          rows.map((r) => r.id),
        );
        n += rows.length;
      }
      n += await trimToCap();
      if (n) changed();
      return n;
    },

    async sweep() {
      const rows = await db.query('downloads', { filter: (r) => r.state === 'in_progress' && r.page !== liveness.id && !liveness.isAlive(r.page) });
      return markUntracked(rows);
    },

    async flush() {
      await Promise.all([...active.values()].filter((a) => a.dirty).map((a) => write(a).catch(() => undefined)));
    },

    close() {
      for (const a of active.values()) if (a.timer !== null) timers.clear(a.timer);
      active.clear();
      liveness.stop();
      hub.close();
    },
  };
  return store;
}

// ── App-page liveness (localStorage heartbeats) ──────────────────────────────────────────────────────────────────

export const PAGE_KEY_PREFIX = 'gnome:library:page:';
/** Heartbeat interval while the page observes downloads… */
export const HEARTBEAT_MS = 20_000;
/** …and how old a heartbeat may be before the page counts as closed (background tabs run timers once a minute). */
export const PAGE_STALE_MS = 3 * 60_000;

export function createPageLiveness(opts: { id: string; storage?: Storage | null; now?: () => number; timers?: Timers }): PageLiveness {
  const storage = opts.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.storage;
  const now = opts.now ?? Date.now;
  const timers: Timers = opts.timers ?? { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  const key = PAGE_KEY_PREFIX + opts.id;
  let timer: unknown = null;
  const beat = (): void => {
    try {
      storage?.setItem(key, String(now()));
    } catch {
      /* storage full or blocked: other pages then treat this page's downloads as untracked after PAGE_STALE_MS */
    }
  };
  const drop = (): void => {
    try {
      storage?.removeItem(key);
    } catch {
      /* ignore */
    }
  };
  // Heartbeats of pages that closed without pagehide: forget them.
  try {
    for (let i = (storage?.length ?? 0) - 1; i >= 0; i--) {
      const k = storage?.key(i);
      if (!k?.startsWith(PAGE_KEY_PREFIX) || k === key) continue;
      const at = Number(storage?.getItem(k));
      if (!Number.isFinite(at) || now() - at > PAGE_STALE_MS) storage?.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  return {
    id: opts.id,
    isAlive(page) {
      if (page === opts.id) return true;
      try {
        const at = Number(storage?.getItem(PAGE_KEY_PREFIX + page));
        return Number.isFinite(at) && at > 0 && now() - at <= PAGE_STALE_MS;
      } catch {
        return false;
      }
    },
    setActive(on) {
      if (on && timer === null) {
        beat();
        timer = timers.set(beat, HEARTBEAT_MS);
      } else if (!on && timer !== null) {
        timers.clear(timer);
        timer = null;
        drop();
      }
    },
    stop() {
      if (timer !== null) timers.clear(timer);
      timer = null;
      drop();
    },
  };
}
