/**
 * Scramjet 2.0.67-alpha.2 hooks `History.prototype.pushState`/`replaceState` and converts the URL argument with
 * `String()` even when the page passed none, `undefined` or `null`, for which a browser keeps the document's URL (HTML:
 * the URL argument is optional and nullable). The page then moves to `<origin>/undefined` (or `/null`): measured with
 * DuckDuckGo's results page in both browsers (worklist A12: the address bar showed `duckduckgo.com/undefined`;
 * Ultraviolet keeps the URL). GNOME's wrapper, installed at Scramjet's `init.post` (after Scramjet's client hooked
 * the realm, so it is the outermost), passes the document's current real URL in that case, which is what "no URL"
 * means; every other call passes through unchanged. Report upstream: scramjet `History.prototype.pushState` hook.
 */
import type { Natives } from '../natives';
import { CALL_ORIGINAL, arg, nativePrototype, pageKit } from '../realm';
import type { PageKit } from '../realm';

const KEYS = ['pushState', 'replaceState'] as const;

/** Wraps pushState/replaceState of a page realm's History prototype; how many it wrapped. */
export function wrapHistoryUrl(N: Natives, kit: PageKit, proto: object | undefined, currentUrl: () => string | null): number {
  if (!proto) return 0;
  let n = 0;
  for (const key of KEYS) {
    const d = N.getOwnPropertyDescriptor(proto, key);
    const original = d && 'value' in d ? (d.value as unknown) : undefined;
    if (!d || typeof original !== 'function' || !d.configurable) continue;
    const replaced = kit.replace(original as (...a: never[]) => unknown, (_self, args, box) => {
      box[0] = CALL_ORIGINAL;
      const url = arg(args, 2);
      if (url !== undefined && url !== null) return;
      const real = currentUrl();
      if (real === null) return;
      // The page's own arguments array (made by the trap in the page realm): defined, never assigned (no setter runs).
      N.defineProperty(args, 2, { value: real, writable: true, enumerable: true, configurable: true });
    });
    N.defineProperty(proto, key, { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable, value: replaced });
    n++;
  }
  return n;
}

/** The fix in a Scramjet document's realm (tabs.ts, at init.post). */
export function installHistoryUrlFix(win: Window, N: Natives, currentUrl: () => string | null): number {
  const kit = pageKit(win, N);
  if (!kit) return 0;
  return wrapHistoryUrl(N, kit, nativePrototype(N, win, 'History'), currentUrl);
}
