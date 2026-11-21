import { describe, expect, it } from 'vitest';
import { LIMITS, validateEventPayload } from '../shared/engine-protocol';
import { PROXIED_DOCUMENT_CSP } from '../shared/proxy-origin';
import { classifyFailure, hasNetworkSignature } from './classify';
import { appOriginsFrom, newInstanceId } from './core';
import { applyProxiedCsp, scriptsUnrewritten } from './csp';
import { reportUrl, TabHistory } from './history';
import { faviconDataUrl, fitTitle, iconMime } from './observe/title';
import { siteStorageKeys } from './site-data';
import { PNG_BYTES } from './testing/png';

describe('classify (ENGINE-PROTOCOL §6.4)', () => {
  const ok = { offline: false, transportOffline: false };
  it('maps the transports\' words', () => {
    for (const d of ['Request failed with error code 52: Server returned nothing', 'code 7 Could not connect', 'code 35 SSL connect error', 'hyper UnexpectedEof … tls', 'MuxTaskEnded', 'TypeError: Failed to fetch']) {
      expect(classifyFailure('error-hook', d, ok)).toBe('network');
      expect(hasNetworkSignature(d)).toBe(true);
    }
    expect(classifyFailure('error-hook', 'TypeError: x is not a function', ok)).toBe('engine');
    expect(classifyFailure('uv-error-page', 'Error: code 6 Could not resolve host', ok)).toBe('network');
    expect(classifyFailure('timeout', '', ok)).toBe('timeout');
    expect(classifyFailure('frame-left-proxy', 'code 7', ok)).toBe('engine');
    expect(classifyFailure('error-hook', 'Failed to fetch', { offline: false, transportOffline: true })).toBe('gateway');
    expect(classifyFailure('error-hook', 'Failed to fetch', { offline: true, transportOffline: true })).toBe('offline');
    expect(classifyFailure('blocked', '', { offline: true, transportOffline: true })).toBe('blocked');
  });
});

describe('core helpers', () => {
  it('reads the templated app origins, never the placeholder', () => {
    expect(appOriginsFrom('%GNOME_APP_ORIGINS%')).toEqual([]);
    expect(appOriginsFrom('https://gnome.example http://127.0.0.1:20700 https://gnome.example')).toEqual(['https://gnome.example', 'http://127.0.0.1:20700']);
    expect(appOriginsFrom('https://gnome.example/path javascript:alert(1)')).toEqual([]);
    expect(appOriginsFrom(null)).toEqual([]);
  });
  it('makes instance ids the protocol accepts', () => {
    for (let i = 0; i < 50; i++) expect(newInstanceId()).toMatch(/^[a-z0-9]{16}$/);
  });
});

describe('CSP on Scramjet responses', () => {
  it('sets the policy for navigable destinations and adds script-src none for unrewritten scriptable documents', () => {
    const h = new Map<string, string>();
    const bag = { get: (n: string) => h.get(n) ?? null, set: (n: string, v: string) => void h.set(n, v), delete: (n: string) => void h.delete(n) };
    h.set('content-security-policy-report-only', 'x');
    expect(applyProxiedCsp('iframe', bag)).toBe(true);
    expect(h.get('content-security-policy')).toBe(PROXIED_DOCUMENT_CSP);
    expect(h.has('content-security-policy-report-only')).toBe(false);
    expect(applyProxiedCsp('image', bag)).toBe(false);
    applyProxiedCsp('object', bag, { unrewrittenScripts: true });
    expect(h.get('content-security-policy')).toBe(`${PROXIED_DOCUMENT_CSP}, script-src 'none'`);
    expect(['image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/rss+xml', null].map(scriptsUnrewritten)).toEqual([true, true, true, true, true]);
    expect(['text/html', 'application/pdf', 'image/png', 'text/plain', 'application/json'].map(scriptsUnrewritten)).toEqual([false, false, false, false, false]);
  });
});

describe('history fitting', () => {
  it('reports long URLs as origin + path and keeps non-http entries out', () => {
    expect(reportUrl('https://u:p@a.example/x?y')).toBe('https://a.example/x?y');
    expect(reportUrl(`https://a.example/${'p'.repeat(LIMITS.maxUrlLength)}`)?.length).toBeLessThanOrEqual(LIMITS.maxUrlLength);
    expect(reportUrl('data:text/html,x')).toBeNull();
    const h = new TabHistory(3);
    h.restore(['https://a/', 'https://b/', 'https://c/', 'https://d/'], 3);
    expect(h.entries).toEqual(['https://b/', 'https://c/', 'https://d/']);
    expect(h.index).toBe(2);
  });
});

describe('title and favicon', () => {
  it('fits titles and builds favicon data URLs the protocol accepts', () => {
    expect(fitTitle('  a\n\tb ‮ c ')).toBe('a b  c');
    expect(fitTitle('x'.repeat(5000)).length).toBe(LIMITS.maxTitleLength);
    const icon = faviconDataUrl(null, PNG_BYTES);
    expect(icon?.startsWith('data:image/png;base64,')).toBe(true);
    expect(validateEventPayload('tab.favicon', { tabId: 1, icon }).ok).toBe(true);
    expect(faviconDataUrl('image/png', new Uint8Array(LIMITS.faviconMaxBytes + 1))).toBeNull();
    expect(faviconDataUrl('text/html', new TextEncoder().encode('<html>'))).toBeNull();
    expect(iconMime('image/vnd.microsoft.icon; charset=x', new Uint8Array(4))).toBe('image/vnd.microsoft.icon');
  });
});

describe('site data', () => {
  it('keeps the engines\' own storage keys', () => {
    expect(siteStorageKeys(['bare-mux-path', 'gnome-x', 'https://a.example@k', '__uv$x'])).toEqual(['https://a.example@k', '__uv$x']);
  });
});

describe('bounded reads (favicons)', () => {
  it('reads small bodies and gives up on larger ones', async () => {
    const { readAtMost } = await import('./tabs');
    const small = await readAtMost(new Response(new Uint8Array([1, 2, 3])), 4);
    expect([...(small ?? [])]).toEqual([1, 2, 3]);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readAtMost(new Response(endless), 64 * 1024)).toBeNull();
    expect(pulled).toBeLessThan(80);
  });
});
