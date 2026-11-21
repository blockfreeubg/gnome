import { describe, expect, it } from 'vitest';
import { composeHooks } from '../core/compose';
import { createPrivacyProvider } from '../privacy/provider';
import {
  LAX_POST_MS,
  UV_SCRIPT_COOKIE_DESTINATIONS,
  blankUvScriptCookies,
  createCookieProvider,
  deletesCookie,
  domainMatch,
  pathMatch,
  sameSiteAllows,
  sameSiteMode,
  sessionizeSetCookie,
  setCookieAcceptable,
  fixUvCookies,
  uvCookieHeader,
  uvFetchMetadata,
  uvSameSiteRequest,
  verdictBlocksCookies,
} from './provider';
import type { SameSiteMode, SameSiteRequest, StoredCookie } from './provider';
import { contextFor, request, settings, topDocument } from '../privacy/testing';
import type { RequestInfo, ResponseHeaders } from '../../shared/engine-hooks';
import type { BlockerSettings } from '../core/policy';

const A = 'https://site-a.example';
const B = 'https://site-b.example';
const T = 'https://trk.example';

/** A ResponseHeaders over a list of pairs, like tabs.ts rawHeadersBag (one pair per Set-Cookie line). */
function bag(pairs: Array<[string, string]>): ResponseHeaders & { pairs: Array<[string, string]> } {
  const lc = (n: string) => n.toLowerCase();
  return {
    pairs,
    get: (n) => pairs.find(([k]) => lc(k) === lc(n))?.[1] ?? null,
    getAll: (n) => pairs.filter(([k]) => lc(k) === lc(n)).map(([, v]) => v),
    set: (n, v) => {
      for (let i = pairs.length - 1; i >= 0; i--) if (lc(pairs[i]?.[0] ?? '') === lc(n)) pairs.splice(i, 1);
      pairs.push([n, v]);
    },
    append: (n, v) => {
      pairs.push([n, v]);
    },
    delete: (n) => {
      for (let i = pairs.length - 1; i >= 0; i--) if (lc(pairs[i]?.[0] ?? '') === lc(n)) pairs.splice(i, 1);
    },
  };
}

function onRequest(s: BlockerSettings, req: RequestInfo) {
  const top = req.isTopLevelDocument ? req.url : req.topLevelUrl;
  return createCookieProvider().onRequest?.(req, contextFor(s, req.url, top)) ?? null;
}

function onResponse(s: BlockerSettings, req: RequestInfo, lines: string[], now = Date.parse('2026-11-19T12:00:00Z')) {
  const top = req.isTopLevelDocument ? req.url : req.topLevelUrl;
  const h = bag([['content-type', 'text/html'], ...lines.map((l): [string, string] => ['Set-Cookie', l])]);
  createCookieProvider({ now: () => now }).onResponse?.({ ...req, status: 200 }, h, contextFor(s, req.url, top));
  return h.getAll('set-cookie');
}

const blocked = (s: BlockerSettings, req: RequestInfo): boolean => {
  const v = onRequest(s, req);
  return !!v && v.action === 'allow' && (v.headers?.remove ?? []).includes('cookie');
};

describe('createCookieProvider: modes × rules × party (D4)', () => {
  type Mode = 'all' | 'block-third-party' | 'block-all';
  type Rule = 'allow' | 'session' | 'block' | null;
  type Party = 'first' | 'third' | 'unknown';
  const cases: Array<[Mode, Rule, Party, boolean]> = [];
  for (const mode of ['all', 'block-third-party', 'block-all'] as Mode[]) {
    for (const rule of [null, 'allow', 'session', 'block'] as Rule[]) {
      for (const party of ['first', 'third', 'unknown'] as Party[]) {
        const want = rule === 'allow' || rule === 'session' ? false : rule === 'block' ? true : mode === 'block-all' ? true : mode === 'block-third-party' ? party !== 'first' : false;
        cases.push([mode, rule, party, want]);
      }
    }
  }
  it.each(cases)('mode %s, rule %s, %s party → blocked %s', (mode, rule, party, want) => {
    const s = settings({ privacy: { cookies: mode }, extensions: { cookieRules: rule ? { '*.trk.example': rule } : {} } });
    const req = request({ url: `${T}/pixel`, topLevelUrl: party === 'first' ? `${T}/` : party === 'third' ? `${A}/` : null });
    expect(blocked(s, req)).toBe(want);
    const kept = onResponse(s, req, ['t=1; Path=/']);
    expect(kept.length === 0).toBe(want);
  });

  it('cookie manager off: modes and rules are ignored (cookies as the engines handle them)', () => {
    const s = settings({ enabled: { cookies: false }, privacy: { cookies: 'block-all' }, extensions: { cookieRules: { '*.trk.example': 'block' } } });
    expect(blocked(s, request({ url: `${T}/p`, topLevelUrl: `${A}/` }))).toBe(false);
    expect(onResponse(s, request({ url: `${T}/p`, topLevelUrl: `${A}/` }), ['t=1'])).toEqual(['t=1']);
  });

  it('rules are keyed by the cookie site, in every context: block strips first-party cookies too', () => {
    const s = settings({ privacy: { cookies: 'all' }, extensions: { cookieRules: { '*.site-a.example': 'block' } } });
    expect(blocked(s, topDocument(`${A}/`))).toBe(true);
    expect(blocked(s, request({ url: `${A}/api`, topLevelUrl: `${B}/` }))).toBe(true);
    expect(blocked(s, request({ url: `${B}/api`, topLevelUrl: `${A}/` }))).toBe(false);
  });

  it('a tab document is judged under itself: cross-site navigations keep their own cookies (D3, OAuth)', () => {
    const s = settings({ privacy: { cookies: 'block-third-party' } });
    // site-a → IdP → site-a/callback: every hop is the tab's own document.
    expect(blocked(s, topDocument('https://idp.example/authorize', { topLevelUrl: `${A}/` }))).toBe(false);
    expect(blocked(s, topDocument(`${A}/callback?code=1`, { topLevelUrl: 'https://idp.example/authorize' }))).toBe(false);
    expect(onResponse(s, topDocument(`${A}/callback?code=1`, { topLevelUrl: 'https://idp.example/' }), ['session=abc; Path=/; HttpOnly'])).toEqual(['session=abc; Path=/; HttpOnly']);
  });

  it('the allowlist does not exempt a site from cookie rules', () => {
    const s = settings({ extensions: { allowlist: ['*.site-a.example'] } });
    expect(blocked(s, request({ url: `${T}/p`, topLevelUrl: `${A}/` }))).toBe(true);
  });

  it('a session rule rewrites every line, keeps deleting lines, and appends one header per cookie', () => {
    const s = settings({ extensions: { cookieRules: { '*.site-a.example': 'session' } } });
    const out = onResponse(s, topDocument(`${A}/`), ['a=1; Max-Age=3600; Path=/', 'b=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Secure', 'c=; Max-Age=0', 'd=; expires=Thu, 01-Jan-1970 00:00:01 GMT']);
    expect(out).toEqual(['a=1; Path=/', 'b=2; Secure', 'c=; Max-Age=0', 'd=; expires=Thu, 01-Jan-1970 00:00:01 GMT']);
  });

  it('a header line is one cookie, as in browsers and both engines: a comma in a value or a date never splits it', () => {
    const s = settings({ privacy: { cookies: 'all' } });
    // A value with `,name=` in it stays one cookie (both engines parse each line as one; splitting would store two).
    expect(onResponse(s, topDocument(`${A}/`), ['prefs=k1=v1,k2=v2; Path=/'])).toEqual(['prefs=k1=v1,k2=v2; Path=/']);
    const session = settings({ extensions: { cookieRules: { '*.site-a.example': 'session' } } });
    expect(onResponse(session, topDocument(`${A}/`), ['a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/'])).toEqual(['a=1; Path=/']);
  });

  it('leaves the headers alone when nothing changes', () => {
    const s = settings({ privacy: { cookies: 'all' } });
    const h = bag([['Set-Cookie', 'a=1'], ['X-Other', 'y'], ['Set-Cookie', 'b=2']]);
    createCookieProvider().onResponse?.({ ...topDocument(`${A}/`), status: 200 }, h, contextFor(s, `${A}/`, `${A}/`));
    expect(h.pairs).toEqual([['Set-Cookie', 'a=1'], ['X-Other', 'y'], ['Set-Cookie', 'b=2']]);
  });
});

describe('Set-Cookie lines a browser refuses (both engines store them)', () => {
  it.each([
    // [line, response URL, accepted]
    ['a=1', `${A}/`, true],
    ['a=1; Domain=site-a.example', `${A}/`, true],
    ['a=1; Domain=.site-a.example', 'https://www.site-a.example/', true],
    ['a=1; Domain=www.site-a.example', 'https://www.site-a.example/', true],
    ['a=1; Domain=WWW.Site-A.example', 'https://www.site-a.example/', true],
    // another site, a sibling, a public suffix
    ['a=1; Domain=site-b.example', `${A}/`, false],
    ['a=1; Domain=other.site-a.example', 'https://www.site-a.example/', false],
    ['a=1; Domain=example', `${A}/`, false],
    ['a=1; Domain=co.uk', 'https://shop.co.uk/', false],
    ['a=1; Domain=github.io', 'https://foo.github.io/', false],
    ['a=1; Domain=localhost', 'http://site-a.localhost/', false],
    ['a=1; Domain=site-a.localhost', 'http://www.site-a.localhost/', true],
    ['a=1; Domain=evil-site-a.example', `${A}/`, false],
    // the last Domain wins; an empty one means host-only
    ['a=1; Domain=site-b.example; Domain=site-a.example', `${A}/`, true],
    ['a=1; Domain=', `${A}/`, true],
    // IP hosts: only the host itself
    ['a=1; Domain=127.0.0.1', 'http://127.0.0.1:8080/', true],
    ['a=1; Domain=0.0.1', 'http://127.0.0.1/', false],
    // prefixes and Secure
    ['__Secure-a=1; Secure', `${A}/`, true],
    ['__Secure-a=1', `${A}/`, false],
    ['__secure-a=1', `${A}/`, false],
    ['__Host-a=1; Secure; Path=/', `${A}/`, true],
    ['__Host-a=1; Secure; Path=/; Domain=site-a.example', `${A}/`, false],
    ['__Host-a=1; Secure', `${A}/`, false],
    ['__Host-a=1; Path=/', `${A}/`, false],
    ['a=1; Secure', 'http://site-a.example/', false],
    ['a=1; Secure', 'http://site-a.localhost/', true],
    ['a=1; Secure', 'http://127.0.0.1/', true],
    ['', `${A}/`, false],
  ] as const)('%s from %s → %s', (line, url, ok) => {
    expect(setCookieAcceptable(line, url)).toBe(ok);
  });

  it('the provider drops refused lines also while the cookie manager is off', () => {
    for (const s of [settings({ privacy: { cookies: 'all' } }), settings({ enabled: { cookies: false } })]) {
      expect(onResponse(s, topDocument(`${B}/`), ['sid=evil; Domain=site-a.example; Path=/', 'own=1'])).toEqual(['own=1']);
    }
  });
});

describe('sessionizeSetCookie and deletesCookie', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  it('removes Expires and Max-Age in every spelling', () => {
    expect(sessionizeSetCookie('a=1; max-age=60; Path=/', now)).toBe('a=1; Path=/');
    expect(sessionizeSetCookie('a=1;MAX-AGE=60;path=/', now)).toBe('a=1;path=/');
    expect(sessionizeSetCookie('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly', now)).toBe('a=1; HttpOnly');
    expect(sessionizeSetCookie('a=1; expires=Sun, 06-Nov-2094 08:49:37 GMT', now)).toBe('a=1');
    expect(sessionizeSetCookie('a=1', now)).toBe('a=1');
    expect(sessionizeSetCookie('a=x=y; Max-Age=5', now)).toBe('a=x=y');
  });
  it('keeps a deleting line as it is', () => {
    for (const l of ['a=; Max-Age=0', 'a=; Max-Age=-1; Path=/', 'a=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'a=; expires=Thu, 01-Jan-1970 00:00:01 GMT']) {
      expect(deletesCookie(l, now)).toBe(true);
      expect(sessionizeSetCookie(l, now)).toBe(l);
    }
  });
  it('Max-Age wins over Expires; an invalid Max-Age is ignored', () => {
    expect(deletesCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60', now)).toBe(false);
    expect(deletesCookie('a=1; Max-Age=soon; Expires=Thu, 01 Jan 1970 00:00:00 GMT', now)).toBe(true);
    expect(deletesCookie('a=1; Max-Age=soon', now)).toBe(false);
    expect(deletesCookie('a=1; Expires=not a date', now)).toBe(false);
  });
});

describe('SameSite: sameSiteMode (the browser rules)', () => {
  const base = (over: Partial<SameSiteRequest> & { url: string }): SameSiteRequest => ({
    method: 'GET',
    isTopLevelDocument: false,
    destination: '',
    topLevelUrl: `${A}/`,
    initiator: `${A}/`,
    ...over,
  });
  it.each([
    // tab documents
    ['GNOME’s own load (address bar, bookmark, reload)', base({ url: `${A}/`, isTopLevelDocument: true, destination: 'document', initiator: '' }), 'strict'],
    ['a same-site link', base({ url: `${A}/x`, isTopLevelDocument: true, initiator: 'https://www.site-a.example/' }), 'strict'],
    ['a cross-site link (GET)', base({ url: `${A}/x`, isTopLevelDocument: true, initiator: `${B}/` }), 'lax'],
    ['a cross-site link without referrer (unknown initiator)', base({ url: `${A}/x`, isTopLevelDocument: true, initiator: null }), 'lax'],
    ['a cross-site top-level POST', base({ url: `${A}/login`, isTopLevelDocument: true, method: 'POST', initiator: 'https://idp.example/' }), 'cross-site'],
    ['a same-site top-level POST', base({ url: `${A}/login`, isTopLevelDocument: true, method: 'POST', initiator: `${A}/form` }), 'strict'],
    // frames and subresources
    ['a same-site subresource', base({ url: `${A}/api` }), 'strict'],
    ['a same-site subresource from a cross-site frame', base({ url: `${A}/api`, initiator: `${B}/frame` }), 'cross-site'],
    ['a subresource of another site', base({ url: `${B}/api` }), 'cross-site'],
    ['a same-site frame inside another site', base({ url: `${B}/frame`, destination: 'iframe', topLevelUrl: `${A}/`, initiator: `${B}/x` }), 'cross-site'],
    ['a same-site frame', base({ url: `${A}/frame`, destination: 'iframe' }), 'strict'],
    ['a frame navigated by a cross-site page', base({ url: `${A}/frame`, destination: 'iframe', initiator: `${B}/` }), 'cross-site'],
    ['unknown tab (no top-level page)', base({ url: `${A}/api`, topLevelUrl: null }), 'cross-site'],
    ['unknown initiator of a subresource', base({ url: `${A}/api`, initiator: null }), 'cross-site'],
    ['an engine-host fetch for a page (favicon, download) with that page as initiator', base({ url: `${A}/favicon.ico`, topLevelUrl: `${B}/`, initiator: `${B}/` }), 'cross-site'],
    ['not http(s)', base({ url: 'data:text/plain,x' }), 'cross-site'],
  ] as const)('%s → %s', (_label, r, want) => {
    expect(sameSiteMode(r)).toBe(want);
  });
});

describe('SameSite: sameSiteAllows', () => {
  const now = 1_000_000_000;
  const get = { isTopLevelDocument: true, method: 'GET' };
  const post = { isTopLevelDocument: true, method: 'POST' };
  const sub = { isTopLevelDocument: false, method: 'POST' };
  const c = (sameSite: string | undefined, extra: Partial<StoredCookie> = {}): StoredCookie => ({ name: 'n', value: 'v', domain: '.site-a.example', path: '/', secure: true, ...(sameSite === undefined ? {} : { sameSite }), ...extra });
  const table: Array<[string, StoredCookie, SameSiteMode, typeof get, boolean]> = [
    ['Strict / strict', c('Strict'), 'strict', get, true],
    ['Strict / lax', c('Strict'), 'lax', get, false],
    ['Strict / cross-site', c('strict'), 'cross-site', get, false],
    ['Lax / lax', c('Lax'), 'lax', get, true],
    ['Lax / cross-site', c('Lax'), 'cross-site', get, false],
    ['None+Secure / cross-site', c('None'), 'cross-site', sub, true],
    ['None without Secure counts as Lax', c('None', { secure: false }), 'cross-site', sub, false],
    ['None without Secure / lax', c('None', { secure: false }), 'lax', get, true],
    ['unspecified = Lax by default / lax', c(undefined), 'lax', get, true],
    ['unspecified / cross-site subresource', c(undefined), 'cross-site', sub, false],
    ['invalid value = unspecified', c('bogus', { set: now - 1000 }), 'cross-site', post, true],
    ['Lax+POST: unspecified, fresh, top-level POST', c(undefined, { set: now - 1000 }), 'cross-site', post, true],
    ['Lax+POST: too old', c(undefined, { set: now - LAX_POST_MS }), 'cross-site', post, false],
    ['Lax+POST: not for an explicit Lax', c('Lax', { set: now - 1000 }), 'cross-site', post, false],
    ['Lax+POST: not for subresources', c(undefined, { set: now - 1000 }), 'cross-site', sub, false],
    ['Lax+POST: no set time', c(undefined), 'cross-site', post, false],
    ['Lax+POST: a Date set time', c(undefined, { set: new Date(now - 5000) }), 'cross-site', post, true],
  ];
  it.each(table)('%s', (_l, cookie, mode, req, want) => {
    expect(sameSiteAllows(cookie, mode, req, now)).toBe(want);
  });
});

describe('uvCookieHeader (what Ultraviolet should send)', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const rows: StoredCookie[] = [
    { name: 'xs_strict', value: '1', domain: '.site-a.example', path: '/', secure: false, httpOnly: false, sameSite: 'Strict', set: now - 60_000 },
    { name: 'xs_lax', value: '1', domain: '.site-a.example', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', set: now - 60_000 },
    { name: 'plain', value: '2', domain: '.site-a.example', path: '/', set: now - 600_000 },
    { name: 'none', value: '3', domain: '.site-a.example', path: '/', secure: true, sameSite: 'None', set: now - 600_000 },
    { name: 'http', value: '4', domain: '.site-a.example', path: '/', httpOnly: true, sameSite: 'Lax', set: now - 600_000 },
    { name: 'deep', value: '5', domain: '.site-a.example', path: '/app', set: now - 600_000 },
    { name: 'sec', value: '6', domain: '.site-a.example', path: '/', secure: true, set: now - 600_000 },
    { name: 'old', value: '7', domain: '.site-a.example', path: '/', expires: new Date(now - 1), set: now - 600_000 },
    { name: 'aged', value: '8', domain: '.site-a.example', path: '/', maxAge: 10, set: new Date(now - 11_000) },
    { name: 'other', value: '9', domain: '.evilsite-a.example', path: '/', set: now - 600_000 },
    { name: 'host', value: '10', domain: 'www.site-a.example', path: '/', set: now - 600_000 },
  ];
  const opts = (forScript = false, request = { isTopLevelDocument: true, method: 'GET' }) => ({ forScript, request, now });

  it('GNOME’s own load or a same-site request: every matching cookie', () => {
    expect(uvCookieHeader(rows, `${A}/`, 'strict', opts())).toBe('xs_strict=1; xs_lax=1; plain=2; none=3; http=4; sec=6');
  });
  it('a cross-site link: no Strict cookie', () => {
    expect(uvCookieHeader(rows, `${A}/`, 'lax', opts())).toBe('xs_lax=1; plain=2; none=3; http=4; sec=6');
  });
  it('a cross-site subresource (favicon, <a download>, an image): only SameSite=None', () => {
    expect(uvCookieHeader(rows, `${A}/favicon.ico`, 'cross-site', opts(false, { isTopLevelDocument: false, method: 'GET' }))).toBe('none=3');
  });
  it('matches paths, Secure, hosts and expiry like a browser (UV matched only the end of the host name)', () => {
    expect(uvCookieHeader(rows, `${A}/app/x`, 'strict', opts())).toContain('deep=5');
    expect(uvCookieHeader(rows, `${A}/application`, 'strict', opts())).not.toContain('deep=5');
    expect(uvCookieHeader(rows, 'http://site-a.example/', 'strict', opts())).not.toContain('sec=6');
    expect(uvCookieHeader(rows, 'https://evilsite-a.example/', 'strict', opts())).toBe('other=9');
    expect(uvCookieHeader(rows, 'https://www.site-a.example/', 'strict', opts())).toContain('host=10');
    expect(uvCookieHeader(rows, 'https://x.www.site-a.example/', 'strict', opts())).not.toContain('host=10');
    expect(uvCookieHeader(rows, `${A}/`, 'strict', opts())).not.toMatch(/old=|aged=/);
  });
  it('document.cookie: no HttpOnly cookie', () => {
    expect(uvCookieHeader(rows, `${A}/`, 'strict', opts(true))).toBe('xs_strict=1; xs_lax=1; plain=2; none=3; sec=6');
  });
  it('ignores malformed rows and URLs', () => {
    expect(uvCookieHeader([{ name: 'a', value: 'b' } as StoredCookie, { name: 1 as unknown as string, value: 'x', domain: '.site-a.example' }], `${A}/`, 'strict', opts())).toBe('');
    expect(uvCookieHeader(rows, 'not a url', 'strict', opts())).toBe('');
  });
});

describe('helpers', () => {
  it('domainMatch and pathMatch', () => {
    expect(domainMatch('a.b.example', 'b.example')).toBe(true);
    expect(domainMatch('ab.example', 'b.example')).toBe(false);
    expect(domainMatch('1.2.3.4', '2.3.4')).toBe(false);
    expect(pathMatch('/a/b', '/a')).toBe(true);
    expect(pathMatch('/ab', '/a')).toBe(false);
    expect(pathMatch('/a/', '/a/')).toBe(true);
    expect(pathMatch('/a/b', '/a/')).toBe(true);
  });
});

describe('Ultraviolet glue: fixUvCookies, uvSameSiteRequest, uvFetchMetadata', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  // The rows of the host-smoke row "page-chosen requests" (victim site-a, attacker site-b), as UV stores them (every
  // domain with a leading dot, `set` when stored).
  const rows: StoredCookie[] = [
    { name: 'xs_strict', value: '1', domain: '.site-a.example', path: '/', sameSite: 'Strict', set: new Date(now - 60_000) },
    { name: 'xs_lax', value: '1', domain: '.site-a.example', path: '/', sameSite: 'Lax', set: new Date(now - 60_000) },
    { name: 'h', value: '1', domain: '.site-a.example', path: '/', httpOnly: true, sameSite: 'Lax', set: new Date(now - 60_000) },
  ];
  /** A stand-in for one UV 3.2.10 instance: its own serialize sends every row whose domain the host ends with. */
  const instance = () => ({
    cookie: {
      serialize: (rs: StoredCookie[], meta: { url: URL }, js: boolean) =>
        rs.filter((r) => meta.url.hostname.endsWith(String(r.domain).slice(1)) && !(js && r.httpOnly)).map((r) => `${r.name}=${r.value}`).join('; '),
    },
  });
  const meta = { url: new URL(`${A}/xs/echo`) };
  const info = (over: Partial<RequestInfo>): RequestInfo => request({ engine: 'ultraviolet', tabId: null, url: `${A}/xs/echo`, ...over });

  it('without the fix UV sends both cookies everywhere (the finding)', () => {
    expect(instance().cookie.serialize(rows, meta, false)).toBe('xs_strict=1; xs_lax=1; h=1');
  });

  it('a favicon or <a download> the engine host fetched for site-b’s page: neither cookie', () => {
    const uv = instance();
    const req = uvSameSiteRequest(info({ destination: 'image', topLevelUrl: `${B}/xs/attacker`, documentUrl: `${B}/xs/attacker` }), null);
    expect(fixUvCookies(uv, { request: req, documentCrossSite: true }, () => now)).toBe(true);
    expect(uv.cookie.serialize(rows, meta, false)).toBe('');
  });

  it('an unattributed request (no context): only SameSite=None cookies', () => {
    const uv = instance();
    fixUvCookies(uv, null, () => now);
    expect(uv.cookie.serialize([...rows, { name: 'n', value: '1', domain: '.site-a.example', path: '/', sameSite: 'None', secure: true }], meta, false)).toBe('n=1');
  });

  it('a tab a page asked for (opener site-b): the Lax cookie, never the Strict one', () => {
    const uv = instance();
    const req = uvSameSiteRequest(info({ isTopLevelDocument: true, destination: 'document', topLevelUrl: `${A}/xs/echo`, documentUrl: `${A}/xs/echo` }), `${B}/xs/attacker`);
    fixUvCookies(uv, { request: req, documentCrossSite: false }, () => now);
    expect(uv.cookie.serialize(rows, meta, false)).toBe('xs_lax=1; h=1');
    // its document.cookie (a tab-top document of its own site): every non-HttpOnly cookie
    expect(uv.cookie.serialize(rows, meta, true)).toBe('xs_strict=1; xs_lax=1');
  });

  it('GNOME’s own load: both cookies', () => {
    const uv = instance();
    const req = uvSameSiteRequest(info({ isTopLevelDocument: true, destination: 'document', topLevelUrl: null, documentUrl: `${A}/xs/echo` }), '');
    fixUvCookies(uv, { request: req, documentCrossSite: false }, () => now);
    expect(uv.cookie.serialize(rows, meta, false)).toBe('xs_strict=1; xs_lax=1; h=1');
  });

  it('a cross-site frame’s document.cookie holds only SameSite=None cookies', () => {
    const uv = instance();
    const req = uvSameSiteRequest(info({ destination: 'iframe', topLevelUrl: `${B}/`, documentUrl: `${B}/` }), `${B}/`);
    fixUvCookies(uv, { request: req, documentCrossSite: true }, () => now);
    expect(uv.cookie.serialize([...rows, { name: 'n', value: '1', domain: '.site-a.example', path: '/', sameSite: 'None', secure: true }], meta, true)).toBe('n=1');
  });

  it('a document whose cookies the cookie manager blocks gets an empty document.cookie (the request header is the provider’s)', () => {
    const uv = instance();
    const req = uvSameSiteRequest(info({ destination: 'iframe', topLevelUrl: `${B}/`, documentUrl: `${B}/` }), `${B}/`);
    fixUvCookies(uv, { request: req, documentCrossSite: true, documentBlocked: true }, () => now);
    expect(uv.cookie.serialize([{ name: 'n', value: '1', domain: '.site-a.example', path: '/', sameSite: 'None', secure: true }], meta, true)).toBe('');
  });

  it('leaves an instance of another shape alone', () => {
    expect(fixUvCookies({}, null)).toBe(false);
    expect(fixUvCookies(null, null)).toBe(false);
    expect(fixUvCookies({ cookie: {} }, null)).toBe(false);
  });

  it('uvSameSiteRequest: navigations take the announced initiator, other requests their document', () => {
    expect(uvSameSiteRequest(info({ destination: 'script', documentUrl: `${B}/p`, topLevelUrl: `${B}/` }), 'ignored').initiator).toBe(`${B}/p`);
    expect(uvSameSiteRequest(info({ destination: 'iframe', documentUrl: `${B}/p` }), null).initiator).toBeNull();
    const top = uvSameSiteRequest(info({ isTopLevelDocument: true, destination: 'document', topLevelUrl: `${B}/old` }), '');
    expect(top.topLevelUrl).toBe(`${A}/xs/echo`);
    expect(top.initiator).toBe('');
  });

  it('uvFetchMetadata: as a browser for known initiators, nothing for unknown ones', () => {
    const nav = uvSameSiteRequest(info({ isTopLevelDocument: true, destination: 'document' }), `${B}/xs/attacker`);
    expect(uvFetchMetadata(nav, 'navigate')).toEqual([['sec-fetch-site', 'cross-site'], ['sec-fetch-mode', 'navigate'], ['sec-fetch-dest', 'document']]);
    expect(uvFetchMetadata({ ...nav, initiator: '' }, 'navigate')?.[0]).toEqual(['sec-fetch-site', 'none']);
    expect(uvFetchMetadata({ ...nav, initiator: 'https://www.site-a.example/' }, 'navigate')?.[0]).toEqual(['sec-fetch-site', 'same-site']);
    expect(uvFetchMetadata({ ...nav, initiator: `${A}/other` }, 'navigate')?.[0]).toEqual(['sec-fetch-site', 'same-origin']);
    expect(uvFetchMetadata({ ...nav, initiator: null }, 'navigate')).toBeNull();
    const img = uvSameSiteRequest(info({ destination: 'image', documentUrl: `${A}/p` }), null);
    expect(uvFetchMetadata(img, 'no-cors')).toEqual([['sec-fetch-site', 'same-origin'], ['sec-fetch-mode', 'no-cors'], ['sec-fetch-dest', 'image']]);
    const xhr = uvSameSiteRequest(info({ destination: '', documentUrl: `${B}/p` }), null);
    expect(uvFetchMetadata(xhr, 'cors')).toEqual([['sec-fetch-site', 'cross-site'], ['sec-fetch-mode', 'cors'], ['sec-fetch-dest', 'empty']]);
    const frame = uvSameSiteRequest(info({ destination: 'iframe' }), `${A}/`);
    expect(uvFetchMetadata(frame, 'navigate')?.[2]).toEqual(['sec-fetch-dest', 'iframe']);
  });
});

describe('Ultraviolet: the script cookie string of a blocked document (blankUvScriptCookies, row K3c)', () => {
  /** A stand-in for one UV 3.2.10 instance (a fresh `cookie` object per instance, as UV builds it). */
  const instance = () => ({
    cookie: {
      calls: [] as boolean[],
      serialize(this: { calls: boolean[] }, rows: Array<{ name: string; value: string }>, _meta: unknown, js: boolean) {
        this.calls.push(js);
        return rows.map((r) => `${r.name}=${r.value}`).join('; ');
      },
    },
  });
  const rows = [{ name: 'trk', value: '1' }];

  it('empties what UV injects for scripts, keeps the request’s own Cookie serialization', () => {
    const uv = instance();
    expect(blankUvScriptCookies(uv)).toBe(true);
    expect(uv.cookie.serialize(rows, {}, true)).toBe('');
    expect(uv.cookie.serialize(rows, {}, false)).toBe('trk=1');
    expect(uv.cookie.calls).toEqual([false]);
    // Another instance (another request) is untouched.
    expect(instance().cookie.serialize(rows, {}, true)).toBe('trk=1');
  });

  it('leaves an instance of another shape alone', () => {
    expect(blankUvScriptCookies(null)).toBe(false);
    expect(blankUvScriptCookies({})).toBe(false);
    expect(blankUvScriptCookies({ cookie: { serialize: 'x' } })).toBe(false);
  });

  it('documents and workers get the string, other answers do not', () => {
    expect([...UV_SCRIPT_COOKIE_DESTINATIONS].sort()).toEqual(['document', 'frame', 'iframe', 'worker']);
  });

  it('verdictBlocksCookies follows the cookie provider’s decision through the real composite (no other provider removes `cookie`)', () => {
    const hooks = composeHooks({
      providers: [createCookieProvider(), createPrivacyProvider({ rewriteParams: () => null })],
      onBlock: () => {},
      onError: (_p, _w, err) => {
        throw err;
      },
    });
    hooks.configure?.(settings({ privacy: { cookies: 'block-third-party', referrer: 'none' } }));
    const frame = (url: string) => request({ engine: 'ultraviolet', tabId: null, url, destination: 'iframe', topLevelUrl: `${A}/`, documentUrl: `${A}/`, referrer: `${A}/` });
    const third = hooks.onRequest?.(frame(`${T}/frame`)) ?? { action: 'allow' as const };
    const first = hooks.onRequest?.(frame(`${A}/frame`)) ?? { action: 'allow' as const };
    expect(verdictBlocksCookies(third)).toBe(true);
    // The privacy provider removed `referer` (mode none) there too: that is not a cookie decision.
    expect(first.action === 'allow' ? first.headers?.remove : undefined).toEqual(['referer']);
    expect(verdictBlocksCookies(first)).toBe(false);
    expect(verdictBlocksCookies({ action: 'block', category: 'ads' })).toBe(false);
    expect(verdictBlocksCookies({ action: 'allow', headers: { remove: ['Cookie'] } })).toBe(true);
  });
});
