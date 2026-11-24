import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GnomeSwClient } from '../engine-host/sw-client/client';
import { SW_PAGE_CSP } from '../sw/pure';
import { LIMITS, validateEventPayload } from './engine-protocol';
import {
  ENGINE_HOST_SCRIPTS,
  ENGINE_PREFIXES,
  INLINE_DOCUMENT_TYPES,
  PROXIED_DOCUMENT_CSP,
  TRANSPORT_MODULES,
  VENDOR,
  VENDOR_PACKAGES,
  WEBRTC_GLOBALS,
  bareMime,
  bareMuxWorkerCsp,
  bareMuxWorkerScriptCsp,
  downloadDisposition,
  downloadFilename,
  engineHostCsp,
  engineHostUrl,
  isEngineHostClientUrl,
  needsProxiedCsp,
  parseHostToSw,
  parseSwSignal,
  proxyInertCsp,
  proxyScriptCsp,
} from './proxy-origin';
import type { HostToSwMessage, SwClient } from './proxy-origin';

describe('CSP strings', () => {
  it('are exactly the policies the spike verified, without report endpoints', () => {
    expect(PROXIED_DOCUMENT_CSP).toBe("default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob:; form-action 'self'");
    expect(engineHostCsp(['https://gnome.example'])).toBe(
      "frame-ancestors https://gnome.example; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'",
    );
    for (const p of [PROXIED_DOCUMENT_CSP, engineHostCsp(['https://a.example']), bareMuxWorkerCsp()]) {
      expect(p).not.toMatch(/report-(uri|to)/);
      expect(p).not.toMatch(/\bws:|\bwss:/);
    }
  });

  it('adds ws: wss: to connect-src only with the custom-Wisp opt-in of the operator', () => {
    const apps = ['http://127.0.0.1:5173', 'http://127.0.0.1:8080'];
    expect(engineHostCsp(apps, { customWisp: false })).toBe(engineHostCsp(apps));
    expect(engineHostCsp(apps, { customWisp: true })).toBe(
      "frame-ancestors http://127.0.0.1:5173 http://127.0.0.1:8080; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob: ws: wss:; form-action 'self'",
    );
    expect(bareMuxWorkerCsp()).toBe("connect-src 'self'");
    expect(bareMuxWorkerCsp({ customWisp: false })).toBe("connect-src 'self'");
    expect(bareMuxWorkerCsp({ customWisp: true })).toBe("connect-src 'self' ws: wss:");
    expect(engineHostCsp([])).toMatch(/^frame-ancestors 'none';/);
  });

  it('gives every other proxy-origin script the proxied-document policy, framed by the engine host and the app', () => {
    expect(proxyScriptCsp([])).toBe(`${PROXIED_DOCUMENT_CSP}; frame-ancestors 'self'`);
    expect(proxyScriptCsp(['https://gnome.example'])).toBe(
      "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob:; form-action 'self'; frame-ancestors 'self' https://gnome.example",
    );
    expect(proxyScriptCsp(['http://127.0.0.1:8080', 'http://localhost:8080'])).toMatch(/; frame-ancestors 'self' http:\/\/127\.0\.0\.1:8080 http:\/\/localhost:8080$/);
  });

  it("widens the bare-mux worker's second policy only with the opt-in, and only its connect-src", () => {
    const apps = ['https://gnome.example'];
    expect(bareMuxWorkerScriptCsp(apps)).toBe(proxyScriptCsp(apps));
    expect(bareMuxWorkerScriptCsp(apps, { customWisp: false })).toBe(proxyScriptCsp(apps));
    expect(bareMuxWorkerScriptCsp(apps, { customWisp: true })).toBe(
      "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob: ws: wss:; form-action 'self'; frame-ancestors 'self' https://gnome.example",
    );
    // Both of the worker's policies are enforced (the worker may connect only where both allow it), so the opt-in's
    // sources must be in both of them; the script policy's extra `blob:` stays refused by the first one.
    for (const customWisp of [false, true]) {
      const connect = (p: string) => (/connect-src ([^;]*)/.exec(p)?.[1] ?? '').split(' ');
      const script = connect(bareMuxWorkerScriptCsp(apps, { customWisp }));
      const worker = connect(bareMuxWorkerCsp({ customWisp }));
      expect(script.filter((s) => s !== 'blob:')).toEqual(worker);
      expect(worker.includes('ws:') && script.includes('ws:')).toBe(customWisp);
    }
  });

  it('lets nothing run, load, submit or re-base in inert answers; the SW pages use the same directives', () => {
    expect(proxyInertCsp([])).toBe("default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    expect(proxyInertCsp(['https://gnome.example'])).toBe(
      "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' https://gnome.example",
    );
    expect(proxyInertCsp(['https://gnome.example']).startsWith(`${SW_PAGE_CSP}; `)).toBe(true);
    for (const p of [proxyScriptCsp(['https://a.example']), bareMuxWorkerScriptCsp(['https://a.example']), proxyInertCsp(['https://a.example'])]) {
      expect(p).not.toMatch(/report-(uri|to)/);
      expect(p).not.toMatch(/\bws:|\bwss:/);
    }
  });

  it("equal gnome-server's fixture (backend/tests/fixtures/proxy-origin-csp.json), case by case", () => {
    // csp.rs compares its ProxyPolicies with the same file; regenerate it with
    // `node tests/e2e/engine/suites/backend-proxy.mjs --write-fixture` after changing a policy here.
    type Case = { appOrigins: string[]; customWisp?: boolean; csp: string };
    const f = JSON.parse(readFileSync(new URL('../../../backend/tests/fixtures/proxy-origin-csp.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(f.PROXIED_DOCUMENT_CSP).toBe(PROXIED_DOCUMENT_CSP);
    const fns: Record<string, (c: Case) => string> = {
      engineHostCsp: (c) => engineHostCsp(c.appOrigins, { customWisp: c.customWisp === true }),
      bareMuxWorkerCsp: (c) => bareMuxWorkerCsp({ customWisp: c.customWisp === true }),
      proxyScriptCsp: (c) => proxyScriptCsp(c.appOrigins),
      bareMuxWorkerScriptCsp: (c) => bareMuxWorkerScriptCsp(c.appOrigins, { customWisp: c.customWisp === true }),
      proxyInertCsp: (c) => proxyInertCsp(c.appOrigins),
    };
    for (const [key, fn] of Object.entries(fns)) {
      const cases = f[key] as Case[] | undefined;
      expect(cases?.length, key).toBeGreaterThan(1);
      for (const c of cases ?? []) expect(fn(c), `${key} ${JSON.stringify(c)}`).toBe(c.csp);
    }
  });

  it('covers every navigable destination and workers', () => {
    for (const d of ['document', 'iframe', 'frame', 'object', 'embed', 'worker', 'sharedworker']) expect(needsProxiedCsp(d)).toBe(true);
    for (const d of ['image', 'script', 'style', 'font', '', 'audio']) expect(needsProxiedCsp(d)).toBe(false);
  });
});

describe('SwClient', () => {
  it('lets the engine host post a message to the service worker: GnomeSwClient sends it to the controller, none without one', () => {
    const sent: unknown[] = [];
    const container = {
      controller: { postMessage: (m: unknown) => void sent.push(m) } as unknown as ServiceWorker | null,
      register: () => Promise.reject(new Error('not used here')),
      ready: new Promise<ServiceWorkerRegistration>(() => {}),
      addEventListener: () => {},
    };
    const client: SwClient = new GnomeSwClient({ container, secureContext: true, origin: 'http://127.0.0.1:1', build: 'b', setTimeout: () => 0, clearTimeout: () => {} });
    const message: HostToSwMessage = { type: 'gnome-blocker-config', settings: {}, setId: null };
    client.post(message);
    expect(sent).toEqual([message]);
    expect(parseHostToSw(sent[0])).toEqual(message);
    container.controller = null;
    expect(() => client.post(message)).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe('engine-host URL', () => {
  it('is always /engine/ on the proxy origin, without parameters', () => {
    expect(engineHostUrl('https://p.gnome.example')).toBe('https://p.gnome.example/engine/');
    expect(engineHostUrl('https://p.gnome.example/ignored?x=1')).toBe('https://p.gnome.example/engine/');
    expect(engineHostUrl('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081/engine/');
  });
});

describe('downloads', () => {
  it('treats attachments and types browsers do not render as downloads', () => {
    expect(downloadDisposition('attachment; filename="a.zip"', 'application/zip')).toBe('attachment');
    expect(downloadDisposition('ATTACHMENT', 'text/html')).toBe('attachment');
    expect(downloadDisposition(null, 'application/zip')).toBe('unrendered-type');
    expect(downloadDisposition(null, 'application/octet-stream')).toBe('unrendered-type');
    expect(downloadDisposition('inline', 'text/csv')).toBe('unrendered-type');
    for (const t of ['text/html; charset=utf-8', 'TEXT/PLAIN', 'application/json', 'image/svg+xml', 'image/png', 'video/mp4', 'audio/ogg', 'application/pdf']) {
      expect(downloadDisposition(null, t)).toBeNull();
    }
    expect(downloadDisposition(null, null)).toBeNull();
    expect(downloadDisposition('inline; filename=x', 'garbage')).toBeNull();
    expect(downloadDisposition('attachments-are-not-this', 'text/html')).toBeNull();
    expect(INLINE_DOCUMENT_TYPES).toContain('text/html');
  });

  it('reads bare MIME types the protocol accepts', () => {
    expect(bareMime('Text/HTML; charset=UTF-8')).toBe('text/html');
    expect(bareMime('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
    expect(bareMime('nonsense')).toBeNull();
    expect(bareMime(null)).toBeNull();
  });

  it('derives safe file names the download.started validator accepts', () => {
    const cases: Array<[string | null, string, string]> = [
      ['attachment; filename="report.pdf"', 'https://e.example/x', 'report.pdf'],
      ["attachment; filename*=UTF-8''na%C3%AFve%20file.txt; filename=\"fallback.txt\"", 'https://e.example/x', 'naïve file.txt'],
      ['attachment; filename=plain.bin', 'https://e.example/x', 'plain.bin'],
      ['attachment; filename="../../etc/passwd"', 'https://e.example/x', '.._.._etc_passwd'],
      ['attachment; filename="a\u202eexe.txt"', 'https://e.example/x', 'aexe.txt'],
      ['attachment', 'https://e.example/files/archive%20v2.zip', 'archive v2.zip'],
      ['attachment; filename=".."', 'https://e.example/', 'download'],
      [null, 'https://e.example/', 'download'],
    ];
    for (const [cd, url, want] of cases) {
      const name = downloadFilename(cd, url);
      expect(name).toBe(want);
      const v = validateEventPayload('download.started', {
        downloadId: 'sj-1', tabId: 1, url: 'https://e.example/x', filename: name, mime: null, total: null, engine: 'scramjet',
      });
      expect(v.ok).toBe(true);
    }
    const long = downloadFilename(`attachment; filename="${'n'.repeat(400)}.tar.gz"`, 'https://e.example/');
    expect(long.length).toBeLessThanOrEqual(LIMITS.maxFilenameLength);
    expect(long.endsWith('.gz')).toBe(true);
  });
});

describe('service worker messages', () => {
  it('recognizes only the engine-host client', () => {
    expect(isEngineHostClientUrl('https://p.gnome.example/engine/', 'https://p.gnome.example')).toBe(true);
    expect(isEngineHostClientUrl('https://p.gnome.example/engine/?x=1', 'https://p.gnome.example')).toBe(true);
    for (const u of ['https://p.gnome.example/~/sj/abc/https%3A%2F%2Fevil.example%2Fengine%2F', 'https://p.gnome.example/uv/service/x', 'https://p.gnome.example/engine/x', 'https://evil.example/engine/', 'nonsense']) {
      expect(isEngineHostClientUrl(u, 'https://p.gnome.example')).toBe(false);
    }
  });

  it('parses host → SW messages', () => {
    expect(parseHostToSw({ type: 'gnome-claim' })).toEqual({ type: 'gnome-claim' });
    expect(parseHostToSw({ type: 'gnome-skip-waiting', extra: 1 })).toEqual({ type: 'gnome-skip-waiting' });
    expect(parseHostToSw({ type: 'gnome-sw-config', config: { csp: 'off' } })).toBeNull();
    expect(parseHostToSw('gnome-claim')).toBeNull();
  });

  it('parses SW signals with only the documented fields', () => {
    expect(parseSwSignal({ type: 'sw-hello', build: '0.1.0+abc', startedAt: 5, extra: true })).toEqual({ type: 'sw-hello', build: '0.1.0+abc', startedAt: 5 });
    const started = {
      type: 'uv-download',
      phase: 'started',
      id: 'uv-x-1',
      url: 'https://e.example/f',
      referrer: null,
      clientUrl: null,
      navigation: true,
      disposition: 'unrendered-type',
      filename: 'f',
      mime: null,
      total: 3,
    };
    expect(parseSwSignal({ ...started, extra: 1 })).toEqual(started);
    expect(parseSwSignal({ ...started, navigation: false, disposition: 'attachment' })).toEqual({ ...started, navigation: false, disposition: 'attachment' });
    expect(parseSwSignal({ ...started, navigation: 'yes' })).toBeNull();
    expect(parseSwSignal({ ...started, clientUrl: undefined })).toBeNull();
    expect(parseSwSignal({ ...started, disposition: undefined })).toBeNull();
    expect(parseSwSignal({ ...started, disposition: 'inline' })).toBeNull();
    expect(parseSwSignal({ type: 'uv-download', phase: 'done', id: 'uv-x-1', state: 'completed', received: 3, error: null })).not.toBeNull();
    expect(parseSwSignal({ type: 'uv-download', phase: 'done', id: '../x', state: 'completed', received: 3, error: null })).toBeNull();
    expect(parseSwSignal({ type: 'uv-download', phase: 'progress', id: 'a', received: -1, total: null })).toBeNull();
    expect(parseSwSignal({ type: 'sw-config', csp: 'off' })).toBeNull();
    expect(parseSwSignal(null)).toBeNull();
  });

  // ── Wave B step 3 (WAVE-B3 §3.1 C10, C11) ──
  const HEX = 'ab'.repeat(32);
  it('parses gnome-blocker-config with and without a set id', () => {
    expect(parseHostToSw({ type: 'gnome-blocker-config', settings: { a: 1 } })).toEqual({ type: 'gnome-blocker-config', settings: { a: 1 }, setId: null });
    expect(parseHostToSw({ type: 'gnome-blocker-config', settings: {}, setId: HEX })).toEqual({ type: 'gnome-blocker-config', settings: {}, setId: HEX });
    expect(parseHostToSw({ type: 'gnome-blocker-config', settings: {}, setId: HEX.toUpperCase() })).toEqual({ type: 'gnome-blocker-config', settings: {}, setId: null });
    expect(parseHostToSw({ type: 'gnome-blocker-config', settings: [] })).toBeNull();
  });

  it('parses gnome-blocker-engines within its limits only', () => {
    const g = (group: string, n = 4) => ({ group, bytes: new ArrayBuffer(n) });
    const ok = parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('ads'), g('trackers')], extra: 1 });
    expect(ok).toMatchObject({ type: 'gnome-blocker-engines', setId: HEX });
    expect(ok?.type === 'gnome-blocker-engines' ? ok.groups.map((x) => x.group) : null).toEqual(['ads', 'trackers']);
    const all = ['ads', 'security', 'trackers', 'params', 'cookies', 'annoyances'];
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: all.map((x) => g(x)) })).not.toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [...all, 'ads'].map((x) => g(x)) })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('ads'), g('ads')] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('social')] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [{ group: 'ads', bytes: new Uint8Array(4) }] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('ads', 0)] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('ads', 64 * 1024 * 1024 + 1)] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: HEX, groups: [g('ads', 64 * 1024 * 1024), g('trackers', 64 * 1024 * 1024), g('params', 1)] })).toBeNull();
    expect(parseHostToSw({ type: 'gnome-blocker-engines', setId: 'x', groups: [] })).toBeNull();
  });

  it('parses gnome-blocker-context: drop defaults to [], malformed or oversized messages are null', () => {
    const doc: [string, string] = ['https://p.example/uv/service/x', 'https://site-a.example/'];
    expect(parseHostToSw({ type: 'gnome-blocker-context', docs: [doc], navs: ['https://p.example/uv/service/y'], reset: true })).toEqual({
      type: 'gnome-blocker-context',
      docs: [doc],
      navs: ['https://p.example/uv/service/y'],
      drop: [],
      inits: [],
      reset: true,
    });
    const base = { type: 'gnome-blocker-context', docs: [], navs: [], drop: [], reset: false };
    expect(parseHostToSw(base)).toEqual({ ...base, inits: [] });
    const init: [string, string] = ['https://p.example/uv/service/y', ''];
    const opener: [string, string] = ['https://p.example/uv/service/z', 'https://site-b.example/page'];
    expect(parseHostToSw({ ...base, inits: [init, opener] })).toEqual({ ...base, inits: [init, opener] });
    expect(parseHostToSw({ ...base, inits: Array.from({ length: 65 }, () => init) })).toBeNull();
    expect(parseHostToSw({ ...base, inits: [['https://p.example/uv/service/y', 1]] })).toBeNull();
    expect(parseHostToSw({ ...base, inits: [['', '']] })).toBeNull();
    expect(parseHostToSw({ ...base, inits: [['https://p.example/uv/service/y', 'x'.repeat(8193)]] })).toBeNull();
    expect(parseHostToSw({ ...base, inits: 'x' })).toBeNull();
    expect(parseHostToSw({ ...base, docs: Array.from({ length: 513 }, () => doc) })).toBeNull();
    expect(parseHostToSw({ ...base, navs: Array.from({ length: 65 }, () => 'u') })).toBeNull();
    expect(parseHostToSw({ ...base, drop: Array.from({ length: 65 }, () => 'u') })).toBeNull();
    expect(parseHostToSw({ ...base, docs: [['a']] })).toBeNull();
    expect(parseHostToSw({ ...base, docs: [['a', '']] })).toBeNull();
    expect(parseHostToSw({ ...base, navs: ['x'.repeat(8193)] })).toBeNull();
    expect(parseHostToSw({ ...base, navs: [1] })).toBeNull();
    expect(parseHostToSw({ ...base, reset: 'yes' })).toBeNull();
  });

  it('parses uv-blocked counts, and the step-2 shape as one count', () => {
    const documentUrl = 'https://p.example/uv/service/x';
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: { ads: 3, trackers: 1 } })).toEqual({ type: 'uv-blocked', documentUrl, counts: { ads: 3, trackers: 1 } });
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, category: 'ads' })).toEqual({ type: 'uv-blocked', documentUrl, counts: { ads: 1 } });
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, category: 'evil' })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: { evil: 1 } })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: { ads: 0 } })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: { ads: 1.5 } })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: { ads: 100_001 } })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl, counts: {} })).toBeNull();
    expect(parseSwSignal({ type: 'uv-blocked', documentUrl: 7, counts: { ads: 1 } })).toBeNull();
  });
});

describe('vendor layout', () => {
  it('serves every path from a pinned package directory', () => {
    const dirs = new Set(VENDOR_PACKAGES.map((p) => p.dir));
    const paths = [...Object.values(VENDOR), ...Object.values(TRANSPORT_MODULES).flatMap((m) => Object.values(m))];
    for (const p of paths) expect(dirs.has(p.split('/')[2] ?? '')).toBe(true);
    expect(ENGINE_HOST_SCRIPTS.indexOf(VENDOR.scramjet)).toBeLessThan(ENGINE_HOST_SCRIPTS.indexOf(VENDOR.controllerApi));
    expect(ENGINE_PREFIXES).toEqual(['/~/sj/', '/uv/service/']);
  });

  it('pins the same versions as the spike harness and frontend/package.json', () => {
    const deps = (rel: string): Record<string, string> => {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
      return pkg.dependencies ?? {};
    };
    const spike = deps('../../../tests/e2e/package.json');
    const frontend = deps('../../package.json');
    for (const p of VENDOR_PACKAGES) {
      expect(spike[p.pkg]?.replace(/^npm:.*@/, '')).toBe(p.version);
      // Wave B adds the engines to frontend/package.json (lane b): exact pins only, the same versions.
      if (frontend[p.pkg] !== undefined) expect(frontend[p.pkg]?.replace(/^npm:.*@/, '')).toBe(p.version);
    }
  });

  it('lists the WebRTC constructors the spike neutralized', () => {
    expect(WEBRTC_GLOBALS).toEqual(expect.arrayContaining(['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']));
  });
});
