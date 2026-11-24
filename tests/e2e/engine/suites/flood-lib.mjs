// Helpers of the cookie-flood suite (WAVE-D §6.4, rows CF1–CF9): a TLS front with a large head limit that logs
// Cookie header sizes, raw-socket requests from a chosen loopback source address, cookie planting in a page, and the
// M2 probe (`connections` in /admin/diagnostics).
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { onCleanup } from './backend-lib.mjs';

/** Whether the server has WAVE-D M2 (connection caps, head limits): its diagnostics carry `connections`. */
export async function hasM2(adminOrigin) {
  try {
    const res = await fetch(`${adminOrigin}/admin/diagnostics`);
    const d = await res.json();
    return typeof d.connections === 'object' && d.connections !== null;
  } catch {
    return false;
  }
}

/**
 * A TLS-terminating front like backend-https.mjs's, but with heads up to 4 MiB (Caddy's `max_header_size 4MB`,
 * WAVE-D D16) and a log of every forwarded request's Cookie header length per host (`cookieBytes`).
 */
export async function startFloodFront({ port, upstream, key, cert }) {
  const [uHost, uPort] = upstream.split(':');
  const seen = [];
  const headers = (req) => {
    const h = { ...req.headers };
    for (const k of Object.keys(h)) if (k.startsWith('x-forwarded-')) delete h[k];
    h['x-forwarded-proto'] = 'https';
    h['x-forwarded-host'] = req.headers.host ?? '';
    h['x-forwarded-for'] = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1';
    seen.push({ host: (req.headers.host ?? '').split(':')[0], path: req.url.split('?')[0], cookieBytes: (req.headers.cookie ?? '').length });
    if (seen.length > 5000) seen.splice(0, 1000);
    return h;
  };
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert), maxHeaderSize: 4 * 1024 * 1024 }, (req, res) => {
    const up = http.request({ host: uHost, port: Number(uPort), method: req.method, path: req.url, headers: headers(req), maxHeaderSize: 4 * 1024 * 1024 }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.rawHeaders);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(Number(uPort), uHost, () => {
      const h = headers(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`])), '', ''];
      up.write(lines.join('\r\n'));
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  onCleanup(close);
  return { close, seen, maxCookieBytes: (host) => Math.max(0, ...seen.filter((s) => s.host === host).map((s) => s.cookieBytes)) };
}

/**
 * Sends `raw` from the local address `src` to 127.0.0.1:`port` and resolves to the answer's status line (or '' when
 * the connection closed without one). Writes and reads at once: a refused head is answered before it is all sent.
 */
export function rawRequest(port, raw, src = '127.0.0.1') {
  return new Promise((resolve) => {
    let buf = '';
    const s = net.connect({ port, host: '127.0.0.1', localAddress: src }, () => s.write(raw, () => {}));
    s.setEncoding('latin1');
    s.on('data', (d) => {
      buf += d;
    });
    const done = () => resolve(buf);
    s.on('end', done);
    s.on('close', done);
    s.on('error', () => {});
    s.setTimeout(10_000, () => s.destroy());
  });
}

/** A request head of about `bytes` carried by cookies of 3.9 KB. */
export function floodedHead({ path = '/api/health', host, bytes, extra = '' }) {
  const n = Math.ceil(bytes / 3900);
  const cookies = Array.from({ length: n }, (_, i) => `f${i}=${'c'.repeat(3890)}`);
  return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Cookie: ${cookies.join('; ')}\r\nConnection: close\r\n\r\n`;
}

/** Retries `rawRequest` while the answer is empty (a reset can swallow the answer to an oversized head). */
export async function statusOf(port, raw, src) {
  for (let i = 0; i < 4; i++) {
    const res = await rawRequest(port, raw, src);
    if (res) return { status: Number(res.split(' ')[1]), strict: /content-security-policy: default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\r\n/i.test(res) };
  }
  return { status: 0, strict: false };
}

/**
 * Plants `count` cookies of `size` bytes from the page's origin (document.cookie), with `attrs`; resolves to how many
 * the page then sees and the length of its document.cookie.
 */
export async function plant(page, { count, size, attrs = 'Path=/', prefix = 'flood' }) {
  return page.evaluate(
    ({ count, size, attrs, prefix }) => {
      for (let i = 0; i < count; i++) document.cookie = `${prefix}${i}=${'x'.repeat(Math.max(1, size - prefix.length - 6))}; ${attrs}`;
      const c = document.cookie;
      return { seen: c ? c.split('; ').length : 0, bytes: c.length };
    },
    { count, size, attrs, prefix },
  );
}

/** fetch() from the page, resolving to { status, body } (body parsed as JSON when it is). */
export async function pageFetch(page, url, init = {}) {
  return page.evaluate(
    async ({ url, init }) => {
      try {
        const r = await fetch(url, { credentials: 'include', ...init });
        const t = await r.text();
        let body = t;
        try {
          body = JSON.parse(t);
        } catch {}
        return { status: r.status, body };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    },
    { url, init },
  );
}
