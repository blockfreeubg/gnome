import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from './defaults';
import { withLocalVpn } from './local-vpn';

describe('withLocalVpn (docs/WAVE-C.md D12)', () => {
  it('puts this browser’s vpn.mode and vpn.killSwitch back and keeps the other vpn keys', () => {
    const doc = { theme: 'x', vpn: { mode: 'gateway', killSwitch: false, preferredLocation: 'se-sto', autoConnect: true } };
    expect(withLocalVpn(doc, { mode: 'off', killSwitch: true })).toEqual({
      theme: 'x',
      vpn: { mode: 'off', killSwitch: true, preferredLocation: 'se-sto', autoConnect: true },
    });
    expect(doc.vpn.mode).toBe('gateway'); // not mutated
  });

  it('gives a document without a vpn object just the two device keys', () => {
    expect(withLocalVpn({ a: 1 }, { mode: 'gateway', killSwitch: false })).toEqual({ a: 1, vpn: { mode: 'gateway', killSwitch: false } });
    expect(withLocalVpn({ vpn: 'junk' }, { mode: 'off', killSwitch: true })).toEqual({ vpn: { mode: 'off', killSwitch: true } });
  });

  it('returns non-objects unchanged', () => {
    expect(withLocalVpn(null, { mode: 'off', killSwitch: true })).toBeNull();
    expect(withLocalVpn([1], { mode: 'off', killSwitch: true })).toEqual([1]);
  });

  it('the exit check of this browser is off by default (D15: no check service unless the operator sets one)', () => {
    expect(createDefaultSettings().vpn.verifyExit).toBe(false);
  });
});
