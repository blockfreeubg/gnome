// Lane e (backend) e2e suite: GNOME_STATIC_RELOAD with the real `npm run dev:engine` watch build (docs/WAVE-B.md §6
// item 8: "the static index is rebuilt when a request misses … so `npm run dev:engine` works without restarting
// gnome-server"; ARCHITECTURE §3 "Two-origin development").
//
// gnome-server (two-origin, GNOME_STATIC_RELOAD=true) starts on an EMPTY static dir, so /engine/ is the "not built"
// page. Then `npm run dev:engine` (lane b's script: copy-vendor + the engine-host and SW watch builds) writes into that
// dir; without a restart the server must serve the new engine host (templated, under its policy), /sw.js with the
// build id, the vendor files and every chunk the page loads, in Chromium and Firefox. A second dev:engine run with
// another build id (a rebuild landing while the server keeps running) must be picked up as well. The watch processes
// run in their own process group, which this file stops (also on failure or Ctrl-C).
//
//   node tests/e2e/engine/suites/backend-reload.mjs [--browser chromium|firefox|all]
// Ports: BACKEND_E2E_PORT_BASE + 50 (app) and + 51 (proxy listener). Output: BACKEND_E2E_DIR (backend-lib.mjs).
// Under the runner (tests/e2e/engine/run.mjs) it runs as a standalone suite (`standalone` below): once per run, as a
// child process on the runner's standalone port block, with its own server and its own build.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO, assertPortsFree, cleanupAll, installSignalHandlers, launchBrowser, loadContract, onCleanup, parseArgs, portBase,
  portFree, recorder, sleep, startGnomeServer, summarize, workDir, writeResults,
} from './backend-lib.mjs';

const FRONTEND = path.join(REPO, 'frontend');
const RELOAD_GAP_MS = 1_500; // gnome-server's RELOAD_MIN_GAP (1 s) plus room for file mtimes to move on

/** `npm run dev:engine` into `dist` with `buildId`, in its own process group; resolves once both builds are written. */
async function devEngine(dist, buildId, dir) {
  const log = [];
  const child = spawn('npm', ['run', 'dev:engine'], {
    cwd: FRONTEND,
    env: { ...process.env, GNOME_DIST_DIR: dist, GNOME_BUILD_ID: buildId },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const keep = (d) => log.push(d.toString());
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise((r) => child.once('exit', r));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, sleep(10_000)]);
    }
    writeFileSync(path.join(dir, `dev-engine-${buildId}.log`), log.join(''));
  };
  onCleanup(stop);
  const ready = () =>
    existsSync(path.join(dist, 'engine', 'index.html')) &&
    existsSync(path.join(dist, 'vendor', 'bare-mux', 'worker.js')) &&
    existsSync(path.join(dist, 'sw.js')) &&
    readFileSync(path.join(dist, 'sw.js'), 'utf8').includes(buildId);
  const t0 = Date.now();
  while (!ready()) {
    if (child.exitCode !== null) throw new Error(`npm run dev:engine exited early:\n${log.join('').slice(-2000)}`);
    if (Date.now() - t0 > 120_000) throw new Error(`no engine-host build with ${buildId} after 120 s:\n${log.join('').slice(-2000)}`);
    await sleep(500);
  }
  // vite writes the page, chunks and manifest of one build in quick succession: let it finish.
  await sleep(RELOAD_GAP_MS);
  return { stop, log: () => log.join('') };
}

async function served(stack, buildId, m) {
  const res = await fetch(`${stack.proxyOrigin}/engine/`);
  const html = await res.text();
  const meta = /<meta name="gnome-app-origins" content="([^"]*)"/.exec(html)?.[1] ?? null;
  const sw = await (await fetch(`${stack.proxyOrigin}/sw.js`)).text();
  const worker = await fetch(`${stack.proxyOrigin}/vendor/bare-mux/worker.js`);
  const chunks = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((x) => x[1]);
  const chunkStatus = [];
  for (const c of chunks) chunkStatus.push((await fetch(`${stack.proxyOrigin}${c}`)).status);
  return {
    status: res.status,
    csp: res.headers.get('content-security-policy'),
    wantCsp: m.engineHostCsp([stack.appOrigin]),
    meta,
    swHasId: sw.includes(buildId),
    workerPolicies: (worker.headers.get('content-security-policy') ?? '').split(/,\s*/).filter(Boolean).length,
    chunks: chunks.length,
    chunksOk: chunkStatus.every((s) => s === 200),
  };
}

/** The engine host loaded at top level: every request of the page answers < 400 and nothing violates its policy. */
async function loadInBrowser(ctx, stack) {
  const browser = await ctx.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const bad = [];
    const csp = [];
    page.on('requestfailed', (r) => bad.push(`failed ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) bad.push(`${r.status()} ${r.url()}`);
    });
    page.on('console', (msg) => {
      if (/Content[- ]Security[- ]Policy|Refused to/i.test(msg.text()) && !/favicon/.test(msg.text())) csp.push(msg.text().slice(0, 160));
    });
    await page.goto(`${stack.proxyOrigin}/engine/`, { waitUntil: 'load' });
    await sleep(1_000);
    const scripts = await page.evaluate(() => document.scripts.length);
    return { bad, csp, scripts };
  } finally {
    await browser.close();
  }
}

/** The runner (run.mjs) starts this file as a child process with its own server layout instead of calling run(ctx). */
export const standalone = true;

export async function run(ctx) {
  const { record, stack } = ctx;
  if (!stack.reload) {
    record({ test: 'reload: GNOME_STATIC_RELOAD with npm run dev:engine', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/backend-reload.mjs' });
    return;
  }
  if (stack.reload.notBuilt) {
    const first = await stack.reload.notBuilt();
    record({
      test: 'reload: before the first build /engine/ is the "not built" page',
      result: first.status === 503 && /engine host/i.test(first.body) ? 'pass' : 'fail',
      notes: `status ${first.status}`,
    });
  }
  for (const buildId of stack.reload.builds) {
    const s = await stack.reload.state(buildId);
    const ok = s.status === 200 && s.csp === s.wantCsp && s.meta === stack.appOrigin && s.swHasId && s.workerPolicies === 2 && s.chunks > 0 && s.chunksOk;
    record({ test: `reload: dev:engine build ${buildId} is served without a restart`, result: ok ? 'pass' : 'fail', notes: JSON.stringify({ ...s, wantCsp: undefined }) });
    const b = await loadInBrowser(ctx, stack);
    record({
      test: `reload: build ${buildId} loads completely in the browser`,
      result: b.bad.length === 0 && b.csp.length === 0 && b.scripts > 0 ? 'pass' : 'fail',
      notes: `${b.scripts} scripts; failed ${JSON.stringify(b.bad.slice(0, 6))}; CSP ${JSON.stringify(b.csp.slice(0, 3))}`,
    });
  }
}

// ── standalone driver ────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  const dir = workDir(`reload-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const dist = path.join(dir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const ports = { app: portBase() + 50, proxy: portBase() + 51 };
  for (const p of Object.values(ports)) if (!(await portFree(p))) throw new Error(`port ${p} is in use`);
  const m = await loadContract();
  const server = await startGnomeServer({
    dir,
    staticDir: dist,
    label: 'reload-server',
    env: {
      GNOME_BIND: `127.0.0.1:${ports.app}`,
      GNOME_PROXY_BIND: `127.0.0.1:${ports.proxy}`,
      GNOME_ADMIN_BIND: '',
      GNOME_STATIC_RELOAD: 'true',
      GNOME_WISP_UPSTREAM: `127.0.0.1:${portBase() + 59}`,
    },
  });
  const builds = [`reload-${process.pid}-1`, `reload-${process.pid}-2`];
  const stack = { appOrigin: server.appOrigin, proxyOrigin: server.proxyOrigin };
  const all = [];
  try {
    // One pass per browser: the first browser checks the not-built page and both builds, the others the last build.
    let builtUpTo = 0;
    let current = null;
    stack.reload = {
      builds,
      notBuilt: async () => {
        const res = await fetch(`${stack.proxyOrigin}/engine/`);
        return { status: res.status, body: await res.text() };
      },
      state: async (buildId) => {
        const index = builds.indexOf(buildId);
        if (index >= builtUpTo) {
          await current?.stop();
          current = await devEngine(dist, buildId, dir);
          builtUpTo = index + 1;
        }
        return served(stack, buildId, m);
      },
    };
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows, record } = recorder(name);
      const ctx = { browser: name, suite: 'backend-reload', runDir: dir, launch: (o) => launchBrowser(name, o), record, log: console.log, sleep, stack };
      if (name !== args.browsers[0]) {
        // The server and its static dir are shared: later browsers load the last build (no rows for checks they skip).
        stack.reload.builds = builds.slice(-1);
        stack.reload.notBuilt = null;
      }
      try {
        await run(ctx);
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...rows);
    }
    await current?.stop();
    const log = server.log();
    const reindexes = (log.match(/static index ready/g) ?? []).length;
    console.log(`  (server indexed ${reindexes} times without a restart)`);
  } finally {
    await cleanupAll();
  }
  writeResults(dir, 'backend-reload', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  for (const p of Object.values(ports)) if (!(await portFree(p))) console.log(`port ${p} still in use`);
  await assertPortsFree();
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
