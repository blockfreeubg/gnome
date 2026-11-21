#!/usr/bin/env node
// Two-origin engine-host spike harness (docs/research/spike-engine-host.md).
//
//   cd tests/e2e && npm ci && node spike-engine-host/run.mjs [--browser chromium|firefox|all]
//        [--only suite,suite] [--skip suite,...] [--offline] [--strict] [--parallel]
//
// Starts HolyWisp x2 (Docker), the app/proxy/target servers and the leak sentinel on 127.0.0.1:22xxx, runs the
// suites in Chromium and Firefox, writes results/<timestamp>/{results.json,results.md,*.log} and stops
// everything it started. Environment: see tests/e2e/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { PORTS, RESULTS_DIR, HOLYWISP, NODE_MODULES, TICKETS } from './lib/config.mjs';
import { startServer, command, killServer, stopAllServers, events, eventsSince, portFree, run, sleep, onCleanup, cleanupAll, installSignalHandlers } from './lib/procs.mjs';
import { startHolyWisp } from './lib/holywisp.mjs';
import { BROWSERS, launch, newContext } from './lib/browsers.mjs';
import { openApp } from './lib/drive.mjs';
import { record, results, writeReport } from './lib/report.mjs';

const ALL_SUITES = ['smoke', 'sw', 'nav', 'transport', 'fallback', 'input', 'isolation', 'leak', 'perf', 'attack'];
// Suites that may run for both browsers at once (--parallel). The others restart the shared proxy server
// (transport, leak/hostcsp), judge results from shared server logs that the other browser's traffic would pollute
// (fallback: target request log; isolation: app API log; leak: sentinel + CSP reports) or measure timings (perf);
// with --parallel they run afterwards, one browser at a time.
const PARALLEL_SAFE = new Set(['smoke', 'sw', 'nav', 'input']);

function parseArgs(argv) {
  const a = { browsers: BROWSERS, suites: ALL_SUITES.filter((s) => s !== 'smoke' && s !== 'attack'), offline: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--browser') { const b = v(); a.browsers = b === 'all' ? BROWSERS : b.split(','); }
    else if (k === '--only') a.suites = v().split(',');
    else if (k === '--skip') { const s = new Set(v().split(',')); a.suites = a.suites.filter((x) => !s.has(x)); }
    else if (k === '--offline') a.offline = true;
    else if (k === '--strict') a.strict = true;
    else if (k === '--parallel') a.parallel = true; // run the browsers concurrently (each runs its suites in order)
    else if (k === '-h' || k === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument ${k}`);
  }
  for (const s of a.suites) if (!ALL_SUITES.includes(s)) throw new Error(`unknown suite ${s} (known: ${ALL_SUITES.join(', ')})`);
  for (const b of a.browsers) if (!BROWSERS.includes(b)) throw new Error(`unknown browser ${b}`);
  return a;
}

async function preflight(args) {
  if (!fs.existsSync(path.join(NODE_MODULES, 'playwright-core'))) throw new Error('dependencies missing: run `npm ci` in tests/e2e');
  if (HOLYWISP.runner === 'docker') await run('docker', ['version', '--format', '{{.Server.Version}}']).catch(() => { throw new Error('docker is required (or set HOLYWISP_RUNNER=host)'); });
  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portFree(port))) throw new Error(`port ${port} (${name}) is already in use`);
  }
  void args;
}

async function startProxy() {
  return startServer('proxy', 'proxy.mjs');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  installSignalHandlers();
  const startedAt = new Date().toISOString();
  const runDir = path.join(RESULTS_DIR, startedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(runDir, { recursive: true });
  process.env.SPIKE_RUN_DIR = runDir;
  console.log(`engine-host spike: suites ${args.suites.join(', ')} on ${args.browsers.join(', ')}; output ${runDir}`);
  await preflight(args);

  onCleanup(stopAllServers);
  console.log('starting HolyWisp (prod + test-only) and servers ...');
  await startHolyWisp('prod');
  await startHolyWisp('test');
  await startServer('target', 'target.mjs');
  await startServer('sentinel', 'sentinel.mjs');
  await startServer('app', 'app.mjs');
  await startProxy();

  const ctxBase = {
    runDir,
    offline: args.offline,
    events,
    eventsSince,
    command,
    sleep,
    TICKETS,
    openApp,
    newContext,
    async restartProxy(downMs = 1000) {
      await killServer('proxy', 'SIGKILL');
      await sleep(downMs);
      await startProxy();
    },
    killProxy: () => killServer('proxy', 'SIGKILL'),
    startProxy,
  };

  const meta = { startedAt, browsers: args.browsers, suites: args.suites, holywisp: HOLYWISP.image || HOLYWISP.bin, node: process.version };
  try {
    const runBrowser = async (browserName, suites = args.suites) => {
      for (const suite of suites) {
        const mod = await import(`./suites/${suite}.mjs`);
        console.log(`\n== ${suite} [${browserName}]`);
        const ctx = {
          ...ctxBase,
          browser: browserName,
          suite,
          launch: (opts) => launch(browserName, opts),
          record: (row) => record({ browser: browserName, suite, ...row }),
          log: (...m) => console.log(`     ${m.join(' ')}`.slice(0, 600)),
        };
        const t0 = Date.now();
        try {
          await mod.run(ctx);
        } catch (e) {
          record({ browser: browserName, suite, test: 'suite-error', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
        }
        console.log(`   (${suite} [${browserName}] took ${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    };
    // --parallel: Chromium and Firefox at the same time against the same servers (about half the wall time), but
    // only for PARALLEL_SAFE suites; the others follow one browser at a time.
    if (args.parallel) {
      const par = args.suites.filter((s) => PARALLEL_SAFE.has(s));
      const ser = args.suites.filter((s) => !PARALLEL_SAFE.has(s));
      if (ser.length) console.log(`--parallel: ${ser.join(', ')} will run one browser at a time after ${par.join(', ') || 'nothing'}`);
      await Promise.all(args.browsers.map((b) => runBrowser(b, par)));
      for (const b of args.browsers) await runBrowser(b, ser);
    } else for (const browserName of args.browsers) await runBrowser(browserName);
  } finally {
    const counts = writeReport(runDir, meta);
    fs.writeFileSync(path.join(runDir, 'events.json'), JSON.stringify(events.filter((e) => e.type !== 'target-request').slice(-20000), null, 1));
    console.log(`\nresults: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')} -> ${path.join(runDir, 'results.md')}`);
    await cleanupAll();
    const busy = [];
    for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port))) busy.push(`${name}:${port}`);
    console.log(busy.length ? `WARNING: ports still in use: ${busy.join(', ')}` : 'all harness ports are free again');
  }
  const unexpected = results.filter((r) => r.result === 'fail' && !r.expectFail);
  if (args.strict && unexpected.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e.stack || e);
  await cleanupAll();
  process.exit(2);
});
