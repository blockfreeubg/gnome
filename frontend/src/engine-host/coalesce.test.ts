import { describe, expect, it } from 'vitest';
import { COALESCE_MS, EVENT_RATE_LIMITS, TokenBuckets, admitEvent } from '../shared/engine-protocol';
import type { AnyEventMessage, EventMap, EventType } from '../shared/engine-protocol';
import { Coalescer, isCoalesced } from './coalesce';
import { ManualClock } from './testing/manual-clock';

function setup() {
  const clock = new ManualClock();
  const sent: Array<{ type: EventType; p: unknown; at: number }> = [];
  const c = new Coalescer(<T extends EventType>(type: T, p: EventMap[T]) => sent.push({ type, p, at: clock.now() }), clock);
  return { clock, sent, c };
}

const commit = (tabId: number, url: string, historyHandling: 'push' | 'replace'): EventMap['tab.committed'] => ({
  tabId,
  navId: null,
  url,
  engine: 'scramjet',
  kind: 'same-document',
  historyHandling,
  index: 0,
  length: 1,
  canGoBack: false,
  canGoForward: false,
  ms: null,
});

describe('Coalescer', () => {
  it('sends the first value at once and only the newest at the end of the interval', () => {
    const { c, sent, clock } = setup();
    for (let i = 0; i < 10; i++) c.emit('tab.title', { tabId: 1, title: `t${i}` });
    expect(sent.map((s) => (s.p as { title: string }).title)).toEqual(['t0']);
    clock.advance(COALESCE_MS['tab.title']);
    expect(sent.map((s) => (s.p as { title: string }).title)).toEqual(['t0', 't9']);
    clock.advance(COALESCE_MS['tab.title']);
    expect(sent).toHaveLength(2);
    // After a quiet interval, the next value goes out at once again.
    c.emit('tab.title', { tabId: 1, title: 'again' });
    expect(sent).toHaveLength(3);
  });

  it('flushes held values of a tab before any other event of that tab', () => {
    const { c, sent } = setup();
    c.emit('tab.loading', { tabId: 1, loading: true });
    c.emit('tab.title', { tabId: 1, title: 'a' });
    c.emit('tab.title', { tabId: 1, title: 'b' });
    c.emit('tab.loading', { tabId: 1, loading: false });
    c.emit('tab.title', { tabId: 2, title: 'other tab' });
    c.emit('tab.loaded', { tabId: 1, navId: 1, url: 'https://a.example/', engine: 'scramjet', ms: 5 });
    expect(sent.map((s) => s.type + ':' + JSON.stringify(s.p))).toEqual([
      'tab.loading:{"tabId":1,"loading":true}',
      'tab.title:{"tabId":1,"title":"a"}',
      'tab.title:{"tabId":2,"title":"other tab"}',
      'tab.title:{"tabId":1,"title":"b"}',
      'tab.loading:{"tabId":1,"loading":false}',
      'tab.loaded:{"tabId":1,"navId":1,"url":"https://a.example/","engine":"scramjet","ms":5}',
    ]);
  });

  it('merges same-document replace commits but never pushes', () => {
    expect(isCoalesced('tab.committed', commit(1, 'https://a/', 'replace'))).toBe(true);
    expect(isCoalesced('tab.committed', commit(1, 'https://a/', 'push'))).toBe(false);
    const { c, sent, clock } = setup();
    for (let i = 0; i < 50; i++) c.emit('tab.committed', commit(1, `https://a.example/?i=${i}`, 'replace'));
    c.emit('tab.committed', commit(1, 'https://a.example/pushed', 'push'));
    expect(sent.map((s) => (s.p as { url: string }).url)).toEqual([
      'https://a.example/?i=0',
      'https://a.example/?i=49',
      'https://a.example/pushed',
    ]);
    clock.advance(1000);
    expect(sent).toHaveLength(3);
  });

  it('keeps an ordinary replaceState-heavy page under the app rate limits', () => {
    const { c, sent, clock } = setup();
    const buckets = new TokenBuckets();
    let dropped = 0;
    // 60 replaceState calls and 30 title changes per second for 10 s.
    for (let t = 0; t < 10_000; t += 16) {
      c.emit('tab.committed', commit(1, `https://a.example/?t=${t}`, 'replace'));
      if (t % 32 === 0) c.emit('tab.title', { tabId: 1, title: `ticker ${t}` });
      clock.advance(16);
    }
    for (const s of sent) if (!admitEvent(buckets, { k: 'evt', type: s.type, p: s.p } as AnyEventMessage, s.at)) dropped++;
    expect(dropped).toBe(0);
    expect(sent.length).toBeLessThan(110);
    expect(EVENT_RATE_LIMITS['tab.committed'].perSecond).toBeGreaterThanOrEqual(2 * (1000 / COALESCE_MS['tab.committed']));
  });

  it('throttles download.progress per download and flushes it before download.done', () => {
    const { c, sent } = setup();
    for (let i = 1; i <= 5; i++) c.emit('download.progress', { downloadId: 'd1', received: i, total: 10 });
    c.emit('download.progress', { downloadId: 'd2', received: 1, total: null });
    c.emit('download.done', { downloadId: 'd1', state: 'completed', received: 10, error: null });
    expect(sent.map((s) => `${s.type}:${(s.p as { downloadId: string }).downloadId}:${(s.p as { received: number }).received}`)).toEqual([
      'download.progress:d1:1',
      'download.progress:d2:1',
      'download.progress:d1:5',
      'download.done:d1:10',
    ]);
  });

  it('forget drops held values of a closed tab', () => {
    const { c, sent, clock } = setup();
    c.emit('tab.title', { tabId: 3, title: 'a' });
    c.emit('tab.title', { tabId: 3, title: 'b' });
    c.forget('tab:3');
    clock.advance(1000);
    expect(sent).toHaveLength(1);
    expect(c.size).toBe(0);
  });
});
