// Lane a: performance of the built engine host on the real stack (port of the spike's `perf` suite, WAVE-B §10 "The
// perf suite"): per engine × transport, engine-host init (InitResult.timings), the load time of example.com (cold =
// the first load in a fresh browser, warm = median of the next loads in the same tab) and of Wikipedia, the engine
// host's main-thread lag and long tasks (`diagnostics`) and, in Chromium, its JS heap. Real sites over the direct
// route (HolyWisp → the internet). These are measurements, recorded as `pass` when every load succeeded; the numbers
// are the result. HOST_PERF_RUNS (default 4) loads per site.
import { SITES } from '../lib/config.mjs';

const COMBOS = [
  ['scramjet', 'libcurl'],
  ['scramjet', 'epoxy'],
  ['ultraviolet', 'libcurl'],
  ['ultraviolet', 'epoxy'],
];
const RUNS = Math.max(2, Number(process.env.HOST_PERF_RUNS) || 4);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

export async function run(ctx) {
  for (const [engine, transport] of COMBOS) {
    const browser = await ctx.launch();
    try {
      const context = await ctx.newContext(browser);
      const app = await ctx.openApp(context, { engine, transport, fallback: '0' });
      const init = app.init?.timings;
      const loads = { example: [], wikipedia: [] };
      let failures = 0;
      let tab = 1;
      for (const [site, url] of [
        ['example', SITES.example],
        ['wikipedia', SITES.wikipedia],
      ]) {
        const id = tab++;
        for (let i = 0; i < RUNS; i++) {
          const r = await app.navigate(id, url, { engine, create: i === 0, timeout: 60000 });
          if (r.ok) loads[site].push(r.ms);
          else failures++;
        }
      }
      const diag = await app.cmd('diagnostics', {});
      const notes = [
        `init total ${init?.totalMs} ms (sw ${init?.swReadyMs}, scramjet ${init?.scramjetMs}, ultraviolet ${init?.ultravioletMs})`,
        `example.com cold ${loads.example[0] ?? '-'} ms, warm median ${median(loads.example.slice(1)) ?? '-'} ms`,
        `Wikipedia cold ${loads.wikipedia[0] ?? '-'} ms, warm median ${median(loads.wikipedia.slice(1)) ?? '-'} ms`,
        `main thread max lag ${diag.mainThread.maxLagMs} ms, long tasks ${diag.mainThread.longTasks} (${diag.mainThread.longTaskMs} ms)`,
        diag.memory ? `JS heap ${Math.round(diag.memory.usedJSHeapSize / 1048576)} MiB` : 'JS heap n/a',
        `failed loads ${failures}`,
      ];
      ctx.record({ test: 'perf:real-sites', engine, transport, result: failures === 0 ? 'pass' : 'fail', notes: notes.join('; ') });
      await app.close();
      await context.close();
    } finally {
      await browser.close();
    }
  }
}
