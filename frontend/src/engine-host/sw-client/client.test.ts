import { describe, expect, it } from 'vitest';
import { FakeClock, settle } from '../transport/testing';
import { GnomeSwClient, SW_TIMEOUTS, type SwContainerLike } from './client';

const ORIGIN = 'http://127.0.0.1:27511';

class FakeWorker {
  sent: unknown[] = [];
  listeners: Array<() => void> = [];
  state: ServiceWorkerState = 'activated';
  constructor(
    readonly name: string,
    readonly onPost: (msg: unknown, w: FakeWorker) => void = () => {},
  ) {}
  postMessage(msg: unknown): void {
    this.sent.push(msg);
    this.onPost(msg, this);
  }
  addEventListener(_t: string, fn: () => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  setState(state: ServiceWorkerState): void {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }
}

class FakeContainer implements SwContainerLike {
  controller: ServiceWorker | null = null;
  reg: { active: FakeWorker | null; waiting: FakeWorker | null; installing: FakeWorker | null; addEventListener(): void; update?: () => Promise<unknown> };
  readonly #listeners = new Map<string, Array<(e: MessageEvent | Event) => void>>();
  registered: Array<[string, RegistrationOptions]> = [];
  constructor() {
    this.reg = { active: null, waiting: null, installing: null, addEventListener() {} };
  }
  get ready(): Promise<ServiceWorkerRegistration> {
    return Promise.resolve(this.reg as unknown as ServiceWorkerRegistration);
  }
  register(url: string, opts: RegistrationOptions): Promise<ServiceWorkerRegistration> {
    this.registered.push([url, opts]);
    return Promise.resolve(this.reg as unknown as ServiceWorkerRegistration);
  }
  addEventListener(type: 'message' | 'controllerchange', fn: (e: MessageEvent | Event) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  setController(w: FakeWorker | null): void {
    this.controller = w as unknown as ServiceWorker;
    for (const fn of this.#listeners.get('controllerchange') ?? []) fn(new Event('controllerchange'));
  }
  message(data: unknown, source: unknown = this.controller, origin = ORIGIN): void {
    for (const fn of this.#listeners.get('message') ?? []) fn({ data, source, origin } as unknown as MessageEvent);
  }
}

/** A worker that answers gnome-hello with sw-hello. */
function helloWorker(c: FakeContainer, name: string, build: string, startedAt = 1): FakeWorker {
  return new FakeWorker(name, (msg, w) => {
    if ((msg as { type?: string }).type === 'gnome-hello') queueMicrotask(() => c.message({ type: 'sw-hello', build, startedAt }, w));
  });
}

function client(c: FakeContainer | null, clock: FakeClock, secure = true) {
  return new GnomeSwClient({ container: c, secureContext: secure, origin: ORIGIN, build: 'B1', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
}

describe('ensureControlled', () => {
  it('rejects with insecure_context without a secure context or service workers', async () => {
    const clock = new FakeClock();
    await expect(client(null, clock).ensureControlled()).rejects.toMatchObject({ code: 'insecure_context' });
    await expect(client(new FakeContainer(), clock, false).ensureControlled()).rejects.toMatchObject({ code: 'insecure_context' });
  });

  it('registers /sw.js at scope / with updateViaCache none and reads the build id', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const w = helloWorker(c, 'active', 'B1');
    c.reg.active = w;
    c.controller = w as unknown as ServiceWorker;
    const s = client(c, clock);
    const st = await s.ensureControlled();
    expect(c.registered).toEqual([['/sw.js', { scope: '/', updateViaCache: 'none' }]]);
    expect(st).toEqual({ controlled: true, build: 'B1', current: true, updateWaiting: false });
    expect(s.diagnostics().starts).toBe(1);
  });

  it('an older active worker is reported as not current', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const w = helloWorker(c, 'active', 'B0');
    c.reg.active = w;
    c.controller = w as unknown as ServiceWorker;
    expect(await client(c, clock).ensureControlled()).toMatchObject({ build: 'B0', current: false });
  });

  it('claims an uncontrolled load (forced reload) with gnome-claim', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const w = new FakeWorker('active', (msg, self) => {
      const type = (msg as { type?: string }).type;
      if (type === 'gnome-claim') queueMicrotask(() => c.setController(self));
      if (type === 'gnome-hello') queueMicrotask(() => c.message({ type: 'sw-hello', build: 'B1', startedAt: 5 }, self));
    });
    c.reg.active = w;
    const s = client(c, clock);
    const changes: unknown[] = [];
    s.onControllerChange((ctl) => changes.push(ctl));
    expect(await s.ensureControlled()).toMatchObject({ controlled: true, current: true });
    expect(w.sent[0]).toEqual({ type: 'gnome-claim' });
    expect(changes).toEqual([w]);
  });

  it('fails with sw_timeout when the claim never happens', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    c.reg.active = new FakeWorker('active');
    const rejected = expect(client(c, clock).ensureControlled()).rejects.toMatchObject({ code: 'sw_timeout' });
    await clock.advance(SW_TIMEOUTS.claimMs);
    await rejected;
  });

  it('the apply step: a waiting worker is asked to activate before the engines start', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const old = helloWorker(c, 'old', 'B0');
    const fresh = new FakeWorker('new', (msg, self) => {
      const type = (msg as { type?: string }).type;
      if (type === 'gnome-skip-waiting')
        queueMicrotask(() => {
          c.reg.waiting = null;
          c.reg.active = self;
          c.setController(self);
        });
      if (type === 'gnome-hello') queueMicrotask(() => c.message({ type: 'sw-hello', build: 'B1', startedAt: 9 }, self));
    });
    c.reg.active = old;
    c.reg.waiting = fresh;
    c.controller = old as unknown as ServiceWorker;
    const st = await client(c, clock).ensureControlled();
    expect(fresh.sent[0]).toEqual({ type: 'gnome-skip-waiting' });
    expect(st).toEqual({ controlled: true, build: 'B1', current: true, updateWaiting: false });
  });

  it('the apply step asks again while a just-closed engine host is still counted, and stops once it applied', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const old = helloWorker(c, 'old', 'B0');
    let hosts = 2; // the other GNOME tab closed a moment ago and is still listed
    const fresh = new FakeWorker('new', (msg, self) => {
      const type = (msg as { type?: string }).type;
      if (type === 'gnome-skip-waiting' && hosts <= 1)
        queueMicrotask(() => {
          c.reg.waiting = null;
          c.reg.active = self;
          c.setController(self);
        });
      if (type === 'gnome-hello') queueMicrotask(() => c.message({ type: 'sw-hello', build: 'B1', startedAt: 9 }, self));
    });
    c.reg.active = old;
    c.reg.waiting = fresh;
    c.controller = old as unknown as ServiceWorker;
    const p = client(c, clock).ensureControlled();
    await clock.advance(SW_TIMEOUTS.applyRetryMs);
    expect(fresh.sent.filter((m) => (m as { type?: string }).type === 'gnome-skip-waiting')).toHaveLength(2);
    hosts = 1; // the closed tab's client is gone now
    await clock.advance(SW_TIMEOUTS.applyRetryMs);
    expect(await p).toEqual({ controlled: true, build: 'B1', current: true, updateWaiting: false });
    const asks = fresh.sent.filter((m) => (m as { type?: string }).type === 'gnome-skip-waiting').length;
    await clock.advance(SW_TIMEOUTS.applyMs);
    expect(asks).toBe(3);
    expect(fresh.sent.filter((m) => (m as { type?: string }).type === 'gnome-skip-waiting')).toHaveLength(3); // no ask after it applied
  });

  it('a waiting worker that refuses (another engine host is open) leaves the update waiting', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const old = helloWorker(c, 'old', 'B0');
    c.reg.active = old;
    c.reg.waiting = new FakeWorker('new');
    c.controller = old as unknown as ServiceWorker;
    const p = client(c, clock).ensureControlled();
    await clock.advance(SW_TIMEOUTS.applyMs);
    expect(await p).toEqual({ controlled: true, build: 'B0', current: false, updateWaiting: true });
  });
});

describe('the background update check', () => {
  /** A registration whose update() finds `fresh` (a newer /sw.js), installs it (installing → installed) and parks it. */
  function withPendingUpdate(c: FakeContainer, fresh: FakeWorker): { checks: number } {
    const seen = { checks: 0 };
    c.reg.update = async () => {
      seen.checks += 1;
      if (c.reg.waiting === fresh) return c.reg;
      fresh.state = 'installing';
      c.reg.installing = fresh;
      queueMicrotask(() => {
        c.reg.installing = null;
        c.reg.waiting = fresh;
        fresh.setState('installed');
      });
      return c.reg;
    };
    return seen;
  }

  it('does not delay the start; a newer worker it finds waits, and the status says so (the next load applies it)', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const old = helloWorker(c, 'old', 'B1');
    c.reg.active = old;
    c.controller = old as unknown as ServiceWorker;
    const fresh = new FakeWorker('new');
    let installingListener: (() => void) | null = null;
    c.reg.addEventListener = ((_t: string, fn: () => void) => {
      installingListener = fn;
    }) as () => void;
    const seen = withPendingUpdate(c, fresh);
    const s = client(c, clock);
    const statuses: unknown[] = [];
    s.onStatus((x) => statuses.push(x));
    expect(await s.ensureControlled()).toEqual({ controlled: true, build: 'B1', current: true, updateWaiting: false });
    expect(seen.checks).toBe(0);
    await clock.advance(SW_TIMEOUTS.updateCheckAfterMs);
    expect(seen.checks).toBe(1);
    // the browser fires updatefound; the client follows the new worker's statechange
    (installingListener as (() => void) | null)?.();
    await clock.advance(600);
    expect(s.status().updateWaiting).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ updateWaiting: true });
    expect(fresh.sent).toEqual([]); // never applied while the engines run
    await clock.advance(SW_TIMEOUTS.updateCheckEveryMs);
    expect(seen.checks).toBe(2);
  });

  it('runs at once when the active worker is not this build’s (a newer /sw.js is known to exist)', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const old = helloWorker(c, 'old', 'B0'); // this bundle is B1
    c.reg.active = old;
    c.controller = old as unknown as ServiceWorker;
    const seen = withPendingUpdate(c, new FakeWorker('new'));
    expect(await client(c, clock).ensureControlled()).toMatchObject({ current: false });
    await clock.advance(1);
    expect(seen.checks).toBe(1);
  });

  it('a failing check (offline) is ignored and runs again later', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const w = helloWorker(c, 'old', 'B1');
    c.reg.active = w;
    c.controller = w as unknown as ServiceWorker;
    let calls = 0;
    c.reg.update = () => {
      calls += 1;
      return Promise.reject(new TypeError('Failed to update a ServiceWorker: network error'));
    };
    await client(c, clock).ensureControlled();
    await clock.advance(SW_TIMEOUTS.updateCheckAfterMs + SW_TIMEOUTS.updateCheckEveryMs);
    expect(calls).toBe(2);
  });
});

describe('signals', () => {
  it('validates, counts and forwards SW signals; a sw-hello from another worker is ignored', async () => {
    const clock = new FakeClock();
    const c = new FakeContainer();
    const w = helloWorker(c, 'active', 'B1');
    c.reg.active = w;
    c.controller = w as unknown as ServiceWorker;
    const s = client(c, clock);
    await s.ensureControlled();
    const got: unknown[] = [];
    s.onSignal((x) => got.push(x));
    c.message({ type: 'sw-held', ms: 120 });
    c.message({ type: 'sw-unavailable', reason: 'stale-prefix' });
    c.message({ type: 'sw-unavailable', reason: 'evil' });
    c.message({ type: 'uv-error', url: 'x', message: 'y', extra: 1 });
    c.message({ type: 'sw-held', ms: 1 }, w, 'https://evil.example');
    c.message({ type: 'sw-hello', build: 'B9', startedAt: 2 }, new FakeWorker('waiting'));
    await settle();
    expect(got).toEqual([
      { type: 'sw-held', ms: 120 },
      { type: 'sw-unavailable', reason: 'stale-prefix' },
      { type: 'uv-error', url: 'x', message: 'y' },
    ]);
    expect(s.status().build).toBe('B1');
    expect(s.diagnostics()).toEqual({ starts: 1, held: 1, unavailable: 1 });
  });
});
