import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../settings/defaults';
import {
  createGamesApi,
  filterFromSettings,
  gamesApiDiagnostics,
  licenseLink,
  listParams,
  parseDetail,
  parseListPage,
  parseStatus,
  safeLink,
  thumbnailSrc,
} from './api';
import { createFakeGamesApi, FAKE_PROXY_ORIGIN, summaryOf } from './testing/fake-api';
import type { GameDetail, GameSummary } from './types';

const fake = createFakeGamesApi();
const detail = (slug: string): GameDetail => structuredClone(fake.games.find((g) => g.slug === slug)!);
const sample: GameSummary = summaryOf(fake.games[0]!);

describe('shape checks', () => {
  it('drops malformed items and counts them', () => {
    const before = gamesApiDiagnostics().droppedItems;
    const page = parseListPage({ items: [sample, { ...sample, id: 'x' }, null, { ...sample, source: 'y8' }], next_cursor: null, total: 4 });
    expect(page.items).toEqual([sample]);
    expect(gamesApiDiagnostics().droppedItems - before).toBe(3);
  });

  it('rejects a malformed envelope as invalid_response', () => {
    expect(() => parseListPage({ items: 'nope', next_cursor: null, total: 1 })).toThrow(/unexpected response/);
    expect(() => parseListPage({ items: [], total: 1 })).toThrow();
  });

  it('keeps titles as plain strings and checks the detail fields', () => {
    const d = { ...detail('2048'), title: 'Press <Space>' };
    expect(parseDetail(d)?.title).toBe('Press <Space>');
    expect(parseDetail({ ...d, embed_kind: 'flash' })).toBeNull();
    expect(parseDetail({ ...d, embed_allowed: 'yes' })).toBeNull();
    expect(parseDetail({ ...d, oss: { repository: 1 } })).toBeNull();
    expect(parseDetail({ ...d, flags: ['iap', 'unknown'] })?.flags).toEqual(['iap']);
  });

  it('reads the status and drops unknown sources', () => {
    const s = parseStatus({
      listed: 3,
      playable: 2,
      importing: false,
      sources: [
        { id: 'gamepix', name: 'GamePix', last_import: { status: 'failed', finished_at: 5 } },
        { id: 'y8', name: 'Y8', last_import: null },
      ],
    });
    expect(s.sources).toEqual([{ id: 'gamepix', name: 'GamePix', last_import: { status: 'failed', finished_at: 5 } }]);
  });
});

describe('filterFromSettings (D11)', () => {
  const games = createDefaultSettings().games;
  it('keeps only known slugs, sorted, at most 19', () => {
    const known = Array.from({ length: 19 }, (_, i) => `c${String(i).padStart(2, '0')}`);
    const hidden = [...Array.from({ length: 24 }, (_, i) => `c${String(i).padStart(2, '0')}`), 'nope'].reverse();
    const f = filterFromSettings({ ...games, hiddenCategories: hidden, showMobileOnly: true }, known);
    expect(f.mobile).toBe(true);
    expect(f.exclude).toEqual(known);
  });
  it('sends none before the categories loaded', () => {
    expect(filterFromSettings({ ...games, hiddenCategories: ['puzzle'] }, null)).toEqual({ mobile: false, exclude: [] });
  });
});

describe('links and images', () => {
  const proxy = FAKE_PROXY_ORIGIN;
  it('thumbnailSrc accepts /api/thumb/<id>, https and proxy-origin OSS only', () => {
    const t = (thumbnail: string | null) => thumbnailSrc({ ...sample, thumbnail }, proxy);
    expect(t('/api/thumb/12')).toBe('/api/thumb/12');
    expect(t('https://img.gamepix.com/a.png')).toBe('https://img.gamepix.com/a.png');
    expect(t(`${proxy}/oss/2048/icon.png`)).toBe(`${proxy}/oss/2048/icon.png`);
    expect(t('javascript:alert(1)')).toBeNull();
    expect(t('data:image/png;base64,AAAA')).toBeNull();
    expect(t('http://cdn.example/a.png')).toBeNull();
    expect(t(`${proxy}/uv/service/x`)).toBeNull();
    expect(t('/browse?url=x')).toBeNull();
    expect(t(null)).toBeNull();
  });
  it('safeLink allows https only', () => {
    expect(safeLink('https://play2048.co')).toBe('https://play2048.co/');
    expect(safeLink('javascript:alert(1)')).toBeNull();
    expect(safeLink('data:text/html,x')).toBeNull();
    expect(safeLink('http://example.com')).toBeNull();
    expect(safeLink('https://user:pw@example.com')).toBeNull();
    expect(safeLink(' https:x')).toBe('https://x/'); // parsed, not prefix-matched: a host named "x"
    expect(safeLink(null)).toBeNull();
  });
  it('licenseLink allows only this game under <proxy origin>/oss/<slug>/', () => {
    const g = detail('2048');
    expect(licenseLink(g, proxy)).toBe(`${proxy}/oss/2048/LICENSE.txt`);
    const other = (url: string) => licenseLink({ ...g, oss: { ...g.oss!, license_file_url: url } }, proxy);
    expect(other(`${proxy}.evil.example/oss/2048/LICENSE`)).toBeNull();
    expect(other('https://127.0.0.1.evil.example/oss/2048/LICENSE')).toBeNull();
    expect(other(`${proxy}/oss/hexgl/LICENSE`)).toBeNull();
    expect(other(`${proxy}/oss/2048/`)).toBeNull();
    expect(other('javascript:alert(1)')).toBeNull();
    expect(other('data:text/plain,MIT')).toBeNull();
    expect(licenseLink(g, null)).toBeNull();
  });
});

describe('createGamesApi over fetch', () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the list parameters, the filter of every listing and maps 404 to null', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.startsWith('/api/games/gone')) return json(404, { error: { code: 'not_found', message: 'Not found.' } });
        if (url.startsWith('/api/games/sections')) return json(200, { featured: [], trending: [], popular: [], new: [] });
        return json(200, { items: [sample], next_cursor: null, total: 1 });
      }),
    );
    const a = createGamesApi();
    await a.list({ q: 'chess', sort: 'az', mobile: true, exclude: ['horror', 'idle'], include_link_out: true, limit: 48 });
    expect(urls[0]).toBe('/api/games?q=chess&sort=az&mobile=1&exclude=horror%2Cidle&include_link_out=1&limit=48');
    await a.sections({ mobile: false, exclude: ['horror'] });
    expect(urls[1]).toBe('/api/games/sections?exclude=horror');
    expect(await a.game('gone', { mobile: false, exclude: [] })).toBeNull();
    expect(urls[2]).toBe('/api/games/gone');
  });

  it('splits by-ids into requests of at most 200', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return json(200, { items: [] });
      }),
    );
    await createGamesApi().byIds(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(urls).toHaveLength(3);
    expect(new URL(urls[2]!, 'http://x').searchParams.get('ids')!.split(',')).toHaveLength(50);
  });

  it('play posts with the CSRF header and ignores failures', async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        inits.push(init);
        throw new TypeError('offline');
      }),
    );
    await expect(createGamesApi().play('a b')).resolves.toBeUndefined();
    expect((inits[0]!.headers as Record<string, string>)['X-GNOME-Request']).toBe('1');
  });

  it('listParams omits what is not set', () => {
    expect(listParams({})).toEqual({
      q: undefined,
      category: undefined,
      tag: undefined,
      sort: undefined,
      mobile: undefined,
      exclude: undefined,
      include_link_out: undefined,
      cursor: undefined,
      limit: undefined,
    });
  });
});
