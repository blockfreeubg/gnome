/**
 * `status.blocker.detail` codes (WAVE-B3 C5b): the engine host writes exactly one of these, the app parses it and
 * renders its own sentence (x4, `error-copy.ts`), and a generic one for anything that does not parse. Pure; the app
 * may import it.
 *
 * | state      | detail                                   |
 * | ---------- | ---------------------------------------- |
 * | `building` | null                                     |
 * | `ready`    | null                                     |
 * | `ready`    | `lists-failed:<failed>:<total>`          |
 * | `ready`    | `over-cache-limit:<bytes>:<limitBytes>`  |
 * | `ready`    | `cache-rejected`                         |
 * | `failed`   | `failed:<reason>`                        |
 * | `off`      | null                                     |
 */

export type BlockerFailReason = 'all-lists-failed' | 'worker-crashed' | 'out-of-memory' | 'build-error';
export const BLOCKER_FAIL_REASONS: readonly BlockerFailReason[] = ['all-lists-failed', 'worker-crashed', 'out-of-memory', 'build-error'];

export type BlockerDetail =
  | { code: 'lists-failed'; failed: number; total: number }
  | { code: 'over-cache-limit'; bytes: number; limitBytes: number }
  | { code: 'cache-rejected' }
  | { code: 'failed'; reason: BlockerFailReason };

const INT_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const int = (s: string | undefined): number | null => {
  if (s === undefined || !INT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** The code for a detail; integers are written in decimal (whole, non-negative, safe). */
export function formatBlockerDetail(d: BlockerDetail): string {
  const n = (x: number): string => String(Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(x))));
  switch (d.code) {
    case 'lists-failed':
      return `lists-failed:${n(d.failed)}:${n(d.total)}`;
    case 'over-cache-limit':
      return `over-cache-limit:${n(d.bytes)}:${n(d.limitBytes)}`;
    case 'cache-rejected':
      return 'cache-rejected';
    case 'failed':
      return `failed:${d.reason}`;
  }
}

/** The parsed code, or null for null and for anything that is not exactly one of the codes above. */
export function parseBlockerDetail(s: string | null): BlockerDetail | null {
  if (s === null || s.length > 80) return null;
  const parts = s.split(':');
  switch (parts[0]) {
    case 'lists-failed': {
      if (parts.length !== 3) return null;
      const failed = int(parts[1]);
      const total = int(parts[2]);
      return failed !== null && total !== null && failed >= 1 && failed <= total ? { code: 'lists-failed', failed, total } : null;
    }
    case 'over-cache-limit': {
      if (parts.length !== 3) return null;
      const bytes = int(parts[1]);
      const limitBytes = int(parts[2]);
      return bytes !== null && limitBytes !== null ? { code: 'over-cache-limit', bytes, limitBytes } : null;
    }
    case 'cache-rejected':
      return parts.length === 1 ? { code: 'cache-rejected' } : null;
    case 'failed': {
      const reason = parts[1] as BlockerFailReason;
      return parts.length === 2 && BLOCKER_FAIL_REASONS.includes(reason) ? { code: 'failed', reason } : null;
    }
    default:
      return null;
  }
}
