import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../lib/api';
import { validateEngineSettings } from '../../shared/engine-protocol';
import { createDefaultSettings } from '../../settings/defaults';
import type { Settings } from '../../settings/schema';
import { validateSettings } from '../../settings/validate';
import { SiteExposure } from '../../extensions/app/exposure';
import { filterListRefs, type ServerListing } from '../../extensions/app/lists';
import { buildEngineSettings, chooseRoute, NO_VPN_LOCATION, shortcutCombos, type SnapshotContext } from './snapshot';

const config = (over: Partial<ServerConfig['wisp']> = {}, engines: Partial<ServerConfig['engines']> = {}): ServerConfig => ({
  version: '0.1.0',
  access_mode: 'open',
  registration: 'closed',
  features: { accounts: false, sync: false, games: false, vpn_gateway: true, thumb_proxy: false },
  wisp: {
    path: '/wisp/',
    ticket_ttl_s: 3600,
    profiles: [{ id: 'se-got', label: 'Sweden', country_code: 'se', city: 'Gothenburg', path: '/wisp/p/se-got/' }],
    custom_servers: false,
    ...over,
  },
  engines: { default: 'scramjet', scramjet: true, ultraviolet: true, ...engines },
  proxy: { origin: 'http://127.0.0.1:28002', isolated: true },
  source_url: null,
  limits: { max_ws_per_session: 16 },
});

const LISTING: ServerListing = {
  lists: (['ads', 'privacy', 'security', 'urlparams', 'cookies', 'annoyances'] as const).map((category, i) => ({
    id: `list-${category}`,
    name: category,
    category,
    format: 'abp' as const,
    license: 'GPL-3.0',
    homepage: 'https://example.org/',
    default_enabled: i % 2 === 0,
    trusted: false,
    available: true,
    size: 1,
    sha256: String(i).repeat(64),
    updated_at: null,
    fetched_at: null,
    version: null,
  })),
  resources: null,
};

const ctx = (over: Partial<SnapshotContext> = {}): SnapshotContext => ({ config: config(), blocker: false, apple: false, ...over });

function settingsWith(mut: (s: Settings) => void): Settings {
  const s = createDefaultSettings();
  mut(s);
  return validateSettings(s).settings;
}

describe('chooseRoute (ENGINE-PROTOCOL §4, §6.6)', () => {
  it('uses the default route without VPN or custom servers', () => {
    expect(chooseRoute(createDefaultSettings(), ctx()).route).toEqual({ kind: 'default' });
  });

  it('uses custom servers only when the operator allows them', () => {
    const s = settingsWith((x) => (x.browser.wispServers = ['wss://a.example/', '/wisp/alt/', 'wss://a.example/']));
    expect(chooseRoute(s, ctx())).toMatchObject({ route: { kind: 'default' }, customIgnored: 'operator' });
    expect(chooseRoute(s, ctx({ config: config({ custom_servers: true }) })).route).toEqual({ kind: 'custom', servers: ['wss://a.example/', '/wisp/alt/'] });
  });

  it('lets the VPN win over custom servers, and the kill switch never leaves the profile route', () => {
    const s = settingsWith((x) => {
      x.browser.wispServers = ['wss://a.example/'];
      x.vpn.mode = 'gateway';
      x.vpn.preferredLocation = 'se-got';
      x.vpn.killSwitch = true;
    });
    const c = ctx({ config: config({ custom_servers: true }), vpnStatus: { 'se-got': 'down' } });
    expect(chooseRoute(s, c)).toEqual({ route: { kind: 'profile', id: 'se-got' }, vpnFellBack: false, customIgnored: 'vpn', autoPicked: null });
    // Kill switch off and the location down: the default route, and the app says so.
    const off = settingsWith((x) => {
      x.vpn.mode = 'gateway';
      x.vpn.preferredLocation = 'se-got';
      x.vpn.killSwitch = false;
    });
    expect(chooseRoute(off, c)).toMatchObject({ route: { kind: 'default' }, vpnFellBack: true });
    expect(chooseRoute(off, ctx()).route).toEqual({ kind: 'profile', id: 'se-got' });
  });

  it('a chosen location the server no longer offers: the default route with the kill switch off, nothing with it on', () => {
    const gone = (killSwitch: boolean): Settings =>
      settingsWith((x) => {
        x.vpn.mode = 'gateway';
        x.vpn.preferredLocation = 'nl-ams';
        x.vpn.killSwitch = killSwitch;
      });
    // /api/config offers only se-got (e.g. refreshed after the engine host's `unknown-profile`).
    expect(chooseRoute(gone(false), ctx())).toMatchObject({ route: { kind: 'default' }, vpnFellBack: true });
    expect(chooseRoute(gone(true), ctx())).toMatchObject({ route: { kind: 'profile', id: 'nl-ams' }, vpnFellBack: false });
    // Before /api/config is known nothing says the location is gone.
    expect(chooseRoute(gone(false), ctx({ config: null })).route).toEqual({ kind: 'profile', id: 'nl-ams' });
  });

  it('with the kill switch on and no location at all, routes to a profile the server does not have (nothing loads)', () => {
    const s = settingsWith((x) => {
      x.vpn.mode = 'gateway';
      x.vpn.killSwitch = true;
    });
    expect(chooseRoute(s, ctx({ config: config({ profiles: [] }) })).route).toEqual({ kind: 'profile', id: NO_VPN_LOCATION });
    // Without a chosen location the first offered one is used.
    expect(chooseRoute(s, ctx()).route).toEqual({ kind: 'profile', id: 'se-got' });
  });

  it('Automatic (D17): the pinned one while not down, else the first one up, else the first offered; a chosen one is never replaced', () => {
    const three = config({ profiles: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }] } as Partial<ServerConfig['wisp']>);
    const auto = (killSwitch: boolean): Settings =>
      settingsWith((x) => {
        x.vpn.mode = 'gateway';
        x.vpn.preferredLocation = null;
        x.vpn.killSwitch = killSwitch;
      });
    for (const ks of [true, false]) {
      // First one up, skipping a down one.
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: { a: 'down', b: 'up', c: 'up' } }))).toMatchObject({ route: { kind: 'profile', id: 'b' }, autoPicked: 'b' });
      // Pinned and not down: kept, even when an earlier one is up again.
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: { a: 'up', b: 'up', c: 'up' }, autoPinned: 'c' })).route).toEqual({ kind: 'profile', id: 'c' });
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: { c: 'unknown' }, autoPinned: 'c' })).route).toEqual({ kind: 'profile', id: 'c' });
      // Pinned and down: moves to the first one up.
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: { a: 'down', b: 'up', c: 'down' }, autoPinned: 'c' }))).toMatchObject({ route: { kind: 'profile', id: 'b' }, autoPicked: 'b' });
      // Pinned but no longer offered: the first one up.
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: { b: 'up' }, autoPinned: 'gone' })).route).toEqual({ kind: 'profile', id: 'b' });
      // None up: the first offered (unknown statuses count as not up).
      expect(chooseRoute(auto(ks), ctx({ config: three, vpnStatus: {} })).route).toEqual({ kind: 'profile', id: 'a' });
    }
    // All down: the kill switch blocks on the first offered one; without it the default route.
    const down = { a: 'down', b: 'down', c: 'down' } as const;
    expect(chooseRoute(auto(true), ctx({ config: three, vpnStatus: down })).route).toEqual({ kind: 'profile', id: 'a' });
    expect(chooseRoute(auto(false), ctx({ config: three, vpnStatus: down }))).toMatchObject({ route: { kind: 'default' }, vpnFellBack: true, autoPicked: null });
    // A chosen location is never replaced by another one that is up.
    const chosen = (killSwitch: boolean): Settings =>
      settingsWith((x) => {
        x.vpn.mode = 'gateway';
        x.vpn.preferredLocation = 'a';
        x.vpn.killSwitch = killSwitch;
      });
    expect(chooseRoute(chosen(true), ctx({ config: three, vpnStatus: { a: 'down', b: 'up' }, autoPinned: 'b' }))).toMatchObject({ route: { kind: 'profile', id: 'a' }, autoPicked: null });
    expect(chooseRoute(chosen(false), ctx({ config: three, vpnStatus: { a: 'down', b: 'up' } }))).toMatchObject({ route: { kind: 'default' }, vpnFellBack: true });
  });
});

describe('buildEngineSettings', () => {
  it('forces WebRTC to block under the VPN kill switch', () => {
    const allow = settingsWith((x) => (x.privacy.webrtc = 'allow'));
    expect(buildEngineSettings(allow, ctx()).privacy.webrtc).toBe('allow');
    const locked = settingsWith((x) => {
      x.privacy.webrtc = 'allow';
      x.vpn.mode = 'gateway';
      x.vpn.killSwitch = true;
    });
    expect(buildEngineSettings(locked, ctx()).privacy.webrtc).toBe('block');
  });

  it('maps the engine with engineChoice and the operator default', () => {
    const s = createDefaultSettings();
    expect(buildEngineSettings(s, ctx()).engine).toBe('auto');
    expect(buildEngineSettings(s, ctx({ config: config({}, { default: 'ultraviolet' }) })).engine).toBe('ultraviolet');
    expect(buildEngineSettings(s, ctx({ config: config({}, { scramjet: false }) })).engine).toBe('ultraviolet');
  });

  it('sends the blocker site maps only after the blocker capability, scoped to exposed sites (WAVE-B3 D5)', () => {
    const s = settingsWith((x) => {
      x.extensions.allowlist = ['example.com', '*.other.example'];
      x.extensions.perSite = { 'news.example': { adblock: false }, '*.far.example': { cosmetic: false } };
      x.extensions.cookieRules = { 'shop.example': 'session' };
    });
    const scope = new SiteExposure();
    scope.expose('https://example.com/', 1, 'gnome-load', s.extensions);
    scope.expose('https://news.example/a', 1, 'gnome-load', s.extensions);
    const before = buildEngineSettings(s, ctx({ scope })).extensions;
    expect([before.allowlist, before.perSite, before.cookieRules]).toEqual([[], {}, {}]);
    // `blocker` without an exposure object: nothing (fail closed for privacy).
    expect(buildEngineSettings(s, ctx({ blocker: true })).extensions.allowlist).toEqual([]);
    const after = buildEngineSettings(s, ctx({ blocker: true, scope })).extensions;
    expect(after.allowlist).toEqual(['example.com']);
    expect(after.perSite).toEqual({ 'news.example': { adblock: false } });
    // Cookie rules travel whole, and only while the cookie manager is on.
    expect(after.cookieRules).toEqual({ 'shop.example': 'session' });
    const off = settingsWith((x) => {
      x.extensions.cookieRules = { 'shop.example': 'session' };
      x.extensions.enabled.cookies = false;
    });
    expect(buildEngineSettings(off, ctx({ blocker: true, scope })).extensions.cookieRules).toEqual({});
  });

  it('sends the filter-list refs always and the cache limit (WAVE-B3 §7.1)', () => {
    const lists = [{ id: 'easylist', sha256: 'a'.repeat(64), category: 'ads' as const, format: 'abp' as const, trusted: false }];
    const s = settingsWith((x) => (x.performance.cacheLimitMB = 16));
    const snap = buildEngineSettings(s, ctx({ lists }));
    expect(snap.extensions.lists).toEqual(lists);
    expect(snap.extensions.cacheLimitMB).toBe(16);
    expect(buildEngineSettings(createDefaultSettings(), ctx()).extensions).toMatchObject({ lists: [], cacheLimitMB: 256 });
  });

  it('sends each bound combo once, canonical', () => {
    const combos = shortcutCombos({ a: 'alt+t', b: 'Alt+T', c: '', d: 'Mod+K' });
    expect(combos).toEqual(['Alt+T', 'Mod+K']);
  });

  it('property: every settings value validate.ts accepts gives a snapshot validateEngineSettings accepts', () => {
    let seed = 0x9e3779b9;
    const rnd = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const junk: unknown[] = ['', 'x', 'auto', 'allow', 'block', 'gateway', true, false, 0, 1.5, -3, 1e9, null, [], {}, 'wss://w.example/', '/wisp/x/', 'Alt+Q', 'mod+shift+k', 'ctrl+alt+meta+shift+contextmenu', 'example.com', '*.example.org', '__proto__'];
    const leafPaths: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
        for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      } else leafPaths.push(path);
    };
    walk(createDefaultSettings(), '');
    const set = (o: Record<string, unknown>, path: string, value: unknown): void => {
      const parts = path.split('.');
      let cur = o;
      for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
      cur[parts.at(-1)!] = value;
    };
    const failures: string[] = [];
    for (let i = 0; i < 400; i++) {
      const raw = createDefaultSettings() as unknown as Record<string, unknown>;
      for (let j = 0; j < 25; j++) {
        const path = pick(leafPaths);
        let value: unknown = pick(junk);
        if (path === 'browser.wispServers' || path === 'extensions.allowlist') value = Array.from({ length: Math.floor(rnd() * 20) }, () => pick(junk));
        if (path === 'extensions.perSite' || path === 'extensions.cookieRules' || path === 'privacy.sitePermissions') {
          value = Object.fromEntries(Array.from({ length: Math.floor(rnd() * 8) }, () => [String(pick(junk)), pick([{ adblock: pick([true, false, 'x']) }, 'block', 'session', { popups: 'allow' }])]));
        }
        if (path.startsWith('browser.shortcuts.')) value = pick(['', 'Alt+T', 'Alt+Shift+T', 'mod+f', 'F6', 'nonsense+', 'Alt+T']);
        set(raw, path, value);
      }
      const s = validateSettings(raw).settings;
      // Every key of the maps exposed (the widest scope), and refs built from a listing.
      const scope = new SiteExposure();
      for (const k of [...s.extensions.allowlist, ...Object.keys(s.extensions.perSite)]) scope.expose(`https://${k.replace(/^\*\./, '')}/`, null, 'gnome-load', s.extensions);
      const lists = filterListRefs(LISTING, s);
      for (const blocker of [false, true]) {
        for (const custom of [false, true]) {
          const snap = buildEngineSettings(s, ctx({ blocker, scope, lists, config: config({ custom_servers: custom }) }));
          const v = validateEngineSettings(snap);
          if (!v.ok) failures.push(`${v.error} ← ${JSON.stringify(snap).slice(0, 300)}`);
        }
      }
      const noConfig = validateEngineSettings(buildEngineSettings(s, ctx({ config: null })));
      if (!noConfig.ok) failures.push(noConfig.error);
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });
});
