/**
 * A `GamesApi` for unit tests and the visual check (docs/WAVE-C.md §5.5), over real feed records taken unchanged from
 * `crates/catalog/tests/fixtures/` (captured 2026-11-10, provenance in that directory's README.md):
 * - `gamepix-p1.json`, `gamepix-chess-p1.json`, `gamepix-mahjong-p1.json` — GamePix v2 JSON feed (`sid=1`);
 * - `gamedistribution-p1.json` — GameDistribution RSS (JSON) feed, page 1 of 10;
 * - `playgama-p1.json` — Playgama partner catalogue export, 10 games;
 * - `itch-free-web.xml` — itch.io's free web games RSS (link-out records);
 * - `crates/catalog/oss-games.toml` — the curated `2048` entry (license, copyright, pinned commit).
 * The records are mapped to GNOME's wire shapes roughly as the crate does (a reduced category table); nothing here is
 * invented catalog data, and none of it is ever used outside tests and the local visual check.
 *
 * It pages with opaque cursors bound to the query, honours q / category / tag / sort / mobile / exclude /
 * include_link_out, answers null for unknown slugs and fails every call while `failing` is set.
 */
import gamepixP1 from '../../../../crates/catalog/tests/fixtures/gamepix-p1.json';
import gamepixChess from '../../../../crates/catalog/tests/fixtures/gamepix-chess-p1.json';
import gamepixMahjong from '../../../../crates/catalog/tests/fixtures/gamepix-mahjong-p1.json';
import gamedistribution from '../../../../crates/catalog/tests/fixtures/gamedistribution-p1.json';
import playgama from '../../../../crates/catalog/tests/fixtures/playgama-p1.json';
import itchXml from '../../../../crates/catalog/tests/fixtures/itch-free-web.xml?raw';
import { ApiError } from '../../lib/api';
import type { GameFilter, GamesApi } from '../api';
import { summaryOf } from '../summary';
import type { CategorySlug, GameCategory, GameDetail, GameFlag, GameListQuery, GamePage, GamesStatus } from '../types';

export const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  action: 'Action',
  adventure: 'Adventure',
  arcade: 'Arcade',
  racing: 'Racing',
  sports: 'Sports',
  puzzle: 'Puzzle',
  strategy: 'Strategy',
  multiplayer: 'Multiplayer',
  simulation: 'Simulation',
  idle: 'Idle',
  platformer: 'Platformer',
  casual: 'Casual',
  horror: 'Horror',
  sandbox: 'Sandbox',
  card: 'Card',
};
const CORE = Object.keys(CATEGORY_NAMES).filter((c) => c !== 'card');

/** A reduced version of the crate's label table (crates/catalog/src/categories.rs). */
function mapCategory(label: string): CategorySlug {
  const l = label.trim().toLowerCase();
  const table: Record<string, CategorySlug> = {
    'match-3': 'puzzle',
    puzzle: 'puzzle',
    puzzles: 'puzzle',
    mahjong: 'puzzle',
    'mahjong-&-connect': 'puzzle',
    merge: 'puzzle',
    chess: 'strategy',
    strategy: 'strategy',
    boardgames: 'strategy',
    farming: 'simulation',
    cooking: 'simulation',
    simulation: 'simulation',
    zombie: 'action',
    battle: 'action',
    action: 'action',
    shooter: 'action',
    building: 'casual',
    'hyper-casual': 'casual',
    casual: 'casual',
    cozy: 'casual',
    airplane: 'arcade',
    arcade: 'arcade',
    agility: 'arcade',
    sports: 'sports',
    adventure: 'adventure',
    racing: 'racing',
    cards: 'card',
    solitaire: 'card',
  };
  return table[l] ?? 'casual';
}

/** Python-style list strings in the GameDistribution and Playgama captures ("['a', 'b']"). */
function pyList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string') return [];
  return [...v.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

const date = (s: unknown): number | null => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};

function flagsFromTags(tags: readonly string[]): GameFlag[] {
  const out: GameFlag[] = [];
  const low = tags.map((t) => t.toLowerCase());
  if (low.includes('kids friendly')) out.push('kids_friendly');
  if (low.includes('no blood')) out.push('no_blood');
  if (low.includes('no cruelty')) out.push('no_cruelty');
  return out;
}

function build(): GameDetail[] {
  const games: GameDetail[] = [];
  let id = 1;
  const seen = new Set<string>();
  const add = (g: Omit<GameDetail, 'id' | 'plays'>, plays: number) => {
    if (seen.has(g.slug)) return;
    seen.add(g.slug);
    const gid = id++;
    games.push({ ...g, id: gid, plays, thumbnail: g.thumbnail === '' ? `/api/thumb/${gid}` : g.thumbnail });
  };
  type GpItem = Record<string, unknown>;
  const gp = [gamepixP1, gamepixChess, gamepixMahjong].flatMap((f) => (f as { items: GpItem[] }).items);
  gp.forEach((r, i) => {
    const orientation = r.orientation === 'portrait' ? 'portrait' : r.orientation === 'landscape' ? 'landscape' : 'any';
    add(
      {
        slug: String(r.namespace),
        title: String(r.title),
        developer: null,
        thumbnail: '',
        categories: [mapCategory(String(r.category))],
        mobile: true,
        source: 'gamepix',
        added_at: date(r.date_published) ?? 0,
        playable: true,
        description: typeof r.description === 'string' ? r.description : '',
        instructions: '',
        tags: [String(r.category)],
        embed_url: String(r.url),
        width: typeof r.width === 'number' ? r.width : null,
        height: typeof r.height === 'number' ? r.height : null,
        source_url: `https://www.gamepix.com/play/${String(r.namespace)}`,
        developer_url: null,
        license: null,
        published_at: date(r.date_published),
        attribution: 'via GamePix',
        embed_kind: 'iframe',
        orientation,
        flags: [],
        embed_allowed: true,
        oss: null,
      },
      Math.round(1000 * Number(r.quality_score ?? 0.5)) - i,
    );
  });
  (gamedistribution as Array<Record<string, unknown>>).forEach((r, i) => {
    const tags = pyList(r.Tag);
    const slug = String(r.Title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    add(
      {
        slug,
        title: String(r.Title),
        developer: null,
        thumbnail: '',
        categories: pyList(r.Category).map(mapCategory).slice(0, 3),
        mobile: r.Mobile === 'true',
        source: 'gamedistribution',
        added_at: 1_762_000_000_000 - i * 86_400_000,
        playable: true,
        description: String(r.Description ?? '').trim(),
        instructions: String(r.Instructions ?? '').trim(),
        tags: tags.filter((t) => !/^(kids friendly|no blood|no cruelty)$/i.test(t)),
        embed_url: String(r.Url),
        width: Number(r.Width) || null,
        height: Number(r.Height) || null,
        source_url: `https://gamedistribution.com/games/${slug}`,
        developer_url: null,
        license: null,
        published_at: null,
        attribution: 'via GameDistribution',
        embed_kind: 'iframe',
        orientation: null,
        flags: flagsFromTags(tags),
        embed_allowed: true,
        oss: null,
      },
      400 - i,
    );
  });
  (playgama as { games: Array<Record<string, unknown>> }).games.forEach((r, i) => {
    const orient = String(r.screenOrientation ?? '');
    add(
      {
        slug: String(r.slug),
        title: String(r.title),
        developer: null,
        thumbnail: '',
        categories: [...new Set(pyList(r.genres).map(mapCategory))].slice(0, 3),
        mobile: pyList(r.mobileReady).some((m) => /android|ios/i.test(m)),
        source: 'playgama',
        added_at: 1_761_000_000_000 - i * 86_400_000,
        playable: true,
        description: String(r.description ?? ''),
        instructions: String(r.howToPlayText ?? ''),
        tags: pyList(r.tags).slice(0, 6),
        embed_url: String(r.gameURL),
        width: null,
        height: null,
        source_url: String(r.playgamaGameUrl),
        developer_url: null,
        license: null,
        published_at: null,
        attribution: 'via Playgama',
        embed_kind: 'iframe',
        orientation: /'vertical': True/.test(orient) && !/'horizontal': True/.test(orient) ? 'portrait' : 'landscape',
        flags: r.inGamePurchases === 'Yes' ? ['iap'] : [],
        embed_allowed: i !== 0, // one game whose host this operator has not approved (D4): link-out only
        oss: null,
      },
      300 - i,
    );
  });
  for (const m of itchXml.matchAll(/<item>[\s\S]*?<plainTitle>([\s\S]*?)<\/plainTitle>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g)) {
    const link = m[2]!.trim();
    const slug = `itch-${new URL(link).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '')}`;
    add(
      {
        slug,
        title: m[1]!.trim(),
        developer: new URL(link).hostname.split('.')[0] ?? null,
        thumbnail: null,
        categories: ['casual'],
        mobile: false,
        source: 'itchio',
        added_at: 1_760_000_000_000,
        playable: false,
        description: '',
        instructions: '',
        tags: [],
        embed_url: link,
        width: null,
        height: null,
        source_url: link,
        developer_url: null,
        license: null,
        published_at: null,
        attribution: 'via itch.io',
        embed_kind: 'link',
        orientation: null,
        flags: [],
        embed_allowed: false,
        oss: null,
      },
      1,
    );
    if (games.filter((g) => g.source === 'itchio').length >= 8) break;
  }
  // crates/catalog/oss-games.toml, entry "2048" (thumbnail and license file under <proxy origin>/oss/2048/).
  add(
    {
      slug: '2048',
      title: '2048',
      developer: 'Gabriele Cirulli',
      thumbnail: `${FAKE_PROXY_ORIGIN}/oss/2048/meta/apple-touch-icon.png`,
      categories: ['puzzle'],
      mobile: true,
      source: 'oss',
      added_at: 1_759_000_000_000,
      playable: true,
      description: "A small clone of 1024, based on Saming's 2048 (also a clone). 2048 was indirectly inspired by Threes.",
      instructions: '',
      tags: ['numbers', 'sliding'],
      embed_url: `${FAKE_PROXY_ORIGIN}/oss/2048/index.html`,
      width: null,
      height: null,
      source_url: 'https://github.com/gabrielecirulli/2048',
      developer_url: 'https://play2048.co',
      license: 'MIT',
      published_at: null,
      attribution: 'MIT · Copyright (c) 2014 Gabriele Cirulli',
      embed_kind: 'selfhost',
      orientation: 'any',
      flags: [],
      embed_allowed: true,
      oss: {
        repository: 'https://github.com/gabrielecirulli/2048',
        commit: '478b6ec346e3787f589e4af751378d06ded4cbbc',
        license_file_url: `${FAKE_PROXY_ORIGIN}/oss/2048/LICENSE.txt`,
      },
    },
    250,
  );
  return games;
}

/** The proxy origin the fake's OSS URLs use (tests pass it to thumbnailSrc and licenseLink). */
export const FAKE_PROXY_ORIGIN = 'http://127.0.0.1:22081';

export { summaryOf };

export interface FakeGamesApi extends GamesApi {
  /** Every call rejects with a network error while set. */
  failing: boolean;
  /** Every call waits this long (ms) before answering (0 = next microtask). */
  delayMs: number;
  /** Status override (the empty-catalog states). */
  statusOverride: GamesStatus | null;
  readonly games: GameDetail[];
  readonly calls: Array<{ method: string; arg: unknown }>;
  readonly plays: string[];
}

function matches(g: GameDetail, q: GameListQuery): boolean {
  if (!q.include_link_out && !g.playable) return false;
  if (q.mobile && !g.mobile) return false;
  if (q.exclude?.some((c) => g.categories.includes(c))) return false;
  if (q.category && !g.categories.includes(q.category)) return false;
  if (q.tag && !g.tags.includes(q.tag)) return false;
  if (q.q) {
    const words = q.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = `${g.title} ${g.tags.join(' ')}`.toLowerCase();
    const hayWords = hay.split(/[^a-z0-9]+/);
    const ok = words.every((w, i) =>
      i === words.length - 1 && w.length >= 3 ? hayWords.some((h) => h.startsWith(w)) : hayWords.includes(w),
    );
    if (!ok) return false;
  }
  return true;
}

function sorted(list: GameDetail[], sort: GameListQuery['sort']): GameDetail[] {
  const out = [...list];
  switch (sort) {
    case 'new':
      return out.sort((a, b) => b.added_at - a.added_at || a.id - b.id);
    case 'az':
      return out.sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
    case 'trending':
      return out.sort((a, b) => (b.plays % 97) - (a.plays % 97) || a.id - b.id);
    default:
      return out.sort((a, b) => b.plays - a.plays || a.id - b.id);
  }
}

export function createFakeGamesApi(opts: { games?: GameDetail[] } = {}): FakeGamesApi {
  const games = opts.games ?? build();
  const calls: FakeGamesApi['calls'] = [];
  const plays: string[] = [];
  const fake: FakeGamesApi = {
    failing: false,
    delayMs: 0,
    statusOverride: null,
    games,
    calls,
    plays,
    async list(q, signal) {
      await gate('list', q, signal);
      const { cursor, limit = 48, ...rest } = q;
      const key = JSON.stringify({ ...rest, exclude: rest.exclude?.filter((c) => c in CATEGORY_NAMES) });
      if (rest.category && !(rest.category in CATEGORY_NAMES)) throw badRequest(`unknown category: ${rest.category}`);
      if (limit < 1 || limit > 100) throw badRequest('limit must be 1-100');
      let offset = 0;
      if (cursor) {
        const [k, o] = cursor.split('|');
        if (k !== btoa(key)) throw badRequest('cursor does not belong to this query');
        offset = Number(o);
      }
      const all = sorted(games.filter((g) => matches(g, rest)), rest.sort ?? (rest.q ? 'relevance' : 'popular'));
      const items = all.slice(offset, offset + limit).map(summaryOf);
      const next = offset + limit < all.length ? `${btoa(key)}|${offset + limit}` : null;
      return { items, next_cursor: next, total: all.length };
    },
    async sections(f, signal) {
      await gate('sections', f, signal);
      const playable = games.filter((g) => matches(g, { mobile: f.mobile, exclude: f.exclude }));
      const take = (sort: GameListQuery['sort']) => sorted(playable, sort).slice(0, 24).map(summaryOf);
      return { featured: take('popular').slice(0, 12), trending: take('trending'), popular: take('popular'), new: take('new') };
    },
    async categories(signal) {
      await gate('categories', null, signal);
      const out: GameCategory[] = [];
      for (const [slug, name] of Object.entries(CATEGORY_NAMES)) {
        const count = games.filter((g) => g.playable && g.categories.includes(slug)).length;
        if (CORE.includes(slug) || count > 0) out.push({ slug, name, count });
      }
      return out;
    },
    async tags(prefix, limit = 30, signal) {
      await gate('tags', prefix, signal);
      const counts = new Map<string, number>();
      for (const g of games) for (const t of g.tags) if (t.startsWith(prefix)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag, count]) => ({ tag, count }));
    },
    async byIds(ids, signal) {
      await gate('byIds', ids, signal);
      return ids.flatMap((id) => games.filter((g) => g.id === id).map(summaryOf));
    },
    async game(slug, f, signal) {
      await gate('game', slug, signal);
      const g = games.find((x) => x.slug === slug);
      if (!g) return null;
      const related = games
        .filter((x) => x.id !== g.id && x.playable && matches(x, { mobile: f.mobile, exclude: f.exclude }))
        .filter((x) => x.categories.some((c) => g.categories.includes(c)))
        .slice(0, 12)
        .map(summaryOf);
      const page: GamePage = { game: structuredClone(g), related };
      return page;
    },
    async status(signal) {
      await gate('status', null, signal);
      if (fake.statusOverride) return structuredClone(fake.statusOverride);
      const names: Array<[GameDetail['source'], string]> = [
        ['gamepix', 'GamePix'],
        ['gamedistribution', 'GameDistribution'],
        ['playgama', 'Playgama'],
        ['itchio', 'itch.io'],
        ['oss', 'Open source'],
      ];
      return {
        listed: games.length,
        playable: games.filter((g) => g.playable).length,
        importing: false,
        sources: names.map(([id, name]) => ({ id, name, last_import: { status: 'complete', finished_at: 1_762_700_000_000 } })),
      };
    },
    async play(slug) {
      calls.push({ method: 'play', arg: slug });
      plays.push(slug);
    },
  };
  async function gate(method: string, arg: unknown, signal?: AbortSignal): Promise<void> {
    calls.push({ method, arg });
    if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
    else await Promise.resolve();
    if (signal?.aborted) throw new ApiError({ status: 0, code: 'aborted', message: 'The request was cancelled.' });
    if (fake.failing) throw new ApiError({ status: 0, code: 'network_error', message: 'Could not reach the GNOME server.' });
  }
  return fake;
}

function badRequest(message: string): ApiError {
  return new ApiError({ status: 400, code: 'bad_request', message, fromGnome: true });
}

/** The filter type the fake's helpers take (re-exported for tests). */
export type { GameFilter };
