/**
 * The app side of the filter lists (WAVE-B3 §7.1): the `/api/filters` listing as GNOME's own server publishes it
 * (docs/API.md "Content-blocking filter lists"), and `filterListRefs()`, the exact rule that turns the listing and the
 * user's settings into `EngineSettings.extensions.lists` (the lists the engine host downloads and compiles).
 *
 * Pure (no storage, no DOM): `listing.svelte.ts` keeps the listing in IndexedDB and refreshes it; the Extensions page
 * and Settings read names, licenses and publishers from it. List names shown anywhere in GNOME's UI come from this
 * listing, never from the engine host (WAVE-B3 C5).
 */
import type { FilterCategory, FilterListRef } from '../../shared/engine-protocol';
import type { Settings } from '../../settings/schema';
import { GROUP_OF, TOGGLE_OF } from '../core/categories';

/** GET /api/filters → FilterList (docs/API.md). */
export interface ServerFilterList {
  id: string;
  name: string;
  category: 'ads' | 'privacy' | 'annoyances' | 'cookies' | 'urlparams' | 'security' | 'resources';
  format: 'abp' | 'resources';
  license: string;
  homepage: string;
  default_enabled: boolean;
  trusted: boolean;
  available: boolean;
  size: number;
  sha256: string | null;
  updated_at: number | null;
  fetched_at: number | null;
  version: string | null;
}
export interface ServerListing {
  lists: ServerFilterList[];
  resources: ServerFilterList | null;
}

/** The engine protocol's list id and hash syntax (engine-protocol.ts `ID_RE`, `SHA256_RE`): refs that do not fit are left out. */
const LIST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** LIMITS.maxFilterLists: the snapshot validator accepts at most this many refs. */
const MAX_REFS = 500;

const CATEGORIES: readonly ServerFilterList['category'][] = ['ads', 'privacy', 'annoyances', 'cookies', 'urlparams', 'security', 'resources'];

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** One entry of the server's answer, or null when it is not one this app can use (the server is GNOME's own, but its answer is still input). */
export function parseServerList(v: unknown): ServerFilterList | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id, 64) || !LIST_ID_RE.test(o.id) || !str(o.name, 300) || !o.name.trim()) return null;
  if (typeof o.category !== 'string' || !(CATEGORIES as readonly string[]).includes(o.category)) return null;
  const format = o.format === 'resources' ? 'resources' : o.format === 'abp' ? 'abp' : null;
  if (format === null) return null;
  const sha = typeof o.sha256 === 'string' && SHA256_RE.test(o.sha256) ? o.sha256 : null;
  return {
    id: o.id,
    name: o.name.trim(),
    category: o.category as ServerFilterList['category'],
    format,
    license: str(o.license, 200) ? o.license : '',
    homepage: str(o.homepage, 2048) ? o.homepage : '',
    default_enabled: o.default_enabled === true,
    trusted: o.trusted === true,
    available: o.available !== false && sha !== null,
    size: num(o.size) ? Math.floor(o.size) : 0,
    sha256: sha,
    updated_at: num(o.updated_at) ? o.updated_at : null,
    fetched_at: num(o.fetched_at) ? o.fetched_at : null,
    version: str(o.version, 200) ? o.version : null,
  };
}

/** The whole `GET /api/filters` body; entries this app cannot use are dropped, duplicate ids keep the first. */
export function parseServerListing(v: unknown): ServerListing | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.lists)) return null;
  const seen = new Set<string>();
  const lists: ServerFilterList[] = [];
  for (const raw of o.lists.slice(0, 2 * MAX_REFS)) {
    const l = parseServerList(raw);
    if (!l || l.category === 'resources' || l.format !== 'abp' || seen.has(l.id)) continue;
    seen.add(l.id);
    lists.push(l);
  }
  const r = o.resources === null || o.resources === undefined ? null : parseServerList(o.resources);
  return { lists, resources: r && r.format === 'resources' && r.category === 'resources' ? r : null };
}

/** Whether a list is on: the user's choice (settings stores only deviations), else the server's default. */
export function listEnabled(l: Pick<ServerFilterList, 'id' | 'default_enabled'>, choices: Readonly<Record<string, boolean>>): boolean {
  return Object.prototype.hasOwnProperty.call(choices, l.id) ? choices[l.id] === true : l.default_enabled;
}

/**
 * Whether the group of a list category can apply anywhere: its toggle on globally or in a per-site override; for
 * URL-parameter lists, privacy protection with "Remove tracking parameters" (no per-site switch exists for them).
 */
export function categoryCanApply(category: Exclude<FilterCategory, 'resources'>, s: Pick<Settings, 'extensions' | 'privacy'>): boolean {
  const e = s.extensions;
  // WAVE-B3 D1/D2: the list's group engine and the switch that governs it.
  const toggle = TOGGLE_OF[GROUP_OF[category]];
  if (toggle === 'privacy') return e.enabled.privacy && s.privacy.stripTrackingParams;
  if (e.enabled[toggle]) return true;
  for (const rule of Object.values(e.perSite)) if (rule[toggle] === true) return true;
  return false;
}

const toRef = (l: ServerFilterList): FilterListRef => ({
  id: l.id,
  sha256: l.sha256!,
  category: l.category,
  format: l.format,
  trusted: l.trusted,
});

/**
 * The lists the engine host compiles: available ones with a hash that are on (the user's choice, else the server's
 * default) and whose group can apply somewhere (its toggle on globally or in a per-site override; params: privacy
 * protection with "Remove tracking parameters"), sorted by id; plus `ubo-resources` when any list is in. Lists the
 * blockers cannot use are not downloaded or built.
 */
export function filterListRefs(listing: ServerListing, s: Pick<Settings, 'extensions' | 'privacy'>): FilterListRef[] {
  const out: FilterListRef[] = [];
  for (const l of listing.lists) {
    if (l.category === 'resources' || l.format !== 'abp' || !l.available || l.sha256 === null) continue;
    if (!listEnabled(l, s.extensions.lists)) continue;
    if (!categoryCanApply(l.category, s)) continue;
    out.push(toRef(l));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const r = listing.resources;
  const refs = out.slice(0, r ? MAX_REFS - 1 : MAX_REFS);
  if (refs.length && r && r.available && r.sha256 !== null && !refs.some((x) => x.id === r.id)) {
    refs.push(toRef(r));
    refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return refs;
}

/** Plain names for the list categories (Settings and the Extensions page group by them). */
export const CATEGORY_LABELS: Readonly<Record<Exclude<FilterCategory, 'resources'>, string>> = {
  ads: 'Ads',
  privacy: 'Trackers',
  security: 'Scam and malware sites',
  urlparams: 'Tracking parameters',
  cookies: 'Cookie notices',
  annoyances: 'Annoyances',
};
export const CATEGORY_ORDER: readonly Exclude<FilterCategory, 'resources'>[] = ['ads', 'privacy', 'security', 'urlparams', 'cookies', 'annoyances'];

/** A publisher link the UI may show: http(s) only. */
export function safeHref(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
