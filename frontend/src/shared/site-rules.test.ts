import { describe, expect, it } from 'vitest';
import { validateCommandPayload } from './engine-protocol';
import {
  ENFORCED_PERMISSIONS,
  ENGINE_PERMISSION_ASK,
  browserFamily,
  decideOpen,
  enginePermissionFor,
  enginePermissionsFor,
  inHostList,
  isHostKey,
  resolveEnginePermissions,
  ruleFor,
  siteKeysFor,
  tabFrameAllow,
  trustedEnforcedPermissions,
} from './site-rules';

describe('enforced permissions per browser', () => {
  it('never offer a clipboard block: no browser enforces it (execCommand copy ignores the policy in Chromium)', () => {
    expect(ENFORCED_PERMISSIONS.chromium).toEqual(['fullscreen', 'autoplay']);
    expect(ENFORCED_PERMISSIONS.gecko).toEqual(['fullscreen']);
    expect(ENFORCED_PERMISSIONS.other).toEqual([]);
    for (const list of Object.values(ENFORCED_PERMISSIONS)) expect(list).not.toContain('clipboard');
  });

  it("the app keeps only what this browser can enforce of the engine host's claim", () => {
    const claim = ['clipboard', 'autoplay', 'fullscreen'] as const;
    // A hostile engine host claiming everything in Firefox gets fullscreen only.
    expect(trustedEnforcedPermissions(claim, 'gecko')).toEqual(['fullscreen']);
    expect(trustedEnforcedPermissions(claim, 'chromium')).toEqual(['autoplay', 'fullscreen']);
    expect(trustedEnforcedPermissions(claim, 'other')).toEqual([]);
    // Nothing is added that the engine host did not claim.
    expect(trustedEnforcedPermissions(['fullscreen'], 'chromium')).toEqual(['fullscreen']);
    expect(trustedEnforcedPermissions([], 'chromium')).toEqual([]);
  });

  it('browserFamily reads its defaults only when called (nothing at import time) and is "other" without a DOM', () => {
    expect(browserFamily('Mozilla/5.0 Firefox/157.0', null, null)).toBe('other');
    expect(browserFamily('Mozilla/5.0 Chrome/156.0.0.0', { featurePolicy: {} }, {})).toBe('chromium');
  });
});

describe('host keys', () => {
  it('accepts the Settings syntax', () => {
    for (const k of ['example.com', '*.example.com', 'example.com:8080', '[2001:db8::1]', 'localhost', '127.0.0.1', 'xn--bcher-kva.example']) {
      expect(isHostKey(k)).toBe(true);
    }
    for (const k of ['', 'exa mple.com', 'https://example.com', 'example.com/path', '*example.com', '**.example.com', '-bad.example', 'a'.repeat(261)]) {
      expect(isHostKey(k)).toBe(false);
    }
  });
});

describe('siteKeysFor', () => {
  it('lists host:port, host, then wildcards from the most specific', () => {
    expect(siteKeysFor('https://a.b.example.com:8443/x')).toEqual([
      'a.b.example.com:8443',
      'a.b.example.com',
      '*.a.b.example.com',
      '*.b.example.com',
      '*.example.com',
      '*.com',
    ]);
    expect(siteKeysFor('http://Example.COM./')).toEqual(['example.com', '*.example.com', '*.com']);
  });

  it('never applies wildcards to IP addresses and ignores non-http(s) URLs', () => {
    expect(siteKeysFor('http://127.0.0.1:8080/')).toEqual(['127.0.0.1:8080', '127.0.0.1']);
    expect(siteKeysFor('http://[2001:db8::1]/')).toEqual(['[2001:db8::1]']);
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'about:blank', 'not a url', 'file:///etc/passwd']) expect(siteKeysFor(u)).toEqual([]);
  });
});

describe('ruleFor', () => {
  const rules = { 'example.com': 'exact', '*.example.com': 'wild', 'example.com:8080': 'port', '*.sub.example.com': 'deeper' };

  it('applies the documented precedence', () => {
    expect(ruleFor(rules, 'https://example.com/')).toBe('exact');
    expect(ruleFor(rules, 'https://example.com:8080/')).toBe('port');
    expect(ruleFor(rules, 'https://www.example.com/')).toBe('wild');
    expect(ruleFor(rules, 'https://a.sub.example.com/')).toBe('deeper');
    expect(ruleFor(rules, 'https://sub.example.com/')).toBe('deeper');
    expect(ruleFor({ '*.example.com': 'wild' }, 'https://example.com/')).toBe('wild');
    expect(ruleFor(rules, 'https://example.org/')).toBeUndefined();
  });

  it('only reads own keys', () => {
    const polluted = JSON.parse('{"__proto__": {"example.org": "evil"}}') as Record<string, string>;
    expect(ruleFor(polluted, 'https://example.org/')).toBeUndefined();
    expect(ruleFor({}, 'https://toString/')).toBeUndefined();
  });

  it('matches host lists', () => {
    expect(inHostList(['*.example.com'], 'https://a.example.com/')).toBe(true);
    expect(inHostList(['example.com'], 'https://a.example.com/')).toBe(false);
    expect(inHostList([], 'https://example.com/')).toBe(false);
  });
});

describe('engine-enforced permissions', () => {
  it('resolves ask, keeps only engine permissions and drops empty or invalid sites', () => {
    const perms = resolveEnginePermissions(
      { camera: 'ask', autoplay: 'ask', fullscreen: 'block', clipboard: 'ask', popups: 'block' },
      { 'video.example': { autoplay: 'allow' }, 'cam.example': { camera: 'allow' }, 'bad key': { autoplay: 'allow' }, '*.x.example': { clipboard: 'ask' } },
    );
    expect(perms).toEqual({
      defaults: { autoplay: ENGINE_PERMISSION_ASK.autoplay, fullscreen: 'block', clipboard: ENGINE_PERMISSION_ASK.clipboard },
      sites: { 'video.example': { autoplay: 'allow' }, '*.x.example': { clipboard: 'allow' } },
    });
    expect(enginePermissionFor(perms, 'autoplay', 'https://video.example/watch')).toBe('allow');
    expect(enginePermissionFor(perms, 'autoplay', 'https://other.example/')).toBe('block');
    expect(enginePermissionFor(perms, 'clipboard', 'https://a.x.example/')).toBe('allow');
    expect(enginePermissionFor(perms, 'fullscreen', 'https://a.x.example/')).toBe('block');
  });

  it('sends only the decisions for the destination of a load, never the site list', () => {
    const perms = resolveEnginePermissions({ autoplay: 'block' }, { 'video.example': { autoplay: 'allow' } });
    const set = enginePermissionsFor(perms, 'https://video.example/watch');
    expect(set).toEqual({ autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' });
    const p = { tabId: 1, url: 'https://video.example/watch', engine: null, permissions: set };
    expect(validateCommandPayload('tab.navigate', p).ok).toBe(true);
    expect(JSON.stringify(p)).not.toContain('video.example"');
  });

  it('writes block as an explicit none in the tab frame allow attribute, for enforced permissions only', () => {
    const set = { autoplay: 'block', fullscreen: 'allow', clipboard: 'block' } as const;
    expect(tabFrameAllow(set, ['autoplay', 'fullscreen', 'clipboard'])).toBe("autoplay 'none'; fullscreen; clipboard-write 'none'");
    expect(tabFrameAllow(set, ['autoplay'])).toBe("autoplay 'none'; fullscreen; clipboard-write");
    expect(tabFrameAllow(set, [])).toBe('autoplay; fullscreen; clipboard-write');
  });
});

describe('decideOpen', () => {
  const base = { disposition: 'foreground' as const, userActivation: true, appActivation: true, popups: 'block' as const, openLinksInBackground: false };

  it('opens tabs the user asked for', () => {
    expect(decideOpen(base)).toEqual({ action: 'open', background: false });
    expect(decideOpen({ ...base, disposition: 'background' })).toEqual({ action: 'open', background: true });
    expect(decideOpen({ ...base, openLinksInBackground: true })).toEqual({ action: 'open', background: true });
    expect(decideOpen({ ...base, disposition: 'popup', openLinksInBackground: true })).toEqual({ action: 'open', background: false });
  });

  it('fails closed when the app cannot read its own activation (the engine host claim alone is no gesture)', () => {
    expect(decideOpen({ ...base, appActivation: null })).toEqual({ action: 'blocked' });
    expect(decideOpen({ ...base, appActivation: null, popups: 'ask' })).toEqual({ action: 'ask' });
    expect(decideOpen({ ...base, appActivation: null, popups: 'allow' })).toEqual({ action: 'open', background: true });
  });

  it('applies the popups permission without a gesture, including a claimed gesture the app did not see', () => {
    expect(decideOpen({ ...base, userActivation: false })).toEqual({ action: 'blocked' });
    expect(decideOpen({ ...base, appActivation: false })).toEqual({ action: 'blocked' });
    expect(decideOpen({ ...base, userActivation: false, popups: 'ask' })).toEqual({ action: 'ask' });
    expect(decideOpen({ ...base, userActivation: false, popups: 'allow' })).toEqual({ action: 'open', background: true });
  });
});
