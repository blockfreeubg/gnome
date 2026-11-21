/**
 * The `network` provider (WAVE-B3 §4.1): list-based blocking of requests and WebSockets, in both realms (the engine
 * host for Scramjet, the service worker for Ultraviolet). DOM-free and free of the library: each realm hands it a
 * GroupMatcher over its own engines (filters/engines.ts in the engine host, sw/engines.ts in the SW).
 */
import type { BlockerGroup, BlockerStatus } from '../../shared/engine-protocol';
import type { RedirectResource, RequestInfo, RequestVerdict } from '../../shared/engine-hooks';
import { CATEGORY_OF, MATCH_ORDER } from '../core/categories';
import type { HookProvider, RequestContext } from '../core/compose';

/**
 * Ghostery treats an empty source as first party, so `$third-party` rules would never match where the context is
 * unknown; this sentinel makes such a request third-party to everything (D15).
 */
export const UNKNOWN_SOURCE = 'https://unknown.invalid/';

/** Request.destination → Ghostery request type (research §2.6; Ghostery has no 'style', 'document' is no main frame). */
export const DEST_TO_TYPE: Readonly<Record<string, string>> = {
  '': 'xmlhttprequest',
  document: 'sub_frame',
  iframe: 'sub_frame',
  frame: 'sub_frame',
  fencedframe: 'sub_frame',
  script: 'script',
  worker: 'script',
  sharedworker: 'script',
  serviceworker: 'script',
  audioworklet: 'script',
  paintworklet: 'script',
  json: 'script',
  style: 'stylesheet',
  image: 'image',
  font: 'font',
  audio: 'media',
  video: 'media',
  track: 'other',
  object: 'object',
  embed: 'object',
  report: 'csp_report',
  manifest: 'other',
  xslt: 'other',
  webidentity: 'other',
  websocket: 'websocket',
};

/** The tab's own document is `main_frame` (Scramjet shows it as an iframe); frames are `sub_frame`. */
export function requestType(req: Pick<RequestInfo, 'destination' | 'isTopLevelDocument'>): string {
  if (req.isTopLevelDocument) return 'main_frame';
  return Object.prototype.hasOwnProperty.call(DEST_TO_TYPE, req.destination) ? (DEST_TO_TYPE[req.destination] as string) : 'other';
}

/** The initiator Ghostery's party and `$domain` checks use: the URL itself for main_frame, the sentinel when unknown. */
export function sourceUrlOf(req: Pick<RequestInfo, 'url' | 'documentUrl' | 'topLevelUrl'>, type: string): string {
  if (type === 'main_frame') return req.url;
  return req.documentUrl ?? req.topLevelUrl ?? UNKNOWN_SOURCE;
}

/** What one group engine says about a request. */
export interface GroupMatch {
  match: boolean;
  /** A `$redirect` resource as Ghostery returns it (`contentType` may carry `;base64`). */
  redirect?: { contentType: string; body: string } | undefined;
}

export interface GroupMatcher {
  /** Some group engines are in force. */
  ready(): boolean;
  /** null when the group has no engine in force. */
  match(group: BlockerGroup, url: string, sourceUrl: string, type: string): GroupMatch | null;
}

/** Ghostery's redirect as a verdict resource: a bare lower-case type; base64 when the type said so. */
export function toResource(r: { contentType: string; body: string }): RedirectResource | null {
  const parts = r.contentType.toLowerCase().split(';').map((p) => p.trim());
  const type = parts[0] ?? '';
  if (!/^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/.test(type)) return null;
  return { contentType: type, body: r.body, base64: parts.includes('base64') };
}

export interface NetworkProviderDeps {
  engines: GroupMatcher;
  status(): BlockerStatus;
}

export function createNetworkProvider(deps: NetworkProviderDeps): HookProvider {
  const judge = (req: RequestInfo, ctx: RequestContext, type: string): { group: BlockerGroup; m: GroupMatch } | null => {
    if (ctx.policy.allowlisted || !deps.engines.ready()) return null;
    const source = sourceUrlOf(req, type);
    for (const group of MATCH_ORDER) {
      if (!ctx.policy.groups[group]) continue;
      const m = deps.engines.match(group, req.url, source, type);
      if (m?.match) return { group, m };
    }
    return null;
  };
  return {
    name: 'network',
    onRequest(req, ctx): RequestVerdict | null {
      const type = requestType(req);
      const hit = judge(req, ctx, type);
      if (!hit) return null;
      const category = CATEGORY_OF[hit.group];
      // Documents and frames are never answered with a resource (D10): a plain block.
      if (hit.m.redirect && type !== 'main_frame' && type !== 'sub_frame') {
        const resource = toResource(hit.m.redirect);
        if (resource) return { action: 'block', category, resource };
      }
      return { action: 'block', category };
    },
    onWebSocket(req, ctx) {
      const hit = judge(req, ctx, 'websocket');
      return hit ? CATEGORY_OF[hit.group] : null;
    },
    status: () => deps.status(),
  };
}
