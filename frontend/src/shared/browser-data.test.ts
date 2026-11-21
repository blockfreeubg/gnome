import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, safeVerdict, type RequestInfo } from './engine-hooks';
import { BOOKMARK_ROOT, LIBRARY_LIMITS, VisitGate, library, onLibrary, provideLibrary, shouldRecordVisit, type BrowserLibrary } from './browser-data';

describe('history recording rule', () => {
  it('records cross-document navigations and same-document pushes beyond the fragment only', () => {
    expect(shouldRecordVisit('navigate', 'push', 'https://a.example/', 'https://a.example/')).toBe(true);
    expect(shouldRecordVisit('navigate', 'replace', 'https://a.example/', 'https://b.example/')).toBe(true);
    expect(shouldRecordVisit('same-document', 'push', 'https://a.example/x', 'https://a.example/y')).toBe(true);
    expect(shouldRecordVisit('same-document', 'push', 'https://a.example/x?q=1', 'https://a.example/x?q=2')).toBe(true);
    expect(shouldRecordVisit('same-document', 'push', 'https://a.example/x', 'https://a.example/x#part')).toBe(false);
    expect(shouldRecordVisit('same-document', 'push', 'https://a.example/x#a', 'https://a.example/x#b')).toBe(false);
    expect(shouldRecordVisit('same-document', 'push', null, 'https://a.example/x')).toBe(true);
    expect(shouldRecordVisit('same-document', 'replace', 'https://a.example/map?z=1', 'https://a.example/map?z=2')).toBe(false);
    expect(shouldRecordVisit('same-document', 'traverse', 'https://a.example/y', 'https://a.example/x')).toBe(false);
    expect(shouldRecordVisit('reload', 'replace', 'https://a.example/', 'https://a.example/')).toBe(false);
    expect(shouldRecordVisit('history', 'traverse', 'https://a.example/', 'https://b.example/')).toBe(false);
  });

  it('caps the visits engine events can write, per tab and overall, and skips repeats', () => {
    const gate = new VisitGate();
    const nav = (url: string) => ({ kind: 'navigate' as const, historyHandling: 'push' as const, url });
    expect(gate.decide('tab:1', nav('https://a.example/'), null, 0)).toBe('record');
    expect(gate.decide('tab:1', nav('https://a.example/'), 'https://a.example/', 1000)).toBe('skip');
    expect(gate.decide('tab:1', nav('https://a.example/'), 'https://a.example/', LIBRARY_LIMITS.repeatVisitMs + 1)).toBe('record');
    expect(gate.decide('tab:1', { kind: 'reload', historyHandling: 'replace', url: 'https://a.example/' }, null, 2000)).toBe('skip');
    const flood = new VisitGate();
    let recorded = 0;
    for (let i = 0; i < 100; i++) if (flood.decide('tab:1', nav(`https://f.example/${i}`), null, 10_000 + i) === 'record') recorded++;
    expect(recorded).toBe(LIBRARY_LIMITS.visitsPerTabPerMinute);
    expect(flood.decide('tab:1', nav('https://f.example/late'), null, 10_000 + 60_001)).toBe('record');
    const many = new VisitGate();
    let total = 0;
    for (let tab = 0; tab < 16; tab++) for (let i = 0; i < 20; i++) if (many.decide(`tab:${tab}`, nav(`https://m.example/${tab}/${i}`), null, 5000) === 'record') total++;
    expect(total).toBe(LIBRARY_LIMITS.visitsPerMinute);
    many.forget('tab:0');
  });

  it('uses a non-null bookmark root (IndexedDB cannot index null)', () => {
    expect(BOOKMARK_ROOT).toBe('root');
  });
});

describe('library registry', () => {
  it('provides, notifies and unregisters', () => {
    const seen: Array<BrowserLibrary | null> = [];
    const off = onLibrary((l) => seen.push(l));
    const fake = { history: {}, bookmarks: {}, downloads: {} } as unknown as BrowserLibrary;
    const unregister = provideLibrary(fake);
    expect(library()).toBe(fake);
    unregister();
    expect(library()).toBeNull();
    off();
    provideLibrary(fake)();
    expect(seen).toEqual([null, fake, null]);
  });
});

describe('engine hooks', () => {
  const req: RequestInfo = {
    engine: 'scramjet',
    tabId: 1,
    url: 'https://ads.example/x.js',
    method: 'GET',
    destination: 'script',
    topLevelUrl: 'https://news.example/',
    isTopLevelDocument: false,
    documentUrl: 'https://news.example/',
    referrer: null,
  };

  it('ALLOW_ALL blocks nothing and reports the blocker off', () => {
    expect(ALLOW_ALL.onRequest(req)).toEqual({ action: 'allow' });
    expect(ALLOW_ALL.onWebSocket(req)).toBe('allow');
    expect(ALLOW_ALL.status()).toEqual({ state: 'off', lists: 0, detail: null });
  });

  it('safeVerdict fails open on throws and malformed verdicts and limits redirects to documents', () => {
    const errors: unknown[] = [];
    const hooks = (v: unknown) => ({ ...ALLOW_ALL, onRequest: () => v as never });
    expect(safeVerdict({ ...ALLOW_ALL, onRequest: () => { throw new Error('boom'); } }, req, (e) => errors.push(e))).toEqual({ action: 'allow' });
    expect(safeVerdict(hooks({ action: 'nuke' }), req, (e) => errors.push(e))).toEqual({ action: 'allow' });
    expect(safeVerdict(hooks({ action: 'redirect', url: 'https://x.example/' }), req, (e) => errors.push(e))).toEqual({ action: 'allow' });
    expect(safeVerdict(hooks({ action: 'redirect', url: 'javascript:alert(1)' }), { ...req, isTopLevelDocument: true }, (e) => errors.push(e))).toEqual({ action: 'allow' });
    expect(errors).toHaveLength(4);
    expect(safeVerdict(hooks({ action: 'redirect', url: 'https://news.example/a' }), { ...req, destination: 'document', isTopLevelDocument: true }, () => undefined)).toEqual({
      action: 'redirect',
      url: 'https://news.example/a',
    });
    expect(safeVerdict(hooks({ action: 'block', category: 'ads' }), req, () => undefined)).toEqual({ action: 'block', category: 'ads' });
    // onWebSocket callers pass destination 'websocket': never a document, so a redirect verdict for it is refused.
    const wsErrors: unknown[] = [];
    expect(safeVerdict(hooks({ action: 'redirect', url: 'https://x.example/' }), { ...req, destination: 'websocket' }, (e) => wsErrors.push(e))).toEqual({ action: 'allow' });
    expect(wsErrors).toHaveLength(1);
  });

  it('safeVerdict keeps a good $redirect resource for subresources only, drops malformed ones, and allows unknown categories (WAVE-B3 C7)', () => {
    const hooks = (v: unknown) => ({ ...ALLOW_ALL, onRequest: () => v as never });
    const resource = { contentType: 'application/javascript', body: '(function(){})();', base64: false };
    const good = { action: 'block', category: 'ads', resource };
    expect(safeVerdict(hooks(good), req, () => undefined)).toEqual(good);
    const plain = { action: 'block', category: 'ads' };
    for (const bad of [
      { ...resource, contentType: 'Text/HTML' },
      { ...resource, contentType: 'text/javascript;base64' },
      { ...resource, body: 7 },
      { ...resource, base64: 'yes' },
      { ...resource, body: 'a'.repeat(1_398_105) },
      null,
      'noop.js',
    ]) {
      expect(safeVerdict(hooks({ ...plain, resource: bad }), req, () => undefined)).toEqual(plain);
    }
    expect(safeVerdict(hooks({ ...plain, resource: { ...resource, body: 'a'.repeat(1_398_104) } }), req, () => undefined)).toMatchObject({ resource: { base64: false } });
    for (const doc of [{ isTopLevelDocument: true }, { destination: 'document' }, { destination: 'iframe' }, { destination: 'frame' }]) {
      expect(safeVerdict(hooks(good), { ...req, ...doc }, () => undefined)).toEqual(plain);
    }
    const errors: unknown[] = [];
    expect(safeVerdict(hooks({ action: 'block', category: 'malware' }), req, (e) => errors.push(e))).toEqual({ action: 'allow' });
    expect(errors).toHaveLength(1);
    expect(safeVerdict(hooks({ action: 'redirect', url: 'https://news.example/a' }), { ...req, destination: 'frame' }, () => undefined)).toEqual({
      action: 'redirect',
      url: 'https://news.example/a',
    });
  });
});
