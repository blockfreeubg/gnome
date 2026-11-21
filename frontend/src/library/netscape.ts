/**
 * Netscape bookmark files (`<!DOCTYPE NETSCAPE-Bookmark-file-1>`), the HTML format every browser imports and exports
 * (Chrome, Edge, Firefox, Safari). The parser is a small tolerant tokenizer rather than DOMParser, so it runs the
 * same in a page, a worker and the unit tests, and never builds a live DOM from an untrusted file: it reads folders
 * (`<DT><H3>`), links (`<DT><A HREF>`) and their dates, and ignores everything else (descriptions `<DD>`,
 * separators `<HR>`, icons, comments, scripts). URLs are kept as written; the store decides what it accepts
 * (http(s) only).
 *
 * The file is untrusted, so the tokenizer runs in linear time whatever it holds (every search moves forward and a
 * search that found nothing is not repeated: unclosed comments, scripts, tags or links cannot make it quadratic), keeps
 * at most MAX_IMPORT_DEPTH folder levels (deeper folders give their contents to the deepest one kept) and reads at
 * most MAX_IMPORT_ENTRIES entries. Indices are computed on a lower-case copy that has the same length as the file
 * (`String.prototype.toLowerCase` alone turns `İ` into two code units).
 */
import type { Bookmark } from '../shared/browser-data';
import { BOOKMARK_ROOT } from '../shared/browser-data';
import type { BookmarkTreeNode } from './bookmarks';

export interface ParsedBookmarks {
  /** Top-level nodes (the file's outer `<DL>`). */
  nodes: BookmarkTreeNode[];
  /** `<TITLE>` / `<H1>` of the file, if any. */
  title: string | null;
  /** Entries (bookmarks and folders) after the first MAX_IMPORT_ENTRIES, which were not read. */
  truncated: number;
}

/** Files larger than this are refused before parsing. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
/**
 * Folder levels kept from a file (bookmarks.ts allows 64 below the bookmarks bar, and an import adds its own folder
 * plus the target's depth); a folder nested deeper gives its bookmarks to the deepest folder kept.
 */
export const MAX_IMPORT_DEPTH = 48;
/** Entries read from one file: far more than the store's 20 000 bookmarks, so the import's own limit decides. */
export const MAX_IMPORT_ENTRIES = 100_000;
/**
 * Source characters read for one name (a folder heading, a link's text, the file's title). Stored titles are at most
 * 512 characters; without the cut, one label of megabytes of `&amp;` made the decoder build hundreds of MB.
 */
export const MAX_LABEL_SOURCE = 16_384;

export class BookmarkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookmarkFileError';
  }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);?/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x') || lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    return NAMED[lower] ?? m;
  });
}

function parseAttributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1]!.toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** ADD_DATE values: seconds (Chrome, Firefox), sometimes milliseconds or microseconds. */
export function parseDate(v: string | undefined): number | undefined {
  if (!v || !/^\d{1,20}$/.test(v)) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n > 1e14) return Math.floor(n / 1000);
  if (n > 1e11) return Math.floor(n);
  return Math.floor(n * 1000);
}

/**
 * `s` lower-cased with the same length, so indices match: U+0130 (İ) is the only code point whose lower case is longer
 * (two code units), so it becomes `I` first. (A replace callback per A–Z run needed hundreds of MB for 4 million
 * tags; the native lower-casing needs one copy.)
 */
function lowerSameLength(s: string): string {
  return s.replace(/\u0130/g, 'I').toLowerCase();
}

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isAsciiLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Removes tags (an unclosed one runs to the end) in one pass. */
function stripTags(s: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, lt));
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    i = gt + 1;
  }
  return parts.join('');
}

const text = (s: string): string => decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

export function parseNetscapeBookmarks(html: string): ParsedBookmarks {
  if (html.length > MAX_IMPORT_BYTES) throw new BookmarkFileError('The file is larger than 16 MB.');
  const src = html;
  const lower = lowerSameLength(html);
  const n = src.length;
  const root: BookmarkTreeNode[] = [];
  /**
   * The lists a `</DL>` returns to: one frame per folder kept (so at most MAX_IMPORT_DEPTH + 1), each counting the
   * `<DL>`s opened inside it without a folder heading. A frame per `<DL>` would let a file of nested `<DL>`s
   * allocate millions of frames (600 MB for 16 MB of `<DL>`).
   */
  const stack: Array<{ list: BookmarkTreeNode[]; depth: number }> = [];
  /** `<DL>`s open in the current list that did not start a folder. */
  let plain = 0;
  const plainStack: number[] = [];
  let pendingFolder: BookmarkTreeNode | null = null;
  let current: BookmarkTreeNode[] | null = null;
  /** Folder levels above `current` (0: the file's outer list). */
  let depth = 0;
  let title: string | null = null;
  let entries = 0;
  let truncated = 0;
  let sawList = false;
  let sawEntry = false;

  // The next '>' at or after a position. Positions only grow, so a '>' found earlier is reused while it is still
  // ahead, and once none is left no later search runs.
  let gtAt = -1;
  let gtNone = false;
  const nextGt = (from: number): number => {
    if (gtNone) return -1;
    if (gtAt >= from) return gtAt;
    gtAt = src.indexOf('>', from);
    if (gtAt < 0) gtNone = true;
    return gtAt;
  };
  // The next `</name` (followed by a delimiter) at or after a position, with the same reuse per tag name.
  const closes = new Map<string, number>();
  const nextClose = (name: string, from: number): number => {
    const known = closes.get(name);
    if (known !== undefined && (known < 0 || known >= from)) return known;
    const needle = `</${name}`;
    let k = from;
    for (;;) {
      k = lower.indexOf(needle, k);
      if (k < 0) break;
      const d = lower.charCodeAt(k + needle.length);
      if (Number.isNaN(d) || isSpace(d) || d === 62 /* > */ || d === 47 /* / */) break;
      k += needle.length;
    }
    closes.set(name, k);
    return k;
  };
  const add = (node: BookmarkTreeNode): boolean => {
    if (entries >= MAX_IMPORT_ENTRIES) {
      truncated++;
      return false;
    }
    entries++;
    (current ?? root).push(node);
    return true;
  };

  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      // Comments carry no bookmarks; an unclosed one runs to the end of the file.
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    const closing = src.charCodeAt(j) === 47; /* / */
    if (closing) j++;
    if (!isAsciiLetter(src.charCodeAt(j))) {
      i = lt + 1;
      continue;
    }
    const nameStart = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isSpace(c) || c === 47 || c === 62) break;
      j++;
    }
    const name = lower.slice(nameStart, j);
    const gt = nextGt(j);
    if (gt < 0) break; // no tag can end after this point
    i = gt + 1;

    if (!closing && (name === 'script' || name === 'style')) {
      // Scripts and styles carry no bookmarks; an unclosed one runs to the end of the file.
      const close = nextClose(name, i);
      if (close < 0) break;
      const end = nextGt(close + name.length + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (name === 'title' && !closing) {
      const end = nextClose('title', i);
      if (end > 0 && title === null) title = text(src.slice(i, Math.min(end, i + MAX_LABEL_SOURCE))) || null;
      continue;
    }
    if (name === 'h1' && !closing) {
      const end = nextClose('h1', i);
      if (end > 0 && title === null) title = text(src.slice(i, Math.min(end, i + MAX_LABEL_SOURCE))) || null;
      continue;
    }
    if (name === 'dl') {
      sawList = true;
      if (!closing) {
        if (current === null) current = root;
        else if (pendingFolder) {
          stack.push({ list: current, depth });
          plainStack.push(plain);
          plain = 0;
          current = pendingFolder.children ??= [];
          depth++;
        } else {
          // A <DL> without a folder heading (or under a folder that was not kept) keeps adding to the enclosing list.
          plain++;
        }
        pendingFolder = null;
      } else if (plain > 0) {
        plain--;
        pendingFolder = null;
      } else if (stack.length) {
        const top = stack.pop()!;
        current = top.list;
        depth = top.depth;
        plain = plainStack.pop() ?? 0;
        pendingFolder = null;
      } else {
        current = root;
        depth = 0;
      }
      continue;
    }
    if (closing) continue;
    if (name === 'h3') {
      sawEntry = true;
      const end = nextClose('h3', i);
      const label = end > 0 ? text(src.slice(i, Math.min(end, i + MAX_LABEL_SOURCE))) : '';
      const attrs = parseAttributes(src.slice(j, gt));
      pendingFolder = null;
      if (depth < MAX_IMPORT_DEPTH) {
        const folder: BookmarkTreeNode = { kind: 'folder', title: label, url: null, addedAt: parseDate(attrs.add_date), children: [] };
        if (add(folder)) pendingFolder = folder;
      }
      if (end > 0) i = end;
      continue;
    }
    if (name === 'a') {
      sawEntry = true;
      const attrs = parseAttributes(src.slice(j, gt));
      const end = nextClose('a', i);
      const label = end > 0 ? text(src.slice(i, Math.min(end, i + MAX_LABEL_SOURCE))) : '';
      if (attrs.href !== undefined) {
        add({ kind: 'bookmark', title: label, url: attrs.href.trim(), addedAt: parseDate(attrs.add_date) });
        pendingFolder = null;
      }
      if (end > 0) i = end;
    }
  }
  if (!(sawList && sawEntry) && !/NETSCAPE-Bookmark-file/i.test(html)) {
    throw new BookmarkFileError('This is not a bookmarks file (HTML export from a browser).');
  }
  return { nodes: root, title, truncated };
}

/** Counts of a parsed tree (the import dialog's preview); `webLinks`: bookmarks with an http(s) address. */
export function countTree(nodes: readonly BookmarkTreeNode[]): { bookmarks: number; folders: number; webLinks: number } {
  let bookmarks = 0;
  let folders = 0;
  let webLinks = 0;
  const todo: Array<readonly BookmarkTreeNode[]> = [nodes];
  for (let list = todo.pop(); list; list = todo.pop()) {
    for (const node of list) {
      if (node.kind === 'folder') {
        folders++;
        if (node.children?.length) todo.push(node.children);
      } else {
        bookmarks++;
        if (/^https?:\/\//i.test(node.url ?? '')) webLinks++;
      }
    }
  }
  return { bookmarks, folders, webLinks };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serializes live bookmarks as a Netscape file. GNOME's bookmarks bar is the root's children, so they are written
 * inside a "Bookmarks bar" folder marked `PERSONAL_TOOLBAR_FOLDER` (Chrome and Firefox put it in their bar).
 */
export function exportNetscapeBookmarks(items: readonly Bookmark[], opts: { now?: number } = {}): string {
  const children = new Map<string, Bookmark[]>();
  for (const b of items) {
    const list = children.get(b.parentId) ?? [];
    list.push(b);
    children.set(b.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const sec = (ms: number): number => Math.floor(ms / 1000);
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number): void => {
    const pad = '    '.repeat(depth);
    for (const b of children.get(parentId) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      if (b.kind === 'folder') {
        lines.push(`${pad}<DT><H3 ADD_DATE="${sec(b.createdAt)}" LAST_MODIFIED="${sec(b.updatedAt)}">${escapeHtml(b.title)}</H3>`);
        lines.push(`${pad}<DL><p>`);
        walk(b.id, depth + 1);
        lines.push(`${pad}</DL><p>`);
      } else if (b.url) {
        lines.push(`${pad}<DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${sec(b.createdAt)}" LAST_MODIFIED="${sec(b.updatedAt)}">${escapeHtml(b.title)}</A>`);
      }
    }
  };
  const t = sec(opts.now ?? Date.now());
  lines.push(`    <DT><H3 ADD_DATE="${t}" LAST_MODIFIED="${t}" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>`);
  lines.push('    <DL><p>');
  walk(BOOKMARK_ROOT, 2);
  lines.push('    </DL><p>');
  lines.push('</DL><p>');
  return lines.join('\n') + '\n';
}
