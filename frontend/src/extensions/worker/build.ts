/**
 * Building the group engines from verified list text (WAVE-B3 §4.1, D1, D12). Pure apart from the library: unit-tested
 * in node with the real @ghostery/adblocker. The builder Worker (builder.worker.ts) feeds it the lists it downloaded,
 * x2's sanitizer and a selector validator that asks the engine host's main thread (D8).
 *
 * Per group, one after the other (the engine and its text are dropped before the next): the kept lines of the
 * group's lists, plus the `shared` lines of every list (exceptions, `$badfilter`, `$redirect-rule`), plus, for the
 * `params` group, the `$removeparam` lines of every list → FiltersEngine.parse(ENGINE_CONFIG) → updateResources →
 * selector validation → update({removedCosmeticFilters}) → serialize → onGroup (the bytes, exactly sized).
 */
import { FiltersEngine } from '@ghostery/adblocker';
import type { BlockerGroup, BlockerListStats, FilterListRef } from '../../shared/engine-protocol';
import { BLOCKER_GROUPS } from '../../shared/engine-protocol';
import { GROUP_OF } from '../core/categories';
import type { SanitizeOptions, SanitizeResult } from '../core/sanitize';
import { ENGINE_CONFIG } from '../filters/config';
import type { FetchedList } from '../filters/lists';

export interface BuildDeps {
  sanitize(text: string, opts: SanitizeOptions): SanitizeResult;
  trustOnly(resources: unknown): ReadonlySet<string>;
  /**
   * Ids (CosmeticFilter.getId) of the selectors to drop, of `[id, selector]` pairs that reach a stylesheet; `styles`:
   * `[id, declarations]` of the `:style()` rules among them (x2's validateSelectors keeps a root or body hit of such a
   * rule when its declarations only restore the page, e.g. the lists' `body:style(overflow: auto !important)` unbreak
   * rules).
   */
  validate(group: BlockerGroup, pairs: Array<[number, string]>, styles: Array<[number, string]>): Promise<number[]>;
  /** A group is built: its serialized engine (an ArrayBuffer of exactly its bytes). */
  onGroup(out: GroupOutput): void;
  /** Applied after the build (the library does not serialize the env). */
  env: Map<string, boolean>;
}

export interface GroupOutput {
  group: BlockerGroup;
  bytes: ArrayBuffer;
  network: number;
  cosmetic: number;
  scriptlets: number;
}

export interface BuildResult {
  groups: Array<Omit<GroupOutput, 'bytes'> & { size: number }>;
  lists: BlockerListStats[];
  resources: { redirects: number; scriptlets: number } | null;
}

export interface ResourcesInput {
  ref: FilterListRef;
  /** The verified ubo-resources JSON text, or null when it failed (its list entry says why). */
  fetched: FetchedList;
}

/** The serialized bytes as an ArrayBuffer of exactly their length (serialize() may return a view into a larger one). */
export function exactBuffer(u: Uint8Array): ArrayBuffer {
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength && u.buffer instanceof ArrayBuffer) return u.buffer;
  return u.slice().buffer as ArrayBuffer;
}

export async function buildEngines(lists: readonly FetchedList[], resources: ResourcesInput | null, deps: BuildDeps): Promise<BuildResult> {
  const stats: BlockerListStats[] = [];
  let resourcesText: string | null = null;
  let resourcesSha = '';
  let resourcesJson: unknown = null;
  if (resources) {
    const r = resources.fetched;
    if (r.ok) {
      try {
        resourcesJson = JSON.parse(r.text);
        resourcesText = r.text;
        resourcesSha = r.ref.sha256;
        stats.push({ id: r.ref.id, sha256: r.ref.sha256, state: 'compiled', error: null, rules: 0, dropped: 0 });
      } catch {
        stats.push({ id: r.ref.id, sha256: r.ref.sha256, state: 'failed', error: 'build', rules: 0, dropped: 0 });
      }
    } else {
      stats.push({ id: r.ref.id, sha256: r.ref.sha256, state: 'failed', error: r.error, rules: 0, dropped: 0 });
    }
  }
  const requiresTrust = deps.trustOnly(resourcesJson);

  // Sanitize every list once; keep only what the groups need.
  const own = new Map<BlockerGroup, string[]>();
  const shared: string[] = [];
  const params: string[] = [];
  for (const l of lists) {
    if (l.ref.category === 'resources') continue;
    if (!l.ok) {
      stats.push({ id: l.ref.id, sha256: l.ref.sha256, state: 'failed', error: l.error, rules: 0, dropped: 0 });
      continue;
    }
    let s: SanitizeResult;
    try {
      s = deps.sanitize(l.text, { trusted: l.ref.trusted, requiresTrust });
    } catch {
      stats.push({ id: l.ref.id, sha256: l.ref.sha256, state: 'failed', error: 'build', rules: 0, dropped: 0 });
      continue;
    }
    const g = GROUP_OF[l.ref.category];
    const texts = own.get(g) ?? [];
    texts.push(s.text);
    own.set(g, texts);
    shared.push(...s.shared);
    params.push(...s.params);
    stats.push({ id: l.ref.id, sha256: l.ref.sha256, state: 'compiled', error: null, rules: s.rules, dropped: s.dropped });
  }
  if (params.length && !own.has('params')) own.set('params', []);

  const groups: BuildResult['groups'] = [];
  let resourceCounts: BuildResult['resources'] = null;
  const sharedText = shared.join('\n');
  for (const group of BLOCKER_GROUPS) {
    const texts = own.get(group);
    if (!texts) continue;
    own.delete(group);
    let text = texts.join('\n');
    if (sharedText) text += `\n${sharedText}`;
    if (group === 'params' && params.length) text += `\n${params.join('\n')}`;
    let engine: FiltersEngine | null = FiltersEngine.parse(text, ENGINE_CONFIG);
    text = '';
    if (resourcesText !== null) engine.updateResources(resourcesText, resourcesSha);
    engine.updateEnv(deps.env);
    const { networkFilters, cosmeticFilters } = engine.getFilters();
    const pairs: Array<[number, string]> = [];
    const styles: Array<[number, string]> = [];
    let scriptlets = 0;
    for (const f of cosmeticFilters) {
      if (f.isScriptInject()) scriptlets++;
      else if (!f.isUnhide()) {
        pairs.push([f.getId(), f.getSelector()]);
        if (f.hasCustomStyle()) styles.push([f.getId(), f.getStyle()]);
      }
    }
    const drop = pairs.length ? await deps.validate(group, pairs, styles) : [];
    if (drop.length) engine.update({ removedCosmeticFilters: drop });
    const bytes = exactBuffer(engine.serialize());
    if (resourceCounts === null && resourcesText !== null) {
      resourceCounts = { redirects: engine.resources.resources.length, scriptlets: engine.resources.scriptlets.length };
    }
    const out: GroupOutput = { group, bytes, network: networkFilters.length, cosmetic: cosmeticFilters.length - scriptlets - drop.length, scriptlets };
    engine = null;
    groups.push({ group, size: bytes.byteLength, network: out.network, cosmetic: out.cosmetic, scriptlets: out.scriptlets });
    deps.onGroup(out);
  }
  stats.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { groups, lists: stats, resources: resourceCounts };
}
