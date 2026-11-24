#!/usr/bin/env node
// Wave B e2e runner (docs/WAVE-B.md §3; suite API: tests/e2e/engine/README.md).
//
//   cd tests/e2e && node engine/run.mjs [--browser chromium|firefox|all] [--only a,b] [--skip a,b] [--parts x,y]
//        [--no-build] [--dist <dir>] [--build-server] [--offline] [--blocker-real] [--strict]
//
// Builds the frontend with `npm run build:e2e` (plus the e2e driver page), starts the REAL stack on loopback (HolyWisp
// for the direct route and for one VPN profile, gnome-server in two-origin mode serving that build, the spike's local
// target site and leak sentinel, the content-blocker fixture server), runs the suites of suites/*.mjs in Chromium and
// Firefox, writes results.md and results.json into <E2E_RESULTS_DIR>/<timestamp>/, and stops everything it started.
// Suites that need their own server layout (`export const standalone = true`) run once per run as a child process on
// their own port block. Filter lists (WAVE-B3 §12.1, lib/blocker.mjs): by default the server offers only the test
// lists of fixtures/blocker/lists/*.txt, the generated big list and `ubo-resources` (upstream; with --offline the
// pinned copy); --blocker-real keeps the built-in registry instead (needs the internet, §12.3).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupAll, installSignalHandlers, run, sleep } from '../spike-engine-host/lib/procs.mjs';
import { launch, newContext, BROWSERS } from './lib/browsers.mjs';
import { buildFrontend, loadContract } from './lib/build.mjs';
import { CARGO_TARGET_DIR, ENGINE_E2E_DIR, HOLYWISP, PORTS, REPO_DIR, RESULTS_DIR, SERVER_BIN } from './lib/config.mjs';
import { standalonePortBase } from './lib/ports.mjs';
import { openApp } from './lib/drive.mjs';
import { record, results, writeReport } from './lib/report.mjs';
import { portsInUse, startStack } from './lib/stack.mjs';

const SUITES_DIR = path.join(ENGINE_E2E_DIR, 'suites');
/** Suites run in this order first; the rest alphabetically. Files ending in -lib.mjs are helpers, not suites. */
const FIRST = ['build', 'sw', 'transport'];

function discoverSuites() {
  const names = fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('-lib.mjs'))
    .map((f) => f.slice(0, -4));
  return [...FIRST.filter((s) => names.includes(s)), ...names.filter((s) => !FIRST.includes(s)).sort()];
}

/**
 * The port block of standalone suites: E2E_STANDALONE_PORT_BASE (default E2E_PORT_BASE + 100) up to +99, passed to
 * them as BACKEND_E2E_PORT_BASE (backend-lib.mjs: app +0, admin +2, HolyWisp +10/+11, sentinel +20, HTTPS front +30,
 * backend-reload +50/+51/+59). The other suite libraries' blocks follow E2E_PORT_BASE too (lib/ports.mjs).
 */
const STANDALONE_PORT_BASE = standalonePortBase();

/** Every `<name>.json` row file under `dir` (a standalone suite writes one into its work directory). */
function findRows(dir, name) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findRows(p, name));
    else if (e.name === `${name}.json`) out.push(p);
  }
  return out;
}

/**
 * Runs a standalone suite once for every browser of the run: `node suites/<suite>.mjs --browser <list> [--static
 * <dist>]` with BACKEND_E2E_PORT_BASE (its own port block), BACKEND_E2E_DIR (<runDir>/<suite>/) and GNOME_SERVER_BIN.
 * The suite writes its rows as <suite>.json there (backend-lib.mjs writeResults); they become this run's rows.
 */
async function runStandalone(suite, { browsers, runDir, dist, useDist }) {
  const dir = path.join(runDir, suite);
  fs.mkdirSync(dir, { recursive: true });
  const args = [path.join(SUITES_DIR, `${suite}.mjs`), '--browser', browsers.join(','), ...(useDist ? ['--static', dist] : [])];
  const env = { ...process.env, BACKEND_E2E_PORT_BASE: String(STANDALONE_PORT_BASE), BACKEND_E2E_DIR: dir, GNOME_SERVER_BIN: SERVER_BIN };
  const log = fs.openSync(path.join(dir, 'output.log'), 'w');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: path.join(ENGINE_E2E_DIR, '..'), env, stdio: ['ignore', log, log] });
    child.once('exit', (c, sig) => resolve(c ?? sig));
    child.once('error', (e) => resolve(String(e)));
  });
  fs.closeSync(log);
  const files = findRows(dir, suite);
  let n = 0;
  for (const f of files) {
    for (const row of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      record({ ...row, browser: row.browser ?? browsers[0], suite });
      n++;
    }
  }
  if (!n) {
    const tail = fs.readFileSync(path.join(dir, 'output.log'), 'utf8').slice(-800);
    record({ browser: browsers[0], suite, test: 'suite-error', result: 'fail', notes: `standalone run exited ${code} without rows: ${tail}` });
  }
  console.log(`   (${suite}: ${n} rows from the standalone run, exit ${code}; output ${path.join(dir, 'output.log')})`);
}

function parseArgs(argv) {
  const all = discoverSuites();
  const a = { browsers: BROWSERS, suites: all, parts: null, build: true, dist: null, buildServer: false, offline: false, blockerReal: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--browser') {
      const b = v();
      a.browsers = b === 'all' ? BROWSERS : b.split(',');
    } else if (k === '--only') a.suites = v().split(',');
    else if (k === '--skip') {
      const s = new Set(v().split(','));
      a.suites = a.suites.filter((x) => !s.has(x));
    } else if (k === '--parts') a.parts = v().split(',');
    else if (k === '--no-build') a.build = false;
    else if (k === '--dist') a.dist = path.resolve(v());
    else if (k === '--build-server') a.buildServer = true;
    else if (k === '--offline') a.offline = true;
    else if (k === '--blocker-real') a.blockerReal = true;
    else if (k === '--strict') a.strict = true;
    else if (k === '-h' || k === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  for (const s of a.suites) if (!all.includes(s)) throw new Error(`unknown suite ${s} (known: ${all.join(', ')})`);
  for (const b of a.browsers) if (!BROWSERS.includes(b)) throw new Error(`unknown browser ${b}`);
  if (a.blockerReal && a.offline) throw new Error('--blocker-real needs the internet: it cannot run with --offline');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  installSignalHandlers();
  const startedAt = new Date().toISOString();
  const runDir = path.join(RESULTS_DIR, startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true });
  const dist = args.dist ?? process.env.E2E_DIST_DIR ?? path.join(RESULTS_DIR, 'dist');
  console.log(`wave-b e2e: suites ${args.suites.join(', ')} on ${args.browsers.join(', ')}; ports ${PORTS.app}..${PORTS.target}; output ${runDir}`);

  const busy = await portsInUse();
  if (busy.length) throw new Error(`ports in use: ${busy.join(', ')} (set E2E_PORT_BASE to a free range)`);
  if (args.buildServer) {
    console.log(`building gnome-server (CARGO_TARGET_DIR=${CARGO_TARGET_DIR}) ...`);
    await run('cargo', ['build', '--release', '-p', 'gnome-server'], {
      cwd: REPO_DIR,
      env: { ...process.env, CARGO_TARGET_DIR, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '3' },
      maxBuffer: 64 << 20,
    });
  }
  if (!fs.existsSync(SERVER_BIN)) throw new Error(`gnome-server not found at ${SERVER_BIN}: run with --build-server or set GNOME_SERVER_BIN`);

  const contract = await loadContract();
  let build = { problems: [], buildId: null, engineHost: fs.existsSync(path.join(dist, 'engine', 'index.html')), built: false };
  if (args.build) build = { ...(await buildFrontend({ dist, contract })), built: true };
  else if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`--no-build but ${dist} has no build`);

  const meta = {
    startedAt,
    browsers: args.browsers,
    suites: args.suites,
    buildId: build.buildId,
    server: SERVER_BIN,
    holywisp: `${HOLYWISP.bin} (${HOLYWISP.runner})`,
    node: process.version,
    dist,
    filterLists: args.blockerReal ? 'real (built-in registry)' : `test${args.offline ? ' (offline: pinned ubo-resources)' : ''}`,
  };
  let stack;
  try {
    console.log('starting HolyWisp (direct + VPN profile), gnome-server, target site, sentinel and blocker fixtures ...');
    stack = await startStack({ runDir, staticDir: dist, blocker: { mode: args.blockerReal ? 'real' : 'test', offline: args.offline } });
    const standalone = [];
    for (const suite of args.suites) if ((await import(path.join(SUITES_DIR, `${suite}.mjs`))).standalone === true) standalone.push(suite);
    for (const browserName of args.browsers) {
      for (const suite of args.suites) {
        if (standalone.includes(suite)) continue;
        const mod = await import(path.join(SUITES_DIR, `${suite}.mjs`));
        if (typeof mod.run !== 'function') {
          record({ browser: browserName, suite, test: 'suite-error', result: 'fail', notes: 'the suite exports no run(ctx)' });
          continue;
        }
        console.log(`\n== ${suite} [${browserName}]`);
        const launched = new Set();
        const ctx = {
          browser: browserName,
          suite,
          runDir,
          firstBrowser: args.browsers[0],
          parts: args.parts,
          offline: args.offline,
          /** --blocker-real: the server offers the built-in filter lists (internet), not the test lists. */
          blockerReal: args.blockerReal,
          records: results,
          build,
          contract,
          engineHost: build.engineHost,
          async launch(opts) {
            const b = await launch(browserName, opts);
            launched.add(b);
            b.once('disconnected', () => launched.delete(b));
            return b;
          },
          newContext: (browser, opts) => newContext(browser, opts),
          openApp: (context, query, opts) => openApp(context, query, { origin: stack.appOrigin, ...opts }),
          record: (row) => record({ browser: browserName, suite, ...row }),
          log: (...m) => console.log(`     ${m.join(' ')}`.slice(0, 800)),
          sleep,
          stack,
        };
        const t0 = Date.now();
        try {
          await mod.run(ctx);
        } catch (e) {
          record({ browser: browserName, suite, test: 'suite-error', result: 'fail', notes: String(e.stack || e).slice(0, 800) });
        } finally {
          // A suite closes what it launches; anything left open is closed here (one browser of each kind at a time).
          for (const b of launched) await b.close().catch(() => {});
        }
        console.log(`   (${suite} [${browserName}] took ${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    }
    for (const suite of standalone) {
      console.log(`\n== ${suite} [${args.browsers.join(', ')}] (standalone, ports from ${STANDALONE_PORT_BASE})`);
      const t0 = Date.now();
      await runStandalone(suite, { browsers: args.browsers, runDir, dist, useDist: fs.existsSync(path.join(dist, 'e2e-driver', 'index.html')) });
      console.log(`   (${suite} took ${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  } finally {
    const counts = writeReport(runDir, meta);
    console.log(`\nresults: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')} -> ${path.join(runDir, 'results.md')}`);
    await cleanupAll();
    await sleep(300);
    const left = await portsInUse();
    console.log(left.length ? `WARNING: ports still in use: ${left.join(', ')}` : 'all runner ports are free again');
  }
  const unexpected = results.filter((r) => r.result === 'fail' && !r.expectFail);
  if (args.strict && unexpected.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e.stack || e);
  await cleanupAll();
  process.exit(2);
});
