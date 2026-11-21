/**
 * "Clear … when GNOME closes" at the next fresh start (ENGINE-PROTOCOL §6.11, docs/WAVE-B.md §4): a new browser tab
 * with no other GNOME page open clears the history (library) and asks the first engine host to clear proxied cookies
 * and site data before its engines start (init.clearOnStart). Its own file: the controller is a module singleton.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../app/server.svelte';
import type { ServerConfig } from '../lib/api';
import { settings } from '../settings/store.svelte';
import { provideLibrary } from '../shared/browser-data';
import { browser } from './browser.svelte';
import { FAKE_PROXY_ORIGIN, FakeEngineHost } from './testing/fake-engine-host';
import { createMemoryLibrary } from './testing/memory-library';
import type { DomEmbedder } from './engine/embed';

vi.mock('../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/idb')>()),
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => 'current'),
}));

const config: ServerConfig = {
  version: '0.1.0',
  access_mode: 'open',
  registration: 'closed',
  features: { accounts: false, sync: false, games: false, vpn_gateway: false, thumb_proxy: false },
  wisp: { path: '/wisp/', ticket_ttl_s: 3600, profiles: [], custom_servers: false },
  engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
  proxy: { origin: FAKE_PROXY_ORIGIN, isolated: true },
  source_url: null,
  limits: { max_ws_per_session: 16 },
};

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(pred: () => boolean, what: string, n = 400): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`timed out: ${what}`);
}

const host = new FakeEngineHost();
const lib = createMemoryLibrary();
let activation: { isActive: boolean } | undefined;

beforeAll(async () => {
  Object.defineProperty(globalThis.navigator, 'userActivation', { configurable: true, get: () => activation });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/wisp/ticket') {
        return new Response(JSON.stringify({ ticket: 'w1.1800000000.AAAAAAAAAAAAAAAAAAAAAA.' + 'B'.repeat(43), expires_at: Date.now() + 3_600_000, wisp_url: 'ws://127.0.0.1:28002/wisp/' }), {
          status: 200,
          headers: { 'content-type': 'application/json', date: new Date().toUTCString() },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  server.config = config;
  await settings.init();
  settings.reset();
  void settings.set('privacy', 'clearHistoryOnExit', true);
  void settings.set('privacy', 'clearSiteDataOnExit', true);
  void settings.set('browser', 'cookies', { ...settings.value.browser.cookies, clearOnExit: true });
  await lib.history.recordVisit({ url: 'https://kept.example/', title: 'Kept', at: 1 });
  provideLibrary(lib);
  browser.embedder = Object.assign(host, { setContainer() {}, element: null }) as unknown as DomEmbedder;
  await browser.start();
  browser.setVisible(true);
});

afterAll(() => {
  browser.dispose();
  vi.unstubAllGlobals();
});

describe('clear on exit, applied at the next fresh start', () => {
  it('clears the history once the library is there', () => {
    expect(lib.visits).toEqual([]);
  });

  it('sends clearOnStart with the first init only', async () => {
    const tab = browser.openUrl('https://example.com/')!;
    await until(() => browser.engineState === 'ready' && browser.model.get(tab.id)?.live === true, 'engine ready');
    expect(host.commandsOf('init')[0]!.p.clearOnStart).toEqual({ cookies: true, siteData: true });
    browser.restartEngine('restart');
    // The second init waits for its ticket: at most one mint per 2 s (TICKET.appMinIntervalMs).
    for (let i = 0; i < 500 && !(host.commandsOf('init').length === 2 && browser.engineState === 'ready'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(host.commandsOf('init')[1]!.p.clearOnStart).toEqual({ cookies: false, siteData: false });
  });
});
