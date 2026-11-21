/**
 * The builder Worker (WAVE-B3 D8): a dedicated module Worker on the proxy origin, started by the engine host for one
 * build and terminated after it. It downloads the lists by hash (filters/lists.ts), sanitizes them with x2's
 * sanitizer, builds the group engines one after the other (build.ts), asks the engine host's main thread to validate
 * the selectors (it has a DOM), and transfers each serialized group back. It takes input only from the engine host.
 */
import type { BlockerGroup } from '../../shared/engine-protocol';
import { sanitizeList, trustOnlyScriptlets } from '../core/sanitize';
import { preprocessorEnv } from '../filters/config';
import { fetchList, newBudget, sha256Hex } from '../filters/lists';
import type { FetchedList } from '../filters/lists';
import { buildEngines } from './build';
import type { FromWorker, ToWorker } from './messages';

/** The Worker's global, typed narrowly (this file compiles with the project's DOM lib). */
const scope = self as unknown as {
  postMessage(m: FromWorker, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  location: { origin: string };
};

const pending = new Map<number, (drop: number[]) => void>();
let seq = 0;
let busy = false;

const post = (m: FromWorker, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);

async function build(m: Extract<ToWorker, { type: 'build' }>): Promise<void> {
  const t0 = performance.now();
  const deps = { fetch: (u: string, i: RequestInit) => fetch(u, i), sha256: sha256Hex, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), origin: scope.location.origin };
  const budget = newBudget();
  const resRef = m.refs.find((r) => r.category === 'resources' && r.format === 'resources') ?? null;
  const lists: FetchedList[] = [];
  // The resources first (trust depends on them), then each list (one at a time: memory, D8).
  const resources = resRef ? { ref: resRef, fetched: await fetchList(resRef, deps, budget) } : null;
  for (const ref of m.refs) {
    if (ref === resRef || ref.category === 'resources') continue;
    lists.push(await fetchList(ref, deps, budget));
  }
  if (lists.length > 0 && lists.every((l) => !l.ok)) {
    post({ type: 'error', id: m.id, reason: 'all-lists-failed' });
    return;
  }
  const result = await buildEngines(lists, resources, {
    sanitize: sanitizeList,
    trustOnly: trustOnlyScriptlets,
    env: preprocessorEnv(m.browser),
    validate: (group: BlockerGroup, pairs, styles) =>
      new Promise<number[]>((resolve) => {
        const s = ++seq;
        pending.set(s, resolve);
        post({ type: 'validate', id: m.id, seq: s, group, pairs, styles });
      }),
    onGroup: (g) => post({ type: 'group', id: m.id, group: g.group, bytes: g.bytes, network: g.network, cosmetic: g.cosmetic, scriptlets: g.scriptlets }, [g.bytes]),
  });
  post({ type: 'done', id: m.id, lists: result.lists, resources: result.resources, buildMs: Math.round(performance.now() - t0) });
}

scope.onmessage = (ev: MessageEvent<unknown>) => {
  const m = ev.data as Partial<ToWorker> | null;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'validated' && typeof m.seq === 'number' && Array.isArray(m.drop)) {
    const r = pending.get(m.seq);
    pending.delete(m.seq);
    r?.(m.drop.filter((x): x is number => typeof x === 'number'));
    return;
  }
  if (m.type === 'build' && typeof m.id === 'number' && Array.isArray(m.refs) && !busy) {
    busy = true;
    const id = m.id;
    build(m as Extract<ToWorker, { type: 'build' }>).catch((err: unknown) => {
      const oom = err instanceof RangeError || /memory|allocation/i.test(String(err));
      post({ type: 'error', id, reason: oom ? 'out-of-memory' : 'build-error' });
    });
  }
};
