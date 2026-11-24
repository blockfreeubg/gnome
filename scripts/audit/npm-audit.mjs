#!/usr/bin/env node
/**
 * npm audit with GNOME's classification (WAVE-D D24, docs/AUDIT.md).
 *
 *   node scripts/audit/npm-audit.mjs [--offline] [--fixtures DIR] [--json FILE] [--today YYYY-MM-DD]
 *
 * Runs `npm audit --json` in frontend/, tests/e2e/ and bench/wispjs/ (with --fixtures: reads DIR/<project>.json
 * instead, no network; --offline: every audit is "skipped", never "pass") and classifies each finding:
 * - shipped: a package that reaches browsers. Today that is every package of frontend/ (conservative: the chunk
 *   graphs of GNOME's own bundles that would narrow it are not written yet, WAVE-D §4.6), which includes the
 *   VENDOR_PACKAGES pins and every package bundled inside them (copy-vendor's transitive `dependencies`);
 * - build-only: tests/e2e/ and bench/wispjs/ (never shipped).
 * Shipped high/critical findings fail unless ignored; an expired ignore fails; other findings are reported. The
 * locks' hasInstallScript packages must be allow-listed (installs run with --ignore-scripts anyway).
 * Exit 0 pass, 1 policy failure, 2 usage or tool error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECTS = [
  { name: 'frontend', dir: 'frontend', shipped: true },
  { name: 'tests-e2e', dir: 'tests/e2e', shipped: false },
  { name: 'bench-wispjs', dir: 'bench/wispjs', shipped: false },
];

export function loadPolicy(file = path.join(ROOT, 'scripts', 'audit', 'npm-policy.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Days from `today` (YYYY-MM-DD) to `date`. */
function daysUntil(date, today) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Problems with the ignore list: expired, too far ahead, no reason. */
export function checkIgnores(policy, today) {
  const problems = [];
  for (const ig of policy.ignores ?? []) {
    const what = ig.advisory ?? ig.package ?? '(unnamed)';
    if (!ig.reason) problems.push(`ignore ${what}: no reason`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ig.expires ?? '')) problems.push(`ignore ${what}: no expires date`);
    else if (daysUntil(ig.expires, today) < 0) problems.push(`ignore ${what}: expired on ${ig.expires}`);
    else if (daysUntil(ig.expires, today) > (policy.maxIgnoreDays ?? 90)) problems.push(`ignore ${what}: expires more than ${policy.maxIgnoreDays ?? 90} days ahead`);
  }
  return problems;
}

/** Advisory ids/URLs of a finding (npm audit v2 report: `via` holds advisories or names of other findings). */
function advisories(v) {
  return (v.via ?? []).filter((x) => typeof x === 'object').map((x) => x.url ?? String(x.source));
}

/**
 * Classify one project's `npm audit --json` report. `shippedProject`: the project's packages reach browsers.
 * `bundledIn`: package names bundled inside a shipped vendored package (counted as shipped from any project).
 */
export function classify(report, { shippedProject, bundledIn = new Set(), policy, today }) {
  const findings = [];
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    const shipped = shippedProject || bundledIn.has(name);
    const ids = advisories(v);
    const ignore = (policy.ignores ?? []).find(
      (ig) => (ig.package === name || ids.some((id) => ig.advisory && id.includes(ig.advisory))) && /^\d{4}-\d{2}-\d{2}$/.test(ig.expires ?? '') && daysUntil(ig.expires, today) >= 0,
    );
    const fails = shipped && (policy.failOn ?? ['high', 'critical']).includes(v.severity) && !ignore;
    findings.push({ package: name, severity: v.severity, shipped, advisories: ids, ignored: !!ignore, fails });
  }
  return findings;
}

/** Packages with an install script in a lock (v2/v3 `packages`), as names. */
export function installScripts(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([key, p]) => key && p.hasInstallScript)
    .map(([key]) => key.split('node_modules/').pop());
}

/** Names of packages bundled inside the vendored engines (their transitive `dependencies` as installed). */
async function vendorBundled() {
  const names = new Set();
  try {
    const cv = await import(path.join(ROOT, 'frontend', 'scripts', 'copy-vendor.mjs'));
    const nm = path.join(ROOT, 'frontend', 'node_modules');
    for (const p of cv.vendorPackages()) {
      names.add(p.pkg);
      const dir = path.join(nm, p.pkg);
      if (existsSync(dir)) for (const [id] of cv.bundledDependencies(dir, nm)) names.add(id.slice(0, id.lastIndexOf('@')));
    }
  } catch (err) {
    process.stderr.write(`npm-audit: cannot list vendored packages (${err.message}); frontend counts as shipped anyway\n`);
  }
  return names;
}

export async function run({ offline = false, fixtures = null, today = new Date().toISOString().slice(0, 10), policyFile } = {}) {
  const policy = loadPolicy(policyFile);
  const bundledIn = await vendorBundled();
  const out = { tool: `npm ${npmVersion()}`, today, projects: [], installScripts: [], ignoreProblems: checkIgnores(policy, today), status: 'pass' };
  for (const proj of PROJECTS) {
    const lockFile = path.join(ROOT, proj.dir, 'package-lock.json');
    if (!existsSync(lockFile)) {
      out.projects.push({ name: proj.name, status: 'skipped', reason: 'no package-lock.json' });
      continue;
    }
    // Allow-list entries: "name" (any project) or "project:name".
    const allowed = (n) => (policy.installScriptsAllow ?? []).some((a) => a === n || a === `${proj.name}:${n}`);
    const scripts = installScripts(JSON.parse(readFileSync(lockFile, 'utf8'))).filter((n) => !allowed(n));
    for (const n of scripts) out.installScripts.push(`${proj.name}: ${n}`);
    let report;
    if (fixtures) {
      const f = path.join(fixtures, `${proj.name}.json`);
      if (!existsSync(f)) {
        out.projects.push({ name: proj.name, status: 'skipped', reason: 'no fixture' });
        continue;
      }
      report = JSON.parse(readFileSync(f, 'utf8'));
    } else if (offline) {
      out.projects.push({ name: proj.name, status: 'skipped', reason: '--offline (npm audit needs the registry)' });
      continue;
    } else {
      try {
        // npm audit exits 1 when it finds anything; the JSON is on stdout either way.
        report = JSON.parse(execFileSync('npm', ['audit', '--json', '--package-lock-only'], { cwd: path.join(ROOT, proj.dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (err) {
        try {
          report = JSON.parse(err.stdout);
        } catch {
          out.projects.push({ name: proj.name, status: 'error', reason: String(err.stderr || err.message).trim().split('\n')[0] });
          out.status = 'error';
          continue;
        }
      }
      if (report.error) {
        out.projects.push({ name: proj.name, status: 'error', reason: report.error.summary ?? 'npm audit failed' });
        out.status = 'error';
        continue;
      }
    }
    const findings = classify(report, { shippedProject: proj.shipped, bundledIn, policy, today });
    const status = findings.some((f) => f.fails) ? 'fail' : 'pass';
    out.projects.push({ name: proj.name, status, findings });
  }
  if (out.status !== 'error' && (out.projects.some((p) => p.status === 'fail') || out.installScripts.length || out.ignoreProblems.length)) out.status = 'fail';
  if (out.status === 'pass' && out.projects.every((p) => p.status === 'skipped')) out.status = 'skipped';
  return out;
}

function npmVersion() {
  try {
    return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = { offline: false, fixtures: null, json: null, today: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--offline') opt.offline = true;
    else if (a === '--fixtures') opt.fixtures = path.resolve(args[++i] ?? '');
    else if (a === '--json') opt.json = args[++i];
    else if (a === '--today') opt.today = args[++i];
    else {
      process.stderr.write(`usage: npm-audit.mjs [--offline] [--fixtures DIR] [--json FILE] [--today YYYY-MM-DD]\n`);
      process.exit(2);
    }
  }
  const out = await run(opt);
  for (const p of out.projects) {
    const n = p.findings?.length ?? 0;
    process.stdout.write(`npm audit ${p.name}: ${p.status}${p.reason ? ` (${p.reason})` : ''}${n ? `, ${n} finding(s)` : ''}\n`);
    for (const f of p.findings ?? []) process.stdout.write(`  ${f.severity} ${f.package} ${f.shipped ? 'shipped' : 'build-only'}${f.ignored ? ' (ignored)' : ''}${f.fails ? ' FAILS' : ''}\n`);
  }
  for (const s of out.installScripts) process.stdout.write(`install script not allow-listed: ${s}\n`);
  for (const s of out.ignoreProblems) process.stdout.write(`${s}\n`);
  if (opt.json) writeFileSync(opt.json, `${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.status === 'fail' ? 1 : out.status === 'error' ? 2 : 0);
}
