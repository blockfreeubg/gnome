/**
 * The content blocker's cache key (WAVE-B3 D6): 32 random bytes as 64 lower-case hex digits, kept in the app origin's
 * IndexedDB `kv` under `blocker:key:v1` (never on the proxy origin), sent in `init` as `InitPayload.blockerKey`. The
 * engine host MACs the filter data it caches on the proxy origin with it and uses cached data only when the MAC
 * verifies, so a page that writes the proxy origin's Cache Storage cannot plant filters or scriptlets.
 *
 * Created on first use; never synced, never part of a settings export or import (it is not a setting). Replaced when
 * the app sends `siteData.clear` with `storage` or `cache`, when it starts with "clear site data on exit" pending
 * (the new key goes into that `init`), and after a compromise signal: the next engine-host start then rebuilds once,
 * and the per-user MAC a page could read before is gone. Escaped code can read the key (ENGINE-PROTOCOL §1).
 */
import { kvGet, kvSet } from '../../lib/idb';

export const BLOCKER_KEY_KV = 'blocker:key:v1';
const KEY_RE = /^[0-9a-f]{64}$/;

export interface KeyStore {
  get(): Promise<unknown>;
  put(value: string): Promise<void>;
  random(bytes: Uint8Array<ArrayBuffer>): void;
}

const defaultStore: KeyStore = {
  get: () => kvGet<unknown>(BLOCKER_KEY_KV),
  put: (v) => kvSet(BLOCKER_KEY_KV, v),
  random: (b) => {
    crypto.getRandomValues(b);
  },
};

export type RotationReason = 'site-data-cleared' | 'clear-on-start' | 'compromise';

export class BlockerKey {
  readonly #store: KeyStore;
  /** The key in use (memory copy; also what init sends when storage is unavailable). */
  #key: string | null = null;
  #loading: Promise<string> | null = null;
  /** Rotations this app page (diagnostics and tests). */
  readonly rotations: RotationReason[] = [];

  constructor(store: Partial<KeyStore> = {}) {
    this.#store = { ...defaultStore, ...store };
  }

  #fresh(): string {
    const b = new Uint8Array(new ArrayBuffer(32));
    this.#store.random(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  /**
   * The key for `init`: the stored one, else a new one (stored). When storage fails, a key kept in memory for this app
   * page: the blocker then caches under a key no later page knows, which only costs a rebuild.
   */
  get(): Promise<string> {
    if (this.#key) return Promise.resolve(this.#key);
    this.#loading ??= (async () => {
      let stored: unknown;
      try {
        stored = await this.#store.get();
      } catch {
        stored = undefined;
      }
      if (this.#key) return this.#key;
      if (typeof stored === 'string' && KEY_RE.test(stored)) {
        this.#key = stored;
        return stored;
      }
      const key = this.#fresh();
      this.#key = key;
      await this.#store.put(key).catch(() => undefined);
      return key;
    })().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  /** Replaces the key (stored at once; the next engine-host `init` carries it). */
  async rotate(reason: RotationReason): Promise<string> {
    if (this.#loading) await this.#loading.catch(() => undefined);
    const key = this.#fresh();
    this.#key = key;
    this.rotations.push(reason);
    await this.#store.put(key).catch(() => undefined);
    return key;
  }
}
