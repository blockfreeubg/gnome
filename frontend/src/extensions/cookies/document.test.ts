// The document parts of x3 (cookies/document.ts, privacy/document.ts) against a fake page realm: node `vm` contexts
// stand for proxied documents (each its own realm, as realm.test.ts does), with an engine-like `Document.prototype`
// whose `cookie` and `referrer` accessors ignore `this` (as Scramjet's traps do).
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { DocumentInfo } from '../../shared/engine-hooks';
import type { Natives } from '../../engine-host/natives';
import { cachedKit, pageKit } from '../../engine-host/realm';
import type { HookProvider } from '../core/compose';
import { withPrivacyDocument } from '../privacy/document';
import { createPrivacyProvider } from '../privacy/provider';
import { contextFor, settings } from '../privacy/testing';
import type { BlockerSettings } from '../core/policy';
import { createCookieProvider } from './provider';
import { scriptCookieAcceptable, withCookieDocument } from './document';

const FAKE_NATIVE = new WeakSet<object>();
const N = {
  winDocument(this: { document: object }) {
    return this.document;
  },
  winNavigator(this: { navigator: object }) {
    return this.navigator;
  },
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  defineProperty: Object.defineProperty,
  getPrototypeOf: Object.getPrototypeOf,
  // The vm realm has no DOM: its stand-in `Document` constructor passes realm.ts's native check.
  fnToString(this: object) {
    return FAKE_NATIVE.has(this) ? 'function Document() { [native code] }' : Function.prototype.toString.call(this);
  },
  apply: Reflect.apply,
  Proxy,
} as unknown as Natives;

interface Page {
  ctx: vm.Context;
  win: Window;
  run<T = unknown>(code: string): T;
}

const ENGINE = `
  globalThis.__jar = globalThis.__jar || 'a=1; b=2';
  globalThis.__writes = [];
  globalThis.__ref = 'https://site-b.example/secret/page?id=42';
  function Document() {}
  Object.defineProperty(Document.prototype, 'cookie', { configurable: true, enumerable: true,
    get() { return globalThis.__jar; },
    set(v) { globalThis.__writes.push(v); } });
  Object.defineProperty(Document.prototype, 'referrer', { configurable: true, enumerable: true, get() { return globalThis.__ref; } });
  globalThis.Document = Document;
  globalThis.document = new Document();
  globalThis.navigator = {};
`;

/** A realm with an engine-like Document.prototype; `jar` is what its engine's cookie getter answers (for the realm). */
function page(jar?: string): Page {
  const ctx = vm.createContext(jar === undefined ? {} : { __jar: jar });
  const run = <T,>(code: string): T => vm.runInContext(code, ctx) as T;
  run(ENGINE);
  FAKE_NATIVE.add(run<object>('Document'));
  const win = run<Window>('globalThis');
  pageKit(win, N); // document start: the core builds the kit before the engine's client and the page run
  return { ctx, win, run };
}

/** Whether a value belongs to this file's realm (the engine host's). */
function hostRealm(v: unknown): boolean {
  if ((typeof v !== 'object' && typeof v !== 'function') || v === null) return false;
  let F = typeof v === 'function' ? (v as { constructor: unknown }).constructor : (v as { constructor: { constructor: unknown } }).constructor?.constructor;
  for (let i = 0; i < 4 && typeof F === 'function' && (F as { constructor: unknown }).constructor !== F; i++) F = (F as { constructor: unknown }).constructor;
  return F === Function;
}

const kitOf = (win: Window) => cachedKit(win, N);

function attach(p: HookProvider, pg: Page, s: BlockerSettings, url: string, top: string): void {
  const doc: DocumentInfo = { engine: 'scramjet', tabId: 1, url, topLevelUrl: top, isTopLevel: url === top };
  p.onDocument?.(pg.win, doc, contextFor(s, url, top));
}

describe('withCookieDocument', () => {
  const make = () => withCookieDocument(createCookieProvider(), { N, kitOf });
  const s = settings({ privacy: { cookies: 'block-third-party' } });

  it('a third-party frame under block-third-party: reads are empty, writes ignored', () => {
    const p = make();
    const frame = page();
    attach(p, frame, s, 'https://trk.example/frame', 'https://site-a.example/');
    expect(frame.run('document.cookie')).toBe('');
    frame.run('document.cookie = "t=1"');
    expect(frame.run('__writes.length')).toBe(0);
  });

  it('a first-party document keeps its cookies (the engine’s own hook runs)', () => {
    const p = make();
    const top = page();
    attach(p, top, s, 'https://site-a.example/', 'https://site-a.example/');
    expect(top.run('document.cookie')).toBe('a=1; b=2');
    top.run('document.cookie = "c=3; Path=/"');
    expect(top.run('__writes')).toEqual(['c=3; Path=/']);
  });

  it('decides by `this`: a blocked frame’s document through the top realm’s getter, a fake `this` in the frame realm', () => {
    const p = make();
    const top = page('a=1; b=2');
    const frame = page('trk=1');
    attach(p, top, s, 'https://site-a.example/', 'https://site-a.example/');
    attach(p, frame, s, 'https://trk.example/frame', 'https://site-a.example/');
    top.ctx.frameDoc = frame.run('document');
    expect(top.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call(frameDoc)')).toBe('');
    expect(top.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call(document)')).toBe('a=1; b=2');
    // The engine's trap ignores `this`: a fake one in the frame realm gets the frame's (blocked) decision.
    expect(frame.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call({})')).toBe('');
    expect(frame.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call(new Document())')).toBe('');
  });

  it('decides by the accessor’s realm too: a blocked frame passing an attached first-party document gets nothing', () => {
    const p = make();
    const top = page('a=1; b=2');
    const frame = page('trk=1');
    attach(p, top, s, 'https://site-a.example/', 'https://site-a.example/');
    attach(p, frame, s, 'https://trk.example/frame', 'https://site-a.example/');
    frame.ctx.topDoc = top.run('document');
    // The engines' accessors read and write the jar of their OWN realm's document whatever `this` is (this fake as
    // Scramjet's trap and Ultraviolet's hook do): the frame's realm on the top document would hand out trk's cookies.
    expect(frame.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call(topDoc)')).toBe('');
    frame.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").set.call(topDoc, "t=1; Path=/")');
    expect(frame.run('__writes')).toEqual([]);
    // The top realm's own accessor on its own document still works.
    expect(top.run('document.cookie')).toBe('a=1; b=2');
  });

  it('checks a script write against the realm’s document, also when `this` is another site’s attached document', () => {
    const p = make();
    const all = settings({ privacy: { cookies: 'all' } });
    const b = page('b=1');
    const a = page('a=1');
    attach(p, b, all, 'https://site-b.example/', 'https://site-b.example/');
    attach(p, a, all, 'https://site-a.example/f', 'https://site-b.example/');
    b.ctx.aDoc = a.run('document');
    // site-b's accessor stores for site-b's URL (its engine's realm): another site's Domain stays refused there.
    b.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").set.call(aDoc, "sid=evil; Domain=site-a.example; Path=/")');
    expect(b.run('__writes')).toEqual([]);
    b.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").set.call(aDoc, "ok=1; Path=/")');
    expect(b.run('__writes')).toEqual(['ok=1; Path=/']);
  });

  it('a rule `block` for the document’s own site blocks it as first party; `allow` lets a third party through', () => {
    const p = make();
    const a = page();
    attach(p, a, settings({ privacy: { cookies: 'all' }, extensions: { cookieRules: { '*.site-a.example': 'block' } } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(a.run('document.cookie')).toBe('');
    const t = page();
    attach(p, t, settings({ extensions: { cookieRules: { 'trk.example': 'allow' } } }), 'https://trk.example/f', 'https://site-a.example/');
    expect(t.run('document.cookie')).toBe('a=1; b=2');
  });

  it('the cookie manager off: nothing blocked', () => {
    const p = make();
    const t = page();
    attach(p, t, settings({ enabled: { cookies: false }, privacy: { cookies: 'block-all' } }), 'https://trk.example/f', 'https://site-a.example/');
    expect(t.run('document.cookie')).toBe('a=1; b=2');
  });

  it('ignores writes a browser refuses from script (another site’s Domain, HttpOnly, prefixes) and non-string values', () => {
    const p = make();
    const b = page();
    attach(p, b, s, 'https://site-b.example/', 'https://site-b.example/');
    b.run('document.cookie = "sid=evil; Domain=site-a.example; Path=/"');
    b.run('document.cookie = "h=1; HttpOnly"');
    b.run('document.cookie = "__Host-x=1; Path=/"');
    b.run('document.cookie = { toString() { globalThis.converted = (globalThis.converted || 0) + 1; return "o=1"; } }');
    b.run('document.cookie = "ok=1; Domain=site-b.example"');
    expect(b.run('__writes')).toEqual(['ok=1; Domain=site-b.example']);
    expect(b.run('globalThis.converted')).toBeUndefined();
  });

  it('installs only page-realm callables, wraps each realm once, and runs no page code on a page Proxy `this`', () => {
    const p = make();
    const pg = page();
    attach(p, pg, s, 'https://site-a.example/', 'https://site-a.example/');
    const d1 = pg.run<PropertyDescriptor>('Object.getOwnPropertyDescriptor(Document.prototype, "cookie")');
    attach(p, pg, s, 'https://site-a.example/again', 'https://site-a.example/again');
    const d2 = pg.run<PropertyDescriptor>('Object.getOwnPropertyDescriptor(Document.prototype, "cookie")');
    expect(d2.get).toBe(d1.get);
    expect(hostRealm(d1.get)).toBe(false);
    expect(hostRealm(d1.set)).toBe(false);
    expect(pg.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.constructor === Function')).toBe(true);
    pg.run(`globalThis.trapped = []; globalThis.spy = new Proxy({}, new Proxy({}, { get(t, k) { trapped.push(String(k)); return undefined; } }));`);
    pg.run('Object.getOwnPropertyDescriptor(Document.prototype, "cookie").get.call(spy)');
    pg.run('try { Object.getOwnPropertyDescriptor(Document.prototype, "cookie").set.call(spy, "x=1") } catch (e) {}');
    expect(pg.run('trapped')).toEqual([]);
  });

  it('Ultraviolet: a blocked document’s injected cookie string (__uv$cookies) becomes empty; others keep theirs', () => {
    const p = make();
    const uvAttach = (pg: Page, url: string, top: string, engine: 'ultraviolet' | 'scramjet' = 'ultraviolet') =>
      p.onDocument?.(pg.win, { engine, tabId: 1, url, topLevelUrl: top, isTopLevel: url === top }, contextFor(s, url, top));
    const frame = page();
    frame.run('globalThis.__uv$cookies = "trk=1"');
    uvAttach(frame, 'https://trk.example/frame', 'https://site-a.example/');
    expect(frame.run('__uv$cookies')).toBe('');
    expect(frame.run('typeof __uv$cookies')).toBe('string');
    const first = page();
    first.run('globalThis.__uv$cookies = "a=1"');
    uvAttach(first, 'https://site-a.example/', 'https://site-a.example/');
    expect(first.run('__uv$cookies')).toBe('a=1');
    // Scramjet documents have no such global: a page's own variable of that name stays.
    const sj = page();
    sj.run('globalThis.__uv$cookies = "page data"');
    uvAttach(sj, 'https://trk.example/frame', 'https://site-a.example/', 'scramjet');
    expect(sj.run('__uv$cookies')).toBe('page data');
    // Also without a kit (a data property holding a primitive needs none).
    const noKit = withCookieDocument(createCookieProvider(), { N, kitOf: () => null });
    const bare = page();
    bare.run('globalThis.__uv$cookies = "trk=1"');
    noKit.onDocument?.(bare.win, { engine: 'ultraviolet', tabId: 1, url: 'https://trk.example/f', topLevelUrl: 'https://site-a.example/', isTopLevel: false }, contextFor(s, 'https://trk.example/f', 'https://site-a.example/'));
    expect(bare.run('__uv$cookies')).toBe('');
  });

  it('a realm without a kit is left alone', () => {
    const p = withCookieDocument(createCookieProvider(), { N, kitOf: () => null });
    const t = page();
    attach(p, t, s, 'https://trk.example/f', 'https://site-a.example/');
    expect(t.run('document.cookie')).toBe('a=1; b=2');
  });

  it('keeps the wrapped provider’s request and response hooks', () => {
    const base = createCookieProvider();
    const p = withCookieDocument(base, { N, kitOf });
    expect(p.name).toBe('cookies');
    expect(p.onRequest).toBe(base.onRequest);
    expect(p.onResponse).toBe(base.onResponse);
  });

  it('scriptCookieAcceptable', () => {
    expect(scriptCookieAcceptable('a=1', 'https://site-a.example/')).toBe(true);
    expect(scriptCookieAcceptable('a=1; httponly', 'https://site-a.example/')).toBe(false);
    expect(scriptCookieAcceptable('a=1; Domain=site-b.example', 'https://site-a.example/')).toBe(false);
  });
});

describe('withPrivacyDocument', () => {
  const make = () => withPrivacyDocument(createPrivacyProvider({ rewriteParams: () => null }), { N, kitOf });

  it('sets navigator.globalPrivacyControl and doNotTrack as configurable read-only primitives', () => {
    const p = make();
    const pg = page();
    attach(p, pg, settings({ privacy: { sendGpc: true, doNotTrack: true } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('navigator.globalPrivacyControl')).toBe(true);
    expect(pg.run('navigator.doNotTrack')).toBe('1');
    expect(pg.run('JSON.stringify(Object.getOwnPropertyDescriptor(navigator, "globalPrivacyControl"))')).toBe('{"value":true,"writable":false,"enumerable":true,"configurable":true}');
    pg.run('navigator.globalPrivacyControl = false');
    expect(pg.run('navigator.globalPrivacyControl')).toBe(true);
    expect(pg.run('delete navigator.globalPrivacyControl')).toBe(true);
  });

  it('neither with privacy protection off or the switches off; an allowlisted site keeps GPC', () => {
    const p = make();
    for (const s of [settings({ enabled: { privacy: false }, privacy: { doNotTrack: true } }), settings({ privacy: { sendGpc: false } })]) {
      const pg = page();
      attach(p, pg, s, 'https://site-a.example/', 'https://site-a.example/');
      expect(pg.run('"globalPrivacyControl" in navigator')).toBe(false);
      expect(pg.run('"doNotTrack" in navigator')).toBe(false);
    }
    const al = page();
    attach(p, al, settings({ extensions: { allowlist: ['*.site-a.example'] } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(al.run('navigator.globalPrivacyControl')).toBe(true);
  });

  it('sets the navigator flags also in a realm without a kit', () => {
    const p = withPrivacyDocument(createPrivacyProvider({ rewriteParams: () => null }), { N, kitOf: () => null });
    const pg = page();
    attach(p, pg, settings(), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('navigator.globalPrivacyControl')).toBe(true);
    expect(pg.run('document.referrer')).toBe('https://site-b.example/secret/page?id=42');
  });

  it('reduces document.referrer to the floor and the mode, also through the prototype descriptor and on other documents', () => {
    const p = make();
    const pg = page();
    attach(p, pg, settings({ privacy: { referrer: 'origin-cross-site' } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('document.referrer')).toBe('https://site-b.example/');
    expect(pg.run('Object.getOwnPropertyDescriptor(Document.prototype, "referrer").get.call(document)')).toBe('https://site-b.example/');
    expect(pg.run('Object.getOwnPropertyDescriptor(Document.prototype, "referrer").get.call(new Document())')).toBe('https://site-b.example/');
    const other = page();
    other.ctx.doc = pg.run('document');
    // Another realm's original getter on this document still sees the engine's value; this realm's wrapper, when
    // it has one, answers for documents GNOME attached.
    const q = page();
    q.run('__ref = "https://site-d.example/other?id=7"');
    attach(p, q, settings({ privacy: { referrer: 'default' } }), 'https://site-c.example/', 'https://site-c.example/');
    expect(q.run('document.referrer')).toBe('https://site-d.example/');
    q.ctx.doc = pg.run('document');
    // q's getter on pg's document answers pg's reduced value (decided by `this`, not by q's own document).
    expect(q.run('Object.getOwnPropertyDescriptor(Document.prototype, "referrer").get.call(doc)')).toBe('https://site-b.example/');
  });

  it('same origin keeps the full URL (without fragment); none and https → http give ""', () => {
    const p = make();
    const same = page();
    same.run('__ref = "https://site-a.example/from?x=1#frag"');
    attach(p, same, settings({ privacy: { referrer: 'origin-cross-site' } }), 'https://site-a.example/to', 'https://site-a.example/to');
    expect(same.run('document.referrer')).toBe('https://site-a.example/from?x=1');
    const none = page();
    attach(p, none, settings({ privacy: { referrer: 'none' } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(none.run('document.referrer')).toBe('');
    const down = page();
    attach(p, down, settings({ privacy: { referrer: 'default' } }), 'http://plain.example/', 'http://plain.example/');
    expect(down.run('document.referrer')).toBe('');
    const empty = page();
    empty.run('__ref = ""');
    attach(p, empty, settings(), 'https://site-a.example/', 'https://site-a.example/');
    expect(empty.run('document.referrer')).toBe('');
  });

  it('the floor holds with privacy protection off', () => {
    const p = make();
    const pg = page();
    attach(p, pg, settings({ enabled: { privacy: false }, privacy: { referrer: 'none' } }), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('document.referrer')).toBe('https://site-b.example/');
  });

  it('installs only page-realm callables and reads the referrer with page code once', () => {
    const p = make();
    const pg = page();
    pg.run(`globalThis.reads = 0; Object.defineProperty(Document.prototype, 'referrer', { configurable: true, enumerable: true, get() { globalThis.reads++; return 'https://site-b.example/x'; } });`);
    attach(p, pg, settings(), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('reads')).toBe(1);
    pg.run('document.referrer; document.referrer;');
    expect(pg.run('reads')).toBe(1);
    const d = pg.run<PropertyDescriptor>('Object.getOwnPropertyDescriptor(Document.prototype, "referrer")');
    expect(hostRealm(d.get)).toBe(false);
  });

  it('Ultraviolet: the injected referrer global (__uv$referrer, the whole proxied referring URL) becomes empty', () => {
    const p = make();
    const uv = page();
    uv.run('globalThis.__uv$referrer = "http://proxy.example/uv/service/https%3A%2F%2Fsite-b.example%2Fsecret%3Fid%3D42"');
    p.onDocument?.(uv.win, { engine: 'ultraviolet', tabId: 1, url: 'https://site-a.example/', topLevelUrl: 'https://site-a.example/', isTopLevel: true }, contextFor(settings({ enabled: { privacy: false } }), 'https://site-a.example/', 'https://site-a.example/'));
    expect(uv.run('__uv$referrer')).toBe('');
    expect(uv.run('document.referrer')).toBe('https://site-b.example/');
    const sj = page();
    sj.run('globalThis.__uv$referrer = "page data"');
    attach(p, sj, settings(), 'https://site-a.example/', 'https://site-a.example/');
    expect(sj.run('__uv$referrer')).toBe('page data');
  });

  it('a throwing engine getter reads as no referrer (fail closed for the value, open for the page)', () => {
    const p = make();
    const pg = page();
    pg.run(`Object.defineProperty(Document.prototype, 'referrer', { configurable: true, get() { throw new Error('x'); } });`);
    attach(p, pg, settings(), 'https://site-a.example/', 'https://site-a.example/');
    expect(pg.run('document.referrer')).toBe('');
  });
});
