/**
 * Wisp tickets for the engine host (ENGINE-PROTOCOL §6.5, ARCHITECTURE §4.6): the app mints them with
 * `POST /api/wisp/ticket` and hands them over in `init` and with the `ticket` command.
 *
 * - At most one mint per TICKET.appMinIntervalMs and TICKET.appMaxPerMinute per rolling minute (the server allows 30
 *   per minute per session). A request inside those limits is deferred and coalesced with any other pending one,
 *   never dropped: with short TTLs a dropped renewal left the transports without a valid ticket (spike §12).
 * - A `429` waits its `Retry-After` and then tries again for everyone waiting.
 * - Mints an engine event started (`needTicket`, a status with `ticket-missing`) are non-interactive: they never
 *   prompt for the access code or the sign-in (§1.2 rule 9); a `login_required` / `access_code_required` answer is
 *   reported as `credentials` so the browser view can show its passive notice. Only a gesture in GNOME's own UI
 *   makes an interactive mint.
 * - `Ticket.expiresAt` is on this browser's clock: ticketExpiresAtLocal() with the response's `Date` header.
 */
import { TICKET, ticketExpiresAtLocal, type Ticket } from '../../shared/engine-protocol';
import { isApiError, type WispTicket } from '../../lib/api';
import { systemClock, type Clock } from './client';

export type MintOutcome =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: 'credentials'; kind: 'login' | 'access-code'; message: string }
  | { ok: false; reason: 'error'; message: string };

export interface TicketMinterDeps {
  mint(opts: { interactive: boolean }): Promise<WispTicket>;
  /** `/api/config` → wisp.ticket_ttl_s · 1000 (caps the life the app computes). */
  ttlMs(): number;
  clock?: Clock;
}

interface Waiter {
  resolve(o: MintOutcome): void;
}

interface Batch {
  interactive: boolean;
  waiters: Waiter[];
}

export class TicketMinter {
  readonly #deps: TicketMinterDeps;
  readonly #clock: Clock;
  /** Start times of recent mints (rolling minute). */
  readonly #times: number[] = [];
  #blockedUntil = 0;
  #inflight: Batch | null = null;
  #queued: Batch | null = null;
  #timer: unknown = null;
  /** Mints actually sent (diagnostics, tests). */
  sent = 0;

  constructor(deps: TicketMinterDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * Asks for a ticket. Coalesces with a mint in flight (unless this one is interactive and that one is not: it might
   * need the prompt the other may not show) or with a queued one.
   */
  request(interactive: boolean): Promise<MintOutcome> {
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve };
      if (this.#inflight && (!interactive || this.#inflight.interactive)) {
        this.#inflight.waiters.push(waiter);
        return;
      }
      if (this.#queued) {
        this.#queued.interactive ||= interactive;
        this.#queued.waiters.push(waiter);
      } else {
        this.#queued = { interactive, waiters: [waiter] };
      }
      this.#schedule();
    });
  }

  /** When the next mint may start (Unix ms on the injected clock). */
  nextAllowedAt(): number {
    const now = this.#clock.now();
    while (this.#times.length && (this.#times[0] ?? 0) <= now - 60_000) this.#times.shift();
    let at = Math.max(now, this.#blockedUntil);
    const last = this.#times.at(-1);
    if (last !== undefined) at = Math.max(at, last + TICKET.appMinIntervalMs);
    if (this.#times.length >= TICKET.appMaxPerMinute) at = Math.max(at, (this.#times[this.#times.length - TICKET.appMaxPerMinute] ?? 0) + 60_000);
    return at;
  }

  #schedule(): void {
    if (this.#inflight || !this.#queued || this.#timer !== null) return;
    const delay = this.nextAllowedAt() - this.#clock.now();
    if (delay <= 0) {
      this.#run();
      return;
    }
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      this.#schedule();
    }, delay);
  }

  #run(): void {
    const batch = this.#queued;
    if (!batch) return;
    this.#queued = null;
    this.#inflight = batch;
    const startedAt = this.#clock.now();
    this.#times.push(startedAt);
    this.sent++;
    void this.#deps
      .mint({ interactive: batch.interactive })
      .then((t): MintOutcome => {
        const receivedAt = this.#clock.now();
        return {
          ok: true,
          ticket: { value: t.ticket, wispUrl: t.wispUrl, expiresAt: ticketExpiresAtLocal(t.expiresAt, t.date, receivedAt, this.#deps.ttlMs()) },
        };
      })
      .catch((err: unknown): MintOutcome | 'retry' => {
        if (isApiError(err, 'rate_limited')) {
          this.#blockedUntil = Math.max(this.#blockedUntil, this.#clock.now() + Math.max(1, err.retryAfterS ?? 5) * 1000);
          return 'retry';
        }
        if (isApiError(err, 'login_required')) return { ok: false, reason: 'credentials', kind: 'login', message: err.message };
        if (isApiError(err, 'access_code_required')) return { ok: false, reason: 'credentials', kind: 'access-code', message: err.message };
        return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'Could not get a ticket.' };
      })
      .then((outcome) => {
        this.#inflight = null;
        if (outcome === 'retry') {
          // Everyone waiting tries again after Retry-After: a 429 never drops a request.
          if (this.#queued) {
            this.#queued.interactive ||= batch.interactive;
            this.#queued.waiters.unshift(...batch.waiters);
          } else this.#queued = batch;
        } else {
          for (const w of batch.waiters) w.resolve(outcome);
        }
        this.#schedule();
      });
  }

  dispose(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
