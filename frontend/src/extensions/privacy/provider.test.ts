import { describe, expect, it } from 'vitest';
import { STRIP_MAX_PER_WINDOW, STRIP_WINDOW_MS, createPrivacyProvider, parseReferrerPolicy, reduceReferrer, referrerUnderPolicy } from './provider';
import { contextFor, request, settings, topDocument } from './testing';
import type { RequestInfo, RequestVerdict } from '../../shared/engine-hooks';
import type { BlockerSettings } from '../core/policy';

const A = 'https://site-a.example';
const B = 'https://site-b.example';

/** Runs the provider as x1's composite does: a tab's own document under itself, everything else under its tab's page. */
function judge(p: ReturnType<typeof createPrivacyProvider>, s: BlockerSettings, req: RequestInfo): RequestVerdict | null {
  const top = req.isTopLevelDocument ? req.url : req.topLevelUrl;
  return p.onRequest?.(req, contextFor(s, req.url, top)) ?? null;
}

const headersOf = (v: RequestVerdict | null): { set: Record<string, string>; remove: string[] } => {
  const h = v && v.action === 'allow' ? v.headers : undefined;
  return { set: Object.fromEntries(h?.set ?? []), remove: [...(h?.remove ?? [])] };
};

describe('reduceReferrer (the floor and the modes)', () => {
  const page = `${A}/path/page?q=1#frag`;
  it.each([
    // [referrer, target, mode, expected]
    [page, `${A}/other`, 'default', `${A}/path/page?q=1`],
    [page, `${A}/other`, 'origin-cross-site', `${A}/path/page?q=1`],
    [page, `${A}/other`, 'none', null],
    // same site, another origin: only the origin
    [page, 'https://www.site-a.example/x', 'default', `${A}/`],
    [page, 'https://www.site-a.example/x', 'origin-cross-site', `${A}/`],
    [page, `${A}:8443/x`, 'default', `${A}/`],
    [page, 'http://site-a.example/x', 'default', null],
    // cross-site
    [page, `${B}/x`, 'default', `${A}/`],
    [page, `${B}/x`, 'origin-cross-site', `${A}/`],
    [page, `${B}/x`, 'none', null],
    // https → http: nothing in every mode
    [page, 'http://site-b.example/x', 'default', null],
    [page, 'http://site-b.example/x', 'origin-cross-site', null],
    // http → https is allowed (the origin to another origin)
    ['http://plain.example/a?b', `${B}/x`, 'default', 'http://plain.example/'],
    ['http://plain.example/a?b', 'http://plain.example/c', 'default', 'http://plain.example/a?b'],
  ] as const)('%s → %s (%s)', (ref, target, mode, want) => {
    expect(reduceReferrer(ref, target, mode)).toBe(want);
  });

  it('never adds a referrer', () => {
    for (const mode of ['default', 'origin-cross-site', 'none'] as const) expect(reduceReferrer(null, `${B}/`, mode)).toBeNull();
  });

  it('never widens: an origin-only referrer stays origin-only, credentials are dropped', () => {
    expect(reduceReferrer(`${A}/`, `${A}/deep/path`, 'default')).toBe(`${A}/`);
    expect(reduceReferrer('https://user:pw@site-a.example/p', `${A}/x`, 'default')).toBe(`${A}/p`);
    expect(reduceReferrer('https://user:pw@site-a.example/p', `${B}/x`, 'default')).toBe(`${A}/`);
  });

  it('sends none for a referrer or target that is not http(s)', () => {
    expect(reduceReferrer('about:blank', `${B}/`, 'default')).toBeNull();
    expect(reduceReferrer('blob:https://site-a.example/123', `${A}/`, 'default')).toBeNull();
    expect(reduceReferrer('javascript:1', `${A}/`, 'default')).toBeNull();
    expect(reduceReferrer(`${A}/`, 'data:text/plain,x', 'default')).toBeNull();
    expect(reduceReferrer('not a url', `${A}/`, 'default')).toBeNull();
  });
});

describe('createPrivacyProvider: headers', () => {
  const p = createPrivacyProvider({ rewriteParams: () => null });

  it('sends Sec-GPC with sendGpc, DNT with doNotTrack, on subresources and documents', () => {
    const s = settings({ privacy: { sendGpc: true, doNotTrack: true } });
    for (const req of [request({ url: `${B}/a.js` }), topDocument(`${A}/`), request({ url: `${A}/f`, destination: 'iframe' }), request({ url: `${B}/x`, destination: '' })]) {
      expect(headersOf(judge(p, s, req)).set).toMatchObject({ 'sec-gpc': '1', dnt: '1' });
    }
  });

  it('sends neither with privacy protection off, or with the switches off', () => {
    for (const s of [settings({ enabled: { privacy: false }, privacy: { doNotTrack: true } }), settings({ privacy: { sendGpc: false, doNotTrack: false } })]) {
      const h = headersOf(judge(p, s, request({ url: `${B}/a.js` })));
      expect(h.set['sec-gpc']).toBeUndefined();
      expect(h.set.dnt).toBeUndefined();
    }
  });

  it('an allowlisted site keeps GPC (privacy headers are not list-based)', () => {
    const s = settings({ extensions: { allowlist: ['*.site-a.example'] } });
    expect(headersOf(judge(p, s, topDocument(`${A}/`))).set['sec-gpc']).toBe('1');
    expect(headersOf(judge(p, s, request({ url: `${B}/t.js`, topLevelUrl: `${A}/` }))).set['sec-gpc']).toBe('1');
  });

  it('reduces the Referer to the floor, also with privacy protection off', () => {
    for (const s of [settings({ privacy: { referrer: 'default' } }), settings({ enabled: { privacy: false }, privacy: { referrer: 'none' } })]) {
      const h = headersOf(judge(p, s, request({ url: `${B}/a.js`, referrer: `${A}/secret/page?id=42` })));
      expect(h.set.referer).toBe(`${A}/`);
      const https2http = headersOf(judge(p, s, request({ url: 'http://site-b.example/a.js', referrer: `${A}/p` })));
      expect(https2http.remove).toContain('referer');
    }
  });

  it('keeps a same-origin Referer as it is (no header change) and removes it with `none`', () => {
    const s = settings({ privacy: { referrer: 'origin-cross-site' } });
    const same = headersOf(judge(p, s, request({ url: `${A}/api`, referrer: `${A}/page?x=1` })));
    expect(same.set.referer).toBeUndefined();
    expect(same.remove).not.toContain('referer');
    const none = headersOf(judge(p, settings({ privacy: { referrer: 'none' } }), request({ url: `${A}/api`, referrer: `${A}/page` })));
    expect(none.remove).toEqual(['referer']);
  });

  it('never adds a Referer when the engine sends none', () => {
    const h = headersOf(judge(p, settings({ privacy: { referrer: 'default' } }), request({ url: `${B}/a.js`, referrer: null })));
    expect(h.set.referer).toBeUndefined();
    expect(h.remove).not.toContain('referer');
  });

  it('has no opinion when there is nothing to change', () => {
    const s = settings({ privacy: { sendGpc: false } });
    expect(judge(p, s, request({ url: `${B}/a.js` }))).toBeNull();
  });
});

describe('createPrivacyProvider: tracking parameters (D13)', () => {
  const tracked = `${A}/article?utm_source=x&fbclid=y&id=1`;

  it('redirects a tab document to the URL without built-in tracking parameters', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    expect(judge(p, settings(), topDocument(tracked))).toEqual({ action: 'redirect', url: `${A}/article?id=1` });
  });

  it('applies the filter lists first (rewriteParams with the document URL and the type), then the table', () => {
    const calls: unknown[][] = [];
    const p = createPrivacyProvider({
      rewriteParams: (...a) => {
        calls.push(a);
        return `${A}/article?utm_source=x&id=1`; // the list removed fbclid (and kept utm_*)
      },
    });
    expect(judge(p, settings(), topDocument(tracked))).toEqual({ action: 'redirect', url: `${A}/article?id=1` });
    expect(calls).toEqual([[tracked, tracked, 'main_frame']]);
    const frame = request({ url: `${B}/embed?gnome_e2e=1`, destination: 'iframe', documentUrl: `${A}/` });
    const p2 = createPrivacyProvider({
      rewriteParams: (url, doc, type) => {
        calls.push([url, doc, type]);
        return `${B}/embed`;
      },
    });
    expect(judge(p2, settings(), frame)).toEqual({ action: 'redirect', url: `${B}/embed` });
    expect(calls.at(-1)).toEqual([`${B}/embed?gnome_e2e=1`, `${A}/`, 'sub_frame']);
  });

  it('strips frames too (document, iframe, frame destinations)', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    for (const destination of ['document', 'iframe', 'frame']) {
      expect(judge(p, settings(), request({ url: `${B}/f?gclid=1&a=2`, destination, tabId: Math.random() }))).toEqual({ action: 'redirect', url: `${B}/f?a=2` });
    }
  });

  it('never strips subresources, POST documents or other methods', () => {
    const p = createPrivacyProvider({ rewriteParams: () => `${A}/x` });
    expect(judge(p, settings(), request({ url: `${A}/x?utm_source=1`, destination: 'script' }))?.action).not.toBe('redirect');
    expect(judge(p, settings(), request({ url: `${A}/x?utm_source=1`, destination: '' }))?.action).not.toBe('redirect');
    expect(judge(p, settings(), topDocument(`${A}/x?utm_source=1`, { method: 'POST' }))?.action).not.toBe('redirect');
    expect(judge(p, settings(), topDocument(`${A}/x?utm_source=1`, { method: 'PUT' }))?.action).not.toBe('redirect');
    expect(judge(createPrivacyProvider({ rewriteParams: () => null }), settings(), topDocument(`${A}/y?utm_source=1`, { method: 'HEAD' }))).toEqual({ action: 'redirect', url: `${A}/y` });
  });

  it('never produces a redirect to another origin (a provider bug cannot become an open redirect)', () => {
    const p = createPrivacyProvider({ rewriteParams: () => 'https://evil.example/?x' });
    const v = judge(p, settings(), topDocument(`${A}/p?q=1`));
    expect(v?.action).not.toBe('redirect');
    const p2 = createPrivacyProvider({ rewriteParams: () => 'javascript:alert(1)' });
    expect(judge(p2, settings(), topDocument(`${A}/p?q=1`))?.action).not.toBe('redirect');
  });

  it('fails open when rewriteParams throws: the built-in table still applies', () => {
    const p = createPrivacyProvider({
      rewriteParams: () => {
        throw new Error('engine not ready');
      },
    });
    expect(judge(p, settings(), topDocument(tracked))).toEqual({ action: 'redirect', url: `${A}/article?id=1` });
  });

  it('does nothing without stripTrackingParams, with privacy protection off, or on an allowlisted site', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    for (const s of [settings({ privacy: { stripTrackingParams: false } }), settings({ enabled: { privacy: false } }), settings({ extensions: { allowlist: ['*.site-a.example'] } })]) {
      expect(judge(p, s, topDocument(tracked))?.action).not.toBe('redirect');
    }
  });

  it('judges a tab document under itself: a link from an allowlisted site to a tracked URL is stripped, and to an allowlisted one is not (D3)', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    const s = settings({ extensions: { allowlist: ['*.site-a.example'] } });
    expect(judge(p, s, topDocument(`${B}/?utm_source=x`, { topLevelUrl: `${A}/` }))).toEqual({ action: 'redirect', url: `${B}/` });
    expect(judge(p, s, topDocument(`${A}/?utm_source=x`, { topLevelUrl: `${B}/` }))?.action).not.toBe('redirect');
  });

  it('loop guard: a URL it produced is not stripped again, and at most 3 redirects per tab in 10 s', () => {
    let t = 1_000;
    const p = createPrivacyProvider({ rewriteParams: () => null, now: () => t });
    const s = settings();
    // A server that redirects the clean URL back to a tracked one: strip, strip, strip, then let it through.
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const v = judge(p, s, topDocument(`${A}/loop?utm_source=${i}`, { tabId: 7 }));
      results.push(v?.action ?? 'none');
      t += 100;
    }
    expect(results.filter((r) => r === 'redirect')).toHaveLength(STRIP_MAX_PER_WINDOW);
    expect(results.slice(STRIP_MAX_PER_WINDOW).every((r) => r !== 'redirect')).toBe(true);
    // Another tab is not affected.
    expect(judge(p, s, topDocument(`${A}/loop?utm_source=z`, { tabId: 8 }))?.action).toBe('redirect');
    // After the window the tab strips again.
    t += STRIP_WINDOW_MS;
    expect(judge(p, s, topDocument(`${A}/loop?utm_source=later`, { tabId: 7 }))?.action).toBe('redirect');
  });

  it('loop guard: a URL it produced that still carries a parameter a later list removes is not redirected again within 10 s', () => {
    let t = 0;
    let calls = 0;
    const p = createPrivacyProvider({
      rewriteParams: (url) => {
        calls++;
        return url.includes('a=1') ? `${A}/p?b=1` : `${A}/p`;
      },
      now: () => t,
    });
    const s = settings();
    expect(judge(p, s, topDocument(`${A}/p?a=1&b=1`, { tabId: 1 }))).toEqual({ action: 'redirect', url: `${A}/p?b=1` });
    // The produced URL comes back: never stripped again within the window.
    t += 50;
    expect(judge(p, s, topDocument(`${A}/p?b=1`, { tabId: 1 }))?.action).not.toBe('redirect');
    expect(calls).toBe(2);
  });

  it('loop guard in the service worker (no tab): per destination page, also when another parameter changes each round', () => {
    const p0 = createPrivacyProvider({ rewriteParams: () => null, now: () => 0 });
    const rounds: string[] = [];
    for (let i = 1; i <= 6; i++) rounds.push(judge(p0, settings(), topDocument(`${A}/loop.html?utm_source=loop&round=${i}`, { tabId: null, engine: 'ultraviolet' }))?.action ?? 'none');
    expect(rounds.filter((r) => r === 'redirect')).toHaveLength(STRIP_MAX_PER_WINDOW);
  });

  it('loop guard in the service worker (no tab): another page is not affected', () => {
    const t = 0;
    const p = createPrivacyProvider({ rewriteParams: () => null, now: () => t });
    const s = settings();
    const out: string[] = [];
    for (let i = 0; i < 4; i++) out.push(judge(p, s, topDocument(`${A}/sw?fbclid=${i}`, { tabId: null, engine: 'ultraviolet' }))?.action ?? 'none');
    expect(out.filter((r) => r === 'redirect')).toHaveLength(STRIP_MAX_PER_WINDOW);
    expect(judge(p, s, topDocument(`${A}/other?fbclid=1`, { tabId: null, engine: 'ultraviolet' }))?.action).toBe('redirect');
  });
});

describe('the requesting document’s Referrer-Policy header (Scramjet serves every document with unsafe-url)', () => {
  const headers = (policy: string | null) => ({
    get: (n: string) => (n.toLowerCase() === 'referrer-policy' ? policy : null),
    getAll: () => [],
    set() {},
    append() {},
    delete() {},
  });
  const respond = (p: ReturnType<typeof createPrivacyProvider>, url: string, policy: string | null, destination = 'document') => {
    const res = { ...request({ url, destination, isTopLevelDocument: destination === 'document' }), status: 200 };
    p.onResponse?.(res, headers(policy), contextFor(settings(), url, url));
  };

  it('a page served with no-referrer sends none to its subresources, also same-origin', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    respond(p, `${A}/page#x`, 'no-referrer');
    const s = settings({ privacy: { referrer: 'default' } });
    expect(headersOf(judge(p, s, request({ url: `${B}/img`, documentUrl: `${A}/page`, referrer: `${A}/` }))).remove).toEqual(['referer']);
    expect(headersOf(judge(p, s, request({ url: `${A}/img`, documentUrl: `${A}/page`, referrer: `${A}/page` }))).remove).toEqual(['referer']);
  });

  it('same-origin and origin policies; a later answer without the header forgets the policy', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    const s = settings({ privacy: { referrer: 'default' } });
    respond(p, `${A}/so`, 'same-origin');
    expect(headersOf(judge(p, s, request({ url: `${B}/x`, documentUrl: `${A}/so`, referrer: `${A}/so` }))).remove).toEqual(['referer']);
    expect(headersOf(judge(p, s, request({ url: `${A}/x`, documentUrl: `${A}/so`, referrer: `${A}/so?q=1` }))).set.referer).toBeUndefined();
    respond(p, `${A}/o`, 'origin');
    expect(headersOf(judge(p, s, request({ url: `${A}/x`, documentUrl: `${A}/o`, referrer: `${A}/o?q=1` }))).set.referer).toBe(`${A}/`);
    respond(p, `${A}/o`, null);
    expect(headersOf(judge(p, s, request({ url: `${A}/x`, documentUrl: `${A}/o`, referrer: `${A}/o?q=1` }))).set.referer).toBeUndefined();
  });

  it('a permissive page policy never widens past the floor', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    respond(p, `${A}/u`, 'unsafe-url');
    expect(headersOf(judge(p, settings({ privacy: { referrer: 'default' } }), request({ url: `${B}/x`, documentUrl: `${A}/u`, referrer: `${A}/u?secret=1` }))).set.referer).toBe(`${A}/`);
  });

  it('ignores the answers of subresources', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    respond(p, `${A}/script.js`, 'no-referrer', 'script');
    expect(headersOf(judge(p, settings(), request({ url: `${B}/x`, documentUrl: `${A}/script.js`, referrer: `${A}/` }))).remove).toEqual([]);
  });

  it('a frame of a no-referrer page navigates without a Referer (the frame’s documentUrl is its parent)', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    respond(p, `${A}/page`, 'no-referrer');
    const frame = request({ url: `${B}/frame`, destination: 'iframe', documentUrl: `${A}/page`, referrer: `${A}/page` });
    expect(headersOf(judge(p, settings({ privacy: { referrer: 'default' } }), frame)).remove).toEqual(['referer']);
  });

  it('a tab navigation follows the policy of the page it leaves, which the referrer names (Referrer Policy §8.3)', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    const s = settings({ privacy: { referrer: 'default' } });
    respond(p, `${A}/doc?x=1`, 'no-referrer'); // the tab's own document (tab 1)
    // The engine already trimmed the cross-origin referrer to the origin: the tab's document is that origin's page.
    expect(headersOf(judge(p, s, topDocument(`${B}/next`, { tabId: 1, referrer: `${A}/` }))).remove).toEqual(['referer']);
    // Same origin, the full URL of the page.
    expect(headersOf(judge(p, s, topDocument(`${A}/next`, { tabId: 1, referrer: `${A}/doc?x=1` }))).remove).toEqual(['referer']);
    // Another tab, and a navigation another origin started (a frame of site-c targeting _top): the floor only.
    expect(headersOf(judge(p, s, topDocument(`${B}/next`, { tabId: 2, referrer: `${A}/` }))).remove).toEqual([]);
    expect(headersOf(judge(p, s, topDocument(`${B}/next`, { tabId: 1, referrer: 'https://site-c.example/' }))).remove).toEqual([]);
  });

  it('a redirect hop does not become the tab’s page; the next document does, also one without the header', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    const s = settings({ privacy: { referrer: 'default' } });
    respond(p, `${A}/doc`, 'no-referrer');
    const hop = { ...topDocument(`${A}/go`, { tabId: 1, referrer: `${A}/doc` }), status: 302 };
    p.onResponse?.(hop, headers('unsafe-url'), contextFor(settings(), hop.url, hop.url));
    expect(headersOf(judge(p, s, topDocument(`${B}/next`, { tabId: 1, referrer: `${A}/` }))).remove).toEqual(['referer']);
    respond(p, `${A}/plain`, null);
    expect(headersOf(judge(p, s, topDocument(`${B}/next`, { tabId: 1, referrer: `${A}/` }))).remove).toEqual([]);
  });

  it('the destination’s own policy never applies to the request that loads it', () => {
    const p = createPrivacyProvider({ rewriteParams: () => null });
    respond(p, `${B}/next`, 'no-referrer');
    respond(p, `${A}/doc`, null);
    const v = judge(p, settings({ privacy: { referrer: 'default' } }), topDocument(`${B}/next`, { tabId: 1, referrer: `${A}/doc?q=1` }));
    expect(headersOf(v).set.referer).toBe(`${A}/`);
  });

  it('parseReferrerPolicy and referrerUnderPolicy', () => {
    expect(parseReferrerPolicy('no-referrer, unsafe-url')).toBe('unsafe-url');
    expect(parseReferrerPolicy('unsafe-url, bogus')).toBe('unsafe-url');
    expect(parseReferrerPolicy('bogus')).toBeNull();
    expect(parseReferrerPolicy(null)).toBeNull();
    expect(referrerUnderPolicy(`${A}/p?q#h`, `${A}/x`, 'unsafe-url')).toBe(`${A}/p?q`);
    expect(referrerUnderPolicy(`${A}/p`, 'http://b.example/', 'strict-origin')).toBeNull();
    expect(referrerUnderPolicy(`${A}/p`, `${B}/`, 'origin-when-cross-origin')).toBe(`${A}/`);
    expect(referrerUnderPolicy(`${A}/p`, 'http://b.example/', 'no-referrer-when-downgrade')).toBeNull();
    expect(referrerUnderPolicy('data:x', `${B}/`, 'unsafe-url')).toBeNull();
  });
});
