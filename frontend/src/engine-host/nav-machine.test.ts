import { describe, expect, it } from 'vitest';
import { TIMEOUTS, validateEventPayload } from '../shared/engine-protocol';
import type { EngineId, EventMap, EventType } from '../shared/engine-protocol';
import { TabNavigator } from './nav-machine';
import type { Nav, NavEnv } from './nav-machine';
import { ManualClock } from './testing/manual-clock';

type Ev = { type: EventType; p: unknown };

function setup(over: Partial<NavEnv> & { ready?: Partial<Record<EngineId, boolean>>; unchanged?: boolean } = {}) {
  const clock = new ManualClock();
  const events: Ev[] = [];
  let navSeq = 0;
  const fallbacks: Nav[] = [];
  const downloads: { confirmed: Nav[]; cancelled: Nav[] } = { confirmed: [], cancelled: [] };
  const ready = { scramjet: true, ultraviolet: true, ...over.ready };
  const env: NavEnv = {
    now: () => clock.now(),
    clock,
    emit: <T extends EventType>(type: T, p: EventMap[T]) => {
      const v = validateEventPayload(type, p);
      if (!v.ok) throw new Error(`invalid ${type}: ${v.error}`);
      events.push({ type, p });
    },
    nextNavId: () => ++navSeq,
    engineReady: (e) => ready[e],
    autoFallback: () => true,
    transportOffline: () => false,
    online: () => true,
    startFallback: (nav) => fallbacks.push(nav),
    documentUnchanged: () => over.unchanged ?? true,
    confirmDownload: (nav) => downloads.confirmed.push(nav),
    cancelDownload: (nav) => downloads.cancelled.push(nav),
    ...over,
  };
  const tab = new TabNavigator(7, env);
  const of = <T extends EventType>(type: T) => events.filter((e) => e.type === type).map((e) => e.p as EventMap[T]);
  return { tab, clock, events, of, fallbacks, downloads, env };
}

const A = 'https://a.example/';
const B = 'https://b.example/page';
const C = 'https://c.example/';

describe('TabNavigator: GNOME-initiated navigations', () => {
  it('loading → committed (push) → loaded, with index and length', () => {
    const { tab, of, events } = setup();
    const nav = tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'scramjet');
    tab.documentLoaded(A, 'scramjet');
    expect(events.map((e) => e.type)).toEqual(['tab.loading', 'tab.committed', 'tab.loading', 'tab.loaded']);
    const c = of('tab.committed')[0];
    expect(c).toMatchObject({ navId: nav.id, url: A, kind: 'navigate', historyHandling: 'push', index: 0, length: 1, canGoBack: false });
    expect(of('tab.loaded')[0]).toMatchObject({ navId: nav.id, url: A, engine: 'scramjet' });
    expect(tab.state()).toMatchObject({ entries: [A], index: 0, loading: false, navId: nav.id, engine: 'scramjet', error: null });
  });

  it('commits a redirect with the final URL', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(B, 'scramjet');
    expect(of('tab.committed')[0]?.url).toBe(B);
    expect(tab.history.entries).toEqual([B]);
  });

  it('tab.go is a traverse onto the target entry; reload is replace', () => {
    const { tab, of } = setup();
    for (const u of [A, B, C]) {
      tab.beginGnome({ url: u, engine: 'scramjet', kind: 'navigate', forced: false });
      tab.commitDocument(u, 'scramjet');
      tab.documentLoaded(u, 'scramjet');
    }
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'history', targetIndex: 0, forced: false });
    tab.commitDocument(A, 'scramjet');
    expect(of('tab.committed').at(-1)).toMatchObject({ kind: 'history', historyHandling: 'traverse', index: 0, length: 3, canGoForward: true });
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'reload', forced: false });
    tab.commitDocument(A, 'scramjet');
    expect(of('tab.committed').at(-1)).toMatchObject({ kind: 'reload', historyHandling: 'replace', index: 0, length: 3 });
    // A new navigation from entry 0 drops the forward entries.
    tab.beginGnome({ url: C, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(C, 'scramjet');
    expect(tab.history.entries).toEqual([A, C]);
  });

  it('the first commit of a restored tab replaces entries[index]', () => {
    const { tab, of } = setup();
    tab.history.restore([A, B, C], 1);
    tab.beginGnome({ url: B, engine: 'ultraviolet', kind: 'navigate', restore: true, forced: false });
    tab.commitDocument(B, 'ultraviolet');
    expect(of('tab.committed')[0]).toMatchObject({ kind: 'navigate', historyHandling: 'replace', index: 1, length: 3, canGoBack: true, canGoForward: true });
  });

  it('caps the back/forward list at 50 entries', () => {
    const { tab, of } = setup();
    for (let i = 0; i < 60; i++) {
      const u = `https://x.example/${i}`;
      tab.beginGnome({ url: u, engine: 'scramjet', kind: 'navigate', forced: false });
      tab.commitDocument(u, 'scramjet');
    }
    expect(tab.history.length).toBe(50);
    expect(of('tab.committed').at(-1)).toMatchObject({ index: 49, length: 50 });
    expect(tab.history.entries[0]).toBe('https://x.example/10');
  });
});

describe('TabNavigator: navigations started in the page', () => {
  it('a link (request hook / navigate event) is push, a location.replace is replace', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'ultraviolet');
    tab.documentLoaded(A, 'ultraviolet');
    tab.beginPage({ url: B, engine: 'ultraviolet', type: 'push' });
    tab.commitDocument(B, 'ultraviolet');
    tab.documentLoaded(B, 'ultraviolet');
    expect(of('tab.committed').at(-1)).toMatchObject({ url: B, historyHandling: 'push', index: 1, length: 2 });
    tab.beginPage({ url: C, engine: 'ultraviolet', type: 'replace' });
    tab.commitDocument(C, 'ultraviolet');
    expect(of('tab.committed').at(-1)).toMatchObject({ url: C, kind: 'navigate', historyHandling: 'replace', index: 1, length: 2 });
    expect(of('tab.loaded')).toHaveLength(2);
  });

  it('a second start signal for a pending navigation only updates the method', () => {
    const { tab, of } = setup();
    const n1 = tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    const n2 = tab.beginPage({ url: A, engine: 'scramjet', method: 'post' });
    expect(n2).toBe(n1);
    expect(n1.method).toBe('POST');
    expect(of('tab.loading')).toHaveLength(1);
  });

  it('the browser Back button moving the frame is a traversal (timing back_forward, no start signal)', () => {
    const { tab, of } = setup();
    for (const u of [A, B]) {
      tab.beginGnome({ url: u, engine: 'scramjet', kind: 'navigate', forced: false });
      tab.commitDocument(u, 'scramjet');
      tab.documentLoaded(u, 'scramjet');
    }
    tab.commitDocument(A, 'scramjet', 'back_forward');
    tab.documentLoaded(A, 'scramjet');
    expect(of('tab.committed').at(-1)).toMatchObject({ url: A, kind: 'history', historyHandling: 'traverse', index: 0, length: 2 });
    expect(of('tab.loaded').at(-1)?.url).toBe(A);
  });

  it('a traversal without a matching entry is reported as navigate/push', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'scramjet');
    tab.beginPage({ url: C, engine: 'scramjet', type: 'traverse' });
    tab.commitDocument(C, 'scramjet');
    expect(of('tab.committed').at(-1)).toMatchObject({ kind: 'navigate', historyHandling: 'push', index: 1 });
  });

  it('an Ultraviolet navigation announced by beforeunload learns its URL at the commit', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'ultraviolet');
    tab.documentLoaded(A, 'ultraviolet');
    const nav = tab.beginPage({ url: null, engine: 'ultraviolet' });
    tab.commitDocument(B, 'ultraviolet', 'navigate');
    expect(nav.url).toBe(B);
    expect(of('tab.committed').at(-1)).toMatchObject({ url: B, historyHandling: 'push', navId: nav.id });
  });

  it('a page reload without start signal commits as reload/replace', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'ultraviolet');
    tab.documentLoaded(A, 'ultraviolet');
    tab.beginPage({ url: null, engine: 'ultraviolet' });
    tab.commitDocument(A, 'ultraviolet', 'reload');
    expect(of('tab.committed').at(-1)).toMatchObject({ kind: 'reload', historyHandling: 'replace', index: 0, length: 1 });
  });

  it('a non-HTML document with no hook commits at its load event', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.documentLoaded(A, 'scramjet');
    expect(of('tab.committed')).toHaveLength(1);
    expect(of('tab.loaded')).toHaveLength(1);
  });
});

describe('TabNavigator: same-document commits', () => {
  function loaded() {
    const s = setup();
    s.tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    s.tab.commitDocument(A, 'scramjet');
    s.tab.documentLoaded(A, 'scramjet');
    return s;
  }

  it('push, replace and traverse (popstate) keep index/length right', () => {
    const { tab, of } = loaded();
    tab.sameDocument(`${A}one`, 'push');
    tab.sameDocument(`${A}two`, 'push');
    tab.sameDocument(`${A}two?x=1`, 'replace');
    expect(of('tab.committed').at(-1)).toMatchObject({ kind: 'same-document', historyHandling: 'replace', index: 2, length: 3, navId: null, ms: null });
    tab.sameDocument(`${A}one`, 'traverse');
    expect(of('tab.committed').at(-1)).toMatchObject({ historyHandling: 'traverse', index: 1, length: 3, canGoForward: true });
    expect(tab.history.entries).toEqual([A, `${A}one`, `${A}two?x=1`]);
  });

  it('a replace to the same URL changes nothing', () => {
    const { tab, of } = loaded();
    tab.sameDocument(A, 'replace');
    expect(of('tab.committed')).toHaveLength(1);
  });

  it('a traversal to an unknown URL becomes a replace', () => {
    const { tab, of } = loaded();
    tab.sameDocument(`${A}#frag`, 'traverse');
    expect(of('tab.committed').at(-1)).toMatchObject({ historyHandling: 'replace', index: 0, length: 1 });
  });
  it('ignores and counts a same-document commit to another origin (WAVE-B3 F4)', () => {
    const { tab, of } = loaded();
    tab.sameDocument('https://bank.example/login', 'push');
    tab.sameDocument('http://a.example/', 'replace');
    tab.sameDocument('https://a.example:8443/', 'replace');
    expect(of('tab.committed')).toHaveLength(1);
    expect(tab.crossOriginSameDocument).toBe(3);
    expect(tab.current?.url).toBe(A);
    tab.sameDocument(`${A}ok`, 'push');
    expect(of('tab.committed')).toHaveLength(2);
  });
});

describe('TabNavigator: failures and the controlled fallback', () => {
  it('a Scramjet error-hook failure of a GET switches to Ultraviolet once (same navId)', () => {
    const { tab, of, fallbacks } = setup();
    const nav = tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.fail('error-hook', 'injected');
    expect(of('tab.engineSwitched')[0]).toMatchObject({ navId: nav.id, from: 'scramjet', to: 'ultraviolet', reason: 'error-hook' });
    expect(fallbacks).toEqual([nav]);
    expect(of('tab.error')).toHaveLength(0);
    // The retry fails too: attempted, no second switch.
    const retry = tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true, auto: true, navId: nav.id });
    expect(retry.id).toBe(nav.id);
    tab.uvErrorPage('Error: code 7 Could not connect', A);
    expect(of('tab.error')[0]).toMatchObject({ navId: nav.id, signal: 'uv-error-page', fallback: 'attempted', engine: 'ultraviolet', kind: 'network' });
    expect(of('tab.engineSwitched')).toHaveLength(1);
  });

  it('a POST is never re-sent: fallback available, idempotent false', () => {
    const { tab, of, fallbacks } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'scramjet');
    tab.documentLoaded(A, 'scramjet');
    tab.beginPage({ url: B, engine: 'scramjet', method: 'POST' });
    tab.fail('error-hook', 'boom');
    expect(fallbacks).toHaveLength(0);
    expect(of('tab.error')[0]).toMatchObject({ fallback: 'available', idempotent: false, signal: 'error-hook', kind: 'engine' });
    expect(of('tab.error')[0]?.detail).toContain('POST');
  });

  it('a forced engine has no automatic fallback; the timeout is a timeout', () => {
    const { tab, of, fallbacks, clock } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: true });
    clock.advance(TIMEOUTS.navigationMs);
    expect(fallbacks).toHaveLength(0);
    expect(of('tab.error')[0]).toMatchObject({ signal: 'timeout', kind: 'timeout', fallback: 'available' });
    expect(tab.state().error?.signal).toBe('timeout');
  });

  it('the timeout falls back for an automatic Scramjet navigation', () => {
    const { tab, of, clock, fallbacks } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    clock.advance(TIMEOUTS.navigationMs);
    expect(of('tab.engineSwitched')[0]?.reason).toBe('timeout');
    expect(fallbacks).toHaveLength(1);
  });

  it('only one fallback until the next user navigation', () => {
    const { tab, fallbacks } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.fail('error-hook', 'x');
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true, auto: true, navId: 1 });
    tab.commitDocument(A, 'ultraviolet');
    // An in-page navigation does not reset the counter …
    tab.beginGnome({ url: B, engine: 'scramjet', kind: 'history', targetIndex: 0, forced: false });
    tab.fail('error-hook', 'y');
    expect(fallbacks).toHaveLength(1);
    // … a user navigation does.
    tab.beginGnome({ url: C, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.fail('error-hook', 'z');
    expect(fallbacks).toHaveLength(2);
  });

  it('a gateway problem is reported as gateway, offline as offline', () => {
    const a = setup({ transportOffline: () => true });
    a.tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true });
    a.tab.fail('error-hook', 'Failed to fetch');
    expect(a.of('tab.error')[0]?.kind).toBe('gateway');
    const b = setup({ online: () => false });
    b.tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true });
    b.tab.fail('error-hook', 'Failed to fetch');
    expect(b.of('tab.error')[0]?.kind).toBe('offline');
  });

  it('the substitute page of a failed navigation does not commit', () => {
    const { tab, of } = setup({ ready: { ultraviolet: false } });
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.fail('error-hook', 'boom');
    tab.commitDocument(A, 'scramjet');
    tab.documentLoaded(A, 'scramjet');
    expect(of('tab.committed')).toHaveLength(0);
    expect(of('tab.loaded')).toHaveLength(0);
    expect(of('tab.error')[0]?.fallback).toBe('none');
  });

  it('a frame that left the proxy is a final engine error, also without a pending navigation', () => {
    const { tab, of, fallbacks } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'scramjet');
    tab.documentLoaded(A, 'scramjet');
    tab.frameLeftProxy();
    expect(of('tab.error')[0]).toMatchObject({ signal: 'frame-left-proxy', kind: 'engine', fallback: 'none' });
    expect(fallbacks).toHaveLength(0);
  });

  it('an in-page UV error page without a start signal still becomes tab.error', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true });
    tab.commitDocument(A, 'ultraviolet');
    tab.documentLoaded(A, 'ultraviolet');
    tab.uvErrorPage('Error: something', null);
    expect(of('tab.error')[0]).toMatchObject({ signal: 'uv-error-page', engine: 'ultraviolet', fallback: 'available' });
  });
});

describe('TabNavigator: 204, stop, the UV in-page timeout rule, downloads', () => {
  it('a 204 ends the navigation without commit or error', () => {
    const { tab, of, events } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(A, 'scramjet');
    tab.documentLoaded(A, 'scramjet');
    tab.beginPage({ url: B, engine: 'scramjet' });
    tab.responseStatus(204);
    expect(events.slice(-1)[0]).toEqual({ type: 'tab.loading', p: { tabId: 7, loading: false } });
    expect(of('tab.committed')).toHaveLength(1);
    expect(of('tab.error')).toHaveLength(0);
    expect(tab.state().loading).toBe(false);
  });

  it('an in-page UV navigation whose document stays ends quietly at the timer', () => {
    const { tab, of, clock } = setup({ unchanged: true });
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true });
    tab.commitDocument(A, 'ultraviolet');
    tab.documentLoaded(A, 'ultraviolet');
    tab.beginPage({ url: B, engine: 'ultraviolet', type: 'push' });
    clock.advance(TIMEOUTS.navigationMs);
    expect(of('tab.error')).toHaveLength(0);
    expect(of('tab.loading').at(-1)?.loading).toBe(false);
  });

  it('a GNOME-initiated UV navigation still times out', () => {
    const { tab, of, clock } = setup({ unchanged: true });
    tab.beginGnome({ url: A, engine: 'ultraviolet', kind: 'navigate', forced: true });
    clock.advance(TIMEOUTS.navigationMs);
    expect(of('tab.error')[0]?.signal).toBe('timeout');
  });

  it('an attachment ends the navigation at once: no timeout, no fallback, no tab.loaded', () => {
    const { tab, of, clock, fallbacks } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    expect(tab.downloadResponse('attachment')).toBe(true);
    clock.advance(TIMEOUTS.navigationMs * 2);
    expect(of('tab.loading').at(-1)?.loading).toBe(false);
    expect(of('tab.error')).toHaveLength(0);
    expect(of('tab.loaded')).toHaveLength(0);
    expect(fallbacks).toHaveLength(0);
  });

  it('an unrendered type becomes a download after downloadCommitMs without a commit', () => {
    const { tab, clock, downloads, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.downloadResponse('unrendered-type');
    clock.advance(TIMEOUTS.downloadCommitMs - 1);
    expect(downloads.confirmed).toHaveLength(0);
    clock.advance(1);
    expect(downloads.confirmed).toHaveLength(1);
    expect(of('tab.loading').at(-1)?.loading).toBe(false);
    clock.advance(TIMEOUTS.navigationMs);
    expect(of('tab.error')).toHaveLength(0);
  });

  it('an unrendered type that commits after all is a page', () => {
    const { tab, clock, downloads, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.downloadResponse('unrendered-type');
    tab.documentLoaded(A, 'scramjet');
    clock.advance(TIMEOUTS.downloadCommitMs);
    expect(downloads.confirmed).toHaveLength(0);
    expect(downloads.cancelled).toHaveLength(1);
    expect(of('tab.loaded')).toHaveLength(1);
  });

  it('tab.stop ends the navigation; the timer is cleared', () => {
    const { tab, of, clock } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.stop();
    clock.advance(TIMEOUTS.navigationMs);
    expect(of('tab.error')).toHaveLength(0);
    expect(of('tab.loading').at(-1)?.loading).toBe(false);
    expect(clock.pending).toBe(0);
  });
});

describe('TabNavigator: URL fitting', () => {
  it('reports an over-long URL as origin + path and keeps the full one', () => {
    const { tab, of } = setup();
    const long = `https://a.example/p?q=${'x'.repeat(9000)}`;
    tab.beginGnome({ url: long, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.commitDocument(long, 'scramjet');
    expect(of('tab.committed')[0]?.url).toBe('https://a.example/p');
    expect(tab.history.current).toBe(long);
    expect(tab.state().entries).toEqual(['https://a.example/p']);
  });
});

describe('TabNavigator: content-blocker additions (WAVE-B3 C3, §4.4)', () => {
  it('announces GNOME-initiated loads with their url, at most 2 per second per tab', () => {
    const announced: string[] = [];
    const { tab, of, clock } = setup({ announced: (u: string) => void announced.push(u) });
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    expect(of('tab.loading').at(-1)).toEqual({ tabId: 7, loading: true, url: A });
    expect(tab.announce('https://b.example/')).toBe(true);
    expect(tab.announce('https://c.example/')).toBe(false);
    expect(of('tab.loading').filter((e) => 'url' in e)).toHaveLength(2);
    clock.advance(1001);
    expect(tab.announce('https://c.example/')).toBe(true);
    expect(announced).toEqual([A, 'https://b.example/', 'https://c.example/']);
    expect(tab.announce('javascript:alert(1)')).toBe(false);
  });

  it('a blocked navigation reports fallback none and the detail as given', () => {
    const { tab, of } = setup();
    tab.beginGnome({ url: A, engine: 'scramjet', kind: 'navigate', forced: false });
    tab.fail('blocked', 'blocked:ads');
    expect(of('tab.error').at(-1)).toMatchObject({ kind: 'blocked', fallback: 'none', detail: 'blocked:ads' });
  });
});
