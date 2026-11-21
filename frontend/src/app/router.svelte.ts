/**
 * Client router (History API).
 *
 * - Lazy page chunks from the route registry (routes.ts); a top progress bar shows only when a load is slow.
 * - Same-origin <a href> clicks are intercepted (except downloads, target=_blank, modifier clicks, rel="external",
 *   data-router="off" and server paths like /api/ or /wisp/). Hover/focus prefetches the target chunk when
 *   Settings → Performance → "Prefetch pages" is on.
 * - Scroll restoration per history entry (also across reloads via sessionStorage); new pages start at the top or at
 *   their #hash target.
 * - Route changes use the View Transitions API when available (cross-fade + 6px rise), otherwise a Svelte
 *   cross-fade; both follow the motion setting and are skipped when motion is "none".
 * - Focus: if the focused element disappeared with the old page, focus moves to the new page's <h1>; the new page
 *   title is announced to screen readers.
 */
import { flushSync, tick } from 'svelte';
import { appEvents } from '../lib/events';
import { supportsViewTransitions } from '../lib/platform';
import { getMotionScale } from '../settings/apply';
import { settings } from '../settings/store.svelte';
import { announce } from './announcer.svelte';
import { isServerPath, normalizePath } from './match';
import { toast } from './overlays/toast.svelte';
import { loadRoute, matchRoute, routeTitle, type PageComponent, type RouteDef } from './routes';

export interface RouteState {
  route: RouteDef;
  params: Record<string, string>;
  query: URLSearchParams;
  pathname: string;
  search: string;
  hash: string;
  /** History entry key (scroll restoration). */
  key: string;
  /** Identity of the rendered page (route + path): query/hash changes keep the page mounted. */
  pageKey: string;
  /** Loaded page component (null for persistent routes, which render in their own layer). */
  component: PageComponent | null;
}

export interface NavigateOptions {
  replace?: boolean;
}

interface HistoryState {
  gnome: 1;
  key: string;
  idx: number;
}

type Mode = 'initial' | 'push' | 'replace' | 'pop';

const SCROLL_STORAGE = 'gnome:scroll';
const CHUNK_RELOAD_FLAG = 'gnome:chunk-reload';
const newKey = (): string => Math.random().toString(36).slice(2, 10);

function isHistoryState(v: unknown): v is HistoryState {
  return !!v && typeof v === 'object' && (v as HistoryState).gnome === 1 && typeof (v as HistoryState).key === 'string';
}

function currentLocation(): { pathname: string; search: string; hash: string } {
  return { pathname: location.pathname, search: location.search, hash: location.hash };
}

class Router {
  current = $state.raw<RouteState | null>(null);
  /** A page chunk is loading for longer than ~120 ms. */
  pending = $state(false);
  /** Persistent pages loaded so far (rendered by the shell in their own layers). */
  persistent = $state.raw<Array<{ route: RouteDef; component: PageComponent }>>([]);
  /** How the RouteView animates the current swap. */
  transition = $state<'none' | 'crossfade' | 'view-transition'>('none');
  direction = $state<'forward' | 'back'>('forward');
  /**
   * Position in the app's own history entries (the toolbar's Back/Forward on GNOME pages): `index` is the current
   * entry, `top` the furthest entry known to exist after it (a push drops the forward entries, like browsers do).
   */
  entries = $state({ index: 0, top: 0 });
  /** Bumped by reload(): the RouteView re-mounts the current page. */
  reloads = $state(0);

  #scroller: HTMLElement | null = null;
  #layers = new Map<string, HTMLElement>();
  #token = 0;
  #index = 0;
  #positions = new Map<string, number>();
  #initialized = false;
  #prefetched = new Set<string>();

  /** The shell registers its page scroll container (used for scroll restoration and focus). */
  setScroller(el: HTMLElement | null): void {
    this.#scroller = el;
  }

  /**
   * The shell registers the layer of each persistent route (focus target after navigating to it, since the page
   * scroller is hidden then). Returns the unregister function.
   */
  setLayer(routeId: string, el: HTMLElement): () => void {
    this.#layers.set(routeId, el);
    return () => {
      if (this.#layers.get(routeId) === el) this.#layers.delete(routeId);
    };
  }

  get scroller(): HTMLElement | null {
    return this.#scroller;
  }

  /** True when the current route belongs to the given rail section. */
  isActive(section: string): boolean {
    const r = this.current?.route;
    return !!r && (r.section ?? r.id) === section;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.#loadPositions();

    let state = history.state as unknown;
    if (!isHistoryState(state)) {
      state = { gnome: 1, key: newKey(), idx: 0 } satisfies HistoryState;
      history.replaceState(state, '', location.href);
    }
    this.#index = (state as HistoryState).idx;
    this.entries = { index: this.#index, top: this.#index };

    window.addEventListener('popstate', (ev) => this.#onPop(ev));
    document.addEventListener('click', (ev) => this.#onClick(ev));
    const onHover = (ev: Event): void => this.#onHover(ev);
    document.addEventListener('pointerover', onHover, { passive: true });
    document.addEventListener('focusin', onHover);
    window.addEventListener('pagehide', () => this.#savePositions());

    await this.#go(currentLocation(), 'initial', (state as HistoryState).key);
  }

  /** Navigates within the app (absolute or relative URL). Other origins and server paths do a full load. */
  async navigate(to: string, opts: NavigateOptions = {}): Promise<void> {
    const url = new URL(to, location.href);
    if (url.origin !== location.origin || isServerPath(url.pathname)) {
      location.assign(url.href);
      return;
    }
    const pathname = normalizePath(url.pathname);
    const cur = this.current;
    const samePage = !!cur && pathname === cur.pathname && url.search === cur.search;
    if (samePage && cur) {
      if (url.hash === cur.hash) {
        if (!opts.replace) this.#scroller?.scrollTo({ top: 0, behavior: getMotionScale() > 0 ? 'smooth' : 'auto' });
        return;
      }
      // Hash-only change: update the entry and scroll to the target.
      const state: HistoryState = { gnome: 1, key: opts.replace ? cur.key : newKey(), idx: opts.replace ? this.#index : this.#index + 1 };
      if (!opts.replace) this.#index++;
      if (opts.replace) history.replaceState(state, '', url.href);
      else history.pushState(state, '', url.href);
      if (!opts.replace) this.entries = { index: this.#index, top: this.#index };
      this.current = { ...cur, hash: url.hash, key: state.key };
      this.#scrollToHash(url.hash);
      return;
    }
    await this.#go(
      { pathname, search: url.search, hash: url.hash },
      opts.replace ? 'replace' : 'push',
      opts.replace && cur ? cur.key : newKey(),
    );
  }

  back(): void {
    history.back();
  }

  forward(): void {
    history.forward();
  }

  get canGoBack(): boolean {
    return this.entries.index > 0;
  }

  get canGoForward(): boolean {
    return this.entries.index < this.entries.top;
  }

  /** Re-mounts the current (non-persistent) page, like a browser's Reload for GNOME's own pages. */
  reload(): void {
    if (!this.current || this.current.route.persistent) return;
    this.reloads++;
    queueMicrotask(() => this.#manageFocus(null));
  }

  /** Loads a route's chunk ahead of time (hover/focus on links, rail items). */
  prefetch(path: string): void {
    const pathname = normalizePath(new URL(path, location.href).pathname);
    if (this.#prefetched.has(pathname)) return;
    this.#prefetched.add(pathname);
    const { route } = matchRoute(pathname);
    loadRoute(route).catch(() => this.#prefetched.delete(pathname));
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  async #go(loc: { pathname: string; search: string; hash: string }, mode: Mode, key: string): Promise<void> {
    const token = ++this.#token;
    const pathname = normalizePath(loc.pathname);
    const { route, params } = matchRoute(pathname);
    const prev = this.current;
    if (prev && mode !== 'initial' && this.#scroller && !prev.route.persistent) {
      this.#positions.set(prev.key, this.#scroller.scrollTop);
    }

    const slow = setTimeout(() => {
      if (token === this.#token) this.pending = true;
    }, 120);
    let component: PageComponent;
    try {
      component = (await loadRoute(route)).default;
    } catch (err) {
      clearTimeout(slow);
      if (token === this.#token) {
        this.pending = false;
        this.#chunkFailed(`${pathname}${loc.search}${loc.hash}`, err);
      }
      return;
    }
    clearTimeout(slow);
    if (token !== this.#token) return; // superseded by a newer navigation
    this.pending = false;

    const href = `${pathname}${loc.search}${loc.hash}`;
    if (mode === 'push') {
      this.#index++;
      history.pushState({ gnome: 1, key, idx: this.#index } satisfies HistoryState, '', href);
      this.entries = { index: this.#index, top: this.#index };
    } else if (mode === 'replace' || (mode === 'initial' && pathname !== loc.pathname)) {
      // Also canonicalizes the address of a cold load ("/games/" or "//games" → "/games").
      history.replaceState({ gnome: 1, key, idx: this.#index } satisfies HistoryState, '', href);
    }

    if (route.persistent && !this.persistent.some((p) => p.route.id === route.id)) {
      this.persistent = [...this.persistent, { route, component }];
    }

    const next: RouteState = {
      route,
      params,
      query: new URLSearchParams(loc.search),
      pathname,
      search: loc.search,
      hash: loc.hash,
      key,
      pageKey: `${route.id}:${pathname}`,
      component: route.persistent ? null : component,
    };

    const pageChanges = !prev || prev.pageKey !== next.pageKey;
    const animate = mode !== 'initial' && pageChanges && getMotionScale() > 0 && document.visibilityState === 'visible';
    const prevActive = document.activeElement;

    if (animate && supportsViewTransitions()) {
      this.transition = 'view-transition';
      try {
        const vt = document.startViewTransition(() => {
          flushSync(() => {
            this.current = next;
          });
          this.#restoreScroll(next, mode);
        });
        // A navigation during the animation skips this transition: `ready` (and, if the update failed, `finished`)
        // then reject. Nothing waits for them, so without a handler each quick click surfaced as an unhandled error.
        vt.ready.catch(() => undefined);
        vt.finished.catch(() => undefined);
        await vt.updateCallbackDone;
      } catch {
        // The transition was skipped (e.g. another one started); state is already applied.
        if (this.current !== next) this.current = next;
      }
    } else {
      this.transition = animate ? 'crossfade' : 'none';
      this.current = next;
      await tick();
      this.#restoreScroll(next, mode);
    }

    const title = routeTitle(route, params);
    document.title = route.id === 'home' ? 'GNOME' : `${title} · GNOME`;
    if (mode !== 'initial') {
      this.#manageFocus(prevActive);
      announce(`${title}`);
    }
    appEvents.emit('route:changed', { path: pathname, routeId: route.id, params });
  }

  #restoreScroll(next: RouteState, mode: Mode): void {
    const el = this.#scroller;
    if (!el || next.route.persistent) return;
    if (next.hash && this.#scrollToHash(next.hash)) return;
    const saved = mode === 'pop' || mode === 'initial' ? this.#positions.get(next.key) : undefined;
    if (!saved) {
      el.scrollTop = 0;
      return;
    }
    // Content may still be loading: retry until the position is reachable (max ~1 s).
    const started = performance.now();
    const attempt = (): void => {
      el.scrollTop = saved;
      if (Math.abs(el.scrollTop - saved) > 2 && performance.now() - started < 1000 && this.current === next) {
        requestAnimationFrame(attempt);
      }
    };
    attempt();
  }

  #scrollToHash(hash: string): boolean {
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* use raw */
    }
    const target = id ? document.getElementById(id) : null;
    if (!target) return false;
    target.scrollIntoView({ block: 'start' });
    return true;
  }

  #manageFocus(prevActive: Element | null): void {
    const active = document.activeElement;
    // Focus left in a layer that was just hidden (the browser view becomes inert when another page is shown) is
    // lost too: the browser drops it at the next frame.
    const lost =
      !active ||
      active === document.body ||
      !active.isConnected ||
      !!active.closest('[inert], [hidden]') ||
      (prevActive !== null && !prevActive.isConnected);
    if (!lost) return;
    // Persistent pages (the browser) render in their own layer; the page scroller is hidden while they are shown.
    const route = this.current?.route;
    const root = route?.persistent ? (this.#layers.get(route.id) ?? null) : this.#scroller;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('h1') ?? root;
    // A heading (or layer) without a tabindex cannot take focus: make it programmatically focusable.
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  #onPop(ev: PopStateEvent): void {
    let state = ev.state as unknown;
    if (!isHistoryState(state)) {
      state = { gnome: 1, key: newKey(), idx: this.#index + 1 } satisfies HistoryState;
      history.replaceState(state, '', location.href);
    }
    const s = state as HistoryState;
    const prevIndex = this.#index;
    this.#index = s.idx;
    this.entries = { index: s.idx, top: Math.max(this.entries.top, s.idx) };
    this.direction = s.idx < prevIndex ? 'back' : 'forward';
    const cur = this.current;
    const loc = currentLocation();
    if (cur && normalizePath(loc.pathname) === cur.pathname && loc.search === cur.search) {
      if (this.#scroller) this.#positions.set(cur.key, this.#scroller.scrollTop);
      this.current = { ...cur, hash: loc.hash, key: s.key };
      if (!loc.hash || !this.#scrollToHash(loc.hash)) {
        const y = this.#positions.get(s.key);
        if (y !== undefined && this.#scroller) this.#scroller.scrollTop = y;
      }
      return;
    }
    void this.#go(loc, 'pop', s.key);
  }

  #onClick(ev: MouseEvent): void {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
    if (!a || !a.hasAttribute('href')) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.dataset.router === 'off') return;
    if ((a.getAttribute('rel') ?? '').split(/\s+/).includes('external')) return;
    let url: URL;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin || isServerPath(url.pathname)) return;
    ev.preventDefault();
    void this.navigate(`${url.pathname}${url.search}${url.hash}`);
  }

  #onHover(ev: Event): void {
    if (!settings.value.performance.prefetchPages) return;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (conn?.saveData) return;
    const target = ev.target as Element | null;
    const a = target?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement)) return;
    try {
      const url = new URL(a.href, location.href);
      if (url.origin === location.origin && !isServerPath(url.pathname)) this.prefetch(url.pathname);
    } catch {
      /* ignore invalid hrefs */
    }
  }

  #chunkFailed(href: string, err: unknown): void {
    console.error('[gnome] page failed to load', err);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast.error('You are offline', { description: 'This page could not be loaded. Check your connection.' });
      return;
    }
    // After a new deployment old chunk names disappear: reload once to pick up the new build.
    try {
      if (sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== href) {
        sessionStorage.setItem(CHUNK_RELOAD_FLAG, href);
        location.assign(href);
        return;
      }
    } catch {
      /* storage unavailable: fall through to the toast */
    }
    toast.error('This page could not be loaded', {
      description: err instanceof Error ? err.message : undefined,
      actions: [{ label: 'Retry', onClick: () => this.navigate(href) }],
    });
  }

  #loadPositions(): void {
    try {
      const raw = sessionStorage.getItem(SCROLL_STORAGE);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') this.#positions.set(k, v);
    } catch {
      /* ignore */
    }
  }

  #savePositions(): void {
    if (this.current && this.#scroller && !this.current.route.persistent) {
      this.#positions.set(this.current.key, this.#scroller.scrollTop);
    }
    try {
      const entries = [...this.#positions.entries()].slice(-50);
      sessionStorage.setItem(SCROLL_STORAGE, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* ignore */
    }
  }
}

export const router = new Router();

/** Convenience for components and features. */
export function navigate(to: string, opts?: NavigateOptions): Promise<void> {
  return router.navigate(to, opts);
}
