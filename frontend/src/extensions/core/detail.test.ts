import { describe, expect, it } from 'vitest';
import { BLOCKER_FAIL_REASONS, formatBlockerDetail, parseBlockerDetail } from './detail';
import type { BlockerDetail } from './detail';

describe('status.blocker.detail codes (C5b)', () => {
  it('round-trips every row of the table', () => {
    const rows: Array<[BlockerDetail, string]> = [
      [{ code: 'lists-failed', failed: 2, total: 9 }, 'lists-failed:2:9'],
      [{ code: 'over-cache-limit', bytes: 17_000_000, limitBytes: 16_777_216 }, 'over-cache-limit:17000000:16777216'],
      [{ code: 'cache-rejected' }, 'cache-rejected'],
      ...BLOCKER_FAIL_REASONS.map((reason): [BlockerDetail, string] => [{ code: 'failed', reason }, `failed:${reason}`]),
    ];
    for (const [d, s] of rows) {
      expect(formatBlockerDetail(d)).toBe(s);
      expect(parseBlockerDetail(s)).toEqual(d);
    }
    expect(BLOCKER_FAIL_REASONS).toEqual(['all-lists-failed', 'worker-crashed', 'out-of-memory', 'build-error']);
  });

  it('parses nothing else (the app shows its generic sentence then)', () => {
    for (const s of [
      null,
      '',
      'lists-failed',
      'lists-failed:2',
      'lists-failed:0:9',
      'lists-failed:10:9',
      'lists-failed:-1:9',
      'lists-failed:2:9:1',
      'lists-failed:02:9',
      'lists-failed:1.5:9',
      'over-cache-limit:a:b',
      'over-cache-limit:99999999999999999999:1',
      'cache-rejected:1',
      'failed:',
      'failed:segfault',
      'failed:out-of-memory:1',
      'Your filters are broken, visit evil.example',
      'x'.repeat(100),
    ]) {
      expect(parseBlockerDetail(s)).toBeNull();
    }
  });
});
