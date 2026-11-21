/**
 * Privacy protection inside proxied documents (WAVE-B3 §6.1, window side): `withPrivacyDocument` adds `onDocument`
 * to the privacy provider. The core calls it for every proxied document it attaches, at any depth, after the engine's
 * client hooked the window (Scramjet `init.post`; Ultraviolet right after its handler, the `__uvHook` point) and
 * before page scripts run.
 *
 * - `navigator.globalPrivacyControl = true` (policy.gpc) and `navigator.doNotTrack = '1'` (policy.dnt): own,
 *   non-writable, configurable data properties of the document's navigator holding primitives (rule R1 allows them
 *   in every realm, also one without a kit); configurable, so nothing collides with an engine's own hooks, and a
 *   page that deletes them only drops its own signal.
 * - `document.referrer` reduced like the `Referer` header (reduceReferrer: the floor and the mode, against the
 *   document's own URL): the value the engine reports is read once with `kit.readString(document, 'referrer')` (page
 *   code reads it, from page frames), reduced, and kept per document; the realm's `Document.prototype.referrer`
 *   getter (the engine's own by then) is wrapped once per realm with `kit.replace`, deciding by the document it is
 *   called on (`RETURN` the reduced value for an attached document; for anything else the reduced value of the
 *   realm's latest attached document, since the engines' getters answer for their realm whatever `this` is), so the
 *   value holds also through `Object.getOwnPropertyDescriptor(Document.prototype, 'referrer')`, from another realm,
 *   or on another document. A realm without a kit gets only the navigator properties.
 *
 * - Ultraviolet also injects the browser's referrer of the document request as the page global `__uv$referrer`
 *   (uv.sw.js `createHtmlInject`: the whole proxied URL of the referring page, which `__uv$config.decodeUrl` turns
 *   into its real URL); its handler never reads or removes it, so for an Ultraviolet document it becomes `''` here
 *   (a data property holding a primitive), and a script cannot read the unreduced referrer there.
 *
 * Workers, `about:blank` children and non-HTML documents get the `Sec-GPC` header but no
 * `navigator.globalPrivacyControl` (no hook runs there): About says so.
 */
import type { DocumentInfo, ProxiedWindow } from '../../shared/engine-hooks';
import type { Natives } from '../../engine-host/natives';
import { CALL_ORIGINAL, RETURN, nativePrototype } from '../../engine-host/realm';
import type { PageKit } from '../../engine-host/realm';
import type { HookProvider, RequestContext } from '../core/compose';
import { reduceReferrer } from './provider';

export interface PrivacyDocumentDeps {
  N: Natives;
  /** The kit built for a proxied window at its document start (x1's cachedKit), or null (then no wrapper). */
  kitOf(win: Window): PageKit | null;
}

type AnyFn = (...args: never[]) => unknown;

/** Ultraviolet's page global with the document request's proxied referrer (see the header). */
const UV_REFERRER_GLOBAL = '__uv$referrer';

/** Per realm (keyed by its Document.prototype): the reduced referrer of the latest document attached there. */
interface RealmReferrer {
  latest: string | null;
}

export function withPrivacyDocument(provider: HookProvider, deps: PrivacyDocumentDeps): HookProvider {
  const { N } = deps;
  /** Attached documents → the referrer they report. */
  const referrers = new WeakMap<object, string>();
  const realms = new WeakMap<object, RealmReferrer>();

  function setNavigatorFlag(nav: object, key: string, value: boolean | string): void {
    try {
      N.defineProperty(nav, key, { value, writable: false, enumerable: true, configurable: true });
    } catch {
      /* a non-configurable own property (the page cannot have made one before document start): leave it */
    }
  }

  function wrapReferrer(win: Window, kit: PageKit, realm: RealmReferrer): void {
    const proto = nativePrototype(N, win, 'Document');
    if (!proto) return;
    const d = N.getOwnPropertyDescriptor(proto, 'referrer');
    if (!d || !d.configurable || typeof d.get !== 'function') return;
    const get = kit.replace(d.get as AnyFn, (self, _args, box) => {
      const own = typeof self === 'object' && self !== null ? referrers.get(self) : undefined;
      const v = own ?? realm.latest;
      if (v === null) {
        box[0] = CALL_ORIGINAL;
        return;
      }
      box[0] = RETURN;
      box[1] = v;
    });
    N.defineProperty(proto, 'referrer', { configurable: true, enumerable: d.enumerable, get, ...(d.set ? { set: d.set } : {}) });
  }

  /** An Ultraviolet document: its injected referrer becomes '' (only a data property holding a non-empty string). */
  function clearUvReferrer(win: Window): void {
    try {
      const d = N.getOwnPropertyDescriptor(win, UV_REFERRER_GLOBAL);
      if (!d || !('value' in d) || typeof d.value !== 'string' || d.value === '' || !d.configurable) return;
      N.defineProperty(win, UV_REFERRER_GLOBAL, { value: '', writable: d.writable, enumerable: d.enumerable, configurable: true });
    } catch {
      /* the realm is gone */
    }
  }

  function install(win: Window, doc: DocumentInfo, ctx: RequestContext): void {
    const p = ctx.policy;
    if (doc.engine === 'ultraviolet') clearUvReferrer(win);
    if (p.gpc || p.dnt) {
      let nav: object | null = null;
      try {
        nav = N.winNavigator.call(win);
      } catch {
        nav = null;
      }
      if (nav) {
        if (p.gpc) setNavigatorFlag(nav, 'globalPrivacyControl', true);
        if (p.dnt) setNavigatorFlag(nav, 'doNotTrack', '1');
      }
    }
    const kit = deps.kitOf(win);
    if (!kit) return;
    let document: Document;
    try {
      document = N.winDocument.call(win);
    } catch {
      return;
    }
    const reported = kit.readString(document, 'referrer');
    const reduced = reduceReferrer(reported === null || reported === '' ? null : reported, doc.url, p.referrer) ?? '';
    referrers.set(document, reduced);
    const proto = nativePrototype(N, win, 'Document');
    if (!proto) return;
    let realm = realms.get(proto);
    if (!realm) {
      realm = { latest: reduced };
      realms.set(proto, realm);
      wrapReferrer(win, kit, realm);
    } else {
      realm.latest = reduced;
    }
  }

  return {
    ...provider,
    onDocument(win: ProxiedWindow, doc: DocumentInfo, ctx: RequestContext): void {
      provider.onDocument?.(win, doc, ctx);
      install(win as Window, doc, ctx);
    },
  };
}
