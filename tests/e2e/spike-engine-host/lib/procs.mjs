// Child-process servers with an IPC event log, plus cleanup that always runs.
import { fork, execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { SPIKE_DIR } from './config.mjs';

export const events = []; // every event reported by any child: {type, at, from, ...}
const children = new Map(); // name -> {proc, pending: Map}
const cleanups = [];
let cmdSeq = 0;

export function onCleanup(fn) {
  cleanups.push(fn);
}

export async function cleanupAll() {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn(); } catch (e) { console.error('cleanup:', e.message); }
  }
}

let installed = false;
export function installSignalHandlers() {
  if (installed) return;
  installed = true;
  const bye = async (sig) => {
    console.error(`\n${sig}: cleaning up`);
    await cleanupAll();
    process.exit(130);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

export function startServer(name, script, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = fork(path.join(SPIKE_DIR, 'servers', script), [], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const entry = { proc, pending: new Map(), name };
    children.set(name, entry);
    let listening = false;
    proc.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'cmd-result') {
        const p = entry.pending.get(m.id);
        if (p) { entry.pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
        return;
      }
      events.push({ ...m, from: name });
      if (m.type === 'listening' && !listening) { listening = true; resolve(entry); }
    });
    proc.on('exit', (code, signal) => {
      events.push({ type: 'exit', from: name, code, signal, at: Date.now() });
      for (const p of entry.pending.values()) p.reject(new Error(`${name} exited`));
      entry.pending.clear();
      if (!listening) reject(new Error(`${name} exited before listening (code ${code}, signal ${signal})`));
      if (children.get(name) === entry) children.delete(name);
    });
  });
}

export function command(name, cmd, args = {}, timeout = 10000) {
  const entry = children.get(name);
  if (!entry) return Promise.reject(new Error(`${name} is not running`));
  const id = ++cmdSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { entry.pending.delete(id); reject(new Error(`${name}.${cmd}: timeout`)); }, timeout);
    entry.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    entry.proc.send({ kind: 'cmd', id, cmd, args });
  });
}

export function killServer(name, signal = 'SIGKILL') {
  const entry = children.get(name);
  if (!entry) return Promise.resolve();
  return new Promise((resolve) => {
    entry.proc.once('exit', () => resolve());
    entry.proc.kill(signal);
  });
}

export async function stopAllServers() {
  await Promise.all([...children.keys()].map((n) => killServer(n, 'SIGTERM')));
}

export function eventsSince(t, type) {
  return events.filter((e) => e.at >= t && (!type || e.type === type));
}

export function waitPort(port, host = '127.0.0.1', timeout = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeout) reject(new Error(`port ${host}:${port} not open after ${timeout} ms`));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(true); });
  });
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 << 20, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
