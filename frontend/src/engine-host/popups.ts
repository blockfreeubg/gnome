/**
 * Popups and new tabs (ENGINE-PROTOCOL §6.3): `tab.openRequest` is the only way a proxied page opens anything. The
 * engine iframe has no `allow-popups`, so the browser opens nothing itself; in every proxied document the engine host
 * routes `window.open`, links and `<area>`s with a new-window target, middle/Ctrl/Cmd/Shift-clicks and GET forms with
 * such a target to the app, which decides (site-rules.ts decideOpen). POST forms with such a target are submitted in
 * the same tab. `window.close()` of a tab's top document becomes `tab.closeRequest`. `target=_top` / `_parent` from
 * the tab's top document navigate the tab itself (the browser would refuse them in the sandbox, or would navigate the
 * engine host).
 *
 * The pure decisions come first (unit-tested); installPopupRouting() wires them into a proxied window.
 */
import type { OpenDisposition } from '../shared/engine-protocol';
import type { Natives } from './natives';
import { CALL_ORIGINAL, RETURN, THROW, arg, nativePrototype, pageKit } from './realm';
import type { Decide, PageKit } from './realm';

// ── Pure decisions ───────────────────────────────────────────────────────────────────────────────────────────────

/** HTML "tokenize the features argument" (simplified: lower-case names, separators are whitespace, ",", "="). */
export function tokenizeFeatures(features: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = features;
  let i = 0;
  const isSep = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === '=' || c === ',';
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
  while (i < s.length) {
    while (i < s.length && isSep(s[i] ?? '')) i++;
    let name = '';
    while (i < s.length && !isSep(s[i] ?? '')) name += s[i++];
    name = name.toLowerCase();
    while (i < s.length && isWs(s[i] ?? '')) i++;
    let value = '';
    if (i < s.length && (s[i] === '=' || s[i] === ',')) {
      if (s[i] === '=') {
        i++;
        while (i < s.length && isSep(s[i] ?? '') && s[i] !== ',') i++;
        while (i < s.length && !isSep(s[i] ?? '')) value += s[i++];
      }
    }
    if (name) out.set(name, value);
  }
  return out;
}

/** HTML "parse a boolean feature". */
function featureBool(value: string): boolean {
  if (value === '') return true;
  const v = value.toLowerCase();
  if (v === 'yes' || v === 'true') return true;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n !== 0 : false;
}

/** HTML "check if a popup window is requested" for window.open's features argument. */
export function isPopupRequested(features: string): boolean {
  const t = tokenizeFeatures(features);
  if (t.size === 0) return false;
  const popup = t.get('popup');
  if (popup !== undefined) return featureBool(popup);
  const set = (name: string, dflt: boolean): boolean => {
    const v = t.get(name);
    return v === undefined ? dflt : featureBool(v);
  };
  if (!set('location', false) && !set('toolbar', false)) return true;
  if (!set('menubar', false)) return true;
  if (!set('resizable', true)) return true;
  if (!set('scrollbars', false)) return true;
  if (!set('status', false)) return true;
  return false;
}

/** Where a link, form or window.open target points from a proxied document. */
export type TargetKind = 'self' | 'tab-top' | 'parent' | 'frame' | 'new';

/**
 * `_self`/'' → self; `_top` (and `_unfencedTop`, which is `_top` outside a fenced frame) → the tab's top document;
 * `_parent` → the parent document; from the tab's top document both are the tab itself (its parent is the engine
 * host); a name of a frame in the tab → that frame; `_blank` and any other name → a new tab.
 */
export function classifyTarget(target: string, frameNames: ReadonlySet<string>, isTabTop: boolean): TargetKind {
  const t = target.trim();
  const lower = t.toLowerCase();
  if (lower === '' || lower === '_self') return 'self';
  if (lower === '_top' || lower === '_unfencedtop') return isTabTop ? 'self' : 'tab-top';
  if (lower === '_parent') return isTabTop ? 'self' : 'parent';
  if (lower === '_blank') return 'new';
  return frameNames.has(t) ? 'frame' : 'new';
}

/** What the router does about a link or form submission that stays in the tab. */
export type RouteAction = 'native' | 'retarget-self' | 'navigate';

/**
 * Whether the browser's own default action gets a target right. Every proxied document inherits the engine iframe's
 * sandbox, in which a frame may navigate only itself and its descendants (no `allow-top-navigation*`, and the
 * sandboxed navigation flag forbids ancestors and other frames: measured in both browsers, where such links and
 * forms did nothing at all). `nativeTarget` is the target the browser will use (the attribute as the engine left
 * it), `pageTarget` the one the page wrote (Scramjet keeps it in `scramjet-attr-target`).
 * - `native`: the default action is right (the frame itself, or a named descendant frame);
 * - `retarget-self`: the page means this frame but the browser would use `_top`/`_parent`: the element's target
 *   becomes `_self` for this activation, so the browser's own navigation (referrer, `rel`, method, body) is kept;
 * - `navigate`: another frame of the tab (its top document, the parent, a named frame that is not a descendant):
 *   the engine host navigates it.
 */
export function routeAction(kind: Exclude<TargetKind, 'new'>, nativeTarget: string, pageTarget: string, frameIsDescendant: boolean): RouteAction {
  if (kind === 'self') {
    const t = nativeTarget.trim().toLowerCase();
    return t === '' || t === '_self' ? 'native' : 'retarget-self';
  }
  if (kind === 'frame') return frameIsDescendant && nativeTarget.trim() === pageTarget.trim() ? 'native' : 'navigate';
  return 'navigate';
}

export interface ClickInfo {
  /** MouseEvent.button: 0 primary, 1 middle. */
  button: number;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  apple: boolean;
}

/**
 * The disposition of a link activation, or null when it stays in the tab: middle-click and Ctrl+click (Cmd+click on
 * Apple) open a background tab, Shift+click a foreground one (a new window in browsers), a new-window target a
 * foreground tab. Alt+click (download in some browsers) is left alone.
 */
export function linkDisposition(click: ClickInfo, target: TargetKind): OpenDisposition | null {
  if (click.button > 1 || click.alt) return null;
  if (click.button === 1) return 'background';
  if (click.apple ? click.meta : click.ctrl) return 'background';
  if (click.shift) return 'foreground';
  return target === 'new' ? 'foreground' : null;
}

/** The URL a GET form submits to: its action with the query replaced by the form's entries (files by name). */
export function getSubmissionUrl(action: string, entries: Iterable<[string, string]>): string | null {
  let u: URL;
  try {
    u = new URL(action);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const q = new URLSearchParams();
  for (const [k, v] of entries) q.append(k, v);
  u.search = q.toString();
  return u.href;
}

/** A window.open URL that opens nothing: empty or about:blank (ENGINE-PROTOCOL §6.3). */
export function opensNothing(url: string): boolean {
  const t = url.trim().toLowerCase();
  return t === '' || t === 'about:blank' || t.startsWith('about:blank#') || t.startsWith('about:blank?');
}

// ── Wiring into a proxied window ─────────────────────────────────────────────────────────────────────────────────

export interface PopupSink {
  /** The real URL behind a URL the page or its engine produced (relative ones against `base`), or null. */
  realUrl(raw: string, base: string): string | null;
  /** The real URL of the document of `win`. */
  documentUrl(win: Window): string | null;
  /** Names of the frames in the tab (link targets that stay in the tab). */
  frameNames(): ReadonlySet<string>;
  /** The window of the tab's frame with this name (the first in tree order), or null. */
  frameWindow(name: string): Window | null;
  /** The tab's top window. */
  tabTop(): Window | null;
  open(url: string, disposition: OpenDisposition, userActivation: boolean): void;
  /** An `<a download>` of a proxied URL (`name`: the download attribute): the engine host downloads it itself. */
  download(proxiedUrl: string, realUrl: string, name: string): void;
  close(): void;
  /** Navigates a window of the tab to a real URL through the tab's engine (the engine host is its initiator). */
  navigate(target: Window, realUrl: string): void;
  apple(): boolean;
}

interface Pending {
  done: boolean;
  act: () => void;
}

/** Windows inside a withPageAssignments() run (depth, so nested runs work). */
const assigning = new WeakMap<object, number>();

/**
 * WAVE-B3 §3.3 (x2's scriptlet runner): while `run` executes, an assignment to `window.open` or `window.close` of
 * `win` (uBO's `prevent-window-open`/`nowoif` wraps `open` by assignment) is kept: the getter then returns the
 * assigned page-realm value, which calls GNOME's own function when it lets a popup through (it read that function
 * through the getter before assigning). Outside `run`, assignments are discarded as before, so Ultraviolet's own
 * wrapper stays behind GNOME's.
 */
export function withPageAssignments(win: Window, run: () => void): void {
  assigning.set(win, (assigning.get(win) ?? 0) + 1);
  try {
    run();
  } finally {
    const n = (assigning.get(win) ?? 1) - 1;
    if (n > 0) assigning.set(win, n);
    else assigning.delete(win);
  }
}

/**
 * Installs the popup routing in a proxied window (`isTabTop`: the tab's top document). What the page can call
 * (`window.open`, `window.close`, `HTMLFormElement.prototype.submit`) becomes a callable of the page's own realm
 * (realm.ts); the listeners read the page's events and elements only through this realm's natives.
 */
export function installPopupRouting(win: Window, N: Natives, sink: PopupSink, isTabTop: boolean): void {
  const kit: PageKit | null = pageKit(win, N);
  const activation = (): boolean => {
    try {
      const ua = N.navUserActivation.call(N.winNavigator.call(win));
      return ua ? N.uaIsActive.call(ua) : false;
    } catch {
      return false;
    }
  };
  const base = (): string => sink.documentUrl(win) ?? '';
  const proxiedBase = (): string => {
    try {
      return N.locationHref.call(N.winLocation.call(win));
    } catch {
      return location.href;
    }
  };
  const parentOf = (w: Window): Window | null => {
    try {
      const fe = N.frameElement.call(w);
      const doc = fe ? N.ownerDocument.call(fe) : null;
      return doc ? N.defaultView.call(doc) : null;
    } catch {
      return null;
    }
  };
  const isDescendant = (child: Window, ancestor: Window): boolean => {
    let w: Window | null = child;
    for (let i = 0; i < 32 && w; i++) {
      if (w === ancestor) return true;
      w = parentOf(w);
    }
    return false;
  };
  /** The window a kind of target names (null for `self`/`new`, or when the frame is gone). */
  const targetWindow = (kind: TargetKind, name: string): Window | null =>
    kind === 'tab-top' ? sink.tabTop() : kind === 'parent' ? parentOf(win) : kind === 'frame' ? sink.frameWindow(name.trim()) : null;

  // The target the page wrote: Scramjet replaces `_top`/`_parent` of links and <base> with its own frame names (empty
  // for GNOME's tab frames) and keeps the page's value in `scramjet-attr-target`; forms keep theirs.
  const pageAttr = (el: Element, attr: string): string | null => {
    if (attr === 'target') {
      const sj = N.getAttribute.call(el, 'scramjet-attr-target');
      if (sj !== null) return sj;
    }
    return N.getAttribute.call(el, attr);
  };
  // HTML "get an element's target": the element's own attribute, else the first <base target> of its document.
  const baseTarget = (doc: Document | null, page: boolean): string => {
    try {
      const b = doc ? N.querySelector.call(doc, 'base[target]') : null;
      return (b ? (page ? pageAttr(b, 'target') : N.getAttribute.call(b, 'target')) : null) ?? '';
    } catch {
      return '';
    }
  };
  const targetsOf = (el: Element, attr: 'target' | 'formtarget'): { page: string; native: string } => {
    if (N.hasAttribute.call(el, attr) || (attr === 'target' && N.hasAttribute.call(el, 'scramjet-attr-target'))) {
      return { page: pageAttr(el, attr) ?? '', native: N.getAttribute.call(el, attr) ?? '' };
    }
    const doc = N.ownerDocument.call(el);
    return { page: baseTarget(doc, true), native: baseTarget(doc, false) };
  };
  /** Sets an attribute for the current activation only (put back after this task, when the browser has read it). */
  const retarget = (el: Element, attr: string): void => {
    const old = N.getAttribute.call(el, attr);
    N.setAttribute.call(el, attr, '_self');
    N.setTimeout(() => {
      try {
        if (old === null) N.removeAttribute.call(el, attr);
        else N.setAttribute.call(el, attr, old);
      } catch {
        /* gone */
      }
    }, 0);
  };
  const go = (target: Window | null, real: string): void => {
    if (!target) return;
    try {
      sink.navigate(target, real);
    } catch {
      /* the navigation was refused */
    }
  };

  // window.open → openRequest, always null to the page (the engines may wrap this function; it decodes their URLs).
  // The arguments become strings in the page realm (kit.str), so a page-made toString runs in page frames only.
  const openDecide: Decide = (_self, args, box) => {
    box[0] = RETURN;
    box[1] = null;
    if (!kit) return;
    const s = (v: unknown, dflt: string): string => (v === undefined || v === null ? dflt : typeof v === 'string' ? v : kit.str(v));
    let raw: string;
    let name: string;
    let features: string;
    try {
      raw = s(arg(args, 0), '');
      name = s(arg(args, 1), '_blank');
      features = s(arg(args, 2), '');
    } catch (err) {
      box[0] = THROW; // what the page's own conversion threw
      box[1] = err;
      return;
    }
    try {
      if (opensNothing(raw)) return;
      const kind = classifyTarget(name, sink.frameNames(), isTabTop);
      const real = sink.realUrl(raw, base());
      if (!real) return;
      if (kind !== 'new') {
        // _self stays in this window; _top, _parent and frame names navigate that frame of the tab.
        go(kind === 'self' ? win : targetWindow(kind, name), real);
        return;
      }
      sink.open(real, isPopupRequested(features) ? 'popup' : 'foreground', activation());
    } catch {
      /* never break the page's call */
    }
  };
  // An accessor that keeps returning this function: Ultraviolet 3.2.10 wraps window.open by assignment and calls the
  // wrapped function with the URL only (target and features dropped), so its wrapper is stored and never used. The
  // getter, the setter and the value are page-realm callables.
  const keep = (key: string, decide: Decide): void => {
    if (!kit) return;
    try {
      const d = N.getOwnPropertyDescriptor(win, key);
      const original = d && 'value' in d && typeof d.value === 'function' ? (d.value as (...a: never[]) => unknown) : null;
      const value = original ? kit.replace(original, decide) : kit.fn(decide);
      // What a scriptlet assigned inside withPageAssignments (a page value; GNOME never reads or calls it itself).
      let assigned: { v: unknown } | null = null;
      N.defineProperty(win, key, {
        configurable: true,
        enumerable: true,
        get: kit.fn((_s, _a, box) => {
          box[0] = RETURN;
          box[1] = assigned ? assigned.v : value;
        }),
        set: kit.fn((_s, args, box) => {
          box[0] = RETURN; // outside a scriptlet run (an engine's wrapper): this function stays in front
          box[1] = undefined;
          if ((assigning.get(win) ?? 0) > 0) assigned = { v: arg(args, 0) };
        }),
      });
    } catch {
      /* non-configurable: leave the native one (the sandbox opens nothing) */
    }
  };
  keep('open', openDecide);
  if (isTabTop) {
    keep('close', (_self, _args, box) => {
      box[0] = RETURN;
      box[1] = undefined;
      try {
        sink.close();
      } catch {
        /* ignore */
      }
    });
  }

  // Links: decide in the capture phase, act after the page's own listeners (bubble phase on the window) unless the page
  // cancelled the click; if the page stopped propagation, act after the dispatch (the browser's default did nothing
  // in the sandbox).
  const pending = new WeakMap<Event, Pending>();
  const later = (ev: Event, act: () => void): void => {
    pending.set(ev, { done: false, act });
    N.setTimeout(() => {
      const p = pending.get(ev);
      if (p && !p.done && !N.defaultPrevented.call(ev)) {
        p.done = true;
        p.act();
      }
    }, 0);
  };
  const decideLink = (ev: Event): void => {
    let el: Element | null = null;
    try {
      const path = N.composedPath.call(ev);
      for (let i = 0; i < path.length; i++) {
        const t = path[i];
        if (N.nodeType.call(t) !== 1) continue;
        const name = N.localName.call(t);
        if ((name === 'a' || name === 'area') && N.hasAttribute.call(t, 'href')) {
          el = t as Element;
          break;
        }
      }
    } catch {
      return;
    }
    if (!el) return;
    const isArea = N.localName.call(el) === 'area';
    const href = isArea ? N.areaHref.call(el) : N.anchorHref.call(el);
    if (N.hasAttribute.call(el, 'download')) {
      // A download stays a download, but its request must go through the tab's engine (see PopupSink.download).
      // blob: and data: links a page builds itself need no network: the browser handles them.
      if (N.button.call(ev) !== 0 || N.eventType.call(ev) !== 'click') return;
      const real = sink.realUrl(href, proxiedBase());
      if (!real) return;
      const name = (isArea ? N.getAttribute.call(el, 'download') : N.anchorDownload.call(el)) ?? '';
      later(ev, () => sink.download(href, real, name));
      return;
    }
    const t = targetsOf(el, 'target');
    const kind = classifyTarget(t.page, sink.frameNames(), isTabTop);
    const click: ClickInfo = {
      button: N.button.call(ev),
      ctrl: N.mouseCtrl.call(ev),
      meta: N.mouseMeta.call(ev),
      shift: N.mouseShift.call(ev),
      alt: N.mouseAlt.call(ev),
      apple: sink.apple(),
    };
    const disposition = linkDisposition(click, kind);
    if (disposition !== null) {
      const real = sink.realUrl(href, proxiedBase());
      if (!real) return;
      const userActivation = activation();
      later(ev, () => sink.open(real, disposition, userActivation));
      return;
    }
    if (kind === 'new') return;
    const target = targetWindow(kind, t.page);
    const action = routeAction(kind, t.native, t.page, target !== null && isDescendant(target, win));
    if (action === 'native') return;
    if (action === 'retarget-self') {
      retarget(el, 'target');
      return;
    }
    const real = sink.realUrl(href, proxiedBase());
    if (!real || !target) return;
    later(ev, () => go(target, real));
  };
  const actLink = (ev: Event): void => {
    const p = pending.get(ev);
    if (!p || p.done) return;
    p.done = true;
    if (N.defaultPrevented.call(ev)) return;
    N.preventDefault.call(ev);
    p.act();
  };
  for (const type of ['click', 'auxclick']) {
    N.on.call(win, type, decideLink as (ev: never) => void, true);
    N.on.call(win, type, actLink as (ev: never) => void, false);
  }

  /**
   * A form submission (the `submit` event, or `form.submit()`, which fires none): a new-window target opens a tab
   * for GET and submits POST here (a POST cannot be reproduced in another tab); `_top`/`_parent`/frame names the
   * sandbox would refuse submit in that frame of the tab (GET: its URL, POST: the same entries replayed there). `act`
   * runs it now (form.submit()) or after the page's listeners (the event). Returns whether the router submitted it
   * itself (the browser's own submission must not run).
   */
  const routeForm = (form: Element, submitter: Element | null, act: (fn: () => void) => void): boolean => {
    if (N.localName.call(form) !== 'form') return false;
    const sName = submitter ? N.localName.call(submitter) : '';
    const button = submitter !== null && (sName === 'button' || sName === 'input');
    const subAttr = (attr: string): string | null => (button && submitter && N.hasAttribute.call(submitter, attr) ? N.getAttribute.call(submitter, attr) : null);
    const t = button && submitter && N.hasAttribute.call(submitter, 'formtarget') ? targetsOf(submitter, 'formtarget') : targetsOf(form, 'target');
    const kind = classifyTarget(t.page, sink.frameNames(), isTabTop);
    const subMethod = subAttr('formmethod') !== null ? (sName === 'button' ? N.buttonFormMethod.call(submitter) : N.inputFormMethod.call(submitter)) : null;
    const method = (subMethod ?? N.formMethod.call(form)).toLowerCase();
    if (method === 'dialog') return false;
    const retargetForm = (): void => {
      if (button && submitter && N.hasAttribute.call(submitter, 'formtarget')) retarget(submitter, 'formtarget');
      retarget(form, 'target');
    };
    const proxiedAction = (): string =>
      subAttr('formaction') !== null ? (sName === 'button' ? N.buttonFormAction.call(submitter) : N.inputFormAction.call(submitter)) : N.formAction.call(form);
    // The entry list from the page realm's FormData, serialized there (realm.ts): no page object reaches this realm.
    const entries = (): { entries: Array<[string, string]>; files: number } | null => {
      try {
        return kit ? kit.formEntries(form, button ? submitter : null) : null;
      } catch {
        return null;
      }
    };
    const getUrl = (): string | null => {
      const action = sink.realUrl(proxiedAction(), proxiedBase());
      const list = action ? entries() : null;
      return action && list ? getSubmissionUrl(action, list.entries) : null;
    };
    if (kind === 'new') {
      if (method !== 'get') {
        // A POST cannot be reproduced in another tab: submit it here.
        retargetForm();
        return false;
      }
      const url = getUrl();
      if (!url) return false;
      const userActivation = activation();
      act(() => sink.open(url, 'foreground', userActivation));
      return true;
    }
    const target = targetWindow(kind, t.page);
    const action = routeAction(kind, t.native, t.page, target !== null && isDescendant(target, win));
    if (action === 'native') return false;
    if (action === 'retarget-self' || !target) {
      retargetForm();
      return false;
    }
    if (method === 'get') {
      const url = getUrl();
      if (!url) return false;
      act(() => go(target, url));
      return true;
    }
    const enctype = subAttr('formenctype') !== null ? (sName === 'button' ? N.buttonFormEnctype.call(submitter) : N.inputFormEnctype.call(submitter)) : N.formEnctype.call(form);
    const list = entries();
    const proxied = proxiedAction();
    const charset = N.getAttribute.call(form, 'accept-charset');
    act(() => {
      // Files cannot be handed to another frame's form without an engine-host FileList: submit those here.
      if (list && list.files === 0 && replayPost(N, target, proxied, enctype, charset, list.entries)) return;
      // The target frame went away: submit in this frame rather than lose the submission.
      retargetForm();
      try {
        N.formSubmit.call(form);
      } catch {
        /* the form is gone too */
      }
    });
    return true;
  };

  N.on.call(
    win,
    'submit',
    ((ev: Event) => {
      try {
        const form = N.eventTarget.call(ev) as Element | null;
        if (!form) return;
        routeForm(form, N.submitter.call(ev) as Element | null, (fn) => later(ev, fn));
      } catch {
        /* a form we cannot read: the browser's own submission goes ahead */
      }
    }) as (ev: never) => void,
    true,
  );
  N.on.call(win, 'submit', actLink as (ev: never) => void, false);

  // form.submit() fires no submit event: route it the same way, at once (a page-realm callable; the original runs
  // from the page realm when the router leaves the submission to the browser).
  if (!kit) return;
  try {
    const proto = nativePrototype(N, win, 'HTMLFormElement');
    const d = proto ? N.getOwnPropertyDescriptor(proto, 'submit') : undefined;
    const original = d && 'value' in d ? (d.value as unknown) : undefined;
    if (proto && d && typeof original === 'function' && d.configurable) {
      const submit = kit.replace(original as (...a: never[]) => unknown, (self, _args, box) => {
        let handled = false;
        try {
          handled = typeof self === 'object' && self !== null && routeForm(self as Element, null, (fn) => fn());
        } catch {
          handled = false;
        }
        box[0] = handled ? RETURN : CALL_ORIGINAL;
        box[1] = undefined;
      });
      N.defineProperty(proto, 'submit', { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: submit });
    }
  } catch {
    /* this realm refused: programmatic submissions keep the browser's behaviour */
  }
}

/**
 * Submits a POST in another frame of the tab: a hidden form with the same entries (files included) in `target`'s
 * document, submitted there, so the request goes through that frame's engine like the page's own submission would.
 */
function replayPost(N: Natives, target: Window, proxiedAction: string, enctype: string, charset: string | null, entries: Array<[string, string]>): boolean {
  try {
    const doc = N.winDocument.call(target);
    const f = N.createElement.call(doc, 'form');
    N.setAttribute.call(f, 'method', 'post');
    N.setAttribute.call(f, 'action', proxiedAction);
    N.setAttribute.call(f, 'enctype', enctype);
    if (charset) N.setAttribute.call(f, 'accept-charset', charset);
    N.setAttribute.call(f, 'target', '_self');
    N.setAttribute.call(f, 'style', 'display:none');
    for (const [name, value] of entries) {
      const input = N.createElement.call(doc, 'input');
      N.setAttribute.call(input, 'name', name);
      N.setAttribute.call(input, 'type', 'hidden');
      N.setAttribute.call(input, 'value', value);
      N.appendChild.call(f, input);
    }
    const parent = N.docBody.call(doc) ?? N.docElement.call(doc);
    if (!parent) return false;
    N.appendChild.call(parent, f);
    N.formSubmit.call(f);
    N.setTimeout(() => {
      try {
        const p = N.parentNode.call(f);
        if (p) N.removeChild.call(p, f);
      } catch {
        /* gone with its document */
      }
    }, 0);
    return true;
  } catch {
    return false;
  }
}
