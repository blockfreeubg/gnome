/**
 * The engine set in force in the engine host (WAVE-B3 §4.1, D7): loaded by dynamic import() inside createBlocker (its
 * own chunk: the library never enters the engine host's entry chunk), deserialized per group, the preprocessor env
 * applied, warmed up in idle time, swapped after a build. Implements FilterEngines (what x2 and x3 read) and the
 * network provider's GroupMatcher.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker';
import type { BlockerGroup } from '../../shared/engine-protocol';
import { MATCH_ORDER } from '../core/categories';
import type { SitePolicy } from '../core/policy';
import { listDomainOf } from '../core/site';
import type { GroupMatch, GroupMatcher } from './network';
import { scriptletCall } from './scriptlets';

export interface CosmeticsResult {
  /** CSS to insert: hiding rules (`display: none !important`) and `:style()` rules; '' when none. */
  styles: string;
  /**
   * Scriptlet sources for PageKit.run, deduplicated, each built by scriptletCall() from a matched script-inject filter
   * of `matchCosmeticFilters` that has no exception (the same selection getCosmeticsFilters makes).
   */
  scripts: string[];
}

export interface FilterEngines {
  /** Some group engines are in force (built, or loaded from a verified cache). */
  ready(): boolean;
  /**
   * At document start: hostname-specific rules (plus the generic base stylesheet when `policy.genericHide`) of the groups
   * the policy allows; styles only when `policy.hide`, scriptlets per group toggle (D2). Empty when not ready.
   */
  cosmetics(url: string, policy: SitePolicy): CosmeticsResult;
  /** Generic rules for classes, ids and hrefs that appeared in a document (x2's monitor), when `policy.genericHide`. */
  cosmeticsForFeatures(url: string, policy: SitePolicy, features: { classes: readonly string[]; ids: readonly string[]; hrefs: readonly string[] }): string;
  /**
   * The params group's `$removeparam` result for a document URL (the `$removeparam` filters of every enabled list, D1);
   * null without a change, with the group off, or not ready.
   */
  rewriteParams(url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame'): string | null;
  /** The engines in force changed (a swap after a build, a reload). */
  onChange(listener: () => void): () => void;
}

/** One loaded set: its key and the group engines (views into their bytes, which the set keeps for the SW). */
export interface EngineSet {
  readonly setId: string;
  readonly engines: ReadonlyMap<BlockerGroup, FiltersEngine>;
  readonly bytes: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>;
}

const yieldTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Deserializes each group in its own task (a version or checksum mismatch throws: the caller treats it as a miss) and
 * applies the env. The bytes stay referenced: the engines are views into them, and the SW gets a copy.
 */
export async function loadEngineSet(setId: string, groups: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>, env: Map<string, boolean>): Promise<EngineSet> {
  const engines = new Map<BlockerGroup, FiltersEngine>();
  for (const g of groups) {
    const e = FiltersEngine.deserialize(new Uint8Array(g.bytes));
    e.updateEnv(env);
    engines.set(g.group, e);
    await yieldTask();
  }
  return { setId, engines, bytes: groups };
}

/** A few synthetic matches in idle time (filters materialize lazily: the first 1,000 matches cost ~45 ms). */
export function warmUp(set: EngineSet, idle: (cb: () => void) => void): void {
  const urls = ['https://ads.example.com/ad.js', 'https://www.example.org/pixel.gif', 'https://cdn.example.net/app.css', 'https://track.example.io/collect'];
  let i = 0;
  const step = (): void => {
    const end = Math.min(i + 50, 200);
    for (; i < end; i++) {
      const url = `${urls[i % urls.length] ?? ''}?n=${i}`;
      for (const e of set.engines.values()) e.match(Request.fromRawDetails({ url, sourceUrl: 'https://news.example/', type: i % 2 ? 'script' : 'image' }));
    }
    if (i < 200) idle(step);
  };
  idle(step);
}

export class EnginesInForce implements FilterEngines, GroupMatcher {
  #set: EngineSet | null = null;
  readonly #listeners = new Set<() => void>();

  get set(): EngineSet | null {
    return this.#set;
  }

  /** Swaps the set in force (D7: the previous one stays until this moment). */
  swap(set: EngineSet | null): void {
    this.#set = set;
    for (const l of [...this.#listeners]) {
      try {
        l();
      } catch {
        /* a listener's problem */
      }
    }
  }

  ready(): boolean {
    return this.#set !== null && this.#set.engines.size > 0;
  }

  match(group: BlockerGroup, url: string, sourceUrl: string, type: string): GroupMatch | null {
    const e = this.#set?.engines.get(group);
    if (!e) return null;
    const r = e.match(Request.fromRawDetails({ url, sourceUrl, type: type as never }));
    return { match: r.match, redirect: r.redirect ? { contentType: r.redirect.contentType, body: r.redirect.body } : undefined };
  }

  cosmetics(url: string, policy: SitePolicy): CosmeticsResult {
    const out: CosmeticsResult = { styles: '', scripts: [] };
    const set = this.#set;
    const page = pageOf(url);
    if (!set || !page) return out;
    const styles: string[] = [];
    const scripts = new Set<string>();
    for (const group of MATCH_ORDER) {
      const e = set.engines.get(group);
      if (!e || !policy.groups[group]) continue;
      if (policy.hide) {
        const r = e.getCosmeticsFilters({
          url,
          hostname: page.hostname,
          domain: page.domain,
          getBaseRules: policy.genericHide,
          getInjectionRules: false,
          getExtendedRules: false,
          getRulesFromDOM: false,
          getRulesFromHostname: true,
        });
        if (r.styles) styles.push(r.styles);
      }
      const m = e.matchCosmeticFilters({
        url,
        hostname: page.hostname,
        domain: page.domain,
        getRulesFromDOM: false,
        getRulesFromHostname: true,
        getInjectionRules: true,
        getExtendedRules: false,
      });
      for (const { filter, exception } of m.matches) {
        if (filter === undefined || exception !== undefined || !filter.isScriptInject()) continue;
        const parsed = filter.parseScript();
        if (!parsed) continue;
        const template = e.resources.getScriptlet(parsed.name);
        if (template === undefined) continue;
        const call = scriptletCall(template, parsed.args);
        if (call !== null) scripts.add(call);
      }
    }
    out.styles = styles.join('\n');
    out.scripts = [...scripts];
    return out;
  }

  cosmeticsForFeatures(url: string, policy: SitePolicy, features: { classes: readonly string[]; ids: readonly string[]; hrefs: readonly string[] }): string {
    const set = this.#set;
    const page = pageOf(url);
    if (!set || !page || !policy.genericHide) return '';
    const styles: string[] = [];
    for (const group of MATCH_ORDER) {
      const e = set.engines.get(group);
      if (!e || !policy.groups[group]) continue;
      const r = e.getCosmeticsFilters({
        url,
        hostname: page.hostname,
        domain: page.domain,
        classes: [...features.classes],
        ids: [...features.ids],
        hrefs: [...features.hrefs],
        getBaseRules: false,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromDOM: true,
        getRulesFromHostname: false,
      });
      if (r.styles) styles.push(r.styles);
    }
    return styles.join('\n');
  }

  rewriteParams(url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame'): string | null {
    const e = this.#set?.engines.get('params');
    if (!e) return null;
    const r = e.match(Request.fromRawDetails({ url, sourceUrl: type === 'main_frame' ? url : (documentUrl ?? url), type }));
    const to = r.rewrite?.url;
    return typeof to === 'string' && to !== url ? to : null;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function pageOf(url: string): { hostname: string; domain: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const hostname = u.hostname.replace(/\.$/, '');
    return { hostname, domain: listDomainOf(hostname) };
  } catch {
    return null;
  }
}
