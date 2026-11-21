import { describe, expect, it } from 'vitest';
import { LIMITS } from '../shared/engine-protocol';
import { MAX_CLOSED_TABS, parseSession, TabModel } from './tabs.svelte';

const u = (n: number | string): string => `https://example.com/${n}`;

describe('TabModel', () => {
  it('creates tabs up to LIMITS.maxTabs and refuses more', () => {
    const m = new TabModel();
    for (let i = 0; i < LIMITS.maxTabs; i++) expect(m.create({ url: u(i) })).not.toBeNull();
    expect(m.create({ url: u('x') })).toBeNull();
    expect(m.tabs).toHaveLength(LIMITS.maxTabs);
  });

  it('opens tabs from a page next to their opener, keeps pinned tabs first', () => {
    const m = new TabModel();
    const a = m.create({ url: u('a') })!;
    const b = m.create({ url: u('b') })!;
    const c1 = m.create({ url: u('c1'), after: a.id, openerId: a.id })!;
    const c2 = m.create({ url: u('c2'), after: a.id, openerId: a.id })!;
    expect(m.tabs.map((t) => t.id)).toEqual([a.id, c1.id, c2.id, b.id]);
    m.setPinned(b.id, true);
    expect(m.tabs[0]!.id).toBe(b.id);
    m.move(b.id, 3);
    expect(m.tabs[0]!.id).toBe(b.id);
    m.move(a.id, 0);
    expect(m.tabs[0]!.id).toBe(b.id);
  });

  it('activates by closeTabActivates and returns to the opener', () => {
    const m = new TabModel();
    const a = m.create({ url: u('a') })!;
    const b = m.create({ url: u('b') })!;
    const c = m.create({ url: u('c') })!;
    m.activate(b.id, 10);
    m.close(b.id, 'right', 20);
    expect(m.activeId).toBe(c.id);
    const d = m.create({ url: u('d'), after: a.id, openerId: a.id, activate: true, now: 30 })!;
    m.close(d.id, 'right', 40);
    expect(m.activeId).toBe(a.id);
    m.activate(c.id, 50);
    m.activate(a.id, 60);
    m.close(a.id, 'last-used', 70);
    expect(m.activeId).toBe(c.id);
  });

  it('keeps a bounded closed-tab stack with entries', () => {
    const m = new TabModel();
    for (let i = 0; i < MAX_CLOSED_TABS + 5; i++) {
      const t = m.create({ url: u(i) })!;
      m.applyCommit(t.id, { url: u(`${i}b`), historyHandling: 'push', index: 1, length: 2, canGoBack: true, canGoForward: false });
      m.close(t.id);
    }
    expect(m.closed).toHaveLength(MAX_CLOSED_TABS);
    const last = m.popClosed()!;
    expect(last.entries).toEqual([u(MAX_CLOSED_TABS + 4), u(`${MAX_CLOSED_TABS + 4}b`)]);
    expect(last.index).toBe(1);
  });

  describe('entries copy (ENGINE-PROTOCOL §6.1)', () => {
    it('push drops forward entries and the oldest beyond length; replace and traverse', () => {
      const m = new TabModel();
      const t = m.create({ url: null })!;
      const commit = (url: string, historyHandling: 'push' | 'replace' | 'traverse', index: number, length: number) =>
        m.applyCommit(t.id, { url, historyHandling, index, length, canGoBack: index > 0, canGoForward: index < length - 1 });
      expect(commit(u(1), 'push', 0, 1)).toBe('ok');
      expect(commit(u(2), 'push', 1, 2)).toBe('ok');
      expect(commit(u(3), 'push', 2, 3)).toBe('ok');
      expect(commit(u(1), 'traverse', 0, 3)).toBe('ok');
      expect(m.get(t.id)!.canGoForward).toBe(true);
      expect(commit(u(4), 'push', 1, 2)).toBe('ok');
      expect(m.get(t.id)!.entries).toEqual([u(1), u(4)]);
      expect(commit(u('4#x'), 'replace', 1, 2)).toBe('ok');
      expect(m.get(t.id)!.entries).toEqual([u(1), u('4#x')]);
      expect(m.get(t.id)!.url).toBe(u('4#x'));
    });

    it('drops the oldest entry at the 50-entry cap', () => {
      const m = new TabModel();
      const t = m.create({ url: null })!;
      for (let i = 0; i < LIMITS.maxTabHistory + 3; i++) {
        const len = Math.min(i + 1, LIMITS.maxTabHistory);
        expect(m.applyCommit(t.id, { url: u(i), historyHandling: 'push', index: len - 1, length: len, canGoBack: len > 1, canGoForward: false })).toBe('ok');
      }
      expect(m.get(t.id)!.entries).toHaveLength(LIMITS.maxTabHistory);
      expect(m.get(t.id)!.entries[0]).toBe(u(3));
    });

    it('asks for a resync when an event was lost, then takes the engine host list', () => {
      const m = new TabModel();
      const t = m.create({ url: null })!;
      m.applyCommit(t.id, { url: u(1), historyHandling: 'push', index: 0, length: 1, canGoBack: false, canGoForward: false });
      // The commit of u(2) was dropped by the rate limits.
      expect(m.applyCommit(t.id, { url: u(3), historyHandling: 'push', index: 2, length: 3, canGoBack: true, canGoForward: false })).toBe('resync');
      m.applyState(t.id, { entries: [u(1), u(2), u(3)], index: 2, title: 'Three', loading: false, navId: 3, engine: 'scramjet', error: null });
      expect(m.get(t.id)!.entries).toEqual([u(1), u(2), u(3)]);
      expect(m.get(t.id)!.title).toBe('Three');
    });
  });

  describe('discard policy', () => {
    const policy = { memorySaver: false, discardAfterMinutes: 30, backgroundTabs: 'keep-alive' as const };

    it('keeps at most LIMITS.liveTabsSoftCap live tabs, discarding the least recently used background ones', () => {
      const m = new TabModel();
      for (let i = 0; i < LIMITS.liveTabsSoftCap + 3; i++) {
        const t = m.create({ url: u(i), activate: true, now: 1000 + i })!;
        t.live = true;
      }
      const ids = m.discardCandidates(policy, 5000);
      expect(ids).toEqual(m.tabs.slice(0, 3).map((t) => t.id));
      expect(ids).not.toContain(m.activeId);
    });

    it('never discards the active, a pinned, a loading or a fullscreen tab; memory saver and background discard', () => {
      const m = new TabModel();
      const [a, b, c, d, e] = [0, 1, 2, 3, 4].map((i) => m.create({ url: u(i), now: 0 })!);
      for (const t of m.tabs) t.live = true;
      m.setPinned(b!.id, true);
      m.get(c!.id)!.loading = true;
      m.get(d!.id)!.fullscreen = true;
      m.activate(a!.id, 0);
      expect(m.discardCandidates({ ...policy, memorySaver: true, discardAfterMinutes: 1 }, 30_000)).toEqual([]);
      expect(m.discardCandidates({ ...policy, memorySaver: true, discardAfterMinutes: 1 }, 61_000)).toEqual([e!.id]);
      expect(m.discardCandidates({ ...policy, backgroundTabs: 'discard' }, 1)).toEqual([e!.id]);
    });
  });

  it('round-trips a session snapshot and treats stored input as untrusted', () => {
    const m = new TabModel();
    const a = m.create({ url: u('a') })!;
    m.applyCommit(a.id, { url: u('a2'), historyHandling: 'push', index: 1, length: 2, canGoBack: true, canGoForward: false });
    m.create({ url: null });
    const snap = m.snapshot(5);
    const norm = (s: string): string | null => (s.startsWith('https://') ? s : null);
    expect(parseSession(JSON.parse(JSON.stringify(snap)), norm)).toEqual(snap);
    const hostile = { version: 1, tabs: [{ url: 'javascript:alert(1)', entries: ['javascript:x', u('ok')], index: 9, title: 7 }, null, 'x'], active: 99 };
    expect(parseSession(hostile, norm)).toEqual({ version: 1, tabs: [{ url: u('ok'), title: '', entries: [u('ok')], index: 0, pinned: false }], active: 0, savedAt: 0 });
    expect(parseSession({ version: 2 }, norm)).toBeNull();
  });
});
