// Process start/stop with ready checks and the bench configuration of every server (docs/WAVE-D.md §3.1). The
// bench settings live only here, never in a product default. Every process is pinned with taskset and every
// listener it opens is checked to be on loopback.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertLoopback, tree } from './proc.mjs';
import { formatList } from './cpusets.mjs';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const HOLYWISP_BIN = path.join(REPO, 'services/holywisp/build/x86_64/holywisp');
export const HOLYWISP_CONF = path.join(REPO, 'services/holywisp/gnome.conf');
export const tilde = (s) => String(s).replaceAll(os.homedir(), '~');

/** The lane's ports (12000-12999). */
// BENCH_PORT_BASE moves the whole set (default 12100: app = base+1 ... echo = base+20).
const PB = Number(process.env.BENCH_PORT_BASE || 12100);
export const PORTS = { app: PB + 1, proxy: PB + 2, admin: PB + 3, holywisp: PB + 11, wispjs: PB + 12, vpn: PB + 13, echo: PB + 20 };
const H = '127.0.0.1';

export function waitPort(port, timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, H);
      s.once('connect', () => {
        s.destroy();
        resolve(Date.now() - t0);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) reject(new Error(`port ${port} not ready after ${timeoutMs} ms`));
        else setTimeout(tryOnce, 20);
      });
    };
    tryOnce();
  });
}

export async function httpStatus(port, p, timeoutMs = 1000) {
  try {
    const r = await fetch(`http://${H}:${port}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
    await r.arrayBuffer();
    return r.status;
  } catch {
    return 0;
  }
}

/** Spawn `cmd` pinned to `cpus`, logging to `log`. Returns {name, pid, cmdline, exited, stop()}. */
export function launch(name, cmd, args, { cpus, env = {}, log, cleanEnv = false }) {
  const full = cpus ? ['taskset', ['-c', formatList(cpus), cmd, ...args]] : [cmd, args];
  const base = cleanEnv ? { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' } : process.env;
  const child = spawn(full[0], full[1], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (log) {
    mkdirSync(path.dirname(log), { recursive: true });
    const out = createWriteStream(log);
    child.stdout.pipe(out);
    child.stderr.pipe(out);
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  let stopped = false;
  return {
    name,
    pid: child.pid,
    child,
    cmdline: tilde([cmd, ...args].join(' ')),
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, tilde(v)])),
    exited,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const t = await Promise.race([exited, sleep(5000).then(() => null)]);
      if (!t) {
        for (const p of tree(child.pid).reverse()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
        await exited;
      }
    },
  };
}

export function holywispArgs(port) {
  // gnome.conf plus the bench flags: loopback targets allowed (the echo is on loopback; the harness refuses any
  // other host), the connection and flood limits raised/off so the bench measures relaying, 4 workers.
  return ['--config', HOLYWISP_CONF, '--host', H, '--port', String(port), '--workers', '4', '--allow-loopback', 'on',
    '--flood-protection', 'off', '--connections-limit-per-ip', '1000000', '--max-concurrent-connections', '100000',
    '--max-streams-per-conn', '0'];
}

export function gnomeEnv({ staticDir, dataDir, upstream, profilesFile, log = 'warn', defaultCaps = false }) {
  const env = {
    GNOME_BIND: `${H}:${PORTS.app}`,
    GNOME_PROXY_BIND: `${H}:${PORTS.proxy}`,
    GNOME_ADMIN_BIND: `${H}:${PORTS.admin}`,
    GNOME_STATIC_DIR: staticDir,
    GNOME_DATA_DIR: dataDir,
    GNOME_WISP_UPSTREAM: `${H}:${upstream}`,
    GNOME_WORKERS: '4',
    GNOME_RATE_LIMIT_SCALE: '0',
    GNOME_FILTERS_REFRESH_HOURS: '0',
    GNOME_CATALOG_REFRESH_HOURS: '0',
    GNOME_OSS_FETCH: 'manual',
    GNOME_LOG: log,
  };
  if (!defaultCaps) {
    Object.assign(env, {
      GNOME_MAX_WS_PER_IP: '100000',
      GNOME_MAX_WS_PER_SESSION: '100000',
      // d4b's caps (ignored by snapshots that predate them), at their maximum so they never differ between runs.
      GNOME_MAX_CONNECTIONS: '100000',
      GNOME_MAX_CONNS_PER_IP: '100000',
      GNOME_MAX_INFLIGHT_PER_IP: '100000',
      GNOME_MAX_INFLIGHT_HEAD_MB: '1024',
    });
  }
  if (profilesFile) env.GNOME_VPN_PROFILES = profilesFile;
  return env;
}

export function writeProfiles(dir) {
  const f = path.join(dir, 'vpn-profiles.toml');
  writeFileSync(f, `[[profile]]\nid = "bench-vpn"\nlabel = "Bench"\ncountry_code = "se"\ncountry = "Sweden"\ncity = "Bench"\nprovider_note = "bench (no listener)"\nwisp_upstream = "${H}:${PORTS.vpn}"\n`);
  return f;
}

/** Every configuration of §3.3: what it starts and how the load generator reaches it. */
export const CONFIGS = {
  rust: { gateway: true, upstream: 'holywisp' },
  node1: { gateway: true, upstream: 'holywisp', workers: 1 },
  node4: { gateway: true, upstream: 'holywisp', workers: 4 },
  'node4-wispjs': { gateway: true, upstream: 'wispjs4', workers: 4 },
  holywisp: { direct: 'holywisp' },
  wispjs: { direct: 'wispjs', workers: 1 },
  wispjs4: { direct: 'wispjs', workers: 4 },
  'rust-ctr': { unavailable: 'not implemented in this pass: needs a static (musl) gnome-server from d3a\'s server-out target (the host glibc 2.44 binary does not run in debian:trixie) and the container runner (open)' },
  'rust-copy': { unavailable: 'not implemented in this pass: as rust-ctr, plus bench/lib/no-splice.json (Docker default seccomp minus splice; open)' },
  'rust+caddy': { unavailable: 'needs d3a\'s derived Caddy image (deployment/caddy/), not built yet' },
};

/**
 * Start a configuration. Returns {procs: [{name, pid}], wisp: [loadgen flags], app, proxy, stop(), cmdlines}.
 * `o` = {serverBin, staticDir, dataDir, scratch, cpus, logDir, profilesFile, log, defaultCaps}
 */
export async function startConfig(name, o) {
  const c = CONFIGS[name];
  if (!c) throw new Error(`unknown configuration ${name}`);
  if (c.unavailable) throw Object.assign(new Error(c.unavailable), { unavailable: true });
  const started = [];
  const stopAll = async () => {
    for (const p of started.reverse()) await p.stop();
  };
  const log = (n) => path.join(o.logDir, `${n}.log`);
  try {
    const up = async (kind) => {
      if (kind === 'holywisp') {
        if (!existsSync(HOLYWISP_BIN)) throw new Error(`HolyWisp not found at ${HOLYWISP_BIN}`);
        const p = launch('holywisp', HOLYWISP_BIN, holywispArgs(PORTS.holywisp), { cpus: o.cpus, log: log(`${name}-holywisp`), cleanEnv: true });
        started.push(p);
        await waitPort(PORTS.holywisp);
        return { p, port: PORTS.holywisp };
      }
      const workers = kind === 'wispjs4' ? 4 : (c.workers ?? 1);
      const p = launch(kind, process.execPath, [path.join(REPO, 'bench/wispjs/server.mjs'), '--port', String(PORTS.wispjs), '--workers', String(workers)], { cpus: o.cpus, log: log(`${name}-wispjs`), cleanEnv: true });
      started.push(p);
      await waitPort(PORTS.wispjs);
      return { p, port: PORTS.wispjs };
    };
    const procs = [];
    let wisp;
    if (c.direct) {
      const u = await up(c.direct === 'holywisp' ? 'holywisp' : name);
      procs.push({ name: c.direct === 'holywisp' ? 'holywisp' : 'wispjs', pid: u.p.pid });
      wisp = ['--url', `ws://${H}:${u.port}/`];
    } else {
      const u = await up(c.upstream);
      if (name === 'rust') {
        const env = gnomeEnv({ staticDir: o.staticDir, dataDir: o.dataDir, upstream: u.port, profilesFile: o.profilesFile, log: o.log, defaultCaps: o.defaultCaps });
        const p = launch('gnome-server', o.serverBin, ['serve'], { cpus: o.cpus, env, log: log(`${name}-gnome-server`), cleanEnv: true });
        started.push(p);
        procs.push({ name: 'gnome-server', pid: p.pid });
      } else {
        const args = [path.join(REPO, 'bench/node/server.mjs'), '--bind', `${H}:${PORTS.app}`, '--proxy-bind', `${H}:${PORTS.proxy}`, '--static', o.staticDir,
          '--upstream', `${H}:${u.port}`, '--profile', `bench-vpn=${H}:${PORTS.vpn}`, '--workers', String(c.workers),
          '--max-ws-per-ip', o.defaultCaps ? '32' : '100000', '--max-ws-per-session', o.defaultCaps ? '16' : '100000'];
        const p = launch('node', process.execPath, args, { cpus: o.cpus, log: log(`${name}-node`), cleanEnv: true });
        started.push(p);
        procs.push({ name: 'node-gateway', pid: p.pid });
      }
      procs.push({ name: c.upstream === 'holywisp' ? 'holywisp' : 'wispjs', pid: u.p.pid });
      await waitPort(PORTS.app);
      await waitPort(PORTS.proxy);
      for (let i = 0; i < 500 && (await httpStatus(PORTS.app, '/api/health')) !== 200; i++) await sleep(20);
      wisp = ['--ticket-api', `http://${H}:${PORTS.app}`];
    }
    await sleep(200);
    for (const p of started) assertLoopback(p.name, tree(p.pid));
    return { name, procs, wisp, stop: stopAll, cmdlines: started.map((p) => ({ name: p.name, cmd: p.cmdline, env: p.env })) };
  } catch (e) {
    await stopAll();
    throw e;
  }
}
