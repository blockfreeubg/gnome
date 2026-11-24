import { describe, expect, it } from 'vitest';
import { createChangeHub } from './changes';
import type { LibraryDb } from './db';
import { CAP_CHECK_EVERY, createHistoryStore, HISTORY_BYTES_TRIM_TO, MAX_HISTORY_BYTES, MAX_VISITS, QUOTA_EVICT_MIN, SUGGEST_SCAN, TITLE_WINDOW_MS, visitBytes, type HistoryPrefs } from './history';
import { DAY_MS } from './match';
import { clock, LIBRARY_DBS, uuids } from './testing/dbs';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe.each(LIBRARY_DBS)('history store on %s', (_name, makeDb) => {
  async function setup(prefs: Partial<HistoryPrefs> = {}, limits: { maxVisits?: number; capCheckEvery?: number; maxBytes?: number } = {}) {
    const raw: LibraryDb = await makeDb();
    // Counts the records each query hands to the store (directly or through its filter): the work an event causes.
    let reads = 0;
    const db: LibraryDb = {
      ...raw,
      query: (store, q = {}) => {
        if (!q.filter) return raw.query(store, q).then((rows) => ((reads += rows.length), rows));
        const filter = q.filter as (v: unknown) => boolean;
        return raw.query(store, { ...q, filter: (v) => (reads++, filter(v)) });
      },
    };
    const c = clock();
    const p: HistoryPrefs = { enabled: true, retentionDays: 90, ...prefs };
    let pending = 0;
    const store = createHistoryStore({
      db,
      prefs: () => p,
      now: c.now,
      uuid: uuids(),
      hub: createChangeHub('history', { crossTab: false }),
      onPending: () => pending++,
      ...limits,
    });
    return { db, raw, c, p, store, pending: () => pending, reads: () => reads };
  }

  it('records http(s) visits only while history is enabled', async () => {
    const { store, p, c, pending } = await setup();
    await store.recordVisit({ url: 'https://example.com/a', title: '  Example   A ', at: c.now() });
    await store.recordVisit({ url: 'javascript:alert(1)', title: 'x', at: c.now() });
    await store.recordVisit({ url: 'data:text/html,hi', title: 'x', at: c.now() });
    await store.recordVisit({ url: 'https://user:pw@example.com/', title: 'x', at: c.now() });
    await store.recordVisit({ url: `https://example.com/${'x'.repeat(4100)}`, title: 'x', at: c.now() });
    p.enabled = false;
    await store.recordVisit({ url: 'https://example.com/off', title: 'off', at: c.now() });
    const rows = await store.query({ limit: 10 });
    expect(rows.map((r) => [r.url, r.title])).toEqual([['https://example.com/a', 'Example A']]);
    expect(pending()).toBe(1);
  });

  it('caps titles at 512 characters, strips control characters, and clamps future times to now', async () => {
    const { store, c } = await setup();
    await store.recordVisit({ url: 'https://example.com/', title: `a\u0000b\u0007${'é'.repeat(600)}`, at: c.now() + 10 * DAY_MS });
    const [v] = await store.query({ limit: 1 });
    expect([...v!.title!].length).toBe(512);
    expect(v!.title!.startsWith('a b ')).toBe(true);
    expect(v!.visitedAt).toBe(c.now());
  });

  it('pages newest first with `before`, and searches URL and title case-insensitively (every word)', async () => {
    const { store, c } = await setup();
    for (let i = 0; i < 25; i++) {
      await store.recordVisit({ url: `https://site${i % 3}.example/page${i}`, title: i % 2 ? `Rust guide ${i}` : `Svelte notes ${i}`, at: c.now() - (25 - i) * 1000 });
    }
    const first = await store.query({ limit: 10 });
    expect(first).toHaveLength(10);
    expect(first[0]!.url).toBe('https://site0.example/page24');
    const second = await store.query({ limit: 10, before: first[9]!.visitedAt });
    expect(second[0]!.visitedAt).toBeLessThan(first[9]!.visitedAt);
    const all = [...first, ...second, ...(await store.query({ limit: 10, before: second[9]!.visitedAt }))];
    expect(new Set(all.map((v) => v.id)).size).toBe(25);
    const rust = await store.query({ text: 'RUST guide', limit: 100 });
    expect(rust.length).toBe(12);
    expect(rust.every((v) => v.title!.startsWith('Rust'))).toBe(true);
    expect((await store.query({ text: 'site1 svelte', limit: 100 })).every((v) => v.url.includes('site1') && v.title!.includes('Svelte'))).toBe(true);
    expect(await store.query({ limit: 0 })).toEqual([]);
  });

  it('pages with (before, beforeId) without skipping visits that share the boundary millisecond', async () => {
    const { store, c } = await setup();
    const t = c.now() - 5000;
    for (let i = 0; i < 5; i++) await store.recordVisit({ url: `https://same.example/${i}`, title: null, at: t });
    await store.recordVisit({ url: 'https://older.example/', title: null, at: t - 1 });
    await store.recordVisit({ url: 'https://newer.example/', title: null, at: t + 1 });
    const seen: string[] = [];
    let last: { visitedAt: number; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await store.query({ before: last?.visitedAt, beforeId: last?.id, limit: 2 });
      if (!page.length) break;
      seen.push(...page.map((v) => v.url));
      last = page[page.length - 1];
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe('https://newer.example/');
    expect(seen[6]).toBe('https://older.example/');
    // Without beforeId, `before` stays exclusive (the HistoryStore contract).
    expect((await store.query({ before: t, limit: 10 })).map((v) => v.url)).toEqual(['https://older.example/']);
  });

  it('updateTitle writes nothing while history is off', async () => {
    const { store, p, c } = await setup();
    await store.recordVisit({ url: 'https://example.com/', title: 'Before', at: c.now() });
    p.enabled = false;
    await store.updateTitle('https://example.com/', 'After');
    expect((await store.query({ limit: 1 }))[0]!.title).toBe('Before');
  });

  it('updateTitle names the newest visit of the URL from the last 30 minutes only', async () => {
    const { store, c } = await setup();
    await store.recordVisit({ url: 'https://example.com/', title: null, at: c.now() - TITLE_WINDOW_MS - 1000 });
    await store.recordVisit({ url: 'https://example.com/', title: null, at: c.now() - 1000 });
    await store.updateTitle('https://example.com/', 'Example Domain');
    const rows = await store.query({ limit: 5 });
    expect(rows.map((r) => r.title)).toEqual(['Example Domain', null]);
    c.advance(TITLE_WINDOW_MS + 5000);
    await store.updateTitle('https://example.com/', 'Later');
    expect((await store.query({ limit: 5 })).map((r) => r.title)).toEqual(['Example Domain', null]);
  });

  it('updateTitle reads only the visits of the last 30 minutes, however many visits the URL has', async () => {
    const { store, raw, c, reads } = await setup();
    const url = 'https://busy.example/';
    // A forged commit stream can give one URL thousands of visits; a title event must not read them all.
    const old = Array.from({ length: 3000 }, (_, i) => ({ id: `old-${i}`, url, title: null, visitedAt: c.now() - TITLE_WINDOW_MS - 60_000 - i * 1000 }));
    await raw.putMany('history', old);
    await store.recordVisit({ url, title: null, at: c.now() - 5000 });
    await store.recordVisit({ url: 'https://other.example/', title: null, at: c.now() - 1000 });
    const before = reads();
    await store.updateTitle(url, 'Busy');
    expect(reads() - before).toBeLessThanOrEqual(2);
    expect((await store.query({ limit: 2 })).map((v) => [v.url, v.title])).toEqual([
      ['https://other.example/', null],
      [url, 'Busy'],
    ]);
  });

  it('a title change in the same millisecond as the upload is still pending afterwards', async () => {
    const { store, c } = await setup();
    await store.recordVisit({ url: 'https://same-ms.example/', title: null, at: c.now() });
    const handedOut = await store.sync.pending(10);
    await store.updateTitle('https://same-ms.example/', 'Named'); // no clock advance
    await store.sync.acknowledge(handedOut);
    expect((await store.sync.pending(10)).map((v) => [v.url, v.title])).toEqual([['https://same-ms.example/', 'Named']]);
  });

  it(`keeps at most maxVisits visits (default ${MAX_VISITS}), deleting the oldest, checked every ${CAP_CHECK_EVERY} new visits`, async () => {
    const { store, raw, c } = await setup({ retentionDays: 0 }, { maxVisits: 50, capCheckEvery: 10 });
    expect(MAX_VISITS).toBe(100_000);
    // An existing store over the cap (another device, an older build) is trimmed by prune() (at start and daily).
    await raw.putMany('history', Array.from({ length: 60 }, (_, i) => ({ id: `seed-${String(i).padStart(3, '0')}`, url: `https://seed.example/${i}`, title: null, visitedAt: c.now() - 1e9 + i })));
    expect(await store.prune()).toBe(10);
    expect(await store.count()).toBe(50);
    expect((await store.query({ limit: 100 })).at(-1)!.url).toBe('https://seed.example/10');
    // A flood of new visits never leaves more than maxVisits + capCheckEvery.
    for (let i = 0; i < 95; i++) {
      c.advance(1000);
      await store.recordVisit({ url: `https://flood.example/${i}`, title: null, at: c.now() });
      expect(await store.count()).toBeLessThanOrEqual(60);
    }
    await store.prune();
    const left = await store.query({ limit: 100 });
    expect(left).toHaveLength(50);
    // The newest survive.
    expect(left[0]!.url).toBe('https://flood.example/94');
    expect(left.every((v) => v.url.startsWith('https://flood.example/'))).toBe(true);
  });

  it(`keeps the visits' estimated size within the byte budget (default ${MAX_HISTORY_BYTES} B), oldest first, with the count cap`, async () => {
    expect(MAX_HISTORY_BYTES).toBe(64 * 1024 * 1024);
    expect(visitBytes({ url: 'https://a.example/', title: 'Ab' })).toBe(2 * (18 + 2) + 96);
    const maxBytes = 20_000;
    const { store, raw, c } = await setup({ retentionDays: 0 }, { maxVisits: 1000, capCheckEvery: 5, maxBytes });
    // A store over the budget at start (≈ 1.2 KB per seeded visit) is trimmed by prune() to 90 % of it, oldest first.
    const seed = Array.from({ length: 30 }, (_, i) => ({ id: `seed-${String(i).padStart(3, '0')}`, url: `https://seed.example/${i}/${'p'.repeat(500)}`, title: null, visitedAt: c.now() - 1e9 + i }));
    await raw.putMany('history', seed);
    const dropped = await store.prune();
    expect(dropped).toBeGreaterThan(0);
    const left = await store.query({ limit: 100 });
    expect(left.length).toBe(30 - dropped);
    expect(left.at(-1)!.url.startsWith(`https://seed.example/${dropped}/`)).toBe(true);
    expect(await store.estimatedBytes()).toBeLessThanOrEqual(maxBytes * HISTORY_BYTES_TRIM_TO);
    // A flood of large visits (also synced ones) never leaves the estimate far above the budget.
    for (let i = 0; i < 60; i++) {
      c.advance(1000);
      await store.recordVisit({ url: `https://flood.example/${i}/${'q'.repeat(400)}`, title: 'T'.repeat(200), at: c.now() });
      expect(await store.estimatedBytes()).toBeLessThanOrEqual(maxBytes + 5 * visitBytes({ url: `https://flood.example/${i}/${'q'.repeat(400)}`, title: 'T'.repeat(200) }));
    }
    await store.sync.applyRemote(
      Array.from({ length: 10 }, (_, i) => ({ id: `remote-${i}`, url: `https://remote.example/${i}/${'r'.repeat(600)}`, title: null, visitedAt: c.now() + i })),
      { clearedBefore: null },
    );
    await store.prune();
    expect(await store.estimatedBytes()).toBeLessThanOrEqual(maxBytes);
    const newest = await store.query({ limit: 1 });
    expect(newest[0]!.id).toBe('remote-9');
    // The running estimate equals a recompute from every visit (a second store over the same database recomputes).
    await store.updateTitle(`https://flood.example/59/${'q'.repeat(400)}`, 'short');
    await store.removeUrl(`https://remote.example/3/${'r'.repeat(600)}`);
    const running = await store.estimatedBytes();
    const fresh = createHistoryStore({ db: raw, prefs: () => ({ enabled: true, retentionDays: 0 }), now: c.now, uuid: uuids('b'), hub: createChangeHub('history', { crossTab: false }) });
    expect(await fresh.estimatedBytes()).toBe(running);
    const all = await raw.query('history');
    expect(running).toBe(all.reduce((n, r) => n + visitBytes(r), 0));
    // remove(ids) makes the estimate unknown; the next read recomputes it.
    await store.remove([all[0]!.id]);
    expect(await store.estimatedBytes()).toBe(running - visitBytes(all[0]!));
    await store.clear();
    expect(await store.estimatedBytes()).toBe(0);
    fresh.close();
  });

  it('removes by id, by exact URL (resolving the count), by range and all, notifying listeners', async () => {
    const { store, c } = await setup();
    let changes = 0;
    store.onChange(() => changes++);
    const at = c.now();
    for (const [i, url] of ['https://a.example/', 'https://b.example/', 'https://a.example/', 'https://c.example/'].entries()) {
      await store.recordVisit({ url, title: null, at: at - i * 1000 });
    }
    await tick();
    const before = changes;
    expect(await store.removeUrl('https://a.example/')).toBe(2);
    expect(await store.removeUrl('https://nothing.example/')).toBe(0);
    let rows = await store.query({ limit: 10 });
    expect(rows.map((r) => r.url)).toEqual(['https://b.example/', 'https://c.example/']);
    await store.remove([rows[0]!.id]);
    expect((await store.query({ limit: 10 })).map((r) => r.url)).toEqual(['https://c.example/']);
    await store.recordVisit({ url: 'https://d.example/', title: null, at: at - 500 });
    await store.removeRange(at - 3500, at - 2500); // removes c (at - 3000)
    rows = await store.query({ limit: 10 });
    expect(rows.map((r) => r.url)).toEqual(['https://d.example/']);
    await store.clear();
    expect(await store.count()).toBe(0);
    await tick();
    expect(changes).toBeGreaterThan(before);
  });

  it('when storage is full, recordVisit drops the oldest visits and records the new one', async () => {
    // `db` is this test's wrapper around the database (the store's view of it): patching it leaks into no other test.
    const { store, db, raw, c } = await setup({ retentionDays: 0 });
    const t = c.now() - DAY_MS;
    await raw.putMany(
      'history',
      Array.from({ length: 1200 }, (_, i) => ({ id: `e0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, url: `https://old.example/${i}`, title: null, visitedAt: t + i })),
    );
    // The origin's quota is used up until something is deleted.
    let full = true;
    db.putMany = async (s, v) => {
      if (full && s === 'history') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return raw.putMany(s, v);
    };
    db.deleteMany = async (s, ids) => {
      if (ids.length) full = false;
      return raw.deleteMany(s, ids);
    };
    await store.recordVisit({ url: 'https://new.example/', title: 'New', at: c.now() });
    const [newest] = await store.query({ limit: 1 });
    expect(newest!.url).toBe('https://new.example/');
    // At least QUOTA_EVICT_MIN of the oldest went (5 % of 1200 is less); the newest old ones stay.
    expect(await store.count()).toBe(1200 - QUOTA_EVICT_MIN + 1);
    expect((await store.visitsOf('https://old.example/0')).length).toBe(0);
    expect((await store.visitsOf('https://old.example/1199')).length).toBe(1);
    // Other write errors are not retried.
    db.putMany = async () => {
      throw new DOMException('Broken', 'UnknownError');
    };
    await expect(store.recordVisit({ url: 'https://x.example/', title: null, at: c.now() })).rejects.toThrow('Broken');
    expect(await store.count()).toBe(1200 - QUOTA_EVICT_MIN + 1);
  });

  it('removes a range larger than one delete batch completely', async () => {
    const { store, raw, c } = await setup({ retentionDays: 0 });
    const t = c.now() - DAY_MS;
    await raw.putMany(
      'history',
      Array.from({ length: 4100 }, (_, i) => ({ id: `f0000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, url: `https://bulk.example/${i}`, title: null, visitedAt: t + i })),
    );
    await store.recordVisit({ url: 'https://outside.example/', title: null, at: t - 10 });
    await store.removeRange(t, t + 4100);
    expect((await store.query({ limit: 10 })).map((v) => v.url)).toEqual(['https://outside.example/']);
    // 4,100 puts and deletes on fake-indexeddb take ~1.6 s on an idle machine and timed out at vitest's default 5 s
    // under load: the timeout matches the work, the assertions stay as they are.
  }, 30_000);

  it('prunes visits older than the retention period, never with retention 0 (forever)', async () => {
    const { store, c, p } = await setup({ retentionDays: 7 });
    p.retentionDays = 0;
    await store.recordVisit({ url: 'https://old.example/', title: null, at: c.now() - 30 * DAY_MS });
    await store.recordVisit({ url: 'https://new.example/', title: null, at: c.now() - DAY_MS });
    expect(await store.prune()).toBe(0);
    p.retentionDays = 7;
    expect(await store.prune()).toBe(1);
    expect((await store.query({ limit: 10 })).map((v) => v.url)).toEqual(['https://new.example/']);
    // A visit older than the retention period is not recorded at all.
    await store.recordVisit({ url: 'https://ancient.example/', title: null, at: c.now() - 8 * DAY_MS });
    expect(await store.count()).toBe(1);
  });

  it('suggests by match quality and frecency, one entry per URL', async () => {
    const { store, c } = await setup();
    const now = c.now();
    for (let i = 0; i < 6; i++) await store.recordVisit({ url: 'https://github.com/', title: 'GitHub', at: now - i * 60_000 });
    await store.recordVisit({ url: 'https://github.blog/', title: 'The GitHub Blog', at: now - 40 * DAY_MS });
    await store.recordVisit({ url: 'https://example.com/git-tips', title: 'Tips', at: now - 1000 });
    await store.recordVisit({ url: 'https://unrelated.example/', title: 'Nothing', at: now });
    const s = await store.suggest('git', 5);
    expect(s.map((x) => x.url)).toEqual(['https://github.com/', 'https://github.blog/', 'https://example.com/git-tips']);
    expect(s.every((x) => x.source === 'history' && x.score > 0)).toBe(true);
    expect(s[0]!.score).toBeGreaterThan(s[1]!.score);
    expect(await store.suggest('   ', 5)).toEqual([]);
    expect(await store.suggest('git', 1)).toHaveLength(1);
    // A new visit invalidates the suggestion cache.
    await store.recordVisit({ url: 'https://gitlab.com/', title: 'GitLab', at: now });
    expect((await store.suggest('gitlab', 5)).map((x) => x.url)).toEqual(['https://gitlab.com/']);
    expect(SUGGEST_SCAN).toBeGreaterThanOrEqual(1000);
  });

  describe('sync adapter', () => {
    it('hands out pending visits oldest first and acknowledges unless the visit changed again', async () => {
      const { store, c } = await setup();
      await store.recordVisit({ url: 'https://a.example/', title: 'A', at: c.now() - 2000 });
      await store.recordVisit({ url: 'https://b.example/', title: null, at: c.now() - 1000 });
      const pending = await store.sync.pending(10);
      expect(pending.map((p) => p.url)).toEqual(['https://a.example/', 'https://b.example/']);
      c.advance(10);
      await store.updateTitle('https://b.example/', 'B'); // changed after pending() handed it out
      await store.sync.acknowledge(pending);
      const left = await store.sync.pending(10);
      expect(left.map((p) => [p.url, p.title])).toEqual([['https://b.example/', 'B']]);
      await store.sync.acknowledge(left);
      expect(await store.sync.pending(10)).toEqual([]);
      expect(await store.count()).toBe(2);
    });

    it('never hands out a visit the server would refuse: it stays on this device, the rest keeps syncing', async () => {
      const { store, raw, c } = await setup();
      await store.recordVisit({ url: 'https://a.example/', title: 'A', at: c.now() - 1000 });
      const t = c.now();
      // Left by an older build or another code path: a host the server refuses, a non-UUID id, a lone surrogate.
      await raw.putMany('history', [
        { id: 'c0000000-0000-4000-8000-000000000001', url: 'http://a$b.example/', title: null, visitedAt: t - 3000, syncPending: t - 3000 },
        { id: 'legacy-1', url: 'https://b.example/', title: null, visitedAt: t - 2500, syncPending: t - 2500 },
        { id: 'c0000000-0000-4000-8000-000000000002', url: 'https://c.example/', title: 'x \udc00', visitedAt: t - 2000, syncPending: t - 2000 },
      ]);
      const out = await store.sync.pending(10);
      expect(out.map((v) => v.url)).toEqual(['https://a.example/']);
      expect(await store.count()).toBe(4); // still in the local history
      expect((await raw.get('history', 'legacy-1'))!.syncPending).toBeUndefined();
      // A full batch of refused visits does not hide the valid ones behind it.
      await raw.putMany(
        'history',
        Array.from({ length: 12 }, (_, i) => ({ id: `legacy-x${i}`, url: 'https://d.example/', title: null, visitedAt: t - 9000 + i, syncPending: t - 9000 + i })),
      );
      expect((await store.sync.pending(5)).map((v) => v.url)).toEqual(['https://a.example/']);
    });

    it('applies remote visits (upsert by id), honours clearedBefore and keeps local edits that are not uploaded', async () => {
      const { store, c } = await setup();
      const now = c.now();
      await store.recordVisit({ url: 'https://old-local.example/', title: null, at: now - 5 * DAY_MS });
      await store.recordVisit({ url: 'https://local.example/', title: 'mine', at: now - 1000 });
      const [local] = await store.sync.pending(10).then((p) => p.filter((v) => v.url === 'https://local.example/'));
      await store.sync.applyRemote(
        [
          { id: local!.id, url: 'https://local.example/', title: 'theirs', visitedAt: now - 1000 },
          { id: 'b0000000-0000-4000-8000-000000000001', url: 'https://remote.example/x', title: 'Remote', visitedAt: now - 2000 },
          { id: 'b0000000-0000-4000-8000-000000000002', url: 'https://too-old.example/', title: null, visitedAt: now - 6 * DAY_MS },
          { id: 'b0000000-0000-4000-8000-000000000003', url: 'javascript:void(0)', title: null, visitedAt: now - 100 },
        ],
        { clearedBefore: now - 4 * DAY_MS },
      );
      const rows = await store.query({ limit: 10 });
      expect(rows.map((r) => [r.url, r.title])).toEqual([
        ['https://local.example/', 'mine'],
        ['https://remote.example/x', 'Remote'],
      ]);
      // Remote visits are not pending (they came from the server).
      expect((await store.sync.pending(10)).map((p) => p.url)).toEqual(['https://local.example/']);
    });
  });
});

describe('history restore (Undo)', () => {
  it('puts deleted visits back with their ids', async () => {
    const { createMemoryDb } = await import('./testing/memory-db');
    const c = clock();
    const store = createHistoryStore({ db: createMemoryDb(), prefs: () => ({ enabled: true, retentionDays: 0 }), now: c.now, uuid: uuids(), hub: createChangeHub('history', { crossTab: false }) });
    await store.recordVisit({ url: 'https://a.example/', title: 'A', at: c.now() - 10 });
    await store.recordVisit({ url: 'https://a.example/', title: 'A', at: c.now() });
    const visits = await store.visitsOf('https://a.example/');
    expect(visits).toHaveLength(2);
    expect(visits[0]!.visitedAt).toBeGreaterThan(visits[1]!.visitedAt);
    await store.removeUrl('https://a.example/');
    await store.restore(visits);
    expect((await store.query({ limit: 10 })).map((v) => v.id)).toEqual(visits.map((v) => v.id));
  });
});

describe('history byte budget recompute (unit benchmark, WAVE-D D21)', () => {
  it('recomputes the estimate of 100 000 visits at start', async () => {
    const { createMemoryDb } = await import('./testing/memory-db');
    const db = createMemoryDb();
    const c = clock();
    const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: `v-${i}`, url: `https://example.com/page/${i}?q=${'x'.repeat(100)}`, title: `Page ${i}`, visitedAt: c.now() - i }));
    await db.putMany('history', rows);
    const store = createHistoryStore({ db, prefs: () => ({ enabled: true, retentionDays: 0 }), now: c.now, uuid: uuids(), hub: createChangeHub('history', { crossTab: false }) });
    const t = performance.now();
    expect(await store.prune()).toBe(0);
    const ms = performance.now() - t;
    console.info(`[D21] recompute + cap check of 100 000 visits (memory db): ${ms.toFixed(1)} ms`);
    expect(await store.estimatedBytes()).toBe(rows.reduce((n, r) => n + visitBytes(r), 0));
    store.close();
  });
});
