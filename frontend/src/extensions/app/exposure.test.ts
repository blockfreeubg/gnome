import { describe, expect, it } from 'vitest';
import { EXPOSURE_BUDGET, SiteExposure } from './exposure';

const MAPS = {
  allowlist: ['*.site-a.localhost', 'other.example'],
  perSite: { '*.news.example': { adblock: false }, 'exact.example:8080': { cosmetic: false } } as Record<string, { adblock?: boolean; cosmetic?: boolean }>,
};

function clock(): { now: () => number; t: number } {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
}

describe('SiteExposure (WAVE-B3 D5)', () => {
  it('scopes the maps to exposed sites by siteKeysFor', () => {
    const e = new SiteExposure();
    expect(e.scoped(MAPS)).toEqual({ allowlist: [], perSite: {} });
    expect(e.expose('https://www.site-a.localhost/x', 1, 'gnome-load', MAPS)).toBe('added');
    expect(e.scoped(MAPS)).toEqual({ allowlist: ['*.site-a.localhost'], perSite: {} });
    e.expose('http://exact.example:8080/', 1, 'commit', MAPS);
    expect(e.scoped(MAPS).perSite).toEqual({ 'exact.example:8080': { cosmetic: false } });
    // Another port of the same host does not expose the port rule.
    const f = new SiteExposure();
    f.expose('http://exact.example:9090/', 1, 'commit', MAPS);
    expect(f.scoped(MAPS).perSite).toEqual({});
  });

  it('an exposure without rule entries is free and never counts against the budget', () => {
    const c = clock();
    const e = new SiteExposure({ now: c.now });
    for (let i = 0; i < 500; i++) expect(e.expose(`https://free-${i}.example/`, 1, 'nav-start', MAPS)).toBe('free');
    expect(e.expose('https://site-a.localhost/', 1, 'nav-start', MAPS)).toBe('added');
    expect(e.dropped).toBe(0);
  });

  it('a rule added later for a site that was exposed without one reaches the scope (e.g. Settings)', () => {
    const e = new SiteExposure();
    e.expose('https://later.example/', 1, 'commit', MAPS);
    const maps = { allowlist: ['*.later.example'], perSite: {} };
    expect(e.scoped(maps).allowlist).toEqual(['*.later.example']);
    // ... and exposing it again is free.
    expect(e.expose('https://later.example/', 1, 'commit', maps)).toBe('free');
  });

  it('budgets 20 rule-bearing sites per tab per minute and 120 per app page per hour', () => {
    const c = clock();
    const e = new SiteExposure({ now: c.now });
    const maps = { allowlist: Array.from({ length: 400 }, (_, i) => `*.r${i}.example`), perSite: {} };
    let n = 0;
    for (let i = 0; i < EXPOSURE_BUDGET.perTabPerMinute; i++) expect(e.expose(`https://r${n++}.example/`, 1, 'nav-start', maps)).toBe('added');
    expect(e.expose(`https://r${n}.example/`, 1, 'nav-start', maps)).toBe('dropped');
    expect(e.scoped(maps).allowlist).not.toContain(`*.r${n}.example`);
    // Another tab has its own minute.
    expect(e.expose(`https://r${n++}.example/`, 2, 'commit', maps)).toBe('added');
    // GNOME's own loads and restored entries always pass.
    expect(e.expose(`https://r${n++}.example/`, 1, 'gnome-load', maps)).toBe('added');
    expect(e.expose(`https://r${n++}.example/`, 1, 'restore', maps)).toBe('added');
    // A minute later the tab's window is open again, until the page's hour is used up.
    let added = 21;
    for (let m = 1; m < 10; m++) {
      c.t += 60_001;
      for (let i = 0; i < 20; i++) if (e.expose(`https://r${n++}.example/`, 1, 'commit', maps) === 'added') added++;
    }
    expect(added).toBe(EXPOSURE_BUDGET.perPagePerHour);
    expect(e.dropped).toBeGreaterThan(0);
    // An hour after the first ones, the page budget has room again.
    c.t += 60 * 60_000;
    expect(e.expose(`https://r${n++}.example/`, 1, 'commit', maps)).toBe('added');
  });

  it('is one object across engine-host replacements: the budget does not reset (the browser keeps it per app page)', () => {
    // The browser creates one SiteExposure per app page and never replaces it on onReset/onReady; nothing in the class
    // depends on a connection. A replacement is simulated by just continuing to use it.
    const c = clock();
    const e = new SiteExposure({ now: c.now });
    const maps = { allowlist: Array.from({ length: 50 }, (_, i) => `*.q${i}.example`), perSite: {} };
    for (let i = 0; i < 20; i++) e.expose(`https://q${i}.example/`, 7, 'nav-start', maps);
    expect(e.expose('https://q20.example/', 7, 'nav-start', maps)).toBe('dropped');
  });

  it('sends empty maps after two compromise signals', () => {
    const e = new SiteExposure();
    e.expose('https://site-a.localhost/', 1, 'gnome-load', MAPS);
    e.setCompromiseSignals(1);
    expect(e.paused).toBe(false);
    expect(e.scoped(MAPS).allowlist).toEqual(['*.site-a.localhost']);
    e.setCompromiseSignals(2);
    expect(e.paused).toBe(true);
    expect(e.scoped(MAPS)).toEqual({ allowlist: [], perSite: {} });
    e.setCompromiseSignals(0); // never goes back within the page
    expect(e.paused).toBe(true);
  });

  it('ignores what is not an http(s) URL and own-property tricks', () => {
    const e = new SiteExposure();
    expect(e.expose('javascript:alert(1)', 1, 'commit', MAPS)).toBe('free');
    const proto = { allowlist: [], perSite: JSON.parse('{"__proto__": {"adblock": false}}') as Record<string, { adblock?: boolean }> };
    e.expose('https://x.example/', 1, 'commit', proto);
    expect(Object.keys(e.scoped(proto).perSite)).toEqual([]);
  });
});
