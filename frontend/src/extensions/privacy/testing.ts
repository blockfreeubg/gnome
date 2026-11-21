/** Test helpers for lane x3's unit tests (settings literals, contexts, requests). Imported by *.test.ts only. */
import type { RequestInfo } from '../../shared/engine-hooks';
import type { RequestContext } from '../core/compose';
import { sitePolicy } from '../core/policy';
import type { BlockerSettings } from '../core/policy';
import { isThirdParty } from '../core/site';

export function settings(over: {
  privacy?: Partial<BlockerSettings['privacy']>;
  enabled?: Partial<BlockerSettings['extensions']['enabled']>;
  extensions?: Partial<Omit<BlockerSettings['extensions'], 'enabled'>>;
} = {}): BlockerSettings {
  return {
    privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'block-third-party', ...over.privacy },
    extensions: {
      enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true, ...over.enabled },
      lists: [],
      allowlist: [],
      perSite: {},
      cosmeticAggressive: false,
      cookieRules: {},
      ...over.extensions,
    },
  };
}

/** What the composite (x1's composeHooks) hands a provider: the policy of the tab's top-level page (D3). */
export function contextFor(s: BlockerSettings, url: string, top: string | null): RequestContext {
  return { settings: s, policy: sitePolicy(s, top), thirdParty: isThirdParty(url, top) };
}

export function request(over: Partial<RequestInfo> & { url: string }): RequestInfo {
  return {
    engine: 'scramjet',
    tabId: 1,
    method: 'GET',
    isTopLevelDocument: false,
    topLevelUrl: 'https://site-a.example/',
    destination: 'script',
    documentUrl: 'https://site-a.example/',
    referrer: null,
    ...over,
  };
}

/** The tab's own top-level document (judged under itself, D3). */
export function topDocument(url: string, over: Partial<RequestInfo> = {}): RequestInfo {
  return request({ url, isTopLevelDocument: true, destination: 'document', documentUrl: url, topLevelUrl: over.topLevelUrl ?? null, ...over });
}
