// Lane a: port of the spike's `leak` suite (spike-engine-host/suites/leak.mjs, items 4 and §5) against the BUILT engine
// host on the real stack (WAVE-B §2 Tests). The proxied-document CSP is always on here (it is not optional in GNOME),
// so the rows ask: does anything a proxied document does still reach the network natively, outside Wisp?
//
//   lab    the spike's construct matrix (/leak/matrix of the runner's target site: one element per CSS/HTML/DOM
//          construct that can load a URL, each pointing at its own unroutable host leak-<id>.gnome-spike.invalid)
//          through both engines: 0 native requests, and the engine host must have counted CSP violations (the
//          constructs the engines leave native are blocked, not silent)
//   sites  real sites through both engines: native egress of the browser (everything the sentinel proxy sees that
//          is not browser background noise) must be 0; violations and tab.blocked are reported
//
//   probe  the spike's 30-check page-feature probe (/leak/csp-probe: inline scripts, eval, wasm, modules, fetch, XHR,
//          WebSocket, images, styles, frames, workers, storage, cookies, pushState) through both engines under
//          GNOME's hard-wired CSP (worklist A10): every check passes except the engines' own documented limits
//          (README "Known limitations"; the spike's `csp-probe:off` baseline failed the same checks without any CSP),
//          and nothing reaches the network natively
//
// Native requests are seen at the runner's sentinel (the browsers' proxy for every non-loopback host): proxied
// requests leave through Wisp (HolyWisp), never through the browser's proxy. Parts: --parts lab,sites,probe.
import { LEAK_CONSTRUCTS, LEAK_DOMAIN } from '../../spike-engine-host/servers/isolation-leak-pages.mjs';
import { BROWSER_NOISE } from '../../spike-engine-host/lib/netwatch.mjs';
import { ENGINES, fixtureQuery, readOutOf } from './host-lib.mjs';

const SITES = {
  wikipedia: 'https://en.wikipedia.org/wiki/Gnome',
  github: 'https://github.com/MercuryWorkshop/scramjet',
  hn: 'https://news.ycombinator.com/',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP',
  python: 'https://www.python.org/',
};

const hostOf = (e) => {
  if (e.kind === 'connect') return String(e.target || '').replace(/:\d+$/, '');
  try {
    return new URL(e.url).hostname;
  } catch {
    return String(e.url || '');
  }
};

const has = (ctx, part) => !ctx.parts || ctx.parts.includes(part);

export async function run(ctx) {
  const browser = await ctx.launch();
  try {
    if (has(ctx, 'lab')) await lab(ctx, browser);
    if (has(ctx, 'probe')) await probe(ctx, browser);
    if (has(ctx, 'sites') && !ctx.offline) await sites(ctx, browser);
  } finally {
    await browser.close();
  }
}

async function lab(ctx, browser) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx));
    let id = 1;
    for (const engine of ENGINES) {
      const tab = id++;
      try {
        const d0 = await app.stats();
        const t0 = Date.now();
        const r = await app.navigate(tab, `${ctx.stack.target.origin}/leak/matrix`, { engine, create: true, timeout: 45000 });
        const ran = await readOutOf(app, `tab-${tab}`, 20000).catch(() => null);
        await ctx.sleep(4000);
        const hits = ctx.stack.sentinel.since(t0).map(hostOf);
        const leaked = [...new Set(hits.filter((h) => h.endsWith(`.${LEAK_DOMAIN}`)).map((h) => h.split('.')[0].replace(/^leak-/, '')))];
        const other = hits.filter((h) => !h.endsWith(`.${LEAK_DOMAIN}`) && !BROWSER_NOISE.test(h));
        const d1 = await app.stats();
        const violations = d1.csp.violations - d0.csp.violations;
        const ok = r.ok && leaked.length === 0 && other.length === 0 && violations > 0;
        ctx.record({
          test: 'lab:construct-matrix (CSP on)',
          engine,
          result: ok ? 'pass' : 'fail',
          notes: `${r.ok ? '' : `load failed ${JSON.stringify(r.error).slice(0, 120)}; `}constructs ${LEAK_CONSTRUCTS.length}; native ${leaked.length}${leaked.length ? ` (${leaked.join(', ')})` : ''}; other native hosts ${JSON.stringify([...new Set(other)])}; CSP violations counted ${violations} ${JSON.stringify(d1.csp.byDirective)}; page script ${ran ? 'ran' : 'no #out'}`,
        });
      } catch (e) {
        ctx.record({ test: 'lab:construct-matrix (CSP on)', engine, result: 'fail', notes: `threw: ${String(e.message || e).slice(0, 300)}` });
      }
      await app.cmd('tab.close', { tabId: tab }).catch(() => {});
    }
    await app.close();
  } finally {
    await context.close();
  }
}

/**
 * Checks of /leak/csp-probe that fail through an engine whatever the CSP (the spike's `csp-probe:off` rows, README
 * "Known limitations"): no regression of GNOME's policy. Keys `<engine>|<browser>`.
 */
const PROBE_KNOWN_LIMITS = {
  'scramjet|chromium': [],
  'scramjet|firefox': ['blobWorker', 'urlWorker', 'postMessageFrame'],
  'ultraviolet|chromium': ['dynamicImport'],
  // README: UV workers error in Firefox, blob: workers too: the spike's `csp-probe:off` row (no GNOME policy at all,
  // spike-engine-host/results/2026-11-12T19-00-34-241Z) has blobWorker=FAIL worker error for UV in Firefox.
  'ultraviolet|firefox': ['dynamicImport', 'blobWorker', 'urlWorker'],
};
// A GNOME bug this row found (2026-11-19, both engines, both browsers), fixed in integration part 2: `blobImage` and
// `blobWorker` failed because the engines resolve a page's blob: URL by fetching it from the engine host (Scramjet's
// controller) or from the service worker (Ultraviolet), and neither policy had `blob:` in connect-src (engineHostCsp,
// proxyScriptCsp). Both have it now (proxy-origin.ts, csp.rs); a blob: URL resolves locally, so nothing leaves.


async function probe(ctx, browser) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    let id = 50;
    for (const engine of ENGINES) {
      const tab = id++;
      try {
        const t0 = Date.now();
        const r = await app.navigate(tab, `${ctx.stack.target.origin}/leak/csp-probe`, { engine, create: true, timeout: 45000 });
        let out = null;
        for (let i = 0; i < 300 && !out?.done; i++) {
          out = (await readOutOf(app, `tab-${tab}`, 2000).catch(() => null)) ?? out;
          if (!out?.done) await ctx.sleep(300);
        }
        await ctx.sleep(1500);
        const native = [...new Set(ctx.stack.sentinel.since(t0).map(hostOf).filter((h) => !BROWSER_NOISE.test(h)))];
        const failing = out ? Object.entries(out).filter(([, v]) => typeof v === 'string' && v.startsWith('FAIL')).map(([k]) => k) : [];
        const known = PROBE_KNOWN_LIMITS[`${engine}|${ctx.browser}`] ?? [];
        const unexpected = failing.filter((k) => !known.includes(k));
        const ok = r.ok && out?.done === true && Object.keys(out).length >= 31 && unexpected.length === 0 && native.length === 0;
        ctx.record({
          test: 'probe:page-features under the proxied-document CSP (spike csp-probe)',
          engine,
          result: ok ? 'pass' : 'fail',
          notes: `${r.ok ? '' : `load failed ${JSON.stringify(r.error).slice(0, 120)}; `}${out ? `${Object.keys(out).length - 1} checks${out.done ? '' : ' (incomplete)'}` : 'no output'}; failing ${failing.map((k) => `${k}=${String(out[k]).slice(0, 60)}`).join('; ') || 'none'}; known engine limits ${JSON.stringify(known)}; native hosts ${JSON.stringify(native)}`,
        });
      } catch (e) {
        ctx.record({ test: 'probe:page-features under the proxied-document CSP (spike csp-probe)', engine, result: 'fail', notes: `threw: ${String(e.message || e).slice(0, 300)}` });
      }
      await app.cmd('tab.close', { tabId: tab }).catch(() => {});
    }
    await app.close();
  } finally {
    await context.close();
  }
}

async function sites(ctx, browser) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, {});
    let id = 1;
    for (const [name, url] of Object.entries(SITES)) {
      for (const engine of ENGINES) {
        const tab = id++;
        try {
          const d0 = await app.stats();
          const t0 = Date.now();
          const since = await app.mark();
          const r = await app.navigate(tab, url, { engine, create: true, timeout: 60000 });
          await ctx.sleep(6000);
          const hosts = ctx.stack.sentinel.since(t0).map(hostOf);
          const native = [...new Set(hosts.filter((h) => !BROWSER_NOISE.test(h)))];
          const noise = hosts.filter((h) => BROWSER_NOISE.test(h)).length;
          const d1 = await app.stats();
          const blocked = (await app.eventsSince(since)).filter((e) => e.type === 'tab.blocked' && e.p.tabId === tab).pop();
          ctx.record({
            test: `sites:${name}`,
            engine,
            result: r.ok && native.length === 0 ? 'pass' : 'fail',
            notes: `${r.ok ? `loaded "${String(r.title ?? '').slice(0, 50)}"` : `load failed ${JSON.stringify(r.error).slice(0, 160)}`}; native hosts ${JSON.stringify(native)}; browser noise ${noise}; CSP violations ${d1.csp.violations - d0.csp.violations}; tab.blocked ${blocked ? blocked.p.total : 0}`,
          });
        } catch (e) {
          ctx.record({ test: `sites:${name}`, engine, result: 'fail', notes: `threw: ${String(e.message || e).slice(0, 300)}` });
        }
        await app.cmd('tab.close', { tabId: tab }).catch(() => {});
      }
    }
    await app.close();
  } finally {
    await context.close();
  }
}
