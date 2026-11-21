/**
 * `status.blocker` (WAVE-B3 §4.1, C5b): what the engine host reports, from the blocker's facts. Pure.
 * `off`: no lists in the snapshot, or no group can apply anywhere; `building`: loading or building with nothing in
 * force yet; `ready`: a set is in force (also while a newer one builds), `detail` a C5b code; `failed`: nothing could
 * be built. Detail precedence for `ready`: lists-failed, then over-cache-limit, then cache-rejected.
 */
import type { BlockerStatus } from '../../shared/engine-protocol';
import { formatBlockerDetail } from '../core/detail';
import type { BlockerFailReason } from '../core/detail';
import type { BlockerSettings } from '../core/policy';

export interface StatusFacts {
  /** Filter lists in the snapshot (the resources ref not counted). */
  lists: number;
  /** Some group's toggle is on globally or in a per-site override. */
  anyGroupOn: boolean;
  /** Lists compiled into the set in force (null: none in force). */
  inForce: { compiled: number; failed: number } | null;
  /** The last attempt failed completely (nothing in force). */
  failure: BlockerFailReason | null;
  overLimit: { bytes: number; limitBytes: number } | null;
  /** A cached set failed verification (reported until the next set is put in force). */
  cacheRejected: boolean;
}

export function blockerStatus(f: StatusFacts): BlockerStatus {
  if (f.lists === 0 || !f.anyGroupOn) return { state: 'off', lists: 0, detail: null };
  if (f.inForce) {
    const total = f.inForce.compiled + f.inForce.failed;
    const detail =
      f.inForce.failed > 0
        ? formatBlockerDetail({ code: 'lists-failed', failed: f.inForce.failed, total })
        : f.overLimit
          ? formatBlockerDetail({ code: 'over-cache-limit', ...f.overLimit })
          : f.cacheRejected
            ? formatBlockerDetail({ code: 'cache-rejected' })
            : null;
    return { state: 'ready', lists: f.inForce.compiled, detail };
  }
  if (f.failure) return { state: 'failed', lists: 0, detail: formatBlockerDetail({ code: 'failed', reason: f.failure }) };
  return { state: 'building', lists: 0, detail: null };
}

/** Whether any group can apply somewhere (D2): its toggle on globally or in a per-site override. */
export function anyGroupOn(s: BlockerSettings): boolean {
  const e = s.extensions.enabled;
  if (e.adblock || e.trackers || e.cosmetic || (e.privacy && s.privacy.stripTrackingParams)) return true;
  return Object.values(s.extensions.perSite).some((r) => r.adblock === true || r.trackers === true || r.cosmetic === true);
}

/** The retry delays after a complete failure (§4.1): 1 min, 5 min, 30 min, then at the next snapshot with other lists. */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 1_800_000];
