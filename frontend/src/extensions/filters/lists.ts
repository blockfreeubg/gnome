/**
 * Filter-list downloads for the builder Worker (WAVE-B3 §4.1, D9): `GET /api/filters/<id>?v=<sha256>` on the proxy
 * origin (same origin, `cache: 'default'`, so the immutable answer comes from the HTTP cache), at most 64 MiB per
 * list and 128 MiB per build, one `503` + `Retry-After` honoured, decoded as UTF-8 (fatal) and compiled only when the
 * body's SHA-256 equals the ref's. A failure is a BlockerListError code, never text. DOM-free (Worker scope).
 */
import type { BlockerListError, FilterListRef } from '../../shared/engine-protocol';

export const LIST_LIMITS = { listBytes: 64 * 1024 * 1024, buildBytes: 128 * 1024 * 1024, retryAfterMaxS: 10 } as const;

export type FetchedList = { ok: true; ref: FilterListRef; text: string; bytes: number } | { ok: false; ref: FilterListRef; error: BlockerListError };

export interface ListFetchDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  sha256(bytes: Uint8Array): Promise<string>;
  sleep(ms: number): Promise<void>;
  /** The proxy origin (the Worker's `location.origin`). */
  origin: string;
}

/** Bytes left of this build's budget (shared by the lists of one build). */
export interface BuildBudget {
  left: number;
}

export function newBudget(): BuildBudget {
  return { left: LIST_LIMITS.buildBytes };
}

export function listUrl(origin: string, ref: Pick<FilterListRef, 'id' | 'sha256'>): string {
  return `${origin}/api/filters/${encodeURIComponent(ref.id)}?v=${ref.sha256}`;
}

/** Reads a body up to `max` bytes; null when it is longer (the rest is cancelled). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(len) && len > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchList(ref: FilterListRef, deps: ListFetchDeps, budget: BuildBudget): Promise<FetchedList> {
  const url = listUrl(deps.origin, ref);
  let res: Response;
  try {
    res = await deps.fetch(url, { cache: 'default', credentials: 'omit', redirect: 'error' });
    if (res.status === 503) {
      const after = Number(res.headers.get('retry-after') ?? '1');
      await res.body?.cancel().catch(() => undefined);
      await deps.sleep(Math.max(0, Math.min(Number.isFinite(after) ? after : 1, LIST_LIMITS.retryAfterMaxS)) * 1000);
      res = await deps.fetch(url, { cache: 'default', credentials: 'omit', redirect: 'error' });
    }
  } catch {
    return { ok: false, ref, error: 'download' };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, ref, error: 'download' };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, Math.min(LIST_LIMITS.listBytes, budget.left));
  } catch {
    return { ok: false, ref, error: 'download' };
  }
  if (bytes === null) return { ok: false, ref, error: 'too-large' };
  budget.left -= bytes.byteLength;
  // The server keeps only the current version: a stale ?v= gets the current body (API.md), so compare the hash.
  if ((await deps.sha256(bytes)) !== ref.sha256) return { ok: false, ref, error: 'changed' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, ref, error: 'invalid-utf8' };
  }
  return { ok: true, ref, text, bytes: bytes.byteLength };
}

/** WebCrypto SHA-256 as lower-case hex (Worker, window and node). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
