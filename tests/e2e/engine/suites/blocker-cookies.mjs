// Lane x3 (docs/WAVE-B3.md §6, §12.2 rows K1–K12, plus the SameSite and Domain rows of the 2026-11-19 security
// finding): the cookie manager on the real stack, both engines (Scramjet's jar in the engine host, Ultraviolet's
// `__op` rows in the service worker), through the e2e driver page and the content-blocker fixture server (lane x5).
// Every row starts from empty jars (`cookies.delete {all: true}`) and uses its own cookie names.
//
//   K1  block-third-party: a trk.localhost frame's Set-Cookie is not stored and its Cookie not sent
//   K2  first-party cookies work in that mode (cookies.list attributes each to its engine: K10)
//   K3  document.cookie in that frame: the write is ignored, the read is ''
//   K3b the same through Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') of the frame's realm (also
//       with a fake `this`, and with the tab's attached first-party document as `this`: both engines' accessors
//       answer for their own realm) and of the top page's realm; in Ultraviolet also the page global `__uv$cookies`
//       its service worker injects is empty
//   K3c (measured) an about:blank child the blocked frame creates: a realm GNOME never attaches (Ultraviolet: the
//       SW glue of blankUvScriptCookies closes it)
//   K4  rule `allow` for trk.localhost: its cookies work as third party
//   K5  rule `block` for site-a: first-party header and JavaScript cookies blocked
//   K6  rule `session`: stored without an expiry; the fresh-start delete (what the app sends, x4) removes it; a
//       sign-out's deleting Set-Cookie still deletes it
//   K7  block-all; K8 all (control); K9 the cookie manager off: modes and rules ignored
//   K11 Ultraviolet: cookieStore, CookieStore, CookieStoreManager are undefined in a tab document and an about:blank
//       child (F5, lane x1's hardening; checked here)
//   K12 under block-third-party: a link from site-b to site-a sends and stores site-a's own cookies, and an OAuth-style
//       chain site-a → idp.localhost → site-a/callback keeps the session cookie the callback sets (D3)
//   K13 SameSite as in a browser (mode `all`, so third-party blocking does not hide it): requests site-b makes to
//       site-a carry site-a's SameSite=None cookie, the Lax one only on the top-level GET link, the Strict one never;
//       GNOME's own load carries all (Ultraviolet 3.2.10 ignored SameSite)
//   K14 a Set-Cookie with another site's Domain is refused (both engines stored it)
//   K15 the cross-site read of that finding under the default mode: a site-b page's fetch() and image to site-a carry
//       none of site-a's cookies (SameSite=None included), while site-a itself gets them
import { applyBlocker, clickAndWait, inTab, requestsUntil, startBlockerSuite } from './blocker-privacy.mjs';
import { perEngine } from './host-lib.mjs';

const enc = encodeURIComponent;
const names = (cookieHeader) => String(cookieHeader ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')[0]);

export async function run(ctx) {
  const s = await startBlockerSuite(ctx, 'cookies:setup (blocker offered, fixtures)');
  if (!s) return;
  const { fx, app, close } = s;
  const A = fx.origin('site-a');
  const B = fx.origin('site-b');
  const T = fx.origin('trk');
  const IDP = fx.origin('idp');
  let tab = 1;
  const open = async (url, engine) => {
    const id = tab++;
    const r = await app.navigate(id, url, { engine, create: true, timeout: 45000 });
    return { id, r };
  };
  const shut = (id) => app.cmd('tab.close', { tabId: id }).catch(() => {});
  /** A GNOME-initiated load in a throwaway tab (sets or reads cookies first-party). */
  const visit = async (url, engine) => {
    const { id, r } = await open(url, engine);
    await shut(id);
    return r;
  };
  const list = async (site) => (await app.cmd('cookies.list', { site }).catch(() => ({ cookies: [] }))).cookies;
  const fresh = () => app.cmd('cookies.delete', { all: true, site: null, name: null }).catch(() => {});
  /** The Cookie header of the newest request to `label` /cookies whose query has `via`. */
  const cookieSeen = async (since, label, via, path = '/cookies') => {
    const rs = await requestsUntil(fx, { since, label, path }, (x) => x.some((r) => r.search.includes(`via=${via}`)));
    const r = rs.filter((x) => x.search.includes(`via=${via}`)).pop();
    return r ? { seen: true, cookie: r.headers.cookie ?? '' } : { seen: false, cookie: null };
  };
  /** A site-a page with a frame; resolves when the frame's request reached the server. */
  const withFrame = async (engine, frameUrl, viaPath, viaLabel) => {
    const since = Date.now();
    const { id, r } = await open(`${A}/privacy/cookie-top.html?frame=${enc(frameUrl)}`, engine);
    if (r.ok) await requestsUntil(fx, { since, label: viaLabel, path: viaPath });
    return { id, r, since };
  };

  // --parts P1,K3,…: only those rows (their ids are the first word of the row name).
  const runRow = (name, fn, opts) => (!ctx.parts || ctx.parts.includes(name.split(' ')[0]) ? perEngine(ctx, name, fn, opts) : Promise.resolve());
  try {
    // ── K1 / K2 ───────────────────────────────────────────────────────────────────────────────────────────────
    await runRow('K1 block-third-party: a third-party frame’s Set-Cookie is not stored, its Cookie not sent', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      // A first-party trk cookie (GNOME load), which the third-party frame must not send.
      await visit(`${T}/set-cookie?k1seed=1`, engine);
      const seeded = (await list('trk.localhost')).map((c) => c.name);
      const a = await withFrame(engine, `${T}/set-cookie?k1frame=1`, '/set-cookie', 'trk');
      await shut(a.id);
      const b = await withFrame(engine, `${T}/cookies?format=html&via=k1`, '/cookies', 'trk');
      const sent = await cookieSeen(b.since, 'trk', 'k1');
      await shut(b.id);
      const after = (await list('trk.localhost')).map((c) => `${c.engine}:${c.name}`);
      const ok = seeded.includes('k1seed') && !after.some((n) => n.endsWith(':k1frame')) && sent.seen && !names(sent.cookie).includes('k1seed');
      return { result: ok ? 'pass' : 'fail', notes: `seeded ${JSON.stringify(seeded)}; jar after ${JSON.stringify(after)}; frame sent ${JSON.stringify(sent)}` };
    });

    await runRow('K2 first-party cookies work under block-third-party (and cookies.list names the engine: K10)', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      await visit(`${A}/set-cookie?k2=1`, engine);
      const since = Date.now();
      await visit(`${A}/cookies?format=html&via=k2`, engine);
      const sent = await cookieSeen(since, 'site-a', 'k2');
      const jar = await list('site-a.localhost');
      const mine = jar.find((c) => c.name === 'k2');
      const ok = names(sent.cookie).includes('k2') && mine?.engine === engine;
      return { result: ok ? 'pass' : 'fail', notes: `sent ${JSON.stringify(sent)}; cookies.list ${JSON.stringify(jar.map((c) => `${c.engine}:${c.name}`))}` };
    });

    // ── K3 / K3b: document.cookie ─────────────────────────────────────────────────────────────────────────────
    await runRow('K3 + K3b document.cookie in a third-party frame: write ignored, read "" (also through descriptors of both realms)', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      await visit(`${T}/set-cookie?k3seed=1`, engine);
      const { id, r } = await withFrame(engine, `${T}/privacy/cookie-frame.html?js=k3js`, '/privacy/cookie-frame.html', 'trk');
      if (!r.ok) return { result: 'fail', notes: `top did not load: ${JSON.stringify(r.error)}` };
      const f = await app.waitTabFrame(id, async (fr) => fr.childFrames().length > 0, 15000);
      const child = f?.childFrames()[0] ?? null;
      let inside = null;
      if (child) {
        await child.waitForFunction(() => typeof window.jsGet === 'function', null, { timeout: 15000 }).catch(() => {});
        inside = await child
          .evaluate(() => ({
            gpc: navigator.globalPrivacyControl ?? null,
            read: window.jsGet(),
            afterWrite: window.jsSet('k3late=1; Path=/'),
            viaDescriptor: window.viaDescriptor(),
            fake: window.viaDescriptorFake(),
            descriptorSet: window.descriptorSet('k3desc=1; Path=/'),
            viaParent: window.viaDescriptorParent(),
            parentSet: window.descriptorSetParent('k3parent=1; Path=/'),
            uvCookies: window.uvCookiesGlobal(),
          }))
          .catch((e) => ({ error: String(e).slice(0, 200) }));
      }
      const topRead = await inTab(app, id, () => window.topRealmRead(), undefined, { ready: 'topRealmRead' }).catch((e) => `threw ${String(e).slice(0, 80)}`);
      await shut(id);
      const jar = (await list('trk.localhost')).map((c) => c.name);
      const jarA = (await list('site-a.localhost')).map((c) => c.name);
      const empty = (v) => v === '' || /^threw/.test(String(v));
      const checks = {
        read: !!inside && !inside.error && inside.read === '' && inside.afterWrite === '',
        descriptors: !!inside && inside.viaDescriptor === '' && empty(inside.fake) && inside.descriptorSet === '' && topRead === '',
        parentThis: !!inside && empty(inside.viaParent) && empty(inside.parentSet) && !jar.includes('k3parent') && !jarA.includes('k3parent'),
        uvGlobal: !!inside && (engine === 'ultraviolet' ? inside.uvCookies === '' : inside.uvCookies === null),
        jar: !jar.some((n) => n.startsWith('k3js') || n === 'k3late' || n === 'k3desc'),
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      return { result: failed.length ? 'fail' : 'pass', notes: `${failed.length ? `failed ${failed.join(', ')}; ` : ''}frame ${JSON.stringify(inside)}; top realm on the frame document ${JSON.stringify(topRead)}; trk jar ${JSON.stringify(jar)}; site-a jar ${JSON.stringify(jarA)}` };
    });

    // Measured, not a row of the plan: an about:blank child of the blocked frame is a realm no GNOME hook reaches
    // (WAVE-B3 §6.1: about:blank children get no document overrides), so whether its cookie accessor hands out the
    // frame's cookies depends on what the engine does in that realm. Scramjet: nothing. Ultraviolet 3.2.10: every
    // window its handler hooks starts from the cookie string the SW injected into the frame, so the fix is the SW's
    // (blankUvScriptCookies, b3-x3-review-scripts/sw-k3c-glue.txt; validated in a scratch tree, both browsers).
    await runRow('K3c (measured) an about:blank child of a blocked third-party frame: does its document.cookie read the frame’s cookies?', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      await visit(`${T}/set-cookie?k3cseed=1`, engine);
      const { id, r } = await withFrame(engine, `${T}/privacy/cookie-frame.html`, '/privacy/cookie-frame.html', 'trk');
      if (!r.ok) return { result: 'fail', notes: `top did not load: ${JSON.stringify(r.error)}` };
      const f = await app.waitTabFrame(id, async (fr) => fr.childFrames().length > 0, 15000);
      const child = f?.childFrames()[0] ?? null;
      let out = null;
      if (child) {
        await child.waitForFunction(() => typeof window.blankChild === 'function', null, { timeout: 15000 }).catch(() => {});
        out = await child.evaluate(() => window.blankChild()).catch((e) => ({ error: String(e).slice(0, 200) }));
      }
      await shut(id);
      const leaked = !out || out.error ? null : Object.values(out).some((v) => typeof v === 'string' && v.includes('k3cseed'));
      return { result: leaked === false ? 'pass' : 'fail', notes: `${leaked ? 'LEAK: the child realm reads the blocked frame’s cookies; ' : ''}${JSON.stringify(out)}` };
    });

    // ── K4–K9: rules and modes ────────────────────────────────────────────────────────────────────────────────
    const frameRound = async (engine, opts, tag) => {
      await fresh();
      await applyBlocker(app, opts);
      // SameSite=None; Secure: a cookie without SameSite is Lax by default, which a browser (Chromium) never sends to a
      // cross-site frame, and Ultraviolet follows that since the SameSite glue (K13); these rows are about the cookie
      // manager letting third-party cookies through, so they use cookies a browser sends to a third-party frame.
      const none = enc('; SameSite=None; Secure');
      await visit(`${T}/set-cookie?${tag}seed=1${none}`, engine);
      const a = await withFrame(engine, `${T}/set-cookie?${tag}frame=1${none}`, '/set-cookie', 'trk');
      await shut(a.id);
      const b = await withFrame(engine, `${T}/cookies?format=html&via=${tag}`, '/cookies', 'trk');
      const sent = await cookieSeen(b.since, 'trk', tag);
      await shut(b.id);
      const jar = (await list('trk.localhost')).map((c) => c.name);
      return { seeded: jar.includes(`${tag}seed`), stored: jar.includes(`${tag}frame`), sent: names(sent.cookie), seen: sent.seen };
    };
    await runRow('K4 rule `allow` for trk.localhost: its cookies work as third party', async (engine) => {
      const r = await frameRound(engine, { privacy: { cookies: 'block-third-party' }, extensions: { cookieRules: { 'trk.localhost': 'allow' } } }, 'k4');
      const ok = r.seeded && r.stored && r.sent.includes('k4seed') && r.sent.includes('k4frame');
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(r) };
    });

    await runRow('K5 rule `block` for site-a: first-party header and JavaScript cookies blocked', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' } });
      await visit(`${A}/set-cookie?k5before=1`, engine);
      await applyBlocker(app, { privacy: { cookies: 'all' }, extensions: { cookieRules: { '*.site-a.localhost': 'block' } } });
      await visit(`${A}/set-cookie?k5=1`, engine);
      const since = Date.now();
      const { id, r } = await open(`${A}/privacy/cookie-frame.html?js=k5js&via=k5`, engine);
      const js = r.ok ? await inTab(app, id, () => ({ read: window.jsGet(), afterWrite: window.jsSet('k5late=1; Path=/') }), undefined, { ready: 'jsGet' }) : null;
      await shut(id);
      const doc = (await requestsUntil(fx, { since, label: 'site-a', path: '/privacy/cookie-frame.html' })).pop();
      const jar = (await list('site-a.localhost')).map((c) => c.name);
      const ok = !jar.includes('k5') && !jar.includes('k5js') && !jar.includes('k5late') && (doc?.headers.cookie ?? '') === '' && js?.read === '' && js?.afterWrite === '';
      return { result: ok ? 'pass' : 'fail', notes: `jar ${JSON.stringify(jar)}; document request Cookie ${JSON.stringify(doc?.headers.cookie ?? null)}; js ${JSON.stringify(js)}` };
    });

    await runRow('K6 rule `session`: stored without an expiry, removed by the fresh-start delete, a deleting Set-Cookie still deletes it', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' }, extensions: { cookieRules: { '*.site-a.localhost': 'session' } } });
      await visit(`${A}/set-cookie?k6=1%3B%20Max-Age%3D86400&k6out=1%3B%20Expires%3DWed%2C%2021%20Oct%202099%2007%3A28%3A00%20GMT`, engine);
      const jar1 = await list('site-a.localhost');
      const k6 = jar1.find((c) => c.name === 'k6');
      const k6out = jar1.find((c) => c.name === 'k6out');
      // A sign-out: the deleting line passes unchanged.
      await visit(`${A}/set-cookie?k6out=%3B%20Max-Age%3D0`, engine);
      const jar2 = (await list('site-a.localhost')).map((c) => c.name);
      // What the app sends at a fresh start for this rule (freshStartCookieDeletes, x4 wires it before session restore).
      const del = await app.cmd('cookies.delete', { all: false, site: 'site-a.localhost', name: null }).catch((e) => ({ error: String(e) }));
      const jar3 = (await list('site-a.localhost')).map((c) => c.name);
      const ok = !!k6 && k6.expires === null && !!k6out && k6out.expires === null && !jar2.includes('k6out') && jar2.includes('k6') && jar3.length === 0;
      return { result: ok ? 'pass' : 'fail', notes: `k6 ${JSON.stringify(k6)}; after sign-out ${JSON.stringify(jar2)}; fresh-start delete ${JSON.stringify(del)} → ${JSON.stringify(jar3)} (the app's wiring at a real fresh start is x4's U-rows)` };
    });

    await runRow('K7 block-all: first-party cookies are not stored or sent', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' } });
      await visit(`${A}/set-cookie?k7before=1`, engine);
      await applyBlocker(app, { privacy: { cookies: 'block-all' } });
      await visit(`${A}/set-cookie?k7=1`, engine);
      const since = Date.now();
      await visit(`${A}/cookies?format=html&via=k7`, engine);
      const sent = await cookieSeen(since, 'site-a', 'k7');
      const jar = (await list('site-a.localhost')).map((c) => c.name);
      const ok = sent.seen && sent.cookie === '' && !jar.includes('k7');
      return { result: ok ? 'pass' : 'fail', notes: `sent ${JSON.stringify(sent)}; jar ${JSON.stringify(jar)}` };
    });

    await runRow('K8 mode `all` (control): third-party frame cookies are stored and sent', async (engine) => {
      const r = await frameRound(engine, { privacy: { cookies: 'all' } }, 'k8');
      const ok = r.seeded && r.stored && r.sent.includes('k8seed') && r.sent.includes('k8frame');
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(r) };
    });

    await runRow('K9 the cookie manager off: modes and rules are ignored', async (engine) => {
      const r = await frameRound(engine, { enabled: { cookies: false }, privacy: { cookies: 'block-all' }, extensions: { cookieRules: { 'trk.localhost': 'block' } } }, 'k9');
      const ok = r.seeded && r.stored && r.sent.includes('k9seed') && r.sent.includes('k9frame');
      return { result: ok ? 'pass' : 'fail', notes: JSON.stringify(r) };
    });

    await runRow(
      'K11 Ultraviolet: cookieStore, CookieStore, CookieStoreManager are undefined in a tab document and an about:blank child (F5)',
      async (engine) => {
        await applyBlocker(app, {});
        const { id, r } = await open(`${A}/privacy/cookie-top.html`, engine);
        const out = r.ok ? await inTab(app, id, () => window.cookieStores(), undefined, { ready: 'cookieStores' }) : null;
        await shut(id);
        const all = (v) => Array.isArray(v) && v.every((t) => t === 'undefined');
        return { result: out && all(out.top) && all(out.blank) ? 'pass' : 'fail', notes: JSON.stringify(out) };
      },
      { engines: ['ultraviolet'] },
    );

    // ── K12: cross-site navigations keep the destination's own cookies (D3) ───────────────────────────────────
    await runRow('K12 under block-third-party: a link from site-b sends and stores site-a’s cookies; an OAuth chain keeps the callback’s session cookie', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      await visit(`${A}/set-cookie?k12=1`, engine);
      const since = Date.now();
      const { id, r } = await open(`${B}/privacy/probe.html?to=${enc(`${A}/set-cookie?k12link=1&_to=${enc(`${A}/cookies?format=html&via=k12link`)}`)}`, engine);
      if (!r.ok) return { result: 'fail', notes: `site-b did not load: ${JSON.stringify(r.error)}` };
      const c1 = await clickAndWait(app, id, '#link', /\/cookies\?/);
      const link = await cookieSeen(since, 'site-a', 'k12link');
      // site-a → IdP → site-a/callback (sets the session) → site-a/cookies
      const callback = `${A}/set-cookie?k12sess=1&_to=${enc(`${A}/cookies?format=html&via=k12cb`)}`;
      const s2 = Date.now();
      await app.navigate(id, `${A}/privacy/probe.html?to=${enc(`${IDP}/redirect?to=${enc(callback)}`)}`, { engine, timeout: 45000 });
      const c2 = await clickAndWait(app, id, '#link', /\/cookies\?/);
      const cb = await cookieSeen(s2, 'site-a', 'k12cb');
      await shut(id);
      const jar = (await list('site-a.localhost')).map((c) => c.name);
      const ok = c1.ok && names(link.cookie).includes('k12') && names(link.cookie).includes('k12link') && c2.ok && names(cb.cookie).includes('k12sess') && jar.includes('k12sess');
      return { result: ok ? 'pass' : 'fail', notes: `link ${JSON.stringify(link)}; OAuth callback ${JSON.stringify(cb)}; jar ${JSON.stringify(jar)}` };
    });

    // ── K13: SameSite ─────────────────────────────────────────────────────────────────────────────────────────
    await runRow('K13 SameSite as in a browser: site-b’s image, link and POST to site-a; GNOME’s own load', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' } });
      const set = `xs_strict=1${enc('; SameSite=Strict')}&xs_lax=1${enc('; SameSite=Lax')}&xs_none=1${enc('; SameSite=None; Secure')}&xs_plain=1`;
      await visit(`${A}/set-cookie?${set}`, engine);
      const since = Date.now();
      const { id, r } = await open(`${B}/privacy/xs-attacker.html`, engine);
      if (!r.ok) return { result: 'fail', notes: `site-b did not load: ${JSON.stringify(r.error)}` };
      const img = await cookieSeen(since, 'site-a', 'img');
      const link = await clickAndWait(app, id, '#link', /via=link/);
      const linkSeen = await cookieSeen(since, 'site-a', 'link');
      await app.navigate(id, `${B}/privacy/xs-attacker.html`, { engine, timeout: 45000 });
      const post = await clickAndWait(app, id, '#go', /via=post/);
      const postSeen = await cookieSeen(since, 'site-a', 'post', '/echo');
      await shut(id);
      const own = Date.now();
      await visit(`${A}/cookies?format=html&via=gnome`, engine);
      const gnome = await cookieSeen(own, 'site-a', 'gnome');
      const has = (x, n) => names(x.cookie).includes(n);
      const checks = {
        img: img.seen && has(img, 'xs_none') && !has(img, 'xs_lax') && !has(img, 'xs_strict'),
        link: link.ok && linkSeen.seen && has(linkSeen, 'xs_lax') && has(linkSeen, 'xs_none') && !has(linkSeen, 'xs_strict'),
        post: post.ok && postSeen.seen && has(postSeen, 'xs_none') && !has(postSeen, 'xs_lax') && !has(postSeen, 'xs_strict'),
        gnome: gnome.seen && ['xs_strict', 'xs_lax', 'xs_none', 'xs_plain'].every((n) => has(gnome, n)),
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
      const brief = (x) => x.cookie;
      return {
        result: failed.length ? 'fail' : 'pass',
        notes: `${failed.length ? `failed ${failed.join(', ')}; ` : ''}img ${brief(img)}; link ${brief(linkSeen)}; POST ${brief(postSeen)} (xs_plain: Lax by default, Chromium's Lax+POST window applies in Ultraviolet; Scramjet keeps its own rule); GNOME's own load ${brief(gnome)}`,
      };
    });

    // ── K15: the cross-site read of the 2026-11-19 finding, under the default mode ─────────────────────────
    await runRow('K15 block-third-party (the default): site-b’s fetch() and image to site-a carry none of site-a’s cookies, SameSite=None included', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' } });
      await visit(`${A}/set-cookie?k15none=1${enc('; SameSite=None; Secure')}&k15lax=1${enc('; SameSite=Lax')}`, engine);
      await applyBlocker(app, { privacy: { cookies: 'block-third-party' } });
      const since = Date.now();
      const { id, r } = await open(`${B}/privacy/probe.html?img=${enc(`${A}/cookies?via=k15img`)}`, engine);
      if (!r.ok) return { result: 'fail', notes: `site-b did not load: ${JSON.stringify(r.error)}` };
      const read = await inTab(app, id, (u) => window.echo(u, { credentials: 'include' }), `${A}/cookies?via=k15fetch`);
      const img = await cookieSeen(since, 'site-a', 'k15img');
      const fetched = await cookieSeen(since, 'site-a', 'k15fetch');
      await shut(id);
      const own = Date.now();
      await visit(`${A}/cookies?format=html&via=k15own`, engine);
      const first = await cookieSeen(own, 'site-a', 'k15own');
      const ok = img.seen && img.cookie === '' && fetched.seen && fetched.cookie === '' && names(first.cookie).includes('k15none') && names(first.cookie).includes('k15lax');
      return { result: ok ? 'pass' : 'fail', notes: `image ${JSON.stringify(img.cookie)}; fetch ${JSON.stringify(fetched.cookie)} (page read ${JSON.stringify(read?.cookie ?? read?.error ?? null)}); site-a itself ${JSON.stringify(first.cookie)}` };
    });

    // ── K14: Domain of another site ───────────────────────────────────────────────────────────────────────────
    await runRow('K14 a Set-Cookie for another site’s Domain is refused', async (engine) => {
      await fresh();
      await applyBlocker(app, { privacy: { cookies: 'all' } });
      await visit(`${B}/set-cookie?k14inj=1${enc('; Domain=site-a.localhost')}&k14own=1`, engine);
      const since = Date.now();
      await visit(`${A}/cookies?format=html&via=k14`, engine);
      const sent = await cookieSeen(since, 'site-a', 'k14');
      const jarA = (await list('site-a.localhost')).map((c) => c.name);
      const jarB = (await list('site-b.localhost')).map((c) => c.name);
      const ok = sent.seen && !names(sent.cookie).includes('k14inj') && !jarA.includes('k14inj') && jarB.includes('k14own');
      return { result: ok ? 'pass' : 'fail', notes: `site-a got ${JSON.stringify(sent.cookie)}; site-a jar ${JSON.stringify(jarA)}; site-b jar ${JSON.stringify(jarB)}` };
    });
  } finally {
    await fresh();
    await close();
  }
}

