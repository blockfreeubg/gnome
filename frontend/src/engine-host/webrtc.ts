/**
 * The WebRTC kill switch (ENGINE-PROTOCOL §6.15, `privacy.webrtc: 'block'`): the WEBRTC_GLOBALS constructors become
 * `undefined` (non-writable, non-configurable) in every proxied window at document start (Scramjet `init.pre`, the UV
 * document-start hook) and in the engine-host realm. Without it a proxied page reaches STUN servers directly, outside
 * Wisp, and reveals the user's IP address.
 *
 * Child frames a proxied page creates itself (`about:blank`, `srcdoc`, `javascript:`, `<object>`/`<embed>`) start with
 * a fresh realm that no engine hook reaches before the page can touch it. guardChildFrames() closes that for ordinary
 * pages, in each guarded realm:
 * - getters that hand out a child window or document (`contentWindow`, `contentDocument` of iframes, frames and
 *   objects) kill the child before they return it;
 * - every DOM insertion path (appendChild, insertBefore, replaceChild, append, prepend, before, after, replaceWith,
 *   replaceChildren, insertAdjacentElement/HTML, innerHTML/outerHTML, setHTMLUnsafe, document.write, execCommand,
 *   Range insertion) sweeps the target document's child browsing contexts right after the native call returns (the
 *   child realm exists synchronously);
 * - observers the page cannot reach: a MutationObserver per document (frames the HTML parser inserts: it runs before
 *   the parser runs the next script) and a capture-phase `load` listener per document and shadow root (a frame that
 *   navigates to a new `about:blank`/`srcdoc`/`blob:` document gets a NEW realm; Chromium also fires the initial
 *   about:blank `load` inside the insertion call), each sweeping the child browsing contexts the way the page itself
 *   reaches them (`window[i]`, which also finds `<embed>` documents no getter hands out).
 * Everything installed in a page realm is a callable of that realm (realm.ts), and the guard reads page objects only
 * through the engine-host realm's natives. The engine-host realm gets the same guard (killWebRtcDeep at init),
 * because escaped page code can reach it (window.top[0]) and insert fresh frames into its document with its own DOM
 * methods (tests/e2e/engine/suites/host-webrtc.mjs `escaped-code-realms`).
 *
 * A `srcdoc` written later by any path reaches the same observer (an attribute record, before the browser commits
 * the about:srcdoc navigation), which puts GNOME's document-start hook first (see guardChildFrames).
 *
 * Known limits, measured in tests/e2e/engine/suites/host-webrtc.mjs `gaps-open` (lane a review, 2026-11-12; only
 * connection-level blocking would close them, which a website cannot do): a page that polls a child frame while the
 * frame loads a new proxied document reaches the new realm before the engine's document-start script has loaded
 * (both engines, both browsers); a `javascript:` document runs its scripts while it is parsed (Ultraviolet; Scramjet
 * runs none); Firefox fires the `load` of a frame re-navigated to about:blank after the new realm is reachable; a page
 * that runs GNOME's step out of stack (it recursed to the limit first) gets a RangeError after the native insertion
 * and the frame stays unkilled until the observer runs; and a page that first reaches the engine host through a fresh
 * realm's native `parent`/`top` getters (host-attack.mjs `borrow-natives`) is escaped code.
 */
import { WEBRTC_GLOBALS } from '../shared/proxy-origin';
import type { Natives } from './natives';
import { CALL_ORIGINAL, RETURN, THROW, arg, nativePrototype, pageKit, wrapAccessor, wrapMethod } from './realm';
import type { PageKit } from './realm';

const KILLED = Symbol.for('gnome.webrtc.killed');
const GUARDED = Symbol.for('gnome.webrtc.guarded');
const HARDENED = Symbol.for('gnome.uv.hardened');

type AnyWindow = Window & Record<PropertyKey, unknown>;

/** Replaces the WebRTC constructors of `win` with undefined; returns how many were present. Idempotent. */
export function killWebRtc(win: Window, N: Pick<Natives, 'defineProperty' | 'getOwnPropertyDescriptor'>): number {
  const w = win as AnyWindow;
  let replaced = 0;
  try {
    if (N.getOwnPropertyDescriptor(w, KILLED)) return 0;
    N.defineProperty(w, KILLED, { value: true, enumerable: false, configurable: false, writable: false });
  } catch {
    return 0;
  }
  for (const name of WEBRTC_GLOBALS) {
    try {
      const had = N.getOwnPropertyDescriptor(w, name) !== undefined;
      N.defineProperty(w, name, { value: undefined, writable: false, configurable: false, enumerable: false });
      if (had) replaced++;
    } catch {
      /* already non-configurable in this window (e.g. a second engine hook): leave it */
    }
  }
  return replaced;
}

/** The attribute that marks GNOME's document-start hook at the head of a `srcdoc` document. */
export const SRCDOC_HOOK_MARK = 'data-gnome-hook';

/** GNOME's document-start hook as the first element of a `srcdoc` document (an absolute URL on the proxy origin). */
export function srcdocHookTag(origin: string, hookPath: string): string {
  return `<script src="${origin}${hookPath}" ${SRCDOC_HOOK_MARK}=""></script>`;
}

/** The `srcdoc` HTML with the hook first, unless it already starts with it. */
export function withSrcdocHook(html: string, tag: string): string {
  return html.startsWith(tag) ? html : tag + html;
}

const ALWAYS = (): boolean => true;

/**
 * The switch in `win` and, through guardChildFrames, in every same-origin child frame created there, at any depth.
 * `srcdocTag`: GNOME's document-start hook (srcdocHookTag), put first in every `srcdoc` a script writes (see
 * guardChildFrames); null leaves `srcdoc` alone.
 *
 * `active`: whether the switch is still on when a child frame turns up (the guard stays installed for the life of its
 * realm). A proxied document decides once, at its start, so its own guard keeps the default (always). The
 * engine-host realm outlives every settings change: its guard follows the live `privacy.webrtc` (core.ts), otherwise
 * it would kill the new document of every tab frame at its `load` after a switch to `allow` (worklist A1).
 */
export function killWebRtcDeep(
  win: Window,
  N: Natives,
  onKilled: (replaced: number) => void = () => {},
  srcdocTag: string | null = null,
  active: () => boolean = ALWAYS,
): void {
  const replaced = killWebRtc(win, N);
  if (replaced > 0) onKilled(replaced);
  guardChildFrames(
    win,
    N,
    (child) => {
      if (active()) killWebRtcDeep(child, N, onKilled, srcdocTag, active);
    },
    srcdocTag,
  );
}

/** The child window of a frame element (iframe, frame or object; each kind has its own getter), or null. */
function frameWindow(N: Natives, el: unknown): Window | null {
  for (const get of [N.contentWindow, N.frameContentWindow, N.objectContentWindow]) {
    try {
      const w = get.call(el) as Window | null;
      if (w) return w;
    } catch {
      /* not this element kind */
    }
  }
  return null;
}

/** Whether a window is same-origin with this realm (reading a cross-origin child's location throws). */
function sameOrigin(N: Natives, w: Window): boolean {
  try {
    N.locationHref.call(N.winLocation.call(w));
    return true;
  } catch {
    return false;
  }
}

/** The window of a node's document (a Document node is its own document), or null. */
function viewOf(N: Natives, node: unknown): Window | null {
  try {
    const doc = N.nodeType.call(node) === 9 ? (node as Document) : N.ownerDocument.call(node);
    return doc ? N.defaultView.call(doc) : null;
  } catch {
    return null;
  }
}

/**
 * Installs the child-frame guard in `win`'s realm (see the header). `onChild` runs for each same-origin child window
 * found, before the page sees it; it should kill the switch there and call guardChildFrames on it in turn.
 *
 * `srcdoc` documents a script writes (the `srcdoc` property, setAttribute, an Attr, or HTML inserted with an iframe
 * that has one) are a NEW realm once they load (both browsers; Chromium reuses the about:blank window only sometimes),
 * created after the page's call returns and running its scripts at once: the guard cannot reach it in time. So the
 * `srcdoc` HTML gets GNOME's document-start hook first (`srcdocTag`), which hands the new window to the engine host
 * before any other script there runs. The value is re-set right after the page's own call, before the browser loads
 * it (an about:srcdoc navigation never commits in the same task); a page reading `srcdoc` back gets its own value from
 * its engine (both keep the page's value in their own attribute). Measured before this: a srcdoc set after insertion
 * ran RTCPeerConnection under Ultraviolet (both browsers) and Scramjet (Firefox).
 */
export function guardChildFrames(win: Window, N: Natives, onChild: (child: Window) => void, srcdocTag: string | null = null): void {
  const w = win as AnyWindow;

  /**
   * A child window the page could reach: the switch (and the guard) before it does. One already killed whose
   * document is observed needs nothing (its own guard covers what it creates), so a sweep costs a check per child.
   */
  const child = (c: Window | null): void => {
    if (!c || !sameOrigin(N, c)) return;
    try {
      if ((N.getOwnPropertyDescriptor(c, KILLED) || N.getOwnPropertyDescriptor(c, HARDENED)) && observedRoots.has(N.winDocument.call(c))) return;
    } catch {
      /* gone */
    }
    onChild(c);
  };
  /** Every child browsing context of `view`, as the page reaches them (`view[i]`, which finds `<embed>`s too). */
  const sweep = (view: Window | null): void => {
    if (!view) return;
    let n = 0;
    try {
      n = N.winLength.call(view) as number;
    } catch {
      return;
    }
    for (let i = 0; i < n && i < 1000; i++) {
      let c: Window | null = null;
      try {
        c = (view as unknown as Record<number, Window | null>)[i] ?? null; // WindowProxy indexed access: no page code
      } catch {
        c = null;
      }
      child(c);
    }
  };
  /** An iframe's `srcdoc` with GNOME's hook first (re-set at once, before the browser loads the old value). */
  const hookSrcdoc = (el: unknown): void => {
    if (srcdocTag === null) return;
    try {
      if (N.nodeType.call(el) !== 1 || N.localName.call(el) !== 'iframe') return;
      const v = N.getAttribute.call(el, 'srcdoc');
      if (v === null || v.startsWith(srcdocTag)) return;
      N.setAttribute.call(el, 'srcdoc', withSrcdocHook(v, srcdocTag));
    } catch {
      /* an element we cannot read */
    }
  };
  /**
   * srcdoc hooks and open shadow roots in a subtree; returns whether it may hold frames (then the caller sweeps the
   * document's child browsing contexts: an insertion without a frame element creates none).
   */
  const scan = (node: unknown): boolean => {
    try {
      const type = N.nodeType.call(node);
      if (type !== 1 && type !== 11 && type !== 9) return false;
      let frames = false;
      if (type === 1) {
        const local = N.localName.call(node);
        if (local === 'iframe') hookSrcdoc(node);
        if (local === 'iframe' || local === 'frame' || local === 'object' || local === 'embed') frames = true;
        const root = N.shadowRoot.call(node);
        if (root) {
          observeRoot(root);
          frames = true;
        }
        if (N.firstElementChild.call(node) === null) return frames; // a leaf (most insertions): no subtree to query
      }
      const list = type === 9 ? N.querySelectorAll.call(node, FRAME_SELECTOR) : type === 11 ? N.fragQuerySelectorAll.call(node, FRAME_SELECTOR) : N.elQuerySelectorAll.call(node, FRAME_SELECTOR);
      const len = N.nodeListLength.call(list);
      for (let i = 0; i < len; i++) {
        frames = true;
        hookSrcdoc(N.nodeListItem.call(list, i));
      }
      return frames;
    } catch {
      return true; // a node we cannot read: sweep to be safe
    }
  };
  /**
   * One added node (the observer's records): its own srcdoc and shadow root. The parser adds every element as its own
   * record, and the wrapped insertion paths scan whole subtrees synchronously, so no subtree query here (Wikipedia's
   * parse would otherwise query every added node's subtree).
   */
  const scanNode = (node: unknown): void => {
    try {
      if (N.nodeType.call(node) !== 1) return;
      hookSrcdoc(node);
      const root = N.shadowRoot.call(node);
      if (root) observeRoot(root);
    } catch {
      /* not an element */
    }
  };
  /** After the page changed a node's subtree: hook srcdocs there, sweep that document's child frames. */
  const changed = (node: unknown): void => {
    if (scan(node)) sweep(viewOf(N, node));
  };
  const onLoad = (ev: Event): void => {
    try {
      const t = N.eventTarget.call(ev);
      const local = t && N.nodeType.call(t) === 1 ? N.localName.call(t) : '';
      if (local === 'iframe' || local === 'frame' || local === 'object' || local === 'embed') {
        child(frameWindow(N, t));
        sweep(viewOf(N, t));
      }
    } catch {
      /* not a frame */
    }
  };
  /** Records of the page realm's observer (realm.ts `observe`), read with this realm's natives only. */
  const onMutations = (records: ArrayLike<unknown>): void => {
    const views = new Set<Window>();
    for (let r = 0; r < records.length; r++) {
      const rec = records[r];
      try {
        if (N.recordType.call(rec) === 'attributes') {
          hookSrcdoc(N.recordTarget.call(rec)); // a srcdoc written by any path (property, setAttribute, an Attr …)
          continue;
        }
        const added = N.recordAddedNodes.call(rec);
        const len = N.nodeListLength.call(added);
        for (let i = 0; i < len; i++) scanNode(N.nodeListItem.call(added, i));
        const v = viewOf(N, N.recordTarget.call(rec));
        if (v) views.add(v);
      } catch {
        /* not a record */
      }
    }
    for (const v of views) sweep(v);
  };
  /**
   * The observers of a document or shadow root: a MutationObserver of the root's own realm (realm.ts `observe`) and a
   * capture-phase `load` listener (events reach listeners as objects of their target's realm).
   */
  const observeRoot = (root: Node): void => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      const view = viewOf(N, root);
      const kit = view ? pageKit(view, N) : null;
      kit?.observe(root, onMutations, srcdocTag === null ? undefined : ['srcdoc']);
      N.on.call(root, 'load', onLoad as (ev: never) => void, true);
    } catch {
      /* a root we cannot observe */
    }
  };
  // Per document (a Window reused by the next same-origin document keeps its realm, not its observers).
  try {
    observeRoot(N.winDocument.call(win));
  } catch {
    /* no document */
  }

  // Per realm: the wrappers, once (the marker lives on the Window, so a new realm of the same frame gets its own).
  let fresh = false;
  try {
    if (!N.getOwnPropertyDescriptor(w, GUARDED)) {
      N.defineProperty(w, GUARDED, { value: true, enumerable: false, configurable: false, writable: false });
      fresh = true;
    }
  } catch {
    fresh = false;
  }
  if (fresh) installWrappers(win, N, { child, sweep, scan, changed, observeRoot });
  // The frames this realm already has.
  sweep(win);
}

const observedRoots = new WeakSet<object>();
const FRAME_SELECTOR = 'iframe,frame,object,embed';

interface GuardSteps {
  child(c: Window | null): void;
  sweep(view: Window | null): void;
  scan(node: unknown): boolean;
  changed(node: unknown): void;
  observeRoot(root: Node): void;
}

function installWrappers(win: Window, N: Natives, g: GuardSteps): void {
  const kit: PageKit | null = pageKit(win, N);
  if (!kit) return; // nothing else may be installed here: see realm.ts
  const P = (name: string): object | undefined => nativePrototype(N, win, name);

  // Getters that hand out a child window or document: the child gets the switch first.
  for (const ctor of ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement']) {
    for (const key of ['contentWindow', 'contentDocument']) {
      wrapAccessor(N, kit, P(ctor), key, { get: { before: (self) => g.child(frameWindow(N, self)) } });
    }
  }

  // Insertion paths: after the native call returns (the child realm exists synchronously). The document to sweep is
  // the inserted node's (a Range method's `this` is no node).
  const afterArgs = (self: unknown, args: ArrayLike<unknown>): void => {
    let frames = false;
    let view: Window | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = arg(args, i);
      if (typeof a !== 'object' || a === null) continue;
      if (g.scan(a)) {
        frames = true;
        view ??= viewOf(N, a);
      }
    }
    if (frames) g.sweep(view ?? viewOf(N, self));
  };
  const afterSelf = (self: unknown): void => g.changed(self);
  const node = P('Node');
  for (const key of ['appendChild', 'insertBefore', 'replaceChild']) wrapMethod(N, kit, node, key, null, afterArgs);
  const element = P('Element');
  for (const key of ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement']) wrapMethod(N, kit, element, key, null, afterArgs);
  wrapMethod(N, kit, element, 'insertAdjacentHTML', null, (self) => {
    let p: unknown = null;
    try {
      p = N.parentNode.call(self);
    } catch {
      p = null;
    }
    g.changed(p ?? self);
  });
  wrapMethod(N, kit, element, 'setHTMLUnsafe', null, afterSelf);
  wrapMethod(N, kit, element, 'attachShadow', null, (_self, _args, root) => {
    if (root && typeof root === 'object') g.observeRoot(root as Node);
  });
  const docFrag = P('DocumentFragment');
  for (const key of ['append', 'prepend', 'replaceChildren']) wrapMethod(N, kit, docFrag, key, null, afterArgs);
  const shadow = P('ShadowRoot');
  wrapMethod(N, kit, shadow, 'setHTMLUnsafe', null, afterSelf);
  const doc = P('Document');
  for (const key of ['append', 'prepend', 'replaceChildren']) wrapMethod(N, kit, doc, key, null, afterArgs);
  for (const key of ['write', 'writeln', 'execCommand']) wrapMethod(N, kit, doc, key, null, afterSelf);
  const range = P('Range');
  for (const key of ['insertNode', 'surroundContents']) wrapMethod(N, kit, range, key, null, afterArgs);
  // innerHTML/outerHTML (outerHTML replaces the element: what changed is its old parent).
  const outerParents: unknown[] = [];
  wrapAccessor(N, kit, element, 'innerHTML', { set: { after: afterSelf } });
  wrapAccessor(N, kit, shadow, 'innerHTML', { set: { after: afterSelf } });
  wrapAccessor(N, kit, element, 'outerHTML', {
    set: {
      before: (self) => {
        let p: unknown = null;
        try {
          p = N.parentNode.call(self);
        } catch {
          p = null;
        }
        outerParents.push(p);
      },
      after: (self) => {
        const p = outerParents.pop();
        g.changed(p ?? self);
      },
    },
  });
  // A srcdoc a script writes later (the property, setAttribute, an Attr, …) reaches the document's observer: its
  // attribute record (a microtask) comes before the browser commits the about:srcdoc navigation (a later task).
}

// ── Ultraviolet realm hardening (WAVE-B3 §11.2 F2, F4, F5) ──────────────────────────────────────────────────────

/** The Cookie Store API globals (F5): Ultraviolet 3.2.10 never virtualizes them, so they reach the shared real jar. */
export const COOKIE_STORE_GLOBALS: readonly string[] = ['cookieStore', 'CookieStore', 'CookieStoreManager'];

export interface UvRealmDeps {
  /** The engine-host document (the tab iframes live in it). */
  hostDocument: Document;
  /** The real URL of the document a window shows (about: documents: their creator's), or null. */
  documentUrl(win: Window): string | null;
  /** The real URL behind a proxied URL (resolved against `base`), or null when it is not an Ultraviolet URL. */
  realUrl(raw: string, base: string): string | null;
}

/** Histories of the hardened realms' windows → their window (a page may call one realm's pushState on another's history). */
const historyWindows = new WeakMap<object, Window>();

/**
 * At an Ultraviolet document's start (before UV's client hooks the window) and in every child realm the guard
 * reaches: (F2) the realm's `frameElement` getter returns null where the native one would hand out an element of the
 * engine-host document (the tab iframe); (F4) the realm's History `pushState`/`replaceState` refuse a URL of another
 * origin than the document's real one with a page-realm SecurityError, as browsers do (UV's own wrapper only rewrites
 * the URL; it wraps GNOME's, so GNOME sees the proxied URL), and refuse proxy-origin URLs that are no Ultraviolet URL
 * (`/engine/?x`, F3's path); (F5) `cookieStore`, `CookieStore`, `CookieStoreManager` and
 * `ServiceWorkerRegistration.prototype.cookies` become data properties holding undefined. Everything installed is
 * made by the kit (rule R1); a realm without a kit gets only the data properties. Idempotent per realm.
 */
export function hardenUvRealm(win: Window, N: Natives, deps: UvRealmDeps, opts: { frameElement: boolean } = { frameElement: true }): void {
  const w = win as AnyWindow;
  try {
    historyWindows.set(N.winHistory.call(win), win);
  } catch {
    /* no history */
  }
  try {
    if (N.getOwnPropertyDescriptor(w, HARDENED)) return;
    N.defineProperty(w, HARDENED, { value: true, enumerable: false, configurable: false, writable: false });
  } catch {
    return;
  }
  // F5: data properties holding primitives only.
  for (const name of COOKIE_STORE_GLOBALS) {
    try {
      N.defineProperty(w, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    } catch {
      /* already non-configurable */
    }
  }
  try {
    const swr = nativePrototype(N, win, 'ServiceWorkerRegistration');
    if (swr) N.defineProperty(swr, 'cookies', { value: undefined, writable: false, configurable: false, enumerable: false });
  } catch {
    /* not there */
  }
  const kit = pageKit(win, N);
  if (!kit) return;
  // F2: frameElement (an own accessor of the Window in both browsers; Window.prototype where a browser has it there).
  // Only in a document's own realm at its start (opts.frameElement), never in the child realms the guard reaches: a
  // frame's initial about:blank Window is reused by its first same-origin document, whose document-start hook
  // (public/engine/uv-doc-hook.js) walks up to the engine host with that realm's frameElement getter (measured: with
  // the wrapper there, nested UV documents were never attached; rows CS10, K3).
  for (const holder of opts.frameElement ? [w as object, nativePrototype(N, win, 'Window')] : []) {
    if (!holder) continue;
    try {
      const d = N.getOwnPropertyDescriptor(holder, 'frameElement');
      if (!d || !d.get || !d.configurable) continue;
      const get = kit.replace(d.get as (...a: never[]) => unknown, (self, _args, box) => {
        box[0] = CALL_ORIGINAL;
        try {
          const fe = N.frameElement.call(self);
          if (fe && N.ownerDocument.call(fe) === deps.hostDocument) {
            box[0] = RETURN;
            box[1] = null;
          }
        } catch {
          /* not a window: the native getter throws its own TypeError */
        }
      });
      N.defineProperty(holder, 'frameElement', { configurable: true, enumerable: d.enumerable, get, set: d.set });
    } catch {
      /* this realm refused */
    }
  }
  // F4: pushState/replaceState to another origin.
  const history = nativePrototype(N, win, 'History');
  for (const key of ['pushState', 'replaceState']) {
    try {
      const d = history ? N.getOwnPropertyDescriptor(history, key) : undefined;
      const original = d && 'value' in d ? (d.value as unknown) : undefined;
      if (!history || !d || typeof original !== 'function' || !d.configurable) continue;
      const wrapped = kit.replace(original as (...a: never[]) => unknown, (self, args, box) => {
        box[0] = CALL_ORIGINAL;
        const raw = arg(args, 2);
        if (raw === undefined || raw === null) return; // no URL: the document's own
        let url: string;
        try {
          url = typeof raw === 'string' ? raw : kit.str(raw);
        } catch (err) {
          box[0] = THROW;
          box[1] = err;
          return;
        }
        try {
          const target = historyWindows.get(self as object) ?? win;
          const base = N.locationHref.call(N.winLocation.call(target));
          const doc = deps.documentUrl(target);
          const next = deps.realUrl(url, base);
          if (doc === null) return; // a document GNOME cannot name: the browser's own rules
          if (next === null || new URL(next).origin !== new URL(doc).origin) {
            box[0] = THROW;
            box[1] = kit.error(`Failed to execute '${key}' on 'History': the URL is not of the same origin as the document`, 'SecurityError');
          }
        } catch {
          /* fail open: the native call decides */
        }
      });
      N.defineProperty(history, key, { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: wrapped });
    } catch {
      /* this realm refused */
    }
  }
}

/**
 * `perRealm` in `win` and, through the child-frame guard, in every same-origin child realm created there (the guard's
 * coverage and limits: see guardChildFrames). Used for Ultraviolet documents, where the WebRTC switch (when on) and
 * hardenUvRealm both apply to each realm.
 */
export function guardRealmsDeep(win: Window, N: Natives, perRealm: (w: Window) => void, srcdocTag: string | null): void {
  perRealm(win);
  guardChildFrames(win, N, (child) => guardRealmsDeep(child, N, perRealm, srcdocTag), srcdocTag);
}

