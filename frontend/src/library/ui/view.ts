/**
 * Pure helpers of the History, Bookmarks and Downloads pages (grouping, labels, folder paths), unit-tested in
 * view.test.ts.
 */
import { formatBytes, formatDayLabel } from '../../lib/format';
import { BOOKMARK_ROOT, type Bookmark, type DownloadItem } from '../../shared/browser-data';

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Groups items (newest first) by local calendar day. */
export function groupByDay<T>(items: readonly T[], time: (item: T) => number, now: number = Date.now()): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const item of items) {
    const t = time(item);
    const key = dayKey(t);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(item);
    else out.push({ key, label: formatDayLabel(t, now), items: [item] });
  }
  return out;
}

export function formatClock(t: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(t);
}

/** "example.com/path?q" — what a row shows under the title. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, '');
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return host + (rest.length > 80 ? rest.slice(0, 79) + '…' : rest);
  } catch {
    return url;
  }
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── Time ranges (History → Clear) ────────────────────────────────────────────────────────────────────────────────

export type ClearRange = 'hour' | 'today' | 'week' | 'month' | 'all';

export const CLEAR_RANGES: ReadonlyArray<{ value: ClearRange; label: string }> = [
  { value: 'hour', label: 'Last hour' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 4 weeks' },
  { value: 'all', label: 'All time' },
];

/** The start of a range (null = everything). */
export function rangeStart(range: ClearRange, now: number = Date.now()): number | null {
  switch (range) {
    case 'hour':
      return now - 3600_000;
    case 'today': {
      const d = new Date(now);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }
    case 'week':
      return now - 7 * 86_400_000;
    case 'month':
      return now - 28 * 86_400_000;
    default:
      return null;
  }
}

// ── Bookmarks ────────────────────────────────────────────────────────────────────────────────────────────────────

export const ROOT_LABEL = 'Bookmarks bar';

export interface FolderNode {
  id: string;
  title: string;
  depth: number;
  /** Titles from the root down to this folder. */
  path: string[];
  childFolders: number;
}

/** Folders in tree order (depth-first, position order), the root first. */
export function folderTree(items: readonly Bookmark[]): FolderNode[] {
  const kids = new Map<string, Bookmark[]>();
  for (const b of items) {
    if (b.kind !== 'folder') continue;
    const list = kids.get(b.parentId) ?? [];
    list.push(b);
    kids.set(b.parentId, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  const out: FolderNode[] = [{ id: BOOKMARK_ROOT, title: ROOT_LABEL, depth: 0, path: [], childFolders: kids.get(BOOKMARK_ROOT)?.length ?? 0 }];
  const seen = new Set<string>([BOOKMARK_ROOT]);
  const walk = (parent: string, depth: number, path: string[]): void => {
    for (const f of kids.get(parent) ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const p = [...path, f.title];
      out.push({ id: f.id, title: f.title, depth, path: p, childFolders: kids.get(f.id)?.length ?? 0 });
      walk(f.id, depth + 1, p);
    }
  };
  walk(BOOKMARK_ROOT, 1, []);
  return out;
}

/**
 * The folder ids from the root to `id` (inclusive), for breadcrumbs; [] when the folder is unknown. Pass the page's
 * id map when calling it per row (building one from 20 000 items per call is what made search results slow).
 */
export function folderChain(items: readonly Bookmark[] | ReadonlyMap<string, Bookmark>, id: string): Bookmark[] {
  const byId: ReadonlyMap<string, Bookmark> = isList(items) ? new Map(items.map((b) => [b.id, b])) : items;
  const out: Bookmark[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId === BOOKMARK_ROOT ? undefined : byId.get(cur.parentId);
  }
  return out;
}

function isList(v: readonly Bookmark[] | ReadonlyMap<string, Bookmark>): v is readonly Bookmark[] {
  return Array.isArray(v);
}

/** Ids of `folderId` and every folder inside it (a folder cannot be moved into these); one pass over the items. */
export function descendantFolders(items: readonly Bookmark[], folderId: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const b of items) {
    if (b.kind !== 'folder') continue;
    const list = kids.get(b.parentId);
    if (list) list.push(b.id);
    else kids.set(b.parentId, [b.id]);
  }
  const out = new Set<string>([folderId]);
  const todo = [folderId];
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    for (const k of kids.get(id) ?? []) {
      if (out.has(k)) continue;
      out.add(k);
      todo.push(k);
    }
  }
  return out;
}

export function countIn(items: readonly Bookmark[], folderId: string): number {
  let n = 0;
  for (const b of items) if (b.parentId === folderId) n++;
  return n;
}

/** Live items per parent id (the tree's and the folder rows' counts, in one pass instead of one per folder). */
export function childCounts(items: readonly Bookmark[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of items) out.set(b.parentId, (out.get(b.parentId) ?? 0) + 1);
  return out;
}

// ── Downloads ────────────────────────────────────────────────────────────────────────────────────────────────────

export type FileKind = 'archive' | 'image' | 'video' | 'audio' | 'document' | 'code' | 'file';

const EXT: Record<string, FileKind> = {
  zip: 'archive', gz: 'archive', tgz: 'archive', xz: 'archive', bz2: 'archive', '7z': 'archive', rar: 'archive', tar: 'archive', zst: 'archive', iso: 'archive', dmg: 'archive', deb: 'archive', rpm: 'archive', apk: 'archive', img: 'archive',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', heic: 'image',
  mp4: 'video', mkv: 'video', webm: 'video', mov: 'video', avi: 'video',
  mp3: 'audio', flac: 'audio', ogg: 'audio', wav: 'audio', m4a: 'audio', opus: 'audio',
  pdf: 'document', txt: 'document', md: 'document', doc: 'document', docx: 'document', odt: 'document', epub: 'document', csv: 'document', xlsx: 'document', ods: 'document', pptx: 'document',
  js: 'code', ts: 'code', json: 'code', py: 'code', rs: 'code', c: 'code', sh: 'code', wasm: 'code', html: 'code', css: 'code',
};

export function fileKind(filename: string, mime: string | null): FileKind {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext]!;
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || mime === 'application/pdf') return 'document';
  if (/zip|compressed|tar|gzip|x-7z|octet-stream/.test(mime)) return mime.includes('octet') ? 'file' : 'archive';
  return 'file';
}

/** "1.2 MB of 4 MB", "4 MB", "12 KB so far". */
export function downloadSize(d: Pick<DownloadItem, 'state' | 'received' | 'total'>): string {
  if (d.state === 'in_progress') {
    if (d.total !== null && d.total > 0) return `${formatBytes(d.received)} of ${formatBytes(d.total)}`;
    return d.received > 0 ? `${formatBytes(d.received)} so far` : 'Starting…';
  }
  const size = d.total ?? (d.received > 0 ? d.received : null);
  return size === null ? '' : formatBytes(size);
}

export const STATE_LABEL: Record<DownloadItem['state'], string> = {
  in_progress: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  untracked: 'No longer followed',
};

/** Matches a download for the page's filter box (file name and address). */
export function downloadMatches(d: DownloadItem, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${d.filename}\n${d.url}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Saves text as a file through a temporary object URL (bookmark export). */
export function saveTextFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * An error as the library pages show it: storage errors in words a person can act on, anything else as its message.
 */
export function errorText(err: unknown): string {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  if (name === 'QuotaExceededError') return 'This browser has no room left for GNOME’s data. Remove some history or downloads, then try again.';
  if (name === 'StorageUnavailableError') return 'This browser does not let GNOME store data here (private window or blocked storage).';
  return err instanceof Error ? err.message : String(err);
}

/** The noun for a count ("visit" / "visits"); the caller writes the number (lib/format's pluralize adds it). */
export function word(n: number, one: string, many: string = `${one}s`): string {
  return n === 1 ? one : many;
}
