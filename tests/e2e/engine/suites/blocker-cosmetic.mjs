// Lane x2: cosmetic filtering and scriptlets on the real stack (docs/WAVE-B3.md §5, §12.2 rows CS1–CS18), both
// engines in each browser. The rules are the lane's test lists (fixtures/blocker/lists/cosmetic.txt, untrusted, and
// cosmetic-trusted.txt, trusted), which the runner's gnome-server serves as file lists (lane x5); the pages are
// fixtures/blocker/cosmetic/<label>/*, reached through the VPN profile route (the allow-loopback HolyWisp).
//
// The suite sends every filter list the server offers (ids and hashes from /api/filters, as the app's filterListRefs
// does) with the ad blocker and cosmetic filtering on, waits until status.blocker is `ready`, then loads each fixture in
// a fresh tab and reads what the page saw (`#out`) and the computed styles. Rows (each per engine):
//   CS1  site-specific hiding                    CS10 a site-b frame inside site-a gets site-b's rules
//   CS2  generic hiding only with cosmeticAggressive   CS11 set-constant before the page's scripts; virtual location
//   CS3  a class/id/node added after load (monitor)    CS12 abort-on-property-read, json-prune on fetched JSON
//   CS4  :style()                                 CS13 trust: trusted-set-cookie/rpnt only from the trusted list
//   CS5  unsafe :style() dropped (url(, URL(, ABP), and selectors that open a block of their own
//                                                      CS14 root/body/::highlight( rules dropped, find still highlights
//   CS6  ABP {style} converted                    CS15 the §11.4 argument vectors run no code; values arrive as data
//   CS7  an invalid selector does not disable its rule  CS16 set-cookie/set-local-storage-item land in the engine's jar
//   CS8  #@#, $generichide, $elemhide             CS17 nowoif stops a click-triggered popunder (another popup passes)
//   CS9  per-site cosmetic off; allowlisted site   CS18 R1 rule 2: a page's recording Proxies receive nothing foreign
//   cs-href (measured, not a plan row): a hiding rule that selects links by their address.
//   cs-late (lane review, not a plan row): a document that opened before the engines were ready (a fresh context whose
//        build is held) gets its styles and generic rules when they are, not its scriptlets; and everything the late
//        steps hand the page (the observer's options as the browser reads them, natives) is of the page's realm.
//   A2   (plan row of §12.2 "Attacks", left to this lane by lane x1): a page that removes GNOME's stylesheet un-hides
//        only its own content.
// Parts (--parts): rows by name (cs1 … cs18, cs-href, cs-late, a2).
import fs from 'node:fs';
import { CosmeticFilter } from '../../../../frontend/node_modules/@ghostery/adblocker/dist/esm/index.js';
import { inFrame, realClick } from './host-lib.mjs';

const ENGINES = ['scramjet', 'ultraviolet'];
const READY_MS = 90_000;

/** The list refs the app would send (filterListRefs): every list the server offers, by id and hash. */
async function listRefs(app) {
  const listing = await app.gnome(async () => (await fetch('/api/filters', { headers: { 'Cache-Control': 'no-cache' } })).json());
  const all = [...(listing.lists ?? []), ...(listing.resources ? [listing.resources] : [])];
  return all.filter((l) => l.available !== false && l.id !== 'big').map((l) => ({ id: l.id, sha256: l.sha256, category: l.category, format: l.format, trusted: l.trusted === true }));
}

/** A full settings snapshot: the driver's current one with these extension (and, when given, privacy) changes. */
async function configure(app, ext = {}, privacy = null) {
  const cur = await app.gnome(() => window.gnomeTest.settings);
  const extensions = {
    ...cur.extensions,
    enabled: { adblock: true, trackers: false, privacy: false, cookies: false, cosmetic: true },
    lists: app.refs,
    allowlist: [],
    perSite: {},
    cosmeticAggressive: false,
    cookieRules: {},
    ...ext,
  };
  await app.gnome((s) => window.gnomeTest.applySettings(s), privacy ? { extensions, privacy: { ...cur.privacy, ...privacy } } : { extensions });
}

async function waitReady(app, ms = READY_MS) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = (await app.status()).blocker;
    if (last.state === 'ready' || last.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ...last, ms: Date.now() - t0 };
}

let nextTab = 100;

/** Loads `url` in a new tab of `engine`, waits for its #out; returns {tabId, frame, out, r} (frame null on failure). */
async function load(app, engine, url, { outTimeout = 15_000 } = {}) {
  const tabId = nextTab++;
  const r = await app.navigate(tabId, url, { engine, create: true, timeout: 45_000 });
  if (!r.ok) return { tabId, frame: null, out: null, r, why: `did not load: ${JSON.stringify(r.error).slice(0, 200)}` };
  const frame = await app.waitTabFrame(tabId, async (f) => ((await f.evaluate(() => document.getElementById('out')?.textContent ?? '')) || '').length > 0, outTimeout);
  if (!frame) return { tabId, frame: null, out: null, r, why: '#out never filled' };
  const text = await inFrame(frame, () => document.getElementById('out').textContent);
  let out = null;
  try {
    out = JSON.parse(text);
  } catch {
    out = { raw: text };
  }
  return { tabId, frame, out, r, engine: r.engine };
}

async function closeTab(app, tabId) {
  await app.cmd('tab.close', { tabId }).catch(() => {});
}

/** Computed styles of selectors in a frame: {sel: {display, color, opacity, bg} | null}. */
async function styles(frame, sels) {
  return inFrame(
    frame,
    (list) => {
      const o = {};
      for (const s of list) {
        const e = document.querySelector(s);
        if (!e) {
          o[s] = null;
          continue;
        }
        const c = getComputedStyle(e);
        o[s] = { display: c.display, color: c.color, opacity: c.opacity, bg: c.backgroundImage };
      }
      return o;
    },
    sels,
  );
}

/** The CSS text of every stylesheet GNOME could have put into the page (adopted sheets and style elements). */
async function sheetText(frame) {
  return inFrame(frame, () => {
    const parts = [];
    for (const s of document.adoptedStyleSheets ?? []) for (const r of s.cssRules) parts.push(r.cssText);
    for (const st of document.querySelectorAll('style')) parts.push(st.textContent);
    return parts.join('\n');
  });
}

const hidden = (s) => s !== null && s !== undefined && s.display === 'none';
const shown = (s) => s !== null && s !== undefined && s.display !== 'none';

export async function run(ctx) {
  const want = (name) => !ctx.parts || ctx.parts.includes(name);
  const bl = ctx.stack.blocker;
  if (!bl) {
    ctx.record({ test: 'cs:setup', result: 'fail', notes: 'the runner has no content-blocker fixtures (ctx.stack.blocker)' });
    return;
  }
  const url = (label, path) => bl.url(label, `/cosmetic/${path}`);
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const app = await ctx.openApp(context, { route: `profile:${ctx.stack.profiles.live}`, fallback: '0' });
    const caps = app.init?.capabilities ?? [];
    if (!caps.includes('blocker')) {
      ctx.record({ test: 'cs:setup', result: 'fail', notes: `the engine host does not offer 'blocker' (capabilities ${caps.join(',')}): build without GNOME_ENGINE_TEST_CAPABILITIES=blocker?` });
      return;
    }
    app.refs = await listRefs(app);
    const ids = app.refs.map((r) => r.id);
    if (!ids.includes('e2e-cosmetic') || !ids.includes('e2e-cosmetic-trusted')) {
      ctx.record({ test: 'cs:setup', result: 'fail', notes: `the server does not list the cosmetic test lists (lists: ${ids.join(', ')})` });
      return;
    }
    await configure(app);
    const ready = await waitReady(app);
    ctx.record({ test: 'cs:setup', result: ready.state === 'ready' ? 'pass' : 'fail', notes: `status.blocker ${JSON.stringify(ready)}; lists ${ids.join(', ')}` });
    if (ready.state !== 'ready') return;

    const row = async (name, test, fn) => {
      if (!want(name)) return;
      for (const engine of ENGINES) {
        try {
          const r = await fn(engine);
          ctx.record({ test, engine, result: r.result, notes: String(r.notes ?? '').slice(0, 1500), ...(r.expectFail ? { expectFail: true } : {}), ...(r.data ? { data: r.data } : {}) });
        } catch (e) {
          ctx.record({ test, engine, result: 'fail', notes: `threw: ${String(e?.stack ?? e).slice(0, 600)}` });
        }
      }
    };
    const pageRow = (name, test, label, path, check, opts) =>
      row(name, test, async (engine) => {
        const p = await load(app, engine, url(label, path), opts);
        try {
          if (!p.frame) return { result: 'fail', notes: p.why };
          if (p.engine !== engine) return { result: 'fail', notes: `loaded in ${p.engine}, not ${engine}` };
          return await check(p, engine);
        } finally {
          await closeTab(app, p.tabId);
        }
      });

    // ── CS1, CS4–CS7: site-specific rules ──────────────────────────────────────────────────────────────────────
    await pageRow('cs1', 'CS1 site-specific hiding', 'site-a', 'cs1.html', async (p) => {
      const s = await styles(p.frame, ['.gnome-cs1-ad', '.gnome-cs1-keep']);
      const ok = hidden(s['.gnome-cs1-ad']) && shown(s['.gnome-cs1-keep']);
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(s) };
    });

    await pageRow('cs4', 'CS4 :style() applied', 'site-a', 'cs4.html', async (p) => {
      const s = await styles(p.frame, ['.gnome-cs4', '.gnome-cs6']);
      const ok = s['.gnome-cs4']?.color === 'rgb(1, 2, 3)' && s['.gnome-cs6']?.opacity === '0.5';
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(s) };
    });

    await pageRow('cs5', 'CS5 unsafe :style() dropped (url(, URL(, ABP {style} with url)', 'site-a', 'cs4.html', async (p) => {
      const s = await styles(p.frame, ['.gnome-cs5a', '.gnome-cs5b', '.gnome-cs5c']);
      const css = await sheetText(p.frame);
      const beacons = bl.fixtures.beacons ? ['cs5a', 'cs5b', 'cs5c'].map((id) => bl.fixtures.beacons({ label: 'cdn', id })) : [];
      const noImage = ['.gnome-cs5a', '.gnome-cs5b', '.gnome-cs5c'].every((k) => s[k] && s[k].bg === 'none' && s[k].display !== 'none');
      const ok = noImage && !/beacon/i.test(css);
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; GNOME sheets name the URL: ${/beacon/i.test(css)}; cdn beacon hits ${JSON.stringify(beacons)}` };
    });

    await pageRow('cs5', 'CS5 a selector that opens a block of its own ({ in a hiding or a :style() rule) is dropped', 'cdn', 'cs5.html', async (p) => {
      // Lane review: the library pastes selectors into its stylesheet text unchanged, so `.x{background-image:url(…);a:b`
      // would give the page the list's own declarations (and break the other rules of its block): the control shares
      // that stylesheet.
      const s = await styles(p.frame, ['.gnome-cs5d', '.gnome-cs5e', '.gnome-cs5-ctl']);
      const css = await sheetText(p.frame);
      const named = /gnome-cs5[de]/.test(css);
      const ok = s['.gnome-cs5d']?.bg === 'none' && shown(s['.gnome-cs5d']) && s['.gnome-cs5e']?.color !== 'rgb(9, 8, 7)' && s['.gnome-cs5e']?.opacity === '1' && hidden(s['.gnome-cs5-ctl']) && !named;
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; GNOME sheets name the dropped rules: ${named}` };
    });

    await pageRow('cs6', 'CS6 ABP {style} rule converted and applied', 'site-a', 'cs4.html', async (p) => {
      const s = await styles(p.frame, ['.gnome-cs6']);
      return { result: s['.gnome-cs6']?.opacity === '0.5' && shown(s['.gnome-cs6']) ? 'pass' : 'fail', notes: JSON.stringify(s) };
    });

    await pageRow('cs7', 'CS7 an invalid selector beside valid ones: the valid ones still hide', 'site-a', 'cs4.html', async (p) => {
      const s = await styles(p.frame, ['.gnome-cs7-a', '.gnome-cs7-b', '.gnome-cs7-keep']);
      const css = await sheetText(p.frame);
      const atRule = /@page/i.test(css);
      const ok = hidden(s['.gnome-cs7-a']) && hidden(s['.gnome-cs7-b']) && shown(s['.gnome-cs7-keep']) && !css.includes('2n+)') && !atRule;
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; invalid selector in a sheet: ${css.includes('2n+)')}; @page in a sheet: ${atRule}` };
    });

    await pageRow('cs-href', 'cs-href (measured): a hiding rule that selects a link by its address', 'site-a', 'cs4.html', async (p) => {
      const s = await styles(p.frame, ['#cs-href']);
      const attr = await inFrame(p.frame, () => {
        const a = document.getElementById('cs-href');
        return { href: a.href, attribute: Element.prototype.getAttribute.call(a, 'href') };
      });
      return hidden(s['#cs-href'])
        ? { result: 'pass', notes: `hidden; ${JSON.stringify(attr)}` }
        : { result: 'fail', expectFail: true, notes: `not hidden: the engine rewrote the attribute the selector reads (${JSON.stringify(attr)}): a known limitation, stated in About` };
    });

    // ── A2 (§12.2 "Attacks", left to this lane by lane x1): a page removes GNOME's stylesheet ────────────────────
    await row('a2', "A2 a page that removes GNOME's stylesheet un-hides only its own content (another tab of the site keeps it)", async (engine) => {
      const b = await load(app, engine, url('site-a', 'cs1.html'));
      const a = await load(app, engine, url('site-a', 'cs1.html'));
      try {
        if (!a.frame || !b.frame) return { result: 'fail', notes: a.why ?? b.why };
        // Firefox computes no style for the document of a tab in the background (every value ''): read each tab shown.
        const read = async (p) => {
          await app.cmd('tab.activate', { tabId: p.tabId });
          await ctx.sleep(150);
          return styles(p.frame, ['.gnome-cs1-ad']);
        };
        const before = { a: await read(a), b: await read(b) };
        await app.cmd('tab.activate', { tabId: a.tabId });
        // The page's own code (main world of tab a): everything GNOME adopted into its document, gone.
        const removed = await inFrame(a.frame, () => {
          const n = (document.adoptedStyleSheets ?? []).length;
          document.adoptedStyleSheets = [];
          for (const st of document.querySelectorAll('style')) st.remove();
          return n;
        });
        await ctx.sleep(300);
        const after = { a: await read(a), b: await read(b) };
        const ok = hidden(before.a['.gnome-cs1-ad']) && hidden(before.b['.gnome-cs1-ad']) && removed > 0 && shown(after.a['.gnome-cs1-ad']) && hidden(after.b['.gnome-cs1-ad']);
        return { result: ok ? 'pass' : 'fail', notes: `before ${JSON.stringify(before)}; removed ${removed} adopted sheet(s); after ${JSON.stringify(after)}` };
      } finally {
        await closeTab(app, a.tabId);
        await closeTab(app, b.tabId);
      }
    });

    // ── CS10: frames ──────────────────────────────────────────────────────────────────────────────────────────
    await pageRow('cs10', "CS10 a site-b frame inside site-a gets site-b's rules", 'site-a', 'cs10.html', async (p) => {
      const top = await styles(p.frame, ['.gnome-cs10-a']);
      let child = null;
      for (let i = 0; i < 40 && !child; i++) {
        child = p.frame.childFrames().find((f) => /cs10-frame/.test(f.url())) ?? null;
        if (!child) {
          // Ultraviolet/Scramjet frame URLs are proxied: match by the frame's own document
          for (const f of p.frame.childFrames()) {
            const t = await inFrame(f, () => document.title, null, 3000).catch(() => null);
            if (t === 'cs10-frame') child = f;
          }
        }
        if (!child) await ctx.sleep(250);
      }
      if (!child) return { result: 'fail', notes: 'the site-b frame was not found' };
      const diag = await inFrame(child, () => {
        const d = Object.getOwnPropertyDescriptor(window, '__uvHook');
        return { adopted: (document.adoptedStyleSheets ?? []).length, styles: document.querySelectorAll('style').length, uvHook: d ? (d.get ? 'accessor' : 'data') : 'none', url: location.href };
      }, null, 3000).catch((e) => String(e));
      let s = null;
      for (let i = 0; i < 20; i++) {
        s = await styles(child, ['.gnome-cs10-b', '.gnome-cs10-a']).catch(() => null);
        if (s && s['.gnome-cs10-b']) break;
        await ctx.sleep(250);
      }
      const ok = hidden(top['.gnome-cs10-a']) && hidden(s?.['.gnome-cs10-b']) && shown(s?.['.gnome-cs10-a']);
      return { result: ok ? 'pass' : 'fail', notes: `top ${JSON.stringify(top)}; frame ${JSON.stringify(s)}; frame doc ${JSON.stringify(diag)}` };
    });

    // ── CS11, CS12: scriptlets ─────────────────────────────────────────────────────────────────────────────────
    await pageRow('cs11', "CS11 set-constant is in place before the page's first script", 'site-a', 'cs11.html', async (p) => {
      const ok = p.out?.seen === 42 && p.out?.afterWrite === 42;
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(p.out) };
    });

    await row('cs11', "CS11 the scriptlet sees the engine's virtual location (window-close-if matches the real URL)", async (engine) => {
      const tabId = nextTab++;
      const since = await app.mark();
      const r = await app.navigate(tabId, url('site-a', 'cs11-loc.html'), { engine, create: true, timeout: 45_000 });
      const closed = await app.waitFor(since, (e) => e.type === 'tab.closeRequest' && e.p.tabId === tabId, 8000);
      await closeTab(app, tabId);
      if (!r.ok) return { result: 'fail', notes: `did not load: ${JSON.stringify(r.error)}` };
      return { result: closed ? 'pass' : 'fail', notes: closed ? 'tab.closeRequest: the regex for the real URL matched location.href' : 'no tab.closeRequest within 8 s' };
    });

    await pageRow('cs12', 'CS12 abort-on-property-read and json-prune on a fetched JSON', 'site-a', 'cs12.html', async (p) => {
      const o = p.out ?? {};
      const ok = o.aborted === true && o.json && !('gnomeCs12Ad' in o.json) && o.json.content === 'kept' && o.parsed && !('gnomeCs12Ad' in o.parsed) && o.parsed.keep === 2;
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(o) };
    });

    // ── CS13, CS15: trust and arguments ─────────────────────────────────────────────────────────────────────────
    await pageRow('cs13', 'CS13 scriptlets that need trust run only from the trusted list', 'cdn', 'cs13.html', async (p) => {
      const o = p.out ?? {};
      const cookies = String(o.cookie ?? '');
      // prevent-clipboard-write arms itself at the first mousemove: move over the frame, then look for its wrapper.
      const box = await (await p.frame.waitForSelector('#t1')).boundingBox();
      if (box) await app.page.mouse.move(box.x + 5, box.y + 5);
      await ctx.sleep(300);
      const clip = await inFrame(p.frame, () => Object.prototype.hasOwnProperty.call(document, 'execCommand'));
      const checks = {
        trustedLs: typeof o.trustedLs === 'string' && /^\d{10,}$/.test(o.trustedLs),
        rpntTrusted: o.t3 === 'gnome-cs13-trusted-replaced',
        untrustedLs: o.untrustedLs !== null && o.untrustedLs !== undefined,
        untrustedCookie: cookies.includes('gnome_cs13_untrusted'),
        spacedName: cookies.includes('gnome_cs13_spaced'),
        rpntUntrusted: o.t1 !== 'gnome-cs13-original',
        replaceNodeTextUntrusted: o.t2 !== 'gnome-cs13-second',
        clipboardWrapper: clip,
      };
      const ok = checks.trustedLs && checks.rpntTrusted && !checks.untrustedLs && !checks.untrustedCookie && !checks.spacedName && !checks.rpntUntrusted && !checks.replaceNodeTextUntrusted && !checks.clipboardWrapper;
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(checks)}; page ${JSON.stringify(o)}` };
    });

    await pageRow('cs13', 'CS13 trusted-set-cookie from the trusted list sets its (Secure) cookie', 'cdn', 'cs13.html', async (p) => {
      const cookies = String(p.out?.cookie ?? '');
      const set = /(?:^|; )gnome_cs13_trusted=yes(?:;|$)/.test(cookies);
      if (set) return { result: 'pass', notes: cookies };
      // trusted-set-cookie always adds `; Secure` and the fixture site is http://cdn.localhost; it was stored in every
      // engine and browser on 2026-11-19 except once (Ultraviolet, Chromium, the first run), recorded as a failure.
      return { result: 'fail', notes: `not set (document.cookie ${JSON.stringify(cookies)}): the scriptlet adds Secure and the page is http` };
    });

    await pageRow('cs15', 'CS15 the argument vectors of §11.4 run no code; the values arrive as the parsed strings', 'site-b', 'cs15.html', async (p) => {
      const o = p.out ?? {};
      const expected = expectedVectors();
      const mismatches = Object.entries(expected).filter(([k, v]) => o[k] !== v);
      const ok = o.PWNED === null && mismatches.length === 0;
      return { result: ok ? 'pass' : 'fail', notes: `PWNED ${o.PWNED}; mismatches ${JSON.stringify(mismatches.map(([k, v]) => [k, v, o[k]]))}` };
    });

    await row('cs15', 'CS15 a regex argument ending in $ arrives unchanged (window-close-if)', async (engine) => {
      const tabId = nextTab++;
      const since = await app.mark();
      const r = await app.navigate(tabId, url('site-b', 'cs15-close.html'), { engine, create: true, timeout: 45_000 });
      const closed = await app.waitFor(since, (e) => e.type === 'tab.closeRequest' && e.p.tabId === tabId, 8000);
      await closeTab(app, tabId);
      if (!r.ok) return { result: 'fail', notes: `did not load: ${JSON.stringify(r.error)}` };
      return { result: closed ? 'pass' : 'fail', notes: closed ? 'tab.closeRequest' : 'no tab.closeRequest within 8 s' };
    });

    // ── CS14: GNOME's own UI and the root ──────────────────────────────────────────────────────────────────────
    await pageRow('cs14', 'CS14 ##body, ##*, :root, html and ::highlight( rules dropped: the body and find highlights stay', 'cdn', 'cs14.html', async (p) => {
      const s = await styles(p.frame, ['html', 'body', '#text', '.gnome-cs14-ok']);
      const found = await app.cmd('tab.find', { tabId: p.tabId, query: 'gnomefindme', backwards: false, caseSensitive: false });
      const page = await inFrame(p.frame, () => ({ has: typeof CSS !== 'undefined' && CSS.highlights ? CSS.highlights.has('gnome-find') || CSS.highlights.has('gnome-find-active') : null }));
      const css = await sheetText(p.frame);
      const leaked = /highlight|(^|[\s,])(body|html|\*|:root)\s*[,{]/i.test(css.replace(/::highlight\(gnome-find(-active)?\)\{background:#ff/g, ''));
      // find.ts adds GNOME's own ::highlight style; any other mention comes from a list
      const listHighlight = css.split('\n').some((l) => /highlight/i.test(l) && /transparent/i.test(l));
      const ok = shown(s.html) && shown(s.body) && shown(s['#text']) && hidden(s['.gnome-cs14-ok']) && found.matches === 2 && found.highlights === true && !listHighlight;
      await app.cmd('tab.findClear', { tabId: p.tabId }).catch(() => {});
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; find ${JSON.stringify(found)}; registry ${JSON.stringify(page)}; list ::highlight style: ${listHighlight}; root selector in sheets: ${leaked}` };
    });

    // ── CS16: the engine's virtual jar and storage ────────────────────────────────────────────────────────────
    await pageRow('cs16', "CS16 set-cookie and set-local-storage-item land in the engine's virtual jar and storage", 'cdn', 'cs16.html', async (p, engine) => {
      const o = p.out ?? {};
      const list = await app.cmd('cookies.list', { site: 'cdn.localhost' }).catch((e) => ({ error: String(e) }));
      const mine = (list.cookies ?? []).filter((c) => c.name === 'gnome_cs16');
      const host = ctx.stack.proxyOrigin;
      const ef = app.engineFrame();
      const realm = ef ? await inFrame(ef, () => ({ cookie: document.cookie, ls: (() => { try { return localStorage.getItem('gnome_cs16_ls'); } catch { return 'error'; } })() })) : null;
      const ok = /(?:^|; )gnome_cs16=yes(?:;|$)/.test(String(o.cookie)) && o.ls === 'yes' && mine.some((c) => c.engine === engine) && realm !== null && !realm.cookie.includes('gnome_cs16') && realm.ls === null;
      return { result: ok ? 'pass' : 'fail', notes: `page ${JSON.stringify(o)}; cookies.list ${JSON.stringify(mine)}; proxy origin (${host}) ${JSON.stringify(realm)}` };
    });

    // ── CS17: popunder ────────────────────────────────────────────────────────────────────────────────────────
    await pageRow('cs17', 'CS17 nowoif stops a click-triggered popunder; another popup still opens', 'site-a', 'cs17.html', async (p) => {
      await ctx.sleep(500);
      let since = await app.mark();
      await realClick(app, p.frame, '#popunder');
      await ctx.sleep(1500);
      const blocked = (await app.eventsSince(since)).filter((e) => e.type === 'tab.openRequest' && e.p.openerTabId === p.tabId);
      await ctx.sleep(1200); // one click opens one tab per second (step 2's rate limit)
      since = await app.mark();
      await realClick(app, p.frame, '#ok');
      const opened = await app.waitFor(since, (e) => e.type === 'tab.openRequest' && e.p.openerTabId === p.tabId, 5000);
      const ok = blocked.length === 0 && opened !== null && /cs17-ok/.test(opened.p.url);
      return { result: ok ? 'pass' : 'fail', notes: `popunder requests ${JSON.stringify(blocked.map((e) => e.p.url))}; allowed popup ${opened ? opened.p.url : 'none'}` };
    });

    // ── CS18: R1 rule 2 with cosmeticAggressive ────────────────────────────────────────────────────────────────
    if (want('cs18') || want('cs2') || want('cs3') || want('cs8')) {
      await configure(app, { cosmeticAggressive: true });
    }
    const cs18 = async (p) => {
      const o = p.out ?? {};
      // #gnome-cs18-parsed and #gnome-cs18-frag are parser-made nodes the page's own code never touched before GNOME's
      // monitor read them (rule 3: their wrappers must still be the page realm's; the page checks that in o.foreign).
      const s = await styles(p.frame, ['#gnome-cs18-id7', '#gnome-cs18-id3', '#gnome-cs18-id1', '#gnome-cs18-parsed', '#gnome-cs18-frag']);
      const ok = Array.isArray(o.foreign) && o.foreign.length === 0 && o.checked === 2 && (o.sheets ?? []).every((r) => r === 'page') && hidden(s['#gnome-cs18-id7']) && hidden(s['#gnome-cs18-id3']) && shown(s['#gnome-cs18-id1']) && hidden(s['#gnome-cs18-parsed']) && hidden(s['#gnome-cs18-frag']);
      return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(o)}; ${JSON.stringify(s)}` };
    };
    await pageRow('cs18', 'CS18 a page that replaced getAttribute, querySelectorAll, NodeList iteration and push receives nothing foreign', 'site-b', 'cs18.html', cs18, { outTimeout: 20_000 });
    if (want('cs18')) {
      // Lane review: the same page with privacy.webrtc 'allow', where Scramjet documents have no frame guard of lane
      // x1 (a page-realm observer created before GNOME's monitor; Ultraviolet documents keep theirs). Measured
      // 2026-11-20: a monitor built on an engine-host MutationObserver (mutation m2) passes both rows in both browsers,
      // because page-realm code reaches the parser's nodes first in this stack; the monitor's use of kit.observe (rule
      // 3) is pinned by cosmetic/provider.test.ts (6 tests fail with that mutation). These rows check rule 2 and the
      // sheets' realm in both configurations.
      const before = (await app.gnome(() => window.gnomeTest.settings)).privacy?.webrtc ?? 'block';
      await configure(app, { cosmeticAggressive: true }, { webrtc: 'allow' });
      await pageRow('cs18', "CS18 the same without lane x1's WebRTC frame guard (privacy.webrtc allow): GNOME's monitor is the first observer", 'site-b', 'cs18.html', cs18, { outTimeout: 20_000 });
      await configure(app, { cosmeticAggressive: true }, { webrtc: before });
    }

    // ── CS2, CS3, CS8: generic rules (cosmeticAggressive on) ──────────────────────────────────────────────────
    await pageRow('cs2', 'CS2 generic hiding with cosmeticAggressive on', 'site-a', 'cs2.html', async (p) => {
      let s = null;
      for (let i = 0; i < 12; i++) {
        s = await styles(p.frame, ['.gnome-cs2-generic', '.gnome-cs2-keep']);
        if (hidden(s['.gnome-cs2-generic'])) break;
        await ctx.sleep(250);
      }
      return { result: hidden(s['.gnome-cs2-generic']) && shown(s['.gnome-cs2-keep']) ? 'pass' : 'fail', notes: JSON.stringify(s) };
    });

    await pageRow('cs3', 'CS3 a class, an id and a node added after load are hidden (GNOME monitor)', 'site-a', 'cs3.html', async (p) => {
      let s = null;
      for (let i = 0; i < 16; i++) {
        s = await styles(p.frame, ['#late', '#gnome-cs3-id', '#added']);
        if (hidden(s['#late']) && hidden(s['#gnome-cs3-id']) && hidden(s['#added'])) break;
        await ctx.sleep(250);
      }
      const ok = hidden(s['#late']) && hidden(s['#gnome-cs3-id']) && hidden(s['#added']);
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(s) };
    });

    const cs8 = async (path, expect) => {
      await pageRow('cs8', `CS8 ${path}: ${JSON.stringify(expect)}`, 'site-b', path, async (p) => {
        let s = null;
        for (let i = 0; i < 8; i++) {
          s = await styles(p.frame, ['.gnome-cs8-ex', '.gnome-cs8-gen', '.gnome-cs8-site']);
          if (Object.entries(expect).every(([k, v]) => (v ? hidden(s[k]) : shown(s[k])))) break;
          await ctx.sleep(250);
        }
        const ok = Object.entries(expect).every(([k, v]) => (v ? hidden(s[k]) : shown(s[k])));
        return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(s) };
      });
    };
    if (want('cs8')) {
      await cs8('cs8.html', { '.gnome-cs8-ex': false, '.gnome-cs8-gen': true, '.gnome-cs8-site': true });
      await cs8('cs8-generichide.html', { '.gnome-cs8-ex': false, '.gnome-cs8-gen': false, '.gnome-cs8-site': true });
      await cs8('cs8-elemhide.html', { '.gnome-cs8-ex': false, '.gnome-cs8-gen': false, '.gnome-cs8-site': false });
    }

    // CS2's other half: generic rules need cosmeticAggressive
    if (want('cs2')) {
      await configure(app, { cosmeticAggressive: false });
      await pageRow('cs2', 'CS2 generic hiding stays off without cosmeticAggressive', 'site-a', 'cs2.html', async (p) => {
        await ctx.sleep(800);
        const s = await styles(p.frame, ['.gnome-cs2-generic']);
        return { result: shown(s['.gnome-cs2-generic']) ? 'pass' : 'fail', notes: JSON.stringify(s) };
      });
    }

    // ── CS9: per-site cosmetic off, allowlisted site ─────────────────────────────────────────────────────────
    if (want('cs9')) {
      await configure(app, { perSite: { 'site-a.localhost': { cosmetic: false } } });
      await pageRow('cs9', 'CS9 per-site cosmetic off: nothing hidden, scriptlets still run (they follow the ad blocker, D2)', 'site-a', 'cs1.html', async (p) => {
        const s = await styles(p.frame, ['.gnome-cs1-ad']);
        const ok = shown(s['.gnome-cs1-ad']) && p.out?.scriptlet === true;
        return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; set-constant ran: ${p.out?.scriptlet}` };
      });
      await configure(app, { allowlist: ['site-a.localhost'] });
      await pageRow('cs9', 'CS9 allowlisted site: nothing hidden, no scriptlets', 'site-a', 'cs1.html', async (p) => {
        const s = await styles(p.frame, ['.gnome-cs1-ad']);
        const ok = shown(s['.gnome-cs1-ad']) && p.out?.scriptlet === false;
        return { result: ok ? 'pass' : 'fail', notes: `${JSON.stringify(s)}; set-constant ran: ${p.out?.scriptlet}` };
      });
      await configure(app);
    }

    // ── cs-late (lane review): documents that opened before the engines were ready ───────────────────────────────
    if (want('cs-late')) {
      const late = {};
      for (const engine of ENGINES) late[engine] = await lateDocument(ctx, browser, app.refs, url, engine).catch((e) => ({ error: String(e?.stack ?? e).slice(0, 600) }));
      await row('cs-late', 'cs-late (lane review) a document opened before the engines were ready gets its styles and generic rules when they are, not its scriptlets', async (engine) => {
        const o = late[engine];
        if (o.error) return { result: 'fail', notes: o.error };
        const ok = o.during?.state === 'building' && shown(o.before['.gnome-cslate-ad']) && shown(o.before['.gnome-cslate-gen']) && o.ready?.state === 'ready' && hidden(o.after['.gnome-cslate-ad']) && hidden(o.after['.gnome-cslate-gen']) && o.out?.scriptlet === false;
        return { result: ok ? 'pass' : 'fail', notes: `status while held ${JSON.stringify(o.during)}; before ${JSON.stringify(o.before)}; after ${JSON.stringify(o.after)} (${o.ready?.state} after ${o.ready?.ms} ms); scriptlet ran: ${o.out?.scriptlet}` };
      });
      await row('cs-late', 'cs-late R1 (lane review) what the late styles and monitor hand the page (observer options, natives) is all of its own realm', async (engine) => {
        const o = late[engine];
        if (o.error) return { result: 'fail', notes: o.error };
        // The monitor must have run (the generic rule came from it), or the row proves nothing.
        const ok = hidden(o.after['.gnome-cslate-gen']) && Array.isArray(o.out?.foreign) && o.out.foreign.length === 0 && (o.out.sheets ?? []).length > 0 && o.out.sheets.every((r) => r === 'page');
        return { result: ok ? 'pass' : 'fail', notes: `foreign ${JSON.stringify(o.out?.foreign)}; calls ${JSON.stringify(o.out?.calls)}; sheets ${JSON.stringify(o.out?.sheets)}; monitor ran: ${hidden(o.after['.gnome-cslate-gen'])}` };
      });
    }
    await app.close();
  } finally {
    await browser.close();
  }
}

/**
 * `test.blocker` (e2e builds only, lane x1's core.ts): the engine host runs it; the app's client has no result check
 * for it and reports `invalid test.blocker result`, which is not a failure of the command (lane x1's suites do the
 * same). The row checks the effect itself (status.blocker `building` while held).
 */
async function testBlocker(app, p) {
  try {
    await app.cmd('test.blocker', p);
  } catch (e) {
    if (!/invalid test\./.test(String(e?.message ?? e))) throw e;
  }
}

/**
 * Row cs-late: a fresh browser context (nothing in force, nothing cached) whose build is held, so a page opened there
 * meets engines that are not ready; then the build is released. Returns what the page showed before and after.
 */
async function lateDocument(ctx, browser, refs, url, engine) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, { route: `profile:${ctx.stack.profiles.live}`, fallback: '0' });
    try {
      app.refs = refs;
      await testBlocker(app, { holdBuild: true });
      await configure(app, { cosmeticAggressive: true });
      await ctx.sleep(300);
      const during = (await app.status()).blocker;
      const p = await load(app, engine, url('site-b', 'cs-late.html'));
      if (!p.frame) return { error: `${p.why}; status while held ${JSON.stringify(during)}` };
      if (p.engine !== engine) return { error: `loaded in ${p.engine}, not ${engine}` };
      const sels = ['.gnome-cslate-ad', '.gnome-cslate-gen'];
      const before = await styles(p.frame, sels);
      await testBlocker(app, { releaseBuild: true });
      const ready = await waitReady(app);
      let after = null;
      for (let i = 0; i < 40; i++) {
        after = await styles(p.frame, sels);
        if (hidden(after['.gnome-cslate-ad']) && hidden(after['.gnome-cslate-gen'])) break;
        await ctx.sleep(250);
      }
      await ctx.sleep(400); // the page reports every 100 ms; a monitor batch is ≤ 100 ms
      const text = await inFrame(p.frame, () => document.getElementById('out').textContent);
      let out = null;
      try {
        out = JSON.parse(text);
      } catch {
        out = { raw: text };
      }
      return { during, before, ready, after, out };
    } finally {
      await app.close().catch(() => null);
    }
  } finally {
    await context.close().catch(() => null);
  }
}

/**
 * What the CS15 page must read back: each trusted-set-constant `json:` argument of cosmetic-trusted.txt as the library
 * parses it (CosmeticFilter.parseScript), after decodeURIComponent (as the library intends), JSON-decoded.
 */
function expectedVectors() {
  const text = fs.readFileSync(new URL('../fixtures/blocker/lists/cosmetic-trusted.txt', import.meta.url), 'utf8');
  const out = {};
  for (const l of text.split('\n').filter((x) => x.includes('+js(trusted-set-constant, gnomeCs15v'))) {
    const { args } = CosmeticFilter.parse(l.trim()).parseScript();
    const [name, value] = args.map((a) => decodeURIComponent(a));
    out[name] = JSON.parse(value.slice('json:'.length));
  }
  return out;
}

/** Exported for a check of the expectations without a browser. */
export const _expectedVectors = expectedVectors;
