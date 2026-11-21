import { describe, expect, it } from 'vitest';
import {
  RECOVERY,
  RebuildBudget,
  backoffDelayMs,
  classifyProbe,
  probeUrl,
  redactTicket,
  retryAfterMs,
  routeEndpoints,
  uvTransportAction,
  uvTransportKey,
  wispUrl,
} from './transport';

const TICKET = 'w1.1762903600.AAAAAAAAAAAAAAAAAAAAAA.' + 'B'.repeat(43);

describe('routeEndpoints', () => {
  it('maps the default and profile routes to the gateway on the proxy origin', () => {
    expect(routeEndpoints({ kind: 'default' }, 'https://p.gnome.example')).toEqual({
      endpoints: [{ url: 'wss://p.gnome.example/wisp/', gateway: true, kind: 'default' }],
      skipped: [],
    });
    expect(routeEndpoints({ kind: 'profile', id: 'se-got' }, 'http://127.0.0.1:8081').endpoints).toEqual([
      { url: 'ws://127.0.0.1:8081/wisp/p/se-got/', gateway: true, kind: 'profile' },
    ]);
  });

  it('keeps custom servers in order, resolves paths on the proxy origin and skips unusable ones', () => {
    const r = routeEndpoints(
      { kind: 'custom', servers: ['/wisp/', 'wss://wisp.example.org/', 'ws://insecure.example/', 'wss://wisp.example.org/proxy', 'wss://other.example/w/#frag'] },
      'https://p.gnome.example',
    );
    expect(r.endpoints).toEqual([
      { url: 'wss://p.gnome.example/wisp/', gateway: true, kind: 'custom' },
      { url: 'wss://wisp.example.org/', gateway: false, kind: 'custom' },
      { url: 'wss://other.example/w/', gateway: false, kind: 'custom' },
    ]);
    expect(r.skipped).toEqual([
      { server: 'ws://insecure.example/', problem: 'mixed-content' },
      { server: 'wss://wisp.example.org/proxy', problem: 'not-wisp-path' },
    ]);
    expect(routeEndpoints({ kind: 'custom', servers: ['ws://127.0.0.1:6001/'] }, 'http://127.0.0.1:8081').endpoints).toHaveLength(1);
  });
});

describe('wispUrl and probeUrl', () => {
  const gateway = { url: 'wss://p.gnome.example/wisp/', gateway: true, kind: 'default' as const };

  it('uses the canonical ?t=<ticket>&/ form on the gateway', () => {
    expect(wispUrl(gateway, TICKET)).toBe(`wss://p.gnome.example/wisp/?t=${TICKET}&/`);
    expect(wispUrl(gateway, TICKET).endsWith('/')).toBe(true);
    expect(wispUrl({ ...gateway, url: 'ws://127.0.0.1:8081/wisp/p/se-got/' }, 'a+b/c')).toBe('ws://127.0.0.1:8081/wisp/p/se-got/?t=a%2Bb%2Fc&/');
    expect(wispUrl(gateway, null)).toBe('wss://p.gnome.example/wisp/');
  });

  it('never sends the ticket to other servers and keeps their URLs ending in "/"', () => {
    const other = { url: 'wss://wisp.example.org/', gateway: false, kind: 'custom' as const };
    expect(wispUrl(other, TICKET)).toBe('wss://wisp.example.org/');
    expect(wispUrl({ ...other, url: 'wss://wisp.example.org/w/?key=1' }, TICKET)).toBe('wss://wisp.example.org/w/?key=1&/');
    expect(probeUrl(other, TICKET)).toBeNull();
  });

  it('probes the same URL over http(s)', () => {
    expect(probeUrl(gateway, TICKET)).toBe(`https://p.gnome.example/wisp/?t=${TICKET}&/`);
    expect(probeUrl({ ...gateway, url: 'ws://127.0.0.1:8081/wisp/' }, null)).toBe('http://127.0.0.1:8081/wisp/');
  });

  it('redacts tickets', () => {
    expect(redactTicket(`wss://p.gnome.example/wisp/?t=${TICKET}&/`)).toBe('wss://p.gnome.example/wisp/?t=<ticket>&/');
    expect(redactTicket('https://p.example/wisp/?a=1&t=secret')).toBe('https://p.example/wisp/?a=1&t=<ticket>');
  });
});

describe('classifyProbe', () => {
  it('reads the gateway answers of API.md "Ticket probe"', () => {
    expect(classifyProbe(426, null, null)).toEqual({ kind: 'valid' });
    expect(classifyProbe(401, null, 'wisp_ticket_expired')).toEqual({ kind: 'rejected', code: 'wisp_ticket_expired' });
    expect(classifyProbe(401, null, '<script>')).toEqual({ kind: 'rejected', code: null });
    expect(classifyProbe(404, null, 'not_found')).toEqual({ kind: 'unknown-profile' });
    expect(classifyProbe(null, null, null)).toEqual({ kind: 'unreachable', status: null });
    expect(classifyProbe(502, null, 'bad_gateway')).toEqual({ kind: 'unreachable', status: 502 });
  });

  it('reads 503 wisp_upstream_unavailable as the upstream being down, any other 503 as unreachable', () => {
    expect(classifyProbe(503, '30', 'wisp_upstream_unavailable')).toEqual({ kind: 'upstream-down', retryAfterMs: 30_000 });
    expect(classifyProbe(503, null, 'wisp_upstream_unavailable')).toEqual({ kind: 'upstream-down', retryAfterMs: null });
    expect(classifyProbe(503, '2', 'unavailable')).toEqual({ kind: 'unreachable', status: 503 });
    expect(retryAfterMs('5')).toBe(5000);
    expect(retryAfterMs(' 7 ')).toBe(7000);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it('treats 429 as backoff, honouring and capping Retry-After', () => {
    expect(classifyProbe(429, '17', 'rate_limited')).toEqual({ kind: 'rate-limited', retryAfterMs: 17_000 });
    expect(classifyProbe(429, null, null)).toEqual({ kind: 'rate-limited', retryAfterMs: RECOVERY.rateLimitDefaultMs });
    expect(classifyProbe(429, 'soon', null)).toEqual({ kind: 'rate-limited', retryAfterMs: RECOVERY.rateLimitDefaultMs });
    expect(classifyProbe(429, '0', null)).toEqual({ kind: 'rate-limited', retryAfterMs: 1000 });
    expect(classifyProbe(429, '999999', null)).toEqual({ kind: 'rate-limited', retryAfterMs: RECOVERY.rateLimitMaxMs });
  });
});

describe('backoff and rebuild cap', () => {
  it('doubles from 250 ms up to 30 s with ±50 % jitter', () => {
    expect(backoffDelayMs(0, 0.5)).toBe(250);
    expect(backoffDelayMs(3, 0.5)).toBe(2000);
    expect(backoffDelayMs(20, 0.5)).toBe(30_000);
    expect(backoffDelayMs(0, 0)).toBe(125);
    expect(backoffDelayMs(0, 0.999_999)).toBe(375);
  });

  it('allows rebuildLimit rebuilds per window per side', () => {
    const b = new RebuildBudget();
    for (let i = 0; i < RECOVERY.rebuildLimit; i++) expect(b.tryTake(1000 + i)).toBe(true);
    expect(b.tryTake(2000)).toBe(false);
    expect(b.waitMs(2000)).toBe(1000 + RECOVERY.rebuildWindowMs - 2000);
    expect(b.tryTake(1000 + RECOVERY.rebuildWindowMs)).toBe(true);
  });
});

describe('the shared Ultraviolet transport', () => {
  const direct = uvTransportKey({ kind: 'default' }, 'libcurl');
  const vpn = uvTransportKey({ kind: 'profile', id: 'se-got' }, 'libcurl');

  it('keys a transport by route and kind, never by ticket', () => {
    expect(direct).toBe('libcurl|default|');
    expect(vpn).toBe('libcurl|profile|se-got');
    expect(uvTransportKey({ kind: 'profile', id: 'se-got' }, 'epoxy')).not.toBe(vpn);
    expect(uvTransportKey({ kind: 'custom', servers: ['/wisp/', 'wss://w.example/'] }, 'epoxy')).toBe('epoxy|custom|/wisp/ wss://w.example/');
  });

  it('installs at start when nothing or something else runs, and reuses an equal one', () => {
    expect(uvTransportAction('start', null, direct)).toBe('install');
    expect(uvTransportAction('start', vpn, direct)).toBe('install');
    expect(uvTransportAction('start', direct, direct)).toBe('keep');
  });

  it('installs on a settings change only when the route or kind differs', () => {
    expect(uvTransportAction('configure', direct, vpn)).toBe('install');
    expect(uvTransportAction('configure', vpn, vpn)).toBe('keep');
  });

  it('never lets a rebuild replace another route (a GNOME tab with older settings cannot undo a VPN route)', () => {
    expect(uvTransportAction('rebuild', vpn, direct)).toBe('keep');
    expect(uvTransportAction('rebuild', direct, direct)).toBe('install');
    // Nothing installed (the SharedWorker restarted): there is no other route to undo.
    expect(uvTransportAction('rebuild', null, direct)).toBe('install');
  });
});
