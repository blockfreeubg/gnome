import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../settings/defaults';
import { cookieRuleFor, cookiesBlocked, sitePolicy, SW_FALLBACK_SETTINGS } from './policy';
import type { BlockerSettings, CookieRule, SitePolicy } from './policy';

const base = (): BlockerSettings => structuredClone(SW_FALLBACK_SETTINGS);
const withExt = (e: Partial<BlockerSettings['extensions']>, p: Partial<BlockerSettings['privacy']> = {}): BlockerSettings => {
  const s = base();
  return { privacy: { ...s.privacy, ...p }, extensions: { ...s.extensions, ...e } };
};

describe('sitePolicy precedence (D3: allowlist > per-site > global)', () => {
  it('applies the global toggles without rules', () => {
    const p = sitePolicy(base(), 'https://news.example/');
    expect(p.allowlisted).toBe(false);
    expect(p.groups).toEqual({ ads: true, security: true, trackers: true, params: true, cookies: true, annoyances: true });
    expect(p).toMatchObject({ hide: true, genericHide: false, gpc: true, dnt: false, referrer: 'origin-cross-site', stripParams: true, cookieMode: 'block-third-party' });
  });

  it('the allowlist turns off everything list-based but keeps GPC, the referrer mode and the cookie mode', () => {
    const s = withExt({ allowlist: ['*.site-a.localhost'], perSite: { 'site-a.localhost': { adblock: true } } });
    for (const top of ['http://site-a.localhost/', 'http://www.site-a.localhost:8080/x']) {
      const p = sitePolicy(s, top);
      expect(p.allowlisted).toBe(true);
      expect(Object.values(p.groups).every((v) => !v)).toBe(true);
      expect(p).toMatchObject({ hide: false, genericHide: false, stripParams: false, gpc: true, referrer: 'origin-cross-site', cookieMode: 'block-third-party' });
    }
    expect(sitePolicy(s, 'http://site-b.localhost/').allowlisted).toBe(false);
  });

  it('per-site overrides beat the global toggles; exact keys beat wildcards; ports and IPs', () => {
    const s = withExt({
      enabled: { adblock: true, trackers: false, privacy: true, cookies: true, cosmetic: true },
      perSite: {
        '*.example.com': { adblock: false },
        'shop.example.com': { adblock: true, cosmetic: false },
        'example.org:8443': { trackers: true },
        '127.0.0.2': { adblock: false },
      },
    });
    const a = sitePolicy(s, 'https://www.example.com/');
    expect(a.groups).toMatchObject({ ads: false, security: false, trackers: false });
    const b = sitePolicy(s, 'https://shop.example.com/');
    expect(b.groups).toMatchObject({ ads: true, security: true, trackers: false, cookies: false, annoyances: false });
    expect(b.hide).toBe(false);
    expect(sitePolicy(s, 'https://example.org:8443/').groups.trackers).toBe(true);
    expect(sitePolicy(s, 'https://example.org/').groups.trackers).toBe(false);
    expect(sitePolicy(s, 'http://127.0.0.2/').groups.ads).toBe(false);
    expect(sitePolicy(s, 'http://127.0.0.3/').groups.ads).toBe(true);
  });

  it('wildcards never apply to IP literals in the allowlist', () => {
    const s = withExt({ allowlist: ['*.0.0.2'] });
    expect(sitePolicy(s, 'http://127.0.0.2/').allowlisted).toBe(false);
  });

  it('privacy protection gates params, GPC, DNT and the referrer mode; cosmeticAggressive the generic hiding', () => {
    const s = withExt({ enabled: { adblock: true, trackers: true, privacy: false, cookies: false, cosmetic: true }, cosmeticAggressive: true }, { doNotTrack: true, referrer: 'none' });
    const p = sitePolicy(s, 'https://a.example/');
    expect(p).toMatchObject({ gpc: false, dnt: false, referrer: 'default', stripParams: false, cookieMode: 'all', genericHide: true });
    expect(p.groups.params).toBe(false);
    const q = sitePolicy(withExt({}, { stripTrackingParams: false, doNotTrack: true }), 'https://a.example/');
    expect(q).toMatchObject({ stripParams: false, dnt: true });
    expect(q.groups.params).toBe(false);
  });

  it('an unknown top-level page gets the global settings without site rules', () => {
    const s = withExt({ allowlist: ['*.a.example'], perSite: { '*.a.example': { adblock: false } } });
    const p = sitePolicy(s, null);
    expect(p.allowlisted).toBe(false);
    expect(p.groups.ads).toBe(true);
  });
});

describe('cookies (D4)', () => {
  const pol = (mode: SitePolicy['cookieMode']): SitePolicy => ({ ...sitePolicy(base(), 'https://a.example/'), cookieMode: mode });
  it('truth table: rule × mode × party (unknown party counts as third-party)', () => {
    const rules: Array<CookieRule | null> = [null, 'allow', 'session', 'block'];
    const parties: Array<boolean | null> = [false, true, null];
    for (const mode of ['all', 'block-third-party', 'block-all'] as const) {
      for (const rule of rules) {
        for (const party of parties) {
          const want = rule === 'block' ? true : rule !== null ? false : mode === 'block-all' ? true : mode === 'block-third-party' ? party !== false : false;
          expect(cookiesBlocked(pol(mode), rule, party), `${mode} ${String(rule)} ${String(party)}`).toBe(want);
        }
      }
    }
  });

  it('cookieRuleFor is keyed by the cookie site and off with the cookie manager', () => {
    const s = withExt({ cookieRules: { '*.trk.example': 'allow', 'bank.example': 'session' } });
    expect(cookieRuleFor(s, 'https://px.trk.example/a')).toBe('allow');
    expect(cookieRuleFor(s, 'https://bank.example/')).toBe('session');
    expect(cookieRuleFor(s, 'https://www.bank.example/')).toBeNull();
    const off = withExt({ cookieRules: { 'bank.example': 'block' }, enabled: { ...base().extensions.enabled, cookies: false } });
    expect(cookieRuleFor(off, 'https://bank.example/')).toBeNull();
    expect(sitePolicy(off, 'https://bank.example/').cookieMode).toBe('all');
  });
});

describe('SW_FALLBACK_SETTINGS', () => {
  it('equals the schema defaults minus lists and rules', () => {
    const d = createDefaultSettings();
    expect(SW_FALLBACK_SETTINGS.privacy).toEqual({
      webrtc: d.privacy.webrtc,
      sendGpc: d.privacy.sendGpc,
      doNotTrack: d.privacy.doNotTrack,
      referrer: d.privacy.referrer,
      stripTrackingParams: d.privacy.stripTrackingParams,
      cookies: d.browser.cookies.mode,
    });
    expect(SW_FALLBACK_SETTINGS.extensions).toEqual({
      enabled: d.extensions.enabled,
      lists: [],
      allowlist: d.extensions.allowlist,
      perSite: d.extensions.perSite,
      cosmeticAggressive: d.extensions.cosmeticAggressive,
      cookieRules: d.extensions.cookieRules,
    });
  });
});
