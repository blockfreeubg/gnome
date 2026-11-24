// Lane d (browser data) helpers for the library-*.mjs suites (docs/WAVE-B.md §5 "Tests").
//
// The suites follow the suite contract of tests/e2e/engine/run.mjs (WAVE-B §3: `export async function run(ctx)`)
// and use only the ctx members listed there (browser, suite, runDir, launch, newContext, record, log, sleep,
// stack.appOrigin / proxyOrigin / restartServer). Until that runner exists, and to run the library checks alone,
// `runStandalone()` starts the real stack itself and runs a suite in Chromium and Firefox:
//
//   node tests/e2e/engine/suites/library-pages.mjs [--browser chromium|firefox|all]
//   node tests/e2e/engine/suites/library-sync.mjs  [--browser …]
//
// The stack: HolyWisp (services/holywisp/build/<arch>/holywisp with a copy of services/holywisp/gnome.conf whose
// port is changed, nothing else; on the host with HOLYWISP_RUNNER=host, the default, or in the locked-down
// unprivileged container of the spike harness with HOLYWISP_RUNNER=docker) and gnome-server (GNOME_SERVER_BIN) in
// two-origin mode on loopback, serving the frontend build in LIBRARY_E2E_STATIC (default frontend/dist) with a fresh
// data directory per run.
//
// Environment: LIBRARY_E2E_PORT_BASE (default E2E_PORT_BASE + 220, tests/e2e/engine/lib/ports.mjs): base+0 app,
// base+1 proxy listener, base+4 HolyWisp. LIBRARY_E2E_DIR: run output (default ~/.cache/gnome-e2e-library; never /tmp).
// LIBRARY_E2E_SHOTS: screenshots (default docs/screenshots/library). GNOME_SERVER_BIN: the server binary (default
// $CARGO_TARGET_DIR/release/gnome-server, else target/release/gnome-server).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import { suitePortBase } from '../lib/ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..', '..', '..');
export const BROWSERS = ['chromium', 'firefox'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portBase() {
  return suitePortBase('library');
}

export function shotsDir() {
  const dir = path.resolve(process.env.LIBRARY_E2E_SHOTS || path.join(REPO, 'docs', 'screenshots', 'library'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function launchBrowser(name) {
  if (name === 'chromium') {
    const o = { headless: true };
    if (process.env.CHROMIUM_EXECUTABLE) o.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else o.channel = 'chromium'; // the full chromium-1248 in the new headless mode
    return chromium.launch(o);
  }
  if (name === 'firefox') {
    const o = { headless: true };
    if (process.env.FIREFOX_EXECUTABLE) o.executablePath = process.env.FIREFOX_EXECUTABLE;
    return firefox.launch(o);
  }
  throw new Error(`unknown browser ${name}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function waitPort(port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => (s.destroy(), resolve(true)));
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`nothing listens on ${port} after ${ms} ms`);
}

/** Starts HolyWisp and gnome-server; returns the ctx.stack object plus stop(). */
export async function startStack({ runDir, log }) {
  const base = portBase();
  const ports = { app: base, proxy: base + 1, wisp: base + 4 };
  for (const p of Object.values(ports)) if (!(await portFree(p))) throw new Error(`port ${p} is in use (LIBRARY_E2E_PORT_BASE=${base})`);
  const staticDir = path.resolve(process.env.LIBRARY_E2E_STATIC || path.join(REPO, 'frontend', 'dist'));
  if (!existsSync(path.join(staticDir, 'index.html'))) throw new Error(`no frontend build in ${staticDir} (LIBRARY_E2E_STATIC)`);
  const bin = path.resolve(
    process.env.GNOME_SERVER_BIN || path.join(process.env.CARGO_TARGET_DIR || path.join(REPO, 'target'), 'release', 'gnome-server'),
  );
  if (!existsSync(bin)) throw new Error(`no gnome-server at ${bin} (GNOME_SERVER_BIN)`);
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  const hwBin = path.join(REPO, 'services', 'holywisp', 'build', arch, 'holywisp');
  const conf = readFileSync(path.join(REPO, 'services', 'holywisp', 'gnome.conf'), 'utf8');
  if (!/^port = 6001\b/m.test(conf)) throw new Error('services/holywisp/gnome.conf: "port = 6001" not found');
  const confPath = path.join(runDir, 'holywisp.conf');
  writeFileSync(confPath, conf.replace(/^port = 6001\b/m, `port = ${ports.wisp}`));

  const procs = [];
  const runner = process.env.HOLYWISP_RUNNER || 'host';
  let container = null;
  if (runner === 'docker') {
    // The spike harness's locked-down, unprivileged container (tests/e2e/spike-engine-host/lib/holywisp.mjs): the
    // static binary on the Alpine image pinned in services/holywisp/Dockerfile, host network, read-only, no caps.
    const df = readFileSync(path.join(REPO, 'services', 'holywisp', 'Dockerfile'), 'utf8');
    const image = /^ARG ALPINE_IMAGE=(\S+)/m.exec(df)?.[1];
    if (!image) throw new Error('ARG ALPINE_IMAGE not found in services/holywisp/Dockerfile');
    container = `gnome-lib-e2e-hw-${ports.wisp}`;
    const args = ['run', '-d', '--name', container, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--ulimit', 'nofile=65536:65536', '--user', '65534:65534', '-v', `${confPath}:/etc/holywisp/gnome.conf:ro`,
      '-v', `${hwBin}:/opt/holywisp/holywisp:ro`, '--entrypoint', '/opt/holywisp/holywisp', image, '--config', '/etc/holywisp/gnome.conf'];
    spawnSync('docker', ['rm', '-f', container]);
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  } else {
    const hw = spawn(hwBin, ['--config', confPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    hw.stdout.on('data', (d) => out.push(d));
    hw.stderr.on('data', (d) => out.push(d));
    hw.on('exit', () => writeFileSync(path.join(runDir, 'holywisp.log'), Buffer.concat(out)));
    procs.push(hw);
  }
  await waitPort(ports.wisp);

  const dataDir = path.join(runDir, 'data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  let server = null;
  let serverLog = [];
  const startServer = async (extra = {}) => {
    const env = {
      ...process.env,
      GNOME_BIND: `127.0.0.1:${ports.app}`,
      GNOME_PROXY_BIND: `127.0.0.1:${ports.proxy}`,
      GNOME_ADMIN_BIND: '',
      GNOME_DATA_DIR: dataDir,
      GNOME_STATIC_DIR: staticDir,
      GNOME_WISP_UPSTREAM: `127.0.0.1:${ports.wisp}`,
      GNOME_ACCOUNTS: 'true',
      GNOME_REGISTRATION: 'open',
      GNOME_ARGON2_MEMORY_KIB: '8192',
      GNOME_FILTERS_REFRESH_HOURS: '0',
      // No live game-feed import and no OSS download from GitHub (WAVE-C §2.2).
      GNOME_CATALOG_REFRESH_HOURS: '0',
      GNOME_OSS_FETCH: 'manual',
      GNOME_LOG: 'warn',
      ...extra,
    };
    serverLog = [];
    server = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => serverLog.push(d));
    server.stderr.on('data', (d) => serverLog.push(d));
    await waitPort(ports.app);
    await waitPort(ports.proxy);
  };
  const stopServer = async () => {
    if (!server) return;
    const s = server;
    server = null;
    const done = new Promise((r) => s.once('exit', r));
    s.kill('SIGTERM');
    await Promise.race([done, sleep(5000)]);
    if (s.exitCode === null) s.kill('SIGKILL');
    writeFileSync(path.join(runDir, 'server.log'), Buffer.concat(serverLog));
  };
  await startServer();
  log(`stack: app http://127.0.0.1:${ports.app}, proxy http://127.0.0.1:${ports.proxy}, HolyWisp :${ports.wisp} (${runner}), static ${staticDir}`);
  return {
    appOrigin: `http://127.0.0.1:${ports.app}`,
    proxyOrigin: `http://127.0.0.1:${ports.proxy}`,
    async restartServer(env = {}) {
      await stopServer();
      await startServer(env);
    },
    upstream() {
      throw new Error('library suites do not stop upstreams');
    },
    async stop() {
      await stopServer();
      for (const p of procs) p.kill('SIGTERM');
      if (container) spawnSync('docker', ['rm', '-f', container]);
      await sleep(300);
      for (const p of Object.values(ports)) if (!(await portFree(p))) log(`port ${p} is still in use`);
    },
  };
}

/** The settings mirror the app reads before first paint (src/settings/store.svelte.ts), with partial settings. */
export function settingsMirror(theme, extra = {}) {
  return JSON.stringify({
    v: 1,
    updatedAt: Date.now(),
    settings: { version: 1, ...extra, appearance: { theme, ...(extra.appearance ?? {}) } },
    boot: { theme, motion: 'none', vars: {}, dark: {}, light: {}, classes: [], meta: { dark: '#0f0f0d', light: '#f5f1e8' } },
  });
}

/**
 * Runs one suite standalone in the selected browsers and prints the records. Exits 1 when a record failed.
 */
export async function runStandalone(run, suite) {
  const argv = process.argv.slice(2);
  const pick = argv.includes('--browser') ? argv[argv.indexOf('--browser') + 1] : 'all';
  const browsers = pick === 'all' ? BROWSERS : pick.split(',');
  const root = path.resolve(process.env.LIBRARY_E2E_DIR || path.join(os.homedir(), '.cache', 'gnome-e2e-library'));
  const runDir = path.join(root, `${suite}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });
  const records = [];
  const log = (...m) => console.log(`[${suite}]`, ...m);
  const stack = await startStack({ runDir, log });
  const open = new Set();
  const stopAll = async () => {
    for (const b of open) await b.close().catch(() => {});
    await stack.stop();
  };
  process.once('SIGINT', () => void stopAll().then(() => process.exit(130)));
  try {
    for (const browser of browsers) {
      const ctx = {
        browser,
        suite,
        runDir,
        log,
        sleep,
        stack,
        async launch() {
          const b = await launchBrowser(browser);
          open.add(b);
          b.once('disconnected', () => open.delete(b));
          return b;
        },
        newContext(b, opts = {}) {
          return b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts });
        },
        record(r) {
          records.push({ browser, ...r });
          const mark = r.result === 'pass' ? 'PASS' : r.result === 'skip' ? 'SKIP' : 'FAIL';
          console.log(`${mark} ${browser}${r.engine ? ` ${r.engine}` : ''}${r.transport ? `/${r.transport}` : ''} ${r.test}${r.notes ? ` — ${r.notes}` : ''}`);
        },
      };
      try {
        await run(ctx);
      } catch (err) {
        ctx.record({ test: 'suite completed', result: 'fail', notes: String(err?.stack ?? err).slice(0, 2000) });
      }
      for (const b of open) await b.close().catch(() => {});
    }
  } finally {
    await stopAll();
  }
  const count = (res, b) => records.filter((r) => r.result === res && (!b || r.browser === b)).length;
  const lines = [`# ${suite} — ${new Date().toISOString()}`, '', '| Browser | Pass | Fail | Skip |', '| --- | --- | --- | --- |'];
  for (const b of browsers) lines.push(`| ${b} | ${count('pass', b)} | ${count('fail', b)} | ${count('skip', b)} |`);
  lines.push('', '| Browser | Engine | Transport | Test | Result | Notes |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of records) lines.push(`| ${r.browser} | ${r.engine ?? '–'} | ${r.transport ?? '–'} | ${r.test} | ${r.result} | ${(r.notes ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  writeFileSync(path.join(runDir, 'results.md'), lines.join('\n') + '\n');
  writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(records, null, 2));
  console.log(`\n${suite}: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped (${runDir}/results.md)`);
  process.exitCode = count('fail') ? 1 : 0;
}

/** True when this module file is the script node was started with. */
export function isMain(metaUrl) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
