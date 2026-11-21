/**
 * Proxied site data (ENGINE-PROTOCOL §6.11): what "clear cookies / site data" removes for every proxied site, both
 * engines. `cookies`: Scramjet's persisted jar (`__scramjet_controller` → `state` / `cookies`) and Ultraviolet's
 * `__op` `cookies` store; `storage`: the proxy origin's localStorage and sessionStorage (where both engines keep the
 * proxied sites' storage under their own key prefixes) and every IndexedDB database except the engines' own;
 * `cache`: Cache Storage, which also holds the content blocker's MAC'd engine sets (`gnome-blocker-v1`, WAVE-B3 §4.3;
 * the core then tells the blocker to cache nothing more this session, and the app replaces its key). Applied at startup by
 * `init.clearOnStart` (before the engines read their jars), and by `siteData.clear` (capability `siteData`).
 */
import type { SiteDataKind } from '../shared/engine-protocol';
import { UV_COOKIE_DB } from './cookies';

/** Databases the engines themselves keep (their cookie stores are emptied, never deleted). */
export const ENGINE_DATABASES: readonly string[] = ['__scramjet_controller', UV_COOKIE_DB];
/** localStorage keys that are not a proxied site's (bare-mux keeps its SharedWorker path here). */
export const ENGINE_STORAGE_KEYS: readonly string[] = ['bare-mux-path'];

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let created = false;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      created = true;
    };
    req.onsuccess = () => {
      if (created) {
        req.result.close();
        indexedDB.deleteDatabase(name);
        resolve(null);
        return;
      }
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
}

async function clearStore(dbName: string, store: string): Promise<void> {
  const db = await openExisting(dbName);
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(store)) return;
    const tx = db.transaction(store, 'readwrite');
    await request(tx.objectStore(store).clear());
  } finally {
    db.close();
  }
}

/** Both engines' persisted cookie jars. */
export async function clearCookies(): Promise<void> {
  await Promise.all([clearStore('__scramjet_controller', 'state'), clearStore(UV_COOKIE_DB, 'cookies')]);
}

/** Keys of the proxy origin's localStorage that belong to proxied sites. */
export function siteStorageKeys(keys: readonly string[]): string[] {
  return keys.filter((k) => !ENGINE_STORAGE_KEYS.includes(k) && !k.startsWith('gnome-'));
}

export async function clearSiteData(kinds: readonly SiteDataKind[]): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (kinds.includes('cookies')) jobs.push(clearCookies());
  if (kinds.includes('storage')) {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) keys.push(k);
    }
    for (const k of siteStorageKeys(keys)) localStorage.removeItem(k);
    sessionStorage.clear();
    if (typeof indexedDB.databases === 'function') {
      jobs.push(
        indexedDB.databases().then((dbs) =>
          Promise.all(
            dbs
              .map((d) => d.name)
              .filter((n): n is string => !!n && !ENGINE_DATABASES.includes(n))
              .map(
                (n) =>
                  new Promise<void>((resolve) => {
                    const r = indexedDB.deleteDatabase(n);
                    r.onsuccess = r.onerror = r.onblocked = () => resolve();
                  }),
              ),
          ),
        ),
      );
    }
  }
  if (kinds.includes('cache') && typeof caches !== 'undefined') {
    jobs.push(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
  await Promise.all(jobs);
}
