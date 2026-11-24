/**
 * The `EngineSettings` snapshot (ENGINE-PROTOCOL §4): what the engine host gets from the user's settings and
 * `/api/config`, and nothing else (§1.2 rules 4–5: a hostile page in the engine host can read all of it).
 *
 * Every value it produces is one the protocol validator accepts, so a saved setting can never make `init` fail
 * (a property test checks it over random settings): combos in canonical form and each once (`isCombo`), Wisp servers
 * filtered with `isWispServer`, the content blocker's per-site maps empty until the engine host reports the `blocker`
 * capability.
 *
 * Content blocking (WAVE-B3 §7.1, D5): `lists` = the refs `filterListRefs()` built from the app's `/api/filters`
 * listing, always (public data, so `init` can load a cached set at once; an engine host without `blocker` ignores
 * them, D19); `allowlist`/`perSite` = the scoped maps of the app page's SiteExposure (only sites the engine host shows
 * or is about to load) once the engine host reported `blocker`, else empty; `cookieRules` whole while `blocker` is
 * reported and the cookie manager is on (cookie rules apply to any third party on any page, so they cannot be
 * scoped), else `{}`; `cacheLimitMB` = `performance.cacheLimitMB`.
 *
 * Route (§4, §6.6): `profile` while `vpn.mode` is `gateway` (the VPN always wins: custom servers would bypass it);
 * else `custom` when the operator allows custom servers (`/api/config` → wisp.custom_servers) and
 * `browser.wispServers` has entries; else `default`. The app enforces the VPN kill switch by choosing the route:
 * with the kill switch on it never leaves the profile route, and WebRTC is forced to `block`.
 */
import { engineChoice, isCombo, isWispServer, LIMITS, type EngineSettings, type FilterListRef, type WispRoute } from '../../shared/engine-protocol';
import type { ScopedMaps } from '../../extensions/app/exposure';
import type { ServerConfig } from '../../lib/api';
import { normalizeCombo } from '../../lib/keys';
import type { Settings } from '../../settings/schema';

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Route id used while the VPN is on with the kill switch but no location exists to route through (none chosen and
 * the server offers none): the engine host's probe of `/wisp/p/<id>/` answers 404 (`unknown-profile`), so nothing
 * loads, which is what the kill switch promises. The VPN page names the problem.
 */
export const NO_VPN_LOCATION = 'no-location';

export interface SnapshotContext {
  config: ServerConfig | null;
  /** The engine host reported the `blocker` capability (Wave B step 3): only then are the per-site maps sent. */
  blocker: boolean;
  apple: boolean;
  /** `/api/vpn/locations` statuses by profile id, when the app has them (vpn/state.svelte.ts statusMap(), D14). */
  vpnStatus?: Readonly<Record<string, 'up' | 'down' | 'unknown'>>;
  /** The Automatic location this app page pinned (D17): kept while it is offered and not `down`. */
  autoPinned?: string | null;
  /** The filter-list refs (extensions/app/lists.ts filterListRefs); none while the app has no listing. */
  lists?: readonly FilterListRef[];
  /** The app page's site exposure (WAVE-B3 D5): which allowlist/per-site entries may travel. Without it, none do. */
  scope?: { scoped(maps: Pick<Settings['extensions'], 'allowlist' | 'perSite'>): ScopedMaps };
}

/** `performance.cacheLimitMB` within the protocol's range (16–8192 MiB, the settings range). */
export function cacheLimitOf(s: Settings): number {
  const v = Math.round(s.performance.cacheLimitMB);
  return Number.isFinite(v) ? Math.min(8192, Math.max(16, v)) : 256;
}

export interface RouteChoice {
  route: WispRoute;
  /** The VPN is on but its location is down and the kill switch is off: the default route is used instead. */
  vpnFellBack: boolean;
  /** Custom servers are set but not used (the VPN is on, or the operator does not allow them). */
  customIgnored: 'vpn' | 'operator' | null;
  /** With the Automatic location (`preferredLocation` null): the location it picked (the app page pins it), else null. */
  autoPicked: string | null;
}

export function chooseRoute(s: Settings, ctx: SnapshotContext): RouteChoice {
  const servers = uniqueWispServers(s.browser.wispServers);
  if (s.vpn.mode === 'gateway') {
    const offered = (ctx.config?.wisp.profiles.map((p) => p.id) ?? []).filter((p) => PROFILE_ID_RE.test(p));
    const preferred = s.vpn.preferredLocation;
    const status = (id: string): 'up' | 'down' | 'unknown' => ctx.vpnStatus?.[id] ?? 'unknown';
    let id: string | null;
    let autoPicked: string | null = null;
    if (preferred && PROFILE_ID_RE.test(preferred)) {
      // A chosen location is never replaced by another one (D17).
      id = preferred;
    } else {
      // Automatic (D17): the pinned one while offered and not down; else the first one up; else the first offered.
      const pinned = ctx.autoPinned ?? null;
      id =
        (pinned !== null && offered.includes(pinned) && status(pinned) !== 'down' ? pinned : null) ??
        offered.find((p) => status(p) === 'up') ??
        offered[0] ??
        null;
      autoPicked = id;
    }
    // A location the server no longer offers (/api/config, refreshed after `unknown-profile`) is as unavailable as
    // one /api/vpn/locations reports down.
    const available = id !== null && (!ctx.config || offered.includes(id)) && ctx.vpnStatus?.[id] !== 'down';
    const customIgnored = servers.length ? 'vpn' : null;
    // The kill switch never leaves the profile route: an unavailable location then loads nothing, as it promises.
    if (s.vpn.killSwitch) return { route: { kind: 'profile', id: id ?? NO_VPN_LOCATION }, vpnFellBack: false, customIgnored, autoPicked };
    if (available && id !== null) return { route: { kind: 'profile', id }, vpnFellBack: false, customIgnored, autoPicked };
    return { route: { kind: 'default' }, vpnFellBack: true, customIgnored, autoPicked: null };
  }
  if (servers.length && ctx.config?.wisp.custom_servers) return { route: { kind: 'custom', servers }, vpnFellBack: false, customIgnored: null, autoPicked: null };
  return { route: { kind: 'default' }, vpnFellBack: false, customIgnored: servers.length ? 'operator' : null, autoPicked: null };
}

/** `browser.wispServers` entries the protocol accepts, in order, each once, at most LIMITS.maxWispServers. */
export function uniqueWispServers(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of list) {
    if (out.length >= LIMITS.maxWispServers) break;
    if (isWispServer(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The bound combos of `browser.shortcuts` in canonical form, each once (two actions on one combo send it once). */
export function shortcutCombos(shortcuts: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  for (const raw of Object.values(shortcuts)) {
    if (!raw) continue;
    const c = normalizeCombo(raw);
    if (c && isCombo(c)) out.add(c);
    if (out.size >= LIMITS.maxCombos) break;
  }
  return [...out];
}

export function buildEngineSettings(s: Settings, ctx: SnapshotContext): EngineSettings {
  const engines = { scramjet: ctx.config?.engines.scramjet ?? true, ultraviolet: ctx.config?.engines.ultraviolet ?? true };
  const vpnLocked = s.vpn.mode === 'gateway' && s.vpn.killSwitch;
  const scoped = ctx.blocker && ctx.scope ? ctx.scope.scoped(s.extensions) : { allowlist: [], perSite: {} };
  const cookieRules = ctx.blocker && s.extensions.enabled.cookies ? s.extensions.cookieRules : {};
  return {
    engines,
    engine: engineChoice(s.browser.engine, ctx.config?.engines.default ?? 'scramjet', engines),
    autoFallback: s.browser.autoFallback,
    transport: s.browser.transport,
    route: chooseRoute(s, ctx).route,
    privacy: {
      webrtc: vpnLocked ? 'block' : s.privacy.webrtc,
      sendGpc: s.privacy.sendGpc,
      doNotTrack: s.privacy.doNotTrack,
      referrer: s.privacy.referrer,
      stripTrackingParams: s.privacy.stripTrackingParams,
      cookies: s.browser.cookies.mode,
    },
    extensions: {
      enabled: { ...s.extensions.enabled },
      // Filter-list references (public: id + sha256 from /api/filters) always; the per-site maps only once the engine
      // host runs a content blocker (capability `blocker`), scoped to the sites it shows (WAVE-B3 D5).
      lists: (ctx.lists ?? []).slice(0, LIMITS.maxFilterLists).map((r) => ({ ...r })),
      allowlist: [...new Set(scoped.allowlist)].slice(0, LIMITS.maxSiteRules),
      perSite: Object.fromEntries(Object.entries(scoped.perSite).slice(0, LIMITS.maxSiteRules)),
      cosmeticAggressive: s.extensions.cosmeticAggressive,
      cookieRules: Object.fromEntries(Object.entries(cookieRules).slice(0, LIMITS.maxSiteRules)),
      cacheLimitMB: cacheLimitOf(s),
    },
    keys: { combos: shortcutCombos(s.browser.shortcuts), apple: ctx.apple },
  };
}
