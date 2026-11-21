// The engine host's check of its builder Worker's messages (WAVE-B3 D8): data only, never looser than what the
// Worker sends.
import { describe, expect, it } from 'vitest';
import { parseFromWorker } from './messages';

describe('parseFromWorker', () => {
  it('validate: pairs and the :style() declarations of some of them; malformed or oversized styles are refused', () => {
    const base = { type: 'validate', id: 1, seq: 2, group: 'ads', pairs: [[7, 'body'], [8, '.ad']] };
    expect(parseFromWorker({ ...base, styles: [[7, 'overflow: auto !important']] })).toEqual({ ...base, styles: [[7, 'overflow: auto !important']] });
    // absent (a Worker that sends none): no styles
    expect(parseFromWorker(base)).toEqual({ ...base, styles: [] });
    expect(parseFromWorker({ ...base, styles: [[7, 3]] })).toBeNull();
    expect(parseFromWorker({ ...base, styles: [[-1, 'x']] })).toBeNull();
    expect(parseFromWorker({ ...base, styles: [[7, 'x'.repeat(8193)]] })).toBeNull();
    expect(parseFromWorker({ ...base, styles: [[7, 'a'], [8, 'b'], [9, 'c']] })).toBeNull(); // more than the pairs
    expect(parseFromWorker({ ...base, styles: 'overflow' })).toBeNull();
  });

  it('refuses unknown groups, list error codes and non-buffer engines', () => {
    expect(parseFromWorker({ type: 'validate', id: 1, seq: 1, group: 'nope', pairs: [] })).toBeNull();
    expect(parseFromWorker({ type: 'group', id: 1, group: 'ads', bytes: 'x', network: 0, cosmetic: 0, scriptlets: 0 })).toBeNull();
    expect(parseFromWorker({ type: 'group', id: 1, group: 'ads', bytes: new ArrayBuffer(0), network: 0, cosmetic: 0, scriptlets: 0 })).toBeNull();
    const list = { id: 'easylist', sha256: 'a'.repeat(64), state: 'failed', error: 'bogus', rules: 0, dropped: 0 };
    expect(parseFromWorker({ type: 'done', id: 1, lists: [list], resources: null, buildMs: 5 })).toBeNull();
    expect(parseFromWorker({ type: 'done', id: 1, lists: [{ ...list, error: 'changed' }], resources: null, buildMs: 5 })).toMatchObject({ type: 'done' });
    expect(parseFromWorker({ type: 'error', id: 1, reason: 'something else' })).toBeNull();
  });
});
