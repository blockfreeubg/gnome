import { describe, expect, it } from 'vitest';
import { validateCommandResult } from '../shared/engine-protocol';
import { SUGGEST_ENDPOINTS, parseSuggestions, suggest, suggestUrl } from './suggest';
import { ipLiteral, parseVpnVerify, vpnVerify } from './vpn-verify';

// Real answers captured on 2026-11-12 (query "gnome sh").
const DDG = '["gnome sh",["gnome show","gnome shell","gnome shell extensions","gnome shoes","gnome shield","gnome shell integration","gnome shop","gnome shortcuts"]]';
const GOOGLE =
  '["gnome sh",["gnome show","gnome shell extensions","gnome shoes","gnome shell","gnome shift at midnight","gnome shirts","gnome shadow priest","gnome shell themes","gnome show merch","gnome show cas van de pol"],[],{"google:suggestsubtypes":[[512],[512]]}]';
const BING =
  '["gnome sh",["gnome show","gnome shell","gnome shell extensions","gnome shoes","gnome shield","gnome shell integration","gnome shell themes","gnome shop","gnome shortcuts","gnome shell extension manager","gnome shuttle phoenix","gnome shell integration edge","gnome shuttle duluth mn"]]';
const STARTPAGE = '["gnome sh",["gnome shell","gnome shell 3.6","gnome shell","gnome shell 3.6"]]';

const res = (body: string, status = 200) => ({ status, headers: [] as Array<[string, string]>, body: new TextEncoder().encode(body).buffer as ArrayBuffer });

describe('search suggestions', () => {
  it('has an https endpoint for every provider and encodes the query', () => {
    for (const u of Object.values(SUGGEST_ENDPOINTS)) expect(u.startsWith('https://') && u.includes('{q}')).toBe(true);
    expect(suggestUrl('duckduckgo', 'a&b c')).toBe('https://duckduckgo.com/ac/?q=a%26b%20c&type=list');
  });

  it('parses real provider answers within the protocol limits', () => {
    for (const body of [DDG, GOOGLE, BING]) {
      const items = parseSuggestions(body);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(10);
      expect(validateCommandResult('suggest', { items })).toBeTruthy();
    }
    expect(parseSuggestions(BING)).toHaveLength(10);
    expect(parseSuggestions(STARTPAGE)).toEqual(['gnome shell', 'gnome shell 3.6']);
  });

  it('drops non-strings, control characters and empty items, and cuts long ones', () => {
    const long = 'x'.repeat(300);
    const items = parseSuggestions(JSON.stringify(['q', [1, null, '  ', 'a‮b\u0000', long]]));
    expect(items).toEqual(['ab', `${'x'.repeat(255)}…`]);
    expect(validateCommandResult('suggest', { items })).toBeTruthy();
  });

  it('rejects other formats and failed answers', async () => {
    expect(() => parseSuggestions('<html>')).toThrow(/not JSON/);
    expect(() => parseSuggestions('{"a":1}')).toThrow(/unknown format/);
    await expect(suggest(async () => res('', 503), 'ecosia', 'x')).rejects.toThrow(/503/);
    expect(await suggest(async () => res(DDG), 'duckduckgo', '   ')).toEqual([]);
  });

  it('fetches through proxyFetch with a size cap', async () => {
    const calls: Array<{ url: string; maxBytes: number }> = [];
    const items = await suggest(async (url, init) => {
      calls.push({ url, maxBytes: init.maxBytes });
      return res(DDG);
    }, 'duckduckgo', 'gnome sh');
    expect(items[0]).toBe('gnome show');
    expect(calls).toEqual([{ url: 'https://duckduckgo.com/ac/?q=gnome%20sh&type=list', maxBytes: 65536 }]);
  });
});

describe('VPN exit check', () => {
  // am.i.mullvad.net/json shape (documentation addresses).
  const MULLVAD = '{"ip":"198.51.100.7","country":"Sweden","city":"Stockholm","longitude":18.0,"latitude":59.3,"mullvad_exit_ip":true,"blacklisted":{"blacklisted":false,"results":[]},"organization":"Example"}';

  it('reads the check service answer', () => {
    const r = parseVpnVerify(MULLVAD, 1_700_000_000_123.7);
    expect(r).toEqual({ ip: '198.51.100.7', country: 'Sweden', city: 'Stockholm', vpnExit: true, checkedAt: 1_700_000_000_123 });
    expect(validateCommandResult('vpn.verify', r)).toBeTruthy();
    const plain = parseVpnVerify('{"ip":"2001:DB8::1","country":"Germany"}', 1);
    expect(plain).toEqual({ ip: '2001:db8::1', country: 'Germany', city: null, vpnExit: null, checkedAt: 1 });
    expect(validateCommandResult('vpn.verify', plain)).toBeTruthy();
  });

  it('accepts only IP literals', () => {
    expect(ipLiteral('203.0.113.1')).toBe('203.0.113.1');
    expect(ipLiteral('256.1.1.1')).toBeNull();
    expect(ipLiteral('::1')).toBe('::1');
    expect(ipLiteral('fe80::1%eth0')).toBeNull();
    expect(ipLiteral('1:2:3')).toBeNull();
    expect(ipLiteral(7)).toBeNull();
    expect(() => parseVpnVerify('{"ip":"example.com"}', 1)).toThrow(/IP address/);
    expect(() => parseVpnVerify('[]', 1)).toThrow(/unknown format/);
  });

  it('fails on a non-2xx answer', async () => {
    await expect(vpnVerify(async () => res('{}', 500), 'https://am.i.mullvad.net/json')).rejects.toThrow(/500/);
  });
});
