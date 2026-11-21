/**
 * Which service-worker clients are engine hosts (WAVE-B3 §4.5, finding F3). Step 2 trusted any window client whose
 * URL path is `/engine/`; a UV page can `pushState` its own URL to `/engine/?x` (from an about:blank child realm UV
 * never hooked) and then pass. Here a client counts as an engine host only when:
 *  - its navigation fetch (`mode: 'navigate'`) to exactly `/engine/` created it (`resultingClientId`), or
 *  - it loaded before this SW controlled it or before the SW (re)started (so no navigation was seen), its URL path is
 *    `/engine/`, and it was never seen as a proxied document or worker.
 * Every client a `/uv/` or `/~/sj/` navigation or worker script created is `proxied` and never an engine host, also
 * when its URL later says `/engine/`. Residual (row A3b; §11.1): right after a SW restart a UV page that made no request
 * since passes by URL, and a page that reaches a native realm (F2) can start a real `/engine/` document. DOM-free.
 */

const PROXIED_MAX = 8192;

export class EngineHostRegistry {
  readonly #hosts = new Set<string>();
  /** LRU of proxied clients (documents and workers). */
  readonly #proxied = new Map<string, true>();

  /** A navigation fetch created `clientId` for `path` (the URL's pathname). */
  navigation(clientId: string, path: string, engineHostPath: string, proxied: boolean): void {
    if (!clientId) return;
    if (proxied) {
      this.markProxied(clientId);
      return;
    }
    if (path === engineHostPath && !this.#proxied.has(clientId)) this.#hosts.add(clientId);
  }

  /** A proxied document or worker (its resultingClientId). */
  markProxied(clientId: string): void {
    if (!clientId) return;
    this.#hosts.delete(clientId);
    this.#proxied.delete(clientId);
    this.#proxied.set(clientId, true);
    while (this.#proxied.size > PROXIED_MAX) {
      const oldest = this.#proxied.keys().next().value;
      if (oldest === undefined) break;
      this.#proxied.delete(oldest);
    }
  }

  /**
   * Whether a message from this client counts. `urlIsEngineHost`: its Client.url path is `/engine/` (on this
   * origin); such a client that was never seen as proxied is registered provisionally (it loaded before this SW).
   */
  accept(clientId: string, urlIsEngineHost: boolean): boolean {
    if (!clientId) return false;
    if (this.#hosts.has(clientId)) return true;
    if (this.#proxied.has(clientId) || !urlIsEngineHost) return false;
    this.#hosts.add(clientId);
    return true;
  }

  /** Whether signals go to this client (registered hosts only; a provisional one once it said hello). */
  isHost(clientId: string): boolean {
    return this.#hosts.has(clientId);
  }

  isProxied(clientId: string): boolean {
    return this.#proxied.has(clientId);
  }

  forget(clientId: string): void {
    this.#hosts.delete(clientId);
  }

  hosts(): string[] {
    return [...this.#hosts];
  }
}
