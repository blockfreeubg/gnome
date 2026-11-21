/**
 * The engine host's step-3 composition root (WAVE-B3 §4.1, §4.2): `createBlocker()`, which core.ts calls at `init`
 * only when `blocker` is offered (D19). It composes the providers (network, then lane x3's cookies and privacy, then
 * lane x2's cosmetic; host/providers.ts), drives the engine sets (a verified cached set, else a build in the Worker;
 * the set in force stays until the next one is ready, D7), answers blocker.stats / blocker.reload, reports
 * status.blocker, and keeps the service worker supplied (config, engines while this host has an Ultraviolet tab).
 *
 * `@ghostery/adblocker` and filters/engines.ts reach the engine host only through the dynamic import() below (their
 * own chunk, §10.2): until it resolves the network provider fails open.
 */
import { BLOCKER_GROUPS } from '../../shared/engine-protocol';
import type { BlockerGroup, BlockerListStats, BlockerStats, BlockerStatus, EngineSettings, LogLevel } from '../../shared/engine-protocol';
import type { EngineHooks } from '../../shared/engine-hooks';
import type { HostToSwMessage } from '../../shared/proxy-origin';
import type { KeyedBlockCounter } from '../../engine-host/blocked';
import type { Natives } from '../../engine-host/natives';
import type { PageKit } from '../../engine-host/realm';
import { composeHooks } from '../core/compose';
import type { HookProvider, ProviderName } from '../core/compose';
import type { BlockerFailReason } from '../core/detail';
import type { BlockerSettings } from '../core/policy';
import { SANITIZER_VERSION } from '../core/sanitize';
import { validateSelectors } from '../core/selectors';
import type { SelectorCheckOptions } from '../core/selectors';
import { ADBLOCKER_ENGINE_VERSION } from '../core/version';
import { BlockerCache, importBlockerKey, setComponents, setKey, utcDay } from '../filters/cache';
import type { Manifest } from '../filters/cache';
import { preprocessorEnv } from '../filters/config';
import type { CosmeticsResult, EngineSet, EnginesInForce, FilterEngines } from '../filters/engines';
import { createNetworkProvider } from '../filters/network';
import type { GroupMatch, GroupMatcher } from '../filters/network';
import { RETRY_DELAYS_MS, anyGroupOn, blockerStatus } from '../filters/status';
import { createBuilderWorker, runBuild } from '../filters/worker-client';
import type { BuildOutcome, WorkerClientDeps } from '../filters/worker-client';
import { windowProviders } from './providers';

export interface BlockerHostContext {
  readonly N: Natives;
  /** The kit built for a proxied window at its document start (pageKit's cache), or null: x2 and x3 get it through here. */
  kitOf(win: Window): PageKit | null;
  /** popups.ts withPageAssignments (§3.3), for x2's scriptlet runner. */
  withPageAssignments(win: Window, run: () => void): void;
  /**
   * The core's per-tab counter (tab.blocked, src/engine-host/blocked.ts). Adaptation (x1): keyed by the blocked URL,
   * which counts once per page (Firefox requests a refused parser-preloaded image twice).
   */
  readonly counter: KeyedBlockCounter;
  postToSw(message: HostToSwMessage): void;
  /** Whether this engine host has a live Ultraviolet tab (it then keeps the SW supplied with engines). */
  hasUvTabs(): boolean;
  log(level: LogLevel, message: string): void;
  readonly browser: 'chromium' | 'gecko' | 'other';
  /**
   * Adaptation (x1): the whole settings snapshot of the last init/settings command, for gnome-blocker-config (the SW
   * validates a full EngineSettings with validateEngineSettings), or null before init.
   */
  engineSettings(): EngineSettings | null;
  /** Adaptation (x1): status.blocker changed (the core queues a status event). */
  statusChanged(): void;
  /** e2e builds only (`test.blocker {holdBuild}`): awaited before each build starts. */
  testGate?(): Promise<void>;
}

export interface Blocker {
  readonly hooks: EngineHooks;
  /** Always present: `ready()` stays false until the engines module (dynamic import) has loaded and a set is in force. */
  readonly engines: FilterEngines;
  /**
   * `init`: the first settings and the app's key. Resolves when a verified cached set is in force, or after `waitMs`
   * (500 at init; never waits for a build: D7).
   */
  start(settings: BlockerSettings, blockerKey: string | null, waitMs: number): Promise<void>;
  stats(): Promise<BlockerStats>;
  /** blocker.reload: drops every cached set and rebuilds the current one; resolves when the build started. */
  reload(): Promise<void>;
  /** siteData.clear deleted Cache Storage: keep the set in force, write nothing more to the cache this session (§4.3). */
  onCacheCleared(): void;
  /** The SW (re)started: resend the config, the engines (with a UV tab) and the UV context (reset). */
  onSwHello(): void;
  /**
   * An Ultraviolet load of this engine host starts (before its first request): the engines in force go to the SW
   * unless it already has them from this host since its last start and the last swap.
   */
  onUvTab(): void;
  /** Adaptation (x1): hook throws counted by the composite, for EngineDiagnostics.blocker. */
  hookErrors(): number;
}

/** What tests replace (the real ones by default). */
export interface BlockerInternals {
  importEngines(): Promise<typeof import('../filters/engines')>;
  build(refs: Parameters<typeof runBuild>[0], browser: Parameters<typeof runBuild>[1], signal: AbortSignal): Promise<BuildOutcome>;
  caches: CacheStorage | null;
  origin: string;
  locks: LockManager | null;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  idle(fn: () => void): void;
  /** Extra providers after `network` (default: host/providers.ts windowProviders). */
  providers(engines: FilterEngines): HookProvider[];
}

const MiB = 1024 * 1024;
const DEFAULT_CACHE_MB = 256;
const LOCK_NAME = 'gnome-blocker-build';
const LOCK_POLL_MS = 2_000;
const LOCK_WAIT_MS = 30_000;
const DAY_MS = 86_400_000;

/** The facade x2/x3 and the network provider hold from the start; it delegates to the engines once loaded. */
class LateEngines implements FilterEngines, GroupMatcher {
  inner: EnginesInForce | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #offs: Array<() => void> = [];

  attach(e: EnginesInForce): void {
    this.inner = e;
    this.#offs.push(e.onChange(() => this.#fire()));
  }

  #fire(): void {
    for (const l of [...this.#listeners]) {
      try {
        l();
      } catch {
        /* a listener's problem */
      }
    }
  }

  ready(): boolean {
    return this.inner?.ready() ?? false;
  }
  match(group: BlockerGroup, url: string, sourceUrl: string, type: string): GroupMatch | null {
    return this.inner ? this.inner.match(group, url, sourceUrl, type) : null;
  }
  cosmetics(url: string, policy: Parameters<FilterEngines['cosmetics']>[1]): CosmeticsResult {
    return this.inner ? this.inner.cosmetics(url, policy) : { styles: '', scripts: [] };
  }
  cosmeticsForFeatures(...a: Parameters<FilterEngines['cosmeticsForFeatures']>): string {
    return this.inner ? this.inner.cosmeticsForFeatures(...a) : '';
  }
  rewriteParams(...a: Parameters<FilterEngines['rewriteParams']>): string | null {
    return this.inner ? this.inner.rewriteParams(...a) : null;
  }
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

interface InForce {
  set: EngineSet;
  source: 'cache' | 'build';
  builtAt: number;
  buildMs: number;
  lists: BlockerListStats[];
  groups: Array<{ group: BlockerGroup; bytes: number; network: number; cosmetic: number; scriptlets: number }>;
  resources: { redirects: number; scriptlets: number } | null;
}

function defaultInternals(ctx: BlockerHostContext): BlockerInternals {
  const probe = typeof document === 'object' ? document.implementation.createHTMLDocument('') : null;
  const hitsRoot = (sel: string): boolean => {
    if (!probe) return false;
    try {
      return probe.documentElement.matches(sel) || (probe.body !== null && probe.body.matches(sel));
    } catch {
      return true;
    }
  };
  const yieldTask = (): Promise<void> => {
    const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    return typeof sched?.yield === 'function' ? sched.yield() : new Promise((r) => setTimeout(r, 0));
  };
  const workerDeps: WorkerClientDeps = {
    createWorker: createBuilderWorker,
    validate: (pairs, styles) =>
      validateSelectors(pairs, { CSSStyleSheet: CSSStyleSheet as unknown as SelectorCheckOptions['CSSStyleSheet'], hitsRoot, sliceMs: 8, now: () => performance.now(), yield: yieldTask, styles }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };
  return {
    importEngines: () => import('../filters/engines'),
    build: (refs, browser, signal) => runBuild(refs, browser, workerDeps, signal),
    caches: typeof caches === 'object' ? caches : null,
    origin: typeof location === 'object' ? location.origin : '',
    locks: typeof navigator === 'object' && navigator.locks ? navigator.locks : null,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    idle: (fn) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof ric === 'function') ric(fn, { timeout: 2000 });
      else setTimeout(fn, 50);
    },
    providers: (engines) =>
      windowProviders({
        N: ctx.N,
        engines,
        kitOf: (w) => ctx.kitOf(w),
        withPageAssignments: (w, run) => ctx.withPageAssignments(w, run),
        log: (level, message) => ctx.log(level, message),
      }),
  };
}

export function createBlocker(ctx: BlockerHostContext, over: Partial<BlockerInternals> = {}): Blocker {
  const io: BlockerInternals = { ...defaultInternals(ctx), ...over };
  const engines = new LateEngines();
  let settings: BlockerSettings | null = null;
  let started = false;
  let cache: BlockerCache | null = null;
  let current: InForce | null = null;
  let wantK: string | null = null;
  let inflight: { k: string; abort: AbortController } | null = null;
  let failure: BlockerFailReason | null = null;
  let overLimit: { bytes: number; limitBytes: number } | null = null;
  /** Shown with the set in force that replaced a rejected cache entry (once: cleared at the next swap). */
  let cacheRejected = false;
  let rejectedPending = false;
  let cacheCleared = false;
  let retries = 0;
  let retryTimer: unknown = null;
  let hookErrors = 0;
  let mod: typeof import('../filters/engines') | null = null;
  const firstSet: Array<() => void> = [];

  const env = preprocessorEnv(ctx.browser);
  const refsOf = (s: BlockerSettings) => s.extensions.lists;
  const filterLists = (s: BlockerSettings) => refsOf(s).filter((r) => r.category !== 'resources').length;
  const limitBytes = (): number => (settings?.extensions.cacheLimitMB ?? DEFAULT_CACHE_MB) * MiB;

  const status = (): BlockerStatus => {
    if (!settings) return { state: 'off', lists: 0, detail: null };
    // the resources ref is not a filter list (whatever its id): the set in force has the refs of the snapshot's K
    const resources = new Set(refsOf(settings).filter((r) => r.category === 'resources').map((r) => r.id));
    const filterStats = current ? current.lists.filter((l) => !resources.has(l.id) && l.id !== 'ubo-resources') : [];
    const inForce = current
      ? { compiled: filterStats.filter((l) => l.state === 'compiled').length, failed: filterStats.filter((l) => l.state === 'failed').length }
      : null;
    return blockerStatus({ lists: filterLists(settings), anyGroupOn: anyGroupOn(settings), inForce, failure, overLimit, cacheRejected });
  };
  let lastStatus = '';
  const notify = (): void => {
    const s = JSON.stringify(status());
    if (s === lastStatus) return;
    lastStatus = s;
    ctx.statusChanged();
  };

  const network = createNetworkProvider({ engines, status });
  const composite = composeHooks({
    providers: [network, ...io.providers(engines)],
    onBlock: (req, category) => {
      if (req.tabId !== null) ctx.counter.count(req.tabId, category, 1, req.url);
    },
    onError: (provider: ProviderName, where: string, err: unknown) => {
      hookErrors++;
      ctx.log('warn', `content blocker ${provider}.${where}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
    },
  });

  // ── The service worker ──
  const postConfig = (): void => {
    const full = ctx.engineSettings();
    if (!full) return;
    ctx.postToSw({ type: 'gnome-blocker-config', settings: full, setId: current?.set.setId ?? null });
  };
  /**
   * The set this engine host last sent to the SW: null after the SW (re)started; a newer set in force differs from it.
   * A UV load then sends the set again (onUvTab): a swap or a SW restart while this host had no UV tab left the SW
   * without the set in force (measured by lane x3's review: P7's $removeparam failed open in later UV tabs).
   */
  let swSetId: string | null = null;
  const postEngines = (): void => {
    if (!current) return;
    ctx.postToSw({ type: 'gnome-blocker-engines', setId: current.set.setId, groups: current.set.bytes.map((g) => ({ group: g.group, bytes: g.bytes })) });
    swSetId = current.set.setId;
  };

  // ── Sets ──
  const swapIn = (next: InForce): void => {
    current = next;
    cacheRejected = rejectedPending;
    rejectedPending = false;
    failure = null;
    retries = 0;
    engines.inner?.swap(next.set);
    mod?.warmUp(next.set, io.idle);
    postConfig();
    if (ctx.hasUvTabs()) postEngines();
    for (const f of firstSet.splice(0)) f();
    notify();
  };

  const loadModule = async (): Promise<typeof import('../filters/engines')> => {
    if (mod) return mod;
    const m = await io.importEngines();
    if (!mod) {
      mod = m;
      engines.attach(new m.EnginesInForce());
    }
    return mod;
  };

  const fromCache = async (k: string, components: unknown[]): Promise<boolean> => {
    if (!cache) return false;
    const r = await cache.load(k, components).catch(() => ({ kind: 'miss' as const }));
    if (r.kind === 'rejected') {
      rejectedPending = true;
      ctx.log('warn', 'content blocker: the cached filter data did not verify and is rebuilt');
      return false;
    }
    if (r.kind !== 'hit') return false;
    const m = await loadModule();
    let set: EngineSet;
    try {
      set = await m.loadEngineSet(k, r.groups, env);
    } catch {
      // ENGINE_VERSION or checksum mismatch: a miss (the K binding should have caught a version change).
      rejectedPending = true;
      await cache.clear().catch(() => undefined);
      return false;
    }
    const man: Manifest = r.manifest;
    swapIn({
      set,
      source: 'cache',
      builtAt: man.builtDay * DAY_MS,
      buildMs: man.buildMs,
      lists: man.lists,
      groups: man.groups.map((g) => ({ group: g.group, bytes: g.bytes, network: g.network, cosmetic: g.cosmetic, scriptlets: g.scriptlets })),
      resources: man.resources ? { redirects: man.resources.redirects, scriptlets: man.resources.scriptlets } : null,
    });
    return true;
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => io.setTimeout(r, ms));

  /** One build at a time per browser (Web Lock, `ifAvailable`; while held, the cache is polled for 30 s). */
  const withLock = async (k: string, components: unknown[], signal: AbortSignal, build: () => Promise<void>): Promise<void> => {
    if (!io.locks) return build();
    let held = false;
    await io.locks
      .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          held = true;
          return;
        }
        await build();
      })
      .catch(() => {
        held = true;
      });
    if (!held) return;
    for (let waited = 0; waited < LOCK_WAIT_MS && !signal.aborted; waited += LOCK_POLL_MS) {
      await sleep(LOCK_POLL_MS);
      if (signal.aborted) return;
      if (await fromCache(k, components)) return;
    }
    if (!signal.aborted) await build();
  };

  const run = async (k: string, refs: BlockerSettings['extensions']['lists'], abort: AbortController, skipCache: boolean): Promise<void> => {
    const components = setComponents(refs, SANITIZER_VERSION);
    await loadModule();
    if (abort.signal.aborted) return;
    if (!skipCache && (await fromCache(k, components))) return;
    if (abort.signal.aborted) return;
    notify();
    await withLock(k, components, abort.signal, async () => {
      if (abort.signal.aborted || (!skipCache && current?.set.setId === k)) return;
      if (ctx.testGate) await ctx.testGate();
      if (abort.signal.aborted) return;
      const outcome = await io.build(refs, ctx.browser, abort.signal);
      if (abort.signal.aborted || outcome.kind === 'aborted') return;
      if (outcome.kind === 'failed') {
        failure = outcome.reason;
        ctx.log('warn', `content blocker: the filter lists could not be prepared (${outcome.reason})`);
        scheduleRetry();
        notify();
        return;
      }
      const m = await loadModule();
      let set: EngineSet;
      try {
        set = await m.loadEngineSet(k, outcome.groups.map((g) => ({ group: g.group, bytes: g.bytes })), env);
      } catch {
        failure = 'build-error';
        scheduleRetry();
        notify();
        return;
      }
      if (abort.signal.aborted) return;
      const groups = outcome.groups.map((g) => ({ group: g.group, bytes: g.bytes.byteLength, network: g.network, cosmetic: g.cosmetic, scriptlets: g.scriptlets }));
      const builtAt = io.now();
      overLimit = null;
      swapIn({ set, source: 'build', builtAt, buildMs: outcome.buildMs, lists: outcome.lists, groups, resources: outcome.resources });
      if (cache && cache.enabled) {
        const resRef = refs.find((r) => r.category === 'resources');
        const total = groups.reduce((n, g) => n + g.bytes, 0);
        const res = await cache
          .store(
            k,
            {
              components,
              engineVersion: ADBLOCKER_ENGINE_VERSION,
              sanitizer: SANITIZER_VERSION,
              builtDay: utcDay(builtAt),
              buildMs: outcome.buildMs,
              lists: outcome.lists,
              resources: outcome.resources && resRef ? { ...outcome.resources, sha256: resRef.sha256 } : null,
              groups: groups.map((g) => ({ group: g.group, network: g.network, cosmetic: g.cosmetic, scriptlets: g.scriptlets })),
            },
            outcome.groups.map((g) => ({ group: g.group, bytes: g.bytes })),
            limitBytes(),
          )
          .catch(() => 'failed' as const);
        if (res === 'over-limit' || res === 'failed') overLimit = { bytes: total, limitBytes: limitBytes() };
        notify();
      }
    });
  };

  const scheduleRetry = (): void => {
    if (retryTimer !== null || retries >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[retries++] as number;
    retryTimer = io.setTimeout(() => {
      retryTimer = null;
      wantK = null;
      reconcile(false);
    }, delay);
  };

  /** Brings the set in force in line with the snapshot's lists (a cached set, else a build; the old set stays meanwhile). */
  const reconcile = (skipCache: boolean): void => {
    if (!started || !settings) return;
    const s = settings;
    const refs = refsOf(s);
    if (filterLists(s) === 0) {
      inflight?.abort.abort();
      inflight = null;
      wantK = null;
      notify();
      return;
    }
    void setKey(setComponents(refs, SANITIZER_VERSION)).then((k) => {
      if (settings !== s) return; // a newer snapshot came meanwhile
      if (!skipCache && (current?.set.setId === k || wantK === k)) return;
      wantK = k;
      if (failure !== null && !skipCache && retryTimer === null && retries === 0) failure = null;
      inflight?.abort.abort();
      const abort = new AbortController();
      inflight = { k, abort };
      void run(k, refs, abort, skipCache)
        .catch((err: unknown) => {
          failure = 'build-error';
          ctx.log('warn', `content blocker: ${err instanceof Error ? err.message : String(err)}`);
          notify();
        })
        .finally(() => {
          if (inflight?.abort === abort) inflight = null;
          if (wantK === k && current?.set.setId !== k) wantK = null;
        });
    });
  };

  const hooks: EngineHooks = {
    ...composite,
    configure(s) {
      const listsChanged = settings === null || JSON.stringify(refsOf(settings)) !== JSON.stringify(refsOf(s));
      settings = s;
      composite.configure(s);
      postConfig();
      if (listsChanged) {
        if (retryTimer !== null) {
          io.clearTimeout(retryTimer);
          retryTimer = null;
        }
        retries = 0;
        reconcile(false);
      }
      notify();
    },
    status,
  };

  return {
    hooks,
    engines,
    async start(s, blockerKey, waitMs) {
      const key = await importBlockerKey(blockerKey).catch(() => null);
      cache = io.caches && key ? new BlockerCache({ caches: io.caches, origin: io.origin, now: io.now }, key) : null;
      if (cacheCleared) cache?.disable();
      started = true;
      if (settings === null) hooks.configure(s);
      else reconcile(false);
      if (filterLists(s) === 0 || waitMs <= 0 || current !== null) return;
      await new Promise<void>((resolve) => {
        const t = io.setTimeout(resolve, waitMs);
        firstSet.push(() => {
          io.clearTimeout(t);
          resolve();
        });
      });
    },
    async stats() {
      const usage = cache ? await cache.usage() : { bytes: 0, entries: 0 };
      const c = current;
      return {
        engineVersion: ADBLOCKER_ENGINE_VERSION,
        builtAt: c ? Math.max(0, Math.floor(c.builtAt)) : null,
        buildMs: c ? Math.max(0, Math.min(3_600_000, Math.round(c.buildMs))) : null,
        source: c ? c.source : null,
        engines: c ? c.groups.filter((g) => BLOCKER_GROUPS.includes(g.group)) : [],
        lists: c ? c.lists.slice(0, 500) : [],
        cache: { bytes: usage.bytes, entries: usage.entries, limitBytes: limitBytes() },
        resources: c ? c.resources : null,
      };
    },
    async reload() {
      await cache?.clear();
      if (settings && filterLists(settings) > 0) {
        wantK = null;
        reconcile(true);
      }
    },
    onCacheCleared() {
      cacheCleared = true;
      cache?.disable();
    },
    onSwHello() {
      swSetId = null;
      postConfig();
      if (ctx.hasUvTabs()) postEngines();
    },
    onUvTab() {
      if (current && swSetId !== current.set.setId) postEngines();
    },
    hookErrors: () => hookErrors,
  };
}

