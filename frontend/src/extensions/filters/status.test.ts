import { describe, expect, it } from 'vitest';
import { parseBlockerDetail } from '../core/detail';
import { SW_FALLBACK_SETTINGS } from '../core/policy';
import { anyGroupOn, blockerStatus } from './status';
import type { StatusFacts } from './status';

const base: StatusFacts = { lists: 9, anyGroupOn: true, inForce: null, failure: null, overLimit: null, cacheRejected: false };

describe('status.blocker (C5b)', () => {
  it('off, building, ready, failed with their codes', () => {
    expect(blockerStatus({ ...base, lists: 0 })).toEqual({ state: 'off', lists: 0, detail: null });
    expect(blockerStatus({ ...base, anyGroupOn: false })).toEqual({ state: 'off', lists: 0, detail: null });
    expect(blockerStatus(base)).toEqual({ state: 'building', lists: 0, detail: null });
    expect(blockerStatus({ ...base, inForce: { compiled: 9, failed: 0 } })).toEqual({ state: 'ready', lists: 9, detail: null });
    const lf = blockerStatus({ ...base, inForce: { compiled: 7, failed: 2 }, overLimit: { bytes: 1, limitBytes: 2 }, cacheRejected: true });
    expect(lf).toEqual({ state: 'ready', lists: 7, detail: 'lists-failed:2:9' });
    expect(parseBlockerDetail(lf.detail)).toEqual({ code: 'lists-failed', failed: 2, total: 9 });
    expect(blockerStatus({ ...base, inForce: { compiled: 9, failed: 0 }, overLimit: { bytes: 17_000_000, limitBytes: 16_777_216 }, cacheRejected: true }).detail).toBe(
      'over-cache-limit:17000000:16777216',
    );
    expect(blockerStatus({ ...base, inForce: { compiled: 9, failed: 0 }, cacheRejected: true }).detail).toBe('cache-rejected');
    expect(blockerStatus({ ...base, failure: 'out-of-memory' })).toEqual({ state: 'failed', lists: 0, detail: 'failed:out-of-memory' });
    // a set in force wins over a later failed rebuild (the engines in force stay, D7)
    expect(blockerStatus({ ...base, failure: 'worker-crashed', inForce: { compiled: 9, failed: 0 } }).state).toBe('ready');
  });

  it('anyGroupOn follows the global toggles and per-site overrides', () => {
    const s = structuredClone(SW_FALLBACK_SETTINGS);
    expect(anyGroupOn(s)).toBe(true);
    s.extensions.enabled = { adblock: false, trackers: false, privacy: true, cookies: true, cosmetic: false };
    s.privacy.stripTrackingParams = false;
    expect(anyGroupOn(s)).toBe(false);
    s.extensions.perSite = { 'a.example': { trackers: true } };
    expect(anyGroupOn(s)).toBe(true);
  });
});
