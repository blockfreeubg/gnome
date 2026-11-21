/**
 * The app side of the engine protocol (docs/ENGINE-PROTOCOL.md §2–§5): embeds `<proxy origin>/engine/` in a sandboxed
 * cross-origin iframe, performs the hardened hello/connect handshake, sends commands with per-type timeouts and
 * validates every result and event before anything else sees it.
 *
 * Trust: the proxy origin is one shared realm (§1.1), so everything that arrives here may come from a hostile page
 * that escaped its engine. The pipeline for an event is fixed (§1.2 rule 1): validate → drop unknown tab/download ids
 * (silently within TIMEOUTS.closedTabGraceMs of closing the tab) → admitEvent() with one TokenBuckets per port →
 * handle. Compromise signals (hellos the app did not ask for, iframe loads it did not cause, invalid events and
 * results) are counted apart from the benign drops (§1.2 rule 8).
 *
 * The client never re-navigates its iframe: to reconnect (Retry, "Restart browser engine", recovery after an
 * unexpected load) it replaces the element (§2.3), so a reconnect adds no session-history entry.
 *
 * DOM access goes through `EngineEmbedder` (src/browser/engine/embed.ts in the app, a fake in unit tests), so the
 * whole state machine runs in Node.
 */
import {
  admitEvent,
  commandTimeoutMs,
  decideHello,
  PROTOCOL_VERSION,
  TIMEOUTS,
  TokenBuckets,
  validateCommandResult,
  validateEventMessage,
  validateMismatch,
  validateResultMessage,
  type AnyEventMessage,
  type CommandErrorCode,
  type CommandPayload,
  type CommandResult,
  type CommandType,
  type ConnectMessage,
  type InitPayload,
  type InitResult,
} from '../../shared/engine-protocol';
import { engineHostUrl } from '../../shared/proxy-origin';

// ── DOM seam ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One engine iframe element. */
export interface EngineFrame {
  /** The iframe's contentWindow (compared with `MessageEvent.source`). */
  readonly window: unknown;
  remove(): void;
}

export interface WindowMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface EngineEmbedder {
  /**
   * Creates and inserts a fresh engine iframe whose `src` is `src` (never changed afterwards). `onLoad` runs for
   * every `load` event of that element.
   */
  create(src: string, onLoad: () => void): EngineFrame;
  /** Window `message` events of the app document. */
  onMessage(listener: (ev: WindowMessage) => void): () => void;
  /** Posts the connect message to the frame with the port transferred. */
  postConnect(frame: EngineFrame, msg: ConnectMessage, targetOrigin: string, port: MessagePort): void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ── State and counters ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * - `idle`: no iframe yet (created when the browser view first needs a proxied tab).
 * - `starting`: iframe created, expecting a hello. `connecting`: connected, `init` in flight. `ready`.
 * - `failed`: no hello within TIMEOUTS.helloWaitMs (a late first hello from the same iframe still connects), or `init`
 *   failed (Retry replaces the iframe).
 * - `mismatch`: another protocol version ("GNOME was updated — Reload").
 * - `unresponsive`: two pings in a row timed out ("Restart browser engine").
 */
export type EngineClientState = 'idle' | 'starting' | 'connecting' | 'ready' | 'failed' | 'mismatch' | 'unresponsive';

export interface ProtocolCounters {
  /** Compromise signals (ENGINE-PROTOCOL §1.2 rule 8). */
  unexpectedHellos: number;
  unexpectedLoads: number;
  invalidEvents: number;
  invalidResults: number;
  /** Benign: not compromise signals. */
  rateLimited: number;
  unknownIds: number;
  libraryLimited: number;
  refusedShortcuts: number;
  /** Results that arrived after their command timed out (or for ids never sent). */
  lateResults: number;
  /** Events of a type this app does not know (a newer engine host): ignored. */
  unknownEventTypes: number;
  /** Site exposures over the budget (WAVE-B3 D5): those sites got the global settings, without their site rules. */
  droppedExposures: number;
}

export const emptyCounters = (): ProtocolCounters => ({
  unexpectedHellos: 0,
  unexpectedLoads: 0,
  invalidEvents: 0,
  invalidResults: 0,
  rateLimited: 0,
  unknownIds: 0,
  libraryLimited: 0,
  refusedShortcuts: 0,
  lateResults: 0,
  unknownEventTypes: 0,
  droppedExposures: 0,
});

export function compromiseSignals(c: ProtocolCounters): number {
  return c.unexpectedHellos + c.unexpectedLoads + c.invalidEvents + c.invalidResults;
}

/** A command that failed: the engine host's error code, or one of the client's own. */
export class EngineCommandError extends Error {
  readonly code: CommandErrorCode | 'not_ready' | 'restarted';
  constructor(code: CommandErrorCode | 'not_ready' | 'restarted', message: string) {
    super(message);
    this.name = 'EngineCommandError';
    this.code = code;
  }
}

export type IdStatus = 'known' | 'closed' | 'unknown';

/** Why the engine host went away: the client replaces the iframe after each. */
export type ResetReason = 'unexpected-load' | 'retry' | 'restart';

export interface EngineClientDeps {
  embedder: EngineEmbedder;
  /** `/api/config` → proxy.origin. */
  proxyOrigin: string;
  /** The `init` payload for a freshly connected engine host (settings snapshot, ticket, clearOnStart). */
  buildInit(): Promise<InitPayload>;
  /** Whether a tab id is one of the app's live proxied tabs, one closed less than closedTabGraceMs ago, or neither. */
  tabStatus(tabId: number): IdStatus;
  /**
   * A download id of the current instance: `known` (the app records it), `closed` (announced by download.started but
   * not recorded, over LIBRARY_LIMITS or with the downloads list off, or already done: its events are dropped without
   * being counted, §6.9) or `unknown` (never announced: dropped and counted, §1.2 rule 8).
   */
  downloadStatus(downloadId: string): IdStatus;
  /** A validated, admitted event. */
  onEvent(msg: AnyEventMessage): void;
  /**
   * A tab's event was dropped by the rate limits (the app asks tab.state: the navigation watchdog). `msg` is the
   * validated event (a dropped tab.openRequest still goes to the pop-up indicator, where only the user can open it).
   */
  onRateLimited?(tabId: number, msg: AnyEventMessage): void;
  /** `init` succeeded on a new engine host instance (the app re-creates its live tabs after a reset). */
  onReady(result: InitResult, firstStart: boolean): void;
  /** The connected engine host is gone; pending commands were rejected. `instance` is the old instance. */
  onReset?(reason: ResetReason, instance: string | null): void;
  onStateChange?(state: EngineClientState, detail: string | null): void;
  onCounters?(counters: Readonly<ProtocolCounters>): void;
  clock?: Clock;
}

interface Pending {
  type: CommandType;
  /** An e2e-only `test.*` command: its result is not one of the protocol's (testCommand). */
  raw?: boolean;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The id an event's validity depends on: its tab (opener for openRequest) or its download. */
function eventIds(msg: AnyEventMessage): { tabId?: number; downloadId?: string } {
  switch (msg.type) {
    case 'status':
    case 'needTicket':
    case 'log':
      return {};
    case 'tab.openRequest':
      return { tabId: msg.p.openerTabId };
    case 'download.progress':
    case 'download.done':
      return { downloadId: msg.p.downloadId };
    default:
      return { tabId: (msg.p as { tabId: number }).tabId };
  }
}

export class EngineClient {
  readonly #deps: EngineClientDeps;
  readonly #clock: Clock;
  #state: EngineClientState = 'idle';
  #detail: string | null = null;
  #frame: EngineFrame | null = null;
  #loadsSeen = 0;
  #expecting = false;
  #instance: string | null = null;
  #port: MessagePort | null = null;
  #buckets = new TokenBuckets();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #helloTimer: unknown = null;
  #pingTimer: unknown = null;
  #pingFailures = 0;
  #visible = false;
  #offMessage: (() => void) | null = null;
  #info: InitResult | null = null;
  #started = false;
  #generation = 0;
  readonly counters: ProtocolCounters = emptyCounters();

  constructor(deps: EngineClientDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  get state(): EngineClientState {
    return this.#state;
  }

  get detail(): string | null {
    return this.#detail;
  }

  /** The connected instance (null before the first connect and while reconnecting). */
  get instance(): string | null {
    return this.#instance;
  }

  /** The last `init` result of the connected engine host. */
  get info(): InitResult | null {
    return this.#info;
  }

  /** Creates the engine iframe if none exists yet (the browser view needs a proxied tab). */
  start(): void {
    if (this.#frame) return;
    this.#offMessage ??= this.#deps.embedder.onMessage((ev) => this.#onWindowMessage(ev));
    this.#replace();
  }

  /** Retry / "Restart browser engine" (a gesture in GNOME's UI): replaces the iframe, never re-navigates it. */
  restart(reason: 'retry' | 'restart' = 'restart'): void {
    this.#offMessage ??= this.#deps.embedder.onMessage((ev) => this.#onWindowMessage(ev));
    this.#reset(reason);
  }

  /** The browser view became visible or hidden: liveness pings run only while it is visible. */
  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    if (visible) this.#schedulePing(0);
    else this.#cancelPing();
  }

  /** Counts a benign drop that the app decided itself (LIBRARY_LIMITS, refused forwarded shortcuts, the exposure budget). */
  count(key: 'libraryLimited' | 'refusedShortcuts' | 'droppedExposures'): void {
    this.counters[key]++;
    this.#deps.onCounters?.(this.counters);
  }

  /** Sends a command; resolves with its validated result. Fails with `not_ready` unless the engine host is ready. */
  send<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<CommandResult<T>> {
    if ((this.#state !== 'ready' && this.#state !== 'unresponsive') || !this.#port) {
      return Promise.reject(new EngineCommandError('not_ready', 'The browser engine is not running.'));
    }
    return this.#send(type, payload);
  }

  /**
   * e2e builds only (`npm run build:e2e`): a raw `test.*` command for the engine host's e2e handlers (they exist only in
   * e2e builds of the engine host). Its result is not validated: it is not a protocol command. Production builds have
   * the constant false and refuse it.
   */
  testCommand(type: string, payload: unknown): Promise<unknown> {
    if (!__GNOME_ENGINE_TEST__ || !/^test\.[A-Za-z]{1,32}$/.test(type)) return Promise.reject(new EngineCommandError('unsupported', 'Not an e2e build.'));
    if ((this.#state !== 'ready' && this.#state !== 'unresponsive') || !this.#port) {
      return Promise.reject(new EngineCommandError('not_ready', 'The browser engine is not running.'));
    }
    const port = this.#port;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        if (this.#pending.delete(id)) reject(new EngineCommandError('timeout', `The browser engine did not answer (${type}).`));
      }, 10_000);
      this.#pending.set(id, { type: type as CommandType, raw: true, resolve, reject, timer });
      port.postMessage({ k: 'cmd', id, type, p: payload });
    });
  }

  /** Removes the iframe and every listener (tests, app teardown). */
  dispose(): void {
    this.#teardown(new EngineCommandError('restarted', 'The browser engine was stopped.'));
    this.#frame?.remove();
    this.#frame = null;
    this.#offMessage?.();
    this.#offMessage = null;
    this.#setState('idle', null);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────

  #setState(state: EngineClientState, detail: string | null): void {
    if (state === this.#state && detail === this.#detail) return;
    this.#state = state;
    this.#detail = detail;
    this.#deps.onStateChange?.(state, detail);
  }

  #teardown(err: EngineCommandError): void {
    this.#generation++;
    this.#expecting = false;
    this.#clock.clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
    this.#cancelPing();
    this.#pingFailures = 0;
    for (const [, p] of this.#pending) {
      this.#clock.clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    if (this.#port) {
      this.#port.onmessage = null;
      this.#port.close();
    }
    this.#port = null;
    this.#buckets = new TokenBuckets();
    this.#info = null;
    this.#pendingInstance = null;
  }

  #reset(reason: ResetReason): void {
    const old = this.#instance;
    this.#teardown(new EngineCommandError('restarted', 'The browser engine restarted.'));
    this.#instance = null;
    if (old !== null || this.#started) this.#deps.onReset?.(reason, old);
    this.#replace();
  }

  /** Removes the current iframe (if any) and inserts a fresh one, then expects exactly one hello. */
  #replace(): void {
    this.#frame?.remove();
    this.#loadsSeen = 0;
    const generation = this.#generation;
    const frame = this.#deps.embedder.create(engineHostUrl(this.#deps.proxyOrigin), () => this.#onLoad(frame, generation));
    this.#frame = frame;
    this.#expecting = true;
    this.#setState('starting', null);
    // The hello timeout shows "did not start" but does not end `expecting` (HelloContext.expecting, ENGINE-PROTOCOL
    // §2.2 step 5): a late first hello from this same, never-connected iframe still connects (failed → connecting).
    // Only an accepted hello (connect or mismatch) or replacing the iframe (Retry, restart, teardown) ends the window.
    this.#helloTimer = this.#clock.setTimeout(() => {
      this.#helloTimer = null;
      if (generation !== this.#generation || !this.#expecting) return;
      this.#setState('failed', 'The browser engine did not start.');
    }, TIMEOUTS.helloWaitMs);
  }

  #onLoad(frame: EngineFrame, generation: number): void {
    if (frame !== this.#frame || generation !== this.#generation) return;
    this.#loadsSeen++;
    // The first load of a fresh iframe is the one the app caused. Any later one means the engine-host document was
    // reloaded or navigated behind the app's back (§2.3): a compromise signal, then recovery with a fresh iframe.
    if (this.#loadsSeen === 1) return;
    this.counters.unexpectedLoads++;
    this.#deps.onCounters?.(this.counters);
    this.#reset('unexpected-load');
  }

  #onWindowMessage(ev: WindowMessage): void {
    const frame = this.#frame;
    if (!frame) return;
    // A mismatch answer to our connect (another protocol version on the engine-host side).
    if (ev.source === frame.window && ev.origin === new URL(this.#deps.proxyOrigin).origin && isRecord(ev.data) && ev.data.gnome === 'mismatch') {
      const m = validateMismatch(ev.data);
      if (m.ok && m.value.instance === this.#pendingInstance) this.#mismatch();
      return;
    }
    const decision = decideHello(ev, {
      expectedSource: frame.window,
      proxyOrigin: new URL(this.#deps.proxyOrigin).origin,
      expecting: this.#expecting,
      connectedInstance: this.#instance ?? this.#pendingInstance,
    });
    switch (decision.action) {
      case 'ignore':
        return;
      case 'unexpected':
        this.counters.unexpectedHellos++;
        this.#deps.onCounters?.(this.counters);
        return;
      case 'mismatch':
        this.#expecting = false;
        this.#mismatch();
        return;
      case 'connect':
        this.#connect(frame, decision.hello.instance);
    }
  }

  #pendingInstance: string | null = null;

  #mismatch(): void {
    this.#teardown(new EngineCommandError('restarted', 'GNOME was updated.'));
    this.#setState('mismatch', 'GNOME was updated. Reload to keep browsing.');
  }

  #connect(frame: EngineFrame, instance: string): void {
    this.#expecting = false;
    this.#clock.clearTimeout(this.#helloTimer);
    this.#helloTimer = null;
    const channel = new MessageChannel();
    const port = channel.port1;
    this.#port = port;
    this.#pendingInstance = instance;
    port.onmessage = (ev: MessageEvent) => this.#onPortMessage(ev.data);
    const generation = this.#generation;
    this.#deps.embedder.postConnect(frame, { gnome: 'connect', protocol: PROTOCOL_VERSION, instance }, new URL(this.#deps.proxyOrigin).origin, channel.port2);
    // A mismatch answer can arrive synchronously in tests (and tears this connection down).
    if (generation !== this.#generation) return;
    this.#setState('connecting', null);
    void (async () => {
      let payload: InitPayload;
      try {
        payload = await this.#deps.buildInit();
      } catch (err) {
        if (generation !== this.#generation) return;
        this.#setState('failed', err instanceof Error ? err.message : 'The browser engine could not be configured.');
        return;
      }
      if (generation !== this.#generation) return;
      try {
        const result = await this.#send('init', payload);
        if (generation !== this.#generation) return;
        const first = !this.#started;
        this.#started = true;
        this.#instance = instance;
        this.#pendingInstance = null;
        this.#info = result;
        this.#setState('ready', null);
        if (this.#visible) this.#schedulePing(TIMEOUTS.pingIntervalMs);
        this.#deps.onReady(result, first);
      } catch (err) {
        if (generation !== this.#generation) return;
        const message = err instanceof EngineCommandError && err.code === 'timeout' ? 'The browser engine did not finish starting.' : err instanceof Error ? err.message : 'The browser engine failed to start.';
        this.#setState('failed', message);
      }
    })();
  }

  // ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

  #send<T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<CommandResult<T>> {
    const port = this.#port;
    if (!port) return Promise.reject(new EngineCommandError('not_ready', 'The browser engine is not running.'));
    const id = this.#nextId++;
    return new Promise<CommandResult<T>>((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new EngineCommandError('timeout', `The browser engine did not answer (${type}).`));
      }, commandTimeoutMs(type));
      this.#pending.set(id, { type, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        port.postMessage({ k: 'cmd', id, type, p: payload });
      } catch (err) {
        this.#clock.clearTimeout(timer);
        this.#pending.delete(id);
        reject(new EngineCommandError('failed', err instanceof Error ? err.message : 'Could not send the command.'));
      }
    });
  }

  #onPortMessage(data: unknown): void {
    const kind = isRecord(data) ? data.k : undefined;
    if (kind === 'res') this.#onResult(data);
    else if (kind === 'evt') this.#onEventMessage(data);
    else this.#invalid('invalidEvents');
  }

  #invalid(key: 'invalidEvents' | 'invalidResults'): void {
    this.counters[key]++;
    this.#deps.onCounters?.(this.counters);
  }

  #onResult(data: unknown): void {
    const env = validateResultMessage(data);
    if (!env.ok) return this.#invalid('invalidResults');
    const pending = this.#pending.get(env.value.id);
    if (!pending) {
      this.counters.lateResults++;
      this.#deps.onCounters?.(this.counters);
      // A late answer to a command this port sent (typically a ping that timed out) still shows the engine host is
      // alive again: "not responding" ends without a restart.
      if (env.value.id < this.#nextId && this.#state === 'unresponsive') this.noteAlive();
      return;
    }
    this.#pending.delete(env.value.id);
    this.#clock.clearTimeout(pending.timer);
    if (!env.value.ok) {
      pending.reject(new EngineCommandError(env.value.error.code, env.value.error.message));
      return;
    }
    if (pending.raw) {
      pending.resolve(env.value.p);
      return;
    }
    const result = validateCommandResult(pending.type, env.value.p);
    if (!result.ok) {
      this.#invalid('invalidResults');
      pending.reject(new EngineCommandError('failed', `Invalid answer from the browser engine (${pending.type}).`));
      return;
    }
    pending.resolve(result.value);
    if (this.#state === 'unresponsive') this.noteAlive();
  }

  #onEventMessage(data: unknown): void {
    const v = validateEventMessage(data);
    if (!v.ok) {
      if (v.code === 'unknown_type') {
        this.counters.unknownEventTypes++;
        this.#deps.onCounters?.(this.counters);
        return;
      }
      return this.#invalid('invalidEvents');
    }
    const msg = v.value;
    // Only a connected, initialized engine host may emit events (init's own result comes first).
    if (this.#state !== 'ready' && this.#state !== 'unresponsive') {
      this.counters.unknownIds++;
      this.#deps.onCounters?.(this.counters);
      return;
    }
    const ids = eventIds(msg);
    if (ids.tabId !== undefined) {
      const status = this.#deps.tabStatus(ids.tabId);
      if (status !== 'known') {
        // In flight when the app closed the tab: dropped without counting.
        if (status === 'unknown') {
          this.counters.unknownIds++;
          this.#deps.onCounters?.(this.counters);
        }
        return;
      }
    }
    if (ids.downloadId !== undefined) {
      const status = this.#deps.downloadStatus(ids.downloadId);
      if (status !== 'known') {
        // An unrecorded download (over LIBRARY_LIMITS, §6.9) is dropped silently; an id no download.started announced
        // is counted like an unknown tab id.
        if (status === 'unknown') {
          this.counters.unknownIds++;
          this.#deps.onCounters?.(this.counters);
        }
        return;
      }
    }
    if (!admitEvent(this.#buckets, msg, this.#clock.now())) {
      this.counters.rateLimited++;
      this.#deps.onCounters?.(this.counters);
      if (ids.tabId !== undefined) this.#deps.onRateLimited?.(ids.tabId, msg);
      return;
    }
    this.#deps.onEvent(msg);
  }

  /** Forget a closed tab's or finished download's rate-limit buckets. */
  forgetScope(scope: { tabId: number } | { downloadId: string }): void {
    this.#buckets.forget('tabId' in scope ? `tab:${scope.tabId}` : `download:${scope.downloadId}`);
  }

  // ── Liveness ───────────────────────────────────────────────────────────────────────────────────────────────────

  #cancelPing(): void {
    this.#clock.clearTimeout(this.#pingTimer);
    this.#pingTimer = null;
  }

  #schedulePing(delay: number): void {
    this.#cancelPing();
    const live = (): boolean => this.#state === 'ready' || this.#state === 'unresponsive';
    if (!this.#visible || !live()) return;
    const generation = this.#generation;
    this.#pingTimer = this.#clock.setTimeout(() => {
      if (generation !== this.#generation || !live()) return;
      this.#send('ping', {})
        .then(() => {
          if (generation !== this.#generation) return;
          this.#pingFailures = 0;
          // #onResult already turned "not responding" back into ready (noteAlive).
          this.#schedulePing(TIMEOUTS.pingIntervalMs);
        })
        .catch((err: unknown) => {
          if (generation !== this.#generation) return;
          if (err instanceof EngineCommandError && err.code === 'timeout') {
            this.#pingFailures++;
            if (this.#pingFailures >= 2 && this.#state === 'ready') this.#setState('unresponsive', 'The browser engine is not responding.');
          }
          // While "not responding", keep asking (more often): the page's script may finish, and no restart is automatic.
          this.#schedulePing(this.#state === 'unresponsive' ? TIMEOUTS.pingMs : TIMEOUTS.pingIntervalMs);
        });
    }, delay);
  }

  /** "Not responding" → a later answer to any command clears it (the page's script finished). */
  noteAlive(): void {
    if (this.#state === 'unresponsive') {
      this.#pingFailures = 0;
      this.#setState('ready', null);
      this.#schedulePing(TIMEOUTS.pingIntervalMs);
    }
  }
}
