/**
 * VPN locations client (docs/WAVE-C.md §6.2, §7.2) over `src/lib/api.ts`. Shape-checked: an older server without
 * `exit` / `check_service` gets `exit.state 'unchecked'` and the check URL's host; a malformed location is dropped.
 */
import { api, ApiError, isApiError } from '../lib/api';
import type { ExitError, LocationStatus, VpnExit, VpnLocation, VpnLocations } from './types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const STATUSES: ReadonlySet<string> = new Set<LocationStatus>(['up', 'down', 'unknown']);
const EXIT_ERRORS: ReadonlySet<string> = new Set<ExitError>(['upstream_unreachable', 'connect_failed', 'tls_failed', 'http_status', 'bad_answer', 'timeout']);
const EXIT_STATES: ReadonlySet<string> = new Set(['ok', 'failed', 'unchecked', 'off']);

const exitError = (v: unknown): ExitError | null => (typeof v === 'string' && EXIT_ERRORS.has(v) ? (v as ExitError) : null);

/** The exit of a location as the client may show it; anything unreadable is `unchecked`. */
export const UNCHECKED: VpnExit = Object.freeze({
  state: 'unchecked',
  ip: null,
  country: null,
  city: null,
  provider_exit: null,
  country_match: null,
  checked_at: null,
  error: null,
  v6: null,
}) as VpnExit;

export function parseExit(v: unknown): VpnExit {
  if (!isRec(v) || typeof v.state !== 'string' || !EXIT_STATES.has(v.state)) return { ...UNCHECKED };
  let v6: VpnExit['v6'] = null;
  if (isRec(v.v6) && (v.v6.state === 'ok' || v.v6.state === 'failed' || v.v6.state === 'unchecked')) {
    v6 = { state: v.v6.state, ip: str(v.v6.ip), error: exitError(v.v6.error) };
  }
  return {
    state: v.state as VpnExit['state'],
    ip: str(v.ip),
    country: str(v.country),
    city: str(v.city),
    provider_exit: bool(v.provider_exit),
    country_match: bool(v.country_match),
    checked_at: num(v.checked_at),
    error: exitError(v.error),
    v6,
  };
}

function parseLocation(v: unknown): VpnLocation | null {
  if (!isRec(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const status = typeof v.status === 'string' && STATUSES.has(v.status) ? (v.status as LocationStatus) : 'unknown';
  return {
    id,
    label: str(v.label) || id,
    country_code: (str(v.country_code) ?? '').toLowerCase(),
    country: str(v.country) ?? '',
    city: str(v.city) ?? '',
    provider_note: str(v.provider_note) ?? '',
    path: str(v.path) ?? '',
    status,
    checked_at: num(v.checked_at),
    exit: parseExit(v.exit),
  };
}

/** The check URL's host, with `:port` when it is not the scheme's default (as the server words it). */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function parseLocations(v: unknown): VpnLocations {
  if (!isRec(v) || !Array.isArray(v.profiles)) {
    throw new ApiError({ status: 200, code: 'invalid_response', message: 'The GNOME server sent an unexpected response.' });
  }
  const profiles = v.profiles.map(parseLocation).filter((l): l is VpnLocation => l !== null);
  const verify_url = str(v.verify_url);
  const check_service = str(v.check_service) ?? hostOf(verify_url);
  return { profiles, verify_url, check_service };
}

/** Shape-checked; an older server without `exit` / `check_service` gets `exit.state 'unchecked'` and the URL's host. */
export async function fetchLocations(signal?: AbortSignal): Promise<VpnLocations> {
  return parseLocations(await api.get<unknown>('/api/vpn/locations', { timeoutMs: 8000, ...(signal ? { signal } : {}) }));
}

export type CheckResult = { kind: 'ok'; exit: VpnExit } | { kind: 'denied' } | { kind: 'unavailable' } | { kind: 'failed'; message: string };

/** `POST /api/vpn/locations/:id/check` with the reason when it gave no exit (401 = the access policy, §6.2). */
export async function checkLocationResult(id: string): Promise<CheckResult> {
  try {
    const v = await api.post<unknown>(`/api/vpn/locations/${encodeURIComponent(id)}/check`, undefined, { timeoutMs: 40_000 });
    if (!isRec(v)) return { kind: 'failed', message: 'The GNOME server sent an unexpected response.' };
    return { kind: 'ok', exit: parseExit(v.exit) };
  } catch (err) {
    if (isApiError(err) && (err.status === 401 || err.code === 'access_code_required' || err.code === 'login_required')) return { kind: 'denied' };
    if (isApiError(err) && err.status === 404) return { kind: 'unavailable' };
    return { kind: 'failed', message: err instanceof Error ? err.message : 'The check failed.' };
  }
}

/** `POST /api/vpn/locations/:id/check`; null when the server has no check route (404) or the request failed. */
export async function checkLocation(id: string): Promise<VpnExit | null> {
  const r = await checkLocationResult(id);
  return r.kind === 'ok' ? r.exit : null;
}
