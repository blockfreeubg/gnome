// Row AU4 (WAVE-D §6.7): the npm audit classification on recorded `npm audit --json` shapes, no network.
//   node --test scripts/audit/npm-audit.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkIgnores, classify, installScripts } from './npm-audit.mjs';

const today = '2026-11-24';
const policy = { failOn: ['high', 'critical'], maxIgnoreDays: 90, ignores: [] };
const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    'bad-lib': { name: 'bad-lib', severity: 'high', via: [{ source: 1, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high' }], nodes: ['node_modules/bad-lib'] },
    'meh-lib': { name: 'meh-lib', severity: 'moderate', via: [{ source: 2, url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'moderate' }], nodes: ['node_modules/meh-lib'] },
  },
};

test('a vulnerable shipped package fails; moderate ones are reported only', () => {
  const f = classify(report, { shippedProject: true, policy, today });
  assert.deepEqual(f.map((x) => [x.package, x.shipped, x.fails]), [['bad-lib', true, true], ['meh-lib', true, false]]);
});

test('the same package as build-only passes (reported)', () => {
  const f = classify(report, { shippedProject: false, policy, today });
  assert.equal(f.some((x) => x.fails), false);
  assert.equal(f.length, 2);
});

test('a package bundled inside a vendored package counts as shipped', () => {
  const f = classify(report, { shippedProject: false, bundledIn: new Set(['bad-lib']), policy, today });
  assert.equal(f.find((x) => x.package === 'bad-lib').fails, true);
});

test('ignores need a reason and an expiry at most 90 days ahead; an expired one fails and stops ignoring', () => {
  const live = { ...policy, ignores: [{ advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'not reachable', expires: '2026-12-31' }] };
  assert.deepEqual(checkIgnores(live, today), []);
  assert.equal(classify(report, { shippedProject: true, policy: live, today }).find((x) => x.package === 'bad-lib').fails, false);
  const expired = { ...policy, ignores: [{ advisory: 'GHSA-aaaa-bbbb-cccc', reason: 'old', expires: '2026-11-01' }] };
  assert.match(checkIgnores(expired, today)[0], /expired/);
  assert.equal(classify(report, { shippedProject: true, policy: expired, today }).find((x) => x.package === 'bad-lib').fails, true);
  assert.match(checkIgnores({ ...policy, ignores: [{ package: 'x', reason: 'r', expires: '2027-06-01' }] }, today)[0], /more than 90 days/);
  assert.match(checkIgnores({ ...policy, ignores: [{ package: 'x', expires: '2026-12-01' }] }, today)[0], /no reason/);
});

test('install scripts are listed from the lock', () => {
  const lock = { packages: { '': { name: 'root' }, 'node_modules/fsevents': { hasInstallScript: true }, 'node_modules/a/node_modules/esbuild': { hasInstallScript: true }, 'node_modules/b': {} } };
  assert.deepEqual(installScripts(lock), ['fsevents', 'esbuild']);
});
