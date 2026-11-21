/**
 * The cookie manager inside proxied documents (WAVE-B3 §6.1, window side): `withCookieDocument` adds `onDocument` to
 * the cookie provider, for every proxied document the core attaches (after the engine's client hooked the window:
 * Scramjet `init.post`, Ultraviolet's `__uvHook` point; before page scripts).
 *
 * Whether the document's own cookies are blocked (its URL against `cookieRuleFor`, `cookiesBlocked` with the party of
 * the document against its tab's top-level page, D4) is kept per document, and the realm's `Document.prototype.cookie`
 * accessor (the engine's own hook by then: Scramjet's trap, or Ultraviolet's after its client) is wrapped once per
 * realm with `kit.replace` for `get` and `set`, deciding by the document it is called on AND by the realm the accessor
 * belongs to: both engines' accessors answer for their own realm's document whatever `this` is (Scramjet 2.0.67-alpha.2
 * `Document.prototype.cookie` trap: `cookieJar.getCookies(client.url)` / `setCookies(value, client.url)`; Ultraviolet
 * 3.2.10: the realm's cookie string and `meta`), so a call is judged by the realm's latest attached document and,
 * when GNOME attached it too, by the document passed as `this`:
 * - either blocked → `RETURN ''` / `RETURN undefined` (the write is ignored);
 * - else `CALL_ORIGINAL`, except a write a browser would refuse from script, which is ignored: a cookie for a
 *   `Domain` the host (of the realm's document, and of `this`) does not belong to or that is a public suffix, a
 *   `__Secure-`/`__Host-` name without its requirements, `Secure` from an insecure URL, `HttpOnly` (scripts cannot
 *   set HttpOnly cookies), and a value that is not a string primitive (converting it would run page code twice: the
 *   engine converts again).
 * So a fake `this` cannot reach the jar of a blocked frame, and neither can a blocked frame that passes an attached
 * first-party document (`getter.call(parent.document)`: the engine still reads the frame's own cookies). A realm
 * with no attached document is never wrapped (fail open). Every attached realm's prototype is wrapped, so a tracker in
 * a blocked frame gets nothing through `Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')` either, in its
 * own realm or another's (rows K3/K3b, both engines and browsers).
 *
 * Ultraviolet also injects a document's script-visible cookies as the page global `__uv$cookies` (uv.sw.js
 * `createHtmlInject`), which its handler reads once at start and never removes: for a blocked document that string is
 * replaced by `''` here (a data property holding a primitive, rule R1), so a script there cannot read the blocked
 * cookies past the wrapped accessor. `about:blank` children a page creates are realms GNOME never attaches (no hook
 * runs there): see the lane report.
 */
import type { DocumentInfo, ProxiedWindow } from '../../shared/engine-hooks';
import type { Natives } from '../../engine-host/natives';
import { CALL_ORIGINAL, RETURN, arg, nativePrototype } from '../../engine-host/realm';
import type { PageKit } from '../../engine-host/realm';
import type { HookProvider, RequestContext } from '../core/compose';
import { cookieRuleFor, cookiesBlocked } from '../core/policy';
import { setCookieAcceptable } from './provider';

export interface CookieDocumentDeps {
  N: Natives;
  /** The kit built for a proxied window at its document start (x1's cachedKit), or null (then nothing is wrapped). */
  kitOf(win: Window): PageKit | null;
}

type AnyFn = (...args: never[]) => unknown;

interface DocState {
  blocked: boolean;
  url: string;
}

/** Whether `document.cookie = line` from a document at `url` would be stored by a browser. */
export function scriptCookieAcceptable(line: string, url: string): boolean {
  const attrs = line.split(';').slice(1).map((a) => a.split('=')[0]?.trim().toLowerCase());
  if (attrs.includes('httponly')) return false;
  return setCookieAcceptable(line, url);
}

/** Ultraviolet's page global with the document's script-visible cookies (see the header). */
const UV_COOKIES_GLOBAL = '__uv$cookies';

export function withCookieDocument(provider: HookProvider, deps: CookieDocumentDeps): HookProvider {
  const { N } = deps;
  const states = new WeakMap<object, DocState>();
  /** Per realm (its Document.prototype): the state of the latest document attached there. */
  const realms = new WeakMap<object, { latest: DocState }>();

  /**
   * What a call decides by: the realm's latest attached document (whose cookies the engine's accessor reads and
   * writes, whatever `this` is) and, when GNOME attached it, the document the accessor is called on.
   */
  const statesFor = (self: unknown, realm: { latest: DocState }): readonly DocState[] => {
    const own = typeof self === 'object' && self !== null ? states.get(self) : undefined;
    return own === undefined || own === realm.latest ? [realm.latest] : [realm.latest, own];
  };

  function wrap(proto: object, kit: PageKit, realm: { latest: DocState }): void {
    const d = N.getOwnPropertyDescriptor(proto, 'cookie');
    if (!d || !d.configurable || typeof d.get !== 'function' || typeof d.set !== 'function') return;
    const get = kit.replace(d.get as AnyFn, (self, _args, box) => {
      if (statesFor(self, realm).some((s) => s.blocked)) {
        box[0] = RETURN;
        box[1] = '';
      } else box[0] = CALL_ORIGINAL;
    });
    const set = kit.replace(d.set as AnyFn, (self, args, box) => {
      const ss = statesFor(self, realm);
      const v = arg(args, 0);
      if (typeof v !== 'string' || ss.some((s) => s.blocked || !scriptCookieAcceptable(v, s.url))) {
        box[0] = RETURN;
        box[1] = undefined;
      } else box[0] = CALL_ORIGINAL;
    });
    N.defineProperty(proto, 'cookie', { configurable: true, enumerable: d.enumerable, get, set });
  }

  /** A blocked Ultraviolet document: its injected cookie string becomes '' (only a data property holding a string). */
  function clearUvCookies(win: Window): void {
    try {
      const d = N.getOwnPropertyDescriptor(win, UV_COOKIES_GLOBAL);
      if (!d || !('value' in d) || typeof d.value !== 'string' || d.value === '' || !d.configurable) return;
      N.defineProperty(win, UV_COOKIES_GLOBAL, { value: '', writable: d.writable, enumerable: d.enumerable, configurable: true });
    } catch {
      /* the realm is gone */
    }
  }

  function install(win: Window, doc: DocumentInfo, ctx: RequestContext): void {
    const blocked = cookiesBlocked(ctx.policy, cookieRuleFor(ctx.settings, doc.url), ctx.thirdParty);
    if (blocked && doc.engine === 'ultraviolet') clearUvCookies(win);
    const kit = deps.kitOf(win);
    if (!kit) return;
    let document: Document;
    try {
      document = N.winDocument.call(win);
    } catch {
      return;
    }
    const state: DocState = { blocked, url: doc.url };
    states.set(document, state);
    const proto = nativePrototype(N, win, 'Document');
    if (!proto) return;
    const realm = realms.get(proto);
    if (realm) {
      realm.latest = state;
      return;
    }
    const fresh = { latest: state };
    realms.set(proto, fresh);
    wrap(proto, kit, fresh);
  }

  return {
    ...provider,
    onDocument(win: ProxiedWindow, doc: DocumentInfo, ctx: RequestContext): void {
      provider.onDocument?.(win, doc, ctx);
      install(win as Window, doc, ctx);
    },
  };
}
