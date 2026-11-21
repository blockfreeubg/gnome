/**
 * What applies to a request or document under its tab's top-level page (WAVE-B3 D2–D4). Pure, DOM-free.
 */
import { BLOCKER_GROUPS } from '../../shared/engine-protocol';
import type { BlockerGroup, EngineSettings } from '../../shared/engine-protocol';
import { inHostList, ruleFor } from '../../shared/site-rules';
import { TOGGLE_OF } from './categories';

export type BlockerSettings = Pick<EngineSettings, 'privacy' | 'extensions'>;
export type CookieRule = 'allow' | 'session' | 'block';

/** What applies under one tab's top-level page (D3); its frames inherit it. */
export interface SitePolicy {
  /** The top-level site is on the allowlist: nothing list-based applies. */
  readonly allowlisted: boolean;
  /** Network blocking, `$redirect` resources and scriptlets, per group. */
  readonly groups: Readonly<Record<BlockerGroup, boolean>>;
  /** Element hiding with site-specific rules. */
  readonly hide: boolean;
  /** Also the site-independent ("generic") hiding rules. */
  readonly genericHide: boolean;
  readonly gpc: boolean;
  readonly dnt: boolean;
  readonly referrer: 'default' | 'origin-cross-site' | 'none';
  readonly stripParams: boolean;
  /** `browser.cookies.mode` while the cookie manager is on, else 'all'. */
  readonly cookieMode: 'all' | 'block-third-party' | 'block-all';
}

export function sitePolicy(s: BlockerSettings, topLevelUrl: string | null): SitePolicy {
  const e = s.extensions;
  const allowlisted = topLevelUrl !== null && inHostList(e.allowlist, topLevelUrl);
  const site = topLevelUrl === null ? undefined : ruleFor(e.perSite, topLevelUrl);
  const on = {
    adblock: site?.adblock ?? e.enabled.adblock,
    trackers: site?.trackers ?? e.enabled.trackers,
    cosmetic: site?.cosmetic ?? e.enabled.cosmetic,
  };
  const privacy = e.enabled.privacy;
  const stripParams = !allowlisted && privacy && s.privacy.stripTrackingParams;
  const groups = {} as Record<BlockerGroup, boolean>;
  for (const g of BLOCKER_GROUPS) {
    const t = TOGGLE_OF[g];
    groups[g] = !allowlisted && (t === 'privacy' ? stripParams : on[t]);
  }
  const hide = !allowlisted && on.cosmetic;
  return {
    allowlisted,
    groups,
    hide,
    genericHide: hide && e.cosmeticAggressive,
    gpc: privacy && s.privacy.sendGpc,
    dnt: privacy && s.privacy.doNotTrack,
    referrer: privacy ? s.privacy.referrer : 'default',
    stripParams,
    cookieMode: e.enabled.cookies ? s.privacy.cookies : 'all',
  };
}

/** The cookie rule of a cookie's site (D4); null without one, or while the cookie manager is off. */
export function cookieRuleFor(s: BlockerSettings, cookieUrl: string): CookieRule | null {
  if (!s.extensions.enabled.cookies) return null;
  return ruleFor(s.extensions.cookieRules, cookieUrl) ?? null;
}

/**
 * Whether cookies of a request or document are blocked (D4). `allow` and `session` rules allow (a session rule is
 * "allow until GNOME closes"); `thirdParty` null (unknown top-level page) counts as third-party: a page can make its
 * context unknown on purpose (no-referrer frames, workers, about:blank children; D15).
 */
export function cookiesBlocked(p: SitePolicy, rule: CookieRule | null, thirdParty: boolean | null): boolean {
  if (rule === 'allow' || rule === 'session') return false;
  if (rule === 'block') return true;
  if (p.cookieMode === 'block-all') return true;
  return p.cookieMode === 'block-third-party' && thirdParty !== false;
}

/**
 * What the service worker applies before an engine host sent the user's settings (after every SW start): the schema
 * defaults of `settings/defaults.ts` (a unit test compares them), no lists, no site or cookie rules. List-based
 * blocking still fails open (no engines yet); privacy headers and cookie modes do not wait (D7).
 */
export const SW_FALLBACK_SETTINGS: BlockerSettings = {
  privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'block-third-party' },
  extensions: {
    enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true },
    lists: [],
    allowlist: [],
    perSite: {},
    cosmeticAggressive: false,
    cookieRules: {},
  },
};
