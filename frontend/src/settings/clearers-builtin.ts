/**
 * Clearers for local data whose IndexedDB stores already exist (lib/idb.ts). The feature that owns a store may
 * register its own clearer with the same id (registerClearer); the registered one is then used instead (it can also
 * update in-memory state). Settings → Privacy → "Clear browsing data" shows the union.
 *
 * Proxied sites' cookies/site data and closed tabs live in the browser engine (proxy origin) and the tab session;
 * those clearers ('siteData', 'closedTabs') are registered by the browser when it runs.
 */
import { idbClear, idbTransaction, type StoreName } from '../lib/idb';
import type { ClearerDef } from './clearers';

/** Deletes records whose `index` value is ≥ since (or everything without `since`). */
async function clearStore(store: StoreName, index: string, since: number | undefined, keep?: (v: unknown) => boolean): Promise<void> {
  if (since === undefined && !keep) {
    await idbClear(store);
    return;
  }
  await idbTransaction([store], (get) => {
    const os = get(store);
    const source = os.index(index);
    const req = source.openCursor(since === undefined ? null : IDBKeyRange.lowerBound(since));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if (!keep?.(cursor.value)) cursor.delete();
      cursor.continue();
    };
  });
}

/** The categories the dialog always lists, in order (unregistered ones are shown as unavailable). */
export const EXPECTED_CLEARERS: ReadonlyArray<Pick<ClearerDef, 'id' | 'label' | 'description' | 'order'>> = [
  { id: 'history', label: 'Browsing history', description: 'Pages you visited in GNOME’s browser.', order: 10 },
  {
    id: 'siteData',
    label: 'Cookies and site data',
    description: 'Cookies and storage of sites opened in GNOME. Signs you out of most sites.',
    order: 20,
  },
  { id: 'cache', label: 'Cached files', description: 'Files kept to load pages faster.', order: 30 },
  { id: 'downloads', label: 'Downloads list', description: 'The list of downloads. Downloaded files are not deleted.', order: 40 },
  { id: 'closedTabs', label: 'Recently closed tabs', description: 'Tabs you can reopen.', order: 50 },
];

export const BUILTIN_CLEARERS: readonly ClearerDef[] = [
  {
    id: 'history',
    label: 'Browsing history',
    description: 'Pages you visited in GNOME’s browser.',
    order: 10,
    supportsTimeRange: true,
    clear: ({ since }) => clearStore('history', 'visitedAt', since),
  },
  {
    id: 'cache',
    label: 'Cached files',
    description: 'Files GNOME cached in this browser (Cache Storage).',
    order: 30,
    clear: async () => {
      if (typeof caches === 'undefined') return;
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    },
  },
  {
    id: 'downloads',
    label: 'Downloads list',
    description: 'The list of downloads. Downloaded files are not deleted.',
    order: 40,
    supportsTimeRange: true,
    // Downloads still running stay in the list.
    clear: ({ since }) => clearStore('downloads', 'startedAt', since, (v) => (v as { state?: string }).state === 'in_progress'),
  },
  {
    id: 'gamesRecent',
    label: 'Recently played games',
    description: 'The recently played list on the Games page.',
    order: 60,
    supportsTimeRange: true,
    clear: ({ since }) => clearStore('games_recent', 'playedAt', since),
  },
];
