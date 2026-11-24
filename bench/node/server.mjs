#!/usr/bin/env node
// The Node.js baseline of gnome-server's three hot paths (docs/WAVE-D.md D2, §3.2): the Wisp gateway, static
// serving and the session/ticket API, built-ins only. Benchmark-only code: never shipped, imported by nothing in
// the product. Two origins (app + proxy listener), both on loopback; rate limits are not implemented (the bench
// runs gnome-server with GNOME_RATE_LIMIT_SCALE=0).
//
//   node bench/node/server.mjs --bind 127.0.0.1:P --proxy-bind 127.0.0.1:Q --static DIR --upstream 127.0.0.1:H
//        [--profile id=127.0.0.1:port]… [--workers N] [--max-ws-per-ip N] [--max-ws-per-session N]
import cluster from 'node:cluster';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AnonKey, TicketKey } from './tokens.mjs';
import { loadIndex, policies, resolve, respond, isReserved } from './static.mjs';
import { makeApi, apiError, notFound } from './api.mjs';
import { makeGateway } from './gateway.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', '..', 'backend', 'tests', 'fixtures', 'proxy-origin-csp.json');

const { values: o } = parseArgs({
  options: {
    bind: { type: 'string' },
    'proxy-bind': { type: 'string' },
    static: { type: 'string' },
    upstream: { type: 'string' },
    profile: { type: 'string', multiple: true, default: [] },
    workers: { type: 'string', default: '1' },
    'max-ws-per-ip': { type: 'string', default: '32' },
    'max-ws-per-session': { type: 'string', default: '16' },
    'ticket-ttl': { type: 'string', default: '3600' },
  },
});
const hostPort = (s) => {
  const i = s.lastIndexOf(':');
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
};
for (const k of ['bind', 'proxy-bind', 'static', 'upstream']) if (!o[k]) throw new Error(`--${k} is required`);
const app = hostPort(o.bind);
const proxy = hostPort(o['proxy-bind']);
for (const l of [app, proxy]) if (!/^127\./.test(l.host)) throw new Error('the Node baseline listens on loopback only');

const workers = Number(o.workers);
if (cluster.isPrimary && workers > 1) {
  // One secret and one start time for every worker (gnome-server is one process).
  process.env.BENCH_NODE_SECRET ??= randomBytes(32).toString('base64');
  process.env.BENCH_NODE_STARTED ??= String(Math.floor(Date.now() / 1000));
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (w, code, sig) => {
    console.error(`worker ${w.process.pid} exited (${code ?? sig})`);
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    for (const w of Object.values(cluster.workers)) w.kill('SIGTERM');
    process.exit(0);
  });
} else {
  start();
}

function start() {
  const master = process.env.BENCH_NODE_SECRET ? Buffer.from(process.env.BENCH_NODE_SECRET, 'base64') : randomBytes(32);
  const startedS = Number(process.env.BENCH_NODE_STARTED ?? Math.floor(Date.now() / 1000));
  const appOrigin = `http://${app.host}:${app.port}`;
  const proxyOrigin = `http://${proxy.host}:${proxy.port}`;
  const upstreams = new Map([['direct', hostPort(o.upstream)]]);
  const profiles = new Map();
  for (const p of o.profile) {
    const [id, addr] = p.split('=');
    upstreams.set(id, hostPort(addr));
    profiles.set(id, { id, label: id, countryCode: 'se', city: id });
  }
  const ttl = Number(o['ticket-ttl']);
  const profileMints = new Map();
  const st = {
    anonKey: new AnonKey(master),
    ticketKey: new TicketKey(master),
    startedS,
    appOrigin,
    proxyOrigin,
    upstreams,
    profiles,
    ticketTtlS: ttl,
    maxWsPerIp: Number(o['max-ws-per-ip']),
    maxWsPerSession: Number(o['max-ws-per-session']),
    recordProfileMint(sref, iat) {
      profileMints.set(sref.toString('hex'), { iat, until: iat + ttl });
    },
    supersedes(sref, iat) {
      const m = profileMints.get(sref.toString('hex'));
      if (!m) return false;
      if (m.until <= Date.now() / 1000) {
        profileMints.delete(sref.toString('hex'));
        return false;
      }
      return iat < m.iat;
    },
  };
  const pol = { ...policies(FIXTURE, appOrigin, proxyOrigin), appOriginsAttr: appOrigin };
  const idx = loadIndex(o.static, pol);
  const api = makeApi(st);
  const gw = makeGateway(st);
  const ridPrefix = randomBytes(6).toString('base64url');
  let rid = 0;

  // The security headers every response gets (ARCHITECTURE §4.4), by listener role.
  function security(h, role) {
    h['x-content-type-options'] ??= 'nosniff';
    h['referrer-policy'] ??= 'no-referrer';
    if (role === 'proxy') {
      delete h['x-frame-options'];
      h['content-security-policy'] ??= pol.proxyInert;
      return h;
    }
    const html = (h['content-type'] ?? '').toLowerCase().startsWith('text/html');
    const shell = html && !h['content-security-policy'];
    h['x-frame-options'] ??= shell ? 'DENY' : 'SAMEORIGIN';
    if (html) {
      h['cross-origin-opener-policy'] ??= 'same-origin';
      h['permissions-policy'] ??= PERMISSIONS_POLICY;
    }
    if (!h['content-security-policy']) h['content-security-policy'] = html ? pol.shell([]) : pol.appFrameAncestors;
    return h;
  }

  function wispProfile(p) {
    if (p === '/wisp' || p === '/wisp/') return { profile: null };
    const m = /^\/wisp\/p\/([^/]+)\/?$/.exec(p);
    if (!m) return null;
    try {
      return { profile: decodeURIComponent(m[1]) };
    } catch {
      return null;
    }
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((ok, fail) => {
      const chunks = [];
      let n = 0;
      req.on('data', (d) => {
        n += d.length;
        if (n > limit) {
          fail(new Error('too large'));
          req.destroy();
        } else chunks.push(d);
      });
      req.on('end', () => ok(Buffer.concat(chunks)));
      req.on('error', fail);
    });
  }

  function makeHandler(role) {
    return async (req, res, upgrade = null) => {
      const h0 = { 'x-request-id': `${ridPrefix}-${++rid}` };
      const finish = (status, headers, body, head = false) => {
        const h = security({ ...headers, ...h0 }, role);
        if (upgrade) {
          upgrade.writeError(status, h, body);
          return;
        }
        if (body && !Buffer.isBuffer(body)) {
          res.writeHead(status, h);
          body.pipe(res);
          return;
        }
        if (body && h['content-length'] === undefined) h['content-length'] = String(body.length);
        if (!body && h['content-length'] === undefined && status !== 304 && status !== 204) h['content-length'] = '0';
        res.writeHead(status, h);
        res.end(head ? undefined : body ?? undefined);
      };
      const send = (r) => finish(r.status, r.headers, r.body, req.method === 'HEAD');
      const p = req.url.split('?')[0];
      if (req.method !== 'GET' && req.method !== 'HEAD' && !upgrade) {
        if (req.headers['x-gnome-request'] !== '1') return send(apiError(403, 'forbidden', 'missing X-GNOME-Request: 1 header'));
        const origin = req.headers.origin;
        if (origin && origin !== appOrigin && origin !== proxyOrigin) return send(apiError(403, 'forbidden', 'origin not allowed'));
      }
      if (role === 'proxy') {
        const w = wispProfile(p);
        if (w) {
          return gw.handle(req, w.profile, {
            send,
            socket: upgrade?.socket,
            head: upgrade?.head,
            writeRaw: (status, headers) => upgrade.write101(security(Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), v])), role), h0),
          });
        }
      }
      if (role === 'app' && p.startsWith('/api/')) {
        let body = Buffer.alloc(0);
        if (req.method === 'POST') {
          try {
            body = await readBody(req);
          } catch {
            return send(apiError(413, 'payload_too_large', 'the body is too large'));
          }
        }
        const r = api.handle(req, p, body);
        if (r) return send(r);
        return send(notFound());
      }
      let decoded = p;
      try {
        decoded = decodeURIComponent(p);
      } catch {
        /* lossy: keep the raw path */
      }
      if (isReserved(p) || isReserved(decoded)) return send(notFound());
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const r = apiError(405, 'method_not_allowed', 'method not allowed');
        r.headers.allow = 'GET, HEAD';
        return send(r);
      }
      const r = resolve(idx, p, role);
      if (r.kind === 'file') return respond(r.e, req, res, role, finish);
      if (r.kind === 'reserved') return send(notFound());
      if (r.kind === 'engine-unavailable') return finish(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' }, Buffer.from('the proxy engine is starting\n'));
      if (r.kind === 'notbuilt') return finish(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, Buffer.from('not built\n'));
      return finish(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' }, Buffer.from('404 Not Found\n'));
    };
  }

  const reason = (s) => http.STATUS_CODES[s] ?? '';
  for (const [role, l] of [['app', app], ['proxy', proxy]]) {
    const handler = makeHandler(role);
    const server = http.createServer({ keepAliveTimeout: 75_000, requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => {
      handler(req, res).catch((e) => {
        console.error(e);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      const raw = (status, h, body) => {
        const lines = [`HTTP/1.1 ${status} ${reason(status)}`];
        for (const [k, v] of Object.entries(h)) for (const x of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${x}`);
        lines.push(`date: ${new Date().toUTCString()}`);
        return `${lines.join('\r\n')}\r\n\r\n`;
      };
      const upgrade = {
        socket,
        head,
        writeError(status, h, body) {
          if (body && h['content-length'] === undefined) h['content-length'] = String(body.length);
          socket.end(Buffer.concat([Buffer.from(raw(status, h)), body ?? Buffer.alloc(0)]));
        },
        write101(h, h0) {
          socket.write(raw(101, { ...h, ...h0 }));
        },
      };
      handler(req, null, upgrade).catch(() => socket.destroy());
    });
    server.listen(l.port, l.host, () => {
      const a = server.address();
      if (!/^127\./.test(a.address)) {
        console.error('refusing a non-loopback listener');
        process.exit(1);
      }
      console.error(`node baseline ${role} listening on ${a.address}:${a.port} (pid ${process.pid})`);
    });
  }
}

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), display-capture=(), screen-wake-lock=(), idle-detection=(), publickey-credentials-get=(), publickey-credentials-create=(), otp-credentials=(), identity-credentials-get=(), xr-spatial-tracking=(), local-fonts=(), window-management=()';
