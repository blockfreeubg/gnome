/**
 * History store (HistoryStore in src/shared/browser-data.ts) on the `history` object store.
 *
 * Lane c decides which commits are visits (VisitGate); this store adds the user's rules: nothing is recorded while
 * `browser.history.enabled` is off, only http(s) URLs within the sync limits, and visits older than
 * `browser.history.retentionDays` are pruned (at start, daily and when the setting changes: index.ts). The store
 * keeps at most MAX_VISITS visits (the oldest go first), so a forged commit stream from an escaped engine host,
 * which the VisitGate only slows down, cannot grow IndexedDB without bound (ENGINE-PROTOCOL §1.2 rule 2); and the work
 * an engine event causes is bounded too (updateTitle reads only the last 30 minutes of visits).
 *
 * Sync (account.syncHistory): every local visit and title change carries `syncPending` until the server
 * acknowledged it; visits from the server never do. Deleting visits is local: the sync API has no per-visit delete,
 * only `cleared_before`, which another device's "clear" sends and applyRemote() honours.
 */
import type { HistoryRecord } from '../lib/idb';
import type { RecordSyncAdapter } from '../settings/sync';
import type { HistoryStore, HistoryVisit, Suggestion } from '../shared/browser-data';
import { createChangeHub, type ChangeHub } from './changes';
import type { LibraryDb } from './db';
import { DAY_MS, frecency, matchesText, matchQuality, storableTitle, storableUrl, suggestionScore } from './match';
import { historyUploadable } from './wire';

export interface HistoryPrefs {
  /** browser.history.enabled */
  enabled: boolean;
  /** browser.history.retentionDays (0 = forever) */
  retentionDays: number;
}

export interface HistoryDeps {
  db: LibraryDb;
  prefs: () => HistoryPrefs;
  now?: () => number;
  uuid?: () => string;
  /** Change notification (default: a cross-tab hub). */
  hub?: ChangeHub;
  /** A change that history sync should upload (index.ts: requestRecordSync('history')). */
  onPending?: () => void;
  /** The cap and how often it is checked (defaults MAX_VISITS and CAP_CHECK_EVERY; tests use less). */
  maxVisits?: number;
  capCheckEvery?: number;
}

export interface LocalHistoryStore extends HistoryStore {
  /**
   * HistoryStore.query, plus `beforeId` for paging: with it the page continues after the visit (before, beforeId) in
   * the store's order (visitedAt, then id, both descending), so visits that share the boundary millisecond are not
   * skipped.
   */
  query(opts: { text?: string; before?: number; beforeId?: string; limit: number }): Promise<HistoryVisit[]>;
  /** Deletes visits older than the retention period and the oldest beyond MAX_VISITS; resolves to how many. */
  prune(): Promise<number>;
  /** Visits in the store (the History page's header count). */
  count(): Promise<number>;
  /** Puts deleted visits back (the History page's Undo); they are uploaded again by history sync (same ids). */
  restore(visits: readonly HistoryVisit[]): Promise<void>;
  /** Every visit of `url` (all of them, newest first): the page's "remove all visits to this page" count. */
  visitsOf(url: string): Promise<HistoryVisit[]>;
  readonly sync: RecordSyncAdapter<'history'>;
  close(): void;
}

/** How long after a visit `tab.title` may still name it (HistoryStore.updateTitle). */
export const TITLE_WINDOW_MS = 30 * 60_000;
/** Visits the omnibox scans (newest first) to rank suggestions. */
export const SUGGEST_SCAN = 5000;
/** Visits kept at most; beyond it the oldest are deleted (the sync server keeps the newest 100 000 too, API.md). */
export const MAX_VISITS = 100_000;
/** The cap is checked after this many visits were added since the last check (so the store exceeds it by at most this). */
export const CAP_CHECK_EVERY = 500;
const DELETE_BATCH = 2000;
/** When IndexedDB is full, recordVisit drops this share of the oldest visits (at least QUOTA_EVICT_MIN) and retries. */
export const QUOTA_EVICT_SHARE = 0.05;
export const QUOTA_EVICT_MIN = 500;

/** IndexedDB refused a write because the origin's storage quota is used up. */
export function isQuotaError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'QuotaExceededError';
}

function toVisit(r: HistoryRecord): HistoryVisit {
  return { id: r.id, url: r.url, title: r.title, visitedAt: r.visitedAt };
}

export function createHistoryStore(deps: HistoryDeps): LocalHistoryStore {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const hub = deps.hub ?? createChangeHub('history');
  let suggestCache: { rows: HistoryRecord[] } | null = null;
  const offCache = hub.onChange(() => (suggestCache = null));

  const changed = (pending: boolean): void => {
    suggestCache = null;
    hub.emit();
    if (pending) deps.onPending?.();
  };

  function cutoff(): number | null {
    const days = deps.prefs().retentionDays;
    return days > 0 ? now() - days * DAY_MS : null;
  }

  async function deleteIds(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += DELETE_BATCH) await db.deleteMany('history', ids.slice(i, i + DELETE_BATCH));
  }

  /** Deletes the visits in a visitedAt range, DELETE_BATCH at a time (a range can hold all 100 000 visits). */
  async function removeWhere(range: { lower?: number; upper?: number; upperOpen?: boolean }): Promise<number> {
    let removed = 0;
    for (;;) {
      const rows = await db.query('history', { index: 'visitedAt', range, limit: DELETE_BATCH });
      await deleteIds(rows.map((r) => r.id));
      removed += rows.length;
      if (rows.length < DELETE_BATCH) return removed;
    }
  }

  /** Sync stamps grow with every change of a record, also within one millisecond (acknowledge compares them). */
  const pendingStamp = (prev: number | undefined): number => Math.max(now(), (prev ?? 0) + 1);

  /** Deletes the `n` oldest visits; resolves to how many. */
  async function dropOldest(n: number): Promise<number> {
    if (n <= 0) return 0;
    const oldest = await db.query('history', { index: 'visitedAt', limit: n });
    await deleteIds(oldest.map((r) => r.id));
    return oldest.length;
  }

  // The total cap. `added` counts the visits this page added since the last check; one check runs at a time.
  const maxVisits = deps.maxVisits ?? MAX_VISITS;
  const capCheckEvery = deps.capCheckEvery ?? CAP_CHECK_EVERY;
  let added = 0;
  let capRun: Promise<number> | null = null;
  function trimToCap(): Promise<number> {
    capRun ??= (async () => {
      try {
        added = 0;
        const total = await db.count('history');
        if (total <= maxVisits) return 0;
        return await dropOldest(total - maxVisits);
      } finally {
        capRun = null;
      }
    })();
    return capRun;
  }
  /** After visits were stored: the cap check, whose failure does not fail the write that triggered it. */
  async function noteAdded(n: number): Promise<void> {
    added += n;
    if (added < capCheckEvery) return;
    try {
      if ((await trimToCap()) > 0) changed(false);
    } catch (err) {
      console.warn('[gnome] history cap check failed', err);
    }
  }

  const store: LocalHistoryStore = {
    async recordVisit({ url, title, at }) {
      if (!deps.prefs().enabled) return;
      const href = storableUrl(url);
      if (!href || !Number.isFinite(at) || at < 0) return;
      const t = Math.min(at, now());
      const min = cutoff();
      if (min !== null && t < min) return;
      const rec: HistoryRecord = { id: uuid(), url: href, title: storableTitle(title), visitedAt: t, syncPending: t };
      try {
        await db.putMany('history', [rec]);
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        // The browser's storage for GNOME is full. History is a rolling window: it makes room by dropping its oldest
        // visits and tries once more, rather than losing every new visit (and the removal frees room for the rest of
        // the app too).
        const total = await db.count('history');
        const dropped = await dropOldest(Math.min(total, Math.max(QUOTA_EVICT_MIN, Math.ceil(total * QUOTA_EVICT_SHARE))));
        if (dropped) changed(false);
        await db.putMany('history', [rec]);
      }
      changed(true);
      await noteAdded(1);
    },

    async updateTitle(url, title) {
      // Like recordVisit: nothing is written while history is off (the caller's check is not relied on).
      if (!deps.prefs().enabled) return;
      const href = storableUrl(url);
      const t = storableTitle(title);
      if (!href || !t) return;
      // The newest visit of the URL within the window: a scan of the window's visits (bounded by the VisitGate's rate),
      // never of every visit of the URL, which a forged commit stream can make large.
      const [newest] = await db.query('history', {
        index: 'visitedAt',
        range: { lower: now() - TITLE_WINDOW_MS },
        direction: 'prev',
        filter: (r) => r.url === href,
        limit: 1,
      });
      if (!newest || newest.title === t) return;
      await db.putMany('history', [{ ...newest, title: t, syncPending: pendingStamp(newest.syncPending) }]);
      changed(true);
    },

    async query({ text, before, beforeId, limit }) {
      const n = Math.max(0, Math.floor(limit));
      if (!n) return [];
      const q = text?.trim() ?? '';
      const after = before !== undefined && typeof beforeId === 'string' ? { at: before, id: beforeId } : null;
      const filters: Array<(r: HistoryRecord) => boolean> = [];
      // The index runs (visitedAt, id) descending: skip the boundary millisecond's visits up to and including the last one shown.
      if (after) filters.push((r) => r.visitedAt < after.at || r.id < after.id);
      if (q) filters.push((r) => matchesText(q, r.url, r.title));
      const rows = await db.query('history', {
        index: 'visitedAt',
        range: before === undefined ? undefined : { upper: before, upperOpen: !after },
        direction: 'prev',
        filter: filters.length ? (r) => filters.every((f) => f(r)) : undefined,
        limit: n,
      });
      return rows.map(toVisit);
    },

    async suggest(text, limit) {
      const q = text.trim();
      const n = Math.max(0, Math.floor(limit));
      if (!q || !n) return [];
      if (!suggestCache) {
        suggestCache = { rows: await db.query('history', { index: 'visitedAt', direction: 'prev', limit: SUGGEST_SCAN }) };
      }
      const at = now();
      const pages = new Map<string, { title: string | null; times: number[]; newest: number }>();
      for (const r of suggestCache.rows) {
        const p = pages.get(r.url);
        if (p) {
          p.times.push(r.visitedAt);
          if (!p.title && r.title) p.title = r.title;
        } else pages.set(r.url, { title: r.title, times: [r.visitedAt], newest: r.visitedAt });
      }
      const out: Array<Suggestion & { newest: number }> = [];
      for (const [url, p] of pages) {
        const quality = matchQuality(q, url, p.title);
        if (quality <= 0) continue;
        out.push({ url, title: p.title, source: 'history', score: suggestionScore(quality, frecency(p.times, at)), newest: p.newest });
      }
      out.sort((a, b) => b.score - a.score || b.newest - a.newest);
      return out.slice(0, n).map(({ newest: _n, ...s }) => s);
    },

    async remove(ids) {
      const list = ids.filter((id) => typeof id === 'string');
      if (!list.length) return;
      await deleteIds(list);
      changed(false);
    },

    async removeUrl(url) {
      const keys = new Set([url, storableUrl(url)].filter((u): u is string => !!u));
      let ids: string[] = [];
      for (const k of keys) ids = ids.concat((await db.query('history', { index: 'url', range: { only: k } })).map((r) => r.id));
      if (!ids.length) return 0;
      await deleteIds(ids);
      changed(false);
      return ids.length;
    },

    async removeRange(from, to) {
      if (!(to > from)) return;
      const n = await removeWhere({ lower: Math.max(0, from), upper: to, upperOpen: true });
      if (n) changed(false);
    },

    async clear() {
      await db.clear('history');
      changed(false);
    },

    onChange(listener) {
      return hub.onChange(listener);
    },

    async prune() {
      const min = cutoff();
      const n = (min === null ? 0 : await removeWhere({ upper: min, upperOpen: true })) + (await trimToCap());
      if (n) changed(false);
      return n;
    },

    count() {
      return db.count('history');
    },

    async restore(visits) {
      const t = now();
      const puts: HistoryRecord[] = [];
      for (const v of visits) {
        const url = storableUrl(v.url);
        if (!url || typeof v.id !== 'string' || !Number.isFinite(v.visitedAt)) continue;
        puts.push({ id: v.id, url, title: storableTitle(v.title), visitedAt: Math.min(v.visitedAt, t), syncPending: t });
      }
      await db.putMany('history', puts);
      if (puts.length) {
        changed(true);
        await noteAdded(puts.length);
      }
    },

    async visitsOf(url) {
      const href = storableUrl(url) ?? url;
      const rows = await db.query('history', { index: 'url', range: { only: href } });
      return rows.sort((a, b) => b.visitedAt - a.visitedAt).map(toVisit);
    },

    sync: {
      kind: 'history',
      async pending(limit) {
        // A visit the server would refuse would make it refuse the whole batch on every sync: it stays local.
        for (;;) {
          const rows = await db.query('history', { index: 'syncPending', limit: Math.max(1, limit) });
          const t = now();
          const refused = rows.filter((r) => !historyUploadable(r, t));
          if (!refused.length) return rows;
          console.warn(`[gnome] history sync: ${refused.length} visit(s) the server would refuse stay on this device`);
          await db.putMany(
            'history',
            refused.map(({ syncPending: _p, ...rest }) => rest),
          );
        }
      },
      async acknowledge(items) {
        const done: HistoryRecord[] = [];
        for (const item of items) {
          const current = await db.get('history', item.id);
          if (!current || current.syncPending === undefined || current.syncPending !== item.syncPending) continue;
          const { syncPending: _p, ...rest } = current;
          done.push(rest);
        }
        await db.putMany('history', done);
      },
      async applyRemote(items, { clearedBefore }) {
        let removed = 0;
        if (clearedBefore !== null && clearedBefore > 0) removed = await removeWhere({ upper: clearedBefore, upperOpen: true });
        const min = cutoff();
        const puts: HistoryRecord[] = [];
        for (const item of items) {
          const url = storableUrl(item.url);
          if (!url || typeof item.id !== 'string' || !Number.isFinite(item.visitedAt) || item.visitedAt < 0) continue;
          if (clearedBefore !== null && item.visitedAt < clearedBefore) continue;
          if (min !== null && item.visitedAt < min) continue;
          const local = await db.get('history', item.id);
          if (local?.syncPending !== undefined) continue; // a local edit not uploaded yet wins; it goes up next
          puts.push({ id: item.id, url, title: storableTitle(item.title), visitedAt: item.visitedAt });
        }
        await db.putMany('history', puts);
        if (puts.length || removed) changed(false);
        if (puts.length) await noteAdded(puts.length);
      },
    },

    close() {
      offCache();
      hub.close();
    },
  };
  return store;
}
