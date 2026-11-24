/**
 * Account sync (docs/API.md "Sync"). Local-first: this browser is the source of truth and the server is a mirror.
 *
 * - **Settings**: one document per account (`/api/sync/settings`). Every upload names the server copy it was based on
 *   (`base_updated_at`); a `409` returns the newer server copy, which is merged with the local settings (three-way, per
 *   key, against the last copy both sides agreed on) and uploaded again. The `account` section (which sync switches
 *   are on) is device-local and never leaves the browser.
 * - **Bookmarks / history**: record streams with `since` cursors. The features that own those stores register a
 *   RecordSyncAdapter with `registerRecordSync()` and call `requestRecordSync(kind)` after a local change; this module
 *   keeps the cursors, pages through pulls and batches uploads.
 *
 * Wiring (which switches are on, when to run) lives in `account-sync.ts`, who is signed in in `account.svelte.ts`.
 * Everything here takes its dependencies as arguments so the merge and conflict logic is unit-tested without a
 * browser.
 */
import { SvelteMap } from 'svelte/reactivity';
import { api, isApiError, type ApiError } from '../lib/api';
import type { BookmarkRecord, HistoryRecord } from '../lib/idb';
import { createDefaultSettings } from './defaults';
import { withLocalPicture } from './local-picture';
import { withLocalVpn } from './local-vpn';
import type { Settings } from './schema';
import { deepEqual, loadSettings } from './validate';

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error' | 'offline' | 'signed-out';

export interface SyncStatus {
  state: SyncState;
  lastSyncedAt: number | null;
  error: string | null;
}

export class SyncConflictError extends Error {
  constructor(readonly server: { data: unknown; updatedAt: number }) {
    super('The server has a newer copy');
    this.name = 'SyncConflictError';
  }
}

// ── Three-way merge ──────────────────────────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPrimitiveList(v: unknown): v is Array<string | number> {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number');
}

/**
 * Three-way merge of lists used as sets (the allowlist, start-up pages, Wisp servers, hidden categories): what either
 * side added is kept, what either side removed stays removed, in the preferred side's order (its additions first).
 */
function mergeLists(base: unknown, local: Array<string | number>, remote: Array<string | number>, prefer: 'local' | 'remote'): Array<string | number> {
  const before = new Set(isPrimitiveList(base) ? base : []);
  const l = new Set(local);
  const r = new Set(remote);
  const out: Array<string | number> = [];
  const seen = new Set<string | number>();
  for (const x of prefer === 'local' ? [...local, ...remote] : [...remote, ...local]) {
    if (seen.has(x)) continue;
    seen.add(x);
    if (before.has(x) && (!l.has(x) || !r.has(x))) continue; // removed on one side
    out.push(x);
  }
  return out;
}

/**
 * Merges two edited copies of a document against their common ancestor.
 *
 * Plain objects (sections, host-keyed records) merge key by key, so an edit on one device and a different edit on
 * another both survive, and a record entry deleted on one side stays deleted unless the other side changed it. Lists
 * of strings or numbers merge as sets (mergeLists), so sites added to the allowlist on two devices are all kept.
 * Everything else (strings, numbers, booleans) is a leaf: a side that left it unchanged takes the other side's value;
 * when both changed it differently, `prefer` decides (normally the newer document).
 */
export function threeWayMerge(base: unknown, local: unknown, remote: unknown, prefer: 'local' | 'remote'): unknown {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(local, base)) return remote;
  if (deepEqual(remote, base)) return local;
  if (isPrimitiveList(local) && isPrimitiveList(remote)) return mergeLists(base, local, remote, prefer);
  if (isPlainObject(local) && isPlainObject(remote)) {
    const b = isPlainObject(base) ? base : {};
    const out: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(b)]);
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const v = threeWayMerge(b[k], local[k], remote[k], prefer);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return prefer === 'local' ? local : remote;
}

/** The part of the settings that is synced: everything except the device-local `account` switches. */
export type SyncedSettings = Omit<Settings, 'account'>;

export function syncedPart(s: Settings): SyncedSettings {
  const { account: _account, ...rest } = s;
  return rest;
}

/**
 * Validates a synced document (from the server or a merge) and re-attaches this device's `account` section. A home
 * background picture stored in another browser (`idb:` key) is replaced by this device's own backdrop: the picture
 * itself is never synced. `vpn.mode` and `vpn.killSwitch` keep this device's values (device-local, docs/WAVE-C.md D12).
 */
export function withDeviceSettings(doc: unknown, device: Settings): Settings {
  const raw = isPlainObject(doc)
    ? {
        ...withLocalVpn(withLocalPicture(doc, device.appearance.homeBackground), {
          mode: device.vpn.mode,
          killSwitch: device.vpn.killSwitch,
        }),
        account: device.account,
      }
    : { account: device.account };
  return loadSettings(raw).settings;
}

// ── Settings sync ────────────────────────────────────────────────────────────────────────────────────────────────

/** HTTP transport for `/api/sync/settings`. */
export interface SettingsSyncTransport {
  pull(): Promise<{ data: unknown | null; updatedAt: number | null }>;
  /** Rejects with SyncConflictError when `baseUpdatedAt` is stale (HTTP 409). */
  push(data: SyncedSettings, baseUpdatedAt: number | null): Promise<{ updatedAt: number }>;
}

/** The last copy this device and the server agreed on (the merge ancestor). Stored per user. */
export interface SettingsSyncBase {
  userId: number;
  updatedAt: number;
  data: SyncedSettings;
}

export interface SettingsSyncDeps {
  userId: number;
  transport: SettingsSyncTransport;
  /** Current local settings and their local `updatedAt`. */
  local(): { settings: Settings; updatedAt: number };
  /** Applies merged settings locally (origin `sync`, so it is not uploaded again by the change listener). */
  apply(settings: Settings, updatedAt: number): void;
  loadBase(): Promise<SettingsSyncBase | null>;
  saveBase(base: SettingsSyncBase | null): Promise<void>;
  /** Uploads attempted before giving up on repeated conflicts. Default 4. */
  maxAttempts?: number;
}

export interface SettingsSyncOutcome {
  /** Local settings were changed by the merge. */
  pulled: boolean;
  /** The server copy was replaced. */
  pushed: boolean;
  /** Number of 409 conflicts resolved during this run. */
  conflicts: number;
  updatedAt: number;
}

/**
 * One settings round trip: pull, merge, apply locally, upload when the server copy differs, and on a 409 merge with
 * the newer copy and retry. Resolves when both sides hold the same document.
 */
export async function syncSettingsOnce(deps: SettingsSyncDeps): Promise<SettingsSyncOutcome> {
  const maxAttempts = deps.maxAttempts ?? 4;
  const stored = await deps.loadBase();
  const base = stored && stored.userId === deps.userId ? stored : null;
  /**
   * The merge ancestor: the server copy the local settings already contain. At first the last agreed copy; after a
   * merge with a server copy whose upload then lost a race (409), that server copy — the local settings include its
   * changes now, so only edits made since then on either side may count as changes in the next merge.
   */
  let ancestor: { updatedAt: number; data: SyncedSettings } | null = base;
  let server = await deps.transport.pull();
  const outcome: SettingsSyncOutcome = { pulled: false, pushed: false, conflicts: 0, updatedAt: server.updatedAt ?? 0 };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { settings: localSettings, updatedAt: localUpdatedAt } = deps.local();
    const local = syncedPart(localSettings);
    let merged: SyncedSettings = local;
    let serverDoc: SyncedSettings | null = null;

    if (server.data !== null && server.data !== undefined && server.updatedAt !== null) {
      serverDoc = syncedPart(withDeviceSettings(server.data, localSettings));
      const remoteChanged = !ancestor || ancestor.updatedAt !== server.updatedAt;
      if (remoteChanged) {
        // Without an agreed copy (first sync of this device), the defaults are the ancestor: whatever either side
        // changed from the defaults is kept, and keys changed on both sides go to the newer document.
        const prefer = localUpdatedAt > server.updatedAt ? 'local' : 'remote';
        const from = ancestor?.data ?? syncedPart(createDefaultSettings());
        merged = syncedPart(withDeviceSettings(threeWayMerge(from, local, serverDoc, prefer), localSettings));
        if (!deepEqual(merged, local)) {
          deps.apply({ ...merged, account: localSettings.account } as Settings, Math.max(localUpdatedAt + 1, server.updatedAt));
          outcome.pulled = true;
        }
      }
      if (deepEqual(merged, serverDoc)) {
        await deps.saveBase({ userId: deps.userId, updatedAt: server.updatedAt, data: merged });
        outcome.updatedAt = server.updatedAt;
        return outcome;
      }
    }

    try {
      const res = await deps.transport.push(merged, serverDoc ? server.updatedAt : null);
      outcome.pushed = true;
      outcome.updatedAt = res.updatedAt;
      await deps.saveBase({ userId: deps.userId, updatedAt: res.updatedAt, data: merged });
      return outcome;
    } catch (err) {
      if (!(err instanceof SyncConflictError)) throw err;
      outcome.conflicts++;
      // `merged` already holds this server copy's changes: it becomes the ancestor, so a key the other device changed
      // again since then is taken from the newer copy instead of being mistaken for a conflict with a local edit.
      if (serverDoc && server.updatedAt !== null) ancestor = { updatedAt: server.updatedAt, data: serverDoc };
      server = { data: err.server.data, updatedAt: err.server.updatedAt };
    }
  }
  throw new Error('Settings kept changing on another device; try again in a moment.');
}

interface SettingsWire {
  data: unknown | null;
  updated_at: number | null;
}

/** `/api/sync/settings` over the shared API client. */
export const httpSettingsTransport: SettingsSyncTransport = {
  async pull() {
    const res = await api.get<SettingsWire>('/api/sync/settings');
    return { data: res?.data ?? null, updatedAt: typeof res?.updated_at === 'number' ? res.updated_at : null };
  },
  async push(data, baseUpdatedAt) {
    try {
      const res = await api.put<{ updated_at: number }>('/api/sync/settings', { data, base_updated_at: baseUpdatedAt });
      return { updatedAt: res.updated_at };
    } catch (err) {
      if (isApiError(err, 'conflict')) {
        const body = (err as ApiError).body as Partial<SettingsWire> | undefined;
        if (body && typeof body.updated_at === 'number') {
          throw new SyncConflictError({ data: body.data ?? null, updatedAt: body.updated_at });
        }
      }
      throw err;
    }
  },
};

// ── Bookmarks / history record sync (hooks for the features that own those stores) ──────────────────────────────

export type RecordKind = 'bookmarks' | 'history';
export type RecordOf<K extends RecordKind> = K extends 'bookmarks' ? BookmarkRecord : HistoryRecord;

/**
 * Implemented by the feature that owns a record store (bookmarks, history) and registered with
 * `registerRecordSync()`. Records use the local IndexedDB shapes from `lib/idb.ts`; conversion to the API's wire
 * format happens here.
 */
export interface RecordSyncAdapter<K extends RecordKind> {
  kind: K;
  /**
   * Local records not yet acknowledged by the server (new, edited, or — for bookmarks — tombstones with
   * `deleted: true`). Return at most `limit` items; the engine asks again until nothing is left.
   */
  pending(limit: number): Promise<RecordOf<K>[]>;
  /** The server stored these items: clear their pending flag (unless the record changed again meanwhile). */
  acknowledge(items: RecordOf<K>[]): Promise<void>;
  /**
   * Changes received from the server (oldest first). Bookmarks: last-writer-wins on `updatedAt`, tombstones delete;
   * keep local-only fields such as `favorite`. History: upsert by id. `clearedBefore` (history only): the user
   * deleted everything visited before it on another device — drop local entries older than that.
   */
  applyRemote(items: RecordOf<K>[], info: { clearedBefore: number | null }): Promise<void>;
}

export interface RecordCursorStore {
  get(kind: RecordKind, userId: number): Promise<number | null>;
  set(kind: RecordKind, userId: number, since: number | null): Promise<void>;
}

export interface RecordSyncTransport {
  pull(kind: RecordKind, since: number | null, cursor: string | null): Promise<{
    items: Array<BookmarkRecord | HistoryRecord>;
    nextCursor: string | null;
    serverTime: number;
    clearedBefore: number | null;
  }>;
  push(kind: RecordKind, items: Array<BookmarkRecord | HistoryRecord>): Promise<void>;
}

/** Server batch limit for POST /api/sync/{bookmarks,history}. */
export const RECORD_BATCH = 5000;

export async function syncRecordsOnce<K extends RecordKind>(
  adapter: RecordSyncAdapter<K>,
  deps: { userId: number; transport: RecordSyncTransport; cursors: RecordCursorStore; batch?: number },
): Promise<{ pulled: number; pushed: number }> {
  const batch = Math.min(deps.batch ?? RECORD_BATCH, RECORD_BATCH);
  let since = await deps.cursors.get(adapter.kind, deps.userId);
  let pulled = 0;
  let cursor: string | null = null;
  let serverTime = since;
  // Pull every page first (history pages with next_cursor; bookmarks answer in one page).
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await deps.transport.pull(adapter.kind, since, cursor);
    if (page.items.length || page.clearedBefore !== null) {
      await adapter.applyRemote(page.items as RecordOf<K>[], { clearedBefore: page.clearedBefore });
    }
    pulled += page.items.length;
    serverTime = page.serverTime;
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  if (serverTime !== null) {
    since = serverTime;
    await deps.cursors.set(adapter.kind, deps.userId, since);
  }
  let pushed = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const items = await adapter.pending(batch);
    if (!items.length) break;
    await deps.transport.push(adapter.kind, items);
    await adapter.acknowledge(items);
    pushed += items.length;
    if (items.length < batch) break;
  }
  return { pulled, pushed };
}

// Wire formats (docs/API.md) ⇄ local records (lib/idb.ts).

interface BookmarkWire {
  id: string;
  parent_id: string | null;
  kind: 'bookmark' | 'folder';
  title: string;
  url: string | null;
  position: number;
  created_at: number;
  updated_at: number;
  deleted: boolean;
}

interface HistoryWire {
  id: string;
  url: string;
  title: string | null;
  visited_at: number;
}

export function bookmarkToWire(b: BookmarkRecord): BookmarkWire {
  return {
    id: b.id,
    parent_id: b.parentId,
    kind: b.kind,
    title: b.deleted ? '' : b.title,
    url: b.deleted || b.kind === 'folder' ? null : b.url,
    position: b.position,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
    deleted: b.deleted,
  };
}

export function bookmarkFromWire(w: BookmarkWire): BookmarkRecord {
  return {
    id: w.id,
    parentId: w.parent_id ?? null,
    kind: w.kind === 'folder' ? 'folder' : 'bookmark',
    title: w.title ?? '',
    url: w.url ?? null,
    position: typeof w.position === 'number' ? w.position : 0,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    deleted: !!w.deleted,
  };
}

export function historyToWire(h: HistoryRecord): HistoryWire {
  return { id: h.id, url: h.url, title: h.title, visited_at: h.visitedAt };
}

export function historyFromWire(w: HistoryWire): HistoryRecord {
  return { id: w.id, url: w.url, title: w.title ?? null, visitedAt: w.visited_at };
}

export const httpRecordTransport: RecordSyncTransport = {
  async pull(kind, since, cursor) {
    const query: Record<string, string | number> = {};
    if (since !== null) query.since = since;
    if (kind === 'history') {
      query.limit = 1000;
      if (cursor) query.cursor = cursor;
      const res = await api.get<{
        items: HistoryWire[];
        next_cursor: string | null;
        server_time: number;
        cleared_before: number | null;
      }>('/api/sync/history', { query });
      return {
        items: (res.items ?? []).map(historyFromWire),
        nextCursor: res.next_cursor ?? null,
        serverTime: res.server_time,
        clearedBefore: res.cleared_before ?? null,
      };
    }
    const res = await api.get<{ items: BookmarkWire[]; server_time: number }>('/api/sync/bookmarks', { query });
    return { items: (res.items ?? []).map(bookmarkFromWire), nextCursor: null, serverTime: res.server_time, clearedBefore: null };
  },
  async push(kind, items) {
    const body =
      kind === 'history'
        ? { items: (items as HistoryRecord[]).map(historyToWire) }
        : { items: (items as BookmarkRecord[]).map(bookmarkToWire) };
    await api.post(`/api/sync/${kind}`, body, { timeoutMs: 60_000 });
  },
};

// ── Adapter registry (the browser team registers; the account controller runs them) ─────────────────────────────

/** Reactive, so Settings → Account & sync updates when a store registers (or goes away). */
const adapters = new SvelteMap<RecordKind, RecordSyncAdapter<RecordKind>>();
const requestListeners = new Set<(kind: RecordKind) => void>();

/**
 * Registers the bookmarks or history store for account sync. Returns an unregister function. Syncing starts only
 * when the user is signed in, sync is on and the matching switch (`account.syncBookmarks` / `account.syncHistory`)
 * is on.
 */
export function registerRecordSync<K extends RecordKind>(adapter: RecordSyncAdapter<K>): () => void {
  adapters.set(adapter.kind, adapter as unknown as RecordSyncAdapter<RecordKind>);
  for (const fn of requestListeners) fn(adapter.kind);
  return () => {
    if (adapters.get(adapter.kind) === (adapter as unknown)) adapters.delete(adapter.kind);
  };
}

/** The registered adapter for a record kind (reactive in components, effects and $derived). */
export function getRecordSync(kind: RecordKind): RecordSyncAdapter<RecordKind> | undefined {
  return adapters.get(kind);
}

/** Call after a local change to bookmarks/history: schedules an upload (debounced; no-op while sync is off). */
export function requestRecordSync(kind: RecordKind): void {
  for (const fn of requestListeners) fn(kind);
}

/** Used by the account controller to learn about requests. */
export function onRecordSyncRequest(fn: (kind: RecordKind) => void): () => void {
  requestListeners.add(fn);
  return () => requestListeners.delete(fn);
}
