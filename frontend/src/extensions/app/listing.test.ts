import { describe, expect, it } from 'vitest';
import { FilterListing, LISTING_REFRESH_MS, type ListingDeps } from './listing.svelte';
import type { ServerListing } from './lists';

const LIST = {
  id: 'easylist',
  name: 'EasyList',
  category: 'ads',
  format: 'abp',
  license: 'GPL-3.0',
  homepage: 'https://easylist.to/',
  default_enabled: true,
  trusted: false,
  available: true,
  size: 10,
  sha256: 'a'.repeat(64),
  updated_at: 1,
  fetched_at: 2,
  version: '1',
};

class Harness {
  stored: unknown = undefined;
  auto = true;
  t = 1000;
  timers: Array<{ at: number; fn: () => void; id: number }> = [];
  calls: Array<{ url: string; headers: Record<string, string> }> = [];
  answers: Array<() => Response> = [];
  #id = 0;

  deps(): Partial<ListingDeps> & { autoUpdate: () => boolean } {
    return {
      fetch: async (url, init) => {
        this.calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
        const a = this.answers.shift();
        if (!a) throw new TypeError('network');
        return a();
      },
      get: async () => this.stored,
      put: async (v) => {
        this.stored = structuredClone(v);
      },
      now: () => this.t,
      autoUpdate: () => this.auto,
      setTimeout: (fn, ms) => {
        const id = ++this.#id;
        this.timers.push({ at: this.t + ms, fn, id });
        return id;
      },
      clearTimeout: (h) => {
        this.timers = this.timers.filter((x) => x.id !== h);
      },
    };
  }

  async advance(ms: number): Promise<void> {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      due.fn();
      await flush();
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const ok = (lists: unknown[] = [LIST], etag = '"v1"'): (() => Response) => () =>
  new Response(JSON.stringify({ lists, resources: null }), { status: 200, headers: { 'content-type': 'application/json', etag } });

describe('FilterListing (WAVE-B3 §7.1)', () => {
  it('fetches at start, stores the listing with its ETag, revalidates with If-None-Match', async () => {
    const h = new Harness();
    h.answers.push(ok());
    const l = new FilterListing(h.deps());
    await l.start();
    await flush();
    expect(l.state).toBe('ok');
    expect(l.listing?.lists.map((x) => x.id)).toEqual(['easylist']);
    expect((h.stored as { etag: string }).etag).toBe('"v1"');
    h.answers.push(() => new Response(null, { status: 304 }));
    await l.refresh('page');
    expect(h.calls[1]!.headers['If-None-Match']).toBe('"v1"');
    expect(l.listing?.lists.length).toBe(1);
    l.stop();
  });

  it('refreshes every 60 minutes while open', async () => {
    const h = new Harness();
    h.answers.push(ok(), ok(), ok());
    const l = new FilterListing(h.deps());
    await l.start();
    await flush();
    expect(h.calls.length).toBe(1);
    await h.advance(LISTING_REFRESH_MS);
    expect(h.calls.length).toBe(2);
    await h.advance(LISTING_REFRESH_MS);
    expect(h.calls.length).toBe(3);
    l.stop();
  });

  it('with auto-update off uses the stored listing until "Update lists now", and fetches once when none is stored', async () => {
    const h = new Harness();
    h.auto = false;
    h.answers.push(ok());
    const first = new FilterListing(h.deps());
    await first.start();
    await flush();
    expect(h.calls.length).toBe(1); // nothing stored: fetched once
    first.stop();
    const l = new FilterListing(h.deps());
    await l.start();
    await flush();
    await l.refresh('page');
    await l.refresh('failed-list');
    await h.advance(LISTING_REFRESH_MS);
    expect(h.calls.length).toBe(1);
    expect(l.listing?.lists[0]?.id).toBe('easylist');
    h.answers.push(ok([{ ...LIST, sha256: 'b'.repeat(64) }], '"v2"'));
    await l.refresh('user');
    expect(h.calls.length).toBe(2);
    expect(l.listing?.lists[0]?.sha256).toBe('b'.repeat(64));
    l.stop();
  });

  it('honours 503 + Retry-After once, and reports a server without lists', async () => {
    const h = new Harness();
    h.answers.push(() => new Response('{}', { status: 503, headers: { 'retry-after': '2' } }), ok());
    const l = new FilterListing(h.deps());
    const p = l.refresh('user');
    await flush();
    expect(l.state).toBe('loading');
    await h.advance(2000);
    await p;
    expect(h.calls.length).toBe(2);
    expect(l.state).toBe('ok');
    const h2 = new Harness();
    h2.answers.push(() => new Response('{}', { status: 404 }));
    const l2 = new FilterListing(h2.deps());
    await l2.refresh('user');
    expect(l2.state).toBe('missing');
  });

  it('keeps the stored listing when the server is unreachable', async () => {
    const h = new Harness();
    const listing: ServerListing = { lists: [LIST as never], resources: null };
    h.stored = { listing, etag: '"v1"', fetchedAt: 5 };
    const l = new FilterListing(h.deps());
    await l.refresh('user'); // no answer queued: network error
    expect(l.state).toBe('ok');
    expect(l.listing?.lists[0]?.id).toBe('easylist');
    expect(l.checkedAt).toBe(5);
  });

  it('joins concurrent refreshes', async () => {
    const h = new Harness();
    h.answers.push(ok());
    const l = new FilterListing(h.deps());
    await Promise.all([l.refresh('user'), l.refresh('page')]);
    expect(h.calls.length).toBe(1);
  });
});
