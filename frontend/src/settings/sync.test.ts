import { describe, expect, it, vi } from 'vitest';
import type { BookmarkRecord, HistoryRecord } from '../lib/idb';
import { createDefaultSettings } from './defaults';
import type { Settings } from './schema';
import {
  bookmarkFromWire,
  bookmarkToWire,
  syncedPart,
  syncRecordsOnce,
  syncSettingsOnce,
  SyncConflictError,
  threeWayMerge,
  type RecordSyncAdapter,
  type RecordSyncTransport,
  type SettingsSyncBase,
  type SettingsSyncTransport,
  type SyncedSettings,
} from './sync';

describe('threeWayMerge', () => {
  it('keeps edits made to different keys on both sides', () => {
    const base = { a: 1, b: 1, c: { x: 1, y: 1 } };
    const local = { a: 2, b: 1, c: { x: 2, y: 1 } };
    const remote = { a: 1, b: 3, c: { x: 1, y: 3 } };
    expect(threeWayMerge(base, local, remote, 'remote')).toEqual({ a: 2, b: 3, c: { x: 2, y: 3 } });
  });

  it('resolves keys changed on both sides by the preferred side', () => {
    expect(threeWayMerge({ a: 1 }, { a: 2 }, { a: 3 }, 'local')).toEqual({ a: 2 });
    expect(threeWayMerge({ a: 1 }, { a: 2 }, { a: 3 }, 'remote')).toEqual({ a: 3 });
  });

  it('merges record entries: additions from both sides, deletions stick', () => {
    const base = { rules: { 'a.com': 'block', 'b.com': 'allow' } };
    const local = { rules: { 'a.com': 'block', 'c.com': 'session' } }; // deleted b.com, added c.com
    const remote = { rules: { 'a.com': 'block', 'b.com': 'allow', 'd.com': 'block' } }; // added d.com
    expect(threeWayMerge(base, local, remote, 'remote')).toEqual({
      rules: { 'a.com': 'block', 'c.com': 'session', 'd.com': 'block' },
    });
  });

  it('merges lists as sets: additions from both sides are kept, removals stick', () => {
    // Sites allowed on two devices between syncs: both are kept, in the preferred side's order.
    expect(threeWayMerge({ l: ['a'] }, { l: ['a', 'b'] }, { l: ['a', 'c'] }, 'local')).toEqual({ l: ['a', 'b', 'c'] });
    expect(threeWayMerge({ l: ['a'] }, { l: ['a', 'b'] }, { l: ['a', 'c'] }, 'remote')).toEqual({ l: ['a', 'c', 'b'] });
    expect(threeWayMerge({ l: ['a'] }, { l: ['a'] }, { l: ['a', 'c'] }, 'local')).toEqual({ l: ['a', 'c'] });
    // Removed on one side, an addition on the other: the removal sticks and the addition is kept.
    expect(threeWayMerge({ l: ['a', 'b'] }, { l: ['b'] }, { l: ['a', 'b', 'c'] }, 'remote')).toEqual({ l: ['b', 'c'] });
    // The same item added on both sides appears once; a first sync (no ancestor list) keeps everything.
    expect(threeWayMerge({ l: [] }, { l: ['x', 'y'] }, { l: ['y', 'x', 'z'] }, 'local')).toEqual({ l: ['x', 'y', 'z'] });
    expect(threeWayMerge(undefined, ['x'], ['z'], 'local')).toEqual(['x', 'z']);
  });

  it('keeps lists of objects as single values', () => {
    expect(threeWayMerge({ l: [{ a: 1 }] }, { l: [{ a: 2 }] }, { l: [{ a: 3 }] }, 'local')).toEqual({ l: [{ a: 2 }] });
  });

  it('ignores prototype-polluting keys', () => {
    const remote = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const merged = threeWayMerge({ a: 0 }, { a: 0, b: 2 }, remote, 'remote') as Record<string, unknown>;
    expect(merged).toEqual({ a: 1, b: 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/** In-memory server with the documented base_updated_at semantics. */
function fakeServer(initial: { data: unknown; updatedAt: number } | null = null) {
  let stored = initial;
  let clock = initial?.updatedAt ?? 1000;
  const transport: SettingsSyncTransport = {
    pull: vi.fn(async () => (stored ? { data: structuredClone(stored.data), updatedAt: stored.updatedAt } : { data: null, updatedAt: null })),
    push: vi.fn(async (data: SyncedSettings, base: number | null) => {
      if (stored && base !== stored.updatedAt) throw new SyncConflictError({ data: structuredClone(stored.data), updatedAt: stored.updatedAt });
      clock += 10;
      stored = { data: structuredClone(data), updatedAt: clock };
      return { updatedAt: clock };
    }),
  };
  return {
    transport,
    get stored() {
      return stored;
    },
    /** Another device writes directly. */
    write(data: unknown) {
      clock += 10;
      stored = { data, updatedAt: clock };
    },
  };
}

function fakeDevice(initial: Settings = createDefaultSettings(), updatedAt = 500) {
  let settings = initial;
  let stamp = updatedAt;
  let base: SettingsSyncBase | null = null;
  return {
    get settings() {
      return settings;
    },
    get base() {
      return base;
    },
    edit(fn: (s: Settings) => void) {
      const next = structuredClone(settings);
      fn(next);
      settings = next;
      stamp = Math.max(Date.now(), stamp + 1);
    },
    deps(transport: SettingsSyncTransport, userId = 1) {
      return {
        userId,
        transport,
        local: () => ({ settings, updatedAt: stamp }),
        apply: (s: Settings, at: number) => {
          settings = s;
          stamp = at;
        },
        loadBase: async () => base,
        saveBase: async (b: SettingsSyncBase | null) => {
          base = b;
        },
      };
    },
  };
}

describe('syncSettingsOnce', () => {
  it('uploads local settings when the server has none (base_updated_at null)', async () => {
    const server = fakeServer();
    const dev = fakeDevice();
    dev.edit((s) => (s.appearance.theme = 'light'));
    const out = await syncSettingsOnce(dev.deps(server.transport));
    expect(out).toMatchObject({ pushed: true, pulled: false, conflicts: 0 });
    expect(server.transport.push).toHaveBeenCalledWith(expect.anything(), null);
    expect((server.stored!.data as SyncedSettings).appearance.theme).toBe('light');
    expect(dev.base?.updatedAt).toBe(server.stored!.updatedAt);
  });

  it('never uploads the device-local account section', async () => {
    const server = fakeServer();
    const dev = fakeDevice();
    dev.edit((s) => (s.account.syncHistory = true));
    await syncSettingsOnce(dev.deps(server.transport));
    expect(server.stored!.data).not.toHaveProperty('account');
  });

  it('first sync of a new device takes the account copy and keeps local edits to other keys', async () => {
    const remote = createDefaultSettings();
    remote.appearance.accentPreset = 'moss';
    remote.browser.searchEngine = 'brave';
    const server = fakeServer({ data: syncedPart(remote), updatedAt: 5000 });
    const dev = fakeDevice();
    dev.edit((s) => (s.appearance.fontSize = 16));
    const out = await syncSettingsOnce(dev.deps(server.transport));
    expect(dev.settings.appearance.accentPreset).toBe('moss');
    expect(dev.settings.browser.searchEngine).toBe('brave');
    expect(dev.settings.appearance.fontSize).toBe(16);
    expect(out).toMatchObject({ pulled: true, pushed: true });
    expect(server.transport.push).toHaveBeenCalledWith(expect.anything(), 5000);
    expect((server.stored!.data as SyncedSettings).appearance.fontSize).toBe(16);
  });

  it('does nothing when both sides already agree', async () => {
    const server = fakeServer();
    const dev = fakeDevice();
    await syncSettingsOnce(dev.deps(server.transport));
    vi.mocked(server.transport.push).mockClear();
    const out = await syncSettingsOnce(dev.deps(server.transport));
    expect(out).toMatchObject({ pulled: false, pushed: false });
    expect(server.transport.push).not.toHaveBeenCalled();
  });

  it('on 409 merges the newer server copy with local edits and retries with its updated_at', async () => {
    const server = fakeServer();
    const a = fakeDevice();
    const b = fakeDevice();
    await syncSettingsOnce(a.deps(server.transport));
    await syncSettingsOnce(b.deps(server.transport));

    // Device A edits the theme and syncs; device B edits the blur but its pull is stale (raced with A).
    a.edit((s) => (s.appearance.theme = 'light'));
    b.edit((s) => (s.appearance.blur = 4));
    const stalePull = await server.transport.pull();
    await syncSettingsOnce(a.deps(server.transport));
    vi.mocked(server.transport.pull).mockResolvedValueOnce(stalePull);

    const out = await syncSettingsOnce(b.deps(server.transport));
    expect(out.conflicts).toBe(1);
    expect(out.pushed).toBe(true);
    expect(b.settings.appearance.theme).toBe('light');
    expect(b.settings.appearance.blur).toBe(4);
    const stored = server.stored!.data as SyncedSettings;
    expect(stored.appearance.theme).toBe('light');
    expect(stored.appearance.blur).toBe(4);

    // A pulls B's edit without losing its own.
    await syncSettingsOnce(a.deps(server.transport));
    expect(a.settings.appearance.blur).toBe(4);
    expect(a.settings.appearance.theme).toBe('light');
  });

  it('after a 409, a key the other device changed again comes from the newer copy (no false conflict)', async () => {
    const server = fakeServer();
    const a = fakeDevice();
    await syncSettingsOnce(a.deps(server.transport));

    // Another device changes the theme twice; this device's pull only saw the first change.
    const s1 = createDefaultSettings();
    s1.appearance.theme = 'light';
    server.write(syncedPart(s1));
    const stalePull = await server.transport.pull();
    const s2 = createDefaultSettings();
    s2.appearance.theme = 'system';
    server.write(syncedPart(s2));

    // This device's own edit is newer than both server copies, so it would win a real conflict.
    a.edit((s) => (s.appearance.fontSize = 16));
    vi.mocked(server.transport.pull).mockResolvedValueOnce(stalePull);

    const out = await syncSettingsOnce(a.deps(server.transport));
    expect(out.conflicts).toBe(1);
    expect(a.settings.appearance.theme).toBe('system');
    expect(a.settings.appearance.fontSize).toBe(16);
    const stored = server.stored!.data as SyncedSettings;
    expect(stored.appearance.theme).toBe('system');
    expect(stored.appearance.fontSize).toBe(16);
    expect(a.base?.updatedAt).toBe(server.stored!.updatedAt);
  });

  it('after a 409, a key both sides changed since the merged copy is still a conflict for `prefer`', async () => {
    const server = fakeServer();
    const a = fakeDevice();
    await syncSettingsOnce(a.deps(server.transport));

    const s1 = createDefaultSettings();
    s1.appearance.blur = 10;
    server.write(syncedPart(s1));
    const stalePull = await server.transport.pull();
    const s2 = structuredClone(s1);
    s2.appearance.radius = 2;
    server.write(syncedPart(s2));

    a.edit((s) => (s.appearance.radius = 12)); // newer than s2: the local value wins the conflict on radius
    vi.mocked(server.transport.pull).mockResolvedValueOnce(stalePull);
    await syncSettingsOnce(a.deps(server.transport));
    const stored = server.stored!.data as SyncedSettings;
    expect(stored.appearance.blur).toBe(10);
    expect(stored.appearance.radius).toBe(12);
    expect(a.settings.appearance.radius).toBe(12);
  });

  it('keeps sites both devices added to the allowlist between syncs (409, then merge)', async () => {
    const server = fakeServer();
    const a = fakeDevice();
    const b = fakeDevice();
    await syncSettingsOnce(a.deps(server.transport));
    await syncSettingsOnce(b.deps(server.transport));

    a.edit((s) => (s.extensions.allowlist = ['a.example']));
    b.edit((s) => (s.extensions.allowlist = ['b.example']));
    const stalePull = await server.transport.pull();
    await syncSettingsOnce(a.deps(server.transport));
    vi.mocked(server.transport.pull).mockResolvedValueOnce(stalePull);
    const out = await syncSettingsOnce(b.deps(server.transport));
    expect(out.conflicts).toBe(1);
    expect([...(server.stored!.data as SyncedSettings).extensions.allowlist].sort()).toEqual(['a.example', 'b.example']);

    await syncSettingsOnce(a.deps(server.transport));
    expect([...a.settings.extensions.allowlist].sort()).toEqual(['a.example', 'b.example']);
  });

  it('never adopts a home background picture stored in another browser, and does not upload over it', async () => {
    const remote = createDefaultSettings();
    remote.appearance.homeBackground = { kind: 'image', value: 'idb:home-bg:elsewhere', dim: 0.3, blur: 0 };
    remote.appearance.theme = 'light';
    const server = fakeServer({ data: syncedPart(remote), updatedAt: 9000 });
    const dev = fakeDevice();
    dev.edit((s) => (s.appearance.homeBackground = { kind: 'color', value: '#203040', dim: 0, blur: 0 }));
    const out = await syncSettingsOnce(dev.deps(server.transport));
    expect(dev.settings.appearance.theme).toBe('light');
    expect(dev.settings.appearance.homeBackground.value).toBe('#203040');
    expect(out.pushed).toBe(false);
    // The next run finds nothing to do (no upload loop over the other browser's picture).
    expect(await syncSettingsOnce(dev.deps(server.transport))).toMatchObject({ pushed: false, pulled: false });
  });

  it('gives up after repeated conflicts instead of looping', async () => {
    const server = fakeServer({ data: syncedPart(createDefaultSettings()), updatedAt: 100 });
    const dev = fakeDevice();
    dev.edit((s) => (s.appearance.radius = 2));
    vi.mocked(server.transport.push).mockImplementation(async () => {
      throw new SyncConflictError({ data: syncedPart(createDefaultSettings()), updatedAt: Math.random() });
    });
    await expect(syncSettingsOnce({ ...dev.deps(server.transport), maxAttempts: 3 })).rejects.toThrow(/another device/);
    expect(server.transport.push).toHaveBeenCalledTimes(3);
  });

  it('validates server data: invalid values fall back instead of reaching the store', async () => {
    const remote = syncedPart(createDefaultSettings()) as unknown as Record<string, Record<string, unknown>>;
    remote.appearance = { ...remote.appearance, fontSize: 999, theme: 'neon' };
    const server = fakeServer({ data: remote, updatedAt: 9000 });
    const dev = fakeDevice();
    await syncSettingsOnce(dev.deps(server.transport));
    expect(dev.settings.appearance.fontSize).toBe(20);
    expect(dev.settings.appearance.theme).toBe('dark');
  });

  it('ignores a base saved for another user', async () => {
    const remote = createDefaultSettings();
    remote.appearance.theme = 'light';
    const server = fakeServer({ data: syncedPart(remote), updatedAt: 7000 });
    const dev = fakeDevice();
    const deps = dev.deps(server.transport, 2);
    await deps.saveBase({ userId: 1, updatedAt: 7000, data: syncedPart(createDefaultSettings()) });
    await syncSettingsOnce(deps);
    expect(dev.settings.appearance.theme).toBe('light');
  });
});

describe('record sync', () => {
  const bm = (id: string, updatedAt: number, extra: Partial<BookmarkRecord> = {}): BookmarkRecord => ({
    id,
    parentId: null,
    kind: 'bookmark',
    title: id,
    url: `https://${id}.example/`,
    position: 0,
    createdAt: 1,
    updatedAt,
    deleted: false,
    ...extra,
  });

  it('converts bookmarks to the wire format (tombstones carry no title/url)', () => {
    const w = bookmarkToWire(bm('a', 5, { deleted: true }));
    expect(w).toMatchObject({ id: 'a', parent_id: null, title: '', url: null, deleted: true, updated_at: 5 });
    expect(bookmarkFromWire(bookmarkToWire(bm('b', 6)))).toEqual(bm('b', 6));
  });

  it('pulls every page, stores the cursor, then pushes pending items in batches', async () => {
    const pages = [
      { items: [{ id: 'h1', url: 'https://a/', title: null, visitedAt: 1 }], nextCursor: 'c1', serverTime: 50, clearedBefore: null },
      { items: [{ id: 'h2', url: 'https://b/', title: null, visitedAt: 2 }], nextCursor: null, serverTime: 60, clearedBefore: 0 },
    ];
    const transport: RecordSyncTransport = {
      pull: vi.fn(async () => pages.shift()!),
      push: vi.fn(async () => {}),
    };
    let pending: HistoryRecord[] = [1, 2, 3].map((n) => ({ id: `l${n}`, url: `https://l${n}/`, title: null, visitedAt: n }));
    const applied: HistoryRecord[] = [];
    const adapter: RecordSyncAdapter<'history'> = {
      kind: 'history',
      pending: async (limit) => pending.slice(0, limit),
      acknowledge: async (items) => {
        pending = pending.filter((p) => !items.includes(p));
      },
      applyRemote: async (items) => {
        applied.push(...items);
      },
    };
    const cursors = new Map<string, number | null>([['history:1', 10]]);
    const out = await syncRecordsOnce(adapter, {
      userId: 1,
      transport,
      batch: 2,
      cursors: {
        get: async (k, u) => cursors.get(`${k}:${u}`) ?? null,
        set: async (k, u, v) => void cursors.set(`${k}:${u}`, v),
      },
    });
    expect(transport.pull).toHaveBeenNthCalledWith(1, 'history', 10, null);
    expect(transport.pull).toHaveBeenNthCalledWith(2, 'history', 10, 'c1');
    expect(applied.map((h) => h.id)).toEqual(['h1', 'h2']);
    expect(cursors.get('history:1')).toBe(60);
    expect(transport.push).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ pulled: 2, pushed: 3 });
    expect(pending).toEqual([]);
  });
});
