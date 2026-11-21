import { describe, expect, it } from 'vitest';
import { buildPath, compilePattern, isServerPath, matchPattern, normalizePath } from './match';
import {
  allRoutes,
  matchRoute,
  MOBILE_BAR_SLOTS,
  mobileNav,
  navRoutes,
  NOT_FOUND_ID,
  pathFor,
  registerRoute,
  routeById,
  routeTitle,
} from './routes';

describe('normalizePath', () => {
  it('collapses slashes, adds the leading one and drops a trailing one', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('games/')).toBe('/games');
    expect(normalizePath('//games///x//')).toBe('/games/x');
    expect(normalizePath('/index.html')).toBe('/');
    expect(normalizePath('/games/INDEX.HTML')).toBe('/games');
  });
});

describe('compilePattern / matchPattern', () => {
  it('matches static segments case-insensitively, with or without a trailing slash', () => {
    const p = compilePattern('/games');
    expect(matchPattern(p, '/games')).toEqual({});
    expect(matchPattern(p, '/games/')).toEqual({});
    expect(matchPattern(p, '/GAMES')).toEqual({});
    expect(matchPattern(p, '/games/x')).toBeNull();
    expect(matchPattern(p, '/gamesx')).toBeNull();
  });

  it('decodes params and keeps their case', () => {
    const p = compilePattern('/games/:slug');
    expect(matchPattern(p, '/games/Tetris-Deluxe')).toEqual({ slug: 'Tetris-Deluxe' });
    expect(matchPattern(p, '/games/caf%C3%A9')).toEqual({ slug: 'café' });
    expect(matchPattern(p, '/games/a%2Fb')).toEqual({ slug: 'a/b' });
    expect(matchPattern(p, '/games')).toBeNull();
    expect(matchPattern(p, '/games/a/b')).toBeNull();
  });

  it('rejects malformed escapes instead of throwing', () => {
    expect(matchPattern(compilePattern('/games/:slug'), '/games/%E0%A4%A')).toBeNull();
  });

  it('supports a trailing wildcard', () => {
    const p = compilePattern('/files/*');
    expect(matchPattern(p, '/files')).toEqual({ wildcard: '' });
    expect(matchPattern(p, '/files/a/b/c')).toEqual({ wildcard: 'a/b/c' });
  });

  it('scores static > param > wildcard', () => {
    const s = compilePattern('/settings/about').score;
    const p = compilePattern('/settings/:section').score;
    const w = compilePattern('/settings/*').score;
    expect(s).toBeGreaterThan(p);
    expect(p).toBeGreaterThan(w);
  });

  it('buildPath encodes params and fills wildcards', () => {
    expect(buildPath('/games/:slug', { slug: 'a b/c' })).toBe('/games/a%20b%2Fc');
    expect(buildPath('/play/:slug', { slug: 42 })).toBe('/play/42');
    expect(buildPath('/files/*', { wildcard: 'x/y' })).toBe('/files/x/y');
    expect(buildPath('/')).toBe('/');
    expect(() => buildPath('/games/:slug')).toThrow(/slug/);
  });
});

describe('route registry (docs/ARCHITECTURE.md §5.1)', () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ['/', 'home', {}],
    ['/browse', 'browse', {}],
    ['/games', 'games', {}],
    ['/games/snake', 'game', { slug: 'snake' }],
    ['/play/snake', 'play', { slug: 'snake' }],
    ['/extensions', 'extensions', {}],
    ['/vpn', 'vpn', {}],
    ['/history', 'history', {}],
    ['/bookmarks', 'bookmarks', {}],
    ['/downloads', 'downloads', {}],
    ['/settings', 'settings', {}],
    ['/settings/appearance', 'settings-section', { section: 'appearance' }],
    ['/about', 'about', {}],
  ];

  it.each(cases)('%s → %s', (path, id, params) => {
    const m = matchRoute(path);
    expect(m.route.id).toBe(id);
    expect(m.params).toEqual(params);
  });

  it('falls back to the not-found page', () => {
    for (const path of ['/nope', '/games/a/b', '/settings/a/b', '/browsex']) {
      const m = matchRoute(path);
      expect(m.route.id).toBe(NOT_FOUND_ID);
      expect(m.params.wildcard).toBe(path);
    }
  });

  it('keeps only the browser persistent and highlights the right rail section', () => {
    expect(allRoutes().filter((r) => r.persistent).map((r) => r.id)).toEqual(['browse']);
    expect(routeById('game')?.section).toBe('games');
    expect(routeById('play')?.section).toBe('games');
    expect(routeById('settings-section')?.section).toBe('settings');
  });

  it('lists rail destinations in order', () => {
    expect(navRoutes('main').map((r) => r.id)).toEqual([
      'home',
      'browse',
      'games',
      'extensions',
      'vpn',
      'history',
      'bookmarks',
      'downloads',
    ]);
    expect(navRoutes('bottom').map((r) => r.id)).toEqual(['settings', 'about']);
    expect(navRoutes('main').filter((r) => r.nav.mobile).length).toBeLessThanOrEqual(4);
  });

  it('splits the nav between the mobile bar and the "More" sheet without losing a destination', () => {
    const { bar, more } = mobileNav();
    expect(bar.map((r) => r.id)).toEqual(['home', 'browse', 'games', 'vpn']);
    expect(more.map((r) => r.id)).toEqual(['extensions', 'history', 'bookmarks', 'downloads', 'settings', 'about']);
    const all = [...navRoutes('main'), ...navRoutes('bottom')].map((r) => r.id).sort();
    expect([...bar, ...more].map((r) => r.id).sort()).toEqual(all);
    // A fifth "mobile" destination does not fit in the bar: it is listed in the sheet instead of disappearing.
    const off = registerRoute({
      id: 'extra',
      path: '/extra',
      title: 'Extra',
      load: () => Promise.reject(new Error('not loaded in tests')),
      nav: { label: 'Extra', icon: navRoutes('main')[0]!.nav.icon, group: 'main', order: 400, mobile: true },
    });
    try {
      expect(mobileNav().bar).toHaveLength(MOBILE_BAR_SLOTS);
      expect(mobileNav().more.map((r) => r.id)).toContain('extra');
    } finally {
      off();
    }
  });

  it('builds paths and titles', () => {
    expect(pathFor('game', { slug: 'snake' })).toBe('/games/snake');
    expect(pathFor('home')).toBe('/');
    expect(() => pathFor('unknown')).toThrow();
    expect(routeTitle(matchRoute('/history').route, {})).toBe('History');
  });

  it('every route lazy-loads a page module', () => {
    for (const r of allRoutes()) expect(typeof r.load).toBe('function');
  });

  it('can be extended by feature teams, most specific pattern first', () => {
    const off = registerRoute({
      id: 'games-category',
      path: '/games/category/:category',
      title: (p) => `Games · ${p.category}`,
      section: 'games',
      load: () => Promise.reject(new Error('not loaded in tests')),
    });
    try {
      const m = matchRoute('/games/category/puzzle');
      expect(m.route.id).toBe('games-category');
      expect(routeTitle(m.route, m.params)).toBe('Games · puzzle');
      expect(matchRoute('/games/snake').route.id).toBe('game');
    } finally {
      off();
    }
    expect(matchRoute('/games/category/puzzle').route.id).toBe(NOT_FOUND_ID);
  });
});

describe('isServerPath', () => {
  it('leaves server-owned paths to the browser', () => {
    for (const p of [
      '/api/config',
      '/api',
      '/admin/',
      '/wisp/',
      '/engine/',
      '/vendor/scramjet/scramjet.js',
      '/~/sj/https%3A%2F%2Fexample.com',
      '/uv/service/x',
      '/sw.js',
      '/assets/index-abc.js',
      '/brand/favicon.ico',
      '/logo.png',
      '/manifest.webmanifest',
    ]) {
      expect(isServerPath(p), p).toBe(true);
    }
  });

  it('routes app paths on the client', () => {
    for (const p of ['/', '/games', '/games/snake', '/settings/appearance', '/apiary', '/engineering', '/browse']) {
      expect(isServerPath(p), p).toBe(false);
    }
  });
});
