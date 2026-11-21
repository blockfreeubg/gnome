#!/usr/bin/env node
/**
 * Two-origin stack QA (ARCHITECTURE §4.4, §4.6; docs/API.md): HTTP and Wisp checks against a running gnome-server in
 * two-origin mode with a real HolyWisp behind it. No browser is involved (the browser-side checks are
 * settings/settings-qa.mjs, about/about-qa.mjs and stack/engine-on-gnome-server.mjs).
 *
 *   GNOME_QA_APP=http://127.0.0.1:24110 GNOME_QA_PROXY=http://127.0.0.1:24111 GNOME_QA_ADMIN=http://127.0.0.1:24112 \
 *     node tests/e2e/stack/stack-qa.mjs
 *
 * What it checks:
 * - route sets per role: the app origin serves the SPA and /api/* but no /wisp/, /engine/, /sw.js, /vendor/** or
 *   engine prefixes; the proxy origin serves none of the SPA, /api/config, /api/session, /api/auth/*, /api/sync/*,
 *   /api/wisp/ticket or /api/vpn/*, only /api/health, /api/filters*, /assets/*, /wisp/* and the engine prefixes;
 * - security headers per role (shell CSP with the proxy origin in frame-src and no ws:/wss:, X-Frame-Options on the
 *   app; frame-ancestors <app> and no X-Frame-Options on the proxy) and CSRF (X-GNOME-Request + Origin, no CORS);
 * - cookies set by the app origin are HttpOnly, SameSite=Strict, Path=/ and host-only (no Domain);
 * - /api/config: isolated, the proxy origin, wisp.ticket_ttl_s; /api/health in full on the app origin and minimal on
 *   the proxy origin; /api/vpn/locations shape;
 * - a ticket minted on the app origin opens a Wisp connection through the proxy origin's /wisp/ in all three URL
 *   forms (?t=<ticket>&/, ?t=<ticket>/, ?t=<ticket>) and fetches https://example.com/ with TLS inside the stream
 *   (certificate verified) and http://example.org/ in the clear;
 * - refusals before the upgrade (missing, empty, forged, malformed, duplicate t, "//"; Origin = app origin, foreign or
 *   missing) with their JSON codes; the ticket probe (plain GET/HEAD, no Origin) answers 426 for a valid ticket in
 *   every form and 401 wisp_ticket_* otherwise;
 * - filter lists on both roles: index ETag/304, a body's strong ETag/304, br negotiation, ?v=<sha256> immutable;
 * - with GNOME_QA_ADMIN: /admin/diagnostics reports two-origin mode, the raised file-descriptor limit, zero-copy relays
 *   and the probes this run made.
 *
 * Env: GNOME_QA_APP and GNOME_QA_PROXY (required), GNOME_QA_ADMIN (admin listener; optional),
 *      GNOME_QA_OFFLINE=1 (skip the checks that fetch example.com/example.org through Wisp),
 *      GNOME_QA_EXPIRED_TICKET (a ticket of this server that has expired: probe and upgrade must say
 *      wisp_ticket_expired; mint one with GNOME_WISP_TICKET_TTL_S=60 and wait a minute),
 *      GNOME_QA_ROUTE (Wisp route for the fetch checks, default /wisp/; e.g. /wisp/p/<profile>/).
 * The run makes about 25 upgrades and probes: the gateway allows 60 per minute and IP, so wait a minute between runs.
 * Needs `npm ci` in tests/e2e (the `ws` package). Exits 1 on any failure.
 */
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const APP = (process.env.GNOME_QA_APP ?? '').replace(/\/$/, '');
const PROXY = (process.env.GNOME_QA_PROXY ?? '').replace(/\/$/, '');
const ADMIN = (process.env.GNOME_QA_ADMIN ?? '').replace(/\/$/, '');
const OFFLINE = process.env.GNOME_QA_OFFLINE === '1';
const ROUTE = process.env.GNOME_QA_ROUTE ?? '/wisp/';
if (!APP || !PROXY) {
  console.error('Set GNOME_QA_APP and GNOME_QA_PROXY to the app and proxy origins of a two-origin gnome-server.');
  process.exit(2);
}

const results = [];
function check(ok, name, detail = '') {
  results.push({ ok, name });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
}
const section = (title) => console.log(`\n${title}`);
const codeOf = (text) => {
  try {
    return JSON.parse(text)?.error?.code ?? null;
  } catch {
    return null;
  }
};
async function http(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init });
  const body = init.method === 'HEAD' ? '' : await res.text();
  return { status: res.status, headers: res.headers, body, code: codeOf(body) };
}

// ── Wisp v1 client (enough for one request per stream) ─────────────────────────────────────────────────────────────

/** Opens a WebSocket; resolves {ws} on 101 or {status, body} when the server refused the upgrade. */
function upgrade(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin === undefined ? {} : { origin });
    ws.binaryType = 'nodebuffer';
    // Frames are buffered from the start: the first CONTINUE can arrive in the same read as the 101 head.
    ws.inbox = [];
    ws.on('message', (d) => (ws.sink ? ws.sink(d) : ws.inbox.push(d)));
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, code: codeOf(body) }));
    });
    ws.once('error', (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

/** Stream 1 of a fresh Wisp connection to host:port, as a Duplex. */
function wispStream(ws, host, port) {
  return new Promise((resolve, reject) => {
    const id = 1;
    let window = 0;
    let started = false;
    const queue = [];
    const frame = (type, payload) => {
      const b = Buffer.alloc(5 + payload.length);
      b[0] = type;
      b.writeUInt32LE(id, 1);
      payload.copy(b, 5);
      return b;
    };
    const flush = () => {
      while (window > 0 && queue.length) {
        ws.send(frame(0x02, queue.shift()));
        window--;
      }
    };
    const duplex = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        queue.push(Buffer.from(chunk));
        flush();
        cb();
      },
    });
    ws.sink = (data) => {
      const b = Buffer.from(data);
      const [type, sid, p] = [b[0], b.readUInt32LE(1), b.subarray(5)];
      if (type === 0x03 && sid === 0 && !started) {
        started = true;
        window = p.readUInt32LE(0);
        const connect = Buffer.alloc(3 + Buffer.byteLength(host));
        connect[0] = 0x01; // TCP
        connect.writeUInt16LE(port, 1);
        connect.write(host, 3);
        ws.send(frame(0x01, connect));
        resolve(duplex);
      } else if (sid === id && type === 0x02) duplex.push(p);
      else if (sid === id && type === 0x03) {
        window = p.readUInt32LE(0);
        flush();
      } else if (sid === id && type === 0x04) duplex.push(null);
    };
    for (const d of ws.inbox.splice(0)) ws.sink(d);
    ws.on('close', () => duplex.push(null));
    setTimeout(() => !started && reject(new Error('no CONTINUE on stream 0 within 10 s')), 10_000);
  });
}

async function httpsThroughWisp(ws, host) {
  const stream = await wispStream(ws, host, 443);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket: stream, servername: host, ALPNProtocols: ['http/1.1'] });
    let data = '';
    s.on('secureConnect', () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    s.on('data', (c) => (data += c.toString('latin1')));
    s.on('end', () => resolve({ status: Number(data.split(' ')[1]), protocol: s.getProtocol(), verified: s.authorized }));
    s.on('error', reject);
    setTimeout(() => reject(new Error('no answer within 20 s')), 20_000);
  });
}

async function httpThroughWisp(ws, host) {
  const stream = await wispStream(ws, host, 80);
  return new Promise((resolve, reject) => {
    let data = '';
    stream.on('data', (c) => (data += c.toString('latin1')));
    stream.on('end', () => resolve({ status: Number(data.split(' ')[1]) }));
    stream.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => reject(new Error('no answer within 20 s')), 20_000);
  });
}

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

section('Configuration');
const config = JSON.parse((await http(`${APP}/api/config`)).body);
check(config.proxy?.isolated === true, 'proxy.isolated is true', JSON.stringify(config.proxy));
check(config.proxy?.origin === PROXY, 'proxy.origin is the proxy origin', config.proxy?.origin);
check(Number.isInteger(config.wisp?.ticket_ttl_s) && config.wisp.ticket_ttl_s >= 60, `wisp.ticket_ttl_s = ${config.wisp?.ticket_ttl_s}`);
check(config.wisp?.path === '/wisp/', 'wisp.path is /wisp/');

section('Route sets per role');
const index = await http(`${APP}/`);
const asset = /\/assets\/[^"']+\.js/.exec(index.body)?.[0];
const expectations = [
  // [origin, method, path, expected status or predicate, label]
  [APP, 'GET', '/', (r) => r.status === 200 && /text\/html/.test(r.headers.get('content-type')), 'SPA'],
  [APP, 'GET', '/settings', (r) => r.status === 200 && /text\/html/.test(r.headers.get('content-type')), 'SPA route'],
  [APP, 'GET', '/api/config', 200],
  [APP, 'GET', '/api/health', 200],
  [APP, 'GET', '/api/filters', 200],
  [APP, 'GET', '/api/vpn/locations', 200],
  [APP, 'GET', '/wisp/', 404],
  [APP, 'GET', '/%77isp/', 404],
  [APP, 'GET', '/engine/', 404],
  [APP, 'GET', '/sw.js', 404],
  [APP, 'GET', '/vendor/bare-mux/worker.js', 404],
  [APP, 'GET', '/~/sj/x', 404],
  [APP, 'GET', '/uv/service/x', 404],
  [PROXY, 'GET', '/', 404],
  [PROXY, 'GET', '/settings', 404],
  [PROXY, 'GET', '/index.html', 404],
  [PROXY, 'GET', '/api/config', 404],
  [PROXY, 'GET', '/api/session', 404],
  [PROXY, 'POST', '/api/session', 404],
  [PROXY, 'GET', '/api/auth/me', 404],
  [PROXY, 'POST', '/api/auth/login', 404],
  [PROXY, 'GET', '/api/sync/settings', 404],
  [PROXY, 'POST', '/api/wisp/ticket', 404],
  [PROXY, 'GET', '/api/vpn/locations', 404],
  [PROXY, 'GET', '/api/health', 200],
  [PROXY, 'GET', '/api/filters', 200],
  [PROXY, 'GET', '/wisp/', 401],
  [PROXY, 'GET', '/wisp/p/no-such-profile/', 404],
  [PROXY, 'GET', '/~/sj/x', 503],
  [PROXY, 'GET', '/uv/service/x', 503],
  ...(asset ? [[APP, 'GET', asset, 200], [PROXY, 'GET', asset, 200]] : []),
];
for (const [origin, method, path, want, label] of expectations) {
  const headers = method === 'GET' ? {} : { 'X-GNOME-Request': '1', 'Content-Type': 'application/json' };
  const r = await http(`${origin}${path}`, { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) });
  const ok = typeof want === 'function' ? want(r) : r.status === want;
  const role = origin === APP ? 'app' : 'proxy';
  check(ok, `${role} ${method} ${path} → ${typeof want === 'function' ? label : want}`, ok ? '' : `got ${r.status}`);
}

section('Security headers per role');
{
  const csp = index.headers.get('content-security-policy') ?? '';
  check(index.headers.get('x-frame-options') === 'SAMEORIGIN', 'app: X-Frame-Options SAMEORIGIN');
  check(new RegExp(`frame-src [^;]*${PROXY.replace(/[.:/]/g, '\\$&')}`).test(csp), 'app: frame-src lists the proxy origin');
  check(/connect-src 'self';/.test(csp) && !/ wss?:/.test(csp), "app: connect-src 'self' without ws:/wss:");
  check(/frame-ancestors 'self'/.test(csp), "app: frame-ancestors 'self'");
  for (const path of ['/engine/', '/api/health', '/nope', ...(asset ? [asset] : [])]) {
    const r = await http(`${PROXY}${path}`);
    const pcsp = r.headers.get('content-security-policy') ?? '';
    check(
      r.headers.get('x-frame-options') === null && new RegExp(`frame-ancestors ('self' )?${APP.replace(/[.:/]/g, '\\$&')}`).test(pcsp),
      `proxy ${path}: frame-ancestors <app origin>, no X-Frame-Options`,
      pcsp.slice(0, 80),
    );
  }
}

section('CSRF');
{
  const post = (headers) => http(`${APP}/api/session`, { method: 'POST', headers });
  check((await post({})).status === 403, 'POST without X-GNOME-Request → 403');
  check((await post({ 'X-GNOME-Request': '1', Origin: PROXY })).status === 403, 'POST with Origin = proxy origin → 403');
  check((await post({ 'X-GNOME-Request': '1', Origin: APP })).status === 200, 'POST with Origin = app origin → 200');
  const pre = await http(`${APP}/api/wisp/ticket`, {
    method: 'OPTIONS',
    headers: { Origin: PROXY, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-gnome-request' },
  });
  check(pre.status >= 400 && !pre.headers.has('access-control-allow-origin'), 'CORS preflight from the proxy origin is refused', String(pre.status));
}

section('Cookies');
const ticketRes = await fetch(`${APP}/api/wisp/ticket`, { method: 'POST', headers: { 'X-GNOME-Request': '1' } });
const setCookies = ticketRes.headers.getSetCookie();
const ticket = await ticketRes.json();
{
  const sid = setCookies.find((c) => /^(__Host-)?gnome_sid=/.test(c)) ?? '';
  check(/; HttpOnly/i.test(sid) && /; SameSite=Strict/i.test(sid) && /; Path=\//i.test(sid), 'gnome_sid: HttpOnly; SameSite=Strict; Path=/', sid.replace(/=[^;]+/, '=…'));
  check(sid !== '' && !/;\s*Domain=/i.test(sid), 'gnome_sid is host-only (no Domain)');
  if (config.features?.accounts) {
    const user = `stackqa_${Date.now().toString(36)}`;
    const reg = await fetch(`${APP}/api/auth/register`, {
      method: 'POST',
      headers: { 'X-GNOME-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: 'correct horse battery staple' }),
    });
    const auth = reg.headers.getSetCookie().find((c) => /^(__Host-)?gnome_auth=/.test(c)) ?? '';
    check(reg.status === 201 && /; HttpOnly/i.test(auth) && /; SameSite=Strict/i.test(auth) && !/;\s*Domain=/i.test(auth), 'gnome_auth (register): HttpOnly, SameSite=Strict, host-only', String(reg.status));
    const cookie = auth.split(';')[0];
    const out = await fetch(`${APP}/api/auth/logout`, { method: 'POST', headers: { 'X-GNOME-Request': '1', cookie } });
    const after = await http(`${APP}/api/session`, { headers: { cookie } });
    check(out.status === 204 && after.status === 401, 'logout ends the user session (GET /api/session → 401)', `${out.status}, ${after.status}`);
  }
}

section('Health, VPN locations');
{
  const full = JSON.parse((await http(`${APP}/api/health`)).body);
  check(full.status === 'ok' && typeof full.version === 'string' && full.wisp?.direct !== undefined, 'app /api/health: full form', JSON.stringify(full));
  const min = JSON.parse((await http(`${PROXY}/api/health`)).body);
  check(
    JSON.stringify(Object.keys(min).sort()) === '["status","wisp"]' && JSON.stringify(Object.keys(min.wisp)) === '["direct"]',
    'proxy /api/health: status + direct Wisp only (no version, uptime, db or VPN profile ids)',
    JSON.stringify(min),
  );
  const vpn = JSON.parse((await http(`${APP}/api/vpn/locations`)).body);
  check(Array.isArray(vpn.profiles) && /^https:\/\//.test(vpn.verify_url ?? ''), `/api/vpn/locations: ${vpn.profiles?.length} profiles + verify_url`);
  check(
    (vpn.profiles ?? []).every((p) => ['id', 'label', 'country_code', 'country', 'city', 'path'].every((k) => typeof p[k] === 'string') && ['up', 'down', 'unknown'].includes(p.status)),
    'every location has id, label, country, city, path and a status',
  );
  check(config.features?.vpn_gateway === (vpn.profiles?.length > 0), 'features.vpn_gateway matches the location list');
}

section('Wisp tickets and the gateway');
check(ticketRes.status === 200 && /^w1\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(ticket.ticket ?? ''), 'ticket minted on the app origin');
check(ticket.wisp_url === `${PROXY.replace(/^http/, 'ws')}/wisp/`, 'wisp_url is the proxy origin\'s /wisp/', ticket.wisp_url);
{
  const ttl = (ticket.expires_at - Date.now()) / 1000;
  check(ttl > config.wisp.ticket_ttl_s - 60 && ttl <= config.wisp.ticket_ttl_s, `ticket expires in ≈ ticket_ttl_s (${Math.round(ttl)} s)`);
}
const wsRoute = `${PROXY.replace(/^http/, 'ws')}${ROUTE}`;
if (!OFFLINE) {
  for (const [form, suffix] of [['?t=<ticket>&/', '&/'], ['?t=<ticket>/', '/'], ['?t=<ticket>', '']]) {
    const u = await upgrade(`${wsRoute}?t=${ticket.ticket}${suffix}`, PROXY);
    if (!u.ws) {
      check(false, `${ROUTE}${form} upgrades`, `${u.status} ${u.body}`);
      continue;
    }
    try {
      const r = await httpsThroughWisp(u.ws, 'example.com');
      check(r.status === 200 && r.verified, `https://example.com/ through ${ROUTE}${form}`, `HTTP ${r.status}, ${r.protocol}, certificate verified`);
    } catch (e) {
      check(false, `https://example.com/ through ${ROUTE}${form}`, e.message);
    }
    u.ws.close();
  }
  const u = await upgrade(`${wsRoute}?t=${ticket.ticket}&/`, PROXY);
  try {
    const r = u.ws ? await httpThroughWisp(u.ws, 'example.org') : { status: u.status };
    check(r.status === 200, 'http://example.org/ through Wisp', `HTTP ${r.status}`);
  } catch (e) {
    check(false, 'http://example.org/ through Wisp', e.message);
  }
  u.ws?.close();
}
const forged = ticket.ticket.slice(0, -4) + (ticket.ticket.endsWith('AAAA') ? 'BBBB' : 'AAAA');
for (const [name, query, origin, status, code] of [
  ['no ticket', '', PROXY, 401, 'wisp_ticket_missing'],
  ['empty ticket', '?t=&/', PROXY, 401, 'wisp_ticket_missing'],
  ['forged ticket', `?t=${forged}&/`, PROXY, 401, 'wisp_ticket_invalid'],
  ['malformed ticket', '?t=hello&/', PROXY, 401, 'wisp_ticket_invalid'],
  ['two t parameters', `?t=${ticket.ticket}&t=${ticket.ticket}&/`, PROXY, 401, 'wisp_ticket_invalid'],
  ['?t=<ticket>// (two slashes)', `?t=${ticket.ticket}//`, PROXY, 401, 'wisp_ticket_invalid'],
  ['Origin = app origin', `?t=${ticket.ticket}&/`, APP, 403, 'forbidden'],
  ['Origin = another site', `?t=${ticket.ticket}&/`, 'https://evil.example', 403, 'forbidden'],
  ['no Origin', `?t=${ticket.ticket}&/`, undefined, 403, 'forbidden'],
]) {
  const u = await upgrade(`${PROXY.replace(/^http/, 'ws')}/wisp/${query}`, origin);
  u.ws?.close();
  check(u.status === status && u.code === code, `upgrade refused before the upgrade: ${name} → ${status} ${code}`, u.ws ? 'upgraded!' : `${u.status} ${u.code}`);
}
for (const [name, query, status, code, method] of [
  ['valid ?t=<ticket>&/', `?t=${ticket.ticket}&/`, 426, 'upgrade_required'],
  ['valid ?t=<ticket>/', `?t=${ticket.ticket}/`, 426, 'upgrade_required'],
  ['valid ?t=<ticket>', `?t=${ticket.ticket}`, 426, 'upgrade_required'],
  ['valid, HEAD', `?t=${ticket.ticket}&/`, 426, null, 'HEAD'],
  ['forged', `?t=${forged}&/`, 401, 'wisp_ticket_invalid'],
  ['missing', '', 401, 'wisp_ticket_missing'],
  ...(process.env.GNOME_QA_EXPIRED_TICKET ? [['expired', `?t=${process.env.GNOME_QA_EXPIRED_TICKET}&/`, 401, 'wisp_ticket_expired']] : []),
]) {
  const r = await http(`${PROXY}/wisp/${query}`, { method: method ?? 'GET' }); // no Origin header
  const ok = r.status === status && (code === null || r.code === code) && (status !== 426 || r.headers.get('upgrade') === 'websocket');
  check(ok && r.headers.get('cache-control') === 'no-store', `probe ${name} → ${status}${code ? ` ${code}` : ''}`, `${r.status} ${r.code}`);
}
if (process.env.GNOME_QA_EXPIRED_TICKET) {
  const u = await upgrade(`${PROXY.replace(/^http/, 'ws')}/wisp/?t=${process.env.GNOME_QA_EXPIRED_TICKET}&/`, PROXY);
  u.ws?.close();
  check(u.status === 401 && u.code === 'wisp_ticket_expired', 'upgrade with the expired ticket → 401 wisp_ticket_expired', `${u.status} ${u.code}`);
}

section('Filter lists on both roles');
for (const origin of [APP, PROXY]) {
  const role = origin === APP ? 'app' : 'proxy';
  const idx = await http(`${origin}/api/filters`);
  const listing = JSON.parse(idx.body);
  check(idx.status === 200 && Array.isArray(listing.lists) && listing.lists.length > 0, `${role}: GET /api/filters lists ${listing.lists?.length} lists`);
  const etag = idx.headers.get('etag');
  check(!!etag && (await http(`${origin}/api/filters`, { headers: { 'If-None-Match': etag } })).status === 304, `${role}: index ETag → 304`);
  const list = listing.lists.find((l) => l.available);
  if (!list) {
    check(false, `${role}: a list has been fetched from upstream`, 'none available yet (the first refresh runs 10 s after start)');
    continue;
  }
  const body = await http(`${origin}/api/filters/${list.id}`, { headers: { 'Accept-Encoding': 'identity' } });
  check(body.status === 200 && body.headers.get('etag') === `"${list.sha256}"`, `${role}: GET /api/filters/${list.id} with ETag "<sha256>"`);
  check((await http(`${origin}/api/filters/${list.id}`, { headers: { 'If-None-Match': `"${list.sha256}"` } })).status === 304, `${role}: body If-None-Match → 304`);
  const br = await fetch(`${origin}/api/filters/${list.id}`, { headers: { 'Accept-Encoding': 'br' } });
  await br.arrayBuffer();
  check(br.headers.get('etag') === `"${list.sha256}.br"` && /accept-encoding/i.test(br.headers.get('vary') ?? ''), `${role}: brotli variant with its own ETag`);
  const pinned = await http(`${origin}/api/filters/${list.id}?v=${list.sha256}`);
  check(/immutable/.test(pinned.headers.get('cache-control') ?? ''), `${role}: ?v=<sha256> is immutable`);
}

if (ADMIN) {
  section('Admin diagnostics');
  const d = JSON.parse((await http(`${ADMIN}/admin/diagnostics`)).body);
  check(d.proxy?.isolated === true && d.proxy?.mode === 'two-origin', 'two-origin mode', JSON.stringify(d.proxy?.mode));
  check(d.fd_limit?.soft === d.fd_limit?.hard || d.fd_limit?.startup?.raised === true, 'file-descriptor soft limit is at the hard limit', JSON.stringify(d.fd_limit?.startup));
  if (!OFFLINE) check((d.ws?.relays?.zero_copy ?? 0) > 0, 'Wisp relays used zero-copy splice', JSON.stringify(d.ws?.relays));
  check((d.ws?.probes?.valid ?? 0) >= 4 && (d.ws?.probes?.rejected ?? 0) >= 2, 'probes are counted', JSON.stringify(d.ws?.probes));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
