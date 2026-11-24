// The static index of the Node baseline, following docs/API.md and ARCHITECTURE §4.4 (not the Rust code):
// strong ETag = first 16 bytes of SHA-256 in base64url (siblings: -br / -gz suffix), files ≤ 256 KiB kept in
// memory up to a 32 MiB budget (sorted URL order; identity, then .br, then .gz), larger ones read from disk;
// `immutable` for /assets/, `no-cache` elsewhere; the app/proxy listener split and the CSP strings of the
// proxy origin (read from backend/tests/fixtures/proxy-origin-csp.json).
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_FILE_LIMIT = 256 * 1024;
export const MEMORY_BUDGET = 32 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';
export const RESERVED = ['/api', '/admin', '/wisp', '/oss', '/play-frame'];
const ENGINE_PREFIXES = ['/~/sj/', '/uv/service/'];
const PLACEHOLDER = '%GNOME_APP_ORIGINS%';

export const isReserved = (p) => RESERVED.some((r) => p === r || (p.startsWith(r) && p[r.length] === '/'));
export const isEnginePath = (p) => ENGINE_PREFIXES.some((e) => p.startsWith(e));
const isEngineHost = (p) => p.startsWith('/engine/');
const proxyOnly = (p) => isEngineHost(p) || p === '/sw.js' || p.startsWith('/vendor/') || p.startsWith('/oss/');
const hasExtension = (p) => (p.split('/').pop() ?? '').includes('.');

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json', wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8', license: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', zip: 'application/zip',
  gz: 'application/gzip',
};
export function contentType(p) {
  const name = p.split('/').pop();
  const i = name.lastIndexOf('.');
  if (i < 0) return 'text/plain; charset=utf-8';
  return TYPES[name.slice(i + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** Accept-Encoding → {br, gzip} (q=0 refuses; `*` covers both when not named). */
export function accepted(value) {
  if (!value) return { br: false, gzip: false };
  let br, gzip, star;
  for (const item of value.split(',')) {
    const [rawName, ...params] = item.split(';');
    const name = rawName.trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const t = p.trim();
      if (t.startsWith('q=') || t.startsWith('Q=')) q = Number.parseFloat(t.slice(2).trim()) || 0;
    }
    const ok = q > 0;
    if (name === 'br') br = ok;
    else if (name === 'gzip' || name === 'x-gzip') gzip = ok;
    else if (name === '*') star = ok;
  }
  return { br: br ?? star ?? false, gzip: gzip ?? star ?? false };
}

/** If-None-Match (weak comparison, `*`). */
export function noneMatch(values, etag) {
  for (const v of values) for (const t of v.split(',')) {
    const s = t.trim();
    if (s === '*' || s.replace(/^W\//, '') === etag) return true;
  }
  return false;
}

const etagOf = (hash, suffix = '') => `"${hash.subarray(0, 16).toString('base64url')}${suffix}"`;

/** The `sha256-…` sources of a document's inline scripts (CSP hashes). */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? '')) continue;
    if (!m[2]) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2]).digest('base64')}'`);
  }
  return out;
}

/** The CSP strings of a two-origin deployment (`appOrigin`, `proxyOrigin`). */
export function policies(fixturePath, appOrigin, proxyOrigin) {
  const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const EX = 'https://gnome.example.com';
  const pick = (list, extra = {}) => list.find((e) => e.appOrigins?.length === 1 && e.appOrigins[0] === EX && Object.entries(extra).every(([k, v]) => e[k] === v)).csp.replaceAll(EX, appOrigin);
  const shell = (hashes) =>
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hashes.map((h) => ` ${h}`).join('')}; worker-src 'self' blob:; connect-src 'self'; frame-src blob: 'self' ${proxyOrigin}; img-src 'self' data: blob: https: ${proxyOrigin}; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  return {
    shell,
    proxyScript: pick(fx.proxyScriptCsp),
    proxyInert: pick(fx.proxyInertCsp),
    engineHost: pick(fx.engineHostCsp, { customWisp: false }),
    bareMuxWorker: fx.bareMuxWorkerCsp.find((e) => e.customWisp === false).csp,
    bareMuxWorkerScript: pick(fx.bareMuxWorkerScriptCsp, { customWisp: false }),
    bareMuxWorkerPath: fx.bareMuxWorkerPath,
    appFrameAncestors: "frame-ancestors 'self'",
  };
}

function walk(root, prefix = '', out = new Map(), depth = 0) {
  if (depth > 32) return out;
  for (const e of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue;
    const url = `${prefix}/${e.name}`;
    const full = path.join(root, url);
    if (e.isDirectory()) walk(root, url, out, depth + 1);
    else if (e.isFile() || (e.isSymbolicLink() && statSync(full).isFile())) out.set(url, { full, len: statSync(full).size });
  }
  return out;
}

/** Build the index: Map url → entry. */
export function loadIndex(root, pol) {
  const found = walk(root);
  const urls = [...found.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let budget = MEMORY_BUDGET;
  const files = new Map();
  const keep = (len) => len <= MEMORY_FILE_LIMIT && len <= budget;
  for (const url of urls) {
    if (['.br', '.gz'].some((x) => url.endsWith(x) && found.has(url.slice(0, -3)))) continue;
    const { full } = found.get(url);
    let { len } = found.get(url);
    let data = readFileSync(full);
    let hash = createHash('sha256').update(data).digest();
    const type = contentType(url);
    let body = null;
    if (keep(len)) {
      body = data;
      budget -= len;
    }
    let csp = null;
    let templated = false;
    if (url === pol.bareMuxWorkerPath) csp = { kind: 'proxy', values: [pol.bareMuxWorker, pol.bareMuxWorkerScript], singleOrigin: true };
    else if (type.startsWith('text/javascript')) csp = { kind: 'proxy', values: [pol.proxyScript], singleOrigin: proxyOnly(url) };
    if (type.startsWith('text/html')) {
      let text = data.toString('utf8');
      if (isEngineHost(url) && text.includes(PLACEHOLDER)) {
        templated = true;
        text = text.replaceAll(PLACEHOLDER, pol.appOriginsAttr);
        data = Buffer.from(text);
        hash = createHash('sha256').update(data).digest();
        len = data.length;
        if (body) budget += body.length - len;
        body = keep(len) || body ? data : null;
      }
      csp = isEngineHost(url) ? { kind: 'engine', values: [pol.engineHost] } : { kind: 'shell', values: [pol.shell(inlineScriptHashes(text))] };
    }
    const tag = etagOf(hash);
    const variant = (p, l, suffix) => {
      const v = { etag: etagOf(hash, suffix), len: l, body: null, full: p };
      if (keep(l)) {
        v.body = readFileSync(p);
        budget -= l;
      }
      return v;
    };
    const br = !templated && found.has(`${url}.br`) ? variant(found.get(`${url}.br`).full, found.get(`${url}.br`).len, '-br') : null;
    const gz = !templated && found.has(`${url}.gz`) ? variant(found.get(`${url}.gz`).full, found.get(`${url}.gz`).len, '-gz') : null;
    files.set(url, {
      type,
      cache: url.startsWith('/assets/') ? IMMUTABLE : NO_CACHE,
      extra: url === '/sw.js' ? [['service-worker-allowed', '/']] : [],
      csp,
      identity: { etag: tag, len, body, full },
      br,
      gz,
    });
  }
  return { files, index: files.get('/index.html'), engineIndex: files.get('/engine/index.html') };
}

function exact(idx, p) {
  return idx.files.get(p) ?? (p.endsWith('/') ? idx.files.get(`${p}index.html`) : undefined);
}

/** Resolve a path for a listener role ('app' | 'proxy'). */
export function resolve(idx, p, role) {
  if (isReserved(p)) return { kind: 'reserved' };
  if (role === 'app') {
    if (isEnginePath(p) || proxyOnly(p)) return { kind: 'notfound' };
    const e = exact(idx, p);
    if (e) return { kind: 'file', e };
    if (!hasExtension(p)) return idx.index ? { kind: 'file', e: idx.index } : { kind: 'notbuilt' };
    return { kind: 'notfound' };
  }
  if (isEnginePath(p)) return { kind: 'engine-unavailable' };
  if (isEngineHost(p)) {
    const e = exact(idx, p);
    if (e) return { kind: 'file', e };
    if (!hasExtension(p)) return idx.engineIndex ? { kind: 'file', e: idx.engineIndex } : { kind: 'notbuilt' };
    return { kind: 'notfound' };
  }
  if (p === '/sw.js' || p.startsWith('/vendor/') || p.startsWith('/assets/')) {
    const e = exact(idx, p);
    return e ? { kind: 'file', e } : { kind: 'notfound' };
  }
  return { kind: 'notfound' };
}

/** The handler's own CSP (and X-Frame-Options) for an entry, by role. */
function applyCsp(h, csp, role) {
  if (!csp) return;
  if (csp.kind === 'shell' && role === 'app') {
    h['x-frame-options'] = 'DENY';
    h['content-security-policy'] = csp.values;
  } else if (csp.kind === 'engine') h['content-security-policy'] = csp.values;
  else if (csp.kind === 'proxy' && role === 'proxy') h['content-security-policy'] = csp.values;
}

/** Serve a resolved entry. `h` is the header object the caller finishes (security headers) and writes. */
export async function respond(e, req, res, role, finish) {
  const { br, gzip } = accepted(req.headers['accept-encoding']);
  let v = e.identity;
  let enc = null;
  if (e.br && br) [v, enc] = [e.br, 'br'];
  else if (e.gz && gzip) [v, enc] = [e.gz, 'gzip'];
  const h = { 'cache-control': e.cache };
  if (e.br || e.gz) h.vary = 'Accept-Encoding';
  applyCsp(h, e.csp, role);
  const inm = req.headersDistinct['if-none-match'] ?? [];
  if (inm.length && noneMatch(inm, v.etag)) {
    h.etag = v.etag;
    return finish(304, h, null);
  }
  const head = req.method === 'HEAD';
  let len = v.len;
  let stream = null;
  let etagValid = true;
  if (!v.body) {
    let st;
    try {
      st = await stat(v.full);
    } catch {
      return finish(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_CACHE }, Buffer.from('404 Not Found\n'));
    }
    len = st.size;
    etagValid = len === v.len;
    if (!head) stream = createReadStream(v.full, { highWaterMark: 64 * 1024 });
  }
  h['content-type'] = e.type;
  h['content-length'] = String(len);
  if (etagValid) h.etag = v.etag;
  else h['cache-control'] = NO_CACHE;
  if (enc) h['content-encoding'] = enc;
  for (const [k, val] of e.extra) h[k] = val;
  return finish(200, h, head ? null : (v.body ?? stream), head);
}
