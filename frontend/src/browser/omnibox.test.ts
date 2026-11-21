import { describe, expect, it } from 'vitest';
import { mergeOptions, primaryOption, SuggestThrottle, wantsSearchSuggestions } from './omnibox';
import { describeTransport } from './ui/status-text';
import { errorCopy } from './ui/error-copy';
import { addressOf, faviconOf, titleOf } from './ui/util';
import type { Tab } from './tabs.svelte';

const search = { searchEngine: 'duckduckgo' as const, customSearchUrl: '' };

describe('address bar suggestions', () => {
  it('puts the primary action first and drops library entries for the same URL', () => {
    const p = primaryOption('example.com', search, 'DuckDuckGo');
    expect(p).toMatchObject({ kind: 'primary', mode: 'url' });
    const opts = mergeOptions(
      p,
      [
        { url: 'https://example.com/', title: 'Example', source: 'history', score: 3 },
        { url: 'https://example.com/a', title: 'A', source: 'bookmark', score: 9 },
        { url: 'https://example.com/a', title: 'A again', source: 'history', score: 1 },
      ],
      [],
    );
    expect(opts.map((o) => o.key)).toEqual(['primary', 'bookmark:https://example.com/a']);
  });

  it('adds search suggestions after the library, without repeating the typed text', () => {
    const p = primaryOption('gnome', search, 'DuckDuckGo');
    const opts = mergeOptions(p, [], ['gnome', 'Gnome garden', 'gnome garden', 'gnome desktop', 'a', 'b', 'c']);
    expect(opts.filter((o) => o.kind === 'query').map((o) => (o.kind === 'query' ? o.text : ''))).toEqual(['Gnome garden', 'gnome desktop', 'a', 'b']);
  });

  it('asks for search suggestions only for searches, never for addresses, custom engines or when off', () => {
    expect(wantsSearchSuggestions('gnome folklore', search, true)).toBe('duckduckgo');
    expect(wantsSearchSuggestions('example.com', search, true)).toBeNull();
    expect(wantsSearchSuggestions('gnome', search, false)).toBeNull();
    expect(wantsSearchSuggestions('gnome', { searchEngine: 'custom', customSearchUrl: 'https://s.example/?q=%s' }, true)).toBeNull();
    expect(wantsSearchSuggestions('x'.repeat(300), search, true)).toBeNull();
  });

  it('debounces 150 ms and keeps to 5 requests per second', () => {
    const t = new SuggestThrottle();
    expect(t.delay(0)).toBe(150);
    for (let i = 0; i < 5; i++) t.sent(100 + i);
    expect(t.delay(200)).toBe(900);
    expect(t.delay(1200)).toBe(150);
  });
});

describe('transport wording (ENGINE-PROTOCOL §6.6)', () => {
  const base = { transport: 'libcurl' as const, endpoint: 'default' as const, since: 1, retryInMs: 4200 };
  it('says what each offline state means, with the retry time', () => {
    expect(describeTransport({ ...base, state: 'ready', detail: null }).blocking).toBe(false);
    // 'ready' is "built, nothing known wrong" (sockets open on demand), so the badge never says "connected".
    expect(describeTransport({ ...base, state: 'ready', detail: null }).short).toBe(`${base.transport} ready`);
    expect(describeTransport({ ...base, state: 'offline', detail: 'gateway-unreachable' }).long).toBe('GNOME’s server is unreachable. Retrying in 4 s.');
    expect(describeTransport({ ...base, endpoint: 'profile', state: 'offline', detail: 'upstream-unreachable' }).long).toMatch(/VPN location is down/);
    expect(describeTransport({ ...base, state: 'offline', detail: 'rate-limited' }).short).toBe('Too many connections');
    expect(describeTransport({ ...base, state: 'offline', detail: 'ticket-missing' }).long).toMatch(/Sign in/);
  });
});

describe('tab labels after a failed navigation', () => {
  const err = { url: 'https://down.example/' } as NonNullable<Tab['error']>;
  it('names the address that failed and drops the previous page’s icon', () => {
    const t = { title: 'Gnome - Wikipedia', url: 'https://en.wikipedia.org/wiki/Gnome', favicon: 'data:image/png;base64,AAAA', error: err };
    expect(titleOf(t)).toBe('down.example');
    expect(addressOf(t)).toBe('https://down.example/');
    expect(faviconOf(t)).toBeNull();
    const ok = { ...t, error: null };
    expect([titleOf(ok), addressOf(ok), faviconOf(ok)]).toEqual(['Gnome - Wikipedia', 'https://en.wikipedia.org/wiki/Gnome', 'data:image/png;base64,AAAA']);
  });
});

describe('error overlay wording (ENGINE-PROTOCOL §6.4)', () => {
  const base = { host: 'example.com', killSwitch: false, engine: 'Scramjet' };
  it('says "VPN location down" only from the app’s own facts: the profile route and /api/vpn/locations', () => {
    expect(errorCopy({ kind: 'gateway' }, { ...base, vpn: { label: 'Sweden', status: 'down' } }).title).toBe('This VPN location is down');
    expect(errorCopy({ kind: 'network' }, { ...base, vpn: { label: 'Sweden', status: 'down' } }).title).toBe('This VPN location is down');
    // The location is up (or not checked yet): a network failure is the site's, a gateway failure the route's.
    expect(errorCopy({ kind: 'network' }, { ...base, vpn: { label: 'Sweden', status: 'up' } }).title).toBe('Can’t reach example.com');
    expect(errorCopy({ kind: 'gateway' }, { ...base, vpn: { label: 'Sweden', status: 'unknown' } }).title).toBe('The VPN location is not reachable');
    // Off the profile route (no VPN, or it fell back without the kill switch): GNOME's own gateway.
    expect(errorCopy({ kind: 'gateway' }, { ...base, vpn: null }).title).toBe('GNOME’s proxy is not reachable');
    expect(errorCopy({ kind: 'timeout' }, { ...base, vpn: { label: 'Sweden', status: 'down' } }).glyph).toBe('timer');
  });

  it('names a location the server no longer offers, and the kill switch', () => {
    const gone = errorCopy({ kind: 'gateway' }, { ...base, killSwitch: true, vpn: { label: 'nl-ams', status: 'gone' } });
    expect(gone.title).toBe('This VPN location is no longer offered');
    expect(gone.body).toMatch(/nl-ams.*kill switch/s);
    expect(errorCopy({ kind: 'network' }, { ...base, vpn: { label: '', status: 'none' } }).title).toBe('No VPN location is available');
  });
});
