/**
 * The service worker's engines (WAVE-B3 D15, §4.5): received by message from an engine host
 * (`gnome-blocker-engines`; the SW never reads Cache Storage), deserialized, the preprocessor env applied. The most
 * recent such message wins and the previous set is dropped. Implements the network provider's GroupMatcher and the
 * params group's rewriteParams for x3's privacy provider. DOM-free (WebWorker scope).
 */
import { FiltersEngine, Request } from '@ghostery/adblocker';
import type { BlockerGroup } from '../../shared/engine-protocol';
import type { GroupMatch, GroupMatcher } from '../filters/network';

export class SwEngines implements GroupMatcher {
  #setId: string | null = null;
  #engines = new Map<BlockerGroup, FiltersEngine>();
  readonly #env: Map<string, boolean>;

  constructor(env: Map<string, boolean>) {
    this.#env = env;
  }

  get setId(): string | null {
    return this.#setId;
  }

  /** Puts a set in force; throws (the caller keeps the previous set) when a group does not deserialize. */
  load(setId: string, groups: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>): void {
    const next = new Map<BlockerGroup, FiltersEngine>();
    for (const g of groups) {
      const e = FiltersEngine.deserialize(new Uint8Array(g.bytes));
      e.updateEnv(this.#env);
      next.set(g.group, e);
    }
    this.#engines = next;
    this.#setId = setId;
  }

  ready(): boolean {
    return this.#engines.size > 0;
  }

  match(group: BlockerGroup, url: string, sourceUrl: string, type: string): GroupMatch | null {
    const e = this.#engines.get(group);
    if (!e) return null;
    const r = e.match(Request.fromRawDetails({ url, sourceUrl, type: type as never }));
    return { match: r.match, redirect: r.redirect ? { contentType: r.redirect.contentType, body: r.redirect.body } : undefined };
  }

  rewriteParams(url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame'): string | null {
    const e = this.#engines.get('params');
    if (!e) return null;
    const r = e.match(Request.fromRawDetails({ url, sourceUrl: type === 'main_frame' ? url : (documentUrl ?? url), type }));
    const to = r.rewrite?.url;
    return typeof to === 'string' && to !== url ? to : null;
  }
}
