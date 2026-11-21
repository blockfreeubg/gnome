import { describe, expect, it } from 'vitest';
import { BOOKMARK_ROOT, type Bookmark } from '../../shared/browser-data';
import { childCounts, countIn, descendantFolders, downloadMatches, errorText, downloadSize, fileKind, folderChain, folderTree, groupByDay, rangeStart, shortUrl, word } from './view';

const bm = (id: string, parentId: string, kind: 'bookmark' | 'folder', title: string, position: number): Bookmark => ({
  id,
  parentId,
  kind,
  title,
  url: kind === 'folder' ? null : `https://${id}.example/`,
  position,
  favorite: false,
  createdAt: 0,
  updatedAt: 0,
});

describe('library page helpers', () => {
  it('groups newest-first items by local day', () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    const t = (d: number, h: number) => new Date(2026, 10, d, h).getTime();
    const g = groupByDay([t(12, 14), t(12, 9), t(11, 23), t(9, 8)], (x) => x, now);
    expect(g.map((x) => [x.label, x.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [expect.stringContaining('9'), 1],
    ]);
  });

  it('builds the folder tree depth-first in position order and the chain to a folder', () => {
    const items = [
      bm('b', BOOKMARK_ROOT, 'folder', 'B', 1),
      bm('a', BOOKMARK_ROOT, 'folder', 'A', 0),
      bm('a1', 'a', 'folder', 'A1', 0),
      bm('x', 'a1', 'bookmark', 'X', 0),
      bm('loop1', 'loop2', 'folder', 'L1', 0),
      bm('loop2', 'loop1', 'folder', 'L2', 0),
    ];
    expect(folderTree(items).map((f) => `${f.depth}:${f.title}`)).toEqual(['0:Bookmarks bar', '1:A', '2:A1', '1:B']);
    expect(folderChain(items, 'a1').map((f) => f.id)).toEqual(['a', 'a1']);
    expect(folderChain(items, 'loop1').length).toBeLessThanOrEqual(2);
    expect([...descendantFolders(items, 'a')].sort()).toEqual(['a', 'a1']);
    expect([...descendantFolders(items, 'loop1')].sort()).toEqual(['loop1', 'loop2']);
    expect(countIn(items, 'a1')).toBe(1);
    expect(folderChain(new Map(items.map((b) => [b.id, b])), 'a1').map((f) => f.id)).toEqual(['a', 'a1']);
    const counts = childCounts(items);
    expect(items.every((b) => (counts.get(b.id) ?? 0) === countIn(items, b.id))).toBe(true);
    expect(counts.get(BOOKMARK_ROOT)).toBe(countIn(items, BOOKMARK_ROOT));
  });

  it('labels downloads', () => {
    expect(fileKind('raspios.img.xz', null)).toBe('archive');
    expect(fileKind('photo', 'image/jpeg')).toBe('image');
    expect(fileKind('manual.PDF', null)).toBe('document');
    expect(fileKind('blob', 'application/octet-stream')).toBe('file');
    expect(downloadSize({ state: 'in_progress', received: 1_572_864, total: 4_194_304 })).toBe('1.5 MB of 4 MB');
    expect(downloadSize({ state: 'in_progress', received: 0, total: null })).toBe('Starting…');
    expect(downloadSize({ state: 'completed', received: 2048, total: null })).toMatch(/KB/);
    const d = { filename: 'debian-13.iso', url: 'https://cdimage.debian.org/x.iso' } as Parameters<typeof downloadMatches>[0];
    expect(downloadMatches(d, 'DEBIAN cdimage')).toBe(true);
    expect(downloadMatches(d, 'ubuntu')).toBe(false);
  });

  it('words storage errors for people and passes other messages through', () => {
    expect(errorText(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))).toMatch(/no room left/);
    expect(errorText(Object.assign(new Error('x'), { name: 'StorageUnavailableError' }))).toMatch(/does not let GNOME store data/);
    expect(errorText(new Error('This bookmark no longer exists.'))).toBe('This bookmark no longer exists.');
    expect(errorText('plain')).toBe('plain');
  });

  it('shortens URLs, computes range starts and picks nouns', () => {
    expect(shortUrl('https://www.example.com/')).toBe('example.com');
    expect(shortUrl('https://example.com/a?b=1')).toBe('example.com/a?b=1');
    const now = new Date(2026, 10, 12, 15, 30).getTime();
    expect(rangeStart('hour', now)).toBe(now - 3600_000);
    expect(rangeStart('today', now)).toBe(new Date(2026, 10, 12).getTime());
    expect(rangeStart('all', now)).toBeNull();
    expect(word(1, 'visit')).toBe('visit');
    expect(word(2, 'match', 'matches')).toBe('matches');
  });
});
