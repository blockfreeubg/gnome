// The cosmetic provider (WAVE-B3 §5.1, §5.4) against a fake FilterEngines, a fake kit and a fake page whose window,
// document, elements, node lists and mutation records are recording Proxies: the provider may reach them only through
// the natives and the kit (rule R1 rule 2), so any trap of theirs that fires is a failure. The records array is a real
// array of another realm (a vm context) with a recording getter on that realm's Array.prototype, so a read of a hole
// through the prototype would show too. Covered: nothing when not ready and the late-styles path; allowlisted and
// kit-less documents; scriptlets only through kit.run inside withPageAssignments, before the styles; the <style>
// fallback; the monitor's features, batching, caps and its stop at a trusted pagehide.
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentInfo } from '../../shared/engine-hooks';
import type { Natives } from '../../engine-host/natives';
import { MONITOR_LIMITS } from './monitor';
import type { CosmeticNatives } from './natives';
import { LATE_DOCUMENTS, createCosmeticProviderWith } from './provider';
import type { PageKit } from '../../engine-host/realm';
import type { RequestContext } from '../core/compose';
import type { SitePolicy } from '../core/policy';
import type { FilterEngines } from '../filters/engines';

type CosmeticKit = Pick<PageKit, 'run' | 'sheet' | 'setSheet' | 'adopt' | 'observe'>;

// ── a recording fake page ───────────────────────────────────────────────────────────────────────────────────────

let violations: string[] = [];

/** An object every trap of which is recorded (and then performed on an empty target). */
function pageObject(label: string): object {
  const handler = new Proxy(
    {},
    {
      get:
        (_t, trap: string | symbol) =>
        (...args: unknown[]) => {
          violations.push(`${label}: ${String(trap)}${trap === 'get' || trap === 'has' || trap === 'getOwnPropertyDescriptor' ? ` ${String(args[1])}` : ''}`);
          return (Reflect as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[trap]?.(...args);
        },
    },
  );
  return new Proxy({}, handler);
}

interface NodeState {
  type: 1 | 3 | 9;
  localName: string;
  attrs: Map<string, string>;
  children: object[];
  head?: object | null;
  root?: object | null;
  text?: string;
}
interface ListState {
  items: object[];
}
interface RecordState {
  type: 'childList' | 'attributes';
  target: object;
  added: object;
  attributeName: string | null;
}
const nodes = new WeakMap<object, NodeState>();
const lists = new WeakMap<object, ListState>();
const recs = new WeakMap<object, RecordState>();

function el(localName: string, attrs: Record<string, string> = {}, children: object[] = []): object {
  const p = pageObject(`<${localName}>`);
  nodes.set(p, { type: 1, localName, attrs: new Map(Object.entries(attrs)), children });
  return p;
}
function nodeList(items: object[]): object {
  const p = pageObject('NodeList');
  lists.set(p, { items });
  return p;
}
function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new TypeError(`Illegal invocation (${what})`); // a brand check
  return v;
}
function descendants(n: object, out: object[] = []): object[] {
  for (const c of must(nodes.get(n), 'node').children) {
    const s = must(nodes.get(c), 'node');
    if (s.type === 1 && (s.attrs.has('id') || s.attrs.has('class') || s.attrs.has('href'))) out.push(c);
    descendants(c, out);
  }
  return out;
}

const created: object[] = [];
const CN: CosmeticNatives = {
  recordType: function (this: unknown) {
    return must(recs.get(this as object), 'record').type;
  },
  recordTarget: function (this: unknown) {
    return must(recs.get(this as object), 'record').target as Node;
  },
  recordAddedNodes: function (this: unknown) {
    return must(recs.get(this as object), 'record').added as NodeList;
  },
  recordAttributeName: function (this: unknown) {
    return must(recs.get(this as object), 'record').attributeName;
  },
  nodeListLength: function (this: unknown) {
    return must(lists.get(this as object), 'list').items.length;
  },
  nodeListItem: function (this: unknown, i: number) {
    return (must(lists.get(this as object), 'list').items[i] ?? null) as Node | null;
  },
  nodeType: function (this: unknown) {
    return must(nodes.get(this as object), 'node').type;
  },
  localName: function (this: unknown) {
    return must(nodes.get(this as object), 'node').localName;
  },
  elQuerySelectorAll: function (this: unknown, sel: string) {
    expect(sel).toBe('[id],[class],[href]');
    return nodeList(descendants(this as object)) as NodeList;
  },
  docQuerySelectorAll: function (this: unknown, sel: string) {
    expect(sel).toBe('[id],[class],[href]');
    return nodeList(descendants(this as object)) as NodeList;
  },
  getAttribute: function (this: unknown, name: string) {
    return must(nodes.get(this as object), 'node').attrs.get(name) ?? null;
  },
  docHead: function (this: unknown) {
    return (must(nodes.get(this as object), 'doc').head ?? null) as Element | null;
  },
  docElement: function (this: unknown) {
    return (must(nodes.get(this as object), 'doc').root ?? null) as Element | null;
  },
  createElement: function (this: unknown, tag: string) {
    must(nodes.get(this as object), 'doc');
    const e = el(tag);
    created.push(e);
    return e as Element;
  },
  appendChild: function (this: unknown, n: Node) {
    must(nodes.get(this as object), 'node').children.push(n);
    return n;
  },
  textContentSet: function (this: unknown, text: string) {
    must(nodes.get(this as object), 'node').text = text;
  },
};

interface Page {
  win: Window;
  doc: object;
  head: object;
  body: object;
  listeners: Array<{ type: string; fn: (ev: unknown) => void }>;
}
const winDocs = new WeakMap<object, object>();
const winListeners = new WeakMap<object, Page['listeners']>();

function makePage(body: object[] = [], opts: { head?: boolean; root?: boolean } = {}): Page {
  const win = pageObject('window') as Window;
  const doc = pageObject('document');
  const head = el('head');
  const bodyEl = el('body', { class: 'page-body' }, body);
  const html = el('html', { class: 'root-class' }, [head, bodyEl]);
  nodes.set(doc, { type: 9, localName: '#document', attrs: new Map(), children: [html], head: opts.head === false ? null : head, root: opts.root === false ? null : html });
  winDocs.set(win, doc);
  const listeners: Page['listeners'] = [];
  winListeners.set(win, listeners);
  return { win, doc, head, body: bodyEl, listeners };
}

const timers: Array<{ at: number; fn: () => void }> = [];
let clock = 0;
function advance(ms: number): void {
  clock += ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > clock) return;
    timers.shift();
    t.fn();
  }
}

const N = {
  winDocument: function (this: unknown) {
    return must(winDocs.get(this as object), 'window');
  },
  on: function (this: unknown, type: string, fn: (ev: unknown) => void) {
    must(winListeners.get(this as object), 'window').push({ type, fn });
  },
  setTimeout: () => {
    throw new Error('the runtime timer is used');
  },
} as unknown as Natives;

// ── fake kit and engines ────────────────────────────────────────────────────────────────────────────────────────

/** A real array of another realm whose prototype records reads of holes. */
const realm = vm.createContext({ violations });
function pageArray(items: object[], hole = false): ArrayLike<unknown> {
  realm.violations = violations;
  const arr = vm.runInContext(`(() => { Object.defineProperty(Array.prototype, '7', { configurable: true, get() { violations.push('Array.prototype[7]'); return undefined; } }); return []; })()`, realm) as unknown[];
  items.forEach((x, i) => (arr[i] = x));
  if (hole) arr.length = 8; // index 7 is a hole: a read through the prototype would hit the getter
  return arr;
}

interface FakeKit extends CosmeticKit {
  calls: string[];
  sheets: Array<{ css: string; adopted: object | null }>;
  observers: Array<{ root: object; cb: (records: ArrayLike<unknown>) => void; filter?: readonly string[] }>;
  inAssignments: boolean;
}

function fakeKit(opts: { sheets?: boolean; runOk?: boolean } = {}): FakeKit {
  const kit: FakeKit = {
    calls: [],
    sheets: [],
    observers: [],
    inAssignments: false,
    run(source) {
      kit.calls.push(`run:${source}`);
      expect(kit.inAssignments).toBe(true);
      return opts.runOk ?? true;
    },
    sheet(css) {
      kit.calls.push('sheet');
      if (opts.sheets === false) return null;
      const s = { css, adopted: null };
      kit.sheets.push(s);
      return s;
    },
    setSheet(sheet, css) {
      kit.calls.push('setSheet');
      (sheet as { css: string }).css = css;
      return true;
    },
    adopt(doc, sheet) {
      kit.calls.push('adopt');
      (sheet as { adopted: object | null }).adopted = doc;
      return true;
    },
    observe(root, cb, filter) {
      kit.calls.push('observe');
      kit.observers.push({ root, cb, filter });
      return true;
    },
  };
  return kit;
}

interface FakeEngines extends FilterEngines {
  isReady: boolean;
  fire(): void;
  featureCalls: Array<{ classes: readonly string[]; ids: readonly string[]; hrefs: readonly string[] }>;
  cosmeticsCalls: string[];
  scripts: string[];
  styles: string;
  generic: (f: { classes: readonly string[]; ids: readonly string[]; hrefs: readonly string[] }) => string;
}

function fakeEngines(): FakeEngines {
  const listeners: Array<() => void> = [];
  const e: FakeEngines = {
    isReady: true,
    featureCalls: [],
    cosmeticsCalls: [],
    scripts: ['/*s1*/', '/*s2*/'],
    styles: '.ad{display:none !important}',
    generic: (f) => f.classes.map((c) => `.${c}{display:none !important}`).join('\n'),
    ready: () => e.isReady,
    cosmetics(url) {
      e.cosmeticsCalls.push(url);
      return { styles: e.styles, scripts: e.scripts };
    },
    cosmeticsForFeatures(_url, _policy, features) {
      e.featureCalls.push({ classes: [...features.classes], ids: [...features.ids], hrefs: [...features.hrefs] });
      return e.generic(features);
    },
    rewriteParams: () => null,
    onChange(l) {
      listeners.push(l);
      return () => {};
    },
    fire() {
      for (const l of listeners) l();
    },
  };
  return e;
}

const POLICY: SitePolicy = {
  allowlisted: false,
  groups: { ads: true, security: true, trackers: true, params: true, cookies: false, annoyances: false },
  hide: true,
  genericHide: false,
  gpc: true,
  dnt: false,
  referrer: 'origin-cross-site',
  stripParams: true,
  cookieMode: 'block-third-party',
};
const ctx = (p: Partial<SitePolicy> = {}): RequestContext => ({ settings: {} as RequestContext['settings'], policy: { ...POLICY, ...p }, thirdParty: false });
const info = (url = 'https://site-a.localhost/'): DocumentInfo => ({ engine: 'scramjet', tabId: 1, url, topLevelUrl: url, isTopLevel: true });

function setup(kitOpts: Parameters<typeof fakeKit>[0] = {}) {
  const engines = fakeEngines();
  const kit = fakeKit(kitOpts);
  const logs: string[] = [];
  let kitFor: (win: Window) => CosmeticKit | null = () => kit;
  const provider = createCosmeticProviderWith(
    {
      N,
      engines,
      kitOf: (w) => kitFor(w) as PageKit | null,
      withPageAssignments: (_w, run) => {
        kit.inAssignments = true;
        try {
          run();
        } finally {
          kit.inAssignments = false;
        }
      },
      log: (level, m) => logs.push(`${level}:${m}`),
    },
    { CN, schedule: (fn, ms) => timers.push({ at: clock + ms, fn }), now: () => clock },
  );
  return { engines, kit, logs, provider, setKitFor: (f: typeof kitFor) => (kitFor = f) };
}

function record(type: 'childList' | 'attributes', target: object, added: object[] = [], attributeName: string | null = null): object {
  const r = pageObject('MutationRecord');
  recs.set(r, { type, target, added: nodeList(added), attributeName });
  return r;
}

beforeEach(() => {
  violations = [];
  timers.length = 0;
  clock = 1000;
  created.length = 0;
});

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('cosmetic provider: document start', () => {
  it('runs the scriptlets through kit.run inside withPageAssignments, then adopts one page-realm sheet', () => {
    const { kit, provider, engines } = setup();
    const p = makePage();
    provider.onDocument?.(p.win, info(), ctx());
    expect(engines.cosmeticsCalls).toEqual(['https://site-a.localhost/']);
    expect(kit.calls).toEqual(['run:/*s1*/', 'run:/*s2*/', 'sheet', 'adopt']);
    expect(kit.sheets.length).toBe(1);
    expect(kit.sheets[0]?.css).toBe('.ad{display:none !important}');
    expect(kit.sheets[0]?.adopted === p.doc).toBe(true);
    expect(violations).toEqual([]);
  });

  it('uses the document URL (a frame gets its own site rules) and handles a document once', () => {
    const { provider, engines } = setup();
    const p = makePage();
    provider.onDocument?.(p.win, { ...info('https://site-b.localhost/frame'), isTopLevel: false, topLevelUrl: 'https://site-a.localhost/' }, ctx());
    provider.onDocument?.(p.win, info('https://site-b.localhost/frame'), ctx());
    expect(engines.cosmeticsCalls).toEqual(['https://site-b.localhost/frame']);
  });

  it('does nothing on an allowlisted site, nor without a kit', () => {
    const a = setup();
    a.provider.onDocument?.(makePage().win, info(), ctx({ allowlisted: true }));
    expect(a.kit.calls).toEqual([]);
    expect(a.engines.cosmeticsCalls).toEqual([]);
    const b = setup();
    b.setKitFor(() => null);
    b.provider.onDocument?.(makePage().win, info(), ctx());
    expect(b.engines.cosmeticsCalls).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('logs scriptlets that did not run as a count, with no page data', () => {
    const { provider, logs } = setup({ runOk: false });
    provider.onDocument?.(makePage().win, info(), ctx());
    expect(logs).toEqual(['warn:cosmetic filtering: 2 of 2 scriptlets did not run in a document']);
  });

  it('falls back to a <style> made by the page document, in its head, else its root element, else nothing', () => {
    for (const shape of [{}, { head: false }, { head: false, root: false }] as const) {
      created.length = 0;
      const { provider, kit, logs } = setup({ sheets: false });
      const p = makePage([], shape);
      provider.onDocument?.(p.win, info(), ctx());
      expect(kit.calls).toEqual(['run:/*s1*/', 'run:/*s2*/', 'sheet']);
      if ('root' in shape) {
        expect(created.length).toBe(0);
        expect(logs).toEqual(['warn:cosmetic filtering: a document took no stylesheet']);
      } else {
        expect(created.length).toBe(1);
        const style = created[0] as object;
        expect(nodes.get(style)?.localName).toBe('style');
        expect(nodes.get(style)?.text).toBe('.ad{display:none !important}');
        const parent = 'head' in shape ? nodes.get(p.doc)?.root : p.head;
        expect(nodes.get(parent as object)?.children.includes(style)).toBe(true);
      }
    }
    expect(violations).toEqual([]);
  });

  it('skips styles over 512 KiB (fail open), keeps scriptlets', () => {
    const { provider, kit, engines, logs } = setup();
    engines.styles = 'x'.repeat(MONITOR_LIMITS.cssChars + 1);
    provider.onDocument?.(makePage().win, info(), ctx());
    expect(kit.calls).toEqual(['run:/*s1*/', 'run:/*s2*/']);
    expect(logs).toEqual(["warn:cosmetic filtering: a document's styles exceed 512 KiB and were not applied"]);
  });
});

describe('cosmetic provider: engines not ready', () => {
  it('does nothing until ready, then gives the document its styles and monitor, not its scriptlets', () => {
    const { provider, kit, engines } = setup();
    engines.isReady = false;
    const p = makePage([el('div', { class: 'late-ad' })]);
    provider.onDocument?.(p.win, info(), ctx({ genericHide: true }));
    expect(kit.calls).toEqual([]);
    expect(engines.cosmeticsCalls).toEqual([]);
    engines.fire(); // a change that is not "ready" yet
    expect(kit.calls).toEqual([]);
    engines.isReady = true;
    engines.fire();
    expect(kit.calls).toEqual(['sheet', 'adopt', 'observe']);
    advance(0);
    expect(engines.featureCalls).toEqual([{ classes: ['late-ad'], ids: [], hrefs: [] }]);
    engines.fire(); // nothing pending any more
    expect(engines.cosmeticsCalls.length).toBe(1);
    expect(violations).toEqual([]);
  });

  it('remembers at most 256 documents (the oldest is dropped)', () => {
    const { provider, engines } = setup();
    engines.isReady = false;
    const pages = Array.from({ length: LATE_DOCUMENTS + 1 }, (_, i) => {
      const p = makePage();
      provider.onDocument?.(p.win, info(`https://s${i}.localhost/`), ctx());
      return p;
    });
    expect(pages.length).toBe(257);
    engines.isReady = true;
    engines.fire();
    expect(engines.cosmeticsCalls.length).toBe(LATE_DOCUMENTS);
    expect(engines.cosmeticsCalls[0]).toBe('https://s1.localhost/');
  });
});

describe('cosmetic provider: the generic-rule monitor', () => {
  it('only with genericHide', () => {
    const { provider, kit } = setup();
    provider.onDocument?.(makePage().win, info(), ctx({ genericHide: false }));
    expect(kit.observers).toEqual([]);
  });

  it('collects the features already present, then those of added nodes and changed attributes, in batches ≤ 1 per 100 ms', () => {
    const { provider, kit, engines } = setup();
    const p = makePage([el('div', { id: 'hero', class: 'a  b\tc' }, [el('a', { href: 'https://ads.example/x' })])]);
    provider.onDocument?.(p.win, info(), ctx({ genericHide: true }));
    expect(kit.observers.length).toBe(1);
    expect(kit.observers[0]?.root === p.doc).toBe(true);
    expect(kit.observers[0]?.filter).toEqual(['class', 'id', 'href']);
    advance(0);
    // html and body contribute nothing
    expect(engines.featureCalls).toEqual([{ classes: ['a', 'b', 'c'], ids: ['hero'], hrefs: ['https://ads.example/x'] }]);
    expect(kit.sheets.map((s) => s.css)).toEqual(['.ad{display:none !important}', '.a{display:none !important}\n.b{display:none !important}\n.c{display:none !important}']);

    const cb = kit.observers[0]!.cb;
    const added = el('section', { class: 'b d' }, [el('span', { class: 'e' })]);
    const changed = el('p', { class: 'f' });
    cb(pageArray([record('childList', p.body, [added]), record('attributes', changed, [], 'class'), record('attributes', p.body, [], 'class')], true));
    advance(50);
    expect(engines.featureCalls.length).toBe(1); // within 100 ms of the first batch
    advance(50);
    expect(engines.featureCalls[1]).toEqual({ classes: ['d', 'e', 'f'], ids: [], hrefs: [] });
    expect(kit.calls.filter((c) => c === 'setSheet').length).toBe(1);
    expect(kit.sheets[1]?.css).toContain('.f{display:none !important}');
    expect(violations).toEqual([]);
  });

  it('ignores features over 256 characters and stops collecting at 4,096 distinct ones', () => {
    const { provider, kit, engines } = setup();
    provider.onDocument?.(makePage().win, info(), ctx({ genericHide: true }));
    advance(0);
    const cb = kit.observers[0]!.cb;
    const long = 'x'.repeat(MONITOR_LIMITS.featureLength + 1);
    const many = Array.from({ length: MONITOR_LIMITS.features + 10 }, (_, i) => `c${i}`).join(' ');
    cb(pageArray([record('attributes', el('div', { class: `${long} ok` }), [], 'class')]));
    advance(100);
    expect(engines.featureCalls.at(-1)).toEqual({ classes: ['ok'], ids: [], hrefs: [] });
    cb(pageArray([record('attributes', el('div', { class: many }), [], 'class')]));
    advance(100);
    expect(engines.featureCalls.at(-1)?.classes.length).toBe(MONITOR_LIMITS.features - 1);
    cb(pageArray([record('attributes', el('div', { class: 'more' }), [], 'class')]));
    advance(100);
    expect(engines.featureCalls.length).toBe(2);
  });

  it('stops adding CSS at 512 KiB per document', () => {
    const { provider, kit, engines, logs } = setup();
    engines.generic = () => 'y'.repeat(200 * 1024);
    provider.onDocument?.(makePage().win, info(), ctx({ genericHide: true }));
    const cb = kit.observers[0]!.cb;
    for (let i = 0; i < 4; i++) {
      cb(pageArray([record('attributes', el('div', { class: `k${i}` }), [], 'class')]));
      advance(100);
    }
    expect(kit.sheets[1]?.css.length).toBe(2 * 200 * 1024 + 1);
    expect(engines.featureCalls.length).toBe(3);
    expect(logs).toContain('warn:cosmetic filtering: the 512 KiB per-document limit for generic rules was reached');
  });

  it('stops at a trusted pagehide, not at a synthetic one', () => {
    const { provider, kit, engines } = setup();
    const p = makePage();
    provider.onDocument?.(p.win, info(), ctx({ genericHide: true }));
    const cb = kit.observers[0]!.cb;
    const pagehide = p.listeners.find((l) => l.type === 'pagehide');
    expect(pagehide).toBeDefined();
    pagehide!.fn({ isTrusted: false });
    cb(pageArray([record('attributes', el('div', { class: 'one' }), [], 'class')]));
    advance(100);
    expect(engines.featureCalls.at(-1)?.classes).toEqual(['one']);
    pagehide!.fn({ isTrusted: true });
    cb(pageArray([record('attributes', el('div', { class: 'two' }), [], 'class')]));
    advance(100);
    expect(engines.featureCalls.flatMap((f) => f.classes)).not.toContain('two');
  });

  it('survives records it cannot read (a brand check throws) and an engines call that throws', () => {
    const { provider, kit, engines, logs } = setup();
    provider.onDocument?.(makePage().win, info(), ctx({ genericHide: true }));
    const cb = kit.observers[0]!.cb;
    cb(pageArray([pageObject('not-a-record')]));
    engines.generic = () => {
      throw new Error('x');
    };
    cb(pageArray([record('attributes', el('div', { class: 'z' }), [], 'class')]));
    advance(100);
    expect(logs).toContain('warn:cosmetic filtering: generic rules could not be read');
    // the fake record has no state: the natives threw, nothing of it was read as a page object
    expect(violations).toEqual([]);
  });
});
