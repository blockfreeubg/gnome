// `run.mjs --plan` arithmetic: cells × repeats × (warm-up + measured + overhead), plus R1's 10 s waits and S1.
export const CELL_OVERHEAD_S = 1.5;
export const CONFIG_START_S = 3;

/** rows: [{cells, budgeted, unavailable}]; p: {warmup, duration, repeats, budgetedRepeats, gate, s1Runs}. */
export function planSeconds(rows, p, s1 = true, r1 = true) {
  const per = p.warmup + p.duration + CELL_OVERHEAD_S + (p.gate ? 2 : 0);
  let secs = 0;
  for (const r of rows) {
    if (r.unavailable) continue;
    const extra = r.budgeted ? Math.max(0, p.budgetedRepeats - p.repeats) : 0;
    secs += r.cells * p.repeats * per + r.budgeted * extra * per;
    secs += (p.repeats + extra) * CONFIG_START_S + (r1 ? 10 : 0);
  }
  if (s1) secs += 5 * p.s1Runs * 1.5;
  return Math.round(secs);
}
