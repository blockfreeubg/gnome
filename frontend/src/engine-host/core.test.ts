// The composition root's runtime with lane a's fakes (WAVE-B §2 "Fakes to work alone"): the commands that need no
// DOM, answered over a real MessageChannel, every result checked with the contract's validators.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateCommandResult, validateResultMessage } from '../shared/engine-protocol';
import type { CommandType } from '../shared/engine-protocol';
import { EngineHostRuntime, OFFERED_CAPABILITIES } from './core';
import type { Natives } from './natives';
import { FakeSwClient } from './testing/fake-sw-client';
import { FakeTransportManager } from './testing/fake-transport-manager';
import type { EngineSettings } from '../shared/engine-protocol';

const SETTINGS: EngineSettings = {
  engines: { scramjet: true, ultraviolet: true },
  engine: 'auto',
  autoFallback: true,
  transport: 'libcurl',
  route: { kind: 'default' },
  privacy: { webrtc: 'allow', sendGpc: false, doNotTrack: false, referrer: 'default', stripTrackingParams: false, cookies: 'all' },
  extensions: { enabled: { adblock: false, trackers: false, privacy: false, cookies: false, cosmetic: false }, lists: [], allowlist: [], perSite: {}, cosmeticAggressive: false, cookieRules: {} },
  keys: { combos: ['Alt+T'], apple: false },
};

let channel: MessageChannel;
let seq = 0;
const pending = new Map<number, (m: unknown) => void>();

function start() {
  channel = new MessageChannel();
  const transport = new FakeTransportManager();
  const sw = new FakeSwClient();
  new EngineHostRuntime({ N: { on: () => undefined } as unknown as Natives, port: channel.port1 as unknown as MessagePort, transport, sw, instance: 'abcdefgh12345678', startedAt: performance.now() });
  channel.port2.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { k: string; id?: number };
    if (m.k === 'res' && typeof m.id === 'number') pending.get(m.id)?.(m);
  };
  return { transport, sw };
}

function cmd(type: CommandType | string, p: unknown = {}): Promise<{ ok: boolean; p?: unknown; error?: { code: string } }> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, (m) => {
      pending.delete(id);
      expect(validateResultMessage(m)).toBeTruthy();
      resolve(m as { ok: boolean; p?: unknown; error?: { code: string } });
    });
    channel.port2.postMessage({ k: 'cmd', id, type, p });
  });
}

// The DOM the init path touches without tabs: the #tabs container and `window` (no vendor scripts are loaded, so
// both engines fail to initialize, as they would after a broken vendor copy).
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  g.document = { getElementById: () => ({ id: 'tabs' }) };
  g.window = globalThis;
  g.location = new URL('http://127.0.0.1:27201/engine/');
});
afterEach(() => {
  channel.port1.close();
  channel.port2.close();
  vi.useRealTimers();
  delete g.document;
  delete g.window;
  delete g.location;
});

const INIT = { settings: { ...SETTINGS, privacy: { ...SETTINGS.privacy, webrtc: 'allow' } }, ticket: { value: 'tkt_'.padEnd(40, 'a'), expiresAt: Date.now() + 3_600_000, wispUrl: 'ws://127.0.0.1:1/wisp/' }, clearOnStart: { cookies: false, siteData: false } };

describe('EngineHostRuntime with the fakes', () => {
  it('answers commands before init with bad_state', async () => {
    start();
    expect((await cmd('ping')).error?.code).toBe('bad_state');
  });

  it('initializes with the fakes, reports the failed engines, and answers ping, status and diagnostics', async () => {
    const { transport, sw } = start();
    const init = await cmd('init', INIT);
    expect(init.ok).toBe(true);
    expect(validateCommandResult('init', init.p)).toBeTruthy();
    expect(init.p).toMatchObject({ capabilities: [...OFFERED_CAPABILITIES], status: { engines: { scramjet: { state: 'failed' }, ultraviolet: { state: 'failed' } } } });
    expect(sw.ensureCalls).toBe(1);
    expect(transport.calls.map((c) => c.fn)).toContain('start');
    expect((await cmd('init', INIT)).error?.code).toBe('bad_state');
    const ping = await cmd('ping');
    expect(ping.ok).toBe(true);
    expect(ping.p).toMatchObject({ instance: 'abcdefgh12345678' });
    const status = await cmd('status');
    expect(status.ok && validateCommandResult('status', status.p)).toBeTruthy();
    const diag = await cmd('diagnostics');
    expect(diag.ok).toBe(true);
    expect(validateCommandResult('diagnostics', diag.p)).toBeTruthy();
    expect(diag.p).toMatchObject({ capabilities: [...OFFERED_CAPABILITIES], tabs: { live: 0, scramjet: 0, ultraviolet: 0 } });
  });

  it('fails a load with engine_unavailable when no engine is ready; unknown commands and test.* (non-e2e build) are unknown_type', async () => {
    start();
    await cmd('init', INIT);
    expect((await cmd('tab.create', { tabId: 1, active: true, engine: null, zoom: 1, start: { kind: 'url', url: 'https://example.com/' }, permissions: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } })).error?.code).toBe('engine_unavailable');
    expect((await cmd('tab.state', { tabId: 1 })).error?.code).toBe('no_tab');
    expect((await cmd('no.such')).error?.code).toBe('unknown_type');
    expect((await cmd('test.stats')).error?.code).toBe('unknown_type');
  });

  it('answers suggest through proxyFetch, and offers saveLink/saveImage (tab.download)', async () => {
    const { transport } = start();
    await cmd('init', INIT);
    transport.fetchResult = { status: 200, headers: [], body: new TextEncoder().encode('["q",["one","two"]]').buffer as ArrayBuffer };
    const s = await cmd('suggest', { query: 'q', provider: 'bing' });
    expect(s).toMatchObject({ ok: true, p: { items: ['one', 'two'] } });
    expect(validateCommandResult('suggest', s.p)).toBeTruthy();
    transport.fetchResult = { status: 503, headers: [], body: new ArrayBuffer(0) };
    expect((await cmd('suggest', { query: 'q', provider: 'bing' })).error?.code).toBe('failed');
    expect(OFFERED_CAPABILITIES).toEqual(expect.arrayContaining(['saveLink', 'saveImage']));
    // Offered: the command reaches the tab manager (no such tab here) instead of being refused as unsupported.
    const r = await cmd('tab.download', { tabId: 1, url: 'https://example.com/a.bin', kind: 'link' });
    expect(r.error?.code).toBe('no_tab');
  });
});

describe('browserFamily', () => {
  it('needs both the User-Agent token and the engine feature', async () => {
    const { browserFamily } = await import('../shared/site-rules');
    const blink = { featurePolicy: {} };
    const gecko = { mozInnerScreenX: 0 };
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36', blink, {})).toBe('chromium');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36', blink, {})).toBe('chromium');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0', {}, gecko)).toBe('gecko');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0', {}, gecko)).toBe('other');
    // A spoofed Firefox User-Agent in another engine claims no enforcement.
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0', blink, {})).toBe('other');
    expect(browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', {}, {})).toBe('other');
  });
});
