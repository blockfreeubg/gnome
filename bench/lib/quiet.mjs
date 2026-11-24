// The quiet gate (docs/WAVE-D.md §3.4): 2 s of /proc/stat; every CPU of both sets ≥ 95 % idle and the 1-minute
// load average ≤ 2, else wait and retry; after the last try the repeat runs and is marked noisy.
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export function readCpuTimes() {
  const out = new Map();
  for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
    const m = /^cpu(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].split(/\s+/).map(Number);
    const idle = v[3] + (v[4] ?? 0);
    out.set(Number(m[1]), { idle, total: v.reduce((a, b) => a + b, 0) });
  }
  return out;
}

export async function idleShares(cpus, ms = 2000) {
  const a = readCpuTimes();
  await sleep(ms);
  const b = readCpuTimes();
  return Object.fromEntries(cpus.map((c) => {
    const dt = b.get(c).total - a.get(c).total;
    return [c, dt > 0 ? (b.get(c).idle - a.get(c).idle) / dt : 1];
  }));
}

export const loadavg1 = () => Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);

/** Returns {clean, waitedS, idle, load}. `tries` = 0 measures once and never waits. */
export async function gate(cpus, { minIdle = 0.95, maxLoad = 2, waitS = 30, tries = 20, log = () => {} } = {}) {
  let waited = 0;
  for (let i = 0; ; i++) {
    const idle = await idleShares(cpus);
    const load = loadavg1();
    const ok = Object.values(idle).every((x) => x >= minIdle) && load <= maxLoad;
    if (ok) return { clean: true, waitedS: waited, idle, load };
    if (i >= tries) return { clean: false, waitedS: waited, idle, load };
    log(`quiet gate: busy (load ${load}, min idle ${Math.min(...Object.values(idle)).toFixed(2)}); waiting ${waitS} s`);
    await sleep(waitS * 1000);
    waited += waitS;
  }
}
