/**
 * How several built-in providers become the single `registerEngineHooks()` / `registerSwHooks()` registration
 * (WAVE-B3 §3.2). Pure, DOM-free, compiled in every scope. Every provider member is optional and synchronous; the
 * composite catches each throw (fail open, reported through `onError`).
 */
import { BLOCK_CATEGORIES } from '../../shared/engine-protocol';
import type { BlockCategory, BlockerStatus } from '../../shared/engine-protocol';
import type { DocumentInfo, EngineHooks, ProxiedWindow, RequestInfo, RequestVerdict, ResponseHeaders, ResponseInfo } from '../../shared/engine-hooks';
import { sitePolicy } from './policy';
import type { BlockerSettings, SitePolicy } from './policy';
import { isThirdParty } from './site';

export interface RequestContext {
  readonly settings: BlockerSettings;
  /** The policy of the tab's top-level page (D3). */
  readonly policy: SitePolicy;
  /** The request's (or document's) site differs from the top-level page's; null when that page is unknown. */
  readonly thirdParty: boolean | null;
}

export type ProviderName = 'network' | 'cookies' | 'privacy' | 'cosmetic';

/** One built-in extension's part of the hooks. Members are optional and synchronous; the composite catches throws. */
export interface HookProvider {
  readonly name: ProviderName;
  configure?(settings: BlockerSettings): void;
  /** null = no opinion. `redirect` only for documents (safeVerdict drops it for anything else). */
  onRequest?(req: RequestInfo, ctx: RequestContext): RequestVerdict | null;
  onResponse?(res: ResponseInfo, headers: ResponseHeaders, ctx: RequestContext): void;
  /** The category that blocks the socket, or null. */
  onWebSocket?(req: RequestInfo, ctx: RequestContext): BlockCategory | null;
  /** Window side only (rule R1 applies to everything it installs). */
  onDocument?(win: ProxiedWindow, doc: DocumentInfo, ctx: RequestContext): void;
  /** Only the network provider has one: it is status.blocker. */
  status?(): BlockerStatus;
}

export interface ComposeOptions {
  /** In this order: network, cookies, privacy, cosmetic (blocks first; document overrides before scriptlets). */
  readonly providers: readonly HookProvider[];
  /**
   * Each block, `$redirect` answer and parameter-stripping redirect, once: the engine host counts it into tab.blocked
   * (a request without a tab, such as the WebSocket backstop's, goes to diagnostics only), the SW batches it per
   * document into uv-blocked.
   */
  onBlock(req: RequestInfo, category: BlockCategory): void;
  onError(provider: ProviderName, where: string, err: unknown): void;
}

const OFF: BlockerStatus = { state: 'off', lists: 0, detail: null };

/** The tab's top-level page for this request (D3, C6): a tab's own document request is judged under itself. */
const topOf = (req: RequestInfo): string | null => (req.isTopLevelDocument ? req.url : req.topLevelUrl);

/**
 * A parameter-stripping redirect is kept only where safeVerdict keeps it (documents, http(s)) and only when it stays
 * on the request's origin, so a provider bug cannot become an open redirect inside the proxy; it is counted only then.
 */
function goodRedirect(req: RequestInfo, to: string): boolean {
  if (!req.isTopLevelDocument && req.destination !== 'document' && req.destination !== 'iframe' && req.destination !== 'frame') return false;
  try {
    const from = new URL(req.url);
    const dest = new URL(to);
    return (dest.protocol === 'http:' || dest.protocol === 'https:') && dest.origin === from.origin && dest.href !== from.href;
  } catch {
    return false;
  }
}

/** Policy cache key: the top-level page's host (site rules are host keys, ports included). */
function hostOf(url: string | null): string {
  if (url === null) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * The one EngineHooks object of a realm (the SW uses it as RequestHooks and never calls onDocument). Until the first
 * configure() everything is allowed (the SW configures SW_FALLBACK_SETTINGS at its start, §4.5). Verdicts: the first
 * `block` wins (in provider order); else the first `redirect` that goodRedirect() keeps; else `allow` with the header
 * changes of every provider merged (lower-case names, a later `set` replaces an earlier one, a `remove` beats any
 * `set` of the same name).
 */
export function composeHooks(opts: ComposeOptions): EngineHooks {
  let settings: BlockerSettings | null = null;
  const policies = new Map<string, SitePolicy>();
  const run = <T>(p: HookProvider, where: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      opts.onError(p.name, where, err);
      return fallback;
    }
  };
  const context = (url: string, top: string | null): RequestContext | null => {
    if (settings === null) return null;
    const key = top === null ? '' : `h:${hostOf(top)}`;
    let policy = policies.get(key);
    if (!policy) {
      policy = sitePolicy(settings, top);
      if (policies.size >= 256) policies.clear();
      policies.set(key, policy);
    }
    return { settings, policy, thirdParty: isThirdParty(url, top) };
  };
  const network = opts.providers.find((p) => p.name === 'network');

  return {
    configure(s) {
      settings = s;
      policies.clear();
      for (const p of opts.providers) if (p.configure) run(p, 'configure', () => p.configure?.(s), undefined);
    },
    onRequest(req) {
      const ctx = context(req.url, topOf(req));
      if (ctx === null) return { action: 'allow' };
      let redirect: RequestVerdict | null = null;
      const set = new Map<string, string>();
      const remove = new Set<string>();
      for (const p of opts.providers) {
        if (!p.onRequest) continue;
        const v = run(p, 'onRequest', () => p.onRequest?.(req, ctx) ?? null, null);
        if (v === null) continue;
        if (v.action === 'block') {
          if (!BLOCK_CATEGORIES.includes(v.category)) {
            opts.onError(p.name, 'onRequest', new Error(`invalid category ${String(v.category)}`));
            continue;
          }
          opts.onBlock(req, v.category);
          return v;
        }
        if (v.action === 'redirect') {
          if (redirect === null && goodRedirect(req, v.url)) redirect = v;
          else if (redirect === null) opts.onError(p.name, 'onRequest', new Error('redirect refused'));
          continue;
        }
        for (const n of v.headers?.remove ?? []) remove.add(n.toLowerCase());
        for (const [n, value] of v.headers?.set ?? []) set.set(n.toLowerCase(), value);
      }
      if (redirect !== null) {
        opts.onBlock(req, 'urlparams');
        return redirect;
      }
      for (const n of remove) set.delete(n);
      return set.size || remove.size ? { action: 'allow', headers: { set: [...set], remove: [...remove] } } : { action: 'allow' };
    },
    onResponse(res: ResponseInfo, headers: ResponseHeaders) {
      const ctx = context(res.url, topOf(res));
      if (ctx === null) return;
      for (const p of opts.providers) if (p.onResponse) run(p, 'onResponse', () => p.onResponse?.(res, headers, ctx), undefined);
    },
    onWebSocket(req) {
      const ctx = context(req.url, topOf(req));
      if (ctx === null) return 'allow';
      for (const p of opts.providers) {
        if (!p.onWebSocket) continue;
        const c = run(p, 'onWebSocket', () => p.onWebSocket?.(req, ctx) ?? null, null);
        if (c !== null && BLOCK_CATEGORIES.includes(c)) {
          opts.onBlock(req, c);
          return 'block';
        }
      }
      return 'allow';
    },
    onDocument(win: ProxiedWindow, doc: DocumentInfo) {
      const ctx = context(doc.url, doc.topLevelUrl);
      if (ctx === null) return;
      for (const p of opts.providers) if (p.onDocument) run(p, 'onDocument', () => p.onDocument?.(win, doc, ctx), undefined);
    },
    status() {
      return network?.status ? run(network, 'status', () => network.status?.() ?? OFF, OFF) : OFF;
    },
  };
}
