import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../settings/defaults';
import { chipStatus, connectionOf, decideAutoConnect, nextPollDelay, VpnStateImpl, type BrowserFacts } from './state.svelte';
import { fakeLocations, fakeVpnEnv, OFFERED } from './testing/fake-locations';
import type { ExitError, VpnConnection } from './types';

type In = Parameters<typeof connectionOf>[0];
const sto = { id: 'se-sto', label: 'Stockholm' };
const base = (over: Partial<In> = {}): In => ({
  mode: 'gateway',
  killSwitch: true,
  offered: OFFERED,
  route: { ...sto, status: 'up' },
  status: { 'se-sto': 'up', 'de-fra': 'down' },
  exitWarning: () => null,
  engineState: 'ready',
  profileTransport: [{ state: 'ready', detail: null }],
  ...over,
});

describe('connectionOf (D13, D14)', () => {
  const rows: Array<[string, Partial<In>, VpnConnection]> = [
    ['mode off', { mode: 'off' }, { kind: 'off' }],
    ['no offered location, kill switch', { offered: [], route: { id: '', label: '', status: 'none' } }, { kind: 'blocked', location: null, reason: 'no-location' }],
    ['no offered location, no kill switch', { offered: [], killSwitch: false, route: null }, { kind: 'fallback', location: null, reason: 'no-location' }],
    ['route none', { route: { id: '', label: '', status: 'none' } }, { kind: 'blocked', location: null, reason: 'no-location' }],
    ['location gone from /api/config', { route: { id: 'x', label: 'x', status: 'unknown' } }, { kind: 'blocked', location: { id: 'x', label: 'x' }, reason: 'location-gone' }],
    ['route says gone', { route: { ...sto, status: 'gone' } }, { kind: 'blocked', location: sto, reason: 'location-gone' }],
    ['health down', { status: { 'se-sto': 'down' } }, { kind: 'blocked', location: sto, reason: 'location-down' }],
    ['fallback (route left, kill switch off)', { killSwitch: false, route: null, status: { 'se-sto': 'down', 'de-fra': 'down' }, preferred: 'se-sto' }, { kind: 'fallback', location: sto, reason: 'location-down' }],
    ['fallback to a preferred location no longer offered', { killSwitch: false, route: null, preferred: 'gone' }, { kind: 'fallback', location: { id: 'gone', label: 'gone' }, reason: 'location-gone' }],
    ['ready side', {}, { kind: 'connected', location: sto, engine: 'running', exitWarning: null }],
    ['connecting side', { profileTransport: [{ state: 'connecting', detail: null }] }, { kind: 'connecting', location: sto, exitWarning: null }],
    ['degraded side', { profileTransport: [{ state: 'degraded', detail: null }] }, { kind: 'connecting', location: sto, exitWarning: null }],
    ['offline upstream-unreachable', { profileTransport: [{ state: 'offline', detail: 'upstream-unreachable' }] }, { kind: 'blocked', location: sto, reason: 'location-down' }],
    ['offline unknown-profile, no kill switch', { killSwitch: false, profileTransport: [{ state: 'offline', detail: 'unknown-profile' }] }, { kind: 'fallback', location: sto, reason: 'location-gone' }],
    ['no engine host', { engineState: 'idle', profileTransport: [] }, { kind: 'connected', location: sto, engine: 'not-started', exitWarning: null }],
    ['engine host starting', { engineState: 'starting', profileTransport: [] }, { kind: 'connecting', location: sto, exitWarning: null }],
  ];
  for (const [name, over, want] of rows) {
    it(name, () => expect(connectionOf(base(over))).toEqual(want));
  }

  it('an exit warning is carried, never blocked or fallback', () => {
    const warn = (): ExitError => 'connect_failed';
    expect(connectionOf(base({ exitWarning: warn }))).toEqual({ kind: 'connected', location: sto, engine: 'running', exitWarning: 'connect_failed' });
    expect(connectionOf(base({ exitWarning: warn, profileTransport: [{ state: 'connecting', detail: null }] }))).toMatchObject({ kind: 'connecting', exitWarning: 'connect_failed' });
    expect(connectionOf(base({ exitWarning: warn, killSwitch: false }))).toMatchObject({ kind: 'connected' });
  });
});

describe('chipStatus', () => {
  it('maps every connection', () => {
    expect(chipStatus({ kind: 'off' })).toBeNull();
    expect(chipStatus({ kind: 'connected', location: sto, engine: 'running', exitWarning: null })).toEqual({ state: 'ok', detail: 'Stockholm' });
    expect(chipStatus({ kind: 'connected', location: sto, engine: 'not-started', exitWarning: null })).toEqual({ state: 'ok', detail: 'Stockholm' });
    expect(chipStatus({ kind: 'connected', location: sto, engine: 'running', exitWarning: 'timeout' })).toEqual({ state: 'degraded', detail: 'Stockholm · exit check failing' });
    expect(chipStatus({ kind: 'connecting', location: sto, exitWarning: null })).toEqual({ state: 'starting', detail: 'Stockholm' });
    expect(chipStatus({ kind: 'blocked', location: sto, reason: 'location-down' })).toEqual({ state: 'down', detail: 'Blocked' });
    expect(chipStatus({ kind: 'fallback', location: null, reason: 'no-location' })).toEqual({ state: 'degraded', detail: 'Not in use' });
  });
});

describe('decideAutoConnect (D12)', () => {
  const vpn = createDefaultSettings().vpn;
  it('only on a fresh start, with autoConnect, while off, with an offered location', () => {
    expect(decideAutoConnect(true, { ...vpn, autoConnect: true }, 1)).toBe(true);
    expect(decideAutoConnect(false, { ...vpn, autoConnect: true }, 1)).toBe(false);
    expect(decideAutoConnect(true, vpn, 1)).toBe(false);
    expect(decideAutoConnect(true, { ...vpn, autoConnect: true, mode: 'gateway' }, 1)).toBe(false);
    expect(decideAutoConnect(true, { ...vpn, autoConnect: true }, 0)).toBe(false);
  });
});

describe('nextPollDelay', () => {
  it('60 s while active, backoff 60 s → 2 → 5 min, none without locations or while inactive', () => {
    expect(nextPollDelay({ offered: 2, active: true, errors: 0 })).toBe(60_000);
    expect(nextPollDelay({ offered: 2, active: true, errors: 1 })).toBe(60_000);
    expect(nextPollDelay({ offered: 2, active: true, errors: 2 })).toBe(120_000);
    expect(nextPollDelay({ offered: 2, active: true, errors: 7 })).toBe(300_000);
    expect(nextPollDelay({ offered: 0, active: true, errors: 0 })).toBeNull();
    expect(nextPollDelay({ offered: null, active: true, errors: 0 })).toBeNull();
    expect(nextPollDelay({ offered: 2, active: false, errors: 0 })).toBeNull();
  });
});

describe('VpnStateImpl', () => {
  it('polls every 60 s while on, not while off and unwatched; a watched page polls whatever the mode', async () => {
    const env = fakeVpnEnv();
    const s = new VpnStateImpl(env.deps);
    s.kick();
    expect(env.fetches).toBe(0);
    expect(s.plannedDelay).toBeNull();
    s.connect('se-sto');
    await env.timers.advance(0);
    expect(env.fetches).toBe(1);
    expect(s.plannedDelay).toBe(60_000);
    await env.timers.advance(60_000);
    expect(env.fetches).toBe(2);
    s.disconnect();
    await env.timers.advance(0);
    expect(s.plannedDelay).toBeNull();
    await env.timers.advance(600_000);
    expect(env.fetches).toBe(2);
    const stop = s.watch();
    await env.timers.advance(60_000);
    expect(env.fetches).toBe(4);
    stop();
    expect(s.plannedDelay).toBeNull();
    s.dispose();
  });

  it('backs off after errors and never polls without offered locations', async () => {
    const env = fakeVpnEnv();
    env.answer = new Error('down');
    const s = new VpnStateImpl(env.deps);
    s.watch();
    await env.timers.advance(0);
    expect(s.loadError).toBe('down');
    expect(s.plannedDelay).toBe(60_000);
    await env.timers.advance(60_000);
    expect(s.plannedDelay).toBe(120_000);
    await env.timers.advance(120_000);
    expect(s.plannedDelay).toBe(300_000);
    env.answer = fakeLocations();
    await env.timers.advance(300_000);
    expect(s.loadError).toBeNull();
    expect(s.plannedDelay).toBe(60_000);
    s.dispose();

    const none = fakeVpnEnv();
    none.offered = [];
    const n = new VpnStateImpl(none.deps);
    n.watch();
    await none.timers.advance(600_000);
    expect(none.fetches).toBe(0);
    n.dispose();
  });

  it('connect, disconnect and select write the settings; a switch while connected names the new location', async () => {
    const env = fakeVpnEnv();
    const s = new VpnStateImpl(env.deps);
    s.connect();
    expect(env.vpn).toMatchObject({ mode: 'gateway', preferredLocation: null });
    s.connect('de-fra');
    expect(env.vpn.preferredLocation).toBe('de-fra');
    expect(env.toasts).toEqual(['Now using Frankfurt']);
    expect(s.routeNotice).toBe('Tabs you opened earlier keep their pages. Reload them to load them through Frankfurt.');
    await env.timers.advance(10_000);
    expect(s.routeNotice).toBeNull();
    s.disconnect();
    expect(env.vpn.mode).toBe('off');
    s.select('se-sto');
    expect(env.vpn).toMatchObject({ mode: 'off', preferredLocation: 'se-sto' });
    expect(env.toasts).toHaveLength(1); // off: only selects
    s.dispose();
  });

  it('exitWarning and statusMap come from the locations answer; checks update the exit and cool down', async () => {
    const env = fakeVpnEnv();
    const s = new VpnStateImpl(env.deps);
    await s.refresh();
    expect(s.statusMap()).toEqual({ 'se-sto': 'up', 'de-fra': 'down' });
    expect(s.exitWarning('de-fra')).toBe('connect_failed');
    expect(s.exitWarning('se-sto')).toBeNull();
    expect(s.checkService).toBe('exit-check.example');
    expect((await s.checkNow('se-sto'))?.ip).toBe('198.51.100.8');
    expect(s.locations!.find((l) => l.id === 'se-sto')!.exit.ip).toBe('198.51.100.8');
    expect(s.canCheck('se-sto')).toBe(false);
    expect(await s.checkNow('se-sto')).toBeNull();
    expect(env.checks).toEqual(['se-sto']);
    await env.timers.advance(60_000);
    expect(s.canCheck('se-sto')).toBe(true);
    env.check = { kind: 'denied' };
    await s.checkNow('se-sto');
    expect(s.checkDenied).toBe(true);
    s.dispose();
  });

  it('the connection follows the browser facts, and the server status when none are handed in yet', async () => {
    const env = fakeVpnEnv();
    const s = new VpnStateImpl(env.deps);
    expect(s.connection).toEqual({ kind: 'off' });
    env.vpn = { ...env.vpn, mode: 'gateway' };
    await s.refresh();
    expect(s.connection).toEqual({ kind: 'connected', location: sto, engine: 'not-started', exitWarning: null });
    const facts: BrowserFacts = { vpnLocation: { ...sto, status: 'up' }, engineState: 'ready', profileTransport: [{ state: 'connecting', detail: null }] };
    s.setFacts(facts);
    expect(s.connection).toEqual({ kind: 'connecting', location: sto, exitWarning: null });
    env.vpn = { ...env.vpn, preferredLocation: 'de-fra' };
    s.setFacts(null);
    expect(s.connection).toEqual({ kind: 'blocked', location: { id: 'de-fra', label: 'Frankfurt' }, reason: 'location-down' });
    env.vpn = { ...env.vpn, killSwitch: false };
    expect(s.connection).toEqual({ kind: 'fallback', location: { id: 'de-fra', label: 'Frankfurt' }, reason: 'location-down' });
    s.dispose();
  });
});
