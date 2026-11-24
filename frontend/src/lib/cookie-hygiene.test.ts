import { describe, expect, it } from 'vitest';
import { cleanForeignCookies, cookieNames, hygieneLevels, MAX_NAMES_PER_RUN, registrableDomain, REGISTRABLE_THRESHOLD, startCookieHygiene } from './cookie-hygiene';

/** A cookie jar with RFC 6265 domain and path rules, as one page sees it through document.cookie. */
class FakeJar {
  cookies: Array<{ name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean }> = [];
  constructor(
    public host: string,
    public https = true,
  ) {}

  private domainMatch(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
  }

  /** Plant a cookie as another page of `fromHost` would (Set-Cookie or document.cookie there). */
  plant(fromHost: string, line: string): void {
    const saved = this.host;
    this.host = fromHost;
    this.cookie = line;
    this.host = saved;
  }

  get cookie(): string {
    return this.cookies
      .filter((c) => (c.hostOnly ? c.domain === this.host : this.domainMatch(this.host, c.domain)) && c.path === '/' && (!c.secure || this.https || this.host === 'localhost'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  set cookie(line: string) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    let domain: string | null = null;
    let path = '/';
    let secure = false;
    let expired = false;
    for (const a of attrs) {
      const [k, v = ''] = a.split('=');
      const key = k!.toLowerCase();
      if (key === 'domain') domain = v.replace(/^\./, '').toLowerCase();
      else if (key === 'path') path = v;
      else if (key === 'secure') secure = true;
      else if (key === 'max-age' && Number(v) <= 0) expired = true;
    }
    if (domain !== null) {
      // (Browsers treat http://localhost as a secure context, so its Secure cookies are visible.)
    // The browser refuses a Domain that the host is not within, and public suffixes (here: single labels, "co.uk").
      if (!this.domainMatch(this.host, domain) || !domain.includes('.') || domain === 'co.uk') return;
    }
    if ((name.startsWith('__Secure-') || name.startsWith('__Host-')) && !secure) return;
    const d = domain ?? this.host;
    const existing = this.cookies.find((c) => c.name === name && c.domain === d && c.path === path);
    // "Leave Secure cookies alone": a non-Secure write cannot replace a Secure cookie.
    if (existing?.secure && !secure) return;
    this.cookies = this.cookies.filter((c) => c !== existing);
    if (!expired) this.cookies.push({ name, value, domain: d, hostOnly: domain === null, path, secure });
  }
}

const opts = (over: Partial<Parameters<typeof cleanForeignCookies>[1]> = {}) => ({
  appHost: 'gnome.example.com',
  proxyHost: 'p.gnome.example.com',
  registrable: false,
  https: true,
  ...over,
});

describe('cookie hygiene scope rules', () => {
  it('estimates registrable domains and the levels to clear', () => {
    expect(registrableDomain('gnome.example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('127.0.0.1')).toBeNull();
    expect(hygieneLevels('gnome.example.com', 'p.gnome.example.com', false)).toEqual(['gnome.example.com']);
    expect(hygieneLevels('gnome.example.com', 'p.gnome.example.com', true)).toEqual(['gnome.example.com', 'example.com']);
    expect(hygieneLevels('gnome.example.com', 'p.example.com', false)).toEqual(['gnome.example.com']);
    // Two ports on localhost: host-only only.
    expect(hygieneLevels('localhost', 'localhost', true)).toEqual([]);
    expect(hygieneLevels('127.0.0.1', '127.0.0.1', true)).toEqual([]);
    // Separate registrable domains share nothing.
    expect(hygieneLevels('gnome.example.com', 'gnome-proxy.other.net', true)).toEqual([]);
  });

  it('removes a flood planted for the common parent and host-only cookies, keeps a sibling site’s registrable cookie', () => {
    const jar = new FakeJar('gnome.example.com');
    for (let i = 0; i < 50; i++) jar.plant('p.gnome.example.com', `flood${i}=${'x'.repeat(100)}; Domain=gnome.example.com; Path=/`);
    jar.plant('gnome.example.com', 'hostonly=1; Path=/');
    jar.plant('other.example.com', 'sso=keep; Domain=example.com; Path=/');
    jar.plant('p.gnome.example.com', '__Secure-planted=1; Domain=gnome.example.com; Path=/; Secure');
    const removed = cleanForeignCookies(jar, opts());
    expect(removed).toContain('flood0');
    expect(jar.cookie).toBe('sso=keep');
    expect(jar.cookies.some((c) => c.name === '__Secure-planted')).toBe(false);
  });

  it('clears the registrable level only past 32 KB or when the operator opted in', () => {
    const big = new FakeJar('gnome.example.com');
    big.plant('other.example.com', 'sso=keep; Domain=example.com; Path=/');
    for (let i = 0; i < 10; i++) big.plant('p.gnome.example.com', `r${i}=${'y'.repeat(4000)}; Domain=example.com; Path=/`);
    expect(big.cookie.length).toBeGreaterThan(REGISTRABLE_THRESHOLD);
    cleanForeignCookies(big, opts());
    expect(big.cookie).toBe('');
    const optIn = new FakeJar('gnome.example.com');
    optIn.plant('other.example.com', 'sso=1; Domain=example.com; Path=/');
    cleanForeignCookies(optIn, opts({ registrable: true }));
    expect(optIn.cookie).toBe('');
  });

  it('on localhost (two ports) deletes host-only cookies only; a Secure cookie needs a Secure deletion', () => {
    const jar = new FakeJar('localhost', false);
    jar.plant('localhost', 'a=1; Path=/');
    jar.plant('localhost', '__Secure-b=1; Path=/; Secure');
    cleanForeignCookies(jar, opts({ appHost: 'localhost', proxyHost: 'localhost', https: false }));
    expect(jar.cookies).toEqual([]);
  });

  it('cannot see other paths, and expires at most 200 names per run', () => {
    const jar = new FakeJar('gnome.example.com');
    jar.plant('p.gnome.example.com', 'api=1; Domain=gnome.example.com; Path=/api');
    for (let i = 0; i < 250; i++) jar.plant('p.gnome.example.com', `n${i}=1; Domain=gnome.example.com; Path=/`);
    expect(cleanForeignCookies(jar, opts())).toHaveLength(MAX_NAMES_PER_RUN);
    expect(cookieNames(jar.cookie)).toHaveLength(50);
    cleanForeignCookies(jar, opts());
    expect(jar.cookie).toBe('');
    // A cookie for another path stays (the server limits are the guarantee).
    expect(jar.cookies.map((c) => c.name)).toEqual(['api']);
  });
});

describe('startCookieHygiene', () => {
  function fakeWindow(host: string) {
    const jar = new FakeJar(host);
    const listeners: Array<() => void> = [];
    const timers: Array<() => void> = [];
    const win = {
      location: { hostname: host, origin: `https://${host}`, protocol: 'https:' },
      document: Object.assign(jar, { visibilityState: 'visible', addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: () => {} }),
      setInterval: (fn: () => void) => timers.push(fn),
      clearInterval: () => {},
    } as unknown as Window & typeof globalThis;
    return { win, jar, listeners, timers };
  }

  it('runs only in two-origin mode, once the configuration is known, and when the page becomes visible', () => {
    const { win, jar, listeners, timers } = fakeWindow('gnome.example.com');
    const source: { config: { proxy: { origin: string | null; isolated: boolean } } | null } = { config: null };
    jar.plant('p.gnome.example.com', 'f=1; Domain=gnome.example.com; Path=/');
    startCookieHygiene(source, win);
    expect(jar.cookie).toBe('f=1');
    source.config = { proxy: { origin: 'https://gnome.example.com', isolated: false } };
    timers[0]!();
    expect(jar.cookie).toBe('f=1'); // single-origin mode: off
    source.config = { proxy: { origin: 'https://p.gnome.example.com', isolated: true } };
    listeners[0]!();
    expect(jar.cookie).toBe('');
    jar.plant('p.gnome.example.com', 'g=1; Domain=gnome.example.com; Path=/');
    timers[1]!();
    expect(jar.cookie).toBe('');
  });
});
