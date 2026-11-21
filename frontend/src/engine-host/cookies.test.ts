import { describe, expect, it } from 'vitest';
import { validateCommandResult } from '../shared/engine-protocol';
import { belongsToSite, cookieMatcher, domainMatches, expiredMatcher, parseScramjetDump, scramjetCookieInfos, scramjetCookiesForUv, scramjetToUvRow, setCookieLine, uvCookieInfos, uvRowToScramjet } from './cookies';
import type { ScramjetCookie, UvCookieRow } from './cookies';

const NOW = Date.UTC(2026, 10, 12);
// A real scramjet 2.0.67-alpha.2 jar dump shape (CookieJar.dump()).
const DUMP = JSON.stringify({
  '.httpbin.org@/@sid': { name: 'sid', value: 'abc', domain: '.httpbin.org', path: '/', hostOnly: true, httpOnly: true, secure: true, sameSite: 'lax' },
  '.example.com@/@pref': { name: 'pref', value: 'dark', domain: '.example.com', path: '/', hostOnly: false, expires: NOW + 3_600_000, sameSite: 'Strict' },
  '.example.com@/@old': { name: 'old', value: 'x', domain: '.example.com', path: '/', expires: NOW - 1 },
  '.sub.example.com@/a@deep': { name: 'deep', value: '1', domain: '.sub.example.com', path: '/a' },
});

describe('cookie jars', () => {
  it('parses a Scramjet dump and drops malformed entries', () => {
    expect(Object.keys(parseScramjetDump(DUMP))).toHaveLength(4);
    expect(parseScramjetDump('not json')).toEqual({});
    expect(parseScramjetDump(JSON.stringify({ a: { value: 1 } }))).toEqual({});
  });
  it('matches domains and sites', () => {
    expect(domainMatches('.example.com', 'www.example.com')).toBe(true);
    expect(domainMatches('.example.com', 'example.com')).toBe(true);
    expect(domainMatches('.example.com', 'badexample.com')).toBe(false);
    expect(belongsToSite('.sub.example.com', 'example.com')).toBe(true);
    expect(belongsToSite('.example.com', 'sub.example.com')).toBe(false);
  });
  it('copies the destination host cookies to UV rows, HttpOnly included, expired ones not', () => {
    const jar = parseScramjetDump(DUMP);
    const rows = scramjetCookiesForUv(jar, 'https://sub.example.com/a/b', NOW);
    expect(rows.map((r) => r.id).sort()).toEqual(['.example.com@/@pref', '.sub.example.com@/a@deep']);
    const sid = scramjetCookiesForUv(jar, 'https://httpbin.org/cookies', NOW);
    expect(sid[0]).toMatchObject({ id: '.httpbin.org@/@sid', httpOnly: true, secure: true, value: 'abc' });
  });
  it('round-trips Scramjet ⇄ UV', () => {
    const c: ScramjetCookie = { name: 'n', value: 'v', domain: 'a.example', path: '/p', expires: NOW + 1000, secure: true, httpOnly: false, sameSite: 'None' };
    const back = uvRowToScramjet(scramjetToUvRow(c, NOW));
    expect(back).toMatchObject({ name: 'n', value: 'v', domain: '.a.example', path: '/p', expires: NOW + 1000, secure: true, httpOnly: false, sameSite: 'none' });
  });
  it('reports metadata only, in shapes the protocol accepts', () => {
    const jar = parseScramjetDump(DUMP);
    const sj = scramjetCookieInfos(jar, null, NOW);
    const uv = uvCookieInfos([{ id: '.x.example@/@u', name: 'u', value: 'vvvv', domain: '.x.example', path: '/', secure: false, httpOnly: true, expires: new Date(NOW + 5000).toISOString() }], 'x.example', NOW);
    expect(sj.map((c) => c.name).sort()).toEqual(['deep', 'pref', 'sid']);
    expect(sj.find((c) => c.name === 'sid')).toMatchObject({ size: 3, httpOnly: true, sameSite: 'lax', expires: null });
    expect(uv[0]).toMatchObject({ engine: 'ultraviolet', size: 4, expires: NOW + 5000 });
    expect(validateCommandResult('cookies.list', { cookies: [...sj, ...uv], truncated: false }).ok).toBe(true);
  });
  it('selects what cookies.delete removes', () => {
    const m = cookieMatcher({ all: false, site: 'example.com', name: 'pref' });
    expect(m({ domain: '.example.com', name: 'pref' })).toBe(true);
    expect(m({ domain: '.example.com', name: 'other' })).toBe(false);
    expect(cookieMatcher({ all: false, site: 'example.com', name: null })({ domain: '.sub.example.com', name: 'x' })).toBe(true);
    expect(cookieMatcher({ all: true, site: null, name: null })({ name: 'x' })).toBe(true);
  });
});

describe('expired cookies (cookies.list purges them, WAVE-B3 §6.1)', () => {
  it('expiredMatcher: Expires in either jar, Max-Age after `set` (UV rows)', () => {
    const expired = expiredMatcher(NOW);
    expect(expired({ expires: NOW - 1 })).toBe(true);
    expect(expired({ expires: NOW + 1 })).toBe(false);
    expect(expired({})).toBe(false);
    expect(expired({ expires: new Date(NOW - 1000) })).toBe(true);
    expect(expired({ expires: new Date(NOW - 1000).toUTCString() })).toBe(true);
    expect(expired({ maxAge: 10, set: new Date(NOW - 11_000) })).toBe(true);
    expect(expired({ maxAge: 10, set: new Date(NOW - 9_000) })).toBe(false);
    // Max-Age decides over Expires when both are there (RFC 6265 §5.3)
    expect(expired({ maxAge: 3600, set: NOW - 1000, expires: NOW - 1 })).toBe(false);
  });
  it('uvCookieInfos skips rows expired by Max-Age and reports their computed expiry', () => {
    const rows: UvCookieRow[] = [
      { id: '.a.example@/@gone', name: 'gone', value: '1', domain: '.a.example', path: '/', secure: false, httpOnly: false, maxAge: 5, set: new Date(NOW - 6000) },
      { id: '.a.example@/@live', name: 'live', value: '1', domain: '.a.example', path: '/', secure: false, httpOnly: false, maxAge: 60, set: new Date(NOW - 1000) },
    ];
    const infos = uvCookieInfos(rows, null, NOW);
    expect(infos.map((c) => c.name)).toEqual(['live']);
    expect(infos[0]?.expires).toBe(NOW - 1000 + 60_000);
  });
});

describe('setCookieLine (the lines cookies.delete re-syncs into live Scramjet documents)', () => {
  it('recreates a domain cookie and a host-only one, with their attributes, at a URL the cookie applies to', () => {
    const jar = parseScramjetDump(DUMP);
    expect(setCookieLine(jar['.example.com@/@pref'] as ScramjetCookie)).toEqual({
      url: 'http://example.com/',
      cookie: `pref=dark; Path=/; Domain=example.com; Expires=${new Date(NOW + 3_600_000).toUTCString()}; SameSite=Strict`,
    });
    expect(setCookieLine(jar['.httpbin.org@/@sid'] as ScramjetCookie)).toEqual({ url: 'https://httpbin.org/', cookie: 'sid=abc; Path=/; Secure; HttpOnly; SameSite=lax' });
    expect(setCookieLine(jar['.sub.example.com@/a@deep'] as ScramjetCookie)?.url).toBe('http://sub.example.com/a');
  });

  it('keeps an IPv6 literal in brackets, so the controller’s new URL() takes the line', () => {
    for (const domain of ['[::1]', '.[2001:db8::1]', '::1']) {
      const line = setCookieLine({ name: 'v6', value: '1', domain, path: '/', hostOnly: true });
      expect(line).not.toBeNull();
      expect(() => new URL(line?.url ?? '')).not.toThrow();
      expect(new URL(line?.url ?? '').hostname).toMatch(/^\[[0-9a-f:]+\]$/);
    }
  });

  it('leaves out a cookie no URL can hold (no domain, or one a URL refuses)', () => {
    expect(setCookieLine({ name: 'a', value: '1' })).toBeNull();
    expect(setCookieLine({ name: 'a', value: '1', domain: '.' })).toBeNull();
    expect(setCookieLine({ name: 'a', value: '1', domain: 'bad host' })).toBeNull();
  });
});
