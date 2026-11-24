// The measured API paths of the Node baseline (docs/API.md): POST /api/wisp/ticket (anonymous session minted on
// first use, X-GNOME-Request: 1, route-bound w2 tickets), GET /api/config, GET /api/session, GET /api/health.
// Anonymous sessions are stateless HMAC tokens: none of these touch a database (as in gnome-server).
import { sessionRefAnonymous, ANON_TTL_S } from './tokens.mjs';

export const COOKIE = '__Host-gnome_sid';

export function readCookie(header, name) {
  if (!header) return null;
  for (const h of Array.isArray(header) ? header : [header]) {
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
  }
  return null;
}

export const apiError = (status, code, message, extra = {}) => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: Buffer.from(JSON.stringify({ ...extra, error: { code, message } })),
});
export const notFound = () => apiError(404, 'not_found', 'not found');

const json = (status, value, extraHeaders = {}) => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  body: Buffer.from(JSON.stringify(value)),
});

/** Sort object keys (serde_json's default map order for `json!` values). */
const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

export function makeApi(st) {
  const nowS = () => Math.floor(Date.now() / 1000);
  const anon = (req) => {
    const t = readCookie(req.headers.cookie, COOKIE);
    return t ? st.anonKey.verify(t, nowS()) : null;
  };
  const configBody = Buffer.from(
    JSON.stringify({
      version: '0.1.0',
      access_mode: 'open',
      registration: 'open',
      features: { accounts: true, sync: true, games: true, vpn_gateway: st.profiles.size > 0, thumb_proxy: true },
      wisp: {
        path: '/wisp/',
        ticket_ttl_s: st.ticketTtlS,
        profiles: [...st.profiles.values()].map((p) => ({ id: p.id, label: p.label, country_code: p.countryCode, city: p.city, path: `/wisp/p/${p.id}/` })),
        custom_servers: false,
      },
      engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
      proxy: { origin: st.proxyOrigin, isolated: true },
      source_url: null,
      limits: { max_ws_per_session: st.maxWsPerSession },
    }),
  );

  function route(body) {
    if (!body.length || /^\s*$/.test(body.toString('latin1'))) return { route: 'default' };
    let v;
    try {
      v = JSON.parse(body.toString('utf8'));
    } catch {
      return { err: apiError(400, 'bad_request', 'the body is not valid JSON') };
    }
    const bad = (msg) => ({ err: { ...apiError(422, 'validation_failed', 'validation failed'), body: Buffer.from(JSON.stringify({ error: { code: 'validation_failed', fields: { route: msg }, message: 'validation failed' } })) } });
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { err: { ...apiError(422, 'validation_failed', 'validation failed'), body: Buffer.from(JSON.stringify({ error: { code: 'validation_failed', fields: { '': 'must be a JSON object' }, message: 'validation failed' } })) } };
    }
    const r = v.route;
    if (r === undefined || r === null || r === 'default') return { route: 'default' };
    if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 1 && 'profile' in r) {
      if (typeof r.profile === 'string') return r.profile !== 'direct' && st.profiles.has(r.profile) ? { route: { profile: r.profile } } : bad('unknown VPN location');
    }
    return bad('must be "default" or {"profile": "<id>"}');
  }

  return {
    /** Returns a response object or null (not an API path handled here). */
    handle(req, p, body) {
      if (p === '/api/wisp/ticket' && req.method === 'POST') {
        const now = nowS();
        let a = anon(req);
        let setCookie = null;
        if (!a) {
          const issued = st.anonKey.issue(now);
          a = { id: issued.id, exp: issued.exp };
          setCookie = `${COOKIE}=${issued.token}; Max-Age=${ANON_TTL_S}; Path=/; HttpOnly; SameSite=Strict; Secure`;
        }
        const r = route(body);
        if (r.err) return r.err;
        const exp = Math.min(now + st.ticketTtlS, a.exp);
        if (exp <= now) return apiError(401, 'unauthorized', 'the session has expired');
        const sref = sessionRefAnonymous(a.id);
        const out = json(200, sorted({ ticket: st.ticketKey.mint(sref, r.route, now, exp), expires_at: exp * 1000, wisp_url: `${st.proxyOrigin.replace(/^http/, 'ws')}/wisp/` }), setCookie ? { 'set-cookie': setCookie } : {});
        if (r.route !== 'default') st.recordProfileMint(sref, now);
        return out;
      }
      if (p === '/api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
        return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: configBody };
      }
      if (p === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
        const a = anon(req);
        if (!a) return apiError(401, 'unauthorized', 'no session');
        return json(200, { session: { expires_at: a.exp * 1000, kind: 'anonymous', proxy: true, user: null } });
      }
      if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        return json(200, { status: 'ok', version: '0.1.0', uptime_s: nowS() - st.startedS, db: 'ok', wisp: Object.fromEntries([['direct', 'up'], ...[...st.profiles.keys()].map((k) => [k, 'up'])].sort()) });
      }
      return null;
    },
  };
}
