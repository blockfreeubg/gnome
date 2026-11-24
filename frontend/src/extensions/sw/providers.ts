/**
 * The service worker's providers beside `network` (WAVE-B3 §4.5, §13 item 6): the only file of the SW that imports
 * lane x3's DOM-free providers (cookies, privacy; landed 2026-11-19 12:20). Order after network: cookies, privacy.
 */
import type { HookProvider } from '../core/compose';
import { createCookieProvider } from '../cookies/provider';
import { createPrivacyProvider } from '../privacy/provider';
import type { RewriteParams } from './blocker';

/**
 * Lane x3's Ultraviolet glue for sw.ts (row K3c, lane x3's review 2026-11-20; no contract change): a UV document or
 * worker whose own cookies the cookie manager blocks gets an empty script cookie string, so the about:blank children
 * that share UV's closure read nothing either.
 */
export { UV_SCRIPT_COOKIE_DESTINATIONS, blankUvScriptCookies, verdictBlocksCookies } from '../cookies/provider';
// Lane x3's Ultraviolet SameSite glue (sw.ts): UV's cookie serialization, fetch metadata and the opener's Referer.
export { fixUvCookies, uvFetchMetadata, uvSameSiteRequest } from '../cookies/provider';
export type { UvCookieContext } from '../cookies/provider';
export { reduceReferrer } from '../privacy/provider';
export { isThirdParty } from '../core/site';
export { cookieRuleFor, cookiesBlocked, sitePolicy } from '../core/policy';

export function swProviders(deps: { rewriteParams: RewriteParams }): HookProvider[] {
  return [createCookieProvider(), createPrivacyProvider({ rewriteParams: deps.rewriteParams })];
}
