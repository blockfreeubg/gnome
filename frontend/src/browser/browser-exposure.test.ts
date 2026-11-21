/**
 * WAVE-B3 D5 against an engine host a page controls: what it can make the app expose. A forged commit over the budget
 * stays out of the scope also when a forwarded shortcut (reload, back: ordinary forwarded actions that need no real
 * key press, app/shortcuts.ts) loads it again, and when the engine host is replaced and the app re-creates its tabs
 * from their entries (the budget carries over, WAVE-B3 §10.3). GNOME's own loads stay unbudgeted. One controller per
 * file (a module singleton, as in the app); the tests run in order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../app/server.svelte';
import type { ServerConfig } from '../lib/api';
import { normalizeCombo } from '../lib/keys';
import { settings } from '../settings/store.svelte';
import { provideLibrary } from '../shared/browser-data';
import type { EngineSettings } from '../shared/engine-protocol';
import { browser } from './browser.svelte';
import type { DomEmbedder } from './engine/embed';
import { FAKE_PROXY_ORIGIN, FakeEngineHost } from './testing/fake-engine-host';
import { createMemoryLibrary } from './testing/memory-library';

vi.mock('../lib/idb', async (importOriginal) => {
  const kv = new Map<string, unknown>();
  return {
    ...(await importOriginal<typeof import('../lib/idb')>()),
    idbGet: vi.fn(async () => undefined),
    idbPut: vi.fn(async () => 'current'),
    kvGet: vi.fn(async (k: string) => kv.get(k)),
    kvSet: vi.fn(async (k: string, v: unknown) => void kv.set(k, v)),
  };
});

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
async function settle(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
async function until(pred: () => boolean, what: string, n = 600): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`timed out: ${what}`);
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const host = new FakeEngineHost({ blocker: true });
const lib = createMemoryLibrary();
const lastSettings = (): EngineSettings => host.commandsOf('settings').at(-1)!.p.settings;
const sentKeys = (): string[] => lastSettings().extensions.allowlist;
/** Every allowlist key the app sent in `settings` commands (since the `from`-th command). */
const everSent = (from = 0): Set<string> =>
  new Set(host.commandsOf('settings').slice(from).flatMap((c) => c.p.settings.extensions.allowlist));
const settingsCount = (): number => host.commandsOf('settings').length;
const RULES = Array.from({ length: 40 }, (_, i) => `*.f${i}.example`);

/** A commit the engine host reports for the active tab (a page's own navigation, or a forged one). */
function commit(url: string): void {
  const t = browser.active!;
  host.emit('tab.committed', {
    tabId: t.id,
    navId: t.navId,
    url,
    engine: 'scramjet',
    kind: 'navigate',
    historyHandling: 'push',
    index: t.entries.length,
    length: t.entries.length + 1,
    canGoBack: true,
    canGoForward: false,
    ms: 5,
  });
}
/** A shortcut the engine host says the page forwarded (ordinary actions need no real key press). */
function forwardKey(action: 'reload' | 'back'): void {
  const combo = normalizeCombo(settings.value.browser.shortcuts[action] ?? '');
  if (!combo) throw new Error(`no combo for ${action}`);
  host.emit('tab.key', { tabId: browser.active!.id, combo, repeat: false });
}

beforeAll(async () => {
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
  settings.set('extensions', 'allowlist', RULES);
  provideLibrary(lib);
  browser.embedder = Object.assign(host, { setContainer() {}, element: null }) as unknown as DomEmbedder;
  await browser.start();
  browser.setVisible(true);
});

afterAll(() => {
  browser.dispose();
});

describe('the scoped site maps against a hostile engine host (WAVE-B3 D5)', () => {
  it('forged commits expose at most 20 rule-bearing sites per tab per minute', async () => {
    browser.openUrl('https://start.example/');
    await until(() => browser.engineState === 'ready' && host.commandsOf('tab.create').length > 0, 'the tab');
    await settle();
    // Spread over time so the client's tab.committed rate limit (burst 20, 10/s) does not drop them first.
    for (let i = 0; i < 22; i++) {
      commit(`https://f${i}.example/`);
      await wait(110);
    }
    await settle(60);
    expect(browser.active!.url).toBe('https://f21.example/');
    expect(sentKeys()).toContain('*.f19.example');
    expect(everSent().has('*.f20.example')).toBe(false);
    expect(everSent().has('*.f21.example')).toBe(false);
    expect(browser.counters?.droppedExposures).toBe(2);
  }, 20_000);

  it('a forwarded reload of a page over the budget does not expose it (a forged tab.key is no gesture in GNOME’s UI)', async () => {
    // The engine host answers reload and back without its own commits (the forged entries stay the app's entries).
    host.on('tab.reload', () => ({ navId: 1000, engine: 'scramjet' }));
    host.on('tab.go', () => ({ navId: 1001, engine: 'scramjet' }));
    const reloads = host.commandsOf('tab.reload').length;
    const from = settingsCount();
    forwardKey('reload');
    await until(() => host.commandsOf('tab.reload').length === reloads + 1, 'the reload');
    await settle(60);
    expect(everSent(from).has('*.f21.example')).toBe(false);
    expect(browser.counters?.droppedExposures).toBe(3);
  });

  it('a forwarded Back to an entry over the budget does not expose it', async () => {
    const gos = host.commandsOf('tab.go').length;
    const from = settingsCount();
    forwardKey('back');
    await until(() => host.commandsOf('tab.go').length === gos + 1, 'the back');
    await settle(60);
    expect(browser.active!.url).toBe('https://f21.example/'); // the app moves only when the engine host commits
    expect(everSent(from).has('*.f20.example')).toBe(false);
  });

  it('after an engine-host replacement the re-created tab’s entries are budgeted like the commits they came from', async () => {
    const creates = host.commandsOf('tab.create').length;
    const from = settingsCount();
    host.reloadDocument(); // an unexpected load: the app replaces the engine iframe and re-creates its tabs
    await until(() => host.commandsOf('tab.create').length > creates && browser.engineState === 'ready', 'the re-created tab');
    await settle(60);
    const recreated = host.commandsOf('tab.create').at(-1)!.p.start;
    expect(recreated.kind).toBe('restore');
    expect(browser.siteRulesPaused).toBe(false);
    // The sites exposed before stay exposed (the scope is per app page); the ones over the budget stay out.
    expect(sentKeys()).toContain('*.f19.example');
    expect(everSent(from).has('*.f20.example')).toBe(false);
    expect(everSent(from).has('*.f21.example')).toBe(false);
  });

  it('GNOME’s own loads are not budgeted: its Reload button and a typed address expose their sites', async () => {
    browser.reload(); // the toolbar's Reload (a gesture in GNOME's UI)
    await settle(60);
    expect(sentKeys()).toContain('*.f21.example');
    browser.openUrl('https://f30.example/');
    await until(() => host.commandsOf('tab.navigate').some((c) => c.p.url === 'https://f30.example/'), 'navigate');
    expect(sentKeys()).toContain('*.f30.example');
  });
});
