import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_RATE_LIMITS, TIMEOUTS, type AnyEventMessage, type InitPayload } from '../../shared/engine-protocol';
import { FAKE_PROXY_ORIGIN, FakeEngineHost, HANG, ManualClock, flush } from '../testing/fake-engine-host';
import { EngineClient, EngineCommandError, compromiseSignals, type EngineClientDeps, type EngineClientState, type IdStatus } from './client';

const settings = {
  engines: { scramjet: true, ultraviolet: true },
  engine: 'auto',
  autoFallback: true,
  transport: 'libcurl',
  route: { kind: 'default' },
  privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'all' },
  extensions: { enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true }, lists: [], allowlist: [], perSite: {}, cosmeticAggressive: false, cookieRules: {} },
  keys: { combos: ['Alt+T'], apple: false },
} as const;

const initPayload = (): InitPayload => ({ settings: structuredClone(settings) as unknown as InitPayload['settings'], ticket: null, clearOnStart: { cookies: false, siteData: false } });

interface Harness {
  host: FakeEngineHost;
  clock: ManualClock;
  client: EngineClient;
  events: AnyEventMessage[];
  states: Array<[EngineClientState, string | null]>;
  resets: Array<[string, string | null]>;
  readies: Array<[string, boolean]>;
  rateLimited: number[];
  tabs: Map<number, IdStatus>;
}

let current: Harness | null = null;
afterEach(() => {
  current?.client.dispose();
  current = null;
});

function harness(over: Partial<EngineClientDeps> = {}, host = new FakeEngineHost()): Harness {
  const clock = new ManualClock();
  const h: Harness = { host, clock, client: null as unknown as EngineClient, events: [], states: [], resets: [], readies: [], rateLimited: [], tabs: new Map() };
  h.client = new EngineClient({
    embedder: host,
    proxyOrigin: FAKE_PROXY_ORIGIN,
    clock,
    buildInit: async () => initPayload(),
    tabStatus: (id) => h.tabs.get(id) ?? 'unknown',
    downloadStatus: (id) => (id === 'd1' ? 'known' : id === 'capped' ? 'closed' : 'unknown'),
    onEvent: (m) => h.events.push(m),
    onRateLimited: (id) => h.rateLimited.push(id),
    onReady: (r, first) => h.readies.push([r.instance, first]),
    onReset: (reason, inst) => h.resets.push([reason, inst]),
    onStateChange: (s, d) => h.states.push([s, d]),
    ...over,
  });
  current = h;
  return h;
}

async function started(over: Partial<EngineClientDeps> = {}, host?: FakeEngineHost): Promise<Harness> {
  const h = harness(over, host);
  h.client.start();
  await flush();
  expect(h.client.state).toBe('ready');
  return h;
}

describe('EngineClient handshake (ENGINE-PROTOCOL §2.2)', () => {
  it('embeds engineHostUrl(proxyOrigin) without parameters, connects once and sends init first', async () => {
    const h = await started();
    expect(h.host.frames).toHaveLength(1);
    expect(h.host.frames[0]!.src).toBe(`${FAKE_PROXY_ORIGIN}/engine/`);
    expect(h.host.commands[0]!.type).toBe('init');
    expect(h.host.violations).toEqual([]);
    expect(h.readies).toEqual([[h.host.instance, true]]);
    expect(h.states.map(([s]) => s)).toEqual(['starting', 'connecting', 'ready']);
  });

  it('ignores hellos from other sources, other origins, invalid ones and repeats of the connected instance', async () => {
    const h = await started();
    h.host.post({ gnome: 'hello', protocol: 1, build: 'x', instance: 'abcdefgh12' }, { source: { other: true } });
    h.host.post({ gnome: 'hello', protocol: 1, build: 'x', instance: 'abcdefgh12' }, { origin: 'http://127.0.0.1:9' });
    h.host.post({ gnome: 'hello', protocol: 1, build: 'x', instance: 'NOT VALID' });
    h.host.hello(); // duplicate of the connected instance
    await flush();
    expect(h.client.counters.unexpectedHellos).toBe(0);
    expect(h.host.commandsOf('init')).toHaveLength(1);
  });

  it('counts a valid hello it did not ask for as a compromise signal and does not re-handshake', async () => {
    const h = await started();
    h.host.hello('attacker0001');
    await flush();
    expect(h.client.counters.unexpectedHellos).toBe(1);
    expect(compromiseSignals(h.client.counters)).toBe(1);
    expect(h.client.state).toBe('ready');
    expect(h.host.frames).toHaveLength(1);
  });

  it('shows "GNOME was updated" on a protocol mismatch in either direction', async () => {
    const a = harness({}, new FakeEngineHost({ protocol: 2 }));
    a.client.start();
    await flush();
    expect(a.client.state).toBe('mismatch');
    a.client.dispose();
    // The engine host answers a connect with mismatch (it speaks another version than the one we connect with).
    const host = new FakeEngineHost({ autoHello: false });
    const b = harness({}, host);
    b.client.start();
    await flush();
    host.postConnect = (_frame, msg) => host.post({ gnome: 'mismatch', protocol: 9, instance: msg.instance });
    host.hello();
    await flush();
    expect(b.client.state).toBe('mismatch');
  });

  it('fails with "did not start" when no hello arrives in time, and Retry replaces the iframe', async () => {
    const host = new FakeEngineHost({ autoHello: false });
    const h = harness({}, host);
    h.client.start();
    await flush();
    h.clock.advance(TIMEOUTS.helloWaitMs);
    expect(h.client.state).toBe('failed');
    expect(h.client.detail).toMatch(/did not start/);
    h.client.restart('retry');
    await flush();
    expect(host.frames).toHaveLength(2);
    expect(host.frames[0]!.removed).toBe(true);
    host.hello();
    await flush();
    expect(h.client.state).toBe('ready');
  });
});

describe('EngineClient late first hello (§2.2 step 5, HelloContext.expecting)', () => {
  it('connects a late first hello from its own never-connected iframe after "did not start" (failed → connecting → ready)', async () => {
    const host = new FakeEngineHost({ autoHello: false });
    const h = harness({}, host);
    h.client.start();
    await flush();
    h.clock.advance(TIMEOUTS.helloWaitMs);
    expect(h.client.state).toBe('failed');
    host.hello();
    await flush();
    expect(h.client.state).toBe('ready');
    expect(h.client.counters.unexpectedHellos).toBe(0);
    expect(host.frames).toHaveLength(1);
    expect(host.commandsOf('init')).toHaveLength(1);
    expect(h.states.map(([s]) => s)).toEqual(['starting', 'failed', 'connecting', 'ready']);
    expect(h.readies).toEqual([[host.instance, true]]);
  });

  it('a second hello after the late connect is a compromise signal (the window ended with the accepted hello)', async () => {
    const host = new FakeEngineHost({ autoHello: false });
    const h = harness({}, host);
    h.client.start();
    await flush();
    h.clock.advance(TIMEOUTS.helloWaitMs);
    host.hello();
    await flush();
    host.hello('attacker0002');
    await flush();
    expect(h.client.counters.unexpectedHellos).toBe(1);
    expect(h.client.state).toBe('ready');
    expect(host.commandsOf('init')).toHaveLength(1);
  });

  it('Retry ends the window of the old iframe: its late hello is ignored and only the new iframe connects', async () => {
    const host = new FakeEngineHost({ autoHello: false });
    const h = harness({}, host);
    h.client.start();
    await flush();
    h.clock.advance(TIMEOUTS.helloWaitMs);
    const oldWindow = host.frames[0]!.window;
    h.client.restart('retry');
    await flush();
    host.post({ gnome: 'hello', protocol: 1, build: 'test', instance: 'oldframe0001' }, { source: oldWindow });
    await flush();
    expect(h.client.state).toBe('starting');
    expect(host.commandsOf('init')).toHaveLength(0);
    host.hello();
    await flush();
    expect(h.client.state).toBe('ready');
    expect(host.commandsOf('init')).toHaveLength(1);
  });
});

describe('EngineClient unexpected loads (§2.3)', () => {
  it('replaces the iframe after a load it did not cause, rejects pending commands and re-initializes', async () => {
    const h = await started();
    h.host.on('tab.find', () => HANG);
    h.tabs.set(1, 'known');
    const pending = h.client.send('tab.find', { tabId: 1, query: 'x', backwards: false, caseSensitive: false });
    await flush();
    const old = h.host.instance;
    h.host.reloadDocument();
    await expect(pending).rejects.toMatchObject({ code: 'restarted' });
    await flush();
    expect(h.client.counters.unexpectedLoads).toBe(1);
    expect(h.resets).toEqual([['unexpected-load', old]]);
    expect(h.host.frames).toHaveLength(2);
    expect(h.host.frames[0]!.removed).toBe(true);
    expect(h.client.state).toBe('ready');
    expect(h.readies.at(-1)).toEqual([h.host.instance, false]);
    expect(h.host.instance).not.toBe(old);
  });

  it('a user restart replaces the iframe without counting a compromise signal', async () => {
    const h = await started();
    h.client.restart('restart');
    await flush();
    expect(h.client.counters.unexpectedLoads).toBe(0);
    expect(h.resets.map(([r]) => r)).toEqual(['restart']);
    expect(h.host.frames).toHaveLength(2);
    expect(h.client.state).toBe('ready');
  });
});

describe('EngineClient commands (§3)', () => {
  it('validates results per command type and rejects invalid ones as compromise signals', async () => {
    const h = await started();
    h.tabs.set(1, 'known');
    h.host.on('tab.zoom', () => ({ factor: 99 }));
    await expect(h.client.send('tab.zoom', { tabId: 1, factor: 1.5 })).rejects.toBeInstanceOf(EngineCommandError);
    expect(h.client.counters.invalidResults).toBe(1);
    h.host.on('tab.zoom', () => ({ factor: 1.5, extra: 'dropped' }));
    await expect(h.client.send('tab.zoom', { tabId: 1, factor: 1.5 })).resolves.toEqual({ factor: 1.5 });
  });

  it('passes engine-host error codes on and reads unknown codes as failed', async () => {
    const h = await started();
    h.host.on('tab.go', () => {
      throw { code: 'no_entry', message: 'nothing there' };
    });
    await expect(h.client.send('tab.go', { tabId: 1, delta: -1, permissions: { autoplay: 'block', fullscreen: 'allow', clipboard: 'allow' } })).rejects.toMatchObject({
      code: 'no_entry',
    });
    h.host.on('tab.go', () => {
      throw { code: 'weird_code', message: 'x' };
    });
    await expect(h.client.send('tab.go', { tabId: 1, delta: 1, permissions: { autoplay: 'block', fullscreen: 'allow', clipboard: 'allow' } })).rejects.toMatchObject({
      code: 'failed',
    });
  });

  it('times out with the per-type timeout and counts the late answer apart', async () => {
    const h = await started();
    let release: (() => void) | null = null;
    h.host.on('tab.find', () => new Promise((r) => (release = () => r({ matches: 0, active: 0, highlights: true, capped: false }))));
    const p = h.client.send('tab.find', { tabId: 1, query: 'q', backwards: false, caseSensitive: false });
    await flush();
    h.clock.advance(TIMEOUTS.findMs - 1);
    let settled = false;
    p.catch(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    h.clock.advance(1);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    release!();
    await flush();
    expect(h.client.counters.lateResults).toBe(1);
    expect(compromiseSignals(h.client.counters)).toBe(0);
  });

  it('refuses to send before the engine host is ready', async () => {
    const h = harness();
    await expect(h.client.send('status', {})).rejects.toMatchObject({ code: 'not_ready' });
  });
});

describe('EngineClient event pipeline (§1.2 rule 1)', () => {
  const loading = (tabId: number) => ({ tabId, loading: true });

  it('drops invalid events as compromise signals and ignores unknown types', async () => {
    const h = await started();
    h.host.raw({ k: 'evt', type: 'tab.title', p: { tabId: 1, title: 42 } });
    h.host.raw({ k: 'evt', type: 'tab.future', p: {} });
    h.host.raw({ k: 'nope' });
    await flush();
    expect(h.client.counters.invalidEvents).toBe(2);
    expect(h.client.counters.unknownEventTypes).toBe(1);
    expect(h.events).toEqual([]);
  });

  it('drops unknown tab ids before the rate limits and closed tabs silently', async () => {
    const h = await started();
    h.tabs.set(1, 'known');
    h.tabs.set(2, 'closed');
    for (let i = 0; i < 50; i++) h.host.emit('tab.loading', loading(7));
    h.host.emit('tab.loading', loading(2));
    await flush();
    expect(h.client.counters.unknownIds).toBe(50);
    expect(h.client.counters.rateLimited).toBe(0);
    // The forged ids did not use up the real tab's budget.
    for (let i = 0; i < EVENT_RATE_LIMITS['tab.loading'].burst; i++) h.host.emit('tab.loading', loading(1));
    await flush();
    expect(h.events).toHaveLength(EVENT_RATE_LIMITS['tab.loading'].burst);
    expect(h.client.counters.rateLimited).toBe(0);
  });

  it('rate-limits per tab, counts the drops apart from compromise signals and tells the watchdog', async () => {
    const h = await started();
    h.tabs.set(1, 'known');
    h.tabs.set(3, 'known');
    const burst = EVENT_RATE_LIMITS['tab.favicon'].burst;
    for (let i = 0; i < burst + 2; i++) h.host.emit('tab.favicon', { tabId: 1, icon: null });
    h.host.emit('tab.favicon', { tabId: 3, icon: null });
    await flush();
    expect(h.events.filter((e) => e.type === 'tab.favicon')).toHaveLength(burst + 1);
    expect(h.client.counters.rateLimited).toBe(2);
    expect(h.rateLimited).toEqual([1, 1]);
    expect(compromiseSignals(h.client.counters)).toBe(0);
    h.clock.advance(1000);
    h.host.emit('tab.favicon', { tabId: 1, icon: null });
    await flush();
    expect(h.events.filter((e) => e.type === 'tab.favicon')).toHaveLength(burst + 2);
  });

  it('checks the opener of openRequest; drops events of unrecorded downloads silently and of unannounced ones counted', async () => {
    const h = await started();
    h.tabs.set(1, 'known');
    h.host.emit('tab.openRequest', { openerTabId: 9, url: 'https://example.com/', disposition: 'foreground', userActivation: true });
    await flush();
    expect(h.client.counters.unknownIds).toBe(1);
    // Announced, but over LIBRARY_LIMITS: not counted (§6.9).
    h.host.emit('download.progress', { downloadId: 'capped', received: 1, total: null });
    await flush();
    expect(h.client.counters.unknownIds).toBe(1);
    // Never announced by a download.started: an unknown id (§1.2 rule 8).
    h.host.emit('download.done', { downloadId: 'forged', state: 'completed', received: 1, error: null });
    await flush();
    expect(h.client.counters.unknownIds).toBe(2);
    h.host.emit('download.progress', { downloadId: 'd1', received: 1, total: null });
    await flush();
    expect(h.events.map((e) => e.type)).toEqual(['download.progress']);
    expect(compromiseSignals(h.client.counters)).toBe(0);
  });

  it('delivers events in order with their sanitized values', async () => {
    const h = await started();
    h.tabs.set(1, 'known');
    h.host.emit('tab.title', { tabId: 1, title: 'a‮b\u0007c' });
    h.host.emit('tab.loading', loading(1));
    await flush();
    expect(h.events.map((e) => e.type)).toEqual(['tab.title', 'tab.loading']);
    expect((h.events[0]!.p as { title: string }).title).toBe('ab c');
  });
});

describe('EngineClient liveness (§2.3)', () => {
  it('pings while visible and reports "not responding" after two timeouts in a row; an answer clears it', async () => {
    const h = await started();
    h.host.on('ping', () => HANG);
    h.client.setVisible(true);
    h.clock.advance(0);
    await flush();
    h.clock.advance(TIMEOUTS.pingMs);
    await flush();
    expect(h.client.state).toBe('ready');
    h.clock.advance(TIMEOUTS.pingIntervalMs);
    await flush();
    h.clock.advance(TIMEOUTS.pingMs);
    await flush();
    expect(h.client.state).toBe('unresponsive');
    h.host.handlers.delete('ping');
    await expect(h.client.send('status', {})).resolves.toBeTruthy();
    expect(h.client.state).toBe('ready');
  });

  async function unresponsive(h: Harness): Promise<void> {
    h.client.setVisible(true);
    h.clock.advance(0);
    await flush();
    h.clock.advance(TIMEOUTS.pingMs);
    await flush();
    h.clock.advance(TIMEOUTS.pingIntervalMs);
    await flush();
    h.clock.advance(TIMEOUTS.pingMs);
    await flush();
    expect(h.client.state).toBe('unresponsive');
  }

  it('leaves "not responding" by itself when the late answer of a timed-out ping arrives (no restart)', async () => {
    const h = await started();
    const late: Array<() => void> = [];
    h.host.on('ping', (_m, host) => new Promise((r) => late.push(() => r({ instance: host.instance, uptimeMs: 1 }))));
    await unresponsive(h);
    late[0]!();
    await flush();
    expect(h.client.state).toBe('ready');
    expect(h.client.counters.lateResults).toBe(1);
    expect(h.host.frames).toHaveLength(1);
  });

  it('keeps pinging while "not responding" and recovers on the next answer', async () => {
    const h = await started();
    let hang = true;
    h.host.on('ping', (_m, host) => (hang ? HANG : { instance: host.instance, uptimeMs: 1 }));
    await unresponsive(h);
    const sent = h.host.commandsOf('ping').length;
    hang = false;
    h.clock.advance(TIMEOUTS.pingMs);
    await flush();
    expect(h.host.commandsOf('ping').length).toBe(sent + 1);
    expect(h.client.state).toBe('ready');
    expect(h.host.frames).toHaveLength(1);
  });

  it('does not ping while hidden', async () => {
    const h = await started();
    h.client.setVisible(false);
    h.clock.advance(TIMEOUTS.pingIntervalMs * 3);
    await flush();
    expect(h.host.commandsOf('ping')).toHaveLength(0);
  });
});

describe('EngineClient.testCommand (e2e builds only)', () => {
  it('is refused outside e2e builds and sends nothing', async () => {
    const h = await started();
    const before = h.host.commands.length;
    await expect(h.client.testCommand('test.hooks', {})).rejects.toMatchObject({ code: 'unsupported' });
    await flush();
    expect(h.host.commands.length).toBe(before);
    expect(h.host.violations).toEqual([]);
  });
});
