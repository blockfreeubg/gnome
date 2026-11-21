/**
 * What the toolbar shield and the blocked page do with the site rules (WAVE-B3 §7.1, D3). Pure: the site functions
 * (core/site.ts, which pulls in tldts) are passed in, so the app loads them lazily, only when the shield's popover or
 * the blocked page needs them.
 *
 * - *Pause on this site* adds `siteKeyOf(top)` (`*.<registrable domain>`, the bare host for IP literals) to the
 *   allowlist, and names that key.
 * - *Resume* removes every allowlist key among `siteKeysFor(top)` that is at least as specific as `siteKeyOf(top)`
 *   (`<host>:<port>`, `<host>`, `*.<sub>.<site>`, `*.<site>`); when a broader key (`*.co.uk`, a user's `*.com`) still
 *   matches, there is no Resume: the shield says "Blocking is off for <key> in Settings" and links to the rule.
 * - The per-site switches write the most specific per-site rule that applies to the page when it is at least as
 *   specific as `siteKeyOf(top)`, else a rule under `siteKeyOf(top)`: a broader rule (a user's `*.com`) is never changed
 *   from one site's panel, its values are copied into the site's own rule. A switch set back to the global value is
 *   removed from the rule (and an empty rule with it).
 * - The blocked page's "Turn off blocking on <key>": `siteKeyOf(url)` when the page's host is the registrable domain
 *   or `www.` + it, else the exact host (on `ads.example.com` only that host).
 */
import { siteKeysFor } from '../../shared/site-rules';
import type { Settings } from '../../settings/schema';

export interface SiteFns {
  siteOf(url: string): string | null;
  siteKeyOf(url: string): string | null;
}

type Ext = Settings['extensions'];
export type SiteSwitch = 'adblock' | 'trackers' | 'cosmetic';
export const SITE_SWITCHES: readonly SiteSwitch[] = ['adblock', 'trackers', 'cosmetic'];

export interface ShieldSite {
  /** The key Pause writes; null for pages that are not http(s) sites. */
  pauseKey: string | null;
  /** An allowlist key matches the page (blocking is off there). */
  allowlisted: boolean;
  /** The allowlist keys Resume removes (at least as specific as pauseKey). */
  removable: string[];
  /** A broader allowlist key that still matches after Resume: shown instead of Resume. */
  broader: string | null;
  /** The per-site rule key that applies to the page, if any. */
  ruleKey: string | null;
  /** The per-site rule the switches write: `ruleKey` when it is at least as specific as `pauseKey`, else `pauseKey`. */
  switchKey: string | null;
  /** Effective switches on this page (per-site rule, else global). */
  switches: Record<SiteSwitch, boolean>;
}

export function shieldSite(top: string, ext: Pick<Ext, 'allowlist' | 'perSite' | 'enabled'>, fns: SiteFns): ShieldSite {
  const keys = siteKeysFor(top);
  const pauseKey = fns.siteKeyOf(top);
  const allow = new Set(ext.allowlist);
  const matching = keys.filter((k) => allow.has(k));
  const cut = pauseKey === null ? -1 : keys.indexOf(pauseKey);
  // Keys up to the pause key in siteKeysFor's order (most specific first) are at least as specific as it.
  const removable = cut < 0 ? [] : matching.filter((k) => keys.indexOf(k) <= cut);
  const broader = matching.find((k) => !removable.includes(k)) ?? null;
  const ruleKey = keys.find((k) => Object.prototype.hasOwnProperty.call(ext.perSite, k)) ?? null;
  const rule = ruleKey ? ext.perSite[ruleKey] : undefined;
  const switches = {} as Record<SiteSwitch, boolean>;
  for (const s of SITE_SWITCHES) switches[s] = rule?.[s] ?? ext.enabled[s];
  const switchKey = ruleKey !== null && cut >= 0 && keys.indexOf(ruleKey) <= cut ? ruleKey : (pauseKey ?? ruleKey);
  return { pauseKey, allowlisted: matching.length > 0, removable, broader, ruleKey, switchKey, switches };
}

/** The allowlist after Pause. */
export function pauseAllowlist(allowlist: readonly string[], key: string): string[] {
  return allowlist.includes(key) ? [...allowlist] : [...allowlist, key];
}

/** The allowlist after Resume (only the removable keys go). */
export function resumeAllowlist(allowlist: readonly string[], removable: readonly string[]): string[] {
  const drop = new Set(removable);
  return allowlist.filter((k) => !drop.has(k));
}

/** The per-site map after a switch on the popover changed (it writes `site.switchKey`, see the header). */
export function setSiteSwitch(ext: Pick<Ext, 'perSite' | 'enabled'>, site: Pick<ShieldSite, 'ruleKey' | 'switchKey'>, which: SiteSwitch, on: boolean): Ext['perSite'] | null {
  const key = site.switchKey;
  if (key === null) return null;
  const own = Object.prototype.hasOwnProperty.call(ext.perSite, key) ? ext.perSite[key] : undefined;
  // A broader rule applied until now: the site's own rule starts from its values, so only `which` changes here.
  const from = own ?? (site.ruleKey !== null && site.ruleKey !== key ? ext.perSite[site.ruleKey] : undefined);
  const cur = { ...(from ?? {}) };
  if (on === ext.enabled[which]) delete cur[which];
  else cur[which] = on;
  const next = { ...ext.perSite };
  if (Object.keys(cur).length) next[key] = cur;
  else delete next[key];
  return next;
}

/** The key the blocked page's "Turn off blocking on <key>" writes. */
export function blockedPageKey(url: string, fns: SiteFns): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  const site = fns.siteOf(url);
  if (site === null) return null;
  if (host === site || host === `www.${site}`) return fns.siteKeyOf(url);
  return host;
}
