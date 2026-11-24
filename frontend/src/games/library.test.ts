import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase } from '../lib/idb';
import { settings } from '../settings/store.svelte';
import { emitGamesChange, GAMES_CHANNEL, resetGamesChannel } from './channel';
import { gameLibrary, resetGameLibrary, snapshotOf } from './library.svelte';
import { createFakeGamesApi, summaryOf } from './testing/fake-api';

const api = createFakeGamesApi();
const g = (i: number) => summaryOf(api.games[i]!);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await closeDatabase();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetGamesChannel();
  resetGameLibrary();
  settings.reset('games');
});

describe('GameLibrary', () => {
  it('toggles favorites, newest first, and persists them', async () => {
    const lib = gameLibrary();
    expect(await lib.toggleFavorite(g(0))).toBe(true);
    await new Promise((r) => setTimeout(r, 2));
    expect(await lib.toggleFavorite(g(1))).toBe(true);
    expect(lib.favorites.map((f) => f.id)).toEqual([g(1).id, g(0).id]);
    expect(lib.isFavorite(g(0).id)).toBe(true);
    expect(await lib.toggleFavorite(g(0))).toBe(false);
    resetGameLibrary();
    const again = gameLibrary();
    // Wait for the first load itself, not a fixed number of ticks (the IndexedDB load is slower under load).
    for (let i = 0; i < 200 && !again.ready; i++) await new Promise((r) => setTimeout(r, 5));
    expect(again.favorites.map((f) => f.id)).toEqual([g(1).id]);
    expect(snapshotOf(again.favorites[0]!)).toEqual(g(1));
  });

  it('records plays within recentLimit, newest first', async () => {
    settings.set('games', 'recentLimit', 2);
    const lib = gameLibrary();
    await lib.recordPlay(g(0), 1000);
    await lib.recordPlay(g(1), 2000);
    await lib.recordPlay(g(2), 3000);
    await lib.recordPlay(g(1), 4000);
    expect(lib.recent.map((r) => [r.id, r.playedAt])).toEqual([
      [g(1).id, 4000],
      [g(2).id, 3000],
    ]);
  });

  it('records nothing while trackRecent is off, and keeps the list', async () => {
    const lib = gameLibrary();
    await lib.recordPlay(g(0), 1000);
    settings.set('games', 'trackRecent', false);
    await lib.recordPlay(g(1), 2000);
    expect(lib.recent.map((r) => r.id)).toEqual([g(0).id]);
  });

  it('recentLimit 0 keeps none', async () => {
    const lib = gameLibrary();
    await lib.recordPlay(g(0), 1000);
    settings.set('games', 'recentLimit', 0);
    await lib.recordPlay(g(1), 2000);
    expect(lib.recent).toEqual([]);
  });

  it('clears recently played by time range', async () => {
    const lib = gameLibrary();
    await lib.recordPlay(g(0), 1000);
    await lib.recordPlay(g(1), 2000);
    await lib.recordPlay(g(2), 3000);
    await lib.clearRecent(2000);
    expect(lib.recent.map((r) => r.id)).toEqual([g(0).id]);
    await lib.clearRecent();
    expect(lib.recent).toEqual([]);
  });

  it('marks an id the server no longer lists, or lists under another slug, as no longer available', async () => {
    const lib = gameLibrary();
    await lib.toggleFavorite(g(0));
    await lib.recordPlay({ ...g(1), slug: 'reassigned-elsewhere' }, 1000);
    await lib.recordPlay({ ...g(2), id: 99_999 }, 2000);
    const gone = await lib.refresh(api);
    expect(gone.sort()).toEqual([g(1).id, 99_999].sort());
    expect(lib.unavailable.has(g(1).id)).toBe(true);
    expect(lib.unavailable.has(g(0).id)).toBe(false);
    // The reassigned id keeps its own snapshot, never the other game's.
    expect(snapshotOf(lib.recent.find((r) => r.id === g(1).id)!)?.slug).toBe('reassigned-elsewhere');
  });

  it('reloads when another tab writes (BroadcastChannel gnome:games)', async () => {
    const lib = gameLibrary();
    await flush();
    const other = new BroadcastChannel(GAMES_CHANNEL);
    // Another tab stores a favorite directly and announces it.
    const { idbPut } = await import('../lib/idb');
    await idbPut('games_favorites', { id: g(3).id, slug: g(3).slug, addedAt: 5, snapshot: g(3) });
    other.postMessage({ kind: 'favorites' });
    for (let i = 0; i < 10 && !lib.favorites.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(lib.favorites.map((f) => f.id)).toEqual([g(3).id]);
    other.close();
    emitGamesChange('favorites'); // a local echo does not reload (nothing to assert beyond not throwing)
  });
});
