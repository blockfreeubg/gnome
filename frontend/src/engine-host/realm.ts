/**
 * Realm hygiene (WAVE-B3 §3.3 rule R1, §11.2 finding F1, and its converse). A proxied page is same-origin with the
 * engine host, so any engine-host object it can reach hands it the engine host's global: `fn.constructor('return
 * this')()` for a function, `err.constructor.constructor(…)` for an error, `args.constructor.constructor(…)` for an
 * array. Two directions must hold:
 *
 * 1. Nothing GNOME installs in a page realm is an engine-host function: every value, getter and setter is a
 *    callable of the PAGE realm: a Proxy made by the page realm's own Proxy constructor around a page-realm function
 *    (the original native, or a page-realm arrow function), with a handler and an `apply` trap compiled with that
 *    realm's own `Function` constructor (captured at document start, before page scripts or the engines' client
 *    hooks run), so nothing about it is the engine host's. The trap calls
 *    GNOME's step (an engine-host function the page cannot reach: it sits only in the trap's closure and in the
 *    Proxy handler) and turns anything the step throws into a page-realm RangeError. Even a page that exhausts the
 *    stack so that the engine-host step overflows at its first instruction (V8 then throws the RangeError in the
 *    engine-host realm) receives a page-realm error: the outermost frame the page calls is page code.
 * 2. Engine-host code never runs page code. V8 and SpiderMonkey create the arguments array of a Proxy trap in the
 *    CALLER's realm, so an engine-host read of a page getter, a `String(pageValue)` or a call of a page function hands
 *    a page-made Proxy an engine-host array (measured in V8 with two vm contexts: getter, toString, template
 *    literal, call, construct, Reflect.apply). GNOME's steps therefore read page objects only through the engine-host
 *    realm's native getters and methods (natives.ts; Web IDL brand checks run no page code), convert page values to
 *    strings with `PageKit.str` (the page realm's String, so a page-made toString runs from page frames), and call
 *    the original natives from the page-realm trap (the page realm's Reflect.apply).
 *
 * 3. Engine-host code hands the page no DOM object it reached first through an engine-host container. Blink keeps
 *    one JS wrapper per DOM object, made in the realm of the object it was first reached through: a node reached
 *    through a page object (a document, an event, a node list a page-realm native returned) gets a page-realm wrapper
 *    (measured: querySelector, NodeList items, tree walking, composedPath, event targets, trusted events), but the
 *    records of an engine-host MutationObserver and the arguments of an engine-host callback (a TreeWalker filter)
 *    hand parser-made nodes engine-host wrappers (measured: `document.body` was then an engine-host object). Hence
 *    `PageKit.observe` and no engine-host callbacks that receive page nodes.
 *
 * A realm whose `Function` is not the browser's own (the page replaced it before GNOME reached that realm) or that
 * forbids eval gets no kit: nothing is installed there except data properties holding primitives.
 */
import type { Natives } from './natives';

/** GNOME's step before or after a wrapped native runs (engine-host code; it must not throw on purpose). */
export type Step = (self: unknown, args: ArrayLike<unknown>) => void;
export type AfterStep = (self: unknown, args: ArrayLike<unknown>, result: unknown) => void;
/**
 * A replacement's decision, written into `box` (a page-realm array the trap made): `box[0]` 0 → return `box[1]`
 * (a primitive or a page-realm object), 1 → throw `box[1]` (a page value, e.g. what a page toString threw), 2 → call
 * the original function with the page's own `this` and arguments.
 */
export type Decide = (self: unknown, args: ArrayLike<unknown>, box: unknown[]) => void;

export const RETURN = 0;
export const THROW = 1;
export const CALL_ORIGINAL = 2;

type AnyFn = (...args: never[]) => unknown;

/** What the page-realm factory returns (page-realm functions; read once, own data properties). */
interface PageFactory {
  /** A page-realm arrow function: the Proxy target of GNOME's own callables (a function prototype, no constructor). */
  fp: AnyFn;
  str: (v: unknown) => string;
  formJson: (form: unknown, submitter: unknown) => string;
  error: (message: string, name: string) => unknown;
  highlight: (name: string, ranges: readonly unknown[]) => boolean;
  unhighlight: (name: string) => void;
  observe: (root: unknown, cb: (records: ArrayLike<unknown>) => void, attributeFilter: readonly string[] | null) => boolean;
  wrap: (original: AnyFn, before: Step | null, after: AfterStep | null) => AnyFn;
  replace: (original: AnyFn, decide: Decide) => AnyFn;
  run: (source: string) => unknown;
  sheet: (css: string) => unknown;
  setSheet: (sheet: unknown, css: string) => unknown;
  adopt: (doc: unknown, sheet: unknown) => unknown;
  readString: (obj: unknown, key: string) => unknown;
}

/**
 * The page-realm half, compiled with the page realm's own Function constructor. Every global it names (Reflect,
 * String, RangeError, Function) is looked up by page-realm code, so a page that tampered with them only breaks itself.
 */
const FACTORY_SOURCE = `"use strict";
const apply = Reflect.apply;
const P = Proxy;
const S = String;
const RE = RangeError;
const FD = typeof FormData === "function" ? FormData : null;
const J = JSON.stringify;
const DE = typeof DOMException === "function" ? DOMException : null;
const HR = (function () { try { return typeof CSS === "object" && CSS !== null && CSS.highlights ? CSS.highlights : null; } catch (e) { return null; } })();
const HRP = HR ? Object.getPrototypeOf(HR) : null;
const HRset = HRP ? HRP.set : null;
const HRdel = HRP ? HRP.delete : null;
const HL = typeof Highlight === "function" ? Highlight : null;
const HLadd = HL ? HL.prototype.add : null;
const MO = typeof MutationObserver === "function" ? MutationObserver : null;
const MOobserve = MO ? MO.prototype.observe : null;
const MSG = "Maximum call stack size exceeded";
const CSSS = typeof CSSStyleSheet === "function" ? CSSStyleSheet : null;
const CSSreplace = CSSS && typeof CSSS.prototype.replaceSync === "function" ? CSSS.prototype.replaceSync : null;
const ADdesc = typeof Document === "function" ? Object.getOwnPropertyDescriptor(Document.prototype, "adoptedStyleSheets") : undefined;
const ADget = ADdesc && typeof ADdesc.get === "function" ? ADdesc.get : null;
const push = Array.prototype.push;
const G = globalThis;
return {
  fp: () => undefined,
  str: function (v) { return S(v); },
  formJson: function (form, submitter) {
    if (FD === null) return "{}";
    const fd = submitter === null ? new FD(form) : new FD(form, submitter);
    const entries = [];
    let files = 0;
    for (const e of fd) {
      const v = e[1];
      if (typeof v === "string") entries[entries.length] = [S(e[0]), v];
      else { files++; entries[entries.length] = [S(e[0]), S(v && v.name)]; }
    }
    return S(J({ entries: entries, files: files }));
  },
  error: function (message, name) { return DE === null ? new Error(S(message)) : new DE(S(message), S(name)); },
  highlight: function (name, ranges) {
    if (!HR || !HL || !HRset || !HLadd) return false;
    const h = new HL();
    for (let i = 0; i < ranges.length; i++) apply(HLadd, h, [ranges[i]]);
    apply(HRset, HR, [S(name), h]);
    return true;
  },
  unhighlight: function (name) { if (HR && HRdel) apply(HRdel, HR, [S(name)]); },
  observe: function (root, cb, attributeFilter) {
    if (!MO || !MOobserve) return false;
    const mo = new MO(function (records) { try { cb(records); } catch (e) { /* never reported to the page */ } });
    // The browser reads MutationObserverInit member by member, inherited members too, with opts as \`this\`: no
    // prototype (a page getter on Object.prototype finds nothing to run for), and the attribute names copied into a
    // page-realm array of strings (the caller's array is the engine host's; lane x2's review, row cs-late R1).
    const opts = { __proto__: null, childList: true, subtree: true };
    if (attributeFilter !== null) {
      const names = [];
      for (let i = 0; i < attributeFilter.length; i++) names[i] = S(attributeFilter[i]);
      opts.attributes = true;
      opts.attributeFilter = names;
    }
    apply(MOobserve, mo, [root, opts]);
    return true;
  },
  wrap: function (original, before, after) {
    return new P(original, { apply: function (target, self, args) {
      if (before !== null) { try { before(self, args); } catch (e) { throw new RE(MSG); } }
      const r = apply(original, self, args);
      if (after !== null) { try { after(self, args, r); } catch (e) { throw new RE(MSG); } }
      return r;
    } });
  },
  replace: function (original, decide) {
    return new P(original, { apply: function (target, self, args) {
      const box = [0, undefined];
      try { decide(self, args, box); } catch (e) { throw new RE(MSG); }
      const k = box[0];
      if (k === 2) return apply(original, self, args);
      if (k === 1) throw box[1];
      return box[1];
    } });
  },
  run: function (source) {
    try { const f = G.Function(S(source)); apply(f, undefined, []); return true; } catch (e) { return false; }
  },
  sheet: function (css) {
    if (CSSS === null || CSSreplace === null) return null;
    try { const s = new CSSS(); apply(CSSreplace, s, [S(css)]); return s; } catch (e) { return null; }
  },
  setSheet: function (sheet, css) {
    if (CSSreplace === null) return false;
    try { apply(CSSreplace, sheet, [S(css)]); return true; } catch (e) { return false; }
  },
  adopt: function (doc, sheet) {
    if (ADget === null) return false;
    try { apply(push, apply(ADget, doc, []), [sheet]); return true; } catch (e) { return false; }
  },
  readString: function (obj, key) { try { const v = obj[S(key)]; return typeof v === "string" ? v : null; } catch (e) { return null; } },
};`;

/** Tools for installing GNOME's functions in one page realm (see the header). */
export interface PageKit {
  /** ToString in the page realm (throws what the page's conversion throws: a page value). */
  str(v: unknown): string;
  /**
   * A form's entry list as the page realm's FormData builds it (files by name), as engine-host data: the page realm
   * serializes it to a JSON string, so nothing of the page realm reaches engine-host code. Throws (a page value or a
   * page-realm error) when the page's form cannot be read.
   */
  formEntries(form: unknown, submitter: unknown): { entries: Array<[string, string]>; files: number };
  /** A page-realm DOMException to throw at the page (WAVE-B3 §3.3 pageError). */
  error(message: string, name?: string): unknown;
  /**
   * Find highlights (CSS Custom Highlight API) in the page realm's own registry, with a page-realm Highlight (a
   * Highlight of this realm in the page's registry would hand the page an engine-host object). False without the API.
   */
  highlight(name: string, ranges: readonly Range[]): boolean;
  unhighlight(name: string): void;
  /**
   * A MutationObserver of the PAGE realm on `root` (childList, subtree) whose page-realm callback hands the records
   * to `cb`. Blink wraps a node the first time script reaches it, in the realm of the object it was reached through:
   * records of an engine-host observer would hand parser-created nodes (measured: document.body) engine-host-realm
   * wrappers, which the page then gets. `cb` must read the records with this realm's natives only.
   */
  observe(root: Node, cb: (records: ArrayLike<unknown>) => void, attributeFilter?: readonly string[]): boolean;
  /** A page-realm callable that runs `original` (a page-realm native) between GNOME's steps. */
  wrap(original: AnyFn, before: Step | null, after: AfterStep | null): AnyFn;
  /** A page-realm callable that looks like `original` and does what `decide` says. */
  replace(original: AnyFn, decide: Decide): AnyFn;
  /** A page-realm callable (for accessors) that does what `decide` says; "call the original" returns undefined. */
  fn(decide: Decide): AnyFn;
  /**
   * Compiles `source` with the realm's CURRENT Function (after the engine's client hooked the window: Scramjet's or
   * UV's wrapper, which rewrites the code like page code) and runs it; false when either throws. Scriptlets only (D11),
   * at document start, before page scripts.
   */
  run(source: string): boolean;
  /** A constructed CSSStyleSheet of the page realm holding `css` (only such a sheet can join that realm's documents); null without the API. */
  sheet(css: string): object | null;
  setSheet(sheet: object, css: string): boolean;
  /** Appends `sheet` to `doc.adoptedStyleSheets` with the captured getter and Array.prototype.push (an observable array: no page code runs). */
  adopt(doc: Document, sheet: object): boolean;
  /** `obj[key]` read by page-realm code: the string, else null (also when the read throws). */
  readString(obj: object, key: string): string | null;
}

/**
 * Kits per document: a frame's WindowProxy stays the same object when the frame navigates to a new realm, its
 * document does not (a Window reused by its first same-origin document compiles a second kit of the same realm).
 */
const kits = new WeakMap<object, PageKit | null>();

/**
 * Whether `fn` is the browser's own native function named `name` (of some realm the page has): its source is
 * `function <name>() { [native code] }` (SpiderMonkey adds line breaks), which no page function, bound function or
 * Proxy (`function () { [native code] }`) has. Function.prototype.toString runs no page code.
 */
export function isNative(N: Natives, fn: unknown, name: string): boolean {
  if (typeof fn !== 'function') return false;
  try {
    return (N.fnToString.call(fn) as string).replace(/\s+/g, ' ') === `function ${name}() { [native code] }`;
  } catch {
    return false;
  }
}

/** The `prototype` of the realm's own constructor `name`, only when it is the browser's native (see isNative). */
export function nativePrototype(N: Natives, win: object, name: string): object | undefined {
  try {
    const d = N.getOwnPropertyDescriptor(win, name);
    const C = d && 'value' in d ? (d.value as unknown) : undefined;
    if (!isNative(N, C, name)) return undefined;
    const pd = N.getOwnPropertyDescriptor(C as object, 'prototype');
    return pd && 'value' in pd && typeof pd.value === 'object' && pd.value !== null ? (pd.value as object) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The kit of `win`'s realm, built on the first call. Call it at document start (Scramjet `init.pre`, the UV
 * document-start hook, a child frame the guard reaches at its creation), before page code runs in that realm.
 */
export function pageKit(win: Window, N: Natives): PageKit | null {
  return kitFor(win, N, true);
}

/**
 * The kit `pageKit` built for the document `win` shows now, without building one (WAVE-B3 §4.2 `kitOf`): null when
 * none was built at its document start (or the realm got none). Step-3 providers take their kit only from here, so
 * nothing is compiled in a realm after page code may have run there.
 */
export function cachedKit(win: Window, N: Natives): PageKit | null {
  return kitFor(win, N, false);
}

function kitFor(win: Window, N: Natives, build: boolean): PageKit | null {
  let key: object;
  try {
    key = N.winDocument.call(win);
  } catch {
    return null;
  }
  const cached = kits.get(key);
  if (cached !== undefined) return cached;
  if (!build) return null;
  let kit: PageKit | null = null;
  try {
    const d = N.getOwnPropertyDescriptor(win, 'Function');
    const F = d && 'value' in d ? (d.value as unknown) : undefined;
    // The browser's own Function constructor (of some realm the page has): a page-made function or Proxy is refused
    // without being called.
    if (isNative(N, F, 'Function')) {
      const make = new (F as FunctionConstructor)(FACTORY_SOURCE) as () => PageFactory;
      kit = buildKit(N.apply(make, undefined, []) as PageFactory);
    }
  } catch {
    kit = null; // eval forbidden in that realm (its CSP), or the realm is gone
  }
  kits.set(key, kit);
  return kit;
}

function buildKit(f: PageFactory): PageKit {
  const { fp, str, formJson, error, highlight, unhighlight, observe, wrap, replace, run, sheet, setSheet, adopt, readString } = f;
  const obj = (v: unknown): object | null => (typeof v === 'object' && v !== null ? v : null);
  return {
    str: (v) => {
      const s = str(v);
      return typeof s === 'string' ? s : '';
    },
    error: (message, name = 'SecurityError') => error(message, name),
    highlight: (name, ranges) => highlight(name, ranges) === true,
    unhighlight: (name) => {
      unhighlight(name);
    },
    observe: (root, cb, attributeFilter) => observe(root, cb, attributeFilter ? [...attributeFilter] : null) === true,
    formEntries: (form, submitter) => {
      const json = formJson(form, submitter ?? null);
      const parsed = JSON.parse(typeof json === 'string' ? json : '{}') as { entries?: unknown; files?: unknown };
      const entries: Array<[string, string]> = [];
      if (Array.isArray(parsed.entries)) {
        for (const e of parsed.entries) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string') entries.push([e[0], e[1]]);
      }
      return { entries, files: typeof parsed.files === 'number' ? parsed.files : 0 };
    },
    wrap: (original, before, after) => wrap(original, before, after),
    replace: (original, decide) => replace(original, decide),
    fn: (decide) => replace(fp, decide),
    // Each result is coerced without reading a property of it (rule 2); the page-realm halves catch their own throws.
    run: (source) => {
      try {
        return run(source) === true;
      } catch {
        return false; // the stack was exhausted at the call itself
      }
    },
    sheet: (css) => {
      try {
        return obj(sheet(css));
      } catch {
        return null;
      }
    },
    setSheet: (s, css) => {
      try {
        return setSheet(s, css) === true;
      } catch {
        return false;
      }
    },
    adopt: (doc, s) => {
      try {
        return adopt(doc, s) === true;
      } catch {
        return false;
      }
    },
    readString: (o, key) => {
      try {
        const v = readString(o, key);
        return typeof v === 'string' ? v : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Wraps a method of a page prototype (or object) with GNOME's steps; false when it is missing, not a function or not
 * configurable. `proto` must be an object of the page realm read before page code ran there.
 */
export function wrapMethod(N: Natives, kit: PageKit, proto: object | undefined, key: string, before: Step | null, after: AfterStep | null): boolean {
  if (!proto) return false;
  const d = N.getOwnPropertyDescriptor(proto, key);
  const original = d && 'value' in d ? (d.value as unknown) : undefined;
  if (!d || typeof original !== 'function' || !d.configurable) return false;
  N.defineProperty(proto, key, { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: kit.wrap(original as AnyFn, before, after) });
  return true;
}

/** Wraps the getter and/or setter of an accessor of a page prototype with GNOME's steps. */
export function wrapAccessor(
  N: Natives,
  kit: PageKit,
  proto: object | undefined,
  key: string,
  steps: { get?: { before?: Step; after?: AfterStep }; set?: { before?: Step; after?: AfterStep } },
): boolean {
  if (!proto) return false;
  const d = N.getOwnPropertyDescriptor(proto, key);
  if (!d || !d.configurable || (!d.get && !d.set)) return false;
  const get = d.get && steps.get ? kit.wrap(d.get as AnyFn, steps.get.before ?? null, steps.get.after ?? null) : d.get;
  const set = d.set && steps.set ? kit.wrap(d.set as AnyFn, steps.set.before ?? null, steps.set.after ?? null) : d.set;
  N.defineProperty(proto, key, { configurable: d.configurable, enumerable: d.enumerable, get, set });
  return true;
}

/** The i-th argument when the page passed it (own data elements of the trap's page-realm array only). */
export function arg(args: ArrayLike<unknown>, i: number): unknown {
  return i < args.length ? args[i] : undefined;
}
