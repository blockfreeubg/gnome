/**
 * Main-thread health for `diagnostics` (ENGINE-PROTOCOL §6.18): the worst lag of a 50 ms interval timer and, where
 * the browser reports them (Chromium: PerformanceObserver.supportedEntryTypes has `longtask`), long tasks. Counters
 * only.
 */
export class LagMonitor {
  #max = 0;
  #longTasks = 0;
  #longTaskMs = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.#timer !== null) return;
    let last = performance.now();
    this.#timer = setInterval(() => {
      const t = performance.now();
      const lag = t - last - 50;
      if (lag > this.#max) this.#max = lag;
      last = t;
    }, 50);
    // Only where the browser has long-task entries (Chromium): Firefox logs "Ignoring unsupported entryTypes:
    // longtask" for an observe() of an entry type it lacks (worklist A8).
    if (!(globalThis.PerformanceObserver?.supportedEntryTypes ?? []).includes('longtask')) return;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.#longTasks++;
          this.#longTaskMs += e.duration;
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* not observable after all */
    }
  }

  reset(): void {
    this.#max = 0;
    this.#longTasks = 0;
    this.#longTaskMs = 0;
  }

  snapshot(): { maxLagMs: number; longTasks: number; longTaskMs: number } {
    return { maxLagMs: Math.round(this.#max), longTasks: this.#longTasks, longTaskMs: Math.round(this.#longTaskMs) };
  }
}
