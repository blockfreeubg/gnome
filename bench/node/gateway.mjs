// The Wisp gateway of the Node baseline (ARCHITECTURE §4.6, docs/API.md), the same checks in the same order:
// route → ticket probe (plain GET/HEAD) → RFC 6455 upgrade headers → exactly one Origin equal to the proxy
// origin → ticket (form, MAC, expiry, route binding, minted before this process started, superseded by a
// VPN-location ticket) → connection caps → the reconstructed upgrade to the route's Wisp server with one
// X-Forwarded-For → 101 with the upstream's headers → relay by copying (pipe()), TCP_NODELAY on both legs, and
// the 15 s re-check that closes a direct-route connection once a VPN-location ticket supersedes it.
import net from 'node:net';
import { apiError, notFound } from './api.mjs';

const RECHECK_MS = 15_000;
const HEAD_TIMEOUT_MS = 10_000;

function ticketParam(query) {
  let found = null;
  for (const pair of (query ?? '').split('&')) {
    if (pair.startsWith('t=')) {
      if (found !== null) return { err: 'invalid' };
      found = pair.slice(2);
    }
  }
  if (found === null) return { err: 'missing' };
  let raw = found.endsWith('/') ? found.slice(0, -1) : found;
  if (!raw) return { err: 'missing' };
  if (raw.length > 3 * 192) return { err: 'invalid' };
  try {
    return { ok: decodeURIComponent(raw) };
  } catch {
    return { err: 'invalid' };
  }
}

const unauthorized = (code, msg) => apiError(401, code, msg);

function forwardedText(values, name, max) {
  let out = '';
  for (const v of values ?? []) {
    if (!/^[\x20-\x7e\t]*$/.test(v)) return { err: apiError(400, 'bad_request', `${name}: only visible ASCII is forwarded`) };
    const t = v.trim();
    if (!t) continue;
    if (out) out += ', ';
    out += t;
  }
  if (out.length > max) return { err: apiError(400, 'bad_request', `${name} is too long`) };
  return { ok: out || null };
}
const hasToken = (list, token) => list.split(',').some((t) => t.trim().toLowerCase() === token);

function upgradeRequired(message, withVersion) {
  const r = apiError(426, 'upgrade_required', message);
  r.headers.upgrade = 'websocket';
  if (withVersion) r.headers['sec-websocket-version'] = '13';
  return r;
}

export function makeGateway(st) {
  const caps = { ip: new Map(), session: new Map() };
  const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const dec = (m, k) => {
    const n = (m.get(k) ?? 1) - 1;
    if (n <= 0) m.delete(k);
    else m.set(k, n);
  };

  function verify(query, route) {
    const p = ticketParam(query);
    if (p.err === 'missing') return { err: unauthorized('wisp_ticket_missing', 'a Wisp ticket is required (?t=<ticket>&/, from POST /api/wisp/ticket)') };
    if (p.err) return { err: unauthorized('wisp_ticket_invalid', 'invalid Wisp ticket parameter') };
    const v = st.ticketKey.verify(p.ok, Math.floor(Date.now() / 1000));
    if (v.err === 'expired') return { err: unauthorized('wisp_ticket_expired', 'expired Wisp ticket') };
    if (v.err) return { err: unauthorized('wisp_ticket_invalid', v.err === 'bad_mac' ? 'invalid Wisp ticket' : 'malformed Wisp ticket') };
    const t = v.ok;
    const same = route === 'default' ? t.route === 'default' : t.route !== 'default' && t.route.profile === route.profile;
    if (!same) return { err: unauthorized('wisp_ticket_wrong_route', 'this Wisp ticket was minted for another route') };
    if (t.iat < st.startedS) return { err: unauthorized('wisp_ticket_stale', 'this Wisp ticket was minted before the server restarted') };
    if (t.route === 'default' && st.supersedes(t.sessionRef, t.iat)) return { err: unauthorized('wisp_ticket_superseded', 'this session uses a VPN location now; the direct-route ticket is void') };
    return { ok: t };
  }

  function forwardedUpgrade(req) {
    if (req.httpVersion !== '1.1' || req.method !== 'GET') return { err: upgradeRequired('Wisp needs an HTTP/1.1 GET WebSocket upgrade', false) };
    const h = req.headersDistinct;
    const up = forwardedText(h.upgrade, 'upgrade', 64);
    if (up.err) return up;
    const conn = forwardedText(h.connection, 'connection', 128);
    if (conn.err) return conn;
    if (!up.ok || !conn.ok || !hasToken(up.ok, 'websocket') || !hasToken(conn.ok, 'upgrade')) return { err: upgradeRequired('Wisp needs a WebSocket upgrade (Upgrade: websocket)', false) };
    const ver = forwardedText(h['sec-websocket-version'], 'sec-websocket-version', 16);
    if (ver.err) return ver;
    if (ver.ok !== '13') return { err: upgradeRequired('unsupported WebSocket version (13 is required)', true) };
    const key = forwardedText(h['sec-websocket-key'], 'sec-websocket-key', 64);
    if (key.err) return key;
    if (!key.ok || key.ok.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/.test(key.ok)) return { err: apiError(400, 'bad_request', 'invalid Sec-WebSocket-Key') };
    const protocol = forwardedText(h['sec-websocket-protocol'], 'sec-websocket-protocol', 1024);
    if (protocol.err) return protocol;
    const ext = forwardedText(h['sec-websocket-extensions'], 'sec-websocket-extensions', 1024);
    if (ext.err) return ext;
    const p = req.url.split('?')[0];
    if (p.length > 256 || !/^[\x21-\x7e]*$/.test(p)) return { err: apiError(400, 'bad_request', 'invalid path') };
    return { ok: { upgrade: up.ok, connection: conn.ok, key: key.ok, protocol: protocol.ok, extensions: ext.ok } };
  }

  /** Read an HTTP/1.x response head from the upstream. Resolves {status, headers: [[name, value]], rest}. */
  function readHead(sock) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => done(new Error('timeout')), HEAD_TIMEOUT_MS);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 16384) done(new Error('malformed'));
          return;
        }
        const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const headers = lines.slice(1).map((l) => {
          const i = l.indexOf(':');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        });
        done(null, { status, headers, rest: buf.subarray(end + 4) });
      };
      const onErr = (e) => done(e);
      const onEnd = () => done(new Error('closed'));
      function done(err, v) {
        clearTimeout(timer);
        sock.off('data', onData).off('error', onErr).off('end', onEnd);
        sock.pause();
        if (err) reject(err);
        else resolve(v);
      }
      sock.on('data', onData).on('error', onErr).on('end', onEnd);
    });
  }

  /**
   * Handle a request on a Wisp route. `send(resp)` writes an ordinary response; `socket`/`head` are set for an
   * HTTP upgrade (Node's 'upgrade' event), when the relay may start.
   */
  async function handle(req, profile, { send, socket, head, writeRaw }) {
    const upstream = profile === null ? st.upstreams.get('direct') : profile !== 'direct' ? st.upstreams.get(profile) : undefined;
    if (!upstream) return send(notFound());
    const route = profile === null ? 'default' : { profile };
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : null;
    if ((req.method === 'GET' || req.method === 'HEAD') && req.headers.upgrade === undefined) {
      const v = verify(query, route);
      return send(v.err ?? upgradeRequired('the Wisp ticket is valid; connect with a WebSocket upgrade', false));
    }
    const fwd = forwardedUpgrade(req);
    if (fwd.err) return send(fwd.err);
    const origins = req.headersDistinct.origin ?? [];
    if (origins.length !== 1) return send(apiError(403, 'forbidden', "Wisp connections need the proxy origin's Origin header"));
    if (origins[0].toLowerCase() !== st.proxyOrigin) return send(apiError(403, 'forbidden', 'origin not allowed for Wisp connections'));
    const v = verify(query, route);
    if (v.err) return send(v.err);
    const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1';
    const sk = v.ok.sessionRef.toString('hex');
    if ((caps.ip.get(ip) ?? 0) >= st.maxWsPerIp) return send(apiError(429, 'too_many_connections', 'too many concurrent Wisp connections from this address', { tier: 'ip' }));
    if ((caps.session.get(sk) ?? 0) >= st.maxWsPerSession) return send(apiError(429, 'too_many_connections', 'too many concurrent Wisp connections for this session', { tier: 'session' }));
    if (!socket) return send(upgradeRequired('Wisp needs a WebSocket upgrade (Upgrade: websocket)', false));
    inc(caps.ip, ip);
    inc(caps.session, sk);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      dec(caps.ip, ip);
      dec(caps.session, sk);
    };
    const up = net.connect(upstream.port, upstream.host);
    up.setNoDelay(true);
    socket.setNoDelay(true);
    const path = profile === null ? '/wisp/' : `/wisp/p/${profile}/`;
    let h = `GET ${path} HTTP/1.1\r\nHost: ${upstream.host}:${upstream.port}\r\nUpgrade: ${fwd.ok.upgrade}\r\nConnection: ${fwd.ok.connection}\r\nSec-WebSocket-Key: ${fwd.ok.key}\r\nSec-WebSocket-Version: 13`;
    if (fwd.ok.protocol) h += `\r\nSec-WebSocket-Protocol: ${fwd.ok.protocol}`;
    if (fwd.ok.extensions) h += `\r\nSec-WebSocket-Extensions: ${fwd.ok.extensions}`;
    h += `\r\nX-Forwarded-For: ${ip}\r\n\r\n`;
    let res;
    try {
      await new Promise((ok, fail) => up.once('connect', ok).once('error', fail));
      up.write(h);
      res = await readHead(up);
    } catch (e) {
      release();
      up.destroy();
      const msg = e.message === 'timeout' ? 'the Wisp server did not answer in time' : 'the Wisp server is unavailable';
      return send(apiError(502, 'bad_gateway', msg));
    }
    if (res.status !== 101) {
      release();
      up.destroy();
      return send(apiError(502, 'bad_gateway', `the Wisp server refused the connection (HTTP ${res.status})`));
    }
    writeRaw(101, res.headers);
    if (res.rest.length) socket.write(res.rest);
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
    up.resume();
    const close = () => {
      release();
      clearInterval(timer);
      socket.destroy();
      up.destroy();
    };
    socket.on('close', close).on('error', close);
    up.on('close', close).on('error', close);
    const timer = route === 'default' ? setInterval(() => st.supersedes(v.ok.sessionRef, v.ok.iat) && close(), RECHECK_MS) : null;
    timer?.unref();
  }

  return { handle };
}
