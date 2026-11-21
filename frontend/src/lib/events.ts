/** Typed event emitter + the app-wide event bus + small DOM listener helpers. */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }

  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>): void {
    this.#listeners.get(type)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[gnome] listener for "${String(type)}" failed`, err);
      }
    }
  }

  listenerCount(type: keyof Events): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

/** Events shared across features. Add new ones here so every team sees the contract. */
export interface AppEvents extends Record<string, unknown> {
  /** The router committed a navigation. */
  'route:changed': { path: string; routeId: string; params: Record<string, string> };
  /** Settings changed locally, from another tab, or from sync. */
  'settings:changed': { origin: 'local' | 'tab' | 'sync' | 'import'; sections: string[] };
  /** POST /api/session answered login_required (accounts mode, signed out). */
  'session:login-required': { message: string };
  /** The anonymous/user session was created or refreshed. */
  'session:changed': { kind: 'anonymous' | 'user'; expiresAt: number };
  /** A BrowserBridge implementation was registered or removed. */
  'bridge:changed': { id: string };
}

export const appEvents = new Emitter<AppEvents>();

/** addEventListener that returns its own remover. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  fn: (ev: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  fn: (ev: DocumentEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  fn: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  fn: (ev: Event) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void;
export function listen(
  target: EventTarget,
  type: string,
  fn: (ev: Event) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Collects disposers and runs them all at once. */
export class Disposables {
  #fns: Array<() => void> = [];
  add(fn: () => void): void {
    this.#fns.push(fn);
  }
  dispose(): void {
    for (const fn of this.#fns.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        console.error('[gnome] dispose failed', err);
      }
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & {
  flush(): void;
  cancel(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = (): void => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const wrapped = (...args: A): void => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return wrapped;
}
