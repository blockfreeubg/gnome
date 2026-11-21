import { describe, expect, it } from 'vitest';
import { createDefaultSettings, DEFAULT_SETTINGS } from './defaults';
import { CURRENT_SETTINGS_VERSION, SETTINGS_SECTIONS, type Settings } from './schema';
import {
  deepEqual,
  deepMerge,
  DESIGN_V1_APPEARANCE,
  DESIGN_V2_APPEARANCE,
  EXPORT_FORMAT,
  MIGRATIONS,
  migrateDesignV2,
  exportSettings,
  loadSettings,
  migrateSettings,
  parseSettingsImport,
  RETIRED_KEYS,
  validateSection,
  validateSettings,
  type Migration,
} from './validate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('validateSettings', () => {
  it('accepts the defaults unchanged and without issues', () => {
    const { settings, issues } = validateSettings(createDefaultSettings());
    expect(issues).toEqual([]);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('fills every missing key from the defaults (deep merge)', () => {
    const { settings, issues } = validateSettings({
      version: CURRENT_SETTINGS_VERSION,
      appearance: { theme: 'light', homeBackground: { kind: 'color', value: '#223344' } },
      browser: { shortcuts: { newTab: 'Alt+N' } },
    });
    expect(issues).toEqual([]);
    expect(settings.appearance.theme).toBe('light');
    expect(settings.appearance.accentPreset).toBe(DEFAULT_SETTINGS.appearance.accentPreset);
    expect(settings.appearance.homeBackground).toEqual({ kind: 'color', value: '#223344', dim: 0.35, blur: 0 });
    expect(settings.browser.shortcuts.newTab).toBe('Alt+N');
    expect(settings.browser.shortcuts.closeTab).toBe('Alt+W');
    expect(settings.privacy).toEqual(DEFAULT_SETTINGS.privacy);
  });

  it('replaces invalid values with defaults and reports each one', () => {
    const { settings, issues } = validateSettings({
      version: CURRENT_SETTINGS_VERSION,
      appearance: { theme: 'neon', accent: 'red', fontFamily: 'comic-sans', sidebar: 42, reduceTransparency: 'yes' },
      browser: { customSearchUrl: 'https://no-placeholder.example/', homepage: 'javascript:alert(1)' },
    });
    expect(settings.appearance.theme).toBe('dark');
    expect(settings.appearance.accent).toBe(DEFAULT_SETTINGS.appearance.accent);
    expect(settings.appearance.fontFamily).toBe('inter');
    expect(settings.appearance.sidebar).toBe('compact');
    expect(settings.appearance.reduceTransparency).toBe(false);
    expect(settings.browser.customSearchUrl).toBe('');
    expect(settings.browser.homepage).toBe('gnome://home');
    expect(issues.map((i) => i.path).sort()).toEqual(
      [
        'appearance.accent',
        'appearance.fontFamily',
        'appearance.reduceTransparency',
        'appearance.sidebar',
        'appearance.theme',
        'browser.customSearchUrl',
        'browser.homepage',
      ].sort(),
    );
  });

  it('clamps and rounds numbers', () => {
    const { settings, issues } = validateSettings({
      version: CURRENT_SETTINGS_VERSION,
      appearance: { fontSize: 99, radius: -3, transparency: 0.123456, blur: 12.6 },
      browser: { defaultZoom: 7 },
    });
    expect(settings.appearance.fontSize).toBe(20);
    expect(settings.appearance.radius).toBe(0);
    expect(settings.appearance.transparency).toBe(0.55);
    expect(settings.appearance.blur).toBe(13);
    expect(settings.browser.defaultZoom).toBe(2);
    expect(issues.filter((i) => i.message.includes('clamped')).length).toBe(4);
    expect(validateSettings({ appearance: { fontSize: Number.NaN } }).settings.appearance.fontSize).toBe(14);
  });

  it('normalizes hex colors and shortcut combos', () => {
    const { settings } = validateSettings({
      appearance: { accentPreset: 'custom', accent: 'ABC', colors: { background: '#0A0B0C', text: null } },
      browser: { shortcuts: { newTab: 'shift+alt+n' } },
    });
    expect(settings.appearance.accent).toBe('#aabbcc');
    expect(settings.appearance.colors.background).toBe('#0a0b0c');
    expect(settings.appearance.colors.text).toBeNull();
    expect(settings.browser.shortcuts.newTab).toBe('Alt+Shift+N');
    expect(validateSettings({ browser: { shortcuts: { newTab: 'Alt+Hyper' } } }).settings.browser.shortcuts.newTab).toBe('Alt+T');
  });

  it('cleans arrays: invalid entries removed, duplicates dropped, length capped', () => {
    const { settings, issues } = validateSettings({
      browser: { wispServers: ['wss://w.example/wisp/', 'https://not-ws.example', '/wisp/', 'wss://w.example/wisp/'] },
      extensions: { allowlist: ['example.com', 'bad host!', 'sub.example.org'] },
      games: { hiddenCategories: Array.from({ length: 250 }, (_, i) => `cat-${i}`) },
    });
    expect(settings.browser.wispServers).toEqual(['wss://w.example/wisp/', '/wisp/']);
    expect(settings.extensions.allowlist).toEqual(['example.com', 'sub.example.org']);
    expect(settings.games.hiddenCategories).toHaveLength(200);
    expect(issues.some((i) => i.path === 'browser.wispServers.1')).toBe(true);
    expect(issues.some((i) => i.path === 'games.hiddenCategories' && i.message.includes('200'))).toBe(true);
  });

  it('validates host-keyed records and partial permission maps', () => {
    const { settings, issues } = validateSettings({
      privacy: {
        sitePermissions: {
          'example.com': { camera: 'allow', microphone: 'maybe', teleport: 'allow' },
          'not a host': { camera: 'block' },
          '[::1]:8080': { popups: 'allow' },
        },
      },
      extensions: { cookieRules: { 'example.com': 'session', 'x.org': 'sometimes' }, lists: { easylist: true, 'bad id!': true } },
    });
    expect(settings.privacy.sitePermissions).toEqual({ 'example.com': { camera: 'allow' }, '[::1]:8080': { popups: 'allow' } });
    expect(settings.extensions.cookieRules).toEqual({ 'example.com': 'session' });
    expect(settings.extensions.lists).toEqual({ easylist: true });
    expect(issues.length).toBeGreaterThanOrEqual(5);
  });

  it('cannot be used for prototype pollution', () => {
    const raw = JSON.parse(
      '{"version":1,"__proto__":{"polluted":true},"privacy":{"sitePermissions":{"__proto__":{"camera":"allow"},"constructor":{"camera":"allow"}}},"extensions":{"perSite":{"__proto__":{"adblock":false}}}}',
    ) as unknown;
    const { settings } = validateSettings(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(settings.privacy.sitePermissions)).toEqual([]);
    expect(Object.keys(settings.extensions.perSite)).toEqual([]);
    expect(Object.getPrototypeOf(settings.privacy.sitePermissions)).toBe(Object.prototype);
  });

  it('drops unknown keys and reports them', () => {
    const { settings, issues } = validateSettings({ version: CURRENT_SETTINGS_VERSION, appearance: { sparkles: true }, telemetry: { on: true } });
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(issues.map((i) => i.path).sort()).toEqual(['appearance.sparkles', 'telemetry']);
  });

  it('rejects non-object input with defaults', () => {
    for (const raw of [null, 42, 'settings', [1, 2]]) {
      expect(loadSettings(raw).settings).toEqual(DEFAULT_SETTINGS);
    }
  });
});

describe('retired keys', () => {
  it('lists games.playMode', () => {
    expect(RETIRED_KEYS.has('games.playMode')).toBe(true);
  });

  it('loads stored settings that still contain games.playMode cleanly', () => {
    const stored = { ...clone(DEFAULT_SETTINGS), games: { ...clone(DEFAULT_SETTINGS.games), playMode: 'proxied', view: 'list' } };
    const { settings, issues } = loadSettings(stored);
    expect(issues).toEqual([]);
    expect(settings.games.view).toBe('list');
    expect('playMode' in settings.games).toBe(false);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, games: { ...DEFAULT_SETTINGS.games, view: 'list' } });
  });

  it('accepts imports that contain it and strips it from section writes too', () => {
    const file = JSON.stringify({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: '2026-11-09T12:00:00.000Z',
      settings: { ...clone(DEFAULT_SETTINGS), games: { ...clone(DEFAULT_SETTINGS.games), playMode: 'direct' } },
    });
    const r = parseSettingsImport(file);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toEqual([]);
      expect('playMode' in r.settings.games).toBe(false);
    }
    const section = validateSection('games', { ...DEFAULT_SETTINGS.games, playMode: 'proxied' }, DEFAULT_SETTINGS.games);
    expect(section.issues).toEqual([]);
    expect('playMode' in section.value).toBe(false);
  });
});

describe('validateSection', () => {
  it('validates one section against the current value', () => {
    const current = clone(DEFAULT_SETTINGS.appearance);
    const { value, issues } = validateSection('appearance', { ...current, theme: 'light', blur: 400 }, current);
    expect(value.theme).toBe('light');
    expect(value.blur).toBe(40);
    expect(issues).toHaveLength(1);
  });

  it('falls back to the current value (not the default) for invalid keys', () => {
    const current = { ...clone(DEFAULT_SETTINGS.appearance), theme: 'light' as const };
    const { value } = validateSection('appearance', { ...current, theme: 'purple' }, current);
    expect(value.theme).toBe('light');
  });

  it('covers every section', () => {
    for (const section of SETTINGS_SECTIONS) {
      const { value, issues } = validateSection(section, clone(DEFAULT_SETTINGS[section]), DEFAULT_SETTINGS[section]);
      expect(issues, section).toEqual([]);
      expect(value).toEqual(DEFAULT_SETTINGS[section]);
    }
  });
});

describe('migrations', () => {
  it('treats a missing version as current and reports it', () => {
    const m = migrateSettings({ appearance: { theme: 'light' } });
    expect(m.fromVersion).toBeNull();
    expect((m.data as Settings).version).toBe(CURRENT_SETTINGS_VERSION);
    expect(m.issues[0]?.path).toBe('version');
  });

  it('runs ordered migrations up to the current version', () => {
    const migrations: Migration[] = [
      { from: 1, to: 2, run: (d) => ({ ...d, appearance: { ...(d.appearance as object), theme: (d as { mode?: string }).mode } }) },
      { from: 2, to: 3, run: (d) => ({ ...d, step3: true }) },
    ];
    const m = migrateSettings({ version: 1, mode: 'light' }, migrations, 3);
    expect(m.fromVersion).toBe(1);
    expect(m.data).toMatchObject({ version: 3, step3: true, appearance: { theme: 'light' } });
    expect(m.issues).toEqual([]);
  });

  it('stops at a missing step and reports it', () => {
    const m = migrateSettings({ version: 1 }, [], 2);
    expect(m.issues.some((i) => i.message.includes('no migration from v1'))).toBe(true);
    expect((m.data as { version: number }).version).toBe(2);
  });

  it('v1 → v2 (design v2): untouched v1 defaults move to the v2 look, the user’s own choices stay', () => {
    const v1Appearance = {
      ...clone(DEFAULT_SETTINGS.appearance),
      ...DESIGN_V1_APPEARANCE,
      homeBackground: { kind: 'glow', value: '', dim: 0.35, blur: 0 },
    };
    const v1 = { ...clone(DEFAULT_SETTINGS), version: 1, appearance: v1Appearance };
    const fresh = loadSettings(v1);
    expect(fresh.fromVersion).toBe(1);
    expect(fresh.issues).toEqual([]);
    expect(fresh.settings).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.appearance).toMatchObject({ ...DESIGN_V2_APPEARANCE, homeBackground: { ...DESIGN_V2_APPEARANCE.homeBackground, dim: 0.35, blur: 0 } });

    const chosen = {
      ...v1Appearance,
      theme: 'light',
      accentPreset: 'ember',
      fontFamily: 'atkinson',
      transparency: 0.9,
      blur: 30,
      radius: 4,
      sidebar: 'expanded',
      homeBackground: { kind: 'image', value: 'https://images.example/forest.jpg', dim: 0.5, blur: 4 },
    };
    const kept = loadSettings({ ...clone(DEFAULT_SETTINGS), version: 1, appearance: chosen }).settings.appearance;
    expect(kept).toEqual({ ...chosen, accent: DESIGN_V2_APPEARANCE.accent });

    // A custom accent that happens to be the old default hex is still the user's own color.
    const custom = loadSettings({ version: 1, appearance: { accentPreset: 'custom', accent: '#d6b47a' } }).settings.appearance;
    expect(custom).toMatchObject({ accentPreset: 'custom', accent: '#d6b47a' });
    // The glow ignored dim and blur, so any v1 glow becomes the wallpaper, keeping dim and blur for later pictures.
    const glow = loadSettings({ version: 1, appearance: { homeBackground: { kind: 'glow', value: '', dim: 0.6, blur: 8 } } });
    expect(glow.settings.appearance.homeBackground).toEqual({ kind: 'wallpaper', value: 'grove', dim: 0.6, blur: 8 });
    // Other sections and malformed appearance sections are left to validation.
    expect(migrateDesignV2({ version: 1, browser: { homepage: 'https://example.com/' } })).toEqual({ version: 1, browser: { homepage: 'https://example.com/' } });
    expect(migrateDesignV2({ version: 1, appearance: 'dark' })).toEqual({ version: 1, appearance: 'dark' });
    expect(MIGRATIONS.map((m) => [m.from, m.to])).toEqual([[1, 2]]);
    expect(CURRENT_SETTINGS_VERSION).toBe(2);
  });

  it('accepts files from a newer GNOME, keeping what this version understands', () => {
    const { settings, issues } = loadSettings({ version: 7, appearance: { theme: 'light', hologram: true } });
    expect(settings.appearance.theme).toBe('light');
    expect(issues.some((i) => i.message.includes('newer GNOME'))).toBe(true);
  });
});

describe('import / export', () => {
  it('round-trips an export', () => {
    const s = { ...createDefaultSettings(), appearance: { ...createDefaultSettings().appearance, theme: 'light' as const } };
    const text = exportSettings(s, new Date('2026-11-10T10:00:00Z'));
    const parsed = JSON.parse(text) as { format: string; exportedAt: string };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.exportedAt).toBe('2026-11-10T10:00:00.000Z');
    const r = parseSettingsImport(text);
    expect(r).toEqual({ ok: true, settings: s, issues: [] });
  });

  it('accepts a bare settings object', () => {
    const r = parseSettingsImport(JSON.stringify({ version: 1, appearance: { theme: 'system' } }));
    expect(r.ok && r.settings.appearance.theme).toBe('system');
  });

  it('rejects files that are not GNOME settings', () => {
    expect(parseSettingsImport('not json')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parseSettingsImport('[1,2,3]')).toEqual({ ok: false, error: 'The file does not contain GNOME settings.' });
    expect(parseSettingsImport('{"hello":"world"}')).toEqual({ ok: false, error: 'The file does not contain GNOME settings.' });
    expect(parseSettingsImport('{"format":"other","settings":{}}')).toEqual({
      ok: false,
      error: 'The file is not a GNOME settings export.',
    });
    expect(parseSettingsImport(' '.repeat(1024 * 1024 + 1))).toEqual({ ok: false, error: 'The file is larger than 1 MB.' });
  });

  it('reports corrected values in an otherwise valid import', () => {
    const r = parseSettingsImport(JSON.stringify({ version: 1, appearance: { theme: 'neon', fontSize: 15 } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings.appearance.fontSize).toBe(15);
      expect(r.issues.map((i) => i.path)).toEqual(['appearance.theme']);
    }
  });
});

describe('deepMerge / deepEqual', () => {
  it('merges plain objects recursively and replaces arrays', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 'x' };
    expect(deepMerge(base, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] }, d: 'x' });
    expect(base).toEqual({ a: { b: 1, c: [1, 2] }, d: 'x' }); // not mutated
  });

  it('deletes record entries set to undefined', () => {
    const base: Record<string, { x: number }> = { 'a.com': { x: 1 }, 'b.com': { x: 2 } };
    expect(deepMerge(base, { 'a.com': undefined })).toEqual({ 'b.com': { x: 2 } });
  });

  it('ignores prototype keys', () => {
    const merged = deepMerge({ a: 1 } as Record<string, unknown>, JSON.parse('{"__proto__":{"evil":1},"b":2}') as never);
    expect(merged).toEqual({ a: 1, b: 2 });
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it('compares structurally', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('protocol-shaped values (src/shared/engine-protocol.ts)', () => {
  it('keeps privacy.webrtc to block/allow with block as the default', () => {
    const input = createDefaultSettings() as unknown as { privacy: Record<string, unknown> };
    expect(validateSettings(input).settings.privacy.webrtc).toBe('block');
    input.privacy.webrtc = 'allow';
    expect(validateSettings(input).settings.privacy.webrtc).toBe('allow');
    input.privacy.webrtc = 'sometimes';
    const r = validateSettings(input);
    expect(r.settings.privacy.webrtc).toBe('block');
    expect(r.issues.some((i) => i.path === 'privacy.webrtc')).toBe(true);
  });

  it('accepts only Wisp servers the protocol accepts in route.custom.servers', () => {
    const input = createDefaultSettings() as unknown as { browser: Record<string, unknown> };
    input.browser.wispServers = ['wss://wisp.example.org/', '/wisp/alt/', '/wisp/../admin', 'wss://user:pw@x.example/', 'https://x.example/', 'ws://[::1]:9/'];
    expect(validateSettings(input).settings.browser.wispServers).toEqual(['wss://wisp.example.org/', '/wisp/alt/', 'ws://[::1]:9/']);
  });

  it('keeps unbound shortcuts and stores combos in the canonical form the protocol accepts', () => {
    const input = createDefaultSettings() as unknown as { browser: { shortcuts: Record<string, unknown> } };
    input.browser.shortcuts.newTab = '';
    input.browser.shortcuts.closeTab = 'shift+alt+w';
    const s = validateSettings(input).settings.browser.shortcuts;
    expect(s.newTab).toBe('');
    expect(s.closeTab).toBe('Alt+Shift+W');
  });
});
