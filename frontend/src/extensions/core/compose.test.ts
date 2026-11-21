import { describe, expect, it } from 'vitest';
import type { BlockCategory } from '../../shared/engine-protocol';
import type { RequestInfo, ResponseHeaders } from '../../shared/engine-hooks';
import { composeHooks } from './compose';
import type { HookProvider, ProviderName, RequestContext } from './compose';
import { SW_FALLBACK_SETTINGS } from './policy';
import type { BlockerSettings } from './policy';

const req = (over: Partial<RequestInfo> = {}): RequestInfo => ({
  engine: 'scramjet',
  tabId: 1,
  url: 'http://ads.localhost/ad.js',
  method: 'GET',
  destination: 'script',
  topLevelUrl: 'http://site-a.localhost/',
  isTopLevelDocument: false,
  documentUrl: 'http://site-a.localhost/',
  referrer: null,
  ...over,
});

const settings = (e: Partial<BlockerSettings['extensions']> = {}): BlockerSettings => ({
  privacy: { ...SW_FALLBACK_SETTINGS.privacy },
  extensions: { ...SW_FALLBACK_SETTINGS.extensions, ...e },
});

function harness(providers: HookProvider[]) {
  const blocks: Array<[string, BlockCategory]> = [];
  const errors: Array<[ProviderName, string, string]> = [];
  const hooks = composeHooks({
    providers,
    onBlock: (r, c) => blocks.push([r.url, c]),
    onError: (p, w, e) => errors.push([p, w, e instanceof Error ? e.message : String(e)]),
  });
  return { hooks, blocks, errors };
}

describe('composeHooks', () => {
  it('allows everything and calls no provider before configure()', () => {
    let calls = 0;
    const p: HookProvider = { name: 'network', onRequest: () => (calls++, { action: 'block', category: 'ads' }), onWebSocket: () => (calls++, 'ads') };
    const { hooks, blocks } = harness([p]);
    expect(hooks.onRequest(req())).toEqual({ action: 'allow' });
    expect(hooks.onWebSocket(req())).toBe('allow');
    hooks.onResponse({ ...req(), status: 200 }, {} as ResponseHeaders);
    hooks.onDocument({}, { engine: 'scramjet', tabId: 1, url: 'http://site-a.localhost/', topLevelUrl: 'http://site-a.localhost/', isTopLevel: true });
    expect(calls).toBe(0);
    expect(blocks).toEqual([]);
    expect(hooks.status()).toEqual({ state: 'off', lists: 0, detail: null });
  });

  it('block beats redirect beats headers, and onBlock runs exactly once per decision', () => {
    const net: HookProvider = { name: 'network', onRequest: (r) => (r.url.includes('ads') ? { action: 'block', category: 'ads' } : null) };
    const privacy: HookProvider = {
      name: 'privacy',
      onRequest: (r) =>
        r.isTopLevelDocument && r.url.includes('utm_') ? { action: 'redirect', url: r.url.replace(/[?&]utm_[^&]*/, '') } : { action: 'allow', headers: { set: [['Sec-GPC', '1']] } },
    };
    const { hooks, blocks } = harness([net, privacy]);
    hooks.configure(settings());
    expect(hooks.onRequest(req())).toEqual({ action: 'block', category: 'ads' });
    const doc = req({ url: 'http://site-a.localhost/?utm_source=x', destination: 'iframe', isTopLevelDocument: true });
    expect(hooks.onRequest(doc)).toEqual({ action: 'redirect', url: 'http://site-a.localhost/' });
    expect(hooks.onRequest(req({ url: 'http://cdn.localhost/a.js' }))).toEqual({ action: 'allow', headers: { set: [['sec-gpc', '1']], remove: [] } });
    expect(blocks).toEqual([
      ['http://ads.localhost/ad.js', 'ads'],
      ['http://site-a.localhost/?utm_source=x', 'urlparams'],
    ]);
  });

  it('merges header changes: lower-case names, a later set replaces, a remove beats any set', () => {
    const a: HookProvider = { name: 'cookies', onRequest: () => ({ action: 'allow', headers: { set: [['DNT', '0'], ['X-A', 'a']], remove: ['Cookie'] } }) };
    const b: HookProvider = { name: 'privacy', onRequest: () => ({ action: 'allow', headers: { set: [['dnt', '1'], ['cookie', 'x=1']] } }) };
    const { hooks } = harness([a, b]);
    hooks.configure(settings());
    expect(hooks.onRequest(req())).toEqual({ action: 'allow', headers: { set: [['dnt', '1'], ['x-a', 'a']], remove: ['cookie'] } });
  });

  it('reports and skips a throwing provider; reports and ignores an invalid category', () => {
    const boom: HookProvider = {
      name: 'cosmetic',
      configure: () => {
        throw new Error('cfg');
      },
      onRequest: () => {
        throw new Error('boom');
      },
    };
    const bad: HookProvider = { name: 'cookies', onRequest: () => ({ action: 'block', category: 'malware' as BlockCategory }), onWebSocket: () => 'malware' as BlockCategory };
    const { hooks, blocks, errors } = harness([boom, bad]);
    hooks.configure(settings());
    expect(hooks.onRequest(req())).toEqual({ action: 'allow' });
    expect(hooks.onWebSocket(req({ destination: 'websocket' }))).toBe('allow');
    expect(blocks).toEqual([]);
    expect(errors).toEqual([
      ['cosmetic', 'configure', 'cfg'],
      ['cosmetic', 'onRequest', 'boom'],
      ['cookies', 'onRequest', 'invalid category malware'],
    ]);
  });

  it('never keeps or counts a refused redirect (another origin, a subresource, javascript:, the same URL)', () => {
    const targets: Array<[Partial<RequestInfo>, string]> = [
      [{ url: 'http://site-a.localhost/?utm_source=1', isTopLevelDocument: true }, 'http://evil.localhost/'],
      [{ url: 'http://site-a.localhost/a.js?utm_source=1' }, 'http://site-a.localhost/a.js'],
      [{ url: 'http://site-a.localhost/?utm_source=1', isTopLevelDocument: true }, 'javascript:alert(1)'],
      [{ url: 'http://site-a.localhost/', isTopLevelDocument: true }, 'http://site-a.localhost/'],
      [{ url: 'http://site-a.localhost/?a=1', isTopLevelDocument: true }, 'not a url'],
    ];
    for (const [r, to] of targets) {
      const p: HookProvider = { name: 'privacy', onRequest: () => ({ action: 'redirect', url: to }) };
      const { hooks, blocks, errors } = harness([p]);
      hooks.configure(settings());
      expect(hooks.onRequest(req(r))).toEqual({ action: 'allow' });
      expect(blocks).toEqual([]);
      expect(errors).toEqual([['privacy', 'onRequest', 'redirect refused']]);
    }
    const ok: HookProvider = { name: 'privacy', onRequest: () => ({ action: 'redirect', url: 'http://site-a.localhost/f' }) };
    const { hooks } = harness([ok]);
    hooks.configure(settings());
    expect(hooks.onRequest(req({ url: 'http://site-a.localhost/f?gclid=1', destination: 'frame' }))).toEqual({ action: 'redirect', url: 'http://site-a.localhost/f' });
  });

  it("judges the tab's own document under itself: allowlisted previous page, the OAuth chain", () => {
    const seen: Array<[string, boolean, boolean | null]> = [];
    const spy: HookProvider = {
      name: 'network',
      onRequest: (r, ctx: RequestContext) => (seen.push([r.url, ctx.policy.allowlisted, ctx.thirdParty]), null),
      onResponse: (r, _h, ctx) => void seen.push([`res ${r.url}`, ctx.policy.allowlisted, ctx.thirdParty]),
    };
    const { hooks } = harness([spy]);
    hooks.configure(settings({ allowlist: ['*.site-a.localhost'] }));
    // A link from allowlisted site-a to docblock: judged under docblock.
    hooks.onRequest(req({ url: 'http://docblock.localhost/', destination: 'iframe', isTopLevelDocument: true, topLevelUrl: 'http://site-a.localhost/' }));
    // site-a → idp → site-a/callback: every hop first-party to itself.
    hooks.onRequest(req({ url: 'http://idp.localhost/auth', destination: 'iframe', isTopLevelDocument: true, topLevelUrl: 'http://site-b.localhost/' }));
    hooks.onResponse({ ...req({ url: 'http://idp.localhost/auth', isTopLevelDocument: true, topLevelUrl: 'http://site-b.localhost/' }), status: 302 }, {} as ResponseHeaders);
    hooks.onRequest(req({ url: 'http://site-b.localhost/callback', destination: 'iframe', isTopLevelDocument: true, topLevelUrl: 'http://site-b.localhost/' }));
    // A subresource of allowlisted site-a: under site-a (frames and subresources inherit the tab's page).
    hooks.onRequest(req({ topLevelUrl: 'http://site-a.localhost/' }));
    // Unknown context: third-party, global settings.
    hooks.onRequest(req({ topLevelUrl: null, documentUrl: null }));
    expect(seen).toEqual([
      ['http://docblock.localhost/', false, false],
      ['http://idp.localhost/auth', false, false],
      ['res http://idp.localhost/auth', false, false],
      ['http://site-b.localhost/callback', false, false],
      ['http://ads.localhost/ad.js', true, true],
      ['http://ads.localhost/ad.js', false, null],
    ]);
  });

  it('caches policies per top-level host and clears the cache at configure()', () => {
    const pols: boolean[] = [];
    const spy: HookProvider = { name: 'network', onRequest: (_r, ctx) => (pols.push(ctx.policy.allowlisted), null) };
    const { hooks } = harness([spy]);
    hooks.configure(settings());
    hooks.onRequest(req());
    hooks.configure(settings({ allowlist: ['site-a.localhost'] }));
    hooks.onRequest(req());
    hooks.onRequest(req({ topLevelUrl: 'http://site-a.localhost:8080/' }));
    expect(pols).toEqual([false, true, true]);
  });

  it('onWebSocket: the first category that blocks, counted once; status comes from the network provider', () => {
    const net: HookProvider = { name: 'network', onWebSocket: (r) => (r.url.includes('ads') ? 'ads' : null), status: () => ({ state: 'ready', lists: 3, detail: null }) };
    const { hooks, blocks } = harness([net]);
    hooks.configure(settings());
    expect(hooks.onWebSocket(req({ url: 'ws://ads.localhost/ws', destination: 'websocket' }))).toBe('block');
    expect(hooks.onWebSocket(req({ url: 'ws://cdn.localhost/ws', destination: 'websocket' }))).toBe('allow');
    expect(blocks).toEqual([['ws://ads.localhost/ws', 'ads']]);
    expect(hooks.status()).toEqual({ state: 'ready', lists: 3, detail: null });
    const throwing = harness([{ name: 'network', status: () => { throw new Error('s'); } }]);
    expect(throwing.hooks.status()).toEqual({ state: 'off', lists: 0, detail: null });
    expect(throwing.errors).toEqual([['network', 'status', 's']]);
  });

  it('onDocument passes the document context in provider order', () => {
    const order: string[] = [];
    const mk = (name: ProviderName): HookProvider => ({ name, onDocument: (_w, d, ctx) => void order.push(`${name}:${d.url}:${String(ctx.thirdParty)}`) });
    const { hooks } = harness([mk('network'), mk('cookies'), mk('privacy'), mk('cosmetic')]);
    hooks.configure(settings());
    hooks.onDocument({}, { engine: 'ultraviolet', tabId: 2, url: 'http://site-b.localhost/f', topLevelUrl: 'http://site-a.localhost/', isTopLevel: false });
    expect(order).toEqual(['network:http://site-b.localhost/f:true', 'cookies:http://site-b.localhost/f:true', 'privacy:http://site-b.localhost/f:true', 'cosmetic:http://site-b.localhost/f:true']);
  });
});
