/**
 * Test doubles for the transport manager's unit tests (manager.test.ts, shared-uv.test.ts): a manual clock, fake
 * Scramjet transports with a socket tap, and a fake bare-mux SharedWorker that runs the real uv-worker-code.ts.
 * Not imported by production code.
 */

import type { TransportKind } from '../../shared/engine-protocol';
import type { ScramjetTransport } from '../../shared/transport';
import type { ManagerDeps, ProbeResponse, RawResponse, ScramjetBackend, WindowSocketEvent } from './backends';

export const settle = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

export class FakeClock {
  now = 1_700_000_000_000;
  #seq = 0;
  #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (id: unknown): void => {
    this.#timers.delete(id as number);
  };

  pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Runs every timer due within `ms`, in order, letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await settle();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.#timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

export interface FakeSjTransport {
  kind: TransportKind;
  url: string;
  inits: number;
}

/** Scramjet side: records builds, lets a test fire socket events, fails builds on demand. */
export class FakeScramjet implements ScramjetBackend {
  builds: FakeSjTransport[] = [];
  active = 0;
  maxActive = 0;
  failNext = 0;
  buildDelayMs = 0;
  readonly #listeners = new Set<(e: WindowSocketEvent) => void>();
  constructor(private readonly clock: FakeClock) {}

  async build(kind: TransportKind, url: string): Promise<ScramjetTransport> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.buildDelayMs) await new Promise<void>((r) => this.clock.setTimeout(r, this.buildDelayMs));
      else await settle(1);
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('init failed');
      }
      const t: FakeSjTransport = { kind, url, inits: 1 };
      this.builds.push(t);
      return t;
    } finally {
      this.active -= 1;
    }
  }

  onSocket(listener: (e: WindowSocketEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  socket(ev: WindowSocketEvent['ev'], url: string, wasOpen = false): void {
    for (const l of this.#listeners) l({ ev, url, wasOpen, code: ev === 'close' ? 1006 : null });
  }

  async request(): Promise<RawResponse> {
    return { status: 200, headers: [['content-type', 'application/json']], body: '["a",["ab","ac"]]' };
  }

  wrapped = 0;
  wrapConnect(): void {
    this.wrapped += 1;
  }
}

/** A probe that answers from a script (the last entry repeats); `null` = network error. */
export class FakeProbe {
  calls: string[] = [];
  answers: Array<ProbeResponse | null> = [{ status: 426, retryAfter: null, errorCode: 'upgrade_required' }];
  probe = async (url: string): Promise<ProbeResponse | null> => {
    this.calls.push(url);
    const a = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    return a === undefined ? null : a;
  };
  static valid: ProbeResponse = { status: 426, retryAfter: null, errorCode: 'upgrade_required' };
  static rejected: ProbeResponse = { status: 401, retryAfter: null, errorCode: 'wisp_ticket_invalid' };
  static rateLimited = (s: string): ProbeResponse => ({ status: 429, retryAfter: s, errorCode: 'rate_limited' });
  static upstreamDown = (s: string | null): ProbeResponse => ({ status: 503, retryAfter: s, errorCode: 'wisp_upstream_unavailable' });
  static unknownProfile: ProbeResponse = { status: 404, retryAfter: null, errorCode: 'not_found' };
}

export function fakeDeps(clock: FakeClock, parts: Partial<ManagerDeps> & { probe: ManagerDeps['probe'] }): ManagerDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    scramjet: null,
    uv: () => {
      throw new Error('no Ultraviolet backend in this test');
    },
    now: () => clock.now,
    random: () => 0.5,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: (level, message) => logs.push(`${level}: ${message}`),
    logs,
    ...parts,
  };
}

// ── A fake bare-mux SharedWorker running the real install code ───────────────────────────────────────────────────

type Listener = (e: { data?: unknown; code?: number }) => void;

/** The WebSocket of the fake worker realm: the tap wraps it, the fake transport creates them. */
export class FakeWorkerSocket {
  static all: FakeWorkerSocket[] = [];
  /** URLs the worker's policy refuses: the constructor throws, as Firefox's does for a CSP-blocked socket. */
  static refused = new Set<string>();
  readonly #listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    if (FakeWorkerSocket.refused.has(url)) throw new Error('NS_ERROR_CONTENT_BLOCKED');
    FakeWorkerSocket.all.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  /** `error` alone is what Chromium fires for a CSP-blocked socket (no `close` follows). */
  fire(type: 'open' | 'close' | 'error', code = 1006): void {
    for (const fn of this.#listeners.get(type) ?? []) fn({ code });
  }
}

/** In-process stand-in for a MessagePort pair (no structured clone, no transfer). */
export class FakePort {
  other: FakePort | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  postMessage(data: unknown): void {
    const target = this.other;
    if (this.closed || !target || target.closed) return;
    queueMicrotask(() => target.onmessage?.({ data }));
  }
  close(): void {
    this.closed = true;
  }
}

export class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/** A localStorage stand-in (one per origin: every engine host of the fake worker shares it). */
export class FakeStorage {
  readonly #items = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#items.set(k, String(v));
  }
  removeItem(k: string): void {
    this.#items.delete(k);
  }
}

interface BareMuxMessage {
  message: { type: string; client?: { function?: unknown; args?: unknown[] } };
  port: FakePort;
}

/**
 * One fake bare-mux SharedWorker. Like bare-mux 2.1.9's worker it handles every connected port in `self.onconnect`
 * (`set` runs the code with `new AsyncFunction(code)()`, `bare-mux-remote` takes a port, `get` answers the name), so
 * the install code's lock wraps it exactly as in the browser. `set()` runs code directly (a port connected before any
 * lock); `connect()` + `setVia()` go through a port.
 */
export class FakeBareMuxWorker {
  readonly self: Record<string, unknown> & { WebSocket: unknown; onconnect: unknown; __gnomeUv?: { taps: unknown[]; gen: number; key: string | null } };
  transport: unknown = null;
  name = '';
  constructions = 0;
  initFails = 0;
  /** localStorage of the origin all windows of this worker belong to. */
  readonly storage = new FakeStorage();
  constructor() {
    const worker = this;
    class FakeBareTransport {
      readonly opts: { wisp: string };
      ready = false;
      constructor(opts: { wisp: string }) {
        this.opts = opts;
        worker.constructions += 1;
      }
      async init(): Promise<void> {
        await settle(1);
        if (worker.initFails > 0) {
          worker.initFails -= 1;
          throw new Error('init failed');
        }
        this.ready = true;
      }
      /** What bare-mux does for a page's request: open the Wisp socket. */
      openSocket(): FakeWorkerSocket {
        const Ws = worker.self.WebSocket as new (url: string) => FakeWorkerSocket;
        return new Ws(this.opts.wisp);
      }
    }
    this.self = {
      WebSocket: FakeWorkerSocket,
      __import: async (path: string) => ({ default: FakeBareTransport, path }),
      onconnect: null,
    };
    this.self.onconnect = (e: { ports: FakePort[] }) => {
      const port = e.ports[0];
      if (!port) return;
      port.onmessage = (ev: { data: unknown }) => {
        const { message, port: reply } = ev.data as BareMuxMessage;
        if (message.type === 'set') {
          const client = message.client ?? {};
          const done =
            client.function === 'bare-mux-remote'
              ? Promise.resolve().then(() => {
                  this.transport = client.args?.[0] ?? null;
                  this.name = `bare-mux-remote (${String(client.args?.[1])})`;
                })
              : this.set(String(client.function), client.args ?? []);
          done.then(
            () => reply.postMessage({ type: 'set' }),
            (err: unknown) => reply.postMessage({ type: 'error', error: String((err as Error)?.message ?? err) }),
          );
        } else if (message.type === 'get') reply.postMessage({ type: 'get', name: this.name });
      };
    };
  }

  async set(code: string, args: unknown[]): Promise<void> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (self: unknown) => Promise<[new (...a: unknown[]) => unknown, string]>;
    const fn = new AsyncFunction('self', code.replace('await import(', 'await self.__import('));
    const [Cls, name] = await fn(this.self);
    this.transport = new Cls(...args);
    this.name = name;
  }

  /** A new client port (`new SharedWorker(…).port`), handled by whatever `self.onconnect` is now. */
  connect(): FakePort {
    const ch = new FakeMessageChannel();
    (this.self.onconnect as (e: { ports: FakePort[] }) => void)({ ports: [ch.port2] });
    return ch.port1;
  }

  /** A bare-mux `set` through a port (what BareMuxConnection.setManualTransport sends); rejects with the worker's error. */
  setVia(port: FakePort, fn: string, args: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ch = new FakeMessageChannel();
      ch.port1.onmessage = (e) => {
        const d = e.data as { type: string; error?: string };
        if (d.type === 'error') reject(new Error(d.error));
        else resolve();
      };
      port.postMessage({ message: { type: 'set', client: { function: fn, args } }, port: ch.port2 });
    });
  }

  /** The socket the current transport opens for a request. */
  openSocket(): FakeWorkerSocket {
    return (this.transport as { openSocket(): FakeWorkerSocket }).openSocket();
  }
}

/**
 * A window for bareMuxUvBackend() whose BareMux talks to `worker` (each window = one engine host). With `storage`
 * (the default: the worker's origin storage, shared by every window) the backend finds the lock secret; `null` models
 * a page without usable localStorage. The connection's port is connected when the backend is created, as bare-mux's
 * BareMuxConnection does.
 */
export function fakeUvWindow(worker: FakeBareMuxWorker, storage: FakeStorage | null = worker.storage): Window & typeof globalThis & { hide(): void } {
  const pagehide: Array<() => void> = [];
  const win = {
    localStorage: storage ?? undefined,
    crypto: globalThis.crypto,
    BareMux: {
      BareMuxConnection: class {
        readonly port: FakePort;
        constructor(readonly path: string) {
          this.port = worker.connect();
        }
        setManualTransport(code: string, args: unknown[]): Promise<void> {
          return worker.setVia(this.port, code, args);
        }
        async getTransport(): Promise<string> {
          return worker.name;
        }
      },
      BareClient: class {
        async fetch(): Promise<Response> {
          return new Response('[]', { status: 200 });
        }
      },
    },
    MessageChannel: FakeMessageChannel,
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'pagehide') pagehide.push(fn);
    },
    hide: () => {
      for (const fn of pagehide) fn();
    },
  };
  return win as unknown as Window & typeof globalThis & { hide(): void };
}
