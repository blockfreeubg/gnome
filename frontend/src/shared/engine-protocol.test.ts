import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  COALESCE_MS,
  COMMAND_TYPES,
  EVENT_FLOOD_LIMIT,
  EVENT_RATE_LIMITS,
  EVENT_TYPES,
  FAVICON_MAX_CHARS,
  FORWARDED_PRIVILEGED_LIMIT,
  HISTORY_HANDLING_FOR_KIND,
  LIMITS,
  PROTOCOL_VERSION,
  TICKET,
  TIMEOUTS,
  TRANSPORT_DETAILS,
  TokenBuckets,
  admitEvent,
  commandTimeoutMs,
  decideConnect,
  decideHello,
  engineChoice,
  fitInt,
  fitText,
  isCombo,
  isWispServer,
  normalizeHttpUrl,
  requiredCapability,
  sanitizeText,
  ticketExpiresAtLocal,
  ticketRenewDelayMs,
  validateCommandMessage,
  validateCommandPayload,
  validateCommandResult,
  validateConnect,
  validateEngineSettings,
  validateEventMessage,
  validateEventPayload,
  validateHello,
  validateMismatch,
  validateResultMessage,
  type AnyEventMessage,
  type CommandPayload,
  type CommandResult,
  type CommandType,
  type EngineHostStatus,
  type EngineSettings,
  type EventMap,
  type EventType,
  type Validated,
} from './engine-protocol';

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const transport = {
  state: 'ready',
  transport: 'libcurl',
  endpoint: 'default',
  detail: null,
  since: 1_762_900_000_000,
  retryInMs: null,
} as const;

const status = (): EngineHostStatus => ({
  engines: {
    scramjet: { state: 'ready', version: '2.0.67-alpha.2', detail: null },
    ultraviolet: { state: 'failed', version: '3.2.10', detail: 'bare-mux setTransport timed out' },
  },
  transport: { scramjet: { ...transport }, ultraviolet: { ...transport, state: 'offline', detail: 'gateway-unreachable', retryInMs: 2000 } },
  sw: { controlled: true, build: '0.1.0+abc123', current: true, updateWaiting: false },
  blocker: { state: 'off', lists: 0, detail: null },
});

const versions = {
  build: '0.1.0+abc123',
  scramjet: '2.0.67-alpha.2',
  scramjetController: '0.0.14',
  ultraviolet: '3.2.10',
  bareMux: '2.1.9',
  transports: { scramjet: { libcurl: '2.0.6', epoxy: '3.0.2' }, ultraviolet: { libcurl: '1.5.2', epoxy: '2.1.29' } },
};

const settings = (): EngineSettings => ({
  engines: { scramjet: true, ultraviolet: true },
  engine: 'auto',
  autoFallback: true,
  transport: 'libcurl',
  route: { kind: 'default' },
  privacy: {
    webrtc: 'block',
    sendGpc: true,
    doNotTrack: false,
    referrer: 'origin-cross-site',
    stripTrackingParams: true,
    cookies: 'block-third-party',
  },
  extensions: {
    enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true },
    lists: [{ id: 'easylist', sha256: 'a'.repeat(64), category: 'ads', format: 'abp', trusted: false }],
    allowlist: ['intranet.example'],
    perSite: { 'news.example': { cosmetic: false } },
    cosmeticAggressive: false,
    cookieRules: { 'bank.example': 'allow' },
  },
  keys: { combos: ['Alt+T', 'Mod+F', 'Alt+Shift+ArrowLeft', 'Alt+,'], apple: false },
});

const permissions = { autoplay: 'block', fullscreen: 'allow', clipboard: 'allow' } as const;

const ticket = { value: 'w1.1762903600.AAAAAAAAAAAAAAAAAAAAAA.' + 'B'.repeat(43), expiresAt: 1_762_903_600_000, wispUrl: 'wss://p.gnome.example/wisp/' };

const diagnostics = {
  instance: 'abcd1234efgh',
  uptimeMs: 12_000,
  status: status(),
  versions,
  capabilities: ['zoom', 'cookies'],
  enforcedPermissions: ['autoplay', 'fullscreen'],
  tabs: { live: 2, scramjet: 1, ultraviolet: 1 },
  sw: { starts: 1, held: 0, unavailable: 0 },
  csp: { violations: 7, byDirective: { 'img-src': 7 } },
  webrtc: { policy: 'block', blocked: 1 },
  transport: {
    probes: { valid: 2, rejected: 1, unreachable: 0, rateLimited: 0, upstreamDown: 1, unknownProfile: 0 },
    rebuilds: { scramjet: 1, ultraviolet: 0 },
    drops: { scramjet: 1, ultraviolet: 0 },
  },
  fallback: { switched: 1, notRetried: 0 },
  protocol: { rejectedCommands: 0 },
  memory: null,
  mainThread: { maxLagMs: 96, longTasks: 5, longTaskMs: 400 },
};

/** One valid payload and one valid result per command type. */
const COMMANDS: { [T in CommandType]: { payload: CommandPayload<T>; result: CommandResult<T> } } = {
  init: {
    payload: { settings: settings(), ticket, clearOnStart: { cookies: false, siteData: false } },
    result: {
      instance: 'abcd1234efgh',
      status: status(),
      versions,
      capabilities: ['zoom', 'print', 'suggest'],
      enforcedPermissions: ['autoplay', 'fullscreen', 'clipboard'],
      timings: { swReadyMs: 69, scramjetMs: 116, ultravioletMs: null, totalMs: 185 },
    },
  },
  settings: { payload: { settings: settings() }, result: {} },
  ticket: { payload: ticket, result: {} },
  status: { payload: {}, result: status() },
  ping: { payload: {}, result: { instance: 'abcd1234efgh', uptimeMs: 5 } },
  diagnostics: { payload: {}, result: diagnostics as CommandResult<'diagnostics'> },
  'tab.create': {
    payload: {
      tabId: 1,
      active: true,
      engine: null,
      zoom: 1,
      start: { kind: 'restore', entries: ['https://a.example/', 'https://b.example/'], index: 1 },
      permissions: { ...permissions },
    },
    result: { navId: 3, engine: 'scramjet' },
  },
  'tab.close': { payload: { tabId: 1 }, result: {} },
  'tab.activate': { payload: { tabId: null }, result: {} },
  'tab.navigate': {
    payload: { tabId: 1, url: 'https://example.com/', engine: 'ultraviolet', permissions: { ...permissions } },
    result: { navId: 4, engine: 'ultraviolet' },
  },
  'tab.go': { payload: { tabId: 1, delta: -1, permissions: { ...permissions } }, result: { navId: 5, engine: 'scramjet' } },
  'tab.reload': { payload: { tabId: 1, permissions: { ...permissions } }, result: { navId: 6, engine: 'scramjet' } },
  'tab.stop': { payload: { tabId: 1 }, result: {} },
  'tab.state': {
    payload: { tabId: 1 },
    result: {
      entries: ['https://a.example/', 'https://b.example/next'],
      index: 1,
      title: 'Next',
      loading: false,
      navId: 7,
      engine: 'scramjet',
      error: null,
    },
  },
  'tab.zoom': { payload: { tabId: 1, factor: 1.25 }, result: { factor: 1.25 } },
  'tab.find': {
    payload: { tabId: 1, query: 'gnome', backwards: false, caseSensitive: false },
    result: { matches: 159, active: 1, highlights: true, capped: false },
  },
  'tab.findClear': { payload: { tabId: 1 }, result: {} },
  'tab.action': { payload: { tabId: 1, action: 'print' }, result: {} },
  'tab.download': { payload: { tabId: 1, url: 'https://example.com/file.zip', kind: 'link' }, result: {} },
  'cookies.list': {
    payload: { site: 'example.com' },
    result: {
      cookies: [
        { engine: 'scramjet', domain: '.example.com', path: '/', name: 'sid', size: 32, expires: null, secure: true, httpOnly: true, sameSite: 'lax' },
      ],
      truncated: false,
    },
  },
  'cookies.delete': { payload: { all: false, site: 'example.com', name: null }, result: { deleted: 3 } },
  'siteData.clear': { payload: { kinds: ['cookies', 'storage'] }, result: {} },
  suggest: { payload: { query: 'gnome', provider: 'duckduckgo' }, result: { items: ['gnome', 'gnome shell'] } },
  'vpn.verify': {
    payload: { url: 'https://am.i.mullvad.net/json' },
    result: { ip: '185.65.135.1', country: 'Sweden', city: 'Gothenburg', vpnExit: true, checkedAt: 1_762_900_000_000 },
  },
  'blocker.stats': {
    payload: {},
    result: {
      engineVersion: 899,
      builtAt: 1_763_510_400_000,
      buildMs: 912,
      source: 'build',
      engines: [{ group: 'ads', bytes: 5_570_000, network: 90_000, cosmetic: 30_000, scriptlets: 8_000 }],
      lists: [
        { id: 'easylist', sha256: 'a'.repeat(64), state: 'compiled', error: null, rules: 70_000, dropped: 12 },
        { id: 'peter-lowe', sha256: 'b'.repeat(64), state: 'failed', error: 'changed', rules: 0, dropped: 0 },
      ],
      cache: { bytes: 9_050_000, entries: 4, limitBytes: 268_435_456 },
      resources: { redirects: 120, scriptlets: 99 },
    },
  },
  'blocker.reload': { payload: {}, result: {} },
};

/** One valid payload per event type. */
const EVENTS: { [T in EventType]: EventMap[T] } = {
  status: status(),
  needTicket: { reason: 'expiring' },
  'tab.loading': { tabId: 1, loading: true },
  'tab.committed': {
    tabId: 1,
    navId: 2,
    url: 'https://en.wikipedia.org/wiki/Gnome',
    engine: 'scramjet',
    kind: 'navigate',
    historyHandling: 'push',
    index: 0,
    length: 1,
    canGoBack: false,
    canGoForward: false,
    ms: 919,
  },
  'tab.loaded': { tabId: 1, navId: 2, url: 'https://en.wikipedia.org/wiki/Gnome', engine: 'scramjet', ms: 1200 },
  'tab.title': { tabId: 1, title: 'Gnome - Wikipedia' },
  'tab.favicon': { tabId: 1, icon: PNG_1PX },
  'tab.error': {
    tabId: 1,
    navId: 2,
    url: 'https://nope.invalid/',
    kind: 'network',
    signal: 'error-hook',
    detail: 'Request failed with error code 7: Could not connect to server',
    engine: 'ultraviolet',
    fallback: 'attempted',
    idempotent: true,
    latencyMs: 16,
  },
  'tab.engineSwitched': { tabId: 1, navId: 2, from: 'scramjet', to: 'ultraviolet', reason: 'error-hook', latencyMs: 3 },
  'tab.openRequest': { openerTabId: 1, url: 'https://example.com/login', disposition: 'foreground', userActivation: true },
  'tab.closeRequest': { tabId: 1 },
  'tab.blocked': { tabId: 1, total: 7, byCategory: { 'direct-connection': 7 } },
  'tab.contextMenu': {
    tabId: 1,
    x: 495,
    y: 209,
    target: { kind: 'link', linkUrl: 'https://example.com/next', srcUrl: null, selectionText: null, selectionTruncated: false, editable: false },
  },
  'tab.key': { tabId: 1, combo: 'Alt+T', repeat: false },
  'tab.fullscreen': { tabId: 1, active: true },
  'download.started': {
    downloadId: 'sj-1',
    tabId: 1,
    url: 'https://example.com/gnome-spike.bin',
    filename: 'gnome-spike.bin',
    mime: 'application/octet-stream',
    total: 2_097_152,
    engine: 'scramjet',
  },
  'download.progress': { downloadId: 'sj-1', received: 65_536, total: 2_097_152 },
  'download.done': { downloadId: 'uv-mwcwgvf8-1', state: 'completed', received: 2_097_152, error: null },
  log: { level: 'warn', message: 'transport rebuilt\nafter a drop' },
};

const clone = <T>(v: T): T => structuredClone(v);
const ok = <T>(r: Validated<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
};
const rejected = (r: Validated<unknown>): string => {
  if (r.ok) throw new Error(`expected a rejection, got ${JSON.stringify(r.value).slice(0, 200)}`);
  return r.error;
};
const evt = <T extends EventType>(type: T, p: unknown) => validateEventPayload(type, p);
const withKey = (obj: object, json: string): unknown => ({ ...clone(obj), ...JSON.parse(json) });

// ── Coverage of the type lists ───────────────────────────────────────────────────────────────────────────────────

describe('type lists', () => {
  it('lists every command and event exactly once and has a rate limit for every event', () => {
    expect(new Set(COMMAND_TYPES).size).toBe(COMMAND_TYPES.length);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect([...COMMAND_TYPES].sort()).toEqual(Object.keys(COMMANDS).sort());
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(EVENTS).sort());
    expect(Object.keys(EVENT_RATE_LIMITS).sort()).toEqual([...EVENT_TYPES].sort());
    for (const limit of Object.values(EVENT_RATE_LIMITS)) {
      expect(limit.burst).toBeGreaterThanOrEqual(1);
      expect(limit.perSecond).toBeGreaterThan(0);
    }
  });

  it('keeps the app live-tab cap below the engine-host hard cap', () => {
    expect(LIMITS.liveTabsSoftCap).toBeLessThan(LIMITS.maxLiveTabs);
  });

  it('gives every command a timeout', () => {
    for (const t of COMMAND_TYPES) expect(commandTimeoutMs(t)).toBeGreaterThan(0);
    expect(commandTimeoutMs('init')).toBe(40_000);
    expect(commandTimeoutMs('tab.navigate')).toBe(10_000);
  });
});

// ── Valid examples ───────────────────────────────────────────────────────────────────────────────────────────────

describe('valid messages pass unchanged', () => {
  for (const type of COMMAND_TYPES) {
    it(`command ${type}: payload and result`, () => {
      const c = COMMANDS[type];
      expect(ok(validateCommandPayload(type, clone(c.payload)))).toEqual(c.payload);
      expect(ok(validateCommandResult(type, clone(c.result)))).toEqual(c.result);
      const msg = ok(validateCommandMessage({ k: 'cmd', id: 7, type, p: clone(c.payload) }));
      expect(msg).toEqual({ k: 'cmd', id: 7, type, p: c.payload });
    });
  }
  for (const type of EVENT_TYPES) {
    it(`event ${type}`, () => {
      const p = EVENTS[type];
      expect(ok(evt(type, clone(p)))).toEqual(p);
      expect(ok(validateEventMessage({ k: 'evt', type, p: clone(p) }))).toEqual({ k: 'evt', type, p });
    });
  }

  it('accepts the other variants of unions and nullable fields', () => {
    for (const start of [{ kind: 'blank' }, { kind: 'url', url: 'https://example.com/' }]) {
      ok(validateCommandPayload('tab.create', { tabId: 2, active: false, engine: 'scramjet', zoom: 0.25, start, permissions }));
    }
    for (const route of [
      { kind: 'profile', id: 'se-got' },
      { kind: 'custom', servers: ['wss://wisp.example.org/', '/wisp/', 'ws://127.0.0.1:6001/'] },
    ]) {
      ok(validateEngineSettings({ ...settings(), route }));
    }
    ok(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'same-document', historyHandling: 'replace', navId: null, ms: null }));
    ok(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'history', historyHandling: 'traverse', index: 1, length: 3, canGoBack: true, canGoForward: true }));
    ok(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'reload', historyHandling: 'replace', index: 2, length: 3, canGoBack: true }));
    ok(validateCommandResult('tab.state', { entries: [], index: 0, title: null, loading: true, navId: 1, engine: 'ultraviolet', error: null }));
    ok(validateCommandResult('tab.state', { ...COMMANDS['tab.state'].result, error: { ...EVENTS['tab.error'] } }));
    ok(evt('tab.favicon', { tabId: 1, icon: null }));
    ok(evt('tab.favicon', { tabId: 1, icon: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}` }));
    ok(evt('tab.error', { ...EVENTS['tab.error'], url: null, navId: null, kind: 'gateway', idempotent: false, fallback: 'available' }));
    ok(evt('download.done', { downloadId: 'sj-2', state: 'failed', received: 0, error: 'stream aborted' }));
    ok(validateCommandPayload('cookies.delete', { all: true, site: null, name: null }));
    ok(validateCommandResult('tab.create', { navId: null, engine: null }));
    ok(validateCommandResult('tab.find', { matches: 0, active: 0, highlights: false, capped: false }));
  });
});

// ── Sanitizing (cosmetic, never rejects) ─────────────────────────────────────────────────────────────────────────

describe('sanitizing', () => {
  it('drops unknown keys at every level', () => {
    const v = ok(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], extra: 1, target: { ...EVENTS['tab.contextMenu'].target, onclick: 'x' } }));
    expect(v).toEqual(EVENTS['tab.contextMenu']);
    expect('extra' in v || 'onclick' in v.target).toBe(false);
    const s = ok(validateEngineSettings({ ...settings(), csp: 'off', privacy: { ...settings().privacy, cspPolicy: '' } }));
    expect(s).toEqual(settings());
  });

  it('removes control and bidi characters from single-line text and fixes lone surrogates', () => {
    const title = 'Bank\u202e lanoitan\u0000 \u0007tab\tnew\nline \ud800 end \u2066x\u2069';
    expect(ok(evt('tab.title', { tabId: 1, title })).title).toBe('Bank lanoitan   tab new line \ufffd end x');
    expect(sanitizeText('a\u0085b\u009fc')).toBe('a b c');
  });

  it('keeps line breaks and tabs in multi-line text (selection, log) but drops other controls', () => {
    const v = ok(evt('tab.contextMenu', {
      ...EVENTS['tab.contextMenu'],
      target: { kind: 'selection', linkUrl: null, srcUrl: null, selectionText: 'line 1\nline 2\t\u0000\u001b[31m', selectionTruncated: false, editable: false },
    }));
    expect(v.target.selectionText).toBe('line 1\nline 2\t[31m');
    expect(ok(evt('log', { level: 'info', message: 'a\r\nb\u0007' })).message).toBe('a\r\nb');
  });

  it('removes bidi controls from multi-line text too (selection, find query, log)', () => {
    const v = ok(evt('tab.contextMenu', {
      ...EVENTS['tab.contextMenu'],
      target: { kind: 'selection', linkUrl: null, srcUrl: null, selectionText: 'a\u202eb\u2066c\u2069\nd', selectionTruncated: false, editable: false },
    }));
    expect(v.target.selectionText).toBe('abc\nd');
    expect(sanitizeText('a\u202eb', true)).toBe('ab');
    expect(ok(validateCommandPayload('tab.find', { tabId: 1, query: 'x\u202dy', backwards: false, caseSensitive: false })).query).toBe('xy');
    expect(ok(evt('log', { level: 'info', message: '\u2067rtl\u2069' })).message).toBe('rtl');
  });

  it('normalizes URLs and strips credentials', () => {
    const v = ok(evt('tab.committed', { ...EVENTS['tab.committed'], url: 'HTTPS://User:Secret@Example.COM:443/a/../b?q=1#h' }));
    expect(v.url).toBe('https://example.com/b?q=1#h');
    expect(normalizeHttpUrl('http://user@example.com/')).toBe('http://example.com/');
    expect(normalizeHttpUrl('ftp://example.com/')).toBeNull();
  });

  it('reads unknown command error codes as "failed" and sanitizes the message', () => {
    const r = ok(validateResultMessage({ k: 'res', id: 3, ok: false, error: { code: 'pwned', message: 'x\u0000y' } }));
    expect(r).toEqual({ k: 'res', id: 3, ok: false, error: { code: 'failed', message: 'x y' } });
    expect(ok(validateResultMessage({ k: 'res', id: 3, ok: true, p: { anything: 1 } }))).toEqual({ k: 'res', id: 3, ok: true, p: { anything: 1 } });
  });

  it('does not mutate its input', () => {
    const input = { ...clone(EVENTS['tab.title']), extra: true, title: 'a\u0000b' };
    const copy = clone(input);
    ok(evt('tab.title', input));
    expect(input).toEqual(copy);
  });
});

// ── Hostile input (rejected) ─────────────────────────────────────────────────────────────────────────────────────

describe('rejects oversized values', () => {
  it('strings', () => {
    rejected(evt('tab.title', { tabId: 1, title: 'x'.repeat(LIMITS.maxTitleLength + 1) }));
    ok(evt('tab.title', { tabId: 1, title: 'x'.repeat(LIMITS.maxTitleLength) }));
    rejected(evt('tab.error', { ...EVENTS['tab.error'], detail: 'x'.repeat(301) }));
    rejected(evt('log', { level: 'info', message: 'x'.repeat(501) }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], url: `https://example.com/${'a'.repeat(LIMITS.maxUrlLength)}` }));
    rejected(validateCommandPayload('tab.find', { tabId: 1, query: 'q'.repeat(513), backwards: false, caseSensitive: false }));
    rejected(validateCommandResult('suggest', { items: ['x'.repeat(257)] }));
  });

  it("tab.create's url start takes an optional http(s) opener (a tab a page asked for), and only that", () => {
    const base = { tabId: 2, active: true, engine: null, zoom: 1, permissions };
    const withOpener = ok(validateCommandPayload('tab.create', { ...base, start: { kind: 'url', url: 'https://victim.example/a', opener: 'https://attacker.example/p?q=1' } }));
    expect(withOpener.start).toEqual({ kind: 'url', url: 'https://victim.example/a', opener: 'https://attacker.example/p?q=1' });
    const without = ok(validateCommandPayload('tab.create', { ...base, start: { kind: 'url', url: 'https://victim.example/a' } }));
    expect(without.start).toEqual({ kind: 'url', url: 'https://victim.example/a' });
    expect('opener' in without.start).toBe(false);
    for (const opener of ['javascript:alert(1)', 'blob:https://a.example/x', '/relative', '', null, 7, 'x'.repeat(9000)]) {
      rejected(validateCommandPayload('tab.create', { ...base, start: { kind: 'url', url: 'https://victim.example/a', opener } }));
    }
    // Only the url start knows an opener: restore and blank drop it like any unknown key.
    const r = ok(validateCommandPayload('tab.create', { ...base, start: { kind: 'restore', entries: ['https://a.example/'], index: 0, opener: 'https://b.example/' } }));
    expect('opener' in r.start).toBe(false);
  });

  it('arrays and records', () => {
    rejected(validateCommandResult('suggest', { items: Array.from({ length: 11 }, (_, i) => `s${i}`) }));
    const perSite: Record<string, object> = {};
    for (let i = 0; i <= LIMITS.maxSiteRules; i++) perSite[`s${i}.example`] = { adblock: false };
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, perSite } }));
    rejected(validateEngineSettings({ ...settings(), keys: { combos: Array.from({ length: 65 }, (_, i) => `Alt+F${i}`), apple: false } }));
    rejected(validateCommandPayload('tab.create', {
      ...COMMANDS['tab.create'].payload,
      start: { kind: 'restore', entries: Array.from({ length: 51 }, (_, i) => `https://e.example/${i}`), index: 0 },
    }));
  });

  it('favicons over 64 KiB', () => {
    const big = `data:image/png;base64,${'A'.repeat(Math.ceil(65_537 / 3) * 4)}`;
    expect(big.length).toBeLessThanOrEqual(FAVICON_MAX_CHARS + 4);
    expect(rejected(evt('tab.favicon', { tabId: 1, icon: big }))).toMatch(/64 KiB/);
    ok(evt('tab.favicon', { tabId: 1, icon: `data:image/png;base64,${'A'.repeat(Math.floor(65_536 / 3) * 4)}` }));
    rejected(evt('tab.favicon', { tabId: 1, icon: 'x'.repeat(FAVICON_MAX_CHARS + 1) }));
  });
});

describe('rejects URLs that are not http(s) where one is required', () => {
  const bad = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://example.com/x', 'file:///etc/passwd', '/relative', 'about:blank', 'chrome://settings', ''];
  for (const url of bad) {
    it(JSON.stringify(url).slice(0, 40), () => {
      rejected(evt('tab.committed', { ...EVENTS['tab.committed'], url }));
      rejected(evt('tab.openRequest', { ...EVENTS['tab.openRequest'], url }));
      rejected(evt('download.started', { ...EVENTS['download.started'], url }));
      rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: { ...EVENTS['tab.contextMenu'].target, linkUrl: url } }));
      rejected(validateCommandPayload('tab.navigate', { tabId: 1, url, engine: null }));
      rejected(validateCommandPayload('vpn.verify', { url }));
    });
  }

  it('favicons that are not base64 data:image URLs', () => {
    for (const icon of [
      'https://example.com/favicon.ico',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,rawbytes',
      'data:image/png;base64,***',
      'data:image/png;base64,QUJD=',
      'data:image/svg+xml;utf8,<svg/>',
      'javascript:alert(1)',
    ]) {
      rejected(evt('tab.favicon', { tabId: 1, icon }));
    }
  });

  it('Wisp tickets and custom servers', () => {
    rejected(validateCommandPayload('ticket', { ...ticket, wispUrl: 'https://p.gnome.example/wisp/' }));
    rejected(validateCommandPayload('ticket', { ...ticket, value: 'w1.1/2' }));
    rejected(validateCommandPayload('ticket', { ...ticket, value: 'w1.x&t=y' }));
    for (const server of ['https://wisp.example/', 'wss://u:p@wisp.example/', '/../admin/', '/wisp/./x', 'wisp/', 'wss://']) {
      rejected(validateEngineSettings({ ...settings(), route: { kind: 'custom', servers: [server] } }));
    }
    rejected(validateEngineSettings({ ...settings(), route: { kind: 'custom', servers: [] } }));
    rejected(validateEngineSettings({ ...settings(), route: { kind: 'profile', id: '../x' } }));
  });
});

describe('rejects wrong enums and types', () => {
  it('enum values', () => {
    rejected(evt('tab.error', { ...EVENTS['tab.error'], kind: 'dns' }));
    rejected(evt('tab.error', { ...EVENTS['tab.error'], kind: 'tls' }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], engine: 'chrome' }));
    rejected(evt('tab.openRequest', { ...EVENTS['tab.openRequest'], disposition: 'window' }));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: { ...EVENTS['tab.contextMenu'].target, kind: 'video' } }));
    rejected(evt('needTicket', { reason: 'please' }));
    rejected(evt('status', { ...status(), transport: { ...status().transport, scramjet: { ...transport, detail: 'unknown' } } }));
    ok(evt('status', { ...status(), transport: { ...status().transport, scramjet: { ...transport, state: 'offline', detail: 'upstream-unreachable', retryInMs: 500 } } }));
    rejected(validateEngineSettings({ ...settings(), privacy: { ...settings().privacy, webrtc: 'proxy' } }));
    rejected(validateCommandPayload('suggest', { query: 'x', provider: 'custom' }));
    rejected(validateCommandResult('init', { ...COMMANDS.init.result, capabilities: ['zoom', 'root'] }));
  });

  it('numbers: NaN, Infinity, fractions, out of range, strings', () => {
    for (const tabId of [Number.NaN, Infinity, -Infinity, 1.5, 0, -1, LIMITS.maxTabId + 1, '1', null, true]) {
      rejected(evt('tab.loading', { tabId, loading: true }));
    }
    for (const factor of [Number.NaN, Infinity, 0.2, 5.01, '1']) rejected(validateCommandPayload('tab.zoom', { tabId: 1, factor }));
    for (const delta of [0, 51, -51, 0.5]) rejected(validateCommandPayload('tab.go', { tabId: 1, delta }));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], x: 40_000 }));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], y: Number.NaN }));
    rejected(evt('download.progress', { downloadId: 'sj-1', received: -1, total: null }));
    rejected(evt('tab.loaded', { ...EVENTS['tab.loaded'], ms: LIMITS.maxDurationMs + 1 }));
  });

  it('missing keys, undefined instead of null, wrong containers', () => {
    const { navId: _navId, ...noNav } = EVENTS['tab.committed'];
    rejected(evt('tab.committed', noNav));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: { ...EVENTS['tab.contextMenu'].target, srcUrl: undefined } }));
    rejected(evt('tab.title', ['tabId', 1]));
    rejected(evt('tab.title', null));
    rejected(evt('tab.title', 'title'));
    rejected(validateCommandResult('suggest', { items: 'gnome' }));
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, cookieRules: [] } }));
    rejected(validateCommandPayload('tab.navigate', { tabId: 1, url: 'https://e.example/', engine: null }));
    rejected(validateCommandPayload('tab.reload', { tabId: 1, permissions: { autoplay: 'block', fullscreen: 'allow' } }));
    rejected(validateCommandPayload('tab.go', { tabId: 1, delta: 1, permissions: { ...permissions, clipboard: 'ask' } }));
  });

  it('identifiers, combos, MIME types and file names', () => {
    rejected(evt('tab.key', { tabId: 1, combo: 'Alt T', repeat: false }));
    rejected(evt('tab.key', { tabId: 1, combo: 'x'.repeat(LIMITS.maxComboLength + 1), repeat: false }));
    ok(evt('tab.key', { tabId: 1, combo: 'Mod+Ctrl+Meta+Alt+Shift+ContextMenu', repeat: false }));
    rejected(evt('download.progress', { downloadId: '../../x', received: 1, total: null }));
    rejected(evt('download.started', { ...EVENTS['download.started'], mime: 'text/html; charset=utf-8' }));
    rejected(evt('download.started', { ...EVENTS['download.started'], mime: 'Text/HTML' }));
    for (const filename of ['../evil.exe', 'dir/file', 'C:\\x', '..', '', '\u0000', '   ']) {
      rejected(evt('download.started', { ...EVENTS['download.started'], filename }));
    }
    rejected(validateEngineSettings({ ...settings(), keys: { combos: ['Alt+T', 'Alt+T'], apple: false } }));
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, allowlist: ['not a host'] } }));
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, lists: [{ ...settings().extensions.lists[0], sha256: 'A'.repeat(64) }] } }));
  });

  it('cross-field rules', () => {
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'same-document' }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], ms: null }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], historyHandling: 'traverse' }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'reload', historyHandling: 'push' }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], kind: 'history', historyHandling: 'replace' }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], index: 1, length: 1, canGoBack: true }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], index: 1, length: 2, canGoBack: false }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], index: 0, length: 2, canGoForward: false }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], index: LIMITS.maxTabHistory, length: LIMITS.maxTabHistory, canGoBack: true }));
    rejected(evt('tab.committed', { ...EVENTS['tab.committed'], length: LIMITS.maxTabHistory + 1, canGoForward: true }));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: { ...EVENTS['tab.contextMenu'].target, selectionTruncated: true } }));
    rejected(validateCommandResult('tab.state', { ...COMMANDS['tab.state'].result, index: 2 }));
    rejected(validateCommandResult('tab.state', { ...COMMANDS['tab.state'].result, entries: [], index: 1 }));
    rejected(validateCommandResult('tab.state', { ...COMMANDS['tab.state'].result, entries: ['javascript:alert(1)'], index: 0 }));
    rejected(evt('tab.engineSwitched', { ...EVENTS['tab.engineSwitched'], to: 'scramjet' }));
    rejected(validateCommandResult('tab.find', { matches: 2, active: 3, highlights: true, capped: false }));
    rejected(validateCommandResult('tab.find', { matches: 2, active: 0, highlights: true, capped: false }));
    rejected(validateCommandResult('tab.create', { navId: 3, engine: null }));
    rejected(validateCommandPayload('tab.create', { ...COMMANDS['tab.create'].payload, start: { kind: 'restore', entries: ['https://a.example/'], index: 1 } }));
    rejected(validateCommandPayload('cookies.delete', { all: true, site: 'example.com', name: null }));
    rejected(validateCommandPayload('cookies.delete', { all: false, site: null, name: 'sid' }));
    rejected(validateCommandPayload('siteData.clear', { kinds: [] }));
    rejected(validateCommandPayload('siteData.clear', { kinds: ['cookies', 'cookies'] }));
  });
});

describe('rejects prototype-pollution keys and exotic objects', () => {
  it('__proto__, constructor and prototype at any validated level', () => {
    rejected(evt('tab.title', withKey(EVENTS['tab.title'], '{"__proto__": {"polluted": true}}')));
    rejected(evt('tab.title', withKey(EVENTS['tab.title'], '{"constructor": {"prototype": {}}}')));
    rejected(evt('tab.title', withKey(EVENTS['tab.title'], '{"prototype": 1}')));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: withKey(EVENTS['tab.contextMenu'].target, '{"__proto__": {}}') }));
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, perSite: JSON.parse('{"__proto__": {"adblock": false}}') } }));
    rejected(validateEngineSettings({ ...settings(), extensions: { ...settings().extensions, cookieRules: JSON.parse('{"constructor": "allow"}') } }));
    rejected(validateEventMessage(JSON.parse('{"k": "evt", "type": "tab.title", "p": {"tabId": 1, "title": "x"}, "__proto__": {"x": 1}}')));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accessor properties, class instances, Maps, Dates and arrays where objects belong', () => {
    const getter = Object.defineProperty({ tabId: 1 }, 'title', { get: () => 'x', enumerable: true });
    rejected(evt('tab.title', getter));
    class Payload {
      tabId = 1;
      title = 'x';
    }
    rejected(evt('tab.title', new Payload()));
    rejected(evt('tab.title', new Map([['tabId', 1]])));
    rejected(evt('needTicket', new Date()));
    rejected(evt('tab.title', Object.assign([], { tabId: 1, title: 'x' })));
    rejected(evt('tab.title', { tabId: new Number(1), title: 'x' }));
    rejected(evt('tab.title', { tabId: 1, title: new String('x') }));
  });

  it('objects with too many keys', () => {
    const p: Record<string, unknown> = { tabId: 1, title: 'x' };
    for (let i = 0; i < LIMITS.maxObjectKeys; i++) p[`k${i}`] = i;
    rejected(evt('tab.title', p));
  });
});

// ── Envelopes and handshake ──────────────────────────────────────────────────────────────────────────────────────

describe('envelopes', () => {
  it('commands: unknown types keep the id so the engine host can answer unknown_type', () => {
    const r = validateCommandMessage({ k: 'cmd', id: 9, type: 'test.setFault', p: {} });
    expect(r).toMatchObject({ ok: false, code: 'unknown_type', id: 9 });
    expect(validateCommandMessage({ k: 'cmd', id: 10, type: 'tab.close', p: { tabId: 'x' } })).toMatchObject({ ok: false, code: 'invalid', id: 10 });
    const noId = validateCommandMessage({ k: 'cmd', id: 0, type: 'tab.close', p: { tabId: 1 } });
    expect(noId.ok).toBe(false);
    expect('id' in noId).toBe(false);
    rejected(validateCommandMessage({ k: 'evt', id: 1, type: 'tab.close', p: { tabId: 1 } }));
    rejected(validateCommandMessage({ k: 'cmd', id: 1, type: 'tab.close' }));
    rejected(validateCommandMessage(null));
  });

  it('events: unknown types are "unknown_type" (ignored), invalid ones "invalid"', () => {
    expect(validateEventMessage({ k: 'evt', type: 'tab.newThing', p: {} })).toMatchObject({ ok: false, code: 'unknown_type' });
    expect(validateEventMessage({ k: 'evt', type: 'tab.title', p: { tabId: 1 } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(validateEventMessage({ k: 'evt', type: 'x'.repeat(41), p: {} })).toMatchObject({ ok: false, code: 'invalid' });
    rejected(validateEventMessage({ k: 'res', type: 'tab.title', p: EVENTS['tab.title'] }));
  });

  it('results', () => {
    rejected(validateResultMessage({ k: 'res', id: 1, ok: true }));
    rejected(validateResultMessage({ k: 'res', id: 1, ok: false }));
    rejected(validateResultMessage({ k: 'res', id: 1, ok: 'yes', p: {} }));
    rejected(validateResultMessage({ k: 'res', id: -1, ok: true, p: {} }));
  });

  it('hello, connect and mismatch', () => {
    const hello = { gnome: 'hello', protocol: PROTOCOL_VERSION, build: '0.1.0+abc', instance: 'abcd1234efgh' };
    expect(ok(validateHello(hello))).toEqual(hello);
    rejected(validateHello({ ...hello, instance: 'short' }));
    rejected(validateHello({ ...hello, build: 'has space' }));
    rejected(validateHello({ ...hello, protocol: 1.5 }));
    ok(validateConnect({ gnome: 'connect', protocol: 1, instance: 'abcd1234efgh' }));
    ok(validateMismatch({ gnome: 'mismatch', protocol: 2, instance: 'abcd1234efgh' }));
    rejected(validateConnect({ gnome: 'hello', protocol: 1, instance: 'abcd1234efgh' }));
  });
});

describe('decideHello (app)', () => {
  const frame = { name: 'engine iframe window' };
  const proxyOrigin = 'https://p.gnome.example';
  const hello = { gnome: 'hello', protocol: PROTOCOL_VERSION, build: '0.1.0', instance: 'aaaa1111bbbb' };
  const ctx = { expectedSource: frame, proxyOrigin, expecting: true, connectedInstance: null };
  const from = (data: unknown, source: unknown = frame, origin = proxyOrigin) => ({ source, origin, data });

  it('connects to the first valid hello it expects', () => {
    expect(decideHello(from(hello), ctx)).toEqual({ action: 'connect', hello });
  });

  it('ignores hellos from other windows, other origins and malformed ones', () => {
    expect(decideHello(from(hello, { other: true }), ctx)).toEqual({ action: 'ignore', reason: 'source' });
    expect(decideHello(from(hello, null), { ...ctx, expectedSource: null })).toEqual({ action: 'ignore', reason: 'source' });
    expect(decideHello(from(hello, frame, 'https://gnome.example'), ctx)).toEqual({ action: 'ignore', reason: 'origin' });
    expect(decideHello(from({ ...hello, instance: 'x' }), ctx)).toEqual({ action: 'ignore', reason: 'invalid' });
  });

  it('treats a hello it did not ask for as a compromise signal, but not repeats of the connected instance', () => {
    const connected = { ...ctx, expecting: false, connectedInstance: hello.instance };
    expect(decideHello(from(hello), connected)).toEqual({ action: 'ignore', reason: 'duplicate' });
    const forged = { ...hello, instance: 'cccc2222dddd' };
    expect(decideHello(from(forged), connected)).toEqual({ action: 'unexpected', hello: forged });
  });

  it('connects a late first hello: the hello timeout does not end expecting (HelloContext.expecting)', () => {
    // After TIMEOUTS.helloWaitMs the app shows "did not start" but, never having connected that iframe, still
    // expects its hello. decideHello takes no clock: what the app passes decides.
    const late = { ...ctx, expecting: true, connectedInstance: null };
    expect(decideHello(from(hello), late)).toEqual({ action: 'connect', hello });
    // Once a hello was accepted the window is closed: another instance's hello is a compromise signal.
    expect(decideHello(from({ ...hello, instance: 'eeee3333ffff' }), { ...late, expecting: false, connectedInstance: hello.instance }).action).toBe('unexpected');
  });

  it('reports a protocol mismatch', () => {
    const v2 = { ...hello, protocol: PROTOCOL_VERSION + 1 };
    expect(decideHello(from(v2), ctx)).toEqual({ action: 'mismatch', hello: v2 });
  });
});

describe('decideConnect (engine host)', () => {
  const parent = { name: 'app window' };
  const ctx = { parent, appOrigins: ['https://gnome.example'], instance: 'aaaa1111bbbb', connected: false };
  const connect = { gnome: 'connect', protocol: PROTOCOL_VERSION, instance: 'aaaa1111bbbb' };
  const from = (data: unknown, opts: { source?: unknown; origin?: string; ports?: unknown[] } = {}) => ({
    source: 'source' in opts ? opts.source : parent,
    origin: opts.origin ?? 'https://gnome.example',
    data,
    ports: opts.ports ?? [{ port: 1 }],
  });

  it('accepts one connect from the parent at an allowed app origin', () => {
    expect(decideConnect(from(connect), ctx)).toEqual({ action: 'accept' });
    expect(decideConnect(from(connect), { ...ctx, connected: true })).toEqual({ action: 'ignore', reason: 'connected' });
  });

  it('ignores other sources, origins and instances', () => {
    expect(decideConnect(from(connect, { source: { child: true } }), ctx)).toEqual({ action: 'ignore', reason: 'source' });
    expect(decideConnect(from(connect, { origin: 'https://p.gnome.example' }), ctx)).toEqual({ action: 'ignore', reason: 'origin' });
    expect(decideConnect(from({ ...connect, instance: 'zzzz9999yyyy' }), ctx)).toEqual({ action: 'ignore', reason: 'instance' });
    expect(decideConnect(from({ gnome: 'connect' }), ctx)).toEqual({ action: 'ignore', reason: 'invalid' });
  });

  it('answers mismatch for another protocol version or a missing port', () => {
    expect(decideConnect(from({ ...connect, protocol: 99 }), ctx)).toEqual({ action: 'mismatch' });
    expect(decideConnect(from(connect, { ports: [] }), ctx)).toEqual({ action: 'mismatch' });
  });
});

// ── Runtime helpers ──────────────────────────────────────────────────────────────────────────────────────────────

describe('rate limits', () => {
  const key = (tabId: number): AnyEventMessage => ({ k: 'evt', type: 'tab.key', p: { tabId, combo: 'Alt+T', repeat: false } });

  it('drops events over the per-tab burst and refills over time, per tab', () => {
    const b = new TokenBuckets();
    const limit = EVENT_RATE_LIMITS['tab.key'];
    let admitted = 0;
    for (let i = 0; i < limit.burst + 10; i++) if (admitEvent(b, key(1), 1000)) admitted++;
    expect(admitted).toBe(limit.burst);
    expect(admitEvent(b, key(2), 1000)).toBe(true);
    expect(admitEvent(b, key(1), 1000 + 1000 / limit.perSecond)).toBe(true);
    expect(admitEvent(b, key(1), 1000 + 1000 / limit.perSecond)).toBe(false);
  });

  it('applies the port-wide flood limit before the per-type buckets', () => {
    const b = new TokenBuckets();
    let admitted = 0;
    for (let tab = 1; tab <= EVENT_FLOOD_LIMIT.burst + 50; tab++) if (admitEvent(b, key(tab), 5000)) admitted++;
    expect(admitted).toBe(EVENT_FLOOD_LIMIT.burst);
  });

  it('scopes downloads by id, popups by opener and forgets closed tabs', () => {
    const b = new TokenBuckets();
    const open: AnyEventMessage = { k: 'evt', type: 'tab.openRequest', p: { ...EVENTS['tab.openRequest'] } };
    for (let i = 0; i < 3; i++) expect(admitEvent(b, open, 0)).toBe(true);
    expect(admitEvent(b, open, 0)).toBe(false);
    b.forget('tab:1');
    expect(admitEvent(b, open, 0)).toBe(true);
    const done = (downloadId: string): AnyEventMessage => ({ k: 'evt', type: 'download.done', p: { downloadId, state: 'completed', received: 1, error: null } });
    expect(admitEvent(b, done('a'), 0) && admitEvent(b, done('a'), 0)).toBe(true);
    expect(admitEvent(b, done('a'), 0)).toBe(false);
    expect(admitEvent(b, done('b'), 0)).toBe(true);
  });

  it('bounds the number of buckets', () => {
    const b = new TokenBuckets(10);
    for (let i = 0; i < 100; i++) b.take(`k${i}`, { burst: 1, perSecond: 1 }, 0);
    expect(b.size).toBe(10);
  });
});

describe('ticket renewal', () => {
  it('renews at 80 % of the remaining life', () => {
    expect(ticketRenewDelayMs(0, 3_600_000)).toBe(2_880_000);
    expect(ticketRenewDelayMs(0, 60_000)).toBe(48_000);
    expect(ticketRenewDelayMs(1000, 26_000)).toBe(20_000);
    expect(TICKET.renewAtFraction).toBe(0.8);
  });

  it('never renews sooner than the floor, also for expired tickets, and clamps very long lives to the timer maximum', () => {
    expect(ticketRenewDelayMs(5000, 5000)).toBe(TICKET.minRenewDelayMs);
    expect(ticketRenewDelayMs(5000, 1000)).toBe(TICKET.minRenewDelayMs);
    expect(ticketRenewDelayMs(0, Number.NaN)).toBe(TICKET.minRenewDelayMs);
    expect(ticketRenewDelayMs(0, 5000)).toBe(TICKET.minRenewDelayMs);
    expect(ticketRenewDelayMs(0, 7 * 24 * 3_600_000)).toBe(483_840_000);
    expect(ticketRenewDelayMs(0, 60 * 24 * 3_600_000)).toBe(2 ** 31 - 1);
  });

  it('measures the life against the server clock, so device clock skew changes nothing', () => {
    const serverNow = Date.UTC(2026, 10, 11, 20, 0, 0);
    const date = new Date(serverNow).toUTCString();
    const expiresAt = serverNow + 3_600_000;
    const ttl = 3_600_000;
    for (const skew of [0, 2 * 3_600_000, -2 * 3_600_000, 61_000, -61_000]) {
      const local = serverNow + skew;
      const at = ticketExpiresAtLocal(expiresAt, date, local, ttl);
      expect(at - local).toBe(3_600_000 - TICKET.clockMarginMs);
      expect(ticketRenewDelayMs(local, at)).toBe(Math.floor((3_600_000 - TICKET.clockMarginMs) * 0.8));
    }
    // A 60 s TTL with the device a minute ahead still renews after ~47 s, not at once in a loop.
    const fast = serverNow + 61_000;
    expect(ticketRenewDelayMs(fast, ticketExpiresAtLocal(serverNow + 60_000, date, fast, 60_000))).toBe(47_200);
  });

  it('caps the life at the configured TTL and falls back to the local clock without a Date header', () => {
    const now = 1_762_900_000_000;
    expect(ticketExpiresAtLocal(now + 7 * 86_400_000, new Date(now).toUTCString(), now, 3_600_000)).toBe(now + 3_600_000);
    expect(ticketExpiresAtLocal(now + 600_000, null, now, 3_600_000)).toBe(now + 600_000);
    expect(ticketExpiresAtLocal(now + 600_000, 'not a date', now, 3_600_000)).toBe(now + 600_000);
    expect(ticketExpiresAtLocal(now - 5000, null, now, 3_600_000)).toBe(now);
    expect(ticketExpiresAtLocal(Number.NaN, null, now, 3_600_000)).toBe(now);
  });
});

describe('normalization helpers for the engine host', () => {
  it('fitText cuts to the limit with an ellipsis and never splits a surrogate pair', () => {
    expect(fitText('short', 10)).toBe('short');
    expect(fitText('abcdefghij', 5)).toBe('abcd\u2026');
    expect(fitText('abc\u{1F600}def', 5)).toBe('abc\u2026');
    expect(fitText('abc\u{1F600}def', 6)).toBe('abc\u{1F600}\u2026');
    expect(fitText('x', 0)).toBe('');
    const title = fitText('t'.repeat(5000), LIMITS.maxTitleLength);
    expect(title).toHaveLength(LIMITS.maxTitleLength);
    ok(evt('tab.title', { tabId: 1, title }));
  });

  it('fitInt rounds and clamps measured numbers so the validators accept them', () => {
    expect(fitInt(495.6, -32_768, 32_767)).toBe(496);
    expect(fitInt(-1e9, -32_768, 32_767)).toBe(-32_768);
    expect(fitInt(Number.NaN, 0, 10)).toBe(0);
    expect(fitInt(Infinity, 0, LIMITS.maxDurationMs)).toBe(LIMITS.maxDurationMs);
    ok(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], x: fitInt(12.25 * 1.5, -32_768, 32_767), y: fitInt(-0.4, -32_768, 32_767) }));
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], x: 12.5 }));
  });

  it('accepts a selection up to the raised limit and flags longer ones as truncated', () => {
    const sel = fitText('s'.repeat(LIMITS.maxSelectionLength + 10), LIMITS.maxSelectionLength);
    const target = { kind: 'selection', linkUrl: null, srcUrl: null, selectionText: sel, selectionTruncated: true, editable: false };
    expect(ok(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target })).target.selectionTruncated).toBe(true);
    rejected(evt('tab.contextMenu', { ...EVENTS['tab.contextMenu'], target: { ...target, selectionText: 's'.repeat(LIMITS.maxSelectionLength + 1) } }));
  });
});

describe('coalescing and forwarded-shortcut limits', () => {
  it('coalesces latest-value events at no more than half the app bucket rate', () => {
    for (const [type, ms] of Object.entries(COALESCE_MS)) {
      const limit = EVENT_RATE_LIMITS[type as EventType];
      expect(1000 / ms).toBeLessThanOrEqual(limit.perSecond / 2);
    }
    expect(FORWARDED_PRIVILEGED_LIMIT.perSecond).toBeLessThanOrEqual(1);
  });

  it('lists every transport detail, including unknown-profile', () => {
    expect(TRANSPORT_DETAILS).toContain('unknown-profile');
    expect(new Set(TRANSPORT_DETAILS).size).toBe(TRANSPORT_DETAILS.length);
    ok(evt('status', { ...status(), transport: { ...status().transport, ultraviolet: { ...transport, state: 'offline', detail: 'unknown-profile' } } }));
  });

  it('allows the documented history handling per commit kind', () => {
    expect(HISTORY_HANDLING_FOR_KIND).toEqual({
      navigate: ['push', 'replace'],
      reload: ['replace'],
      history: ['traverse'],
      'same-document': ['push', 'replace', 'traverse'],
    });
  });

  it('gives the app watchdog more time than the engine host navigation timeout', () => {
    expect(TIMEOUTS.navigationWatchdogMs).toBeGreaterThan(TIMEOUTS.navigationMs);
    expect(TIMEOUTS.downloadCommitMs).toBeLessThan(TIMEOUTS.navigationMs);
    expect(commandTimeoutMs('tab.state')).toBe(TIMEOUTS.statusMs);
  });
});

describe('snapshot helpers', () => {
  it('isWispServer agrees with the route validator', () => {
    for (const s of ['wss://wisp.example.org/', '/wisp/', 'ws://127.0.0.1:6001/', '/wisp/p/se-got/']) {
      expect(isWispServer(s)).toBe(true);
      ok(validateEngineSettings({ ...settings(), route: { kind: 'custom', servers: [s] } }));
    }
    for (const s of ['wss://u:p@wisp.example/', '/wisp/?x', '/a/../b/', 'https://wisp.example/', '', 'wss://']) {
      expect(isWispServer(s)).toBe(false);
      rejected(validateEngineSettings({ ...settings(), route: { kind: 'custom', servers: [s] } }));
    }
  });

  it('isCombo agrees with the keys validator', () => {
    for (const c of ['Alt+T', 'Mod+Shift+ArrowLeft', 'Alt+,', 'Mod+Ctrl+Meta+Alt+Shift+ContextMenu']) {
      expect(isCombo(c)).toBe(true);
      ok(validateEngineSettings({ ...settings(), keys: { combos: [c], apple: true } }));
    }
    for (const c of ['', 'Alt T', 'x'.repeat(LIMITS.maxComboLength + 1)]) expect(isCombo(c)).toBe(false);
  });

  it('engineChoice maps browser.engine and the server default', () => {
    const both = { scramjet: true, ultraviolet: true };
    expect(engineChoice('auto', 'scramjet', both)).toBe('auto');
    expect(engineChoice('auto', 'ultraviolet', both)).toBe('ultraviolet');
    expect(engineChoice('scramjet', 'ultraviolet', both)).toBe('scramjet');
    expect(engineChoice('scramjet', 'scramjet', { scramjet: false, ultraviolet: true })).toBe('ultraviolet');
    expect(engineChoice('auto', 'ultraviolet', { scramjet: true, ultraviolet: false })).toBe('scramjet');
  });
});

describe('capabilities', () => {
  it('maps optional commands to the capability they need', () => {
    expect(requiredCapability('tab.zoom', { tabId: 1, factor: 1 })).toBe('zoom');
    expect(requiredCapability('tab.action', { tabId: 1, action: 'selectAll' })).toBe('selectAll');
    expect(requiredCapability('tab.download', { tabId: 1, url: 'https://e.example/', kind: 'image' })).toBe('saveImage');
    expect(requiredCapability('cookies.delete', { all: true, site: null, name: null })).toBe('cookies');
    expect(requiredCapability('vpn.verify', { url: 'https://am.i.mullvad.net/json' })).toBe('vpnVerify');
    expect(requiredCapability('tab.find', { tabId: 1, query: 'x', backwards: false, caseSensitive: false })).toBeNull();
    expect(requiredCapability('tab.navigate', { tabId: 1, url: 'https://e.example/', engine: null, permissions })).toBeNull();
    expect(requiredCapability('tab.state', { tabId: 1 })).toBeNull();
    expect(CAPABILITIES).not.toContain('permissions');
    expect(requiredCapability('blocker.stats', {})).toBe('blocker');
    expect(requiredCapability('blocker.reload', {})).toBe('blocker');
    expect(commandTimeoutMs('blocker.stats')).toBe(TIMEOUTS.commandMs);
  });
});

// ── Wave B step 3 contract additions (WAVE-B3 §3.1 C1–C12) ─────────────────────────────────────────────────────

describe('content-blocker contract (WAVE-B3 C1–C12)', () => {
  const statsResult = (): CommandResult<'blocker.stats'> => structuredClone(COMMANDS['blocker.stats'].result);

  it('settings snapshots without and with extensions.cacheLimitMB (16–8192, integers)', () => {
    const s = settings();
    expect(ok(validateEngineSettings(clone(s))).extensions).not.toHaveProperty('cacheLimitMB');
    for (const mb of [16, 256, 8192]) {
      const v = ok(validateEngineSettings({ ...s, extensions: { ...s.extensions, cacheLimitMB: mb } }));
      expect(v.extensions.cacheLimitMB).toBe(mb);
    }
    for (const mb of [15, 8193, 1.5, '256', null]) {
      rejected(validateEngineSettings({ ...s, extensions: { ...s.extensions, cacheLimitMB: mb } }));
    }
  });

  it('tab.loading takes a url only with loading: true, and only http(s)', () => {
    expect(ok(evt('tab.loading', { tabId: 1, loading: true, url: 'https://site-a.example/x' }))).toEqual({
      tabId: 1,
      loading: true,
      url: 'https://site-a.example/x',
    });
    expect(ok(evt('tab.loading', { tabId: 1, loading: false }))).toEqual({ tabId: 1, loading: false });
    rejected(evt('tab.loading', { tabId: 1, loading: false, url: 'https://site-a.example/' }));
    rejected(evt('tab.loading', { tabId: 1, loading: true, url: 'javascript:alert(1)' }));
    rejected(evt('tab.loading', { tabId: 1, loading: true, url: 'about:blank' }));
  });

  it('init without and with blockerKey (64 lower-case hex digits)', () => {
    const base = clone(COMMANDS.init.payload);
    expect(ok(validateCommandPayload('init', base))).not.toHaveProperty('blockerKey');
    const key = '0123456789abcdef'.repeat(4);
    expect(ok(validateCommandPayload('init', { ...base, blockerKey: key })).blockerKey).toBe(key);
    rejected(validateCommandPayload('init', { ...base, blockerKey: key.slice(1) }));
    rejected(validateCommandPayload('init', { ...base, blockerKey: key.toUpperCase() }));
    rejected(validateCommandPayload('init', { ...base, blockerKey: 7 }));
  });

  it('blocker.stats and blocker.reload round-trip through the command and result validators', () => {
    for (const type of ['blocker.stats', 'blocker.reload'] as const) {
      const c = COMMANDS[type];
      expect(ok(validateCommandMessage({ k: 'cmd', id: 3, type, p: {} }))).toEqual({ k: 'cmd', id: 3, type, p: {} });
      expect(ok(validateCommandResult(type, clone(c.result)))).toEqual(c.result);
      expect(ok(validateCommandPayload(type, { force: true }))).toEqual({});
      rejected(validateCommandPayload(type, null));
      rejected(validateCommandPayload(type, []));
    }
  });

  it('blocker.stats: 500 lists pass, 501 do not; unknown error codes, groups and states are rejected', () => {
    const list = (i: number) => ({ id: `list-${i}`, sha256: 'c'.repeat(64), state: 'compiled', error: null, rules: 1, dropped: 0 });
    ok(validateCommandResult('blocker.stats', { ...statsResult(), lists: Array.from({ length: 500 }, (_, i) => list(i)) }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), lists: Array.from({ length: 501 }, (_, i) => list(i)) }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), lists: [{ ...list(1), state: 'failed', error: 'Network error: boom' }] }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), lists: [{ ...list(1), state: 'partial' }] }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), engines: [{ group: 'social', bytes: 1, network: 1, cosmetic: 0, scriptlets: 0 }] }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), source: 'disk' }));
    rejected(validateCommandResult('blocker.stats', { ...statsResult(), engines: Array.from({ length: 7 }, () => ({ group: 'ads', bytes: 1, network: 1, cosmetic: 0, scriptlets: 0 })) }));
    ok(validateCommandResult('blocker.stats', { ...statsResult(), builtAt: null, buildMs: null, source: null, engines: [], lists: [], resources: null }));
  });

  it('diagnostics with and without the blocker counters', () => {
    const d = clone(diagnostics);
    expect(ok(validateCommandResult('diagnostics', d))).not.toHaveProperty('blocker');
    const blocker = { hookErrors: 2, wsBackstopBlocked: 1, wsBackstopSkipped: 3, announceWaits: 4, announceTimeouts: 0 };
    expect(ok(validateCommandResult('diagnostics', { ...d, blocker })).blocker).toEqual(blocker);
    rejected(validateCommandResult('diagnostics', { ...d, blocker: { ...blocker, hookErrors: -1 } }));
    rejected(validateCommandResult('diagnostics', { ...d, blocker: { hookErrors: 1 } }));
  });
});
