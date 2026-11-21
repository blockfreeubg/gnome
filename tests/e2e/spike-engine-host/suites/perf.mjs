// Item 8 (spike-transport-fallback): performance per engine x transport x browser over the real /wisp/ route
// (production HolyWisp config): engine-host init (cold / warm), load time of example.com and Wikipedia (cold = first
// load in a fresh profile, warm = median of the next loads in the same tab), memory, main-thread blocking.
//
// Each combination gets a FRESH browser so the process-tree PSS delta belongs to that run alone. Both engines are
// initialized in every engine host (as in production); only the measured engine/transport changes.
// SPIKE_PERF_RUNS (default 5) = loads per site (1 cold + N-1 warm); SPIKE_PERF_REPEAT (default 2) = fresh-browser
// repetitions of every combination (each gives one more cold sample).
import fs from 'node:fs';
import { SITES } from '../lib/config.mjs';

const COMBOS = [
  { engine: 'scramjet', transport: 'libcurl', q: { sjt: 'libcurl' } },
  { engine: 'scramjet', transport: 'epoxy', q: { sjt: 'epoxy' } },
  { engine: 'ultraviolet', transport: 'epoxy', q: { uvt: 'epoxy' } },
  { engine: 'ultraviolet', transport: 'libcurl', q: { uvt: 'libcurl' } },
];
const RUNS = Math.max(2, Number(process.env.SPIKE_PERF_RUNS) || 5);
const REPEAT = Math.max(1, Number(process.env.SPIKE_PERF_REPEAT) || 2);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const mb = (kb) => Math.round(kb / 1024);

// Browser processes are direct or indirect children of this Node process (playwright-core runs in-process);
// the harness' own servers (node) and docker clients are excluded.
function browserTreePssKb() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* gone */ }
  }
  let total = 0;
  let procs = 0;
  const walk = (pid, top) => {
    for (const c of kids.get(pid) || []) {
      let comm = '';
      try { comm = fs.readFileSync(`/proc/${c}/comm`, 'utf8').trim(); } catch { continue; }
      if (top && (comm === 'node' || comm === 'docker')) continue;
      try {
        const m = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${c}/smaps_rollup`, 'utf8'));
        if (m) { total += Number(m[1]); procs++; }
      } catch { /* gone or not readable */ }
      walk(c, false);
    }
  };
  walk(process.pid, true);
  return { kb: total, procs };
}

async function jsHeap(page, browserName) {
  if (browserName !== 'chromium') return null;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Performance.enable');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const v = Object.fromEntries(metrics.map((m) => [m.name, m.value]));
    return { usedMB: Math.round(v.JSHeapUsedSize / 1048576), totalMB: Math.round(v.JSHeapTotalSize / 1048576) };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function run(ctx) {
  for (let rep = 1; rep <= REPEAT; rep++) for (const c of COMBOS) await one(ctx, { ...c, rep });
}

async function one(ctx, combo) {
  {
    const browser = await ctx.launch();
    try {
      const context = await ctx.newContext(browser);
      const blank = await context.newPage();
      await blank.goto('about:blank');
      await ctx.sleep(500);
      const pss0 = browserTreePssKb();
      const t0 = Date.now();
      const app = await ctx.openApp(context, { ...combo.q, fallback: '0', navTimeout: '45000' });
      const initWall = Date.now() - t0;
      await ctx.sleep(500);
      const pssInit = browserTreePssKb();
      ctx.record({ engine: combo.engine, transport: combo.transport, rep: combo.rep, test: `engine host init (cold) #${combo.rep}`, result: 'pass', notes: `${initWall} ms wall (app page load + SW install + both engines); host timings ${JSON.stringify(app.init.timings)}; browser PSS +${mb(pssInit.kb - pss0.kb)} MB`, data: { initWall, timings: app.init.timings } });

      await app.cmd('test.resetStats');
      await app.gnome(() => window.gnomeTest.resetLag());
      const loads = {};
      let tab = 0;
      for (const [name, url] of [['example.com', SITES.example], ['wikipedia', SITES.wikipedia]]) {
        tab++;
        const runs = [];
        for (let i = 0; i < RUNS; i++) {
          const r = await app.navigate(tab, url, { engine: combo.engine, create: i === 0, timeout: 60000 });
          runs.push({ ok: r.ok, ms: r.ms, commitMs: r.committed?.ms ?? null, error: r.ok ? null : r.error });
          if (!r.ok) break;
        }
        loads[name] = runs;
        const ok = runs.length === RUNS && runs.every((r) => r.ok);
        const warm = runs.slice(1).filter((r) => r.ok);
        ctx.record({
          engine: combo.engine, transport: combo.transport, test: `load ${name} #${combo.rep}`,
          result: ok ? 'pass' : 'fail',
          notes: ok
            ? `cold ${runs[0].ms} ms (commit ${runs[0].commitMs}); warm median ${median(warm.map((r) => r.ms))} ms (commit ${median(warm.map((r) => r.commitMs))}) of ${warm.length}`
            : `FAILED: ${JSON.stringify(runs.find((r) => !r.ok)?.error).slice(0, 300)}`,
          data: runs,
        });
      }
      const stats = await app.stats();
      const appLag = await app.gnome(() => window.gnomeTest.lag);
      await ctx.sleep(500);
      const pssEnd = browserTreePssKb();
      const heap = await jsHeap(app.page, ctx.browser);
      const lag = stats.lag;
      ctx.record({
        engine: combo.engine, transport: combo.transport, test: `memory after 2 tabs (example + wikipedia) #${combo.rep}`,
        result: 'pass',
        notes: `browser PSS ${mb(pss0.kb)} MB blank -> ${mb(pssInit.kb)} MB engine host -> ${mb(pssEnd.kb)} MB (${pssEnd.procs} procs)${heap ? `; renderer JS heap ${heap.usedMB}/${heap.totalMB} MB` : ''}`,
        data: { pss0, pssInit, pssEnd, heap },
      });
      ctx.record({
        engine: combo.engine, transport: combo.transport, test: `main-thread blocking during the loads #${combo.rep}`,
        result: 'pass',
        notes: `engine host: long tasks ${ctx.browser === 'chromium' ? `${lag.longTasks} (${lag.longTaskMs} ms total)` : 'n/a (no longtask API)'}, timer lag max ${lag.max} ms, ${lag.over50} stalls > 100 ms; app frame: timer lag max ${Math.round(appLag.max)} ms, ${appLag.over50} stalls > 100 ms`,
        data: { lag, appLag },
      });

      // Warm init: a second engine host in the same profile (SW installed, HTTP cache warm).
      const t1 = Date.now();
      const app2 = await ctx.openApp(context, { ...combo.q, fallback: '0' });
      const warmWall = Date.now() - t1;
      const r2 = await app2.navigate(1, SITES.example, { engine: combo.engine, create: true, timeout: 60000 });
      ctx.record({ engine: combo.engine, transport: combo.transport, rep: combo.rep, test: `engine host init (warm) + first load #${combo.rep}`, result: r2.ok ? 'pass' : 'fail', notes: `init ${warmWall} ms wall, host timings ${JSON.stringify(app2.init.timings)}; example.com ${r2.ok ? `${r2.ms} ms` : JSON.stringify(r2.error)}`, data: { warmWall, timings: app2.init.timings } });
      await context.close();
    } catch (e) {
      ctx.record({ engine: combo.engine, transport: combo.transport, rep: combo.rep, test: `perf #${combo.rep}`, result: 'fail', notes: String(e.stack || e).slice(0, 400) });
    } finally {
      await browser.close();
    }
  }
}
