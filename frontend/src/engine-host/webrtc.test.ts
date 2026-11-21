import { describe, expect, it } from 'vitest';
import { PROXY_PATHS } from '../shared/proxy-origin';
import { FRAME_RESTRICTION_CSP } from './csp';
import type { Natives } from './natives';
import { SRCDOC_HOOK_MARK, killWebRtcDeep, srcdocHookTag, withSrcdocHook } from './webrtc';

describe('srcdoc documents get the document-start hook first', () => {
  const tag = srcdocHookTag('http://127.0.0.1:27201', PROXY_PATHS.uvDocumentHook);

  it('is a classic script on the proxy origin, marked', () => {
    expect(tag).toBe(`<script src="http://127.0.0.1:27201/engine/uv-doc-hook.js" ${SRCDOC_HOOK_MARK}=""></script>`);
  });

  it('goes before everything else, once', () => {
    const html = '<script src="/vendor/ultraviolet/uv.bundle.js" __uv-script="1"></script><p>page</p>';
    const hooked = withSrcdocHook(html, tag);
    expect(hooked.startsWith(tag)).toBe(true);
    expect(hooked.endsWith(html)).toBe(true);
    expect(withSrcdocHook(hooked, tag)).toBe(hooked);
    expect(withSrcdocHook('', tag)).toBe(tag);
  });
});

describe('frames a proxied document may not have', () => {
  it('allows only same-origin (engine-proxied) frames and no plugin content', () => {
    expect(FRAME_RESTRICTION_CSP).toBe("frame-src 'self'; object-src 'none'");
    expect(FRAME_RESTRICTION_CSP).not.toMatch(/data:|blob:|\*/);
  });
});

// A minimal model of windows, documents and frame elements for the child-frame guard: each object answers the native
// getters the guard calls (natives.ts) with its own fields. No page kit can be built for it (no native Function), so
// the guard runs on its sweeps and its capture-phase `load` listener, which is the path that killed the tab frames'
// new documents after a switch to `allow` (worklist A1).
interface FakeWin {
  RTCPeerConnection?: unknown;
  doc: FakeDoc;
  kids: FakeWin[];
  [index: number]: FakeWin;
}
interface FakeDoc {
  nodeType: 9;
  view: FakeWin;
  listeners: Array<(ev: unknown) => void>;
}
interface FakeFrame {
  nodeType: 1;
  localName: 'iframe';
  ownerDocument: FakeDoc;
  contentWindow: FakeWin;
}

function fakeWindow(): FakeWin {
  const win = { RTCPeerConnection: function RTCPeerConnection() {}, kids: [] } as unknown as FakeWin;
  win.doc = { nodeType: 9, view: win, listeners: [] };
  return win;
}

/** `child` becomes the parent's frame `index` (a frame that loads a new document gets a new Window). */
function setFrame(parent: FakeWin, index: number, child: FakeWin): FakeFrame {
  parent.kids[index] = child;
  parent[index] = child;
  return { nodeType: 1, localName: 'iframe', ownerDocument: parent.doc, contentWindow: child };
}

function fireLoad(frame: FakeFrame): void {
  for (const fn of frame.ownerDocument.listeners) fn({ target: frame });
}

const fakeNatives = {
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  defineProperty: Object.defineProperty,
  getPrototypeOf: Object.getPrototypeOf,
  fnToString: Function.prototype.toString,
  apply: Reflect.apply,
  winDocument(this: FakeWin) {
    return this.doc;
  },
  winLength(this: FakeWin) {
    return this.kids.length;
  },
  winLocation(this: FakeWin) {
    return this;
  },
  locationHref() {
    return 'http://127.0.0.1:27201/scramjet/x'; // same-origin with the engine host
  },
  nodeType(this: { nodeType: number }) {
    return this.nodeType;
  },
  defaultView(this: FakeDoc) {
    return this.view;
  },
  ownerDocument(this: FakeFrame) {
    return this.ownerDocument;
  },
  localName(this: FakeFrame) {
    return this.localName;
  },
  firstElementChild() {
    return null;
  },
  shadowRoot() {
    return null;
  },
  eventTarget(this: { target: unknown }) {
    return this.target;
  },
  contentWindow(this: FakeFrame) {
    return this.contentWindow;
  },
  frameContentWindow() {
    throw new TypeError('not a frame');
  },
  objectContentWindow() {
    throw new TypeError('not an object');
  },
  on(this: FakeDoc, type: string, fn: (ev: unknown) => void) {
    if (type === 'load') this.listeners.push(fn);
  },
} as unknown as Natives;

/** The guard takes real Windows; the model stands in for them. */
const asWin = (w: FakeWin): Window => w as unknown as Window;

describe('the child-frame guard and the live privacy.webrtc setting', () => {
  it("the engine-host realm's guard follows the live setting: a tab frame's new document keeps WebRTC under allow", () => {
    let policy: 'block' | 'allow' = 'block';
    const host = fakeWindow();
    const first = fakeWindow();
    setFrame(host, 0, first);
    killWebRtcDeep(asWin(host), fakeNatives, undefined, null, () => policy === 'block');
    expect(host.RTCPeerConnection).toBeUndefined();
    expect(first.RTCPeerConnection).toBeUndefined(); // the install sweep reaches the open tab document

    policy = 'allow'; // a `settings` snapshot, then the tab reloads: a new Window, the host document's load listener runs
    const allowed = fakeWindow();
    fireLoad(setFrame(host, 0, allowed));
    expect(typeof allowed.RTCPeerConnection).toBe('function');
    const allowedChild = fakeWindow(); // and frames the page makes there are not killed either
    fireLoad(setFrame(allowed, 0, allowedChild));
    expect(typeof allowedChild.RTCPeerConnection).toBe('function');

    policy = 'block'; // back to block: the next document is killed again, with its children
    const blocked = fakeWindow();
    fireLoad(setFrame(host, 0, blocked));
    expect(blocked.RTCPeerConnection).toBeUndefined();
    const blockedChild = fakeWindow();
    fireLoad(setFrame(blocked, 0, blockedChild));
    expect(blockedChild.RTCPeerConnection).toBeUndefined();
  });

  it("a proxied document's own guard (no predicate) keeps killing its new child frames", () => {
    const page = fakeWindow();
    killWebRtcDeep(asWin(page), fakeNatives);
    const child = fakeWindow();
    fireLoad(setFrame(page, 0, child));
    expect(page.RTCPeerConnection).toBeUndefined();
    expect(child.RTCPeerConnection).toBeUndefined();
  });

  it('counts each killed window once, through onKilled', () => {
    const page = fakeWindow();
    const killed: number[] = [];
    killWebRtcDeep(asWin(page), fakeNatives, (n) => killed.push(n));
    killWebRtcDeep(asWin(page), fakeNatives, (n) => killed.push(n)); // idempotent
    expect(killed).toEqual([1]);
  });
});

// ── WAVE-B3 F2, F4, F5: the Ultraviolet realm hardening, in a vm context standing for a page realm ──
import vm from 'node:vm';
import { COOKIE_STORE_GLOBALS, hardenUvRealm } from './webrtc';

describe('hardenUvRealm (F2 frameElement, F4 cross-origin pushState, F5 Cookie Store)', () => {
  const hostDocument = { host: true } as unknown as Document;
  const pageDocument = { host: false };
  const NATIVE_NAMES = new Set(['Function', 'History', 'Window', 'ServiceWorkerRegistration']);
  function setup() {
    const ctx = vm.createContext({});
    const run = <T,>(code: string): T => vm.runInContext(code, ctx) as T;
    run(`
      globalThis.History = function History() {};
      History.prototype.pushState = function pushState(s, t, u) { calls.push(['push', u]); };
      History.prototype.replaceState = function replaceState(s, t, u) { calls.push(['replace', u]); };
      globalThis.Window = function Window() {};
      globalThis.ServiceWorkerRegistration = function ServiceWorkerRegistration() {};
      ServiceWorkerRegistration.prototype.cookies = {};
      globalThis.calls = [];
      globalThis.history = new History();
      globalThis.cookieStore = { real: true };
      globalThis.CookieStore = function CookieStore() {};
      globalThis.__fe = null;
      Object.defineProperty(globalThis, 'frameElement', { configurable: true, enumerable: true, get() { return globalThis.__fe; } });
      globalThis.__href = 'https://p.example/uv/service/site-b/page';
    `);
    const win = run<Window>('globalThis');
    const docs = new WeakMap<object, object>();
    const N = {
      winDocument(this: object) {
        let d = docs.get(this);
        if (!d) docs.set(this, (d = {}));
        return d;
      },
      getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
      defineProperty: Object.defineProperty,
      getPrototypeOf: Object.getPrototypeOf,
      // The stand-in constructors count as the browser's own (a vm context has no History or Window).
      fnToString(this: { name?: string }) {
        return typeof this === 'function' && NATIVE_NAMES.has(this.name ?? '') ? `function ${this.name}() { [native code] }` : Function.prototype.toString.call(this);
      },
      apply: Reflect.apply,
      frameElement(this: { __fe: unknown }) {
        return this.__fe;
      },
      ownerDocument(this: { doc: unknown }) {
        return this.doc;
      },
      winHistory(this: { history: unknown }) {
        return this.history;
      },
      winLocation(this: { __href: string }) {
        return { href: this.__href };
      },
      locationHref(this: { href: string }) {
        return this.href;
      },
    } as unknown as Natives;
    // `/uv/service/<host>/<path>` stands for UV's encoded URLs.
    const realUrl = (raw: string, base: string): string | null => {
      const u = new URL(raw, base);
      const m = /^\/uv\/service\/([^/]+)(\/.*)?$/.exec(u.pathname);
      return u.origin === 'https://p.example' && m ? `https://${m[1]}${m[2] ?? '/'}` : null;
    };
    hardenUvRealm(win, N, { hostDocument, documentUrl: () => 'https://site-b/page', realUrl });
    return { run, win };
  }

  it('F2: returns null for the engine host’s iframe, also through the descriptor, and is a page-realm getter', () => {
    const { run, win } = setup();
    (win as unknown as Record<string, unknown>).__fe = { doc: hostDocument };
    expect(run('frameElement')).toBeNull();
    expect(run('Object.getOwnPropertyDescriptor(globalThis, "frameElement").get.call(globalThis)')).toBeNull();
    expect(run('Object.getOwnPropertyDescriptor(globalThis, "frameElement").get.constructor === Function')).toBe(true);
    (win as unknown as Record<string, unknown>).__fe = { doc: pageDocument, mine: 1 };
    expect(run('frameElement.mine')).toBe(1);
  });

  it('F4: refuses pushState/replaceState to another origin or to a proxy-origin URL that is no Ultraviolet URL', () => {
    const { run } = setup();
    run('history.pushState(null, "", "/uv/service/site-b/next")');
    run('history.replaceState(null, "", undefined)');
    expect(run('JSON.stringify(calls)')).toBe('[["push","/uv/service/site-b/next"],["replace",null]]');
    for (const url of ['/uv/service/site-a/', '/engine/?x', 'https://p.example/~/sj/x']) {
      expect(run(`try { history.pushState(null, "", ${JSON.stringify(url)}); "none" } catch (e) { e.constructor.constructor("return this")() === globalThis ? "page:" + e.name : "host" }`)).toMatch(/^page:/);
    }
    expect(run('calls.length')).toBe(2);
    // called through another realm's history object: judged against that history's window (here: unknown → this one)
    expect(run('try { History.prototype.replaceState.call(history, null, "", "/uv/service/evil/"); "none" } catch (e) { "threw" }')).toBe('threw');
  });

  it('F5: the Cookie Store API is undefined (data properties), also on ServiceWorkerRegistration.prototype', () => {
    const { run } = setup();
    for (const name of COOKIE_STORE_GLOBALS) {
      expect(run(`typeof ${name}`)).toBe('undefined');
      expect(run(`(() => { const d = Object.getOwnPropertyDescriptor(globalThis, ${JSON.stringify(name)}); return 'value' in d && !d.configurable && !d.writable; })()`)).toBe(true);
    }
    expect(run('ServiceWorkerRegistration.prototype.cookies')).toBeUndefined();
  });
});
