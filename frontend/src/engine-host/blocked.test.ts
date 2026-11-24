import { describe, expect, it } from 'vitest';
import type { BlockCategory, EventMap } from '../shared/engine-protocol';
import { validateEventPayload } from '../shared/engine-protocol';
import { BlockedCounts } from './blocked';
import { Coalescer, isCoalesced } from './coalesce';
import type { Clock } from './coalesce';

describe('BlockedCounts', () => {
  it('counts per tab and category, total includes direct-connection, resets with the top document', () => {
    const sent: Array<EventMap['tab.blocked']> = [];
    const tabless: BlockCategory[] = [];
    const c = new BlockedCounts((p) => sent.push(p), (cat) => tabless.push(cat));
    c.count(1, 'ads');
    c.count(1, 'ads');
    c.count(1, 'direct-connection');
    c.count(2, 'trackers', 3);
    c.count(null, 'ads');
    c.count(1, 'bogus' as BlockCategory);
    c.count(1, 'ads', 0);
    expect(sent.at(-2)).toEqual({ tabId: 1, total: 3, byCategory: { ads: 2, 'direct-connection': 1 } });
    expect(sent.at(-1)).toEqual({ tabId: 2, total: 3, byCategory: { trackers: 3 } });
    expect(tabless).toEqual(['ads']);
    for (const p of sent) expect(validateEventPayload('tab.blocked', p).ok).toBe(true);
    c.reset(1);
    c.count(1, 'security');
    expect(sent.at(-1)).toEqual({ tabId: 1, total: 1, byCategory: { security: 1 } });
    c.forget(2);
    expect(c.of(2)).toEqual({});
  });

  it('counts a blocked URL once per page (keyed), resets keys with the counts, and resends the counts after a commit', () => {
    const sent: Array<EventMap['tab.blocked']> = [];
    const c = new BlockedCounts((p) => sent.push(p), () => undefined);
    c.count(1, 'ads', 1, 'http://ads.localhost/1');
    c.count(1, 'ads', 1, 'http://ads.localhost/1'); // Firefox's second request for a refused preloaded image
    c.count(1, 'ads', 1, 'http://ads.localhost/2');
    c.count(1, 'trackers', 1, 'http://ads.localhost/1');
    c.count(1, 'direct-connection'); // no key: every one counts
    c.count(1, 'direct-connection');
    expect(sent.at(-1)).toEqual({ tabId: 1, total: 5, byCategory: { ads: 2, trackers: 1, 'direct-connection': 2 } });
    expect(sent).toHaveLength(5);
    // the app starts its numbers again at the commit: the same totals go out once more, nothing for a tab without counts
    c.resend(1);
    expect(sent.at(-1)).toEqual({ tabId: 1, total: 5, byCategory: { ads: 2, trackers: 1, 'direct-connection': 2 } });
    expect(sent).toHaveLength(6);
    c.resend(2);
    expect(sent).toHaveLength(6);
    // a new navigation: counts and keys start again
    c.reset(1);
    c.resend(1);
    expect(sent).toHaveLength(6);
    c.count(1, 'ads', 1, 'http://ads.localhost/1');
    expect(sent.at(-1)).toEqual({ tabId: 1, total: 1, byCategory: { ads: 1 } });
    c.forget(1);
    c.count(1, 'ads', 1, 'http://ads.localhost/1');
    expect(sent.at(-1)).toEqual({ tabId: 1, total: 1, byCategory: { ads: 1 } });
  });

  it('coalesces like every tab.blocked (latest value), while tab.loading with a url is never held', () => {
    expect(isCoalesced('tab.blocked', { tabId: 1, total: 1, byCategory: {} })).toBe(true);
    expect(isCoalesced('tab.loading', { tabId: 1, loading: true })).toBe(true);
    expect(isCoalesced('tab.loading', { tabId: 1, loading: true, url: 'https://a.example/' })).toBe(false);
    const out: unknown[] = [];
    const timers: Array<() => void> = [];
    const clock: Clock = { setTimeout: (f) => timers.push(f), clearTimeout: () => undefined };
    const co = new Coalescer((type, p) => out.push([type, p]), clock);
    const c = new BlockedCounts((p) => co.emit('tab.blocked', p), () => undefined);
    c.count(1, 'ads');
    c.count(1, 'direct-connection');
    c.count(1, 'ads');
    expect(out).toHaveLength(1);
    co.emit('tab.loading', { tabId: 1, loading: true, url: 'https://b.example/' });
    // the held tab.blocked of that tab goes first (order per tab), then the announcement, at once
    expect(out.slice(1)).toEqual([
      ['tab.blocked', { tabId: 1, total: 3, byCategory: { ads: 2, 'direct-connection': 1 } }],
      ['tab.loading', { tabId: 1, loading: true, url: 'https://b.example/' }],
    ]);
  });
});

import { Announcements } from './blocked';

describe('Announcements (D5)', () => {
  it('waits for the answer to an announced host, at most the timeout; answered hosts never wait', async () => {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const a = new Announcements({ setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1, clearTimeout: (t) => void ((timers[t as number] as { cleared: boolean }).cleared = true) });
    expect(a.answered('http://site-a.localhost/')).toBe(false);
    a.announced('http://site-a.localhost/x');
    expect(a.pending('http://site-a.localhost/y')).toBe(true);
    let done = false;
    const w = a.wait('http://site-a.localhost/z', 150).then(() => (done = true));
    a.onSettings();
    await w;
    expect(done).toBe(true);
    expect(timers[0]?.cleared).toBe(true);
    expect(a.answered('http://site-a.localhost/')).toBe(true);
    await a.wait('http://site-a.localhost/', 150); // answered: at once
    a.announced('http://site-b.localhost/');
    const t = a.wait('http://site-b.localhost/', 150);
    timers.at(-1)?.fn();
    await t;
    expect(a.stats).toEqual({ waits: 2, timeouts: 1 });
    await a.wait('http://never.localhost/', 150); // never announced: no wait
    expect(a.stats.waits).toBe(2);
  });
});

import { WsMarks } from './blocked';

describe('WsMarks (D16 backstop)', () => {
  it('one-shot allow marks, block marks that last 5 s, everything else judged', () => {
    let t = 0;
    const m = new WsMarks(() => t);
    m.allowed('wss://a.example/s');
    expect(m.take('wss://a.example/s')).toBe('skip');
    expect(m.take('wss://a.example/s')).toBe('judge');
    m.blocked('wss://ads.example/s');
    expect(m.take('wss://ads.example/s')).toBe('blocked');
    expect(m.take('wss://ads.example/s')).toBe('blocked');
    t = 5001;
    expect(m.take('wss://ads.example/s')).toBe('judge');
    m.allowed('wss://b.example/');
    t = 10_002;
    expect(m.take('wss://b.example/')).toBe('judge');
    m.allowed('wss://c.example/');
    m.blocked('wss://ads.example/s');
    m.clear();
    expect(m.take('wss://c.example/')).toBe('judge');
    expect(m.take('wss://ads.example/s')).toBe('judge');
  });
});
