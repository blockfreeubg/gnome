// Lane t's helpers for the Wave C games suites (docs/WAVE-C.md §9.1): backend-games, games-ui, games-player.
//
// Each suite is standalone (`export const standalone = true`): it starts its own gnome-server (backend-lib.mjs's
// helpers, used read-only) on the standalone port block (BACKEND_E2E_PORT_BASE; app +0, proxy +1, admin +2), with:
//   - the replayed catalog (D19): unmodified captures from crates/catalog/tests/fixtures/ copied into <work>/replay/
//     with the §4.6 index, imported by `gnome-server catalog import --replay` into the server's data dir before it
//     starts (no outside request: unmatched requests fail as Blocked);
//   - the OSS test game (fixtures/games/oss/e2e-blocks/, GNOME's own AGPL-3.0-only game) under GNOME_OSS_GAMES_DIR
//     with fixtures/games/oss-e2e.toml as GNOME_OSS_MANIFEST, imported with `catalog import --source oss`;
//   - GNOME_CATALOG_REFRESH_HOURS=0 and GNOME_OSS_FETCH=manual (nothing from the internet).
// Embeds are never proxied: the browser rows answer every embed host with fixtures/games/embed.html through
// Playwright routing (`routeEmbeds`), and count what reached each host.
//
// Rows that need the internet run only with GAMES_E2E_ONLINE=1; without it they are `skip`.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PORTS, REPO, serverBin, startGnomeServer } from './backend-lib.mjs';

export const FIXTURES = path.join(REPO, 'tests', 'e2e', 'engine', 'fixtures', 'games');
const CAPTURES = path.join(REPO, 'crates', 'catalog', 'tests', 'fixtures');
export const ONLINE = process.env.GAMES_E2E_ONLINE === '1';

/** The replayed sources and the adapter settings the captures were made with (§4.6, §9.1). */
export const REPLAY_SOURCES = 'gamepix,gamedistribution,playgama,gamemonetize,famobi,itchio,js13k';
export const REPLAY_ENV = {
  GNOME_GD_PUBLISHER_ID: 'e2e-publisher',
  GNOME_PLAYGAMA_CLID: 'e2e-clid',
  GNOME_GAMEMONETIZE_ENABLED: 'true',
  GNOME_FAMOBI_AFFILIATE_ID: 'A-E2E',
  GNOME_JS13K_FIRST_YEAR: '2026',
};

/** Every embed host the replayed records use (routed to embed.html), and the popup host of the probes. */
export const EMBED_HOSTS = ['play.gamepix.com', 'html5.gamedistribution.com', 'playgama.com', 'html5.gamemonetize.co', 'play.famobi.com', 'deadlydescent.net'];
export const POPUP_HOST = 'ads.e2e.invalid';

/**
 * Copies the unmodified captures into `<dir>/replay/` and writes the §4.6 index. Returns the index path. The
 * GameMonetize and Famobi captures are one full page each: their runs end as the CLI reports them (B1 reads the
 * reports, never constants).
 */
export function prepareReplay(dir) {
  const out = path.join(dir, 'replay');
  mkdirSync(out, { recursive: true });
  const files = [
    'gamepix-chess-p1.json',
    'gamepix-chess-p2.json',
    'gamepix-chess-p3.json',
    'gamedistribution-p1.json',
    'gamedistribution-end.json',
    'playgama-p1.json',
    'gamemonetize-p1.json',
    'famobi.json',
    'itch-free-web.xml',
    'js13k-2026.xml',
  ];
  for (const f of files) cpSync(path.join(CAPTURES, f), path.join(out, f));
  const index = {
    version: 1,
    note: 'Unmodified captures from crates/catalog/tests/fixtures (2026-11-10).',
    now: '2026-11-10T12:00:00Z',
    config: {
      gamepix: { per_page: 12, category: 'chess' },
      gamedistribution: { per_page: 10 },
      playgama: { per_page: 10 },
      gamemonetize: { per_page: 10 },
      itchio: { max_pages: 1 },
      js13k: { first_year: 2026 },
    },
    sources: {
      gamepix: [1, 2, 3].map((n) => ({ url_contains: ['/v2/json?', `&page=${n}&category=chess`], status: 200, file: `gamepix-chess-p${n}.json` })),
      gamedistribution: [
        { url_contains: ['catalog.api.gamedistribution.com', '&page=1&'], status: 200, file: 'gamedistribution-p1.json' },
        { url_contains: ['catalog.api.gamedistribution.com', '&page=2&'], status: 200, file: 'gamedistribution-end.json' },
      ],
      playgama: [{ url_contains: ['/catalogue/games'], status: 201, file: 'playgama-p1.json' }],
      gamemonetize: [{ url_contains: ['gamemonetize.com/feed.php?', '&page=1'], status: 200, file: 'gamemonetize-p1.json' }],
      famobi: [{ url_contains: ['api.famobi.com/feed'], status: 200, file: 'famobi.json' }],
      itchio: [{ url_contains: ['itch.io/games/free/platform-web.xml?page=1'], status: 200, file: 'itch-free-web.xml' }],
      js13k: [{ url_contains: ['js13kgames.com/2026/games.xml'], status: 200, file: 'js13k-2026.xml' }],
    },
  };
  const file = path.join(out, 'index.json');
  writeFileSync(file, JSON.stringify(index, null, 2));
  return file;
}

/** The OSS test game in `<dir>/oss-games/e2e-blocks/` and its manifest. */
export function prepareOss(dir) {
  const gamesDir = path.join(dir, 'oss-games');
  cpSync(path.join(FIXTURES, 'oss', 'e2e-blocks'), path.join(gamesDir, 'e2e-blocks'), { recursive: true });
  return { GNOME_OSS_MANIFEST: path.join(FIXTURES, 'oss-e2e.toml'), GNOME_OSS_GAMES_DIR: gamesDir };
}

/** Runs `gnome-server <args>` with exactly `env` (plus PATH). Returns {code, stdout, stderr, reports}. */
export function cli(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(serverBin(), args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('exit', (code) => {
      const reports = [];
      for (const line of stdout.split('\n')) {
        try {
          if (line.trim()) reports.push(JSON.parse(line));
        } catch {
          /* not a report line */
        }
      }
      resolve({ code, stdout, stderr, reports });
    });
  });
}

/**
 * A gnome-server with the replayed catalog and the OSS test game, both imported before it starts. `catalog`:
 * 'replay' (default), 'empty' (no import, no OSS build) or 'none' (GNOME_CATALOG_SOURCES=none).
 * Returns startGnomeServer's handle plus {dataDir, env, imports}.
 */
export async function startGamesServer({ dir, staticDir, env = {}, label = 'games', catalog = 'replay' }) {
  const dataDir = path.join(dir, `data-${label}-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });
  const oss = catalog === 'replay' ? prepareOss(dir) : { GNOME_OSS_MANIFEST: path.join(FIXTURES, 'oss-e2e.toml'), GNOME_OSS_GAMES_DIR: path.join(dir, 'oss-empty') };
  const sources = catalog === 'none' ? 'none' : `${REPLAY_SOURCES},oss`;
  const all = {
    // The binds the server gets (the CLI resolves the same two-origin setup: OSS needs the proxy origin, and
    // GameDistribution the public origin its embeds name).
    GNOME_BIND: `127.0.0.1:${PORTS.app}`,
    GNOME_PROXY_BIND: `127.0.0.1:${PORTS.proxy}`,
    GNOME_ADMIN_BIND: `127.0.0.1:${PORTS.admin}`,
    GNOME_PUBLIC_ORIGINS: `http://127.0.0.1:${PORTS.app}`,
    GNOME_DATA_DIR: dataDir,
    GNOME_STATIC_DIR: staticDir,
    GNOME_CATALOG_SOURCES: sources,
    GNOME_CATALOG_REFRESH_HOURS: '0',
    GNOME_OSS_FETCH: 'manual',
    GNOME_THUMB_PROXY: 'false',
    GNOME_ARGON2_MEMORY_KIB: '8192',
    GNOME_FILTERS_REFRESH_HOURS: '0',
    ...REPLAY_ENV,
    ...oss,
    ...env,
  };
  const imports = [];
  if (catalog === 'replay') {
    const index = prepareReplay(dir);
    const r = await cli(['catalog', 'import', '--replay', index], { ...all, GNOME_CATALOG_SOURCES: REPLAY_SOURCES, GNOME_LOG: 'warn' });
    imports.push({ kind: 'replay', ...r });
    const o = await cli(['catalog', 'import', '--source', 'oss'], { ...all, GNOME_LOG: 'warn' });
    imports.push({ kind: 'oss', ...o });
  }
  const server = await startGnomeServer({ dir, staticDir, env: all, label });
  return { ...server, dataDir, env: { ...server.env }, imports };
}

const EMBED_HTML = () => readFileSync(path.join(FIXTURES, 'embed.html'), 'utf8');
/** A 1×1 PNG for network images (thumbnail proxy off): generated, never fetched. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i;

/**
 * Answers every embed host with embed.html, the popup host with a small page, and network images with the PNG.
 * Every request that reaches a routed host is counted in the returned `hits` (host → count) and `requests` list.
 * Other non-local hosts are aborted (and recorded in `unrouted`), so nothing leaves the machine.
 */
export async function routeEmbeds(context, { app, proxy }) {
  const hits = new Map();
  const requests = [];
  const unrouted = [];
  const local = new Set([new URL(app).host, new URL(proxy).host]);
  await context.route(
    (url) => !local.has(url.host),
    async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      requests.push({ host: u.host, url: req.url(), dest: req.headers()['sec-fetch-dest'] ?? null, referer: req.headers().referer ?? null });
      if (EMBED_HOSTS.includes(u.hostname) || u.hostname === POPUP_HOST) {
        hits.set(u.hostname, (hits.get(u.hostname) ?? 0) + 1);
        if (IMAGE_RE.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        if (u.hostname === POPUP_HOST) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>popup</title><p>popup</p>' });
        return route.fulfill({ status: 200, contentType: 'text/html', body: EMBED_HTML() });
      }
      if (req.resourceType() === 'image') {
        hits.set(u.hostname, (hits.get(u.hostname) ?? 0) + 1);
        return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      }
      unrouted.push(req.url());
      return route.abort('blockedbyclient');
    },
  );
  return { hits, requests, unrouted, count: (host) => hits.get(host) ?? 0 };
}

/** JSON GET (no-store) with status and headers. */
export async function getJson(url, init = {}) {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** Every game of a listing query, following next_cursor. */
export async function allGames(app, query = '') {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams(query);
    q.set('limit', '100');
    if (cursor) q.set('cursor', cursor);
    const r = await getJson(`${app}/api/games?${q}`);
    if (r.status !== 200) throw new Error(`/api/games ${r.status}: ${r.text.slice(0, 200)}`);
    items.push(...r.json.items);
    cursor = r.json.next_cursor;
    if (!cursor) break;
  }
  return items;
}

/** One game per source among the listed (playable) games, plus the link-out ones, from the API. */
export async function gamesBySource(app) {
  const playable = await allGames(app);
  const linkOut = (await allGames(app, 'include_link_out=1')).filter((g) => !playable.some((p) => p.id === g.id));
  const bySource = new Map();
  for (const g of playable) if (!bySource.has(g.source)) bySource.set(g.source, g);
  return { playable, linkOut, bySource };
}
