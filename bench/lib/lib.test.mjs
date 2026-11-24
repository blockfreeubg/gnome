import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { derive, parseList, cpuSets } from './cpusets.mjs';
import { assertLoopback, listeners } from './proc.mjs';
import { planSeconds } from './plan.mjs';
import { significant, summarize, histQuantile, lowerBound } from './stats.mjs';

test('CPU sets: 4 physical cores for the servers, siblings idle, the rest for the load generator', () => {
  // This machine's layout: 6 cores × 2 threads, siblings n and n+6.
  const m = new Map();
  for (let c = 0; c < 12; c++) m.set(c, [c % 6, (c % 6) + 6]);
  const d = derive(m);
  assert.deepEqual(d.servers, [0, 1, 2, 3]);
  assert.deepEqual(d.idle, [6, 7, 8, 9]);
  assert.deepEqual([...d.loadgen].sort((a, b) => a - b), [4, 5, 10, 11]);
  // No SMT, 8 cores.
  const n = new Map([...Array(8).keys()].map((c) => [c, [c]]));
  assert.deepEqual(derive(n).loadgen, [4, 5, 6, 7]);
  assert.throws(() => derive(new Map([[0, [0]], [1, [1]]])));
  assert.deepEqual(parseList('0-2,5'), [0, 1, 2, 5]);
  const o = cpuSets('servers=0-3,loadgen=4,5', m);
  assert.deepEqual(o.servers, [0, 1, 2, 3]);
  assert.deepEqual(o.loadgen, [4, 5]);
});

test('the loopback guard aborts on a listener on 0.0.0.0', async () => {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(12190, '0.0.0.0', r));
  try {
    assert.ok(listeners([process.pid]).some((l) => l.port === 12190));
    assert.throws(() => assertLoopback('fixture', [process.pid]), /non-loopback/);
  } finally {
    await new Promise((r) => s.close(r));
  }
  const ok = http.createServer(() => {});
  await new Promise((r) => ok.listen(12191, '127.0.0.1', r));
  try {
    assert.doesNotThrow(() => assertLoopback('fixture', [process.pid]));
  } finally {
    await new Promise((r) => ok.close(r));
  }
});

test('--plan arithmetic', () => {
  const p = { warmup: 2, duration: 8, repeats: 1, budgetedRepeats: 2, gate: null, s1Runs: 10 };
  // 10 cells × 11.5 s + 2 budgeted × 1 extra × 11.5 s + 2 starts × 3 s + 10 s (R1) = 115 + 23 + 6 + 10
  assert.equal(planSeconds([{ cells: 10, budgeted: 2 }], p, false, true), 154);
  assert.equal(planSeconds([{ cells: 10, budgeted: 0, unavailable: 'x' }], p, false, false), 0);
  assert.equal(planSeconds([], p, true, false), 75);
});

test('statistics: the significance band and histogram quantiles', () => {
  const a = summarize([100, 101, 99, 100, 100]);
  assert.equal(a.median, 100);
  assert.equal(significant(a, summarize([102, 102, 102])).significant, false);
  assert.equal(significant(a, summarize([110, 110, 111])).significant, true);
  assert.equal(lowerBound(32), 32);
  assert.equal(histQuantile({ 10: 50, 20: 50 }, 0.5), 10);
  assert.equal(histQuantile({ 10: 50, 20: 50 }, 0.99), 20);
});
