/**
 * Runes-based settings store (local-first).
 *
 * - Source of truth: IndexedDB (`settings` store, key "current"); mirrored synchronously to localStorage
 *   (`gnome:settings:v1`) together with the precomputed appearance "boot payload" for the pre-paint script.
 * - Startup reads the localStorage mirror synchronously (instant, no flash), then reconciles with IndexedDB
 *   (newest `updatedAt` wins).
 * - Every write is validated; invalid values never reach storage.
 * - Cross-tab sync via BroadcastChannel, with `storage` events as a fallback.
 *
 * Reading: `settings.value.appearance.theme` (reactive). Writing: `settings.set('appearance', 'theme', 'light')`,
 * `settings.patch({ appearance: { blur: 10 } })`, `settings.reset('appearance')`, `settings.resetKey(...)`.
 */
import { reportStatus } from '../app/status';
import { appEvents, debounce } from '../lib/events';
import { idbGet, idbPut, type StoredSettings } from '../lib/idb';
import { computeAppearance, type BootPayload } from './apply';
import { createDefaultSettings, DEFAULT_SETTINGS } from './defaults';
import { withLocalPicture } from './local-picture';
import { withLocalVpn } from './local-vpn';
import { CURRENT_SETTINGS_VERSION, SETTINGS_SECTIONS, type Settings, type SettingsSection } from './schema';
import {
  deepEqual,
  deepMerge,
  exportSettings,
  loadSettings,
  parseSettingsImport,
  validateSection,
  type DeepPartial,
  type ImportResult,
  type SettingsIssue,
} from './validate';

export const STORAGE_KEY = 'gnome:settings:v1';
const IDB_KEY = 'current';
const CHANNEL_NAME = 'gnome:settings';
const PERSIST_DELAY_MS = 150;

export interface SettingsMirror {
  v: 1;
  updatedAt: number;
  settings: Settings;
  boot: BootPayload;
}

export type ChangeOrigin = 'local' | 'tab' | 'sync' | 'import';
export interface SettingsChange {
  origin: ChangeOrigin;
  sections: SettingsSection[];
  updatedAt: number;
}

interface ChannelMessage {
  type: 'settings';
  from: string;
  updatedAt: number;
  settings: Settings;
}

const TAB_ID = Math.random().toString(36).slice(2);

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
  }
  return v;
}

/** An IndexedDB settings record worth comparing with the mirror (its `data` still goes through loadSettings). */
function isUsableRecord(v: unknown): v is StoredSettings {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<StoredSettings>;
  return (
    typeof r.updatedAt === 'number' &&
    Number.isFinite(r.updatedAt) &&
    r.updatedAt >= 0 &&
    !!r.data &&
    typeof r.data === 'object' &&
    !Array.isArray(r.data)
  );
}

type MirrorRead =
  | { kind: 'none' }
  /** Present but unusable (not JSON, not an object): removed so the boot script stops reading it. */
  | { kind: 'damaged' }
  | {
      kind: 'ok';
      raw: string;
      settings: Settings;
      updatedAt: number;
      /** Written by a newer GNOME (settings.version above ours): never rewritten by this version. */
      fromNewer: boolean;
    };

function readMirror(): MirrorRead {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return { kind: 'none' }; // storage blocked
  }
  if (!raw) return { kind: 'none' };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'damaged' };
    const m = parsed as Partial<SettingsMirror>;
    const { settings } = loadSettings(m.settings);
    const version = (m.settings as { version?: unknown } | undefined)?.version;
    const updatedAt = typeof m.updatedAt === 'number' && Number.isFinite(m.updatedAt) && m.updatedAt > 0 ? m.updatedAt : 0;
    return { kind: 'ok', raw, settings, updatedAt, fromNewer: typeof version === 'number' && version > CURRENT_SETTINGS_VERSION };
  } catch {
    return { kind: 'damaged' };
  }
}

class SettingsStore {
  #value = $state.raw<Settings>(deepFreeze(createDefaultSettings()));
  #updatedAt = $state(0);
  #loaded = $state(false);
  #listeners = new Set<(change: SettingsChange) => void>();
  #channel: BroadcastChannel | null = null;
  #initialized = false;
  #readyResolve!: () => void;
  readonly ready: Promise<void> = new Promise((resolve) => {
    this.#readyResolve = resolve;
  });
  #persist = debounce(() => void this.#writeNow(), PERSIST_DELAY_MS);

  /** Current settings (deeply frozen; reactive). */
  get value(): Settings {
    return this.#value;
  }

  get updatedAt(): number {
    return this.#updatedAt;
  }

  /** True once IndexedDB has been consulted (the mirror is applied synchronously before that). */
  get loaded(): boolean {
    return this.#loaded;
  }

  get<K extends SettingsSection>(section: K): Settings[K] {
    return this.#value[section];
  }

  /** Sets one key of a section. Invalid values are rejected (the previous value stays) and reported. */
  set<K extends SettingsSection, F extends keyof Settings[K]>(section: K, key: F, value: Settings[K][F]): SettingsIssue[] {
    const current = this.#value[section];
    return this.#commitSection(section, { ...current, [key]: value } as Settings[K], 'local');
  }

  /** Deep-merges a partial object (records merge per key; `undefined` deletes a record entry). */
  patch(patch: DeepPartial<Omit<Settings, 'version'>>, origin: ChangeOrigin = 'local'): SettingsIssue[] {
    const issues: SettingsIssue[] = [];
    let next: Settings = this.#value;
    const changed: SettingsSection[] = [];
    for (const section of SETTINGS_SECTIONS) {
      const p = (patch as Record<string, unknown>)[section];
      if (p === undefined) continue;
      const merged = deepMerge(next[section] as unknown, p as DeepPartial<unknown>);
      const r = validateSection(section, merged, next[section]);
      issues.push(...r.issues);
      if (!deepEqual(r.value, next[section])) {
        next = { ...next, [section]: r.value };
        changed.push(section);
      }
    }
    if (changed.length) this.#commit(next, changed, origin);
    return issues;
  }

  /** Resets one section (or everything) to defaults. */
  reset(section?: SettingsSection): void {
    if (!section) {
      const next = createDefaultSettings();
      const changed = SETTINGS_SECTIONS.filter((s) => !deepEqual(next[s], this.#value[s]));
      if (changed.length) this.#commit(next, changed, 'local');
      return;
    }
    this.#commitSection(section, createDefaultSettings()[section], 'local');
  }

  resetKey<K extends SettingsSection, F extends keyof Settings[K]>(section: K, key: F): void {
    const def = createDefaultSettings()[section][key];
    this.set(section, key, def);
  }

  isDefault<K extends SettingsSection>(section: K, key?: keyof Settings[K]): boolean {
    const cur = this.#value[section];
    const def = DEFAULT_SETTINGS[section];
    return key === undefined ? deepEqual(cur, def) : deepEqual(cur[key], def[key]);
  }

  /** Replaces everything (validated). Used by import and account sync. */
  replace(input: unknown, origin: ChangeOrigin, updatedAt?: number): SettingsIssue[] {
    const { settings, issues } = loadSettings(input);
    const changed = SETTINGS_SECTIONS.filter((s) => !deepEqual(settings[s], this.#value[s]));
    if (changed.length) this.#commit(settings, changed, origin, updatedAt);
    return issues;
  }

  export(): string {
    return exportSettings(this.#value);
  }

  /**
   * Parses and, if valid, applies an exported settings file. Returns the result for the UI to report. The `account`
   * section (which sync switches are on) is device-local, as in account sync: a file never turns sync — in
   * particular history sync — on or off in this browser. Neither does a home background picture the file only
   * references (pictures stay in the browser they were uploaded to), nor this browser's `vpn.mode` and
   * `vpn.killSwitch` (device-local, docs/WAVE-C.md D12).
   */
  import(text: string): ImportResult {
    const result = parseSettingsImport(text);
    if (result.ok) {
      const next = withLocalVpn(withLocalPicture(result.settings, this.#value.appearance.homeBackground), {
        mode: this.#value.vpn.mode,
        killSwitch: this.#value.vpn.killSwitch,
      });
      this.replace({ ...next, account: this.#value.account }, 'import');
    }
    return result;
  }

  /** Non-reactive change subscription (sync, analytics-free diagnostics). */
  onChange(fn: (change: SettingsChange) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Loads persisted settings and starts cross-tab sync. Safe to call more than once. */
  init(): Promise<void> {
    if (this.#initialized) return this.ready;
    this.#initialized = true;

    const mirror = readMirror();
    if (mirror.kind === 'ok') {
      this.#value = deepFreeze(mirror.settings);
      this.#updatedAt = mirror.updatedAt;
      // Repair: values the validator corrected, a boot payload from an older build or a hand-edited mirror would
      // otherwise be re-applied by the pre-paint script on every load until the next settings change.
      if (!mirror.fromNewer && mirror.raw !== this.#serializeMirror()) this.#writeMirror();
    } else if (mirror.kind === 'damaged') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* storage disabled */
      }
    }

    if (typeof window !== 'undefined') {
      if (typeof BroadcastChannel !== 'undefined') {
        this.#channel = new BroadcastChannel(CHANNEL_NAME);
        this.#channel.onmessage = (ev: MessageEvent<ChannelMessage>) => {
          const msg = ev.data;
          if (!msg || msg.type !== 'settings' || msg.from === TAB_ID) return;
          this.#acceptRemote(msg.settings, msg.updatedAt);
        };
      }
      window.addEventListener('storage', (ev) => {
        if (ev.key !== STORAGE_KEY || !ev.newValue) return;
        try {
          const parsed = JSON.parse(ev.newValue) as Partial<SettingsMirror>;
          if (typeof parsed.updatedAt === 'number') this.#acceptRemote(parsed.settings, parsed.updatedAt);
        } catch {
          /* ignore malformed values written by other code */
        }
      });
      const flush = (): void => this.#persist.flush();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }

    void this.#loadFromDatabase().finally(() => {
      this.#loaded = true;
      this.#readyResolve();
    });
    return this.ready;
  }

  async #loadFromDatabase(): Promise<void> {
    try {
      const raw: unknown = await idbGet('settings', IDB_KEY);
      // A damaged record (no settings object, no usable timestamp) must not win over the mirror by its timestamp:
      // it is treated as missing and rewritten from the current settings below.
      const stored = isUsableRecord(raw) ? raw : undefined;
      if (stored && stored.updatedAt > this.#updatedAt) {
        const { settings, issues } = loadSettings(stored.data);
        if (issues.length) console.info('[gnome] settings corrected on load', issues);
        const changed = SETTINGS_SECTIONS.filter((s) => !deepEqual(settings[s], this.#value[s]));
        this.#value = deepFreeze(settings);
        this.#updatedAt = stored.updatedAt;
        this.#writeMirror();
        if (changed.length) this.#notify({ origin: 'local', sections: changed, updatedAt: stored.updatedAt });
      } else if (this.#updatedAt > (stored?.updatedAt ?? 0) || (raw !== undefined && !stored)) {
        // The mirror is newer (e.g. IndexedDB was cleared) or the record is damaged: restore the database copy.
        await this.#writeDatabase();
      }
      reportStatus('settings', { state: 'ok', detail: 'Saved in this browser' });
    } catch (err) {
      reportStatus('settings', {
        state: 'degraded',
        detail: 'IndexedDB unavailable; settings are kept in localStorage only',
      });
      console.warn('[gnome] settings: IndexedDB unavailable', err);
    }
  }

  #acceptRemote(input: unknown, updatedAt: number): void {
    if (!Number.isFinite(updatedAt) || updatedAt <= this.#updatedAt) return;
    const { settings } = loadSettings(input);
    const changed = SETTINGS_SECTIONS.filter((s) => !deepEqual(settings[s], this.#value[s]));
    this.#value = deepFreeze(settings);
    this.#updatedAt = updatedAt;
    if (changed.length) this.#notify({ origin: 'tab', sections: changed, updatedAt });
  }

  #commitSection<K extends SettingsSection>(section: K, candidate: Settings[K], origin: ChangeOrigin): SettingsIssue[] {
    const current = this.#value[section];
    const { value, issues } = validateSection(section, candidate, current);
    if (!deepEqual(value, current)) this.#commit({ ...this.#value, [section]: value }, [section], origin);
    return issues;
  }

  #commit(next: Settings, sections: SettingsSection[], origin: ChangeOrigin, updatedAt?: number): void {
    const stamp = Math.max(updatedAt ?? Date.now(), this.#updatedAt + 1);
    this.#value = deepFreeze({ ...next, version: CURRENT_SETTINGS_VERSION });
    this.#updatedAt = stamp;
    this.#writeMirror();
    this.#persist();
    this.#notify({ origin, sections, updatedAt: stamp });
  }

  #notify(change: SettingsChange): void {
    for (const fn of this.#listeners) {
      try {
        fn(change);
      } catch (err) {
        console.error('[gnome] settings listener failed', err);
      }
    }
    appEvents.emit('settings:changed', { origin: change.origin, sections: change.sections });
  }

  #serializeMirror(): string {
    const mirror: SettingsMirror = {
      v: 1,
      updatedAt: this.#updatedAt,
      settings: this.#value,
      boot: computeAppearance(this.#value),
    };
    return JSON.stringify(mirror);
  }

  /** Synchronous localStorage mirror (the boot script reads it before first paint). */
  #writeMirror(): void {
    try {
      localStorage.setItem(STORAGE_KEY, this.#serializeMirror());
    } catch {
      /* quota exceeded or storage disabled: IndexedDB remains the source of truth */
    }
  }

  async #writeDatabase(): Promise<void> {
    const record: StoredSettings = { version: CURRENT_SETTINGS_VERSION, updatedAt: this.#updatedAt, data: this.#value };
    await idbPut('settings', record, IDB_KEY);
  }

  async #writeNow(): Promise<void> {
    try {
      await this.#writeDatabase();
    } catch (err) {
      reportStatus('settings', {
        state: 'degraded',
        detail: 'Could not write to IndexedDB; settings are kept in localStorage only',
      });
      console.warn('[gnome] settings: persist failed', err);
    }
    if (this.#channel) {
      const msg: ChannelMessage = { type: 'settings', from: TAB_ID, updatedAt: this.#updatedAt, settings: this.#value };
      try {
        this.#channel.postMessage(msg);
      } catch {
        /* channel closed */
      }
    }
  }
}

export const settings = new SettingsStore();
export type { SettingsStore };
