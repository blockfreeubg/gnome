import { describe, expect, it } from 'vitest';
import { validateCommandMessage } from '../../shared/engine-protocol';
import { DEFAULT_SETTINGS } from '../../settings/defaults';
import type { Settings } from '../../settings/schema';
import { freshStartCookieDeletes, siteOfHostKey } from './fresh-start';

const ext = (cookieRules: Settings['extensions']['cookieRules'], cookies = true): Settings['extensions'] => ({
  ...DEFAULT_SETTINGS.extensions,
  enabled: { ...DEFAULT_SETTINGS.extensions.enabled, cookies },
  cookieRules,
});

describe('freshStartCookieDeletes', () => {
  it('one delete per session rule: wildcard, port and IP keys, deduplicated, sorted', () => {
    const out = freshStartCookieDeletes(
      ext({
        '*.example.com': 'session',
        'example.com:8080': 'session',
        'shop.example.org': 'session',
        '192.168.1.10': 'session',
        '[2001:db8::1]:8443': 'session',
        '*.blocked.example': 'block',
        'allowed.example': 'allow',
      }),
    );
    expect(out).toEqual([
      { all: false, site: '192.168.1.10', name: null },
      { all: false, site: '[2001:db8::1]', name: null },
      { all: false, site: 'example.com', name: null },
      { all: false, site: 'shop.example.org', name: null },
    ]);
  });

  it('nothing while the cookie manager is off, or without session rules', () => {
    expect(freshStartCookieDeletes(ext({ '*.example.com': 'session' }, false))).toEqual([]);
    expect(freshStartCookieDeletes(ext({ '*.example.com': 'block' }))).toEqual([]);
    expect(freshStartCookieDeletes(DEFAULT_SETTINGS.extensions)).toEqual([]);
  });

  it('every command it makes passes the cookies.delete validator', () => {
    const out = freshStartCookieDeletes(ext({ '*.a.example': 'session', '[::1]:1': 'session', '10.0.0.1:99': 'session', 'x_y.example': 'session' }));
    expect(out).toHaveLength(4);
    for (const payload of out) {
      const v = validateCommandMessage({ k: 'cmd', id: 1, type: 'cookies.delete', p: payload });
      expect(v.ok).toBe(true);
    }
  });

  it('skips keys that cannot name a site (never sends an invalid command)', () => {
    expect(siteOfHostKey('*.')).toBeNull();
    expect(siteOfHostKey('[::1')).toBeNull();
    expect(siteOfHostKey('Example.COM')).toBe('example.com');
    expect(freshStartCookieDeletes(ext({ '*.': 'session', 'bad key': 'session' }))).toEqual([]);
  });
});
