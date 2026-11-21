/**
 * In-memory LibraryDb for unit tests: the same ordering and sparse-index rules as IndexedDB (db.ts), values copied
 * on the way in and out (structured clone), so a test cannot pass by mutating a returned record.
 */
import { compareKeys, inRange, type KeyRange, type LibIndex, type LibraryDb, type LibraryQuery, type LibraryStoreName, type LibValue } from '../db';

export interface MemoryLibraryDb extends LibraryDb {
  /** Raw records of a store (copies), unordered. */
  dump<S extends LibraryStoreName>(store: S): LibValue<S>[];
  /** Number of putMany/deleteMany/clear calls per store (write-rate tests). */
  writes: Record<LibraryStoreName, number>;
  /** Makes the next operations reject (storage failure tests). */
  failWith: Error | null;
}

export function createMemoryDb(): MemoryLibraryDb {
  const stores: Record<LibraryStoreName, Map<string, unknown>> = {
    history: new Map(),
    bookmarks: new Map(),
    downloads: new Map(),
  };
  const clone = <T>(v: T): T => structuredClone(v);

  function select<S extends LibraryStoreName>(store: S, q: { index?: LibIndex<S>; range?: KeyRange; direction?: 'next' | 'prev' }): LibValue<S>[] {
    const rows = [...stores[store].entries()].map(([id, v]) => ({ id, v: v as Record<string, unknown> }));
    const key = (r: { id: string; v: Record<string, unknown> }): unknown => (q.index ? r.v[q.index as string] : r.id);
    const picked = rows.filter((r) => {
      const k = key(r);
      if (k === undefined || k === null || typeof k === 'boolean') return false;
      return inRange(k, q.range);
    });
    picked.sort((a, b) => compareKeys(key(a), key(b)) || compareKeys(a.id, b.id));
    if (q.direction === 'prev') picked.reverse();
    return picked.map((r) => r.v as unknown as LibValue<S>);
  }

  const db: MemoryLibraryDb = {
    writes: { history: 0, bookmarks: 0, downloads: 0 },
    failWith: null,
    dump(store) {
      return [...stores[store].values()].map((v) => clone(v)) as never;
    },
    async get(store, id) {
      if (db.failWith) throw db.failWith;
      const v = stores[store].get(id);
      return v === undefined ? undefined : (clone(v) as never);
    },
    async query<S extends LibraryStoreName>(store: S, q: LibraryQuery<S> = {}) {
      if (db.failWith) throw db.failWith;
      const out: LibValue<S>[] = [];
      const limit = q.limit ?? Number.POSITIVE_INFINITY;
      if (limit <= 0) return out;
      for (const v of select(store, q)) {
        if (q.filter && !q.filter(clone(v))) continue;
        out.push(clone(v));
        if (out.length >= limit) break;
      }
      return out;
    },
    async count(store, q = {}) {
      if (db.failWith) throw db.failWith;
      return select(store, q).length;
    },
    async putMany(store, values) {
      if (db.failWith) throw db.failWith;
      if (!values.length) return;
      db.writes[store]++;
      for (const v of values) stores[store].set((v as { id: string }).id, clone(v));
    },
    async deleteMany(store, ids) {
      if (db.failWith) throw db.failWith;
      if (!ids.length) return;
      db.writes[store]++;
      for (const id of ids) stores[store].delete(id);
    },
    async clear(store) {
      if (db.failWith) throw db.failWith;
      db.writes[store]++;
      stores[store].clear();
    },
  };
  return db;
}
