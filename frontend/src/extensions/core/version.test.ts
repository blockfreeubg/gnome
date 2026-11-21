import { ENGINE_VERSION } from '@ghostery/adblocker';
import { describe, expect, it } from 'vitest';
import { ADBLOCKER_ENGINE_VERSION, BLOCKER_FORMAT } from './version';

describe('cache-key versions', () => {
  it('ADBLOCKER_ENGINE_VERSION is the pinned library constant (an upgrade changes the cache key deliberately)', () => {
    expect(ADBLOCKER_ENGINE_VERSION).toBe(ENGINE_VERSION);
    expect(BLOCKER_FORMAT).toBe(1);
  });
});
