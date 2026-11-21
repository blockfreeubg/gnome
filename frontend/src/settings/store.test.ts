import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idbGet, idbPut } from '../lib/idb';
import { computeAppearance } from './apply';
import { createDefaultSettings, DEFAULT_SETTINGS } from './defaults';
import { CURRENT_SETTINGS_VERSION, type Settings } from './schema';
import { settings, STORAGE_KEY, type SettingsChange, type SettingsMirror } from './store.svelte';
import { parseSettingsImport } from './validate';

vi.mock('../lib/idb', () => ({
  idbGet: vi.fn(async () => undefined),
  idbPut: vi.fn(async () => 'current'),
}));

function mirror(): SettingsMirror | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as SettingsMirror) : null;
}

beforeEach(() => {
  settings.reset();
  localStorage.clear();
  vi.mocked(idbPut).mockClear();
});

describe('reading and writing', () => {
  it('starts from the defaults, deeply frozen', () => {
    expect(settings.value).toEqual(DEFAULT_SETTINGS);
    expect(settings.get('appearance')).toBe(settings.value.appearance);
    expect(Object.isFrozen(settings.value.appearance.colors)).toBe(true);
    expect(() => {
      (settings.value.appearance as { theme: string }).theme = 'light';
    }).toThrow(TypeError);
  });

  it('set() commits valid values, mirrors them with the boot payload and notifies', () => {
    const changes: SettingsChange[] = [];
    const off = settings.onChange((c) => changes.push(c));
    const before = settings.updatedAt;
    expect(settings.set('appearance', 'theme', 'light')).toEqual([]);
    off();
    expect(settings.value.appearance.theme).toBe('light');
    expect(settings.updatedAt).toBeGreaterThan(before);
    expect(changes).toEqual([{ origin: 'local', sections: ['appearance'], updatedAt: settings.updatedAt }]);
    const m = mirror();
    expect(m?.settings.appearance.theme).toBe('light');
    expect(m?.updatedAt).toBe(settings.updatedAt);
    expect(m?.boot).toEqual(computeAppearance(settings.value));
  });

  it('rejects invalid values: the previous value stays and nothing is written', () => {
    settings.set('appearance', 'theme', 'light');
    localStorage.clear();
    const listener = vi.fn();
    const off = settings.onChange(listener);
    const issues = settings.set('appearance', 'theme', 'neon' as Settings['appearance']['theme']);
    off();
    expect(issues).toHaveLength(1);
    expect(settings.value.appearance.theme).toBe('light');
    expect(listener).not.toHaveBeenCalled();
    expect(mirror()).toBeNull();
  });

  it('clamps out-of-range numbers instead of rejecting them', () => {
    const issues = settings.set('appearance', 'fontSize', 40);
    expect(settings.value.appearance.fontSize).toBe(20);
    expect(issues[0]?.message).toContain('clamped');
  });

  it('does not notify for writes that change nothing', () => {
    const listener = vi.fn();
    const off = settings.onChange(listener);
    settings.set('appearance', 'theme', 'dark');
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  it('patch() deep-merges nested objects across sections', () => {
    settings.patch({ appearance: { homeBackground: { kind: 'gradient', value: 'linear-gradient(#000, #111)' } }, vpn: { autoConnect: true } });
    expect(settings.value.appearance.homeBackground).toEqual({
      kind: 'gradient',
      value: 'linear-gradient(#000, #111)',
      dim: 0.35,
      blur: 0,
    });
    expect(settings.value.vpn.autoConnect).toBe(true);
    expect(settings.value.vpn.killSwitch).toBe(true);
  });

  it('patch() adds and deletes record entries', () => {
    settings.patch({ privacy: { sitePermissions: { 'a.example': { camera: 'allow' }, 'b.example': { popups: 'block' } } } });
    settings.patch({ privacy: { sitePermissions: { 'a.example': undefined } } });
    expect(settings.value.privacy.sitePermissions).toEqual({ 'b.example': { popups: 'block' } });
  });

  it('reset(section), reset() and resetKey()', () => {
    settings.patch({ appearance: { theme: 'light', radius: 4 }, browser: { searchEngine: 'brave' } });
    expect(settings.isDefault('appearance')).toBe(false);
    settings.resetKey('appearance', 'radius');
    expect(settings.value.appearance.radius).toBe(DEFAULT_SETTINGS.appearance.radius);
    expect(settings.isDefault('appearance', 'radius')).toBe(true);
    expect(settings.isDefault('appearance', 'theme')).toBe(false);
    settings.reset('appearance');
    expect(settings.value.appearance).toEqual(DEFAULT_SETTINGS.appearance);
    expect(settings.value.browser.searchEngine).toBe('brave');
    settings.reset();
    expect(settings.value).toEqual(DEFAULT_SETTINGS);
  });

  it('exports and imports through the validated pipeline', () => {
    settings.set('browser', 'searchEngine', 'ecosia');
    const text = settings.export();
    settings.reset();
    const changes: SettingsChange[] = [];
    const off = settings.onChange((c) => changes.push(c));
    const r = settings.import(text);
    off();
    expect(r.ok).toBe(true);
    expect(settings.value.browser.searchEngine).toBe('ecosia');
    expect(changes[0]?.origin).toBe('import');
    expect(settings.import('{"oops"')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(settings.value.browser.searchEngine).toBe('ecosia');
    expect(parseSettingsImport(text).ok).toBe(true);
  });

  it('import keeps this browser’s home background when the file only references a picture stored elsewhere', () => {
    const file = createDefaultSettings();
    file.appearance.theme = 'light';
    file.appearance.homeBackground = { kind: 'image', value: 'idb:home-bg:elsewhere', dim: 0.3, blur: 0 };
    settings.set('appearance', 'homeBackground', { kind: 'gradient', value: 'linear-gradient(#000, #111)', dim: 0, blur: 0 });
    expect(settings.import(JSON.stringify({ format: 'gnome-settings', version: 1, settings: file })).ok).toBe(true);
    expect(settings.value.appearance.theme).toBe('light');
    expect(settings.value.appearance.homeBackground.kind).toBe('gradient');
  });

  it('import keeps this browser’s sync switches (device-local, never taken from a file)', () => {
    const file = createDefaultSettings();
    file.account = { sync: true, syncHistory: true, syncBookmarks: true, syncSettings: true };
    file.appearance.theme = 'light';
    settings.set('account', 'syncBookmarks', false);
    const r = settings.import(JSON.stringify({ format: 'gnome-settings', version: 1, exportedAt: '', settings: file }));
    expect(r.ok).toBe(true);
    expect(settings.value.appearance.theme).toBe('light');
    expect(settings.value.account).toEqual({ ...DEFAULT_SETTINGS.account, syncBookmarks: false });
  });

  it('import rejects files that are not GNOME settings and changes nothing', () => {
    settings.set('appearance', 'theme', 'light');
    for (const text of ['[]', '"x"', '{"format":"other","settings":{}}', '{"hello":1}', 'x'.repeat(1024 * 1024 + 1)]) {
      expect(settings.import(text).ok, text.slice(0, 40)).toBe(false);
    }
    expect(settings.value.appearance.theme).toBe('light');
  });
});

describe('persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes to IndexedDB once per burst of changes (debounced)', async () => {
    vi.useFakeTimers();
    settings.set('appearance', 'radius', 4);
    settings.set('appearance', 'radius', 8);
    settings.set('appearance', 'blur', 10);
    expect(idbPut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(idbPut).toHaveBeenCalledTimes(1);
    const [store, record, key] = vi.mocked(idbPut).mock.calls[0]!;
    expect(store).toBe('settings');
    expect(key).toBe('current');
    expect(record).toMatchObject({ version: CURRENT_SETTINGS_VERSION, updatedAt: settings.updatedAt });
    expect((record as { data: Settings }).data.appearance).toMatchObject({ radius: 8, blur: 10 });
  });
});

describe('startup (fresh module)', () => {
  type StoreModule = typeof import('./store.svelte');

  async function freshStore(): Promise<StoreModule> {
    vi.resetModules();
    return import('./store.svelte');
  }

  afterEach(() => {
    vi.mocked(idbGet).mockReset();
    vi.mocked(idbGet).mockImplementation(async () => undefined);
  });

  it('applies the localStorage mirror synchronously, then a newer IndexedDB copy', async () => {
    const mirrored = createDefaultSettings();
    mirrored.appearance.theme = 'light';
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, updatedAt: 100, settings: mirrored, boot: computeAppearance(mirrored) }));
    const stored = createDefaultSettings();
    stored.appearance.theme = 'system';
    vi.mocked(idbGet).mockResolvedValueOnce({ version: 1, updatedAt: 200, data: stored } as never);

    const { settings: s } = await freshStore();
    const ready = s.init();
    expect(s.value.appearance.theme).toBe('light'); // mirror, before IndexedDB answered
    await ready;
    expect(s.loaded).toBe(true);
    expect(s.value.appearance.theme).toBe('system');
    expect(s.updatedAt).toBe(200);
    expect(mirror()?.settings.appearance.theme).toBe('system');
  });

  it('restores IndexedDB from a newer mirror', async () => {
    const mirrored = createDefaultSettings();
    mirrored.browser.searchEngine = 'bing';
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, updatedAt: 500, settings: mirrored, boot: computeAppearance(mirrored) }));
    vi.mocked(idbGet).mockResolvedValueOnce(undefined);
    vi.mocked(idbPut).mockClear();

    const { settings: s } = await freshStore();
    await s.init();
    expect(s.value.browser.searchEngine).toBe('bing');
    expect(idbPut).toHaveBeenCalledWith('settings', { version: CURRENT_SETTINGS_VERSION, updatedAt: 500, data: s.value }, 'current');
  });

  it('loads a corrupted or outdated mirror without failing (retired keys dropped)', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    let mod = await freshStore();
    await mod.settings.init();
    expect(mod.settings.value).toEqual(DEFAULT_SETTINGS);

    const legacy = { ...createDefaultSettings(), games: { ...createDefaultSettings().games, playMode: 'proxied' } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, updatedAt: 50, settings: legacy }));
    mod = await freshStore();
    await mod.settings.init();
    expect('playMode' in mod.settings.value.games).toBe(false);
  });

  it('repairs the mirror at startup: damaged ones are removed, corrected ones rewritten, current ones left alone', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    await (await freshStore()).settings.init();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    localStorage.setItem(STORAGE_KEY, '[1,2,3]');
    await (await freshStore()).settings.init();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // Invalid values + a boot payload the pre-paint script would misapply (garbage classes, wrong theme).
    const damaged = { v: 1, updatedAt: 70, settings: { version: 1, appearance: { theme: 'light', fontSize: 99, sidebar: 'nope' } }, boot: { theme: 'dark', classes: 'abc def' } };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(damaged));
    let mod = await freshStore();
    mod.settings.init();
    const repaired = mirror()!;
    expect(repaired.updatedAt).toBe(70);
    expect(repaired.settings.appearance).toMatchObject({ theme: 'light', fontSize: 20, sidebar: DEFAULT_SETTINGS.appearance.sidebar });
    expect(repaired.boot).toEqual(computeAppearance(mod.settings.value));

    // A canonical mirror is not rewritten (no storage write, no cross-tab storage event).
    const setItem = vi.spyOn(localStorage, 'setItem');
    mod = await freshStore();
    mod.settings.init();
    expect(setItem.mock.calls.filter(([k]) => k === STORAGE_KEY)).toHaveLength(0);
    setItem.mockRestore();

    // A mirror written by a newer GNOME keeps the keys this version does not know.
    const newer = JSON.stringify({ v: 1, updatedAt: 90, settings: { version: CURRENT_SETTINGS_VERSION + 1, appearance: { theme: 'light', futureKey: 1 } }, boot: computeAppearance(createDefaultSettings()) });
    localStorage.setItem(STORAGE_KEY, newer);
    mod = await freshStore();
    mod.settings.init();
    expect(mod.settings.value.appearance.theme).toBe('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(newer);
  });

  it('does not let a damaged IndexedDB record replace newer settings; the record is rewritten', async () => {
    const mirrored = createDefaultSettings();
    mirrored.appearance.theme = 'light';
    for (const damaged of [
      { version: 1, updatedAt: 9e15, data: 'garbage' },
      { version: 1, updatedAt: 9e15, data: [1, 2] },
      { version: 1, updatedAt: Number.NaN, data: createDefaultSettings() },
      'not a record',
    ]) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, updatedAt: 300, settings: mirrored, boot: computeAppearance(mirrored) }));
      vi.mocked(idbGet).mockResolvedValueOnce(damaged as never);
      vi.mocked(idbPut).mockClear();
      const { settings: s } = await freshStore();
      await s.init();
      expect(s.value.appearance.theme, JSON.stringify(damaged)).toBe('light');
      expect(s.updatedAt).toBe(300);
      expect(idbPut).toHaveBeenCalledWith('settings', { version: CURRENT_SETTINGS_VERSION, updatedAt: 300, data: s.value }, 'current');
    }
  });

  it('keeps working when IndexedDB is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(idbGet).mockRejectedValueOnce(new Error('IndexedDB blocked'));
    const { settings: s } = await freshStore();
    await s.init();
    expect(s.loaded).toBe(true);
    expect(s.set('appearance', 'theme', 'light')).toEqual([]);
    expect(s.value.appearance.theme).toBe('light');
    warn.mockRestore();
  });

  it('syncs across tabs over BroadcastChannel (newer change wins, older ignored)', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window = { addEventListener: () => undefined };
    g.document = { addEventListener: () => undefined, visibilityState: 'visible' };
    try {
      const { settings: s } = await freshStore();
      await s.init();
      const otherTab = new BroadcastChannel('gnome:settings');
      const remote = createDefaultSettings();
      remote.appearance.accentPreset = 'moss';
      const changed = new Promise<SettingsChange>((resolve) => {
        const off = s.onChange((c) => {
          off();
          resolve(c);
        });
      });
      otherTab.postMessage({ type: 'settings', from: 'other-tab', updatedAt: s.updatedAt + 1000, settings: remote });
      const change = await changed;
      expect(change).toMatchObject({ origin: 'tab', sections: ['appearance'] });
      expect(s.value.appearance.accentPreset).toBe('moss');

      const stale = createDefaultSettings();
      stale.appearance.accentPreset = 'ember';
      otherTab.postMessage({ type: 'settings', from: 'other-tab', updatedAt: 1, settings: stale });
      await new Promise((r) => setTimeout(r, 30));
      expect(s.value.appearance.accentPreset).toBe('moss');
      otherTab.close();
    } finally {
      delete g.window;
      delete g.document;
    }
  });
});
