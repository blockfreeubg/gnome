/**
 * The Games page's listing state (one per page mount, docs/WAVE-C.md §5.1–5.2): keyset pages of `GET /api/games`,
 * de-duplicated by id across pages, at most `MAX_ITEMS` kept. Setting `query` aborts the running request and starts
 * at page 1; the filter of Settings → Games (D11) is added to every request, never kept in `query`.
 */
import { isApiError } from '../lib/api';
import type { GameFilter, GamesApi } from './api';
import type { GameListQuery, GameSummary } from './types';

export const PAGE_SIZE = 48;
export const MAX_ITEMS = 15_000;

export type CatalogState = 'idle' | 'loading' | 'more' | 'done' | 'error';

export class CatalogView {
  #api: GamesApi;
  #filter: () => GameFilter;
  #query = $state.raw<GameListQuery>({});
  #items = $state.raw<GameSummary[]>([]);
  #total = $state<number | null>(null);
  #state = $state<CatalogState>('idle');
  #error = $state<string | null>(null);
  #cursor: string | null = null;
  #seen = new Set<number>();
  #abort: AbortController | null = null;
  /** Whether the page that failed was page 1 (retry restarts) or a later one (retry continues). */
  #failedFirst = false;

  constructor(api: GamesApi, filter: () => GameFilter) {
    this.#api = api;
    this.#filter = filter;
  }

  get query(): GameListQuery {
    return this.#query;
  }

  /** Set → aborts the running request, starts page 1. */
  set query(q: GameListQuery) {
    this.#query = { ...q };
    this.#restart();
  }

  get items(): GameSummary[] {
    return this.#items;
  }
  get total(): number | null {
    return this.#total;
  }
  get state(): CatalogState {
    return this.#state;
  }
  get error(): string | null {
    return this.#error;
  }

  /** VirtualGrid onEndReached; a no-op while loading or done. */
  loadMore(): void {
    if (this.#state !== 'idle') return;
    if (this.#cursor === null || this.#items.length >= MAX_ITEMS) {
      this.#state = 'done';
      return;
    }
    void this.#fetch(false);
  }

  retry(): void {
    if (this.#state !== 'error') return;
    if (this.#failedFirst) this.#restart();
    else void this.#fetch(false);
  }

  /** Stops the running request (page unmount). */
  dispose(): void {
    this.#abort?.abort();
    this.#abort = null;
  }

  #restart(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#cursor = null;
    this.#seen = new Set();
    this.#items = [];
    this.#total = null;
    this.#error = null;
    void this.#fetch(true);
  }

  async #fetch(first: boolean): Promise<void> {
    const ctrl = new AbortController();
    this.#abort?.abort();
    this.#abort = ctrl;
    this.#state = first ? 'loading' : 'more';
    this.#error = null;
    const f = this.#filter();
    const q: GameListQuery = {
      ...this.#query,
      ...(f.mobile ? { mobile: true } : {}),
      ...(f.exclude.length ? { exclude: f.exclude } : {}),
      limit: PAGE_SIZE,
      ...(first || this.#cursor === null ? {} : { cursor: this.#cursor }),
    };
    try {
      const page = await this.#api.list(q, ctrl.signal);
      if (ctrl.signal.aborted || this.#abort !== ctrl) return;
      const fresh: GameSummary[] = [];
      for (const item of page.items) {
        if (this.#seen.has(item.id)) continue;
        this.#seen.add(item.id);
        fresh.push(item);
      }
      const room = MAX_ITEMS - this.#items.length;
      this.#items = [...this.#items, ...fresh.slice(0, Math.max(0, room))];
      this.#total = page.total;
      this.#cursor = page.next_cursor;
      this.#state = page.next_cursor === null || this.#items.length >= MAX_ITEMS ? 'done' : 'idle';
    } catch (err) {
      if (ctrl.signal.aborted || this.#abort !== ctrl) return;
      if (isApiError(err, 'aborted')) return;
      this.#failedFirst = first;
      this.#error = err instanceof Error ? err.message : 'Games could not be loaded.';
      this.#state = 'error';
    } finally {
      if (this.#abort === ctrl) this.#abort = null;
    }
  }
}
