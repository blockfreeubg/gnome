// Result rows of a run (one per test × engine × transport × browser) and results.md / results.json, like the spike.
import fs from 'node:fs';
import path from 'node:path';

export const results = [];

export function record(row) {
  if (!['pass', 'fail', 'skip'].includes(row.result)) throw new Error(`record(): result must be pass | fail | skip, got ${row.result}`);
  const r = {
    suite: row.suite || '-',
    test: String(row.test),
    engine: row.engine || '-',
    transport: row.transport || '-',
    browser: row.browser || '-',
    result: row.result,
    notes: row.notes ? String(row.notes) : '',
    expectFail: !!row.expectFail,
    data: row.data === undefined ? null : row.data,
    at: new Date().toISOString(),
  };
  results.push(r);
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[r.result];
  console.log(`  ${mark}  [${r.browser}] ${r.engine}/${r.transport}  ${r.suite}:${r.test}  ${r.notes}`.slice(0, 500));
  return r;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeReport(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  const counts = results.reduce((a, r) => ((a[r.result] = (a[r.result] || 0) + 1), a), {});
  const lines = [
    `# Wave B e2e results (${meta.startedAt})`,
    '',
    `Browsers: ${meta.browsers.join(', ')} · suites: ${meta.suites.join(', ')} · build: ${meta.buildId ?? 'n/a'} · gnome-server: ${meta.server}`,
    '',
    '| Suite | Test | Engine | Transport | Browser | Result | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${cell(r.suite)} | ${cell(r.test)} | ${cell(r.engine)} | ${cell(r.transport)} | ${cell(r.browser)} | ${r.result}${r.expectFail ? ' (expected)' : ''} | ${cell(r.notes)} |`),
    '',
    `Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    '',
  ];
  fs.writeFileSync(path.join(dir, 'results.md'), lines.join('\n'));
  return counts;
}
