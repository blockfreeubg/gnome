import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { settings } from '../../settings/store.svelte';
import { BlockerKey, BLOCKER_KEY_KV, type KeyStore } from './key';

function memory(): KeyStore & { value: unknown; puts: number } {
  let n = 0;
  const m = {
    value: undefined as unknown,
    puts: 0,
    get: async () => m.value,
    put: async (v: string) => {
      m.value = v;
      m.puts++;
    },
    random: (b: Uint8Array<ArrayBuffer>) => {
      for (let i = 0; i < b.length; i++) b[i] = (n * 31 + i * 7) & 0xff;
      n++;
    },
  };
  return m;
}

describe('BlockerKey (WAVE-B3 D6)', () => {
  it('creates a 64-digit lower-case hex key once and keeps it', async () => {
    const store = memory();
    const k = new BlockerKey(store);
    const a = await k.get();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await k.get()).toBe(a);
    expect(store.puts).toBe(1);
    // A later app page reads the same key.
    expect(await new BlockerKey(store).get()).toBe(a);
    expect(store.puts).toBe(1);
  });

  it('replaces a stored value that is not a key', async () => {
    const store = memory();
    store.value = 'ABC';
    const a = await new BlockerKey(store).get();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(store.value).toBe(a);
  });

  it('rotates on site-data clearing, a pending clear on start and a compromise signal', async () => {
    const store = memory();
    const k = new BlockerKey(store);
    const seen = new Set([await k.get()]);
    for (const reason of ['site-data-cleared', 'clear-on-start', 'compromise'] as const) {
      const next = await k.rotate(reason);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      expect(await k.get()).toBe(next);
      expect(store.value).toBe(next);
    }
    expect(k.rotations).toEqual(['site-data-cleared', 'clear-on-start', 'compromise']);
  });

  it('works without storage (a key for this app page only)', async () => {
    const k = new BlockerKey({
      get: async () => {
        throw new Error('no idb');
      },
      put: async () => {
        throw new Error('no idb');
      },
    });
    const a = await k.get();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await k.get()).toBe(a);
  });

  it('uses real crypto and IndexedDB by default, and is never part of a settings export', async () => {
    const k = new BlockerKey();
    const a = await k.get();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const { kvGet } = await import('../../lib/idb');
    expect(await kvGet(BLOCKER_KEY_KV)).toBe(a);
    const exported = settings.export();
    expect(exported).not.toContain(a);
    expect(exported).not.toContain(BLOCKER_KEY_KV);
  });
});
