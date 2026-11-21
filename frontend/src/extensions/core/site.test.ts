import { describe, expect, it } from 'vitest';
import { isThirdParty, listDomainOf, siteKeyOf, siteOf } from './site';

describe('siteOf (registrable domain, private suffixes included)', () => {
  it('pins the answers the fixtures and the shield rely on', () => {
    expect(siteOf('http://site-a.localhost:10050/x')).toBe('site-a.localhost');
    expect(siteOf('http://site-b.localhost/')).toBe('site-b.localhost');
    expect(siteOf('http://sub.site-a.localhost/')).toBe('site-a.localhost');
    expect(siteOf('http://localhost:8080/')).toBe('localhost');
    expect(siteOf('http://127.0.0.2/')).toBe('127.0.0.2');
    expect(siteOf('http://[::1]:80/')).toBe('[::1]');
    expect(siteOf('https://www.foo.co.uk/a')).toBe('foo.co.uk');
    expect(siteOf('https://foo.github.io/')).toBe('foo.github.io');
    expect(siteOf('https://bar.github.io/')).toBe('bar.github.io');
    expect(siteOf('https://www.EXAMPLE.com./')).toBe('example.com');
    expect(siteOf('https://bücher.example/')).toBe('xn--bcher-kva.example');
    expect(siteOf('https://xn--bcher-kva.example/')).toBe('xn--bcher-kva.example');
  });

  it('is null for what is not an http(s) URL', () => {
    for (const u of ['about:blank', 'data:text/html,x', 'javascript:1', 'blob:https://a.example/x', 'nonsense', 'file:///etc/passwd']) {
      expect(siteOf(u)).toBeNull();
    }
  });

  it('keeps foo.github.io apart from bar.github.io in party checks', () => {
    expect(isThirdParty('https://foo.github.io/a.js', 'https://bar.github.io/')).toBe(true);
    expect(isThirdParty('https://cdn.foo.co.uk/a.js', 'https://www.foo.co.uk/')).toBe(false);
    expect(isThirdParty('http://ads.localhost/ad.js', 'http://site-a.localhost/')).toBe(true);
    expect(isThirdParty('https://a.example/', null)).toBeNull();
    expect(isThirdParty('about:blank', 'https://a.example/')).toBeNull();
  });

  it('listDomainOf uses tldts defaults (as Ghostery computes it)', () => {
    expect(listDomainOf('foo.github.io')).toBe('github.io');
    expect(listDomainOf('www.foo.co.uk')).toBe('foo.co.uk');
    expect(listDomainOf('localhost')).toBe('localhost');
  });

  it('siteKeyOf writes *.<site>, or the bare IP', () => {
    expect(siteKeyOf('https://www.example.com/')).toBe('*.example.com');
    expect(siteKeyOf('https://foo.github.io/')).toBe('*.foo.github.io');
    expect(siteKeyOf('http://site-a.localhost:10050/')).toBe('*.site-a.localhost');
    expect(siteKeyOf('http://127.0.0.2:80/')).toBe('127.0.0.2');
    expect(siteKeyOf('http://[::1]/')).toBe('[::1]');
    expect(siteKeyOf('about:blank')).toBeNull();
  });
});
