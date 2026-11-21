import { describe, expect, it } from 'vitest';
import { engineTestCapabilities } from '../../vite.config';
import { TEST_CAPABILITIES, testCapabilities } from './build-info';
import { BUILD_CAPABILITIES, OFFERED_CAPABILITIES } from './core';

describe('the e2e capability switch (WAVE-B3 D19)', () => {
  it('reads GNOME_ENGINE_TEST_CAPABILITIES only in e2e builds', () => {
    expect(engineTestCapabilities({ GNOME_ENGINE_TEST: '1', GNOME_ENGINE_TEST_CAPABILITIES: 'blocker, blocker' })).toEqual(['blocker']);
    expect(engineTestCapabilities({ GNOME_ENGINE_TEST_CAPABILITIES: 'blocker' })).toEqual([]);
    expect(engineTestCapabilities({ GNOME_ENGINE_TEST: '1' })).toEqual([]);
    expect(() => engineTestCapabilities({ GNOME_ENGINE_TEST: '1', GNOME_ENGINE_TEST_CAPABILITIES: 'bl"ocker' })).toThrow();
  });

  it('offers only known capabilities, only in e2e builds', () => {
    expect(testCapabilities(true, ['blocker', 'warp-drive', 7])).toEqual(['blocker']);
    expect(testCapabilities(false, ['blocker'])).toEqual([]);
    // unit tests are not an e2e build: production's set
    expect(TEST_CAPABILITIES).toEqual([]);
    expect(BUILD_CAPABILITIES).toEqual(OFFERED_CAPABILITIES);
    expect(OFFERED_CAPABILITIES).not.toContain('blocker');
  });
});
