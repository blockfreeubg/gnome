/**
 * What the sync server accepts in an upload (API.md "Sync"; backend/src/api/validate.rs and api/sync/*.rs). The
 * server refuses a whole batch (422) for one invalid item, and the next sync would send the same batch again, so the
 * sync adapters never hand out a record that fails these checks: it stays on this device instead (pending() drops
 * its flag) and everything else keeps syncing. The stores only write records that pass (match.ts); this guards
 * against records an older build, another code path or a changed server rule left behind.
 */
import type { BookmarkRecord, HistoryRecord } from '../lib/idb';
import { hasLoneSurrogate, MAX_TITLE_LENGTH, storableUrl } from './match';

/** validate.rs MAX_CLOCK_SKEW_MS: client timestamps may be at most this far ahead of the server's clock. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
/** api/sync/bookmarks.rs MAX_POSITION. */
export const MAX_POSITION = 1e15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** An integer millisecond time the server takes (i64, ≥ 0, at most a day ahead of `now`). */
function okTime(t: unknown, now: number): boolean {
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= now + MAX_CLOCK_SKEW_MS;
}

/** check_title: at most 512 characters, no NUL; and encodable as JSON the server parses (no lone surrogate). */
function okTitle(t: unknown): boolean {
  if (typeof t !== 'string') return false;
  if (t.includes('\0') || hasLoneSurrogate(t)) return false;
  if (t.length <= MAX_TITLE_LENGTH) return true;
  return t.length <= MAX_TITLE_LENGTH * 2 && [...t].length <= MAX_TITLE_LENGTH;
}

/** A stored URL the server accepts (storableUrl returns it unchanged). */
function okUrl(u: unknown): boolean {
  return typeof u === 'string' && storableUrl(u) === u;
}

/** HistoryEntry {id, url, title, visited_at}. */
export function historyUploadable(r: HistoryRecord, now: number): boolean {
  return isUuid(r.id) && okUrl(r.url) && (r.title === null || r.title === undefined || okTitle(r.title)) && okTime(r.visitedAt, now);
}

/**
 * Bookmark as the adapter hands it out (parentId already mapped: null for the root). Tombstones need only the id,
 * the parent and the timestamps; live items also a valid kind, URL, title and position.
 */
export function bookmarkUploadable(r: BookmarkRecord, now: number): boolean {
  if (!isUuid(r.id) || !okTime(r.createdAt, now) || !okTime(r.updatedAt, now)) return false;
  if (r.parentId !== null && (!isUuid(r.parentId) || r.parentId.toLowerCase() === r.id.toLowerCase())) return false;
  if (r.deleted) return true;
  // bookmarkToWire sends `url: null` for every folder.
  if (r.kind === 'bookmark' ? !okUrl(r.url) : r.kind !== 'folder') return false;
  return okTitle(r.title) && typeof r.position === 'number' && Number.isFinite(r.position) && Math.abs(r.position) <= MAX_POSITION;
}
