/**
 * Games catalog client (docs/WAVE-C.md §5.2) over `src/lib/api.ts`, for the public routes of §4.2. Every answer is
 * shape-checked: a malformed item is dropped (and counted, `gamesApiDiagnostics()`), a malformed envelope is an
 * `invalid_response` error. Titles, descriptions and instructions stay plain text; the UI renders them as text.
 */
import { api, ApiError, isApiError } from '../lib/api';
import type { Settings } from '../settings/schema';
import type {
  CategorySlug,
  GameCategory,
  GameDetail,
  GameFlag,
  GameListPage,
  GameListQuery,
  GamePage,
  GameSections,
  GameSummary,
  GameTag,
  GamesStatus,
  SourceId,
} from './types';

/** What every listing honours (Settings → Games, D11). */
export interface GameFilter {
  mobile: boolean;
  exclude: CategorySlug[];
}

/** At most this many categories go into `exclude=` (the server's cap is 20; at most 19 categories exist, D11). */
const MAX_EXCLUDE = 19;

/** exclude = hiddenCategories ∩ the server's category slugs (≤ 19, sorted; before the categories loaded: none). */
export function filterFromSettings(s: Settings['games'], known: readonly CategorySlug[] | null): GameFilter {
  const mobile = s.showMobileOnly;
  if (!known) return { mobile, exclude: [] };
  const knownSet = new Set(known);
  const exclude = [...new Set(s.hiddenCategories)].filter((slug) => knownSet.has(slug)).sort().slice(0, MAX_EXCLUDE);
  return { mobile, exclude };
}

export interface GamesApi {
  list(q: GameListQuery, signal?: AbortSignal): Promise<GameListPage>;
  sections(f: GameFilter, signal?: AbortSignal): Promise<GameSections>;
  categories(signal?: AbortSignal): Promise<GameCategory[]>;
  tags(prefix: string, limit?: number, signal?: AbortSignal): Promise<GameTag[]>;
  /** ≤ 200 ids per request (the client splits longer lists); missing games are simply absent. */
  byIds(ids: readonly number[], signal?: AbortSignal): Promise<GameSummary[]>;
  /** null on 404. */
  game(slug: string, f: GameFilter, signal?: AbortSignal): Promise<GamePage | null>;
  status(signal?: AbortSignal): Promise<GamesStatus>;
  /** `POST /api/games/:slug/play`; failures are ignored (a play count is best effort). */
  play(slug: string): Promise<void>;
}

// ── Shape checks ─────────────────────────────────────────────────────────────────────────────────────────────────

const SOURCES: ReadonlySet<string> = new Set<SourceId>(['gamepix', 'gamedistribution', 'playgama', 'gamemonetize', 'famobi', 'itchio', 'js13k', 'oss']);
const FLAGS: ReadonlySet<string> = new Set<GameFlag>(['kids_friendly', 'no_blood', 'no_cruelty', 'iap', 'paid']);
const EMBED_KINDS: ReadonlySet<string> = new Set(['iframe', 'selfhost', 'link']);
const ORIENTATIONS: ReadonlySet<string> = new Set(['landscape', 'portrait', 'any']);
const RUN_STATES: ReadonlySet<string> = new Set(['complete', 'incomplete', 'failed', 'interrupted']);

let dropped = 0;

/** How many malformed items answers contained (dropped, not shown). */
export function gamesApiDiagnostics(): { droppedItems: number } {
  return { droppedItems: dropped };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function invalid(): ApiError {
  return new ApiError({ status: 200, code: 'invalid_response', message: 'The GNOME server sent an unexpected response.' });
}

export function parseSummary(v: unknown): GameSummary | null {
  if (!isRec(v)) return null;
  const { id, slug, title, developer, thumbnail, categories, mobile, source, added_at, plays, playable } = v;
  if (!isNum(id) || !Number.isInteger(id) || !isStr(slug) || slug === '' || !isStr(title)) return null;
  if (!strOrNull(developer) || !strOrNull(thumbnail) || !isStrArray(categories) || typeof mobile !== 'boolean') return null;
  if (!isStr(source) || !SOURCES.has(source) || !isNum(added_at) || !isNum(plays) || typeof playable !== 'boolean') return null;
  return {
    id,
    slug,
    title,
    developer,
    thumbnail,
    categories: categories.slice(0, 3),
    mobile,
    source: source as SourceId,
    added_at,
    plays,
    playable,
  };
}

function parseOss(v: unknown): GameDetail['oss'] | undefined {
  if (v === null || v === undefined) return null;
  if (!isRec(v)) return undefined;
  const { repository, commit, license_file_url } = v;
  if (!strOrNull(repository) || !strOrNull(commit) || !strOrNull(license_file_url)) return undefined;
  return { repository, commit, license_file_url };
}

export function parseDetail(v: unknown): GameDetail | null {
  const base = parseSummary(v);
  if (!base || !isRec(v)) return null;
  const { description, instructions, tags, embed_url, width, height, source_url, developer_url, license } = v;
  const { published_at, attribution, embed_kind, orientation, flags, embed_allowed } = v;
  if (!isStr(description) || !isStr(instructions) || !isStrArray(tags) || !isStr(embed_url)) return null;
  if (!numOrNull(width) || !numOrNull(height) || !strOrNull(source_url) || !strOrNull(developer_url)) return null;
  if (!strOrNull(license) || !numOrNull(published_at) || !isStr(attribution)) return null;
  if (!isStr(embed_kind) || !EMBED_KINDS.has(embed_kind)) return null;
  if (orientation !== null && !(isStr(orientation) && ORIENTATIONS.has(orientation))) return null;
  if (!isStrArray(flags) || typeof embed_allowed !== 'boolean') return null;
  const oss = parseOss(v.oss);
  if (oss === undefined) return null;
  return {
    ...base,
    description,
    instructions,
    tags,
    embed_url,
    width,
    height,
    source_url,
    developer_url,
    license,
    published_at,
    attribution,
    embed_kind: embed_kind as GameDetail['embed_kind'],
    orientation: orientation as GameDetail['orientation'],
    flags: flags.filter((f): f is GameFlag => FLAGS.has(f)),
    embed_allowed,
    oss,
  };
}

/** Parses an array of summaries, dropping (and counting) malformed items; a non-array is an invalid response. */
function summaries(v: unknown): GameSummary[] {
  if (!Array.isArray(v)) throw invalid();
  const out: GameSummary[] = [];
  for (const item of v) {
    const s = parseSummary(item);
    if (s) out.push(s);
    else dropped++;
  }
  return out;
}

export function parseListPage(v: unknown): GameListPage {
  if (!isRec(v) || !strOrNull(v.next_cursor) || !isNum(v.total)) throw invalid();
  return { items: summaries(v.items), next_cursor: v.next_cursor, total: v.total };
}

export function parseSections(v: unknown): GameSections {
  if (!isRec(v)) throw invalid();
  return { featured: summaries(v.featured), trending: summaries(v.trending), popular: summaries(v.popular), new: summaries(v.new) };
}

export function parseCategories(v: unknown): GameCategory[] {
  if (!isRec(v) || !Array.isArray(v.categories)) throw invalid();
  const out: GameCategory[] = [];
  for (const c of v.categories) {
    if (isRec(c) && isStr(c.slug) && c.slug !== '' && isStr(c.name) && isNum(c.count)) out.push({ slug: c.slug, name: c.name, count: c.count });
    else dropped++;
  }
  return out;
}

export function parseTags(v: unknown): GameTag[] {
  if (!isRec(v) || !Array.isArray(v.tags)) throw invalid();
  const out: GameTag[] = [];
  for (const t of v.tags) {
    if (isRec(t) && isStr(t.tag) && isNum(t.count)) out.push({ tag: t.tag, count: t.count });
    else dropped++;
  }
  return out;
}

export function parseGamePage(v: unknown): GamePage {
  if (!isRec(v)) throw invalid();
  const game = parseDetail(v.game);
  if (!game) throw invalid();
  return { game, related: summaries(v.related) };
}

export function parseStatus(v: unknown): GamesStatus {
  if (!isRec(v) || !isNum(v.listed) || !isNum(v.playable) || typeof v.importing !== 'boolean' || !Array.isArray(v.sources)) {
    throw invalid();
  }
  const sources: GamesStatus['sources'] = [];
  for (const s of v.sources) {
    if (!isRec(s) || !isStr(s.id) || !SOURCES.has(s.id) || !isStr(s.name)) {
      dropped++;
      continue;
    }
    const li = s.last_import;
    let last: GamesStatus['sources'][number]['last_import'] = null;
    if (isRec(li) && isStr(li.status) && RUN_STATES.has(li.status) && isNum(li.finished_at)) {
      last = { status: li.status as 'complete', finished_at: li.finished_at };
    } else if (li !== null && li !== undefined) {
      dropped++;
      continue;
    }
    sources.push({ id: s.id as SourceId, name: s.name, last_import: last });
  }
  return { listed: v.listed, playable: v.playable, importing: v.importing, sources };
}

// ── The HTTP client ──────────────────────────────────────────────────────────────────────────────────────────────

/** `GET /api/games` query parameters (booleans as `1`, lists comma-separated; omitted when not set). */
export function listParams(q: GameListQuery): Record<string, string | number | undefined> {
  return {
    q: q.q ? q.q : undefined,
    category: q.category || undefined,
    tag: q.tag || undefined,
    sort: q.sort,
    mobile: q.mobile ? 1 : undefined,
    exclude: q.exclude && q.exclude.length ? q.exclude.join(',') : undefined,
    include_link_out: q.include_link_out ? 1 : undefined,
    cursor: q.cursor,
    limit: q.limit,
  };
}

function filterParams(f: GameFilter): Record<string, string | number | undefined> {
  return { mobile: f.mobile ? 1 : undefined, exclude: f.exclude.length ? f.exclude.join(',') : undefined };
}

const MAX_IDS = 200;

export function createGamesApi(): GamesApi {
  const get = (path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    api.get<unknown>(path, { query, ...(signal ? { signal } : {}) });
  return {
    async list(q, signal) {
      return parseListPage(await get('/api/games', listParams(q), signal));
    },
    async sections(f, signal) {
      return parseSections(await get('/api/games/sections', filterParams(f), signal));
    },
    async categories(signal) {
      return parseCategories(await get('/api/games/categories', {}, signal));
    },
    async tags(prefix, limit, signal) {
      return parseTags(await get('/api/games/tags', { prefix, limit }, signal));
    },
    async byIds(ids, signal) {
      const unique = [...new Set(ids)];
      const out: GameSummary[] = [];
      for (let i = 0; i < unique.length; i += MAX_IDS) {
        const chunk = unique.slice(i, i + MAX_IDS);
        const v = await get('/api/games/by-ids', { ids: chunk.join(',') }, signal);
        if (!isRec(v)) throw invalid();
        out.push(...summaries(v.items));
      }
      return out;
    },
    async game(slug, f, signal) {
      try {
        return parseGamePage(await get(`/api/games/${encodeURIComponent(slug)}`, filterParams(f), signal));
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    async status(signal) {
      return parseStatus(await get('/api/games/status', {}, signal));
    },
    async play(slug) {
      try {
        await api.post(`/api/games/${encodeURIComponent(slug)}/play`);
      } catch {
        // Best effort: a lost play count changes nothing for the player.
      }
    },
  };
}

// ── Links and images ─────────────────────────────────────────────────────────────────────────────────────────────

function parse(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** The proxy origin as an origin string, or null (unknown, or not an http(s) origin). */
function originOf(proxyOrigin: string | null): string | null {
  if (!proxyOrigin) return null;
  const u = parse(proxyOrigin);
  return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null;
}

/** Only these thumbnail URLs are rendered: `/api/thumb/<id>`, `https:` URLs, and `<proxy origin>/oss/…`. */
export function thumbnailSrc(summary: GameSummary, proxyOrigin: string | null): string | null {
  const t = summary.thumbnail;
  if (!t) return null;
  if (/^\/api\/thumb\/\d+$/.test(t)) return t;
  if (t.startsWith('/')) return null; // other same-origin paths: never
  const u = parse(t);
  if (!u) return null;
  const proxy = originOf(proxyOrigin);
  if (proxy && u.origin === proxy && u.pathname.startsWith('/oss/')) return u.href;
  if (u.protocol === 'https:' && !u.username && !u.password) return u.href;
  return null;
}

/** An href for developer_url, source_url and oss.repository: `https:` URLs only (`new URL()` parsing, never string
 *  prefixes), else null (rendered as text, no link). Used with rel="noopener noreferrer" target="_blank". */
export function safeLink(url: string | null): string | null {
  if (!url) return null;
  const u = parse(url);
  if (!u || u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u.href;
}

/** oss.license_file_url: only `<proxy origin>/oss/<slug>/…` of this game (origin and pathname compared after parsing). */
export function licenseLink(game: GameDetail, proxyOrigin: string | null): string | null {
  const raw = game.oss?.license_file_url;
  const proxy = originOf(proxyOrigin);
  if (!raw || !proxy) return null;
  const u = parse(raw);
  if (!u || u.origin !== proxy || u.username || u.password) return null;
  const prefix = `/oss/${encodeURIComponent(game.slug)}/`;
  if (!u.pathname.startsWith(prefix) || u.pathname.length === prefix.length) return null;
  return u.href;
}

/** The host a link-out names ("Open on <host>"), from a URL `safeLink` accepted. */
export function linkHost(href: string): string {
  return parse(href)?.hostname.replace(/^www\./, '') ?? href;
}

let shared: GamesApi | null = null;

/** The app page's one client (pages and start.ts share it). */
export function gamesClient(): GamesApi {
  return (shared ??= createGamesApi());
}
