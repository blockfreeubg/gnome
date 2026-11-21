import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { RecordKind } from './sync';

// The controller's collaborators, replaced: who is signed in, the settings switches, storage, and the sync engine.
const h = vi.hoisted(() => ({
  account: {
    user: { id: 'u1' } as { id: string } | null,
    syncAvailable: true,
    sync: { state: 'idle', lastSyncedAt: null as number | null, error: null as string | null } as { state: string; lastSyncedAt: number | null; error: string | null },
    refresh: async () => {},
  },
  settings: {
    value: { account: { sync: true, syncSettings: true, syncBookmarks: true, syncHistory: true } },
    updatedAt: 0,
    ready: Promise.resolve(),
    replace: () => {},
    onChange: () => () => {},
  },
  failures: {} as Partial<Record<'settings' | RecordKind, Error>>,
  ran: [] as string[],
}));

vi.mock('../app/status', () => ({ reportStatus: () => {} }));
vi.mock('../lib/idb', () => ({ kvGet: async () => undefined, kvSet: async () => {}, kvDelete: async () => {} }));
vi.mock('./account.svelte', () => ({
  account: h.account,
  onUserChange: () => () => {},
  SYNC_BASE_KEY: 'sync-base',
  syncCursorKey: (kind: string, user: string) => `cursor:${kind}:${user}`,
}));
vi.mock('./store.svelte', () => ({ settings: h.settings }));
vi.mock('./sync', () => ({
  httpRecordTransport: {},
  httpSettingsTransport: {},
  onRecordSyncRequest: () => () => {},
  getRecordSync: (kind: RecordKind) => ({ kind }),
  syncSettingsOnce: async () => {
    h.ran.push('settings');
    if (h.failures.settings) throw h.failures.settings;
    return {};
  },
  syncRecordsOnce: async (adapter: { kind: RecordKind }) => {
    h.ran.push(adapter.kind);
    const err = h.failures[adapter.kind];
    if (err) throw err;
    return {};
  },
}));

const { syncNow } = await import('./account-sync');

beforeEach(() => {
  h.failures = {};
  h.ran = [];
  h.account.user = { id: 'u1' };
  h.account.sync = { state: 'idle', lastSyncedAt: null, error: null };
});

describe('account sync: one run', () => {
  it('syncs every kind that is switched on and ends idle', async () => {
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks', 'history']);
    expect(h.account.sync).toMatchObject({ state: 'idle', error: null });
    expect(h.account.sync.lastSyncedAt).not.toBeNull();
  });

  it('still syncs history when bookmarks fail, and reports the bookmark error as its own', async () => {
    h.failures.bookmarks = new ApiError({ status: 422, code: 'validation_failed', message: 'the account has too many bookmarks', fromGnome: true });
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks', 'history']);
    expect(h.account.sync.state).toBe('error');
    expect(h.account.sync.error).toMatch(/^bookmarks: /);
    expect(h.account.sync.error).not.toMatch(/history/);
    expect(h.account.sync.lastSyncedAt).toBeNull();
  });

  it('still syncs bookmarks and history when settings fail; several failures are all reported', async () => {
    h.failures.settings = new Error('settings broke');
    h.failures.history = new Error('history broke');
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks', 'history']);
    expect(h.account.sync.state).toBe('error');
    expect(h.account.sync.error).toBe('settings: settings broke; history: history broke');
  });

  it('stops at once and shows signed-out when the session ended', async () => {
    h.failures.settings = new ApiError({ status: 401, code: 'unauthorized', message: 'not signed in', fromGnome: true });
    await syncNow();
    expect(h.ran).toEqual(['settings']);
    expect(h.account.sync).toMatchObject({ state: 'signed-out', error: null });
  });

  it('stops after the first kind when the server does not answer at all (no 3 × 15 s wait), and is offline', async () => {
    h.failures = { settings: new ApiError({ status: 0, code: 'network_error', message: 'fetch failed' }) };
    await syncNow();
    expect(h.ran).toEqual(['settings']);
    expect(h.account.sync).toMatchObject({ state: 'offline', error: 'the server is not reachable' });
  });

  it('stops after a client-side timeout too, but goes on after the server’s own 503 timeout (an answer)', async () => {
    h.failures = { bookmarks: new ApiError({ status: 0, code: 'timeout', message: 'timed out' }) };
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks']);
    expect(h.account.sync.state).toBe('offline');
    h.ran = [];
    h.failures = { settings: new ApiError({ status: 503, code: 'timeout', message: 'the server took too long', fromGnome: true }) };
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks', 'history']);
    expect(h.account.sync).toMatchObject({ state: 'error', error: 'settings: the server took too long' });
  });

  it('keeps an earlier real error visible when the server then stops answering', async () => {
    h.failures = {
      settings: new ApiError({ status: 422, code: 'validation_failed', message: 'bad settings', fromGnome: true }),
      bookmarks: new ApiError({ status: 0, code: 'network_error', message: 'fetch failed' }),
    };
    await syncNow();
    expect(h.ran).toEqual(['settings', 'bookmarks']);
    expect(h.account.sync).toMatchObject({ state: 'error', error: 'settings: bad settings; bookmarks: the server is not reachable' });
  });

  it('is offline when the server is not reachable for every kind that failed', async () => {
    const down = new ApiError({ status: 0, code: 'network_error', message: 'fetch failed' });
    h.failures = { settings: down, bookmarks: down, history: down };
    await syncNow();
    expect(h.account.sync.state).toBe('offline');
    expect(h.account.sync.error).toBe('the server is not reachable');
  });
});
