// Anonymous session tokens and Wisp tickets, re-implemented from docs/API.md and ARCHITECTURE §4.4/§4.6 (not
// from the Rust code): HMAC-SHA256 with purpose keys derived from one secret, base64url without padding.
//   session: v1.<exp>.<id22>.<mac43>            ticket: w2.<exp>.<iat>.<route>.<session_ref22>.<mac43>
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ANON_TTL_S = 30 * 24 * 60 * 60;
export const TICKET_MAX_LEN = 192;
export const MAX_PROFILE_ID_LEN = 64;

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export function b64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  return Buffer.from(s, 'base64url');
}
const hmac = (key, ...parts) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};
const macOk = (key, payload, mac) => mac.length === 32 && timingSafeEqual(hmac(key, payload), mac);

/** The purpose key: HMAC(master, "gnome-server/v1/" + purpose). */
export const derive = (master, purpose) => hmac(master, 'gnome-server/v1/', purpose);

export class AnonKey {
  constructor(master, mode = 'open') {
    this.key = derive(master, `anon-session/${mode}`);
  }
  issue(nowS, keepId = null) {
    const id = keepId ?? b64url(randomBytes(16));
    const exp = nowS + ANON_TTL_S;
    const payload = `v1.${exp}.${id}`;
    return { token: `${payload}.${b64url(hmac(this.key, payload))}`, id, exp };
  }
  verify(token, nowS) {
    if (typeof token !== 'string' || token.length > 128) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, exp, id, mac] = parts;
    if (!/^\d{1,12}$/.test(exp)) return null;
    const idb = b64urlDecode(id);
    if (id.length !== 22 || !idb || idb.length !== 16 || mac.length !== 43) return null;
    const macb = b64urlDecode(mac);
    if (!macb || !macOk(this.key, `v1.${exp}.${id}`, macb)) return null;
    const e = Number(exp);
    return e > nowS ? { id, exp: e } : null;
  }
}

/** The session reference a ticket carries: SHA-256("gnome/wisp-ref/anonymous\0" + id)[..16]. */
export const sessionRefAnonymous = (id) => createHash('sha256').update('gnome/wisp-ref/anonymous\0').update(id).digest().subarray(0, 16);

const canonicalDigits = (s) => /^\d{1,12}$/.test(s) && (s === '0' || s[0] !== '0');

export function encodeRoute(route) {
  return route === 'default' ? 'd' : `p${b64url(Buffer.from(route.profile))}`;
}
export function decodeRoute(s) {
  if (s === 'd') return 'default';
  if (s[0] !== 'p') return null;
  const b = s.slice(1);
  if (!b || b.length > 86) return null;
  const bytes = b64urlDecode(b);
  if (!bytes || b64url(bytes) !== b || !bytes.length || bytes.length > MAX_PROFILE_ID_LEN) return null;
  const id = bytes.toString('latin1');
  return /^[\x21-\x7e]+$/.test(id) ? { profile: id } : null;
}
export const sameRoute = (a, b) => (a === 'default' ? b === 'default' : b !== 'default' && a.profile === b.profile);

export class TicketKey {
  constructor(master, mode = 'open') {
    this.key = derive(master, `wisp-ticket/${mode}`);
  }
  mint(sessionRef, route, iatS, expS) {
    const payload = `w2.${expS}.${iatS}.${encodeRoute(route)}.${b64url(sessionRef)}`;
    return `${payload}.${b64url(hmac(this.key, payload))}`;
  }
  /** {ok: ticket} or {err: 'malformed'|'bad_mac'|'expired'}. */
  verify(t, nowS) {
    if (t.length > TICKET_MAX_LEN || !/^[\x00-\x7f]*$/.test(t)) return { err: 'malformed' };
    const p = t.split('.');
    if (p.length !== 6) return { err: 'malformed' };
    const [ver, exp, iat, route, sref, mac] = p;
    if (ver !== 'w2' || !canonicalDigits(exp) || !canonicalDigits(iat) || !route || sref.length !== 22 || mac.length !== 43) return { err: 'malformed' };
    const srefb = b64urlDecode(sref);
    const macb = b64urlDecode(mac);
    if (!srefb || srefb.length !== 16 || !macb || macb.length !== 32) return { err: 'malformed' };
    if (!macOk(this.key, t.slice(0, t.length - mac.length - 1), macb)) return { err: 'bad_mac' };
    const r = decodeRoute(route);
    if (!r) return { err: 'malformed' };
    if (Number(exp) <= nowS) return { err: 'expired' };
    return { ok: { sessionRef: srefb, exp: Number(exp), iat: Number(iat), route: r } };
  }
}
