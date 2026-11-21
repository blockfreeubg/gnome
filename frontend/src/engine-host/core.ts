/**
 * The engine host's composition root (WAVE-B §2, ENGINE-PROTOCOL §2–§6). `main.ts` calls startEngineHost() with lane
 * b's factories; unit tests pass fakes. Order: the standalone guard; the transport manager is created at once (it
 * wraps this realm's WebSocket before any transport module loads); hello to each allowed app origin every 500 ms for
 * 15 s; exactly one connect (decideConnect); then, on `init`: clear-on-start, the service worker (with its apply step),
 * the transports, both engines in parallel, and the protocol from there on.
 */
import {
  PROTOCOL_VERSION,
  TIMEOUTS,
  decideConnect,
  fitInt,
  LIMITS,
} from '../shared/engine-protocol';
import type {
  Capability,
  EngineDiagnostics,
  EngineHostStatus,
  EnginePermission,
  EngineSettings,
  EventMap,
  EventType,
  InitResult,
  LogLevel,
  SwStatus,
  TransportStatus,
} from '../shared/engine-protocol';
import { PROXY_PATHS } from '../shared/proxy-origin';
import { ENFORCED_PERMISSIONS, browserFamily } from '../shared/site-rules';
import type { SwClient, SwSignal } from '../shared/proxy-origin';
import type { TransportManager } from '../shared/transport';
import type { Blocker, BlockerHostContext } from '../extensions/host/blocker';
import { UvContextSender } from '../extensions/host/uv-context';
import { Announcements, BlockedCounts, WsMarks } from './blocked';
import { BUILD, ENGINE_TEST, SELF_CHECK, TEST_CAPABILITIES, VERSIONS } from './build-info';
import { newCounters } from './context';
import type { HostContext } from './context';
import { DownloadTracker } from './downloads';
import { EngineManager } from './engines/manager';
import { clearFind, find } from './find';
import type { FindState } from './find';
import { engineHooks, onEngineHooksChange, registerEngineHooks } from './hooks';
import { ALLOW_ALL } from '../shared/engine-hooks';
import { natives } from './natives';
import type { Natives } from './natives';
import { ProtocolServer, failure } from './protocol-server';
import type { Handlers, PortLike, TestHandlers } from './protocol-server';
import { clearSiteData, clearCookies } from './site-data';
import { printPage, selectAll } from './actions';
import { deleteCookies, listCookies } from './cookie-ops';
import { TabManager } from './tabs';
import { killWebRtcDeep, srcdocHookTag } from './webrtc';
import { withPageAssignments } from './popups';
import { cachedKit } from './realm';
import { LagMonitor } from './diagnostics';
import { suggest } from './suggest';
import { vpnVerify } from './vpn-verify';

export interface EngineHostDeps {
  createTransportManager: () => TransportManager;
  createSwClient: () => SwClient;
  /**
   * Wave B step 3 (WAVE-B3 §4.4): the content blocker's composition root, used only when `blocker` is offered (D19).
   * Absent (unit tests that do not need it): ALLOW_ALL stays.
   */
  createBlocker?: (ctx: BlockerHostContext) => Blocker;
}

/**
 * Capabilities this build offers, each only after its e2e test passed in both browsers with both engines
 * (ENGINE-PROTOCOL §4; tests/e2e/engine/suites/host-capabilities.mjs, Chromium 156 + Firefox 157, 2026-11-12).
 * `saveLink`/`saveImage` since integration part 2: Firefox refused the engine host's blob download because it checks
 * it against the APP's frame-src as a navigation of the engine iframe; with `blob:` there (gnome-server's shell
 * policy) it saves the file in both browsers (`capability:saveLink + saveImage`). Not offered: `blocker` (Wave B step 3).
 */
export const OFFERED_CAPABILITIES: readonly Capability[] = ['zoom', 'print', 'selectAll', 'saveLink', 'saveImage', 'cookies', 'siteData', 'suggest', 'vpnVerify'];

/**
 * What this build offers: OFFERED_CAPABILITIES plus, in e2e builds only, the build's `GNOME_ENGINE_TEST_CAPABILITIES`
 * (WAVE-B3 D19: `blocker` before the integration step offers it). Reported in InitResult.capabilities and
 * diagnostics; `test.offer` only widens the command gate.
 */
export const BUILD_CAPABILITIES: readonly Capability[] = [...new Set([...OFFERED_CAPABILITIES, ...TEST_CAPABILITIES])];

// The per-browser enforcement table and browserFamily() are in the contract (shared/site-rules.ts), so the app applies
// the same table to what this engine host reports.

/** A random instance id: 16 lower-case base-36 characters (INSTANCE_RE allows 8–32). */
export function newInstanceId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...random(16)].map((b) => alphabet[b % 36]).join('');
}

/** The allowed app origins templated into the page (`<meta name="gnome-app-origins">`), valid origins only. */
export function appOriginsFrom(content: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (content ?? '').split(/\s+/)) {
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === raw.replace(/\/$/, '')) out.push(u.origin);
    } catch {
      /* not an origin (e.g. the untemplated placeholder) */
    }
  }
  return [...new Set(out)];
}

let started = false;

export function startEngineHost(deps: EngineHostDeps): void {
  if (started) return;
  started = true;
  if (window.parent === window) {
    const p = document.createElement('p');
    p.id = 'standalone';
    p.textContent = 'This page only works inside GNOME.';
    document.body.replaceChildren(p);
    return;
  }
  const N = natives();
  let runtime: EngineHostRuntime | null = null;
  // The UV document-start hook (public/engine/uv-doc-hook.js) hands each UV document to this host.
  Object.defineProperty(window, '__gnomeEngineHost', {
    value: Object.freeze({
      attachDocument: (win: Window) => {
        runtime?.attachUvDocument(win);
      },
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const transport = deps.createTransportManager();
  const sw = deps.createSwClient();
  const appOrigins = appOriginsFrom(document.querySelector('meta[name="gnome-app-origins"]')?.getAttribute('content'));
  const instance = newInstanceId();
  const startedAt = performance.now();
  let connected = false;

  const hello = { gnome: 'hello', protocol: PROTOCOL_VERSION, build: BUILD, instance };
  const sayHello = (): void => {
    for (const origin of appOrigins) {
      try {
        window.parent.postMessage(hello, origin);
      } catch {
        /* an origin postMessage refuses */
      }
    }
  };
  sayHello();
  const helloTimer = window.setInterval(sayHello, TIMEOUTS.helloIntervalMs);
  window.setTimeout(() => window.clearInterval(helloTimer), TIMEOUTS.helloRepeatForMs);
  if (!appOrigins.length) console.error('[gnome engine host] no app origins in <meta name="gnome-app-origins">: the app cannot connect');

  N.on.call(window, 'message', ((ev: MessageEvent) => {
    const d = decideConnect({ source: ev.source, origin: ev.origin, data: ev.data, ports: ev.ports }, { parent: window.parent, appOrigins, instance, connected });
    if (d.action === 'mismatch') {
      try {
        window.parent.postMessage({ gnome: 'mismatch', protocol: PROTOCOL_VERSION, instance }, ev.origin);
      } catch {
        /* ignore */
      }
      return;
    }
    if (d.action !== 'accept') return;
    const port = ev.ports[0];
    if (!port) return;
    connected = true;
    window.clearInterval(helloTimer);
    runtime = new EngineHostRuntime({ N, port, transport, sw, instance, startedAt, createBlocker: deps.createBlocker ?? null });
  }) as (ev: never) => void);
}

interface RuntimeInit {
  N: Natives;
  port: PortLike;
  transport: TransportManager;
  sw: SwClient;
  instance: string;
  startedAt: number;
  createBlocker?: ((ctx: BlockerHostContext) => Blocker) | null;
}

/** One connected engine host: the protocol, the engines and the tabs. */
export class EngineHostRuntime {
  readonly #N: Natives;
  readonly #transport: TransportManager;
  readonly #sw: SwClient;
  readonly #instance: string;
  readonly #startedAt: number;
  readonly #server: ProtocolServer;
  readonly #counters = newCounters();
  readonly #lag = new LagMonitor();
  #settings: EngineSettings | null = null;
  #engines: EngineManager | null = null;
  #tabs: TabManager | null = null;
  #downloads: DownloadTracker;
  #enforced: readonly EnginePermission[] = ENFORCED_PERMISSIONS[browserFamily()];
  #finds = new Map<number, FindState>();
  #fault: string | null = null;
  /** e2e builds only (`test.offer`): capabilities under test before they are offered. */
  #testOffered: Capability[] = [];
  #statusQueued = false;
  #init: InitResult | null = null;
  /** e2e builds only (`test.hooks`): unregisters the hooks under test. */
  #testHooksOff: (() => void) | null = null;
  readonly #createBlocker: ((ctx: BlockerHostContext) => Blocker) | null;
  /** The content blocker (WAVE-B3), only when `blocker` is offered (D19). */
  #blocker: Blocker | null = null;
  #uvContext: UvContextSender | null = null;
  readonly #counts = new BlockedCounts(
    (p) => this.#emit('tab.blocked', p),
    () => {
      this.#tablessBlocks++;
    },
  );
  #tablessBlocks = 0;
  readonly #wsMarks = new WsMarks(() => performance.now());
  /** e2e builds only (`test.blocker {holdBuild}`): builds wait for this. */
  #buildGate: { promise: Promise<void>; release: () => void } | null = null;
  readonly #announcements = new Announcements({ setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });

  constructor(init: RuntimeInit) {
    this.#N = init.N;
    this.#transport = init.transport;
    this.#sw = init.sw;
    this.#instance = init.instance;
    this.#startedAt = init.startedAt;
    this.#createBlocker = init.createBlocker ?? null;
    this.#downloads = new DownloadTracker({
      emit: (type, p) => this.#emit(type, p),
      forget: (id) => this.#server.forgetDownload(id),
    });
    this.#server = new ProtocolServer(init.port, {
      handlers: this.#handlers(),
      testHandlers: ENGINE_TEST ? this.#testHandlers() : null,
      capabilities: () => (this.#testOffered.length ? [...new Set([...BUILD_CAPABILITIES, ...this.#testOffered])] : BUILD_CAPABILITIES),
      selfCheck: SELF_CHECK,
      onInternalError: (m) => console.error(`[gnome engine host] ${m}`),
    });
    this.#lag.start();
  }

  /** A UV document at its start (the document-start hook). */
  attachUvDocument(win: Window): void {
    try {
      this.#tabs?.documentStart(win, 'ultraviolet');
    } catch (err) {
      this.#counters.hookErrors++;
      console.error('[gnome engine host] UV document hook', err);
    }
  }

  // ── Context shared with the tabs ───────────────────────────────────────────────────────────────────────────────

  #emit<T extends EventType>(type: T, p: EventMap[T]): void {
    this.#server.emit(type, p);
  }

  #log(level: LogLevel, message: string): void {
    if (level === 'error') console.error(`[gnome engine host] ${message}`);
    this.#emit('log', { level, message: message.slice(0, LIMITS.maxMessageLength) });
  }

  #context(engines: EngineManager): HostContext {
    return {
      N: this.#N,
      engines,
      counters: this.#counters,
      settings: () => this.#mustSettings(),
      enforced: () => this.#enforced,
      emit: (type, p) => this.#emit(type, p),
      log: (level, message) => this.#log(level, message),
      now: () => performance.now(),
      blocking: {
        counts: this.#counts,
        announcements: this.#announcements,
        wsMarks: this.#wsMarks,
        uvContext: () => this.#uvContext,
        onUvTab: () => this.#blocker?.onUvTab(),
      },
    };
  }

  #mustSettings(): EngineSettings {
    if (!this.#settings) throw failure('bad_state', 'not initialized');
    return this.#settings;
  }

  #mustEngines(): EngineManager {
    if (!this.#engines) throw failure('bad_state', 'not initialized');
    return this.#engines;
  }

  #tabsOrFail(): TabManager {
    if (!this.#tabs) throw failure('bad_state', 'not initialized');
    return this.#tabs;
  }

  // ── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────

  #status(): EngineHostStatus {
    const engines = this.#engines?.statuses() ?? {
      scramjet: { state: 'initializing', version: VERSIONS.scramjet, detail: null },
      ultraviolet: { state: 'initializing', version: VERSIONS.ultraviolet, detail: null },
    };
    return {
      engines,
      transport: fitTransport(this.#transport.status()),
      sw: fitSw(this.#sw.status()),
      blocker: engineHooks().status(),
    };
  }

  #queueStatus(): void {
    if (this.#statusQueued || !this.#init) return;
    this.#statusQueued = true;
    queueMicrotask(() => {
      this.#statusQueued = false;
      this.#emit('status', this.#status());
    });
  }

  // ── init ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async #initialize(p: Parameters<Handlers['init']>[0]): Promise<InitResult> {
    const t0 = performance.now();
    this.#settings = p.settings;
    const engines = new EngineManager(p.settings.engines);
    this.#engines = engines;
    const ctx = this.#context(engines);
    const container = document.getElementById('tabs') ?? document.body.appendChild(document.createElement('div'));
    if (!container.id) container.id = 'tabs';
    this.#tabs = new TabManager({
      ctx,
      container,
      downloads: this.#downloads,
      reportFailure: (side, detail) => this.#transport.reportFailure(side, detail),
      transportOffline: (side) => this.#transport.status()[side]?.state === 'offline',
      fault: () => this.#fault,
    });
    this.#tabs.setCombos(p.settings.keys.combos, p.settings.keys.apple);
    this.#guardHostRealm();
    // The content blocker exists only where `blocker` is offered (WAVE-B3 D19); otherwise ALLOW_ALL stays and the
    // snapshot's lists are ignored.
    if (BUILD_CAPABILITIES.includes('blocker') && this.#createBlocker) {
      const tabs = this.#tabs;
      try {
        this.#blocker = this.#createBlocker({
          N: this.#N,
          kitOf: (w) => cachedKit(w, this.#N),
          withPageAssignments,
          counter: this.#counts,
          postToSw: (m) => this.#sw.post(m),
          hasUvTabs: () => tabs.hasUvTabs(),
          log: (level, message) => this.#log(level, message),
          browser: browserFamily(),
          engineSettings: () => this.#settings,
          statusChanged: () => this.#queueStatus(),
          ...(ENGINE_TEST ? { testGate: () => this.#buildGate?.promise ?? Promise.resolve() } : {}),
        });
        this.#uvContext = new UvContextSender((m) => this.#sw.post(m));
        registerEngineHooks(this.#blocker.hooks);
      } catch (err) {
        this.#blocker = null;
        this.#log('error', `content blocker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    engineHooks().configure({ privacy: p.settings.privacy, extensions: p.settings.extensions });
    onEngineHooksChange((h) => {
      if (this.#settings) h.configure({ privacy: this.#settings.privacy, extensions: this.#settings.extensions });
      this.#queueStatus();
    });

    // "Clear … when GNOME closes", applied at this start, before any engine reads its jar.
    if (p.clearOnStart.siteData) {
      await clearSiteData(['cookies', 'storage', 'cache']).catch((e: unknown) => this.#log('warn', `clear site data: ${String(e)}`));
      this.#blocker?.onCacheCleared();
    } else if (p.clearOnStart.cookies) await clearCookies().catch((e: unknown) => this.#log('warn', `clear cookies: ${String(e)}`));
    // A verified cached set is put in force within 500 ms, in parallel with the engines' start; never waits for a build (D7).
    const blockerStart = this.#blocker
      ? this.#blocker.start({ privacy: p.settings.privacy, extensions: p.settings.extensions }, p.blockerKey ?? null, 500).catch((err: unknown) => {
          this.#log('warn', `content blocker start: ${err instanceof Error ? err.message : String(err)}`);
        })
      : Promise.resolve();

    // The service worker first (with the explicit apply step of a waiting update), then the transports, then the engines.
    const swT0 = performance.now();
    let swOk = true;
    try {
      await this.#sw.ensureControlled();
    } catch (err) {
      swOk = false;
      this.#log('error', `service worker: ${err instanceof Error ? err.message : String(err)}`);
    }
    const swReadyMs = Math.round(performance.now() - swT0);
    this.#sw.onStatus(() => this.#queueStatus());
    this.#sw.onSignal((s) => this.#onSwSignal(s));
    this.#transport.onStatus(() => this.#queueStatus());
    this.#transport.onNeedTicket((reason) => this.#emit('needTicket', { reason }));
    // Scramjet's sockets: the per-document wrapper (tabs.ts, D16) judged them with their page context; this backstop
    // sees only the URL: it skips a socket the wrapper allowed (one-shot mark), keeps blocking a URL the wrapper
    // blocked (5 s), and judges the rest without context (the network provider's third-party sentinel).
    this.#transport.useHooks({
      onWebSocket: (req) => {
        const mark = this.#blocker ? this.#wsMarks.take(req.url) : 'judge';
        if (mark === 'skip') {
          this.#counters.blocker.wsBackstopSkipped++;
          return 'allow';
        }
        if (mark === 'blocked') {
          this.#counters.blocker.wsBackstopBlocked++;
          return 'block';
        }
        const v = engineHooks().onWebSocket(req);
        if (v === 'block' && this.#blocker) this.#counters.blocker.wsBackstopBlocked++;
        return v;
      },
    });
    if (swOk) {
      await this.#transport.start({
        sides: { scramjet: p.settings.engines.scramjet, ultraviolet: p.settings.engines.ultraviolet },
        route: p.settings.route,
        transport: p.settings.transport,
        ticket: p.ticket,
        proxyOrigin: location.origin,
      });
      await engines.init(this.#transport, this.#sw);
    } else {
      for (const e of [engines.scramjet.status, engines.ultraviolet.status]) {
        if (e.state === 'disabled') continue;
        e.state = 'failed';
        e.detail = 'the service worker did not take control';
      }
    }
    await blockerStart;
    const result: InitResult = {
      instance: this.#instance,
      status: this.#status(),
      versions: VERSIONS,
      capabilities: [...BUILD_CAPABILITIES],
      enforcedPermissions: [...this.#enforced],
      timings: {
        swReadyMs: fitInt(swReadyMs, 0, LIMITS.maxDurationMs),
        scramjetMs: engines.scramjet.initMs === null ? null : fitInt(engines.scramjet.initMs, 0, LIMITS.maxDurationMs),
        ultravioletMs: engines.ultraviolet.initMs === null ? null : fitInt(engines.ultraviolet.initMs, 0, LIMITS.maxDurationMs),
        totalMs: fitInt(performance.now() - t0, 0, LIMITS.maxDurationMs),
      },
    };
    this.#init = result;
    return result;
  }

  /**
   * The WebRTC kill switch in the engine-host realm (ENGINE-PROTOCOL §6.15: escaped code can insert fresh frames into
   * this document with its own DOM methods), installed while `privacy.webrtc` is `block`. This realm's constructors
   * stay undefined once killed, but its child-frame guard follows the live setting: after a switch to `allow` it
   * leaves the tab frames' new documents alone (it used to kill each at its `load`; worklist A1), after a switch back
   * to `block` it kills them again (and the sweep here reaches the documents that are open).
   */
  #guardHostRealm(): void {
    if (this.#settings?.privacy.webrtc !== 'block') return;
    killWebRtcDeep(window, this.#N, undefined, srcdocHookTag(location.origin, PROXY_PATHS.uvDocumentHook), () => this.#settings?.privacy.webrtc === 'block');
  }

  #onSwSignal(s: SwSignal): void {
    switch (s.type) {
      case 'sw-hello':
        // The SW (re)started: it applies its fallback settings until this host sends config, engines and context.
        this.#blocker?.onSwHello();
        this.#uvContext?.reset();
        break;
      case 'uv-blocked':
        // Counting only (C11): a document this host never attached or announced is another GNOME tab's.
        this.#tabs?.countUvBlocked(s.documentUrl, s.counts);
        break;
      case 'sw-held':
        this.#counters.sw.held++;
        break;
      case 'sw-unavailable':
        this.#counters.sw.unavailable++;
        break;
      case 'uv-error':
        this.#tabs?.onUvError();
        break;
      case 'uv-download':
        if (this.#tabs) {
          const tabs = this.#tabs;
          this.#downloads.onUvSignal(s, (sig) => tabs.claimUvDownload(sig));
        }
        break;
      default:
        break;
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

  #handlers(): Handlers {
    const tabs = (): TabManager => this.#tabsOrFail();
    return {
      init: (p) => this.#initialize(p),
      settings: async (p) => {
        const before = this.#mustSettings();
        this.#settings = p.settings;
        this.#tabs?.setCombos(p.settings.keys.combos, p.settings.keys.apple);
        engineHooks().configure({ privacy: p.settings.privacy, extensions: p.settings.extensions });
        // The app's answer to every navigation announcement (WAVE-B3 D5): requests waiting for it are judged now.
        this.#announcements.onSettings();
        this.#guardHostRealm();
        if (JSON.stringify(before.route) !== JSON.stringify(p.settings.route) || before.transport !== p.settings.transport) {
          await this.#transport.configure({ route: p.settings.route, transport: p.settings.transport });
        }
        return {};
      },
      ticket: async (p) => {
        await this.#transport.setTicket(p);
        return {};
      },
      status: () => this.#status(),
      ping: () => ({ instance: this.#instance, uptimeMs: Math.max(0, Math.round(performance.now() - this.#startedAt)) }),
      diagnostics: () => this.#diagnostics(),
      'tab.create': (p) => tabs().create(p),
      'tab.close': (p) => {
        const t = tabs();
        t.get(p.tabId);
        clearFind(this.#N, this.#finds.get(p.tabId) ?? null);
        this.#finds.delete(p.tabId);
        t.close(p.tabId);
        this.#server.forgetTab(p.tabId);
        return {};
      },
      'tab.activate': (p) => {
        tabs().activate(p.tabId);
        return {};
      },
      'tab.navigate': (p) => {
        const t = tabs();
        return t.navigate(t.get(p.tabId), p.url, p.engine, p.permissions);
      },
      'tab.go': (p) => {
        const t = tabs();
        return t.go(t.get(p.tabId), p.delta, p.permissions);
      },
      'tab.reload': (p) => {
        const t = tabs();
        return t.reload(t.get(p.tabId), p.permissions);
      },
      'tab.stop': (p) => {
        const t = tabs();
        t.stop(t.get(p.tabId));
        return {};
      },
      'tab.state': (p) => {
        const t = tabs();
        const tab = t.get(p.tabId);
        this.#server.flushTab(p.tabId);
        return t.state(tab);
      },
      'tab.zoom': (p) => {
        const t = tabs();
        return { factor: t.zoom(t.get(p.tabId), p.factor) };
      },
      'tab.find': (p) => {
        const t = tabs();
        const tab = t.get(p.tabId);
        const { state, result } = find(this.#N, tab.topWin, this.#finds.get(p.tabId) ?? null, p);
        if (state) this.#finds.set(p.tabId, state);
        else this.#finds.delete(p.tabId);
        return result;
      },
      'tab.findClear': (p) => {
        tabs().get(p.tabId);
        clearFind(this.#N, this.#finds.get(p.tabId) ?? null);
        this.#finds.delete(p.tabId);
        return {};
      },
      'tab.action': (p) => {
        const tab = tabs().get(p.tabId);
        const ok = p.action === 'print' ? printPage(this.#N, tab.topWin) : selectAll(this.#N, tab.topWin);
        if (!ok) throw failure('no_document', 'the tab has no page');
        return {};
      },
      'tab.download': (p) => {
        const t = tabs();
        const tab = t.get(p.tabId);
        // Resolves when the download started; its outcome arrives as download.* events.
        void t.downloadUrl(tab, null, p.url, null).catch((err: unknown) => this.#log('warn', `tab.download: ${err instanceof Error ? err.message : String(err)}`));
        return {};
      },
      'cookies.list': (p) => listCookies(this.#mustEngines(), p),
      'cookies.delete': (p) => deleteCookies(this.#mustEngines(), p),
      'siteData.clear': async (p) => {
        await clearSiteData(p.kinds);
        // Cache Storage is gone (gnome-blocker-v1 with it): keep the set in force, cache nothing more (WAVE-B3 §4.3).
        if (p.kinds.includes('storage') || p.kinds.includes('cache')) this.#blocker?.onCacheCleared();
        const sj = this.#engines?.scramjet.controller;
        if (sj && p.kinds.includes('cookies')) {
          sj.cookieJar.load('{}');
          await sj.persistCookies();
          await sj.propagateCookieSync?.([], { clear: true });
        }
        return {};
      },
      suggest: async (p) => {
        this.#mustSettings();
        const items = await suggest((u, i) => this.#transport.proxyFetch(u, i), p.provider, p.query).catch((err: unknown) => {
          throw failure(/timed? ?out/i.test(String(err)) ? 'timeout' : 'failed', `suggestions: ${err instanceof Error ? err.message : String(err)}`);
        });
        return { items };
      },
      'vpn.verify': async (p) => {
        this.#mustSettings();
        return vpnVerify((u, i) => this.#transport.proxyFetch(u, i), p.url).catch((err: unknown) => {
          throw failure(/timed? ?out/i.test(String(err)) ? 'timeout' : 'failed', `VPN check: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
      // Capability `blocker` (the protocol server refuses both while it is not offered, D19).
      'blocker.stats': () => {
        if (!this.#blocker) throw failure('unsupported', 'the content blocker is not running');
        return this.#blocker.stats();
      },
      'blocker.reload': async () => {
        if (!this.#blocker) throw failure('unsupported', 'the content blocker is not running');
        await this.#blocker.reload();
        return {};
      },
    };
  }

  #diagnostics(): EngineDiagnostics {
    const t = this.#transport.diagnostics();
    const sw = this.#sw.diagnostics();
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const lag = this.#lag.snapshot();
    const byDirective: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.#counters.csp.byDirective)) if (/^[a-z-]{1,32}$/.test(k)) byDirective[k] = v;
    return {
      instance: this.#instance,
      uptimeMs: Math.max(0, Math.round(performance.now() - this.#startedAt)),
      status: this.#status(),
      versions: VERSIONS,
      capabilities: [...BUILD_CAPABILITIES],
      enforcedPermissions: [...this.#enforced],
      tabs: this.#tabs?.liveCounts() ?? { live: 0, scramjet: 0, ultraviolet: 0 },
      sw: { starts: sw.starts, held: Math.max(sw.held, this.#counters.sw.held), unavailable: Math.max(sw.unavailable, this.#counters.sw.unavailable) },
      csp: { violations: this.#counters.csp.violations, byDirective },
      webrtc: { policy: this.#settings?.privacy.webrtc ?? 'block', blocked: this.#counters.webrtc.blocked },
      transport: { probes: { ...t.probes }, rebuilds: { ...t.rebuilds }, drops: { ...t.drops } },
      fallback: { switched: this.#counters.fallback.switched, notRetried: this.#counters.fallback.notRetried },
      protocol: { rejectedCommands: this.#server.rejectedCommands },
      memory: mem ? { usedJSHeapSize: Math.round(mem.usedJSHeapSize), totalJSHeapSize: Math.round(mem.totalJSHeapSize) } : null,
      mainThread: { maxLagMs: fitInt(lag.maxLagMs, 0, LIMITS.maxDurationMs), longTasks: lag.longTasks, longTaskMs: Math.round(lag.longTaskMs) },
      ...(this.#blocker
        ? {
            blocker: {
              hookErrors: this.#counters.hookErrors + this.#blocker.hookErrors(),
              wsBackstopBlocked: this.#counters.blocker.wsBackstopBlocked,
              wsBackstopSkipped: this.#counters.blocker.wsBackstopSkipped,
              announceWaits: this.#announcements.stats.waits,
              announceTimeouts: this.#announcements.stats.timeouts,
            },
          }
        : {}),
    };
  }

  // ── test.* (e2e builds only) ───────────────────────────────────────────────────────────────────────────────────

  #testHandlers(): TestHandlers {
    return {
      'test.stats': () => ({
        counters: this.#counters,
        lag: this.#lag.snapshot(),
        selfCheckFailures: this.#server.selfCheckFailures,
        downloads: { started: this.#downloads.started, ignoredUv: this.#downloads.ignoredUv },
        tabs: (this.#tabs?.all() ?? []).map((t) => ({
          id: t.id,
          engine: t.engine,
          allow: t.iframe?.getAttribute('allow') ?? null,
          zoom: t.zoom,
          entries: t.nav.history.entries.length,
          index: t.nav.history.index,
          nav: t.nav.nav ? { id: t.nav.nav.id, phase: t.nav.nav.phase, origin: t.nav.nav.origin, method: t.nav.nav.method } : null,
        })),
        engines: this.#engines?.statuses() ?? null,
        navigationApi: this.#N.hasNavigationApi,
      }),
      'test.resetStats': () => {
        Object.assign(this.#counters, newCounters());
        this.#lag.reset();
        return {};
      },
      'test.enforce': (p) => {
        const perms = (p as { permissions?: unknown } | null)?.permissions;
        this.#enforced = Array.isArray(perms) ? perms.filter((x): x is EnginePermission => x === 'autoplay' || x === 'fullscreen' || x === 'clipboard') : ENFORCED_PERMISSIONS[browserFamily()];
        return {};
      },
      'test.offer': (p) => {
        const caps = (p as { capabilities?: unknown } | null)?.capabilities;
        this.#testOffered = Array.isArray(caps) ? caps.filter((c): c is Capability => typeof c === 'string') : [];
        return {};
      },
      // The Wave B step-3 hook points (WAVE-B §9) with real verdicts: WebSockets whose URL contains `blockWebSocket`
      // (UV pages: the createWebSocket wrapper; Scramjet pages: the transport manager's useHooks), requests whose URL
      // contains `blockRequest` (Scramjet's per-tab plugin; UV requests are hooked in the service worker), and
      // `markDocuments` (onDocument leaves `__gnomeTestDocument` on each document's window). `{}` unregisters.
      'test.hooks': (p) => {
        const cfg = (p ?? {}) as { blockWebSocket?: unknown; blockRequest?: unknown; markDocuments?: unknown };
        this.#testHooksOff?.();
        this.#testHooksOff = null;
        const ws = typeof cfg.blockWebSocket === 'string' && cfg.blockWebSocket ? cfg.blockWebSocket : null;
        const rq = typeof cfg.blockRequest === 'string' && cfg.blockRequest ? cfg.blockRequest : null;
        const mark = cfg.markDocuments === true;
        if (ws === null && rq === null && !mark) return {};
        this.#testHooksOff = registerEngineHooks({
          ...ALLOW_ALL,
          onWebSocket: (req) => (ws !== null && req.url.includes(ws) ? 'block' : 'allow'),
          onRequest: (req) => (rq !== null && req.url.includes(rq) ? { action: 'block', category: 'ads' } : { action: 'allow' }),
          onDocument: (win, doc) => {
            if (!mark) return;
            try {
              Object.defineProperty(win, '__gnomeTestDocument', { value: `${doc.engine}:${doc.isTopLevel ? 'top' : 'nested'}`, configurable: true });
            } catch {
              /* the page's realm refused */
            }
          },
        });
        return {};
      },
      // WAVE-B3 §12.1: the content blocker's test controls. holdBuild/releaseBuild gate every build (fail-open rows);
      // plant/corrupt write the proxy origin's Cache Storage the way a page could (cache-attack rows).
      'test.blocker': async (p) => {
        const cfg = (p ?? {}) as { holdBuild?: unknown; releaseBuild?: unknown; plant?: unknown; corrupt?: unknown };
        if (cfg.holdBuild === true && !this.#buildGate) {
          let release = (): void => undefined;
          const promise = new Promise<void>((r) => (release = r));
          this.#buildGate = { promise, release };
        }
        if (cfg.releaseBuild === true && this.#buildGate) {
          this.#buildGate.release();
          this.#buildGate = null;
        }
        if (cfg.plant === true || cfg.corrupt === true) return testCacheAttack(cfg.plant === true ? 'plant' : 'corrupt');
        return { blocker: this.#blocker !== null, held: this.#buildGate !== null };
      },
      // WAVE-B3 §12.1 (row A6): what code that controls this realm can make the app expose. `announce` (with `tabId`):
      // tab.loading {loading: true, url} for each URL at once, as such code could send them (no 2/s throttle, at most
      // 500); the result: the keys of the scoped maps of the last settings snapshot this host got.
      'test.blockerExposure': (p) => {
        const cfg = (p ?? {}) as { tabId?: unknown; announce?: unknown };
        if (typeof cfg.tabId === 'number' && Array.isArray(cfg.announce)) {
          for (const u of cfg.announce.slice(0, 500)) {
            if (typeof u === 'string' && /^https?:\/\//.test(u) && u.length <= 2048) this.#emit('tab.loading', { tabId: cfg.tabId, loading: true, url: u });
          }
        }
        const e = this.#settings?.extensions;
        return { allowlist: e ? [...e.allowlist] : [], perSite: e ? Object.keys(e.perSite) : [] };
      },
      'test.setFault': (p) => {
        const f = (p as { fault?: unknown } | null)?.fault;
        this.#fault = typeof f === 'string' ? f : null;
        return {};
      },
      'test.webrtc': () => {
        const out: Record<string, unknown> = { host: typeof (window as unknown as Record<string, unknown>).RTCPeerConnection };
        for (const t of this.#tabs?.all() ?? []) {
          try {
            out[`tab-${t.id}`] = t.topWin ? typeof (t.topWin as unknown as Record<string, unknown>).RTCPeerConnection : null;
          } catch {
            out[`tab-${t.id}`] = 'unreadable';
          }
        }
        return out;
      },
    };
  }
}

function fitTransport(s: Record<'scramjet' | 'ultraviolet', TransportStatus>): Record<'scramjet' | 'ultraviolet', TransportStatus> {
  const fit = (t: TransportStatus): TransportStatus => ({
    ...t,
    since: Math.max(0, Math.floor(t.since)),
    retryInMs: t.retryInMs === null ? null : fitInt(t.retryInMs, 0, LIMITS.maxDurationMs),
  });
  return { scramjet: fit(s.scramjet), ultraviolet: fit(s.ultraviolet) };
}

function fitSw(s: SwStatus): SwStatus {
  return { ...s, build: s.build !== null && /^[A-Za-z0-9._+-]{1,64}$/.test(s.build) ? s.build : null };
}

/**
 * e2e only (WAVE-B3 rows S2, S3): what a page that reaches the proxy origin's Cache Storage can do to the blocker
 * cache. `plant`: a manifest with a forged MAC and a fake group under every set key present (and under a made-up
 * one); `corrupt`: one flipped byte in every cached group. Returns what it changed.
 */
async function testCacheAttack(kind: 'plant' | 'corrupt'): Promise<{ changed: number }> {
  if (typeof caches !== 'object' || !(await caches.has('gnome-blocker-v1'))) return { changed: 0 };
  const cache = await caches.open('gnome-blocker-v1');
  let changed = 0;
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    const res = await cache.match(req);
    if (!res) continue;
    if (kind === 'corrupt' && path.endsWith('.bin')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > 100) bytes[100] = (bytes[100] ?? 0) ^ 0xff;
      await cache.put(req, new Response(bytes));
      changed++;
    }
    if (kind === 'plant' && path.endsWith('manifest.json')) {
      const m = (await res.json()) as Record<string, unknown>;
      await cache.put(req, new Response(JSON.stringify({ ...m, mac: '0'.repeat(64), buildMs: 1 }), { headers: { 'content-type': 'application/json' } }));
      changed++;
    }
  }
  return { changed };
}

