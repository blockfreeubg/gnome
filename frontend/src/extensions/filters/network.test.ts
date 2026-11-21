// The network provider's pure parts (WAVE-B3 §4.1, §4.9): the request type of every destination, the source URL the
// party and $domain checks use (the third-party sentinel where the context is unknown, D15), resources from Ghostery's
// redirects, and the verdicts against a fake matcher.
import { describe, expect, it } from 'vitest';
import type { RequestInfo } from '../../shared/engine-hooks';
import { SW_FALLBACK_SETTINGS, sitePolicy } from '../core/policy';
import type { RequestContext } from '../core/compose';
import { DEST_TO_TYPE, UNKNOWN_SOURCE, createNetworkProvider, requestType, sourceUrlOf, toResource } from './network';
import type { GroupMatcher } from './network';

const req = (over: Partial<RequestInfo> = {}): RequestInfo => ({
  engine: 'scramjet',
  tabId: 1,
  url: 'http://ads.localhost/x.js',
  method: 'GET',
  destination: 'script',
  topLevelUrl: 'http://site-a.localhost/',
  isTopLevelDocument: false,
  documentUrl: 'http://site-a.localhost/page',
  referrer: null,
  ...over,
});

describe('requestType', () => {
  it('maps every destination (research §2.6); the tab document is main_frame, frames sub_frame, anything else other', () => {
    const expected: Record<string, string> = {
      '': 'xmlhttprequest',
      document: 'sub_frame',
      iframe: 'sub_frame',
      frame: 'sub_frame',
      fencedframe: 'sub_frame',
      script: 'script',
      worker: 'script',
      sharedworker: 'script',
      serviceworker: 'script',
      audioworklet: 'script',
      paintworklet: 'script',
      json: 'script',
      style: 'stylesheet',
      image: 'image',
      font: 'font',
      audio: 'media',
      video: 'media',
      track: 'other',
      object: 'object',
      embed: 'object',
      report: 'csp_report',
      manifest: 'other',
      xslt: 'other',
      webidentity: 'other',
      websocket: 'websocket',
    };
    expect(DEST_TO_TYPE).toEqual(expected);
    for (const [dest, type] of Object.entries(expected)) expect(requestType({ destination: dest, isTopLevelDocument: false })).toBe(type);
    // Scramjet shows the tab's own document as an iframe request; UV as document: both are the tab's main_frame
    expect(requestType({ destination: 'iframe', isTopLevelDocument: true })).toBe('main_frame');
    expect(requestType({ destination: 'document', isTopLevelDocument: true })).toBe('main_frame');
    // unknown destinations and inherited names are `other`, never a prototype member
    expect(requestType({ destination: 'something-new', isTopLevelDocument: false })).toBe('other');
    expect(requestType({ destination: 'constructor', isTopLevelDocument: false })).toBe('other');
    expect(requestType({ destination: '__proto__', isTopLevelDocument: false })).toBe('other');
  });
});

describe('sourceUrlOf', () => {
  it('main_frame: the URL itself; else the document, else the top-level page, else the third-party sentinel', () => {
    expect(sourceUrlOf(req({ url: 'http://docblock.localhost/' }), 'main_frame')).toBe('http://docblock.localhost/');
    expect(sourceUrlOf(req(), 'script')).toBe('http://site-a.localhost/page');
    expect(sourceUrlOf(req({ documentUrl: null }), 'script')).toBe('http://site-a.localhost/');
    expect(sourceUrlOf(req({ documentUrl: null, topLevelUrl: null }), 'script')).toBe(UNKNOWN_SOURCE);
    expect(UNKNOWN_SOURCE).toBe('https://unknown.invalid/');
  });
});

describe('toResource', () => {
  it('takes the bare lower-case type, base64 from the type; refuses what is not a MIME type', () => {
    expect(toResource({ contentType: 'application/javascript', body: 'x' })).toEqual({ contentType: 'application/javascript', body: 'x', base64: false });
    expect(toResource({ contentType: 'image/gif;base64', body: 'R0lG' })).toEqual({ contentType: 'image/gif', body: 'R0lG', base64: true });
    expect(toResource({ contentType: 'Text/HTML; base64', body: 'PA==' })).toEqual({ contentType: 'text/html', body: 'PA==', base64: true });
    expect(toResource({ contentType: 'not a type', body: 'x' })).toBeNull();
    expect(toResource({ contentType: '', body: 'x' })).toBeNull();
  });
});

describe('createNetworkProvider', () => {
  const ctx = (over: { allowlist?: string[] } = {}): RequestContext => {
    const settings = structuredClone(SW_FALLBACK_SETTINGS);
    settings.extensions.allowlist = over.allowlist ?? [];
    return { settings, policy: sitePolicy(settings, 'http://site-a.localhost/'), thirdParty: true };
  };
  const matcher = (hits: Record<string, { redirect?: { contentType: string; body: string } }>, seen: string[] = []): GroupMatcher => ({
    ready: () => true,
    match: (group, url, source, type) => {
      seen.push(`${group} ${type} ${source}`);
      const h = hits[`${group} ${url}`];
      return h ? { match: true, redirect: h.redirect } : { match: false };
    },
  });
  const status = () => ({ state: 'ready' as const, lists: 1, detail: null });

  it('the first group in MATCH_ORDER that blocks decides (security before ads); resources only for subresources', () => {
    const p = createNetworkProvider({
      engines: matcher({
        'security http://ads.localhost/x.js': {},
        'ads http://ads.localhost/x.js': {},
        'ads http://ads.localhost/stub.js': { redirect: { contentType: 'application/javascript', body: '(()=>{})()' } },
        'ads http://ads.localhost/frame.html': { redirect: { contentType: 'text/html', body: '<p>' } },
      }),
      status,
    });
    expect(p.onRequest?.(req(), ctx())).toEqual({ action: 'block', category: 'security' });
    expect(p.onRequest?.(req({ url: 'http://ads.localhost/stub.js' }), ctx())).toEqual({ action: 'block', category: 'ads', resource: { contentType: 'application/javascript', body: '(()=>{})()', base64: false } });
    // a frame (and the tab's document) is never answered with a resource
    expect(p.onRequest?.(req({ url: 'http://ads.localhost/frame.html', destination: 'iframe' }), ctx())).toEqual({ action: 'block', category: 'ads' });
    expect(p.onRequest?.(req({ url: 'http://ads.localhost/frame.html', destination: 'iframe', isTopLevelDocument: true }), ctx())).toEqual({ action: 'block', category: 'ads' });
    expect(p.onWebSocket?.(req({ destination: 'websocket' }), ctx())).toBe('security');
  });

  it('no opinion when allowlisted or before engines are in force; unknown context is judged with the sentinel', () => {
    const seen: string[] = [];
    const engines = matcher({ 'ads http://ads.localhost/x.js': {} }, seen);
    const p = createNetworkProvider({ engines, status });
    expect(p.onRequest?.(req(), ctx({ allowlist: ['*.site-a.localhost'] }))).toBeNull();
    expect(createNetworkProvider({ engines: { ...engines, ready: () => false }, status }).onRequest?.(req(), ctx())).toBeNull();
    p.onRequest?.(req({ url: 'http://none.localhost/', documentUrl: null, topLevelUrl: null }), ctx());
    // every group the policy allows is asked, each with the sentinel as the source (third-party to everything)
    expect(seen.slice(-5)).toEqual(['security', 'ads', 'trackers', 'cookies', 'annoyances'].map((g) => `${g} script ${UNKNOWN_SOURCE}`));
  });
});
