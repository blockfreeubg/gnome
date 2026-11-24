// games-player (docs/WAVE-C.md §9.3): the player (lane g2) and the wrapper document (lane g1) in every browser of the
// run, against the real gnome-server with the replayed catalog and the OSS test game. Embeds are never proxied: the
// routed fake embed (fixtures/games/embed.html) answers every network host (games-lib.mjs routeEmbeds).
//
//   node tests/e2e/engine/suites/games-player.mjs --browser chromium,firefox --static <frontend dist>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupAll, installSignalHandlers, launchBrowser, parseArgs, recorder, sleep, summarize, workDir, writeResults } from './backend-lib.mjs';
import { allGames, getJson, POPUP_HOST, routeEmbeds, startGamesServer } from './games-lib.mjs';

export const standalone = true;

const NETWORK_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-pointer-lock allow-orientation-lock';
const NETWORK_ALLOW = 'fullscreen; autoplay; gamepad; accelerometer; gyroscope';

async function withContext(ctx, fn) {
  const browser = await ctx.launch();
  try {
    const context = await browser.newContext();
    const net = await routeEmbeds(context, { app: ctx.stack.server.appOrigin, proxy: ctx.stack.server.proxyOrigin });
    const page = await context.newPage();
    const dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.dismiss();
    });
    return await fn({ browser, context, page, net, dialogs });
  } finally {
    await browser.close();
  }
}

/** Opens /play/<slug>, presses the notice's Play when shown; returns the outer frame element, the wrapper and the inner frames. */
async function play(page, app, g, { pressNotice = true } = {}) {
  await page.goto(`${app}/play/${g.slug}`);
  await page.getByRole('heading', { level: 1, name: g.title }).waitFor({ timeout: 20_000 });
  const notice = page.getByRole('region', { name: 'Before you play' });
  const hadNotice = await notice.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (hadNotice && pressNotice) await notice.getByRole('button', { name: 'Play' }).click();
  const outer = page.locator(`iframe[title="${g.title.replace(/"/g, '\\"')} (game)"]`).first();
  await outer.waitFor({ timeout: 15_000 }).catch(() => undefined);
  // Frames from their elements (robust in both browsers): outer iframe → wrapper document → its one iframe.
  const outerHandle = await outer.elementHandle({ timeout: 5000 }).catch(() => null);
  const wrapper = outerHandle ? await outerHandle.contentFrame() : null;
  let inner = null;
  for (let i = 0; i < 80 && !inner && wrapper; i++) {
    const h = await wrapper.$('iframe').catch(() => null);
    const f = h ? await h.contentFrame() : null;
    if (f && f.url() !== 'about:blank' && f.url() !== '') inner = f;
    else await sleep(100);
  }
  return { hadNotice, outer, wrapper, inner };
}

/** The wrapper's iframe attributes, read through the element handle (no script in the wrapper's realm). */
async function attrsOf(wrapper) {
  const h = await wrapper.$('iframe').catch(() => null);
  if (!h) return null;
  const a = async (n) => h.getAttribute(n);
  return { src: await a('src'), sandbox: await a('sandbox'), allow: await a('allow'), referrerpolicy: await a('referrerpolicy') };
}

async function rows(ctx) {
  const { record, stack } = ctx;
  const app = stack.server.appOrigin;
  const proxy = stack.server.proxyOrigin;
  const rec = (test, ok, notes = '') => record({ test, result: ok ? 'pass' : 'fail', notes: typeof notes === 'string' ? notes : JSON.stringify(notes) });
  const games = await allGames(app);
  const bySource = new Map();
  for (const g of games) if (!bySource.has(g.source)) bySource.set(g.source, g);

  // P1 + P2 + P14: one game per network, the frame attributes; the notice before any request.
  await withContext(ctx, async ({ page, net }) => {
    const bad = [];
    let noticeOk = true;
    const seenNotice = new Set();
    for (const [source, g] of bySource) {
      if (source === 'oss') continue;
      const d = (await getJson(`${app}/api/games/${g.slug}`)).json.game;
      const host = new URL(d.embed_url).hostname;
      const before = net.count(host);
      // P14: the notice and no request to the embed host until Play.
      await page.goto(`${app}/play/${g.slug}`);
      const notice = page.getByRole('region', { name: 'Before you play' });
      const shown = await notice.waitFor({ timeout: 8000 }).then(() => true, () => false);
      if (shown) {
        await sleep(500);
        if (net.count(host) !== before) noticeOk = false;
        seenNotice.add(source);
      } else noticeOk = false;
      const { outer, wrapper, inner } = await play(page, app, g);
      const attrs = await outer.evaluate((f) => ({ src: f.getAttribute('src'), allow: f.getAttribute('allow'), fs: f.hasAttribute('allowfullscreen') })).catch(() => null);
      const innerAttrs = wrapper ? await attrsOf(wrapper) : null;
      const referrer = inner ? await inner.evaluate(() => window.e2eEmbed?.referrer ?? null).catch(() => null) : null;
      const ok =
        attrs?.src === `/play-frame/${g.slug}` && attrs.fs && innerAttrs?.src === d.embed_url && innerAttrs.sandbox === NETWORK_SANDBOX && innerAttrs.allow === NETWORK_ALLOW &&
        (source !== 'gamedistribution' || new URL(d.embed_url).searchParams.get('gd_sdk_referrer_url') === `${app}/play/${g.slug}`) && net.count(host) > before;
      if (!ok) bad.push({ source, attrs, innerAttrs, hits: net.count(host) - before });
      // P2: the embed sees the app origin as its referrer.
      if (referrer !== `${app}/`) bad.push({ source, referrer });
    }
    rec('P1 detail → Play: the outer frame /play-frame/<slug> with allow and allowfullscreen, the wrapper’s inner frame src, sandbox, allow (one game per network); GD’s gd_sdk_referrer_url', bad.length === 0, bad.slice(0, 4));
    rec('P2 inside the routed embed document.referrer is the app origin with "/"; the request reached the embed host directly', !bad.some((b) => 'referrer' in b), bad.filter((b) => 'referrer' in b).slice(0, 3));
    rec('P14 the notice: "Before you play" and no request to the embed host until Play (each network)', noticeOk && seenNotice.size >= 5, { noticeOk, seen: [...seenNotice] });
    // P14: a second game of an allowed network loads without the notice; Forget brings it back.
    const second = games.find((x) => x.source === 'gamepix' && x.slug !== bySource.get('gamepix')?.slug);
    const again = second ? await play(page, app, second, { pressNotice: false }) : null;
    await page.goto(`${app}/games`);
    await page.getByRole('button', { name: 'Forget' }).click().catch(() => undefined);
    const back = second ? await play(page, app, second, { pressNotice: false }) : null;
    rec('P14 a second game of an allowed network has no notice; Forget on the Games page brings it back', again?.hadNotice === false && back?.hadNotice === true, { again: again?.hadNotice, back: back?.hadNotice });
  });

  // P3, P4a, P4b, P5, P13: probes from inside a network embed.
  await withContext(ctx, async ({ page, context, net, dialogs }) => {
    const g = bySource.get('gamepix');
    const { outer, inner } = await play(page, app, g);
    const appUrl = page.url();
    const src0 = await outer.getAttribute('src');
    if (!inner) {
      rec('P3–P5, P13 (embed probes)', false, 'the embed frame did not load');
      return;
    }
    await inner.evaluate(() => {
      try {
        top.location = 'https://ads.e2e.invalid/top';
      } catch {
        /* refused */
      }
      try {
        alert('x');
      } catch {
        /* refused */
      }
    });
    await sleep(1000);
    rec('P3 from the embed: top.location = … does not navigate GNOME; alert() shows no dialog', page.url() === appUrl && dialogs.length === 0, { url: page.url(), dialogs });
    const popupP = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await inner.evaluate((h) => {
      window.e2ePopup = window.open(`https://${h}/x`);
    }, POPUP_HOST);
    const popup = await popupP;
    let openerNull = null;
    if (popup) {
      await popup.waitForLoadState().catch(() => undefined);
      openerNull = await popup.evaluate(() => window.opener === null).catch(() => null);
      await popup.evaluate(() => {
        try {
          window.opener.location = 'https://ads.e2e.invalid/opener';
        } catch {
          /* refused */
        }
        try {
          window.opener.top.location = 'https://ads.e2e.invalid/opener-top';
        } catch {
          /* refused */
        }
      }).catch(() => undefined);
    }
    await sleep(1000);
    const src1 = await outer.getAttribute('src').catch(() => null);
    rec('P4a window.open from the embed opens a page; its opener.location / opener.top.location leave GNOME’s tab and the game frame unchanged', !!popup && page.url() === appUrl && src1 === src0, { popup: !!popup, url: page.url(), src1 });
    rec('P4b the popup’s window.opener is null (COOP)', openerNull === true, String(openerNull));
    const perms = await inner.evaluate(async () => {
      const geo = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r(e.code === 1 ? 'PERMISSION_DENIED' : `code ${e.code}`), { timeout: 3000 }));
      let cam = 'none';
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        cam = 'granted';
      } catch (e) {
        cam = e.name;
      }
      // Chromium reports a missing device before its policy check (NotFoundError on a host without a camera, with
      // the policy blocking or not): there the frame's own policy answer (document.featurePolicy) is what counts.
      const fp = document.featurePolicy;
      return { geo, cam, policyCamera: fp ? fp.allowsFeature('camera') : null, policyMic: fp ? fp.allowsFeature('microphone') : null };
    }).catch((e) => ({ error: String(e) }));
    const camBlocked = perms.cam === 'NotAllowedError' || (perms.cam === 'NotFoundError' && perms.policyCamera === false && perms.policyMic === false);
    rec('P5 from the embed: geolocation → PERMISSION_DENIED; getUserMedia → NotAllowedError (Chromium without a camera: NotFoundError with the frame’s policy denying camera and microphone)', perms.geo === 'PERMISSION_DENIED' && camBlocked, perms);
    // P13: frame escapes fail (the wrapper's frame-src), GNOME opens no tab.
    const tries = [`${app}/browse?url=https://ads.e2e.invalid/`, `${proxy}/uv/service/${encodeURIComponent('https://ads.e2e.invalid/')}`, 'https://html5.gamemonetize.co/escape/'];
    const results = [];
    for (const to of tries) {
      const fresh = await play(page, app, g, { pressNotice: false });
      const pagesBefore = context.pages().length;
      const gmBefore = net.count('html5.gamemonetize.co');
      await fresh.inner?.evaluate((u) => {
        location.href = u;
      }, to).catch(() => undefined);
      await sleep(1500);
      const loaded = fresh.wrapper ? await fresh.wrapper.evaluate(() => {
        try {
          return document.querySelector('iframe')?.contentDocument?.URL ?? 'cross-origin';
        } catch {
          return 'cross-origin';
        }
      }).catch(() => 'gone') : 'no-wrapper';
      const h2 = fresh.wrapper ? await fresh.wrapper.$('iframe').catch(() => null) : null;
      const inner2 = h2 ? await h2.contentFrame().catch(() => null) : null;
      const innerUrl = inner2?.url() ?? null;
      results.push({ to: to.slice(0, 50), innerUrl, loaded, tabs: context.pages().length - pagesBefore, gm: net.count('html5.gamemonetize.co') - gmBefore });
    }
    const escaped = results.filter((r) => (r.innerUrl && (r.innerUrl.startsWith(app) || r.innerUrl.startsWith(proxy) || r.innerUrl.includes('gamemonetize'))) || r.tabs > 0 || r.gm > 0);
    rec('P13 frame escapes from the embed (app /browse, proxy /uv/service, another network) fail to load and open no tab', escaped.length === 0, results);
    // P13: the shell cannot be framed.
    const framedShell = await page.evaluate(async () => {
      const f = document.createElement('iframe');
      f.src = '/';
      document.body.append(f);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        return f.contentDocument?.querySelector('#app, main, body > *') ? 'loaded' : 'empty';
      } catch {
        return 'blocked';
      }
    });
    rec("P13 the shell cannot be framed (frame-ancestors 'none'): an <iframe src=\"/\"> stays empty", framedShell !== 'loaded', framedShell);
  });

  // P7, P8, P10, P11: the play counter, link-out, OSS, leaving.
  await withContext(ctx, async ({ page }) => {
    const posts = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/games\/[^/]+\/play$/.test(new URL(r.url()).pathname)) posts.push(r.url());
    });
    const oss = (await getJson(`${app}/api/games?q=blocks`)).json.items.find((x) => x.slug === 'e2e-blocks');
    const { hadNotice, wrapper, inner } = await play(page, app, oss);
    const innerAttrs = wrapper ? await attrsOf(wrapper) : null;
    let running = false;
    let parentBlocked = null;
    if (inner) {
      await inner.waitForFunction(() => typeof window.e2eFrames === 'function' && window.e2eFrames() > 5, null, { timeout: 10_000 }).then(() => (running = true), () => undefined);
      await inner.evaluate(() => window.e2eScore());
      parentBlocked = await inner.evaluate(() => {
        try {
          void parent.document.body;
          return false;
        } catch {
          return true;
        }
      });
    }
    const note = await page.getByText('Served by this GNOME server.').count();
    const license = await page.getByText(/AGPL-3\.0-only/).count();
    await page.reload();
    const again = await play(page, app, oss);
    const best = again.inner ? await again.inner.evaluate(() => Number(localStorage.getItem('e2e-blocks-best') || 0)).catch(() => 0) : 0;
    rec('P10 the OSS game: no notice; the inner frame <proxy>/oss/e2e-blocks/index.html with the OSS attributes (no allow-popups, no fullscreen); the canvas runs and keeps its score after a reload; parent.document throws; "Served by this GNOME server."', !hadNotice && innerAttrs?.src === `${proxy}/oss/e2e-blocks/index.html` && !/allow-popups/.test(innerAttrs.sandbox ?? '') && !/fullscreen/.test(innerAttrs.allow ?? '') && running && best >= 1 && parentBlocked === true && note > 0 && license >= 0, {
      hadNotice, innerAttrs, running, best, parentBlocked, note,
    });
    await sleep(500);
    rec('P7 a frame’s first load sends one POST …/play (two loads → two POSTs)', posts.length === 2, String(posts.length));
    // P8: a link-out game shows only the link-out card.
    const linkOut = (await allGames(app, 'include_link_out=1&q=js13k')).find((x) => !x.playable) ?? (await allGames(app, 'include_link_out=1')).find((x) => !x.playable);
    await page.goto(`${app}/games/${linkOut.slug}`);
    await page.getByRole('heading', { level: 1, name: linkOut.title }).waitFor({ timeout: 15_000 }).catch(() => undefined);
    const openOn = await page.getByRole('link', { name: /^Open on / }).count();
    await page.goto(`${app}/play/${linkOut.slug}`);
    await sleep(1500);
    const frames = await page.locator('iframe').count();
    rec('P8 a link-out game: the detail page offers "Open on <host>"; /play/<slug> shows no frame', openOn >= 1 && frames === 0, { openOn, frames });
    // P11: leaving the player removes the frame.
    await play(page, app, oss);
    await page.goto(`${app}/games`);
    await page.getByRole('grid', { name: 'All games' }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    rec('P11 leaving the player removes the frame', (await page.locator('iframe').count()) === 0 && page.frames().length === 1, String(page.frames().length));
  });
  // P12: Chromium logs an "Unrecognized feature" console message for every Permissions-Policy name it does not know.
  if (ctx.browser === 'chromium') {
    await withContext(ctx, async ({ page }) => {
      const messages = [];
      page.on('console', (m) => messages.push(m.text()));
      await page.goto(`${app}/`);
      await page.waitForLoadState('load');
      await sleep(1500);
      await page.goto(`${app}/play/e2e-blocks`);
      await sleep(1500);
      const bad = messages.filter((t) => /Unrecognized feature|Permissions-Policy|Feature-Policy/i.test(t));
      rec('P12 Chromium: no Permissions-Policy "Unrecognized feature" console message on the app’s first load (shell and wrapper)', bad.length === 0, bad.slice(0, 5));
    });
  } else record({ test: 'P12 (Chromium only)', result: 'skip', notes: 'the row is about Chromium’s console' });
  for (const id of ['P6', 'P9']) record({ test: `${id} (see §9.3)`, result: 'skip', notes: '[unproven] not written yet' });
}

export async function run(ctx) {
  if (!ctx.stack?.server) {
    ctx.record({ test: 'games-player', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/games-player.mjs' });
    return;
  }
  await rows(ctx);
}

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  if (!args.static) throw new Error('--static <frontend dist> is required');
  const dir = workDir(`games-player-${new Date().toISOString().replace(/[:.]/g, '-')}`);
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
  writeResults(dir, 'games-player', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
