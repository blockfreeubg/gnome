/**
 * Per-tab block counts → `tab.blocked` (WAVE-B3 §4.4, C11): the core's BlockCounter. Every block the composite
 * reports (`onBlock`), every counted `uv-blocked` batch and every trusted proxied-document CSP violation
 * (`direct-connection`) is counted here; `total` is the sum of every category. Counts start again with each new
 * navigation of the tab (at its first request, so the blocks of its early subresources count; tabs.ts) and are
 * forgotten with the tab. A block without a tab (the WebSocket backstop's) goes to `onTabless`
 * (EngineDiagnostics.blocker) only. Events leave through the protocol server's coalescer (COALESCE_MS).
 *
 * The app starts a tab's numbers again at every cross-document `tab.committed`; blocks counted before that commit
 * (the parser's early requests) are therefore sent once more right after it (`resend`). A blocked URL counts once per
 * page (`key`): Firefox requests a parser-preloaded image again after its preload was refused (measured: 6 ads and 2
 * trackers for 3 + 1 such images, in both engines), and that second request is the same blocked resource.
 */
import type { BlockCategory, EventMap, TabId } from '../shared/engine-protocol';
import { BLOCK_CATEGORIES } from '../shared/engine-protocol';
import type { BlockCounter } from '../shared/engine-hooks';

/** BlockCounter with what the engine host's own call sites add: a count and a de-duplication key (the URL). */
export interface KeyedBlockCounter extends BlockCounter {
  count(tabId: TabId | null, category: BlockCategory, n?: number, key?: string): void;
}

/** Keys remembered per tab (beyond: blocks are counted without de-duplication). */
const MAX_KEYS = 4096;

export class BlockedCounts implements KeyedBlockCounter {
  readonly #emit: (p: EventMap['tab.blocked']) => void;
  readonly #onTabless: (category: BlockCategory) => void;
  readonly #tabs = new Map<TabId, Partial<Record<BlockCategory, number>>>();
  readonly #keys = new Map<TabId, Set<string>>();

  constructor(emit: (p: EventMap['tab.blocked']) => void, onTabless: (category: BlockCategory) => void) {
    this.#emit = emit;
    this.#onTabless = onTabless;
  }

  count(tabId: TabId | null, category: BlockCategory, n = 1, key?: string): void {
    if (!BLOCK_CATEGORIES.includes(category) || !Number.isSafeInteger(n) || n <= 0) return;
    if (tabId === null) {
      this.#onTabless(category);
      return;
    }
    if (key !== undefined) {
      const k = `${category} ${key}`;
      let seen = this.#keys.get(tabId);
      if (seen?.has(k)) return;
      if (!seen) this.#keys.set(tabId, (seen = new Set()));
      if (seen.size < MAX_KEYS) seen.add(k);
    }
    const by = this.#tabs.get(tabId) ?? {};
    by[category] = Math.min((by[category] ?? 0) + n, Number.MAX_SAFE_INTEGER);
    this.#tabs.set(tabId, by);
    this.#send(tabId, by);
  }

  #send(tabId: TabId, by: Partial<Record<BlockCategory, number>>): void {
    let total = 0;
    for (const c of BLOCK_CATEGORIES) total += by[c] ?? 0;
    this.#emit({ tabId, total: Math.min(total, Number.MAX_SAFE_INTEGER), byCategory: { ...by } });
  }

  /** A new navigation of the tab: its counts start again (no event: the next block reports the new totals). */
  reset(tabId: TabId): void {
    this.#tabs.delete(tabId);
    this.#keys.delete(tabId);
  }

  /** The tab's new top document was committed: what it counted before the commit goes out again (none: nothing). */
  resend(tabId: TabId): void {
    const by = this.#tabs.get(tabId);
    if (by) this.#send(tabId, by);
  }

  /** The tab closed. */
  forget(tabId: TabId): void {
    this.#tabs.delete(tabId);
    this.#keys.delete(tabId);
  }

  /** What a tab has now (tests, test.stats). */
  of(tabId: TabId): Partial<Record<BlockCategory, number>> {
    return { ...(this.#tabs.get(tabId) ?? {}) };
  }
}

/**
 * Navigation announcements (WAVE-B3 D5, §4.4): which hosts this engine host announced with `tab.loading.url` and
 * whether the app has answered since (its answer is a `settings` snapshot that carries the site's rules). A tab's own
 * Scramjet request for a host not yet answered waits for the answer, at most `waitMs` (150), then is judged.
 */
export class Announcements {
  readonly #answered = new Set<string>();
  readonly #pending = new Map<string, Array<() => void>>();
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (t: unknown) => void;
  readonly stats = { waits: 0, timeouts: 0 };

  constructor(timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void }) {
    this.#setTimeout = (fn, ms) => timers.setTimeout(fn, ms);
    this.#clearTimeout = (t) => timers.clearTimeout(t);
  }

  static hostOf(url: string): string | null {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
    } catch {
      return null;
    }
  }

  answered(url: string): boolean {
    const h = Announcements.hostOf(url);
    return h === null || this.#answered.has(h);
  }

  pending(url: string): boolean {
    const h = Announcements.hostOf(url);
    return h !== null && this.#pending.has(h);
  }

  /** `tab.loading.url` went out for `url`. */
  announced(url: string): void {
    const h = Announcements.hostOf(url);
    if (h === null || this.#answered.has(h) || this.#pending.has(h)) return;
    this.#pending.set(h, []);
  }

  /** A `settings` command arrived: every announcement so far is answered. */
  onSettings(): void {
    for (const [h, waiters] of this.#pending) {
      this.#answered.add(h);
      for (const w of waiters) w();
    }
    this.#pending.clear();
    if (this.#answered.size > 4096) this.#answered.clear();
  }

  /** Resolves at the answer for `url`'s host or after `waitMs`; at once when it is answered or was never announced. */
  wait(url: string, waitMs: number): Promise<void> {
    const h = Announcements.hostOf(url);
    const list = h === null ? undefined : this.#pending.get(h);
    if (!list) return Promise.resolve();
    this.stats.waits++;
    return new Promise<void>((resolve) => {
      let done = false;
      const t = this.#setTimeout(() => {
        if (done) return;
        done = true;
        this.stats.timeouts++;
        resolve();
      }, waitMs);
      list.push(() => {
        if (done) return;
        done = true;
        this.#clearTimeout(t);
        resolve();
      });
    });
  }
}

/**
 * WAVE-B3 D16: what the per-document Scramjet WebSocket wrapper decided, for the transport manager's backstop (which
 * sees only the URL). A socket the wrapper allowed leaves one one-shot mark (the first matching connect consumes it
 * and is skipped); a socket it blocked leaves a block mark, and the backstop blocks that URL while it lasts, so a page
 * that reopens it past the wrapper stays blocked. Marks last 5 s.
 */
export class WsMarks {
  static readonly TTL_MS = 5_000;
  readonly #allowed = new Map<string, number[]>();
  readonly #blocked = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  #gc(): void {
    const t = this.#now();
    for (const [u, list] of this.#allowed) {
      const live = list.filter((x) => x > t);
      if (live.length) this.#allowed.set(u, live);
      else this.#allowed.delete(u);
    }
    for (const [u, x] of this.#blocked) if (x <= t) this.#blocked.delete(u);
  }

  allowed(url: string): void {
    this.#gc();
    if (this.#allowed.size > 1000) this.#allowed.clear();
    const list = this.#allowed.get(url) ?? [];
    list.push(this.#now() + WsMarks.TTL_MS);
    this.#allowed.set(url, list);
  }

  blocked(url: string): void {
    this.#gc();
    if (this.#blocked.size > 1000) this.#blocked.clear();
    this.#blocked.set(url, this.#now() + WsMarks.TTL_MS);
  }

  /** The backstop's decision for a connect: 'blocked' (a block mark), 'skip' (an allow mark consumed) or 'judge'. */
  take(url: string): 'blocked' | 'skip' | 'judge' {
    this.#gc();
    if (this.#blocked.has(url)) return 'blocked';
    const list = this.#allowed.get(url);
    if (list && list.length) {
      list.shift();
      if (!list.length) this.#allowed.delete(url);
      return 'skip';
    }
    return 'judge';
  }
}
