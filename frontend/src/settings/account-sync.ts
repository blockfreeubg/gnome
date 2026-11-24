/**
 * The account-sync controller: runs settings / bookmarks / history sync whenever the user is signed in, the server
 * offers sync and the matching switches in `settings.account` are on. Not needed for the first paint, so main.ts
 * loads it once the page is idle (`startAccountSync()`); Settings → Account & sync imports `syncNow()` for its
 * "Sync now" button. Who is signed in lives in account.svelte.ts; merging and conflicts in sync.ts.
 */
import { reportStatus } from '../app/status';
import { isApiError, type ApiError } from '../lib/api';
import { debounce } from '../lib/events';
import { kvDelete, kvGet, kvSet } from '../lib/idb';
import { account, onUserChange, SYNC_BASE_KEY, syncCursorKey } from './account.svelte';
import { settings } from './store.svelte';
import {
  getRecordSync,
  httpRecordTransport,
  httpSettingsTransport,
  onRecordSyncRequest,
  syncRecordsOnce,
  syncSettingsOnce,
  type RecordCursorStore,
  type RecordKind,
  type SettingsSyncBase,
  type SyncStatus,
} from './sync';

const cursorStore: RecordCursorStore = {
  async get(kind, userId) {
    const v = await kvGet<number>(syncCursorKey(kind, userId));
    return typeof v === 'number' ? v : null;
  },
  async set(kind, userId, since) {
    if (since === null) await kvDelete(syncCursorKey(kind, userId));
    else await kvSet(syncCursorKey(kind, userId), since);
  },
};

const SETTINGS_DEBOUNCE_MS = 1500;
const RECORDS_DEBOUNCE_MS = 4000;
const PERIODIC_MS = 10 * 60_000;

function syncWanted(): { settings: boolean; bookmarks: boolean; history: boolean } | null {
  const a = settings.value.account;
  if (!account.user || !account.syncAvailable || !a.sync) return null;
  return { settings: a.syncSettings, bookmarks: a.syncBookmarks, history: a.syncHistory };
}

function setSync(status: Partial<SyncStatus>): void {
  account.sync = { ...account.sync, ...status };
  const s = account.sync;
  reportStatus('sync', {
    state: s.state === 'error' ? 'degraded' : s.state === 'offline' ? 'down' : s.state === 'idle' || s.state === 'syncing' ? 'ok' : 'off',
    detail:
      s.state === 'error'
        ? `Sync failed: ${s.error ?? 'unknown error'}`
        : s.state === 'idle'
          ? 'Account sync is on'
          : s.state === 'syncing'
            ? 'Syncing…'
            : s.state === 'offline'
              ? 'Sync paused: offline'
              : 'Account sync is off',
  });
}

/** A `413 quota_exceeded` answer (WAVE-D D20): whose storage is full, and how full. */
export interface QuotaRefusal {
  scope: 'account' | 'server';
  usedBytes: number | null;
  quotaBytes: number | null;
}

/** The refusal in a sync error, or null. `quota_exceeded` is read from the body (lib/api maps a 413 to its status code). */
export function quotaRefusal(err: unknown): QuotaRefusal | null {
  if (!isApiError(err) || (err as ApiError).status !== 413) return null;
  const body = (err as ApiError).body as { error?: { code?: unknown }; scope?: unknown; used_bytes?: unknown; quota_bytes?: unknown } | null;
  if (!body || typeof body !== 'object' || body.error?.code !== 'quota_exceeded') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { scope: body.scope === 'server' ? 'server' : 'account', usedBytes: num(body.used_bytes), quotaBytes: num(body.quota_bytes) };
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** What Settings shows for a kind stopped by a quota refusal. */
export function quotaMessage(q: QuotaRefusal): string {
  if (q.scope === 'server') return "This server's sync storage is full. Try again later or ask its operator.";
  const amount = q.usedBytes !== null && q.quotaBytes !== null ? ` (${mb(q.usedBytes)} of ${mb(q.quotaBytes)})` : '';
  return `Sync storage on this server is full${amount}. Delete bookmarks or turn off history sync to continue.`;
}

/**
 * Kinds whose sync stopped on a quota refusal, with the message. A stopped kind is not sent again until it changes
 * locally (e.g. bookmarks were deleted) or the app starts again; the other kinds go on.
 */
const quotaStopped = new Map<'settings' | RecordKind, string>();

let running: Promise<void> | null = null;
let rerun = false;
const dirty = new Set<'settings' | RecordKind>();

/** Runs one full sync of everything that is switched on. Concurrent calls coalesce into one follow-up run. */
export function syncNow(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    do {
      rerun = false;
      await runOnce();
    } while (rerun);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** No answer from the server at all, or none within the client's own timeout (status 0; a 503/504 is an answer). */
function serverUnreachable(err: unknown): boolean {
  return isApiError(err, 'network_error') || (isApiError(err, 'timeout') && (err as ApiError).status === 0);
}

async function runOnce(): Promise<void> {
  const want = syncWanted();
  const user = account.user;
  if (!want || !user) {
    setSync({ state: account.user ? 'disabled' : 'signed-out', error: null });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setSync({ state: 'offline' });
    return;
  }
  setSync({ state: 'syncing', error: null });
  const changed = new Set(dirty);
  dirty.clear();
  // Each kind has its own try: a failure of one (e.g. the server's bookmark cap) must not stop the others. Two kinds
  // of failure do stop the run: the session ended (nothing else can sync either), and the server is unreachable (no
  // answer at all, or none within the client's timeout): trying the remaining kinds would only wait up to 15 s each
  // for the same server, and the next run tries every kind again.
  const failures: Array<{ kind: 'settings' | RecordKind; err: unknown }> = [];
  const attempt = async (kind: 'settings' | RecordKind, run: () => Promise<unknown>): Promise<'next' | 'stop' | 'signed-out'> => {
    try {
      await run();
      return 'next';
    } catch (err) {
      if (isApiError(err, 'unauthorized') || isApiError(err, 'login_required')) {
        // The session ended elsewhere (password changed, account deleted, expired): nothing else can sync either.
        void account.refresh().catch(() => {});
        setSync({ state: 'signed-out', error: null });
        return 'signed-out';
      }
      const quota = quotaRefusal(err);
      if (quota) {
        const message = quotaMessage(quota);
        quotaStopped.set(kind, message);
        failures.push({ kind, err: new Error(message) });
        return 'next';
      }
      failures.push({ kind, err });
      return serverUnreachable(err) ? 'stop' : 'next';
    }
  };
  const steps: Array<['settings' | RecordKind, () => Promise<unknown>]> = [];
  if (want.settings) {
    steps.push([
      'settings',
      async () => {
        await settings.ready;
        await syncSettingsOnce({
          userId: user.id,
          transport: httpSettingsTransport,
          local: () => ({ settings: settings.value, updatedAt: settings.updatedAt }),
          apply: (next, updatedAt) => settings.replace(next, 'sync', updatedAt),
          loadBase: async () => (await kvGet<SettingsSyncBase>(SYNC_BASE_KEY)) ?? null,
          saveBase: async (b) => (b ? kvSet(SYNC_BASE_KEY, b) : kvDelete(SYNC_BASE_KEY)),
        });
      },
    ]);
  }
  for (const kind of ['bookmarks', 'history'] as const) {
    if (!want[kind]) continue;
    steps.push([
      kind,
      async () => {
        const adapter = getRecordSync(kind);
        if (!adapter) return; // the feature that owns this store has not registered yet
        await syncRecordsOnce(adapter, { userId: user.id, transport: httpRecordTransport, cursors: cursorStore });
      },
    ]);
  }
  for (const [kind, run] of steps) {
    const stopped = quotaStopped.get(kind);
    if (stopped !== undefined && !changed.has(kind)) {
      failures.push({ kind, err: new Error(stopped) });
      continue;
    }
    quotaStopped.delete(kind);
    const next = await attempt(kind, run);
    if (next === 'signed-out') return;
    if (next === 'stop') break;
  }
  if (!failures.length) {
    setSync({ state: 'idle', lastSyncedAt: Date.now(), error: null });
    return;
  }
  if (failures.every((f) => serverUnreachable(f.err))) {
    setSync({ state: 'offline', error: 'the server is not reachable' });
    return;
  }
  const message = failures
    .map(({ kind, err }) => `${kind}: ${serverUnreachable(err) ? 'the server is not reachable' : err instanceof Error ? err.message : String(err)}`)
    .join('; ');
  setSync({ state: 'error', error: message });
}

let started = false;

/**
 * Starts the controller (idempotent): syncs when a user signs in (or already is), re-syncs on local changes
 * (debounced), on reconnect, when the tab becomes visible and every 10 minutes while visible.
 */
export function startAccountSync(): () => void {
  if (started || typeof window === 'undefined') return () => {};
  started = true;
  const offs: Array<() => void> = [];

  const scheduleSettings = debounce(() => void syncNow(), SETTINGS_DEBOUNCE_MS);
  const scheduleRecords = debounce(() => void syncNow(), RECORDS_DEBOUNCE_MS);

  offs.push(
    settings.onChange((change) => {
      if (change.origin === 'sync') return;
      if (change.sections.includes('account')) {
        // A sync switch changed: start/stop right away.
        void syncNow();
        return;
      }
      if (!syncWanted()?.settings) return;
      dirty.add('settings');
      scheduleSettings();
    }),
  );
  offs.push(
    onRecordSyncRequest((kind) => {
      const want = syncWanted();
      if (!want?.[kind]) return;
      dirty.add(kind);
      scheduleRecords();
    }),
  );
  offs.push(
    onUserChange((user, prev) => {
      if (user && user.id !== prev?.id) void syncNow();
      if (!user) setSync({ state: 'signed-out', error: null, lastSyncedAt: null });
    }),
  );
  // The sign-in check runs at startup (account.svelte.ts); it may have answered before this module loaded.
  if (account.user) void syncNow();

  const onOnline = (): void => {
    if (syncWanted()) void syncNow();
  };
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible' || !syncWanted()) return;
    const last = account.sync.lastSyncedAt ?? 0;
    if (Date.now() - last > PERIODIC_MS || dirty.size) void syncNow();
  };
  const flush = (): void => {
    if (dirty.size) scheduleSettings.flush();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', flush);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible' && syncWanted()) void syncNow();
  }, PERIODIC_MS);
  offs.push(() => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', flush);
    clearInterval(timer);
  });

  return () => {
    offs.forEach((off) => off());
    started = false;
  };
}
