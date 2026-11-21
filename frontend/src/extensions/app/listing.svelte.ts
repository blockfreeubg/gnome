/**
 * The `/api/filters` listing on the app origin (WAVE-B3 §7.1), kept in IndexedDB `kv` under `blocker:listing:v1` with
 * its ETag, so a reload or an offline server still knows which lists exist and their hashes.
 *
 * Refreshed (a conditional GET: `If-None-Match`, `304` keeps what is stored) at app start, every 60 minutes while
 * GNOME is open, when the Extensions page opens and when `blocker.stats` reports a list that failed — only with
 * `extensions.autoUpdateLists` on. With it off the stored listing is used until the user presses "Update lists now";
 * with none stored it is fetched once. `503` + `Retry-After` (the server is verifying its stored lists after a start)
 * is retried once on the server's schedule.
 */
import { kvGet, kvSet } from '../../lib/idb';
import { parseServerListing, type ServerListing } from './lists';

export const LISTING_KV_KEY = 'blocker:listing:v1';
export const LISTING_REFRESH_MS = 60 * 60 * 1000;
const RETRY_CAP_S = 30;

export type RefreshReason = 'start' | 'interval' | 'page' | 'failed-list' | 'user';
export type ListingState = 'idle' | 'loading' | 'ok' | 'missing' | 'error';

interface Stored {
  listing: ServerListing;
  etag: string | null;
  fetchedAt: number;
}

export interface ListingDeps {
  fetch(input: string, init: RequestInit): Promise<Response>;
  get(): Promise<unknown>;
  put(value: Stored): Promise<void>;
  now(): number;
  /** `extensions.autoUpdateLists`. */
  autoUpdate(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const defaultDeps = (autoUpdate: () => boolean): ListingDeps => ({
  fetch: (input, init) => fetch(input, init),
  get: () => kvGet<unknown>(LISTING_KV_KEY),
  put: (v) => kvSet(LISTING_KV_KEY, v),
  now: () => Date.now(),
  autoUpdate,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

function parseStored(v: unknown): Stored | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const listing = parseServerListing(o.listing);
  if (!listing) return null;
  return {
    listing,
    etag: typeof o.etag === 'string' && o.etag.length <= 200 ? o.etag : null,
    fetchedAt: typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt) ? o.fetchedAt : 0,
  };
}

export class FilterListing {
  /** The listing in use (stored or fetched); null before the first one is known. */
  listing: ServerListing | null = $state.raw(null);
  state: ListingState = $state('idle');
  /** When the server last answered a refresh (200 or 304). */
  checkedAt: number | null = $state(null);
  /** Refreshes that went to the server (tests and diagnostics). */
  requests = 0;

  readonly #deps: ListingDeps;
  #etag: string | null = null;
  #loaded: Promise<void> | null = null;
  #inflight: Promise<void> | null = null;
  #timer: unknown = null;
  #retry: unknown = null;
  #stopped = false;

  constructor(deps: Partial<ListingDeps> & { autoUpdate: () => boolean }) {
    this.#deps = { ...defaultDeps(deps.autoUpdate), ...deps };
  }

  /** Reads the stored listing once (storage errors leave it unknown). */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const s = parseStored(await this.#deps.get());
        if (s && this.listing === null) {
          this.listing = s.listing;
          this.#etag = s.etag;
          this.checkedAt = s.fetchedAt || null;
          this.state = 'ok';
        }
      } catch {
        /* IndexedDB unavailable: the listing is fetched instead */
      }
    })();
    return this.#loaded;
  }

  /** App start: the stored listing, a refresh (auto-update on, or nothing stored) and the hourly timer. */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.load();
    void this.refresh('start');
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    this.#deps.clearTimeout(this.#timer);
    this.#deps.clearTimeout(this.#retry);
    this.#timer = this.#retry = null;
  }

  #schedule(): void {
    this.#deps.clearTimeout(this.#timer);
    if (this.#stopped) return;
    this.#timer = this.#deps.setTimeout(() => {
      this.#timer = null;
      void this.refresh('interval').finally(() => this.#schedule());
    }, LISTING_REFRESH_MS);
  }

  /** Whether a refresh for `reason` goes to the server (the rule of WAVE-B3 §7.1 / §9 `autoUpdateLists`). */
  wants(reason: RefreshReason): boolean {
    if (reason === 'user') return true;
    if (this.#deps.autoUpdate()) return true;
    return this.listing === null;
  }

  /** A refresh for `reason`; resolves when it is done (one at a time: a second call joins the first). */
  async refresh(reason: RefreshReason): Promise<void> {
    await this.load();
    if (!this.wants(reason)) return;
    this.#inflight ??= this.#fetch(true).finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #fetch(mayRetry: boolean): Promise<void> {
    this.requests++;
    if (this.listing === null) this.state = 'loading';
    let res: Response;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.#etag && this.listing) headers['If-None-Match'] = this.#etag;
      res = await this.#deps.fetch('/api/filters', { headers, cache: 'no-store', credentials: 'same-origin' });
    } catch {
      if (this.listing === null) this.state = 'error';
      return;
    }
    const now = this.#deps.now();
    if (res.status === 304 && this.listing) {
      this.checkedAt = now;
      this.state = 'ok';
      void this.#deps.put({ listing: this.listing, etag: this.#etag, fetchedAt: now }).catch(() => undefined);
      return;
    }
    if (res.status === 503 && mayRetry) {
      const after = Number(res.headers.get('retry-after'));
      const s = Number.isFinite(after) && after > 0 ? Math.min(after, RETRY_CAP_S) : 2;
      if (this.listing === null) this.state = 'loading';
      await new Promise<void>((resolve) => {
        this.#retry = this.#deps.setTimeout(() => {
          this.#retry = null;
          resolve();
        }, s * 1000);
      });
      if (this.#stopped) return;
      return this.#fetch(false);
    }
    if (res.status === 404 || res.status === 405) {
      if (this.listing === null) this.state = 'missing';
      return;
    }
    if (!res.ok) {
      if (this.listing === null) this.state = 'error';
      return;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (this.listing === null) this.state = 'error';
      return;
    }
    const listing = parseServerListing(body);
    if (!listing) {
      if (this.listing === null) this.state = 'error';
      return;
    }
    const etag = res.headers.get('etag');
    this.#etag = etag && etag.length <= 200 ? etag : null;
    this.listing = listing;
    this.checkedAt = now;
    this.state = 'ok';
    void this.#deps.put({ listing, etag: this.#etag, fetchedAt: now }).catch(() => undefined);
  }
}
