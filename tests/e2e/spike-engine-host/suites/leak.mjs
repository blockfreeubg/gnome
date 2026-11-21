// Item 4 of the engine-host spike (docs/research/spike-engine-host.md, item 4 and §5): requests that bypass the
// proxy engines ("native" requests from proxied documents), their root cause, and the GNOME-imposed CSP on proxied
// documents as a mitigation.
//
//   lab        /leak/matrix (servers/isolation-leak-pages.mjs) per engine x CSP mode: which constructs escape
//   probe      /csp-probe per engine x CSP mode: engine-relevant page features under the GNOME CSP
//   sites      real sites per engine x CSP mode: native requests, CSP violations, page health
//   rootcause  Wikipedia with a Text-node tap (init script) + a scan of every stylesheet for unrewritten URLs
//   bypass     what an ESCAPED page (unrewritten JS in the proxied document) can still send natively with the CSP on
//
// Knobs (environment): SPIKE_LEAK_PARTS (default all), SPIKE_LEAK_SITES (keys of SITES in lib/config.mjs),
// SPIKE_LEAK_MODES (off,enforce[,report-only]), SPIKE_LEAK_ENGINES (scramjet,ultraviolet).
// Detection: Playwright request events (both browsers), CDP Network with initiators (Chromium), the sentinel
// proxy (every non-loopback egress of the browser), CSP reports (POST /__csp-report) and the engine host's
// securitypolicyviolation counter.
import dgram from 'node:dgram';
import { TARGET_ORIGIN, SITES, PORTS } from '../lib/config.mjs';
import { readOut, withDeadline } from '../lib/drive.mjs';
import { NetWatch, settle, sentinelHost, BROWSER_NOISE } from '../lib/netwatch.mjs';
import { LEAK_CONSTRUCTS, leakHost, LEAK_DOMAIN } from '../servers/isolation-leak-pages.mjs';

const list = (name, dflt) => (process.env[name] || dflt).split(',').map((s) => s.trim()).filter(Boolean);
const PARTS = new Set(list('SPIKE_LEAK_PARTS', 'lab,probe,sites,rootcause,bypass,hostcsp,cspbus'));
const MODES = list('SPIKE_LEAK_MODES', 'off,enforce');
const ENGINES = list('SPIKE_LEAK_ENGINES', 'scramjet,ultraviolet');
const SITE_KEYS = list('SPIKE_LEAK_SITES', 'wikipedia,github,hn,mdn,rust,python,npm,bbc');
// lib/config.mjs SITES plus two sites with script-built styles (React/CSS-in-JS front ends).
const SITE_URLS = { ...SITES, npm: 'https://www.npmjs.com/package/playwright-core', bbc: 'https://www.bbc.com/news' };
const TRANSPORT = { scramjet: 'libcurl', ultraviolet: 'epoxy' };
let tabSeq = 100;

function appQuery(mode, extra = {}) {
  const q = { fallback: '0', ...extra };
  if (mode !== 'off') q.csp = mode;
  return q;
}

async function freshApp(ctx, browser, query) {
  const context = await ctx.newContext(browser);
  const watch = new NetWatch(context, ctx.browser);
  const app = await ctx.openApp(context, query);
  await watch.attachExisting();
  return { context, watch, app };
}

async function closeTab(app, tabId) {
  try { await app.cmd('tab.close', { tabId }); } catch { /* already gone */ }
}

// Everything observed since mark m / time t0: native requests, sentinel egress, CSP violations.
async function observe(ctx, app, watch, m, t0) {
  const natives = watch.natives(m);
  const sentinel = ctx.eventsSince(t0, 'sentinel').map((e) => ({ kind: e.kind, host: sentinelHost(e), url: e.url || e.target }));
  const egress = sentinel.filter((s) => !BROWSER_NOISE.test(s.host));
  const noise = sentinel.length - egress.length;
  const reports = ctx.eventsSince(t0, 'csp-report').map((e) => ({ blocked: e.blockedUri, directive: e.directive, disposition: e.disposition, doc: e.documentUri }));
  let violations = [];
  try { violations = ((await app.stats()).counters.csp || []).filter((v) => v.t >= t0); } catch { /* host gone */ }
  return { natives, egress, noise, reports, violations, counts: watch.counts(m), strays: watch.strays(m) };
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const uniq = (a) => [...new Set(a)];

/* ------------------------------------------------------------------------------------------------- lab -- */
const labOffNative = new Map(); // engine -> ids of the constructs that went native with the CSP off (this browser)
function labVerdicts(obs, watch, m, ctx, t0) {
  const reqs = watch.since(m).reqs;
  const targetHits = ctx.eventsSince(t0, 'target-request').map((e) => e.path);
  const blockedHosts = new Set([...obs.violations.map((v) => hostOf(v.blocked)), ...obs.reports.map((r) => hostOf(r.blocked))]);
  const cdpBlocked = new Set(watch.since(m).cdp.filter((c) => c.blockedReason === 'csp').map((c) => hostOf(c.url)));
  const out = {};
  for (const c of LEAK_CONSTRUCTS) {
    const v = { native: false, egress: false, proxied: false, stray: false, cspBlocked: false };
    if (c.url === 'rel') {
      const path = `/leak-rel/${c.id}.png`;
      v.stray = reqs.some((r) => r.kind === 'stray' && new URL(r.url).pathname === path);
      v.proxied = reqs.some((r) => r.kind === 'proxied' && r.target && r.target.includes(path)) || targetHits.includes(path);
    } else {
      const host = leakHost(c.id);
      v.native = obs.natives.some((n) => hostOf(n.url) === host && n.blockedReason !== 'csp' && !/BLOCKED_BY_CSP|CSP/i.test(String(n.failure || n.errorText || '')));
      v.egress = obs.egress.some((s) => s.host === host);
      v.proxied = reqs.some((r) => r.kind === 'proxied' && r.target && r.target.includes(host));
      v.cspBlocked = blockedHosts.has(host) || cdpBlocked.has(host);
    }
    v.verdict = v.native || v.egress ? 'NATIVE' : v.stray ? 'stray' : v.cspBlocked ? 'csp-blocked' : v.proxied ? 'proxied' : 'none';
    out[c.id] = v;
  }
  return out;
}

async function lab(ctx, browser) {
  for (const mode of MODES) {
    const { context, watch, app } = await freshApp(ctx, browser, appQuery(mode, { route: 'test' }));
    try {
      for (const engine of ENGINES) {
        const tabId = ++tabSeq;
        await app.cmd('test.resetStats');
        const m = watch.mark();
        const t0 = Date.now();
        const r = await app.navigate(tabId, `${TARGET_ORIGIN}/leak/matrix`, { create: true, engine, timeout: 45000 });
        const ran = await readOut(app, tabId, 20000);
        await settle(watch, { quietMs: 2000, maxMs: 10000 });
        await ctx.sleep(500);
        const obs = await observe(ctx, app, watch, m, t0);
        const verdicts = labVerdicts(obs, watch, m, ctx, t0);
        const leaked = Object.entries(verdicts).filter(([, v]) => v.verdict === 'NATIVE').map(([k]) => k);
        const stray = Object.entries(verdicts).filter(([, v]) => v.verdict === 'stray').map(([k]) => k);
        const blocked = Object.entries(verdicts).filter(([, v]) => v.verdict === 'csp-blocked').map(([k]) => k);
        const threw = ran ? Object.entries(ran).filter(([, s]) => s !== 'ran').map(([k, s]) => `${k}: ${s}`) : ['no #out'];
        const ok = r.ok && ran;
        // Positive evidence for the mitigation: with the CSP on, every construct that went native with it off must be
        // reported as BLOCKED (a construct that silently made no request would not prove anything).
        if (mode === 'off' && ok) labOffNative.set(engine, new Set(leaked));
        const unproven = mode !== 'off' && labOffNative.has(engine) ? [...labOffNative.get(engine)].filter((k) => verdicts[k]?.verdict !== 'csp-blocked') : [];
        ctx.record({
          engine, transport: TRANSPORT[engine], test: `lab:${mode}`,
          result: !ok ? 'fail' : leaked.length || unproven.length ? 'fail' : 'pass',
          expectFail: mode === 'off' && leaked.length > 0,
          notes: `${ok ? '' : `LOAD FAILED ${JSON.stringify(r.error).slice(0, 120)}; `}native ${leaked.length}/${LEAK_CONSTRUCTS.length}: ${leaked.join(', ') || 'none'}${stray.length ? `; stray: ${stray.join(', ')}` : ''}${blocked.length ? `; csp-blocked ${blocked.length}` : ''}${mode !== 'off' && labOffNative.has(engine) ? `; native-with-CSP-off constructs blocked now: ${labOffNative.get(engine).size - unproven.length}/${labOffNative.get(engine).size}${unproven.length ? ` (NOT blocked: ${unproven.join(', ')})` : ''}` : ''}`,
          data: { verdicts, threw, counts: obs.counts, egressHosts: uniq(obs.egress.map((e) => e.host)), noise: obs.noise, reports: obs.reports.length, violations: obs.violations.length, nativeSample: obs.natives.slice(0, 80) },
        });
        await closeTab(app, tabId);
      }
    } finally {
      await watch.close();
      await context.close();
    }
  }
}

/* ----------------------------------------------------------------------------------------------- probe -- */
// Poll #out until it reports done (the probe writes partial results after every check).
async function readDone(app, tabId, timeout = 60000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    const f = app.tabFrame(tabId);
    if (f) {
      try {
        const txt = await withDeadline(f.evaluate(() => { const el = document.getElementById('out'); return el ? el.textContent : null; }));
        if (txt && txt !== 'pending') { last = JSON.parse(txt); if (last.done) return last; }
      } catch { /* navigating */ }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last ? { ...last, incomplete: true } : null;
}

async function probe(ctx, browser) {
  const base = {};
  for (const mode of MODES) {
    const { context, watch, app } = await freshApp(ctx, browser, appQuery(mode, { route: 'test' }));
    try {
      for (const engine of ENGINES) {
        const tabId = ++tabSeq;
        await app.cmd('test.resetStats');
        const t0 = Date.now();
        const m = watch.mark();
        const r = await app.navigate(tabId, `${TARGET_ORIGIN}/leak/csp-probe`, { create: true, engine, timeout: 45000 });
        const out = await readDone(app, tabId, 90000);
        const obs = await observe(ctx, app, watch, m, t0);
        const failed = out ? Object.entries(out).filter(([, v]) => typeof v === 'string' && v.startsWith('FAIL')).map(([k, v]) => `${k}=${v}`) : ['no output'];
        if (out && out.incomplete) failed.push(`incomplete after ${Object.keys(out).length - 1} checks`);
        if (mode === 'off') base[engine] = new Set(failed.map((f) => f.split('=')[0]));
        const regressions = mode === 'off' ? [] : failed.filter((f) => !(base[engine] || new Set()).has(f.split('=')[0]));
        const selfViolations = obs.violations.filter((v) => !/gnome-spike\.invalid/.test(v.blocked));
        ctx.record({
          engine, transport: TRANSPORT[engine], test: `csp-probe:${mode}`,
          result: !r.ok || !out ? 'fail' : mode === 'off' ? (failed.length ? 'partial' : 'pass') : regressions.length || selfViolations.length ? 'fail' : 'pass',
          notes: `${r.ok ? '' : 'LOAD FAILED; '}failing checks: ${failed.join('; ') || 'none'}${mode !== 'off' ? `; regressions vs off: ${regressions.join('; ') || 'none'}; violations: ${obs.violations.length}` : ''}`,
          data: { out, violations: obs.violations.slice(0, 20), reports: obs.reports.slice(0, 20) },
        });
        await closeTab(app, tabId);
      }
    } finally {
      await watch.close();
      await context.close();
    }
  }
}

/* ----------------------------------------------------------------------------------------------- sites -- */
// Page health, read with the engine host's native getters (engine hooks would alter what the page reports).
function pageHealth() {
  const H = window.top[0];
  const q = (sel) => H.Document.prototype.querySelectorAll.call(document, sel);
  const imgs = [...q('img')];
  const shown = imgs.filter((i) => i.complete && i.naturalWidth > 0).length;
  const body = H.Document.prototype.querySelector.call(document, 'body');
  const text = body ? Object.getOwnPropertyDescriptor(H.HTMLElement.prototype, 'innerText').get.call(body) : '';
  return {
    title: Object.getOwnPropertyDescriptor(H.Document.prototype, 'title').get.call(document).slice(0, 120),
    images: imgs.length,
    imagesShown: shown,
    styleSheets: Object.getOwnPropertyDescriptor(H.Document.prototype, 'styleSheets').get.call(document).length,
    textLength: text.length,
    elements: q('*').length,
    iframes: q('iframe').length,
  };
}

// Every url(...) in the document's CSS that does not point at an engine URL on the proxy origin.
function scanStyles() {
  const H = window.top[0];
  const D = H.Document.prototype;
  const getText = Object.getOwnPropertyDescriptor(H.Node.prototype, 'textContent').get;
  const baseOf = Object.getOwnPropertyDescriptor(H.Node.prototype, 'baseURI').get;
  const ruleText = Object.getOwnPropertyDescriptor(H.CSSRule.prototype, 'cssText').get;
  const rulesOf = Object.getOwnPropertyDescriptor(H.CSSStyleSheet.prototype, 'cssRules').get;
  const sheetsOf = Object.getOwnPropertyDescriptor(D, 'styleSheets').get;
  const getAttr = H.Element.prototype.getAttribute;
  const proxy = H.location.origin;
  const docBase = baseOf.call(document);
  const bad = [];
  const scanned = { styles: 0, links: 0, attrs: 0, adopted: 0 };
  const scan = (text, where) => {
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
    let mm;
    while ((mm = re.exec(text))) {
      const raw = (mm[1] ?? mm[2] ?? mm[3] ?? '').trim();
      if (!raw || /^(data:|blob:|#|about:)/i.test(raw)) continue;
      let abs;
      try { abs = new URL(raw, docBase); } catch { continue; }
      if (abs.origin === proxy && (abs.pathname.startsWith('/~/sj/') || abs.pathname.startsWith('/uv/service/'))) continue;
      bad.push({ where, form: /^https?:/i.test(raw) ? 'absolute' : raw.startsWith('//') ? 'protocol-relative' : 'relative', raw: raw.slice(0, 200), resolved: abs.href.slice(0, 200) });
    }
  };
  const styles = [...D.querySelectorAll.call(document, 'style')];
  styles.forEach((st, i) => {
    scanned.styles++;
    const attrs = [...st.attributes].map((a) => a.name).join(',');
    scan(getText.call(st), `style#${i} textNodes=${st.childNodes.length}${attrs ? ` attrs=${attrs}` : ''}`);
  });
  for (const sh of sheetsOf.call(document)) {
    if (sh.ownerNode && sh.ownerNode.tagName === 'STYLE') continue;
    scanned.links++;
    let rules;
    try { rules = rulesOf.call(sh); } catch { continue; }
    for (const r of rules) scan(ruleText.call(r), `link ${String(sh.href || '').slice(0, 100)}`);
  }
  for (const el of D.querySelectorAll.call(document, '[style]')) { scanned.attrs++; scan(getAttr.call(el, 'style') || '', `style-attr <${el.tagName.toLowerCase()}>`); }
  for (const sh of document.adoptedStyleSheets || []) { scanned.adopted++; for (const r of rulesOf.call(sh)) scan(ruleText.call(r), 'adoptedStyleSheet'); }
  const byForm = {};
  for (const b of bad) byForm[b.form] = (byForm[b.form] || 0) + 1;
  return { docBase: docBase.slice(0, 160), scanned, unrewritten: bad.length, byForm, sample: bad.slice(0, 12) };
}

const siteMetrics = new Map(); // `${engine}|${site}|${mode}` -> metrics

async function sites(ctx, browser) {
  if (ctx.offline) {
    ctx.record({ test: 'sites', result: 'not_run', notes: '--offline' });
    return;
  }
  for (const mode of MODES) {
    const { context, watch, app } = await freshApp(ctx, browser, appQuery(mode));
    try {
      for (const engine of ENGINES) {
        for (const key of SITE_KEYS) {
          const url = SITE_URLS[key];
          if (!url) continue;
          const tabId = ++tabSeq;
          await app.cmd('test.resetStats').catch(() => {});
          const m = watch.mark();
          const t0 = Date.now();
          const r = await app.navigate(tabId, url, { create: true, engine, timeout: 60000 });
          const settledMs = r.ok ? await settle(watch, { quietMs: 3000, maxMs: 20000 }) : 0;
          const frame = app.tabFrame(tabId);
          let health = null;
          let styles = null;
          if (frame) {
            try { health = await withDeadline(frame.evaluate(pageHealth), 15000); } catch (e) { health = { error: String(e.message || e).slice(0, 160) }; }
            try { styles = await withDeadline(frame.evaluate(scanStyles), 15000); } catch (e) { styles = { error: String(e.message || e).slice(0, 160) }; }
          }
          const obs = await observe(ctx, app, watch, m, t0);
          const nativeHosts = uniq(obs.natives.filter((n) => n.blockedReason !== 'csp' && !/BLOCKED_BY_CSP/i.test(String(n.failure || n.errorText || ''))).map((n) => hostOf(n.url)));
          const egressHosts = uniq(obs.egress.map((e) => e.host));
          const leakFree = nativeHosts.length === 0 && egressHosts.length === 0;
          const selfViolations = obs.violations.filter((v) => { const h = hostOf(v.blocked); return !h || h === '127.0.0.1' || h === 'localhost'; });
          const metrics = { ok: r.ok, ms: r.ms, settledMs, title: r.title, health, styles, counts: obs.counts, nativeHosts, egressHosts, natives: obs.natives.slice(0, 40), strays: obs.strays.slice(0, 20), violations: obs.violations.length, violationHosts: uniq(obs.violations.map((v) => `${v.directive} ${hostOf(v.blocked) || v.blocked}`)).slice(0, 20), selfViolations: selfViolations.slice(0, 10), reports: obs.reports.length, error: r.error };
          siteMetrics.set(`${engine}|${key}|${mode}`, metrics);
          let result;
          if (!r.ok) result = 'fail';
          else if (mode === 'off') result = leakFree ? 'pass' : 'fail';
          else result = leakFree && selfViolations.length === 0 ? 'pass' : leakFree ? 'partial' : 'fail';
          ctx.record({
            engine, transport: TRANSPORT[engine], test: `site:${key}:${mode}`, result,
            expectFail: mode === 'off' && r.ok && !leakFree,
            notes: `${r.ok ? `loaded ${r.ms} ms` : `NOT LOADED ${JSON.stringify(r.error).slice(0, 100)}`}; proxied ${obs.counts.proxied}, stray ${obs.counts.stray}, native ${obs.natives.length} [${nativeHosts.join(' ') || '-'}], egress [${egressHosts.join(' ') || '-'}]; violations ${obs.violations.length}${selfViolations.length ? ` (self ${selfViolations.length})` : ''}; unrewritten css urls ${styles?.unrewritten ?? '?'}; imgs ${health?.imagesShown ?? '?'}/${health?.images ?? '?'}`,
            data: metrics,
          });
          await closeTab(app, tabId);
        }
      }
    } finally {
      await watch.close();
      await context.close();
    }
  }
  // CSP compatibility: compare each enforce run with the off run of the same engine and site.
  if (MODES.includes('off') && MODES.includes('enforce')) {
    for (const engine of ENGINES) {
      for (const key of SITE_KEYS) {
        const off = siteMetrics.get(`${engine}|${key}|off`);
        const on = siteMetrics.get(`${engine}|${key}|enforce`);
        if (!off || !on) continue;
        const d = {
          loaded: [off.ok, on.ok],
          title: [off.health?.title, on.health?.title],
          imagesShown: [off.health?.imagesShown, on.health?.imagesShown],
          textLength: [off.health?.textLength, on.health?.textLength],
          elements: [off.health?.elements, on.health?.elements],
          proxied: [off.counts.proxied, on.counts.proxied],
          nativeHosts: [off.nativeHosts, on.nativeHosts],
          egressHosts: [off.egressHosts, on.egressHosts],
          violations: on.violations,
          selfViolations: on.selfViolations,
        };
        const same = on.ok && off.ok && d.title[0] === d.title[1];
        const imgDrop = (off.health?.imagesShown || 0) - (on.health?.imagesShown || 0);
        const textRatio = off.health?.textLength ? (on.health?.textLength || 0) / off.health.textLength : 1;
        const fixed = on.nativeHosts.length === 0 && on.egressHosts.length === 0;
        const healthy = same && imgDrop <= Math.max(2, (off.health?.imagesShown || 0) * 0.1) && textRatio > 0.9 && on.selfViolations.length === 0;
        ctx.record({
          engine, transport: TRANSPORT[engine], test: `csp-compat:${key}`,
          result: fixed && healthy ? 'pass' : fixed ? 'partial' : 'fail',
          notes: `leaks off->on: [${off.nativeHosts.join(' ') || '-'}] -> [${on.nativeHosts.join(' ') || '-'}]; title same: ${d.title[0] === d.title[1]}; imgs ${d.imagesShown.join('->')}; text ${d.textLength.join('->')}; proxied ${d.proxied.join('->')}; violations ${on.violations} (self ${on.selfViolations.length})`,
          data: d,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------------------------------- rootcause -- */
// Document-start tap (Playwright init script, main world, before the engines hook the window): logs every
// Text node or string with "url(" inserted into a STYLE element through a DOM insertion API, with the caller.
function styleTap() {
  if (window.__gnomeStyleTap) return;
  const log = [];
  Object.defineProperty(window, '__gnomeStyleTap', { value: log, enumerable: false });
  const wrap = (proto, name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      try {
        if (this && this.nodeName && String(this.nodeName).toLowerCase() === 'style' && log.length < 200) {
          for (const a of args) {
            const text = typeof a === 'string' ? a : a && a.nodeType === 3 ? a.data : null;
            if (text && /url\(/i.test(text)) {
              const sample = (text.match(/url\([^)]{0,200}\)/i) || [''])[0];
              log.push({ api: `${proto === Node.prototype ? 'Node' : 'Element'}.${name}`, len: text.length, sample, inDoc: this.isConnected, stack: String(new Error().stack || '').split('\n').slice(2, 7).map((l) => l.trim().slice(0, 300)) });
            }
          }
        }
      } catch { /* never break the page */ }
      return orig.apply(this, args);
    };
  };
  wrap(Node.prototype, 'appendChild');
  wrap(Node.prototype, 'insertBefore');
  wrap(Element.prototype, 'append');
  wrap(Element.prototype, 'prepend');
  wrap(Element.prototype, 'replaceChildren');
}

async function rootcause(ctx, browser) {
  if (ctx.offline) return;
  for (const engine of ENGINES) {
    const context = await ctx.newContext(browser);
    await context.addInitScript(styleTap);
    const watch = new NetWatch(context, ctx.browser);
    try {
      const app = await ctx.openApp(context, appQuery('off'));
      await watch.attachExisting();
      const tabId = ++tabSeq;
      const m = watch.mark();
      const t0 = Date.now();
      const r = await app.navigate(tabId, SITES.wikipedia, { create: true, engine, timeout: 60000 });
      await settle(watch, { quietMs: 3000, maxMs: 20000 });
      const frame = app.tabFrame(tabId);
      let tap = null;
      let styles = null;
      if (frame) {
        try { tap = await frame.evaluate(() => window.__gnomeStyleTap || null); } catch (e) { tap = String(e.message || e); }
        try { styles = await frame.evaluate(scanStyles); } catch (e) { styles = { error: String(e.message || e) }; }
      }
      const obs = await observe(ctx, app, watch, m, t0);
      const natives = obs.natives.filter((n) => /wiki[mp]edia\.org|wikidata\.org/.test(hostOf(n.url)));
      // Which tapped insertions carried the URLs that went out natively?
      const nativePaths = natives.map((n) => { try { const u = new URL(n.url); return u.pathname + u.search; } catch { return n.url; } });
      const tapped = Array.isArray(tap) ? tap : [];
      const matching = tapped.filter((e) => nativePaths.some((p) => e.sample.includes(p.slice(0, 40)) || e.sample.includes(p.split('?')[0])));
      const initiators = uniq(natives.map((n) => (n.initiator ? `${n.initiator.type}${n.initiator.url ? ` ${n.initiator.url.slice(0, 80)}` : ''}` : 'n/a')));
      ctx.record({
        engine, transport: TRANSPORT[engine], test: 'rootcause:wikipedia',
        result: r.ok ? 'pass' : 'fail',
        notes: `${r.ok ? '' : 'NOT LOADED; '}native ${natives.length} (${uniq(natives.map((n) => n.type)).join(',')}; initiator ${initiators.join(' | ')}); text-node style inserts with url(): ${tapped.length} (${uniq(tapped.map((e) => e.api)).join(',')}), matching native URLs: ${matching.length}; unrewritten css urls in DOM: ${styles?.unrewritten ?? '?'} ${JSON.stringify(styles?.byForm || {})}`,
        data: { natives: natives.slice(0, 30), tap: tapped.slice(0, 30), matching: matching.slice(0, 10), styles },
      });
    } finally {
      await watch.close();
      await context.close();
    }
  }
}

/* ---------------------------------------------------------------------------------------------- bypass -- */
// With the GNOME CSP enforced, unrewritten JS in a proxied document (any of upstream's known engine escapes) tries
// every route to the network that does not go through the engines. Each route has its own unroutable host.
async function escapedRoutes({ domain, stun }) {
  const out = {};
  const host = (k) => `https://leak-bypass-${k}.${domain}/x`;
  const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = `threw ${e && e.name}: ${String(e && e.message).slice(0, 100)}`; } };
  const H = window.top[0]; // the engine host window: same origin, reached through the real (unforgeable) window.top
  await t('own-realm-fetch', async () => { await fetch(host('own-fetch')); return 'resolved'; }); // hooked by the engine
  await t('blank-iframe-fetch', async () => { const f = document.createElement('iframe'); document.body.appendChild(f); const w = f.contentWindow; await w.fetch(host('blank-iframe')).then(() => 'resolved', (e) => `rejected ${e.name}`); return 'done'; });
  await t('engine-host-fetch', async () => H.fetch(host('host-fetch'), { mode: 'no-cors' }).then(() => 'resolved', (e) => `rejected ${e.name}`));
  await t('engine-host-image', () => { const i = new H.Image(); i.src = host('host-image'); H.document.body.appendChild(i); return 'set'; });
  await t('popup', () => { const w = H.open(host('popup'), '_blank'); return w ? 'opened' : 'blocked'; });
  await t('rtc', async () => {
    const pc = new H.RTCPeerConnection({ iceServers: [{ urls: stun }] });
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 1500));
    const types = (pc.localDescription?.sdp || '').split('\n').filter((l) => l.startsWith('a=candidate')).map((l) => l.split(' ')[7]);
    pc.close();
    return `candidates: ${types.join(',') || 'none'}`;
  });
  await t('self-navigation', () => { setTimeout(() => { location.href = host('self-nav'); }, 50); return 'scheduled'; });
  return out;
}

// UDP listener standing in for a STUN server: WebRTC traffic never reaches the HTTP sentinel.
export const STUN_PORT = Number(process.env.SPIKE_STUN_PORT) || PORTS.sentinel - 1;
export async function udpSink(port = STUN_PORT) {
  const sock = dgram.createSocket('udp4');
  const packets = [];
  sock.on('message', (msg, rinfo) => packets.push({ t: Date.now(), bytes: msg.length, from: `${rinfo.address}:${rinfo.port}`, stunBinding: msg.length >= 20 && msg.readUInt16BE(0) === 0x0001 }));
  await new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(port, '127.0.0.1', resolve); });
  return { packets, url: `stun:127.0.0.1:${port}`, close: () => new Promise((r) => sock.close(r)) };
}

async function bypass(ctx, browser) {
  const sink = await udpSink();
  try {
    for (const engine of ENGINES) await bypassEngine(ctx, browser, engine, sink);
  } finally {
    await sink.close();
  }
}

async function bypassEngine(ctx, browser, engine, sink, label = 'csp-bypass') {
  {
    const { context, watch, app } = await freshApp(ctx, browser, appQuery('enforce', { route: 'test' }));
    try {
      const tabId = ++tabSeq;
      const r = await app.navigate(tabId, `${TARGET_ORIGIN}/iso/probe`, { create: true, engine, timeout: 45000 });
      await readOut(app, tabId, 20000);
      const m = watch.mark();
      const t0 = Date.now();
      const frame = app.tabFrame(tabId);
      const udpBefore = sink.packets.length;
      const out = frame ? await frame.evaluate(escapedRoutes, { domain: LEAK_DOMAIN, stun: sink.url }).catch((e) => ({ error: String(e.message || e) })) : { error: 'no frame' };
      await ctx.sleep(3000);
      const obs = await observe(ctx, app, watch, m, t0);
      const udp = sink.packets.slice(udpBefore);
      const seen = (k) => {
        if (k === 'rtc') return { native: udp.length > 0, egress: udp.length > 0, blocked: false, udpPackets: udp.length, stunBindings: udp.filter((p) => p.stunBinding).length };
        const h = `leak-bypass-${k}.${LEAK_DOMAIN}`;
        const n = obs.natives.find((x) => hostOf(x.url) === h);
        return { native: Boolean(n && n.blockedReason !== 'csp' && !/BLOCKED_BY_CSP/i.test(String(n.failure || ''))), egress: obs.egress.some((s) => s.host === h), blocked: obs.violations.some((v) => hostOf(v.blocked) === h) || obs.reports.some((x) => hostOf(x.blocked) === h) || Boolean(n && n.blockedReason === 'csp') };
      };
      const routes = { 'own-realm-fetch': 'own-fetch', 'blank-iframe-fetch': 'blank-iframe', 'engine-host-fetch': 'host-fetch', 'engine-host-image': 'host-image', popup: 'popup', 'self-navigation': 'self-nav', rtc: 'rtc' };
      for (const [route, k] of Object.entries(routes)) {
        const s = seen(k);
        const leaked = s.native || s.egress;
        ctx.record({
          engine, transport: TRANSPORT[engine], test: `${label}:${route}`,
          result: leaked ? 'fail' : 'pass',
          expectFail: leaked, // documented: the CSP only covers documents the engines create
          notes: `${r.ok ? '' : 'PROBE NOT LOADED; '}${leaked ? 'NATIVE egress' : s.blocked ? 'blocked by CSP' : 'no native request'}; js: ${String(out[route] ?? out.error ?? '').slice(0, 120)}`,
          data: { route, seen: s, js: out[route] },
        });
      }
      for (const p of context.pages()) if (p !== app.page) await p.close().catch(() => {});
    } finally {
      await watch.close();
      await context.close();
    }
  }
}

/* --------------------------------------------------------------------------------------------- hostcsp -- */
// Experiment: the same policy on the ENGINE HOST document (servers/proxy.mjs, SPIKE_ENGINE_HOST_CSP), so an escaped
// page cannot borrow the engine host's realm for native requests. Re-runs the bypass routes, then checks that both
// engines still initialize and load pages (local leak matrix + two real sites), and restores the default proxy.
// connect-src includes data:: libcurl-transport's Emscripten loader fetch()es its wasm from a data: URL (no network).
export const ENGINE_HOST_CSP = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data:; form-action 'self'; report-uri /__csp-report";

async function hostcsp(ctx, browser) {
  process.env.SPIKE_ENGINE_HOST_CSP = ENGINE_HOST_CSP;
  await ctx.restartProxy(300);
  const sink = await udpSink();
  try {
    for (const engine of ENGINES) await bypassEngine(ctx, browser, engine, sink, 'hostcsp-bypass');
    const { context, watch, app } = await freshApp(ctx, browser, appQuery('enforce'));
    try {
      const t0 = Date.now();
      const hostViolations = () => ctx.eventsSince(t0, 'csp-report').filter((e) => /\/engine\/$/.test(e.documentUri));
      ctx.record({ test: 'hostcsp:init', result: app.init.engines.scramjet.state === 'ready' && app.init.engines.ultraviolet.state === 'ready' ? 'pass' : 'fail', notes: `engines ${JSON.stringify(app.init.engines).slice(0, 200)}; transports ${JSON.stringify(app.init.transport).slice(0, 200)}` });
      for (const engine of ENGINES) {
        for (const key of ['wikipedia', 'github']) {
          const tabId = ++tabSeq;
          const m = watch.mark();
          const t1 = Date.now();
          const r = await app.navigate(tabId, SITE_URLS[key], { create: true, engine, timeout: 60000 });
          if (r.ok) await settle(watch, { quietMs: 2500, maxMs: 15000 });
          const obs = await observe(ctx, app, watch, m, t1);
          const leaks = uniq([...obs.natives.filter((n) => n.blockedReason !== 'csp' && !/BLOCKED_BY_CSP/i.test(String(n.failure || n.errorText || ''))).map((n) => hostOf(n.url)), ...obs.egress.map((e) => e.host)]);
          ctx.record({ engine, transport: TRANSPORT[engine], test: `hostcsp-site:${key}`, result: r.ok && !leaks.length ? 'pass' : 'fail', notes: `${r.ok ? `loaded ${r.ms} ms, title ${JSON.stringify(r.title)}` : `NOT LOADED ${JSON.stringify(r.error).slice(0, 120)}`}; proxied ${obs.counts.proxied}; native/egress [${leaks.join(' ') || '-'}]` });
          await closeTab(app, tabId);
        }
      }
      const hv = hostViolations();
      ctx.record({ test: 'hostcsp:engine-host-violations', result: hv.length ? 'fail' : 'pass', notes: hv.length ? `engine host document violations: ${uniq(hv.map((e) => `${e.directive} ${e.blockedUri}`)).slice(0, 8).join(' | ')}` : 'no CSP violation reported by the engine host document while both engines ran' });
    } finally {
      await watch.close();
      await context.close();
    }
  } finally {
    await sink.close();
    delete process.env.SPIKE_ENGINE_HOST_CSP;
    await ctx.restartProxy(300);
  }
}

/* ---------------------------------------------------------------------------------------------- cspbus -- */
// Integrity of the mitigation (session 4): an ordinary UV-proxied page posts sw-config {csp:'off'} on the gnome-engine
// BroadcastChannel for 3 s, then a UV leak page loads. Default: the SW takes its config only from the engine host's
// postMessage, so the CSP must hold (0 native egress, violations reported). swConfigBus=1 re-enables the session-3
// bus path: the forged config then switches the UV CSP off (expectFail, documents the fixed hole).
async function cspbus(ctx, browser) {
  for (const viaBus of [false, true]) {
    const { context, watch, app } = await freshApp(ctx, browser, appQuery('enforce', { route: 'test', swConfigBus: viaBus ? '1' : '0' }));
    try {
      const poison = await app.navigate(++tabSeq, `${TARGET_ORIGIN}/leak/bus-poison`, { create: true, engine: 'ultraviolet', timeout: 30000 });
      await app.waitFor(0, (e) => e.type === 'tab.title' && e.p.title === 'bus poison done', 8000);
      await app.cmd('test.resetStats');
      const m = watch.mark();
      const t0 = Date.now();
      const r = await app.navigate(++tabSeq, `${TARGET_ORIGIN}/leak/matrix`, { create: true, engine: 'ultraviolet', timeout: 45000 });
      await readOut(app, tabSeq, 20000);
      await settle(watch, { quietMs: 2000, maxMs: 10000 });
      const obs = await observe(ctx, app, watch, m, t0);
      const egress = uniq(obs.egress.map((e) => e.host)).filter((h) => h.endsWith(LEAK_DOMAIN));
      const held = poison.ok && r.ok && egress.length === 0 && obs.violations.length > 0;
      ctx.record({
        engine: 'ultraviolet', transport: TRANSPORT.ultraviolet, test: `cspbus:${viaBus ? 'legacy bus config (swConfigBus=1)' : 'forged sw-config from a proxied page'}`,
        result: held ? 'pass' : 'fail',
        expectFail: viaBus && !held,
        notes: `${poison.ok ? '' : 'POISON PAGE NOT LOADED; '}${r.ok ? '' : 'LEAK PAGE NOT LOADED; '}after the page posted sw-config csp:off for 3 s: native egress ${egress.length} host(s), CSP violations ${obs.violations.length}${viaBus ? ' (legacy path: the SW accepts bus config)' : ''}`,
      });
    } finally {
      await watch.close();
      await context.close();
    }
  }
}

export async function run(ctx) {
  // Firefox: allow ICE over loopback so the local STUN sink (bypass part) can observe WebRTC traffic.
  const browser = await ctx.launch({ extraPrefs: { 'media.peerconnection.ice.loopback': true } });
  try {
    if (PARTS.has('lab')) await lab(ctx, browser);
    if (PARTS.has('probe')) await probe(ctx, browser);
    if (PARTS.has('rootcause')) await rootcause(ctx, browser);
    if (PARTS.has('sites')) await sites(ctx, browser);
    if (PARTS.has('bypass')) await bypass(ctx, browser);
    if (PARTS.has('hostcsp')) await hostcsp(ctx, browser);
    if (PARTS.has('cspbus')) await cspbus(ctx, browser);
  } finally {
    await browser.close();
  }
}
