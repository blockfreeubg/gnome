import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKMARK_ROOT, type Bookmark } from '../shared/browser-data';
import { createBookmarkStore } from './bookmarks';
import { createChangeHub } from './changes';
import {
  countTree,
  decodeEntities,
  exportNetscapeBookmarks,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_ENTRIES,
  MAX_LABEL_SOURCE,
  parseDate,
  parseNetscapeBookmarks,
  BookmarkFileError,
} from './netscape';
import { clock, uuids } from './testing/dbs';
import { createMemoryDb } from './testing/memory-db';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

type Node = ReturnType<typeof parseNetscapeBookmarks>['nodes'][number];
const shape = (nodes: readonly Node[]): unknown[] => nodes.map((n) => (n.kind === 'folder' ? { folder: n.title, children: shape(n.children ?? []) } : `${n.title} <${n.url}>`));

describe('Netscape bookmark files', () => {
  it('parses a real Firefox 157 export (BookmarkHTMLUtils, generated through Marionette)', () => {
    const { nodes, title } = parseNetscapeBookmarks(fixture('firefox-157-export.html'));
    expect(title).toBe('Bookmarks');
    expect(shape(nodes)).toEqual([
      'Example & query <https://example.com/?a=1&b=2#frag>',
      {
        folder: 'Bookmarks Toolbar',
        children: [
          'MDN Web Docs <https://developer.mozilla.org/en-US/>',
          {
            folder: 'Rust & Svelte <dev>',
            children: [
              'The Rust Programming Language <https://doc.rust-lang.org/book/>',
              'Svelte • Docs "5" <https://svelte.dev/docs/svelte/overview>',
              { folder: 'Nested', children: ['Gartenzwerg – Wikipedia <https://de.wikipedia.org/wiki/Gartenzwerg>'] },
            ],
          },
          'Bookmarklet <javascript:alert(document.title)>',
        ],
      },
      {
        folder: 'Other Bookmarks',
        children: ['OpenStreetMap <https://www.openstreetmap.org/>', '日本語 title <http://xn--wgv71a.example/%E3%83%91%E3%82%B9>'],
      },
    ]);
    expect(nodes[0]!.addedAt).toBe(1_794_467_062_000);
    expect(countTree(nodes)).toEqual({ bookmarks: 8, folders: 4, webLinks: 7 });
  });

  it('parses a Chromium-format export (bookmark_html_writer layout; written by hand, see the report)', () => {
    const { nodes } = parseNetscapeBookmarks(fixture('chromium-format-export.html'));
    expect(shape(nodes)).toEqual([
      {
        folder: 'Bookmarks bar',
        children: [
          'The Chromium Projects <https://www.chromium.org/Home/>',
          { folder: 'News & reading', children: ['LWN.net <https://lwn.net/>', 'Hacker News <thread> <https://news.ycombinator.com/item?id=1&p=2>'] },
          'Settings <chrome://settings/>',
        ],
      },
      'Raspberry Pi Documentation <https://www.raspberrypi.com/documentation/>',
      { folder: 'Leere Mappe', children: [] },
    ]);
  });

  it('imports a parsed file into the store: only http(s) bookmarks, structure kept', async () => {
    const store = createBookmarkStore({ db: createMemoryDb(), now: clock().now, uuid: uuids(), hub: createChangeHub('bookmarks', { crossTab: false }) });
    const { nodes } = parseNetscapeBookmarks(fixture('firefox-157-export.html'));
    const out = await store.importTree(nodes, BOOKMARK_ROOT, { folderTitle: 'Imported from Firefox' });
    expect(out).toMatchObject({ bookmarks: 7, folders: 5, skipped: 1 });
    const all = await store.all();
    expect(all.find((b) => b.title === 'Bookmarklet')).toBeUndefined();
    const nested = all.find((b) => b.title === 'Nested')!;
    expect((await store.children(nested.id)).map((b) => b.url)).toEqual(['https://de.wikipedia.org/wiki/Gartenzwerg']);
  });

  it('round-trips an export through the parser', () => {
    const t = 1_762_900_000_000;
    const b = (id: string, parentId: string, kind: 'bookmark' | 'folder', title: string, url: string | null, position: number): Bookmark => ({
      id,
      parentId,
      kind,
      title,
      url,
      position,
      favorite: false,
      createdAt: t,
      updatedAt: t + 1000,
    });
    const items = [
      b('f', BOOKMARK_ROOT, 'folder', 'Docs & <guides>', null, 1),
      b('a', BOOKMARK_ROOT, 'bookmark', 'Alpha "quoted"', 'https://a.example/?x=1&y=2', 0),
      b('c', 'f', 'bookmark', 'Child', 'https://c.example/', 0),
    ];
    const html = exportNetscapeBookmarks(items, { now: t });
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true);
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true"');
    expect(html).toContain('HREF="https://a.example/?x=1&amp;y=2"');
    const parsed = parseNetscapeBookmarks(html);
    expect(shape(parsed.nodes)).toEqual([
      { folder: 'Bookmarks bar', children: ['Alpha "quoted" <https://a.example/?x=1&y=2>', { folder: 'Docs & <guides>', children: ['Child <https://c.example/>'] }] },
    ]);
    expect(parsed.nodes[0]!.children![0]!.addedAt).toBe(t);
  });

  it('ignores comments and scripts, and refuses files that are not bookmark files', () => {
    const { nodes } = parseNetscapeBookmarks(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><!-- <DT><A HREF="https://hidden.example/">x</A> --><script>"<A HREF=\'https://s.example/\'>"</script><DT><A HREF=https://ok.example/>OK</A></DL>',
    );
    expect(shape(nodes)).toEqual(['OK <https://ok.example/>']);
    expect(() => parseNetscapeBookmarks('{"roots": {}}')).toThrow(BookmarkFileError);
  });

  it('keeps indices right when lower-casing changes the length (Turkish İ)', () => {
    // 'İ'.toLowerCase() is two code units: an index into a fully lower-cased copy points past the right place.
    const { nodes } = parseNetscapeBookmarks(
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://tr.wikipedia.org/wiki/%C4%B0stanbul">İstanbul İzmir İİİİ – Vikipedi</A>' +
        '<DT><H3>Haberler</H3><DL><p><DT><A HREF="https://www.example.com.tr/">Örnek</A><DT><A HREF="https://two.example/">Two</A></DL><p>' +
        '<DT><A HREF="https://three.example/">Three</A></DL>',
    );
    expect(shape(nodes)).toEqual([
      'İstanbul İzmir İİİİ – Vikipedi <https://tr.wikipedia.org/wiki/%C4%B0stanbul>',
      { folder: 'Haberler', children: ['Örnek <https://www.example.com.tr/>', 'Two <https://two.example/>'] },
      'Three <https://three.example/>',
    ]);
  });

  it('parses hostile files in linear time (unclosed comments, scripts, tags and links)', () => {
    const head = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://a.example/">A</A>';
    const MB = 1 << 20;
    const fill = (unit: string): string => unit.repeat(Math.floor(MB / unit.length));
    // Each of these took the old regex tokenizer O(n²): minutes to hours at 1 MB, days at the 16 MB limit.
    const files = {
      comments: head + fill('<!--'),
      scripts: head + fill('<script>'),
      'tags without >': head + fill('<a'),
      'links without </a>': '<DL>' + fill('<DT><A HREF="https://a/">a'),
      'headings without </h1>': head + fill('<h1>'),
      'titles without </title>': head + fill('<title>'),
      'labels full of <': head + '<DT><A HREF="https://b.example/">' + fill('<b') + '</A>',
    };
    for (const [name, html] of Object.entries(files)) {
      const t0 = performance.now();
      const parsed = parseNetscapeBookmarks(html);
      countTree(parsed.nodes);
      const ms = performance.now() - t0;
      expect(ms, `${name}: ${Math.round(ms)} ms`).toBeLessThan(2500);
      expect(parsed.nodes.length, name).toBeGreaterThan(0);
    }
  });

  it('keeps at most MAX_IMPORT_DEPTH folder levels; deeper bookmarks go to the deepest folder kept', () => {
    const levels = 20_000;
    const html = '<DL><p>' + '<DT><H3>f</H3><DL><p>'.repeat(levels) + '<DT><A HREF="https://deep.example/">Deep</A>' + '</DL><p>'.repeat(levels) + '<DT><A HREF="https://top.example/">Top</A></DL>';
    const { nodes } = parseNetscapeBookmarks(html);
    expect(countTree(nodes)).toEqual({ bookmarks: 2, folders: MAX_IMPORT_DEPTH, webLinks: 2 });
    let level = nodes;
    let depth = 0;
    while (level[0]?.kind === 'folder') {
      level = level[0].children ?? [];
      depth++;
    }
    expect(depth).toBe(MAX_IMPORT_DEPTH);
    expect(level.map((x) => x.url)).toEqual(['https://deep.example/']);
    expect(nodes.at(-1)?.url).toBe('https://top.example/');
  });

  it('nests lists without a folder heading in the enclosing folder, however many there are', () => {
    const plain = 200_000;
    const html =
      '<DL><p><DT><H3>F</H3><DL><p>' +
      '<DL>'.repeat(plain) +
      '<DT><A HREF="https://inner.example/">Inner</A>' +
      '</DL>'.repeat(plain) +
      '<DT><A HREF="https://in-f.example/">Still in F</A></DL><p>' +
      '<DT><A HREF="https://top.example/">Top</A></DL>';
    expect(shape(parseNetscapeBookmarks(html).nodes)).toEqual([
      { folder: 'F', children: ['Inner <https://inner.example/>', 'Still in F <https://in-f.example/>'] },
      'Top <https://top.example/>',
    ]);
  });

  it('reads at most MAX_LABEL_SOURCE characters of one name (a label of megabytes stays cheap)', () => {
    const html = '<DL><p><DT><A HREF="https://x.example/">' + '&amp;'.repeat(3_000_000) + '</A><DT><A HREF="https://y.example/">Y</A></DL>';
    const t0 = performance.now();
    const { nodes } = parseNetscapeBookmarks(html);
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(nodes.map((n) => n.url)).toEqual(['https://x.example/', 'https://y.example/']);
    expect(nodes[0]!.title.length).toBeLessThanOrEqual(MAX_LABEL_SOURCE);
    expect(nodes[0]!.title.startsWith('&&&')).toBe(true);
  });

  it(`reads at most MAX_IMPORT_ENTRIES entries and counts the rest`, () => {
    const html = '<DL><p>' + '<DT><A HREF="https://x.example/">x</A>'.repeat(MAX_IMPORT_ENTRIES + 7) + '</DL>';
    const parsed = parseNetscapeBookmarks(html);
    expect(parsed.nodes).toHaveLength(MAX_IMPORT_ENTRIES);
    expect(parsed.truncated).toBe(7);
  });

  it('decodes entities and dates', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600; &bogus; &#0;')).toBe('a & b <c> "d" \'e\' 😀 &bogus; &#0;');
    expect(parseDate('1762900000')).toBe(1_762_900_000_000);
    expect(parseDate('1762900000123')).toBe(1_762_900_000_123);
    expect(parseDate('1762900000123456')).toBe(1_762_900_000_123);
    expect(parseDate('-1')).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });
});
