/**
 * Commits of a tab's top document (ENGINE-PROTOCOL §6.1). With the Navigation API (the tab's top document's
 * `navigation`, read with this realm's getters): `navigate` starts navigations the page makes (cross-document, not a
 * download; its navigationType says push/replace/reload/traverse) and `currententrychange` reports same-document
 * commits with their type. Without it: wrappers of the document's `History.prototype.pushState`/`replaceState`,
 * `popstate` (a traversal) and `hashchange` (a fragment navigation), and `beforeunload` as the start signal of an
 * Ultraviolet navigation (the URL is then known only at the commit).
 */
import type { HistoryHandling } from '../../shared/engine-protocol';
import type { Natives } from '../natives';
import { nativePrototype, pageKit, wrapMethod } from '../realm';

export interface CommitSink {
  /** A real URL from a raw (proxied) one, or null. */
  decode(raw: string): string | null;
  /** The real URL of the document now. */
  currentUrl(): string | null;
  /** The tab's current entry (after the last commit). */
  lastUrl(): string | null;
  /** `raw`: the destination as the frame requests it (the proxied URL), when the Navigation API says it. */
  pageStart(url: string | null, type: 'push' | 'replace' | 'reload' | 'traverse' | undefined, method: string | undefined, raw?: string | null): void;
  sameDocument(url: string, handling: HistoryHandling): void;
  /**
   * WAVE-B3 D5, §4.5: a trusted `navigate` event for a new document, at its dispatch (`raw`: the proxied destination,
   * `cancelled()`: whether the page has cancelled it, read later).
   */
  announce?(url: string | null, raw: string, cancelled: () => boolean): void;
  /** Ultraviolet only: navigations started without the Navigation API are announced by beforeunload. */
  useBeforeUnload: boolean;
}

const NAV_TYPES = new Set(['push', 'replace', 'reload', 'traverse']);

/** Whether a window has the Navigation API (read through this realm's getter). */
export function navigationOf(win: Window, N: Natives): EventTarget | null {
  if (!N.hasNavigationApi) return null;
  try {
    return N.winNavigation.call(win) ?? null;
  } catch {
    return null;
  }
}

export function installCommitObservers(win: Window, N: Natives, sink: CommitSink): 'navigation-api' | 'history-wrappers' {
  const navigation = navigationOf(win, N);
  if (navigation) {
    N.on.call(
      navigation,
      'navigate',
      ((ev: Event) => {
        try {
          // A synthetic event a page dispatched starts nothing (isTrusted is an unforgeable own property).
          if (!ev.isTrusted) return;
          if (N.navDownloadRequest.call(ev) !== null) return; // a download, not a navigation
          const dest = N.navDestination.call(ev);
          if (N.destSameDocument.call(dest)) return; // committed by currententrychange
          const type = N.navNavigationType.call(ev);
          const raw = N.destUrl.call(dest);
          const url = sink.decode(raw);
          const method = N.navFormData.call(ev) ? 'POST' : 'GET';
          sink.pageStart(url, NAV_TYPES.has(type) ? (type as 'push') : undefined, method, raw);
          sink.announce?.(url, raw, () => {
            try {
              return N.defaultPrevented.call(ev);
            } catch {
              return false;
            }
          });
        } catch {
          /* never break the page's navigation */
        }
      }) as (ev: never) => void,
    );
    N.on.call(
      navigation,
      'currententrychange',
      ((ev: Event) => {
        try {
          const type = N.entryChangeType.call(ev);
          const entry = N.navCurrentEntry.call(navigation);
          const raw = entry ? N.entryUrl.call(entry) : null;
          const url = raw ? sink.decode(raw) : sink.currentUrl();
          if (!url) return;
          sink.sameDocument(url, type === 'push' ? 'push' : type === 'traverse' ? 'traverse' : 'replace');
        } catch {
          /* ignore */
        }
      }) as (ev: never) => void,
    );
    return 'navigation-api';
  }
  // Fallback: wrap this document's History methods (on top of the engine's own wrappers, or under them), as
  // callables of the page's realm (realm.ts).
  const kit = pageKit(win, N);
  const proto = nativePrototype(N, win, 'History');
  for (const [key, handling] of [
    ['pushState', 'push'],
    ['replaceState', 'replace'],
  ] as const) {
    if (!kit) break;
    wrapMethod(N, kit, proto, key, null, () => {
      try {
        const url = sink.currentUrl();
        if (url) sink.sameDocument(url, handling);
      } catch {
        /* ignore */
      }
    });
  }
  N.on.call(win, 'popstate', (() => {
    const url = sink.currentUrl();
    if (url) sink.sameDocument(url, 'traverse');
  }) as (ev: never) => void);
  N.on.call(win, 'hashchange', (() => {
    // A fragment link adds an entry; after a popstate traversal the entry is already current.
    const url = sink.currentUrl();
    if (url && url !== sink.lastUrl()) sink.sameDocument(url, 'push');
  }) as (ev: never) => void);
  if (sink.useBeforeUnload) {
    N.on.call(win, 'beforeunload', (() => sink.pageStart(null, undefined, undefined)) as (ev: never) => void);
  }
  return 'history-wrappers';
}

/** PerformanceNavigationTiming.type of a document (reload, back_forward, navigate), read through this realm. */
export function timingType(win: Window, N: Natives): 'navigate' | 'reload' | 'back_forward' | 'prerender' | null {
  try {
    const entries = N.perfGetEntriesByType.call(N.winPerformance.call(win), 'navigation');
    const e = entries[0];
    if (!e) return null;
    const t = N.perfNavType.call(e);
    return t === 'navigate' || t === 'reload' || t === 'back_forward' || t === 'prerender' ? t : null;
  } catch {
    return null;
  }
}
