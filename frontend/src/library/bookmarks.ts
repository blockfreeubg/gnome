/**
 * Bookmark store (BookmarkStore in src/shared/browser-data.ts) on the `bookmarks` object store.
 *
 * - Top-level items are stored under BOOKMARK_ROOT (IndexedDB cannot index null); the sync adapter maps it to the
 *   wire's `parent_id: null` in pending() and back in applyRemote().
 * - Positions are numbers ordered within a folder; callers pass a `position` as the **index** among the folder's
 *   live items (0 = first), and the store picks a number between the neighbours, so a move rewrites one record (all
 *   siblings only when the gap gets too small).
 * - Every edit is stamped `max(now, updatedAt + 1)` (last writer wins on `updatedAt`, API.md "Bookmarks") and marked
 *   `syncPending` until the server acknowledged it. Deletions are tombstones until then (a folder with everything
 *   in it); acknowledged tombstones are purged, unacknowledged ones after the server's 180 days.
 * - `favorite` is device-local: setFavorite() neither stamps nor marks the record, the sync adapter never sends it
 *   (bookmarkToWire has no such field) and applyRemote() keeps the local value.
 */
import type { BookmarkRecord } from '../lib/idb';
import type { RecordSyncAdapter } from '../settings/sync';
import { BOOKMARK_ROOT, type Bookmark, type BookmarkStore, type Suggestion } from '../shared/browser-data';
import { createChangeHub, type ChangeHub } from './changes';
import type { LibraryDb } from './db';
import { BOOKMARK_FRECENCY, DAY_MS, matchesText, matchQuality, storableTitle, storableUrl, suggestionScore } from './match';
import { bookmarkUploadable } from './wire';

/** The sync server's cap on live bookmarks and folders per account (API.md); the local store keeps the same cap. */
export const MAX_BOOKMARKS = 20_000;
/** Folder depth limit (cycle and runaway-nesting guard). */
export const MAX_DEPTH = 64;
/** The server keeps tombstones this long; unacknowledged local ones go after the same time. */
export const TOMBSTONE_KEEP_MS = 180 * DAY_MS;
const MIN_GAP = 1e-6;

export class BookmarkError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'invalid-url' | 'invalid-parent' | 'cycle' | 'limit' | 'invalid',
  ) {
    super(message);
    this.name = 'BookmarkError';
  }
}

/** A node of an imported tree (netscape.ts produces these). */
export interface BookmarkTreeNode {
  kind: 'bookmark' | 'folder';
  title: string;
  url: string | null;
  addedAt?: number;
  children?: BookmarkTreeNode[];
}

export interface ImportOutcome {
  bookmarks: number;
  folders: number;
  /** Items whose URL is not http(s) (javascript:, place:, file:, …) or that broke a limit. */
  skipped: number;
  /** The folder the import created (null when it went into an existing folder). */
  folderId: string | null;
}

export interface BookmarkDeps {
  db: LibraryDb;
  now?: () => number;
  uuid?: () => string;
  hub?: ChangeHub;
  /** A change bookmark sync should upload (index.ts: requestRecordSync('bookmarks')). */
  onPending?: () => void;
}

export interface LocalBookmarkStore extends BookmarkStore {
  /** Every live item (the Bookmarks page's tree and export). */
  all(): Promise<Bookmark[]>;
  /** Live bookmarks and folders whose title or URL matches every word, best first. */
  search(text: string, limit: number): Promise<Bookmark[]>;
  /** Removes an item (and a folder's contents) and returns a function that puts them back as they were. */
  removeWithUndo(id: string): Promise<() => Promise<void>>;
  /** Adds an imported tree under `parentId` in one transaction. */
  importTree(nodes: readonly BookmarkTreeNode[], parentId: string, opts?: { folderTitle?: string }): Promise<ImportOutcome>;
  /** Drops unacknowledged tombstones older than TOMBSTONE_KEEP_MS; resolves to how many. */
  purgeTombstones(): Promise<number>;
  readonly sync: RecordSyncAdapter<'bookmarks'>;
  close(): void;
}

export function toBookmark(r: BookmarkRecord): Bookmark {
  return {
    id: r.id,
    parentId: r.parentId ?? BOOKMARK_ROOT,
    kind: r.kind,
    title: r.title,
    url: r.kind === 'folder' ? null : r.url,
    position: r.position,
    favorite: !!r.favorite,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function byPosition(a: BookmarkRecord, b: BookmarkRecord): number {
  return a.position - b.position || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Where an item goes among `siblings` (live, in order, without the item): a position number for index `index`, plus
 * the siblings that must be renumbered when the neighbours are too close.
 */
export function placeAt(siblings: readonly BookmarkRecord[], index: number): { position: number; renumber: Array<{ id: string; position: number }> } {
  const i = Math.max(0, Math.min(siblings.length, Math.floor(Number.isFinite(index) ? index : siblings.length)));
  if (!siblings.length) return { position: 0, renumber: [] };
  const prev = siblings[i - 1];
  const next = siblings[i];
  if (!prev) return { position: next!.position - 1, renumber: [] };
  if (!next) return { position: prev.position + 1, renumber: [] };
  if (next.position - prev.position > MIN_GAP * 2) return { position: (prev.position + next.position) / 2, renumber: [] };
  const renumber: Array<{ id: string; position: number }> = [];
  siblings.forEach((s, k) => {
    const p = k < i ? k : k + 1;
    if (s.position !== p) renumber.push({ id: s.id, position: p });
  });
  return { position: i, renumber };
}

export function createBookmarkStore(deps: BookmarkDeps): LocalBookmarkStore {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const hub = deps.hub ?? createChangeHub('bookmarks');
  let liveCache: BookmarkRecord[] | null = null;
  const offCache = hub.onChange(() => (liveCache = null));

  /** Mutations run one after another (read-modify-write on records). */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  const stamp = (prev: number | undefined): number => Math.max(now(), (prev ?? 0) + 1);

  const changed = (pending: boolean): void => {
    liveCache = null;
    hub.emit();
    if (pending) deps.onPending?.();
  };

  async function live(): Promise<BookmarkRecord[]> {
    if (!liveCache) liveCache = await db.query('bookmarks', { filter: (r) => !r.deleted });
    return liveCache;
  }

  async function liveChildren(parentId: string): Promise<BookmarkRecord[]> {
    const rows = await db.query('bookmarks', { index: 'parentId', range: { only: parentId }, filter: (r) => !r.deleted });
    return rows.sort(byPosition);
  }

  async function getLive(id: string): Promise<BookmarkRecord> {
    const r = await db.get('bookmarks', id);
    if (!r || r.deleted) throw new BookmarkError('This bookmark no longer exists.', 'not-found');
    return r;
  }

  /** The folder chain from `folderId` up to the root (folderId first); throws on a missing parent. */
  async function ancestors(folderId: string): Promise<string[]> {
    const chain: string[] = [];
    let cur = folderId;
    while (cur !== BOOKMARK_ROOT) {
      if (chain.includes(cur) || chain.length > MAX_DEPTH) throw new BookmarkError('Folders are nested too deeply.', 'cycle');
      const f = await db.get('bookmarks', cur);
      if (!f || f.deleted || f.kind !== 'folder') throw new BookmarkError('That folder no longer exists.', 'invalid-parent');
      chain.push(cur);
      cur = f.parentId ?? BOOKMARK_ROOT;
    }
    return chain;
  }

  async function subtree(root: BookmarkRecord): Promise<BookmarkRecord[]> {
    const out: BookmarkRecord[] = [root];
    for (let i = 0; i < out.length && out.length <= MAX_BOOKMARKS + 1; i++) {
      const r = out[i]!;
      if (r.kind !== 'folder') continue;
      out.push(...(await db.query('bookmarks', { index: 'parentId', range: { only: r.id }, filter: (c) => !c.deleted })));
    }
    return out;
  }

  /** Levels of live folders below `root` (0 for a bookmark or an empty folder); stops counting past MAX_DEPTH. */
  async function subtreeHeight(root: BookmarkRecord): Promise<number> {
    if (root.kind !== 'folder') return 0;
    let level = [root.id];
    let height = 0;
    while (level.length && height <= MAX_DEPTH) {
      const next: string[] = [];
      let any = false;
      for (const id of level) {
        const kids = await db.query('bookmarks', { index: 'parentId', range: { only: id }, filter: (c) => !c.deleted });
        if (kids.length) any = true;
        for (const k of kids) if (k.kind === 'folder') next.push(k.id);
      }
      if (!any) break;
      height++;
      level = next;
    }
    return height;
  }

  function checkUrl(url: unknown): string {
    const href = storableUrl(url);
    if (!href) throw new BookmarkError('Enter a valid web address that starts with http:// or https://.', 'invalid-url');
    return href;
  }

  function hostTitle(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url;
    } catch {
      return url;
    }
  }

  async function purgeOld(): Promise<number> {
    const min = now() - TOMBSTONE_KEEP_MS;
    const old = await db.query('bookmarks', { index: 'updatedAt', range: { upper: min, upperOpen: true }, filter: (r) => r.deleted });
    await db.deleteMany(
      'bookmarks',
      old.map((r) => r.id),
    );
    return old.length;
  }

  /**
   * After remote changes: live items whose parent is gone, not a folder, or part of a cycle move to the root
   * (stamped, so the repair syncs too).
   */
  async function repairOrphans(): Promise<number> {
    const rows = await db.query('bookmarks', { filter: (r) => !r.deleted });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const fixes: BookmarkRecord[] = [];
    for (const r of rows) {
      let cur = r.parentId ?? BOOKMARK_ROOT;
      const seen = new Set<string>([r.id]);
      let ok = true;
      while (cur !== BOOKMARK_ROOT) {
        const p = byId.get(cur);
        if (!p || p.kind !== 'folder' || seen.has(cur) || seen.size > MAX_DEPTH) {
          ok = false;
          break;
        }
        seen.add(cur);
        cur = p.parentId ?? BOOKMARK_ROOT;
      }
      if (!ok) {
        const t = stamp(r.updatedAt);
        const fixed = { ...r, parentId: BOOKMARK_ROOT, updatedAt: t, syncPending: t };
        byId.set(r.id, fixed);
        fixes.push(fixed);
      }
    }
    await db.putMany('bookmarks', fixes);
    return fixes.length;
  }

  const store: LocalBookmarkStore = {
    async get(id) {
      const r = await db.get('bookmarks', id);
      return r && !r.deleted ? toBookmark(r) : null;
    },

    async children(parentId) {
      return (await liveChildren(parentId)).map(toBookmark);
    },

    async byUrl(url) {
      const href = storableUrl(url);
      if (!href) return [];
      const rows = await db.query('bookmarks', { index: 'url', range: { only: href }, filter: (r) => !r.deleted && r.kind === 'bookmark' });
      return rows.sort(byPosition).map(toBookmark);
    },

    async favorites(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (!n) return [];
      const rows = (await live()).filter((r) => r.favorite && r.kind === 'bookmark' && !!r.url);
      return [...rows].sort(byPosition).slice(0, n).map(toBookmark);
    },

    add(input) {
      return serial(async () => {
        if (input.kind !== 'bookmark' && input.kind !== 'folder') throw new BookmarkError('Unknown bookmark kind.', 'invalid');
        const parentId = input.parentId || BOOKMARK_ROOT;
        const chain = parentId === BOOKMARK_ROOT ? [] : await ancestors(parentId);
        if (chain.length >= MAX_DEPTH) throw new BookmarkError('Folders are nested too deeply.', 'cycle');
        if ((await live()).length >= MAX_BOOKMARKS) {
          throw new BookmarkError(`You have reached the limit of ${MAX_BOOKMARKS.toLocaleString('en')} bookmarks.`, 'limit');
        }
        const url = input.kind === 'bookmark' ? checkUrl(input.url) : null;
        const title = storableTitle(input.title) ?? (url ? hostTitle(url) : 'New folder');
        const siblings = await liveChildren(parentId);
        const { position, renumber } = placeAt(siblings, input.position ?? siblings.length);
        const t = now();
        const rec: BookmarkRecord = {
          id: uuid(),
          parentId,
          kind: input.kind,
          title: [...title].slice(0, 512).join(''),
          url,
          position,
          createdAt: t,
          updatedAt: t,
          deleted: false,
          favorite: input.kind === 'bookmark' && !!input.favorite,
          syncPending: t,
        };
        await db.putMany('bookmarks', [...renumbered(siblings, renumber), rec]);
        changed(true);
        return toBookmark(rec);
      });
    },

    update(id, patch) {
      return serial(async () => {
        const cur = await getLive(id);
        const next: BookmarkRecord = { ...cur };
        if (patch.title !== undefined) next.title = storableTitle(patch.title) ?? (cur.kind === 'folder' ? 'New folder' : hostTitle(cur.url ?? ''));
        if (patch.url !== undefined && cur.kind === 'bookmark') next.url = checkUrl(patch.url);
        const from = cur.parentId ?? BOOKMARK_ROOT;
        const to = patch.parentId ?? from;
        if (to !== from) {
          const chain = to === BOOKMARK_ROOT ? [] : await ancestors(to);
          if (chain.includes(cur.id) || to === cur.id) throw new BookmarkError('A folder cannot go inside itself.', 'cycle');
          // The same limit as add(): no item may end up with MAX_DEPTH folders above it, the moved folder's deepest
          // descendant included (chain.length folders above `cur`, `height` more levels below it).
          if (chain.length + (await subtreeHeight(cur)) >= MAX_DEPTH) throw new BookmarkError('Folders are nested too deeply.', 'cycle');
          next.parentId = to;
        }
        let extra: BookmarkRecord[] = [];
        if (to !== from || patch.position !== undefined) {
          const siblings = (await liveChildren(to)).filter((s) => s.id !== cur.id);
          const { position, renumber } = placeAt(siblings, patch.position ?? siblings.length);
          next.position = position;
          extra = renumbered(siblings, renumber);
        }
        const same = next.title === cur.title && next.url === cur.url && next.parentId === cur.parentId && next.position === cur.position;
        if (same && !extra.length) return toBookmark(cur);
        const t = stamp(cur.updatedAt);
        next.updatedAt = t;
        next.syncPending = t;
        await db.putMany('bookmarks', [...extra, next]);
        changed(true);
        return toBookmark(next);
      });
    },

    setFavorite(id, favorite) {
      return serial(async () => {
        const cur = await getLive(id);
        if (cur.kind !== 'bookmark' || !!cur.favorite === favorite) return;
        await db.putMany('bookmarks', [{ ...cur, favorite }]);
        changed(false);
      });
    },

    async remove(id) {
      await store.removeWithUndo(id);
    },

    removeWithUndo(id) {
      return serial(async () => {
        const cur = await db.get('bookmarks', id);
        if (!cur || cur.deleted) return async () => {};
        const items = await subtree(cur);
        // Tombstones keep only what sync needs (the wire sends no title or URL for them either): the deleted page's
        // address does not stay on the device for the 180 days an unsynced tombstone is kept. Undo uses `snapshot`.
        const tombs: BookmarkRecord[] = items.map((r) => {
          const t = stamp(r.updatedAt);
          return { ...r, deleted: true, favorite: false, title: '', url: null, updatedAt: t, syncPending: t };
        });
        await db.putMany('bookmarks', tombs);
        changed(true);
        const snapshot = items.map((r) => ({ ...r }));
        return () =>
          serial(async () => {
            const parent = snapshot[0]!.parentId ?? BOOKMARK_ROOT;
            const restoreParent = parent === BOOKMARK_ROOT || (await db.get('bookmarks', parent))?.deleted === false ? parent : BOOKMARK_ROOT;
            const back = await Promise.all(
              snapshot.map(async (r, i) => {
                const latest = await db.get('bookmarks', r.id);
                // Newer than the tombstone even when it was uploaded and purged (a tie would keep the tombstone).
                const t = stamp(Math.max(r.updatedAt, tombs[i]!.updatedAt, latest?.updatedAt ?? 0));
                return { ...r, parentId: i === 0 ? restoreParent : r.parentId, deleted: false, updatedAt: t, syncPending: t };
              }),
            );
            await db.putMany('bookmarks', back);
            changed(true);
          });
      });
    },

    async suggest(text, limit) {
      const q = text.trim();
      const n = Math.max(0, Math.floor(limit));
      if (!q || !n) return [];
      const out: Suggestion[] = [];
      for (const r of await live()) {
        if (r.kind !== 'bookmark' || !r.url) continue;
        const quality = matchQuality(q, r.url, r.title);
        if (quality <= 0) continue;
        out.push({ url: r.url, title: r.title || null, source: 'bookmark', score: suggestionScore(quality, BOOKMARK_FRECENCY) + (r.favorite ? 0.5 : 0) });
      }
      const seen = new Set<string>();
      return out
        .sort((a, b) => b.score - a.score)
        .filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)))
        .slice(0, n);
    },

    onChange(listener) {
      return hub.onChange(listener);
    },

    async all() {
      return [...(await live())].sort(byPosition).map(toBookmark);
    },

    async search(text, limit) {
      const q = text.trim();
      if (!q) return [];
      const rows = (await live()).filter((r) => matchesText(q, r.url, r.title));
      const quality = (r: BookmarkRecord): number => (r.url ? matchQuality(q, r.url, r.title) : matchQuality(q, '', r.title)) || 0.5;
      return rows
        .sort((a, b) => quality(b) - quality(a) || b.updatedAt - a.updatedAt)
        .slice(0, Math.max(0, limit))
        .map(toBookmark);
    },

    importTree(nodes, parentId, opts = {}) {
      return serial(async () => {
        const target = parentId || BOOKMARK_ROOT;
        const depth = target === BOOKMARK_ROOT ? 0 : (await ancestors(target)).length;
        let room = MAX_BOOKMARKS - (await live()).length;
        const t = now();
        const puts: BookmarkRecord[] = [];
        const outcome: ImportOutcome = { bookmarks: 0, folders: 0, skipped: 0, folderId: null };
        /** Nodes in `list` and below (iterative: an imported tree can be deep). */
        const countAll = (list: readonly BookmarkTreeNode[]): number => {
          let total = 0;
          const todo: Array<readonly BookmarkTreeNode[]> = [list];
          for (let l = todo.pop(); l; l = todo.pop()) {
            total += l.length;
            for (const x of l) if (x.children?.length) todo.push(x.children);
          }
          return total;
        };
        let base = target;
        let level = depth;
        let topSiblings = await liveChildren(target);
        if (opts.folderTitle !== undefined) {
          if (room <= 0) throw new BookmarkError(`You have reached the limit of ${MAX_BOOKMARKS.toLocaleString('en')} bookmarks.`, 'limit');
          const { position } = placeAt(topSiblings, topSiblings.length);
          const folder: BookmarkRecord = {
            id: uuid(),
            parentId: target,
            kind: 'folder',
            title: storableTitle(opts.folderTitle) ?? 'Imported',
            url: null,
            position,
            createdAt: t,
            updatedAt: t,
            deleted: false,
            favorite: false,
            syncPending: t,
          };
          puts.push(folder);
          room--;
          outcome.folders++;
          outcome.folderId = folder.id;
          base = folder.id;
          level++;
          topSiblings = [];
        }
        const walk = (list: readonly BookmarkTreeNode[], parent: string, lvl: number, startPos: number): void => {
          let pos = startPos;
          for (const node of list) {
            if (room <= 0 || lvl >= MAX_DEPTH) {
              outcome.skipped += 1 + countAll(node.children ?? []);
              continue;
            }
            const created = typeof node.addedAt === 'number' && Number.isFinite(node.addedAt) && node.addedAt > 0 && node.addedAt <= t ? node.addedAt : t;
            if (node.kind === 'folder') {
              const id = uuid();
              puts.push({
                id,
                parentId: parent,
                kind: 'folder',
                title: storableTitle(node.title) ?? 'Folder',
                url: null,
                position: pos++,
                createdAt: created,
                updatedAt: t,
                deleted: false,
                favorite: false,
                syncPending: t,
              });
              room--;
              outcome.folders++;
              walk(node.children ?? [], id, lvl + 1, 0);
            } else {
              const url = storableUrl(node.url);
              if (!url) {
                outcome.skipped++;
                continue;
              }
              puts.push({
                id: uuid(),
                parentId: parent,
                kind: 'bookmark',
                title: storableTitle(node.title) ?? hostTitle(url),
                url,
                position: pos++,
                createdAt: created,
                updatedAt: t,
                deleted: false,
                favorite: false,
                syncPending: t,
              });
              room--;
              outcome.bookmarks++;
            }
          }
        };
        const start = topSiblings.length ? topSiblings[topSiblings.length - 1]!.position + 1 : 0;
        walk(nodes, base, level, start);
        await db.putMany('bookmarks', puts);
        if (puts.length) changed(true);
        return outcome;
      });
    },

    purgeTombstones() {
      return serial(purgeOld);
    },

    sync: {
      kind: 'bookmarks',
      pending(limit) {
        return serial(async () => {
          // An item the server would refuse would make it refuse the whole batch on every sync: it stays local (a
          // tombstone the server cannot take is dropped).
          for (;;) {
            const rows = (await db.query('bookmarks', { index: 'syncPending', limit: Math.max(1, limit) })).map((r) => ({
              ...r,
              parentId: r.parentId === BOOKMARK_ROOT ? null : r.parentId,
            }));
            const t = now();
            const refused = rows.filter((r) => !bookmarkUploadable(r, t));
            if (!refused.length) return rows;
            console.warn(`[gnome] bookmark sync: ${refused.length} item(s) the server would refuse stay on this device`);
            const local = await Promise.all(refused.map((r) => db.get('bookmarks', r.id)));
            await db.putMany(
              'bookmarks',
              local.filter((r): r is BookmarkRecord => !!r && !r.deleted).map(({ syncPending: _p, ...rest }) => rest),
            );
            await db.deleteMany(
              'bookmarks',
              local.filter((r): r is BookmarkRecord => !!r && r.deleted).map((r) => r.id),
            );
          }
        });
      },
      acknowledge(items) {
        return serial(async () => {
          const puts: BookmarkRecord[] = [];
          const purge: string[] = [];
          for (const item of items) {
            const cur = await db.get('bookmarks', item.id);
            if (!cur || cur.syncPending === undefined || cur.syncPending !== item.syncPending) continue;
            if (cur.deleted) purge.push(cur.id);
            else {
              const { syncPending: _p, ...rest } = cur;
              puts.push(rest);
            }
          }
          await db.putMany('bookmarks', puts);
          await db.deleteMany('bookmarks', purge);
        });
      },
      applyRemote(items) {
        return serial(async () => {
          const puts = new Map<string, BookmarkRecord>();
          const dels: string[] = [];
          for (const item of items) {
            if (!item || typeof item.id !== 'string' || !Number.isFinite(item.updatedAt)) continue;
            const local = puts.get(item.id) ?? (await db.get('bookmarks', item.id));
            // Last writer wins. On a tie the server's copy wins, as on the server ("ties keep the stored copy"): a
            // device whose upload lost a tie gets the stored copy re-announced and must take it to converge.
            if (local && local.updatedAt > item.updatedAt) continue;
            if (item.deleted) {
              if (local) dels.push(item.id);
              puts.delete(item.id);
              continue;
            }
            const kind = item.kind === 'folder' ? 'folder' : 'bookmark';
            const url = kind === 'bookmark' ? storableUrl(item.url) : null;
            if (kind === 'bookmark' && !url) continue;
            const parentId = item.parentId === null || item.parentId === undefined || item.parentId === item.id ? BOOKMARK_ROOT : item.parentId;
            puts.set(item.id, {
              id: item.id,
              parentId,
              kind,
              title: storableTitle(item.title) ?? '',
              url,
              position: Number.isFinite(item.position) ? item.position : 0,
              createdAt: Number.isFinite(item.createdAt) ? item.createdAt : item.updatedAt,
              updatedAt: item.updatedAt,
              deleted: false,
              favorite: !!local?.favorite && !local.deleted,
            });
          }
          await db.putMany('bookmarks', [...puts.values()]);
          await db.deleteMany('bookmarks', dels);
          const repaired = puts.size || dels.length ? await repairOrphans() : 0;
          if (puts.size || dels.length) changed(repaired > 0);
        });
      },
    },

    close() {
      offCache();
      hub.close();
    },
  };

  function renumbered(siblings: readonly BookmarkRecord[], renumber: ReadonlyArray<{ id: string; position: number }>): BookmarkRecord[] {
    if (!renumber.length) return [];
    const byId = new Map(siblings.map((s) => [s.id, s]));
    return renumber.map(({ id, position }) => {
      const s = byId.get(id)!;
      const t = stamp(s.updatedAt);
      return { ...s, position, updatedAt: t, syncPending: t };
    });
  }

  return store;
}
