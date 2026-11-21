// The service worker's half (WAVE-B3 §4.5, D15) with fake engines and timers: engine-host registration (F3), the
// client map, referrer lookups that never create a context, workers inheriting, navs consumption and drop, the waits,
// the multi-host union, ready() with one deadline per start, the most recent engines in force, uv-blocked batching.
import { describe, expect, it } from 'vitest';
import type { BlockerGroup } from '../../shared/engine-protocol';
import type { SwSignal } from '../../shared/proxy-origin';
import type { RequestInfo } from '../../shared/engine-hooks';
import { SW_FALLBACK_SETTINGS } from '../core/policy';
import type { BlockerSettings } from '../core/policy';
import { startSwBlocker } from './blocker';
import type { SwEngineSet } from './blocker';


const P = 'https://p.example/uv/service/';
const prox = (real: string) => `${P}${encodeURIComponent(real)}`;
const decode = (u: string) => (u.startsWith(P) ? decodeURIComponent(u.slice(P.length).split('#')[0] ?? '') : null);

function fakeEngines(blockHost = 'ads.localhost'): SwEngineSet & { loads: string[] } {
  let setId: string | null = null;
  const loads: string[] = [];
  return {
    loads,
    get setId() {
      return setId;
    },
    load(id: string, groups: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>) {
      if (groups.some((g) => g.bytes.byteLength === 1)) throw new Error('bad bytes');
      setId = id;
      loads.push(id);
    },
    ready: () => setId !== null,
    match: (group, url, source, type) => (group === 'ads' && new URL(url).hostname === blockHost ? { match: !(source.includes(blockHost)) || type === 'main_frame' ? true : false } : { match: false }),
    rewriteParams: () => null,
  };
}

function setup() {
  const timers: Array<{ fn: () => void; at: number; done: boolean }> = [];
  let t = 0;
  const signals: SwSignal[] = [];
  const engines = fakeEngines();
  const b = startSwBlocker({
    signal: (m) => void signals.push(m),
    decode,
    log: () => undefined,
    engines,
    now: () => t,
    setTimeout: (fn, ms) => timers.push({ fn, at: t + ms, done: false }),
  });
  const advance = async (ms: number) => {
    t += ms;
    for (const x of timers) if (!x.done && x.at <= t) {
      x.done = true;
      x.fn();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  const settings = (over: Partial<BlockerSettings['extensions']> = {}): BlockerSettings => ({ privacy: SW_FALLBACK_SETTINGS.privacy, extensions: { ...SW_FALLBACK_SETTINGS.extensions, lists: [{ id: 'l', sha256: 'a'.repeat(64), category: 'ads', format: 'abp', trusted: false }], ...over } });
  return { b, signals, engines, advance, settings, timers, setT: (v: number) => (t = v) };
}

const nav = (url: string, referrer = '') => ({ url, mode: 'navigate', destination: 'iframe', referrer });
const sub = (url: string, referrer = '') => ({ url, mode: 'no-cors', destination: 'script', referrer });

describe('EngineHostRegistry (F3)', () => {
  it('registers navigations to /engine/, refuses proxied clients even with an /engine/ URL, accepts provisional ones', async () => {
    const { EngineHostRegistry: R } = await import('./hosts');
    const r = new R();
    r.navigation('host-1', '/engine/', '/engine/', false);
    expect(r.accept('host-1', false)).toBe(true);
    r.navigation('page-1', '/uv/service/x', '/engine/', true);
    expect(r.accept('page-1', true)).toBe(false); // pushState to /engine/ from a proxied page
    r.markProxied('worker-1');
    expect(r.accept('worker-1', true)).toBe(false);
    expect(r.accept('old-host', true)).toBe(true); // loaded before this SW: by URL, never seen as proxied
    expect(r.isHost('old-host')).toBe(true);
    expect(r.accept('random', false)).toBe(false);
    r.markProxied('old-host');
    expect(r.isHost('old-host')).toBe(false);
    expect(r.accept('', true)).toBe(false);
  });
});

describe('startSwBlocker', () => {
  it('ready() resolves at the first config or once at 300 ms after the start; never per request', async () => {
    const s = setup();
    let ready = false;
    void s.b.ready().then(() => (ready = true));
    await s.advance(299);
    expect(ready).toBe(false);
    await s.advance(1);
    expect(ready).toBe(true);
    const s2 = setup();
    let r2 = false;
    void s2.b.ready().then(() => (r2 = true));
    s2.b.onConfig('h1', s2.settings(), null);
    await s2.advance(0);
    expect(r2).toBe(true);
  });

  it('applies the fallback settings until a host configured it; blocks once engines arrive; the most recent engines win', async () => {
    const s = setup();
    const info = (url: string): RequestInfo => ({ engine: 'ultraviolet', tabId: null, url, method: 'GET', destination: 'script', topLevelUrl: 'http://site-a.localhost/', isTopLevelDocument: false, documentUrl: 'http://site-a.localhost/', referrer: null });
    expect(s.b.hooks.onRequest(info('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
    s.b.onEngines('h1', { type: 'gnome-blocker-engines', setId: 'a'.repeat(64), groups: [{ group: 'ads', bytes: new ArrayBuffer(4) }] });
    expect(s.b.hooks.onRequest(info('http://ads.localhost/a.js'))).toEqual({ action: 'block', category: 'ads' });
    s.b.onEngines('h2', { type: 'gnome-blocker-engines', setId: 'b'.repeat(64), groups: [{ group: 'ads', bytes: new ArrayBuffer(4) }] });
    s.b.onEngines('h2', { type: 'gnome-blocker-engines', setId: 'c'.repeat(64), groups: [{ group: 'ads', bytes: new ArrayBuffer(1) }] }); // does not load
    expect(s.engines.setId).toBe('b'.repeat(64));
    // the union of the hosts' scoped allowlists
    s.b.onConfig('h1', s.settings({ allowlist: ['*.site-a.localhost'] }), null);
    s.b.onConfig('h2', s.settings({ allowlist: [] }), null);
    expect(s.b.hooks.onRequest(info('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
    s.b.forgetHost('h1');
    expect(s.b.hooks.onRequest(info('http://ads.localhost/a.js'))).toEqual({ action: 'block', category: 'ads' });
  });

  it('a GNOME load without a referrer waits ≤ 50 ms for its late navs entry', async () => {
    const s = setup();
    s.b.onConfig('h1', s.settings(), null);
    const url = prox('http://docblock.localhost/');
    let ctx: { isTopLevelDocument: boolean } | null = null;
    void s.b.context({ clientId: '' }, nav(url)).then((c) => (ctx = c));
    await s.advance(10);
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [url], drop: [], reset: false });
    s.b.onConfig('h1', s.settings(), null);
    await s.advance(0);
    await s.advance(0);
    expect(ctx).toMatchObject({ isTopLevelDocument: true });
  });

  it('a navigation the engine host announced is a tab-top document; it waits ≤ 150 ms for a config sent after it', async () => {
    const s = setup();
    s.b.onConfig('h1', s.settings(), null);
    const url = prox('http://site-a.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [url], drop: [], reset: false });
    let ctx: unknown = null;
    void s.b.context({ clientId: '' }, nav(url)).then((c) => (ctx = c));
    await s.advance(10);
    expect(ctx).toBeNull(); // waiting for the config that answers the announcement
    s.b.onConfig('h1', s.settings({ allowlist: ['*.site-a.localhost'] }), null);
    await s.advance(0);
    expect(ctx).toEqual({ documentUrl: 'http://site-a.localhost/', topLevelUrl: 'http://site-a.localhost/', isTopLevelDocument: true, documentProxied: url, navHost: 'h1' });
    // consumed: a second navigation to the same URL (a frame of another page) is not taken for a tab-top document
    const again = s.b.context({ clientId: '' }, nav(url));
    await s.advance(50);
    expect((await again).isTopLevelDocument).toBe(false);
    // a dropped navigation is no longer announced
    const other = prox('http://site-b.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [other], drop: [], reset: false });
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [], drop: [other], reset: false });
    // (a navigation without a referrer waits ≤ 50 ms for a late navs entry: GNOME's own loads race their message)
    const p2 = s.b.context({ clientId: '' }, nav(other));
    await s.advance(50);
    const c2 = await p2;
    expect(c2.isTopLevelDocument).toBe(false);
    // and an announcement expires after 30 s
    const third = prox('http://site-c.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [third], drop: [], reset: false });
    await s.advance(30_001);
    const p3 = s.b.context({ clientId: '' }, nav(third));
    await s.advance(50);
    expect((await p3).isTopLevelDocument).toBe(false);
  });

  it('every redirect hop of a tab-top navigation is the tab’s own document (D3), counted under the announced URL', async () => {
    const s = setup();
    s.b.onConfig('h1', s.settings(), null);
    // site-b's tab-top document is recorded; its link to site-a was announced
    const pageB = prox('http://site-b.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [[pageB, 'http://site-b.localhost/']], navs: [], drop: [], reset: false });
    const first = prox('http://site-a.localhost/set-cookie');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [first], drop: [], reset: false });
    s.b.onConfig('h1', s.settings(), null);
    const withRef = (u: string) => ({ url: u, mode: 'navigate', destination: 'iframe', referrer: pageB });
    const c1 = await s.b.context({ clientId: '' }, withRef(first));
    expect(c1).toMatchObject({ isTopLevelDocument: true, topLevelUrl: 'http://site-a.localhost/set-cookie', documentProxied: first });
    // the 302 hop (the browser keeps site-b's referrer): without the redirect record it would be a frame of site-b
    const hop = prox('http://site-a.localhost/cookies');
    const unrecorded = s.b.context({ clientId: '' }, withRef(hop));
    await s.advance(20);
    expect((await unrecorded).topLevelUrl).toBe('http://site-b.localhost/');
    s.b.redirected(c1, hop);
    const c2 = await s.b.context({ clientId: '' }, withRef(hop));
    expect(c2).toMatchObject({ isTopLevelDocument: true, topLevelUrl: 'http://site-a.localhost/cookies', documentUrl: 'http://site-a.localhost/cookies', documentProxied: first, navHost: 'h1' });
    // a subresource or frame context is never turned into a redirect hop, and a non-UV location is ignored
    s.b.redirected({ ...c2, isTopLevelDocument: false }, prox('http://site-c.localhost/'));
    s.b.redirected(c2, 'https://elsewhere.example/');
    const c3 = s.b.context({ clientId: '' }, withRef(prox('http://site-c.localhost/')));
    await s.advance(20);
    expect((await c3).isTopLevelDocument).toBe(false);
  });

  it('subresources get their client’s document and top; a referrer only looks up, never creates; workers inherit', async () => {
    const s = setup();
    s.b.onConfig('h1', s.settings(), null);
    const top = prox('http://site-a.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [[top, 'http://site-a.localhost/']], navs: [], drop: [], reset: false });
    s.b.onClient('c-top', top, null, null);
    expect(await s.b.context({ clientId: 'c-top' }, sub('http://ads.localhost/a.js'))).toEqual({
      documentUrl: 'http://site-a.localhost/',
      topLevelUrl: 'http://site-a.localhost/',
      isTopLevelDocument: false,
      documentProxied: top,
    });
    // a frame of site-b inside it: its top is site-a's (the referrer names a recorded document)
    const frame = prox('http://site-b.localhost/f');
    s.b.onClient('c-frame', frame, null, top);
    const fc = await s.b.context({ clientId: 'c-frame' }, sub('http://ads.localhost/a.js'));
    expect(fc).toMatchObject({ documentUrl: 'http://site-b.localhost/f', topLevelUrl: 'http://site-a.localhost/' });
    // a worker of that frame inherits its context
    s.b.onClient('c-worker', prox('http://site-b.localhost/w.js'), 'c-frame', null);
    expect((await s.b.context({ clientId: 'c-worker' }, sub('http://ads.localhost/b.js'))).topLevelUrl).toBe('http://site-a.localhost/');
    // a referrer naming a document the SW never recorded creates nothing: unknown after ≤ 50 ms
    s.b.onClient('c-forged', prox('http://evil.localhost/'), null, prox('http://bank.localhost/'));
    let unknown: unknown = null;
    void s.b.context({ clientId: 'c-forged' }, sub('http://ads.localhost/a.js', prox('http://site-a.localhost/'))).then((c) => (unknown = c));
    await s.advance(49);
    expect(unknown).toBeNull();
    await s.advance(1);
    expect(unknown).toMatchObject({ topLevelUrl: null, isTopLevelDocument: false });
    // a client the SW never saw: the same, the global settings as third-party
    const never = await (async () => {
      const p = s.b.context({ clientId: 'nobody' }, sub('http://ads.localhost/a.js'));
      await s.advance(50);
      return p;
    })();
    expect(never).toEqual({ documentUrl: null, topLevelUrl: null, isTopLevelDocument: false, documentProxied: null });
  });

  it('a link of a tab-top document waits ≤ 20 ms for its announcement', async () => {
    const s = setup();
    s.b.onConfig('h1', s.settings(), null);
    const top = prox('http://site-b.localhost/');
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [[top, 'http://site-b.localhost/']], navs: [top], drop: [], reset: false });
    s.b.onClient('c-top', top, null, null);
    const dest = prox('http://site-a.localhost/');
    let ctx: { isTopLevelDocument: boolean } | null = null;
    void s.b.context({ clientId: '' }, nav(dest, top)).then((c) => (ctx = c));
    await s.advance(5);
    s.b.onContext('h1', { type: 'gnome-blocker-context', docs: [], navs: [dest], drop: [], reset: false });
    s.b.onConfig('h1', s.settings(), null);
    await s.advance(0);
    await s.advance(0);
    expect(ctx).toMatchObject({ isTopLevelDocument: true });
  });

  it('batches uv-blocked per document, at most one message per 250 ms', async () => {
    const s = setup();
    s.b.counted('doc-1', 'ads');
    s.b.counted('doc-1', 'ads');
    s.b.counted('doc-1', 'trackers');
    s.b.counted('doc-2', 'security');
    s.b.counted(null, 'ads');
    expect(s.signals).toEqual([]);
    await s.advance(250);
    expect(s.signals).toEqual([
      { type: 'uv-blocked', documentUrl: 'doc-1', counts: { ads: 2, trackers: 1 } },
      { type: 'uv-blocked', documentUrl: 'doc-2', counts: { security: 1 } },
    ]);
  });

  it('counts a blocked URL once per document (Firefox re-requests a refused preloaded image); a navigation to the document starts again', async () => {
    const s = setup();
    const doc = prox('http://site-a.localhost/counts.html');
    s.b.counted(doc, 'ads', 'http://ads.localhost/1');
    s.b.counted(doc, 'ads', 'http://ads.localhost/1');
    s.b.counted(doc, 'ads', 'http://ads.localhost/2');
    s.b.counted(doc, 'trackers', 'http://ads.localhost/1'); // another category of the same URL is another block
    s.b.counted(prox('http://site-b.localhost/'), 'ads', 'http://ads.localhost/1'); // another document
    await s.advance(250);
    expect(s.signals).toEqual([
      { type: 'uv-blocked', documentUrl: doc, counts: { ads: 2, trackers: 1 } },
      { type: 'uv-blocked', documentUrl: prox('http://site-b.localhost/'), counts: { ads: 1 } },
    ]);
    // the same URL again in the same document: nothing
    s.b.counted(doc, 'ads', 'http://ads.localhost/1');
    await s.advance(250);
    expect(s.signals).toHaveLength(2);
    // a reload of the document (its navigation fetch records its client): its blocks count again
    s.b.onClient('c-reload', doc, null, null);
    s.b.counted(doc, 'ads', 'http://ads.localhost/1');
    await s.advance(250);
    expect(s.signals.at(-1)).toEqual({ type: 'uv-blocked', documentUrl: doc, counts: { ads: 1 } });
  });

  it('the composite counts each block of a request under its document, keyed by the request URL', async () => {
    const s = setup();
    s.b.onConfig('host-1', s.settings(), 'a'.repeat(64));
    s.engines.load('a'.repeat(64), [{ group: 'ads', bytes: new ArrayBuffer(8) }]);
    const doc = prox('http://site-a.localhost/');
    const info = (): RequestInfo => ({ engine: 'ultraviolet', tabId: null, url: 'http://ads.localhost/x.png', method: 'GET', destination: 'image', topLevelUrl: 'http://site-a.localhost/', isTopLevelDocument: false, documentUrl: 'http://site-a.localhost/', referrer: null });
    for (let i = 0; i < 2; i++) {
      const r = info();
      s.b.attach(r, doc);
      expect(s.b.hooks.onRequest(r)).toEqual({ action: 'block', category: 'ads' });
    }
    await s.advance(250);
    expect(s.signals).toEqual([{ type: 'uv-blocked', documentUrl: doc, counts: { ads: 1 } }]);
  });
});
