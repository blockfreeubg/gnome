import test from 'node:test';
import assert from 'node:assert/strict';
import { AnonKey, TicketKey, sessionRefAnonymous, decodeRoute, encodeRoute } from './tokens.mjs';

const master = Buffer.alloc(32, 1);

test('anonymous session token format and expiry', () => {
  const k = new AnonKey(master);
  const { token, id, exp } = k.issue(1000);
  assert.match(token, /^v1\.2593000\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(k.verify(token, 1000), { id, exp });
  assert.equal(k.verify(token, exp), null);
  assert.equal(k.verify(token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A'), 1000), null);
  assert.equal(new AnonKey(Buffer.alloc(32, 2)).verify(token, 1000), null);
});

test('w2 ticket format, route binding and refusals', () => {
  const k = new TicketKey(master);
  const r = sessionRefAnonymous('AAAAAAAAAAAAAAAAAAAAAA');
  const t = k.mint(r, 'default', 1000, 2000);
  assert.match(t, /^w2\.2000\.1000\.d\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(t.split('.').length, 6);
  const v = k.verify(t, 1999).ok;
  assert.equal(v.route, 'default');
  assert.equal(v.iat, 1000);
  assert.deepEqual(k.verify(t, 2000), { err: 'expired' });
  assert.deepEqual(k.verify(t.replace('w2.', 'w1.'), 1), { err: 'malformed' });
  assert.deepEqual(k.verify(t.replace('.2000.', '.02000.'), 1), { err: 'malformed' });
  assert.deepEqual(k.verify(t.slice(0, -2) + 'AA', 1), { err: 'bad_mac' });
  const p = k.mint(r, { profile: 'e2e-vpn' }, 1000, 999_999_999_999);
  assert.ok(p.length <= 192);
  assert.deepEqual(k.verify(p, 1).ok.route, { profile: 'e2e-vpn' });
  assert.deepEqual(decodeRoute(encodeRoute({ profile: 'a.b' })), { profile: 'a.b' });
  assert.equal(decodeRoute('x'), null);
  assert.equal(decodeRoute('p'), null);
});
