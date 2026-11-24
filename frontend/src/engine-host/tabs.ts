/**
 * Tabs (ENGINE-PROTOCOL §4, §6.1–§6.4, §6.9, §6.14): one iframe per tab inside `#tabs`, created when the tab first
 * loads a page and re-created when it changes engine; its `allow` attribute is written from the command's resolved
 * permissions (tabFrameAllow) before every GNOME-initiated load; GNOME-initiated loads replace the frame's current
 * entry (`location.replace`, or `src` on a fresh frame), so they never add entries to the app tab's joint session
 * history. Each tab's navigation state lives in a TabNavigator (nav-machine.ts); this module feeds it from the frame
 * loads, the Scramjet plugin hooks and the per-document observers (observe/*), and runs the controlled fallback.
 */
import { LIMITS, TIMEOUTS, fitText, sanitizeText } from '../shared/engine-protocol';
import { BLOCK_CATEGORIES } from '../shared/engine-protocol';
import type {
  BlockCategory,
  CommandPayload,
  CommandResult,
  EngineId,
  EnginePermissionSet,
  EventMap,
  HistoryHandling,
  NavStart,
  TabId,
  TabState,
} from '../shared/engine-protocol';
import { safeVerdict } from '../shared/engine-hooks';
import type { HeaderChanges, RedirectResource, RequestInfo, ResponseHeaders } from '../shared/engine-hooks';
import { PROXY_PATHS, bareMime, downloadDisposition } from '../shared/proxy-origin';
import type { SwSignal } from '../shared/proxy-origin';
import type { HostContext } from './context';
import { scramjetCookiesForUv, writeUvCookies } from './cookies';
import { FRAME_RESTRICTION_CSP, applyProxiedCsp, scriptsUnrewritten } from './csp';
import { DownloadTracker, namedDisposition } from './downloads';
import { tabFrameAllowList } from './frame-allow';
import { NoEngineError } from './engines/manager';
import { SCRAMJET_CLIENT, vendor } from './engines/vendor';
import { CALL_ORIGINAL, RETURN, THROW, arg, pageKit } from './realm';
import type {
  FrameInitCtx,
  ManagedPluginLike,
  ScramjetErrorCtx,
  ScramjetErrorProps,
  ScramjetFrameLike,
  ScramjetPreresponseProps,
  ScramjetRequestCtx,
  ScramjetRequestProps,
  ScramjetResponseProps,
} from './engines/vendor';
import { engineHooks } from './hooks';
import { TabNavigator } from './nav-machine';
import type { Nav } from './nav-machine';
import { installCommitObservers, timingType } from './observe/commits';
import { installContextMenu } from './observe/context-menu';
import { installHistoryUrlFix } from './observe/history-url';
import { compileCombos, installKeyForwarding } from './observe/keys';
import type { CompiledCombos } from './observe/keys';
import { faviconDataUrl, iconLinkHref, installTitleObserver } from './observe/title';
import { installPopupRouting } from './popups';
import { failure } from './protocol-server';
import { realClock } from './coalesce';
import { TabRequestClaims, tabShaped } from './sj-requests';
import { guardRealmsDeep, hardenUvRealm, killWebRtc, killWebRtcDeep, srcdocHookTag } from './webrtc';

export class Tab {
  readonly id: TabId;
  readonly nav: TabNavigator;
  iframe: HTMLIFrameElement | null = null;
  engine: EngineId | null = null;
  sjFrame: ScramjetFrameLike | null = null;
  active = false;
  zoom = 1;
  permissions: EnginePermissionSet;
  fullscreen = false;
  /** The tab frame's document when the pending navigation started (the UV in-page timeout rule). */
  docAtNavStart: Document | null = null;
  /** The tab's top document and window (set at document start). */
  topDoc: Document | null = null;
  topWin: Window | null = null;
  /**
   * WAVE-B3 §4.4: the URL of the tab's latest own Scramjet request (every hop), until the top document commits, fails
   * or stops: requests of that document before its commit (the preload scanner) belong to the new page.
   */
  pendingTop: string | null = null;
  /**
   * The navigation (TabNavigator.nav) whose block counts the tab counts now: they start again at the first request of
   * each new navigation (#startCounts), so the parser's early requests count for the page they belong to.
   */
  countsNav: object | null = null;
  initFailedNotified = false;
  /** Raw icon href last fetched (dedupe). */
  iconHref: string | null = null;
  closed = false;
  /** Scramjet: which document requests are this tab frame's own navigations (nested frames' look the same). */
  readonly sjClaims = new TabRequestClaims();

  constructor(id: TabId, nav: TabNavigator, permissions: EnginePermissionSet, zoom: number) {
    this.id = id;
    this.nav = nav;
    this.permissions = permissions;
    this.zoom = zoom;
  }
}

export interface TabManagerDeps {
  ctx: HostContext;
  container: HTMLElement;
  downloads: DownloadTracker;
  /** Probe the engine's transport after a failure that may be the transport (TransportManager.reportFailure). */
  reportFailure(engine: EngineId, detail: string): void;
  /** Transport state of an engine side (`offline` means a navigation failure is the gateway's). */
  transportOffline(engine: EngineId): boolean;
  /** Fault injection of e2e builds (`test.setFault`): 'sj-throw-marker' fails Scramjet requests with that marker. */
  fault(): string | null;
}

export class TabManager {
  readonly tabs = new Map<TabId, Tab>();
  readonly #d: TabManagerDeps;
  readonly #attached = new WeakSet<Document>();
  /** Scramjet requests (the request objects its hooks share) claimed as a tab frame's own navigation. */
  readonly #ownRequests = new WeakSet<object>();
  #navSeq = 0;
  #combos: CompiledCombos = { apple: false, list: [] };
  /** The opener (real URL) of a navigation a page asked for (tab.create start.opener), kept for its Ultraviolet retry. */
  readonly #navOpener = new WeakMap<Nav, string>();
  /**
   * UV documents' proxied URLs without the fragment (as at their document start, and the tab-top navigations this host
   * announced to the SW, with their navigation) → their tab, for uv-blocked (LRU, WAVE-B3 §4.4). The SW counts a
   * request of a document under that document's proxied URL, without the fragment (sw/blocker.ts).
   */
  readonly #uvDocs = new Map<string, { tab: TabId; nav: object | null }>();

  constructor(deps: TabManagerDeps) {
    this.#d = deps;
    const N = deps.ctx.N;
    N.on.call(document, 'fullscreenchange', (() => this.#onFullscreen()) as (ev: never) => void);
  }

  get ctx(): HostContext {
    return this.#d.ctx;
  }

  /** Re-reads the shortcut combos (each settings snapshot). */
  setCombos(combos: readonly string[], apple: boolean): void {
    this.#combos = compileCombos(combos, apple);
  }

  liveCounts(): { live: number; scramjet: number; ultraviolet: number } {
    let scramjet = 0;
    let ultraviolet = 0;
    for (const t of this.tabs.values()) {
      if (t.engine === 'scramjet') scramjet++;
      else if (t.engine === 'ultraviolet') ultraviolet++;
    }
    return { live: this.tabs.size, scramjet, ultraviolet };
  }

  get(tabId: TabId): Tab {
    const t = this.tabs.get(tabId);
    if (!t) throw failure('no_tab', `no tab ${tabId}`);
    return t;
  }

  // ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

  create(p: CommandPayload<'tab.create'>): CommandResult<'tab.create'> {
    if (this.tabs.has(p.tabId)) throw failure('tab_exists', `tab ${p.tabId} exists`);
    if (this.tabs.size >= LIMITS.maxLiveTabs) throw failure('too_many_tabs', `at most ${LIMITS.maxLiveTabs} live tabs per engine host`);
    const tab = new Tab(p.tabId, new TabNavigator(p.tabId, this.#navEnv(p.tabId)), p.permissions, p.zoom);
    this.tabs.set(tab.id, tab);
    if (p.active) this.activate(tab.id);
    try {
      if (p.start.kind === 'blank') return { navId: null, engine: null };
      if (p.start.kind === 'url') return this.navigate(tab, p.start.url, p.engine, p.permissions, p.start.opener ?? null);
      tab.nav.history.restore(p.start.entries, p.start.index);
      const url = tab.nav.history.current ?? p.start.entries[p.start.index] ?? p.start.entries[0];
      if (!url) return { navId: null, engine: null };
      return this.#load(tab, url, p.engine, p.permissions, { kind: 'navigate', restore: true });
    } catch (err) {
      // No engine could start the first load: the tab is not created (the app may try again with the same id).
      if (this.tabs.get(tab.id) === tab) this.close(tab.id);
      throw err;
    }
  }

  close(tabId: TabId): void {
    const tab = this.get(tabId);
    tab.closed = true;
    this.ctx.blocking.counts.forget(tab.id);
    tab.nav.dispose();
    this.#removeFrame(tab);
    this.tabs.delete(tab.id);
  }

  activate(tabId: TabId | null): void {
    if (tabId !== null) this.get(tabId);
    for (const t of this.tabs.values()) {
      t.active = t.id === tabId;
      if (t.iframe) t.iframe.hidden = !t.active;
    }
  }

  /**
   * `opener`: the real URL of the page that asked for this tab (tab.create's `start.opener`): the load is that page's
   * navigation (its initiator), not GNOME's own.
   */
  navigate(tab: Tab, url: string, engine: EngineId | null, permissions: EnginePermissionSet, opener: string | null = null): NavStart {
    return this.#load(tab, url, engine, permissions, { kind: 'navigate', opener });
  }

  go(tab: Tab, delta: number, permissions: EnginePermissionSet): NavStart {
    const target = tab.nav.history.index + delta;
    const url = tab.nav.history.at(target);
    if (url === null || tab.nav.history.length === 0) throw failure('no_entry', 'no such back/forward entry');
    return this.#load(tab, url, null, permissions, { kind: 'history', targetIndex: target, keepEngine: true });
  }

  reload(tab: Tab, permissions: EnginePermissionSet): NavStart {
    const url = tab.nav.current?.url ?? tab.nav.history.current;
    if (!url) throw failure('no_document', 'the tab has no page');
    return this.#load(tab, url, null, permissions, { kind: 'reload', keepEngine: true });
  }

  stop(tab: Tab): void {
    try {
      const w = tab.iframe ? this.ctx.N.contentWindow.call(tab.iframe) : null;
      if (w) this.ctx.N.stopWindow.call(w);
    } catch {
      /* escaped */
    }
    tab.sjClaims.clear();
    tab.pendingTop = null;
    tab.nav.stop();
  }

  state(tab: Tab): TabState {
    return tab.nav.state();
  }

  zoom(tab: Tab, factor: number): number {
    tab.zoom = factor;
    if (tab.iframe) applyZoom(tab.iframe, factor);
    return factor;
  }

  // ── Loads ──────────────────────────────────────────────────────────────────────────────────────────────────────

  #load(
    tab: Tab,
    url: string,
    commandEngine: EngineId | null,
    permissions: EnginePermissionSet,
    opts: { kind: 'navigate' | 'reload' | 'history'; targetIndex?: number; restore?: boolean; keepEngine?: boolean; opener?: string | null },
  ): NavStart {
    let choice;
    try {
      if (opts.keepEngine && tab.engine && this.ctx.engines.ready(tab.engine)) {
        // tab.go / tab.reload stay on the tab's engine; the fallback rule of the settings still applies.
        choice = { engine: tab.engine, forced: this.ctx.settings().engine !== 'auto', initFailed: false };
      } else {
        choice = this.ctx.engines.choose(commandEngine, this.ctx.settings());
      }
    } catch (err) {
      if (err instanceof NoEngineError) throw failure('engine_unavailable', err.message);
      throw err;
    }
    const forced = choice.forced;
    tab.permissions = permissions;
    this.#ensureFrame(tab, choice.engine);
    const nav = tab.nav.beginGnome({
      url,
      engine: choice.engine,
      kind: opts.kind,
      forced,
      ...(opts.targetIndex !== undefined ? { targetIndex: opts.targetIndex } : {}),
      ...(opts.restore ? { restore: true } : {}),
    });
    if (opts.opener) this.#navOpener.set(nav, opts.opener);
    tab.docAtNavStart = this.#frameDoc(tab);
    this.#loadFrame(tab, url, opts.opener ?? null);
    if (choice.initFailed && !tab.initFailedNotified) {
      tab.initFailedNotified = true;
      this.ctx.emit('tab.engineSwitched', { tabId: tab.id, navId: nav.id, from: 'scramjet', to: 'ultraviolet', reason: 'init-failed', latencyMs: 0 });
    }
    return { navId: nav.id, engine: choice.engine };
  }

  #proxied(tab: Tab, url: string): string {
    if (tab.engine === 'scramjet') {
      if (!tab.sjFrame) throw failure('engine_unavailable', 'Scramjet frame missing');
      return this.ctx.engines.scramjet.proxiedUrl(tab.sjFrame, url);
    }
    return this.ctx.engines.ultraviolet.proxiedUrl(url);
  }

  /**
   * GNOME-initiated load of `url` into the tab frame, replacing the frame's current entry. `opener`: the real URL of
   * the page that asked for the tab (a tab.openRequest), which is then the load's initiator.
   */
  #loadFrame(tab: Tab, url: string, opener: string | null = null): void {
    const f = tab.iframe;
    if (!f) return;
    const proxied = this.#proxied(tab, url);
    if (tab.engine === 'scramjet') {
      tab.sjClaims.expect(proxied, this.ctx.now());
      // Scramjet's Origin/Referer/Sec-Fetch-Site and cookie mode (sj-requests.ts withInitiator): GNOME's own navigation
      // has no initiator, like a typed URL; a tab a page asked for has that page, like a link it followed.
      const initiator = opener === null ? null : this.#proxied(tab, opener);
      this.ctx.engines.scramjet.gnomeLoads.expect(proxied, this.ctx.now(), initiator);
    }
    if (tab.engine === 'ultraviolet') {
      const abs = new URL(proxied, location.href).href;
      this.#uvLoad();
      this.#startCounts(tab);
      this.#noteUvNav(tab, abs);
      // The load's initiator for SameSite and fetch metadata (lane x3's glue): none for GNOME's own load, the opener
      // for a tab a page asked for.
      this.ctx.blocking.uvContext()?.nav(abs, opener ?? '');
    }
    const N = this.ctx.N;
    try {
      const w = N.contentWindow.call(f);
      if (w) {
        const loc = N.winLocation.call(w);
        const href = N.locationHref.call(loc);
        if (href !== 'about:blank' && new URL(href).origin === location.origin) {
          N.locationReplace.call(loc, proxied);
          return;
        }
      }
    } catch {
      /* the frame left the proxy origin: reset it below */
    }
    f.src = proxied;
  }

  #frameDoc(tab: Tab): Document | null {
    try {
      return tab.iframe ? this.ctx.N.contentDocument.call(tab.iframe) : null;
    } catch {
      return null;
    }
  }

  #ensureFrame(tab: Tab, engine: EngineId): void {
    const allow = tabFrameAllowList(tab.permissions, this.ctx.enforced());
    if (tab.iframe && tab.engine === engine) {
      if (tab.iframe.getAttribute('allow') !== allow) tab.iframe.setAttribute('allow', allow);
      return;
    }
    this.#removeFrame(tab);
    const f = document.createElement('iframe');
    f.name = `tab-${tab.id}`;
    f.setAttribute('allow', allow);
    f.title = 'Page';
    f.hidden = !tab.active;
    applyZoom(f, tab.zoom);
    this.ctx.N.on.call(f, 'load', (() => this.#onFrameLoad(tab, f)) as (ev: never) => void);
    this.#d.container.append(f);
    tab.iframe = f;
    tab.engine = engine;
    if (engine === 'scramjet') tab.sjFrame = this.ctx.engines.scramjet.createFrame(f, this.#plugin(tab));
  }

  #removeFrame(tab: Tab): void {
    if (tab.sjFrame) this.ctx.engines.scramjet.removeFrame(tab.sjFrame);
    tab.sjFrame = null;
    tab.iframe?.remove();
    tab.iframe = null;
    tab.engine = null;
    tab.topDoc = null;
    tab.topWin = null;
  }

  // ── The navigation environment of one tab ──────────────────────────────────────────────────────────────────────

  #navEnv(tabId: TabId) {
    const ctx = this.ctx;
    const emit: HostContext['emit'] = (type, p) => {
      if (type === 'tab.error') {
        const e = p as Parameters<HostContext['emit']>[1] & { idempotent?: boolean; fallback?: string };
        if (e.idempotent === false && e.fallback === 'available') ctx.counters.fallback.notRetried++;
      }
      ctx.emit(type, p);
      // The app starts the tab's numbers again at a cross-document commit: what was counted for this document before
      // it (the parser's early requests) goes out again after it (blocked.ts).
      if (type === 'tab.committed' && (p as EventMap['tab.committed']).kind !== 'same-document') ctx.blocking.counts.resend(tabId);
    };
    return {
      now: () => ctx.now(),
      clock: realClock,
      emit,
      nextNavId: () => ++this.#navSeq,
      engineReady: (e: EngineId) => ctx.engines.ready(e),
      autoFallback: () => ctx.settings().autoFallback,
      transportOffline: (e: EngineId) => this.#d.transportOffline(e),
      online: () => {
        try {
          return ctx.N.navOnLine.call(navigator);
        } catch {
          return true;
        }
      },
      startFallback: (nav: Nav) => this.#startFallback(tabId, nav),
      documentUnchanged: () => {
        const tab = this.tabs.get(tabId);
        return !!tab && tab.docAtNavStart !== null && this.#frameDoc(tab) === tab.docAtNavStart;
      },
      confirmDownload: (nav: Nav) => this.#d.downloads.release(nav),
      cancelDownload: (nav: Nav) => this.#d.downloads.drop(nav),
      announced: (url: string) => ctx.blocking.announcements.announced(url),
    };
  }

  #startFallback(tabId: TabId, nav: Nav): void {
    const ctx = this.ctx;
    ctx.counters.fallback.switched++;
    const url = nav.url;
    const copy = async (): Promise<number> => {
      if (!url) return 0;
      const rows = scramjetCookiesForUv(ctx.engines.scramjet.jar(), url, Date.now());
      await writeUvCookies(rows, []);
      return rows.length;
    };
    void copy()
      .catch((err: unknown) => {
        ctx.log('warn', `fallback cookie copy failed: ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      })
      .then(() => {
        const tab = this.tabs.get(tabId);
        if (!tab || tab.closed || tab.nav.nav !== nav || !url) return;
        try {
          if (!ctx.engines.ultraviolet.ready) throw new Error('Ultraviolet is not ready');
          this.#ensureFrame(tab, 'ultraviolet');
          tab.nav.beginGnome({
            url,
            engine: 'ultraviolet',
            kind: nav.kind,
            forced: true,
            auto: true,
            navId: nav.id,
            ...(nav.targetIndex !== null ? { targetIndex: nav.targetIndex } : {}),
            ...(nav.restore ? { restore: true } : {}),
          });
          tab.docAtNavStart = this.#frameDoc(tab);
          // The retry keeps the navigation's initiator: a tab a page asked for is not GNOME's own load (SameSite).
          this.#loadFrame(tab, url, this.#navOpener.get(nav) ?? null);
        } catch (err) {
          tab.nav.fallbackFailed(nav, err instanceof Error ? err.message : String(err));
        }
      });
  }

  // ── Frame loads: every load of a tab frame is classified ───────────────────────────────────────────────────────

  #onFrameLoad(tab: Tab, f: HTMLIFrameElement): void {
    if (tab.iframe !== f || tab.closed) return;
    const N = this.ctx.N;
    let w: Window | null;
    let href: string;
    try {
      w = N.contentWindow.call(f);
      if (!w) return;
      href = N.locationHref.call(N.winLocation.call(w));
    } catch {
      tab.nav.frameLeftProxy();
      return;
    }
    if (href === 'about:blank') return;
    const engine = tab.engine;
    if (!engine) return;
    let doc: Document | null = null;
    try {
      doc = N.contentDocument.call(f);
    } catch {
      doc = null;
    }
    if (engine === 'ultraviolet' && doc && N.getElementById.call(doc, 'uvVersion') && N.getElementById.call(doc, 'errorTrace')) {
      const trace = N.getElementById.call(doc, 'errorTrace');
      let text = 'Ultraviolet error page';
      try {
        text = trace && N.localName.call(trace) === 'textarea' ? N.textareaValue.call(trace) : N.docTitle.call(doc);
      } catch {
        /* keep the generic text */
      }
      this.#d.reportFailure('ultraviolet', text);
      tab.nav.uvErrorPage(fitText(sanitizeText(text), LIMITS.maxDetailLength), this.#realOf(tab, href));
      return;
    }
    const real = this.#realOf(tab, href);
    if (real === null) {
      // A proxy-origin URL outside the engine prefixes (the engine host, an API path): the page left the proxy.
      tab.nav.frameLeftProxy();
      return;
    }
    if (doc && !this.#attached.has(doc) && isHtml(N, doc) && tab.nav.pending) {
      // The service worker's blocked page (WAVE-B3 §4.5): no engine hook reached it, its <meta name="gnome-blocked">
      // names the category. A document the site serves cannot fake it: UV rewrites and attaches those.
      const category = blockedCategoryOf(N, doc);
      if (category) {
        tab.pendingTop = null;
        tab.nav.fail('blocked', `blocked:${category}`);
        return;
      }
    }
    if (doc && !this.#attached.has(doc) && isHtml(N, doc) && tab.nav.pending && !engineRan(w, engine)) {
      // An HTML document no engine hook reached: the service worker's "engine unavailable" page.
      tab.nav.fail('engine-unavailable', `${engine === 'scramjet' ? 'Scramjet' : 'Ultraviolet'} was not available for this page`);
      return;
    }
    tab.nav.documentLoaded(real, engine);
    // No favicon fetch for a document whose navigation failed (a blocked page: its site gets no request, row N8).
    if (w && tab.nav.nav?.phase !== 'failed') void this.#sendFavicon(tab, w, real);
  }

  #realOf(tab: Tab, raw: string): string | null {
    return this.ctx.engines.decode(raw, location.href, tab.sjFrame);
  }

  /**
   * The engine host is about to fetch `proxiedUrl` for the document of `w` (its favicon, a download it started):
   * under Scramjet that document becomes the request's initiator (sj-requests.ts withInitiator), so the target's
   * SameSite rules apply as in a browser instead of the `strict` mode of a request without one.
   */
  #onBehalfOf(tab: Tab, proxiedUrl: string, w: Window | null): void {
    if (!w || (tab.engine !== 'scramjet' && tab.engine !== 'ultraviolet')) return;
    let doc: string;
    try {
      doc = this.ctx.N.locationHref.call(this.ctx.N.winLocation.call(w));
    } catch {
      return;
    }
    if (tab.engine === 'ultraviolet') {
      // Under Ultraviolet the service worker judges the fetch with the page as its initiator (`inits`).
      const real = this.#realOf(tab, doc);
      if (real && /^https?:/i.test(real)) this.ctx.blocking.uvContext()?.init(new URL(proxiedUrl, location.href).href, real);
      return;
    }
    if (!doc.startsWith(`${location.origin}${PROXY_PATHS.scramjetPrefix}`)) return;
    this.ctx.engines.scramjet.pageFetches.expect(proxiedUrl, this.ctx.now(), doc);
  }

  /**
   * A URL a page (or its engine) passed to window.open, a link or a form: engine-prefixed and proxy-origin URLs are
   * decoded, other relative URLs resolve against the document's real URL. http(s) only.
   */
  #pageUrl(tab: Tab, raw: string, base: string): string | null {
    const t = raw.trim();
    const uvPrefix = this.ctx.engines.ultraviolet.prefix ?? '/uv/service/';
    const proxied = t.startsWith('/~/sj/') || t.startsWith(uvPrefix) || t.startsWith(location.origin);
    let abs: string;
    try {
      abs = new URL(t, proxied || !base ? location.href : base).href;
    } catch {
      return null;
    }
    const r = this.#realOf(tab, abs);
    return r && /^https?:/i.test(r) ? r : null;
  }

  async #sendFavicon(tab: Tab, w: Window, pageUrl: string): Promise<void> {
    const N = this.ctx.N;
    let href = iconLinkHref(w, N);
    if (!href) {
      try {
        href = this.#proxied(tab, new URL('/favicon.ico', pageUrl).href);
      } catch {
        return;
      }
    }
    if (href === tab.iconHref) return;
    tab.iconHref = href;
    let icon: string | null = null;
    try {
      const u = new URL(href, location.href);
      if (u.origin === location.origin && this.ctx.engines.engineOf(u)) {
        // A URL the page chose, fetched by the engine host: the page is its initiator (its site decides the cookies).
        this.#onBehalfOf(tab, u.href, w);
        const r = await N.fetch(u.href, { credentials: 'same-origin', cache: 'force-cache' });
        const len = Number(r.headers.get('content-length') ?? '0');
        if (r.ok && len <= LIMITS.faviconMaxBytes) {
          const buf = await readAtMost(r, LIMITS.faviconMaxBytes);
          icon = buf ? faviconDataUrl(r.headers.get('content-type'), buf) : null;
        } else {
          void r.body?.cancel().catch(() => {});
        }
      } else if (u.protocol === 'data:') {
        const r = await N.fetch(u.href);
        const buf = await readAtMost(r, LIMITS.faviconMaxBytes);
        icon = buf ? faviconDataUrl(r.headers.get('content-type'), buf) : null;
      }
    } catch {
      icon = null;
    }
    if (tab.closed || !this.tabs.has(tab.id)) return;
    this.ctx.emit('tab.favicon', { tabId: tab.id, icon });
  }

  // ── Documents (Scramjet init.pre/post, the UV document-start hook) ─────────────────────────────────────────────

  /** The frame elements from `win` up to the tab iframe (innermost first), and the tab; null outside any tab. */
  placeOf(win: Window): { tab: Tab; chain: Element[] } | null {
    const N = this.ctx.N;
    const chain: Element[] = [];
    let w: Window | null = win;
    for (let i = 0; i < 32 && w; i++) {
      let fe: Element | null;
      try {
        fe = N.frameElement.call(w);
      } catch {
        return null;
      }
      if (!fe) return null;
      chain.push(fe);
      const doc: Document | null = N.ownerDocument.call(fe);
      if (doc === document) {
        for (const t of this.tabs.values()) if (t.iframe === fe) return { tab: t, chain };
        return null;
      }
      w = doc ? N.defaultView.call(doc) : null;
    }
    return null;
  }

  /**
   * Scramjet `init.pre`, before Scramjet's client hooks the window: the page realm's kit (realm.ts) from its pristine
   * natives, then the WebRTC kill switch.
   */
  scramjetPre(win: Window): void {
    pageKit(win, this.ctx.N);
    if (this.ctx.settings().privacy.webrtc === 'block') this.#killSwitch(win);
  }

  /** A proxied document at its start (Scramjet init.post; the UV hook). */
  documentStart(win: Window, engine: EngineId): void {
    const place = this.placeOf(win);
    if (!place) return;
    const { tab, chain } = place;
    const N = this.ctx.N;
    let doc: Document;
    try {
      doc = N.winDocument.call(win);
    } catch {
      return;
    }
    if (this.#attached.has(doc)) return;
    // The page realm's kit first (for UV this hook runs before Ultraviolet's scripts and the page's own).
    pageKit(win, N);
    const block = this.ctx.settings().privacy.webrtc === 'block';
    if (tab.engine !== engine) {
      // GNOME's hook at the start of a srcdoc a script wrote (webrtc.ts) in a tab of the other engine, or a document
      // of a frame this tab no longer uses: the kill switch only; the tab's own engine attaches the rest.
      if (block) this.#killSwitch(win);
      return;
    }
    this.#attached.add(doc);
    const isTop = chain.length === 1;
    if (engine === 'ultraviolet') {
      // Before Ultraviolet's client: the WebRTC switch (when on) and the UV hardening (WAVE-B3 F2, F4, F5), here and in
      // every child realm the guard reaches.
      this.#guardUv(tab, win, block);
      this.#restrictFrames(doc);
    }
    this.#installCommon(tab, win, doc, isTop, engine);
    if (isTop) {
      tab.topWin = win;
      tab.topDoc = doc;
      // The document's counts started at its navigation's first request (#startCounts: a Scramjet own request, a UV
      // load GNOME started, the SW's first count for an announced UV navigation), so the parser's early requests count
      // for it; a document whose navigation showed none (the browser's own Back, a navigation nobody announced) starts
      // them here.
      const starting = tab.nav.nav;
      if (starting === null || starting.phase !== 'pending' || tab.countsNav !== starting) this.ctx.blocking.counts.reset(tab.id);
      tab.pendingTop = null;
      tab.iconHref = null;
      // Its request was claimed already: whatever is still expected belonged to a navigation that never happened.
      tab.sjClaims.clear();
      const url = this.#documentUrl(tab, win, engine);
      if (url) tab.nav.commitDocument(url, engine, timingType(win, N));
      tab.countsNav = tab.nav.nav;
      this.#installTop(tab, win, engine);
    }
    if (engine === 'ultraviolet') this.#hookUvWebSockets(tab, win);
    const url = this.#documentUrl(tab, win, engine);
    if (!url) return;
    const info = { engine, tabId: tab.id, url, topLevelUrl: tab.nav.current?.url ?? url, isTopLevel: isTop };
    const runOnDocument = (): void => {
      try {
        engineHooks().onDocument(win, info);
      } catch (err) {
        this.ctx.counters.hookErrors++;
        this.ctx.log('warn', `onDocument hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (engine === 'scramjet') {
      this.#hookSjWebSockets(tab, win, url);
      runOnDocument(); // init.post: Scramjet's client hooked the window already
      return;
    }
    // Ultraviolet: the page context for the service worker, the document map for uv-blocked, and onDocument once
    // UV's client has hooked the window (WAVE-B3 D11, §4.4).
    this.#uvDocumentStarted(tab, win, info.topLevelUrl);
    this.#afterUvClient(win, runOnDocument);
  }

  /**
   * WAVE-B3 D16: Scramjet's client opens every page WebSocket through `client.bare.createWebSocket(url, protocols,
   * headers)` (scramjet.js 2.0.67-alpha.2, its WebSocket and WebSocketStream proxies). At init.post, before page code
   * ran, the method of the realm's BareClient prototype is replaced with a kit-built callable that asks the hooks with
   * this document's context (on the prototype, so deleting an own property does not unwrap it), and leaves a mark
   * for the transport backstop (core.ts). [unproven] beyond rows N10/A10.
   */
  #hookSjWebSockets(tab: Tab, win: Window, documentUrl: string): void {
    const N = this.ctx.N;
    const kit = pageKit(win, N);
    if (!kit) return;
    try {
      const d = N.getOwnPropertyDescriptor(win, SCRAMJET_CLIENT);
      const client = d && 'value' in d ? (d.value as unknown) : undefined;
      if (typeof client !== 'object' || client === null) return;
      const bd = N.getOwnPropertyDescriptor(client, 'bare');
      const bare = bd && 'value' in bd ? (bd.value as unknown) : undefined;
      if (typeof bare !== 'object' || bare === null) return;
      const proto = N.getPrototypeOf(bare) as object | null;
      if (!proto || wrappedSjProtos.has(proto)) return;
      const md = N.getOwnPropertyDescriptor(proto, 'createWebSocket');
      const original = md && 'value' in md ? (md.value as unknown) : undefined;
      if (!md || typeof original !== 'function' || !md.configurable) return;
      wrappedSjProtos.add(proto);
      const ctx = this.ctx;
      const wrapped = kit.replace(original as (...a: never[]) => unknown, (_self, args, box) => {
        box[0] = CALL_ORIGINAL;
        let url: string;
        try {
          const a0 = arg(args, 0);
          url = typeof a0 === 'string' ? a0 : kit.str(a0);
        } catch (err) {
          box[0] = THROW;
          box[1] = err;
          return;
        }
        const info: RequestInfo = {
          engine: 'scramjet',
          tabId: tab.id,
          url,
          method: 'GET',
          destination: 'websocket',
          topLevelUrl: tab.nav.current?.url ?? null,
          isTopLevelDocument: false,
          documentUrl,
          referrer: null,
        };
        let verdict: 'allow' | 'block' = 'allow';
        try {
          verdict = engineHooks().onWebSocket(info);
        } catch (err) {
          ctx.counters.hookErrors++;
          ctx.log('warn', `onWebSocket hook: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (verdict === 'block') {
          ctx.blocking.wsMarks.blocked(url);
          box[0] = THROW;
          box[1] = kit.error('Blocked by GNOME', 'SecurityError');
          return;
        }
        ctx.blocking.wsMarks.allowed(url);
      });
      N.defineProperty(proto, 'createWebSocket', { value: wrapped, writable: md.writable, configurable: true, enumerable: md.enumerable });
    } catch (err) {
      this.ctx.counters.hookErrors++;
      this.ctx.log('warn', `Scramjet WebSocket hook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The proxied URL of a UV document (as at its start) → its tab; and its page context to the service worker. */
  #uvDocumentStarted(tab: Tab, win: Window, topLevelUrl: string): void {
    let proxied: string;
    try {
      proxied = this.ctx.N.locationHref.call(this.ctx.N.winLocation.call(win));
    } catch {
      return;
    }
    if (proxied.startsWith('about:')) return;
    this.#uvDocMap(proxied, { tab: tab.id, nav: null });
    this.ctx.blocking.uvContext()?.doc(proxied, topLevelUrl);
    this.#uvLoad();
  }

  #uvDocMap(proxied: string, entry: { tab: TabId; nav: object | null }): void {
    const key = withoutFragment(proxied);
    this.#uvDocs.delete(key);
    this.#uvDocs.set(key, entry);
    while (this.#uvDocs.size > 4096) {
      const oldest = this.#uvDocs.keys().next().value;
      if (oldest === undefined) break;
      this.#uvDocs.delete(oldest);
    }
  }

  /** A UV tab-top navigation this host announces to the SW: its counts (uv-blocked) belong to the tab. */
  #noteUvNav(tab: Tab, proxied: string): void {
    this.#uvDocMap(proxied, { tab: tab.id, nav: tab.nav.nav });
  }

  /**
   * An Ultraviolet load of this engine host starts (WAVE-B3 §4.5 "when its first UV tab opens"): the SW gets the
   * engines in force before that page's first request unless it has them already (host/blocker.ts onUvTab). At the
   * first UV document start it was too late: its HTML and the parser's early requests were judged by a SW without
   * lists (measured: two of three ad images loaded, row N13b).
   */
  #uvLoad(): void {
    this.ctx.blocking.onUvTab();
  }

  /**
   * A new navigation of the tab (its first request, a UV load GNOME started, the SW's first count for an announced UV
   * navigation): the tab's counts start again, once per navigation (redirect hops keep them).
   */
  #startCounts(tab: Tab): void {
    const nav = tab.nav.nav;
    if (nav === null || nav.phase !== 'pending' || tab.countsNav === nav) return;
    this.ctx.blocking.counts.reset(tab.id);
    tab.countsNav = nav;
  }

  /**
   * uv-blocked (C11): counts of a UV document of this host (its proxied URL, as the SW recorded it) or of a tab-top
   * navigation it announced; a URL it does not know is another GNOME tab's and is ignored. Counts of an announced
   * navigation that is still pending start that navigation's counts (they arrive before its document start).
   */
  countUvBlocked(documentUrl: string, counts: Partial<Record<BlockCategory, number>>): void {
    const entry = this.#uvDocs.get(withoutFragment(documentUrl));
    const tab = entry ? this.tabs.get(entry.tab) : undefined;
    if (!entry || !tab || tab.closed) return;
    if (entry.nav !== null && tab.nav.nav === entry.nav) this.#startCounts(tab);
    for (const c of BLOCK_CATEGORIES) {
      const n = counts[c];
      if (n !== undefined) this.ctx.blocking.counts.count(tab.id, c, n);
    }
  }

  /** Whether a tab of this engine host shows an Ultraviolet document. */
  hasUvTabs(): boolean {
    for (const t of this.tabs.values()) if (t.engine === 'ultraviolet' && !t.closed) return true;
    return false;
  }

  /**
   * UV's handler assigns `self.__uvHook = p` right after it hooked the window and before any page script (uv.handler.js
   * 3.2.10): a kit-built accessor there runs `fn` at that point, once (WAVE-B3 D11). No kit, or no assignment: `fn`
   * never runs for that document (fail open, logged and counted) [unproven] (rows CS11, K3).
   */
  #afterUvClient(win: Window, fn: () => void): void {
    const N = this.ctx.N;
    const kit = pageKit(win, N);
    if (!kit) return;
    let value: unknown;
    let ran = false;
    try {
      N.defineProperty(win, '__uvHook', {
        configurable: true,
        enumerable: false,
        get: kit.fn((_s, _a, box) => {
          box[0] = RETURN;
          box[1] = value;
        }),
        set: kit.fn((_s, args, box) => {
          box[0] = RETURN;
          box[1] = undefined;
          value = arg(args, 0);
          if (ran) return;
          ran = true;
          fn();
        }),
      });
    } catch (err) {
      this.ctx.counters.hookErrors++;
      this.ctx.log('warn', `UV document point: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The real URL of a proxied document: its proxied location decoded (this realm's natives only: the engines' own
   * page-realm objects, such as Scramjet's client, are not read, the page can reach and change them). An
   * `about:blank`/`about:srcdoc` document has the URL of the document that made it (its parent's).
   */
  #documentUrl(tab: Tab, win: Window, _engine: EngineId): string | null {
    const N = this.ctx.N;
    let w: Window | null = win;
    for (let i = 0; i < 8 && w; i++) {
      let href: string;
      try {
        href = N.locationHref.call(N.winLocation.call(w));
      } catch {
        return null;
      }
      if (!href.startsWith('about:')) return this.#realOf(tab, href);
      try {
        const fe: Element | null = N.frameElement.call(w);
        const doc: Document | null = fe ? N.ownerDocument.call(fe) : null;
        w = doc && doc !== document ? N.defaultView.call(doc) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** The WebRTC switch (when `block`) and hardenUvRealm in an Ultraviolet document's realm and its child realms. */
  #guardUv(tab: Tab, win: Window, block: boolean): void {
    const N = this.ctx.N;
    let first = true;
    const deps = {
      hostDocument: document,
      documentUrl: (w: Window) => this.#documentUrl(tab, w, 'ultraviolet'),
      realUrl: (raw: string, base: string) => {
        try {
          return this.#realOf(tab, new URL(raw, base).href);
        } catch {
          return null;
        }
      },
    };
    guardRealmsDeep(
      win,
      N,
      (w) => {
        if (block && killWebRtc(w, N) > 0 && first) {
          // Counted once per proxied document (diagnostics webrtc.blocked), not per child frame.
          this.ctx.counters.webrtc.blocked++;
          first = false;
        }
        hardenUvRealm(w, N, deps, { frameElement: w === win });
      },
      srcdocHookTag(location.origin, PROXY_PATHS.uvDocumentHook),
    );
  }

  #killSwitch(win: Window): void {
    let first = true;
    killWebRtcDeep(
      win,
      this.ctx.N,
      () => {
        // Counted once per proxied document (diagnostics webrtc.blocked), not per child frame.
        if (first) this.ctx.counters.webrtc.blocked++;
        first = false;
      },
      srcdocHookTag(location.origin, PROXY_PATHS.uvDocumentHook),
    );
  }

  /**
   * An Ultraviolet document at its start: no `data:`/`blob:` frames and no plugin content (FRAME_RESTRICTION_CSP), a
   * `<meta>` policy first in `<head>`, enforced for everything parsed or created after it (UV leaves `data:` frame
   * URLs as they are; Scramjet serves them through the service worker).
   */
  #restrictFrames(doc: Document): void {
    const N = this.ctx.N;
    try {
      if (N.docContentType.call(doc) !== 'text/html') return;
      const head = N.docHead.call(doc);
      if (!head) return;
      const meta = N.createElement.call(doc, 'meta');
      N.setAttribute.call(meta, 'http-equiv', 'Content-Security-Policy');
      N.setAttribute.call(meta, 'content', FRAME_RESTRICTION_CSP);
      N.appendChild.call(head, meta);
    } catch (err) {
      this.ctx.counters.hookErrors++;
      this.ctx.log('warn', `frame policy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #installCommon(tab: Tab, win: Window, doc: Document, isTop: boolean, engine: EngineId): void {
    const N = this.ctx.N;
    const ctx = this.ctx;
    // Scramjet turns a pushState/replaceState without a URL into `<origin>/undefined` (observe/history-url.ts).
    if (engine === 'scramjet') installHistoryUrlFix(win, N, () => this.#documentUrl(tab, win, engine));
    installKeyForwarding(win, N, () => this.#combos, (combo, repeat) => ctx.emit('tab.key', { tabId: tab.id, combo, repeat }));
    installContextMenu(win, N, {
      realUrl: (raw) => this.#realOf(tab, raw),
      frameChain: (w) => this.placeOf(w)?.chain ?? [],
      zoom: () => tab.zoom,
      send: (p) => ctx.emit('tab.contextMenu', { tabId: tab.id, ...p }),
    });
    N.on.call(
      doc,
      'securitypolicyviolation',
      ((ev: SecurityPolicyViolationEvent) => {
        // A synthetic event a page dispatched counts nothing (WAVE-B3 F6): isTrusted is an unforgeable own property.
        if (!ev.isTrusted) return;
        // Read with this realm's getters: the page may redefine its own event prototype's accessors.
        let disposition: string;
        let directive: string;
        try {
          disposition = N.spvDisposition.call(ev);
          directive = N.spvEffectiveDirective.call(ev);
        } catch {
          return;
        }
        if (disposition !== 'enforce') return;
        ctx.counters.csp.violations++;
        const dir = /^[a-z-]{1,32}$/.test(directive) ? directive : 'other';
        if (dir in ctx.counters.csp.byDirective || Object.keys(ctx.counters.csp.byDirective).length < LIMITS.maxDiagnosticsDirectives) {
          ctx.counters.csp.byDirective[dir] = (ctx.counters.csp.byDirective[dir] ?? 0) + 1;
        }
        if (tab.closed) return;
        ctx.blocking.counts.count(tab.id, 'direct-connection');
      }) as (ev: never) => void,
      true,
    );
    installPopupRouting(
      win,
      N,
      {
        realUrl: (raw, base) => this.#pageUrl(tab, raw, base),
        documentUrl: (w) => this.#documentUrl(tab, w, engine),
        frameNames: () => this.#frameNames(tab),
        frameWindow: (name) => this.#frameWindow(tab, name),
        tabTop: () => tab.topWin,
        open: (url, disposition, userActivation) => {
          ctx.counters.popups.routed++;
          ctx.emit('tab.openRequest', { openerTabId: tab.id, url, disposition, userActivation });
        },
        download: (proxiedUrl, realUrl, name) => {
          void this.downloadUrl(tab, new URL(proxiedUrl, location.href).href, realUrl, name, win).catch((err: unknown) =>
            ctx.log('warn', `download: ${err instanceof Error ? err.message : String(err)}`),
          );
        },
        close: () => {
          ctx.counters.popups.closeRequests++;
          ctx.emit('tab.closeRequest', { tabId: tab.id });
        },
        navigate: (target, realUrl) => {
          N.locationAssign.call(N.winLocation.call(target), this.#proxied(tab, realUrl));
        },
        apple: () => this.#combos.apple,
      },
      isTop,
    );
  }

  #installTop(tab: Tab, win: Window, engine: EngineId): void {
    const N = this.ctx.N;
    installCommitObservers(win, N, {
      decode: (raw) => this.#realOf(tab, raw),
      currentUrl: () => this.#documentUrl(tab, win, engine),
      lastUrl: () => tab.nav.history.current,
      pageStart: (url, type, method, raw) => {
        if (tab.topWin !== win || tab.engine !== engine) return;
        if (engine === 'scramjet' && raw) tab.sjClaims.expect(raw, this.ctx.now());
        const before = tab.nav.nav;
        tab.nav.beginPage({ url, engine, ...(type ? { type } : {}), ...(method ? { method } : {}) });
        if (tab.nav.nav !== before) tab.docAtNavStart = this.#frameDoc(tab);
      },
      sameDocument: (url, handling: HistoryHandling) => {
        if (tab.topWin !== win) return;
        tab.nav.sameDocument(url, handling);
      },
      announce: (url, raw, cancelled) => {
        if (tab.topWin !== win || tab.engine !== engine) return;
        // UV: the navigation goes to the service worker synchronously (it must beat the fetch), dropped again when
        // the page cancelled it; the announcement to the app only once it was not cancelled (WAVE-B3 D5, §4.5).
        const proxied = engine === 'ultraviolet' && raw ? new URL(raw, location.href).href : null;
        if (proxied) {
          this.#noteUvNav(tab, proxied);
          this.ctx.blocking.uvContext()?.nav(proxied);
        }
        queueMicrotask(() => {
          if (cancelled()) {
            if (proxied) this.ctx.blocking.uvContext()?.drop(proxied);
            return;
          }
          if (url && !this.ctx.blocking.announcements.answered(url) && !this.ctx.blocking.announcements.pending(url)) tab.nav.announce(url);
        });
      },
      useBeforeUnload: engine === 'ultraviolet',
    });
    if (engine === 'scramjet') {
      // The tab's top document is leaving: its next document request is the tab's own (also where the Navigation API
      // is missing; with it, `navigate` above already named the URL and this does not override it).
      N.on.call(
        win,
        'beforeunload',
        (() => {
          if (tab.topWin === win) tab.sjClaims.expect(null, this.ctx.now());
        }) as (ev: never) => void,
        true,
      );
    }
    installTitleObserver(win, N, (title) => {
      if (tab.topWin !== win || tab.closed) return;
      tab.nav.title = title;
      this.ctx.emit('tab.title', { tabId: tab.id, title });
    });
  }

  /**
   * Downloads a URL in the tab's context (its engine, its cookies) as a blob the browser saves (`<a download>`,
   * tab.download). `from`: the document that started it (the clicked link's; else the tab's top document), which is
   * the request's initiator: a page cannot make the engine host send another site its SameSite=Strict cookies.
   */
  async downloadUrl(tab: Tab, proxiedUrl: string | null, realUrl: string, name: string | null, from: Window | null = tab.topWin): Promise<void> {
    const engine = tab.engine;
    if (!engine) throw failure('no_document', 'the tab has no page');
    const N = this.ctx.N;
    const proxied = proxiedUrl ?? this.#proxied(tab, realUrl);
    this.#onBehalfOf(tab, proxied, from);
    await this.#d.downloads.fetchDownload(tab.id, engine, proxied, realUrl, name, {
      fetch: (input, init) => N.fetch(input, init),
      save: (blob, filename) => {
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 60_000);
      },
    });
  }

  /** The named frames of the tab, in tree order (depth ≤ 8): name → its window. */
  #namedFrames(tab: Tab): Map<string, Window> {
    const out = new Map<string, Window>();
    const N = this.ctx.N;
    const walk = (doc: Document | null, depth: number): void => {
      if (!doc || depth > 8) return;
      try {
        const frames = N.querySelectorAll.call(doc, 'iframe, frame');
        const count = N.nodeListLength.call(frames);
        for (let i = 0; i < count; i++) {
          const f = N.nodeListItem.call(frames, i);
          const n = N.getAttribute.call(f, 'name');
          let w: Window | null = null;
          try {
            w = N.localName.call(f) === 'frame' ? N.frameContentWindow.call(f) : N.contentWindow.call(f);
          } catch {
            w = null;
          }
          if (n && w && !out.has(n)) out.set(n, w);
          try {
            walk(w ? N.winDocument.call(w) : null, depth + 1);
          } catch {
            /* cross-origin */
          }
        }
      } catch {
        /* gone */
      }
    };
    walk(tab.topDoc, 0);
    return out;
  }

  #frameNames(tab: Tab): ReadonlySet<string> {
    return new Set(this.#namedFrames(tab).keys());
  }

  #frameWindow(tab: Tab, name: string): Window | null {
    return this.#namedFrames(tab).get(name) ?? null;
  }

  /**
   * Every UV page WebSocket passes BareClient.createWebSocket in its own realm: ask the hooks there (step 3). The
   * wrapper, the accessor that catches uv.bundle.js defining `Ultraviolet` and the error a blocked socket throws are
   * page-realm objects (realm.ts). Only the first definition is wrapped: it comes from uv.bundle.js before any page
   * script ran, so reading it runs no page code; a later assignment (by the page) is kept as a plain value.
   */
  #hookUvWebSockets(tab: Tab, win: Window): void {
    const N = this.ctx.N;
    const kit = pageKit(win, N);
    if (!kit) return;
    const ctx = this.ctx;
    const own = (o: unknown, key: string): unknown => {
      if ((typeof o !== 'object' && typeof o !== 'function') || o === null) return undefined;
      const d = N.getOwnPropertyDescriptor(o, key);
      return d && 'value' in d ? d.value : undefined;
    };
    const wrap = (uv: unknown): void => {
      const proto = own(own(uv, 'BareClient'), 'prototype');
      if (typeof proto !== 'object' || proto === null || wrappedUvProtos.has(proto)) return;
      const d = N.getOwnPropertyDescriptor(proto, 'createWebSocket');
      const original = d && 'value' in d ? (d.value as unknown) : undefined;
      if (!d || typeof original !== 'function') return;
      wrappedUvProtos.add(proto);
      const wrapped = kit.replace(original as (...a: never[]) => unknown, (_self, args, box) => {
        box[0] = CALL_ORIGINAL;
        let url: string;
        try {
          const a0 = arg(args, 0);
          url = typeof a0 === 'string' ? a0 : kit.str(a0);
        } catch (err) {
          box[0] = THROW;
          box[1] = err;
          return;
        }
        const info: RequestInfo = {
          engine: 'ultraviolet',
          tabId: tab.id,
          url,
          method: 'GET',
          destination: 'websocket',
          topLevelUrl: tab.nav.current?.url ?? null,
          isTopLevelDocument: false,
          documentUrl: this.#documentUrl(tab, win, 'ultraviolet') ?? tab.nav.current?.url ?? null,
          referrer: null,
        };
        let verdict: 'allow' | 'block' = 'allow';
        try {
          verdict = engineHooks().onWebSocket(info);
        } catch (err) {
          ctx.counters.hookErrors++;
          ctx.log('warn', `onWebSocket hook: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (verdict === 'block') {
          box[0] = THROW;
          box[1] = kit.error('Blocked by GNOME', 'SecurityError');
        }
      });
      N.defineProperty(proto, 'createWebSocket', { value: wrapped, writable: true, configurable: true, enumerable: false });
    };
    try {
      const d = N.getOwnPropertyDescriptor(win, 'Ultraviolet');
      if (d) {
        if ('value' in d) wrap(d.value);
        return;
      }
      let value: unknown;
      let first = true;
      N.defineProperty(win, 'Ultraviolet', {
        configurable: true,
        enumerable: false,
        get: kit.fn((_s, _a, box) => {
          box[0] = RETURN;
          box[1] = value;
        }),
        set: kit.fn((_s, args, box) => {
          box[0] = RETURN;
          box[1] = undefined;
          value = arg(args, 0);
          if (!first) return;
          first = false;
          try {
            wrap(value);
          } catch {
            /* leave UV alone */
          }
        }),
      });
    } catch {
      /* the page realm refused: UV sockets stay unhooked (ALLOW_ALL until step 3 anyway) */
    }
  }

  #onFullscreen(): void {
    const N = this.ctx.N;
    const el = N.fullscreenElement.call(document);
    for (const tab of this.tabs.values()) {
      const active = !!tab.iframe && el === tab.iframe;
      if (active !== tab.fullscreen) {
        tab.fullscreen = active;
        this.ctx.emit('tab.fullscreen', { tabId: tab.id, active });
      }
    }
  }

  // ── Scramjet's per-tab plugin ──────────────────────────────────────────────────────────────────────────────────

  #plugin(tab: Tab): ManagedPluginLike {
    const ManagedPlugin = vendor().$scramjetController?.ManagedPlugin;
    if (!ManagedPlugin) throw failure('engine_unavailable', 'scramjet-controller is not loaded');
    const self = this;
    const ctx = this.ctx;
    const guard = (where: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        if ((err as { gnomeInjected?: boolean } | null)?.gnomeInjected) throw err;
        ctx.counters.hookErrors++;
        ctx.log('error', `${where}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    class GnomeTabPlugin extends ManagedPlugin {
      constructor() {
        super('gnome-tab', []);
      }
      override install(frame: ScramjetFrameLike): void {
        super.install(frame);
        // Hooks must never throw (a throw fails the request); init hooks are not awaited.
        this.tap<FrameInitCtx, unknown>(frame.hooks.init.pre, (c) => guard('init.pre', () => self.scramjetPre(c.window)));
        this.tap<FrameInitCtx, unknown>(frame.hooks.init.post, (c) => guard('init.post', () => self.documentStart(c.window, 'scramjet')));
        // fetch.request may wait for the app's answer to a navigation announcement (WAVE-B3 D5): Scramjet awaits the
        // taps' promises (Tap.dispatch → Promise.all, awaited by its fetch; scramjet.js 2.0.67-alpha.2).
        this.tap<ScramjetRequestCtx, ScramjetRequestProps>(frame.hooks.fetch.request, (c, p) => {
          const box: { wait: Promise<void> | null } = { wait: null };
          guard('fetch.request', () => {
            const r = self.#sjRequest(tab, c, p);
            if (r instanceof Promise) box.wait = r;
          });
          const wait = box.wait;
          return wait === null
            ? undefined
            : wait.catch((err: unknown) =>
                guard('fetch.request', () => {
                  throw err;
                }),
              );
        });
        this.tap<ScramjetRequestCtx, ScramjetPreresponseProps>(frame.hooks.fetch.preresponse, (c, p) => guard('fetch.preresponse', () => self.#sjPreresponse(tab, c, p)));
        this.tap<ScramjetRequestCtx, ScramjetResponseProps>(frame.hooks.fetch.response, (c, p) => guard('fetch.response', () => self.#sjResponse(tab, c, p)));
        this.tap<ScramjetErrorCtx, ScramjetErrorProps>(frame.hooks.error.request, (c, p) => guard('error.request', () => self.#sjError(tab, c, p)));
      }
    }
    return new GnomeTabPlugin();
  }

  /** A document/iframe request without Scramjet's `$iframe` first-load mark: the tab frame's or a nested frame's. */
  #isTabDocument(c: ScramjetRequestCtx): boolean {
    const dest = c.parsed.destination;
    return (dest === 'iframe' || dest === 'document') && !c.parsed.isIframe;
  }

  /** Whether a tab-shaped request is a navigation of the tab frame itself (sj-requests.ts), not of a nested frame. */
  #claimTabRequest(tab: Tab, rawUrl: string, realUrl: string | null): boolean {
    const doc = this.#frameDoc(tab);
    const nav = tab.nav.nav;
    return tab.sjClaims.claim(rawUrl, this.ctx.now(), {
      hookedDocument: doc !== null && this.#attached.has(doc),
      pendingUrl: nav && nav.phase === 'pending' ? nav.url : null,
      realUrl,
    });
  }

  #isOwnRequest(c: ScramjetRequestCtx): boolean {
    return typeof c.request === 'object' && c.request !== null && this.#ownRequests.has(c.request);
  }

  /**
   * The step-3 request context of a Scramjet request (WAVE-B3 C6, §4.4): the tab's own request is its own top-level
   * page; a request whose client is the document being loaded (`tab.pendingTop`) belongs to that new page; else the
   * committed page. `documentUrl`: the client's real URL (subresources), the parent document (frame navigations, from
   * the raw referrer), the URL itself (the tab's document); an about:/blob:/data: client counts as the top-level page.
   */
  #requestInfo(tab: Tab, c: ScramjetRequestCtx, url: string, method: string, headers?: ScramjetRequestProps['init']['headers']): RequestInfo {
    const own = this.#isOwnRequest(c);
    const dest = c.parsed.destination;
    let documentUrl: string | null = null;
    if (own) documentUrl = url;
    else if (dest === 'document' || dest === 'iframe' || dest === 'frame') {
      const ref = c.request?.rawReferrer;
      documentUrl = ref ? httpOrNull(this.#realOf(tab, ref)) : null;
    } else {
      const client = (c.parsed as { clientUrl?: URL }).clientUrl;
      documentUrl = client ? httpOrNull(String(client.href)) : null;
    }
    const committed = tab.nav.current?.url ?? null;
    const topLevelUrl = own ? url : documentUrl !== null && tab.pendingTop !== null && documentUrl === tab.pendingTop ? tab.pendingTop : committed;
    return {
      engine: 'scramjet',
      tabId: tab.id,
      url,
      method: method.toUpperCase(),
      destination: dest,
      topLevelUrl,
      isTopLevelDocument: own,
      documentUrl: documentUrl ?? topLevelUrl,
      referrer: headerOf(headers, 'referer'),
    };
  }

  #sjRequest(tab: Tab, c: ScramjetRequestCtx, p: ScramjetRequestProps): void | Promise<void> {
    const url = String(p.url.href);
    const method = String(p.init?.method ?? c.request?.method ?? 'GET').toUpperCase();
    const own =
      tab.engine === 'scramjet' &&
      this.#isTabDocument(c) &&
      typeof c.request === 'object' &&
      c.request !== null &&
      this.#claimTabRequest(tab, String(c.request.rawUrl?.href ?? url), url);
    if (own) {
      // A navigation of the tab frame (GNOME-initiated, in-page, or a redirect hop). A nested frame's navigation
      // looks the same to Scramjet and leaves the tab's navigation state alone.
      this.#ownRequests.add(c.request);
      tab.nav.beginPage({ url, engine: 'scramjet', method });
      if (this.#d.fault() === 'sj-throw-marker' && url.includes('gnome-fault=sj-throw')) {
        throw Object.assign(new Error('injected Scramjet failure (test)'), { gnomeInjected: true });
      }
    }
    if (own) {
      // A new document of the tab: its counts start now (its early subresources come before its document start).
      this.#startCounts(tab);
      tab.pendingTop = url;
      // The first page of a site waits for its rules (WAVE-B3 D5): announced, then judged at the app's answer or
      // after 150 ms. Not when the throttle refused the announcement.
      const a = this.ctx.blocking.announcements;
      if (!a.answered(url) && (a.pending(url) || tab.nav.announce(url))) {
        return a.wait(url, ANNOUNCE_WAIT_MS).then(() => this.#judge(tab, c, p, url, method, own));
      }
    }
    this.#judge(tab, c, p, url, method, own);
  }

  #judge(tab: Tab, c: ScramjetRequestCtx, p: ScramjetRequestProps, url: string, method: string, own: boolean): void {
    const verdict = safeVerdict(engineHooks(), this.#requestInfo(tab, c, url, method, p.init?.headers), (err) => {
      this.ctx.counters.hookErrors++;
      this.ctx.log('warn', `onRequest hook: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (verdict.action === 'block') {
      // A $redirect resource for a subresource (safeVerdict already dropped any for documents and frames, D10);
      // Scramjet rewrites it like any script, and #sjResponse adds the proxied-document CSP.
      const body = verdict.resource && !own ? resourceBody(verdict.resource) : null;
      p.earlyResponse = body
        ? new Response(body, { status: 200, headers: { 'content-type': verdict.resource?.contentType ?? 'text/plain', 'cache-control': 'no-store' } })
        : new Response(null, { status: 403, statusText: 'Blocked by GNOME' });
      if (own) {
        tab.pendingTop = null;
        tab.nav.fail('blocked', `blocked:${verdict.category}`);
      }
      return;
    }
    if (verdict.action === 'redirect') {
      p.earlyResponse = new Response(null, { status: 307, headers: { location: verdict.url } });
      return;
    }
    if (verdict.headers) applyHeaderChanges(p.init, verdict.headers);
  }

  #sjPreresponse(tab: Tab, c: ScramjetRequestCtx, p: ScramjetPreresponseProps): void {
    const hooks = engineHooks();
    if (!p.response?.rawHeaders) return;
    try {
      hooks.onResponse({ ...this.#requestInfo(tab, c, String(c.parsed.url.href), c.request?.method ?? 'GET'), status: p.response.status }, rawHeadersBag(p.response.rawHeaders));
    } catch (err) {
      this.ctx.counters.hookErrors++;
      this.ctx.log('warn', `onResponse hook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #sjResponse(tab: Tab, c: ScramjetRequestCtx, p: ScramjetResponseProps): void {
    const h = p.response.headers;
    const dest = c.parsed.destination;
    const isTab = this.#isOwnRequest(c);
    const navigation = dest === 'document' || dest === 'iframe';
    const downloadRequest = dest === '' && c.request?.mode === 'navigate';
    if (isTab && tab.engine === 'scramjet') {
      tab.nav.responseStatus(p.response.status);
      const location = p.response.status >= 300 && p.response.status < 400 ? h.get('location') : null;
      if (location) {
        // The next hop of the tab frame's navigation (Scramjet already rewrote the Location).
        try {
          const from = String(c.request.rawUrl?.href ?? location);
          const next = new URL(location, from).href;
          tab.sjClaims.expect(next, this.ctx.now());
          this.ctx.engines.scramjet.gnomeLoads.redirected(from, next, this.ctx.now());
        } catch {
          /* an unusable Location: the browser will not follow it either */
        }
      }
    }
    const cd = h.get('content-disposition');
    const ct = h.get('content-type');
    const disposition = navigation ? downloadDisposition(cd, ct) : downloadRequest ? 'attachment' : null;
    if (disposition && navigation && p.response.status >= 200 && p.response.status < 300) {
      // The browser names the file after the URL it fetched unless the header names it (downloads.ts namedDisposition).
      const named = namedDisposition(cd, disposition, String(c.parsed.url.href));
      if (named) h.set('content-disposition', named);
    }
    if (disposition && p.response.body && p.response.status >= 200 && p.response.status < 300) {
      let held: { nav: object } | null = null;
      if (isTab && tab.engine === 'scramjet') {
        const nav = tab.nav.nav;
        if (tab.nav.downloadResponse(disposition) && disposition === 'unrendered-type' && nav) held = { nav };
      } else if (disposition === 'unrendered-type') {
        // A nested frame answered with a type browsers may not render: no commit to wait for; report it.
        held = null;
      }
      const body = this.#d.downloads.trackScramjet(
        tab.id,
        { url: String(c.parsed.url.href), contentDisposition: cd, contentType: ct, contentLength: h.get('content-length') },
        p.response.body,
        held,
      );
      if (body) p.response.body = body;
    }
    // GNOME's proxied-document policy, plus `script-src 'none'` for a document/iframe answer Scramjet left unrewritten
    // (a scriptable type that is not text/html) and that renders (not a download). The service worker applies the
    // same second policy to the remaining scriptable answers of both engines (sw/pure.ts scramjetNeedsScriptless:
    // `<frame>` documents shown to Scramjet as iframes, downloads, …) and never adds it twice.
    applyProxiedCsp(dest, h, { unrewrittenScripts: navigation && scriptsUnrewritten(bareMime(ct)) && !disposition });
  }

  #sjError(tab: Tab, c: ScramjetErrorCtx, p: ScramjetErrorProps): void {
    const raw = c.rawrequest ?? {};
    const dest = raw.destination ?? '';
    const message = String((c.error as { message?: string } | null)?.message ?? c.error).slice(0, 500);
    if ((dest !== 'document' && dest !== 'iframe') || tab.engine !== 'scramjet') return;
    // The error hook gets the raw request (its URL), not the request object the fetch hooks share.
    const rawUrl = String(raw.rawUrl ?? '');
    const own = tabShaped(dest, rawUrl) && (tab.sjClaims.isOwn(rawUrl) || this.#claimTabRequest(tab, rawUrl, this.#realOf(tab, rawUrl)));
    if (own && !tab.nav.pending) return;
    // GNOME's substitute page, never the engine's own error answer (nothing runs in it); for a nested frame it is what
    // a browser shows inside a frame that could not be loaded.
    p.setResponse = {
      body: '<!doctype html><meta charset="utf-8"><title>GNOME</title><p>This page could not be loaded.</p>',
      status: 502,
      statusText: 'Bad Gateway',
      headers: [
        ['content-type', 'text/html; charset=utf-8'],
        ['content-security-policy', "default-src 'none'"],
      ],
    };
    p.suppressError = true;
    if (!own) return;
    this.#d.reportFailure('scramjet', message);
    // Synchronously: a deferred failure let the substitute page commit first (spike §3 item 6).
    tab.nav.fail('error-hook', message);
  }

  // ── Ultraviolet downloads from the service worker ──────────────────────────────────────────────────────────────

  /** Claims a uv-download `started` signal for one of this host's tabs (ENGINE-PROTOCOL §6.9 attribution order). */
  claimUvDownload(sig: Extract<SwSignal, { type: 'uv-download'; phase: 'started' }>): { tabId: TabId; nav: object | null; held: boolean; url: string } | null {
    const real = this.ctx.engines.decode(sig.url, location.href);
    if (!real) return null;
    const uvTabs = [...this.tabs.values()].filter((t) => t.engine === 'ultraviolet' && !t.closed);
    if (sig.navigation) {
      for (const t of uvTabs) {
        const nav = t.nav.nav;
        if (nav && nav.phase === 'pending' && nav.url === real) {
          const took = t.nav.downloadResponse(sig.disposition);
          return { tabId: t.id, nav: took && sig.disposition === 'unrendered-type' ? nav : null, held: took && sig.disposition === 'unrendered-type', url: real };
        }
      }
    }
    for (const raw of [sig.clientUrl, sig.referrer]) {
      if (!raw) continue;
      const doc = this.ctx.engines.decode(raw, location.href);
      if (!doc) continue;
      for (const t of uvTabs) if (this.#tabHasDocument(t, doc)) return { tabId: t.id, nav: null, held: false, url: real };
    }
    return null;
  }

  #tabHasDocument(tab: Tab, url: string): boolean {
    const N = this.ctx.N;
    const walk = (w: Window | null, depth: number): boolean => {
      if (!w || depth > 8) return false;
      try {
        if (this.#documentUrl(tab, w, 'ultraviolet') === url) return true;
        const doc = N.winDocument.call(w);
        const frames = N.querySelectorAll.call(doc, 'iframe, frame');
        const count = N.nodeListLength.call(frames);
        for (let i = 0; i < count; i++) {
          const f = N.nodeListItem.call(frames, i);
          if (walk(N.localName.call(f) === 'frame' ? N.frameContentWindow.call(f) : N.contentWindow.call(f), depth + 1)) return true;
        }
      } catch {
        /* cross-origin */
      }
      return false;
    };
    return walk(tab.topWin, 0) || tab.nav.current?.url === url;
  }

  /** A UV transport error the SW saw: probe the transport (the navigation's own outcome arrives as a page). */
  onUvError(): void {
    this.#d.reportFailure('ultraviolet', 'uv transport error');
  }

  /** Every tab of this host, for diagnostics and test hooks. */
  all(): Tab[] {
    return [...this.tabs.values()];
  }

  /** The time TIMEOUTS gives an unrendered navigation (exported for tests). */
  static readonly downloadCommitMs = TIMEOUTS.downloadCommitMs;
}

/**
 * A response body of at most `max` bytes, or null when it is longer (then it is cancelled): a page's icon link may
 * name any URL, also one that never ends, and a missing Content-Length says nothing.
 */
export async function readAtMost(r: Response, max: number): Promise<Uint8Array | null> {
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The engine's client ran in this window (a proxied page whose document-start hook we did not see). */
/** UV BareClient prototypes whose createWebSocket GNOME wrapped (one wrapper per realm). */
const wrappedUvProtos = new WeakSet<object>();
/** Scramjet BareClient prototypes whose createWebSocket GNOME wrapped (D16; one wrapper per realm). */
const wrappedSjProtos = new WeakSet<object>();

/** Whether an engine's client ran in a window: its own global, read without running page code. */
function engineRan(w: Window, engine: EngineId): boolean {
  try {
    return Object.getOwnPropertyDescriptor(w, engine === 'scramjet' ? SCRAMJET_CLIENT : '__uv') !== undefined;
  } catch {
    return false;
  }
}

function isHtml(N: HostContext['N'], doc: Document): boolean {
  try {
    const t = N.docContentType.call(doc);
    return t === 'text/html' || t === 'application/xhtml+xml';
  } catch {
    return false;
  }
}

/** Zoom of a tab frame: a CSS transform plus the inverse size, so the page lays out like browser zoom. */
export function applyZoom(f: HTMLIFrameElement, factor: number): void {
  if (factor === 1) {
    f.style.removeProperty('transform');
    f.style.removeProperty('transform-origin');
    f.style.removeProperty('width');
    f.style.removeProperty('height');
    return;
  }
  f.style.transformOrigin = '0 0';
  f.style.transform = `scale(${factor})`;
  f.style.width = `${100 / factor}%`;
  f.style.height = `${100 / factor}%`;
}

function applyHeaderChanges(init: ScramjetRequestProps['init'], changes: HeaderChanges): void {
  const list: Array<[string, string]> = Array.isArray(init.headers)
    ? init.headers
    : Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)] as [string, string]);
  const remove = new Set((changes.remove ?? []).map((n) => n.toLowerCase()));
  for (const [n] of changes.set ?? []) remove.add(n.toLowerCase());
  const out = list.filter(([n]) => !remove.has(n.toLowerCase()));
  for (const [n, v] of changes.set ?? []) out.push([n, v]);
  init.headers = out;
}

function rawHeadersBag(raw: Array<[string, string]>): ResponseHeaders {
  return {
    get: (name) => raw.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1] ?? null,
    getAll: (name) => raw.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v),
    set: (name, value) => {
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i]?.[0].toLowerCase() === name.toLowerCase()) raw.splice(i, 1);
      raw.push([name, value]);
    },
    append: (name, value) => {
      raw.push([name, value]);
    },
    delete: (name) => {
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i]?.[0].toLowerCase() === name.toLowerCase()) raw.splice(i, 1);
    },
  };
}

/** WAVE-B3 D5: how long a tab's own request waits for the app's answer to its announcement. */
export const ANNOUNCE_WAIT_MS = 150;

/** A URL without its fragment (the SW keys UV documents without it). */
function withoutFragment(u: string): string {
  const i = u.indexOf('#');
  return i < 0 ? u : u.slice(0, i);
}

function httpOrNull(u: string | null): string | null {
  return u !== null && /^https?:\/\//i.test(u) ? u : null;
}

/** One request header from Scramjet's init headers (pairs or a record), case-insensitively. */
function headerOf(headers: ScramjetRequestProps['init']['headers'], name: string): string | null {
  if (!headers) return null;
  const list: Array<[string, string]> = Array.isArray(headers) ? headers : Object.entries(headers).map(([k, v]) => [k, String(v)] as [string, string]);
  for (const [n, v] of list) if (n.toLowerCase() === name) return v;
  return null;
}

/** A $redirect resource's body bytes (base64 decoded when it says so); null when it cannot be decoded. */
function resourceBody(r: RedirectResource): Uint8Array<ArrayBuffer> | string | null {
  if (!r.base64) return r.body;
  try {
    const bin = atob(r.body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The category of the service worker's blocked page (`<meta name="gnome-blocked" content="…">`), read with natives. */
function blockedCategoryOf(N: HostContext['N'], doc: Document): BlockCategory | null {
  try {
    const meta = N.querySelector.call(doc, 'meta[name="gnome-blocked"]');
    const c = meta ? N.getAttribute.call(meta, 'content') : null;
    return c !== null && (BLOCK_CATEGORIES as readonly string[]).includes(c) ? (c as BlockCategory) : null;
  } catch {
    return null;
  }
}

