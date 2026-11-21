/**
 * The shared Ultraviolet transport (ENGINE-PROTOCOL §6.6) with the real install code (uv-worker-code.ts) running in
 * a fake bare-mux SharedWorker, and the real bare-mux backend (window-backends.ts) of two engine hosts.
 */
import { describe, expect, it } from 'vitest';
import type { Ticket, WispRoute } from '../../shared/engine-protocol';
import { uvTransportAction, uvTransportKey, type UvInstallReason } from '../../shared/transport';
import { GnomeTransportManager } from './manager';
import { FakeBareMuxWorker, FakeClock, FakeMessageChannel, FakeProbe, FakeWorkerSocket, fakeDeps, fakeUvWindow, settle, type FakeStorage } from './testing';
import { parseUvTapMessage, parseUvTransportName, uvInstallCode, uvLockMarker } from './uv-worker-code';
import { UV_LOCK_STORAGE_KEY, bareMuxUvBackend, uvLockSecret } from './window-backends';

const ORIGIN = 'http://127.0.0.1:27511';
const WISP = 'ws://127.0.0.1:27511/wisp/';

function host(worker: FakeBareMuxWorker, clock: FakeClock, probe = new FakeProbe(), storage: FakeStorage | null = worker.storage) {
  const win = fakeUvWindow(worker, storage);
  const deps = fakeDeps(clock, { probe: probe.probe, uv: () => bareMuxUvBackend(win) });
  const m = new GnomeTransportManager(deps);
  const ticket = (v: string): Ticket => ({ value: v, expiresAt: clock.now + 3_600_000, wispUrl: WISP });
  const start = (route: WispRoute = { kind: 'default' }, transport: 'libcurl' | 'epoxy' = 'epoxy', t = 'T') =>
    m.start({ sides: { scramjet: false, ultraviolet: true }, route, transport, ticket: ticket(t), proxyOrigin: ORIGIN });
  return { win, deps, m, probe, start, ticket };
}

describe('install code', () => {
  it('decides exactly like uvTransportAction (inside the worker)', async () => {
    const reasons: UvInstallReason[] = ['start', 'configure', 'rebuild'];
    for (const reason of reasons) {
      for (const installed of [null, 'epoxy|default|', 'libcurl|default|']) {
        const w = new FakeBareMuxWorker();
        if (installed) await w.set(uvInstallCode({ mode: 'start', key: installed, module: '/m.mjs', expectedGen: null }), [{ wisp: WISP }, null]);
        const before = w.constructions;
        await w.set(uvInstallCode({ mode: reason, key: 'epoxy|default|', module: '/m.mjs', expectedGen: null }), [{ wisp: WISP }, null]);
        const action = w.constructions > before ? 'install' : 'keep';
        expect(action, `${reason} with ${installed}`).toBe(uvTransportAction(reason, installed, 'epoxy|default|'));
        expect(parseUvTransportName(w.name)?.key).toBe(action === 'install' ? 'epoxy|default|' : installed);
      }
    }
  });

  it('a rebuild installs only if nobody rebuilt since the caller looked (compare-and-swap on the generation)', async () => {
    const w = new FakeBareMuxWorker();
    const key = 'libcurl|default|';
    await w.set(uvInstallCode({ mode: 'start', key, module: '/m.mjs', expectedGen: null }), [{ wisp: WISP }, null]);
    expect(parseUvTransportName(w.name)).toEqual({ gen: 1, key });
    await w.set(uvInstallCode({ mode: 'rebuild', key, module: '/m.mjs', expectedGen: 1 }), [{ wisp: WISP }, null]);
    expect(w.constructions).toBe(2);
    await w.set(uvInstallCode({ mode: 'rebuild', key, module: '/m.mjs', expectedGen: 1 }), [{ wisp: WISP }, null]);
    expect(w.constructions).toBe(2);
    expect(parseUvTransportName(w.name)?.gen).toBe(2);
  });

  it('a transport whose init failed counts as not installed; init is memoized', async () => {
    const w = new FakeBareMuxWorker();
    w.initFails = 1;
    const key = 'epoxy|default|';
    await w.set(uvInstallCode({ mode: 'start', key, module: '/m.mjs', expectedGen: null }), [{ wisp: WISP }, null]);
    await settle();
    const t = w.transport as { init(): Promise<void> };
    expect(t.init()).toBe(t.init());
    await w.set(uvInstallCode({ mode: 'start', key, module: '/m.mjs', expectedGen: null }), [{ wisp: WISP }, null]);
    expect(w.constructions).toBe(2);
  });

  it('tap messages are validated', () => {
    expect(parseUvTapMessage({ t: 'wisp', ev: 'close', gen: 3, key: 'k', wasOpen: true, code: 1006 })).toEqual({
      t: 'wisp',
      ev: 'close',
      gen: 3,
      key: 'k',
      wasOpen: true,
      code: 1006,
    });
    expect(parseUvTapMessage({ t: 'wisp', ev: 'boom', gen: 3, key: 'k', wasOpen: true })).toBeNull();
    expect(parseUvTapMessage({ t: 'uv-init', gen: -1, ok: true, message: null })).toBeNull();
    expect(parseUvTapMessage('x')).toBeNull();
    expect(parseUvTransportName('bare-mux-remote (x)')).toBeNull();
  });
});

describe('two engine hosts sharing one bare-mux worker', () => {
  it('the second host keeps an equal transport (no second Wisp connection) and both get the socket events', async () => {
    const clock = new FakeClock();
    const worker = new FakeBareMuxWorker();
    const a = host(worker, clock);
    const b = host(worker, clock);
    await a.start();
    await a.m.ultravioletReady();
    expect(worker.constructions).toBe(1);
    expect((worker.transport as { opts: { wisp: string } }).opts.wisp).toBe(`${WISP}?t=T&/`);
    await b.start();
    await b.m.ultravioletReady();
    expect(worker.constructions).toBe(1);
    expect(worker.self.__gnomeUv?.taps).toHaveLength(2);
    const sock = worker.openSocket();
    sock.fire('open');
    await settle();
    expect(a.m.status().ultraviolet.state).toBe('ready');
    expect(b.m.status().ultraviolet.state).toBe('ready');
  });

  it('a settings change in one host installs its route; the other, with older settings, never undoes it', async () => {
    const clock = new FakeClock();
    const worker = new FakeBareMuxWorker();
    const a = host(worker, clock);
    const b = host(worker, clock);
    await a.start();
    await b.start();
    await b.m.configure({ route: { kind: 'profile', id: 'se-1' }, transport: 'epoxy' });
    const vpnKey = uvTransportKey({ kind: 'profile', id: 'se-1' }, 'epoxy');
    expect(parseUvTransportName(worker.name)?.key).toBe(vpnKey);
    expect(worker.constructions).toBe(2);
    // A still runs the default route: a failure report makes it probe and "rebuild", which keeps the VPN transport.
    clock.now += 5000;
    a.m.reportFailure('ultraviolet', 'uv transport error');
    await clock.advance(10);
    await settle();
    expect(a.probe.calls.length).toBeGreaterThan(0);
    expect(parseUvTransportName(worker.name)?.key).toBe(vpnKey);
    expect((worker.transport as { opts: { wisp: string } }).opts.wisp).toBe('ws://127.0.0.1:27511/wisp/p/se-1/?t=T&/');
    // A's app sends the new settings: equal key → keep (no reinstall)
    await a.m.configure({ route: { kind: 'profile', id: 'se-1' }, transport: 'epoxy' });
    expect(worker.constructions).toBe(2);
  });

  it('after the installing host closes, a drop is still seen and the other host rebuilds once with its ticket', async () => {
    const clock = new FakeClock();
    const worker = new FakeBareMuxWorker();
    const a = host(worker, clock);
    const b = host(worker, clock);
    await a.start(undefined, 'epoxy', 'TA');
    await b.start(undefined, 'epoxy', 'TB');
    const sock = worker.openSocket();
    sock.fire('open');
    await settle();
    a.win.hide(); // pagehide: A's tap says bye
    await settle();
    expect(worker.self.__gnomeUv?.taps).toHaveLength(1);
    sock.fire('close');
    await clock.advance(10);
    await settle();
    expect(b.probe.calls).toEqual(['http://127.0.0.1:27511/wisp/?t=TB&/']);
    expect(worker.constructions).toBe(2);
    expect((worker.transport as { opts: { wisp: string } }).opts.wisp).toBe(`${WISP}?t=TB&/`);
    expect(b.m.diagnostics().drops.ultraviolet).toBe(1);
  });

  it('a drop seen by both hosts rebuilds the shared transport once', async () => {
    const clock = new FakeClock();
    const worker = new FakeBareMuxWorker();
    const a = host(worker, clock);
    const b = host(worker, clock);
    await a.start();
    await b.start();
    const sock = worker.openSocket();
    sock.fire('open');
    await settle();
    sock.fire('close');
    await clock.advance(10);
    await settle();
    expect(a.probe.calls).toHaveLength(1);
    expect(b.probe.calls).toHaveLength(1);
    expect(worker.constructions).toBe(2);
    // an event of the old generation's socket is ignored
    sock.fire('close');
    await clock.advance(10);
    await settle();
    expect(worker.constructions).toBe(2);
    expect(FakeWorkerSocket.all.length).toBeGreaterThan(0);
  });
});

describe('a Wisp socket the bare-mux worker cannot open is a failed open (worklist A2)', () => {
  const S1 = 'ws://127.0.0.1:27510/';
  const S2 = 'ws://127.0.0.1:27512/';
  const route: WispRoute = { kind: 'custom', servers: [S1, S2] };

  for (const [label, refuse, open] of [
    ['the constructor throws (Firefox: NS_ERROR_CONTENT_BLOCKED)', true, (w: FakeBareMuxWorker) => expect(() => w.openSocket()).toThrow(/CONTENT_BLOCKED/)],
    ['an error without a close (Chromium)', false, (w: FakeBareMuxWorker) => w.openSocket().fire('error')],
  ] as const) {
    it(`${label}: the side goes offline and fails over to the next custom server`, async () => {
      const clock = new FakeClock();
      const worker = new FakeBareMuxWorker();
      const a = host(worker, clock);
      if (refuse) FakeWorkerSocket.refused.add(S1);
      try {
        await a.start(route, 'epoxy');
        expect(a.m.status().ultraviolet).toMatchObject({ state: 'ready', endpoint: 'custom' });
        expect((worker.transport as { opts: { wisp: string } }).opts.wisp).toBe(S1);
        open(worker);
        await settle();
        expect(a.m.status().ultraviolet).toMatchObject({ state: 'offline', detail: 'gateway-unreachable', endpoint: 'custom' });
        await clock.advance(a.m.status().ultraviolet.retryInMs ?? 0);
        await settle();
        expect((worker.transport as { opts: { wisp: string } }).opts.wisp).toBe(S2);
        expect(a.m.status().ultraviolet).toMatchObject({ state: 'ready', endpoint: 'custom' });
        expect(a.probe.calls).toHaveLength(0); // custom servers are never probed
      } finally {
        FakeWorkerSocket.refused.delete(S1);
      }
    });
  }

  it('an error after the socket opened is a drop, reported once with its close', async () => {
    const clock = new FakeClock();
    const worker = new FakeBareMuxWorker();
    const a = host(worker, clock);
    await a.start({ kind: 'default' }, 'epoxy');
    const sock = worker.openSocket();
    sock.fire('open');
    await settle();
    sock.fire('error');
    await settle();
    expect(a.m.status().ultraviolet.state).toBe('ready'); // an error alone after open: the close decides
    sock.fire('close');
    await clock.advance(10);
    await settle();
    expect(a.probe.calls).toHaveLength(1); // the drop's probe, once
  });
});

describe('the lock: only GNOME engine hosts can set the shared transport', () => {
  /** What an ordinary proxied page can send: bare-mux's own message format on a port it connected itself. */
  const attacks = (worker: FakeBareMuxWorker) => {
    const page = worker.connect();
    const spy = new FakeMessageChannel();
    return {
      remote: () => worker.setVia(page, 'bare-mux-remote', [spy.port2, 'page']),
      code: () => worker.setVia(page, 'return [class Evil { constructor() {} }, "evil"]', []),
      forgedMarker: () => worker.setVia(page, `${uvLockMarker('0'.repeat(32))}return [class Evil {}, "evil"]`, []),
    };
  };

  it('after GNOME installed, a page’s `set` (remote port, own code, a wrong secret) is refused; engine hosts still set', async () => {
    const worker = new FakeBareMuxWorker();
    const clock = new FakeClock();
    const a = host(worker, clock);
    await a.start({ kind: 'default' }, 'epoxy', 'TA');
    const secret = worker.storage.getItem(UV_LOCK_STORAGE_KEY);
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    const installed = { name: worker.name, transport: worker.transport, constructions: worker.constructions };
    const page = attacks(worker);
    await expect(page.remote()).rejects.toThrow(/only GNOME engine hosts/);
    await expect(page.code()).rejects.toThrow(/only GNOME engine hosts/);
    await expect(page.forgedMarker()).rejects.toThrow(/only GNOME engine hosts/);
    expect({ name: worker.name, transport: worker.transport, constructions: worker.constructions }).toEqual(installed);
    // Another GNOME tab's engine host (same origin storage) connects after the lock and still installs its route.
    const b = host(worker, clock);
    await b.start({ kind: 'profile', id: 'se-1' }, 'epoxy', 'TB');
    expect(parseUvTransportName(worker.name)?.key).toBe(uvTransportKey({ kind: 'profile', id: 'se-1' }, 'epoxy'));
    expect(worker.constructions).toBe(installed.constructions + 1);
    expect(b.m.status().ultraviolet.state).toBe('ready');
  });

  it('control: without a usable localStorage there is no secret and nothing is locked', async () => {
    const worker = new FakeBareMuxWorker();
    const a = host(worker, new FakeClock(), new FakeProbe(), null);
    await a.start({ kind: 'default' }, 'epoxy', 'TA');
    expect(uvLockSecret({ localStorage: undefined as unknown as Storage, crypto: globalThis.crypto })).toBeNull();
    await attacks(worker).remote();
    expect(worker.name).toBe('bare-mux-remote (page)');
  });

  it('the secret is created once per origin and reused; a malformed stored value is replaced', () => {
    const worker = new FakeBareMuxWorker();
    const win = { localStorage: worker.storage as unknown as Storage, crypto: globalThis.crypto };
    const first = uvLockSecret(win);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(uvLockSecret(win)).toBe(first);
    worker.storage.setItem(UV_LOCK_STORAGE_KEY, 'not-a-secret');
    const second = uvLockSecret(win);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    expect(uvInstallCode({ mode: 'start', key: 'k', module: '/m.mjs', expectedGen: null, secret: second }).startsWith(uvLockMarker(second ?? ''))).toBe(true);
    expect(uvInstallCode({ mode: 'start', key: 'k', module: '/m.mjs', expectedGen: null, secret: 'x' }).startsWith('/*gnome-uv')).toBe(false);
  });
});
