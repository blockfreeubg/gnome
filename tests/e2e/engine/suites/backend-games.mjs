// backend-games (docs/WAVE-C.md §9.2): the games backend against the real gnome-server (release build) with the
// replayed catalog (D19) and the OSS test game. HTTP rows once (the first browser of the run), browser rows (B13) in
// every browser. Standalone: its own server on the standalone port block (games-lib.mjs).
//
//   node tests/e2e/engine/suites/backend-games.mjs --browser chromium,firefox --static <frontend dist>
//
// Ports (BACKEND_E2E_PORT_BASE): +0/+1/+2 the catalog server, +40/+41/+42 the runner-like server of B18, +43/+44/+45
// the job-path server of B14. Rows not written yet are listed as `skip` with "[unproven]".
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupAll, installSignalHandlers, launchBrowser, parseArgs, portBase, recorder, sleep, startGnomeServer, summarize, workDir, writeResults,
} from './backend-lib.mjs';
import { allGames, cli, getJson, prepareOss, REPLAY_SOURCES, startGamesServer } from './games-lib.mjs';

export const standalone = true;

const SUMMARY_KEYS = ['added_at', 'categories', 'developer', 'id', 'mobile', 'playable', 'plays', 'slug', 'source', 'thumbnail', 'title'];
const DETAIL_KEYS = [
  ...SUMMARY_KEYS, 'attribution', 'description', 'developer_url', 'embed_allowed', 'embed_kind', 'embed_url', 'flags', 'height', 'instructions',
  'license', 'orientation', 'oss', 'published_at', 'source_url', 'tags', 'width',
].sort();
const keys = (o) => Object.keys(o ?? {}).sort().join(',');
const PERMISSIONS = /(^|, )camera=\(\)/;

/** Rows over HTTP (once per run). */
async function httpRows(ctx) {
  const { record, stack } = ctx;
  const { server, imports, extra } = stack;
  const app = server.appOrigin;
  const admin = server.adminOrigin;
  const rec = (test, ok, notes = '') => record({ test, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes) });

  // B1: the replay import, one JSON report per source with the recorded status; Playgama fails → exit 1.
  const replay = imports.find((i) => i.kind === 'replay');
  const statusOf = Object.fromEntries(replay.reports.map((r) => [r.source, r.status]));
  const want = { gamepix: 'complete', gamedistribution: 'complete', playgama: 'failed', itchio: 'complete', js13k: 'complete' };
  rec(
    'B1 catalog import --replay: one report per source with the recorded status, exit 1 for Playgama’s failed run',
    replay.code === 1 && Object.entries(want).every(([k, v]) => statusOf[k] === v) && replay.reports.length === REPLAY_SOURCES.split(',').length,
    { code: replay.code, statusOf },
  );
  {
    const dir = path.join(ctx.dir, 'bad-replay');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, sources: { gamepix: [{ url_contains: ['x'], status: 200, file: '../x.json' }] } }));
    const bad = await cli(['catalog', 'import', '--replay', path.join(dir, 'index.json')], { ...server.env, GNOME_DATA_DIR: path.join(dir, 'data') });
    rec('B1 --replay with .. in the index exits 2', bad.code === 2, `exit ${bad.code}: ${bad.stderr.trim().slice(0, 200)}`);
  }

  // B2: /api/config features.
  const cfg = (await getJson(`${app}/api/config`)).json;
  rec('B2 /api/config: features.games true, thumb_proxy as configured (false)', cfg?.features?.games === true && cfg.features.thumb_proxy === false, cfg?.features);

  // B3: shapes.
  const list = (await getJson(`${app}/api/games?limit=5`)).json;
  const oss = (await getJson(`${app}/api/games?q=blocks&limit=5`)).json.items.find((g) => g.source === 'oss');
  const detail = (await getJson(`${app}/api/games/${oss?.slug}`)).json;
  const sections = (await getJson(`${app}/api/games/sections`)).json;
  const cats = (await getJson(`${app}/api/games/categories`)).json;
  const tags = (await getJson(`${app}/api/games/tags?limit=5`)).json;
  const byIds = (await getJson(`${app}/api/games/by-ids?ids=${list.items.map((g) => g.id).join(',')}`)).json;
  const status = (await getJson(`${app}/api/games/status`)).json;
  const shapes = {
    list: keys(list) === 'items,next_cursor,total' && list.items.every((g) => keys(g) === SUMMARY_KEYS.join(',')),
    detail: keys(detail) === 'game,related' && keys(detail.game) === DETAIL_KEYS.join(',') && keys(detail.game.oss) === 'commit,license_file_url,repository',
    sections: keys(sections) === 'featured,new,popular,trending',
    categories: keys(cats) === 'categories' && cats.categories.every((c) => keys(c) === 'count,name,slug') && cats.categories.length >= 14,
    tags: keys(tags) === 'tags' && tags.tags.every((t) => keys(t) === 'count,tag'),
    byIds: keys(byIds) === 'items' && byIds.items.length === list.items.length,
    status: keys(status) === 'importing,listed,playable,sources' && status.sources.every((s) => keys(s) === 'id,last_import,name'),
  };
  rec('B3 every route’s keys equal the client’s shapes (GameSummary, GameDetail with embed_allowed and oss, sections, categories, tags, by-ids, status)', Object.values(shapes).every(Boolean), { shapes, detailKeys: keys(detail?.game) });

  // B4: paging with limit=12 returns every listed game once; total constant; a cursor reused with another exclude → 400.
  {
    const seen = new Set();
    let cursor = null;
    let totals = new Set();
    let pages = 0;
    let dup = 0;
    let firstCursor = null;
    do {
      const r = (await getJson(`${app}/api/games?limit=12${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json;
      totals.add(r.total);
      for (const g of r.items) (seen.has(g.id) ? dup++ : seen.add(g.id));
      cursor = r.next_cursor;
      firstCursor ??= cursor;
      pages++;
    } while (cursor && pages < 50);
    rec('B4 paging: next_cursor with limit=12 returns every listed game once, total constant', dup === 0 && totals.size === 1 && seen.size === [...totals][0], { pages, seen: seen.size, totals: [...totals], dup });
    const other = await getJson(`${app}/api/games?limit=12&exclude=puzzle&cursor=${encodeURIComponent(firstCursor)}`);
    rec('B4 a cursor reused with another exclude → 400 "cursor does not belong to this query"', other.status === 400 && other.json?.error?.message === 'cursor does not belong to this query', other.text.slice(0, 200));
  }

  // B5: search and filters.
  {
    const chess = (await getJson(`${app}/api/games?q=chess&limit=100`)).json;
    const che = (await getJson(`${app}/api/games?q=che&limit=100`)).json;
    const ch = (await getJson(`${app}/api/games?q=ch&limit=100`)).json;
    const firstTitleMatch = chess.items.length > 0 && /chess/i.test(chess.items[0].title);
    rec('B5 search: "chess" finds games, title matches first; "che" (prefix) finds at least as many; "ch" whole words only', firstTitleMatch && che.total >= chess.total && ch.total < che.total, { chess: chess.total, che: che.total, ch: ch.total, first: chess.items[0]?.title });
    const puzzle = (await getJson(`${app}/api/games?category=puzzle&limit=100`)).json;
    const noPuzzle = (await getJson(`${app}/api/games?exclude=puzzle&limit=100`)).json;
    const mobile = (await getJson(`${app}/api/games?mobile=1&limit=100`)).json;
    const total = list.total;
    rec(
      'B5 category, exclude and mobile filters with their totals',
      puzzle.items.every((g) => g.categories.includes('puzzle')) &&
        noPuzzle.items.every((g) => !g.categories.includes('puzzle')) &&
        noPuzzle.total + puzzle.total === total &&
        mobile.items.every((g) => g.mobile) &&
        mobile.total <= total,
      { total, puzzle: puzzle.total, noPuzzle: noPuzzle.total, mobile: mobile.total },
    );
  }

  // B6: the 400 messages and the 404s (unknown slug; hidden and broken by the admin).
  {
    const cases = [
      ['limit=0', 'limit must be 1-100'],
      ['category=nope', 'unknown category: nope'],
      ['sort=nope', 'unknown sort: nope'],
      ['cursor=zzz', 'invalid cursor'],
      [`q=${'a'.repeat(101)}`, 'q is limited to 100 characters'],
      [`exclude=${Array.from({ length: 21 }, (_, i) => `c${i}`).join(',')}`, 'at most 20 categories can be excluded'],
    ];
    const bad = [];
    for (const [q, msg] of cases) {
      const r = await getJson(`${app}/api/games?${q}`);
      if (r.status !== 400 || r.json?.error?.code !== 'bad_request' || r.json?.error?.message !== msg) bad.push({ q: q.slice(0, 30), status: r.status, got: r.json?.error });
    }
    const ids = await getJson(`${app}/api/games/by-ids?ids=a,b`);
    if (ids.json?.error?.message !== 'ids must be comma-separated integers') bad.push({ ids: ids.json?.error });
    const tagp = await getJson(`${app}/api/games/tags?prefix=${'a'.repeat(41)}`);
    if (tagp.json?.error?.message !== 'tag prefix is limited to 40 characters') bad.push({ tags: tagp.json?.error });
    rec('B6 the 400 bad_request messages of §4.2', bad.length === 0, bad);
    const unknown = await getJson(`${app}/api/games/no-such-game`);
    const [h, b] = list.items;
    const setStatus = (id, s) => fetch(`${admin}/admin/games/${id}/status`, { method: 'POST', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ status: s }) });
    const r1 = await setStatus(h.id, 'hidden');
    const r2 = await setStatus(b.id, 'broken');
    const gh = await getJson(`${app}/api/games/${h.slug}`);
    const gb = await getJson(`${app}/api/games/${b.slug}`);
    await setStatus(h.id, null);
    await setStatus(b.id, null);
    const back = await getJson(`${app}/api/games/${h.slug}`);
    rec('B6 404 for an unknown slug and for games the admin set hidden / broken (and back after clearing)', unknown.status === 404 && r1.status === 204 && r2.status === 204 && gh.status === 404 && gb.status === 404 && back.status === 200, {
      unknown: unknown.status, admin: [r1.status, r2.status], hidden: gh.status, broken: gb.status, back: back.status,
    });
  }

  // B7: the play counter.
  {
    const g = list.items[0];
    const ok = await fetch(`${app}/api/games/${g.slug}/play`, { method: 'POST', headers: { 'X-GNOME-Request': '1' } });
    const csrf = await fetch(`${app}/api/games/${g.slug}/play`, { method: 'POST' });
    const unknown = await fetch(`${app}/api/games/no-such-game/play`, { method: 'POST', headers: { 'X-GNOME-Request': '1' } });
    rec('B7 POST /api/games/:slug/play → 204; without X-GNOME-Request → 403; unknown → 404', ok.status === 204 && csrf.status === 403 && unknown.status === 404, [ok.status, csrf.status, unknown.status]);
  }

  // B8: status while an import runs and after (the oss run through the admin endpoint is quick: poll fast).
  // B11: POST /admin/catalog/import {"sources":["oss"]} → 202; 409 while it runs; 422 for crates.
  {
    const post = (body) => fetch(`${admin}/admin/catalog/import`, { method: 'POST', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await post({ sources: ['crates'] });
    // Only the oss source (no network): two requests at once, so the second finds the first still running.
    const [started, again] = await Promise.all([post({ sources: ['oss'] }), post({ sources: ['oss'] })]);
    const codes = [started.status, again.status].sort();
    let importing = false;
    let after = null;
    for (let i = 0; i < 200; i++) {
      const s = (await getJson(`${app}/api/games/status`)).json;
      importing ||= s.importing === true;
      if (!s.importing) {
        after = s;
        break;
      }
      await sleep(25);
    }
    const ossStatus = after?.sources.find((x) => x.id === 'oss');
    rec('B11 POST /admin/catalog/import → 202, 409 while it runs, 422 for an unknown source', codes[0] === 202 && codes[1] === 409 && bad.status === 422, { codes, bad: bad.status });
    // [unproven] seeing importing:true: the oss run takes milliseconds, so the poll may miss it (noted, not required).
    rec('B8 /api/games/status: after a run, last_import of that run (importing seen while it ran: see notes)', after !== null && ossStatus?.last_import?.status === 'complete', { sawImporting: importing, last: ossStatus?.last_import });
    const ossRun = await post({ sources: ['oss'] });
    let runs = null;
    for (let i = 0; i < 50; i++) {
      runs = (await getJson(`${admin}/admin/catalog/imports?source=oss`)).json?.runs ?? [];
      if (runs.length >= 2 && runs[0].finished_at) break;
      await sleep(200);
    }
    const listed = (await getJson(`${app}/api/games?q=blocks`)).json.items.some((g) => g.slug === 'e2e-blocks');
    rec('B11 an oss import through the admin endpoint lists the test game', ossRun.status === 202 && listed, { status: ossRun.status, runs: runs?.length });
  }

  // B9 + B10: shell framing, the wrapper per source, the deadlydescent.net game, COOP / Permissions-Policy.
  {
    const index = await fetch(`${app}/`);
    const csp = index.headers.get('content-security-policy') ?? '';
    const frameSrc = /frame-src ([^;]*)/.exec(csp)?.[1]?.trim();
    rec("B9 index.html: frame-src blob: 'self' <proxy origin>, frame-ancestors 'none', X-Frame-Options: DENY", frameSrc === `blob: 'self' ${server.proxyOrigin}` && /frame-ancestors 'none'/.test(csp) && index.headers.get('x-frame-options') === 'DENY', { frameSrc });
    const { bySource } = await bySourceOf(app);
    const wrappers = [];
    for (const [source, g] of bySource) {
      const d = (await getJson(`${app}/api/games/${g.slug}`)).json.game;
      const r = await fetch(`${app}/play-frame/${g.slug}`);
      const wcsp = r.headers.get('content-security-policy') ?? '';
      const want = source === 'oss' ? `${server.proxyOrigin}/oss/${g.slug}/` : new URL(d.embed_url).origin;
      const fs = /frame-src ([^;]*)/.exec(wcsp)?.[1]?.trim();
      wrappers.push({ source, status: r.status, ok: r.status === 200 && fs === want && /default-src 'none'/.test(wcsp), fs, want });
    }
    rec('B9 /play-frame/<slug> of one game per replayed source: wrapper_csp names only that game’s origin', wrappers.length >= 6 && wrappers.every((w) => w.ok), wrappers.filter((w) => !w.ok).concat([{ sources: wrappers.map((w) => w.source) }]));
    const pend = await pendingGame(app);
    const ddWrap = pend ? await fetch(`${app}/play-frame/${pend.slug}`) : null;
    const diag = (await getJson(`${admin}/admin/diagnostics`)).json;
    const pendingHosts = JSON.stringify(diag?.games ?? {}).includes('deadlydescent.net');
    rec('B9 the deadlydescent.net game: wrapper 404, embed_allowed false, pending in /admin/diagnostics', !!pend && ddWrap.status === 404 && pend.embed_allowed === false && pendingHosts, { slug: pend?.slug, wrapper: ddWrap?.status, pendingHosts });
    // B10
    const shellCoop = index.headers.get('cross-origin-opener-policy');
    const shellPP = index.headers.get('permissions-policy') ?? '';
    const anyGame = [...bySource.values()][0];
    const wrap = await fetch(`${app}/play-frame/${anyGame.slug}`);
    const api = await fetch(`${app}/api/games/status`);
    const proxy = await fetch(`${server.proxyOrigin}/engine/`);
    const imgSrc = /img-src ([^;]*)/.exec(csp)?.[1] ?? '';
    rec(
      'B10 app HTML (shell and wrapper) carries COOP same-origin and the Permissions-Policy; JSON and proxy-role answers do not; img-src has the proxy origin',
      shellCoop === 'same-origin' && wrap.headers.get('cross-origin-opener-policy') === 'same-origin' && PERMISSIONS.test(shellPP) && wrap.headers.get('permissions-policy') === shellPP &&
        api.headers.get('cross-origin-opener-policy') === null && api.headers.get('permissions-policy') === null && proxy.headers.get('permissions-policy') === null && imgSrc.includes(server.proxyOrigin),
      { shellCoop, pp: shellPP.slice(0, 60), apiCoop: api.headers.get('cross-origin-opener-policy'), proxyPP: proxy.headers.get('permissions-policy'), imgSrc },
    );
    ctx.stack.pending = pend;
  }

  // B12: /oss/e2e-blocks/** on the proxy origin.
  {
    const P = server.proxyOrigin;
    const get = (p, dest) => fetch(`${P}${p}`, { headers: dest ? { 'sec-fetch-dest': dest } : {} });
    const entry = await get('/oss/e2e-blocks/index.html', 'iframe');
    const ecsp = entry.headers.get('content-security-policy') ?? '';
    const etag = entry.headers.get('etag');
    const again = await fetch(`${P}/oss/e2e-blocks/index.html`, { headers: { 'sec-fetch-dest': 'iframe', 'if-none-match': etag ?? '' } });
    const doc = await get('/oss/e2e-blocks/index.html', 'document');
    const none = await get('/oss/e2e-blocks/index.html');
    const js = await get('/oss/e2e-blocks/game.js', 'script');
    const svg = await get('/oss/e2e-blocks/icon.svg', 'image');
    const lic = await get('/oss/e2e-blocks/LICENSE', 'document');
    const trav = [];
    for (const p of ['/oss/e2e-blocks/%2e%2e/x', '/oss/e2e-blocks/..%2fgame.js', '/oss/e2e-blocks/.gnome-oss.json', '/oss/e2e-blocks/.hidden', '/oss/e2e-blocks/', '/oss/e2e-blocks']) trav.push([p, (await get(p, 'iframe')).status]);
    const appSide = await fetch(`${app}/oss/e2e-blocks/index.html`, { headers: { 'sec-fetch-dest': 'iframe' } });
    const ok =
      entry.status === 200 && /^text\/html/.test(entry.headers.get('content-type') ?? '') && /default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; form-action 'self'; frame-ancestors /.test(ecsp) &&
      entry.headers.get('x-content-type-options') === 'nosniff' && !!etag && again.status === 304 && doc.status === 404 && none.status === 404 &&
      js.status === 200 && (js.headers.get('content-security-policy') ?? '') !== ecsp && svg.status === 200 && lic.status === 200 && /^text\/plain/.test(lic.headers.get('content-type') ?? '') &&
      trav.every(([, s]) => s === 404) && appSide.status === 404;
    rec('B12 /oss/e2e-blocks/: the entry only as a frame with the OSS document CSP, ETag/304, scripts / inert files their policies, LICENSE text/plain, traversal 404, app origin 404', ok, {
      entry: entry.status, ecsp: ecsp.slice(0, 160), again: again.status, doc: doc.status, none: none.status, js: js.status, svg: svg.status, lic: [lic.status, lic.headers.get('content-type')], trav, appSide: appSide.status,
    });
  }

  // B15: /ads.txt (unset here → 404; the set case runs on the B14 server).
  rec('B15 /ads.txt unset → 404', (await fetch(`${app}/ads.txt`)).status === 404);
  {
    const r = await fetch(`${extra.job.appOrigin}/ads.txt`);
    rec('B15 GNOME_ADS_TXT set → /ads.txt is the file as text/plain', r.status === 200 && /^text\/plain/.test(r.headers.get('content-type') ?? '') && (await r.text()) === extra.job.adsTxt);
  }
  // B16: thumbnails.
  {
    const r = await fetch(`${app}/api/thumb/${oss.id}`);
    rec('B16 /api/thumb/<oss game> → 404 (here the thumbnail proxy is off: 404 either way)', r.status === 404, String(r.status));
    record({ test: 'B16 one GamePix thumbnail through the proxy, then a cache hit', result: 'skip', notes: 'GAMES_E2E_ONLINE=1 only [unproven]' });
  }

  // B17: config check warnings.
  {
    const base = { GNOME_DATA_DIR: path.join(ctx.dir, 'cc-data'), GNOME_STATIC_DIR: ctx.staticDir };
    const prof = path.join(ctx.dir, 'profiles.toml');
    writeFileSync(prof, '[[profile]]\nid = "e2e-x"\nlabel = "X"\ncountry_code = "se"\ncountry = "Sweden"\ncity = "X"\nwisp_upstream = "127.0.0.1:9"\n');
    const run = async (env) => {
      const r = await cli(['config', 'check'], { ...base, ...env });
      return `${r.stdout}\n${r.stderr}`;
    };
    const open = await run({ GNOME_VPN_PROFILES: prof, GNOME_ACCESS_MODE: 'open' });
    const okShared = await run({ GNOME_VPN_PROFILES: prof, GNOME_ACCESS_MODE: 'open', GNOME_VPN_EGRESS_SHARED_OK: 'true' });
    const vars = await run({});
    const single = await run({ GNOME_CATALOG_SOURCES: 'gamepix,oss' });
    const warnsTerms = (t) => /warning:[^\n]*(terms|share)/i.test(t);
    rec('B17 config check prints the catalog and check variables; D16 warning for profiles + open mode, silent with GNOME_VPN_EGRESS_SHARED_OK; the single-origin oss warning', /GNOME_CATALOG_SOURCES/.test(vars) && /GNOME_VPN_CHECK_URL/.test(vars) && warnsTerms(open) && !warnsTerms(okShared) && /open-source games need a separate proxy origin/.test(single), {
      open: warnsTerms(open), shared: warnsTerms(okShared),
    });
    record({ test: 'B17 the accounts + open registration warning, none with closed registration, the code-mode warning, the no-check-service warning', result: 'skip', notes: '[unproven] not written yet (vpn_exit.rs / config.rs unit tests cover them)' });
  }

  // B14 + B18: the extra servers started at the beginning.
  {
    const t0 = extra.job.startedAt;
    let runs = (await getJson(`${extra.job.adminOrigin}/admin/catalog/imports?source=oss`)).json?.runs ?? [];
    while (!runs.length && Date.now() - t0 < 45_000) {
      await sleep(1000);
      runs = (await getJson(`${extra.job.adminOrigin}/admin/catalog/imports?source=oss`)).json?.runs ?? [];
    }
    const ms = (v) => (typeof v === 'number' && v < 1e12 ? v * 1000 : v);
    const firstAt = runs.length ? Math.min(...runs.map((r) => ms(r.started_at))) : null;
    rec('B14 the job path: with refresh 0 and only oss enabled, an oss run started by catalog.import within 45 s of start', firstAt !== null && firstAt - t0 <= 45_000, { runs: runs.length, first_after_s: firstAt && Math.round((firstAt - t0) / 1000), keys: Object.keys(runs[0] ?? {}).join(',') });
    const wait = 60_000 - (Date.now() - extra.idle.startedAt);
    if (wait > 0) await sleep(wait);
    const idleRuns = (await getJson(`${extra.idle.adminOrigin}/admin/catalog/imports`)).json?.runs;
    const diag = (await getJson(`${extra.idle.adminOrigin}/admin/diagnostics`)).json;
    const lastFetch = diag?.games?.oss?.last_fetch;
    // Narrowed (plan conflict, see the report): §4.6 imports `oss` at the first tick even with refresh 0 (no network
    // involved), so the list holds that one oss run; no feed source may have run and no OSS build was fetched.
    const feedRuns = (idleRuns ?? []).filter((r) => r.source !== 'oss');
    rec('B18 a server with the runner’s base environment imports no feed for 60 s (only §4.6’s local oss scan) and fetches no OSS build', Array.isArray(idleRuns) && feedRuns.length === 0 && lastFetch === null, { runs: (idleRuns ?? []).map((r) => r.source), lastFetch });
  }
}

/** One playable game per source. */
async function bySourceOf(app) {
  const bySource = new Map();
  for (const g of await allGames(app)) if (!bySource.has(g.source)) bySource.set(g.source, g);
  return { bySource };
}

/** The Playgama game whose embed is on the developer host deadlydescent.net (not approved: embed_allowed false). */
async function pendingGame(app) {
  for (const g of await allGames(app, 'include_link_out=1')) {
    if (g.source !== 'playgama') continue;
    const d = (await getJson(`${app}/api/games/${g.slug}`)).json?.game;
    if (d && /deadlydescent\.net/.test(d.embed_url)) return d;
  }
  return null;
}

/** B13 (every browser): the OSS entry is not a top-level document and not frameable by a proxy-origin parent. */
async function browserRows(ctx) {
  const { record, stack } = ctx;
  const { server } = stack;
  const browser = await ctx.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    // Chromium and Firefox report an empty 404 as a navigation error; either way the game must not be there.
    const status = await page.goto(`${server.proxyOrigin}/oss/e2e-blocks/index.html`).then((r) => r?.status(), (e) => (/ERR_HTTP_RESPONSE_CODE_FAILURE|NS_ERROR_NET_EMPTY_RESPONSE/.test(String(e)) ? 404 : String(e).slice(0, 80)));
    const top = { status, canvas: await page.locator('canvas').count() };
    record({ test: 'B13 a top-level navigation to /oss/e2e-blocks/index.html shows the 404, not the game', result: top.status === 404 && top.canvas === 0 ? 'pass' : 'fail', notes: JSON.stringify(top) });
    // A plain proxy-origin parent: the engine host opened top-level navigates itself away, which destroyed the
    // evaluation context in Chromium (c-gate, 2026-11-23); a routed blank page on the proxy origin is a stable parent,
    // and the frame request still goes to the real server (whose frame-ancestors decides).
    await page.route(`${server.proxyOrigin}/gnome-b13-parent`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>parent</title><body></body>' }));
    await page.goto(`${server.proxyOrigin}/gnome-b13-parent`).catch(() => undefined);
    const framed = await page.evaluate(async () => {
      const f = document.createElement('iframe');
      f.src = '/oss/e2e-blocks/index.html';
      document.body.append(f);
      await new Promise((r) => setTimeout(r, 1500));
      try {
        return { readable: true, canvas: f.contentDocument?.querySelector('canvas') !== null && f.contentDocument !== null };
      } catch {
        return { readable: false, canvas: false };
      }
    });
    record({ test: 'B13 a proxy-origin parent’s <iframe src="/oss/e2e-blocks/index.html"> does not load (frame-ancestors names the app origins only)', result: framed.canvas ? 'fail' : 'pass', notes: JSON.stringify(framed) });
    record({ test: 'B13 the probe set evaluated in the OSS frame inside the player’s wrapper reaches no sentinel', result: 'skip', notes: '[unproven] the probe set is not copied into games-lib.mjs yet' });
  } finally {
    await browser.close();
  }
}

export async function run(ctx) {
  if (!ctx.stack?.server) {
    ctx.record({ test: 'backend-games', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/backend-games.mjs' });
    return;
  }
  if (ctx.first) await httpRows(ctx);
  await browserRows(ctx);
}

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  if (!args.static) throw new Error('--static <frontend dist> is required');
  const dir = workDir(`backend-games-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const all = [];
  try {
    // B18: a server like the runner's shared one (its base environment, default sources), and B14: only oss.
    const b = portBase();
    const idleDir = path.join(dir, 'idle');
    mkdirSync(idleDir, { recursive: true });
    const idle = await startGnomeServer({ dir: idleDir, staticDir: args.static, label: 'idle', env: { GNOME_BIND: `127.0.0.1:${b + 40}`, GNOME_PROXY_BIND: `127.0.0.1:${b + 41}`, GNOME_ADMIN_BIND: `127.0.0.1:${b + 42}` } });
    idle.startedAt = Date.now();
    const jobDir = path.join(dir, 'job');
    mkdirSync(jobDir, { recursive: true });
    const adsTxt = 'e2e.example, pub-0000000000000000, DIRECT\n';
    writeFileSync(path.join(jobDir, 'ads.txt'), adsTxt);
    const job = await startGnomeServer({
      dir: jobDir,
      staticDir: args.static,
      label: 'job',
      env: {
        GNOME_BIND: `127.0.0.1:${b + 43}`, GNOME_PROXY_BIND: `127.0.0.1:${b + 44}`, GNOME_ADMIN_BIND: `127.0.0.1:${b + 45}`,
        GNOME_CATALOG_SOURCES: 'oss', ...prepareOss(jobDir), GNOME_ADS_TXT: path.join(jobDir, 'ads.txt'),
      },
    });
    Object.assign(job, { startedAt: Date.now(), adsTxt });
    const server = await startGamesServer({ dir, staticDir: args.static, label: 'games' });
    const stack = { server, imports: server.imports, extra: { idle, job } };
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows, record } = recorder(name);
      const ctx = { browser: name, first: name === args.browsers[0], dir, staticDir: args.static, launch: (o) => launchBrowser(name, o), record, log: console.log, sleep, stack };
      try {
        await run(ctx);
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...rows);
    }
  } finally {
    await cleanupAll();
  }
  writeResults(dir, 'backend-games', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
