// The engine host's composition root with the real engines module and cache code, a fake Worker build (the real
// group build of build.ts in-process), an in-memory CacheStorage and fake timers.
import { describe, expect, it } from 'vitest';
import type { BlockerStatus, EngineSettings, FilterListRef } from '../../shared/engine-protocol';
import type { HostToSwMessage } from '../../shared/proxy-origin';
import type { RequestInfo } from '../../shared/engine-hooks';
import { SW_FALLBACK_SETTINGS } from '../core/policy';
import type { BlockerSettings } from '../core/policy';
import { sanitizeList, trustOnlyScriptlets } from '../core/sanitize';
import { preprocessorEnv } from '../filters/config';
import { MemoryCaches } from '../filters/testing';
import type { BuildOutcome } from '../filters/worker-client';
import { buildEngines } from '../worker/build';
import type { GroupOutput } from '../worker/build';
import { createBlocker } from './blocker';
import type { BlockerInternals } from './blocker';

const KEY = '12'.repeat(32);
const ref = (id: string, sha: string, category: FilterListRef['category'] = 'ads'): FilterListRef => ({ id, sha256: sha.repeat(64), category, format: 'abp', trusted: false });

async function realBuild(text: string, lists: FilterListRef[]): Promise<BuildOutcome> {
  const out: GroupOutput[] = [];
  const r = await buildEngines(
    lists.map((l) => ({ ok: true as const, ref: l, text, bytes: text.length })),
    null,
    { sanitize: sanitizeList, trustOnly: trustOnlyScriptlets, validate: async () => [], onGroup: (g) => out.push(g), env: preprocessorEnv('chromium') },
  );
  return { kind: 'built', groups: out, lists: r.lists, resources: r.resources, buildMs: 5 };
}

function harness(opts: { build?: (refs: FilterListRef[]) => Promise<BuildOutcome>; caches?: MemoryCaches; uv?: boolean } = {}) {
  const posted: HostToSwMessage[] = [];
  const counted: Array<[number | null, string, string | undefined]> = [];
  const timers: Array<{ fn: () => void; ms: number; done: boolean }> = [];
  let statusChanges = 0;
  let builds = 0;
  const caches = opts.caches ?? new MemoryCaches();
  let full: EngineSettings | null = null;
  const internals: Partial<BlockerInternals> = {
    importEngines: () => import('../filters/engines'),
    build: async (refs) => {
      builds++;
      return opts.build ? opts.build(refs) : realBuild('||ads.localhost^\n', refs);
    },
    caches: caches as unknown as CacheStorage,
    origin: 'http://p.example',
    locks: null,
    now: () => Date.UTC(2026, 10, 19, 10),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, done: false });
      return timers.length - 1;
    },
    clearTimeout: (t) => {
      const x = timers[t as number];
      if (x) x.done = true;
    },
    idle: () => undefined,
    providers: () => [],
  };
  const blocker = createBlocker(
    {
      N: {} as never,
      kitOf: () => null,
      withPageAssignments: (_w, run) => run(),
      counter: { count: (tabId, c, _n, key) => void counted.push([tabId, c, key]) },
      postToSw: (m) => void posted.push(m),
      hasUvTabs: () => opts.uv ?? false,
      log: () => undefined,
      browser: 'chromium',
      engineSettings: () => full,
      statusChanged: () => void statusChanges++,
    },
    internals,
  );
  const settings = (lists: FilterListRef[]): BlockerSettings => {
    const s = structuredClone(SW_FALLBACK_SETTINGS);
    s.extensions.lists = lists;
    full = { ...({} as EngineSettings), privacy: s.privacy, extensions: s.extensions } as EngineSettings;
    return s;
  };
  return { blocker, posted, counted, timers, caches, settings, builds: () => builds, statusChanges: () => statusChanges };
}

const req = (url: string): RequestInfo => ({
  engine: 'scramjet',
  tabId: 3,
  url,
  method: 'GET',
  destination: 'script',
  topLevelUrl: 'http://site-a.localhost/',
  isTopLevelDocument: false,
  documentUrl: 'http://site-a.localhost/',
  referrer: null,
});

const settle = async (n = 40): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('createBlocker', () => {
  it('fails open while building, then blocks; caches the set; a second engine host loads it from the cache', async () => {
    const lists = [ref('easylist', 'a')];
    const h = harness();
    const s = h.settings(lists);
    h.blocker.hooks.configure(s);
    expect(h.blocker.hooks.status()).toEqual({ state: 'building', lists: 0, detail: null } satisfies BlockerStatus); // not started yet: nothing in force
    expect(h.blocker.hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
    const started = h.blocker.start(s, KEY, 500);
    expect(h.blocker.hooks.status().state).toBe('building');
    await settle();
    await started;
    expect(h.builds()).toBe(1);
    expect(h.blocker.hooks.status()).toEqual({ state: 'ready', lists: 1, detail: null });
    expect(h.blocker.hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'block', category: 'ads' });
    // counted for its tab, keyed by the URL (a blocked URL counts once per page: engine-host/blocked.ts)
    expect(h.counted).toEqual([[3, 'ads', 'http://ads.localhost/a.js']]);
    const stats = await h.blocker.stats();
    expect(stats).toMatchObject({ engineVersion: 899, source: 'build', buildMs: 5, cache: { entries: 2 } });
    expect(stats.engines.map((e) => e.group)).toEqual(['ads']);
    // the SW got the config with the set id; no engines without a UV tab
    const cfg = h.posted.filter((m) => m.type === 'gnome-blocker-config');
    expect(cfg.at(-1)).toMatchObject({ setId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(h.posted.some((m) => m.type === 'gnome-blocker-engines')).toBe(false);
    h.blocker.onUvTab();
    expect(h.posted.at(-1)).toMatchObject({ type: 'gnome-blocker-engines' });
    // the next UV load: the SW has this set from this host already (no second copy of the engines) …
    const engines = () => h.posted.filter((m) => m.type === 'gnome-blocker-engines').length;
    h.blocker.onUvTab();
    expect(engines()).toBe(1);
    // … until the SW (re)starts (it keeps nothing): the next UV load sends the set again
    h.blocker.onSwHello(); // without a UV tab in this harness: config only
    expect(engines()).toBe(1);
    h.blocker.onUvTab();
    expect(engines()).toBe(2);
    // a swap to another set while no UV tab is open: the next UV load sends the new set
    const firstSet = (h.posted.at(-1) as { setId: string }).setId;
    const other = h.settings([ref('easylist', 'b')]);
    h.blocker.hooks.configure(other);
    await settle();
    expect(h.blocker.hooks.status().state).toBe('ready');
    expect(engines()).toBe(2);
    h.blocker.onUvTab();
    expect(engines()).toBe(3);
    expect((h.posted.at(-1) as { setId: string }).setId).not.toBe(firstSet);

    const second = harness({ caches: h.caches, build: async () => ({ kind: 'failed', reason: 'worker-crashed' }) });
    const s2 = second.settings(lists);
    second.blocker.hooks.configure(s2);
    await second.blocker.start(s2, KEY, 500);
    expect(second.builds()).toBe(0);
    expect(await second.blocker.stats()).toMatchObject({ source: 'cache' });
    expect(second.blocker.hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'block', category: 'ads' });
    // another key: the cached set does not verify → rebuilt, cache-rejected
    const third = harness({ caches: h.caches });
    const s3 = third.settings(lists);
    third.blocker.hooks.configure(s3);
    await third.blocker.start(s3, '34'.repeat(32), 500);
    await settle();
    expect(third.builds()).toBe(1);
    expect(third.blocker.hooks.status()).toEqual({ state: 'ready', lists: 1, detail: 'cache-rejected' });
  });

  it('keeps the set in force while a newer one builds, and swaps it in (D7)', async () => {
    let release: (o: BuildOutcome) => void = () => undefined;
    let n = 0;
    const h = harness({
      build: (refs) => {
        n++;
        if (n === 1) return realBuild('||ads.localhost^\n', refs);
        return new Promise((r) => (release = r));
      },
    });
    const s = h.settings([ref('easylist', 'a')]);
    h.blocker.hooks.configure(s);
    await h.blocker.start(s, KEY, 500);
    await settle();
    const s2 = h.settings([ref('easylist', 'b')]);
    h.blocker.hooks.configure(s2);
    await settle();
    expect(h.blocker.hooks.status().state).toBe('ready');
    expect(h.blocker.hooks.onRequest(req('http://ads.localhost/a.js'))).toMatchObject({ action: 'block' });
    expect(h.blocker.hooks.onRequest(req('http://trk.localhost/a.js'))).toEqual({ action: 'allow' });
    release(await realBuild('||trk.localhost^\n', [ref('easylist', 'b')]));
    await settle();
    expect(h.blocker.hooks.onRequest(req('http://trk.localhost/a.js'))).toMatchObject({ action: 'block' });
    expect(h.blocker.hooks.onRequest(req('http://ads.localhost/a.js'))).toEqual({ action: 'allow' });
  });

  it('reports a failed build with its code and retries after 1 minute; a failed list shows in the detail', async () => {
    let fail = true;
    const h = harness({
      build: async (refs) => (fail ? { kind: 'failed', reason: 'out-of-memory' } : { ...(await realBuild('||ads.localhost^\n', refs.slice(0, 1))), lists: [{ id: 'easylist', sha256: 'a'.repeat(64), state: 'compiled', error: null, rules: 1, dropped: 0 }, { id: 'gone', sha256: 'b'.repeat(64), state: 'failed', error: 'changed', rules: 0, dropped: 0 }] }),
    });
    const s = h.settings([ref('easylist', 'a'), ref('gone', 'b')]);
    h.blocker.hooks.configure(s);
    await h.blocker.start(s, null, 0);
    await settle();
    expect(h.blocker.hooks.status()).toEqual({ state: 'failed', lists: 0, detail: 'failed:out-of-memory' });
    const retry = h.timers.find((t) => t.ms === 60_000 && !t.done);
    expect(retry).toBeDefined();
    fail = false;
    retry?.fn();
    await settle();
    expect(h.blocker.hooks.status()).toEqual({ state: 'ready', lists: 1, detail: 'lists-failed:1:2' });
  });

  it('caches nothing over the limit (over-cache-limit) and after site data was cleared; reload rebuilds', async () => {
    const h = harness();
    const s = h.settings([ref('easylist', 'a')]);
    s.extensions.cacheLimitMB = 1 / 1024 / 1024; // one byte: whatever the set weighs, it does not fit
    h.blocker.hooks.configure(s);
    await h.blocker.start(s, KEY, 0);
    await settle();
    const st = h.blocker.hooks.status();
    expect(st.state).toBe('ready');
    expect(st.detail).toMatch(/^over-cache-limit:\d+:1$/);
    expect((await h.blocker.stats()).cache.entries).toBe(0);

    const h3 = harness();
    const s3 = h3.settings([ref('easylist', 'a')]);
    h3.blocker.onCacheCleared();
    h3.blocker.hooks.configure(s3);
    await h3.blocker.start(s3, KEY, 0);
    await settle();
    expect(h3.blocker.hooks.status().state).toBe('ready');
    expect((await h3.blocker.stats()).cache.entries).toBe(0);
    await h3.blocker.reload();
    await settle();
    expect(h3.builds()).toBe(2);
    expect(h3.blocker.hooks.status().state).toBe('ready');
  });

  it('is off without lists, and resends config and engines on sw-hello when it has a UV tab', async () => {
    const h = harness({ uv: true });
    const s = h.settings([]);
    h.blocker.hooks.configure(s);
    await h.blocker.start(s, KEY, 500);
    expect(h.blocker.hooks.status()).toEqual({ state: 'off', lists: 0, detail: null });
    expect(h.builds()).toBe(0);
    const s2 = h.settings([ref('easylist', 'a')]);
    h.blocker.hooks.configure(s2);
    await settle();
    h.posted.length = 0;
    h.blocker.onSwHello();
    expect(h.posted.map((m) => m.type)).toEqual(['gnome-blocker-config', 'gnome-blocker-engines']);
  });
});
