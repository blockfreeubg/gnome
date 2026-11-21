import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../settings/defaults';
import { blockedPageKey, pauseAllowlist, resumeAllowlist, setSiteSwitch, shieldSite, type SiteFns } from './shield';

// A small stand-in for core/site.ts (tldts): registrable domain = last two labels, `co.uk` and `github.io` as suffixes.
const SUFFIX2 = new Set(['co.uk', 'github.io']);
const fns: SiteFns = {
  siteOf(url) {
    const h = new URL(url).hostname;
    if (/^\d+(\.\d+){3}$/.test(h) || h.startsWith('[')) return h;
    const l = h.split('.');
    const n = SUFFIX2.has(l.slice(-2).join('.')) ? 3 : 2;
    return l.slice(-n).join('.');
  },
  siteKeyOf(url) {
    const s = this.siteOf(url);
    return s === null ? null : /^\d+(\.\d+){3}$/.test(s) || s.startsWith('[') ? s : `*.${s}`;
  },
};
const ext = (over: Partial<ReturnType<typeof createDefaultSettings>['extensions']> = {}) => ({ ...createDefaultSettings().extensions, ...over });

describe('shield site rules (WAVE-B3 §7.1)', () => {
  it('Pause names and writes *.<registrable domain>', () => {
    const s = shieldSite('https://www.news.example.co.uk/a', ext(), fns);
    expect(s.pauseKey).toBe('*.example.co.uk');
    expect(s.allowlisted).toBe(false);
    expect(pauseAllowlist([], s.pauseKey!)).toEqual(['*.example.co.uk']);
    expect(pauseAllowlist(['*.example.co.uk'], '*.example.co.uk')).toEqual(['*.example.co.uk']);
    expect(shieldSite('https://foo.github.io/', ext(), fns).pauseKey).toBe('*.foo.github.io');
    expect(shieldSite('http://192.168.1.4:8080/', ext(), fns).pauseKey).toBe('192.168.1.4');
  });

  it('Resume removes only keys at least as specific as the site key', () => {
    const allowlist = ['*.site-a.localhost', 'site-a.localhost', 'www.site-a.localhost:8080', '*.www.site-a.localhost', 'other.example'];
    const s = shieldSite('http://www.site-a.localhost:8080/', ext({ allowlist }), { siteOf: () => 'site-a.localhost', siteKeyOf: () => '*.site-a.localhost' });
    expect(s.allowlisted).toBe(true);
    expect(s.removable.sort()).toEqual(['*.site-a.localhost', '*.www.site-a.localhost', 'www.site-a.localhost:8080']);
    expect(s.broader).toBeNull();
    expect(resumeAllowlist(allowlist, s.removable)).toEqual(['site-a.localhost', 'other.example']);
    // Allowed through Settings as the bare host: Resume removes it too.
    const bare = shieldSite('http://site-a.localhost/', ext({ allowlist: ['site-a.localhost'] }), { siteOf: () => 'site-a.localhost', siteKeyOf: () => '*.site-a.localhost' });
    expect(bare.removable).toEqual(['site-a.localhost']);
  });

  it('a broader key that still matches replaces Resume', () => {
    const s = shieldSite('https://shop.example.co.uk/', ext({ allowlist: ['*.co.uk', '*.example.co.uk'] }), fns);
    expect(s.removable).toEqual(['*.example.co.uk']);
    expect(s.broader).toBe('*.co.uk');
    const only = shieldSite('https://shop.example.com/', ext({ allowlist: ['*.com'] }), fns);
    expect(only.removable).toEqual([]);
    expect(only.broader).toBe('*.com');
  });

  it('per-site switches write the rule that applies, else a new one under the site key, and drop global values', () => {
    const e = ext({ perSite: { '*.news.example': { adblock: false } } });
    const s = shieldSite('https://www.news.example/', e, fns);
    expect(s.ruleKey).toBe('*.news.example');
    expect(s.switches).toEqual({ adblock: false, trackers: true, cosmetic: true });
    expect(setSiteSwitch(e, s, 'cosmetic', false)).toEqual({ '*.news.example': { adblock: false, cosmetic: false } });
    // Back to the global value: the rule loses the key, and an empty rule goes.
    expect(setSiteSwitch(e, s, 'adblock', true)).toEqual({});
    const t = shieldSite('https://a.example/', ext(), fns);
    expect(setSiteSwitch(ext(), t, 'trackers', false)).toEqual({ '*.a.example': { trackers: false } });
  });

  it('per-site switches never change a rule broader than the site key (a user’s *.com): they copy it to the site’s own', () => {
    const e = ext({ perSite: { '*.com': { cosmetic: false } } });
    const s = shieldSite('https://www.example.com/', e, fns);
    expect(s.ruleKey).toBe('*.com');
    expect(s.switchKey).toBe('*.example.com');
    expect(s.switches).toEqual({ adblock: true, trackers: true, cosmetic: false });
    // Ads off here only: *.com keeps its rule, the site's own rule keeps the cosmetic value it had through *.com.
    expect(setSiteSwitch(e, s, 'adblock', false)).toEqual({ '*.com': { cosmetic: false }, '*.example.com': { cosmetic: false, adblock: false } });
    // A more specific rule than the site key (a host the user named with "Only this host") is the one that changes.
    const h = ext({ perSite: { 'www.example.com': { trackers: false } } });
    const hs = shieldSite('https://www.example.com/', h, fns);
    expect(hs.switchKey).toBe('www.example.com');
    expect(setSiteSwitch(h, hs, 'trackers', true)).toEqual({});
  });

  it('the blocked page names *.<site> for the site or www, else the exact host', () => {
    expect(blockedPageKey('https://example.com/x', fns)).toBe('*.example.com');
    expect(blockedPageKey('https://www.example.com/x', fns)).toBe('*.example.com');
    expect(blockedPageKey('https://ads.example.com/x', fns)).toBe('ads.example.com');
    expect(blockedPageKey('http://10.0.0.1/', fns)).toBe('10.0.0.1');
    expect(blockedPageKey('ftp://example.com/', fns)).toBeNull();
  });
});
