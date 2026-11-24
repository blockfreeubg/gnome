#!/usr/bin/env node
// The benchmark harness (docs/WAVE-D.md §3.1–§3.4; bench/README.md). It starts and stops every process itself,
// pins them, runs the load generator, samples /proc and writes results.json + results.md.
//
//   node bench/run.mjs [--preset dev|quick|record] [--scenarios W1,H1,…] [--configs rust,node1,…] [--repeats N]
//     [--duration S] [--warmup S] [--server-bin PATH] [--dist DIR] [--out DIR] [--label L] [--check] [--smoke]
//     [--plan] [--cpus servers=LIST,loadgen=LIST] [--no-check] [--no-gate-wait] [--note TEXT] [--scratch DIR]
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { cpuSets, formatList } from './lib/cpusets.mjs';
import { gate } from './lib/quiet.mjs';
import { Sampler, netCounters, pipeCount, tree, status, assertLoopback } from './lib/proc.mjs';
import { summarize, mergeHists, histQuantile } from './lib/stats.mjs';
import { CONFIGS, PORTS, REPO, startConfig, launch, waitPort, httpStatus, writeProfiles, tilde, gnomeEnv } from './lib/servers.mjs';
import { prepareDist } from './lib/dist.mjs';
import { runCheck } from './lib/check.mjs';
import { planSeconds } from './lib/plan.mjs';

const { values: a } = parseArgs({
  options: {
    preset: { type: 'string', default: 'dev' },
    scenarios: { type: 'string' },
    configs: { type: 'string' },
    repeats: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    'server-bin': { type: 'string' },
    dist: { type: 'string' },
    out: { type: 'string' },
    label: { type: 'string' },
    note: { type: 'string', default: '' },
    check: { type: 'boolean', default: false },
    'no-check': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    plan: { type: 'boolean', default: false },
    'no-gate-wait': { type: 'boolean', default: false },
    cpus: { type: 'string' },
    scratch: { type: 'string' },
  },
});

// ── presets (§3.4) ───────────────────────────────────────────────────────────────────────────────────────────────
const PRESETS = {
  // A few minutes, no gate, never quoted.
  dev: { warmup: 1, duration: 5, repeats: 1, budgetedRepeats: 1, gate: null, w4: [1000], s1Runs: 5, hc: [64] },
  // Every scenario once (budgeted cells twice), short windows, a short gate that never blocks: ≤ 45 min. Numbers
  // are quotable only as "quick preset" numbers, with their noisy marks.
  quick: { warmup: 2, duration: 8, repeats: 1, budgetedRepeats: 2, gate: { waitS: 5, tries: 1 }, w4: [1000, 3000], s1Runs: 10, hc: [64] },
  // The full method: ≈ 5 h, in a quiet window only.
  record: { warmup: 5, duration: 20, repeats: 3, budgetedRepeats: 5, gate: { waitS: 30, tries: 20 }, w4: [1000, 5000, 10000], s1Runs: 30, hc: [1, 16, 64, 256] },
  // Each scenario 2 s, no gate: harness self-test.
  smoke: { warmup: 0.5, duration: 2, repeats: 1, budgetedRepeats: 1, gate: null, w4: [200], s1Runs: 2, hc: [16] },
};
const preset = { ...PRESETS[a.smoke ? 'smoke' : a.preset] };
if (!preset.warmup) throw new Error(`unknown preset ${a.preset}`);
if (a.repeats) preset.repeats = preset.budgetedRepeats = Number(a.repeats);
if (a.duration) preset.duration = Number(a.duration);
if (a.warmup) preset.warmup = Number(a.warmup);
// Measure the gate (and mark noisy repeats) but never wait: for runs on a machine known to be shared.
if (a['no-gate-wait'] && preset.gate) preset.gate = { ...preset.gate, tries: 0 };
const presetName = a.smoke ? 'smoke' : a.preset;

const ALL_SCENARIOS = ['W1', 'W2', 'W3', 'W4', 'H1', 'A1', 'S1', 'R1', 'B1'];
const scenarios = a.scenarios ? a.scenarios.split(',') : ALL_SCENARIOS;
const ALL_CONFIGS = ['rust', 'node1', 'node4', 'node4-wispjs', 'holywisp', 'wispjs', 'wispjs4', 'rust-ctr', 'rust-copy', 'rust+caddy'];
const configs = a.configs ? a.configs.split(',') : ALL_CONFIGS;

const cpus = cpuSets(a.cpus);
const scratch = a.scratch ?? path.join(os.tmpdir(), `gnome-bench-${process.getuid()}`);
mkdirSync(scratch, { recursive: true });
// Both binaries come from one target directory: $CARGO_TARGET_DIR, else the repository's ignored /target/.
const LOADGEN = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO, 'target'), 'release/gnome-bench');
const serverBin = path.resolve(a['server-bin'] ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO, 'target'), 'release/gnome-server'));

// ── the cells (§3.3) ─────────────────────────────────────────────────────────────────────────────────────────────
const GW = ['rust', 'node1', 'node4', 'node4-wispjs'];
const DIRECT = ['holywisp', 'wispjs', 'wispjs4'];
const WISP_CFGS = [...GW, ...DIRECT, 'rust-ctr', 'rust-copy', 'rust+caddy'];
const HTTP_CFGS = ['rust', 'node1', 'node4', 'rust+caddy'];

function cellsFor(cfg) {
  const out = [];
  const add = (scenario, variant, run, budget = null) => out.push({ scenario, variant, cfg, run, budget });
  // W4 first: its per-connection RSS is measured against a process that has not yet grown under W1's load.
  if (scenarios.includes('W4') && ['rust', 'node4', 'holywisp', 'wispjs'].includes(cfg)) {
    for (const n of preset.w4) add('W4', `N=${n}`, { kind: 'idle', n }, cfg === 'rust' ? 'RB3' : null);
  }
  if (scenarios.includes('W1') && WISP_CFGS.includes(cfg)) {
    for (const [c, s] of [[1, 1], [1, 10], [8, 4], [64, 4], [768, 1]]) {
      if (cfg === 'rust+caddy' && !((c === 1 && s === 10) || (c === 8 && s === 4))) continue;
      add('W1', `${c}x${s}`, { kind: 'wisp', mode: 'tp', args: ['--conns', c, '--streams', s] }, c === 1 && s === 10 && ['rust', 'holywisp'].includes(cfg) ? 'RB5' : null);
    }
  }
  if (scenarios.includes('W2') && WISP_CFGS.includes(cfg)) {
    add('W2', 'idle', { kind: 'wisp', mode: 'rtt', args: [] }, ['rust', 'holywisp'].includes(cfg) ? 'RB6' : null);
    add('W2', 'under W1 8x4', { kind: 'wisp', mode: 'rtt', args: [], background: ['tp', '--conns', 8, '--streams', 4] });
  }
  if (scenarios.includes('W3') && WISP_CFGS.includes(cfg) && cfg !== 'rust+caddy') {
    add('W3', '(a) setup churn', { kind: 'wisp', mode: 'churn', args: ['--inflight', 32, '--sources', 8] }, cfg === 'rust' ? 'RB7' : null);
    if (DIRECT.includes(cfg)) add('W3', '(b) stream churn', { kind: 'wisp', mode: 'open', args: ['--inflight', 8] });
  }
  if (scenarios.includes('H1') && HTTP_CFGS.includes(cfg)) {
    for (const [v, port, p, hdr] of H1_PATHS) {
      if (cfg === 'rust+caddy' && v !== 'a') continue;
      for (const c of preset.hc) {
        if (cfg === 'node1' && c < 64 && presetName === 'record') continue;
        add('H1', `(${v}) c=${c}`, { kind: 'http', port, path: p, hdr, c }, v === 'a' && c === 64 && ['rust', 'node4'].includes(cfg) ? 'RB8' : null);
      }
      add('H1', `(${v}) 5000/s`, { kind: 'http', port, path: p, hdr, c: 64, rate: 5000 }, v === 'a' && cfg === 'rust' ? 'RB8' : null);
    }
  }
  if (scenarios.includes('A1') && ['rust', 'node1', 'node4'].includes(cfg)) {
    for (const [v, method, p, hdr] of A1_PATHS) {
      add('A1', `${v} c=64`, { kind: 'http', port: PORTS.app, path: p, method, hdr, c: 64, session: true });
      add('A1', `${v} 2000/s`, { kind: 'http', port: PORTS.app, path: p, method, hdr, c: 64, rate: 2000, session: true }, v === 'ticket' && cfg === 'rust' ? 'RB9' : null);
    }
  }
  return out;
}

let H1_PATHS = [];
const A1_PATHS = [
  ['ticket', 'POST', '/api/wisp/ticket', ['X-GNOME-Request: 1']],
  ['config', 'GET', '/api/config', []],
  ['session', 'GET', '/api/session', []],
];

function setH1(files, etag) {
  H1_PATHS = [
    ['a', PORTS.app, files.asset, ['Accept-Encoding: br']],
    ['b', PORTS.app, files.asset, ['Accept-Encoding: gzip']],
    ['c', PORTS.app, files.asset, []],
    ['d', PORTS.app, files.asset, [`If-None-Match: ${etag}`]],
    ['e', PORTS.proxy, files.vendor, ['Accept-Encoding: br']],
    ['f', PORTS.app, '/browse', ['Accept-Encoding: br']],
    ['g', PORTS.proxy, '/engine/', ['Accept-Encoding: br']],
  ];
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function planCells() {
  const rows = [];
  for (const cfg of configs) {
    const cells = cellsFor(cfg);
    const budgeted = cells.filter((c) => c.budget).length;
    rows.push({ cfg, cells: cells.length, budgeted, unavailable: CONFIGS[cfg]?.unavailable ?? null });
  }
  return rows;
}
if (a.plan) {
  setH1({ asset: '/assets/x.js', vendor: '/vendor/x.js' }, '"x"');
  const rows = planCells();
  for (const r of rows) console.log(`${r.cfg.padEnd(14)} ${String(r.cells).padStart(3)} cells (${r.budgeted} budgeted)${r.unavailable ? `  — unavailable: ${r.unavailable}` : ''}`);
  const s = planSeconds(rows, preset, scenarios.includes('S1'), scenarios.includes('R1'));
  console.log(`preset ${presetName}: ${preset.repeats} repeat(s), ${preset.budgetedRepeats} for budgeted cells, ${preset.warmup} s warm-up + ${preset.duration} s measured; ≈ ${Math.round(s / 60)} min (estimate, without gate waits)`);
  process.exit(0);
}

// ── machine record (§3.4) ────────────────────────────────────────────────────────────────────────────────────────
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const readT = (f) => {
  try {
    return readFileSync(f, 'utf8').trim();
  } catch {
    return null;
  }
};
const fileSha = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
function machine() {
  const cpuinfo = readT('/proc/cpuinfo') ?? '';
  const mem = readT('/proc/meminfo') ?? '';
  const wjs = JSON.parse(readT(path.join(REPO, 'bench/wispjs/node_modules/@mercuryworkshop/wisp-js/package.json')) ?? '{}');
  return {
    cpu: /model name\s*:\s*(.*)/.exec(cpuinfo)?.[1],
    logicalCpus: os.cpus().length,
    cores: cpus.cores,
    smt: cpus.smt,
    siblings: readT('/sys/devices/system/cpu/cpu0/topology/thread_siblings_list'),
    governor: readT('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    boost: readT('/sys/devices/system/cpu/cpufreq/boost') ?? readT('/sys/devices/system/cpu/intel_pstate/no_turbo')?.replace(/^/, 'no_turbo='),
    kernel: os.release(),
    memTotalMiB: Math.round(Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0) / 1024),
    swapTotalMiB: Math.round(Number(/SwapTotal:\s+(\d+)/.exec(mem)?.[1] ?? 0) / 1024),
    docker: sh('docker', ['version', '--format', '{{.Server.Version}}']),
    rustc: sh('rustc', ['--version']),
    node: process.version,
    oha: sh('oha', ['--version']) ?? 'not installed (H1/A1 use gnome-bench http, README "Deviations")',
    wispJs: wjs.version ?? null,
    sysctl: Object.fromEntries(['fs/pipe-user-pages-soft', 'fs/pipe-user-pages-hard', 'fs/pipe-max-size', 'net/ipv4/ip_local_port_range', 'net/ipv4/tcp_tw_reuse', 'net/core/somaxconn'].map((k) => [k.replaceAll('/', '.'), readT(`/proc/sys/${k}`)])),
    pipesHeldBefore: pipeCount(),
    cpuSets: { servers: formatList(cpus.servers), idle: formatList(cpus.idle), loadgen: formatList(cpus.loadgen) },
    sha256: { 'gnome-server': fileSha(serverBin), holywisp: fileSha(path.join(REPO, 'services/holywisp/build/x86_64/holywisp')), 'gnome-bench': fileSha(LOADGEN) },
  };
}

// ── running cells ────────────────────────────────────────────────────────────────────────────────────────────────
function loadgen(args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('taskset', ['-c', formatList(cpus.loadgen), LOADGEN, ...args.map(String)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      onStderr?.(String(d), p.pid);
    });
    p.on('exit', (code) => {
      const line = out.trim().split('\n').pop();
      try {
        resolve({ ...JSON.parse(line), pid: p.pid });
      } catch {
        reject(new Error(`gnome-bench ${args.slice(0, 2).join(' ')} failed (${code}): ${err.slice(-400)}`));
      }
    });
    resolve.pid = p.pid;
  });
}

async function runCell(cell, srv, repeat) {
  const g = preset.gate ? await gate([...cpus.servers, ...cpus.loadgen], { ...preset.gate, log }) : null;
  const net0 = netCounters();
  const target = ['--target', `127.0.0.1:${PORTS.echo}`];
  const W = ['--warmup', preset.warmup, '--duration', preset.duration];
  const r = cell.run;
  let lg;
  let sampler;
  const procs = srv.procs.map((p) => ({ ...p }));
  if (r.kind === 'wisp') {
    let bg = null;
    if (r.background) bg = loadgen(['wisp', ...r.background.slice(0, 1), ...srv.wisp, ...target, ...r.background.slice(1), '--warmup', 0.5, '--duration', preset.warmup + preset.duration + 1]);
    await sleep(r.background ? 600 : 0);
    sampler = new Sampler(procs);
    lg = await loadgen(['wisp', r.mode, ...srv.wisp, ...target, ...r.args, ...W]);
    if (bg) lg.background = await bg;
  } else if (r.kind === 'idle') {
    let base = null;
    let held = null;
    const rssOf = () => Object.fromEntries(procs.map((p) => [p.name, tree(p.pid).reduce((s, x) => s + (status(x)?.rssKiB ?? 0), 0)]));
    base = rssOf();
    sampler = new Sampler(procs);
    let marks = Promise.resolve();
    lg = await loadgen(['wisp', 'idle', ...srv.wisp, ...target, '--conns', r.n, '--active', Math.min(1000, r.n), '--rate-kib', 128, '--hold', 3, '--duration', preset.duration, '--sources', 8], {
      onStderr: (s) => {
        if (/^ready/m.test(s)) marks = sleep(2000).then(() => (held = rssOf()));
      },
    });
    await marks;
    if (held) lg.perConnKiB = Object.fromEntries(Object.keys(base).map((k) => [k, Number(((held[k] - base[k]) / Math.max(1, lg.held)).toFixed(2))]));
    lg.heldRssMiB = held && Object.fromEntries(Object.entries(held).map(([k, v]) => [k, Number((v / 1024).toFixed(1))]));
  } else if (r.kind === 'http') {
    const hdr = [...r.hdr];
    const args = ['http', '--url', `http://127.0.0.1:${r.port}${r.path}`, '-c', r.c, ...W];
    for (const h of hdr) args.push('-H', h);
    if (r.method) args.push('--method', r.method);
    if (r.rate) args.push('--rate', r.rate);
    if (r.session) args.push('--session-from', `http://127.0.0.1:${PORTS.app}`);
    sampler = new Sampler(procs);
    lg = await loadgen(args);
  }
  const s = sampler.stop();
  const net1 = netCounters();
  const lgCores = cpus.loadgen.length;
  const out = {
    scenario: cell.scenario, variant: cell.variant, config: cell.cfg, repeat, budget: cell.budget,
    noisy: g ? !g.clean : null, gate: g && { load: g.load, minIdle: Number(Math.min(...Object.values(g.idle)).toFixed(3)), waitedS: g.waitedS },
    loadgen: lg, procs: s.procs, windowS: s.secs,
    loadgenBound: lg.loadgen_cpu_s !== undefined && lg.secs ? lg.loadgen_cpu_s / lg.secs > 0.9 * lgCores : false,
    loopback: { listenOverflows: net1.listenOverflows - net0.listenOverflows, timeWaitAfter: net1.timeWait, eaddrnotavail: Object.entries(lg.errors ?? {}).filter(([k]) => /Cannot assign requested address|AddrNotAvailable/i.test(k)).reduce((x, [, v]) => x + v, 0) },
  };
  out.loopbackAffected = out.loopback.listenOverflows > 0 || out.loopback.eaddrnotavail > 0;
  // Derived metrics.
  const serverCpu = Object.values(s.procs).reduce((x, p) => x + p.cpuS, 0);
  if (lg.mib_s !== undefined && lg.bytes) out.cpuSPerGiB = Object.fromEntries(Object.entries(s.procs).map(([k, p]) => [k, Number((p.cpuS / (lg.bytes / 2 ** 30)).toFixed(3))]));
  if (r.kind === 'http' && lg.ops) out.cpuUsPerReq = Number(((serverCpu * 1e6) / lg.ops).toFixed(1));
  return out;
}

const runs = [];
const notes = [];
const log = (m) => console.error(`[bench] ${m}`);

async function main() {
  if (!existsSync(LOADGEN)) throw new Error(`${LOADGEN} missing: cargo build --release --manifest-path bench/loadgen/Cargo.toml --target-dir \${CARGO_TARGET_DIR:-target}`);
  if (!existsSync(serverBin)) throw new Error(`${serverBin} missing (--server-bin)`);
  const distSrc = path.resolve(a.dist ?? path.join(REPO, 'frontend/dist'));
  const dist = prepareDist(distSrc, scratch);
  const id = a.out ? path.basename(a.out) : `${new Date().toISOString().slice(0, 10)}-${a.label ?? presetName}`;
  const outDir = path.resolve(a.out ?? path.join(REPO, 'bench/results', id));
  const rawDir = path.join(REPO, 'bench/results/raw', id);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const dataDir = path.join(scratch, 'data');
  mkdirSync(dataDir, { recursive: true });
  const profilesFile = writeProfiles(scratch);
  const echo = launch('echo', LOADGEN, ['echo', '--listen', `127.0.0.1:${PORTS.echo}`], { cpus: cpus.loadgen, log: path.join(rawDir, 'echo.log') });
  const cleanup = [echo.stop];
  process.on('SIGINT', async () => {
    for (const c of cleanup) await c();
    process.exit(130);
  });
  try {
    await waitPort(PORTS.echo);
    assertLoopback('echo', [echo.pid]);
    const common = { serverBin, staticDir: dist.dir, dataDir, scratch, cpus: cpus.servers, logDir: rawDir, profilesFile, log: 'warn'};

    // The equivalence check must pass before any timing (§3.2).
    let check = null;
    if (!a['no-check'] || a.check) {
      log('equivalence check (gnome-server vs the Node baseline)…');
      check = await runCheck({ common, distDir: dist.dir, loadgen: LOADGEN, target: `127.0.0.1:${PORTS.echo}` });
      writeFileSync(path.join(outDir, 'check.json'), `${JSON.stringify(check, null, 1)}\n`.replaceAll(scratch, '<scratch>').replaceAll(os.homedir(), '~').replaceAll(os.userInfo().username, '<user>'));
      log(`check: ${check.pass ? 'PASS' : 'FAIL'} (${check.equivalent}/${check.cases} requests equivalent; 64 MiB echo: ${check.sha.map((x) => `${x.config} ${x.equal ? 'equal' : 'DIFFERENT'}`).join(', ')})`);
      if (!check.pass) {
        for (const d of check.diffs) log(`  ✗ ${d.name}: ${d.diffs.join('; ')}`);
        throw new Error('--check failed: no timing runs (§3.2)');
      }
      if (a.check) return;
    }
    const files = (await import('./lib/equivalence.mjs')).pickFiles(dist.dir);
    // H1 (d) needs the identity ETag of the asset (both servers compute the same value).
    const etag = `"${createHash('sha256').update(readFileSync(path.join(dist.dir, files.asset))).digest().subarray(0, 16).toString('base64url')}"`;
    setH1(files, etag);

    const meta = {
      id, preset: presetName, label: a.label ?? presetName, note: a.note, started: new Date().toISOString(),
      settings: { ...preset }, scenarios, configs,
      snapshot: process.env.BENCH_SNAPSHOT ?? null, serverBin: tilde(serverBin), dist: { dir: tilde(dist.dir), source: tilde(distSrc), label: dist.label },
      machine: machine(), check: check && { pass: check.pass, equivalent: check.equivalent, cases: check.cases, sha: check.sha },
      commands: {},
    };
    const maxRepeats = Math.max(preset.repeats, preset.budgetedRepeats);
    const unavailable = {};
    for (let rep = 1; rep <= maxRepeats; rep++) {
      for (const cfg of configs) {
        const cells = cellsFor(cfg).filter((c) => rep <= preset.repeats || (c.budget && rep <= preset.budgetedRepeats));
        const wantR1 = scenarios.includes('R1') && ['rust', 'node1', 'node4', 'holywisp'].includes(cfg) && rep === 1;
        if (!cells.length && !wantR1) continue;
        let srv;
        try {
          srv = await startConfig(cfg, common);
        } catch (e) {
          if (e.unavailable) {
            unavailable[cfg] = e.message;
            continue;
          }
          throw e;
        }
        cleanup.push(srv.stop);
        meta.commands[cfg] = srv.cmdlines;
        log(`repeat ${rep}/${maxRepeats} · ${cfg}: ${cells.length} cells`);
        try {
          if (wantR1) {
            await sleep(10_000);
            runs.push({ scenario: 'R1', variant: '(a) 10 s after start', config: cfg, repeat: rep, rssMiB: rssMap(srv) });
          }
          for (const cell of cells) {
            try {
              const r = await runCell(cell, srv, rep);
              runs.push(r);
              log(`  ${cell.scenario} ${cell.variant}: ${headline(r)}${r.noisy ? ' (noisy)' : ''}`);
            } catch (e) {
              runs.push({ scenario: cell.scenario, variant: cell.variant, config: cfg, repeat: rep, error: String(e.message).slice(0, 300) });
              log(`  ${cell.scenario} ${cell.variant}: ERROR ${e.message.slice(0, 200)}`);
            }
            if (wantR1 && cell.scenario === 'H1' && cell.variant === '(a) c=64') runs.push({ scenario: 'R1', variant: '(b) after H1 (a) c=64', config: cfg, repeat: rep, rssMiB: rssMap(srv) });
            if (wantR1 && cell.scenario === 'W4' && cell.variant === `N=${preset.w4[0]}`) {
              await sleep(2000);
              runs.push({ scenario: 'R1', variant: `(c) after W4 N=${preset.w4[0]} closed`, config: cfg, repeat: rep, rssMiB: rssMap(srv) });
            }
          }
        } finally {
          await srv.stop();
        }
      }
    }
    for (const [cfg, why] of Object.entries(unavailable)) notes.push(`${cfg}: not run (${why})`);
    if (scenarios.includes('S1') && configs.some((c) => ['rust', 'node1'].includes(c))) await startup(common, dist.dir, rawDir);
    if (scenarios.includes('B1')) b1();
    meta.finished = new Date().toISOString();
    meta.notes = notes;
    const results = { meta, runs, summary: summarizeRuns(runs) };
    // No home directory, scratch path or user name in committed results (§3.1).
    const redact = (t) => t.replaceAll(scratch, '<scratch>').replaceAll(os.homedir(), '~').replaceAll(os.userInfo().username, '<user>');
    writeFileSync(path.join(outDir, 'results.json'), redact(`${JSON.stringify(results, null, 1)}\n`));
    writeFileSync(path.join(outDir, 'results.md'), redact(markdown(results)));
    log(`wrote ${tilde(outDir)}/results.{json,md}`);
  } finally {
    for (const c of cleanup.reverse()) await c();
  }
}

function rssMap(srv) {
  return Object.fromEntries(srv.procs.map((p) => [p.name, Number((tree(p.pid).reduce((s, x) => s + (status(x)?.rssKiB ?? 0), 0) / 1024).toFixed(1))]));
}

function headline(r) {
  const l = r.loadgen;
  if (l.mode === 'tp') return `${l.mib_s} MiB/s`;
  if (l.mode === 'idle') return `held ${l.held}/${l.conns}, ${JSON.stringify(r.loadgen.perConnKiB)} KiB/conn`;
  if (l.mode === 'http') return `${l.ops_s} req/s p50 ${l.p50_us} µs p99 ${l.p99_us} µs${Object.keys(l.errors).length ? ` errors ${JSON.stringify(l.errors)}` : ''}`;
  return `${l.ops_s} ops/s p50 ${l.p50_us} µs p99 ${l.p99_us} µs`;
}

// ── S1: startup (§3.3) ───────────────────────────────────────────────────────────────────────────────────────────
async function startup(common, distDir, rawDir) {
  const hw = launch('holywisp', path.join(REPO, 'services/holywisp/build/x86_64/holywisp'), (await import('./lib/servers.mjs')).holywispArgs(PORTS.holywisp), { cpus: cpus.servers, log: path.join(rawDir, 's1-holywisp.log'), cleanEnv: true });
  await waitPort(PORTS.holywisp);
  try {
    for (const cfg of ['rust', 'node1'].filter((c) => configs.includes(c))) {
      for (const variant of ['(a) warm', '(b) cold (fadvise)', '(c) fresh data dir']) {
        if (cfg === 'node1' && variant.startsWith('(c)')) continue; // the Node baseline has no data directory
        const times = [];
        for (let i = 0; i < preset.s1Runs; i++) {
          const dataDir = variant.startsWith('(c)') ? path.join(common.scratch, `s1-fresh-${i}`) : common.dataDir;
          if (variant.startsWith('(c)')) rmSync(dataDir, { recursive: true, force: true });
          mkdirSync(dataDir, { recursive: true });
          if (variant.startsWith('(b)')) {
            const targets = cfg === 'rust' ? [serverBin, distDir, dataDir] : [process.execPath, path.join(REPO, 'bench/node'), distDir];
            await new Promise((r) => spawn(LOADGEN, ['fadvise', ...targets], { stdio: 'ignore' }).on('exit', r));
          }
          const t0 = performance.now();
          let p;
          if (cfg === 'rust') {
            p = launch('gnome-server', serverBin, ['serve'], { cpus: cpus.servers, env: gnomeEnv({ staticDir: distDir, dataDir, upstream: PORTS.holywisp }), cleanEnv: true });
          } else {
            p = launch('node', process.execPath, [path.join(REPO, 'bench/node/server.mjs'), '--bind', `127.0.0.1:${PORTS.app}`, '--proxy-bind', `127.0.0.1:${PORTS.proxy}`, '--static', distDir, '--upstream', `127.0.0.1:${PORTS.holywisp}`], { cpus: cpus.servers, cleanEnv: true });
          }
          let ms = null;
          while (performance.now() - t0 < 20_000) {
            if ((await httpStatus(PORTS.app, '/api/health', 200)) === 200) {
              ms = performance.now() - t0;
              break;
            }
            await sleep(2);
          }
          await p.stop();
          times.push(ms);
        }
        const v = times.filter((x) => x !== null).sort((x, y) => x - y);
        runs.push({ scenario: 'S1', variant, config: cfg, repeat: 1, budget: cfg === 'rust' ? 'RB10' : null, startupMs: { p50: v[Math.floor(v.length * 0.5)], p90: v[Math.min(v.length - 1, Math.floor(v.length * 0.9))], max: v.at(-1), n: v.length, failed: times.length - v.length } });
        log(`  S1 ${cfg} ${variant}: p50 ${v[Math.floor(v.length * 0.5)]?.toFixed(1)} ms`);
      }
    }
  } finally {
    await hw.stop();
  }
}

// ── B1: sizes (§3.3; only the glibc build until d3a's server-out exists) ────────────────────────────────────────
function b1() {
  const stripped = path.join(scratch, 'gnome-server.stripped');
  copyFileSync(serverBin, stripped);
  sh('strip', [stripped]);
  const lock = readT(path.join(REPO, 'Cargo.lock')) ?? '';
  const tree = sh('cargo', ['tree', '-p', 'gnome-server', '-e', 'normal', '--prefix', 'none', '--offline', '--manifest-path', path.join(REPO, 'Cargo.toml')]);
  runs.push({
    scenario: 'B1', variant: 'x86_64 glibc release', config: 'rust', repeat: 1,
    bytes: { unstripped: statSync(serverBin).size, stripped: statSync(stripped).size },
    crates: { lockPackages: (lock.match(/^\[\[package\]\]$/gm) ?? []).length, normalTree: tree ? new Set(tree.split('\n').map((l) => l.replace(/ \(\*\)$/, '').trim()).filter(Boolean)).size : null },
  });
  notes.push('B1: x86_64 musl, aarch64 musl, panic=abort / opt-level=s variants, mimalloc and cargo bloat not measured (need d3a server-out / d1b; open)');
}

// ── summaries and the markdown tables ────────────────────────────────────────────────────────────────────────────
function metricOf(r) {
  const l = r.loadgen;
  if (!l) return {};
  if (l.mode === 'tp') return { 'MiB/s': l.mib_s };
  if (l.mode === 'idle') return Object.fromEntries(Object.entries(l.perConnKiB ?? {}).map(([k, v]) => [`KiB/conn ${k}`, v]));
  if (l.mode === 'http') return { 'req/s': l.ops_s, 'p50 µs': l.p50_us, 'p99 µs': l.p99_us, 'p99.9 µs': l.p999_us, 'CPU µs/req': r.cpuUsPerReq };
  return { 'ops/s': l.ops_s, 'p50 µs': l.p50_us, 'p99 µs': l.p99_us, 'p99.9 µs': l.p999_us, 'max µs': l.max_us };
}

function summarizeRuns(all) {
  const groups = new Map();
  for (const r of all) {
    if (r.error || !r.loadgen) continue;
    const k = `${r.scenario}|${r.variant}|${r.config}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of groups) {
    const [scenario, variant, config] = k.split('|');
    const clean = rs.filter((r) => !r.noisy);
    const use = clean.length ? clean : rs;
    const metrics = {};
    for (const name of Object.keys(metricOf(use[0]))) metrics[name] = summarize(use.map((r) => metricOf(r)[name]));
    if (use[0].loadgen.hist_ns) {
      const h = mergeHists(use.map((r) => r.loadgen.hist_ns));
      for (const [n, q] of [['p50 µs', 0.5], ['p99 µs', 0.99], ['p99.9 µs', 0.999]]) if (metrics[n]) metrics[n] = { ...metrics[n], merged: histQuantile(h, q) / 1000 };
    }
    const peak = {};
    for (const name of Object.keys(use[0].procs ?? {})) peak[name] = Math.max(...use.map((r) => r.procs[name].peakRssMiB));
    out.push({ scenario, variant, config, budget: rs[0].budget, repeats: rs.length, clean: clean.length, noisyOnly: !clean.length && rs.some((r) => r.noisy), loadgenBound: use.some((r) => r.loadgenBound), loopbackAffected: use.some((r) => r.loopbackAffected), metrics, peakRssMiB: peak, cpuSPerGiB: use[0].cpuSPerGiB ?? null });
  }
  // RB3: RSS growth per idle connection as the slope between the smallest and the largest N of W4.
  for (const cfg of new Set(all.filter((r) => r.scenario === 'W4').map((r) => r.config))) {
    const w = all.filter((r) => r.scenario === 'W4' && r.config === cfg && r.loadgen?.heldRssMiB);
    const byN = new Map();
    for (const r of w) {
      const n = r.loadgen.held;
      if (!byN.has(r.variant)) byN.set(r.variant, []);
      byN.get(r.variant).push(r);
    }
    const groups = [...byN.values()].sort((x, y) => x[0].loadgen.held - y[0].loadgen.held);
    if (groups.length < 2) continue;
    const lo = groups[0];
    const hi = groups.at(-1);
    const med = (rs, k) => summarize(rs.map((r) => r.loadgen.heldRssMiB[k])).median;
    const held = (rs) => summarize(rs.map((r) => r.loadgen.held)).median;
    const slope = Object.fromEntries(Object.keys(lo[0].loadgen.heldRssMiB).map((k) => [k, Number((((med(hi, k) - med(lo, k)) * 1024) / Math.max(1, held(hi) - held(lo))).toFixed(2))]));
    out.push({ scenario: 'W4', variant: `slope ${lo[0].variant}→${hi[0].variant}`, config: cfg, budget: cfg === 'rust' ? 'RB3' : null, repeats: Math.min(lo.length, hi.length), clean: null, metrics: Object.fromEntries(Object.entries(slope).map(([k, v]) => [`KiB/conn ${k}`, { median: v }])), peakRssMiB: {} });
  }
  return out;
}

const fmt = (m) => (m ? (m.merged !== undefined ? m.merged : m.median) : null);
function markdown({ meta, runs: all, summary }) {
  const L = [];
  L.push(`# Benchmark results: ${meta.id}`, '');
  L.push(`Preset **${meta.preset}**${meta.note ? ` — ${meta.note}` : ''}. ${meta.started} → ${meta.finished}.`, '');
  L.push(`Machine: ${meta.machine.cpu}, ${meta.machine.logicalCpus} logical CPUs (${meta.machine.cores} cores), governor ${meta.machine.governor}, kernel ${meta.machine.kernel}, ${meta.machine.memTotalMiB} MiB RAM; ${meta.machine.rustc}; Node ${meta.machine.node}; wisp-js ${meta.machine.wispJs}. CPU sets: servers ${meta.machine.cpuSets.servers}, idle siblings ${meta.machine.cpuSets.idle}, load generator ${meta.machine.cpuSets.loadgen}.`, '');
  L.push(`Server: \`${meta.serverBin}\` (sha256 ${meta.machine.sha256['gnome-server']?.slice(0, 16)}…), snapshot ${meta.snapshot ?? 'n/a'}; dist: ${meta.dist.label}.`, '');
  if (meta.check) L.push(`Equivalence check: ${meta.check.pass ? 'pass' : 'FAIL'} (${meta.check.equivalent}/${meta.check.cases}; 64 MiB echo ${meta.check.sha.map((s) => `${s.config} ${s.equal ? 'equal' : 'different'}`).join(', ')}).`, '');
  L.push('Marks: **N** noisy (the quiet gate failed and no clean repeat exists), **L** load-generator-bound, **X** loopback limits hit (not a server number).', '');
  for (const sc of ['W1', 'W2', 'W3', 'W4', 'H1', 'A1']) {
    const rows = summary.filter((s) => s.scenario === sc);
    if (!rows.length) continue;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
    L.push(`## ${sc}`, '', `| variant | config | ${cols.join(' | ')} | peak RSS MiB | n | marks |`, `| --- | --- | ${cols.map(() => '---:').join(' | ')} | --- | ---: | --- |`);
    for (const r of rows) {
      const marks = `${r.noisyOnly ? 'N' : ''}${r.loadgenBound ? 'L' : ''}${r.loopbackAffected ? 'X' : ''}${r.budget ? ` ${r.budget}` : ''}`;
      const v = cols.map((c) => {
        const x = fmt(r.metrics[c]);
        return x === null || x === undefined ? '' : Number(x).toLocaleString('en-US', { maximumFractionDigits: 1 });
      });
      L.push(`| ${r.variant} | ${r.config} | ${v.join(' | ')} | ${Object.entries(r.peakRssMiB).map(([k, x]) => `${k} ${x}`).join(', ')} | ${r.repeats} | ${marks} |`);
    }
    L.push('');
  }
  const s1 = all.filter((r) => r.scenario === 'S1');
  if (s1.length) {
    L.push('## S1 startup (exec → first 200 from /api/health)', '', '| variant | config | p50 ms | p90 ms | max ms | runs |', '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const r of s1) L.push(`| ${r.variant} | ${r.config} | ${r.startupMs.p50?.toFixed(1)} | ${r.startupMs.p90?.toFixed(1)} | ${r.startupMs.max?.toFixed(1)} | ${r.startupMs.n} |`);
    L.push('');
  }
  const r1 = all.filter((r) => r.scenario === 'R1');
  if (r1.length) {
    L.push('## R1 memory at rest (RSS MiB)', '', '| variant | config | RSS |', '| --- | --- | --- |');
    for (const r of r1) L.push(`| ${r.variant} | ${r.config} | ${Object.entries(r.rssMiB).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
    L.push('');
  }
  const b = all.find((r) => r.scenario === 'B1');
  if (b) L.push('## B1 sizes', '', `gnome-server x86_64 glibc release: ${b.bytes.unstripped.toLocaleString('en-US')} B unstripped, ${b.bytes.stripped.toLocaleString('en-US')} B stripped; Cargo.lock packages ${b.crates.lockPackages}, crates in the normal tree ${b.crates.normalTree ?? 'n/a'}.`, '');
  const errs = all.filter((r) => r.error);
  if (errs.length) {
    L.push('## Errors', '');
    for (const e of errs) L.push(`- ${e.scenario} ${e.variant} ${e.config}: ${e.error}`);
    L.push('');
  }
  if (meta.notes?.length) L.push('## Notes', '', ...meta.notes.map((n) => `- ${n}`), '');
  return `${L.join('\n')}\n`;
}

main().catch((e) => {
  console.error(`[bench] ${e.stack ?? e}`);
  process.exit(1);
});
