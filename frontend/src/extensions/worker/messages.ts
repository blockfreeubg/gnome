/**
 * The messages between the engine host and its builder Worker (WAVE-B3 D8). Both sides validate what they receive:
 * the Worker takes input only from the engine host, and the engine host treats the Worker's answers as data
 * (counts, ids, codes, bytes), never as text it shows. DOM-free.
 */
import type { BlockerGroup, BlockerListStats, FilterListRef } from '../../shared/engine-protocol';
import { BLOCKER_GROUPS, BLOCKER_LIST_ERRORS } from '../../shared/engine-protocol';

export type ToWorker =
  | { type: 'build'; id: number; refs: FilterListRef[]; browser: 'chromium' | 'gecko' | 'other' }
  | { type: 'validated'; id: number; seq: number; drop: number[] };

export type FromWorker =
  | { type: 'validate'; id: number; seq: number; group: BlockerGroup; pairs: Array<[number, string]>; styles: Array<[number, string]> }
  | { type: 'group'; id: number; group: BlockerGroup; bytes: ArrayBuffer; network: number; cosmetic: number; scriptlets: number }
  | { type: 'done'; id: number; lists: BlockerListStats[]; resources: { redirects: number; scriptlets: number } | null; buildMs: number }
  | { type: 'error'; id: number; reason: 'all-lists-failed' | 'build-error' | 'out-of-memory' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const group = (v: unknown): v is BlockerGroup => typeof v === 'string' && (BLOCKER_GROUPS as readonly string[]).includes(v);

/** The engine host's check of a Worker message; null drops it. */
export function parseFromWorker(d: unknown): FromWorker | null {
  if (!isObj(d) || !nat(d.id)) return null;
  switch (d.type) {
    case 'validate': {
      if (!nat(d.seq) || !group(d.group) || !Array.isArray(d.pairs) || d.pairs.length > 2_000_000) return null;
      const pairs: Array<[number, string]> = [];
      for (const p of d.pairs as unknown[]) {
        if (!Array.isArray(p) || p.length !== 2 || !nat(p[0]) || typeof p[1] !== 'string' || p[1].length > 8192) return null;
        pairs.push([p[0], p[1]]);
      }
      // the :style() declarations of some of those ids (absent from an older Worker of the same build: none)
      const rawStyles = d.styles === undefined ? [] : d.styles;
      if (!Array.isArray(rawStyles) || rawStyles.length > pairs.length) return null;
      const styles: Array<[number, string]> = [];
      for (const p of rawStyles as unknown[]) {
        if (!Array.isArray(p) || p.length !== 2 || !nat(p[0]) || typeof p[1] !== 'string' || p[1].length > 8192) return null;
        styles.push([p[0], p[1]]);
      }
      return { type: 'validate', id: d.id, seq: d.seq, group: d.group, pairs, styles };
    }
    case 'group':
      return group(d.group) && d.bytes instanceof ArrayBuffer && d.bytes.byteLength > 0 && nat(d.network) && nat(d.cosmetic) && nat(d.scriptlets)
        ? { type: 'group', id: d.id, group: d.group, bytes: d.bytes, network: d.network, cosmetic: d.cosmetic, scriptlets: d.scriptlets }
        : null;
    case 'done': {
      if (!Array.isArray(d.lists) || d.lists.length > 501 || !nat(d.buildMs)) return null;
      const lists: BlockerListStats[] = [];
      for (const l of d.lists as unknown[]) {
        if (!isObj(l) || typeof l.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(l.id) || typeof l.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(l.sha256)) return null;
        if ((l.state !== 'compiled' && l.state !== 'failed') || !nat(l.rules) || !nat(l.dropped)) return null;
        if (!(l.error === null || (BLOCKER_LIST_ERRORS as readonly unknown[]).includes(l.error))) return null;
        lists.push({ id: l.id, sha256: l.sha256, state: l.state, error: l.error as BlockerListStats['error'], rules: l.rules, dropped: l.dropped });
      }
      const r = d.resources;
      const resources = r === null ? null : isObj(r) && nat(r.redirects) && nat(r.scriptlets) ? { redirects: r.redirects, scriptlets: r.scriptlets } : undefined;
      return resources === undefined ? null : { type: 'done', id: d.id, lists, resources, buildMs: d.buildMs };
    }
    case 'error':
      return d.reason === 'all-lists-failed' || d.reason === 'build-error' || d.reason === 'out-of-memory' ? { type: 'error', id: d.id, reason: d.reason } : null;
    default:
      return null;
  }
}
