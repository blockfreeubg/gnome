/**
 * The engine host's side of the service worker (WAVE-B §3 lane b; ENGINE-PROTOCOL §2.5; spike §4.4): registration,
 * the explicit apply step for a waiting update, the claim of an uncontrolled load, the build id, and the SW's
 * signals (`Client.postMessage` from our own workers only, validated with parseSwSignal).
 *
 * The apply step: at startup, before any engine exists, when a newer worker is waiting, the host posts
 * `gnome-skip-waiting` to it; it activates only if this is the only engine-host window client (it counts them), and
 * the host waits for `controllerchange`, asking again every SW_TIMEOUTS.applyRetryMs meanwhile (a GNOME tab closed a
 * moment ago can still be counted). Firefox does not apply a waiting worker across a reload by itself (spike §7.13).
 *
 * The background update check: browsers look for a newer `/sw.js` on their own only after some navigations (Chromium
 * found an update only ~1.5 s after the reload that should have applied it, so it stayed waiting: lane c's
 * shell-sw-update e2e). So the host calls `registration.update()` once it is controlled: at once when the active
 * worker is not this build's (`current: false`: the engine host was loaded from a newer deploy, so a newer /sw.js
 * exists), else SW_TIMEOUTS.updateCheckAfterMs later, and then every updateCheckEveryMs. A newer worker installs and
 * waits (the SW neutralizes skipWaiting; the old worker controls this host, so it cannot activate by itself),
 * `updateWaiting` turns true (the app's "GNOME was updated" notice) and the next load applies it. Checking before the
 * host was controlled, at startup, was measured to break Firefox: there an uncontrolled engine host lets the new
 * worker activate by itself while the host claims the old one, which left a redundant controller that never answered
 * (no sw-hello, Scramjet's controller.wait() timed out).
 * Proven in both browsers by the `sw` e2e suite's `update` part (also right after the other GNOME tab closed).
 */

import type { SwStatus } from '../../shared/engine-protocol';
import { PROXY_PATHS, parseSwSignal, type HostToSwMessage, type SwClient, type SwSignal } from '../../shared/proxy-origin';

export const SW_TIMEOUTS = {
  /** register() + `ready` (a first install downloads the vendor scripts it imports). */
  readyMs: 20_000,
  /** The claim of an uncontrolled load (forced reload). */
  claimMs: 5_000,
  /**
   * The background update check (`registration.update()`) runs this long after the engine host started (at once when
   * the active worker is not this build's: then a newer /sw.js is known to exist)...
   */
  updateCheckAfterMs: 3_000,
  /** ...and then this often (a deploy while the user browses is noticed within this time). */
  updateCheckEveryMs: 15 * 60_000,
  /** The waiting worker activates within this long, or it refused (another engine host is open). */
  applyMs: 3_000,
  /**
   * Within applyMs the waiting worker is asked again this often: an engine host that just went away (the other GNOME
   * tab closed a moment ago, or this page's previous engine host during a reload) can still be listed among its
   * clients for a short while, so a single ask was refused in Chromium (lane c's shell-sw-update e2e).
   */
  applyRetryMs: 500,
  /** sw-hello after gnome-hello. */
  helloMs: 2_000,
} as const;

/** The parts of ServiceWorkerContainer / ServiceWorkerRegistration the client uses (fakes implement them in tests). */
export interface SwContainerLike {
  readonly controller: ServiceWorker | null;
  register(url: string, opts: RegistrationOptions): Promise<ServiceWorkerRegistration>;
  readonly ready: Promise<ServiceWorkerRegistration>;
  addEventListener(type: 'message' | 'controllerchange', fn: (e: MessageEvent | Event) => void): void;
}

export interface SwClientDeps {
  container: SwContainerLike | null;
  secureContext: boolean;
  origin: string;
  /** This bundle's build id (__GNOME_BUILD__). */
  build: string;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const fail = (code: 'insecure_context' | 'sw_timeout', message: string): Error => Object.assign(new Error(message), { code });

export class GnomeSwClient implements SwClient {
  readonly #d: SwClientDeps;
  #reg: ServiceWorkerRegistration | null = null;
  #status: SwStatus = { controlled: false, build: null, current: false, updateWaiting: false };
  readonly #statusListeners = new Set<(s: SwStatus) => void>();
  readonly #signalListeners = new Set<(s: SwSignal) => void>();
  readonly #controllerListeners = new Set<(c: ServiceWorker) => void>();
  readonly #controllerWaiters = new Set<() => void>();
  readonly #helloWaiters = new Set<() => void>();
  readonly #starts = new Set<number>();
  #held = 0;
  #unavailable = 0;
  #attached = false;
  #updateChecks = false;
  #pending: Promise<SwStatus> | null = null;

  constructor(deps: SwClientDeps) {
    this.#d = deps;
  }

  ensureControlled(): Promise<SwStatus> {
    this.#pending ??= this.#ensure().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  status(): SwStatus {
    // Read the registration fresh: the updatefound/statechange events can arrive before `waiting` is set (Firefox).
    if (this.#reg && this.#status.controlled) this.#update({ updateWaiting: !!this.#reg.waiting });
    return { ...this.#status };
  }

  onStatus(listener: (status: SwStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onSignal(listener: (signal: SwSignal) => void): () => void {
    this.#signalListeners.add(listener);
    return () => this.#signalListeners.delete(listener);
  }

  controller(): ServiceWorker | null {
    return this.#d.container?.controller ?? null;
  }

  onControllerChange(listener: (controller: ServiceWorker) => void): () => void {
    this.#controllerListeners.add(listener);
    return () => this.#controllerListeners.delete(listener);
  }

  diagnostics(): { starts: number; held: number; unavailable: number } {
    return { starts: this.#starts.size, held: this.#held, unavailable: this.#unavailable };
  }

  /** Engine host → SW message (gnome-blocker-config in Wave B step 3; the others are sent by the client itself). */
  post(message: HostToSwMessage): void {
    this.controller()?.postMessage(message);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

  async #ensure(): Promise<SwStatus> {
    const c = this.#d.container;
    if (!this.#d.secureContext || !c) throw fail('insecure_context', 'service workers need a secure context');
    this.#attach(c);
    const reg = await this.#within(c.register(PROXY_PATHS.serviceWorker, { scope: '/', updateViaCache: 'none' }), SW_TIMEOUTS.readyMs);
    if (!reg) throw fail('sw_timeout', 'the service worker did not register in time');
    this.#watchRegistration(reg);
    const ready = await this.#within(c.ready, SW_TIMEOUTS.readyMs);
    if (!ready) throw fail('sw_timeout', 'the service worker did not activate in time');
    // The apply step: a waiting update activates now if this is the only engine host (the worker decides).
    if (reg.waiting) {
      const changed = this.#nextControllerChange();
      const ask = (): void => reg.waiting?.postMessage({ type: 'gnome-skip-waiting' } satisfies HostToSwMessage);
      ask();
      const retries: unknown[] = [];
      for (let ms = SW_TIMEOUTS.applyRetryMs; ms < SW_TIMEOUTS.applyMs; ms += SW_TIMEOUTS.applyRetryMs) retries.push(this.#d.setTimeout(ask, ms));
      await this.#within(changed, SW_TIMEOUTS.applyMs);
      for (const t of retries) this.#d.clearTimeout(t);
    }
    if (!c.controller) {
      // A forced reload loads the engine host uncontrolled although the SW is active: ask it to claim this client.
      const changed = this.#nextControllerChange();
      (reg.active ?? ready.active)?.postMessage({ type: 'gnome-claim' } satisfies HostToSwMessage);
      await this.#within(changed, SW_TIMEOUTS.claimMs);
      if (!c.controller) throw fail('sw_timeout', 'the service worker did not take control');
    }
    await this.#hello();
    this.#update({ controlled: true, updateWaiting: !!reg.waiting });
    this.#scheduleUpdateChecks(reg);
    return this.status();
  }

  /** The background update check (see the header): once after updateCheckAfterMs, then every updateCheckEveryMs. */
  #scheduleUpdateChecks(reg: ServiceWorkerRegistration): void {
    if (this.#updateChecks || typeof reg.update !== 'function') return;
    this.#updateChecks = true;
    const next = (ms: number): void => {
      this.#d.setTimeout(() => {
        // A newer worker installs and waits; #watchRegistration reports updateWaiting. Errors (offline): next time.
        void Promise.resolve()
          .then(() => reg.update())
          .catch(() => {});
        next(SW_TIMEOUTS.updateCheckEveryMs);
      }, ms);
    };
    next(this.#status.current ? SW_TIMEOUTS.updateCheckAfterMs : 0);
  }

  #attach(c: SwContainerLike): void {
    if (this.#attached) return;
    this.#attached = true;
    c.addEventListener('message', (e) => this.#onMessage(e as MessageEvent));
    c.addEventListener('controllerchange', () => {
      for (const w of [...this.#controllerWaiters]) w();
      const ctl = c.controller;
      this.#update({ controlled: !!ctl, build: null, current: false });
      if (!ctl) return;
      for (const l of this.#controllerListeners) {
        try {
          l(ctl);
        } catch {
          /* a listener's problem stays there */
        }
      }
      void this.#hello();
    });
  }

  #watchRegistration(reg: ServiceWorkerRegistration): void {
    if (this.#reg === reg) return;
    this.#reg = reg;
    const check = (): void => {
      this.#update({ updateWaiting: !!reg.waiting });
      // `waiting` may be set only after the statechange event: look again shortly after.
      for (const ms of [50, 500]) this.#d.setTimeout(() => this.#update({ updateWaiting: !!reg.waiting }), ms);
    };
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', check);
    });
    reg.installing?.addEventListener('statechange', check);
  }

  #onMessage(e: MessageEvent): void {
    const c = this.#d.container;
    // Only our own workers: same origin, sent by a ServiceWorker (proxied pages have no way to post here).
    if (e.origin && e.origin !== this.#d.origin) return;
    const signal = parseSwSignal(e.data);
    if (!signal) return;
    if (signal.type === 'sw-hello') {
      // The build that matters is the controller's (a waiting worker may announce itself too).
      if (!c?.controller || (e.source && e.source !== c.controller)) return;
      this.#starts.add(signal.startedAt);
      this.#update({ build: signal.build, current: signal.build === this.#d.build });
      for (const w of [...this.#helloWaiters]) w();
    } else if (signal.type === 'sw-held') this.#held += 1;
    else if (signal.type === 'sw-unavailable') this.#unavailable += 1;
    for (const l of this.#signalListeners) {
      try {
        l(signal);
      } catch {
        /* ignore */
      }
    }
  }

  async #hello(): Promise<void> {
    const ctl = this.#d.container?.controller;
    if (!ctl) return;
    const answered = new Promise<void>((resolve) => {
      const done = (): void => {
        this.#helloWaiters.delete(done);
        resolve();
      };
      this.#helloWaiters.add(done);
    });
    ctl.postMessage({ type: 'gnome-hello' } satisfies HostToSwMessage);
    await this.#within(answered, SW_TIMEOUTS.helloMs);
  }

  #nextControllerChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.#controllerWaiters.delete(done);
        resolve();
      };
      this.#controllerWaiters.add(done);
    });
  }

  /** Resolves with the value, or undefined after `ms`. */
  #within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const t = this.#d.setTimeout(() => resolve(undefined), ms);
      p.then(
        (v) => {
          this.#d.clearTimeout(t);
          resolve(v);
        },
        (err) => {
          this.#d.clearTimeout(t);
          reject(err);
        },
      );
    });
  }

  #update(patch: Partial<SwStatus>): void {
    const next = { ...this.#status, ...patch };
    if (
      next.controlled === this.#status.controlled &&
      next.build === this.#status.build &&
      next.current === this.#status.current &&
      next.updateWaiting === this.#status.updateWaiting
    )
      return;
    this.#status = next;
    for (const l of this.#statusListeners) {
      try {
        l(this.status());
      } catch {
        /* ignore */
      }
    }
  }
}
