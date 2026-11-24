/**
 * The browser: the composition root of the app side of Wave B (docs/WAVE-B.md §4). It owns the tab list, drives the
 * engine host through EngineClient, mints Wisp tickets, sends the settings snapshot, handles every validated event,
 * records history visits through one VisitGate, observes downloads, applies the discard policy and the session, and
 * registers the BrowserBridge and the tab shortcuts.
 *
 * Engine events never trigger a privileged action by themselves (ENGINE-PROTOCOL §1.2 rule 2): what needs a gesture
 * waits for a click in GNOME's own UI (Retry, the pop-up indicator, the sign-in notice, context-menu items), or for the
 * app document's own transient activation (popups with a gesture, privileged forwarded shortcuts).
 */
import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { navigate, router } from '../app/router.svelte';
import { server } from '../app/server.svelte';
import { shell } from '../app/shell.svelte';
import { clearStatus, reportStatus } from '../app/status';
import { toast } from '../app/overlays/toast.svelte';
import { dispatchForwardedShortcut, isForwardedDispatch, onForwardedShortcut, register } from '../app/shortcuts';
import { isApiError, requestWispTicket, type TicketRoute } from '../lib/api';
import { decideAutoConnect, vpnState } from '../vpn/state.svelte';
import { appEvents } from '../lib/events';
import { account } from '../settings/account.svelte';
import { isApplePlatform } from '../lib/platform';
import { displayUrl, hostOf, parseOmnibox } from '../lib/url';
import { registerClearer } from '../settings/clearers';
import { registerFeature } from '../settings/features';
import type { PermissionValue } from '../settings/schema';
import { settings } from '../settings/store.svelte';
import { library, onLibrary, VisitGate, type BrowserLibrary } from '../shared/browser-data';
import { SiteExposure, type ExposureReason } from '../extensions/app/exposure';
import { BlockerKey } from '../extensions/app/key';
import { FilterListing } from '../extensions/app/listing.svelte';
import { filterListRefs } from '../extensions/app/lists';
import { SessionStats } from '../extensions/app/stats.svelte';
import { freshStartCookieDeletes } from '../extensions/cookies/fresh-start';
import { parseBlockerDetail } from '../extensions/core/detail';
import { blockerStateCopy } from './ui/error-copy';
import {
  LIMITS,
  normalizeHttpUrl,
  TIMEOUTS,
  type AnyEventMessage,
  type BlockerStats,
  type Capability,
  type CommandPayload,
  type CommandResult,
  type EngineHostStatus,
  type EngineId,
  type EnginePermissionSet,
  type EventMap,
  type InitPayload,
  type InitResult,
  type TabStart,
  type VpnVerifyResult,
  type WispRoute,
} from '../shared/engine-protocol';
import { decideOpen, enginePermissionsFor, resolveEnginePermissions, ruleFor, type ResolvedPermissions } from '../shared/site-rules';
import { setBridge, type OpenOptions } from './bridge';
import { compromiseSignals, EngineClient, EngineCommandError, type EngineClientState, type ProtocolCounters } from './engine/client';
import { createDomEmbedder, type DomEmbedder } from './engine/embed';
import { engineFacts, rememberEngineFacts } from './engine/facts.svelte';
import { buildEngineSettings, chooseRoute, NO_VPN_LOCATION } from './engine/snapshot';
import { sameRoute, TicketMinter, type MintOutcome } from './engine/tickets';
import { detectStart, isFreshStart, loadSession, saveSession } from './session';
import { parseSession, TabModel, type Tab } from './tabs.svelte';

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
const SNAPSHOT_DEBOUNCE_MS = 250;
/** `unknown-profile` (§6.6): /api/config is refreshed at most this often because of it. */
const PROFILE_REFRESH_MIN_MS = 30_000;
const LOG_RING = 200;
/**
 * After a gesture-backed open, how long the same tab's next tab.openRequest counts as having no gesture (#onOpenRequest):
 * longer than one click's burst of window.open calls, shorter than a person's next click.
 */
export const GESTURE_OPEN_WINDOW_MS = 1000;

export type TicketNotice = { kind: 'login' | 'access-code'; message: string } | null;
export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matches: number;
  active: number;
  capped: boolean;
  busy: boolean;
}

const ENGINE_LABEL: Record<EngineId, string> = { scramjet: 'Scramjet', ultraviolet: 'Ultraviolet' };
export const engineLabel = (e: EngineId): string => ENGINE_LABEL[e];
export const otherEngine = (e: EngineId): EngineId => (e === 'scramjet' ? 'ultraviolet' : 'scramjet');

function appActivation(): boolean | null {
  if (typeof navigator === 'undefined') return null;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : null;
}

class Browser {
  readonly model = new TabModel();
  engineState: EngineClientState = $state('idle');
  engineDetail: string | null = $state(null);
  status: EngineHostStatus | null = $state.raw(null);
  ticketNotice: TicketNotice = $state(null);
  updateNotice = $state(false);
  find: FindState = $state({ open: false, query: '', caseSensitive: false, matches: 0, active: 0, capped: false, busy: false });
  downloadsOpen = $state(false);
  /** The browser view (/browse) is the visible route. */
  visible = $state(false);
  counters: ProtocolCounters | null = $state.raw(null);
  readonly log: Array<EventMap['log'] & { at: number }> = [];
  /** Download ids recorded for the current engine-host instance. */
  readonly downloads = new SvelteSet<string>();
  /** The DOM seam of the engine client (a fake engine host in unit tests: src/browser/testing). */
  embedder: DomEmbedder = createDomEmbedder();
  /** Omnibox focus requests (incremented; the toolbar focuses on change). */
  focusOmniboxTick = $state(0);
  bookmarkEditor: { url: string; title: string } | null = $state(null);

  // ── Content blocking, app side (WAVE-B3 §7.1) ──
  /** Which sites' allowlist/per-site rules the engine host may receive (D5): one per app page, across engine hosts. */
  readonly exposure = new SiteExposure();
  /** The blocker's cache key (D6), sent in `init`, replaced when site data is cleared and after compromise signals. */
  readonly blockerKey = new BlockerKey();
  /** The `/api/filters` listing (names, licenses, hashes) the list refs are built from. */
  readonly filterListing = new FilterListing({ autoUpdate: () => settings.value.extensions.autoUpdateLists });
  /** This session's block counts (nothing persisted). */
  readonly blockStats = new SessionStats();
  /** The last `blocker.stats` answer of the current engine host (the Extensions page). */
  blockerStats: BlockerStats | null = $state.raw(null);
  /** Site rules are paused in this app page: two compromise signals were seen (D5). */
  siteRulesPaused = $state(false);

  #client: EngineClient | null = null;
  #minter: TicketMinter | null = null;
  #gate = new VisitGate();
  #closedAt = new Map<number, number>();

  /** A tab left the engine host (closed or discarded): its in-flight events drop silently for closedTabGraceMs. */
  #markClosed(id: number): void {
    const now = Date.now();
    // Older entries no longer matter (their events count as unknown ids): keep the map small in a long session.
    for (const [k, at] of this.#closedAt) if (now - at >= TIMEOUTS.closedTabGraceMs) this.#closedAt.delete(k);
    this.#closedAt.set(id, now);
  }
  #watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  #resyncs = new Map<number, ReturnType<typeof setTimeout>>();
  #snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSnapshot = '';
  #permissions: ResolvedPermissions = resolveEnginePermissions({}, {});
  /** The settings object #permissions was resolved from (settings values are replaced, never mutated). */
  #permissionsFrom: object | null = null;
  #interactiveStart = false;
  #started = false;
  #initialized: Promise<void> | null = null;
  #clearOnStart: { cookies: boolean; siteData: boolean } = { cookies: false, siteData: false };
  /** True unless a fresh start still has to clear history ("clear history when GNOME closes"). */
  #freshStartApplied = true;
  /** Compromise signals already answered with a key rotation (D6). */
  #signalsSeen = 0;
  /** The last list problem `status.blocker` reported (the listing is asked for again once per problem). */
  #listProblem: string | null = null;
  /** A fresh start whose "until GNOME closes" cookie deletes (WAVE-B3 §6.1, §7.1) the first engine host still has to run. */
  #freshCookieDeletes = false;
  /** Those deletes in flight: no tab is created before they are done (the restored tab's first request is clean). */
  #cookieDeletesDone: Promise<void> | null = null;
  #fallbackHref = new Map<number, { https: string; http: string }>();
  /** When each tab's page last opened a tab with a gesture (#onOpenRequest). */
  #gestureOpenAt = new Map<number, number>();
  #switched = new Map<number, EventMap['tab.engineSwitched']>();
  /**
   * `/api/vpn/locations` statuses (app origin): the app's own facts about the VPN route (ENGINE-PROTOCOL §6.4,
   * §6.13). One source of truth (WAVE-C §8.1): the VPN state's poll (vpn/state.svelte.ts), health status only (D14).
   */
  get #vpnStatus(): Readonly<Record<string, 'up' | 'down' | 'unknown'>> {
    return vpnState().statusMap();
  }
  /** The Automatic location this app page pinned (D17); null until one was picked, and again after the VPN went off. */
  #autoPinned: string | null = $state(null);
  /** The route of the ticket the engine host holds (D23); null before the first. */
  #ticketRoute: TicketRoute | null = null;
  /** A fresh start whose auto-connect decision waits for /api/config (made before the engine host is created). */
  #autoConnectPending = false;
  /** Tabs that were live before the last route change and have not loaded a page since (the VPN page's line). */
  #previousRouteTabs = $state.raw<ReadonlySet<number>>(new Set());
  #offs: Array<() => void> = [];

  // ── Start-up ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Idempotent: registers the bridge and shortcuts, restores the session. The engine iframe waits for the view. */
  start(): Promise<void> {
    this.#initialized ??= this.#start();
    return this.#initialized;
  }

  async #start(): Promise<void> {
    this.#offs.push(setBridge({ id: 'browser', openUrl: (h, o) => void this.openUrl(h, o), openInternal: (p) => void navigate(p), focusOmnibox: () => this.focusOmnibox() }));
    this.#registerShortcuts();
    this.#offs.push(
      registerClearer({
        id: 'closedTabs',
        label: 'Recently closed tabs',
        description: 'Tabs you can reopen.',
        order: 50,
        clear: () => {
          this.model.closed.length = 0;
        },
      }),
    );
    onForwardedShortcut((outcome) => {
      if (outcome === 'refused-activation' || outcome === 'refused-rate') this.#client?.count('refusedShortcuts');
    });
    this.#offs.push(
      $effect.root(() => {
        // Settings, the server's config or the filter-list listing changed: a new snapshot (debounced).
        $effect(() => {
          void settings.value;
          void server.config;
          void this.filterListing.listing;
          untrack(() => this.#scheduleSnapshot());
        });
        // Session: written a moment after any change of the tabs, never before start() has read the stored one (a
        // fresh start waits for /api/config first, §8.1: an early write of the still-empty tab list replaced the
        // stored tabs it was about to restore).
        let saveTimer: ReturnType<typeof setTimeout> | null = null;
        const save = (): void => {
          saveTimer = this.#started ? null : setTimeout(save, 800);
          if (this.#started) void saveSession(this.model.snapshot());
        };
        $effect(() => {
          const snap = this.model.snapshot(0);
          void JSON.stringify(snap);
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(save, 800);
        });
        // VPN location status for the route choice (kill switch rules) and error wording: the VPN state's poll.
        $effect(() => {
          void this.#vpnStatus;
          untrack(() => this.#scheduleSnapshot());
        });
      }),
    );
    const discardTimer = setInterval(() => this.#applyDiscards(), 30_000);
    this.#offs.push(() => clearInterval(discardTimer));
    if (typeof document !== 'undefined') {
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') this.#resyncLoading();
      };
      document.addEventListener('visibilitychange', onVisible);
      this.#offs.push(() => document.removeEventListener('visibilitychange', onVisible));
      const onFs = (): void => {
        if (!document.fullscreenElement) for (const t of this.model.tabs) t.fullscreen = false;
        shell.immersive = !!document.fullscreenElement && (document.fullscreenElement === this.embedder.element || document.fullscreenElement === document.documentElement);
      };
      document.addEventListener('fullscreenchange', onFs);
      this.#offs.push(() => document.removeEventListener('fullscreenchange', onFs));
    }
    // Signed in, or a session was created (access code): a ticket mint that needed credentials can work now.
    this.#offs.push(
      appEvents.on('session:changed', () => {
        if (this.ticketNotice) void this.#renewTicket(true);
      }),
    );
    this.#offs.push(
      $effect.root(() => {
        $effect(() => {
          if (account.user && untrack(() => this.ticketNotice?.kind === 'login')) untrack(() => void this.#renewTicket(true));
        });
      }),
    );
    this.#offs.push(
      onLibrary((lib) => {
        if (lib) void this.#applyClearOnExitHistory(lib);
      }),
    );

    await settings.ready;
    // The filter-list listing (stored copy, then a refresh as autoUpdateLists allows; hourly while open).
    void this.filterListing.start();
    this.#offs.push(() => this.filterListing.stop());
    const kind = await detectStart();
    const fresh = isFreshStart(kind);
    // Auto-connect (WAVE-C D12, §8.1): decided here, before any tab is made live or a deep link opens (both wait for
    // this start); without /api/config yet, right before the engine host is created (#ensureEngine).
    if (fresh) {
      if (!server.config) await server.refresh().catch(() => undefined);
      if (server.config) this.#decideAutoConnect();
      else this.#autoConnectPending = true;
    }
    const s = settings.value;
    if (fresh) {
      this.#clearOnStart = { cookies: s.browser.cookies.clearOnExit, siteData: s.privacy.clearSiteDataOnExit };
      this.#freshCookieDeletes = true;
      // History is cleared once the library is there (now, or when it registers: the onLibrary listener above).
      this.#freshStartApplied = !s.privacy.clearHistoryOnExit;
      const lib = library();
      if (lib) await this.#applyClearOnExitHistory(lib);
    }
    // A reload keeps the tabs it had; a fresh start follows browser.startup.
    const restore = !kind.firstInTab || s.browser.startup === 'restore';
    if (restore) {
      const snap = parseSession(await loadSession(), (u) => normalizeHttpUrl(u));
      if (snap) {
        for (const t of snap.tabs) {
          const tab = this.model.create({ url: t.url, entries: t.entries, index: t.index, title: t.title, pinned: t.pinned });
          if (tab && tab.url) tab.discarded = true;
          if (tab) for (const u of tab.entries) this.#expose(u, tab.id, 'restore');
        }
        const active = this.model.tabs[snap.active];
        if (active) this.model.activate(active.id);
      }
    } else if (s.browser.startup === 'urls') {
      for (const raw of s.browser.startupUrls) {
        const url = normalizeHttpUrl(raw);
        if (url) {
          const tab = this.model.create({ url });
          if (tab) {
            tab.discarded = true;
            // The user's own start-up pages: GNOME's loads (D5), exposed now as the stored session's entries are.
            this.#expose(url, tab.id, 'gnome-load');
          }
        }
      }
    }
    this.#started = true;
    // Everything the browser-gated settings rows promise is implemented by this module and the engine host.
    this.#offs.push(registerFeature('browser'));
    // The built-in extensions (WAVE-B3): their settings rows act through the engine host's `blocker` capability,
    // offered since the step-3 integration (§12.4), so they register right after the browser.
    this.#offs.push(registerFeature('extensions'));
    if (this.visible) this.#ensureActiveLive();
  }

  /** The fresh start's auto-connect decision (once): turns the switch on before the first snapshot is built. */
  #decideAutoConnect(): void {
    this.#autoConnectPending = false;
    const offered = server.config?.wisp.profiles.length ?? 0;
    if (decideAutoConnect(true, settings.value.vpn, offered)) settings.set('vpn', 'mode', 'gateway');
  }

  async #applyClearOnExitHistory(lib: BrowserLibrary): Promise<void> {
    if (this.#freshStartApplied) return;
    this.#freshStartApplied = true;
    try {
      await lib.history.clear();
    } catch {
      toast.error('Could not clear history', { description: 'Local storage is unavailable.' });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.#client?.setVisible(visible);
    if (visible) {
      this.#ensureActiveLive();
      this.#resyncLoading();
    }
  }

  setContainer(el: HTMLElement | null): void {
    this.embedder.setContainer(el);
  }

  // ── Engine host ────────────────────────────────────────────────────────────────────────────────────────────────

  get capabilities(): readonly Capability[] {
    return engineFacts.capabilities;
  }

  hasCapability(c: Capability): boolean {
    return this.engineState === 'ready' && engineFacts.capabilities.includes(c);
  }

  /**
   * The VPN location pages are routed through now (null off the profile route), with what the app itself knows about
   * it: `/api/vpn/locations` (down, up, unknown) and `/api/config` (`gone`: no longer offered). The error overlay
   * words gateway and network failures with it (ENGINE-PROTOCOL §6.4); nothing an engine event says changes it.
   */
  get vpnLocation(): { id: string; label: string; status: 'up' | 'down' | 'unknown' | 'gone' | 'none' } | null {
    const { route } = this.#routeChoice();
    if (route.kind !== 'profile') return null;
    if (route.id === NO_VPN_LOCATION) return { id: route.id, label: '', status: 'none' };
    const profile = server.config?.wisp.profiles.find((p) => p.id === route.id);
    if (server.config && !profile) return { id: route.id, label: route.id, status: 'gone' };
    return { id: route.id, label: profile?.label || route.id, status: this.#vpnStatus[route.id] ?? 'unknown' };
  }

  #routeChoice(): ReturnType<typeof chooseRoute> {
    return chooseRoute(settings.value, { config: server.config, blocker: false, apple: false, vpnStatus: this.#vpnStatus, autoPinned: this.#autoPinned });
  }

  /**
   * Keeps the Automatic location pinned for this app page (D17) and says when it moved: called with each snapshot
   * (never from a getter). A chosen location or the VPN off clears the pin.
   */
  #updatePin(choice: ReturnType<typeof chooseRoute>): void {
    const s = settings.value.vpn;
    if (s.mode !== 'gateway' || s.preferredLocation !== null) {
      if (this.#autoPinned !== null) this.#autoPinned = null;
      return;
    }
    const picked = choice.autoPicked;
    if (picked === null || picked === this.#autoPinned) return;
    const before = this.#autoPinned;
    this.#autoPinned = picked;
    if (before !== null && this.#vpnStatus[before] === 'down') {
      const label = (id: string): string => server.config?.wisp.profiles.find((p) => p.id === id)?.label || id;
      toast.warning('VPN location changed', { description: `VPN location changed: ${label(before)} is down. Now using ${label(picked)}.`, id: 'vpn-auto-moved' });
    }
  }

  /** The ticket route for an engine route (D23); null when there is nothing to mint for (no VPN location at all). */
  #ticketRouteOf(route: WispRoute): TicketRoute | null {
    if (route.kind !== 'profile') return 'default';
    return route.id === NO_VPN_LOCATION ? null : { profile: route.id };
  }

  /** A mint for the route the app chose now (D23); remembers the route of every ticket handed over. */
  async #mint(interactive: boolean, route: TicketRoute | null = this.#ticketRouteOf(this.#routeChoice().route)): Promise<MintOutcome> {
    if (!this.#minter) return { ok: false, reason: 'error', message: 'The browser engine is not running.' };
    if (route === null) return { ok: false, reason: 'error', message: 'No VPN location to route through.' };
    const out = await this.#minter.request(interactive, route);
    if (out.ok) this.#ticketRoute = out.route;
    return out;
  }

  /** Tabs that may still use the previous route until they are reloaded (the VPN page's persistent line, §8.1). */
  get previousRouteTabs(): number {
    return this.#previousRouteTabs.size;
  }

  #pageLoaded(id: number): void {
    if (!this.#previousRouteTabs.has(id)) return;
    const next = new Set(this.#previousRouteTabs);
    next.delete(id);
    this.#previousRouteTabs = next;
  }

  /**
   * The route changed (D23): a ticket for the new route goes to the engine host before the snapshot that switches
   * it; the tabs live now are counted as "on the previous route" until they load a page.
   */
  async #switchRoute(route: TicketRoute): Promise<void> {
    this.#previousRouteTabs = new Set(this.model.tabs.filter((t) => t.live && t.url).map((t) => t.id));
    const out = await this.#mint(false, route);
    if (out.ok) {
      this.ticketNotice = null;
      await this.#send('ticket', out.ticket).catch((err: unknown) => this.#logError('ticket', err));
    } else if (out.reason === 'credentials') this.#needCredentials(out.kind, out.message);
    this.#flushSnapshot(true);
  }

  /** A connected, initialized engine host (it may be slow to answer: `unresponsive` still takes commands). */
  #engineUp(): boolean {
    return this.engineState === 'ready' || this.engineState === 'unresponsive';
  }

  /** Creates the engine host on first need (a proxied tab in the visible browser view). */
  #ensureEngine(interactive: boolean): EngineClient | null {
    if (this.#client) return this.#client;
    if (!server.config) {
      // Not loaded yet (or the server is unreachable): try again once it answers. The view shows "starting".
      this.engineState = 'starting';
      this.engineDetail = null;
      void server.refresh().then(() => {
        if (server.config && this.visible) this.#ensureActiveLive();
        else if (!server.config) {
          this.engineState = 'failed';
          this.engineDetail = server.error ?? 'GNOME’s server is not reachable.';
        }
      });
      return null;
    }
    const origin = server.config.proxy.origin;
    if (!origin) {
      this.engineState = 'failed';
      this.engineDetail = 'The server did not name its proxy origin, so the browser engine cannot start.';
      return null;
    }
    // A fresh start's auto-connect decision that waited for /api/config: made before the engine host exists.
    if (this.#autoConnectPending) this.#decideAutoConnect();
    this.#interactiveStart = interactive;
    this.#minter = new TicketMinter({ mint: (o) => requestWispTicket(o), ttlMs: () => (server.config?.wisp.ticket_ttl_s ?? 3600) * 1000 });
    const client = new EngineClient({
      embedder: this.embedder,
      proxyOrigin: origin,
      buildInit: () => this.#buildInit(),
      tabStatus: (id) => {
        const t = this.model.get(id);
        if (t?.live) return 'known';
        const at = this.#closedAt.get(id);
        return at !== undefined && Date.now() - at < TIMEOUTS.closedTabGraceMs ? 'closed' : 'unknown';
      },
      downloadStatus: (id) => this.#downloadStatus(id),
      onEvent: (m) => this.#onEvent(m),
      onRateLimited: (id, msg) => {
        if (msg.type === 'tab.openRequest') {
          // Over the openRequest budget: never opened, but listed in the pop-up indicator (a gesture there opens it).
          const opener = this.model.get(msg.p.openerTabId);
          if (opener) this.#holdPopup(opener, msg.p.url);
          return;
        }
        this.#scheduleResync(id, 1000);
      },
      onReady: (r, first) => this.#onReady(r, first),
      onReset: (_reason, instance) => this.#onReset(instance),
      onStateChange: (state, detail) => {
        this.engineState = state;
        this.engineDetail = detail;
        this.#reportEngine();
      },
      onCounters: (c) => {
        this.counters = { ...c };
        this.#reportCounters();
        this.#onCompromise(compromiseSignals(c));
      },
    });
    this.#client = client;
    client.setVisible(this.visible);
    client.start();
    return client;
  }

  async #buildInit(): Promise<InitPayload> {
    const outcome = await this.#mint(this.#interactiveStart);
    this.#interactiveStart = false;
    if (!outcome.ok && outcome.reason === 'credentials') this.#needCredentials(outcome.kind, outcome.message);
    if (outcome.ok) this.ticketNotice = null;
    const snap = this.#snapshot();
    this.#lastSnapshot = JSON.stringify(snap);
    const clear = this.#clearOnStart;
    // Applied once per fresh start, by the first engine host only.
    this.#clearOnStart = { cookies: false, siteData: false };
    // "Clear site data on exit" deletes the blocker's cache too: the init that does it carries a new key (D6).
    const blockerKey = clear.siteData ? await this.blockerKey.rotate('clear-on-start') : await this.blockerKey.get();
    return { settings: snap, ticket: outcome.ok ? outcome.ticket : null, clearOnStart: clear, blockerKey };
  }

  #snapshot(): InitPayload['settings'] {
    const s = settings.value;
    const listing = this.filterListing.listing;
    this.#updatePin(this.#routeChoice());
    return buildEngineSettings(s, {
      config: server.config,
      blocker: this.hasCapability('blocker'),
      apple: isApplePlatform(),
      vpnStatus: this.#vpnStatus,
      autoPinned: this.#autoPinned,
      lists: listing ? filterListRefs(listing, s) : [],
      scope: this.exposure,
    });
  }

  /**
   * Sends the snapshot now when it changed (or always, `force`): before a GNOME-initiated load whose site joined the
   * scope (D5: its rules must be in place before the load command), and as the answer to every `tab.loading.url`.
   */
  #flushSnapshot(force = false): void {
    if (!this.#client || !this.#engineUp()) return;
    const snap = this.#snapshot();
    const text = JSON.stringify(snap);
    if (!force && text === this.#lastSnapshot) return;
    if (this.#snapshotTimer) {
      clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    this.#lastSnapshot = text;
    this.#client.send('settings', { settings: snap }).catch((err: unknown) => this.#logError('settings', err));
    // Sent at once (a load command follows); a route change gets its ticket right after (the engine host re-mints
    // through needTicket if it connects before it arrives).
    const route = this.#ticketRouteOf(snap.route);
    if (route && this.#ticketRoute && !sameRoute(route, this.#ticketRoute)) void this.#switchRoute(route);
  }

  /** A site the engine host loads or is about to load (D5); GNOME's own loads flush the snapshot before their command. */
  #expose(url: string, tabId: number | null, reason: ExposureReason): void {
    const r = this.exposure.expose(url, tabId, reason, settings.value.extensions);
    if (r === 'dropped') this.#client?.count('droppedExposures');
    // Within the budget the site's rules go out before the load command, whoever started the load.
    if (r === 'added') this.#flushSnapshot();
  }

  #scheduleSnapshot(): void {
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = null;
      if (this.engineState !== 'ready' || !this.#client) return;
      const snap = this.#snapshot();
      const text = JSON.stringify(snap);
      if (text === this.#lastSnapshot) return;
      const choice = this.#routeChoice();
      if (choice.vpnFellBack) toast.warning('VPN location unavailable', { description: 'Pages load through GNOME’s own connection until the location is back.', id: 'vpn-fallback' });
      // A route change: the new route's ticket first, then the snapshot that switches it (D23).
      const route = this.#ticketRouteOf(snap.route);
      if (route && this.#ticketRoute && !sameRoute(route, this.#ticketRoute)) {
        void this.#switchRoute(route);
        return;
      }
      this.#lastSnapshot = text;
      this.#client.send('settings', { settings: snap }).catch((err: unknown) => this.#logError('settings', err));
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  #offSiteData: (() => void) | null = null;

  #onReady(r: InitResult, first: boolean): void {
    rememberEngineFacts(r);
    // "Cookies and site data" in Settings → Privacy → Clear browsing data, where the engine host can clear them.
    this.#offSiteData?.();
    this.#offSiteData = r.capabilities.includes('siteData')
      ? registerClearer({
          id: 'siteData',
          label: 'Cookies and site data',
          description: 'Cookies and storage of sites opened in GNOME. Signs you out of most sites.',
          order: 20,
          clear: async () => {
            await this.clearSiteData(['cookies', 'storage', 'cache']);
          },
        })
      : null;
    this.status = r.status;
    this.blockerStats = null;
    this.#reportTransport(r.status);
    this.#reportBlocker(r.status);
    this.#checkUpdate(r.status);
    this.downloads.clear();
    this.#downloadsSeen.clear();
    // Re-create the tabs that were live before a reset (from the app's own copy of their entries); on the first start
    // only the active tab becomes live.
    const wanted = first ? [] : this.model.tabs.filter((t) => t.live);
    for (const t of this.model.tabs) t.live = false;
    // With a content blocker (WAVE-B3 §7.1): first the snapshot with the scoped site maps and the cookie rules, which
    // `init` could not carry (the app learns `blocker` from init's result), then the restore.
    if (r.capabilities.includes('blocker')) this.#flushSnapshot();
    // Then, at a fresh start, the cookies of sites with an "until GNOME closes" rule go (both engines' jars), and only
    // then are tabs restored (#makeLive waits for them).
    if (this.#freshCookieDeletes) {
      this.#freshCookieDeletes = false;
      const deletes = r.capabilities.includes('cookies') ? freshStartCookieDeletes(settings.value.extensions) : [];
      if (deletes.length) {
        this.#cookieDeletesDone = (async () => {
          for (const d of deletes) await this.#send('cookies.delete', d).catch((err: unknown) => this.#logError('cookies.delete', err));
        })().finally(() => {
          this.#cookieDeletesDone = null;
        });
      }
    }
    for (const t of wanted) void this.#makeLive(t);
    this.#ensureActiveLive();
    this.#scheduleSnapshot();
  }

  #onReset(instance: string | null): void {
    for (const id of this.#watchdogs.keys()) this.#clearWatchdog(id);
    if (instance) void library()?.downloads.instanceEnded(instance).catch(() => undefined);
    this.downloads.clear();
    this.#downloadsSeen.clear();
    for (const t of this.model.tabs) {
      t.loading = false;
      t.navStartedAt = null;
    }
  }

  /** Retry / Restart buttons (gestures in GNOME's UI). */
  restartEngine(reason: 'retry' | 'restart' = 'restart'): void {
    if (!this.#client) {
      this.#ensureEngine(true);
      return;
    }
    this.#interactiveStart = true;
    this.#client.restart(reason);
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────────────────────────────────────────

  get tabs(): Tab[] {
    return this.model.tabs;
  }

  get active(): Tab | null {
    return this.model.active;
  }

  permissionsFor(url: string): EnginePermissionSet {
    const p = settings.value.privacy;
    if (this.#permissionsFrom !== p) {
      this.#permissionsFrom = p;
      this.#permissions = resolveEnginePermissions(p.defaultPermissions, p.sitePermissions);
    }
    return enginePermissionsFor(this.#permissions, url);
  }

  #defaultZoom(): number {
    return settings.value.browser.defaultZoom;
  }

  /** Opens a new tab with the new-tab setting (home, blank, or an address). */
  newTab(opts: { background?: boolean } = {}): Tab | null {
    const b = settings.value.browser;
    if (b.newTab === 'url' && b.newTabUrl) {
      const url = normalizeHttpUrl(b.newTabUrl);
      if (url) return this.openUrl(url, { newTab: true, ...(opts.background ? { background: true } : {}) });
    }
    const tab = this.model.create({ url: null, activate: !opts.background, zoom: this.#defaultZoom() });
    if (!tab) {
      this.#tooManyTabs();
      return null;
    }
    if (!opts.background) {
      this.#show();
      this.#activate(tab.id);
      this.focusOmnibox();
    }
    return tab;
  }

  #tooManyTabs(): void {
    toast.warning('Too many tabs', { description: `GNOME keeps at most ${LIMITS.maxTabs} tabs per page. Close some to open more.`, id: 'too-many-tabs' });
  }

  #show(): void {
    if (typeof window !== 'undefined' && router.current?.route.id !== 'browse') void navigate('/browse');
  }

  /** BrowserBridge.openUrl and every user-started navigation. */
  /**
   * `fromPage`: the link came from that tab's page (its context menu): a new tab's first load is then the page's
   * navigation (start.opener), as a browser makes "Open link in new tab", never GNOME's own (ENGINE-PROTOCOL §6.1).
   */
  openUrl(href: string, opts: OpenOptions & { engine?: EngineId; openerId?: number; fromPage?: boolean } = {}): Tab | null {
    if (href === 'about:blank') return this.newTab(opts.background ? { background: true } : {});
    const url = normalizeHttpUrl(href);
    if (!url) {
      toast.error('Cannot open this address', { description: 'GNOME opens http and https addresses.' });
      return null;
    }
    const current = this.model.active;
    // The active tab is reused for its new-tab page, and for navigations started in the visible browser view
    // (address bar, Retry); from other GNOME pages a page opens in a new tab instead of replacing one.
    const reuse = !opts.newTab && current && (!current.url || (this.visible && !current.pinned)) ? current : null;
    let tab: Tab | null = reuse;
    if (!tab) {
      tab = this.model.create({ url: null, activate: !opts.background, after: opts.openerId ?? null, openerId: opts.openerId ?? null, zoom: this.#defaultZoom() });
      if (!tab) {
        this.#tooManyTabs();
        return null;
      }
      const page = opts.fromPage && opts.openerId != null ? this.model.get(opts.openerId) : undefined;
      const pageUrl = page?.url ? normalizeHttpUrl(page.url) : null;
      if (pageUrl) tab.pageOpen = { url, opener: pageUrl };
    }
    if (opts.fallbackHref) this.#fallbackHref.set(tab.id, { https: url, http: opts.fallbackHref });
    else this.#fallbackHref.delete(tab.id);
    if (!opts.background) {
      this.#show();
      this.#activate(tab.id);
    }
    // A user navigation (address bar, GNOME's pages, menus) may mint interactively; one a forwarded key started
    // (`home`, `newTab` with an address) may not (§1.2 rule 9).
    this.#navigateTab(tab, url, opts.engine ?? null, !isForwardedDispatch());
    return tab;
  }

  /** Omnibox submit (address or search) in the active tab. */
  submitOmnibox(input: string, opts: { newTab?: boolean } = {}): void {
    const b = settings.value.browser;
    const r = parseOmnibox(input, { searchEngine: b.searchEngine, customSearchUrl: b.customSearchUrl });
    if (!r) return;
    const active = this.model.active;
    if (active) active.draft = null;
    if (r.kind === 'internal') {
      void navigate(r.href);
      return;
    }
    this.openUrl(r.href, { ...(opts.newTab ? { newTab: true } : {}), ...(r.fallbackHref ? { fallbackHref: r.fallbackHref } : {}) });
  }

  /**
   * `reason`: how the destination's site joins the scope of the site maps (WAVE-B3 D5): GNOME's own loads always do
   * (`gnome-load`); the first load of a tab a page opened is the page's navigation (`nav-start`, budgeted). The
   * destination joins the scope here, also when the tab becomes live only later (#makeLive budgets what it re-sends).
   */
  #navigateTab(tab: Tab, url: string, engine: EngineId | null, user: boolean, reason: ExposureReason = 'gnome-load'): void {
    // A navigation the user starts while a mint needed credentials is a gesture: mint interactively first (it may ask
    // for the access code), then load (ENGINE-PROTOCOL §6.5).
    if (user && this.ticketNotice && this.#minter) {
      void this.#userMint().then(() => this.#navigateTab(tab, url, engine, false, reason));
      return;
    }
    tab.error = null;
    tab.draft = null;
    tab.blockedPopups = [];
    if (!tab.live) {
      // Not in the engine host yet: becomes live with this URL when the view shows it.
      tab.url = url;
      tab.entries = tab.discarded && tab.entries.length ? [...tab.entries.slice(0, tab.index + 1), url].slice(-LIMITS.maxTabHistory) : [url];
      tab.index = tab.entries.length - 1;
      tab.discarded = true;
      tab.title = displayUrl(url);
      tab.favicon = null;
      this.#expose(url, tab.id, tab.pageOpen?.url === url ? 'nav-start' : reason);
      if (this.visible) void this.#makeLive(tab, user, engine);
      return;
    }
    if (!this.#engineUp()) {
      // The engine host is being replaced (Retry, "Restart browser engine", unexpected-load recovery): #onReady
      // re-creates its live tabs from their entries, so the navigation goes there instead of failing as not_ready.
      tab.url = url;
      tab.entries = [...tab.entries.slice(0, tab.index + 1), url].slice(-LIMITS.maxTabHistory);
      tab.index = tab.entries.length - 1;
      tab.canGoBack = tab.index > 0;
      tab.canGoForward = false;
      tab.title = displayUrl(url);
      tab.favicon = null;
      this.#expose(url, tab.id, reason);
      return;
    }
    tab.loading = true;
    tab.navStartedAt = Date.now();
    this.#expose(url, tab.id, reason);
    this.#send('tab.navigate', { tabId: tab.id, url, engine, permissions: this.permissionsFor(url) })
      .then((r) => this.#navStarted(tab.id, r.navId, r.engine))
      .catch((err: unknown) => this.#commandFailed(tab.id, err));
  }

  #navStarted(tabId: number, navId: number | null, engine: EngineId | null): void {
    const t = this.model.get(tabId);
    if (!t) return;
    if (navId !== null) {
      t.navId = navId;
      t.navStartedAt ??= Date.now();
      this.#armWatchdog(tabId, navId);
    }
    if (engine) t.engine = engine;
  }

  #commandFailed(tabId: number, err: unknown): void {
    const t = this.model.get(tabId);
    if (t) {
      t.loading = false;
      t.navStartedAt = null;
    }
    if (err instanceof EngineCommandError && err.code === 'not_ready') return;
    if (err instanceof EngineCommandError && err.code === 'no_tab' && t) {
      t.live = false;
      t.discarded = true;
      if (this.visible && this.model.activeId === tabId) void this.#makeLive(t);
      return;
    }
    this.#logError('command', err);
  }

  /** Makes the active proxied tab live (engine started on demand). */
  #ensureActiveLive(): void {
    if (!this.#started || !this.visible) return;
    const t = this.model.active;
    if (t?.url && !t.live) void this.#makeLive(t);
    else if (this.engineState === 'ready') this.#send('tab.activate', { tabId: t?.live ? t.id : null }).catch(() => undefined);
  }

  /** tab.create for a tab with a URL (restore from its entries when it has more than one, or was discarded). */
  async #makeLive(t: Tab, interactive = false, engine: EngineId | null = null): Promise<void> {
    if (!t.url || t.live) return;
    const client = this.#ensureEngine(interactive);
    if (!client) return;
    if (this.engineState !== 'ready') return; // onReady makes the active tab live
    if (this.#cookieDeletesDone) {
      await this.#cookieDeletesDone;
      if (!t.url || t.live || this.engineState !== 'ready') return;
    }
    if (this.model.tabs.filter((x) => x.live).length >= LIMITS.maxLiveTabs) this.#applyDiscards(true);
    const entries = t.entries.length ? t.entries : [t.url];
    const index = Math.min(t.index, entries.length - 1);
    let start: TabStart = entries.length > 1 ? { kind: 'restore', entries: [...entries], index } : { kind: 'url', url: entries[index]! };
    // The first load of a tab a page asked for (and only that URL: the user may have typed another one meanwhile).
    const pageOpen = t.pageOpen;
    if (pageOpen && start.kind === 'url' && start.url === pageOpen.url) start = { ...start, opener: pageOpen.opener };
    t.live = true;
    t.discarded = false;
    t.loading = true;
    t.error = null;
    t.navStartedAt = Date.now();
    this.#closedAt.delete(t.id);
    // Every entry joins the scope like the commit it came from (WAVE-B3 D5, budgeted): what was exposed before costs
    // nothing, and what the budget refused stays out also when the tab is created again (after an engine-host
    // replacement the budget carries over, §10.3; a discarded tab made live by a forwarded key). GNOME's own loads
    // exposed their destination with their reason already (#navigateTab, go, reload, duplicate, reopenClosed), the
    // stored session's entries and the start-up pages at the start (browser-exposure.test.ts).
    for (const u of entries) this.#expose(u, t.id, 'commit');
    try {
      const r = await client.send('tab.create', {
        tabId: t.id,
        active: this.model.activeId === t.id,
        engine,
        zoom: t.zoom,
        start,
        permissions: this.permissionsFor(entries[index]!),
      });
      t.pageOpen = null;
      this.#navStarted(t.id, r.navId, r.engine);
      if (this.model.activeId === t.id) await client.send('tab.activate', { tabId: t.id });
    } catch (err) {
      t.live = false;
      t.discarded = true;
      t.loading = false;
      t.navStartedAt = null;
      if (err instanceof EngineCommandError && err.code === 'tab_exists') {
        t.live = true;
        return;
      }
      if (err instanceof EngineCommandError && err.code === 'too_many_tabs') {
        this.#applyDiscards(true);
        toast.warning('Too many open pages', { description: 'Unload some tabs, then try again.', id: 'too-many-live' });
        return;
      }
      this.#logError('tab.create', err);
    }
  }

  activate(id: number): void {
    this.#activate(id);
  }

  #activate(id: number): void {
    const t = this.model.get(id);
    if (!t) return;
    this.model.activate(id);
    this.find.open = false;
    // "Unload background tabs as soon as you switch away" and the live-tab cap apply at once, not only on the timer.
    queueMicrotask(() => this.#applyDiscards());
    if (!this.visible) return;
    if (t.url && !t.live) void this.#makeLive(t);
    else if (this.engineState === 'ready') this.#send('tab.activate', { tabId: t.live ? t.id : null }).catch(() => undefined);
  }

  close(id: number): void {
    const t = this.model.get(id);
    if (!t) return;
    const wasLive = t.live;
    this.model.close(id, settings.value.browser.closeTabActivates);
    this.#gate.forget(String(id));
    this.#clearWatchdog(id);
    this.#fallbackHref.delete(id);
    this.#gestureOpenAt.delete(id);
    this.exposure.forgetTab(id);
    this.blockStats.forgetTab(id);
    if (wasLive) {
      this.#markClosed(id);
      this.#send('tab.close', { tabId: id }).catch(() => undefined);
      this.#client?.forgetScope({ tabId: id });
    }
    const next = this.model.active;
    if (next) this.#activate(next.id);
    else {
      if (this.engineState === 'ready') this.#send('tab.activate', { tabId: null }).catch(() => undefined);
      // The browser view never shows zero tabs: a fresh new tab takes the last one's place.
      if (this.visible) this.newTab();
    }
  }

  async closeMany(ids: number[]): Promise<void> {
    if (ids.length > 1 && settings.value.browser.confirmCloseMultiple) {
      const { confirm } = await import('../app/overlays/dialogs.svelte');
      const ok = await confirm({ title: `Close ${ids.length} tabs?`, confirmLabel: 'Close tabs', danger: true });
      if (!ok) return;
    }
    for (const id of ids) this.close(id);
  }

  reopenClosed(): Tab | null {
    const c = this.model.popClosed();
    if (!c) return null;
    const tab = this.model.create({ url: c.url, entries: c.entries, index: c.index, title: c.title, pinned: c.pinned, activate: true, zoom: this.#defaultZoom() });
    if (!tab) {
      this.#tooManyTabs();
      return null;
    }
    this.model.move(tab.id, c.position);
    if (tab.url) {
      tab.discarded = true;
      // A gesture in GNOME's UI (its menu, or the privileged shortcut, which needs a real key press): GNOME's load (D5).
      this.#expose(tab.url, tab.id, 'gnome-load');
    }
    this.#show();
    this.#activate(tab.id);
    return tab;
  }

  duplicate(id: number): Tab | null {
    const t = this.model.get(id);
    if (!t) return null;
    const tab = this.model.create({ url: t.url, entries: t.entries, index: t.index, title: t.title, after: t.id, activate: true, zoom: t.zoom });
    if (!tab) {
      this.#tooManyTabs();
      return null;
    }
    if (tab.url) {
      tab.discarded = true;
      // A gesture in GNOME's UI (the tab menu, or the privileged shortcut, which needs a real key press): GNOME's load.
      this.#expose(tab.url, tab.id, 'gnome-load');
    }
    this.#activate(tab.id);
    return tab;
  }

  togglePin(id: number): void {
    const t = this.model.get(id);
    if (t) this.model.setPinned(id, !t.pinned);
  }

  // ── Navigation of the active tab ───────────────────────────────────────────────────────────────────────────────

  /**
   * How a Back, Forward or Reload exposes its page (WAVE-B3 D5). From GNOME's own UI (the toolbar, the menu, the error
   * page, the shield) it is GNOME's load. From a shortcut the page forwarded (`tab.key`) it is the page's navigation,
   * budgeted: these actions need no real key press (app/shortcuts.ts ORDINARY_FORWARDED), so an engine host a page
   * controls could forge commits over the budget and then "reload" each of them into the scope.
   */
  #historyLoadReason(): ExposureReason {
    return isForwardedDispatch() ? 'nav-start' : 'gnome-load';
  }

  go(delta: number, id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t?.url) return;
    const target = t.index + delta;
    const url = t.entries[target];
    if (!url) return;
    const reason = this.#historyLoadReason();
    if (!t.live || !this.#engineUp()) {
      // Discarded, or live while the engine host is replaced: the tab is (re-)created at the new entry.
      t.index = target;
      t.url = url;
      t.canGoBack = target > 0;
      t.canGoForward = target < t.entries.length - 1;
      this.#expose(url, t.id, reason);
      if (!t.live) void this.#makeLive(t);
      return;
    }
    t.error = null;
    t.loading = true;
    t.navStartedAt = Date.now();
    this.#expose(url, t.id, reason);
    this.#send('tab.go', { tabId: t.id, delta, permissions: this.permissionsFor(url) })
      .then((r) => this.#navStarted(t.id, r.navId, r.engine))
      .catch((err: unknown) => this.#commandFailed(t.id, err));
  }

  reload(id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t?.url) return;
    const reason = this.#historyLoadReason();
    if (!t.live) {
      this.#expose(t.url, t.id, reason);
      void this.#makeLive(t, true);
      return;
    }
    t.error = null;
    t.loading = true;
    t.navStartedAt = Date.now();
    this.#expose(t.url, t.id, reason);
    this.#send('tab.reload', { tabId: t.id, permissions: this.permissionsFor(t.url) })
      .then((r) => this.#navStarted(t.id, r.navId, r.engine))
      .catch((err: unknown) => this.#commandFailed(t.id, err));
  }

  stop(id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t?.live) return;
    this.#send('tab.stop', { tabId: t.id }).catch(() => undefined);
  }

  /** Error overlay: Retry (same URL, same engine choice) or "Open in <other engine>". */
  retry(id: number, engine: EngineId | null = null): void {
    const t = this.model.get(id);
    const url = t?.error?.url ?? t?.url;
    if (!t || !url) return;
    this.#navigateTab(t, url, engine, true);
  }

  // ── Find, zoom, actions ────────────────────────────────────────────────────────────────────────────────────────

  openFind(): void {
    if (!this.model.active?.live) return;
    this.find.open = true;
  }

  async findNext(query: string, backwards = false): Promise<void> {
    const t = this.model.active;
    this.find.query = query;
    if (!t?.live) return;
    if (!query) {
      await this.findClear();
      return;
    }
    this.find.busy = true;
    try {
      const r = await this.#send('tab.find', { tabId: t.id, query: query.slice(0, LIMITS.maxFindQuery), backwards, caseSensitive: this.find.caseSensitive });
      if (this.find.query !== query) return;
      this.find.matches = r.matches;
      this.find.active = r.active;
      this.find.capped = r.capped;
    } catch (err) {
      this.#logError('tab.find', err);
    } finally {
      this.find.busy = false;
    }
  }

  async findClear(close = false): Promise<void> {
    const t = this.model.active;
    this.find.matches = 0;
    this.find.active = 0;
    this.find.capped = false;
    if (close) {
      this.find.open = false;
      this.find.query = '';
    }
    if (t?.live) await this.#send('tab.findClear', { tabId: t.id }).catch(() => undefined);
  }

  zoom(direction: 1 | -1 | 0, id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t || !this.hasCapability('zoom')) return;
    let next = 1;
    if (direction === 0) next = this.#defaultZoom();
    else {
      const steps = ZOOM_STEPS as readonly number[];
      const i = steps.findIndex((s) => s >= t.zoom - 1e-6);
      const cur = i < 0 ? steps.length - 1 : i;
      next = direction > 0 ? (steps[Math.min(steps.length - 1, steps[cur]! > t.zoom + 1e-6 ? cur : cur + 1)] ?? t.zoom) : (steps[Math.max(0, cur - 1)] ?? t.zoom);
    }
    next = Math.min(LIMITS.zoomMax, Math.max(LIMITS.zoomMin, next));
    t.zoom = next;
    if (t.live) this.#send('tab.zoom', { tabId: t.id, factor: next }).then((r) => (t.zoom = r.factor)).catch((err: unknown) => this.#logError('tab.zoom', err));
  }

  action(action: 'selectAll' | 'print', id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t?.live || !this.hasCapability(action)) return;
    this.#send('tab.action', { tabId: t.id, action }).catch((err: unknown) => this.#logError('tab.action', err));
  }

  saveUrl(url: string, kind: 'link' | 'image', id = this.model.activeId): void {
    const t = id === null ? null : this.model.get(id);
    if (!t?.live || !this.hasCapability(kind === 'link' ? 'saveLink' : 'saveImage')) return;
    this.#send('tab.download', { tabId: t.id, url, kind }).catch((err: unknown) => this.#logError('tab.download', err));
  }

  /** Search suggestions through the engine host (capability `suggest`); [] when not offered or on failure. */
  async searchSuggestions(query: string, provider: import('../shared/engine-protocol').SuggestProvider): Promise<string[]> {
    if (!this.hasCapability('suggest')) return [];
    try {
      return (await this.#send('suggest', { query: query.slice(0, LIMITS.maxSuggestQuery), provider })).items;
    } catch {
      return [];
    }
  }

  /**
   * This browser's exit check (capability `vpnVerify`, command `vpn.verify`; WAVE-C §8.1): the check service's answer
   * through the current route, as the engine host reports it (not proof). null while the capability is missing, the
   * engine host is not ready, or the check failed.
   */
  async verifyExit(url: string): Promise<VpnVerifyResult | null> {
    if (!this.hasCapability('vpnVerify')) return null;
    try {
      return await this.#send('vpn.verify', { url });
    } catch {
      return null;
    }
  }

  focusOmnibox(): void {
    this.#show();
    this.focusOmniboxTick++;
  }

  editBookmark(url: string, title: string): void {
    this.bookmarkEditor = { url, title };
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  /** The passive notice's button (a gesture): the account page to sign in, or an interactive mint (access code). */
  async signIn(): Promise<void> {
    if (this.ticketNotice?.kind === 'login') {
      void navigate('/settings/account');
      return;
    }
    await this.#userMint();
  }

  /** A mint the user started (may prompt for the access code); sends the ticket on success. */
  async #userMint(): Promise<void> {
    if (!this.#minter) return;
    const out = await this.#mint(true);
    if (out.ok) {
      this.ticketNotice = null;
      await this.#send('ticket', out.ticket).catch((err: unknown) => this.#logError('ticket', err));
    } else if (out.reason === 'credentials') this.#needCredentials(out.kind, out.message);
  }

  /** The update notice's button (a gesture). */
  reloadApp(): void {
    location.reload();
  }

  #send: EngineClient['send'] = (type, payload) => {
    if (!this.#client) return Promise.reject(new EngineCommandError('not_ready', 'The browser engine is not running.'));
    return this.#client.send(type, payload);
  };

  // ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────────

  #onEvent(m: AnyEventMessage): void {
    switch (m.type) {
      case 'status':
        this.status = m.p;
        this.#reportBlocker(m.p);
        this.#reportTransport(m.p);
        this.#checkUpdate(m.p);
        this.#checkTransportNeeds(m.p);
        return;
      case 'needTicket':
        void this.#renewTicket();
        return;
      case 'tab.loading': {
        const t = this.model.get(m.p.tabId);
        if (!t) return;
        // A navigation's destination before its page loads (WAVE-B3 C3, D5): expose its site (budgeted: a page can
        // cause or forge these) and answer at once with a snapshot, also when nothing changed: the engine host holds
        // the first request of a site until this answer.
        if (m.p.url !== undefined && this.hasCapability('blocker')) {
          if (this.exposure.expose(m.p.url, t.id, 'nav-start', settings.value.extensions) === 'dropped') this.#client?.count('droppedExposures');
          this.#flushSnapshot(true);
        }
        t.loading = m.p.loading;
        if (m.p.loading) {
          t.navStartedAt = Date.now();
          if (t.navId !== null) this.#armWatchdog(t.id, t.navId);
          this.blockStats.navigationStarted(t.id);
        } else {
          t.navStartedAt = null;
          this.#clearWatchdog(t.id);
          this.blockStats.navigationEnded(t.id);
        }
        return;
      }
      case 'tab.committed':
        this.#pageLoaded(m.p.tabId);
        this.#onCommitted(m.p);
        return;
      case 'tab.loaded': {
        const t = this.model.get(m.p.tabId);
        if (!t) return;
        if (t.navId === null || t.navId === m.p.navId) {
          t.loading = false;
          t.navStartedAt = null;
          this.#clearWatchdog(t.id);
        }
        this.#fallbackHref.delete(t.id);
        const sw = this.#switched.get(t.id);
        this.#switched.delete(t.id);
        if (sw && sw.navId === m.p.navId && this.model.activeId === t.id) {
          toast.info(`Opened with ${engineLabel(sw.to)}`, {
            description: sw.reason === 'init-failed' ? `${engineLabel(sw.from)} did not start in this browser.` : `${engineLabel(sw.from)} could not load this page.`,
            id: `engine-switch-${t.id}`,
          });
        }
        return;
      }
      case 'tab.title': {
        const t = this.model.get(m.p.tabId);
        if (!t) return;
        t.title = m.p.title;
        if (t.url && settings.value.browser.history.enabled) void library()?.history.updateTitle(t.url, m.p.title).catch(() => undefined);
        return;
      }
      case 'tab.favicon': {
        const t = this.model.get(m.p.tabId);
        if (t) t.favicon = m.p.icon;
        return;
      }
      case 'tab.error':
        this.#onError(m.p);
        return;
      case 'tab.engineSwitched': {
        const t = this.model.get(m.p.tabId);
        if (!t) return;
        t.engine = m.p.to;
        // Told once the page loaded with the other engine (a failed retry ends at the error overlay instead).
        this.#switched.set(t.id, m.p);
        return;
      }
      case 'tab.openRequest':
        this.#onOpenRequest(m.p);
        return;
      case 'tab.closeRequest': {
        const t = this.model.get(m.p.tabId);
        // Like browsers: only a tab a page opened, while it has one history entry.
        if (t?.openedByPage && t.entries.length <= 1) this.close(t.id);
        return;
      }
      case 'tab.blocked': {
        const t = this.model.get(m.p.tabId);
        if (!t) return;
        t.blocked = m.p.total;
        t.blockedBy = { ...m.p.byCategory };
        this.blockStats.onBlocked(t.id, t.url, m.p.byCategory);
        return;
      }
      case 'tab.contextMenu':
        void this.#onContextMenu(m.p);
        return;
      case 'tab.key':
        if (m.p.tabId === this.model.activeId && this.visible) dispatchForwardedShortcut(m.p.combo, m.p.repeat);
        return;
      case 'tab.fullscreen': {
        const t = this.model.get(m.p.tabId);
        if (t) t.fullscreen = m.p.active;
        return;
      }
      case 'download.started':
        void this.#onDownloadStarted(m.p);
        return;
      case 'download.progress':
        library()?.downloads.progress(this.#client?.instance ?? '', m.p);
        return;
      case 'download.done':
        void library()
          ?.downloads.done(this.#client?.instance ?? '', m.p, Date.now())
          .catch(() => undefined);
        this.downloads.delete(m.p.downloadId);
        this.#client?.forgetScope({ downloadId: m.p.downloadId });
        return;
      case 'log':
        this.log.push({ ...m.p, at: Date.now() });
        if (this.log.length > LOG_RING) this.log.splice(0, this.log.length - LOG_RING);
        return;
    }
  }

  #onCommitted(c: EventMap['tab.committed']): void {
    const t = this.model.get(c.tabId);
    if (!t) return;
    const previousUrl = t.url;
    t.engine = c.engine;
    t.navId = c.navId ?? t.navId;
    // The committed page's site joins the scope (budgeted); its rules then go out with the next snapshot.
    const exposed = this.exposure.expose(c.url, t.id, 'commit', settings.value.extensions);
    if (exposed === 'dropped') this.#client?.count('droppedExposures');
    else if (exposed === 'added') this.#flushSnapshot();
    if (c.kind !== 'same-document') {
      t.error = null;
      t.blocked = 0;
      t.blockedBy = {};
      this.blockStats.newDocument(t.id, c.url);
      t.favicon = null;
      if (c.kind === 'navigate') t.blockedPopups = [];
    }
    if (this.model.applyCommit(t.id, c) === 'resync') this.#scheduleResync(t.id, 0);
    if (this.find.open && this.model.activeId === t.id && c.kind !== 'same-document') void this.findClear();
    // History (ENGINE-PROTOCOL §6.1): one VisitGate per app page caps what events can write.
    if (!settings.value.browser.history.enabled) return;
    const decision = this.#gate.decide(String(t.id), c, previousUrl, Date.now());
    if (decision === 'limited') this.#client?.count('libraryLimited');
    // A new document's title is not known at its commit (tab.title follows and names the visit): t.title is still
    // the previous page's. A same-document push keeps its document, and so its title.
    const title = c.kind === 'same-document' ? t.title || null : null;
    if (decision === 'record') void library()?.history.recordVisit({ url: c.url, title, at: Date.now() }).catch(() => undefined);
  }

  #onError(e: EventMap['tab.error']): void {
    const t = this.model.get(e.tabId);
    if (!t) return;
    t.loading = false;
    t.navStartedAt = null;
    this.blockStats.navigationEnded(t.id);
    this.#clearWatchdog(t.id);
    this.#switched.delete(t.id);
    // An address typed without a scheme was tried as https first: fall back to http once if it could not connect.
    const fb = this.#fallbackHref.get(t.id);
    if (fb && e.kind === 'network' && e.url !== null && normalizeHttpUrl(fb.https) === e.url) {
      this.#fallbackHref.delete(t.id);
      // Started by an event: the user's own navigation already had its interactive mint (§1.2 rule 9).
      this.#navigateTab(t, fb.http, null, false);
      return;
    }
    t.error = e;
  }

  #onOpenRequest(r: EventMap['tab.openRequest']): void {
    const opener = this.model.get(r.openerTabId);
    if (!opener) return;
    const s = settings.value;
    const appAct = appActivation();
    // One tab per click: a browser lets one activation open one pop-up (window.open consumes it), but the app cannot
    // see clicks inside the engine iframe, and its own activation lasts seconds. So after a gesture-backed open, the
    // same tab's next open within GESTURE_OPEN_WINDOW_MS counts as having no gesture (security review, integration
    // part 2: one click with 4 × window.open opened 3 GNOME tabs). A person's next click comes later than that.
    const now = Date.now();
    const last = this.#gestureOpenAt.get(opener.id);
    const consumed = last !== undefined && now - last < GESTURE_OPEN_WINDOW_MS;
    const userActivation = r.userActivation && !consumed;
    const decision = decideOpen({
      disposition: r.disposition,
      userActivation,
      appActivation: appAct,
      popups: this.#popupSetting(opener.url ?? ''),
      openLinksInBackground: s.browser.openLinksInBackground,
    });
    if (userActivation && appAct === true) this.#gestureOpenAt.set(opener.id, now);
    if (decision.action === 'open') {
      // Not a gesture in GNOME's own UI (the click was in the page): the new tab's load never prompts for
      // credentials (ENGINE-PROTOCOL §1.2 rule 9), it only shows the passive notice when a ticket is missing.
      this.#openFromPage(opener, r.url, decision.background, false);
      return;
    }
    // Blocked (or ask): the toolbar indicator, from which the user can open it (a gesture in GNOME's UI).
    this.#holdPopup(opener, r.url);
  }

  /** A pop-up the page asked for and GNOME held back: the toolbar indicator (the newest 20). */
  #holdPopup(opener: Tab, url: string): void {
    opener.blockedPopups = [...opener.blockedPopups, { url, at: Date.now() }].slice(-20);
  }

  /** `user`: the open is a gesture in GNOME's own UI (the pop-up indicator), which may mint interactively. */
  #openFromPage(opener: Tab, url: string, background: boolean, user: boolean): Tab | null {
    const tab = this.model.create({ url: null, after: opener.id, openerId: opener.id, openedByPage: true, activate: !background, zoom: this.#defaultZoom() });
    if (!tab) {
      this.#tooManyTabs();
      return null;
    }
    // The page asked for this tab: its first load is that page's navigation, never GNOME's own (which would send the
    // destination its SameSite=Strict cookies and no Referer, as if the user had typed the URL; ENGINE-PROTOCOL §6.3).
    const openerUrl = opener.url ? normalizeHttpUrl(opener.url) : null;
    tab.pageOpen = openerUrl ? { url, opener: openerUrl } : null;
    if (!background) this.#activate(tab.id);
    this.#navigateTab(tab, url, null, user, user ? 'gnome-load' : 'nav-start');
    return tab;
  }

  /** Opens one of the held-back pop-ups (the indicator's item: a gesture). */
  openBlockedPopup(openerId: number, url: string): void {
    const opener = this.model.get(openerId);
    if (!opener) return;
    opener.blockedPopups = opener.blockedPopups.filter((p) => p.url !== url);
    this.#openFromPage(opener, url, false, true);
  }

  #popupSetting(url: string): PermissionValue {
    const p = settings.value.privacy;
    return ruleFor(p.sitePermissions, url)?.popups ?? p.defaultPermissions.popups;
  }

  /** The indicator's "Always allow / Always block pop-ups from <site>" (a gesture). */
  setPopupPermission(openerUrl: string, value: 'allow' | 'block'): void {
    const host = hostOf(openerUrl) ? new URL(openerUrl).hostname.toLowerCase() : '';
    if (!host) return;
    const p = settings.value.privacy;
    void settings.set('privacy', 'sitePermissions', { ...p.sitePermissions, [host]: { ...(p.sitePermissions[host] ?? {}), popups: value } });
  }

  popupDecisionFor(url: string): PermissionValue {
    return this.#popupSetting(url);
  }

  async #onContextMenu(e: EventMap['tab.contextMenu']): Promise<void> {
    if (!this.visible || e.tabId !== this.model.activeId) return;
    if (typeof document !== 'undefined' && document.querySelector('dialog:modal')) return;
    const frame = this.embedder.element;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + e.x, rect.left), rect.right - 4);
    const y = Math.min(Math.max(rect.top + e.y, rect.top), rect.bottom - 4);
    const { contextMenuItems } = await import('./contextmenu');
    const { openContextMenu } = await import('../app/overlays/contextmenu.svelte');
    openContextMenu({ x, y }, contextMenuItems(this, e), { label: 'Page menu' });
  }

  async #onDownloadStarted(d: EventMap['download.started']): Promise<void> {
    const t = this.model.get(d.tabId);
    if (t && t.loading && t.navId !== null) {
      // A navigation that became a download ends here (never with tab.loaded).
      t.loading = false;
      t.navStartedAt = null;
      this.#clearWatchdog(t.id);
    }
    this.#noteDownloadSeen(d.downloadId);
    const lib = library();
    const instance = this.#client?.instance;
    if (!lib || !instance || !settings.value.browser.downloads.track) return;
    // Known at once, before the store's write resolves: a small download's download.done can arrive right behind
    // download.started and must not be dropped as an unknown id. The store takes the later events of an item it
    // recorded (it registers the item synchronously) and ignores the rest; an item it did not record is forgotten.
    this.downloads.add(d.downloadId);
    try {
      const recorded = await lib.downloads.started(instance, d, Date.now());
      if (!recorded) {
        this.downloads.delete(d.downloadId);
        this.#client?.count('libraryLimited');
      } else if (settings.value.browser.downloads.openPanelOnStart) this.downloadsOpen = true;
    } catch {
      // Storage unavailable: the browser still downloads the file.
      this.downloads.delete(d.downloadId);
    }
  }

  /** Download ids the current engine-host instance announced (later events of unrecorded ones drop silently). */
  #downloadsSeen = new Set<string>();

  #noteDownloadSeen(id: string): void {
    this.#downloadsSeen.add(id);
    // Bounded: a forged download.started stream must not grow it (the oldest ids then count as unknown again).
    if (this.#downloadsSeen.size > 1000) this.#downloadsSeen.delete(this.#downloadsSeen.values().next().value as string);
  }

  /** The engine client's check for download.progress / done (ENGINE-PROTOCOL §1.2 rules 1 and 8). */
  #downloadStatus(id: string): 'known' | 'closed' | 'unknown' {
    if (this.downloads.has(id)) return 'known';
    // Announced but not recorded (over LIBRARY_LIMITS, tracking off) or already done: dropped without counting.
    return this.#downloadsSeen.has(id) ? 'closed' : 'unknown';
  }

  async #renewTicket(force = false): Promise<void> {
    if (!this.#minter || !this.#client) return;
    // After a mint answered that credentials are needed, retrying without them cannot succeed: the engine host's
    // repeated needTicket would only use up the ticket budget (10 per minute here, 30 on the server) that the user's
    // own mint needs. Retry once a minute, or at once when the session changes (sign-in, access code).
    if (!force && this.ticketNotice && Date.now() - this.#credentialsAt < 60_000) return;
    const out = await this.#mint(false);
    if (out.ok) {
      this.ticketNotice = null;
      await this.#send('ticket', out.ticket).catch((err: unknown) => this.#logError('ticket', err));
    } else if (out.reason === 'credentials') this.#needCredentials(out.kind, out.message);
  }

  #credentialsAt = 0;

  #needCredentials(kind: 'login' | 'access-code', message: string): void {
    this.ticketNotice = { kind, message };
    this.#credentialsAt = Date.now();
  }

  #checkTransportNeeds(s: EngineHostStatus): void {
    const sides = Object.values(s.transport);
    if (sides.some((x) => x.state === 'offline' && x.detail === 'ticket-missing') && !this.ticketNotice) void this.#renewTicket();
    if (sides.some((x) => x.state === 'offline' && x.detail === 'unknown-profile') && Date.now() - this.#profileRefreshAt >= PROFILE_REFRESH_MIN_MS) {
      // The route names a VPN profile the server no longer has: refresh /api/config and choose the route again. At
      // most once per PROFILE_REFRESH_MIN_MS: status events (10 per second) must not drive requests to the app's API.
      this.#profileRefreshAt = Date.now();
      void server.refresh().then(() => this.#scheduleSnapshot());
    }
  }

  #profileRefreshAt = 0;

  #checkUpdate(s: EngineHostStatus): void {
    this.updateNotice = s.sw.updateWaiting || (s.sw.controlled && !s.sw.current);
  }

  // ── Watchdog (ENGINE-PROTOCOL §3) ──────────────────────────────────────────────────────────────────────────────

  #armWatchdog(tabId: number, navId: number): void {
    this.#clearWatchdog(tabId);
    this.#watchdogs.set(
      tabId,
      setTimeout(() => {
        this.#watchdogs.delete(tabId);
        const t = this.model.get(tabId);
        if (t?.live && t.loading && t.navId === navId) void this.#resync(tabId);
      }, TIMEOUTS.navigationWatchdogMs),
    );
  }

  #clearWatchdog(tabId: number): void {
    const w = this.#watchdogs.get(tabId);
    if (w) clearTimeout(w);
    this.#watchdogs.delete(tabId);
  }

  #scheduleResync(tabId: number, delay: number): void {
    if (this.#resyncs.has(tabId)) return;
    this.#resyncs.set(
      tabId,
      setTimeout(() => {
        this.#resyncs.delete(tabId);
        void this.#resync(tabId);
      }, delay),
    );
  }

  #resyncLoading(): void {
    for (const t of this.model.tabs) if (t.live && t.loading) void this.#resync(t.id);
  }

  async #resync(tabId: number): Promise<void> {
    const t = this.model.get(tabId);
    if (!t?.live) return;
    try {
      const s = await this.#send('tab.state', { tabId });
      this.model.applyState(tabId, s);
      if (s.loading && s.navId !== null) this.#armWatchdog(tabId, s.navId);
    } catch (err) {
      this.#commandFailed(tabId, err);
    }
  }

  // ── Discarding ─────────────────────────────────────────────────────────────────────────────────────────────────

  #applyDiscards(force = false): void {
    const p = settings.value.performance;
    const ids = this.model.discardCandidates(p);
    if (force && !ids.length) {
      const lru = this.model.tabs.filter((t) => t.live && t.id !== this.model.activeId && !t.pinned).sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
      if (lru) ids.push(lru.id);
    }
    for (const id of ids) this.discard(id);
  }

  /** Closes the engine tab and keeps its URL and entries; it is restored when shown again. */
  discard(id: number): void {
    const t = this.model.get(id);
    if (!t?.live) return;
    t.live = false;
    t.discarded = true;
    t.loading = false;
    t.fullscreen = false;
    this.#clearWatchdog(id);
    this.#markClosed(id);
    this.#send('tab.close', { tabId: id }).catch(() => undefined);
    this.#client?.forgetScope({ tabId: id });
  }

  // ── Shortcuts ──────────────────────────────────────────────────────────────────────────────────────────────────

  #registerShortcuts(): void {
    const onView = (fn: () => void) => () => {
      if (!this.visible) return false;
      fn();
      return true;
    };
    const offs = [
      register('newTab', () => void this.newTab()),
      register('closeTab', onView(() => this.model.activeId !== null && this.close(this.model.activeId))),
      register('reopenClosedTab', () => void this.reopenClosed()),
      register('nextTab', onView(() => this.model.cycle(1) && this.activate(this.model.cycle(1)!.id)), { repeat: true }),
      register('prevTab', onView(() => this.model.cycle(-1) && this.activate(this.model.cycle(-1)!.id)), { repeat: true }),
      register('focusOmnibox', () => this.focusOmnibox()),
      register('reload', onView(() => this.reload())),
      register('hardReload', onView(() => this.reload())), // the same reload, a second binding (SHORTCUT_LABELS)
      register('back', onView(() => this.go(-1))),
      register('forward', onView(() => this.go(1))),
      register('bookmarkPage', onView(() => this.model.active?.url && this.editBookmark(this.model.active.url, this.model.active.title))),
      register('toggleFullscreen', () => this.toggleFullscreen()),
      register('findInPage', () => {
        if (!this.visible || !this.model.active?.live) return false;
        this.openFind();
        return true;
      }),
      register('duplicateTab', onView(() => this.model.activeId !== null && this.duplicate(this.model.activeId))),
      register('pinTab', onView(() => this.model.activeId !== null && this.togglePin(this.model.activeId))),
      register('zoomIn', () => (this.visible && this.hasCapability('zoom') ? (this.zoom(1), true) : false), { repeat: true }),
      register('zoomOut', () => (this.visible && this.hasCapability('zoom') ? (this.zoom(-1), true) : false), { repeat: true }),
      register('zoomReset', () => (this.visible && this.hasCapability('zoom') ? (this.zoom(0), true) : false)),
    ];
    for (let n = 1; n <= 9; n++) {
      offs.push(
        register(
          `selectTab${n}` as `selectTab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`,
          onView(() => {
            const t = n === 9 ? this.model.tabs.at(-1) : this.model.tabs[n - 1];
            if (t) this.activate(t.id);
          }),
        ),
      );
    }
    this.#offs.push(...offs);
  }

  // ── Content blocking (WAVE-B3 §7.1) ────────────────────────────────────────────────────────────────────────────

  /** Clears proxied site data (a gesture: Settings → Clear browsing data). With storage or cache the blocker's key goes too (D6). */
  async clearSiteData(kinds: CommandPayload<'siteData.clear'>['kinds']): Promise<void> {
    await this.#send('siteData.clear', { kinds });
    if (kinds.includes('storage') || kinds.includes('cache')) await this.blockerKey.rotate('site-data-cleared');
  }

  /** Compromise signals (ENGINE-PROTOCOL §1.2 rule 8): a new blocker key for the next engine host, and after two the site maps stay empty. */
  #onCompromise(signals: number): void {
    this.exposure.setCompromiseSignals(signals);
    if (signals > this.#signalsSeen) {
      this.#signalsSeen = signals;
      void this.blockerKey.rotate('compromise');
      if (this.exposure.paused && !this.siteRulesPaused) {
        this.siteRulesPaused = true;
        this.#flushSnapshot();
      }
    }
  }

  /** `blocker.stats` of the current engine host (capability `blocker`); null when it runs no blocker or did not answer. */
  async refreshBlockerStats(): Promise<BlockerStats | null> {
    if (!this.hasCapability('blocker')) return null;
    try {
      const stats = await this.#send('blocker.stats', {});
      this.blockerStats = stats;
      // A list the server changed since the app's listing (D9 `changed`), or one that failed: ask the server again.
      if (stats.lists.some((l) => l.state === 'failed')) void this.filterListing.refresh('failed-list');
      return stats;
    } catch (err) {
      this.#logError('blocker.stats', err);
      return null;
    }
  }

  /** e2e builds only: a raw `test.*` command to the engine host (EngineClient.testCommand; refused elsewhere). */
  testCommand(type: string, payload: unknown = {}): Promise<unknown> {
    if (!this.#client) return Promise.reject(new EngineCommandError('not_ready', 'The browser engine is not running.'));
    return this.#client.testCommand(type, payload);
  }

  /** "Rebuild filter data" (a gesture): every cached set is discarded and the current one rebuilt. */
  async rebuildFilters(): Promise<void> {
    await this.#send('blocker.reload', {});
  }

  /** The cookie manager (capability `cookies`). */
  listCookies(site: string | null = null): Promise<CommandResult<'cookies.list'>> {
    return this.#send('cookies.list', { site });
  }

  deleteCookies(p: CommandPayload<'cookies.delete'>): Promise<CommandResult<'cookies.delete'>> {
    return this.#send('cookies.delete', p);
  }

  /**
   * After a site rule changed through a gesture in GNOME's UI (the shield, the blocked page): the page's site is
   * exposed as GNOME's own (not budgeted) and the snapshot goes out at once, so the next load uses the rule.
   */
  applySiteRules(url: string, tabId: number | null): void {
    this.exposure.expose(url, tabId, 'gnome-load', settings.value.extensions);
    this.#flushSnapshot();
  }

  /**
   * The blocked page's confirmed "Turn off blocking on <key>": the allowlist entry is added, the snapshot sent, and the
   * tab loads the blocked URL (`tab.navigate`: the blocked navigation never committed, so a reload would load the
   * previous page).
   */
  allowBlockedPage(tabId: number, key: string): void {
    const t = this.model.get(tabId);
    const url = t?.error?.url;
    if (!t || !url) return;
    const ext = settings.value.extensions;
    if (!ext.allowlist.includes(key)) settings.set('extensions', 'allowlist', [...ext.allowlist, key]);
    this.applySiteRules(url, tabId);
    this.#navigateTab(t, url, null, true);
  }

  #reportBlocker(s: EngineHostStatus): void {
    if (!this.hasCapability('blocker')) {
      clearStatus('blocker');
      return;
    }
    const b = s.blocker;
    // Lists the engine host could not load (D9: `changed` when the server has a newer version than this app's
    // listing): the listing is asked for again (with auto-update on, listing.svelte.ts), once per reported problem,
    // also while the Extensions page is closed; new hashes then go out with the next snapshot.
    const d = parseBlockerDetail(b.detail);
    const problem = d?.code === 'lists-failed' || (d?.code === 'failed' && d.reason === 'all-lists-failed') ? `${b.state}|${b.detail}` : null;
    if (problem !== null && problem !== this.#listProblem) void this.filterListing.refresh('failed-list');
    this.#listProblem = problem;
    const copy = blockerStateCopy(b);
    const state = b.state === 'ready' ? (copy.tone === 'warn' ? 'degraded' : 'ok') : b.state === 'building' ? 'starting' : b.state === 'failed' ? 'down' : 'off';
    reportStatus('blocker', { state, detail: copy.text ?? `${copy.label}${b.state === 'ready' ? ` · ${b.lists} filter lists` : ''}`, data: { state: b.state, lists: b.lists } });
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────────────────────────────────────────

  #logError(what: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.log.push({ level: 'warn', message: `${what}: ${msg}`.slice(0, LIMITS.maxMessageLength), at: Date.now() });
    if (this.log.length > LOG_RING) this.log.splice(0, this.log.length - LOG_RING);
    if (isApiError(err)) return;
  }

  #reportEngine(): void {
    const map: Record<EngineClientState, 'ok' | 'starting' | 'degraded' | 'down' | 'off'> = {
      idle: 'off',
      starting: 'starting',
      connecting: 'starting',
      ready: 'ok',
      failed: 'down',
      mismatch: 'down',
      unresponsive: 'degraded',
    };
    const st = this.status;
    const engines = st ? Object.entries(st.engines).map(([id, e]) => `${engineLabel(id as EngineId)} ${e.state}`).join(', ') : '';
    reportStatus('engine', {
      state: map[this.engineState],
      detail: this.engineDetail ?? (this.engineState === 'ready' ? `Browser engine running${engines ? ` (${engines})` : ''}` : this.engineState === 'idle' ? 'Starts with the first page you open' : 'Starting'),
    });
  }

  #reportTransport(s: EngineHostStatus): void {
    const sides = Object.entries(s.transport);
    const worst = sides.some(([, t]) => t.state === 'offline') ? 'down' : sides.some(([, t]) => t.state === 'connecting' || t.state === 'degraded') ? 'degraded' : 'ok';
    reportStatus('transport', {
      state: worst,
      detail: sides.map(([id, t]) => `${engineLabel(id as EngineId)}: ${t.transport} ${t.state}${t.detail ? ` (${t.detail})` : ''}`).join(' · '),
      data: Object.fromEntries(sides.map(([id, t]) => [id, { state: t.state, transport: t.transport, endpoint: t.endpoint, detail: t.detail }])),
    });
    this.#reportEngine();
  }

  #reportCounters(): void {
    const c = this.counters;
    if (!c) return;
    const signals = compromiseSignals(c);
    reportStatus('engine-protocol', {
      state: signals ? 'degraded' : 'ok',
      detail: signals
        ? `${signals} compromise signal${signals === 1 ? '' : 's'}: a page may have escaped its proxy engine`
        : 'No compromise signals',
      data: {
        compromise: { unexpectedHellos: c.unexpectedHellos, unexpectedLoads: c.unexpectedLoads, invalidEvents: c.invalidEvents, invalidResults: c.invalidResults },
        other: { rateLimited: c.rateLimited, unknownIds: c.unknownIds, libraryLimited: c.libraryLimited, refusedShortcuts: c.refusedShortcuts, lateResults: c.lateResults, unknownEventTypes: c.unknownEventTypes, droppedExposures: c.droppedExposures },
      },
    });
  }

  /** Teardown for tests and hot reload. */
  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
    for (const id of [...this.#watchdogs.keys()]) this.#clearWatchdog(id);
    for (const t of this.#resyncs.values()) clearTimeout(t);
    this.#resyncs.clear();
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = null;
    this.#offSiteData?.();
    onForwardedShortcut(null);
    this.#client?.dispose();
    this.#client = null;
    this.#minter?.dispose();
    clearStatus('engine');
    clearStatus('transport');
    clearStatus('engine-protocol');
    clearStatus('blocker');
    this.#initialized = null;
  }
}

export type { Browser };
export const browser = new Browser();

// e2e builds only (`npm run build:e2e`): the suites read the browser's state (tests/e2e/engine/suites/shell-*.mjs).
// Production builds have the constant false and drop this.
if (__GNOME_ENGINE_TEST__) Object.assign(globalThis, { __gnomeBrowser: browser, __gnomeSettings: settings, __gnomeServer: server });

/** main.ts and the browser view: idempotent. */
export function startBrowser(): Promise<void> {
  return browser.start();
}
