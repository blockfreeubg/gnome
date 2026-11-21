import { describe, expect, it } from 'vitest';
import { validateEngineSettings } from '../../shared/engine-protocol';
import { createDefaultSettings } from '../../settings/defaults';
import type { Settings } from '../../settings/schema';
import { categoryCanApply, filterListRefs, parseServerListing, type ServerFilterList, type ServerListing } from './lists';

const sha = (n: number): string => n.toString(16).padStart(64, '0');

function list(id: string, category: ServerFilterList['category'], over: Partial<ServerFilterList> = {}): ServerFilterList {
  return {
    id,
    name: id,
    category,
    format: category === 'resources' ? 'resources' : 'abp',
    license: 'GPL-3.0',
    homepage: 'https://example.org/',
    default_enabled: true,
    trusted: false,
    available: true,
    size: 100,
    sha256: sha(id.length * 7 + id.charCodeAt(0)),
    updated_at: 1,
    fetched_at: 1,
    version: null,
    ...over,
  };
}

const LISTING: ServerListing = {
  lists: [
    list('easylist', 'ads'),
    list('ublock-badware', 'security', { trusted: true }),
    list('easyprivacy', 'privacy'),
    list('adguard-spyware-url', 'urlparams', { trusted: true }),
    list('fanboy-cookiemonster', 'cookies', { default_enabled: false }),
    list('ublock-annoyances-others', 'annoyances', { default_enabled: false }),
    list('not-yet', 'ads', { available: false, sha256: null }),
  ],
  resources: list('ubo-resources', 'resources', { trusted: true }),
};

function settingsWith(mut: (s: Settings) => void = () => undefined): Settings {
  const s = createDefaultSettings();
  mut(s);
  return s;
}

const ids = (s: Settings, l: ServerListing = LISTING): string[] => filterListRefs(l, s).map((r) => r.id);

describe('filterListRefs (WAVE-B3 §7.1)', () => {
  it('takes the server defaults: available lists with a hash, sorted by id, plus ubo-resources', () => {
    expect(ids(settingsWith())).toEqual(['adguard-spyware-url', 'easylist', 'easyprivacy', 'ublock-badware', 'ubo-resources']);
    const refs = filterListRefs(LISTING, settingsWith());
    expect(refs.find((r) => r.id === 'ubo-resources')).toEqual({ id: 'ubo-resources', sha256: LISTING.resources!.sha256, category: 'resources', format: 'resources', trusted: true });
    expect(refs.find((r) => r.id === 'easylist')).toEqual({ id: 'easylist', sha256: LISTING.lists[0]!.sha256, category: 'ads', format: 'abp', trusted: false });
  });

  it('follows the user’s choices over the defaults', () => {
    const s = settingsWith((x) => (x.extensions.lists = { easylist: false, 'fanboy-cookiemonster': true, 'not-yet': true }));
    expect(ids(s)).toEqual(['adguard-spyware-url', 'easyprivacy', 'fanboy-cookiemonster', 'ublock-badware', 'ubo-resources']);
  });

  it('leaves out unavailable and hashless lists', () => {
    const l: ServerListing = { lists: [list('a', 'ads', { available: false }), list('b', 'ads', { sha256: null })], resources: LISTING.resources };
    expect(ids(settingsWith(), l)).toEqual([]);
  });

  it('leaves out lists whose blocker is off everywhere, keeps them while a per-site override turns it on', () => {
    const off = settingsWith((x) => (x.extensions.enabled.adblock = false));
    expect(ids(off)).toEqual(['adguard-spyware-url', 'easyprivacy', 'ubo-resources']);
    const oneSite = settingsWith((x) => {
      x.extensions.enabled.adblock = false;
      x.extensions.perSite = { '*.example.com': { adblock: true } };
    });
    expect(ids(oneSite)).toContain('easylist');
    expect(ids(oneSite)).toContain('ublock-badware');
    // An override that turns it off somewhere does not count.
    const offSite = settingsWith((x) => {
      x.extensions.enabled.adblock = false;
      x.extensions.perSite = { '*.example.com': { adblock: false, trackers: true } };
    });
    expect(ids(offSite)).not.toContain('easylist');
  });

  it('cookie-notice and annoyance lists follow cosmetic filtering', () => {
    const s = settingsWith((x) => {
      x.extensions.lists = { 'fanboy-cookiemonster': true, 'ublock-annoyances-others': true };
      x.extensions.enabled.cosmetic = false;
    });
    expect(ids(s)).not.toContain('fanboy-cookiemonster');
    expect(ids(s)).not.toContain('ublock-annoyances-others');
    s.extensions.perSite = { 'news.example': { cosmetic: true } };
    expect(ids(s)).toEqual(expect.arrayContaining(['fanboy-cookiemonster', 'ublock-annoyances-others']));
  });

  it('parameter lists need privacy protection and “Remove tracking parameters”', () => {
    expect(categoryCanApply('urlparams', settingsWith((x) => (x.privacy.stripTrackingParams = false)))).toBe(false);
    expect(categoryCanApply('urlparams', settingsWith((x) => (x.extensions.enabled.privacy = false)))).toBe(false);
    expect(categoryCanApply('urlparams', settingsWith())).toBe(true);
  });

  it('sends ubo-resources only with a list, and only when the server has it', () => {
    const none = settingsWith((x) => {
      x.extensions.enabled = { adblock: false, trackers: false, privacy: false, cookies: true, cosmetic: false };
    });
    expect(ids(none)).toEqual([]);
    expect(ids(settingsWith(), { ...LISTING, resources: null })).not.toContain('ubo-resources');
    expect(ids(settingsWith(), { ...LISTING, resources: list('ubo-resources', 'resources', { available: false, sha256: null }) })).not.toContain('ubo-resources');
  });

  it('produces refs the snapshot validator accepts', () => {
    const s = createDefaultSettings();
    const snap = {
      engines: { scramjet: true, ultraviolet: true },
      engine: 'auto',
      autoFallback: true,
      transport: 'libcurl',
      route: { kind: 'default' },
      privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'block-third-party' },
      extensions: { enabled: s.extensions.enabled, lists: filterListRefs(LISTING, s), allowlist: [], perSite: {}, cosmeticAggressive: false, cookieRules: {} },
      keys: { combos: [], apple: false },
    };
    expect(validateEngineSettings(snap).ok).toBe(true);
  });
});

describe('parseServerListing', () => {
  it('keeps valid entries, drops malformed and duplicate ones', () => {
    const body = {
      lists: [
        { ...list('easylist', 'ads') },
        { ...list('easylist', 'ads'), name: 'dup' },
        { id: '../x', name: 'bad id', category: 'ads', format: 'abp' },
        { id: 'weird', name: 'w', category: 'unknown', format: 'abp' },
        { ...list('res-in-lists', 'resources') },
        null,
        { ...list('upper', 'ads'), sha256: 'ABC' },
      ],
      resources: list('ubo-resources', 'resources'),
    };
    const l = parseServerListing(body)!;
    expect(l.lists.map((x) => x.id)).toEqual(['easylist', 'upper']);
    expect(l.lists[0]!.name).toBe('easylist');
    // A malformed hash: the list is not available to the blocker.
    expect(l.lists[1]).toMatchObject({ sha256: null, available: false });
    expect(l.resources?.id).toBe('ubo-resources');
    expect(parseServerListing({ lists: 'no' })).toBeNull();
    expect(parseServerListing(null)).toBeNull();
    expect(parseServerListing({ lists: [], resources: list('x', 'ads') })!.resources).toBeNull();
  });
});
