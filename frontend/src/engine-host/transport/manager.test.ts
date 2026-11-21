import { describe, expect, it } from 'vitest';
import { TICKET, type EngineId, type NeedTicketReason, type Ticket, type TransportStatus, type WispRoute } from '../../shared/engine-protocol';
import { RECOVERY, backoffDelayMs, uvTransportKey } from '../../shared/transport';
import { GnomeTransportManager } from './manager';
import { FakeClock, FakeProbe, FakeScramjet, fakeDeps, settle } from './testing';

const ORIGIN = 'http://127.0.0.1:27511';
const WISP = 'ws://127.0.0.1:27511/wisp/';

function setup(opts: { route?: WispRoute; transport?: 'libcurl' | 'epoxy'; ticket?: Ticket | null; random?: number } = {}) {
  const clock = new FakeClock();
  const sj = new FakeScramjet(clock);
  const probe = new FakeProbe();
  const deps = fakeDeps(clock, { scramjet: sj, probe: probe.probe, random: () => opts.random ?? 0.5 });
  const m = new GnomeTransportManager(deps);
  const reasons: NeedTicketReason[] = [];
  m.onNeedTicket((r) => reasons.push(r));
  const statuses: Array<Record<EngineId, TransportStatus>> = [];
  m.onStatus((s) => statuses.push(s));
  const sinkGot: unknown[] = [];
  m.bindScramjet({ setTransport: (t) => sinkGot.push(t) });
  const ticket = opts.ticket === undefined ? { value: 'T1', expiresAt: clock.now + 3_600_000, wispUrl: WISP } : opts.ticket;
  const start = () =>
    m.start({
      sides: { scramjet: true, ultraviolet: false },
      route: opts.route ?? { kind: 'default' },
      transport: opts.transport ?? 'libcurl',
      ticket,
      proxyOrigin: ORIGIN,
    });
  return { clock, sj, probe, deps, m, reasons, statuses, sinkGot, start };
}

describe('start and the first transport', () => {
  it('builds with the canonical ticket URL and resolves scramjetTransport()', async () => {
    const t = setup();
    await t.start();
    expect(t.sj.builds).toHaveLength(1);
    expect(t.sj.builds[0]?.url).toBe(`${WISP}?t=T1&/`);
    expect(await t.m.scramjetTransport()).toBe(t.sj.builds[0]);
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', transport: 'libcurl', endpoint: 'default', detail: null });
    expect(t.m.status().ultraviolet.state).toBe('offline');
    await expect(t.m.ultravioletReady()).rejects.toThrow(/not enabled/);
    expect(t.sj.wrapped).toBe(1);
  });

  it('without a ticket: ticket-missing, needTicket{missing}, and the ticket rebuilds', async () => {
    const t = setup({ ticket: null });
    await t.start();
    expect(t.sj.builds[0]?.url).toBe(WISP);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'ticket-missing' });
    await t.clock.advance(1);
    expect(t.reasons).toEqual(['missing']);
    await t.m.setTicket({ value: 'T2', expiresAt: t.clock.now + 60_000, wispUrl: WISP });
    expect(t.sj.builds.at(-1)?.url).toBe(`${WISP}?t=T2&/`);
    expect(t.m.status().scramjet.state).toBe('ready');
    expect(t.sinkGot).toEqual([t.sj.builds[1]]);
  });

  it('a failed first build rejects scramjetTransport() and the side is offline', async () => {
    const t = setup();
    t.sj.failNext = 1;
    await t.start();
    await expect(t.m.scramjetTransport()).rejects.toThrow('init failed');
    expect(t.m.status().scramjet.state).toBe('offline');
  });

  it('start() twice throws; status events are emitted', async () => {
    const t = setup();
    await t.start();
    await expect(t.start()).rejects.toThrow(/already/);
    await settle();
    expect(t.statuses.at(-1)?.scramjet.state).toBe('ready');
  });
});

describe('watchdog and probe outcomes', () => {
  it('epoxy drop → probe 426 → rebuild (same ticket), handed to the sink', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.sj.socket('open', `${WISP}?t=T1&/`);
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(10);
    expect(t.probe.calls).toEqual(['http://127.0.0.1:27511/wisp/?t=T1&/']);
    expect(t.sj.builds).toHaveLength(2);
    expect(t.sinkGot).toEqual([t.sj.builds[1]]);
    expect(t.m.diagnostics()).toMatchObject({ rebuilds: { scramjet: 1 }, drops: { scramjet: 1 }, probes: { valid: 1 } });
  });

  it('libcurl drop → one probe, no rebuild (libcurl reconnects by itself)', async () => {
    const t = setup();
    await t.start();
    t.sj.socket('open', `${WISP}?t=T1&/`);
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(10);
    expect(t.probe.calls).toHaveLength(1);
    expect(t.sj.builds).toHaveLength(1);
    expect(t.m.status().scramjet.state).toBe('degraded');
    t.sj.socket('open', `${WISP}?t=T1&/`);
    expect(t.m.status().scramjet.state).toBe('ready');
  });

  it('ignores sockets of other URLs (not this endpoint)', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.sj.socket('close', 'wss://echo.example/', true);
    t.sj.socket('close', 'ws://127.0.0.1:27511/wisp/p/x/?t=T1&/', true);
    await t.clock.advance(10);
    expect(t.probe.calls).toHaveLength(0);
  });

  it('401 → ticket-rejected + needTicket{rejected}; the ticket rebuilds even a healthy-kind epoxy side', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.probe.answers = [FakeProbe.rejected];
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(10);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'ticket-rejected' });
    expect(t.reasons).toEqual(['rejected']);
    expect(t.sj.builds).toHaveLength(1);
    await t.m.setTicket({ value: 'T9', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    expect(t.sj.builds.at(-1)?.url).toBe(`${WISP}?t=T9&/`);
    expect(t.m.status().scramjet.state).toBe('ready');
  });

  it('429 → rate-limited for Retry-After, never ticket or gateway trouble; then probes again', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.probe.answers = [FakeProbe.rateLimited('7'), FakeProbe.valid];
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(10);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'rate-limited', retryInMs: 7000 });
    expect(t.reasons).toEqual([]);
    // reportFailure does not cut a 429 wait short.
    t.clock.now += 3000;
    t.m.reportFailure('scramjet', 'navigation failed');
    await t.clock.advance(10);
    expect(t.probe.calls).toHaveLength(1);
    await t.clock.advance(7000);
    expect(t.probe.calls).toHaveLength(2);
    expect(t.sj.builds).toHaveLength(2);
    expect(t.m.diagnostics().probes).toMatchObject({ rateLimited: 1, valid: 1 });
  });

  it('503 wisp_upstream_unavailable → upstream-unreachable, next probe after Retry-After', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.probe.answers = [FakeProbe.upstreamDown('20'), FakeProbe.upstreamDown(null), FakeProbe.valid];
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(10);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'upstream-unreachable', retryInMs: 20_000 });
    await t.clock.advance(19_000);
    expect(t.probe.calls).toHaveLength(1);
    await t.clock.advance(1_000);
    expect(t.probe.calls).toHaveLength(2);
    // without Retry-After: the backoff (random 0.5 → the base value of the second failure)
    expect(t.m.status().scramjet.retryInMs).toBe(backoffDelayMs(1, 0.5));
    await t.clock.advance(backoffDelayMs(1, 0.5));
    expect(t.probe.calls).toHaveLength(3);
    expect(t.sj.builds).toHaveLength(2);
    expect(t.m.diagnostics().probes.upstreamDown).toBe(2);
  });

  it('a navigation failure never cuts the 503’s Retry-After short (the next probe comes after it)', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start();
    t.probe.answers = [FakeProbe.upstreamDown('20'), FakeProbe.valid];
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(5_000);
    expect(t.probe.calls).toHaveLength(1);
    t.m.reportFailure('scramjet', 'navigation failed');
    await t.clock.advance(1);
    t.m.reportFailure('scramjet', 'navigation failed again');
    await t.clock.advance(10_000);
    expect(t.probe.calls).toHaveLength(1); // still waiting for Retry-After (20 s)
    await t.clock.advance(5_000);
    expect(t.probe.calls).toHaveLength(2);
    expect(t.sj.builds).toHaveLength(2); // the 426 then rebuilt epoxy
  });

  it('404 on a VPN profile route → unknown-profile, no retry until the app picks a route', async () => {
    const t = setup({ transport: 'epoxy', route: { kind: 'profile', id: 'se-1' } });
    await t.start();
    const url = 'ws://127.0.0.1:27511/wisp/p/se-1/?t=T1&/';
    expect(t.sj.builds[0]?.url).toBe(url);
    t.probe.answers = [FakeProbe.unknownProfile];
    t.sj.socket('close', url, true);
    await t.clock.advance(60_000);
    expect(t.probe.calls).toHaveLength(1);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'unknown-profile', endpoint: 'profile' });
    await t.m.configure({ route: { kind: 'default' }, transport: 'epoxy' });
    expect(t.sj.builds.at(-1)?.url).toBe(`${WISP}?t=T1&/`);
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', endpoint: 'default' });
  });

  it('network errors back off with injected randomness, 12 attempts, then the idle retry', async () => {
    const t = setup({ transport: 'epoxy', random: 0 });
    await t.start();
    t.probe.answers = [null];
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(1);
    const waits: Array<number | null> = [];
    for (let i = 0; i < RECOVERY.probeAttempts + 1; i++) {
      const s = t.m.status().scramjet;
      expect(s).toMatchObject({ state: 'offline', detail: 'gateway-unreachable' });
      waits.push(s.retryInMs);
      await t.clock.advance(s.retryInMs ?? 0);
    }
    expect(waits.slice(0, 4)).toEqual([125, 250, 500, 1000]);
    expect(waits[RECOVERY.probeAttempts - 1]).toBe(backoffDelayMs(RECOVERY.probeAttempts - 1, 0));
    expect(waits[RECOVERY.probeAttempts]).toBe(RECOVERY.idleRetryMs);
    // a reported navigation failure probes now during the idle wait (at most every 2 s)
    const before = t.probe.calls.length;
    t.clock.now += RECOVERY.failureProbeMinIntervalMs;
    t.m.reportFailure('scramjet', 'x');
    await t.clock.advance(1);
    expect(t.probe.calls.length).toBe(before + 1);
  });

  it('a socket that fails to open after a 426 → upstream-unreachable and backoff, not a rebuild per 426', async () => {
    const t = setup({ transport: 'epoxy', random: 0.5 });
    await t.start();
    t.sj.socket('connecting', `${WISP}?t=T1&/`);
    t.sj.socket('close', `${WISP}?t=T1&/`, false);
    await t.clock.advance(1);
    expect(t.probe.calls).toHaveLength(1);
    expect(t.sj.builds).toHaveLength(1);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'upstream-unreachable', retryInMs: backoffDelayMs(0, 0.5) });
    // more failing sockets during the backoff change nothing
    t.sj.socket('close', `${WISP}?t=T1&/`, false);
    await t.clock.advance(1);
    expect(t.probe.calls).toHaveLength(1);
    await t.clock.advance(backoffDelayMs(0, 0.5));
    // after the wait: 426 again → one rebuild; its socket fails again → longer backoff
    expect(t.sj.builds).toHaveLength(2);
    t.sj.socket('close', `${WISP}?t=T1&/`, false);
    await t.clock.advance(1);
    expect(t.m.status().scramjet).toMatchObject({ detail: 'upstream-unreachable', retryInMs: backoffDelayMs(1, 0.5) });
    // the upstream comes back: the rebuilt transport's socket opens → ready, backoff reset
    await t.clock.advance(backoffDelayMs(1, 0.5));
    expect(t.sj.builds).toHaveLength(3);
    t.sj.socket('open', `${WISP}?t=T1&/`);
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', detail: null });
  });

  it('caps rebuilds per side: beyond the limit the side is offline with rebuild-limit', async () => {
    const t = setup({ transport: 'epoxy' });
    await t.start(); // 1 build
    for (let i = 0; i < RECOVERY.rebuildLimit + 1; i++) {
      t.sj.socket('close', `${WISP}?t=T1&/`, true);
      await t.clock.advance(RECOVERY.failureProbeMinIntervalMs);
    }
    expect(t.sj.builds).toHaveLength(RECOVERY.rebuildLimit);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'rebuild-limit' });
    const wait = t.m.status().scramjet.retryInMs ?? 0;
    expect(wait).toBeGreaterThan(0);
    await t.clock.advance(wait + 10);
    expect(t.sj.builds.length).toBeGreaterThan(RECOVERY.rebuildLimit);
  });

  it('a failed rebuild backs off and tries again', async () => {
    const t = setup({ transport: 'epoxy', random: 0.5 });
    await t.start();
    t.sj.failNext = 1;
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(1);
    expect(t.sj.builds).toHaveLength(1);
    expect(t.m.status().scramjet.state).toBe('offline');
    await t.clock.advance(backoffDelayMs(0, 0.5));
    expect(t.sj.builds).toHaveLength(2);
    expect(t.m.status().scramjet.state).toBe('ready');
  });
});

describe('tickets', () => {
  it('lazy renewal: libcurl is rebuilt, a healthy epoxy keeps its socket, a degraded epoxy is rebuilt', async () => {
    const lc = setup({ transport: 'libcurl' });
    await lc.start();
    await lc.m.setTicket({ value: 'T2', expiresAt: lc.clock.now + 3_600_000, wispUrl: WISP });
    expect(lc.sj.builds.map((b) => b.url)).toEqual([`${WISP}?t=T1&/`, `${WISP}?t=T2&/`]);

    const ep = setup({ transport: 'epoxy' });
    await ep.start();
    await ep.m.setTicket({ value: 'T2', expiresAt: ep.clock.now + 3_600_000, wispUrl: WISP });
    expect(ep.sj.builds).toHaveLength(1);
    ep.probe.answers = [null];
    ep.sj.socket('close', `${WISP}?t=T1&/`, true);
    await ep.clock.advance(1);
    expect(ep.m.status().scramjet.state).toBe('offline');
    await ep.m.setTicket({ value: 'T3', expiresAt: ep.clock.now + 3_600_000, wispUrl: WISP });
    expect(ep.sj.builds.at(-1)?.url).toBe(`${WISP}?t=T3&/`);
  });

  it('proactive renewal at ticketRenewDelayMs after every ticket (80 %, never sooner than 10 s)', async () => {
    const t = setup({ ticket: null });
    await t.start();
    await t.clock.advance(1);
    t.reasons.length = 0;
    await t.m.setTicket({ value: 'A', expiresAt: t.clock.now + 60_000, wispUrl: WISP });
    await t.clock.advance(47_999);
    expect(t.reasons).toEqual([]);
    await t.clock.advance(1);
    expect(t.reasons).toEqual(['expiring']);
    // an already-expired ticket renews after the floor, not at once (no loop)
    await t.m.setTicket({ value: 'B', expiresAt: t.clock.now - 5_000, wispUrl: WISP });
    await t.clock.advance(TICKET.minRenewDelayMs - 1);
    expect(t.reasons).toEqual(['expiring']);
    await t.clock.advance(1);
    expect(t.reasons).toEqual(['expiring', 'expiring']);
    // a newer ticket replaces the timer of the older one
    await t.m.setTicket({ value: 'C', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    await t.m.setTicket({ value: 'D', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    await t.clock.advance(2_880_000);
    expect(t.reasons).toEqual(['expiring', 'expiring', 'expiring']);
  });
});

describe('one queue, routes and custom endpoints', () => {
  it('serializes concurrent rebuild requests (never two inits at once)', async () => {
    const t = setup({ transport: 'libcurl' });
    t.sj.buildDelayMs = 50;
    const started = t.start();
    await t.clock.advance(50);
    await started;
    const a = t.m.setTicket({ value: 'T2', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    const b = t.m.configure({ route: { kind: 'profile', id: 'de-1' }, transport: 'libcurl' });
    const c = t.m.setTicket({ value: 'T3', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    await t.clock.advance(500);
    await Promise.all([a, b, c]);
    expect(t.sj.maxActive).toBe(1);
    expect(t.sj.builds.at(-1)?.url).toBe('ws://127.0.0.1:27511/wisp/p/de-1/?t=T3&/');
  });

  it('configure() with the same route and kind rebuilds nothing', async () => {
    const t = setup();
    await t.start();
    await t.m.configure({ route: { kind: 'default' }, transport: 'libcurl' });
    expect(t.sj.builds).toHaveLength(1);
    await t.m.configure({ route: { kind: 'default' }, transport: 'epoxy' });
    expect(t.sj.builds.map((b) => b.kind)).toEqual(['libcurl', 'epoxy']);
    expect(t.m.status().scramjet.transport).toBe('epoxy');
  });

  it('custom endpoints never get the ticket, are never probed, and fail over in order', async () => {
    const t = setup({
      transport: 'epoxy',
      route: { kind: 'custom', servers: ['wss://a.example/wisp/', 'ws://b.example/', 'wss://c.example/x', 'wss://d.example/w/?k=1'] },
    });
    await t.start();
    expect(t.sj.builds[0]?.url).toBe('wss://a.example/wisp/');
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', endpoint: 'custom' });
    expect(t.reasons).toEqual([]);
    expect(t.deps.logs.some((l) => l.includes('not-wisp-path'))).toBe(true);
    // a failed connect → backoff → the next server
    t.sj.socket('close', 'wss://a.example/wisp/', false);
    await t.clock.advance(backoffDelayMs(0, 0.5));
    expect(t.sj.builds.at(-1)?.url).toBe('ws://b.example/');
    t.sj.socket('close', 'ws://b.example/', false);
    await t.clock.advance(backoffDelayMs(1, 0.5));
    expect(t.sj.builds.at(-1)?.url).toBe('wss://d.example/w/?k=1&/');
    await t.m.setTicket({ value: 'T5', expiresAt: t.clock.now + 3_600_000, wispUrl: WISP });
    expect(t.sj.builds.every((b) => !b.url.includes('T5') && !b.url.includes('T1'))).toBe(true);
    expect(t.probe.calls).toEqual([]);
  });

  it('a custom server gets a test socket before `ready`: a dead first server fails over before any page asks (A3)', async () => {
    const t = setup({ transport: 'epoxy', route: { kind: 'custom', servers: ['ws://dead.example/', 'ws://live.example/'] } });
    const tested: string[] = [];
    const timeouts: number[] = [];
    t.deps.testSocket = async (url, timeoutMs) => {
      tested.push(url);
      timeouts.push(timeoutMs);
      return url.startsWith('ws://live.example/');
    };
    await t.start();
    // every test socket gets the deadline after which it closes itself (no socket left connecting to a blackhole)
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((ms) => ms === 4_000)).toBe(true);
    // the dead one was tested and skipped: the only transport built is the live server's
    expect(t.sj.builds.map((b) => b.url)).toEqual(['ws://live.example/']);
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', endpoint: 'custom' });
    expect(tested).toEqual(['ws://dead.example/', 'ws://live.example/']);
    // the live one fails later: the next round starts after it (dead, then live again)
    t.sj.socket('close', 'ws://live.example/', false);
    await t.clock.advance(backoffDelayMs(0, 0.5) + 3_001);
    expect(t.sj.builds.map((b) => b.url)).toEqual(['ws://live.example/', 'ws://live.example/']);
    expect(t.m.status().scramjet).toMatchObject({ state: 'ready', endpoint: 'custom' });
    expect(t.probe.calls).toEqual([]);
  });

  it('custom servers that all refuse the test socket never report `ready` (A2: e.g. blocked by the policies)', async () => {
    const t = setup({ transport: 'epoxy', route: { kind: 'custom', servers: ['ws://a.example/', 'ws://b.example/'] } });
    t.deps.testSocket = async () => false;
    const seen = new Set<string>();
    t.m.onStatus((s) => seen.add(s.scramjet.state));
    await t.start();
    for (let i = 0; i < 4; i++) await t.clock.advance(backoffDelayMs(i, 0.5));
    expect(seen.has('ready')).toBe(false);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'gateway-unreachable' });
    expect(new Set(t.sj.builds.map((b) => b.url))).toEqual(new Set(['ws://a.example/', 'ws://b.example/']));
  });

  it('after a socket failure no earlier test result vouches for a server (it is tested again)', async () => {
    const t = setup({ transport: 'epoxy', route: { kind: 'custom', servers: ['ws://only.example/'] } });
    let up = true;
    const tested: boolean[] = [];
    t.deps.testSocket = async () => {
      tested.push(up);
      return up;
    };
    await t.start();
    expect(t.m.status().scramjet.state).toBe('ready');
    up = false; // the server dies right after its test
    t.sj.socket('close', 'ws://only.example/', true); // a drop within the reuse window
    await t.clock.advance(backoffDelayMs(0, 0.5));
    expect(tested).toEqual([true, false]);
    expect(t.m.status().scramjet).toMatchObject({ state: 'offline', detail: 'gateway-unreachable' });
  });

  it('a test result serves both sides for a moment; the gateway is never tested', async () => {
    const tested: string[] = [];
    const t = setup({ transport: 'epoxy' });
    t.deps.testSocket = async (url) => {
      tested.push(url);
      return true;
    };
    await t.start();
    expect(tested).toEqual([]); // the gateway has its probe
    await t.m.configure({ route: { kind: 'custom', servers: ['ws://x.example/'] }, transport: 'epoxy' });
    await t.m.configure({ route: { kind: 'custom', servers: ['ws://x.example/'] }, transport: 'libcurl' });
    expect(tested).toEqual(['ws://x.example/']); // the second build within the reuse window used the first result
    await t.clock.advance(5_000);
    await t.m.configure({ route: { kind: 'custom', servers: ['ws://x.example/'] }, transport: 'epoxy' });
    expect(tested).toEqual(['ws://x.example/', 'ws://x.example/']);
  });

  it('every URL in the logs is redacted', async () => {
    const t = setup({ transport: 'epoxy' });
    t.deps.log = (level, message) => t.deps.logs.push(`${level}: ${message}`);
    await t.start();
    t.sj.socket('close', `${WISP}?t=T1&/`, true);
    await t.clock.advance(1);
    expect(t.deps.logs.some((l) => l.includes('?t=<ticket>'))).toBe(true);
    expect(t.deps.logs.some((l) => l.includes('T1'))).toBe(false);
  });
});

describe('proxyFetch and hooks', () => {
  it('GET through the Scramjet transport with a size cap and timeout', async () => {
    const t = setup();
    await t.start();
    const res = await t.m.proxyFetch('https://duckduckgo.com/ac/?q=a', { timeoutMs: 5000, maxBytes: 1024 });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('["a",["ab","ac"]]');
    await expect(t.m.proxyFetch('https://duckduckgo.com/', { timeoutMs: 5000, maxBytes: 4 })).rejects.toThrow(/too large/);
    await expect(t.m.proxyFetch('javascript:alert(1)', { timeoutMs: 5000, maxBytes: 4 })).rejects.toThrow(/http/);
  });

  it('uvTransportKey is the shared key of a route and kind', () => {
    expect(uvTransportKey({ kind: 'profile', id: 'se-1' }, 'epoxy')).toBe('epoxy|profile|se-1');
  });
});
