// CPU sets (docs/WAVE-D.md §3.4): servers on 4 logical CPUs of 4 distinct physical cores with their SMT siblings
// left idle, the load generator on the remaining physical cores (all their threads).
import { readdirSync, readFileSync } from 'node:fs';

export function parseList(s) {
  const out = [];
  for (const part of String(s).trim().split(',').filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}
export const formatList = (l) => [...l].sort((a, b) => a - b).join(',');

/** `siblings`: Map cpu → its thread_siblings_list (array). */
export function derive(siblings, serverCores = 4) {
  const cores = [];
  const seen = new Set();
  for (const cpu of [...siblings.keys()].sort((a, b) => a - b)) {
    if (seen.has(cpu)) continue;
    const group = [...siblings.get(cpu)].sort((a, b) => a - b);
    group.forEach((c) => seen.add(c));
    cores.push(group);
  }
  if (cores.length < serverCores + 1) throw new Error(`need at least ${serverCores + 1} physical cores, found ${cores.length}`);
  const servers = cores.slice(0, serverCores).map((g) => g[0]);
  const idle = cores.slice(0, serverCores).flatMap((g) => g.slice(1));
  const loadgen = cores.slice(serverCores).flat();
  return { servers, idle, loadgen, cores: cores.length, smt: cores.some((g) => g.length > 1) };
}

export function readTopology(root = '/sys/devices/system/cpu') {
  const m = new Map();
  for (const d of readdirSync(root)) {
    if (!/^cpu\d+$/.test(d)) continue;
    try {
      m.set(Number(d.slice(3)), parseList(readFileSync(`${root}/${d}/topology/thread_siblings_list`, 'utf8')));
    } catch {
      /* offline CPU */
    }
  }
  return m;
}

/** `override`: "servers=0-3,loadgen=4,5,10,11" (the --cpus flag, e.g. on a Raspberry Pi 4). */
export function cpuSets(override, topology = readTopology()) {
  const d = derive(topology);
  if (!override) return d;
  const grab = (k) => new RegExp(`${k}=([\\d,-]+?)(?:,(?:servers|loadgen)=|$)`).exec(override)?.[1];
  const s = grab('servers');
  const l = grab('loadgen');
  if (s) d.servers = parseList(s);
  if (l) d.loadgen = parseList(l);
  d.override = override;
  return d;
}
