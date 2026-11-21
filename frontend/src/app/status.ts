/**
 * Status registry for diagnostics. Named subsystems report `{ state, detail }`; the shell (VPN dot, diagnostics
 * view, "Copy diagnostics" command) reads it. Reads are reactive inside Svelte components and effects.
 *
 *   reportStatus('transport', { state: 'ok', detail: 'libcurl over /wisp/' });
 */
import { SvelteMap } from 'svelte/reactivity';

export type StatusState = 'ok' | 'starting' | 'degraded' | 'down' | 'off' | 'unknown';

export interface SubsystemStatus {
  state: StatusState;
  /** One short, human-readable sentence. */
  detail?: string;
  /** Optional structured data for diagnostics (must not contain secrets or browsing data). */
  data?: Record<string, unknown>;
  updatedAt: number;
}

const registry = new SvelteMap<string, SubsystemStatus>();
const listeners = new Set<(name: string, status: SubsystemStatus | undefined) => void>();

export function reportStatus(name: string, status: Omit<SubsystemStatus, 'updatedAt'> & { updatedAt?: number }): void {
  const next: SubsystemStatus = { ...status, updatedAt: status.updatedAt ?? Date.now() };
  const prev = registry.get(name);
  if (prev && prev.state === next.state && prev.detail === next.detail && prev.data === next.data) return;
  registry.set(name, next);
  for (const fn of listeners) fn(name, next);
}

export function clearStatus(name: string): void {
  if (!registry.delete(name)) return;
  for (const fn of listeners) fn(name, undefined);
}

export function getStatus(name: string): SubsystemStatus | undefined {
  return registry.get(name);
}

/** Reactive list sorted by name. */
export function allStatuses(): Array<[string, SubsystemStatus]> {
  return [...registry.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function onStatusChange(fn: (name: string, status: SubsystemStatus | undefined) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Plain JSON snapshot for "Copy diagnostics" / bug reports. */
export function statusSnapshot(): Record<string, SubsystemStatus> {
  return Object.fromEntries(allStatuses());
}
