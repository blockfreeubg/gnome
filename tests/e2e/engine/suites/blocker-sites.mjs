// Lane x1 (docs/WAVE-B3.md §12.3): real sites with the default filter lists (runner mode --blocker-real; needs the
// internet). Per site × engine: the load outcome, title, tab.blocked per category, the engine host's main-thread
// figures, and for three sites the same with blocking off. Pass: every site loads as with blocking off; ≥ 6 of 8
// ad-heavy and ≥ 4 of 5 tracker-heavy sites show blocks per engine; the controls load. A bot or consent wall counts as
// neither. Screenshots go to <runDir>/blocker-sites/. Skipped without --blocker-real or with --offline.
import fs from 'node:fs';
import path from 'node:path';
import { applyBlocker, blockedOf, blockerSettings, ENGINES, listRefs, openBlockerApp, waitBlocker } from './blocker-network.mjs';

const AD_HEAVY = ['https://www.speedtest.net/', 'https://www.cnn.com/', 'https://www.theguardian.com/', 'https://www.w3schools.com/', 'https://www.dailymail.co.uk/', 'https://www.forbes.com/', 'https://www.accuweather.com/', 'https://www.youtube.com/'];
const TRACKER_HEAVY = ['https://www.nytimes.com/', 'https://www.imdb.com/', 'https://www.businessinsider.com/', 'https://www.huffpost.com/', 'https://www.reddit.com/'];
const CONTROLS = ['https://en.wikipedia.org/', 'https://github.com/', 'https://news.ycombinator.com/', 'https://developer.mozilla.org/'];
const OFF_TOO = new Set(['https://www.cnn.com/', 'https://www.nytimes.com/', 'https://en.wikipedia.org/']);
const WALL = /just a moment|access denied|are you a robot|captcha|attention required|unusual traffic|blocked|403 forbidden|unknown error/i;
// A DataDome interstitial (measured 2026-11-21 on nytimes.com and forbes.com through GNOME): the page's title is the
// bare host name and its body has no text (the challenge is a cross-origin frame).

export async function run(ctx) {
  const bk = ctx.stack.blocker;
  if (!bk || bk.mode !== 'real' || ctx.offline) {
    ctx.record({ test: 'blocker-sites', result: 'skip', notes: 'needs --blocker-real (the built-in registry) and the internet' });
    return;
  }
  const dir = path.join(ctx.runDir, 'blocker-sites');
  fs.mkdirSync(dir, { recursive: true });
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await openBlockerApp(ctx, context, { route: 'default' });
    const refs = await listRefs(ctx);
    const on = blockerSettings(refs, { enabled: { privacy: true, cookies: true } });
    const off = blockerSettings(refs, { enabled: { adblock: false, trackers: false, privacy: false, cookies: false, cosmetic: false } });
    await applyBlocker(app, on);
    const ready = await waitBlocker(app, { timeout: 120_000 });
    ctx.record({ test: 'sites: default lists built', result: ready.ok ? 'pass' : 'fail', notes: `${ready.ms} ms; ${JSON.stringify(ready.status)}; lists ${refs.map((r) => r.id).join(', ')}` });
    let id = 700;
    const visit = async (engine, url) => {
      const tab = id++;
      const s = await app.mark();
      const d0 = await app.cmd('diagnostics', {}).catch(() => null);
      const nav = await app.navigate(tab, url, { engine, create: true, timeout: 60_000 });
      await ctx.sleep(4000);
      const blocked = await blockedOf(app, s, tab);
      const d1 = await app.cmd('diagnostics', {}).catch(() => null);
      const shot = path.join(dir, `${ctx.browser}-${engine}-${new URL(url).hostname}-${tab}.png`);
      await app.page.screenshot({ path: shot }).catch(() => null);
      const text = await Promise.race([
        app.tabFrame(tab).evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)).catch(() => ''),
        ctx.sleep(5000).then(() => ''),
      ]);
      await app.cmd('tab.close', { tabId: tab }).catch(() => null);
      const host = new URL(url).hostname.replace(/^www\./, '');
      const wall = WALL.test(nav.title ?? '') || WALL.test(text) || ((nav.title ?? '') === host && text === '');
      return { ok: nav.ok, title: nav.title ?? null, error: nav.error ?? null, blocked, wall, lag: d1?.mainThread ?? null, lagBefore: d0?.mainThread ?? null };
    };
    for (const engine of ENGINES) {
      let adShown = 0;
      let adCounted = 0;
      let trkShown = 0;
      let trkCounted = 0;
      const rows = [];
      for (const [group, list] of [['ad-heavy', AD_HEAVY], ['tracker-heavy', TRACKER_HEAVY], ['control', CONTROLS]]) {
        for (const url of list) {
          const r = await visit(engine, url);
          const n = Object.entries(r.blocked?.byCategory ?? {}).filter(([k]) => k !== 'direct-connection').reduce((a, [, v]) => a + v, 0);
          if (!r.wall && group === 'ad-heavy') {
            adCounted++;
            if (n > 0) adShown++;
          }
          if (!r.wall && group === 'tracker-heavy') {
            trkCounted++;
            if (n > 0) trkShown++;
          }
          let offNote = '';
          if (OFF_TOO.has(url)) {
            await applyBlocker(app, off);
            const o = await visit(engine, url);
            await applyBlocker(app, on);
            offNote = `; blocking off: ${o.ok ? 'loaded' : 'FAILED'} "${String(o.title).slice(0, 40)}"`;
            if (o.ok && !r.ok) offNote += ' — breaks only with blocking on';
          }
          rows.push(`${new URL(url).hostname}: ${r.ok ? 'ok' : 'FAIL'}${r.wall ? ' (bot/consent wall)' : ''} "${String(r.title).slice(0, 40)}" blocked ${n} ${JSON.stringify(r.blocked?.byCategory ?? {})}${offNote}`);
          ctx.record({ test: `sites: ${group} ${new URL(url).hostname}`, engine, result: r.ok || r.wall ? 'pass' : 'fail', notes: `${rows.at(-1)}; main thread ${JSON.stringify(r.lag)}` });
        }
      }
      const pass = adShown >= Math.min(6, adCounted) && trkShown >= Math.min(4, trkCounted);
      ctx.record({ test: 'sites: blocks shown (≥ 6/8 ad-heavy, ≥ 4/5 tracker-heavy, walls excluded)', engine, result: pass ? 'pass' : 'fail', notes: `ad-heavy ${adShown}/${adCounted}, tracker-heavy ${trkShown}/${trkCounted}` });
    }
    await app.close();
  } finally {
    await context.close();
    await browser.close();
  }
}
