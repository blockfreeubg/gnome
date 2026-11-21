import { describe, expect, it } from 'vitest';
import { SessionStats, sumCounts } from './stats.svelte';

const siteOf = (u: string): string | null => {
  const h = new URL(u).hostname;
  return h.split('.').slice(-2).join('.');
};

describe('SessionStats (WAVE-B3 §7.1)', () => {
  it('sums tab.blocked deltas per category, tab and site', () => {
    const s = new SessionStats();
    s.onBlocked(1, 'https://www.a.example/', { ads: 2 });
    s.onBlocked(1, 'https://www.a.example/', { ads: 3, trackers: 1 });
    s.onBlocked(2, 'https://b.example/', { trackers: 4, 'direct-connection': 1 });
    expect(s.totals).toEqual({ ads: 3, trackers: 5, 'direct-connection': 1 });
    expect(s.perTab.get(1)).toEqual({ ads: 3, trackers: 1 });
    expect(sumCounts(s.totals)).toBe(8); // direct connections are not the blocker's
    expect(s.sitesOf(['https://a.example/x', 'https://b.example/'], siteOf)).toEqual([
      { site: 'a.example', counts: { ads: 3, trackers: 1 } },
      { site: 'b.example', counts: { trackers: 4, 'direct-connection': 1 } },
    ]);
  });

  it('starts a new document’s counts from zero (commit, or counts that went down)', () => {
    const s = new SessionStats();
    s.onBlocked(1, 'https://a.example/', { ads: 5 });
    s.newDocument(1);
    s.onBlocked(1, 'https://a.example/next', { ads: 2 });
    expect(s.totals.ads).toBe(7);
    // No commit seen, but the counts restarted: the new ones are all new.
    s.onBlocked(1, 'https://a.example/next', { ads: 1, trackers: 1 });
    expect(s.totals).toEqual({ ads: 8, trackers: 1 });
  });

  // The engine host counts a navigation from its first request, so the blocks of a new page's early (parser-preloaded)
  // requests reach the app between the navigation's start (tab.loading) and its tab.committed; it goes on with the
  // same counts after the commit and sends them once more then (engine-host/blocked.ts `resend`), alone or merged
  // with later blocks by its 500 ms coalescing.
  it('counts a new page’s early blocks once, when the engine host repeats them after the commit (alone or merged)', () => {
    const s = new SessionStats();
    s.navigationStarted(1);
    s.onBlocked(1, 'https://a.example/', { ads: 1 });
    s.onBlocked(1, 'https://a.example/', { ads: 3, trackers: 1 });
    s.newDocument(1, 'https://a.example/');
    s.onBlocked(1, 'https://a.example/', { ads: 3, trackers: 1 }); // the repeat, alone
    expect(s.totals).toEqual({ ads: 3, trackers: 1 });
    // A reload: early blocks again (the counts went down: a new navigation), then the repeat merged with a later block.
    s.navigationStarted(1);
    s.onBlocked(1, 'https://a.example/', { ads: 1 });
    s.onBlocked(1, 'https://a.example/', { ads: 3 });
    s.newDocument(1, 'https://a.example/');
    s.onBlocked(1, 'https://a.example/', { ads: 3, trackers: 1 });
    expect(s.totals).toEqual({ ads: 6, trackers: 2 });
    expect(s.perTab.get(1)).toEqual({ ads: 6, trackers: 2 });
    // A later block of that page counts.
    s.onBlocked(1, 'https://a.example/', { ads: 4, trackers: 1 });
    expect(s.totals).toEqual({ ads: 7, trackers: 2 });
  });

  it('a page whose blocks all come after its commit counts in full, also when they equal the previous page’s', () => {
    const s = new SessionStats();
    for (let i = 0; i < 3; i++) {
      s.navigationStarted(1);
      s.newDocument(1, `https://a.example/${i}`);
      s.onBlocked(1, `https://a.example/${i}`, { trackers: 1 });
    }
    expect(s.totals).toEqual({ trackers: 3 });
  });

  it('the early blocks of a new site count for it, not for the page the tab left', () => {
    const s = new SessionStats();
    s.navigationStarted(1);
    s.newDocument(1, 'https://a.example/');
    s.onBlocked(1, 'https://a.example/', { ads: 2 });
    // To b.example: its early block arrives while the tab still shows a.example.
    s.navigationStarted(1);
    s.onBlocked(1, 'https://a.example/', { trackers: 1 });
    s.newDocument(1, 'https://b.example/');
    s.onBlocked(1, 'https://b.example/', { ads: 1, trackers: 1 });
    expect(s.totals).toEqual({ ads: 3, trackers: 1 });
    expect(s.sitesOf(['https://a.example/', 'https://b.example/'], siteOf)).toEqual([
      { site: 'a.example', counts: { ads: 2 } },
      { site: 'b.example', counts: { ads: 1, trackers: 1 } },
    ]);
    // ... also when the page the tab left blocked nothing.
    s.navigationStarted(1);
    s.newDocument(1, 'https://c.example/');
    s.navigationStarted(1);
    s.onBlocked(1, 'https://c.example/', { ads: 2 });
    s.newDocument(1, 'https://d.example/');
    s.onBlocked(1, 'https://d.example/', { ads: 2 });
    expect(s.totals).toEqual({ ads: 5, trackers: 1 });
    expect(s.sitesOf(['https://c.example/', 'https://d.example/'], siteOf)).toEqual([{ site: 'd.example', counts: { ads: 2 } }]);
  });

  it('a second loading event of a navigation keeps its early counts; a navigation that ends without a commit forgets them', () => {
    const s = new SessionStats();
    s.navigationStarted(1);
    s.onBlocked(1, 'https://a.example/', { ads: 2 });
    s.navigationStarted(1);
    s.newDocument(1, 'https://a.example/');
    s.onBlocked(1, 'https://a.example/', { ads: 2 });
    expect(s.totals).toEqual({ ads: 2 });
    // A navigation that failed (blocked page, error): its counts stay; the next page starts from zero.
    s.navigationStarted(1);
    s.onBlocked(1, 'https://a.example/', { ads: 1 });
    s.navigationEnded(1);
    s.navigationStarted(1);
    s.newDocument(1, 'https://b.example/');
    s.onBlocked(1, 'https://b.example/', { ads: 1 });
    expect(s.totals).toEqual({ ads: 4 });
  });

  it('after a commit with nothing counted since its navigation started, the first counts are the new page’s', () => {
    const s = new SessionStats();
    s.onBlocked(1, 'https://a.example/', { ads: 2 });
    s.navigationStarted(1);
    s.newDocument(1, 'https://b.example/');
    s.onBlocked(1, 'https://b.example/', { ads: 2 });
    expect(s.totals).toEqual({ ads: 4 });
    expect(s.sitesOf(['https://b.example/'], siteOf)).toEqual([{ site: 'b.example', counts: { ads: 2 } }]);
  });

  it('ignores junk and keeps closed tabs in the totals', () => {
    const s = new SessionStats();
    s.onBlocked(1, 'javascript:void 0', { ads: -3, trackers: Number.NaN, cookies: 1.7 });
    expect(s.totals).toEqual({ cookies: 1 });
    s.forgetTab(1);
    expect(s.perTab.has(1)).toBe(false);
    expect(s.totals).toEqual({ cookies: 1 });
    expect(s.sitesOf(['https://closed.example/'], siteOf)).toEqual([]);
  });
});
