/**
 * Fakes for the VPN state's tests and the local visual check (docs/WAVE-C.md §7.5): `/api/vpn/locations` answers in
 * the wire shape of §6.2 (two test locations of GNOME's own e2e setup, no provider), a fake check route, fake
 * settings and fake timers. Never used outside tests.
 */
import { createDefaultSettings } from '../../settings/defaults';
import type { Settings } from '../../settings/schema';
import type { CheckResult } from '../api';
import type { VpnDeps } from '../state.svelte';
import type { VpnExit, VpnLocations } from '../types';

export const OK_EXIT: VpnExit = {
  state: 'ok',
  ip: '198.51.100.7',
  country: 'Sweden',
  city: 'Stockholm',
  provider_exit: null,
  country_match: true,
  checked_at: 1_763_900_000_000,
  error: null,
  v6: null,
};

/** Two locations; checks on (`exit-check.example`). */
export function fakeLocations(over: Partial<VpnLocations> = {}): VpnLocations {
  return {
    profiles: [
      {
        id: 'se-sto',
        label: 'Stockholm',
        country_code: 'se',
        country: 'Sweden',
        city: 'Stockholm',
        provider_note: 'Test location of this server',
        path: '/wisp/p/se-sto/',
        status: 'up',
        checked_at: 1_763_900_000_000,
        exit: { ...OK_EXIT },
      },
      {
        id: 'de-fra',
        label: 'Frankfurt',
        country_code: 'de',
        country: 'Germany',
        city: 'Frankfurt',
        provider_note: '',
        path: '/wisp/p/de-fra/',
        status: 'down',
        checked_at: 1_763_900_000_000,
        exit: { ...OK_EXIT, state: 'failed', ip: null, country: null, city: null, country_match: null, error: 'connect_failed' },
      },
    ],
    verify_url: 'https://exit-check.example/json',
    check_service: 'exit-check.example',
    ...over,
  };
}

export const OFFERED = [
  { id: 'se-sto', label: 'Stockholm' },
  { id: 'de-fra', label: 'Frankfurt' },
];

export interface FakeTimers {
  set(fn: () => void, ms: number): number;
  clear(h: unknown): void;
  /** Runs every timer due within `ms`. */
  advance(ms: number): Promise<void>;
  pending(): number[];
  now(): number;
}

export function fakeTimers(start = 1_763_900_000_000): FakeTimers {
  let t = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clear(h) {
      timers.delete(h as number);
    },
    async advance(ms) {
      const end = t + ms;
      await new Promise((r) => setTimeout(r, 0));
      for (;;) {
        const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await new Promise((r) => setTimeout(r, 0));
      }
      t = end;
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => [...timers.values()].map((v) => v.at - t),
    now: () => t,
  };
}

export interface FakeVpnEnv {
  deps: VpnDeps;
  vpn: Settings['vpn'];
  offered: Array<{ id: string; label: string }> | null;
  visible: boolean;
  answer: VpnLocations | Error;
  check: CheckResult;
  fetches: number;
  checks: string[];
  toasts: string[];
  timers: FakeTimers;
}

export function fakeVpnEnv(): FakeVpnEnv {
  const listeners = new Set<() => void>();
  const timers = fakeTimers();
  const env: FakeVpnEnv = {
    vpn: { ...createDefaultSettings().vpn },
    offered: [...OFFERED],
    visible: true,
    answer: fakeLocations(),
    check: { kind: 'ok', exit: { ...OK_EXIT, ip: '198.51.100.8' } },
    fetches: 0,
    checks: [],
    toasts: [],
    timers,
    deps: {
      fetchLocations: async () => {
        env.fetches++;
        await Promise.resolve();
        if (env.answer instanceof Error) throw env.answer;
        return structuredClone(env.answer);
      },
      checkLocation: async (id) => {
        env.checks.push(id);
        return env.check;
      },
      vpn: () => env.vpn,
      setVpn: (key, value) => {
        env.vpn = { ...env.vpn, [key]: value };
        for (const fn of listeners) fn();
      },
      onVpnChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      offered: () => env.offered,
      visible: () => env.visible,
      toast: (m) => env.toasts.push(m),
      now: () => timers.now(),
      setTimeout: (fn, ms) => timers.set(fn, ms),
      clearTimeout: (h) => timers.clear(h),
    },
  };
  return env;
}
