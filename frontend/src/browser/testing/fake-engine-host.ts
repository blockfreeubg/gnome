/**
 * A fake engine host for unit tests of the app side (docs/WAVE-B.md §4 "Fakes"): it implements the DOM seam of
 * src/browser/engine/client.ts (`EngineEmbedder`) and answers the protocol over a real MessageChannel, like
 * `<proxy origin>/engine/` would. It validates every command it receives with the protocol's own validator
 * (`violations` lists anything invalid the app sent), keeps a per-tab back/forward list like the engine host, and lets
 * a test script events, raw (possibly hostile) messages, hellos and iframe loads.
 *
 * Test-only: nothing in the app imports it.
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  validateCommandMessage,
  type AnyCommandMessage,
  type BlockCategory,
  type BlockerState,
  type BlockerStats,
  type CommandResult,
  type CookieInfo,
  type CommandType,
  type EngineHostStatus,
  type EngineId,
  type EventMap,
  type EventType,
  type InitResult,
  type TabState,
  type Capability,
  type VpnVerifyResult,
} from '../../shared/engine-protocol';
import type { ConnectMessage } from '../../shared/engine-protocol';
import type { EngineEmbedder, EngineFrame, WindowMessage } from '../engine/client';

export const FAKE_PROXY_ORIGIN = 'http://127.0.0.1:28002';

export function fakeStatus(): EngineHostStatus {
  const transport = { state: 'ready' as const, transport: 'libcurl' as const, endpoint: 'default' as const, detail: null, since: 1, retryInMs: null };
  return {
    engines: {
      scramjet: { state: 'ready', version: '2.0.67-alpha.2', detail: null },
      ultraviolet: { state: 'ready', version: '3.2.10', detail: null },
    },
    transport: { scramjet: transport, ultraviolet: { ...transport } },
    sw: { controlled: true, build: 'test', current: true, updateWaiting: false },
    blocker: { state: 'off', lists: 0, detail: null },
  };
}

export function fakeInitResult(instance: string, overrides: Partial<InitResult> = {}): InitResult {
  return {
    instance,
    status: fakeStatus(),
    versions: {
      build: 'test',
      scramjet: '2.0.67-alpha.2',
      scramjetController: '0.0.14',
      ultraviolet: '3.2.10',
      bareMux: '2.1.9',
      transports: {
        scramjet: { libcurl: '2.0.6', epoxy: '3.0.2' },
        ultraviolet: { libcurl: '1.5.2', epoxy: '2.1.29' },
      },
    },
    capabilities: ['zoom', 'print', 'selectAll'],
    enforcedPermissions: ['autoplay', 'fullscreen'],
    timings: { swReadyMs: 10, scramjetMs: 20, ultravioletMs: 30, totalMs: 40 },
    ...overrides,
  };
}

interface FakeTab {
  entries: string[];
  index: number;
  title: string | null;
  loading: boolean;
  navId: number | null;
  engine: EngineId | null;
  error: EventMap['tab.error'] | null;
}

export type CommandHandler = (msg: AnyCommandMessage, host: FakeEngineHost) => unknown;

/** Handlers may return a value (the result), throw `{code, message}` (an error answer), or return HANG (no answer). */
export const HANG = Symbol('hang');

export interface FakeHostOptions {
  /** Post hellos automatically after create() (default true). */
  autoHello?: boolean;
  /** Emit loading/committed/loaded for GNOME-initiated navigations (default true). */
  autoNavigate?: boolean;
  /** Protocol version the hello carries (default PROTOCOL_VERSION). */
  protocol?: number;
  initResult?: (instance: string) => InitResult;
  /**
   * Emulate the content blocker (WAVE-B3 §7.1 fakes): `init` reports the `blocker` and `cookies` capabilities, the
   * status carries `blocker`, and `blocker.stats` / `blocker.reload` / `cookies.list` / `cookies.delete` answer from
   * the fake's own state (`blockerStats`, `cookies`).
   */
  blocker?: boolean;
}

let instanceCounter = 0;

/**
 * One fake engine host "document" per created iframe; `current` is the live one. Messages to the app go through the
 * registered window listener (hellos, mismatch) or the transferred port (results, events).
 */
export class FakeEngineHost implements EngineEmbedder {
  readonly origin = FAKE_PROXY_ORIGIN;
  readonly violations: string[] = [];
  readonly commands: AnyCommandMessage[] = [];
  readonly handlers = new Map<string, CommandHandler>();
  /** Every frame ever created (the client must create a fresh one per reconnect). */
  readonly frames: Array<{ window: object; removed: boolean; src: string; onLoad: () => void; instance: string }> = [];
  tabs = new Map<number, FakeTab>();
  port: MessagePort | null = null;
  #listeners = new Set<(ev: WindowMessage) => void>();
  #opts: Required<Omit<FakeHostOptions, 'initResult'>> & Pick<FakeHostOptions, 'initResult'>;
  /** The blocker's status as the next `status` / init reports it. */
  blockerStatus: EngineHostStatus['blocker'] = { state: 'off', lists: 0, detail: null };
  /** What `blocker.stats` answers (null: `unsupported`). */
  blockerStats: BlockerStats | null = null;
  /** blocker.reload calls (each starts a "build": the status goes to `building`). */
  reloads = 0;
  /**
   * What `vpn.verify` answers (WAVE-C §8.1): a result, or an error the command fails with. null = the capability is
   * not offered (`unsupported`); set before `init` so `vpnVerify` is among the capabilities.
   */
  vpnVerify: VpnVerifyResult | { code: string; message: string } | null = null;
  /** The jar `cookies.list` reports and `cookies.delete` edits. */
  cookies: CookieInfo[] = [];
  #navId = 0;
  #connected = false;

  constructor(opts: FakeHostOptions = {}) {
    this.#opts = { autoHello: true, autoNavigate: true, protocol: PROTOCOL_VERSION, blocker: false, ...opts };
  }

  get current(): (typeof this.frames)[number] | null {
    return this.frames.at(-1) ?? null;
  }

  get instance(): string {
    return this.current?.instance ?? '';
  }

  // ── EngineEmbedder ─────────────────────────────────────────────────────────────────────────────────────────────

  create(src: string, onLoad: () => void): EngineFrame {
    const window = { fake: 'engine-window', n: this.frames.length };
    const instance = `fake${String(++instanceCounter).padStart(8, '0')}`;
    const entry = { window, removed: false, src, onLoad, instance };
    this.frames.push(entry);
    this.#connected = false;
    this.port = null;
    this.tabs = new Map();
    // The fresh document loads, then repeats its hello until connected.
    queueMicrotask(() => {
      if (entry.removed) return;
      onLoad();
      if (this.#opts.autoHello) this.hello();
    });
    return {
      window,
      remove: () => {
        entry.removed = true;
      },
    };
  }

  onMessage(listener: (ev: WindowMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  postConnect(frame: EngineFrame, msg: ConnectMessage, targetOrigin: string, port: MessagePort): void {
    const cur = this.current;
    if (!cur || frame.window !== cur.window || cur.removed) return this.#violation('connect to a removed or foreign frame');
    if (targetOrigin !== this.origin) return this.#violation(`connect with target origin ${targetOrigin}`);
    if (msg.gnome !== 'connect' || msg.instance !== cur.instance) return this.#violation('connect for another instance');
    if (this.#connected) return this.#violation('second connect');
    if (msg.protocol !== this.#opts.protocol) {
      this.post({ gnome: 'mismatch', protocol: this.#opts.protocol, instance: cur.instance });
      return;
    }
    this.#connected = true;
    this.port = port;
    port.onmessage = (ev: MessageEvent) => void this.#onCommand(ev.data);
  }

  // ── Scripting ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** A window message from the current engine iframe (as the browser would deliver it). */
  post(data: unknown, from: { source?: unknown; origin?: string } = {}): void {
    const ev: WindowMessage = { source: from.source ?? this.current?.window ?? null, origin: from.origin ?? this.origin, data };
    for (const l of [...this.#listeners]) l(ev);
  }

  hello(instance = this.instance): void {
    this.post({ gnome: 'hello', protocol: this.#opts.protocol, build: 'test', instance });
  }

  /** The engine-host document reloads (an escaped page called location.reload()): an unexpected load. */
  reloadDocument(): void {
    const cur = this.current;
    if (!cur) return;
    cur.instance = `fake${String(++instanceCounter).padStart(8, '0')}`;
    this.#connected = false;
    this.port = null;
    this.tabs = new Map();
    cur.onLoad();
  }

  emit<T extends EventType>(type: T, p: EventMap[T]): void {
    this.raw({ k: 'evt', type, p });
  }

  /** Anything over the port, valid or not. */
  raw(data: unknown): void {
    if (!this.port) throw new Error('fake engine host is not connected');
    this.port.postMessage(data);
  }

  /** The blocker's state changes (a `status` event with the new blocker part). */
  setBlocker(state: BlockerState, detail: string | null = null, lists = this.blockerStatus.lists): void {
    this.blockerStatus = { state, lists, detail };
    if (this.port) this.emit('status', this.#status());
  }

  /** A tab's cumulative block counts for its current document (tab.blocked, `total` = their sum). */
  blocked(tabId: number, byCategory: Partial<Record<BlockCategory, number>>): void {
    const total = Object.values(byCategory).reduce((a, b) => a + (b ?? 0), 0);
    this.emit('tab.blocked', { tabId, total, byCategory });
  }

  /** A navigation the engine host announces before its page loads (tab.loading with `url`, WAVE-B3 C3). */
  announce(tabId: number, url: string): void {
    this.emit('tab.loading', { tabId, loading: true, url });
  }

  #status(): EngineHostStatus {
    return { ...fakeStatus(), blocker: { ...this.blockerStatus } };
  }

  on(type: CommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  commandsOf<T extends CommandType>(type: T): Array<Extract<AnyCommandMessage, { type: T }>> {
    return this.commands.filter((c) => c.type === type) as Array<Extract<AnyCommandMessage, { type: T }>>;
  }

  #violation(msg: string): void {
    this.violations.push(msg);
  }

  async #onCommand(data: unknown): Promise<void> {
    const v = validateCommandMessage(data);
    if (!v.ok) {
      this.#violation(`invalid command: ${v.error}`);
      if (v.id !== undefined) this.raw({ k: 'res', id: v.id, ok: false, error: { code: v.code === 'unknown_type' ? 'unknown_type' : 'bad_request', message: v.error } });
      return;
    }
    const msg = v.value;
    this.commands.push(msg);
    const handler = this.handlers.get(msg.type);
    try {
      const result = handler ? await handler(msg, this) : this.#default(msg);
      if (result === HANG) return;
      if (this.port) this.raw({ k: 'res', id: msg.id, ok: true, p: result });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (this.port) this.raw({ k: 'res', id: msg.id, ok: false, error: { code: e.code ?? 'failed', message: e.message ?? 'failed' } });
    }
  }

  // ── A minimal engine host ──────────────────────────────────────────────────────────────────────────────────────

  #default(msg: AnyCommandMessage): unknown {
    switch (msg.type) {
      case 'init': {
        if (this.#opts.initResult) return this.#opts.initResult(this.instance);
        const verify: Capability[] = this.vpnVerify ? ['vpnVerify'] : [];
        if (!this.#opts.blocker) return fakeInitResult(this.instance, verify.length ? { capabilities: ['zoom', 'print', 'selectAll', ...verify] } : {});
        return fakeInitResult(this.instance, { status: this.#status(), capabilities: ['zoom', 'print', 'selectAll', 'cookies', 'siteData', 'blocker', ...verify] });
      }
      case 'settings':
      case 'ticket':
      case 'tab.activate':
      case 'tab.findClear':
      case 'tab.action':
      case 'tab.download':
        return {};
      case 'status':
        return this.#status();
      case 'blocker.stats':
        if (!this.#opts.blocker || !this.blockerStats) throw { code: 'unsupported', message: 'no blocker' };
        return this.blockerStats;
      case 'blocker.reload':
        if (!this.#opts.blocker) throw { code: 'unsupported', message: 'no blocker' };
        this.reloads++;
        queueMicrotask(() => this.port && this.setBlocker('building', null));
        return {};
      case 'cookies.list': {
        if (!this.#opts.blocker) throw { code: 'unsupported', message: 'not offered by the fake' };
        const site = msg.p.site;
        const cookies = site === null ? this.cookies : this.cookies.filter((c) => c.domain.replace(/^\./, '') === site || c.domain.endsWith(`.${site}`));
        return { cookies: cookies.map((c) => ({ ...c })), truncated: false };
      }
      case 'cookies.delete': {
        if (!this.#opts.blocker) throw { code: 'unsupported', message: 'not offered by the fake' };
        const before = this.cookies.length;
        const p = msg.p;
        const ofSite = (c: CookieInfo): boolean => p.site !== null && (c.domain.replace(/^\./, '') === p.site || c.domain.endsWith(`.${p.site}`));
        this.cookies = p.all ? [] : this.cookies.filter((c) => !(ofSite(c) && (p.name === null || c.name === p.name)));
        return { deleted: before - this.cookies.length };
      }
      case 'ping':
        return { instance: this.instance, uptimeMs: 1000 };
      case 'tab.create': {
        if (this.tabs.has(msg.p.tabId)) throw { code: 'tab_exists', message: 'exists' };
        if (this.tabs.size >= LIMITS.maxLiveTabs) throw { code: 'too_many_tabs', message: 'too many' };
        const tab: FakeTab = { entries: [], index: 0, title: null, loading: false, navId: null, engine: null, error: null };
        this.tabs.set(msg.p.tabId, tab);
        const start = msg.p.start;
        if (start.kind === 'blank') return { navId: null, engine: null };
        if (start.kind === 'restore') {
          tab.entries = [...start.entries];
          tab.index = start.index;
          return this.#navigate(msg.p.tabId, start.entries[start.index] ?? 'https://example.com/', msg.p.engine, 'navigate', 'replace');
        }
        return this.#navigate(msg.p.tabId, start.url, msg.p.engine, 'navigate', 'push');
      }
      case 'tab.close':
        if (!this.tabs.delete(msg.p.tabId)) throw { code: 'no_tab', message: 'no tab' };
        return {};
      case 'tab.navigate':
        this.#tab(msg.p.tabId);
        return this.#navigate(msg.p.tabId, msg.p.url, msg.p.engine, 'navigate', 'push');
      case 'tab.go': {
        const tab = this.#tab(msg.p.tabId);
        const target = tab.index + msg.p.delta;
        if (target < 0 || target >= tab.entries.length) throw { code: 'no_entry', message: 'no entry' };
        tab.index = target;
        return this.#navigate(msg.p.tabId, tab.entries[target]!, null, 'history', 'traverse');
      }
      case 'tab.reload': {
        const tab = this.#tab(msg.p.tabId);
        const url = tab.entries[tab.index];
        if (!url) throw { code: 'no_document', message: 'no document' };
        return this.#navigate(msg.p.tabId, url, null, 'reload', 'replace');
      }
      case 'tab.stop': {
        const tab = this.#tab(msg.p.tabId);
        tab.loading = false;
        queueMicrotask(() => this.port && this.emit('tab.loading', { tabId: msg.p.tabId, loading: false }));
        return {};
      }
      case 'tab.state': {
        const t = this.#tab(msg.p.tabId);
        const state: TabState = { entries: t.entries, index: t.index, title: t.title, loading: t.loading, navId: t.navId, engine: t.engine, error: t.error };
        return state;
      }
      case 'tab.zoom':
        this.#tab(msg.p.tabId);
        return { factor: msg.p.factor };
      case 'tab.find':
        this.#tab(msg.p.tabId);
        return { matches: msg.p.query ? 3 : 0, active: msg.p.query ? 1 : 0, highlights: true, capped: false };
      case 'siteData.clear':
        if (!this.#opts.blocker) throw { code: 'unsupported', message: 'not offered by the fake' };
        if (msg.p.kinds.includes('cookies')) this.cookies = [];
        return {};
      case 'vpn.verify':
        if (!this.vpnVerify) throw { code: 'unsupported', message: 'not offered by the fake' };
        if ('code' in this.vpnVerify) throw this.vpnVerify;
        return { ...this.vpnVerify };
      case 'diagnostics':
      case 'suggest':
        throw { code: 'unsupported', message: 'not offered by the fake' };
    }
  }

  #tab(tabId: number): FakeTab {
    const t = this.tabs.get(tabId);
    if (!t) throw { code: 'no_tab', message: 'no tab' };
    return t;
  }

  #navigate(tabId: number, url: string, engine: EngineId | null, kind: 'navigate' | 'history' | 'reload', handling: 'push' | 'replace' | 'traverse'): CommandResult<'tab.navigate'> {
    const tab = this.#tab(tabId);
    const navId = ++this.#navId;
    const eng: EngineId = engine ?? 'scramjet';
    tab.navId = navId;
    tab.engine = eng;
    tab.loading = true;
    tab.error = null;
    if (this.#opts.autoNavigate) {
      queueMicrotask(() => {
        if (!this.port || !this.tabs.has(tabId)) return;
        this.emit('tab.loading', { tabId, loading: true });
        if (handling === 'push') {
          tab.entries = [...tab.entries.slice(0, tab.entries.length ? tab.index + 1 : 0), url].slice(-LIMITS.maxTabHistory);
          tab.index = tab.entries.length - 1;
        } else if (handling === 'replace') {
          if (tab.entries.length === 0) tab.entries = [url];
          else tab.entries[tab.index] = url;
        }
        tab.loading = false;
        this.emit('tab.committed', {
          tabId,
          navId,
          url,
          engine: eng,
          kind,
          historyHandling: handling,
          index: tab.index,
          length: tab.entries.length,
          canGoBack: tab.index > 0,
          canGoForward: tab.index < tab.entries.length - 1,
          ms: 5,
        });
        this.emit('tab.loaded', { tabId, navId, url, engine: eng, ms: 6 });
      });
    }
    return { navId, engine: eng };
  }
}

/** Resolves after pending microtasks and MessagePort deliveries (Node delivers port messages as macrotasks). */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A manual clock for EngineClient / TicketMinter tests. */
export class ManualClock {
  t = 1_800_000_000_000;
  #timers = new Map<number, { at: number; fn: () => void }>();
  #id = 0;
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#id;
    this.#timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.#timers.delete(h as number);
  };
  /** Advances the clock, running due timers in order (including ones they schedule). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.#timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.#timers.size;
  }
}
