import { describe, expect, it } from 'vitest';
import type { BookmarkRecord } from '../lib/idb';
import { bookmarkFromWire, bookmarkToWire, syncRecordsOnce, type RecordCursorStore, type RecordKind, type RecordSyncTransport } from '../settings/sync';
import { BOOKMARK_ROOT } from '../shared/browser-data';
import { BookmarkError, createBookmarkStore, placeAt, TOMBSTONE_KEEP_MS } from './bookmarks';
import { createChangeHub } from './changes';
import type { LibraryDb } from './db';
import { clock, LIBRARY_DBS, uuids } from './testing/dbs';
import { createMemoryDb } from './testing/memory-db';

describe('placeAt', () => {
  const rec = (id: string, position: number) => ({ id, position }) as BookmarkRecord;
  it('puts an item before, between or after its siblings with one write', () => {
    const s = [rec('a', 0), rec('b', 1), rec('c', 2)];
    expect(placeAt([], 0)).toEqual({ position: 0, renumber: [] });
    expect(placeAt(s, 0)).toEqual({ position: -1, renumber: [] });
    expect(placeAt(s, 1)).toEqual({ position: 0.5, renumber: [] });
    expect(placeAt(s, 3)).toEqual({ position: 3, renumber: [] });
    expect(placeAt(s, 99)).toEqual({ position: 3, renumber: [] });
    expect(placeAt(s, -5)).toEqual({ position: -1, renumber: [] });
  });
  it('renumbers the siblings when the gap is too small', () => {
    const s = [rec('a', 0), rec('b', 0.0000001), rec('c', 5)];
    const out = placeAt(s, 1);
    expect(out.position).toBe(1);
    expect(out.renumber).toEqual([
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
    ]);
  });
});

describe.each(LIBRARY_DBS)('bookmark store on %s', (_name, makeDb) => {
  /** A second device in the same test always runs on memory (IndexedDB here is one global database). */
  async function setup(prefix = 'a', second = false) {
    const db: LibraryDb = second ? createMemoryDb() : await makeDb();
    const c = clock();
    let pending = 0;
    const store = createBookmarkStore({ db, now: c.now, uuid: uuids(prefix), hub: createChangeHub('bookmarks', { crossTab: false }), onPending: () => pending++ });
    return { db, c, store, pending: () => pending };
  }

  it('adds bookmarks and folders in position order under the root sentinel', async () => {
    const { store, db } = await setup();
    const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'A', url: 'https://a.example' });
    const f = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: '  Reading  ', url: 'https://ignored.example/' });
    const b = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: '', url: 'https://www.b.example/x', position: 0 });
    expect(f.url).toBeNull();
    expect(f.title).toBe('Reading');
    expect(b.title).toBe('b.example');
    expect(a.url).toBe('https://a.example/');
    expect((await store.children(BOOKMARK_ROOT)).map((x) => x.id)).toEqual([b.id, a.id, f.id]);
    const inner = await store.add({ parentId: f.id, kind: 'bookmark', title: 'In', url: 'https://in.example/' });
    expect((await store.children(f.id)).map((x) => x.id)).toEqual([inner.id]);
    // Stored records never use null for the root (IndexedDB does not index null).
    const raw = await db.get('bookmarks', a.id);
    expect(raw!.parentId).toBe(BOOKMARK_ROOT);
    expect(raw!.syncPending).toBeTypeOf('number');
  });

  it('refuses non-http URLs, unknown parents and folders inside themselves', async () => {
    const { store } = await setup();
    await expect(store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'x', url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid-url' });
    await expect(store.add({ parentId: 'nope', kind: 'bookmark', title: 'x', url: 'https://x.example/' })).rejects.toBeInstanceOf(BookmarkError);
    const f1 = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'F1', url: null });
    const f2 = await store.add({ parentId: f1.id, kind: 'folder', title: 'F2', url: null });
    const bm = await store.add({ parentId: f2.id, kind: 'bookmark', title: 'B', url: 'https://b.example/' });
    await expect(store.update(f1.id, { parentId: f2.id })).rejects.toMatchObject({ code: 'cycle' });
    await expect(store.update(f1.id, { parentId: f1.id })).rejects.toMatchObject({ code: 'cycle' });
    await expect(store.add({ parentId: bm.id, kind: 'bookmark', title: 'x', url: 'https://x.example/' })).rejects.toMatchObject({ code: 'invalid-parent' });
    await expect(store.update(bm.id, { url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'invalid-url' });
  });

  it('refuses a move that would nest the moved folder’s subtree past MAX_DEPTH, and allows one that fits', async () => {
    const { store } = await setup();
    const chain = async (n: number, label: string): Promise<string[]> => {
      const ids: string[] = [];
      let parent = BOOKMARK_ROOT;
      for (let i = 0; i < n; i++) {
        parent = (await store.add({ parentId: parent, kind: 'folder', title: `${label}${i}`, url: null })).id;
        ids.push(parent);
      }
      return ids;
    };
    // A: 40 nested folders. B: 30 nested folders with a bookmark at the bottom (height 30 below B's top folder).
    const a = await chain(40, 'a');
    const b = await chain(30, 'b');
    await store.add({ parentId: b.at(-1)!, kind: 'bookmark', title: 'deep', url: 'https://deep.example/' });
    const bTop = b[0]!;
    // Into A's deepest folder: 40 folders above B's top + 30 levels below it ≥ MAX_DEPTH (64).
    await expect(store.update(bTop, { parentId: a.at(-1)! })).rejects.toMatchObject({ code: 'cycle' });
    expect((await store.get(bTop))!.parentId).toBe(BOOKMARK_ROOT);
    // Into A's 30th folder: 30 + 30 = 60 < 64, and the deepest bookmark ends with 63 folders above it.
    await store.update(bTop, { parentId: a[29]! });
    expect((await store.get(bTop))!.parentId).toBe(a[29]);
    // Four levels deeper no longer fits: 34 + 30 = 64 would put 64 folders above the deepest bookmark.
    await expect(store.update(bTop, { parentId: a[33]! })).rejects.toMatchObject({ code: 'cycle' });
    expect((await store.get(bTop))!.parentId).toBe(a[29]);
    // A bookmark (height 0) is held to add()'s limit: not below a folder that already has 64 folders above it.
    const full = await chain(64, 'f');
    const loose = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'loose', url: 'https://loose.example/' });
    await expect(store.update(loose.id, { parentId: full.at(-1)! })).rejects.toMatchObject({ code: 'cycle' });
    await expect(store.update(loose.id, { parentId: full.at(-2)! })).resolves.toMatchObject({ parentId: full.at(-2) });
  });

  it('updates with last-writer-wins stamps max(now, updatedAt + 1) and moves between folders', async () => {
    const { store, c } = await setup();
    const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'A', url: 'https://a.example/' });
    const f = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'F', url: null });
    // Same millisecond: the stamp still grows.
    const edited = await store.update(a.id, { title: 'A2' });
    expect(edited.updatedAt).toBe(a.updatedAt + 1);
    c.advance(5000);
    const moved = await store.update(a.id, { parentId: f.id });
    expect(moved.parentId).toBe(f.id);
    expect(moved.updatedAt).toBe(c.now());
    expect((await store.children(BOOKMARK_ROOT)).map((x) => x.id)).toEqual([f.id]);
    // A no-op patch does not stamp.
    const same = await store.update(a.id, { title: 'A2' });
    expect(same.updatedAt).toBe(moved.updatedAt);
    // Reorder within a folder.
    const b = await store.add({ parentId: f.id, kind: 'bookmark', title: 'B', url: 'https://b.example/' });
    await store.update(b.id, { position: 0 });
    expect((await store.children(f.id)).map((x) => x.title)).toEqual(['B', 'A2']);
  });

  it('favorites are device-local: no stamp, no sync, listed in position order', async () => {
    const { store, pending } = await setup();
    const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'A', url: 'https://a.example/' });
    const b = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'B', url: 'https://b.example/', favorite: true });
    await store.sync.acknowledge(await store.sync.pending(10));
    const before = pending();
    await store.setFavorite(a.id, true);
    expect(pending()).toBe(before);
    expect((await store.get(a.id))!.updatedAt).toBe(a.updatedAt);
    expect(await store.sync.pending(10)).toEqual([]);
    expect((await store.favorites(10)).map((x) => x.id)).toEqual([a.id, b.id]);
    expect(await store.favorites(1)).toHaveLength(1);
    await store.setFavorite(b.id, false);
    expect((await store.favorites(10)).map((x) => x.id)).toEqual([a.id]);
  });

  it('byUrl and suggest find live bookmarks; search covers folders', async () => {
    const { store } = await setup();
    const f = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'Rust things', url: null });
    await store.add({ parentId: f.id, kind: 'bookmark', title: 'The Rust Book', url: 'https://doc.rust-lang.org/book/' });
    const gone = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'Rust gone', url: 'https://doc.rust-lang.org/book/' });
    await store.remove(gone.id);
    expect((await store.byUrl('https://doc.rust-lang.org/book/')).map((b) => b.title)).toEqual(['The Rust Book']);
    const s = await store.suggest('rust', 5);
    expect(s).toEqual([{ url: 'https://doc.rust-lang.org/book/', title: 'The Rust Book', source: 'bookmark', score: expect.any(Number) }]);
    expect((await store.search('rust', 10)).map((b) => b.title).sort()).toEqual(['Rust things', 'The Rust Book']);
  });

  it('removing a folder tombstones it with its contents; undo restores them', async () => {
    const { store, db } = await setup();
    const f = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'F', url: null });
    const sub = await store.add({ parentId: f.id, kind: 'folder', title: 'Sub', url: null });
    await store.add({ parentId: sub.id, kind: 'bookmark', title: 'Deep', url: 'https://deep.example/' });
    const undo = await store.removeWithUndo(f.id);
    expect(await store.children(BOOKMARK_ROOT)).toEqual([]);
    expect(await store.get(sub.id)).toBeNull();
    const tombs = (await db.query('bookmarks', {})).filter((r) => r.deleted);
    expect(tombs).toHaveLength(3);
    expect(tombs.map((t) => bookmarkToWire(t)).every((w) => w.deleted && w.title === '' && w.url === null)).toBe(true);
    // The stored tombstones keep nothing of the deleted pages either (they can stay 180 days when sync is off).
    expect(tombs.every((t) => t.title === '' && t.url === null)).toBe(true);
    await undo();
    expect((await store.children(BOOKMARK_ROOT)).map((x) => x.title)).toEqual(['F']);
    expect((await store.children(sub.id)).map((x) => [x.title, x.url])).toEqual([['Deep', 'https://deep.example/']]);
  });

  it('Undo stamps the restored items newer than their tombstones, also after the tombstones were uploaded', async () => {
    const { store, c } = await setup();
    const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'A', url: 'https://a.example/' });
    // Another device's clock ran an hour ahead: the copy it synced is stamped in this device's future.
    const ahead = c.now() + 3_600_000;
    await store.sync.applyRemote(
      [{ id: a.id, parentId: null, kind: 'bookmark', title: 'A', url: 'https://a.example/', position: 0, createdAt: a.createdAt, updatedAt: ahead, deleted: false }],
      { clearedBefore: null },
    );
    const undo = await store.removeWithUndo(a.id);
    const [tomb] = await store.sync.pending(10);
    expect(tomb!.deleted).toBe(true);
    await store.sync.acknowledge([tomb!]); // uploaded and purged
    c.advance(1000);
    await undo();
    const [back] = await store.sync.pending(10);
    expect(back!.deleted).toBe(false);
    expect(back!.updatedAt).toBeGreaterThan(tomb!.updatedAt);
  });

  it('imports a tree into a new folder, skipping URLs that are not http(s)', async () => {
    const { store } = await setup();
    const out = await store.importTree(
      [
        { kind: 'bookmark', title: 'One', url: 'https://one.example/', addedAt: 1_600_000_000_000 },
        { kind: 'bookmark', title: 'Smart', url: 'place:sort=8&maxResults=10' },
        { kind: 'folder', title: 'Dev', url: null, children: [{ kind: 'bookmark', title: 'MDN', url: 'https://developer.mozilla.org/' }] },
      ],
      BOOKMARK_ROOT,
      { folderTitle: 'Imported' },
    );
    expect(out).toMatchObject({ bookmarks: 2, folders: 2, skipped: 1 });
    const [imported] = await store.children(BOOKMARK_ROOT);
    expect(imported!.title).toBe('Imported');
    const kids = await store.children(imported!.id);
    expect(kids.map((k) => k.title)).toEqual(['One', 'Dev']);
    expect(kids[0]!.createdAt).toBe(1_600_000_000_000);
    expect((await store.children(kids[1]!.id)).map((k) => k.url)).toEqual(['https://developer.mozilla.org/']);
  });

  it('purges acknowledged tombstones and old unacknowledged ones', async () => {
    const { store, db, c } = await setup();
    const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'A', url: 'https://a.example/' });
    const b = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'B', url: 'https://b.example/' });
    await store.remove(a.id);
    await store.sync.acknowledge((await store.sync.pending(10)).filter((p) => p.id === a.id));
    expect(await db.get('bookmarks', a.id)).toBeUndefined();
    await store.remove(b.id);
    expect(await store.purgeTombstones()).toBe(0);
    c.advance(TOMBSTONE_KEEP_MS + 1000);
    expect(await store.purgeTombstones()).toBe(1);
    expect(await db.get('bookmarks', b.id)).toBeUndefined();
  });

  describe('sync adapter', () => {
    it('maps the root sentinel to parent_id null on the wire and back', async () => {
      const { store } = await setup();
      const top = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'Top', url: null });
      await store.add({ parentId: top.id, kind: 'bookmark', title: 'In', url: 'https://in.example/', favorite: true });
      const pending = await store.sync.pending(10);
      const wire = pending.map(bookmarkToWire);
      expect(wire.find((w) => w.id === top.id)!.parent_id).toBeNull();
      expect(wire.find((w) => w.id !== top.id)!.parent_id).toBe(top.id);
      expect(wire.every((w) => !('favorite' in w))).toBe(true);
      // Another device receives them through bookmarkFromWire → applyRemote.
      const other = await setup('b', true);
      await other.store.sync.applyRemote(wire.map(bookmarkFromWire), { clearedBefore: null });
      const [t] = await other.store.children(BOOKMARK_ROOT);
      expect(t!.id).toBe(top.id);
      expect((await other.store.children(top.id)).map((x) => [x.title, x.favorite])).toEqual([['In', false]]);
    });

    it('last writer wins on applyRemote; on a tie the server copy wins (as on the server); favorites survive remote edits', async () => {
      const { store } = await setup();
      const a = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'Local', url: 'https://a.example/', favorite: true });
      const base = (over: Partial<BookmarkRecord>): BookmarkRecord => ({
        id: a.id,
        parentId: null,
        kind: 'bookmark',
        title: 'Remote',
        url: 'https://a.example/',
        position: 0,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        deleted: false,
        ...over,
      });
      await store.sync.applyRemote([base({ updatedAt: a.updatedAt - 5, title: 'Older' })], { clearedBefore: null });
      expect((await store.get(a.id))!.title).toBe('Local');
      await store.sync.applyRemote([base({})], { clearedBefore: null });
      const tie = (await store.get(a.id))!;
      expect([tie.title, tie.favorite]).toEqual(['Remote', true]);
      expect((await store.sync.pending(10)).map((p) => p.id)).not.toContain(a.id);
      await store.sync.applyRemote([base({ updatedAt: a.updatedAt + 10, title: 'Newer' })], { clearedBefore: null });
      const got = (await store.get(a.id))!;
      expect([got.title, got.favorite, got.parentId]).toEqual(['Newer', true, BOOKMARK_ROOT]);
      // A newer remote tombstone deletes; it is not pending locally.
      await store.sync.applyRemote([base({ updatedAt: a.updatedAt + 20, deleted: true, title: '', url: null })], { clearedBefore: null });
      expect(await store.get(a.id)).toBeNull();
      expect((await store.sync.pending(10)).map((p) => p.id)).not.toContain(a.id);
    });

    it('never hands out an item the server would refuse: it stays on this device, the rest keeps syncing', async () => {
      const { store, db, c } = await setup();
      const ok = await store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'OK', url: 'https://ok.example/' });
      const t = c.now();
      const rec = (over: Partial<BookmarkRecord>): BookmarkRecord => ({
        id: 'b0000000-0000-4000-8000-0000000000ff',
        parentId: BOOKMARK_ROOT,
        kind: 'bookmark',
        title: 'Bad',
        url: 'http://a$b.example/',
        position: 5,
        createdAt: t,
        updatedAt: t,
        deleted: false,
        syncPending: t,
        ...over,
      });
      // Left by an older build or another code path: a host the server refuses, a title with a lone surrogate, a
      // time more than a day ahead, a parent that is not a UUID, and a tombstone whose id is not a UUID.
      await db.putMany('bookmarks', [
        rec({}),
        rec({ id: 'b0000000-0000-4000-8000-0000000000fe', url: 'https://fine.example/', title: 'broken \ud800' }),
        rec({ id: 'b0000000-0000-4000-8000-0000000000fd', url: 'https://fine.example/', updatedAt: t + 2 * 86_400_000 }),
        rec({ id: 'b0000000-0000-4000-8000-0000000000fc', url: 'https://fine.example/', parentId: 'not-a-folder-id' }),
        rec({ id: 'legacy-tombstone', deleted: true, title: '', url: null }),
      ]);
      const out = await store.sync.pending(10);
      expect(out.map((r) => r.id)).toEqual([ok.id]);
      expect((await db.get('bookmarks', 'b0000000-0000-4000-8000-0000000000ff'))!.syncPending).toBeUndefined();
      expect((await store.get('b0000000-0000-4000-8000-0000000000ff'))!.title).toBe('Bad'); // still listed locally
      expect(await db.get('bookmarks', 'legacy-tombstone')).toBeUndefined();
      expect(await store.sync.pending(10)).toHaveLength(1);
    });

    it('moves orphans whose folder was deleted elsewhere to the root', async () => {
      const { store } = await setup();
      const f = await store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'F', url: null });
      const child = await store.add({ parentId: f.id, kind: 'bookmark', title: 'C', url: 'https://c.example/' });
      await store.sync.applyRemote(
        [{ id: f.id, parentId: null, kind: 'folder', title: '', url: null, position: 0, createdAt: f.createdAt, updatedAt: f.updatedAt + 100, deleted: true }],
        { clearedBefore: null },
      );
      expect((await store.children(BOOKMARK_ROOT)).map((x) => x.id)).toEqual([child.id]);
      expect((await store.sync.pending(10)).some((p) => p.id === child.id && p.parentId === null)).toBe(true);
    });

    /** The server's rules (api/sync/bookmarks.rs): last writer wins on updated_at, a tie or a loser re-announces the stored copy. */
    function lwwServer(): RecordSyncTransport {
      const server = new Map<string, BookmarkRecord & { syncedAt: number }>();
      let clockTick = 0;
      return {
        async pull(_kind, since) {
          const items = [...server.values()].filter((r) => since === null || r.syncedAt > since).sort((x, y) => x.syncedAt - y.syncedAt);
          return { items: items.map(({ syncedAt: _s, ...r }) => bookmarkFromWire(bookmarkToWire(r))), nextCursor: null, serverTime: clockTick, clearedBefore: null };
        },
        async push(_kind, items) {
          clockTick++;
          for (const raw of items as BookmarkRecord[]) {
            const w = bookmarkFromWire(bookmarkToWire(raw));
            const cur = server.get(w.id);
            if (cur && cur.updatedAt >= w.updatedAt) {
              cur.syncedAt = clockTick;
              continue;
            }
            server.set(w.id, { ...w, syncedAt: clockTick });
          }
        },
      };
    }
    const cursorsFor = (): RecordCursorStore => {
      const m = new Map<string, number | null>();
      return { get: async (k: RecordKind, u) => m.get(`${k}${u}`) ?? null, set: async (k, u, s) => void m.set(`${k}${u}`, s) };
    };

    it('two devices that edit an item with the same stamp converge on the copy the server kept', async () => {
      const transport = lwwServer();
      const d1 = await setup('1');
      const d2 = await setup('2', true);
      const c1 = cursorsFor();
      const c2 = cursorsFor();
      const run = (d: typeof d1, cursors: RecordCursorStore) => syncRecordsOnce(d.store.sync, { userId: 1, transport, cursors });
      const x = await d1.store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'X', url: 'https://x.example/' });
      await run(d1, c1);
      await run(d2, c2);
      // Both edit it at the same millisecond (or both stamp updatedAt + 1 of a copy from a clock that ran ahead).
      d1.c.advance(1000);
      d2.c.set(d1.c.now());
      await d1.store.update(x.id, { title: 'Edit on 1' });
      await d2.store.update(x.id, { title: 'Edit on 2' });
      expect((await d1.store.get(x.id))!.updatedAt).toBe((await d2.store.get(x.id))!.updatedAt);
      await run(d1, c1); // the server keeps "Edit on 1"
      await run(d2, c2); // d2's tie loses; the stored copy is re-announced
      await run(d1, c1);
      await run(d2, c2);
      expect((await d1.store.get(x.id))!.title).toBe('Edit on 1');
      expect((await d2.store.get(x.id))!.title).toBe('Edit on 1');
      expect(await d2.store.sync.pending(10)).toEqual([]);
    });

    it('two devices converge through a server that applies last-writer-wins (syncRecordsOnce)', async () => {
      const transport = lwwServer();
      const d1 = await setup('1');
      const d2 = await setup('2', true);
      const c1 = cursorsFor();
      const c2 = cursorsFor();
      const run = (d: typeof d1, cursors: RecordCursorStore) => syncRecordsOnce(d.store.sync, { userId: 1, transport, cursors });
      const f = await d1.store.add({ parentId: BOOKMARK_ROOT, kind: 'folder', title: 'Shared', url: null });
      const x = await d1.store.add({ parentId: f.id, kind: 'bookmark', title: 'X', url: 'https://x.example/' });
      await run(d1, c1);
      await run(d2, c2);
      expect((await d2.store.children(f.id)).map((b) => b.title)).toEqual(['X']);
      d2.c.advance(1000);
      await d2.store.update(x.id, { title: 'X renamed on 2' });
      d1.c.advance(500);
      await d1.store.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'Y', url: 'https://y.example/' });
      await run(d2, c2);
      await run(d1, c1);
      await run(d2, c2);
      const tree = async (d: typeof d1) => (await d.store.all()).map((b) => `${b.parentId === BOOKMARK_ROOT ? 'root' : 'f'}:${b.title}`).sort();
      expect(await tree(d1)).toEqual(['f:X renamed on 2', 'root:Shared', 'root:Y']);
      expect(await tree(d2)).toEqual(await tree(d1));
      expect(await d1.store.sync.pending(10)).toEqual([]);
      expect(await d2.store.sync.pending(10)).toEqual([]);
      // Deletion propagates.
      d1.c.advance(5000);
      await d1.store.remove(f.id);
      await run(d1, c1);
      await run(d2, c2);
      expect(await tree(d2)).toEqual(['root:Y']);
    });
  });
});
