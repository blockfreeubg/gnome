/**
 * The browser library: history, bookmarks and downloads in IndexedDB (src/shared/browser-data.ts is the contract the
 * browser shell uses through library()).
 *
 * initLibrary() is idempotent: main.ts calls it at startup (lane c), and the History, Bookmarks and Downloads pages
 * call it too, so they work in a build whose browser has not started. It provides the stores, registers the
 * bookmarks sync adapter (the history adapter only while `account.syncHistory` is on), replaces the built-in
 * `history` and `downloads` clearers of Settings → Privacy, and runs the maintenance: retention
 * (`browser.history.retentionDays`, `browser.downloads.keepDays`), tombstone purge and the sweep of downloads whose
 * app page closed, at start, daily and when those settings change.
 */
import { uuid } from '../lib/idb';
import { registerClearer } from '../settings/clearers';
import { EXPECTED_CLEARERS } from '../settings/clearers-builtin';
import { settings } from '../settings/store.svelte';
import { registerRecordSync, requestRecordSync } from '../settings/sync';
import { provideLibrary } from '../shared/browser-data';
import { createBookmarkStore, type LocalBookmarkStore } from './bookmarks';
import { idbLibraryDb, type LibraryDb } from './db';
import { createDownloadStore, createPageLiveness, type LocalDownloadStore } from './downloads';
import { createHistoryStore, type LocalHistoryStore } from './history';
import { DAY_MS } from './match';

export interface LocalLibrary {
  history: LocalHistoryStore;
  bookmarks: LocalBookmarkStore;
  downloads: LocalDownloadStore;
}

let current: { lib: LocalLibrary; dispose: () => void } | null = null;

/** The stores with the extra methods the library pages use (null before initLibrary()). */
export function localLibrary(): LocalLibrary | null {
  return current?.lib ?? null;
}

function clearerText(id: string): { label: string; description?: string; order?: number } {
  const e = EXPECTED_CLEARERS.find((c) => c.id === id);
  return { label: e?.label ?? id, description: e?.description, order: e?.order };
}

/** Creates the stores and their wiring. `db` is replaceable for tests; the app uses IndexedDB. */
export function createLibrary(db: LibraryDb = idbLibraryDb): { lib: LocalLibrary; dispose: () => void } {
  const b = (): typeof settings.value.browser => settings.value.browser;
  const history = createHistoryStore({
    db,
    prefs: () => ({ enabled: b().history.enabled, retentionDays: b().history.retentionDays }),
    onPending: () => requestRecordSync('history'),
  });
  const bookmarks = createBookmarkStore({ db, onPending: () => requestRecordSync('bookmarks') });
  const downloads = createDownloadStore({
    db,
    prefs: () => ({ track: b().downloads.track, keepDays: b().downloads.keepDays }),
    liveness: createPageLiveness({ id: uuid() }),
  });
  const lib: LocalLibrary = { history, bookmarks, downloads };
  const offs: Array<() => void> = [];
  let disposed = false;

  offs.push(provideLibrary(lib));
  offs.push(registerRecordSync(bookmarks.sync));
  let offHistorySync: (() => void) | null = null;
  const watchHistorySync = (): void => {
    const on = settings.value.account.syncHistory;
    if (on && !offHistorySync) offHistorySync = registerRecordSync(history.sync);
    else if (!on && offHistorySync) {
      offHistorySync();
      offHistorySync = null;
    }
  };
  watchHistorySync();
  offs.push(() => offHistorySync?.());

  offs.push(
    registerClearer({
      id: 'history',
      ...clearerText('history'),
      supportsTimeRange: true,
      clear: ({ since }) => (since === undefined ? history.clear() : history.removeRange(since, Number.MAX_SAFE_INTEGER)),
    }),
  );
  offs.push(
    registerClearer({
      id: 'downloads',
      ...clearerText('downloads'),
      supportsTimeRange: true,
      clear: ({ since }) => (since === undefined ? downloads.clear() : downloads.clearSince(since)),
    }),
  );

  const report = (what: string) => (err: unknown) => console.warn(`[gnome] library ${what} failed`, err);
  const maintain = (): void => {
    void history.prune().catch(report('history retention'));
    void downloads.prune().catch(report('downloads retention'));
    void downloads.sweep().catch(report('downloads sweep'));
    void bookmarks.purgeTombstones().catch(report('tombstone purge'));
  };
  let last = { retention: b().history.retentionDays, keep: b().downloads.keepDays };
  offs.push(
    settings.onChange((change) => {
      if (change.sections.includes('account')) watchHistorySync();
      if (!change.sections.includes('browser')) return;
      const next = { retention: b().history.retentionDays, keep: b().downloads.keepDays };
      if (next.retention !== last.retention) void history.prune().catch(report('history retention'));
      if (next.keep !== last.keep) void downloads.prune().catch(report('downloads retention'));
      last = next;
    }),
  );
  void settings.ready.then(() => {
    if (disposed) return;
    last = { retention: b().history.retentionDays, keep: b().downloads.keepDays };
    watchHistorySync();
    maintain();
  });
  const daily = setInterval(maintain, DAY_MS);
  offs.push(() => clearInterval(daily));

  if (typeof window !== 'undefined') {
    const onHide = (): void => void downloads.flush();
    window.addEventListener('pagehide', onHide);
    offs.push(() => window.removeEventListener('pagehide', onHide));
  }

  return {
    lib,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of offs.reverse()) off();
      history.close();
      bookmarks.close();
      downloads.close();
    },
  };
}

/**
 * Starts the library once per app page (later calls return the same dispose function): provideLibrary() with the
 * history, bookmarks and downloads stores, the sync adapters and the `history` and `downloads` clearers.
 */
export function initLibrary(): () => void {
  if (!current) {
    const created = createLibrary();
    current = {
      lib: created.lib,
      dispose: () => {
        if (current?.lib !== created.lib) return;
        current = null;
        created.dispose();
      },
    };
  }
  return current.dispose;
}
