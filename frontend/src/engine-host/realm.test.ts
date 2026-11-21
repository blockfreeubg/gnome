// Realm hygiene (realm.ts): two node `vm` contexts stand for the engine host (this file's realm) and a proxied page
// (the context). Everything the kit makes must belong to the page's realm, also what it throws and what a page-made
// Proxy receives, and the page must never see an engine-host array, error or function, even when it exhausts the
// stack around a call.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Natives } from './natives';
import { CALL_ORIGINAL, RETURN, THROW, arg, cachedKit, isNative, pageKit, wrapAccessor, wrapMethod } from './realm';

// A vm context has no document: one stand-in object per global (pageKit caches kits per document).
const docs = new WeakMap<object, object>();
function winDocument(this: object): object {
  let d = docs.get(this);
  if (!d) docs.set(this, (d = {}));
  return d;
}

const N = {
  winDocument,
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  defineProperty: Object.defineProperty,
  getPrototypeOf: Object.getPrototypeOf,
  fnToString: Function.prototype.toString,
  apply: Reflect.apply,
  Proxy,
} as unknown as Natives;

interface Page {
  ctx: vm.Context;
  win: Window;
  run<T = unknown>(code: string): T;
}

function page(): Page {
  const ctx = vm.createContext({});
  const run = <T,>(code: string): T => vm.runInContext(code, ctx) as T;
  return { ctx, win: run<Window>('globalThis'), run };
}

/** Whether a value belongs to the engine host's realm (this file's): its constructor's Function is ours. */
function hostRealm(v: unknown): boolean {
  if ((typeof v !== 'object' && typeof v !== 'function') || v === null) return false;
  let F = typeof v === 'function' ? (v as { constructor: unknown }).constructor : (v as { constructor: { constructor: unknown } }).constructor?.constructor;
  for (let i = 0; i < 4 && typeof F === 'function' && (F as { constructor: unknown }).constructor !== F; i++) F = (F as { constructor: unknown }).constructor;
  return F === Function;
}

describe('pageKit', () => {
  it('builds callables of the page realm', () => {
    const p = page();
    const kit = pageKit(p.win, N);
    expect(kit).not.toBeNull();
    const fn = kit!.fn((_s, _a, box) => {
      box[0] = RETURN;
      box[1] = 42;
    });
    p.ctx.fn = fn;
    expect(p.run('fn()')).toBe(42);
    // constructor, prototype chain and toString all belong to the page
    expect(p.run('fn.constructor === Function')).toBe(true);
    expect(p.run('Object.getPrototypeOf(fn) === Function.prototype')).toBe(true);
    expect(p.run('fn.constructor("return this")() === globalThis')).toBe(true);
    expect(p.run('Function.prototype.toString.call(fn)')).toMatch(/\[native code\]/);
    expect(hostRealm(fn)).toBe(false);
  });

  it('refuses a realm whose Function is not the browser’s own', () => {
    const p = page();
    p.run('globalThis.Function = function Function() {}');
    expect(pageKit(p.win, N)).toBeNull();
    const q = page();
    q.run('globalThis.Function = new Proxy(Function, {})');
    expect(pageKit(q.win, N)).toBeNull();
  });

  it('hands a page-made Proxy only page-realm arguments', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    p.run(`globalThis.seen = []; globalThis.trap = new Proxy(function () {}, { apply(t, th, args) { seen.push(args); return 'x'; } });`);
    p.run('globalThis.obj = { toString: trap }');
    // ToString of a page value runs in the page realm (kit.str), not with this realm's String
    expect(kit.str(p.run('obj'))).toBe('x');
    const wrapped = kit.wrap(p.run('trap'), null, null);
    p.ctx.wrapped = wrapped;
    p.run('wrapped(1, 2)');
    const seen = p.run<unknown[][]>('seen');
    expect(seen.length).toBe(2);
    for (const args of seen) {
      expect(hostRealm(args)).toBe(false);
      expect(p.run<boolean>('seen.every((a) => a.constructor === Array)')).toBe(true);
    }
  });

  it('reads only the arguments the page passed (a missing index would run a getter the page planted)', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    p.run(`globalThis.seen = []; Object.defineProperty(Array.prototype, '3', { configurable: true, get: new Proxy(function () {}, { apply(t, th, args) { seen.push(args); return 'x'; } }) });`);
    let got: unknown = 'unset';
    p.ctx.f = kit.fn((_s, args, box) => {
      got = arg(args, 3);
      box[0] = RETURN;
      box[1] = 1;
    });
    expect(p.run('f(1)')).toBe(1);
    expect(got).toBeUndefined();
    expect(p.run('seen.length')).toBe(0);
  });

  it('wraps natives: steps run, results and native errors pass through unchanged', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    const proto = p.run<object>('Array.prototype');
    const steps: string[] = [];
    expect(wrapMethod(N, kit, proto, 'push', (_self, args) => steps.push(`before ${String(arg(args, 0))}`), (_s, _a, r) => steps.push(`after ${String(r)}`))).toBe(true);
    expect(p.run('const a = []; a.push(7)')).toBe(1);
    expect(steps).toEqual(['before 7', 'after 1']);
    expect(p.run('Array.prototype.push.constructor === Function && Array.prototype.push.name')).toBe('push');
    // a native error keeps its page-realm class
    expect(p.run('try { Array.prototype.push.call(Object.freeze([]), 1); "none" } catch (e) { e.constructor === TypeError }')).toBe(true);
  });

  it('wraps accessors with page-realm getters and setters', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    p.run(`globalThis.P = { _v: 1, get v() { return this._v; }, set v(x) { this._v = x; } };`);
    let reads = 0;
    expect(wrapAccessor(N, kit, p.run('P'), 'v', { get: { before: () => reads++ }, set: { after: () => reads++ } })).toBe(true);
    expect(p.run('P.v = 5; P.v')).toBe(5);
    expect(reads).toBe(2);
    expect(p.run('const d = Object.getOwnPropertyDescriptor(P, "v"); d.get.constructor === Function && d.set.constructor === Function')).toBe(true);
  });

  it('replacements: return, throw a page value, or call the original', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    const original = p.run<(...a: unknown[]) => unknown>('(function original(x) { return "orig " + x; })');
    let mode = RETURN;
    p.ctx.r = kit.replace(original, (_self, args, box) => {
      box[0] = mode;
      box[1] = mode === THROW ? p.run('new TypeError("page")') : `mine ${String(arg(args, 0))}`;
    });
    expect(p.run('r(1)')).toBe('mine 1');
    mode = CALL_ORIGINAL;
    expect(p.run('r(2)')).toBe('orig 2');
    mode = THROW;
    expect(p.run('try { r(3) } catch (e) { e instanceof TypeError && e.message }')).toBe('page');
  });

  it('turns a failing GNOME step into a page-realm RangeError', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    p.ctx.bad = kit.fn(() => {
      throw new Error('engine-host error');
    });
    expect(p.run('try { bad(); "none" } catch (e) { (e instanceof RangeError) + " " + (e.constructor.constructor("return this")() === globalThis) }')).toBe('true true');
  });

  it('lets no engine-host error escape when the page exhausts the stack around a call', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    const native = p.run<(...a: unknown[]) => unknown>('Array.prototype.push');
    p.ctx.w = kit.wrap(native, () => {
      const x = [1, 2, 3].map((v) => v + 1); // some engine-host work
      void x;
    }, null);
    p.ctx.makeRec = (pad: number) =>
      p.run(`(function (w, box) { const go = (d) => { ${Array.from({ length: pad }, (_, i) => `let v${i} = d + ${i};`).join('')} try { w.call([], 1); } catch (e) { box.errs[box.n] = e; box.n = box.n + 1; } go(d + 1); }; return go; })`);
    const kinds = p.run<{ page: number; host: number }>(`(() => {
      const kinds = { page: 0, host: 0 };
      for (let pad = 0; pad < 40; pad++) {
        const box = { errs: [], n: 0 };
        try { makeRec(pad)(w, box)(0); } catch (e) {}
        for (let i = 0; i < box.n; i++) { const e = box.errs[i]; if (e && e.constructor && e.constructor.constructor("return this")() === globalThis) kinds.page++; else kinds.host++; }
      }
      return kinds;
    })()`);
    expect(kinds.host).toBe(0);
    expect(kinds.page).toBeGreaterThan(0); // the scan did hit the limit inside the wrapper
  });

  it('tells browser natives from page functions and Proxies, in both engines\' formats', () => {
    expect(isNative(N, Function, 'Function')).toBe(true);
    expect(isNative(N, function Function() {}, 'Function')).toBe(false);
    expect(isNative(N, new Proxy(Function, {}), 'Function')).toBe(false);
    expect(isNative(N, Function.bind(null), 'Function')).toBe(false);
    expect(isNative(N, Array, 'Function')).toBe(false);
    // SpiderMonkey prints natives over three lines
    const gecko = { ...N, fnToString: () => 'function Function() {\n    [native code]\n}' } as unknown as Natives;
    expect(isNative(gecko, () => 0, 'Function')).toBe(true);
    const geckoProxy = { ...N, fnToString: () => 'function () {\n    [native code]\n}' } as unknown as Natives;
    expect(isNative(geckoProxy, () => 0, 'Function')).toBe(false);
  });

  it('serializes nothing of the page into this realm but strings', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    // no FormData in a bare context: an empty entry list
    expect(kit.formEntries({}, null)).toEqual({ entries: [], files: 0 });
    const e = kit.error('blocked', 'SecurityError');
    expect(hostRealm(e)).toBe(false);
  });
});

// ── WAVE-B3 §3.3: x1's kit additions (run, sheet, setSheet, adopt, readString) and cachedKit ──

/** A page with stand-ins for the CSSOM pieces a vm context lacks, defined before the kit is built (document start). */
function cssPage(): Page {
  const p = page();
  p.run(`
    globalThis.CSSStyleSheet = class CSSStyleSheet { replaceSync(css) { if (css.includes('{{bad')) throw new SyntaxError('bad'); this.css = css; } };
    globalThis.Document = class Document {};
    const store = new WeakMap();
    Object.defineProperty(Document.prototype, 'adoptedStyleSheets', { configurable: true, get() { let a = store.get(this); if (!a) store.set(this, (a = [])); return a; } });
    globalThis.doc = new Document();
  `);
  return p;
}

/** Replaces the page's array and iteration members with Proxies that record every call (R1 rule 2 probes). */
const RECORDERS = `
  globalThis.hits = [];
  const rec = (name, f) => new Proxy(f, { apply(t, th, args) { hits.push(name); return Reflect.apply(t, th, args); } });
  Array.prototype.push = rec('push', Array.prototype.push);
  Array.prototype[Symbol.iterator] = rec('iterator', Array.prototype[Symbol.iterator]);
  globalThis.NodeList = class NodeList { item() { hits.push('item'); } get length() { hits.push('nlength'); return 0; } };
  NodeList.prototype[Symbol.iterator] = rec('nl-iterator', function* () {});
`;

describe('pageKit: step-3 additions (WAVE-B3 §3.3)', () => {
  it('cachedKit returns the kit built at document start and never builds one', () => {
    const p = page();
    expect(cachedKit(p.win, N)).toBeNull();
    const kit = pageKit(p.win, N);
    expect(kit).not.toBeNull();
    expect(cachedKit(p.win, N)).toBe(kit);
  });

  it('run compiles with the realm’s CURRENT Function (an engine wrapper sees the source) and runs it', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    // After the kit was built, the engine's client replaces Function with a recording wrapper.
    p.run(`globalThis.sources = []; const F = Function; globalThis.Function = new Proxy(F, { apply(t, th, args) { sources.push(args); return Reflect.apply(t, th, args); } });`);
    expect(kit.run('globalThis.ran = (globalThis.ran || 0) + 1')).toBe(true);
    expect(p.run('ran')).toBe(1);
    expect(p.run('sources.length')).toBe(1);
    expect(p.run('sources[0][0]')).toBe('globalThis.ran = (globalThis.ran || 0) + 1');
    expect(hostRealm(p.run('sources[0]'))).toBe(false);
  });

  it('run returns false on a throw or a syntax error, and the throw never reaches the engine host', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    expect(kit.run('throw new Error("page")')).toBe(false);
    expect(kit.run('this is not javascript (')).toBe(false);
    p.run('globalThis.Function = function () { throw new TypeError("no eval here"); }');
    expect(kit.run('1')).toBe(false);
  });

  it('readString reads with page-realm code: strings only, null for a throwing or non-string getter', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    p.run(`globalThis.seen = [];
      globalThis.o = { s: 'ref', n: 5, get t() { throw new Error('x'); } };
      Object.defineProperty(o, 'p', { get: new Proxy(function () {}, { apply(t, th, args) { seen.push(args); return 'via proxy'; } }) });`);
    const o = p.run<object>('o');
    expect(kit.readString(o, 's')).toBe('ref');
    expect(kit.readString(o, 'n')).toBeNull();
    expect(kit.readString(o, 't')).toBeNull();
    expect(kit.readString(o, 'missing')).toBeNull();
    expect(kit.readString(o, 'p')).toBe('via proxy');
    expect(hostRealm(p.run('seen[0]'))).toBe(false);
  });

  it('sheet, setSheet and adopt build and attach page-realm sheets without running page members', () => {
    const p = cssPage();
    const kit = pageKit(p.win, N)!;
    p.run(RECORDERS);
    const sheet = kit.sheet('.ad { display: none !important; }');
    expect(sheet).not.toBeNull();
    expect(hostRealm(sheet)).toBe(false);
    p.ctx.sheet = sheet;
    expect(p.run('sheet instanceof CSSStyleSheet && sheet.css')).toBe('.ad { display: none !important; }');
    expect(kit.setSheet(sheet!, '.x { display: none !important; }')).toBe(true);
    expect(kit.setSheet(sheet!, '{{bad')).toBe(false);
    expect(kit.sheet('{{bad')).toBeNull();
    expect(kit.adopt(p.run<Document>('doc'), sheet!)).toBe(true);
    // push was captured at document start: the recording replacements of push, the iterator and length never ran.
    expect(p.run('hits.length')).toBe(0);
    expect(p.run('Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets").get.call(doc)[0] === sheet')).toBe(true);
  });

  it('observe does not run the page’s array or iteration members either', () => {
    const p = page();
    p.run(`globalThis.MutationObserver = class MutationObserver { constructor(cb) { this.cb = cb; } observe(root, opts) { globalThis.observed = { root, childList: opts.childList, subtree: opts.subtree }; } };`);
    const kit = pageKit(p.win, N)!;
    p.run(RECORDERS);
    const root = p.run<Node>('({ node: true })');
    expect(kit.observe(root, () => {})).toBe(true);
    expect(p.run('hits.length')).toBe(0);
    expect(p.run('observed.childList && observed.subtree')).toBe(true);
  });

  it('observe gives the browser options without a prototype and a page-realm attributeFilter (read like a WebIDL dictionary)', () => {
    // Lane x2's review (row cs-late R1, measured in both browsers): the options object held the engine host's
    // attributeFilter array, and a page getter on Object.prototype for a member the options leave out (attributeOldValue,
    // characterData, characterDataOldValue) got it through `this.attributeFilter`.
    const p = page();
    // A stand-in for the browser: MutationObserverInit is read member by member in lexicographic order, inherited
    // members too (WebIDL dictionary conversion), and attributeFilter is iterated as a sequence.
    p.run(`globalThis.MutationObserver = class MutationObserver {
      constructor(cb) { this.cb = cb; }
      observe(root, opts) {
        const d = Object.create(null);
        for (const k of ['attributeFilter', 'attributeOldValue', 'attributes', 'characterData', 'characterDataOldValue', 'childList', 'subtree']) d[k] = opts[k];
        globalThis.observed = { __proto__: null, filter: d.attributeFilter === undefined ? null : [...d.attributeFilter], attributes: d.attributes === true, childList: d.childList === true, subtree: d.subtree === true };
        globalThis.filterValue = d.attributeFilter;
      }
    };`);
    const kit = pageKit(p.win, N)!;
    // page code, after the kit was built: getters for the members the options leave out
    p.run(`globalThis.seen = []; for (const k of ['attributeOldValue', 'characterData', 'characterDataOldValue']) Object.defineProperty(Object.prototype, k, { configurable: true, get() { seen.push(this.attributeFilter); return undefined; } });`);
    expect(kit.observe(p.run<Node>('({})'), () => {}, ['class', 'id', 'href'])).toBe(true);
    expect(p.run('JSON.stringify(observed)')).toBe('{"filter":["class","id","href"],"attributes":true,"childList":true,"subtree":true}');
    expect(hostRealm(p.run('filterValue'))).toBe(false);
    for (const v of p.run<unknown[]>('Array.from(seen)')) expect(hostRealm(v)).toBe(false);
    expect(p.run('seen.length')).toBe(0);
  });

  it('without the APIs: sheet null, setSheet and adopt false', () => {
    const p = page();
    const kit = pageKit(p.win, N)!;
    expect(kit.sheet('a{}')).toBeNull();
    expect(kit.setSheet({}, 'a{}')).toBe(false);
    expect(kit.adopt({} as Document, {})).toBe(false);
  });

  it('lets no engine-host error reach the page when it exhausts the stack around a call that uses each addition', () => {
    const p = cssPage();
    const kit = pageKit(p.win, N)!;
    const o = p.run<object>('({ s: "v" })');
    const doc = p.run<Document>('doc');
    const uses: Array<(sheet: object | null) => void> = [
      () => void kit.run('1'),
      () => void kit.readString(o, 's'),
      () => void kit.sheet('a{}'),
      (s) => void (s && kit.setSheet(s, 'b{}')),
      (s) => void (s && kit.adopt(doc, s)),
    ];
    const sheet = kit.sheet('a{}');
    for (const use of uses) {
      p.ctx.w = kit.fn((_s, _a, box) => {
        use(sheet);
        box[0] = RETURN;
        box[1] = 1;
      });
      p.ctx.makeRec = (pad: number) =>
        p.run(`(function (w, box) { const go = (d) => { ${Array.from({ length: pad }, (_, i) => `let v${i} = d + ${i};`).join('')} try { w(); } catch (e) { box.errs[box.n] = e; box.n = box.n + 1; } go(d + 1); }; return go; })`);
      const kinds = p.run<{ page: number; host: number }>(`(() => {
        const kinds = { page: 0, host: 0 };
        for (let pad = 0; pad < 30; pad++) {
          const box = { errs: [], n: 0 };
          try { makeRec(pad)(w, box)(0); } catch (e) {}
          for (let i = 0; i < box.n; i++) { const e = box.errs[i]; if (e && e.constructor && e.constructor.constructor("return this")() === globalThis) kinds.page++; else kinds.host++; }
        }
        return kinds;
      })()`);
      expect(kinds.host).toBe(0);
      expect(kinds.page).toBeGreaterThan(0);
    }
  });
});

