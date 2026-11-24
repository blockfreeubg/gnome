// The --check request list (docs/WAVE-D.md §3.2): ≈ 40 fixed requests sent to gnome-server and to the Node
// baseline over raw sockets; status and every response header are compared, except the values of Date and
// x-request-id, the ETag form (both servers hash the same files, so the values are compared too, but only the
// form is required), and the values of cookies and tickets (random per server; their form is compared).
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** One raw HTTP/1.1 exchange (Connection: close). Returns {status, headers: [[lower, value]…], body: Buffer}. */
export function rawRequest(port, text, { timeoutMs = 5000, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return reject(new Error(`no response head from :${port}`));
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const headers = lines.slice(1).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
      });
      resolve({ status, headers, body: buf.subarray(end + 4) });
    };
    const timer = setTimeout(finish, timeoutMs);
    s.on('data', (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      // A 101 never ends by itself: stop at its head; others end at Content-Length (keep-alive answers).
      const head = buf.subarray(0, end).toString('latin1');
      if (/^HTTP\/1\.1 101 /.test(head)) return finish();
      const m = /\r\ncontent-length:\s*(\d+)/i.exec(head);
      if (m && buf.length - end - 4 >= Number(m[1]) && !/^HEAD /.test(text)) finish();
      if (/^HEAD /.test(text) || /^HTTP\/1\.1 (304|204) /.test(head)) finish();
    });
    s.on('end', finish);
    s.on('close', finish);
    s.on('error', (e) => (chunks.length ? finish() : reject(e)));
    s.write(text);
  });
}

function req(method, p, host, headers = [], body = '') {
  const h = [`${method} ${p} HTTP/1.1`, `Host: ${host}`, ...(headers.some((x) => /^connection:/i.test(x)) ? [] : ['Connection: close']), ...headers];
  if (method === 'POST') h.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return `${h.join('\r\n')}\r\n\r\n${body}`;
}

const wsKey = () => randomBytes(16).toString('base64');
const upgradeHeaders = (origin) => [
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Key: ${wsKey()}`,
  'Sec-WebSocket-Version: 13',
  ...(origin ? [`Origin: ${origin}`] : []),
];

/** Pick fixed files from a dist directory: a hashed JS asset, a hashed CSS asset, the large vendor file. */
export function pickFiles(dist) {
  const assets = readdirSync(path.join(dist, 'assets')).filter((f) => !/\.(br|gz)$/.test(f)).sort();
  const js = assets.filter((f) => f.endsWith('.js')).sort((a, b) => statSync(path.join(dist, 'assets', b)).size - statSync(path.join(dist, 'assets', a)).size);
  const css = assets.find((f) => f.endsWith('.css'));
  // H1 (a)-(c): a mid-sized hashed asset (kept in memory by both servers: ≤ 256 KiB).
  const mid = js.find((f) => statSync(path.join(dist, 'assets', f)).size <= 200 * 1024) ?? js[0];
  return { asset: `/assets/${mid}`, css: `/assets/${css}`, vendor: '/vendor/libcurl-transport/index.js' };
}

/**
 * The fixed cases. `ctx` = {app, proxy (ports), appOrigin, proxyOrigin, files, profile (a configured VPN id)}.
 * Cases may depend on earlier ones through `state` (the session cookie, a ticket, an ETag).
 */
export function cases(ctx) {
  const A = `127.0.0.1:${ctx.app}`;
  const P = `127.0.0.1:${ctx.proxy}`;
  const f = ctx.files;
  const c = [];
  const add = (name, port, build, after) => c.push({ name, port, build, after });
  const app = ctx.app, proxy = ctx.proxy;
  add('index br', app, () => req('GET', '/', A, ['Accept-Encoding: br, gzip']));
  add('index identity', app, () => req('GET', '/', A));
  add('HEAD index', app, () => req('HEAD', '/', A));
  add('SPA fallback /browse', app, () => req('GET', '/browse', A, ['Accept-Encoding: gzip']));
  add('SPA fallback /settings/x', app, () => req('GET', '/settings/x', A));
  add('asset br', app, () => req('GET', f.asset, A, ['Accept-Encoding: gzip, deflate, br']), (r, s) => (s.etagBr = get(r, 'etag')));
  add('asset gzip', app, () => req('GET', f.asset, A, ['Accept-Encoding: gzip']));
  add('asset identity', app, () => req('GET', f.asset, A, ['Accept-Encoding: identity']), (r, s) => (s.etag = get(r, 'etag')));
  add('asset br;q=0', app, () => req('GET', f.asset, A, ['Accept-Encoding: br;q=0, gzip']));
  add('asset 304', app, (s) => req('GET', f.asset, A, [`If-None-Match: ${s.etag}`]));
  add('asset 304 br', app, (s) => req('GET', f.asset, A, ['Accept-Encoding: br', `If-None-Match: W/${s.etagBr}`]));
  add('css asset', app, () => req('GET', f.css, A, ['Accept-Encoding: br']));
  add('asset on proxy', proxy, () => req('GET', f.asset, P, ['Accept-Encoding: br']));
  add('missing asset 404', app, () => req('GET', '/assets/missing-0000.js', A));
  add('missing file 404', app, () => req('GET', '/nope.png', A));
  add('manifest', app, () => req('GET', '/manifest.webmanifest', A));
  add('POST / 405', app, () => req('POST', '/', A));
  add('sw.js on proxy', proxy, () => req('GET', '/sw.js', P, ['Accept-Encoding: br']));
  add('sw.js on app 404', app, () => req('GET', '/sw.js', A));
  add('vendor br (large)', proxy, () => req('GET', f.vendor, P, ['Accept-Encoding: br']));
  add('vendor identity (large)', proxy, () => req('GET', f.vendor, P));
  add('vendor on app 404', app, () => req('GET', f.vendor, A));
  add('engine host', proxy, () => req('GET', '/engine/', P, ['Accept-Encoding: br']));
  add('engine host deep', proxy, () => req('GET', '/engine/x/y', P));
  add('SPA path on proxy 404', proxy, () => req('GET', '/browse', P));
  add('reserved /api 404', app, () => req('GET', '/api/nope', A));
  add('reserved encoded /%61pi 404', app, () => req('GET', '/%61pi/x', A));
  add('reserved /admin 404', app, () => req('GET', '/admin', A));
  add('api config', app, () => req('GET', '/api/config', A));
  add('api session (none)', app, () => req('GET', '/api/session', A));
  add('ticket without header 403', app, () => req('POST', '/api/wisp/ticket', A));
  add('ticket mint (anonymous)', app, () => req('POST', '/api/wisp/ticket', A, ['X-GNOME-Request: 1']), (r, s) => {
    s.cookie = (get(r, 'set-cookie') ?? '').split(';')[0];
    try {
      s.ticket = JSON.parse(r.body.toString()).ticket;
    } catch {
      s.ticket = '';
    }
  });
  add('ticket mint (session)', app, (s) => req('POST', '/api/wisp/ticket', A, ['X-GNOME-Request: 1', `Cookie: ${s.cookie}`, 'Content-Type: application/json'], '{"route":"default"}'));
  add('ticket bad JSON 400', app, (s) => req('POST', '/api/wisp/ticket', A, ['X-GNOME-Request: 1', `Cookie: ${s.cookie}`], '{'));
  add('ticket unknown route 422', app, (s) => req('POST', '/api/wisp/ticket', A, ['X-GNOME-Request: 1', `Cookie: ${s.cookie}`], '{"route":{"profile":"nope"}}'));
  add('ticket profile route', app, (s) => req('POST', '/api/wisp/ticket', A, ['X-GNOME-Request: 1', `Cookie: ${s.cookie}`], JSON.stringify({ route: { profile: ctx.profile } })), (r, s) => {
    try {
      s.profileTicket = JSON.parse(r.body.toString()).ticket;
    } catch {
      s.profileTicket = '';
    }
  });
  add('api session (cookie)', app, (s) => req('GET', '/api/session', A, [`Cookie: ${s.cookie}`]));
  add('probe valid 426', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P));
  add('probe missing 401', proxy, () => req('GET', '/wisp/', P));
  add('probe malformed 401', proxy, () => req('GET', '/wisp/?t=w2.1.2.d.x.y&/', P));
  add('probe bad mac 401', proxy, (s) => req('GET', `/wisp/?t=${s.ticket.slice(0, -2)}AA&/`, P));
  add('probe two tickets 401', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&t=${s.ticket}&/`, P));
  add('probe wrong route 401', proxy, (s) => req('GET', `/wisp/p/${ctx.profile}/?t=${s.ticket}&/`, P));
  add('probe profile ticket on direct 401', proxy, (s) => req('GET', `/wisp/?t=${s.profileTicket}&/`, P));
  add('probe unknown profile 404', proxy, (s) => req('GET', `/wisp/p/nope/?t=${s.ticket}&/`, P));
  add('upgrade without Origin 403', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P, upgradeHeaders(null)));
  add('upgrade app Origin 403', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P, upgradeHeaders(ctx.appOrigin)));
  add('upgrade bad version 426', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P, ['Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${wsKey()}`, 'Sec-WebSocket-Version: 8', `Origin: ${ctx.proxyOrigin}`]));
  add('upgrade bad key 400', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P, ['Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Key: short', 'Sec-WebSocket-Version: 13', `Origin: ${ctx.proxyOrigin}`]));
  add('upgrade without ticket 401', proxy, () => req('GET', '/wisp/', P, upgradeHeaders(ctx.proxyOrigin)));
  add('upgrade succeeds 101', proxy, (s) => req('GET', `/wisp/?t=${s.ticket}&/`, P, upgradeHeaders(ctx.proxyOrigin)));
  return c;
}

export const get = (r, name) => r.headers.find(([k]) => k === name)?.[1];

const IGNORE_VALUE = new Set(['date', 'x-request-id', 'sec-websocket-accept']);
// Values that are random per server: compare their form.
const FORMS = {
  etag: /^"[A-Za-z0-9_-]{22}(-br|-gz)?"$/,
  'set-cookie': /^__Host-gnome_sid=v1\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
};

/** Replace a server's own origins (and ports) with placeholders so CSP strings and URLs compare. */
export function normalizer(appOrigin, proxyOrigin) {
  return (v) => v.replaceAll(appOrigin, '<app-origin>').replaceAll(proxyOrigin, '<proxy-origin>');
}

/** Compare two responses; returns a list of differences (empty = equivalent). */
export function compare(a, b, na = (v) => v, nb = (v) => v) {
  const diffs = [];
  if (a.status !== b.status) diffs.push(`status ${a.status} ≠ ${b.status}`);
  const names = new Set([...a.headers.map(([k]) => k), ...b.headers.map(([k]) => k)]);
  for (const n of names) {
    const va = a.headers.filter(([k]) => k === n).map(([, v]) => v);
    const vb = b.headers.filter(([k]) => k === n).map(([, v]) => v);
    if (va.length !== vb.length) {
      diffs.push(`${n}: ${JSON.stringify(va)} ≠ ${JSON.stringify(vb)}`);
      continue;
    }
    if (IGNORE_VALUE.has(n)) continue;
    if (n === 'content-length' && a.status === 200 && b.status === 200 && va[0] !== vb[0]) {
      // Same file, same encoding → same length; JSON bodies may differ in length (session ids, times).
      if (!(get(a, 'content-type') ?? '').startsWith('application/json')) diffs.push(`content-length: ${va[0]} ≠ ${vb[0]}`);
      continue;
    }
    if (n === 'content-length') continue;
    if (FORMS[n]) {
      for (const [i, v] of va.entries()) {
        if (!FORMS[n].test(v) || !FORMS[n].test(vb[i])) diffs.push(`${n} form: ${v} | ${vb[i]}`);
      }
      continue;
    }
    for (const [i, v] of va.entries()) if (na(v) !== nb(vb[i])) diffs.push(`${n}: ${na(v)} ≠ ${nb(vb[i])}`);
  }
  return diffs;
}

/** Body shape of JSON responses: the sorted key paths (values differ by design). */
export function jsonShape(r) {
  if (!(get(r, 'content-type') ?? '').startsWith('application/json')) return null;
  try {
    const walk = (v, p, out) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`, out);
      else out.push(p);
      return out;
    };
    return walk(JSON.parse(r.body.toString()), '', []).sort().join(',');
  } catch {
    return 'invalid JSON';
  }
}

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
