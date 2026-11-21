/**
 * Which Scramjet document requests are navigations of the TAB frame (ENGINE-PROTOCOL §6.1). Scramjet 2.0.67-alpha.2
 * marks a nested iframe's request with `$iframe=1` only on its first load: a nested frame that navigates itself (a
 * link, `location`, a form, a meta refresh inside the iframe) and every redirect hop of a nested load reach the
 * per-tab plugin exactly like a navigation of the tab frame (destination `iframe`, no `$iframe`; measured in both
 * browsers). Taken as the tab's, such a request started a navigation the tab never made: `tab.loading` without a
 * commit, then after TIMEOUTS.navigationMs the controlled fallback loaded the nested frame's URL as the whole tab on
 * Ultraviolet, and a redirecting iframe added a duplicate back/forward entry.
 *
 * So a tab-shaped request counts as the tab frame's own only when the engine host expected it: the URL of a
 * GNOME-initiated load, the destination of the tab's top document's Navigation API `navigate` event (also for
 * traversals of the browser's own Back/Forward), the Location of the previous hop's redirect, the first request
 * after the top document's `beforeunload` where the Navigation API is missing, or the destination of the tab's
 * pending navigation. A tab frame without a document the engine host attached (a fresh frame, a non-HTML page) has
 * no nested frames, so everything there is the tab's. Pure: the caller supplies the clock and the frame facts.
 */
import { TIMEOUTS } from '../shared/engine-protocol';
import { PROXY_PATHS } from '../shared/proxy-origin';

/** A request URL for comparing: fragments never reach the network, so they are dropped. */
export function requestKey(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** A tab-shaped Scramjet request: a document/iframe destination without Scramjet's `$iframe=1` first-load mark. */
export function tabShaped(destination: string, rawUrl: string): boolean {
  if (destination !== 'document' && destination !== 'iframe') return false;
  try {
    return new URL(rawUrl).searchParams.get('$iframe') !== '1';
  } catch {
    return false;
  }
}

export interface ClaimFacts {
  /** The tab frame currently shows a document the engine host attached (it can contain nested proxied frames). */
  hookedDocument: boolean;
  /** The real destination of the tab's pending navigation, when one is pending and known. */
  pendingUrl: string | null;
  /** The real URL behind the request (decoded), when it can be decoded. */
  realUrl: string | null;
}

/**
 * How long a URL-less expectation (the top document's `beforeunload`) waits for its request: the browser sends it at
 * once, and one left over (the navigation was cancelled, e.g. at a "leave this page?" prompt) must not claim a nested
 * frame's navigation much later.
 */
export const UNNAMED_EXPECT_MS = 5000;

export class TabRequestClaims {
  #expect: { key: string | null; at: number } | null = null;
  #own: string | null = null;

  /**
   * The tab frame is about to request `url` (a proxied URL; null: the next tab-shaped request, whatever its URL).
   * A URL-less expectation does not replace a fresh one that names the URL (the Navigation API's `navigate` and the
   * top document's `beforeunload` both fire for one navigation).
   */
  expect(url: string | null, now: number): void {
    const key = url === null ? null : requestKey(url);
    if (url !== null && key === null) return;
    if (key === null && this.#expect && this.#expect.key !== null && now - this.#expect.at < 1000) return;
    this.#expect = { key, at: now };
  }

  /** Forgets the expectation (the navigation ended without another request). */
  clear(): void {
    this.#expect = null;
  }

  /** Whether a tab-shaped request with this raw (proxied) URL is the tab frame's own; consumes a matching expectation. */
  claim(rawUrl: string, now: number, facts: ClaimFacts): boolean {
    const key = requestKey(rawUrl);
    if (key === null) return false;
    const e = this.#expect;
    let own = false;
    if (e && now - e.at <= (e.key === null ? UNNAMED_EXPECT_MS : TIMEOUTS.navigationMs) && (e.key === null || e.key === key)) {
      this.#expect = null;
      own = true;
    } else if (!facts.hookedDocument) {
      own = true;
    } else if (facts.pendingUrl !== null && facts.realUrl !== null && requestKey(facts.pendingUrl) === requestKey(facts.realUrl)) {
      own = true;
    }
    if (own) this.#own = key;
    return own;
  }

  /** Whether the last claimed request had this raw URL (the error hook sees only the URL). */
  isOwn(rawUrl: string): boolean {
    const key = requestKey(rawUrl);
    return key !== null && key === this.#own;
  }
}

// ── The initiator Scramjet sees (scramjet-controller 0.0.14's `request` RPC) ─────────────────────────────────────────

/**
 * The fields of scramjet-controller 0.0.14's `request` RPC (controller.sw.js → controller.api.js `methods.request`)
 * that say who started a request. The SW side sends `rawClientUrl` = the URL of `clients.get(event.clientId)`.
 */
export interface SjRequestRpc {
  rawUrl?: unknown;
  rawClientUrl?: unknown;
  rawReferrer?: unknown;
  referrer?: unknown;
  mode?: unknown;
  destination?: unknown;
  [key: string]: unknown;
}

/**
 * The request as Scramjet should see its initiator (worklist A14 and the part-2 security review; measured
 * 2026-11-19 on the real stack). Scramjet takes the initiator (`Origin`, `Referer`, `Sec-Fetch-Site`, and the cookie
 * mode: `strict` sends every cookie, `lax` withholds SameSite=Strict ones, `cross-site` sends only SameSite=None
 * ones) from `rawClientUrl`, else `rawReferrer`, when that is a URL of its own prefix; without one it uses `strict`.
 * - A navigation GNOME starts (`loadInitiator(rawUrl)` is not undefined): `null` for GNOME's own (address bar,
 *   bookmark, history, reload): a browser sends no initiator for those, but Chromium names the frame's PREVIOUS
 *   document as the client of the engine host's `location.replace()`, so Scramjet sent the previous site's `Origin`
 *   and `Referer` (cross-site) and chose the `lax` cookie mode. The initiator fields are dropped. A string for a tab a
 *   page asked for (`tab.create` with `start.opener`): the opener's URL in Scramjet's form, so the destination sees
 *   the page that opened it, as it would after a link click in a browser (before, it got its SameSite=Strict cookies,
 *   `Sec-Fetch-Site: none` and no Referer for a `target=_blank` link of any site).
 * - A client that is no Scramjet document (the engine host itself, `/engine/`, whose own fetches and loads into a
 *   fresh tab frame reach the SW with it as the client in both browsers): Scramjet's unrewriteUrl logs "unrewriteurl:
 *   unexpected url <proxy>/engine/" (console.error) for it. Dropped, unless the engine host made the request on a
 *   page's behalf (`onBehalfOf(rawUrl)`: the tab's favicon, a download the page started): then that page's document is
 *   the initiator, as in a browser (before, the engine host's favicon fetch and `<a download>` sent the target's
 *   SameSite=Strict and Lax cookies for any URL a page named, without a click).
 * Returns the request itself when nothing changes.
 */
export function withInitiator(
  e: SjRequestRpc,
  loadInitiator: (rawUrl: string) => string | null | undefined,
  onBehalfOf: (rawUrl: string) => string | undefined = () => undefined,
): SjRequestRpc {
  if (typeof e !== 'object' || e === null) return e;
  const navigation = e.mode === 'navigate' && (e.destination === 'document' || e.destination === 'iframe');
  if (navigation && typeof e.rawUrl === 'string') {
    const initiator = loadInitiator(e.rawUrl);
    if (initiator === null) return { ...e, rawClientUrl: undefined, rawReferrer: '', referrer: '' };
    if (typeof initiator === 'string') return { ...e, rawClientUrl: initiator, rawReferrer: initiator, referrer: initiator };
  }
  if (typeof e.rawClientUrl === 'string' && !isScramjetDocumentUrl(e.rawClientUrl)) {
    const page = !navigation && typeof e.rawUrl === 'string' ? onBehalfOf(e.rawUrl) : undefined;
    return page === undefined ? { ...e, rawClientUrl: undefined } : { ...e, rawClientUrl: page, rawReferrer: page, referrer: page };
  }
  return e;
}

/** An http(s) URL under Scramjet's prefix (a document Scramjet made); other schemes (about:, blob:) count as one. */
function isScramjetDocumentUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return true; // nothing Scramjet's unrewriteUrl would object to
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  return u.pathname.startsWith(PROXY_PATHS.scramjetPrefix);
}

/**
 * Requests the engine host makes or starts itself, by request key (proxied URL without its fragment), with the
 * initiator Scramjet must see for them (withInitiator): `null` for GNOME's own navigations, else the proxied URL of the
 * page they are for. Each is remembered for TIMEOUTS.navigationMs; a redirect of a remembered navigation makes its
 * next hop one too, with the same initiator (a browser keeps `Sec-Fetch-Site: none` across the redirects of an
 * address-bar navigation, and a link's initiator across the link's redirects).
 */
export class GnomeLoads {
  readonly #until = new Map<string, { until: number; initiator: string | null }>();

  expect(rawUrl: string, now: number, initiator: string | null = null): void {
    const key = requestKey(rawUrl);
    if (key === null) return;
    this.#prune(now);
    this.#until.set(key, { until: now + TIMEOUTS.navigationMs, initiator });
  }

  /** undefined: not one of these requests; null: GNOME's own (no initiator); a string: the page's proxied URL. */
  initiatorOf(rawUrl: string, now: number): string | null | undefined {
    const key = requestKey(rawUrl);
    if (key === null) return undefined;
    const e = this.#until.get(key);
    return e !== undefined && now <= e.until ? e.initiator : undefined;
  }

  has(rawUrl: string, now: number): boolean {
    return this.initiatorOf(rawUrl, now) !== undefined;
  }

  /** `fromRawUrl` answered with a redirect to `toRawUrl` (rewritten by Scramjet): the same load continues there. */
  redirected(fromRawUrl: string, toRawUrl: string, now: number): void {
    const initiator = this.initiatorOf(fromRawUrl, now);
    if (initiator !== undefined) this.expect(toRawUrl, now, initiator);
  }

  get size(): number {
    return this.#until.size;
  }

  #prune(now: number): void {
    for (const [k, e] of this.#until) if (e.until < now) this.#until.delete(k);
  }
}
