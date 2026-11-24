import { describe, expect, it } from 'vitest';
import { OFFERED_CAPABILITIES } from './core';

describe('the offered capabilities (WAVE-B3 D19, §12.4)', () => {
  it('offers blocker for real since the step-3 integration (no build-time switch)', () => {
    expect(OFFERED_CAPABILITIES).toContain('blocker');
    expect(new Set(OFFERED_CAPABILITIES).size).toBe(OFFERED_CAPABILITIES.length);
  });
});
