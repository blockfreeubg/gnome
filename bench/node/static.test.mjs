import test from 'node:test';
import assert from 'node:assert/strict';
import { accepted, noneMatch, isReserved, contentType, resolve, inlineScriptHashes } from './static.mjs';

test('encoding negotiation', () => {
  assert.deepEqual(accepted('gzip, deflate, br'), { br: true, gzip: true });
  assert.deepEqual(accepted('br;q=0, gzip'), { br: false, gzip: true });
  assert.deepEqual(accepted('*;q=0, br'), { br: true, gzip: false });
  assert.deepEqual(accepted('*'), { br: true, gzip: true });
  assert.deepEqual(accepted(undefined), { br: false, gzip: false });
});

test('ETag matching (weak comparison, *)', () => {
  assert.ok(noneMatch(['"abc"'], '"abc"'));
  assert.ok(noneMatch(['W/"abc"'], '"abc"'));
  assert.ok(noneMatch(['"x", "abc"'], '"abc"'));
  assert.ok(noneMatch(['*'], '"abc"'));
  assert.ok(!noneMatch(['"abd"'], '"abc"'));
});

test('path rules', () => {
  for (const p of ['/api', '/api/x', '/admin', '/wisp/', '/oss/a', '/play-frame']) assert.ok(isReserved(p), p);
  for (const p of ['/apix', '/', '/assets/api']) assert.ok(!isReserved(p), p);
  assert.equal(contentType('/a/b.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('/x'), 'text/plain; charset=utf-8');
  const e = { type: 'text/html' };
  const idx = { files: new Map([['/index.html', e], ['/sw.js', e], ['/assets/a.js', e], ['/engine/index.html', e]]), index: e, engineIndex: e };
  assert.equal(resolve(idx, '/browse', 'app').kind, 'file');
  assert.equal(resolve(idx, '/x.png', 'app').kind, 'notfound');
  assert.equal(resolve(idx, '/sw.js', 'app').kind, 'notfound');
  assert.equal(resolve(idx, '/sw.js', 'proxy').kind, 'file');
  assert.equal(resolve(idx, '/browse', 'proxy').kind, 'notfound');
  assert.equal(resolve(idx, '/engine/deep/link', 'proxy').kind, 'file');
  assert.equal(resolve(idx, '/~/sj/x', 'proxy').kind, 'engine-unavailable');
  assert.equal(resolve(idx, '/api/x', 'app').kind, 'reserved');
});

test('inline script hashes skip external scripts', () => {
  const h = inlineScriptHashes('<script src="/a.js"></script><script>x()</script><script type="module">y()</script>');
  assert.equal(h.length, 2);
  assert.match(h[0], /^'sha256-[A-Za-z0-9+/]+=*'$/);
});
