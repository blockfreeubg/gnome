// Fixture site of the Wave B step 3 content-blocker suites (docs/WAVE-B3.md §12.1, lane x5). One node:http server on
// E2E_BLOCKER_PORT (= E2E_PORT_BASE + 50), listening on [::1] and 127.0.0.1, answering for the names
//
//   site-a.localhost  site-b.localhost  ads.localhost  trk.localhost  cdn.localhost  bad.localhost
//   docblock.localhost  idp.localhost
//
// (`*.localhost` resolves to the loopback addresses on this host; each name is its own registrable domain). Pages reach
// it only through the VPN profile route `e2e-vpn` (`openApp(context, {route: 'profile:e2e-vpn'})`), whose HolyWisp has
// the TEST-ONLY allow-loopback overlay; the direct route keeps the production policy and cannot reach it.
//
// Static files: http://<name>.localhost:<port>/<lane>/<path> serves
//   tests/e2e/engine/fixtures/blocker/<lane>/<label>/<path>   (host-specific; <label> = the name without .localhost)
//   else tests/e2e/engine/fixtures/blocker/<lane>/shared/<path>
// where <lane> is a directory of fixtures/blocker/ (one per lane: network, cosmetic, privacy, ui; never `lists`), a path
// ending in `/` serves index.html, and every answer is `Cache-Control: no-store`. In text files (html, js, mjs, css,
// json, txt, svg, xml) `{{port}}` becomes the port, `{{host}}` the request's host name and `{{origin:<label>}}`
// `http://<label>.localhost:<port>`. A sidecar `<file>.headers.json` ({"Header": "value" | ["v1", "v2"]}) adds
// response headers (and `":status"`: a status code); sidecars themselves are never served.
//
// Endpoints on every name (they win over static files):
//   /            a small page titled with the host name (`<pre id="out">` holds {"host": …})
//   /echo        the request as JSON {method, url, host, path, query, headers, body}; `no-store`; CORS reflects the
//                Origin with credentials; `?format=html` wraps it in a page (`<pre id="out">`)
//   /set-cookie?<name>=<value>&…   one Set-Cookie per pair (the value may carry attributes after `;`, `Path=/` is
//                added when it names no path); `_to=<url>` answers 302 to it; the page lists what it set
//   /cookies     the Cookie header it got, {"cookie": "…"} (`?format=html`: a page)
//   /ws          WebSocket echo (text and binary; ping → pong; the first offered subprotocol is accepted)
//   /beacon?id=x counts a hit per host and id (a 1×1 GIF): proves that something was or was NOT requested
//   /redirect?to=<url>[&status=301|302|303|307|308]   a redirect (302 by default)
//   /policy?referrer=<policy>[&to=<url>][&frame=<url>][&img=<url>][&script=<url>]   a page served with that
//                Referrer-Policy: #out holds {referrer: document.referrer, url}, plus a#link, iframe#frame, img#img,
//                script#script for the given URLs
//
// In-process API (the runner starts it; suites get it as ctx.stack.blocker.fixtures):
//   const fx = await startBlockerFixtures({port});
//   fx.url('site-a', '/network/page.html'); fx.origin('ads'); fx.requests({since, label, path}); fx.beacons({label, id});
//   fx.ws(); fx.mark(); fx.reset(); await fx.close();
// Standalone (debugging): node engine/servers/blocker-fixtures.mjs [--port 14050] [--root <dir>]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURES_DIR = path.resolve(here, '..', 'fixtures', 'blocker');

/** The fixture names (WAVE-B3 §12.1), as labels; each serves as `<label>.localhost`. */
export const BLOCKER_LABELS = Object.freeze(['site-a', 'site-b', 'ads', 'trk', 'cdn', 'bad', 'docblock', 'idp']);
export const BLOCKER_HOSTS = Object.freeze(BLOCKER_LABELS.map((l) => `${l}.localhost`));

const TEXT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};
const BINARY_TYPES = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
};
/** A transparent 1×1 GIF (the /beacon answer). */
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_LOG = 20_000;
const MAX_ECHO_BODY = 64 * 1024;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** JSON for a <script> or <pre>: no `<` that could end the element. */
const jsonInHtml = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}<title>${esc(title)}</title></head><body>${body}</body></html>`;

/** The label of a fixture host name (`site-a.localhost` → `site-a`), or null for anything else. */
export function labelOf(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!h.endsWith('.localhost')) return null;
  const label = h.slice(0, -'.localhost'.length);
  return BLOCKER_LABELS.includes(label) ? label : null;
}

function hostnameOf(req) {
  const raw = String(req.headers.host ?? '');
  // [::1]:port, host:port, host
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']')).toLowerCase();
  return raw.replace(/:\d+$/, '').toLowerCase();
}

function headersObject(raw) {
  const out = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const k = raw[i].toLowerCase();
    const v = raw[i + 1];
    out[k] = k in out ? [].concat(out[k], v) : v;
  }
  return out;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  const ask = req.headers['access-control-request-headers'];
  if (ask) res.setHeader('Access-Control-Allow-Headers', ask);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** `{{port}}`, `{{host}}` and `{{origin:<label>}}` in a text fixture. */
export function substitute(text, { port, host }) {
  return text
    .replace(/\{\{port\}\}/g, String(port))
    .replace(/\{\{host\}\}/g, host)
    .replace(/\{\{origin:([a-z0-9-]+)\}\}/g, (_, label) => `http://${label}.localhost:${port}`);
}

/**
 * The file a static request maps to, or null: `/<lane>/<rest>` → `<root>/<lane>/<label>/<rest>`, else
 * `<root>/<lane>/shared/<rest>` (index.html for a directory). Never leaves `<root>/<lane>/`, never `lists/`, never a
 * `.headers.json` sidecar.
 */
export function resolveStatic(root, label, pathname) {
  let segs;
  try {
    segs = pathname.split('/').slice(1).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const [lane, ...rest] = segs;
  if (!lane || !/^[a-z0-9][a-z0-9-]*$/.test(lane) || lane === 'lists') return null;
  if (rest.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0') || s.includes('/'))) return null;
  if (rest.length && rest[rest.length - 1].endsWith('.headers.json')) return null;
  const laneDir = path.join(root, lane);
  for (const base of [path.join(laneDir, label), path.join(laneDir, 'shared')]) {
    let file = path.join(base, ...rest);
    if (!file.startsWith(laneDir + path.sep)) continue;
    try {
      let st = fs.statSync(file);
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
      if (st.isFile()) return file;
    } catch {
      /* try the next base */
    }
  }
  return null;
}

function serveStatic(req, res, { root, label, port, host, pathname }) {
  const file = resolveStatic(root, label, pathname);
  if (!file) return false;
  const ext = path.extname(file).toLowerCase();
  const textType = TEXT_TYPES[ext];
  const type = textType ?? BINARY_TYPES[ext] ?? 'application/octet-stream';
  let headers = {};
  let status = 200;
  const sidecar = `${file}.headers.json`;
  if (fs.existsSync(sidecar)) {
    const extra = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    for (const [k, v] of Object.entries(extra)) {
      if (k === ':status') status = Number(v);
      else headers[k] = Array.isArray(v) ? v.map((x) => substitute(String(x), { port, host })) : substitute(String(v), { port, host });
    }
  }
  const raw = fs.readFileSync(file);
  const body = textType ? substitute(raw.toString('utf8'), { port, host }) : raw;
  headers = { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers };
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const POLICY_RE = /^[a-z-]{1,40}(,\s*[a-z-]{1,40})*$/;

async function endpoint(req, res, ctx) {
  const { url, label, host, port, onBeacon } = ctx;
  const q = url.searchParams;
  const html = q.get('format') === 'html';
  switch (url.pathname) {
    case '/':
      send(res, 200, 'text/html; charset=utf-8', page(host, `<h1>${esc(host)}</h1><pre id="out">${jsonInHtml({ host, label })}</pre>`));
      return true;
    case '/echo': {
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req, MAX_ECHO_BODY);
      const out = {
        method: req.method,
        url: `http://${host}:${port}${req.url}`,
        host,
        path: url.pathname,
        query: Object.fromEntries(q),
        headers: headersObject(req.rawHeaders),
        body,
      };
      if (html) send(res, 200, 'text/html; charset=utf-8', page('echo', `<pre id="out">${esc(JSON.stringify(out))}</pre>`));
      else send(res, 200, 'application/json', JSON.stringify(out));
      return true;
    }
    case '/set-cookie': {
      const set = [];
      let to = null;
      for (const [k, v] of q) {
        if (k === '_to') to = v;
        else if (k.startsWith('_') || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(k)) continue;
        else set.push(/;\s*path=/i.test(v) ? `${k}=${v}` : `${k}=${v}; Path=/`);
      }
      cors(req, res);
      if (to !== null) {
        res.writeHead(302, { Location: to, 'Set-Cookie': set, 'Cache-Control': 'no-store' });
        res.end();
      } else {
        res.setHeader('Set-Cookie', set);
        send(res, 200, 'text/html; charset=utf-8', page('set-cookie', `<pre id="out">${esc(JSON.stringify({ host, set }))}</pre>`));
      }
      return true;
    }
    case '/cookies': {
      cors(req, res);
      const out = { host, cookie: req.headers.cookie ?? '' };
      if (html) send(res, 200, 'text/html; charset=utf-8', page('cookies', `<pre id="out">${esc(JSON.stringify(out))}</pre>`));
      else send(res, 200, 'application/json', JSON.stringify(out));
      return true;
    }
    case '/beacon': {
      cors(req, res);
      onBeacon(label, q.get('id') ?? '');
      send(res, 200, 'image/gif', GIF);
      return true;
    }
    case '/redirect': {
      const to = q.get('to');
      const status = Number(q.get('status') ?? 302);
      if (!to || !REDIRECT_CODES.has(status)) {
        send(res, 400, 'text/plain; charset=utf-8', 'redirect needs ?to=<url> and a 30x status');
        return true;
      }
      res.writeHead(status, { Location: to, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    case '/policy': {
      const policy = q.get('referrer') ?? '';
      if (!POLICY_RE.test(policy)) {
        send(res, 400, 'text/plain; charset=utf-8', 'policy needs ?referrer=<a Referrer-Policy token>');
        return true;
      }
      const parts = [`<pre id="out">pending</pre>`];
      if (q.get('to')) parts.push(`<a id="link" href="${esc(q.get('to'))}">next</a>`);
      if (q.get('frame')) parts.push(`<iframe id="frame" src="${esc(q.get('frame'))}"></iframe>`);
      if (q.get('img')) parts.push(`<img id="img" alt="" src="${esc(q.get('img'))}">`);
      if (q.get('script')) parts.push(`<script id="script" src="${esc(q.get('script'))}"></script>`);
      parts.push(`<script>document.getElementById('out').textContent=JSON.stringify({referrer:document.referrer,url:location.href});</script>`);
      send(res, 200, 'text/html; charset=utf-8', page(`policy ${policy}`, parts.join('\n')), { 'Referrer-Policy': policy });
      return true;
    }
    case '/ws':
      send(res, 426, 'text/plain; charset=utf-8', 'WebSocket echo: connect with Upgrade: websocket', { Upgrade: 'websocket' });
      return true;
    default:
      return false;
  }
}

// ── WebSocket echo (RFC 6455, enough for the tests: text, binary, ping/pong, close) ─────────────────────────────

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function wsUpgrade(req, socket, record) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  const proto = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0].trim();
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : ''}\r\n`,
  );
  record.open = true;
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskOff + (i % 4)];
      buf = buf.subarray(off + len);
      if (opcode === 0x8) {
        record.open = false;
        socket.end(wsFrame(0x8, payload.subarray(0, 2)));
        return;
      }
      if (opcode === 0x9) socket.write(wsFrame(0xa, payload));
      else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        record.messages++;
        socket.write(wsFrame(opcode === 0x0 ? 0x1 : opcode, payload));
      }
    }
  });
  socket.on('close', () => (record.open = false));
  socket.on('error', () => (record.open = false));
}

// ── The server ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Starts the fixture server on `port` ([::1] and 127.0.0.1). `root`: the fixtures directory (default
 * tests/e2e/engine/fixtures/blocker, or E2E_BLOCKER_FIXTURES_DIR).
 */
export async function startBlockerFixtures({ port, root = process.env.E2E_BLOCKER_FIXTURES_DIR || DEFAULT_FIXTURES_DIR, log = () => {} } = {}) {
  if (!Number.isInteger(port)) throw new Error('startBlockerFixtures needs {port}');
  const requests = [];
  const beacons = new Map();
  const sockets = [];
  const onBeacon = (label, id) => {
    const k = `${label}\n${id}`;
    beacons.set(k, (beacons.get(k) ?? 0) + 1);
  };
  const handler = async (req, res) => {
    const host = hostnameOf(req);
    const label = labelOf(host);
    let url;
    try {
      url = new URL(req.url, `http://${host || 'unknown'}:${port}`);
    } catch {
      send(res, 400, 'text/plain; charset=utf-8', 'bad request URL');
      return;
    }
    requests.push({ at: Date.now(), host, label, method: req.method, path: url.pathname, search: url.search, url: `http://${host}:${port}${req.url}`, headers: headersObject(req.rawHeaders) });
    if (requests.length > MAX_LOG) requests.splice(0, requests.length - MAX_LOG);
    if (!label) {
      send(res, 421, 'text/plain; charset=utf-8', `not a fixture host: ${host} (known: ${BLOCKER_HOSTS.join(', ')})`);
      return;
    }
    try {
      if (await endpoint(req, res, { url, label, host, port, onBeacon })) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, { root, label, port, host, pathname: url.pathname })) return;
      send(res, 404, 'text/plain; charset=utf-8', `no fixture for ${host}${url.pathname}`);
    } catch (e) {
      log(`blocker fixtures: ${req.method} ${host}${req.url}: ${e.stack || e}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'fixture error');
      else res.destroy();
    }
  };
  const servers = [];
  /** Upgraded (WebSocket) sockets: the HTTP server no longer tracks them, close() ends them. */
  const upgraded = new Set();
  const listen = (address) =>
    new Promise((resolve, reject) => {
      // Only WebSocket upgrades take the upgrade path: libcurl (the libcurl transport) offers `Upgrade: h2c` on plain
      // HTTP requests, which must be answered as ordinary HTTP/1.1 requests.
      const s = http.createServer({ shouldUpgradeCallback: (req) => String(req.headers.upgrade ?? '').toLowerCase() === 'websocket' }, handler);
      s.on('upgrade', (req, socket) => {
        const host = hostnameOf(req);
        const label = labelOf(host);
        // An absolute-form target (epoxy's handshake sends `GET ws://host:port/ws`, RFC 9112 §3.2.2) names the same path.
        const pathname = new URL(req.url ?? '/', `http://${host || 'unknown'}:${port}`).pathname;
        requests.push({ at: Date.now(), host, label, method: 'UPGRADE', path: pathname, search: '', url: `ws://${host}:${port}${req.url}`, headers: headersObject(req.rawHeaders) });
        if (!label || pathname !== '/ws') {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          return;
        }
        const record = { at: Date.now(), label, url: `ws://${host}:${port}${req.url}`, open: false, messages: 0 };
        sockets.push(record);
        upgraded.add(socket);
        socket.on('close', () => upgraded.delete(socket));
        socket.on('error', () => {});
        wsUpgrade(req, socket, record);
      });
      s.once('error', reject);
      s.listen(port, address, () => {
        s.off('error', reject);
        servers.push(s);
        resolve();
      });
    });
  await listen('127.0.0.1');
  let ipv6 = true;
  try {
    await listen('::1');
  } catch (e) {
    ipv6 = false;
    log(`blocker fixtures: [::1]:${port} not available (${e.code ?? e}); IPv4 only`);
  }
  let markAt = 0;
  return {
    port,
    root,
    ipv6,
    labels: BLOCKER_LABELS,
    hosts: BLOCKER_HOSTS,
    /** `http://<label>.localhost:<port>` */
    origin: (label) => `http://${label}.localhost:${port}`,
    /** `http://<label>.localhost:<port><path>` */
    url: (label, p = '/') => `http://${label}.localhost:${port}${p.startsWith('/') ? p : `/${p}`}`,
    /** A timestamp to pass as `since`. */
    mark: () => (markAt = Date.now()),
    /** Requests the server got (newest last), filtered by `since` (ms), `label`, `path` (string or RegExp), `method`. */
    requests({ since = 0, label, path: p, method } = {}) {
      return requests.filter(
        (r) => r.at >= since && (label === undefined || r.label === label) && (method === undefined || r.method === method) && (p === undefined || (p instanceof RegExp ? p.test(r.path) : r.path === p)),
      );
    },
    /** Hits of /beacon (all ids of `label` when `id` is omitted, every host when `label` is omitted). */
    beacons({ label, id } = {}) {
      let n = 0;
      for (const [k, v] of beacons) {
        const [l, i] = k.split('\n');
        if ((label === undefined || l === label) && (id === undefined || i === id)) n += v;
      }
      return n;
    },
    /** WebSocket connections to /ws: [{at, label, url, open, messages}]. */
    ws: ({ since = 0 } = {}) => sockets.filter((s) => s.at >= since),
    reset() {
      requests.length = 0;
      beacons.clear();
      sockets.length = 0;
      markAt = 0;
    },
    get lastMark() {
      return markAt;
    },
    async close() {
      for (const sock of upgraded) sock.destroy();
      upgraded.clear();
      // close() waits for every connection; anything still open after 2 s is not worth waiting for.
      await Promise.all(servers.map((s) => Promise.race([new Promise((r) => (s.close(() => r()), s.closeAllConnections?.())), new Promise((r) => setTimeout(r, 2000))])));
    },
  };
}

// Standalone: node engine/servers/blocker-fixtures.mjs [--port N] [--root dir]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const port = Number(opt('--port', process.env.E2E_BLOCKER_PORT ?? Number(process.env.E2E_PORT_BASE ?? 27500) + 50));
  const fx = await startBlockerFixtures({ port, root: opt('--root', undefined), log: console.error });
  console.log(`blocker fixtures on ${fx.ipv6 ? '[::1] and ' : ''}127.0.0.1:${port}: ${fx.hosts.map((h) => `http://${h}:${port}/`).join(' ')}`);
  process.send?.({ type: 'listening', port });
  const stop = async () => {
    await fx.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
