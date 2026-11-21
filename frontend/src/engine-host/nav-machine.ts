/**
 * The navigation state machine of one tab (ENGINE-PROTOCOL §6.1, §6.2, §6.4, §6.9), without any DOM: tabs.ts feeds it
 * what the frames, the engines' hooks and the timers report, and it decides which events go to the app, how the
 * tab's back/forward list changes, when a navigation fails, and when the controlled fallback retries on Ultraviolet.
 *
 * A navigation starts either from GNOME (tab.create/navigate/go/reload) or in the page (Scramjet's request hook, the
 * Navigation API's `navigate` event of the tab's top document, `beforeunload` where that API is missing). It ends
 * with a commit and a load, an error, a download, a 204/205 answer, or tab.stop. Every load of the tab frame is
 * classified, also those no start signal announced.
 */
import { LIMITS, TIMEOUTS, fitInt, fitText, sanitizeText } from '../shared/engine-protocol';
import type {
  CommitKind,
  EngineId,
  EventMap,
  FailureSignal,
  FallbackState,
  HistoryHandling,
  NavId,
  TabId,
  TabState,
} from '../shared/engine-protocol';
import type { DownloadDisposition } from '../shared/proxy-origin';
import { classifyFailure } from './classify';
import type { Clock, Send } from './coalesce';
import { TabHistory, reportUrl } from './history';

export type NavOrigin = 'gnome' | 'page';
export type NavPhase = 'pending' | 'committed' | 'loaded' | 'failed' | 'download' | 'ended';

export interface Nav {
  id: NavId;
  /** The real destination; null for an Ultraviolet navigation announced only by `beforeunload`. */
  url: string | null;
  engine: EngineId;
  origin: NavOrigin;
  kind: Exclude<CommitKind, 'same-document'>;
  handling: HistoryHandling;
  /** The Navigation API told us the type (push/replace/reload/traverse); else the commit decides from timing. */
  typeKnown: boolean;
  /** tab.go: the entry it loads. */
  targetIndex: number | null;
  /** The first load of a restored tab: its commit replaces entries[index]. */
  restore: boolean;
  /** The automatic Ultraviolet retry of a failed Scramjet navigation (same navId). */
  auto: boolean;
  /** The engine was chosen by the command or by the settings (no automatic fallback). */
  forced: boolean;
  method: string;
  startedAt: number;
  phase: NavPhase;
  /** The response had a type browsers do not render: the timeout and the fallback are off (§6.9). */
  unrendered: boolean;
  timer: unknown;
  downloadTimer: unknown;
}

export interface NavEnv {
  now(): number;
  clock: Clock;
  emit: Send;
  nextNavId(): NavId;
  engineReady(engine: EngineId): boolean;
  autoFallback(): boolean;
  transportOffline(engine: EngineId): boolean;
  online(): boolean;
  /** Starts the controlled fallback for `nav` (cookie copy, then retryOnUltraviolet). */
  startFallback(nav: Nav): void;
  /** The UV in-page timeout rule: the tab frame still shows the document it showed when `nav` started. */
  documentUnchanged(nav: Nav): boolean;
  /** An `unrendered-type` navigation committed no document in time: report it as a download now. */
  confirmDownload(nav: Nav): void;
  /** An `unrendered-type` navigation committed after all (the browser rendered it): forget its pending download. */
  cancelDownload(nav: Nav): void;
  /** WAVE-B3 D5: a `tab.loading` event carried this (fitted) URL. */
  announced?(url: string): void;
}

/** WAVE-B3 C3: at most this many `tab.loading.url` announcements per tab per second (beyond: no `url`). */
export const ANNOUNCE_LIMIT = { perSecond: 2 } as const;

export interface GnomeLoad {
  url: string;
  engine: EngineId;
  kind: Exclude<CommitKind, 'same-document'>;
  forced: boolean;
  targetIndex?: number;
  restore?: boolean;
  auto?: boolean;
  /** The fallback retry keeps the failed navigation's id. */
  navId?: NavId;
}

export interface PageStart {
  url: string | null;
  engine: EngineId;
  /** From the Navigation API's navigationType; omitted when unknown (request hook, beforeunload). */
  type?: 'push' | 'replace' | 'reload' | 'traverse';
  method?: string;
}

/** PerformanceNavigationTiming.type of a committed document (used when no navigationType was seen). */
export type TimingType = 'navigate' | 'reload' | 'back_forward' | 'prerender' | null;

const SAME_DOC_NAV_ID = null;

export class TabNavigator {
  readonly tabId: TabId;
  readonly history = new TabHistory();
  readonly #env: NavEnv;
  nav: Nav | null = null;
  /** The committed document: its real URL and engine. */
  current: { url: string; engine: EngineId } | null = null;
  title: string | null = null;
  lastError: EventMap['tab.error'] | null = null;
  /** Automatic fallbacks since the last user navigation (at most one per navigation). */
  attempts = 0;
  /**
   * The last GNOME-initiated load forced its engine (the command's or the settings' choice): navigations the page
   * starts inherit it, so a forced engine never falls back automatically (ENGINE-PROTOCOL §6.2).
   */
  forcedEngine = false;

  constructor(tabId: TabId, env: NavEnv) {
    this.tabId = tabId;
    this.#env = env;
  }

  get pending(): boolean {
    return this.nav?.phase === 'pending';
  }

  /** A navigation GNOME starts (the caller loads the frame right after). */
  beginGnome(load: GnomeLoad): Nav {
    if (!load.auto && load.kind === 'navigate') this.attempts = 0;
    if (!load.auto) this.forcedEngine = load.forced;
    return this.#begin({
      id: load.navId ?? this.#env.nextNavId(),
      url: load.url,
      engine: load.engine,
      origin: 'gnome',
      kind: load.kind,
      handling: load.kind === 'reload' ? 'replace' : load.kind === 'history' ? 'traverse' : load.restore ? 'replace' : 'push',
      typeKnown: true,
      targetIndex: load.targetIndex ?? null,
      restore: !!load.restore,
      auto: !!load.auto,
      forced: load.forced,
    });
  }

  /**
   * A navigation the page started. While a navigation is pending (a redirect hop, the engine host's own load seen by
   * the page's `navigate` event, a second signal for the same navigation) only the method is updated.
   */
  beginPage(start: PageStart): Nav {
    const nav = this.nav;
    if (nav && nav.phase === 'pending') {
      if (start.method) nav.method = start.method.toUpperCase();
      if (nav.url === null && start.url !== null) nav.url = start.url;
      return nav;
    }
    const type = start.type;
    const created = this.#begin({
      id: this.#env.nextNavId(),
      url: start.url,
      engine: start.engine,
      origin: 'page',
      kind: type === 'reload' ? 'reload' : type === 'traverse' ? 'history' : 'navigate',
      handling: type === 'reload' || type === 'replace' ? 'replace' : type === 'traverse' ? 'traverse' : 'push',
      typeKnown: type !== undefined,
      targetIndex: null,
      restore: false,
      auto: false,
      forced: this.forcedEngine,
    });
    if (start.method) created.method = start.method.toUpperCase();
    return created;
  }

  #begin(init: Omit<Nav, 'method' | 'startedAt' | 'phase' | 'unrendered' | 'timer' | 'downloadTimer'>): Nav {
    this.#clearTimers(this.nav);
    const nav: Nav = {
      ...init,
      method: 'GET',
      startedAt: this.#env.now(),
      phase: 'pending',
      unrendered: false,
      timer: null,
      downloadTimer: null,
    };
    nav.timer = this.#env.clock.setTimeout(() => this.#onTimeout(nav), TIMEOUTS.navigationMs);
    this.nav = nav;
    this.lastError = null;
    if (nav.origin !== 'gnome' || nav.url === null || !this.announce(nav.url)) this.#env.emit('tab.loading', { tabId: this.tabId, loading: true });
    return nav;
  }

  #announced: number[] = [];

  /**
   * `tab.loading {loading: true, url}` for a navigation whose destination is known (WAVE-B3 C3, D5): GNOME-initiated
   * loads, a Scramjet tab request, a page's `navigate` event that was not cancelled. At most ANNOUNCE_LIMIT per second;
   * false when it went out without being announced (the URL does not fit, or the throttle said no).
   */
  announce(url: string): boolean {
    const reported = reportUrl(url);
    if (reported === null) return false;
    const now = this.#env.now();
    this.#announced = this.#announced.filter((t) => now - t < 1000);
    if (this.#announced.length >= ANNOUNCE_LIMIT.perSecond) return false;
    this.#announced.push(now);
    this.#env.emit('tab.loading', { tabId: this.tabId, loading: true, url: reported });
    this.#env.announced?.(reported);
    return true;
  }

  setMethod(method: string): void {
    if (this.nav?.phase === 'pending') this.nav.method = method.toUpperCase();
  }

  /**
   * A new document became the tab's top document (Scramjet `init.post`, the UV document-start hook, or a frame load
   * of a document no hook reached). `timing` is its PerformanceNavigationTiming.type.
   */
  commitDocument(url: string, engine: EngineId, timing: TimingType = null): void {
    let nav = this.nav;
    if (nav && nav.phase === 'failed' && nav.engine === engine && (nav.url === null || nav.url === url)) {
      return; // the substitute page of a failed navigation, or its UV error page: the app shows its overlay
    }
    if (!nav || nav.phase !== 'pending') {
      // A navigation no start signal announced (e.g. the browser's own Back button moved the frame).
      nav = this.beginPage({ url, engine, type: timingToType(timing, this.history, url) });
    } else if (nav.engine !== engine) {
      return; // a document of the frame this navigation replaced
    }
    if (nav.origin === 'page' && !nav.typeKnown) {
      const t = timingToType(timing, this.history, url);
      if (t === 'reload') Object.assign(nav, { kind: 'reload', handling: 'replace' });
      else if (t === 'traverse') Object.assign(nav, { kind: 'history', handling: 'traverse' });
    }
    if (nav.url === null) nav.url = url;
    let kind: Exclude<CommitKind, 'same-document'> = nav.kind;
    let handling: HistoryHandling = nav.handling;
    let index: number | undefined;
    if (kind === 'history') {
      index = nav.targetIndex ?? this.history.findTraversal(url) ?? undefined;
      if (index === undefined) {
        kind = 'navigate';
        handling = 'push';
      }
    } else if (kind === 'reload' && this.history.length === 0) {
      kind = 'navigate';
      handling = 'push';
    }
    const reported = reportUrl(url) ?? (nav.url !== null ? reportUrl(nav.url) : null);
    this.#clearTimers(nav);
    if (nav.unrendered) this.#env.cancelDownload(nav);
    nav.phase = 'committed';
    if (reported === null) {
      // A document we cannot name (not http(s)): nothing to commit, but the navigation is over.
      this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
      nav.phase = 'ended';
      return;
    }
    this.history.apply(handling, url, index);
    this.current = { url, engine };
    this.lastError = null;
    const pos = this.history.position();
    this.#env.emit('tab.committed', {
      tabId: this.tabId,
      navId: nav.id,
      url: reported,
      engine,
      kind,
      historyHandling: handling,
      index: pos.index,
      length: pos.length,
      canGoBack: pos.canGoBack,
      canGoForward: pos.canGoForward,
      ms: fitInt(this.#env.now() - nav.startedAt, 0, LIMITS.maxDurationMs),
    });
  }

  /**
   * Same-document commits refused because their URL has another origin than the committed document (WAVE-B3 F4:
   * Ultraviolet's history hook does not check the origin), so a page cannot move its tab's address, policy, rule
   * exposure or service-worker context with pushState.
   */
  crossOriginSameDocument = 0;

  /** A same-document commit of the top document (pushState, replaceState, fragment, popstate). */
  sameDocument(url: string, handling: HistoryHandling): void {
    if (!this.current) return;
    const reported = reportUrl(url);
    if (reported === null) return;
    if (!sameOrigin(url, this.current.url)) {
      this.crossOriginSameDocument++;
      return;
    }
    let h = handling;
    let index: number | undefined;
    if (h === 'replace' && url === this.history.current) return;
    if (h === 'traverse') {
      const i = this.history.findTraversal(url);
      if (i === null) h = 'replace';
      else index = i;
      if (i === null && url === this.history.current) return;
    }
    this.history.apply(h, url, index);
    this.current = { url, engine: this.current.engine };
    const pos = this.history.position();
    this.#env.emit('tab.committed', {
      tabId: this.tabId,
      navId: SAME_DOC_NAV_ID,
      url: reported,
      engine: this.current.engine,
      kind: 'same-document',
      historyHandling: h,
      index: pos.index,
      length: pos.length,
      canGoBack: pos.canGoBack,
      canGoForward: pos.canGoForward,
      ms: null,
    });
  }

  /** The tab frame fired `load` with a readable proxy-origin document that is not an engine error page. */
  documentLoaded(url: string | null, engine: EngineId): void {
    let nav = this.nav;
    if (nav && nav.phase === 'failed') return;
    if (nav && nav.phase === 'pending') {
      if (url === null) return;
      this.commitDocument(url, engine);
      nav = this.nav;
    } else if ((!nav || nav.phase !== 'committed') && url !== null && url !== this.history.current) {
      // A document whose start no hook saw (e.g. a non-HTML document opened from the page).
      this.beginPage({ url, engine });
      this.commitDocument(url, engine);
      nav = this.nav;
    }
    if (!nav || nav.phase !== 'committed' || !this.current) return;
    nav.phase = 'loaded';
    this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
    this.#env.emit('tab.loaded', {
      tabId: this.tabId,
      navId: nav.id,
      url: reportUrl(this.current.url) ?? (reportUrl(nav.url ?? '') as string),
      engine: this.current.engine,
      ms: fitInt(this.#env.now() - nav.startedAt, 0, LIMITS.maxDurationMs),
    });
  }

  /** The tab's top-document response (Scramjet's per-tab plugin sees the status): 204/205 keep the document. */
  responseStatus(status: number): void {
    const nav = this.nav;
    if (!nav || nav.phase !== 'pending') return;
    if (status !== 204 && status !== 205) return;
    this.#end(nav);
  }

  /**
   * The navigation's response is a download (downloadDisposition()). `attachment` ends it now; `unrendered-type` stops
   * the timer and the fallback and waits TIMEOUTS.downloadCommitMs for a commit. Returns whether a pending navigation
   * took it (the caller reports download.started now for `attachment`).
   */
  downloadResponse(disposition: DownloadDisposition): boolean {
    const nav = this.nav;
    if (!nav || nav.phase !== 'pending') return false;
    this.#env.clock.clearTimeout(nav.timer);
    nav.timer = null;
    if (disposition === 'attachment') {
      nav.phase = 'download';
      this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
      return true;
    }
    nav.unrendered = true;
    nav.downloadTimer = this.#env.clock.setTimeout(() => {
      if (this.nav !== nav || nav.phase !== 'pending') return;
      nav.phase = 'download';
      this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
      this.#env.confirmDownload(nav);
    }, TIMEOUTS.downloadCommitMs);
    return true;
  }

  /** The tab frame left the proxy origin: a final engine error, also without a navigation in progress. */
  frameLeftProxy(): void {
    const nav = this.nav;
    if (nav && nav.phase === 'pending') {
      this.fail('frame-left-proxy', 'the page left the proxy');
      return;
    }
    this.#emitError(nav, null, 'frame-left-proxy', 'the page left the proxy', this.current?.engine ?? nav?.engine ?? 'scramjet');
  }

  /** Ultraviolet's error page loaded in the tab frame: GNOME's overlay instead, also for in-page navigations. */
  uvErrorPage(trace: string, url: string | null): void {
    const nav = this.nav;
    if (nav && nav.phase === 'pending') {
      this.fail('uv-error-page', trace);
      return;
    }
    if (nav && nav.phase === 'failed') return;
    const started = this.beginPage({ url, engine: 'ultraviolet' });
    this.fail('uv-error-page', trace, started);
  }

  /** tab.stop: ends the navigation; the document (if any) stays. */
  stop(): void {
    const nav = this.nav;
    if (!nav || nav.phase !== 'pending') {
      this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
      return;
    }
    this.#end(nav);
  }

  /** An engine-level failure of the pending navigation (error hook, timeout, UV error page, no engine ready). */
  fail(signal: FailureSignal, detail: string, which: Nav | null = this.nav): void {
    const nav = which;
    if (!nav || nav !== this.nav || nav.phase !== 'pending') return;
    this.#clearTimers(nav);
    nav.phase = 'failed';
    const idempotent = nav.method === 'GET' || nav.method === 'HEAD';
    const canFallback =
      (signal === 'error-hook' || signal === 'timeout') &&
      nav.engine === 'scramjet' &&
      !nav.forced &&
      !nav.auto &&
      !nav.unrendered &&
      idempotent &&
      nav.url !== null &&
      this.attempts < 1 &&
      this.#env.autoFallback() &&
      this.#env.engineReady('ultraviolet');
    if (canFallback) {
      this.attempts++;
      this.#env.emit('tab.engineSwitched', {
        tabId: this.tabId,
        navId: nav.id,
        from: 'scramjet',
        to: 'ultraviolet',
        reason: signal,
        latencyMs: fitInt(this.#env.now() - nav.startedAt, 0, LIMITS.maxDurationMs),
      });
      this.#env.startFallback(nav);
      return;
    }
    // A block's detail is exactly `blocked:<category>` (the app maps it to its own text, WAVE-B3 §4.4).
    const why = idempotent || signal === 'blocked' ? detail : `${detail} (not sent again automatically: ${nav.method} navigation)`;
    this.#emitError(nav, nav.id, signal, why, nav.engine);
  }

  /** The fallback could not start the retry (Ultraviolet failed in the meantime). */
  fallbackFailed(nav: Nav, detail: string): void {
    if (this.nav !== nav) return;
    this.#emitError(nav, nav.id, 'fallback-failed', detail, 'ultraviolet', 'attempted');
  }

  #emitError(
    nav: Nav | null,
    navId: NavId | null,
    signal: FailureSignal,
    detail: string,
    engine: EngineId,
    forceFallback?: FallbackState,
  ): void {
    const other: EngineId = engine === 'scramjet' ? 'ultraviolet' : 'scramjet';
    const fallback: FallbackState =
      forceFallback ??
      (nav?.auto ? 'attempted' : signal !== 'frame-left-proxy' && signal !== 'blocked' && this.#env.engineReady(other) ? 'available' : 'none');
    const kind = classifyFailure(signal, detail, { offline: !this.#env.online(), transportOffline: this.#env.transportOffline(engine) });
    const url = nav?.url ?? this.current?.url ?? null;
    const error: EventMap['tab.error'] = {
      tabId: this.tabId,
      navId,
      url: url === null ? null : reportUrl(url),
      kind,
      signal,
      detail: fitText(sanitizeText(detail), LIMITS.maxDetailLength),
      engine,
      fallback,
      idempotent: nav ? nav.method === 'GET' || nav.method === 'HEAD' : true,
      latencyMs: nav ? fitInt(this.#env.now() - nav.startedAt, 0, LIMITS.maxDurationMs) : 0,
    };
    this.lastError = error;
    this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
    this.#env.emit('tab.error', error);
  }

  #end(nav: Nav): void {
    this.#clearTimers(nav);
    nav.phase = 'ended';
    this.#env.emit('tab.loading', { tabId: this.tabId, loading: false });
  }

  #onTimeout(nav: Nav): void {
    if (this.nav !== nav || nav.phase !== 'pending') return;
    nav.timer = null;
    if (nav.origin === 'page' && nav.engine === 'ultraviolet' && this.current && this.#env.documentUnchanged(nav)) {
      // UV cannot show us the answer: a 204/205 or a cancelled navigation keeps the document (ENGINE-PROTOCOL §6.1).
      this.#end(nav);
      return;
    }
    this.fail('timeout', `no document within ${TIMEOUTS.navigationMs / 1000} s`, nav);
  }

  #clearTimers(nav: Nav | null): void {
    if (!nav) return;
    if (nav.timer !== null) this.#env.clock.clearTimeout(nav.timer);
    if (nav.downloadTimer !== null) this.#env.clock.clearTimeout(nav.downloadTimer);
    nav.timer = null;
    nav.downloadTimer = null;
  }

  dispose(): void {
    this.#clearTimers(this.nav);
  }

  /** tab.state (core): what this host knows about the tab. */
  state(): TabState {
    const { entries, index } = this.history.reported();
    const nav = this.nav;
    return {
      entries,
      index,
      title: this.title,
      loading: nav?.phase === 'pending',
      navId: nav?.id ?? null,
      engine: nav?.phase === 'pending' ? nav.engine : (this.current?.engine ?? nav?.engine ?? null),
      error: this.lastError,
    };
  }
}

/** Without a navigationType: a reload, a traversal onto a matching entry, or a new entry. */
function timingToType(timing: TimingType, history: TabHistory, url: string): PageStart['type'] {
  if (timing === 'reload') return 'reload';
  if (timing === 'back_forward' && history.findTraversal(url) !== null) return 'traverse';
  return undefined;
}

/** Whether two real URLs have the same origin (an unparsable one never does). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
