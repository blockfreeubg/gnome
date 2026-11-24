/**
 * The service worker's half of the content blocker (WAVE-B3 §4.5, D15), for Ultraviolet: the composite hooks with
 * the SW's own engines (received by message), the page context of UV requests (which document made a request and
 * which tab-top page it belongs to, from what the engine hosts send), the per-document `uv-blocked` batches, and the
 * one 300 ms deadline per SW start before which requests wait for the user's settings. It persists nothing (the
 * scoped site maps must not land where proxied pages read). DOM-free (WebWorker scope).
 *
 * Context (D15): every UV navigation and worker script fetch records its resulting client (onClient); a navigation
 * an engine host announced in `navs` is a tab-top document (its own top-level page); another navigation gets the
 * top-level page of the recorded document its referrer names (a lookup only: a referrer never creates a context),
 * else none until a `docs` entry names its proxied URL; a worker inherits its creator's. A request from a client with
 * no context waits ≤ 50 ms for one, then is judged with the global settings and no site rules, as third-party.
 */
import { BLOCK_CATEGORIES } from '../../shared/engine-protocol';
import type { BlockCategory, BlockerGroup } from '../../shared/engine-protocol';
import type { RequestHooks, RequestInfo } from '../../shared/engine-hooks';
import type { HostToSwMessage, SwSignal } from '../../shared/proxy-origin';
import { composeHooks } from '../core/compose';
import type { HookProvider } from '../core/compose';
import { SW_FALLBACK_SETTINGS } from '../core/policy';
import type { BlockerSettings } from '../core/policy';
import { createNetworkProvider } from '../filters/network';
import type { GroupMatcher } from '../filters/network';
import { blockerStatus, anyGroupOn } from '../filters/status';

export type RewriteParams = (url: string, documentUrl: string | null, type: 'main_frame' | 'sub_frame') => string | null;

/** What the SW blocker needs of its engines (sw/engines.ts SwEngines). */
export interface SwEngineSet {
  readonly setId: string | null;
  load(setId: string, groups: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>): void;
  ready(): boolean;
  match(...a: Parameters<GroupMatcher['match']>): ReturnType<GroupMatcher['match']>;
  rewriteParams: RewriteParams;
}

export interface SwBlockerDeps {
  /** Client.postMessage to the registered engine-host clients only (uv-blocked batches; §4.5). */
  signal(msg: SwSignal): void;
  /** Proxied UV URL → real URL (`__uv$config.decodeUrl` after the prefix), null when it is not one. */
  decode(proxied: string): string | null;
  log(message: string): void;
  /** The engines (sw/engines.ts). */
  engines: SwEngineSet;
  /** x3's providers (sw/providers.ts). */
  providers?(rewriteParams: RewriteParams): HookProvider[];
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
}

export interface SwContext extends Pick<RequestInfo, 'documentUrl' | 'topLevelUrl' | 'isTopLevelDocument'> {
  /**
   * The requesting document's proxied URL (for uv-blocked), or null; for a tab-top navigation the URL its engine host
   * announced (also for the redirect hops after it), which that host maps to its tab.
   */
  documentProxied: string | null;
  /** A tab-top navigation: the engine host whose announcement made it one (its redirect hops stay tab-top, D3). */
  navHost?: string;
}

export interface SwBlocker {
  readonly hooks: RequestHooks;
  /** gnome-blocker-config from registered engine-host client `clientId` (already validated). */
  onConfig(clientId: string, settings: BlockerSettings, setId: string | null): void;
  /** gnome-blocker-engines from a registered engine-host client: deserialized and put in force (the most recent such message wins; the previous set is dropped). */
  onEngines(clientId: string, msg: Extract<HostToSwMessage, { type: 'gnome-blocker-engines' }>): void;
  onContext(clientId: string, msg: Extract<HostToSwMessage, { type: 'gnome-blocker-context' }>): void;
  /**
   * A UV navigation fetch (mode navigate, destination document/iframe/frame) or worker script fetch: remember which
   * document its resulting client shows (a worker inherits the creator's context).
   */
  onClient(resultingClientId: string, proxiedUrl: string, creatorClientId: string | null, referrer: string | null): void;
  /** An engine-host client is gone (clients.get → undefined): drop its config, scoped maps and context. */
  forgetHost(clientId: string): void;
  /**
   * The page context of a UV request (D15), resolved after at most the waits of §4.5: ≤ 50 ms for an unknown client's
   * context, ≤ 20 ms for an unannounced link of a tab-top document, ≤ 150 ms for an announced navigation's config.
   */
  context(event: { clientId: string; resultingClientId?: string }, request: { url: string; mode: string; destination: string; referrer: string }): Promise<SwContext>;
  /** Resolves when the user's settings arrived, or at the single deadline of this SW start (300 ms after it): never per request. */
  ready(): Promise<void>;
  /**
   * A block of a request with this context (the composite's onBlock), batched per document into uv-blocked. `url`: a
   * blocked URL counts once per document (Firefox requests a refused parser-preloaded image twice); a new navigation
   * of the document starts again.
   */
  counted(documentProxied: string | null, category: BlockCategory, url?: string): void;
  /** Known hosts (to check which are gone). */
  hostIds(): string[];
  /** sw.ts: the proxied document a RequestInfo belongs to, set before the hooks judge it (for uv-blocked). */
  attach(info: RequestInfo, documentProxied: string | null): void;
  /**
   * A tab-top navigation (`ctx` from context()) was answered with a redirect to `location` (a proxied URL: UV's
   * rewritten Location, or the SW's own 307 of parameter stripping): the next hop is the tab's own document too and is
   * judged under itself (D3 "every redirect hop"), not as a frame of the page that started the navigation.
   */
  redirected(ctx: SwContext, location: string, initiator?: string | null): void;
  /**
   * The initiator of a UV navigation to `proxiedUrl` for SameSite and fetch metadata (lane x3's glue): the engine
   * host's announced one (`inits`, one-shot: '' = GNOME's own load, else the opener's real URL), else the real URL of
   * the recorded document `referrer` names (a lookup only), else null (unknown: cross-site).
   */
  initiatorOf(proxiedUrl: string, referrer: string | null): string | null;
  /** The settings in force (the newest config with every host's scoped maps; the fallback before any). */
  settings(): BlockerSettings;
  /** The real http(s) URL of a proxied UV URL, or null. */
  realOf(proxied: string): string | null;
}

export const SW_WAITS = { unknownClientMs: 50, tabTopLinkMs: 20, announcedConfigMs: 150, readyMs: 300, batchMs: 250, navTtlMs: 30_000 } as const;
const LIMITS = { clients: 2048, documents: 4096, navs: 64, countedDocs: 512, countedUrls: 2048 } as const;

interface ClientCtx {
  /** The document's proxied URL (a worker: its creator's document). */
  doc: string;
  /** The real top-level URL, or null until known. */
  top: string | null;
  tabTop: boolean;
}

interface HostState {
  settings: BlockerSettings;
  setId: string | null;
  at: number;
  /** Order of the last config (messages of one host arrive in order). */
  seq: number;
  /** Announced tab-top navigations (and their redirect hops): proxied URL → when, and the message order. */
  navs: Map<string, number>;
  navSeq: Map<string, number>;
  /** A redirect hop → the URL its host announced (what uv-blocked names for the whole chain). */
  navOrigin: Map<string, string>;
}

function lruSet<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest as K);
  }
}

const isNavigation = (r: { mode: string; destination: string }): boolean =>
  r.mode === 'navigate' && (r.destination === 'document' || r.destination === 'iframe' || r.destination === 'frame');

export function startSwBlocker(deps: SwBlockerDeps): SwBlocker {
  const now = deps.now ?? (() => Date.now());
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const engines = deps.engines;
  const hosts = new Map<string, HostState>();
  /** proxied document URL → real top-level URL. */
  const documents = new Map<string, string>();
  const clients = new Map<string, ClientCtx>();
  /** Waiters for a client's context, a navs entry, or a host's config. */
  let waiters: Array<() => void> = [];
  const wake = (): void => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  const waitFor = (pred: () => boolean, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (pred()) return resolve();
      let done = false;
      const check = (): void => {
        if (done) return;
        if (pred()) {
          done = true;
          resolve();
        } else waiters.push(check);
      };
      waiters.push(check);
      later(() => {
        if (done) return;
        done = true;
        resolve();
      }, ms);
    });

  let msgSeq = 0;
  // ── Settings: the newest config's settings with the union of every host's scoped maps (D5) ──
  let configured = false;
  const effective = (): BlockerSettings => {
    const list = [...hosts.values()].sort((a, b) => a.at - b.at);
    const newest = list.at(-1);
    if (!newest) return SW_FALLBACK_SETTINGS;
    const allowlist = new Set<string>();
    const perSite: BlockerSettings['extensions']['perSite'] = {};
    for (const h of list) {
      for (const k of h.settings.extensions.allowlist) allowlist.add(k);
      for (const [k, v] of Object.entries(h.settings.extensions.perSite)) perSite[k] = v;
    }
    return { privacy: newest.settings.privacy, extensions: { ...newest.settings.extensions, allowlist: [...allowlist], perSite } };
  };

  // ── uv-blocked batches ──
  const batches = new Map<string, Partial<Record<BlockCategory, number>>>();
  /** Per document: the URLs counted since its navigation (LRU of documents). */
  const countedUrls = new Map<string, Set<string>>();
  let flushScheduled = false;
  const flush = (): void => {
    flushScheduled = false;
    for (const [documentUrl, counts] of batches) deps.signal({ type: 'uv-blocked', documentUrl, counts });
    batches.clear();
  };
  const counted = (doc: string | null, category: BlockCategory, url?: string): void => {
    if (doc === null || !BLOCK_CATEGORIES.includes(category)) return;
    if (url !== undefined) {
      const k = `${category} ${url}`;
      let seen = countedUrls.get(doc);
      if (seen?.has(k)) return;
      if (!seen) {
        seen = new Set();
        lruSet(countedUrls, doc, seen, LIMITS.countedDocs);
      }
      if (seen.size < LIMITS.countedUrls) seen.add(k);
    }
    const c = batches.get(doc) ?? {};
    c[category] = Math.min((c[category] ?? 0) + 1, 100_000);
    batches.set(doc, c);
    if (!flushScheduled) {
      flushScheduled = true;
      later(flush, SW_WAITS.batchMs);
    }
  };

  /** The proxied document of each RequestInfo the hooks see (sw.ts sets it before judging). */
  const docOfInfo = new WeakMap<object, string | null>();

  const network = createNetworkProvider({
    engines,
    status: () => {
      const s = effective();
      const lists = s.extensions.lists.filter((l) => l.category !== 'resources').length;
      return blockerStatus({ lists, anyGroupOn: anyGroupOn(s), inForce: engines.ready() ? { compiled: lists, failed: 0 } : null, failure: null, overLimit: null, cacheRejected: false });
    },
  });
  const composite = composeHooks({
    providers: [network, ...(deps.providers?.((u, d, t) => engines.rewriteParams(u, d, t)) ?? [])],
    onBlock: (req, category) => counted(docOfInfo.get(req) ?? null, category, req.url),
    onError: (p, where, err) => deps.log(`content blocker ${p}.${where}: ${err instanceof Error ? err.message : String(err)}`),
  });
  composite.configure(SW_FALLBACK_SETTINGS);
  const reconfigure = (): void => composite.configure(effective());

  /** Announced initiators (`inits`): proxied URL → [initiator, when]. One-shot, ≤ 30 s, LRU-bounded. */
  const inits = new Map<string, [string, number]>();
  const takeInit = (proxied: string): string | null => {
    const key = strip(proxied);
    const e = inits.get(key);
    if (e === undefined) return null;
    inits.delete(key);
    return now() - e[1] <= SW_WAITS.navTtlMs ? e[0] : null;
  };

  // ── ready(): one deadline per SW start ──
  let readyResolve: () => void = () => undefined;
  const readyPromise = new Promise<void>((r) => (readyResolve = r));
  later(() => readyResolve(), SW_WAITS.readyMs);

  const navOf = (proxied: string): { host: string; state: HostState } | null => {
    const t = now();
    for (const [host, state] of hosts) {
      const at = state.navs.get(proxied);
      if (at !== undefined && t - at <= SW_WAITS.navTtlMs) return { host, state };
    }
    return null;
  };

  const strip = (u: string): string => u.split('#')[0] ?? u;

  const realOf = (proxied: string): string | null => {
    const r = deps.decode(proxied);
    return r !== null && /^https?:\/\//i.test(r) ? r : null;
  };

  return {
    hooks: {
      ...composite,
      configure: () => undefined, // the SW is configured by its engine hosts only (onConfig)
    },
    counted,
    hostIds: () => [...hosts.keys()],
    onConfig(clientId, settings, setId) {
      const prev = hosts.get(clientId);
      hosts.set(clientId, { settings, setId, at: now(), seq: ++msgSeq, navs: prev?.navs ?? new Map(), navSeq: prev?.navSeq ?? new Map(), navOrigin: prev?.navOrigin ?? new Map() });
      configured = true;
      reconfigure();
      readyResolve();
      wake();
    },
    onEngines(_clientId, msg) {
      try {
        engines.load(msg.setId, msg.groups);
      } catch (err) {
        deps.log(`content blocker engines: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onContext(clientId, msg) {
      let state = hosts.get(clientId);
      if (!state) {
        // context before the first config of this host: keep it with the fallback settings until the config comes
        state = { settings: SW_FALLBACK_SETTINGS, setId: null, at: 0, seq: 0, navs: new Map(), navSeq: new Map(), navOrigin: new Map() };
        hosts.set(clientId, state);
      }
      if (msg.reset) {
        state.navs.clear();
        state.navSeq.clear();
        state.navOrigin.clear();
      }
      for (const [proxied, top] of msg.docs) {
        const key = strip(proxied);
        lruSet(documents, key, top, LIMITS.documents);
        for (const c of clients.values()) if (c.doc === key) c.top = top;
      }
      const t = now();
      for (const n of msg.navs) {
        lruSet(state.navs, strip(n), t, LIMITS.navs);
        lruSet(state.navSeq, strip(n), ++msgSeq, LIMITS.navs);
        state.navOrigin.delete(strip(n));
        // a client created by this navigation before the announcement arrived (a race) becomes the tab-top
        for (const c of clients.values()) {
          if (c.doc === strip(n) && c.top === null) {
            c.top = realOf(n);
            c.tabTop = true;
          }
        }
      }
      for (const d of msg.drop) {
        state.navs.delete(strip(d));
        state.navSeq.delete(strip(d));
        state.navOrigin.delete(strip(d));
        inits.delete(strip(d));
      }
      for (const [proxied, initiator] of msg.inits ?? []) lruSet(inits, strip(proxied), [initiator, t], LIMITS.navs);
      wake();
    },
    onClient(resultingClientId, proxiedUrl, creatorClientId, referrer) {
      if (!resultingClientId) return;
      const doc = strip(proxiedUrl);
      // A navigation to this document (a reload too) starts its counted URLs again (a worker script URL is no document).
      countedUrls.delete(doc);
      const creator = creatorClientId ? clients.get(creatorClientId) : undefined;
      // A worker (its URL is a script, not a document): the creator's context.
      if (creator && !documents.has(doc) && navOf(doc) === null && referrer === null) {
        lruSet(clients, resultingClientId, { ...creator }, LIMITS.clients);
        return;
      }
      const nav = navOf(doc);
      if (nav) {
        lruSet(clients, resultingClientId, { doc, top: realOf(doc), tabTop: true }, LIMITS.clients);
        return;
      }
      const known = documents.get(doc);
      const viaReferrer = referrer ? documents.get(strip(referrer)) : undefined;
      lruSet(clients, resultingClientId, { doc, top: known ?? viaReferrer ?? (creator?.top ?? null), tabTop: false }, LIMITS.clients);
    },
    forgetHost(clientId) {
      hosts.delete(clientId);
      reconfigure();
    },
    async context(event, request) {
      const url = request.url;
      if (isNavigation(request)) {
        const key = strip(url);
        // A link in a tab-top document races its announcement: wait ≤ 20 ms for the navs entry.
        const refDoc = request.referrer ? strip(request.referrer) : null;
        const refIsTabTop = refDoc !== null && [...clients.values()].some((c) => c.doc === refDoc && c.tabTop);
        if (!navOf(key) && refIsTabTop) await waitFor(() => navOf(key) !== null, SW_WAITS.tabTopLinkMs);
        // A navigation without a referrer (GNOME's own loads have no initiator; the engine host posts their `navs`
        // just before it loads the frame, and the message can arrive after the fetch): ≤ 50 ms for it too.
        else if (!navOf(key) && !refDoc) await waitFor(() => navOf(key) !== null, SW_WAITS.unknownClientMs);
        const nav = navOf(key);
        const real = realOf(url);
        if (nav) {
          // Announced: wait ≤ 150 ms for a config from that host sent after the announcement (it carries the rules).
          const after = nav.state.navSeq.get(key) ?? 0;
          const host = nav.host;
          const origin = nav.state.navOrigin.get(key) ?? key;
          // Consumed (§4.5): a later navigation to the same URL (a frame of another page, in any GNOME tab) is not
          // taken for this tab's own document.
          nav.state.navs.delete(key);
          nav.state.navSeq.delete(key);
          nav.state.navOrigin.delete(key);
          await waitFor(() => (hosts.get(host)?.seq ?? 0) > after, SW_WAITS.announcedConfigMs);
          return { documentUrl: real, topLevelUrl: real, isTopLevelDocument: true, documentProxied: origin, navHost: host };
        }
        // A frame: its parent is the referrer's recorded document (a lookup only), else the creator client's.
        const parentTop = refDoc !== null ? (documents.get(refDoc) ?? null) : null;
        const creator = event.clientId ? clients.get(event.clientId) : undefined;
        const top = parentTop ?? creator?.top ?? null;
        const parent = refDoc !== null && documents.has(refDoc) ? realOf(refDoc) : creator ? realOf(creator.doc) : null;
        return { documentUrl: parent ?? top, topLevelUrl: top, isTopLevelDocument: false, documentProxied: refDoc !== null && documents.has(refDoc) ? refDoc : (creator?.doc ?? null) };
      }
      const id = event.clientId;
      // A fetch the engine host makes for a page (its favicon, a download; lane x3's glue): that page's context.
      if (id && hosts.has(id) && !clients.has(id)) {
        const page = inits.has(strip(url)) ? takeInit(url) : null;
        if (page) {
          let doc: string | null = null;
          for (const k of documents.keys()) if (realOf(k) === page) doc = k;
          return { documentUrl: page, topLevelUrl: doc !== null ? (documents.get(doc) ?? null) : null, isTopLevelDocument: false, documentProxied: doc };
        }
      }
      if (id) {
        const has = (): boolean => {
          const c = clients.get(id);
          return c !== undefined && (c.top !== null || documents.has(c.doc));
        };
        if (!has()) await waitFor(has, SW_WAITS.unknownClientMs);
        const c = clients.get(id);
        if (c) {
          const top = c.top ?? documents.get(c.doc) ?? null;
          const real = realOf(c.doc);
          return { documentUrl: real ?? top, topLevelUrl: top, isTopLevelDocument: false, documentProxied: c.doc };
        }
      }
      // Unknown context: the global settings without site rules, third-party (D15). The referrer is used only to
      // count the block (a recorded document), never to pick a policy.
      const refDoc = request.referrer ? strip(request.referrer) : null;
      return { documentUrl: null, topLevelUrl: null, isTopLevelDocument: false, documentProxied: refDoc !== null && documents.has(refDoc) ? refDoc : null };
    },
    ready: () => (configured ? Promise.resolve() : readyPromise),
    attach: (info, doc) => {
      docOfInfo.set(info, doc);
    },
    redirected(ctx, location, initiator) {
      if (!ctx.isTopLevelDocument || ctx.navHost === undefined) return;
      const state = hosts.get(ctx.navHost);
      if (!state || realOf(location) === null) return;
      const key = strip(location);
      // The hop keeps the navigation's initiator (GNOME's own load stays initiator-less, as a browser's does).
      if (initiator !== undefined && initiator !== null) lruSet(inits, key, [initiator, now()], LIMITS.navs);
      lruSet(state.navs, key, now(), LIMITS.navs);
      // the hop needs no config of its own: its host's answer for the first hop is in already
      lruSet(state.navSeq, key, 0, LIMITS.navs);
      lruSet(state.navOrigin, key, ctx.documentProxied ?? key, LIMITS.navs);
    },
    initiatorOf(proxiedUrl, referrer) {
      const announced = takeInit(proxiedUrl);
      if (announced !== null) return announced;
      const refDoc = referrer ? strip(referrer) : null;
      return refDoc !== null && documents.has(refDoc) ? realOf(refDoc) : null;
    },
    settings: () => effective(),
    realOf,
  };
}
