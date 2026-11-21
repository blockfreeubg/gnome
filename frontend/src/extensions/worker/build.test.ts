// The group build with the real @ghostery/adblocker 2.20.3, x2's sanitizer and the pinned ubo-resources.json
// (WAVE-B3 §4.9). Engines are loaded back exactly as the engine host loads them (filters/engines.ts).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FiltersEngine } from '@ghostery/adblocker';
import { describe, expect, it } from 'vitest';
import type { BlockerGroup, FilterCategory, FilterListRef } from '../../shared/engine-protocol';
import { sitePolicy, SW_FALLBACK_SETTINGS } from '../core/policy';
import { sanitizeList, trustOnlyScriptlets } from '../core/sanitize';
import { composeHooks } from '../core/compose';
import { preprocessorEnv } from '../filters/config';
import { EnginesInForce, loadEngineSet } from '../filters/engines';
import type { FetchedList } from '../filters/lists';
import { createNetworkProvider } from '../filters/network';
import { GHOSTERY_ARGS_TAIL, scriptletCall } from '../filters/scriptlets';
import type { RequestInfo } from '../../shared/engine-hooks';
import { buildEngines } from './build';
import type { GroupOutput } from './build';

const RESOURCES = readFileSync(new URL('../../../../tests/e2e/engine/fixtures/blocker/lists/ubo-resources.json', import.meta.url), 'utf8');
const HEX = (c: string) => c.repeat(64);

function list(id: string, category: Exclude<FilterCategory, 'resources'>, text: string, trusted = false): FetchedList {
  return { ok: true, ref: { id, sha256: HEX(id[0] ?? 'a'), category, format: 'abp', trusted }, text, bytes: text.length };
}
const resources = (): { ref: FilterListRef; fetched: FetchedList } => {
  const ref: FilterListRef = { id: 'ubo-resources', sha256: HEX('f'), category: 'resources', format: 'resources', trusted: false };
  return { ref, fetched: { ok: true, ref, text: RESOURCES, bytes: RESOURCES.length } };
};

async function build(lists: FetchedList[], opts: { browser?: 'chromium' | 'gecko'; drop?: (pairs: Array<[number, string]>, styles: Array<[number, string]>) => number[] } = {}) {
  const out: GroupOutput[] = [];
  const env = preprocessorEnv(opts.browser ?? 'chromium');
  const result = await buildEngines(lists, resources(), {
    sanitize: sanitizeList,
    trustOnly: trustOnlyScriptlets,
    validate: async (_g, pairs, styles) => (opts.drop ? opts.drop(pairs, styles) : []),
    onGroup: (g) => out.push(g),
    env,
  });
  const set = await loadEngineSet('k', out.map((g) => ({ group: g.group, bytes: g.bytes })), env);
  const engines = new EnginesInForce();
  engines.swap(set);
  return { result, out, engines };
}

const settings = () => structuredClone(SW_FALLBACK_SETTINGS);
function hooksFor(engines: EnginesInForce, s = settings()) {
  const blocks: Array<[string, string]> = [];
  const hooks = composeHooks({
    providers: [createNetworkProvider({ engines, status: () => ({ state: 'ready', lists: 1, detail: null }) })],
    onBlock: (r, c) => blocks.push([r.url, c]),
    onError: (p, w, e) => {
      throw new Error(`${p} ${w} ${String(e)}`);
    },
  });
  hooks.configure(s);
  return { hooks, blocks };
}
const req = (url: string, over: Partial<RequestInfo> = {}): RequestInfo => ({
  engine: 'scramjet',
  tabId: 1,
  url,
  method: 'GET',
  destination: 'script',
  topLevelUrl: 'http://site-a.localhost/',
  isTopLevelDocument: false,
  documentUrl: 'http://site-a.localhost/',
  referrer: null,
  ...over,
});

describe('buildEngines (D1, D12)', () => {
  it('one engine per group, shared exceptions and $badfilter reach every group, counts per list', async () => {
    const { result, out, engines } = await build([
      list('ads-a', 'ads', '[Adblock Plus]\n||ads.localhost^$third-party\n||ads2.localhost^\n! comment\n'),
      list('privacy-b', 'privacy', '! Title\n||trk.localhost^$third-party\n@@||ads.localhost/ok.js^\n||ads2.localhost^$badfilter\n'),
      list('bad-c', 'security', '||bad.localhost^\n'),
    ]);
    expect(out.map((g) => g.group).sort()).toEqual(['ads', 'security', 'trackers']);
    expect(result.lists.map((l) => [l.id, l.state])).toEqual([
      ['ads-a', 'compiled'],
      ['bad-c', 'compiled'],
      ['privacy-b', 'compiled'],
      ['ubo-resources', 'compiled'],
    ]);
    expect(result.lists.find((l) => l.id === 'ads-a')?.rules).toBe(2);
    expect(result.resources).toEqual({ redirects: expect.any(Number), scriptlets: expect.any(Number) });
    for (const g of out) expect(g.bytes.byteLength).toBeGreaterThan(0);
    const { hooks, blocks } = hooksFor(engines);
    expect(hooks.onRequest(req('http://ads.localhost/ad.js'))).toEqual({ action: 'block', category: 'ads' });
    expect(hooks.onRequest(req('http://ads.localhost/ok.js'))).toEqual({ action: 'allow' }); // exception from another list
    expect(hooks.onRequest(req('http://ads2.localhost/x.js'))).toEqual({ action: 'allow' }); // $badfilter from another list
    expect(hooks.onRequest(req('http://trk.localhost/p.gif', { destination: 'image' }))).toEqual({ action: 'block', category: 'trackers' });
    expect(hooks.onRequest(req('http://bad.localhost/x', { destination: '' }))).toEqual({ action: 'block', category: 'security' });
    // first party: not blocked by a $third-party rule
    expect(hooks.onRequest(req('http://ads.localhost/ad.js', { topLevelUrl: 'http://ads.localhost/', documentUrl: 'http://ads.localhost/' }))).toEqual({ action: 'allow' });
    // unknown context: third-party to everything (the sentinel)
    expect(hooks.onRequest(req('http://ads.localhost/ad.js', { topLevelUrl: null, documentUrl: null }))).toEqual({ action: 'block', category: 'ads' });
    expect(blocks.length).toBe(4);
  });

  it('a $redirect-rule in a list of another group answers a block of the trackers group with its stub (shared)', async () => {
    const { engines } = await build([
      list('ads-a', 'ads', '||trk.localhost/t.js$redirect-rule=noop.js\n'),
      list('privacy-b', 'privacy', '||trk.localhost^$third-party\n'),
    ]);
    const v = hooksFor(engines).hooks.onRequest(req('http://trk.localhost/t.js'));
    expect(v).toMatchObject({ action: 'block', category: 'trackers', resource: { contentType: 'application/javascript', base64: false } });
    expect((v as { resource: { body: string } }).resource.body).toContain('use strict');
  });

  it('$redirect answers subresources with the resource, never a document or a frame; $important beats @@', async () => {
    const { engines } = await build([
      list('ads-a', 'ads', '||ads.localhost/stub.js$script,redirect=noop.js\n||ads.localhost/frame$subdocument,redirect=noop.html\n||imp.localhost^$important\n@@||imp.localhost^\n||pix.localhost/p.gif$image,redirect=1x1.gif\n'),
    ]);
    const { hooks } = hooksFor(engines);
    expect(hooks.onRequest(req('http://ads.localhost/stub.js'))).toMatchObject({ action: 'block', resource: { contentType: 'application/javascript' } });
    expect(hooks.onRequest(req('http://ads.localhost/frame', { destination: 'iframe' }))).toEqual({ action: 'block', category: 'ads' });
    expect(hooks.onRequest(req('http://ads.localhost/frame', { destination: 'iframe', isTopLevelDocument: true, topLevelUrl: 'http://site-a.localhost/' }))).toEqual({ action: 'allow' });
    expect(hooks.onRequest(req('http://imp.localhost/x.js'))).toEqual({ action: 'block', category: 'ads' });
    const gif = hooks.onRequest(req('http://pix.localhost/p.gif', { destination: 'image' }));
    expect(gif).toMatchObject({ action: 'block', resource: { contentType: 'image/gif', base64: true } });
  });

  it('every list’s $removeparam goes to the params group and applies through rewriteParams', async () => {
    const { out, engines } = await build([list('ads-a', 'ads', '||ads.localhost^\n$removeparam=gnome_e2e\n')]);
    expect(out.map((g) => g.group).sort()).toEqual(['ads', 'params']);
    expect(engines.rewriteParams('http://site-a.localhost/p?gnome_e2e=1&id=2', null, 'main_frame')).toBe('http://site-a.localhost/p?id=2');
    expect(engines.rewriteParams('http://site-a.localhost/p?id=2', null, 'main_frame')).toBeNull();
  });

  it('preprocessors: !#if env_firefox, and an @@ line under !#else, with the env applied after deserialize', async () => {
    const text = '||ff.localhost^\n!#if env_firefox\n||onlyff.localhost^\n!#else\n@@||ff.localhost/x^\n!#endif\n';
    const chrome = await build([list('ads-a', 'ads', text)], { browser: 'chromium' });
    const ff = await build([list('ads-a', 'ads', text)], { browser: 'gecko' });
    const c = hooksFor(chrome.engines).hooks;
    const f = hooksFor(ff.engines).hooks;
    expect(c.onRequest(req('http://ff.localhost/x'))).toEqual({ action: 'allow' });
    expect(f.onRequest(req('http://ff.localhost/x'))).toEqual({ action: 'block', category: 'ads' });
    expect(c.onRequest(req('http://onlyff.localhost/a'))).toEqual({ action: 'allow' });
    expect(f.onRequest(req('http://onlyff.localhost/a'))).toEqual({ action: 'block', category: 'ads' });
    // the same bytes, loaded with the other env
    const swapped = await loadEngineSet('k', chrome.out.map((g) => ({ group: g.group, bytes: g.bytes })), preprocessorEnv('gecko'));
    const e = new EnginesInForce();
    e.swap(swapped);
    expect(hooksFor(e).hooks.onRequest(req('http://onlyff.localhost/a'))).toEqual({ action: 'block', category: 'ads' });
  });

  it('a failed list is reported with its code and the others still build; an invalid selector is removed', async () => {
    const failed: FetchedList = { ok: false, ref: { id: 'gone', sha256: HEX('9'), category: 'ads', format: 'abp', trusted: false }, error: 'changed' };
    const { result, engines } = await build([failed, list('ads-a', 'ads', 'site-a.localhost##.ad\nsite-a.localhost##.bad-one\n')], {
      drop: (pairs) => pairs.filter(([, s]) => s === '.bad-one').map(([id]) => id),
    });
    expect(result.lists.find((l) => l.id === 'gone')).toEqual({ id: 'gone', sha256: HEX('9'), state: 'failed', error: 'changed', rules: 0, dropped: 0 });
    const css = engines.cosmetics('http://site-a.localhost/', sitePolicy(settings(), 'http://site-a.localhost/')).styles;
    expect(css).toContain('.ad');
    expect(css).not.toContain('.bad-one');
  });

  it('policy: allowlisted and toggled-off groups are not matched; nothing before an engine is in force', async () => {
    const { engines } = await build([list('ads-a', 'ads', '||ads.localhost^\n'), list('privacy-b', 'privacy', '||trk.localhost^\n')]);
    const s = settings();
    s.extensions.allowlist = ['*.site-a.localhost'];
    s.extensions.perSite = { 'site-b.localhost': { adblock: false } };
    s.extensions.enabled.trackers = false;
    const { hooks } = hooksFor(engines, s);
    expect(hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
    const b = { topLevelUrl: 'http://site-b.localhost/', documentUrl: 'http://site-b.localhost/' };
    expect(hooks.onRequest(req('http://ads.localhost/a.js', b))).toEqual({ action: 'allow' });
    expect(hooks.onRequest(req('http://trk.localhost/a.js', b))).toEqual({ action: 'allow' });
    const empty = new EnginesInForce();
    expect(hooksFor(empty).hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
  });
});

describe('scriptletCall and cosmetics() with the real library (§11.4)', () => {
  const engine = FiltersEngine.parse('', {});
  engine.updateResources(RESOURCES, 'x');
  const names = (JSON.parse(RESOURCES) as { scriptlets: Array<{ name: string }> }).scriptlets.map((s) => s.name);

  it('GHOSTERY_ARGS_TAIL ends every template getScriptlet returns', () => {
    expect(names.length).toBeGreaterThan(100);
    let n = 0;
    for (const name of names) {
      const t = engine.resources.getScriptlet(name);
      if (t === undefined) continue; // dependency-only scriptlets (fn helpers) have no template
      n++;
      expect(t.endsWith(GHOSTERY_ARGS_TAIL), name).toBe(true);
    }
    expect(n).toBeGreaterThan(90);
    expect(scriptletCall('(function(){})()', [])).toBe('(function(){})()');
    expect(scriptletCall('(function(){})()', ['a'])).toBeNull();
  });

  function runScripts(scripts: string[]): { PWNED: number; seen: unknown[] } {
    const ctx = vm.createContext({});
    vm.runInContext(
      `globalThis.PWNED = 0; globalThis.seen = []; globalThis.window = globalThis; globalThis.self = globalThis;
       globalThis.document = { currentScript: null, readyState: 'loading', addEventListener() {}, querySelectorAll() { return []; } };
       globalThis.location = { hostname: 'a.test', href: 'https://a.test/' };
       globalThis.addEventListener = () => {};
       globalThis.EventTarget = class EventTarget { addEventListener() {} removeEventListener() {} };
       globalThis.Request = class Request { clone() { return this; } };
       globalThis.XMLHttpRequest = class XMLHttpRequest { open() {} send() {} };
       globalThis.fetch = () => Promise.reject(new Error('no network'));
       globalThis.structuredClone = (v) => v;
       globalThis.console = { log() {}, error() {} };
       Object.defineProperty(globalThis, 'probe', { configurable: true, set(v) { seen.push(v); } });`,
      ctx,
    );
    for (const s of scripts) {
      try {
        vm.runInContext(s, ctx);
      } catch {
        /* a scriptlet that needs more of the DOM than the stub has: its arguments are what matters */
      }
    }
    return { PWNED: vm.runInContext('PWNED', ctx) as number, seen: vm.runInContext('seen', ctx) as unknown[] };
  }

  it('the §11.4 vectors leave PWNED at 0 even from a trusted list, and a regex argument arrives unchanged', async () => {
    const vectors = [
      'a.test##+js(set-constant, foo, x`-Function`globalThis.PWNED=1```-`)',
      'a.test##+js(set-constant, a`\\,Function`globalThis.PWNED=2```\\,`)',
      "a.test##+js(set-constant, $', \\,PWNED=6\\,0, \\,0)",
      'a.test##+js(set-constant, $`, x)',
      'a.test##+js(set-constant, $&, x)',
      'a.test##+js(set-constant, "a\\`b", x)',
      'a.test##+js(set-constant, \\`, x)',
      'a.test##+js(set-constant, x%2C`${globalThis.PWNED=3}`, y)',
      'a.test##+js(set-constant, probe, /^a$/)',
    ];
    const { engines } = await build([list('trusted-a', 'ads', vectors.join('\n'), true)]);
    const policy = sitePolicy(settings(), 'https://a.test/');
    const { scripts } = engines.cosmetics('https://a.test/', policy);
    expect(scripts.length).toBeGreaterThan(5);
    for (const s of scripts) expect(s.includes('.map((a) => decodeURIComponent(a)))')).toBe(true);
    const r = runScripts(scripts);
    expect(r.PWNED).toBe(0);
    // Ghostery's own assembly of the same filters does break out (the reason for scriptletCall).
    const own = FiltersEngine.parse(vectors.slice(0, 3).join('\n'), {});
    own.updateResources(RESOURCES, 'x');
    const ghostery = own.getCosmeticsFilters({ url: 'https://a.test/', hostname: 'a.test', domain: 'a.test', getRulesFromDOM: false });
    expect(runScripts(ghostery.scripts).PWNED).not.toBe(0);
    // set-constant with a regex value received exactly that string (as the constant's value)
    expect(scripts.some((s) => s.includes(JSON.stringify(['probe', '/^a$/'])))).toBe(true);
  });

  it('styles only with policy.hide, scriptlets per group toggle, generic base rules only with genericHide', async () => {
    const { engines } = await build([list('ads-a', 'ads', 'site-a.localhost##.ad\n##.generic-ad\n##div[data-generic-ad]\nsite-a.localhost##+js(set-constant, foo, true)\n')]);
    const s = settings();
    const p = sitePolicy(s, 'http://site-a.localhost/');
    const c = engines.cosmetics('http://site-a.localhost/', p);
    expect(c.styles).toContain('.ad');
    expect(c.styles).not.toContain('generic-ad');
    expect(c.scripts).toHaveLength(1);
    s.extensions.cosmeticAggressive = true;
    // the base stylesheet: generic rules the library cannot index by class or id
    expect(engines.cosmetics('http://site-a.localhost/', sitePolicy(s, 'http://site-a.localhost/')).styles).toContain('div[data-generic-ad]');
    s.extensions.enabled.cosmetic = false;
    const noHide = engines.cosmetics('http://site-a.localhost/', sitePolicy(s, 'http://site-a.localhost/'));
    expect(noHide.styles).toBe('');
    expect(noHide.scripts).toHaveLength(1);
    s.extensions.enabled.adblock = false;
    expect(engines.cosmetics('http://site-a.localhost/', sitePolicy(s, 'http://site-a.localhost/')).scripts).toHaveLength(0);
    const feat = engines.cosmeticsForFeatures('http://site-a.localhost/', sitePolicy({ ...settings(), extensions: { ...settings().extensions, cosmeticAggressive: true } }, 'http://site-a.localhost/'), { classes: ['generic-ad'], ids: [], hrefs: [] });
    expect(feat).toContain('.generic-ad');
  });
});

void (null as unknown as BlockerGroup);

describe('selector validation inputs', () => {
  it('sends every selector that reaches a stylesheet, and the declarations of the :style() rules among them by id', async () => {
    const seen: Array<{ pairs: Array<[number, string]>; styles: Array<[number, string]> }> = [];
    await build(
      [list('ads1', 'ads', ['site-a.localhost##.ad-box', 'site-a.localhost##body:style(overflow: auto !important)', 'site-a.localhost#@#.ok', 'site-a.localhost##+js(set-constant, x, 1)'].join('\n'))],
      { drop: (pairs, styles) => (seen.push({ pairs, styles }), []) },
    );
    const all = seen.flatMap((x) => x.pairs);
    const styles = new Map(seen.flatMap((x) => x.styles));
    // the hiding rule and the :style() selector go to validation; the exception and the scriptlet do not
    expect(all.map(([, sel]) => sel).sort()).toEqual(['.ad-box', 'body']);
    const body = all.find(([, sel]) => sel === 'body');
    expect(body && styles.get(body[0])).toBe('overflow: auto !important');
    const box = all.find(([, sel]) => sel === '.ad-box');
    expect(box && styles.has(box[0])).toBe(false);
  });
});
