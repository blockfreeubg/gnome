/**
 * Per-tab throttling of latest-value events (ENGINE-PROTOCOL §5 "Coalescing", COALESCE_MS): the first value of a
 * quiet interval goes out at once, later ones are held and only the newest is sent when the interval ends; before
 * an event of the same scope (tab, download) that is not coalesced is sent, that scope's held values go out first (in
 * the order they were held), so the order per tab is kept. Latest values of different types are independent of each
 * other and keep their own intervals. `tab.committed` is coalesced only for same-document `replace` commits (pushes and cross-document commits
 * are entries and are never merged). `status` (port scope) is throttled the same way at 200 ms: it has no app-side
 * coalescing rule, but a burst of transport changes must not reach its bucket limit. Pure: the clock is injected.
 */
import { COALESCE_MS } from '../shared/engine-protocol';
import type { EventMap, EventType } from '../shared/engine-protocol';

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Send = <T extends EventType>(type: T, p: EventMap[T]) => void;

/** Interval per coalesced event type (COALESCE_MS plus the port-scoped `status` throttle). */
const INTERVALS: Readonly<Partial<Record<EventType, number>>> = { ...COALESCE_MS, status: 200 };

/** The scope an event is ordered and throttled in: its tab, its download, or the port. */
export function scopeOf(type: EventType, p: unknown): string {
  const o = p as Record<string, unknown>;
  if (type === 'download.progress' || type === 'download.done') return `download:${String(o.downloadId)}`;
  if (type === 'tab.openRequest') return `tab:${String(o.openerTabId)}`;
  if (typeof o.tabId === 'number') return `tab:${o.tabId}`;
  return 'port';
}

/** Whether this event is a latest value that may be merged with the next one of its type and scope. */
export function isCoalesced(type: EventType, p: unknown): boolean {
  if (!(type in INTERVALS)) return false;
  // A navigation announcement (WAVE-B3 C3): the app answers it with the site's rules before the page loads.
  if (type === 'tab.loading') return (p as EventMap['tab.loading']).url === undefined;
  if (type !== 'tab.committed') return true;
  const c = p as EventMap['tab.committed'];
  return c.kind === 'same-document' && c.historyHandling === 'replace';
}

interface Slot {
  type: EventType;
  scope: string;
  /** Held value (the newest), sent when the interval ends; `seq` orders held values of one scope. */
  pending: { p: unknown; seq: number } | null;
  timer: unknown;
}

export class Coalescer {
  readonly #send: Send;
  readonly #clock: Clock;
  /** Active intervals by `${type}|${scope}`, in the order their values were first held (Map order). */
  readonly #slots = new Map<string, Slot>();
  #seq = 0;

  constructor(send: Send, clock: Clock = realClock) {
    this.#send = send;
    this.#clock = clock;
  }

  emit<T extends EventType>(type: T, p: EventMap[T]): void {
    const scope = scopeOf(type, p);
    if (!isCoalesced(type, p)) {
      this.flush(scope);
      this.#send(type, p);
      return;
    }
    const key = `${type}|${scope}`;
    const slot = this.#slots.get(key);
    if (slot) {
      slot.pending = { p, seq: ++this.#seq };
      return;
    }
    this.#send(type, p);
    this.#startInterval({ type, scope, pending: null, timer: null }, key);
  }

  /** Sends every held value of `scope` now (in the order they were held); their intervals keep running. */
  flush(scope: string): void {
    const held = [...this.#slots.values()].filter((s) => s.scope === scope && s.pending);
    held.sort((a, b) => (a.pending?.seq ?? 0) - (b.pending?.seq ?? 0));
    for (const slot of held) {
      const p = slot.pending?.p;
      slot.pending = null;
      this.#send(slot.type, p as never);
    }
  }

  /** Drops held values and intervals of a scope (a closed tab, a finished download). */
  forget(scope: string): void {
    for (const [key, slot] of this.#slots) {
      if (slot.scope !== scope) continue;
      this.#clock.clearTimeout(slot.timer);
      this.#slots.delete(key);
    }
  }

  /** Sends everything held, in order, and stops all intervals. */
  drain(): void {
    const held = [...this.#slots.values()].filter((s) => s.pending);
    held.sort((a, b) => (a.pending?.seq ?? 0) - (b.pending?.seq ?? 0));
    for (const slot of this.#slots.values()) this.#clock.clearTimeout(slot.timer);
    this.#slots.clear();
    for (const slot of held) this.#send(slot.type, slot.pending?.p as never);
  }

  get size(): number {
    return this.#slots.size;
  }

  #startInterval(slot: Slot, key: string): void {
    const ms = INTERVALS[slot.type] ?? 0;
    slot.timer = this.#clock.setTimeout(() => this.#intervalEnd(key, slot), ms);
    this.#slots.set(key, slot);
  }

  #intervalEnd(key: string, slot: Slot): void {
    if (this.#slots.get(key) !== slot) return;
    if (!slot.pending) {
      this.#slots.delete(key);
      return;
    }
    const { p } = slot.pending;
    slot.pending = null;
    // Latest values of different types are independent: only events that are not coalesced flush the others, so
    // each type stays at one value per interval.
    this.#send(slot.type, p as never);
    this.#startInterval(slot, key);
  }
}
