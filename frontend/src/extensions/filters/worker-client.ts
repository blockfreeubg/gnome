/**
 * The engine host's side of a build (WAVE-B3 §4.1, D8): starts the builder Worker, answers its selector batches with
 * x2's validateSelectors on this realm's CSSStyleSheet (≤ 8 ms slices) and a probe document, validates every message
 * (worker/messages.ts), and terminates the Worker after `done`, `error`, an abort (a newer build) or 120 s.
 */
import type { BlockerGroup, BlockerListStats, FilterListRef } from '../../shared/engine-protocol';
import type { BlockerFailReason } from '../core/detail';
import { parseFromWorker } from '../worker/messages';
import type { ToWorker } from '../worker/messages';

export const BUILD_TIMEOUT_MS = 120_000;

export interface WorkerLike {
  postMessage(m: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  onerror: ((ev: ErrorEvent | Event) => void) | null;
}

export interface BuiltGroup {
  group: BlockerGroup;
  bytes: ArrayBuffer;
  network: number;
  cosmetic: number;
  scriptlets: number;
}

export type BuildOutcome =
  | { kind: 'built'; groups: BuiltGroup[]; lists: BlockerListStats[]; resources: { redirects: number; scriptlets: number } | null; buildMs: number }
  | { kind: 'failed'; reason: BlockerFailReason }
  | { kind: 'aborted' };

export interface WorkerClientDeps {
  createWorker(): WorkerLike;
  /**
   * Ids to drop of [id, selector] pairs (x2's validateSelectors, on the main thread); `styles`: the `:style()`
   * declarations by id (validateSelectors' `opts.styles`).
   */
  validate(pairs: Array<[number, string]>, styles: ReadonlyMap<number, string>): Promise<number[]>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

let buildSeq = 0;

export function runBuild(refs: FilterListRef[], browser: 'chromium' | 'gecko' | 'other', deps: WorkerClientDeps, signal: AbortSignal): Promise<BuildOutcome> {
  return new Promise<BuildOutcome>((resolve) => {
    const id = ++buildSeq;
    const groups: BuiltGroup[] = [];
    let w: WorkerLike;
    try {
      w = deps.createWorker();
    } catch {
      resolve({ kind: 'failed', reason: 'worker-crashed' });
      return;
    }
    let done = false;
    const finish = (o: BuildOutcome): void => {
      if (done) return;
      done = true;
      deps.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        w.terminate();
      } catch {
        /* gone */
      }
      resolve(o);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = deps.setTimeout(() => finish({ kind: 'failed', reason: 'worker-crashed' }), BUILD_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);
    w.onerror = (ev) => {
      const msg = typeof (ev as ErrorEvent).message === 'string' ? (ev as ErrorEvent).message : '';
      finish({ kind: 'failed', reason: /memory|allocation/i.test(msg) ? 'out-of-memory' : 'worker-crashed' });
    };
    w.onmessage = (ev) => {
      const m = parseFromWorker(ev.data);
      if (!m || m.id !== id || done) return;
      switch (m.type) {
        case 'validate':
          void deps
            .validate(m.pairs, new Map(m.styles))
            .catch(() => [] as number[])
            .then((drop) => {
              if (!done) w.postMessage({ type: 'validated', id, seq: m.seq, drop });
            });
          break;
        case 'group':
          if (!groups.some((g) => g.group === m.group)) groups.push({ group: m.group, bytes: m.bytes, network: m.network, cosmetic: m.cosmetic, scriptlets: m.scriptlets });
          break;
        case 'done':
          finish(groups.length ? { kind: 'built', groups, lists: m.lists, resources: m.resources, buildMs: m.buildMs } : { kind: 'failed', reason: 'all-lists-failed' });
          break;
        case 'error':
          finish({ kind: 'failed', reason: m.reason });
          break;
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    w.postMessage({ type: 'build', id, refs, browser });
  });
}

/** The real Worker (Vite bundles it as its own module chunk on the proxy origin). */
export function createBuilderWorker(): WorkerLike {
  return new Worker(new URL('../worker/builder.worker.ts', import.meta.url), { type: 'module', name: 'gnome-blocker-build' }) as unknown as WorkerLike;
}
