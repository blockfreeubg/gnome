// Result rows: one per engine x transport x browser x test, as the spike report's results table.
import fs from 'node:fs';
import path from 'node:path';

export const results = [];

export function record(row) {
  const r = {
    engine: row.engine || '-',
    transport: row.transport || '-',
    browser: row.browser || '-',
    suite: row.suite || '-',
    test: row.test,
    result: row.result, // pass | fail | partial | not_run
    notes: row.notes || '',
    data: row.data === undefined ? null : row.data,
    expectFail: !!row.expectFail, // documented upstream behaviour, not a harness regression
    at: new Date().toISOString(),
  };
  results.push(r);
  const mark = { pass: 'PASS', fail: 'FAIL', partial: 'PART', not_run: 'SKIP' }[r.result] || r.result;
  console.log(`  ${mark.padEnd(4)}  [${r.browser}] ${r.engine}/${r.transport}  ${r.suite}:${r.test}  ${r.notes}`.slice(0, 400));
  return r;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeReport(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  const lines = [
    `# Engine-host spike results (${meta.startedAt})`,
    '',
    `Browsers: ${meta.browsers.join(', ')} · suites: ${meta.suites.join(', ')} · HolyWisp: ${meta.holywisp}`,
    '',
    '| Suite | Test | Engine | Transport | Browser | Result | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => `| ${cell(r.suite)} | ${cell(r.test)} | ${cell(r.engine)} | ${cell(r.transport)} | ${cell(r.browser)} | ${r.result} | ${cell(r.notes)} |`),
    '',
  ];
  const counts = results.reduce((a, r) => ((a[r.result] = (a[r.result] || 0) + 1), a), {});
  lines.push(`Totals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  fs.writeFileSync(path.join(dir, 'results.md'), lines.join('\n') + '\n');
  return counts;
}
