/**
 * The engine host's half of the Ultraviolet page context (WAVE-B3 D15, §4.5): what it tells the service worker about
 * the UV documents it attached (`docs`: [proxied document URL, real top-level URL]), the UV tab-top navigations it is
 * about to start or saw start (`navs`), the announced ones that were cancelled (`drop`), and everything again after a
 * SW restart (`reset`). Messages stay within BLOCKER_CONTEXT_LIMITS; what it remembers is LRU-bounded.
 */
import { BLOCKER_CONTEXT_LIMITS } from '../../shared/proxy-origin';
import type { HostToSwMessage } from '../../shared/proxy-origin';

const MAX_DOCS = 4096;

export class UvContextSender {
  readonly #post: (m: HostToSwMessage) => void;
  /** proxied document URL → real top-level URL, most recent last. */
  readonly #docs = new Map<string, string>();
  #queued: { docs: Array<[string, string]>; navs: string[]; drop: string[] } = { docs: [], navs: [], drop: [] };
  #scheduled = false;

  constructor(post: (m: HostToSwMessage) => void) {
    this.#post = post;
  }

  #fits(u: string): boolean {
    return u.length > 0 && u.length <= BLOCKER_CONTEXT_LIMITS.urlLength;
  }

  /** A UV document started (its top-level page is known). Batched to the end of the task. */
  doc(proxiedUrl: string, topLevelUrl: string): void {
    if (!this.#fits(proxiedUrl) || !this.#fits(topLevelUrl)) return;
    if (this.#docs.get(proxiedUrl) === topLevelUrl) return;
    this.#docs.delete(proxiedUrl);
    this.#docs.set(proxiedUrl, topLevelUrl);
    while (this.#docs.size > MAX_DOCS) {
      const oldest = this.#docs.keys().next().value;
      if (oldest === undefined) break;
      this.#docs.delete(oldest);
    }
    this.#queued.docs.push([proxiedUrl, topLevelUrl]);
    this.#schedule();
  }

  /** A UV tab-top navigation to `proxiedUrl` is about to start: sent at once (it must beat the fetch). */
  nav(proxiedUrl: string): void {
    if (!this.#fits(proxiedUrl)) return;
    this.#flush();
    this.#post({ type: 'gnome-blocker-context', docs: [], navs: [proxiedUrl], drop: [], reset: false });
  }

  /** An announced navigation was cancelled. */
  drop(proxiedUrl: string): void {
    if (!this.#fits(proxiedUrl)) return;
    this.#queued.drop.push(proxiedUrl);
    this.#schedule();
  }

  /** The SW (re)started: everything this engine host knows, `reset: true` first, then chunks within the limits. */
  reset(): void {
    this.#queued = { docs: [], navs: [], drop: [] };
    const all = [...this.#docs];
    this.#post({ type: 'gnome-blocker-context', docs: all.slice(0, BLOCKER_CONTEXT_LIMITS.docs), navs: [], drop: [], reset: true });
    for (let i = BLOCKER_CONTEXT_LIMITS.docs; i < all.length; i += BLOCKER_CONTEXT_LIMITS.docs) {
      this.#post({ type: 'gnome-blocker-context', docs: all.slice(i, i + BLOCKER_CONTEXT_LIMITS.docs), navs: [], drop: [], reset: false });
    }
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => this.#flush());
  }

  #flush(): void {
    this.#scheduled = false;
    const q = this.#queued;
    this.#queued = { docs: [], navs: [], drop: [] };
    for (let i = 0; i < Math.max(q.docs.length, q.drop.length); i += BLOCKER_CONTEXT_LIMITS.navs) {
      const docs = q.docs.slice(i, i + BLOCKER_CONTEXT_LIMITS.navs);
      const drop = q.drop.slice(i, i + BLOCKER_CONTEXT_LIMITS.navs);
      if (docs.length || drop.length) this.#post({ type: 'gnome-blocker-context', docs, navs: [], drop, reset: false });
    }
  }
}
