/**
 * The blocker cache in Cache Storage on the proxy origin (WAVE-B3 §4.3, D6), engine host only. Proxied pages can read
 * and write this storage (UV hooks neither `caches` nor `CacheStorage`; Scramjet does not prefix `keys()`), so a set is
 * used only when its manifest's HMAC-SHA-256 under the app's `blockerKey` verifies, the manifest names exactly the set
 * key K being loaded (with the same components: an older, validly MAC'd set replayed under a newer K is refused) and
 * every group's bytes hash to the manifest's SHA-256. Times are whole UTC days (no millisecond timestamps a page could
 * read). The service worker never reads this cache.
 */
import type { BlockerGroup, BlockerListStats, FilterListRef } from '../../shared/engine-protocol';
import { BLOCKER_GROUPS } from '../../shared/engine-protocol';
import { ADBLOCKER_ENGINE_VERSION, BLOCKER_FORMAT } from '../core/version';
import { ENGINE_CONFIG_ID } from './config';
import { hex } from './lists';

export const CACHE_NAME = `gnome-blocker-v${BLOCKER_FORMAT}`;
const PREFIX = '/__gnome/blocker/';
const DAY_MS = 86_400_000;

export interface ManifestGroup {
  group: BlockerGroup;
  bytes: number;
  sha256: string;
  network: number;
  cosmetic: number;
  scriptlets: number;
}

export interface Manifest {
  format: number;
  key: string;
  components: unknown[];
  engineVersion: number;
  sanitizer: number;
  builtDay: number;
  buildMs: number;
  usedDay: number;
  groups: ManifestGroup[];
  lists: BlockerListStats[];
  resources: { redirects: number; scriptlets: number; sha256: string } | null;
  mac: string;
}

/** JSON with object keys sorted at every level (the MAC and K are computed over it). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** What K hashes (§4.3): the format, the library's ENGINE_VERSION, the sanitizer's version, the config id, the refs. */
export function setComponents(refs: readonly FilterListRef[], sanitizerVersion: number): unknown[] {
  const sorted = [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ['gnome-blocker', BLOCKER_FORMAT, ADBLOCKER_ENGINE_VERSION, sanitizerVersion, ENGINE_CONFIG_ID, sorted.map((r) => [r.id, r.sha256, r.category, r.format, r.trusted])];
}

export async function sha256Of(data: BufferSource | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** The set key K: lower-case hex SHA-256 of the canonical JSON of the components. */
export async function setKey(components: unknown[]): Promise<string> {
  return sha256Of(canonicalJson(components));
}

export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** The app's 64-hex-digit blockerKey as an HMAC-SHA-256 key (null for anything else: nothing is cached then). */
export async function importBlockerKey(key: string | null): Promise<CryptoKey | null> {
  if (key === null || !/^[0-9a-f]{64}$/.test(key)) return null;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface CacheDeps {
  caches: CacheStorage;
  /** The proxy origin (synthetic URLs under it; the server never serves them). */
  origin: string;
  now(): number;
}

export type LoadResult =
  | { kind: 'hit'; manifest: Manifest; groups: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> }
  /** Nothing cached under K. */
  | { kind: 'miss' }
  /** Something was cached under K but did not verify (deleted). */
  | { kind: 'rejected' };

export type StoreResult = 'stored' | 'over-limit' | 'failed' | 'disabled';

const fromHex = (h: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};

function isManifest(v: unknown): v is Manifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.format === 'number' &&
    typeof m.key === 'string' &&
    Array.isArray(m.components) &&
    typeof m.mac === 'string' &&
    /^[0-9a-f]{64}$/.test(m.mac) &&
    Array.isArray(m.groups) &&
    Array.isArray(m.lists) &&
    typeof m.usedDay === 'number' &&
    typeof m.builtDay === 'number' &&
    typeof m.buildMs === 'number' &&
    (m.groups as unknown[]).every(
      (g) =>
        typeof g === 'object' &&
        g !== null &&
        BLOCKER_GROUPS.includes((g as ManifestGroup).group) &&
        typeof (g as ManifestGroup).sha256 === 'string' &&
        typeof (g as ManifestGroup).bytes === 'number',
    )
  );
}

export class BlockerCache {
  readonly #d: CacheDeps;
  readonly #key: CryptoKey | null;
  #disabled = false;

  constructor(deps: CacheDeps, key: CryptoKey | null) {
    this.#d = deps;
    this.#key = key;
  }

  /** Whether this engine host may read and write the cache (a key, and site data not cleared this session). */
  get enabled(): boolean {
    return this.#key !== null && !this.#disabled;
  }

  /** siteData.clear deleted Cache Storage: write nothing more for the rest of this engine host's life (§4.3). */
  disable(): void {
    this.#disabled = true;
  }

  #url(k: string, name: string): string {
    return `${this.#d.origin}${PREFIX}${k}/${name}`;
  }

  async #mac(body: Omit<Manifest, 'mac'>): Promise<string> {
    if (!this.#key) throw new Error('no key');
    return hex(await crypto.subtle.sign('HMAC', this.#key, new TextEncoder().encode(canonicalJson(body))));
  }

  async #verify(m: Manifest): Promise<boolean> {
    if (!this.#key) return false;
    const { mac, ...body } = m;
    return crypto.subtle.verify('HMAC', this.#key, fromHex(mac), new TextEncoder().encode(canonicalJson(body)));
  }

  async #open(): Promise<Cache> {
    return this.#d.caches.open(CACHE_NAME);
  }

  async #deleteSet(cache: Cache, k: string): Promise<void> {
    for (const req of await cache.keys()) {
      if (new URL(req.url).pathname.startsWith(`${PREFIX}${k}/`)) await cache.delete(req);
    }
  }

  /** Loads the set K (§4.3 "Load"); anything that does not verify is deleted and reported as `rejected`. */
  async load(k: string, components: unknown[]): Promise<LoadResult> {
    if (!this.#key) return { kind: 'miss' };
    let cache: Cache;
    try {
      if (!(await this.#d.caches.has(CACHE_NAME))) return { kind: 'miss' };
      cache = await this.#open();
    } catch {
      return { kind: 'miss' };
    }
    const res = await cache.match(this.#url(k, 'manifest.json')).catch(() => undefined);
    if (!res) {
      // Group entries without a manifest are leftovers (or planted): gone.
      await this.#deleteSet(cache, k).catch(() => undefined);
      return { kind: 'miss' };
    }
    const reject = async (): Promise<LoadResult> => {
      await this.#deleteSet(cache, k).catch(() => undefined);
      return { kind: 'rejected' };
    };
    let manifest: unknown;
    try {
      manifest = JSON.parse(await res.text());
    } catch {
      return reject();
    }
    if (!isManifest(manifest) || !(await this.#verify(manifest).catch(() => false))) return reject();
    if (manifest.key !== k || manifest.format !== BLOCKER_FORMAT || canonicalJson(manifest.components) !== canonicalJson(components)) return reject();
    const groups: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> = [];
    for (const g of manifest.groups) {
      const r = await cache.match(this.#url(k, `${g.group}.bin`)).catch(() => undefined);
      if (!r) return reject();
      const bytes = await r.arrayBuffer();
      // Hash exactly the buffer that will be deserialized.
      if (bytes.byteLength !== g.bytes || (await sha256Of(bytes)) !== g.sha256) return reject();
      groups.push({ group: g.group, bytes });
    }
    // usedDay at most once a day (it is covered by the MAC, so the manifest is re-signed).
    const today = utcDay(this.#d.now());
    if (manifest.usedDay !== today && this.enabled) {
      const { mac: _mac, ...body } = manifest;
      const next = { ...body, usedDay: today };
      try {
        await cache.put(this.#url(k, 'manifest.json'), jsonResponse({ ...next, mac: await this.#mac(next) }));
        manifest = { ...next, mac: '' } as Manifest;
      } catch {
        /* the old usedDay stays */
      }
    }
    return { kind: 'hit', manifest: manifest as Manifest, groups };
  }

  /**
   * Stores a built set (§4.3 "Size"): not when it alone exceeds `limitBytes` or the put fails (quota); afterwards
   * the most recently used other sets are kept while the total fits.
   */
  async store(
    k: string,
    body: Omit<Manifest, 'mac' | 'groups' | 'key' | 'format' | 'usedDay'> & { groups: Array<Omit<ManifestGroup, 'sha256' | 'bytes'>> },
    groups: ReadonlyArray<{ group: BlockerGroup; bytes: ArrayBuffer }>,
    limitBytes: number,
  ): Promise<StoreResult> {
    if (!this.enabled) return 'disabled';
    const total = groups.reduce((n, g) => n + g.bytes.byteLength, 0);
    if (total > limitBytes) return 'over-limit';
    try {
      const mg: ManifestGroup[] = [];
      for (const g of groups) {
        const info = body.groups.find((x) => x.group === g.group);
        mg.push({ group: g.group, bytes: g.bytes.byteLength, sha256: await sha256Of(g.bytes), network: info?.network ?? 0, cosmetic: info?.cosmetic ?? 0, scriptlets: info?.scriptlets ?? 0 });
      }
      const manifestBody: Omit<Manifest, 'mac'> = { ...body, format: BLOCKER_FORMAT, key: k, usedDay: utcDay(this.#d.now()), groups: mg };
      const cache = await this.#open();
      await this.#deleteSet(cache, k);
      for (const g of groups) {
        await cache.put(this.#url(k, `${g.group}.bin`), new Response(g.bytes, { headers: { 'content-type': 'application/octet-stream' } }));
      }
      // The manifest last: a set without it is never used.
      await cache.put(this.#url(k, 'manifest.json'), jsonResponse({ ...manifestBody, mac: await this.#mac(manifestBody) }));
    } catch {
      await this.#open()
        .then((c) => this.#deleteSet(c, k))
        .catch(() => undefined);
      return 'failed';
    }
    await this.evict(k, limitBytes).catch(() => undefined);
    return 'stored';
  }

  /** Keeps `current` plus the most recently used verified sets while the total fits; deletes everything else. */
  async evict(current: string, limitBytes: number): Promise<void> {
    if (!this.enabled) return;
    const cache = await this.#open();
    const sets = new Map<string, Request[]>();
    for (const req of await cache.keys()) {
      const m = /^\/__gnome\/blocker\/([0-9a-f]{64})\/[a-z]+\.(?:json|bin)$/.exec(new URL(req.url).pathname);
      if (!m) {
        await cache.delete(req);
        continue;
      }
      const list = sets.get(m[1] as string) ?? [];
      list.push(req);
      sets.set(m[1] as string, list);
    }
    const ranked: Array<{ k: string; usedDay: number; bytes: number }> = [];
    for (const [k, reqs] of sets) {
      const res = await cache.match(this.#url(k, 'manifest.json'));
      let m: unknown = null;
      try {
        m = res ? JSON.parse(await res.text()) : null;
      } catch {
        m = null;
      }
      if (!isManifest(m) || m.key !== k || !(await this.#verify(m).catch(() => false))) {
        for (const r of reqs) await cache.delete(r);
        continue;
      }
      ranked.push({ k, usedDay: k === current ? Number.MAX_SAFE_INTEGER : m.usedDay, bytes: m.groups.reduce((n, g) => n + g.bytes, 0) });
    }
    ranked.sort((a, b) => b.usedDay - a.usedDay);
    let total = 0;
    for (const s of ranked) {
      if (total + s.bytes <= limitBytes) {
        total += s.bytes;
        continue;
      }
      await this.#deleteSet(cache, s.k);
    }
  }

  /** blocker.reload: every cached set is dropped. */
  async clear(): Promise<void> {
    await this.#d.caches.delete(CACHE_NAME).catch(() => false);
  }

  /** What is cached (for blocker.stats), whether or not it verifies. */
  async usage(): Promise<{ bytes: number; entries: number }> {
    try {
      if (!(await this.#d.caches.has(CACHE_NAME))) return { bytes: 0, entries: 0 };
      const cache = await this.#open();
      let bytes = 0;
      let entries = 0;
      for (const req of await cache.keys()) {
        const r = await cache.match(req);
        if (!r) continue;
        entries++;
        bytes += (await r.arrayBuffer()).byteLength;
      }
      return { bytes, entries };
    } catch {
      return { bytes: 0, entries: 0 };
    }
  }
}

function jsonResponse(v: unknown): Response {
  return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
}
