/**
 * The engine host's transport manager (WAVE-B lane b; contract and pure rules: src/shared/transport.ts; behaviour:
 * ENGINE-PROTOCOL §6.5–§6.6, ARCHITECTURE §5.4). Ported from the spike's verified recipe (spike §4.5–§4.6, §6):
 *
 * - One rebuild queue for both sides: build, `await init()`, only then hand the transport over (Scramjet: the sink
 *   given to bindScramjet(), i.e. `controller.setTransport`; Ultraviolet: the shared bare-mux transport).
 * - Watchdog on socket events (Scramjet: the engine-host realm's WebSocket tap; Ultraviolet: the tap inside the
 *   bare-mux worker). A drop of libcurl is probed once (libcurl reconnects by itself with its old URL); epoxy is probed
 *   and rebuilt. A socket that never opened is a failed upgrade: a 426 probe then means the upstream is down
 *   (`upstream-unreachable`, backoff) instead of a rebuild after every 426.
 * - Probe outcomes (classifyProbe): 426 rebuild, 401 `needTicket{rejected}` and wait for the ticket, 429 wait
 *   Retry-After, 503 `wisp_upstream_unavailable` wait Retry-After (else the backoff), 404 `unknown-profile` (the app
 *   chooses the route again), anything else backoff 250 ms·2ⁿ ±50 % ≤ 30 s, 12 attempts, then every 60 s.
 * - Rebuild cap per side (RebuildBudget), lazy renewal per transport kind, the proactive renewal timer
 *   (ticketRenewDelayMs after every ticket), custom endpoints without ticket or probe: a test socket picks the first
 *   that opens before a transport is built for it (deps.testSocket), and a failed socket means backoff, then the
 *   next one. The taps count a socket the page's policy refuses as a failed open (a throwing constructor in
 *   Firefox, `error` without `close` in Chromium).
 *
 * Unverified until the e2e suites pass on the real stack (WAVE-B §3): the 429/503/404 handling, the rebuild cap, the
 * idle retry, the upstream-down detection after a 426, custom endpoints and their failover, the shared-UV rules with
 * two engine hosts.
 */

import {
  ENGINE_IDS,
  ticketRenewDelayMs,
  type EngineId,
  type NeedTicketReason,
  type Ticket,
  type TransportDetail,
  type TransportKind,
  type TransportState,
  type TransportStatus,
  type WispRoute,
} from '../../shared/engine-protocol';
import type { RequestHooks } from '../../shared/engine-hooks';
import {
  RECOVERY,
  RebuildBudget,
  backoffDelayMs,
  classifyProbe,
  probeUrl,
  redactTicket,
  routeEndpoints,
  uvTransportKey,
  wispUrl,
  type ProbeOutcome,
  type ProxyFetchInit,
  type ProxyFetchResult,
  type ScramjetTransport,
  type ScramjetTransportSink,
  type TransportDiagnostics,
  type TransportManager,
  type TransportOptions,
  type UvInstallReason,
  type WispEndpoint,
} from '../../shared/transport';
import { readBody, type ManagerDeps, type RawResponse, type UvBackend, type UvSocketEvent, type WindowSocketEvent } from './backends';

type BuildReason = 'start' | 'configure' | 'rebuild' | 'ticket';
type RecoverReason = 'drop' | 'connect-failed' | 'failure' | 'build-failed';
type BuildResult = 'ok' | 'failed' | 'limited' | 'skipped' | 'unreachable';

/** A custom Wisp server's test socket (worklist A3) gets this long to open. */
const CUSTOM_TEST_MS = 4_000;
/** One test result serves both sides' builds of the same server for this long (the builds run one after the other). */
const CUSTOM_TEST_REUSE_MS = 3_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
    settled: false,
  };
  // A side nobody asks about must not cause an unhandled rejection.
  d.promise.catch(() => {});
  return d;
}

interface Side {
  readonly id: EngineId;
  enabled: boolean;
  status: TransportStatus;
  endpointIndex: number;
  readonly budget: RebuildBudget;
  /** Bumped by configure(), setTicket() and an opened socket: a running recovery loop ends at its next check. */
  epoch: number;
  /** The epoch whose recovery loop runs (null: none). Loops of older epochs end at their next check. */
  recoveryEpoch: number | null;
  /** Ends the current recovery wait early (reportFailure, an opened socket, a new epoch). */
  wake: (() => void) | null;
  /** A socket failed to open; cleared when one opens or the probe explains the failure (401, network error). */
  upgradeFailed: boolean;
  /** Consecutive failed recoveries (the backoff exponent across recovery runs); 0 after a socket opened. */
  failures: number;
  waitingTicket: boolean;
  /**
   * The recovery wait that runs is the gateway's Retry-After (a 429, or a 503 `wisp_upstream_unavailable` that
   * carried one): reportFailure() must not cut it short (probes share the upgrade budget; the contract says "next
   * probe after Retry-After").
   */
  serverWait: boolean;
  lastProbeAt: number;
  built: boolean;
  first: Deferred<void>;
  /** Scramjet: the transport handed to the Controller. */
  current: ScramjetTransport | null;
  /** Ultraviolet: newest generation of the shared transport of this manager's key that it has seen. */
  uvGen: number | null;
  /** Timer of a scheduled retry after a rebuild-limit or a failed first-level recovery. */
  retryTimer: unknown;
}

const withTimeout = <T>(deps: ManagerDeps, p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = deps.setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        deps.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        deps.clearTimeout(t);
        reject(e);
      },
    );
  });

const errText = (e: unknown): string => redactTicket(String((e as { message?: unknown } | null)?.message ?? e)).slice(0, 300);

/** URL of a socket without query and fragment, to match it against an endpoint. */
function socketBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

export class GnomeTransportManager implements TransportManager {
  readonly #deps: ManagerDeps;
  readonly #sides: Record<EngineId, Side>;
  #queue: Promise<unknown> = Promise.resolve();
  #started = false;
  #route: WispRoute = { kind: 'default' };
  #kind: TransportKind = 'libcurl';
  #proxyOrigin = '';
  #endpoints: WispEndpoint[] = [];
  #ticket: Ticket | null = null;
  #renewTimer: unknown = null;
  #sink: ScramjetTransportSink | null = null;
  #hooks: Pick<RequestHooks, 'onWebSocket'> | null = null;
  #uv: UvBackend | null = null;
  readonly #statusListeners = new Set<(s: Record<EngineId, TransportStatus>) => void>();
  /** Results of custom Wisp servers' test sockets (#customReachable), newest last. */
  readonly #customTests = new Map<string, { at: number; ok: boolean }>();
  readonly #ticketListeners = new Set<(r: NeedTicketReason) => void>();
  #statusQueued = false;
  readonly #diag: TransportDiagnostics = {
    probes: { valid: 0, rejected: 0, unreachable: 0, rateLimited: 0, upstreamDown: 0, unknownProfile: 0 },
    rebuilds: { scramjet: 0, ultraviolet: 0 },
    drops: { scramjet: 0, ultraviolet: 0 },
  };

  constructor(deps: ManagerDeps) {
    this.#deps = deps;
    const side = (id: EngineId): Side => ({
      id,
      enabled: false,
      status: { state: 'connecting', transport: 'libcurl', endpoint: 'default', detail: null, since: deps.now(), retryInMs: null },
      endpointIndex: 0,
      budget: new RebuildBudget(),
      epoch: 0,
      recoveryEpoch: null,
      wake: null,
      upgradeFailed: false,
      failures: 0,
      waitingTicket: false,
      serverWait: false,
      lastProbeAt: Number.NEGATIVE_INFINITY,
      built: false,
      first: deferred<void>(),
      current: null,
      uvGen: null,
      retryTimer: null,
    });
    this.#sides = { scramjet: side('scramjet'), ultraviolet: side('ultraviolet') };
    deps.scramjet?.onSocket((e) => this.#onWindowSocket(e));
  }

  // ── TransportManager ───────────────────────────────────────────────────────────────────────────────────────────

  async start(opts: TransportOptions): Promise<void> {
    if (this.#started) throw new Error('TransportManager.start() was already called');
    this.#started = true;
    this.#proxyOrigin = new URL(opts.proxyOrigin).origin;
    this.#applyRoute(opts.route, opts.transport);
    this.#ticket = opts.ticket;
    for (const id of ENGINE_IDS) {
      const side = this.#sides[id];
      side.enabled = opts.sides[id] === true;
      if (!side.enabled) {
        this.#setStatus(side, 'offline', null, null);
        side.first.reject(new Error(`${id} has no transport: the engine is not enabled`));
      }
    }
    if (this.#sides.scramjet.enabled && !this.#deps.scramjet) {
      this.#sides.scramjet.enabled = false;
      this.#setStatus(this.#sides.scramjet, 'offline', null, null);
      this.#sides.scramjet.first.reject(new Error('the Scramjet transports are not available in this page'));
    }
    if (this.#sides.ultraviolet.enabled) {
      try {
        this.#uv = this.#deps.uv();
        this.#uv.onSocket((e) => this.#onUvSocket(e));
      } catch (err) {
        const uv = this.#sides.ultraviolet;
        uv.enabled = false;
        this.#setStatus(uv, 'offline', null, null);
        uv.first.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (this.#ticket) this.#scheduleRenewal();
    else if (this.#endpoints.some((e) => e.gateway)) this.#deps.setTimeout(() => this.#emitNeedTicket('missing'), 0);
    const builds: Promise<BuildResult>[] = [];
    for (const id of ENGINE_IDS) {
      const side = this.#sides[id];
      if (!side.enabled) continue;
      this.#setStatus(side, 'connecting', 'rebuilding', null);
      builds.push(this.#build(side, 'start'));
    }
    await Promise.all(builds);
  }

  scramjetTransport(): Promise<ScramjetTransport> {
    const side = this.#sides.scramjet;
    return side.first.promise.then(() => {
      if (!side.current) throw new Error('Scramjet transport missing');
      return side.current;
    });
  }

  bindScramjet(sink: ScramjetTransportSink): void {
    this.#sink = sink;
  }

  ultravioletReady(): Promise<void> {
    return this.#sides.ultraviolet.first.promise;
  }

  async configure(opts: Pick<TransportOptions, 'route' | 'transport'>): Promise<void> {
    if (!this.#started) throw new Error('TransportManager.configure() before start()');
    const before = uvTransportKey(this.#route, this.#kind);
    if (before === uvTransportKey(opts.route, opts.transport)) return;
    this.#applyRoute(opts.route, opts.transport);
    if (!this.#ticket && this.#endpoints.some((e) => e.gateway)) this.#emitNeedTicket('missing');
    const builds: Promise<BuildResult>[] = [];
    for (const id of ENGINE_IDS) {
      const side = this.#sides[id];
      if (!side.enabled) continue;
      this.#resetRecovery(side);
      side.failures = 0;
      side.waitingTicket = false;
      side.upgradeFailed = false;
      this.#setStatus(side, 'connecting', 'rebuilding', null);
      builds.push(this.#build(side, 'configure'));
    }
    await Promise.all(builds);
  }

  async setTicket(ticket: Ticket): Promise<void> {
    this.#ticket = ticket;
    this.#scheduleRenewal();
    if (!this.#started) return;
    const builds: Promise<BuildResult>[] = [];
    for (const id of ENGINE_IDS) {
      const side = this.#sides[id];
      const endpoint = this.#endpoint(side);
      if (!side.enabled || !endpoint?.gateway) continue;
      // Lazy renewal: tickets are checked only at the upgrade. libcurl reconnects with the URL it was built with, so
      // it gets the new one now (cheap); a healthy epoxy transport keeps its socket (no transport has a close API:
      // rebuilding it would leak a Wisp connection) and uses the ticket at its next rebuild.
      const rebuild = side.waitingTicket || side.status.state !== 'ready' || this.#kind === 'libcurl';
      if (!rebuild) continue;
      this.#resetRecovery(side);
      side.waitingTicket = false;
      builds.push(this.#build(side, 'ticket'));
    }
    await Promise.all(builds);
  }

  status(): Record<EngineId, TransportStatus> {
    return { scramjet: { ...this.#sides.scramjet.status }, ultraviolet: { ...this.#sides.ultraviolet.status } };
  }

  onStatus(listener: (status: Record<EngineId, TransportStatus>) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onNeedTicket(listener: (reason: NeedTicketReason) => void): () => void {
    this.#ticketListeners.add(listener);
    return () => this.#ticketListeners.delete(listener);
  }

  reportFailure(sideId: EngineId, detail: string): void {
    const side = this.#sides[sideId];
    if (!side?.enabled || !side.built) return;
    this.#deps.log('debug', `transport ${sideId}: navigation failure reported (${redactTicket(detail).slice(0, 200)})`);
    const now = this.#deps.now();
    if (now - side.lastProbeAt < RECOVERY.failureProbeMinIntervalMs) return;
    if (side.recoveryEpoch === side.epoch) {
      // Probe now instead of at the end of the backoff (at most every failureProbeMinIntervalMs), but never cut the
      // gateway's Retry-After short (429, or a 503 that carried one): probes share its upgrade budget.
      if (!side.serverWait) side.wake?.();
      return;
    }
    void this.#recover(side, 'failure');
  }

  useHooks(hooks: Pick<RequestHooks, 'onWebSocket'>): void {
    this.#hooks = hooks;
  }

  async proxyFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('proxyFetch: invalid URL');
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('proxyFetch: only http(s) URLs');
    if ((init.method ?? 'GET') !== 'GET') throw new Error('proxyFetch: only GET');
    const headers = Object.entries(init.headers ?? {}).map(([k, v]) => [k, v] as [string, string]);
    const ac = new AbortController();
    const run = async (): Promise<ProxyFetchResult> => {
      let raw: RawResponse;
      const sj = this.#sides.scramjet;
      if (sj.current && this.#deps.scramjet) raw = await this.#deps.scramjet.request(sj.current, target, headers, ac.signal);
      else if (this.#uv && this.#sides.ultraviolet.built) raw = await this.#uv.request(target, headers, ac.signal);
      else throw new Error('proxyFetch: no transport is ready');
      const body = await readBody(raw.body, init.maxBytes);
      return { status: raw.status, headers: raw.headers, body };
    };
    try {
      return await withTimeout(this.#deps, run(), init.timeoutMs, 'proxyFetch');
    } finally {
      ac.abort();
    }
  }

  diagnostics(): TransportDiagnostics {
    return {
      probes: { ...this.#diag.probes },
      rebuilds: { ...this.#diag.rebuilds },
      drops: { ...this.#diag.drops },
    };
  }

  // ── Routes, endpoints, status ──────────────────────────────────────────────────────────────────────────────────

  #applyRoute(route: WispRoute, kind: TransportKind): void {
    this.#route = route;
    this.#kind = kind;
    const { endpoints, skipped } = routeEndpoints(route, this.#proxyOrigin);
    for (const s of skipped) this.#deps.log('warn', `custom Wisp server skipped (${s.problem}): ${redactTicket(s.server).slice(0, 200)}`);
    this.#endpoints = endpoints;
    for (const id of ENGINE_IDS) this.#sides[id].endpointIndex = 0;
  }

  #endpoint(side: Side): WispEndpoint | null {
    return this.#endpoints[side.endpointIndex % Math.max(1, this.#endpoints.length)] ?? null;
  }

  #wantedUvKey(): string {
    return uvTransportKey(this.#route, this.#kind);
  }

  #setStatus(side: Side, state: TransportState, detail: TransportDetail | null, retryInMs: number | null): void {
    const endpoint = this.#endpoint(side);
    const next: TransportStatus = {
      state,
      transport: this.#kind,
      endpoint: endpoint?.kind ?? (this.#route.kind === 'custom' ? 'custom' : this.#route.kind),
      detail,
      since: side.status.since,
      retryInMs: retryInMs === null ? null : Math.max(0, Math.min(Math.round(retryInMs), 3_600_000)),
    };
    const prev = side.status;
    const changed =
      prev.state !== next.state ||
      prev.detail !== next.detail ||
      prev.transport !== next.transport ||
      prev.endpoint !== next.endpoint ||
      prev.retryInMs !== next.retryInMs;
    if (!changed) return;
    if (prev.state !== next.state || prev.detail !== next.detail) next.since = this.#deps.now();
    side.status = next;
    this.#queueStatus();
  }

  #queueStatus(): void {
    if (this.#statusQueued) return;
    this.#statusQueued = true;
    queueMicrotask(() => {
      this.#statusQueued = false;
      const s = this.status();
      for (const l of this.#statusListeners) {
        try {
          l(s);
        } catch (err) {
          this.#deps.log('error', `transport status listener: ${errText(err)}`);
        }
      }
    });
  }

  #emitNeedTicket(reason: NeedTicketReason): void {
    for (const l of this.#ticketListeners) {
      try {
        l(reason);
      } catch (err) {
        this.#deps.log('error', `needTicket listener: ${errText(err)}`);
      }
    }
  }

  #scheduleRenewal(): void {
    if (this.#renewTimer !== null) this.#deps.clearTimeout(this.#renewTimer);
    this.#renewTimer = null;
    const ticket = this.#ticket;
    if (!ticket) return;
    const delay = ticketRenewDelayMs(this.#deps.now(), ticket.expiresAt);
    this.#renewTimer = this.#deps.setTimeout(() => {
      this.#renewTimer = null;
      if (this.#ticket === ticket) this.#emitNeedTicket('expiring');
    }, delay);
  }

  /** Status after a successful build: no ticket for a gateway endpoint is `ticket-missing`, else ready. */
  #afterBuild(side: Side): void {
    const endpoint = this.#endpoint(side);
    if (endpoint?.gateway && !this.#ticket) this.#setStatus(side, 'offline', 'ticket-missing', null);
    else this.#setStatus(side, 'ready', null, null);
  }

  // ── Builds (one queue) ─────────────────────────────────────────────────────────────────────────────────────────

  #serialized<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn, fn);
    this.#queue = p.catch(() => {});
    return p;
  }

  #build(side: Side, reason: BuildReason): Promise<BuildResult> {
    return this.#serialized(async (): Promise<BuildResult> => {
      if (!side.enabled) return 'skipped';
      let endpoint = this.#endpoint(side);
      if (!endpoint) {
        this.#setStatus(side, 'offline', 'gateway-unreachable', null);
        side.first.reject(new Error('no usable Wisp endpoint for this route'));
        return 'failed';
      }
      const now = this.#deps.now();
      if (!side.budget.tryTake(now)) {
        const wait = side.budget.waitMs(now);
        this.#setStatus(side, 'offline', 'rebuild-limit', wait);
        if (side.recoveryEpoch !== side.epoch) this.#scheduleRetry(side, wait);
        return 'limited';
      }
      this.#setStatus(side, 'connecting', 'rebuilding', null);
      // Custom servers get a test socket first (worklist A2/A3), from the current one on: the transport is built for
      // the first that opens one, so a dead server (or one the page's policy refuses) is failed over before a page
      // needs it. When none opens, the current one is built anyway (the engine may start) and the recovery takes over.
      const unreachable = !endpoint.gateway && !(await this.#pickCustom(side));
      endpoint = this.#endpoint(side) ?? endpoint;
      const kind = this.#kind;
      const url = wispUrl(endpoint, endpoint.gateway ? (this.#ticket?.value ?? null) : null);
      try {
        if (side.id === 'scramjet') {
          const sj = this.#deps.scramjet;
          if (!sj) throw new Error('the Scramjet transports are not available in this page');
          const t = await withTimeout(this.#deps, sj.build(kind, url), RECOVERY.initTimeoutMs, `${kind} transport init`);
          sj.wrapConnect(t, (wsUrl) => this.#checkWebSocket(wsUrl));
          side.current = t;
          // The first transport goes to the Controller's constructor (scramjetTransport()); every later one to the sink.
          if (this.#sink && side.built) this.#sink.setTransport(t);
        } else {
          const uv = this.#uv;
          if (!uv) throw new Error('bare-mux is not available');
          const mode: UvInstallReason = reason === 'start' ? 'start' : reason === 'configure' ? 'configure' : 'rebuild';
          const res = await withTimeout(
            this.#deps,
            uv.install(mode, this.#wantedUvKey(), kind, url, side.uvGen),
            RECOVERY.initTimeoutMs,
            'bare-mux setManualTransport',
          );
          if (res.key === this.#wantedUvKey()) side.uvGen = Math.max(side.uvGen ?? 0, res.gen);
          if (res.action === 'keep' && res.key !== this.#wantedUvKey()) {
            // A newer installation of another route runs (another GNOME tab's settings changed first); this tab's
            // settings follow shortly. Its status is that of the shared transport, which this host did not build.
            this.#deps.log('info', 'transport ultraviolet: kept the shared transport another engine host installed');
          }
        }
        if (side.built) this.#diag.rebuilds[side.id] += 1;
        side.built = true;
        if (unreachable) {
          this.#deps.log('warn', `transport ${side.id}: no custom Wisp server opened a test socket (built for ${redactTicket(url).slice(0, 200)})`);
          side.upgradeFailed = true;
          this.#setStatus(side, 'offline', 'gateway-unreachable', null);
          side.first.resolve();
          if (side.recoveryEpoch !== side.epoch) void this.#recover(side, 'connect-failed');
          return 'unreachable';
        }
        this.#afterBuild(side);
        side.first.resolve();
        return 'ok';
      } catch (err) {
        this.#deps.log('warn', `transport ${side.id}: ${reason} build failed: ${errText(err)}`);
        if (!side.built) {
          // The first build failed: the engine cannot start on this side (the core reports the engine as failed).
          this.#setStatus(side, 'offline', null, null);
          side.first.reject(err instanceof Error ? err : new Error(String(err)));
          return 'failed';
        }
        this.#setStatus(side, 'offline', null, null);
        if (side.recoveryEpoch !== side.epoch) void this.#recover(side, 'build-failed');
        return 'failed';
      }
    });
  }

  #scheduleRetry(side: Side, ms: number): void {
    if (side.retryTimer !== null) this.#deps.clearTimeout(side.retryTimer);
    const epoch = side.epoch;
    side.retryTimer = this.#deps.setTimeout(() => {
      side.retryTimer = null;
      if (epoch === side.epoch && side.enabled && side.status.state === 'offline') void this.#recover(side, 'build-failed');
    }, Math.max(ms, 1));
  }

  #checkWebSocket(url: string): 'allow' | 'block' {
    const hooks = this.#hooks;
    if (!hooks) return 'allow';
    try {
      const verdict = hooks.onWebSocket({
        engine: 'scramjet',
        tabId: null,
        url,
        method: 'GET',
        destination: 'websocket',
        topLevelUrl: null,
        isTopLevelDocument: false,
        documentUrl: null,
        referrer: null,
      });
      return verdict === 'block' ? 'block' : 'allow';
    } catch (err) {
      this.#deps.log('error', `onWebSocket hook: ${errText(err)}`);
      return 'allow';
    }
  }

  // ── Watchdog ───────────────────────────────────────────────────────────────────────────────────────────────────

  #onWindowSocket(e: WindowSocketEvent): void {
    const side = this.#sides.scramjet;
    if (!side.enabled || !side.built) return;
    const endpoint = this.#endpoint(side);
    if (!endpoint || socketBase(e.url) !== socketBase(endpoint.url)) return;
    this.#onSocket(side, e.ev, e.wasOpen);
  }

  #onUvSocket(e: UvSocketEvent): void {
    const side = this.#sides.ultraviolet;
    if (!side.enabled || !side.built) return;
    if (e.key !== this.#wantedUvKey()) return;
    if (side.uvGen !== null && e.gen < side.uvGen) return; // an old socket of a transport that was replaced
    side.uvGen = e.gen;
    this.#onSocket(side, e.ev, e.wasOpen);
  }

  #onSocket(side: Side, ev: 'connecting' | 'open' | 'close', wasOpen: boolean): void {
    if (ev === 'connecting') return;
    // A socket that closed or never opened: no earlier test result may vouch for a server any more.
    if (ev === 'close') this.#customTests.clear();
    if (ev === 'open') {
      side.upgradeFailed = false;
      side.failures = 0;
      side.waitingTicket = false;
      if (side.recoveryEpoch === side.epoch) this.#resetRecovery(side);
      this.#setStatus(side, 'ready', null, null);
      return;
    }
    if (wasOpen) {
      // A drop. libcurl reconnects by itself with the URL (and ticket) it was built with: the probe only renews a
      // rejected ticket before the next request fails. epoxy never reconnects: the probe decides how to rebuild.
      this.#diag.drops[side.id] += 1;
      if (side.status.state === 'ready') this.#setStatus(side, 'degraded', null, null);
      void this.#recover(side, 'drop');
      return;
    }
    side.upgradeFailed = true;
    if (side.status.state === 'ready') this.#setStatus(side, 'degraded', null, null);
    void this.#recover(side, 'connect-failed');
  }

  #resetRecovery(side: Side): void {
    side.epoch += 1;
    const wake = side.wake;
    side.wake = null;
    wake?.();
    if (side.retryTimer !== null) {
      this.#deps.clearTimeout(side.retryTimer);
      side.retryTimer = null;
    }
  }

  #sleep(side: Side, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.#deps.clearTimeout(timer);
        if (side.wake === done) side.wake = null;
        resolve();
      };
      const timer = this.#deps.setTimeout(done, ms);
      side.wake = done;
    });
  }

  async #probe(side: Side, endpoint: WispEndpoint): Promise<ProbeOutcome> {
    side.lastProbeAt = this.#deps.now();
    const url = probeUrl(endpoint, this.#ticket?.value ?? null);
    if (!url) return { kind: 'unreachable', status: null };
    let outcome: ProbeOutcome;
    try {
      const res = await this.#deps.probe(url);
      outcome = res ? classifyProbe(res.status, res.retryAfter, res.errorCode) : classifyProbe(null, null, null);
    } catch {
      outcome = classifyProbe(null, null, null);
    }
    const p = this.#diag.probes;
    if (outcome.kind === 'valid') p.valid += 1;
    else if (outcome.kind === 'rejected') p.rejected += 1;
    else if (outcome.kind === 'rate-limited') p.rateLimited += 1;
    else if (outcome.kind === 'upstream-down') p.upstreamDown += 1;
    else if (outcome.kind === 'unknown-profile') p.unknownProfile += 1;
    else p.unreachable += 1;
    this.#deps.log('debug', `transport ${side.id}: probe ${redactTicket(url)} → ${outcome.kind}`);
    return outcome;
  }

  /** Backoff for the n-th consecutive failure; after RECOVERY.probeAttempts, the idle retry. */
  #backoff(side: Side): number {
    const n = side.failures;
    side.failures += 1;
    return n >= RECOVERY.probeAttempts ? RECOVERY.idleRetryMs : backoffDelayMs(n, this.#deps.random());
  }

  async #recover(side: Side, reason: RecoverReason): Promise<void> {
    if (side.recoveryEpoch === side.epoch || !side.enabled) return;
    const epoch = side.epoch;
    side.recoveryEpoch = epoch;
    const live = (): boolean => epoch === side.epoch && side.enabled;
    let why: RecoverReason = reason;
    try {
      while (live()) {
        const endpoint = this.#endpoint(side);
        if (!endpoint) return;
        if (!endpoint.gateway) {
          // Custom servers have no probe: back off, move to the next server after a failed connect, rebuild.
          const wait = this.#backoff(side);
          this.#setStatus(side, 'offline', 'gateway-unreachable', wait);
          await this.#sleep(side, wait);
          if (!live()) return;
          if (side.upgradeFailed && this.#endpoints.length > 1) side.endpointIndex = (side.endpointIndex + 1) % this.#endpoints.length;
          side.upgradeFailed = false;
          if (await this.#rebuildFromRecovery(side, live)) return;
          continue;
        }
        const outcome = await this.#probe(side, endpoint);
        if (!live()) return;
        switch (outcome.kind) {
          case 'valid': {
            if (side.upgradeFailed) {
              // The ticket is valid and the gateway is up, yet the upgrade failed: the gateway's upstream (HolyWisp,
              // or the VPN location's instance) is down. Back off instead of rebuilding after every 426.
              side.upgradeFailed = false;
              const wait = this.#backoff(side);
              this.#setStatus(side, 'offline', 'upstream-unreachable', wait);
              await this.#sleep(side, wait);
              why = 'failure';
              // After the wait the probe runs again; a 426 then rebuilds once and the next socket tells.
              if (!live()) return;
              const again = await this.#probe(side, endpoint);
              if (!live()) return;
              if (again.kind !== 'valid') {
                this.#applyOutcome(side, again);
                if (await this.#waitForOutcome(side, again)) continue;
                return;
              }
              if (await this.#rebuildFromRecovery(side, live)) return;
              continue;
            }
            if (why === 'drop' && this.#kind === 'libcurl') {
              // libcurl reconnects on the next request by itself; nothing to rebuild.
              if (side.status.state === 'offline') this.#setStatus(side, 'degraded', null, null);
              return;
            }
            if (why === 'failure' && side.status.state === 'ready') return; // the transport is fine
            if (await this.#rebuildFromRecovery(side, live)) return;
            continue;
          }
          default:
            this.#applyOutcome(side, outcome);
            if (await this.#waitForOutcome(side, outcome)) {
              why = 'failure';
              continue;
            }
            return;
        }
      }
    } finally {
      if (side.recoveryEpoch === epoch) side.recoveryEpoch = null;
    }
  }

  /** Status for a non-426 probe outcome (and the ticket request for a 401). */
  #applyOutcome(side: Side, outcome: ProbeOutcome): void {
    switch (outcome.kind) {
      case 'rejected':
        side.upgradeFailed = false;
        side.waitingTicket = true;
        this.#setStatus(side, 'offline', 'ticket-rejected', null);
        this.#emitNeedTicket('rejected');
        return;
      case 'unknown-profile':
        this.#setStatus(side, 'offline', 'unknown-profile', null);
        return;
      case 'rate-limited':
        this.#setStatus(side, 'offline', 'rate-limited', outcome.retryAfterMs);
        return;
      case 'upstream-down':
        side.upgradeFailed = false;
        return;
      case 'unreachable':
        side.upgradeFailed = false;
        return;
      case 'valid':
        return;
    }
  }

  /** Waits as the outcome requires; true = probe again, false = stop (a ticket or a new route must come first). */
  async #waitForOutcome(side: Side, outcome: ProbeOutcome): Promise<boolean> {
    switch (outcome.kind) {
      case 'rejected':
      case 'unknown-profile':
      case 'valid':
        return false;
      case 'rate-limited':
        side.serverWait = true;
        try {
          await this.#sleep(side, outcome.retryAfterMs);
        } finally {
          side.serverWait = false;
        }
        return true;
      case 'upstream-down': {
        const wait = outcome.retryAfterMs ?? this.#backoff(side);
        if (outcome.retryAfterMs !== null) side.failures += 1;
        this.#setStatus(side, 'offline', 'upstream-unreachable', wait);
        side.serverWait = outcome.retryAfterMs !== null;
        try {
          await this.#sleep(side, wait);
        } finally {
          side.serverWait = false;
        }
        return true;
      }
      case 'unreachable': {
        const wait = this.#backoff(side);
        this.#setStatus(side, 'offline', 'gateway-unreachable', wait);
        await this.#sleep(side, wait);
        return true;
      }
    }
  }

  /**
   * The first custom server, from the side's current one on, whose test socket opens becomes the side's endpoint;
   * false when none does (the side's endpoint stays). Without deps.testSocket every server counts as reachable.
   */
  async #pickCustom(side: Side): Promise<boolean> {
    const n = this.#endpoints.length;
    for (let i = 0; i < n; i++) {
      const index = (side.endpointIndex + i) % n;
      const e = this.#endpoints[index];
      if (!e || e.gateway) continue;
      if (await this.#customReachable(wispUrl(e, null))) {
        side.endpointIndex = index;
        return true;
      }
    }
    return false;
  }

  /**
   * Whether a custom Wisp server opens a socket (deps.testSocket; without it every server counts as reachable). The
   * test socket is the engine-host realm's own, outside the taps; one result serves both sides for a moment.
   */
  async #customReachable(url: string): Promise<boolean> {
    const test = this.#deps.testSocket?.bind(this.#deps);
    if (!test) return true;
    const hit = this.#customTests.get(url);
    if (hit && this.#deps.now() - hit.at <= CUSTOM_TEST_REUSE_MS) return hit.ok;
    let ok: boolean;
    try {
      // The socket gives up (and closes) after CUSTOM_TEST_MS itself; the outer deadline only guards a test that
      // never settles.
      ok = await withTimeout(this.#deps, test(url, CUSTOM_TEST_MS), CUSTOM_TEST_MS + 1_000, 'custom Wisp test socket');
    } catch {
      ok = false;
    }
    this.#customTests.delete(url);
    this.#customTests.set(url, { at: this.#deps.now(), ok });
    for (const k of this.#customTests.keys()) {
      if (this.#customTests.size <= 8) break;
      this.#customTests.delete(k);
    }
    return ok;
  }

  /** A rebuild from a recovery run: true = done; false = it failed or hit the cap and the wait is over (probe again). */
  async #rebuildFromRecovery(side: Side, live: () => boolean): Promise<boolean> {
    const result = await this.#build(side, 'rebuild');
    if (result === 'unreachable') return false; // the custom branch backs off and moves to the next server
    if (result === 'ok' || result === 'skipped' || !live()) return true;
    if (result === 'limited') {
      await this.#sleep(side, Math.max(1, side.budget.waitMs(this.#deps.now())));
      return false;
    }
    const wait = this.#backoff(side);
    this.#setStatus(side, 'offline', null, wait);
    await this.#sleep(side, wait);
    return false;
  }
}
