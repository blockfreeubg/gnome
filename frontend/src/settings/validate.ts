/**
 * Settings validation, versioned migrations, deep-merge with defaults, and JSON import/export.
 *
 * Loading never throws: anything invalid or missing falls back to the default for that key, unknown keys are
 * dropped, and every correction is reported as an issue (shown after an import).
 */
import { normalizeCombo } from '../lib/keys';
import { isCombo, isHostKey as isProtocolHostKey, isWispServer, LIMITS } from '../shared/engine-protocol';
import { createDefaultSettings } from './defaults';
import {
  CURRENT_SETTINGS_VERSION,
  SHORTCUT_ACTIONS,
  SITE_PERMISSIONS,
  type Settings,
  type SettingsSection,
} from './schema';

export interface SettingsIssue {
  path: string;
  message: string;
}

// ── Spec DSL ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Spec =
  | { t: 'bool' }
  | { t: 'num'; min: number; max: number; int?: boolean; decimals?: number }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'str'; max: number; test?: (s: string) => boolean; trim?: boolean }
  | { t: 'hex' }
  | { t: 'combo' }
  | { t: 'literal'; value: string | number | boolean }
  | { t: 'nullable'; inner: Spec }
  | { t: 'array'; item: Spec; max: number; unique?: boolean }
  | { t: 'record'; key: (k: string) => boolean; value: Spec; max: number }
  | { t: 'partial'; shape: Readonly<Record<string, Spec>> }
  | { t: 'object'; shape: Readonly<Record<string, Spec>> };

const bool = (): Spec => ({ t: 'bool' });
const num = (min: number, max: number, opts: { int?: boolean; decimals?: number } = {}): Spec => ({
  t: 'num',
  min,
  max,
  ...opts,
});
const oneOf = (...values: string[]): Spec => ({ t: 'enum', values });
const str = (max: number, test?: (s: string) => boolean): Spec => ({ t: 'str', max, ...(test ? { test } : {}) });
const hex = (): Spec => ({ t: 'hex' });
/** Keyboard combo, stored in canonical form ("shift+alt+t" → "Alt+Shift+T"); '' = unbound. */
const combo = (): Spec => ({ t: 'combo' });
const literal = (value: string | number | boolean): Spec => ({ t: 'literal', value });
const nullable = (inner: Spec): Spec => ({ t: 'nullable', inner });
const array = (item: Spec, max: number, unique = true): Spec => ({ t: 'array', item, max, unique });
const record = (key: (k: string) => boolean, value: Spec, max: number): Spec => ({ t: 'record', key, value, max });
const partial = (shape: Record<string, Spec>): Spec => ({ t: 'partial', shape });
const object = (shape: Record<string, Spec>): Spec => ({ t: 'object', shape });

/**
 * Host keys, browser.wispServers entries and shortcut combos use the engine protocol's own checks
 * (src/shared/engine-protocol.ts), so a saved value always fits the protocol and the snapshot sent to the engine host.
 */
export const isHostKey = (k: string): boolean => isProtocolHostKey(k);
const isListId = (k: string): boolean => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k);
const isSlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
const isHttpUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};
const isStartUrl = (s: string): boolean => isHttpUrl(s) || /^gnome:\/\/[a-z0-9/_-]*$/i.test(s);
/** '' (unset) or an http(s) URL template containing %s. */
export const isSearchTemplate = (s: string): boolean => s === '' || (s.includes('%s') && isHttpUrl(s.replace(/%s/g, 'x')));

const PERMISSION_VALUE = oneOf('ask', 'allow', 'block');
const permissionShape = Object.fromEntries(SITE_PERMISSIONS.map((p) => [p, PERMISSION_VALUE]));

const SETTINGS_SPEC: Spec = object({
  version: literal(CURRENT_SETTINGS_VERSION),
  appearance: object({
    theme: oneOf('dark', 'light', 'system'),
    accentPreset: oneOf('mint', 'periwinkle', 'wheat', 'moss', 'lichen', 'ember', 'slate', 'mushroom', 'fern', 'custom'),
    accent: hex(),
    colors: object({
      background: nullable(hex()),
      surface: nullable(hex()),
      text: nullable(hex()),
      mutedText: nullable(hex()),
      border: nullable(hex()),
    }),
    fontFamily: oneOf('inter', 'montserrat', 'geist', 'system', 'atkinson', 'fraunces', 'mono'),
    fontSize: num(12, 20, { int: true }),
    density: oneOf('compact', 'comfortable', 'spacious'),
    transparency: num(0.55, 1, { decimals: 2 }),
    reduceTransparency: bool(),
    blur: num(0, 40, { int: true }),
    animation: oneOf('none', 'reduced', 'normal', 'expressive'),
    radius: num(0, 16, { int: true }),
    sidebar: oneOf('auto', 'expanded', 'compact', 'hidden'),
    sidebarPosition: oneOf('left', 'right'),
    toolbar: oneOf('full', 'compact'),
    tabStrip: oneOf('top', 'hidden-when-single'),
    showBookmarksBar: bool(),
    homeBackground: object({
      kind: oneOf('wallpaper', 'glow', 'none', 'color', 'gradient', 'image'),
      value: str(4096),
      dim: num(0, 0.9, { decimals: 2 }),
      blur: num(0, 40, { int: true }),
    }),
  }),
  browser: object({
    searchEngine: oneOf('duckduckgo', 'google', 'bing', 'brave', 'startpage', 'ecosia', 'custom'),
    customSearchUrl: str(2048, isSearchTemplate),
    searchSuggestions: bool(),
    engine: oneOf('auto', 'scramjet', 'ultraviolet'),
    autoFallback: bool(),
    transport: oneOf('libcurl', 'epoxy'),
    wispServers: array(str(LIMITS.maxWsUrlLength, isWispServer), LIMITS.maxWispServers),
    homepage: str(4096, isStartUrl),
    startup: oneOf('home', 'restore', 'urls'),
    startupUrls: array(str(4096, isStartUrl), 50),
    newTab: oneOf('home', 'blank', 'url'),
    newTabUrl: str(4096, (s) => s === '' || isStartUrl(s)),
    openLinksInBackground: bool(),
    closeTabActivates: oneOf('right', 'left', 'last-used'),
    confirmCloseMultiple: bool(),
    history: object({ enabled: bool(), retentionDays: num(0, 3650, { int: true }) }),
    cookies: object({ mode: oneOf('all', 'block-third-party', 'block-all'), clearOnExit: bool() }),
    downloads: object({ track: bool(), openPanelOnStart: bool(), keepDays: num(0, 3650, { int: true }) }),
    shortcuts: object(Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, combo()]))),
    defaultZoom: num(0.5, 2, { decimals: 2 }),
  }),
  privacy: object({
    webrtc: oneOf('block', 'allow'),
    stripTrackingParams: bool(),
    sendGpc: bool(),
    doNotTrack: bool(),
    referrer: oneOf('default', 'origin-cross-site', 'none'),
    clearHistoryOnExit: bool(),
    clearSiteDataOnExit: bool(),
    sitePermissions: record(isHostKey, partial(permissionShape), 5000),
    defaultPermissions: object(permissionShape),
  }),
  performance: object({
    gpuEffects: bool(),
    memorySaver: bool(),
    discardAfterMinutes: num(1, 1440, { int: true }),
    backgroundTabs: oneOf('keep-alive', 'discard'),
    prefetchPages: bool(),
    cacheLimitMB: num(16, 8192, { int: true }),
  }),
  vpn: object({
    mode: oneOf('off', 'gateway'),
    preferredLocation: nullable(str(64, isListId)),
    autoConnect: bool(),
    killSwitch: bool(),
    verifyExit: bool(),
  }),
  games: object({
    view: oneOf('grid', 'list'),
    cardSize: oneOf('small', 'medium', 'large'),
    defaultSort: oneOf('popular', 'trending', 'new', 'az'),
    fullscreenOnPlay: bool(),
    trackRecent: bool(),
    recentLimit: num(0, 500, { int: true }),
    showMobileOnly: bool(),
    hiddenCategories: array(str(64, isSlug), 200),
  }),
  extensions: object({
    enabled: object({ adblock: bool(), trackers: bool(), privacy: bool(), cookies: bool(), cosmetic: bool() }),
    lists: record(isListId, bool(), 500),
    allowlist: array(str(260, isHostKey), 5000),
    perSite: record(isHostKey, partial({ adblock: bool(), trackers: bool(), cosmetic: bool() }), 5000),
    cosmeticAggressive: bool(),
    autoUpdateLists: bool(),
    cookieRules: record(isHostKey, oneOf('allow', 'session', 'block'), 5000),
  }),
  account: object({ sync: bool(), syncHistory: bool(), syncBookmarks: bool(), syncSettings: bool() }),
});

/**
 * Keys removed from the schema without a version bump. Stored settings or imports that still contain them load
 * cleanly: the key is dropped silently (not reported as an issue) and disappears from storage on the next save.
 * - `games.playMode` (2026-11-10): publisher game embeds are never proxied (docs/ARCHITECTURE.md §6).
 */
export const RETIRED_KEYS: ReadonlySet<string> = new Set(['games.playMode']);

// ── Walker ───────────────────────────────────────────────────────────────────────────────────────────────────────

const INVALID: unique symbol = Symbol('invalid');
type Checked = unknown | typeof INVALID;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function check(spec: Spec, input: unknown, path: string, issues: SettingsIssue[]): Checked {
  switch (spec.t) {
    case 'bool':
      return typeof input === 'boolean' ? input : INVALID;
    case 'num': {
      if (typeof input !== 'number' || !Number.isFinite(input)) return INVALID;
      let v = input;
      if (spec.int) v = Math.round(v);
      else if (spec.decimals !== undefined) v = Number(v.toFixed(spec.decimals));
      if (v < spec.min || v > spec.max) {
        const clamped = Math.min(spec.max, Math.max(spec.min, v));
        issues.push({ path, message: `out of range (${spec.min}–${spec.max}); clamped to ${clamped}` });
        v = clamped;
      }
      return v;
    }
    case 'enum':
      return typeof input === 'string' && spec.values.includes(input) ? input : INVALID;
    case 'str': {
      if (typeof input !== 'string') return INVALID;
      const v = input.trim();
      if (v.length > spec.max) return INVALID;
      if (spec.test && !spec.test(v)) return INVALID;
      return v;
    }
    case 'hex': {
      if (typeof input !== 'string') return INVALID;
      const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
      if (!m || !m[1]) return INVALID;
      const h = m[1].toLowerCase();
      return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
    }
    case 'combo': {
      if (typeof input !== 'string' || input.length > 64) return INVALID;
      const c = normalizeCombo(input);
      return c !== null && (c === '' || isCombo(c)) ? c : INVALID;
    }
    case 'literal':
      return input === spec.value ? input : INVALID;
    case 'nullable':
      return input === null ? null : check(spec.inner, input, path, issues);
    case 'array': {
      if (!Array.isArray(input)) return INVALID;
      const out: unknown[] = [];
      const seen = new Set<string>();
      input.forEach((item, i) => {
        const v = check(spec.item, item, join(path, i), issues);
        if (v === INVALID) {
          issues.push({ path: join(path, i), message: 'invalid entry removed' });
          return;
        }
        const k = JSON.stringify(v);
        if (spec.unique && seen.has(k)) return;
        seen.add(k);
        out.push(v);
      });
      if (out.length > spec.max) {
        issues.push({ path, message: `too many entries; kept the first ${spec.max}` });
        out.length = spec.max;
      }
      return out;
    }
    case 'record': {
      if (!isPlainObject(input)) return INVALID;
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [k, raw] of Object.entries(input)) {
        if (FORBIDDEN_KEYS.has(k) || !spec.key(k)) {
          issues.push({ path: join(path, k), message: 'invalid key removed' });
          continue;
        }
        const v = check(spec.value, raw, join(path, k), issues);
        if (v === INVALID) {
          issues.push({ path: join(path, k), message: 'invalid entry removed' });
          continue;
        }
        if (count >= spec.max) {
          issues.push({ path, message: `too many entries; kept the first ${spec.max}` });
          break;
        }
        out[k] = v;
        count++;
      }
      return out;
    }
    case 'partial': {
      if (!isPlainObject(input)) return INVALID;
      const out: Record<string, unknown> = {};
      for (const [k, raw] of Object.entries(input)) {
        const sub = spec.shape[k];
        if (!sub || FORBIDDEN_KEYS.has(k)) {
          issues.push({ path: join(path, k), message: 'unknown key removed' });
          continue;
        }
        const v = check(sub, raw, join(path, k), issues);
        if (v === INVALID) issues.push({ path: join(path, k), message: 'invalid value removed' });
        else out[k] = v;
      }
      return out;
    }
    case 'object':
      // Objects are resolved field by field against defaults (see resolve).
      return isPlainObject(input) ? input : INVALID;
  }
}

function clone<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function resolve(spec: Spec, input: unknown, fallback: unknown, path: string, issues: SettingsIssue[]): unknown {
  if (spec.t === 'object') {
    if (!isPlainObject(input)) {
      if (input !== undefined) issues.push({ path: path || '(root)', message: 'expected an object; using defaults' });
      return clone(fallback);
    }
    const out: Record<string, unknown> = {};
    const defaults = (fallback ?? {}) as Record<string, unknown>;
    for (const [k, sub] of Object.entries(spec.shape)) {
      out[k] = resolve(sub, input[k], defaults[k], join(path, k), issues);
    }
    for (const k of Object.keys(input)) {
      if (k in spec.shape || RETIRED_KEYS.has(join(path, k))) continue;
      issues.push({ path: join(path, k), message: 'unknown setting ignored' });
    }
    return out;
  }
  const v = check(spec, input, path, issues);
  if (v === INVALID) {
    if (input !== undefined) issues.push({ path, message: 'invalid value; using the default' });
    return clone(fallback);
  }
  return v;
}

/** Validates arbitrary data against the schema, filling every missing/invalid key from the defaults. */
export function validateSettings(input: unknown): { settings: Settings; issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = [];
  const settings = resolve(SETTINGS_SPEC, input, createDefaultSettings(), '', issues) as Settings;
  return { settings, issues };
}

/** Validates a single section value (used by set/patch so invalid writes never reach storage). */
export function validateSection<K extends SettingsSection>(
  section: K,
  value: unknown,
  fallback: Settings[K],
): { value: Settings[K]; issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = [];
  const spec = (SETTINGS_SPEC as Extract<Spec, { t: 'object' }>).shape[section];
  if (!spec) return { value: fallback, issues: [{ path: section, message: 'unknown section' }] };
  return { value: resolve(spec, value, fallback, section, issues) as Settings[K], issues };
}

// ── Migrations ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Migration {
  /** Version this migration upgrades from. */
  from: number;
  to: number;
  run(data: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Appearance defaults of settings version 1 (design v1, until 2026-11-12) and the design v2 values that replace them.
 * Settings are stored whole, so a browser that ever saved a change also stored every default of its time; the v1 → v2
 * migration moves the values that still equal a v1 default to the v2 default (the new look for everyone who did not
 * choose otherwise) and leaves every value the user changed alone. Frozen here: later default changes need their
 * own migration step.
 */
export const DESIGN_V1_APPEARANCE = {
  accentPreset: 'wheat',
  accent: '#d6b47a',
  fontFamily: 'geist',
  transparency: 0.78,
  blur: 18,
  radius: 6,
  sidebar: 'auto',
} as const;

export const DESIGN_V2_APPEARANCE = {
  accentPreset: 'mint',
  accent: '#9ff0c8',
  fontFamily: 'inter',
  transparency: 0.82,
  blur: 16,
  radius: 10,
  sidebar: 'compact',
  homeBackground: { kind: 'wallpaper', value: 'grove' },
} as const;

/** v1 → v2 (design v2): see DESIGN_V1_APPEARANCE. Only `appearance` changes; malformed sections are left to validation. */
export function migrateDesignV2(data: Record<string, unknown>): Record<string, unknown> {
  const a = data.appearance;
  if (!isPlainObject(a)) return data;
  const next: Record<string, unknown> = { ...a };
  for (const key of Object.keys(DESIGN_V1_APPEARANCE) as Array<keyof typeof DESIGN_V1_APPEARANCE>) {
    // A custom accent color is the user's own choice, even when it happens to be the old default hex.
    if (key === 'accent' && next.accentPreset === 'custom') continue;
    if (next[key] === DESIGN_V1_APPEARANCE[key]) next[key] = DESIGN_V2_APPEARANCE[key];
  }
  // The v1 default backdrop was the "lantern glow" (it ignores value, dim and blur): it becomes the wallpaper. Dim
  // and blur keep their values; they apply again when the user picks a picture.
  const bg = next.homeBackground;
  if (isPlainObject(bg) && bg.kind === 'glow' && (bg.value === '' || bg.value === undefined)) {
    next.homeBackground = { ...bg, ...DESIGN_V2_APPEARANCE.homeBackground };
  }
  return { ...data, appearance: next };
}

/**
 * Ordered schema migrations. Add an entry here (and bump CURRENT_SETTINGS_VERSION + the `version` literal in
 * schema.ts and docs/ARCHITECTURE.md §5.3) whenever a key is renamed or reshaped, or old defaults must move.
 * - v1 → v2 (2026-11-12): design v2 defaults (migrateDesignV2).
 */
export const MIGRATIONS: readonly Migration[] = [{ from: 1, to: 2, run: migrateDesignV2 }];

export interface MigrationResult {
  data: unknown;
  fromVersion: number | null;
  issues: SettingsIssue[];
}

export function migrateSettings(
  raw: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
  current: number = CURRENT_SETTINGS_VERSION,
): MigrationResult {
  const issues: SettingsIssue[] = [];
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) issues.push({ path: '(root)', message: 'not a settings object; using defaults' });
    return { data: {}, fromVersion: null, issues };
  }
  let data: Record<string, unknown> = { ...raw };
  const rawVersion = data.version;
  let version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : null;
  const fromVersion = version;
  if (version === null) {
    issues.push({ path: 'version', message: `missing version; treated as version ${current}` });
    version = current;
  }
  if (version > current) {
    issues.push({
      path: 'version',
      message: `saved by a newer GNOME (v${version}); settings this version does not know were ignored`,
    });
    version = current;
  }
  while (version < current) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      issues.push({ path: 'version', message: `no migration from v${version}; unknown keys fall back to defaults` });
      break;
    }
    data = step.run(data);
    version = step.to;
  }
  data.version = current;
  return { data, fromVersion, issues };
}

/** Full load pipeline: migrate → validate/deep-merge with defaults. */
export function loadSettings(raw: unknown): { settings: Settings; issues: SettingsIssue[]; fromVersion: number | null } {
  const m = migrateSettings(raw);
  const v = validateSettings(m.data);
  return { settings: v.settings, issues: [...m.issues, ...v.issues], fromVersion: m.fromVersion };
}

// ── Import / export ──────────────────────────────────────────────────────────────────────────────────────────────

export const EXPORT_FORMAT = 'gnome-settings';
const MAX_IMPORT_BYTES = 1024 * 1024;

export interface SettingsExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  settings: Settings;
}

export function exportSettings(settings: Settings, now: Date = new Date()): string {
  const payload: SettingsExport = {
    format: EXPORT_FORMAT,
    version: CURRENT_SETTINGS_VERSION,
    exportedAt: now.toISOString(),
    settings,
  };
  return JSON.stringify(payload, null, 2);
}

export type ImportResult =
  | { ok: true; settings: Settings; issues: SettingsIssue[] }
  | { ok: false; error: string };

/** Parses an exported file (or a bare settings object). Never applies anything by itself. */
export function parseSettingsImport(text: string): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, error: 'The file is larger than 1 MB.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'The file does not contain GNOME settings.' };
  let raw: unknown = parsed;
  if ('format' in parsed) {
    if (parsed.format !== EXPORT_FORMAT || !isPlainObject(parsed.settings)) {
      return { ok: false, error: 'The file is not a GNOME settings export.' };
    }
    raw = parsed.settings;
  } else if (!('appearance' in parsed) && !('browser' in parsed) && !('version' in parsed)) {
    return { ok: false, error: 'The file does not contain GNOME settings.' };
  }
  const { settings, issues } = loadSettings(raw);
  return { ok: true, settings, issues };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Deep-merges a patch into a base object. Plain objects merge recursively; arrays, records replaced wholesale only
 * where the patch provides them. Records (host-keyed maps) are merged key by key; set a key to `undefined` to delete.
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (v === undefined) {
      if (k in patch) delete out[k];
      continue;
    }
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}
