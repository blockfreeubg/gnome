/**
 * Host-keyed site rules: the key syntax and how a URL finds its rule. Used by the app (popup decisions, the
 * permissions it resolves for every GNOME-initiated load, Settings) and by the engine host (the tab iframe's `allow`
 * attribute; the content blocker's allowlist, per-site and cookie rules in Wave B step 3), so both sides agree on
 * which rule applies. Pure, no dependencies, no side effects.
 *
 * Keys (lower case, as Settings stores them; same syntax as src/settings/validate.ts `isHostKey`):
 * - `example.com`        exactly that host (any port)
 * - `example.com:8080`   that host on that port only
 * - `*.example.com`      example.com itself and every subdomain
 * - `[2001:db8::1]`      an IPv6 literal (wildcards never apply to IP addresses)
 *
 * Precedence for a URL: `host:port` (only when the URL names a port) > `host` > the most specific wildcard
 * (`*.a.example.com` before `*.example.com` before `*.com`).
 */

import { ENGINE_PERMISSIONS, isHostKey } from './engine-protocol.ts';
import type { EnginePermission, EnginePermissionSet, PermissionDecision } from './engine-protocol.ts';

export { HOST_KEY_RE, isHostKey } from './engine-protocol.ts';

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Candidate rule keys for a URL, most specific first; [] for anything that is not an http(s) URL with a host. */
export function siteKeysFor(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return [];
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return [];
  const keys: string[] = [];
  if (u.port) keys.push(`${host}:${u.port}`);
  keys.push(host);
  if (host.startsWith('[') || IPV4_RE.test(host)) return keys;
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) keys.push(`*.${labels.slice(i).join('.')}`);
  return keys;
}

/** The rule that applies to `url`, or undefined. Only own keys count (`__proto__` and friends never match). */
export function ruleFor<T>(rules: Readonly<Record<string, T>>, url: string): T | undefined {
  for (const key of siteKeysFor(url)) {
    if (Object.prototype.hasOwnProperty.call(rules, key)) return rules[key];
  }
  return undefined;
}

/** Whether `url` matches any key of a host list (e.g. the content blocker's allowlist). */
export function inHostList(list: readonly string[], url: string): boolean {
  if (list.length === 0) return false;
  const set = new Set(list);
  return siteKeysFor(url).some((k) => set.has(k));
}

// ── Permissions the engine host enforces ─────────────────────────────────────────────────────────────────────────

export type PermissionSetting = 'ask' | 'allow' | 'block';

/**
 * What a stored `ask` means for the permissions the engine host enforces. v1 has no prompt for them: autoplay is
 * blocked, element fullscreen and clipboard writes behave as in a normal browser (allowed after a user gesture in the
 * page; clipboard reads are never delegated). Settings offers only allow/block for these three, and only for those the
 * engine host enforces in this browser (InitResult.enforcedPermissions).
 */
export const ENGINE_PERMISSION_ASK: Readonly<EnginePermissionSet> = {
  autoplay: 'block',
  fullscreen: 'allow',
  clipboard: 'allow',
};

/**
 * App side only: the user's settings resolved for the engine-enforced permissions. The app keeps this and sends the
 * engine host only the decisions for each destination it loads (enginePermissionsFor), never the per-site list.
 */
export interface ResolvedPermissions {
  defaults: EnginePermissionSet;
  sites: Record<string, Partial<EnginePermissionSet>>;
}

const resolve = (p: EnginePermission, v: PermissionSetting | undefined): PermissionDecision | undefined =>
  v === undefined ? undefined : v === 'ask' ? ENGINE_PERMISSION_ASK[p] : v;

/**
 * Builds ResolvedPermissions from the app settings (`privacy.defaultPermissions` / `sitePermissions`): only the
 * engine-enforced permissions, `ask` resolved, sites without an engine-enforced entry left out.
 */
export function resolveEnginePermissions(
  defaults: Readonly<Partial<Record<string, PermissionSetting>>>,
  sites: Readonly<Record<string, Readonly<Partial<Record<string, PermissionSetting>>>>>,
): ResolvedPermissions {
  const out: ResolvedPermissions = {
    defaults: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' },
    sites: {},
  };
  for (const p of ENGINE_PERMISSIONS) out.defaults[p] = resolve(p, defaults[p]) ?? ENGINE_PERMISSION_ASK[p];
  for (const host of Object.keys(sites)) {
    if (!isHostKey(host)) continue;
    const entry: Partial<EnginePermissionSet> = {};
    for (const p of ENGINE_PERMISSIONS) {
      const v = resolve(p, sites[host]?.[p]);
      if (v) entry[p] = v;
    }
    if (Object.keys(entry).length) out.sites[host] = entry;
  }
  return out;
}

/** The decision for one engine-enforced permission at `url` (per-site entry, else the default). */
export function enginePermissionFor(perms: ResolvedPermissions, p: EnginePermission, url: string): PermissionDecision {
  for (const key of siteKeysFor(url)) {
    const entry = Object.prototype.hasOwnProperty.call(perms.sites, key) ? perms.sites[key] : undefined;
    const v = entry?.[p];
    if (v) return v;
  }
  return perms.defaults[p];
}

/** App: the `permissions` of a tab.create / tab.navigate / tab.go / tab.reload command loading `url`. */
export function enginePermissionsFor(perms: ResolvedPermissions, url: string): EnginePermissionSet {
  return {
    autoplay: enginePermissionFor(perms, 'autoplay', url),
    fullscreen: enginePermissionFor(perms, 'fullscreen', url),
    clipboard: enginePermissionFor(perms, 'clipboard', url),
  };
}

/** Permissions-policy feature names of the engine-enforced permissions. */
export const PERMISSION_FEATURES: Readonly<Record<EnginePermission, string>> = {
  autoplay: 'autoplay',
  fullscreen: 'fullscreen',
  clipboard: 'clipboard-write',
};

/**
 * Engine host: the `allow` attribute of a tab iframe before a GNOME-initiated load. A tab frame is same-origin with
 * the engine host, so a feature left out would be allowed by its default allowlist (`'self'`): `block` is therefore
 * written as `<feature> 'none'`. Permissions this browser cannot enforce (not in `enforced`) are allowed, as in a
 * normal browser.
 */
export function tabFrameAllow(perms: EnginePermissionSet, enforced: readonly EnginePermission[]): string {
  return ENGINE_PERMISSIONS.map((p) =>
    enforced.includes(p) && perms[p] === 'block' ? `${PERMISSION_FEATURES[p]} 'none'` : PERMISSION_FEATURES[p],
  ).join('; ');
}

/** The browser engines the enforcement table below tells apart. */
export type BrowserFamily = 'chromium' | 'gecko' | 'other';

/**
 * Site permissions the engine host enforces per browser (InitResult.enforcedPermissions), each only after its e2e test
 * passed in that browser with both engines (host-capabilities `permission:*`: `<feature> 'none'` blocks it, the next
 * load with the feature allowed lifts it; `permission:InitResult…` checks that this list is exactly what passed).
 * Chromium enforces fullscreen and autoplay. Clipboard is enforced nowhere (integration part 2, security review):
 * Chromium's `clipboard-write 'none'` refuses only the asynchronous Clipboard API, while `document.execCommand('copy')`
 * on a click, which most sites use, still writes; so no browser gets a Clipboard switch that would promise a block.
 * Firefox 157 implements neither the `autoplay` nor the `clipboard-write` permissions policy (it logs "Skipping
 * unsupported feature name" for both; a blocked page still plays and writes).
 * The app applies the same table to what the engine host reports (`trustedEnforcedPermissions`): an engine host
 * that a hostile page controls (ENGINE-PROTOCOL §1.1) must not make Settings offer a block this browser cannot do.
 */
export const ENFORCED_PERMISSIONS: Readonly<Record<BrowserFamily, readonly EnginePermission[]>> = {
  chromium: ['fullscreen', 'autoplay'],
  gecko: ['fullscreen'],
  other: [],
};

/**
 * The browser engine, for the per-browser enforcement table: the User-Agent token checked against a feature only that
 * engine has (Blink's `document.featurePolicy`, Gecko's `mozInnerScreenX`), so a spoofed User-Agent falls to 'other'
 * (nothing enforced) rather than claiming enforcement. "HeadlessChrome/" counts as Chromium. The defaults are read
 * when it is called (never at import time).
 */
export function browserFamily(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  doc: object | null = typeof document === 'undefined' ? null : document,
  win: object | null = typeof window === 'undefined' ? null : window,
): BrowserFamily {
  if (/\bFirefox\//.test(ua) && win !== null && 'mozInnerScreenX' in win) return 'gecko';
  if (/Chrom(?:e|ium)\/\d/.test(ua) && doc !== null && 'featurePolicy' in doc) return 'chromium';
  return 'other';
}

/**
 * App side: the permissions the app offers allow/block for, i.e. what the engine host claims (InitResult) and this
 * browser can enforce (ENFORCED_PERMISSIONS of the app's own browserFamily()), in ENGINE_PERMISSIONS order.
 */
export function trustedEnforcedPermissions(claimed: readonly EnginePermission[], family: BrowserFamily): EnginePermission[] {
  const can = ENFORCED_PERMISSIONS[family];
  return ENGINE_PERMISSIONS.filter((p) => claimed.includes(p) && can.includes(p));
}

// ── Popups (decided by the app for tab.openRequest) ──────────────────────────────────────────────────────────────

export type OpenDecision = { action: 'open'; background: boolean } | { action: 'blocked' } | { action: 'ask' };

/**
 * The app's answer to a valid, rate-admitted `tab.openRequest` (docs/ENGINE-PROTOCOL.md §6.3):
 * - with a user gesture the tab opens: `background` disposition in the background, `foreground`/`popup` in front
 *   unless `browser.openLinksInBackground` is on. A gesture needs both the engine host's claim (`userActivation`)
 *   and the app's own document having transient activation (`appActivation`: activation propagates to ancestor
 *   documents). The claim alone never counts: after an escape the engine host can say anything, so a browser without
 *   `navigator.userActivation` (`appActivation` null) gets no gesture (fail closed);
 * - without one, the opener site's `popups` permission decides: allow → a background tab, block → the toolbar's
 *   "pop-up blocked" indicator (opening from there is a gesture in GNOME's own UI), ask → the same indicator with
 *   Allow / Block for the site.
 */
export function decideOpen(input: {
  disposition: 'foreground' | 'background' | 'popup';
  userActivation: boolean;
  appActivation: boolean | null;
  popups: PermissionSetting;
  openLinksInBackground: boolean;
}): OpenDecision {
  const gesture = input.userActivation && input.appActivation === true;
  if (gesture) {
    const background = input.disposition === 'background' || (input.disposition === 'foreground' && input.openLinksInBackground);
    return { action: 'open', background };
  }
  if (input.popups === 'allow') return { action: 'open', background: true };
  return input.popups === 'ask' ? { action: 'ask' } : { action: 'blocked' };
}
