import { describe, expect, it } from 'vitest';
import * as copy from './copy';
import type { VpnConnection } from './types';

const FORBIDDEN = /mullvad|secure|anonymous|protected|encrypted|no logs|hide your ip|your ip is hidden|system-wide/i;
const sto = { id: 'se-sto', label: 'Stockholm' };
const CONNECTIONS: VpnConnection[] = [
  { kind: 'off' },
  { kind: 'connecting', location: sto, exitWarning: null },
  { kind: 'connected', location: sto, engine: 'running', exitWarning: null },
  { kind: 'connected', location: sto, engine: 'not-started', exitWarning: null },
  ...(['location-down', 'location-gone', 'no-location'] as const).flatMap((reason) => [
    { kind: 'blocked' as const, location: sto, reason },
    { kind: 'fallback' as const, location: sto, reason },
  ]),
];

/** Every exported string, every value of exported records and every exported function's output for sample inputs. */
function allStrings(): string[] {
  const out: string[] = [];
  const exit = { state: 'ok' as const, ip: '198.51.100.7', city: 'Stockholm', country: 'Sweden', error: 'timeout' as const };
  for (const [name, v] of Object.entries(copy)) {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object' && v) out.push(...Object.values(v).map(String));
    else if (typeof v === 'function') {
      if (name === 'stateText' || name === 'stateLine') for (const c of CONNECTIONS) out.push((v as (c: VpnConnection) => string)(c));
      else if (name === 'exitWarningText') for (const e of Object.keys(copy.EXIT_REASONS)) out.push(copy.exitWarningText('Stockholm', e as 'timeout'));
      else if (name === 'privacyParagraphs') out.push(...copy.privacyParagraphs('exit-check.example').flatMap((p) => [p.lead, p.text]));
      else if (name === 'exitReport') out.push(copy.exitReport('exit-check.example', exit));
      else if (name === 'providerExitText') out.push(copy.providerExitText('exit-check.example', true), copy.providerExitText('exit-check.example', false));
      else if (name === 'countryMismatchText') out.push(copy.countryMismatchText('exit-check.example', 'Germany', 'Sweden'));
      else if (name === 'v6Text') for (const state of ['ok', 'failed', 'unchecked'] as const) out.push(copy.v6Text('exit-check.example', { state, ip: '2001:db8::1', error: 'timeout' }));
      else out.push((v as (s: string) => string)('Stockholm'));
    }
  }
  return out;
}

describe('vpn copy (§7.3)', () => {
  it('no exported string makes a claim the VPN cannot keep or names a provider', () => {
    const strings = allStrings();
    expect(strings.length).toBeGreaterThan(40);
    for (const s of strings) expect(s, s).not.toMatch(FORBIDDEN);
  });

  it('state texts and lines are exact', () => {
    expect(CONNECTIONS.map(copy.stateText)).toEqual([
      'Off',
      'Connecting to Stockholm',
      'Connected to Stockholm',
      'Ready: Stockholm',
      'Blocked: Stockholm is down',
      'Not in use: Stockholm is down',
      'Blocked: Stockholm is no longer offered',
      'Not in use: Stockholm is no longer offered',
      'Blocked: no VPN location',
      'Not in use: no VPN location',
    ]);
    expect(copy.stateLine(CONNECTIONS[4]!)).toBe(
      "The kill switch stops pages from loading until Stockholm is back, instead of using this server's own connection.",
    );
    expect(copy.stateLine(CONNECTIONS[6]!)).toBe(
      "The kill switch stops pages from loading until you choose another location, instead of using this server's own connection.",
    );
    expect(copy.stateLine(CONNECTIONS[5]!)).toBe("Pages load through this server's own connection until the VPN can be used again.");
  });

  it('the exit warning lowers the reason and drops its period', () => {
    expect(copy.exitWarningText('Stockholm', 'timeout')).toBe('The exit check through Stockholm fails: the check took too long');
    expect(copy.exitWarningText('Stockholm', 'connect_failed')).toBe(
      "The exit check through Stockholm fails: connections through this location to the check service fail: the location's tunnel or the check service may be down",
    );
  });

  it('the Checks paragraph appears only with a check service', () => {
    expect(copy.privacyParagraphs(null).map((p) => p.lead)).not.toContain('Checks.');
    expect(copy.privacyParagraphs('c.example').map((p) => p.lead)).toEqual([
      'What it does.',
      'What it does not do.',
      'Who runs it.',
      'Checks.',
      'Kill switch.',
      'This browser only.',
    ]);
  });
});
