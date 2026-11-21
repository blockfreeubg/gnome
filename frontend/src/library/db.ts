/**
 * The storage the library stores run on: the three IndexedDB object stores of lib/idb.ts (`history`, `bookmarks`,
 * `downloads`) behind a small interface, so the stores' rules are unit-tested on the in-memory implementation
 * (src/library/testing/memory-db.ts) and on fake-indexeddb with the same tests.
 *
 * Semantics follow IndexedDB: a query over an index visits records in (index value, primary key) order (`prev`
 * reverses both) and skips records that lack the indexed property; `putMany` and `deleteMany` are atomic.
 */
import {
  idbClear,
  idbCount,
  idbGet,
  idbQuery,
  idbTransaction,
  type BookmarkRecord,
  type DownloadRecord,
  type HistoryRecord,
} from '../lib/idb';

export interface LibraryRecords {
  history: { value: HistoryRecord; index: 'visitedAt' | 'url' | 'syncPending' };
  bookmarks: { value: BookmarkRecord; index: 'parentId' | 'url' | 'updatedAt' | 'syncPending' };
  downloads: { value: DownloadRecord; index: 'startedAt' | 'instance' };
}

export type LibraryStoreName = keyof LibraryRecords;
export type LibValue<S extends LibraryStoreName> = LibraryRecords[S]['value'];
export type LibIndex<S extends LibraryStoreName> = LibraryRecords[S]['index'];

/** A key range over an index (or the primary key); an absent bound is open-ended. */
export type KeyRange =
  | { only: IDBValidKey }
  | { lower?: number | string; upper?: number | string; lowerOpen?: boolean; upperOpen?: boolean };

export interface LibraryQuery<S extends LibraryStoreName> {
  index?: LibIndex<S>;
  range?: KeyRange;
  direction?: 'next' | 'prev';
  /** Applied before `limit`. */
  filter?: (value: LibValue<S>) => boolean;
  limit?: number;
}

export interface LibraryDb {
  get<S extends LibraryStoreName>(store: S, id: string): Promise<LibValue<S> | undefined>;
  query<S extends LibraryStoreName>(store: S, q?: LibraryQuery<S>): Promise<LibValue<S>[]>;
  count<S extends LibraryStoreName>(store: S, q?: { index?: LibIndex<S>; range?: KeyRange }): Promise<number>;
  /** Puts every value in one transaction (all or nothing). */
  putMany<S extends LibraryStoreName>(store: S, values: readonly LibValue<S>[]): Promise<void>;
  /** Deletes every id in one transaction. */
  deleteMany(store: LibraryStoreName, ids: readonly string[]): Promise<void>;
  clear(store: LibraryStoreName): Promise<void>;
}

/** Whether `key` is inside `range` (the in-memory implementation and tests use it). */
export function inRange(key: unknown, range: KeyRange | undefined): boolean {
  if (!range) return true;
  if ('only' in range) return compareKeys(key, range.only) === 0;
  if (range.lower !== undefined) {
    const c = compareKeys(key, range.lower);
    if (c < 0 || (c === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const c = compareKeys(key, range.upper);
    if (c > 0 || (c === 0 && range.upperOpen)) return false;
  }
  return true;
}

/** IndexedDB key order for the key types the library uses: numbers sort before strings. */
export function compareKeys(a: unknown, b: unknown): number {
  const rank = (v: unknown): number => (typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function toIdbRange(range: KeyRange | undefined): IDBKeyRange | null {
  if (!range) return null;
  if ('only' in range) return IDBKeyRange.only(range.only);
  const { lower, upper, lowerOpen = false, upperOpen = false } = range;
  if (lower !== undefined && upper !== undefined) return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  if (lower !== undefined) return IDBKeyRange.lowerBound(lower, lowerOpen);
  if (upper !== undefined) return IDBKeyRange.upperBound(upper, upperOpen);
  return null;
}

/** The real implementation: database `gnome` through lib/idb.ts. */
export const idbLibraryDb: LibraryDb = {
  get(store, id) {
    return idbGet(store, id) as Promise<never>;
  },
  query(store, q = {}) {
    return idbQuery(store, {
      index: q.index as never,
      query: toIdbRange(q.range),
      direction: q.direction ?? 'next',
      limit: q.limit,
      filter: q.filter as never,
    }) as Promise<never>;
  },
  async count(store, q = {}) {
    if (!q.index) return idbCount(store, toIdbRange(q.range) ?? undefined);
    let n = 0;
    await idbQuery(store, {
      index: q.index as never,
      query: toIdbRange(q.range),
      filter: () => {
        n++;
        return false;
      },
    });
    return n;
  },
  async putMany(store, values) {
    if (!values.length) return;
    await idbTransaction([store], (get) => {
      const os = get(store);
      for (const v of values) os.put(v);
    });
  },
  async deleteMany(store, ids) {
    if (!ids.length) return;
    await idbTransaction([store], (get) => {
      const os = get(store);
      for (const id of ids) os.delete(id);
    });
  },
  clear(store) {
    return idbClear(store);
  },
};
