// Medians, IQR, the significance rule and histogram helpers (docs/WAVE-D.md §3.4).
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function summarize(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return { median: quantile(v, 0.5), min: v[0], max: v.at(-1), iqr: quantile(v, 0.75) - quantile(v, 0.25), n: v.length };
}
/**
 * Significant only when the medians differ by more than max(3 %, the larger IQR as a share of the "before"
 * median). Returns {significant, change} with change = (after - before) / before.
 */
export function significant(before, after) {
  if (!before || !after || !before.median) return { significant: false, change: NaN };
  const change = (after.median - before.median) / before.median;
  const band = Math.max(0.03, Math.max(before.iqr, after.iqr) / Math.abs(before.median));
  return { significant: Math.abs(change) > band, change, band };
}
// The loadgen's log-linear histogram (bench/loadgen/src/hist.rs).
export function lowerBound(idx) {
  if (idx < 32) return idx;
  const e = Math.floor((idx - 32) / 32) + 5;
  return (32 + ((idx - 32) % 32)) * 2 ** (e - 5);
}
export function mergeHists(hists) {
  const out = {};
  for (const h of hists) for (const [k, v] of Object.entries(h ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}
export function histQuantile(h, q) {
  const keys = Object.keys(h).map(Number).sort((a, b) => a - b);
  const n = keys.reduce((a, k) => a + h[k], 0);
  if (!n) return NaN;
  const want = Math.min(n, Math.max(1, Math.ceil(q * n)));
  let seen = 0;
  for (const k of keys) {
    seen += h[k];
    if (seen >= want) return lowerBound(k);
  }
  return NaN;
}
