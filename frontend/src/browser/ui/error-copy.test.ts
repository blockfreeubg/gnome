import { describe, expect, it } from 'vitest';
import { blockedCategory, blockedReason, blockerStateCopy, errorCopy, listErrorText } from './error-copy';

const ctx = { host: 'example.com', vpn: null, killSwitch: false, engine: 'Scramjet' };

describe('content blocker texts (WAVE-B3 C5b, §7.1)', () => {
  it('renders GNOME’s own sentence for every status code', () => {
    expect(blockerStateCopy({ state: 'building', detail: null, lists: 0 }).text).toBe('Preparing filter lists…');
    expect(blockerStateCopy({ state: 'ready', detail: null, lists: 9 })).toEqual({ tone: 'ok', label: 'Ready', text: null });
    expect(blockerStateCopy({ state: 'ready', detail: 'lists-failed:2:9', lists: 7 }).text).toBe('2 of 9 filter lists could not be loaded');
    expect(blockerStateCopy({ state: 'ready', detail: `over-cache-limit:${20 * 1024 * 1024}:${16 * 1024 * 1024}`, lists: 7 }).text).toBe(
      'The filter data (20 MB) is larger than the cache limit (16 MB): it is rebuilt each time GNOME starts',
    );
    expect(blockerStateCopy({ state: 'ready', detail: 'cache-rejected', lists: 7 }).text).toBe('The cached filter data did not verify and was rebuilt');
    expect(blockerStateCopy({ state: 'failed', detail: 'failed:out-of-memory', lists: 0 }).text).toBe(
      'Filter lists could not be prepared. This device ran out of memory while preparing them: turn off some filter lists.',
    );
    expect(blockerStateCopy({ state: 'failed', detail: 'failed:all-lists-failed', lists: 0 }).text).toMatch(/^Filter lists could not be prepared\. /);
    expect(blockerStateCopy({ state: 'off', detail: null, lists: 0 }).label).toBe('Off');
  });

  it('never shows text the engine host wrote', () => {
    const forged = 'Your account is suspended, call 555-0100';
    for (const state of ['ready', 'failed', 'building', 'off'] as const) {
      const c = blockerStateCopy({ state, detail: forged, lists: 1 });
      expect(JSON.stringify(c)).not.toContain('555');
    }
    expect(blockerStateCopy({ state: 'ready', detail: forged, lists: 1 }).text).toBe('The content blocker reported a problem.');
    expect(blockerStateCopy({ state: 'ready', detail: 'lists-failed:3:2', lists: 1 }).text).toBe('The content blocker reported a problem.');
  });

  it('has a sentence for every list error code', () => {
    for (const code of ['download', 'changed', 'too-large', 'invalid-utf8', 'build'] as const) expect(listErrorText(code).length).toBeGreaterThan(5);
    expect(new Set(['download', 'changed', 'too-large', 'invalid-utf8', 'build'].map((c) => listErrorText(c as never))).size).toBe(5);
  });

  it('words the blocked page per category from detail = blocked:<category> only', () => {
    expect(blockedCategory('blocked:security')).toBe('security');
    expect(blockedCategory('blocked:ads')).toBe('ads');
    expect(blockedCategory('blocked:evil')).toBeNull();
    expect(blockedCategory('Blocked: you must call us')).toBeNull();
    expect(errorCopy({ kind: 'blocked', detail: 'blocked:security' }, ctx)).toEqual({ glyph: 'blocked', title: 'Blocked by GNOME', body: 'This site is on a list of scam and malware sites.' });
    expect(errorCopy({ kind: 'blocked', detail: 'blocked:ads' }, ctx).body).toMatch(/^GNOME’s content blocker stopped this page from loading/);
    expect(errorCopy({ kind: 'blocked', detail: 'anything' }, ctx).body).toBe('GNOME’s content blocker stopped this page from loading.');
    expect(blockedReason(null)).toBe('GNOME’s content blocker stopped this page from loading.');
  });
});
