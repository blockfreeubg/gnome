// Lane b: the service worker on the real stack (port of the spike's `sw` rows; WAVE-B §3 "Tests").
// Parts (all by default; `--parts a,b`):
//   register   /sw.js controls the engine host at scope /, reports this build's id (status.sw current)
//   csp        PROXIED_DOCUMENT_CSP on proxied documents of both engines (the SW adds it; the response the browser got)
//   hold503    a Scramjet prefix no controller announced: held ≤ 5 s, then 503 not-routable with `default-src 'none'`
//   stale      an old Scramjet URL after an app reload: 503 stale-prefix at once
//   bodies     a form POST body arrives intact through both engines (the Firefox body fix)
//   download   a UV attachment: the browser downloads it once, the SW's tap reports started/progress/done
//   stop       the SW stopped while an engine host runs (Chromium: CDP; Firefox: its own idle stop after ~30 s): the
//              next Scramjet page is held, the controller revived once, and the page routed
//   forced     a forced reload loads the engine host uncontrolled: it asks for the claim and initializes
//   update     a new /sw.js waits while engine hosts run (both engines keep working); with two GNOME pages the apply
//              step is refused; with one, the reload applies it (explicit apply step, ENGINE-PROTOCOL §2.5), also when
//              the reload comes right after the other GNOME page closed; an update no page has noticed yet is found by
//              the engine host's background check a few seconds after the next load and applied at the load after
// Realm parts (servers/realm-fixtures.mjs through the VPN profile; "native" = a script that runs unvirtualized on the
// proxy origin, which reaches the engine host by walking `parent`: an escape any ordinary page could use):
//   hook         UV: the document-start hook (and with it the WebRTC kill switch) in HTML whose `<head>` a text search
//                misplaces: a comment containing `<head>`, `<head data-x=">">`, `<html data-x="<head>">`
//   frames       both engines: the documents of a `<frameset>` are virtualized like iframes (no native realm)
//   unrewritten  both engines: HTML without a Content-Type, `Text/HTML`, SVG, XHTML and XML documents never run native
//                scripts (SCRIPTLESS_CSP where the engine left them unrewritten); a `+xml` type is either downloaded
//                (Chromium) or rendered without a native script
//   object       both engines: `<object>`/`<embed>` never get proxied content (service workers do not see plugin
//                loads: gnome-server answers the engine prefix with its strict 503 page) and run no native script
//   sharedworker UV: a SharedWorker started with an engine-proxied URL is refused (UV serves it unrewritten);
//                Scramjet: a SharedWorker the page starts runs rewritten (virtualized location, fetch through Wisp)
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PORTS } from '../lib/config.mjs';
import { startRealmFixtures } from '../servers/realm-fixtures.mjs';

const ALL = ['register', 'csp', 'hold503', 'stale', 'bodies', 'download', 'stop', 'forced', 'update', 'hook', 'frames', 'unrewritten', 'object', 'sharedworker'];
const REALM_PARTS = ['hook', 'frames', 'unrewritten', 'object', 'sharedworker'];
const PERMS = { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' };
/** src/sw/pure.ts SW_PAGE_CSP: the SW's own pages (hold/503, refused, blocked). */
const SW_PAGE_CSP = "default-src 'none'; form-action 'none'; base-uri 'none'";

async function withPage(ctx, browser, query, fn) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, query);
    return await fn(app, context);
  } finally {
    await context.close();
  }
}

/** The document response of a tab frame navigation (what the browser received from the SW). */
function documentResponse(page, pred, timeout = 30000) {
  return page.waitForResponse((r) => r.request().resourceType() === 'document' && pred(r.url()), { timeout });
}

/** Loads `url` in a hidden iframe of the engine-host document and returns the browser's response for it. */
async function frameLoad(app, url, timeout = 15000) {
  const wait = documentResponse(app.page, (u) => u === url, timeout);
  await app.engineFrame().evaluate((u) => {
    const f = document.createElement('iframe');
    f.hidden = true;
    f.src = u;
    document.body.append(f);
  }, url);
  const t0 = Date.now();
  const res = await wait;
  return { status: res.status(), headers: await res.allHeaders(), ms: Date.now() - t0 };
}

export async function run(ctx) {
  if (!ctx.engineHost) {
    ctx.record({ test: 'sw suite', result: 'skip', notes: 'engine host not built (frontend/engine/index.html missing)' });
    return;
  }
  const parts = new Set(ctx.parts ?? ALL);
  const rec = (test, ok, notes = '', extra = {}) => ctx.record({ test, result: ok ? 'pass' : 'fail', notes, ...extra });
  const CSP = ctx.contract.PROXIED_DOCUMENT_CSP;
  const target = ctx.stack.target;
  const vpn = `profile:${ctx.stack.profiles.live}`;
  const browser = await ctx.launch();
  try {
    if (parts.has('register')) {
      await withPage(ctx, browser, {}, async (app) => {
        const sw = app.init.status.sw;
        const scope = await app.engineFrame().evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope ?? null);
        rec('the SW controls the engine host at scope / and reports this build', sw.controlled && sw.current && sw.build === ctx.build.buildId && scope === `${ctx.stack.proxyOrigin}/`, `${JSON.stringify(sw)}; scope ${scope}`);
      });
    }

    if (parts.has('csp') && !ctx.offline) {
      for (const engine of ['scramjet', 'ultraviolet']) {
        await withPage(ctx, browser, { engine, fallback: 0 }, async (app) => {
          const prefix = engine === 'scramjet' ? '/~/sj/' : '/uv/service/';
          const wait = documentResponse(app.page, (u) => u.startsWith(`${ctx.stack.proxyOrigin}${prefix}`));
          await app.navigate(1, 'https://example.com/', { create: true, engine });
          const res = await wait.catch(() => null);
          const csp = res ? ((await res.allHeaders())['content-security-policy'] ?? '') : '';
          rec('a proxied document carries PROXIED_DOCUMENT_CSP', csp.split(/,\s*/).includes(CSP), csp || 'no response seen', { engine });
        });
      }
    }

    if (parts.has('hold503')) {
      await withPage(ctx, browser, {}, async (app) => {
        const before = (await app.stats()).sw;
        const url = `${ctx.stack.proxyOrigin}/~/sj/nosuchctl/https%3A%2F%2Fexample.com%2F`;
        const r = await frameLoad(app, url, 20000);
        await sleep(500);
        const after = (await app.stats()).sw;
        rec(
          'an unrouted Scramjet prefix: held, then 503 not-routable with a no-script CSP',
          r.status === 503 && r.headers['x-gnome-sw'] === 'not-routable' && r.headers['content-security-policy'] === SW_PAGE_CSP && r.ms >= 4000,
          `${r.status} ${r.headers['x-gnome-sw']} after ${r.ms} ms; csp ${r.headers['content-security-policy']}; sw.unavailable ${before.unavailable} → ${after.unavailable}`,
        );
      });
    }

    if (parts.has('stale') && !ctx.offline) {
      const context = await ctx.newContext(browser);
      try {
        let app = await ctx.openApp(context, { engine: 'scramjet', fallback: 0 });
        await app.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        const old = app.tabFrame(1)?.url() ?? '';
        const page = app.page;
        await page.reload();
        app = new app.constructor(page);
        await app.waitInit();
        const r = old.includes('/~/sj/') ? await frameLoad(app, old) : null;
        rec('an old Scramjet URL after an app reload: 503 stale-prefix at once', !!r && r.status === 503 && r.headers['x-gnome-sw'] === 'stale-prefix' && r.ms < 3000, r ? `${r.status} ${r.headers['x-gnome-sw']} in ${r.ms} ms` : `no old URL (${old})`);
      } finally {
        await context.close();
      }
    }

    if (parts.has('bodies') && target) {
      for (const engine of ['scramjet', 'ultraviolet']) {
        await withPage(ctx, browser, { engine, fallback: 0, route: vpn }, async (app) => {
          const r = await app.navigate(1, `${target.origin}/form`, { create: true, engine });
          const frame = app.tabFrame(1);
          let out = null;
          if (r.committed || r.ok) {
            const since = await app.mark();
            await frame.evaluate(() => document.getElementById('submit').click());
            await app.waitFor(since, (e) => e.type === 'tab.loaded' || e.type === 'tab.error', 20000);
            const f2 = await app.waitTabFrame(1, (f) => f.evaluate(() => !!document.getElementById('out')), 15000);
            out = f2 ? JSON.parse(await f2.evaluate(() => document.getElementById('out').textContent)) : null;
          }
          rec('a form POST body arrives intact', out?.method === 'POST' && out?.body === 'greeting=hello+gnome&n=42', JSON.stringify(out ?? r.error).slice(0, 200), { engine });
        });
      }
    }

    if (parts.has('download') && target) {
      await withPage(ctx, browser, { engine: 'ultraviolet', fallback: 0, route: vpn }, async (app) => {
        await app.navigate(1, `${target.origin}/download-page`, { create: true, engine: 'ultraviolet' });
        // The SW's own signals, as the engine host receives them (Client.postMessage), next to the protocol events.
        await app.engineFrame().evaluate(() => {
          window.__gnomeSwSignals = [];
          navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'uv-download') window.__gnomeSwSignals.push(e.data);
          });
        });
        const since = await app.mark();
        await app.tabFrame(1).evaluate(() => document.getElementById('dl').click());
        const done = await app.waitFor(since, (e) => e.type === 'download.done', 30000);
        const evs = (await app.eventsSince(since)).filter((e) => e.type.startsWith('download.'));
        const started = evs.find((e) => e.type === 'download.started');
        const progress = evs.filter((e) => e.type === 'download.progress').length;
        await sleep(500);
        const dl = app.downloads.at(-1);
        const size = dl ? await dl.download.path().then((p) => (p ? readFileSync(p).length : null)).catch(() => null) : null;
        const sig = await app.engineFrame().evaluate(() => window.__gnomeSwSignals);
        const sStart = sig.find((x) => x.phase === 'started');
        const sDone = sig.find((x) => x.phase === 'done');
        rec(
          'UV attachment: one browser download; the SW tap signals started/progress/done with the byte count',
          !!dl && app.downloads.length === 1 && size === 2097152 && sStart?.navigation === true && sStart?.disposition === 'attachment' && sStart?.filename === 'gnome-spike.bin' && sStart?.total === 2097152 && sig.some((x) => x.phase === 'progress') && sDone?.state === 'completed' && sDone?.received === 2097152,
          `browser downloads ${app.downloads.length} (${dl?.suggestedFilename}, ${size} bytes); SW: ${sig.map((x) => x.phase).join(',')}; done ${JSON.stringify(sDone ?? null)}`,
          { engine: 'ultraviolet' },
        );
        rec(
          'UV attachment: the engine host turns the signals into download.started/progress/done (lane a)',
          !!started && started.p.filename === 'gnome-spike.bin' && progress >= 1 && done?.p.state === 'completed' && done?.p.received === sDone?.received,
          `events: ${evs.map((e) => e.type.slice(9)).join(',')}; done ${JSON.stringify(done?.p ?? null)}`,
          { engine: 'ultraviolet' },
        );
      });
    }

    if (parts.has('stop') && !ctx.offline) {
      if (ctx.browser !== 'chromium') {
        // Firefox stops an idle worker after about 30 s even while engine hosts run: wait for that instead of CDP.
        await withPage(ctx, browser, { engine: 'scramjet', fallback: 0 }, async (app) => {
          const first = await app.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
          const before = (await app.stats()).sw;
          await sleep(45_000);
          const r = await app.navigate(1, 'https://example.org/', { engine: 'scramjet', timeout: 30000 });
          const after = (await app.stats()).sw;
          rec(
            'the idle SW restarted while an engine host runs: held, revived, routed',
            !!first.committed && r.title === 'Example Domain' && after.starts > before.starts,
            `starts ${before.starts} → ${after.starts}, held ${before.held} → ${after.held}; ${r.ok ? 'tab.loaded' : JSON.stringify(r.error).slice(0, 160)}`,
          );
        });
      } else {
        await withPage(ctx, browser, { engine: 'scramjet', fallback: 0 }, async (app, context) => {
          const first = await app.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
          const cdp = await context.newCDPSession(app.page);
          await cdp.send('ServiceWorker.enable');
          await cdp.send('ServiceWorker.stopAllWorkers');
          await sleep(1000);
          const before = (await app.stats()).sw;
          const r = await app.navigate(1, 'https://example.org/', { engine: 'scramjet' });
          await sleep(500);
          const after = (await app.stats()).sw;
          rec(
            'SW stopped while an engine host runs: held, revived, routed',
            !!first.committed && !!r.committed && r.title === 'Example Domain' && after.starts > before.starts,
            `starts ${before.starts} → ${after.starts}, held ${before.held} → ${after.held}; ${r.ok ? 'tab.loaded' : JSON.stringify(r.error).slice(0, 160)}`,
          );
        });
      }
    }

    if (parts.has('forced') && !ctx.offline) {
      await withPage(ctx, browser, { engine: 'scramjet', fallback: 0 }, async (app, context) => {
        if (ctx.browser === 'chromium') {
          const cdp = await context.newCDPSession(app.page);
          await cdp.send('Page.reload', { ignoreCache: true });
          await app.page.waitForLoadState('load');
        } else {
          await app.page.reload(); // Playwright's Firefox reload bypasses the cache (spike §7.13)
        }
        const again = new app.constructor(app.page);
        await again.waitInit();
        const r = await again.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        rec('forced reload: claimed, initialized, pages load', again.init.status.sw.controlled && r.title === 'Example Domain', `${JSON.stringify(again.init.status.sw)}; ${r.ok ? 'tab.loaded' : JSON.stringify(r.error).slice(0, 160)}`);
      });
    }

    if (parts.has('update') && !ctx.offline) {
      const swFile = path.join(ctx.stack.staticDir, 'sw.js');
      const backup = path.join(ctx.runDir, `sw.js.${ctx.browser}.orig`);
      copyFileSync(swFile, backup);
      const original = readFileSync(swFile, 'utf8');
      const oldId = ctx.build.buildId;
      const newId = `${oldId.split('+')[0]}+29991231235959.1`;
      const context = await ctx.newContext(browser);
      try {
        const a = await ctx.openApp(context, { fallback: 0 });
        const b = await ctx.openApp(context, { fallback: 0 });
        writeFileSync(swFile, original.split(oldId).join(newId));
        await ctx.stack.restartServer({}); // gnome-server indexes the static dir at startup
        const waiting = await a.engineFrame().evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          await reg.update();
          for (let i = 0; i < 100 && !reg.waiting; i++) await new Promise((r) => setTimeout(r, 100));
          return !!reg.waiting;
        });
        await sleep(500);
        const stA = (await a.status()).sw;
        const sj = await a.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        const uv = await a.navigate(2, 'https://example.org/', { create: true, engine: 'ultraviolet' });
        rec(
          'a new /sw.js waits while engine hosts run; both engines keep working',
          waiting && stA.updateWaiting && stA.build === oldId && sj.title === 'Example Domain' && uv.title === 'Example Domain',
          `waiting ${waiting}; status.sw ${JSON.stringify(stA)}; sj ${sj.ok ? 'loaded' : 'not loaded'}, uv ${uv.ok ? 'loaded' : 'not loaded'}`,
        );
        // Two GNOME pages: reloading one must not apply the update (the other engine host uses the old worker).
        await a.page.reload();
        const a2 = new a.constructor(a.page);
        await a2.waitInit();
        const two = a2.init.status.sw;
        rec('with two GNOME pages open the apply step is refused (update stays waiting)', two.updateWaiting && two.build === oldId, JSON.stringify(two));
        // The user closes the other GNOME tab and reloads at once (lane c's flow): the closed tab's engine host can
        // still be counted for a moment, so the apply step must ask again within its window.
        await b.close();
        await a.page.reload();
        const a3 = new a.constructor(a.page);
        await a3.waitInit();
        const one = a3.init.status.sw;
        const sj2 = await a3.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        rec(
          'the only GNOME page applies the waiting update at its next load (explicit apply step)',
          one.controlled && one.build === newId && one.current === false && !one.updateWaiting && sj2.title === 'Example Domain',
          `${JSON.stringify(one)}; ${sj2.ok ? 'tab.loaded' : JSON.stringify(sj2.error).slice(0, 120)}`,
        );
        // A newer /sw.js that no page has noticed yet (no registration.update() from the test). Browsers look on their
        // own only after some navigations (Chromium: ~1.5 s after the reload that should have applied it, lane c's
        // flow), so the engine host checks a few seconds after it started: the update installs and waits while the
        // engines keep working, status.sw says so (the app's notice), and the next load applies it.
        const thirdId = `${oldId.split('+')[0]}+29991231235959.2`;
        writeFileSync(swFile, original.split(oldId).join(thirdId));
        await ctx.stack.restartServer({});
        await a.page.reload();
        const a4 = new a.constructor(a.page);
        await a4.waitInit();
        const t0 = Date.now();
        let noticed = (await a4.status()).sw;
        while (!noticed.updateWaiting && Date.now() - t0 < 15000) {
          await sleep(250);
          noticed = (await a4.status()).sw;
        }
        const sj3 = await a4.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        const uv3 = await a4.navigate(2, 'https://example.org/', { create: true, engine: 'ultraviolet' });
        rec(
          'an update no page has noticed yet is found within seconds of the next load and waits; both engines keep working',
          a4.init.status.sw.build === newId && noticed.updateWaiting && noticed.build === newId && sj3.title === 'Example Domain' && uv3.title === 'Example Domain',
          `at init ${JSON.stringify(a4.init.status.sw)}; after ${Date.now() - t0} ms ${JSON.stringify(noticed)}; sj ${sj3.ok ? 'loaded' : 'not loaded'}, uv ${uv3.ok ? 'loaded' : 'not loaded'}`,
        );
        await a.page.reload();
        const a5 = new a.constructor(a.page);
        await a5.waitInit();
        const applied = a5.init.status.sw;
        const sj4 = await a5.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
        rec(
          '…and the load after that applies it (explicit apply step)',
          applied.controlled && applied.build === thirdId && !applied.updateWaiting && sj4.title === 'Example Domain',
          `${JSON.stringify(applied)}; ${sj4.ok ? 'tab.loaded' : JSON.stringify(sj4.error).slice(0, 120)}`,
        );
      } catch (e) {
        rec('SW update flow', false, String(e.message || e).slice(0, 300));
      } finally {
        await context.close();
        copyFileSync(backup, swFile);
        await ctx.stack.restartServer({});
      }
    }

    if (REALM_PARTS.some((p) => parts.has(p))) await realmParts(ctx, browser, parts, rec);
  } finally {
    await browser.close();
  }
}

// ── Realm parts ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What a fixture document reports: its #out (or SVG #t) text, parsed when its script ran; null when unreadable. */
async function readReport(frame) {
  if (!frame) return null;
  const raw = await Promise.race([
    frame.evaluate(() => (document.getElementById('out') || document.getElementById('t'))?.textContent ?? null).catch(() => null),
    sleep(3000).then(() => null),
  ]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { ran: false, text: raw };
  }
}

/** A report shows a native realm: its script ran outside the engine (it reached the engine host, or nothing wrapped it). */
const native = (r, engine) => !!r?.ran && (String(r.host).startsWith('host@') || (engine === 'ultraviolet' ? r.uv !== 'object' : r.sj !== 'object'));
const brief = (r) => (r ? JSON.stringify(r).slice(0, 160) : 'unreadable');

async function realmParts(ctx, browser, parts, rec) {
  const fx = await startRealmFixtures(PORTS.realm);
  const route = `profile:${ctx.stack.profiles.live}`;
  try {
    for (const engine of ['ultraviolet', 'scramjet']) {
      const context = await ctx.newContext(browser);
      try {
        const app = await ctx.openApp(context, { engine, fallback: 0, route, webrtc: 'block' });
        let tab = 0;
        const open = async (p, timeout = 45000) => {
          tab += 1;
          const r = await app.navigate(tab, `${fx.origin}${p}`, { create: true, engine, timeout });
          await sleep(1500);
          return { r, tab };
        };
        const outcome = (r) => (r.ok ? 'loaded' : `not loaded (${JSON.stringify(r.error).slice(0, 100)})`);

        if (parts.has('hook') && engine === 'ultraviolet') {
          for (const p of ['/plain', '/c-head', '/a-head', '/h-attr']) {
            const { r, tab: t } = await open(p);
            const rep = await readReport(app.tabFrame(t));
            rec(`UV document-start hook placed by the parsed tree (${p}): virtualized, WebRTC blocked`, !!rep?.ran && rep.uv === 'object' && rep.rtc === 'undefined' && rep.host === 'nohost', `${outcome(r)}; ${brief(rep)}`, { engine });
          }
        }

        if (parts.has('frames')) {
          const { r } = await open('/frameset');
          const kids = ['kid-a', 'kid-b'].map((n) => app.page.frames().find((f) => f.name() === n) ?? null);
          const reps = await Promise.all(kids.map(readReport));
          const ok = reps.every((x) => !!x?.ran && !native(x, engine) && x.rtc === 'undefined');
          rec('a <frameset>’s documents are virtualized like iframes (no native realm)', ok, `${outcome(r)}; ${reps.map(brief).join(' | ')}`, { engine });
        }

        if (parts.has('unrewritten')) {
          for (const p of ['/none', '/upper', '/svg', '/xhtml', '/xml', '/plusxml']) {
            // A download never ends with tab.loaded (ENGINE-PROTOCOL §6.9): do not wait the full timeout for it.
            const { r, tab: t } = await open(p, p === '/plusxml' ? 8000 : 45000);
            const rep = await readReport(app.tabFrame(t));
            const downloaded = r.events.some((e) => e.type === 'download.started');
            const ok = rep !== null ? !native(rep, engine) && (!rep.ran || rep.rtc === 'undefined') : p === '/plusxml' && downloaded;
            rec(`a document the engine may leave unrewritten (${p}) runs no native script`, ok, `${downloaded ? 'downloaded (download.started)' : outcome(r)}; ${brief(rep)}`, { engine });
          }
        }

        if (parts.has('object')) {
          const before = fx.hits().length;
          const { r, tab: t } = await open('/object');
          const tf = app.tabFrame(t);
          const inner = app.page.frames().filter((f) => f !== tf && f.parentFrame() === tf);
          const reps = (await Promise.all(inner.map(readReport))).filter((x) => x !== null);
          const served = fx.hits().slice(before).filter((h) => h === '/kid' || h === '/kid2');
          const ok = r.ok && served.length === 0 && reps.every((x) => !native(x, engine));
          rec('<object>/<embed> get no proxied content and run no native script', ok, `${outcome(r)}; fixture served ${served.join(',') || 'no /kid'}; ${inner.length} nested document(s): ${reps.map(brief).join(' | ') || 'none with a report'}`, { engine });
        }

        if (parts.has('sharedworker') && engine === 'scramjet') {
          // Worklist A9 (was code reading only): Scramjet rewrites a SharedWorker the page starts: its `location` is
          // the site's real URL and its fetch reaches the site through the engine (never natively: the fixture is
          // reachable only through Wisp).
          const before = fx.hits().filter((h) => h === '/shared-fetch').length;
          const { r, tab: t } = await open('/sharedworker-sj');
          let text = '';
          for (let i = 0; i < 40 && !/^worker says|worker error|no reply|threw/.test(text); i++) {
            await sleep(250);
            text = String((await readReport(app.tabFrame(t)))?.text ?? '');
          }
          const fetched = fx.hits().filter((h) => h === '/shared-fetch').length - before;
          const ok = text === `worker says loc:${fx.origin}/shared-sj.js fetch:from-the-site` && fetched === 1;
          // Firefox: Scramjet's URL workers time out (README "Known limitations"; measured 2026-11-19: "no reply").
          const limit = ctx.browser === 'firefox' && !ok;
          rec('a SharedWorker a Scramjet page starts runs rewritten (virtualized location, fetch through the engine)', ok, `${outcome(r)}; page says ${JSON.stringify(text)}; the site served /shared-fetch ${fetched}×${limit ? ' (known limit: Scramjet workers time out in Firefox)' : ''}`, { engine, ...(limit ? { expectFail: true } : {}) });
        }
        if (parts.has('sharedworker') && engine === 'ultraviolet') {
          const { r, tab: t } = await open('/sharedworker');
          await sleep(3500);
          const rep = await readReport(app.tabFrame(t));
          const text = String(rep?.text ?? '');
          const sawScript = fx.hits().includes('/shared.js');
          rec('a SharedWorker with a UV-proxied URL is refused (no native worker realm)', !!rep && !/^worker says/.test(text) && text !== 'pending' && !sawScript, `${outcome(r)}; page says ${JSON.stringify(text)}; fixture served shared.js: ${sawScript}`, { engine });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await fx.close();
  }
}
