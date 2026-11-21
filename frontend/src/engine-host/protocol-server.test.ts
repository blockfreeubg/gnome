import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_TYPES, validateResultMessage } from '../shared/engine-protocol';
import type { Capability, CommandType, EngineSettings } from '../shared/engine-protocol';
import { ProtocolServer, failure } from './protocol-server';
import type { Handlers, TestHandlers } from './protocol-server';

export const SETTINGS: EngineSettings = {
  engines: { scramjet: true, ultraviolet: true },
  engine: 'auto',
  autoFallback: true,
  transport: 'libcurl',
  route: { kind: 'default' },
  privacy: { webrtc: 'block', sendGpc: false, doNotTrack: false, referrer: 'default', stripTrackingParams: false, cookies: 'all' },
  extensions: {
    enabled: { adblock: false, trackers: false, privacy: false, cookies: false, cosmetic: false },
    lists: [],
    allowlist: [],
    perSite: {},
    cosmeticAggressive: false,
    cookieRules: {},
  },
  keys: { combos: ['Alt+T'], apple: false },
};

const PERMS = { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } as const;

function handlers(over: Partial<Handlers> = {}): Handlers {
  const out = {} as Record<CommandType, unknown>;
  for (const t of COMMAND_TYPES) out[t] = () => Promise.reject(failure('failed', `${t} not scripted`));
  return { ...(out as unknown as Handlers), ...over };
}

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

function connect(h: Handlers, opts: { caps?: Capability[]; test?: TestHandlers | null; selfCheck?: boolean } = {}) {
  const ch = new MessageChannel();
  channels.push(ch);
  const server = new ProtocolServer(ch.port2 as unknown as MessagePort, {
    handlers: h,
    testHandlers: opts.test ?? null,
    capabilities: () => opts.caps ?? [],
    selfCheck: opts.selfCheck ?? true,
  });
  const inbox: unknown[] = [];
  const waiters: Array<() => void> = [];
  ch.port1.onmessage = (e) => {
    inbox.push(e.data);
    for (const w of waiters.splice(0)) w();
  };
  const next = async (n = 1): Promise<unknown[]> => {
    while (inbox.length < n) await new Promise<void>((r) => waiters.push(r));
    return inbox.splice(0, n);
  };
  const send = (m: unknown) => ch.port1.postMessage(m);
  return { server, send, next, inbox };
}

const initMsg = (id = 1) => ({
  k: 'cmd',
  id,
  type: 'init',
  p: { settings: SETTINGS, ticket: null, clearOnStart: { cookies: false, siteData: false } },
});

describe('ProtocolServer', () => {
  it('answers invalid and unknown commands with their id', async () => {
    const { send, next } = connect(handlers());
    send({ k: 'cmd', id: 5, type: 'nope', p: {} });
    send({ k: 'cmd', id: 6, type: 'tab.close', p: { tabId: -1 } });
    send({ k: 'cmd', id: 'x', type: 'ping', p: {} }); // no readable id: no answer
    send({ k: 'cmd', id: 7, type: 'ping', p: { ['__proto__']: 1 } });
    const [a, b, c] = await next(3);
    expect(a).toMatchObject({ k: 'res', id: 5, ok: false, error: { code: 'unknown_type' } });
    expect(b).toMatchObject({ k: 'res', id: 6, ok: false, error: { code: 'bad_request' } });
    expect(c).toMatchObject({ k: 'res', id: 7, ok: false, error: { code: 'bad_request' } });
    for (const m of [a, b, c]) expect(validateResultMessage(m).ok).toBe(true);
  });

  it('requires init first, accepts it once, and answers every command exactly once', async () => {
    let inits = 0;
    const { send, next, inbox } = connect(
      handlers({
        init: async () => {
          inits++;
          await new Promise((r) => setTimeout(r, 20));
          return INIT_RESULT;
        },
        'tab.close': () => ({}),
      }),
    );
    send({ k: 'cmd', id: 1, type: 'tab.close', p: { tabId: 1 } });
    expect((await next())[0]).toMatchObject({ id: 1, ok: false, error: { code: 'bad_state' } });
    send(initMsg(2));
    send({ k: 'cmd', id: 3, type: 'tab.close', p: { tabId: 1 } }); // waits for init
    send(initMsg(4));
    const answers = await next(3);
    expect(answers.map((a) => (a as { id: number }).id).sort()).toEqual([2, 3, 4]);
    expect(answers.find((a) => (a as { id: number }).id === 4)).toMatchObject({ ok: false, error: { code: 'bad_state' } });
    expect(answers.find((a) => (a as { id: number }).id === 2)).toMatchObject({ ok: true });
    expect(answers.find((a) => (a as { id: number }).id === 3)).toMatchObject({ ok: true, p: {} });
    expect(inits).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(inbox).toHaveLength(0);
  });

  it('answers unsupported for a command whose capability is not offered', async () => {
    const { send, next } = connect(handlers({ init: () => INIT_RESULT, 'tab.zoom': () => ({ factor: 2 }) }), { caps: [] });
    send(initMsg());
    await next();
    send({ k: 'cmd', id: 2, type: 'tab.zoom', p: { tabId: 1, factor: 2 } });
    send({ k: 'cmd', id: 3, type: 'tab.action', p: { tabId: 1, action: 'print' } });
    const [a, b] = await next(2);
    expect(a).toMatchObject({ id: 2, ok: false, error: { code: 'unsupported' } });
    expect(b).toMatchObject({ id: 3, ok: false, error: { code: 'unsupported' } });
  });

  it('passes the validated payload, maps thrown codes, and fails an invalid result in self-check builds', async () => {
    let seen: unknown = null;
    const { send, next } = connect(
      handlers({
        init: () => INIT_RESULT,
        'tab.navigate': (p) => {
          seen = p;
          return { navId: 1, engine: 'scramjet' };
        },
        'tab.go': () => {
          throw failure('no_entry', 'no such entry');
        },
        'tab.stop': () => {
          throw Object.assign(new Error('weird'), { code: 'EWHATEVER' });
        },
        'tab.state': () => ({ entries: [], index: 3, title: null, loading: false, navId: null, engine: null, error: null }),
      }),
    );
    send(initMsg());
    await next();
    send({ k: 'cmd', id: 2, type: 'tab.navigate', p: { tabId: 1, url: 'https://user:pw@a.example/x', engine: null, permissions: PERMS, extra: 1 } });
    send({ k: 'cmd', id: 3, type: 'tab.go', p: { tabId: 1, delta: -1, permissions: PERMS } });
    send({ k: 'cmd', id: 4, type: 'tab.stop', p: { tabId: 1 } });
    send({ k: 'cmd', id: 5, type: 'tab.state', p: { tabId: 1 } });
    const res = await next(4);
    expect(seen).toEqual({ tabId: 1, url: 'https://a.example/x', engine: null, permissions: PERMS });
    expect(res[0]).toMatchObject({ id: 2, ok: true, p: { navId: 1, engine: 'scramjet' } });
    expect(res[1]).toMatchObject({ id: 3, ok: false, error: { code: 'no_entry', message: 'no such entry' } });
    expect(res[2]).toMatchObject({ id: 4, ok: false, error: { code: 'failed' } });
    expect(res[3]).toMatchObject({ id: 5, ok: false, error: { code: 'failed' } });
  });

  it('exposes test.* only when the build has test handlers', async () => {
    const prod = connect(handlers({ init: () => INIT_RESULT }));
    prod.send({ k: 'cmd', id: 9, type: 'test.stats', p: {} });
    expect((await prod.next())[0]).toMatchObject({ id: 9, ok: false, error: { code: 'unknown_type' } });
    const e2e = connect(handlers(), { test: { 'test.stats': () => ({ n: 1 }) } });
    e2e.send({ k: 'cmd', id: 9, type: 'test.stats', p: {} });
    expect((await e2e.next())[0]).toMatchObject({ id: 9, ok: true, p: { n: 1 } });
  });

  it('drops events that fail the self-check and sends valid ones', async () => {
    const { server, next, inbox } = connect(handlers());
    server.emit('tab.title', { tabId: 1, title: 'x'.repeat(2000) });
    server.emit('tab.title', { tabId: 1, title: 'ok' });
    const [m] = await next();
    expect(m).toEqual({ k: 'evt', type: 'tab.title', p: { tabId: 1, title: 'ok' } });
    expect(server.selfCheckFailures).toBe(1);
    expect(inbox).toHaveLength(0);
  });
});

const STATUS = {
  engines: {
    scramjet: { state: 'ready', version: '2.0.67-alpha.2', detail: null },
    ultraviolet: { state: 'ready', version: '3.2.10', detail: null },
  },
  transport: {
    scramjet: { state: 'ready', transport: 'libcurl', endpoint: 'default', detail: null, since: 1, retryInMs: null },
    ultraviolet: { state: 'ready', transport: 'libcurl', endpoint: 'default', detail: null, since: 1, retryInMs: null },
  },
  sw: { controlled: true, build: 'dev', current: true, updateWaiting: false },
  blocker: { state: 'off', lists: 0, detail: null },
} as const;

const INIT_RESULT = {
  instance: 'abcdefgh12',
  status: STATUS,
  versions: {
    build: 'dev',
    scramjet: '2.0.67-alpha.2',
    scramjetController: '0.0.14',
    ultraviolet: '3.2.10',
    bareMux: '2.1.9',
    transports: { scramjet: { libcurl: '2.0.6', epoxy: '3.0.2' }, ultraviolet: { libcurl: '1.5.2', epoxy: '2.1.29' } },
  },
  capabilities: [],
  enforcedPermissions: [],
  timings: { swReadyMs: 1, scramjetMs: 2, ultravioletMs: 3, totalMs: 4 },
} as unknown as ReturnType<Handlers['init']> extends infer R ? Awaited<R> : never;
