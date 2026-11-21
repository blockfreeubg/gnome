// Lane e (backend) helpers for the backend-*.mjs suites (docs/WAVE-B.md §6 "Tests").
//
// The suites follow the suite contract of tests/e2e/engine/run.mjs (WAVE-B §3: `export async function run(ctx)`).
// Until that runner exists, and to run the backend checks alone, `runStandalone()` starts the real stack itself:
// HolyWisp (services/holywisp/build/<arch>/holywisp with services/holywisp/gnome.conf, only its port changed; on the
// host with HOLYWISP_RUNNER=host, the default here, or in the spike harness's locked-down container with
// HOLYWISP_RUNNER=docker), gnome-server (GNOME_SERVER_BIN, default target/release/gnome-server) in two-origin mode
// on loopback, and a leak sentinel; then it runs the suite in Chromium and Firefox (the cached chromium-1248 and
// firefox-1555 through playwright-core 1.64.0) and prints the records.
//
//   node tests/e2e/engine/suites/backend-proxy.mjs [--browser chromium|firefox|all] [--parts a,b] [--static <dir>]
//   node tests/e2e/engine/suites/backend-https.mjs [--browser …]
//   node tests/e2e/engine/suites/backend-proxy.mjs --write-fixture    # regenerate backend/tests/fixtures/…
//
// Ports come from the environment: BACKEND_E2E_PORT_BASE (default: the runner's standalone block, E2E_PORT_BASE + 100,
// tests/e2e/engine/lib/ports.mjs; the runner passes it to its standalone suites). The suite
// uses base+0 (app), +1 (proxy listener), +2 (admin), +10 (HolyWisp), +11 (a VPN profile's upstream that never
// runs), +20 (leak sentinel), +30/+31 (HTTPS front of the two-hostname run). Scratch output goes to
// BACKEND_E2E_DIR (default: <E2E_RESULTS_DIR>/backend when E2E_RESULTS_DIR is set, else a directory under
// tests/e2e/engine/results/, which is git-ignored like the spike's).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import { suitePortBase } from '../lib/ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..', '..', '..');
export const E2E = path.join(REPO, 'tests', 'e2e');
export const FIXTURE = path.join(REPO, 'backend', 'tests', 'fixtures', 'proxy-origin-csp.json');
export const BROWSERS = ['chromium', 'firefox'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function portBase() {
  return suitePortBase('backend');
}

export const PORTS = (() => {
  const b = portBase();
  return { app: b, proxy: b + 1, admin: b + 2, holywisp: b + 10, deadUpstream: b + 11, sentinel: b + 20, httpsApp: b + 30, httpsProxy: b + 31 };
})();

export function workDir(name) {
  // Inside the runner (no BACKEND_E2E_DIR) the work goes under the run's E2E_RESULTS_DIR, never into the repository.
  const base =
    process.env.BACKEND_E2E_DIR || (process.env.E2E_RESULTS_DIR ? path.join(process.env.E2E_RESULTS_DIR, 'backend') : path.join(here, '..', 'results', 'backend'));
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── The TypeScript contract (frontend/src/shared/proxy-origin.ts), run as it is ─────────────────────────────────

/**
 * Imports the frozen contract with Node's type stripping. The shared files use extension-less relative imports
 * (bundler style), so they are copied into `dir` with `.ts` added to those specifiers; nothing else changes.
 */
export async function loadContract(dir = workDir('contract')) {
  const shared = path.join(REPO, 'frontend', 'src', 'shared');
  for (const f of readdirSync(shared)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(shared, f), 'utf8').replace(/(from\s+'\.\/[a-z-]+)(')/g, '$1.ts$2');
    writeFileSync(path.join(dir, f), src);
  }
  return import(`${pathToFileURL(path.join(dir, 'proxy-origin.ts')).href}?t=${Date.now()}`);
}

/** The fixture the Rust unit tests compare with (backend/tests/fixtures/proxy-origin-csp.json). */
export function fixtureFrom(m) {
  const cases = [];
  const origins = [[], ['https://gnome.example.com'], ['http://127.0.0.1:8080', 'http://127.0.0.1:5173'], ["'self'"]];
  for (const o of origins) for (const customWisp of [false, true]) cases.push({ appOrigins: o, customWisp, csp: m.engineHostCsp(o, { customWisp }) });
  // The other proxy-origin policies take the app origins as gnome-server has them: [] in single-origin mode.
  const appOriginSets = origins.slice(0, 3);
  return {
    comment: 'Generated from frontend/src/shared/proxy-origin.ts by running its functions (tests/e2e/engine/suites/backend-proxy.mjs --write-fixture). Do not edit by hand.',
    PROXIED_DOCUMENT_CSP: m.PROXIED_DOCUMENT_CSP,
    ENGINE_HOST_CSP_DIRECTIVES: m.ENGINE_HOST_CSP_DIRECTIVES,
    CUSTOM_WISP_CONNECT_SOURCES: m.CUSTOM_WISP_CONNECT_SOURCES,
    engineHostCsp: cases,
    bareMuxWorkerCsp: [false, true].map((customWisp) => ({ customWisp, csp: m.bareMuxWorkerCsp({ customWisp }) })),
    proxyScriptCsp: appOriginSets.map((o) => ({ appOrigins: o, csp: m.proxyScriptCsp(o) })),
    bareMuxWorkerScriptCsp: appOriginSets.flatMap((o) => [false, true].map((customWisp) => ({ appOrigins: o, customWisp, csp: m.bareMuxWorkerScriptCsp(o, { customWisp }) }))),
    proxyInertCsp: appOriginSets.map((o) => ({ appOrigins: o, csp: m.proxyInertCsp(o) })),
    bareMuxWorkerPath: m.VENDOR.bareMuxWorker,
    engineHostPath: m.PROXY_PATHS.engineHost,
    serviceWorkerPath: m.PROXY_PATHS.serviceWorker,
    enginePrefixes: m.ENGINE_PREFIXES,
  };
}

// ── Browsers ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function launchBrowser(name, { args = [], prefs = {} } = {}) {
  if (name === 'chromium') {
    const o = { headless: true, args };
    if (process.env.CHROMIUM_EXECUTABLE) o.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else o.channel = 'chromium';
    return chromium.launch(o);
  }
  if (name === 'firefox') {
    const o = { headless: true, firefoxUserPrefs: { 'devtools.jsonview.enabled': false, ...prefs } };
    if (process.env.FIREFOX_EXECUTABLE) o.executablePath = process.env.FIREFOX_EXECUTABLE;
    return firefox.launch(o);
  }
  throw new Error(`unknown browser ${name}`);
}

// ── Processes ────────────────────────────────────────────────────────────────────────────────────────────────────

const cleanups = [];
export function onCleanup(fn) {
  cleanups.push(fn);
}
export async function cleanupAll() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (e) {
      console.error('cleanup:', e.message);
    }
  }
}

export function waitPort(port, host = '127.0.0.1', timeout = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(port, host);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeout) reject(new Error(`port ${host}:${port} did not open`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.once('error', () => resolve(true));
  });
}

function spawnLogged(name, cmd, args, env, logFile) {
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const keep = (d) => {
    chunks.push(d.toString());
    if (chunks.length > 4000) chunks.splice(0, 1000);
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 12000);
      await exited;
      clearTimeout(t);
    }
    if (logFile) writeFileSync(logFile, chunks.join(''));
  };
  return { name, proc, exited, stop, log: () => chunks.join('') };
}

/** HolyWisp with services/holywisp/gnome.conf (read, never changed), only `--port` overridden. */
export async function startHolyWisp(port, dir) {
  const bin = process.env.HOLYWISP_BIN || path.join(REPO, 'services', 'holywisp', 'build', os.arch() === 'arm64' ? 'aarch64' : 'x86_64', 'holywisp');
  const conf = path.join(REPO, 'services', 'holywisp', 'gnome.conf');
  if (!existsSync(bin)) throw new Error(`HolyWisp binary not found: ${bin} (services/holywisp/fetch-build.sh)`);
  const runner = process.env.HOLYWISP_RUNNER || 'host';
  let p;
  if (runner === 'host') {
    p = spawnLogged('holywisp', bin, ['--config', conf, '--port', String(port)], process.env, path.join(dir, `holywisp-${port}.log`));
  } else {
    const name = `gnome-e2e-backend-holywisp-${port}-${process.pid}`;
    const df = readFileSync(path.join(REPO, 'services', 'holywisp', 'Dockerfile'), 'utf8');
    const image = /^ARG ALPINE_IMAGE=(\S+)/m.exec(df)?.[1];
    if (!image) throw new Error('ARG ALPINE_IMAGE not found in services/holywisp/Dockerfile');
    const args = ['run', '--rm', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--ulimit', 'nofile=65536:65536', '--user', '65534:65534', '-v', `${conf}:/etc/holywisp/holywisp.conf:ro`, '-v', `${path.resolve(bin)}:/opt/holywisp/holywisp:ro`,
      '--entrypoint', '/opt/holywisp/holywisp', image, '--config', '/etc/holywisp/holywisp.conf', '--port', String(port)];
    p = spawnLogged('holywisp', 'docker', args, process.env, path.join(dir, `holywisp-${port}.log`));
    const inner = p.stop;
    p.stop = async () => {
      await new Promise((r) => spawn('docker', ['rm', '-f', name], { stdio: 'ignore' }).once('exit', r));
      await inner();
    };
  }
  onCleanup(p.stop);
  await waitPort(port);
  return p;
}

export function serverBin() {
  if (process.env.GNOME_SERVER_BIN) return process.env.GNOME_SERVER_BIN;
  const target = process.env.CARGO_TARGET_DIR || path.join(REPO, 'target');
  for (const profile of ['release', 'debug']) {
    const p = path.join(target, profile, 'gnome-server');
    if (existsSync(p)) return p;
  }
  throw new Error('gnome-server not built (cargo build --release -p gnome-server) and GNOME_SERVER_BIN not set');
}

/**
 * gnome-server in two-origin mode on loopback: app `GNOME_BIND`, proxy `GNOME_PROXY_BIND`, admin listener, a fresh
 * data dir per start. `env` adds or overrides settings. Returns {appOrigin, proxyOrigin, adminOrigin, stop, log}.
 */
export async function startGnomeServer({ dir, staticDir, env = {}, label = 'server' }) {
  const dataDir = path.join(dir, `data-${label}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const base = {
    GNOME_BIND: `127.0.0.1:${PORTS.app}`,
    GNOME_PROXY_BIND: `127.0.0.1:${PORTS.proxy}`,
    GNOME_ADMIN_BIND: `127.0.0.1:${PORTS.admin}`,
    GNOME_STATIC_DIR: staticDir,
    GNOME_DATA_DIR: dataDir,
    GNOME_WISP_UPSTREAM: `127.0.0.1:${PORTS.holywisp}`,
    GNOME_ARGON2_MEMORY_KIB: '8192',
    GNOME_FILTERS_REFRESH_HOURS: '0',
    GNOME_LOG: 'info',
  };
  const merged = { ...base, ...env };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GNOME_')));
  const p = spawnLogged('gnome-server', serverBin(), ['serve'], { ...clean, ...merged }, path.join(dir, `${label}.log`));
  onCleanup(p.stop);
  const ports = [merged.GNOME_BIND, merged.GNOME_PROXY_BIND, merged.GNOME_ADMIN_BIND].filter(Boolean).map((b) => Number(b.split(':').pop()));
  const started = Promise.all(ports.map((port) => waitPort(port)));
  const died = p.exited.then(({ code, signal }) => {
    throw new Error(`gnome-server exited early (code ${code}, signal ${signal}):\n${p.log().slice(-3000)}`);
  });
  await Promise.race([started, died]);
  const appOrigin = `http://${merged.GNOME_BIND}`;
  const proxyOrigin = merged.GNOME_PROXY_ORIGIN || `http://${merged.GNOME_PROXY_BIND}`;
  return { appOrigin, proxyOrigin, adminOrigin: `http://${merged.GNOME_ADMIN_BIND}`, env: merged, stop: p.stop, log: p.log };
}

/**
 * The leak sentinel: answers every request with 200 and records it (method, path, upgrade). Every check that must
 * not reach the network directly targets this server; a hit is a leak.
 */
export async function startSentinel(port = PORTS.sentinel) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ at: Date.now(), method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(req.url.endsWith('.js') ? 'void 0;' : 'sentinel');
  });
  server.on('upgrade', (req, socket) => {
    hits.push({ at: Date.now(), method: 'UPGRADE', path: req.url });
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  onCleanup(close);
  return { origin: `http://127.0.0.1:${port}`, hits, close, since: (t) => hits.filter((h) => h.at >= t) };
}

// ── Static dirs ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A GNOME_STATIC_DIR made of the spike's app stub, engine host (with its %GNOME_APP_ORIGINS% placeholder left for the
 * server to fill), sw.js and the pinned engine/transport builds (unmodified, from tests/e2e/node_modules), as
 * tests/e2e/stack/engine-on-gnome-server.mjs does, but without filling the placeholder itself.
 */
export async function prepareSpikeStatic(dir) {
  const { SPIKE_DIR, NODE_MODULES, VENDOR } = await import('../../spike-engine-host/lib/config.mjs');
  rmSync(dir, { recursive: true, force: true });
  const web = path.join(SPIKE_DIR, 'web');
  mkdirSync(path.join(dir, 'engine'), { recursive: true });
  for (const f of ['index.html', 'app.js']) cpSync(path.join(web, 'app', f), path.join(dir, f));
  for (const f of readdirSync(path.join(web, 'proxy', 'engine'))) cpSync(path.join(web, 'proxy', 'engine', f), path.join(dir, 'engine', f));
  cpSync(path.join(web, 'proxy', 'sw.js'), path.join(dir, 'sw.js'));
  for (const [name, rel] of Object.entries(VENDOR)) cpSync(path.join(NODE_MODULES, rel), path.join(dir, 'vendor', name), { recursive: true, dereference: true });
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'probe-0000.js'), 'export const probe = 1;\n');
  writeFileSync(path.join(dir, 'assets', 'probe-0000.css'), 'body { color: #ccc; }\n');
  return dir;
}

// ── Standalone runs ──────────────────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { browsers: BROWSERS, parts: null, static: null, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser') out.browsers = argv[++i] === 'all' ? BROWSERS : argv[i].split(',');
    else if (a === '--parts') out.parts = argv[++i].split(',');
    else if (a === '--static') out.static = path.resolve(argv[++i]);
    else out.flags.add(a);
  }
  return out;
}

/** Records in the runner's shape, printed as they come; `summary()` counts them. */
export function recorder(browser) {
  const rows = [];
  const record = (row) => {
    const r = { browser, ...row };
    rows.push(r);
    const tag = [r.engine, r.transport].filter(Boolean).join('/');
    console.log(`  ${r.result.padEnd(4)} [${browser}${tag ? ` ${tag}` : ''}] ${r.test}${r.notes ? ` (${String(r.notes).slice(0, 400)})` : ''}`);
  };
  return { rows, record };
}

export function summarize(rows) {
  const count = (k) => rows.filter((r) => r.result === k).length;
  return { pass: count('pass'), fail: count('fail'), skip: count('skip') };
}

export function writeResults(dir, name, rows) {
  const lines = [`# ${name}`, '', '| browser | test | engine | transport | result | notes |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) lines.push(`| ${r.browser ?? ''} | ${r.test} | ${r.engine ?? ''} | ${r.transport ?? ''} | ${r.result} | ${String(r.notes ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`);
  const s = summarize(rows);
  lines.push('', `${s.pass} pass, ${s.fail} fail, ${s.skip} skip`);
  writeFileSync(path.join(dir, `${name}.md`), `${lines.join('\n')}\n`);
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows, null, 2));
}

let handlersInstalled = false;
export function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.error(`\n${sig}: cleaning up`);
      await cleanupAll();
      process.exit(130);
    });
  }
}

/** Checks that every port of the range this harness used is free again (prints what is still listening). */
export async function assertPortsFree() {
  const busy = [];
  for (const p of Object.values(PORTS)) if (!(await portFree(p))) busy.push(p);
  console.log(busy.length ? `ports still in use: ${busy.join(', ')}` : 'all backend e2e ports are free again');
  return busy.length === 0;
}
