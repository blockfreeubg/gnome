// Small helpers shared by the spike's HTTP servers (no framework: the servers must stay transparent).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Serve one file with no-cache + ETag (the policy API.md gives /vendor/** and other unhashed files).
export function sendFile(req, res, file, extraHeaders = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return send(res, 404, 'not found\n', { 'content-type': 'text/plain' });
  }
  if (!st.isFile()) return send(res, 404, 'not found\n', { 'content-type': 'text/plain' });
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'content-type': mimeOf(file), 'cache-control': 'no-cache', etag, ...extraHeaders };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// Resolve `rel` inside `root`, refusing traversal.
export function safeJoin(root, rel) {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

export function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
}

export function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json', ...headers });
}

export function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export const randomId = (n = 12) => crypto.randomBytes(n).toString('base64url');

// Child processes report events to run.mjs over IPC; standalone runs just log them.
export function report(type, data) {
  const msg = { type, at: Date.now(), ...data };
  if (process.send) process.send(msg);
  else if (process.env.SPIKE_VERBOSE) console.log(JSON.stringify(msg));
}

export function onCommand(handler) {
  if (!process.send) return;
  process.on('message', async (m) => {
    if (!m || typeof m !== 'object' || m.kind !== 'cmd') return;
    try {
      const result = await handler(m.cmd, m.args || {});
      process.send({ type: 'cmd-result', id: m.id, ok: true, result });
    } catch (e) {
      process.send({ type: 'cmd-result', id: m.id, ok: false, error: String(e?.stack || e) });
    }
  });
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
