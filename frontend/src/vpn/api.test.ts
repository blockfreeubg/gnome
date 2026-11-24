import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLocation, checkLocationResult, fetchLocations, parseLocations } from './api';
import { fakeLocations } from './testing/fake-locations';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('vpn api shape checks', () => {
  it('reads a full answer unchanged', () => {
    const a = fakeLocations();
    expect(parseLocations(structuredClone(a))).toEqual(a);
  });

  it('an older server without exit / check_service: unchecked, and the URL host', () => {
    const r = parseLocations({
      profiles: [{ id: 'se-sto', label: 'Stockholm', country_code: 'SE', country: 'Sweden', city: 'Stockholm', path: '/wisp/p/se-sto/', status: 'up', checked_at: 1 }],
      verify_url: 'https://check.example:8443/json',
    });
    expect(r.check_service).toBe('check.example:8443');
    expect(r.profiles[0]!.exit.state).toBe('unchecked');
    expect(r.profiles[0]!.country_code).toBe('se');
    expect(r.profiles[0]!.provider_note).toBe('');
  });

  it('a gated answer: unchecked with nulls', () => {
    const r = parseLocations({
      profiles: [{ id: 'a', label: 'A', status: 'down', exit: { state: 'unchecked', ip: null, country: null, city: null, provider_exit: null, country_match: null, checked_at: null, error: null, v6: null } }],
      verify_url: null,
      check_service: null,
    });
    expect(r.profiles[0]!.exit).toMatchObject({ state: 'unchecked', ip: null, v6: null });
    expect(r.verify_url).toBeNull();
  });

  it('reads v6 and drops unknown errors and malformed locations', () => {
    const r = parseLocations({
      profiles: [
        { id: 'a', label: 'A', status: 'weird', exit: { state: 'failed', error: 'nope', v6: { state: 'failed', ip: null, error: 'timeout' } } },
        { label: 'no id' },
        'junk',
      ],
      verify_url: 'https://c.example/',
      check_service: 'c.example',
    });
    expect(r.profiles).toHaveLength(1);
    expect(r.profiles[0]!.status).toBe('unknown');
    expect(r.profiles[0]!.exit.error).toBeNull();
    expect(r.profiles[0]!.exit.v6).toEqual({ state: 'failed', ip: null, error: 'timeout' });
    expect(() => parseLocations({ nope: 1 })).toThrow();
  });

  it('fetchLocations GETs /api/vpn/locations', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (urls.push(u), json(200, fakeLocations()))));
    expect((await fetchLocations()).profiles).toHaveLength(2);
    expect(urls).toEqual(['/api/vpn/locations']);
  });

  it('checkLocation: the exit, null on 404 or failure, denied on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      if (u.includes('/gone/')) return json(404, { error: { code: 'not_found', message: 'x' } });
      if (u.includes('/locked/')) return json(401, { error: { code: 'access_code_required', message: 'x' } });
      if (u.includes('/down/')) throw new TypeError('offline');
      return json(200, { exit: fakeLocations().profiles[0]!.exit });
    }));
    expect((await checkLocation('se-sto'))?.ip).toBe('198.51.100.7');
    expect(await checkLocation('gone')).toBeNull();
    expect(await checkLocation('down')).toBeNull();
    expect(await checkLocationResult('locked')).toEqual({ kind: 'denied' });
  });
});
