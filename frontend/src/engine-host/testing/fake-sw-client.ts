/** A SwClient for lane a's tests: control, status and signals scripted by the test. */
import type { SwStatus } from '../../shared/engine-protocol';
import type { HostToSwMessage, SwClient, SwSignal } from '../../shared/proxy-origin';

export class FakeSwClient implements SwClient {
  #status: SwStatus = { controlled: false, build: null, current: false, updateWaiting: false };
  readonly #statusListeners = new Set<(s: SwStatus) => void>();
  readonly #signalListeners = new Set<(s: SwSignal) => void>();
  readonly #controllerListeners = new Set<(c: ServiceWorker) => void>();
  worker: ServiceWorker | null = null;
  failWith: 'insecure_context' | 'sw_timeout' | null = null;
  ensureCalls = 0;
  /** Every message post() was given, in order. */
  readonly posted: HostToSwMessage[] = [];

  async ensureControlled(): Promise<SwStatus> {
    this.ensureCalls++;
    if (this.failWith) throw Object.assign(new Error(`service worker: ${this.failWith}`), { code: this.failWith });
    this.#status = { controlled: true, build: 'dev', current: true, updateWaiting: false };
    for (const l of this.#statusListeners) l(this.status());
    return this.status();
  }

  status(): SwStatus {
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
    return this.worker;
  }

  onControllerChange(listener: (controller: ServiceWorker) => void): () => void {
    this.#controllerListeners.add(listener);
    return () => this.#controllerListeners.delete(listener);
  }

  diagnostics(): { starts: number; held: number; unavailable: number } {
    return { starts: 1, held: 0, unavailable: 0 };
  }

  post(message: HostToSwMessage): void {
    this.posted.push(message);
  }

  /** Test: a signal from the service worker. */
  signal(s: SwSignal): void {
    for (const l of this.#signalListeners) l(s);
  }

  /** Test: another worker took control. */
  changeController(c: ServiceWorker): void {
    this.worker = c;
    for (const l of this.#controllerListeners) l(c);
  }
}
