/**
 * This session's content-blocker counts (WAVE-B3 §7.1): sums of `tab.blocked` deltas per category, per open tab and
 * per site of open tabs (kept per host here, grouped into sites by the caller with core/site.ts `siteOf`, which the app
 * loads lazily: tldts stays out of the app's first chunk). Nothing is persisted.
 *
 * `tab.blocked` carries cumulative counts that the engine host starts again at each new navigation of a tab, from the
 * navigation's first request (engine-host/blocked.ts), and coalesces (the newest value per 500 ms): a delta is the
 * growth since the tab's last event, and a count that went down means a new navigation started (its counts are all
 * new). The blocks of a new page's early requests (the parser's preloads) therefore arrive between the navigation's
 * start (`tab.loading {loading: true}`) and its `tab.committed`; the engine host goes on counting the same navigation
 * after the commit and sends those counts once more then (alone, or merged with later blocks), because the shield
 * starts again at the commit. So a commit after such early counts does not start the sums again (no double count),
 * and those counts move to the committed page's host; a commit with no counts since the navigation started does
 * (the new page's first counts are all new, also when they equal the previous page's). [unproven] when a new
 * navigation's first counts are not lower than the previous page's in any category before its commit (no reset is
 * seen): they then count only as growth over the previous page's (an undercount; the event carries no navigation id).
 *
 * Counts come from the engine host and are display-only (ENGINE-PROTOCOL §1.2 rule 2): a page that escaped its engine
 * can make them up, which is why GNOME shows them as counts and decides nothing on them.
 */
import { SvelteMap } from 'svelte/reactivity';
import { BLOCK_CATEGORIES, type BlockCategory } from '../../shared/engine-protocol';

export type CategoryCounts = Partial<Record<BlockCategory, number>>;

/** Categories the shield and the Extensions page count as "blocked" (direct connections are GNOME's sandbox, not the blocker). */
export const BLOCKER_CATEGORIES: readonly BlockCategory[] = BLOCK_CATEGORIES.filter((c) => c !== 'direct-connection');

export function sumCounts(c: CategoryCounts, categories: readonly BlockCategory[] = BLOCKER_CATEGORIES): number {
  let n = 0;
  for (const k of categories) n += c[k] ?? 0;
  return n;
}

function add(into: CategoryCounts, delta: CategoryCounts): CategoryCounts {
  const out: CategoryCounts = { ...into };
  for (const k of BLOCK_CATEGORIES) if (delta[k]) out[k] = (out[k] ?? 0) + delta[k]!;
  return out;
}

/** `from` minus `delta` (never below 0; categories that reach 0 go). */
function sub(from: CategoryCounts, delta: CategoryCounts): CategoryCounts {
  const out: CategoryCounts = { ...from };
  for (const k of BLOCK_CATEGORIES) {
    if (!delta[k]) continue;
    const v = (out[k] ?? 0) - delta[k]!;
    if (v > 0) out[k] = v;
    else delete out[k];
  }
  return out;
}

const safe = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export class SessionStats {
  /** Session totals per category (all tabs, open or closed). */
  totals: CategoryCounts = $state.raw({});
  /** Per open tab: this session's sums. */
  readonly perTab = new SvelteMap<number, CategoryCounts>();
  /** Per host of the tab's page: this session's sums. */
  readonly perHost = new SvelteMap<string, CategoryCounts>();
  /** The last cumulative counts seen per tab. */
  readonly #last = new Map<number, CategoryCounts>();
  /** Per tab, from a navigation's start to its commit: what the counts that arrived meanwhile added, by host. */
  readonly #navs = new Map<number, Map<string | null, CategoryCounts>>();

  /**
   * A navigation of the tab started (`tab.loading {loading: true}`). One that starts while another has not committed
   * keeps what that one counted: a second `loading` event of the same navigation must not lose its early counts.
   */
  navigationStarted(tabId: number): void {
    if (!this.#navs.has(tabId)) this.#navs.set(tabId, new Map());
  }

  /** The tab stopped loading without a commit (`tab.loading {loading: false}`, `tab.error`): its counts stay where they are. */
  navigationEnded(tabId: number): void {
    this.#navs.delete(tabId);
  }

  /** The tab's top document was committed (cross-document, at `url`): see the header. */
  newDocument(tabId: number, url: string | null = null): void {
    const early = this.#navs.get(tabId);
    this.#navs.delete(tabId);
    if (!early?.size) {
      // Nothing counted since the navigation started: the new page's counts start from zero.
      this.#last.delete(tabId);
      return;
    }
    // The committed page's early blocks: the counts go on (the engine host's next event repeats them), under its host.
    const to = url ? hostOf(url) : null;
    for (const [from, added] of early) {
      if (from === to) continue;
      if (from) {
        const left = sub(this.perHost.get(from) ?? {}, added);
        if (Object.keys(left).length) this.perHost.set(from, left);
        else this.perHost.delete(from);
      }
      if (to) this.perHost.set(to, add(this.perHost.get(to) ?? {}, added));
    }
  }

  /** A tab.blocked event: `byCategory` is cumulative for the tab's current navigation; `url` is the tab's page now. */
  onBlocked(tabId: number, url: string | null, byCategory: CategoryCounts): void {
    const now: CategoryCounts = {};
    for (const k of BLOCK_CATEGORIES) {
      const v = safe(byCategory[k]);
      if (v) now[k] = v;
    }
    const prev = this.#last.get(tabId) ?? {};
    // Any category lower than before: the engine host started a new navigation (its counts are all new).
    const reset = BLOCK_CATEGORIES.some((k) => (now[k] ?? 0) < (prev[k] ?? 0));
    const delta: CategoryCounts = {};
    let any = false;
    for (const k of BLOCK_CATEGORIES) {
      const d = (now[k] ?? 0) - (reset ? 0 : (prev[k] ?? 0));
      if (d > 0) {
        delta[k] = d;
        any = true;
      }
    }
    this.#last.set(tabId, now);
    const host = url ? hostOf(url) : null;
    const early = this.#navs.get(tabId);
    // Counts arrived during a navigation (also when they add nothing new): its commit continues them.
    if (early && !early.has(host)) early.set(host, {});
    if (!any) return;
    this.totals = add(this.totals, delta);
    this.perTab.set(tabId, add(this.perTab.get(tabId) ?? {}, delta));
    if (host) this.perHost.set(host, add(this.perHost.get(host) ?? {}, delta));
    if (early) early.set(host, add(early.get(host) ?? {}, delta));
  }

  /** A tab closed: its per-tab sums go (the totals and the site sums stay for the session). */
  forgetTab(tabId: number): void {
    this.#last.delete(tabId);
    this.#navs.delete(tabId);
    this.perTab.delete(tabId);
  }

  /** The sums per site (`siteOf`) of the given open tabs' pages, in the order of `openUrls`. */
  sitesOf(openUrls: Iterable<string>, siteOf: (url: string) => string | null): Array<{ site: string; counts: CategoryCounts }> {
    const order: string[] = [];
    for (const u of openUrls) {
      const s = siteOf(u);
      if (s && !order.includes(s)) order.push(s);
    }
    const by = new Map<string, CategoryCounts>();
    for (const [host, counts] of this.perHost) {
      const s = siteOf(`http://${host}/`);
      if (s && order.includes(s)) by.set(s, add(by.get(s) ?? {}, counts));
    }
    return order.filter((s) => by.has(s)).map((site) => ({ site, counts: by.get(site)! }));
  }
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
