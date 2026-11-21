/**
 * The browser controller wired to the fake engine host (src/browser/testing/fake-engine-host.ts) and an in-memory
 * library: per-load permissions, history visits through the VisitGate, decideOpen with the app document's own
 * activation, the forwarded-shortcut rules and the navigation watchdog. The tests share one controller (it is a
 * module singleton, like in the app) and run in order.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../app/server.svelte';
import { openHomepage } from '../app/builtin';
import { register } from '../app/shortcuts';
import type { ServerConfig } from '../lib/api';
import { settings } from '../settings/store.svelte';
import { provideLibrary } from '../shared/browser-data';
import { TIMEOUTS } from '../shared/engine-protocol';
import { browser } from './browser.svelte';
import { contextMenuItems } from './contextmenu';
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
async function settle(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
async function until(pred: () => boolean, what: string, n = 400): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error(`timed out: ${what}`);
}

/** Polls in real time (for waits behind the ticket minter's 2 s spacing). */
async function within(pred: () => boolean, what: string, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
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
  void settings.set('privacy', 'sitePermissions', { 'example.com': { autoplay: 'block', clipboard: 'ask' } });
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

describe('browser controller with the fake engine host', () => {
  it('keeps the history at start-up unless "clear history when GNOME closes" is on', () => {
    expect(lib.visits.map((v) => v.url)).toEqual(['https://kept.example/']);
    lib.visits.length = 0;
  });

  it('starts the engine host on the first page, mints a ticket for init and creates the tab with its permissions', async () => {
    const tab = browser.openUrl('https://example.com/')!;
    await until(() => browser.engineState === 'ready', 'engine ready');
    await until(() => browser.model.get(tab.id)?.live === true && !browser.model.get(tab.id)?.loading, 'tab loaded');
    const init = host.commandsOf('init')[0]!;
    expect(init.p.ticket?.value).toMatch(/^w1\./);
    expect(init.p.settings.route).toEqual({ kind: 'default' });
    const create = host.commandsOf('tab.create')[0]!;
    expect(create.p.start).toEqual({ kind: 'url', url: 'https://example.com/' });
    // example.com blocks autoplay; its stored "ask" for clipboard means allow (ENGINE_PERMISSION_ASK).
    expect(create.p.permissions).toEqual({ autoplay: 'block', fullscreen: 'allow', clipboard: 'allow' });
    expect(host.violations).toEqual([]);
    const t = browser.model.get(tab.id)!;
    expect([t.url, t.entries, t.engine]).toEqual(['https://example.com/', ['https://example.com/'], 'scramjet']);
  });

  it('records one history visit per navigation through the VisitGate', async () => {
    expect(lib.visits.map((v) => v.url)).toEqual(['https://example.com/']);
    const t = browser.active!;
    // A reload never adds a visit; a repeat commit of the same URL within a minute neither.
    browser.reload();
    await until(() => host.commandsOf('tab.reload').length === 1 && !browser.active!.loading, 'reload');
    host.emit('tab.committed', { tabId: t.id, navId: 99, url: 'https://example.com/', engine: 'scramjet', kind: 'navigate', historyHandling: 'replace', index: 0, length: 1, canGoBack: false, canGoForward: false, ms: 3 });
    await settle();
    expect(lib.visits).toHaveLength(1);
    browser.submitOmnibox('https://example.org/');
    await until(() => browser.active!.url === 'https://example.org/' && !browser.active!.loading, 'second page');
    expect(lib.visits.map((v) => v.url)).toEqual(['https://example.org/', 'https://example.com/']);
    // Another site: the defaults (autoplay allowed).
    expect(host.commandsOf('tab.navigate').at(-1)!.p.permissions.autoplay).toBe('allow');
  });

  it('decideOpen: a page’s claim alone never opens a tab; with the app document’s activation it does', async () => {
    const opener = browser.active!;
    const before = browser.model.tabs.length;
    activation = { isActive: false };
    host.emit('tab.openRequest', { openerTabId: opener.id, url: 'https://popup.example/', disposition: 'foreground', userActivation: true });
    await until(() => opener.blockedPopups.length === 1, 'blocked');
    expect(browser.model.tabs).toHaveLength(before);
    activation = undefined; // a browser without navigator.userActivation: fail closed
    host.emit('tab.openRequest', { openerTabId: opener.id, url: 'https://popup2.example/', disposition: 'foreground', userActivation: true });
    await until(() => opener.blockedPopups.length === 2, 'blocked again');
    activation = { isActive: true };
    host.emit('tab.openRequest', { openerTabId: opener.id, url: 'https://opened.example/', disposition: 'foreground', userActivation: true });
    await until(() => browser.model.tabs.length === before + 1, 'opened');
    const opened = browser.model.tabs.find((t) => t.url === 'https://opened.example/' || t.entries.includes('https://opened.example/'))!;
    expect(opened.openedByPage).toBe(true);
    expect(browser.model.activeId).toBe(opened.id);
    // window.close() of a tab a page opened, with one entry: closes it.
    await until(() => opened.live && !opened.loading, 'opened loaded');
    // Its first load is the opener page's navigation (start.opener), never GNOME's own (security review, part 2).
    const create = host.commandsOf('tab.create').find((c) => c.p.tabId === opened.id)!;
    expect(create.p.start).toEqual({ kind: 'url', url: 'https://opened.example/', opener: opener.url });
    expect(opened.pageOpen).toBeNull();
    host.emit('tab.closeRequest', { tabId: opened.id });
    await until(() => !browser.model.get(opened.id), 'closed by the page');
    // …but not a tab the user opened.
    host.emit('tab.closeRequest', { tabId: opener.id });
    await settle();
    expect(browser.model.get(opener.id)).toBeTruthy();
    activation = undefined;
  });

  it('"Open link in new tab" in a page’s context menu loads as that page’s navigation (start.opener)', async () => {
    const page = browser.model.tabs.find((t) => t.live && t.url)!;
    const target = { kind: 'link' as const, linkUrl: 'https://linked.example/x', srcUrl: null, selectionText: null, selectionTruncated: false, editable: false };
    const items = contextMenuItems(browser, { tabId: page.id, x: 1, y: 1, target });
    const open = items.find((i) => 'label' in i && i.label === 'Open link in background tab') as { onSelect: () => void } | undefined;
    expect(open).toBeTruthy();
    const before = browser.model.tabs.length;
    open!.onSelect();
    await until(() => browser.model.tabs.length === before + 1, 'the link tab');
    const opened = browser.model.tabs.find((t) => t.entries.includes('https://linked.example/x'))!;
    await until(() => host.commandsOf('tab.create').some((c) => c.p.tabId === opened.id), 'tab.create of the link tab');
    expect(host.commandsOf('tab.create').find((c) => c.p.tabId === opened.id)!.p.start).toEqual({ kind: 'url', url: 'https://linked.example/x', opener: page.url });
  });

  it('one click opens one tab: a burst of opens from one page goes to the pop-up indicator (security review)', async () => {
    const opener = browser.openUrl('https://burst.example/', { newTab: true })!;
    await until(() => browser.model.get(opener.id)?.live === true && !browser.model.get(opener.id)!.loading, 'opener live');
    const before = browser.model.tabs.length;
    activation = { isActive: true };
    for (let i = 1; i <= 4; i++) host.emit('tab.openRequest', { openerTabId: opener.id, url: `https://burst${i}.example/`, disposition: 'foreground', userActivation: true });
    // The first opens; the next two count as having no gesture; the fourth is over the openRequest budget (3 at once):
    // all three are held in the indicator, none opens.
    await until(() => browser.model.get(opener.id)!.blockedPopups.length === 3, 'three held back');
    expect(browser.model.tabs).toHaveLength(before + 1);
    expect(browser.model.get(opener.id)!.blockedPopups.map((p) => p.url)).toEqual(['https://burst2.example/', 'https://burst3.example/', 'https://burst4.example/']);
    // A later click (the window passed, the budget refilled) opens a tab again.
    await new Promise((r) => setTimeout(r, 2100));
    host.emit('tab.openRequest', { openerTabId: opener.id, url: 'https://burst5.example/', disposition: 'foreground', userActivation: true });
    await until(() => browser.model.tabs.length === before + 2, 'a later open');
    activation = undefined;
  });

  it('forwarded keys: only for the active tab, privileged ones only with activation', async () => {
    const ran: string[] = [];
    const offs = [register('reload', () => void ran.push('reload')), register('newTab', () => void ran.push('newTab'))];
    const active = browser.active!;
    const other = browser.openUrl('https://other.example/', { newTab: true, background: true })!;
    await until(() => browser.model.get(other.id)?.live === true, 'background tab live');
    // A tab the user opened is GNOME's own load: no opener.
    await until(() => host.commandsOf('tab.create').some((c) => c.p.tabId === other.id), 'tab.create of the background tab');
    expect(host.commandsOf('tab.create').find((c) => c.p.tabId === other.id)!.p.start).toEqual({ kind: 'url', url: 'https://other.example/' });
    host.emit('tab.key', { tabId: other.id, combo: 'Alt+R', repeat: false });
    host.emit('tab.key', { tabId: active.id, combo: 'Alt+T', repeat: false });
    await settle();
    expect(ran).toEqual([]);
    expect(browser.counters?.refusedShortcuts).toBe(1);
    host.emit('tab.key', { tabId: active.id, combo: 'Alt+R', repeat: false });
    activation = { isActive: true };
    host.emit('tab.key', { tabId: active.id, combo: 'Alt+T', repeat: false });
    await until(() => ran.length === 2, 'ran');
    expect(ran).toEqual(['reload', 'newTab']);
    activation = undefined;
    for (const off of offs) off();
  });

  it('asks tab.state when a navigation gets no outcome within the watchdog time', async () => {
    host.on('tab.navigate', (msg) => ({ navId: 777, engine: 'scramjet', _tab: (msg.p as { tabId: number }).tabId }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      browser.submitOmnibox('https://slow.example/');
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 20; i++) await tick();
      expect(browser.active!.loading).toBe(true);
      const before = host.commandsOf('tab.state').length;
      await vi.advanceTimersByTimeAsync(TIMEOUTS.navigationWatchdogMs + 10);
      for (let i = 0; i < 20; i++) await tick();
      expect(host.commandsOf('tab.state').length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
      host.handlers.delete('tab.navigate');
    }
    // The engine host's answer (not loading) ends the spinner.
    await until(() => browser.active!.loading === false, 'spinner ends');
  });

  it('records downloads within the library caps and drops events of unrecorded ones', async () => {
    const t = browser.active!;
    host.emit('download.started', { downloadId: 'dl-1', tabId: t.id, url: 'https://example.com/file.zip', filename: 'file.zip', mime: 'application/zip', total: 10, engine: 'scramjet' });
    await until(() => browser.downloads.has('dl-1'), 'recorded');
    host.emit('download.progress', { downloadId: 'dl-1', received: 5, total: 10 });
    host.emit('download.done', { downloadId: 'dl-1', state: 'completed', received: 10, error: null });
    await until(() => !browser.downloads.has('dl-1'), 'done');
    const item = [...lib.downloadItems.values()][0]!;
    expect([item.state, item.received]).toEqual(['completed', 10]);
  });

  it('keeps a download.done that arrives right behind its download.started (a small file)', async () => {
    const t = browser.active!;
    const unknownBefore = browser.counters?.unknownIds ?? 0;
    // Like lane d's store: the item is registered at once, the IndexedDB write that started() awaits takes a while.
    const started = lib.downloads.started;
    lib.downloads.started = async (...args) => {
      const recorded = await started.apply(lib.downloads, args);
      await new Promise((r) => setTimeout(r, 60));
      return recorded;
    };
    try {
      host.emit('download.started', { downloadId: 'dl-small', tabId: t.id, url: 'https://example.com/small.zip', filename: 'small.zip', mime: 'application/zip', total: 3, engine: 'scramjet' });
      host.emit('download.progress', { downloadId: 'dl-small', received: 3, total: 3 });
      host.emit('download.done', { downloadId: 'dl-small', state: 'completed', received: 3, error: null });
      await within(() => [...lib.downloadItems.values()].some((d) => d.url === 'https://example.com/small.zip' && d.state === 'completed'), 'small download completed', 1500);
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      lib.downloads.started = started;
    }
    expect(browser.downloads.has('dl-small')).toBe(false);
    expect(browser.counters?.unknownIds ?? 0).toBe(unknownBefore);
    // A download.done for an id no download.started announced is an unknown id (§1.2 rule 8), and changes nothing.
    host.emit('download.done', { downloadId: 'dl-forged', state: 'failed', received: 0, error: 'x' });
    await until(() => (browser.counters?.unknownIds ?? 0) === unknownBefore + 1, 'forged id counted');
  });

  it('while a ticket needs credentials, a page’s pop-up or a forwarded key never prompts (only GNOME’s own UI may)', async () => {
    const { setAccessCodePrompt } = await import('../lib/api');
    const prompts: number[] = [];
    setAccessCodePrompt(async () => {
      prompts.push(Date.now());
      return false;
    });
    type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn<Fetch>>;
    const original = fetchMock.getMockImplementation()!;
    // From now on the server wants an access code (code mode, no session yet).
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/wisp/ticket' || url === '/api/session') {
        return new Response(JSON.stringify({ error: { code: 'access_code_required', message: 'An access code is required.' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return original(url, init);
    });
    try {
      // Not the tab of the earlier pop-up test: its tab.openRequest budget (3, then 0.5 per second) is used up.
      const opener = browser.model.tabs.find((t) => t.live && t.id !== browser.model.activeId)!;
      expect(opener).toBeTruthy();
      host.emit('needTicket', { reason: 'rejected' });
      await within(() => browser.ticketNotice?.kind === 'access-code', 'passive notice');
      const tabsBefore = browser.model.tabs.length;
      activation = { isActive: true }; // a real click in the page: decideOpen opens the tab…
      host.emit('tab.openRequest', { openerTabId: opener.id, url: 'https://popup-while-locked.example/', disposition: 'foreground', userActivation: true });
      await within(() => browser.model.tabs.length === tabsBefore + 1, 'pop-up tab', 3000);
      // Past the minter's 2 s spacing: a mint the pop-up had queued would have run (and prompted) by now.
      await new Promise((r) => setTimeout(r, 2600));
      // …but the access-code dialog only opens from GNOME's own UI (the notice's button, the address bar, Retry).
      expect(prompts).toHaveLength(0);
      expect(browser.ticketNotice?.kind).toBe('access-code');

      // A forwarded `home` key is an ordinary action (no activation needed, so a forged tab.key can send it at any
      // time); with an address as home page it opens that address like a link: no prompt either.
      activation = undefined;
      const offHome = register('home', () => openHomepage());
      void settings.set('browser', 'homepage', 'https://home.example/');
      const active = browser.active!;
      await within(() => active.live && !active.loading, 'active tab live');
      host.emit('tab.key', { tabId: active.id, combo: 'Alt+Home', repeat: false });
      await within(() => host.commandsOf('tab.navigate').some((c) => c.p.url === 'https://home.example/'), 'home page opened', 3000);
      await new Promise((r) => setTimeout(r, 2600));
      offHome();
      expect(prompts).toHaveLength(0);

      await browser.signIn();
      expect(prompts).toHaveLength(1);
    } finally {
      activation = undefined;
      fetchMock.mockImplementation(original);
      setAccessCodePrompt(null);
    }
  }, 20_000);

  it('vpnLocation: the profile route the app chose, with what /api/config says about it', async () => {
    expect(browser.vpnLocation).toBeNull();
    const before = server.config;
    server.config = { ...config, wisp: { ...config.wisp, profiles: [{ id: 'se-got', label: 'Sweden', country_code: 'se', city: 'Gothenburg', path: '/wisp/p/se-got/' }] } };
    try {
      await settings.set('vpn', 'mode', 'gateway');
      await settings.set('vpn', 'preferredLocation', 'se-got');
      expect(browser.vpnLocation).toEqual({ id: 'se-got', label: 'Sweden', status: 'unknown' });
      // A location the server no longer offers: with the kill switch (the default) the route stays on it, and the
      // overlay says why nothing loads.
      await settings.set('vpn', 'preferredLocation', 'nl-ams');
      expect(browser.vpnLocation).toEqual({ id: 'nl-ams', label: 'nl-ams', status: 'gone' });
      // Without the kill switch the route falls back to GNOME's own gateway: no VPN wording at all.
      await settings.set('vpn', 'killSwitch', false);
      expect(browser.vpnLocation).toBeNull();
    } finally {
      await settings.set('vpn', 'mode', 'off');
      await settings.set('vpn', 'killSwitch', true);
      await settings.set('vpn', 'preferredLocation', null);
      server.config = before;
    }
  });
});
