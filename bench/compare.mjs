#!/usr/bin/env node
// Noise-aware comparison of two result sets (docs/WAVE-D.md §3.4) and the runtime ceilings of §7
// (scripts/budgets.json). Exit 1 on a significant regression of a budgeted cell or a ceiling exceeded.
//   node bench/compare.mjs <before>/results.json <after>/results.json
//   node bench/compare.mjs --ceilings <results>/results.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { significant } from './lib/stats.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const load = (f) => JSON.parse(readFileSync(f.endsWith('.json') ? f : path.join(f, 'results.json'), 'utf8'));
const budgets = JSON.parse(readFileSync(path.join(REPO, 'scripts/budgets.json'), 'utf8')).runtime;
const lowerIsBetter = (metric) => !/\/s$/.test(metric);
const val = (m) => (m ? (m.merged ?? m.median) : undefined);

function find(res, scenario, variant, config) {
  return res.summary.find((s) => s.scenario === scenario && s.variant === variant && s.config === config);
}
const run = (res, scenario, variantPrefix, config) => res.runs.find((r) => r.scenario === scenario && r.config === config && r.variant.startsWith(variantPrefix));

/** The §7 runtime ceilings on one result set: [{id, value, limit, ok}]. */
export function ceilings(res) {
  const out = [];
  const add = (id, what, value, limit, ok) => out.push({ id, what, value, limit, ok: value === undefined || Number.isNaN(value) ? null : ok });
  const r1a = run(res, 'R1', '(a)', 'rust');
  add('RB1', 'R1 (a) gnome-server RSS MiB', r1a?.rssMiB?.['gnome-server'], budgets.RB1.max, r1a?.rssMiB?.['gnome-server'] <= budgets.RB1.max);
  const r1b = run(res, 'R1', '(b)', 'rust');
  add('RB2', 'R1 (b) gnome-server RSS MiB', r1b?.rssMiB?.['gnome-server'], budgets.RB2.max, r1b?.rssMiB?.['gnome-server'] <= budgets.RB2.max);
  const slope = res.summary.find((s) => s.scenario === 'W4' && s.config === 'rust' && s.variant.startsWith('slope'));
  const sv = val(slope?.metrics?.['KiB/conn gnome-server']);
  add('RB3', `W4 ${slope?.variant ?? 'slope'} gnome-server KiB/conn`, sv, budgets.RB3.max, sv <= budgets.RB3.max);
  const g = val(find(res, 'W1', '1x10', 'rust')?.metrics['MiB/s']);
  const h = val(find(res, 'W1', '1x10', 'holywisp')?.metrics['MiB/s']);
  add('RB5', 'W1 1x10 rust / holywisp', g / h, budgets.RB5.min, g / h >= budgets.RB5.min);
  const wr = find(res, 'W2', 'idle', 'rust')?.metrics;
  const wh = find(res, 'W2', 'idle', 'holywisp')?.metrics;
  const d99 = val(wr?.['p99 µs']) - val(wh?.['p99 µs']);
  const d999 = val(wr?.['p99.9 µs']) - val(wh?.['p99.9 µs']);
  add('RB6', 'W2 idle added p99 µs', d99, budgets.RB6.p99Max, d99 <= budgets.RB6.p99Max);
  add('RB6', 'W2 idle added p99.9 µs', d999, budgets.RB6.p999Max, d999 <= budgets.RB6.p999Max);
  const w3 = val(find(res, 'W3', '(a) setup churn', 'rust')?.metrics['p99 µs']);
  add('RB7', 'W3 (a) rust p99 µs', w3, budgets.RB7.max, w3 <= budgets.RB7.max);
  const hr = val(find(res, 'H1', '(a) c=64', 'rust')?.metrics['req/s']);
  const hn = val(find(res, 'H1', '(a) c=64', 'node4')?.metrics['req/s']);
  add('RB8', 'H1 (a) c=64 rust / node4', hr / hn, budgets.RB8.min, hr / hn >= budgets.RB8.min);
  const hp = val(find(res, 'H1', '(a) 5000/s', 'rust')?.metrics['p99 µs']);
  add('RB8', 'H1 (a) 5000/s rust p99 µs', hp, budgets.RB8.p99Max, hp <= budgets.RB8.p99Max);
  const a1 = val(find(res, 'A1', 'ticket 2000/s', 'rust')?.metrics['p99 µs']);
  add('RB9', 'A1 ticket 2000/s rust p99 µs', a1, budgets.RB9.max, a1 <= budgets.RB9.max);
  for (const [i, v] of ['(a)', '(b)', '(c)'].entries()) {
    const s = run(res, 'S1', v, 'rust')?.startupMs?.p50;
    add('RB10', `S1 ${v} rust p50 ms`, s, budgets.RB10.max[i], s <= budgets.RB10.max[i]);
  }
  return out;
}

function printCeilings(res) {
  let bad = 0;
  for (const c of ceilings(res)) {
    const mark = c.ok === null ? 'n/a ' : c.ok ? 'ok  ' : 'OVER';
    if (c.ok === false) bad++;
    console.log(`${mark} ${c.id.padEnd(5)} ${c.what.padEnd(36)} ${c.value === undefined || Number.isNaN(c.value) ? '—' : Number(c.value).toFixed(2)} (limit ${c.limit})`);
  }
  return bad;
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (args[0] === '--ceilings') {
    const res = load(args[1]);
    console.log(`ceilings of ${res.meta.id} (${res.meta.preset} preset${res.meta.note ? `; ${res.meta.note}` : ''})`);
    process.exit(printCeilings(res) ? 1 : 0);
  }
  if (args.length !== 2) {
    console.error('usage: node bench/compare.mjs <before> <after> | --ceilings <results>');
    process.exit(2);
  }
  const [before, after] = args.map(load);
  let regressions = 0;
  console.log(`before ${before.meta.id} (${before.meta.preset}) → after ${after.meta.id} (${after.meta.preset})`);
  for (const s of after.summary) {
    const b = find(before, s.scenario, s.variant, s.config);
    if (!b) continue;
    for (const [metric, m] of Object.entries(s.metrics)) {
      const bm = b.metrics[metric];
      if (!bm || !m) continue;
      const sig = significant(bm, m);
      if (!sig.significant) continue;
      const worse = lowerIsBetter(metric) ? sig.change > 0 : sig.change < 0;
      const budgeted = Boolean(s.budget);
      if (worse && budgeted) regressions++;
      console.log(`${worse ? (budgeted ? 'REGRESSION' : 'worse     ') : 'better    '} ${s.scenario} ${s.variant} ${s.config} ${metric}: ${val(bm)} → ${val(m)} (${(sig.change * 100).toFixed(1)} %, band ${(sig.band * 100).toFixed(1)} %)`);
    }
  }
  console.log('— ceilings of the after set —');
  const over = printCeilings(after);
  process.exit(regressions || over ? 1 : 0);
}
