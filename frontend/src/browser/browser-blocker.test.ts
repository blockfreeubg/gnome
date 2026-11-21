/**
 * The app side of content blocking (WAVE-B3 §7.1) wired to the fake engine host with blocker emulation: `init` with
 * `blockerKey`, list refs from the app's `/api/filters` listing, the scoped site maps (D5) and their budget, the
 * answering snapshot for every `tab.loading.url`, `tab.blocked` per category, key rotation (site data cleared,
 * compromise signals), empty maps after two compromise signals, `blocker.stats`/`reload`, and the blocked page's
 * confirmed allow. One controller per file (a module singleton, like in the app); the tests run in order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../app/server.svelte';
import type { ServerConfig } from '../lib/api';
import { isFeatureActive } from '../settings/features';
import { settings } from '../settings/store.svelte';
import { provideLibrary } from '../shared/browser-data';
import type { AnyCommandMessage, BlockerStats, EngineSettings, InitPayload } from '../shared/engine-protocol';
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

const SHA_A = 'a'.repeat(64);
const SHA_R = 'c'.repeat(64);
const entry = (id: string, category: string, sha: string, over: object = {}) => ({
  id,
  name: id,
  category,
  format: category === 'resources' ? 'resources' : 'abp',
  license: 'GPL-3.0',
  homepage: 'https://example.org/',
  default_enabled: true,
  trusted: category === 'resources',
  available: true,
  size: 10,
  sha256: sha,
  updated_at: 1,
  fetched_at: 1,
  version: null,
  ...over,
});
const LISTING = { lists: [entry('easylist', 'ads', SHA_A), entry('off-list', 'annoyances', 'b'.repeat(64), { default_enabled: false })], resources: entry('ubo-resources', 'resources', SHA_R) };

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

const host = new FakeEngineHost({ blocker: true });
const lib = createMemoryLibrary();
const settingsCmds = (): EngineSettings[] => host.commandsOf('settings').map((c) => c.p.settings);
const lastSettings = (): EngineSettings => settingsCmds().at(-1)!;
const indexOf = (pred: (c: AnyCommandMessage) => boolean): number => host.commands.findIndex(pred);

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
      if (url === '/api/filters') return new Response(JSON.stringify(LISTING), { status: 200, headers: { 'content-type': 'application/json', etag: '"l1"' } });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  server.config = config;
  await settings.init();
  settings.reset();
  settings.set('extensions', 'allowlist', ['*.allowed.example', '*.forged-0.example']);
  settings.set('extensions', 'perSite', { '*.news.example': { adblock: false } });
  settings.set('extensions', 'cookieRules', { 'shop.example': 'session' });
  settings.set('performance', 'cacheLimitMB', 64);
  provideLibrary(lib);
  browser.embedder = Object.assign(host, { setContainer() {}, element: null }) as unknown as DomEmbedder;
  await browser.start();
  browser.setVisible(true);
});

afterAll(() => {
  browser.dispose();
});

describe('content blocking, app side (WAVE-B3 §7.1)', () => {
  it('init carries a blocker key, the list refs and the cache limit; no site maps before `blocker` is reported', async () => {
    await until(() => browser.filterListing.listing !== null, 'listing');
    browser.openUrl('https://start.example/');
    await until(() => browser.engineState === 'ready', 'engine ready');
    const init = host.commandsOf('init')[0]!.p as InitPayload;
    expect(init.blockerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(init.settings.extensions.lists.map((l) => l.id)).toEqual(['easylist', 'ubo-resources']);
    expect(init.settings.extensions.cacheLimitMB).toBe(64);
    expect(init.settings.extensions.allowlist).toEqual([]);
    expect(init.settings.extensions.cookieRules).toEqual({});
    expect(host.violations).toEqual([]);
  });

  it('a fresh start: after init the snapshot, then the "until GNOME closes" cookie deletes, then the tab', async () => {
    await until(() => host.commandsOf('tab.create').length > 0, 'the tab');
    const del = indexOf((c) => c.type === 'cookies.delete');
    const snap = indexOf((c) => c.type === 'settings');
    const create = indexOf((c) => c.type === 'tab.create');
    expect(host.commandsOf('cookies.delete').map((c) => c.p)).toEqual([{ all: false, site: 'shop.example', name: null }]);
    expect(snap).toBeGreaterThan(indexOf((c) => c.type === 'init'));
    expect(snap).toBeLessThan(del);
    expect(del).toBeLessThan(create);
  });

  it('after init: cookie rules whole, site maps only for exposed sites', async () => {
    await until(() => settingsCmds().length > 0, 'a snapshot after init');
    await until(() => host.commandsOf('tab.create').length > 0, 'the tab');
    await settle();
    const s = lastSettings().extensions;
    expect(s.cookieRules).toEqual({ 'shop.example': 'session' });
    expect(s.allowlist).toEqual([]);
    expect(s.perSite).toEqual({});
  });

  it('a GNOME-initiated load sends its site rules before the load command', async () => {
    const tab = browser.active!;
    browser.openUrl('https://www.allowed.example/page');
    await until(() => host.commandsOf('tab.navigate').some((c) => c.p.url === 'https://www.allowed.example/page'), 'navigate');
    const nav = indexOf((c) => c.type === 'tab.navigate' && c.p.url === 'https://www.allowed.example/page');
    const snap = indexOf((c) => c.type === 'settings' && c.p.settings.extensions.allowlist.includes('*.allowed.example'));
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(nav);
    expect(lastSettings().extensions.allowlist).toEqual(['*.allowed.example']);
    expect(tab.id).toBe(browser.active!.id);
  });

  it('answers every tab.loading.url at once, also when nothing changed', async () => {
    const t = browser.active!;
    const before = settingsCmds().length;
    host.announce(t.id, 'https://www.allowed.example/again');
    await until(() => settingsCmds().length === before + 1, 'answer to an unchanged announcement');
    host.announce(t.id, 'https://www.news.example/x');
    await until(() => settingsCmds().length === before + 2, 'answer with the new site');
    expect(lastSettings().extensions.perSite).toEqual({ '*.news.example': { adblock: false } });
  });

  it('budgets forged announcements: at most 20 newly exposed rule-bearing sites per tab per minute', async () => {
    const t = browser.active!;
    const many = Array.from({ length: 30 }, (_, i) => `*.forged-${i}.example`);
    settings.set('extensions', 'allowlist', ['*.allowed.example', ...many]);
    await settle();
    // Spread over time so the fake's tab.loading rate limit (burst 20, 10/s) does not drop them first.
    for (let i = 0; i < 30; i++) {
      host.announce(t.id, `https://forged-${i}.example/`);
      await new Promise((r) => setTimeout(r, 110));
    }
    await settle(60);
    const sent = lastSettings().extensions.allowlist.filter((k) => k.startsWith('*.forged-'));
    // The tab's minute allows 20 rule-bearing sites; the news.example announcement of the previous test used one.
    expect(sent.length).toBe(19);
    expect(browser.counters?.droppedExposures).toBeGreaterThanOrEqual(10);
  }, 20_000);

  it('tab.blocked: the shield’s counts per category, and this session’s sums', async () => {
    const t = browser.active!;
    host.blocked(t.id, { ads: 2, trackers: 1, 'direct-connection': 1 });
    await until(() => t.blocked === 4, 'blocked');
    expect(t.blockedBy).toEqual({ ads: 2, trackers: 1, 'direct-connection': 1 });
    host.blocked(t.id, { ads: 5, trackers: 1, 'direct-connection': 1 });
    await until(() => t.blocked === 7, 'blocked 2');
    expect(browser.blockStats.totals).toMatchObject({ ads: 5, trackers: 1 });
  });

  it('status.blocker reaches the app, and blocker.stats / blocker.reload work', async () => {
    host.setBlocker('ready', 'lists-failed:1:2', 1);
    await until(() => browser.status?.blocker.detail === 'lists-failed:1:2', 'status');
    const stats: BlockerStats = {
      engineVersion: 899,
      builtAt: 1,
      buildMs: 900,
      source: 'build',
      engines: [{ group: 'ads', bytes: 1000, network: 10, cosmetic: 5, scriptlets: 1 }],
      lists: [
        { id: 'easylist', sha256: SHA_A, state: 'compiled', error: null, rules: 10, dropped: 0 },
        { id: 'ubo-resources', sha256: SHA_R, state: 'failed', error: 'changed', rules: 0, dropped: 0 },
      ],
      cache: { bytes: 1000, entries: 2, limitBytes: 64 * 1024 * 1024 },
      resources: null,
    };
    host.blockerStats = stats;
    const before = browser.filterListing.requests;
    expect(await browser.refreshBlockerStats()).toEqual(stats);
    // A failed list makes the app ask the server for the listing again.
    await until(() => browser.filterListing.requests > before, 'listing refresh after a failed list');
    await browser.rebuildFilters();
    expect(host.reloads).toBe(1);
    await until(() => browser.status?.blocker.state === 'building', 'building after reload');
  });

  it('a status that reports lists it could not load makes the app ask for the listing again, once per report', async () => {
    host.setBlocker('ready', null, 2);
    await until(() => browser.status?.blocker.detail === null, 'status ready');
    await settle();
    const before = browser.filterListing.requests;
    host.setBlocker('ready', 'lists-failed:1:3', 2);
    await until(() => browser.filterListing.requests === before + 1, 'listing refresh after lists-failed');
    // The same report again (any later status carries it): no second request.
    host.setBlocker('ready', 'lists-failed:1:3', 2);
    await settle(60);
    expect(browser.filterListing.requests).toBe(before + 1);
    host.setBlocker('failed', 'failed:all-lists-failed', 0);
    await until(() => browser.filterListing.requests === before + 2, 'listing refresh after all lists failed');
    host.setBlocker('ready', null, 2);
    await settle();
  });

  it('the blocked page’s confirmed allow adds the key, sends it, then loads the blocked URL', async () => {
    const t = browser.active!;
    host.emit('tab.error', { tabId: t.id, navId: t.navId, url: 'https://docblock.example/x', kind: 'blocked', signal: 'blocked', detail: 'blocked:ads', engine: 'scramjet', fallback: 'none', idempotent: true, latencyMs: 5 });
    await until(() => t.error?.kind === 'blocked', 'blocked error');
    const n = host.commands.length;
    browser.allowBlockedPage(t.id, '*.docblock.example');
    await until(() => host.commandsOf('tab.navigate').some((c) => c.p.url === 'https://docblock.example/x'), 'navigate to the blocked url');
    const later = host.commands.slice(n);
    const snap = later.findIndex((c) => c.type === 'settings' && c.p.settings.extensions.allowlist.includes('*.docblock.example'));
    const nav = later.findIndex((c) => c.type === 'tab.navigate');
    expect(snap).toBeGreaterThan(-1);
    expect(snap).toBeLessThan(nav);
    expect(later.some((c) => c.type === 'tab.reload')).toBe(false);
    expect(settings.value.extensions.allowlist).toContain('*.docblock.example');
  });

  it('clearing site data replaces the key', async () => {
    const key = await browser.blockerKey.get();
    await browser.clearSiteData(['cookies', 'storage', 'cache']);
    expect(await browser.blockerKey.get()).not.toBe(key);
    expect(browser.blockerKey.rotations).toContain('site-data-cleared');
  });

  it('a compromise signal replaces the key; after two the site maps stay empty for this app page', async () => {
    const key = await browser.blockerKey.get();
    host.raw({ k: 'evt', type: 'tab.title', p: { tabId: 'x' } });
    await until(() => (browser.counters?.invalidEvents ?? 0) === 1, 'first signal');
    await settle();
    expect(await browser.blockerKey.get()).not.toBe(key);
    expect(browser.siteRulesPaused).toBe(false);
    host.raw({ k: 'evt', type: 'tab.title', p: { tabId: 'y' } });
    await until(() => browser.siteRulesPaused, 'paused');
    await settle();
    expect(lastSettings().extensions.allowlist).toEqual([]);
    expect(lastSettings().extensions.perSite).toEqual({});
    // Cookie rules cannot be scoped: they still travel while the cookie manager is on (D5).
    expect(lastSettings().extensions.cookieRules).toEqual({ 'shop.example': 'session' });
    browser.openUrl('https://www.allowed.example/after');
    await until(() => host.commandsOf('tab.navigate').some((c) => c.p.url === 'https://www.allowed.example/after'), 'navigate');
    expect(lastSettings().extensions.allowlist).toEqual([]);
  });

  it('does not register the extensions feature in builds without D19’s switch', () => {
    expect(isFeatureActive('extensions')).toBe(false);
  });
});
