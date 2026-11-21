// PROXY origin of the spike (http://127.0.0.1:22081): engine host, service worker, vendor files, the
// /wisp/ gateway stub and the 503 page for engine prefixes. Mirrors ARCHITECTURE §4.4/§4.6 and API.md
// ("Proxy origin" + "Wisp"). Runs as a child process of run.mjs so the transport suite can kill it hard
// and restart it (the gateway dies together with the static routes, as gnome-server would).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {
  PORTS, HOST, PROXY_ORIGIN, APP_ORIGIN, APP_ORIGIN_XSITE, TICKETS, WISP_ROUTES, SPIKE_DIR, NODE_MODULES, VENDOR,
} from '../lib/config.mjs';
import { send, sendJson, sendFile, safeJoin, readBody, report, onCommand, listen } from './common.mjs';

const WEB = path.join(SPIKE_DIR, 'web', 'proxy');
const ENGINE_PREFIXES = ['/~/sj/', '/uv/service/'];
const frameAncestors = (process.env.SPIKE_FRAME_ANCESTORS || `${APP_ORIGIN} ${APP_ORIGIN_XSITE}`).trim();
// SPIKE_ENGINE_HOST_CSP (leak suite, "hostcsp" part): extra CSP directives for the engine host document /engine/.
const engineHostCsp = (process.env.SPIKE_ENGINE_HOST_CSP || '').trim();
const allowedWispOrigins = new Set([PROXY_ORIGIN]);
let validTickets = new Set(JSON.parse(process.env.SPIKE_TICKETS || 'null') || [TICKETS.first]);
const live = new Set(); // spliced Wisp connections: {client, upstream, route, at}
let upgrades = 0;

const baseHeaders = {
  // API.md "Proxy origin": frame-ancestors <app origin>, no X-Frame-Options.
  'content-security-policy': `frame-ancestors ${frameAncestors}`,
  'x-content-type-options': 'nosniff',
};

function engine503(res, pathname) {
  report('engine-prefix-fallthrough', { path: pathname.slice(0, 160) });
  // Small page that re-registers the SW and retries a few times; never the SPA (API.md "Proxy origin").
  const html = `<!doctype html><meta charset="utf-8"><title>Reconnecting</title>
<p>The proxy engine was not ready for this page. Retrying.</p>
<script src="/engine/retry-503.js"></script>`;
  send(res, 503, html, { ...baseHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' });
}

// Strict ticket parsing (the default; SPIKE_GATEWAY_STRICT=0 or setStrict {strict:false} selects the old lenient
// URLSearchParams parse): exactly like the Rust gateway's ticket_param (backend/src/gateway/mod.rs as changed in
// session 4): the first "t=" pair of the raw query, ONE trailing "/" stripped, then percent-decoded (an invalid
// escape stays literal, non-UTF-8 is invalid); two "t=" pairs are ambiguous. The canonical form is ?t=<ticket>&/.
// (Session 3's Rust parser did not strip the "/", so "?t=<ticket>/" failed the MAC there.)
let strictTickets = process.env.SPIKE_GATEWAY_STRICT !== '0';
// Probe order. 'stub' (default) = the Rust gateway since session 4: a plain GET/HEAD of a Wisp route answers 401 for a
// missing/invalid ticket and 426 for a valid one, without an Origin check. 'legacy' (SPIKE_GATEWAY_PROBE=legacy;
// 'rust' is accepted as an old alias) = the session-3 Rust order, which answered 426 to every plain GET.
const probeOrderOf = (v) => (v === 'legacy' || v === 'rust' ? 'legacy' : 'stub');
let probeOrder = probeOrderOf(process.env.SPIKE_GATEWAY_PROBE);
function percentDecode(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s.slice(i + 1, i + 3);
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; } else bytes.push(...Buffer.from(s[i]));
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return null; }
}
function strictTicketOf(url) {
  const pairs = url.search.replace(/^\?/, '').split('&');
  let found = null;
  for (const pair of pairs) {
    if (!pair.startsWith('t=')) continue;
    if (found !== null) return { ticket: null, form: 'ambiguous' };
    found = pair.slice(2);
  }
  if (found === null) return { ticket: null, form: 'none' };
  const form = found.endsWith('/') ? 'query+slash' : pairs.includes('/') ? 'query+amp-slash' : 'query';
  const raw = found.endsWith('/') ? found.slice(0, -1) : found;
  if (!raw) return { ticket: null, form: 'none' };
  return { ticket: percentDecode(raw), form };
}

function ticketOf(url) {
  if (strictTickets) return strictTicketOf(url);
  // Accepts ?t=<ticket> and ?t=<ticket>/ : libcurl-transport (1.x and 2.x) and libcurl.js refuse Wisp URLs
  // that do not END with "/", so the ticketed URL handed to libcurl carries one trailing slash.
  const raw = url.searchParams.get('t');
  if (raw === null) return { ticket: null, form: 'none' };
  if (raw.endsWith('/')) return { ticket: raw.slice(0, -1), form: 'query+slash' };
  return { ticket: raw, form: 'query' };
}

async function handle(req, res) {
  const url = new URL(req.url, PROXY_ORIGIN);
  const p = url.pathname;
  if (WISP_ROUTES[p]) {
    // Plain HTTP on a Wisp route: 401 for a missing/invalid ticket, 426 for a valid one. The engine host
    // uses this to tell "ticket rejected" from "gateway down" after a failed reconnect (WebSockets hide
    // the status of a refused upgrade).
    // probeOrder 'legacy' (setStrict {probeOrder} / SPIKE_GATEWAY_PROBE=legacy): the session-3 Rust gateway checked
    // "is this an upgrade" BEFORE the ticket, so a plain GET always got 426 there.
    if (probeOrder === 'legacy') return sendJson(res, 426, { error: 'upgrade_required' }, { ...baseHeaders, 'cache-control': 'no-store' });
    const { ticket } = ticketOf(url);
    if (!ticket || !validTickets.has(ticket)) return sendJson(res, 401, { error: 'ticket_invalid' }, { ...baseHeaders, 'cache-control': 'no-store' });
    return sendJson(res, 426, { error: 'upgrade_required' }, { ...baseHeaders, 'cache-control': 'no-store' });
  }
  if (ENGINE_PREFIXES.some((pre) => p.startsWith(pre))) return engine503(res, p);
  if (p === '/sw.js') {
    return sendFile(req, res, path.join(WEB, 'sw.js'), { ...baseHeaders, 'service-worker-allowed': '/', 'cache-control': 'no-cache' });
  }
  if (p === '/engine') return send(res, 308, '', { ...baseHeaders, location: '/engine/' });
  if (p.startsWith('/engine/')) {
    const rel = p.slice('/engine/'.length);
    if (rel === '' || !rel.split('/').pop().includes('.')) {
      // The allowed app origins are templated in so the host can check the parent's origin on "connect".
      const doc = fs.readFileSync(path.join(WEB, 'engine', 'index.html'), 'utf8').replace('%GNOME_APP_ORIGINS%', frameAncestors);
      const hostCsp = engineHostCsp ? { 'content-security-policy': `frame-ancestors ${frameAncestors}; ${engineHostCsp}` } : {};
      return send(res, 200, doc, { ...baseHeaders, ...hostCsp, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    }
    const file = safeJoin(path.join(WEB, 'engine'), rel);
    if (!file) return send(res, 404, 'not found\n', baseHeaders);
    return sendFile(req, res, file, baseHeaders);
  }
  if (p.startsWith('/vendor/')) {
    const [, , name, ...rest] = p.split('/');
    const dir = VENDOR[name];
    if (!dir || rest.length === 0) return send(res, 404, 'not found\n', baseHeaders);
    const root = path.join(NODE_MODULES, dir);
    const file = safeJoin(root, rest.join('/'));
    if (!file) return send(res, 404, 'not found\n', baseHeaders);
    return sendFile(req, res, file, baseHeaders);
  }
  if (p === '/api/health') return sendJson(res, 200, { status: 'ok', role: 'proxy' }, baseHeaders);
  if (p === '/api/filters') return sendJson(res, 200, { lists: [] }, baseHeaders);
  if (p === '/__csp-report' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req, 64 << 10)).toString('utf8') || '{}');
    } catch { /* ignore malformed reports */ }
    const r = body['csp-report'] || body;
    report('csp-report', {
      documentUri: String(r['document-uri'] || r.documentURL || '').slice(0, 300),
      blockedUri: String(r['blocked-uri'] || r.blockedURL || '').slice(0, 300),
      directive: String(r['effective-directive'] || r['violated-directive'] || r.effectiveDirective || ''),
      disposition: String(r.disposition || ''),
      sample: String(r['script-sample'] || r.sample || '').slice(0, 120),
    });
    return send(res, 204, '', baseHeaders);
  }
  return send(res, 404, 'not found\n', { ...baseHeaders, 'content-type': 'text/plain' });
}

function rejectUpgrade(socket, status, reason, body = '') {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

// Gateway stub (ARCHITECTURE §4.4 contract, verified against HolyWisp in docs/research/holywisp.md §6.2).
function onUpgrade(req, socket, head) {
  const url = new URL(req.url, PROXY_ORIGIN);
  const routeKey = WISP_ROUTES[url.pathname];
  const { ticket, form } = ticketOf(url);
  const rec = {
    n: ++upgrades,
    path: url.pathname,
    query: url.search.replace(/t=[^&]+/, 't=<redacted>'),
    ticketForm: form,
    ticketTail: ticket ? ticket.slice(-6) : null,
    origin: req.headers.origin || null,
    protocol: req.headers['sec-websocket-protocol'] || null,
    hadCookie: Boolean(req.headers.cookie),
  };
  socket.on('error', () => {});
  if (!routeKey) {
    report('wisp-upgrade', { ...rec, status: 404 });
    return rejectUpgrade(socket, 404, 'Not Found', '{"error":"not_found"}');
  }
  if (!allowedWispOrigins.has(req.headers.origin)) {
    report('wisp-upgrade', { ...rec, status: 403 });
    return rejectUpgrade(socket, 403, 'Forbidden', '{"error":"origin"}');
  }
  if (!ticket || !validTickets.has(ticket)) {
    report('wisp-upgrade', { ...rec, status: 401 });
    return rejectUpgrade(socket, 401, 'Unauthorized', '{"error":"ticket_invalid"}');
  }
  const upstreamPort = PORTS[routeKey];
  const upstream = net.connect(upstreamPort, '127.0.0.1'); // never "localhost" (§4.4)
  upstream.on('error', () => {});
  const lines = [
    `GET ${url.pathname} HTTP/1.1`, // ticket query stripped
    `Host: 127.0.0.1:${upstreamPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] || ''}`,
    `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || ''}`,
  ];
  if (req.headers['sec-websocket-protocol']) lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
  // Every client forwarding header is dropped; exactly one bare client IP is written. Cookie and
  // Authorization are never forwarded.
  const ip = (req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '');
  lines.push(`X-Forwarded-For: ${ip}`);
  upstream.write(lines.join('\r\n') + '\r\n\r\n');
  if (head && head.length) upstream.write(head);
  let buf = Buffer.alloc(0);
  let settled = false;
  const timer = setTimeout(() => fail('timeout'), 5000);
  const fail = (why) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    report('wisp-upgrade', { ...rec, status: 502, why });
    upstream.destroy();
    rejectUpgrade(socket, 502, 'Bad Gateway', '{"error":"upstream"}');
  };
  upstream.on('close', () => fail('upstream closed'));
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 8192) fail('head too large');
      return;
    }
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    upstream.off('data', onData);
    const status = Number(buf.subarray(0, end).toString('latin1').split(' ')[1]);
    if (status !== 101) {
      report('wisp-upgrade', { ...rec, status: 502, upstreamStatus: status });
      upstream.destroy();
      return rejectUpgrade(socket, 502, 'Bad Gateway', '{"error":"upstream"}');
    }
    report('wisp-upgrade', { ...rec, status: 101, route: routeKey });
    const conn = { client: socket, upstream, route: routeKey, at: Date.now() };
    live.add(conn);
    const done = () => {
      if (!live.delete(conn)) return;
      report('wisp-close', { n: rec.n, route: routeKey, ms: Date.now() - conn.at });
      socket.destroy();
      upstream.destroy();
    };
    socket.on('close', done);
    upstream.on('close', done);
    socket.write(buf); // 101 head + the first Wisp frame that follows it immediately
    upstream.pipe(socket);
    socket.pipe(upstream);
  };
  upstream.on('data', onData);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, String(e), baseHeaders); } catch { /* socket gone */ }
  });
});
server.on('upgrade', onUpgrade);
server.keepAliveTimeout = 5000;

onCommand(async (cmd, args) => {
  switch (cmd) {
    case 'dropWisp': {
      const n = live.size;
      for (const c of [...live]) { c.client.destroy(); c.upstream.destroy(); }
      return { dropped: n };
    }
    case 'setTickets':
      validTickets = new Set(args.tickets);
      return { tickets: args.tickets.length };
    case 'stats':
      return { live: live.size, upgrades, strict: strictTickets, probeOrder };
    case 'setStrict':
      if (args.strict !== undefined) strictTickets = !!args.strict;
      if (args.probeOrder) probeOrder = probeOrderOf(args.probeOrder);
      return { strict: strictTickets, probeOrder };
    default:
      throw new Error(`unknown command ${cmd}`);
  }
});

await listen(server, PORTS.proxy, HOST);
report('listening', { role: 'proxy', port: PORTS.proxy });
