/**
 * The VPN state (docs/WAVE-C.md §7.1–7.2), one per app page: the location list and exits from
 * `GET /api/vpn/locations`, the connection as the app knows it (D13), connect / disconnect / location choice
 * (D12: `vpn.mode` and `vpn.killSwitch` are device-local, `settings/local-vpn.ts`) and on-demand exit checks.
 *
 * Polling: every 60 s while `vpn.mode` is `gateway` or the VPN page is visible (`watch()`), at once on a mode or
 * location change and when the page becomes visible; after errors 60 s → 2 min → 5 min; never while the server offers
 * no locations. Exit-check results never change the connection (D14): a failure is `exitWarning`, a warning only.
 */
import type { StatusState } from '../app/status';
import type { Settings } from '../settings/schema';
import type { CheckResult } from './api';
import { appVpnDeps } from './app-deps';
import type { ExitError, VpnConnection, VpnExit, VpnLocation, VpnLocations, VpnLocationRef } from './types';

export interface BrowserFacts {
  /** `browser.vpnLocation`: the profile route the app chose (null off the profile route). */
  readonly vpnLocation: { id: string; label: string; status: 'up' | 'down' | 'unknown' | 'gone' | 'none' } | null;
  readonly engineState: string; // Browser.engineState
  /** The engine host's transport sides whose `endpoint` is `profile` (EngineHostStatus.transport). */
  readonly profileTransport: ReadonlyArray<{ state: 'connecting' | 'ready' | 'degraded' | 'offline'; detail: string | null }>;
}

export interface VpnState {
  readonly locations: readonly VpnLocation[] | null; // null until the first answer
  readonly verifyUrl: string | null;
  readonly checkService: string | null;
  readonly loadError: string | null;
  readonly connection: VpnConnection;
  /** The health status per location for the route choice (lane v3): `/api/vpn/locations` `status` only — exit
   *  checks never enter it (D14). */
  statusMap(): Readonly<Record<string, 'up' | 'down' | 'unknown'>>;
  /** The server's last check of this location failed: its error, else null (a warning only, D14). */
  exitWarning(id: string): ExitError | null;
  connect(locationId?: string | null): void;
  disconnect(): void;
  select(locationId: string | null): void;
  checkNow(id: string): Promise<VpnExit | null>;
  refresh(): Promise<void>;
  /** The VPN page is visible: poll every 60 s whatever the mode; returns the stop function. */
  watch(): () => void;
}

/** Pure: whether a fresh start turns the VPN on (D12): fresh, `autoConnect` on, mode off, and the server offers at
 *  least one location (`/api/config` wisp.profiles; v3 calls it once that is known, before any tab is live). */
export function decideAutoConnect(fresh: boolean, s: Settings['vpn'], offeredLocations: number): boolean {
  return fresh && s.autoConnect && s.mode === 'off' && offeredLocations > 0;
}

const ENGINE_RUNNING: ReadonlySet<string> = new Set(['ready', 'unresponsive']);
const ENGINE_STARTING: ReadonlySet<string> = new Set(['starting', 'connecting']);

/** Pure: the app's facts → the connection the page and the chip show (D13). */
export function connectionOf(i: {
  mode: 'off' | 'gateway';
  killSwitch: boolean;
  offered: ReadonlyArray<{ id: string; label: string }> | null; // /api/config wisp.profiles; null = not loaded
  route: BrowserFacts['vpnLocation'];
  status: Readonly<Record<string, 'up' | 'down' | 'unknown'>>;
  exitWarning: (id: string) => ExitError | null;
  engineState: string;
  profileTransport: BrowserFacts['profileTransport'];
  /** `vpn.preferredLocation` (additive, lane v1): names the location a fallback is about when the browser left the
   *  profile route (kill switch off), where `route` is null. Omitted: the Automatic choice (D17). */
  preferred?: string | null;
}): VpnConnection {
  if (i.mode === 'off') return { kind: 'off' };
  const unusable = (location: VpnLocationRef | null, reason: 'location-down' | 'location-gone' | 'no-location'): VpnConnection =>
    i.killSwitch ? { kind: 'blocked', location, reason } : { kind: 'fallback', location, reason };
  const offered = i.offered;
  if (offered && offered.length === 0) return unusable(null, 'no-location');
  const labelOf = (id: string) => offered?.find((p) => p.id === id)?.label || id;

  if (!i.route) {
    // Mode on but off the profile route: the browser fell back to this server's own connection (kill switch off).
    if (!offered) return unusable(null, 'no-location');
    const pick =
      (i.preferred && i.preferred) || offered.find((p) => i.status[p.id] === 'up')?.id || offered[0]?.id || null;
    if (!pick) return unusable(null, 'no-location');
    const ref = { id: pick, label: labelOf(pick) };
    return unusable(ref, offered.some((p) => p.id === pick) ? 'location-down' : 'location-gone');
  }

  const r = i.route;
  if (r.status === 'none') return unusable(null, 'no-location');
  const ref: VpnLocationRef = { id: r.id, label: r.label || labelOf(r.id) };
  if (r.status === 'gone' || (offered && !offered.some((p) => p.id === r.id))) return unusable(ref, 'location-gone');
  if (i.status[r.id] === 'down' || r.status === 'down') return unusable(ref, 'location-down');
  const exitWarning = i.exitWarning(r.id);

  if (ENGINE_RUNNING.has(i.engineState)) {
    const sides = i.profileTransport;
    if (sides.some((s) => s.state === 'ready')) return { kind: 'connected', location: ref, engine: 'running', exitWarning };
    if (sides.some((s) => s.state === 'connecting' || s.state === 'degraded')) return { kind: 'connecting', location: ref, exitWarning };
    if (sides.some((s) => s.state === 'offline' && s.detail === 'unknown-profile')) return unusable(ref, 'location-gone');
    if (sides.some((s) => s.state === 'offline' && s.detail === 'upstream-unreachable')) return unusable(ref, 'location-down');
    return { kind: 'connecting', location: ref, exitWarning };
  }
  if (ENGINE_STARTING.has(i.engineState)) return { kind: 'connecting', location: ref, exitWarning };
  return { kind: 'connected', location: ref, engine: 'not-started', exitWarning };
}

/** Pure: the chip for a connection (null = no chip). */
export function chipStatus(c: VpnConnection): { state: StatusState; detail: string } | null {
  switch (c.kind) {
    case 'off':
      return null;
    case 'connected':
      return c.exitWarning ? { state: 'degraded', detail: `${c.location.label} · exit check failing` } : { state: 'ok', detail: c.location.label };
    case 'connecting':
      return { state: 'starting', detail: c.location.label };
    case 'blocked':
      return { state: 'down', detail: 'Blocked' };
    case 'fallback':
      return { state: 'degraded', detail: 'Not in use' };
  }
}

/** The polling plan: ms until the next `/api/vpn/locations` request, or null for none. */
export function nextPollDelay(p: { offered: number | null; active: boolean; errors: number }): number | null {
  if (!p.offered || !p.active) return null;
  if (p.errors <= 0) return 60_000;
  return [60_000, 120_000, 300_000][Math.min(p.errors, 3) - 1]!;
}

/** Seconds a location's "Check again" stays disabled after a check. */
export const CHECK_COOLDOWN_MS = 60_000;

export interface VpnDeps {
  fetchLocations(signal?: AbortSignal): Promise<VpnLocations>;
  checkLocation(id: string): Promise<CheckResult>;
  /** The `vpn` settings section (reactive in the app). */
  vpn(): Settings['vpn'];
  setVpn<K extends keyof Settings['vpn']>(key: K, value: Settings['vpn'][K]): void;
  /** Subscribes to settings changes of the `vpn` section; returns the unsubscribe function. */
  onVpnChange(fn: () => void): () => void;
  /** `/api/config` wisp.profiles; null until the configuration loaded. */
  offered(): ReadonlyArray<{ id: string; label: string }> | null;
  /** Whether the document is visible (no polling in hidden tabs). */
  visible(): boolean;
  toast?(message: string): void;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** How long the pre-v3 "Tabs you opened earlier keep their pages" notice stays. */
export const ROUTE_NOTICE_MS = 10_000;

export class VpnStateImpl implements VpnState {
  #deps: VpnDeps;
  #data = $state.raw<VpnLocations | null>(null);
  #loadError = $state<string | null>(null);
  #facts = $state.raw<BrowserFacts | null>(null);
  #errors = 0;
  #watchers = $state(0);
  #timer: unknown = null;
  #inflight: Promise<void> | null = null;
  #lastChecked = $state.raw<Record<string, number>>({});
  #checking = $state.raw<Record<string, boolean>>({});
  #denied = $state(false);
  #routeNotice = $state<string | null>(null);
  #noticeTimer: unknown = null;
  #lastMode: string;
  #lastPreferred: string | null;
  #off: () => void;

  constructor(deps: VpnDeps) {
    this.#deps = deps;
    this.#lastMode = deps.vpn().mode;
    this.#lastPreferred = deps.vpn().preferredLocation;
    this.#off = deps.onVpnChange(() => this.#onSettings());
  }

  get locations(): readonly VpnLocation[] | null {
    return this.#data?.profiles ?? null;
  }
  get verifyUrl(): string | null {
    return this.#data?.verify_url ?? null;
  }
  get checkService(): string | null {
    return this.#data?.check_service ?? null;
  }
  get loadError(): string | null {
    return this.#loadError;
  }
  /** "Enter the access code or sign in to see exit checks." (the last on-demand check answered 401). */
  get checkDenied(): boolean {
    return this.#denied;
  }
  /** The pre-v3 route-change notice, for 10 s after a change while connected. */
  get routeNotice(): string | null {
    return this.#routeNotice;
  }
  get facts(): BrowserFacts | null {
    return this.#facts;
  }

  get connection(): VpnConnection {
    const s = this.#deps.vpn();
    const f = this.#facts;
    return connectionOf({
      mode: s.mode,
      killSwitch: s.killSwitch,
      offered: this.#deps.offered(),
      route: f ? f.vpnLocation : this.#guessRoute(),
      status: this.statusMap(),
      exitWarning: (id) => this.exitWarning(id),
      engineState: f?.engineState ?? 'idle',
      profileTransport: f?.profileTransport ?? [],
      preferred: s.preferredLocation,
    });
  }

  /** Before the browser's facts are handed in: the route chooseRoute would pick (no engine host yet). */
  #guessRoute(): BrowserFacts['vpnLocation'] {
    const s = this.#deps.vpn();
    if (s.mode !== 'gateway') return null;
    const offered = this.#deps.offered();
    const id = s.preferredLocation || offered?.[0]?.id || null;
    if (!id) return s.killSwitch ? { id: '', label: '', status: 'none' } : null;
    const status = this.statusMap()[id] ?? 'unknown';
    if (!s.killSwitch && status === 'down') return null;
    const p = offered?.find((o) => o.id === id);
    if (offered && !p) return s.killSwitch ? { id, label: id, status: 'gone' } : null;
    return { id, label: p?.label || id, status };
  }

  setFacts(facts: BrowserFacts | null): void {
    this.#facts = facts;
  }

  statusMap(): Readonly<Record<string, 'up' | 'down' | 'unknown'>> {
    const out: Record<string, 'up' | 'down' | 'unknown'> = {};
    for (const l of this.#data?.profiles ?? []) out[l.id] = l.status;
    return out;
  }

  exitWarning(id: string): ExitError | null {
    const exit = this.#data?.profiles.find((l) => l.id === id)?.exit;
    if (!exit || exit.state !== 'failed') return null;
    return exit.error ?? 'bad_answer';
  }

  /** Whether "Check again" may be pressed for this location now. */
  canCheck(id: string): boolean {
    if (this.#checking[id]) return false;
    const last = this.#lastChecked[id];
    return last === undefined || this.#now() - last >= CHECK_COOLDOWN_MS;
  }

  connect(locationId?: string | null): void {
    if (locationId !== undefined) this.#deps.setVpn('preferredLocation', locationId);
    this.#deps.setVpn('mode', 'gateway');
  }

  disconnect(): void {
    this.#deps.setVpn('mode', 'off');
  }

  select(locationId: string | null): void {
    const before = this.#deps.vpn().preferredLocation;
    if (before === locationId) return;
    this.#deps.setVpn('preferredLocation', locationId);
  }

  async checkNow(id: string): Promise<VpnExit | null> {
    if (!this.canCheck(id)) return null;
    this.#checking = { ...this.#checking, [id]: true };
    try {
      const r = await this.#deps.checkLocation(id);
      this.#lastChecked = { ...this.#lastChecked, [id]: this.#now() };
      if (r.kind === 'denied') {
        this.#denied = true;
        return null;
      }
      if (r.kind !== 'ok') return null;
      this.#denied = false;
      const data = this.#data;
      if (data) this.#data = { ...data, profiles: data.profiles.map((l) => (l.id === id ? { ...l, exit: r.exit } : l)) };
      return r.exit;
    } finally {
      this.#checking = { ...this.#checking, [id]: false };
    }
  }

  refresh(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    const offered = this.#deps.offered();
    if (offered && offered.length === 0) {
      this.#schedule();
      return Promise.resolve();
    }
    const run = (async () => {
      try {
        this.#data = await this.#deps.fetchLocations();
        this.#loadError = null;
        this.#errors = 0;
      } catch (err) {
        this.#errors++;
        this.#loadError = err instanceof Error ? err.message : 'The VPN locations could not be loaded.';
      } finally {
        this.#inflight = null;
        this.#schedule();
      }
    })();
    this.#inflight = run;
    return run;
  }

  watch(): () => void {
    this.#watchers++;
    void this.refresh();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.#watchers--;
      this.#schedule();
    };
  }

  /** Something the plan depends on changed (configuration loaded, page visible again): fetch at once when active. */
  kick(): void {
    if (this.#active()) void this.refresh();
    else this.#schedule();
  }

  dispose(): void {
    this.#off();
    this.#clear();
    if (this.#noticeTimer) (this.#deps.clearTimeout ?? clearTimeout)(this.#noticeTimer as ReturnType<typeof setTimeout>);
  }

  /** For tests and diagnostics: the delay the scheduler chose last (null = none). */
  plannedDelay: number | null = null;

  #active(): boolean {
    return this.#deps.visible() && (this.#deps.vpn().mode === 'gateway' || this.#watchers > 0);
  }

  #schedule(): void {
    this.#clear();
    const offered = this.#deps.offered();
    const delay = nextPollDelay({ offered: offered ? offered.length : null, active: this.#active(), errors: this.#errors });
    this.plannedDelay = delay;
    if (delay === null) return;
    this.#timer = (this.#deps.setTimeout ?? setTimeout)(() => {
      this.#timer = null;
      void this.refresh();
    }, delay);
  }

  #clear(): void {
    if (this.#timer !== null) (this.#deps.clearTimeout ?? clearTimeout)(this.#timer as ReturnType<typeof setTimeout>);
    this.#timer = null;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #onSettings(): void {
    const s = this.#deps.vpn();
    const modeChanged = s.mode !== this.#lastMode;
    const locationChanged = s.preferredLocation !== this.#lastPreferred;
    this.#lastMode = s.mode;
    this.#lastPreferred = s.preferredLocation;
    if (!modeChanged && !locationChanged) return;
    if (s.mode === 'gateway') {
      const label = this.#labelOf(s.preferredLocation);
      if (locationChanged && !modeChanged && label) this.#deps.toast?.(`Now using ${label}`);
      if (label) this.#showNotice(label);
    } else {
      this.#routeNotice = null;
    }
    this.kick();
  }

  #labelOf(id: string | null): string | null {
    const offered = this.#deps.offered();
    const pick = id ?? offered?.find((p) => this.statusMap()[p.id] === 'up')?.id ?? offered?.[0]?.id ?? null;
    if (!pick) return null;
    return offered?.find((p) => p.id === pick)?.label || this.#data?.profiles.find((l) => l.id === pick)?.label || pick;
  }

  #showNotice(label: string): void {
    const set = this.#deps.setTimeout ?? setTimeout;
    const clear = this.#deps.clearTimeout ?? clearTimeout;
    if (this.#noticeTimer) clear(this.#noticeTimer as ReturnType<typeof setTimeout>);
    this.#routeNotice = `Tabs you opened earlier keep their pages. Reload them to load them through ${label}.`;
    this.#noticeTimer = set(() => {
      this.#routeNotice = null;
      this.#noticeTimer = null;
    }, ROUTE_NOTICE_MS);
  }
}

let instance: VpnStateImpl | null = null;
let pendingFacts: BrowserFacts | null = null;

/** The app page's one VPN state over the real settings store, server configuration and API (created on first use). */
export function vpnState(): VpnStateImpl {
  if (!instance) {
    instance = new VpnStateImpl(appVpnDeps());
    if (pendingFacts) instance.setFacts(pendingFacts);
  }
  return instance;
}

/** The browser's read-only facts (start.ts hands them in once the browser module loaded). */
export function setBrowserFacts(facts: BrowserFacts | null): void {
  pendingFacts = facts;
  instance?.setFacts(facts);
}

/** Tests: drop the instance. */
export function resetVpnState(): void {
  instance?.dispose();
  instance = null;
  pendingFacts = null;
}
