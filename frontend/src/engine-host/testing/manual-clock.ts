/** A deterministic clock for unit tests: timers fire only when the test advances time. */
import type { Clock } from '../coalesce';

export class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Advances time by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.#timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
    }
    this.#now = end;
  }

  get pending(): number {
    return this.#timers.size;
  }
}
