/** Read/write settings by dotted path ("browser.history.enabled") for the settings page. */
import { settings } from '../../settings/store.svelte';
import type { SettingsSection } from '../../settings/schema';
import { deepEqual, type SettingsIssue } from '../../settings/validate';
import { defaultAt, getAt, splitPath, withAt } from './registry';

export function read<T>(path: string): T {
  return getAt(settings.value, path) as T;
}

export function write(path: string, value: unknown): SettingsIssue[] {
  const { section, key, rest } = splitPath(path);
  const current = settings.value[section] as unknown as Record<string, unknown>;
  const next = rest ? withAt(current[key], rest, value) : value;
  return settings.set(section as SettingsSection, key as never, next as never);
}

export function resetPaths(paths: readonly string[]): void {
  for (const p of paths) write(p, structuredClone(defaultAt(p)));
}

export function pathsAreDefault(paths: readonly string[]): boolean {
  return paths.every((p) => deepEqual(read(p), defaultAt(p)));
}
