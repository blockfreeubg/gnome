/**
 * The appended IndexedDB upgrade (lib/idb.ts, version 1 → 2) on fake-indexeddb: a version-1 database written with
 * the released version-1 schema is opened by the current code and migrated.
 */
import { describe, expect, it } from 'vitest';
import { closeDatabase, DB_NAME, DB_VERSION, idbGetAll, idbQuery, LEGACY_DOWNLOAD_INSTANCE, migrateDownloadRecord, requestToPromise } from '../lib/idb';
import { BOOKMARK_ROOT } from '../shared/browser-data';
import { freshIndexedDb } from './testing/dbs';

/** The released version-1 schema (lib/idb.ts UPGRADES[0]), copied so this test keeps describing version 1. */
function createV1(db: IDBDatabase): void {
  db.createObjectStore('settings');
  db.createObjectStore('session');
  const history = db.createObjectStore('history', { keyPath: 'id' });
  history.createIndex('visitedAt', 'visitedAt');
  history.createIndex('url', 'url');
  const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'id' });
  bookmarks.createIndex('parentId', 'parentId');
  bookmarks.createIndex('url', 'url');
  bookmarks.createIndex('updatedAt', 'updatedAt');
  const downloads = db.createObjectStore('downloads', { keyPath: 'id' });
  downloads.createIndex('startedAt', 'startedAt');
  db.createObjectStore('games_favorites', { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
  db.createObjectStore('games_recent', { keyPath: 'id' }).createIndex('playedAt', 'playedAt');
  db.createObjectStore('extensions');
  db.createObjectStore('sitePermissions', { keyPath: 'host' });
  db.createObjectStore('kv');
}

async function writeV1(records: { downloads?: unknown[]; bookmarks?: unknown[]; history?: unknown[] }): Promise<void> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => createV1(req.result);
  const db = await requestToPromise(req);
  const tx = db.transaction(['downloads', 'bookmarks', 'history'], 'readwrite');
  for (const [store, list] of Object.entries(records)) for (const r of list ?? []) tx.objectStore(store).put(r);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('IndexedDB upgrade 1 → 2', () => {
  it('is the second upgrade', () => {
    expect(DB_VERSION).toBe(2);
  });

  it('migrates download records, moves top-level bookmarks to the root sentinel and adds the new indexes', async () => {
    await freshIndexedDb();
    await writeV1({
      downloads: [
        { id: 'd1', url: 'https://f.example/a.zip', filename: 'a.zip', mime: 'application/zip', size: 1000, received: 1000, state: 'complete', error: null, startedAt: 10, finishedAt: 20 },
        { id: 'd2', url: 'https://f.example/b.iso', filename: 'b.iso', mime: null, size: null, received: 5, state: 'in_progress', error: null, startedAt: 30, finishedAt: null },
        { id: 'd3', url: 'https://f.example/c', filename: 'c', mime: null, size: 9, received: 1, state: 'failed', error: 'network', startedAt: 40, finishedAt: 41 },
        { nope: true, id: 7 },
      ],
      bookmarks: [
        { id: 'b1', parentId: null, kind: 'bookmark', title: 'Top', url: 'https://top.example/', position: 0, createdAt: 1, updatedAt: 1, deleted: false, favorite: true },
        { id: 'b2', parentId: 'f1', kind: 'bookmark', title: 'In', url: 'https://in.example/', position: 0, createdAt: 1, updatedAt: 1, deleted: false },
      ],
      history: [{ id: 'h1', url: 'https://h.example/', title: 'H', visitedAt: 5 }],
    });
    await closeDatabase();
    const downloads = await idbGetAll('downloads');
    const byId = Object.fromEntries(downloads.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(byId.d1).toMatchObject({ total: 1000, state: 'completed', engine: 'scramjet', instance: LEGACY_DOWNLOAD_INSTANCE, finishedAt: 20 });
    expect(byId.d1).not.toHaveProperty('size');
    expect(byId.d2).toMatchObject({ state: 'untracked', total: null, received: 5, finishedAt: null });
    expect(byId.d3).toMatchObject({ state: 'failed', error: 'network', total: 9 });
    expect(await idbQuery('downloads', { index: 'instance', query: IDBKeyRange.only(LEGACY_DOWNLOAD_INSTANCE) })).toHaveLength(3);
    const top = await idbQuery('bookmarks', { index: 'parentId', query: IDBKeyRange.only(BOOKMARK_ROOT) });
    expect(top.map((b) => [b.id, b.favorite])).toEqual([['b1', true]]);
    // History records are untouched, and the sparse syncPending index starts empty (old visits are not re-uploaded).
    expect(await idbGetAll('history')).toEqual([{ id: 'h1', url: 'https://h.example/', title: 'H', visitedAt: 5 }]);
    expect(await idbQuery('history', { index: 'syncPending' })).toEqual([]);
  });

  it('migrateDownloadRecord leaves version-2 records alone and drops unusable ones', () => {
    const v2 = migrateDownloadRecord({ id: 'x', url: 'https://x.example/', size: 3, state: 'complete', startedAt: 1, finishedAt: 2 })!;
    expect(migrateDownloadRecord(v2)).toBe(v2);
    expect(migrateDownloadRecord(null)).toBeNull();
    expect(migrateDownloadRecord({ id: 1, url: 'x' })).toBeNull();
  });
});
