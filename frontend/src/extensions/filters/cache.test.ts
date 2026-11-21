import { describe, expect, it } from 'vitest';
import type { BlockerGroup, FilterListRef } from '../../shared/engine-protocol';
import { BlockerCache, CACHE_NAME, canonicalJson, importBlockerKey, setComponents, setKey, utcDay } from './cache';
import { MemoryCaches } from './testing';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const ORIGIN = 'http://p.example';
const ref = (id: string, sha: string): FilterListRef => ({ id, sha256: sha.repeat(64), category: 'ads', format: 'abp', trusted: false });
const groups = (n = 100): Array<{ group: BlockerGroup; bytes: ArrayBuffer }> => [
  { group: 'ads', bytes: new Uint8Array(n).fill(7).buffer },
  { group: 'trackers', bytes: new Uint8Array(n / 2).fill(9).buffer },
];
const body = () => ({
  components: [] as unknown[],
  engineVersion: 899,
  sanitizer: 1,
  builtDay: utcDay(Date.UTC(2026, 10, 19)),
  buildMs: 900,
  lists: [],
  resources: null,
  groups: [
    { group: 'ads' as const, network: 3, cosmetic: 1, scriptlets: 0 },
    { group: 'trackers' as const, network: 2, cosmetic: 0, scriptlets: 0 },
  ],
});

async function setup(key = KEY, now = () => Date.UTC(2026, 10, 19, 12)) {
  const caches = new MemoryCaches();
  const c = new BlockerCache({ caches: caches as unknown as CacheStorage, origin: ORIGIN, now }, await importBlockerKey(key));
  return { caches, c };
}

async function stored(refs = [ref('easylist', 'a')]) {
  const s = await setup();
  const components = setComponents(refs, 1);
  const k = await setKey(components);
  expect(await s.c.store(k, { ...body(), components }, groups(), 1 << 20)).toBe('stored');
  return { ...s, k, components };
}

describe('the set key K (§4.3)', () => {
  it('is stable for the same refs in any order and changes with any component', async () => {
    const a = await setKey(setComponents([ref('b', '1'), ref('a', '2')], 1));
    expect(a).toBe(await setKey(setComponents([ref('a', '2'), ref('b', '1')], 1)));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await setKey(setComponents([ref('a', '2'), ref('b', '3')], 1)));
    expect(a).not.toBe(await setKey(setComponents([ref('a', '2'), ref('b', '1')], 2)));
    expect(a).not.toBe(await setKey(setComponents([ref('a', '2'), { ...ref('b', '1'), trusted: true }], 1)));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});

describe('BlockerCache (D6)', () => {
  it('stores and loads a set with day-granular times only', async () => {
    const { c, caches, k, components } = await stored();
    const r = await c.load(k, components);
    expect(r.kind).toBe('hit');
    if (r.kind !== 'hit') return;
    expect(r.groups.map((g) => [g.group, g.bytes.byteLength])).toEqual([
      ['ads', 100],
      ['trackers', 50],
    ]);
    const cache = await caches.open(CACHE_NAME);
    const urls = [...cache.entries.keys()].sort();
    expect(urls).toEqual([`${ORIGIN}/__gnome/blocker/${k}/ads.bin`, `${ORIGIN}/__gnome/blocker/${k}/manifest.json`, `${ORIGIN}/__gnome/blocker/${k}/trackers.bin`]);
    const manifest = await (await cache.match(`${ORIGIN}/__gnome/blocker/${k}/manifest.json`))!.text();
    // no millisecond timestamps (UV pages can read this cache)
    const numbers: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'number') numbers.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(JSON.parse(manifest));
    expect(numbers.length).toBeGreaterThan(5);
    for (const n of numbers) expect(n).toBeLessThan(1e9);
    expect(JSON.parse(manifest)).toMatchObject({ key: k, format: 1, usedDay: utcDay(Date.UTC(2026, 10, 19)) });
  });

  it('refuses a manifest under another key, a flipped byte, usedDay tampering, a missing group and nothing without a key', async () => {
    const { c, caches, k, components } = await stored();
    const cache = await caches.open(CACHE_NAME);
    const mUrl = `${ORIGIN}/__gnome/blocker/${k}/manifest.json`;
    const good = new Map(cache.entries);
    const reset = () => {
      cache.entries.clear();
      for (const [u, e] of good) cache.entries.set(u, e);
    };
    // another blockerKey (a planted set MAC'd by someone else)
    const other = new BlockerCache({ caches: caches as unknown as CacheStorage, origin: ORIGIN, now: Date.now }, await importBlockerKey(OTHER));
    expect((await other.load(k, components)).kind).toBe('rejected');
    reset();
    // one flipped byte in a group
    const ads = cache.entries.get(`${ORIGIN}/__gnome/blocker/${k}/ads.bin`)!;
    const flipped = new Uint8Array(ads.body.slice(0));
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    cache.entries.set(`${ORIGIN}/__gnome/blocker/${k}/ads.bin`, { ...ads, body: flipped.buffer });
    expect((await c.load(k, components)).kind).toBe('rejected');
    expect(cache.entries.size).toBe(0); // deleted
    reset();
    // usedDay rewritten without the key
    const m = JSON.parse(new TextDecoder().decode(good.get(mUrl)!.body)) as Record<string, unknown>;
    cache.entries.set(mUrl, { body: new TextEncoder().encode(JSON.stringify({ ...m, usedDay: 1 })).buffer, type: 'application/json' });
    expect((await c.load(k, components)).kind).toBe('rejected');
    reset();
    cache.entries.delete(`${ORIGIN}/__gnome/blocker/${k}/trackers.bin`);
    expect((await c.load(k, components)).kind).toBe('rejected');
    reset();
    const keyless = new BlockerCache({ caches: caches as unknown as CacheStorage, origin: ORIGIN, now: Date.now }, null);
    expect(await keyless.load(k, components)).toEqual({ kind: 'miss' });
    expect(await keyless.store(k, { ...body(), components }, groups(), 1 << 20)).toBe('disabled');
    expect(await importBlockerKey('AB'.repeat(32))).toBeNull();
    expect(await importBlockerKey('ab')).toBeNull();
  });

  it('refuses a valid older manifest replayed under a newer K, and an ENGINE_VERSION change is a new K', async () => {
    const { c, caches, k: oldK } = await stored([ref('easylist', 'a')]);
    const newComponents = setComponents([ref('easylist', 'b')], 1);
    const newK = await setKey(newComponents);
    const cache = await caches.open(CACHE_NAME);
    for (const [u, e] of [...cache.entries]) cache.entries.set(u.replace(oldK, newK), e);
    expect((await c.load(newK, newComponents)).kind).toBe('rejected');
    expect((await c.load(oldK, setComponents([ref('easylist', 'a')], 1))).kind).toBe('hit');
    const comps = setComponents([ref('easylist', 'a')], 1);
    comps[2] = 900;
    expect(await setKey(comps)).not.toBe(oldK);
  });

  it('re-signs usedDay at most once a day', async () => {
    let now = Date.UTC(2026, 10, 19, 12);
    const caches = new MemoryCaches();
    const c = new BlockerCache({ caches: caches as unknown as CacheStorage, origin: ORIGIN, now: () => now }, await importBlockerKey(KEY));
    const components = setComponents([ref('easylist', 'a')], 1);
    const k = await setKey(components);
    await c.store(k, { ...body(), components }, groups(), 1 << 20);
    now += 3 * 86_400_000;
    const r = await c.load(k, components);
    expect(r.kind === 'hit' && r.manifest.usedDay).toBe(utcDay(now));
    expect((await c.load(k, components)).kind).toBe('hit');
  });

  it('does not cache a set larger than the limit or when a put fails; evicts the least recently used others', async () => {
    const s = await setup();
    const comps = (x: string) => setComponents([ref('l', x)], 1);
    const k1 = await setKey(comps('1'));
    expect(await s.c.store(k1, { ...body(), components: comps('1') }, groups(100), 149)).toBe('over-limit');
    const cache = await s.caches.open(CACHE_NAME);
    cache.failPuts = true;
    expect(await s.c.store(k1, { ...body(), components: comps('1') }, groups(100), 1000)).toBe('failed');
    cache.failPuts = false;
    let day = Date.UTC(2026, 10, 1);
    const c = new BlockerCache({ caches: s.caches as unknown as CacheStorage, origin: ORIGIN, now: () => day }, await importBlockerKey(KEY));
    const keys: string[] = [];
    for (const x of ['1', '2', '3']) {
      const k = await setKey(comps(x));
      keys.push(k);
      expect(await c.store(k, { ...body(), components: comps(x) }, groups(100), 1000)).toBe('stored');
      day += 86_400_000;
    }
    // 150 bytes each: a limit of 320 keeps the current one and the most recently used other.
    await c.evict(keys[0]!, 320);
    expect((await c.load(keys[0]!, comps('1'))).kind).toBe('hit');
    expect((await c.load(keys[2]!, comps('3'))).kind).toBe('hit');
    expect((await c.load(keys[1]!, comps('2'))).kind).toBe('miss');
    expect((await c.usage()).entries).toBe(6);
  });

  it('writes nothing after disable() (site data cleared) and clear() drops everything', async () => {
    const { c, caches, k, components } = await stored();
    c.disable();
    expect(c.enabled).toBe(false);
    expect(await c.store(k, { ...body(), components }, groups(), 1 << 20)).toBe('disabled');
    expect((await c.load(k, components)).kind).toBe('hit'); // reading what is there stays allowed
    await c.clear();
    expect(await caches.has(CACHE_NAME)).toBe(false);
  });
});
