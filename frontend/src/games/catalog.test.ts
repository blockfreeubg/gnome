import { describe, expect, it } from 'vitest';
import type { GamesApi } from './api';
import { CatalogView, MAX_ITEMS, PAGE_SIZE } from './catalog.svelte';
import { createFakeGamesApi, summaryOf } from './testing/fake-api';
import type { GameListPage, GameListQuery, GameSummary } from './types';

const flush = () => new Promise((r) => setTimeout(r, 0));
const noFilter = () => ({ mobile: false, exclude: [] });

describe('CatalogView', () => {
  it('loads page 1, then more pages, until done', async () => {
    const api = createFakeGamesApi();
    const v = new CatalogView(api, noFilter);
    v.query = { sort: 'popular' };
    expect(v.state).toBe('loading');
    await flush();
    expect(v.items).toHaveLength(PAGE_SIZE);
    expect(v.state).toBe('idle');
    const total = v.total!;
    while (v.state !== 'done') {
      v.loadMore();
      await flush();
    }
    expect(v.items).toHaveLength(total);
    v.loadMore();
    expect(v.state).toBe('done');
  });

  it('adds the settings filter to every request', async () => {
    const api = createFakeGamesApi();
    const v = new CatalogView(api, () => ({ mobile: true, exclude: ['puzzle'] }));
    v.query = { sort: 'new' };
    await flush();
    expect(api.calls.at(-1)!.arg).toMatchObject({ sort: 'new', mobile: true, exclude: ['puzzle'], limit: PAGE_SIZE });
    expect(v.items.every((g) => !g.categories.includes('puzzle'))).toBe(true);
  });

  it('aborts the running request when the query changes', async () => {
    const api = createFakeGamesApi();
    api.delayMs = 5;
    const v = new CatalogView(api, noFilter);
    v.query = { sort: 'popular' };
    v.query = { q: 'chess' };
    await new Promise((r) => setTimeout(r, 20));
    expect(v.query).toEqual({ q: 'chess' });
    const lists = api.calls.filter((c) => c.method === 'list');
    expect(lists).toHaveLength(2);
    expect(lists[1]!.arg).toMatchObject({ q: 'chess' });
    const all = await api.list({ limit: 100 });
    expect(v.total).toBeGreaterThan(0);
    expect(v.total).toBeLessThan(all.total);
  });

  it('guards loadMore while loading and de-duplicates across pages', async () => {
    const one = summaryOf(createFakeGamesApi().games[0]!);
    const two = { ...one, id: one.id + 1000, slug: 'other' };
    let n = 0;
    const api = {
      list: async (_q: GameListQuery): Promise<GameListPage> => {
        n++;
        await Promise.resolve();
        return n === 1 ? { items: [one], next_cursor: 'c1', total: 2 } : { items: [one, two], next_cursor: null, total: 2 };
      },
    } as unknown as GamesApi;
    const v = new CatalogView(api, noFilter);
    v.query = {};
    v.loadMore(); // loading: ignored
    await flush();
    v.loadMore();
    v.loadMore(); // 'more': ignored
    await flush();
    expect(n).toBe(2);
    expect(v.items.map((g) => g.id)).toEqual([one.id, two.id]);
    expect(v.state).toBe('done');
  });

  it('keeps what it had on an error and retries', async () => {
    const api = createFakeGamesApi();
    const v = new CatalogView(api, noFilter);
    v.query = {};
    await flush();
    api.failing = true;
    v.loadMore();
    await flush();
    expect(v.state).toBe('error');
    expect(v.error).toMatch(/Could not reach/);
    expect(v.items).toHaveLength(PAGE_SIZE);
    api.failing = false;
    v.retry();
    await flush();
    expect(v.items).toHaveLength(Math.min(v.total!, PAGE_SIZE * 2));
    expect(v.items.length).toBeGreaterThan(PAGE_SIZE);
  });

  it('stops at the 15,000 cap', async () => {
    let next = 0;
    const api = {
      list: async (): Promise<GameListPage> => {
        const items: GameSummary[] = Array.from({ length: 100 }, () => ({ ...summaryOf(createFakeGamesApi().games[0]!), id: next++ }));
        return { items, next_cursor: 'more', total: 99_999 };
      },
    } as unknown as GamesApi;
    const v = new CatalogView(api, noFilter);
    v.query = {};
    for (let i = 0; i < 200 && v.state !== 'done'; i++) {
      await flush();
      v.loadMore();
    }
    expect(v.items).toHaveLength(MAX_ITEMS);
    expect(v.state).toBe('done');
  });
});
