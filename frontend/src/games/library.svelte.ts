/**
 * Favorites and recently played (D9): this browser's IndexedDB stores `games_favorites` and `games_recent`, keyed by
 * catalog id, each record with the last `GameSummary` as `snapshot` so the shelves render while the server is
 * unreachable. Not synced. Changes reach the app's other tabs over `gnome:games` (`channel.ts`).
 *
 * A record whose id `by-ids` no longer returns, or returns with another slug (ids are reassigned when an operator
 * rebuilds the database), is "No longer available": it stays listed, greyed, with Remove, and its snapshot is never
 * replaced by the other game.
 */
import { SvelteSet } from 'svelte/reactivity';
import { idbClear, idbDelete, idbPut, idbQuery, idbTransaction, type GameFavoriteRecord, type GameRecentRecord } from '../lib/idb';
import { settings } from '../settings/store.svelte';
import { parseSummary, type GamesApi } from './api';
import { emitGamesChange, onGamesChange } from './channel';
import type { GameSummary } from './types';

export interface GameLibrary {
  readonly favorites: readonly GameFavoriteRecord[]; // lib/idb.ts types, newest first
  readonly recent: readonly GameRecentRecord[];
  /** Ids the last `refresh()` found no longer listed (or listed under another slug). */
  readonly unavailable: ReadonlySet<number>;
  /** The first load from IndexedDB finished (shelves show nothing before, never a flash of "empty"). */
  readonly ready: boolean;
  isFavorite(id: number): boolean;
  toggleFavorite(game: GameSummary): Promise<boolean>; // the new state
  removeFavorite(id: number): Promise<void>;
  recordPlay(game: GameSummary, at?: number): Promise<void>; // honours trackRecent / recentLimit
  removeRecent(id: number): Promise<void>;
  clearRecent(since?: number): Promise<void>;
  /** Refresh snapshots from `by-ids`; returns the ids the server no longer lists, counting an id whose returned slug
   *  differs from the stored one as no longer listed (its snapshot is kept, never replaced by the other game). */
  refresh(api: GamesApi): Promise<number[]>;
}

/** The stored snapshot as a summary (null when it is not one, e.g. written by an older build). */
export function snapshotOf(rec: { snapshot: unknown }): GameSummary | null {
  return parseSummary(rec.snapshot);
}

/** A plain copy of a summary for IndexedDB (Svelte state proxies cannot be cloned into it). */
function plain(game: GameSummary): GameSummary {
  return { ...game, categories: [...game.categories] };
}

class Library implements GameLibrary {
  favorites = $state.raw<GameFavoriteRecord[]>([]);
  recent = $state.raw<GameRecentRecord[]>([]);
  ready = $state(false);
  readonly unavailable = new SvelteSet<number>();
  #loading: Promise<void> | null = null;

  constructor() {
    onGamesChange((kind, remote) => {
      if (remote && (kind === 'favorites' || kind === 'recent')) void this.reload();
    });
    void this.reload();
  }

  /** Reads both stores (newest first). Errors leave the lists as they were (IndexedDB unavailable: empty lists). */
  reload(): Promise<void> {
    const run = (async () => {
      try {
        const [fav, rec] = await Promise.all([
          idbQuery('games_favorites', { index: 'addedAt', direction: 'prev' }),
          idbQuery('games_recent', { index: 'playedAt', direction: 'prev' }),
        ]);
        this.favorites = fav;
        this.recent = rec;
      } catch {
        // IndexedDB unavailable (private mode in some browsers): favorites and recent stay empty for this page.
      } finally {
        this.ready = true;
      }
    })();
    this.#loading = run;
    return run;
  }

  /** Resolves once the first load finished. */
  whenReady(): Promise<void> {
    return this.#loading ?? this.reload();
  }

  isFavorite(id: number): boolean {
    return this.favorites.some((f) => f.id === id);
  }

  async toggleFavorite(game: GameSummary): Promise<boolean> {
    await this.whenReady();
    if (this.isFavorite(game.id)) {
      await this.removeFavorite(game.id);
      return false;
    }
    const rec: GameFavoriteRecord = { id: game.id, slug: game.slug, addedAt: Date.now(), snapshot: plain(game) };
    await idbPut('games_favorites', rec);
    this.favorites = [rec, ...this.favorites.filter((f) => f.id !== game.id)];
    this.unavailable.delete(game.id);
    emitGamesChange('favorites');
    return true;
  }

  async removeFavorite(id: number): Promise<void> {
    await idbDelete('games_favorites', id);
    this.favorites = this.favorites.filter((f) => f.id !== id);
    emitGamesChange('favorites');
  }

  async recordPlay(game: GameSummary, at: number = Date.now()): Promise<void> {
    const { trackRecent, recentLimit } = settings.value.games;
    if (!trackRecent) return;
    await this.whenReady();
    const limit = Math.max(0, Math.floor(recentLimit));
    const rec: GameRecentRecord = { id: game.id, slug: game.slug, playedAt: at, snapshot: plain(game) };
    const next = limit > 0 ? [rec, ...this.recent.filter((r) => r.id !== game.id)].sort((a, b) => b.playedAt - a.playedAt) : [];
    const drop = limit > 0 ? next.slice(limit) : this.recent;
    const keep = next.slice(0, limit);
    await idbTransaction(['games_recent'], (get) => {
      const os = get('games_recent');
      if (limit > 0) os.put(rec);
      for (const d of drop) os.delete(d.id);
    });
    this.recent = keep;
    this.unavailable.delete(game.id);
    emitGamesChange('recent');
  }

  async removeRecent(id: number): Promise<void> {
    await idbDelete('games_recent', id);
    this.recent = this.recent.filter((r) => r.id !== id);
    emitGamesChange('recent');
  }

  async clearRecent(since?: number): Promise<void> {
    if (since === undefined) {
      await idbClear('games_recent');
    } else {
      await idbTransaction(['games_recent'], (get) => {
        const req = get('games_recent').index('playedAt').openCursor(IDBKeyRange.lowerBound(since));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      });
    }
    await this.reload();
    emitGamesChange('recent');
  }

  async refresh(gamesApi: GamesApi): Promise<number[]> {
    await this.whenReady();
    const stored = new Map<number, string>();
    for (const r of [...this.favorites, ...this.recent]) stored.set(r.id, r.slug);
    if (!stored.size) return [];
    const found = await gamesApi.byIds([...stored.keys()]);
    const fresh = new Map<number, GameSummary>();
    for (const g of found) if (stored.get(g.id) === g.slug) fresh.set(g.id, g);
    const gone = [...stored.keys()].filter((id) => !fresh.has(id));
    // Keep the snapshots current (titles and thumbnails change); written only when a record really changed.
    const favs = this.favorites.map((f) => (fresh.has(f.id) ? { ...f, snapshot: plain(fresh.get(f.id)!) } : f));
    const recs = this.recent.map((r) => (fresh.has(r.id) ? { ...r, snapshot: plain(fresh.get(r.id)!) } : r));
    try {
      await idbTransaction(['games_favorites', 'games_recent'], (get) => {
        for (const f of favs) if (fresh.has(f.id)) get('games_favorites').put(f);
        for (const r of recs) if (fresh.has(r.id)) get('games_recent').put(r);
      });
      this.favorites = favs;
      this.recent = recs;
    } catch {
      // The snapshots stay as they were.
    }
    this.unavailable.clear();
    for (const id of gone) this.unavailable.add(id);
    return gone;
  }
}

let instance: Library | null = null;

export function gameLibrary(): GameLibrary {
  return (instance ??= new Library());
}

/** Tests: a fresh library on the next `gameLibrary()`. */
export function resetGameLibrary(): void {
  instance = null;
}

