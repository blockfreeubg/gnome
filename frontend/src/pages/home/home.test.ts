import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kvGet, kvSet, type BookmarkRecord, type HistoryRecord } from '../../lib/idb';
import { DEFAULT_WALLPAPER, wallpaperById } from '../../styles/wallpapers';
import { cssUrl, imageSource, isSafeGradient, resolveBackground } from './background';
import {
  defaultQuickLinks,
  initialQuickLinks,
  loadQuickLinks,
  MAX_QUICK_LINKS,
  matchScore,
  QUICK_LINKS_MIRROR_KEY,
  readQuickLinksMirror,
  saveQuickLinks,
  suggest,
  validateQuickLinks,
  type SuggestionIndex,
} from './data';

vi.mock('../../lib/idb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/idb')>()),
  kvGet: vi.fn(async () => undefined),
  kvSet: vi.fn(async () => undefined),
}));

describe('quick links mirror (first-frame tiles, no layout shift)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(kvGet).mockReset();
    vi.mocked(kvSet).mockReset();
  });

  it('starts from the defaults on a first visit and from the mirror afterwards', async () => {
    expect(initialQuickLinks()).toEqual(defaultQuickLinks());
    const mine = [{ id: 'm1', title: 'Mine', url: 'https://example.org/' }];
    await saveQuickLinks(mine);
    expect(vi.mocked(kvSet)).toHaveBeenCalledWith('home.quickLinks', mine);
    expect(readQuickLinksMirror()).toEqual(mine);
    expect(initialQuickLinks()).toEqual(mine);
  });

  it('keeps the mirror in step with IndexedDB and ignores a damaged one', async () => {
    localStorage.setItem(QUICK_LINKS_MIRROR_KEY, '{oops');
    expect(readQuickLinksMirror()).toBeNull();
    localStorage.setItem(QUICK_LINKS_MIRROR_KEY, JSON.stringify([{ id: 'x', title: 'X', url: 'javascript:alert(1)' }]));
    expect(readQuickLinksMirror()).toEqual([]);
    vi.mocked(kvGet).mockResolvedValueOnce([{ id: 'db', title: 'From DB', url: 'example.net' }]);
    const r = await loadQuickLinks();
    expect(r).toMatchObject({ customized: true, available: true });
    expect(readQuickLinksMirror()).toEqual([{ id: 'db', title: 'From DB', url: 'https://example.net/' }]);
    vi.mocked(kvGet).mockRejectedValueOnce(new Error('IndexedDB blocked'));
    expect((await loadQuickLinks()).links).toEqual([{ id: 'db', title: 'From DB', url: 'https://example.net/' }]);
  });
});

describe('quick links validation', () => {
  it('keeps valid links, normalizes addresses and fills empty titles', () => {
    expect(
      validateQuickLinks([
        { id: 'a', title: ' Wiki ', url: 'wikipedia.org' },
        { id: 'b', title: '', url: 'https://www.example.com/x' },
      ]),
    ).toEqual([
      { id: 'a', title: 'Wiki', url: 'https://wikipedia.org/' },
      { id: 'b', title: 'example.com', url: 'https://www.example.com/x' },
    ]);
  });

  it('drops unsafe, malformed and duplicate entries; caps the count', () => {
    expect(
      validateQuickLinks([
        { id: 'x', title: 'XSS', url: 'javascript:alert(1)' },
        { id: 'y', title: 'Words', url: 'not an address' },
        { id: 1, title: 'bad id', url: 'example.com' },
        null,
        'string',
        { id: 'z', title: 'Z', url: 'example.org' },
        { id: 'z', title: 'Z again', url: 'example.net' },
      ]),
    ).toEqual([{ id: 'z', title: 'Z', url: 'https://example.org/' }]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `id${i}`, title: `T${i}`, url: `site${i}.com` }));
    expect(validateQuickLinks(many)).toHaveLength(MAX_QUICK_LINKS);
    expect(validateQuickLinks({ not: 'an array' })).toBeNull();
    expect(validateQuickLinks(undefined)).toBeNull();
  });

  it('ships valid defaults', () => {
    expect(validateQuickLinks(defaultQuickLinks())).toEqual(defaultQuickLinks());
  });
});

describe('suggestions', () => {
  const now = Date.now();
  const h = (url: string, title: string | null, ago: number): HistoryRecord => ({ id: `${url}${ago}`, url, title, visitedAt: now - ago });
  const b = (id: string, url: string, title: string, favorite = false): BookmarkRecord => ({
    id,
    parentId: null,
    kind: 'bookmark',
    title,
    url,
    position: 0,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    favorite,
  });

  it('scores URL prefixes over title words over substrings', () => {
    expect(matchScore('git', 'Somewhere', 'https://github.com/')).toBe(4);
    expect(matchScore('git', 'GitHub', 'https://example.com/')).toBe(3);
    expect(matchScore('hub', 'Git hub', 'https://example.com/')).toBe(2.5);
    expect(matchScore('hub', 'x', 'https://github.com/')).toBe(1.5);
    expect(matchScore('ithu', 'GitHub', 'https://e.com/')).toBe(1);
    expect(matchScore('zzz', 'GitHub', 'https://github.com/')).toBe(0);
    expect(matchScore('  ', 'GitHub', 'https://github.com/')).toBe(0);
  });

  it('merges bookmarks and history, de-duplicating URLs and ranking frequent visits', () => {
    const index: SuggestionIndex = {
      history: [
        h('https://news.example/a', 'News A', 1000),
        h('https://news.example/b', 'News B', 2000),
        h('https://news.example/b', 'News B', 3000),
        h('https://news.example/b', 'News B', 4000),
        h('https://docs.example/', 'Docs', 5000),
        h('https://nested.example/', 'Bookmarked news', 6000),
      ],
      bookmarks: [b('1', 'https://nested.example/', 'Bookmarked news', true)],
      loadedAt: now,
    };
    const s = suggest(index, 'news', 5);
    expect(s.bookmarks.map((x) => x.url)).toEqual(['https://nested.example/']);
    expect(s.history.map((x) => x.url)).toEqual(['https://news.example/b', 'https://news.example/a']);
    expect(suggest(index, '', 5)).toEqual({ history: [], bookmarks: [] });
  });
});

describe('home background', () => {
  it('accepts plain gradients only', () => {
    expect(isSafeGradient('linear-gradient(135deg, #1a1a16, #2a2a24)')).toBe(true);
    expect(isSafeGradient('radial-gradient(circle at top, #333 0%, #111 70%)')).toBe(true);
    for (const bad of [
      'url(https://evil.example/x.png)',
      'linear-gradient(red, blue), url(x)',
      'linear-gradient(red, blue); position: fixed',
      'linear-gradient(var(--x), red)',
      'expression(alert(1))',
      'red',
    ]) {
      expect(isSafeGradient(bad), bad).toBe(false);
    }
  });

  it('accepts https images and IndexedDB images', () => {
    expect(imageSource('https://images.example/bg.jpg')).toEqual({ kind: 'url', url: 'https://images.example/bg.jpg' });
    expect(imageSource('idb:home.background')).toEqual({ kind: 'idb', key: 'home.background' });
    expect(imageSource('http://images.example/bg.jpg')).toBeNull();
    expect(imageSource('javascript:alert(1)')).toBeNull();
    expect(imageSource('idb:')).toBeNull();
  });

  it('quotes URLs for CSS', () => {
    expect(cssUrl('https://x.example/a.png')).toBe('url("https://x.example/a.png")');
    expect(cssUrl('https://x.example/a"b\\c.png')).toBe('url("https://x.example/a\\22 b\\5c c.png")');
  });

  it('falls back to the default wallpaper for invalid values and clamps dim/blur', () => {
    const grove = wallpaperById(DEFAULT_WALLPAPER);
    expect(resolveBackground({ kind: 'color', value: '#123456', dim: 2, blur: -1 })).toEqual({ kind: 'color', color: '#123456', dim: 0.9, blur: 0 });
    expect(resolveBackground({ kind: 'color', value: 'red', dim: 0.3, blur: 0 }).kind).toBe('wallpaper');
    expect(resolveBackground({ kind: 'gradient', value: 'url(x)', dim: 0.3, blur: 0 }).kind).toBe('wallpaper');
    expect(resolveBackground({ kind: 'image', value: 'ftp://x', dim: 0.3, blur: 50 })).toEqual({ kind: 'wallpaper', wallpaper: grove, dim: 0.3, blur: 40 });
    expect(resolveBackground({ kind: 'none', value: '', dim: 0, blur: 0 }).kind).toBe('none');
    expect(resolveBackground({ kind: 'glow', value: '', dim: 0, blur: 0 }).kind).toBe('glow');
    // Wallpapers by id; an unknown id shows the default one.
    expect(resolveBackground({ kind: 'wallpaper', value: 'grove', dim: 0.35, blur: 0 }).wallpaper).toBe(grove);
    expect(resolveBackground({ kind: 'wallpaper', value: 'no-such-wallpaper', dim: 0.35, blur: 0 }).wallpaper).toBe(grove);
  });
});
