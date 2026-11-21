import { describe, expect, it } from 'vitest';
import { BLOCK_CATEGORIES, BLOCKER_GROUPS } from '../../shared/engine-protocol';
import { CATEGORY_OF, GROUP_OF, MATCH_ORDER, TOGGLE_OF } from './categories';

describe('groups and categories (D1, D2)', () => {
  it('maps every list category but resources to a group, and every group to a block category and a toggle', () => {
    expect(Object.keys(GROUP_OF).sort()).toEqual(['ads', 'annoyances', 'cookies', 'privacy', 'security', 'urlparams']);
    expect(new Set(Object.values(GROUP_OF))).toEqual(new Set(BLOCKER_GROUPS));
    for (const g of BLOCKER_GROUPS) {
      expect(BLOCK_CATEGORIES).toContain(CATEGORY_OF[g]);
      expect(['adblock', 'trackers', 'privacy', 'cosmetic']).toContain(TOGGLE_OF[g]);
    }
    expect(TOGGLE_OF.security).toBe('adblock');
    expect(TOGGLE_OF.cookies).toBe('cosmetic');
  });

  it('matches every group but params (documents only, D13), security first', () => {
    expect(MATCH_ORDER[0]).toBe('security');
    expect([...MATCH_ORDER].sort()).toEqual(BLOCKER_GROUPS.filter((g) => g !== 'params').sort());
  });
});
