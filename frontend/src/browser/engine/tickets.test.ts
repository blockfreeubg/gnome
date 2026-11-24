import { describe, expect, it } from 'vitest';
import { ApiError, type WispTicket } from '../../lib/api';
import { TICKET } from '../../shared/engine-protocol';
import { ManualClock, flush } from '../testing/fake-engine-host';
import { TicketMinter, type MintOutcome } from './tickets';

const TTL = 3_600_000;

function setup(answer?: (n: number, interactive: boolean) => Promise<WispTicket>) {
  const clock = new ManualClock();
  const calls: boolean[] = [];
  const routes: unknown[] = [];
  const times: number[] = [];
  const minter = new TicketMinter({
    clock,
    ttlMs: () => TTL,
    mint: async ({ interactive, route }) => {
      calls.push(interactive);
      routes.push(route);
      times.push(clock.now());
      if (answer) return answer(calls.length, interactive);
      return { ticket: `w1.${calls.length}.abcdefgh`, expiresAt: clock.now() + TTL, wispUrl: 'ws://127.0.0.1:28002/wisp/', date: null };
    },
  });
  return { clock, calls, routes, times, minter };
}

describe('TicketMinter (ENGINE-PROTOCOL §6.5)', () => {
  it('converts expires_at with the server clock from the Date header, skew both ways, capped at the TTL', async () => {
    for (const skewMs of [-10 * 60_000, 0, 7 * 60_000]) {
      const { clock, minter } = setup();
      const serverNow = clock.now() + skewMs;
      const date = new Date(serverNow).toUTCString();
      const serverExpires = Math.floor(serverNow / 1000) * 1000 + 30 * 60_000;
      const m = new TicketMinter({
        clock,
        ttlMs: () => TTL,
        mint: async () => ({ ticket: 'w1.x.abcdefgh', expiresAt: serverExpires, wispUrl: 'ws://h/wisp/', date }),
      });
      const out = (await m.request(false)) as Extract<MintOutcome, { ok: true }>;
      expect(out.ok).toBe(true);
      // ~30 minutes of life on the local clock whatever the skew (minus the 1 s margin for the header's resolution).
      const life = out.ticket.expiresAt - clock.now();
      expect(life).toBeGreaterThan(30 * 60_000 - 2 * TICKET.clockMarginMs);
      expect(life).toBeLessThanOrEqual(30 * 60_000);
      void minter;
    }
    const { clock } = setup();
    const m = new TicketMinter({ clock, ttlMs: () => 60_000, mint: async () => ({ ticket: 'w1.x.abcdefgh', expiresAt: clock.now() + 86_400_000, wispUrl: 'ws://h/wisp/', date: null }) });
    const capped = (await m.request(false)) as Extract<MintOutcome, { ok: true }>;
    expect(capped.ticket.expiresAt - clock.now()).toBe(60_000);
  });

  it('coalesces requests that arrive while a mint is in flight or deferred, never dropping one', async () => {
    const { clock, calls, minter } = setup();
    const a = minter.request(false);
    const b = minter.request(false);
    await flush();
    expect(calls).toHaveLength(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    // Inside the 2 s interval: deferred, then one mint for both.
    const c = minter.request(false);
    const d = minter.request(false);
    await flush();
    expect(calls).toHaveLength(1);
    clock.advance(TICKET.appMinIntervalMs);
    await flush();
    expect(calls).toHaveLength(2);
    const [rc, rd] = await Promise.all([c, d]);
    expect(rc.ok && rd.ok).toBe(true);
  });

  it('keeps to 10 mints per rolling minute and 1 per 2 s', async () => {
    const { clock, calls, times, minter } = setup();
    const outcomes: Array<Promise<MintOutcome>> = [];
    for (let i = 0; i < 30; i++) {
      outcomes.push(minter.request(false));
      await flush();
      clock.advance(1000);
      await flush();
    }
    // 30 s: one mint per 2 s at most.
    expect(calls.length).toBeLessThanOrEqual(16);
    for (let i = 0; i < 40; i++) {
      clock.advance(1000);
      await flush();
    }
    const all = await Promise.all(outcomes);
    expect(all.every((o) => o.ok)).toBe(true);
    // Never more than 10 in any 60 s window, never two within 2 s.
    for (let i = 0; i < times.length; i++) {
      expect(times.filter((t) => t >= times[i]! && t < times[i]! + 60_000).length).toBeLessThanOrEqual(TICKET.appMaxPerMinute);
      if (i > 0) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(TICKET.appMinIntervalMs);
    }
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('waits Retry-After after a 429 and then mints for everyone waiting', async () => {
    let n = 0;
    const { clock, calls, minter } = setup(async (_i) => {
      n++;
      if (n === 1) throw new ApiError({ status: 429, code: 'rate_limited', message: 'slow down', retryAfterS: 7 });
      return { ticket: 'w1.ok.abcdefgh', expiresAt: clock.now() + TTL, wispUrl: 'ws://h/wisp/', date: null };
    });
    const p = minter.request(false);
    await flush();
    expect(calls).toHaveLength(1);
    clock.advance(6000);
    await flush();
    expect(calls).toHaveLength(1);
    clock.advance(1000);
    await flush();
    expect(calls).toHaveLength(2);
    expect((await p).ok).toBe(true);
  });

  it('reports credential answers of non-interactive mints without prompting', async () => {
    const { calls, minter } = setup(async () => {
      throw new ApiError({ status: 401, code: 'login_required', message: 'Sign in' });
    });
    expect(await minter.request(false)).toMatchObject({ ok: false, reason: 'credentials', kind: 'login' });
    expect(calls).toEqual([false]);
  });

  it('runs an interactive request after a non-interactive one in flight (it may need the prompt)', async () => {
    const { clock, calls, minter } = setup();
    const a = minter.request(false);
    const b = minter.request(true);
    await flush();
    expect(calls).toEqual([false]);
    clock.advance(TICKET.appMinIntervalMs);
    await flush();
    expect(calls).toEqual([false, true]);
    expect((await a).ok && (await b).ok).toBe(true);
  });

  it('mints for the route asked; a batch never mixes routes and a newer route supersedes a pending one (WAVE-C D23)', async () => {
    const { clock, routes, minter } = setup();
    const a = minter.request(false, 'default');
    // In flight for `default`; a profile request queues, and the in-flight waiters follow it (superseded).
    const b = minter.request(false, { profile: 'e2e-vpn' });
    await flush();
    expect(routes).toEqual(['default']);
    // A third request for yet another route supersedes the queued one.
    const c = minter.request(false, { profile: 'e2e-vpn2' });
    clock.advance(TICKET.appMinIntervalMs);
    await flush();
    expect(routes).toEqual(['default', { profile: 'e2e-vpn2' }]);
    for (const o of [await a, await b, await c]) expect(o).toMatchObject({ ok: true, route: { profile: 'e2e-vpn2' } });
    // Same route: coalesced with the mint in flight.
    clock.advance(TICKET.appMinIntervalMs);
    const d = minter.request(false, { profile: 'e2e-vpn2' });
    const e = minter.request(false, { profile: 'e2e-vpn2' });
    await flush();
    expect(routes).toHaveLength(3);
    expect((await d).ok && (await e).ok).toBe(true);
  });
});
