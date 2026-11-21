import { beforeAll, describe, expect, it } from 'vitest';
import {
  displayUrl,
  hostOf,
  internalPath,
  isKnownTld,
  isTldListLoaded,
  isValidSearchTemplate,
  loadTldList,
  monogram,
  normalizeLinkUrl,
  parseOmnibox,
  searchUrl,
  type SearchOptions,
} from './url';
import { TLD_COUNT, TLDS } from './tlds';

const DDG: SearchOptions = { searchEngine: 'duckduckgo', customSearchUrl: '' };
const ddg = (q: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

beforeAll(async () => {
  await loadTldList();
});

function url(input: string): string | undefined {
  const r = parseOmnibox(input, DDG);
  return r?.kind === 'url' ? r.href : undefined;
}

function kind(input: string): string | undefined {
  return parseOmnibox(input, DDG)?.kind;
}

describe('TLD list', () => {
  it('is loaded lazily and complete', () => {
    expect(isTldListLoaded()).toBe(true);
    expect(TLDS.size).toBe(TLD_COUNT);
    expect(TLDS.has('com')).toBe(true);
    expect(TLDS.has('xn--p1ai')).toBe(true); // .рф
  });

  it('knows new gTLDs and rejects made-up ones', () => {
    for (const tld of ['app', 'dev', 'xyz', 'photography', 'museum', 'zip', 'MOV']) expect(isKnownTld(tld)).toBe(true);
    for (const tld of ['txt', 'js', 'local', 'internal', 'b', 'exe']) expect(isKnownTld(tld)).toBe(false);
    expect(isKnownTld('onion')).toBe(true); // special-use, not in the root zone
  });
});

describe('parseOmnibox: bare hosts', () => {
  it('upgrades scheme-less domains to https with an http fallback', () => {
    expect(parseOmnibox('example.com', DDG)).toEqual({
      kind: 'url',
      href: 'https://example.com/',
      fallbackHref: 'http://example.com/',
    });
  });

  it('keeps paths, queries and fragments', () => {
    expect(url('example.com/a/b?q=1&r=2#frag')).toBe('https://example.com/a/b?q=1&r=2#frag');
    expect(url('news.ycombinator.com/item?id=1')).toBe('https://news.ycombinator.com/item?id=1');
  });

  it('lower-cases hosts and accepts multi-label and new gTLD domains', () => {
    expect(url('EXAMPLE.COM')).toBe('https://example.com/');
    expect(url('www.bbc.co.uk')).toBe('https://www.bbc.co.uk/');
    expect(url('svelte.dev')).toBe('https://svelte.dev/');
    expect(url('my-site.photography/gallery')).toBe('https://my-site.photography/gallery');
    expect(url('example.museum')).toBe('https://example.museum/');
    expect(url('exa_mple.com')).toBe('https://exa_mple.com/');
    expect(url('duckduckgo.onion')).toBe('https://duckduckgo.onion/');
  });

  it('accepts explicit ports on domains', () => {
    expect(url('example.com:8443/x')).toBe('https://example.com:8443/x');
  });

  it('treats unknown TLDs, file names and numbers as searches', () => {
    for (const q of ['node.js', 'notes.txt', 'printer.local', 'foo.bar.notatld', 'a.b', '3.14', '1.2.3']) {
      expect(parseOmnibox(q, DDG)).toEqual({ kind: 'search', href: ddg(q), query: q });
    }
  });

  it('rejects invalid labels and ports', () => {
    expect(kind('-example.com')).toBe('search');
    expect(kind('example-.com')).toBe('search');
    expect(kind('example.com:99999')).toBe('search');
    expect(kind('example.com:0')).toBe('search');
    expect(kind(':8080')).toBe('search');
  });

  it('treats e-mail addresses and userinfo without a scheme as searches', () => {
    expect(kind('someone@example.com')).toBe('search');
    expect(kind('example.com@evil.example')).toBe('search');
  });

  it('keeps a trailing dot (fully qualified name)', () => {
    expect(url('example.com.')).toBe('https://example.com./');
  });
});

describe('parseOmnibox: localhost and IP literals', () => {
  it('uses http for localhost, with ports and paths', () => {
    expect(parseOmnibox('localhost', DDG)).toEqual({ kind: 'url', href: 'http://localhost/' });
    expect(url('localhost:3000')).toBe('http://localhost:3000/');
    expect(url('localhost:5173/app?x=1')).toBe('http://localhost:5173/app?x=1');
    expect(url('api.localhost:8080')).toBe('http://api.localhost:8080/');
  });

  it('accepts IPv4 with ports and rejects malformed addresses', () => {
    expect(url('127.0.0.1')).toBe('http://127.0.0.1/');
    expect(url('192.168.1.1:8080/admin')).toBe('http://192.168.1.1:8080/admin');
    expect(kind('256.1.1.1')).toBe('search');
    expect(kind('01.2.3.4')).toBe('search');
    expect(kind('1.2.3.4.5')).toBe('search');
  });

  it('accepts IPv6 literals, bare and bracketed, with ports', () => {
    expect(url('::1')).toBe('http://[::1]/');
    expect(url('2001:db8::1')).toBe('http://[2001:db8::1]/');
    expect(url('[::1]:8080')).toBe('http://[::1]:8080/');
    expect(url('[2001:db8::1]:443/x')).toBe('http://[2001:db8::1]:443/x');
    expect(kind('[zz::1]')).toBe('search');
  });

  it('accepts single-label intranet hosts only with a port or trailing slash', () => {
    expect(url('intranet:8080')).toBe('http://intranet:8080/');
    expect(url('intranet/')).toBe('http://intranet/');
    expect(kind('intranet')).toBe('search');
    expect(kind('intranet/page')).toBe('search');
  });
});

describe('parseOmnibox: explicit schemes', () => {
  it('keeps http and https URLs (normalized by the URL parser)', () => {
    expect(parseOmnibox('http://example.com', DDG)).toEqual({ kind: 'url', href: 'http://example.com/' });
    expect(url('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
    expect(url('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(url('http:example.com')).toBe('http://example.com/');
    expect(url('https://user:pw@example.com/')).toBe('https://user:pw@example.com/');
  });

  it('never opens other schemes: they become searches', () => {
    for (const q of [
      'javascript:alert(1)',
      'JavaScript:void(0)',
      'data:text/html,<b>x</b>',
      'file:///etc/passwd',
      'mailto:someone@example.com',
      'ftp://example.com',
      'view-source:https://example.com',
      'chrome://settings',
      'blob:https://example.com/uuid',
    ]) {
      expect(parseOmnibox(q, DDG)).toEqual({ kind: 'search', href: ddg(q), query: q });
    }
  });

  it('treats broken http URLs as searches', () => {
    expect(kind('http://')).toBe('search');
    expect(kind('https://exa mple.com')).toBe('search');
  });

  it('allows about:blank', () => {
    expect(parseOmnibox('about:blank', DDG)).toEqual({ kind: 'url', href: 'about:blank' });
    expect(normalizeLinkUrl('about:blank')).toBeNull();
  });
});

describe('parseOmnibox: gnome:// pages', () => {
  it('maps internal pages to routes', () => {
    expect(parseOmnibox('gnome://settings', DDG)).toEqual({ kind: 'internal', href: '/settings' });
    expect(parseOmnibox('gnome://settings/appearance', DDG)?.href).toBe('/settings/appearance');
    expect(parseOmnibox('GNOME://Games/', DDG)?.href).toBe('/games');
    expect(parseOmnibox('gnome:history', DDG)?.href).toBe('/history');
    expect(parseOmnibox('gnome://browser', DDG)?.href).toBe('/browse');
    expect(parseOmnibox('gnome://settings?q=theme#motion', DDG)?.href).toBe('/settings?q=theme#motion');
  });

  it('maps home aliases to the root', () => {
    for (const alias of ['gnome://', 'gnome://home', 'gnome://newtab', 'gnome://start']) {
      expect(parseOmnibox(alias, DDG)).toEqual({ kind: 'internal', href: '/' });
    }
    expect(internalPath('home?x=1')).toBe('/?x=1');
  });

  it('encodes odd path segments instead of passing them through', () => {
    expect(internalPath('games/a b')).toBe('/games/a%20b');
    expect(internalPath('../../etc')).toBe('/etc');
    expect(internalPath('settings/%2e%2e/x')).toBe('/settings/x');
  });
});

describe('parseOmnibox: searches', () => {
  it('searches anything with whitespace before the host part ends', () => {
    expect(parseOmnibox('how to tie a knot', DDG)).toEqual({
      kind: 'search',
      href: 'https://duckduckgo.com/?q=how%20to%20tie%20a%20knot',
      query: 'how to tie a knot',
    });
    expect(kind('what is example.com')).toBe('search');
    expect(kind('example.com /path')).toBe('search');
  });

  it('keeps addresses whose path contains spaces', () => {
    expect(url('example.com/some page')).toBe('https://example.com/some%20page');
    expect(url('example.com/search?q=a b')).toBe('https://example.com/search?q=a%20b');
    expect(url('localhost:3000/a b')).toBe('http://localhost:3000/a%20b');
  });

  it('forces a search with a leading "?"', () => {
    expect(parseOmnibox('?example.com', DDG)).toEqual({ kind: 'search', href: ddg('example.com'), query: 'example.com' });
    expect(parseOmnibox('?', DDG)).toBeNull();
    expect(parseOmnibox('?   ', DDG)).toBeNull();
  });

  it('trims whitespace and zero-width characters, and ignores empty input', () => {
    expect(url('  example.com  ')).toBe('https://example.com/');
    expect(url('​example.com﻿')).toBe('https://example.com/');
    expect(parseOmnibox('', DDG)).toBeNull();
    expect(parseOmnibox(' \t\n', DDG)).toBeNull();
  });

  it('encodes search terms safely', () => {
    const q = 'a&b=c #d %s 100%';
    expect(parseOmnibox(q, DDG)?.href).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`);
    expect(parseOmnibox('"quoted" words', DDG)?.href).toBe('https://duckduckgo.com/?q=%22quoted%22%20words');
  });
});

describe('IDN', () => {
  it('converts internationalized domains to punycode', () => {
    expect(url('münchen.de')).toBe('https://xn--mnchen-3ya.de/');
    expect(url('例え.jp/パス')).toBe('https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9');
    expect(url('пример.рф')).toBe('https://xn--e1afmkfd.xn--p1ai/');
  });
});

describe('search templates', () => {
  it('uses the configured engine', () => {
    expect(searchUrl('a b', { searchEngine: 'google', customSearchUrl: '' })).toBe('https://www.google.com/search?q=a%20b');
    expect(searchUrl('x', { searchEngine: 'brave', customSearchUrl: '' })).toBe('https://search.brave.com/search?q=x');
    expect(searchUrl('x', { searchEngine: 'startpage', customSearchUrl: '' })).toBe('https://www.startpage.com/do/search?q=x');
    expect(searchUrl('x', { searchEngine: 'ecosia', customSearchUrl: '' })).toBe('https://www.ecosia.org/search?q=x');
    expect(searchUrl('x', { searchEngine: 'bing', customSearchUrl: '' })).toBe('https://www.bing.com/search?q=x');
  });

  it('supports custom templates with one or more %s', () => {
    const opts: SearchOptions = { searchEngine: 'custom', customSearchUrl: 'https://search.example/find?term=%s&again=%s' };
    expect(searchUrl('a b', opts)).toBe('https://search.example/find?term=a%20b&again=a%20b');
    expect(parseOmnibox('two words', opts)?.href).toBe('https://search.example/find?term=two%20words&again=two%20words');
  });

  it('does not re-expand %s that appears in the query', () => {
    const opts: SearchOptions = { searchEngine: 'custom', customSearchUrl: 'https://s.example/?q=%s' };
    expect(searchUrl('%s', opts)).toBe('https://s.example/?q=%25s');
  });

  it('falls back to DuckDuckGo for unusable custom templates', () => {
    for (const t of ['', 'https://s.example/?q=', 'javascript:%s', 'ftp://s.example/%s', 'not a url %s']) {
      expect(isValidSearchTemplate(t)).toBe(false);
      expect(searchUrl('x', { searchEngine: 'custom', customSearchUrl: t })).toBe('https://duckduckgo.com/?q=x');
    }
    expect(isValidSearchTemplate('http://s.example/?q=%s')).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizeLinkUrl only returns http(s) addresses', () => {
    expect(normalizeLinkUrl('example.com')).toBe('https://example.com/');
    expect(normalizeLinkUrl('http://localhost:8080')).toBe('http://localhost:8080/');
    expect(normalizeLinkUrl('some words')).toBeNull();
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('gnome://settings')).toBeNull();
  });

  it('displayUrl drops the https scheme, www. and a lone slash', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com');
    expect(displayUrl('https://example.com/a%20b?q=%C3%BC')).toBe('example.com/a b?q=ü');
    expect(displayUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(displayUrl('https://example.com:8443/')).toBe('example.com:8443');
    expect(displayUrl('about:blank')).toBe('about:blank');
    expect(displayUrl('not a url')).toBe('not a url');
  });

  it('displayUrl keeps spoofing characters encoded (bidi overrides, invisible and control characters)', () => {
    // "…/%E2%80%AEfdp.exe" would render right-to-left as "exe.pdf" if decoded.
    expect(displayUrl('https://example.com/%E2%80%AEfdp.exe')).toBe('example.com/%E2%80%AEfdp.exe');
    expect(displayUrl('https://example.com/a%E2%80%8Bb%C2%ADc%E2%81%A6d')).toBe('example.com/a%E2%80%8Bb%C2%ADc%E2%81%A6d');
    expect(displayUrl('https://example.com/%07bell%7F')).toBe('example.com/%07bell%7F');
    expect(displayUrl('https://example.com/caf%C3%A9')).toBe('example.com/café');
  });

  it('hostOf and monogram', () => {
    expect(hostOf('https://www.example.com/x')).toBe('example.com');
    expect(hostOf('nonsense')).toBe('');
    expect(monogram('Wikipedia', 'https://www.wikipedia.org/')).toBe('W');
    expect(monogram('  ', 'https://github.com/')).toBe('G');
    expect(monogram('ölmühle', 'https://x.de/')).toBe('Ö');
    expect(monogram(null, 'garbage')).toBe('•');
  });
});
