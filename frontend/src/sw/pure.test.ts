import { describe, expect, it } from 'vitest';
import { CSP_DESTINATIONS, PROXIED_DOCUMENT_CSP } from '../shared/proxy-origin';
import {
  SCRIPTLESS_CSP,
  SW_PAGE_CSP,
  blockedResponse,
  contentLength,
  createBodyFix,
  documentHookInstalled,
  documentHookNode,
  downloadDecision,
  engineDestination,
  ensureProxiedCsp,
  forEngines,
  injectDocumentHook,
  isStalePrefix,
  referrerFor,
  refusedResponse,
  scramjetNeedsScriptless,
  scramjetPrefixOf,
  scriptCapable,
  tapDownloadStream,
  unavailableResponse,
  uvNeedsScriptless,
  uvRefusesDestination,
  withProxiedCsp,
} from './pure';

const HOOK = '/engine/uv-doc-hook.js';

describe('referrerFor (the Referer Ultraviolet sends, as a browser computes it)', () => {
  const page = 'https://a.example/path/page?q=secret#frag';
  it('sends only the origin to another origin by default, the whole URL (without the fragment) to the same origin', () => {
    expect(referrerFor(page, 'https://b.example/x', '')).toBe('https://a.example/');
    expect(referrerFor(page, 'https://b.example/x', 'strict-origin-when-cross-origin')).toBe('https://a.example/');
    expect(referrerFor(page, 'https://a.example/other', '')).toBe('https://a.example/path/page?q=secret');
    expect(referrerFor(page, 'http://b.example/x', '')).toBeNull(); // a downgrade
  });
  it("follows the request's policy", () => {
    expect(referrerFor(page, 'https://b.example/', 'no-referrer')).toBeNull();
    expect(referrerFor(page, 'https://b.example/', 'unsafe-url')).toBe('https://a.example/path/page?q=secret');
    expect(referrerFor(page, 'https://a.example/', 'origin')).toBe('https://a.example/');
    expect(referrerFor(page, 'https://b.example/', 'same-origin')).toBeNull();
    expect(referrerFor(page, 'https://a.example/z', 'same-origin')).toBe('https://a.example/path/page?q=secret');
    expect(referrerFor(page, 'https://b.example/', 'origin-when-cross-origin')).toBe('https://a.example/');
    expect(referrerFor(page, 'http://b.example/', 'no-referrer-when-downgrade')).toBeNull();
    expect(referrerFor(page, 'https://b.example/', 'no-referrer-when-downgrade')).toBe('https://a.example/path/page?q=secret');
    expect(referrerFor(page, 'http://b.example/', 'strict-origin')).toBeNull();
    expect(referrerFor(page, 'https://b.example/', 'strict-origin')).toBe('https://a.example/');
  });
  it('drops credentials and anything that is not an http(s) URL', () => {
    expect(referrerFor('https://u:p@a.example/x', 'https://a.example/y', '')).toBe('https://a.example/x');
    expect(referrerFor('about:client', 'https://a.example/', '')).toBeNull();
    expect(referrerFor('not a url', 'https://a.example/', '')).toBeNull();
  });
});

describe('prefix ownership', () => {
  it('extracts the controller prefix of a Scramjet URL', () => {
    expect(scramjetPrefixOf('/~/sj/abc123/https%3A%2F%2Fexample.com%2F')).toBe('/~/sj/abc123/');
    expect(scramjetPrefixOf('/~/sj/')).toBeNull();
    expect(scramjetPrefixOf('/uv/service/x')).toBeNull();
  });

  it('a prefix is stale only when its announcing client is gone', () => {
    const owners = new Map([['/~/sj/a/', 'client-1']]);
    expect(isStalePrefix(owners, '/~/sj/a/', new Set(['client-1']))).toBe(false);
    expect(isStalePrefix(owners, '/~/sj/a/', new Set())).toBe(true);
    // unknown prefix (after a SW restart): not stale, the hold revives the controller
    expect(isStalePrefix(owners, '/~/sj/b/', new Set())).toBe(false);
    expect(isStalePrefix(owners, null, new Set())).toBe(false);
  });
});

describe('CSP decision', () => {
  it('adds PROXIED_DOCUMENT_CSP for every navigable and worker destination, any content type', async () => {
    for (const dest of CSP_DESTINATIONS) {
      const res = ensureProxiedCsp(new Response('x', { status: 200, headers: { 'content-type': 'application/octet-stream' } }), dest);
      expect(res.headers.get('content-security-policy'), dest).toBe(PROXIED_DOCUMENT_CSP);
      expect(await res.text()).toBe('x');
    }
    for (const dest of ['', 'script', 'style', 'image', 'font']) {
      const res = new Response('x');
      expect(ensureProxiedCsp(res, dest)).toBe(res);
    }
  });

  it('keeps an existing policy (both are enforced, so it can only get stricter) and adds GNOME’s once', () => {
    const h = withProxiedCsp(new Headers({ 'content-security-policy': "script-src 'none'" }));
    expect(h.get('content-security-policy')).toBe(`script-src 'none', ${PROXIED_DOCUMENT_CSP}`);
    expect(withProxiedCsp(h).get('content-security-policy')).toBe(`script-src 'none', ${PROXIED_DOCUMENT_CSP}`);
  });

  it('rebuilds null-body and error statuses correctly (UV’s 500 error page gets the policy too)', () => {
    expect(ensureProxiedCsp(new Response(null, { status: 204 }), 'iframe').status).toBe(204);
    const err = ensureProxiedCsp(new Response('<p>Error', { status: 500, headers: { 'content-type': 'text/html' } }), 'document');
    expect(err.status).toBe(500);
    expect(err.headers.get('content-security-policy')).toBe(PROXIED_DOCUMENT_CSP);
    const opaque = Response.error();
    expect(ensureProxiedCsp(opaque, 'document')).toBe(opaque);
  });

  it('the SW’s own pages run nothing, submit nothing and set no base (at least as strict as the proxied policy)', async () => {
    expect(SW_PAGE_CSP).toBe("default-src 'none'; form-action 'none'; base-uri 'none'");
    const page = unavailableResponse('stale-prefix', 'iframe');
    expect(page.status).toBe(503);
    expect(page.headers.get('content-security-policy')).toBe(SW_PAGE_CSP);
    expect(page.headers.get('x-gnome-sw')).toBe('stale-prefix');
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('stale-prefix');
    expect(await unavailableResponse('not-routable', 'script').text()).toBe('');
    expect(blockedResponse('ads').headers.get('content-security-policy')).toBe(SW_PAGE_CSP);
    const refused = refusedResponse('sharedworker');
    expect([refused.status, refused.headers.get('content-security-policy'), refused.headers.get('x-gnome-sw'), await refused.text()]).toEqual([403, SW_PAGE_CSP, 'refused', '']);
    expect(await refusedResponse('frame').text()).toContain('not supported');
    // passing through the CSP step leaves the SW's own (stricter) policy alone, also when scriptless is asked for
    expect(ensureProxiedCsp(unavailableResponse('not-routable', 'iframe'), 'iframe', { scriptless: true }).headers.get('content-security-policy')).toBe(SW_PAGE_CSP);
  });

  it('a document its engine did not rewrite gets SCRIPTLESS_CSP as a second policy, once', async () => {
    const res = ensureProxiedCsp(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), 'document', { scriptless: true });
    expect(res.headers.get('content-security-policy')).toBe(`${PROXIED_DOCUMENT_CSP}, ${SCRIPTLESS_CSP}`);
    expect(await res.text()).toBe('<svg/>');
    // already carrying both (lane a's Scramjet plugin sets "PROXIED, script-src 'none'" as one value): left alone
    const both = new Response('x', { headers: { 'content-security-policy': `${PROXIED_DOCUMENT_CSP}, ${SCRIPTLESS_CSP}` } });
    expect(ensureProxiedCsp(both, 'iframe', { scriptless: true })).toBe(both);
    // carrying GNOME's policy only: the scriptless one is added
    const one = ensureProxiedCsp(new Response('x', { headers: { 'content-security-policy': PROXIED_DOCUMENT_CSP } }), 'iframe', { scriptless: true });
    expect(one.headers.get('content-security-policy')).toBe(`${PROXIED_DOCUMENT_CSP}, ${SCRIPTLESS_CSP}`);
    expect(withProxiedCsp(withProxiedCsp(new Headers(), true), true).get('content-security-policy')).toBe(`${PROXIED_DOCUMENT_CSP}, ${SCRIPTLESS_CSP}`);
  });
});

describe('what the engines see, and which answers must not run scripts', () => {
  it('a <frame> load is shown to the engines as an iframe load; nothing else changes', () => {
    expect(engineDestination('frame')).toBe('iframe');
    for (const d of ['document', 'iframe', 'object', 'embed', 'script', '', 'worker']) expect(engineDestination(d)).toBe(d);
    const req = new Request('http://127.0.0.1/uv/service/x', { method: 'POST', body: 'a=1', headers: { 'x-a': 'b' } });
    expect(forEngines(req)).toBe(req); // destination '' stays: the real Request
  });

  it('the engines’ view of a frame request reads like the real one, methods included', async () => {
    const real = new Request('http://127.0.0.1/~/sj/p/x', { method: 'POST', body: 'a=1', headers: { 'x-a': 'b' }, referrer: 'about:client' });
    // A Request whose destination is `frame` (a real one cannot be constructed with it): methods bound like a real one.
    const fake = new Proxy(real, {
      get(t, k) {
        if (k === 'destination') return 'frame';
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as Request;
    expect(fake.destination).toBe('frame');
    const seen = forEngines(fake);
    expect(seen.destination).toBe('iframe');
    expect(seen.url).toBe(real.url);
    expect(seen.method).toBe('POST');
    expect(seen.headers.get('x-a')).toBe('b');
    expect(await seen.clone().text()).toBe('a=1');
    expect(await seen.blob().then((b) => b.text())).toBe('a=1');
  });

  it('only documents whose type can run scripts need the scriptless policy', () => {
    for (const m of [null, 'text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/rss+xml', 'text/xsl']) expect(scriptCapable(m), String(m)).toBe(true);
    for (const m of ['application/pdf', 'image/png', 'video/mp4', 'text/plain', 'application/json', 'application/zip']) expect(scriptCapable(m), m).toBe(false);
  });

  it('Ultraviolet: frame answers it did not rewrite (with the hook) run no scripts', () => {
    expect(uvNeedsScriptless('document', true, 'text/html')).toBe(false);
    expect(uvNeedsScriptless('document', false, 'text/html')).toBe(true); // e.g. `Text/HTML`, or the hook missing
    expect(uvNeedsScriptless('iframe', false, null)).toBe(true); // no Content-Type: the browser sniffs HTML
    expect(uvNeedsScriptless('iframe', false, 'image/svg+xml')).toBe(true);
    expect(uvNeedsScriptless('document', false, 'application/xhtml+xml')).toBe(true);
    expect(uvNeedsScriptless('object', false, 'text/html')).toBe(true);
    expect(uvNeedsScriptless('embed', false, 'image/svg+xml')).toBe(true);
    expect(uvNeedsScriptless('document', false, 'application/pdf')).toBe(false);
    expect(uvNeedsScriptless('script', false, null)).toBe(false);
    expect(uvNeedsScriptless('image', false, 'image/svg+xml')).toBe(false);
  });

  it('Scramjet: it rewrites only text/html seen as document or iframe', () => {
    expect(scramjetNeedsScriptless('document', 'text/html')).toBe(false);
    expect(scramjetNeedsScriptless('iframe', 'text/html')).toBe(false);
    expect(scramjetNeedsScriptless('frame', 'text/html')).toBe(false); // shown to Scramjet as iframe
    expect(scramjetNeedsScriptless('object', 'text/html')).toBe(true);
    expect(scramjetNeedsScriptless('embed', 'text/html')).toBe(true);
    expect(scramjetNeedsScriptless('document', 'application/foo+xml')).toBe(true);
    expect(scramjetNeedsScriptless('iframe', null)).toBe(true);
    expect(scramjetNeedsScriptless('document', 'application/pdf')).toBe(false);
    expect(scramjetNeedsScriptless('script', 'text/html')).toBe(false);
  });

  it('Ultraviolet shared-worker scripts are refused (UV serves them unrewritten); dedicated workers are not', () => {
    expect(uvRefusesDestination('sharedworker')).toBe(true);
    for (const d of ['worker', 'document', 'iframe', 'script', '']) expect(uvRefusesDestination(d)).toBe(false);
  });
});

describe('document-start hook (UV’s own injection)', () => {
  it('the hook node is first, in the shape of UV’s own nodes; the wrapper is installed once', () => {
    const uvNodes = [{ tagName: 'script', nodeName: 'script', childNodes: [], attrs: [] }];
    const calls: unknown[][] = [];
    const instance: { createHtmlInject?: unknown } = {
      createHtmlInject(...args: unknown[]) {
        calls.push(args);
        return uvNodes;
      },
    };
    expect(documentHookInstalled(instance)).toBe(false);
    expect(injectDocumentHook(instance)).toBe(true);
    expect(injectDocumentHook(instance)).toBe(true); // idempotent
    expect(documentHookInstalled(instance)).toBe(true);
    const nodes = (instance.createHtmlInject as (...a: unknown[]) => unknown[])('h', 'b', 'c', 'cfg', 'cookies', 'ref');
    expect(nodes).toEqual([documentHookNode(), ...uvNodes]);
    expect(calls).toEqual([['h', 'b', 'c', 'cfg', 'cookies', 'ref']]);
    expect(documentHookNode().attrs).toEqual([
      { name: 'src', value: HOOK, skip: true },
      { name: '__uv-script', value: '1', skip: true },
    ]);
  });

  it('an instance without createHtmlInject cannot carry the hook (its documents count as unrewritten)', () => {
    const instance: { createHtmlInject?: unknown } = {};
    expect(injectDocumentHook(instance)).toBe(false);
    expect(documentHookInstalled(instance)).toBe(false);
    expect(documentHookInstalled(null)).toBe(false);
  });
});

describe('download disposition per request', () => {
  const nav = { mode: 'navigate', destination: 'iframe' };
  it('frame navigations: attachment, unrendered type, or a page', () => {
    expect(downloadDecision(nav, 'attachment; filename="a.zip"', 'application/zip')).toEqual({ navigation: true, disposition: 'attachment' });
    expect(downloadDecision(nav, 'inline; filename="a.zip"', 'application/zip')).toEqual({ navigation: true, disposition: 'unrendered-type' });
    expect(downloadDecision({ mode: 'navigate', destination: 'document' }, null, 'text/html; charset=utf-8')).toBeNull();
    expect(downloadDecision(nav, null, null)).toBeNull();
    expect(downloadDecision(nav, 'inline; filename="x.pdf"', 'application/pdf')).toBeNull();
    expect(downloadDecision(nav, null, 'video/mp4')).toBeNull();
  });

  it('a download request (<a download>: navigate mode, empty destination) is always one; a page’s fetch never', () => {
    expect(downloadDecision({ mode: 'navigate', destination: '' }, null, 'text/html')).toEqual({ navigation: false, disposition: 'attachment' });
    expect(downloadDecision({ mode: 'cors', destination: '' }, 'attachment', 'application/zip')).toBeNull();
    expect(downloadDecision({ mode: 'no-cors', destination: 'image' }, 'attachment', 'image/png')).toBeNull();
    expect(downloadDecision({ mode: 'navigate', destination: 'object' }, 'attachment', 'application/zip')).toBeNull();
  });

  it('Content-Length', () => {
    expect(contentLength('2097152')).toBe(2097152);
    expect(contentLength(' 12 ')).toBe(12);
    expect(contentLength('-1')).toBeNull();
    expect(contentLength('1e9')).toBeNull();
    expect(contentLength(undefined)).toBeNull();
  });

  it('the stream tap passes bytes through and reports progress (≤ every 200 ms) and the end', async () => {
    let t = 0;
    const chunks = [new Uint8Array(1000), new Uint8Array(2000), new Uint8Array(3000)];
    const src = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        t += 150;
        if (next) c.enqueue(next);
        else c.close();
      },
    });
    const events: unknown[] = [];
    const out = tapDownloadStream(src, { progress: (r) => events.push(['progress', r]), done: (s, r, e) => events.push([s, r, e]) }, () => t);
    const buf = await new Response(out).arrayBuffer();
    expect(buf.byteLength).toBe(6000);
    // 150 ms per chunk on the injected clock: never two progress events within 200 ms, then exactly one end.
    expect(events.at(-1)).toEqual(['completed', 6000, null]);
    const progress = events.slice(0, -1) as Array<[string, number]>;
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(3);
    expect(progress.every(([k, r], i) => k === 'progress' && r <= 6000 && (i === 0 || r > (progress[i - 1]?.[1] ?? 0)))).toBe(true);
  });

  it('a cancelled or failing download ends once with its state', async () => {
    const events: unknown[] = [];
    const out = tapDownloadStream(new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(10)) }), {
      progress: () => {},
      done: (s, r) => events.push([s, r]),
    });
    const reader = out.getReader();
    await reader.read();
    await reader.cancel();
    expect(events).toEqual([['cancelled', 10]]);
    const failing = tapDownloadStream(
      new ReadableStream<Uint8Array>({
        pull: (c) => c.error(new Error('reset')),
      }),
      { progress: () => {}, done: (s, r, e) => events.push([s, r, e]) },
    );
    await expect(new Response(failing).arrayBuffer()).rejects.toThrow();
    expect(events.at(-1)).toEqual(['failed', 0, 'reset']);
  });
});

describe('Firefox request bodies', () => {
  it('without Request.prototype.body: one buffer per request, every read returns the same object', async () => {
    const proto = {};
    const fix = createBodyFix(proto, false);
    const req = new Request('http://x.test/', { method: 'POST', body: 'a=1' });
    Object.setPrototypeOf(req, proto);
    // the real Request methods are still reachable through Request.prototype for clone()
    Object.setPrototypeOf(proto, Request.prototype);
    Object.defineProperty(proto, 'clone', { value: Request.prototype.clone });
    await fix.bufferBody(req);
    const a = (req as unknown as { body: ArrayBuffer }).body;
    expect(a).toBeInstanceOf(ArrayBuffer);
    expect((req as unknown as { body: ArrayBuffer }).body).toBe(a);
    expect(new TextDecoder().decode(a)).toBe('a=1');
  });

  it('bare-mux’s internal Request reads the buffered body once, synchronously', async () => {
    const proto = {};
    const fix = createBodyFix(proto, false);
    const inner = Object.create(proto) as { body: unknown };
    const seen: unknown[] = [];
    const fetch = fix.wrapFetch(async (_t: unknown, init: { body?: unknown } | undefined) => {
      seen.push(inner.body, init?.body);
      return 'ok';
    });
    expect(await fetch('https://e.test/', { body: new TextEncoder().encode('xyz').buffer })).toBe('ok');
    expect(seen[0]).toBe(seen[1]);
    expect(new TextDecoder().decode(seen[0] as ArrayBuffer)).toBe('xyz');
    expect(inner.body).toBeNull();
  });

  it('with a native body nothing is patched', async () => {
    const proto = {};
    const fix = createBodyFix(proto, true);
    expect(Object.getOwnPropertyDescriptor(proto, 'body')).toBeUndefined();
    const req = new Request('http://x.test/', { method: 'POST', body: 'a' });
    await fix.bufferBody(req);
    expect(req.bodyUsed).toBe(false);
  });
});
