import { describe, expect, it } from 'vitest';
import type { FilterListRef } from '../../shared/engine-protocol';
import { LIST_LIMITS, fetchList, listUrl, newBudget, sha256Hex } from './lists';
import type { ListFetchDeps } from './lists';

const enc = (s: string) => new TextEncoder().encode(s);

async function refFor(body: Uint8Array, id = 'easylist'): Promise<FilterListRef> {
  return { id, sha256: await sha256Hex(body), category: 'ads', format: 'abp', trusted: false };
}

function deps(responses: Array<() => Response>, sleeps: number[] = []): ListFetchDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    origin: 'http://p.example',
    sha256: sha256Hex,
    sleep: async (ms) => void sleeps.push(ms),
    fetch: async (url) => {
      urls.push(url);
      const r = responses.shift();
      if (!r) throw new TypeError('network');
      return r();
    },
  };
}

describe('fetchList (D9)', () => {
  it('fetches by hash on the proxy origin and returns the text when the SHA-256 matches', async () => {
    const body = enc('[Adblock Plus]\n||ads.example^\n');
    const ref = await refFor(body);
    const d = deps([() => new Response(body)]);
    const r = await fetchList(ref, d, newBudget());
    expect(r).toEqual({ ok: true, ref, text: '[Adblock Plus]\n||ads.example^\n', bytes: body.byteLength });
    expect(d.urls).toEqual([listUrl('http://p.example', ref)]);
    expect(d.urls[0]).toBe(`http://p.example/api/filters/easylist?v=${ref.sha256}`);
  });

  it('reports a changed body (the server kept only a newer version)', async () => {
    const ref = await refFor(enc('old'));
    expect(await fetchList(ref, deps([() => new Response('new')]), newBudget())).toMatchObject({ ok: false, error: 'changed' });
  });

  it('honours one 503 with Retry-After (capped), then gives up with download', async () => {
    const body = enc('! list');
    const ref = await refFor(body);
    const sleeps: number[] = [];
    const ok = await fetchList(ref, deps([() => new Response(null, { status: 503, headers: { 'retry-after': '2' } }), () => new Response(body)], sleeps), newBudget());
    expect(ok.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
    const twice = await fetchList(ref, deps([() => new Response(null, { status: 503, headers: { 'retry-after': '600' } }), () => new Response(null, { status: 503 })], sleeps), newBudget());
    expect(twice).toMatchObject({ ok: false, error: 'download' });
    expect(sleeps).toEqual([2000, LIST_LIMITS.retryAfterMaxS * 1000]);
    expect(await fetchList(ref, deps([]), newBudget())).toMatchObject({ ok: false, error: 'download' });
    expect(await fetchList(ref, deps([() => new Response('x', { status: 404 })]), newBudget())).toMatchObject({ ok: false, error: 'download' });
  });

  it('refuses a list over the per-list cap or the build budget (too-large)', async () => {
    const body = enc('x'.repeat(1000));
    const ref = await refFor(body);
    expect(await fetchList(ref, deps([() => new Response(body)]), { left: 999 })).toMatchObject({ ok: false, error: 'too-large' });
    expect(await fetchList(ref, deps([() => new Response(body, { headers: { 'content-length': String(LIST_LIMITS.listBytes + 1) } })]), newBudget())).toMatchObject({
      ok: false,
      error: 'too-large',
    });
    const budget = { left: 1500 };
    expect((await fetchList(ref, deps([() => new Response(body)]), budget)).ok).toBe(true);
    expect(budget.left).toBe(500);
  });

  it('refuses invalid UTF-8 (invalid-utf8)', async () => {
    const body = new Uint8Array([0x21, 0x20, 0xff, 0xfe, 0x0a]);
    const ref = await refFor(body);
    expect(await fetchList(ref, deps([() => new Response(body)]), newBudget())).toMatchObject({ ok: false, error: 'invalid-utf8' });
  });
});
