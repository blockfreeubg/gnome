// games-ui (docs/WAVE-C.md §9.3): the Games pages (lane g2) against the real gnome-server with the replayed catalog
// and the OSS test game, in every browser of the run. Standalone: its own server (games-lib.mjs), the e2e frontend
// build the runner passes (--static). Names and roles are §3.3's test contract.
//
//   node tests/e2e/engine/suites/games-ui.mjs --browser chromium,firefox --static <frontend dist>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupAll, installSignalHandlers, launchBrowser, parseArgs, recorder, sleep, summarize, workDir, writeResults } from './backend-lib.mjs';
import { allGames, getJson, routeEmbeds, startGamesServer } from './games-lib.mjs';

export const standalone = true;

async function withPage(ctx, fn, { viewport } = {}) {
  const browser = await ctx.launch();
  try {
    const context = await browser.newContext(viewport ? { viewport } : {});
    const net = await routeEmbeds(context, { app: ctx.stack.server.appOrigin, proxy: ctx.stack.server.proxyOrigin });
    const page = await context.newPage();
    const apiRequests = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/games')) apiRequests.push(r.url());
    });
    return await fn({ page, context, net, apiRequests });
  } finally {
    await browser.close();
  }
}

async function rows(ctx) {
  const { record, stack } = ctx;
  const app = stack.server.appOrigin;
  const rec = (test, ok, notes = '') => record({ test, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes) });
  const status = (await getJson(`${app}/api/games/status`)).json;
  const all = (await getJson(`${app}/api/games?limit=1`)).json.total;

  // U1, U2, U3, U11: the page, search, selects, link-out tiles.
  await withPage(ctx, async ({ page, net }) => {
    await page.goto(`${app}/games`);
    await page.getByRole('heading', { level: 1, name: 'Games' }).waitFor({ timeout: 20_000 });
    const grid = page.getByRole('grid', { name: 'All games' });
    await grid.waitFor({ timeout: 20_000 });
    const shelves = {};
    for (const name of ['Featured', 'Trending', 'Popular', 'Recently added']) shelves[name] = await page.getByRole('region', { name }).getByRole('link').count();
    const more = status.listed - status.playable;
    const wantLine = new RegExp(`${status.playable} games to play here from .+ · ${more} more on other sites`);
    const header = await page.getByText(wantLine).first().innerText().catch(() => (page.locator('main').innerText().then((t) => t.slice(0, 300))));
    const linkOutInGrid = await grid.getByRole('link', { name: /\(opens on / }).count();
    rec('U1 /games: heading, the four server shelves not empty, "All games" with playable tiles only, the status line with the API’s counts', Object.values(shelves).every((n) => n > 0) && wantLine.test(header) && linkOutInGrid === 0, { shelves, header: header.slice(0, 160), playable: status.playable, more });

    const search = page.getByRole('searchbox', { name: 'Search games' });
    await search.fill('chess');
    const chess = (await getJson(`${app}/api/games?q=chess&include_link_out=1&limit=1`)).json.total;
    const chessPlayable = (await getJson(`${app}/api/games?q=chess&limit=1`)).json.total;
    const count = page.getByRole('status').filter({ hasText: /results?$/ });
    await count.first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    const countText = (await count.first().innerText().catch(() => '')).trim();
    const n = Number(countText.replace(/[^0-9]/g, ''));
    const url = new URL(page.url());
    rec('U2 search: "chess" shows "<n> results" equal to the API’s total; the URL keeps q', (n === chess || n === chessPlayable) && url.searchParams.get('q') === 'chess', { countText, chess, chessPlayable, q: url.searchParams.get('q') });
    // U11: link-out tiles in search results: "(opens on …)" names; no iframe for them.
    const results = page.getByRole('grid', { name: 'Search results' });
    await results.waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.getByRole('searchbox', { name: 'Search games' }).fill('js13k');
    await sleep(1200);
    const linkOut = await page.getByRole('link', { name: /\(opens on (itch\.io|js13kGames)\)$/ }).count();
    const frames = page.frames().length;
    rec('U11 link-out tiles in search results carry "(opens on itch.io|js13kGames)", no iframe is created for them', linkOut > 0 && frames === 1, { linkOut, frames });
    await search.fill('');
    await page.getByRole('grid', { name: 'All games' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    const restored = await page.getByRole('region', { name: 'Featured' }).count();
    rec('U2 clearing the search restores the shelves', restored === 1, String(restored));

    // U3: the Category select lists "All categories" and the 14 core categories.
    const cat = page.getByRole('combobox', { name: 'Category' });
    await cat.click();
    const options = await page.getByRole('option').allInnerTexts();
    await page.keyboard.press('Escape');
    const cats = (await getJson(`${app}/api/games/categories`)).json.categories;
    const core = ['Action', 'Adventure', 'Arcade', 'Racing', 'Sports', 'Puzzle', 'Strategy', 'Multiplayer', 'Simulation', 'Idle', 'Platformer', 'Casual', 'Horror', 'Sandbox'];
    rec('U3 the Category select lists "All categories" and all 14 core categories', /All categories/.test(options[0] ?? '') && core.every((c) => options.some((o) => o.includes(c))), { options: options.slice(0, 20), api: cats.length });
    await page.goto(`${app}/games?category=puzzle`);
    const pg = page.getByRole('grid', { name: /Puzzle games/ });
    await pg.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const first = (await pg.getByRole('link').first().getAttribute('aria-label').catch(() => null)) ?? '';
    const api = (await getJson(`${app}/api/games?category=puzzle&limit=48`)).json.items;
    rec('U3 a category grid’s first tile is the API’s first item for that query', !!first && first.startsWith(api[0]?.title ?? '\u0000'), { first, api: api[0]?.title });
    void net;
  });

  // U4: virtualization over every page of "All games".
  await withPage(ctx, async ({ page, apiRequests }) => {
    await page.goto(`${app}/games?sort=az`);
    const grid = page.getByRole('grid', { name: 'All games' });
    await grid.waitFor({ timeout: 20_000 });
    let maxCells = 0;
    const titles = new Set();
    const box = await grid.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 80, 700));
    for (let i = 0; i < 60; i++) {
      const names = await grid.getByRole('link').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      for (const t of names) titles.add(t);
      maxCells = Math.max(maxCells, await grid.getByRole('gridcell').count());
      await page.mouse.wheel(0, 1200);
      await sleep(120);
    }
    const pages = apiRequests.filter((u) => /\/api\/games\?/.test(u) && /sort=az/.test(u));
    const withCursor = pages.filter((u) => /cursor=/.test(u)).length;
    const allLimit48 = pages.every((u) => /limit=48/.test(u));
    const lastTitle = (await allGames(app, 'sort=az')).at(-1)?.title;
    rec('U4 virtualization: scrolling loads every page once (cursor, limit=48), never more than 100 gridcells, the last game reachable', withCursor === Math.ceil(all / 48) - 1 && allLimit48 && maxCells <= 100 && [...titles].some((t) => t?.startsWith(lastTitle ?? '\u0000')), {
      requests: pages.length, withCursor, maxCells, seen: titles.size, lastTitle,
    });
  });

  // U6: favorites (detail page → shelf; kept after a reload; removed).
  await withPage(ctx, async ({ page }) => {
    const g = (await getJson(`${app}/api/games?limit=1&sort=az`)).json.items[0];
    await page.goto(`${app}/games/${g.slug}`);
    await page.getByRole('heading', { level: 1, name: g.title }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Add to favorites' }).click();
    const pressed = await page.getByRole('button', { name: 'Remove from favorites' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await page.goto(`${app}/games`);
    const fav = page.getByRole('region', { name: 'Favorites' });
    await fav.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const shown = await fav.getByRole('link', { name: new RegExp(`^${g.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).count();
    await page.reload();
    await fav.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const kept = await fav.getByRole('link').count();
    await page.goto(`${app}/games/${g.slug}`);
    await page.getByRole('button', { name: 'Remove from favorites' }).click({ timeout: 10_000 }).catch(() => undefined);
    const unpressed = await page.getByRole('button', { name: 'Add to favorites' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await page.goto(`${app}/games`);
    await page.getByRole('grid', { name: 'All games' }).waitFor({ timeout: 10_000 });
    let gone = 1;
    for (let i = 0; i < 25 && gone; i++) {
      gone = await page.getByRole('region', { name: 'Favorites' }).count();
      if (gone) await sleep(200);
    }
    rec('U6 favorites: add on the detail page → the Favorites shelf; kept after a reload; remove', pressed && shown === 1 && kept >= 1 && unpressed && gone === 0, { pressed, shown, kept, unpressed, gone });
  });

  // U10: phone viewport, no horizontal overflow.
  await withPage(
    ctx,
    async ({ page }) => {
      await page.goto(`${app}/games`);
      await page.getByRole('grid', { name: 'All games' }).waitFor({ timeout: 20_000 });
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      rec('U10 phone viewport 390×844: no horizontal overflow', o.sw <= o.cw + 1, o);
    },
    { viewport: { width: 390, height: 844 } },
  );

  // U14: the detail page of one record per replayed source: text, chips, developer link.
  await withPage(ctx, async ({ page }) => {
    const bySource = new Map();
    for (const g of await allGames(app)) if (!bySource.has(g.source)) bySource.set(g.source, g);
    const bad = [];
    for (const [source, g] of bySource) {
      const d = (await getJson(`${app}/api/games/${g.slug}`)).json.game;
      await page.goto(`${app}/games/${g.slug}`);
      await page.getByRole('heading', { level: 1, name: g.title }).waitFor({ timeout: 15_000 }).catch(() => undefined);
      const about = await page.getByRole('region', { name: 'About this game' }).innerText().catch(() => '');
      const markup = await page.getByRole('region', { name: 'About this game' }).locator('b, i, script, img').count().catch(() => 0);
      const play = await page.getByRole('link', { name: 'Play', exact: true }).count();
      const via = await page.getByText(source === 'oss' ? /AGPL-3\.0-only/ : /^via /).count();
      if (!about.includes(d.description.slice(0, 30).trim()) || markup > 0 || play !== 1 || via === 0) bad.push({ source, slug: g.slug, about: about.slice(0, 60), markup, play, via });
    }
    rec('U14 the detail page of one record per replayed source: "About this game" as text, Play, the attribution', bad.length === 0 && bySource.size >= 6, bad);
  });

  // U8 (last: restarts): an empty catalog, then GNOME_CATALOG_SOURCES=none.
  for (const [catalog, heading] of [['empty', 'No games yet'], ['none', 'Games are not available on this server']]) {
    await stack.server.stop();
    stack.server = await startGamesServer({ dir: ctx.dir, staticDir: ctx.staticDir, label: `${catalog}-${ctx.browser}`, catalog });
    await withPage(ctx, async ({ page }) => {
      await page.goto(`${stack.server.appOrigin}/games`);
      const h = page.getByRole('heading', { name: heading });
      const ok = await h.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      rec(`U8 ${catalog === 'empty' ? 'an empty catalog' : 'GNOME_CATALOG_SOURCES=none'}: "${heading}"`, ok, ok ? '' : (await page.locator('main').innerText().catch(() => '')).slice(0, 200));
    });
  }
  await stack.server.stop();
  stack.server = await startGamesServer({ dir: ctx.dir, staticDir: ctx.staticDir, label: `games-${ctx.browser}-again` });
  for (const id of ['U5', 'U7', 'U9', 'U12', 'U13']) record({ test: `${id} (see §9.3)`, result: 'skip', notes: '[unproven] not written yet' });
}

export async function run(ctx) {
  if (!ctx.stack?.server) {
    ctx.record({ test: 'games-ui', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/games-ui.mjs' });
    return;
  }
  await rows(ctx);
}

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  if (!args.static) throw new Error('--static <frontend dist> is required');
  const dir = workDir(`games-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const all = [];
  try {
    const stack = { server: await startGamesServer({ dir, staticDir: args.static, label: 'games' }) };
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows: out, record } = recorder(name);
      const ctx = { browser: name, dir, staticDir: args.static, launch: (o) => launchBrowser(name, o), record, log: console.log, sleep, stack };
      try {
        await run(ctx);
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...out);
    }
  } finally {
    await cleanupAll();
  }
  writeResults(dir, 'games-ui', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
