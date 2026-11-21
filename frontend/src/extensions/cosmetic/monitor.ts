/**
 * GNOME's own generic-rule monitor (WAVE-B3 §5.1, rule R1). Generic hiding rules (`##.ad-banner` without a domain)
 * are too many to inject whole, so, as ad blockers do, the classes, ids and hrefs that appear in a document are
 * collected and only the generic rules for those are fetched (`FilterEngines.cosmeticsForFeatures`) and added to a
 * second page-realm stylesheet.
 *
 * Not `@ghostery/adblocker-content`'s DOMMonitor: it reads page objects with ordinary property access, spreads page
 * NodeLists, iterates `classList` and runs an engine-host MutationObserver (R1 rules 2 and 3). Here:
 *  - the observer is the PAGE realm's (`kit.observe`, added nodes plus `class`/`id`/`href` changes), so the nodes in its
 *    records get page-realm wrappers (rule 3);
 *  - its records array is read with `Object.getOwnPropertyDescriptor` (own data elements only: a hole never reaches a
 *    page getter on Array.prototype), every record, node list and element only with engine-host natives
 *    (`cosmetic/natives.ts`), attribute values as the primitives those natives return (rule 2);
 *  - `class` is split on ASCII whitespace; at most 4,096 distinct features per document, each at most 256 characters;
 *  - at most one engines call per 100 ms (batched); at most 512 KiB of CSS per document;
 *  - it stops at the document's trusted `pagehide` (the caller wires that).
 * `html` and `body` contribute no features (their classes would only select rules that hide the whole page, which
 * selectors.ts removes anyway).
 */
import type { InjectedSheet } from './inject';
import type { CosmeticNatives } from './natives';
import type { PageKit } from '../../engine-host/realm';

export interface Features {
  classes: string[];
  ids: string[];
  hrefs: string[];
}

export const MONITOR_LIMITS = { features: 4096, featureLength: 256, batchMs: 100, cssChars: 512 * 1024 } as const;

export interface MonitorDeps {
  readonly CN: CosmeticNatives;
  readonly kit: Pick<PageKit, 'observe'>;
  /** The generic CSS for features new to this document ('' when none). */
  rulesFor(features: Readonly<Features>): string;
  /** Creates the document's second stylesheet with `css` (inject.ts). */
  inject(css: string): InjectedSheet | null;
  /** Engine-host timer (natives.ts setTimeout). */
  schedule(fn: () => void, ms: number): void;
  now(): number;
  /** CSS already in the document (the document-start styles): counts against the 512 KiB. */
  readonly initialChars: number;
  log(level: 'warn' | 'error', message: string): void;
}

export interface Monitor {
  stop(): void;
}

const FEATURE_SELECTOR = '[id],[class],[href]';
const WS_RE = /[\t\n\f\r ]+/;

/** Own data element `i` of a page-realm array (never a getter, never the prototype). */
function own(N: { getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor }, arr: unknown, key: number | 'length'): unknown {
  if (typeof arr !== 'object' || arr === null) return undefined;
  const d = N.getOwnPropertyDescriptor(arr, key);
  return d && 'value' in d ? d.value : undefined;
}

export function startMonitor(doc: Document, deps: MonitorDeps): Monitor {
  const { CN } = deps;
  const seen = new Set<string>();
  let pending: Features = { classes: [], ids: [], hrefs: [] };
  let pendingCount = 0;
  let stopped = false;
  let saturated = false;
  let timer = false;
  let lastFlush = -Infinity;
  let css = '';
  let chars = deps.initialChars;
  let sheet: InjectedSheet | null = null;
  let cssFull = false;

  const add = (kind: 'c' | 'i' | 'h', value: string): void => {
    if (saturated || value.length === 0 || value.length > MONITOR_LIMITS.featureLength) return;
    const key = kind + value;
    if (seen.has(key)) return;
    if (seen.size >= MONITOR_LIMITS.features) {
      saturated = true;
      return;
    }
    seen.add(key);
    (kind === 'c' ? pending.classes : kind === 'i' ? pending.ids : pending.hrefs).push(value);
    pendingCount++;
  };

  const element = (el: unknown): void => {
    if (saturated) return;
    const name = CN.localName.call(el);
    if (name === 'html' || name === 'body') return;
    const id = CN.getAttribute.call(el, 'id');
    if (typeof id === 'string') add('i', id);
    const cls = CN.getAttribute.call(el, 'class');
    if (typeof cls === 'string') for (const c of cls.split(WS_RE)) add('c', c);
    const href = CN.getAttribute.call(el, 'href');
    if (typeof href === 'string') add('h', href);
  };

  const list = (nodes: NodeList): void => {
    const n = CN.nodeListLength.call(nodes);
    for (let i = 0; i < n && !saturated; i++) element(CN.nodeListItem.call(nodes, i));
  };

  const subtree = (node: unknown): void => {
    if (CN.nodeType.call(node) !== 1) return;
    element(node);
    list(CN.elQuerySelectorAll.call(node, FEATURE_SELECTOR));
  };

  const flush = (): void => {
    timer = false;
    lastFlush = deps.now();
    if (stopped || cssFull || pendingCount === 0) return;
    const batch = pending;
    pending = { classes: [], ids: [], hrefs: [] };
    pendingCount = 0;
    let more = '';
    try {
      more = deps.rulesFor(batch);
    } catch {
      deps.log('warn', 'cosmetic filtering: generic rules could not be read');
      return;
    }
    if (typeof more !== 'string' || more.length === 0) return;
    if (chars + more.length + 1 > MONITOR_LIMITS.cssChars) {
      cssFull = true;
      deps.log('warn', 'cosmetic filtering: the 512 KiB per-document limit for generic rules was reached');
      return;
    }
    chars += more.length + 1;
    css = css ? `${css}\n${more}` : more;
    try {
      if (sheet === null) sheet = deps.inject(css);
      else sheet.set(css);
    } catch {
      deps.log('warn', 'cosmetic filtering: generic rules could not be applied');
    }
  };

  const wake = (): void => {
    if (pendingCount === 0 || timer || stopped) return;
    timer = true;
    deps.schedule(flush, Math.max(0, MONITOR_LIMITS.batchMs - (deps.now() - lastFlush)));
  };

  const onRecords = (records: ArrayLike<unknown>): void => {
    if (stopped || saturated) return;
    try {
      const n = own(Object, records, 'length');
      if (typeof n !== 'number') return;
      for (let i = 0; i < n && !saturated; i++) {
        const r = own(Object, records, i);
        if (r === undefined) continue;
        const type = CN.recordType.call(r);
        if (type === 'childList') {
          const added = CN.recordAddedNodes.call(r);
          const m = CN.nodeListLength.call(added);
          for (let j = 0; j < m && !saturated; j++) subtree(CN.nodeListItem.call(added, j));
        } else if (type === 'attributes') {
          const target = CN.recordTarget.call(r);
          const attr = CN.recordAttributeName.call(r);
          if (CN.nodeType.call(target) !== 1 || (attr !== 'class' && attr !== 'id' && attr !== 'href')) continue;
          const name = CN.localName.call(target);
          if (name === 'html' || name === 'body') continue;
          const v = CN.getAttribute.call(target, attr);
          if (typeof v !== 'string') continue;
          if (attr === 'class') for (const c of v.split(WS_RE)) add('c', c);
          else add(attr === 'id' ? 'i' : 'h', v);
        }
      }
    } catch {
      /* a record of a document that went away: nothing to collect */
    }
    wake();
  };

  // What the document already has (a document reached late, or nodes the parser made before this point).
  try {
    list(CN.docQuerySelectorAll.call(doc, FEATURE_SELECTOR));
  } catch {
    /* nothing to scan */
  }
  if (!deps.kit.observe(doc, onRecords, ['class', 'id', 'href'])) {
    deps.log('warn', 'cosmetic filtering: this document has no observer; generic rules apply to its first elements only');
  }
  wake();
  return {
    stop() {
      stopped = true;
    },
  };
}
