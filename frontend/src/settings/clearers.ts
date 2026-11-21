/**
 * "Clear browsing data" registry. Features that own local data register a named clearer; Settings → Privacy lists
 * them (reactively) and runs the ones the user selects. Clearers must only remove data they own.
 *
 *   registerClearer({ id: 'history', label: 'Browsing history', clear: ({ since }) => history.clear(since) });
 */
import { SvelteMap } from 'svelte/reactivity';

export interface ClearOptions {
  /** Only remove data created at or after this time (ms). Undefined = all time. */
  since?: number;
}

export interface ClearerDef {
  /** Stable id, e.g. 'history', 'cookies', 'cache', 'downloads', 'siteData', 'gamesRecent'. */
  id: string;
  label: string;
  /** One plain sentence describing exactly what is removed. */
  description?: string;
  /** Lower sorts first. */
  order?: number;
  /** Whether the clearer honours `since` (otherwise the UI offers "all time" only). */
  supportsTimeRange?: boolean;
  clear(opts: ClearOptions): Promise<void> | void;
}

export interface ClearResult {
  id: string;
  ok: boolean;
  error?: string;
}

const registry = new SvelteMap<string, ClearerDef>();

export function registerClearer(def: ClearerDef): () => void {
  if (registry.has(def.id)) console.warn(`[gnome] clearer "${def.id}" registered twice; replacing`);
  registry.set(def.id, def);
  return () => {
    if (registry.get(def.id) === def) registry.delete(def.id);
  };
}

/** Reactive, ordered list of registered clearers. */
export function listClearers(): ClearerDef[] {
  return [...registry.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}

/** Runs the selected clearers sequentially; one failure does not stop the others. */
export async function runClearers(ids: readonly string[], opts: ClearOptions = {}): Promise<ClearResult[]> {
  const results: ClearResult[] = [];
  for (const id of ids) {
    const def = registry.get(id);
    if (!def) {
      results.push({ id, ok: false, error: 'Not available' });
      continue;
    }
    try {
      await def.clear(def.supportsTimeRange ? opts : {});
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
