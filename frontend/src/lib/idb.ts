/**
 * Tiny typed IndexedDB wrapper for the local-first data in docs/ARCHITECTURE.md §5.2.
 * Database `gnome`; one object store per data kind; schema changes go through UPGRADES (append-only).
 *
 * Every helper rejects with StorageUnavailableError when IndexedDB cannot be opened (private modes, blocked
 * storage); callers degrade gracefully (empty lists, a toast) instead of crashing.
 */
import type { Settings, SitePermission, PermissionValue } from '../settings/schema';
import { BOOKMARK_ROOT } from '../shared/browser-data';
import type { EngineId } from '../shared/engine-protocol';

export const DB_NAME = 'gnome';

// ── Record shapes (shared contract between feature teams) ────────────────────────────────────────────────────────

export interface StoredSettings {
  version: number;
  updatedAt: number;
  data: Settings;
}

export interface HistoryRecord {
  id: string; // uuid
  url: string; // committed top-level URL (http/https)
  title: string | null;
  visitedAt: number; // ms
  /**
   * Set (to the time of the change) while the visit has not been uploaded by history sync; absent once the server
   * acknowledged it, and on visits that came from the server. Indexed (`syncPending`), and records without it are not
   * in that index.
   */
  syncPending?: number;
}

export interface BookmarkRecord {
  id: string; // uuid
  /**
   * BOOKMARK_ROOT ('root') for top-level items in stored records: IndexedDB does not index null. The sync wire
   * format uses null for the root; the bookmarks sync adapter (src/library/bookmarks.ts) maps it both ways, so the
   * records sync.ts converts carry null there.
   */
  parentId: string | null;
  kind: 'bookmark' | 'folder';
  title: string;
  url: string | null; // null for folders
  position: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean; // tombstone for sync
  favorite?: boolean; // shown under "Favorites" on Home (device-local: never synced)
  /** Like HistoryRecord.syncPending: the edit (or tombstone) has not been uploaded yet. */
  syncPending?: number;
}

/** States of a download in GNOME's list (DownloadItemState in src/shared/browser-data.ts). */
export type DownloadRecordState = 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'untracked';

/** Since database version 2 (the appended upgrade migrates version-1 records: migrateDownloadRecord). */
export interface DownloadRecord {
  id: string; // uuid (DownloadItem.id)
  url: string;
  filename: string;
  mime: string | null;
  total: number | null; // total bytes when known
  received: number;
  state: DownloadRecordState;
  error: string | null;
  engine: EngineId;
  /** The engine-host instance that reported it; download ids restart with every engine host. Indexed. */
  instance: string;
  /** The engine host's downloadId (unique within `instance`). */
  downloadId: string;
  /** The app page that recorded it (its liveness decides whether an unfinished download is still observed). */
  page: string;
  startedAt: number;
  finishedAt: number | null;
}

/** The version-1 shape of a download record (never written since version 2). */
export interface DownloadRecordV1 {
  id: string;
  url: string;
  filename: string;
  mime: string | null;
  size: number | null;
  received: number;
  state: 'in_progress' | 'complete' | 'failed' | 'cancelled';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Instance id given to downloads recorded before database version 2 (no engine host knows them). */
export const LEGACY_DOWNLOAD_INSTANCE = 'legacy';

/**
 * Version 1 → 2 for one download record: `size` → `total`, `complete` → `completed`, `engine`, `instance`,
 * `downloadId` and `page` added. A download that was still running belongs to an engine host that is gone, so it
 * becomes `untracked`. Records that already have the version-2 shape are returned as they are.
 */
export function migrateDownloadRecord(raw: unknown): DownloadRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DownloadRecordV1> & Partial<DownloadRecord>;
  if (typeof r.id !== 'string' || typeof r.url !== 'string') return null;
  if (typeof r.instance === 'string' && typeof r.downloadId === 'string' && 'total' in r && typeof r.page === 'string') {
    return r as DownloadRecord;
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const old = (raw as { state?: unknown }).state;
  const state: DownloadRecordState =
    old === 'complete' || old === 'completed'
      ? 'completed'
      : old === 'failed' || old === 'cancelled' || old === 'untracked'
        ? old
        : 'untracked';
  const startedAt = num(r.startedAt) ?? 0;
  return {
    id: r.id,
    url: r.url,
    filename: typeof r.filename === 'string' && r.filename ? r.filename : 'download',
    mime: typeof r.mime === 'string' ? r.mime : null,
    total: num(r.total) ?? num(r.size),
    received: num(r.received) ?? 0,
    state,
    error: typeof r.error === 'string' ? r.error : null,
    engine: r.engine === 'ultraviolet' ? 'ultraviolet' : 'scramjet',
    instance: LEGACY_DOWNLOAD_INSTANCE,
    downloadId: r.id,
    page: LEGACY_DOWNLOAD_INSTANCE,
    startedAt,
    finishedAt: num(r.finishedAt) ?? (state === 'untracked' ? null : startedAt),
  };
}

export interface GameFavoriteRecord {
  id: number; // catalog game id
  slug: string;
  addedAt: number;
  snapshot: unknown; // last known GameSummary (renders offline)
}

export interface GameRecentRecord {
  id: number;
  slug: string;
  playedAt: number;
  snapshot: unknown;
}

export interface SitePermissionRecord {
  host: string;
  permissions: Partial<Record<SitePermission, PermissionValue>>;
  updatedAt: number;
}

export interface StoreMap {
  settings: { key: string; value: StoredSettings; indexes: never };
  session: { key: string; value: unknown; indexes: never };
  history: { key: string; value: HistoryRecord; indexes: 'visitedAt' | 'url' | 'syncPending' };
  bookmarks: { key: string; value: BookmarkRecord; indexes: 'parentId' | 'url' | 'updatedAt' | 'syncPending' };
  downloads: { key: string; value: DownloadRecord; indexes: 'startedAt' | 'instance' };
  games_favorites: { key: number; value: GameFavoriteRecord; indexes: 'addedAt' };
  games_recent: { key: number; value: GameRecentRecord; indexes: 'playedAt' };
  extensions: { key: string; value: unknown; indexes: never };
  sitePermissions: { key: string; value: SitePermissionRecord; indexes: never };
  kv: { key: string; value: unknown; indexes: never };
}

export type StoreName = keyof StoreMap;
export type StoreKey<S extends StoreName> = StoreMap[S]['key'];
export type StoreValue<S extends StoreName> = StoreMap[S]['value'];
export type StoreIndex<S extends StoreName> = StoreMap[S]['indexes'];

export const STORE_NAMES: readonly StoreName[] = [
  'settings',
  'session',
  'history',
  'bookmarks',
  'downloads',
  'games_favorites',
  'games_recent',
  'extensions',
  'sitePermissions',
  'kv',
];

type Upgrade = (db: IDBDatabase, tx: IDBTransaction) => void;

/** Append-only list: UPGRADES[n] migrates version n → n + 1. Never edit a released entry. */
const UPGRADES: readonly Upgrade[] = [
  // v0 → v1: initial stores
  (db) => {
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
    const favorites = db.createObjectStore('games_favorites', { keyPath: 'id' });
    favorites.createIndex('addedAt', 'addedAt');
    const recent = db.createObjectStore('games_recent', { keyPath: 'id' });
    recent.createIndex('playedAt', 'playedAt');
    db.createObjectStore('extensions');
    db.createObjectStore('sitePermissions', { keyPath: 'host' });
    db.createObjectStore('kv');
  },
  // v1 → v2 (Wave B, browser data): sync-pending indexes, the downloads instance index, version-2 download records
  // (migrateDownloadRecord) and top-level bookmarks under BOOKMARK_ROOT instead of null (null is not indexed).
  (_db, tx) => {
    tx.objectStore('history').createIndex('syncPending', 'syncPending');
    const bookmarks = tx.objectStore('bookmarks');
    bookmarks.createIndex('syncPending', 'syncPending');
    const downloads = tx.objectStore('downloads');
    downloads.createIndex('instance', 'instance');
    downloads.openCursor().onsuccess = function () {
      const cursor = this.result;
      if (!cursor) return;
      const next = migrateDownloadRecord(cursor.value);
      if (next) cursor.update(next);
      else cursor.delete();
      cursor.continue();
    };
    bookmarks.openCursor().onsuccess = function () {
      const cursor = this.result;
      if (!cursor) return;
      const b = cursor.value as BookmarkRecord;
      if (b.parentId === null || b.parentId === undefined) cursor.update({ ...b, parentId: BOOKMARK_ROOT });
      cursor.continue();
    };
  },
];

export const DB_VERSION = UPGRADES.length;

export class StorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Local storage (IndexedDB) is unavailable in this browser session.');
    this.name = 'StorageUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Closes the open connection (tests that delete the database between cases; the next helper call reopens it). */
export async function closeDatabase(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  try {
    (await p).close();
  } catch {
    /* it never opened */
  }
}
const listeners = new Set<(state: 'ok' | 'unavailable' | 'blocked', detail?: string) => void>();

/** Observe database availability (used for the diagnostics status registry). */
export function onDatabaseState(fn: (state: 'ok' | 'unavailable' | 'blocked', detail?: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(state: 'ok' | 'unavailable' | 'blocked', detail?: string): void {
  for (const fn of listeners) fn(state, detail);
}

export function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageUnavailableError());
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new StorageUnavailableError(err));
      return;
    }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!tx) return;
      for (let v = ev.oldVersion; v < DB_VERSION; v++) UPGRADES[v]?.(db, tx);
    };
    req.onblocked = () => emit('blocked', 'Another GNOME tab is using an older database version. Close other tabs.');
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: close so it can proceed; next call reopens with the new version.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      emit('ok');
      resolve(db);
    };
    req.onerror = () => reject(new StorageUnavailableError(req.error));
  }).catch((err: unknown) => {
    dbPromise = null;
    const e = err instanceof StorageUnavailableError ? err : new StorageUnavailableError(err);
    emit('unavailable', e.message);
    throw e;
  });
  return dbPromise;
}

async function withStore<S extends StoreName, T>(
  store: S,
  mode: IDBTransactionMode,
  fn: (os: IDBObjectStore) => IDBRequest<T> | Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(store, mode);
  const os = tx.objectStore(store);
  const out = fn(os);
  const result = out instanceof IDBRequest ? requestToPromise(out) : Promise.resolve(out);
  const [value] = await Promise.all([result, txDone(tx)]);
  return value;
}

export function idbGet<S extends StoreName>(store: S, key: StoreKey<S>): Promise<StoreValue<S> | undefined> {
  return withStore(store, 'readonly', (os) => os.get(key) as IDBRequest<StoreValue<S> | undefined>);
}

/** Puts a value. Stores with a keyPath (history, bookmarks, …) take the key from the value; others need `key`. */
export function idbPut<S extends StoreName>(store: S, value: StoreValue<S>, key?: StoreKey<S>): Promise<StoreKey<S>> {
  return withStore(store, 'readwrite', (os) => os.put(value, key) as IDBRequest<StoreKey<S>>);
}

export function idbPutMany<S extends StoreName>(store: S, values: readonly StoreValue<S>[]): Promise<void> {
  return withStore(store, 'readwrite', (os) => {
    for (const v of values) os.put(v);
  });
}

export function idbDelete<S extends StoreName>(store: S, key: StoreKey<S> | IDBKeyRange): Promise<void> {
  return withStore(store, 'readwrite', (os) => os.delete(key) as IDBRequest<undefined>).then(() => undefined);
}

export function idbClear(store: StoreName): Promise<void> {
  return withStore(store, 'readwrite', (os) => os.clear()).then(() => undefined);
}

export function idbCount<S extends StoreName>(store: S, query?: IDBKeyRange | StoreKey<S>): Promise<number> {
  return withStore(store, 'readonly', (os) => os.count(query));
}

export interface QueryOptions<S extends StoreName> {
  index?: StoreIndex<S>;
  query?: IDBKeyRange | IDBValidKey | null;
  direction?: IDBCursorDirection;
  limit?: number;
  /** Skip values that do not match (applied before `limit`). */
  filter?: (value: StoreValue<S>) => boolean;
}

/** Cursor query with index, range, direction, filter and limit (e.g. the 20 most recent history entries). */
export function idbQuery<S extends StoreName>(store: S, opts: QueryOptions<S> = {}): Promise<StoreValue<S>[]> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  return withStore(store, 'readonly', (os) => {
    const source: IDBObjectStore | IDBIndex = opts.index ? os.index(opts.index as string) : os;
    const out: StoreValue<S>[] = [];
    return new Promise<StoreValue<S>[]>((resolve, reject) => {
      if (limit <= 0) {
        resolve(out);
        return;
      }
      const req = source.openCursor(opts.query ?? null, opts.direction ?? 'next');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const value = cursor.value as StoreValue<S>;
        if (!opts.filter || opts.filter(value)) out.push(value);
        if (out.length >= limit) resolve(out);
        else cursor.continue();
      };
    });
  });
}

export function idbGetAll<S extends StoreName>(store: S, opts: Omit<QueryOptions<S>, 'filter' | 'direction'> = {}): Promise<StoreValue<S>[]> {
  return withStore(store, 'readonly', (os) => {
    const source: IDBObjectStore | IDBIndex = opts.index ? os.index(opts.index as string) : os;
    return source.getAll(opts.query ?? null, opts.limit) as IDBRequest<StoreValue<S>[]>;
  });
}

/** Runs several operations atomically in one readwrite transaction. */
export async function idbTransaction<S extends StoreName>(
  stores: readonly S[],
  fn: (get: <T extends S>(name: T) => IDBObjectStore) => void,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(stores as unknown as string[], 'readwrite');
  fn((name) => tx.objectStore(name));
  await txDone(tx);
}

// ── kv convenience ───────────────────────────────────────────────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await idbGet('kv', key)) as T | undefined;
}

export function kvSet<T>(key: string, value: T): Promise<void> {
  return idbPut('kv', value as unknown, key).then(() => undefined);
}

export function kvDelete(key: string): Promise<void> {
  return idbDelete('kv', key);
}

/** RFC 4122 v4 id (crypto.randomUUID where available). */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
