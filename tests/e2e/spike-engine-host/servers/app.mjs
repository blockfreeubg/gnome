// APP origin of the spike (http://127.0.0.1:22080): the shell stub and the parts of the API the engine
// host interacts with (POST /api/wisp/ticket) plus two endpoints the isolation suite attacks. The CSRF
// rules mirror ARCHITECTURE §4.3: SameSite=Strict cookies, mandatory X-GNOME-Request: 1 and an Origin
// check on state-changing requests, no CORS.
import http from 'node:http';
import path from 'node:path';
import { PORTS, HOST, APP_ORIGIN, APP_ORIGIN_XSITE, PROXY_ORIGIN, TICKETS, SPIKE_DIR } from '../lib/config.mjs';
import { send, sendJson, sendFile, safeJoin, parseCookies, randomId, report, onCommand, listen } from './common.mjs';

const WEB = path.join(SPIKE_DIR, 'web', 'app');
const APP_ORIGINS = new Set([APP_ORIGIN, APP_ORIGIN_XSITE]);
let ticket = TICKETS.first;
const sessions = new Set();

function appHeaders() {
  return {
    'content-security-policy': [
      "default-src 'self'",
      `frame-src ${PROXY_ORIGIN}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

function logApi(req, extra) {
  const c = parseCookies(req.headers.cookie);
  report('app-request', {
    method: req.method,
    path: new URL(req.url, APP_ORIGIN).pathname,
    origin: req.headers.origin || null,
    secFetchSite: req.headers['sec-fetch-site'] || null,
    xGnome: req.headers['x-gnome-request'] || null,
    hasSession: Boolean(c.gnome_sid && sessions.has(c.gnome_sid)),
    cookieNames: Object.keys(c),
    ...extra,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, APP_ORIGIN);
  const p = url.pathname;
  const cookies = parseCookies(req.headers.cookie);
  const hasSession = Boolean(cookies.gnome_sid && sessions.has(cookies.gnome_sid));

  if (p.startsWith('/api/')) {
    const origin = req.headers.origin;
    const sameOrigin = origin ? APP_ORIGINS.has(origin) : true;
    if (req.method === 'OPTIONS') {
      // No CORS on the app origin: a preflight never succeeds.
      logApi(req, { outcome: 'preflight-refused' });
      return send(res, 204, '');
    }
    if (p === '/api/config' && req.method === 'GET') {
      logApi(req, { outcome: 'ok' });
      return sendJson(res, 200, { proxy: { origin: PROXY_ORIGIN }, wisp: { path: '/wisp/' } }, appHeaders());
    }
    if (p === '/api/wisp/ticket' && req.method === 'POST') {
      const ok = hasSession && sameOrigin && req.headers['x-gnome-request'] === '1';
      logApi(req, { outcome: ok ? 'ticket-issued' : 'rejected' });
      if (!ok) return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200, { ticket, expires_at: Date.now() + 86400e3, wisp_url: `${PROXY_ORIGIN.replace('http', 'ws')}/wisp/` }, { 'cache-control': 'no-store' });
    }
    if (p === '/api/secret' && req.method === 'GET') {
      // A read endpoint: responses are never readable cross-origin (no CORS), but the request itself
      // arrives with the session cookie when it is same-site; GET handlers must stay side-effect free.
      logApi(req, { outcome: hasSession ? 'served' : 'no-session' });
      if (!hasSession) return sendJson(res, 401, { error: 'unauthenticated' });
      return sendJson(res, 200, { secret: 'app-api-secret' });
    }
    if (p === '/api/state' && req.method === 'POST') {
      const ok = hasSession && sameOrigin && req.headers['x-gnome-request'] === '1';
      logApi(req, { outcome: ok ? 'state-changed' : 'rejected' });
      if (!ok) return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200, { ok: true });
    }
    logApi(req, { outcome: 'not-found' });
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (p === '/' || p === '/index.html') {
    const headers = { ...appHeaders() };
    const set = [];
    if (!hasSession) {
      const sid = randomId();
      sessions.add(sid);
      set.push(`gnome_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    }
    // A JS-readable app cookie: shows what cookie scoping (host, not port) means for dev two-origin mode.
    set.push('gnome_pref=visible-to-js; SameSite=Strict; Path=/');
    headers['set-cookie'] = set;
    return sendFile(req, res, path.join(WEB, 'index.html'), headers);
  }
  const file = safeJoin(WEB, p.slice(1));
  if (!file) return send(res, 404, 'not found\n');
  return sendFile(req, res, file, appHeaders());
});

onCommand(async (cmd, args) => {
  if (cmd === 'setTicket') { ticket = args.ticket; return { ok: true }; }
  throw new Error(`unknown command ${cmd}`);
});

await listen(server, PORTS.app, HOST);
report('listening', { role: 'app', port: PORTS.app });
