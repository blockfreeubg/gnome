// /proc sampling (docs/WAVE-D.md §3.4) and the loopback guard (§0): every listener a started process opens must
// be on 127.0.0.0/8 (or ::1).
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

const CLK_TCK = 100;
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** `pid` and every descendant (node:cluster workers). */
export function tree(pid) {
  const kids = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const s = read(`/proc/${d}/stat`);
    if (!s) continue;
    const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(d));
  }
  const out = [];
  const walk = (p) => {
    out.push(p);
    for (const k of kids.get(p) ?? []) walk(k);
  };
  walk(pid);
  return out;
}

export function status(pid) {
  const s = read(`/proc/${pid}/status`);
  if (!s) return null;
  const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0);
  return { rssKiB: kb('VmRSS'), hwmKiB: kb('VmHWM'), threads: kb('Threads') };
}

export function cpuSeconds(pid) {
  const s = read(`/proc/${pid}/stat`);
  if (!s) return 0;
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) / CLK_TCK;
}

export function pssKiB(pid) {
  const s = read(`/proc/${pid}/smaps_rollup`);
  return Number(/^Pss:\s+(\d+)/m.exec(s ?? '')?.[1] ?? 0);
}

export function fdCount(pid) {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return 0;
  }
}

function socketInodes(pid) {
  const out = new Set();
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) out.add(m[1]);
      } catch {
        /* closed meanwhile */
      }
    }
  } catch {
    /* gone */
  }
  return out;
}

function hexAddr(h) {
  if (h.length === 8) return [3, 2, 1, 0].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)).join('.');
  const words = h.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  const full = words.join('');
  if (full === '00000000000000000000000000000001') return '::1';
  if (full.startsWith('00000000000000000000ffff')) return [24, 26, 28, 30].map((i) => parseInt(full.slice(i, i + 2), 16)).join('.');
  return full.match(/.{4}/g).join(':');
}

/** TCP listeners owned by `pids`: [{addr, port}]. */
export function listeners(pids) {
  const inodes = new Set();
  for (const p of pids) for (const i of socketInodes(p)) inodes.add(i);
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (read(f) ?? '').split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== '0A' || !inodes.has(c[9])) continue;
      const [a, p] = c[1].split(':');
      out.push({ addr: hexAddr(a), port: parseInt(p, 16) });
    }
  }
  return out;
}

export const isLoopback = (a) => a === '::1' || /^127\./.test(a);

/** Throws when a listener of `pids` is not on loopback. */
export function assertLoopback(name, pids) {
  const bad = listeners(pids).filter((l) => !isLoopback(l.addr));
  if (bad.length) throw new Error(`${name} listens on a non-loopback address (${bad.map((l) => `${l.addr}:${l.port}`).join(', ')}); run aborted`);
}

/** Loopback health counters: ListenOverflows (TcpExt) and sockets in TIME_WAIT. */
export function netCounters() {
  const ns = read('/proc/net/netstat') ?? '';
  const lines = ns.split('\n');
  let overflows = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('TcpExt:') && lines[i + 1].startsWith('TcpExt:')) {
      const k = lines[i].split(/\s+/);
      const v = lines[i + 1].split(/\s+/);
      overflows = Number(v[k.indexOf('ListenOverflows')] ?? 0);
      break;
    }
  }
  let timeWait = 0;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) for (const l of (read(f) ?? '').split('\n').slice(1)) if (l.trim().split(/\s+/)[3] === '06') timeWait++;
  return { listenOverflows: overflows, timeWait };
}

/** Pipes held by this UID's processes that we can see (the per-user pipe budget, §3.4). */
export function pipeCount() {
  let n = 0;
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      for (const fd of readdirSync(`/proc/${d}/fd`)) {
        try {
          if (readlinkSync(`/proc/${d}/fd/${fd}`).startsWith('pipe:')) n++;
        } catch {
          /* raced */
        }
      }
    } catch {
      /* not ours */
    }
  }
  return n;
}

/** Samples VmRSS/VmHWM every 100 ms for named process trees; `stop()` returns per-name metrics. */
export class Sampler {
  constructor(procs) {
    this.procs = procs; // [{name, pid}]
    this.peak = Object.fromEntries(procs.map((p) => [p.name, 0]));
    this.cpu0 = Object.fromEntries(procs.map((p) => [p.name, this.cpu(p.pid)]));
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), 100);
    this.tick();
  }
  cpu(pid) {
    return tree(pid).reduce((a, p) => a + cpuSeconds(p), 0);
  }
  rss(pid) {
    return tree(pid).reduce((a, p) => a + (status(p)?.rssKiB ?? 0), 0);
  }
  tick() {
    for (const p of this.procs) this.peak[p.name] = Math.max(this.peak[p.name], this.rss(p.pid));
  }
  stop() {
    clearInterval(this.timer);
    this.tick();
    const secs = (performance.now() - this.t0) / 1000;
    const out = {};
    for (const p of this.procs) {
      const pids = tree(p.pid);
      out[p.name] = {
        cpuS: Number((this.cpu(p.pid) - this.cpu0[p.name]).toFixed(3)),
        peakRssMiB: Number((this.peak[p.name] / 1024).toFixed(1)),
        rssMiB: Number((this.rss(p.pid) / 1024).toFixed(1)),
        pssMiB: Number((pids.reduce((a, x) => a + pssKiB(x), 0) / 1024).toFixed(1)),
        fds: pids.reduce((a, x) => a + fdCount(x), 0),
      };
    }
    return { secs: Number(secs.toFixed(2)), procs: out };
  }
}
