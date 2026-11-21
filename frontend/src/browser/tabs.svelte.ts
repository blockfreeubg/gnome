/**
 * GNOME's tab list for one app page (docs/ARCHITECTURE.md §5.6): order, the active tab, pinning, the closed-tab
 * stack, each tab's copy of its back/forward entries (session restore, un-discard) and the discard policy.
 *
 * A tab without a URL shows GNOME's new-tab page; a tab with a URL is a proxied page, `live` while the engine host
 * has a frame for it, `discarded` while it only exists here (memory saver, the live-tab cap). Tab ids double as the
 * protocol's TabId: unique per app page and never reused (LIMITS.maxTabId).
 *
 * Pure state: no engine, DOM or storage access (src/browser/browser.svelte.ts drives it).
 */
import { LIMITS, type BlockCategory, type EngineId, type EventMap, type HistoryHandling, type TabState } from '../shared/engine-protocol';

export type TabError = EventMap['tab.error'];

export interface Tab {
  id: number;
  /** The real URL of the current entry; null = the new-tab page. */
  url: string | null;
  title: string;
  favicon: string | null;
  /** Copy of the engine host's back/forward list (real URLs, oldest first) and the current index. */
  entries: string[];
  index: number;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** The navigation in progress, else the last one. */
  navId: number | null;
  /** When the current navigation started (navigation watchdog), null when none is in progress. */
  navStartedAt: number | null;
  engine: EngineId | null;
  /** The last navigation failed: GNOME's error overlay. */
  error: TabError | null;
  pinned: boolean;
  /** The engine host has a frame for this tab. */
  live: boolean;
  /** Proxied, but its frame was closed to save memory; restored from `entries` when shown. */
  discarded: boolean;
  lastActiveAt: number;
  openerId: number | null;
  /** Opened by a page (tab.openRequest): window.close() may close it while it has one entry. */
  openedByPage: boolean;
  /**
   * A tab a page asked for whose first load has not been sent yet: `url` is what the page asked for, `opener` the real
   * URL of the page that asked (ENGINE-PROTOCOL §6.3). That load goes out as the opener's navigation (tab.create's
   * `start.opener`), not as GNOME's own; null once sent, or once the user chose another URL for the tab.
   */
  pageOpen: { url: string; opener: string } | null;
  zoom: number;
  /** Blocked-request count of the current document (tab.blocked `total`, direct connections included). */
  blocked: number;
  /** The same per category (tab.blocked `byCategory`): the toolbar shield (WAVE-B3 §7.1). */
  blockedBy: Partial<Record<BlockCategory, number>>;
  /** A pop-up this tab's page asked for and GNOME held back (the toolbar indicator). */
  blockedPopups: Array<{ url: string; at: number }>;
  /** The page put an element into fullscreen. */
  fullscreen: boolean;
  /** Set when the user typed in the address bar and has not navigated yet. */
  draft: string | null;
}

export interface ClosedTab {
  url: string | null;
  title: string;
  entries: string[];
  index: number;
  pinned: boolean;
  position: number;
  closedAt: number;
}

/** What survives an app reload (session restore): real URLs and entries only. */
export interface SessionTab {
  url: string | null;
  title: string;
  entries: string[];
  index: number;
  pinned: boolean;
}

export interface SessionSnapshot {
  version: 1;
  tabs: SessionTab[];
  active: number;
  savedAt: number;
}

export const MAX_CLOSED_TABS = 25;

export interface CreateOptions {
  url?: string | null;
  entries?: string[];
  index?: number;
  title?: string;
  pinned?: boolean;
  activate?: boolean;
  /** Insert after this tab (opener) instead of at the end. */
  after?: number | null;
  openerId?: number | null;
  openedByPage?: boolean;
  zoom?: number;
  now?: number;
}

/** The result of applying a commit to the app's copy of the entries. */
export type CommitResult = 'ok' | 'resync';

export class TabModel {
  tabs: Tab[] = $state([]);
  activeId: number | null = $state(null);
  closed: ClosedTab[] = $state([]);
  #nextId = 1;

  get active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  get(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  indexOf(id: number): number {
    return this.tabs.findIndex((t) => t.id === id);
  }

  /** Creates a tab, or returns null at LIMITS.maxTabs (the caller shows a notice). */
  create(opts: CreateOptions = {}): Tab | null {
    if (this.tabs.length >= LIMITS.maxTabs) return null;
    if (this.#nextId > LIMITS.maxTabId) return null;
    const now = opts.now ?? Date.now();
    const url = opts.url ?? null;
    const entries = opts.entries?.length ? opts.entries.slice(-LIMITS.maxTabHistory) : url ? [url] : [];
    const index = Math.min(Math.max(0, opts.index ?? entries.length - 1), Math.max(0, entries.length - 1));
    const tab: Tab = {
      id: this.#nextId++,
      url: entries[index] ?? url,
      title: opts.title ?? '',
      favicon: null,
      entries,
      index,
      canGoBack: index > 0,
      canGoForward: index < entries.length - 1,
      loading: false,
      navId: null,
      navStartedAt: null,
      engine: null,
      error: null,
      pinned: opts.pinned ?? false,
      live: false,
      discarded: false,
      lastActiveAt: now,
      openerId: opts.openerId ?? null,
      openedByPage: opts.openedByPage ?? false,
      pageOpen: null,
      zoom: opts.zoom ?? 1,
      blocked: 0,
      blockedBy: {},
      blockedPopups: [],
      fullscreen: false,
      draft: null,
    };
    let at = this.tabs.length;
    if (opts.after != null) {
      const i = this.indexOf(opts.after);
      if (i >= 0) {
        // After the opener and the tabs it already opened (like browsers do).
        at = i + 1;
        while (at < this.tabs.length && this.tabs[at]!.openerId === opts.after) at++;
      }
    }
    if (tab.pinned) at = Math.min(at, this.pinnedCount());
    else at = Math.max(at, this.pinnedCount());
    this.tabs.splice(at, 0, tab);
    if (opts.activate || this.activeId === null) this.activate(tab.id, now);
    return this.get(tab.id) ?? null;
  }

  pinnedCount(): number {
    let n = 0;
    while (n < this.tabs.length && this.tabs[n]!.pinned) n++;
    return n;
  }

  activate(id: number, now = Date.now()): void {
    const t = this.get(id);
    if (!t) return;
    const prev = this.active;
    if (prev && prev.id !== id) prev.lastActiveAt = now;
    t.lastActiveAt = now;
    this.activeId = id;
  }

  /**
   * Removes a tab, remembers it in the closed-tab stack (proxied or new-tab pages alike) and activates the next one
   * by `browser.closeTabActivates`. Returns the removed tab.
   */
  close(id: number, policy: 'right' | 'left' | 'last-used' = 'right', now = Date.now()): Tab | null {
    const i = this.indexOf(id);
    if (i < 0) return null;
    const tab = this.tabs[i]!;
    this.tabs.splice(i, 1);
    this.closed.unshift({ url: tab.url, title: tab.title, entries: [...tab.entries], index: tab.index, pinned: tab.pinned, position: i, closedAt: now });
    if (this.closed.length > MAX_CLOSED_TABS) this.closed.length = MAX_CLOSED_TABS;
    for (const t of this.tabs) if (t.openerId === id) t.openerId = null;
    if (this.activeId === id) {
      let next: Tab | undefined;
      if (policy === 'last-used') next = [...this.tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      else if (policy === 'left') next = this.tabs[i - 1] ?? this.tabs[i];
      else next = this.tabs[i] ?? this.tabs[i - 1];
      // A tab opened from the closed one goes back to its opener first (like browsers).
      if (tab.openerId !== null && policy !== 'last-used') next = this.get(tab.openerId) ?? next;
      this.activeId = next?.id ?? null;
      if (next) next.lastActiveAt = now;
    }
    return tab;
  }

  /** Pops the most recently closed tab; the caller re-creates it. */
  popClosed(): ClosedTab | null {
    return this.closed.shift() ?? null;
  }

  move(id: number, to: number): void {
    const from = this.indexOf(id);
    if (from < 0) return;
    const tab = this.tabs[from]!;
    const pinned = this.pinnedCount();
    // Pinned tabs stay before the others.
    const lo = tab.pinned ? 0 : pinned - (from < pinned ? 1 : 0);
    const hi = tab.pinned ? pinned - 1 : this.tabs.length - 1;
    const target = Math.min(Math.max(to, lo), hi);
    if (target === from) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(target, 0, tab);
  }

  setPinned(id: number, pinned: boolean): void {
    const t = this.get(id);
    if (!t || t.pinned === pinned) return;
    const from = this.indexOf(id);
    this.tabs.splice(from, 1);
    t.pinned = pinned;
    const at = pinned ? this.pinnedCount() : this.pinnedCount();
    this.tabs.splice(at, 0, t);
  }

  /** The tab `delta` positions away from the active one, wrapping around. */
  cycle(delta: number): Tab | null {
    if (!this.tabs.length) return null;
    const i = Math.max(0, this.indexOf(this.activeId ?? -1));
    return this.tabs[(((i + delta) % this.tabs.length) + this.tabs.length) % this.tabs.length] ?? null;
  }

  // ── Back/forward entries (ENGINE-PROTOCOL §6.1) ─────────────────────────────────────────────────────────────────

  /**
   * Applies a commit to the app's copy of the tab's entries: `push` drops the entries after the old current one,
   * appends the URL and drops the oldest beyond `length`; `replace` overwrites entry `index`; `traverse` moves to
   * `index` and sets it to the URL. Returns `resync` when the result disagrees with the commit's `index`/`length`
   * (an event was dropped): the caller asks `tab.state` and calls applyState().
   */
  applyCommit(id: number, c: { url: string; historyHandling: HistoryHandling; index: number; length: number; canGoBack: boolean; canGoForward: boolean }): CommitResult {
    const t = this.get(id);
    if (!t) return 'ok';
    let entries = [...t.entries];
    let index = t.index;
    if (c.historyHandling === 'push') {
      entries = entries.length ? entries.slice(0, index + 1) : [];
      entries.push(c.url);
      if (entries.length > c.length) entries = entries.slice(entries.length - c.length);
      index = entries.length - 1;
    } else if (c.historyHandling === 'replace') {
      if (entries.length === 0) entries = [c.url];
      else if (c.index < entries.length) entries[c.index] = c.url;
      index = c.index;
    } else {
      if (c.index < entries.length) entries[c.index] = c.url;
      index = c.index;
    }
    t.url = c.url;
    t.canGoBack = c.canGoBack;
    t.canGoForward = c.canGoForward;
    if (index !== c.index || entries.length !== c.length || entries[index] !== c.url) {
      t.index = Math.min(c.index, Math.max(0, entries.length - 1));
      t.entries = entries;
      return 'resync';
    }
    t.entries = entries;
    t.index = index;
    return 'ok';
  }

  /** The engine host's own view of the tab (tab.state): its entries win. */
  applyState(id: number, s: TabState): void {
    const t = this.get(id);
    if (!t) return;
    if (s.entries.length) {
      t.entries = [...s.entries];
      t.index = Math.min(s.index, s.entries.length - 1);
      t.url = s.entries[t.index] ?? t.url;
      t.canGoBack = t.index > 0;
      t.canGoForward = t.index < t.entries.length - 1;
    }
    if (s.title !== null) t.title = s.title;
    t.loading = s.loading;
    if (!s.loading) t.navStartedAt = null;
    t.navId = s.navId;
    t.engine = s.engine ?? t.engine;
    t.error = s.error;
  }

  // ── Discarding (ARCHITECTURE §5.4: memory saver, background tabs, LIMITS.liveTabsSoftCap) ───────────────────────

  /**
   * Live proxied tabs to discard now: never the active tab or a pinned one, nor one that is loading or in
   * fullscreen. `backgroundTabs: 'discard'` discards every live background tab; memory saver those not shown for
   * `discardAfterMinutes`; and beyond LIMITS.liveTabsSoftCap live tabs the least recently used background tabs go.
   */
  discardCandidates(policy: { memorySaver: boolean; discardAfterMinutes: number; backgroundTabs: 'keep-alive' | 'discard' }, now = Date.now()): number[] {
    const live = this.tabs.filter((t) => t.live);
    const eligible = live.filter((t) => t.id !== this.activeId && !t.pinned && !t.loading && !t.fullscreen);
    const out = new Set<number>();
    if (policy.backgroundTabs === 'discard') for (const t of eligible) out.add(t.id);
    if (policy.memorySaver) {
      for (const t of eligible) if (now - t.lastActiveAt >= policy.discardAfterMinutes * 60_000) out.add(t.id);
    }
    let remaining = live.length - out.size;
    if (remaining > LIMITS.liveTabsSoftCap) {
      for (const t of [...eligible].sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
        if (remaining <= LIMITS.liveTabsSoftCap) break;
        if (out.has(t.id)) continue;
        out.add(t.id);
        remaining--;
      }
    }
    return [...out];
  }

  // ── Session restore ────────────────────────────────────────────────────────────────────────────────────────────

  snapshot(now = Date.now()): SessionSnapshot {
    return {
      version: 1,
      tabs: this.tabs.map((t) => ({ url: t.url, title: t.title, entries: [...t.entries], index: t.index, pinned: t.pinned })),
      active: Math.max(0, this.indexOf(this.activeId ?? -1)),
      savedAt: now,
    };
  }
}

/** Checks a stored session snapshot (it comes from IndexedDB: treat it as untrusted input). */
export function parseSession(raw: unknown, normalize: (url: string) => string | null): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<SessionSnapshot>;
  if (v.version !== 1 || !Array.isArray(v.tabs)) return null;
  const tabs: SessionTab[] = [];
  for (const t of v.tabs.slice(0, LIMITS.maxTabs)) {
    if (!t || typeof t !== 'object') continue;
    const entries = (Array.isArray(t.entries) ? t.entries : [])
      .map((e) => (typeof e === 'string' ? normalize(e) : null))
      .filter((e): e is string => e !== null)
      .slice(-LIMITS.maxTabHistory);
    const url = typeof t.url === 'string' ? normalize(t.url) : null;
    const index = Number.isInteger(t.index) ? Math.min(Math.max(0, t.index), Math.max(0, entries.length - 1)) : Math.max(0, entries.length - 1);
    tabs.push({ url: entries[index] ?? url, title: typeof t.title === 'string' ? t.title.slice(0, LIMITS.maxTitleLength) : '', entries: entries.length ? entries : url ? [url] : [], index: entries.length ? index : 0, pinned: t.pinned === true });
  }
  const active = Number.isInteger(v.active) ? Math.min(Math.max(0, v.active as number), Math.max(0, tabs.length - 1)) : 0;
  return { version: 1, tabs, active, savedAt: typeof v.savedAt === 'number' ? v.savedAt : 0 };
}
