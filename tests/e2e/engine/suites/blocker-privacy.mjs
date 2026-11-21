// Lane x3 (docs/WAVE-B3.md §6, §12.2 rows P1–P12): privacy protection on the real stack, both engines, through the
// e2e driver page and the content-blocker fixture server (servers/blocker-fixtures.mjs, lane x5; reached over the VPN
// profile route `e2e-vpn`). The engine host must offer `blocker` (the D19 build switch) with lane x1's composite
// holding x3's providers (host/providers.ts, sw/providers.ts); without them every row records why it cannot run.
//
//   P1  Sec-GPC: 1 on documents and subresources, navigator.globalPrivacyControl === true; neither with privacy off
//   P2  DNT: 1 and navigator.doNotTrack === '1'
//   P3  the Referer floor (mode `default`, and privacy protection off): a cross-origin request gets only the origin
//       (Ultraviolet sent the whole URL before); P3b https → http: none (a real https page over the VPN route, which
//       reaches the internet too, loads a fixture image; skipped with --offline).
//   P4  `origin-cross-site`: cross-site Referer and document.referrer (also through the prototype's descriptor) are
//       the origin, same-origin requests get the full URL
//   P5  `none`: no Referer, document.referrer === ''
//   P6  never widened: a page with Referrer-Policy: no-referrer still sends none, with its images and with its own
//       navigations (its frame, a link a user clicks: Scramjet serves documents as unsafe-url, so GNOME applies it);
//       P6m (measured) the same policy from <meta name="referrer">: Scramjet ignores it for its HTML's elements and links
//   P7  a link with utm_source, fbclid, gnome_e2e (the test list's $removeparam) and id lands on ?id=1, the history
//       entry is the clean URL, `urlparams` counted
//   P8  a POST form keeps its URL, a frame document is stripped
//   P9  an allowlisted site keeps its parameters and still gets GPC
//   P10 a page that sends the browser back to its tracked URL: at most 3 strips, no loop
//   P11 a link from site-b to allowlisted site-a/?utm_source=x keeps its parameter (judged under site-a, D3)
//   P12 a dedicated worker's request carries Sec-GPC (the worker has no navigator.globalPrivacyControl: About)
//
// The helpers below are also used by blocker-cookies.mjs.
import { inFrame, perEngine, realClick } from './host-lib.mjs';
import { tabText } from '../lib/tab-read.mjs';

export const ENGINES = ['scramjet', 'ultraviolet'];
const enc = encodeURIComponent;

/** The privacy/extensions part of EngineSettings for a row (everything else stays as the driver started). */
export function blockerSettings({ privacy = {}, enabled = {}, extensions = {} } = {}) {
  return {
    privacy: { webrtc: 'block', sendGpc: true, doNotTrack: false, referrer: 'origin-cross-site', stripTrackingParams: true, cookies: 'block-third-party', ...privacy },
    extensions: {
      enabled: { adblock: false, trackers: false, privacy: true, cookies: true, cosmetic: false, ...enabled },
      lists: [],
      allowlist: [],
      perSite: {},
      cosmeticAggressive: false,
      cookieRules: {},
      ...extensions,
    },
  };
}

export async function applyBlocker(app, opts) {
  await app.gnome((p) => window.gnomeTest.applySettings(p), blockerSettings(opts));
}

/** FilterListRefs for list ids of the server's listing (plus `ubo-resources` when it is there). */
export function refsFor(listing, ids) {
  const all = [...(listing?.lists ?? []), ...(listing?.resources ? [listing.resources] : [])];
  const refs = [];
  for (const l of all) {
    if (!(ids.includes(l.id) || l.id === 'ubo-resources') || !l.available || !l.sha256) continue;
    refs.push({ id: l.id, sha256: l.sha256, category: l.category, format: l.format, trusted: !!l.trusted });
  }
  return refs.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Waits for status.blocker to be `ready` with at least `lists` lists; returns the last status. */
export async function waitBlockerReady(app, { lists = 1, timeout = 90000 } = {}) {
  const t0 = Date.now();
  let st = null;
  for (;;) {
    try {
      st = await app.status();
    } catch {
      st = null;
    }
    const b = st?.blocker;
    if (b && b.state === 'ready' && b.lists >= lists) return { ok: true, blocker: b };
    if (Date.now() - t0 > timeout) return { ok: false, blocker: b ?? null };
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The shared start of x3's suites: the fixture server of the runner, a browser, the driver page over the VPN profile
 * route, and whether the engine host offers `blocker`. Returns null (after recording `setupRow`) when a row cannot run.
 */
export async function startBlockerSuite(ctx, setupRow) {
  const fx = ctx.stack?.blocker?.fixtures;
  if (!fx) {
    ctx.record({ test: setupRow, result: 'fail', notes: 'the runner started no content-blocker fixture server (ctx.stack.blocker, lane x5)' });
    return null;
  }
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  const app = await ctx.openApp(context, { route: 'profile:e2e-vpn', fallback: '0' });
  const caps = app.init?.capabilities ?? [];
  const offered = caps.includes('blocker');
  ctx.record({ test: setupRow, result: offered ? 'pass' : 'fail', notes: `capabilities ${JSON.stringify(caps)}${offered ? '' : ' (no `blocker`: build without GNOME_ENGINE_TEST_CAPABILITIES=blocker?)'}` });
  const close = async () => {
    await app.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  if (!offered) {
    await close();
    return null;
  }
  return { fx, app, browser, context, close };
}

/** Polls the fixture server's request log until `pred` holds for the matching requests (or `ms` passes). */
export async function requestsUntil(fx, filter, pred = (rs) => rs.length > 0, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const rs = fx.requests(filter);
    if (pred(rs) || Date.now() - t0 > ms) return rs;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** #out of the tab's document as JSON (read through the engine host's frame), waiting until it is not `pending`. */
export async function readOut(app, tabId, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const t = await tabText(app.page, tabId, '#out', { timeout: 5000 }).catch(() => null);
    if (t && t !== 'pending' && t !== 'ready') {
      try {
        return JSON.parse(t);
      } catch {
        /* still writing */
      }
    }
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Evaluates `fn(arg)` in the tab's document once it has `window[ready]`. */
export async function inTab(app, tabId, fn, arg, { ready = 'probe', ms = 15000 } = {}) {
  const f = await app.waitTabFrame(tabId, async (fr) => (await fr.evaluate((k) => typeof window[k] === 'function', ready)) === true, ms);
  if (!f) throw new Error(`tab ${tabId}: window.${ready} never appeared`);
  return inFrame(f, fn, arg, ms);
}

/** Clicks `selector` in the tab with a real mouse click and waits for the next tab.loaded/tab.error whose URL matches. */
export async function clickAndWait(app, tabId, selector, urlRe, timeout = 30000) {
  const f = await app.waitTabFrame(tabId, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 15000);
  if (!f) return { ok: false, error: 'frame not ready' };
  const since = await app.mark();
  await realClick(app, f, selector);
  const end = await app.waitFor(since, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === tabId && (e.type === 'tab.error' || urlRe.test(e.p.url ?? '')), timeout);
  const events = (await app.eventsSince(since)).filter((e) => e.p?.tabId === tabId);
  return { ok: end?.type === 'tab.loaded', end, events, committed: events.filter((e) => e.type === 'tab.committed').pop()?.p ?? null };
}

const header = (r, name) => (r ? (Array.isArray(r.headers[name]) ? r.headers[name].join(', ') : r.headers[name] ?? null) : undefined);

export async function run(ctx) {
  const s = await startBlockerSuite(ctx, 'privacy:setup (blocker offered, fixtures)');
  if (!s) return;
  const { fx, app, close } = s;
  const A = fx.origin('site-a');
  const B = fx.origin('site-b');
  let tab = 1;
  const open = async (url, engine) => {
    const id = tab++;
    const r = await app.navigate(id, url, { engine, create: true, timeout: 45000 });
    return { id, r };
  };
  const shut = (id) => app.cmd('tab.close', { tabId: id }).catch(() => {});
  // --parts P1,K3,…: only those rows (their ids are the first word of the row name).
  const runRow = (name, fn, opts) => (!ctx.parts || ctx.parts.includes(name.split(' ')[0]) ? perEngine(ctx, name, fn, opts) : Promise.resolve());
  try {
    // ── P1 / P2: GPC and DNT ───────────────────────────────────────────────────────────────────────────────────
    for (const [row, what] of [
      ['P1 Sec-GPC + navigator.globalPrivacyControl (none with privacy protection off)', 'gpc'],
      ['P2 DNT + navigator.doNotTrack', 'dnt'],
    ]) {
      await runRow(row, async (engine) => {
        const notes = [];
        const once = async (privacyOn) => {
          await applyBlocker(app, { enabled: { privacy: privacyOn }, privacy: { sendGpc: true, doNotTrack: true } });
          const id = `${what}-${engine}-${privacyOn ? 'on' : 'off'}`;
          const since = Date.now();
          const { id: t, r } = await open(`${A}/privacy/probe.html?img=${enc(`${B}/beacon?id=${id}`)}`, engine);
          if (!r.ok) return { ok: false, why: `load failed: ${JSON.stringify(r.error)}` };
          const doc = (await requestsUntil(fx, { since, label: 'site-a', path: '/privacy/probe.html' })).pop();
          const img = (await requestsUntil(fx, { since, label: 'site-b', path: '/beacon' })).pop();
          const page = await inTab(app, t, () => window.probe());
          await shut(t);
          const h = what === 'gpc' ? 'sec-gpc' : 'dnt';
          const seen = { doc: header(doc, h), img: header(img, h), page: what === 'gpc' ? page?.gpc : page?.dnt };
          notes.push(`${privacyOn ? 'on' : 'off'}: ${JSON.stringify(seen)}`);
          const want = what === 'gpc' ? true : '1';
          return privacyOn ? { ok: seen.doc === '1' && seen.img === '1' && seen.page === want } : { ok: seen.doc == null && seen.img == null && seen.page !== want };
        };
        const on = await once(true);
        const off = await once(false);
        return { result: on.ok && off.ok ? 'pass' : 'fail', notes: [on.why, off.why, ...notes].filter(Boolean).join('; ') };
      });
    }

    // ── P3–P6: the Referer floor and the modes ────────────────────────────────────────────────────────────────
    const refererOf = async (engine, mode, privacyOn, pageUrl, imgLabel, id) => {
      await applyBlocker(app, { enabled: { privacy: privacyOn }, privacy: { referrer: mode } });
      const since = Date.now();
      const { id: t, r } = await open(pageUrl, engine);
      if (!r.ok) return { error: `load failed: ${JSON.stringify(r.error)}` };
      const img = (await requestsUntil(fx, { since, label: imgLabel, path: '/beacon' }, (rs) => rs.some((x) => x.search.includes(id)))).filter((x) => x.search.includes(id)).pop();
      await shut(t);
      return { referer: img ? header(img, 'referer') : undefined, seen: !!img };
    };
    const secretPage = (img) => `${A}/privacy/probe.html?secret=s3cr3t&img=${enc(img)}`;
    await runRow('P3 the Referer floor (`default`, and privacy protection off): only the origin to another origin', async (engine) => {
      const a = await refererOf(engine, 'default', true, secretPage(`${B}/beacon?id=p3a-${engine}`), 'site-b', `p3a-${engine}`);
      const b = await refererOf(engine, 'none', false, secretPage(`${B}/beacon?id=p3b-${engine}`), 'site-b', `p3b-${engine}`);
      const want = `${A}/`;
      const ok = a.seen && a.referer === want && b.seen && b.referer === want;
      return { result: ok ? 'pass' : 'fail', notes: `default: ${JSON.stringify(a)}; privacy off (mode none ignored): ${JSON.stringify(b)}; want ${want}; https → http: not testable with the http fixtures (unit tests: reduceReferrer)` };
    });

    await runRow('P3b the floor from https to http: no Referer (a real https page loads an http fixture image)', async (engine) => {
      if (ctx.offline) return { result: 'skip', notes: '--offline: needs a real https page' };
      await applyBlocker(app, { enabled: { privacy: false }, privacy: { referrer: 'default' } });
      const id = `p3d-${engine}`;
      const since = Date.now();
      const { id: t, r } = await open('https://example.com/?gnome-e2e=1', engine);
      if (!r.ok) return { result: 'fail', notes: `https://example.com did not load over the VPN route: ${JSON.stringify(r.error)}` };
      const f = await app.waitTabFrame(t, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 20000);
      // The image is added through the page's own (engine-hooked) DOM, as a page script would.
      if (f) await inFrame(f, (u) => { const i = document.createElement('img'); i.src = u; document.body.appendChild(i); return true; }, `${B}/beacon?id=${id}`);
      const img = (await requestsUntil(fx, { since, label: 'site-b', path: '/beacon' }, (rs) => rs.some((x) => x.search.includes(id)))).filter((x) => x.search.includes(id)).pop();
      await shut(t);
      return { result: img && header(img, 'referer') == null ? 'pass' : 'fail', notes: `image ${img ? 'requested' : 'not requested'}, Referer ${JSON.stringify(img ? header(img, 'referer') : undefined)}` };
    });

    await runRow('P4 `origin-cross-site`: cross-site Referer and document.referrer are the origin, same-origin the full URL', async (engine) => {
      const cross = await refererOf(engine, 'origin-cross-site', true, secretPage(`${B}/beacon?id=p4a-${engine}`), 'site-b', `p4a-${engine}`);
      const sameUrl = secretPage(`${A}/beacon?id=p4b-${engine}`);
      const same = await refererOf(engine, 'origin-cross-site', true, sameUrl, 'site-a', `p4b-${engine}`);
      // document.referrer after a link from a site-a page with a query to site-b, and to site-a.
      const docRef = async (target) => {
        const from = `${A}/privacy/probe.html?secret=s3cr3t&to=${enc(target)}`;
        const { id: t, r } = await open(from, engine);
        if (!r.ok) return { error: 'load failed' };
        const c = await clickAndWait(app, t, '#link', /probe\.html\?dest=/);
        const p = c.ok ? await inTab(app, t, () => window.probe()) : null;
        await shut(t);
        return { from, referrer: p?.referrer, viaDescriptor: p?.referrerViaDescriptor, uvReferrer: p?.uvReferrer };
      };
      const toB = await docRef(`${B}/privacy/probe.html?dest=b`);
      const toA = await docRef(`${A}/privacy/probe.html?dest=a`);
      const checks = {
        crossHeader: cross.referer === `${A}/`,
        sameHeader: same.referer === sameUrl,
        crossDoc: toB.referrer === `${A}/` && toB.viaDescriptor === `${A}/`,
        sameDoc: toA.referrer === toA.from && toA.viaDescriptor === toA.from,
        // Ultraviolet's injected page global with the browser's (proxied, unreduced) referrer is empty (Scramjet: none).
        uvGlobal: [toB, toA].every((x) => (engine === 'ultraviolet' ? x.uvReferrer === '' : x.uvReferrer === null)),
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      const notes = `${failed.length ? `failed ${failed.join(', ')}; ` : ''}cross ${JSON.stringify(cross)}; same ${JSON.stringify(same)}; link→site-b ${JSON.stringify(toB)}; link→site-a ${JSON.stringify(toA)}`;
      // Measured 2026-11-19: Scramjet 2.0.67-alpha.2 in Firefox reports document.referrer '' after a link (its own
      // history-based getter), less than the floor allows. GNOME only ever reduces the value, so it cannot restore it.
      const engineReportsNone = engine === 'scramjet' && ctx.browser === 'firefox' && toA.referrer === '' && toB.referrer === '' && toA.viaDescriptor === '' && toB.viaDescriptor === '';
      if (failed.length && engineReportsNone && failed.every((k) => k === 'crossDoc' || k === 'sameDoc')) {
        return { result: 'fail', expectFail: true, notes: `known engine limit (Scramjet in Firefox reports no document.referrer; GNOME never adds one): ${notes}` };
      }
      return { result: failed.length ? 'fail' : 'pass', notes };
    });

    await runRow('P5 `none`: no Referer, document.referrer === ""', async (engine) => {
      const cross = await refererOf(engine, 'none', true, secretPage(`${B}/beacon?id=p5a-${engine}`), 'site-b', `p5a-${engine}`);
      const same = await refererOf(engine, 'none', true, secretPage(`${A}/beacon?id=p5b-${engine}`), 'site-a', `p5b-${engine}`);
      await applyBlocker(app, { privacy: { referrer: 'none' } });
      const { id: t, r } = await open(`${A}/privacy/probe.html?secret=1&to=${enc(`${B}/privacy/probe.html?dest=b`)}`, engine);
      const c = r.ok ? await clickAndWait(app, t, '#link', /dest=b/) : { ok: false };
      const p = c.ok ? await inTab(app, t, () => window.probe()) : null;
      await shut(t);
      const uvGlobal = engine === 'ultraviolet' ? p?.uvReferrer === '' : p?.uvReferrer === null;
      const ok = cross.seen && cross.referer == null && same.seen && same.referer == null && p?.referrer === '' && p?.referrerViaDescriptor === '' && uvGlobal;
      return { result: ok ? 'pass' : 'fail', notes: `cross ${JSON.stringify(cross)}; same ${JSON.stringify(same)}; document.referrer ${JSON.stringify(p?.referrer)} / descriptor ${JSON.stringify(p?.referrerViaDescriptor)} / UV page global ${JSON.stringify(p?.uvReferrer)}` };
    });

    await runRow('P6 never widened: a page with Referrer-Policy: no-referrer sends none (its images, its frame, a link it has)', async (engine) => {
      const id = `p6-${engine}`;
      const page = `${A}/policy?referrer=no-referrer&img=${enc(`${B}/beacon?id=${id}`)}`;
      const a = await refererOf(engine, 'default', true, page, 'site-b', id);
      const id2 = `p6s-${engine}`;
      const b = await refererOf(engine, 'origin-cross-site', true, `${A}/policy?referrer=no-referrer&img=${enc(`${A}/beacon?id=${id2}`)}`, 'site-a', id2);
      // The page's navigations too (a browser applies the document's policy to them): its frame, and a link a user
      // clicks, cross-site (both engines serve the document under their own policy, so the page's is GNOME's to apply).
      await applyBlocker(app, { privacy: { referrer: 'default' } });
      const since = Date.now();
      const frameUrl = `${B}/echo?format=html&via=p6frame-${engine}`;
      const linkUrl = `${B}/policy?referrer=unsafe-url&via=p6link-${engine}`;
      const { id: t, r } = await open(`${A}/policy?referrer=no-referrer&frame=${enc(frameUrl)}&to=${enc(linkUrl)}`, engine);
      let frame = null;
      let link = null;
      let linkDoc = null;
      if (r.ok) {
        frame = (await requestsUntil(fx, { since, label: 'site-b', path: '/echo' }, (rs) => rs.some((x) => x.search.includes(`via=p6frame-${engine}`)))).filter((x) => x.search.includes(`via=p6frame-${engine}`)).pop() ?? null;
        const c = await clickAndWait(app, t, '#link', /via=p6link/);
        link = (await requestsUntil(fx, { since, label: 'site-b', path: '/policy' }, (rs) => rs.some((x) => x.search.includes(`via=p6link-${engine}`)))).filter((x) => x.search.includes(`via=p6link-${engine}`)).pop() ?? null;
        linkDoc = c.ok ? await readOut(app, t) : null;
      }
      await shut(t);
      const nav = { frame: frame ? header(frame, 'referer') : 'not requested', link: link ? header(link, 'referer') : 'not requested', linkDocumentReferrer: linkDoc?.referrer };
      const ok = a.seen && a.referer == null && b.seen && b.referer == null && !!frame && nav.frame == null && !!link && nav.link == null && linkDoc?.referrer === '';
      return { result: ok ? 'pass' : 'fail', notes: `cross-site image ${JSON.stringify(a)}; same-origin image ${JSON.stringify(b)}; navigations ${JSON.stringify(nav)}` };
    });

    // Measured beside P6: the same policy from <meta name="referrer"> (no header): parser-made image and frame, a
    // script-made image, a clicked link.
    await runRow('P6m (measured) a page whose <meta name="referrer" content="no-referrer"> sets its policy sends no Referer', async (engine) => {
      await applyBlocker(app, { privacy: { referrer: 'default' } });
      const since = Date.now();
      const scriptImg = `${B}/beacon?id=p6meta-script-${engine}`;
      const { id: t, r } = await open(`${A}/privacy/meta-referrer.html?img=${enc(scriptImg)}`, engine);
      if (!r.ok) return { result: 'fail', notes: `load failed: ${JSON.stringify(r.error)}` };
      const pick = async (path, needle) => (await requestsUntil(fx, { since, label: 'site-b', path }, (rs) => rs.some((x) => x.search.includes(needle)))).filter((x) => x.search.includes(needle)).pop() ?? null;
      const parserImg = await pick('/beacon', 'p6meta-parser');
      const script = await pick('/beacon', `p6meta-script-${engine}`);
      const frame = await pick('/echo', 'p6meta-frame');
      const c = await clickAndWait(app, t, '#link', /via=p6meta-link/);
      const link = await pick('/policy', 'p6meta-link');
      await shut(t);
      const seen = (x) => (x ? header(x, 'referer') : 'not requested');
      const got = { parserImage: seen(parserImg), scriptImage: seen(script), frame: seen(frame), link: c.ok ? seen(link) : 'link failed' };
      const sent = Object.entries(got).filter(([, v]) => v !== null && v !== undefined);
      const notes = JSON.stringify(got);
      // Measured 2026-11-20: Scramjet 2.0.67-alpha.2 applies a <meta name="referrer"> policy only to the requests its
      // client makes (script-made elements, frames), not to the elements of the HTML it rewrote (an image the parser
      // made) and, in Chromium, not to a followed link; GNOME's hooks never see a page's HTML, so they cannot learn
      // that policy. The floor still holds there (the origin only, never the page's URL): anything more fails.
      if (sent.length && engine === 'scramjet' && sent.every(([k, v]) => (k === 'parserImage' || k === 'link') && v === `${A}/`)) {
        return { result: 'fail', expectFail: true, notes: `known engine limit (Scramjet ignores a <meta> referrer policy for its HTML's elements and links; the floor holds): ${notes}` };
      }
      return { result: sent.length ? 'fail' : 'pass', notes };
    });

    // ── P7–P11: tracking parameters ───────────────────────────────────────────────────────────────────────────
    const listing = await ctx.stack.blocker.listing();
    const refs = refsFor(listing, ['e2e-privacy']);
    const haveList = refs.some((r) => r.id === 'e2e-privacy');
    await applyBlocker(app, { extensions: { lists: refs } });
    const ready = haveList ? await waitBlockerReady(app, { lists: 1 }) : { ok: false, blocker: null };
    ctx.record({ test: 'privacy:lists (the e2e-privacy test list compiled)', result: haveList && ready.ok ? 'pass' : 'fail', notes: `refs ${JSON.stringify(refs.map((r) => r.id))}; blocker ${JSON.stringify(ready.blocker)}` });

    await runRow('P7 a link with utm_source, fbclid, gnome_e2e and id lands on ?id=1, history is clean, urlparams counted', async (engine) => {
      await applyBlocker(app, { extensions: { lists: refs } });
      const tracked = `${A}/privacy/probe.html?utm_source=x&fbclid=y&gnome_e2e=z&id=1`;
      const since = Date.now();
      const { id: t, r } = await open(`${B}/privacy/probe.html?to=${enc(tracked)}`, engine);
      if (!r.ok) return { result: 'fail', notes: `site-b did not load: ${JSON.stringify(r.error)}` };
      const c = await clickAndWait(app, t, '#link', /site-a\.localhost.*probe\.html/);
      const blocked = c.events.filter((e) => e.type === 'tab.blocked').map((e) => e.p);
      const urlparams = Math.max(0, ...blocked.map((b) => b.byCategory?.urlparams ?? 0));
      const seen = fx.requests({ since, label: 'site-a', path: '/privacy/probe.html' }).map((x) => x.search);
      const state = await app.cmd('tab.state', { tabId: t }).catch(() => null);
      await shut(t);
      const want = `${A}/privacy/probe.html?id=1`;
      // The tab's history: its site-a entries are exactly the clean URL (the site-b entry carries the link target in
      // its own query, so only site-a's entries count).
      const siteA = (state?.entries ?? []).filter((u) => u.startsWith(`${A}/`));
      const history = siteA.length > 0 && siteA.every((u) => u === want) && state?.entries?.[state.index] === want;
      const ok = c.ok && c.committed?.url === want && seen.length > 0 && seen.every((q) => q === '?id=1') && urlparams >= 1 && history;
      return { result: ok ? 'pass' : 'fail', notes: `committed ${c.committed?.url}; server saw ${JSON.stringify(seen)}; urlparams ${urlparams}; history site-a entries ${JSON.stringify(siteA)} (index ${state?.index})` };
    });

    await runRow('P8 a POST form keeps its URL; a frame document is stripped', async (engine) => {
      await applyBlocker(app, { extensions: { lists: refs } });
      const since = Date.now();
      const { id: t, r } = await open(`${A}/privacy/form.html`, engine);
      if (!r.ok) return { result: 'fail', notes: `load failed: ${JSON.stringify(r.error)}` };
      const frame = (await requestsUntil(fx, { since, label: 'site-b', path: '/echo' })).map((x) => x.search);
      const c = await clickAndWait(app, t, '#go', /\/echo/);
      const posts = (await requestsUntil(fx, { since, label: 'site-a', path: '/echo', method: 'POST' })).map((x) => x.search);
      await shut(t);
      const ok = frame.length > 0 && frame.every((q) => q === '?format=html&id=8') && posts.length === 1 && posts[0] === '?format=html&utm_source=post&id=8' && c.ok;
      return { result: ok ? 'pass' : 'fail', notes: `frame requests ${JSON.stringify(frame)}; POST ${JSON.stringify(posts)}; post loaded ${c.ok}` };
    });

    await runRow('P9 an allowlisted site keeps its parameters and still gets GPC', async (engine) => {
      await applyBlocker(app, { extensions: { lists: refs, allowlist: ['*.site-a.localhost'] } });
      const since = Date.now();
      const { id: t, r } = await open(`${A}/privacy/probe.html?utm_source=x&id=9`, engine);
      const doc = (await requestsUntil(fx, { since, label: 'site-a', path: '/privacy/probe.html' })).pop();
      const page = r.ok ? await inTab(app, t, () => window.probe()) : null;
      await shut(t);
      const ok = r.ok && r.committed?.url === `${A}/privacy/probe.html?utm_source=x&id=9` && doc?.search === '?utm_source=x&id=9' && header(doc, 'sec-gpc') === '1' && page?.gpc === true;
      return { result: ok ? 'pass' : 'fail', notes: `committed ${r.committed?.url}; server ${doc?.search} sec-gpc ${header(doc, 'sec-gpc')}; page gpc ${page?.gpc}` };
    });

    await runRow('P10 a page that sends the browser back to its tracked URL: at most 3 strips, no loop', async (engine) => {
      await applyBlocker(app, { extensions: { lists: refs } });
      const since = Date.now();
      const id = tab++;
      await app.createTab(id, { engine, url: `${A}/privacy/loop.html` });
      const out = await readOut(app, id, 40000);
      const seen = fx.requests({ since, label: 'site-a', path: '/privacy/loop.html' }).map((x) => x.search);
      await shut(id);
      const strips = out ? out.rounds - 1 : null;
      const ok = !!out && /utm_source=loop/.test(out.url) && strips !== null && strips <= 3 && strips >= 1;
      return { result: ok ? 'pass' : 'fail', notes: `final ${out?.url}; page rounds ${out?.rounds} → strips ${strips}; server saw ${JSON.stringify(seen)}` };
    });

    await runRow('P11 a link from site-b to allowlisted site-a/?utm_source=x keeps its parameter (D3)', async (engine) => {
      await applyBlocker(app, { extensions: { lists: refs, allowlist: ['*.site-a.localhost'] } });
      const target = `${A}/privacy/probe.html?utm_source=x&id=11`;
      const { id: t, r } = await open(`${B}/privacy/probe.html?to=${enc(target)}`, engine);
      if (!r.ok) return { result: 'fail', notes: `site-b did not load: ${JSON.stringify(r.error)}` };
      const c = await clickAndWait(app, t, '#link', /site-a\.localhost/);
      await shut(t);
      return { result: c.ok && c.committed?.url === target ? 'pass' : 'fail', notes: `committed ${c.committed?.url}` };
    });

    await runRow('P12 a dedicated worker’s request carries Sec-GPC (no navigator.globalPrivacyControl in the worker)', async (engine) => {
      await applyBlocker(app, { privacy: { sendGpc: true } });
      const { id: t, r } = await open(`${A}/privacy/probe.html`, engine);
      if (!r.ok) return { result: 'fail', notes: `load failed: ${JSON.stringify(r.error)}` };
      const w = await inTab(app, t, (u) => window.workerEcho(u), `${A}/echo?from=worker`, { ms: 20000 });
      await shut(t);
      const gpc = w?.echo?.headers?.['sec-gpc'];
      const notes = `worker: ${JSON.stringify({ gpcHeader: gpc, workerNavigatorGpc: w?.gpc, error: w?.error })}`;
      // README Known limitations: in Firefox, Scramjet's workers time out and Ultraviolet's workers error.
      if (!w?.echo && ctx.browser === 'firefox') return { result: 'fail', expectFail: true, notes: `known engine limit (workers do not run in Firefox under ${engine}): ${notes}` };
      return { result: gpc === '1' ? 'pass' : 'fail', notes };
    });
  } finally {
    await close();
  }
}
