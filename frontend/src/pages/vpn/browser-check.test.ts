import { describe, expect, it } from 'vitest';
import { ROWS } from '../settings/registry';
import * as bcopy from './browser-check.svelte';
import { BrowserCheck, type BrowserCheckFacts } from './browser-check.svelte';

const FORBIDDEN = /mullvad|secure|anonymous|protected|encrypted|no logs|hide your ip|your ip is hidden|system-wide|confirmed/i;
const ANSWER = { ip: '192.0.2.10', country: 'Sweden', city: 'E2E', vpnExit: false, checkedAt: 1 };

function facts(over: Partial<BrowserCheckFacts> = {}): BrowserCheckFacts & { calls: string[] } {
  const calls: string[] = [];
  return {
    vpnLocation: { id: 'e2e-vpn', status: 'up' },
    engineState: 'ready',
    verifyExit: true,
    verifyUrl: 'http://127.0.0.1:23060/json',
    verify: async (url) => {
      calls.push(url);
      return ANSWER;
    },
    calls,
    ...over,
  };
}

describe("this browser's exit check (WAVE-C §8.1)", () => {
  it('runs once per connect or route change, once the engine host is ready', async () => {
    const c = new BrowserCheck();
    const f = facts({ engineState: 'starting' });
    c.maybeRun(f);
    expect(f.calls).toEqual([]);
    const ready = { ...f, engineState: 'ready' };
    c.maybeRun(ready);
    c.maybeRun(ready);
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
    expect(c.result).toEqual({ locationId: 'e2e-vpn', answer: ANSWER });
    // Another route: one more run. Off and on again: one more.
    c.maybeRun({ ...ready, vpnLocation: { id: 'e2e-vpn2', status: 'up' } });
    await Promise.resolve();
    c.maybeRun({ ...ready, vpnLocation: null });
    c.maybeRun({ ...ready, vpnLocation: { id: 'e2e-vpn2', status: 'up' } });
    await Promise.resolve();
    expect(f.calls).toHaveLength(3);
  });

  it('never runs with the switch off (the default) or without a check service', async () => {
    const c = new BrowserCheck();
    const off = facts({ verifyExit: false });
    c.maybeRun(off);
    await c.run(off);
    const none = facts({ verifyUrl: null });
    c.maybeRun(none);
    await c.run(none);
    const nowhere = facts({ vpnLocation: { id: 'no-location', status: 'none' } });
    await c.run(nowhere);
    expect([...off.calls, ...none.calls, ...nowhere.calls]).toEqual([]);
    expect(c.result).toBeNull();
  });

  it('says what the service answered, never that it confirms anything', () => {
    expect(bcopy.browserCheckText('127.0.0.1:23060', ANSWER)).toBe('Through this browser’s route, 127.0.0.1:23060 reports 192.0.2.10 in E2E, Sweden');
    expect(bcopy.previousRouteText(1)).toBe('1 tab may still use the previous route until you reload it');
    expect(bcopy.previousRouteText(3)).toBe('3 tabs may still use the previous route until you reload them');
    const texts = [
      bcopy.BROWSER_CHECK_TITLE,
      bcopy.BROWSER_CHECK_CAVEAT,
      bcopy.BROWSER_CHECK_FAILED,
      bcopy.AUTO_CONNECT_LABEL,
      bcopy.AUTO_CONNECT_HELP,
      bcopy.VERIFY_LABEL,
      bcopy.VERIFY_HELP,
      bcopy.mismatchText('E2E · live'),
      // §10's Settings texts (VPN rows and the Games section).
      ...ROWS.filter((r) => r.section === 'vpn').flatMap((r) => [r.label, r.description ?? '', r.keywords ?? '']),
    ];
    for (const t of texts) expect(t, t).not.toMatch(FORBIDDEN);
  });
});
