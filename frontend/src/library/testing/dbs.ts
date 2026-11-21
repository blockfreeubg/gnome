/**
 * Test helper: the LibraryDb implementations every store test runs on — the in-memory one and the real IndexedDB
 * adapter (db.ts → lib/idb.ts) on fake-indexeddb, a fresh database per test.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { closeDatabase } from '../../lib/idb';
import { idbLibraryDb, type LibraryDb } from '../db';
import { createMemoryDb } from './memory-db';

export async function freshIndexedDb(): Promise<void> {
  await closeDatabase();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

export const LIBRARY_DBS: ReadonlyArray<readonly [string, () => Promise<LibraryDb>]> = [
  ['memory', async () => createMemoryDb()],
  [
    'indexeddb',
    async () => {
      await freshIndexedDb();
      return idbLibraryDb;
    },
  ],
];

/** A controllable clock. */
export function clock(start = 1_750_000_000_000): { now: () => number; set(t: number): void; advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set: (v) => (t = v),
    advance: (ms) => (t += ms),
  };
}

/** Deterministic UUIDs (valid v4 shape, so the sync server's checks would accept them). */
export function uuids(prefix = 'a'): () => string {
  let n = 0;
  const p = (prefix.replace(/[^0-9a-f]/g, '0') + '00000000').slice(0, 8);
  return () => `${p}-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
}
