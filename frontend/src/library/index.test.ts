import { afterEach, describe, expect, it } from 'vitest';
import { listClearers, runClearers } from '../settings/clearers';
import { settings } from '../settings/store.svelte';
import { getRecordSync } from '../settings/sync';
import { BOOKMARK_ROOT, library } from '../shared/browser-data';
import { initLibrary, localLibrary } from './index';
import { freshIndexedDb } from './testing/dbs';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('initLibrary', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    settings.set('account', 'syncHistory', false);
  });

  it('provides the stores once (idempotent) and unregisters everything on dispose', async () => {
    await freshIndexedDb();
    dispose = initLibrary();
    expect(initLibrary()).toBe(dispose);
    const lib = library();
    expect(lib).not.toBeNull();
    expect(localLibrary()?.history).toBe(lib!.history);
    expect(getRecordSync('bookmarks')).toBe(localLibrary()!.bookmarks.sync);
    expect(listClearers().map((c) => c.id)).toEqual(expect.arrayContaining(['history', 'downloads']));
    dispose();
    dispose = null;
    expect(library()).toBeNull();
    expect(localLibrary()).toBeNull();
    expect(getRecordSync('bookmarks')).toBeUndefined();
    expect(listClearers().map((c) => c.id)).not.toContain('history');
  });

  it('registers the history sync adapter only while account.syncHistory is on', async () => {
    await freshIndexedDb();
    settings.set('account', 'syncHistory', false);
    dispose = initLibrary();
    expect(getRecordSync('history')).toBeUndefined();
    settings.set('account', 'syncHistory', true);
    await tick();
    expect(getRecordSync('history')).toBe(localLibrary()!.history.sync);
    settings.set('account', 'syncHistory', false);
    await tick();
    expect(getRecordSync('history')).toBeUndefined();
  });

  it('the history and downloads clearers remove from the stores (time range included)', async () => {
    await freshIndexedDb();
    dispose = initLibrary();
    const lib = localLibrary()!;
    const now = Date.now();
    await lib.history.recordVisit({ url: 'https://old.example/', title: null, at: now - 3 * 3600_000 });
    await lib.history.recordVisit({ url: 'https://new.example/', title: null, at: now - 60_000 });
    await lib.bookmarks.add({ parentId: BOOKMARK_ROOT, kind: 'bookmark', title: 'Kept', url: 'https://kept.example/' });
    const res = await runClearers(['history'], { since: now - 3600_000 });
    expect(res).toEqual([{ id: 'history', ok: true }]);
    expect((await lib.history.query({ limit: 10 })).map((v) => v.url)).toEqual(['https://old.example/']);
    await runClearers(['history']);
    expect(await lib.history.count()).toBe(0);
    expect(await lib.bookmarks.children(BOOKMARK_ROOT)).toHaveLength(1);
  });
});
