import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../test/setup';
import { LIBRARY_LIMITS } from '../shared/browser-data';
import type { EventMap } from '../shared/engine-protocol';
import { createChangeHub } from './changes';
import type { LibraryDb } from './db';
import {
  createDownloadStore,
  createPageLiveness,
  HEARTBEAT_MS,
  MAX_DOWNLOAD_ITEMS,
  PAGE_KEY_PREFIX,
  PAGE_STALE_MS,
  PROGRESS_WRITE_MS,
  type DownloadPrefs,
  type PageLiveness,
  type Timers,
} from './downloads';
import { DAY_MS } from './match';
import { clock, LIBRARY_DBS, uuids } from './testing/dbs';
import { createMemoryDb } from './testing/memory-db';

/** Manual timers driven by the test clock. */
function manualTimers(c: ReturnType<typeof clock>) {
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: Timers & { run(ms: number): void; size(): number } = {
    set(fn, ms) {
      pending.set(++seq, { at: c.now() + ms, fn });
      return seq;
    },
    clear(h) {
      pending.delete(h as number);
    },
    run(ms) {
      const end = c.now() + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        c.set(next[1].at);
        pending.delete(next[0]);
        next[1].fn();
      }
      c.set(end);
    },
    size: () => pending.size,
  };
  return timers;
}

const started = (downloadId: string, over: Partial<EventMap['download.started']> = {}): EventMap['download.started'] => ({
  downloadId,
  tabId: 1,
  url: `https://files.example/${downloadId}.zip`,
  filename: `${downloadId}.zip`,
  mime: 'application/zip',
  total: 2_097_152,
  engine: 'scramjet',
  ...over,
});

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe.each(LIBRARY_DBS)('download store on %s', (_name, makeDb) => {
  async function setup(prefs: Partial<DownloadPrefs> = {}, liveness?: PageLiveness) {
    const db: LibraryDb = await makeDb();
    const c = clock();
    const timers = manualTimers(c);
    const p: DownloadPrefs = { track: true, keepDays: 30, ...prefs };
    const live: PageLiveness = liveness ?? { id: 'page-1', isAlive: (id) => id === 'page-1', setActive: () => {}, stop: () => {} };
    const store = createDownloadStore({ db, prefs: () => p, liveness: live, now: c.now, uuid: uuids(), timers, hub: createChangeHub('downloads', { crossTab: false }) });
    return { db, c, timers, p, store };
  }

  it('records a download and its completion, keyed by instance + downloadId', async () => {
    const { store, c } = await setup();
    expect(await store.started('inst-A', started('1'), c.now())).toBe(true);
    // The same id from another engine-host instance is another download.
    expect(await store.started('inst-B', started('1', { engine: 'ultraviolet' }), c.now())).toBe(true);
    // A repeated started for a running download is refused.
    expect(await store.started('inst-A', started('1'), c.now())).toBe(false);
    c.advance(3000);
    await store.done('inst-A', { downloadId: '1', state: 'completed', received: 2_097_152, error: null }, c.now());
    const list = await store.list(10);
    expect(list).toHaveLength(2);
    const a = list.find((d) => d.engine === 'scramjet')!;
    expect(a).toMatchObject({ state: 'completed', received: 2_097_152, total: 2_097_152, filename: '1.zip', mime: 'application/zip', error: null });
    expect(a.finishedAt).toBe(c.now());
    expect(list.find((d) => d.engine === 'ultraviolet')!.state).toBe('in_progress');
  });

  it('records nothing while tracking is off, and nothing for non-http URLs', async () => {
    const { store, p, c } = await setup({ track: false });
    expect(await store.started('i', started('1'), c.now())).toBe(false);
    p.track = true;
    expect(await store.started('i', started('2', { url: 'blob:https://x.example/uuid' }), c.now())).toBe(false);
    expect(await store.list(10)).toEqual([]);
    // Later events of an unrecorded download are ignored.
    store.progress('i', { downloadId: '1', received: 10, total: null });
    await store.done('i', { downloadId: '1', state: 'completed', received: 10, error: null }, c.now());
    expect(await store.list(10)).toEqual([]);
  });

  it(`caps one instance at ${LIBRARY_LIMITS.activeDownloadsPerInstance} unfinished and ${LIBRARY_LIMITS.downloadsPerInstance} in total`, async () => {
    const { store, c } = await setup();
    for (let i = 0; i < LIBRARY_LIMITS.activeDownloadsPerInstance; i++) expect(await store.started('flood', started(`a${i}`), c.now())).toBe(true);
    expect(await store.started('flood', started('over'), c.now())).toBe(false);
    // Another instance is not affected.
    expect(await store.started('other', started('x'), c.now())).toBe(true);
    // Finishing frees an unfinished slot, but the total keeps counting.
    for (let i = 0; i < LIBRARY_LIMITS.activeDownloadsPerInstance; i++) {
      await store.done('flood', { downloadId: `a${i}`, state: 'completed', received: 1, error: null }, c.now());
    }
    for (let n = LIBRARY_LIMITS.activeDownloadsPerInstance; n < LIBRARY_LIMITS.downloadsPerInstance; n++) {
      expect(await store.started('flood', started(`b${n}`), c.now())).toBe(true);
      await store.done('flood', { downloadId: `b${n}`, state: n % 2 ? 'completed' : 'failed', received: 1, error: n % 2 ? null : 'network' }, c.now());
    }
    expect(await store.started('flood', started('one-too-many'), c.now())).toBe(false);
    expect((await store.list(1000)).length).toBe(LIBRARY_LIMITS.downloadsPerInstance + 1);
  });

  it(`persists progress at most once per ${PROGRESS_WRITE_MS} ms per item, and the final value at done`, async () => {
    const db = createMemoryDb();
    const c = clock();
    const timers = manualTimers(c);
    const store = createDownloadStore({
      db,
      prefs: () => ({ track: true, keepDays: 0 }),
      liveness: { id: 'p', isAlive: () => true, setActive: () => {}, stop: () => {} },
      now: c.now,
      uuid: uuids(),
      timers,
      hub: createChangeHub('downloads', { crossTab: false }),
    });
    await store.started('i', started('1'), c.now());
    const afterStart = db.writes.downloads;
    // 50 progress events over 2.5 s (every 50 ms).
    for (let k = 1; k <= 50; k++) {
      timers.run(50);
      store.progress('i', { downloadId: '1', received: k * 40_000, total: 2_097_152 });
      await flushAsync();
    }
    const writes = db.writes.downloads - afterStart;
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(writes).toBeLessThanOrEqual(3);
    // The newest value is still pending: the trailing write happens within a second.
    timers.run(PROGRESS_WRITE_MS);
    await flushAsync();
    expect(db.dump('downloads')[0]!.received).toBe(50 * 40_000);
    // While running, list() shows the freshest value even between writes.
    store.progress('i', { downloadId: '1', received: 2_000_000, total: 2_097_152 });
    expect((await store.list(1))[0]!.received).toBe(2_000_000);
    await store.done('i', { downloadId: '1', state: 'completed', received: 2_097_152, error: null }, c.now());
    expect(db.dump('downloads')[0]).toMatchObject({ state: 'completed', received: 2_097_152 });
    expect(timers.size()).toBe(0);
  });

  it('marks unfinished downloads of an ended instance untracked', async () => {
    const { store, c } = await setup();
    await store.started('gone', started('1'), c.now());
    await store.started('gone', started('2'), c.now());
    await store.done('gone', { downloadId: '2', state: 'cancelled', received: 5, error: 'cancelled' }, c.now());
    await store.started('alive', started('3'), c.now());
    await store.instanceEnded('gone');
    const byName = Object.fromEntries((await store.list(10)).map((d) => [d.filename, d.state]));
    expect(byName).toEqual({ '1.zip': 'untracked', '2.zip': 'cancelled', '3.zip': 'in_progress' });
    // Events of the ended instance are ignored from now on.
    await store.done('gone', { downloadId: '1', state: 'completed', received: 1, error: null }, c.now());
    expect((await store.list(10)).find((d) => d.filename === '1.zip')!.state).toBe('untracked');
  });

  it('sweeps unfinished downloads of app pages that closed', async () => {
    const db = await makeDb();
    const c = clock();
    const storage = new MemoryStorage();
    const mk = (id: string) => createPageLiveness({ id, storage, now: c.now, timers: manualTimers(c) });
    const live1 = mk('page-1');
    const s1 = createDownloadStore({ db, prefs: () => ({ track: true, keepDays: 0 }), liveness: live1, now: c.now, uuid: uuids('1'), hub: createChangeHub('downloads', { crossTab: false }) });
    await s1.started('i1', started('1'), c.now());
    expect(storage.getItem(PAGE_KEY_PREFIX + 'page-1')).toBe(String(c.now()));
    const s2 = createDownloadStore({ db, prefs: () => ({ track: true, keepDays: 0 }), liveness: mk('page-2'), now: c.now, uuid: uuids('2'), hub: createChangeHub('downloads', { crossTab: false }) });
    expect(await s2.sweep()).toBe(0); // page 1 is alive
    // Page 1 closes without pagehide: its heartbeat stops.
    c.advance(PAGE_STALE_MS + HEARTBEAT_MS);
    expect(await s2.sweep()).toBe(1);
    expect((await s2.list(10))[0]!.state).toBe('untracked');
  });

  it('prunes finished items older than keepDays and clears finished ones (running ones stay)', async () => {
    const { store, c, p } = await setup({ keepDays: 7 });
    await store.started('i', started('old'), c.now() - 10 * DAY_MS);
    await store.done('i', { downloadId: 'old', state: 'completed', received: 1, error: null }, c.now() - 10 * DAY_MS);
    await store.started('i', started('new'), c.now() - DAY_MS);
    await store.done('i', { downloadId: 'new', state: 'failed', received: 0, error: 'x' }, c.now() - DAY_MS);
    await store.started('i', started('run'), c.now() - 20 * DAY_MS);
    expect(await store.prune()).toBe(1);
    p.keepDays = 0;
    c.advance(400 * DAY_MS);
    expect(await store.prune()).toBe(0);
    expect((await store.list(10)).map((d) => d.filename).sort()).toEqual(['new.zip', 'run.zip']);
    await store.clearSince(c.now());
    expect((await store.list(10)).length).toBe(2);
    await store.clear();
    expect((await store.list(10)).map((d) => d.filename)).toEqual(['run.zip']);
  });

  it(`keeps at most maxItems items (default ${MAX_DOWNLOAD_ITEMS}) across engine-host instances: the oldest finished go`, async () => {
    const db = await makeDb();
    const c = clock();
    const store = createDownloadStore({
      db,
      prefs: () => ({ track: true, keepDays: 0 }),
      liveness: { id: 'p', isAlive: () => true, setActive: () => {}, stop: () => {} },
      now: c.now,
      uuid: uuids(),
      hub: createChangeHub('downloads', { crossTab: false }),
      maxItems: 30,
    });
    expect(MAX_DOWNLOAD_ITEMS).toBe(1000);
    // Two downloads that keep running, recorded first (the oldest items).
    for (const id of ['run-1', 'run-2']) expect(await store.started('first0001', started(id), c.now())).toBe(true);
    // An escaped page that makes the app replace its engine host gets a fresh per-instance budget each time.
    for (let inst = 0; inst < 8; inst++) {
      const instance = `instance${inst}`;
      for (let k = 0; k < 10; k++) {
        c.advance(1000);
        expect(await store.started(instance, started(`d${k}`), c.now())).toBe(true);
        await store.done(instance, { downloadId: `d${k}`, state: 'completed', received: 1, error: null }, c.now());
      }
      await store.instanceEnded(instance);
    }
    await store.prune();
    const list = await store.list(1000);
    expect(list).toHaveLength(30);
    expect(list.filter((d) => d.state === 'in_progress').map((d) => d.filename).sort()).toEqual(['run-1.zip', 'run-2.zip']);
    // The newest finished ones are kept.
    expect(list[0]!.startedAt).toBe(c.now());
  });

  it('instanceEnded marks only this page’s items (instance ids come from the engine host)', async () => {
    const db = await makeDb();
    const c = clock();
    const mk = (page: string) =>
      createDownloadStore({ db, prefs: () => ({ track: true, keepDays: 0 }), liveness: { id: page, isAlive: () => true, setActive: () => {}, stop: () => {} }, now: c.now, uuid: uuids(page), hub: createChangeHub('downloads', { crossTab: false }) });
    const one = mk('page-1');
    const two = mk('page-2');
    expect(await one.started('shared01', started('1'), c.now())).toBe(true);
    // Another page whose (forged) engine host used the same instance id ends it. (Page 2 reads the stored record;
    // page 1's own list would show its in-memory copy.)
    await two.instanceEnded('shared01');
    expect((await two.list(10))[0]!.state).toBe('in_progress');
    await one.instanceEnded('shared01');
    expect((await two.list(10))[0]!.state).toBe('untracked');
  });

  it('remove() takes an item off the list, also while it runs (its later events are ignored)', async () => {
    const { store, c } = await setup();
    await store.started('i', started('1'), c.now());
    const [item] = await store.list(1);
    await store.remove(item!.id);
    store.progress('i', { downloadId: '1', received: 99, total: null });
    await store.done('i', { downloadId: '1', state: 'completed', received: 100, error: null }, c.now());
    expect(await store.list(10)).toEqual([]);
  });
});

describe('download store write failures', () => {
  it('a download whose writes failed frees its unfinished slot once, even when done() came first', async () => {
    const db = createMemoryDb();
    const c = clock();
    const store = createDownloadStore({ db, prefs: () => ({ track: true, keepDays: 0 }), liveness: { id: 'p', isAlive: () => true, setActive: () => {}, stop: () => {} }, now: c.now, uuid: uuids(), hub: createChangeHub('downloads', { crossTab: false }) });
    const cap = LIBRARY_LIMITS.activeDownloadsPerInstance;
    for (let i = 0; i < cap - 1; i++) expect(await store.started('inst0001', started(`a${i}`), c.now())).toBe(true);
    db.failWith = new Error('QuotaExceededError');
    const s = store.started('inst0001', started('broken'), c.now());
    const d = store.done('inst0001', { downloadId: 'broken', state: 'completed', received: 1, error: null }, c.now());
    await expect(s).rejects.toThrow('QuotaExceededError');
    await expect(d).rejects.toThrow('QuotaExceededError');
    db.failWith = null;
    // cap - 1 downloads still run: exactly one more fits.
    expect(await store.started('inst0001', started('one-more'), c.now())).toBe(true);
    expect(await store.started('inst0001', started('over'), c.now())).toBe(false);
  });
});

describe('page liveness', () => {
  it('beats while active, stops and forgets stale pages', () => {
    const c = clock();
    const storage = new MemoryStorage();
    storage.setItem(PAGE_KEY_PREFIX + 'dead', String(c.now() - PAGE_STALE_MS - 1));
    storage.setItem(PAGE_KEY_PREFIX + 'recent', String(c.now() - 1000));
    const timers = manualTimers(c);
    const l = createPageLiveness({ id: 'me', storage, now: c.now, timers });
    expect(storage.getItem(PAGE_KEY_PREFIX + 'dead')).toBeNull();
    expect(l.isAlive('recent')).toBe(true);
    expect(l.isAlive('me')).toBe(true);
    expect(l.isAlive('dead')).toBe(false);
    l.setActive(true);
    timers.run(HEARTBEAT_MS);
    expect(storage.getItem(PAGE_KEY_PREFIX + 'me')).toBe(String(c.now()));
    l.setActive(false);
    expect(storage.getItem(PAGE_KEY_PREFIX + 'me')).toBeNull();
    c.advance(PAGE_STALE_MS);
    expect(l.isAlive('recent')).toBe(false);
  });
});
