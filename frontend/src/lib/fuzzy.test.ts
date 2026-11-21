import { describe, expect, it } from 'vitest';
import { fuzzyMatch, highlightParts } from './fuzzy';

const score = (q: string, t: string): number => fuzzyMatch(q, t)?.score ?? -Infinity;

describe('fuzzyMatch', () => {
  it('matches case-insensitive subsequences and rejects the rest', () => {
    expect(fuzzyMatch('stg', 'Settings')).not.toBeNull();
    expect(fuzzyMatch('SET', 'settings')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Settings')).toBeNull();
    expect(fuzzyMatch('sett', 'Set')).toBeNull();
  });

  it('empty queries match everything with score 0', () => {
    expect(fuzzyMatch('   ', 'Anything')).toEqual({ score: 0, indices: [] });
  });

  it('ranks prefixes and word starts above scattered matches', () => {
    expect(score('his', 'History')).toBeGreaterThan(score('his', 'Toggle this side'));
    expect(score('tsb', 'Toggle sidebar')).toBeGreaterThan(score('tsb', 'tests about'));
    expect(score('dark', 'Dark theme')).toBeGreaterThan(score('dark', 'Bookmark folders'));
    expect(score('down', 'Downloads')).toBeGreaterThan(score('down', 'Show markdown'));
  });

  it('prefers contiguous matches and shorter targets', () => {
    expect(score('set', 'Settings')).toBeGreaterThan(score('set', 'Sidebar: expanded tab'));
    expect(score('game', 'Games')).toBeGreaterThan(score('game', 'Open the game catalog and play something long'));
  });

  it('returns indices for highlighting', () => {
    const m = fuzzyMatch('tsb', 'Toggle sidebar')!;
    expect(m.indices).toEqual([0, 7, 11]);
    expect(highlightParts('Toggle sidebar', m.indices)).toEqual([
      { text: 'T', match: true },
      { text: 'oggle ', match: false },
      { text: 's', match: true },
      { text: 'ide', match: false },
      { text: 'b', match: true },
      { text: 'ar', match: false },
    ]);
    expect(fuzzyMatch('side', 'Toggle sidebar')!.indices).toEqual([7, 8, 9, 10]);
  });
});
